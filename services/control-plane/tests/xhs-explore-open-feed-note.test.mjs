import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createXhsAdapter } from "../apps/xhs/adapter.mjs";
import { CapabilityRegistry } from "../control-plane/lib/capability-registry.mjs";
import { evaluateCapabilityPolicy } from "../control-plane/lib/policy.mjs";
import { FastOperator, serve } from "../scripts/fast-operator.mjs";

const registry = CapabilityRegistry.load(fileURLToPath(new URL("../apps", import.meta.url)));
const capability = registry.require("xhs.explore.open_feed_note");

test("feed-note exploration is a general automatic R0 navigation capability", () => {
  assert.equal(capability.risk, "R0");
  assert.equal(capability.automationPolicy.mode, "automatic");
  assert.equal(capability.implementation.action, "openFeedNote");
  assert.deepEqual(capability.inputSchema.properties.selector.enum, ["any"]);
  assert.equal(capability.inputSchema.properties.index.minimum, 0);
  assert.equal(capability.preconditions.some((item) => /already on|on a feed page/i.test(item)), false);
  assert.deepEqual(evaluateCapabilityPolicy(capability, { invocation: "session" }), {
    approvalRequired: false,
    externalEffect: false,
  });
  const bootstrap = readFileSync(new URL("../control-plane/bootstrap.mjs", import.meta.url), "utf8");
  assert.match(bootstrap, /capabilityId: "xhs\.explore\.open_feed_note", adapterId: "xhs"/);
});

test("operator opens the requested visible feed card and returns only a trusted note receipt", async () => {
  const operator = Object.create(FastOperator.prototype);
  const cards = [
    { cover: { center: [100, 200] }, authorName: "redacted-a" },
    { cover: { center: [300, 400] }, authorName: "redacted-b" },
  ];
  operator.ensureXhsFeed = async () => ({ ok: true, activity: "com.xingin.xhs.index.v2.IndexActivityV2" });
  operator.feedDump = async () => ({ nodes: [] });
  operator.feedCards = () => cards;
  operator.openCard = async (card) => ({ opened: card === cards[1], activity: "com.xingin.xhs.note.NoteDetailActivity" });
  operator.observeOpenNoteDetail = async () => ({
    ok: true,
    pageFingerprint: "a".repeat(64),
    targetFingerprint: "b".repeat(64),
    observedAt: "2026-07-30T16:00:00.000Z",
  });

  assert.deepEqual(await operator.openFeedNote({ selector: "any", index: 1 }), {
    ok: true,
    selectedIndex: 1,
    activity: "com.xingin.xhs.note.NoteDetailActivity",
    pageFingerprint: "a".repeat(64),
    targetFingerprint: "b".repeat(64),
    observedAt: "2026-07-30T16:00:00.000Z",
  });
});

test("operator fails before navigation when no selectable card exists", async () => {
  const operator = Object.create(FastOperator.prototype);
  operator.ensureXhsFeed = async () => ({ ok: true, activity: "com.xingin.xhs.index.v2.IndexActivityV2" });
  operator.feedDump = async () => ({ nodes: [] });
  operator.feedCards = () => [];
  assert.deepEqual(await operator.openFeedNote({ selector: "any" }), {
    ok: false,
    notSent: true,
    step: "noSelectableFeedCard",
  });
});

test("operator formally launches XHS from the desktop before reading the feed", async () => {
  const operator = Object.create(FastOperator.prototype);
  const trace = [];
  const focuses = [
    { package: "com.android.launcher", activity: "com.android.launcher.Launcher" },
    { package: "com.xingin.xhs", activity: "com.xingin.xhs.index.v2.IndexActivityV2" },
  ];
  operator.currentFocus = async () => { trace.push("focus"); return focuses.shift(); };
  operator.backToFeed = async () => { trace.push("backToFeed"); return { activity: "com.android.launcher.Launcher" }; };
  operator.session = { exec: async (command) => { trace.push(command); return "Events injected: 1"; } };
  operator.feedDump = async () => { trace.push("feedDump"); return { nodes: [] }; };
  operator.feedCards = () => [{ cover: { center: [100, 200] } }];
  operator.openCard = async () => { trace.push("openCard"); return { opened: true, activity: "com.xingin.xhs.note.NoteDetailActivity" }; };
  operator.observeOpenNoteDetail = async () => ({ ok: true, pageFingerprint: "a".repeat(64), targetFingerprint: "b".repeat(64), observedAt: "2026-07-30T16:00:00.000Z" });

  const result = await operator.openFeedNote({ selector: "any" });
  assert.equal(result.ok, true);
  assert.deepEqual(trace, [
    "focus",
    "monkey -p com.xingin.xhs -c android.intent.category.LAUNCHER 1",
    "focus",
    "feedDump",
    "openCard",
  ]);
});

test("operator converts a desktop launcher runtime throw into a retryable no-effect result", async () => {
  const operator = Object.create(FastOperator.prototype);
  const commands = [];
  operator.session = {
    async exec(command) {
      commands.push(command);
      if (command.startsWith("dumpsys window")) {
        return "mCurrentFocus=Window{42 u0 com.android.launcher/com.android.launcher.Launcher}";
      }
      throw new Error("adb shell timeout while launching XHS");
    },
    async oneShotShell() { return ""; },
  };

  assert.deepEqual(await operator.openFeedNote({ selector: "any" }), {
    ok: false,
    notSent: true,
    step: "xhsLaunchFailed",
    errorCode: "XHS_LAUNCH_FAILED",
    message: "adb shell timeout while launching XHS",
  });
  assert.deepEqual(commands, [
    "dumpsys window 2>/dev/null | grep -E mCurrentFocus",
    "monkey -p com.xingin.xhs -c android.intent.category.LAUNCHER 1",
  ]);
});

