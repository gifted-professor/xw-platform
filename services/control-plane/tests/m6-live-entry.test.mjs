import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  canonicalM64LiveWindowAuthorizationSigningBytes,
  deriveM64LiveWindowAuthorizationBodyHash,
  deriveM64LiveWindowAuthorizationEnvelopeHash,
  selectM64LiveWindowRuntimeBinding,
} from "../../../packages/kernel/lib/m6-4-live-window-authorization.mjs";
import {
  M64_LIVE_ACTION_EVIDENCE_SCHEMA_ID,
  M64_LIVE_ATTEMPT_EVIDENCE_SCHEMA_ID,
  deriveM64ActionEvidence,
  deriveM64AttemptEvidence,
  deriveM64IndependentEffectObservation,
} from "../../../packages/kernel/lib/m6-live-evidence.mjs";
import {
  createM6LiveEntry,
  deriveM6LiveEntryRunId,
  loadM6LiveEntryConfigFromEnv,
} from "../control-plane/lib/m6-live-entry.mjs";
import { ControlPlaneError } from "../control-plane/lib/errors.mjs";
import {
  M64_LIVE_WINDOW_ISSUER_ALLOWLIST_SCHEMA_ID,
  normalizeM64LiveWindowIssuerAllowlist,
} from "../control-plane/lib/m6-live-window-authorization.mjs";
import { ControlRouter } from "../control-plane/router.mjs";

const NOW = Date.parse("2030-01-01T00:10:00.000Z");
const H = (character) => character.repeat(64);
const TOKEN = "m6-live-entry-test-token-32-bytes-minimum";

function protocolHandle(binding, { onClose = null } = {}) {
  return {
    schemaId: "xw.m6-live-worker-protocol.v1",
    runId: binding.runId,
    sessionId: binding.sessionId,
    directiveHash: H("a"),
    async close() {
      onClose?.();
      return { schemaId: "xw.m6-live-worker-protocol-close.v1", verifiedClosed: true };
    },
  };
}

function publicAttemptEvidence({ run, context }) {
  const actionEvidence = deriveM64ActionEvidence({
    schemaId: M64_LIVE_ACTION_EVIDENCE_SCHEMA_ID,
    actionCount: run.actionCount,
    transportCount: run.actionCount,
    verifiedActionCount: run.actionCount,
    actionTraceHashes: Array.from({ length: run.actionCount }, (_, index) => H(index % 2 === 0 ? "7" : "8")),
  });
  const oracleEvidence = deriveM64IndependentEffectObservation({
    schemaId: "xw.m6-4-independent-effect-observation.v1",
    phase: "final",
    sourceClass: "INDEPENDENT_POST_DISPATCH",
    selfDerived: false,
    scenarioKey: context.scenarioKey,
    primaryFamily: context.scenario.primaryFamily,
    oracleHash: context.scenario.oracleHash,
    effectBoundaryHash: context.scenario.effectBoundaryHash,
    environmentAttestationHash: H("9"),
    accountIsolationHash: H("a"),
    expectedArtifactHash: H("b"),
    independentObserverHash: H("c"),
    actualStateHash: H("d"),
    sourceEvidenceHash: H("e"),
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
    observedAt: "2030-01-01T00:10:00.000Z",
  });
  return deriveM64AttemptEvidence({
    schemaId: M64_LIVE_ATTEMPT_EVIDENCE_SCHEMA_ID,
    purpose: run.binding.purpose,
    manifestHash: run.binding.scenarioManifestHash,
    scenarioKey: context.scenarioKey,
    liveAuthorizationHash: run.binding.liveWindowAuthorizationHash,
    gateEpochHash: run.binding.gateEpochHash,
    bindingHash: run.binding.bindingHash,
    runId: run.binding.runId,
    runStatusBeforeClose: run.status,
    status: "FAILED",
    expectedArtifactHash: H("b"),
    actionEvidence,
    oracleEvidence,
  });
}

function manifest(manifestRef = "m6_4_action_smoke") {
  return Object.freeze(JSON.parse(readFileSync(
    new URL(`../../../artifacts/m6-4/cohort-manifests/${manifestRef}.json`, import.meta.url),
    "utf8",
  )));
}

