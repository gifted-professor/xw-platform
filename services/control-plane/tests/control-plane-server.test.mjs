import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await control.stop();
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});
