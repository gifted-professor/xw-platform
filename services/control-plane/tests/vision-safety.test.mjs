import test from "node:test";
import assert from "node:assert/strict";
import {
  fingerprintLabels,
  hasXianyuMainTabbarFingerprint,
  hasXianyuPublishComposeFingerprint,
  isForbiddenLabel,
  isFinancialCommitLabel,
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

// REX Phase 5 §8.4 B6: 视觉禁词从「外发/社交一律禁止」收窄为「只保护资金最终控件 +
// §14 未勾选的删除/永久注销」。publish/send/order/buy/follow 等非支付动作不再是 label 级
// 硬禁——它们由 ECP/classifier 判定，不在视觉闸这里被 blanket 卡死。
test("REX P5c B6: publish/send/order/buy/follow labels are non-payment freedom, not blanket-forbidden", () => {
  assert.equal(isForbiddenLabel("发布"), false);
  assert.equal(isForbiddenLabel("发送"), false);
  assert.equal(isForbiddenLabel("下单"), false);
  assert.equal(isForbiddenLabel("购买"), false);
  assert.equal(isForbiddenLabel("关注他"), false);
  assert.equal(isForbiddenLabel("想要"), false);
  assert.equal(isForbiddenLabel("聊一聊"), false);
});

test("REX P5c B6: money-final controls stay forbidden; delete/permanent-closure obey §14 (still blocked)", () => {
  assert.equal(isForbiddenLabel("确认支付"), true);
  assert.equal(isForbiddenLabel("立即购买"), true);
  assert.equal(isForbiddenLabel("加入购物车"), true);
  assert.equal(isForbiddenLabel("支付"), true);
  assert.equal(isForbiddenLabel("付款"), true);
  assert.equal(isForbiddenLabel("删除"), true); // §14 未勾选 → fail-closed
  assert.equal(isForbiddenLabel("注销"), true); // §14 未勾选 → fail-closed
  assert.equal(isForbiddenLabel("存草稿"), false); // 草稿单独能力，不在资金/删除闸默认字面
  assert.equal(isForbiddenLabel("下一步"), false);
});

test("REX P5c B6: isFinancialCommitLabel positively recognizes only money-final controls", () => {
  assert.equal(isFinancialCommitLabel("确认支付"), true);
  assert.equal(isFinancialCommitLabel("立即购买"), true);
  assert.equal(isFinancialCommitLabel("加入购物车"), true);
  assert.equal(isFinancialCommitLabel("支付方式"), false); // prepare, not the final commit
  assert.equal(isFinancialCommitLabel("发布"), false);
  assert.equal(isFinancialCommitLabel("删除"), false); // §14 decision, not a financial commit
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
  const r = resolveTarget([{ label: "确认支付", center: [900, 200], bounds: [800, 150, 1000, 250] }], {
    label: "确认支付",
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

test("gateTap: non-payment freedom; money-final and §14-delete stay blocked", () => {
  assert.equal(gateTap({ label: "发布" }).allow, true);
  assert.equal(gateTap({ label: "下一步" }).allow, true);
  assert.equal(gateTap({ label: "确认支付" }).allow, false);
  assert.equal(gateTap({ label: "删除" }).allow, false);
});
