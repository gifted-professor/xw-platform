import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { canonicalJson, sha256 } from "../control-plane/lib/canonical.mjs";
import { CapabilityRegistry } from "../control-plane/lib/capability-registry.mjs";
import { deriveM6PrivateMaterialBinding } from "../control-plane/lib/m6-typed-transport.mjs";
import { StateStore } from "../control-plane/lib/state-store.mjs";
import { seedM6CompositeAuthority } from "./helpers/m6-composite-authority.mjs";

const H = (char) => char.repeat(64);
const contexts = new WeakMap();
const M6_CAPABILITY = {
  schemaVersion: 1, id: "xiaowei.m6.grounded_run", appId: "xiaowei", packageName: null, versionRange: "test",
  maturity: "E3", risk: "R1", resources: ["device"], inputSchema: { type: "object", properties: {}, additionalProperties: false },
  outputSchema: { type: "object" }, preconditions: [], verification: { mode: "state", description: "M6 after-frame" },
  restoration: { required: false, description: "bounded action" }, timeoutMs: 5000, idempotency: "external_effect",
  automationPolicy: { mode: "lab_only", canaryOnly: true },
  implementation: { adapter: "xiaowei", action: "m6_grounded_run", implementationClosureHash: H("b") }, evidence: [],
  availability: "canary_only", exposure: "internal", invocationPolicy: { allowedModes: ["composite_action"] }, lifecycle: "canary_only",
};

function formalize(state, d) {
  let context = contexts.get(state);
  if (!context) {
    const registry = new CapabilityRegistry([M6_CAPABILITY]);
    const capability = registry.require(M6_CAPABILITY.id);
    state.syncCapabilities(registry);
    state.upsertNode({ nodeId: "m6-node", authority: true });
    const device = state.upsertDevice({ deviceId: "device-m6-grounded", alias: "01", physicalLabel: "m6-test", nodeId: "m6-node", runtimeId: "m6-runtime", routingProfile: { enabled: true, capabilityIds: [capability.id] } });
    const composite = seedM6CompositeAuthority(state, { fence: state.getM6GateFence() });
    const session = state.createSession({
      actorId: composite.actorId, authorityNodeId: "m6-node", deviceId: device.deviceId,
      capability, canary: true, invocation: "composite_action",
      m6CompositeAuthority: composite.authority,
    });
    const job = state.createJob({
      idempotencyKey: composite.idempotencyKey,
      operationKey: composite.idempotencyKey,
      actorId: composite.actorId,
      authorityNodeId: "m6-node",
      deviceId: device.deviceId,
      capability,
      params: composite.params,
      sessionId: session.sessionId,
      status: "running",
      canary: true,
      invocation: "composite_action",
      externalEffect: true,
      m6CompositeAuthority: composite.authority,
    }).job;
    context = { capability, device, session, job };
    contexts.set(state, context);
  }
  const job = context.job;
  Object.assign(d.bindings, {
    runId: job.runId, sessionId: context.session.sessionId, leaseId: context.session.leaseId,
    jobId: job.jobId, deviceId: context.device.deviceId, capabilityId: context.capability.id,
    capabilityContractHash: context.capability.capabilityContractHash,
    implementationClosureHash: context.capability.implementation.implementationClosureHash,
    sessionScopeCapabilityId: context.capability.id, canary: true, alias: "01", actionSlotSpecHash: H("f"),
  });
  return job;
}

function seedEpoch() {
  const raw = {
    schemaId: "xw.m6-live-gate.v1", gateId: "m6-gate", mode: "CLOSED", status: "closed",
    releaseId: "release-action-test", sourceCommit: "a".repeat(40), actor: "operator:test",
    lockHashes: { runtimeProfile: H("1"), hardRedlinePolicy: H("2"), groundingRuntime: H("3") },
    allowlist: ["01"], issuedAt: "2030-01-01T00:00:00Z", expiresAt: "2030-01-02T00:00:00Z",
    parentEpochHash: null, closeoutRef: { id: "c", sha256: H("4") }, aggregateSealRef: { id: "a", sha256: H("5") }, rollbackTargetEpochHash: null,
  };
  return { ...raw, epochHash: sha256(`xw.m6-live-gate.v1:${canonicalJson(raw)}`) };
}

