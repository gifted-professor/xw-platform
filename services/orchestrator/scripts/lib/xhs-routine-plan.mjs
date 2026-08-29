/**
 * xhs-routine-plan.mjs — sealed routine plans for the deterministic XHS feed
 * routine machine. Placement policy v1 is 03-first: a normal run is exactly
 * one 03 child; 04 exists only as the second child of an explicitly requested
 * read-only parallel=2 batch.
 *
 * Pure module: no fs, no network, no device I/O. The CLI is
 * ops/xw-xhs-routine.mjs; the state machine lib is xhs-feed-routine-machine.mjs.
 *
 * Invariants (plan V2 §2):
 *   - single/default -> 03 only. 01/02 are rejected. 04 never receives a
 *     single run and is never an automatic fallback for a busy/offline 03.
 *   - explicit parallel=2 -> exact [03,04], read-only effectClass=none only.
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
import { createHash, randomUUID } from "node:crypto";
import { validateSealedMission } from "./xhs-exploration-mission.mjs";

export const ROUTINE_SCHEMA_ID = "xw.xhs.routine-plan.v1";
export const ROUTINE_SCHEMA_VERSION = 2;
export const ROUTINE_PLACEMENT_POLICY_ID = "xw.xhs.placement.03-first.v1";
export const ROUTINE_PLACEMENT_POLICY_VERSION = 1;
export const ROUTINE_PRIMARY_ALIAS = "03";
export const ROUTINE_SECONDARY_ALIAS = "04";
/** Backward-compatible name: now means the default/primary alias. */
export const ROUTINE_ALIAS = ROUTINE_PRIMARY_ALIAS;
export const ROUTINE_PER_DEVICE_CONCURRENCY = 1;
export const ROUTINE_MAX_PARALLEL = 2;

export const ROUTINE_PLACEMENT_POLICY = Object.freeze({
  id: ROUTINE_PLACEMENT_POLICY_ID,
  version: ROUTINE_PLACEMENT_POLICY_VERSION,
  primaryAlias: ROUTINE_PRIMARY_ALIAS,
  secondaryAlias: ROUTINE_SECONDARY_ALIAS,
  defaultParallel: 1,
  maxParallel: ROUTINE_MAX_PARALLEL,
  secondaryRequiresExplicitConcurrency: true,
  automaticFallback: false,
  allowedAliases: Object.freeze([ROUTINE_PRIMARY_ALIAS, ROUTINE_SECONDARY_ALIAS]),
});

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
  "xhs.explore.goal.v1": Object.freeze({
    id: "xhs.explore.goal.v1",
    effectClass: "none",
    behavior: "goal-driven read-only free exploration; nested xw.xhs.exploration-mission.v1; exact [03=feed_lane,04=search_lane]",
    externalEffects: 0,
    params: {},
    stopConditions: [
      "externalEffects=0; every forbidden action hard-blocked (V3-I01)",
      "every interactive primitive via single-use CP navigation permit (V3-I02)",
      "budget/deadline/no-novelty stop is a cap, never a quota",
      "lane failure -> peer safe checkpoint + all-settled shielded cleanup (V3-I08)",
      "package drift",
    ],
  }),
});

const BY_TEMPLATE = new Map(Object.entries(ROUTINE_TEMPLATE_CATALOG));

/** Templates that carry a nested sealed exploration mission (V3 §3.2). */
const MISSION_TEMPLATES = new Set(["xhs.explore.goal.v1"]);

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

function canonicalPlanBody({ template, alias, parallel, placement, children, params, stopConditions, effectClass, mission = null }) {
  const body = {
    schemaId: ROUTINE_SCHEMA_ID,
    schemaVersion: ROUTINE_SCHEMA_VERSION,
    template,
    alias,
    parallel,
    placement,
    children,
    perDeviceConcurrency: ROUTINE_PER_DEVICE_CONCURRENCY,
    effectClass,
    params,
    stopConditions,
  };
  // V3 (§5.1): the nested mission enters the canonical plan body ONLY when
  // present — legacy V2 plan bytes stay identical when the field is absent.
  if (mission && MISSION_TEMPLATES.has(template)) body.mission = mission;
  return body;
}

