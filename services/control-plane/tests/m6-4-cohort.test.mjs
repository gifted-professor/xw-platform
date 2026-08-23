import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveM64ActionSlotAuthority,
  deriveM64CohortAggregateHash,
  deriveM64CohortManifestHash,
  deriveM64CohortScenarioKeys,
  deriveM64ScenarioActionPlan,
  M6_4_FAMILY_ACTION_SEQUENCES,
  M6_4_COHORT_PURPOSES,
  M6_4_COHORT_RULES,
  M6_4_SMOOTH_DISTRIBUTION,
  validateM64CohortAggregate,
  validateM64CohortManifest,
  resolveM64CohortActionSlot,
} from "../../../packages/kernel/lib/m6-4-cohort.mjs";
import { deriveM6TrustedParameterHash } from "../../../packages/kernel/lib/m6-action-slot.mjs";

const H = (character) => character.repeat(64);

function aggregate(purpose, overrides = {}) {
  const rule = M6_4_COHORT_RULES[purpose];
  const keys = deriveM64CohortScenarioKeys(purpose);
  const hotClose = purpose === "M6_4_HOT_CLOSE";
  const raw = {
    schemaId: "xw.m6-4-cohort-aggregate.v1",
    purpose,
    alias: "01",
    expectedScenarioKeys: keys,
    attempts: keys.map((scenarioKey) => ({
      scenarioKey,
      alias: "01",
      status: hotClose ? "ABORTED_PENDING_CLOSEOUT" : "SUCCEEDED",
      actionCount: ["M6_4_SHADOW", "M6_4_HOT_CLOSE"].includes(purpose) ? 0 : 1,
      transportCount: ["M6_4_SHADOW", "M6_4_HOT_CLOSE"].includes(purpose) ? 0 : 1,
      forbiddenEffectCount: 0,
      publicEffectCount: 0,
      paymentAttemptCount: 0,
      deleteAttemptCount: 0,
    })),
    ...(hotClose ? {
      status: "FAILED",
      manifestHash: H("a"),
      gateEpochHash: H("b"),
      liveAuthorizationHash: H("c"),
      failureCloseout: {
        status: "FAILURE_CLOSEOUT",
        priorStatus: "ABORTED_PENDING_CLOSEOUT",
        scenarioKey: keys[0],
        purpose,
        manifestHash: H("a"),
        gateEpochHash: H("b"),
        liveAuthorizationHash: H("c"),
        evidenceHash: H("d"),
      },
    } : {}),
    ...overrides,
  };
  return { ...raw, aggregateHash: deriveM64CohortAggregateHash(raw) };
}

function rehash(value) {
  value.aggregateHash = deriveM64CohortAggregateHash(value);
  return value;
}

test("Gate F purpose constants and frozen scenario IDs are exact", () => {
  assert.deepEqual([...M6_4_COHORT_PURPOSES], [
    "M6_4_SHADOW",
    "M6_4_HOT_CLOSE",
    "M6_4_ACTION_SMOKE",
    "M6_4_RELIABILITY",
    "M6_4_SMOOTH",
  ]);
  assert.deepEqual(deriveM64CohortScenarioKeys("M6_4_HOT_CLOSE"), ["m6_4_hot_close-01"]);
  assert.deepEqual(deriveM64CohortScenarioKeys("M6_4_ACTION_SMOKE"), [
    "m6_4_action_smoke-01",
    "m6_4_action_smoke-02",
    "m6_4_action_smoke-03",
  ]);
});

test("purpose-specific cardinalities and thresholds validate without cross-window substitution", () => {
  for (const purpose of ["M6_4_SHADOW", "M6_4_ACTION_SMOKE", "M6_4_RELIABILITY", "M6_4_SMOOTH"]) {
    assert.deepEqual(validateM64CohortAggregate(aggregate(purpose)), { ok: true, errors: [] });
  }
});

test("HOT_CLOSE accepts only the bound zero-counter failure-closeout chain", () => {
  assert.deepEqual(validateM64CohortAggregate(aggregate("M6_4_HOT_CLOSE")), { ok: true, errors: [] });

  for (const field of ["actionCount", "transportCount"]) {
    const counterOne = aggregate("M6_4_HOT_CLOSE");
    counterOne.attempts[0][field] = 1;
    const errors = validateM64CohortAggregate(rehash(counterOne)).errors;
    assert.ok(errors.includes("M64_COHORT_ZERO_ACTION_VIOLATION"), `${field}=1 must fail`);
  }

  const wrongAggregateStatus = aggregate("M6_4_HOT_CLOSE");
  wrongAggregateStatus.status = "SUCCEEDED";
  assert.ok(validateM64CohortAggregate(rehash(wrongAggregateStatus)).errors.includes("M64_COHORT_HOT_CLOSE_LIFECYCLE_INVALID"));

  const wrongAttemptStatus = aggregate("M6_4_HOT_CLOSE");
  wrongAttemptStatus.attempts[0].status = "FAILED";
  assert.ok(validateM64CohortAggregate(rehash(wrongAttemptStatus)).errors.includes("M64_COHORT_HOT_CLOSE_LIFECYCLE_INVALID"));
});