function fixture({ manifestRef = "m6_4_action_smoke", gateMode = null } = {}) {
  const frozenManifest = manifest(manifestRef);
  const owner = generateKeyPairSync("ed25519");
  const body = {
    schemaId: "xw.m6-4-live-window-authorization.v1",
    authorizationId: "m64-live-entry-auth-0001",
    issuer: "owner:live-entry-test",
    keyId: "owner-live-entry-key",
    allowlistVersion: 1,
    signatureAlgorithm: "ed25519",
    nonce: "m64-live-entry-nonce-0001",
    alias: "01",
    releaseId: "m64-live-entry-release",
    releaseHash: H("1"),
    sourceCommit: "a".repeat(40),
    gateId: "m6-live-entry-gate",
    gateEpochHash: H("2"),
    gateGeneration: 4,
    purpose: frozenManifest.purpose,
    scenarioManifestHash: frozenManifest.manifestHash,
    runtimeProfileHash: H("3"),
    modelProfileHash: H("4"),
    providerHash: H("5"),
    toolProfileHash: H("6"),
    policyHash: H("7"),
    locksHash: H("8"),
    environmentAttestationHash: H("9"),
    operatorHash: H("c"),
    emergencyCloseAuthorizationHash: H("d"),
    emergencyCloseReasonCodeAllowlist: ["SAFETY_STOP"],
    closeoutGraceMs: 30 * 60 * 1000,
    effectBoundary: "BOUNDED_READ_TRACE",
    independentOracleHash: H("e"),
    resetObligationsHash: H("f"),
    issuedAt: "2030-01-01T00:00:00.000Z",
    expiresAt: "2030-01-01T01:00:00.000Z",
  };
  const withBodyHash = { ...body, bodyHash: deriveM64LiveWindowAuthorizationBodyHash(body) };
  const withSignature = {
    ...withBodyHash,
    signature: sign(null, canonicalM64LiveWindowAuthorizationSigningBytes(withBodyHash), owner.privateKey).toString("base64"),
  };
  const authorization = Object.freeze({
    ...withSignature,
    envelopeHash: deriveM64LiveWindowAuthorizationEnvelopeHash(withSignature),
  });
  const issuerAllowlist = normalizeM64LiveWindowIssuerAllowlist({
    schemaId: M64_LIVE_WINDOW_ISSUER_ALLOWLIST_SCHEMA_ID,
    version: 1,
    keys: [{
      issuer: body.issuer,
      keyId: body.keyId,
      publicKey: owner.publicKey.export({ type: "spki", format: "pem" }),
      status: "active",
    }],
  });
  const fence = {
    gateId: body.gateId,
    epochHash: body.gateEpochHash,
    generation: body.gateGeneration,
    mode: gateMode ?? (frozenManifest.purpose === "M6_4_SHADOW" ? "OBSERVE_ONLY" : "GROUNDED_ACTION"),
    purpose: body.purpose,
    allowlist: ["01"],
    expiresAt: "2030-01-01T00:50:00.000Z",
    releaseId: body.releaseId,
    sourceCommit: body.sourceCommit,
    locksHash: body.locksHash,
  };
  const consumption = {
    authorizationId: body.authorizationId,
    bodyHash: authorization.bodyHash,
    envelopeHash: authorization.envelopeHash,
    gateId: body.gateId,
    gateEpochHash: body.gateEpochHash,
    gateGeneration: body.gateGeneration,
    purpose: body.purpose,
    releaseId: body.releaseId,
    sourceCommit: body.sourceCommit,
    locksHash: body.locksHash,
    expiresAt: body.expiresAt,
    consumptionHash: H("0"),
  };
  const tail = {
    schemaId: "xw.m6-live-gate.v2",
    gateId: fence.gateId,
    epochHash: fence.epochHash,
    mode: fence.mode,
    purpose: fence.purpose,
    allowlist: fence.allowlist,
    expiresAt: fence.expiresAt,
    releaseId: fence.releaseId,
    sourceCommit: fence.sourceCommit,
    lockSetRef: { id: "locks-live-entry", sha256: fence.locksHash },
  };
  const gateSnapshot = {
    chain: [tail],
    currentPointer: { chain: [tail.epochHash], tailEpochHash: tail.epochHash, generation: fence.generation },
  };
  const scenarioClaims = new Map();
  const state = {
    getM6GateFence: () => fence,
    getM64LiveWindowAuthorizationConsumption: (authorizationId) => authorizationId === body.authorizationId ? consumption : null,
    claimM64LiveScenarioStart({ verification, scenarioKey }) {
      const key = `${verification.authorizationId}:${scenarioKey}`;
      if (scenarioClaims.has(key)) {
        throw new ControlPlaneError("M6_LIVE_SCENARIO_ALREADY_CLAIMED", "scenario already claimed");
      }
      const claim = Object.freeze({
        schemaId: "xw.m6-4-live-scenario-claim.v1",
        status: "STARTED",
        authorizationId: verification.authorizationId,
        authorizationHash: verification.envelopeHash,
        manifestHash: verification.runtimeBinding.scenarioManifestHash,
        scenarioKey,
        purpose: verification.runtimeBinding.purpose,
        gateEpochHash: verification.runtimeBinding.gateEpochHash,
        gateGeneration: verification.runtimeBinding.gateGeneration,
        claimHash: H("b"),
      });
      scenarioClaims.set(key, claim);
      return claim;
    },
  };
  return {
    authorization,
    frozenManifest,
    issuerAllowlist,
    runtimeSnapshot: selectM64LiveWindowRuntimeBinding(authorization),
    qualification: { contentHash: authorization.modelProfileHash },
    state,
    gateSnapshot,
    request: {
      manifestRef,
      manifestHash: frozenManifest.manifestHash,
      scenarioKey: `${manifestRef}-01`,
      authorizationId: authorization.authorizationId,
      authorizationHash: authorization.envelopeHash,
      authorization,
    },
  };
}

function recoveryTestEntry(f, {
  workerDriver = async ({ binding }) => protocolHandle(binding),
  processClose = async () => ({
    verifiedClosed: true,
    broker: { pipeClosed: true },
    process: { verifiedClosed: true },
  }),
} = {}) {
  const closeReasons = [];
  const callbacks = {
    async observe() { return { externalEffect: false, actionCount: 0, frameRef: H("a") }; },
    async ground() { return { externalEffect: false, actionCount: 0, disposition: "ALLOW_ONCE", decisionRef: H("b"), operationKey: H("6") }; },
    async act() { return { externalEffect: true, actionCount: 1, effectStatus: "VERIFIED", actionReceiptRef: H("7"), verificationRef: H("c") }; },
    async verify() { return { externalEffect: false, actionCount: 0, verified: true, verificationRef: H("c") }; },
    async checkpointAudit() { return { externalEffect: false, actionCount: 0, checkpointRef: H("d") }; },
    async trace() { return { externalEffect: false, actionCount: 0, traceRefs: [H("e")] }; },
    async waitHuman() { return { externalEffect: false, actionCount: 0, status: "WAITING" }; },
    async complete({ run }) { return { externalEffect: false, actionCount: 0, workerRunRef: run.workerRunRef, status: "COMPLETED" }; },
    async close({ reason }) {
      closeReasons.push(reason);
      return { schemaId: "xw.m6-run-close.v1", verifiedClosed: true };
    },
  };
  const entry = createM6LiveEntry({
    state: f.state,
    config: {
      internalToken: TOKEN,
      runtimeSnapshot: f.runtimeSnapshot,
      issuerAllowlist: f.issuerAllowlist,
      qualification: f.qualification,
    },
    callbacks,
    manifestLoader: () => f.frozenManifest,
    loadGateSnapshot: () => f.gateSnapshot,
    qualifyLaunch: () => ({ authority: { qualificationStatus: "QUALIFIED" } }),
    processAdapterFactory() {
      return {
        launch() {
          return {
            ready: Promise.resolve({ bindingHash: H("f") }),
            broker: { async close() { return { pipeClosed: true }; } },
            close: processClose,
          };
        },
      };
    },
    workerDriver,
    now: () => NOW,
  });
  return { closeReasons, entry };
}

