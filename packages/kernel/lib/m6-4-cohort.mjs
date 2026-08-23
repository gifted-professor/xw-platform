import { createHash } from "node:crypto";

export const M6_4_COHORT_RULES = Object.freeze({
  M6_4_SHADOW: Object.freeze({ attempts: 5, minimumSucceeded: 5, actionPolicy: "ZERO" }),
  M6_4_HOT_CLOSE: Object.freeze({ attempts: 1, minimumSucceeded: 0, actionPolicy: "ZERO_OR_ONE" }),
  M6_4_ACTION_SMOKE: Object.freeze({ attempts: 3, minimumSucceeded: 3, actionPolicy: "BOUNDED" }),
  M6_4_RELIABILITY: Object.freeze({ attempts: 20, minimumSucceeded: 19, actionPolicy: "BOUNDED" }),
  M6_4_SMOOTH: Object.freeze({ attempts: 30, minimumSucceeded: 27, actionPolicy: "BOUNDED" }),
});

export const M6_4_SMOOTH_DISTRIBUTION = Object.freeze({
  "app-launch": 4, "app-switch": 4, search: 4, "text-input": 4,
  scroll: 4, "tab-back": 4, "form-edit": 3, "settings-nav": 3,
});

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function deriveM64CohortAggregateHash(aggregate) {
  const { aggregateHash: _ignored, ...payload } = aggregate || {};
  return createHash("sha256").update(`xw.m6-4-cohort-aggregate.v1:${canonical(payload)}`).digest("hex");
}

export function deriveM64CohortManifestHash(manifest) {
  const { manifestHash: _ignored, ...payload } = manifest || {};
  return createHash("sha256").update(`xw.m6-4-cohort-manifest.v1:${canonical(payload)}`).digest("hex");
}

export function validateM64CohortManifest(manifest) {
  const errors = [];
  const rule = M6_4_COHORT_RULES[manifest?.purpose];
  if (manifest?.schemaId !== "xw.m6-4-cohort-manifest.v1") errors.push("M64_MANIFEST_SCHEMA_INVALID");
  if (!rule) errors.push("M64_COHORT_PURPOSE_INVALID");
  if (manifest?.alias !== "01") errors.push("M64_COHORT_ALIAS_INVALID");
  if (!Array.isArray(manifest?.scenarios) || (rule && manifest.scenarios.length !== rule.attempts)) errors.push("M64_COHORT_CARDINALITY_INVALID");
  if (Array.isArray(manifest?.scenarios)) {
    const keys = manifest.scenarios.map((scenario) => scenario.scenarioKey);
    if (new Set(keys).size !== keys.length || manifest.scenarios.some((scenario) => scenario.alias !== "01" || scenario.authorized !== false
      || scenario.executionStatus !== "NOT_RUN" || !/^[0-9a-f]{64}$/u.test(scenario.oracleHash || "")
      || !/^[0-9a-f]{64}$/u.test(scenario.effectBoundaryHash || ""))) errors.push("M64_COHORT_SCENARIO_INVALID");
    if (manifest?.purpose === "M6_4_SMOOTH") {
      const counts = Object.fromEntries(Object.keys(M6_4_SMOOTH_DISTRIBUTION).map((family) => [family, 0]));
      for (const scenario of manifest.scenarios) if (Object.hasOwn(counts, scenario.primaryFamily)) counts[scenario.primaryFamily] += 1;
      if (canonical(counts) !== canonical(M6_4_SMOOTH_DISTRIBUTION)) errors.push("M64_SMOOTH_DISTRIBUTION_INVALID");
    }
  }
  if (manifest?.liveAuthorizationRef !== null || manifest?.gateFEligible !== false) errors.push("M64_MANIFEST_MUST_BE_OFFLINE");
  if (deriveM64CohortManifestHash(manifest) !== manifest?.manifestHash) errors.push("M64_MANIFEST_HASH_INVALID");
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

export function validateM64CohortAggregate(aggregate) {
  const errors = [];
  const rule = M6_4_COHORT_RULES[aggregate?.purpose];
  if (aggregate?.schemaId !== "xw.m6-4-cohort-aggregate.v1") errors.push("M64_COHORT_SCHEMA_INVALID");
  if (!rule) errors.push("M64_COHORT_PURPOSE_INVALID");
  if (aggregate?.alias !== "01") errors.push("M64_COHORT_ALIAS_INVALID");
  if (!Array.isArray(aggregate?.expectedScenarioKeys) || !Array.isArray(aggregate?.attempts)) {
    errors.push("M64_COHORT_ATTEMPTS_INVALID");
  } else if (rule) {
    if (aggregate.expectedScenarioKeys.length !== rule.attempts || aggregate.attempts.length !== rule.attempts) {
      errors.push("M64_COHORT_CARDINALITY_INVALID");
    }
    const expected = new Set(aggregate.expectedScenarioKeys);
    const actual = new Set(aggregate.attempts.map((attempt) => attempt.scenarioKey));
    if (expected.size !== rule.attempts || actual.size !== aggregate.attempts.length
      || [...expected].some((key) => !actual.has(key))) errors.push("M64_COHORT_SCENARIO_SUBSTITUTION");
    const successCount = aggregate.attempts.filter((attempt) => attempt.status === "SUCCEEDED").length;
    if (successCount < rule.minimumSucceeded) errors.push("M64_COHORT_SUCCESS_THRESHOLD");
    if (aggregate.attempts.some((attempt) => attempt.alias !== "01" || attempt.forbiddenEffectCount !== 0
      || attempt.publicEffectCount !== 0 || attempt.paymentAttemptCount !== 0 || attempt.deleteAttemptCount !== 0)) {
      errors.push("M64_COHORT_FORBIDDEN_EFFECT");
    }
    if (rule.actionPolicy === "ZERO" && aggregate.attempts.some((attempt) => attempt.actionCount !== 0 || attempt.transportCount !== 0)) {
      errors.push("M64_COHORT_ZERO_ACTION_VIOLATION");
    }
    if (rule.actionPolicy === "ZERO_OR_ONE" && aggregate.attempts.some((attempt) => attempt.actionCount > 1 || attempt.transportCount > 1)) {
      errors.push("M64_COHORT_HOT_CLOSE_BUDGET");
    }
  }
  if (deriveM64CohortAggregateHash(aggregate) !== aggregate?.aggregateHash) errors.push("M64_COHORT_HASH_INVALID");
  return { ok: errors.length === 0, errors };
}
