#!/usr/bin/env node
/**
 * xw-locator — the single passive diagnostic entry for the visual block locator.
 *
 * M6-1: this CLI no longer holds its own algorithm. It is a thin proxy over the
 * unique GroundingRuntime (services/orchestrator/scripts/lib/m6/m6-grounding-runtime.mjs):
 * status reports runtime/provider availability; prepare freezes an execution-grade
 * frame and segments it; verify produces a blockId-only grounding decision. The
 * hermetic fixture provider is used in CI and here; real providers (Cordis/DSH/OCR)
 * are wired in later milestones but the safety policy and block id derivation are
 * owned by the runtime and cannot be overridden by any provider.
 *
 * It never taps. Until the trusted live permit exists, selected points remain
 * effect=none / tapAuthorized=false / executionEligibility=offline_only.
 *
 * No machine-external paths, no python venv, no out-of-repo resolver script: the
 * M6-0 compat exception for this file is resolved in M6-1.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadFoundationCapabilities } from "../scripts/lib/foundation-capabilities.mjs";
import { computeRedlinePolicySha256 } from "../scripts/lib/m6/m6-contracts.mjs";
import {
  HERMETIC_FIXTURE_PROVIDER,
  createEvidenceStore,
  createGroundingRuntime,
} from "../scripts/lib/m6/m6-grounding-runtime.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const POLICY_PATH = join(ROOT, "tests", "fixtures", "m6", "hard-redline-policy.valid.json");

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

function readJson(file, label) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${label} unreadable: ${error.message}`);
  }
}

function capability() {
  const item = loadFoundationCapabilities().find((entry) => entry.id === "locator.visual-block.v1");
  if (!item) throw new Error("locator.visual-block.v1 is not registered");
  return item;
}

// The same pinned hard-redline policy the runtime and tests use. The locator is a
// diagnostic surface; it never weakens or swaps this policy.
function loadPolicy() {
  return readJson(POLICY_PATH, "hard-redline policy");
}

function makeRuntime() {
  const policy = loadPolicy();
  const expectedPolicySha256 = computeRedlinePolicySha256(policy);
  const evidence = createEvidenceStore();
  const built = createGroundingRuntime({ policy, expectedPolicySha256, evidence });
  if (!built.ok) {
    throw new Error(`grounding runtime failed to construct: ${built.errors.map((e) => e.message).join("; ")}`);
  }
  return { policy, expectedPolicySha256, evidence, runtime: built.runtime };
}

// Convert a prepared/segmented frame into the legacy "vision pack"-shaped JSON
// callers expect, but populated from the runtime's contract-conformant output.
function writeArtifacts(outDir, { frame, blockSet, overlayRef, evidence }) {
  const frameFile = join(outDir, "screen-frame.json");
  const blocksFile = join(outDir, "blocks.json");
  const packFile = join(outDir, "vision-pack.json");
  writeFileSync(frameFile, `${JSON.stringify(frame, null, 2)}\n`, "utf8");
  writeFileSync(blocksFile, `${JSON.stringify(blockSet.blocks, null, 2)}\n`, "utf8");
  writeFileSync(packFile, `${JSON.stringify({
    schemaId: "xw.screen-frame.v1",
    frameId: frame.frameId,
    manifestId: frame.manifestSha256,
    selectionRequestId: `loc-${frame.frameId.slice(0, 12)}`,
    candidateCount: blockSet.blocks.length,
    frame,
    overlayRef,
  }, null, 2)}\n`, "utf8");
  return { frameFile, blocksFile, packFile };
}

function commandStatus() {
  const cap = capability();
  const provider = HERMETIC_FIXTURE_PROVIDER;
  console.log(JSON.stringify({
    ok: true,
    capability: cap,
    runtime: {
      groundingRuntime: "services/orchestrator/scripts/lib/m6/m6-grounding-runtime.mjs",
      provider: { id: provider.id, version: provider.version, modelSha256: provider.modelSha256 },
      machineExternalPaths: [],
    },
    tapAuthorized: false,
    nextSafeAction: "prepare",
  }, null, 2));
}

function readEvidenceInput(args) {
  // M6-1 is offline: prepare takes a --input evidence bundle (screenshotA/B,
  // dump, focus as files or a single JSON) or a --replay-corpus frame id.
  if (args.input) {
    const input = resolve(args.input);
    if (!existsSync(input)) throw new Error(`input not found: ${input}`);
    const raw = readFileSync(input, "utf8");
    try {
      return JSON.parse(raw);
    } catch {
      // Treat the input as a raw screenshot for A and synthesize a stable frame.
      return { screenshotA: raw, screenshotB: raw, dump: "cli-input", focus: "cli-input" };
    }
  }
  throw new Error("prepare requires --input <evidence.json|screen.png> (M6-1 is offline; live capture is M6-2)");
}

function commandPrepare(args) {
  if (!args.out) throw new Error("prepare requires --out");
  const ev = readEvidenceInput(args);
  const outDir = resolve(args.out);
  mkdirSync(outDir, { recursive: true });
  const { runtime, evidence } = makeRuntime();
  const capturedAt = ev.capturedAt || args.capturedAt || "2026-08-20T10:00:00.000Z";
  const frameRes = runtime.freezeFrame({
    screenshotA: ev.screenshotA,
    screenshotB: ev.screenshotB,
    dump: ev.dump,
    focus: ev.focus,
    capturedAt,
    linkage: ev.linkage || { sessionId: args.sessionId || "sess-cli", leaseRef: args.leaseRef || "lease-cli", alias: args.alias || "00", appId: args.appId || "app-cli" },
    width: ev.width || Number(args["max-side"]) || 1080,
    height: ev.height || 2400,
    density: ev.density || 3,
    orientation: ev.orientation,
  });
  if (!frameRes.ok) throw new Error(`freezeFrame failed: ${frameRes.errors.map((e) => e.message).join("; ")}`);
  const seg = runtime.segmentBlocks(frameRes.frame);
  if (!seg.ok) throw new Error(`segmentBlocks failed: ${seg.errors.map((e) => e.message).join("; ")}`);
  const overlayRef = evidence.overlay(seg.blockSet);
  const { frameFile, blocksFile, packFile } = writeArtifacts(outDir, { frame: frameRes.frame, blockSet: seg.blockSet, overlayRef, evidence });
  console.log(JSON.stringify({
    ok: true,
    operation: "prepare",
    capabilityId: "locator.visual-block.v1",
    source: args.input,
    frameId: frameRes.frame.frameId,
    manifestId: frameRes.frame.manifestSha256,
    selectionRequestId: `loc-${frameRes.frame.frameId.slice(0, 12)}`,
    candidateCount: seg.blockSet.blocks.length,
    artifacts: { frame: frameFile, blocks: blocksFile, pack: packFile },
    decisionRule: "Vision must return blockId only; raw x/y/bbox/point are forbidden",
    tapAuthorized: false,
  }, null, 2));
}

function commandVerify(args) {
  if (!args.dir || !args.decision) {
    throw new Error("verify requires --dir <prepare目录> --decision <decision.json>");
  }
  const dir = resolve(args.dir);
  const { runtime } = makeRuntime();
  const frame = readJson(join(dir, "screen-frame.json"), "screen frame");
  const decision = readJson(resolve(args.decision), "decision request");
  // Re-derive the block set with private signals so decide() can run the firewall.
  const seg = runtime.segmentBlocks(frame);
  if (!seg.ok) throw new Error(`segmentBlocks failed: ${seg.errors.map((e) => e.message).join("; ")}`);
  const requestedBlockId = decision.blockId || decision.block?.blockId;
  if (!requestedBlockId) throw new Error("decision must carry a blockId");
  const dec = runtime.decide({
    frame,
    blockSet: seg.blockSet,
    blockId: requestedBlockId,
    intent: decision.intent || "tap",
    grantRef: decision.grantRef || "grant-cli",
    goalRef: decision.goalRef || "goal-cli",
    stepRef: decision.stepRef || "step-cli",
    effectClass: decision.effectClass || "navigation",
  });
  if (!dec.ok) throw new Error(`decide failed: ${dec.errors.map((e) => e.message).join("; ")}`);
  const output = resolve(args.output || join(dir, "verified-point.json"));
  const point = runtime.resolveInternalPoint(dec.decision);
  writeFileSync(output, `${JSON.stringify({ ok: dec.decision.result === "ALLOW_ONCE", decision: dec.decision, pointRef: point.pointRef }, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    ok: dec.decision.result === "ALLOW_ONCE",
    operation: "verify",
    capabilityId: "locator.visual-block.v1",
    output,
    result: { result: dec.decision.result, groundingDecisionId: dec.decision.groundingDecisionId },
    tapAuthorized: false,
    nextSafeAction: dec.decision.result === "ALLOW_ONCE" ? "trusted_live_tap_permit_required" : dec.decision.result,
  }, null, 2));
  if (dec.decision.result !== "ALLOW_ONCE") process.exitCode = 3;
}

function commandSelfTest() {
  const registered = capability();
  const provider = HERMETIC_FIXTURE_PROVIDER;
  const checks = [
    { id: "catalog_registered", pass: registered.status === "implemented" },
    { id: "passive_contract", pass: registered.effect === "none" && registered.directRun === false },
    { id: "runtime_available", pass: Boolean(provider.modelSha256) },
  ];
  // Smoke the runtime end to end on a synthetic stable frame.
  try {
    const { runtime } = makeRuntime();
    const fr = runtime.freezeFrame({
      screenshotA: "selftest", screenshotB: "selftest", dump: "d", focus: "f",
      capturedAt: "2026-08-20T10:00:00.000Z",
      linkage: { sessionId: "s", leaseRef: "l", alias: "01", appId: "a" },
    });
    checks.push({ id: "freeze_frame", pass: fr.ok });
    if (fr.ok) {
      const seg = runtime.segmentBlocks(fr.frame);
      checks.push({ id: "segment_blocks", pass: seg.ok });
    }
  } catch (error) {
    checks.push({ id: "runtime_smoke", pass: false, detail: error.message });
  }
  for (const check of checks) console.log(`${check.pass ? "PASS" : "FAIL"} ${check.id}${check.detail ? ` — ${check.detail}` : ""}`);
  const failed = checks.filter((check) => !check.pass);
  console.log(`XW_LOCATOR_SELF_TEST summary pass=${checks.length - failed.length} fail=${failed.length}`);
  if (failed.length) process.exitCode = 1;
}

function usage() {
  console.log(`用法:
  node ops/xw-locator.mjs status
  node ops/xw-locator.mjs prepare --input <evidence.json|screen.png> --out <目录>
  node ops/xw-locator.mjs verify --dir <prepare目录> --decision <decision.json>
  node ops/xw-locator.mjs --self-test

该入口是唯一 GroundingRuntime 的诊断代理，只定位和验证 blockId，不执行 tap。
M6-1 离线：prepare 只接受 --input 证据；真机截图采集在 M6-2。`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args["self-test"]) return commandSelfTest();
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
