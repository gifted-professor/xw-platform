import { createHash } from "node:crypto";

import { M6_4_COHORT_RULES } from "./m6-4-cohort.mjs";
import { verifyM64EffectObservation } from "./m6-effect-boundary.mjs";

const HASH = /^[0-9a-f]{64}$/u;
const NORMAL_TERMINAL_RUN_STATUSES = new Set(["COMPLETED", "FAILED", "WAITING"]);

export const M64_LIVE_EXPECTED_STATE_SCHEMA_ID = "xw.m6-4-independent-expected-state.v1";
export const M64_LIVE_ORACLE_OBSERVATION_SCHEMA_ID = "xw.m6-4-independent-effect-observation.v1";
export const M64_LIVE_ACTION_EVIDENCE_SCHEMA_ID = "xw.m6-4-action-evidence.v1";
export const M64_LIVE_ATTEMPT_EVIDENCE_SCHEMA_ID = "xw.m6-4-live-attempt-evidence.v1";

export const M64_LIVE_COUNTER_FIELDS = Object.freeze([
  "forbiddenEffectCount",
  "publicEffectCount",
  "paymentAttemptCount",
  "deleteAttemptCount",
  "misclickCount",
  "staleActionCount",
  "duplicateActionCount",
  "unknownReplayCount",
  "riskChallengeCount",
  "unknownEffectCount",
  "actionApprovalPromptCount",
  "humanInterventionCount",
]);

export const M64_LIVE_CRITICAL_ZERO_COUNTER_FIELDS = Object.freeze(
  M64_LIVE_COUNTER_FIELDS.filter((field) => field !== "humanInterventionCount"),
);

const EXPECTED_KEYS = Object.freeze([
  "accountIsolationHash", "authoredAt", "effectBoundaryHash", "environmentAttestationHash",
  "expectedArtifactHash", "expectedStateHash", "expiresAt", "independentAuthorHash", "manifestHash",
  "oracleHash", "primaryFamily", "purpose", "scenarioKey", "schemaId", "selfDerived", "sourceClass",
]);
const OBSERVATION_KEYS = Object.freeze([
  "accountIsolationHash", "actualStateHash", "counters", "effectBoundaryHash", "environmentAttestationHash",
  "expectedArtifactHash", "independentObserverHash", "observationHash", "observedAt", "observedEffects",
  "oracleHash", "phase", "primaryFamily", "resetResults", "scenarioKey", "schemaId", "selfDerived",
  "sourceClass", "sourceEvidenceHash",
]);
const ACTION_KEYS = Object.freeze([
  "actionCount", "actionEvidenceHash", "actionTraceHashes", "schemaId", "transportCount", "verifiedActionCount",
]);
const ATTEMPT_KEYS = Object.freeze([
  "actionEvidence", "attemptHash", "bindingHash", "expectedArtifactHash", "gateEpochHash",
  "liveAuthorizationHash", "manifestHash", "oracleEvidence", "purpose", "runId", "runStatusBeforeClose",
  "scenarioKey", "schemaId", "status",
]);

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha(domain, value) {
  return createHash("sha256").update(`${domain}:${canonical(value)}`).digest("hex");
}

function exactObject(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && canonical(Object.keys(value).sort()) === canonical([...keys].sort());
}

function selected(input, keys, hashKey) {
  return Object.fromEntries(keys.filter((key) => key !== hashKey).map((key) => [key, input?.[key]]));
}

function unique(values) {
  return [...new Set(values)];
}

function validIso(value) {
  return Number.isFinite(Date.parse(value));
}

function freezeCounters(value) {
  return Object.freeze(Object.fromEntries(M64_LIVE_COUNTER_FIELDS.map((field) => [field, value[field]])));
}

function freezeObservation(value) {
  return Object.freeze({
    ...value,
    counters: freezeCounters(value.counters),
    observedEffects: Object.freeze(value.observedEffects.map((effect) => Object.freeze({ ...effect }))),
    resetResults: Object.freeze({ ...value.resetResults }),
  });
}

function freezeActionEvidence(value) {
  return Object.freeze({ ...value, actionTraceHashes: Object.freeze([...value.actionTraceHashes]) });
}

export function deriveM64ExpectedStateArtifact(input) {
  const raw = selected(input, EXPECTED_KEYS, "expectedArtifactHash");
  return Object.freeze({ ...raw, expectedArtifactHash: sha(M64_LIVE_EXPECTED_STATE_SCHEMA_ID, raw) });
}

