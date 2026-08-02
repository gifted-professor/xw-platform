import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

test("navigation card opening uses a one-shot tap and leaves the persistent shell untouched", async () => {
  const operator = Object.create(FastOperator.prototype);
  const calls = [];
  operator.metrics = { taps: 0 };
  operator.session = {
    oneShotShell: async (command) => { calls.push(`oneShot:${command}`); return ""; },
    exec: async () => { calls.push("persistent"); throw new Error("persistent navigation tap must not run"); },
  };
  operator.currentFocus = async () => ({ package: "com.xingin.xhs", activity: "NoteDetailActivity" });

  const result = await operator.openCard({ cover: { center: [120, 340] } });
  assert.deepEqual(result, { opened: true, activity: "NoteDetailActivity" });
  assert.equal(operator.metrics.taps, 1);
  assert.deepEqual(calls, ["oneShot:input tap 120 340"]);
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

test("dump uses a one-shot shell before the persistent-shell fallback", async () => {
  const operator = Object.create(FastOperator.prototype);
  operator.metrics = { dumps: 0, totalDumpMs: 0 };
  operator.session = {
    execOut: async () => { throw new Error("exec-out unavailable"); },
    oneShotShell: async () => (
      '<hierarchy rotation="0"><node class="android.widget.FrameLayout" '
      + 'bounds="[0,0][1080,2400]" clickable="false" /></hierarchy>'
    ),
    exec: async () => { throw new Error("persistent shell must not be used"); },
  };

  const doc = await operator.dump({ label: "one-shot-fallback", retries: 0 });
  assert.equal(doc.nodes.length, 1);
  assert.equal(doc._label, "one-shot-fallback");
  assert.equal(operator.metrics.dumps, 1);
});

test("read-only focus prefers one-shot shell before persistent fallback", async () => {
  const operator = Object.create(FastOperator.prototype);
  const calls = [];
  operator.session = {
    oneShotShell: async (command) => { calls.push(`oneShot:${command}`); return "mCurrentFocus=Window{42 u0 com.xingin.xhs/com.xingin.xhs.index.v2.IndexActivityV2}"; },
    exec: async () => { throw new Error("persistent focus fallback must not run"); },
  };
  assert.deepEqual(await operator.currentFocus(), {
    package: "com.xingin.xhs",
    activity: "com.xingin.xhs.index.v2.IndexActivityV2",
    raw: "mCurrentFocus=Window{42 u0 com.xingin.xhs/com.xingin.xhs.index.v2.IndexActivityV2}",
  });
  assert.deepEqual(calls, ["oneShot:dumpsys window"]);
});

test("read-only focus prefers exec-out dumpsys window when available", async () => {
  const operator = Object.create(FastOperator.prototype);
  const calls = [];
  operator.session = {
    execOut: async (args) => {
      calls.push(args);
      return Buffer.from("mCurrentFocus=Window{42 u0 com.xingin.xhs/com.xingin.xhs.index.v2.IndexActivityV2}");
    },
    oneShotShell: async () => { throw new Error("one-shot focus fallback must not run"); },
    exec: async () => { throw new Error("persistent focus fallback must not run"); },
  };
  assert.deepEqual(await operator.currentFocus(), {
    package: "com.xingin.xhs",
    activity: "com.xingin.xhs.index.v2.IndexActivityV2",
    raw: "mCurrentFocus=Window{42 u0 com.xingin.xhs/com.xingin.xhs.index.v2.IndexActivityV2}",
  });
  assert.deepEqual(calls, [["dumpsys", "window"]]);
});

test("read-only focus does not cascade to a second adb child after exec-out timeout", async () => {
  const operator = Object.create(FastOperator.prototype);
  const calls = [];
  operator.session = {
    execOut: async () => { calls.push("execOut"); throw new Error("exec-out timeout 8000ms"); },
    oneShotShell: async () => { calls.push("oneShot"); return "mCurrentFocus=Window{bad}"; },
  };
  assert.deepEqual(await operator.currentFocus(), { package: null, activity: null, raw: "" });
  assert.deepEqual(calls, ["execOut"]);
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

test("operator prefers a one-shot launcher so a Windows persistent shell cannot poison the serve", async () => {
  const operator = Object.create(FastOperator.prototype);
  const trace = [];
  const focuses = [
    { package: "com.android.launcher", activity: "com.android.launcher.Launcher" },
    { package: "com.xingin.xhs", activity: "com.xingin.xhs.index.v2.IndexActivityV2" },
  ];
  operator.currentFocus = async () => { trace.push("focus"); return focuses.shift(); };
  operator.session = {
    oneShotShell: async (command) => { trace.push(`oneShot:${command}`); return "Events injected: 1"; },
    exec: async () => { throw new Error("persistent launcher fallback must not run"); },
  };
  operator.feedDump = async () => { trace.push("feedDump"); return { nodes: [] }; };
  operator.feedCards = () => [{ cover: { center: [100, 200] } }];
  operator.openCard = async () => { trace.push("openCard"); return { opened: true, activity: "com.xingin.xhs.note.NoteDetailActivity" }; };
  operator.observeOpenNoteDetail = async () => ({
    ok: true,
    pageFingerprint: "a".repeat(64),
    targetFingerprint: "b".repeat(64),
    observedAt: "2026-07-30T16:00:00.000Z",
  });

  const result = await operator.openFeedNote({ selector: "any" });
  assert.equal(result.ok, true);
  assert.deepEqual(trace, [
    "focus",
    "oneShot:monkey -p com.xingin.xhs -c android.intent.category.LAUNCHER 1",
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
    async oneShotShell() { throw new Error("one-shot shell unavailable"); },
  };

  assert.deepEqual(await operator.openFeedNote({ selector: "any" }), {
    ok: false,
    notSent: true,
    step: "xhsLaunchFailed",
    errorCode: "XHS_LAUNCH_FAILED",
    message: "adb shell timeout while launching XHS",
  });
  assert.deepEqual(commands, [
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

test("note locator observation prefers a one-shot dumpsys activity top over the persistent shell", async () => {
  const operator = Object.create(FastOperator.prototype);
  const calls = [];
  operator.currentFocus = async () => ({
    package: "com.xingin.xhs",
    activity: "com.xingin.xhs.note.NoteDetailActivity",
  });
  operator.session = {
    oneShotShell: async (command) => {
      calls.push(`oneShot:${command}`);
      return "Hist #0: ActivityRecord{ com.xingin.xhs/.note.NoteDetailActivity }\\n"
        + "  Intent { dat=xhsdiscover://item/0123456789abcdef01234567 }";
    },
    exec: async () => {
      calls.push("persistent");
      throw new Error("persistent locator fallback must not run");
    },
  };

  const result = await operator.observeOpenNoteDetail();
  assert.equal(result.ok, true);
  assert.equal(result.targetFingerprint.length, 64);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^oneShot:dumpsys activity top/);
});

test("note locator observation prefers exec-out dumpsys activity top when available", async () => {
  const calls = [];
  const operator = Object.create(FastOperator.prototype);
  operator.currentFocus = async () => ({
    package: "com.xingin.xhs",
    activity: "com.xingin.xhs.note.NoteDetailActivity",
  });
  operator.session = {
    execOut: async (args) => {
      calls.push(args);
      return Buffer.from("ACTIVITY com.xingin.xhs/.note.NoteDetailActivity\\n"
        + "  Intent { dat=xhsdiscover://item/0123456789abcdef01234567 }");
    },
    oneShotShell: async () => { throw new Error("one-shot fallback must not run"); },
    exec: async () => { throw new Error("persistent locator fallback must not run"); },
  };

  const result = await operator.observeOpenNoteDetail();
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [["dumpsys", "activity", "top"]]);
});

test("mResumedActivity with a stable note intent URI yields a receipt", async () => {
  const operator = Object.create(FastOperator.prototype);
  operator.currentFocus = async () => ({
    package: "com.xingin.xhs",
    activity: "com.xingin.xhs.note.NoteDetailActivity",
  });
  operator.session = {
    execOut: async () => Buffer.from(
      "mResumedActivity: ActivityRecord{42 u0 com.xingin.xhs/.note.NoteDetailActivity t7}\n"
        + "  Intent { act=android.intent.action.VIEW dat=xhsdiscover://item/0123456789abcdef01234567 }\n",
    ),
  };
  const result = await operator.observeOpenNoteDetail();
  assert.equal(result.ok, true);
  assert.match(result.targetFingerprint, /^[a-f0-9]{64}$/);
});

test("mResumedActivity with a non-note dat URI stays fail-closed and secret-free", async () => {
  const diagnostics = [];
  const operator = Object.create(FastOperator.prototype);
  operator.diagnosticLogger = (entry) => diagnostics.push(entry);
  operator.currentFocus = async () => ({
    package: "com.xingin.xhs",
    activity: "com.xingin.xhs.note.NoteDetailActivity",
  });
  operator.session = {
    execOut: async () => Buffer.from(
      "mResumedActivity: ActivityRecord{42 u0 com.xingin.xhs/.note.NoteDetailActivity t7}\n"
        + "Intent { dat=https://private.example/token=private-token title=private-title }",
    ),
  };

  const result = await operator.observeOpenNoteDetail();
  assert.equal(result.ok, false);
  assert.equal(result.step, "stableNoteLocatorUnavailable");
  assert.equal(result.locatorShape.currentBlockFound, true);
  assert.deepEqual(result.locatorShape.fields.dat, { present: true, has24Hex: false });
  assert.deepEqual(diagnostics, [{
    event: "fast-operator.locator-shape",
    ...result.locatorShape,
  }]);
  assert.doesNotMatch(JSON.stringify(diagnostics), /private-title|private-token|private\.example/);
});

test("missing current activity block records only a redacted structural probe shape", async () => {
  const diagnostics = [];
  const operator = Object.create(FastOperator.prototype);
  operator.diagnosticLogger = (entry) => diagnostics.push(entry);
  operator.currentFocus = async () => ({
    package: "com.xingin.xhs",
    activity: "com.xingin.xhs.note.NoteDetailActivity",
  });
  operator.session = {
    execOut: async (args) => {
      if (args[0] === "dumpsys") return Buffer.from("TASK id=1\n  * Hist #1: ActivityRecord{old com.other/.PrivateActivity}\n");
      return Buffer.from(".");
    },
  };

  const result = await operator.observeOpenNoteDetail();
  assert.equal(result.ok, false);
  assert.equal(result.step, "stableNoteLocatorUnavailable");
  assert.equal(result.locatorShape.currentBlockFound, false);
  assert.deepEqual(diagnostics.at(-1), {
    event: "fast-operator.locator-probe-shape",
    activity: "NoteDetailActivity",
    attempts: [
      { transport: "exec-out:dumpsys activity top", outcome: "nonempty" },
    ],
    output: {
      byteBucket: "65-1024",
      lineBucket: "1-20",
      histHeaders: 1,
      activityHeaders: 0,
      resumedMarkers: 0,
      xhsComponentLines: 0,
      matchingActivityLines: 0,
      intentMarkers: 0,
    },
  });
  assert.doesNotMatch(JSON.stringify(diagnostics), /PrivateActivity|com\.other/);
});

test("empty dumpsys activity top falls through to cmd activity top", async () => {
  const calls = [];
  const operator = Object.create(FastOperator.prototype);
  operator.currentFocus = async () => ({
    package: "com.xingin.xhs",
    activity: "com.xingin.xhs.note.NoteDetailActivity",
  });
  operator.session = {
    execOut: async (args) => {
      calls.push(args);
      if (args[0] === "dumpsys") return Buffer.from("");
      return Buffer.from(
        "ACTIVITY com.xingin.xhs/.note.NoteDetailActivity\n"
          + "  Intent { dat=xhsdiscover://item/0123456789abcdef01234567 }",
      );
    },
  };
  const result = await operator.observeOpenNoteDetail();
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [["dumpsys", "activity", "top"], ["cmd", "activity", "top"]]);
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

test("serve preserves a secret-free locator shape for a graceful stable-locator rejection", async (t) => {
  const diagnostics = [];
  const operator = Object.create(FastOperator.prototype);
  operator.diagnosticLogger = (entry) => diagnostics.push(entry);
  operator.ensureXhsFeed = async () => ({ ok: true, activity: "com.xingin.xhs.index.v2.IndexActivityV2" });
  operator.feedDump = async () => ({ nodes: [] });
  operator.feedCards = () => [{ cover: { center: [100, 200] } }];
  operator.openCard = async () => ({ opened: true, activity: "com.xingin.xhs.note.NoteDetailActivity" });
  operator.currentFocus = async () => ({ package: "com.xingin.xhs", activity: "com.xingin.xhs.note.NoteDetailActivity" });
  operator.session = { exec: async () => "ACTIVITY com.xingin.xhs/.note.NoteDetailActivity Intent { act=android.intent.action.MAIN }" };
  operator.metricsSummary = () => ({});
  const server = serve(0, {
    adb: "offline-test-adb",
    serial: "offline-test-runtime",
    authorize: async () => ({ authorized: true }),
    errorLogger: (entry) => diagnostics.push(entry),
    operatorFactory: async () => operator,
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, "listening");
  const response = await fetch(`http://127.0.0.1:${server.address().port}/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "openFeedNote", selector: "any" }),
  });
  assert.equal(response.status, 200);
  const locatorShape = {
    activity: "NoteDetailActivity",
    currentBlockFound: true,
    fields: {
      dat: { present: false, has24Hex: false },
      clip: { present: false, has24Hex: false },
      mReferrer: { present: false, has24Hex: false },
      extrasNoteId: { present: false, has24Hex: false },
    },
    generic24Count: 0,
  };
  assert.deepEqual((await response.json()).result, {
    ok: false,
    notSent: true,
    step: "stableNoteLocatorUnavailable",
    locatorShape,
  });
  assert.deepEqual(diagnostics, [{
    event: "fast-operator.locator-shape",
    ...locatorShape,
  }]);
});

test("a closed persistent adb shell is poisoned immediately instead of hanging the next command", () => {
  const root = mkdtempSync(join(tmpdir(), "fast-operator-child-close-"));
  try {
    const fakeAdb = join(root, "fake-adb.mjs");
    const harness = join(root, "harness.mjs");
    writeFileSync(fakeAdb, `#!/usr/bin/env node
if (process.argv.length > 5) process.exit(0);
process.stdin.setEncoding("utf8");
let commandCount = 0;
process.stdin.on("data", (chunk) => {
  commandCount += 1;
  const marker = String(chunk).match(/echo (__FO_END_[0-9]+__)/)?.[1];
  if (commandCount === 1 && marker) process.stdout.write("fastop-ready\\n" + marker);
  if (commandCount === 2) setTimeout(() => process.exit(0), 10);
});
`);
    chmodSync(fakeAdb, 0o755);
    writeFileSync(harness, `
import { FastOperator } from ${JSON.stringify(new URL("../scripts/fast-operator.mjs", import.meta.url).href)};
const op = new FastOperator({
  adbPath: ${JSON.stringify(fakeAdb)},
  serial: "test-runtime",
  diagnosticLogger: (entry) => console.log(JSON.stringify(entry)),
});
await op.start();
const startedAt = Date.now();
let pendingError = null;
try { await op.session.exec("pending-command", 30000); }
catch (error) { pendingError = error.message; }
await op.session.start();
console.log(JSON.stringify({ survived: true, pendingError, elapsedMs: Date.now() - startedAt }));
await op.close();
`);
    const child = spawnSync(process.execPath, [harness], { encoding: "utf8", timeout: 3000 });
    assert.equal(child.signal, null, `child timed out: ${child.stderr}`);
    assert.equal(child.status, 0, `child process crashed: ${child.stderr}`);
    assert.match(child.stdout, /"survived":true/);
    assert.match(child.stdout, /adb shell poisoned \(process\.exit\)/);
    assert.match(child.stdout, /"event":"fast-operator\.transport-error"/);
    assert.match(child.stdout, /"source":"process\.exit"/);
    assert.match(child.stdout, /"errorCode":"ADB_SHELL_EXITED"/);
    const elapsedMs = Number(child.stdout.match(/"elapsedMs":(\d+)/)?.[1]);
    assert.ok(elapsedMs < 1000, `pending exec rejected too slowly: ${elapsedMs}ms`);
    assert.doesNotMatch(child.stdout, /test-runtime|fake-adb|fast-operator-child-close/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
