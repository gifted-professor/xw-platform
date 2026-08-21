// AutonomyGrant semantic validation and scope compilation for M6.
// Schema shape is enforced by m6-contracts.mjs against xw.autonomy-grant.v1; this module
// adds the trust and safety invariants: no model-issued grants, intents limited to
// registered action families, budgets within the AgenticSkillSpec maximums, validity
// window, and payment/delete intents rejected even when explicitly listed.
// Pure functions only: no device IO, no network, deterministic (`now` is a parameter).
import {
  HARD_REDLINE_CATEGORY_NAMES,
  REDLINE_EFFECT_CLASSES,
  fail,
  loadM6ContractSchema,
  sha256Hex,
} from "./m6-contracts.mjs";
import { validateJsonSchema } from "../../../../control-plane/control-plane/lib/json-schema-validator.mjs";

export const M6_GRANT_ISSUER_KINDS = Object.freeze(["user", "operator", "system"]);

export function validateAutonomyGrant(grant, {
  registeredActionFamilies = [],
  skillSpecLimits = null,
  now = null,
  knownRedlinePolicySha256 = null,
} = {}) {
  const code = "INVALID_M6_AUTONOMY_GRANT";
  const errors = [];
  if (!grant || typeof grant !== "object" || Array.isArray(grant)) {
    fail(errors, code, "grant must be an object");
    return { ok: false, errors };
  }
  if (grant.schemaId !== "xw.autonomy-grant.v1") {
    fail(errors, code, "schemaId must be xw.autonomy-grant.v1");
    return { ok: false, errors };
  }
  for (const message of validateJsonSchema(grant, loadM6ContractSchema("xw.autonomy-grant.v1"))) {
    fail(errors, code, message);
  }
  if (errors.length > 0) return { ok: false, errors };

  // Trust: the grant must come from a trusted actor, never from the model.
  if (!M6_GRANT_ISSUER_KINDS.includes(grant.issuer.kind)) {
    fail(errors, code, `grant issuer kind is not a trusted actor: ${grant.issuer.kind}`);
  }
  if (grant.goal.goalSha256 !== sha256Hex(grant.goal.raw)) {
    fail(errors, code, "goal.goalSha256 does not match the raw goal (forged goal binding)");
  }

  // Scope: intents must be registered action families and never redline categories,
  // even when explicitly listed in the grant document.
  const registered = new Set(registeredActionFamilies);
  for (const intent of grant.scope.intents) {
    if (HARD_REDLINE_CATEGORY_NAMES.includes(intent) || REDLINE_EFFECT_CLASSES.includes(intent)) {
      fail(errors, code, `grant cannot authorize hard-redline intent: ${intent}`);
    } else if (registered.size > 0 && !registered.has(intent)) {
      fail(errors, code, `intent is not a registered action family: ${intent}`);
    }
  }

  // Budgets: positive and within the AgenticSkillSpec maximums when provided.
  for (const [key, value] of Object.entries(grant.budgets)) {
    if (!Number.isInteger(value) || value <= 0) fail(errors, code, `budget ${key} must be a positive integer`);
    if (skillSpecLimits && skillSpecLimits[key] !== undefined && value > skillSpecLimits[key]) {
      fail(errors, code, `budget ${key} exceeds the AgenticSkillSpec maximum ${skillSpecLimits[key]}`);
    }
  }

  // Validity window.
  const notBefore = Date.parse(grant.notBefore);
  const notAfter = Date.parse(grant.notAfter);
  if (Number.isNaN(notBefore) || Number.isNaN(notAfter)) {
    fail(errors, code, "notBefore/notAfter must be valid date-time strings");
  } else {
    if (notAfter <= notBefore) fail(errors, code, "notAfter must be after notBefore");
    if (now !== null) {
      const nowMs = typeof now === "number" ? now : Date.parse(now);
      if (nowMs < notBefore) fail(errors, code, "grant is not yet valid (before notBefore)");
      if (nowMs >= notAfter) fail(errors, code, "grant is expired");
    }
  }

  // The hard-redline reference is independent: it must point at the known policy and
  // can never be weakened by the grant.
  if (knownRedlinePolicySha256 && grant.hardRedlinePolicyRef.policySha256 !== knownRedlinePolicySha256) {
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