function normalizeParallel(raw) {
  const text = String(raw ?? 1).trim();
  if (!/^[12]$/.test(text)) {
    throw new RoutinePlanError(
      "ROUTINE_PARALLEL_INVALID",
      `--parallel must be 1 or 2; got ${JSON.stringify(raw)}`,
    );
  }
  return Number(text);
}

function placementFor({ requestedAlias, parallel, effectClass, templateId = null }) {
  if (![ROUTINE_PRIMARY_ALIAS, ROUTINE_SECONDARY_ALIAS].includes(requestedAlias)) {
    throw new RoutinePlanError(
      "ROUTINE_ALIAS_NOT_ALLOWED",
      `alias ${requestedAlias} rejected: placement policy permits only 03, plus 04 as an explicit parallel=2 secondary; 01/02 produce zero job/lease/I/O`,
    );
  }

  // V3 (§3.2/§5.1): the exploration mission fixes exact [03=feed_lane,04=search_lane].
  // Alias 01/02, alias 04 alone, role changes, work stealing and single-lane
  // fallback are all whole-plan rejections.
  if (MISSION_TEMPLATES.has(templateId)) {
    if (parallel !== 2) {
      throw new RoutinePlanError(
        "ROUTINE_PARALLEL_PLAN_REQUIRED",
        "xhs.explore.goal.v1 is exactly-parallel-2 [03,04] by mission contract; no single-lane or downgraded execution",
      );
    }
    if (effectClass !== "none") {
      throw new RoutinePlanError("ROUTINE_SECONDARY_EFFECT_CLASS_FORBIDDEN", "exploration missions are read-only only");
    }
    const placement = Object.freeze({
      policyId: ROUTINE_PLACEMENT_POLICY_ID,
      policyVersion: ROUTINE_PLACEMENT_POLICY_VERSION,
      mode: "exploration_mission",
      primaryAlias: ROUTINE_PRIMARY_ALIAS,
      aliases: Object.freeze([ROUTINE_PRIMARY_ALIAS, ROUTINE_SECONDARY_ALIAS]),
      parallel: 2,
      automaticFallback: false,
    });
    const children = Object.freeze([
      Object.freeze({ index: 0, alias: ROUTINE_PRIMARY_ALIAS, role: "feed_lane", effectClass, externalEffects: 0 }),
      Object.freeze({ index: 1, alias: ROUTINE_SECONDARY_ALIAS, role: "search_lane", effectClass, externalEffects: 0 }),
    ]);
    return Object.freeze({ placement, children });
  }

  if (parallel === 1 && requestedAlias === ROUTINE_SECONDARY_ALIAS) {
    throw new RoutinePlanError(
      "ROUTINE_SECONDARY_REQUIRES_EXPLICIT_CONCURRENCY",
      "alias 04 cannot run alone or as fallback; request --parallel 2 to create the exact read-only [03,04] batch",
    );
  }

  if (parallel === 2 && effectClass !== "none") {
    throw new RoutinePlanError(
      "ROUTINE_SECONDARY_EFFECT_CLASS_FORBIDDEN",
      "parallel [03,04] is read-only only: alias 04 cannot receive a social-effect child",
    );
  }

  const aliases = parallel === 2
    ? [ROUTINE_PRIMARY_ALIAS, ROUTINE_SECONDARY_ALIAS]
    : [ROUTINE_PRIMARY_ALIAS];
  const mode = parallel === 2 ? "explicit_concurrency" : "single_primary";
  const placement = Object.freeze({
    policyId: ROUTINE_PLACEMENT_POLICY_ID,
    policyVersion: ROUTINE_PLACEMENT_POLICY_VERSION,
    mode,
    primaryAlias: ROUTINE_PRIMARY_ALIAS,
    aliases: Object.freeze([...aliases]),
    parallel,
    automaticFallback: false,
  });
  const children = Object.freeze(aliases.map((alias, index) => Object.freeze({
    index,
    alias,
    role: index === 0 ? "primary" : "concurrency_secondary",
    effectClass,
    externalEffects: effectClass === "none" ? 0 : "hard-budgeted-on-03",
  })));
  return Object.freeze({ placement, children });
}

