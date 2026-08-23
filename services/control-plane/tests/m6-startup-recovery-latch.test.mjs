import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { deriveM6StartupRecoveryLatch } from "../control-plane/bootstrap.mjs";
import {
  deriveM6GateFSafetyClosePackageHash,
  deriveM6GateFSafetyCloseProofHash,
} from "../control-plane/lib/m6-gate-safety-close-arm.mjs";
import { createM6LiveEntry } from "../control-plane/lib/m6-live-entry.mjs";
import { StateStore } from "../control-plane/lib/state-store.mjs";
import { ControlRouter } from "../control-plane/router.mjs";
import { startControlPlaneScheduler } from "../control-plane/server.mjs";

const H = (character) => character.repeat(64);
const LIVE_TOKEN = "m6-live-recovery-route-token-at-least-32-bytes";
const GATE_TOKEN = "m6-gate-recovery-route-token-at-least-32-bytes";
const PURPOSE = "M6_4_ACTION_SMOKE";

function activeFixture({ withArm = true } = {}) {
  const activeEpochHash = H("a");
  const closeEpochHash = H("b");
  const safetyProof = Object.freeze({
    algorithm: "ed25519",
    allowlistVersion: 1,
    keyId: "gate-key",
    signature: "opaque-signature",
    subject: "operator:test",
  });
  const safetyPackage = Object.freeze({
    authorization: null,
    epoch: Object.freeze({
      epochHash: closeEpochHash,
      gateId: "m6-test-gate",
      parentEpochHash: activeEpochHash,
      purpose: PURPOSE,
    }),
    operation: "EMERGENCY_CLOSE",
    phase: null,
    proof: safetyProof,
    reasonCode: "SAFETY_STOP",
  });
  const fence = Object.freeze({
    gateId: "m6-test-gate",
    epochHash: activeEpochHash,
    generation: 4,
    mode: "GROUNDED_ACTION",
    purpose: PURPOSE,
    locksHash: H("e"),
  });
  const arm = withArm ? Object.freeze({
    gateId: fence.gateId,
    purpose: fence.purpose,
    activeEpochHash,
    closeEpochHash,
    packageHash: deriveM6GateFSafetyClosePackageHash(safetyPackage),
    activationProofHash: H("c"),
    proofHash: deriveM6GateFSafetyCloseProofHash(safetyProof),
    reasonCode: safetyPackage.reasonCode,
    package: safetyPackage,
    armedGeneration: fence.generation,
    status: "ARMED",
  }) : null;
  const gate = Object.freeze({
    schemaId: "xw.m6-gate-f-operations-status.v1",
    mode: fence.mode,
    phase: "GROUNDED_ACTION",
    purpose: fence.purpose,
    epochHash: fence.epochHash,
    generation: fence.generation,
    locksHash: fence.locksHash,
    tripleConsistent: true,
    errors: [],
    activeAuthorizationCount: 1,
  });
  return {
    state: {
      getM6GateFence: () => fence,
      getM6GateSafetyCloseArm: () => arm,
    },
    gateOperations: { status: () => gate },
  };
}

function closedFixture({
  fencePurpose = null,
  gatePurpose = null,
  actionCount = 0,
  resourceCounts = { jobs: 0, leases: 0, runs: 0, sessions: 0 },
  terminalArm = null,
  generation = 0,
} = {}) {
  const fence = Object.freeze({
    mode: "CLOSED",
    purpose: fencePurpose,
    epochHash: H("d"),
    generation,
    locksHash: H("e"),
  });
  return {
    state: {
      getM6GateFence: () => fence,
      getM6GateSafetyCloseArmByTerminalEpoch: () => terminalArm,
    },
    gateOperations: { status: () => ({
      schemaId: "xw.m6-gate-f-operations-status.v1",
      mode: "CLOSED",
      phase: "CLOSED",
      purpose: gatePurpose,
      epochHash: fence.epochHash,
      generation: fence.generation,
      locksHash: fence.locksHash,
      tripleConsistent: true,
      errors: [],
      activeAuthorizationCount: 0,
      actionCount,
      resourceCounts,
    }) },
  };
}

