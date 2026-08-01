import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { AdapterRegistry, ControlPlane } from "../control-plane/lib/control-plane.mjs";
import { CapabilityRegistry } from "../control-plane/lib/capability-registry.mjs";
import { DeviceRunRuntime } from "../control-plane/lib/device-run.mjs";
import { EffectLedger } from "../control-plane/lib/effect-ledger.mjs";
import { EvidenceStore } from "../control-plane/lib/evidence-store.mjs";
import { MissionRuntime } from "../control-plane/lib/mission-runtime.mjs";
import { StateStore } from "../control-plane/lib/state-store.mjs";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/mission-freedom-single-device.fixture.json", import.meta.url), "utf8"));
const AUTHORITY = "DESKTOP-3I1EVHE";
const checkpoints = {
  offline: "passed",
  r0r1Canary: "pending_live",
  legacyNonMissionR2ManualGate: "pending_live",
  scopedAutomaticR2: "blocked_by_adr_acceptance",
  independentReview: "pending",
  restorationAndLeaseCleanup: "pending_live",
};

function snapshot(surface, extra = {}) {
  const now = new Date().toISOString();
  return { surface, createdAt: now, observedAt: now, ...extra };
}

function correctRecheck(target) {
  return {
    readiness: { source: "control-plane", ready: true, fresh: true },
    app: fixture.policy.app, account: fixture.policy.account, targetFingerprint: target,
    pageFingerprint: "acceptance-page", beforeState: "before", control: true,
  };
}