function semanticHashOf(planLike) {
  return sha256Hex(canonicalJson(canonicalPlanBody({
    template: planLike.template,
    alias: planLike.planAlias ?? planLike.alias,
    parallel: planLike.parallel,
    placement: planLike.placement,
    children: planLike.children,
    params: planLike.params,
    stopConditions: planLike.stopConditions,
    effectClass: planLike.effectClass,
    mission: planLike.mission ?? null,
  })));
}

function freshIdToken(randomUUIDFn = randomUUID) {
  const raw = String(randomUUIDFn()).replaceAll("-", "").toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(raw)) {
    throw new RoutinePlanError("ROUTINE_EXECUTION_ID_INVALID", "random UUID source must return a UUID-compatible 128-bit hex value");
  }
  return raw;
}

const EXECUTION_RUN_ID_RE = /^xe_[a-f0-9]{32}$/;
const ROUTINE_RUN_ID_RE = /^rr_[a-f0-9]{32}$/;

/**
 * Allocate execution identity independently from semantic planning. A batch
 * shares executionRunId across its children and gives every child a unique
 * routineRunId. IDs are random UUID material and are never derived from the
 * deterministic planHash.
 */
export function createRoutineExecutionIdentity({ executionRunId = null, randomUUIDFn = randomUUID } = {}) {
  const token = freshIdToken(randomUUIDFn);
  const resolvedExecutionRunId = executionRunId || `xe_${token}`;
  if (!EXECUTION_RUN_ID_RE.test(resolvedExecutionRunId)) {
    throw new RoutinePlanError("ROUTINE_EXECUTION_ID_INVALID", "executionRunId must match xe_<32 lowercase hex>");
  }
  return Object.freeze({
    executionRunId: resolvedExecutionRunId,
    routineRunId: `rr_${token}`,
  });
}

function assertSemanticPlan(plan) {
  if (!plan || typeof plan !== "object" || plan.schemaId !== ROUTINE_SCHEMA_ID || plan.schemaVersion !== ROUTINE_SCHEMA_VERSION) {
    throw new RoutinePlanError("ROUTINE_PLAN_SCHEMA", "routine plan schema mismatch");
  }
  if (!/^[a-f0-9]{64}$/.test(plan.planHash || "") || semanticHashOf(plan) !== plan.planHash) {
    throw new RoutinePlanError("ROUTINE_PLAN_TAMPERED", "planHash does not match canonical plan content");
  }
  if (plan.perDeviceConcurrency !== ROUTINE_PER_DEVICE_CONCURRENCY) {
    throw new RoutinePlanError("ROUTINE_PLAN_TAMPERED", "perDeviceConcurrency differs from the sealed policy");
  }
  if (plan.planAlias !== undefined && plan.planAlias !== plan.placement?.primaryAlias) {
    throw new RoutinePlanError("ROUTINE_PLAN_TAMPERED", "execution planAlias does not match the sealed placement primary");
  }
}

function assertExecutionAlias(plan, alias) {
  const allowed = plan.placement?.aliases || [];
  if (!allowed.includes(alias)) {
    if (alias === ROUTINE_SECONDARY_ALIAS) {
      throw new RoutinePlanError(
        "ROUTINE_SECONDARY_REQUIRES_EXPLICIT_CONCURRENCY",
        "alias 04 is not present in this plan; only an explicit parallel=2 read-only plan can bind it",
      );
    }
    throw new RoutinePlanError("ROUTINE_EXECUTION_ALIAS_INVALID", `alias ${alias} is not an authorized child of this plan`);
  }
  if (alias === ROUTINE_SECONDARY_ALIAS && plan.effectClass !== "none") {
    throw new RoutinePlanError("ROUTINE_SECONDARY_EFFECT_CLASS_FORBIDDEN", "alias 04 execution child must be effectClass none");
  }
}

