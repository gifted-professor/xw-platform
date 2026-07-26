import assert from "node:assert/strict";
import test from "node:test";

import { classifyXianyuPage } from "../scripts/xianyu-page-classifier.mjs";

const resolution = [1080, 2400];

function element(label, bounds) {
  return { label, bounds, center: [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2] };
}

test("classifies a complete Xianyu bottom-bar fingerprint as main-safe", () => {
  const result = classifyXianyuPage({
    resolution,
    focus: { package: "com.taobao.idlefish", activity: "com.taobao.idlefish.maincontainer.activity.MainActivity" },
    elements: [
      element("闲鱼", [0, 2140, 220, 2320]),
      element("消息", [610, 2140, 800, 2320]),
      element("我的", [850, 2140, 1070, 2320]),
      element("推荐", [100, 160, 240, 260]),
    ],
  });
  assert.equal(result.pageType, "main-safe");
  assert.equal(result.safeStateVerified, true);
  assert.ok(result.confidence >= 0.9);
});

test("does not accept MainActivity alone as a safe page", () => {
  const result = classifyXianyuPage({
    resolution,
    focus: { package: "com.taobao.idlefish", activity: "com.taobao.idlefish.maincontainer.activity.MainActivity" },
    elements: [element("下一步（1）", [780, 2100, 1060, 2300])],
  });
  assert.equal(result.pageType, "image-picker");
  assert.equal(result.safeStateVerified, false);
});

test("does not accept a semantic-only bottom bar as visual safe-state proof", () => {
  const result = classifyXianyuPage({
    resolution,
    focus: { package: "com.taobao.idlefish", activity: "com.taobao.idlefish.maincontainer.activity.MainActivity" },
    semanticNodes: [
      element("闲鱼", [0, 2140, 220, 2320]),
      element("消息", [610, 2140, 800, 2320]),
      element("我的", [850, 2140, 1070, 2320]),
    ],
  });
  assert.equal(result.pageType, "unknown");
  assert.equal(result.safeStateVerified, false);
});

test("does not accept an incomplete visual bottom bar", () => {
  const result = classifyXianyuPage({
    resolution,
    focus: { package: "com.taobao.idlefish", activity: "com.taobao.idlefish.maincontainer.activity.MainActivity" },
    elements: [
      element("闲鱼", [0, 2140, 220, 2320]),
      element("消息", [610, 2140, 800, 2320]),
    ],
  });
  assert.equal(result.pageType, "unknown");
  assert.equal(result.safeStateVerified, false);
});

test("does not accept a complete visual bottom bar with non-main focus", () => {
  const result = classifyXianyuPage({
    resolution,
    focus: { package: "com.taobao.idlefish", activity: "com.taobao.idlefish.publish.PublishActivity" },
    elements: [
      element("闲鱼", [0, 2140, 220, 2320]),
      element("消息", [610, 2140, 800, 2320]),
      element("我的", [850, 2140, 1070, 2320]),
    ],
  });
  assert.equal(result.pageType, "unknown");
  assert.equal(result.safeStateVerified, false);
});

test("classifies discard dialog ahead of compose markers", () => {
  const result = classifyXianyuPage({
    resolution,
    elements: [
      element("宝贝描述", [50, 300, 500, 500]),
      element("发布", [850, 2160, 1060, 2320]),
      element("不保存", [100, 1700, 450, 1870]),
      element("存草稿", [600, 1700, 980, 1870]),
    ],
  });
  assert.equal(result.pageType, "discard-dialog");
  assert.equal(result.safeStateVerified, false);
});

test("does not treat filled description text as discard-dialog actions", () => {
  const result = classifyXianyuPage({
    resolution,
    focus: { package: "com.taobao.idlefish", activity: "FishFlutterBoostActivity" },
    semanticNodes: [
      element("关闭", [0, 94, 113, 178]),
      element("发布", [880, 94, 1080, 178]),
      element("+添加优质 首图更吸引人~", [74, 257, 378, 561]),
      element("控制面库存验证 不保存草稿 不发布", [74, 575, 1006, 1121]),
    ],
  });
  assert.notEqual(result.pageType, "discard-dialog");
  assert.equal(result.safeStateVerified, false);
});

test("classifies SKU sheet and publish composer", () => {
  const sku = classifyXianyuPage({
    resolution,
    elements: [
      element("批量设置", [50, 200, 400, 320]),
      element("价格", [100, 500, 300, 620]),
      element("库存", [500, 500, 700, 620]),
      element("确定", [700, 2100, 1020, 2300]),
    ],
  });
  assert.equal(sku.pageType, "sku-sheet");

  const compose = classifyXianyuPage({
    resolution,
    elements: [
      element("宝贝描述", [50, 300, 600, 500]),
      element("商品规格", [50, 1200, 800, 1350]),
      element("运费", [50, 1400, 800, 1550]),
      element("发布", [820, 2140, 1060, 2320]),
    ],
  });
  assert.equal(compose.pageType, "publish-compose");
  assert.equal(compose.safeStateVerified, false);
});

test("classifies the fresh device-02 size-spec sheet fingerprint", () => {
  const result = classifyXianyuPage({
    resolution,
    focus: {
      package: "com.taobao.idlefish",
      activity: "com.idlefish.flutterbridge.flutterboost.boost.FishFlutterBoostTransparencyActivity",
    },
    elements: [
      element("尺码", [60, 320, 240, 430]),
      element("添加规格类型", [300, 960, 760, 1100]),
      element("下一步 设置价格和库存", [260, 2130, 850, 2280]),
    ],
  });
  assert.equal(result.pageType, "sku-sheet");
  assert.equal(result.safeStateVerified, false);
  assert.ok(result.confidence >= 0.9);
});

test("returns unknown for weak or conflicting evidence", () => {
  const result = classifyXianyuPage({
    resolution,
    elements: [element("消息", [600, 2140, 800, 2320]), element("价格", [50, 700, 400, 850])],
  });
  assert.equal(result.pageType, "unknown");
  assert.equal(result.safeStateVerified, false);
  assert.ok(result.reasons.length > 0);
});
