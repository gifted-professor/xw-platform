// AutonomyGrant validation and scope compilation for M6.
// Two layers, both pure and deterministic (`now` is a parameter):
//   - validateAutonomyGrantShape(document): schema shape only. Passing shape says
//     nothing about trust; callers must never treat it as authorization.
//   - validateAutonomyGrantTrusted(document, trustedContext): schema + authoritative
//     binding. trustedContext is mandatory and every field is required — a missing
//     registry, redline hash, issuer ref or clock fails closed. The issuer must carry
//     an authorizationRef matching trustedIssuerRef verbatim; self-declared
//     kind=user/operator/system alone never authorizes.
import {
  HARD_REDLINE_CATEGORY_NAMES,
  REDLINE_EFFECT_CLASSES,
  fail,
  loadM6ContractSchema,
  sha256Hex,
} from "./m6-contracts.mjs";
import { validateJsonSchema } from "../../../../control-plane/control-plane/lib/json-schema-validator.mjs";

export const M6_GRANT_ISSUER_KINDS = Object.freeze(["user", "operator", "system"]);

const GRANT_CODE = "INVALID_M6_AUTONOMY_GRANT";
const GRANT_CONTEXT_CODE = "M6_AUTONOMY_GRANT_CONTEXT_MISSING";

export function validateAutonomyGrantShape(document) {
  const errors = [];
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    fail(errors, GRANT_CODE, "grant must be an object");
    return { ok: false, errors };
  }
  if (document.schemaId !== "xw.autonomy-grant.v1") {
    fail(errors, GRANT_CODE, "schemaId must be xw.autonomy-grant.v1");
    return { ok: false, errors };
  }
  for (const message of validateJsonSchema(document, loadM6ContractSchema("xw.autonomy-grant.v1"))) {
    fail(errors, GRANT_CODE, message);
  }
  return { ok: errors.length === 0, errors };
}

function requireContext(trustedContext, errors) {
  const context = trustedContext || {};
  if (!Array.isArray(context.registeredActionFamilies) || context.registeredActionFamilies.length === 0) {
    fail(errors, GRANT_CONTEXT_CODE, "trustedContext.registeredActionFamilies must be a non-empty array");
  }
  if (typeof context.knownRedlinePolicySha256 !== "string" || context.knownRedlinePolicySha256.length === 0) {
    fail(errors, GRANT_CONTEXT_CODE, "trustedContext.knownRedlinePolicySha256 is required");
  }
  if (typeof context.trustedIssuerRef !== "string" || context.trustedIssuerRef.length === 0) {
    fail(errors, GRANT_CONTEXT_CODE, "trustedContext.trustedIssuerRef is required");
  }
  if (context.now === undefined || context.now === null) {
    fail(errors, GRANT_CONTEXT_CODE, "trustedContext.now is required");
  } else if (Number.isNaN(typeof context.now === "number" ? context.now : Date.parse(context.now))) {
    fail(errors, GRANT_CONTEXT_CODE, "trustedContext.now must be a valid timestamp");
  }
  return errors.length === 0;
}

