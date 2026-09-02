/**
 * xhs-exploration-authority.mjs — V3 hard-zero exploration authority policy
 * (plan V2 §5.2 / invariants V3-I01/I02/I05/I06/I08).
 *
 * The authority binds the mission, release/account, the exact two sessions
 * (03=feed_lane, 04=search_lane) and every shared budget. It never inherits
 * Mission social authorization or `nonpayment_v1` softness: the profile is
 * fail-closed even when global policyMode.active=true, and no routine social
 * authority, comment draft, effect reservation, or effect bridge is created
 * anywhere on this path.
 *
 * Storage primitives live on StateStore; this module owns validation and the
 * exact rejection codes the acceptance probes assert.
 */
import { newId } from "./canonical.mjs";
import { ControlPlaneError } from "./errors.mjs";
import { createLockedECorpusInterlock, validateECorpusPassRef } from "./xhs-e-corpus-pass.mjs";

export const EXPLORATION_PROFILE = "xhs_goal_explore_v1";
export const EXPLORATION_TEMPLATE_ID = "xhs.explore.goal.v1";
export const EXPLORATION_LANE_ROLES = Object.freeze({ "03": "feed_lane", "04": "search_lane" });

/**
 * Mission budget fields that double as reservation cap names (plan §3.3).
 */
export const EXPLORATION_BUDGET_KINDS = Object.freeze({
  primitives: "reservedPrimitives",
  novelOpens: "novelOpens",
  queries: "sealedQueries",
  resultScreens: "resultScreensPerQuery",
  commentScreens: "commentScreens",
  visionAnalysis: "visionAnalysisAttempts",
  visionPermits: "visionMaxIssuedPermits",
});

/**
 * Frozen budget ceilings mirroring the orchestrator compiler's default caps
 * (plan §3.3). Kept in CP code so the trust boundary can refuse a widened
 * mission even if a caller bypasses the seal checks.
 */
export const EXPLORATION_BUDGET_CEILINGS = Object.freeze({
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
  vision: 0,
});

/**
 * Primitives a profile session may run generically (observation-class only).
 * Everything interactive (tap/swipe/input_text/back/launch_app) and every
 * other capability id is refused on the generic session-action path — even
 * with the caller's real session token, even under policyMode.active=true.
 */
export const EXPLORATION_GENERIC_PRIMITIVES = Object.freeze(new Set(["dump_ui", "screen", "focus"]));
export const EXPLORATION_FORBIDDEN_GENERIC_PRIMITIVES = Object.freeze(
  new Set(["tap", "swipe", "input_text", "back", "launch_app"]),
);

const EXPLORER_CAPABILITY_ID = "xiaowei.explorer.primitive";

function reject(code, message, { status = 403, details = {} } = {}) {
  throw new ControlPlaneError(code, message, { status, details });
}

