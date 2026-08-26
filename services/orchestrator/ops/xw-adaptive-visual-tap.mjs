#!/usr/bin/env node
// xw-adaptive-visual-tap.mjs — 04 快车道 VISION 单击（plan §4.3）
//
// 在一条命令内：绑定 alias04 + Explorer session + screenshot hash/TTL/focus + 目标描述，
// 校验 Claude 给出的视觉块（越界 / 低置信 / 同名歧义 / 系统区 / 红线 label），把块
// 内容寻址为 blockId，从 bounds 确定性取中心，立即消费一次 actionRef，经现有 Explorer
// session 执行一次 tap；只回 blockId / jobId / evidence ref，不把最终坐标作为可复用授权。
//
//   node ops/xw-adaptive-visual-tap.mjs \
//     --alias 04 --session-file <ctx> \
//     --screenshot <path.png> --screenshot-hash <sha256> --captured-at <ms> \
//     --focus <focusJson|-> --target "搜索" \
//     --blocks <blocks.json|-> [--blocks-json '...'] \
//     [--ttl-ms 30000] [--confidence 0.5] [--ledger <path>] [--width W --height H]
//
// stdout: BLOCK_ID= ...  JOB= ...  EVIDENCE= ...  ACTION_REF= ...  (无 X= Y=)
// exit: 0 ok | 2 设备/lease | 3 视觉校验拒绝(可记 VISION 失败) | 4 客户端参数

import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, appendFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import {
  authorizeExplorerLease,
  parseArgs,
  resolveDevice,
  runExplorerPrimitive,
} from "./_explore-lib.mjs";

// ---------- 红线 label（plan §2/§4.3：支付/删除/账号/权限/验证码/风控/登录墙立即停） ----------
const REDLINE_LABELS = [
  "支付", "付款", "转账", "充值", "钱包", "余额", "提现",
  "删除", "注销", "改密", "修改密码", "解绑", "退出登录",
  "权限", "授权管理", "系统权限",
  "验证码", "风控", "安全验证", "滑块", "拼图",
  "登录", "login", "sign in", "注册",
  "发布", "发表", "发布笔记", "上传", "draft", "草稿",
  "收藏", "点赞", "关注", "评论", "私信", "消息",
];

// ---------- 纯函数（离线可测） ----------

export function isRedlineLabel(label) {
  const s = String(label || "").toLowerCase();
  return REDLINE_LABELS.some((r) => s.includes(r.toLowerCase()));
}

export function readPngDims(buf) {
  // PNG: 8-byte sig, then IHDR: 4 len + 4 "IHDR" + 4 width + 4 height (BE)
  if (!buf || buf.length < 24) return null;
  if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null;
  const width = (buf[16] << 24) | (buf[17] << 16) | (buf[18] << 8) | buf[19];
  const height = (buf[20] << 24) | (buf[21] << 16) | (buf[22] << 8) | buf[23];
  return { width: width >>> 0, height: height >>> 0 };
}

export function isOutOfBounds(bounds, dims) {
  const { x, y, w, h } = bounds;
  if (typeof x !== "number" || typeof y !== "number" || typeof w !== "number" || typeof h !== "number") {
    return true;
  }
  if (w <= 0 || h <= 0) return true;
  if (x < 0 || y < 0) return true;
  if (x + w > dims.width + 1 || y + h > dims.height + 1) return true; // +1 容错
  return false;
}

export function isSystemArea(bounds, dims) {
  // 顶部状态栏 / 底部导航条属系统区，不点
  const SYS_TOP = 72;
  const SYS_BOTTOM = 96;
  const { y, h } = bounds;
  if (y + h <= SYS_TOP) return true;
  if (y >= dims.height - SYS_BOTTOM) return true;
  return false;
}

export function blockCenter(bounds) {
  return {
    x: Math.round(bounds.x + bounds.w / 2),
    y: Math.round(bounds.y + bounds.h / 2),
  };
}

export function canonicalBlock(block) {
  return JSON.stringify({
    label: String(block.label || ""),
    region: String(block.region || ""),
    bounds: {
      x: Math.round(block.bounds.x),
      y: Math.round(block.bounds.y),
      w: Math.round(block.bounds.w),
      h: Math.round(block.bounds.h),
    },
  });
}

export function computeBlockId(block) {
  return "blk_" + createHash("sha256").update(canonicalBlock(block)).digest("hex").slice(0, 24);
}

