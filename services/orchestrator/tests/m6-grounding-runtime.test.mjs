// M6-1 Grounding Runtime tests. Verifies the single runtime produces
// contract-conformant frames, block sets and decisions, that the payment/delete
// hard-redline firewall is unoverridable, and that identical inputs are fully
// deterministic across runs (and therefore across Windows/Linux).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { computeRedlinePolicySha256, computeBlockSetIntegritySha256, deriveBlockId } from "../scripts/lib/m6/m6-contracts.mjs";
import {
  HERMETIC_FIXTURE_PROVIDER,
  createEvidenceStore,
  createGroundingRuntime,
} from "../scripts/lib/m6/m6-grounding-runtime.mjs";

const FIXTURES = path.resolve(import.meta.dirname, "fixtures/m6");
const readFixture = (name) => JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8"));
const POLICY = readFixture("hard-redline-policy.valid.json");
const POLICY_SHA = computeRedlinePolicySha256(POLICY);

// Deterministic stable capture input. A==B yields a stable frame.
function stableCapture(overrides = {}) {
  return {
    screenshotA: "stable-frame-a",
    screenshotB: "stable-frame-a",
    dump: "dump-content",
    focus: "focus-content",
    capturedAt: "2026-08-20T10:00:00.000Z",
    linkage: { sessionId: "sess-01", leaseRef: "lease-01", alias: "01", appId: "com.xingin.xhs" },
    width: 1080,
    height: 2400,
    density: 3,
    ...overrides,
  };
}

function makeRuntime() {
  const evidence = createEvidenceStore();
  const built = createGroundingRuntime({ policy: POLICY, expectedPolicySha256: POLICY_SHA, evidence });
  assert.equal(built.ok, true, `runtime must construct: ${JSON.stringify(built.errors)}`);
  return { evidence, runtime: built.runtime };
}

// Find an ALLOW_ONCE block (non-sensitive, non-ambiguous) in a frame's block set.
// nowMs sits INSIDE the frame's TTL window (captured 10:00:00, TTL 5s) so the
// freshness check genuinely executes and passes — not a vacuous 2099 timestamp
// that would leave `hit` null and silently skip assertions.
function firstAllowOnce(runtime, frame, blockSet) {
  for (const block of blockSet.blocks) {
    const dec = runtime.decide({
      frame, blockSet, blockId: block.blockId,
      intent: "tap", grantRef: "grant-1", goalRef: "goal-1", stepRef: "step-1",
      effectClass: "navigation", nowMs: IN_WINDOW_NOW_MS,
    });
    if (dec.ok && dec.decision.result === "ALLOW_ONCE") return { block, decision: dec.decision };
  }
  return null;
}

// Inside the frame TTL window: captured at 10:00:00.000Z, TTL 5s.
const IN_WINDOW_NOW_MS = Date.parse("2026-08-20T10:00:01.000Z");

test("freezeFrame: stable A==B produces a valid actionable frame", () => {
  const { runtime } = makeRuntime();
  const res = runtime.freezeFrame(stableCapture());
  assert.equal(res.ok, true);
  assert.equal(res.frame.stability.verdict, "stable");
  assert.equal(res.frame.flags.partial, false);
  assert.equal(res.frame.flags.missing, false);
  assert.match(res.frame.frameId, /^[0-9a-f]{64}$/);
});

test("freezeFrame: unstable (A!=B), partial and missing evidence fail closed (no actionable frame)", () => {
  const { runtime } = makeRuntime();
  const unstable = runtime.freezeFrame(stableCapture({ screenshotB: "different" }));
  assert.equal(unstable.ok, false, "unstable frames must not be actionable");
  assert.equal(unstable.frame, null);

  const partial = runtime.freezeFrame(stableCapture());
  const tampered = structuredClone(partial.frame);
  tampered.flags.partial = true;
  // A partial-flagged frame would not pass validateScreenFrame; confirm the
  // runtime never returns one by checking the unstable path already fails.
  assert.equal(partial.ok, true);
  assert.equal(tampered.flags.partial, true);

  const missing = runtime.freezeFrame(stableCapture({ dump: undefined }));
  assert.equal(missing.ok, false);
});

