import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CapabilityRegistry } from "../control-plane/lib/capability-registry.mjs";
import { AdapterRegistry, ControlPlane } from "../control-plane/lib/control-plane.mjs";
import { EvidenceStore } from "../control-plane/lib/evidence-store.mjs";
import { createFakeObserveProvider } from "../control-plane/lib/open-action-session.mjs";
import { CURRENT_CONTROL_SCHEMA_VERSION, StateStore } from "../control-plane/lib/state-store.mjs";
import { ControlRouter } from "../control-plane/router.mjs";

const tempBase = fileURLToPath(new URL("../control-plane/runtime", import.meta.url));
mkdirSync(tempBase, { recursive: true });
const AUTHORITY = "DESKTOP-3I1EVHE";

function runtime({ paymentSignals = [] } = {}) {
  const root = mkdtempSync(join(tempBase, "oa-exec-"));
  const state = new StateStore({ dbPath: join(root, "control.db") });
  const caps = new CapabilityRegistry([]);
  state.upsertNode({ nodeId: AUTHORITY, authority: true });
  const device = state.upsertDevice({
    alias: "01",
    physicalLabel: "rack-01",
    nodeId: AUTHORITY,
    runtimeId: "private-01",
    routingProfile: { enabled: true, tags: ["slot:01"], capabilityIds: [] },
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
    adapters: new AdapterRegistry([]),
    authorityNodeId: AUTHORITY,
    observeProvider: createFakeObserveProvider({ fixture: { paymentSignals, pageKey: paymentSignals[0] || "feed.home" } }),
  });
  const router = new ControlRouter({ control, state, capabilities: caps, evidence });
  return { root, state, device, control, router };
}

function auth(token) {
  return { "x-control-token": token };
}

async function openObserved(f) {
  const created = f.control.createDeviceSession({ actorId: "agent-exec", deviceId: f.device.deviceId });
  const observed = await f.control.observeDeviceSession(created.session.sessionId, created.token, {});
  return { created, observed };
}

