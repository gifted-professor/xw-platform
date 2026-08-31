import assert from "node:assert/strict";
import test from "node:test";

import { canonicalJson, sha256 } from "../control-plane/lib/canonical.mjs";
import { CapabilityRegistry } from "../control-plane/lib/capability-registry.mjs";
import { ControlPlaneError } from "../control-plane/lib/errors.mjs";
import { createM6GroundedActionFacade } from "../control-plane/lib/m6-grounded-action-facade.mjs";
import { createM6TypedTransport, validateM6TypedInvocation } from "../control-plane/lib/m6-typed-transport.mjs";
import { StateStore } from "../control-plane/lib/state-store.mjs";
import { deriveLiveVisualBlockSet, deriveTargetEnvironmentAttestation } from "../../../packages/kernel/lib/m6-live-grounding.mjs";
import { deriveM6ActionSlotSpec, deriveM6LogicalActionIdentity, deriveM6TrustedParameterHash } from "../../../packages/kernel/lib/m6-action-slot.mjs";
import { seedM6CompositeAuthority } from "./helpers/m6-composite-authority.mjs";

const H = (value) => sha256(value);
const M6_CAPABILITY = {
  schemaVersion: 1, id: "xiaowei.m6.grounded_run", appId: "xiaowei", packageName: null, versionRange: "test",
  maturity: "E3", risk: "R1", resources: ["device"], inputSchema: { type: "object", properties: {}, additionalProperties: false },
  outputSchema: { type: "object" }, preconditions: [], verification: { mode: "state", description: "M6 after-frame" },
  restoration: { required: false, description: "bounded action" }, timeoutMs: 5000, idempotency: "external_effect",
  automationPolicy: { mode: "lab_only", canaryOnly: true },
  implementation: { adapter: "xiaowei", action: "m6_grounded_run", implementationClosureHash: H("implementation-closure") }, evidence: [],
  availability: "canary_only", exposure: "internal", invocationPolicy: { allowedModes: ["composite_action"] }, lifecycle: "canary_only",
};

function seedFence(state) {
  const raw = {
    schemaId: "xw.m6-live-gate.v1", gateId: "m6-gate", mode: "CLOSED", status: "closed",
    releaseId: "release-facade", sourceCommit: "a".repeat(40), actor: "operator:test",
    lockHashes: { runtimeProfile: H("r"), hardRedlinePolicy: H("h"), groundingRuntime: H("g") },
    allowlist: ["01"], issuedAt: "2030-01-01T00:00:00Z", expiresAt: "2030-01-02T00:00:00Z",
    parentEpochHash: null, closeoutRef: { id: "c", sha256: H("c") }, aggregateSealRef: { id: "a", sha256: H("a") }, rollbackTargetEpochHash: null,
  };
  const epoch = { ...raw, epochHash: sha256(`xw.m6-live-gate.v1:${canonicalJson(raw)}`) };
  state.seedM6GateFence({ epoch, locksHash: H("locks") });
  return state.promoteM6GateFence({ expectedEpochHash: epoch.epochHash, expectedGeneration: 0, next: {
    gateId: "m6-gate", epochHash: H("action-epoch"), mode: "GROUNDED_ACTION", purpose: "M6_4_ACTION_SMOKE",
    allowlist: ["01"], expiresAt: "2030-01-01T01:00:00Z", releaseId: raw.releaseId, sourceCommit: raw.sourceCommit, locksHash: H("locks-v2"),
  } });
}

function environment() {
  return deriveTargetEnvironmentAttestation({
    appPackageHash: H("pkg"), appBuildHash: H("build"), signingHash: H("sign"), osBuildHash: H("os"),
    displayHash: H("display"), localeThemeHash: H("locale"), imeHash: H("ime"), accessibilityHash: H("access"),
    accountBindingHash: H("account"),
    accountIsolationHash: H("account"), capturedAt: "2030-01-01T00:00:00Z", expiresAt: "2030-01-01T01:00:00Z",
  });
}

