import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createXhsAdapter } from "../apps/xhs/adapter.mjs";
import { CapabilityRegistry } from "../control-plane/lib/capability-registry.mjs";
import { FastOperator, serve } from "../scripts/fast-operator.mjs";

const registry = CapabilityRegistry.load(fileURLToPath(new URL("../apps", import.meta.url)));

function node(label, bounds, { className = "android.widget.TextView", clickable = true, text = label, contentDesc = "" } = {}) {
  return { text, contentDesc, className, clickable, bounds };
}

function doc(nodes, hierarchy = "") {
  return { nodes, _hierarchyXml: hierarchy };
}

test("publish edit dry-run capability is a bounded replay-safe job with no final commit", () => {
  const capability = registry.require("xhs.publish.edit_dry_run");
  assert.equal(capability.implementation.adapter, "xhs");
  assert.equal(capability.implementation.action, "publishEditDryRun");
  assert.equal(capability.idempotency, "replay_safe");
  assert.equal(capability.effect.class, "reversible");
  assert.equal(capability.automationPolicy.mode, "automatic");
  assert.deepEqual(capability.resources, ["device", "transport:xiaowei:22222"]);
});

test("bounded publish edit workflow fills caption, observes publish, and exits without tapping commit", async () => {
  const caption = "并发链路测试，不会发布";
  const publishButton = node("发布", [820, 2140, 1060, 2250]);
  const dumps = [
    doc([node("发布", [460, 2200, 620, 2380], { contentDesc: "发布", text: "" })]),
    doc([node("从相册选择", [220, 1500, 860, 1640])]),
    doc([node("", [20, 300, 340, 640], { className: "android.widget.FrameLayout", text: "" })]),
    doc([node("下一步(1)", [820, 2180, 1060, 2320])]),
    doc([
      node("", [40, 520, 1040, 1100], { className: "android.widget.EditText", text: "" }),
      publishButton,
    ]),
    doc([
      node(caption, [40, 520, 1040, 1100], { className: "android.widget.EditText" }),
      publishButton,
    ], `<hierarchy text="${caption}"></hierarchy>`),
  ];
  const taps = [];
  let imeRestored = false;
  const operator = new FastOperator({
    adbPath: "offline",
    serial: "offline",
    wait: async () => {},
  });
  operator.navigationShell = async () => "";
  operator.navigationTap = async (x, y) => { taps.push([x, y]); };
  operator.dump = async () => {
    const next = dumps.shift();
    if (!next) throw new Error("unexpected dump");
    return next;
  };
  operator.inputTextViaXiaowei = async (text) => {
    assert.equal(text, caption);
    return { audit: { inputAccepted: true }, restore: async () => { imeRestored = true; } };
  };
  const focuses = [
    "com.xingin.xhs.index.v2.IndexActivityV2",
    "com.xingin.xhs.index.v2.IndexActivityV2",
    "com.xingin.capa.lib.entrancev2.CapaAlbumActivity",
    "com.xingin.capa.lib.entrancev2.CapaAlbumActivity",
    "com.xingin.capa.post.platform.activity.CapaPostNotePlatformActivity",
    "com.xingin.xhs.index.v2.IndexActivityV2",
  ];
  operator.currentFocus = async () => ({ package: "com.xingin.xhs", activity: focuses.shift() });

  const output = await operator.publishEditDryRun({ caption });
  assert.equal(output.ok, true);
  assert.equal(output.captionLanded, true);
  assert.equal(output.postButtonObserved, true);
  assert.equal(output.published, false);
  assert.equal(output.savedDraft, false);
  assert.equal(output.finalCommit, false);
  assert.equal(output.paymentTransport, 0);
  assert.equal(output.restored, true);
  assert.equal(imeRestored, true);
  assert.equal(dumps.length, 0);
  assert.equal(focuses.length, 0);
  assert.equal(taps.some(([x, y]) => x === 940 && y === 2195), false, "publish button must never be tapped");
});

