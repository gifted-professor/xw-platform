import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { deriveM6AggregateSealHash } from "../../../packages/kernel/lib/m6-aggregate-closeout.mjs";
import {
  canonicalM64LiveWindowAuthorizationSigningBytes,
  deriveM64LiveWindowAuthorizationBodyHash,
  deriveM64LiveWindowAuthorizationEnvelopeHash,
  selectM64LiveWindowRuntimeBinding,
} from "../../../packages/kernel/lib/m6-4-live-window-authorization.mjs";
import { canonicalJson, sha256 } from "../control-plane/lib/canonical.mjs";
import { promoteM6GateEpoch } from "../control-plane/lib/m6-gate-promoter.mjs";
import { writeImmutableJson } from "../control-plane/lib/m6-gate-loader.mjs";
import { createM6LiveBrokerHandler } from "../control-plane/lib/m6-live-broker.mjs";
import { M64_LIVE_WINDOW_ISSUER_ALLOWLIST_SCHEMA_ID } from "../control-plane/lib/m6-live-window-authorization.mjs";
import { deriveM6CloseoutHash, deriveM6EpochHash } from "../control-plane/lib/m6-live-gate.mjs";
import {
  deriveM6ActionEpochBindingHash,
  deriveM6EmergencyCloseAuthorizationHash,
  deriveM6V2EpochHash,
  deriveM6V2LockSetHash,
  M6_GATE_V2_LOCK_KINDS,
} from "../control-plane/lib/m6-live-gate-v2.mjs";
import { StateStore } from "../control-plane/lib/state-store.mjs";

const GATE = "m6-gate";
const ACTOR = "operator:promoter";
const RELEASE = "release-promoter";
const COMMIT = "a".repeat(40);
const V1_LOCKS = { runtimeProfile: "1".repeat(64), hardRedlinePolicy: "2".repeat(64), groundingRuntime: "3".repeat(64) };

