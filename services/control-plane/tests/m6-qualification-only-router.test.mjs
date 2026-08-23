import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { assertM6QualificationBootstrapClosed, createControlPlaneRuntime } from "../control-plane/bootstrap.mjs";
import { CapabilityRegistry } from "../control-plane/lib/capability-registry.mjs";
import { canonicalJson, sha256 } from "../control-plane/lib/canonical.mjs";
import { AdapterRegistry, ControlPlane } from "../control-plane/lib/control-plane.mjs";
import { ControlPlaneError } from "../control-plane/lib/errors.mjs";
import { StateStore } from "../control-plane/lib/state-store.mjs";
import { ControlRouter } from "../control-plane/router.mjs";

const TOKEN = "qualification-only-control-token-0000000001";
const ACCOUNT_HASH = "a".repeat(64);
const EPOCH_HASH = "b".repeat(64);
const LOCKS_HASH = "c".repeat(64);

function closedGate(overrides = {}) {
  return {
    schemaId: "xw.m6-gate-f-operations-status.v1",
    mode: "CLOSED",
    phase: "CLOSED",
    purpose: null,
    epochHash: EPOCH_HASH,
    generation: 7,
    locksHash: LOCKS_HASH,
    tripleConsistent: true,
    errors: [],
    activeAuthorizationCount: 0,
    actionCount: 0,
    resourceCounts: { jobs: 0, leases: 0, runs: 0, sessions: 0 },
    ...overrides,
  };
}

function closedEpoch() {
  const raw = {
    schemaId: "xw.m6-live-gate.v1",
    gateId: "m6-qualification-gate",
    mode: "CLOSED",
    status: "closed",
    releaseId: "release-qualification-test",
    sourceCommit: "d".repeat(40),
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
    closeoutRef: { id: "closeout", sha256: "4".repeat(64) },
    aggregateSealRef: { id: "aggregate", sha256: "5".repeat(64) },
    rollbackTargetEpochHash: null,
  };
  return { ...raw, epochHash: sha256(`xw.m6-live-gate.v1:${canonicalJson(raw)}`) };
}

function inMemoryEvidence() {
  return {
    minExternalEffectFreeBytes: 0,
    freeBytes() { return 1_000_000; },
    assertCapacity() {},
    initializeRun() {},
    storageForRun(runId) { return { runId }; },
  };
}

function qualificationBody(gate = closedGate()) {
  const deviceId = "public-device-01";
  const requestHash = sha256(`xw.m6-target-environment-job.v1:${canonicalJson({
    accountIsolationBindingHash: ACCOUNT_HASH,
    deviceId,
    gateEpochHash: gate.epochHash,
    gateGeneration: gate.generation,
    gateLocksHash: gate.locksHash,
  })}`);
  return {
    actorId: "operator:m6-target-environment-qualification",
    capabilityId: "xiaowei.m6.qualify_environment",
    idempotencyKey: `m6-env-${requestHash}`,
    params: {
      accountIsolationBindingHash: ACCOUNT_HASH,
      gateEpochHash: gate.epochHash,
      gateGeneration: gate.generation,
      gateLocksHash: gate.locksHash,
    },
    canary: true,
    deviceId,
    expectedGateEpochHash: gate.epochHash,
    expectedGateGeneration: gate.generation,
    expectedGateLocksHash: gate.locksHash,
  };
}

function fixture({ gate = closedGate(), afterSubmit = null } = {}) {
  let currentGate = structuredClone(gate);
  const jobs = new Map();
  const cancelled = [];
  const state = {
    listDevices() {
      return [
        { deviceId: "public-device-01", alias: "01", online: true, quarantined: false, runtimeId: "private-runtime-01" },
        { deviceId: "public-device-02", alias: "02", online: true, quarantined: false, runtimeId: "private-runtime-02" },
      ];
    },
    listLeases() { return []; },
    requireJob(jobId) {
      const job = jobs.get(jobId);
      if (!job) throw new ControlPlaneError("JOB_NOT_FOUND", "missing", { status: 404 });
      return job;
    },
  };
  const control = {
    policyMode: null,
    submitM6QualificationJob(input) {
      const job = {
        jobId: "qualification-job-1",
        runId: "qualification-run-1",
        status: "queued",
        ...structuredClone(input),
      };
      jobs.set(job.jobId, job);
      afterSubmit?.({ gate: currentGate, setGate(value) { currentGate = value; } });
      return { reused: false, job };
    },
    submitJob() {
      throw new Error("qualification-only router must not use the ordinary submitJob path");
    },
    cancelJob(jobId) { cancelled.push(jobId); return jobs.get(jobId); },
    transportStatus() { return { status: "idle", ageMs: 0 }; },
  };
  const gateOperations = {
    assertAuthorized(headers = {}) {
      if (headers["x-control-token"] !== TOKEN) {
        throw new ControlPlaneError("M6_GATE_F_ACCESS_DENIED", "denied", { status: 403 });
      }
    },
    status() { return structuredClone(currentGate); },
    health() { return { installed: true, status: "PREFLIGHT_REQUIRED", blockers: [], actionCount: 0 }; },
  };
  const evidence = { minExternalEffectFreeBytes: 0, freeBytes() { return 1_000_000; } };
  const router = new ControlRouter({
    control,
    state,
    capabilities: { capabilities: [{ id: "ordinary" }, { id: "xiaowei.m6.qualify_environment" }] },
    evidence,
    m6GateFOperations: gateOperations,
    m6RuntimeMode: "QUALIFICATION_ONLY",
  });
  return { router, jobs, cancelled, gateOperations, state };
}

