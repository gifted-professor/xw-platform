import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createExplorerRoutineRuntime } from "../ops/_xhs-routine-explorer-runtime.mjs";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("Explorer runtime maps one exact 03 binding onto formal CP session/action/release APIs", async (t) => {
  const contextRoot = mkdtempSync(join(tmpdir(), "xhs-routine-context-"));
  t.after(() => rmSync(contextRoot, { recursive: true, force: true }));
  const controlBase = "http://127.0.0.1:19020";
  const registryBase = "http://127.0.0.1:19030";
  const actorId = "agent:xhs-routine";
  const sessionId = "session-03";
  const leaseId = "lease-03";
  const deviceId = "device-03";
  const token = "private-session-token";
  let leases = [];
  const calls = [];

  const entry = () => ({
    devices: [{
      alias: "03",
      serial: "private-serial",
      deviceId,
      control: { deviceId },
      state: { online: true, ready: true, quarantined: false, leaseFree: leases.length === 0 },
      metadata: { width: 1080, height: 2400 },
    }],
  });
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ origin: parsed.origin, path: parsed.pathname, method, body });
    if (parsed.origin === registryBase && parsed.pathname === "/api/agent-entry") return json(entry());
    if (parsed.origin !== controlBase) return json({ error: { code: "UNEXPECTED_ORIGIN" } }, 500);
    if (method === "POST" && parsed.pathname === "/control/v1/sessions") {
      assert.deepEqual(body, {
        actorId,
        capabilityId: "xiaowei.explorer.primitive",
        canary: true,
        placement: { alias: "03" },
      });
      leases = [{ leaseId, sessionId, deviceId, kind: "interactive", holderId: actorId }];
      return json({
        session: {
          sessionId,
          leaseId,
          token,
          deviceId,
          actorId,
          scopeCapabilityId: "xiaowei.explorer.primitive",
          canary: true,
          routeDecision: { selectedDevice: { alias: "03", deviceId } },
        },
      }, 201);
    }
    if (method === "GET" && parsed.pathname === "/control/v1/leases") return json({ leases });
    if (method === "POST" && parsed.pathname === `/control/v1/sessions/${sessionId}/heartbeat`) {
      assert.equal(body.token, token);
      return json({
        session: {
          sessionId,
          leaseId,
          deviceId,
          actorId,
          scopeCapabilityId: "xiaowei.explorer.primitive",
          canary: true,
          routeDecision: { selectedDevice: { alias: "03", deviceId } },
        },
      });
    }
    if (method === "POST" && parsed.pathname === `/control/v1/sessions/${sessionId}/actions`) {
      assert.equal(body.token, token);
      assert.equal(body.params.primitive, "focus");
      return json({
        job: {
          jobId: "job-focus",
          runId: "run-focus",
          status: "succeeded",
          result: { output: { ok: true, package: "com.xingin.xhs", activity: "IndexActivityV2" } },
        },
      });
    }
    if (method === "POST" && parsed.pathname === `/control/v1/sessions/${sessionId}/release`) {
      assert.equal(body.token, token);
      leases = [];
      return json({ released: true });
    }
    return json({ error: { code: "UNEXPECTED_ROUTE", message: `${method} ${parsed.pathname}` } }, 500);
  };

  const runtime = createExplorerRoutineRuntime({
    controlBase,
    registryBase,
    fetchImpl,
    contextRoot,
    allowTestEndpoints: true,
    skipAclHardening: true,
  });
  const session = await runtime.createSession({
    actorId,
    capabilityId: "xiaowei.explorer.primitive",
    canary: true,
    placement: { alias: "03" },
  });
  assert.equal(session.routeDecision.selectedDevice.alias, "03");
  assert.equal(session.token, token);
  assert.equal(readdirSync(contextRoot).length, 1, "one private session context exists while the lease is active");
  const action = await runtime.executeSessionAction(sessionId, token, {
    idempotencyKey: "xhs-routine:test:1",
    params: { primitive: "focus" },
  });
  assert.equal(action.status, "succeeded");
  assert.equal(action.authorization.sessionId, sessionId);
  assert.equal((await runtime.listLeases()).length, 1);
  assert.equal((await runtime.getDevice(deviceId)).alias, "03");
  assert.equal((await runtime.releaseSession(sessionId, token)).released, true);
  assert.equal((await runtime.listLeases()).length, 0);
  assert.equal(calls.some((call) => call.path.endsWith("/actions")), true);
  assert.equal(calls.some((call) => call.path.endsWith("/release")), true);
  assert.equal(readdirSync(contextRoot).length, 0, "the private session context is removed after release");
});

