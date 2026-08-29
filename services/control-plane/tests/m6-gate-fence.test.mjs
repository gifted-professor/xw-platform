import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CapabilityRegistry } from "../control-plane/lib/capability-registry.mjs";
import { canonicalJson, sha256 } from "../control-plane/lib/canonical.mjs";
import { CURRENT_CONTROL_SCHEMA_VERSION, StateStore } from "../control-plane/lib/state-store.mjs";
import { seedM6CompositeAuthority } from "./helpers/m6-composite-authority.mjs";

function closedEpoch(overrides = {}) {
  const raw = {
    schemaId: "xw.m6-live-gate.v1",
    gateId: "m6-gate",
    mode: "CLOSED",
    status: "closed",
    releaseId: "release-v19-test",
    sourceCommit: "a".repeat(40),
    actor: "operator:test",
    lockHashes: {
      runtimeProfile: "1".repeat(64),
      hardRedlinePolicy: "2".repeat(64),
      groundingRuntime: "3".repeat(64),
    },
    allowlist: ["01"],
    issuedAt: "2030-01-01T00:00:00Z",
    expiresAt: "2030-01-02T00:00:00Z",
    parentEpochHash: null,
    closeoutRef: { id: "close", sha256: "4".repeat(64) },
    aggregateSealRef: { id: "aggregate", sha256: "5".repeat(64) },
    rollbackTargetEpochHash: null,
    ...overrides,
  };
  return { ...raw, epochHash: sha256(`xw.m6-live-gate.v1:${canonicalJson(raw)}`) };
}

