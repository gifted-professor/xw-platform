/**
 * xw-xhs-dispatcher.mjs — single adaptive execution surface for the 04 小红书
 * multi-entry script pack (plan V2 §3/§6).
 *
 * Pure module: no fs, no network, no device I/O. The CLI wrapper is
 * ops/xw-xhs.mjs; tests import these pure functions directly.
 *
 * Three call surfaces (plan V2 §1) converge on the same planHash + effect
 * budget:
 *   1. explicit entry : /xw xhs <action>            -> ops/xw-xhs.mjs
 *   2. natural language : /xw task "..." via xhs-compose -> compiles to this catalog
 *   3. RPA/agent entry : node ops/xw-xhs.mjs ... --json
 *
 * Invariants (plan V2 §2.1/§4):
 *   - 04-only. Every plan forces placement=04, perDeviceConcurrency=1.
 *     alias 01/02/03 and no-alias-non-04 are rejected at plan stage with
 *     XHS_ALIAS_NOT_04 — before any job/lease/session/device I/O is created.
 *   - One action = one closeout run, one operationKey per (action,target,payload).
 *   - Effect actions (like/collect/follow/comment/reply/publish-send) are
 *     mission-only and fail-closed until their wave promotes them. W0 ships
 *     plan-only; --execute is gated per action.
 */
import { createHash } from "node:crypto";

export const DISPATCHER_SCHEMA_ID = "xw.xhs.action-plan.v1";
export const DISPATCHER_SCHEMA_VERSION = 1;
export const FORCED_ALIAS = "04";
export const PER_DEVICE_CONCURRENCY = 1;

/**
 * Default recipe revision map (plan V2 §11 rollback boundary). The CLI loads
 * the live map from a state file and passes it as `recipeRevisions`; this frozen
 * default is the pre-promotion baseline (search@1) so the pure module is
 * testable without fs. `switch-alias` bumps an entry only after the Catalog
 * promotes that revision to canary_only/implemented — the plan then binds the
 * new revision in planHash, making the rollback boundary explicit and the plan
 * reproducible per revision.
 */
export const DEFAULT_RECIPE_REVISIONS = Object.freeze({
  "xhs.search.fixed": 1,
  "xhs.browse.fixed": 1,
});

/**
 * Resolve the recipe revision a fixed_recipe action targets, given the live
 * override map. Falls back to the frozen default, then null (unknown recipe).
 */
export function resolveRecipeRevision(recipeId, recipeRevisions = {}) {
  if (!recipeId) return null;
  if (Object.prototype.hasOwnProperty.call(recipeRevisions, recipeId)) {
    const r = Number(recipeRevisions[recipeId]);
    if (Number.isInteger(r) && r >= 1) return r;
    // invalid override (0/NaN/negative) -> fall back to default so a typo cannot
    // silently unbind a known recipe (fail-safe to last known good revision).
  }
  return DEFAULT_RECIPE_REVISIONS[recipeId] ?? null;
}

const EFFECT_CLASS = Object.freeze({
  NONE: "none",
  SOCIAL: "social",
  PUBLISH: "publish",
});

/**
 * The single action catalog. backend kinds:
 *   fixed_recipe  — a sealed R0 Recipe resolved/executed via the Runner
 *   r0_workflow   — Explorer-session acquire -> dump -> (vision) -> release
 *   capability    — a typed mission-only social/publish capability job
 *   composed      — ordered composition of the above (e.g. nurture)
 *
 * `gate` is the wave that may promote this action to live; until then
 * --execute fails closed with the gate reason.
 */
