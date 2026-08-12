#!/usr/bin/env node
/**
 * 抖音：搜索关键词 → 图文列表 → 开帖 → 分享给「天才较瘦」+ 飞书同款字段附言 → 发送
 *
 * 硬规则：
 *   - 禁止点好友行最左第一个（会点到群）
 *   - dump 找「天才较瘦」→ tap → 必须「已选中」再输入/发送
 *   - 附言 = 分享链接|标题|作者|Live角标|关键词|文本|采集状态
 *
 *   node ops/douyin-share-friend-harvest.mjs --alias 01 --session-file <ctx> --keyword "喀纳斯 live图" --need 10 --checkpoint-file <run-scoped.json>
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { parseArgs } from "./_explore-lib.mjs";
import { scoreXjLiveTitle } from "./_douyin-xj-live-lib.mjs";
import { decodeEntities } from "./_xhs-parse.mjs";
import {
  buildShareFriendMessage,
  extractDetailMeta,
} from "../runtime/xj-live-pipeline/share-friend-msg.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PKG = "com.ss.android.ugc.aweme";
const FRIEND = "天才较瘦";

const { opt, flag } = parseArgs(process.argv.slice(2));
if (flag("--help") || flag("-h")) {
  console.log(
    `用法: node ops/douyin-share-friend-harvest.mjs --alias 01 --session-file <ctx> --keyword "喀纳斯 live图" --need 10 [--checkpoint-file <run-scoped.json>]`,
  );
  process.exit(0);
}

const alias = opt("--alias", "01");
const sessionFile = opt("--session-file");
const keyword = opt("--keyword", "喀纳斯 live图");
const need = Math.max(1, Number(opt("--need", "10")) || 10);
const friendName = opt("--friend", FRIEND);
const failStop = Math.max(1, Number(opt("--fail-stop", "4")) || 4);
const resumeFile = opt("--resume-file");
const checkpointFile = opt("--checkpoint-file") || resumeFile;
if (!sessionFile) {
  console.log("✗ need --session-file");
  process.exit(4);
}
process.env.XHS_LOCAL = "1";

let resumeState = null;
const resumeSource = resumeFile || (checkpointFile && existsSync(checkpointFile) ? checkpointFile : null);
if (resumeSource) {
  try {
    const parsed = JSON.parse(readFileSync(resumeSource, "utf8"));
    if (parsed.keyword !== keyword || parsed.friend !== friendName || !Array.isArray(parsed.sent)) {
      throw new Error("resume keyword/friend/sent mismatch");
    }
    resumeState = parsed;
  } catch (e) {
    console.log(`✗ invalid checkpoint/resume file: ${e.message}`);
    process.exit(4);
  }
}

let sessionSerial = "";
try {
  const ctx = JSON.parse(readFileSync(sessionFile, "utf8"));
  sessionSerial = ctx.serial || ctx.deviceSerial || ctx.session?.serial || "";
} catch {}
if (!sessionSerial) {
  console.log("✗ session-file missing serial; refuse hardcoded device serial");
  process.exit(4);
}

const FUNNEL = { x: 1020, y: 276 };
const TUWEN = { x: 667, y: 1242 };
const DISMISS = { x: 540, y: 1900 };

const VISUAL_TAP_ROOT = join(ROOT, "..", "xhs-registry-visual-tap", "experiments", "visual-tap-resolver");
const VISUAL_PY = join(VISUAL_TAP_ROOT, ".venv-ocr", "Scripts", "python.exe");
const VISUAL_DEMO = join(VISUAL_TAP_ROOT, "visual_tap_demo.py");

const outDir = join(ROOT, "runtime/xj-live-pipeline/harvest-links");
mkdirSync(outDir, { recursive: true });
const checkpointPath = checkpointFile || join(outDir, "share-friend-sent.json");
mkdirSync(dirname(checkpointPath), { recursive: true });
const logPath = join(outDir, `share-friend-run-${Date.now()}.jsonl`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();

function log(row) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...row });
  appendFileSync(logPath, line + "\n");
  console.log(line);
}

function opsArgs(args) {
  if (args.includes("--session-file")) return args;
  return [...args, "--session-file", sessionFile];
}
function shNode(args, timeoutMs = 120000) {
  const r = spawnSync("node", opsArgs(args), {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, XHS_LOCAL: "1" },
    timeout: timeoutMs,
    maxBuffer: 20 * 1024 * 1024,
  });
  return ((r.stdout || "") + (r.stderr || "")).trim();
}
function kv(t) {
  const o = {};
  for (const line of String(t || "").split(/\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) o[m[1]] = m[2];
  }
  return o;
}
function parseNodes(raw) {
  const nodes = [];
  for (const m of String(raw || "").matchAll(/<node ([^>]+)\/>/g)) {
    const a = m[1];
    const get = (k) => {
      const r = a.match(new RegExp(k + '="([^"]*)"'));
      return r ? decodeEntities(r[1]) : "";
    };
    const b = get("bounds").match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    if (!b) continue;
    nodes.push({
      text: get("text"),
      desc: get("content-desc"),
      cls: get("class"),
      x1: +b[1],
      y1: +b[2],
      x2: +b[3],
      y2: +b[4],
      cx: ((+b[1] + +b[3]) / 2) | 0,
      cy: ((+b[2] + +b[4]) / 2) | 0,
      w: +b[3] - +b[1],
      h: +b[4] - +b[2],
    });
  }
  return nodes;
}
async function dumpXml() {
  for (let i = 0; i < 5; i++) {
    const out = shNode(["ops/dump-ui.mjs", "--alias", alias], 60000);
    // prefer path from DUMP= line when present
    const m = String(out).match(/DUMP=([^\r\n]+)/);
    if (m) {
      try {
        const raw = readFileSync(m[1].trim(), "utf8");
        if (raw.includes("<hierarchy") && raw.length > 1500) return raw;
      } catch {}
    }
    try {
      const dir = join(tmpdir(), "xhs-explore");
      const dumps = readdirSync(dir)
        .filter((f) => f.startsWith(`dump-${alias}-`) && f.endsWith(".xml"))
        .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
      if (dumps[0] && Date.now() - dumps[0].t < 30000) {
        const raw = readFileSync(join(dir, dumps[0].f), "utf8");
        if (raw.includes("<hierarchy") && raw.length > 1500) return raw;
      }
    } catch {}
    await sleep(600 + i * 400);
  }
  console.log("DUMP_MISS after retries");
  return null;
}
function tap(x, y) {
  shNode(["ops/tap.mjs", "--alias", alias, "--x", String(x), "--y", String(y)]);
}
function back() {
  shNode(["ops/back.mjs", "--alias", alias]);
}
function focusNow() {
  return kv(shNode(["ops/focus.mjs", "--alias", alias], 30000));
}
function isDetailFocus(foc) {
  const f = String(foc?.FOCUS || foc?.ACTIVITY || "");
  return /DetailActivity|FlowPage|aweme\.detail|DetailFeed/i.test(f);
}
function isSearchResultFocus(foc) {
  const f = String(foc?.FOCUS || foc?.ACTIVITY || "");
  return /SearchResult|search\.activity/i.test(f);
}

/**
 * 回搜索结果队列：优先左上角返回（半坐标加速：先点固定 77,167，focus 校验；
 * 失败再 dump 找「返回」）。不连按系统 back。
 */