test("production config exposes only sealed runtime/dependency seams and no free child command or fixture fallback", () => {
  const config = loadM6LiveEntryConfigFromEnv({
    env: {
      XW_M6_LIVE_PROVIDER_BASE_URL: "https://provider.example/v1",
      XW_M6_LIVE_MODEL_PROFILE_HASH: H("1"),
      XW_M6_LIVE_MODEL_PROFILE_ROOT: "C:\\sealed\\model-profiles",
      XW_DSH_PERSISTENCE_ROOT: "C:\\runtime\\dsh",
      XW_M6_LIVE_DEPENDENCY_ROOT: "C:\\sealed\\dependencies\\layer",
      XW_M6_LIVE_DEPENDENCY_LAYER_HASH: H("2"),
      XW_M6_SOURCE_RELEASE_ROOT: "C:\\sealed\\release",
      DEEPSEEK_API_KEY: "injected-only-at-launch",
    },
  });
  assert.deepEqual(Object.keys(config.runtimeEnv).sort(), [
    "XW_DSH_PERSISTENCE_ROOT",
    "XW_M6_LIVE_MODEL_PROFILE_HASH",
    "XW_M6_LIVE_MODEL_PROFILE_ROOT",
    "XW_M6_LIVE_PROVIDER_BASE_URL",
  ]);
  assert.deepEqual(Object.keys(config.dependencyEnv).sort(), [
    "XW_M6_LIVE_DEPENDENCY_LAYER_HASH",
    "XW_M6_LIVE_DEPENDENCY_ROOT",
  ]);
  assert.equal(Object.hasOwn(config, "command"), false);
  assert.equal(Object.hasOwn(config, "args"), false);
  assert.equal(Object.hasOwn(config, "cwd"), false);
  assert.equal(Object.hasOwn(config, "qualificationPath"), false);
});

test("unsealed production entry rejects before adapter/resource creation with exact blockers", () => {
  let adapterConstructions = 0;
  const entry = createM6LiveEntry({
    state: {
      getM6GateFence() { throw new Error("must not inspect the gate while statically unsealed"); },
      getM64LiveWindowAuthorizationConsumption() { throw new Error("must not inspect consumption while statically unsealed"); },
      claimM64LiveScenarioStart() { throw new Error("must not claim a scenario while statically unsealed"); },
    },
    config: { internalToken: TOKEN },
    processAdapterFactory() { adapterConstructions += 1; },
  });
  entry.assertAuthorized({ "x-control-token": TOKEN });
  assert.throws(() => entry.preflight({
    manifestRef: "m6_4_action_smoke",
    manifestHash: H("1"),
    scenarioKey: "m6_4_action_smoke-01",
    authorizationId: "m64-live-entry-auth-unsealed",
    authorizationHash: H("2"),
    authorization: { authorizationId: "m64-live-entry-auth-unsealed", envelopeHash: H("2") },
  }), (error) => {
    assert.equal(error.code, "M6_LIVE_ENTRY_UNSEALED");
    assert.equal(error.details.resourceCount, 0);
    assert.ok(error.details.blockers.includes("M6_LIVE_DEVICE_CALLBACKS_UNAVAILABLE"));
    assert.ok(error.details.blockers.includes("M6_LIVE_CHILD_PROTOCOL_DRIVER_UNAVAILABLE"));
    return true;
  });
  assert.equal(adapterConstructions, 0);
  assert.equal(entry.health().activeRuns, 0);
});

test("production process construction is bound to the signed target attestation and live-window expiry", async () => {
  const f = fixture();
  let adapterConstructions = 0;
  let launches = 0;
  const callbacks = {
    async observe() { return { externalEffect: false, actionCount: 0, frameRef: H("1") }; },
    async ground() { return { externalEffect: false, actionCount: 0, disposition: "HARD_STOP", reasonRef: H("2") }; },
    async act() { throw new Error("not used"); },
    async verify() { return { externalEffect: false, actionCount: 0, verified: false, verificationRef: H("3") }; },
    async checkpointAudit() { return { externalEffect: false, actionCount: 0, checkpointRef: H("4") }; },
    async trace() { return { externalEffect: false, actionCount: 0, traceRefs: [H("5")] }; },
    async waitHuman() { return { externalEffect: false, actionCount: 0, status: "WAITING" }; },
    async complete({ run }) { return { externalEffect: false, actionCount: 0, workerRunRef: run.workerRunRef, status: "COMPLETED" }; },
    async close() { return { schemaId: "xw.m6-run-close.v1", verifiedClosed: true }; },
  };
  const entry = createM6LiveEntry({
    state: f.state,
    config: { internalToken: TOKEN, runtimeSnapshot: f.runtimeSnapshot, issuerAllowlist: f.issuerAllowlist, qualification: f.qualification },
    callbacks,
    manifestLoader: () => f.frozenManifest,
    loadGateSnapshot: () => f.gateSnapshot,
    qualifyLaunch: () => ({ authority: { qualificationStatus: "QUALIFIED" } }),
    processAdapterFactory({ requiredTargetEnvironmentAttestationHash, requiredLiveWindowExpiresAt }) {
      adapterConstructions += 1;
      assert.equal(requiredTargetEnvironmentAttestationHash, f.authorization.environmentAttestationHash);
      assert.equal(requiredLiveWindowExpiresAt, f.authorization.expiresAt);
      const error = new Error("stop after construction binding check");
      error.code = "M6_TEST_PROCESS_CONSTRUCTION_STOP";
      throw error;
    },
    async workerDriver() {
      launches += 1;
      throw new Error("process construction rejection must precede worker launch");
    },
    now: () => NOW,
  });
  await assert.rejects(() => entry.start(f.request), (error) => {
    assert.equal(error.code, "M6_LIVE_ENTRY_UNSEALED");
    assert.ok(error.details.blockers.includes("M6_TEST_PROCESS_CONSTRUCTION_STOP"));
    assert.equal(error.details.resourceCount, 0);
    return true;
  });
  assert.equal(adapterConstructions, 1);
  assert.equal(launches, 0);
  assert.equal(entry.health().activeRuns, 0);
});

