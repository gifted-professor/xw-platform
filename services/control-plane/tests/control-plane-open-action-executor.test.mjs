import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CapabilityRegistry } from "../control-plane/lib/capability-registry.mjs";
import { AdapterRegistry, ControlPlane } from "../control-plane/lib/control-plane.mjs";
import { EvidenceStore } from "../control-plane/lib/evidence-store.mjs";
import { validateJsonSchema } from "../control-plane/lib/json-schema-validator.mjs";
import { createFakeObserveProvider } from "../control-plane/lib/open-action-session.mjs";
import { CURRENT_CONTROL_SCHEMA_VERSION, StateStore } from "../control-plane/lib/state-store.mjs";
import { ControlRouter } from "../control-plane/router.mjs";

const tempBase = fileURLToPath(new URL("../control-plane/runtime", import.meta.url));
const ACTION_RESULT_SCHEMA = JSON.parse(readFileSync(new URL(
  "../../../packages/kernel/contracts/open-action/action-result.v1.schema.json",
  import.meta.url,
), "utf8"));
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

function tapAction(overrides = {}) {
  return {
    schemaId: "xw.open-action.primitive.v1",
    schemaVersion: 1,
    kind: "tap",
    actionId: "a1",
    idempotencyKey: "tap-1",
    target: { normalizedCoordinate: { x: 0.5, y: 0.5 } },
    ...overrides,
  };
}

function actionRequest(actionOverrides = {}, claimed = null) {
  return {
    schemaId: "xw.open-action.action-request.v1",
    schemaVersion: 1,
    action: tapAction(actionOverrides),
    agentClaimedCategory: claimed,
  };
}

function assertResultSchema(result) {
  const errors = validateJsonSchema(result, ACTION_RESULT_SCHEMA);
  assert.deepEqual(errors, [], JSON.stringify(errors));
}

async function openObserved(f) {
  const created = f.control.createDeviceSession({ actorId: "agent-exec", deviceId: f.device.deviceId });
  const observed = await f.control.observeDeviceSession(created.session.sessionId, created.token, {});
  return { created, observed };
}

async function postAction(f, created, body) {
  return f.router.handle({
    method: "POST",
    path: `/control/v1/device-sessions/${created.session.sessionId}/actions`,
    headers: auth(created.token),
    body,
  });
}

