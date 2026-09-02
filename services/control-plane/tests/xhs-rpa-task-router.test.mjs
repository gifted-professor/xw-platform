import assert from "node:assert/strict";
import test from "node:test";

import { ControlRouter } from "../control-plane/router.mjs";
import { ControlPlaneError } from "../control-plane/lib/errors.mjs";

const TOKEN = "gate-f-operations-token-that-is-long-enough";
const PROGRAM_ID = "xrp_explore_foundation";

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function exact(value, keys) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && Object.keys(value).every((key) => keys.includes(key)));
}

function fixture() {
  const calls = { health: 0, plan: 0, status: 0, disable: 0, manual: 0 };
  const rpa = {
    health() {
      calls.health += 1;
      return { status: "READY_DISABLED", RPA_RECURRING_ENABLED: false };
    },
    async plan(input) {
      if (!exact(input, ["programId"])) fail("XHS_RPA_PLAN_INPUT_INVALID");
      calls.plan += 1;
      return { programId: input.programId, ioOperations: 0 };
    },
    async status(input) {
      if (!exact(input, ["programId"])) fail("XHS_RPA_STATUS_INPUT_INVALID");
      calls.status += 1;
      return { programId: input.programId, recurringEnabled: false };
    },
    async disable(input) {
      if (!exact(input, ["programId", "generation"])) fail("XHS_RPA_DISABLE_INPUT_INVALID");
      calls.disable += 1;
      return {
        programId: input.programId,
        generation: input.generation + 1,
        enabled: false,
        recurringEnabled: false,
        activeTicks: 0,
        disabledAtMs: 1_800_000_000_000,
      };
    },
    async manualOnce(input) {
      if (!exact(input, ["programId", "generation", "idempotencyKey"])) {
        fail("XHS_RPA_MANUAL_INPUT_INVALID");
      }
      calls.manual += 1;
      return { result: { status: "SUCCEEDED" }, recurringEnabled: false };
    },
  };
  const gate = {
    assertAuthorized(headers = {}) {
      if (headers["x-m6-gate-f-operations-token"] !== TOKEN) {
        throw new ControlPlaneError("M6_GATE_F_OPERATIONS_UNAUTHORIZED", "invalid token", { status: 403 });
      }
    },
  };
  return {
    calls,
    router: new ControlRouter({
      control: {}, state: {}, capabilities: {}, evidence: {},
      m6GateFOperations: gate,
      xhsRpaTaskBootstrap: rpa,
      xhsV3FixedOperatorAuthorization: { assertAuthorized() { return true; } },
    }),
  };
}

function post(router, route, body, headers = { "x-m6-gate-f-operations-token": TOKEN }) {
  return router.handle({ method: "POST", path: `/control/v1/internal/xhs/rpa/${route}`, body, headers });
}

test("formal RPA routes are Gate-F-token-owned and manual-once only", async () => {
  const f = fixture();
  await assert.rejects(
    () => post(f.router, "manual-once", {
      programId: PROGRAM_ID, generation: 1, idempotencyKey: "manual:opaque:12345678",
    }, {}),
    (error) => error.code === "M6_GATE_F_OPERATIONS_UNAUTHORIZED",
  );
  assert.equal(f.calls.manual, 0);

  const health = await f.router.handle({
    method: "GET",
    path: "/control/v1/internal/xhs/rpa/health",
    headers: { "x-m6-gate-f-operations-token": TOKEN },
  });
  assert.equal(health.body.rpa.RPA_RECURRING_ENABLED, false);
  assert.equal((await post(f.router, "plan", { programId: PROGRAM_ID })).body.plan.ioOperations, 0);
  assert.equal((await post(f.router, "status", { programId: PROGRAM_ID })).body.rpa.recurringEnabled, false);
  assert.equal((await post(f.router, "manual-once", {
    programId: PROGRAM_ID,
    generation: 1,
    idempotencyKey: "manual:opaque:12345678",
  })).body.rpa.result.status, "SUCCEEDED");
  const disabled = (await post(f.router, "disable", { programId: PROGRAM_ID, generation: 1 })).body.rpa;
  assert.equal(disabled.generation, 2);
  assert.equal(disabled.recurringEnabled, false);
  assert.equal(disabled.activeTicks, 0);
  assert.deepEqual(f.calls, { health: 1, plan: 1, status: 1, disable: 1, manual: 1 });
});

test("caller goal/path/endpoint/alias/provider/role/E/recurring fields reject before RPA work", async () => {
  const f = fixture();
  for (const field of [
    "goal", "query", "path", "endpoint", "alias", "provider", "role",
    "eCorpus", "taskName", "recurring", "schedule",
  ]) {
    await assert.rejects(
      () => post(f.router, "manual-once", {
        programId: PROGRAM_ID,
        generation: 1,
        idempotencyKey: "manual:opaque:12345678",
        [field]: "caller",
      }),
      (error) => error.code === "XHS_RPA_MANUAL_INPUT_INVALID",
    );
  }
  assert.equal(f.calls.manual, 0);
});

test("RPA namespace is absent without both task bootstrap and Gate-F authority", async () => {
  const router = new ControlRouter({ control: {}, state: {}, capabilities: {}, evidence: {} });
  await assert.rejects(
    () => post(router, "manual-once", {
      programId: PROGRAM_ID, generation: 1, idempotencyKey: "manual:opaque:12345678",
    }),
    (error) => error.code === "XHS_RPA_TASK_BOOTSTRAP_UNAVAILABLE" && error.status === 503,
  );
});
