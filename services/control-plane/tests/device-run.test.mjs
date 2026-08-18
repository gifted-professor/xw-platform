import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";

import { DeviceRunRuntime } from "../control-plane/lib/device-run.mjs";
import { MissionRuntime } from "../control-plane/lib/mission-runtime.mjs";
import { StateStore } from "../control-plane/lib/state-store.mjs";

const AUTHORITY = "DESKTOP-3I1EVHE";

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "device-run-"));
}

const missionInput = {
  issuer: { actorId: "human:operator" },
  idempotencyKey: "freedom-run-01",
  app: "xhs",
  account: "local-alias",
  parallelism: 1,
  controllers: ["agent:runner"],
  scope: {
    actions: ["follow", "like", "collect", "comment", "dm"],
    targets: { kind: "fingerprint", values: ["target-hash-aaa"] },
    totalCount: 5,
    perTargetCount: 1,
    frequency: { count: 1, windowSeconds: 3600 },
  },
  validity: { expiresAt: "2099-07-29T16:00:00Z" },
};

function setup(path, { now } = {}) {
  const state = new StateStore({ dbPath: path, ...(now ? { now } : {}) });
  const missions = new MissionRuntime({ state });
  const runs = new DeviceRunRuntime({ state, missions, authorityNodeId: AUTHORITY, leaseTtlMs: 60000, leaseHeartbeatMs: 10000 });
  state.upsertNode({ nodeId: AUTHORITY, authority: true });
  const device = state.upsertDevice({
    alias: "01",
    physicalLabel: "rack-01",
    nodeId: AUTHORITY,
    runtimeId: "private-runtime-id",
    routingProfile: { enabled: true, tags: ["slot:01"], capabilityIds: [] },
  });
  const { mission } = missions.createMission(missionInput);
  return { state, missions, runs, device, mission };
}