test("internal routes drive the real broker handler into the run manager and verify close/shutdown cleanup", async () => {
  const f = fixture();
  const closeEvents = [];
  let activationReads = 0;
  const state = {
    getM6GateFence() {
      activationReads += 1;
      return f.state.getM6GateFence();
    },
    getM64LiveWindowAuthorizationConsumption(authorizationId) {
      activationReads += 1;
      return f.state.getM64LiveWindowAuthorizationConsumption(authorizationId);
    },
    claimM64LiveScenarioStart: (input) => f.state.claimM64LiveScenarioStart(input),
  };
  let brokerCall;
  let observeCalls = 0;
  let actCalls = 0;
  let processCloseCalls = 0;
  let controlCloseCalls = 0;
  const callbacks = {
    async observe() { observeCalls += 1; return { externalEffect: false, actionCount: 0, frameRef: H("a") }; },
    async ground() { return { externalEffect: false, actionCount: 0, disposition: "ALLOW_ONCE", decisionRef: H("b"), operationKey: H("6") }; },
    async act({ actionSlotResolution, slotAuthority }) {
      actCalls += 1;
      assert.equal(actionSlotResolution.scenario.scenarioKey, f.request.scenarioKey);
      assert.equal(actionSlotResolution.slotAuthority.slotAuthorityHash, slotAuthority.slotAuthorityHash);
      assert.equal(actionSlotResolution.actionSlotSpec.scenarioManifestHash, f.request.manifestHash);
      return { externalEffect: true, actionCount: 1, effectStatus: "VERIFIED", actionReceiptRef: H("7"), verificationRef: H("c") };
    },
    async verify() { return { externalEffect: false, actionCount: 0, verified: true, verificationRef: H("c") }; },
    async checkpointAudit() { return { externalEffect: false, actionCount: 0, checkpointRef: H("d") }; },
    async trace() { return { externalEffect: false, actionCount: 0, traceRefs: [H("e")] }; },
    async waitHuman() { return { externalEffect: false, actionCount: 0, status: "WAITING" }; },
    async complete({ run }) { return { externalEffect: false, actionCount: 0, workerRunRef: run.workerRunRef, status: "COMPLETED" }; },
    async close({ run, context }) {
      controlCloseCalls += 1;
      closeEvents.push("manager-close");
      const attemptEvidence = publicAttemptEvidence({ run, context });
      return {
        schemaId: "xw.m6-run-close.v1",
        attemptEvidence,
        attemptEvidenceHash: attemptEvidence.attemptHash,
        verifiedClosed: true,
      };
    },
  };
  const entry = createM6LiveEntry({
    state,
    config: {
      internalToken: TOKEN,
      command: process.execPath,
      args: [],
      cwd: process.cwd(),
      runtimeSnapshot: f.runtimeSnapshot,
      issuerAllowlist: f.issuerAllowlist,
      qualification: f.qualification,
    },
    callbacks,
    manifestLoader: () => f.frozenManifest,
    loadGateSnapshot: () => f.gateSnapshot,
    qualifyLaunch: () => ({ authority: { qualificationStatus: "QUALIFIED" } }),
    processAdapterFactory({ handleToolCall }) {
      brokerCall = handleToolCall;
      return {
        launch() {
          return {
            ready: Promise.resolve({ bindingHash: H("f") }),
            broker: {
              async close() {
                closeEvents.push("broker-close");
                return { pipeClosed: true };
              },
            },
            async close() {
              processCloseCalls += 1;
              closeEvents.push("process-close");
              return {
                verifiedClosed: true,
                broker: { pipeClosed: true },
                process: { verifiedClosed: true },
              };
            },
          };
        },
      };
    },
    async workerDriver({ binding, workerRunRef }) {
      await brokerCall({ method: "worker_start", params: { workerRunRef }, binding });
      const observed = await brokerCall({ method: "phone_observe", params: { runRef: binding.runId, stepRef: "step:live-entry" }, binding });
      const grounded = await brokerCall({ method: "phone_ground", params: { frameRef: observed.frameRef, intentRef: H("8") }, binding });
      const acted = await brokerCall({ method: "phone_act", params: { decisionRef: grounded.decisionRef, operationKey: grounded.operationKey }, binding });
      await brokerCall({ method: "phone_verify", params: { actionReceiptRef: acted.actionReceiptRef, expectationRef: H("9") }, binding });
      return protocolHandle(binding, { onClose: () => closeEvents.push("worker-protocol-close") });
    },
    now: () => NOW,
  });
  const router = new ControlRouter({ control: {}, state, capabilities: {}, evidence: {}, m6LiveEntry: entry });
  const headers = { "x-control-token": TOKEN };
  const preflight = await router.handle({
    method: "POST",
    path: "/control/v1/internal/m6/live/preflight",
    headers,
    body: f.request,
  });
  assert.equal(preflight.body.preflight.status, "SEALED_PREFLIGHT");
  assert.equal(preflight.body.preflight.resourceCount, 0);
  assert.equal(activationReads, 0, "preflight re-verifies but never requires or consumes the activation receipt");
  const started = await router.handle({
    method: "POST",
    path: "/control/v1/internal/m6/live/start",
    headers,
    body: f.request,
  });
  assert.equal(started.status, 202);
  assert.equal(started.body.run.status, "RUNNING");
  assert.equal(started.body.run.runId, deriveM6LiveEntryRunId({
    authorizationHash: f.request.authorizationHash,
    scenarioKey: f.request.scenarioKey,
  }));
  assert.ok(activationReads >= 2, "start checks the current fence and atomically-written authorization receipt");
  assert.equal(started.body.run.actionCount, 1);
  assert.equal(observeCalls, 1);
  assert.equal(actCalls, 1);
  assert.doesNotMatch(JSON.stringify(started.body), new RegExp(TOKEN, "u"));
  const status = await router.handle({
    method: "GET",
    path: "/control/v1/internal/m6/live/status",
    query: new URLSearchParams({ runId: started.body.run.runId }),
    headers,
  });
  assert.equal(status.body.run.status, "RUNNING");
  const closed = await router.handle({
    method: "POST",
    path: "/control/v1/internal/m6/live/close",
    headers,
    body: { runId: started.body.run.runId, reasonCode: "CANARY_COMPLETE" },
  });
  assert.equal(closed.body.run.close.verifiedClosed, true);
  assert.equal(closed.body.run.close.attemptEvidenceHash, closed.body.run.close.attemptEvidence.attemptHash);
  const preserved = await router.handle({
    method: "GET",
    path: "/control/v1/internal/m6/live/status",
    query: new URLSearchParams({ runId: started.body.run.runId }),
    headers,
  });
  assert.deepEqual(preserved.body.run.close.attemptEvidence, closed.body.run.close.attemptEvidence);
  assert.equal(processCloseCalls, 1);
  assert.equal(controlCloseCalls, 1);
  assert.deepEqual(closeEvents, [
    "manager-close",
    "broker-close",
    "worker-protocol-close",
    "process-close",
  ]);
  assert.equal(entry.health().activeRuns, 0);
  assert.equal((await entry.shutdown()).activeRuns, 0);
});