test("facade executes one grounded typed write under the same formal session/lease and verifies after-frame", async () => {
  const wall = Date.parse("2030-01-01T00:00:00Z");
  const state = new StateStore({ now: () => wall });
  try {
    state.upsertNode({ nodeId: "node-1", authority: true });
    const registry = new CapabilityRegistry([M6_CAPABILITY]);
    const m6Capability = registry.require(M6_CAPABILITY.id);
    state.syncCapabilities(registry);
    const device = state.upsertDevice({ deviceId: "device-1", alias: "01", physicalLabel: "test", nodeId: "node-1", runtimeId: "runtime-1", routingProfile: { enabled: true, capabilityIds: [m6Capability.id] } });
    const fence = seedFence(state);
    const composite = seedM6CompositeAuthority(state, { fence });
    const session = state.createSession({
      actorId: composite.actorId, authorityNodeId: "node-1", deviceId: device.deviceId,
      capability: m6Capability, canary: true, invocation: "composite_action",
      m6CompositeAuthority: composite.authority,
    });
    const env = environment();
    const frame = { frameId: H("frame"), environmentAttestationHash: env.attestationHash, focusHash: H("focus") };
    const dumpXml = `<hierarchy><node text="公开笔记" resource-id="com.xhs:id/card" class="android.view.View" package="com.xhs" clickable="true" bounds="[10,100][900,500]"/><node text="" resource-id="" class="android.view.View" package="com.xhs" clickable="false" bounds="[0,0][1080,2400]"/></hierarchy>`;
    const precomputed = deriveLiveVisualBlockSet({ frame, dumpXml, environmentAttestation: env });
    const block = precomputed.blockSet.blocks[0];
    const actionSlotSpec = deriveM6ActionSlotSpec({
      scenarioManifestHash: H("manifest"), scenarioId: "scenario-1", logicalStepId: "step-1", actionSlotOrdinal: 0,
      alias: "01", primitive: "tap", actionFamily: "open_public_note", intentRef: H("intent"), intentPolicyHash: H("intent-policy"),
      targetKind: "block", targetEligibilityHash: H("eligibility"), trustedParameterHash: deriveM6TrustedParameterHash({}), allowedStateHash: H("states"),
      effectBoundaryHash: H("effects"), budgetPolicyHash: H("budget"), redlinePolicyHash: H("redline"),
      resetPolicyHash: H("reset"), oracleHash: H("oracle"), verificationPolicyHash: H("verify"),
    });
    const planHash = H("plan");
    const { operationKey } = deriveM6LogicalActionIdentity({ planHash, actionSlotSpec });
    const capabilityJob = state.createJob({
      idempotencyKey: composite.idempotencyKey,
      operationKey: composite.idempotencyKey,
      actorId: composite.actorId,
      authorityNodeId: "node-1",
      deviceId: device.deviceId,
      capability: m6Capability,
      params: composite.params,
      sessionId: session.sessionId,
      status: "running",
      canary: true,
      invocation: "composite_action",
      externalEffect: true,
      m6CompositeAuthority: composite.authority,
    }).job;
    const typedAuthorization = state.issueTransportActionAuthorization({
      kind: "capability_job", purpose: "execute", jobId: capabilityJob.jobId, runId: capabilityJob.runId,
      leaseId: session.leaseId, deviceId: device.deviceId, operationKey,
      capabilityContractHash: m6Capability.capabilityContractHash,
      implementationClosureHash: m6Capability.implementation.implementationClosureHash,
      jobStatus: "running", source: "m6-parent-broker", ttlMs: 5_000, now: state.now,
    });
    const slot = {
      slotSpecHash: actionSlotSpec.actionSlotSpecHash, frameId: frame.frameId, blockId: block.blockId, uiStateGeneration: 1,
      appPackageHash: H("pkg"), focusHash: frame.focusHash, pageFingerprint: precomputed.blockSet.pageFingerprint,
      rotation: 0, displayHash: H("display"), environmentAttestationHash: env.attestationHash,
    };
    let writes = 0;
    const typedTransport = createM6TypedTransport({
      async invokeWrite(binding, invocation, privateMaterial) {
        writes += 1;
        assert.equal(invocation.primitive, "tap");
        assert.equal(binding.decisionRef.length, 64);
        assert.deepEqual(privateMaterial.point, { x: 455, y: 300 });
        return { ok: true };
      },
    });
    const monoValues = [46_000, 46_010, 46_100];
    const facade = createM6GroundedActionFacade({
      state,
      typedTransport,
      async captureWithinRun({ phase }) {
        return { frame, dumpXml, observation: { observationId: `obs-${phase}`, evidenceRefs: [H(phase)] } };
      },
      async readCurrentState() { return slot; },
      async materializePrivate({ blockSet, privateGeometry }) {
        const selected = blockSet.blocks.find((entry) => entry.blockId === block.blockId);
        const region = privateGeometry.get(selected.boundsRef);
        return { point: { x: Math.round((region.x1 + region.x2) / 2), y: Math.round((region.y1 + region.y2) / 2) } };
      },
      async verifyAfter() { return { ok: true, stateChanged: true }; },
      monoNow: () => monoValues.shift(),
    });
    const result = await facade.execute({
      session: { ...session, leaseId: session.leaseId },
      environmentAttestation: env,
      intent: { operationKey, operation: "tap", targetKind: "block", intentRef: actionSlotSpec.intentRef },
      candidateBlockId: block.blockId,
      bindings: {
        runId: capabilityJob.runId, sessionId: session.sessionId, leaseId: session.leaseId, gateEpochHash: fence.epochHash,
        gateGeneration: fence.generation, grantHash: H("grant"), stepId: "step-1", environmentAttestationHash: env.attestationHash,
      },
      slot,
      actionSlotSpec,
      planHash,
      timing: { issuedAtMs: wall, expiresAtMs: wall + 5_000, dispatchDeadlineMonoMs: 50_000 },
      fence,
      manifestStep: {
        logicalStepId: actionSlotSpec.logicalStepId, actionSlotOrdinal: actionSlotSpec.actionSlotOrdinal,
        primitive: actionSlotSpec.primitive, actionFamily: actionSlotSpec.actionFamily,
        intentRef: actionSlotSpec.intentRef, intentPolicyHash: actionSlotSpec.intentPolicyHash,
        targetKind: actionSlotSpec.targetKind, targetEligibilityHash: actionSlotSpec.targetEligibilityHash,
        trustedParams: {}, trustedParameterHash: actionSlotSpec.trustedParameterHash,
        allowedStateHash: actionSlotSpec.allowedStateHash, effectBoundaryHash: actionSlotSpec.effectBoundaryHash,
        budgetPolicyHash: actionSlotSpec.budgetPolicyHash, redlinePolicyHash: actionSlotSpec.redlinePolicyHash,
        resetPolicyHash: actionSlotSpec.resetPolicyHash, oracleHash: actionSlotSpec.oracleHash,
        verificationPolicyHash: actionSlotSpec.verificationPolicyHash,
      },
      typedAuthorization,
    });
    assert.equal(result.effectStatus, "VERIFIED");
    assert.equal(result.actionCount, 1);
    assert.equal(writes, 1);
    assert.equal(state.validateSession(session.sessionId, session.token).leaseId, session.leaseId);
    state.releaseSession(session.sessionId, session.token);
  } finally { state.close(); }
});

