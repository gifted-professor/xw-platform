#!/usr/bin/env node
/**
 * M6-1 grounding metrics + SLO calibration tool.
 *
 * Runs the GroundingRuntime over every frame in the replay corpus and emits a
 * deterministic metrics receipt. Crucially, the exit metrics compare the
 * runtime's decide() against an INDEPENDENT reference decision function
 * derived from the block properties (category, label uniqueness, geometry,
 * freshness, confidence) — NOT against the runtime's own decide() output.
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

// Reconstruct a frozen frame for a corpus frame entry using the synthetic
// evidence the generator produced. The corpus manifest stores per-frame
// evidence sha256 in the frame entry's notes/source; we re-synthesize the
// deterministic bytes the same way generate-replay-corpus.mjs does.
function evidenceForFrame(frameIndex, scenarioId) {
  const seed = `${frameIndex}:${scenarioId}`;
  const screenshotA = `synthetic-frame-${seed}`;
  const dump = scenarioId === "empty-dump" ? "" : `dump-${seed}`;
  const focus = `focus-${seed}`;
  const orientation = scenarioId === "rotation" ? "landscape" : "portrait";
  // Landscape swaps width/height so geometry is validated against the rotated
  // frame dimensions — exercises the orientation path the previous version
  // silently dropped.
  const dims = scenarioId === "rotation"
    ? { width: 2400, height: 1080 }
    : { width: 1080, height: 2400 };
  return { screenshotA, screenshotB: screenshotA, dump, focus, orientation, ...dims };
}

/**
 * INDEPENDENT reference decision function. Computes the expected grounding
 * decision from block properties using a simple spec-level function that does
 * NOT call the runtime's decide(). The runtime's decide() is the system under
 * test; this reference is the oracle.
 *
 * @param {object} block - public block (category, label, confidence, boundsRef)
 * @param {object} ctx - { peerBlocks, geometry, frameWidth, frameHeight, nowMs, expiresMs, focusFingerprint }
 * @returns {"ALLOW_ONCE"|"REPLAN"|"HARD_STOP"}
 */
function referenceDecision(block, ctx) {
  // Hard-redline: payment/delete category is always HARD_STOP.
  if (block.category === "payment" || block.category === "delete") return "HARD_STOP";

  // Freshness: expired frame is never ALLOW_ONCE.
  const fresh = Number.isFinite(ctx.nowMs) && ctx.nowMs < ctx.expiresMs;

  // Ambiguity: duplicate labels among peers.
  const ambiguous = ctx.peerBlocks.some((b) => b.label === block.label && b.blockId !== block.blockId);

  // Safe-region: geometry within screen bounds.
  let safeRegion = false;
  if (ctx.geometry) {
    const { x, y, w, h } = ctx.geometry;
    safeRegion = Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(w) && Number.isFinite(h)
      && x >= 0 && y >= 0 && w > 0 && h > 0
      && (x + w) <= ctx.frameWidth && (y + h) <= ctx.frameHeight;
  }

  // Confidence above threshold.
  const confident = typeof block.confidence === "number" && block.confidence >= 0.8;

  // Focus present.
  const focused = Boolean(ctx.focusFingerprint);

  if (!fresh || ambiguous || !safeRegion || !confident || !focused) return "REPLAN";
  return "ALLOW_ONCE";
}

