/**
 * xhs-exploration-mission.mjs — V3 free-exploration mission compiler
 * (plan V2 §3.2/§5.1). Pure module: no fs, no network, no state, no I/O.
 *
 * One template, `xhs.explore.goal.v1` (effectClass none, externalEffects 0).
 * The natural-language compiler is plan-only: raw goal/query text never
 * enters the sealed mission — only deployment-keyed HMAC digests. The private
 * payload is re-validated at execution before any session/lease/job/device
 * I/O is created (plan §3.2: reject, never clamp).
 *
 * Deterministic: identical semantic input + identical key yields identical
 * mission bytes/hash. No timestamps, no random UUIDs in the sealed body.
 */
import { createHash, createHmac } from "node:crypto";

export const EXPLORATION_MISSION_SCHEMA_ID = "xw.xhs.exploration-mission.v1";
export const EXPLORATION_MISSION_SCHEMA_VERSION = 1;
export const EXPLORATION_TEMPLATE_ID = "xhs.explore.goal.v1";
export const EXPLORATION_SESSION_PROFILE = "xhs_goal_explore_v1";

/** Fixed lane roles (plan V2 §3.4) — no reassignment, no work stealing. */
export const EXPLORATION_LANES = Object.freeze([
  Object.freeze({ index: 0, alias: "03", role: "feed_lane" }),
  Object.freeze({ index: 1, alias: "04", role: "search_lane" }),
]);
export const EXPLORATION_LANE_ALIASES = Object.freeze(EXPLORATION_LANES.map((l) => l.alias));
export const EXPLORATION_ACQUIRE_ORDER = Object.freeze(["03", "04"]);
export const EXPLORATION_PARALLELISM = 2;

/** Closed page allowlist + navigation-intent vocabulary (plan V2 §3.2/V3-I03). */
export const EXPLORATION_PAGES = Object.freeze([
  "HOME_FEED",
  "SEARCH_HOME",
  "SEARCH_RESULTS",
  "IMAGE_NOTE",
  "VIDEO_NOTE",
  "COMMENT_PANEL",
]);

export const EXPLORATION_NAVIGATION_VOCABULARY = Object.freeze([
  "OPEN_SEARCH",
  "SUBMIT_SEARCH",
  "SCROLL_FEED",
  "SCROLL_RESULTS",
  "OPEN_CONTENT_CARD",
  "OPEN_COMMENT_PANEL",
  "SCROLL_COMMENTS",
  "PAUSE_VIDEO_SAFE_ZONE",
  "BACK",
  "RESTORE",
]);

/** Complete forbidden action set (plan V2 §3.2/V3-I01) — hard-zero, no debt. */
export const EXPLORATION_FORBIDDEN_ACTIONS = Object.freeze([
  "like", "collect", "follow", "comment_send", "comment_reply", "comment_like",
  "dm", "publish", "delete", "payment", "purchase", "account", "settings",
  "permission_change", "share",
]);

/**
 * Budget caps (plan V2 §3.3). Every value is a CAP, never a quota. Defaults
 * equal the initial caps; runtime callers may only go lower — a raise is a
 * new sealed policy version.
 */
export const EXPLORATION_BUDGET_CAPS = Object.freeze({
  missionDurationSec: 600,
  reservedPrimitives: 80,
  novelOpens: 8,
  sealedQueries: 2,
  resultScreensPerQuery: 2,
  commentScreens: 6,
  consecutiveNavigationFailures: 2,
  noNovelScreens: 2,
  visionAnalysisAttempts: 6,
  visionMaxIssuedPermits: 1,
  visionMaxPhysicalTaps: 1,
  providerDecisionDeadlineMs: 8000,
  frameMaxAgeMs: 10000,
  permitTtlMs: 5000,
  perDeviceConcurrency: 1,
});

export const EXPLORATION_VISION_MODES = Object.freeze(["off", "shadow", "canary1"]);
export const EXPLORATION_EVIDENCE_RETENTION_DAYS = 7;

export class ExplorationMissionError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "ExplorationMissionError";
  }
}

function sha256Hex(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

export function canonicalJson(value) {
  return JSON.stringify(value, (_, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = v[k];
      return out;
    }
    return v;
  });
}