export function validateAutonomyGrantTrusted(document, trustedContext) {
  const errors = [];
  // Fail closed on an incomplete authoritative context before trusting anything else.
  const contextOk = requireContext(trustedContext, errors);
  const shape = validateAutonomyGrantShape(document);
  errors.push(...shape.errors);
  if (!contextOk || !shape.ok) return { ok: false, errors };
  const grant = document;
  const code = GRANT_CODE;
  const context = trustedContext;

  // Trust: the issuer must present the exact authorization reference pinned by the
  // caller; the self-declared kind must also be a trusted actor kind.
  if (!M6_GRANT_ISSUER_KINDS.includes(grant.issuer.kind)) {
    fail(errors, code, `grant issuer kind is not a trusted actor: ${grant.issuer.kind}`);
  }
  if (grant.issuer.authorizationRef !== context.trustedIssuerRef) {
    fail(errors, code, "issuer.authorizationRef does not match the trusted issuer reference");
  }
  if (grant.goal.goalSha256 !== sha256Hex(grant.goal.raw)) {
    fail(errors, code, "goal.goalSha256 does not match the raw goal (forged goal binding)");
  }

  // Scope: intents must be a non-empty subset of the registered action families and
  // must never name hard-redline categories, even when explicitly listed. A grant
  // whose intents collapse to nothing after redline removal fails closed.
  const registered = new Set(context.registeredActionFamilies);
  if (!Array.isArray(grant.scope.intents) || grant.scope.intents.length === 0) {
    fail(errors, code, "grant scope.intents must be a non-empty array");
  } else {
    const effectiveIntents = [];
    for (const intent of grant.scope.intents) {
      if (HARD_REDLINE_CATEGORY_NAMES.includes(intent) || REDLINE_EFFECT_CLASSES.includes(intent)) {
        fail(errors, code, `grant cannot authorize hard-redline intent: ${intent}`);
        continue;
      }
      if (!registered.has(intent)) {
        fail(errors, code, `intent is not a registered action family: ${intent}`);
        continue;
      }
      effectiveIntents.push(intent);
    }
    if (effectiveIntents.length === 0) {
      fail(errors, code, "grant has no effective intents inside the registered action families");
    }
  }

  // Budgets: positive and within the AgenticSkillSpec maximums when provided.
  for (const [key, value] of Object.entries(grant.budgets)) {
    if (!Number.isInteger(value) || value <= 0) fail(errors, code, `budget ${key} must be a positive integer`);
    const limit = context.skillSpecLimits?.[key];
    if (limit !== undefined && value > limit) {
      fail(errors, code, `budget ${key} exceeds the AgenticSkillSpec maximum ${limit}`);
    }
  }

  // Validity window; the clock is authoritative input, never ambient.
  const notBefore = Date.parse(grant.notBefore);
  const notAfter = Date.parse(grant.notAfter);
  if (Number.isNaN(notBefore) || Number.isNaN(notAfter)) {
    fail(errors, code, "notBefore/notAfter must be valid date-time strings");
  } else {
    if (notAfter <= notBefore) fail(errors, code, "notAfter must be after notBefore");
    const nowMs = typeof context.now === "number" ? context.now : Date.parse(context.now);
    if (nowMs < notBefore) fail(errors, code, "grant is not yet valid (before notBefore)");
    if (nowMs >= notAfter) fail(errors, code, "grant is expired");
  }

  // The hard-redline reference is independent: it must point at the pinned policy and
  // can never be weakened by the grant.
  if (grant.hardRedlinePolicyRef.policySha256 !== context.knownRedlinePolicySha256) {
    fail(errors, code, "hardRedlinePolicyRef does not match the pinned hard-redline policy");
  }
  return { ok: errors.length === 0, errors };
}

// effectiveScope = AgenticSkillSpec maximum ∩ compiled TaskIntentSet ∩ actor/device/time/budget limits − hardRedlineSet
export function computeEffectiveScope({ skillSpec, taskIntentSet, limits = {}, hardRedlineSet = [] }) {
  const code = "INVALID_M6_EFFECTIVE_SCOPE";
  const errors = [];
  if (!skillSpec || typeof skillSpec !== "object") {
    fail(errors, code, "skillSpec is required");
    return { ok: false, errors };
  }
  if (!Array.isArray(taskIntentSet)) {
    fail(errors, code, "taskIntentSet must be an array");
    return { ok: false, errors };
  }
  const redline = new Set([...HARD_REDLINE_CATEGORY_NAMES, ...REDLINE_EFFECT_CLASSES, ...hardRedlineSet]);
  const specIntents = new Set(skillSpec.actionFamilies || []);
  const specApps = new Set(skillSpec.apps || []);
  const limitApps = limits.apps ? new Set(limits.apps) : null;
  const limitAliases = limits.aliases ? new Set(limits.aliases) : null;

  const intents = taskIntentSet.filter((intent) => {
    if (redline.has(intent)) return false;
    if (specIntents.size > 0 && !specIntents.has(intent)) return false;
    return true;
  });
  const dropped = taskIntentSet.filter((intent) => !intents.includes(intent));

  if (intents.length === 0) fail(errors, code, "effective intent scope is empty after intersection and hard-redline subtraction");
  let apps = [...specApps];
  if (limitApps) apps = apps.filter((app) => limitApps.has(app));
  if (apps.length === 0) fail(errors, code, "effective app scope is empty after intersection");

  let aliases = limits.aliases ? [...limitAliases] : [];
  if (limitAliases && aliases.length === 0) fail(errors, code, "effective alias scope is empty after intersection");

  const budgets = {};
  for (const key of ["maxSteps", "maxActions", "maxTokens", "wallClockSeconds"]) {
    const candidates = [skillSpec.maxBudgets?.[key], limits.budgets?.[key]].filter((v) => v !== undefined);
    if (candidates.length === 0) {
      fail(errors, code, `no budget bound available for ${key}`);
    } else {
      budgets[key] = Math.min(...candidates);
      if (budgets[key] <= 0) fail(errors, code, `effective budget ${key} must be positive`);
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    scope: {
      apps,
      aliases,
      intents,
      budgets,
      droppedIntents: dropped,
      hardRedlineSet: [...redline],
    },
  };
}
