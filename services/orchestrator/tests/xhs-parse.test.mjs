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
    avatar("U", [5, 215, 302, 512]),
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

// P1 回归（Hermes 独立验证）：两个不同 bounds 但同中心的 clickable 容器，旧按 center 去重会并成 1 个候选 → fail-open。
test("findProfileFollowBtn fails closed on two distinct same-center containers (dedupe by bounds)", () => {
  // A=[10,900][500,1100] center(255,1000)；B=[50,920][460,1080] center(255,1000)，B 套在 A 内。
  const A = [10, 900, 500, 1100];
  const B = [50, 920, 460, 1080];
  const nodes = [
    root(),
    avatar("U", [5, 215, 302, 512]),
    node({ cls: "FrameLayout", clickable: true, bounds: A }),
    node({ cls: "FrameLayout", clickable: true, bounds: B }),
    // label1 套在 B 内（A 也包住）→ 最小容器 B
    node({ text: "关注", cls: "TextView", clickable: false, bounds: [200, 950, 260, 1010] }),
    // label2 在 A 内但 B 外（x=470 > B.R=460）→ 最小容器 A
    node({ text: "关注", cls: "TextView", clickable: false, bounds: [470, 990, 490, 1010] }),
  ];
  assert.equal(findProfileFollowBtn(xml(nodes)), null);
});

// P2 回归（Hermes 独立验证）：离屏/无关节点 R=2000 不应抬高屏宽阈值、误拒真实宽 441 的 CTA。
test("findProfileFollowBtn derives screen width from root, not global max R (offscreen inflation)", () => {
  const nodes = [
    root(), // [0,0][1080,2400] → 屏宽 1080，阈值 324
    avatar("U", [5, 215, 302, 512]),
    // 离屏无关节点 R=2000：旧全局 max R 会把阈值抬到 600 → 误拒 441 的 CTA
    node({ cls: "FrameLayout", clickable: false, bounds: [1900, 0, 2000, 100] }),
    ...overlayCta("关注"), // 容器宽 441 [33,954][474,1042] → (254,998)
  ];
  const hit = findProfileFollowBtn(xml(nodes));
  assert.equal(hit.matched, "关注");
  assert.equal(hit.x, 254);
  assert.equal(hit.y, 998);
});

// ---------- Supplemental findings（Hermes 第二轮只读复验，20-VERIFICATION-RESULT.md 第 185 行后） ----------

// P1a 回归 #1：稀疏 dump 缺可信全屏 root（仅头像 + 140px 统计 tab）→ 旧以 nodes[0]=avatar(宽297) 当屏宽，
// 阈值 89，统计 140 通过 → 误点统计「关注」。应 fail-closed。
test("findProfileFollowBtn returns null when no trustworthy full-screen root exists (sparse dump)", () => {
  const nodes = [
    avatar("U", [5, 215, 302, 512]),
    ...statTab("关注"), // 容器 [44,534][184,600] 宽 140
  ];
  assert.equal(findProfileFollowBtn(xml(nodes)), null);
});

// P1a 回归 #2：截断 dump 首节点为子屏片段（不含头像），无全屏 root → 旧以该片段(宽200)当屏宽误点统计。
test("findProfileFollowBtn returns null on a truncated dump whose first node is sub-screen and does not wrap the avatar", () => {
  const nodes = [
    node({ cls: "FrameLayout", clickable: false, bounds: [0, 500, 200, 700] }), // 子屏片段，不含头像
    avatar("U", [5, 215, 302, 512]),
    ...statTab("关注"),
  ];
  assert.equal(findProfileFollowBtn(xml(nodes)), null);
});

// P1b 回归：全屏 clickable wrapper 包住裸 follow label 但无真实 CTA → 旧返回页面中心 (540,1200)。应 null。
test("findProfileFollowBtn excludes a page-sized clickable wrapper from CTA ancestors", () => {
  const nodes = [
    node({ cls: "FrameLayout", clickable: true, bounds: [0, 0, 1080, 2400] }), // 全屏 wrapper
    avatar("U", [5, 215, 302, 512]),
    node({ text: "关注", cls: "TextView", clickable: false, bounds: [500, 1180, 580, 1220] }), // 裸 label 中心 (540,1200)
  ];
  assert.equal(findProfileFollowBtn(xml(nodes)), null);
});

