import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  M64_LIVE_ACTION_EVIDENCE_SCHEMA_ID,
  M64_LIVE_ATTEMPT_EVIDENCE_SCHEMA_ID,
  deriveM64ActionEvidence,
  deriveM64AttemptEvidence,
  deriveM64ExpectedStateArtifact,
  deriveM64IndependentEffectObservation,
  validateM64AttemptEvidence,
  validateM64AttemptEvidenceIntegrity,
} from "../lib/m6-live-evidence.mjs";

const H = (value) => createHash("sha256").update(value).digest("hex");
const manifest = JSON.parse(readFileSync(new URL("../../../artifacts/m6-4/cohort-manifests/m6_4_action_smoke.json", import.meta.url), "utf8"));
const boundary = JSON.parse(readFileSync(new URL("../../../artifacts/m6-4/cohort-manifests/xw.m6-effect-boundary.v1.json", import.meta.url), "utf8"));
const scenario = manifest.scenarios[0];
const rule = boundary.families.find((entry) => entry.primaryFamily === scenario.primaryFamily);

function evidenceFixture() {
  const expected = deriveM64ExpectedStateArtifact({
    schemaId: "xw.m6-4-independent-expected-state.v1",
    purpose: manifest.purpose,
    manifestHash: manifest.manifestHash,
    scenarioKey: scenario.scenarioKey,
    primaryFamily: scenario.primaryFamily,
    oracleHash: scenario.oracleHash,
    effectBoundaryHash: scenario.effectBoundaryHash,
    environmentAttestationHash: H("environment"),
    accountIsolationHash: H("account"),
    expectedStateHash: H("expected-state"),
    independentAuthorHash: H("independent-author"),
    sourceClass: "INDEPENDENT_PRE_DISPATCH",
    selfDerived: false,
    authoredAt: "2029-12-31T23:00:00.000Z",
    expiresAt: "2030-01-01T01:00:00.000Z",
  });
  const counters = Object.freeze({
    forbiddenEffectCount: 0,
    publicEffectCount: 0,
    paymentAttemptCount: 0,
    deleteAttemptCount: 0,
    misclickCount: 0,
    staleActionCount: 0,
    duplicateActionCount: 0,
    unknownReplayCount: 0,
    riskChallengeCount: 0,
    unknownEffectCount: 0,
    actionApprovalPromptCount: 0,
    humanInterventionCount: 0,
  });
  const oracleEvidence = deriveM64IndependentEffectObservation({
    schemaId: "xw.m6-4-independent-effect-observation.v1",
    phase: "final",
    sourceClass: "INDEPENDENT_POST_DISPATCH",
    selfDerived: false,
    scenarioKey: scenario.scenarioKey,
    primaryFamily: scenario.primaryFamily,
    oracleHash: scenario.oracleHash,
    effectBoundaryHash: scenario.effectBoundaryHash,
    environmentAttestationHash: expected.environmentAttestationHash,
    accountIsolationHash: expected.accountIsolationHash,
    expectedArtifactHash: expected.expectedArtifactHash,
    independentObserverHash: H("independent-observer"),
    actualStateHash: expected.expectedStateHash,
    sourceEvidenceHash: H("oracle-source-evidence"),
    observedEffects: [],
    resetResults: Object.fromEntries(rule.resetObligations.map((obligation) => [obligation, true])),
    counters,
    observedAt: "2030-01-01T00:10:00.000Z",
  });
  const actionCount = scenario.actionPlan.maxActionCount;
  const actionEvidence = deriveM64ActionEvidence({
    schemaId: M64_LIVE_ACTION_EVIDENCE_SCHEMA_ID,
    actionCount,
    transportCount: actionCount,
    verifiedActionCount: actionCount,
    actionTraceHashes: Array.from({ length: actionCount }, (_, index) => H(`trace-${index}`)),
  });
  const run = Object.freeze({
    runId: "run:m64-live-evidence-test",
    bindingHash: H("binding"),
    status: "COMPLETED",
    actionCount,
  });
  const window = Object.freeze({
    manifest,
    authorization: Object.freeze({ envelopeHash: H("authorization"), gateEpochHash: H("gate") }),
  });
  const attempt = deriveM64AttemptEvidence({
    schemaId: M64_LIVE_ATTEMPT_EVIDENCE_SCHEMA_ID,
    purpose: manifest.purpose,
    manifestHash: manifest.manifestHash,
    scenarioKey: scenario.scenarioKey,
    liveAuthorizationHash: window.authorization.envelopeHash,
    gateEpochHash: window.authorization.gateEpochHash,
    bindingHash: run.bindingHash,
    runId: run.runId,
    runStatusBeforeClose: run.status,
    status: "SUCCEEDED",
    expectedArtifactHash: expected.expectedArtifactHash,
    actionEvidence,
    oracleEvidence,
  });
  return { attempt, expected, run, window };
}

test("M6 live attempt evidence re-derives every nested hash and rejects post-close tampering", () => {
  const value = evidenceFixture();
  assert.equal(validateM64AttemptEvidence(value.attempt, {
    boundary,
    expected: value.expected,
    run: value.run,
    scenario,
    window: value.window,
  }).ok, true);
  const tampered = {
    ...value.attempt,
    oracleEvidence: {
      ...value.attempt.oracleEvidence,
      counters: { ...value.attempt.oracleEvidence.counters, publicEffectCount: 1 },
    },
  };
  assert.ok(validateM64AttemptEvidenceIntegrity(tampered).errors.includes("M64_ATTEMPT_ORACLE_HASH_INVALID"));
});

test("an oracle authored and observed by the same source remains circular even after every hash is re-sealed", () => {
  const value = evidenceFixture();
  const circularObservation = deriveM64IndependentEffectObservation({
    ...value.attempt.oracleEvidence,
    independentObserverHash: value.expected.independentAuthorHash,
  });
  const circularAttempt = deriveM64AttemptEvidence({ ...value.attempt, oracleEvidence: circularObservation });
  const validation = validateM64AttemptEvidence(circularAttempt, {
    boundary,
    expected: value.expected,
    run: value.run,
    scenario,
    window: value.window,
  });
  assert.ok(validation.critical.includes("M64_ATTEMPT_EXPECTED_STATE_MISMATCH"));
});

test("independent observations cannot omit counters and receive synthetic zero defaults", () => {
  const value = evidenceFixture();
  const missingCounters = { ...value.attempt.oracleEvidence };
  delete missingCounters.counters;
  assert.throws(() => deriveM64IndependentEffectObservation(missingCounters));
});
