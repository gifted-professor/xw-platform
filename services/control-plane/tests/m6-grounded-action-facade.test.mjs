import assert from "node:assert/strict";
import test from "node:test";

import { canonicalJson, sha256 } from "../control-plane/lib/canonical.mjs";
import { CapabilityRegistry } from "../control-plane/lib/capability-registry.mjs";
import { createM6GroundedActionFacade } from "../control-plane/lib/m6-grounded-action-facade.mjs";
import { createM6TypedTransport, validateM6TypedInvocation } from "../control-plane/lib/m6-typed-transport.mjs";
import { StateStore } from "../control-plane/lib/state-store.mjs";
import { deriveLiveVisualBlockSet, deriveTargetEnvironmentAttestation } from "../../../packages/kernel/lib/m6-live-grounding.mjs";
import { deriveM6ActionSlotSpec, deriveM6LogicalActionIdentity, deriveM6TrustedParameterHash } from "../../../packages/kernel/lib/m6-action-slot.mjs";

const H = (value) => sha256(value);
const M6_CAPABILITY = {
  schemaVersion: 1, id: "m6.agentic_session", appId: "xiaowei", packageName: "com.xhs", versionRange: "test",
  maturity: "E3", risk: "R1", resources: ["device"], inputSchema: { type: "object", properties: {}, additionalProperties: false },
  outputSchema: { type: "object" }, preconditions: [], verification: { mode: "state", description: "M6 after-frame" },
  restoration: { required: false, description: "bounded action" }, timeoutMs: 5000, idempotency: "external_effect",
  automationPolicy: { mode: "automatic" }, implementation: { adapter: "m6-typed-adapter", action: "grounded_action" }, evidence: [],
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
    accountIsolationHash: H("account"), capturedAt: "2030-01-01T00:00:00Z", expiresAt: "2030-01-01T01:00:00Z",
  });
}

test("facade executes one grounded typed write under the same formal session/lease and verifies after-frame", async () => {
  const wall = Date.parse("2030-01-01T00:00:00Z");
  const state = new StateStore({ now: () => wall });
  try {
    state.upsertNode({ nodeId: "node-1", authority: true });
    state.syncCapabilities(new CapabilityRegistry([M6_CAPABILITY]));
    const device = state.upsertDevice({ deviceId: "device-1", alias: "01", physicalLabel: "test", nodeId: "node-1", runtimeId: "runtime-1", routingProfile: { enabled: true, capabilityIds: [M6_CAPABILITY.id] } });
    const session = state.createSession({ actorId: "agent:test", deviceId: device.deviceId, sessionKind: "open_action", canary: true });
    const fence = seedFence(state);
    const env = environment();
    const frame = { frameId: H("frame"), environmentAttestationHash: env.attestationHash, focusHash: H("focus") };
    const dumpXml = `<hierarchy><node text="公开笔记" resource-id="com.xhs:id/card" class="android.view.View" package="com.xhs" clickable="true" bounds="[10,100][900,500]"/><node text="" resource-id="" class="android.view.View" package="com.xhs" clickable="false" bounds="[0,0][1080,2400]"/></hierarchy>`;
    const precomputed = deriveLiveVisualBlockSet({ frame, dumpXml, environmentAttestation: env });
    const block = precomputed.blockSet.blocks[0];
    const actionSlotSpec = deriveM6ActionSlotSpec({
      scenarioManifestHash: H("manifest"), scenarioId: "scenario-1", logicalStepId: "step-1", actionSlotOrdinal: 0,
      alias: "01", primitive: "tap", actionFamily: "open_public_note", intentRef: H("intent"), intentPolicyHash: H("intent-policy"),
      targetKind: "block", targetEligibilityHash: H("eligibility"), trustedParameterHash: deriveM6TrustedParameterHash({}), allowedStateHash: H("states"),
      effectBoundaryHash: H("effects"), budgetPolicyHash: H("budget"), redlinePolicyHash: H("redline"), verificationPolicyHash: H("verify"),
    });
    const planHash = H("plan");
    const { operationKey } = deriveM6LogicalActionIdentity({ planHash, actionSlotSpec });
    const capabilityJob = state.createJob({
      idempotencyKey: "m6-facade-job", actorId: "agent:test", authorityNodeId: "node-1", deviceId: device.deviceId,
      capability: M6_CAPABILITY, sessionId: session.sessionId, status: "running",
    }).job;
    const typedAuthorization = state.issueTransportActionAuthorization({
      kind: "capability_job", purpose: "execute", jobId: capabilityJob.jobId, runId: capabilityJob.runId,
      leaseId: session.leaseId, deviceId: device.deviceId, operationKey,
      capabilityContractHash: H("capability-contract"), implementationClosureHash: H("implementation-closure"),
      jobStatus: "running", source: "m6-parent-broker", ttlMs: 5_000, now: state.now,
    });
    const slot = {
      slotSpecHash: actionSlotSpec.actionSlotSpecHash, frameId: frame.frameId, blockId: block.blockId, uiStateGeneration: 1,
      appPackageHash: H("pkg"), focusHash: frame.focusHash, pageFingerprint: precomputed.blockSet.pageFingerprint,
      rotation: 0, displayHash: H("display"), environmentAttestationHash: env.attestationHash,
    };
    let writes = 0;
    const typedTransport = createM6TypedTransport({
      async invokeWrite(invocation, privateMaterial) {
        writes += 1;
        assert.equal(invocation.primitive, "tap");
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
      manifestStep: { primitive: "tap", trustedParams: {}, trustedParameterHash: actionSlotSpec.trustedParameterHash },
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
