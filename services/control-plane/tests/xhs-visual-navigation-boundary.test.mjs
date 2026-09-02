// VISION boundary test (executable-plan W3, contract VISION).
//
// Proves the real-vision provider adapter (real-vision-provider.mjs) plugs into
// the grounding runtime and that the runtime's safety policy still owns the
// decision surface — the provider can only supply block material; it cannot
// override blockId derivation, block-set integrity, the six grounding checks
// or the payment/delete hard-redline firewall. Three probes:
//
//   1. independent annotation oracle — an oracle re-derives each block's
//      regionHash + blockId from the raw annotation using the SAME contract
//      formulas (m6-contracts), proving the provider's mapping is deterministic
//      and conformant, with no coordinate leakage to the block surface.
//   2. block mutation — a mutated block set breaks integritySha256 and decide()
//      rejects it; a relabeled payment block is caught by both the integrity
//      check AND the redline firewall (defense in depth).
//   3. dump fallback ladder — empty/throwing loader => zero blocks (never a
//      fabricated navigation target); effect buttons => HARD_STOP; unique R0
//      navigation => ALLOW_ONCE; duplicate => REPLAN; and the live guard
//      rejects HERMETIC_FIXTURE_PROVIDER so the fallback is STOP, not fixture.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  computeRedlinePolicySha256,
  computeBlockSetIntegritySha256,
  deriveBlockId,
  sha256Hex,
  stableStringify,
} from "../../orchestrator/scripts/lib/m6/m6-contracts.mjs";
import {
  HERMETIC_FIXTURE_PROVIDER,
  createEvidenceStore,
  createGroundingRuntime,
} from "../../orchestrator/scripts/lib/m6/m6-grounding-runtime.mjs";
import {
  REAL_VISION_PROVIDER_ID,
  FIXTURE_MODEL_SHA256,
  assertLiveGroundingProvider,
  classifyCategory,
  createRealVisionProvider,
} from "../../orchestrator/scripts/lib/m6/real-vision-provider.mjs";

const FIXTURES = path.resolve(import.meta.dirname, "../../orchestrator/tests/fixtures/m6");
const POLICY = JSON.parse(readFileSync(path.join(FIXTURES, "hard-redline-policy.valid.json"), "utf8"));
const POLICY_SHA = computeRedlinePolicySha256(POLICY);

// Inside the frame TTL window: captured 10:00:00.000Z, TTL 5s -> expires 10:00:05.
const IN_WINDOW_NOW_MS = Date.parse("2026-08-20T10:00:01.000Z");

function stableCapture(overrides = {}) {
  return {
    screenshotA: "stable-frame-a",
    screenshotB: "stable-frame-a",
    dump: "dump-content",
    focus: "focus-content",
    capturedAt: "2026-08-20T10:00:00.000Z",
    linkage: { sessionId: "sess-01", leaseRef: "lease-01", alias: "04", appId: "com.xingin.xhs" },
    width: 1080,
    height: 2400,
    density: 3,
    ...overrides,
  };
}

/** Build a runtime pinned to a real-vision provider whose loader returns `annos`. */
function makeRealRuntime(annos, opts = {}) {
  const evidence = createEvidenceStore();
  let loader;
  if (opts.throwOnLoad) {
    loader = () => { throw new Error("analyze.py unavailable"); };
  } else if (opts.nullOnLoad) {
    loader = () => null;
  } else {
    loader = () => (Array.isArray(annos) ? annos : []);
  }
  const provider = createRealVisionProvider({ loader, modelSha256: FIXTURE_MODEL_SHA256 });
  const built = createGroundingRuntime({ provider, policy: POLICY, expectedPolicySha256: POLICY_SHA, evidence });
  assert.equal(built.ok, true, `runtime must construct with real provider: ${JSON.stringify(built.errors)}`);
  return { evidence, runtime: built.runtime, provider };
}

function annotate(label, bounds, extra = {}) {
  return { label, bounds, conf: 0.95, source: "a11y", ...extra };
}

// ---------------------------------------------------------------------------
// Probe 1 — independent annotation oracle
// ---------------------------------------------------------------------------

