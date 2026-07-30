import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { DeviceRunRuntime } from "../control-plane/lib/device-run.mjs";
import { EffectCommitProtocol } from "../control-plane/lib/effect-commit-protocol.mjs";
import { EffectLedger } from "../control-plane/lib/effect-ledger.mjs";
import { MissionRuntime } from "../control-plane/lib/mission-runtime.mjs";
import { StateStore } from "../control-plane/lib/state-store.mjs";

const AUTHORITY = "DESKTOP-3I1EVHE";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "effect-commit-"));
  const state = new StateStore({ dbPath: join(root, "control.db") });
  const missions = new MissionRuntime({ state });
  const runs = new DeviceRunRuntime({ state, missions, authorityNodeId: AUTHORITY });
  state.upsertNode({ nodeId: AUTHORITY, authority: true });
  state.upsertDevice({
    alias: "01", physicalLabel: "rack-01", nodeId: AUTHORITY, runtimeId: "private-runtime-01",
    routingProfile: { enabled: true, tags: ["slot:01"], capabilityIds: [] },
  });
  const { mission } = missions.createMission({
    issuer: { actorId: "human:operator" }, idempotencyKey: `ecp-${Math.random()}`,
    app: "xhs", account: "local-alias", parallelism: 1, controllers: ["agent:runner"],
    scope: {
      actions: ["follow", "comment"], targets: { kind: "fingerprint", values: ["target-a"] },
      totalCount: 2, perTargetCount: 2, frequency: { count: 2, windowSeconds: 3600 },
    },
    validity: { expiresAt: "2099-07-29T16:00:00Z" }, policy: { publish: "confirm", delete: "confirm" },
  });
  const run = runs.openDeviceRun({ missionId: mission.missionId, controllerAgent: "agent:runner" });
  return { root, state, mission, run, runs };
}

function correctState(target = "target-a") {
  return {
    readiness: { source: "control-plane", ready: true, fresh: true },
    app: "xhs", account: "local-alias", targetFingerprint: target,
    pageFingerprint: "profile-v1", beforeState: "not-following", control: true,
  };
}

function parentGrant(grantId) {
  return {
    grantId,
    issuanceNonce: `nonce-${grantId}`,
    app: "xhs",
    accountFingerprint: "local-alias",
    controllers: ["agent:runner"],
    authorization: { primitives: [], socialActions: ["follow"], missionOnlyActions: [], prohibitedActions: [] },
    targets: { mode: "explicit_fingerprints", values: ["target-a"] },
    budget: { maxima: { totalCount: 2, perTargetCount: 2, frequency: { count: 2, windowSeconds: 3600 } }, defaults: { totalCount: 2, perTargetCount: 2, frequency: { count: 2, windowSeconds: 3600 } } },
    validity: { expiresAt: null },
  };
}

function parentMissionInput(idempotencyKey) {
  return {
    issuer: { actorId: "user:a1234" }, idempotencyKey,
    app: "xhs", account: "local-alias", parallelism: 1, controllers: ["agent:runner"],
    scope: { actions: ["follow"], targets: { kind: "fingerprint", values: ["target-a"] }, totalCount: 2, perTargetCount: 2, frequency: { count: 2, windowSeconds: 3600 } },
    validity: { expiresAt: "2099-07-29T16:00:00Z" }, policy: { publish: "confirm", delete: "confirm" },
  };
}