async function returnToSearchQueue(reason) {
  if (isSearchResultFocus(focusNow())) {
    console.log(`BACK_UI already_on_search reason=${reason}`);
    return true;
  }
  // 半坐标：详情左上角返回（need=5/10 实测 77,167）
  console.log(`BACK_UI fixed 77,167 reason=${reason}`);
  tap(77, 167);
  await sleep(800);
  if (isSearchResultFocus(focusNow())) {
    console.log(`BACK_UI ok_on_search via=fixed reason=${reason}`);
    return true;
  }
  for (let i = 0; i < 2; i++) {
    const raw = await dumpXml();
    const ns = raw ? parseNodes(raw) : [];
    let btn =
      ns.find(
        (n) =>
          (n.desc === "返回" || n.text === "返回" || /返回|关闭|navigate.?up|Back/i.test(`${n.text}${n.desc}`)) &&
          n.y1 < 320 &&
          n.cx < 200,
      ) || null;
    if (!btn) {
      const corners = ns
        .filter((n) => n.y1 < 280 && n.x2 < 180 && n.w > 40 && n.h > 40 && n.w < 200 && n.h < 200)
        .sort((a, b) => a.x1 - b.x1 || a.y1 - b.y1);
      btn = corners[0] || null;
    }
    if (btn) {
      console.log(`BACK_UI dump-tap ${btn.cx},${btn.cy} reason=${reason} i=${i}`);
      tap(btn.cx, btn.cy);
      await sleep(800);
    } else {
      console.log(`BACK_UI miss → single key back reason=${reason} i=${i}`);
      back();
      await sleep(800);
    }
    if (isSearchResultFocus(focusNow())) {
      console.log(`BACK_UI ok_on_search via=dump reason=${reason}`);
      return true;
    }
  }
  console.log(`BACK_UI fail focus=${String(focusNow().FOCUS || "").slice(0, 60)} reason=${reason}`);
  return isSearchResultFocus(focusNow());
}
function avoidPublishZone(x, y) {
  if (y > 2050 && x > 380 && x < 700) return { x: 540, y: 1100 };
  if (y > 2200) return { x, y: 1800 };
  return { x, y };
}

