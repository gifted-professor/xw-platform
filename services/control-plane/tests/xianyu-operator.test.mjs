import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APP_NUMPAD_SETTLE_MS,
  boundsClose,
  createStepSupervisor,
  descriptionContains,
  findDiscardWithoutSaving,
  findDescriptionField,
  findFreightOptionBlock,
  findHomeTab,
  findPublishEntry,
  findSellTab,
  findSkuRecoveryClose,
  findSkuBatchEditControls,
  freightOptionTarget,
  freightRowVerified,
  getScreenHeight,
  isBottomTabSelected,
  isEmptyDescriptionField,
  isPublishCompose,
  isRecoverySafeMain,
  loadLayoutProfile,
  normalizeXwInputText,
  parseDisplayResolution,
  parseAllUiNodes,
  probeBottomTabs,
  recoverDiscardDryRun,
  saveLayoutProfile,
  semanticSnapshot,
} from "../scripts/xianyu-operator.mjs";

test("parseDisplayResolution uses the effective override size", () => {
  assert.deepEqual(parseDisplayResolution("Physical size: 1080x2400\nOverride size: 720x1600"), [720, 1600]);
  assert.deepEqual(parseDisplayResolution("Physical size: 1080x2400"), [1080, 2400]);
  assert.equal(parseDisplayResolution("size unavailable"), null);
});

const skuRecoveryNodes = [
  { label: "设置宝贝规格", bounds: [0, 80, 1080, 180] },
  { label: "关闭,按钮", className: "android.widget.Button", clickable: true, bounds: [920, 84, 1050, 174] },
  { label: "添加规格类型", bounds: [40, 1500, 1040, 1600] },
  { label: "下一步 设置价格和库存,按钮", bounds: [40, 2160, 1040, 2280] },
];

test("SKU recovery close requires a unique, classified top-right close button", () => {
  const focus = { package: "com.taobao.idlefish", activity: "SkuActivity" };
  assert.equal(
    findSkuRecoveryClose(skuRecoveryNodes, { focus, resolution: [1080, 2400] }),
    skuRecoveryNodes[1],
  );
  assert.equal(findSkuRecoveryClose([
    ...skuRecoveryNodes,
    { ...skuRecoveryNodes[1], bounds: [800, 84, 900, 174] },
  ], { focus, resolution: [1080, 2400] }), null);
  assert.equal(findSkuRecoveryClose([
    { label: "关闭,按钮", className: "android.widget.Button", clickable: true, bounds: [920, 84, 1050, 174] },
  ], { focus, resolution: [1080, 2400] }), null);
});

test("recovery safe main requires MainActivity and the complete bottom bar", () => {
  const focus = {
    package: "com.taobao.idlefish",
    activity: "com.taobao.idlefish.maincontainer.activity.MainActivity",
  };
  assert.equal(isRecoverySafeMain({ focus, nodes: device02BottomTabs, resolution: [1080, 2400] }), true);
  assert.equal(isRecoverySafeMain({ focus, nodes: device02BottomTabs.slice(0, 4), resolution: [1080, 2400] }), false);
  assert.equal(isRecoverySafeMain({
    focus,
    nodes: [...device02BottomTabs, { label: "设置宝贝规格", bounds: [0, 80, 1080, 180] }],
    resolution: [1080, 2400],
  }), false);
  assert.equal(isRecoverySafeMain({
    focus: { ...focus, activity: "OtherActivity" },
    nodes: device02BottomTabs,
    resolution: [1080, 2400],
  }), false);
  assert.equal(isRecoverySafeMain({ focus, nodes: device02BottomTabs, resolution: null }), false);
});

function recoveryXml(nodes) {
  const escape = (value) => String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  return `<hierarchy>${nodes.map((node) => `<node text="" content-desc="${escape(node.label)}" class="${node.className || "android.view.View"}" clickable="${node.clickable === true}" bounds="[${node.bounds[0]},${node.bounds[1]}][${node.bounds[2]},${node.bounds[3]}]" />`).join("")}</hierarchy>`;
}

