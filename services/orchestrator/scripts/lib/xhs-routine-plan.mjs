/**
 * xhs-routine-plan.mjs — the sealed routine plan catalog for the 04-only
 * deterministic XHS feed routine machine (direct-routine plan V2 §1/§4/§7).
 *
 * Pure module: no fs, no network, no device I/O. The CLI is
 * ops/xw-xhs-routine.mjs; the state machine lib is xhs-feed-routine-machine.mjs.
 *
 * Invariants (plan V2 §2):
 *   - 04-only. alias 01/02/03 rejected at plan stage (ROUTINE_ALIAS_NOT_04)
 *     before any job/lease/session/device I/O. 04 busy never falls back.
 *   - No publish/DM/follow/collect/payment/delete/account-setting entry exists
 *     in this catalog at all — there is nothing to mis-call.
 *   - comment.max schema cap is fixed at 2 (ROUTINE_COMMENT_MAX_EXCEEDED above
 *     that); like.max cap is fixed at 1. Caps are upper bounds, not quotas.
 *   - Deterministic seeded sampling: seed + selection results enter the
 *     receipt for replay; randomness is never used to evade platform limits.
 *   - Three call surfaces (routine CLI flags, sealed JSON plan, /xw xhs
 *     routine <template>) converge on the same canonical planHash and the
 *     same executor. No second business script set.
 */
import { createHash } from "node:crypto";

export const ROUTINE_SCHEMA_ID = "xw.xhs.routine-plan.v1";
export const ROUTINE_SCHEMA_VERSION = 1;
export const ROUTINE_ALIAS = "04";
export const ROUTINE_PER_DEVICE_CONCURRENCY = 1;

/** comment.max is schema-fixed at 2 for the whole program (plan V2 §2/§7). */
export const COMMENT_MAX_CAP = 2;
/** like.max is schema-fixed at 1 ("偶尔点赞是上限而非补量"). */
export const LIKE_MAX_CAP = 1;

/**
 * Routine template catalog (plan V2 §4). Templates are the only entry points;
 * "组合脚本" is a sealed JSON orchestration of these primitives, never new code.
 *
 * `effectClass` drives which waves may run which template live:
 *   none   — S1 (feed-play, scout), zero external effects
 *   social — S2/S3 (nurture-lite, nurture-grounded), hard-bounded effects
 */
