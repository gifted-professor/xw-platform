// fixture 测试：_xhs-parse.mjs 的关注四态解析 + 主页浮层作者提取（req#9：四状态、desc-only、错误目标、按钮缺失）。
// inline XML 字符串经 allNodes 解析；纯解析、无设备 IO。
import assert from "node:assert/strict";
import test from "node:test";
import { findFollowBtn, findProfileAuthor, findProfileFollowBtn, followState } from "../ops/_xhs-parse.mjs";

// 合成 <node> 标签。allNodes 读 text/content-desc/class/clickable/bounds。
function node({ text = "", desc = "", cls = "android.widget.TextView", clickable = false, bounds = [800, 150, 1000, 210] } = {}) {
  const [L, T, R, B] = bounds;
  return `<node text="${text}" content-desc="${desc}" class="android.widget.${cls.replace(/^android\.widget\./, "")}" clickable="${clickable}" bounds="[${L},${T}][${R},${B}]" />`;
}
const xml = (nodes) => `<?xml version='1.0'?><hierarchy>${nodes.join("")}</hierarchy>`;

// 主页浮层头像：clickable ImageView，content-desc「头像,<name>」。
function avatar(name, bounds = [40, 100, 200, 260]) {
  return node({ desc: `头像,${name}`, cls: "android.widget.ImageView", clickable: true, bounds });
}
// 关注按钮：clickable Button/TextView。
function followBtn(label, { via = "text", bounds = [800, 150, 1000, 210], cls = "android.widget.Button" } = {}) {
  return node({
    text: via === "text" ? label : "",
    desc: via === "desc" ? label : "",
    cls,
    clickable: true,
    bounds,
  });
}

// ---------- followState：四状态 + missing + unknown ----------
test("followState classifies the four follow states", () => {
  assert.equal(followState("关注"), "unfollowed");
  assert.equal(followState("已关注"), "followed");
  assert.equal(followState("回关"), "unfollowed"); // 回关=未关注，tap 即回关
  assert.equal(followState("相互关注"), "followed");
  assert.equal(followState(""), "missing");
  assert.equal(followState(null), "missing");
  assert.equal(followState("粉丝 123"), "unknown");
});

// ---------- findFollowBtn：四状态 + desc-only + 缺失 + 假阳排除 ----------
test("findFollowBtn classifies the four follow states (text and desc separately)", () => {
  assert.equal(findFollowBtn(xml([followBtn("关注")])).matched, "关注");
  assert.equal(findFollowBtn(xml([followBtn("已关注")])).matched, "已关注");
  assert.equal(findFollowBtn(xml([followBtn("回关")])).matched, "回关");
  assert.equal(findFollowBtn(xml([followBtn("相互关注")])).matched, "相互关注");
  // desc-only：text 空、contentDesc=关注 仍命中
  assert.equal(findFollowBtn(xml([followBtn("关注", { via: "desc" })])).matched, "关注");
  assert.equal(findFollowBtn(xml([followBtn("已关注", { via: "desc" })])).matched, "已关注");
});

test("findFollowBtn returns null when no follow button is present", () => {
  assert.equal(findFollowBtn(xml([followBtn("评论")])), null);
  assert.equal(findFollowBtn(xml([])), null);
});

test("findFollowBtn rejects false-positive labels like 关注的话题 (exact-set, not includes)", () => {
  // 「关注的话题」不应被 includes 误中
  assert.equal(findFollowBtn(xml([node({ text: "关注的话题", clickable: true })])), null);
  // 同屏有真「关注」按钮仍能命中
  const hit = findFollowBtn(xml([
    node({ text: "关注的话题", clickable: true, bounds: [100, 150, 400, 210] }),
    followBtn("关注"),
  ]));
  assert.equal(hit.matched, "关注");
});

// ---------- findProfileAuthor：正确 / 错误目标 / 缺失 ----------
test("findProfileAuthor tier-1 extracts name from 头像,<name>", () => {
  assert.deepEqual(findProfileAuthor(xml([avatar("张三")])), { name: "张三", fallback: null });
  // 名字含逗号也只取「头像,」之后整体
  assert.equal(findProfileAuthor(xml([avatar("张三,二店")])).name, "张三,二店");
});

test("findProfileAuthor tier-1 miss returns name:null + fallback TextView", () => {
  // 无头像 desc → tier-1 miss；fallback 取顶部非 meta TextView
  const r = findProfileAuthor(xml([
    node({ text: "李四", bounds: [300, 120, 600, 170] }),
    node({ text: "粉丝 123", bounds: [300, 180, 600, 230] }),
  ]));
  assert.equal(r.name, null);
  assert.equal(r.fallback, "李四");
  // 全空 → 都 null
  assert.deepEqual(findProfileAuthor(xml([])), { name: null, fallback: null });
});

