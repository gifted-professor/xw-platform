import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const fixtures = JSON.parse(readFileSync(new URL("./fixtures/payment-tripwire/cases.json", import.meta.url), "utf8"));

test("target-bound classifier holds verified final controls without keyword blanket blocking", async () => {
  const module = await import("../control-plane/lib/financial-commit-classifier.mjs").catch(() => null);
  assert.ok(module?.classifyFinancialCommit, "RED: financial commit classifier is not implemented");
  for (const fixture of fixtures.positive) {
    assert.equal(module.classifyFinancialCommit(fixture).actionClass, "financial_commit", fixture.name);
  }
  for (const fixture of fixtures.negative) {
    assert.notEqual(module.classifyFinancialCommit(fixture).actionClass, "financial_commit", fixture.name);
  }
});

test("typed and raw final-payment inputs dispatch zero transport without a bound approval", async () => {
  const { createFinancialCommitTripwire } = await import("../control-plane/lib/financial-commit-classifier.mjs");
  let transportCalls = 0;
  let observationCalls = 0;
  const tripwire = createFinancialCommitTripwire({
    transport: async () => { transportCalls += 1; return { ok: true }; },
    observeCandidate: async () => { observationCalls += 1; return {}; }
  });
  for (const primitive of ["typed-capability", "tap", "input", "shell"]) {
    const result = await tripwire.dispatch({
      primitive,
      app: "fixture-pay",
      accountRef: "redacted:account",
      deviceId: "fixture-device",
      snapshotHash: "a".repeat(64),
      ...fixtures.positive[0]
    });
    assert.equal(result.decision, "wait_financial_commit", primitive);
    assert.equal(result.transportDispatched, false, primitive);
  }
  assert.equal(transportCalls, 0);
  assert.equal(observationCalls, 0);
});

test("ordinary inputs never invoke synchronous observation and payment candidates invoke it once", async () => {
  const { createFinancialCommitTripwire } = await import("../control-plane/lib/financial-commit-classifier.mjs");
  let transportCalls = 0;
  let observationCalls = 0;
  const tripwire = createFinancialCommitTripwire({
    transport: async () => { transportCalls += 1; return { ok: true }; },
    observeCandidate: async ({ input }) => {
      observationCalls += 1;
      return {
        target: { ...input.target, verifiedFinalControl: true },
        context: { ...input.context, amount: "8.00", currency: "CNY", payeeRef: "redacted:merchant" }
      };
    }
  });
  const ordinary = await tripwire.dispatch(fixtures.negative[2]);
  assert.equal(ordinary.transportDispatched, true);
  assert.equal(ordinary.synchronousObservationCount, 0);
  assert.equal(observationCalls, 0);

  const candidate = await tripwire.dispatch({
    target: { text: "确认支付" },
    context: { stage: "final" }
  });
  assert.equal(candidate.decision, "wait_financial_commit");
  assert.equal(candidate.transportDispatched, false);
  assert.equal(candidate.synchronousObservationCount, 1);
  assert.equal(observationCalls, 1);
  assert.equal(transportCalls, 1);
});

// ─── REX Phase 2 收尾 §4.2.A：生产输入路径接线证明 ───
//
// 下列测试证明：每个直运入口都已接 guardFinancialCommit fail-closed 守卫——
// 命中 financial_commit 即在触碰设备前抛 FINANCIAL_COMMIT_REQUIRES_HUMAN_GATE
// （transport=0），非金融输入透传（零同步）。#runJob chokepoint 的端到端证明
// 在 tests/control-plane-server.test.mjs。

const FINANCIAL_COMMIT_INPUT = Object.freeze({
  target: { text: "确认支付", verifiedFinalControl: true },
  context: { stage: "final", amount: "88.00", currency: "CNY", payeeRef: "redacted:merchant" },
});

