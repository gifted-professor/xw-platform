import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";
import test from "node:test";

import { ExplorerSessionBridge } from "../control-plane/lib/explorer-session-bridge.mjs";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/explorer-hotpath/sequence.json", import.meta.url), "utf8"));

// 模拟固定延迟的 transport（离线 perf 门，不碰真机/Windows）。延迟取小值——门是
// 相对/结构性断言（p95<=baseline+budget、acquire p95<=2s），不需要模拟真实绝对延迟。
const TRANSPORT_LATENCY_MS = 2;
const ACQUIRE_LATENCY_MS = 20; // 远低于 §7.2 free device acquire p95<=2s 上限
function makeLatencyTransport(counter) {
  return async ({ primitive }) => {
    const start = performance.now();
    while (performance.now() - start < TRANSPORT_LATENCY_MS) { /* busy wait 模拟延迟 */ }
    counter.dispatched += 1;
    return { ok: true, primitive: primitive?.type ?? null };
  };
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function p95(values) {
  return percentile([...values].sort((a, b) => a - b), 95);
}

// ─── 结构性硬门（§7.2）：acquire=1 / preflight=1 / 同步观测=0 / 重复 preflight=0 / 重复 lease=0 ───

test("100-primitive steady-state: acquire once, preflight once, zero sync observation, zero repeated preflight/lease", async () => {
  const counter = { dispatched: 0 };
  let acquireCount = 0, preflightCount = 0, syncObs = 0;
  const bridge = new ExplorerSessionBridge({
    acquire: async () => { acquireCount += 1; const start = performance.now(); while (performance.now() - start < ACQUIRE_LATENCY_MS) {} return { sessionId: "s", leaseId: "l", token: "t" }; },
    preflight: async () => { preflightCount += 1; },
    transport: makeLatencyTransport(counter),
    observeForClassifier: async () => { syncObs += 1; return {}; },
  });
  const session = await bridge.open(fixture.session);
  for (let i = 0; i < 100; i++) await session.dispatchPrimitive({ type: "tap", x: i, y: i });
  await session.close();
  assert.equal(acquireCount, 1, "每 session acquire = 1");
  assert.equal(preflightCount, 1, "preflight = 1（普通 primitive 不重复 preflight）");
  assert.equal(syncObs, 0, "普通 primitive 同步 dump/vision/cloud = 0");
  assert.equal(counter.dispatched, 100, "transport 每 primitive 一次");
});

// ─── 延迟硬门（§7.2）：steady primitive p95 <= direct REPL p95 + max(100ms, 10%) ───

test("steady primitive p95 within direct-REPL p95 + max(100ms, 10%)", async () => {
  const N = 100;
  // baseline: 直接调 transport（模拟 direct REPL），逐 primitive
  const baselineLat = [];
  const baseCounter = { dispatched: 0 };
  const baseTransport = makeLatencyTransport(baseCounter);
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    await baseTransport({ primitive: { type: "tap" } });
    baselineLat.push(performance.now() - t0);
  }
  // candidate: session bridge
  const candCounter = { dispatched: 0 };
  const bridge = new ExplorerSessionBridge({
    acquire: async () => ({ sessionId: "s", leaseId: "l", token: "t" }),
    transport: makeLatencyTransport(candCounter),
  });
  const session = await bridge.open(fixture.session);
  const candLat = [];
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    await session.dispatchPrimitive({ type: "tap" });
    candLat.push(performance.now() - t0);
  }
  await session.close();
  const budget = Math.max(100, p95(baselineLat) * 0.10);
  assert.ok(p95(candLat) <= p95(baselineLat) + budget,
    `steady p95 candidate ${p95(candLat).toFixed(2)}ms > baseline ${p95(baselineLat).toFixed(2)}ms + budget ${budget.toFixed(2)}ms`);
});

// ─── 30-step 门（§7.2）：30-step <= direct baseline * 1.10 + 2s ───

