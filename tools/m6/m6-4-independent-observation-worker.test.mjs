import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  verify,
} from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  M64_INDEPENDENT_ORACLE_POLICY_SCHEMA_ID,
  canonicalM64ObservationEnvelopeSigningBytes,
  deriveM64ExpectationIndexHash,
  deriveM64IndependentActorHash,
  deriveM64IndependentOraclePolicyHash,
  deriveM64ObservationLocatorHash,
  deriveM64ObservationRequestHash,
} from "../../services/control-plane/control-plane/lib/m6-live-production-dependencies.mjs";
import { canonicalJson, sha256 } from "../../services/control-plane/control-plane/lib/canonical.mjs";
import {
  M64_DEVICE_READ_SNAPSHOT_SCHEMA_ID,
  M64_OBSERVATION_WORK_REQUEST_SCHEMA_ID,
  deriveM64DeviceReadSnapshotSha256,
  loadM64ObservationSigner,
  main,
  publishM64IndependentObservation,
  validateM64DeviceReadSnapshot,
} from "./m6-4-independent-observation-worker.mjs";
import { loadM64ResourceObserverPolicy } from "./m6-4-production-operator-bridge.mjs";

const H = (value) => sha256(`test:${value}`);
const NOW = Date.parse("2026-08-24T12:00:00.000Z");

function writeJson(path, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  writeFileSync(path, bytes);
  return { path, sha256: sha256(bytes) };
}

