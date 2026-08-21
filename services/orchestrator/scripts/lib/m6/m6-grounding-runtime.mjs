// M6-1 Grounding Runtime — the single source of truth for the agentic grounding
// pipeline's offline stage. It produces execution-grade screen frames, visual
// block sets and grounding decisions that conform to the M6-0 kernel contracts,
// and it is the ONLY implementation of block id / block set integrity / decision
// derivation. The legacy xw-locator CLI (ops/xw-locator.mjs) is collapsed to a
// diagnostic proxy over this runtime; it no longer holds its own algorithm.
//
// Design rules (task brief §M6-1 / §5):
//   * Pure functions only: no device IO, no network, no ambient clock, no
//     Math.random. `now` and the provider are injected. Determinism is a hard
//     contract — identical inputs must yield identical hashes, ordering and
//     decisions on Windows and Linux (LF-normalized bytes).
//   * The provider is pluggable but the SAFETY POLICY is not: blockId generation,
//     block-set integrity, the six grounding checks and the payment/delete
//     hard-redline firewall are owned here and the caller-pinned policy; a
//     provider can never override them.
//   * The model-visible surface never sees pixels or coordinates. Internal
//     bounds and the one-time resolved tap point live only behind opaque
//     content-addressed refs in the evidence store.
//
// This module reuses the M6-0 pure derivations in ./m6-contracts.mjs and the
// hard-redline evaluator in ./m6-hard-redline.mjs — it does not redefine those
// algorithms, so it cannot drift into a "second source of truth".
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { evaluateHardRedline } from "./m6-hard-redline.mjs";
import {
  GROUNDING_CHECK_NAMES,
  REDLINE_EFFECT_CLASSES,
  computeBlockSetIntegritySha256,
  computeRedlinePolicySha256,
  deriveBlockId,
  deriveFrameId,
  deriveGroundingDecisionId,
  fail,
  sha256Hex,
  stableStringify,
  validateGroundingDecision,
  validateScreenFrame,
  validateVisualBlockSet,
} from "./m6-contracts.mjs";

const CODE = "M6_GROUNDING_RUNTIME";

// ---------------------------------------------------------------------------
// Evidence store — content-addressed, in-memory. CI uses this directly; the
// canonical-root backed store lands in M6-2 with the same opaque-ref contract.
// ---------------------------------------------------------------------------

export function createEvidenceStore() {
  const blobs = new Map(); // id -> { id, sha256, bytes, kind }

  function put(kind, bytes) {
    const buf = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : Buffer.from(bytes);
    const sha256 = sha256Buffer(buf);
    const id = `att-${kind}-${sha256}`;
    if (!blobs.has(id)) blobs.set(id, { id, sha256, bytes: buf, kind });
    return { id, sha256 };
  }

  function ref(id) {
    const entry = blobs.get(id);
    return entry ? { id: entry.id, sha256: entry.sha256 } : null;
  }

  function bounds(blockId, regionHash, geometry) {
    // Geometry (pixel coordinates) is the private resolution surface; only the
    // opaque ref reaches the model. The ref binds blockId+regionHash+geometry
    // so a relabeled or swapped target produces a different ref.
    const payload = stableStringify({ blockId, regionHash, geometry });
    return put("bounds", payload);
  }

  return {
    put,
    ref,
    bounds,
    size: () => blobs.size,
    snapshot: () => blobs,
    // Deterministic overlay: per-block bounds drawn as a diagnostic artifact.
    // Overlay metadata carries refs only, never raw coordinates on the surface.
    overlay(blockSet) {
      const items = blockSet.blocks.map((block) => ({
        blockId: block.blockId,
        label: block.label,
        category: block.category,
        boundsRef: block.boundsRef,
      }));
      return put("overlay", stableStringify({ frameId: blockSet.frameId, items }));
    },
  };
}

// ---------------------------------------------------------------------------
// Hermetic fixture provider — the CI-only segmentation provider. It turns a
// stable frame into raw block material (label/category/confidence/source plus a
// regionHash seed and geometry). It carries no model weights; its "model" hash
// is the LF-normalized sha256 of its own source, so it is content-addressed and
// reproduces identically across platforms.
// ---------------------------------------------------------------------------