function openFence(state) {
  const seed = seedEpoch();
  state.seedM6GateFence({ epoch: seed, locksHash: H("6") });
  return state.promoteM6GateFence({
    expectedEpochHash: seed.epochHash,
    expectedGeneration: 0,
    next: {
      gateId: seed.gateId, epochHash: H("7"), mode: "GROUNDED_ACTION", purpose: "M6_4_ACTION_SMOKE",
      allowlist: ["01"], expiresAt: "2030-01-01T01:00:00Z", releaseId: seed.releaseId,
      sourceCommit: seed.sourceCommit, locksHash: H("8"),
    },
  });
}

function decision(fence, operationKey = "operation-1", ref = "9") {
  const derivedOperationKey = /^[0-9a-f]{64}$/u.test(operationKey) ? operationKey : sha256(operationKey);
  return {
    schemaId: "xw.grounding-decision.v2", decisionRef: H(ref), operationKey: derivedOperationKey, disposition: "ALLOW_ONCE",
    target: { kind: "block", frameId: H("b"), blockId: H("c") },
    bindings: {
      runId: "run-1", sessionId: "session-1", leaseId: "lease-1", gateEpochHash: fence.epochHash,
      gateGeneration: fence.generation, grantHash: H("d"), stepId: "step-1", environmentAttestationHash: H("e"),
    },
  };
}

function slot() {
  const region = { x1: 10, y1: 100, x2: 900, y2: 500 };
  const boundsRef = sha256(`xw.m6-private-bounds.v1:${H("c")}:${canonicalJson(region)}`);
  return {
    slotSpecHash: H("f"), frameId: H("b"), blockId: H("c"), uiStateGeneration: 1,
    appPackageHash: H("1"), focusHash: H("2"), pageFingerprint: H("3"), rotation: 0,
    displayHash: H("4"), environmentAttestationHash: H("e"), primitive: "tap", targetKind: "block",
    trustedParameterHash: sha256("xw.m6-trusted-parameters.v1:{}"), boundsRef, appRef: null, textRef: null,
  };
}

function expected(d, s) {
  return { operationKey: d.operationKey, target: d.target, bindings: d.bindings, slot: s };
}

function typedAuth(state, d, overrides = {}) {
  const job = state.getJob(d.bindings.jobId);
  return state.issueTransportActionAuthorization({
    kind: "capability_job", purpose: "execute", jobId: d.bindings.jobId, runId: d.bindings.runId,
    leaseId: d.bindings.leaseId, deviceId: d.bindings.deviceId, operationKey: d.operationKey,
    capabilityContractHash: job.capability.capabilityContractHash,
    implementationClosureHash: job.capability.implementation.implementationClosureHash,
    jobStatus: "running", source: "m6-parent-broker",
    ttlMs: 5_000, now: state.now, ...overrides,
  });
}

function privateBinding(d, s, currentState = s) {
  const region = { x1: 10, y1: 100, x2: 900, y2: 500 };
  return deriveM6PrivateMaterialBinding({
    invocation: { primitive: "tap", target: d.target, trustedParams: {}, operationKey: d.operationKey },
    privateMaterial: { point: { x: 455, y: 300 }, bounds: region, boundsRef: s.boundsRef },
    authority: {
      schemaId: "xw.m6-private-dispatch-authority.v1", operationKey: d.operationKey, decisionRef: d.decisionRef,
      slotSpecHash: s.slotSpecHash, primitive: "tap", target: d.target,
      trustedParameterHash: s.trustedParameterHash,
      currentStateHash: sha256(`xw.m6-current-state.v1:${canonicalJson(currentState)}`),
      boundsRef: s.boundsRef, appRef: null, textRef: null,
    },
  });
}