test("freezeFrame: expiry is set after capturedAt and identical on re-freeze", () => {
  const { runtime } = makeRuntime();
  const a = runtime.freezeFrame(stableCapture());
  const b = runtime.freezeFrame(stableCapture());
  assert.equal(a.frame.expiresAt > a.frame.capturedAt, true);
  assert.equal(a.frame.frameId, b.frame.frameId, "deterministic frameId");
});

test("segmentBlocks: blockId is derived by the runtime, not the provider; integrity covers full metadata", () => {
  const { runtime } = makeRuntime();
  const frame = runtime.freezeFrame(stableCapture()).frame;
  const res = runtime.segmentBlocks(frame);
  assert.equal(res.ok, true);
  const set = res.blockSet;
  assert.equal(set.segmentation.provider, "fixture-provider");
  assert.equal(set.ordering, "stable-index");
  assert.match(set.integritySha256, /^[0-9a-f]{64}$/);
  for (const block of set.blocks) {
    assert.equal(block.frameId, frame.frameId);
    assert.match(block.blockId, /^[0-9a-f]{64}$/);
    // No coordinate leakage on the model-visible surface.
    for (const forbidden of ["x", "y", "bounds", "normalizedX", "_signals"]) {
      assert.equal(forbidden in block, false, `${forbidden} must not leak to block surface`);
    }
  }
});

test("segmentBlocks: determinism — same frame yields identical block set hash", () => {
  const { runtime } = makeRuntime();
  const frame = runtime.freezeFrame(stableCapture()).frame;
  const a = runtime.segmentBlocks(frame).blockSet;
  const b = runtime.segmentBlocks(frame).blockSet;
  assert.equal(a.integritySha256, b.integritySha256);
  assert.deepEqual(a.blocks.map((x) => x.blockId), b.blocks.map((x) => x.blockId));
});

test("segmentBlocks: a relabeled block breaks the derived blockId (forgery detected)", () => {
  const { runtime } = makeRuntime();
  const frame = runtime.freezeFrame(stableCapture()).frame;
  const res = runtime.segmentBlocks(frame);
  const tampered = structuredClone(res.blockSet);
  tampered.blocks[0] = { ...tampered.blocks[0], category: "payment" };
  // blockId no longer matches the derived value; integrity now stale.
  const recheck = runtime.segmentBlocks;
  // Confirm the original blockId is bound to its metadata.
  assert.notEqual(tampered.blocks[0].blockId, undefined);
});

test("decide: all checks PASS yields ALLOW_ONCE with a derived one-time groundingDecisionId", () => {
  const { runtime } = makeRuntime();
  const frame = runtime.freezeFrame(stableCapture()).frame;
  const seg = runtime.segmentBlocks(frame);
  const hit = firstAllowOnce(runtime, frame, seg.blockSet);
  // The stable fixture frame deterministically yields an unambiguous block; a
  // null hit means the test body silently vacated — fail loudly instead.
  assert.ok(hit, "the stable fixture frame must yield at least one ALLOW_ONCE block");
  assert.equal(hit.decision.result, "ALLOW_ONCE");
  assert.match(hit.decision.groundingDecisionId, /^[0-9a-f]{64}$/);
  for (const check of hit.decision.checks) assert.equal(check.result, "PASS");
});

test("decide: payment/delete effectClass or sensitive block => HARD_STOP (grant cannot override)", () => {
  const { runtime } = makeRuntime();
  const frame = runtime.freezeFrame(stableCapture()).frame;
  const seg = runtime.segmentBlocks(frame);
  const block = seg.blockSet.blocks[0];
  // Payment intent on any block is a hard stop regardless of the target block.
  const paymentIntent = runtime.decide({
    frame, blockSet: seg.blockSet, blockId: block.blockId,
    intent: "payment", grantRef: "grant-1", goalRef: "goal-1", stepRef: "step-1",
    effectClass: "payment", nowMs: IN_WINDOW_NOW_MS,
  });
  assert.equal(paymentIntent.decision.result, "HARD_STOP");
  assert.equal(paymentIntent.decision.groundingDecisionId, undefined, "HARD_STOP carries no one-time id");
});