export const XHS_ACTION_CATALOG = Object.freeze({
  search: Object.freeze({
    id: "search",
    backend: "fixed_recipe",
    recipeId: "xhs.search.fixed",
    effectClass: EFFECT_CLASS.NONE,
    gate: "W1",
    params: { keyword: { type: "string", required: true, min: 1, max: 50 }, pages: { type: "integer", min: 0, max: 1, default: 1 } },
    stopConditions: ["pages>1 before W1 implementation", "search surface not observed", "package drift"],
  }),
  browse: Object.freeze({
    id: "browse",
    backend: "fixed_recipe",
    recipeId: "xhs.browse.fixed",
    effectClass: EFFECT_CLASS.NONE,
    gate: "W3",
    // S0 truth fix (plan V2 §3.3): recipe@1 performs exactly 5 sealed static
    // swipes and has no time-bound loop — the old `minutes`/`swipes` inputs
    // validated fine but never bound to any execution step. This action now
    // takes no params; parameterized feed behavior arrives with the S1 routine
    // machine (xhs.feed-play.v1 --items), not by lying in this plan.
    params: {},
    stopConditions: ["any interaction attempted", "feed empty", "package drift"],
  }),
  inbox: Object.freeze({
    id: "inbox",
    backend: "r0_workflow",
    effectClass: EFFECT_CLASS.NONE,
    gate: "W3",
    aliases: ["messages"], // /xw messages compat alias
    params: {},
    stopConditions: ["non-unique conversation entered", "send/delete attempted", "package drift"],
  }),
  read: Object.freeze({
    id: "read",
    backend: "r0_workflow",
    effectClass: EFFECT_CLASS.NONE,
    gate: "W3",
    params: { thread: { type: "string", required: true, min: 1, max: 200 } },
    stopConditions: ["thread fingerprint not unique", "send attempted", "package drift"],
  }),
  like: Object.freeze({
    id: "like",
    backend: "capability",
    capabilityId: "xhs.like.ensure",
    effectClass: EFFECT_CLASS.SOCIAL,
    gate: "W4",
    params: { keyword: { type: "string", min: 1, max: 50 }, count: { type: "integer", min: 1, max: 20, default: 1 } },
    stopConditions: ["target not unique", "already-true verified skip", "mission budget exceeded"],
  }),
  collect: Object.freeze({
    id: "collect",
    backend: "capability",
    capabilityId: "xhs.collect.ensure",
    effectClass: EFFECT_CLASS.SOCIAL,
    gate: "W4",
    params: { keyword: { type: "string", min: 1, max: 50 }, count: { type: "integer", min: 1, max: 20, default: 1 } },
    stopConditions: ["target not unique", "already-true verified skip", "mission budget exceeded"],
  }),
  follow: Object.freeze({
    id: "follow",
    backend: "capability",
    capabilityId: "xhs.follow.ensure",
    effectClass: EFFECT_CLASS.SOCIAL,
    gate: "W4",
    params: { keyword: { type: "string", min: 1, max: 50 }, count: { type: "integer", min: 1, max: 20, default: 1 } },
    stopConditions: ["target not unique", "already-following skip", "mission budget exceeded"],
  }),
  nurture: Object.freeze({
    id: "nurture",
    backend: "composed",
    effectClass: EFFECT_CLASS.SOCIAL,
    gate: "W4",
    params: { minutes: { type: "integer", min: 1, max: 60, default: 20 }, likes: { type: "integer", min: 0, max: 20, default: 0 }, collects: { type: "integer", min: 0, max: 20, default: 0 }, follows: { type: "integer", min: 0, max: 20, default: 0 } },
    stopConditions: ["any effect without explicit count", "target not unique", "mission budget exceeded"],
  }),
  comment: Object.freeze({
    id: "comment",
    backend: "capability",
    capabilityId: "xhs.comment.bound_send",
    effectClass: EFFECT_CLASS.SOCIAL,
    gate: "W5",
    params: { keyword: { type: "string", required: true, min: 1, max: 50 }, text: { type: "string", required: true, min: 1, max: 2000 }, count: { type: "integer", min: 1, max: 1, default: 1 } },
    stopConditions: ["note not unique", "text hash already sent", "send result ambiguous -> no blind retry"],
  }),
  reply: Object.freeze({
    id: "reply",
    backend: "capability",
    capabilityId: "xhs.dm.bound_reply",
    effectClass: EFFECT_CLASS.SOCIAL,
    gate: "W5",
    params: { thread: { type: "string", required: true, min: 1, max: 200 }, text: { type: "string", required: true, min: 1, max: 2000 } },
    stopConditions: ["thread not unique", "username contains/maybe", "last-message fingerprint drifted", "body hash already sent"],
  }),
  "publish prepare": Object.freeze({
    id: "publish prepare",
    backend: "capability",
    capabilityId: "xhs.publish.edit_dry_run",
    effectClass: EFFECT_CLASS.NONE,
    gate: "W6",
    params: { title: { type: "string", required: true, min: 1, max: 100 }, body: { type: "string", required: true, min: 1, max: 10000 }, tags: { type: "array", max: 20 }, images: { type: "array", max: 9 } },
    stopConditions: ["publish button tapped", "content drift after freeze"],
  }),
  "publish send": Object.freeze({
    id: "publish send",
    backend: "capability",
    capabilityId: "xhs.publish.commit", // protected capability, W6
    effectClass: EFFECT_CLASS.PUBLISH,
    gate: "W6",
    params: { run: { type: "string", required: true, min: 1, max: 200 } },
    stopConditions: ["envelope expired", "content/screenshot/device/account drift", "live handle lost after restart", "ambiguous -> no retry"],
  }),
});