test("SHADOW activates only under OBSERVE_ONLY and can observe/ground/close with phone_act hard-stopped", async () => {
  const f = fixture({ manifestRef: "m6_4_shadow" });
  let brokerCall;
  let actErrorCode = null;
  let callbackActCalls = 0;
  const callbacks = {
    async observe() { return { externalEffect: false, actionCount: 0, frameRef: H("1") }; },
    async ground({ slotAuthority }) {
      assert.equal(slotAuthority, null);
      return { externalEffect: false, actionCount: 0, disposition: "HARD_STOP", reasonRef: H("2") };
    },
    async act() { callbackActCalls += 1; throw new Error("shadow must never reach the action callback"); },
    async verify() { return { externalEffect: false, actionCount: 0, verified: false, verificationRef: H("3") }; },
    async checkpointAudit() { return { externalEffect: false, actionCount: 0, checkpointRef: H("4") }; },
    async trace() { return { externalEffect: false, actionCount: 0, traceRefs: [H("5")] }; },
    async waitHuman() { return { externalEffect: false, actionCount: 0, status: "WAITING" }; },
    async complete({ run }) { return { externalEffect: false, actionCount: 0, workerRunRef: run.workerRunRef, status: "COMPLETED" }; },
    async close() { return { schemaId: "xw.m6-run-close.v1", verifiedClosed: true }; },
  };
  const entry = createM6LiveEntry({
    state: f.state,
    config: {
      internalToken: TOKEN,
      runtimeSnapshot: f.runtimeSnapshot,
      issuerAllowlist: f.issuerAllowlist,
      qualification: f.qualification,
    },
    callbacks,
    manifestLoader: () => f.frozenManifest,
    loadGateSnapshot: () => f.gateSnapshot,
    qualifyLaunch: () => ({ authority: { qualificationStatus: "QUALIFIED" } }),
    processAdapterFactory({ handleToolCall }) {
      brokerCall = handleToolCall;
      return {
        launch() {
          return {
            ready: Promise.resolve(),
            broker: { async close() { return { pipeClosed: true }; } },
            async close() {
              return { verifiedClosed: true, broker: { pipeClosed: true }, process: { verifiedClosed: true } };
            },
          };
        },
      };
    },
    async workerDriver({ binding, workerRunRef }) {
      await brokerCall({ method: "worker_start", params: { workerRunRef }, binding });
      const observed = await brokerCall({ method: "phone_observe", params: { runRef: binding.runId, stepRef: "step:shadow" }, binding });
      const grounded = await brokerCall({ method: "phone_ground", params: { frameRef: observed.frameRef, intentRef: H("6") }, binding });
      assert.equal(grounded.disposition, "HARD_STOP");
      try {
        await brokerCall({ method: "phone_act", params: { decisionRef: H("7"), operationKey: H("8") }, binding });
      } catch (error) {
        actErrorCode = error.code;
      }
      return protocolHandle(binding);
    },
    now: () => NOW,
  });
  const preflight = entry.preflight(f.request);
  assert.equal(preflight.status, "SEALED_PREFLIGHT");
  const started = await entry.start(f.request);
  assert.equal(started.status, "RUNNING");
  assert.equal(started.actionCount, 0);
  assert.equal(actErrorCode, "M6_LIVE_ZERO_ACTION_PURPOSE");
  assert.equal(callbackActCalls, 0);
  const closed = await entry.close({ runId: started.runId, reasonCode: "CANARY_COMPLETE" });
  assert.equal(closed.close.verifiedClosed, true);
  assert.equal(closed.actionCount, 0);
  assert.equal(entry.health().activeRuns, 0);
});

test("close attempts manager, broker, worker protocol, and process in order and aggregates every failure", async () => {
  const f = fixture();
  const events = [];
  const codedFailure = (code) => Object.assign(new Error(code), { code });
  const callbacks = {
    async observe() { return { externalEffect: false, actionCount: 0, frameRef: H("1") }; },
    async ground() { return { externalEffect: false, actionCount: 0, disposition: "HARD_STOP", reasonRef: H("2") }; },
    async act() { throw new Error("not used"); },
    async verify() { return { externalEffect: false, actionCount: 0, verified: false, verificationRef: H("3") }; },
    async checkpointAudit() { return { externalEffect: false, actionCount: 0, checkpointRef: H("4") }; },
    async trace() { return { externalEffect: false, actionCount: 0, traceRefs: [H("5")] }; },
    async waitHuman() { return { externalEffect: false, actionCount: 0, status: "WAITING" }; },
    async complete({ run }) { return { externalEffect: false, actionCount: 0, workerRunRef: run.workerRunRef, status: "COMPLETED" }; },
    async close() {
      events.push("manager-close");
      throw codedFailure("M6_TEST_MANAGER_CLOSE");
    },
  };
  const entry = createM6LiveEntry({
    state: f.state,
    config: {
      internalToken: TOKEN,
      runtimeSnapshot: f.runtimeSnapshot,
      issuerAllowlist: f.issuerAllowlist,
      qualification: f.qualification,
    },
    callbacks,
    manifestLoader: () => f.frozenManifest,
    loadGateSnapshot: () => f.gateSnapshot,
    qualifyLaunch: () => ({ authority: { qualificationStatus: "QUALIFIED" } }),
    processAdapterFactory() {
      return {
        launch() {
          return {
            ready: Promise.resolve(),
            broker: {
              close() {
                events.push("broker-close");
                throw codedFailure("M6_TEST_BROKER_CLOSE");
              },
            },
            close() {
              events.push("process-close");
              throw codedFailure("M6_TEST_PROCESS_CLOSE");
            },
          };
        },
      };
    },
    async workerDriver({ binding }) {
      return protocolHandle(binding, {
        onClose() {
          events.push("worker-protocol-close");
          throw codedFailure("M6_TEST_PROTOCOL_CLOSE");
        },
      });
    },
    now: () => NOW,
  });
  const started = await entry.start(f.request);
  await assert.rejects(
    () => entry.close({ runId: started.runId, reasonCode: "SAFETY_STOP" }),
    (error) => {
      assert.equal(error.code, "M6_LIVE_RUN_CLOSE_UNVERIFIED");
      assert.deepEqual(error.details.blockers, [
        "M6_TEST_MANAGER_CLOSE",
        "M6_TEST_BROKER_CLOSE",
        "M6_TEST_PROTOCOL_CLOSE",
        "M6_TEST_PROCESS_CLOSE",
      ]);
      assert.deepEqual(error.details.cleanup, {
        callFenceDrained: true,
        controlResourcesClosed: false,
        brokerStopAttempted: true,
        workerProtocolClosed: false,
        brokerClosed: false,
        processClosed: false,
      });
      return true;
    },
  );
  assert.deepEqual(events, [
    "manager-close",
    "broker-close",
    "worker-protocol-close",
    "process-close",
  ]);
});