test("qualification-only bootstrap requires exact CLOSED zero-resource state before scheduler start", () => {
  assert.throws(() => createControlPlaneRuntime({
    m6RuntimeMode: "QUALIFICATION_ONLY",
    m6Enabled: false,
    m6LiveEntryEnabled: false,
    m6GateFOperationsEnabled: false,
  }), { code: "M6_QUALIFICATION_BOOTSTRAP_UNSAFE" });
  assert.throws(() => createControlPlaneRuntime({
    m6RuntimeMode: "FINAL",
    m6Enabled: true,
    m6LiveEntryEnabled: false,
    m6GateFOperationsEnabled: true,
  }), { code: "M6_FINAL_BOOTSTRAP_INCOMPLETE" });
  const standardState = new StateStore();
  try {
    assert.throws(() => createControlPlaneRuntime({
      state: standardState,
      m6RuntimeMode: "QUALIFICATION_ONLY",
      m6Enabled: false,
      m6LiveEntryEnabled: false,
      m6GateFOperationsEnabled: true,
    }), { code: "M6_RUNTIME_MODE_STATE_MISMATCH" });
  } finally {
    standardState.close();
  }
  const gateOperations = { status: () => closedGate() };
  const state = { getM6GateFResourceCounts: () => ({ jobs: 0, leases: 0, sessions: 0, actionCount: 0 }) };
  assert.deepEqual(assertM6QualificationBootstrapClosed({ gateOperations, state }), {
    epochHash: EPOCH_HASH,
    generation: 7,
    locksHash: LOCKS_HASH,
  });
  assert.throws(() => assertM6QualificationBootstrapClosed({
    gateOperations,
    state: { getM6GateFResourceCounts: () => ({ jobs: 1, leases: 0, sessions: 0, actionCount: 0 }) },
  }), { code: "M6_QUALIFICATION_BOOTSTRAP_NOT_CLOSED" });
  assert.throws(() => assertM6QualificationBootstrapClosed({
    gateOperations: { status: () => closedGate({ mode: "GROUNDED_ACTION", phase: "GROUNDED_ACTION" }) },
    state,
  }), { code: "M6_QUALIFICATION_BOOTSTRAP_NOT_CLOSED" });
});

