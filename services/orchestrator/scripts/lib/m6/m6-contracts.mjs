// M6 contract validators (schema + forgery guards) for the agentic grounding pipeline.
// Pure functions only: no device IO, no network, deterministic. Schemas live in
// packages/kernel/contracts/orchestration/m6/ and are the source of truth; this module
// validates documents against them with the shared zero-dependency JSON Schema subset
// validator and adds the semantic invariants the schema layer cannot express
// (derived ids, once-only decisions, receipt linkage). Style follows
// packages/kernel/lib/skill-runtime.mjs: validators return { ok, errors } and never throw.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { validateJsonSchema } from "../../../../control-plane/control-plane/lib/json-schema-validator.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../../..");const CONTRACT_DIR = path.join(REPO_ROOT, "packages/kernel/contracts/orchestration/m6");

export const M6_SCHEMA_FILES = Object.freeze({
  "xw.screen-frame.v1": "xw.screen-frame.v1.schema.json",
  "xw.visual-block.v1": "xw.visual-block.v1.schema.json",
  "xw.visual-block-set.v1": "xw.visual-block-set.v1.schema.json",
  "xw.grounding-decision.v1": "xw.grounding-decision.v1.schema.json",
  "xw.autonomy-grant.v1": "xw.autonomy-grant.v1.schema.json",
  "xw.hard-redline-policy.v1": "xw.hard-redline-policy.v1.schema.json",
  "xw.grounded-action.receipt.v1": "xw.grounded-action.receipt.v1.schema.json",
  "xw.agentic-executor.v1": "xw.agentic-executor.v1.schema.json",
  "xw.visual-assets.lock.v1": "xw.visual-assets.lock.v1.schema.json",
  "xw.replay-corpus-manifest.v1": "xw.replay-corpus-manifest.v1.schema.json",
  "xw.capture-attempt-receipt.v1": "xw.capture-attempt-receipt.v1.schema.json",
  "xw.m6-live-gate.v1": "xw.m6-live-gate.v1.schema.json",
});

export const CAPTURE_RECEIPT_STATUSES = Object.freeze(["accepted", "rejected"]);

export const M6_LIVE_GATE_MODES = Object.freeze(["CLOSED", "OBSERVE_ONLY"]);

export const M6_LIVE_GATE_STATUSES = Object.freeze(["active", "closed"]);

export const GROUNDING_CHECK_NAMES = Object.freeze([
  "freshness",
  "focus",
  "ambiguity",
  "safe-region",
  "sensitive-label",
  "confidence",
]);

export const GROUNDING_RESULTS = Object.freeze(["ALLOW_ONCE", "REPLAN", "HARD_STOP"]);

export const REDLINE_EFFECT_CLASSES = Object.freeze(["payment", "delete"]);

export const RECEIPT_STATUSES = Object.freeze([
  "AUTHORIZED",
  "DISPATCHED",
  "VERIFIED",
  "FAILED",
  "AMBIGUOUS",
  "RECONCILED",
]);

export const HARD_REDLINE_CATEGORY_NAMES = Object.freeze([
  "payment",
  "purchase",
  "transfer",
  "tip",
  "subscription",
  "credential-submit",
  "delete",
  "uninstall",
  "clear-data",
]);

export const HARD_REDLINE_RISK_PAGES = Object.freeze([
  "confirm-dialog",
  "payment-page",
  "order-page",
  "assets-page",
  "destructive-settings",
]);

export function loadM6ContractSchema(schemaId) {
  const file = M6_SCHEMA_FILES[schemaId];
  if (!file) throw new Error(`unknown M6 schemaId: ${schemaId}`);
  return JSON.parse(readFileSync(path.join(CONTRACT_DIR, file), "utf8"));
}

export function fail(errors, code, message, details) {
  errors.push(details === undefined ? { code, message } : { code, message, details });
}

