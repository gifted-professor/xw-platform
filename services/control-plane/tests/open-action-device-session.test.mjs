import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CapabilityRegistry } from "../control-plane/lib/capability-registry.mjs";
import { AdapterRegistry, ControlPlane } from "../control-plane/lib/control-plane.mjs";
import { EvidenceStore } from "../control-plane/lib/evidence-store.mjs";
import { createFakeObserveProvider } from "../control-plane/lib/open-action-session.mjs";
import { StateStore } from "../control-plane/lib/state-store.mjs";
import { ControlRouter } from "../control-plane/router.mjs";
import { validateDeviceSession, validateObservation } from "../../../packages/kernel/lib/open-action.mjs";

const tempBase = fileURLToPath(new URL("../control-plane/runtime", import.meta.url));
mkdirSync(tempBase, { recursive: true });

function capability() {
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
  };
}

function fixture({ observeProvider } = {}) {
  const root = mkdtempSync(join(tempBase, "oa-session-"));
  const state = new StateStore({ dbPath: join(root, "control.db") });
  const caps = new CapabilityRegistry([capability()]);
  state.upsertNode({ nodeId: "DESKTOP-3I1EVHE", authority: true });
  const device = state.upsertDevice({
    alias: "01",
    physicalLabel: "rack-01",
    nodeId: "DESKTOP-3I1EVHE",
    runtimeId: "private-01",
    routingProfile: { enabled: true, tags: ["slot:01"], capabilityIds: ["test.observe"] },
  });
  const evidence = new EvidenceStore({
    runsRoot: join(root, "runs"),
    state,
    minFreeBytes: 0,
    minExternalEffectFreeBytes: 0,
  });
  const control = new ControlPlane({
    state,
    evidence,
    capabilities: caps,
    adapters: new AdapterRegistry([{
      id: "test",
      async execute() { return {}; },
      async verify() { return { ok: true }; },
      async restore() { return { ok: true }; },
    }]),
    authorityNodeId: "DESKTOP-3I1EVHE",
    observeProvider,
  });
  const router = new ControlRouter({ control, state, capabilities: caps, evidence });
  return { root, state, device, control, router };
}