test("recoverDiscardDryRun handles the explicit discard dialog and verifies safe main", async () => {
  const discardDialog = [
    { label: "不保存", className: "android.widget.Button", clickable: true, bounds: [42, 2143, 524, 2248] },
    { label: "存草稿", className: "android.widget.Button", clickable: true, bounds: [556, 2143, 1038, 2248] },
  ];
  let state = "sku";
  const taps = [];
  const op = {
    serial: "device-02",
    transport: "gateway",
    async shellExec(command) { return command === "wm size" ? "Physical size: 1080x2400" : ""; },
    async currentFocus() {
      return state === "main"
        ? { package: "com.taobao.idlefish", activity: "com.taobao.idlefish.maincontainer.activity.MainActivity" }
        : { package: "com.taobao.idlefish", activity: "SkuActivity" };
    },
    async dumpXml() {
      return recoveryXml(state === "sku" ? skuRecoveryNodes : state === "dialog" ? discardDialog : device02BottomTabs);
    },
    async tap(x, y) {
      taps.push([x, y]);
      state = state === "sku" ? "dialog" : "main";
    },
    async capturePng(path) { return { path, bytes: 100, sha256: "a".repeat(64) }; },
  };
  const result = await recoverDiscardDryRun(op, { evidenceDir: "/tmp/xianyu-recovery-test" });
  assert.equal(result.ok, true);
  assert.equal(result.safeStateVerified, true);
  assert.equal(result.savedDraft, false);
  assert.equal(result.discard.step, "discarded-without-saving-from-recovery-dialog");
  assert.equal(taps.length, 2);
  assert.equal(result.evidenceFiles.some((file) => file.label === "xianyu-recovery-final"), true);
});

test("recoverDiscardDryRun performs zero taps when two fresh snapshots already show safe main", async () => {
  let taps = 0;
  const op = {
    serial: "device-02",
    transport: "gateway",
    async shellExec() { return "Physical size: 1080x2400"; },
    async currentFocus() {
      return {
        package: "com.taobao.idlefish",
        activity: "com.taobao.idlefish.maincontainer.activity.MainActivity",
      };
    },
    async dumpXml() { return recoveryXml(device02BottomTabs); },
    async tap() { taps += 1; },
    async capturePng(path) { return { path, bytes: 100, sha256: "c".repeat(64) }; },
  };
  const result = await recoverDiscardDryRun(op, { evidenceDir: "/tmp/xianyu-recovery-test" });
  assert.equal(result.ok, true);
  assert.equal(result.step, "already-safe-main");
  assert.equal(result.safeStateVerified, true);
  assert.equal(taps, 0);
  assert.equal(result.evidenceFiles.length, 2);
});

test("recoverDiscardDryRun returns structured failure and best-effort evidence on exception", async () => {
  const op = {
    serial: "device-02",
    transport: "gateway",
    async shellExec() { return "Physical size: 1080x2400"; },
    async currentFocus() { return { package: "com.taobao.idlefish", activity: "SkuActivity" }; },
    async dumpXml() { throw new Error("simulated dump failure"); },
    async capturePng(path) { return { path, bytes: 100, sha256: "b".repeat(64) }; },
  };
  const result = await recoverDiscardDryRun(op, { evidenceDir: "/tmp/xianyu-recovery-test" });
  assert.equal(result.ok, false);
  assert.equal(result.step, "exception");
  assert.equal(result.safeStateVerified, false);
  assert.equal(result.errorScreenshotCaptured, true);
  assert.equal(result.evidenceFiles.length, 1);
});

// 02 号机实测（density 440, 三键导航）：底栏 y 落在 2072–2175，旧硬编码 2180/2320 会 miss。
const device02BottomTabs = [
  { label: "闲鱼，未读消息数0，选中状态", bounds: [22, 2132, 218, 2175], clickable: true },
  { label: "深圳，未选中状态", bounds: [218, 2132, 415, 2175], clickable: true },
  { label: "卖闲置", bounds: [427, 2072, 653, 2175], clickable: true },
  { label: "消息，未读消息数8，未选中状态", bounds: [663, 2132, 860, 2175], clickable: true },
  { label: "我的，未选中状态", bounds: [860, 2132, 1058, 2175], clickable: true },
  // 瀑布流噪声：左下区域但 y 不够低，不能误命中
  { label: "闲鱼同款商品卡", bounds: [20, 1800, 280, 2000], clickable: true },
];