test("VISION probe 1: independent oracle re-derives regionHash + blockId; no coordinate leakage", () => {
  const annos = [
    annotate("返回", { x: 100, y: 100, w: 360, h: 120 }),
    annotate("首页", { x: 200, y: 2200, w: 200, h: 120 }),
    annotate("搜索", { x: 500, y: 60, w: 400, h: 120 }),
  ];
  const { runtime } = makeRealRuntime(annos);
  const frame = runtime.freezeFrame(stableCapture()).frame;
  const res = runtime.segmentBlocks(frame);
  assert.equal(res.ok, true);
  const set = res.blockSet;

  // The block set carries the REAL provider identity, not the fixture provider.
  assert.equal(set.segmentation.provider, REAL_VISION_PROVIDER_ID);
  assert.equal(set.segmentation.modelSha256, FIXTURE_MODEL_SHA256);
  assert.notEqual(set.segmentation.provider, HERMETIC_FIXTURE_PROVIDER.id);

  // Independent oracle: re-derive regionHash + blockId from the raw annotation
  // using the same contract formulas the provider used, and compare. This proves
  // the mapping is deterministic and conformant (not a second source of truth).
  assert.equal(set.blocks.length, annos.length);
  for (let i = 0; i < annos.length; i += 1) {
    const ann = annos[i];
    const category = classifyCategory(ann.label);
    const regionHash = sha256Hex(`xw.region.rv:${stableStringify({
      frameId: frame.frameId, stableIndex: i, label: ann.label, category, bounds: ann.bounds,
    })}`);
    const blockId = deriveBlockId({ frameId: frame.frameId, stableIndex: i, regionHash, label: ann.label, category });
    const block = set.blocks[i];
    assert.equal(block.regionHash, regionHash, `oracle regionHash mismatch @${i}`);
    assert.equal(block.blockId, blockId, `oracle blockId mismatch @${i}`);
    assert.equal(block.label, ann.label);
    assert.equal(block.category, category);
    // No coordinate leakage on the model-visible surface.
    for (const forbidden of ["x", "y", "bounds", "normalizedX", "_signals", "geometry"]) {
      assert.equal(forbidden in block, false, `${forbidden} must not leak to block surface`);
    }
  }

  // Determinism: re-segmenting the same frame yields an identical block set hash.
  const again = runtime.segmentBlocks(frame).blockSet;
  assert.equal(again.integritySha256, set.integritySha256);
});

// ---------------------------------------------------------------------------
// Probe 2 — block mutation / relabel is caught by integrity + redline
// ---------------------------------------------------------------------------

test("VISION probe 2: mutated block set breaks integritySha256 -> decide rejects; relabel caught by redline", () => {
  const annos = [annotate("返回", { x: 100, y: 100, w: 360, h: 120 })];
  const { runtime } = makeRealRuntime(annos);
  const frame = runtime.freezeFrame(stableCapture()).frame;
  const set = runtime.segmentBlocks(frame).blockSet;
  const block = set.blocks[0];

  // (a) Mutating the block surface (category -> payment) changes the integrity
  // hash. decide() recomputes integrity on every call and rejects the mismatch.
  const tampered = structuredClone(set);
  tampered.blocks[0] = { ...tampered.blocks[0], category: "payment" };
  const dec = runtime.decide({
    frame, blockSet: tampered, blockId: block.blockId,
    intent: "tap", grantRef: "g", goalRef: "g", stepRef: "s",
    effectClass: "navigation", nowMs: IN_WINDOW_NOW_MS,
  });
  assert.equal(dec.ok, false, "mutated block set must be rejected (integrity mismatch)");

  // (b) A legitimately-issued payment block (provider correctly classifies a
  // payment button) is caught by the sensitive-label check AND the redline
  // firewall — HARD_STOP regardless of effectClass. This is "效果按钮一律 stop".
  const payAnnos = [annotate("确认支付", { x: 100, y: 100, w: 360, h: 120 }, { conf: 0.99 })];
  const { runtime: rt2 } = makeRealRuntime(payAnnos);
  const f2 = rt2.freezeFrame(stableCapture()).frame;
  const s2 = rt2.segmentBlocks(f2).blockSet;
  assert.equal(s2.blocks[0].category, "payment", "classifier must label 确认支付 as payment");
  const payDec = rt2.decide({
    frame: f2, blockSet: s2, blockId: s2.blocks[0].blockId,
    intent: "tap", grantRef: "g", goalRef: "g", stepRef: "s",
    effectClass: "navigation", nowMs: IN_WINDOW_NOW_MS,
  });
  assert.equal(payDec.ok, true);
  assert.equal(payDec.decision.result, "HARD_STOP", "payment button -> HARD_STOP");
});

// ---------------------------------------------------------------------------
// Probe 3 — dump fallback ladder: empty/throwing loader, uniqueness, live guard
// ---------------------------------------------------------------------------

test("VISION probe 3a: empty/throwing/null loader fails closed (no block set -> no decide -> no blind tap)", () => {
  // The block-set schema requires minItems:1, so an empty annotation makes
  // segmentBlocks fail closed: the runtime refuses to produce a block set at
  // all. The workflow CANNOT reach decide() — there is no navigation target
  // to tap. This is the dump fallback ladder: vision unavailable -> STOP, never
  // a fabricated target and never a silent fallback to the fixture provider.
  for (const opts of [{}, { throwOnLoad: true }, { nullOnLoad: true }]) {
    const { runtime } = makeRealRuntime([], opts);
    const frame = runtime.freezeFrame(stableCapture()).frame;
    const res = runtime.segmentBlocks(frame);
    assert.equal(res.ok, false, `loader ${JSON.stringify(opts)} -> segmentBlocks must fail closed`);
    assert.equal(res.blockSet, null, "no block set produced from empty annotation");
  }
});