export const ROUTINE_TEMPLATE_CATALOG = Object.freeze({
  "xhs.scout.home.v1": Object.freeze({
    id: "xhs.scout.home.v1",
    effectClass: "none",
    behavior: "read-only exploration of known feed/detail/comments surfaces; collect fingerprint/locator/corpus",
    externalEffects: 0,
    params: {
      items: { type: "integer", min: 1, max: 30, default: 5 },
      seed: { type: "string", min: 1, max: 64, default: "daily" },
    },
    stopConditions: ["surface not recognized -> STOP", "dump ambiguous -> skip/STOP", "package drift"],
  }),
  "xhs.feed-play.v1": Object.freeze({
    id: "xhs.feed-play.v1",
    effectClass: "none",
    behavior: "refresh, pick card, open, dwell, optional bounded comment read on image notes, back-verify, loop",
    externalEffects: 0,
    params: {
      items: { type: "integer", min: 1, max: 30, default: 8 },
      prefer: { type: "enum", values: ["any", "note", "video"], default: "any" },
      dwell: { type: "dwellSeconds", min: 2, max: 60, default: "5:12" },
      commentScreens: { type: "integer", min: 0, max: 3, default: 1 },
      seed: { type: "string", min: 1, max: 64, default: "daily" },
    },
    stopConditions: [
      "each item opened at most once",
      "video main surface comment swipe = 0",
      "dwell bounded by plan range",
      "back must semantically confirm feed",
      "surface not recognized -> skip/STOP",
      "package drift",
    ],
  }),
  "xhs.nurture-lite.v1": Object.freeze({
    id: "xhs.nurture-lite.v1",
    effectClass: "social",
    behavior: "feed-play + bounded occasional like (like-max is a cap, not a quota)",
    externalEffects: { like: "<= likeMax" },
    params: {
      items: { type: "integer", min: 1, max: 30, default: 8 },
      prefer: { type: "enum", values: ["any", "note", "video"], default: "any" },
      dwell: { type: "dwellSeconds", min: 2, max: 60, default: "5:12" },
      commentScreens: { type: "integer", min: 0, max: 3, default: 1 },
      likeMax: { type: "integer", min: 0, max: LIKE_MAX_CAP, default: 1 },
      seed: { type: "string", min: 1, max: 64, default: "daily" },
    },
    stopConditions: [
      "like <= likeMax (hard, cap not quota)",
      "like state not provably unliked -> zero transport",
      "ambiguous -> slot consumed, no retry",
      "video main surface comment swipe = 0",
      "surface not recognized -> skip/STOP",
      "package drift",
    ],
  }),
  "xhs.nurture-grounded.v1": Object.freeze({
    id: "xhs.nurture-grounded.v1",
    effectClass: "social",
    behavior: "nurture-lite + observation-bound grounded LLM draft + bounded comment (schema cap 2)",
    externalEffects: { like: "<= likeMax", comment: "<= 2" },
    params: {
      items: { type: "integer", min: 1, max: 30, default: 8 },
      prefer: { type: "enum", values: ["any", "note", "video"], default: "any" },
      dwell: { type: "dwellSeconds", min: 2, max: 60, default: "5:12" },
      commentScreens: { type: "integer", min: 0, max: 3, default: 1 },
      likeMax: { type: "integer", min: 0, max: LIKE_MAX_CAP, default: 1 },
      commentMax: { type: "integer", min: 0, max: COMMENT_MAX_CAP, default: 2 },
      llm: { type: "enum", values: ["grounded"], default: "grounded" },
      seed: { type: "string", min: 1, max: 64, default: "daily" },
    },
    stopConditions: [
      "comment <= commentMax <= 2 (hard)",
      "draft without sealed receipt / expired TTL / state drift -> no send",
      "ambiguous comment closes remaining comments this run",
      "no fabricated first-person experience",
      "like state not provably unliked -> zero transport",
      "surface not recognized -> skip/STOP",
      "package drift",
    ],
  }),
});

const BY_TEMPLATE = new Map(Object.entries(ROUTINE_TEMPLATE_CATALOG));

export class RoutinePlanError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "RoutinePlanError";
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
 * Parse a dwell param like "5:12" into { min, max } seconds.
 * Bounds are inclusive; min <= max; both within [planMin, planMax].
 */
export function parseDwellSeconds(raw, { min: capMin, max: capMax }) {
  // already-normalized sealed form {min,max} — validate and re-freeze
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const { min, max } = raw;
    if (!Number.isInteger(min) || !Number.isInteger(max) || min > max) {
      throw new RoutinePlanError("ROUTINE_DWELL_INVALID", `--dwell object must be {min<=max} integer seconds`);
    }
    if (min < capMin) throw new RoutinePlanError("ROUTINE_DWELL_INVALID", `--dwell min below minimum ${capMin}s (live acceptance floor)`);
    if (max > capMax) throw new RoutinePlanError("ROUTINE_DWELL_INVALID", `--dwell max above maximum ${capMax}s`);
    return Object.freeze({ min, max });
  }
  const s = String(raw ?? "").trim();
  const m = /^(\d+):(\d+)$/.exec(s);
  if (!m) throw new RoutinePlanError("ROUTINE_DWELL_INVALID", `--dwell must be "<min>:<max>" seconds, got ${JSON.stringify(raw)}`);
  const min = Number(m[1]);
  const max = Number(m[2]);
  if (min > max) throw new RoutinePlanError("ROUTINE_DWELL_INVALID", `--dwell min ${min} > max ${max}`);
  if (min < capMin) throw new RoutinePlanError("ROUTINE_DWELL_INVALID", `--dwell min below minimum ${capMin}s (live acceptance floor)`);
  if (max > capMax) throw new RoutinePlanError("ROUTINE_DWELL_INVALID", `--dwell max above maximum ${capMax}s`);
  return Object.freeze({ min, max });
}

