#!/usr/bin/env node
/**
 * xw-locator — the single passive entry for the visual block locator.
 *
 * It may acquire a screenshot through an already-leased Explorer session,
 * build a frame/query-bound Vision pack, and validate a blockId-only decision.
 * It never taps. Until the trusted live permit exists, selected points remain
 * effect=none / tapAuthorized=false / executionEligibility=offline_only.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadFoundationCapabilities } from "../scripts/lib/foundation-capabilities.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--") && argv[i + 1] && !argv[i + 1].startsWith("--")) out[arg.slice(2)] = argv[++i];
    else if (arg.startsWith("--")) out[arg.slice(2)] = true;
    else out._.push(arg);
  }
  return out;
}

function fail(message, code = 2) {
  console.log(`XW_LOCATOR_FAILED ${message}`);
  process.exit(code);
}

function firstExisting(candidates) {
  return candidates.find((item) => item && existsSync(item)) || null;
}

function runtime(args = {}) {
  const roots = [
    args.root,
    process.env.XW_VISUAL_LOCATOR_ROOT,
    join(ROOT, "experiments", "visual-tap-resolver"),
    "C:\\Users\\Public\\xhs-registry-visual-tap\\experiments\\visual-tap-resolver",
  ].filter(Boolean).map((item) => resolve(item));
  const resolverRoot = roots.find((item) => existsSync(join(item, "visual_tap_demo.py"))) || roots[0];
  const python = firstExisting([
    args.python,
    process.env.XW_VISUAL_LOCATOR_PYTHON,
    resolverRoot && join(resolverRoot, ".venv-ocr", "Scripts", "python.exe"),
    resolverRoot && join(resolverRoot, ".venv", "Scripts", "python.exe"),
    resolverRoot && join(resolverRoot, ".venv", "bin", "python"),
  ]);
  const script = resolverRoot ? join(resolverRoot, "visual_tap_demo.py") : null;
  return {
    resolverRoot,
    python,
    script,
    available: Boolean(python && script && existsSync(script)),
  };
}

function run(command, argv, { cwd, timeoutMs = 180000 } = {}) {
  const result = spawnSync(command, argv, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stdout || result.stderr || "").trim().slice(0, 1200);
    throw new Error(`${command} exited ${result.status}${detail ? `: ${detail}` : ""}`);
  }
  return String(result.stdout || "").trim();
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} unreadable: ${error.message}`);
  }
}

function capability() {
  const item = loadFoundationCapabilities().find((entry) => entry.id === "locator.visual-block.v1");
  if (!item) throw new Error("locator.visual-block.v1 is not registered");
  return item;
}

function commandStatus(args) {
  const rt = runtime(args);
  console.log(JSON.stringify({
    ok: rt.available,
    capability: capability(),
    runtime: rt,
    tapAuthorized: false,
    nextSafeAction: rt.available ? "prepare" : "install_or_merge_visual_resolver",
  }, null, 2));
  if (!rt.available) process.exitCode = 3;
}

function captureInput(args, outDir) {
  if (args.input) {
    const input = resolve(args.input);
    if (!existsSync(input)) throw new Error(`input screenshot not found: ${input}`);
    return input;
  }
  if (!args.alias || !args["session-file"]) {
    throw new Error("prepare requires --input or both --alias and --session-file");
  }
  const input = join(outDir, "source.png");
  const stdout = run(process.execPath, [
    join(ROOT, "ops", "screenshot-and-analyze.mjs"),
    "--alias", String(args.alias),
    "--session-file", resolve(args["session-file"]),
    "--out", input,
  ], { cwd: ROOT, timeoutMs: 90000 });
  if (!stdout.includes(`SHOT=${input}`) || !existsSync(input)) {
    throw new Error("Explorer screenshot did not produce the requested frame");
  }
  return input;
}

function commandPrepare(args) {
  if (!args.query || !String(args.query).trim()) throw new Error("prepare requires --query");
  if (!args.out) throw new Error("prepare requires --out");
  const rt = runtime(args);
  if (!rt.available) throw new Error("visual locator runtime unavailable; run status for details");
  const outDir = resolve(args.out);
  mkdirSync(outDir, { recursive: true });
  const input = captureInput(args, outDir);
  const argv = [
    rt.script,
    "vision-pack",
    "--input", input,
    "--output-dir", outDir,
    "--query", String(args.query).trim(),
    "--max-side", String(args["max-side"] || 640),
    "--max-blocks", String(args["max-blocks"] || 256),
  ];
  if (args.ocr) argv.push("--ocr");
  run(rt.python, argv, { cwd: rt.resolverRoot });
  const packPath = join(outDir, "vision-pack.json");
  const pack = readJson(packPath, "vision pack");
  console.log(JSON.stringify({
    ok: true,
    operation: "prepare",
    capabilityId: "locator.visual-block.v1",
    source: input,
    frameId: pack.frame?.frameId,
    manifestId: pack.manifestId,
    selectionRequestId: pack.selectionRequestId,
    candidateCount: pack.candidateCount,
    artifacts: {
      blocks: join(outDir, "blocks.json"),
      pack: packPath,
      overlay: join(outDir, "vision-overlay-all.png"),
      prompt: join(outDir, "vision-prompt.txt"),
    },
    decisionRule: "Vision must return blockId only; raw x/y/bbox/point are forbidden",
    tapAuthorized: false,
  }, null, 2));
}

function commandVerify(args) {
  if (!args.input || !args.dir || !args.decision) {
    throw new Error("verify requires --input --dir --decision");
  }
  const rt = runtime(args);
  if (!rt.available) throw new Error("visual locator runtime unavailable; run status for details");
  const dir = resolve(args.dir);
  const output = resolve(args.output || join(dir, "verified-point.json"));
  const argv = [
    rt.script,
    "select",
    "--input", resolve(args.input),
    "--blocks", join(dir, "blocks.json"),
    "--pack", join(dir, "vision-pack.json"),
    "--overlay", join(dir, "vision-overlay-all.png"),
    "--prompt", join(dir, "vision-prompt.txt"),
    "--decision", resolve(args.decision),
    "--output", output,
    "--min-confidence", String(args["min-confidence"] || 0.8),
    "--json",
  ];
  run(rt.python, argv, { cwd: rt.resolverRoot });
  const point = readJson(output, "verified point");
  console.log(JSON.stringify({
    ok: point.ok === true,
    operation: "verify",
    capabilityId: "locator.visual-block.v1",
    output,
    result: point,
    tapAuthorized: false,
    nextSafeAction: "trusted_live_tap_permit_required",
  }, null, 2));
  if (point.ok !== true) process.exitCode = 3;
}

function commandSelfTest(args) {
  const rt = runtime(args);
  const registered = capability();
  const checks = [
    { id: "catalog_registered", pass: registered.status === "implemented" },
    { id: "passive_contract", pass: registered.effect === "none" && registered.directRun === false },
    { id: "runtime_available", pass: rt.available },
  ];
  if (rt.available) {
    try {
      run(rt.python, ["-c", "import cv2, numpy; print('ok')"], { cwd: rt.resolverRoot, timeoutMs: 30000 });
      checks.push({ id: "opencv_import", pass: true });
    } catch (error) {
      checks.push({ id: "opencv_import", pass: false, detail: error.message });
    }
  }
  for (const check of checks) console.log(`${check.pass ? "PASS" : "FAIL"} ${check.id}${check.detail ? ` — ${check.detail}` : ""}`);
  const failed = checks.filter((check) => !check.pass);
  console.log(`XW_LOCATOR_SELF_TEST summary pass=${checks.length - failed.length} fail=${failed.length}`);
  if (failed.length) process.exitCode = 1;
}

function usage() {
  console.log(`用法:
  node ops/xw-locator.mjs status
  node ops/xw-locator.mjs prepare --input <screen.png> --query <目标> --out <目录>
  node ops/xw-locator.mjs prepare --alias <01-04> --session-file <ctx> --query <目标> --out <目录>
  node ops/xw-locator.mjs verify --input <同一screen.png> --dir <prepare目录> --decision <decision.json>
  node ops/xw-locator.mjs --self-test

该入口只定位和验证 blockId，不执行 tap。`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args["self-test"]) return commandSelfTest(args);
  const command = args._[0] || "status";
  if (command === "status") return commandStatus(args);
  if (command === "prepare") return commandPrepare(args);
  if (command === "verify") return commandVerify(args);
  if (command === "execute" || command === "tap") {
    fail("trusted live tap permit is not implemented; passive verified-point cannot authorize a tap", 4);
  }
  usage();
  process.exitCode = 2;
}

try {
  main();
} catch (error) {
  fail(error.message || String(error));
}
