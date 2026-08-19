import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { main as xwMain, redact } from "../../../packages/cli/xw.mjs";
import { ControlClient } from "../../../packages/control-client/lib/control-client.mjs";
import { createFaultBackend, createFixtureBackend, createRecordedBackend } from "../../../packages/replay/lib/replay.mjs";
import { AgentGateway } from "../../../packages/agent-gateway/lib/agent-gateway.mjs";
import { CapabilityRegistry } from "../control-plane/lib/capability-registry.mjs";
import { AdapterRegistry, ControlPlane } from "../control-plane/lib/control-plane.mjs";
import { EvidenceStore } from "../control-plane/lib/evidence-store.mjs";
import { StateStore } from "../control-plane/lib/state-store.mjs";
import { ControlRouter } from "../control-plane/router.mjs";

const tempBase = fileURLToPath(new URL("../control-plane/runtime", import.meta.url));
mkdirSync(tempBase, { recursive: true });
const AUTHORITY = "DESKTOP-3I1EVHE";

function runtime(observeProvider) {
  const root = mkdtempSync(join(tempBase, "m3eh-"));
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
    observeProvider,
  });
  const router = new ControlRouter({ control, state, capabilities: caps, evidence });
  return { root, state, device, control, router };
}

function routerFetch(router) {
  return async (url, init = {}) => {
    const parsed = new URL(url, "http://cp.local");
    try {
      const result = await router.handle({
        method: init.method || "GET",
        path: parsed.pathname,
        query: parsed.searchParams,
        body: init.body ? JSON.parse(init.body) : undefined,
        headers: init.headers || {},
      });
      return { ok: result.status < 400, status: result.status, async text() { return JSON.stringify(result.body); } };
    } catch (error) {
      return {
        ok: false,
        status: error.status || 500,
        async text() {
          return JSON.stringify({ error: { code: error.code, message: error.message, details: error.details } });
        },
      };
    }
  };
}

function tapRequest(observationId, key = "tap-1") {
  return {
    schemaId: "xw.open-action.action-request.v1",
    schemaVersion: 1,
    action: {
      schemaId: "xw.open-action.primitive.v1",
      schemaVersion: 1,
      kind: "tap",
      actionId: "a1",
      idempotencyKey: key,
      basedOnObservationId: observationId,
      target: { normalizedCoordinate: { x: 0.5, y: 0.5 } },
    },
    agentClaimedCategory: null,
  };
}

test("replay backends stay fixture-only and never claim live transport", () => {
  const fixture = createFixtureBackend();
  const recorded = createRecordedBackend({ observations: [{ observationId: "obs-rec", sessionId: "s", deviceId: "d" }] });
  const fault = createFaultBackend({ faultAfter: "observe" });
  assert.equal(fixture.transportCalled, false);
  assert.equal(recorded.transportCalled, false);
  assert.equal(fault.liveCanaryGate, "CLOSED");
});

test("gateway observe-act-verify uses control-client and never opens control.db", async () => {
  const backend = createFixtureBackend({ fixture: { paymentSignals: [] } });
  const f = runtime(backend.observeProvider);
  try {
    const gateway = new AgentGateway({
      controlBaseUrl: "http://cp.local",
      fetchImpl: routerFetch(f.router),
    });
    assert.equal(gateway.invariants.readsControlDb, false);
    assert.equal(gateway.invariants.decidesPayment, false);
    const attached = await gateway.attach({ actorId: "agent-gateway", deviceId: f.device.deviceId });
    const observed = await gateway.observe(attached.harnessSessionId);
    const acted = await gateway.act(attached.harnessSessionId, tapRequest(observed.observation.observationId));
    assert.equal(acted.result.ok, true);
    assert.equal(acted.ledger.transportCalled, false);
    const verified = await gateway.verify(attached.harnessSessionId);
    assert.equal(verified.ok, true);
    const trace = await gateway.trace(attached.harnessSessionId);
    assert.ok(trace.events.some((event) => event.type === "primitive.verified"));
    await gateway.release(attached.harnessSessionId);
  } finally {
    f.state.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("control-client surfaces stale observation and unknown payment without executing", async () => {
  const backend = createFixtureBackend({ fixture: { paymentSignals: ["final_confirm_payment"] } });
  const f = runtime(backend.observeProvider);
  try {
    const client = new ControlClient({ baseUrl: "http://cp.local", fetchImpl: routerFetch(f.router) });
    const created = await client.createDeviceSession({ actorId: "agent-cc", deviceId: f.device.deviceId });
    const observed = await client.observe(created.session.sessionId, created.token);
    const held = await client.act(created.session.sessionId, created.token, tapRequest(observed.observation.observationId, "hold-1"));
    assert.equal(held.result.ok, false);
    assert.equal(held.result.errorCode, "PAYMENT_CONTEXT_UNCERTAIN");
    await assert.rejects(
      () => client.act(created.session.sessionId, created.token, tapRequest("obs_old", "stale-1")),
      { code: "STALE_OBSERVATION" },
    );
  } finally {
    f.state.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("xw phone CLI redacts tokens and can attach through control-client", async () => {
  const backend = createFixtureBackend();
  const f = runtime(backend.observeProvider);
  const ctx = join(f.root, "ctx.json");
  try {
    const fetchImpl = routerFetch(f.router);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    process.env.XW_CONTROL_TOKEN = "secret-token-value";
    process.env.XW_CONTROL_URL = "http://cp.local";
    const code = await xwMain(["phone", "attach", "--actor", "agent-cli", "--device", f.device.deviceId, "--context-file", ctx, "--json"]);
    assert.equal(code, 0);
    const saved = JSON.parse(readFileSync(ctx, "utf8"));
    assert.ok(saved.sessionId);
    assert.ok(saved.token);
    const preview = redact({ token: saved.token, nested: { authorization: "abc" } });
    assert.equal(preview.token, "[redacted]");
    assert.equal(preview.nested.authorization, "[redacted]");
    globalThis.fetch = originalFetch;
  } finally {
    delete process.env.XW_CONTROL_TOKEN;
    delete process.env.XW_CONTROL_URL;
    f.state.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