test("adapter dispatches and seals the combined navigation observation", async () => {
  const calls = [];
  const adapter = createXhsAdapter({
    fetchImpl: async (_url, options) => {
      calls.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ ok: true, result: {
        ok: true,
        selectedIndex: 0,
        activity: "com.xingin.xhs.note.NoteDetailActivity",
        pageFingerprint: "a".repeat(64),
        targetFingerprint: "b".repeat(64),
        observedAt: "2026-07-30T16:00:00.000Z",
      } }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const execution = await adapter.execute({
    capability,
    device: { deviceId: "dev-02", metadata: { xhsServePort: 17897 } },
    params: { selector: "any", index: 0 },
    leaseAuthorization: { leaseId: "lease-a", token: "token-a", deviceId: "dev-02" },
  });
  assert.deepEqual(calls, [{ action: "openFeedNote", selector: "any", index: 0 }]);
  assert.deepEqual(await adapter.verify({ capability, execution }), { ok: true, mode: "state" });
  assert.equal(adapter.buildExplicitObservationReceipt({ capability, execution }).targetFingerprint, "b".repeat(64));
});

test("real serve switch exposes only the bounded openFeedNote method", async (t) => {
  const calls = [];
  const server = serve(0, {
    adb: "offline-test-adb",
    serial: "offline-test-runtime",
    authorize: async () => ({ authorized: true }),
    operatorFactory: async () => ({
      async openFeedNote(input) {
        calls.push(input);
        return { ok: true, targetFingerprint: "b".repeat(64) };
      },
      metricsSummary() { return {}; },
    }),
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, "listening");
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "openFeedNote", selector: "any", index: 2 }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).result.ok, true);
  assert.deepEqual(calls, [{ selector: "any", index: 2 }]);
});

test("serve retries lazy operator initialization after a failed factory", async (t) => {
  let factoryCalls = 0;
  const server = serve(0, {
    adb: "offline-test-adb",
    serial: "offline-test-runtime",
    authorize: async () => ({ authorized: true }),
    errorLogger: () => {},
    operatorFactory: async () => {
      factoryCalls += 1;
      if (factoryCalls === 1) throw new Error("transient warm-up failure");
      return {
        async openFeedNote() { return { ok: true, targetFingerprint: "b".repeat(64) }; },
        metricsSummary() { return {}; },
      };
    },
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, "listening");
  const { port } = server.address();
  const request = () => fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "openFeedNote", selector: "any" }),
  });

  assert.equal((await request()).status, 500);
  const recovered = await request();
  assert.equal(recovered.status, 200);
  assert.equal((await recovered.json()).result.ok, true);
  assert.equal(factoryCalls, 2);
});

test("serve shares one in-flight lazy operator initialization across concurrent requests", async (t) => {
  let factoryCalls = 0;
  let releaseFactory;
  const factoryGate = new Promise((resolve) => { releaseFactory = resolve; });
  const server = serve(0, {
    adb: "offline-test-adb",
    serial: "offline-test-runtime",
    authorize: async () => ({ authorized: true }),
    operatorFactory: async () => {
      factoryCalls += 1;
      await factoryGate;
      return {
        async openFeedNote() { return { ok: true, targetFingerprint: "b".repeat(64) }; },
        metricsSummary() { return {}; },
      };
    },
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, "listening");
  const { port } = server.address();
  const request = () => fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "openFeedNote", selector: "any" }),
  });

  const first = request();
  const second = request();
  await new Promise((resolve) => setImmediate(resolve));
  releaseFactory();
  const responses = await Promise.all([first, second]);
  assert.deepEqual(responses.map((response) => response.status), [200, 200]);
  assert.equal(factoryCalls, 1);
});

test("serve records a redacted structured openFeedNote runtime error", async (t) => {
  const errors = [];
  const server = serve(0, {
    adb: "offline-test-adb",
    serial: "offline-test-runtime",
    authorize: async () => ({ authorized: true }),
    errorLogger: (entry) => errors.push(entry),
    operatorFactory: async () => ({
      async openFeedNote() {
        const error = new Error("launcher failed for offline-test-runtime token=top-secret");
        error.code = "ADB_SHELL_TIMEOUT";
        throw error;
      },
      metricsSummary() { return {}; },
    }),
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, "listening");
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "openFeedNote", selector: "any" }),
  });
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.deepEqual(body.error, {
    code: "ADB_SHELL_TIMEOUT",
    step: "openFeedNote",
    message: "launcher failed for [runtime] token=[redacted]",
  });
  assert.deepEqual(errors, [{
    event: "fast-operator.request-error",
    action: "openFeedNote",
    step: "openFeedNote",
    errorCode: "ADB_SHELL_TIMEOUT",
    message: "launcher failed for [runtime] token=[redacted]",
  }]);
  assert.doesNotMatch(JSON.stringify({ body, errors }), /offline-test-runtime|top-secret/);
});