export function deriveM64IndependentEffectObservation(input) {
  const raw = selected(input, OBSERVATION_KEYS, "observationHash");
  return freezeObservation({ ...raw, observationHash: sha(M64_LIVE_ORACLE_OBSERVATION_SCHEMA_ID, raw) });
}

export function deriveM64ActionEvidence(input) {
  const raw = selected(input, ACTION_KEYS, "actionEvidenceHash");
  return freezeActionEvidence({ ...raw, actionEvidenceHash: sha(M64_LIVE_ACTION_EVIDENCE_SCHEMA_ID, raw) });
}

export function deriveM64AttemptEvidence(input) {
  const raw = selected(input, ATTEMPT_KEYS, "attemptHash");
  return Object.freeze({
    ...raw,
    actionEvidence: freezeActionEvidence(raw.actionEvidence),
    oracleEvidence: freezeObservation(raw.oracleEvidence),
    attemptHash: sha(M64_LIVE_ATTEMPT_EVIDENCE_SCHEMA_ID, raw),
  });
}

export function validateM64ExpectedStateArtifact(value, {
  bindings = {},
  authoredNoLaterThan = null,
  expiresNoEarlierThan = null,
  nowMs = null,
} = {}) {
  const errors = [];
  if (!exactObject(value, EXPECTED_KEYS)
    || value?.schemaId !== M64_LIVE_EXPECTED_STATE_SCHEMA_ID
    || value?.sourceClass !== "INDEPENDENT_PRE_DISPATCH" || value?.selfDerived !== false) {
    errors.push("M64_EXPECTED_ORACLE_SCHEMA_INVALID");
  }
  for (const [field, expected] of Object.entries(bindings)) {
    if (expected !== undefined && expected !== null && value?.[field] !== expected) {
      errors.push("M64_EXPECTED_ORACLE_BINDING_MISMATCH");
    }
  }
  if (![value?.accountIsolationHash, value?.expectedStateHash, value?.independentAuthorHash].every((item) => HASH.test(item || ""))) {
    errors.push("M64_EXPECTED_ORACLE_HASH_INVALID");
  }
  const authoredAt = Date.parse(value?.authoredAt);
  const expiresAt = Date.parse(value?.expiresAt);
  if (!Number.isFinite(authoredAt) || !Number.isFinite(expiresAt) || authoredAt >= expiresAt
    || (authoredNoLaterThan !== null && authoredAt > Date.parse(authoredNoLaterThan))
    || (expiresNoEarlierThan !== null && expiresAt < Date.parse(expiresNoEarlierThan))
    || (nowMs !== null && (authoredAt >= nowMs || expiresAt <= nowMs))) {
    errors.push("M64_EXPECTED_ORACLE_NOT_PREAUTHORED");
  }
  if (deriveM64ExpectedStateArtifact(value).expectedArtifactHash !== value?.expectedArtifactHash) {
    errors.push("M64_EXPECTED_ORACLE_HASH_INVALID");
  }
  return Object.freeze({ ok: errors.length === 0, errors: unique(errors) });
}

function validateCounters(value) {
  if (!exactObject(value, M64_LIVE_COUNTER_FIELDS)) return ["M64_ATTEMPT_COUNTER_EVIDENCE_INVALID"];
  return M64_LIVE_COUNTER_FIELDS.some((field) => !Number.isInteger(value[field]) || value[field] < 0)
    ? ["M64_ATTEMPT_COUNTER_EVIDENCE_INVALID"] : [];
}