test("v21 migration creates an empty fence and seeds generation 0 only from a self-hashed v1 CLOSED tail", () => {
  const root = mkdtempSync(join(tmpdir(), "m6-fence-"));
  const state = new StateStore({ dbPath: join(root, "control.db") });
  try {
    assert.equal(CURRENT_CONTROL_SCHEMA_VERSION, 21);
    assert.equal(state.db.prepare("PRAGMA user_version").get().user_version, CURRENT_CONTROL_SCHEMA_VERSION);
    assert.equal(state.getM6GateFence(), null);
    assert.throws(() => state.seedM6GateFence({ epoch: closedEpoch({ mode: "OBSERVE_ONLY", status: "active" }), locksHash: "6".repeat(64) }), {
      code: "M6_GATE_FENCE_SEED_INVALID",
    });
    const epoch = closedEpoch();
    const fence = state.seedM6GateFence({ epoch, locksHash: "6".repeat(64) });
    assert.equal(fence.epochHash, epoch.epochHash);
    assert.equal(fence.generation, 0);
    assert.equal(fence.mode, "CLOSED");
    assert.equal(state.seedM6GateFence({ epoch, locksHash: "6".repeat(64) }).epochHash, epoch.epochHash);
    assert.throws(() => state.seedM6GateFence({ epoch: closedEpoch({ actor: "other" }), locksHash: "6".repeat(64) }), {
      code: "M6_GATE_FENCE_ALREADY_SEEDED",
    });
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("fence promotion is BEGIN IMMEDIATE CAS and file/DB mismatch fails closed", () => {
  const state = new StateStore();
  try {
    const seed = closedEpoch();
    state.seedM6GateFence({ epoch: seed, locksHash: "6".repeat(64) });
    const next = {
      gateId: seed.gateId,
      epochHash: "7".repeat(64),
      mode: "GROUNDED_ACTION",
      purpose: "M6_4_ACTION_SMOKE",
      allowlist: ["01"],
      expiresAt: "2030-01-01T01:00:00Z",
      releaseId: seed.releaseId,
      sourceCommit: seed.sourceCommit,
      locksHash: "8".repeat(64),
    };
    assert.throws(() => state.promoteM6GateFence({ expectedEpochHash: "9".repeat(64), expectedGeneration: 0, next }), {
      code: "M6_GATE_FENCE_CAS_MISMATCH",
    });
    const consumption = { nonce: "hot-close-nonce", authorizationHash: "d".repeat(64), reasonCode: "SAFETY_STOP" };
    const promoted = state.promoteM6GateFence({ expectedEpochHash: seed.epochHash, expectedGeneration: 0, next, emergencyCloseConsumption: consumption });
    assert.equal(promoted.generation, 1);
    assert.equal(promoted.mode, "GROUNDED_ACTION");
    assert.equal(state.assertM6GateFence(promoted).epochHash, next.epochHash);
    assert.throws(() => state.assertM6GateFence({ ...promoted, generation: 2 }), { code: "M6_GATE_FENCE_MISMATCH" });
    assert.throws(() => state.promoteM6GateFence({ expectedEpochHash: seed.epochHash, expectedGeneration: 0, next }), {
      code: "M6_GATE_FENCE_CAS_MISMATCH",
    });
    const next2 = { ...next, epochHash: "e".repeat(64), mode: "CLOSED", purpose: "M6_4_CLOSEOUT" };
    assert.throws(() => state.promoteM6GateFence({
      expectedEpochHash: next.epochHash,
      expectedGeneration: 1,
      next: next2,
      emergencyCloseConsumption: consumption,
    }), { code: "M6_GATE_EMERGENCY_CLOSE_REPLAY" });
    assert.equal(state.getM6GateFence().generation, 1);
    assert.equal(state.getM6EmergencyCloseConsumption(consumption.nonce).reasonCode, "SAFETY_STOP");
  } finally {
    state.close();
  }
});

test("gate activation atomically requires zero resources and then isolates ordinary sessions", () => {
  const state = new StateStore();
  try {
    const seed = closedEpoch();
    state.seedM6GateFence({ epoch: seed, locksHash: "6".repeat(64) });
    const registry = CapabilityRegistry.load(fileURLToPath(new URL("../apps", import.meta.url)));
    const groundedCapability = registry.require("xiaowei.m6.grounded_run");
    state.syncCapabilities(registry);
    const device = state.upsertDevice({
      alias: "01",
      physicalLabel: "rack-01",
      nodeId: "node-a",
      runtimeId: "private-01",
      routingProfile: { enabled: true, tags: ["slot:01"] },
    });
    const session = state.createSession({
      actorId: "operator:qualification",
      authorityNodeId: "node-a",
      deviceId: device.deviceId,
      canary: true,
      sessionKind: "open_action",
    });
    const next = {
      gateId: seed.gateId,
      epochHash: "7".repeat(64),
      mode: "GROUNDED_ACTION",
      purpose: "M6_4_ACTION_SMOKE",
      allowlist: ["01"],
      expiresAt: "2030-01-01T01:00:00Z",
      releaseId: seed.releaseId,
      sourceCommit: seed.sourceCommit,
      locksHash: "8".repeat(64),
    };
    assert.throws(() => state.promoteM6GateFence({
      expectedEpochHash: seed.epochHash,
      expectedGeneration: 0,
      next,
    }), { code: "M6_GATE_F_RESOURCES_NOT_ZERO" });
    assert.equal(state.getM6GateFence().mode, "CLOSED");

    state.releaseSession(session.sessionId, session.token);
    const promoted = state.promoteM6GateFence({
      expectedEpochHash: seed.epochHash,
      expectedGeneration: 0,
      next,
    });
    assert.equal(promoted.mode, "GROUNDED_ACTION");
    assert.throws(() => state.createSession({
      actorId: "operator:ordinary",
      authorityNodeId: "node-a",
      deviceId: device.deviceId,
      canary: true,
      sessionKind: "open_action",
    }), { code: "M6_GATE_ACTIVE_ISOLATION" });
    assert.throws(() => state.createSession({
      actorId: "agent:m6-production-broker",
      authorityNodeId: "node-a",
      deviceId: device.deviceId,
      capability: groundedCapability,
      canary: true,
      invocation: "composite_action",
      m6CompositeAuthority: {},
    }), { code: "M6_COMPOSITE_AUTHORITY_INVALID" });
    assert.throws(() => state.createJob({
      idempotencyKey: "ordinary-active-job",
      actorId: "agent:ordinary",
      authorityNodeId: "node-a",
      deviceId: device.deviceId,
      capability: groundedCapability,
      canary: true,
    }), { code: "M6_GATE_ACTIVE_ISOLATION" });
    assert.throws(() => state.acquireLease({
      deviceId: device.deviceId,
      kind: "job",
      holderId: "ordinary-job",
    }), { code: "M6_GATE_ACTIVE_ISOLATION" });
    assert.throws(() => state.openDiscoveryRunStorage({
      grantId: "ordinary-grant",
      grantHash: "ordinary-grant-hash",
      controllerAgent: "agent:ordinary",
      authorityNodeId: "node-a",
    }), { code: "M6_GATE_ACTIVE_ISOLATION" });
    assert.throws(() => state.openDeviceRunStorage({
      missionId: "ordinary-mission",
      missionHash: "ordinary-mission-hash",
      missionVersion: 1,
      controllerAgent: "agent:ordinary",
      authorityNodeId: "node-a",
    }), { code: "M6_GATE_ACTIVE_ISOLATION" });
    assert.deepEqual(state.getM6GateFResourceCounts(), {
      jobs: 0,
      leases: 0,
      sessions: 0,
      actionCount: 0,
    });
  } finally {
    state.close();
  }
});

test("composite exception binds production actor, alias 01, live claim, authorization, and current fence", () => {
  const now = Date.parse("2030-01-01T00:00:00Z");
  const state = new StateStore({ now: () => now });
  try {
    const seed = closedEpoch();
    state.seedM6GateFence({ epoch: seed, locksHash: "6".repeat(64) });
    const fence = state.promoteM6GateFence({
      expectedEpochHash: seed.epochHash,
      expectedGeneration: 0,
      next: {
        gateId: seed.gateId,
        epochHash: "7".repeat(64),
        mode: "GROUNDED_ACTION",
        purpose: "M6_4_ACTION_SMOKE",
        allowlist: ["01"],
        expiresAt: "2030-01-01T01:00:00Z",
        releaseId: seed.releaseId,
        sourceCommit: seed.sourceCommit,
        locksHash: "8".repeat(64),
      },
    });
    const registry = CapabilityRegistry.load(fileURLToPath(new URL("../apps", import.meta.url)));
    const capability = registry.require("xiaowei.m6.grounded_run");
    state.syncCapabilities(registry);
    state.upsertNode({ nodeId: "node-a", authority: true });
    const device01 = state.upsertDevice({
      deviceId: "device-01",
      alias: "01",
      physicalLabel: "rack-01",
      nodeId: "node-a",
      runtimeId: "private-01",
      routingProfile: { enabled: true, capabilityIds: [capability.id] },
    });
    const device02 = state.upsertDevice({
      deviceId: "device-02",
      alias: "02",
      physicalLabel: "rack-02",
      nodeId: "node-a",
      runtimeId: "private-02",
      routingProfile: { enabled: true, capabilityIds: [capability.id] },
    });
    const composite = seedM6CompositeAuthority(state, { fence });
    const sessionInput = {
      actorId: composite.actorId,
      authorityNodeId: "node-a",
      deviceId: device01.deviceId,
      capability,
      canary: true,
      invocation: "composite_action",
      m6CompositeAuthority: composite.authority,
    };
    assert.throws(() => state.createSession({
      ...sessionInput,
      actorId: "agent:forged-broker",
    }), { code: "M6_COMPOSITE_AUTHORITY_INVALID" });
    assert.throws(() => state.createSession({
      ...sessionInput,
      deviceId: device02.deviceId,
    }), { code: "M6_COMPOSITE_AUTHORITY_INVALID" });
    assert.throws(() => state.createSession({
      ...sessionInput,
      m6CompositeAuthority: {
        ...composite.authority,
        fence: { ...fence, generation: fence.generation + 1 },
      },
    }), { code: "M6_COMPOSITE_AUTHORITY_INVALID" });
    state.db.prepare("UPDATE m6_live_scenario_claims SET status='FINALIZED', finalized_at=? WHERE claim_hash=?")
      .run(now, composite.authority.scenarioClaimHash);
    assert.throws(() => state.createSession(sessionInput), { code: "M6_COMPOSITE_AUTHORITY_INVALID" });
    state.db.prepare("UPDATE m6_live_scenario_claims SET status='STARTED', finalized_at=NULL WHERE claim_hash=?")
      .run(composite.authority.scenarioClaimHash);
    assert.throws(() => state.createSession({
      ...sessionInput,
      ttlMs: Date.parse(fence.expiresAt) - now + 1,
    }), { code: "M6_COMPOSITE_AUTHORITY_INVALID" });
    const session = state.createSession(sessionInput);
    const jobInput = {
      idempotencyKey: composite.idempotencyKey,
      operationKey: composite.idempotencyKey,
      actorId: composite.actorId,
      authorityNodeId: "node-a",
      deviceId: device01.deviceId,
      capability,
      params: composite.params,
      sessionId: session.sessionId,
      status: "running",
      canary: true,
      invocation: "composite_action",
      externalEffect: true,
      m6CompositeAuthority: composite.authority,
    };
    assert.throws(() => state.createJob({
      ...jobInput,
      params: { ...composite.params, grantRef: "0".repeat(64) },
    }), { code: "M6_COMPOSITE_AUTHORITY_INVALID" });
    const created = state.createJob(jobInput);
    assert.equal(created.job.actorId, "agent:m6-production-broker");
    assert.equal(created.job.deviceId, device01.deviceId);
    assert.equal(created.job.status, "running");
    assert.deepEqual(state.getM6GateFResourceCounts(), {
      jobs: 1,
      leases: 1,
      sessions: 1,
      actionCount: 0,
    });
  } finally {
    state.close();
  }
});

test("formal qualification job atomically binds the exact CLOSED fence triple", () => {
  const state = new StateStore({ m6RuntimeMode: "QUALIFICATION_ONLY" });
  try {
    const seed = closedEpoch();
    const locksHash = "6".repeat(64);
    state.seedM6GateFence({ epoch: seed, locksHash });
    const registry = CapabilityRegistry.load(fileURLToPath(new URL("../apps", import.meta.url)));
    const capability = registry.require("xiaowei.m6.qualify_environment");
    state.syncCapabilities(registry);
    state.upsertNode({ nodeId: "node-a", authority: true });
    const device = state.upsertDevice({
      alias: "01",
      physicalLabel: "rack-01",
      nodeId: "node-a",
      runtimeId: "private-01",
      routingProfile: { enabled: true, capabilityIds: [capability.id] },
    });
    const params = {
      accountIsolationBindingHash: "a".repeat(64),
      gateEpochHash: seed.epochHash,
      gateGeneration: 0,
      gateLocksHash: locksHash,
    };
    assert.throws(() => state.createM6QualificationJob({
      idempotencyKey: "qualification-rebound",
      actorId: "operator:m6-target-environment-qualification",
      authorityNodeId: "node-a",
      deviceId: device.deviceId,
      capability,
      params: { ...params, gateGeneration: 1 },
      canary: true,
    }), { code: "M6_QUALIFICATION_GATE_REBOUND" });
    assert.deepEqual(state.getM6GateFResourceCounts(), {
      jobs: 0,
      leases: 0,
      sessions: 0,
      actionCount: 0,
    });
    const requestHash = sha256(`xw.m6-target-environment-job.v1:${canonicalJson({
      accountIsolationBindingHash: params.accountIsolationBindingHash,
      deviceId: device.deviceId,
      gateEpochHash: params.gateEpochHash,
      gateGeneration: params.gateGeneration,
      gateLocksHash: params.gateLocksHash,
    })}`);
    const created = state.createM6QualificationJob({
      idempotencyKey: `m6-env-${requestHash}`,
      actorId: "operator:m6-target-environment-qualification",
      authorityNodeId: "node-a",
      deviceId: device.deviceId,
      capability,
      params,
      canary: true,
    });
    assert.equal(created.reused, false);
    assert.equal(created.job.status, "queued");
    assert.deepEqual(created.job.params, params);
    assert.equal(state.getM6GateFResourceCounts().jobs, 1);
    assert.throws(() => state.createJob({
      idempotencyKey: `m6-env-${requestHash}`,
      actorId: "operator:m6-target-environment-qualification",
      authorityNodeId: "node-a",
      deviceId: device.deviceId,
      capability,
      params,
      canary: true,
    }), { code: "M6_QUALIFICATION_ONLY_REQUIRED" });
  } finally {
    state.close();
  }
});