function proof(epoch, privateKey) {
  return {
    keyId: "promoter-key",
    subject: ACTOR,
    allowlistVersion: 1,
    signature: sign(null, Buffer.from(epoch.epochHash, "hex"), privateKey).toString("base64"),
    algorithm: "ed25519",
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "m6-promoter-"));
  const state = new StateStore({ dbPath: join(root, "control.db"), now: () => Date.parse("2030-01-01T00:00:02Z") });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const issuerPath = join(root, "m6-gate", "issuer-keys.json");
  writeImmutableJson(issuerPath, {
    schemaId: "xw.m6-gate-issuer-allowlist.v1",
    version: 1,
    keys: [{ keyId: "promoter-key", subject: ACTOR, publicKey: publicKey.export({ type: "spki", format: "pem" }), status: "active" }],
  });
  writeImmutableJson(join(root, "m6-gate", "locks.v1.json"), {
    schemaId: "xw.m6-locks.v1",
    releaseId: RELEASE,
    sourceCommit: COMMIT,
    lockHashes: V1_LOCKS,
  });
  const observedHash = "4".repeat(64);
  const closeRaw = { closeoutId: "seed-closeout", epochHash: observedHash, actor: ACTOR, reason: "seed", committedAt: "2030-01-01T00:00:00Z" };
  const closeout = { ...closeRaw, closeoutHash: deriveM6CloseoutHash(closeRaw) };
  writeImmutableJson(join(root, "m6-gate", GATE, "closeouts", `${closeout.closeoutId}.json`), closeout);
  const sealPayload = { epochHash: observedHash, attempts: [], allowlist: ["01"] };
  const sealHash = deriveM6AggregateSealHash(sealPayload);
  writeImmutableJson(join(root, "m6-gate", GATE, "aggregate", `${sealHash}.json`), {
    schemaId: "xw.m6-aggregate-closeout.v1",
    epochHash: observedHash,
    sealPayload,
    sealHash,
    attemptCount: 0,
    aliases: ["01"],
  });
  const seedRaw = {
    schemaId: "xw.m6-live-gate.v1",
    gateId: GATE,
    mode: "CLOSED",
    status: "closed",
    releaseId: RELEASE,
    sourceCommit: COMMIT,
    actor: ACTOR,
    lockHashes: V1_LOCKS,
    allowlist: ["01"],
    issuedAt: "2030-01-01T00:00:00Z",
    expiresAt: "2030-01-02T00:00:00Z",
    parentEpochHash: null,
    closeoutRef: { id: closeout.closeoutId, sha256: closeout.closeoutHash },
    aggregateSealRef: { id: sealHash, sha256: sealHash },
    rollbackTargetEpochHash: null,
  };
  const seed = { ...seedRaw, epochHash: deriveM6EpochHash(seedRaw) };
  writeImmutableJson(join(root, "m6-gate", GATE, "epochs", `${seed.epochHash}.json`), { ...seed, proof: proof(seed, privateKey) });
  writeImmutableJson(join(root, "m6-gate", GATE, "current.json"), {
    chain: [seed.epochHash], tailEpochHash: seed.epochHash, generation: 0, promotedAt: "2030-01-01T00:00:00Z",
  });
  const seedLocksHash = sha256(`xw.m6-locks.v1:${canonicalJson(seed.lockHashes)}`);
  state.seedM6GateFence({ epoch: seed, locksHash: seedLocksHash });
  const lockRaw = {
    schemaId: "xw.m6-locks.v2",
    lockSetId: "promoter-locks",
    lockHashes: Object.fromEntries(M6_GATE_V2_LOCK_KINDS.map((kind, index) => [kind, String(index % 10).repeat(64)])),
  };
  const lockSet = { ...lockRaw, lockSetHash: deriveM6V2LockSetHash(lockRaw) };
  writeImmutableJson(join(root, "m6-gate", "locks.v2", `${lockSet.lockSetId}.json`), lockSet);
  const nextBase = {
    schemaId: "xw.m6-live-gate.v2",
    gateId: GATE,
    mode: "GROUNDED_ACTION",
    purpose: "M6_4_ACTION_SMOKE",
    status: "active",
    releaseId: RELEASE,
    sourceCommit: COMMIT,
    actor: ACTOR,
    lockSetRef: { id: lockSet.lockSetId, sha256: lockSet.lockSetHash },
    allowlist: ["01"],
    issuedAt: "2030-01-01T00:00:01Z",
    expiresAt: "2030-01-01T01:00:00Z",
    parentEpochHash: seed.epochHash,
    closeoutRef: null,
    aggregateSealRef: null,
    rollbackTargetEpochHash: null,
  };
  const authRaw = {
    schemaId: "xw.m6-emergency-close-authorization.v1",
    authorizationId: "promoter-emergency",
    expectedCurrentEpochHash: seed.epochHash,
    expectedParentEpochHash: seed.epochHash,
    actionEpochBindingHash: deriveM6ActionEpochBindingHash(nextBase),
    releaseId: RELEASE,
    planHash: "b".repeat(64),
    contractHash: "c".repeat(64),
    alias: "01",
    operator: ACTOR,
    reasonCodeAllowlist: ["SAFETY_STOP"],
    nonce: "promoter-nonce",
    expiresAt: "2030-01-01T02:00:00Z",
  };
  const auth = { ...authRaw, authorizationHash: deriveM6EmergencyCloseAuthorizationHash(authRaw) };
  writeImmutableJson(join(root, "m6-gate", GATE, "emergency-close", `${auth.authorizationId}.json`), auth);
  const nextRaw = {
    ...nextBase,
    emergencyCloseAuthorizationRef: { id: auth.authorizationId, sha256: auth.authorizationHash },
  };
  const next = { ...nextRaw, epochHash: deriveM6V2EpochHash(nextRaw) };
  const liveBody = {
    schemaId: "xw.m6-4-live-window-authorization.v1",
    authorizationId: "promoter-live-window-0001",
    issuer: "owner:promoter-test",
    keyId: "promoter-owner-key",
    allowlistVersion: 1,
    signatureAlgorithm: "ed25519",
    nonce: "promoter-live-window-nonce-0001",
    alias: "01",
    releaseId: RELEASE,
    releaseHash: "1".repeat(64),
    sourceCommit: COMMIT,
    gateId: GATE,
    gateEpochHash: next.epochHash,
    gateGeneration: 1,
    purpose: next.purpose,
    scenarioManifestHash: lockSet.lockHashes.scenarioManifest,
    runtimeProfileHash: lockSet.lockHashes.runtimeProfile,
    modelProfileHash: lockSet.lockHashes.modelProfile,
    providerHash: lockSet.lockHashes.liveProvider,
    toolProfileHash: lockSet.lockHashes.liveToolSpec,
    policyHash: lockSet.lockHashes.grantActionPolicy,
    locksHash: lockSet.lockSetHash,
    environmentAttestationHash: "8".repeat(64),
    operatorHash: "9".repeat(64),
    emergencyCloseAuthorizationHash: auth.authorizationHash,
    emergencyCloseReasonCodeAllowlist: auth.reasonCodeAllowlist,
    closeoutGraceMs: Date.parse(auth.expiresAt) - Date.parse(next.expiresAt),
    effectBoundary: "BOUNDED_READ_TRACE",
    independentOracleHash: "a".repeat(64),
    resetObligationsHash: "b".repeat(64),
    issuedAt: "2030-01-01T00:00:00Z",
    expiresAt: "2030-01-01T00:30:00Z",
  };
  const liveWithBodyHash = { ...liveBody, bodyHash: deriveM64LiveWindowAuthorizationBodyHash(liveBody) };
  const liveWithSignature = {
    ...liveWithBodyHash,
    signature: sign(null, canonicalM64LiveWindowAuthorizationSigningBytes(liveWithBodyHash), privateKey).toString("base64"),
  };
  const liveWindowAuthorization = {
    ...liveWithSignature,
    envelopeHash: deriveM64LiveWindowAuthorizationEnvelopeHash(liveWithSignature),
  };
  const liveWindowIssuerAllowlist = {
    schemaId: M64_LIVE_WINDOW_ISSUER_ALLOWLIST_SCHEMA_ID,
    version: 1,
    keys: [{
      issuer: liveBody.issuer,
      keyId: liveBody.keyId,
      publicKey: publicKey.export({ type: "spki", format: "pem" }),
      status: "active",
    }],
  };
  const liveWindowRuntime = selectM64LiveWindowRuntimeBinding(liveWindowAuthorization);
  return {
    root,
    state,
    privateKey,
    issuerPath,
    seed,
    next,
    liveWindowAuthorization,
    liveWindowIssuerAllowlist,
    liveWindowRuntime,
    cleanup() { state.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

function liveWindowArgs(f) {
  return {
    liveWindowAuthorization: f.liveWindowAuthorization,
    liveWindowIssuerAllowlist: f.liveWindowIssuerAllowlist,
    liveWindowRuntime: f.liveWindowRuntime,
  };
}

function resignLiveWindowAuthorization(f, overrides) {
  const { bodyHash: _bodyHash, signature: _signature, envelopeHash: _envelopeHash, ...body } = f.liveWindowAuthorization;
  const changed = { ...body, ...overrides };
  const withBodyHash = { ...changed, bodyHash: deriveM64LiveWindowAuthorizationBodyHash(changed) };
  const withSignature = {
    ...withBodyHash,
    signature: sign(null, canonicalM64LiveWindowAuthorizationSigningBytes(withBodyHash), f.privateKey).toString("base64"),
  };
  return { ...withSignature, envelopeHash: deriveM64LiveWindowAuthorizationEnvelopeHash(withSignature) };
}

test("single promote API commits immutable epoch then v20 fence then generation-bearing pointer", () => {
  const f = fixture();
  try {
    const result = promoteM6GateEpoch({
      state: f.state,
      m6Root: f.root,
      gateId: GATE,
      epoch: f.next,
      proof: proof(f.next, f.privateKey),
      issuerAllowlistPath: f.issuerPath,
      promotedAt: "2030-01-01T00:00:02Z",
      ...liveWindowArgs(f),
    });
    assert.equal(result.generation, 1);
    assert.equal(f.state.getM6GateFence().epochHash, f.next.epochHash);
    assert.equal(f.state.getM64LiveWindowAuthorizationConsumption(f.liveWindowAuthorization.authorizationId).envelopeHash, f.liveWindowAuthorization.envelopeHash);
  } finally { f.cleanup(); }
});

test("fault after DB fence leaves pointer behind and the production broker fails closed", async () => {
  const f = fixture();
  try {
    assert.throws(() => promoteM6GateEpoch({
      state: f.state,
      m6Root: f.root,
      gateId: GATE,
      epoch: f.next,
      proof: proof(f.next, f.privateKey),
      issuerAllowlistPath: f.issuerPath,
      promotedAt: "2030-01-01T00:00:02Z",
      faultAfter: "dbFence",
      ...liveWindowArgs(f),
    }), { code: "M6_GATE_PROMOTE_FAULT" });
    assert.equal(f.state.getM6GateFence().epochHash, f.next.epochHash);
    const pointer = JSON.parse(readFileSync(join(f.root, "m6-gate", GATE, "current.json"), "utf8"));
    assert.equal(pointer.tailEpochHash, f.seed.epochHash);
    const binding = {
      runId: "run:db-fault", workerId: "worker:db-fault", sessionId: "session:db-fault", alias: "01", processRef: "process:db-fault",
      gateEpochHash: f.next.epochHash, generation: 1, purpose: f.next.purpose,
      scenarioManifestHash: f.liveWindowRuntime.scenarioManifestHash,
      liveWindowAuthorizationHash: f.liveWindowAuthorization.envelopeHash,
      bindingHash: "f".repeat(64),
    };
    let calls = 0;
    const handler = createM6LiveBrokerHandler({
      state: f.state,
      binding,
      authorizationId: f.liveWindowAuthorization.authorizationId,
      m6Root: f.root,
      gateId: GATE,
      issuerAllowlistPath: f.issuerPath,
      now: () => Date.parse("2030-01-01T00:00:02Z"),
      runManager: {
        getRunBinding: () => binding,
        async handleToolCall() {
          calls += 1;
          return { externalEffect: false, actionCount: 0, workerRunRef: "worker:db-fault", status: "RUNNING" };
        },
      },
    });
    await assert.rejects(
      () => handler({ method: "worker_start", params: { workerRunRef: "worker:db-fault" }, binding }),
      { code: "M6_GATE_TRIPLE_MISMATCH" },
    );
    assert.equal(calls, 0);
  } finally { f.cleanup(); }
});

test("v2 activation rejects a mutated owner envelope before immutable epoch or fence activation", () => {
  const f = fixture();
  try {
    assert.throws(() => promoteM6GateEpoch({
      state: f.state,
      m6Root: f.root,
      gateId: GATE,
      epoch: f.next,
      proof: proof(f.next, f.privateKey),
      issuerAllowlistPath: f.issuerPath,
      promotedAt: "2030-01-01T00:00:02Z",
      ...liveWindowArgs(f),
      liveWindowAuthorization: { ...f.liveWindowAuthorization, providerHash: "f".repeat(64) },
    }), { code: "M64_LIVE_AUTH_BODY_HASH_INVALID" });
    assert.equal(f.state.getM6GateFence().generation, 0);
    assert.equal(existsSync(join(f.root, "m6-gate", GATE, "epochs", `${f.next.epochHash}.json`)), false);

    const rebound = resignLiveWindowAuthorization(f, { providerHash: "f".repeat(64) });
    assert.throws(() => promoteM6GateEpoch({
      state: f.state,
      m6Root: f.root,
      gateId: GATE,
      epoch: f.next,
      proof: proof(f.next, f.privateKey),
      issuerAllowlistPath: f.issuerPath,
      promotedAt: "2030-01-01T00:00:02Z",
      liveWindowAuthorization: rebound,
      liveWindowIssuerAllowlist: f.liveWindowIssuerAllowlist,
      liveWindowRuntime: selectM64LiveWindowRuntimeBinding(rebound),
    }), { code: "M64_LIVE_AUTH_RUNTIME_BINDING_MISMATCH" });
    assert.equal(f.state.getM6GateFence().generation, 0);
    assert.equal(existsSync(join(f.root, "m6-gate", GATE, "epochs", `${f.next.epochHash}.json`)), false);
  } finally { f.cleanup(); }
});
