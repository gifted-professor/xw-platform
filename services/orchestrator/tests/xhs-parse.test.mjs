// fixture 测试：_xhs-parse.mjs 的关注四态解析 + 主页浮层作者提取（req#9：四状态、desc-only、错误目标、按钮缺失）。
// inline XML 字符串经 allNodes 解析；纯解析、无设备 IO。
import assert from "node:assert/strict";
import test from "node:test";
import { findFollowBtn, findProfileAuthor, followState } from "../ops/_xhs-parse.mjs";

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