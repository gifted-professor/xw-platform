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
});

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

export function deriveBlockId({ frameId, stableIndex, regionHash }) {
  return sha256Hex(`xw.visual-block.v1:${frameId}:${stableIndex}:${regionHash}`);
}

export function computeBlockSetIntegritySha256(blocks) {
  return sha256Hex(`xw.visual-block-set.v1:${blocks.map((block) => block.blockId).join(",")}`);
}

export function deriveGroundingDecisionId({ frameId, blockId, grantRef, intent, effectClass }) {
  return sha256Hex(`xw.grounding-decision.v1:${frameId}:${blockId}:${grantRef}:${intent}:${effectClass}`);
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
  if (blockSet.integritySha256 !== computeBlockSetIntegritySha256(blockSet.blocks)) {
    fail(errors, code, "integritySha256 does not match the block id list");
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