// P2-desc 回归：text="按钮" 与 content-desc="关注" 冲突 → matched 应取四态字段「关注」，而非 text||desc="按钮"。
test("findProfileFollowBtn picks the follow-state field when text and desc conflict", () => {
  const nodes = [
    root(),
    avatar("U", [5, 215, 302, 512]),
    node({ cls: "FrameLayout", clickable: true, bounds: [33, 954, 474, 1042] }),
    node({ text: "按钮", desc: "关注", cls: "TextView", clickable: false, bounds: [215, 971, 293, 1026] }),
  ];
  const hit = findProfileFollowBtn(xml(nodes));
  assert.ok(hit, "expected a CTA hit");
  assert.equal(hit.matched, "关注"); // 修复前为 "按钮"
  assert.equal(followState(hit.matched), "unfollowed");
});

// 唯一性回归：两个同面积(88000)、不同 bounds 的最小 clickable 容器都包住 label → 旧按输入序取 anc[0] 返回其一。
// 应 fail-closed（最小可操作容器不唯一）。
test("findProfileFollowBtn fails closed when the minimal clickable ancestor is not unique (same area, different bounds)", () => {
  // C1=[0,900][440,1100] 与 C2=[200,900][640,1100]：均 440x200=88000，互不包含但重叠；
  // label [300,1000][340,1010] 落在重叠区 → 两个都是最小容器 → 多候选 → null。
  const nodes = [
    root(),
    avatar("U", [5, 215, 302, 512]),
    node({ cls: "FrameLayout", clickable: true, bounds: [0, 900, 440, 1100] }),
    node({ cls: "FrameLayout", clickable: true, bounds: [200, 900, 640, 1100] }),
    node({ text: "关注", cls: "TextView", clickable: false, bounds: [300, 1000, 340, 1010] }),
  ];
  assert.equal(findProfileFollowBtn(xml(nodes)), null);
});

// ---------- Round-3 Hermes 复验新发现（21-VERIFICATION-RESULT-r3.md） ----------

// P1 #1：截断 wrapper 只要包含头像，旧「最大含头像节点」仍当可信 root → 误点统计 (114,567)。
// 修：可信 root 须含头像且宽 > 2× 头像宽（全屏窗口远宽于头像块）；wrapper=[0,0][400,700] 宽 400 < 594 → 不可信 → null。
test("findProfileFollowBtn returns null when only a sub-screen wrapper (not full-width) contains the avatar", () => {
  const nodes = [
    node({ cls: "FrameLayout", clickable: false, bounds: [0, 0, 400, 700] }), // 子屏 wrapper，含头像但非全屏
    avatar("U", [5, 215, 302, 512]),
    ...statTab("关注"), // [44,534][184,600] 宽 140
  ];
  assert.equal(findProfileFollowBtn(xml(nodes)), null);
});

// P1 #2：同一物理 CTA 出现冲突 follow 态时，旧按 bounds 去重 + XML 顺序决定 matched。
// 修：按容器 bounds 聚合所有态，>1 distinct state → null（不点击）。顺序无关。
test("findProfileFollowBtn fails closed on conflicting follow states in the same CTA (order: 关注 then 已关注)", () => {
  const nodes = [
    root(),
    avatar("U", [5, 215, 302, 512]),
    node({ cls: "FrameLayout", clickable: true, bounds: [33, 954, 474, 1042] }),
    node({ text: "关注", cls: "TextView", clickable: false, bounds: [215, 971, 293, 1026] }),
    node({ text: "已关注", cls: "TextView", clickable: false, bounds: [250, 975, 290, 1020] }),
  ];
  assert.equal(findProfileFollowBtn(xml(nodes)), null);
});

test("findProfileFollowBtn fails closed on conflicting follow states in the same CTA (order: 已关注 then 关注)", () => {
  const nodes = [
    root(),
    avatar("U", [5, 215, 302, 512]),
    node({ cls: "FrameLayout", clickable: true, bounds: [33, 954, 474, 1042] }),
    node({ text: "已关注", cls: "TextView", clickable: false, bounds: [215, 971, 293, 1026] }),
    node({ text: "关注", cls: "TextView", clickable: false, bounds: [250, 975, 290, 1020] }),
  ];
  assert.equal(findProfileFollowBtn(xml(nodes)), null);
});

// P1 #2 单节点：text 与 desc 都是四态且不同 → 节点自身歧义 → null（旧 text 优先取 "关注" 错）。
test("findProfileFollowBtn fails closed when one node has contradictory text and desc follow states", () => {
  const nodes = [
    root(),
    avatar("U", [5, 215, 302, 512]),
    node({ cls: "FrameLayout", clickable: true, bounds: [33, 954, 474, 1042] }),
    node({ text: "关注", desc: "已关注", cls: "TextView", clickable: false, bounds: [215, 971, 293, 1026] }),
  ];
  assert.equal(findProfileFollowBtn(xml(nodes)), null);
});