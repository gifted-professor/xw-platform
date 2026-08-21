// M6-1 grounding metrics tests. Verifies the committed metrics receipt meets the
// task-brief exit gates and that regeneration is deterministic (Windows/Linux
// parity by construction). Also a lightweight p95 regression guard.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { HERMETIC_FIXTURE_PROVIDER } from "../scripts/lib/m6/m6-grounding-runtime.mjs";
import { buildMetrics, measureDecisionP95Ms, receiptSha256For } from "../../../tools/m6/grounding-metrics.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const RECEIPT_PATH = path.join(REPO_ROOT, "services/orchestrator/contracts/m6/grounding-metrics.v1.json");
const CORPUS_PATH = path.join(REPO_ROOT, "services/orchestrator/contracts/m6/replay-corpus.v1.json");
const receipt = JSON.parse(readFileSync(RECEIPT_PATH, "utf8"));
const manifest = JSON.parse(readFileSync(CORPUS_PATH, "utf8"));

test("grounding metrics: the committed receipt passes every task-brief exit gate", () => {
  assert.equal(receipt.schemaId, "xw.grounding-metrics.v1");
  const g = receipt.exitGates;
  assert.equal(g.recallGe98, true, `block recall must be >=98% (got ${receipt.blockRecall}%)`);
  assert.equal(g.top1Ge95, true, `top-1 must be >=95% (got ${receipt.top1}%)`);
  assert.equal(g.safeRegionGe99, true, `safe-region must be >=99% (got ${receipt.safeRegion}%)`);
  assert.equal(g.forbiddenEq0, true, `forbidden must be 0 (got ${receipt.forbidden})`);
  assert.equal(g.misclickEq0, true, `misclick must be 0 (got ${receipt.misclick})`);
  assert.equal(g.staleEq0, true, `unexpected stale must be 0 (got ${receipt.stale})`);
  assert.equal(g.evidenceIntegrity, true, `evidence hash integrity must hold (got ${receipt.evidenceMismatches} mismatches)`);
  assert.equal(g.deterministic, true, "per-frame determinism must hold");
});

test("P1-5: a tampered corpus (corrupted evidence sha256) causes evidenceIntegrity gate to fail", () => {
  const tampered = JSON.parse(JSON.stringify(manifest));
  // Corrupt the first screenshot entry's sha256.
  const screenshot = tampered.entries.find((e) => e.kind === "screenshot");
  assert.ok(screenshot, "corpus must have a screenshot entry");
  screenshot.sha256 = "0".repeat(64);
  const result = buildMetrics({ corpus: tampered });
  assert.ok(result.evidenceMismatches > 0, `tampered corpus must produce evidence mismatches (got ${result.evidenceMismatches})`);
  assert.equal(result.exitGates.evidenceIntegrity, false, "tampered corpus must fail the evidenceIntegrity gate");
});

test("P1-5: frame hashes and every declared byte length are consumed by the integrity gate", () => {
  const tampered = structuredClone(manifest);
  for (const entry of tampered.entries) entry.bytes = 1;
  for (const entry of tampered.entries.filter((entry) => entry.kind === "frame")) {
    entry.sha256 = "0".repeat(64);
  }
  const result = buildMetrics({ corpus: tampered });
  assert.ok(result.evidenceMismatches > 0);
  assert.equal(result.exitGates.evidenceIntegrity, false);
  assert.equal(result.exitGates.staleEq0, false);
});

