import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createXhsAdapter } from "../apps/xhs/adapter.mjs";
import {
  restoreXhsPublishNoSave,
  runXhsPublishEditDryRun,
} from "../apps/xhs/publish-edit-dry-run.mjs";
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

test("transport workflow rejects invalid caption before any Xiaowei request", async () => {
  let requests = 0;
  const output = await runXhsPublishEditDryRun({
    transport: { invoke: async () => { requests += 1; } },
    device: { runtimeId: "runtime-01" },
    caption: "   ",
  });
  assert.equal(output.ok, false);
  assert.equal(output.step, "captionInvalid");
  assert.equal(output.finalCommit, false);
  assert.equal(output.paymentTransport, 0);
  assert.equal(requests, 0);
});

test("transport cleanup can resolve a discard control on a non-self-closing parent node", async () => {
  const serial = "runtime-01";
  let focusCount = 0;
  const taps = [];
  const xml = [
    '<hierarchy rotation="0">',
    '<node text="不保存" content-desc="" class="android.widget.FrameLayout" package="com.xingin.xhs" clickable="true" bounds="[40,1900][360,2050]">',
    '<node text="" content-desc="" class="android.widget.ImageView" package="com.xingin.xhs" clickable="false" bounds="[60,1920][100,1960]"/>',
    "</node>",
    "</hierarchy>",
  ].join("");
  const transport = {
    async invoke(request) {
      const command = request.data.command;
      if (command.includes("dumpsys window")) {
        focusCount += 1;
        return { code: 10000, data: { [serial]: focusCount === 1
          ? "mCurrentFocus=Window{1 u0 com.xingin.xhs/com.xingin.capa.post.platform.activity.CapaPostNotePlatformActivity}"
          : "mCurrentFocus=Window{2 u0 com.xingin.xhs/com.xingin.xhs.index.v2.IndexActivityV2}" } };
      }
      if (command.startsWith("base64 ")) return { code: 10000, data: { [serial]: Buffer.from(xml).toString("base64") } };
      if (command.startsWith("input tap ")) taps.push(command);
      if (command.includes("settings get secure")) return { code: 10000, data: { [serial]: "com.sohu.inputmethod.sogou.xiaomi/.SogouIME" } };
      return { code: 10000, data: { [serial]: "" } };
    },
  };

  const output = await restoreXhsPublishNoSave({ transport, device: { runtimeId: serial } });
  assert.equal(output.ok, true);
  assert.deepEqual(taps, ["input tap 200 1975"]);
});

test("transport cleanup repairs UTF-16LE Chinese attribute bytes inside ASCII XML", async () => {
  const serial = "runtime-01";
  let focusCount = 0;
  const taps = [];
  const xmlBytes = Buffer.concat([
    Buffer.from('<hierarchy rotation="0"><node text="', "ascii"),
    Buffer.from("不保存并退出", "utf16le"),
    Buffer.from('" class="android.widget.TextView" package="com.xingin.xhs" clickable="true" bounds="[100,1800][500,2000]"/></hierarchy>', "ascii"),
  ]);
  const transport = {
    async invoke(request) {
      const command = request.data.command;
      if (command.includes("dumpsys window")) {
        focusCount += 1;
        const activity = focusCount === 1
          ? "com.xingin.capa.post.platform.activity.CapaPostNotePlatformActivity"
          : "com.xingin.xhs.index.v2.IndexActivityV2";
        return { code: 10000, data: { [serial]: `mCurrentFocus=Window{1 u0 com.xingin.xhs/${activity}}` } };
      }
      if (command.startsWith("base64 ")) return { code: 10000, data: { [serial]: xmlBytes.toString("base64") } };
      if (command.startsWith("input tap ")) taps.push(command);
      if (command.includes("settings get secure")) return { code: 10000, data: { [serial]: "com.sohu.inputmethod.sogou.xiaomi/.SogouIME" } };
      return { code: 10000, data: { [serial]: "" } };
    },
  };

  const output = await restoreXhsPublishNoSave({ transport, device: { runtimeId: serial } });
  assert.equal(output.ok, true);
  assert.deepEqual(taps, ["input tap 300 1900"]);
  assert.equal(output.trace.some((entry) => entry.discard === "不保存并退出"), true);
});

