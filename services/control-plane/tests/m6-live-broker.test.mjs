import assert from "node:assert/strict";
import test from "node:test";

import { createM6LiveBrokerHandler } from "../control-plane/lib/m6-live-broker.mjs";

const H = (letter) => letter.repeat(64);
const binding = Object.freeze({
  runId: "run:broker-test", workerId: "worker:broker-test", sessionId: "session:broker-test", alias: "01", processRef: "process:broker-test",
  gateEpochHash: H("a"), generation: 2, purpose: "M6_4_ACTION_SMOKE", scenarioManifestHash: H("b"),
  liveWindowAuthorizationHash: H("c"), bindingHash: H("d"),
});

function fixture() {
  let calls = 0;
  const fence = {
    gateId: "m6-gate", epochHash: binding.gateEpochHash, generation: binding.generation, mode: "GROUNDED_ACTION",
    purpose: binding.purpose, allowlist: ["01"], expiresAt: "2030-01-01T01:00:00Z",
    releaseId: "release-broker-test", sourceCommit: "a".repeat(40), locksHash: H("e"),
  };
  const consumption = {
    authorizationId: "auth-1", envelopeHash: binding.liveWindowAuthorizationHash, gateId: fence.gateId,
    gateEpochHash: binding.gateEpochHash, gateGeneration: binding.generation, purpose: binding.purpose,
    expiresAt: "2030-01-01T01:00:00Z",
  };
  const state = {
    getM6GateFence: () => fence,
    getM64LiveWindowAuthorizationConsumption: () => consumption,
  };
  const runManager = {
    getRunBinding: () => binding,
    async handleToolCall() { calls += 1; return { externalEffect: false, actionCount: 0, workerRunRef: "worker:broker-test", status: "RUNNING" }; },
  };
  const pointer = { chain: [fence.epochHash], tailEpochHash: fence.epochHash, generation: fence.generation };
  const loaded = {
    chain: [{
      schemaId: "xw.m6-live-gate.v2", epochHash: fence.epochHash, mode: fence.mode, purpose: fence.purpose,
      allowlist: fence.allowlist, expiresAt: fence.expiresAt, releaseId: fence.releaseId,
      sourceCommit: fence.sourceCommit, lockSetRef: { sha256: fence.locksHash },
    }],
    currentPointer: pointer,
  };
  const handler = createM6LiveBrokerHandler({
    state,
    runManager,
    binding,
    authorizationId: "auth-1",
    now: () => Date.parse("2030-01-01T00:00:00Z"),
    loadGateSnapshot: () => loaded,
  });
  return { state, runManager, handler, fence, consumption, loaded, pointer, calls: () => calls };
}

test("Control Plane live broker independently rechecks fence and consumed authorization", async () => {
  const f = fixture();
  const result = await f.handler({ method: "worker_start", params: { workerRunRef: "worker:broker-test" }, binding });
  assert.equal(result.status, "RUNNING");
  assert.equal(f.calls(), 1);
  f.state.getM64LiveWindowAuthorizationConsumption = () => null;
  await assert.rejects(() => f.handler({ method: "worker_start", params: { workerRunRef: "worker:broker-test" }, binding }), { code: "M6_LIVE_BROKER_AUTH_CONSUMPTION_MISMATCH" });
  assert.equal(f.calls(), 1);
});

test("Control Plane live broker rejects gate/run drift and extra tools before run dispatch", async () => {
  const f = fixture();
  f.fence.generation += 1;
  await assert.rejects(() => f.handler({ method: "worker_start", params: { workerRunRef: "worker:broker-test" }, binding }), { code: "M6_LIVE_BROKER_GATE_FENCE_MISMATCH" });
  f.fence.generation -= 1;
  await assert.rejects(() => f.handler({ method: "phone_raw", params: {}, binding }), { code: "M6_LIVE_TOOL_FORBIDDEN" });
  await assert.rejects(() => f.handler({ method: "worker_start", params: { workerRunRef: "worker:broker-test" }, binding: { ...binding, runId: "run:other" } }), { code: "M6_LIVE_BROKER_RUN_BINDING_MISMATCH" });
  assert.equal(f.calls(), 0);
});

test("Control Plane live broker rejects file/DB/current triple mismatch before dispatch", async () => {
  const f = fixture();
  f.pointer.generation -= 1;
  await assert.rejects(
    () => f.handler({ method: "worker_start", params: { workerRunRef: "worker:broker-test" }, binding }),
    { code: "M6_GATE_TRIPLE_MISMATCH" },
  );
  assert.equal(f.calls(), 0);
});