/** Bind one authorized plan child to a fresh or supplied execution identity. */
export function bindRoutineExecution(plan, { alias = plan?.alias, identity = null, randomUUIDFn = randomUUID } = {}) {
  assertSemanticPlan(plan);
  const resolvedAlias = String(alias || "").trim();
  assertExecutionAlias(plan, resolvedAlias);
  const ids = identity || createRoutineExecutionIdentity({ randomUUIDFn });
  if (!EXECUTION_RUN_ID_RE.test(ids.executionRunId || "") || !ROUTINE_RUN_ID_RE.test(ids.routineRunId || "")) {
    throw new RoutinePlanError("ROUTINE_EXECUTION_ID_INVALID", "execution identity is missing or malformed");
  }
  const bindingBody = {
    schemaId: ROUTINE_SCHEMA_ID,
    schemaVersion: ROUTINE_SCHEMA_VERSION,
    planHash: plan.planHash,
    alias: resolvedAlias,
    executionRunId: ids.executionRunId,
    routineRunId: ids.routineRunId,
  };
  const executionBindingHash = sha256Hex(canonicalJson(bindingBody));
  return Object.freeze({
    ...plan,
    mode: "execution",
    executionReady: true,
    planAlias: plan.planAlias ?? plan.alias,
    alias: resolvedAlias,
    executionRunId: ids.executionRunId,
    routineRunId: ids.routineRunId,
    executionBindingHash,
  });
}

/** Validate the explicit execution binding before a driver/session may use it. */
export function validateRoutineExecutionBinding(bound) {
  assertSemanticPlan(bound);
  if (bound.mode !== "execution" || bound.executionReady !== true) {
    throw new RoutinePlanError("ROUTINE_EXECUTION_NOT_BOUND", "plan-only document has no execution identity");
  }
  assertExecutionAlias(bound, String(bound.alias || ""));
  if (!EXECUTION_RUN_ID_RE.test(bound.executionRunId || "") || !ROUTINE_RUN_ID_RE.test(bound.routineRunId || "")) {
    throw new RoutinePlanError("ROUTINE_EXECUTION_ID_INVALID", "execution identity is missing or malformed");
  }
  const expected = sha256Hex(canonicalJson({
    schemaId: ROUTINE_SCHEMA_ID,
    schemaVersion: ROUTINE_SCHEMA_VERSION,
    planHash: bound.planHash,
    alias: bound.alias,
    executionRunId: bound.executionRunId,
    routineRunId: bound.routineRunId,
  }));
  if (expected !== bound.executionBindingHash) {
    throw new RoutinePlanError("ROUTINE_EXECUTION_BINDING_TAMPERED", "execution binding hash mismatch");
  }
  return bound;
}

/** Bind the exact [03,04] children of an explicit read-only parallel plan. */
export function bindRoutineExecutionBatch(plan, { randomUUIDFn = randomUUID } = {}) {
  assertSemanticPlan(plan);
  if (plan.parallel !== 2 || canonicalJson(plan.placement?.aliases) !== canonicalJson([ROUTINE_PRIMARY_ALIAS, ROUTINE_SECONDARY_ALIAS])) {
    throw new RoutinePlanError("ROUTINE_PARALLEL_PLAN_REQUIRED", "an exact explicit parallel=2 [03,04] plan is required");
  }
  if (plan.effectClass !== "none") {
    throw new RoutinePlanError("ROUTINE_SECONDARY_EFFECT_CLASS_FORBIDDEN", "parallel [03,04] batch must be effectClass none");
  }
  const primaryIdentity = createRoutineExecutionIdentity({ randomUUIDFn });
  const secondaryIdentity = createRoutineExecutionIdentity({
    executionRunId: primaryIdentity.executionRunId,
    randomUUIDFn,
  });
  const children = Object.freeze([
    bindRoutineExecution(plan, { alias: ROUTINE_PRIMARY_ALIAS, identity: primaryIdentity }),
    bindRoutineExecution(plan, { alias: ROUTINE_SECONDARY_ALIAS, identity: secondaryIdentity }),
  ]);
  return Object.freeze({
    ok: true,
    mode: "execution_batch",
    executionReady: true,
    planHash: plan.planHash,
    executionRunId: primaryIdentity.executionRunId,
    aliases: Object.freeze(children.map((child) => child.alias)),
    children,
  });
}