const BY_ALIAS = Object.freeze((() => {
  const m = {};
  for (const a of Object.values(XHS_ACTION_CATALOG)) {
    m[a.id] = a;
    for (const alias of a.aliases || []) m[alias] = a;
  }
  return m;
})());

export function resolveAction(name) {
  if (typeof name !== "string") return null;
  const key = name.trim();
  if (!key) return null;
  // allow "publish prepare" / "publish send" as two-word ids
  return BY_ALIAS[key] || null;
}

export function listActions() {
  return Object.values(XHS_ACTION_CATALOG).map((a) => ({
    id: a.id,
    backend: a.backend,
    effectClass: a.effectClass,
    recipeId: a.recipeId || null,
    capabilityId: a.capabilityId || null,
    gate: a.gate,
    aliases: a.aliases || null,
  }));
}

/**
 * Coerce + validate raw params against the action's param spec. Applies
 * defaults. Unknown keys are rejected (fail closed). Returns a frozen canonical
 * params object used for planHash determinism across all three entry surfaces.
 */
export function normalizeParams(action, raw = {}) {
  const out = {};
  const spec = action.params || {};
  for (const [key, rule] of Object.entries(spec)) {
    let v = raw[key];
    if (v === undefined || v === null) {
      if (rule.required) throw new PlanError("PARAMS_REQUIRED", `--${key} required for ${action.id}`);
      if (rule.default !== undefined) v = rule.default;
      else continue;
    }
    if (rule.type === "integer") {
      v = Number(v);
      if (!Number.isInteger(v)) throw new PlanError("PARAMS_INVALID", `--${key} must be integer`);
    } else if (rule.type === "string") {
      v = String(v);
    } else if (rule.type === "array") {
      if (!Array.isArray(v)) {
        if (typeof v === "string") v = String(v).split(/[,，]/).map((s) => s.trim()).filter(Boolean);
        else throw new PlanError("PARAMS_INVALID", `--${key} must be array`);
      } else {
        v = v.map(String);
      }
    }
    if (rule.type === "string" || rule.type === "integer") {
      if (rule.min !== undefined && v < rule.min) throw new PlanError("PARAMS_INVALID", `--${key} below minimum ${rule.min}`);
      if (rule.max !== undefined && v > rule.max) throw new PlanError("PARAMS_INVALID", `--${key} above maximum ${rule.max}`);
    }
    if (rule.type === "array" && rule.max !== undefined && v.length > rule.max) {
      throw new PlanError("PARAMS_INVALID", `--${key} exceeds max ${rule.max}`);
    }
    out[key] = v;
  }
  for (const key of Object.keys(raw)) {
    if (!(key in spec)) throw new PlanError("PARAMS_UNKNOWN", `unknown --${key} for ${action.id}`);
  }
  return Object.freeze(out);
}

export class PlanError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "PlanError";
  }
}

function sha256Hex(s) {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function canonicalJson(value) {
  return JSON.stringify(value, (_, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = v[k];
      return out;
    }
    return v;
  });
}

/**
 * The effect budget for an action — the strict Mission shape (plan V2 §5).
 * social actions get totalCount/perTargetCount=1; nurture gets one Mission
 * per explicit social count; none/publish-send handled separately.
 *
 * `targetFingerprint` is unknown at pure plan time (discovered during run),
 * so operationKey is deferred — returned as null until a target is bound.
 */