test("30-step mixed exploration within direct baseline * 1.10 + 2s", async () => {
  const mixed = [
    ...fixture.primitives,
    { type: "tap", x: 1, y: 2 }, { type: "swipe" }, { type: "input", text: "x" },
    { type: "focus" }, { type: "back" }, { type: "tap", x: 3, y: 4 }, { type: "screenshot" },
    { type: "dump" }, { type: "input", text: "y" }, { type: "tap", x: 5, y: 6 },
    { type: "back" }, { type: "focus" }, { type: "swipe" }, { type: "tap", x: 7, y: 8 },
    { type: "input", text: "z" }, { type: "dump" }, { type: "tap", x: 9, y: 10 },
    { type: "back" }, { type: "screenshot" }, { type: "focus" }, { type: "tap", x: 11, y: 12 },
    { type: "swipe" }, { type: "input", text: "w" }, { type: "tap", x: 13, y: 14 },
  ].slice(0, 30);
  // baseline：直接逐 primitive
  const baseTransport = makeLatencyTransport({ dispatched: 0 });
  const t0Base = performance.now();
  for (const p of mixed) await baseTransport({ primitive: p });
  const baselineTotal = performance.now() - t0Base;
  // candidate：bridge
  const bridge = new ExplorerSessionBridge({
    acquire: async () => ({ sessionId: "s", leaseId: "l", token: "t" }),
    transport: makeLatencyTransport({ dispatched: 0 }),
  });
  const session = await bridge.open(fixture.session);
  const t0Cand = performance.now();
  for (const p of mixed) await session.dispatchPrimitive(p);
  const candTotal = performance.now() - t0Cand;
  await session.close();
  assert.ok(candTotal <= baselineTotal * 1.10 + 2000,
    `30-step candidate ${candTotal.toFixed(2)}ms > baseline ${baselineTotal.toFixed(2)}ms * 1.10 + 2s`);
});

// ─── payment candidate 一次额外观察单独统计（§7.2 / §7.1）───

test("payment candidate triggers exactly one extra synchronous observation, counted separately", async () => {
  let syncObs = 0;
  const bridge = new ExplorerSessionBridge({
    acquire: async () => ({ sessionId: "s", leaseId: "l", token: "t" }),
    transport: makeLatencyTransport({ dispatched: 0 }),
    observeForClassifier: async () => { syncObs += 1; return {}; },
  });
  const session = await bridge.open(fixture.session);
  for (const p of fixture.primitives) await session.dispatchPrimitive(p); // 4 普通 → 0 观测
  await session.dispatchPrimitive({ type: "tap", x: 1, y: 2, actionClass: "financial_commit_candidate" });
  await session.close();
  assert.equal(syncObs, 1, "payment candidate 一次额外观察，单独统计");
});

// ─── L0 控制面不可用仍能只读观察（§7.2 / §6.3 item 8）───

test("L0 read-only observe works without control plane (lease-free, no acquire)", async () => {
  const counter = { dispatched: 0 };
  const transport = makeLatencyTransport(counter);
  // 不 open（不 acquire），直接 L0 只读
  const out = await ExplorerSessionBridge.l0Observe({ transport, primitive: { type: "dump" } });
  assert.equal(out.ok, true);
  assert.equal(counter.dispatched, 1);
  assert.equal(out.primitive, "dump");
});

// ─── free device session acquire p95 <= 2s（§7.2）───

test("free device session acquire p95 <= 2s", async () => {
  const acquires = [];
  for (let i = 0; i < 20; i++) {
    const bridge = new ExplorerSessionBridge({
      acquire: async () => { const start = performance.now(); while (performance.now() - start < ACQUIRE_LATENCY_MS) {} return { sessionId: "s", leaseId: "l", token: "t" }; },
      transport: makeLatencyTransport({ dispatched: 0 }),
    });
    const t0 = performance.now();
    await bridge.open(fixture.session);
    acquires.push(performance.now() - t0);
  }
  assert.ok(p95(acquires) <= 2000, `acquire p95 ${p95(acquires).toFixed(2)}ms > 2000ms`);
});