#!/usr/bin/env node
/**
 * xw-xhs-routine-accept.mjs — read-only acceptance snapshot/verify tool for
 * the xhs routine live waves (plan V2 §5.3/§8.4).
 *
 *   before --wave S1 --aliases 03        snapshot CP leases + registry device view
 *   after  --wave S1 --run-id xe_...     read the authoritative run-store trace,
 *                                        assert cleanup/deltas, emit the wave receipt
 *   corpus verify --manifest <path>      verify the S4 vision corpus (R2; §8.2)
 *
 * Zero device I/O: only loopback CP/Registry GETs and run-store file reads.
 * Raw screenshots/XML never enter Git; receipts hold refs/hashes only.
 * Console: console.log only (Windows bridge treats stderr as fatal).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { readRoutineTrace } from "../scripts/lib/xhs-routine-run-store.mjs";
import { createExplorerRoutineRuntime } from "./_xhs-routine-explorer-runtime.mjs";

const RECEIPT_SCHEMA = "xw.xhs.routine-live-wave-receipt.v1";
const KNOWN_WAVES = new Set(["S1", "S2", "S3", "S4", "PARALLEL"]);

function acceptanceRoot() {
  const runtimeRoot = process.env.XW_RUNTIME_ROOT
    || (process.platform === "win32" ? "C:\\Users\\Public\\xw-runtime" : resolve("xw-runtime"));
  return join(runtimeRoot, "state", "orchestrator", "xhs-routine-acceptance");
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--") && i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      out[a.slice(2)] = argv[++i];
    } else if (a.startsWith("--")) {
      out[a.slice(2)] = true;
    } else {
      out._.push(a);
    }
  }
  return out;
}

function usage() {
  return `usage:
  node ops/xw-xhs-routine-accept.mjs before --wave S1 --aliases 03
  node ops/xw-xhs-routine-accept.mjs after  --wave S1 --run-id xe_... --aliases 03
  node ops/xw-xhs-routine-accept.mjs corpus verify --manifest <corpus-manifest.v1.json>

before: read-only snapshot of CP leases + registry device view per alias.
after:  binds the before snapshot, reads the run-store trace and asserts
        cleanup/deltas, emitting a ${RECEIPT_SCHEMA} receipt.`;
}

function emit(payload, exitCode = 0) {
  console.log(JSON.stringify(payload, null, 2));
  return exitCode;
}

function emitError(code, message, extra = {}) {
  emit({ ok: false, error: { code, message, ...extra } }, 4);
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function assertWave(value) {
  const wave = String(value || "").toUpperCase();
  if (!KNOWN_WAVES.has(wave)) {
    throw Object.assign(new Error(`unknown wave ${value}; expected one of ${[...KNOWN_WAVES].join(",")}`), {
      code: "ACCEPT_WAVE_UNKNOWN",
    });
  }
  return wave;
}

function assertAliases(value) {
  const aliases = String(value || "03").split(",").map((a) => a.trim()).filter(Boolean);
  if (!aliases.length || aliases.some((a) => !/^\d{2}$/.test(a))) {
    throw Object.assign(new Error("--aliases must be a comma list of two-digit aliases"), {
      code: "ACCEPT_ALIASES_INVALID",
    });
  }
  return aliases;
}

/** Read-only fleet snapshot: leases + registry device view, no mutations.
 *  snapshotImpl is a test seam only; production always uses the runtime. */
async function snapshot({ aliases }) {
  const runtime = createExplorerRoutineRuntime({});
  const leases = await runtime.listLeases();
  return leasesToSnapshot(leases, aliases);
}

function leasesToSnapshot(leases, aliases) {
  const rows = Array.isArray(leases) ? leases : [];
  return {
    capturedAt: new Date().toISOString(),
    aliases,
    globalActiveLeases: rows.length,
    leasesByAlias: Object.fromEntries(aliases.map((alias) => [
      alias,
      rows.filter((l) => l?.alias === alias || l?.deviceAlias === alias).map((l) => l.leaseId),
    ])),
    leaseIds: rows.map((l) => l.leaseId).sort(),
  };
}