/** Deployment-keyed digest (V3-I09): HMAC-SHA-256 with a caller-held 256-bit key. */
export function keyedDigest({ key, digestKeyId, kind, value }) {
  if (!(key instanceof Buffer) || key.length !== 32) {
    throw new ExplorationMissionError("EXPLORATION_DIGEST_KEY_INVALID", "digest key must be 32 raw bytes");
  }
  const normalized = String(value ?? "").trim().replace(/\s+/g, " ");
  const digest = createHmac("sha256", key)
    .update(`xhs-explore-v1:${digestKeyId}:${kind}:${normalized}`, "utf8")
    .digest("hex");
  return Object.freeze({ digestKeyId: String(digestKeyId), digest });
}

const MIXED_EFFECT_RE = /点赞|点个赞|关注|收藏一?下|发评论|发送评论|留言|私信|口信|like|follow|dm\b|publish|发布|上架/i;
const UNBOUNDED_RE = /全部|所有|无限|一直|永远|不要停|别停|不停|所有内容|\ball\b|\bforever\b|unlimited|without[ -]?end/i;

/** Normalize the raw goal text (trim + whitespace collapse) before hashing. */
export function normalizeGoalText(raw) {
  return String(raw ?? "").trim().replace(/\s+/g, " ");
}

/**
 * Compile a natural-language exploration goal into a sealed public mission.
 * Plan-only: creates zero runtime state. Any disallowed intent is a whole-plan
 * rejection (EXPLORATION_GOAL_MIXED_EFFECT etc.) — mixed effects are never
 * silently removed or clamped.
 */