export function sha256Hex(input) {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

export function deriveFrameId(manifestSha256) {
  return sha256Hex(`xw.screen-frame.v1:${manifestSha256}`);
}

// Ids and integrity hashes bind the full canonical safety metadata, not just the
// identifiers: relabeling a block or editing decision checks/policy invalidates them.
export function deriveBlockId(block) {
  return sha256Hex(`xw.visual-block.v1:${stableStringify({
    frameId: block.frameId,
    stableIndex: block.stableIndex,
    regionHash: block.regionHash,
    label: block.label,
    category: block.category,
  })}`);
}

export function computeBlockSetIntegritySha256(blockSet) {
  return sha256Hex(`xw.visual-block-set.v1:${stableStringify({
    frameId: blockSet.frameId,
    segmentation: blockSet.segmentation,
    ordering: blockSet.ordering,
    blocks: (blockSet.blocks || []).map((block) => ({
      frameId: block.frameId,
      blockId: block.blockId,
      stableIndex: block.stableIndex,
      regionHash: block.regionHash,
      boundsRef: block.boundsRef,
      label: block.label,
      category: block.category,
      confidence: block.confidence,
      source: block.source,
    })),
  })}`);
}

export function deriveGroundingDecisionId(decision) {
  return sha256Hex(`xw.grounding-decision.v1:${stableStringify({
    goalRef: decision.goalRef,
    stepRef: decision.stepRef,
    grantRef: decision.grantRef,
    frameId: decision.frameId,
    blockId: decision.blockId,
    intent: decision.intent,
    effectClass: decision.effectClass,
    policyVersion: decision.policyVersion,
    policySha256: decision.policySha256,
    checks: decision.checks,
  })}`);
}

// Canonical hash of a hard-redline policy document, excluding its self-referential
// policySha256 field. Callers pin this value; a weakened policy with a stale hash
// no longer matches.
export function computeRedlinePolicySha256(policy) {
  const { policySha256, ...rest } = policy || {};
  return sha256Hex(`xw.hard-redline-policy.v1:${stableStringify(rest)}`);
}

function validateAgainstSchema(document, schemaId, code) {
  const errors = [];
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    fail(errors, code, "document must be an object");
    return errors;
  }
  if (document.schemaId !== schemaId) {
    fail(errors, code, `schemaId must be ${schemaId}`);
    return errors;
  }
  for (const message of validateJsonSchema(document, loadM6ContractSchema(schemaId))) {
    fail(errors, code, message);
  }
  return errors;
}