test("three transactions reuse Action Ledger ASSESSED→EXECUTING→EXECUTED→VERIFIED→COMPLETED with one transport", () => {
  let now = Date.parse("2030-01-01T00:00:00Z");
  const state = new StateStore({ now: () => now });
  try {
    const fence = openFence(state);
    const d = decision(fence);
    formalize(state, d);
    const s = slot();
    const prepared = state.prepareM6GroundedAction({
      decision: d, slot: s, timing: { issuedAtMs: now, expiresAtMs: now + 5_000, dispatchDeadlineMonoMs: 50_000 }, fence,
    });
    assert.equal(prepared.ledger.status, "ASSESSED");
    assert.equal(prepared.ledger.transportCounter, 0);
    const authorized = state.authorizeM6GroundedActionSend({ actionId: prepared.ledger.actionId, fence, expectedPermit: expected(d, s), nowMonoMs: 46_000, typedAuthorization: typedAuth(state, d) });
    assert.equal(authorized.status, "EXECUTING");
    const sending = state.markM6ActionTransportStart({ actionId: prepared.ledger.actionId, currentState: s, guardStartedMonoMs: 46_010, writeReadyMonoMs: 46_100, privateMaterialBinding: privateBinding(d, s) });
    assert.equal(sending.transportCounter, 1);
    assert.equal(sending.status, "EXECUTING");
    assert.equal(state.recordM6ActionTransportOutcome({ actionId: prepared.ledger.actionId, ok: true, result: { writeAck: true } }).status, "EXECUTED");
    const completed = state.completeM6GroundedAction({
      actionId: prepared.ledger.actionId,
      afterObservation: { observationId: "obs-after", evidenceRefs: [H("a")] },
      verification: { ok: true, stateChanged: true },
      receipt: { actionId: prepared.ledger.actionId, operationKey: d.operationKey },
    });
    assert.equal(completed.status, "COMPLETED");
    assert.equal(completed.transportCounter, 1);
    assert.equal(completed.effectStatus, "VERIFIED_EFFECT");
  } finally { state.close(); }
});

test("global claim, guard drift, and post-counter failure split no-effect from ambiguous", () => {
  let now = Date.parse("2030-01-01T00:00:00Z");
  const state = new StateStore({ now: () => now });
  try {
    const fence = openFence(state);
    const s = slot();
    const first = decision(fence, "same-operation", "8");
    formalize(state, first);
    const prepared = state.prepareM6GroundedAction({ decision: first, slot: s, timing: { issuedAtMs: now, expiresAtMs: now + 5_000, dispatchDeadlineMonoMs: 50_000 }, fence });
    assert.throws(() => state.prepareM6GroundedAction({
      decision: decision(fence, "same-operation", "7"), slot: s,
      timing: { issuedAtMs: now, expiresAtMs: now + 5_000, dispatchDeadlineMonoMs: 50_000 }, fence,
    }), { code: "M6_LOGICAL_ACTION_CLAIM_CONFLICT" });
    state.authorizeM6GroundedActionSend({ actionId: prepared.ledger.actionId, fence, expectedPermit: expected(first, s), nowMonoMs: 46_000, typedAuthorization: typedAuth(state, first) });
    const driftedState = { ...s, focusHash: H("0") };
    assert.throws(() => state.markM6ActionTransportStart({
      actionId: prepared.ledger.actionId, currentState: driftedState, guardStartedMonoMs: 46_010, writeReadyMonoMs: 46_100,
      privateMaterialBinding: privateBinding(first, s, driftedState),
    }), { code: "M6_TCB_CURRENT_STATE_GUARD" });
    const blocked = state.getM6ActionLedger(prepared.ledger.actionId);
    assert.equal(blocked.transportCounter, 0);
    assert.equal(blocked.externalEffect, false);

    const second = decision(fence, "operation-2", "6");
    formalize(state, second);
    const p2 = state.prepareM6GroundedAction({ decision: second, slot: s, timing: { issuedAtMs: now, expiresAtMs: now + 5_000, dispatchDeadlineMonoMs: 60_000 }, fence });
    state.authorizeM6GroundedActionSend({ actionId: p2.ledger.actionId, fence, expectedPermit: expected(second, s), nowMonoMs: 56_000, typedAuthorization: typedAuth(state, second) });
    state.markM6ActionTransportStart({ actionId: p2.ledger.actionId, currentState: s, guardStartedMonoMs: 56_010, writeReadyMonoMs: 56_100, privateMaterialBinding: privateBinding(second, s) });
    const ambiguous = state.recordM6ActionTransportOutcome({ actionId: p2.ledger.actionId, ok: false, errorCode: "WRITE_UNKNOWN" });
    assert.equal(ambiguous.status, "AMBIGUOUS");
    assert.equal(ambiguous.transportCounter, 1);
    assert.equal(ambiguous.externalEffect, true);
  } finally { state.close(); }
});