function findFriendNodes(ns, name) {
  return ns
    .filter((n) => `${n.text}${n.desc}`.includes(name))
    .map((n) => ({
      ...n,
      selected: /已选中|已选择/i.test(`${n.text}${n.desc}`),
      area: n.w * n.h,
    }))
    .sort((a, b) => b.area - a.area);
}

async function selectFriend(name) {
  let raw = await dumpXml();
  let ns = raw ? parseNodes(raw) : [];
  let hits = findFriendNodes(ns, name);
  if (!hits.length) {
    console.log(`FRIEND_MISS name=${name}`);
    return { ok: false, reason: "friend_not_in_dump" };
  }
  // 禁止：盲点最左。只用名字命中节点。
  let pick = hits[0];
  console.log(`FRIEND_FIND name=${name} cx=${pick.cx},${pick.cy} d=${(pick.desc || pick.text || "").slice(0, 40)} selected=${pick.selected}`);
  if (!pick.selected) {
    tap(pick.cx, pick.cy);
    await sleep(1500);
    raw = await dumpXml();
    ns = raw ? parseNodes(raw) : [];
    hits = findFriendNodes(ns, name);
    pick = hits.find((h) => h.selected) || hits[0];
  }
  if (!pick?.selected) {
    // one retry
    if (pick) {
      tap(pick.cx, pick.cy);
      await sleep(1500);
      raw = await dumpXml();
      ns = raw ? parseNodes(raw) : [];
      hits = findFriendNodes(ns, name);
      pick = hits.find((h) => h.selected);
    }
  }
  if (!pick?.selected) {
    console.log(`FRIEND_NOT_SELECTED name=${name}`);
    return { ok: false, reason: "friend_not_selected" };
  }
  console.log(`FRIEND_SELECTED d=${(pick.desc || pick.text || "").slice(0, 50)} cx=${pick.cx},${pick.cy}`);
  return { ok: true, pick };
}

async function goSearch() {
  shNode(["ops/launch-app.mjs", "--alias", alias, "--package", PKG, "--force-stop"], 60000);
  await sleep(7000);
  let raw = await dumpXml();
  let ns = raw ? parseNodes(raw) : [];
  const search = ns
    .filter((n) => (n.desc === "搜索" || n.text === "搜索") && n.y1 < 280 && n.cx > 700)
    .sort((a, b) => b.cx - a.cx)[0];
  tap(search?.cx || 1003, search?.cy || 155);
  await sleep(2000);
  raw = await dumpXml();
  ns = raw ? parseNodes(raw) : [];
  const field = ns.find((n) => /EditText/.test(n.cls) && n.y1 < 400) || { cx: 446, cy: 161 };
  shNode(
    ["ops/input-text.mjs", "--alias", alias, "--text", keyword, "--x", String(field.cx), "--y", String(field.cy), "--clear-first"],
    90000,
  );
  await sleep(1000);
  raw = await dumpXml();
  ns = raw ? parseNodes(raw) : [];
  const btn = ns.find((n) => n.text === "搜索" && n.y1 < 250 && n.cx > 800);
  tap(btn?.cx || 959, btn?.cy || 161);
  await sleep(4500);
  raw = await dumpXml();
  ns = raw ? parseNodes(raw) : [];
  const zonghe = ns.find((n) => n.text === "综合" && n.y1 < 400);
  if (zonghe) {
    tap(zonghe.cx, zonghe.cy);
    await sleep(1000);
  }
  tap(FUNNEL.x, FUNNEL.y);
  await sleep(2000);
  tap(TUWEN.x, TUWEN.y);
  await sleep(1200);
  tap(DISMISS.x, DISMISS.y);
  await sleep(2000);
  console.log("GO_SEARCH+FILTER done");
}