test("production runtime rejects caller-selected loopback ports", () => {
  assert.throws(
    () => createExplorerRoutineRuntime({ controlBase: "http://127.0.0.1:19020" }),
    (error) => error.code === "ROUTINE_ENDPOINT_INVALID",
  );
});

// Regression (live S2 window 1, 2026-08-28): the register client dropped
// sessionId from the POST body; the CP router fed `undefined` into
// validateSession and the SQL bind failure surfaced as CONTROL_INTERNAL_ERROR.
test("authority registration sends the sessionId in the POST body", async (t) => {
  const contextRoot = mkdtempSync(join(tmpdir(), "xhs-routine-context-reg-"));
  t.after(() => rmSync(contextRoot, { recursive: true, force: true }));
  const controlBase = "http://127.0.0.1:19020";
  const registryBase = "http://127.0.0.1:19030";
  const sessionId = "session-03";
  const leaseId = "lease-03";
  const deviceId = "device-03";
  const token = "private-session-token";
  const entry = () => ({
    devices: [{
      alias: "03",
      serial: "private-serial",
      deviceId,
      control: { deviceId },
      state: { online: true, ready: true, quarantined: false, leaseFree: true },
      metadata: { width: 1080, height: 2400 },
    }],
  });
  let registerBody = null;
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    if (parsed.origin === registryBase && parsed.pathname === "/api/agent-entry") return json(entry());
    if (parsed.origin !== controlBase) return json({ error: { code: "UNEXPECTED_ORIGIN" } }, 500);
    if (method === "POST" && parsed.pathname === "/control/v1/sessions") {
      return json({
        session: {
          sessionId, leaseId, token, deviceId,
          actorId: "agent:xhs-routine",
          scopeCapabilityId: "xiaowei.explorer.primitive",
          canary: true,
          routeDecision: { selectedDevice: { alias: "03", deviceId } },
        },
      }, 201);
    }
    if (method === "POST" && parsed.pathname === "/control/v1/routine-authority") {
      registerBody = body;
      return json({ authority: { authorityId: "routine-auth-1", status: "active" } }, 201);
    }
    if (method === "GET" && parsed.pathname === "/control/v1/leases") {
      return json({ leases: [{ leaseId, sessionId, deviceId, kind: "interactive", holderId: "agent:xhs-routine" }] });
    }
    return json({ error: { code: "UNEXPECTED_ROUTE", message: `${method} ${parsed.pathname}` } }, 500);
  };
  const runtime = createExplorerRoutineRuntime({
    controlBase,
    registryBase,
    fetchImpl,
    contextRoot,
    allowTestEndpoints: true,
    skipAclHardening: true,
  });
  await runtime.createSession({
    actorId: "agent:xhs-routine",
    capabilityId: "xiaowei.explorer.primitive",
    canary: true,
    placement: { alias: "03" },
  });
  const authority = await runtime.registerRoutineAuthority({
    sessionId,
    token,
    executionRunId: "xe-reg-1",
    routineRunId: "rr-reg-1",
    planHash: "a".repeat(64),
    effectCaps: { like: 1, comment: 0 },
    canaryAuthorized: true,
    accountFingerprint: null,
  });
  assert.equal(authority.authorityId, "routine-auth-1");
  assert.ok(registerBody, "register must POST to /control/v1/routine-authority");
  assert.equal(registerBody.sessionId, sessionId, "sessionId must travel in the body: the CP router keys registration off it");
  assert.equal(registerBody.alias, "03");
  assert.equal(registerBody.token, token);
  assert.deepEqual(registerBody.effectCaps, { like: 1, comment: 0 });
});