test("guardFinancialCommit: no-semantic passes free; non-financial passes; financial_commit fail-closes; valid approval passes", async () => {
  const { guardFinancialCommit } = await import("../control-plane/lib/financial-commit-classifier.mjs");
  // 无语义 → 不 classify，零成本放行
  const none = await guardFinancialCommit({ action: "list", data: { items: [] } });
  assert.equal(none.actionClass, "unknown");
  assert.equal(none.guarded, false);
  // 非金融语义（observe）→ 放行
  const obs = await guardFinancialCommit({ target: { text: "余额" }, context: { stage: "observe", financialSurface: true } });
  assert.equal(obs.actionClass, "financial_observe");
  assert.equal(obs.guarded, true);
  // financial_commit + 无 verifier → 直运 fail-closed
  await assert.rejects(() => guardFinancialCommit(FINANCIAL_COMMIT_INPUT), { code: "FINANCIAL_COMMIT_REQUIRES_HUMAN_GATE" });
  // financial_commit + verifier + 无效批准 → 仍拒
  const verifier = async ({ approval }) => approval?.signature === "good" ? { ok: true } : { ok: false, code: "BAD_SIG" };
  await assert.rejects(
    () => guardFinancialCommit({ ...FINANCIAL_COMMIT_INPUT, approval: { signature: "bad" } }, { verifyApproval: verifier }),
    { code: "FINANCIAL_COMMIT_REQUIRES_HUMAN_GATE" },
  );
  // financial_commit + verifier + 有效批准 → 放行（sanctioned PHC 路径）
  const approved = await guardFinancialCommit({ ...FINANCIAL_COMMIT_INPUT, approval: { signature: "good" } }, { verifyApproval: verifier });
  assert.equal(approved.approved, true);
});

test("extractFinancialInput tolerates data/params/devices and returns null when no semantic target/context", async () => {
  const { extractFinancialInput } = await import("../control-plane/lib/financial-commit-classifier.mjs");
  assert.equal(extractFinancialInput({ action: "list" }), null);
  assert.equal(extractFinancialInput(null), null);
  const fromData = extractFinancialInput({ data: { target: { text: "支付" }, context: { stage: "final" } }, devices: ["dev-1"] });
  assert.equal(fromData.target.text, "支付");
  assert.equal(fromData.deviceId, "dev-1");
  const fromParams = extractFinancialInput({ params: { target: { text: "支付" } } });
  assert.equal(fromParams.target.text, "支付");
});

test("admission gate refuses a financial_commit capability on every auto-dispatch invocation", async () => {
  const { evaluateCapabilityPolicy } = await import("../control-plane/lib/policy.mjs");
  const base = { id: "fixture.pay.send", appId: "fixture", maturity: "E3", risk: "R0", idempotency: "replay_safe", automationPolicy: { mode: "automatic" }, resources: [], restoration: { required: false } };
  const payCap = { ...base, financialCommit: true };
  for (const invocation of ["job", "session", "mission_effect"]) {
    const out = evaluateCapabilityPolicy(payCap, { invocation });
    assert.equal(out.decision, "wait_human_commit", invocation);
    assert.equal(out.reasonCode, "PROTECTED_COMMIT_REQUIRED", invocation);
    assert.equal(out.approvalRequired, true, invocation);
  }
  // 普通同等 capability 不受闸影响
  const ok = evaluateCapabilityPolicy(base, { invocation: "job" });
  assert.equal(ok.decision, "allow");
});