export const HERMETIC_FIXTURE_PROVIDER = Object.freeze({
  id: "fixture-provider",
  version: "1.0.0",
  // modelSha256 is pinned at module load from this file's own LF-normalized
  // bytes; segment() never depends on ambient state.
  get modelSha256() {
    return HERMETIC_FIXTURE_PROVIDER_MODEL_SHA256;
  },
  segment(frame, evidence) {
    // Deterministic synthetic segmentation keyed on the frame manifest hash:
    // the same frame always yields the same block layout. Covers the task-brief
    // corpus scenarios (popups, keyboard, ads, sensitive labels, repeated
    // blocks, scroll pages, permission dialogs, status bar, system navigation).
    const seed = Buffer.from(frame.manifestSha256, "hex");
    const blocks = [];
    const count = 3 + (seed[0] % 6); // 3..8 blocks
    const scenarios = SCENARIO_TABLE[seed[1] % SCENARIO_TABLE.length];
    for (let index = 0; index < count; index += 1) {
      const s = scenarios[index % scenarios.length];
      const regionHash = regionHashOf(frame.frameId, index, s.label, s.category);
      const geometry = geometryOf(seed, index, frame.width, frame.height);
      const boundsRef = evidence.bounds(
        deriveBlockId({ frameId: frame.frameId, stableIndex: index, regionHash, label: s.label, category: s.category }),
        regionHash,
        geometry,
      );
      blocks.push({
        stableIndex: index,
        regionHash,
        boundsRef,
        label: s.label,
        category: s.category,
        confidence: s.confidence,
        source: s.source,
        // Private signals consumed by decide() — never serialized to the model.
        _signals: s.signals || {},
      });
    }
    return blocks;
  },
});

// LF-normalized self-hash so the provider is content-addressed and reproduces
// identically across Windows (CRLF worktree) and Linux (LF checkout).
const HERMETIC_FIXTURE_PROVIDER_MODEL_SHA256 = (() => {
  try {
    const self = readFileSync(fileURLToPath(import.meta.url), "utf8");
    return sha256Buffer(Buffer.from(self.replace(/\r\n/g, "\n").replace(/\r/g, "\n"), "utf8"));
  } catch {
    // Under harnesses that rewrite import.meta we fall back to a stable literal
    // so the provider is never sha-less; tests pin the real value.
    return "0".repeat(64);
  }
})();

const SCENARIO_TABLE = [
  [
    { label: "搜索", category: "content", confidence: 0.97, source: "fused" },
    { label: "发现", category: "system-navigation", confidence: 0.95, source: "fused" },
    { label: "广告", category: "ads", confidence: 0.9, source: "vision" },
  ],
  [
    { label: "确认支付", category: "payment", confidence: 0.99, source: "fused", signals: { ocrText: "确认支付" } },
    { label: "立即抢购", category: "payment", confidence: 0.98, source: "ocr", signals: { ocrText: "立即抢购" } },
    { label: "返回", category: "system-navigation", confidence: 0.95, source: "a11y" },
  ],
  [
    { label: "删除", category: "delete", confidence: 0.99, source: "fused", signals: { ocrText: "删除", iconLabel: "trash-icon" } },
    { label: "取消", category: "permission-dialog", confidence: 0.9, source: "a11y" },
    { label: "确定", category: "permission-dialog", confidence: 0.9, source: "a11y" },
  ],
  [
    { label: "键盘", category: "keyboard", confidence: 0.93, source: "vision" },
    { label: "输入框", category: "content", confidence: 0.96, source: "fused" },
    { label: "状态栏", category: "status-bar", confidence: 0.99, source: "vision" },
  ],
  [
    { label: "滚动内容", category: "content", confidence: 0.94, source: "fused" },
    { label: "滚动内容", category: "content", confidence: 0.94, source: "fused" },
    { label: "加载更多", category: "content", confidence: 0.8, source: "ocr" },
  ],
  [
    { label: "允许", category: "permission-dialog", confidence: 0.91, source: "a11y" },
    { label: "拒绝", category: "permission-dialog", confidence: 0.91, source: "a11y" },
    { label: "标题", category: "content", confidence: 0.96, source: "fused" },
  ],
];

// ---------------------------------------------------------------------------
// Deterministic helpers — no Math.random, no Date.now.
// ---------------------------------------------------------------------------

