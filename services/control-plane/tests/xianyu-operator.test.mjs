import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APP_NUMPAD_SETTLE_MS,
  analyzeQrCodeMaskState,
  analyzeImageUploadState,
  applyQrCodeMaskIfRequired,
  boundsClose,
  createStickyXiaoweiInputSession,
  createStepSupervisor,
  descriptionContains,
  discardDraftDryRun,
  findDiscardWithoutSaving,
  findDescriptionField,
  findFreightOptionBlock,
  findHomeTab,
  findPublishEntry,
  findSellTab,
  fillPriceField,
  findSkuRecoveryClose,
  findSkuExitConfirm,
  findSkuBatchEditControls,
  findSpecDimensionDeleteEntry,
  findSkuSelectAll,
  summarizeSkuSelectAllMiss,
  findAppNumpadDelete,
  findAppNumpadKey,
  freightOptionTarget,
  freightRowVerified,
  getScreenHeight,
  isBottomTabSelected,
  isEmptyDescriptionField,
  isPublishCompose,
  isXianyuChatOverlay,
  isRecoverySafeMain,
  inspectPriceState,
  priceFieldValueMatches,
  shouldPersistDraft,
  returnFromXianyuChatOverlay,
  ensureOnPublishCompose,
  firstFailedPublishStep,
  firstFailedPublishDiagnostic,
  loadLayoutProfile,
  normalizeXwInputText,
  parseDisplayResolution,
  parseAllUiNodes,
  probeBottomTabs,
  recoverDiscardDryRun,
  recoverySemanticHints,
  resolveOperatorCommand,
  saveLayoutProfile,
  semanticSnapshot,
  summarizeImageMediaNodes,
  summarizeFlutterSkuTapTransition,
  summarizeAppNumpadCandidates,
  verifyImageManifestDryRun,
  replaceSkuBatchAppNumpadValue,
  deleteExistingSpecValues,
  skuBatchInputValue,
  shouldScrollAfterSkuValue,
  skuScrollNudgeCount,
  orderSkuDimensionEntries,
  skuDimensionValuesComplete,
  waitForSkuPricePage,
} from "../scripts/xianyu-operator.mjs";

test("operator CLI recognizes the dedicated Flutter tap probe command", () => {
  assert.equal(resolveOperatorCommand(["node", "script", "flutter-pointer-tap-probe"]), "flutter-pointer-tap-probe");
  assert.equal(resolveOperatorCommand(["node", "script", "unknown"]), "help");
});

test("Flutter SKU tap transition requires compose-to-specs state change", () => {
  const compose = [
    { label: "宝贝描述", className: "android.view.View", bounds: [10, 300, 900, 500] },
    { label: "商品规格", className: "android.view.View", bounds: [10, 900, 900, 1050] },
    { label: "发布", className: "android.widget.Button", bounds: [900, 20, 1070, 150] },
  ];
  const specs = [
    { label: "设置宝贝规格", className: "android.view.View", bounds: [10, 100, 900, 220] },
    { label: "推荐常用的规格类型", className: "android.view.View", bounds: [10, 300, 900, 420] },
  ];
  assert.deepEqual(summarizeFlutterSkuTapTransition(compose, specs), {
    verified: true,
    from: "publish-compose",
    to: "sku-specs",
    beforeSkuPage: false,
    afterSkuPage: true,
  });
  assert.equal(summarizeFlutterSkuTapTransition(compose, compose).verified, false);
  assert.equal(summarizeFlutterSkuTapTransition(specs, specs).verified, false);
});

test("numpad failure diagnostics retain only matching key geometry and bounded enums", () => {
  const diagnostic = summarizeAppNumpadCandidates([
    { label: "小数点, .", className: "android.widget.Button", bounds: [0, 2290, 270, 2390], clickable: true },
    { label: "用户价格描述 12.34", className: "android.view.View", bounds: [20, 300, 900, 500] },
  ], ".", [1080, 2400]);
  assert.equal(diagnostic.kind, "app-numpad-key-missing");
  assert.equal(diagnostic.missing, ".");
  assert.equal(diagnostic.candidateCount, 1);
  assert.deepEqual(diagnostic.candidates[0], {
    classKind: "button",
    bounds: [0, 2290, 270, 2390],
    clickable: true,
    withinKeyboardGeometry: false,
  });
  assert.doesNotMatch(JSON.stringify(diagnostic), /用户价格描述|小数点/);
});

test("publish failure diagnostic bubbles only the bounded numpad object", () => {
  const diagnostic = firstFailedPublishDiagnostic({
    sku: {
      ok: false,
      step: "sku-price-numpad-failed",
      priceTyped: {
        field: "price",
        typed: {
          diagnostic: {
            kind: "app-numpad-key-missing",
            missing: ".",
            resolution: [1080, 2400],
            candidateCount: 1,
            candidates: [{ classKind: "button", bounds: [0, 2290, 270, 2390], clickable: true, withinKeyboardGeometry: false, rawLabel: "secret" }],
            privateRawLabel: "secret",
          },
        },
      },
    },
  });
  assert.equal(diagnostic.field, "price");
  assert.equal(diagnostic.candidates[0].withinKeyboardGeometry, false);
  assert.doesNotMatch(JSON.stringify(diagnostic), /secret|rawLabel/);
});

test("publish failure diagnostic keeps bounded SKU page markers without unrelated labels", () => {
  const diagnostic = firstFailedPublishDiagnostic({
    sku: {
      ok: false,
      step: "sku-select-all-missing",
      expectedRows: 5,
      dimResults: [{ dim: "尺码" }],
      selectAllMiss: {
        kind: "sku-select-all-missing",
        nodeCount: 35,
        labelsWithSelectAll: ["全选"],
        almostRelatedLabels: ["颜色\n选择推荐的\n颜色", "用户商品私密文本"],
        markers: {
          specsPage: true,
          batchEntry: false,
          cancelBatch: false,
          nextOrPriceStock: true,
        },
      },
    },
  });
  assert.deepEqual(diagnostic.dimensions, ["尺码"]);
  assert.deepEqual(diagnostic.labelsWithSelectAll, ["全选"]);
  assert.deepEqual(diagnostic.almostRelatedLabels, ["颜色\n选择推荐的\n颜色"]);
  assert.deepEqual(diagnostic.markers, {
    specsPage: true,
    batchEntry: false,
    cancelBatch: false,
    nextOrPriceStock: true,
  });
  assert.doesNotMatch(JSON.stringify(diagnostic), /用户商品私密文本/);
});

test("publish failure diagnostic bubbles only bounded price surface state", () => {
  const diagnostic = firstFailedPublishDiagnostic({
    price: {
      ok: false,
      step: "price-commit-close-unverified",
      observed: {
        surface: "ambiguous",
        composeVisible: true,
        hasPriceField: false,
        composeNeighborhood: false,
        valueMatches: true,
        inlinePriceValue: true,
        atComposeAnchor: false,
        atSheetAnchor: false,
        digitCount: 99,
        hasKeyboardConfirm: false,
        auxiliaryMarkers: { originalPrice: false, stock: false, settlement: true },
        rawLabel: "用户私密价格描述",
      },
    },
  });
  assert.deepEqual(diagnostic, {
    kind: "price-state-unverified",
    stage: "price-commit-close-unverified",
    surface: "ambiguous",
    composeVisible: true,
    hasPriceField: false,
    composeNeighborhood: false,
    valueMatches: true,
    inlinePriceValue: true,
    atComposeAnchor: false,
    atSheetAnchor: false,
    digitCount: 10,
    hasKeyboardConfirm: false,
    auxiliaryMarkers: { originalPrice: false, stock: false, settlement: true },
  });
  assert.doesNotMatch(JSON.stringify(diagnostic), /用户私密|rawLabel/);
});

test("image upload state counts 04 button tiles only when anchored by the add tile", () => {
  const nodes = [
    { label: "媒体一", className: "android.widget.Button", bounds: [74, 257, 378, 561], clickable: true },
    { label: "媒体二", className: "android.widget.Button", bounds: [388, 257, 692, 561], clickable: true },
    { label: "添加图片", className: "android.widget.Button", bounds: [703, 257, 1007, 561], clickable: false },
  ];
  assert.deepEqual(analyzeImageUploadState(nodes, { picked: 2, publishCompose: true }), {
    verified: true,
    mediaCount: 2,
    expectedCount: 2,
    hasAddMore: true,
  });

  const unrelatedButtons = nodes.slice(0, 2);
  assert.equal(analyzeImageUploadState(unrelatedButtons, { picked: 2, publishCompose: true }).mediaCount, 0);
});