test("FINAL bootstrap derives an immutable recovery-only latch from one exact ACTIVE/ARMED generation", () => {
  const exact = activeFixture();
  const latch = deriveM6StartupRecoveryLatch({
    runtimeMode: "FINAL",
    state: exact.state,
    gateOperations: exact.gateOperations,
  });
  assert.deepEqual(latch, {
    schemaId: "xw.m6-startup-recovery-latch.v1",
    required: true,
    status: "RECOVERY_ONLY",
    reason: "DURABLE_GATE_ACTIVE_ARMED",
    gateEpochHash: H("a"),
    purpose: PURPOSE,
    schedulerAllowed: false,
    externalResourceState: "NOT_ASSERTED",
  });
  assert.equal(Object.isFrozen(latch), true);

  const missingArm = activeFixture({ withArm: false });
  const unsafe = deriveM6StartupRecoveryLatch({
    runtimeMode: "FINAL",
    state: missingArm.state,
    gateOperations: missingArm.gateOperations,
  });
  assert.equal(unsafe.required, true);
  assert.equal(unsafe.status, "UNSAFE_RECOVERY_ONLY");
  assert.equal(unsafe.schedulerAllowed, false);

  assert.equal(deriveM6StartupRecoveryLatch({ runtimeMode: "STANDARD" }), null);
  const baseClosed = closedFixture();
  assert.equal(deriveM6StartupRecoveryLatch({
    runtimeMode: "FINAL",
    ...baseClosed,
  }).required, false);
  assert.equal(deriveM6StartupRecoveryLatch({
    runtimeMode: "FINAL",
    state: baseClosed.state,
    gateOperations: { status: () => { throw new Error("pointer drift"); } },
  }).status, "UNSAFE_RECOVERY_ONLY");
});

test("server never starts the scheduler in recovery-only and starts only for a separately verified base CLOSED state", () => {
  let starts = 0;
  const control = { start() { starts += 1; } };
  const held = startControlPlaneScheduler({
    control,
    m6StartupRecovery: { required: true },
  });
  assert.deepEqual(held, { started: false, recoveryOnly: true });
  assert.equal(starts, 0);

  const baseClosed = startControlPlaneScheduler({
    control,
    m6StartupRecovery: { required: false },
  });
  assert.deepEqual(baseClosed, { started: true, recoveryOnly: false });
  assert.equal(starts, 1);
});

test("FINAL CLOSED is NORMAL only for null-purpose zero-resource base state with no terminal arm", () => {
  for (const [name, fixture] of [
    ["terminal arm", closedFixture({ terminalArm: { status: "CONSUMED", terminalEpochHash: H("d") } })],
    ["fence purpose", closedFixture({ fencePurpose: PURPOSE })],
    ["status purpose", closedFixture({ gatePurpose: PURPOSE })],
    ["non-base generation", closedFixture({ generation: 1 })],
    ["action count", closedFixture({ actionCount: 1 })],
    ["job resource", closedFixture({ resourceCounts: { jobs: 1, leases: 0, runs: 0, sessions: 0 } })],
    ["lease resource", closedFixture({ resourceCounts: { jobs: 0, leases: 1, runs: 0, sessions: 0 } })],
    ["run resource", closedFixture({ resourceCounts: { jobs: 0, leases: 0, runs: 1, sessions: 0 } })],
    ["session resource", closedFixture({ resourceCounts: { jobs: 0, leases: 0, runs: 0, sessions: 1 } })],
  ]) {
    const latch = deriveM6StartupRecoveryLatch({ runtimeMode: "FINAL", ...fixture });
    assert.equal(latch.required, true, name);
    assert.equal(latch.schedulerAllowed, false, name);
  }
});