export function compileExplorationMission({
  goal,
  queries = [],
  budgets = {},
  vision = null,
  releaseIdRef = null,
  accountFingerprintRef = null,
  digestKeyId = "ka-1",
  digestKey = null,
  seed = "explore",
} = {}) {
  const normalizedGoal = normalizeGoalText(goal);
  if (!normalizedGoal) {
    throw new ExplorationMissionError("EXPLORATION_GOAL_REQUIRED", "exploration goal is required");
  }
  if (normalizedGoal.length > 512) {
    throw new ExplorationMissionError("EXPLORATION_GOAL_TOO_LONG", "goal exceeds 512 normalized characters");
  }
  if (MIXED_EFFECT_RE.test(normalizedGoal)) {
    throw new ExplorationMissionError("EXPLORATION_GOAL_MIXED_EFFECT", "goal mixes read-only exploration with a social effect; whole plan rejected");
  }
  if (UNBOUNDED_RE.test(normalizedGoal)) {
    throw new ExplorationMissionError("EXPLORATION_GOAL_UNBOUNDED", "unbounded exploration language rejected; state explicit bounded options");
  }
  if (!Array.isArray(queries) || queries.length > EXPLORATION_BUDGET_CAPS.sealedQueries) {
    throw new ExplorationMissionError("EXPLORATION_QUERY_CAP_EXCEEDED", `at most ${EXPLORATION_BUDGET_CAPS.sealedQueries} sealed queries`);
  }
  if (!(digestKey instanceof Buffer) || digestKey.length !== 32) {
    throw new ExplorationMissionError("EXPLORATION_DIGEST_KEY_INVALID", "a 256-bit deployment-keyed digest key is required to seal the mission");
  }
  const normalizedQueries = queries.map((q) => normalizeGoalText(q));
  for (const q of normalizedQueries) {
    if (!q) throw new ExplorationMissionError("EXPLORATION_QUERY_INVALID", "sealed queries must be non-empty");
    if (q.length > 128) throw new ExplorationMissionError("EXPLORATION_QUERY_TOO_LONG", "sealed query exceeds 128 normalized chars");
    // queries carry the same mixed-effect screen as the goal (V3-I01): a
    // social verb inside a sealed query rejects the WHOLE plan
    if (MIXED_EFFECT_RE.test(q)) {
      throw new ExplorationMissionError("EXPLORATION_GOAL_MIXED_EFFECT", `sealed query mixes a social effect: ${q}`);
    }
  }

  // budgets: defaults = caps; overrides lower them, never raise (plan §3.3)
  const resolvedBudgets = {};
  for (const [name, cap] of Object.entries(EXPLORATION_BUDGET_CAPS)) {
    const requested = budgets?.[name];
    if (requested === undefined || requested === null) {
      resolvedBudgets[name] = cap;
      continue;
    }
    if (!Number.isInteger(requested) || requested < 0) {
      throw new ExplorationMissionError("EXPLORATION_BUDGET_INVALID", `budget ${name} must be a non-negative integer`);
    }
    if (requested > cap) {
      throw new ExplorationMissionError("EXPLORATION_BUDGET_CAP_EXCEEDED", `budget ${name}=${requested} exceeds the sealed cap ${cap}; raising requires a new sealed policy version`);
    }
    resolvedBudgets[name] = requested;
  }

  // Vision is opt-in. A mission without a fully pinned provider remains
  // DUMP-only; shadow/canary may never carry null placeholder identities.
  const visionMode = String(vision?.mode ?? "off");
  if (!EXPLORATION_VISION_MODES.includes(visionMode)) {
    throw new ExplorationMissionError("EXPLORATION_VISION_MODE_INVALID", `vision mode must be one of ${EXPLORATION_VISION_MODES.join("|")}`);
  }
  // first live canary is a single global visual permit (plan §3.3/§5.5);
  // multi-tap promotion is a later sealed policy, never a compiler option
  if (visionMode === "canary1" && resolvedBudgets.visionMaxIssuedPermits > 1) {
    throw new ExplorationMissionError("EXPLORATION_VISION_BUDGET_INVALID", "first canary vision budget is globally one permit");
  }
  const visionPolicy = Object.freeze({
    mode: visionMode,
    remoteEgress: false, // local-only vision for this release (V3-I09)
    provider: Object.freeze({
      kind: "local-pinned",
      pythonHash: vision?.provider?.pythonHash ?? null,
      modelHash: vision?.provider?.modelHash ?? null,
      scriptHash: vision?.provider?.scriptHash ?? null,
      configHash: vision?.provider?.configHash ?? null,
    }),
  });
  if (visionMode !== "off") {
    for (const key of ["pythonHash", "modelHash", "scriptHash", "configHash"]) {
      if (!/^[a-f0-9]{64}$/.test(String(visionPolicy.provider[key] ?? ""))) {
        throw new ExplorationMissionError(
          "EXPLORATION_VISION_PROVIDER_UNPINNED",
          `vision ${visionMode} requires a 64-hex provider.${key}`,
        );
      }
    }
  } else if (["pythonHash", "modelHash", "scriptHash", "configHash"]
    .some((key) => visionPolicy.provider[key] !== null)) {
    throw new ExplorationMissionError(
      "EXPLORATION_VISION_PROVIDER_INVALID",
      "vision off must not carry a dormant provider binding",
    );
  }

  const goalRef = keyedDigest({ key: digestKey, digestKeyId, kind: "goal", value: normalizedGoal });
  const queryRefs = normalizedQueries.map((q, index) => {
    const d = keyedDigest({ key: digestKey, digestKeyId, kind: "query", value: q });
    return Object.freeze({ index, digestKeyId: d.digestKeyId, digest: d.digest });
  });

  const body = {
    schemaId: EXPLORATION_MISSION_SCHEMA_ID,
    schemaVersion: EXPLORATION_MISSION_SCHEMA_VERSION,
    templateId: EXPLORATION_TEMPLATE_ID,
    goalRef,
    objective: { kind: "explore", bounded: true },
    queries: Object.freeze(queryRefs),
    placement: Object.freeze({
      lanes: EXPLORATION_LANES,
      acquireOrder: EXPLORATION_ACQUIRE_ORDER,
      parallelism: EXPLORATION_PARALLELISM,
      automaticFallback: false,
      perDeviceConcurrency: 1,
    }),
    pages: EXPLORATION_PAGES,
    navigationVocabulary: EXPLORATION_NAVIGATION_VOCABULARY,
    forbiddenActions: EXPLORATION_FORBIDDEN_ACTIONS,
    budgets: Object.freeze(resolvedBudgets),
    stopPolicy: Object.freeze({
      consecutiveNavigationFailures: resolvedBudgets.consecutiveNavigationFailures,
      noNovelScreens: resolvedBudgets.noNovelScreens,
    }),
    vision: visionPolicy,
    evidence: Object.freeze({
      privateRetentionDays: EXPLORATION_EVIDENCE_RETENTION_DAYS,
      remoteEgress: false,
      publicPrivacy: "opaque-keyed-digests",
    }),
    releaseBinding: Object.freeze({ releaseIdRef, accountFingerprintRef }),
    externalEffects: 0,
    profile: EXPLORATION_SESSION_PROFILE,
    seed: String(seed).slice(0, 64),
  };
  const missionHash = sha256Hex(canonicalJson(body));
  const mission = Object.freeze({ ...body, missionHash });
  // private form never serialized with the sealed mission; returned to the
  // execution binder and dropped from stdout/receipts
  const privatePayload = Object.freeze({ goal: normalizedGoal, queries: Object.freeze(normalizedQueries) });
  return { mission, missionHash, privatePayload };
}