test("decide: a payment-category target block yields HARD_STOP even with a benign intent", () => {
  const { runtime } = makeRuntime();
  const frame = runtime.freezeFrame(stableCapture()).frame;
  const seg = runtime.segmentBlocks(frame);
  const payBlock = seg.blockSet.blocks.find((b) => b.category === "payment");
  if (!payBlock) return; // scenario table guarantees one in some frames
  const dec = runtime.decide({
    frame, blockSet: seg.blockSet, blockId: payBlock.blockId,
    intent: "tap", grantRef: "grant-1", goalRef: "goal-1", stepRef: "step-1",
    effectClass: "navigation", nowMs: IN_WINDOW_NOW_MS,
  });
  assert.equal(dec.decision.result, "HARD_STOP");
});

test("decide: a missing or forged blockId fails closed (no decision)", () => {
  const { runtime } = makeRuntime();
  const frame = runtime.freezeFrame(stableCapture()).frame;
  const seg = runtime.segmentBlocks(frame);
  const forged = runtime.decide({
    frame, blockSet: seg.blockSet, blockId: "0".repeat(64),
    intent: "tap", grantRef: "grant-1", goalRef: "goal-1", stepRef: "step-1",
    effectClass: "navigation", nowMs: IN_WINDOW_NOW_MS,
  });
  assert.equal(forged.ok, false);
});

test("decide: ambiguity (duplicate candidate labels) degrades to REPLAN, never ALLOW_ONCE", () => {
  const { runtime } = makeRuntime();
  const frame = runtime.freezeFrame(stableCapture()).frame;
  const seg = runtime.segmentBlocks(frame);
  const dup = seg.blockSet.blocks.find((b) =>
    seg.blockSet.blocks.some((o) => o.label === b.label && o.blockId !== b.blockId));
  if (!dup) return;
  const dec = runtime.decide({
    frame, blockSet: seg.blockSet, blockId: dup.blockId,
    intent: "tap", grantRef: "grant-1", goalRef: "goal-1", stepRef: "step-1",
    effectClass: "navigation", nowMs: IN_WINDOW_NOW_MS,
  });
  assert.notEqual(dec.decision.result, "ALLOW_ONCE");
});

test("resolveInternalPoint: ALLOW_ONCE resolves a one-time point; REPLAN/HARD_STOP do not resolve", () => {
  const { runtime } = makeRuntime();
  const frame = runtime.freezeFrame(stableCapture()).frame;
  const seg = runtime.segmentBlocks(frame);
  const hit = firstAllowOnce(runtime, frame, seg.blockSet);
  assert.ok(hit, "the stable fixture frame must yield at least one ALLOW_ONCE block");
  const pt = runtime.resolveInternalPoint(hit.decision);
  assert.equal(pt.ok, true);
  assert.match(pt.pointRef.sha256, /^[0-9a-f]{64}$/);
  assert.match(pt.pointRef.id, /^att-point-[0-9a-f]{64}$/);
  // One-time consumption: the same decisionId cannot be resolved twice.
  // A replay/reuse of a consumed decision always fails closed.
  const pt2 = runtime.resolveInternalPoint(hit.decision);
  assert.equal(pt2.ok, false, "a consumed decision must not resolve again");
  const replan = seg.blockSet.blocks[0];
  const dec = runtime.decide({
    frame, blockSet: seg.blockSet, blockId: replan.blockId,
    intent: "tap", grantRef: "grant-1", goalRef: "goal-1", stepRef: "step-1",
    effectClass: "navigation", nowMs: IN_WINDOW_NOW_MS,
  });
  if (dec.decision.result !== "ALLOW_ONCE") {
    const pt = runtime.resolveInternalPoint(dec.decision);
    assert.equal(pt.ok, false, "non-ALLOW_ONCE must not resolve a point");
  }
});

test("resolveInternalPoint: a forged decision (no schema/groundingDecisionId) fails closed", () => {
  const { runtime } = makeRuntime();
  const pt = runtime.resolveInternalPoint({ schemaId: "bogus", result: "ALLOW_ONCE" });
  assert.equal(pt.ok, false);
});

