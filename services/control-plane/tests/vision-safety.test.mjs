import test from "node:test";
import assert from "node:assert/strict";
import {
  fingerprintLabels,
  hasXianyuMainTabbarFingerprint,
  hasXianyuPublishComposeFingerprint,
  isForbiddenLabel,
  labelMatches,
  resolveTarget,
  gateTap,
} from "../scripts/vision-safety.mjs";

test("labelMatches rejects empty string footgun", () => {
  assert.equal(labelMatches("", "消息"), false);
  assert.equal(labelMatches("消息", ""), false);
  assert.equal(labelMatches("消息", "消息，未读"), true);
  assert.equal(labelMatches("消息", "市集"), false);
});

test("forbidden labels blocked", () => {
  assert.equal(isForbiddenLabel("发布"), true);
  assert.equal(isForbiddenLabel("存草稿"), false); // 草稿单独能力，不在视觉导航黑名单默认字面
  assert.equal(isForbiddenLabel("下一步"), false);
  assert.equal(isForbiddenLabel("想要"), true);
});

test("resolveTarget never picks empty label high-conf box", () => {
  const elements = [
    { label: "", conf: 0.99, center: [290, 2150], bounds: [200, 2100, 380, 2200] },
    { label: "消息", conf: 0.6, center: [540, 2300], bounds: [480, 2250, 600, 2350] },
  ];
  const r = resolveTarget(elements, { label: "消息", region: "tabbar", resolution: [1080, 2400] });
  assert.equal(r.ok, true);
  assert.equal(r.target.label, "消息");
  assert.notEqual(r.target.center[0], 290);
});

test("resolveTarget blocks forbidden needle", () => {
  const r = resolveTarget([{ label: "发布", center: [900, 200], bounds: [800, 150, 1000, 250] }], {
    label: "发布",
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "forbidden_needle");
});

test("xianyu main tabbar fingerprint", () => {
  const fp = fingerprintLabels([
    { label: "闲鱼，未读" },
    { label: "消息" },
    { label: "我的" },
    { label: "推荐流卡片很长很长超过限制的文案" },
  ]);
  assert.equal(hasXianyuMainTabbarFingerprint(fp), true);
  assert.equal(hasXianyuMainTabbarFingerprint(new Set(["消息", "我的"])), false);
});

test("publish compose fingerprint", () => {
  assert.equal(
    hasXianyuPublishComposeFingerprint(new Set(["描述一下宝贝", "价格", "分类"])),
    true,
  );
  assert.equal(hasXianyuPublishComposeFingerprint(new Set(["推荐", "关注"])), false);
});

test("gateTap forbids outbound", () => {
  assert.equal(gateTap({ label: "发布" }).allow, false);
  assert.equal(gateTap({ label: "下一步" }).allow, true);
});