test("publish dry-run fails closed without tapping when the foreground app is not XHS", async () => {
  const taps = [];
  const shell = [];
  const operator = new FastOperator({ adbPath: "offline", serial: "offline", wait: async () => {} });
  operator.navigationShell = async (command) => { shell.push(command); };
  operator.navigationTap = async (x, y) => { taps.push([x, y]); };
  operator.dump = async () => doc([node("发布", [460, 2200, 620, 2380])]);
  operator.currentFocus = async () => ({ package: "com.example.other", activity: "OtherActivity" });

  const output = await operator.publishEditDryRun({ caption: "不会发布" });
  assert.equal(output.ok, false);
  assert.equal(output.restored, false);
  assert.equal(output.published, false);
  assert.equal(output.savedDraft, false);
  assert.deepEqual(taps, []);
  assert.equal(shell.length, 2, "only force-stop and bounded launch may run before the app identity check");
});

test("IME probes stay on bounded one-shot ADB and never start the persistent shell", async () => {
  const calls = [];
  const operator = new FastOperator({ adbPath: "offline", serial: "offline", wait: async () => {} });
  operator.session.oneShotShell = async (command, timeoutMs) => {
    calls.push({ command, timeoutMs });
    return "com.sohu.inputmethod.sogou.xiaomi/.SogouIME\r\n";
  };
  operator.session.exec = async () => {
    throw new Error("persistent shell must not be opened for an IME probe");
  };

  assert.equal(await operator.currentIme(), "com.sohu.inputmethod.sogou.xiaomi/.SogouIME");
  assert.deepEqual(calls, [{ command: "settings get secure default_input_method", timeoutMs: 8000 }]);
});

test("focus falls back to the exact resumed activity when mCurrentFocus is absent", async () => {
  const operator = new FastOperator({ adbPath: "offline", serial: "offline", wait: async () => {} });
  operator.session.execOut = async (args) => Buffer.from(
    args.join(" ") === "dumpsys window"
      ? "mCurrentFocus=null\n"
      : "mResumedActivity: ActivityRecord{a1 u0 com.xingin.xhs/.index.v2.IndexActivityV2 t12}\n",
  );
  operator.session.oneShotShell = async () => "";

  assert.deepEqual(await operator.currentFocus(), {
    package: "com.xingin.xhs",
    activity: "com.xingin.xhs.index.v2.IndexActivityV2",
    raw: "mResumedActivity: ActivityRecord{a1 u0 com.xingin.xhs/.index.v2.IndexActivityV2 t12}\n",
  });
});

test("serve exposes the catalog-bound dry-run action without accepting primitive arrays", async (t) => {
  const calls = [];
  const server = serve(0, {
    adb: "offline-test-adb",
    serial: "offline-test-runtime",
    authorize: async () => ({ authorized: true }),
    operatorFactory: async () => ({
      async publishEditDryRun(input) {
        calls.push(input);
        return { ok: true, published: false, savedDraft: false };
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
    body: JSON.stringify({
      action: "publishEditDryRun",
      caption: "只传业务参数",
      actions: [{ primitive: "tap", x: 1, y: 1 }],
    }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [{ caption: "只传业务参数" }]);
});

test("XHS adapter verifies all no-commit invariants and performs idempotent cleanup", async () => {
  const requests = [];
  const adapter = createXhsAdapter({
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      const result = body.action === "publishEditDryRun"
        ? {
            ok: true,
            captionLanded: true,
            postButtonObserved: true,
            published: false,
            savedDraft: false,
            finalCommit: false,
            paymentTransport: 0,
            restored: true,
          }
        : body.action === "abortPublishNoSave"
          ? { ok: true, restored: true, published: false, savedDraft: false }
          : { restored: true };
      return new Response(JSON.stringify({ ok: true, result, metrics: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const capability = registry.require("xhs.publish.edit_dry_run");
  const device = {
    deviceId: "device-01",
    runtimeId: "runtime-01",
    metadata: { xhsServePort: 17895 },
  };
  const leaseAuthorization = { leaseId: "lease-01", token: "secret", deviceId: "device-01" };
  const execution = await adapter.execute({ capability, device, params: { caption: "测试" }, leaseAuthorization });
  assert.equal((await adapter.verify({ capability, params: { caption: "测试" }, execution })).ok, true);
  assert.equal((await adapter.restore({ capability, device, leaseAuthorization })).ok, true);
  assert.deepEqual(requests.map((request) => request.action), [
    "publishEditDryRun",
    "abortPublishNoSave",
    "restoreIme",
  ]);
});
