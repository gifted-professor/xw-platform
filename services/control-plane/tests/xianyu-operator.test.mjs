import test from "node:test";
import assert from "node:assert/strict";
import {
  descriptionContains,
  findDiscardWithoutSaving,
  findDescriptionField,
  findPublishEntry,
  isEmptyDescriptionField,
  isPublishCompose,
  parseAllUiNodes,
  semanticSnapshot,
} from "../scripts/xianyu-operator.mjs";

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