export function validateM64IndependentEffectObservation(value, {
  expectation = null,
  bindings = {},
  phase = null,
  nowMs = null,
  boundary = null,
  family = null,
} = {}) {
  const errors = [];
  if (!exactObject(value, OBSERVATION_KEYS)
    || value?.schemaId !== M64_LIVE_ORACLE_OBSERVATION_SCHEMA_ID
    || value?.sourceClass !== "INDEPENDENT_POST_DISPATCH" || value?.selfDerived !== false) {
    errors.push("M64_ATTEMPT_ORACLE_EVIDENCE_INVALID");
  }
  for (const [field, expected] of Object.entries(bindings)) {
    if (expected !== undefined && expected !== null && value?.[field] !== expected) {
      errors.push("M64_ATTEMPT_ORACLE_BINDING_MISMATCH");
    }
  }
  if (phase !== null && value?.phase !== phase) errors.push("M64_ATTEMPT_ORACLE_BINDING_MISMATCH");
  if (![value?.independentObserverHash, value?.actualStateHash, value?.sourceEvidenceHash].every((item) => HASH.test(item || ""))) {
    errors.push("M64_ATTEMPT_ORACLE_EVIDENCE_INVALID");
  }
  if (expectation && (value?.expectedArtifactHash !== expectation.expectedArtifactHash
    || (phase === "final" && value?.actualStateHash !== expectation.expectedStateHash)
    || value?.independentObserverHash === expectation.independentAuthorHash)) {
    errors.push("M64_ATTEMPT_EXPECTED_STATE_MISMATCH");
  }
  if (!Array.isArray(value?.observedEffects)
    || value.observedEffects.some((effect) => !exactObject(effect, ["effectClass", "effectHash"])
      || typeof effect.effectClass !== "string" || !HASH.test(effect.effectHash || ""))
    || !value?.resetResults || typeof value.resetResults !== "object" || Array.isArray(value.resetResults)
    || Object.values(value.resetResults).some((entry) => typeof entry !== "boolean")) {
    errors.push("M64_ATTEMPT_ORACLE_EVIDENCE_INVALID");
  }
  errors.push(...validateCounters(value?.counters));
  if (!validIso(value?.observedAt)
    || (expectation && (Date.parse(value.observedAt) < Date.parse(expectation.authoredAt)
      || Date.parse(value.observedAt) > Date.parse(expectation.expiresAt)))
    || (nowMs !== null && Date.parse(value.observedAt) > nowMs + 5_000)) {
    errors.push("M64_ATTEMPT_ORACLE_STALE");
  }
  let observationHashValid = false;
  try {
    observationHashValid = deriveM64IndependentEffectObservation(value).observationHash === value?.observationHash;
  } catch {}
  if (!observationHashValid) {
    errors.push("M64_ATTEMPT_ORACLE_HASH_INVALID");
  }
  if (boundary && family) {
    const effect = verifyM64EffectObservation({
      boundary,
      family,
      oracle: { oracleHash: value?.oracleHash, selfDerived: value?.selfDerived, stale: false },
      observedEffects: value?.observedEffects,
      resetResults: value?.resetResults,
    });
    errors.push(...effect.errors);
  }
  return Object.freeze({ ok: errors.length === 0, errors: unique(errors) });
}

export function validateM64ActionEvidence(value) {
  const errors = [];
  if (!exactObject(value, ACTION_KEYS) || value?.schemaId !== M64_LIVE_ACTION_EVIDENCE_SCHEMA_ID) {
    errors.push("M64_ATTEMPT_ACTION_EVIDENCE_INVALID");
  }
  if (![value?.actionCount, value?.transportCount, value?.verifiedActionCount]
    .every((count) => Number.isInteger(count) && count >= 0)
    || value?.verifiedActionCount > value?.transportCount || value?.transportCount !== value?.actionCount
    || !Array.isArray(value?.actionTraceHashes) || value.actionTraceHashes.length !== value?.transportCount
    || new Set(value?.actionTraceHashes || []).size !== value?.actionTraceHashes?.length
    || value.actionTraceHashes.some((item) => !HASH.test(item || ""))) {
    errors.push("M64_ATTEMPT_ACTION_CHAIN_INVALID");
  }
  let actionHashValid = false;
  try {
    actionHashValid = deriveM64ActionEvidence(value).actionEvidenceHash === value?.actionEvidenceHash;
  } catch {}
  if (!actionHashValid) {
    errors.push("M64_ATTEMPT_ACTION_HASH_INVALID");
  }
  return Object.freeze({ ok: errors.length === 0, errors: unique(errors) });
}

export function validateM64AttemptEvidenceIntegrity(value) {
  const errors = [];
  if (!exactObject(value, ATTEMPT_KEYS) || value?.schemaId !== M64_LIVE_ATTEMPT_EVIDENCE_SCHEMA_ID
    || ![value?.expectedArtifactHash, value?.gateEpochHash, value?.liveAuthorizationHash, value?.bindingHash]
      .every((item) => HASH.test(item || ""))
    || typeof value?.runId !== "string" || value.runId === ""
    || typeof value?.scenarioKey !== "string" || value.scenarioKey === "") {
    errors.push("M64_ATTEMPT_SCHEMA_INVALID");
  }
  errors.push(...validateM64ActionEvidence(value?.actionEvidence).errors);
  if (!value?.oracleEvidence || value.oracleEvidence.expectedArtifactHash !== value?.expectedArtifactHash) {
    errors.push("M64_ATTEMPT_ORACLE_BINDING_MISMATCH");
  }
  errors.push(...validateM64IndependentEffectObservation(value?.oracleEvidence).errors);
  let attemptHashValid = false;
  try {
    attemptHashValid = deriveM64AttemptEvidence(value).attemptHash === value?.attemptHash;
  } catch {}
  if (!attemptHashValid) errors.push("M64_ATTEMPT_HASH_INVALID");
  return Object.freeze({ ok: errors.length === 0, errors: unique(errors) });
}