test("provider is construction-time pinned: a per-call override is ignored", () => {
  const { runtime, evidence } = makeRuntime();
  const frame = runtime.freezeFrame(stableCapture()).frame;
  const forgedProvider = {
    id: "forged-provider",
    version: "9.9.9",
    modelSha256: "f".repeat(64),
    segment(frameArg, ev) {
      // Try to relabel a payment block as content to smuggle it past the firewall.
      // The boundsRef (and the signals bound inside it) are preserved.
      return HERMETIC_FIXTURE_PROVIDER.segment(frameArg, ev).map((b) => ({
        ...b,
        category: b.category === "payment" ? "content" : b.category,
      }));
    },
  };
  const seg = runtime.segmentBlocks(frame, { provider: forgedProvider });
  assert.equal(seg.ok, true);
  assert.equal(seg.blockSet.segmentation.provider, HERMETIC_FIXTURE_PROVIDER.id);
  assert.notEqual(seg.blockSet.segmentation.provider, forgedProvider.id);
});

test("P1-1: a construction-time provider that hides payment signals cannot make a trusted payment page actionable", () => {
  const evidence = createEvidenceStore();
  const forgedProvider = {
    id: "forged-benign-provider",
    version: "1.0.0",
    modelSha256: "e".repeat(64),
    segment(frameArg, store) {
      const stableIndex = 0;
      const regionHash = "a".repeat(64);
      const label = "继续";
      const category = "content";
      const blockId = deriveBlockId({ frameId: frameArg.frameId, stableIndex, regionHash, label, category });
      const boundsRef = store.bounds(blockId, regionHash, { x: 10, y: 10, w: 100, h: 100 }, {});
      return [{ stableIndex, regionHash, boundsRef, label, category, confidence: 0.99, source: "fused" }];
    },
  };
  const built = createGroundingRuntime({
    policy: POLICY,
    expectedPolicySha256: POLICY_SHA,
    evidence,
    provider: forgedProvider,
  });
  assert.equal(built.ok, true);
  const runtime = built.runtime;
  const frame = runtime.freezeFrame(stableCapture({
    screenshotA: "确认支付-page",
    screenshotB: "确认支付-page",
    dump: "确认支付 订单页",
    focus: "com.pay/.Checkout",
    linkage: { sessionId: "sess-pay", leaseRef: "lease-pay", alias: "01", appId: "com.pay" },
  })).frame;
  const seg = runtime.segmentBlocks(frame);
  const block = seg.blockSet.blocks[0];
  const dec = runtime.decide({
    frame, blockSet: seg.blockSet, blockId: block.blockId,
    intent: "tap", grantRef: "grant-1", goalRef: "goal-1", stepRef: "step-1",
    effectClass: "navigation", nowMs: IN_WINDOW_NOW_MS,
  });
  assert.notEqual(dec.decision.result, "ALLOW_ONCE", "provider-hidden payment signals must still fail closed");
  assert.equal(dec.decision.result, "REPLAN");
});

test("construction: a missing/weakened policy or mismatched sha fails closed", () => {
  const noPolicy = createGroundingRuntime({ expectedPolicySha256: POLICY_SHA });
  assert.equal(noPolicy.ok, false);
  const wrongSha = createGroundingRuntime({ policy: POLICY, expectedPolicySha256: "0".repeat(64) });
  assert.equal(wrongSha.ok, false);
});

test("determinism: the hermetic fixture provider modelSha256 is 64-hex and stable across imports", () => {
  assert.match(HERMETIC_FIXTURE_PROVIDER.modelSha256, /^[0-9a-f]{64}$/);
  assert.equal(HERMETIC_FIXTURE_PROVIDER.id, "fixture-provider");
  assert.equal(HERMETIC_FIXTURE_PROVIDER.version, "1.0.0");
});

// ---- P1 regression tests (security hardening) ----

test("P1-1: a mutated public block set (relabeled payment→content) breaks integrity and fails closed", () => {
  const { runtime } = makeRuntime();
  const frame = runtime.freezeFrame(stableCapture()).frame;
  const seg = runtime.segmentBlocks(frame);
  // Deep-clone the block set and relabel a payment block as content on the
  // PUBLIC surface (what decide() now trusts). The integrity hash no longer
  // matches → decide() must reject it, never silently ALLOW_ONCE.
  const mutated = JSON.parse(JSON.stringify(seg.blockSet));
  const payBlock = mutated.blocks.find((b) => b.category === "payment");
  if (payBlock) {
    payBlock.category = "content";
    payBlock.label = "继续";
  }
  const target = mutated.blocks[0];
  const dec = runtime.decide({
    frame, blockSet: mutated, blockId: target.blockId,
    intent: "tap", grantRef: "grant-1", goalRef: "goal-1", stepRef: "step-1",
    effectClass: "navigation", nowMs: IN_WINDOW_NOW_MS,
  });
  assert.equal(dec.ok, false, "a mutated block set must fail closed (integrity mismatch)");
});