test("restart never retries: unsent becomes BLOCKED and counter=1 becomes AMBIGUOUS", () => {
  const root = mkdtempSync(join(tmpdir(), "m6-ledger-restart-"));
  const dbPath = join(root, "control.db");
  let now = Date.parse("2030-01-01T00:00:00Z");
  let state = new StateStore({ dbPath, now: () => now });
  try {
    const fence = openFence(state);
    const s = slot();
    const unsentDecision = decision(fence, "restart-unsent", "5");
    formalize(state, unsentDecision);
    const unsent = state.prepareM6GroundedAction({ decision: unsentDecision, slot: s, timing: { issuedAtMs: now, expiresAtMs: now + 5_000, dispatchDeadlineMonoMs: 70_000 }, fence });
    const sentDecision = decision(fence, "restart-sent", "4");
    formalize(state, sentDecision);
    const sent = state.prepareM6GroundedAction({ decision: sentDecision, slot: s, timing: { issuedAtMs: now, expiresAtMs: now + 5_000, dispatchDeadlineMonoMs: 80_000 }, fence });
    state.authorizeM6GroundedActionSend({ actionId: sent.ledger.actionId, fence, expectedPermit: expected(sentDecision, s), nowMonoMs: 76_000, typedAuthorization: typedAuth(state, sentDecision) });
    state.markM6ActionTransportStart({ actionId: sent.ledger.actionId, currentState: s, guardStartedMonoMs: 76_010, writeReadyMonoMs: 76_100, privateMaterialBinding: privateBinding(sentDecision, s) });
    state.close();
    state = new StateStore({ dbPath, now: () => now });
    assert.equal(state.getM6ActionLedger(unsent.ledger.actionId).status, "BLOCKED");
    assert.equal(state.getM6ActionLedger(sent.ledger.actionId).status, "AMBIGUOUS");
  } finally {
    try { state.close(); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});

test("tx#2 atomically binds and consumes permit plus capability-job typed authorization", () => {
  const now = Date.parse("2030-01-01T00:00:00Z");
  const state = new StateStore({ now: () => now });
  try {
    const fence = openFence(state);
    const s = slot();
    const d = decision(fence, "atomic-typed-auth", "3");
    formalize(state, d);
    const prepared = state.prepareM6GroundedAction({ decision: d, slot: s, timing: { issuedAtMs: now, expiresAtMs: now + 5_000, dispatchDeadlineMonoMs: 50_000 }, fence });
    const wrong = state.issueTransportActionAuthorization({
      kind: "capability_job", purpose: "execute", jobId: "job-wrong", runId: "wrong-run", leaseId: d.bindings.leaseId,
      deviceId: "device-m6-grounded", operationKey: d.operationKey, capabilityContractHash: H("a"), jobStatus: "running", now: state.now,
    });
    assert.throws(() => state.authorizeM6GroundedActionSend({ actionId: prepared.ledger.actionId, fence, expectedPermit: expected(d, s), nowMonoMs: 46_000, typedAuthorization: wrong }), { code: "M6_TYPED_AUTH_BINDING_MISMATCH" });
    assert.equal(state.getM6GroundingPermit(prepared.permit.permitId).consumedAt, null);
    assert.equal(state.getTransportActionAuthorization(wrong.authorization.authorizationId).consumedAt, null);
    assert.equal(state.getM6ActionLedger(prepared.ledger.actionId).status, "ASSESSED");

    const probes = [
      { auth: () => typedAuth(state, d, { capabilityContractHash: H("0") }) },
      { auth: () => typedAuth(state, d, { implementationClosureHash: H("0") }) },
      { auth: () => typedAuth(state, d, { source: "capability_job" }) },
      {
        auth: () => typedAuth(state, d),
        expectedPermit: { ...expected(d, s), slot: { ...s, slotSpecHash: H("0") } },
      },
      {
        mutate: () => state.db.prepare("UPDATE sessions SET scope_capability_id='wrong.scope' WHERE session_id=?").run(d.bindings.sessionId),
        restore: () => state.db.prepare("UPDATE sessions SET scope_capability_id='xiaowei.m6.grounded_run' WHERE session_id=?").run(d.bindings.sessionId),
        auth: () => typedAuth(state, d),
      },
      {
        mutate: () => state.db.prepare("UPDATE sessions SET canary=0 WHERE session_id=?").run(d.bindings.sessionId),
        restore: () => state.db.prepare("UPDATE sessions SET canary=1 WHERE session_id=?").run(d.bindings.sessionId),
        auth: () => typedAuth(state, d),
      },
      {
        mutate: () => state.db.prepare("UPDATE devices SET alias='02' WHERE device_id=?").run(d.bindings.deviceId),
        restore: () => state.db.prepare("UPDATE devices SET alias='01' WHERE device_id=?").run(d.bindings.deviceId),
        auth: () => typedAuth(state, d),
      },
      {
        mutate: () => state.db.prepare("UPDATE jobs SET capability_json=? WHERE job_id=?")
          .run(canonicalJson({ ...state.getJob(d.bindings.jobId).capability, id: "wrong.capability" }), d.bindings.jobId),
        restore: () => state.db.prepare("UPDATE jobs SET capability_json=? WHERE job_id=?")
          .run(canonicalJson(state.getCapabilityRecord("xiaowei.m6.grounded_run")), d.bindings.jobId),
        auth: () => typedAuth(state, d),
      },
    ];
    for (const probe of probes) {
      probe.mutate?.();
      const candidate = probe.auth();
      assert.throws(() => state.authorizeM6GroundedActionSend({
        actionId: prepared.ledger.actionId,
        fence,
        expectedPermit: probe.expectedPermit || expected(d, s),
        nowMonoMs: 46_000,
        typedAuthorization: candidate,
      }), { code: "M6_TYPED_AUTH_BINDING_MISMATCH" });
      assert.equal(state.getM6GroundingPermit(prepared.permit.permitId).consumedAt, null);
      assert.equal(state.getTransportActionAuthorization(candidate.authorization.authorizationId).consumedAt, null);
      assert.equal(state.getM6ActionLedger(prepared.ledger.actionId).transportCounter, 0);
      probe.restore?.();
    }
    const right = typedAuth(state, d);
    const authorized = state.authorizeM6GroundedActionSend({ actionId: prepared.ledger.actionId, fence, expectedPermit: expected(d, s), nowMonoMs: 46_000, typedAuthorization: right });
    assert.equal(authorized.status, "EXECUTING");
    assert.ok(state.getM6GroundingPermit(prepared.permit.permitId).consumedAt);
    assert.ok(state.getTransportActionAuthorization(right.authorization.authorizationId).consumedAt);
    assert.equal(authorized.authorizationReceipt.typedAuthorization.kind, "capability_job");
  } finally { state.close(); }
});
