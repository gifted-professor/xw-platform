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

import { classifyHardRedlinePageRisk, evaluateHardRedline } from "./m6-hard-redline.mjs";
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

  // Geometry (pixel coordinates) AND private signals (ocrText/iconLabel/...) are
  // the private resolution surface; only the opaque ref reaches the model. The
  // ref binds blockId+regionHash+geometry+signals, so:
  //   * a relabeled or swapped target produces a different blockId but KEEPS
  //     the same boundsRef — the original signals (e.g. ocrText "确认支付") still
  //     resolve, so a provider that relabels payment→content cannot smuggle the
  //     block past the redline firewall;
  //   * a caller that mutates the public block set breaks integritySha256,
  //     which decide() re-verifies on every call.
  function bounds(blockId, regionHash, geometry, signals = {}) {
    const payload = stableStringify({ blockId, regionHash, geometry, signals });
    return put("bounds", payload);
  }

  // Resolve the private geometry + signals bound to a boundsRef. Returns null
  // if the ref is absent or not a bounds blob — decide() treats absence as a
  // safe-region failure, never as silent PASS.
  function resolveBounds(id) {
    const entry = blobs.get(id);
    if (!entry || entry.kind !== "bounds") return null;
    try {
      return JSON.parse(entry.bytes.toString("utf8"));
    } catch {
      return null;
    }
  }

  function readText(id, expectedKind) {
    const entry = blobs.get(id);
    if (!entry || (expectedKind && entry.kind !== expectedKind)) return null;
    return entry.bytes.toString("utf8");
  }

  return {
    put,
    ref,
    bounds,
    resolveBounds,
    readText,
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
    const dumpText = evidence.readText(frame.dumpRef?.id, "dump") || "";
    const replayScenario = /^dump-\d+:(.+)$/.exec(dumpText)?.[1];
    const replaySpecs = replayScenario ? REPLAY_SCENE_TABLE[replayScenario] : null;
    const scenarios = replaySpecs || SCENARIO_TABLE[seed[1] % SCENARIO_TABLE.length];
    const count = replaySpecs ? replaySpecs.length : 3 + (seed[0] % 6); // 3..8 fallback blocks
    for (let index = 0; index < count; index += 1) {
      const s = scenarios[index % scenarios.length];
      const regionHash = regionHashOf(frame.frameId, index, s.label, s.category);
      const geometry = replaySpecs ? replayGeometry(index) : geometryOf(seed, index, frame.width, frame.height);
      const blockId = deriveBlockId({ frameId: frame.frameId, stableIndex: index, regionHash, label: s.label, category: s.category });
      // Private signals (ocrText/iconLabel/...) are stored INSIDE the bounds blob,
      // cryptographically bound to the opaque boundsRef. A provider that relabels
      // payment→content changes the blockId but preserves the boundsRef, so the
      // original signals still resolve and the redline firewall still fires.
      const boundsRef = evidence.bounds(blockId, regionHash, geometry, s.signals || {});
      blocks.push({
        stableIndex: index,
        regionHash,
        boundsRef,
        label: s.label,
        category: s.category,
        confidence: s.confidence,
        source: s.source,
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

// Fixture-provider detections for the synthetic replay scenes. The committed
// corpus contains a separate frozen annotation for these scenes; metrics never
// call this table to construct expected truth.
const REPLAY_SCENE_TABLE = Object.freeze({
  popup: [{ label: "取消", category: "permission-dialog", confidence: 0.95, source: "fused" }, { label: "确定", category: "permission-dialog", confidence: 0.95, source: "fused" }, { label: "内容", category: "content", confidence: 0.95, source: "fused" }],
  keyboard: [{ label: "输入框", category: "content", confidence: 0.96, source: "fused" }, { label: "键盘", category: "keyboard", confidence: 0.93, source: "vision" }, { label: "返回", category: "system-navigation", confidence: 0.95, source: "a11y" }],
  rotation: [{ label: "横屏内容", category: "content", confidence: 0.96, source: "fused" }, { label: "返回", category: "system-navigation", confidence: 0.95, source: "a11y" }],
  ads: [{ label: "跳过广告", category: "content", confidence: 0.96, source: "fused" }, { label: "广告", category: "ads", confidence: 0.9, source: "vision" }],
  "dup-blocks": [{ label: "滚动内容", category: "content", confidence: 0.94, source: "fused" }, { label: "滚动内容", category: "content", confidence: 0.94, source: "fused" }],
  sensitive: [{ label: "确认支付", category: "payment", confidence: 0.99, source: "fused", signals: { ocrText: "确认支付" } }, { label: "返回", category: "system-navigation", confidence: 0.95, source: "a11y" }],
  "scroll-before": [{ label: "第一条", category: "content", confidence: 0.96, source: "fused" }, { label: "滚动内容", category: "content", confidence: 0.94, source: "fused" }],
  "scroll-after": [{ label: "第二条", category: "content", confidence: 0.96, source: "fused" }, { label: "加载更多", category: "content", confidence: 0.9, source: "ocr" }],
  "permission-dialog": [{ label: "允许", category: "permission-dialog", confidence: 0.91, source: "a11y" }, { label: "拒绝", category: "permission-dialog", confidence: 0.91, source: "a11y" }],
  "status-bar": [{ label: "搜索", category: "content", confidence: 0.97, source: "fused" }, { label: "状态栏", category: "status-bar", confidence: 0.99, source: "vision" }],
  "system-nav": [{ label: "返回", category: "system-navigation", confidence: 0.95, source: "a11y" }, { label: "标题", category: "content", confidence: 0.96, source: "fused" }],
  "content-search": [{ label: "搜索", category: "content", confidence: 0.97, source: "fused" }, { label: "发现", category: "system-navigation", confidence: 0.95, source: "fused" }],
});

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
  // The geometry always fits within [0,width)×[0,height) — the modulo bounds
  // guarantee x0+w ≤ width and y0+h ≤ height so safe-region can PASS for
  // legitimate blocks.
  const step = Math.floor(width / 8) || 1;
  const h = Math.floor(height / 6) || 1;
  const xMod = Math.max(width - step, 1);
  const yMod = Math.max(height - h, 1);
  const x0 = (index * step + seed[2 % seed.length]) % xMod;
  const y0 = (index * h + seed[3 % seed.length]) % yMod;
  return { x: x0, y: y0, w: step, h };
}

function replayGeometry(index) {
  return { x: 100, y: 100 + index * 180, w: 360, h: 120 };
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

  // One-time consumption registry for ALLOW_ONCE decision IDs. A decisionId can
  // be resolved at most once — replay or reuse of a consumed decisionId always
  // fails closed, preventing point-ref forgery and double-dispatch.
  const consumedDecisions = new Set();
  // Runtime-private issuance registry (P1-4): every ALLOW_ONCE decisionId this
  // runtime produced is registered here with the exact bounds binding it was
  // decided against. resolveInternalPoint only honors decisions present in this
  // registry — a well-formed but never-issued (forged) decision can never obtain
  // a point, and the resolved point is always bound to the registered boundsRef.
  const issuedDecisions = new Map();
  // Runtime-private observation attestations are derived before segmentation.
  // A provider can neither supply nor mutate these page/app risk facts.
  const issuedFrameRisk = new Map();
  const pinnedProvider = Object.freeze({
    id: provider?.id,
    version: provider?.version,
    modelSha256: provider?.modelSha256,
    segment: typeof provider?.segment === "function" ? provider.segment.bind(provider) : null,
  });
  if (!pinnedProvider.id || !pinnedProvider.version
      || !/^[0-9a-f]{64}$/.test(pinnedProvider.modelSha256 || "")
      || !pinnedProvider.segment) {
    fail(errors, CODE, "provider must be construction-time pinned by id/version/modelSha256 and segment()");
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
    issuedFrameRisk.set(frame.frameId, Object.freeze({
      appId: frame.linkage.appId,
      riskClass: classifyHardRedlinePageRisk({ dump, focus, appId: frame.linkage.appId }),
    }));
    return { ok: true, errors: [], frame };
  }

  // segmentBlocks: turn a frozen frame into a model-visible block set. blockId is
  // derived by the runtime (not the provider); integrity covers full metadata.
  // Private signals are stored in the evidence store keyed by blockId — never on
  // the block surface — so decide() can only resolve them for blocks whose
  // blockId is integrity-covered.
  function segmentBlocks(frame) {
    const errs = [];
    if (!frame || frame.schemaId !== "xw.screen-frame.v1") {
      fail(errs, CODE, "segmentBlocks requires a frozen xw.screen-frame.v1");
      return { ok: false, errors: errs, blockSet: null };
    }
    if (!issuedFrameRisk.has(frame.frameId)) {
      fail(errs, CODE, "segmentBlocks requires a frame issued by this runtime");
      return { ok: false, errors: errs, blockSet: null };
    }
    const rawBlocks = pinnedProvider.segment(frame, evidence);
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
      };
    });
    const segmentation = {
      provider: pinnedProvider.id,
      version: pinnedProvider.version,
      modelSha256: pinnedProvider.modelSha256,
    };
    const ordering = "stable-index";
    const integritySha256 = computeBlockSetIntegritySha256({
      frameId: frame.frameId,
      segmentation,
      ordering,
      blocks,
    });
    const blockSet = {
      schemaId: "xw.visual-block-set.v1",
      frameId: frame.frameId,
      segmentation,
      ordering,
      blocks,
      integritySha256,
    };
    const valid = validateVisualBlockSet(blockSet);
    if (!valid.ok) return { ok: false, errors: valid.errors, blockSet: null };
    return { ok: true, errors: [], blockSet };
  }

  // decide: run the six grounding checks + the payment/delete hard-redline
  // firewall, then derive an ALLOW_ONCE / REPLAN / HARD_STOP decision.
  // `nowMs` is required — no ambient clock fallback. `blockSet` integrity is
  // verified on every call so a mutated or forged block set is always detected.
  function decide({ frame, blockSet, blockId, intent, grantRef, goalRef, stepRef, effectClass, nowMs }) {
    const errs = [];
    if (!frame || frame.schemaId !== "xw.screen-frame.v1") {
      fail(errs, CODE, "decide requires a frozen frame");
      return { ok: false, errors: errs, decision: null };
    }
    if (!Number.isFinite(nowMs)) {
      fail(errs, CODE, "nowMs is required and must be a finite number");
      return { ok: false, errors: errs, decision: null };
    }
    // Re-verify integrity of the supplied block set: it must match its declared
    // integritySha256 AND bind to the same frameId. A mutated or swapped block
    // set (e.g. relabeled payment labels) would produce a different hash or
    // frameId and is rejected here.
    const recomputed = computeBlockSetIntegritySha256(blockSet);
    if (recomputed !== blockSet.integritySha256) {
      fail(errs, CODE, "blockSet integritySha256 mismatch — block set was mutated after creation");
      return { ok: false, errors: errs, decision: null };
    }
    if (blockSet.frameId !== frame.frameId) {
      fail(errs, CODE, "blockSet frameId does not match the supplied frame");
      return { ok: false, errors: errs, decision: null };
    }

    const block = blockSet.blocks.find((b) => b.blockId === blockId);
    if (!block) {
      fail(errs, CODE, "decide could not resolve the requested blockId in the block set");
      return { ok: false, errors: errs, decision: null };
    }

    // Resolve private signals from the evidence store. These are stored by
    // blockId during segmentation and cannot be resolved for a forged/unknown
    // blockId (which would produce a different blockId than the one signed by
    // the block set's integrity hash).
    //
    // Resolve private geometry + signals from the bounds blob bound to the
    // block's boundsRef. The boundsRef is content-addressed and preserved across
    // category relabeling, so a provider that relabels payment→content cannot
    // strip the original signals (e.g. ocrText "确认支付") — they still resolve
    // here and the redline firewall still fires.
    //
    // P1-1: the resolved bounds blob must be EXACTLY bound to the block being
    // decided: blockId AND regionHash must match, and the blob's content hash
    // must equal boundsRef.sha256 (detecting any payload tampering). A swapped
    // boundsRef (pointing at a benign block's blob) or a relabeled block with a
    // legitimately recomputed blockId/integrity is rejected — fail closed via
    // HARD_STOP, never degraded to ALLOW_ONCE.
    const bounds = evidence.resolveBounds(block.boundsRef?.id);
    if (
      !bounds
      || bounds.blockId !== block.blockId
      || bounds.regionHash !== block.regionHash
      || evidence.ref(block.boundsRef.id)?.sha256 !== block.boundsRef.sha256
    ) {
      const reason = "boundsRef does not resolve to a bounds blob exactly bound to this block (swapped ref or tampered payload)";
      return {
        ok: true,
        errors: [],
        decision: hardStop({ frame, block, intent, grantRef, goalRef, stepRef, effectClass, checks: [], reason }),
      };
    }
    const geometry = bounds.geometry;
    const privSignals = bounds.signals || {};
    const trustedPage = issuedFrameRisk.get(frame.frameId);
    if (!trustedPage) {
      const reason = "frame has no runtime-issued page/app risk attestation";
      return {
        ok: true,
        errors: [],
        decision: hardStop({ frame, block, intent, grantRef, goalRef, stepRef, effectClass, checks: [], reason }),
      };
    }

    // 1. freshness — frame must not be expired relative to the caller's clock.
    const expiresMs = Date.parse(frame.expiresAt);
    const freshness = nowMs < expiresMs ? "PASS" : "FAIL";

    // 2. focus — focus fingerprint present and non-empty.
    const focus = frame.stability.focusFingerprint ? "PASS" : "FAIL";

    // 3. ambiguity — no duplicate candidate labels among peers.
    const sameLabelPeers = blockSet.blocks.filter((b) => b.label === block.label && b.blockId !== block.blockId);
    const ambiguity = sameLabelPeers.length > 0 ? "FAIL" : "PASS";

    // 4. safe-region — geometry within screen bounds (resolved from evidence).
    let safeRegion = "FAIL";
    if (geometry) {
      const { x, y, w, h } = geometry;
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(w) && Number.isFinite(h)
          && x >= 0 && y >= 0 && w > 0 && h > 0
          && (x + w) <= frame.width && (y + h) <= frame.height) {
        safeRegion = "PASS";
      } else {
        safeRegion = "FAIL";
      }
    }

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
    // Private signals come from the evidence store (integrity-covered blockId),
    // not from the block surface.
    const redline = evaluateHardRedline({
      intent,
      blockSignals: {
        ...privSignals,
        category: block.category,
        // A risky page with provider-only target semantics remains uncertain;
        // the provider cannot self-certify a payment/destructive target safe.
        uncertain: Boolean(trustedPage.riskClass),
      },
      pageFingerprint: {
        pageHash: frame.stability.pageFingerprint,
        riskClass: trustedPage.riskClass,
        appId: trustedPage.appId,
      },
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
    const valid = validateGroundingDecision(decision, { block });
    if (!valid.ok) return { ok: false, errors: valid.errors, decision: null };
    // P1-4: register every issued ALLOW_ONCE with its exact bounds binding so
    // resolveInternalPoint can only honor decisions this runtime produced, and
    // only against the bounds the redline firewall actually saw.
    if (decision.result === "ALLOW_ONCE") {
      issuedDecisions.set(decision.groundingDecisionId, {
        blockId: block.blockId,
        boundsRef: { id: block.boundsRef.id, sha256: block.boundsRef.sha256 },
      });
    }
    return { ok: true, errors: [], decision };
  }

  // resolveInternalPoint: the one-time private tap-point resolution. Only valid
  // on ALLOW_ONCE decisions actually ISSUED by this runtime (P1-4): the
  // decisionId must be present in the runtime-private issuedDecisions registry,
  // the decision's blockId must match the registered binding, and the registered
  // boundsRef must still resolve to an exactly-bound bounds blob. Resolution is
  // atomic — the decision is consumed on success and can never be resolved
  // again. A point is always bound to the registered boundsRef; a point without
  // a valid boundsRef is never produced. Coordinates stay in the evidence store.
  function resolveInternalPoint(decision) {
    const errs = [];
    if (!decision || decision.schemaId !== "xw.grounding-decision.v1") {
      fail(errs, CODE, "resolveInternalPoint requires a grounding decision");
      return { ok: false, errors: errs, pointRef: null };
    }
    if (decision.result !== "ALLOW_ONCE") {
      fail(errs, CODE, "resolveInternalPoint is only valid on ALLOW_ONCE decisions");
      return { ok: false, errors: errs, pointRef: null };
    }
    // Re-validate the decision is well-formed: prevents a forged decision
    // object (carrying ALLOW_ONCE with a fake groundingDecisionId) from
    // obtaining a valid pointRef.
    const valid = validateGroundingDecision(decision);
    if (!valid.ok) {
      fail(errs, CODE, "resolveInternalPoint: decision failed validation — forged or malformed", { validationErrors: valid.errors });
      return { ok: false, errors: errs, pointRef: null };
    }
    // One-time consumption: this decisionId cannot be resolved again.
    if (consumedDecisions.has(decision.groundingDecisionId)) {
      fail(errs, CODE, "resolveInternalPoint: decision already consumed — replay attack prevented");
      return { ok: false, errors: errs, pointRef: null };
    }
    // P1-4: only decisions issued by THIS runtime resolve. The registry binding
    // (blockId + exact boundsRef) is authoritative; a forged-but-well-formed
    // decision that was never issued is rejected here.
    const issued = issuedDecisions.get(decision.groundingDecisionId);
    if (!issued) {
      fail(errs, CODE, "resolveInternalPoint: decision was never issued by this runtime — forged decision rejected");
      return { ok: false, errors: errs, pointRef: null };
    }
    if (issued.blockId !== decision.blockId) {
      fail(errs, CODE, "resolveInternalPoint: decision blockId does not match the issued binding");
      return { ok: false, errors: errs, pointRef: null };
    }
    // Resolve against the registered boundsRef only, and require an exact
    // blockId binding — never scan the store for a first match, never produce a
    // boundsRef:null point.
    const bounds = evidence.resolveBounds(issued.boundsRef.id);
    if (
      !bounds
      || bounds.blockId !== issued.blockId
      || evidence.ref(issued.boundsRef.id)?.sha256 !== issued.boundsRef.sha256
    ) {
      fail(errs, CODE, "resolveInternalPoint: registered boundsRef no longer resolves to an exactly-bound bounds blob");
      return { ok: false, errors: errs, pointRef: null };
    }
    // Atomic consumption: remove from issued BEFORE producing the point so a
    // re-entrant or replayed resolution can never succeed twice.
    issuedDecisions.delete(decision.groundingDecisionId);
    consumedDecisions.add(decision.groundingDecisionId);

    const payload = stableStringify({
      groundingDecisionId: decision.groundingDecisionId,
      frameId: decision.frameId,
      blockId: decision.blockId,
      boundsRef: issued.boundsRef,
      nonce: consumedDecisions.size,
    });
    const pointRef = evidence.put("point", payload);
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
      provider: pinnedProvider,
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