/** 相关搜索芯片带：含「相关搜索」标签，或同带内短文案 chip */
function relatedSearchBandY(ns) {
  const label = (ns || []).find(
    (n) =>
      (n.text === "相关搜索" || n.desc === "相关搜索" || /^相关搜索/.test(n.text || "")) &&
      n.y1 > 300 &&
      n.y1 < 1200,
  );
  if (!label) return null;
  // 左栏竖排芯片可向下延伸；Y 带放宽，真正排除靠视觉 media_card
  return { y1: Math.max(300, label.y1 - 40), y2: Math.min(1700, label.y2 + 900), x2: Math.max(label.x2, 520) };
}

function hasRelatedSearch(ns) {
  if (relatedSearchBandY(ns)) return true;
  if ((ns || []).some((n) => /相关搜索|猜你想搜|大家都在搜/.test(`${n.text || ""}${n.desc || ""}`))) {
    return true;
  }
  // 左栏 ≥3 个短问句 → 典型相关搜竖列（无「相关搜索」字时也能触发视觉闸）
  const leftQs = (ns || []).filter((n) => {
    const t = String(n.text || "").trim();
    return (
      t.length >= 4 &&
      t.length <= 22 &&
      /吗$|？$|\?$/.test(t) &&
      n.x2 < 560 &&
      n.y1 > 350 &&
      n.y1 < 1700 &&
      n.h < 140
    );
  });
  return leftQs.length >= 3;
}

function isRelatedSearchChip(n, band) {
  const t = String(n.text || "").trim();
  if (!t) return false;
  if (/相关搜索|猜你想搜|大家都在搜/.test(t)) return true;
  // 短联想词/问句芯片（无 # 标签的短标题）
  if (t.length <= 18 && !/#/.test(t) && ( /吗$|？$|\?$|风景$|完整|电影|周边/.test(t) || n.h < 140 )) {
    return true;
  }
  if (t.length <= 22 && /吗$|？$|\?$/.test(t) && n.h < 140 && n.w < 700) return true;
  if (!band) return false;
  const inBand = n.y1 >= band.y1 && n.y2 <= band.y2 && (!band.x2 || n.cx <= band.x2);
  if (!inBand) return false;
  if (t.length <= 24 && n.h < 160 && n.w < 900) return true;
  return false;
}

function takeScreenshotPath() {
  const out = shNode(["ops/screenshot-and-analyze.mjs", "--alias", alias], 90000);
  const m = String(out).match(/SHOT=([^\r\n]+)/);
  return m ? m[1].trim() : null;
}