export function effectBudget(action, params) {
  if (action.effectClass === EFFECT_CLASS.NONE) {
    return Object.freeze({ effectClass: "none", missions: [], operationKeyDeferred: true });
  }
  if (action.effectClass === EFFECT_CLASS.PUBLISH) {
    return Object.freeze({
      effectClass: "publish",
      missions: [Object.freeze({ action: "publish_commit", totalCount: 1, perTargetCount: 1, protectedCommit: true })],
      operationKeyDeferred: true,
    });
  }
  // social
  const missions = [];
  if (action.id === "nurture") {
    for (const [act, cap] of [["like", "xhs.like.ensure"], ["collect", "xhs.collect.ensure"], ["follow", "xhs.follow.ensure"]]) {
      const n = params[`${act}s`] || 0;
      if (Number.isInteger(n) && n > 0) {
        missions.push(Object.freeze({ action: act, capabilityId: cap, totalCount: n, perTargetCount: 1 }));
      }
    }
    return Object.freeze({ effectClass: "social", missions: Object.freeze(missions), operationKeyDeferred: true });
  }
  const count = Number.isInteger(params.count) ? params.count : 1;
  const payloadKeys = action.id === "comment" ? ["text"] : action.id === "reply" ? ["text", "thread"] : [];
  const payloadHash = payloadKeys.length
    ? sha256Hex(payloadKeys.map((k) => String(params[k] ?? "")).join("\0"))
    : null;
  missions.push(Object.freeze({
    action: action.id,
    capabilityId: action.capabilityId,
    totalCount: count,
    perTargetCount: 1,
    payloadHash,
  }));
  return Object.freeze({ effectClass: "social", missions: Object.freeze(missions), operationKeyDeferred: true });
}

/**
 * operationKey = sha256(actionRunId + action + targetFingerprint + payloadHash).
 * Deferred until a target fingerprint is discovered during the run. This helper
 * binds a discovered target to a plan to produce the durable operationKey used
 * for replay/idempotency (plan V2 §5.6).
 */
export function bindOperationKey({ actionRunId, action, targetFingerprint, payloadHash = null }) {
  if (!actionRunId || !action || !targetFingerprint) {
    throw new PlanError("OPERATION_KEY_INCOMPLETE", "actionRunId/action/targetFingerprint required");
  }
  return sha256Hex([actionRunId, action, targetFingerprint, payloadHash || ""].join("\0"));
}

/**
 * Adaptive route hint for the dispatcher decision ladder (plan V2 §3).
 * Resolved live from dump/vision; the plan records the preferred first attempt.
 *   fixed_recipe action  -> RECIPE
 *   r0_workflow / composed -> DUMP (vision on dump failure)
 */
export function adaptiveRouteHint(action) {
  if (action.backend === "fixed_recipe") return "RECIPE";
  if (action.backend === "r0_workflow" || action.backend === "composed") return "DUMP";
  if (action.backend === "capability") return "CAPABILITY";
  return "STOP";
}

/**
 * Plan an action. Pure + deterministic: identical (action, params, alias) always
 * yields the same planHash across all three entry surfaces. Rejects non-04
 * aliases at plan stage (XHS_ALIAS_NOT_04) — before any I/O.
 *
 * @param {object} input
 * @param {string} input.actionId - e.g. "search", "publish prepare", "messages"
 * @param {object} [input.params] - raw params
 * @param {string} [input.alias] - requested alias; defaults to 04, non-04 rejected
 * @param {string} [input.actor] - actor id
 * @param {string} [input.goalSignature] - NL goal signature (compose surface)
 * @returns {object} frozen action plan
 */
export function planAction({ actionId, params = {}, alias = FORCED_ALIAS, actor = null, goalSignature = null, recipeRevisions = {} } = {}) {
  const action = resolveAction(actionId);
  if (!action) throw new PlanError("ACTION_UNKNOWN", `unknown xhs action: ${actionId}`);

  // 04-only enforcement at plan stage — the pre-lease proof (plan V2 §2.1/§8).
  const requestedAlias = String(alias || FORCED_ALIAS).trim();
  if (requestedAlias !== FORCED_ALIAS) {
    throw new PlanError("XHS_ALIAS_NOT_04", `alias ${requestedAlias} rejected: 04-only pilot; 01-03 produce zero job/lease/I/O`);
  }

  const normParams = normalizeParams(action, params);
  const budget = effectBudget(action, normParams);
  const recipeRevision =
    action.backend === "fixed_recipe" ? resolveRecipeRevision(action.recipeId, recipeRevisions) : null;

  const planBody = {
    schemaId: DISPATCHER_SCHEMA_ID,
    schemaVersion: DISPATCHER_SCHEMA_VERSION,
    action: action.id,
    alias: FORCED_ALIAS,
    perDeviceConcurrency: PER_DEVICE_CONCURRENCY,
    backend: action.backend,
    recipeId: action.recipeId || null,
    recipeRevision, // null for non-fixed_recipe; bound into planHash (§11)
    capabilityId: action.capabilityId || null,
    effectClass: action.effectClass,
    gate: action.gate,
    adaptiveRoute: adaptiveRouteHint(action),
    params: normParams,
    budget,
    stopConditions: action.stopConditions,
    actor,
    goalSignature,
  };
  const planHash = sha256Hex(canonicalJson(planBody));
  const actionRunId = `ar_${planHash.slice(0, 16)}`;

  return Object.freeze({
    ok: true,
    mode: "plan",
    executionReady: false, // W0: all actions plan-only; --execute gated per action.gate
    actionRunId,
    planHash,
    ...planBody,
  });
}

