#!/usr/bin/env node
/**
 * Harvest Douyin 图文 share links only → Feishu (no longmao).
 *
 *   node ops/douyin-harvest-share-links.mjs --alias 01 --session-file <ctx> --keyword "live实况新疆" --need 10
 *
 * 契约（2026-08-06）：
 *   1) 每个关键词只 goSearch + 漏斗图文 **一次**
 *   2) 之后只在结果队列里：开帖 → 分享链 → back → 同页下一条 / 滑下一页
 *   3) 剪贴板读不到时：在**详情页评论框** PASTE 读链，**禁止**碰结果页搜索框
 *   4) 禁止因搜索框文案变化而重搜同一关键词
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { parseArgs } from "./_explore-lib.mjs";
import { scoreXjLiveTitle, extractDouyinShareUrls } from "./_douyin-xj-live-lib.mjs";
import { decodeEntities } from "./_xhs-parse.mjs";
import { loadDotenv, requireEnv } from "../scripts/lib/load-dotenv.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
loadDotenv(ROOT);
const PKG = "com.ss.android.ugc.aweme";
const BASE = requireEnv("FEISHU_BASE_TOKEN");
const TABLE = requireEnv("FEISHU_DOUYIN_TABLE_ID");

const { opt, flag } = parseArgs(process.argv.slice(2));
if (flag("--help") || flag("-h")) {
  console.log(`用法: node ops/douyin-harvest-share-links.mjs --alias 01 --session-file <ctx> --keyword "live实况新疆" --need 10`);
  process.exit(0);
}

const alias = opt("--alias", "01");
const sessionFile = opt("--session-file");
const keyword = opt("--keyword", "live实况新疆");
const need = Math.max(1, Number(opt("--need", "50")) || 50);
if (!sessionFile) {
  console.log("✗ need --session-file from xw-explore-session acquire");
  process.exit(4);
}
process.env.XHS_LOCAL = "1";

let sessionSerial = "";
try {
  const ctx = JSON.parse(readFileSync(sessionFile, "utf8"));
  sessionSerial = ctx.serial || ctx.deviceSerial || ctx.session?.serial || "";
} catch {}
if (!sessionSerial) {
  console.log("✗ session-file missing serial; refuse hardcoded device serial");
  process.exit(4);
}

// 01 @1080x2400 实测（知识库 recipe-douyin-filter-funnel-tuwen-20260805）
const FUNNEL = { x: 1020, y: 276 };
const TUWEN = { x: 667, y: 1242 };
const DISMISS = { x: 540, y: 1900 };

const outDir = join(ROOT, "runtime", "xj-live-pipeline", "harvest-links");
mkdirSync(outDir, { recursive: true });
const logPath = join(outDir, `run-${Date.now()}.jsonl`);
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
/** 持 session 的受限 shell（不经已禁用的 ops/shell.mjs） */
function xwShell(cmd) {
  const r = spawnSync(
    "node",
    [
      "ops/_win-xiaowei.mjs",
      "--serial",
      sessionSerial,
      "--alias",
      alias,
      "--session-file",
      sessionFile,
      "--action",
      "shell",
      "--cmd",
      cmd,
      "--tag",
      "douyin-harvest-clip",
    ],
    { cwd: ROOT, encoding: "utf8", env: { ...process.env, XHS_LOCAL: "1" }, timeout: 30000 },
  );
  const text = ((r.stdout || "") + (r.stderr || "")).trim();
  let stdout = text;
  try {
    const j = JSON.parse(text.split("\n").filter(Boolean).pop());
    if (j && typeof j.stdout === "string") stdout = j.stdout;
    if (j && j.ok === false) console.log(`XW_SHELL_ERR ${String(j.error || "").slice(0, 120)}`);
  } catch {}
  return stdout || text;
}
function xwKey(...keys) {
  const text = xwShell("input keyevent " + keys.join(" "));
  console.log(`XW_KEY ${keys.join("+")} ok`);
  return text;
}
/** 读系统剪贴板拿 v.douyin.com（01 上常 miss：toast 已复制但 dumpsys 空） */
function readClipboardUrl() {
  const cmds = [
    "cmd clipboard get-clip",
    "dumpsys clipboard",
    "settings get secure clipboard",
  ];
  for (const cmd of cmds) {
    const out = xwShell(cmd);
    const urls = extractDouyinShareUrls(out);
    if (urls.length) {
      const url = urls[urls.length - 1];
      console.log(`CLIP_URL=${url} via=${cmd}`);
      return url;
    }
  }
  console.log("CLIP_URL=miss");
  return null;
}
/** 分享面板 / 复制后外发条：微信|微博|朋友圈|分享链接|私信… */
function isShareChrome(ns) {
  return (ns || []).some((n) =>
    /^(私信|推荐|建群分享|分享链接|复制链接|转发到日常|帮上热门|分享至群|微信|微信朋友圈|微博|QQ|朋友圈)$/.test(
      n.text || "",
    ),
  );
}

/** 外发 App 文案节点（点「分享链接」后会出现在 y≈2100 一带） */
function externalShareAppNodes(ns) {
  return (ns || []).filter((n) => /^(微信|微信朋友圈|微博|QQ|朋友圈|企业微信)$/.test(n.text || n.desc || ""));
}

/**
 * 关掉分享面板 + 复制后的「去粘贴分享 / 微信微博」外发条。
 * 探针实证：toast 后 微博≈(957,2125)，paste 右轨盲点 (1004,2075) 距其 ~68px → 误开微博。
 */
async function dismissShareChrome(reason) {
  for (let i = 0; i < 4; i++) {
    const raw = await dumpXml();
    const ns = raw ? parseNodes(raw) : [];
    const ext = externalShareAppNodes(ns);
    const chrome = isShareChrome(ns) || ns.some((n) => /链接已复制|去粘贴分享/.test(n.text || ""));
    if (!chrome && !ext.length) {
      if (i > 0) console.log(`DISMISS_SHARE_CHROME clear reason=${reason} rounds=${i}`);
      return "clear";
    }
    if (ext.length) {
      console.log(
        `DISMISS_SHARE_CHROME external=${ext.map((e) => `${e.text}@${e.cx},${e.cy}`).join("|")} reason=${reason}`,
      );
    } else {
      console.log(`DISMISS_SHARE_CHROME panel reason=${reason} i=${i}`);
    }
    back();
    await sleep(700);
  }
  return "maybe_left";
}

/**
 * 详情页读链兜底：关掉分享面板 → 开评论输入框 PASTE（y>=400）→ 读 URL。
 * 禁止碰顶栏搜索框。读完 dismiss，仍停在详情，由调用方 back 回列表。
 */
