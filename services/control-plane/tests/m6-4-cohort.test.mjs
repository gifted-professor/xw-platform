import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveM64CohortAggregateHash,
  deriveM64CohortManifestHash,
  M6_4_COHORT_RULES,
  M6_4_SMOOTH_DISTRIBUTION,
  validateM64CohortAggregate,
  validateM64CohortManifest,
} from "../../../packages/kernel/lib/m6-4-cohort.mjs";

function aggregate(purpose, overrides = {}) {
  const rule = M6_4_COHORT_RULES[purpose];
  const keys = Array.from({ length: rule.attempts }, (_, index) => `${purpose.toLowerCase()}-${index + 1}`);
  const raw = {
    schemaId: "xw.m6-4-cohort-aggregate.v1",
    purpose,
    alias: "01",
    expectedScenarioKeys: keys,
    attempts: keys.map((scenarioKey) => ({
      scenarioKey,
      alias: "01",
      status: "SUCCEEDED",
      actionCount: purpose === "M6_4_SHADOW" ? 0 : 1,
      transportCount: purpose === "M6_4_SHADOW" ? 0 : 1,
      forbiddenEffectCount: 0,
      publicEffectCount: 0,
      paymentAttemptCount: 0,
      deleteAttemptCount: 0,
    })),
    ...overrides,
  };
  return { ...raw, aggregateHash: deriveM64CohortAggregateHash(raw) };
}

test("purpose-specific cardinalities and thresholds validate without cross-window substitution", () => {
  for (const purpose of ["M6_4_SHADOW", "M6_4_ACTION_SMOKE", "M6_4_RELIABILITY", "M6_4_SMOOTH"]) {
    assert.deepEqual(validateM64CohortAggregate(aggregate(purpose)), { ok: true, errors: [] });
  }
});

test("shadow action, substituted scenario, and forbidden effect fail closed", () => {
  const shadow = aggregate("M6_4_SHADOW");
  shadow.attempts[0].actionCount = 1;
  shadow.aggregateHash = deriveM64CohortAggregateHash(shadow);
  assert.ok(validateM64CohortAggregate(shadow).errors.includes("M64_COHORT_ZERO_ACTION_VIOLATION"));
  const reliability = aggregate("M6_4_RELIABILITY");
  reliability.attempts[0].scenarioKey = "replacement";
  reliability.attempts[1].publicEffectCount = 1;
  reliability.aggregateHash = deriveM64CohortAggregateHash(reliability);
  const errors = validateM64CohortAggregate(reliability).errors;
  assert.ok(errors.includes("M64_COHORT_SCENARIO_SUBSTITUTION"));
  assert.ok(errors.includes("M64_COHORT_FORBIDDEN_EFFECT"));
});

function manifest(purpose) {
  const families = purpose === "M6_4_SMOOTH"
    ? Object.entries(M6_4_SMOOTH_DISTRIBUTION).flatMap(([family, count]) => Array(count).fill(family))
    : Array(M6_4_COHORT_RULES[purpose].attempts).fill(purpose === "M6_4_RELIABILITY" ? "search" : "safe-navigation");
  const raw = {
    schemaId: "xw.m6-4-cohort-manifest.v1", purpose, alias: "01", gateFEligible: false, liveAuthorizationRef: null,
    scenarios: families.map((primaryFamily, index) => ({ scenarioKey: `${purpose}-${index + 1}`, alias: "01", primaryFamily, authorized: false, executionStatus: "NOT_RUN", oracleHash: `${index}`.padStart(64, "a"), effectBoundaryHash: `${index}`.padStart(64, "b") })),
  };
  return { ...raw, manifestHash: deriveM64CohortManifestHash(raw) };
}

test("offline frozen cohort manifests enforce cardinality and exact smooth distribution", () => {
  for (const purpose of Object.keys(M6_4_COHORT_RULES)) assert.deepEqual(validateM64CohortManifest(manifest(purpose)), { ok: true, errors: [] });
  const smooth = manifest("M6_4_SMOOTH");
  smooth.scenarios[0].primaryFamily = "search";
  smooth.manifestHash = deriveM64CohortManifestHash(smooth);
  assert.ok(validateM64CohortManifest(smooth).errors.includes("M64_SMOOTH_DISTRIBUTION_INVALID"));
});
