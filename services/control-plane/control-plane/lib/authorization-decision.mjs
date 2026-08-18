/**
 * Capability AuthorizationDecision (Foundation PR1).
 * Control Plane is the only authority for allow | wait_human_commit | block.
 */

import { decideProtectedCommit } from "./protected-commit-policy.mjs";
import { normalizeCapabilityEffect, isBusinessEffectClass } from "./capability-effect.mjs";
import { ControlPlaneError } from "./errors.mjs";
import { newId, nowIso } from "./canonical.mjs";

const LOW_MATURITY = new Set(["E0", "E1"]);
const STANDING_GRANT_MISSION_ONLY = new Set(["xhs.collect.standing_grant"]);

/**
 * @returns {AuthorizationDecision}
 */
export function decideCapabilityPolicy(capability, context = {}) {
  const {
    canary = false,
    invocation = "job",
    policyMode = null,
    actorId = null,
    deviceAlias = null,
    principalId = null,
  } = context;

  const effect = capability.normalizedEffect || normalizeCapabilityEffect(capability);
  const evaluatedAt = nowIso();
  const decisionId = newId("auth");

  const baseSubject = {
    actorId: actorId || null,
    principalId: principalId || null,
    capabilityId: capability.id,
    deviceAlias: deviceAlias || null,
  };

  const protectedHit = decideProtectedCommit(effect);
  if (protectedHit.protected) {
    return makeDecision({
      decision: "wait_human_commit",
      reasonCode: "PROTECTED_COMMIT_REQUIRED",
      decisionId,
      evaluatedAt,
      subject: baseSubject,
      effect,
      policyMode,
      capability,
    });
  }

  if (capability.exposure === "internal" && invocation === "job") {
    return makeDecision({
      decision: "block",
      reasonCode: "INTERNAL_CAPABILITY",
      decisionId,
      evaluatedAt,
      subject: baseSubject,
      effect,
      policyMode,
      capability,
    });
  }

  if (STANDING_GRANT_MISSION_ONLY.has(capability.id) && invocation !== "mission_effect") {
    return makeDecision({
      decision: "block",
      reasonCode: "STANDING_GRANT_MISSION_REQUIRED",
      decisionId,
      evaluatedAt,
      subject: baseSubject,
      effect,
      policyMode,
      capability,
    });
  }
  // Mission-only standing grant: allow on mission_effect regardless of pilot mode
  // (parent Mission/ECP authority is the gate, not nonpayment pilot).
  if (STANDING_GRANT_MISSION_ONLY.has(capability.id) && invocation === "mission_effect") {
    return makeDecision({
      decision: "allow",
      reasonCode: "STANDING_GRANT_MISSION_EFFECT",
      decisionId,
      evaluatedAt,
      subject: baseSubject,
      effect,
      policyMode,
      capability,
    });
  }

  const mode = capability.automationPolicy?.mode;
  if (mode === "disabled" || capability.availability === "disabled") {
    return makeDecision({
      decision: "block",
      reasonCode: "CAPABILITY_DISABLED",
      decisionId,
      evaluatedAt,
      subject: baseSubject,
      effect,
      policyMode,
      capability,
    });
  }

  if (capability.availability === "classification_required" || capability.lifecycle === "draft") {
    return makeDecision({
      decision: "block",
      reasonCode: "EFFECT_CLASSIFICATION_REQUIRED",
      decisionId,
      evaluatedAt,
      subject: baseSubject,
      effect,
      policyMode,
      capability,
    });
  }

  if ((LOW_MATURITY.has(capability.maturity) || mode === "lab_only") && (!canary || invocation !== "session")) {
    return makeDecision({
      decision: "block",
      reasonCode: "CANARY_SESSION_REQUIRED",
      decisionId,
      evaluatedAt,
      subject: baseSubject,
      effect,
      policyMode,
      capability,
    });
  }

  if ((capability.automationPolicy?.canaryOnly || capability.availability === "canary_only") && !canary) {
    return makeDecision({
      decision: "block",
      reasonCode: "CANARY_REQUIRED",
      decisionId,
      evaluatedAt,
      subject: baseSubject,
      effect,
      policyMode,
      capability,
    });
  }

  // pilot out-of-scope under nonpayment_v1 pilotOnly
  if (policyMode?.pilotOnly === true && policyMode?.pilotScope === "out_of_scope") {
    return makeDecision({
      decision: "block",
      reasonCode: "AUTONOMY_PILOT_SCOPE_MISS",
      decisionId,
      evaluatedAt,
      subject: baseSubject,
      effect,
      policyMode,
      capability,
    });
  }

  const business = isBusinessEffectClass(effect.class);
  const active = policyMode && policyMode.active === true;

  // shadow / legacy: only none/reversible automatic; business effects block (no ordinary approval)
  if (!active && business) {
    return makeDecision({
      decision: "block",
      reasonCode: "AUTONOMY_INACTIVE",
      decisionId,
      evaluatedAt,
      subject: baseSubject,
      effect,
      policyMode,
      capability,
    });
  }

  // active pilot / nonpayment: allow non-protected effects that passed gates
  return makeDecision({
    decision: "allow",
    reasonCode: active ? "NONPAYMENT_AUTONOMY_ACTIVE" : "REVERSIBLE_OR_NONE_AUTOMATIC",
    decisionId,
    evaluatedAt,
    subject: baseSubject,
    effect,
    policyMode,
    capability,
  });
}

function makeDecision({
  decision,
  reasonCode,
  decisionId,
  evaluatedAt,
  subject,
  effect,
  policyMode,
  capability,
}) {
  return {
    decision,
    reasonCode,
    policyVersion: "xhs.nonpayment-autonomy.v1",
    decisionId,
    evaluatedAt,
    subject,
    effect: {
      class: effect.class,
      phase: effect.phase,
      commitBoundary: effect.commitBoundary,
    },
    capabilityContractHash: capability.capabilityContractHash || null,
    capabilityContractHashAlgorithm: capability.capabilityContractHash
      ? (capability.capabilityContractHashAlgorithm || "legacy_algorithm_unknown")
      : null,
    implementationClosureHash: capability.implementation?.implementationClosureHash
      || capability.implementationClosureHash
      || null,
    tcbManifestRef: capability.implementation?.tcbManifestRef
      || capability.tcbManifestRef
      || null,
    // compatibility projection (deprecated; not an authority)
    approvalRequired: decision === "wait_human_commit",
    externalEffect: isBusinessEffectClass(effect.class),
    effectiveDecisionSource: policyMode?.effectiveDecisionSource ?? null,
    pilotScope: policyMode?.pilotScope ?? null,
  };
}

/** Throw ControlPlaneError for non-allow decisions used on submit paths. */
export function assertAuthorizationAllow(auth) {
  if (auth.decision === "allow") return auth;
  if (auth.decision === "wait_human_commit") {
    throw new ControlPlaneError(
      auth.reasonCode || "PROTECTED_COMMIT_REQUIRED",
      `protected commit required for ${auth.subject?.capabilityId}`,
      { status: 409, details: { authorization: auth } },
    );
  }
  throw new ControlPlaneError(
    auth.reasonCode || "CAPABILITY_BLOCKED",
    `capability blocked: ${auth.reasonCode}`,
    { status: 403, details: { authorization: auth } },
  );
}