// 04 号机量级：手势导航，底栏更靠下
const device04BottomTabs = [
  { label: "闲鱼，未选中状态", bounds: [22, 2227, 218, 2370], clickable: true },
  { label: "卖闲置", bounds: [427, 2160, 653, 2370], clickable: true },
  { label: "消息，未选中状态", bounds: [663, 2227, 860, 2370], clickable: true },
];

test("semanticSnapshot keeps Flutter content-desc text", () => {
  const result = semanticSnapshot({ nodes: [
    { text: "", contentDesc: "卖闲置", bounds: [0, 2000, 300, 2200], clickable: true },
  ] });
  assert.equal(result[0].label, "卖闲置");
});

test("findPublishEntry never treats bare final publish as navigation", () => {
  const snapshot = [
    { label: "发布", bounds: [800, 0, 1080, 200], clickable: true },
    { label: "价格", bounds: [0, 800, 1080, 1000], clickable: true },
  ];
  assert.equal(findPublishEntry(snapshot), null);
});

test("findPublishEntry accepts non-clickable Flutter semantic nodes", () => {
  const target = { label: "发闲置", bounds: [300, 1800, 780, 2300], clickable: false };
  assert.equal(findPublishEntry([target]), target);
});

test("isPublishCompose requires description plus a commerce field", () => {
  assert.equal(isPublishCompose([{ label: "宝贝描述" }, { label: "价格" }, { label: "发布" }]), true);
  assert.equal(isPublishCompose([{ label: "发布" }]), false);
});

test("isPublishCompose accepts the validated compose layout when labels are mojibake", () => {
  assert.equal(isPublishCompose([
    { label: "鍙戝竷", className: "android.widget.Button", bounds: [880, 94, 1080, 178] },
    { label: "娣诲姞鍥剧墖", className: "android.widget.Button", bounds: [74, 257, 378, 561] },
    { label: "浠锋牸", className: "android.widget.Button", bounds: [74, 1511, 1006, 1658] },
  ]), true);
});

test("parseAllUiNodes keeps a clickable Flutter parent with children", () => {
  const xml = '<hierarchy><node text="" content-desc="描述一下宝贝" class="android.view.View" clickable="true" bounds="[74,575][1006,1121]"><node text="" content-desc="" class="android.view.View" clickable="false" bounds="[74,575][1006,1121]" /></node></hierarchy>';
  const result = parseAllUiNodes(xml);
  assert.equal(result.nodes.length, 2);
  assert.equal(result.nodes[0].contentDesc, "描述一下宝贝");
  assert.deepEqual(result.nodes[0].bounds, [74, 575, 1006, 1121]);
});

test("findDescriptionField and descriptionContains verify actual Flutter text", () => {
  const field = {
    label: "闲鱼发布页输入测试\n品牌型号、货品来源",
    className: "android.view.View",
    clickable: true,
    bounds: [74, 575, 1006, 1121],
  };
  assert.equal(findDescriptionField([field]), field);
  assert.equal(descriptionContains(field, "闲鱼发布页输入测试"), true);
  assert.equal(descriptionContains(field, "别的内容"), false);
  assert.equal(isEmptyDescriptionField({ label: "描述一下宝贝的品牌型号、货品来源..." }), true);
  assert.equal(isEmptyDescriptionField({ label: "用户已有的草稿内容" }), false);
});

test("findDiscardWithoutSaving selects only the explicit left discard action", () => {
  const discard = {
    label: "不保存",
    className: "android.widget.Button",
    clickable: true,
    bounds: [42, 2143, 524, 2248],
  };
  const save = {
    label: "存草稿",
    className: "android.widget.Button",
    clickable: true,
    bounds: [556, 2143, 1038, 2248],
  };
  assert.equal(findDiscardWithoutSaving([save, discard]), discard);
  assert.equal(findDiscardWithoutSaving([save]), null);
});

test("getScreenHeight derives height from max bounds y2", () => {
  assert.equal(getScreenHeight(device02BottomTabs), 2175);
  assert.equal(getScreenHeight([]), 0);
  assert.equal(getScreenHeight(null), 0);
});