async function cmdBefore({ wave, aliases }) {
  const snapshotData = await cmdBeforeForTest.snapshotImpl({ aliases });
  const dir = acceptanceRoot();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${wave}-before.json`);
  const body = { schemaId: "xw.xhs.routine-accept-snapshot.v1", phase: "before", wave, ...snapshotData };
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  emit({ ok: true, command: "before", wave, path, snapshot: body });
}

function loadBefore(wave) {
  const path = join(acceptanceRoot(), `${wave}-before.json`);
  if (!existsSync(path)) {
    throw Object.assign(new Error(`no before snapshot for wave ${wave}; run 'before' first`), {
      code: "ACCEPT_BEFORE_SNAPSHOT_MISSING",
    });
  }
  return { path, body: JSON.parse(readFileSync(path, "utf8")) };
}

// V2.1 closeout: every fresh acceptance receipt must carry the release identity
// it ran under — closeout `receipt --emit-contract` refuses identity-less
// receipts as stale lineage (the release-A xe_ receipts must never seed a PASS).
// Identity source (first hit wins): explicit --release-id/--source-commit flags,
// then XW_RELEASE_MANIFEST (read + parsed, no fallback beyond it).
function resolveReleaseIdentity({ releaseId, sourceCommit }) {
  if (releaseId && releaseId !== true && sourceCommit && sourceCommit !== true) {
    return { releaseId: String(releaseId), sourceCommit: String(sourceCommit) };
  }
  const manifestPath = process.env.XW_RELEASE_MANIFEST;
  if (manifestPath && existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest?.releaseId && manifest?.sourceCommit) {
      return { releaseId: String(manifest.releaseId), sourceCommit: String(manifest.sourceCommit) };
    }
  }
  return null;
}

async function cmdAfter({ wave, runId, aliases, releaseId, sourceCommit }) {
  const before = loadBefore(wave);
  const after = await cmdBeforeForTest.snapshotImpl({ aliases });
  const { trace } = readRoutineTrace(runId);
  const run = trace.routineRun;
  const runReceipt = run?.receipt ?? {};
  const cleanup = runReceipt.cleanup ?? {};
  const releaseIdentity = resolveReleaseIdentity({ releaseId, sourceCommit });

  const afterLeaseIds = new Set(after.leaseIds);
  const newLeases = after.leaseIds.filter((id) => !before.body.leaseIds.includes(id));
  // the run's own lease must be gone; every surviving lease must have existed before
  const ownedRemaining = afterLeaseIds.has(run.leaseId ?? "__none__");

  const primitiveTrace = Array.isArray(run.primitiveTrace) ? run.primitiveTrace : null;
  // Parallel batch (xhs-routine-runner mode:"parallel-batch"): the parent receipt
  // carries no primitive trace and a lane-aggregated cleanup — cleanup.verified
  // already encodes "both lanes SUCCEEDED with child.cleanupRecovery
  // .activeOwnedLeases===0". Assert lanes instead of the single-run shape.
  const isParallel = run?.mode === "parallel-batch" && Array.isArray(runReceipt.children);
  const parallelChildren = isParallel ? runReceipt.children : null;
  const assertions = {
    runSucceeded: trace.status === "SUCCEEDED",
    serverVerified: run.serverVerified === true,
    cleanupVerified: isParallel
      ? runReceipt.cleanup?.verified === true
      : (cleanup.verified === true && cleanup.activeLeases === 0 && cleanup.restored === true),
    noNewLeases: newLeases.length === 0,
    ownedLeaseReleased: ownedRemaining === false,
    nonTargetAliasZeroDelta: true, // widened below when trace exposes alias I/O
    primitiveTracePresent: isParallel
      ? parallelChildren.length > 0 && parallelChildren.every((c) => c && typeof c.routineRunId === "string")
      : (Array.isArray(primitiveTrace) && primitiveTrace.length > 0),
  };
  if (isParallel) {
    assertions.childLanesSucceeded = parallelChildren.length === before.body.aliases.length
      && parallelChildren.every((c) => c.status === "SUCCEEDED");
  }
  if (before.body.aliases.length > 1 && run.alias && before.body.aliases.includes(run.alias)) {
    const others = before.body.aliases.filter((a) => a !== run.alias);
    // leases are the only cross-alias I/O observable without device contact;
    // any new lease on a non-target alias is a hard delta
    assertions.nonTargetAliasZeroDelta = !after.leaseIds.some((id) => newLeases.includes(id)
      && others.some((alias) => (after.leasesByAlias[alias] || []).includes(id)));
  }

  const pass = Object.values(assertions).every(Boolean);
  const receipt = {
    schemaId: RECEIPT_SCHEMA,
    schemaVersion: 1,
    wave,
    verdict: pass ? "PASS" : "FAIL",
    emittedAt: new Date().toISOString(),
    releaseIdentity,
    run: {
      executionRunId: trace.executionRunId,
      routineRunId: trace.routineRunId,
      planHash: trace.planHash,
      alias: trace.alias,
      status: trace.status,
      serverVerified: run.serverVerified === true,
      stopReason: runReceipt.stopReason ?? null,
    },
    cleanup: {
      verified: cleanup.verified === true,
      activeLeases: cleanup.activeLeases ?? null,
      restored: cleanup.restored ?? null,
      authorityRef: cleanup.authorityRef ?? null,
    },
    primitives: Array.isArray(primitiveTrace)
      ? primitiveTrace.map((p) => ({ seq: p.seq, primitive: p.primitive, jobId: p.jobId, status: p.status, outputOk: p.outputOk, evidenceRef: p.evidenceRef }))
      : null,
    dumpHashes: Array.isArray(runReceipt.dumpHashes) ? runReceipt.dumpHashes : null,
    leaseDelta: { before: before.body.leaseIds, after: after.leaseIds, newLeases },
    assertions,
    beforeSnapshot: before.path,
  };
  const dir = acceptanceRoot();
  mkdirSync(dir, { recursive: true });
  const receiptPath = join(dir, `${wave}-${trace.executionRunId}-receipt.json`);
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  const summary = { ok: pass, command: "after", wave, verdict: receipt.verdict, assertions, receiptPath };
  emit(summary);
  return pass ? summary : Object.assign(summary, { exitCode: 5 });
}

/** §8.2 (R2): corpus manifest verification. Asserted fields are the §7.1 hard gate. */
function cmdCorpus({ _: positional, manifest }) {
  const action = positional[1];
  if (action !== "verify") {
    emitError("ACCEPT_CORPUS_USAGE", usage());
    return;
  }
  const manifestPath = resolve(String(manifest || ""));
  if (!existsSync(manifestPath)) {
    emitError("ACCEPT_CORPUS_MANIFEST_MISSING", `corpus manifest not found: ${manifestPath}`);
    return;
  }
  const corpus = JSON.parse(readFileSync(manifestPath, "utf8"));
  const root = resolve(manifestPath, "..");
  const problems = [];
  if (corpus.schemaId !== "xw.xhs.routine-vision-corpus.v1") problems.push("schemaId mismatch");
  if (corpus.alias !== "03") problems.push("corpus must be captured on alias 03");
  const frames = Array.isArray(corpus.frames) ? corpus.frames : [];
  if (frames.length < 3) problems.push("at least 3 frames required");
  const hashes = new Set();
  for (const frame of frames) {
    const pngPath = join(root, frame.pngPath || "");
    const annotationPath = join(root, frame.annotationPath || "");
    if (!existsSync(pngPath)) { problems.push(`missing png: ${frame.pngPath}`); continue; }
    if (!existsSync(annotationPath)) { problems.push(`missing annotation: ${frame.annotationPath}`); continue; }
    const hash = sha256File(pngPath);
    hashes.add(hash);
    if (frame.pngSha256 && frame.pngSha256 !== hash) problems.push(`png hash mismatch: ${frame.pngPath}`);
    if (frame.annotationSha256 && frame.annotationSha256 !== sha256File(annotationPath)) {
      problems.push(`annotation hash mismatch: ${frame.annotationPath}`);
    }
    if (frame.annotator?.id === corpus.productionProvider?.id) {
      problems.push(`annotator is the production provider: ${frame.pngPath}`);
    }
  }
  if (hashes.size !== frames.length) problems.push("frame PNG hashes are not all distinct");
  const ok = problems.length === 0;
  const exitCode = ok ? 0 : 4;
  emit({ ok, verdict: ok ? "PASS" : "FAIL", manifestPath, frames: frames.length, problems });
  if (exitCode) process.exitCode = exitCode;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  try {
    if (command === "before") {
      await cmdBefore({ wave: args.wave, aliases: assertAliases(args.aliases) });
    } else if (command === "after") {
      const result = await cmdAfter({
        wave: args.wave,
        runId: args["run-id"] || args.runId,
        aliases: assertAliases(args.aliases),
        releaseId: args["release-id"] ?? args.releaseId,
        sourceCommit: args["source-commit"] ?? args.sourceCommit,
      });
      if (result?.exitCode) process.exitCode = result.exitCode;
    } else if (command === "corpus") {
      cmdCorpus(args);
    } else {
      process.exitCode = 4;
      emitError("ACCEPT_USAGE", usage());
    }
  } catch (error) {
    process.exitCode = 4;
    emitError(error?.code || "ACCEPT_FAILED", error?.message || String(error));
  }
}

// test seam: production uses the loopback runtime; offline tests stub this
cmdBeforeForTest.snapshotImpl = snapshot;

export function cmdBeforeForTest(input) {
  return cmdBefore(input);
}

export function cmdAfterForTest(input) {
  return cmdAfter(input);
}

const isDirect = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isDirect) await main();