export function createExplorationAuthorityPolicy({
  state,
  eCorpusInterlock = createLockedECorpusInterlock(),
} = {}) {
  if (!state) throw new TypeError("createExplorationAuthorityPolicy requires the CP state store");
  if (!eCorpusInterlock || typeof eCorpusInterlock.verifyR3 !== "function") {
    throw new TypeError("createExplorationAuthorityPolicy requires an E-Corpus interlock");
  }

  /**
   * Validate a submitted sealed mission structurally. CP never trusts the
   * orchestrator compiler: this boundary check repeats the exact-keys/caps
   * gate inside the trust boundary (defense in depth, plan §5.2). Integrity
   * (missionHash) is asserted by the router-side mission lib; here the cap
   * floor is re-enforced so even a hash-colliding payload cannot widen budgets.
   */
  function validateSealedMissionForAuthority(mission, { releaseId = null, sourceCommit = null } = {}) {
    if (!mission || typeof mission !== "object" || Array.isArray(mission)) {
      reject("EXPLORATION_MISSION_INVALID", "mission must be an object", { status: 400 });
    }
    if (mission.schemaId !== "xw.xhs.exploration-mission.v1" || mission.schemaVersion !== 1) {
      reject("EXPLORATION_MISSION_SCHEMA", "mission schema mismatch", { status: 400 });
    }
    if (mission.templateId !== EXPLORATION_TEMPLATE_ID) {
      reject("EXPLORATION_TEMPLATE_INVALID", `template must be ${EXPLORATION_TEMPLATE_ID}`, { status: 400 });
    }
    if (mission.profile !== EXPLORATION_PROFILE) {
      reject("EXPLORATION_PROFILE_INVALID", `mission profile must be ${EXPLORATION_PROFILE}`, { status: 400 });
    }
    if (mission.externalEffects !== 0) {
      reject("EXPLORATION_EFFECTS_NOT_ZERO", "mission externalEffects must be exactly 0", { status: 400 });
    }
    const lanes = mission.placement?.lanes;
    if (!Array.isArray(lanes) || lanes.length !== 2
      || lanes[0]?.alias !== "03" || lanes[0]?.role !== "feed_lane"
      || lanes[1]?.alias !== "04" || lanes[1]?.role !== "search_lane") {
      reject("EXPLORATION_LANES_INVALID", "mission lanes must be exactly [03=feed_lane,04=search_lane]", { status: 400 });
    }
    const budgets = mission.budgets ?? {};
    const completeBudgetNames = Object.keys(EXPLORATION_BUDGET_CEILINGS).filter((name) => name !== "vision");
    for (const capName of completeBudgetNames) {
      const value = budgets[capName];
      // the ceiling is the compiler's frozen cap (plan §3.3): a mission may go
      // LOWER than the default but never above it — a hash-colliding payload
      // cannot widen any budget once the CP is on its path
      if (!Number.isInteger(value) || value < 0 || value > EXPLORATION_BUDGET_CEILINGS[capName]) {
        reject("EXPLORATION_BUDGET_INVALID", `budget ${capName} must be within 0..${EXPLORATION_BUDGET_CEILINGS[capName]}`, { status: 400 });
      }
    }
    if (Array.isArray(mission.queries) && mission.queries.length > Number(budgets.sealedQueries ?? 0)) {
      reject("EXPLORATION_QUERY_CAP_EXCEEDED", "sealed queries exceed the mission budget", { status: 400 });
    }
    const vision = mission.vision ?? { mode: "off", remoteEgress: false, provider: null };
    if (!["off", "shadow", "canary1"].includes(vision.mode) || vision.remoteEgress !== false) {
      reject("EXPLORATION_VISION_POLICY_INVALID", "vision mode/egress policy is invalid", { status: 400 });
    }
    if (vision.mode !== "off") {
      if (vision.provider?.kind !== "local-pinned") {
        reject("EXPLORATION_VISION_PROVIDER_UNPINNED", "vision provider must be local-pinned", { status: 400 });
      }
      for (const key of ["providerBundleDigest", "pythonHash", "modelHash", "scriptHash", "configHash"]) {
        if (!/^[a-f0-9]{64}$/.test(String(vision.provider?.[key] ?? ""))) {
          reject("EXPLORATION_VISION_PROVIDER_UNPINNED", `vision provider.${key} must be 64-hex`, { status: 400 });
        }
      }
    }
    const inferredPhase = vision.mode === "canary1" ? "R3" : vision.mode === "shadow" ? "R2" : "R0";
    const rolloutPhase = String(vision.rolloutPhase ?? inferredPhase);
    const validPhaseMode = (rolloutPhase === "R3" && vision.mode === "canary1")
      || (rolloutPhase === "R2" && vision.mode === "shadow")
      || (["R0", "R1"].includes(rolloutPhase) && vision.mode === "off");
    if (!validPhaseMode) {
      reject(
        "EXPLORATION_ROLLOUT_MODE_MISMATCH",
        `rollout phase ${rolloutPhase} is incompatible with vision mode ${vision.mode}`,
        { status: 400 },
      );
    }

    // R0/R1/R2 are mechanically zero even if a legacy/manual mission body
    // still carries the parent cap.  The authority persists only these
    // effective budgets, so bypassing the orchestrator compiler cannot make a
    // visual reservation available.
    let effectiveVisualPermitBudget = 0;
    let eCorpusPassRef = null;
    let eCorpusVerification = null;
    if (rolloutPhase === "R3") {
      if (!/^[a-f0-9]{40}$/.test(String(sourceCommit ?? ""))) {
        reject("ECORPUS_SOURCE_MISMATCH", "R3 requires the full deployed source commit", { status: 403 });
      }
      if (!releaseId) {
        reject("ECORPUS_RELEASE_MISMATCH", "R3 requires the deployed release identity", { status: 403 });
      }
      eCorpusPassRef = validateECorpusPassRef(vision.eCorpusPassRef ?? null);
      eCorpusVerification = eCorpusInterlock.verifyR3({
        ref: eCorpusPassRef,
        releaseId,
        sourceCommit,
        providerBundleDigest: vision.provider?.providerBundleDigest,
      });
      if (eCorpusVerification?.ok !== true || eCorpusVerification?.status !== "PASS"
        || eCorpusVerification?.artifactHash !== eCorpusPassRef?.artifactHash
        || eCorpusVerification?.effectiveVisualPermitBudget !== 1) {
        reject("ECORPUS_VERIFICATION_INVALID", "R3 E-Corpus verifier returned no exact PASS authority", { status: 403 });
      }
      if (budgets.visionMaxIssuedPermits !== 1 || budgets.visionMaxPhysicalTaps !== 1) {
        reject("EXPLORATION_VISION_BUDGET_INVALID", "R3 parent issued/physical visual caps must be exactly one", { status: 400 });
      }
      effectiveVisualPermitBudget = 1;
    } else if (vision.eCorpusPassRef != null) {
      reject("ECORPUS_REF_PHASE_FORBIDDEN", `${rolloutPhase} must not carry dormant E-Corpus authority`, { status: 400 });
    }
    const effectiveBudgets = {
      ...budgets,
      visionMaxIssuedPermits: effectiveVisualPermitBudget,
      visionMaxPhysicalTaps: effectiveVisualPermitBudget,
    };
    const effectiveVision = {
      ...vision,
      rolloutPhase,
      effectiveVisualPermitBudget,
      eCorpusPassRef,
      ...(eCorpusVerification ? {
        eCorpusBinding: {
          artifactHash: eCorpusVerification.artifactHash,
          sourceCommit,
          providerBundleDigest: vision.provider.providerBundleDigest,
        },
      } : {}),
    };
    return { budgets: effectiveBudgets, vision: effectiveVision };
  }

  /**
   * Register the authority: both sessions already formal, aliases fixed
   * [03,04], profile stamped on both sessions, budgets sealed. Zero social
   * authority/draft/bridge/transport side effects (V3-I01).
   */
  function registerAuthority({
    sessions,
    executionRunId,
    routineRunId,
    mission,
    planHash,
    releaseId = null,
    sourceCommit = null,
    accountFingerprint = null,
  }) {
    if (!Array.isArray(sessions) || sessions.length !== 2) {
      reject("EXPLORATION_SESSION_PAIR_REQUIRED", "exactly two sessions are required (03,04)", { status: 400 });
    }
    const ordered = [...sessions].sort((a, b) => String(a.alias).localeCompare(String(b.alias)));
    if (ordered[0]?.alias !== "03" || ordered[1]?.alias !== "04") {
      reject("EXPLORATION_ALIAS_NOT_ALLOWED", "exploration authority is exactly [03,04]; alias 01/02 or 04-alone is rejected", { status: 403 });
    }
    if (!executionRunId || !routineRunId || !planHash) {
      reject("EXPLORATION_AUTHORITY_INVALID", "executionRunId, routineRunId, and planHash are required", { status: 400 });
    }
    if (!/^[a-f0-9]{64}$/.test(String(mission?.missionHash || ""))) {
      reject("EXPLORATION_MISSION_HASH", "mission hash missing/malformed", { status: 400 });
    }
    const validated = validateSealedMissionForAuthority(mission, { releaseId, sourceCommit });

    // profile marks BOTH sessions BEFORE any device I/O can happen (pair
    // barrier, §3.4): the first session to attach already rejects raw taps.
    state.markSessionsExplorationProfile(ordered.map((s) => s.sessionId), EXPLORATION_PROFILE);

    const laneBindings = ordered.map((s) => {
      const session = state.validateSession(s.sessionId, s.token);
      const deviceAlias = session.routeDecision?.selectedDevice?.alias;
      if (deviceAlias && deviceAlias !== s.alias) {
        reject("EXPLORATION_SESSION_ALIAS_DRIFT", `session ${s.sessionId} drifted to device alias ${deviceAlias}`, { status: 409 });
      }
      return {
        sessionId: session.sessionId,
        leaseId: session.leaseId,
        alias: s.alias,
        laneRole: EXPLORATION_LANE_ROLES[s.alias],
      };
    });
    const actorId = state.validateSession(ordered[0].sessionId, ordered[0].token).actorId;
    return state.insertExplorationAuthority({
      authorityId: newId("expl-auth"),
      executionRunId,
      routineRunId,
      missionHash: mission.missionHash,
      planHash,
      templateId: mission.templateId,
      releaseId,
      accountFingerprint,
      actorId,
      lanes: mission.placement.lanes,
      budgets: validated.budgets,
      vision: validated.vision,
      profile: EXPLORATION_PROFILE,
      laneBindings,
      createdAt: Date.now(),
    });
  }

  /** Fresh E-Corpus verification immediately before visual reserve/consume. */
  function assertVisualUnlocked({ authority }) {
    if (authority?.vision?.rolloutPhase !== "R3"
      || authority?.vision?.mode !== "canary1"
      || authority?.vision?.effectiveVisualPermitBudget !== 1
      || authority?.budgets?.visionMaxIssuedPermits !== 1
      || authority?.budgets?.visionMaxPhysicalTaps !== 1) {
      reject("EXPLORATION_VISUAL_BUDGET_LOCKED", "visual permit budget is locked at zero before R3", { status: 403 });
    }
    const result = eCorpusInterlock.verifyR3({
      ref: authority.vision.eCorpusPassRef,
      releaseId: authority.releaseId,
      sourceCommit: authority.vision.eCorpusBinding?.sourceCommit,
      providerBundleDigest: authority.vision.provider?.providerBundleDigest,
    });
    if (result?.ok !== true || result?.status !== "PASS"
      || result?.artifactHash !== authority.vision.eCorpusPassRef?.artifactHash
      || result?.effectiveVisualPermitBudget !== 1) {
      reject("ECORPUS_VERIFICATION_INVALID", "fresh E-Corpus verification failed", { status: 403 });
    }
    return result;
  }

  /**
   * The generic raw-primitive gate (V3-I02). Called by the session-action
   * entry point for every session carrying the exploration profile.
   */
  function assertGenericSessionAction(session, { capabilityId, params }) {
    if (capabilityId !== EXPLORER_CAPABILITY_ID) {
      reject("EXPLORATION_CAPABILITY_FORBIDDEN", "exploration sessions accept only Explorer observation primitives", { details: { capabilityId: capabilityId ?? null } });
    }
    const primitive = String(params?.primitive ?? "");
    if (EXPLORATION_FORBIDDEN_GENERIC_PRIMITIVES.has(primitive)) {
      reject("EXPLORATION_PRIMITIVE_FORBIDDEN", `generic ${primitive} is refused for ${EXPLORATION_PROFILE} sessions; interactive navigation requires a single-use CP permit`, { details: { primitive } });
    }
    if (!EXPLORATION_GENERIC_PRIMITIVES.has(primitive)) {
      reject("EXPLORATION_PRIMITIVE_UNKNOWN", `primitive ${primitive} is not in the exploration observation set`, { details: { primitive } });
    }
  }

  return {
    validateSealedMissionForAuthority,
    registerAuthority,
    assertGenericSessionAction,
    assertVisualUnlocked,
  };
}
