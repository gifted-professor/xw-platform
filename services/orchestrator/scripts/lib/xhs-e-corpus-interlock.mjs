/**
 * Orchestrator-side phase policy for the E-Corpus visual interlock.
 *
 * R0/R1/R2 are mechanically zero, not merely "shadow by convention".  R3 is
 * the only phase that may recover the parent cap of one, and only after a
 * task-owned verifier returns an exact PASS reference.  CP repeats the check;
 * this early gate exists so orchestration refuses before session/lease work.
 */
export const XHS_EXPLORATION_ROLLOUT_PHASES = Object.freeze(["R0", "R1", "R2", "R3", "R4"]);
export const XHS_E_CORPUS_PASS_REF_SCHEMA_ID = "xw.xhs.e-corpus-pass-ref.v1";

const HEX_64 = /^[a-f0-9]{64}$/;

export class XhsECorpusInterlockError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "XhsECorpusInterlockError";
    this.code = code;
  }
}

function reject(code, message) {
  throw new XhsECorpusInterlockError(code, message);
}

export function validateECorpusPassRef(ref) {
  const keys = ["schemaId", "artifactHash", "bindingHash", "gateEpoch", "expiresAtMs"];
  if (!ref || typeof ref !== "object" || Array.isArray(ref)
    || Object.keys(ref).length !== keys.length
    || Object.keys(ref).some((key) => !keys.includes(key))
    || ref.schemaId !== XHS_E_CORPUS_PASS_REF_SCHEMA_ID
    || !HEX_64.test(String(ref.artifactHash ?? ""))
    || !HEX_64.test(String(ref.bindingHash ?? ""))
    || !HEX_64.test(String(ref.gateEpoch ?? ""))
    || !Number.isInteger(ref.expiresAtMs) || ref.expiresAtMs <= 0) {
    reject("ECORPUS_REF_INVALID", "R3 requires one exact task-owned E-Corpus reference");
  }
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, ref[key]])));
}

export function inferExplorationRolloutPhase({ visionMode, requestedPhase = null } = {}) {
  const inferred = visionMode === "canary1" ? "R3" : visionMode === "shadow" ? "R2" : "R0";
  const phase = requestedPhase == null ? inferred : String(requestedPhase);
  if (!XHS_EXPLORATION_ROLLOUT_PHASES.includes(phase)) {
    reject("EXPLORATION_ROLLOUT_PHASE_INVALID", "rollout phase must be R0|R1|R2|R3|R4");
  }
  const validMode = (phase === "R3" && visionMode === "canary1")
    || (phase === "R2" && visionMode === "shadow")
    || (["R0", "R1", "R4"].includes(phase) && visionMode === "off");
  if (!validMode) {
    reject("EXPLORATION_ROLLOUT_MODE_MISMATCH", `${phase} is incompatible with vision mode ${visionMode}`);
  }
  return phase;
}

export function resolveEffectiveVisualPermitPolicy({
  visionMode,
  requestedPhase = null,
  requestedIssuedPermits = null,
  requestedPhysicalTaps = null,
  eCorpusPassRef = null,
  verifyR3 = null,
} = {}) {
  const phase = inferExplorationRolloutPhase({ visionMode, requestedPhase });
  if (phase !== "R3") {
    if ((requestedIssuedPermits != null && requestedIssuedPermits !== 0)
      || (requestedPhysicalTaps != null && requestedPhysicalTaps !== 0)) {
      reject("EXPLORATION_VISUAL_BUDGET_LOCKED", `${phase} visual issued/physical budgets must be exactly zero`);
    }
    if (eCorpusPassRef != null) {
      reject("ECORPUS_REF_PHASE_FORBIDDEN", `${phase} must not carry dormant E-Corpus authority`);
    }
    return Object.freeze({
      phase,
      effectiveVisualPermitBudget: 0,
      effectiveVisualPhysicalTapBudget: 0,
      eCorpusPassRef: null,
      verification: null,
    });
  }

  const issued = requestedIssuedPermits == null ? 1 : requestedIssuedPermits;
  const physical = requestedPhysicalTaps == null ? 1 : requestedPhysicalTaps;
  if (issued !== 1 || physical !== 1) {
    reject("EXPLORATION_VISION_BUDGET_INVALID", "R3 parent visual issued/physical caps are exactly one");
  }
  const ref = validateECorpusPassRef(eCorpusPassRef);
  if (typeof verifyR3 !== "function") {
    reject("ECORPUS_INTERLOCK_NOT_CONFIGURED", "R3 cannot compile without the task-owned E-Corpus verifier");
  }
  const verification = verifyR3({ ref });
  if (verification?.ok !== true || verification?.status !== "PASS"
    || verification.artifactHash !== ref.artifactHash
    || verification.effectiveVisualPermitBudget !== 1) {
    reject("ECORPUS_VERIFICATION_INVALID", "R3 verifier did not return the exact PASS binding");
  }
  return Object.freeze({
    phase,
    effectiveVisualPermitBudget: 1,
    effectiveVisualPhysicalTapBudget: 1,
    eCorpusPassRef: ref,
    verification,
  });
}