test("HOT_CLOSE rejects missing, reversed, wrong-purpose, cross-bound, and forged closeout evidence", () => {
  const missing = aggregate("M6_4_HOT_CLOSE");
  delete missing.failureCloseout;
  assert.ok(validateM64CohortAggregate(rehash(missing)).errors.includes("M64_COHORT_HOT_CLOSE_CLOSEOUT_INVALID"));

  const reversed = aggregate("M6_4_HOT_CLOSE");
  reversed.failureCloseout.priorStatus = "FAILURE_CLOSEOUT";
  assert.ok(validateM64CohortAggregate(rehash(reversed)).errors.includes("M64_COHORT_HOT_CLOSE_CLOSEOUT_INVALID"));

  const wrongPurpose = aggregate("M6_4_HOT_CLOSE");
  wrongPurpose.failureCloseout.purpose = "M6_4_ACTION_SMOKE";
  assert.ok(validateM64CohortAggregate(rehash(wrongPurpose)).errors.includes("M64_COHORT_HOT_CLOSE_CLOSEOUT_INVALID"));

  const crossScenario = aggregate("M6_4_HOT_CLOSE");
  crossScenario.failureCloseout.scenarioKey = "m6_4_hot_close-replacement";
  assert.ok(validateM64CohortAggregate(rehash(crossScenario)).errors.includes("M64_COHORT_HOT_CLOSE_CLOSEOUT_INVALID"));

  for (const field of ["manifestHash", "gateEpochHash", "liveAuthorizationHash"]) {
    const crossBound = aggregate("M6_4_HOT_CLOSE");
    crossBound.failureCloseout[field] = H("e");
    assert.ok(validateM64CohortAggregate(rehash(crossBound)).errors.includes("M64_COHORT_HOT_CLOSE_BINDING_MISMATCH"), `${field} drift must fail`);
  }

  const missingWindowHash = aggregate("M6_4_HOT_CLOSE");
  delete missingWindowHash.liveAuthorizationHash;
  assert.ok(validateM64CohortAggregate(rehash(missingWindowHash)).errors.includes("M64_COHORT_HOT_CLOSE_BINDING_INVALID"));

  const missingEvidence = aggregate("M6_4_HOT_CLOSE");
  delete missingEvidence.failureCloseout.evidenceHash;
  assert.ok(validateM64CohortAggregate(rehash(missingEvidence)).errors.includes("M64_COHORT_HOT_CLOSE_CLOSEOUT_INVALID"));
});

