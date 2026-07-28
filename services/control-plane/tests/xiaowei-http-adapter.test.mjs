import assert from "node:assert/strict";
import test from "node:test";

import { parseEffectiveDisplaySize, XiaoweiHttpAdapter } from "../scripts/xiaowei-http-adapter.mjs";

function fakeInner() {
  return {
    xwBridgeIme: "test/.Ime",
    metrics: { actions: 0, dumps: 0, scrolls: 0, taps: 0, totalDumpMs: 0, totalScrollMs: 0 },
    startCalls: 0,
    tapCalls: [],
    async start() { this.startCalls += 1; return this; },
    async tap(x, y) { this.tapCalls.push([x, y]); },
    async shellExec(command) { return command === "wm size" ? "Physical size: 1080x2400" : ""; },
    async close() {},
  };
}

test("strict typed HTTP tap records real HTTP use without gateway fallback", async () => {
  const inner = fakeInner();
  const calls = [];
  const adapter = new XiaoweiHttpAdapter({
    serial: "private-runtime-id",
    deviceAlias: "01",
    fallbackOnError: false,
    innerOperator: inner,
    healthCheckImpl: async () => true,
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return new Response(JSON.stringify({ status: "executed" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  await adapter.start();
  await adapter.tap(896.4, 175.2);

  assert.equal(inner.startCalls, 1);
  assert.deepEqual(inner.tapCalls, []);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:17910/device/v1/invoke");
  assert.deepEqual(calls[0].body, {
    capability: "input.pointer.tap",
    deviceAlias: "01",
    params: {
      coordinate: { space: "sourcePixels", x: 896, y: 175, width: 1080, height: 2400 },
    },
  });
  assert.deepEqual(adapter.transportEvidence(), {
    mode: "typed-http",
    httpReady: true,
    httpTapAttempts: 1,
    httpTapSucceeded: 1,
    gatewayTapFallbacks: 0,
  });
});

test("strict tap derives the effective frame and never retries ambiguous delivery", async () => {
  const inner = fakeInner();
  inner.shellExec = async () => "Physical size: 1080x2400\nOverride size: 720x1600";
  const calls = [];
  const adapter = new XiaoweiHttpAdapter({
    serial: "private-runtime-id",
    deviceAlias: "01",
    fallbackOnError: false,
    innerOperator: inner,
    healthCheckImpl: async () => true,
    fetchImpl: async (_url, options) => {
      calls.push(JSON.parse(options.body));
      throw new TypeError("response lost");
    },
  });

  await adapter.start();
  await assert.rejects(adapter.tap(600, 1200), /response lost/);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params.coordinate, {
    space: "sourcePixels", x: 600, y: 1200, width: 720, height: 1600,
  });
  assert.equal(adapter.transportEvidence().httpTapAttempts, 1);
  assert.equal(adapter.transportEvidence().httpTapSucceeded, 0);
});

test("strict start fails closed when the source frame cannot be verified", async () => {
  const inner = fakeInner();
  inner.shellExec = async () => "";
  const adapter = new XiaoweiHttpAdapter({
    serial: "private-runtime-id",
    fallbackOnError: false,
    innerOperator: inner,
    healthCheckImpl: async () => true,
  });

  await assert.rejects(adapter.start(), /source frame could not be verified/);
});

test("effective display size prefers an override", () => {
  assert.deepEqual(parseEffectiveDisplaySize("Physical size: 1080x2400\nOverride size: 720x1600"), {
    width: 720, height: 1600,
  });
  assert.equal(parseEffectiveDisplaySize("unknown"), null);
});

test("strict typed HTTP start fails closed when loopback API is unavailable", async () => {
  const adapter = new XiaoweiHttpAdapter({
    serial: "private-runtime-id",
    fallbackOnError: false,
    innerOperator: fakeInner(),
    healthCheckImpl: async () => false,
  });

  await assert.rejects(adapter.start(), /HTTP API not reachable/);
});

test("non-strict mode records the gateway tap fallback", async () => {
  const inner = fakeInner();
  const adapter = new XiaoweiHttpAdapter({
    serial: "private-runtime-id",
    fallbackOnError: true,
    innerOperator: inner,
    healthCheckImpl: async () => false,
  });

  await adapter.start();
  await adapter.tap(10, 20);

  assert.deepEqual(inner.tapCalls, [[10, 20]]);
  assert.equal(adapter.transportEvidence().gatewayTapFallbacks, 1);
});