/**
 * Build the sealed exploration plan from a sealed mission (V3 §3.2). The
 * mission is re-validated fail-closed (unknown fields/tampered hash/caps)
 * and enters the canonical plan body as-is; raw goal/query text is never
 * part of the plan.
 */
export function planExplorationGoalRoutine({ mission, actor = null } = {}) {
  let sealed = mission;
  if (typeof sealed === "string" || sealed instanceof Buffer) {
    sealed = JSON.parse(String(sealed));
  }
  const validated = validateSealedMission(sealed);
  return planRoutine({
    templateId: validated.templateId,
    params: {},
    actor,
    goalSignature: null,
    mission: validated,
  });
}

/**
 * Plan a routine run. Pure + deterministic: identical semantic input always
 * yields the same planHash. No executionRunId/routineRunId is serialized here;
 * bindRoutineExecution() allocates those only when execution is actually
 * being prepared.
 */
export function planRoutine({
  templateId,
  params = {},
  alias = ROUTINE_ALIAS,
  parallel = 1,
  actor = null,
  goalSignature = null,
  mission = null,
} = {}) {
  const template = BY_TEMPLATE.get(String(templateId || ""));
  if (!template) {
    throw new RoutinePlanError("ROUTINE_TEMPLATE_UNKNOWN", `unknown xhs routine template: ${templateId}`);
  }
  const requestedAlias = String(alias || ROUTINE_ALIAS).trim();
  // V3 exploration missions fix parallel=2 [03,04]; any caller alias narrower
  // than the default is rejected (no alias 04 alone, no role changes)
  const effParallel = MISSION_TEMPLATES.has(template.id) ? 2 : normalizeParallel(parallel);
  if (MISSION_TEMPLATES.has(template.id) && requestedAlias !== ROUTINE_PRIMARY_ALIAS) {
    throw new RoutinePlanError(
      "ROUTINE_ALIAS_NOT_ALLOWED",
      `exploration missions fix lanes exactly [03=feed_lane,04=search_lane]; alias argument ${requestedAlias} rejected`,
    );
  }
  const effAlias = MISSION_TEMPLATES.has(template.id) ? ROUTINE_PRIMARY_ALIAS : requestedAlias;
  const normParams = normalizeRoutineParams(template, params);
  const { placement, children } = placementFor({
    requestedAlias: effAlias,
    parallel: effParallel,
    effectClass: template.effectClass,
    templateId: template.id,
  });

  // actor/goalSignature are provenance, not execution semantics — they stay on
  // the plan for audit but never change the planHash, so the three call
  // surfaces converge on the same hash for the same semantic plan. The V3
  // mission is the sealed authority source for exploration plans (plan V2
  // §3.2): its missionHash (not goalSignature) gates the CP authority.
  const planBody = canonicalPlanBody({
    template: template.id,
    alias: ROUTINE_PRIMARY_ALIAS,
    parallel: effParallel,
    placement,
    children,
    params: normParams,
    stopConditions: template.stopConditions,
    effectClass: template.effectClass,
    mission,
  });
  const planHash = sha256Hex(canonicalJson(planBody));
  const plan = {
    ok: true,
    mode: "plan",
    executionReady: false,
    planHash,
    ...planBody,
    actor,
    goalSignature,
    templateSpec: template,
  };

  // Transitional programmatic compatibility for the already-landed offline
  // machine/bridge fixtures: reading plan.routineRunId lazily allocates a
  // random, non-enumerable ID. It is never serialized, hashed or accepted as
  // part of a sealed plan. New production callers must bind explicitly.
  let legacyIdentity = null;
  Object.defineProperty(plan, "routineRunId", {
    enumerable: false,
    configurable: false,
    get() {
      legacyIdentity ||= createRoutineExecutionIdentity();
      return legacyIdentity.routineRunId;
    },
  });
  return Object.freeze(plan);
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
  if (submitted.schemaId !== ROUTINE_SCHEMA_ID || submitted.schemaVersion !== ROUTINE_SCHEMA_VERSION) {
    throw new RoutinePlanError("ROUTINE_PLAN_SCHEMA", "submitted plan schema mismatch");
  }
  const allowedPlanKeys = new Set([
    "ok", "mode", "executionReady", "planHash", "schemaId", "schemaVersion",
    "template", "alias", "parallel", "placement", "children",
    "perDeviceConcurrency", "effectClass", "params", "stopConditions",
    "actor", "goalSignature", "mission",
  ]);
  for (const key of Object.keys(submitted)) {
    if (!allowedPlanKeys.has(key)) {
      throw new RoutinePlanError("ROUTINE_PLAN_SEALED", `unknown or execution-only sealed-plan field: ${key}`);
    }
  }
  if (submitted.ok !== true || submitted.mode !== "plan" || submitted.executionReady !== false) {
    throw new RoutinePlanError("ROUTINE_PLAN_SEALED", "sealed submission must be an unbound plan-only document");
  }
  if (submitted.perDeviceConcurrency !== ROUTINE_PER_DEVICE_CONCURRENCY) {
    throw new RoutinePlanError("ROUTINE_PLAN_TAMPERED", "perDeviceConcurrency differs from the sealed policy");
  }
  for (const executionKey of ["executionRunId", "routineRunId", "executionBindingHash"]) {
    if (Object.prototype.propertyIsEnumerable.call(submitted, executionKey)) {
      throw new RoutinePlanError("ROUTINE_PLAN_SEALED", `${executionKey} is execution-only and must not be submitted in a sealed plan`);
    }
  }
  const { planHash, templateSpec, ...body } = submitted;
  if (!/^[a-f0-9]{64}$/.test(planHash || "")) throw new RoutinePlanError("ROUTINE_PLAN_HASH", "planHash missing/malformed");
  if (templateSpec !== undefined) throw new RoutinePlanError("ROUTINE_PLAN_SEALED", "templateSpec must not be submitted (server-sealed only)");
  // verify the seal over the submitted canonical body BEFORE re-planning — a
  // tampered alias/param/template must report TAMPERED, not the underlying
  // validation error it would trigger downstream
  const recomputedHash = sha256Hex(canonicalJson(canonicalPlanBody({
    template: body.template,
    alias: body.alias,
    parallel: body.parallel,
    placement: body.placement,
    children: body.children,
    params: body.params,
    stopConditions: body.stopConditions,
    effectClass: body.effectClass,
    mission: body.mission ?? null,
  })));
  if (recomputedHash !== planHash) {
    throw new RoutinePlanError("ROUTINE_PLAN_TAMPERED", "planHash does not match canonical plan content — reject before I/O");
  }
  const replanned = planRoutine({
    templateId: body.template,
    params: body.params,
    alias: body.alias,
    parallel: body.parallel,
    actor: body.actor,
    goalSignature: body.goalSignature,
    mission: body.mission ?? null,
  });
  if (replanned.planHash !== planHash) {
    throw new RoutinePlanError("ROUTINE_PLAN_TAMPERED", "planHash does not match canonical plan content — reject before I/O");
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