test("single-device Freedom acceptance matrix stays offline and leaves all live gates pending", async () => {
  const root = mkdtempSync(join(tmpdir(), "freedom-acceptance-"));
  const state = new StateStore({ dbPath: join(root, "control.db") });
  const evidence = new EvidenceStore({ runsRoot: join(root, "runs"), state, minFreeBytes: 0, minExternalEffectFreeBytes: 0 });
  const calls = [];
  const verifies = [];
  const restores = [];
  const adapter = {
    id: "acceptance-adapter",
    async execute(input) { calls.push(input); return { adapter: "fake", boundTarget: input.target }; },
    async verify(input) { verifies.push(input); return { ok: true, evidenceRefs: ["offline-evidence-hash"] }; },
    async restore(input) { restores.push(input); return { ok: true }; },
  };
  const control = new ControlPlane({
    state, capabilities: { capabilities: [] }, adapters: new AdapterRegistry([adapter]), evidence,
    authorityNodeId: AUTHORITY, schedulerIntervalMs: 50, leaseTtlMs: 60000, leaseHeartbeatMs: 5000,
    missionAutoApprovalEnabled: true, adrAccepted: true, acquireTransportLock: () => Promise.resolve(() => {}),
  });
  try {
    state.upsertNode({ nodeId: AUTHORITY, authority: true });
    const device = state.upsertDevice({
      alias: fixture.device.alias, physicalLabel: fixture.device.physicalLabel, nodeId: AUTHORITY,
      runtimeId: "fixture-private-runtime", routingProfile: { enabled: true, tags: fixture.device.tags, capabilityIds: [] },
    });
    control.start();

    // The migration guard is a separately reportable offline checkpoint: false flag blocks
    // before allocation, never downgrading a Mission into per-effect approval.
    const guarded = new ControlPlane({ state, capabilities: { capabilities: [] }, adapters: new AdapterRegistry([]), evidence,
      authorityNodeId: AUTHORITY, missionAutoApprovalEnabled: false, adrAccepted: false });
    const blocked = guarded.submitMission({ actor: "agent:runner", idempotencyKey: "acceptance-adr-block", policy: fixture.policy });
    assert.equal(blocked.reason, "ADR_0008_NOT_ACCEPTED");
    assert.equal(state.listDeviceRuns({ missionId: blocked.mission.missionId }).length, 0);

    const submitted = control.submitMission({ actor: "agent:runner", idempotencyKey: "acceptance-run", policy: fixture.policy });
    assert.equal(submitted.status, "running");
    assert.equal(submitted.run.deviceId, device.deviceId);
    assert.equal(submitted.run.lease.ownerDeviceRunId, submitted.run.deviceRunId);
    control.deviceRuns.heartbeatDeviceRun(submitted.run.deviceRunId, submitted.run.token);

    const tuple = submitted.run.tuple;
    const stale = new Date(Date.now() - 6001).toISOString();
    for (const { envelope, code, decision = "blocked" } of [
      { code: "INTENT_MISMATCH", envelope: { declaredIntent: "back", snapshot: snapshot("social-effect", { effectAction: "follow" }), observedTargetFingerprint: fixture.target } },
      { code: "SNAPSHOT_STALE", envelope: { declaredIntent: "tap", snapshot: { surface: "social-effect", createdAt: stale, observedAt: stale, effectAction: "follow" }, observedTargetFingerprint: fixture.target } },
      { code: "SURFACE_UNKNOWN", envelope: { declaredIntent: "tap", snapshot: snapshot("unknown"), observedTargetFingerprint: fixture.target } },
      { code: "TARGET_MISMATCH", envelope: { declaredIntent: "tap", declaredTarget: "agent-claimed-target", snapshot: snapshot("social-effect", { effectAction: "follow" }), observedTargetFingerprint: fixture.target } },
      { code: "SCOPE_VIOLATION", decision: "scope_violation", envelope: { declaredIntent: "tap", snapshot: snapshot("social-effect", { effectAction: "follow" }), observedTargetFingerprint: "outside-mission-target" } },
    ]) {
      const result = await control.executeMissionPrimitive(tuple, { primitive: "tap", envelope });
      assert.equal(result.verdict.decision, decision);
      assert.equal(result.verdict.code, code);
    }
    assert.equal(state.listMissionEffects(submitted.mission.missionId).length, 0);
    assert.equal(state.db.prepare("SELECT COUNT(*) AS c FROM jobs WHERE approval_required=1").get().c, 0);
    // Payment is a protected observed intent, not an authorizable Mission scope action.
    const paymentIntent = await control.executeMissionPrimitive(tuple, { primitive: "tap", envelope: {
      declaredIntent: "tap", snapshot: snapshot("payment"), observedTargetFingerprint: fixture.target,
    } });
    assert.equal(paymentIntent.verdict.decision, "phc");
    assert.equal(paymentIntent.verdict.code, "PHC_PAYMENT");
    assert.equal(state.listMissionEffects(submitted.mission.missionId).length, 0);

    const ecp = control.createEffectCommitProtocol({
      recheck: async (input) => correctRecheck(input.target),
      execute: async (input) => adapter.execute(input),
      verify: async (input) => adapter.verify(input),
      restore: async (input) => adapter.restore(input),
      recordEvidence: ({ effectId }) => evidence.appendEvent(submitted.run.deviceRunId, { type: "acceptance.effect", effectId }),
    });
    const social = await ecp.commit({ tuple, mission: submitted.mission, action: "follow", target: fixture.target,
      intent: { surface: "social-effect", effectAction: "follow", accessToken: "raw-secret-must-not-persist", runtimeId: "private-runtime" }, idempotencyKey: "acceptance-follow" });
    assert.equal(social.status, "verified");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].target, fixture.target);
    assert.equal(verifies.length, 1);
    assert.equal(verifies[0].target, fixture.target);
    assert.equal(restores.length, 1);
    assert.equal(restores[0].target, fixture.target);
    const durableEffects = state.db.prepare("SELECT intent_json FROM mission_effects WHERE mission_id=?").all(submitted.mission.missionId);
    assert.doesNotMatch(JSON.stringify(durableEffects), /raw-secret-must-not-persist|private-runtime/);

    state.releaseSession(submitted.run.sessionId, submitted.run.token);
    assert.equal(state.listLeases().length, 0);
    assert.deepEqual(checkpoints, fixture.expectedCheckpoints);
    assert.equal(checkpoints.scopedAutomaticR2, "blocked_by_adr_acceptance");
  } finally {
    await control.stop();
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("ledger acceptance covers budget reservation, retained notSent retry, abandon release, and restart no-replay", () => {
  const root = mkdtempSync(join(tmpdir(), "freedom-ledger-"));
  const dbPath = join(root, "control.db");
  let state = new StateStore({ dbPath });
  try {
    state.upsertNode({ nodeId: AUTHORITY, authority: true });
    state.upsertDevice({ alias: "01", physicalLabel: "ledger-device", nodeId: AUTHORITY, runtimeId: "private-runtime",
      routingProfile: { enabled: true, tags: [], capabilityIds: [] } });
    const missions = new MissionRuntime({ state });
    const mission = missions.createMission({
      issuer: { actorId: "human:operator" }, idempotencyKey: "acceptance-ledger",
      app: fixture.policy.app, account: fixture.policy.account, parallelism: 1, controllers: ["agent:runner"],
      scope: { actions: ["follow"], targets: { kind: "fingerprint", values: ["target-a", "target-b", "target-c"] }, totalCount: 2, perTargetCount: 1, frequency: { count: 2, windowSeconds: 3600 } },
      validity: fixture.policy.validity,
    }).mission;
    const runs = new DeviceRunRuntime({ state, missions, authorityNodeId: AUTHORITY });
    const run = runs.openDeviceRun({ missionId: mission.missionId, controllerAgent: "agent:runner" });
    const ledger = new EffectLedger({ state });
    const notSent = ledger.beginEffect({ mission, deviceRunId: run.deviceRunId, action: "follow", target: "target-a", intent: { surface: "social-effect" }, idempotencyKey: "acceptance-not-sent" });
    ledger.recordOutcome(notSent.effectId, { status: "not_sent" });
    assert.equal(ledger.retryNotSent(notSent.effectId, { rechecked: true }).reservationRetained, true);
    ledger.recordOutcome(notSent.effectId, { status: "not_sent" });
    assert.equal(ledger.abandonNotSent(notSent.effectId).reservationReleased, true);
    const ambiguous = ledger.beginEffect({ mission, deviceRunId: run.deviceRunId, action: "follow", target: "target-a", intent: { surface: "social-effect" }, idempotencyKey: "acceptance-ambiguous" });
    ledger.startEffectForExecution(ambiguous.effectId);
    ledger.recordOutcome(ambiguous.effectId, { status: "ambiguous" });
    assert.throws(() => ledger.beginEffect({ mission, deviceRunId: run.deviceRunId, action: "follow", target: "target-a", intent: { surface: "social-effect" }, idempotencyKey: "acceptance-ambiguous-retry" }), { code: "AMBIGUOUS_NO_RETRY" });
    const started = ledger.beginEffect({ mission, deviceRunId: run.deviceRunId, action: "follow", target: "target-b", intent: { surface: "social-effect" }, idempotencyKey: "acceptance-restart" });
    ledger.startEffectForExecution(started.effectId);
    assert.throws(() => ledger.beginEffect({ mission, deviceRunId: run.deviceRunId, action: "follow", target: "target-c", intent: { surface: "social-effect" }, idempotencyKey: "acceptance-budget-exhausted" }), { code: "BUDGET_EXCEEDED" });
    state.close();
    state = new StateStore({ dbPath });
    const recovered = state.listMissionEffects(mission.missionId).find((effect) => effect.effectId === started.effectId);
    assert.equal(recovered.status, "ambiguous");
    assert.equal(recovered.reservationConsumed, true);
    assert.equal(recovered.retryBlocked, true);
    assert.ok(state.listMissionEvents(mission.missionId).some((event) => event.type === "effect.recovered_ambiguous"));
  } finally {
    try { state.close(); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});

test("offline guard matrix fences readiness/schema, requires verification beyond HTTP 200, and restores", async () => {
  const root = mkdtempSync(join(tmpdir(), "freedom-guards-"));
  const state = new StateStore({ dbPath: join(root, "control.db") });
  const evidence = new EvidenceStore({ runsRoot: join(root, "runs"), state, minFreeBytes: 0, minExternalEffectFreeBytes: 0 });
  const fake = { executeCalls: [], verifyCalls: [], restoreCalls: [] };
  const adapter = {
    id: "guard-adapter",
    async execute(input) { fake.executeCalls.push(input); return { httpStatus: 200, dryRun: true }; },
    async verify(input) { fake.verifyCalls.push(input); return { ok: false }; },
    async restore(input) { fake.restoreCalls.push(input); return { ok: true }; },
  };
  const control = new ControlPlane({
    state, capabilities: { capabilities: [] }, adapters: new AdapterRegistry([adapter]), evidence, authorityNodeId: AUTHORITY,
    missionAutoApprovalEnabled: true, adrAccepted: true, acquireTransportLock: () => Promise.resolve(() => {}),
  });
  try {
    state.upsertNode({ nodeId: AUTHORITY, authority: true });
    const device = state.upsertDevice({ alias: "01", physicalLabel: "guard-device", nodeId: AUTHORITY, runtimeId: "private-runtime",
      routingProfile: { enabled: true, tags: [], capabilityIds: [] } });
    const mission = control.missions.createMission({ issuer: { actorId: "human:operator" }, idempotencyKey: "acceptance-guard-mission",
      app: fixture.policy.app, account: fixture.policy.account, parallelism: 1, controllers: ["agent:runner"],
      scope: { actions: ["follow"], targets: { kind: "fingerprint", values: [fixture.target] }, totalCount: 2, perTargetCount: 2, frequency: { count: 2, windowSeconds: 3600 } }, validity: fixture.policy.validity }).mission;
    const runs = new DeviceRunRuntime({ state, missions: control.missions, authorityNodeId: AUTHORITY });
    assert.throws(() => runs.openDeviceRun({ missionId: mission.missionId, controllerAgent: "agent:runner", registrySnapshot: { deviceId: device.deviceId, alias: "01", online: false } }), { code: "READINESS_SPLIT" });
    assert.equal(state.listLeases().length, 0);
    const run = runs.openDeviceRun({ missionId: mission.missionId, controllerAgent: "agent:runner" });
    assert.throws(() => runs.assertControlTuple({ ...run.tuple, controllerEpoch: 0 }), { code: "EPOCH_MISMATCH" });

    const ecp = control.createEffectCommitProtocol({
      recheck: async (input) => correctRecheck(input.target), execute: async (input) => adapter.execute(input),
      verify: async (input) => adapter.verify(input), restore: async (input) => adapter.restore(input),
    });
    const unverified = await ecp.commit({ tuple: run.tuple, mission, action: "follow", target: fixture.target,
      intent: { surface: "social-effect" }, idempotencyKey: "acceptance-http-200-dry-run" });
    assert.equal(unverified.status, "ambiguous");
    assert.equal(fake.executeCalls.length, 1);
    assert.equal(fake.executeCalls[0].target, fixture.target);
    assert.equal(fake.verifyCalls.length, 1);
    assert.equal(fake.restoreCalls.length, 1);
    assert.equal(fake.restoreCalls[0].outcome, "ambiguous");

    const unavailable = new ControlPlane({ state, capabilities: { capabilities: [] }, adapters: new AdapterRegistry([]), evidence,
      authorityNodeId: AUTHORITY, missionAutoApprovalEnabled: true, adrAccepted: true, effectIntentSchema: null });
    await assert.rejects(() => unavailable.executeMissionPrimitive(run.tuple, { primitive: "tap", envelope: {
      declaredIntent: "tap", snapshot: snapshot("social-effect", { effectAction: "follow" }), observedTargetFingerprint: fixture.target,
    } }), { code: "EFFECT_INTENT_SCHEMA_UNAVAILABLE" });
    assert.equal(state.listMissionEvents(mission.missionId).some((event) => event.type === "mission.primitive"), false);
    state.releaseSession(run.sessionId, run.token);
    assert.equal(state.listLeases().length, 0);
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("notSent retry must be an ECP in-place full recheck, never a caller-supplied boolean", async () => {
  const root = mkdtempSync(join(tmpdir(), "freedom-retry-contract-"));
  const state = new StateStore({ dbPath: join(root, "control.db") });
  const evidence = new EvidenceStore({ runsRoot: join(root, "runs"), state, minFreeBytes: 0, minExternalEffectFreeBytes: 0 });
  const control = new ControlPlane({ state, capabilities: { capabilities: [] }, adapters: new AdapterRegistry([]), evidence,
    authorityNodeId: AUTHORITY, missionAutoApprovalEnabled: true, adrAccepted: true });
  try {
    state.upsertNode({ nodeId: AUTHORITY, authority: true });
    state.upsertDevice({ alias: "01", physicalLabel: "retry-device", nodeId: AUTHORITY, runtimeId: "private-runtime",
      routingProfile: { enabled: true, tags: [], capabilityIds: [] } });
    const mission = control.missions.createMission({ issuer: { actorId: "human:operator" }, idempotencyKey: "acceptance-retry-contract",
      app: fixture.policy.app, account: fixture.policy.account, parallelism: 1, controllers: ["agent:runner"],
      scope: { actions: ["follow"], targets: { kind: "fingerprint", values: [fixture.target] }, totalCount: 1, perTargetCount: 1, frequency: { count: 1, windowSeconds: 3600 } }, validity: fixture.policy.validity }).mission;
    const run = control.openDeviceRun({ missionId: mission.missionId, controllerAgent: "agent:runner" });
    const ledger = new EffectLedger({ state });
    const notSent = ledger.beginEffect({ mission, deviceRunId: run.deviceRunId, action: "follow", target: fixture.target,
      intent: { surface: "social-effect" }, idempotencyKey: "acceptance-retry-not-sent" });
    ledger.recordOutcome(notSent.effectId, { status: "not_sent" });
    const ecp = control.createEffectCommitProtocol({
      recheck: async (input) => correctRecheck(input.target), execute: async () => ({ httpStatus: 200 }),
      verify: async () => ({ ok: true }), restore: async () => ({ ok: true }),
    });
    // This expected boundary forces the real ECP to own tuple + full observed-state recheck.
    // A caller-provided { rechecked:true } must not authorize retry.
    assert.equal(typeof ecp.retryNotSentInPlace, "function", "ECP retry wrapper is required for notSent");
    const retried = await ecp.retryNotSentInPlace({ effectId: notSent.effectId, tuple: run.tuple, mission, target: fixture.target });
    assert.equal(retried.status, "verified");
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("PHC policy and legacy non-Mission R2 gate retain their independent authority boundaries", async () => {
  const root = mkdtempSync(join(tmpdir(), "freedom-legacy-"));
  const state = new StateStore({ dbPath: join(root, "control.db") });
  const capability = {
    schemaVersion: 1, id: "acceptance.r2", appId: "xhs", packageName: "local.xhs", versionRange: "*", maturity: "E3", risk: "R2",
    resources: ["device"], inputSchema: { type: "object", properties: {}, additionalProperties: false }, outputSchema: { type: "object" }, preconditions: [],
    verification: { mode: "state", description: "acceptance" }, restoration: { required: false, description: "none" }, timeoutMs: 1000,
    idempotency: "read_only", automationPolicy: { mode: "automatic" }, implementation: { adapter: "acceptance-adapter", action: "follow" }, evidence: [], availability: "implemented",
  };
  const evidence = new EvidenceStore({ runsRoot: join(root, "runs"), state, minFreeBytes: 0, minExternalEffectFreeBytes: 0 });
  const control = new ControlPlane({ state, capabilities: new CapabilityRegistry([capability]), adapters: new AdapterRegistry([{ id: "acceptance-adapter", async execute() {}, async verify() { return { ok: true }; }, async restore() { return { ok: true }; } }]), evidence, authorityNodeId: AUTHORITY });
  try {
    state.upsertDevice({ alias: "01", physicalLabel: "legacy-device", nodeId: AUTHORITY, runtimeId: "private-runtime", routingProfile: { enabled: true, tags: [], capabilityIds: [capability.id] } });
    const job = control.submitJob({ actorId: "agent:legacy", capabilityId: capability.id, idempotencyKey: "acceptance-legacy", params: {} }).job;
    assert.equal(job.status, "waiting_approval");
    assert.equal(job.approvalRequired, true);
    // REX Phase 5 §8.2 B9 反转：nonpayment_v1 active（fake adapter）下，同一非支付 R2
    // capability 不再 waiting_approval——非支付一律自由，唯一硬闸是 financial_commit（此
    // capability risk R2 / read_only / automatic，非支付）。legacy 闸作为 fallback 保留上方。
    // liveness：job 进 queued（不拦），pump 实际 dispatch（无需人类审批即执行）。
    const freeControl = new ControlPlane({ state, capabilities: new CapabilityRegistry([capability]), adapters: new AdapterRegistry([{ id: "acceptance-adapter", async execute() { return { ok: true }; }, async verify() { return { ok: true }; }, async restore() { return { ok: true }; } }]), evidence, authorityNodeId: AUTHORITY, policyMode: { active: true, mode: "nonpayment_v1", effectiveDecisionSource: "deployed-runtime" } });
    const freed = freeControl.submitJob({ actorId: "agent:freedom", capabilityId: capability.id, idempotencyKey: "acceptance-freedom", params: {} }).job;
    assert.equal(freed.approvalRequired, false, "nonpayment_v1: non-payment R2 must not require approval");
    assert.notEqual(freed.status, "waiting_approval", "nonpayment_v1: non-payment R2 must not wait for approval");
    // liveness：job 进 queued（dispatch 队列）而非 waiting_approval（审批队列）——
    // 证明无审批门阻挡 dispatch，pump 会直接执行。
    assert.equal(freed.status, "queued", "nonpayment_v1: non-payment R2 enters dispatch queue, not approval queue");
    // 让 pump 的 queueMicrotask 排空（freed job 进 queued 会触发 pump），再进 finally close，
    // 避免 pump 在 state.close() 后触 DB 产生 unhandledRejection。
    await new Promise((resolve) => setTimeout(resolve, 30));
    const mission = control.missions.createMission({ issuer: { actorId: "human:operator" }, idempotencyKey: "acceptance-phc-policy", app: "xhs", account: "alias", parallelism: 1, controllers: ["agent:runner"], scope: { actions: ["follow", "publish", "delete"], targets: { kind: "fingerprint", values: ["target-a"] }, totalCount: 3, perTargetCount: 3, frequency: { count: 3, windowSeconds: 3600 } }, validity: fixture.policy.validity, policy: { publish: "allow_within_scope", delete: "confirm" } }).mission;
    assert.equal(control.missions.evaluateMissionEffect(mission, { action: "payment", target: "target-a" }).decision, "phc");
    assert.equal(control.missions.evaluateMissionEffect(mission, { action: "delete", target: "target-a" }).decision, "phc");
    assert.equal(control.missions.evaluateMissionEffect(mission, { action: "publish", target: "target-a" }).decision, "ecp");
    assert.equal(control.missions.evaluateMissionEffect(mission, { action: "follow", target: "outside" }).decision, "scope_violation");
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});
