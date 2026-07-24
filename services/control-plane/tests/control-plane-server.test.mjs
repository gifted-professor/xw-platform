import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { assertPinnedNodeVersion } from "../control-plane/bootstrap.mjs";
import { CapabilityRegistry } from "../control-plane/lib/capability-registry.mjs";
import { AdapterRegistry, ControlPlane } from "../control-plane/lib/control-plane.mjs";
import { EvidenceStore } from "../control-plane/lib/evidence-store.mjs";
import { StateStore } from "../control-plane/lib/state-store.mjs";
import { ControlRouter } from "../control-plane/router.mjs";
import { createControlServer } from "../control-plane/server.mjs";

const tempBase = fileURLToPath(new URL("../control-plane/runtime", import.meta.url));
mkdirSync(tempBase, { recursive: true });

const capability = {
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
  verification: { mode: "state", description: "test" },
  restoration: { required: false, description: "none" },
  timeoutMs: 1000,
  idempotency: "read_only",
  automationPolicy: { mode: "automatic" },
  implementation: { adapter: "test", action: "observe" },
  evidence: [],
};

test("HTTP API is loopback-oriented, emits no CORS header, and redacts runtime IDs", async () => {
  const root = mkdtempSync(join(tempBase, "server-test-"));
  const state = new StateStore({ dbPath: join(root, "control.db") });
  const registry = new CapabilityRegistry([capability]);
  const device = state.upsertDevice({
    alias: "01",
    physicalLabel: "rack-01",
    nodeId: "DESKTOP-3I1EVHE",
    runtimeId: "never-expose",
    routingProfile: { enabled: true, capabilityIds: ["test.observe"] },
  });
  const evidence = new EvidenceStore({
    runsRoot: join(root, "runs"),
    state,
    minFreeBytes: 0,
    minExternalEffectFreeBytes: 0,
  });
  const control = new ControlPlane({
    state,
    capabilities: registry,
    adapters: new AdapterRegistry([{
      id: "test",
      async execute() { return {}; },
      async verify() { return { ok: true }; },
      async restore() { return { ok: true }; },
    }]),
    evidence,
  });
  const router = new ControlRouter({ control, state, capabilities: registry, evidence });
  const server = createControlServer({ router });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port, address } = server.address();
    assert.equal(address, "127.0.0.1");
    const response = await fetch(`http://127.0.0.1:${port}/control/v1/devices`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    const body = await response.json();
    assert.equal(body.devices[0].deviceId, device.deviceId);
    assert.doesNotMatch(JSON.stringify(body), /never-expose|runtimeId/);

    const nodesResponse = await fetch(`http://127.0.0.1:${port}/control/v1/nodes`);
    assert.equal(nodesResponse.status, 200);
    const nodes = await nodesResponse.json();
    assert.equal(nodes.nodes[0].nodeId, "DESKTOP-3I1EVHE");
    assert.equal(nodes.nodes[0].readyDevices, 1);
    assert.doesNotMatch(JSON.stringify(nodes), /never-expose|runtimeId|routingProfile/);

    const beforeJobs = state.db.prepare("SELECT COUNT(*) AS count FROM jobs").get().count;
    const planResponse = await fetch(`http://127.0.0.1:${port}/control/v1/routes/plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actorId: "agent-a",
        capabilityId: "test.observe",
      }),
    });
    assert.equal(planResponse.status, 200);
    const plan = await planResponse.json();
    assert.equal(plan.route.decision, "dispatchable");
    assert.equal(plan.route.selectedDeviceId, device.deviceId);
    assert.equal(state.db.prepare("SELECT COUNT(*) AS count FROM jobs").get().count, beforeJobs);

    const submitResponse = await fetch(`http://127.0.0.1:${port}/control/v1/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actorId: "agent-a",
        capabilityId: "test.observe",
        idempotencyKey: "api-auto-route",
      }),
    });
    assert.equal(submitResponse.status, 202);
    const submitted = await submitResponse.json();
    assert.equal(submitted.job.routeDecision.selectedDeviceId, device.deviceId);
    assert.match(submitted.storage.manifestPath, /manifest\.json$/);
    assert.doesNotMatch(JSON.stringify(submitted), /never-expose|runtimeId|routingProfile/);

    const invalid = await fetch(`http://127.0.0.1:${port}/control/v1/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error.code, "INVALID_JSON");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await control.stop();
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("production startup pins the verified Windows Node version", () => {
  assert.equal(assertPinnedNodeVersion({
    expected: "24.11.1",
    actual: "24.11.1",
  }), "24.11.1");
  assert.throws(() => assertPinnedNodeVersion({
    expected: "24.11.1",
    actual: "24.12.0",
  }), { code: "NODE_VERSION_MISMATCH" });
});