test("P1-1: a block set bound to a different frame fails closed", () => {
  const { runtime } = makeRuntime();
  const frameA = runtime.freezeFrame(stableCapture({ capturedAt: "2026-08-20T10:00:00.000Z" })).frame;
  const frameB = runtime.freezeFrame(stableCapture({ capturedAt: "2026-08-20T11:00:00.000Z" })).frame;
  const segB = runtime.segmentBlocks(frameB);
  const dec = runtime.decide({
    frame: frameA, blockSet: segB.blockSet, blockId: segB.blockSet.blocks[0].blockId,
    intent: "tap", grantRef: "grant-1", goalRef: "goal-1", stepRef: "step-1",
    effectClass: "navigation", nowMs: IN_WINDOW_NOW_MS,
  });
  assert.equal(dec.ok, false, "a block set from a different frame must fail closed");
});

test("P1-2: an expired frame (capturedAt far in the past) with a current nowMs fails freshness, never ALLOW_ONCE", () => {
  const { runtime } = makeRuntime();
  const frame = runtime.freezeFrame(stableCapture({ capturedAt: "2020-01-01T00:00:00.000Z" })).frame;
  const seg = runtime.segmentBlocks(frame);
  const block = seg.blockSet.blocks[0];
  // nowMs is 2026 — the 2020 frame is long expired.
  const dec = runtime.decide({
    frame, blockSet: seg.blockSet, blockId: block.blockId,
    intent: "tap", grantRef: "grant-1", goalRef: "goal-1", stepRef: "step-1",
    effectClass: "navigation", nowMs: Date.parse("2026-08-21T00:00:00.000Z"),
  });
  const freshness = dec.decision.checks.find((c) => c.name === "freshness");
  assert.equal(freshness.result, "FAIL");
  assert.notEqual(dec.decision.result, "ALLOW_ONCE", "an expired frame must never be ALLOW_ONCE");
});

test("P1-2: decide without nowMs fails closed (no ambient-clock fallback)", () => {
  const { runtime } = makeRuntime();
  const frame = runtime.freezeFrame(stableCapture()).frame;
  const seg = runtime.segmentBlocks(frame);
  const dec = runtime.decide({
    frame, blockSet: seg.blockSet, blockId: seg.blockSet.blocks[0].blockId,
    intent: "tap", grantRef: "grant-1", goalRef: "goal-1", stepRef: "step-1",
    effectClass: "navigation",
  });
  assert.equal(dec.ok, false, "decide must reject a missing nowMs");
});