test("transport cleanup returns to the editor but never taps save-and-exit", async () => {
  const serial = "runtime-01";
  let focusCount = 0;
  let dumpCount = 0;
  const taps = [];
  const saveMenuXml = [
    '<hierarchy rotation="0">',
    '<node text="返回编辑" class="android.widget.TextView" package="com.xingin.xhs" clickable="true" bounds="[100,700][500,900]"/>',
    '<node text="保存并退出" class="android.widget.TextView" package="com.xingin.xhs" clickable="true" bounds="[100,900][500,1100]"/>',
    "</hierarchy>",
  ].join("");
  const discardXml = '<hierarchy rotation="0"><node text="不保存" class="android.widget.TextView" package="com.xingin.xhs" clickable="true" bounds="[100,1800][500,2000]"/></hierarchy>';
  const transport = {
    async invoke(request) {
      const command = request.data.command;
      if (command.includes("dumpsys window")) {
        focusCount += 1;
        const activity = focusCount <= 2
          ? "com.xingin.capa.post.platform.activity.CapaPostNotePlatformActivity"
          : "com.xingin.xhs.index.v2.IndexActivityV2";
        return { code: 10000, data: { [serial]: `mCurrentFocus=Window{1 u0 com.xingin.xhs/${activity}}` } };
      }
      if (command.startsWith("base64 ")) {
        dumpCount += 1;
        return { code: 10000, data: { [serial]: Buffer.from(dumpCount === 1 ? saveMenuXml : discardXml).toString("base64") } };
      }
      if (command.startsWith("input tap ")) taps.push(command);
      if (command.includes("settings get secure")) return { code: 10000, data: { [serial]: "com.sohu.inputmethod.sogou.xiaomi/.SogouIME" } };
      return { code: 10000, data: { [serial]: "" } };
    },
  };

  const output = await restoreXhsPublishNoSave({ transport, device: { runtimeId: serial } });
  assert.equal(output.ok, true);
  assert.deepEqual(taps, ["input tap 300 800", "input tap 300 1900"]);
  assert.equal(output.trace.some((entry) => entry.observedNeverTapped === "保存并退出"), true);
  assert.equal(output.trace.some((entry) => entry.safeNavigation === "返回编辑"), true);
});

test("transport cleanup observes commit controls but taps only the exact discard branch", async () => {
  const serial = "runtime-01";
  const commands = [];
  let focusCount = 0;
  const xml = [
    '<hierarchy rotation="0">',
    '<node text="发布" content-desc="" class="android.widget.TextView" package="com.xingin.xhs" clickable="true" bounds="[800,2100][1060,2250]"/>',
    '<node text="不保存" content-desc="" class="android.widget.TextView" package="com.xingin.xhs" clickable="true" bounds="[40,1900][360,2050]"/>',
    "</hierarchy>",
  ].join("");
  const transport = {
    async invoke(request) {
      assert.equal(request.devices, serial);
      if (request.action === "selectIme") return { code: 10000 };
      assert.equal(request.action, "adb_shell");
      const command = request.data.command;
      commands.push(command);
      if (command.includes("dumpsys window")) {
        focusCount += 1;
        return {
          code: 10000,
          data: {
            [serial]: focusCount === 1
              ? "mCurrentFocus=Window{1 u0 com.xingin.xhs/com.xingin.capa.post.platform.activity.CapaPostNotePlatformActivity}"
              : "mCurrentFocus=Window{2 u0 com.xingin.xhs/com.xingin.xhs.index.v2.IndexActivityV2}",
          },
        };
      }
      if (command.startsWith("base64 ")) return { code: 10000, data: { [serial]: Buffer.from(xml).toString("base64") } };
      if (command.includes("settings get secure")) return { code: 10000, data: { [serial]: "com.sohu.inputmethod.sogou.xiaomi/.SogouIME" } };
      return { code: 10000, data: { [serial]: "" } };
    },
  };

  const output = await restoreXhsPublishNoSave({ transport, device: { runtimeId: serial } });
  assert.equal(output.ok, true);
  assert.equal(output.restored, true);
  assert.equal(output.published, false);
  assert.equal(output.savedDraft, false);
  const taps = commands.filter((command) => command.startsWith("input tap "));
  assert.deepEqual(taps, ["input tap 200 1975"]);
  assert.equal(taps.includes("input tap 930 2175"), false, "publish must remain observation-only");
});