function withHash(value, derive, key) {
  return Object.freeze({ ...value, [key]: derive(value) });
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "m64-independent-observer-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const releaseRoot = join(root, "release");
  const observationRoot = join(root, "observer");
  mkdirSync(releaseRoot);
  mkdirSync(join(observationRoot, "requests"), { recursive: true });
  mkdirSync(join(observationRoot, "observations"), { recursive: true });
  const author = generateKeyPairSync("ed25519");
  const observer = generateKeyPairSync("ed25519");
  const authorPublic = author.publicKey.export({ type: "spki", format: "pem" }).toString();
  const observerPublic = observer.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPath = join(root, "observer-private.pem");
  writeFileSync(privateKeyPath, observer.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  const index = withHash({
    schemaId: "xw.m6-4-expectation-index.v1",
    entries: [{ lookupHash: H("lookup"), expectationEnvelope: { path: join(root, "expectation.json"), sha256: H("expectation") } }],
  }, deriveM64ExpectationIndexHash, "indexHash");
  const indexRef = writeJson(join(root, "expectation-index.json"), index);
  const policy = withHash({
    schemaId: M64_INDEPENDENT_ORACLE_POLICY_SCHEMA_ID,
    effectBoundaryHash: H("boundary"),
    expectationIndex: indexRef,
    expectationAuthorKeyId: "expectation-author-test",
    expectationAuthorPublicKey: authorPublic,
    independentAuthorHash: deriveM64IndependentActorHash(author.publicKey),
    observationRoot,
    observationObserverKeyId: "observation-observer-test",
    observationObserverPublicKey: observerPublic,
    independentObserverHash: deriveM64IndependentActorHash(observer.publicKey),
    allowedSourceKinds: ["DEVICE_READ_SNAPSHOT"],
    requiredSourceKinds: ["DEVICE_READ_SNAPSHOT"],
    forbiddenSourceKinds: [
      "BROKER_ACK", "CONTROL_PLANE_LEDGER", "DSH_RESULT", "GROUNDED_ACTION_RECEIPT",
      "MODEL_OUTPUT", "SUT_RECEIPT", "TRANSPORT_RESULT",
    ],
    maxObservationAgeMs: 30_000,
  }, deriveM64IndependentOraclePolicyHash, "policyHash");
  const policyRef = writeJson(join(root, "policy.json"), policy);
  const observerPolicy = loadM64ResourceObserverPolicy(policyRef, { releaseRoot });
  const authority = {
    purpose: "M6_4_SHADOW",
    manifestHash: H("manifest"),
    scenarioKey: "m6_4_shadow-01",
    primaryFamily: "app-launch",
    oracleHash: H("oracle"),
    effectBoundaryHash: policy.effectBoundaryHash,
    environmentAttestationHash: H("environment"),
    accountIsolationHash: H("account"),
    expectedArtifactHash: H("expected-artifact"),
    independentAuthorHash: policy.independentAuthorHash,
    phase: "before",
  };
  const request = {
    schemaId: M64_OBSERVATION_WORK_REQUEST_SCHEMA_ID,
    ...authority,
    expectedStateHash: H("expected-state"),
    requestHash: deriveM64ObservationRequestHash(authority),
  };
  const snapshotRaw = {
    schemaId: M64_DEVICE_READ_SNAPSHOT_SCHEMA_ID,
    sourceKind: "DEVICE_READ_SNAPSHOT",
    requestHash: request.requestHash,
    gateEpochHash: H("gate-epoch"),
    captureEvidenceSha256: H("capture-evidence"),
    frameRef: H("frame"),
    observedAt: new Date(NOW).toISOString(),
    actualStateHash: request.expectedStateHash,
    observedEffects: [],
    resetResults: {},
    counters: {
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
    },
    actionCount: 0,
    transportCount: 0,
  };
  const snapshot = { ...snapshotRaw, snapshotSha256: deriveM64DeviceReadSnapshotSha256(snapshotRaw) };
  return { root, releaseRoot, observationRoot, observer, observerPolicy, policy, policyRef, privateKeyPath, request, snapshot };
}

test("dry-run validates the frozen DEVICE_READ_SNAPSHOT-only policy and signer without side effects", async (t) => {
  const f = fixture(t);
  const result = await main([
    "--mode", "dry-run",
    "--policy", `${f.policyRef.path}@${f.policyRef.sha256}`,
    "--release-root", f.releaseRoot,
    "--observer-key-file", f.privateKeyPath,
  ]);
  assert.deepEqual(result.sourceKinds, ["DEVICE_READ_SNAPSHOT"]);
  assert.equal(result.status, "DRY_RUN_READY");
  assert.equal(result.actionCount, 0);
  assert.equal(result.transportCount, 0);
  assert.equal(result.deviceAccessed, false);
  assert.equal(result.gateMutationPerformed, false);
  assert.equal(result.providerDispatchPerformed, false);
});

test("worker signs one source-bound envelope then atomically publishes its request locator", (t) => {
  const f = fixture(t);
  const privateKey = loadM64ObservationSigner(f.privateKeyPath, f.observerPolicy);
  const result = publishM64IndependentObservation({
    request: f.request,
    snapshot: f.snapshot,
    observerPolicy: f.observerPolicy,
    privateKey,
    nowMs: NOW,
  });
  assert.equal(result.actionCount, 0);
  assert.equal(result.transportCount, 0);
  const envelopeBytes = readFileSync(result.envelopePath);
  assert.equal(sha256(envelopeBytes), result.envelopeSha256);
  const envelope = JSON.parse(envelopeBytes);
  assert.deepEqual(envelope.sourceEvidence, [{ kind: "DEVICE_READ_SNAPSHOT", sha256: f.snapshot.snapshotSha256 }]);
  assert.equal(envelope.observation.actualStateHash, f.snapshot.actualStateHash);
  assert.equal(verify(null, canonicalM64ObservationEnvelopeSigningBytes(envelope), f.observer.publicKey, Buffer.from(envelope.signature, "base64")), true);
  const locator = JSON.parse(readFileSync(result.locatorPath));
  assert.equal(locator.envelopeSha256, result.envelopeSha256);
  assert.equal(locator.locatorHash, deriveM64ObservationLocatorHash(locator));
  assert.deepEqual(publishM64IndependentObservation({
    request: f.request,
    snapshot: f.snapshot,
    observerPolicy: f.observerPolicy,
    privateKey,
    nowMs: NOW,
  }), result);
});

test("worker fails closed for non-device, active, stale, and tampered snapshot sources", async (t) => {
  const f = fixture(t);
  for (const mutation of [
    { sourceKind: "MODEL_OUTPUT" },
    { actionCount: 1 },
    { transportCount: 1 },
    { observedAt: new Date(NOW - 30_001).toISOString() },
    { actualStateHash: H("tampered") },
  ]) {
    const mutated = { ...f.snapshot, ...mutation };
    const candidate = Object.hasOwn(mutation, "actualStateHash")
      ? mutated
      : { ...mutated, snapshotSha256: deriveM64DeviceReadSnapshotSha256(mutated) };
    assert.throws(() => validateM64DeviceReadSnapshot(candidate, {
      request: f.request,
      policy: f.policy,
      nowMs: NOW,
    }), (error) => error?.code === (mutation.observedAt ? "M64_DEVICE_READ_SNAPSHOT_STALE" : "M64_DEVICE_READ_SNAPSHOT_INVALID"));
  }
  await assert.rejects(main([
    "--mode", "invalid",
    "--policy", `${f.policyRef.path}@${f.policyRef.sha256}`,
    "--release-root", f.releaseRoot,
    "--observer-key-file", f.privateKeyPath,
  ]), { code: "M64_OBSERVATION_WORKER_MODE_INVALID" });
  assert.equal(canonicalJson(readFileSync(f.privateKeyPath, "utf8").includes("PRIVATE KEY")), "true");
});