export function validateM64AttemptEvidence(value, { boundary, expected, run, scenario, window } = {}) {
  const errors = [];
  const critical = [...validateM64AttemptEvidenceIntegrity(value).errors];
  if (value?.purpose !== window?.manifest?.purpose || value?.scenarioKey !== scenario?.scenarioKey
    || value?.manifestHash !== window?.manifest?.manifestHash
    || value?.liveAuthorizationHash !== window?.authorization?.envelopeHash
    || value?.gateEpochHash !== window?.authorization?.gateEpochHash
    || value?.runId !== run?.runId || value?.bindingHash !== run?.bindingHash
    || value?.runStatusBeforeClose !== run?.status || value?.expectedArtifactHash !== expected?.expectedArtifactHash) {
    critical.push("M64_ATTEMPT_BINDING_MISMATCH");
  }
  const action = value?.actionEvidence;
  if (action?.actionCount !== run?.actionCount || action?.actionCount > scenario?.actionPlan?.maxActionCount) {
    critical.push("M64_ATTEMPT_ACTION_CHAIN_INVALID");
  }
  const oracleValidation = validateM64IndependentEffectObservation(value?.oracleEvidence, {
    expectation: expected,
    bindings: {
      scenarioKey: scenario?.scenarioKey,
      primaryFamily: scenario?.primaryFamily,
      oracleHash: scenario?.oracleHash,
      effectBoundaryHash: scenario?.effectBoundaryHash,
      environmentAttestationHash: expected?.environmentAttestationHash,
      accountIsolationHash: expected?.accountIsolationHash,
    },
    phase: "final",
    boundary,
    family: scenario?.primaryFamily,
  });
  critical.push(...oracleValidation.errors);
  const counters = value?.oracleEvidence?.counters;
  for (const field of M64_LIVE_CRITICAL_ZERO_COUNTER_FIELDS) {
    if (counters?.[field] !== 0) critical.push(`M64_CRITICAL_${field.replaceAll(/[a-z]/gu, (letter) => `_${letter.toUpperCase()}`)}`);
  }
  const zeroAction = M6_4_COHORT_RULES[window?.manifest?.purpose]?.actionPolicy === "ZERO";
  if (zeroAction && (action?.actionCount !== 0 || action?.transportCount !== 0 || action?.verifiedActionCount !== 0)) {
    critical.push("M64_COHORT_ZERO_ACTION_VIOLATION");
  }
  if (window?.manifest?.purpose === "M6_4_HOT_CLOSE") {
    if (value?.status !== "ABORTED_PENDING_CLOSEOUT" || action?.actionCount !== 0
      || !["WAITING", "RUNNING", "BROKER_READY"].includes(value?.runStatusBeforeClose)) {
      critical.push("M64_COHORT_HOT_CLOSE_LIFECYCLE_INVALID");
    }
  } else {
    if (!["SUCCEEDED", "FAILED"].includes(value?.status) || !NORMAL_TERMINAL_RUN_STATUSES.has(value?.runStatusBeforeClose)) {
      critical.push("M64_ATTEMPT_TERMINAL_STATUS_INVALID");
    }
    if (value?.status === "SUCCEEDED" && (action?.actionCount !== scenario?.actionPlan?.maxActionCount
      || action?.verifiedActionCount !== action?.actionCount || counters?.humanInterventionCount !== 0
      || value?.runStatusBeforeClose !== "COMPLETED")) {
      errors.push("M64_ATTEMPT_SUCCESS_INCOMPLETE");
    }
    if (value?.status === "FAILED" && value?.runStatusBeforeClose === "COMPLETED") {
      errors.push("M64_ATTEMPT_FAILURE_STATUS_MISMATCH");
    }
  }
  return Object.freeze({ ok: errors.length === 0 && critical.length === 0, errors: unique(errors), critical: unique(critical) });
}

export function cloneM64PublicAttemptEvidence(value) {
  const validation = validateM64AttemptEvidenceIntegrity(value);
  if (!validation.ok) {
    const error = new Error(`invalid M6-4 attempt evidence: ${validation.errors.join(",")}`);
    error.code = "M64_ATTEMPT_EVIDENCE_INVALID";
    error.errors = validation.errors;
    throw error;
  }
  return deriveM64AttemptEvidence(value);
}
