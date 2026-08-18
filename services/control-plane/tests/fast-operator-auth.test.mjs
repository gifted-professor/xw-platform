import assert from "node:assert/strict";
import test from "node:test";

import { authorizeServeRequest } from "../scripts/fast-operator.mjs";

test("fast-operator serve rejects requests without a lease before device work", async () => {
  await assert.rejects(authorizeServeRequest({
    headers: {},
    runtimeId: "runtime-01",
    env: {},
  }), { code: "CONTROL_LEASE_REQUIRED", status: 423 });
});

test("fast-operator serve binds request authorization to its runtime", async () => {
  const calls = [];
  const result = await authorizeServeRequest({
    headers: {
      "x-control-lease-id": "lease-01",
      "x-control-token": "secret-token",
      "x-control-device-id": "device-01",
    },
    runtimeId: "runtime-01",
    env: { XHS_OPERATOR_CONTROL_URL: "http://127.0.0.1:17920" },
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options, body: JSON.parse(options.body) });
      return new Response(JSON.stringify({ ok: true, authorized: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.equal(result.authorized, true);
  assert.equal(calls[0].options.headers["x-control-token"], "secret-token");
  assert.deepEqual(calls[0].body, {
    leaseId: "lease-01",
    deviceId: "device-01",
    runtimeId: "runtime-01",
  });
});

test("fast-operator serve rejects a mismatched lease response", async () => {
  await assert.rejects(authorizeServeRequest({
    headers: {
      "x-control-lease-id": "lease-01",
      "x-control-token": "secret-token",
      "x-control-device-id": "device-01",
    },
    runtimeId: "runtime-02",
    env: {},
    fetchImpl: async () => new Response(JSON.stringify({
      ok: false,
      error: { code: "LEASE_RUNTIME_MISMATCH", message: "wrong runtime", details: {} },
    }), {
      status: 409,
      headers: { "content-type": "application/json" },
    }),
  }), { code: "LEASE_RUNTIME_MISMATCH", status: 409 });
});
