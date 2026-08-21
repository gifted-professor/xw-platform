#!/usr/bin/env node
/**
 * M6-1 grounding metrics + SLO calibration tool.
 *
 * Runs the GroundingRuntime over every frame in the replay corpus and emits a
 * deterministic metrics receipt. Crucially, the exit metrics compare the
 * runtime's output against INDEPENDENT, committed per-scene annotations
 * (expected blocks, bounds, top target and decisions) — never against truth
 * derived from the runtime/provider output under test.
 * This makes recall / top-1 / misclick honest measurements of decision
 * quality, not circular self-consistency checks.
 *
 * The receipt is written to a content-addressed JSON file with LF-normalized
 * hashing so it reproduces identically on Windows and Linux. The receiptSha256
 * excludes timing values (groundingDecisionP95Ms) so it is deterministic
 * despite machine-dependent latency.
 *
 * Exit metrics (task brief §M6-1): recall >=98%, top-1 >=95%, safe-region >=99%,
 * forbidden/misclick/stale = 0.
 *
 * Usage: node tools/m6/grounding-metrics.mjs [--out <path>]
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  HERMETIC_FIXTURE_PROVIDER,
  createEvidenceStore,
  createGroundingRuntime,
} from "../../services/orchestrator/scripts/lib/m6/m6-grounding-runtime.mjs";
import { computeRedlinePolicySha256 } from "../../services/orchestrator/scripts/lib/m6/m6-contracts.mjs";
import { frameManifestContent, syntheticEvidence } from "./generate-replay-corpus.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const DEFAULT_OUT = "services/orchestrator/contracts/m6/grounding-metrics.v1.json";
const POLICY_PATH = path.join(REPO_ROOT, "services/orchestrator/tests/fixtures/m6/hard-redline-policy.valid.json");
// Deterministic "now" for replay: well after every frame's capturedAt so
// freshness PASSes for non-expired frames, but expired frames (capturedAt far
// in the past) correctly FAIL. This is the corpus clock, not an ambient clock.
const REPLAY_NOW_MS = Date.parse("2026-08-20T10:00:02.000Z");

function sha256(input) {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

// Add dimensions (not produced by syntheticEvidence, which lives in the
// generator's module) based on orientation.
function evidenceWithDims(frameIndex, scenarioId) {
  const ev = syntheticEvidence(frameIndex, scenarioId);
  const dims = ev.orientation === "landscape"
    ? { width: 2400, height: 1080 }
    : { width: 1080, height: 2400 };
  return { ...ev, ...dims };
}

// Build a lookup of the actual manifest entries. Metrics verify both declared
// sha256 and byte length for the frame manifest plus every evidence artifact.
function buildManifestIndex(corpus) {
  const index = new Map();
  for (const entry of corpus.entries) {
    const parts = (entry.entryId || "").split(":");
    const key = parts[0];
    if (!index.has(key)) index.set(key, {});
    index.get(key)[parts[1] || "frame"] = entry;
  }
  return index;
}

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

function sameBounds(actual, expected) {
  return actual && expected
    && actual.x === expected.x && actual.y === expected.y
    && actual.w === expected.w && actual.h === expected.h;
}

function matchExpectedBlock(block, expectedBlocks, evidence) {
  const bounds = evidence.resolveBounds(block.boundsRef?.id)?.geometry;
  return expectedBlocks.find((expected) => expected.stableIndex === block.stableIndex
    && expected.label === block.label
    && expected.category === block.category
    && sameBounds(bounds, expected.bounds));
}

export function receiptSha256For(metrics) {
  const { groundingDecisionP95Ms, receiptSha256, ...hashable } = metrics;
  return sha256(JSON.stringify(hashable));
}

export function buildMetrics({ corpus, policy, expectedPolicySha256, provider = HERMETIC_FIXTURE_PROVIDER } = {}) {
  const resolvedCorpus = corpus || JSON.parse(readFileSync(path.join(REPO_ROOT, "services/orchestrator/contracts/m6/replay-corpus.v1.json"), "utf8"));
  const resolvedPolicy = policy || JSON.parse(readFileSync(POLICY_PATH, "utf8"));
  const resolvedSha = expectedPolicySha256 || computeRedlinePolicySha256(resolvedPolicy);

  const evidence = createEvidenceStore();
  const built = createGroundingRuntime({ policy: resolvedPolicy, expectedPolicySha256: resolvedSha, evidence, provider });
  if (!built.ok) throw new Error(`runtime construct failed: ${built.errors.map((e) => e.message).join("; ")}`);
  const runtime = built.runtime;

  const frames = resolvedCorpus.entries.filter((e) => e.kind === "frame");
  const scenarioOf = (entry) => {
    const m = /scenario=([^;]+)/.exec(entry.notes || "");
    return m ? m[1] : "unknown";
  };
  const manifestIndex = buildManifestIndex(resolvedCorpus);

  let frozen = 0;
  let emptyDumpFrames = 0;
  let segmentable = 0;
  let blocksTotal = 0;
  let allowOnce = 0;
  let replan = 0;
  let hardStop = 0;
  let forbidden = 0; // ALLOW_ONCE on a payment/delete block — must never happen
  let misclick = 0; // runtime ALLOW_ONCE when the reference oracle says not ALLOW_ONCE
  let overRestrictive = 0; // runtime HARD_STOP/REPLAN when reference says ALLOW_ONCE (conservative, not dangerous)
  let staleFrames = 0; // expired frames that the runtime did NOT hard-stop (freshness bypass)
  let pipelineErrors = 0; // freeze/segment/decide failure on a non-empty-dump frame
  let evidenceMismatches = 0; // evidence sha256 does not match the committed manifest
  let safeRegionPass = 0;
  let safeRegionFail = 0;
  let recallCorrect = 0; // annotated blocks reproduced exactly by the provider
  let recallDenom = 0; // independently annotated blocks
  let top1Correct = 0; // provider top block matches the annotated target
  let top1Denom = 0; // actionable annotated frames
  const decisionDeterminism = [];
  const overlayRefs = [];

  for (const entry of frames) {
    const idx = Number((entry.entryId.match(/frame-(\d+)/) || [])[1] ?? 0);
    const scenario = scenarioOf(entry);
    const ev = evidenceWithDims(idx, scenario);
    const expected = entry.expected;
    const expectsReject = expected?.frameOutcome === "REJECT";

    // Verify the frame manifest and every evidence artifact by both content hash
    // and byte length. The synthetic bytes are the replay assets; the committed
    // manifest is their immutable address/annotation envelope.
    const manEntry = manifestIndex.get(entry.entryId);
    if (manEntry) {
      const frameContent = frameManifestContent(idx, scenario, ev);
      const aSha = sha256(ev.screenshotA);
      const bSha = sha256(ev.screenshotB);
      const dSha = sha256(ev.dump || "empty");
      const fSha = sha256(ev.focus);
      const checks = [
        [manEntry.frame, sha256(frameContent), byteLength(frameContent)],
        [manEntry.screenshot, aSha, byteLength(ev.screenshotA)],
        [manEntry.screenshot, bSha, byteLength(ev.screenshotB)],
        [manEntry.dump, dSha, byteLength(ev.dump || "empty")],
        [manEntry.focus, fSha, byteLength(ev.focus)],
      ];
      for (const [manifestEntry, actualSha, actualBytes] of checks) {
        if (!manifestEntry || manifestEntry.sha256 !== actualSha || manifestEntry.bytes !== actualBytes) {
          evidenceMismatches += 1;
        }
      }
    } else evidenceMismatches += 1;
    if (!expected || !Array.isArray(expected.blocks)) evidenceMismatches += 1;

    const fr = runtime.freezeFrame({
      screenshotA: ev.screenshotA, screenshotB: ev.screenshotB, dump: ev.dump, focus: ev.focus,
      capturedAt: "2026-08-20T10:00:00.000Z",
      linkage: { sessionId: "sess-bench", leaseRef: "lease-bench", alias: "01", appId: "com.xw.bench" },
      width: ev.width, height: ev.height, density: 3, orientation: ev.orientation,
    });
    if (!fr.ok) {
      if (!expectsReject) pipelineErrors += 1;
      else emptyDumpFrames += 1;
      continue;
    }
    if (expectsReject) { pipelineErrors += 1; continue; }
    frozen += 1;
    const seg = runtime.segmentBlocks(fr.frame);
    if (!seg.ok) { pipelineErrors += 1; continue; }
    segmentable += 1;
    blocksTotal += seg.blockSet.blocks.length;

    // Generate overlay artifact (acceptance evidence for the evidence store).
    const overlayRef = evidence.overlay(seg.blockSet);
    overlayRefs.push({ entryId: entry.entryId, overlayRef });

    const expectedBlocks = expected.blocks;
    recallDenom += expectedBlocks.length;
    const matches = new Map();
    for (const block of seg.blockSet.blocks) {
      const annotated = matchExpectedBlock(block, expectedBlocks, evidence);
      if (annotated) {
        matches.set(block.blockId, annotated);
        recallCorrect += 1;
      }
    }
    const target = expectedBlocks.find((item) => item.stableIndex === expected.targetStableIndex);
    top1Denom += 1;
    if (target && seg.blockSet.blocks[0]
        && matchExpectedBlock(seg.blockSet.blocks[0], [target], evidence)) top1Correct += 1;
    const expiresMs = Date.parse(fr.frame.expiresAt);

    for (const block of seg.blockSet.blocks) {
      const annotated = matches.get(block.blockId);
      const expectedDecision = annotated?.expectedDecision || "REPLAN";

      const dec = runtime.decide({
        frame: fr.frame, blockSet: seg.blockSet, blockId: block.blockId,
        intent: "tap", grantRef: "grant-bench", goalRef: "goal-bench", stepRef: "step-bench",
        effectClass: "navigation", nowMs: REPLAY_NOW_MS,
      });
      if (!dec.ok) { pipelineErrors += 1; continue; }
      if (dec.decision.result === "ALLOW_ONCE") allowOnce += 1;
      else if (dec.decision.result === "REPLAN") replan += 1;
      else if (dec.decision.result === "HARD_STOP") hardStop += 1;

      const safeCheck = dec.decision.checks.find((c) => c.name === "safe-region");
      if (safeCheck?.result === "PASS") safeRegionPass += 1;
      else if (safeCheck?.result === "FAIL") safeRegionFail += 1;

      // forbidden: the runtime allowed a block independently annotated as a
      // redline, or a payment/delete category surfaced without annotation.
      if (dec.decision.result === "ALLOW_ONCE"
          && (expectedDecision === "HARD_STOP" || block.category === "payment" || block.category === "delete")) forbidden += 1;

      if (dec.decision.result === "ALLOW_ONCE" && expectedDecision !== "ALLOW_ONCE") misclick += 1;

      if (dec.decision.result !== "ALLOW_ONCE" && expectedDecision === "ALLOW_ONCE") overRestrictive += 1;

      // stale: frame expired (nowMs >= expiresMs) but runtime gave ALLOW_ONCE.
      if (REPLAY_NOW_MS >= expiresMs && dec.decision.result === "ALLOW_ONCE") staleFrames += 1;

    }

    // determinism: re-segment and re-decide the first block; must match.
    const seg2 = runtime.segmentBlocks(fr.frame);
    const dec0 = runtime.decide({ frame: fr.frame, blockSet: seg.blockSet, blockId: seg.blockSet.blocks[0].blockId, intent: "tap", grantRef: "grant-bench", goalRef: "goal-bench", stepRef: "step-bench", effectClass: "navigation", nowMs: REPLAY_NOW_MS });
    const dec0b = runtime.decide({ frame: fr.frame, blockSet: seg2.blockSet, blockId: seg2.blockSet.blocks[0].blockId, intent: "tap", grantRef: "grant-bench", goalRef: "goal-bench", stepRef: "step-bench", effectClass: "navigation", nowMs: REPLAY_NOW_MS });
    const sameBlockSet = seg2.blockSet.integritySha256 === seg.blockSet.integritySha256;
    const sameDecision = dec0b.decision.result === dec0.decision.result && dec0b.decision.groundingDecisionId === dec0.decision.groundingDecisionId;
    if (sameBlockSet && sameDecision) decisionDeterminism.push({ entryId: entry.entryId, ok: true });
    else pipelineErrors += 1;
  }

  const metrics = {
    schemaId: "xw.grounding-metrics.v1",
    schemaVersion: 1,
    corpusId: resolvedCorpus.corpusId,
    generatedBy: "tools/m6/grounding-metrics.mjs (deterministic; independent committed scene annotations)",
    provider: { id: provider.id, version: provider.version, modelSha256: provider.modelSha256 },
    framesTotal: frames.length,
    framesFrozen: frozen,
    emptyDumpFrames,
    framesSegmentable: segmentable,
    blocksTotal,
    // recall: exact provider block matches / independently annotated blocks.
    blockRecall: Number((recallCorrect / Math.max(recallDenom, 1) * 100).toFixed(2)),
    // top-1: fraction of actionable frames where provider rank 1 matches the annotated target.
    top1: Number((top1Correct / Math.max(top1Denom, 1) * 100).toFixed(2)),
    // safe-region: fraction of blocks with safe-region PASS.
    safeRegion: Number((safeRegionPass / Math.max(blocksTotal, 1) * 100).toFixed(2)),
    forbidden,
    misclick,
    overRestrictive,
    // stale: expired frames that the runtime ALLOW_ONCEd (freshness bypass) + pipeline errors.
    stale: staleFrames + pipelineErrors,
    staleFramesPassed: staleFrames,
    pipelineErrors,
    evidenceMismatches,
    decisionDistribution: { ALLOW_ONCE: allowOnce, REPLAN: replan, HARD_STOP: hardStop },
    determinism: { checked: decisionDeterminism.length, ok: decisionDeterminism.every((d) => d.ok) },
    overlayArtifacts: overlayRefs.length,
    measuredScope: "frame/evidence bytes + independent annotations + freezeFrame + segmentBlocks + decide (hermetic provider); JSON-RPC bridge / observe-to-dispatch deferred to M6-2",
    exitGates: {
      recallGe98: recallCorrect / Math.max(recallDenom, 1) >= 0.98,
      top1Ge95: top1Correct / Math.max(top1Denom, 1) >= 0.95,
      safeRegionGe99: safeRegionPass / Math.max(blocksTotal, 1) >= 0.99,
      forbiddenEq0: forbidden === 0,
      misclickEq0: misclick === 0,
      staleEq0: (staleFrames + pipelineErrors + evidenceMismatches) === 0,
      evidenceIntegrity: evidenceMismatches === 0,
      deterministic: decisionDeterminism.every((d) => d.ok),
    },
    // p95 grounding-decision timing (ms) measured on the hermetic provider over
    // the frozen frames; a regression guard, not a live SLO (real provider in M6-3).
    // EXCLUDED from receiptSha256 so the hash is deterministic despite machine latency.
    groundingDecisionP95Ms: null, // filled by the calibration pass below
  };

  return metrics;
}

// Lightweight timing: measure the full freeze→segment→decide chain p95 over the
// corpus on this machine. The previous version measured decide() only; this
// covers the entire grounding path a caller exercises.
export function measureDecisionP95Ms({ sampleSize = 60 } = {}) {
  const policy = JSON.parse(readFileSync(POLICY_PATH, "utf8"));
  const expectedPolicySha256 = computeRedlinePolicySha256(policy);
  const evidence = createEvidenceStore();
  const built = createGroundingRuntime({ policy, expectedPolicySha256, evidence });
  if (!built.ok) throw new Error("runtime construct failed");
  const runtime = built.runtime;
  const corpus = JSON.parse(readFileSync(path.join(REPO_ROOT, "services/orchestrator/contracts/m6/replay-corpus.v1.json"), "utf8"));
  const frames = corpus.entries.filter((e) => e.kind === "frame");
  const timings = [];
  for (let i = 0; i < Math.min(sampleSize, frames.length); i += 1) {
    const idx = Number((frames[i].entryId.match(/frame-(\d+)/) || [])[1] ?? i);
    const scenario = (/scenario=([^;]+)/.exec(frames[i].notes || "") || [])[1] || "unknown";
    const ev = evidenceWithDims(idx, scenario);
    const t0 = process.hrtime.bigint();
    const fr = runtime.freezeFrame({
      screenshotA: ev.screenshotA, screenshotB: ev.screenshotB, dump: ev.dump, focus: ev.focus,
      capturedAt: "2026-08-20T10:00:00.000Z",
      linkage: { sessionId: "s", leaseRef: "l", alias: "01", appId: "a" },
      width: ev.width, height: ev.height, orientation: ev.orientation,
    });
    if (!fr.ok) { timings.push(Number(process.hrtime.bigint() - t0) / 1e6); continue; }
    const seg = runtime.segmentBlocks(fr.frame);
    if (!seg.ok) { timings.push(Number(process.hrtime.bigint() - t0) / 1e6); continue; }
    const block = seg.blockSet.blocks[0];
    runtime.decide({ frame: fr.frame, blockSet: seg.blockSet, blockId: block.blockId, intent: "tap", grantRef: "g", goalRef: "go", stepRef: "st", effectClass: "navigation", nowMs: REPLAY_NOW_MS });
    timings.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  if (!timings.length) return 0;
  timings.sort((a, b) => a - b);
  return Number(timings[Math.floor(timings.length * 0.95)].toFixed(3));
}

export function generate({ rootDir = REPO_ROOT, out = DEFAULT_OUT } = {}) {
  const metrics = buildMetrics();
  metrics.groundingDecisionP95Ms = measureDecisionP95Ms();
  // receiptSha256 EXCLUDES groundingDecisionP95Ms so the hash is deterministic
  // despite machine-dependent latency. Timing is a regression guard, not a
  // content-addressed contract.
  const receipt = { ...metrics, receiptSha256: receiptSha256For(metrics) };
  const outPath = path.isAbsolute(out || DEFAULT_OUT) ? (out || DEFAULT_OUT) : path.join(rootDir, out || DEFAULT_OUT);
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  return { outPath, exitGates: receipt.exitGates };
}

function main() {
  const argv = process.argv.slice(2);
  const argOf = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
  const result = generate({ out: argOf("--out") });
  const g = result.exitGates;
  process.stdout.write(`GROUNDING_METRICS recall=${g.recallGe98 ? "PASS" : "FAIL"} top1=${g.top1Ge95 ? "PASS" : "FAIL"} safeRegion=${g.safeRegionGe99 ? "PASS" : "FAIL"} forbidden=${g.forbiddenEq0 ? 0 : "FAIL"} misclick=${g.misclickEq0 ? 0 : "FAIL"} stale=${g.staleEq0 ? 0 : "FAIL"} deterministic=${g.deterministic ? "PASS" : "FAIL"} -> ${result.outPath}\n`);
  const ok = Object.values(g).every(Boolean);
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