test("one cohort authorization reaches each exact scenario with distinct refs while substitution and durable replay create zero new resources", async () => {
  const f = fixture();
  let claimCalls = 0;
  let adapterConstructions = 0;
  const driverScenarios = [];
  const state = {
    ...f.state,
    claimM64LiveScenarioStart(input) {
      claimCalls += 1;
      return f.state.claimM64LiveScenarioStart(input);
    },
  };
  const callbacks = {
    async observe() { return { externalEffect: false, actionCount: 0, frameRef: H("1") }; },
    async ground() { return { externalEffect: false, actionCount: 0, disposition: "HARD_STOP", reasonRef: H("2") }; },
    async act() { throw new Error("not used"); },
    async verify() { return { externalEffect: false, actionCount: 0, verified: false, verificationRef: H("3") }; },
    async checkpointAudit() { return { externalEffect: false, actionCount: 0, checkpointRef: H("4") }; },
    async trace() { return { externalEffect: false, actionCount: 0, traceRefs: [H("5")] }; },
    async waitHuman() { return { externalEffect: false, actionCount: 0, status: "WAITING" }; },
    async complete({ run }) { return { externalEffect: false, actionCount: 0, workerRunRef: run.workerRunRef, status: "COMPLETED" }; },
    async close() { return { schemaId: "xw.m6-run-close.v1", verifiedClosed: true }; },
  };
  const makeEntry = () => createM6LiveEntry({
    state,
    config: {
      internalToken: TOKEN,
      runtimeSnapshot: f.runtimeSnapshot,
      issuerAllowlist: f.issuerAllowlist,
      qualification: f.qualification,
    },
    callbacks,
    manifestLoader: () => f.frozenManifest,
    loadGateSnapshot: () => f.gateSnapshot,
    qualifyLaunch: () => ({ authority: { qualificationStatus: "QUALIFIED" } }),
    processAdapterFactory() {
      adapterConstructions += 1;
      return {
        launch() {
          return {
            ready: Promise.resolve(),
            async close() {
              return { verifiedClosed: true, broker: { pipeClosed: true }, process: { verifiedClosed: true } };
            },
          };
        },
      };
    },
    async workerDriver({ binding, scenario, scenarioKey }) {
      assert.equal(scenario.scenarioKey, scenarioKey);
      driverScenarios.push(scenarioKey);
      return protocolHandle(binding);
    },
    now: () => NOW,
  });
  const entry = makeEntry();
  await assert.rejects(() => entry.start({ ...f.request, scenarioKey: "m6_4_action_smoke-99" }), (error) => {
    assert.equal(error.code, "M6_LIVE_ENTRY_SCENARIO_MISMATCH");
    assert.equal(error.details.resourceCount, 0);
    return true;
  });
  assert.equal(claimCalls, 0);
  assert.equal(adapterConstructions, 0);

  const first = await entry.start(f.request);
  const second = await entry.start({ ...f.request, scenarioKey: "m6_4_action_smoke-02" });
  assert.notEqual(first.runId, second.runId);
  assert.notEqual(first.workerRunRef, second.workerRunRef);
  assert.deepEqual(driverScenarios, ["m6_4_action_smoke-01", "m6_4_action_smoke-02"]);
  assert.equal(claimCalls, 2);
  assert.equal(adapterConstructions, 2);
  await entry.close({ runId: first.runId, reasonCode: "CANARY_COMPLETE" });
  await entry.close({ runId: second.runId, reasonCode: "CANARY_COMPLETE" });

  const restartedEntry = makeEntry();
  await assert.rejects(() => restartedEntry.start(f.request), (error) => {
    assert.equal(error.code, "M6_LIVE_SCENARIO_ALREADY_CLAIMED");
    assert.equal(error.details.resourceCount, 0);
    return true;
  });
  assert.equal(adapterConstructions, 2, "durable replay rejects before adapter construction or process resources");
});

test("broker fatal invalidates and drains late calls before manager and lower-layer cleanup", async () => {
  const f = fixture();
  const events = [];
  let brokerCall;
  let lateEffects = 0;
  const callbacks = {
    async observe({ context }) {
      events.push("handler-enter");
      return new Promise((resolve) => {
        context.abortSignal.addEventListener("abort", () => {
          events.push("handler-abort");
          resolve({ externalEffect: false, actionCount: 0, frameRef: H("1") });
        }, { once: true });
      }).then((result) => {
        if (!context.abortSignal.aborted) lateEffects += 1;
        return result;
      });
    },
    async ground() { return { externalEffect: false, actionCount: 0, disposition: "HARD_STOP", reasonRef: H("2") }; },
    async act() { lateEffects += 1; throw new Error("not used"); },
    async verify() { return { externalEffect: false, actionCount: 0, verified: false, verificationRef: H("3") }; },
    async checkpointAudit() { return { externalEffect: false, actionCount: 0, checkpointRef: H("4") }; },
    async trace() { return { externalEffect: false, actionCount: 0, traceRefs: [H("5")] }; },
    async waitHuman() { return { externalEffect: false, actionCount: 0, status: "WAITING" }; },
    async complete({ run }) { return { externalEffect: false, actionCount: 0, workerRunRef: run.workerRunRef, status: "COMPLETED" }; },
    async close() { events.push("manager-close"); return { schemaId: "xw.m6-run-close.v1", verifiedClosed: true }; },
  };
  const entry = createM6LiveEntry({
    state: f.state,
    config: {
      internalToken: TOKEN,
      runtimeSnapshot: f.runtimeSnapshot,
      issuerAllowlist: f.issuerAllowlist,
      qualification: f.qualification,
    },
    callbacks,
    manifestLoader: () => f.frozenManifest,
    loadGateSnapshot: () => f.gateSnapshot,
    qualifyLaunch: () => ({ authority: { qualificationStatus: "QUALIFIED" } }),
    processAdapterFactory({ handleToolCall, onFatal }) {
      brokerCall = handleToolCall;
      let fatalRaised = false;
      const broker = {
        abort(error) {
          events.push("broker-abort");
          if (fatalRaised) return Promise.resolve();
          fatalRaised = true;
          return onFatal(error);
        },
      };
      return {
        launch() {
          return {
            broker,
            ready: Promise.resolve(),
            async close() {
              events.push("process-close");
              return { verifiedClosed: true, broker: { pipeClosed: true }, process: { verifiedClosed: true } };
            },
          };
        },
      };
    },
    async workerDriver({ binding, workerRunRef, live }) {
      await brokerCall({ method: "worker_start", params: { workerRunRef }, binding });
      const pending = brokerCall({ method: "phone_observe", params: { runRef: binding.runId, stepRef: "step:fatal-drain" }, binding })
        .then(() => null, (error) => error);
      while (!events.includes("handler-enter")) await Promise.resolve();
      const fatal = Object.assign(new Error("simulated broker timeout"), { code: "M6_LIVE_BROKER_TOOL_TIMEOUT" });
      await live.broker.abort(fatal);
      const lateResult = await pending;
      assert.equal(lateResult.code, "M6_LIVE_CALL_FENCE_CLOSED");
    },
    now: () => NOW,
  });
  await assert.rejects(() => entry.start(f.request), { code: "M6_LIVE_BROKER_TOOL_TIMEOUT" });
  assert.equal(lateEffects, 0);
  assert.ok(events.indexOf("handler-abort") < events.indexOf("manager-close"));
  assert.ok(events.indexOf("manager-close") < events.lastIndexOf("broker-abort"));
  assert.ok(events.lastIndexOf("broker-abort") < events.indexOf("process-close"));
  assert.equal(entry.health().activeRuns, 0);
});