test("image upload state counts 02 商品图片 buttons without add-tile anchor", () => {
  // Real 02 dump tiles are ~176px; keep fixture realistic so size gate stays honest.
  const nodes = [
    { label: "商品图片", className: "android.widget.Button", bounds: [77, 282, 253, 458], clickable: true },
    { label: "商品图片", className: "android.widget.Button", bounds: [264, 282, 441, 458], clickable: true },
    { label: "商品图片", className: "android.widget.Button", bounds: [452, 282, 628, 458], clickable: true },
    { label: "商品图片", className: "android.widget.Button", bounds: [639, 282, 816, 458], clickable: true },
    { label: "商品图片", className: "android.widget.Button", bounds: [827, 282, 1003, 458], clickable: true },
    { label: "商品图片", className: "android.widget.Button", bounds: [77, 469, 253, 646], clickable: true },
    { label: "商品图片", className: "android.widget.Button", bounds: [264, 469, 441, 646], clickable: true },
    { label: "商品图片", className: "android.widget.Button", bounds: [452, 469, 628, 646], clickable: true },
    { label: "商品图片", className: "android.widget.Button", bounds: [639, 469, 816, 646], clickable: true },
  ];
  assert.deepEqual(analyzeImageUploadState(nodes, { picked: 9, publishCompose: true }), {
    verified: true,
    mediaCount: 9,
    expectedCount: 9,
    hasAddMore: false,
  });
});

test("image upload state accepts only a full two-row unlabeled button grid without add anchor", () => {
  const fullGrid = Array.from({ length: 9 }, (_, index) => {
    const row = index < 5 ? 0 : 1;
    const column = row === 0 ? index : index - 5;
    const left = 77 + column * 187;
    const top = 282 + row * 187;
    return {
      label: "",
      className: "android.widget.Button",
      bounds: [left, top, left + 176, top + 176],
      clickable: true,
    };
  });
  assert.deepEqual(analyzeImageUploadState(fullGrid, { picked: 9, publishCompose: true }), {
    verified: true,
    mediaCount: 9,
    expectedCount: 9,
    hasAddMore: false,
  });
  assert.equal(analyzeImageUploadState(fullGrid.slice(0, 8), {
    picked: 9,
    publishCompose: true,
  }).mediaCount, 0);
});

test("QR mask state requires one unique semantic action and never relies on SKU", () => {
  const warning = {
    label: "请勿上传含二维码的图片，重新调整图片后再发布。",
    className: "android.view.View",
    bounds: [75, 150, 800, 230],
  };
  const action = {
    label: "一键打码，按钮",
    className: "android.widget.Button",
    bounds: [880, 150, 1030, 230],
    clickable: true,
  };
  assert.deepEqual(analyzeQrCodeMaskState([warning, action]), {
    required: true,
    warningPresent: true,
    actionCount: 1,
    actionBounds: [880, 150, 1030, 230],
  });
  assert.equal(analyzeQrCodeMaskState([]).required, false);
  assert.equal(analyzeQrCodeMaskState([warning]).actionCount, 0);
  assert.equal(analyzeQrCodeMaskState([warning, action, {
    ...action,
    bounds: [700, 150, 850, 230],
  }]).actionCount, 2);
});

test("QR mask action is tapped once and verified before text entry can continue", async () => {
  const warning = {
    label: "请勿上传含二维码的图片，重新调整图片后再发布。",
    className: "android.view.View",
    bounds: [75, 150, 800, 230],
  };
  const action = {
    label: "一键打码",
    className: "android.widget.Button",
    bounds: [880, 150, 1030, 230],
    clickable: true,
  };
  const media = Array.from({ length: 9 }, (_, index) => ({
    label: "商品图片",
    className: "android.widget.Button",
    bounds: [77 + (index % 5) * 187, 282 + Math.floor(index / 5) * 187,
      253 + (index % 5) * 187, 458 + Math.floor(index / 5) * 187],
    clickable: true,
  }));
  const snapshots = [
    { nodes: [warning, action], publishCompose: true },
    { nodes: media, publishCompose: true },
  ];
  const taps = [];
  const result = await applyQrCodeMaskIfRequired({
    async tap(x, y) { taps.push([x, y]); },
  }, {
    expectedImageCount: 9,
    snapshotFn: async () => snapshots.shift(),
    settleFn: async () => {},
  });
  assert.deepEqual(taps, [[955, 190]]);
  assert.deepEqual(result, {
    ok: true,
    step: "qr-mask-applied",
    required: true,
    applied: true,
    verified: true,
    warningDetected: true,
    actionCount: 1,
    imageCount: 9,
    expectedImageCount: 9,
  });
});

test("QR warning without one unique mask action fails closed without tapping", async () => {
  const taps = [];
  const result = await applyQrCodeMaskIfRequired({
    async tap(x, y) { taps.push([x, y]); },
  }, {
    snapshotFn: async () => ({
      nodes: [{ label: "请勿上传含二维码的图片", bounds: [75, 150, 800, 230] }],
      publishCompose: true,
    }),
    settleFn: async () => {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.step, "qr-mask-action-missing");
  assert.deepEqual(taps, []);
});

test("QR mask waits for an asynchronously rendered warning before deciding no action", async () => {
  const warning = { label: "请勿上传含二维码的图片", bounds: [75, 150, 800, 230] };
  const action = { label: "一键打码", bounds: [880, 150, 1030, 230], clickable: true };
  const media = Array.from({ length: 9 }, (_, index) => ({
    label: "商品图片",
    className: "android.widget.Button",
    bounds: [77 + (index % 5) * 187, 282 + Math.floor(index / 5) * 187,
      253 + (index % 5) * 187, 458 + Math.floor(index / 5) * 187],
    clickable: true,
  }));
  const snapshots = [
    { nodes: [], publishCompose: true },
    { nodes: [warning, action], publishCompose: true },
    { nodes: media, publishCompose: true },
  ];
  const taps = [];
  const result = await applyQrCodeMaskIfRequired({
    async tap(x, y) { taps.push([x, y]); },
  }, {
    expectedImageCount: 9,
    snapshotFn: async () => snapshots.shift(),
    settleFn: async () => {},
  });
  assert.equal(result.step, "qr-mask-applied");
  assert.equal(result.warningDetected, true);
  assert.deepEqual(taps, [[955, 190]]);
});

test("explicit QR requirement cannot degrade to a successful no-op", async () => {
  const result = await applyQrCodeMaskIfRequired({ async tap() {} }, {
    forceRequired: true,
    maxDetectAttempts: 2,
    snapshotFn: async () => ({ nodes: [], publishCompose: true }),
    settleFn: async () => {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.step, "qr-mask-required-action-missing");
  assert.equal(result.required, true);
  assert.equal(result.applied, false);
});

test("publish failure diagnostic keeps bounded image geometry and drops raw fields", () => {
  const diagnostic = firstFailedPublishDiagnostic({
    images: {
      ok: false,
      step: "image-album-selector-missing",
      diagnostic: {
        publishCompose: true,
        mediaCount: 0,
        expectedCount: 9,
        hasAddMore: false,
        privateLabel: "用户私密描述",
        topMedia: {
          nodeCount: 1,
          nodes: [{
            labelKind: "empty",
            classKind: "button",
            bounds: [77, 282, 253, 458],
            clickable: true,
            rawLabel: "用户私密描述",
          }],
        },
      },
    },
  });
  assert.equal(diagnostic.kind, "image-upload-state-unverified");
  assert.equal(diagnostic.expectedCount, 9);
  assert.deepEqual(diagnostic.topMedia.nodes[0].bounds, [77, 282, 253, 458]);
  assert.doesNotMatch(JSON.stringify(diagnostic), /用户私密|rawLabel|privateLabel/);
});

test("image media diagnostics preserve geometry but redact every raw label", () => {
  const diagnostic = summarizeImageMediaNodes([
    {
      label: "用户私密描述不应落结果",
      className: "android.view.View",
      bounds: [60, 500, 900, 650],
      clickable: false,
    },
    {
      label: "删除图片",
      className: "android.widget.Button",
      bounds: [260, 180, 320, 240],
      clickable: true,
    },
    {
      label: "+添加更多",
      className: "android.widget.ImageView",
      bounds: [600, 200, 860, 460],
      clickable: true,
    },
    {
      label: "页面底部用户文本",
      className: "android.view.View",
      bounds: [60, 900, 900, 1100],
      clickable: false,
    },
  ]);
  assert.equal(diagnostic.nodeCount, 3);
  assert.deepEqual(diagnostic.nodes.map((node) => node.labelKind), ["other", "delete", "add"]);
  assert.deepEqual(diagnostic.nodes.map((node) => node.classKind), ["view", "button", "image"]);
  assert.doesNotMatch(JSON.stringify(diagnostic), /用户私密描述|页面底部用户文本|删除图片|添加更多/);
});

test("image manifest preflight reads only bounded Pictures paths and reports exact SHA matches", async () => {
  const commands = [];
  const expected = "a".repeat(64);
  const op = {
    async shellExec(command) {
      commands.push(command);
      return `${expected}  /sdcard/Pictures/XianyuFull4/a.png`;
    },
  };
  const result = await verifyImageManifestDryRun(op, [{
    phonePath: "/sdcard/Pictures/XianyuFull4/a.png",
    sha256: expected.toUpperCase(),
  }]);
  assert.equal(result.ok, true);
  assert.equal(result.step, "image-manifest-verified");
  assert.equal(result.stoppedBeforeAction, true);
  assert.equal(result.manifest.entries[0].verified, true);
  assert.deepEqual(commands, ["sha256sum '/sdcard/Pictures/XianyuFull4/a.png'"]);
});

test("image manifest preflight fails closed on mismatches and path traversal", async () => {
  const commands = [];
  const op = {
    async shellExec(command) {
      commands.push(command);
      return `${"b".repeat(64)}  /sdcard/Pictures/XianyuFull4/a.png`;
    },
  };
  const mismatch = await verifyImageManifestDryRun(op, [{
    phonePath: "/sdcard/Pictures/XianyuFull4/a.png",
    sha256: "a".repeat(64),
  }]);
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.step, "image-manifest-unverified");
  assert.equal(mismatch.manifest.entries[0].verified, false);

  const traversal = await verifyImageManifestDryRun(op, [{
    phonePath: "/sdcard/Pictures/../private.txt",
    sha256: "a".repeat(64),
  }]);
  assert.equal(traversal.ok, false);
  assert.equal(traversal.step, "image-manifest-invalid");
  assert.equal(traversal.stoppedBeforeAction, true);
  assert.equal(commands.length, 1);
});

test("SKU text input keeps the first IME restore until the batch is complete", async () => {
  const calls = [];
  let restores = 0;
  const session = createStickyXiaoweiInputSession({
    async inputTextViaXiaowei(text, options) {
      calls.push({ text, options });
      return { audit: { inputAccepted: true }, restore: async () => { restores += 1; } };
    },
  });

  await session.input("蓝色", { clearFirst: false });
  await session.input("白色", { clearFirst: false });
  await session.input("S", { clearFirst: false });
  assert.equal(restores, 0);
  assert.equal(calls.every((call) => call.options.deferRestore === true), true);

  await session.restore();
  await session.restore();
  assert.equal(restores, 1);
});

test("SKU values scroll after every completed value except the last, more later", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5].filter((count) => shouldScrollAfterSkuValue(count, 5)),
    [1, 2, 3, 4],
  );
  assert.deepEqual(
    [1, 2].filter((count) => shouldScrollAfterSkuValue(count, 2)),
    [1],
  );
  assert.deepEqual(
    [1, 2, 3, 4, 5].map((count) => skuScrollNudgeCount(count, 5)),
    [1, 2, 3, 3, 0],
  );
});

