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
