import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/explorer-hotpath/sequence.json", import.meta.url), "utf8"));

test("Explorer session acquires once and keeps ordinary primitives on the hot transport", async () => {
  const module = await import("../control-plane/lib/explorer-session-bridge.mjs").catch(() => null);
  assert.ok(module?.ExplorerSessionBridge, "RED: Explorer session bridge is not implemented");
  let acquireCount = 0;
  let preflightCount = 0;
  let transportCount = 0;
  let syncObservationCount = 0;
  const bridge = new module.ExplorerSessionBridge({
    acquire: async () => { acquireCount += 1; return { sessionId: "fixture-session", leaseId: "fixture-lease", token: "fixture-token" }; },
    preflight: async () => { preflightCount += 1; },
    transport: async () => { transportCount += 1; return { ok: true }; },
    observeForClassifier: async () => { syncObservationCount += 1; return {}; }
  });
  const session = await bridge.open(fixture.session);
  for (const primitive of fixture.primitives) await session.dispatchPrimitive(primitive);
  await session.close();
  assert.equal(acquireCount, fixture.expected.leaseAcquireCount);
  assert.equal(preflightCount, fixture.expected.preflightCount);
  assert.equal(transportCount, fixture.expected.transportDispatchCount);
  assert.equal(syncObservationCount, fixture.expected.synchronousClassifierObservationCount);
});