test("SKU dimension order forces 颜色 before 尺码", () => {
  assert.deepEqual(
    orderSkuDimensionEntries({ 尺码: ["M"], 颜色: ["黑色", "白色"] }).map(([name]) => name),
    ["颜色", "尺码"],
  );
});

test("SKU dimension values must all verify before next", () => {
  const specs = { 颜色: ["黑色", "白色"], 尺码: ["M"] };
  assert.equal(skuDimensionValuesComplete([
    { dim: "颜色", chosen: [{ val: "黑色", ok: true }, { val: "白色", ok: false }] },
    { dim: "尺码", chosen: [{ val: "M", ok: true }] },
  ], specs), false);
  assert.equal(skuDimensionValuesComplete([
    { dim: "颜色", chosen: [{ val: "黑色", ok: true }, { val: "白色", ok: true }] },
    { dim: "尺码", chosen: [{ val: "M", ok: true }] },
  ], specs), true);
});

test("replaceExisting clears old values and dimensions before rebuilding requested specs", async () => {
  const valueDelete = { label: "删除，按钮", bounds: [900, 500, 1000, 600] };
  const dimensionDelete = { label: "删除，按钮, 删除", bounds: [900, 300, 1000, 400] };
  assert.equal(findSpecDimensionDeleteEntry([valueDelete, dimensionDelete]), dimensionDelete);

  const snapshots = [
    { nodes: [valueDelete, dimensionDelete] },
    { nodes: [dimensionDelete] },
    { nodes: [{ label: "推荐常用的规格类型", bounds: [20, 200, 1000, 300] }] },
  ];
  const taps = [];
  const result = await deleteExistingSpecValues({
    async tap(x, y) { taps.push([x, y]); },
  }, {
    snapshotFn: async () => snapshots.shift(),
    settleFn: async () => {},
  });
  assert.deepEqual(taps, [[950, 550], [950, 350]]);
  assert.deepEqual(result, {
    ok: true,
    step: "sku-replaced",
    deleted: 1,
    dimensionsDeleted: 1,
  });
});

test("publish dry-run surfaces the first failed step without full operator output", () => {
  assert.equal(firstFailedPublishStep({
    description: { ok: true, step: "desc-filled" },
    sku: { ok: false, step: "sku-next-missing" },
  }), "sku:sku-next-missing");
  assert.equal(firstFailedPublishStep({}), null);
});

test("parseDisplayResolution uses the effective override size", () => {
  assert.deepEqual(parseDisplayResolution("Physical size: 1080x2400\nOverride size: 720x1600"), [720, 1600]);
  assert.deepEqual(parseDisplayResolution("Physical size: 1080x2400"), [1080, 2400]);
  assert.equal(parseDisplayResolution("size unavailable"), null);
});

test("SKU batch app numpad helpers parse values and require one bounded delete key", () => {
  assert.equal(skuBatchInputValue({ label: "¥45.64,编辑框" }, { decimal: true }), "45.64");
  assert.equal(skuBatchInputValue({ label: "¥5,编辑框" }), "5");
  const deletion = { label: "删除", bounds: [810, 1500, 1080, 1690] };
  assert.equal(findAppNumpadDelete([deletion]), deletion);
  assert.equal(findAppNumpadDelete([{ ...deletion, label: "删除，按钮" }]), null);
  assert.equal(findAppNumpadDelete([{ ...deletion, bounds: [10, 100, 100, 200] }]), null);
  assert.equal(findAppNumpadDelete([deletion, { ...deletion, bounds: [820, 1510, 1070, 1680] }]), null);
});

test("SKU app numpad key accepts the device-02 first row just above 1500px and rejects content lookalikes", () => {
  const one = { label: "数字1, 1", bounds: [0, 1490, 270, 1668] };
  assert.equal(findAppNumpadKey([one], "1"), one);
  assert.equal(findAppNumpadKey([{ ...one, bounds: [0, 1300, 270, 1478] }], "1"), null);
  assert.equal(findAppNumpadKey([{ label: "1", bounds: [0, 1490, 900, 1668] }], "1"), null);
  assert.equal(findAppNumpadKey([{ label: "小数点, .", bounds: [0, 2070, 270, 2250] }], ".")?.label, "小数点, .");
  const device04Dot = { label: "小数点, .", className: "android.view.View", bounds: [0, 2109, 271, 2287], clickable: false };
  assert.equal(findAppNumpadKey([device04Dot], "."), device04Dot);
  assert.equal(findAppNumpadKey([{ ...device04Dot, bounds: [0, 2127, 271, 2305] }], "."), null);
});

