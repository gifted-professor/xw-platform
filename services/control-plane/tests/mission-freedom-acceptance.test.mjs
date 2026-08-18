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
import { evaluateMissionEffect } from "../control-plane/lib/mission-policy.mjs";
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
    // Foundation: shadow/legacy machine-blocks business effects — no ordinary waiting_approval.
    assert.throws(
      () => control.submitJob({ actorId: "agent:legacy", capabilityId: capability.id, idempotencyKey: "acceptance-legacy", params: {} }),
      (err) => err.code === "AUTONOMY_INACTIVE",
    );
    const freeControl = new ControlPlane({ state, capabilities: new CapabilityRegistry([capability]), adapters: new AdapterRegistry([{ id: "acceptance-adapter", async execute() { return { ok: true }; }, async verify() { return { ok: true }; }, async restore() { return { ok: true }; } }]), evidence, authorityNodeId: AUTHORITY, policyMode: { active: true, mode: "nonpayment_v1", effectiveDecisionSource: "deployed-runtime" }, schedulerIntervalMs: 50 });
    freeControl.start();
    try {
      const freed = freeControl.submitJob({ actorId: "agent:freedom", capabilityId: capability.id, idempotencyKey: "acceptance-freedom", params: {} }).job;
      assert.equal(freed.approvalRequired, false, "nonpayment_v1: non-payment R2 must not require approval");
      assert.notEqual(freed.status, "waiting_approval", "nonpayment_v1: non-payment R2 must not wait for approval");
      assert.equal(freed.status, "queued", "nonpayment_v1: non-payment R2 enters dispatch queue, not approval queue");
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      await freeControl.stop();
    }
    const mission = control.missions.createMission({ issuer: { actorId: "human:operator" }, idempotencyKey: "acceptance-phc-policy", app: "xhs", account: "alias", parallelism: 1, controllers: ["agent:runner"], scope: { actions: ["follow", "publish", "delete"], targets: { kind: "fingerprint", values: ["target-a"] }, totalCount: 3, perTargetCount: 3, frequency: { count: 3, windowSeconds: 3600 } }, validity: fixture.policy.validity, policy: { publish: "allow_within_scope", delete: "confirm" } }).mission;
    assert.equal(control.missions.evaluateMissionEffect(mission, { action: "payment", target: "target-a" }).decision, "phc");
    assert.equal(control.missions.evaluateMissionEffect(mission, { action: "delete", target: "target-a" }).decision, "phc");
    // Foundation: publish is always phc; allow_within_scope cannot release
    assert.equal(control.missions.evaluateMissionEffect(mission, { action: "publish", target: "target-a" }).decision, "phc");
    assert.equal(control.missions.evaluateMissionEffect(mission, { action: "follow", target: "outside" }).decision, "scope_violation");
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── REX Phase 5 §8.4 (P5b): mission-policy action/target 软预算（非支付自由，payment 永 PHC）──
// plan B3 line 824：action/target 从权限门降为上下文/软预算。nonpayment_v1 下出 scope 的非支付
// action/target 不再 scope_violation，改为软 ecp + debt 标记；legacy 保持 scope_violation 逐字节不变；
// payment 任何模式都 phc。
test("REX P5b: nonpayment_v1 relaxes out-of-scope action/target to soft ecp+debt; legacy stays scope_violation", () => {
  const root = mkdtempSync(join(tmpdir(), "freedom-scope-soft-"));
  const state = new StateStore({ dbPath: join(root, "control.db") });
  const NONPAY = { active: true };
  try {
    state.upsertNode({ nodeId: AUTHORITY, authority: true });
    state.upsertDevice({ alias: "01", physicalLabel: "scope-soft-device", nodeId: AUTHORITY, runtimeId: "private-runtime", routingProfile: { enabled: true, tags: [], capabilityIds: [] } });
    const missions = new MissionRuntime({ state });
    const mission = missions.createMission({ issuer: { actorId: "human:operator" }, idempotencyKey: "acceptance-scope-soft",
      app: "xhs", account: "alias", parallelism: 1, controllers: ["agent:runner"],
      scope: { actions: ["follow"], targets: { kind: "fingerprint", values: ["target-a"] }, totalCount: 2, perTargetCount: 2, frequency: { count: 2, windowSeconds: 3600 } },
      validity: { expiresAt: "2099-07-29T16:00:00Z" } }).mission;

    // nonpayment: out-of-scope action relaxes to soft ecp + debt
    const actionSoft = evaluateMissionEffect(mission, { action: "dm", target: "target-a" }, { policyMode: NONPAY });
    assert.equal(actionSoft.decision, "ecp");
    assert.equal(actionSoft.debt, true);
    // nonpayment: out-of-scope target relaxes to soft ecp + debt
    const targetSoft = evaluateMissionEffect(mission, { action: "follow", target: "outside-target" }, { policyMode: NONPAY });
    assert.equal(targetSoft.decision, "ecp");
    assert.equal(targetSoft.debt, true);
    // in-scope stays plain ecp without debt
    const inScope = evaluateMissionEffect(mission, { action: "follow", target: "target-a" }, { policyMode: NONPAY });
    assert.equal(inScope.decision, "ecp");
    assert.equal(inScope.debt, undefined);
    // payment stays phc under nonpayment — the one hard gate never relaxes
    assert.equal(evaluateMissionEffect(mission, { action: "payment", target: "target-a" }, { policyMode: NONPAY }).decision, "phc");
    // legacy (default null and explicit null) unchanged
    assert.equal(evaluateMissionEffect(mission, { action: "dm", target: "target-a" }).decision, "scope_violation");
    assert.equal(evaluateMissionEffect(mission, { action: "follow", target: "outside-target" }).decision, "scope_violation");
    assert.equal(evaluateMissionEffect(mission, { action: "dm", target: "target-a" }, { policyMode: null }).decision, "scope_violation");
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── REX Phase 5 §8.4 (P5b): expiry 软预算（纯函数）──────────────────────────────────
// plan B3 line 828-829：count/frequency/expiry 软预算。MISSION_EXPIRED 在 nonpayment_v1 下
// 对非支付 social action 软 ecp+debt；payment / publish / delete 在过期任务上仍硬栅栏（payment
// 永不松；releaseable 只在任务存活时）。legacy 恒 blocked。
test("REX P5b: expiry soft-fences non-payment social effects; payment/publish/delete stay fenced", () => {
  const expired = {
    status: "active",
    validity: { expiresAt: "2001-01-01T00:00:00Z" },
    scope: { actions: ["follow", "like", "collect", "comment", "dm"], targets: { values: ["target-a"] } },
    policy: { publish: "confirm", delete: "confirm", payment: "confirm" },
  };
  // nonpayment: expired non-payment social effect → soft ecp + debt
  const soft = evaluateMissionEffect(expired, { action: "follow", target: "target-a" }, { policyMode: { active: true } });
  assert.equal(soft.decision, "ecp");
  assert.equal(soft.reason, "MISSION_EXPIRED");
  assert.equal(soft.debt, true);
  // legacy: expired → blocked
  assert.equal(evaluateMissionEffect(expired, { action: "follow", target: "target-a" }).decision, "blocked");
  assert.equal(evaluateMissionEffect(expired, { action: "follow", target: "target-a" }, { policyMode: null }).decision, "blocked");
  // payment never relaxes, even on an expired mission under nonpayment
  assert.equal(evaluateMissionEffect(expired, { action: "payment", target: "target-a" }, { policyMode: { active: true } }).decision, "blocked");
  // publish/delete are releaseable only while the mission is live — expiry keeps them fenced
  const released = { ...expired, policy: { publish: "allow_within_scope", delete: "allow_within_scope", payment: "confirm" } };
  assert.equal(evaluateMissionEffect(released, { action: "publish", target: "target-a" }, { policyMode: { active: true } }).decision, "blocked");
  assert.equal(evaluateMissionEffect(released, { action: "delete", target: "target-a" }, { policyMode: { active: true } }).decision, "blocked");
});