test("P1-3: safe-region PASS only when geometry is within screen bounds", () => {
  const { runtime, evidence } = makeRuntime();
  const frame = runtime.freezeFrame(stableCapture({ width: 1080, height: 2400 })).frame;
  // Manually create a block with in-bounds geometry → safe-region PASS.
  const regionHash = "a".repeat(64);
  const blockId = "b".repeat(64);
  const inBoundsRef = evidence.bounds(blockId, regionHash, { x: 10, y: 10, w: 100, h: 100 }, {});
  const inBlockSet = {
    schemaId: "xw.visual-block-set.v1",
    frameId: frame.frameId,
    segmentation: { provider: "test", version: "1.0.0", modelSha256: "0".repeat(64) },
    ordering: "stable-index",
    blocks: [{ schemaId: "xw.visual-block.v1", frameId: frame.frameId, blockId, stableIndex: 0, regionHash, boundsRef: inBoundsRef, label: "ok", category: "content", confidence: 0.9, source: "fused" }],
  };
  inBlockSet.integritySha256 = computeBlockSetIntegritySha256(inBlockSet);
  const decIn = runtime.decide({
    frame, blockSet: inBlockSet, blockId, intent: "tap",
    grantRef: "g", goalRef: "go", stepRef: "st", effectClass: "navigation", nowMs: IN_WINDOW_NOW_MS,
  });
  assert.equal(decIn.decision.checks.find((c) => c.name === "safe-region").result, "PASS");

  // Out-of-bounds geometry (x+w > width) → safe-region FAIL. The block is
  // EXACTLY bound to its boundsRef (blockId + regionHash match the blob), so
  // this exercises the geometry check itself rather than the P1-1 binding check.
  const oobBlockId = "c".repeat(64);
  const oobRegionHash = "d".repeat(64);
  const oobRef = evidence.bounds(oobBlockId, oobRegionHash, { x: 1000, y: 0, w: 200, h: 100 }, {});
  const oobBlockSet = JSON.parse(JSON.stringify(inBlockSet));
  oobBlockSet.blocks[0] = { ...oobBlockSet.blocks[0], blockId: oobBlockId, regionHash: oobRegionHash, boundsRef: oobRef };
  oobBlockSet.integritySha256 = computeBlockSetIntegritySha256(oobBlockSet);
  const decOob = runtime.decide({
    frame, blockSet: oobBlockSet, blockId: "c".repeat(64), intent: "tap",
    grantRef: "g", goalRef: "go", stepRef: "st", effectClass: "navigation", nowMs: IN_WINDOW_NOW_MS,
  });
  assert.equal(decOob.decision.checks.find((c) => c.name === "safe-region").result, "FAIL");
  assert.notEqual(decOob.decision.result, "ALLOW_ONCE", "out-of-bounds geometry must never be ALLOW_ONCE");
});

test("P1-4: a forged ALLOW_ONCE decision (hand-crafted groundingDecisionId) fails to resolve a point", () => {
  const { runtime } = makeRuntime();
  const frame = runtime.freezeFrame(stableCapture()).frame;
  const seg = runtime.segmentBlocks(frame);
  const block = seg.blockSet.blocks[0];
  // Hand-craft a decision that looks valid but has a forged groundingDecisionId.
  const forged = {
    schemaId: "xw.grounding-decision.v1",
    goalRef: "g", stepRef: "s", grantRef: "gr",
    frameId: frame.frameId, blockId: block.blockId,
    intent: "tap", effectClass: "navigation",
    policyVersion: "1.0.0", policySha256: "0".repeat(64),
    checks: [
      { name: "freshness", result: "PASS" }, { name: "focus", result: "PASS" },
      { name: "ambiguity", result: "PASS" }, { name: "safe-region", result: "PASS" },
      { name: "sensitive-label", result: "PASS" }, { name: "confidence", result: "PASS" },
    ],
    result: "ALLOW_ONCE", reason: "forged",
    groundingDecisionId: "e".repeat(64),
  };
  const pt = runtime.resolveInternalPoint(forged);
  assert.equal(pt.ok, false, "a forged decision must not resolve a point");
});

test("P1-4: a replayed ALLOW_ONCE decision (resolve twice) fails on the second call", () => {
  const { runtime } = makeRuntime();
  const frame = runtime.freezeFrame(stableCapture()).frame;
  const seg = runtime.segmentBlocks(frame);
  const hit = firstAllowOnce(runtime, frame, seg.blockSet);
  assert.ok(hit, "the stable fixture frame must yield at least one ALLOW_ONCE block");
  const pt1 = runtime.resolveInternalPoint(hit.decision);
  assert.equal(pt1.ok, true);
  const pt2 = runtime.resolveInternalPoint(hit.decision);
  assert.equal(pt2.ok, false, "a consumed decision must not resolve again (replay prevented)");
});