test("findHomeTab / findSellTab use label + screen-height ratio on device 02 layout", () => {
  const home = findHomeTab(device02BottomTabs, { autoSave: false });
  const sell = findSellTab(device02BottomTabs, { autoSave: false });
  assert.equal(home?.label, "闲鱼，未读消息数0，选中状态");
  assert.deepEqual(home?.bounds, [22, 2132, 218, 2175]);
  assert.equal(sell?.label, "卖闲置");
  assert.deepEqual(sell?.bounds, [427, 2072, 653, 2175]);
  assert.equal(isBottomTabSelected(home), true);
});

test("findHomeTab / findSellTab still work on higher bottom-bar layouts", () => {
  const home = findHomeTab(device04BottomTabs, { autoSave: false });
  const sell = findSellTab(device04BottomTabs, { autoSave: false });
  assert.equal(home?.label, "闲鱼，未选中状态");
  assert.equal(sell?.label, "卖闲置");
  assert.equal(isBottomTabSelected(home), false);
});

test("probeBottomTabs extracts home/sell real bounds from snapshot", () => {
  const probe = probeBottomTabs(device02BottomTabs, getScreenHeight(device02BottomTabs));
  assert.deepEqual(probe.home?.bounds, [22, 2132, 218, 2175]);
  assert.deepEqual(probe.sell?.bounds, [427, 2072, 653, 2175]);
  assert.equal(probe.tabs.length >= 4, true);
  // 瀑布流噪声不应进 tabs
  assert.equal(probe.tabs.some((t) => /同款商品卡/.test(t.label)), false);
});

test("findHomeTab / findSellTab match profile bounds with ±20px tolerance", () => {
  const profile = {
    home: { bounds: [22, 2132, 218, 2175], label: "闲鱼" },
    sell: { bounds: [427, 2072, 653, 2175], label: "卖闲置" },
  };
  // 轻微抖动仍命中
  const jittered = [
    { label: "闲鱼，选中状态", bounds: [30, 2140, 210, 2180], clickable: true },
    { label: "卖闲置", bounds: [435, 2080, 645, 2185], clickable: true },
  ];
  const home = findHomeTab(jittered, { profile, autoSave: false });
  const sell = findSellTab(jittered, { profile, autoSave: false });
  assert.deepEqual(home?.bounds, [30, 2140, 210, 2180]);
  assert.deepEqual(sell?.bounds, [435, 2080, 645, 2185]);
  assert.equal(boundsClose([22, 2132, 218, 2175], [30, 2140, 210, 2180], 20), true);
  // 超出容差：profile miss 后可回落到 ratio；本例 y 太高 ratio 也 miss。
  const far = [
    { label: "闲鱼，选中状态", bounds: [22, 1000, 218, 1100], clickable: true },
    { label: "卖闲置", bounds: [427, 1000, 653, 1150], clickable: true },
  ];
  assert.equal(findHomeTab(far, { profile, autoSave: false }), null);
  assert.equal(findSellTab(far, { profile, autoSave: false }), null);
});