test("findProfileAuthor wrong-target mismatch is detectable by caller", () => {
  // 浮层作者=张三，调用方期望李四 → name 张三 ≠ 李四（调用方 fail-closed）
  const r = findProfileAuthor(xml([avatar("张三"), followBtn("关注")]));
  assert.equal(r.name, "张三");
  assert.notEqual(r.name, "李四");
});

// ---------- findProfileFollowBtn：浮层主 CTA 消歧（重放 overlay-01 的三 label 结构） ----------
// 合成 fixture 复刻 overlay-01.xml 的几何：头像 cy=364；背景控件 y=161（头像上方）；
// 统计 tab y=567（窄容器）；浮层主 CTA y=999（非 clickable label 套在 clickable 宽 FrameLayout 内）。
function root(bounds = [0, 0, 1080, 2400]) {
  const [L, T, R, B] = bounds;
  return `<node text="" content-desc="" class="android.widget.FrameLayout" clickable="false" bounds="[${L},${T}][${R},${B}]" />`;
}
function overlayCta(label, { cBounds = [33, 954, 474, 1042], lBounds = [215, 971, 293, 1026] } = {}) {
  return [
    node({ cls: "FrameLayout", clickable: true, bounds: cBounds }),
    node({ text: label, cls: "TextView", clickable: false, bounds: lBounds }),
  ];
}
function statTab(label, { cBounds = [44, 534, 184, 600], lBounds = [108, 536, 184, 597] } = {}) {
  return [
    node({ cls: "Button", clickable: true, bounds: cBounds }),
    node({ text: label, cls: "TextView", clickable: false, bounds: lBounds }),
  ];
}
function bgControl(label, { cBounds = [222, 122, 395, 199], lBounds = [222, 122, 395, 199] } = {}) {
  return [
    node({ cls: "FrameLayout", clickable: true, bounds: cBounds }),
    node({ text: label, cls: "TextView", clickable: false, bounds: lBounds }),
  ];
}

test("findProfileFollowBtn selects the wide overlay CTA below the avatar, not background/statistic labels", () => {
  const nodes = [
    root(),
    avatar("Mina姐姐", [5, 215, 302, 512]),
    ...bgControl("关注"), // y=161 头像上方
    ...statTab("关注"), // y=567 窄统计 tab
    ...overlayCta("关注"), // y=999 宽主 CTA
  ];
  const hit = findProfileFollowBtn(xml(nodes));
  assert.equal(hit.matched, "关注");
  assert.equal(hit.x, 254);
  assert.equal(hit.y, 998);
  assert.deepEqual([hit.L, hit.T, hit.R, hit.B], [33, 954, 474, 1042]);
});

test("findProfileFollowBtn preserves four-state handling under overlay mode", () => {
  for (const label of ["已关注", "回关", "相互关注"]) {
    const hit = findProfileFollowBtn(xml([root(), avatar("U", [5, 215, 302, 512]), ...overlayCta(label)]));
    assert.equal(hit.matched, label);
    assert.equal(hit.x, 254);
    assert.equal(hit.y, 998);
  }
});

test("findProfileFollowBtn returns null without tier-1 avatar (ordinary detail, not overlay)", () => {
  const nodes = [root(), ...bgControl("关注")];
  // 非浮层 → findProfileFollowBtn 不接管
  assert.equal(findProfileFollowBtn(xml(nodes)), null);
  // 通用 findFollowBtn 仍命中普通 detail 控件（既有行为保持）
  assert.equal(findFollowBtn(xml(nodes)).matched, "关注");
});

test("findProfileFollowBtn fails closed when no actionable candidate exists", () => {
  // 头像下方仅窄统计 tab；背景控件在头像上方 → 无宽 CTA
  const nodes = [root(), avatar("U", [5, 215, 302, 512]), ...bgControl("关注"), ...statTab("关注")];
  assert.equal(findProfileFollowBtn(xml(nodes)), null);
});

test("findProfileFollowBtn fails closed on two equally valid overlay CTAs", () => {
  const nodes = [
    root(),
    avatar("U", [5, 215, 302, 512]),
    ...overlayCta("关注", { cBounds: [33, 900, 474, 988], lBounds: [215, 917, 293, 972] }),
    ...overlayCta("关注", { cBounds: [33, 1100, 474, 1188], lBounds: [215, 1117, 293, 1172] }),
  ];
  assert.equal(findProfileFollowBtn(xml(nodes)), null);
});

test("findProfileFollowBtn fails closed when the below-avatar label has no clickable container", () => {
  const nodes = [
    root(),
    avatar("U", [5, 215, 302, 512]),
    node({ text: "关注", cls: "TextView", clickable: false, bounds: [215, 971, 293, 1026] }),
  ];
  assert.equal(findProfileFollowBtn(xml(nodes)), null);
});