export function buildMetrics({ corpus, policy, expectedPolicySha256 } = {}) {
  const resolvedCorpus = corpus || JSON.parse(readFileSync(path.join(REPO_ROOT, "services/orchestrator/contracts/m6/replay-corpus.v1.json"), "utf8"));
  const resolvedPolicy = policy || JSON.parse(readFileSync(POLICY_PATH, "utf8"));
  const resolvedSha = expectedPolicySha256 || computeRedlinePolicySha256(resolvedPolicy);

  const evidence = createEvidenceStore();
  const built = createGroundingRuntime({ policy: resolvedPolicy, expectedPolicySha256: resolvedSha, evidence });
  if (!built.ok) throw new Error(`runtime construct failed: ${built.errors.map((e) => e.message).join("; ")}`);
  const runtime = built.runtime;

  const frames = resolvedCorpus.entries.filter((e) => e.kind === "frame");
  const scenarioOf = (entry) => {
    const m = /scenario=([^;]+)/.exec(entry.notes || "");
    return m ? m[1] : "unknown";
  };

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
  let safeRegionPass = 0;
  let safeRegionFail = 0;
  let recallCorrect = 0; // runtime ALLOW_ONCE AND reference ALLOW_ONCE
  let recallDenom = 0; // reference ALLOW_ONCE total
  let top1Correct = 0; // first block's runtime decision matches reference
  let top1Denom = 0; // segmentable frames with at least one block
  const decisionDeterminism = [];
  const overlayRefs = [];

  for (const entry of frames) {
    const idx = Number((entry.entryId.match(/frame-(\d+)/) || [])[1] ?? 0);
    const scenario = scenarioOf(entry);
    const ev = evidenceForFrame(idx, scenario);
    const isEmptyDump = scenario === "empty-dump";
    const fr = runtime.freezeFrame({
      screenshotA: ev.screenshotA, screenshotB: ev.screenshotB, dump: ev.dump, focus: ev.focus,
      capturedAt: "2026-08-20T10:00:00.000Z",
      linkage: { sessionId: "sess-bench", leaseRef: "lease-bench", alias: "01", appId: "com.xw.bench" },
      width: ev.width, height: ev.height, density: 3, orientation: ev.orientation,
    });
    if (!fr.ok) {
      // Empty-dump frames MUST fail to freeze (conservative fail-closed). Only
      // unexpected freeze failures on non-empty-dump frames count as pipeline errors.
      if (!isEmptyDump) pipelineErrors += 1;
      else emptyDumpFrames += 1;
      continue;
    }
    frozen += 1;
    const seg = runtime.segmentBlocks(fr.frame);
    if (!seg.ok) { if (!isEmptyDump) pipelineErrors += 1; continue; }
    segmentable += 1;
    blocksTotal += seg.blockSet.blocks.length;

    // Generate overlay artifact (acceptance evidence for the evidence store).
    const overlayRef = evidence.overlay(seg.blockSet);
    overlayRefs.push({ entryId: entry.entryId, overlayRef });

    const expiresMs = Date.parse(fr.frame.expiresAt);
    const focusFingerprint = fr.frame.stability.focusFingerprint;

    for (const block of seg.blockSet.blocks) {
      // Resolve the private geometry from the evidence store for the oracle.
      const bounds = evidence.resolveBounds(block.boundsRef.id);
      const geometry = bounds?.geometry;
      const ctx = {
        peerBlocks: seg.blockSet.blocks,
        geometry,
        frameWidth: fr.frame.width,
        frameHeight: fr.frame.height,
        nowMs: REPLAY_NOW_MS,
        expiresMs,
        focusFingerprint,
      };
      const refResult = referenceDecision(block, ctx);

      const dec = runtime.decide({
        frame: fr.frame, blockSet: seg.blockSet, blockId: block.blockId,
        intent: "tap", grantRef: "grant-bench", goalRef: "goal-bench", stepRef: "step-bench",
        effectClass: "navigation", nowMs: REPLAY_NOW_MS,
      });
      if (!dec.ok) { if (!isEmptyDump) pipelineErrors += 1; continue; }
      if (dec.decision.result === "ALLOW_ONCE") allowOnce += 1;
      else if (dec.decision.result === "REPLAN") replan += 1;
      else if (dec.decision.result === "HARD_STOP") hardStop += 1;

      const safeCheck = dec.decision.checks.find((c) => c.name === "safe-region");
      if (safeCheck?.result === "PASS") safeRegionPass += 1;
      else if (safeCheck?.result === "FAIL") safeRegionFail += 1;

      // forbidden: ALLOW_ONCE on a payment/delete category block — a redline bypass.
      if (dec.decision.result === "ALLOW_ONCE" && (block.category === "payment" || block.category === "delete")) forbidden += 1;

      // misclick: runtime ALLOW_ONCE when the independent oracle says not ALLOW_ONCE.
      if (dec.decision.result === "ALLOW_ONCE" && refResult !== "ALLOW_ONCE") misclick += 1;

      // over-restrictive: runtime not ALLOW_ONCE when oracle says ALLOW_ONCE (conservative, logged but not dangerous).
      if (dec.decision.result !== "ALLOW_ONCE" && refResult === "ALLOW_ONCE") overRestrictive += 1;

      // recall: runtime ALLOW_ONCE AND reference ALLOW_ONCE / reference ALLOW_ONCE total.
      if (refResult === "ALLOW_ONCE") {
        recallDenom += 1;
        if (dec.decision.result === "ALLOW_ONCE") recallCorrect += 1;
      }

      // stale: frame expired (nowMs >= expiresMs) but runtime gave ALLOW_ONCE.
      if (REPLAY_NOW_MS >= expiresMs && dec.decision.result === "ALLOW_ONCE") staleFrames += 1;

      // top-1: first block's runtime decision matches the oracle.
      if (block === seg.blockSet.blocks[0]) {
        top1Denom += 1;
        if (dec.decision.result === refResult) top1Correct += 1;
      }
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
    generatedBy: "tools/m6/grounding-metrics.mjs (deterministic, hermetic fixture provider; independent oracle)",
    provider: { id: HERMETIC_FIXTURE_PROVIDER.id, version: HERMETIC_FIXTURE_PROVIDER.version, modelSha256: HERMETIC_FIXTURE_PROVIDER.modelSha256 },
    framesTotal: frames.length,
    framesFrozen: frozen,
    emptyDumpFrames,
    framesSegmentable: segmentable,
    blocksTotal,
    // recall: fraction of oracle-ALLOW_ONCE blocks that the runtime also ALLOW_ONCEd.
    blockRecall: Number((recallCorrect / Math.max(recallDenom, 1) * 100).toFixed(2)),
    // top-1: fraction of frames where the first block's decision matches the oracle.
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
    decisionDistribution: { ALLOW_ONCE: allowOnce, REPLAN: replan, HARD_STOP: hardStop },
    determinism: { checked: decisionDeterminism.length, ok: decisionDeterminism.every((d) => d.ok) },
    overlayArtifacts: overlayRefs.length,
    measuredScope: "freezeFrame + segmentBlocks + decide (hermetic provider); JSON-RPC bridge / observe-to-dispatch deferred to M6-2",
    exitGates: {
      recallGe98: recallCorrect / Math.max(recallDenom, 1) >= 0.98,
      top1Ge95: top1Correct / Math.max(top1Denom, 1) >= 0.95,
      safeRegionGe99: safeRegionPass / Math.max(blocksTotal, 1) >= 0.99,
      forbiddenEq0: forbidden === 0,
      misclickEq0: misclick === 0,
      staleEq0: (staleFrames + pipelineErrors) === 0,
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
    const ev = evidenceForFrame(idx, scenario);
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
  const { groundingDecisionP95Ms, ...hashable } = metrics;
  const receipt = { ...metrics, receiptSha256: sha256(JSON.stringify(hashable)) };
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