async function pasteDetailCommentReadUrl() {
  console.log("PASTE_DETAIL begin (no search box)");
  let foc = focusNow();
  if (!isDetailFocus(foc)) {
    console.log(`PASTE_DETAIL skip: not_on_detail focus=${String(foc?.FOCUS || "").slice(0, 60)}`);
    return null;
  }

  // 硬闸：有 微博/微信 外发条时禁止右轨盲点（会点到微博）
  await dismissShareChrome("paste_detail_enter");

  let raw = await dumpXml();
  let ns = raw ? parseNodes(raw) : [];
  if (externalShareAppNodes(ns).length || isShareChrome(ns)) {
    console.log("PASTE_DETAIL abort: share chrome still visible after dismiss");
    return null;
  }

  /**
   * 评论输入框优选（01 实证）：
   *   成功：tap_input 245,2285 y1=2230
   *   失败：tap_input 468,2343 y1=2330（粘贴后仍「说点什么」）
   * 规则：y1∈[2180,2320] 且偏左；拒绝贴底导航条附近 y1>2325。
   */
  const pickCommentField = (nodes) => {
    const edits = nodes.filter((n) => /EditText/.test(n.cls) && n.y1 >= 400 && n.y1 < 2360);
    if (!edits.length) return null;
    const score = (n) => {
      let s = 0;
      if (n.y1 >= 2180 && n.y1 <= 2320) s += 50;
      else if (n.y1 > 2320) s -= 40; // 实证 miss 区
      if (n.cx < 400) s += 30;
      else if (n.cx < 550) s += 10;
      else s -= 10;
      if (n.w > 200) s += 5;
      // 越靠近成功锚点越好
      s -= Math.hypot(n.cx - 245, n.cy - 2285) / 20;
      return s;
    };
    edits.sort((a, b) => score(b) - score(a));
    const best = edits[0];
    console.log(
      `PASTE_FIELD_PICK cx=${best.cx} cy=${best.cy} y1=${best.y1} score=${score(best).toFixed(1)} candidates=${edits.length}`,
    );
    return best;
  };

  const pickCommentOpener = (nodes) => {
    const byDesc = nodes.find(
      (n) => /评论/.test(n.desc || "") && n.cx > 880 && n.cy > 1400 && n.cy < 2050 && !/分享/.test(n.desc || ""),
    );
    if (byDesc) return byDesc;
    const byText = nodes.find((n) => n.text === "评论" && n.cx > 880 && n.cy > 1400 && n.cy < 2050);
    if (byText) return byText;
    // FlowPage 右轨：分享≈2261；评论在其上方。勿用 2075——复制后微博条在 y≈2125
    const share = nodes.find((n) => (n.text === "分享" || /分享/.test(n.desc || "")) && n.cx > 900 && n.cy > 1800);
    if (share) return { cx: share.cx, cy: Math.max(1500, share.cy - 280), desc: "derived-above-share" };
    return { cx: 1004, cy: 1900, desc: "flow-comment-safe" };
  };

  let field = pickCommentField(ns);
  if (!field) {
    const hint = ns.find((n) => n.y1 >= 400 && /说点什么|善语结善缘|留下你的评论|发条评论/.test(`${n.text}${n.desc}`));
    if (hint) {
      console.log(`PASTE_DETAIL tap_hint ${hint.cx},${hint.cy}`);
      tap(hint.cx, hint.cy);
      await sleep(1000);
      raw = await dumpXml();
      ns = raw ? parseNodes(raw) : [];
      field = pickCommentField(ns);
    }
  }

  if (!field) {
    if (externalShareAppNodes(ns).length) {
      await dismissShareChrome("before_comment_opener");
      raw = await dumpXml();
      ns = raw ? parseNodes(raw) : [];
    }
    const opener = pickCommentOpener(ns);
    const tooNearExt = externalShareAppNodes(ns).some(
      (e) => Math.hypot(e.cx - opener.cx, e.cy - opener.cy) < 120,
    );
    if (tooNearExt) {
      console.log(`PASTE_DETAIL refuse_opener_near_external ${opener.cx},${opener.cy}`);
    } else {
      console.log(`PASTE_DETAIL open_comments ${opener.cx},${opener.cy} via=${opener.desc || opener.text || "评论"}`);
      tap(opener.cx, opener.cy);
      await sleep(1600);
      if (isAppLaunchGate(focusNow(), null) || focusLooksLikeGateFromShell() || isForeignShareAppFocus(focusNow())) {
        await dismissAppLaunchGate("paste_detail_opener");
        await escapeForeignApp("paste_detail_opener");
        return null;
      }
      raw = await dumpXml();
      ns = raw ? parseNodes(raw) : [];
      field = pickCommentField(ns);
    }
  }

  if (!field) {
    // 禁止 2050–2200：探针微博 text 中心 (957,2125)，旧 2075 盲点必撞
    const railYs = [1900, 1750, 1600, 1450];
    for (const cy of railYs) {
      raw = await dumpXml();
      ns = raw ? parseNodes(raw) : [];
      if (externalShareAppNodes(ns).length || isShareChrome(ns)) {
        console.log(`PASTE_DETAIL rail abort: chrome still up before y=${cy}`);
        await dismissShareChrome(`rail_${cy}`);
        continue;
      }
      if (isAppLaunchGate(focusNow(), ns) || focusLooksLikeGateFromShell()) {
        await dismissAppLaunchGate(`rail_${cy}`);
        return null;
      }
      console.log(`PASTE_DETAIL try_rail_comment 1004,${cy}`);
      tap(1004, cy);
      await sleep(1400);
      if (isAppLaunchGate(focusNow(), null) || isForeignShareAppFocus(focusNow()) || focusLooksLikeGateFromShell()) {
        await dismissAppLaunchGate(`after_rail_${cy}`);
        await escapeForeignApp(`after_rail_${cy}`);
        return null;
      }
      raw = await dumpXml();
      ns = raw ? parseNodes(raw) : [];
      const edits = ns.filter((n) => /EditText/.test(n.cls));
      console.log(
        `PASTE_DETAIL after_rail edits=${edits.map((e) => `${e.y1}@${(e.text || "").slice(0, 12)}`).join(",") || "none"}`,
      );
      field = pickCommentField(ns);
      if (field) break;
      const hint2 = ns.find((n) => /说点什么|善语结善缘|留下你的评论/.test(`${n.text}${n.desc}`) && n.y1 >= 400);
      if (hint2) {
        tap(hint2.cx, hint2.cy);
        await sleep(800);
        raw = await dumpXml();
        ns = raw ? parseNodes(raw) : [];
        field = pickCommentField(ns);
        if (field) break;
      }
      if (isCommentSheet(ns)) break;
    }
  }

  // 最后兜底：点详情底栏中下部（非搜索、非拍摄键区）
  if (!field) {
    for (const [x, y] of [
      [300, 2280],
      [420, 2280],
      [540, 2200],
    ]) {
      console.log(`PASTE_DETAIL fallback_tap_bottom_bar ${x},${y}`);
      tap(x, y);
      await sleep(1000);
      raw = await dumpXml();
      ns = raw ? parseNodes(raw) : [];
      field = pickCommentField(ns);
      if (field) break;
    }
  }

  if (!field) {
    console.log("PASTE_DETAIL miss: no_comment_input");
    return null;
  }
  if (field.y1 < 400) {
    console.log(`PASTE_DETAIL refuse_search_box y1=${field.y1}`);
    return null;
  }

  console.log(`PASTE_DETAIL tap_input ${field.cx},${field.cy} y1=${field.y1}`);
  tap(field.cx, field.cy);
  await sleep(450);
  xwKey("KEYCODE_PASTE");
  await sleep(1000);

  raw = await dumpXml();
  ns = raw ? parseNodes(raw) : [];
  let clip = "";
  for (const n of ns) {
    const t = `${n.text || ""} ${n.desc || ""}`;
    if (/v\.douyin\.com|复制打开抖音/.test(t)) clip += " " + t;
    if (/EditText/.test(n.cls) && n.y1 >= 400 && n.text) clip += " " + n.text;
  }
  const urls = extractDouyinShareUrls(clip);
  const url = urls.length ? urls[urls.length - 1] : null;
  console.log(`PASTE_DETAIL_URL=${url || "null"} snip=${clip.replace(/\s+/g, " ").slice(0, 80)}`);

  // 收起键盘/评论，别发出去
  back();
  await sleep(600);
  if (isCommentSheet(parseNodes(await dumpXml()))) {
    back();
    await sleep(600);
  }
  if (!isDetailFocus(focusNow()) && !isSearchResultFocus(focusNow())) {
    back();
    await sleep(600);
  }
  return url;
}