/** 有相关搜索时：截图 → visual-tap resolve → 只保留大图文 media 块安全点 */
function resolveVisualMediaCards(shotPath) {
  if (!shotPath) return [];
  const outVis = join(outDir, `visual-resolve-${Date.now()}`);
  mkdirSync(outVis, { recursive: true });
  const r = spawnSync(
    VISUAL_PY,
    [VISUAL_DEMO, "resolve", "--input", shotPath, "--output-dir", outVis],
    {
      cwd: VISUAL_TAP_ROOT,
      encoding: "utf8",
      timeout: 60000,
      maxBuffer: 20 * 1024 * 1024,
    },
  );
  const combined = `${r.stdout || ""}${r.stderr || ""}`;
  if (r.status !== 0) {
    console.log(`VISUAL_RESOLVE_FAIL status=${r.status} ${combined.slice(0, 200)}`);
    log({ op: "visual_resolve_fail", status: r.status, err: combined.slice(0, 300) });
    return [];
  }
  const jsonPath = join(outVis, "blocks.json");
  let payload;
  try {
    payload = JSON.parse(readFileSync(jsonPath, "utf8"));
  } catch (e) {
    console.log(`VISUAL_RESOLVE_BAD_JSON ${e}`);
    return [];
  }
  const [imgW, imgH] = payload?.input?.sourceResolution || [1080, 2400];
  const minArea = Math.floor(imgW * imgH * 0.02);
  const cards = (payload.blocks || [])
    .filter((b) => b.kind === "component" || b.kind === "media")
    .map((b) => {
      const [x, y, w, h] = b.sourceBBox || [0, 0, 0, 0];
      const [px, py] = b.sourceSafePoint || [0, 0];
      return {
        id: b.blockId,
        x,
        y,
        w,
        h,
        cx: px,
        cy: py,
        area: w * h,
        aspect: Math.max(w, h) / Math.max(1, Math.min(w, h)),
        score: b.proposalScore || 0,
        text: b.text || "",
      };
    })
    .filter((c) => c.area >= minArea && c.aspect <= 2.4 && c.w >= 280 && c.h >= 220)
    .filter((c) => c.y > 360 && c.y + c.h < imgH - 120 && c.cy < 1950 && c.cy > 420)
    .sort((a, b) => a.y - b.y || a.x - b.x || b.area - a.area);
  // 去重：中心过近只留更大块
  const picked = [];
  for (const c of cards) {
    if (picked.some((p) => Math.abs(p.cx - c.cx) < 120 && Math.abs(p.cy - c.cy) < 160)) continue;
    picked.push(c);
  }
  console.log(
    `VISUAL_CARDS n=${picked.length} from=${cards.length} blocks=${(payload.blocks || []).length} ms=${payload?.timingMs?.total} out=${outVis}`,
  );
  log({
    op: "visual_resolve",
    shot: shotPath,
    out: outVis,
    n: picked.length,
    points: picked.slice(0, 12).map((c) => ({ id: c.id, xy: [c.cx, c.cy], box: [c.x, c.y, c.w, c.h] })),
  });
  return picked;
}

function listCards(raw) {
  const ns = parseNodes(raw);
  const band = relatedSearchBandY(ns);
  if (band) {
    console.log(`RELATED_BAND y=${band.y1}-${band.y2} skip chips in band`);
  }
  return ns
    .filter((n) => n.text && n.text.length > 8 && n.y1 > 380 && n.y1 < 2100 && n.w > 250 && n.h < 400)
    .filter((n) => !isRelatedSearchChip(n, band))
    .filter((n) => !/ICP|综合|视频|用户|直播|搜索|图文|关注|相关/.test(n.text))
    .filter((n) => !(n.text.length <= 24 && /完整版|完整视频|电影/.test(n.text)))
    .map((n) => ({ ...n, ...scoreXjLiveTitle(n.text), _band: band }))
    .filter((n) => n.score >= 1 || /live|实况|新疆|阿勒泰|喀纳斯|图|赛里木|伊犁|禾木/i.test(n.text))
    .sort((a, b) => b.score - a.score || a.y1 - b.y1);
}