/** Seed -> deterministic 32-bit RNG state (sha256, stable across processes). */
export function seedToRngState(seed) {
  return Number.parseInt(sha256Hex(String(seed)).slice(0, 8), 16) >>> 0;
}

function normalizeEnum(value, rule, key) {
  const v = String(value ?? "").trim();
  if (!rule.values.includes(v)) {
    throw new RoutinePlanError("ROUTINE_PARAM_INVALID", `--${key} must be one of ${rule.values.join("|")}`);
  }
  return v;
}

function normalizeInteger(value, rule, key, code) {
  const v = Number(value);
  if (!Number.isInteger(v)) throw new RoutinePlanError(code, `--${key} must be integer`);
  if (rule.min !== undefined && v < rule.min) throw new RoutinePlanError(code, `--${key} below minimum ${rule.min}`);
  if (rule.max !== undefined && v > rule.max) throw new RoutinePlanError(code, `--${key} above maximum ${rule.max}`);
  return v;
}

/**
 * Coerce + validate raw params against a template's param spec. Unknown keys
 * are rejected fail-closed. Publish/DM/follow/collect/payment intents have no
 * param and no template — they cannot be expressed, only invented, and an
 * invented template name is rejected with TEMPLATE_UNKNOWN before any I/O.
 */
export function normalizeRoutineParams(template, raw = {}) {
  const out = {};
  const spec = template.params || {};
  for (const [key, rule] of Object.entries(spec)) {
    let v = raw[key];
    if (v === undefined || v === null) {
      if (rule.default !== undefined) v = rule.default;
      else continue;
    }
    if (rule.type === "integer") {
      v = normalizeInteger(v, rule, key, "ROUTINE_PARAM_INVALID");
    } else if (rule.type === "string") {
      v = String(v);
      if (rule.min !== undefined && v.length < rule.min) throw new RoutinePlanError("ROUTINE_PARAM_INVALID", `--${key} below min length`);
      if (rule.max !== undefined && v.length > rule.max) throw new RoutinePlanError("ROUTINE_PARAM_INVALID", `--${key} above max length`);
    } else if (rule.type === "enum") {
      v = normalizeEnum(v, rule, key);
    } else if (rule.type === "dwellSeconds") {
      v = parseDwellSeconds(v, rule);
    }
    out[key] = v;
  }
  for (const key of Object.keys(raw)) {
    if (!(key in spec)) throw new RoutinePlanError("ROUTINE_PARAM_UNKNOWN", `unknown --${key} for ${template.id}`);
  }
  return Object.freeze(out);
}

function canonicalPlanBody({ template, alias, params, stopConditions, effectClass }) {
  return {
    schemaId: ROUTINE_SCHEMA_ID,
    schemaVersion: ROUTINE_SCHEMA_VERSION,
    template,
    alias,
    perDeviceConcurrency: ROUTINE_PER_DEVICE_CONCURRENCY,
    effectClass,
    params,
    stopConditions,
  };
}

/**
 * Plan a routine run. Pure + deterministic: identical (template, params, alias)
 * always yields the same planHash across all call surfaces.
 */
export function planRoutine({ templateId, params = {}, alias = ROUTINE_ALIAS, actor = null, goalSignature = null } = {}) {
  const template = BY_TEMPLATE.get(String(templateId || ""));
  if (!template) {
    throw new RoutinePlanError("ROUTINE_TEMPLATE_UNKNOWN", `unknown xhs routine template: ${templateId}`);
  }
  const requestedAlias = String(alias || ROUTINE_ALIAS).trim();
  if (requestedAlias !== ROUTINE_ALIAS) {
    throw new RoutinePlanError("ROUTINE_ALIAS_NOT_04", `alias ${requestedAlias} rejected: 04-only routine; 01-03 produce zero job/lease/I/O and 04 busy never falls back`);
  }
  const normParams = normalizeRoutineParams(template, params);

  // actor/goalSignature are provenance, not execution semantics — they stay on
  // the plan for audit but never change the planHash, so the three call
  // surfaces converge on the same hash for the same semantic plan.
  const planBody = canonicalPlanBody({
    template: template.id,
    alias: ROUTINE_ALIAS,
    params: normParams,
    stopConditions: template.stopConditions,
    effectClass: template.effectClass,
  });
  const planHash = sha256Hex(canonicalJson(planBody));
  const routineRunId = `rr_${planHash.slice(0, 16)}`;

  return Object.freeze({
    ok: true,
    mode: "plan",
    executionReady: false,
    routineRunId,
    planHash,
    ...planBody,
    actor,
    goalSignature,
    templateSpec: template,
  });
}