export function rectOverlap(a, b) {
  const ax2 = a.x + a.w, ay2 = a.y + a.h, bx2 = b.x + b.w, by2 = b.y + b.h;
  return !(ax2 <= b.x || bx2 <= a.x || ay2 <= b.y || by2 <= a.y);
}

/**
 * 从候选块中选出目标块。严格 fail closed。
 * 返回 { block, blockId, center, reason }；拒绝时抛 { code, message }。
 */
export function selectBlock(blocks, target, opts) {
  const dims = opts.dims; // {width,height}
  const confThr = opts.confidenceThreshold ?? 0.5;
  if (!Array.isArray(blocks) || blocks.length === 0) {
    throw Object.assign(new Error("VISION_NO_BLOCKS: 候选块为空"), { code: 3, reasonCode: "DUMP_SPARSE" });
  }
  if (!target || !String(target).trim()) {
    throw Object.assign(new Error("VISION_NO_TARGET: 未提供目标描述"), { code: 4 });
  }
  const t = String(target).trim().toLowerCase();
  const matches = blocks.filter((b) => String(b.label || "").toLowerCase().includes(t));
  if (matches.length === 0) {
    throw Object.assign(new Error(`VISION_TARGET_NOT_FOUND: 目标"${target}"无匹配块`), { code: 3, reasonCode: "AMBIGUOUS" });
  }
  // 同名歧义：>1 个 label 匹配且彼此 bounds 不重叠才算不同实例；重叠则视为同等候选
  const unique = [];
  for (const m of matches) {
    const dup = unique.find((u) => rectOverlap(u.bounds, m.bounds));
    if (dup) {
      throw Object.assign(
        new Error(`VISION_AMBIGUOUS: 目标"${target}"有重叠同等候选`),
        { code: 3, reasonCode: "AMBIGUOUS" },
      );
    }
    unique.push(m);
  }
  if (unique.length > 1) {
    throw Object.assign(
      new Error(`VISION_AMBIGUOUS: 目标"${target}"匹配 ${unique.length} 个不重叠块`),
      { code: 3, reasonCode: "AMBIGUOUS" },
    );
  }
  const block = unique[0];
  if (isRedlineLabel(block.label)) {
    throw Object.assign(new Error(`VISION_REDLINE: 块"${block.label}"命中红线`), { code: 3, reasonCode: "REDLINE" });
  }
  if (isOutOfBounds(block.bounds, dims)) {
    throw Object.assign(new Error(`VISION_OUT_OF_BOUNDS: 块越界 ${JSON.stringify(block.bounds)}`), { code: 3, reasonCode: "AMBIGUOUS" });
  }
  if (isSystemArea(block.bounds, dims)) {
    throw Object.assign(new Error(`VISION_SYSTEM_AREA: 块落在系统区`), { code: 3, reasonCode: "AMBIGUOUS" });
  }
  const conf = Number(block.confidence ?? 1);
  if (conf < confThr) {
    throw Object.assign(new Error(`VISION_LOW_CONFIDENCE: confidence=${conf} < ${confThr}`), { code: 3, reasonCode: "AMBIGUOUS" });
  }
  const blockId = computeBlockId(block);
  const center = blockCenter(block.bounds);
  return { block, blockId, center, reason: "VISION_OK" };
}

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * 单次 actionRef：绑定 blockId + screenshotHash + sessionId + nonce。
 * ledger 记录已消费的 (screenshotHash, blockId)；重复则拒绝（防把旧图坐标拿到下一页复用）。
 */
export function consumeActionRef({ screenshotHash, blockId, sessionId, ledgerPath }) {
  const actionRef = "act_" + createHash("sha256")
    .update(`${screenshotHash}|${blockId}|${sessionId}|${randomUUID()}`)
    .digest("hex").slice(0, 24);
  if (ledgerPath) {
    const key = `${screenshotHash}|${blockId}`;
    let existing = "";
    try { existing = readFileSync(ledgerPath, "utf8"); } catch { /* new */ }
    if (existing.includes(key)) {
      throw Object.assign(new Error("VISION_ACTIONREF_CONSUMED: 该截图上的此块已消费过"), { code: 3, reasonCode: "AMBIGUOUS" });
    }
    mkdirSync(dirname(ledgerPath), { recursive: true });
    appendFileSync(ledgerPath, JSON.stringify({ key, actionRef, ts: Date.now() }) + "\n", "utf8");
  }
  return actionRef;
}