test("cohort aggregates reject replacement, reordered, missing, and extra frozen scenarios", () => {
  const replacement = aggregate("M6_4_HOT_CLOSE");
  replacement.expectedScenarioKeys[0] = "m6_4_hot_close-replacement";
  replacement.attempts[0].scenarioKey = "m6_4_hot_close-replacement";
  replacement.failureCloseout.scenarioKey = "m6_4_hot_close-replacement";
  assert.ok(validateM64CohortAggregate(rehash(replacement)).errors.includes("M64_COHORT_SCENARIO_SUBSTITUTION"));

  const reordered = aggregate("M6_4_ACTION_SMOKE");
  [reordered.expectedScenarioKeys[0], reordered.expectedScenarioKeys[1]] = [reordered.expectedScenarioKeys[1], reordered.expectedScenarioKeys[0]];
  [reordered.attempts[0], reordered.attempts[1]] = [reordered.attempts[1], reordered.attempts[0]];
  assert.ok(validateM64CohortAggregate(rehash(reordered)).errors.includes("M64_COHORT_SCENARIO_SUBSTITUTION"));

  const missing = aggregate("M6_4_HOT_CLOSE");
  missing.expectedScenarioKeys = [];
  missing.attempts = [];
  assert.ok(validateM64CohortAggregate(rehash(missing)).errors.includes("M64_COHORT_CARDINALITY_INVALID"));

  const extra = aggregate("M6_4_HOT_CLOSE");
  extra.expectedScenarioKeys.push("m6_4_hot_close-02");
  extra.attempts.push({ ...extra.attempts[0], scenarioKey: "m6_4_hot_close-02" });
  assert.ok(validateM64CohortAggregate(rehash(extra)).errors.includes("M64_COHORT_CARDINALITY_INVALID"));

  const malformed = aggregate("M6_4_HOT_CLOSE");
  malformed.attempts = [null];
  assert.equal(validateM64CohortAggregate(rehash(malformed)).ok, false);
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
    : Array(M6_4_COHORT_RULES[purpose].attempts).fill(
      purpose === "M6_4_RELIABILITY" ? "search" : purpose === "M6_4_ACTION_SMOKE" ? "tab-back" : "app-launch",
    );
  const raw = {
    schemaId: "xw.m6-4-cohort-manifest.v1", purpose, alias: "01", gateFEligible: false, liveAuthorizationRef: null,
    scenarios: families.map((primaryFamily, index) => {
      const scenarioKey = deriveM64CohortScenarioKeys(purpose)[index];
      const oracleHash = `${index}`.padStart(64, "a");
      const effectBoundaryHash = `${index}`.padStart(64, "b");
      const sequence = M6_4_COHORT_RULES[purpose].actionPolicy === "ZERO" ? [] : M6_4_FAMILY_ACTION_SEQUENCES[primaryFamily];
      const slots = sequence.map(({ primitive, targetKind, role }, sequenceIndex) => {
        const trustedParams = primitive === "open_app" ? { appRef: H(String(sequenceIndex + 1)) }
          : primitive === "type_search_text" ? { textRef: H(String(sequenceIndex + 1)) }
            : primitive === "scroll" ? { direction: sequenceIndex === 0 ? "down" : "up", distanceTier: "short" }
              : {};
        return deriveM64ActionSlotAuthority({
          schemaId: "xw.m6-action-slot-authority.v1", sequenceIndex,
          logicalStepId: `${scenarioKey}:step-${sequenceIndex + 1}`, actionSlotOrdinal: 0,
          primitive, actionFamily: `${primaryFamily}:${role}`, intentRef: H("1"), intentPolicyHash: H("2"),
          targetKind, targetEligibilityHash: H("3"), trustedParams,
          trustedParameterHash: deriveM6TrustedParameterHash(trustedParams), allowedStateHash: H("4"),
          effectBoundaryHash, budgetPolicyHash: H("5"), redlinePolicyHash: H("6"), resetPolicyHash: H("7"),
          oracleHash, verificationPolicyHash: H("8"),
        });
      });
      return {
        scenarioKey, alias: "01", primaryFamily, authorized: false, executionStatus: "NOT_RUN",
        oracleHash, effectBoundaryHash, actionPlan: deriveM64ScenarioActionPlan({ slots }),
      };
    }),
  };
  return { ...raw, manifestHash: deriveM64CohortManifestHash(raw) };
}

test("offline frozen cohort manifests enforce cardinality and exact smooth distribution", () => {
  for (const purpose of Object.keys(M6_4_COHORT_RULES)) assert.deepEqual(validateM64CohortManifest(manifest(purpose)), { ok: true, errors: [] });
  const replacement = manifest("M6_4_HOT_CLOSE");
  replacement.scenarios[0].scenarioKey = "m6_4_hot_close-replacement";
  replacement.manifestHash = deriveM64CohortManifestHash(replacement);
  assert.ok(validateM64CohortManifest(replacement).errors.includes("M64_COHORT_SCENARIO_INVALID"));
  const smooth = manifest("M6_4_SMOOTH");
  smooth.scenarios[0].primaryFamily = "search";
  smooth.manifestHash = deriveM64CohortManifestHash(smooth);
  assert.ok(validateM64CohortManifest(smooth).errors.includes("M64_SMOOTH_DISTRIBUTION_INVALID"));
});

test("frozen family plans enumerate every physical write and resolver rejects swapped authority", () => {
  const reliability = manifest("M6_4_RELIABILITY");
  const scenario = reliability.scenarios[0];
  assert.deepEqual(scenario.actionPlan.slots.map((slot) => slot.primitive), [
    "open_app", "tap", "type_search_text", "tap", "back",
  ]);
  assert.equal(scenario.actionPlan.maxActionCount, 5);
  const frozen = scenario.actionPlan.slots[2];
  const resolved = resolveM64CohortActionSlot({
    manifest: reliability,
    scenarioId: scenario.scenarioKey,
    logicalStepId: frozen.logicalStepId,
    actionSlotOrdinal: frozen.actionSlotOrdinal,
    request: {
      primitive: frozen.primitive,
      intentRef: frozen.intentRef,
      targetKind: frozen.targetKind,
      trustedParams: frozen.trustedParams,
    },
  });
  assert.equal(resolved.sequenceIndex, 2);
  assert.equal(resolved.actionSlotSpec.actionSlotSpecHash.length, 64);

  for (const mutation of [
    { logicalStepId: scenario.actionPlan.slots[1].logicalStepId },
    { request: { ...resolved.slotAuthority, primitive: "tap", trustedParams: frozen.trustedParams } },
    { request: { ...resolved.slotAuthority, intentRef: H("9"), trustedParams: frozen.trustedParams } },
    { request: { ...resolved.slotAuthority, trustedParams: { textRef: H("9") } } },
    { request: { unexpectedAuthority: H("9") } },
  ]) {
    assert.throws(() => resolveM64CohortActionSlot({
      manifest: reliability,
      scenarioId: scenario.scenarioKey,
      logicalStepId: frozen.logicalStepId,
      actionSlotOrdinal: frozen.actionSlotOrdinal,
      request: {
        primitive: frozen.primitive,
        intentRef: frozen.intentRef,
        targetKind: frozen.targetKind,
        trustedParams: frozen.trustedParams,
        ...(mutation.request || {}),
      },
      ...mutation,
    }), { code: "M64_ACTION_SLOT_REQUEST_MISMATCH" });
  }
});