test("P1-5: annotations, not provider output, define block recall and top-1 truth", () => {
  const tamperedTruth = structuredClone(manifest);
  for (const frame of tamperedTruth.entries.filter((entry) => entry.kind === "frame" && entry.expected?.frameOutcome === "ACTIONABLE")) {
    frame.expected.blocks[0].label = `independent-nonexistent-target-${frame.entryId}`;
  }
  const result = buildMetrics({ corpus: tamperedTruth });
  assert.ok(result.blockRecall < 98, `tampered truth must lower recall (got ${result.blockRecall})`);
  assert.ok(result.top1 < 95, `tampered target must lower top-1 (got ${result.top1})`);

  const degradedProvider = {
    id: "degraded-fixture-provider",
    version: "1.0.0",
    modelSha256: "d".repeat(64),
    segment(frameArg, evidence) {
      return HERMETIC_FIXTURE_PROVIDER.segment(frameArg, evidence).slice(1);
    },
  };
  const degraded = buildMetrics({ provider: degradedProvider });
  assert.ok(degraded.blockRecall < 98, `provider omission must lower recall (got ${degraded.blockRecall})`);
  assert.ok(degraded.top1 < 95, `provider reorder/omission must lower top-1 (got ${degraded.top1})`);
});

test("grounding metrics: covers >=200 frames and reports the hermetic provider", () => {
  assert.ok(receipt.framesTotal >= 200, `framesTotal ${receipt.framesTotal}`);
  assert.equal(receipt.provider.id, "fixture-provider");
  assert.match(receipt.provider.modelSha256, /^[0-9a-f]{64}$/);
  assert.ok(receipt.framesFrozen > 0);
  assert.ok(receipt.blocksTotal > 0);
});

test("grounding metrics: decision distribution has non-zero ALLOW_ONCE and HARD_STOP", () => {
  assert.ok(receipt.decisionDistribution.ALLOW_ONCE > 0, "some frames must reach ALLOW_ONCE");
  assert.ok(receipt.decisionDistribution.HARD_STOP > 0, "payment/delete blocks must HARD_STOP");
  // Empty-dump frames must fail to freeze (conservative); they are counted, not hidden.
  assert.ok(receipt.emptyDumpFrames > 0, "empty-dump frames must be exercised and fail-closed");
});

test("grounding metrics: regeneration is deterministic and matches the committed receipt", () => {
  const fresh = buildMetrics();
  const { groundingDecisionP95Ms: committedTiming, receiptSha256, ...committedHashable } = receipt;
  const { groundingDecisionP95Ms: freshTiming, ...freshHashable } = fresh;
  assert.deepEqual(freshHashable, committedHashable, "every deterministic receipt field must reproduce exactly");
  assert.equal(receiptSha256, receiptSha256For(fresh), "committed receiptSha256 must match current code/data");
  assert.equal(typeof committedTiming, "number");
  assert.equal(freshTiming, null);
});

test("grounding metrics: p95 grounding-decision latency stays <= the frozen SLO (1s)", () => {
  // CI regression guard: on the hermetic provider over a 60-frame sample, the
  // decide() p95 must be well under 1000ms. This is not the live SLO (real DSH
  // in M6-3) but guards against runtime regressions in the decision path.
  const p95 = measureDecisionP95Ms({ sampleSize: 60 });
  assert.equal(typeof p95, "number");
  assert.ok(p95 > 0, "p95 must be measured");
  assert.ok(p95 < 1000, `grounding-decision p95 ${p95}ms exceeds the 1000ms guard`);
});

test("grounding metrics: the committed receipt's p95 is recorded and under gate", () => {
  assert.equal(typeof receipt.groundingDecisionP95Ms, "number");
  assert.ok(receipt.groundingDecisionP95Ms >= 0);
  assert.ok(receipt.groundingDecisionP95Ms < 1000, "committed p95 must be under the 1s gate");
});

test("grounding metrics: honest annotation-based methodology (not self-referential)", () => {
  assert.equal(typeof receipt.overRestrictive, "number", "overRestrictive must be reported");
  assert.equal(typeof receipt.misclick, "number", "misclick must be reported");
  assert.ok(receipt.overlayArtifacts > 0, "overlay artifacts must be generated");
  assert.ok(receipt.measuredScope.includes("freezeFrame"), "measuredScope must cover the full chain");
  // The receipt hash must exclude timing so it is deterministic.
  assert.match(receipt.receiptSha256, /^[0-9a-f]{64}$/);
  const fresh = buildMetrics();
  assert.equal(receipt.receiptSha256, receiptSha256For(fresh));
});