test("ordinary STANDARD /jobs cannot submit either internal M6 capability", async () => {
  const state = new StateStore({ m6RuntimeMode: "STANDARD" });
  try {
    const capabilities = CapabilityRegistry.load(fileURLToPath(new URL("../apps", import.meta.url)));
    const evidence = inMemoryEvidence();
    const control = new ControlPlane({
      state,
      capabilities,
      adapters: new AdapterRegistry([]),
      evidence,
    });
    const router = new ControlRouter({
      control,
      state,
      capabilities,
      evidence,
      m6RuntimeMode: "STANDARD",
    });
    const requests = [
      {
        idempotencyKey: "generic-qualification",
        actorId: "operator:m6-target-environment-qualification",
        capabilityId: "xiaowei.m6.qualify_environment",
        params: {
          accountIsolationBindingHash: "a".repeat(64),
          gateEpochHash: "b".repeat(64),
          gateGeneration: 0,
          gateLocksHash: "c".repeat(64),
        },
        canary: true,
      },
      {
        idempotencyKey: "generic-grounded-run",
        actorId: "agent:m6-production-broker",
        capabilityId: "xiaowei.m6.grounded_run",
        params: {
          runPacketRef: "d".repeat(64),
          grantRef: "e".repeat(64),
          scenarioManifestRef: "f".repeat(64),
        },
        canary: true,
      },
    ];
    for (const body of requests) {
      await assert.rejects(
        () => router.handle({ method: "POST", path: "/control/v1/jobs", body }),
        (error) => error?.status === 403,
      );
    }
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

test("authenticated QUALIFICATION_ONLY route reaches the dedicated ControlPlane authority path", async () => {
  const state = new StateStore({
    m6RuntimeMode: "QUALIFICATION_ONLY",
    now: () => Date.parse("2030-01-01T00:00:00Z"),
  });
  try {
    const epoch = closedEpoch();
    state.seedM6GateFence({ epoch, locksHash: LOCKS_HASH });
    const capabilities = CapabilityRegistry.load(fileURLToPath(new URL("../apps", import.meta.url)));
    const evidence = inMemoryEvidence();
    state.upsertDevice({
      deviceId: "public-device-01",
      alias: "01",
      physicalLabel: "qualification-01",
      nodeId: "DESKTOP-3I1EVHE",
      runtimeId: "private-runtime-01",
      routingProfile: {
        enabled: true,
        capabilityIds: ["xiaowei.m6.qualify_environment"],
      },
    });
    const control = new ControlPlane({
      state,
      capabilities,
      adapters: new AdapterRegistry([]),
      evidence,
    });
    control.pump = async () => {};
    const status = () => {
      const fence = state.getM6GateFence();
      const counts = state.getM6GateFResourceCounts();
      return closedGate({
        epochHash: fence.epochHash,
        generation: fence.generation,
        locksHash: fence.locksHash,
        actionCount: counts.actionCount,
        resourceCounts: { ...counts, runs: 0 },
      });
    };
    const gateOperations = {
      assertAuthorized(headers = {}) {
        if (headers["x-control-token"] !== TOKEN) {
          throw new ControlPlaneError("M6_GATE_F_ACCESS_DENIED", "denied", { status: 403 });
        }
      },
      status,
      health() { return { installed: true, status: "PREFLIGHT_REQUIRED", blockers: [], actionCount: 0 }; },
    };
    const router = new ControlRouter({
      control,
      state,
      capabilities,
      evidence,
      m6GateFOperations: gateOperations,
      m6RuntimeMode: "QUALIFICATION_ONLY",
    });
    const gate = status();
    const body = qualificationBody(gate);
    const created = await router.handle({
      method: "POST",
      path: "/control/v1/jobs",
      headers: { "x-control-token": TOKEN },
      body,
    });
    assert.equal(created.status, 202);
    assert.equal(created.body.job.actorId, "operator:m6-target-environment-qualification");
    assert.equal(state.getM6GateFResourceCounts().jobs, 1);
  } finally {
    state.close();
  }
});

test("qualification-only router exposes only authenticated Gate status, public alias01 and the formal job", async () => {
  const { router, jobs } = fixture();
  const headers = { "x-control-token": TOKEN };
  const health = await router.handle({ method: "GET", path: "/control/v1/health" });
  assert.equal(health.body.m6RuntimeMode, "QUALIFICATION_ONLY");
  assert.equal(health.body.capabilities, 1);
  assert.equal(health.body.m6LiveEntry, undefined);

  await assert.rejects(() => router.handle({ method: "GET", path: "/control/v1/devices", headers: {} }), {
    code: "M6_GATE_F_ACCESS_DENIED",
  });
  const devices = await router.handle({ method: "GET", path: "/control/v1/devices", headers });
  assert.deepEqual(devices.body.devices, [{ deviceId: "public-device-01", alias: "01", online: true, quarantined: false }]);
  assert.doesNotMatch(JSON.stringify(devices), /private-runtime/u);

  for (const request of [
    { method: "GET", path: "/control/v1/capabilities", headers },
    { method: "POST", path: "/control/v1/sessions", headers, body: {} },
    { method: "POST", path: "/control/v1/internal/m6/gate-f/activate", headers, body: {} },
  ]) {
    await assert.rejects(() => router.handle(request), { code: "M6_QUALIFICATION_ONLY_ROUTE_FORBIDDEN" });
  }

  const body = qualificationBody();
  const submitted = await router.handle({ method: "POST", path: "/control/v1/jobs", headers, body });
  assert.equal(submitted.status, 202);
  assert.deepEqual(jobs.get("qualification-job-1").params, body.params);
  const status = await router.handle({ method: "GET", path: "/control/v1/jobs/qualification-job-1", headers });
  assert.equal(status.body.job.capabilityId, "xiaowei.m6.qualify_environment");
  jobs.set("ordinary-job", { jobId: "ordinary-job", capabilityId: "ordinary", canary: false });
  await assert.rejects(() => router.handle({ method: "GET", path: "/control/v1/jobs/ordinary-job", headers }), {
    code: "M6_QUALIFICATION_JOB_SCOPE_INVALID",
  });
});

test("qualification-only job rejects open/rebound Gate and cancels synchronous submission drift", async () => {
  const headers = { "x-control-token": TOKEN };
  const opened = fixture({ gate: closedGate({ mode: "GROUNDED_ACTION", phase: "GROUNDED_ACTION" }) });
  await assert.rejects(() => opened.router.handle({
    method: "POST", path: "/control/v1/jobs", headers, body: qualificationBody(),
  }), { code: "M6_QUALIFICATION_GATE_NOT_CLOSED" });
  assert.equal(opened.jobs.size, 0);

  const drifted = fixture({
    afterSubmit({ gate, setGate }) { setGate({ ...gate, generation: gate.generation + 1 }); },
  });
  await assert.rejects(() => drifted.router.handle({
    method: "POST", path: "/control/v1/jobs", headers, body: qualificationBody(),
  }), { code: "M6_QUALIFICATION_GATE_DRIFT" });
  assert.deepEqual(drifted.cancelled, ["qualification-job-1"]);
});