test("typed transport rejects raw coordinates, shell, unknown primitive and model-supplied raw text", () => {
  for (const invocation of [
    { primitive: "tap", target: { kind: "block" }, trustedParams: { x: 1 } },
    { primitive: "open_app", target: { kind: "none" }, trustedParams: { package: "raw" } },
    { primitive: "type_search_text", target: { kind: "block" }, trustedParams: { text: "raw" } },
    { primitive: "shell", target: { kind: "none" }, trustedParams: {} },
  ]) {
    assert.throws(() => validateM6TypedInvocation(invocation), { code: "M6_TYPED_TRANSPORT_INVALID" });
  }
  assert.equal(validateM6TypedInvocation({ primitive: "observe", target: { kind: "none" }, trustedParams: {} }).writePrimitive, false);
  assert.equal(validateM6TypedInvocation({ primitive: "wait", target: { kind: "none" }, trustedParams: { durationMs: 1 } }).writePrimitive, false);
});

test("fresh capture time is outside the 250ms send guard while post-return private material delay remains bounded", async () => {
  const env = environment();
  const frame = { frameId: H("timing-frame"), environmentAttestationHash: env.attestationHash, focusHash: H("timing-focus") };
  const dumpXml = `<hierarchy><node text="公开笔记" resource-id="com.xhs:id/card" class="android.view.View" package="com.xhs" clickable="true" bounds="[10,100][900,500]"/><node text="" class="android.view.View" package="com.xhs" clickable="false" bounds="[0,0][1080,2400]"/></hierarchy>`;
  const provider = deriveLiveVisualBlockSet({ frame, dumpXml, environmentAttestation: env });
  const block = provider.blockSet.blocks[0];
  const actionSlotSpec = deriveM6ActionSlotSpec({
    scenarioManifestHash: H("timing-manifest"), scenarioId: "timing-scenario", logicalStepId: "timing-step", actionSlotOrdinal: 0,
    alias: "01", primitive: "tap", actionFamily: "open_public_note", intentRef: H("timing-intent"), intentPolicyHash: H("timing-intent-policy"),
    targetKind: "block", targetEligibilityHash: H("timing-eligibility"), trustedParameterHash: deriveM6TrustedParameterHash({}), allowedStateHash: H("timing-states"),
    effectBoundaryHash: H("timing-effects"), budgetPolicyHash: H("timing-budget"), redlinePolicyHash: H("timing-redline"),
    resetPolicyHash: H("timing-reset"), oracleHash: H("timing-oracle"), verificationPolicyHash: H("timing-verify"),
  });
  const planHash = H("timing-plan");
  const { operationKey } = deriveM6LogicalActionIdentity({ planHash, actionSlotSpec });
  const slot = {
    slotSpecHash: actionSlotSpec.actionSlotSpecHash,
    frameId: frame.frameId,
    blockId: block.blockId,
    uiStateGeneration: 7,
    appPackageHash: H("timing-package"),
    focusHash: frame.focusHash,
    pageFingerprint: provider.blockSet.pageFingerprint,
    rotation: 0,
    displayHash: env.displayHash,
    environmentAttestationHash: env.attestationHash,
  };
  const manifestStep = {
    logicalStepId: actionSlotSpec.logicalStepId,
    actionSlotOrdinal: actionSlotSpec.actionSlotOrdinal,
    primitive: actionSlotSpec.primitive,
    actionFamily: actionSlotSpec.actionFamily,
    intentRef: actionSlotSpec.intentRef,
    intentPolicyHash: actionSlotSpec.intentPolicyHash,
    targetKind: actionSlotSpec.targetKind,
    targetEligibilityHash: actionSlotSpec.targetEligibilityHash,
    trustedParams: {},
    trustedParameterHash: actionSlotSpec.trustedParameterHash,
    allowedStateHash: actionSlotSpec.allowedStateHash,
    effectBoundaryHash: actionSlotSpec.effectBoundaryHash,
    budgetPolicyHash: actionSlotSpec.budgetPolicyHash,
    redlinePolicyHash: actionSlotSpec.redlinePolicyHash,
    resetPolicyHash: actionSlotSpec.resetPolicyHash,
    oracleHash: actionSlotSpec.oracleHash,
    verificationPolicyHash: actionSlotSpec.verificationPolicyHash,
  };

  async function executeWithMaterialDelay(materialDelayMs) {
    let mono = 1_000;
    let writes = 0;
    let aborts = 0;
    let guardTiming = null;
    const session = { sessionId: "timing-session", leaseId: "timing-lease", token: "opaque" };
    const storedAuthorization = {
      authorizationId: "timing-authorization",
      jobId: "timing-job",
      deviceId: "timing-device",
      capabilityContractHash: H("timing-capability"),
      implementationClosureHash: H("timing-implementation"),
    };
    const state = {
      validateSession() {
        return { ...session, scopeCapabilityId: "xiaowei.m6.grounded_run", canary: true };
      },
      getTransportActionAuthorization() { return storedAuthorization; },
      getJob() { return { jobId: storedAuthorization.jobId }; },
      prepareM6GroundedAction() { return { ledger: { actionId: "timing-action" } }; },
      authorizeM6GroundedActionSend() {},
      markM6ActionTransportStart({ guardStartedMonoMs, writeReadyMonoMs }) {
        guardTiming = { guardStartedMonoMs, writeReadyMonoMs };
        if (writeReadyMonoMs - guardStartedMonoMs > 250) {
          throw new ControlPlaneError("M6_TCB_CURRENT_STATE_GUARD", "post-capture materialization exceeded the send guard", { status: 409 });
        }
      },
      recordM6ActionTransportOutcome() {},
      completeM6GroundedAction() { return { transportCounter: 1 }; },
      getM6ActionLedger() { return { transportCounter: 0, status: "EXECUTING" }; },
      abortM6GroundedActionNotSent() { aborts += 1; },
    };
    const facade = createM6GroundedActionFacade({
      state,
      typedTransport: {
        prepareWrite() { return { binding: {} }; },
        async dispatchPrepared() { writes += 1; return { ok: true }; },
      },
      async captureWithinRun({ phase }) {
        return { frame, dumpXml, observation: { observationId: `timing-${phase}`, evidenceRefs: [H(phase)] } };
      },
      async readCurrentState() {
        mono += 5_000; // a real live-strict capture is allowed to take seconds
        return slot;
      },
      async materializePrivate() {
        mono += materialDelayMs;
        return {};
      },
      async verifyAfter() { return { ok: true, stateChanged: true }; },
      monoNow: () => mono,
    });
    const promise = facade.execute({
      session,
      environmentAttestation: env,
      intent: { operationKey, operation: "tap", targetKind: "block", intentRef: actionSlotSpec.intentRef },
      candidateBlockId: block.blockId,
      bindings: {
        runId: "timing-run", sessionId: session.sessionId, leaseId: session.leaseId,
        gateEpochHash: H("timing-gate"), gateGeneration: 1, grantHash: H("timing-grant"),
        stepId: "timing-step", environmentAttestationHash: env.attestationHash,
      },
      slot,
      actionSlotSpec,
      planHash,
      timing: { issuedAtMs: 0, expiresAtMs: 10_000, dispatchDeadlineMonoMs: 10_000 },
      fence: { epochHash: H("timing-gate"), generation: 1 },
      manifestStep,
      typedAuthorization: { authorizationId: storedAuthorization.authorizationId },
    });
    return Object.freeze({ promise, state: () => ({ writes, aborts, guardTiming }) });
  }

  const allowed = await executeWithMaterialDelay(10);
  const allowedResult = await allowed.promise;
  assert.equal(allowedResult.effectStatus, "VERIFIED");
  assert.deepEqual(allowed.state(), {
    writes: 1,
    aborts: 0,
    guardTiming: { guardStartedMonoMs: 6_000, writeReadyMonoMs: 6_010 },
  });

  const blocked = await executeWithMaterialDelay(251);
  await assert.rejects(blocked.promise, { code: "M6_TCB_CURRENT_STATE_GUARD" });
  assert.deepEqual(blocked.state(), {
    writes: 0,
    aborts: 1,
    guardTiming: { guardStartedMonoMs: 6_000, writeReadyMonoMs: 6_251 },
  });
});