test("open_action device session acquires the exclusive lease without capabilityId", async () => {
  const f = fixture();
  try {
    const created = await f.router.handle({
      method: "POST",
      path: "/control/v1/device-sessions",
      body: { actorId: "agent-oa", deviceId: f.device.deviceId },
    });
    assert.equal(created.status, 201);
    const session = created.body.session;
    assert.equal(validateDeviceSession(session).ok, true);
    assert.equal(session.sessionKind, "open_action");
    assert.equal(session.capabilityId, null);
    assert.equal(session.deviceId, f.device.deviceId);
    assert.ok(created.body.token);
    assert.equal(f.state.listLeases().length, 1);
    assert.equal(f.state.listLeases()[0].leaseId, session.leaseId);
  } finally {
    f.state.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("open_action and capability sessions share the one-lease-per-device lock", async () => {
  const f = fixture();
  try {
    const open = await f.router.handle({
      method: "POST",
      path: "/control/v1/device-sessions",
      body: { actorId: "agent-oa", deviceId: f.device.deviceId },
    });
    assert.equal(open.status, 201);
    await assert.rejects(
      () => f.router.handle({
        method: "POST",
        path: "/control/v1/sessions",
        body: { actorId: "agent-cap", deviceId: f.device.deviceId, capabilityId: "test.observe" },
      }),
      { code: "DEVICE_BUSY", status: 423 },
    );
    await f.router.handle({
      method: "POST",
      path: `/control/v1/device-sessions/${open.body.session.sessionId}/release`,
      body: { token: open.body.token },
    });
    const cap = await f.router.handle({
      method: "POST",
      path: "/control/v1/sessions",
      body: { actorId: "agent-cap", deviceId: f.device.deviceId, capabilityId: "test.observe" },
    });
    assert.equal(cap.status, 201);
    await assert.rejects(
      () => f.router.handle({
        method: "POST",
        path: "/control/v1/device-sessions",
        body: { actorId: "agent-oa-2", deviceId: f.device.deviceId },
      }),
      { code: "DEVICE_BUSY", status: 423 },
    );
  } finally {
    f.state.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("observe returns ObservationV1 evidence refs and mutatingCalls=0", async () => {
  const provider = createFakeObserveProvider();
  const f = fixture({ observeProvider: provider });
  try {
    const created = await f.router.handle({
      method: "POST",
      path: "/control/v1/device-sessions",
      body: { actorId: "agent-oa", deviceId: f.device.deviceId },
    });
    const observed = await f.router.handle({
      method: "POST",
      path: `/control/v1/device-sessions/${created.body.session.sessionId}/observe`,
      body: { token: created.body.token },
    });
    assert.equal(observed.status, 200);
    assert.equal(observed.body.mutatingCalls, 0);
    assert.equal(provider.mutatingCalls, 0);
    assert.equal(validateObservation(observed.body.observation).ok, true);
    assert.equal(observed.body.observation.screenshotBytes, undefined);
    assert.equal(observed.body.observation.uiTree, undefined);
    assert.ok(observed.body.observation.screenshotRef.startsWith("evidence:"));
    assert.ok(Array.isArray(observed.body.observation.evidenceRefs));
    assert.ok(observed.body.observation.evidenceRefs.length >= 1);

    const again = await f.router.handle({
      method: "POST",
      path: `/control/v1/device-sessions/${created.body.session.sessionId}/observe`,
      body: { token: created.body.token },
    });
    assert.notEqual(again.body.observation.observationId, observed.body.observation.observationId);
    assert.equal(provider.observeCount, 2);

    const events = await f.router.handle({
      method: "GET",
      path: `/control/v1/device-sessions/${created.body.session.sessionId}/events`,
      query: new URLSearchParams({ token: created.body.token }),
      headers: {},
    });
    assert.equal(events.status, 200);
    assert.ok(events.body.events.some((event) => event.type === "device_session.created"));
    assert.equal(events.body.events.filter((event) => event.type === "observation.captured").length, 2);
  } finally {
    f.state.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("capability session cannot observe and open_action cannot execute legacy actions", async () => {
  const f = fixture();
  try {
    const cap = await f.router.handle({
      method: "POST",
      path: "/control/v1/sessions",
      body: { actorId: "agent-cap", deviceId: f.device.deviceId, capabilityId: "test.observe" },
    });
    await assert.rejects(
      () => f.router.handle({
        method: "POST",
        path: `/control/v1/device-sessions/${cap.body.session.sessionId}/observe`,
        body: { token: cap.body.session.token },
      }),
      { code: "SESSION_KIND_MISMATCH", status: 409 },
    );

    await f.router.handle({
      method: "POST",
      path: `/control/v1/sessions/${cap.body.session.sessionId}/release`,
      body: { token: cap.body.session.token },
    });

    const open = await f.router.handle({
      method: "POST",
      path: "/control/v1/device-sessions",
      body: { actorId: "agent-oa", deviceId: f.device.deviceId },
    });
    await assert.rejects(
      () => f.router.handle({
        method: "POST",
        path: `/control/v1/sessions/${open.body.session.sessionId}/actions`,
        body: { token: open.body.token, idempotencyKey: "nope", capabilityId: "test.observe", params: {} },
      }),
      { code: "SESSION_KIND_MISMATCH", status: 409 },
    );
    await assert.rejects(
      () => f.router.handle({
        method: "POST",
        path: `/control/v1/device-sessions/${open.body.session.sessionId}/actions`,
        body: { token: open.body.token, kind: "tap" },
      }),
      { code: "SESSION_KIND_MISMATCH", status: 405 },
    );
    await assert.rejects(
      () => f.router.handle({
        method: "POST",
        path: `/control/v1/device-sessions/${open.body.session.sessionId}/observe`,
        body: { token: open.body.token, kind: "tap" },
      }),
      { code: "PRIMITIVE_NOT_SUPPORTED", status: 405 },
    );
  } finally {
    f.state.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("open_action create rejects capabilityId and heartbeat/get/release stay on the new lane", async () => {
  const f = fixture();
  try {
    await assert.rejects(
      () => f.router.handle({
        method: "POST",
        path: "/control/v1/device-sessions",
        body: { actorId: "agent-oa", deviceId: f.device.deviceId, capabilityId: "test.observe" },
      }),
      { code: "SESSION_KIND_MISMATCH" },
    );

    const created = await f.router.handle({
      method: "POST",
      path: "/control/v1/device-sessions",
      body: { actorId: "agent-oa", deviceId: f.device.deviceId },
    });
    const got = await f.router.handle({
      method: "GET",
      path: `/control/v1/device-sessions/${created.body.session.sessionId}`,
      query: new URLSearchParams({ token: created.body.token }),
      headers: {},
    });
    assert.equal(got.status, 200);
    assert.equal(got.body.session.sessionKind, "open_action");
    assert.equal(got.body.token, undefined);

    const beat = await f.router.handle({
      method: "POST",
      path: `/control/v1/device-sessions/${created.body.session.sessionId}/heartbeat`,
      body: { token: created.body.token },
    });
    assert.equal(beat.status, 200);

    await assert.rejects(
      () => f.router.handle({
        method: "POST",
        path: `/control/v1/sessions/${created.body.session.sessionId}/heartbeat`,
        body: { token: created.body.token },
      }),
      { code: "SESSION_KIND_MISMATCH", status: 409 },
    );

    const released = await f.router.handle({
      method: "POST",
      path: `/control/v1/device-sessions/${created.body.session.sessionId}/release`,
      body: { token: created.body.token },
    });
    assert.deepEqual(released.body, { released: true, sessionId: created.body.session.sessionId });
    assert.equal(f.state.listLeases().length, 0);
  } finally {
    f.state.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("incomplete fake observation is rejected and does not record a mutating call", async () => {
  const f = fixture({
    observeProvider: {
      mutatingCalls: 0,
      async observe() {
        return { screenshotBytes: "AAAA" };
      },
    },
  });
  try {
    const created = await f.router.handle({
      method: "POST",
      path: "/control/v1/device-sessions",
      body: { actorId: "agent-oa", deviceId: f.device.deviceId },
    });
    await assert.rejects(
      () => f.router.handle({
        method: "POST",
        path: `/control/v1/device-sessions/${created.body.session.sessionId}/observe`,
        body: { token: created.body.token },
      }),
      { code: "OBSERVATION_INCOMPLETE" },
    );
    assert.equal(f.state.listDeviceSessionObservations(created.body.session.sessionId).length, 0);
  } finally {
    f.state.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