test("openDeviceRun atomically selects one canonical ready/free device and owns the lease", () => {
  const root = tempRoot();
  const { state, runs, device, mission } = setup(join(root, "control.db"));
  try {
    const run = runs.openDeviceRun({ missionId: mission.missionId, controllerAgent: "agent:runner" });
    assert.equal(run.deviceId, device.deviceId);
    assert.ok(run.deviceRunId);
    assert.ok(run.sessionId);
    assert.ok(run.leaseId);
    assert.equal(run.controllerEpoch, 1);
    assert.equal(run.lease.ownerDeviceRunId, run.deviceRunId);
    assert.deepEqual(run.tuple, {
      missionId: mission.missionId,
      deviceRunId: run.deviceRunId,
      sessionId: run.sessionId,
      controllerAgent: "agent:runner",
      controllerEpoch: 1,
    });
    // one device, one lease, one device_run
    assert.equal(state.listLeases().length, 1);
    assert.equal(runs.listDeviceRuns({ missionId: mission.missionId }).length, 1);
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("racing two opens for the one ready device yields exactly one success and one DEVICE_BUSY", () => {
  const root = tempRoot();
  const { state, runs, mission } = setup(join(root, "control.db"));
  try {
    const first = runs.openDeviceRun({ missionId: mission.missionId, controllerAgent: "agent:runner" });
    assert.ok(first.deviceRunId);
    assert.throws(
      () => runs.openDeviceRun({ missionId: mission.missionId, controllerAgent: "agent:runner" }),
      { code: "DEVICE_BUSY" },
    );
    assert.equal(state.listLeases().length, 1);
    assert.equal(runs.listDeviceRuns({ missionId: mission.missionId }).length, 1);
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a controller not on the Mission allow-list is rejected before any allocation", () => {
  const root = tempRoot();
  const { state, runs, mission } = setup(join(root, "control.db"));
  try {
    assert.throws(
      () => runs.openDeviceRun({ missionId: mission.missionId, controllerAgent: "agent:imposter" }),
      { code: "CONTROLLER_NOT_AUTHORIZED" },
    );
    assert.equal(state.listLeases().length, 0);
    assert.equal(runs.listDeviceRuns({ missionId: mission.missionId }).length, 0);
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a revoked or expired mission cannot open a device run", () => {
  const root = tempRoot();
  const { state, runs, mission, missions } = setup(join(root, "control.db"));
  try {
    missions.revokeMission(mission.missionId, { actorId: "human:operator", reason: "user-revoke" });
    assert.throws(
      () => runs.openDeviceRun({ missionId: mission.missionId, controllerAgent: "agent:runner" }),
      { code: "MISSION_REVOKED" },
    );
    assert.equal(state.listLeases().length, 0);
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("no ready free device fails closed with NO_ELIGIBLE_DEVICE and allocates nothing", () => {
  const root = tempRoot();
  const { state, runs, mission, device } = setup(join(root, "control.db"));
  try {
    state.upsertDevice({
      deviceId: device.deviceId,
      alias: "01",
      physicalLabel: "rack-01",
      nodeId: AUTHORITY,
      online: false,
      routingProfile: { enabled: true, tags: [], capabilityIds: [] },
    });
    assert.throws(
      () => runs.openDeviceRun({ missionId: mission.missionId, controllerAgent: "agent:runner" }),
      { code: "NO_ELIGIBLE_DEVICE" },
    );
    assert.equal(state.listLeases().length, 0);
    assert.equal(runs.listDeviceRuns({ missionId: mission.missionId }).length, 0);
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Registry/Control Plane readiness disagreement blocks with READINESS_SPLIT and no allocation", () => {
  const root = tempRoot();
  const { state, runs, mission, device } = setup(join(root, "control.db"));
  try {
    // registry mirror says the device is offline while the control plane says ready
    assert.throws(
      () => runs.openDeviceRun({
        missionId: mission.missionId,
        controllerAgent: "agent:runner",
        registrySnapshot: { deviceId: device.deviceId, alias: "01", online: false },
      }),
      { code: "READINESS_SPLIT" },
    );
    assert.equal(state.listLeases().length, 0);
    assert.equal(runs.listDeviceRuns({ missionId: mission.missionId }).length, 0);
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("assertControlTuple validates the complete fencing tuple and rejects stale epoch", () => {
  const root = tempRoot();
  const { state, runs, mission } = setup(join(root, "control.db"));
  try {
    const run = runs.openDeviceRun({ missionId: mission.missionId, controllerAgent: "agent:runner" });
    const tuple = run.tuple;
    assert.equal(runs.assertControlTuple(tuple).deviceRunId, run.deviceRunId);

    // stale epoch
    assert.throws(
      () => runs.assertControlTuple({ ...tuple, controllerEpoch: 0 }),
      { code: "EPOCH_MISMATCH" },
    );
    // missing member
    assert.throws(
      () => runs.assertControlTuple({ ...tuple, sessionId: undefined }),
      { code: "CONTROL_TUPLE_INCOMPLETE" },
    );
    // wrong mission
    assert.throws(
      () => runs.assertControlTuple({ ...tuple, missionId: "mission_other" }),
      { code: "MISSION_MISMATCH" },
    );
    // wrong controller
    assert.throws(
      () => runs.assertControlTuple({ ...tuple, controllerAgent: "agent:imposter" }),
      { code: "CONTROLLER_NOT_AUTHORIZED" },
    );
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("heartbeat and control-loss tracking do not auto-resume an effect", () => {
  const root = tempRoot();
  const { state, runs, mission } = setup(join(root, "control.db"));
  try {
    const run = runs.openDeviceRun({ missionId: mission.missionId, controllerAgent: "agent:runner" });
    const beat = runs.heartbeatDeviceRun(run.deviceRunId, run.token);
    assert.equal(beat.phase, "running");
    assert.ok(Date.parse(beat.heartbeatAt) >= Date.parse(run.heartbeatAt));

    const lost = runs.markControlLost(run.deviceRunId, { reason: "adb-bridge-disconnected" });
    assert.equal(lost.phase, "paused_control_lost");
    // a stale-epoch command against a control-lost run still fails closed
    assert.throws(
      () => runs.assertControlTuple({ ...run.tuple, controllerEpoch: 0 }),
      { code: "EPOCH_MISMATCH" },
    );
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("restart marks in-flight device runs paused_control_lost without auto-resume", () => {
  const root = tempRoot();
  const path = join(root, "control.db");
  let state;
  try {
    const fixture = setup(path);
    state = fixture.state;
    const run = fixture.runs.openDeviceRun({ missionId: fixture.mission.missionId, controllerAgent: "agent:runner" });
    state.close();
    state = new StateStore({ dbPath: path });
    const runs = new DeviceRunRuntime({ state, missions: new MissionRuntime({ state }), authorityNodeId: AUTHORITY });
    const recovered = runs.getDeviceRun(run.deviceRunId);
    assert.equal(recovered.phase, "paused_control_lost");
    assert.equal(state.listLeases().length, 0);
  } finally {
    try { state?.close(); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy non-Mission sessions and leases retain their behavior during migration", () => {
  const root = tempRoot();
  const { state, runs, mission, device } = setup(join(root, "control.db"));
  try {
    // a legacy pinned session (no Mission) still works alongside device runs
    const session = state.createSession({ actorId: "agent-legacy", deviceId: device.deviceId, canary: true });
    assert.ok(session.sessionId);
    assert.equal(Object.hasOwn(session, "ownerDeviceRunId"), false);
    state.releaseSession(session.sessionId, session.token);
    assert.equal(state.listLeases().length, 0);
    // and a Mission run can still open after the legacy session released
    const run = runs.openDeviceRun({ missionId: mission.missionId, controllerAgent: "agent:runner" });
    assert.equal(run.lease.ownerDeviceRunId, run.deviceRunId);
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});