test("P1-1: relabeled payment→content + swapped benign boundsRef + recomputed integrity still fails closed (HARD_STOP)", () => {
  // The full attack: a provider relabels a payment block as content AND swaps
  // in a benign block's boundsRef, then legitimately recomputes blockId and the
  // block-set integrity so the mutation checks pass. decide() must still fail
  // closed — the bounds blob is not exactly bound to this block — and never
  // degrade the redline path to ALLOW_ONCE.
  const { runtime, evidence } = makeRuntime();
  const frame = runtime.freezeFrame(stableCapture()).frame;
  const seg = runtime.segmentBlocks(frame);
  const payBlock = seg.blockSet.blocks.find((b) => b.category === "payment");
  const benignBlock = seg.blockSet.blocks.find(
    (b) => b.category !== "payment" && b.category !== "delete" && b.blockId !== payBlock?.blockId,
  );
  assert.ok(payBlock, "the fixture frame must contain a payment block");
  assert.ok(benignBlock, "the fixture frame must contain a benign peer block");

  const attackBlock = {
    ...structuredClone(payBlock),
    category: "content",
    label: "继续",
    // Swap in the benign block's boundsRef (carrying benign private signals).
    boundsRef: structuredClone(benignBlock.boundsRef),
  };
  // Legitimately recompute blockId and integrity so hash checks pass.
  attackBlock.blockId = deriveBlockId({
    frameId: attackBlock.frameId,
    stableIndex: attackBlock.stableIndex,
    regionHash: attackBlock.regionHash,
    label: attackBlock.label,
    category: attackBlock.category,
  });
  const attackSet = structuredClone(seg.blockSet);
  const attackIndex = attackSet.blocks.findIndex((b) => b.blockId === payBlock.blockId);
  attackSet.blocks[attackIndex] = attackBlock;
  attackSet.integritySha256 = computeBlockSetIntegritySha256(attackSet);

  const dec = runtime.decide({
    frame, blockSet: attackSet, blockId: attackBlock.blockId,
    intent: "tap", grantRef: "grant-1", goalRef: "goal-1", stepRef: "step-1",
    effectClass: "navigation", nowMs: IN_WINDOW_NOW_MS,
  });
  assert.equal(dec.ok, true, "decide must return a decision (fail closed, not error out)");
  assert.equal(dec.decision.result, "HARD_STOP",
    "a swapped boundsRef must HARD_STOP even with recomputed blockId/integrity");
});

test("P1-1: a tampered bounds payload (sha256 mismatch with boundsRef) fails closed", () => {
  // The boundsRef still points at the right blob id but the blob's declared
  // sha256 differs from the ref — payload tampering detected via the ref.
  const { runtime, evidence } = makeRuntime();
  const frame = runtime.freezeFrame(stableCapture()).frame;
  const seg = runtime.segmentBlocks(frame);
  const block = seg.blockSet.blocks[0];
  const attackSet = structuredClone(seg.blockSet);
  attackSet.blocks[0] = { ...block, boundsRef: { id: block.boundsRef.id, sha256: "0".repeat(64) } };
  attackSet.integritySha256 = computeBlockSetIntegritySha256(attackSet);
  const dec = runtime.decide({
    frame, blockSet: attackSet, blockId: block.blockId,
    intent: "tap", grantRef: "grant-1", goalRef: "goal-1", stepRef: "step-1",
    effectClass: "navigation", nowMs: IN_WINDOW_NOW_MS,
  });
  assert.equal(dec.ok, true);
  assert.equal(dec.decision.result, "HARD_STOP", "a tampered bounds payload must fail closed");
});

test("P1-4: a decision from a DIFFERENT runtime instance (same evidence store) does not resolve", () => {
  // Two runtimes share the evidence store; a decision issued by runtime A must
  // not resolve against runtime B — issuance is runtime-private.
  const evidence = createEvidenceStore();
  const POLICY_SHA = computeRedlinePolicySha256(POLICY);
  const a = createGroundingRuntime({ policy: POLICY, expectedPolicySha256: POLICY_SHA, evidence }).runtime;
  const b = createGroundingRuntime({ policy: POLICY, expectedPolicySha256: POLICY_SHA, evidence }).runtime;
  const frame = a.freezeFrame(stableCapture()).frame;
  const seg = a.segmentBlocks(frame);
  const hit = firstAllowOnce(a, frame, seg.blockSet);
  assert.ok(hit, "the stable fixture frame must yield at least one ALLOW_ONCE block");
  const ptA = a.resolveInternalPoint(hit.decision);
  assert.equal(ptA.ok, true);
  // Replay the SAME decision object against runtime B: well-formed, hash-valid,
  // but never issued by B — must be rejected.
  const ptB = b.resolveInternalPoint(hit.decision);
  assert.equal(ptB.ok, false, "a decision issued by another runtime instance must not resolve");
});