test("fresh databases land on schema 17 with action table", () => {
  const f = runtime();
  try {
    assert.equal(f.state.db.prepare("PRAGMA user_version").get().user_version, CURRENT_CONTROL_SCHEMA_VERSION);
    assert.ok(f.state.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='device_session_actions'").get());
  } finally {
    f.state.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("HTTP createDeviceSession ignores faultAfter in the body", async () => {
  const f = runtime();
  try {
    const created = await f.router.handle({
      method: "POST",
      path: "/control/v1/device-sessions",
      body: { actorId: "agent-exec", deviceId: f.device.deviceId, faultAfter: "createdEvent" },
    });
    assert.equal(created.status, 201);
    assert.ok(created.body.token);
    assert.equal(f.state.db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n, 1);
  } finally {
    f.state.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("nonpayment tap executes as a fixture and increments mutatingCalls", async () => {
  const f = runtime({ paymentSignals: [] });
  try {
    const { created, observed } = await openObserved(f);
    const acted = await f.router.handle({
      method: "POST",
      path: `/control/v1/device-sessions/${created.session.sessionId}/actions`,
      headers: auth(created.token),
      body: {
        kind: "tap",
        actionId: "a1",
        idempotencyKey: "tap-1",
        basedOnObservationId: observed.observation.observationId,
        target: { normalizedCoordinate: { x: 0.5, y: 0.5 } },
      },
    });
    assert.equal(acted.status, 200);
    assert.equal(acted.body.result.ok, true);
    assert.equal(acted.body.result.errorCode, null);
    assert.equal(acted.body.mutatingCalls, 1);
    assert.equal(acted.body.result.effect.category, "nonpayment");
    assert.ok(acted.body.result.afterObservationId);
    assert.notEqual(acted.body.result.afterObservationId, observed.observation.observationId);
  } finally {
    f.state.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("payment categories refuse to execute and do not increment mutatingCalls", async () => {
  for (const [signals, errorCode, nextAction] of [
    [["credential_pin_pad"], "PAYMENT_CREDENTIAL_HOLD", "HUMAN"],
    [["final_confirm_pay"], "PAYMENT_FINAL_COMMIT_REQUIRED", "HUMAN"],
    [["pay_ambiguous_button"], "PAYMENT_CONTEXT_UNCERTAIN", "REOBSERVE"],
  ]) {
    const f = runtime({ paymentSignals: signals });
    try {
      const { created, observed } = await openObserved(f);
      const acted = await f.router.handle({
        method: "POST",
        path: `/control/v1/device-sessions/${created.session.sessionId}/actions`,
        headers: auth(created.token),
        body: {
          kind: "tap",
          actionId: "pay-1",
          idempotencyKey: `pay-${errorCode}`,
          basedOnObservationId: observed.observation.observationId,
          target: { normalizedCoordinate: { x: 0.4, y: 0.8 } },
        },
      });
      assert.equal(acted.body.result.ok, false, errorCode);
      assert.equal(acted.body.result.errorCode, errorCode);
      assert.equal(acted.body.result.nextAction, nextAction);
      assert.equal(acted.body.mutatingCalls, 0);
      assert.equal(acted.body.result.afterObservationId, null);
    } finally {
      f.state.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test("unknown observation id is stale and raw_adb is not public", async () => {
  const f = runtime();
  try {
    const created = f.control.createDeviceSession({ actorId: "agent-exec", deviceId: f.device.deviceId });
    await assert.rejects(
      () => f.control.executeDeviceSessionAction(created.session.sessionId, created.token, {
        kind: "tap",
        actionId: "a1",
        idempotencyKey: "stale",
        basedOnObservationId: "obs_missing",
        target: { normalizedCoordinate: { x: 0.1, y: 0.1 } },
      }),
      { code: "STALE_OBSERVATION" },
    );
    await assert.rejects(
      () => f.control.executeDeviceSessionAction(created.session.sessionId, created.token, { kind: "raw_adb" }),
      { code: "PRIMITIVE_NOT_SUPPORTED" },
    );
    await assert.rejects(
      () => f.control.executeDeviceSessionAction(created.session.sessionId, created.token, { kind: "observe" }),
      { code: "PRIMITIVE_NOT_SUPPORTED" },
    );
  } finally {
    f.state.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("actions require header token and reuse the same idempotency key", async () => {
  const f = runtime();
  try {
    const { created, observed } = await openObserved(f);
    const body = {
      kind: "tap",
      actionId: "a1",
      idempotencyKey: "same-tap",
      basedOnObservationId: observed.observation.observationId,
      target: { normalizedCoordinate: { x: 0.2, y: 0.3 } },
    };
    await assert.rejects(
      () => f.router.handle({
        method: "POST",
        path: `/control/v1/device-sessions/${created.session.sessionId}/actions`,
        headers: {},
        body: { ...body, token: created.token },
      }),
      { code: "SESSION_TOKEN_INVALID", status: 403 },
    );
    const first = await f.router.handle({
      method: "POST",
      path: `/control/v1/device-sessions/${created.session.sessionId}/actions`,
      headers: auth(created.token),
      body,
    });
    const replay = await f.router.handle({
      method: "POST",
      path: `/control/v1/device-sessions/${created.session.sessionId}/actions`,
      headers: auth(created.token),
      body,
    });
    assert.equal(first.body.reused, false);
    assert.equal(replay.body.reused, true);
    assert.equal(replay.body.result.actionId, first.body.result.actionId);
    assert.equal(f.state.countDeviceSessionMutations(created.session.sessionId), 1);
    await assert.rejects(
      () => f.router.handle({
        method: "POST",
        path: `/control/v1/device-sessions/${created.session.sessionId}/actions`,
        headers: auth(created.token),
        body: { ...body, target: { normalizedCoordinate: { x: 0.9, y: 0.9 } } },
      }),
      { code: "PRIMITIVE_IDEMPOTENCY_CONFLICT" },
    );
  } finally {
    f.state.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