function isSearchResultFocus(foc) {
  const f = String(foc?.FOCUS || foc?.ACTIVITY || "");
  return /SearchResult|search\.activity/i.test(f);
}

/** @deprecated 禁止再用搜索框读剪贴板；保留空壳防误调 */
async function pasteSearchBoxReadUrlThenClear() {
  console.log("PASTE_SEARCH_BOX blocked — use pasteDetailCommentReadUrl");
  return null;
}

/** 仅当结果页搜索框被脏链污染时的清理；正常采链路径不应触发 */
async function restoreKeywordTextNoSearch() {
  let raw = await dumpXml();
  let ns = raw ? parseNodes(raw) : [];
  const field = ns.find((n) => /EditText/.test(n.cls) && n.y1 < 400);
  if (!field) return;
  const box = (field.text || "").trim();
  if (!/v\.douyin\.com|复制打开抖音/i.test(box)) return;
  console.log("BOX_DIRTY cleanup (unexpected)");
  const clearBtn =
    ns.find((n) => n.desc === "清空" && n.y1 < 280) ||
    ns.find((n) => /清空|清除/.test(`${n.text}${n.desc}`) && n.y1 < 280 && n.cx > 780);
  if (clearBtn) {
    tap(clearBtn.cx, clearBtn.cy);
    await sleep(400);
  }
  shNode(
    ["ops/input-text.mjs", "--alias", alias, "--text", keyword, "--x", String(field.cx), "--y", String(field.cy), "--clear-first"],
    90000,
  );
  await sleep(400);
  raw = await dumpXml();
  ns = raw ? parseNodes(raw) : [];
  if (!ns.some((n) => n.text === "综合" || n.text === "视频")) {
    back();
    await sleep(700);
  }
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
/** dump 限时：最多 3 轮、单次 25s，避免 SHARE_TAP 后静默 1～2min */
async function dumpXml() {
  const t0dump = Date.now();
  for (let i = 0; i < 3; i++) {
    shNode(["ops/dump-ui.mjs", "--alias", alias], 25000);
    try {
      const dir = join(tmpdir(), "xhs-explore");
      const dumps = readdirSync(dir)
        .filter((f) => f.startsWith(`dump-${alias}-`) && f.endsWith(".xml"))
        .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
      if (dumps[0]) {
        // 只要本轮新写的 dump（2s 内）；避免读到陈旧大文件当成功
        const ageMs = Date.now() - dumps[0].t;
        const raw = readFileSync(join(dir, dumps[0].f), "utf8");
        if (raw.includes("<hierarchy") && raw.length > 4000 && ageMs < 15000) {
          if (Date.now() - t0dump > 8000) {
            console.log(`DUMP_OK slowMs=${Date.now() - t0dump} try=${i + 1}`);
          }
          return raw;
        }
      }
    } catch {}
    await sleep(400 + i * 300);
  }
  console.log(`DUMP_MISS ms=${Date.now() - t0dump}`);
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
function isPublishFocus(foc) {
  const f = String(foc?.FOCUS || foc?.ACTIVITY || "");
  return /MvChoose|album\.|Record|Publish|Creative|ShortVideo|MediaChoose|ImageChooser|CameraActivity|shoot/i.test(f);
}
function isWrongFocus(foc) {
  const f = String(foc?.FOCUS || foc?.ACTIVITY || "");
  // music / profile / live / search-suggest side trips
  return /MusicDetail|LivePlay|ProfileEdit|WebView|browser|Login|Verify|Capture/i.test(f);
}
function isDetailFocus(foc) {
  const f = String(foc?.FOCUS || foc?.ACTIVITY || "");
  return /DetailActivity|FlowPage|aweme\.detail|DetailFeed/i.test(f);
}
function isSearchFocus(raw) {
  const ns = parseNodes(raw || "");
  return ns.some((n) => n.text === "综合" || n.text === "图文" || n.text === "视频") ||
    ns.some((n) => /EditText/.test(n.cls) && n.y1 < 400);
}
/** Never tap Douyin bottom 拍摄 (+ ) zone or publish chrome. */
function avoidPublishZone(x, y) {
  // bottom center camera tab ~[430-650, 2100-2340] on 1080x2340
  if (y > 2050 && x > 380 && x < 700) return { x: 540, y: 1100 };
  if (y > 2200) return { x, y: 1800 };
  return { x, y };
}
async function escapePublish(reason) {
  console.log(`ESCAPE_PUBLISH reason=${reason}`);
  log({ op: "escape_publish", reason });
  for (let i = 0; i < 6; i++) {
    const foc = focusNow();
    if (!isPublishFocus(foc)) break;
    back();
    await sleep(700);
  }
  let foc = focusNow();
  if (isPublishFocus(foc)) {
    shNode(["ops/launch-app.mjs", "--alias", alias, "--package", PKG, "--force-stop"], 60000);
    await sleep(6000);
    await goSearch();
    return "researched";
  }
  const raw = await dumpXml();
  if (!isSearchFocus(raw)) {
    await goSearch();
    return "researched";
  }
  return "backed";
}

function listCards(raw) {
  const ns = parseNodes(raw);
  // 漏斗已筛图文：放宽标题分，仍跳过过短/过底栏
  return ns
    .filter((n) => n.text && n.text.length > 8 && n.y1 > 380 && n.y1 < 2100 && n.w > 250 && n.h < 400)
    .map((n) => ({ ...n, ...scoreXjLiveTitle(n.text) }))
    .filter((n) => n.score >= 2 || /live|实况|新疆|动图/i.test(n.text))
    .sort((a, b) => b.score - a.score || a.y1 - b.y1);
}

/** 漏斗 → 内容形式图文 → 空白关面板（禁止顶部图文 tab） */
async function applyTuwenFilter() {
  tap(FUNNEL.x, FUNNEL.y);
  await sleep(2000);
  tap(TUWEN.x, TUWEN.y);
  await sleep(1200);
  tap(DISMISS.x, DISMISS.y);
  await sleep(2000);
  console.log(`FILTER_TUWEN funnel=${FUNNEL.x},${FUNNEL.y} tuwen=${TUWEN.x},${TUWEN.y} dismiss=${DISMISS.x},${DISMISS.y}`);
}

async function goSearch() {
  shNode(["ops/launch-app.mjs", "--alias", alias, "--package", PKG, "--force-stop"], 60000);
  await sleep(7000);
  let raw = await dumpXml();
  let ns = raw ? parseNodes(raw) : [];
  const search = ns.filter((n) => (n.desc === "搜索" || n.text === "搜索") && n.y1 < 280 && n.cx > 700).sort((a, b) => b.cx - a.cx)[0];
  tap(search?.cx || 1003, search?.cy || 155);
  await sleep(2000);
  raw = await dumpXml();
  ns = raw ? parseNodes(raw) : [];
  const field = ns.find((n) => /EditText/.test(n.cls) && n.y1 < 400) || { cx: 446, cy: 161 };
  shNode(["ops/input-text.mjs", "--alias", alias, "--text", keyword, "--x", String(field.cx), "--y", String(field.cy), "--clear-first"], 90000);
  await sleep(1000);
  raw = await dumpXml();
  ns = raw ? parseNodes(raw) : [];
  const btn = ns.find((n) => n.text === "搜索" && n.y1 < 250 && n.cx > 800);
  tap(btn?.cx || 959, btn?.cy || 161);
  await sleep(4500);
  // 保持综合，走漏斗图文
  raw = await dumpXml();
  ns = raw ? parseNodes(raw) : [];
  const zonghe = ns.find((n) => n.text === "综合" && n.y1 < 400);
  if (zonghe) {
    tap(zonghe.cx, zonghe.cy);
    await sleep(1200);
  }
  await applyTuwenFilter();
}

function isCommentSheet(ns) {
  return ns.some((n) => /共\s*\d+\s*条评论/.test(n.text || "") || n.text === "分享你此刻的想法");
}
function isPublishChrome(ns) {
  return ns.some((n) => /^(拍摄|相册|所有照片|下一步|发布|去发布)$/.test(n.text || ""));
}
function isWechatFocus(foc) {
  const f = String(foc?.FOCUS || foc?.ACTIVITY || foc?.PACKAGE || "");
  return /tencent\.mm|com\.tencent\.mm/i.test(f);
}

/** 外部分享目标 App（误点分享面板图标后前台会变成这些） */
function isForeignShareAppFocus(foc) {
  const f = String(foc?.FOCUS || foc?.ACTIVITY || foc?.PACKAGE || "");
  return /tencent\.mm|com\.tencent\.mm|sina\.weibo|com\.sina\.weibo|com\.tencent\.mobileqq|com\.tencent\.tim|com\.qzone|com\.ss\.android\.article|xhs\.note|com\.xingin\.xhs|com\.eg\.android\.Alipay|com\.taobao/i.test(
    f,
  );
}

/**
 * MIUI「启动应用 / 抖音想要打开 微博|微信…」授权浮层。
 * 常盖在 FlowPage 上；dump 可能没有节点，但 focus/dumpsys 可见 securitycenter/wakepath。
 * 只点「拒绝」，永不点「始终允许」。
 */
function isAppLaunchGate(foc, ns) {
  const f = String(foc?.FOCUS || foc?.ACTIVITY || foc?.PACKAGE || foc?.raw || "");
  if (/securitycenter|wakepath|ConfirmStart|AppPermissions|permissioncontroller|PackageInstaller/i.test(f)) {
    return true;
  }
  if (
    Array.isArray(ns) &&
    ns.some((n) => /想要打开|启动应用|始终允许|仅在使用中允许/.test(`${n.text || ""}${n.desc || ""}`))
  ) {
    return true;
  }
  return false;
}

function focusLooksLikeGateFromShell() {
  // dumpsys 兜底：overlay 时 ops/focus 有时仍报抖音
  const out = xwShell("dumpsys window | grep -E mCurrentFocus|mFocusedApp");
  if (/securitycenter|wakepath|ConfirmStart|permissioncontroller/i.test(out)) return true;
  if (/想要打开|启动应用/.test(out)) return true;
  if (/sina\.weibo|tencent\.mm|mobileqq/i.test(out) && !/ugc\.aweme/i.test(out)) return true;
  return false;
}

async function dismissAppLaunchGate(reason) {
  console.log(`DISMISS_APP_GATE reason=${reason}`);
  log({ op: "dismiss_app_gate", reason });
  for (let round = 0; round < 3; round++) {
    const foc = focusNow();
    let raw = await dumpXml();
    let ns = raw ? parseNodes(raw) : [];
    const gate = isAppLaunchGate(foc, ns) || focusLooksLikeGateFromShell();
    if (!gate && !ns.some((n) => n.text === "拒绝" || n.text === "始终允许")) {
      // 已不在闸门
      if (!isForeignShareAppFocus(foc)) return "clear";
    }
    // 只点「拒绝」——精确文案；禁止点「始终允许」
    const deny =
      ns.find((n) => n.text === "拒绝" || n.text === "取消" || n.text === "不允许") ||
      ns.find((n) => /拒绝|取消|不允许/.test(`${n.text}${n.desc}`) && !/始终|仅在/.test(`${n.text}${n.desc}`));
    if (deny) {
      console.log(`APP_GATE_DENY tap ${deny.cx},${deny.cy} text=${deny.text || deny.desc}`);
      tap(deny.cx, deny.cy);
      await sleep(900);
      continue;
    }
    // dump 无节点：MIUI 对话框双按钮常见布局（1080 宽）左=拒绝
    for (const [x, y] of [
      [300, 1580],
      [300, 1650],
      [300, 1720],
      [270, 1550],
    ]) {
      console.log(`APP_GATE_DENY fixed ${x},${y}`);
      tap(x, y);
      await sleep(700);
      const foc2 = focusNow();
      if (!isAppLaunchGate(foc2, parseNodes(await dumpXml()) || []) && !focusLooksLikeGateFromShell()) break;
    }
    // 仍在外 App / 闸门 → back
    back();
    await sleep(700);
  }
  if (isForeignShareAppFocus(focusNow()) || isAppLaunchGate(focusNow(), null) || focusLooksLikeGateFromShell()) {
    shNode(["ops/launch-app.mjs", "--alias", alias, "--package", PKG], 60000);
    await sleep(3500);
    return "relaunched";
  }
  return "dismissed";
}

/** 只认 dump 里明确的「分享链接/复制链接」文案；禁止固定坐标（易点到微信/微博）。 */
function pickShareLinkBtn(ns) {
  const hits = ns.filter((n) => {
    const label = `${n.text || ""}${n.desc || ""}`;
    // 只要纯「分享链接/复制链接」；排除「分享至群」「分享到微博」等
    const exact =
      n.text === "分享链接" ||
      n.text === "复制链接" ||
      n.text === "复制链接到剪贴板" ||
      n.desc === "分享链接" ||
      n.desc === "复制链接";
    if (!exact) return false;
    if (/微信|朋友圈|QQ|微博|企业微信|支付宝|小红书|私信|推荐|至群|热门|日常/i.test(label) && n.text !== "分享链接") {
      return false;
    }
    // 文案节点太宽多半点到整行图标槽，拒绝
    if (n.w > 220) return false;
    // 面板底栏：分享链接通常在右下
    if (n.cy < 1800) return false;
    return true;
  });
  if (!hits.length) return null;
  // 偏好最右下（链接图标槽）
  hits.sort((a, b) => b.cx - a.cx || b.y1 - a.y1);
  const hit = hits[0];
  // 点文案中心偏上一点，避免贴底误触手势条；x 夹在节点内不要出界
  const cx = Math.min(hit.x2 - 8, Math.max(hit.x1 + 8, hit.cx));
  const cy = Math.min(hit.y2 - 4, Math.max(hit.y1 + 4, hit.cy - 2));
  return { ...hit, cx, cy };
}

function pickShareBtn(ns, foc) {
  const focus = String(foc?.FOCUS || foc?.ACTIVITY || "");
  // 优先文案「分享」，避免瞎点；严禁外部分享入口文案
  const labeled = ns.find(
    (n) =>
      (n.text === "分享" || (/^分享\d|分享.*按钮/.test(n.desc || "") && /按钮/.test(n.desc || ""))) &&
      n.cx > 880 &&
      n.cy >= 1600 &&
      n.cy < 2300 &&
      !/微信|朋友圈|微博|QQ|私信/i.test(`${n.text}${n.desc}`),
  );
  if (labeled) return labeled;
  // 图文 FlowPage：实测底栏右下分享（打开面板用；点「分享链接」仍必须靠文案）
  // 注意：面板打开后同坐标会落在「分享链接」槽，勿在面板已开时当「打开分享」重试死坐标
  if (/FlowPage|photos\.detail/i.test(focus)) {
    return { cx: 1004, cy: 2261, desc: "flow-bottom-share-fixed" };
  }
  const collect = ns.find((n) => (n.text === "收藏" || /收藏/.test(n.desc)) && n.cx > 900 && n.cy > 1500);
  if (collect) return { cx: collect.cx, cy: Math.min(collect.cy + 186, 2050), desc: "derived-below-collect" };
  return { cx: 993, cy: 2012, desc: "detail-rail-share-fixed" };
}

async function escapeWechat(reason) {
  return escapeForeignApp(reason);
}

async function escapeForeignApp(reason) {
  console.log(`ESCAPE_FOREIGN_APP reason=${reason}`);
  // 先挡 MIUI 启动确认（微博/微信都会先出这个）
  await dismissAppLaunchGate(`before_escape:${reason}`);
  for (let i = 0; i < 4; i++) {
    const foc = focusNow();
    if (!isWechatFocus(foc) && !isForeignShareAppFocus(foc) && !isAppLaunchGate(foc, null)) break;
    back();
    await sleep(700);
  }
  // 仍在外 App 则拉回抖音（不重搜；调用方决定是否 skip）
  if (isWechatFocus(focusNow()) || isForeignShareAppFocus(focusNow())) {
    shNode(["ops/launch-app.mjs", "--alias", alias, "--package", PKG], 60000);
    await sleep(4000);
  }
}

async function harvestShareFromDetail(titleHint) {
  if (isPublishFocus(focusNow())) {
    await escapePublish("enter_detail");
    return { ok: false, reason: "landed_publish" };
  }
  // Do NOT tap the image (hides rail / opens comments). Tap bottom-right 分享 only.
  await sleep(1500);
  const foc = focusNow();
  let raw = await dumpXml();
  let ns = raw ? parseNodes(raw) : [];
  if (isCommentSheet(ns)) {
    back();
    await sleep(900);
    raw = await dumpXml();
    ns = raw ? parseNodes(raw) : [];
  }
  if (isPublishFocus(foc) || ns.some((n) => /^(拍摄|相册|所有照片|下一步)$/.test(n.text || ""))) {
    await escapePublish("enter_detail_chrome");
    return { ok: false, reason: "landed_publish" };
  }

  const author = ns.find((n) => /^@/.test(n.text))?.text || "";
  const badge = ns.find((n) => n.text === "动图" || n.text === "实况")?.text || "";
  const caption =
    ns.find((n) => n.text && n.text.length > 12 && /live|新疆/i.test(n.text))?.text || titleHint || "";

  // 残留分享面板 / 外发条时：若已有「分享链接」直接点，否则先关再开（避免 fixed 1004,2261 落在外 App 槽）
  let alreadyLink = pickShareLinkBtn(ns);
  if (!alreadyLink && (isShareChrome(ns) || externalShareAppNodes(ns).length)) {
    await dismissShareChrome("before_open_share");
    raw = await dumpXml();
    ns = raw ? parseNodes(raw) : [];
    alreadyLink = pickShareLinkBtn(ns);
  }
  if (!alreadyLink) {
    const share = pickShareBtn(ns, foc);
    console.log(`SHARE_TAP=${share.cx},${share.cy} via=${share.desc || share.text || "分享"} (open panel only)`);
    tap(share.cx, share.cy);
    await sleep(2200);
  } else {
    console.log("SHARE_PANEL already open with 分享链接 — skip open tap");
  }
  // 误点微博/微信图标 → MIUI「想要打开 xxx」或直接进外 App
  if (isAppLaunchGate(focusNow(), parseNodes(await dumpXml()) || []) || focusLooksLikeGateFromShell()) {
    await dismissAppLaunchGate("after_share_icon");
    return { ok: false, reason: "share_opened_app_gate", author, badge, caption };
  }
  if (isWechatFocus(focusNow()) || isForeignShareAppFocus(focusNow())) {
    await escapeForeignApp("after_share_icon");
    return { ok: false, reason: "share_opened_foreign_app", author, badge, caption };
  }
  if (isPublishFocus(focusNow())) {
    await escapePublish("after_share_tap");
    return { ok: false, reason: "share_opened_publish", author, badge, caption };
  }
  let hit = null;
  // 面板轮询上限 3（旧 5 轮 × 慢 dump = 静默数分钟）
  for (let s = 0; s < 3; s++) {
    console.log(`SHARE_PANEL_POLL try=${s + 1}/3`);
    raw = await dumpXml();
    if (!raw) {
      console.log("SHARE_PANEL_POLL dump_miss");
      continue;
    }
    ns = parseNodes(raw);
    if (isAppLaunchGate(focusNow(), ns) || focusLooksLikeGateFromShell()) {
      await dismissAppLaunchGate("share_panel_loop");
      return { ok: false, reason: "share_opened_app_gate", author, badge, caption };
    }
    if (isWechatFocus(focusNow()) || isForeignShareAppFocus(focusNow())) {
      await escapeForeignApp("share_panel_loop");
      return { ok: false, reason: "share_opened_foreign_app", author, badge, caption };
    }
    if (ns.some((n) => /^(拍摄|相册|所有照片|下一步)$/.test(n.text || ""))) {
      await escapePublish("share_panel_became_publish");
      return { ok: false, reason: "share_opened_publish", author, badge, caption };
    }
    // 面板上若出现「微博/微信」图标节点，只记录，绝不点
    if (ns.some((n) => /^(微博|微信|朋友圈|QQ)$/.test(n.text || n.desc || ""))) {
      console.log("SHARE_PANEL has external app icons — only tap labeled 分享链接");
    }
    if (isCommentSheet(ns)) {
      back();
      await sleep(800);
      const share2 = pickShareBtn(parseNodes(await dumpXml()) || [], focusNow());
      tap(share2.cx, share2.cy);
      await sleep(1500);
      continue;
    }
    hit = pickShareLinkBtn(ns);
    if (hit) {
      console.log(`SHARE_LINK_HIT text=${hit.text || hit.desc} ${hit.cx},${hit.cy} bounds=[${hit.x1},${hit.y1}][${hit.x2},${hit.y2}]`);
      break;
    }
    // 只重开一次面板
    if (s === 1) {
      console.log("SHARE_PANEL_RETRY open share icon again (no fixed link slot)");
      const share2 = pickShareBtn(ns, focusNow());
      tap(share2.cx, share2.cy);
      await sleep(1800);
    }
  }
  if (!hit) {
    console.log("SHARE_LINK_MISS — no labeled 分享链接/复制链接 (refuse fixed coords / WeChat|Weibo risk)");
    back();
    await sleep(600);
    return { ok: false, reason: "no_share_link_btn", author, badge, caption };
  }
  tap(hit.cx, hit.cy);
  await sleep(1500);
  if (isAppLaunchGate(focusNow(), parseNodes(await dumpXml()) || []) || focusLooksLikeGateFromShell()) {
    await dismissAppLaunchGate("after_share_link_tap");
    return { ok: false, reason: "share_opened_app_gate", author, badge, caption };
  }
  if (isWechatFocus(focusNow()) || isForeignShareAppFocus(focusNow())) {
    await escapeForeignApp("after_share_link_tap");
    return { ok: false, reason: "share_opened_foreign_app", author, badge, caption };
  }
  // 等「链接已复制」确认（01 上 toast 常有，但 dumpsys clipboard 仍空）
  let toastCopied = false;
  for (let i = 0; i < 4; i++) {
    raw = await dumpXml();
    ns = raw ? parseNodes(raw) : [];
    if (ns.some((n) => /链接已复制|复制成功/.test(n.text || ""))) {
      toastCopied = true;
      break;
    }
    await sleep(500);
  }
  console.log(`TOAST_COPIED=${toastCopied}`);

  let url = readClipboardUrl();
  let gotVia = url ? "clipboard" : null;
  if (!url) {
    raw = await dumpXml();
    ns = raw ? parseNodes(raw) : [];
    let clip = "";
    for (const n of ns) if (/v\.douyin\.com|复制打开抖音|链接已复制/.test(n.text || "")) clip += " " + n.text;
    const urls = extractDouyinShareUrls(clip);
    if (urls.length) {
      url = urls[urls.length - 1];
      gotVia = "toast_text";
      console.log(`TOAST_URL=${url}`);
    }
  }

  // 复制成功后外发条（微信/朋友圈/微博）会浮在 y≈2125；paste 前必须先关，否则右轨盲点开微博
  if (toastCopied || !url) {
    await dismissShareChrome("after_copy_before_read");
  }

  // 剪贴板空 → 仍在详情页时用评论框 PASTE（绝不碰结果页搜索框）
  if (!url) {
    url = await pasteDetailCommentReadUrl();
    if (url) gotVia = "paste_detail";
  }

  // 再退回图文结果队列
  for (let i = 0; i < 5; i++) {
    if (isWechatFocus(focusNow())) {
      await escapeWechat("return_to_list");
    }
    raw = await dumpXml();
    ns = raw ? parseNodes(raw) : [];
    if (
      (ns.some((n) => n.text === "综合" || n.text === "视频") || isSearchResultFocus(focusNow())) &&
      ns.some((n) => n.text && n.text.length > 8 && n.y1 > 380)
    ) {
      break;
    }
    back();
    await sleep(700);
  }

  if (!url) {
    return {
      ok: false,
      reason: toastCopied ? "paste_detail_miss_after_toast" : "clipboard_and_paste_miss",
      author,
      badge,
      caption: caption.slice(0, 200),
      title: titleHint,
      toastCopied,
    };
  }
  console.log(`URL_VIA=${gotVia} ${url}`);
  return {
    ok: true,
    url,
    author,
    badge,
    caption: caption.slice(0, 200),
    title: titleHint,
    toastCopied,
    via: gotVia,
  };
}

function normKw(s) {
  return String(s || "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

/** 顶栏搜索框是否仍是当前关键词（允许抖音截断/少空格） */
function boxMatchesKeyword(box) {
  const b = normKw(box);
  const k = normKw(keyword);
  if (!b || !k) return false;
  if (/v\.douyin\.com|复制打开抖音/i.test(box)) return false;
  return b.includes(k) || k.includes(b) || (b.length >= 4 && k.includes(b));
}

/**
 * 是否还在「当前关键词」的搜索结果队列。
 *
 * - dump 缺 tab 可以；但必须仍在 SearchResult / 有顶栏框，且框文案匹配 keyword。
 * - 禁止：任意列表卡片就当还在队列（会滚进推荐流，看起来像没搜词）。
 * - 关键词漂移 / 无搜索框 → false，由主循环 goSearch 同词重搜（不是假重搜同框）。
 */
async function stillOnTuwenResultList() {
  const foc = focusNow();
  const focus = String(foc?.FOCUS || foc?.ACTIVITY || "");
  const onSearchResult = /SearchResult|search\.activity/i.test(focus);
  const raw = await dumpXml();
  const ns = raw ? parseNodes(raw) : [];
  const hasTabs = ns.some((n) => n.text === "综合" || n.text === "视频" || n.text === "用户" || n.text === "图文");
  const hasList = ns.some((n) => n.text && n.text.length > 8 && n.y1 > 380 && n.y1 < 2100 && n.w > 200);
  const hasBox = ns.some((n) => /EditText/.test(n.cls) && n.y1 < 400);
  const box = (ns.find((n) => /EditText/.test(n.cls) && n.y1 < 400)?.text || "").trim();
  const dirty = /v\.douyin\.com|复制打开抖音/i.test(box);

  if (dirty) {
    console.log(`BOX_DIRTY → restore keyword text, no re-search`);
    await restoreKeywordTextNoSearch();
    return stillOnTuwenResultListQuick();
  }

  if (hasBox && !boxMatchesKeyword(box)) {
    console.log(`KW_MISMATCH box="${box.slice(0, 40)}" want="${keyword}"`);
    return false;
  }

  // 仍在搜索结果：有框且词对，或 SearchResult/tab + 列表
  if (hasList && hasBox && boxMatchesKeyword(box)) return true;
  if (hasList && onSearchResult && (hasTabs || hasBox)) return true;
  if (hasList && hasTabs && onSearchResult) return true;

  console.log(
    `LIST_CHECK tabs=${hasTabs} list=${hasList} box="${box.slice(0, 30)}" kwOk=${boxMatchesKeyword(box)} focus=${focus.slice(0, 60)}`,
  );
  return false;
}

/** 定时核验：不在当前词结果页就同词重搜 */
async function ensureOnKeywordQueue(reason) {
  const foc = focusNow();
  const focus = String(foc?.FOCUS || foc?.ACTIVITY || "");
  const onSearch = /SearchResult|search\.activity/i.test(focus);
  const raw = await dumpXml();
  const ns = raw ? parseNodes(raw) : [];
  const box = (ns.find((n) => /EditText/.test(n.cls) && n.y1 < 400)?.text || "").trim();
  if (box && boxMatchesKeyword(box) && onSearch) {
    console.log(`KW_OK reason=${reason} box="${box.slice(0, 40)}"`);
    return "ok";
  }
  if (box && boxMatchesKeyword(box) && !onSearch) {
    // 框对但 activity 飘了：先 soft back
    console.log(`KW_BOX_OK_FOCUS_OFF reason=${reason} focus=${focus.slice(0, 50)}`);
    const soft = await softReturnToResultList();
    if (soft) return "soft";
  }
  console.log(`KW_RESEARCH reason=${reason} box="${box.slice(0, 40)}" focus=${focus.slice(0, 50)}`);
  await goSearch();
  return "researched";
}

async function stillOnTuwenResultListQuick() {
  const foc = focusNow();
  const focus = String(foc?.FOCUS || foc?.ACTIVITY || "");
  if (/SearchResult|search\.activity/i.test(focus)) {
    const raw = await dumpXml();
    const ns = raw ? parseNodes(raw) : [];
    if (ns.some((n) => n.text && n.text.length > 8 && n.y1 > 380 && n.y1 < 2100)) return true;
  }
  const raw = await dumpXml();
  const ns = raw ? parseNodes(raw) : [];
  return ns.some((n) => n.text && n.text.length > 8 && n.y1 > 380 && n.y1 < 2100 && n.w > 200);
}

async function softReturnToResultList() {
  console.log("LIST_SOFT_RECOVER (back only, no re-search)");
  for (let i = 0; i < 4; i++) {
    if (await stillOnTuwenResultListQuick()) return true;
    back();
    await sleep(700);
  }
  return stillOnTuwenResultListQuick();
}

/** @deprecated kept name shim — 旧逻辑用搜索框==关键词判断，会误触发重搜 */
async function searchStillOnKeyword() {
  return stillOnTuwenResultList();
}

async function restoreKeywordViaClearX() {
  // 仅 escapePublish / 真崩坏兜底；正常采集一关键词只搜一次
  let raw = await dumpXml();
  let ns = raw ? parseNodes(raw) : [];
  const field = ns.find((n) => /EditText/.test(n.cls) && n.y1 < 400) || { cx: 521, cy: 144 };
  let clearBtn =
    ns.find((n) => n.desc === "清空" && n.y1 < 280) ||
    ns.find((n) => /清空|清除/.test(`${n.text}${n.desc}`) && n.y1 < 280 && n.cx > 780 && n.cx < 950);
  if (clearBtn) {
    tap(clearBtn.cx, clearBtn.cy);
    await sleep(500);
  } else {
    tap(855, 144);
    await sleep(500);
  }
  raw = await dumpXml();
  ns = raw ? parseNodes(raw) : [];
  const field2 = ns.find((n) => /EditText/.test(n.cls) && n.y1 < 400) || field;
  shNode([
    "ops/input-text.mjs",
    "--alias",
    alias,
    "--text",
    keyword,
    "--x",
    String(field2.cx),
    "--y",
    String(field2.cy),
    "--clear-first",
  ]);
  await sleep(700);
  raw = await dumpXml();
  ns = raw ? parseNodes(raw) : [];
  const sbtn = ns.find((n) => (n.text === "搜索" || n.desc === "搜索") && n.cx > 880 && n.y1 < 250);
  tap(sbtn?.cx || 995, sbtn?.cy || 144);
  await sleep(3500);
  raw = await dumpXml();
  ns = raw ? parseNodes(raw) : [];
  const zonghe = ns.find((n) => n.text === "综合" && n.y1 < 400);
  if (zonghe) {
    tap(zonghe.cx, zonghe.cy);
    await sleep(1000);
  }
  await applyTuwenFilter();
  return true;
}

function feishuUpsert(row) {
  const payload = {
    fields: ["分享链接", "标题", "作者", "Live角标", "关键词", "文本", "采集状态"],
    rows: [[row.url, (row.title || "").slice(0, 120), row.author || "", row.badge || "", keyword, (row.caption || "").slice(0, 500), "ok"]],
  };
  const name = `feishu-${Date.now()}.json`;
  const p = join(outDir, name);
  // lark-cli requires @relative path under cwd
  const rel = `runtime/xj-live-pipeline/harvest-links/${name}`.replace(/\\/g, "/");
  writeFileSync(p, JSON.stringify(payload));
  const out = spawnSync(
    "lark-cli",
    ["base", "+record-batch-create", "--base-token", BASE, "--table-id", TABLE, "--as", "user", "--json", `@${rel}`],
    { encoding: "utf8", cwd: ROOT, timeout: 90000 },
  );
  const text = ((out.stdout || "") + (out.stderr || "")).trim();
  writeFileSync(p.replace(/\.json$/, ".out.json"), text);
  return text.includes('"ok": true') || text.includes('"ok":true');
}

async function main() {
  console.log(`START alias=${alias} keyword=${keyword} need=${need} mode=search-then-scroll+kw-guard`);
  console.log(`SESSION=${sessionFile}`);
  console.log(`LOG=${logPath}`);
  console.log(`ETA_HINT_MIN=${Math.round((need * 25) / 60)}-${Math.round((need * 50) / 60)} (re-search if kw drift)`);

  const harvested = [];
  const seenTitles = new Set();
  const seenUrls = new Set();
  // 续跑：已写入飞书的 URL 去重
  try {
    const prev = JSON.parse(readFileSync(join(outDir, "harvested.json"), "utf8"));
    if (prev?.keyword === keyword && Array.isArray(prev.harvested)) {
      for (const h of prev.harvested) {
        if (h?.url) {
          seenUrls.add(h.url);
          harvested.push(h);
          if (h.title) seenTitles.add(String(h.title).slice(0, 28));
        }
      }
      console.log(`RESUME have=${harvested.length} from harvested.json`);
    }
  } catch {}

  if (harvested.length >= need) {
    console.log(`ALREADY_DONE ${harvested.length}/${need}`);
    process.exit(0);
  }

  await goSearch(); // 开局搜当前词；中途仅在 KW 漂移/丢队列时同词重搜

  let attempts = 0;
  let pages = 0;
  let idlePages = 0;
  let failStreak = 0;
  const failStop = Math.max(1, Number(opt("--fail-stop", "3")) || 3);
  let stopReason = null;

  while (harvested.length < need && pages < 80) {
    if (isWechatFocus(focusNow())) {
      await escapeWechat("main_loop");
      await ensureOnKeywordQueue("after_wechat");
      pages += 1;
      continue;
    }
    // 每 3 页强制核验顶栏关键词，防止滚进推荐流还当在搜
    if (pages > 0 && pages % 3 === 0) {
      await ensureOnKeywordQueue(`page_${pages}`);
    }
    const raw = await dumpXml();
    if (!raw) {
      log({ op: "dump_fail", page: pages });
      break;
    }
    if (!(await stillOnTuwenResultList())) {
      const focLost = focusNow();
      const focusLost = String(focLost?.FOCUS || focLost?.ACTIVITY || "");
      // 轻恢复：Splash/桌面 → launch 抖音（不 force-stop）+ soft back；仍丢才 goSearch
      if (/Splash|launcher|miui\.home/i.test(focusLost)) {
        console.log(`QUEUE_LIGHT_RECOVER splash→launch focus=${focusLost.slice(0, 60)}`);
        shNode(["ops/launch-app.mjs", "--alias", alias, "--package", PKG], 60000);
        await sleep(4000);
        await softReturnToResultList();
      } else {
        await softReturnToResultList();
      }
      if (!(await stillOnTuwenResultList())) {
        console.log(`QUEUE_LOST focus=${focusLost.slice(0, 80)} → goSearch same keyword`);
        await goSearch();
      }
      pages += 1;
      continue;
    }
    const cards = listCards(raw);
    console.log(`PAGE=${pages} candidates=${cards.length} have=${harvested.length}/${need} elapsedMin=${((Date.now() - t0) / 60000).toFixed(1)}`);

    let openedThisPage = 0;
    for (const c of cards) {
      if (harvested.length >= need) break;
      const tkey = c.text.slice(0, 28);
      if (seenTitles.has(tkey)) continue;
      if (/那拉提/.test(c.text)) {
        seenTitles.add(tkey);
        console.log(`SKIP_KNOWN_BAD ${c.text.slice(0, 36)}`);
        continue;
      }
      // 先不算进 seen：open 失败可同页再试别卡；成功或明确 skip 后再 add
      attempts += 1;
      openedThisPage += 1;

      const rawNow = await dumpXml();
      const nsNow = rawNow ? parseNodes(rawNow) : [];
      if (c.y1 > 1750) {
        attempts -= 1;
        openedThisPage -= 1;
        continue;
      }
      // 封面：优先标题正上方大图；失败回退「标题上方 180px」
      let tapX = c.cx;
      let tapY = Math.max(480, Math.min(c.y1 - 200, 1500));
      const covers = nsNow
        .filter(
          (n) =>
            n.w > 260 &&
            n.h > 200 &&
            n.h < 1000 &&
            n.y1 > 360 &&
            n.y2 < 1950 &&
            n.y2 <= c.y1 + 60 &&
            n.y1 > c.y1 - 1000 &&
            Math.abs(n.cx - c.cx) < 380 &&
            // 排除底栏/按钮扁条
            n.h > 180,
        )
        .sort((a, b) => b.h * b.w - a.h * a.w);
      if (covers[0]) {
        tapX = covers[0].cx;
        // 点封面中上部，减少点到标题/作者区
        tapY = Math.min(Math.max(covers[0].y1 + Math.floor(covers[0].h * 0.35), 480), 1550);
      }
      ({ x: tapX, y: tapY } = avoidPublishZone(tapX, tapY));
      console.log(`OPEN #${attempts} score=${c.score} xy=${tapX},${tapY} ${c.text.slice(0, 36)}`);
      tap(tapX, tapY);
      await sleep(2800);
      let foc = focusNow();
      // 仍在结果页：再点一次封面中心（常见第一次点到文字无跳转）
      if (!isDetailFocus(foc) && isSearchResultFocus(foc)) {
        const retryY = Math.max(500, tapY - 80);
        console.log(`OPEN_RETRY still_list xy=${tapX},${retryY}`);
        tap(tapX, retryY);
        await sleep(2800);
        foc = focusNow();
      }
      if (isPublishFocus(foc)) {
        log({ op: "open_fail", title: c.text.slice(0, 60), focus: foc.FOCUS || "", reason: "publish" });
        failStreak += 1;
        await escapePublish("open_card");
        if (failStreak >= failStop) {
          console.log(`FAIL_STOP after ${failStreak} consecutive misses`);
          break;
        }
        break;
      }
      if (isWrongFocus(foc)) {
        log({ op: "open_fail", title: c.text.slice(0, 60), focus: foc.FOCUS || "", reason: "wrong_page" });
        failStreak += 1;
        for (let b = 0; b < 3; b++) {
          back();
          await sleep(500);
          if (!isWrongFocus(focusNow())) break;
        }
        if (isWrongFocus(focusNow()) || isPublishFocus(focusNow())) await escapePublish("wrong_page");
        if (failStreak >= failStop) {
          console.log(`FAIL_STOP after ${failStreak} consecutive misses`);
          break;
        }
        continue;
      }
      // 掉到 Splash：轻 launch，不立刻算整页废
      if (/Splash|launcher|miui\.home/i.test(String(foc?.FOCUS || foc?.ACTIVITY || ""))) {
        log({ op: "open_fail", title: c.text.slice(0, 60), focus: foc.FOCUS || "", reason: "splash" });
        failStreak += 0.5;
        console.log("OPEN_SPLASH → launch douyin light");
        shNode(["ops/launch-app.mjs", "--alias", alias, "--package", PKG], 60000);
        await sleep(4000);
        await ensureOnKeywordQueue("after_open_splash");
        if (failStreak >= failStop) {
          stopReason = `fail_stop_${failStreak}`;
          break;
        }
        break; // 重新 list
      }
      if (!isDetailFocus(foc)) {
        // open_fail 半权；不加入 seenTitles，下页可再遇
        log({
          op: "open_fail",
          title: c.text.slice(0, 60),
          focus: foc.FOCUS || "",
          reason: "still_list",
          xy: `${tapX},${tapY}`,
        });
        failStreak += 0.5;
        // 仍在列表则不必 back
        if (!isSearchResultFocus(foc)) {
          back();
          await sleep(700);
        }
        if (failStreak >= failStop) {
          stopReason = `fail_stop_${failStreak}`;
          console.log(`FAIL_STOP after ${failStreak} consecutive misses (open_fail half-weight)`);
          break;
        }
        continue;
      }
      seenTitles.add(tkey);
      const r = await harvestShareFromDetail(c.text);
      log({
        op: "harvest",
        ok: r.ok,
        url: r.url || null,
        reason: r.reason || null,
        via: r.via || null,
        toastCopied: r.toastCopied ?? null,
        badge: r.badge,
        title: c.text.slice(0, 60),
      });
      if (r.reason === "landed_publish" || r.reason === "share_opened_publish") {
        await escapePublish("publish_after_share");
        break;
      }
      if (
        r.reason === "share_opened_wechat" ||
        r.reason === "share_opened_foreign_app" ||
        r.reason === "share_opened_app_gate"
      ) {
        // 已 dismiss/escape；跳过本帖，别整页停
        failStreak += 1;
        console.log(`SKIP_POST reason=${r.reason} have=${harvested.length}/${need} failStreak=${failStreak}/${failStop}`);
        if (failStreak >= failStop) {
          stopReason = `fail_stop_${failStreak}`;
          console.log(`FAIL_STOP after ${failStreak} consecutive misses`);
          break;
        }
        continue;
      }
      if (!r.ok || !r.url || seenUrls.has(r.url)) {
        // 已在列表；跳过下一条，不重搜
        failStreak += 1;
        const skipReason = !r.ok ? r.reason || "no_url" : seenUrls.has(r.url) ? "dup_url" : "no_url";
        console.log(`SKIP_POST reason=${skipReason} have=${harvested.length}/${need} failStreak=${failStreak}/${failStop}`);
        if (failStreak >= failStop) {
          stopReason = `fail_stop_${failStreak}`;
          console.log(`FAIL_STOP after ${failStreak} consecutive misses`);
          break;
        }
        continue;
      }
      failStreak = 0;
      seenUrls.add(r.url);
      const row = { url: r.url, title: c.text, author: r.author, badge: r.badge, caption: r.caption };
      const okFs = feishuUpsert(row);
      harvested.push({ ...row, feishu: okFs });
      writeFileSync(join(outDir, "harvested.json"), JSON.stringify({ keyword, need, harvested, at: new Date().toISOString() }, null, 2));
      console.log(`SAVED ${harvested.length}/${need} feishu=${okFs} ${r.url}`);
      if (!okFs) {
        console.log("FEISHU_FAIL — stop");
        writeFileSync(join(outDir, "summary.json"), JSON.stringify({ alias, keyword, need, got: harvested.length, feishuFail: true, urls: harvested.map((h) => h.url) }, null, 2));
        process.exit(3);
      }
      // 成功：直接点下一条，不重搜、不 swipe
    }

    if (stopReason || failStreak >= failStop) break;
    if (harvested.length >= need) break;
    if (openedThisPage === 0) idlePages += 1;
    else idlePages = 0;
    if (idlePages >= 6) {
      console.log("IDLE_PAGES — stop (no new titles)");
      break;
    }
    pages += 1;
    console.log(`SCROLL_DOWN page→${pages}`);
    shNode(["ops/swipe.mjs", "--alias", alias, "--x1", "540", "--y1", "1700", "--x2", "540", "--y2", "700", "--ms", "400"]);
    await sleep(1600);
  }

  const summary = {
    alias,
    keyword,
    need,
    got: harvested.length,
    attempts,
    pages,
    failStreak,
    stopReason,
    elapsedSec: Math.round((Date.now() - t0) / 1000),
    urls: harvested.map((h) => h.url),
    logPath,
  };
  writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(`DONE ${JSON.stringify(summary)}`);
  process.exit(harvested.length >= need ? 0 : 2);
}

main().catch((e) => {
  console.log(`FATAL=${e?.message || e}`);
  process.exit(4);
});