test("SKU batch app numpad replacement clears stale price and stock through the in-app delete key", async () => {
  const values = { price: "45.64", stock: "5" };
  let active = null;
  const priceBounds = [180, 760, 1000, 880];
  const stockBounds = [180, 900, 1000, 1020];
  const deleteBounds = [810, 1500, 1080, 1690];
  const centerOf = (bounds) => [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2];
  const samePoint = (point, bounds) => JSON.stringify(point) === JSON.stringify(centerOf(bounds));
  const nodes = () => [
    { label: `¥${values.price},编辑框`, className: "android.widget.EditText", focused: active === "price", bounds: priceBounds },
    { label: `¥${values.stock},编辑框`, className: "android.widget.EditText", focused: active === "stock", bounds: stockBounds },
    { label: "删除", bounds: deleteBounds },
    { label: "确定, 确定", bounds: [810, 1870, 1080, 2250] },
  ];
  const op = {
    async tap(x, y) {
      const point = [x, y];
      if (samePoint(point, priceBounds)) active = "price";
      else if (samePoint(point, stockBounds)) active = "stock";
      else if (samePoint(point, deleteBounds) && active) values[active] = values[active].slice(0, -1);
    },
  };
  const snapshotFn = async () => ({ nodes: nodes() });
  const typeDigitsFn = async (_op, text) => {
    values[active] += String(text);
    return { ok: true, typed: [...String(text)] };
  };

  const price = await replaceSkuBatchAppNumpadValue(op, {
    field: "price", value: "12.34", snapshotFn, typeDigitsFn,
  });
  const stock = await replaceSkuBatchAppNumpadValue(op, {
    field: "stock", value: "2", snapshotFn, typeDigitsFn,
  });
  assert.equal(price.ok, true);
  assert.equal(price.deletes, 5);
  assert.equal(stock.ok, true);
  assert.equal(stock.deletes, 1);
  assert.deepEqual(values, { price: "12.34", stock: "2" });
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

test("SKU recovery recognizes the device-02 batch price-stock sub-sheet", () => {
  const focus = { package: "com.taobao.idlefish", activity: "SkuActivity" };
  const close = {
    label: "关闭,按钮",
    className: "android.widget.ImageView",
    clickable: false,
    bounds: [965, 210, 1034, 279],
  };
  const nodes = [
    { label: "设置价格和库存", bounds: [300, 80, 800, 180] },
    close,
    { label: "选中的规格 S 蓝色 | S 白色 | M 蓝色 | M 白色", bounds: [40, 300, 1040, 650] },
    { label: "价格, 价格", bounds: [40, 850, 220, 980] },
    { label: "库存, 库存", bounds: [40, 1020, 220, 1150] },
  ];
  assert.equal(findSkuRecoveryClose(nodes, { focus, resolution: [1080, 2400] }), close);
});

test("recovery inspection keeps bounded recovery metadata without unrelated text", () => {
  assert.deepEqual(recoverySemanticHints([
    { label: "关闭,按钮", className: "android.widget.Button", clickable: false, bounds: [920, 84, 1050, 174] },
    { label: "设置价格和库存", className: "android.view.View", clickable: false, bounds: [300, 80, 800, 180] },
    { label: "库存, 库存", className: "android.view.View", clickable: false, bounds: [40, 1020, 220, 1150] },
    { label: "确认退出，按钮, 确认退出", className: "android.widget.Button", clickable: true, bounds: [550, 2040, 1040, 2210] },
    { label: "取消，按钮, 取消", className: "android.widget.Button", clickable: true, bounds: [40, 2040, 520, 2210] },
    { label: "用户发布正文不应进入恢复诊断", className: "android.widget.EditText", clickable: true, bounds: [40, 300, 1040, 700] },
  ]), [
    { label: "关闭,按钮", className: "android.widget.Button", clickable: false, bounds: [920, 84, 1050, 174] },
    { label: "设置价格和库存", className: "android.view.View", clickable: false, bounds: [300, 80, 800, 180] },
    { label: "库存, 库存", className: "android.view.View", clickable: false, bounds: [40, 1020, 220, 1150] },
    { label: "确认退出，按钮, 确认退出", className: "android.widget.Button", clickable: true, bounds: [550, 2040, 1040, 2210] },
    { label: "取消，按钮, 取消", className: "android.widget.Button", clickable: true, bounds: [40, 2040, 520, 2210] },
  ]);
});

test("SKU exit recovery selects only the unique audited bottom-right confirmation", () => {
  const focus = { package: "com.taobao.idlefish", activity: "SkuActivity" };
  const confirm = {
    label: "确认退出，按钮, 确认退出",
    className: "android.view.View",
    clickable: false,
    bounds: [557, 2068, 1034, 2175],
  };
  const nodes = [
    { label: "退\u200b出\u200b后\u200b不\u200b会\u200b保\u200b存\u200b这\u200b次\u200b设\u200b置\u200b的\u200b规\u200b格\u200b哦\u200b", bounds: [173, 1804, 907, 1873] },
    { label: "取消，按钮, 取消", className: "android.view.View", clickable: false, bounds: [46, 2068, 523, 2175] },
    confirm,
  ];
  assert.equal(findSkuExitConfirm(nodes, { focus, resolution: [1080, 2400] }), confirm);
  assert.equal(findSkuExitConfirm([...nodes, { ...confirm, bounds: [600, 2070, 1000, 2170] }], {
    focus,
    resolution: [1080, 2400],
  }), null);
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
  // 03 号机实测：a11y 把「消息」tab 暴露成裸 "消息"（无「消息，未选中状态」描述节点）。
  // 旧正则 /^消息[,，]/ 会 false-negative 拒掉；修正后 (?:$|[,，]) 接受裸标签。
  const device03BareMessageTabs = [
    { label: "闲鱼，未读消息数0，选中状态", bounds: [90, 2322, 146, 2355], clickable: true },
    { label: "卖闲置", bounds: [430, 2241, 650, 2355], clickable: true },
    { label: "消息", bounds: [728, 2322, 787, 2355], clickable: true },
    { label: "我的，未选中状态", bounds: [926, 2323, 982, 2354], clickable: true },
  ];
  assert.equal(isRecoverySafeMain({ focus, nodes: device03BareMessageTabs, resolution: [1080, 2400] }), true);
});

test("compose recovery never force-stops when Xianyu is already on a child page", async () => {
  const shellCommands = [];
  const op = {
    serial: "device-02",
    transport: "gateway",
    async currentFocus() {
      return { package: "com.taobao.idlefish", activity: "SkuActivity" };
    },
    async dumpXml() { return recoveryXml(skuRecoveryNodes); },
    async shellExec(command) { shellCommands.push(command); return ""; },
  };

  const result = await ensureOnPublishCompose(op, { maxAttempts: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.step, "same-app-non-compose");
  assert.equal(shellCommands.some((command) => /force-stop/.test(command)), false);
});

test("compose recovery accepts device 02 filled-description keyboard state without restarting", async () => {
  const shellCommands = [];
  const nodes = [
    { label: "关闭", className: "android.widget.Button", clickable: true, bounds: [0, 94, 113, 178] },
    { label: "发布", className: "android.widget.Button", clickable: true, bounds: [880, 94, 1080, 178] },
    {
      label: "+添加优质\n首图更吸引人~",
      className: "android.widget.Button",
      clickable: true,
      bounds: [74, 257, 378, 561],
    },
    {
      label: "控制面库存验证 不保存草稿 不发布",
      className: "android.view.View",
      clickable: true,
      bounds: [74, 575, 1006, 1121],
    },
  ];
  const op = {
    serial: "device-02",
    transport: "gateway",
    async currentFocus() {
      return {
        package: "com.taobao.idlefish",
        activity: "com.idlefish.flutterbridge.flutterboost.boost.FishFlutterBoostActivity",
      };
    },
    async dumpXml() { return recoveryXml(nodes); },
    async shellExec(command) { shellCommands.push(command); return ""; },
  };

  const result = await ensureOnPublishCompose(op, { maxAttempts: 1 });
  assert.equal(result.ok, true);
  assert.equal(shellCommands.some((command) => /force-stop/.test(command)), false);
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

test("recoverDiscardDryRun resumes safely when recovery starts on the discard dialog", async () => {
  const discardDialog = [
    { label: "不保存", className: "android.widget.Button", clickable: true, bounds: [42, 1980, 524, 2130] },
    { label: "存草稿", className: "android.widget.Button", clickable: true, bounds: [556, 1980, 1038, 2130] },
  ];
  let state = "dialog";
  const taps = [];
  const op = {
    serial: "device-02",
    transport: "gateway",
    async shellExec(command) { return command === "wm size" ? "Physical size: 1080x2400" : ""; },
    async currentFocus() {
      return state === "main"
        ? { package: "com.taobao.idlefish", activity: "com.taobao.idlefish.maincontainer.activity.MainActivity" }
        : { package: "com.taobao.idlefish", activity: "FishFlutterBoostActivity" };
    },
    async dumpXml() { return recoveryXml(state === "dialog" ? discardDialog : device02BottomTabs); },
    async tap(x, y) {
      taps.push([x, y]);
      state = "main";
    },
    async capturePng(path) { return { path, bytes: 100, sha256: "d".repeat(64) }; },
  };

  const result = await recoverDiscardDryRun(op, { evidenceDir: "/tmp/xianyu-recovery-test" });
  assert.equal(result.ok, true);
  assert.equal(result.step, "discard-dialog-discarded-to-safe-main");
  assert.equal(result.savedDraft, false);
  assert.equal(result.discard.step, "discarded-without-saving-from-recovery-dialog");
  assert.equal(taps.length, 1);
});

test("recoverDiscardDryRun backs out of the audited chat overlay before discarding compose", async () => {
  const chat = [
    { label: "闲鱼私聊, 左滑看TA的闲鱼号", bounds: [0, 200, 1080, 2200] },
    { label: "完整聊天", bounds: [40, 260, 220, 330] },
    { label: "商品信息, ¥25.00", bounds: [40, 350, 1040, 600] },
    { label: "想跟TA说点什么...", bounds: [140, 2180, 820, 2280] },
  ];
  const compose = [
    { label: "关闭", className: "android.widget.Button", clickable: true, bounds: [0, 94, 113, 178] },
    { label: "发布, 发布", className: "android.view.View", clickable: true, bounds: [880, 94, 1080, 178] },
    { label: "分类/预计工期/售后服务/等\n售后服务\n额外服务", bounds: [74, 760, 1006, 1500] },
    { label: "商品规格\n已设置10个规格", bounds: [74, 1650, 1006, 1770] },
    { label: "价格和库存\n¥12.34、库存20", bounds: [74, 1790, 1006, 1910] },
  ];
  const discardDialog = [
    { label: "不保存", className: "android.widget.Button", clickable: true, bounds: [42, 1980, 524, 2130] },
    { label: "存草稿", className: "android.widget.Button", clickable: true, bounds: [556, 1980, 1038, 2130] },
  ];
  let state = "chat";
  let backs = 0;
  const taps = [];
  const op = {
    serial: "device-02",
    transport: "gateway",
    async shellExec(command) { return command === "wm size" ? "Physical size: 1080x2400" : ""; },
    async currentFocus() {
      if (state === "chat") {
        return {
          package: "com.taobao.idlefish",
          activity: "com.idlefish.flutterbridge.flutterboost.boost.FishFlutterBoostTransparencyActivity",
        };
      }
      return state === "main"
        ? { package: "com.taobao.idlefish", activity: "com.taobao.idlefish.maincontainer.activity.MainActivity" }
        : { package: "com.taobao.idlefish", activity: "FishFlutterBoostActivity" };
    },
    async dumpXml() {
      const nodes = state === "chat" ? chat
        : state === "compose" ? compose
          : state === "discard" ? discardDialog : device02BottomTabs;
      return recoveryXml(nodes);
    },
    async back() { backs += 1; state = "compose"; },
    async tap(x, y) {
      taps.push([x, y]);
      state = state === "compose" ? "discard" : "main";
    },
    async capturePng(path) { return { path, bytes: 100, sha256: "e".repeat(64) }; },
  };

  const result = await recoverDiscardDryRun(op, { evidenceDir: "/tmp/xianyu-recovery-test" });
  assert.equal(result.ok, true);
  assert.equal(result.safeStateVerified, true);
  assert.equal(result.savedDraft, false);
  assert.equal(backs, 1);
  assert.equal(taps.length, 2);
  assert.equal(result.evidenceFiles.some((file) => file.label === "xianyu-recovery-after-chat-overlay-back"), true);
});

test("recoverDiscardDryRun confirms the audited SKU exit dialog before discarding compose", async () => {
  const skuExitDialog = [
    { label: "退\u200b出\u200b后\u200b不\u200b会\u200b保\u200b存\u200b这\u200b次\u200b设\u200b置\u200b的\u200b规\u200b格\u200b哦\u200b", bounds: [173, 1804, 907, 1873] },
    { label: "取消，按钮, 取消", className: "android.view.View", clickable: false, bounds: [46, 2068, 523, 2175] },
    { label: "确认退出，按钮, 确认退出", className: "android.view.View", clickable: false, bounds: [557, 2068, 1034, 2175] },
  ];
  const compose = [
    { label: "关闭", className: "android.widget.Button", clickable: true, bounds: [0, 94, 113, 178] },
    { label: "发布", className: "android.widget.Button", clickable: true, bounds: [880, 94, 1080, 178] },
    { label: "+添加优质 首图更吸引人~", className: "android.widget.Button", clickable: true, bounds: [74, 257, 378, 561] },
  ];
  const discardDialog = [
    { label: "不保存", className: "android.widget.Button", clickable: true, bounds: [42, 1980, 524, 2130] },
    { label: "存草稿", className: "android.widget.Button", clickable: true, bounds: [556, 1980, 1038, 2130] },
  ];
  let state = "sku-exit";
  const taps = [];
  const op = {
    serial: "device-02",
    transport: "gateway",
    async shellExec(command) { return command === "wm size" ? "Physical size: 1080x2400" : ""; },
    async currentFocus() {
      return state === "main"
        ? { package: "com.taobao.idlefish", activity: "com.taobao.idlefish.maincontainer.activity.MainActivity" }
        : { package: "com.taobao.idlefish", activity: "FishFlutterBoostActivity" };
    },
    async dumpXml() {
      const nodes = state === "sku-exit" ? skuExitDialog
        : state === "compose" ? compose
          : state === "discard" ? discardDialog : device02BottomTabs;
      return recoveryXml(nodes);
    },
    async tap(x, y) {
      taps.push([x, y]);
      state = state === "sku-exit" ? "compose" : state === "compose" ? "discard" : "main";
    },
    async capturePng(path) { return { path, bytes: 100, sha256: "e".repeat(64) }; },
  };

  const result = await recoverDiscardDryRun(op, { evidenceDir: "/tmp/xianyu-recovery-test" });
  assert.equal(result.ok, true);
  assert.equal(result.step, "sku-exit-dialog-discarded-to-safe-main");
  assert.equal(result.savedDraft, false);
  assert.equal(taps.length, 3);
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

test("isPublishCompose accepts device 02 after description fill while the keyboard hides commerce rows", () => {
  assert.equal(isPublishCompose([
    { label: "关闭", className: "android.widget.Button", bounds: [0, 94, 113, 178] },
    { label: "发布", className: "android.widget.Button", bounds: [880, 94, 1080, 178] },
    { label: "+添加优质\n首图更吸引人~", className: "android.widget.Button", bounds: [74, 257, 378, 561] },
    {
      label: "控制面库存验证 不保存草稿 不发布",
      className: "android.view.View",
      bounds: [74, 575, 1006, 1121],
    },
  ]), true);
  assert.equal(isPublishCompose([
    { label: "发布", className: "android.widget.Button", bounds: [880, 94, 1080, 178] },
    { label: "+添加优质\n首图更吸引人~", className: "android.widget.Button", bounds: [74, 257, 378, 561] },
  ]), false);
});

test("isPublishCompose accepts device 02 scrolled service compose without Button class on publish", () => {
  assert.equal(isPublishCompose([
    { label: "发布，按钮, 发布", className: "android.view.View", bounds: [880, 94, 1080, 178] },
    { label: "分类/预计工期/售后服务/等", bounds: [74, 760, 1006, 870] },
    { label: "商品规格, 已设置10个规格", bounds: [74, 1650, 1006, 1770] },
    { label: "价格和库存, ¥12.34、库存20", bounds: [74, 1790, 1006, 1910] },
  ]), true);
  assert.equal(isPublishCompose([
    { label: "发布", className: "android.view.View", bounds: [880, 94, 1080, 178] },
    { label: "商品规格, 已设置10个规格", bounds: [74, 1650, 1006, 1770] },
  ]), false);
});

test("chat overlay requires the exact transparency activity and returns via Back", async () => {
  const overlay = {
    focus: {
      package: "com.taobao.idlefish",
      activity: "com.idlefish.flutterbridge.flutterboost.boost.FishFlutterBoostTransparencyActivity",
    },
    nodes: [
      { label: "完整聊天" },
      { label: "商品信息, ¥25.00" },
      { label: "想跟TA说点什么..." },
    ],
  };
  const compose = {
    focus: { package: "com.taobao.idlefish", activity: "ComposeActivity" },
    nodes: [{ label: "发布", bounds: [880, 94, 1080, 178] }],
  };
  assert.equal(isXianyuChatOverlay(overlay), true);
  assert.equal(isXianyuChatOverlay({ ...overlay, focus: { ...overlay.focus, activity: "MainActivity" } }), false);
  let backs = 0;
  const result = await returnFromXianyuChatOverlay({ back: async () => { backs += 1; } }, overlay, {
    settleMs: 0,
    snapshotFn: async () => compose,
  });
  assert.equal(result.ok, true);
  assert.equal(result.handled, true);
  assert.equal(result.page, compose);
  assert.equal(backs, 1);
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
  // 超出容差：回落到 ratio。本例节点仍在屏底比例带，应命中 fallback。
  const farButBottom = [
    { label: "闲鱼，选中状态", bounds: [22, 1000, 218, 1100], clickable: true },
    { label: "卖闲置", bounds: [427, 1000, 653, 1150], clickable: true },
  ];
  assert.deepEqual(findHomeTab(farButBottom, { profile, autoSave: false })?.bounds, [22, 1000, 218, 1100]);
  assert.deepEqual(findSellTab(farButBottom, { profile, autoSave: false })?.bounds, [427, 1000, 653, 1150]);
  // profile + ratio 都 miss：标签不含闲鱼/首页/卖闲置
  const nowhere = [
    { label: "同款商品卡", bounds: [22, 1000, 218, 1100], clickable: true },
    { label: "其他入口", bounds: [427, 1000, 653, 1150], clickable: true },
  ];
  assert.equal(findHomeTab(nowhere, { profile, autoSave: false }), null);
  assert.equal(findSellTab(nowhere, { profile, autoSave: false }), null);
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

test("price readback distinguishes an uncommitted open sheet from persisted value", () => {
  const keypad = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"]
    .map((label, index) => ({ label, bounds: [40 + index * 10, 1700, 100 + index * 10, 1800] }));
  const typedSheet = [
    { label: "价格设置199", bounds: [44, 912, 1036, 1044] },
    ...keypad,
    { label: "确定", bounds: [857, 2109, 1033, 2274] },
  ];
  const typedState = inspectPriceState(typedSheet, "199");
  assert.equal(typedState.surface, "sheet");
  assert.equal(typedState.sheetOpen, true);
  assert.equal(typedState.valueMatches, true);
  assert.ok(typedState.keyboardConfirm);
  // valueMatches alone is intentionally insufficient: this is the pre-commit state.

  const sparseTypedState = inspectPriceState([
    { label: "价格设置199", bounds: [44, 912, 1036, 1044] },
  ], "199");
  assert.equal(sparseTypedState.surface, "ambiguous");
  assert.equal(sparseTypedState.valueMatches, true);

  const staleCompose = inspectPriceState([
    { label: "宝贝描述", bounds: [77, 300, 1003, 600] },
    { label: "价格设置", bounds: [77, 1677, 1003, 1831] },
    { label: "预估鱼小铺软件服务费 (1.6%)-¥3.18", bounds: [77, 1831, 1003, 1900] },
    { label: "发布", className: "android.widget.Button", bounds: [900, 20, 1070, 150] },
  ], "199");
  assert.equal(staleCompose.surface, "compose");
  assert.equal(staleCompose.sheetOpen, false);
  assert.equal(staleCompose.valueMatches, false);

  const valueCompose = inspectPriceState([
    { label: "宝贝描述", bounds: [77, 300, 1003, 600] },
    { label: "价格 ¥199.00", bounds: [77, 1677, 1003, 1831] },
    { label: "发布", className: "android.widget.Button", bounds: [900, 20, 1070, 150] },
  ], "199");
  assert.equal(valueCompose.surface, "compose");
  assert.equal(valueCompose.valueMatches, true);

  const updatedValueCompose = inspectPriceState([
    { label: "宝贝描述", bounds: [77, 300, 1003, 600] },
    { label: "价格设置199", bounds: [77, 1677, 1003, 1831] },
    { label: "预估鱼小铺软件服务费 (1.6%)-¥3.18", bounds: [77, 1831, 1003, 1900] },
    { label: "发布", className: "android.widget.Button", bounds: [900, 20, 1070, 150] },
  ], "199", {
    composePriceBounds: [77, 1677, 1003, 1831],
    sheetPriceBounds: [44, 912, 1036, 1044],
  });
  assert.equal(updatedValueCompose.surface, "compose");
  assert.equal(updatedValueCompose.valueMatches, true);

  const mixedSparseOverlay = [
    { label: "宝贝描述", bounds: [77, 300, 1003, 600] },
    { label: "价格设置199", bounds: [44, 912, 1036, 1044] },
    { label: "发布", className: "android.widget.Button", bounds: [900, 20, 1070, 150] },
  ];
  assert.equal(inspectPriceState(mixedSparseOverlay, "199").surface, "ambiguous");
  assert.equal(inspectPriceState(mixedSparseOverlay, "199", {
    composePriceBounds: [77, 1677, 1003, 1831],
    sheetPriceBounds: [44, 912, 1036, 1044],
  }).surface, "sheet");

  const shiftedValueCompose = [
    { label: "宝贝描述", bounds: [77, 300, 1003, 600] },
    { label: "商品规格, 非必填", bounds: [74, 1130, 1006, 1240] },
    { label: "价格设置199", bounds: [74, 1260, 1006, 1380] },
    { label: "闲鱼币抵扣, 开启抵扣", bounds: [74, 1400, 1006, 1520] },
    { label: "发货方式, 包邮", bounds: [74, 1540, 1006, 1660] },
    { label: "发布", className: "android.widget.Button", bounds: [900, 20, 1070, 150] },
  ];
  const shiftedState = inspectPriceState(shiftedValueCompose, "199", {
    composePriceBounds: [77, 1677, 1003, 1831],
    sheetPriceBounds: [44, 912, 1036, 1044],
  });
  assert.equal(shiftedState.atComposeAnchor, false);
  assert.equal(shiftedState.composeNeighborhood, true);
  assert.equal(shiftedState.surface, "compose");

  const staleShiftedCompose = inspectPriceState([
    { label: "宝贝描述", bounds: [77, 300, 1003, 600] },
    { label: "价格设置", bounds: [74, 1260, 1006, 1380] },
    { label: "发布", className: "android.widget.Button", bounds: [900, 20, 1070, 150] },
  ], "199", {
    composePriceBounds: [77, 1677, 1003, 1831],
    sheetPriceBounds: [44, 912, 1036, 1044],
  });
  assert.equal(staleShiftedCompose.composeVisible, true);
  assert.equal(staleShiftedCompose.valueMatches, false);
  assert.equal(staleShiftedCompose.composeNeighborhood, false);
  assert.equal(staleShiftedCompose.surface, "compose");

  const missingPriceCompose = inspectPriceState([
    { label: "宝贝描述", bounds: [77, 300, 1003, 600] },
    { label: "发布", className: "android.widget.Button", bounds: [900, 20, 1070, 150] },
  ], "199", {
    composePriceBounds: [77, 1677, 1003, 1831],
    sheetPriceBounds: [44, 912, 1036, 1044],
  });
  assert.equal(missingPriceCompose.composeVisible, true);
  assert.equal(missingPriceCompose.hasPriceField, false);
  assert.equal(missingPriceCompose.surface, "compose");

  const missingPriceOpenSheet = inspectPriceState([
    { label: "宝贝描述", bounds: [77, 300, 1003, 600] },
    ...keypad,
    { label: "确定", bounds: [857, 2109, 1033, 2274] },
    { label: "发布", className: "android.widget.Button", bounds: [900, 20, 1070, 150] },
  ], "199", {
    composePriceBounds: [77, 1677, 1003, 1831],
    sheetPriceBounds: [44, 912, 1036, 1044],
  });
  assert.equal(missingPriceOpenSheet.hasPriceField, false);
  assert.equal(missingPriceOpenSheet.surface, "sheet");

  const reopened = inspectPriceState([
    { label: "价格设置199.00", bounds: [44, 912, 1036, 1044] },
    ...keypad,
    { label: "确定", bounds: [857, 2109, 1033, 2274] },
  ], "199");
  assert.equal(reopened.surface, "sheet");
  assert.equal(reopened.sheetOpen, true);
  assert.equal(reopened.valueMatches, true);

  const feeOnly = inspectPriceState([
    { label: "预估鱼小铺软件服务费 (1.6%)-¥3.18", bounds: [77, 1831, 1003, 1900] },
  ], "3.18");
  assert.equal(feeOnly.surface, "ambiguous");
  assert.equal(feeOnly.priceField, null);
  assert.equal(feeOnly.valueMatches, false);
});

test("priceFieldValueMatches compares the field amount exactly", () => {
  assert.equal(priceFieldValueMatches("价格设置199", "199"), true);
  assert.equal(priceFieldValueMatches("价格 ¥199.00", "199"), true);
  assert.equal(priceFieldValueMatches("价格设置19.90", "199"), false);
  assert.equal(priceFieldValueMatches("价格设置1199.00", "199"), false);
  assert.equal(priceFieldValueMatches("价格设置199.001", "199"), false);
  assert.equal(priceFieldValueMatches("价格设置", "199"), false);
  assert.equal(priceFieldValueMatches("预估服务费 ¥3.18", "3.18"), false);
});

test("draft persistence is blocked after any hard prior failure", () => {
  assert.equal(shouldPersistDraft({ requested: true, summaryOk: true }), true);
  assert.equal(shouldPersistDraft({ requested: true, summaryOk: false }), false);
  assert.equal(shouldPersistDraft({ requested: false, summaryOk: true }), false);
});

test("fillPriceField proves close, persisted readback, and final compose before success", async () => {
  const keypad = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"]
    .map((label, index) => ({ label, bounds: [40 + index * 10, 1700, 100 + index * 10, 1800] }));
  const sheet = (label) => [
    { label, bounds: [44, 912, 1036, 1044] },
    { label: "原价 0.00", bounds: [44, 1050, 1036, 1160] },
    { label: "库存 1000", bounds: [44, 1170, 1036, 1280] },
    ...keypad,
    { label: "确定", bounds: [857, 2109, 1033, 2274] },
  ];
  const compose = [
    { label: "宝贝描述", bounds: [77, 300, 1003, 600] },
    { label: "发布", className: "android.widget.Button", bounds: [900, 20, 1070, 150] },
  ];
  const snapshots = [sheet("价格设置"), sheet("价格设置199"), compose, sheet("价格设置199.00"), compose];
  const taps = [];
  let backs = 0;
  const op = {
    serial: "test-price",
    tap: async (...point) => { taps.push(point); },
    back: async () => { backs += 1; },
    shellExec: async () => ({ ok: true }),
  };
  const result = await fillPriceField(op, { bounds: [77, 1677, 1003, 1831] }, "199", {
    evidenceDir: "C:\\evidence",
    snapshotFn: async () => ({ nodes: snapshots.shift() }),
    captureFn: async (_op, path) => ({ path, bytes: 1, sha256: "a".repeat(64) }),
    settleFn: async () => {},
  });
  assert.equal(result.ok, true);
  assert.equal(result.verificationMethod, "sheet-reopen");
  assert.equal(snapshots.length, 0);
  assert.equal(backs, 0);
  assert.equal(taps.length, 7); // open + 3 digits + first confirm + reopen + readback confirm
});

test("fillPriceField fails closed when the first price sheet never proves compose closure", async () => {
  const keypad = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"]
    .map((label, index) => ({ label, bounds: [40 + index * 10, 1700, 100 + index * 10, 1800] }));
  const initial = [
    { label: "价格设置", bounds: [44, 912, 1036, 1044] },
    ...keypad,
    { label: "确定", bounds: [857, 2109, 1033, 2274] },
  ];
  const typed = initial.map((node, index) => index === 0 ? { ...node, label: "价格设置199" } : node);
  const sparseOpen = [{ label: "价格设置199", bounds: [44, 912, 1036, 1044] }];
  const snapshots = [initial, typed, sparseOpen, sparseOpen, sparseOpen];
  let backs = 0;
  const op = {
    serial: "test-price",
    tap: async () => {},
    back: async () => { backs += 1; },
    shellExec: async () => ({ ok: true }),
  };
  const result = await fillPriceField(op, { bounds: [77, 1677, 1003, 1831] }, "199", {
    evidenceDir: "C:\\evidence",
    snapshotFn: async () => ({ nodes: snapshots.shift() }),
    captureFn: async (_op, path) => ({ path, bytes: 1, sha256: "b".repeat(64) }),
    settleFn: async () => {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.step, "price-commit-close-unverified");
  assert.equal(backs, 1);
  assert.equal(snapshots.length, 0);
});

test("fillPriceField fails closed when persisted readback cannot prove the final compose", async () => {
  const keypad = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"]
    .map((label, index) => ({ label, bounds: [40 + index * 10, 1700, 100 + index * 10, 1800] }));
  const sheet = (label) => [
    { label, bounds: [44, 912, 1036, 1044] },
    { label: "原价 0.00", bounds: [44, 1050, 1036, 1160] },
    { label: "库存 1000", bounds: [44, 1170, 1036, 1280] },
    ...keypad,
    { label: "确定", bounds: [857, 2109, 1033, 2274] },
  ];
  const compose = [
    { label: "宝贝描述", bounds: [77, 300, 1003, 600] },
    { label: "价格设置", bounds: [77, 1677, 1003, 1831] },
    { label: "发布", className: "android.widget.Button", bounds: [900, 20, 1070, 150] },
  ];
  const sparseOpen = [{ label: "价格设置199", bounds: [44, 912, 1036, 1044] }];
  const snapshots = [
    sheet("价格设置"),
    sheet("价格设置199"),
    compose,
    sheet("价格设置199.00"),
    sparseOpen,
    sparseOpen,
    sparseOpen,
  ];
  let backs = 0;
  const op = {
    serial: "test-price",
    tap: async () => {},
    back: async () => { backs += 1; },
    shellExec: async () => ({ ok: true }),
  };
  const result = await fillPriceField(op, { bounds: [77, 1677, 1003, 1831] }, "199", {
    evidenceDir: "C:\\evidence",
    snapshotFn: async () => ({ nodes: snapshots.shift() }),
    captureFn: async (_op, path) => ({ path, bytes: 1, sha256: "c".repeat(64) }),
    settleFn: async () => {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.step, "price-readback-close-unverified");
  assert.equal(backs, 1);
  assert.equal(snapshots.length, 0);
});

test("findSkuSelectAll requires comma-prefix and trailing 全选 (recipe success label)", () => {
  const ok = findSkuSelectAll([
    { label: "全选，按钮 0, 全选", bounds: [40, 400, 200, 460], clickable: true },
  ]);
  assert.ok(ok);
  assert.deepEqual(ok.bounds, [40, 400, 200, 460]);
  // 裸「全选」或无尾缀：当前正则 miss（03 嫌疑）
  assert.equal(findSkuSelectAll([{ label: "全选", bounds: [40, 400, 200, 460] }]), null);
  assert.equal(findSkuSelectAll([{ label: "全选，按钮", bounds: [40, 400, 200, 460] }]), null);
});

test("waitForSkuPricePage skips transient sparse snapshots and stops on a business marker", async () => {
  const snapshots = [
    { nodes: [{ label: "加载中" }] },
    { nodes: [] },
    { nodes: [{ label: "批量设置价格和库存", bounds: [40, 1800, 1000, 1900] }] },
  ];
  const delays = [];
  const result = await waitForSkuPricePage({}, {
    attempts: 6,
    delayMs: 1,
    snapshotFn: async () => snapshots.shift(),
    settleFn: async (ms) => { delays.push(ms); },
  });
  assert.equal(result.navigationWait.ready, true);
  assert.equal(result.navigationWait.attempts, 3);
  assert.deepEqual(delays, [1, 1, 1]);
  assert.equal(result.nodes[0].label, "批量设置价格和库存");
});

test("summarizeSkuSelectAllMiss surfaces raw 全选 labels and page markers for job result", () => {
  const diag = summarizeSkuSelectAllMiss([
    { label: "取消批量设置", bounds: [10, 10, 100, 40], clickable: true },
    { label: "全选", bounds: [40, 400, 200, 460], clickable: true, className: "android.view.View" },
    { label: "已选 2", bounds: [220, 400, 360, 460] },
    { label: "批量设置价格和库存", bounds: [40, 2000, 1000, 2100], clickable: true },
    { label: "设置宝贝规格", bounds: [1, 1, 2, 2] }, // should not dominate markers if also batch
  ]);
  assert.equal(diag.kind, "sku-select-all-missing");
  assert.deepEqual(diag.labelsWithSelectAll, ["全选"]);
  assert.equal(diag.selectAllCandidates.length, 1);
  assert.equal(diag.selectAllCandidates[0].matchesFindSkuSelectAll, false);
  assert.equal(diag.markers.cancelBatch, true);
  assert.equal(diag.markers.batchEntry, true);
  assert.equal(diag.markers.selectedCount, 2);
  assert.equal(diag.markers.specsPage, true);
  assert.ok(diag.clickableLabelsSample.includes("全选"));
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

test("recoverDiscardDryRun relaunches to safe main when 闲鱼 is not in foreground (dialer)", async () => {
  // 03 漂到拨号盘：focus 不是闲鱼。restore() 必须自己 startIdlefish 回主页，零人工 tap。
  const dialerNodes = [
    { label: "1", bounds: [100, 1500, 300, 1700] },
    { label: "2", bounds: [400, 1500, 600, 1700] },
    { label: "呼叫", bounds: [430, 1900, 650, 2050], clickable: true },
  ];
  let started = false;
  const taps = [];
  const op = {
    serial: "device-03",
    transport: "gateway",
    async shellExec(command) {
      if (command === "wm size") return "Physical size: 1080x2400";
      if (command.startsWith("am start")) started = true;
      return "";
    },
    async currentFocus() {
      return started
        ? { package: "com.taobao.idlefish", activity: "com.taobao.idlefish.maincontainer.activity.MainActivity" }
        : { package: "com.android.contacts", activity: "TwelveKeyDialer" };
    },
    async dumpXml() {
      return recoveryXml(started ? device02BottomTabs : dialerNodes);
    },
    async tap(x, y) { taps.push([x, y]); },
    async capturePng(path) { return { path, bytes: 100, sha256: "f".repeat(64) }; },
  };

  const result = await recoverDiscardDryRun(op, { evidenceDir: "/tmp/xianyu-recovery-test" });
  assert.equal(result.ok, true);
  assert.equal(result.step, "relaunched-to-safe-main");
  assert.equal(result.safeStateVerified, true);
  assert.equal(result.savedDraft, false);
  assert.equal(taps.length, 0);
  assert.equal(result.evidenceFiles.some((f) => f.label === "xianyu-recovery-after-relaunch"), true);
});

test("recoverDiscardDryRun relaunches to safe main when delicate recovery cannot handle the page", async () => {
  // 03 服务类目 compose：闲鱼在前台但精细路径认不出该页 → 命中 unexpected-page 兜底，relaunch 回主页。
  const serviceComposeNodes = [
    { label: "服务类目", bounds: [40, 200, 1040, 400] },
    { label: "预计工期", bounds: [40, 500, 1040, 700] },
    { label: "售后服务", bounds: [40, 800, 1040, 1000] },
  ];
  let started = false;
  const taps = [];
  const op = {
    serial: "device-03",
    transport: "gateway",
    async shellExec(command) {
      if (command === "wm size") return "Physical size: 1080x2400";
      if (command.startsWith("am start")) started = true;
      return "";
    },
    async currentFocus() {
      return started
        ? { package: "com.taobao.idlefish", activity: "com.taobao.idlefish.maincontainer.activity.MainActivity" }
        : { package: "com.taobao.idlefish", activity: "FishFlutterBoostActivity" };
    },
    async dumpXml() {
      return recoveryXml(started ? device02BottomTabs : serviceComposeNodes);
    },
    async tap(x, y) { taps.push([x, y]); },
    async capturePng(path) { return { path, bytes: 100, sha256: "g".repeat(64) }; },
  };

  const result = await recoverDiscardDryRun(op, { evidenceDir: "/tmp/xianyu-recovery-test" });
  assert.equal(result.ok, true);
  assert.equal(result.step, "relaunched-to-safe-main");
  assert.equal(result.safeStateVerified, true);
  assert.equal(result.savedDraft, false);
  assert.equal(taps.length, 0);
});

test("discardDraftDryRun relaunches when service compose has no unique close/discard a11y", async () => {
  // job 末 restoration 走 discard-dry-run（非 recover）。03 服务类 compose：
  // isPublishCompose 可能为 true，但顶栏 X /「不保存」a11y 认不出 → 必须 startIdlefish 兜底。
  const serviceCompose = [
    { label: "发布，按钮, 发布", className: "android.view.View", bounds: [880, 94, 1080, 178] },
    { label: "分类/预计工期/售后服务/等", bounds: [74, 760, 1006, 870] },
    { label: "商品规格, 已设置2个规格", bounds: [74, 1650, 1006, 1770] },
    { label: "价格和库存, ¥12.34、库存4", bounds: [74, 1790, 1006, 1910] },
    { label: "发货方式, 包邮", bounds: [74, 1910, 1006, 2030] },
  ];
  let started = false;
  const taps = [];
  const shell = [];
  const op = {
    serial: "device-03",
    transport: "gateway",
    async shellExec(command) {
      shell.push(command);
      if (command === "wm size") return "Physical size: 1080x2400";
      if (command.startsWith("am start") || command.includes("force-stop")) started = true;
      return "";
    },
    async currentFocus() {
      return started
        ? { package: "com.taobao.idlefish", activity: "com.taobao.idlefish.maincontainer.activity.MainActivity" }
        : { package: "com.taobao.idlefish", activity: "FishFlutterBoostActivity" };
    },
    async dumpXml() {
      return recoveryXml(started ? device02BottomTabs : serviceCompose);
    },
    async tap(x, y) { taps.push([x, y]); },
  };

  const result = await discardDraftDryRun(op);
  assert.equal(result.ok, true);
  assert.equal(result.step, "relaunched-to-safe-main");
  assert.equal(result.savedDraft, false);
  assert.equal(result.fallbackFrom, "close-button");
  assert.equal(taps.length, 0);
  assert.equal(shell.some((c) => /force-stop/.test(c)), true);
  assert.equal(shell.some((c) => /am start/.test(c)), true);
});

test("discardDraftDryRun closes via explicit 不保存 when a11y is unique", async () => {
  const compose = [
    { label: "关闭", className: "android.widget.Button", clickable: true, bounds: [0, 80, 100, 180] },
    { label: "发布", className: "android.widget.Button", bounds: [880, 94, 1080, 178] },
    { label: "宝贝描述", bounds: [50, 300, 1000, 500] },
    { label: "价格", bounds: [50, 900, 1000, 1050] },
    { label: "添加图片", bounds: [50, 200, 200, 350] },
  ];
  const dialog = [
    { label: "不保存", className: "android.widget.Button", clickable: true, bounds: [42, 2143, 524, 2248] },
    { label: "存草稿", className: "android.widget.Button", clickable: true, bounds: [556, 2143, 1038, 2248] },
  ];
  let state = "compose";
  const taps = [];
  const op = {
    serial: "device-01",
    transport: "gateway",
    async shellExec(command) {
      if (command === "wm size") return "Physical size: 1080x2400";
      if (command.includes("force-stop") || command.startsWith("am start")) {
        throw new Error("should not relaunch when discard path works");
      }
      return "";
    },
    async currentFocus() {
      return state === "main"
        ? { package: "com.taobao.idlefish", activity: "com.taobao.idlefish.maincontainer.activity.MainActivity" }
        : { package: "com.taobao.idlefish", activity: "FishFlutterBoostActivity" };
    },
    async dumpXml() {
      return recoveryXml(state === "compose" ? compose : state === "dialog" ? dialog : device02BottomTabs);
    },
    async tap() {
      taps.push(state);
      state = state === "compose" ? "dialog" : "main";
    },
  };

  const result = await discardDraftDryRun(op);
  assert.equal(result.ok, true);
  assert.equal(result.step, "discarded-without-saving");
  assert.equal(result.savedDraft, false);
  assert.equal(taps.length, 2);
});

test("discardDraftDryRun treats already-safe main as success without taps", async () => {
  const taps = [];
  const op = {
    serial: "device-03",
    transport: "gateway",
    async shellExec(command) {
      if (command === "wm size") return "Physical size: 1080x2400";
      if (command.includes("force-stop") || command.startsWith("am start")) {
        throw new Error("should not relaunch when already safe main");
      }
      return "";
    },
    async currentFocus() {
      return { package: "com.taobao.idlefish", activity: "com.taobao.idlefish.maincontainer.activity.MainActivity" };
    },
    async dumpXml() { return recoveryXml(device02BottomTabs); },
    async tap(x, y) { taps.push([x, y]); },
  };
  const result = await discardDraftDryRun(op);
  assert.equal(result.ok, true);
  assert.equal(result.step, "already-on-safe-main");
  assert.equal(result.safeStateVerified, true);
  assert.equal(taps.length, 0);
});
