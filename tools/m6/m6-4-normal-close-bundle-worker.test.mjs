import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import {
  deriveM64CohortAggregateHash,
  deriveM64CohortScenarioKeys,
} from "../../packages/kernel/lib/m6-4-cohort.mjs";
import { deriveM6V2EpochHash } from "../../services/control-plane/control-plane/lib/m6-live-gate-v2.mjs";
import {
  deriveM64NormalCloseSigningRequestHash,
  validateM64ExternalNormalCloseBundle,
} from "./m6-4-production-operator-bridge.mjs";
import {
  deriveM64NormalCloseBundle,
  validateM64NormalCloseSigningRequest,
} from "./m6-4-normal-close-bundle-worker.mjs";

const NOW = Date.parse("2030-01-01T00:10:00.000Z");
const H = (value) => Buffer.from(String(value)).toString("hex").padEnd(64, "0").slice(0, 64);

function fixture() {
  const purpose = "M6_4_SHADOW";
  const owner = generateKeyPairSync("ed25519");
  const gate = generateKeyPairSync("ed25519");
  const activeRaw = {
    schemaId: "xw.m6-live-gate.v2",
    gateId: "m6-4-gate-test",
    mode: "OBSERVE_ONLY",
    purpose,
    status: "active",
    releaseId: "xw-m6-test",
    sourceCommit: "1".repeat(40),
    actor: "operator:test-gate",
    lockSetRef: { id: H("locks"), sha256: H("locks") },
    allowlist: ["01"],
    issuedAt: "2030-01-01T00:00:00.000Z",
    expiresAt: "2030-01-01T01:00:00.000Z",
    parentEpochHash: H("closed-parent"),
    closeoutRef: null,
    aggregateSealRef: null,
    rollbackTargetEpochHash: null,
    emergencyCloseAuthorizationRef: { id: "emergency", sha256: H("emergency") },
  };
  const active = { ...activeRaw, epochHash: deriveM6V2EpochHash(activeRaw) };
  const authRaw = {
    purpose,
    gateEpochHash: active.epochHash,
    envelopeHash: H("owner-envelope"),
  };
  const authorization = {
    ...authRaw,
    signature: sign(null, Buffer.from(JSON.stringify(authRaw)), owner.privateKey).toString("base64"),
  };
  const manifest = { purpose, manifestHash: H("manifest") };
  const window = {
    manifest,
    authorization,
    activationPackage: { epoch: active, authorization },
  };
  const expectedScenarioKeys = deriveM64CohortScenarioKeys(purpose);
  const aggregateRaw = {
    schemaId: "xw.m6-4-cohort-aggregate.v1",
    purpose,
    alias: "01",
    expectedScenarioKeys,
    attempts: expectedScenarioKeys.map((scenarioKey) => ({
      scenarioKey,
      alias: "01",
      status: "SUCCEEDED",
      actionCount: 0,
      transportCount: 0,
      forbiddenEffectCount: 0,
      publicEffectCount: 0,
      paymentAttemptCount: 0,
      deleteAttemptCount: 0,
    })),
    manifestHash: manifest.manifestHash,
    gateEpochHash: active.epochHash,
    liveAuthorizationHash: authorization.envelopeHash,
  };
  const aggregate = { ...aggregateRaw, aggregateHash: deriveM64CohortAggregateHash(aggregateRaw) };
  const attemptEvidence = expectedScenarioKeys.map((scenarioKey, index) => ({
    scenarioKey,
    attemptHash: H(`attempt-${index}`),
    oracleEvidence: { observedAt: "2030-01-01T00:09:59.000Z" },
  }));
  const requestRaw = {
    purpose,
    currentGateEpochHash: active.epochHash,
    activationParentEpochHash: active.parentEpochHash,
    aggregate,
    aggregateHash: aggregate.aggregateHash,
    attemptEvidence,
    attemptEvidenceHashes: attemptEvidence.map((entry) => entry.attemptHash),
    requestNonce: "00000000-0000-4000-8000-000000000001",
    requestedAt: "2030-01-01T00:09:59.500Z",
    deadline: "2030-01-01T00:11:00.000Z",
  };
  const request = { ...requestRaw, requestHash: deriveM64NormalCloseSigningRequestHash(requestRaw) };
  return { gate, request, window };
}

test("normal-close worker creates a fresh owner/gate-signed zero-action bundle bound inside the signed seal", () => {
  const { gate, request, window } = fixture();
  const bundle = deriveM64NormalCloseBundle({
    request,
    window,
    gatePrivateKey: gate.privateKey,
    gateKeyId: "gate-key-01",
    gateSubject: "operator:gate-01",
    nowMs: NOW,
  });
  assert.equal(bundle.package.authorization.signature, window.authorization.signature);
  assert.equal(bundle.aggregateSeal.sealPayload.normalCloseRequestHash, request.requestHash);
  assert.equal(bundle.cohortAggregate.attempts.reduce((sum, attempt) => sum + attempt.actionCount, 0), 0);
  assert.equal(validateM64ExternalNormalCloseBundle(bundle, {
    window,
    aggregate: request.aggregate,
    attemptEvidence: request.attemptEvidence,
    requestHash: request.requestHash,
    nowMs: NOW,
  }).ok, true);
});

test("normal-close request and consumer reject stale or cross-request replay", () => {
  const { gate, request, window } = fixture();
  assert.ok(validateM64NormalCloseSigningRequest(request, { window, nowMs: Date.parse(request.deadline) + 1 })
    .errors.includes("M64_NORMAL_CLOSE_REQUEST_STALE"));
  const bundle = deriveM64NormalCloseBundle({
    request,
    window,
    gatePrivateKey: gate.privateKey,
    gateKeyId: "gate-key-01",
    gateSubject: "operator:gate-01",
    nowMs: NOW,
  });
  assert.ok(validateM64ExternalNormalCloseBundle(bundle, {
    window,
    aggregate: request.aggregate,
    attemptEvidence: request.attemptEvidence,
    requestHash: H("another-request"),
    nowMs: NOW,
  }).errors.includes("M64_EXTERNAL_CLOSE_REQUEST_MISMATCH"));
});
