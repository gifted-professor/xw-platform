import assert from "node:assert/strict";
import test from "node:test";

import { GatewayOperator } from "../scripts/gateway-operator.mjs";

function readyTransport(serial, calls) {
  return {
    async invoke(request) {
      calls.push(request);
      return { code: 10000, data: { [serial]: "gateway-ready\n" } };
    },
  };
}

test("GatewayOperator fails before transport when no control-plane lease exists", async () => {
  const transportCalls = [];
  const op = new GatewayOperator({
    serial: "runtime-01",
    leaseAuthorization: {},
    allowBypass: false,
    transportClient: readyTransport("runtime-01", transportCalls),
  });
  await assert.rejects(op.start(), { code: "CONTROL_LEASE_REQUIRED", status: 423 });
  assert.equal(transportCalls.length, 0);
});

test("GatewayOperator authorizes lease against the exact runtime before gateway access", async () => {
  const authCalls = [];
  const transportCalls = [];
  const op = new GatewayOperator({
    serial: "runtime-01",
    leaseAuthorization: {
      leaseId: "lease-01",
      token: "secret-token",
      deviceId: "device-01",
      controlUrl: "http://127.0.0.1:17920",
    },
    allowBypass: false,
    fetchImpl: async (url, options) => {
      authCalls.push({ url: String(url), options, body: JSON.parse(options.body) });
      return new Response(JSON.stringify({ ok: true, authorized: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    transportClient: readyTransport("runtime-01", transportCalls),
  });
  await op.start();
  assert.equal(authCalls.length, 1);
  assert.equal(authCalls[0].options.headers["x-control-token"], "secret-token");
  assert.deepEqual(authCalls[0].body, {
    leaseId: "lease-01",
    deviceId: "device-01",
    runtimeId: "runtime-01",
  });
  assert.equal(transportCalls.length, 1);
});

test("GatewayOperator only allows an explicit recorded lab bypass", async () => {
  const transportCalls = [];
  const originalError = console.error;
  const audit = [];
  console.error = (value) => audit.push(JSON.parse(value));
  const op = new GatewayOperator({
    serial: "runtime-01",
    leaseAuthorization: {},
    allowBypass: true,
    bypassReason: "bounded offline transport test",
    fetchImpl: async () => { throw new Error("authorization should be skipped"); },
    transportClient: readyTransport("runtime-01", transportCalls),
  });
  try {
    await op.start();
    assert.equal(transportCalls.length, 1);
    assert.equal(audit[0].event, "operator.lease-bypass");
    assert.equal(audit[0].reason, "bounded offline transport test");
  } finally {
    console.error = originalError;
  }
});

test("GatewayOperator rejects an unrecorded bypass", async () => {
  const op = new GatewayOperator({
    serial: "runtime-01",
    leaseAuthorization: {},
    allowBypass: true,
    bypassReason: "",
    transportClient: readyTransport("runtime-01", []),
  });
  await assert.rejects(op.start(), { code: "CONTROL_BYPASS_REASON_REQUIRED", status: 403 });
});
