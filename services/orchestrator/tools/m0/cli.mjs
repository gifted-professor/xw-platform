#!/usr/bin/env node
// M0 CLI dispatcher. Subcommands: collect | hash | validate | render |
// secret-scan | test-run | tag-prepare | tag-verify.
//
// Contract (M0 plan hard constraint, deliberately diverging from repo convention):
//   - stdout: only versioned JSON (one line, stable key order).
//   - stderr: diagnostics / human-readable progress.
//   - BLOCK: exit non-zero; the JSON still emitted carries status:"BLOCK".
//   - not imported by runtime; no default secret reading.
//
// Module entry guard allows `import { main } from "./cli.mjs"` for testing.

import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const VERSION = "xhs.m0.cli.v1";

function emit(obj) {
  process.stdout.write(JSON.stringify({ ...obj, cliVersion: VERSION }) + "\n");
}
function diag(msg) {
  process.stderr.write(String(msg) + "\n");
}

export async function main(argv) {
  const args = argv.slice(2);
  const cmd = args[0];
  try {
    switch (cmd) {
      case "test-run": return cmdTestRun(args.slice(1));
      case "validate": return cmdValidate(args.slice(1));
      case "hash": return cmdHash(args.slice(1));
      case "collect": return cmdCollect(args.slice(1));
      case "render": return cmdRender(args.slice(1));
      case "secret-scan": return cmdSecretScan(args.slice(1));
      case "tag-prepare": return cmdTagPrepare(args.slice(1));
      case "tag-verify": return cmdTagVerify(args.slice(1));
      case "--version":
        return emit({ subcommand: "version", version: VERSION });
      default:
        diag(`usage: cli.mjs <collect|hash|validate|render|secret-scan|test-run|tag-prepare|tag-verify> ...`);
        emit({ subcommand: "unknown", status: "BLOCK", reason: `unknown command: ${cmd}` });
        process.exitCode = 2;
    }
  } catch (e) {
    diag(`error: ${e.stack || e.message}`);
    emit({ subcommand: cmd || "unknown", status: "BLOCK", reason: e.message });
    process.exitCode = 1;
  }
}