test("XiaoweiTransport.invoke fail-closes on financial_commit data before opening the WS", async () => {
  const { XiaoweiTransport } = await import("../control-plane/lib/xiaowei-transport.mjs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { randomUUID } = await import("node:crypto");
  const constructed = [];
  class FakeWS {
    constructor(url) { this.url = url; constructed.push(url); this._l = {}; queueMicrotask(() => this._l.open?.()); }
    addEventListener(t, cb) { this._l[t] = cb; }
    send() { queueMicrotask(() => this._l.message?.({ data: JSON.stringify({ code: 10000, data: [] }) })); }
    close() {}
  }
  const transport = new XiaoweiTransport({ WebSocketImpl: FakeWS, lockPath: join(tmpdir(), `xw-test-${randomUUID()}.lock`) });
  await assert.rejects(() => transport.invoke({ action: "tap", data: FINANCIAL_COMMIT_INPUT }), { code: "FINANCIAL_COMMIT_REQUIRES_HUMAN_GATE" });
  assert.equal(constructed.length, 0, "WS must not be constructed for a financial_commit");
  const out = await transport.invoke({ action: "list", data: { items: [] } });
  assert.equal(constructed.length, 1);
  assert.equal(out.code, 10000);
});

test("greenarrow send fail-closes on financial_commit before opening the raw WS", async () => {
  const { send } = await import("../scripts/greenarrow-api.mjs");
  const constructed = [];
  class FakeWS {
    constructor(url) { this.url = url; constructed.push(url); this._l = {}; queueMicrotask(() => this._l.open?.()); }
    addEventListener(t, cb) { this._l[t] = cb; }
    send() { queueMicrotask(() => this._l.message?.({ data: JSON.stringify({ code: 10000 }) })); }
    close() {}
  }
  const realWS = globalThis.WebSocket;
  globalThis.WebSocket = FakeWS;
  try {
    await assert.rejects(() => send({ action: "tap", data: FINANCIAL_COMMIT_INPUT }), { code: "FINANCIAL_COMMIT_REQUIRES_HUMAN_GATE" });
    assert.equal(constructed.length, 0);
    const out = await send({ action: "list" });
    assert.equal(constructed.length, 1);
    assert.equal(out.code, 10000);
  } finally {
    globalThis.WebSocket = realWS;
  }
});

test("FastOperator.tap fail-closes on a declared financial_commit semantic and passes coordinate-only taps", async () => {
  const { FastOperator } = await import("../scripts/fast-operator.mjs");
  const fast = new FastOperator({ adbPath: "fake-adb", serial: "fake-serial" });
  const execCalls = [];
  fast.session = { async exec(cmd) { execCalls.push(cmd); return "ok"; }, async close() {} };
  await assert.rejects(() => fast.tap(100, 200, FINANCIAL_COMMIT_INPUT), { code: "FINANCIAL_COMMIT_REQUIRES_HUMAN_GATE" });
  assert.equal(execCalls.length, 0, "adb input must not fire for a financial_commit tap");
  await fast.tap(100, 200);
  assert.equal(execCalls.length, 1);
  assert.match(execCalls[0], /input tap 100 200/);
});

test("XiaoweiHttpAdapter._httpInvoke fail-closes on financial_commit body before POST", async () => {
  const { XiaoweiHttpAdapter } = await import("../scripts/xiaowei-http-adapter.mjs");
  let fetchCalls = 0;
  const fakeFetch = async () => { fetchCalls += 1; return { ok: true, json: async () => ({ ok: true, status: "ok" }) }; };
  const adapter = new XiaoweiHttpAdapter({ serial: "fake-serial", innerOperator: {}, fetchImpl: fakeFetch });
  const financialBody = { capability: "input.pointer.tap", deviceAlias: "01", params: FINANCIAL_COMMIT_INPUT };
  await assert.rejects(() => adapter._httpInvoke("input.pointer.tap", financialBody), { code: "FINANCIAL_COMMIT_REQUIRES_HUMAN_GATE" });
  assert.equal(fetchCalls, 0, "typed-HTTP POST must not fire for a financial_commit");
  const okBody = { capability: "input.pointer.tap", deviceAlias: "01", params: { coordinate: { space: "sourcePixels", x: 1, y: 2, width: 1080, height: 2400 } } };
  await adapter._httpInvoke("input.pointer.tap", okBody);
  assert.equal(fetchCalls, 1);
});
