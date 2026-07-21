import test from "node:test";
import assert from "node:assert/strict";
import { findPublishEntry, isPublishCompose, semanticSnapshot } from "../scripts/xianyu-operator.mjs";

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
