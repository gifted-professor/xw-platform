import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { CapabilityRegistry } from "../control-plane/lib/capability-registry.mjs";
import { AdapterRegistry, ControlPlane } from "../control-plane/lib/control-plane.mjs";
import { EvidenceStore } from "../control-plane/lib/evidence-store.mjs";
import { StateStore } from "../control-plane/lib/state-store.mjs";

const tempBase = join(process.cwd(), "control-plane", "runtime");
mkdirSync(tempBase, { recursive: true });

function manifest(id, overrides = {}) {
  return {
    schemaVersion: 1,
    id,
    appId: "test",
    packageName: "local.test",
    versionRange: "test",
    maturity: "E3",
    risk: "R0",
    resources: ["device"],
    inputSchema: {
      type: "object",
      properties: { label: { type: "string" } },
      additionalProperties: false,
    },
    outputSchema: { type: "object" },
    preconditions: [],
    verification: { mode: "state", description: "fake verifier" },
    restoration: { required: false, description: "none" },
    timeoutMs: 1000,
    idempotency: "read_only",
    automationPolicy: { mode: "automatic" },
    implementation: { adapter: "test", action: id },
    evidence: [],
    ...overrides,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function until(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function fixture({ capabilities, adapter }) {
  const root = mkdtempSync(join(tempBase, "core-test-"));
  const state = new StateStore({ dbPath: join(root, "control.db") });
  const registry = new CapabilityRegistry(capabilities);
  const devices = ["01", "02"].map((alias) => state.upsertDevice({
    alias,
    physicalLabel: `rack-${alias}`,
    nodeId: "DESKTOP-3I1EVHE",
    runtimeId: `private-${alias}`,
  }));
  const evidence = new EvidenceStore({
    runsRoot: join(root, "runs"),
    state,
    minFreeBytes: 0,
    minExternalEffectFreeBytes: 0,
  });
  const control = new ControlPlane({
    state,
    capabilities: registry,
    adapters: new AdapterRegistry([adapter]),
    evidence,
    schedulerIntervalMs: 5,
    leaseTtlMs: 1000,
    leaseHeartbeatMs: 20,
  });
  control.start();
  return {
    root,
    state,
    registry,
    devices,
    evidence,
    control,
    async close() {
      await control.stop();
      state.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("different devices run concurrently while one device remains FIFO", async () => {
  const gates = [];
  const starts = [];
  let active = 0;
  let maxActive = 0;
  const adapter = {
    id: "test",
    async execute({ job, device }) {
      starts.push([job.jobId, device.alias]);
      active += 1;
      maxActive = Math.max(maxActive, active);
      const gate = deferred();
      gates.push(gate);
      await gate.promise;
      active -= 1;
      return { vendorCode: 0 };
    },
    async verify() { return { ok: true, mode: "state" }; },
    async restore() { return { ok: true }; },
  };
  const f = fixture({ capabilities: [manifest("test.observe")], adapter });
  try {
    const first = f.control.submitJob({
      idempotencyKey: "first",
      actorId: "agent-a",
      deviceId: f.devices[0].deviceId,
      capabilityId: "test.observe",
      params: { label: "first" },
    }).job;
    const secondSameDevice = f.control.submitJob({
      idempotencyKey: "second",
      actorId: "agent-b",
      deviceId: f.devices[0].deviceId,
      capabilityId: "test.observe",
      params: { label: "second" },
    }).job;
    const otherDevice = f.control.submitJob({
      idempotencyKey: "third",
      actorId: "agent-c",
      deviceId: f.devices[1].deviceId,
      capabilityId: "test.observe",
      params: { label: "third" },
    }).job;
    await until(() => starts.length === 2);
    assert.equal(maxActive, 2);
    assert.equal(starts.filter(([, alias]) => alias === "01").length, 1);
    assert.equal(f.state.requireJob(secondSameDevice.jobId).status, "queued");
    gates[0].resolve();
    gates[1].resolve();
    await until(() => starts.length === 3);
    gates[2].resolve();
    assert.equal((await f.control.waitForJob(first.jobId)).status, "succeeded");
    assert.equal((await f.control.waitForJob(otherDevice.jobId)).status, "succeeded");
    assert.equal((await f.control.waitForJob(secondSameDevice.jobId)).status, "succeeded");
  } finally {
    gates.forEach((gate) => gate.resolve());
    await f.close();
  }
});

test("external effects wait for approval before entering the queue", async () => {
  let executions = 0;
  const adapter = {
    id: "test",
    async execute() { executions += 1; return { vendorCode: 0 }; },
    async verify() { return { ok: true, mode: "custom" }; },
    async restore() { return { ok: true }; },
  };
  const external = manifest("test.external", {
    risk: "R2",
    idempotency: "external_effect",
    automationPolicy: { mode: "approval_required" },
  });
  const f = fixture({ capabilities: [external], adapter });
  try {
    const submitted = f.control.submitJob({
      idempotencyKey: "external",
      actorId: "agent-a",
      deviceId: f.devices[0].deviceId,
      capabilityId: external.id,
      params: {},
    }).job;
    assert.equal(submitted.status, "waiting_approval");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(executions, 0);
    f.control.decideApproval(submitted.jobId, {
      decision: "approve",
      actorId: "human-reviewer",
      reason: "bounded test",
    });
    assert.equal((await f.control.waitForJob(submitted.jobId)).status, "succeeded");
    assert.equal(executions, 1);
  } finally {
    await f.close();
  }
});

test("sent failures become ambiguous without automatic retry", async () => {
  let executions = 0;
  const adapter = {
    id: "test",
    async execute() {
      executions += 1;
      const error = new Error("timeout after send");
      error.code = "SENT_TIMEOUT";
      error.sent = true;
      throw error;
    },
    async restore() { return { ok: true }; },
  };
  const f = fixture({ capabilities: [manifest("test.ambiguous")], adapter });
  try {
    const job = f.control.submitJob({
      idempotencyKey: "ambiguous",
      actorId: "agent-a",
      deviceId: f.devices[0].deviceId,
      capabilityId: "test.ambiguous",
      params: {},
    }).job;
    assert.equal((await f.control.waitForJob(job.jobId)).status, "ambiguous");
    assert.equal(executions, 1);
    assert.equal(f.control.submitJob({
      idempotencyKey: "ambiguous",
      actorId: "agent-a",
      deviceId: f.devices[0].deviceId,
      capabilityId: "test.ambiguous",
      params: {},
    }).job.jobId, job.jobId);
    assert.equal(executions, 1);
  } finally {
    await f.close();
  }
});

test("restoration failure quarantines the device", async () => {
  const adapter = {
    id: "test",
    async execute() { return { vendorCode: 0 }; },
    async verify() { return { ok: true, mode: "state" }; },
    async restore() { return { ok: false }; },
  };
  const f = fixture({
    capabilities: [manifest("test.restore", {
      restoration: { required: true, description: "must restore" },
    })],
    adapter,
  });
  try {
    const job = f.control.submitJob({
      idempotencyKey: "restore",
      actorId: "agent-a",
      deviceId: f.devices[0].deviceId,
      capabilityId: "test.restore",
      params: {},
    }).job;
    assert.equal((await f.control.waitForJob(job.jobId)).status, "recovery_required");
    assert.equal(f.state.getDevice(f.devices[0].deviceId).quarantined, true);
  } finally {
    await f.close();
  }
});

test("E1 lab actions require an exclusive canary session and valid token", async () => {
  let executions = 0;
  const adapter = {
    id: "test",
    async execute() { executions += 1; return { vendorCode: 0 }; },
    async verify() { return { ok: true, mode: "state" }; },
    async restore() { return { ok: true }; },
  };
  const lab = manifest("test.lab", {
    maturity: "E1",
    automationPolicy: { mode: "lab_only", canaryOnly: true },
  });
  const f = fixture({ capabilities: [lab], adapter });
  try {
    assert.throws(() => f.control.submitJob({
      idempotencyKey: "not-lab",
      actorId: "agent-a",
      deviceId: f.devices[0].deviceId,
      capabilityId: lab.id,
      params: {},
    }), { code: "CANARY_SESSION_REQUIRED" });
    const session = f.control.createSession({
      actorId: "agent-a",
      deviceId: f.devices[0].deviceId,
      canary: true,
    });
    await assert.rejects(
      f.control.executeSessionAction(session.sessionId, "wrong", {
        idempotencyKey: "bad-token",
        capabilityId: lab.id,
        params: {},
      }),
      { code: "SESSION_TOKEN_INVALID" },
    );
    const job = await f.control.executeSessionAction(session.sessionId, session.token, {
      idempotencyKey: "lab-action",
      capabilityId: lab.id,
      params: {},
    });
    assert.equal(job.status, "succeeded");
    assert.equal(executions, 1);
    assert.equal(f.control.releaseSession(session.sessionId, session.token).released, true);
  } finally {
    await f.close();
  }
});
