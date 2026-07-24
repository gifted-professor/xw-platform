import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CapabilityRegistry } from "../control-plane/lib/capability-registry.mjs";
import { StateStore } from "../control-plane/lib/state-store.mjs";

const tempBase = fileURLToPath(new URL("../control-plane/runtime", import.meta.url));
mkdirSync(tempBase, { recursive: true });

function tempRoot() {
  return mkdtempSync(join(tempBase, "state-test-"));
}

function capability(overrides = {}) {
  return {
    schemaVersion: 1,
    id: "test.observe",
    appId: "test",
    packageName: "local.test",
    versionRange: "test",
    maturity: "E3",
    risk: "R0",
    resources: ["device"],
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: { type: "object" },
    preconditions: [],
    verification: { mode: "state", description: "fake verifier" },
    restoration: { required: false, description: "none" },
    timeoutMs: 1000,
    idempotency: "read_only",
    automationPolicy: { mode: "automatic" },
    implementation: { adapter: "test", action: "observe" },
    evidence: [],
    ...overrides,
  };
}

function setup(path) {
  const state = new StateStore({ dbPath: path });
  const registry = new CapabilityRegistry([capability()]);
  state.syncCapabilities(registry);
  const device = state.upsertDevice({
    alias: "01",
    physicalLabel: "rack-01",
    nodeId: "DESKTOP-3I1EVHE",
    runtimeId: "private-runtime-id",
  });
  return { state, device, registry };
}

test("idempotency is durable and public device records redact runtime IDs", () => {
  const root = tempRoot();
  const path = join(root, "control.db");
  const { state, device, registry } = setup(path);
  try {
    assert.equal(Object.hasOwn(state.getDevice(device.deviceId), "runtimeId"), false);
    assert.equal(state.getDevice(device.deviceId, { includeRuntime: true }).runtimeId, "private-runtime-id");
    const input = {
      idempotencyKey: "same",
      actorId: "agent-a",
      deviceId: device.deviceId,
      capability: registry.require("test.observe"),
      params: {},
    };
    const first = state.createJob(input);
    const second = state.createJob(input);
    assert.equal(first.reused, false);
    assert.equal(second.reused, true);
    assert.equal(second.job.jobId, first.job.jobId);
    assert.throws(
      () => state.createJob({ ...input, params: { changed: true } }),
      { code: "IDEMPOTENCY_CONFLICT", status: 409 },
    );
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("exclusive leases reject a second actor and validate tokens", () => {
  const root = tempRoot();
  const { state, device } = setup(join(root, "control.db"));
  try {
    const session = state.createSession({ actorId: "agent-a", deviceId: device.deviceId, canary: true });
    assert.throws(
      () => state.createSession({ actorId: "agent-b", deviceId: device.deviceId }),
      { code: "DEVICE_BUSY", status: 423 },
    );
    assert.throws(() => state.heartbeatSession(session.sessionId, "wrong"), { code: "SESSION_TOKEN_INVALID" });
    assert.equal(state.heartbeatSession(session.sessionId, session.token).sessionId, session.sessionId);
    assert.deepEqual(state.releaseSession(session.sessionId, session.token), {
      released: true,
      sessionId: session.sessionId,
    });
    assert.equal(state.listLeases().length, 0);
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("restart marks in-flight work recovery_required and quarantines its device", () => {
  const root = tempRoot();
  const path = join(root, "control.db");
  let state;
  try {
    const fixture = setup(path);
    state = fixture.state;
    const created = state.createJob({
      idempotencyKey: "restart",
      actorId: "agent-a",
      deviceId: fixture.device.deviceId,
      capability: fixture.registry.require("test.observe"),
      params: {},
    });
    const lease = state.acquireLease({
      deviceId: fixture.device.deviceId,
      kind: "job",
      holderId: created.job.jobId,
      jobId: created.job.jobId,
    });
    state.transitionJob(created.job.jobId, "running");
    assert.ok(lease.token);
    state.close();
    state = new StateStore({ dbPath: path });
    assert.equal(state.requireJob(created.job.jobId).status, "recovery_required");
    assert.equal(state.getDevice(fixture.device.deviceId).quarantined, true);
    assert.equal(state.listLeases().length, 0);
  } finally {
    try { state?.close(); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});
