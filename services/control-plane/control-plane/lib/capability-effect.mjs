/**
 * Capability effect normalization + contract hash helpers (Foundation P0-A / PR1).
 */

import { canonicalJson, sha256 } from "./canonical.mjs";
import { ControlPlaneError } from "./errors.mjs";

const LEGAL = new Map([
  ["none|na|automatic", true],
  ["reversible|na|automatic", true],
  ["reversible|prepare|automatic", true],
  ["social|final|automatic", true],
  ["publish|prepare|automatic", true],
  ["publish|final|protected_human_commit", true],
  ["payment|prepare|automatic", true],
  ["payment|final|protected_human_commit", true],
  ["delete|prepare|automatic", true],
  ["delete|trash|automatic", true],
  ["delete|final|protected_human_commit", true],
]);

const BUSINESS = new Set(["social", "publish", "payment", "delete"]);

export function isBusinessEffectClass(effectClass) {
  return BUSINESS.has(effectClass);
}

/**
 * Normalize explicit effect or fail closed.
 * @returns {{ class, phase, commitBoundary, legacyDerived?: boolean }}
 */
export function normalizeCapabilityEffect(capability) {
  if (capability?.financialCommit === true || capability?.automationPolicy?.mode === "financial_commit") {
    if (capability?.effect && !effectsEqual(capability.effect, { class: "payment", phase: "final", commitBoundary: "protected_human_commit" })) {
      throw new ControlPlaneError(
        "EFFECT_CONTRACT_MISMATCH",
        `${capability.id}: financialCommit conflicts with explicit effect`,
        { status: 400 },
      );
    }
    return { class: "payment", phase: "final", commitBoundary: "protected_human_commit", legacyDerived: false };
  }

  if (capability?.effect) {
    const normalized = assertLegalEffect(capability.effect, capability.id);
    return { ...normalized, legacyDerived: false };
  }

  // PR1 migration: derive from risk/idempotency and mark legacyDerived.
  // Live manifests should migrate to explicit effect; missing effect is not default-none silently.
  return { ...legacyDeriveEffect(capability), legacyDerived: true };
}

function effectsEqual(a, b) {
  return a?.class === b.class && a?.phase === b.phase && a?.commitBoundary === b.commitBoundary;
}

function assertLegalEffect(effect, capabilityId) {
  if (!effect || typeof effect !== "object") {
    throw new ControlPlaneError("EFFECT_CONTRACT_MISMATCH", `${capabilityId}: effect must be an object`, { status: 400 });
  }
  const { class: cls, phase, commitBoundary } = effect;
  const key = `${cls}|${phase}|${commitBoundary}`;
  if (!LEGAL.has(key)) {
    throw new ControlPlaneError(
      "EFFECT_CONTRACT_MISMATCH",
      `${capabilityId}: illegal effect combination ${key}`,
      { status: 400, details: { effect } },
    );
  }
  return { class: cls, phase, commitBoundary };
}

function legacyDeriveEffect(capability) {
  const id = capability?.id || "<unknown>";
  const mode = capability?.automationPolicy?.mode;
  if (mode === "financial_commit") {
    return { class: "payment", phase: "final", commitBoundary: "protected_human_commit" };
  }
  const risk = capability?.risk;
  const idem = capability?.idempotency;
  // Match pre-Foundation externalEffect fact: R2/R3 or external/ambiguous idempotency
  // are business effects even when idempotency is loosely tagged read_only.
  if (["external_effect", "ambiguous_on_timeout"].includes(idem) || risk === "R2" || risk === "R3") {
    if (typeof id === "string" && id.includes("publish") && (id.includes("dry_run") || id.includes("draft"))) {
      return { class: "publish", phase: "prepare", commitBoundary: "automatic" };
    }
    if (typeof id === "string" && id.includes("payment")) {
      return { class: "payment", phase: "final", commitBoundary: "protected_human_commit" };
    }
    if (typeof id === "string" && id.includes("delete")) {
      return { class: "delete", phase: "final", commitBoundary: "protected_human_commit" };
    }
    return { class: "social", phase: "final", commitBoundary: "automatic" };
  }
  if (idem === "read_only" || risk === "R0") {
    return { class: "none", phase: "na", commitBoundary: "automatic" };
  }
  if (idem === "replay_safe") {
    return { class: "reversible", phase: "na", commitBoundary: "automatic" };
  }
  if (typeof id === "string" && id.includes("publish") && (id.includes("dry_run") || id.includes("draft"))) {
    return { class: "publish", phase: "prepare", commitBoundary: "automatic" };
  }
  return { class: "reversible", phase: "na", commitBoundary: "automatic" };
}

/**
 * Stable capability contract hash (64 hex, no sha256: prefix).
 * PR1: does not yet require implementationClosureHash (that is PR2).
 */
export function computeCapabilityContractHash(capability, normalizedEffect) {
  const effect = normalizedEffect || normalizeCapabilityEffect(capability);
  const body = {
    id: capability.id,
    appId: capability.appId,
    packageName: capability.packageName,
    versionRange: capability.versionRange,
    availability: capability.availability ?? null,
    exposure: capability.exposure ?? "public",
    invocationPolicy: capability.invocationPolicy ?? null,
    maturity: capability.maturity,
    risk: capability.risk,
    resources: capability.resources,
    inputSchema: capability.inputSchema,
    outputSchema: capability.outputSchema,
    normalizedEffect: { class: effect.class, phase: effect.phase, commitBoundary: effect.commitBoundary },
    idempotency: capability.idempotency,
    automationPolicy: capability.automationPolicy,
    verification: capability.verification,
    restoration: capability.restoration,
    timeoutMs: capability.timeoutMs,
    implementation: capability.implementation,
    lifecycle: capability.lifecycle ?? null,
  };
  return sha256(canonicalJson(body));
}

export function attachNormalizedEffect(capability) {
  const normalizedEffect = normalizeCapabilityEffect(capability);
  const capabilityContractHash = computeCapabilityContractHash(capability, normalizedEffect);
  return {
    ...capability,
    normalizedEffect,
    capabilityContractHash,
    externalEffect: isBusinessEffectClass(normalizedEffect.class),
  };
}

export function isClassificationStub(capability) {
  return capability?.lifecycle === "draft"
    || capability?.availability === "classification_required";
}