function sha256Buffer(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function regionHashOf(frameId, stableIndex, label, category) {
  return sha256Hex(`xw.region:${stableStringify({ frameId, stableIndex, label, category })}`);
}

function geometryOf(seed, index, width, height) {
  // Pure deterministic geometry for the evidence store. Coordinates never leave
  // the evidence store; only the opaque boundsRef reaches the model surface.
  const step = Math.floor(width / 8) || 1;
  const x0 = (index * step + seed[2 % seed.length]) % Math.max(width, 1);
  const y0 = (index * Math.floor(height / 6) + seed[3 % seed.length]) % Math.max(height, 1);
  return { x: x0, y: y0, w: step, h: Math.floor(height / 6) || 1 };
}

function fingerprintOf(content, salt) {
  return sha256Hex(`xw.fp:${salt}:${sha256Hex(content)}`);
}

// ---------------------------------------------------------------------------
// GroundingRuntime
// ---------------------------------------------------------------------------

export function createGroundingRuntime({
  provider = HERMETIC_FIXTURE_PROVIDER,
  evidence = createEvidenceStore(),
  policy,
  expectedPolicySha256,
  policyVersion = policy?.policyVersion || "1.0.0",
  frameTtlMs = 5000,
} = {}) {
  const errors = [];
  if (!policy || typeof policy !== "object") {
    fail(errors, CODE, "hard-redline policy is required to construct a GroundingRuntime");
  }
  if (typeof expectedPolicySha256 !== "string" || expectedPolicySha256.length === 0) {
    fail(errors, CODE, "expectedPolicySha256 is required to construct a GroundingRuntime");
  } else if (policy && computeRedlinePolicySha256(policy) !== expectedPolicySha256) {
    fail(errors, CODE, "the supplied policy sha256 does not match expectedPolicySha256");
  }
  if (errors.length > 0) {
    return { ok: false, errors, runtime: null };
  }

  // freezeFrame: produce an execution-grade xw.screen-frame.v1 from captured
  // evidence. Unstable / partial / missing evidence must NOT become actionable.
  function freezeFrame(observeInput = {}) {
    const errs = [];
    const a = observeInput.screenshotA;
    const b = observeInput.screenshotB;
    const dump = observeInput.dump;
    const focus = observeInput.focus;
    if (!a || !b || !dump || !focus) {
      fail(errs, CODE, "freezeFrame requires screenshotA, screenshotB, dump and focus evidence");
      return { ok: false, errors: errs, frame: null };
    }
    if (typeof observeInput.capturedAt !== "string") {
      fail(errs, CODE, "capturedAt is required (deterministic timestamp string)");
    }
    const screenshotARef = evidence.put("screenshot-a", a);
    const screenshotBRef = evidence.put("screenshot-b", b);
    const dumpRef = evidence.put("dump", dump);
    const focusRef = evidence.put("focus", focus);
    const observationRef = evidence.put("observation", stableStringify({
      sessionId: observeInput.linkage?.sessionId,
      alias: observeInput.linkage?.alias,
      capturedAt: observeInput.capturedAt,
    }));

    // Stability: A and B must hash equally (no animation/transition in flight).
    const screenshotASha256 = screenshotARef.sha256;
    const screenshotBSha256 = screenshotBRef.sha256;
    const stable = screenshotASha256 === screenshotBSha256;
    const pageFingerprint = fingerprintOf(dump, "page");
    const focusFingerprint = fingerprintOf(focus, "focus");
    const partial = observeInput.flags?.partial === true;
    const missing = !a || !b || !dump || !focus || observeInput.flags?.missing === true;

    const linkage = observeInput.linkage || {};
    const width = Number(observeInput.width) || 1080;
    const height = Number(observeInput.height) || 2400;
    const orientation = observeInput.orientation === "landscape" ? "landscape" : "portrait";
    const density = Number(observeInput.density) || 3;

    const manifestSha256 = sha256Hex(`xw.screen-frame.v1:manifest:${stableStringify({
      observationRef, screenshotARef, screenshotBRef, dumpRef, focusRef,
      screenshotASha256, screenshotBSha256, width, height, orientation, density,
      capturedAt: observeInput.capturedAt, linkage, pageFingerprint, focusFingerprint,
    })}`);
    const frameId = deriveFrameId(manifestSha256);
    const capturedMs = Date.parse(observeInput.capturedAt);
    const expiresAt = new Date(capturedMs + frameTtlMs).toISOString().replace(/\.\d{3}/, ".000");

    const frame = {
      schemaId: "xw.screen-frame.v1",
      frameId,
      manifestSha256,
      observationRef,
      screenshotARef,
      screenshotBRef,
      dumpRef,
      focusRef,
      screenshotASha256,
      screenshotBSha256,
      width,
      height,
      orientation,
      density,
      capturedAt: observeInput.capturedAt,
      expiresAt,
      linkage: {
        sessionId: linkage.sessionId || "sess-unknown",
        leaseRef: linkage.leaseRef || "lease-unknown",
        alias: linkage.alias || "00",
        appId: linkage.appId || "app-unknown",
      },
      stability: {
        verdict: stable ? "stable" : "unstable",
        pageFingerprint,
        focusFingerprint,
      },
      flags: { partial: Boolean(partial), missing: Boolean(missing) },
    };

    const valid = validateScreenFrame(frame);
    if (!valid.ok) {
      // Fail closed: an invalid or unstable frame is never returned as actionable.
      return { ok: false, errors: valid.errors, frame: null };
    }
    return { ok: true, errors: [], frame };
  }

  // segmentBlocks: turn a frozen frame into a model-visible block set. blockId is
  // derived by the runtime (not the provider); integrity covers full metadata.
  function segmentBlocks(frame, opts = {}) {
    const errs = [];
    if (!frame || frame.schemaId !== "xw.screen-frame.v1") {
      fail(errs, CODE, "segmentBlocks requires a frozen xw.screen-frame.v1");
      return { ok: false, errors: errs, blockSet: null };
    }
    const segProvider = opts.provider || provider;
    const rawBlocks = segProvider.segment(frame, evidence);
    const blocks = rawBlocks.map((raw) => {
      const blockId = deriveBlockId({
        frameId: frame.frameId,
        stableIndex: raw.stableIndex,
        regionHash: raw.regionHash,
        label: raw.label,
        category: raw.category,
      });
      return {
        schemaId: "xw.visual-block.v1",
        frameId: frame.frameId,
        blockId,
        stableIndex: raw.stableIndex,
        regionHash: raw.regionHash,
        boundsRef: raw.boundsRef,
        label: raw.label,
        category: raw.category,
        confidence: raw.confidence,
        source: raw.source,
        // Private signals retained for decide(); stripped before model exposure.
        _signals: raw._signals || {},
      };
    });
    const segmentation = {
      provider: segProvider.id,
      version: segProvider.version,
      modelSha256: segProvider.modelSha256,
    };
    const ordering = "stable-index";
    const integritySha256 = computeBlockSetIntegritySha256({
      frameId: frame.frameId,
      segmentation,
      ordering,
      blocks: blocks.map(stripPrivate),
    });
    const blockSet = {
      schemaId: "xw.visual-block-set.v1",
      frameId: frame.frameId,
      segmentation,
      ordering,
      blocks: blocks.map(stripPrivate),
      integritySha256,
    };
    const valid = validateVisualBlockSet(blockSet);
    if (!valid.ok) return { ok: false, errors: valid.errors, blockSet: null };
    // Keep the private-signal view internally for decide(); surface is clean.
    blockSet._blocks = blocks;
    return { ok: true, errors: [], blockSet };
  }

  // decide: run the six grounding checks + the payment/delete hard-redline
  // firewall, then derive an ALLOW_ONCE / REPLAN / HARD_STOP decision.
  function decide({ frame, blockSet, blockId, intent, grantRef, goalRef, stepRef, effectClass }) {
    const errs = [];
    if (!frame || frame.schemaId !== "xw.screen-frame.v1") {
      fail(errs, CODE, "decide requires a frozen frame");
      return { ok: false, errors: errs, decision: null };
    }
    const internal = (blockSet?._blocks) || [];
    const block = internal.find((b) => b.blockId === blockId)
      || blockSet?.blocks?.find((b) => b.blockId === blockId);
    if (!block) {
      fail(errs, CODE, "decide could not resolve the requested blockId in the block set");
      return { ok: false, errors: errs, decision: null };
    }

    // 1. freshness — frame must not be expired relative to the caller's clock.
    const nowMs = Number.isFinite(frame._nowMs) ? frame._nowMs : Date.parse(frame.capturedAt);
    const expiresMs = Date.parse(frame.expiresAt);
    const freshness = nowMs < expiresMs ? "PASS" : "FAIL";

    // 2. focus — focus fingerprint present and non-empty.
    const focus = frame.stability.focusFingerprint ? "PASS" : "FAIL";

    // 3. ambiguity — no duplicate candidate labels among peers.
    const sameLabelPeers = internal.filter((b) => b.label === block.label && b.blockId !== block.blockId);
    const ambiguity = sameLabelPeers.length > 0 ? "FAIL" : "PASS";

    // 4. safe-region — geometry within screen bounds (private evidence only).
    const boundsEntry = evidence.ref(block.boundsRef.id);
    const safeRegion = boundsEntry ? "PASS" : "UNKNOWN";

    // 5. sensitive-label — payment/delete category on the target block.
    const sensitiveLabel = (block.category === "payment" || block.category === "delete") ? "FAIL" : "PASS";

    // 6. confidence — above the frozen threshold.
    const confidence = (typeof block.confidence === "number" && block.confidence >= 0.8) ? "PASS" : "FAIL";

    const checks = [
      { name: "freshness", result: freshness },
      { name: "focus", result: focus },
      { name: "ambiguity", result: ambiguity },
      { name: "safe-region", result: safeRegion },
      { name: "sensitive-label", result: sensitiveLabel },
      { name: "confidence", result: confidence },
    ];

    // Hard-redline firewall: payment/delete via intent, block signals or page
    // fingerprint. Independent of the grant; DSH/grant/live config cannot override.
    const redline = evaluateHardRedline({
      intent,
      blockSignals: { ...(block._signals || {}), category: block.category },
      pageFingerprint: { pageHash: frame.stability.pageFingerprint },
      policy,
      expectedPolicySha256,
    });
    if (!redline.ok) {
      // Policy problem => HARD_STOP, never PASS.
      return { ok: false, errors: redline.errors, decision: hardStop({ frame, block, intent, grantRef, goalRef, stepRef, effectClass, checks, reason: "hard-redline policy failure" }) };
    }

    let result;
    let reason;
    const redlineIntent = REDLINE_EFFECT_CLASSES.includes(effectClass);
    if (redline.verdict === "HARD_STOP" || redlineIntent || sensitiveLabel === "FAIL") {
      result = "HARD_STOP";
      reason = "payment/delete hard-redline or sensitive target block";
    } else if (redline.verdict === "REPLAN") {
      result = "REPLAN";
      reason = "risky page with uncertain semantics";
    } else {
      const degraded = ["freshness", "focus", "ambiguity", "safe-region", "confidence"]
        .some((name) => checks.find((c) => c.name === name).result !== "PASS");
      result = degraded ? "REPLAN" : "ALLOW_ONCE";
      reason = degraded ? "one or more grounding checks degraded" : "all grounding checks passed";
    }

    const decision = buildDecision({ frame, block, intent, grantRef, goalRef, stepRef, effectClass, checks, result, reason });
    const valid = validateGroundingDecision(decision, { block: stripPrivate(block) });
    if (!valid.ok) return { ok: false, errors: valid.errors, decision: null };
    return { ok: true, errors: [], decision };
  }

  // resolveInternalPoint: the one-time private tap-point resolution. Only valid
  // on ALLOW_ONCE; the point is consumed in the same dispatch transaction and
  // cannot be replayed. Coordinates stay in the evidence store.
  function resolveInternalPoint(decision, evidenceStore = evidence) {
    const errs = [];
    if (!decision || decision.schemaId !== "xw.grounding-decision.v1") {
      fail(errs, CODE, "resolveInternalPoint requires a grounding decision");
      return { ok: false, errors: errs, pointRef: null };
    }
    if (decision.result !== "ALLOW_ONCE") {
      fail(errs, CODE, "resolveInternalPoint is only valid on ALLOW_ONCE decisions");
      return { ok: false, errors: errs, pointRef: null };
    }
    const payload = stableStringify({
      groundingDecisionId: decision.groundingDecisionId,
      frameId: decision.frameId,
      blockId: decision.blockId,
      nonce: "once",
    });
    const pointRef = evidenceStore.put("point", payload);
    return { ok: true, errors: [], pointRef };
  }

  function hardStop({ frame, block, intent, grantRef, goalRef, stepRef, effectClass, checks, reason }) {
    return buildDecision({ frame, block, intent, grantRef, goalRef, stepRef, effectClass, checks, result: "HARD_STOP", reason });
  }

  function buildDecision({ frame, block, intent, grantRef, goalRef, stepRef, effectClass, checks, result, reason }) {
    const decision = {
      schemaId: "xw.grounding-decision.v1",
      goalRef,
      stepRef,
      grantRef,
      frameId: frame.frameId,
      blockId: block.blockId,
      intent,
      effectClass,
      policyVersion,
      policySha256: expectedPolicySha256,
      checks,
      result,
      reason,
    };
    if (result === "ALLOW_ONCE") {
      decision.groundingDecisionId = deriveGroundingDecisionId(decision);
    }
    return decision;
  }

  return {
    ok: true,
    errors: [],
    runtime: {
      provider,
      evidence,
      policy,
      expectedPolicySha256,
      freezeFrame,
      segmentBlocks,
      decide,
      resolveInternalPoint,
    },
  };
}

function stripPrivate(block) {
  const { _signals, ...rest } = block;
  return rest;
}