test("a non-cooperative in-flight handler cannot hang fatal cleanup or prevent a failure closeout", async () => {
  const f = fixture();
  const events = [];
  let brokerCall;
  let capturedRunId = null;
  const callbacks = {
    async observe() {
      events.push("handler-enter");
      return new Promise(() => {});
    },
    async ground() { return { externalEffect: false, actionCount: 0, disposition: "HARD_STOP", reasonRef: H("2") }; },
    async act() { throw new Error("not used"); },
    async verify() { return { externalEffect: false, actionCount: 0, verified: false, verificationRef: H("3") }; },
    async checkpointAudit() { return { externalEffect: false, actionCount: 0, checkpointRef: H("4") }; },
    async trace() { return { externalEffect: false, actionCount: 0, traceRefs: [H("5")] }; },
    async waitHuman() { return { externalEffect: false, actionCount: 0, status: "WAITING" }; },
    async complete({ run }) { return { externalEffect: false, actionCount: 0, workerRunRef: run.workerRunRef, status: "COMPLETED" }; },
    async close() {
      events.push("manager-close");
      return { schemaId: "xw.m6-run-close.v1", verifiedClosed: true };
    },
  };
  const entry = createM6LiveEntry({
    state: f.state,
    config: {
      internalToken: TOKEN,
      runtimeSnapshot: f.runtimeSnapshot,
      issuerAllowlist: f.issuerAllowlist,
      qualification: f.qualification,
      cleanupDrainTimeoutMs: 20,
      cleanupStepTimeoutMs: 100,
    },
    callbacks,
    manifestLoader: () => f.frozenManifest,
    loadGateSnapshot: () => f.gateSnapshot,
    qualifyLaunch: () => ({ authority: { qualificationStatus: "QUALIFIED" } }),
    processAdapterFactory({ handleToolCall, onFatal }) {
      brokerCall = handleToolCall;
      let fatalRaised = false;
      return {
        launch() {
          const broker = {
            abort(error) {
              events.push("broker-abort");
              if (fatalRaised) return Promise.resolve({ pipeClosed: true });
              fatalRaised = true;
              return onFatal(error);
            },
          };
          return {
            broker,
            ready: Promise.resolve(),
            async close() {
              events.push("process-close");
              return { verifiedClosed: true, broker: { pipeClosed: true }, process: { verifiedClosed: true } };
            },
          };
        },
      };
    },
    async workerDriver({ binding, workerRunRef, live }) {
      capturedRunId = binding.runId;
      await brokerCall({ method: "worker_start", params: { workerRunRef }, binding });
      void brokerCall({ method: "phone_observe", params: { runRef: binding.runId, stepRef: "step:hanging" }, binding }).catch(() => {});
      while (!events.includes("handler-enter")) await Promise.resolve();
      const fatal = Object.assign(new Error("simulated timeout"), { code: "M6_LIVE_BROKER_TOOL_TIMEOUT" });
      await live.broker.abort(fatal).catch(() => {});
      return protocolHandle(binding);
    },
    now: () => NOW,
  });
  const startedAt = Date.now();
  await assert.rejects(() => entry.start(f.request), { code: "M6_LIVE_BROKER_TOOL_TIMEOUT" });
  assert.ok(Date.now() - startedAt < 1_000, "cleanup must be bounded independently of the hanging handler");
  assert.ok(events.indexOf("manager-close") < events.lastIndexOf("broker-abort"));
  assert.ok(events.lastIndexOf("broker-abort") < events.indexOf("process-close"));
  assert.equal(entry.health().activeRuns, 0);
  const failureCloseout = entry.status({ runId: capturedRunId });
  assert.equal(failureCloseout.status, "FAILED_CLOSED");
  assert.equal(failureCloseout.close.verifiedClosed, false);
  assert.ok(failureCloseout.close.blockers.includes("M6_LIVE_CALL_FENCE_DRAIN_TIMEOUT"));
  assert.equal(failureCloseout.close.controlResourcesClosed, true);
  assert.equal(failureCloseout.close.processClosed, true);
});

test("internal route bodies are additionalProperties false and never accept a body token or raw device field", async () => {
  const f = fixture();
  const entry = createM6LiveEntry({ state: f.state, config: { internalToken: TOKEN } });
  const router = new ControlRouter({ control: {}, state: f.state, capabilities: {}, evidence: {}, m6LiveEntry: entry });
  await assert.rejects(() => router.handle({
    method: "POST",
    path: "/control/v1/internal/m6/live/preflight",
    headers: { "x-control-token": TOKEN },
    body: { ...f.request, token: TOKEN, deviceId: "forbidden" },
  }), (error) => {
    assert.equal(error.code, "M6_LIVE_ENTRY_INPUT_CLOSED");
    assert.equal(error.details.resourceCount, 0);
    return true;
  });
});

test("epoch recovery closes every exact Control-Plane-owned run, returns only opaque receipt refs, and stays latched", async () => {
  const f = fixture();
  const { closeReasons, entry } = recoveryTestEntry(f);
  const first = await entry.start(f.request);
  const second = await entry.start({ ...f.request, scenarioKey: "m6_4_action_smoke-02" });

  const recovered = await entry.recoverEpoch({
    gateEpochHash: f.authorization.gateEpochHash,
    purpose: f.authorization.purpose,
  });
  assert.equal(recovered.schemaId, "xw.m6-live-entry-epoch-recovery.v1");
  assert.equal(recovered.status, "RECOVERED");
  assert.equal(recovered.stopNewStarts, true);
  assert.equal(recovered.attempted, 2);
  assert.equal(recovered.verifiedClosed, 2);
  assert.equal(recovered.activeMatchingRuns, 0);
  assert.equal(recovered.controlPlaneOwnedActiveRuns, 0);
  assert.equal(recovered.externalResourceState, "NOT_ASSERTED");
  assert.deepEqual(recovered.closeReceipts.map((receipt) => receipt.runId), [first.runId, second.runId].sort());
  assert.ok(recovered.closeReceipts.every((receipt) => /^[0-9a-f]{64}$/u.test(receipt.closeReceiptHash)));
  assert.ok(recovered.closeReceipts.every((receipt) => receipt.attemptEvidenceHash === null));
  assert.deepEqual(closeReasons, ["RECOVERY", "RECOVERY"]);
  assert.equal(entry.status({ runId: first.runId }).close.reasonCode, "RECOVERY");
  assert.equal(entry.status({ runId: second.runId }).close.reasonCode, "RECOVERY");

  const repeated = await entry.closeActiveEpoch({
    gateEpochHash: f.authorization.gateEpochHash,
    purpose: f.authorization.purpose,
  });
  assert.equal(repeated.attempted, 0);
  assert.equal(repeated.verifiedClosed, 0);
  assert.deepEqual(repeated.closeReceipts, []);
  assert.equal(entry.health().status, "RECOVERY_LATCHED");
  assert.throws(() => entry.preflight({ ...f.request, scenarioKey: "m6_4_action_smoke-03" }), {
    code: "M6_LIVE_EPOCH_RECOVERY_LATCHED",
  });
  await assert.rejects(() => entry.start({ ...f.request, scenarioKey: "m6_4_action_smoke-03" }), {
    code: "M6_LIVE_EPOCH_RECOVERY_LATCHED",
  });
});