test("transport recovery may bring XHS to front once before applying the home allowlist", async () => {
  const serial = "runtime-01";
  const commands = [];
  let focusCount = 0;
  const transport = {
    async invoke(request) {
      assert.equal(request.action, "adb_shell");
      const command = request.data.command;
      commands.push(command);
      if (command.includes("dumpsys window")) {
        focusCount += 1;
        return {
          code: 10000,
          data: {
            [serial]: focusCount === 1
              ? "mCurrentFocus=Window{1 u0 com.miui.home/com.miui.home.launcher.Launcher}"
              : "mCurrentFocus=Window{2 u0 com.xingin.xhs/com.xingin.xhs.index.v2.IndexActivityV2}",
          },
        };
      }
      if (command.startsWith("base64 ")) {
        const homeXml = '<hierarchy rotation="0"><node text="首页" class="android.widget.TextView" package="com.xingin.xhs" clickable="true" bounds="[0,2200][200,2400]"/></hierarchy>';
        return { code: 10000, data: { [serial]: Buffer.from(homeXml).toString("base64") } };
      }
      if (command.includes("settings get secure")) {
        return { code: 10000, data: { [serial]: "com.sohu.inputmethod.sogou.xiaomi/.SogouIME" } };
      }
      return { code: 10000, data: { [serial]: "" } };
    },
  };

  const output = await restoreXhsPublishNoSave({ transport, device: { runtimeId: serial } });
  assert.equal(output.ok, true);
  assert.equal(output.restored, true);
  assert.equal(commands.filter((command) => command.startsWith("monkey -p ")).length, 1);
  assert.equal(commands.some((command) => command.includes("force-stop")), false);
});

test("transport recovery resumes an existing XHS edit only to discard it and never taps save draft", async () => {
  const serial = "runtime-01";
  const taps = [];
  let focusCount = 0;
  let dumpCount = 0;
  const promptXml = [
    '<hierarchy rotation="0">',
    '<node text="继续编辑图文笔记吗？" class="android.widget.TextView" package="com.xingin.xhs" clickable="false" bounds="[100,600][980,800]"/>',
    '<node text="存草稿" class="android.widget.TextView" package="com.xingin.xhs" clickable="true" bounds="[100,900][480,1050]"/>',
    '<node text="去编辑" class="android.widget.TextView" package="com.xingin.xhs" clickable="true" bounds="[600,900][980,1050]"/>',
    "</hierarchy>",
  ].join("");
  const editorXml = [
    '<hierarchy rotation="0">',
    '<node text="不保存并退出" class="android.widget.TextView" package="com.xingin.xhs" clickable="true" bounds="[100,1800][500,2000]"/>',
    "</hierarchy>",
  ].join("");
  const homeXml = '<hierarchy rotation="0"><node text="首页" class="android.widget.TextView" package="com.xingin.xhs" clickable="true" bounds="[0,2200][200,2400]"/></hierarchy>';
  const transport = {
    async invoke(request) {
      const command = request.data.command;
      if (command.includes("dumpsys window")) {
        focusCount += 1;
        const component = focusCount === 1
          ? "com.xingin.xhs/com.xingin.xhs.index.v2.IndexActivityV2"
          : focusCount === 2
            ? "com.xingin.xhs/com.xingin.capa.post.platform.activity.CapaPostNotePlatformActivity"
            : "com.xingin.xhs/com.xingin.xhs.index.v2.IndexActivityV2";
        return { code: 10000, data: { [serial]: `mCurrentFocus=Window{1 u0 ${component}}` } };
      }
      if (command.startsWith("base64 ")) {
        dumpCount += 1;
        const xml = dumpCount === 1 ? promptXml : dumpCount === 2 ? editorXml : homeXml;
        return { code: 10000, data: { [serial]: Buffer.from(xml).toString("base64") } };
      }
      if (command.startsWith("input tap ")) taps.push(command);
      if (command.includes("settings get secure")) return { code: 10000, data: { [serial]: "com.sohu.inputmethod.sogou.xiaomi/.SogouIME" } };
      return { code: 10000, data: { [serial]: "" } };
    },
  };

  const output = await restoreXhsPublishNoSave({ transport, device: { runtimeId: serial } });
  assert.equal(output.ok, true);
  assert.deepEqual(taps, ["input tap 790 975", "input tap 300 1900"]);
  assert.equal(taps.includes("input tap 290 975"), false, "存草稿 must remain observation-only");
  assert.equal(output.trace.some((entry) => entry.observedNeverTapped === "存草稿"), true);
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
  const calls = [];
  const transport = { invoke: async () => { throw new Error("adapter test must use the injected workflow"); } };
  const adapter = createXhsAdapter({
    transport,
    publishWorkflow: async (input) => {
      calls.push({ type: "execute", input });
      return {
        ok: true,
        captionLanded: true,
        postButtonObserved: true,
        published: false,
        savedDraft: false,
        finalCommit: false,
        paymentTransport: 0,
        restored: true,
      };
    },
    restorePublishWorkflow: async (input) => {
      calls.push({ type: "restore", input });
      return { ok: true, restored: true, published: false, savedDraft: false };
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
  assert.equal(calls.length, 2);
  assert.equal(calls[0].type, "execute");
  assert.equal(calls[0].input.transport, transport);
  assert.equal(calls[0].input.caption, "测试");
  assert.equal(calls[1].type, "restore");
  assert.equal(calls[1].input.transport, transport);
  assert.equal(calls[1].input.maxSteps, 10);
});