async function cmdTestRun(args) {
  const testDir = args[0] || join(resolve("."), "tools/m0/test");
  const files = readdirSync(testDir)
    .filter((f) => f.endsWith(".test.mjs"))
    .map((f) => join(testDir, f));
  const r = spawnSync(process.execPath, ["--test", ...files], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  diag(r.stderr || "");
  // parse the trailing summary block node --test prints
  const out = r.stdout || "";
  const grab = (key) => {
    const m = new RegExp(`# (tests|pass|fail|skipped)\\s+(\\d+)`).exec(out + r.stderr);
    return m ? Number(m[2]) : null;
  };
  const summary = {};
  const combined = out + "\n" + (r.stderr || "");
  for (const k of ["tests", "pass", "fail", "skipped"]) {
    const m = combined.match(new RegExp(`(?:#|ℹ)\\s+${k}\\s+(\\d+)`));
    if (m) summary[k] = Number(m[1]);
  }
  emit({
    subcommand: "test-run",
    status: (summary.fail || 0) > 0 ? "FAIL" : "PASS",
    exitCode: r.status,
    ...summary,
  });
  if ((summary.fail || 0) > 0) process.exitCode = 1;
}

async function cmdValidate(args) {
  const dir = args[0];
  if (!dir) throw new Error("validate: missing dossier dir");
  const { validateInstance, loadAllSchemas, loadSchema } = await import("./validate.mjs");
  const all = loadAllSchemas();
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  let ok = 0;
  const errors = [];
  for (const f of files) {
    const inst = JSON.parse(readFileSync(join(dir, f), "utf8"));
    const sid = inst.schemaId;
    const entry = all.get(sid);
    if (!entry) { errors.push({ file: f, error: `no schema for schemaId ${sid}` }); continue; }
    const errs = validateInstance(inst, entry.schema);
    if (errs.length) errors.push({ file: f, errors: errs });
    else ok++;
  }
  emit({ subcommand: "validate", status: errors.length ? "FAIL" : "PASS", validated: ok, total: files.length, errors });
  if (errors.length) process.exitCode = 1;
}

async function cmdHash(args) {
  const root = args[0];
  if (!root) throw new Error("hash: missing root dir");
  // remaining args: file list; or read newline-separated from stdin if "-"
  let relPaths = args.slice(1);
  if (relPaths.length === 1 && relPaths[0] === "-") {
    relPaths = readFileSync(0, "utf8").split(/\r?\n/).filter(Boolean);
  }
  const { collectEntries, buildProjection } = await import("./hash.mjs");
  const { gitModeMap } = await import("./collect.mjs");
  let modeMap;
  try { modeMap = gitModeMap(root); } catch { modeMap = new Map(); }
  const entries = collectEntries(root, relPaths.map((p) => p.replace(/\\/g, "/")), { gitModeMap: modeMap });
  const proj = buildProjection(entries);
  emit({
    subcommand: "hash",
    status: "PASS",
    hash: proj.hash,
    fileCount: proj.fileCount,
    totalBytes: proj.totalBytes,
  });
}

async function cmdCollect(args) {
  const registryPath = args[0];
  const deviceAgentPath = args[1] || null;
  if (!registryPath) throw new Error("collect: missing registry path");
  const { collectRepoIdentity } = await import("./collect.mjs");
  const reg = collectRepoIdentity(registryPath, { name: "registry" }, args.find((a) => a.startsWith("--registry-sha="))?.split("=")[1] || "");
  emit({ subcommand: "collect", status: "PASS", repos: [reg] });
}

async function cmdRender(args) {
  const dir = args[0];
  if (!dir) throw new Error("render: missing dossier dir");
  const out = args[1]; // optional output path
  const compare = args.includes("--compare") ? args[args.indexOf("--compare") + 1] : null;
  const { renderDir } = await import("./render.mjs");
  const md = await renderDir(dir);
  const { createHash } = await import("node:crypto");
  const sha256 = createHash("sha256").update(md, "utf8").digest("hex");
  if (out) writeFileSync(out, md);
  let compareResult = null;
  if (compare && existsSync(compare)) {
    const existing = readFileSync(compare, "utf8");
    compareResult = existing === md ? "MATCH" : "DIFF";
  }
  emit({
    subcommand: "render",
    status: compareResult === "DIFF" ? "FAIL" : "PASS",
    bytes: Buffer.byteLength(md, "utf8"),
    sha256,
    compareResult,
  });
  if (compareResult === "DIFF") process.exitCode = 1;
}

async function cmdSecretScan(args) {
  const target = args[0];
  if (!target) throw new Error("secret-scan: missing target file or dir");
  const { scanText } = await import("./secret-scan.mjs");
  const findings = [];
  if (existsSync(target)) {
    const { statSync } = await import("node:fs");
    if (statSync(target).isDirectory()) {
      for (const f of readdirSync(target)) {
        if (!f.endsWith(".json") && !f.endsWith(".md") && !f.endsWith(".mjs")) continue;
        findings.push(...scanText(readFileSync(join(target, f), "utf8"), { path: f }));
      }
    } else {
      findings.push(...scanText(readFileSync(target, "utf8"), { path: target }));
    }
  }
  emit({ subcommand: "secret-scan", status: findings.length ? "FINDINGS" : "CLEAN", count: findings.length, findings });
}

async function cmdTagPrepare(args) {
  const [repo, tagName, target, peerRepo, peerTarget] = args;
  if (!repo || !tagName || !target) throw new Error("tag-prepare: <repo> <tagName> <target> [peerRepo] [peerTarget]");
  const { prepareTag, buildAnnotation } = await import("./tag.mjs");
  const ann = buildAnnotation({
    baselineId: args.find((a) => a.startsWith("--baseline="))?.split("=")[1] || "",
    thisSide: { tagName, repo, target },
    peerSide: { tagName: "(peer)", repo: peerRepo || "(peer)", target: peerTarget || "(peer)" },
    inputPair: { registry: "(tbd)", deviceAgent: "(tbd)" },
    projectionHashes: { registry: "(tbd)", deviceAgent: "(tbd)" },
    toolingHash: "(tbd)",
    dossierManifestHash: "(tbd)",
  });
  const r = prepareTag(repo, "origin", { tagName, target, annotation: ann });
  emit({ subcommand: "tag-prepare", status: "PASS", ...r });
}

async function cmdTagVerify(args) {
  const [repo, tagName, target, baselineId] = args;
  if (!repo || !tagName || !target || !baselineId) throw new Error("tag-verify: <repo> <tagName> <target> <baselineId>");
  const { verifyTag } = await import("./tag.mjs");
  const v = verifyTag(repo, tagName, target, baselineId);
  emit({ subcommand: "tag-verify", status: v.ok ? "PASS" : "FAIL", ...v });
  if (!v.ok) process.exitCode = 1;
}

// entry guard
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main(process.argv);
}