test("loadLayoutProfile / saveLayoutProfile round-trip to temp dir", () => {
  const dir = mkdtempSync(join(tmpdir(), "xianyu-layout-"));
  try {
    const serial = "test-serial-02";
    assert.equal(loadLayoutProfile(serial, { dir }), null);
    const probe = probeBottomTabs(device02BottomTabs, 2175);
    const path = saveLayoutProfile(serial, {
      capturedAt: "2026-07-25T00:00:00.000Z",
      screenH: probe.screenH,
      home: probe.home,
      sell: probe.sell,
      tabs: probe.tabs,
    }, { dir });
    assert.equal(path.endsWith("test-serial-02.json"), true);
    const loaded = loadLayoutProfile(serial, { dir });
    assert.deepEqual(loaded.home.bounds, [22, 2132, 218, 2175]);
    assert.deepEqual(loaded.sell.bounds, [427, 2072, 653, 2175]);
    const raw = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(raw.schemaVersion, 1);
    assert.ok(raw.updatedAt);

    // 无 profile 时 find* 兜底 ratio 并 autoSave
    const dir2 = mkdtempSync(join(tmpdir(), "xianyu-layout-auto-"));
    try {
      const home = findHomeTab(device02BottomTabs, { serial: "auto-02", dir: dir2, autoSave: true });
      assert.ok(home);
      const saved = loadLayoutProfile("auto-02", { dir: dir2 });
      assert.deepEqual(saved?.home?.bounds, [22, 2132, 218, 2175]);
      assert.deepEqual(saved?.sell?.bounds, [427, 2072, 653, 2175]);
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isBottomTabSelected distinguishes 选中 vs 未选中", () => {
  assert.equal(isBottomTabSelected({ label: "闲鱼，选中状态" }), true);
  assert.equal(isBottomTabSelected({ label: "闲鱼，未选中状态" }), false);
  assert.equal(isBottomTabSelected({ label: "消息，未读消息数8，未选中状态" }), false);
});

test("normalizeXwInputText collapses newlines for XwIME/Flutter input", () => {
  assert.equal(
    normalizeXwInputText("第一行\n第二行"),
    "第一行 第二行",
  );
  assert.equal(
    normalizeXwInputText("a\r\nb\n\nc"),
    "a b c",
  );
  assert.equal(normalizeXwInputText("  单行  "), "单行");
});

test("freight multi-line block targets 包邮 by line geometry", () => {
  const nodes = [{
    label: "邮寄\n包邮\n不包邮-按距离付费\n不包邮-固定邮费\n无需邮寄",
    bounds: [33, 921, 1047, 1622],
  }];
  const block = findFreightOptionBlock(nodes);
  assert.ok(block);
  const target = freightOptionTarget(block, "包邮");
  assert.equal(target.index, 1);
  assert.equal(target.lineCount, 5);
  // 行心 y ≈ 921 + 1.5 * ((1622-921)/5)
  assert.ok(Math.abs(target.point[1] - 1131) < 3);
  assert.ok(freightRowVerified("发货方式\n包邮", "包邮"));
  assert.equal(freightRowVerified("发货方式\n运费￥0.00", "包邮"), false);
});

test("findSkuBatchEditControls prefers rightmost 确定 as keyboard confirm", () => {
  const controls = findSkuBatchEditControls([
    { label: "¥,编辑框", className: "android.widget.EditText", bounds: [214, 1006, 983, 1063] },
    { label: "¥,编辑框", className: "android.widget.EditText", bounds: [214, 1155, 983, 1213] },
    { label: "确定, 确定", bounds: [496, 2159, 584, 2212] },
    { label: "确定, 确定", bounds: [884, 2132, 972, 2184] },
  ]);
  assert.ok(controls.priceInput);
  assert.ok(controls.stockInput);
  assert.deepEqual(controls.keyboardConfirm.bounds, [884, 2132, 972, 2184]);
  assert.ok(APP_NUMPAD_SETTLE_MS >= 400);
});

test("createStepSupervisor retries recover then succeeds", async () => {
  const fakeOp = { serial: "test-serial" };
  const seen = [];
  const sup = createStepSupervisor(fakeOp, { onEvent: (e) => seen.push(e.phase) });
  let n = 0;
  const result = await sup.run("probe", async () => {
    n += 1;
    return n >= 2 ? { ok: true, step: "ok" } : { ok: false, step: "need-retry" };
  }, {
    maxAttempts: 2,
    recover: async () => { /* no-op recover */ },
  });
  assert.equal(result.ok, true);
  assert.equal(result.step, "ok");
  assert.ok(seen.includes("start"));
  assert.ok(seen.includes("recover"));
  assert.ok(seen.includes("ok"));
});

test("createStepSupervisor keeps progress events off stdout", async () => {
  const stdout = [];
  const stderr = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => stdout.push(args.join(" "));
  console.error = (...args) => stderr.push(args.join(" "));
  try {
    const sup = createStepSupervisor({ serial: "test-serial" });
    const result = await sup.run("probe", async () => ({ ok: true, step: "ok" }));
    assert.equal(result.ok, true);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  assert.deepEqual(stdout, []);
  assert.ok(stderr.length >= 2);
  assert.ok(stderr.every((line) => JSON.parse(line).event === "supervisor"));
});