test("VISION probe 3b: unique R0 navigation -> ALLOW_ONCE; duplicate label -> REPLAN", () => {
  // Unique navigation block: one "返回" with valid in-bounds geometry + conf.
  const unique = [annotate("返回", { x: 100, y: 100, w: 360, h: 120 })];
  const { runtime: rt1 } = makeRealRuntime(unique);
  const f1 = rt1.freezeFrame(stableCapture()).frame;
  const s1 = rt1.segmentBlocks(f1).blockSet;
  const d1 = rt1.decide({
    frame: f1, blockSet: s1, blockId: s1.blocks[0].blockId,
    intent: "tap", grantRef: "g", goalRef: "g", stepRef: "s",
    effectClass: "navigation", nowMs: IN_WINDOW_NOW_MS,
  });
  assert.equal(d1.ok, true);
  assert.equal(d1.decision.result, "ALLOW_ONCE", "unique R0 navigation -> ALLOW_ONCE");

  // Duplicate labels: two "返回" blocks -> ambiguity FAIL -> REPLAN.
  const dup = [
    annotate("返回", { x: 100, y: 100, w: 360, h: 120 }),
    annotate("返回", { x: 100, y: 2200, w: 360, h: 120 }),
  ];
  const { runtime: rt2 } = makeRealRuntime(dup);
  const f2 = rt2.freezeFrame(stableCapture()).frame;
  const s2 = rt2.segmentBlocks(f2).blockSet;
  // Deciding EITHER duplicate block degrades on ambiguity -> REPLAN.
  for (const b of s2.blocks) {
    const d = rt2.decide({
      frame: f2, blockSet: s2, blockId: b.blockId,
      intent: "tap", grantRef: "g", goalRef: "g", stepRef: "s",
      effectClass: "navigation", nowMs: IN_WINDOW_NOW_MS,
    });
    assert.equal(d.ok, true);
    assert.equal(d.decision.result, "REPLAN", "duplicate navigation label -> REPLAN (不唯一 stop)");
  }
});

test("VISION probe 3c: live guard rejects HERMETIC_FIXTURE_PROVIDER; accepts a real provider", () => {
  assert.throws(
    () => assertLiveGroundingProvider(HERMETIC_FIXTURE_PROVIDER),
    /LIVE_GROUNDING_REJECTS_HERMETIC/,
    "live path must fail closed on the hermetic fixture provider",
  );
  const provider = createRealVisionProvider({ loader: () => [], modelSha256: FIXTURE_MODEL_SHA256 });
  assert.equal(assertLiveGroundingProvider(provider), true, "real provider accepted by the live guard");

  // A provider with a non-64-hex modelSha256 is rejected by both the constructor
  // and the live guard (defense in depth).
  assert.throws(
    () => createRealVisionProvider({ loader: () => [], modelSha256: "not-a-hash" }),
    /REAL_VISION_PROVIDER_MODEL_SHA256_REQUIRED/,
  );
  assert.throws(
    () => assertLiveGroundingProvider({ id: "x", version: "1", modelSha256: "short", segment: () => [] }),
    /LIVE_GROUNDING_REQUIRES_PINNED_MODEL/,
  );
});

test("VISION probe 3d: resolveInternalPoint yields a one-time point for an ALLOW_ONCE R0 navigation", () => {
  const annos = [annotate("搜索", { x: 500, y: 60, w: 400, h: 120 })];
  const { runtime } = makeRealRuntime(annos);
  const frame = runtime.freezeFrame(stableCapture()).frame;
  const set = runtime.segmentBlocks(frame).blockSet;
  const dec = runtime.decide({
    frame, blockSet: set, blockId: set.blocks[0].blockId,
    intent: "tap", grantRef: "g", goalRef: "g", stepRef: "s",
    effectClass: "navigation", nowMs: IN_WINDOW_NOW_MS,
  });
  assert.equal(dec.decision.result, "ALLOW_ONCE");
  const pt = runtime.resolveInternalPoint(dec.decision);
  assert.equal(pt.ok, true);
  assert.ok(pt.pointRef, "one-time point resolved for the unique navigation block");
  // Replay: the one-time decision cannot resolve again.
  const replay = runtime.resolveInternalPoint(dec.decision);
  assert.equal(replay.ok, false, "ALLOW_ONCE decision is one-time (replay rejected)");
});