test("a persisted terminal arm keeps a real CLOSED Gate recovery-only across every StateStore restart", () => {
  const root = mkdtempSync(join(tmpdir(), "m6-terminal-startup-latch-"));
  const dbPath = join(root, "control.db");
  let state = new StateStore({ dbPath, m6RuntimeMode: "FINAL" });
  const terminalEpochHash = H("d");
  const activeEpochHash = H("a");
  try {
    state.db.prepare(`
      INSERT INTO m6_gate_fence (
        marker, gate_id, epoch_hash, generation, mode, purpose, allowlist_json,
        expires_at, release_id, source_commit, locks_hash, updated_at
      ) VALUES ('M6', ?, ?, 2, 'CLOSED', ?, '["01"]', ?, ?, ?, ?, ?)
    `).run(
      "m6-terminal-restart-gate",
      terminalEpochHash,
      "M6_4_HOT_CLOSE",
      Date.parse("2030-01-01T02:00:00Z"),
      "m6-terminal-restart-release",
      "a".repeat(40),
      H("e"),
      Date.parse("2030-01-01T01:00:00Z"),
    );
    state.db.prepare(`
      INSERT INTO m6_gate_safety_close_arms (
        active_epoch_hash, gate_id, purpose, close_epoch_hash, package_hash,
        activation_proof_hash, proof_hash, reason_code, expires_at,
        authorization_expires_at, package_expires_at, package_json,
        armed_generation, status, armed_at, terminal_epoch_hash,
        terminal_proof_hash, terminalized_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'SAFETY_STOP', ?, ?, ?, '{}', 1,
        'CONSUMED', ?, ?, NULL, ?)
    `).run(
      activeEpochHash,
      "m6-terminal-restart-gate",
      "M6_4_HOT_CLOSE",
      terminalEpochHash,
      H("f"),
      H("c"),
      H("b"),
      Date.parse("2030-01-01T02:00:00Z"),
      Date.parse("2030-01-01T02:00:00Z"),
      Date.parse("2030-01-01T02:00:00Z"),
      Date.parse("2030-01-01T00:30:00Z"),
      terminalEpochHash,
      Date.parse("2030-01-01T00:45:00Z"),
    );
    const status = () => ({
      schemaId: "xw.m6-gate-f-operations-status.v1",
      mode: "CLOSED",
      phase: "CLOSED",
      purpose: null,
      epochHash: terminalEpochHash,
      generation: 2,
      locksHash: H("e"),
      tripleConsistent: true,
      errors: [],
      activeAuthorizationCount: 0,
      actionCount: 0,
      resourceCounts: { jobs: 0, leases: 0, runs: 0, sessions: 0 },
    });
    const latchFor = (store) => deriveM6StartupRecoveryLatch({
      runtimeMode: "FINAL",
      state: store,
      gateOperations: { status },
    });
    const first = latchFor(state);
    assert.equal(first.required, true);
    assert.equal(first.reason, "DURABLE_GATE_TERMINAL_CANARY");

    state.close();
    state = new StateStore({ dbPath, m6RuntimeMode: "FINAL" });
    const second = latchFor(state);
    assert.equal(second.required, true);
    assert.equal(second.reason, "DURABLE_GATE_TERMINAL_CANARY");
    assert.equal(second.schedulerAllowed, false);
  } finally {
    try { state.close(); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});

function recoveryRouter({ required = true } = {}) {
  const state = {
    listDevices: () => [{ deviceId: "device-public", alias: "01" }],
    listLeases: () => [],
  };
  const liveEntry = createM6LiveEntry({
    state: {
      getM6GateFence() { return null; },
      getM64LiveWindowAuthorizationConsumption() { return null; },
      claimM64LiveScenarioStart() { throw new Error("recovery must not start a scenario"); },
    },
    config: { internalToken: LIVE_TOKEN },
  });
  let gateRecoveryCalls = 0;
  const gateOperations = {
    assertAuthorized(headers) {
      if (headers["x-control-token"] !== GATE_TOKEN) {
        throw Object.assign(new Error("denied"), { code: "M6_GATE_F_ACCESS_DENIED", status: 403 });
      }
    },
    health: () => ({ installed: true, status: "PREFLIGHT_REQUIRED", blockers: [], actionCount: 0 }),
    status: () => ({ schemaId: "xw.m6-gate-f-operations-status.v1", mode: "CLOSED" }),
    recoverArmedActive(body) {
      assert.deepEqual(body, {});
      gateRecoveryCalls += 1;
      return {
        recovery: {
          schemaId: "xw.m6-gate-f-armed-active-recovery.v1",
          recovered: true,
          priorEpochHash: H("a"),
          terminalEpochHash: H("b"),
          tripleConsistent: true,
          status: "EMERGENCY_CLOSED",
        },
        gate: { schemaId: "xw.m6-gate-f-operations-status.v1", mode: "CLOSED" },
      };
    },
  };
  const latch = {
    schemaId: "xw.m6-startup-recovery-latch.v1",
    required,
    status: required ? "RECOVERY_ONLY" : "NORMAL",
    reason: required ? "DURABLE_GATE_ACTIVE_ARMED" : null,
    gateEpochHash: required ? H("a") : null,
    purpose: required ? PURPOSE : null,
    schedulerAllowed: !required,
    externalResourceState: "NOT_ASSERTED",
  };
  return {
    gateRecoveryCalls: () => gateRecoveryCalls,
    router: new ControlRouter({
      control: {},
      state,
      capabilities: { capabilities: [] },
      evidence: { freeBytes: () => 1_000_000, minExternalEffectFreeBytes: 1 },
      m6GateFOperations: gateOperations,
      m6LiveEntry: liveEntry,
      m6RuntimeMode: "FINAL",
      m6StartupRecovery: latch,
    }),
  };
}

test("recovery-only router exposes only authenticated health/Gate/live recovery and never unlatches in process", async () => {
  const held = recoveryRouter();
  const health = await held.router.handle({ method: "GET", path: "/control/v1/health" });
  assert.equal(health.status, 200);
  assert.equal(health.body.m6StartupRecovery.required, true);
  assert.equal(health.body.m6StartupRecovery.externalResourceState, "NOT_ASSERTED");

  await assert.rejects(() => held.router.handle({ method: "GET", path: "/control/v1/devices" }), {
    code: "M6_STARTUP_RECOVERY_ONLY",
    status: 503,
  });
  await assert.rejects(() => held.router.handle({
    method: "POST",
    path: "/control/v1/internal/m6/live/start",
    headers: { "x-control-token": LIVE_TOKEN },
    body: {},
  }), { code: "M6_STARTUP_RECOVERY_ONLY", status: 503 });
  await assert.rejects(() => held.router.handle({
    method: "POST",
    path: "/control/v1/internal/m6/gate-f/recover-armed-active",
    headers: {},
    body: {},
  }), { code: "M6_GATE_F_ACCESS_DENIED", status: 403 });

  const gate = await held.router.handle({
    method: "POST",
    path: "/control/v1/internal/m6/gate-f/recover-armed-active",
    headers: { "x-control-token": GATE_TOKEN },
    body: {},
  });
  assert.deepEqual(Object.keys(gate.body.recovery).sort(), [
    "priorEpochHash", "recovered", "schemaId", "status", "terminalEpochHash", "tripleConsistent",
  ].sort());
  assert.equal(held.gateRecoveryCalls(), 1);

  const request = { gateEpochHash: H("a"), purpose: PURPOSE };
  await assert.rejects(() => held.router.handle({
    method: "POST",
    path: "/control/v1/internal/m6/live/recover-epoch",
    headers: {},
    body: request,
  }), { code: "M6_LIVE_ENTRY_ACCESS_DENIED", status: 403 });
  await assert.rejects(() => held.router.handle({
    method: "POST",
    path: "/control/v1/internal/m6/live/recover-epoch",
    headers: { "x-control-token": LIVE_TOKEN },
    body: { ...request, token: LIVE_TOKEN },
  }), { code: "M6_LIVE_EPOCH_RECOVERY_INPUT_INVALID", status: 400 });
  const live = await held.router.handle({
    method: "POST",
    path: "/control/v1/internal/m6/live/recover-epoch",
    headers: { "x-control-token": LIVE_TOKEN },
    body: request,
  });
  assert.equal(live.body.recovery.status, "RECOVERED");
  assert.equal(live.body.recovery.controlPlaneOwnedActiveRuns, 0);
  assert.equal(live.body.recovery.externalResourceState, "NOT_ASSERTED");
  assert.equal(JSON.stringify(live.body).includes(LIVE_TOKEN), false);
  assert.equal(JSON.stringify(live.body).includes("signature"), false);

  // Recovery only reduces authority.  The same process and every restart from
  // the same terminal canary state remain latched; there is no resume path.
  await assert.rejects(() => held.router.handle({ method: "GET", path: "/control/v1/devices" }), {
    code: "M6_STARTUP_RECOVERY_ONLY",
  });
  const restarted = recoveryRouter();
  await assert.rejects(() => restarted.router.handle({ method: "GET", path: "/control/v1/devices" }), {
    code: "M6_STARTUP_RECOVERY_ONLY",
  });
});