// ---------- main ----------
// 仅在作为入口脚本运行时执行；被 import（离线测试）时不跑 CLI。
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
(async () => {

const { opt, flag } = parseArgs(process.argv.slice(2));
const SSH = opt("--ssh", "xhs-windows");

if (flag("--help") || flag("-h")) {
  console.log(`用法: node ops/xw-adaptive-visual-tap.mjs --alias 04 --session-file <ctx> \\
  --screenshot <path.png> --screenshot-hash <sha256> --captured-at <ms> \\
  --focus <focusJson|-> --target "搜索" --blocks <blocks.json|-> [--blocks-json '...'] \\
  [--ttl-ms 30000] [--confidence 0.5] [--ledger <path>] [--width W --height H]

VISION 单击：校验视觉块 → 确定性取中心 → 经 Explorer session 一次 tap。
只回 BLOCK_ID / JOB / EVIDENCE / ACTION_REF，不回可复用坐标。`);
  process.exit(0);
}

// --probe：视觉 runtime 能力探针（plan §4.3.2）。
// 有 --screenshot：校验现有 PNG，算 hash/dims，回 PROBE_READY。
// 无 --screenshot 但有 --session-file：经 Explorer session 取 fresh screenshot 再回。
// Claude 拿到路径后用自己的 Read 工具读 PNG；读不出结构化块则 VISION 必须 STOP/VISION_RUNTIME_UNAVAILABLE。
if (flag("--probe")) {
  const probeScreenshot = opt("--screenshot");
  const probeSession = opt("--session-file");
  const probeAlias = opt("--alias");
  if (!probeScreenshot && !probeSession) fail("probe needs --screenshot <path> 或 --session-file <ctx>", 4);
  let probePath = probeScreenshot;
  let capturedAt = probeScreenshot ? (Number(opt("--captured-at") || 0) || Date.now()) : 0;
  if (!probeScreenshot) {
    if (probeAlias !== "04") fail("VISUAL_PROBE_ALIAS_NOT_04: 探针只允许 alias 04", 4);
    try { await authorizeExplorerLease(SSH, probeAlias, probeSession); } catch (e) { fail(`session 授权失败: ${e.message}`, 2); }
    const { copyExplorerEvidence } = await import("./_explore-session-action.mjs");
    const TS = Date.now();
    probePath = resolve(join(tmpdir(), "xhs-explore", `probe-${probeAlias}-${TS}.png`));
    const res = await runExplorerPrimitive({ primitive: "screen" });
    copyExplorerEvidence(res, "screen.png", probePath);
    capturedAt = TS;
  }
  if (!existsSync(probePath)) fail(`screenshot not found: ${probePath}`, 4);
  const probeHash = sha256File(probePath);
  const probeDims = (opt("--width") && opt("--height"))
    ? { width: Number(opt("--width")), height: Number(opt("--height")) }
    : readPngDims(readFileSync(probePath));
  if (!probeDims) fail("无法确定截图尺寸（PNG IHDR 损坏或缺 --width/--height）", 4);
  console.log(`PROBE_READY`);
  console.log(`SHOT=${probePath}`);
  console.log(`HASH=${probeHash}`);
  console.log(`WIDTH=${probeDims.width}`);
  console.log(`HEIGHT=${probeDims.height}`);
  console.log(`CAPTURED_AT=${capturedAt}`);
  console.log(`AGE_MS=${Date.now() - capturedAt}`);
  console.log("✓ probe ok — Claude runtime 须用 Read 工具读 SHOT 路径并返回结构化块；读不出则 STOP/VISION_RUNTIME_UNAVAILABLE");
  process.exit(0);
}

function readJsonArg(name, inlineFlag) {
  const inline = inlineFlag ? opt(inlineFlag) : null;
  if (inline != null) return JSON.parse(inline);
  const p = opt(name);
  if (!p) return null;
  if (p === "-") return JSON.parse(readFileSync(0, "utf8"));
  return JSON.parse(readFileSync(p, "utf8"));
}

function fail(msg, code = 4) {
  console.log(`✗ ${msg}`);
  process.exit(code);
}

const ALIAS = opt("--alias");
const SESSION_FILE = opt("--session-file");
const SCREENSHOT = opt("--screenshot");
const SCREENSHOT_HASH = opt("--screenshot-hash");
const CAPTURED_AT = Number(opt("--captured-at") || 0);
const FOCUS_RAW = opt("--focus");
const TARGET = opt("--target");
const TTL_MS = Number(opt("--ttl-ms") || 30000);
const CONF = Number(opt("--confidence") || 0.5);
const LEDGER = opt("--ledger");

if (ALIAS !== "04") fail("VISUAL_TAP_ALIAS_NOT_04: 视觉单击只允许 alias 04", 4);
if (!SESSION_FILE) fail("need --session-file", 4);
if (!SCREENSHOT) fail("need --screenshot <path.png>", 4);
if (!SCREENSHOT_HASH) fail("need --screenshot-hash <sha256>", 4);
if (!TARGET) fail("need --target <描述>", 4);
if (!CAPTURED_AT) fail("need --captured-at <ms>", 4);

// 1. 截图存在 + hash 一致（防陈旧图 / 拿旧图坐标复用）
if (!existsSync(SCREENSHOT)) fail(`screenshot not found: ${SCREENSHOT}`, 4);
const actualHash = sha256File(SCREENSHOT);
if (actualHash !== SCREENSHOT_HASH) {
  fail(`VISUAL_STALE_SCREENSHOT: hash 不一致（expected ${SCREENSHOT_HASH.slice(0,12)} got ${actualHash.slice(0,12)}）`, 3);
}

// 2. TTL：截图必须新鲜
const ageMs = Date.now() - CAPTURED_AT;
if (ageMs > TTL_MS) {
  fail(`VISUAL_STALE_SCREENSHOT: 截图年龄 ${ageMs}ms 超 TTL ${TTL_MS}ms`, 3);
}
if (ageMs < -5000) fail(`VISUAL_BAD_CAPTURED_AT: captured-at 在未来`, 4);

// 3. focus（可选；提供则原样回显以进入 closeout）
let focus = null;
if (FOCUS_RAW) focus = FOCUS_RAW === "-" ? JSON.parse(readFileSync(0, "utf8")) : JSON.parse(FOCUS_RAW);

// 4. dims：优先 --width/--height，否则从 PNG IHDR 读
let dims = null;
if (opt("--width") && opt("--height")) {
  dims = { width: Number(opt("--width")), height: Number(opt("--height")) };
} else {
  dims = readPngDims(readFileSync(SCREENSHOT));
}
if (!dims) fail("无法确定截图尺寸（--width/--height 或 PNG IHDR）", 4);

// 5. blocks
let blocks;
try {
  blocks = readJsonArg("--blocks", "--blocks-json");
} catch (e) {
  fail(`blocks 解析失败: ${e.message}`, 4);
}
if (!Array.isArray(blocks)) fail("blocks 必须是数组", 4);

// 6. 选块（纯函数，fail closed）
let selected;
try {
  selected = selectBlock(blocks, TARGET, { dims, confidenceThreshold: CONF });
} catch (e) {
  fail(`${e.message}`, e.code === 3 ? 3 : 4);
}

// 7. session 授权 + 单次 actionRef
let auth;
try {
  auth = await authorizeExplorerLease(SSH, ALIAS, SESSION_FILE);
} catch (e) {
  fail(`session 授权失败: ${e.message}`, e.code === 2 ? 2 : 4);
}
const sessionId = auth.session?.sessionId || "unknown";
let actionRef;
try {
  actionRef = consumeActionRef({
    screenshotHash: SCREENSHOT_HASH,
    blockId: selected.blockId,
    sessionId,
    ledgerPath: LEDGER,
  });
} catch (e) {
  fail(e.message, 3);
}

// 8. 一次 tap（经 Explorer session_action）
let tapResult;
try {
  tapResult = await runExplorerPrimitive({ primitive: "tap", x: selected.center.x, y: selected.center.y });
} catch (e) {
  fail(`tap 执行失败: ${e.message}`, e.code === 2 ? 2 : 4);
}

const { serial } = resolveDevice(SSH, ALIAS);
const evidenceRef = tapResult.storage?.evidenceDirectory || tapResult.storage?.runDirectory || "";

// 只回 refs，不回坐标
console.log(`BLOCK_ID=${selected.blockId}`);
console.log(`JOB=${tapResult.jobId}`);
console.log(`EVIDENCE=${evidenceRef}`);
console.log(`ACTION_REF=${actionRef}`);
console.log(`REASON=${selected.reason}`);
console.log(`SERIAL=${serial}`);
console.log(`ALIAS=${ALIAS}`);
console.log("✓ visual tap ok");
process.exit(0);
})();
}