/**
 * Re-validate a submitted sealed mission (CP-side structural check and runner
 * side). Exact keys, no unknown fields, byte-exact hash reproduction. Tampering
 * with any field (goal/alias/roles/budgets/externalEffects/...) changes the
 * canonical hash and is rejected before authority creation.
 */
const SEALED_MISSION_KEYS = new Set([
  "schemaId", "schemaVersion", "templateId", "goalRef", "objective", "queries",
  "placement", "pages", "navigationVocabulary", "forbiddenActions", "budgets",
  "stopPolicy", "vision", "evidence", "releaseBinding", "externalEffects",
  "profile", "seed", "missionHash",
]);

export function validateSealedMission(submitted) {
  if (!submitted || typeof submitted !== "object" || Array.isArray(submitted)) {
    throw new ExplorationMissionError("EXPLORATION_MISSION_INVALID", "submitted mission must be an object");
  }
  if (submitted.schemaId !== EXPLORATION_MISSION_SCHEMA_ID
    || submitted.schemaVersion !== EXPLORATION_MISSION_SCHEMA_VERSION) {
    throw new ExplorationMissionError("EXPLORATION_MISSION_SCHEMA", "mission schema mismatch");
  }
  for (const key of Object.keys(submitted)) {
    if (!SEALED_MISSION_KEYS.has(key)) {
      throw new ExplorationMissionError("EXPLORATION_MISSION_SEALED", `unknown sealed-mission field: ${key}`);
    }
  }
  const { missionHash, goalRef, queries, ...rest } = submitted;
  if (!/^[a-f0-9]{64}$/.test(missionHash || "")) {
    throw new ExplorationMissionError("EXPLORATION_MISSION_HASH", "missionHash missing/malformed");
  }
  for (const ref of [goalRef, ...queries]) {
    if (!ref || typeof ref !== "object") throw new ExplorationMissionError("EXPLORATION_MISSION_SEALED", "digest refs are required");
    if (!/^[a-f0-9]{64}$/.test(ref.digest ?? "")) {
      throw new ExplorationMissionError("EXPLORATION_MISSION_SEALED", `digest for ${ref?.digestKeyId} must be 64 hex`);
    }
    if (ref.index !== undefined && ref.index !== queries.indexOf(ref)) {
      throw new ExplorationMissionError("EXPLORATION_MISSION_SEALED", "query ref index mismatch");
    }
  }
  // The seal is: canonical bytes of the body (excluding missionHash) hashed
  // with plain sha256. No key material in the hash — privacy comes from the
  // HMAC digests, integrity from the plain content hash (plan §3.2: raw text
  // never enters the public form).
  const body = { ...rest, goalRef, queries };
  const actual = sha256Hex(canonicalJson(body));
  if (actual !== missionHash) {
    throw new ExplorationMissionError("EXPLORATION_MISSION_TAMPERED", "missionHash does not match canonical mission content — reject before I/O");
  }
  const mission = Object.freeze({ ...body, missionHash });
  if (mission.externalEffects !== 0 || mission.templateId !== EXPLORATION_TEMPLATE_ID
    || mission.profile !== EXPLORATION_SESSION_PROFILE) {
    throw new ExplorationMissionError("EXPLORATION_MISSION_TAMPERED", "mission violates the hard-zero exploration contract");
  }
  if (canonicalJson(mission.placement?.lanes ?? []) !== canonicalJson(EXPLORATION_LANES)
    || canonicalJson(mission.pages) !== canonicalJson(EXPLORATION_PAGES)
    || canonicalJson(mission.navigationVocabulary) !== canonicalJson(EXPLORATION_NAVIGATION_VOCABULARY)
    || canonicalJson(mission.forbiddenActions) !== canonicalJson(EXPLORATION_FORBIDDEN_ACTIONS)) {
    throw new ExplorationMissionError("EXPLORATION_MISSION_TAMPERED", "sealed allowlists/roles differ from the frozen V3 policy");
  }
  for (const [name, cap] of Object.entries(EXPLORATION_BUDGET_CAPS)) {
    const v = mission.budgets?.[name];
    if (!Number.isInteger(v) || v < 0 || v > cap) {
      throw new ExplorationMissionError("EXPLORATION_BUDGET_CAP_EXCEEDED", `sealed budget ${name}=${v} violates cap ${cap}`);
    }
  }
  const visionMode = mission.vision?.mode;
  if (!EXPLORATION_VISION_MODES.includes(visionMode) || mission.vision?.remoteEgress !== false
    || mission.vision?.provider?.kind !== "local-pinned") {
    throw new ExplorationMissionError("EXPLORATION_VISION_MODE_INVALID", "sealed vision policy is invalid");
  }
  const providerHashes = ["pythonHash", "modelHash", "scriptHash", "configHash"];
  if (visionMode === "off") {
    if (providerHashes.some((key) => mission.vision.provider[key] !== null)) {
      throw new ExplorationMissionError("EXPLORATION_VISION_PROVIDER_INVALID", "vision off must not bind provider bytes");
    }
  } else if (providerHashes.some((key) => !/^[a-f0-9]{64}$/.test(String(mission.vision.provider[key] ?? "")))) {
    throw new ExplorationMissionError("EXPLORATION_VISION_PROVIDER_UNPINNED", "sealed vision provider identity is incomplete");
  }
  return mission;
}