function normKw(s) {
  return String(s || "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

/** 顶栏搜索框是否仍是本轮 keyword（仅允许去空格等价，拒绝任何改写/联想词） */
function boxMatchesKeyword(box) {
  const b = normKw(box);
  const k = normKw(keyword);
  if (!b || !k) return false;
  if (/v\.douyin\.com|复制打开抖音|周边城市|旅游攻略/i.test(box)) return false;
  return b === k;
}

function readSearchBox(ns) {
  const n = (ns || []).find((x) => /EditText/.test(x.cls) && x.y1 < 400);
  return (n?.text || "").trim();
}

/**
 * 校验是否仍在「目标关键词」搜索结果队列。
 * 发现漂移即记录并停止当前关键词，不再自动重搜继续跑。
 */
async function ensureKeywordQueue(reason) {
  const foc = focusNow();
  if (!isSearchResultFocus(foc)) {
    console.log(`KW_CHECK not_search reason=${reason} focus=${String(foc.FOCUS || "").slice(0, 50)}`);
    return "not_search";
  }
  const raw = await dumpXml();
  const ns = raw ? parseNodes(raw) : [];
  const box = readSearchBox(ns);
  const ok = boxMatchesKeyword(box);
  log({ op: "kw_check", reason, box: box.slice(0, 60), want: keyword, ok });
  console.log(`KW_CHECK reason=${reason} box="${box.slice(0, 40)}" want="${keyword}" ok=${ok}`);
  if (ok) return "ok";
  console.log(`KW_MISMATCH → stop current keyword reason=${reason}`);
  log({ op: "kw_mismatch", reason, box: box.slice(0, 80), want: keyword });
  return "mismatch";
}

async function shareOneFromDetail(titleHint) {
  // 半坐标加速：详情附言用列表标题即可（少 1 次 dump）；开分享/发送走固定坐标；
  // 仅「找天才较瘦+已选中」必 dump。
  await sleep(900);
  let foc = focusNow();
  if (!isDetailFocus(foc)) {
    return { ok: false, reason: "not_detail", focus: foc.FOCUS };
  }
  const title = titleHint || "";
  const { msg, fields, msgLen } = buildShareFriendMessage({
    url: "",
    title,
    author: "",
    badge: "",
    keyword,
    caption: title,
    status: "ok",
  });

  // open share（固定坐标）
  console.log("SHARE_OPEN fixed 1004,2261");
  tap(1004, 2261);
  await sleep(1500);

  const sel = await selectFriend(friendName);
  if (!sel.ok) {
    // 若误开「已复制」面板：关一次再开分享
    if (sel.reason === "friend_not_in_dump") {
      console.log("SHARE_PANEL no friend → back + reopen once");
      back();
      await sleep(700);
      tap(1004, 2261);
      await sleep(1500);
      const sel2 = await selectFriend(friendName);
      if (!sel2.ok) return { ok: false, reason: sel2.reason, fields, msgLen };
    } else {
      return { ok: false, reason: sel.reason, fields, msgLen };
    }
  }

  // 想法框 + 发送（固定坐标）
  shNode(
    ["ops/input-text.mjs", "--alias", alias, "--text", msg, "--x", "540", "--y", "2106", "--clear-first"],
    120000,
  );
  await sleep(300);
  console.log("SEND fixed 541,2267");
  tap(541, 2267);
  await sleep(1800);
  foc = focusNow();
  const ok = isDetailFocus(foc) || isSearchResultFocus(foc);
  console.log(`SEND done focus=${String(foc.FOCUS || "").slice(0, 60)} msgLen=${msgLen}`);
  return {
    ok,
    reason: ok ? null : "after_send_focus",
    fields,
    msgLen,
    title: title.slice(0, 80),
    author: "",
    badge: "",
  };
}

async function main() {
  console.log(`START share-friend alias=${alias} keyword=${keyword} need=${need} friend=${friendName}`);
  console.log(`LOG=${logPath}`);
  const sent = resumeState ? [...resumeState.sent] : [];
  const resumedCount = sent.length;
  const seenTitles = new Set();
  const seenTitlePrefixes = new Set(
    sent.map((row) => String(row?.title || "").slice(0, 28)).filter(Boolean),
  );
  if (resumedCount) console.log(`RESUME existing=${resumedCount}/${need} file=${resumeSource}`);
  let attempts = 0;
  let pages = 0;
  let failStreak = 0;
  let stopReason = null;
  let forceVisualRest = false; // 本轮一旦见过相关搜，后续页强制走 visual

  await goSearch();
  const initialKw = await ensureKeywordQueue("after_goSearch");
  if (initialKw === "mismatch") {
    stopReason = "keyword_mismatch_after_goSearch";
  }

  while (!stopReason && sent.length < need && pages < 60) {
    const raw = await dumpXml();
    if (!raw) {
      log({ op: "dump_fail", page: pages });
      break;
    }
    const foc = focusNow();
    if (!isSearchResultFocus(foc) && !isDetailFocus(foc)) {
      console.log(`FOCUS_OFF ${String(foc.FOCUS || "").slice(0, 60)} → goSearch`);
      await goSearch();
      const kwSt = await ensureKeywordQueue("after_focus_off");
      if (kwSt === "mismatch") {
        stopReason = "keyword_mismatch_after_focus_off";
        break;
      }
      pages += 1;
      continue;
    }
    if (isDetailFocus(foc)) {
      await returnToSearchQueue("loop_stray_detail");
      const kwSt = await ensureKeywordQueue("after_stray_detail");
      if (kwSt === "mismatch") {
        stopReason = "keyword_mismatch_after_stray_detail";
        break;
      }
      continue;
    }

    // 每页开采前强制看顶栏：漂了就重搜，并打日志定位漂移点
    if (pages === 0 || pages % 1 === 0) {
      const kwSt = await ensureKeywordQueue(`page_${pages}`);
      if (kwSt === "mismatch") {
        stopReason = `keyword_mismatch_page_${pages}`;
        break;
      }
    }

    const nsPage = parseNodes(raw);
    const relatedNow = hasRelatedSearch(nsPage);
    if (relatedNow) forceVisualRest = true;
    const useVisual = relatedNow || forceVisualRest;
    let targets = [];
    if (useVisual) {
      console.log(
        `OPEN_MODE=visual_media_card (${relatedNow ? "related-search detected" : "force after prior related-search"})`,
      );
      const shot = takeScreenshotPath();
      if (!shot) {
        log({ op: "shot_fail", page: pages });
        console.log("SHOT_FAIL → fallback dump cards");
        targets = listCards(raw).map((c) => ({
          mode: "dump",
          tkey: c.text.slice(0, 28),
          title: c.text,
          card: c,
        }));
      } else {
        const vcards = resolveVisualMediaCards(shot);
        targets = vcards.map((c) => ({
          mode: "visual",
          tkey: `v:${c.id}:${Math.round(c.cx / 40)}:${Math.round(c.cy / 40)}`,
          title: c.text || `visual:${c.id}`,
          vx: c.cx,
          vy: c.cy,
          id: c.id,
          box: [c.x, c.y, c.w, c.h],
        }));
      }
    } else {
      console.log("OPEN_MODE=dump_listCards");
      targets = listCards(raw).map((c) => ({
        mode: "dump",
        tkey: c.text.slice(0, 28),
        title: c.text,
        card: c,
      }));
    }
    console.log(
      `PAGE=${pages} mode=${useVisual ? "visual" : "dump"} targets=${targets.length} have=${sent.length}/${need} elapsedMin=${((Date.now() - t0) / 60000).toFixed(1)}`,
    );
    let opened = 0;
    for (const t of targets) {
      if (sent.length >= need) break;
      if (seenTitles.has(t.tkey) || seenTitlePrefixes.has(String(t.title || "").slice(0, 28))) continue;
      if (t.mode === "dump" && t.card.y1 > 1750) continue;
      if (t.mode === "visual" && t.vy > 1750) continue;
      const preOpenKw = await ensureKeywordQueue(`pre_open_${attempts}`);
      if (preOpenKw === "mismatch") {
        stopReason = "keyword_mismatch_pre_open";
        break;
      }

      let tapX;
      let tapY;
      let titleHint = t.title;

      if (t.mode === "visual") {
        tapX = t.vx;
        tapY = t.vy;
        ({ x: tapX, y: tapY } = avoidPublishZone(tapX, tapY));
      } else {
        const c = t.card;
        const rawNow = await dumpXml();
        const nsNow = rawNow ? parseNodes(rawNow) : [];
        const bandNow = relatedSearchBandY(nsNow);
        if (
          isRelatedSearchChip(c, bandNow) ||
          (bandNow && c.y1 >= bandNow.y1 && c.y1 <= bandNow.y2 && c.cx <= (bandNow.x2 || 9999))
        ) {
          console.log(`SKIP_RELATED_CHIP ${c.text.slice(0, 36)} y=${c.y1}`);
          log({ op: "skip_related_chip", title: c.text.slice(0, 60), y1: c.y1, band: bandNow });
          continue;
        }
        tapX = c.cx;
        tapY = Math.max(480, Math.min(c.y1 - 200, 1500));
        const cover = nsNow
          .filter(
            (n) =>
              n.w > 260 &&
              n.h > 200 &&
              n.h < 1000 &&
              n.y1 > 360 &&
              n.y2 < 1950 &&
              n.y2 <= c.y1 + 60 &&
              Math.abs(n.cx - c.cx) < 380 &&
              !(bandNow && n.y1 >= bandNow.y1 && n.y2 <= bandNow.y2 && n.cx <= (bandNow.x2 || 9999)),
          )
          .sort((a, b) => b.h * b.w - a.h * a.w)[0];
        if (cover) {
          tapX = cover.cx;
          tapY = Math.min(Math.max(cover.y1 + Math.floor(cover.h * 0.35), 480), 1550);
        }
        ({ x: tapX, y: tapY } = avoidPublishZone(tapX, tapY));
        if (bandNow && tapY >= bandNow.y1 && tapY <= bandNow.y2 && tapX <= (bandNow.x2 || 9999)) {
          console.log(`SKIP_TAP_IN_RELATED_BAND xy=${tapX},${tapY} ${c.text.slice(0, 36)}`);
          log({ op: "skip_tap_related_band", xy: [tapX, tapY], title: c.text.slice(0, 60), band: bandNow });
          continue;
        }
        titleHint = c.text;
      }

      attempts += 1;
      opened += 1;
      console.log(`OPEN #${attempts} mode=${t.mode} xy=${tapX},${tapY} ${String(titleHint).slice(0, 36)}`);
      log({
        op: "open_attempt",
        n: attempts,
        mode: t.mode,
        xy: [tapX, tapY],
        title: String(titleHint).slice(0, 60),
        visualId: t.id || null,
        boxWant: keyword,
      });
      tap(tapX, tapY);
      await sleep(2800);
      let foc2 = focusNow();
      if (!isDetailFocus(foc2) && isSearchResultFocus(foc2)) {
        tap(tapX, Math.max(500, tapY - 80));
        await sleep(2800);
        foc2 = focusNow();
      }
      if (!isDetailFocus(foc2)) {
        log({ op: "open_fail", mode: t.mode, title: String(titleHint).slice(0, 60), focus: foc2.FOCUS || "" });
        failStreak += 0.5;
        if (failStreak >= failStop) {
          stopReason = `fail_stop_${failStreak}`;
          break;
        }
        continue;
      }
      seenTitles.add(t.tkey);
      const r = await shareOneFromDetail(titleHint);
      log({
        op: "share_friend",
        ok: r.ok,
        reason: r.reason || null,
        msgLen: r.msgLen,
        title: r.title,
        author: r.author,
        badge: r.badge,
        friend: friendName,
        openMode: t.mode,
      });
      if (!r.ok) {
        failStreak += 1;
        await returnToSearchQueue("after_share_fail");
        if (failStreak >= failStop) {
          stopReason = `fail_stop_${failStreak}`;
          break;
        }
        continue;
      }
      failStreak = 0;
      seenTitlePrefixes.add(String(r.title || "").slice(0, 28));
      sent.push({
        title: r.title,
        author: r.author,
        badge: r.badge,
        keyword,
        msgLen: r.msgLen,
        fields: r.fields,
        openMode: t.mode,
        at: new Date().toISOString(),
      });
      writeFileSync(
        checkpointPath,
        JSON.stringify({ keyword, need, friend: friendName, sent, at: new Date().toISOString() }, null, 2),
      );
      console.log(`SENT ${sent.length}/${need} mode=${t.mode} msgLen=${r.msgLen}`);
      await returnToSearchQueue("after_send");
      const kwSt = await ensureKeywordQueue("after_send_return");
      if (kwSt === "mismatch") {
        stopReason = "keyword_mismatch_after_send_return";
        break;
      }
    }
    if (stopReason || sent.length >= need) break;
    if (opened === 0) {
      // scroll
      shNode([
        "ops/swipe.mjs",
        "--alias",
        alias,
        "--x1",
        "540",
        "--y1",
        "1700",
        "--x2",
        "540",
        "--y2",
        "900",
        "--ms",
        "400",
      ]);
      await sleep(1500);
    }
    pages += 1;
  }

  const summary = {
    alias,
    keyword,
    friend: friendName,
    need,
    got: sent.length,
    resumedCount,
    newSent: sent.length - resumedCount,
    attempts,
    pages,
    failStreak,
    stopReason,
    elapsedSec: Math.round((Date.now() - t0) / 1000),
    secPerPost: sent.length ? Math.round((Date.now() - t0) / 1000 / sent.length) : null,
    logPath,
    checkpointPath,
  };
  writeFileSync(join(outDir, "share-friend-summary.json"), JSON.stringify(summary, null, 2));
  console.log(`DONE ${JSON.stringify(summary)}`);
  process.exit(sent.length >= need ? 0 : 2);
}

main().catch((e) => {
  console.log(String(e?.stack || e));
  process.exit(4);
});
