import { ControlPlaneError } from "./errors.mjs";
import { decideCapabilityPolicy, assertAuthorizationAllow } from "./authorization-decision.mjs";
import { attachNormalizedEffect } from "./capability-effect.mjs";

const STANDING_GRANT_MISSION_ONLY = new Set(["xhs.collect.standing_grant"]);

/**
 * Thin wrapper: returns AuthorizationDecision plus legacy fields for existing callers.
 * Prefer decideCapabilityPolicy() for new code.
 */
export function evaluateCapabilityPolicy(capability, {
  canary = false,
  invocation = "job",
  policyMode = null,
  actorId = null,
  deviceAlias = null,
  principalId = null,
  /** When true (submit paths), non-allow throws. Preview/plan may set false. */
  enforce = false,
} = {}) {
  const enriched = capability.normalizedEffect ? capability : attachNormalizedEffect(capability);
  const auth = decideCapabilityPolicy(enriched, {
    canary,
    invocation,
    policyMode,
    actorId,
    deviceAlias,
    principalId,
  });

  if (enforce) {
    assertAuthorizationAllow(auth);
  }

  // Standing grant: still throw for non-mission (compat with tests that catch ControlPlaneError)
  if (STANDING_GRANT_MISSION_ONLY.has(enriched.id) && invocation !== "mission_effect") {
    throw new ControlPlaneError(
      "STANDING_GRANT_MISSION_REQUIRED",
      `${enriched.id} may run only through a governed Standing Grant Mission ECP`,
      { status: 403 },
    );
  }

  // Legacy throw style for disabled/canary that some call sites expect as throw before submit
  if (auth.decision === "block" && auth.reasonCode === "CAPABILITY_DISABLED") {
    throw new ControlPlaneError("CAPABILITY_DISABLED", `${enriched.id} is disabled`, { status: 403 });
  }
  if (auth.decision === "block" && auth.reasonCode === "CANARY_SESSION_REQUIRED") {
    throw new ControlPlaneError(
      "CANARY_SESSION_REQUIRED",
      `${enriched.id} requires an exclusive canary session`,
      { status: 403 },
    );
  }
  if (auth.decision === "block" && auth.reasonCode === "CANARY_REQUIRED") {
    throw new ControlPlaneError("CANARY_REQUIRED", `${enriched.id} is canary-only`, { status: 403 });
  }

  // Soft evaluation returns structured decision plus legacy flat fields.
  // Callers that only need { approvalRequired, externalEffect } can still read those keys.
  return {
    approvalRequired: auth.decision === "wait_human_commit",
    externalEffect: auth.externalEffect,
    decision: auth.decision,
    reasonCode: auth.reasonCode,
    authorization: auth,
    capabilityContractHash: auth.capabilityContractHash,
  };
}

export { decideCapabilityPolicy, assertAuthorizationAllow };