function parseTime(value) {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

export function validateScreenFrame(frame) {
  const code = "INVALID_M6_SCREEN_FRAME";
  const errors = validateAgainstSchema(frame, "xw.screen-frame.v1", code);
  if (errors.length > 0) return { ok: false, errors };
  if (frame.frameId !== deriveFrameId(frame.manifestSha256)) {
    fail(errors, code, "frameId does not match the canonical manifest hash");
  }
  if (frame.density <= 0) fail(errors, code, "density must be > 0");
  if (frame.stability.verdict !== "stable") {
    fail(errors, code, "unstable frames must not become actionable screen frames");
  }
  if (frame.flags.partial || frame.flags.missing) {
    fail(errors, code, "partial or missing evidence must not become an actionable screen frame");
  }
  const capturedAt = parseTime(frame.capturedAt);
  const expiresAt = parseTime(frame.expiresAt);
  if (capturedAt === null || expiresAt === null) {
    fail(errors, code, "capturedAt/expiresAt must be valid date-time strings");
  } else if (expiresAt <= capturedAt) {
    fail(errors, code, "expiresAt must be after capturedAt");
  }
  return { ok: errors.length === 0, errors };
}

export function validateVisualBlock(block) {
  const code = "INVALID_M6_VISUAL_BLOCK";
  const errors = validateAgainstSchema(block, "xw.visual-block.v1", code);
  if (errors.length > 0) return { ok: false, errors };
  if (block.blockId !== deriveBlockId(block)) {
    fail(errors, code, "blockId is not derived from frameId + stableIndex + regionHash");
  }
  return { ok: errors.length === 0, errors };
}

export function validateVisualBlockSet(blockSet) {
  const code = "INVALID_M6_VISUAL_BLOCK_SET";
  const errors = validateAgainstSchema(blockSet, "xw.visual-block-set.v1", code);
  if (errors.length > 0) return { ok: false, errors };
  const blockIds = new Set();
  const stableIndexes = new Set();
  for (const block of blockSet.blocks) {
    if (block.frameId !== blockSet.frameId) {
      fail(errors, code, `block ${block.blockId} belongs to a different frame (cross-frame reuse)`);
    }
    if (block.blockId !== deriveBlockId(block)) {
      fail(errors, code, `block ${block.blockId} is not derived from frameId + stableIndex + regionHash`);
    }
    if (blockIds.has(block.blockId)) fail(errors, code, `duplicate blockId ${block.blockId}`);
    if (stableIndexes.has(block.stableIndex)) fail(errors, code, `duplicate stableIndex ${block.stableIndex}`);
    blockIds.add(block.blockId);
    stableIndexes.add(block.stableIndex);
  }
  if (blockSet.integritySha256 !== computeBlockSetIntegritySha256(blockSet)) {
    fail(errors, code, "integritySha256 does not match the canonical block metadata and segmentation provenance");
  }
  return { ok: errors.length === 0, errors };
}

export function validateGroundingDecision(decision, { block } = {}) {
  const code = "INVALID_M6_GROUNDING_DECISION";
  const errors = validateAgainstSchema(decision, "xw.grounding-decision.v1", code);
  if (errors.length > 0) return { ok: false, errors };

  const checkNames = decision.checks.map((check) => check.name);
  if (new Set(checkNames).size !== checkNames.length) {
    fail(errors, code, "checks must contain each check name exactly once");
  }
  for (const name of GROUNDING_CHECK_NAMES) {
    if (!checkNames.includes(name)) fail(errors, code, `missing check: ${name}`);
  }
  const checkResult = (name) => decision.checks.find((check) => check.name === name)?.result;

  const redlineIntent = REDLINE_EFFECT_CLASSES.includes(decision.effectClass);
  const sensitiveFailed = checkResult("sensitive-label") === "FAIL";
  const nonAllowChecks = ["freshness", "focus", "ambiguity", "safe-region", "confidence"];
  const degraded = nonAllowChecks.some((name) => checkResult(name) !== "PASS") || sensitiveFailed;

  // Forgery guards: the declared result must agree with the declared checks/effect.
  if ((redlineIntent || sensitiveFailed) && decision.result !== "HARD_STOP") {
    fail(errors, code, "payment/delete effect or failed sensitive-label check must resolve to HARD_STOP");
  }
  if (!redlineIntent && !sensitiveFailed && degraded && decision.result === "ALLOW_ONCE") {
    fail(errors, code, "ALLOW_ONCE requires every check to PASS; a degraded check can at most REPLAN");
  }
  if (decision.result === "ALLOW_ONCE") {
    const expected = deriveGroundingDecisionId(decision);
    if (decision.groundingDecisionId !== expected) {
      fail(errors, code, "ALLOW_ONCE groundingDecisionId is missing or not derived from frame/block/grant/intent/effect");
    }
  } else if (decision.groundingDecisionId !== undefined) {
    fail(errors, code, "groundingDecisionId is only valid on ALLOW_ONCE decisions");
  }

  if (block !== undefined) {
    if (decision.frameId !== block.frameId || decision.blockId !== block.blockId) {
      fail(errors, code, "decision does not bind the supplied block (forged frame/block reference)");
    }
  }
  return { ok: errors.length === 0, errors };
}

export function validateHardRedlinePolicy(policy) {
  const code = "INVALID_M6_HARD_REDLINE_POLICY";
  const errors = validateAgainstSchema(policy, "xw.hard-redline-policy.v1", code);
  if (errors.length > 0) return { ok: false, errors };
  const names = new Set(policy.categories.map((category) => category.name));
  if (names.size !== policy.categories.length) fail(errors, code, "categories must be unique");
  for (const name of HARD_REDLINE_CATEGORY_NAMES) {
    if (!names.has(name)) fail(errors, code, `hard-redline category missing: ${name}`);
  }
  return { ok: errors.length === 0, errors };
}

export function validateGroundedActionReceipt(receipt) {
  const code = "INVALID_M6_GROUNDED_ACTION_RECEIPT";
  const errors = validateAgainstSchema(receipt, "xw.grounded-action.receipt.v1", code);
  if (errors.length > 0) return { ok: false, errors };
  if (receipt.status === "VERIFIED" || receipt.status === "RECONCILED") {
    if (!receipt.afterFrameRef) fail(errors, code, `${receipt.status} receipts require afterFrameRef`);
    if (!receipt.verificationRef) fail(errors, code, `${receipt.status} receipts require verificationRef`);
  }
  if ((receipt.status === "FAILED" || receipt.status === "AMBIGUOUS") && !receipt.error) {
    fail(errors, code, `${receipt.status} receipts require an error taxonomy entry`);
  }
  return { ok: errors.length === 0, errors };
}

export function checkReceiptLinkage(receipt, { decision, grantRef, beforeFrameId } = {}) {
  const code = "M6_RECEIPT_LINKAGE_BROKEN";
  const errors = [];
  if (!receipt || typeof receipt !== "object") {
    fail(errors, code, "receipt must be an object");
    return { ok: false, errors };
  }
  if (decision !== undefined) {
    if (decision.result !== "ALLOW_ONCE") {
      fail(errors, code, "receipts can only reference ALLOW_ONCE grounding decisions");
    } else if (receipt.groundingDecisionRef !== decision.groundingDecisionId) {
      fail(errors, code, "groundingDecisionRef does not match the decision's one-time id");
    }
    if (receipt.beforeFrameRef !== decision.frameId) {
      fail(errors, code, "beforeFrameRef does not match the decision frameId");
    }
    if (receipt.grantRef !== decision.grantRef) {
      fail(errors, code, "grantRef does not match the decision grantRef");
    }
  }
  if (grantRef !== undefined && receipt.grantRef !== grantRef) {
    fail(errors, code, "grantRef does not match the AutonomyGrant");
  }
  if (beforeFrameId !== undefined && receipt.beforeFrameRef !== beforeFrameId) {
    fail(errors, code, "beforeFrameRef does not match the before frame");
  }
  return { ok: errors.length === 0, errors };
}

export function validateAgenticExecutor(executor, { allowedToolClasses } = {}) {
  const code = "INVALID_M6_AGENTIC_EXECUTOR";
  const errors = validateAgainstSchema(executor, "xw.agentic-executor.v1", code);
  if (errors.length > 0) return { ok: false, errors };
  if (allowedToolClasses) {
    for (const toolClass of executor.toolAllowlist) {
      if (!allowedToolClasses.includes(toolClass)) {
        fail(errors, code, `tool class not in the M6 tool surface: ${toolClass}`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

export function validateVisualAssetsLock(document) {
  const code = "INVALID_M6_VISUAL_ASSETS_LOCK";
  const errors = validateAgainstSchema(document, "xw.visual-assets.lock.v1", code);
  return { ok: errors.length === 0, errors };
}

// Privacy guard for the replay corpus: the schema fixes the shape; sensitive keys
// (account/device/serial/token/cookie/secret/password/balance/credential, in any
// separator/casing variant) are rejected here by a recursive normalized key scan,
// because the shared JSON Schema subset cannot express propertyNames patterns.
const REPLAY_FORBIDDEN_KEY_PARTS = Object.freeze([
  "account",
  "device",
  "serial",
  "token",
  "cookie",
  "secret",
  "password",
  "balance",
  "credential",
]);

function normalizeKey(key) {
  return String(key).normalize("NFKC").toLowerCase().replace(/[-_]/g, "");
}

function scanReplayKeys(value, path, errors, code) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanReplayKeys(item, `${path}[${index}]`, errors, code));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const normalized = normalizeKey(key);
    for (const part of REPLAY_FORBIDDEN_KEY_PARTS) {
      if (normalized.includes(part)) {
        fail(errors, code, `sensitive field is forbidden in the replay corpus at ${path}: ${key}`);
        break;
      }
    }
    scanReplayKeys(child, `${path}.${key}`, errors, code);
  }
}

export function validateReplayCorpusManifest(document) {
  const code = "INVALID_M6_REPLAY_CORPUS_MANIFEST";
  const errors = validateAgainstSchema(document, "xw.replay-corpus-manifest.v1", code);
  if (errors.length > 0) return { ok: false, errors };
  scanReplayKeys(document.entries, "$.entries", errors, code);
  for (const entry of document.entries) {
    if (entry.kind !== "frame" || !entry.expected) continue;
    const expected = entry.expected;
    const indices = new Set();
    for (const block of expected.blocks || []) {
      if (indices.has(block.stableIndex)) {
        fail(errors, code, `duplicate expected stableIndex for ${entry.entryId}: ${block.stableIndex}`);
      }
      indices.add(block.stableIndex);
    }
    if (expected.frameOutcome === "ACTIONABLE") {
      if (!Number.isInteger(expected.targetStableIndex) || !indices.has(expected.targetStableIndex)) {
        fail(errors, code, `actionable frame ${entry.entryId} must target an annotated stableIndex`);
      }
      if ((expected.blocks || []).length === 0) {
        fail(errors, code, `actionable frame ${entry.entryId} must contain expected blocks`);
      }
    } else if (expected.frameOutcome === "REJECT" && expected.targetStableIndex !== undefined) {
      fail(errors, code, `rejected frame ${entry.entryId} cannot declare a targetStableIndex`);
    }
  }
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// M6-2: capture attempt receipt + live gate epoch validators.
// ---------------------------------------------------------------------------

// Derived from the canonical receipt payload minus the self-referential
// receiptSha256, so any mutation of run/linkage/status/refs invalidates it.
export function deriveCaptureAttemptReceiptSha256(receipt) {
  const { receiptSha256: _ignored, ...rest } = receipt || {};
  return sha256Hex(`xw.capture-attempt-receipt.v1:${stableStringify(rest)}`);
}

export function validateCaptureAttemptReceipt(receipt) {
  const code = "INVALID_M6_CAPTURE_ATTEMPT_RECEIPT";
  const errors = validateAgainstSchema(receipt, "xw.capture-attempt-receipt.v1", code);
  if (errors.length > 0) return { ok: false, errors };
  if (receipt.receiptSha256 !== deriveCaptureAttemptReceiptSha256(receipt)) {
    fail(errors, code, "receiptSha256 does not match the canonical receipt payload");
  }
  if (receipt.status === "accepted" && !receipt.frameRef) {
    fail(errors, code, "accepted receipts must carry a frameRef");
  }
  // An accepted capture ran a real job/session/lease, so the four attribution
  // ids must be non-null. The schema allows null only so a pre-session rejected
  // receipt (failed before any run/job/session/lease existed) can still validate.
  if (receipt.status === "accepted") {
    for (const idField of ["runId", "jobId", "sessionId", "leaseRef"]) {
      if (typeof receipt[idField] !== "string" || receipt[idField] === "") {
        fail(errors, code, `accepted receipts must carry a non-null ${idField}`);
      }
    }
  }
  if (receipt.status === "rejected" && receipt.frameRef) {
    fail(errors, code, "rejected receipts must not carry a frameRef");
  }
  if (receipt.status === "rejected" && receipt.errorCodes.length === 0) {
    fail(errors, code, "rejected receipts must carry at least one M6_ error code");
  }
  if (receipt.status === "accepted" && receipt.errorCodes.length > 0) {
    fail(errors, code, "accepted receipts must not carry error codes");
  }
  if (!Number.isFinite(Date.parse(receipt.capturedAt)) || !Number.isFinite(Date.parse(receipt.committedAt))) {
    fail(errors, code, "capturedAt/committedAt must be valid date-time strings");
  } else if (Date.parse(receipt.committedAt) < Date.parse(receipt.capturedAt)) {
    fail(errors, code, "committedAt must be at or after capturedAt");
  }
  if (receipt.skew) {
    const skew = receipt.skew;
    if (!Number.isInteger(skew.aToBMs) || skew.aToBMs < 0) {
      fail(errors, code, "skew.aToBMs must be a non-negative integer");
    }
    if (!Number.isInteger(skew.bToFocusBMs) || skew.bToFocusBMs < 0) {
      fail(errors, code, "skew.bToFocusBMs must be a non-negative integer");
    }
  }
  return { ok: errors.length === 0, errors };
}

// Derived from the canonical immutable epoch payload minus self-referential
// epochHash. Includes the parent link and closeout ref so the chain is total.
export function deriveM6LiveGateEpochHash(gate) {
  const { epochHash: _ignored, ...rest } = gate || {};
  return sha256Hex(`xw.m6-live-gate.v1:${stableStringify(rest)}`);
}

export function validateM6LiveGate(gate) {
  const code = "INVALID_M6_LIVE_GATE";
  const errors = validateAgainstSchema(gate, "xw.m6-live-gate.v1", code);
  if (errors.length > 0) return { ok: false, errors };
  if (gate.epochHash !== deriveM6LiveGateEpochHash(gate)) {
    fail(errors, code, "epochHash does not match the canonical epoch payload");
  }
  if (gate.mode === "CLOSED" && gate.status !== "closed") {
    fail(errors, code, "CLOSED epochs must have status=closed");
  }
  if (gate.mode === "OBSERVE_ONLY" && gate.status !== "active") {
    fail(errors, code, "OBSERVE_ONLY epochs must have status=active");
  }
  // An active observe-only epoch may legitimately carry closeoutRef=null (the
  // frozen activation shape); only CLOSED epochs are required to reference a
  // closeout receipt.
  if (gate.mode === "CLOSED" && !gate.closeoutRef) {
    fail(errors, code, "CLOSED epochs must reference a closeout receipt");
  }
  if (gate.status === "active" && Date.parse(gate.expiresAt) <= Date.parse(gate.issuedAt)) {
    fail(errors, code, "expiresAt must be after issuedAt for an active epoch");
  }
  return { ok: errors.length === 0, errors };
}