/**
 * Verify the private execution payload against the sealed digest references.
 * Called by the execution binder BEFORE session/lease/job/device I/O. Returns
 * the normalized private payload; mismatch is a whole-run rejection.
 */
export function verifyPrivatePayload({ mission, privatePayload, digestKey }) {
  if (!(digestKey instanceof Buffer) || digestKey.length !== 32) {
    throw new ExplorationMissionError("EXPLORATION_DIGEST_KEY_INVALID", "digest key must be 32 raw bytes");
  }
  const normalizedGoal = normalizeGoalText(privatePayload?.goal ?? "");
  if (!normalizedGoal) {
    throw new ExplorationMissionError("EXPLORATION_PAYLOAD_INVALID", "private payload has no goal");
  }
  const goalDigest = keyedDigest({
    key: digestKey, digestKeyId: mission.goalRef.digestKeyId, kind: "goal", value: normalizedGoal,
  });
  if (goalDigest.digest !== mission.goalRef.digest) {
    throw new ExplorationMissionError("EXPLORATION_PAYLOAD_MISMATCH", "private goal does not match the sealed digest — reject before I/O");
  }
  const privateQueries = (privatePayload?.queries ?? []).map((q) => normalizeGoalText(q));
  if (privateQueries.length !== mission.queries.length) {
    throw new ExplorationMissionError("EXPLORATION_PAYLOAD_MISMATCH", "private query count differs from the sealed mission");
  }
  const queries = mission.queries.map((ref, index) => {
    const digest = keyedDigest({ key: digestKey, digestKeyId: ref.digestKeyId, kind: "query", value: privateQueries[index] });
    if (digest.digest !== ref.digest) {
      throw new ExplorationMissionError("EXPLORATION_PAYLOAD_MISMATCH", `private query ${index} does not match the sealed digest — reject before I/O`);
    }
    return privateQueries[index];
  });
  return Object.freeze({ goal: normalizedGoal, queries: Object.freeze(queries) });
}