test("ECP rechecks before a single adapter call and requires verification rather than HTTP success", async () => {
  const fixture = setup();
  const calls = [];
  const restores = [];
  try {
    const ecp = new EffectCommitProtocol({
      state: fixture.state,
      ledger: new EffectLedger({ state: fixture.state }),
      deviceRuns: fixture.runs,
      recheck: async () => correctState(),
      execute: async (input) => { calls.push(input); return { httpStatus: 200 }; },
      verify: async () => ({ ok: true, afterState: "following", evidenceRefs: ["verified-hash"] }),
      restore: async (input) => { restores.push(input); return { ok: true }; },
    });
    const result = await ecp.commit({
      tuple: fixture.run.tuple, mission: fixture.mission, action: "follow", target: "target-a",
      intent: { surface: "social-effect" }, idempotencyKey: "ecp-follow-target-a",
    });
    assert.equal(result.status, "verified");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].target, "target-a");
    assert.equal(restores.length, 1);

    const unverified = new EffectCommitProtocol({
      state: fixture.state, ledger: new EffectLedger({ state: fixture.state }), deviceRuns: fixture.runs,
      recheck: async () => correctState(), execute: async () => ({ httpStatus: 200 }),
      verify: async () => ({ ok: false }), restore: async () => ({ ok: true }),
    });
    const second = await unverified.commit({
      tuple: fixture.run.tuple, mission: fixture.mission, action: "comment", target: "target-a",
      intent: { surface: "social-effect" }, idempotencyKey: "ecp-comment-target-a",
    });
    assert.equal(second.status, "ambiguous");
  } finally {
    fixture.state.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("ECP blocks scope and correctness failures before ledger or adapter execution", async () => {
  const fixture = setup();
  let executeCount = 0;
  try {
    const ecp = new EffectCommitProtocol({
      state: fixture.state, ledger: new EffectLedger({ state: fixture.state }), deviceRuns: fixture.runs,
      recheck: async () => ({ ...correctState(), readiness: { source: "control-plane", ready: false, fresh: true } }),
      execute: async () => { executeCount += 1; return {}; }, verify: async () => ({ ok: true }), restore: async () => ({ ok: true }),
    });
    const blocked = await ecp.commit({
      tuple: fixture.run.tuple, mission: fixture.mission, action: "follow", target: "target-a",
      intent: { surface: "social-effect" }, idempotencyKey: "blocked-readiness",
    });
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.code, "READINESS_NOT_READY");
    assert.equal(executeCount, 0);
    assert.equal(fixture.state.listMissionEffects(fixture.mission.missionId).length, 0);

    const scope = await ecp.commit({
      tuple: fixture.run.tuple, mission: fixture.mission, action: "follow", target: "outside-target",
      intent: { surface: "social-effect" }, idempotencyKey: "blocked-scope",
    });
    assert.equal(scope.code, "SCOPE_VIOLATION");
    assert.equal(executeCount, 0);
  } finally {
    fixture.state.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("parent Grant revocation after prepare fences the adapter before an effect can start", async () => {
  const fixture = setup();
  let executeCount = 0;
  try {
    fixture.state.releaseSession(fixture.run.sessionId, fixture.run.token);
    const grant = parentGrant("grant-ecp-revoke");
    fixture.state.issueDelegationGrant({ grant, grantHash: "grant-ecp-revoke-hash", proofHash: "proof", issuerSubject: "user:a1234", issuerKeyId: "test", allowlistVersion: 1 });
    const { mission } = new MissionRuntime({ state: fixture.state }).createMission(parentMissionInput("ecp-parent-revoke"), { parentGrantId: grant.grantId, parentGrantHash: "grant-ecp-revoke-hash" });
    const run = fixture.runs.openDeviceRun({ missionId: mission.missionId, controllerAgent: "agent:runner" });
    const ecp = new EffectCommitProtocol({
      state: fixture.state, ledger: new EffectLedger({ state: fixture.state }), deviceRuns: fixture.runs, missions: new MissionRuntime({ state: fixture.state }),
      recheck: async () => correctState(), execute: async () => { executeCount += 1; return {}; },
      verify: async () => ({ ok: true }), restore: async () => ({ ok: true }),
    });
    const prepared = await ecp.prepare({ tuple: run.tuple, mission, action: "follow", target: "target-a", idempotencyKey: "effect-after-parent-revoke" });
    assert.equal(prepared.status, "prepared");
    fixture.state.revokeDelegationGrant(grant.grantId, { reason: "test-revoked" });
    const result = await ecp.executePrepared({
      ...prepared,
      tuple: run.tuple, mission, action: "follow", target: "target-a", idempotencyKey: "effect-after-parent-revoke",
    });
    assert.deepEqual(result, { status: "blocked", code: "MISSION_REVOKED" });
    assert.equal(executeCount, 0);
  } finally {
    fixture.state.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a parent or child expiry after prepare fences the adapter and retains its receipt", async () => {
  let now = Date.now();
  const root = mkdtempSync(join(tmpdir(), "effect-commit-expiry-"));
  const state = new StateStore({ dbPath: join(root, "control.db"), now: () => now });
  const missions = new MissionRuntime({ state, now: () => now });
  const runs = new DeviceRunRuntime({ state, missions, authorityNodeId: AUTHORITY });
  let executeCount = 0;
  try {
    state.upsertNode({ nodeId: AUTHORITY, authority: true });
    state.upsertDevice({ alias: "01", physicalLabel: "rack-01", nodeId: AUTHORITY, runtimeId: "private-01", routingProfile: { enabled: true, tags: ["slot:01"], capabilityIds: [] } });
    const grant = parentGrant("grant-expiry");
    grant.validity.expiresAt = new Date(now + 1000).toISOString();
    state.issueDelegationGrant({ grant, grantHash: "grant-expiry-hash", proofHash: "proof", issuerSubject: "user:a1234", issuerKeyId: "test", allowlistVersion: 1 });
    const { mission } = missions.createMission({ ...parentMissionInput("parent-expiry"), validity: { expiresAt: new Date(now + 2000).toISOString() } }, { parentGrantId: grant.grantId, parentGrantHash: "grant-expiry-hash" });
    const run = runs.openDeviceRun({ missionId: mission.missionId, controllerAgent: "agent:runner" });
    const observationReceiptId = "receipt-never-minted";
    const ecp = new EffectCommitProtocol({ state, ledger: new EffectLedger({ state }), deviceRuns: runs, missions, evidence: { findByIdAndHash() {} }, recheck: async () => correctState(), execute: async () => { executeCount += 1; return {}; }, verify: async () => ({ ok: true }), restore: async () => ({ ok: true }) });
    const prepared = await ecp.prepare({ tuple: run.tuple, mission, action: "follow", target: "target-a", idempotencyKey: "effect-expiry", observationReceiptId });
    assert.equal(prepared.status, "prepared");
    now += 1001;
    const result = await ecp.executePrepared({ ...prepared, tuple: run.tuple, mission, action: "follow", target: "target-a", idempotencyKey: "effect-expiry", observationReceiptId });
    assert.deepEqual(result, { status: "blocked", code: "PARENT_GRANT_EXPIRED" });
    assert.equal(executeCount, 0);
    const effect = state.listMissionEffects(mission.missionId).find((row) => row.effectId === prepared.effect.effectId);
    assert.deepEqual({ status: effect.status, released: effect.reservationReleased }, { status: "cancelled", released: true });
    assert.equal(state.getDeviceRun(run.deviceRunId).phase, "cancelled");
    assert.equal(state.listLeases().some((lease) => lease.leaseId === run.leaseId), false);
  } finally { state.close(); rmSync(root, { recursive: true, force: true }); }
});

test("prepare reserves a not_sent effect; revoke before send cancels and releases it", async () => {
  const fixture = setup();
  try {
    fixture.state.releaseSession(fixture.run.sessionId, fixture.run.token);
    const grant = parentGrant("grant-prepared-revoke");
    fixture.state.issueDelegationGrant({ grant, grantHash: "grant-prepared-revoke-hash", proofHash: "proof", issuerSubject: "user:a1234", issuerKeyId: "test", allowlistVersion: 1 });
    const { mission } = new MissionRuntime({ state: fixture.state }).createMission(parentMissionInput("prepared-revoke"), { parentGrantId: grant.grantId, parentGrantHash: "grant-prepared-revoke-hash" });
    const run = fixture.runs.openDeviceRun({ missionId: mission.missionId, controllerAgent: "agent:runner" });
    const ecp = new EffectCommitProtocol({ state: fixture.state, ledger: new EffectLedger({ state: fixture.state }), deviceRuns: fixture.runs, missions: new MissionRuntime({ state: fixture.state }), recheck: async () => correctState(), execute: async () => ({}), verify: async () => ({ ok: true }), restore: async () => ({ ok: true }) });
    const prepared = await ecp.prepare({ tuple: run.tuple, mission, action: "follow", target: "target-a", idempotencyKey: "prepared-before-revoke" });
    assert.equal(prepared.effect.status, "not_sent");
    fixture.state.revokeDelegationGrant(grant.grantId, { reason: "before-send" });
    const effect = fixture.state.listMissionEffects(mission.missionId).find((row) => row.effectId === prepared.effect.effectId);
    assert.deepEqual({ status: effect.status, released: effect.reservationReleased, retryBlocked: effect.retryBlocked }, { status: "cancelled", released: true, retryBlocked: true });
    assert.equal(fixture.state.getDeviceRun(run.deviceRunId).phase, "cancelled");
  } finally { fixture.state.close(); rmSync(fixture.root, { recursive: true, force: true }); }
});

test("revoking a parent Grant atomically cancels unstarted work and retains ambiguous audit state", () => {
  const fixture = setup();
  try {
    fixture.state.releaseSession(fixture.run.sessionId, fixture.run.token);
    const grant = parentGrant("grant-cascade");
    fixture.state.issueDelegationGrant({ grant, grantHash: "grant-cascade-hash", proofHash: "proof", issuerSubject: "user:a1234", issuerKeyId: "test", allowlistVersion: 1 });
    const { mission } = new MissionRuntime({ state: fixture.state }).createMission(parentMissionInput("parent-cascade"), { parentGrantId: grant.grantId, parentGrantHash: "grant-cascade-hash" });
    const run = fixture.runs.openDeviceRun({ missionId: mission.missionId, controllerAgent: "agent:runner" });
    const pending = fixture.state.beginMissionEffect({ mission, deviceRunId: run.deviceRunId, action: "follow", targetHash: "target-a", idempotencyKey: "cascade-pending", status: "waiting_authorization" }).effect;
    fixture.state.revokeDelegationGrant(grant.grantId, { reason: "test-cascade" });
    const effect = fixture.state.listMissionEffects(mission.missionId).find((row) => row.effectId === pending.effectId);
    assert.deepEqual({ status: effect.status, released: effect.reservationReleased, retryBlocked: effect.retryBlocked }, { status: "cancelled", released: true, retryBlocked: true });
    assert.equal(fixture.state.getDeviceRun(run.deviceRunId).phase, "cancelled");
    assert.equal(fixture.state.listLeases().some((lease) => lease.leaseId === run.leaseId), false);
    assert.ok(fixture.state.listMissionEvents(mission.missionId).some((event) => event.type === "mission.parent_grant_revoked"));
  } finally {
    fixture.state.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a parent Mission effect fails closed when no server-owned receipt exists", async () => {
  const fixture = setup();
  let executeCount = 0;
  try {
    fixture.state.releaseSession(fixture.run.sessionId, fixture.run.token);
    const grant = parentGrant("grant-receipt-effect");
    fixture.state.issueDelegationGrant({ grant, grantHash: "grant-receipt-effect-hash", proofHash: "proof", issuerSubject: "user:a1234", issuerKeyId: "test", allowlistVersion: 1 });
    const { mission } = new MissionRuntime({ state: fixture.state }).createMission(parentMissionInput("parent-receipt-effect"), { parentGrantId: grant.grantId, parentGrantHash: "grant-receipt-effect-hash" });
    const run = fixture.runs.openDeviceRun({ missionId: mission.missionId, controllerAgent: "agent:runner" });
    const ecp = new EffectCommitProtocol({
      state: fixture.state, ledger: new EffectLedger({ state: fixture.state }), deviceRuns: fixture.runs, missions: new MissionRuntime({ state: fixture.state }),
      evidence: { findByIdAndHash() { throw Object.assign(new Error("tampered"), { code: "EVIDENCE_HASH_MISMATCH" }); } },
      recheck: async () => correctState(), execute: async () => { executeCount += 1; return {}; }, verify: async () => ({ ok: true }), restore: async () => ({ ok: true }),
    });
    const result = await ecp.commit({ tuple: run.tuple, mission, action: "follow", target: "target-a", idempotencyKey: "receipt-effect", observationReceiptId: "forged" });
    assert.deepEqual(result, { status: "blocked", code: "EXPLICIT_RECEIPT_EVIDENCE_UNAVAILABLE" });
    assert.equal(executeCount, 0);
  } finally { fixture.state.close(); rmSync(fixture.root, { recursive: true, force: true }); }
});

test("ECP retries a notSent effect in place only after a full recheck, retaining its reservation", async () => {
  const fixture = setup();
  const calls = [];
  const restores = [];
  let attempt = 0;
  try {
    const ecp = new EffectCommitProtocol({
      state: fixture.state, ledger: new EffectLedger({ state: fixture.state }), deviceRuns: fixture.runs,
      recheck: async (input) => correctState(input.target),
      execute: async (input) => {
        calls.push(input);
        attempt += 1;
        if (attempt === 1) throw Object.assign(new Error("definitively not sent"), { code: "NOT_SENT" });
        return { httpStatus: 200 };
      },
      verify: async () => ({ ok: true, evidenceRefs: ["retry-verified"] }),
      restore: async (input) => { restores.push(input); return { ok: true }; },
    });
    const initial = await ecp.commit({
      tuple: fixture.run.tuple, mission: fixture.mission, action: "follow", target: "target-a",
      intent: { surface: "social-effect" }, idempotencyKey: "retry-not-sent",
    });
    assert.equal(initial.status, "not_sent");
    const reserved = fixture.state.listMissionEffects(fixture.mission.missionId).find((effect) => effect.effectId === initial.effect.effectId);
    assert.equal(reserved.reservationReleased, false);
    new EffectLedger({ state: fixture.state }).beginEffect({
      mission: fixture.mission, deviceRunId: fixture.run.deviceRunId, action: "comment", target: "target-a",
      intent: { surface: "social-effect" }, idempotencyKey: "other-reserved-slot",
    });

    const retried = await ecp.retryNotSentInPlace({
      effectId: initial.effect.effectId, tuple: fixture.run.tuple, mission: fixture.mission, target: "target-a",
      intent: { surface: "social-effect" },
    });
    assert.equal(retried.status, "verified");
    assert.equal(retried.effect.effectId, initial.effect.effectId);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].target, "target-a");
    assert.equal(restores.length, 2);
    assert.equal(fixture.state.listMissionEffects(fixture.mission.missionId).length, 2);
    assert.throws(() => new EffectLedger({ state: fixture.state }).beginEffect({
      mission: fixture.mission, deviceRunId: fixture.run.deviceRunId, action: "follow", target: "target-a",
      intent: { surface: "social-effect" }, idempotencyKey: "retry-must-not-overspend",
    }), { code: "BUDGET_EXCEEDED" });
  } finally {
    fixture.state.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("ECP notSent retry keeps the durable reservation when target or control recheck fails", async () => {
  const fixture = setup();
  let recheckedTarget = "target-a";
  let executeCount = 0;
  try {
    const ecp = new EffectCommitProtocol({
      state: fixture.state, ledger: new EffectLedger({ state: fixture.state }), deviceRuns: fixture.runs,
      recheck: async () => correctState(recheckedTarget),
      execute: async () => { executeCount += 1; throw Object.assign(new Error("not sent"), { code: "NOT_SENT" }); },
      verify: async () => ({ ok: true }), restore: async () => ({ ok: true }),
    });
    const initial = await ecp.commit({
      tuple: fixture.run.tuple, mission: fixture.mission, action: "follow", target: "target-a",
      intent: { surface: "social-effect" }, idempotencyKey: "retry-recheck-failure",
    });
    assert.equal(initial.status, "not_sent");
    recheckedTarget = "other-target";
    const targetBlocked = await ecp.retryNotSentInPlace({
      effectId: initial.effect.effectId, tuple: fixture.run.tuple, mission: fixture.mission, action: "follow", target: "target-a",
      intent: { surface: "social-effect" },
    });
    assert.deepEqual(targetBlocked, { status: "blocked", code: "TARGET_MISMATCH" });
    assert.equal(executeCount, 1);
    assert.equal(fixture.state.listMissionEffects(fixture.mission.missionId)[0].status, "not_sent");
    await assert.rejects(() => ecp.retryNotSentInPlace({
      effectId: initial.effect.effectId, tuple: { ...fixture.run.tuple, controllerEpoch: 0 }, mission: fixture.mission,
      action: "follow", target: "target-a", intent: { surface: "social-effect" },
    }), { code: "EPOCH_MISMATCH" });
    assert.equal(fixture.state.listMissionEffects(fixture.mission.missionId)[0].status, "not_sent");
  } finally {
    fixture.state.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