/**
 * Validate a sealed JSON routine plan (machine entry). The submitted plan must
 * carry the exact canonical planHash — any tampering with template/params/
 * alias is rejected before observation. Returns the frozen plan.
 */
export function acceptSealedRoutinePlan(submitted) {
  if (!submitted || typeof submitted !== "object" || Array.isArray(submitted)) {
    throw new RoutinePlanError("ROUTINE_PLAN_INVALID", "submitted plan must be an object");
  }
  const { templateSpec: _t, ...rest } = submitted;
  if (submitted.schemaId !== ROUTINE_SCHEMA_ID || submitted.schemaVersion !== ROUTINE_SCHEMA_VERSION) {
    throw new RoutinePlanError("ROUTINE_PLAN_SCHEMA", "submitted plan schema mismatch");
  }
  const { routineRunId, planHash, templateSpec, ...body } = submitted;
  if (!/^[a-f0-9]{64}$/.test(planHash || "")) throw new RoutinePlanError("ROUTINE_PLAN_HASH", "planHash missing/malformed");
  if (templateSpec !== undefined) throw new RoutinePlanError("ROUTINE_PLAN_SEALED", "templateSpec must not be submitted (server-sealed only)");
  // verify the seal over the submitted canonical body BEFORE re-planning — a
  // tampered alias/param/template must report TAMPERED, not the underlying
  // validation error it would trigger downstream
  const recomputedHash = sha256Hex(canonicalJson(canonicalPlanBody({
    template: body.template,
    alias: body.alias,
    params: body.params,
    stopConditions: body.stopConditions,
    effectClass: body.effectClass,
  })));
  if (recomputedHash !== planHash) {
    throw new RoutinePlanError("ROUTINE_PLAN_TAMPERED", "planHash does not match canonical plan content — reject before I/O");
  }
  const replanned = planRoutine({ templateId: body.template, params: body.params, alias: body.alias, actor: body.actor, goalSignature: body.goalSignature });
  if (replanned.planHash !== planHash) {
    throw new RoutinePlanError("ROUTINE_PLAN_TAMPERED", "planHash does not match canonical plan content — reject before I/O");
  }
  if (replanned.routineRunId !== routineRunId) {
    throw new RoutinePlanError("ROUTINE_PLAN_TAMPERED", "routineRunId does not match planHash");
  }
  return replanned;
}

/**
 * The three call surfaces compile to the same planHash. Surface 3 (compose/
 * natural language) maps goal keywords to a template + params; it never
 * invents quantities the user did not state.
 */
export function resolveRoutineTemplateFromGoal(goal) {
  const text = String(goal || "");
  if (/只读|scout|探索|采集|fingerprint|语料/i.test(text)) return "xhs.scout.home.v1";
  if (/(grounded|评论).*(养号|互动)|养号.*(grounded|评论)|nurture-grounded/i.test(text)) return "xhs.nurture-grounded.v1";
  if (/养号|nurture/i.test(text)) return "xhs.nurture-lite.v1";
  if (/刷|浏览|feed|feed-play|逛/i.test(text)) return "xhs.feed-play.v1";
  return null;
}

export function listRoutineTemplates() {
  return Object.values(ROUTINE_TEMPLATE_CATALOG).map((t) => ({
    id: t.id,
    effectClass: t.effectClass,
    behavior: t.behavior,
    externalEffects: t.externalEffects,
    params: t.params,
  }));
}