/**
 * S0 execution truth (plan V2 §3.4/§6.6/§10.2): a live-gate pass alone is NEVER
 * execute success. The pre-S0 `--execute` printed `{ok:true, plan, gate}` when
 * the gate was open without any device execution — the fake-execution gap.
 *
 * `--execute` may only report ok:true when a Control-Plane-authoritative
 * terminal receipt is present and bound to the same planHash:
 *   { schemaId, runId, planHash, status, transport:{count}, cleanup }
 * Until the routine executor is wired into the CLI (S1), every --execute fails
 * closed with XHS_EXECUTE_NOT_WIRED even when the action's live gate is open.
 */
export const EXECUTE_RECEIPT_SCHEMA_ID = "xw.xhs.execute-receipt.v1";

export const EXECUTE_TERMINAL_STATUSES = Object.freeze([
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "BLOCKED",
]);

/**
 * Validate a candidate execute receipt against the authoritative shape.
 * Returns { ok, reason } — rejects the gate-only fake-success shape.
 */
export function isAuthoritativeExecuteReceipt(receipt, planHash = null) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    return { ok: false, reason: "receipt_missing" };
  }
  if (receipt.schemaId !== EXECUTE_RECEIPT_SCHEMA_ID) {
    return { ok: false, reason: "receipt_schema" };
  }
  if (typeof receipt.runId !== "string" || !receipt.runId.trim()) {
    return { ok: false, reason: "receipt_runId" };
  }
  if (planHash != null && receipt.planHash !== planHash) {
    return { ok: false, reason: "receipt_planHash_mismatch" };
  }
  if (!EXECUTE_TERMINAL_STATUSES.includes(receipt.status)) {
    return { ok: false, reason: "receipt_not_terminal" };
  }
  const transport = receipt.transport;
  if (!transport || typeof transport !== "object" || Array.isArray(transport)) {
    return { ok: false, reason: "receipt_transport" };
  }
  if (!Number.isInteger(transport.count) || transport.count < 0) {
    return { ok: false, reason: "receipt_transport_count" };
  }
  return { ok: true };
}

/**
 * Resolve the --execute outcome for a plan given live gates and an (optional)
 * authoritative executor receipt. Pure + deterministic.
 *   gate closed                        -> ACTION_GATED (fail-closed, unchanged)
 *   gate open, receipt missing/invalid -> XHS_EXECUTE_NOT_WIRED (S0 truth fix)
 *   gate open, authoritative receipt   -> ok with the receipt echoed
 */
export function resolveExecuteOutcome(plan, liveGates = {}, receipt = null) {
  const gate = evaluateExecuteGate(plan, liveGates);
  if (!gate.ok) {
    return { ok: false, code: "ACTION_GATED", reason: gate.reason };
  }
  const v = isAuthoritativeExecuteReceipt(receipt, plan ? plan.planHash : null);
  if (!v.ok) {
    return {
      ok: false,
      code: "XHS_EXECUTE_NOT_WIRED",
      reason: v.reason,
      message:
        "gate status alone is not execution evidence; --execute succeeds only with a CP-authoritative terminal receipt (runId + transport + terminal status) bound to the same planHash",
    };
  }
  return { ok: true, receipt };
}

/**
 * Decide whether --execute may proceed for an action in the current wave.
 * W0: every action fails closed with its gate reason. Later waves flip their
 * action's gate to live after canary promotion. This is the single switch the
 * dispatcher alias/version map toggles (plan V2 §11 rollback boundary).
 *
 * @param {object} plan - output of planAction
 * @param {object} [liveGates] - map of actionId -> boolean (promoted to live)
 * @returns {{ ok: boolean, reason?: string }}
 */
export function evaluateExecuteGate(plan, liveGates = {}) {
  if (!plan || plan.ok !== true) return { ok: false, reason: "plan_invalid" };
  if (liveGates[plan.action] === true) return { ok: true };
  return { ok: false, reason: `action_gated:${plan.gate || "unknown"}` };
}