test("epoch recovery waits an admitted start across the ownership race and cannot miss the resulting active run", async () => {
  const f = fixture();
  let enterDriver;
  let releaseDriver;
  const driverEntered = new Promise((resolve) => { enterDriver = resolve; });
  const driverRelease = new Promise((resolve) => { releaseDriver = resolve; });
  const { entry } = recoveryTestEntry(f, {
    async workerDriver({ binding }) {
      enterDriver();
      await driverRelease;
      return protocolHandle(binding);
    },
  });

  const startPromise = entry.start(f.request);
  await driverEntered;
  let recoverySettled = false;
  const recoveryPromise = entry.recoverEpoch({
    gateEpochHash: f.authorization.gateEpochHash,
    purpose: f.authorization.purpose,
  }).finally(() => { recoverySettled = true; });
  await Promise.resolve();
  assert.equal(recoverySettled, false, "recovery must wait the already-admitted start barrier");
  releaseDriver();
  const started = await startPromise;
  const recovered = await recoveryPromise;
  assert.equal(recovered.inFlightStartsSettled, 1);
  assert.equal(recovered.attempted, 1);
  assert.equal(recovered.closeReceipts[0].runId, started.runId);
  assert.equal(entry.status({ runId: started.runId }).close.verifiedClosed, true);
  assert.equal(entry.health().activeRuns, 0);
});

test("epoch recovery never closes a different epoch and an empty process map makes no external-resource claim", async () => {
  const f = fixture();
  const { entry } = recoveryTestEntry(f);
  const started = await entry.start(f.request);
  const wrongEpoch = await entry.recoverEpoch({
    gateEpochHash: H("3"),
    purpose: f.authorization.purpose,
  });
  assert.equal(wrongEpoch.attempted, 0);
  assert.equal(wrongEpoch.verifiedClosed, 0);
  assert.equal(wrongEpoch.controlPlaneOwnedActiveRuns, 1);
  assert.equal(wrongEpoch.externalResourceState, "NOT_ASSERTED");
  assert.equal(entry.status({ runId: started.runId }).closed, false);
  await entry.recoverEpoch({
    gateEpochHash: f.authorization.gateEpochHash,
    purpose: f.authorization.purpose,
  });

  const restarted = recoveryTestEntry(f).entry;
  const empty = await restarted.recoverEpoch({
    gateEpochHash: f.authorization.gateEpochHash,
    purpose: f.authorization.purpose,
  });
  assert.equal(empty.attempted, 0);
  assert.equal(empty.verifiedClosed, 0);
  assert.equal(empty.controlPlaneOwnedActiveRuns, 0);
  assert.equal(empty.externalResourceState, "NOT_ASSERTED");
  assert.equal(Object.hasOwn(empty, "externalResources"), false);
});

test("epoch recovery fails explicitly and preserves active counts when a production close is unverified", async () => {
  const f = fixture();
  const { entry } = recoveryTestEntry(f, {
    async processClose() {
      return {
        verifiedClosed: false,
        broker: { pipeClosed: false },
        process: { verifiedClosed: false },
      };
    },
  });
  await entry.start(f.request);
  await assert.rejects(() => entry.recoverEpoch({
    gateEpochHash: f.authorization.gateEpochHash,
    purpose: f.authorization.purpose,
  }), (error) => {
    assert.equal(error.code, "M6_LIVE_EPOCH_RECOVERY_UNVERIFIED");
    assert.equal(error.details.attempted, 1);
    assert.equal(error.details.verifiedClosed, 0);
    assert.equal(error.details.failed, 1);
    assert.equal(error.details.activeRuns, 1);
    assert.equal(error.details.activeMatchingRuns, 1);
    assert.equal(error.details.failures.length, 1);
    assert.match(error.details.failures[0].runId, /^run:[0-9a-f]{64}$/u);
    return true;
  });
  assert.equal(entry.health().activeRuns, 1);
  assert.equal(entry.health().status, "RECOVERY_LATCHED");
  await assert.rejects(() => entry.start({ ...f.request, scenarioKey: "m6_4_action_smoke-02" }), {
    code: "M6_LIVE_EPOCH_RECOVERY_LATCHED",
  });
});

test("an unverified failed-closed recovery cannot be retried into a false zero-run success", async () => {
  const f = fixture();
  const { entry } = recoveryTestEntry(f, {
    async workerDriver({ binding }) {
      return {
        ...protocolHandle(binding),
        async close() {
          return { schemaId: "xw.m6-live-worker-protocol-close.v1", verifiedClosed: false };
        },
      };
    },
  });
  await entry.start(f.request);
  const request = {
    gateEpochHash: f.authorization.gateEpochHash,
    purpose: f.authorization.purpose,
  };
  await assert.rejects(() => entry.recoverEpoch(request), (error) => {
    assert.equal(error.code, "M6_LIVE_EPOCH_RECOVERY_UNVERIFIED");
    assert.equal(error.details.activeMatchingRuns, 0);
    return true;
  });
  assert.equal(entry.health().activeRuns, 0);
  await assert.rejects(() => entry.recoverEpoch(request), (error) => {
    assert.equal(error.code, "M6_LIVE_EPOCH_RECOVERY_UNVERIFIED");
    assert.equal(error.details.repeated, true);
    assert.equal(error.details.activeRuns, 0);
    assert.equal(error.details.activeMatchingRuns, 0);
    return true;
  });
});