test("ancestor redline hard-stop returns no candidate and never reaches permit, counter, or typed transport", async () => {
  const env = environment();
  const frame = { frameId: H("redline-frame"), environmentAttestationHash: env.attestationHash, focusHash: H("focus") };
  const dumpXml = `<hierarchy><node text="" class="android.widget.Button" package="com.xhs" clickable="true" bounds="[10,100][900,400]"><node text="删除账号" class="android.widget.TextView" package="com.xhs" clickable="false" bounds="[30,140][600,260]"/></node><node text="" class="android.view.View" clickable="false" bounds="[0,0][1080,2400]"/></hierarchy>`;
  const actionSlotSpec = deriveM6ActionSlotSpec({
    scenarioManifestHash: H("manifest-redline"), scenarioId: "scenario-redline", logicalStepId: "step-redline", actionSlotOrdinal: 0,
    alias: "01", primitive: "tap", actionFamily: "safe-navigation", intentRef: H("intent-redline"), intentPolicyHash: H("intent-policy-redline"),
    targetKind: "block", targetEligibilityHash: H("eligibility-redline"), trustedParameterHash: deriveM6TrustedParameterHash({}), allowedStateHash: H("states-redline"),
    effectBoundaryHash: H("effects-redline"), budgetPolicyHash: H("budget-redline"), redlinePolicyHash: H("redline-policy"),
    resetPolicyHash: H("reset-redline"), oracleHash: H("oracle-redline"), verificationPolicyHash: H("verify-redline"),
  });
  const planHash = H("plan-redline");
  const { operationKey } = deriveM6LogicalActionIdentity({ planHash, actionSlotSpec });
  const forbidden = () => { throw new Error("redline path crossed a forbidden authority boundary"); };
  const facade = createM6GroundedActionFacade({
    state: {
      validateSession() {
        return { sessionId: "session-redline", leaseId: "lease-redline", scopeCapabilityId: "xiaowei.m6.grounded_run", canary: true };
      },
      prepareM6GroundedAction: forbidden,
    },
    typedTransport: { prepareWrite: forbidden, dispatchPrepared: forbidden },
    async captureWithinRun() { return { frame, dumpXml }; },
    readCurrentState: forbidden,
    materializePrivate: forbidden,
    verifyAfter: forbidden,
  });
  const result = await facade.execute({
    session: { sessionId: "session-redline", leaseId: "lease-redline", token: "opaque" },
    environmentAttestation: env,
    intent: { operationKey, operation: "tap", targetKind: "block", intentRef: actionSlotSpec.intentRef },
    bindings: { sessionId: "session-redline", leaseId: "lease-redline" },
    slot: { slotSpecHash: actionSlotSpec.actionSlotSpecHash },
    actionSlotSpec,
    planHash,
    manifestStep: {
      logicalStepId: actionSlotSpec.logicalStepId, actionSlotOrdinal: actionSlotSpec.actionSlotOrdinal,
      primitive: actionSlotSpec.primitive, actionFamily: actionSlotSpec.actionFamily,
      intentRef: actionSlotSpec.intentRef, intentPolicyHash: actionSlotSpec.intentPolicyHash,
      targetKind: actionSlotSpec.targetKind, targetEligibilityHash: actionSlotSpec.targetEligibilityHash,
      trustedParams: {}, trustedParameterHash: actionSlotSpec.trustedParameterHash,
      allowedStateHash: actionSlotSpec.allowedStateHash, effectBoundaryHash: actionSlotSpec.effectBoundaryHash,
      budgetPolicyHash: actionSlotSpec.budgetPolicyHash, redlinePolicyHash: actionSlotSpec.redlinePolicyHash,
      resetPolicyHash: actionSlotSpec.resetPolicyHash, oracleHash: actionSlotSpec.oracleHash,
      verificationPolicyHash: actionSlotSpec.verificationPolicyHash,
    },
  });
  assert.deepEqual(result, {
    disposition: "HARD_STOP", externalEffect: false, actionCount: 0, effectStatus: "NOT_SENT",
    reason: "M6_LIVE_HARD_REDLINE_NO_SAFE_CANDIDATE",
  });
});