test("fresh databases land on schema 18 with action ledger", () => {
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
    const acted = await postAction(f, created, actionRequest({
      basedOnObservationId: observed.observation.observationId,
    }));
    assert.equal(acted.status, 200);
    assert.equal(acted.body.result.ok, true);
    assert.equal(acted.body.result.errorCode, null);
    assert.equal(acted.body.mutatingCalls, 1);
    assert.equal(acted.body.result.effect.category, "nonpayment");
    assert.ok(acted.body.result.afterObservationId);
    assert.notEqual(acted.body.result.afterObservationId, observed.observation.observationId);
    assertResultSchema(acted.body.result);
  } finally {
    f.state.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("payment categories refuse to execute and do not increment mutatingCalls", async () => {
  for (const [signals, errorCode, nextAction, retryable] of [
    [["credential_pin_pad"], "PAYMENT_CREDENTIAL_HOLD", "HUMAN", false],
    [["final_confirm_pay"], "PAYMENT_FINAL_COMMIT_REQUIRED", "HUMAN", false],
    [["pay_ambiguous_button"], "PAYMENT_CONTEXT_UNCERTAIN", "REOBSERVE", true],
  ]) {
    const f = runtime({ paymentSignals: signals });
    try {
      const { created, observed } = await openObserved(f);
      const acted = await postAction(f, created, actionRequest({
        actionId: "pay-1",
        idempotencyKey: `pay-${errorCode}`,
        basedOnObservationId: observed.observation.observationId,
        target: { normalizedCoordinate: { x: 0.4, y: 0.8 } },
      }));
      assert.equal(acted.body.result.ok, false, errorCode);
      assert.equal(acted.body.result.errorCode, errorCode);
      assert.equal(acted.body.result.nextAction, nextAction);
      assert.equal(acted.body.result.retryable, retryable, errorCode);
      assert.equal(acted.body.mutatingCalls, 0);
      assert.equal(acted.body.result.afterObservationId, null);
      assertResultSchema(acted.body.result);
    } finally {
      f.state.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test("unknown fields and missing schema ids are INVALID_ACTION", async () => {
  const f = runtime();
  try {
    const { created, observed } = await openObserved(f);
    const basedOnObservationId = observed.observation.observationId;
    for (const [label, body] of [
      ["faultAfter", { ...actionRequest({ basedOnObservationId }), faultAfter: "createdEvent" }],
      ["token", { ...actionRequest({ basedOnObservationId }), token: created.token }],
      ["debug", { ...actionRequest({ basedOnObservationId }), debug: true }],
      ["missing request schemaId", {
        schemaVersion: 1,
        action: tapAction({ basedOnObservationId }),
      }],
      ["missing primitive schemaId", {
        schemaId: "xw.open-action.action-request.v1",
        schemaVersion: 1,
        action: {
          kind: "tap",
          actionId: "a1",
          idempotencyKey: "no-schema",
          basedOnObservationId,
          target: { normalizedCoordinate: { x: 0.1, y: 0.1 } },
        },
      }],
      ["tap without target", actionRequest({
        basedOnObservationId,
        target: undefined,
      })],
    ]) {
      await assert.rejects(
        () => f.control.executeDeviceSessionAction(created.session.sessionId, created.token, body),
        { code: "INVALID_ACTION" },
        label,
      );
    }
  } finally {
    f.state.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("unsupported primitives stay PRIMITIVE_NOT_SUPPORTED", async () => {
  const f = runtime();
  try {
    const { created, observed } = await openObserved(f);
    const basedOnObservationId = observed.observation.observationId;
    for (const kind of ["type_text", "wait", "long_press", "raw_adb", "observe"]) {
      await assert.rejects(
        () => f.control.executeDeviceSessionAction(created.session.sessionId, created.token, {
          schemaId: "xw.open-action.action-request.v1",
          schemaVersion: 1,
          action: {
            schemaId: "xw.open-action.primitive.v1",
            schemaVersion: 1,
            kind,
            actionId: "x1",
            idempotencyKey: `kind-${kind}`,
            basedOnObservationId,
            text: kind === "type_text" ? "hi" : undefined,
            durationMs: kind === "wait" ? 10 : undefined,
            target: { normalizedCoordinate: { x: 0.1, y: 0.1 } },
          },
        }),
        { code: "PRIMITIVE_NOT_SUPPORTED" },
        kind,
      );
    }
  } finally {
    f.state.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("unknown payment signal is fail-closed and agent claim cannot override", async () => {
  const unknown = runtime({ paymentSignals: ["final_confirm_payment"] });
  try {
    const { created, observed } = await openObserved(unknown);
    const acted = await postAction(unknown, created, actionRequest({
      idempotencyKey: "unknown-signal",
      basedOnObservationId: observed.observation.observationId,
    }));
    assert.equal(acted.body.result.ok, false);
    assert.equal(acted.body.result.errorCode, "PAYMENT_CONTEXT_UNCERTAIN");
    assert.equal(acted.body.result.retryable, true);
    assert.equal(acted.body.result.nextAction, "REOBSERVE");
    assert.equal(acted.body.mutatingCalls, 0);
    assertResultSchema(acted.body.result);
  } finally {
    unknown.state.close();
    rmSync(unknown.root, { recursive: true, force: true });
  }

  const claimed = runtime({ paymentSignals: ["final_confirm_pay"] });
  try {
    const { created, observed } = await openObserved(claimed);
    const acted = await postAction(claimed, created, actionRequest({
      actionId: "claimed-1",
      idempotencyKey: "claimed-nonpayment",
      basedOnObservationId: observed.observation.observationId,
    }, "nonpayment"));
    assert.equal(acted.body.result.ok, false);
    assert.equal(acted.body.result.errorCode, "PAYMENT_FINAL_COMMIT_REQUIRED");
    assert.equal(acted.body.result.effect.category, "payment_final_commit");
    assert.equal(acted.body.result.effect.agentClaimedCategory, "nonpayment");
    assert.equal(acted.body.mutatingCalls, 0);
    assertResultSchema(acted.body.result);
  } finally {
    claimed.state.close();
    rmSync(claimed.root, { recursive: true, force: true });
  }
});

test("new actions require the latest observation; identical replay still reuses", async () => {
  const f = runtime();
  try {
    const { created, observed } = await openObserved(f);
    const firstObs = observed.observation.observationId;
    const second = await f.control.observeDeviceSession(created.session.sessionId, created.token, {});
    await assert.rejects(
      () => f.control.executeDeviceSessionAction(
        created.session.sessionId,
        created.token,
        actionRequest({ basedOnObservationId: firstObs, idempotencyKey: "stale-obs" }),
      ),
      (error) => {
        assert.equal(error.code, "STALE_OBSERVATION");
        assert.equal(error.details.nextAction, "REOBSERVE");
        return true;
      },
    );
    await assert.rejects(
      () => f.control.executeDeviceSessionAction(
        created.session.sessionId,
        created.token,
        actionRequest({ basedOnObservationId: "obs_missing", idempotencyKey: "missing-obs" }),
      ),
      { code: "STALE_OBSERVATION" },
    );

    const body = actionRequest({
      basedOnObservationId: second.observation.observationId,
      idempotencyKey: "same-tap",
      target: { normalizedCoordinate: { x: 0.2, y: 0.3 } },
    });
    const first = await postAction(f, created, body);
    const replay = await postAction(f, created, body);
    assert.equal(first.body.reused, false);
    assert.equal(replay.body.reused, true);
    assert.equal(replay.body.result.actionId, first.body.result.actionId);
    assert.equal(f.state.countDeviceSessionMutations(created.session.sessionId), 1);
    assertResultSchema(first.body.result);
    assert.notEqual(first.body.result.afterObservationId, second.observation.observationId);
    await assert.rejects(
      () => postAction(f, created, actionRequest({
        basedOnObservationId: second.observation.observationId,
        idempotencyKey: "same-tap",
        target: { normalizedCoordinate: { x: 0.9, y: 0.9 } },
      })),
      { code: "PRIMITIVE_IDEMPOTENCY_CONFLICT" },
    );
  } finally {
    f.state.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("durable reserve records ledger status and refuses a second in-flight action", async () => {
  const f = runtime();
  try {
    const { created, observed } = await openObserved(f);
    const acted = await postAction(f, created, actionRequest({
      basedOnObservationId: observed.observation.observationId,
    }));
    assert.equal(acted.body.ledger.status, "COMPLETED");
    assert.equal(acted.body.ledger.transportCalled, false);
    assert.equal(acted.body.ledger.executionMode, "fixture");
    const reserved = f.state.getDeviceSessionAction(created.session.sessionId, "tap-1");
    assert.equal(reserved.status, "COMPLETED");
    f.state.updateDeviceSessionAction(created.session.sessionId, "tap-1", { status: "EXECUTING" });
    await assert.rejects(
      () => postAction(f, created, actionRequest({
        actionId: "a2",
        idempotencyKey: "other-tap",
        basedOnObservationId: acted.body.result.afterObservationId,
      })),
      { code: "ACTION_IN_FLIGHT" },
    );
    assert.throws(
      () => f.control.releaseDeviceSession(created.session.sessionId, created.token),
      { code: "SESSION_ACTION_RUNNING" },
    );
  } finally {
    f.state.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("control-plane restart marks executing actions ambiguous and refuses blind retry", async () => {
  const first = runtime();
  const dbPath = join(first.root, "control.db");
  try {
    const { created, observed } = await openObserved(first);
    await postAction(first, created, actionRequest({
      basedOnObservationId: observed.observation.observationId,
      idempotencyKey: "restart-tap",
    }));
    first.state.updateDeviceSessionAction(created.session.sessionId, "restart-tap", { status: "EXECUTING" });
    first.state.close();
    const restarted = new StateStore({ dbPath });
    try {
      const row = restarted.getDeviceSessionAction(created.session.sessionId, "restart-tap");
      assert.equal(row.status, "AMBIGUOUS");
      assert.equal(row.errorCode, "CONTROL_PLANE_RESTART");
    } finally {
      restarted.close();
    }
  } finally {
    rmSync(first.root, { recursive: true, force: true });
  }
});

test("successful fixture tap emits requested assessed executed verified events", async () => {
  const f = runtime();
  try {
    const { created, observed } = await openObserved(f);
    await postAction(f, created, actionRequest({
      basedOnObservationId: observed.observation.observationId,
    }));
    const types = f.state.listDeviceSessionEvents(created.session.sessionId).map((event) => event.type);
    for (const name of ["primitive.requested", "effect.assessed", "primitive.executed", "observation.after_captured", "primitive.verified"]) {
      assert.ok(types.includes(name), name);
    }
  } finally {
    f.state.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("actions require header token; body token is not a credential", async () => {
  const f = runtime();
  try {
    const { created, observed } = await openObserved(f);
    const body = actionRequest({ basedOnObservationId: observed.observation.observationId });
    await assert.rejects(
      () => f.router.handle({
        method: "POST",
        path: `/control/v1/device-sessions/${created.session.sessionId}/actions`,
        headers: {},
        body: { ...body, token: created.token },
      }),
      { code: "SESSION_TOKEN_INVALID", status: 403 },
    );
  } finally {
    f.state.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
