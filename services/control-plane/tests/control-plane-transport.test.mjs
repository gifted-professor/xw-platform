import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  acquireTransportLock,
  FairFifoQueue,
  inspectTransportLock,
  XiaoweiTransport,
} from "../control-plane/lib/xiaowei-transport.mjs";

const tempBase = fileURLToPath(new URL("../control-plane/runtime", import.meta.url));
mkdirSync(tempBase, { recursive: true });

test("tokenized transport lock rejects overlap and preserves the owner", async () => {
  const root = mkdtempSync(join(tempBase, "transport-test-"));
  const path = join(root, "xw-ws-22222.lock");
  try {
    const release = await acquireTransportLock({ path, timeoutMs: 20, staleMs: 1000, retryMs: 2 });
    assert.equal(inspectTransportLock({ path, staleMs: 1000 }).status, "busy");
    await assert.rejects(
      acquireTransportLock({ path, timeoutMs: 5, staleMs: 1000, retryMs: 1 }),
      { code: "TRANSPORT_LOCK_TIMEOUT" },
    );
    release();
    assert.equal(inspectTransportLock({ path, staleMs: 1000 }).status, "free");
    const releaseAgain = await acquireTransportLock({ path, timeoutMs: 20, staleMs: 1000, retryMs: 2 });
    releaseAgain();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stale transport lock is recovered before a request", async () => {
  const root = mkdtempSync(join(tempBase, "transport-stale-"));
  const path = join(root, "xw-ws-22222.lock");
  try {
    writeFileSync(path, JSON.stringify({ token: "stale" }));
    const old = new Date(Date.now() - 60000);
    utimesSync(path, old, old);
    assert.equal(inspectTransportLock({ path, staleMs: 1000 }).status, "stale");
    const release = await acquireTransportLock({ path, timeoutMs: 20, staleMs: 1000, retryMs: 2 });
    release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("FairFifoQueue is FIFO and continues after a rejected item", async () => {
  const queue = new FairFifoQueue();
  const order = [];
  const first = queue.enqueue(async () => {
    order.push("first");
    throw new Error("fixture failure");
  });
  const second = queue.enqueue(async () => {
    order.push("second");
    return "ok";
  });
  const third = queue.enqueue(async () => {
    order.push("third");
    return "done";
  });

  await assert.rejects(first, /fixture failure/);
  assert.equal(await second, "ok");
  assert.equal(await third, "done");
  await queue.waitForIdle();
  assert.deepEqual(order, ["first", "second", "third"]);
  assert.equal(queue.size, 0);
});

function createFakeWebSocketFixture({ responseDelayMs = 0 } = {}) {
  const fixture = {
    constructed: [],
    sends: [],
    active: 0,
    maxActive: 0,
  };
  class FakeWS {
    constructor(url) {
      this.url = url;
      this.listeners = new Map();
      this.closed = false;
      fixture.constructed.push(this);
      queueMicrotask(() => this.listeners.get("open")?.());
    }

    addEventListener(type, callback) {
      this.listeners.set(type, callback);
    }

    send(payload) {
      const request = JSON.parse(payload);
      fixture.sends.push(request.action);
      fixture.active += 1;
      fixture.maxActive = Math.max(fixture.maxActive, fixture.active);
      setTimeout(() => {
        fixture.active -= 1;
        this.listeners.get("message")?.({ data: JSON.stringify({ code: 10000, data: request.action }) });
      }, responseDelayMs);
    }

    close() {
      this.closed = true;
    }
  }
  return { FakeWS, fixture };
}

test("transport broker orders concurrent workflows FIFO and keeps single-flight", async () => {
  const root = mkdtempSync(join(tempBase, "transport-fifo-"));
  const path = join(root, "xw-ws-22222.lock");
  const { FakeWS, fixture } = createFakeWebSocketFixture({ responseDelayMs: 2 });
  try {
    const transport = new XiaoweiTransport({
      WebSocketImpl: FakeWS,
      lockPath: path,
      lockTimeoutMs: 1000,
      staleLockMs: 1000,
      lockRetryMs: 1,
    });
    const results = await Promise.all([
      transport.invoke({ action: "first" }),
      transport.invoke({ action: "second" }),
      transport.invoke({ action: "third" }),
    ]);
    assert.deepEqual(fixture.sends, ["first", "second", "third"]);
    assert.equal(fixture.constructed.length, 3, "ordinary invoke keeps one request per WebSocket");
    assert.equal(fixture.maxActive, 1, "broker must remain single-flight");
    assert.deepEqual(results.map((result) => result.data), ["first", "second", "third"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bounded workflow defaults to a fresh WebSocket per request", async () => {
  const root = mkdtempSync(join(tempBase, "transport-bounded-"));
  const path = join(root, "xw-ws-22222.lock");
  const { FakeWS, fixture } = createFakeWebSocketFixture();
  try {
    const transport = new XiaoweiTransport({ WebSocketImpl: FakeWS, lockPath: path, lockTimeoutMs: 1000, staleLockMs: 1000 });
    await transport.runExclusive(async (channel) => {
      const outputs = await Promise.all([
        channel.invoke({ action: "one" }),
        channel.invoke({ action: "two" }),
      ]);
      assert.deepEqual(outputs.map((result) => result.data), ["one", "two"]);
      assert.equal(channel.pending, 0);
    });
    assert.deepEqual(fixture.sends, ["one", "two"]);
    assert.equal(fixture.constructed.length, 2);
    assert.equal(fixture.maxActive, 1, "parallel callback submissions are serialized");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bounded workflow reuses one WebSocket only with explicit opt-in", async () => {
  const root = mkdtempSync(join(tempBase, "transport-reuse-"));
  const path = join(root, "xw-ws-22222.lock");
  const { FakeWS, fixture } = createFakeWebSocketFixture();
  try {
    const transport = new XiaoweiTransport({ WebSocketImpl: FakeWS, lockPath: path, lockTimeoutMs: 1000, staleLockMs: 1000 });
    await transport.runExclusive(async (channel) => {
      await channel.invoke({ action: "reused-one" });
      await channel.invoke({ action: "reused-two" });
    }, { reuseWebSocket: true });
    assert.deepEqual(fixture.sends, ["reused-one", "reused-two"]);
    assert.equal(fixture.constructed.length, 1, "explicit reuse uses one sequential WebSocket");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bounded workflow keeps the financial hard gate before a WebSocket send", async () => {
  const root = mkdtempSync(join(tempBase, "transport-financial-"));
  const path = join(root, "xw-ws-22222.lock");
  const { FakeWS, fixture } = createFakeWebSocketFixture();
  try {
    const transport = new XiaoweiTransport({ WebSocketImpl: FakeWS, lockPath: path, lockTimeoutMs: 1000, staleLockMs: 1000 });
    await assert.rejects(
      () => transport.runExclusive((channel, unchecked) => {
        assert.equal(unchecked, undefined, "unchecked transport helper must not be exposed");
        return channel.invoke({
          action: "tap",
          data: {
            target: { text: "确认支付", verifiedFinalControl: true },
            context: { stage: "final", amount: "8.00", currency: "CNY", payeeRef: "redacted:merchant" },
          },
        });
      }),
      { code: "FINANCIAL_COMMIT_REQUIRES_HUMAN_GATE" },
    );
    assert.equal(fixture.constructed.length, 0);
    assert.deepEqual(fixture.sends, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
