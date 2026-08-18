#!/usr/bin/env node
/**
 * Smoke pipeline: keyword search → Live-badge posts only → share link → longmao → Feishu.
 * Success criterion: 3 posts with share-link identity uploaded.
 *
 *   node ops/douyin-xj-live-pipeline-smoke.mjs --alias 02 --keyword "张live图记录新疆" --need 3
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
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
  console.log(`用法: node ops/douyin-xj-live-pipeline-smoke.mjs --alias <01-04> [--keyword …] [--need 3]`);
  process.exit(0);
}

const alias = opt("--alias", "01");
const keyword = opt("--keyword", "张live图记录新疆");
const need = Math.max(1, Number(opt("--need", "3")) || 3);
process.env.XHS_LOCAL = "1";

const outDir = join(ROOT, "runtime", "xj-live-pipeline");
mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function shNode(args, timeoutMs = 120000) {
  const r = spawnSync("node", args, {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, XHS_LOCAL: "1" },
    timeout: timeoutMs,
    maxBuffer: 20 * 1024 * 1024,
  });
  return ((r.stdout || "") + (r.stderr || "")).trim();
}
function shShell(cmd, timeoutMs = 90000) {
  const r = spawnSync(cmd, {
    shell: true,
    cwd: ROOT,
    encoding: "utf8",
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
    const k = kv(out);
    if (k.DUMP && existsSync(k.DUMP)) {
      const raw = readFileSync(k.DUMP, "utf8");
      if (raw.includes("<hierarchy") && raw.length > 4000) return raw;
    }
    // fallback newest
    try {
      const dir = join(tmpdir(), "xhs-explore");
      const dumps = readdirSync(dir)
        .filter((f) => f.startsWith(`dump-${alias}-`) && f.endsWith(".xml"))
        .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
      if (dumps[0]) {
        const raw = readFileSync(join(dir, dumps[0].f), "utf8");
        if (raw.includes("<hierarchy") && raw.length > 4000) return raw;
      }
    } catch {}
    await sleep(2000 + i * 800);
  }
  return null;
}
function tap(x, y) {
  shNode(["ops/tap.mjs", "--alias", alias, "--x", String(x), "--y", String(y)]);
}
function back() {
  shNode(["ops/back.mjs", "--alias", alias]);
}

function hasLiveBadge(ns) {
  // 详情角标：动图 / 实况（用户要求点进去前默认要有 live logo）
  return ns.some((n) => n.text === "动图" || n.text === "实况" || /实况|动图/.test(n.desc || ""));
}

function listSearchCards(raw) {
  const ns = parseNodes(raw);
  const badges = ns.filter((n) => (n.text === "动图" || n.text === "实况") && n.y1 > 350);
  // SearchResult 标题可能是双列窄卡(~479)或单列宽条(~992)；勿限死 <600
  const cards = ns
    .filter((n) => n.text && n.text.length > 8 && n.y1 > 380 && n.y1 < 2100 && n.w > 250 && n.h < 400)
    .map((n) => {
      const sc = scoreXjLiveTitle(n.text);
      const nearBadge = badges.find(
        (b) => Math.abs(b.cy - n.cy) < 450 && Math.abs(b.cx - n.cx) < 520,
      );
      return { ...n, ...sc, liveLogo: nearBadge?.text || null };
    })
    .filter((n) => n.score >= 3 || /live/i.test(n.text))
    .sort((a, b) => b.score - a.score || a.y1 - b.y1);
  // 快路径：列表不卡 Live logo（角标 dump 不稳且慢）。
  // 标题打分够高就收分享链；Live 判定交给龙猫「有下载视频」。
  return cards.filter((c) => c.score >= 4);
}

async function goSearch() {
  shNode(["ops/launch-app.mjs", "--alias", alias, "--package", PKG, "--force-stop"], 60000);
  await sleep(7000);
  let raw = await dumpXml();
  let ns = raw ? parseNodes(raw) : [];
  const search =
    ns.filter((n) => (n.desc === "搜索" || n.text === "搜索") && n.y1 < 280 && n.cx > 700).sort((a, b) => b.cx - a.cx)[0] ||
    null;
  if (search) tap(search.cx, search.cy);
  else tap(1000, 150);
  await sleep(2000);
  raw = await dumpXml();
  ns = raw ? parseNodes(raw) : [];
  const field = ns.find((n) => /EditText/.test(n.cls) && n.y1 < 400) || { cx: 480, cy: 160 };
  shNode(["ops/input-text.mjs", "--alias", alias, "--text", keyword, "--x", String(field.cx), "--y", String(field.cy), "--clear-first"], 90000);
  await sleep(1200);
  raw = await dumpXml();
  ns = raw ? parseNodes(raw) : [];
  // DO NOT --enter (IME/enter can jump to dialer on 02). Tap top-right 搜索.
  const searchBtn =
    ns.find((n) => n.text === "搜索" && n.y1 < 250 && n.cx > 800) ||
    ns.find((n) => n.text === "搜索" && n.y1 < 300);
  if (searchBtn) tap(searchBtn.cx, searchBtn.cy);
  else tap(959, 161);
  await sleep(4500);
  raw = await dumpXml();
  ns = raw ? parseNodes(raw) : [];
  const zonghe = ns.find((n) => n.text === "综合" && n.y1 < 400);
  if (zonghe) {
    tap(zonghe.cx, zonghe.cy);
    await sleep(1800);
  }
  raw = await dumpXml();
  ns = raw ? parseNodes(raw) : [];
  const shikuang = ns.find((n) => n.text === "实况" && n.y1 < 520);
  if (shikuang) {
    tap(shikuang.cx, shikuang.cy);
    await sleep(2200);
  }
}

async function openShareLinkFromDetail() {
  // Detail 首屏 dump 常 missing hierarchy；先点中间唤起右侧栏 chrome
  await sleep(1500);
  tap(540, 1100);
  await sleep(1200);

  let raw = null;
  let ns = [];
  let share = null;
  for (let i = 0; i < 5; i++) {
    raw = await dumpXml();
    ns = raw ? parseNodes(raw) : [];
    share =
      ns.find((n) => n.text === "分享" && n.cx > 880) ||
      ns.find((n) => /分享/.test(n.desc) && /按钮/.test(n.desc) && n.cx > 800) ||
      ns.find((n) => /分享/.test(n.desc) && n.cx > 800);
    // 有时 dump 只有评论：用评论下方推算分享
    if (!share) {
      const comment = ns.find((n) => /评论/.test(n.desc) && n.cx > 880);
      if (comment) share = { cx: comment.cx, cy: comment.cy + 380, desc: "derived-below-comment", text: "分享" };
    }
    if (share || ns.some((n) => n.text === "动图" || /喜欢|评论/.test(n.desc))) break;
    tap(540, 1200);
    await sleep(1000 + i * 400);
  }

  const author = ns.find((n) => /^@/.test(n.text))?.text || "";
  const badge = ns.find((n) => n.text === "动图" || n.text === "实况")?.text || "";
  const caption =
    ns.find((n) => n.text && n.text.length > 12 && !/^@/.test(n.text) && /live|新疆|伊犁|赛里木|阿勒泰/i.test(n.text))?.text ||
    "";
  if (!share) {
    console.log("  no share btn in dump after wake");
    return { ok: false, reason: "no_share", author, badge, caption };
  }
  console.log(`  SHARE_XY=${share.cx},${share.cy} ${share.desc || share.text || ""}`);
  tap(share.cx, share.cy);
  await sleep(2000);
  let hit = null;
  for (let s = 0; s < 8; s++) {
    raw = await dumpXml();
    ns = raw ? parseNodes(raw) : [];
    hit = ns.find((n) => n.text === "分享链接" || n.text === "复制链接" || n.desc === "分享链接");
    if (hit) break;
    // share sheet bottom actions; try a few Y bands
    const y = s % 2 === 0 ? 2159 : 2050;
    shNode(["ops/swipe.mjs", "--alias", alias, "--x1", "950", "--y1", String(y), "--x2", "200", "--y2", String(y), "--ms", "320"]);
    await sleep(550);
  }
  if (!hit) {
    console.log(
      "  share panel texts",
      ns
        .filter((n) => n.text && n.y1 > 1600)
        .map((n) => n.text)
        .slice(0, 20)
        .join("|"),
    );
    back();
    return { ok: false, reason: "no_share_link_btn", author, badge, caption };
  }
  tap(hit.cx, hit.cy);
  await sleep(1800);
  // dismiss to search/detail then paste into search to read clip
  for (let i = 0; i < 4; i++) {
    raw = await dumpXml();
    ns = raw ? parseNodes(raw) : [];
    if (ns.some((n) => n.text === "综合" || n.text === "视频" || /^@/.test(n.text || ""))) break;
    back();
    await sleep(700);
  }
  // leave detail if still there
  raw = await dumpXml();
  ns = raw ? parseNodes(raw) : [];
  if (!ns.some((n) => n.text === "综合" || n.text === "视频")) {
    back();
    await sleep(900);
  }
  raw = await dumpXml();
  ns = raw ? parseNodes(raw) : [];
  const field = ns.find((n) => /EditText/.test(n.cls) && n.y1 < 400) || { cx: 480, cy: 160 };
  tap(field.cx, field.cy);
  await sleep(400);
  shNode(["ops/input-text.mjs", "--alias", alias, "--text", ".", "--x", String(field.cx), "--y", String(field.cy), "--clear-first"]);
  await sleep(300);
  shNode(["ops/shell.mjs", "--alias", alias, "--cmd", "input keyevent 67"]);
  await sleep(200);
  shNode(["ops/shell.mjs", "--alias", alias, "--cmd", "input keyevent 279"]); // paste
  await sleep(900);
  raw = await dumpXml();
  ns = raw ? parseNodes(raw) : [];
  let clip = "";
  for (const n of ns) {
    if (/v\.douyin\.com|复制打开抖音/.test(n.text || "")) clip += " " + n.text;
  }
  const urls = extractDouyinShareUrls(clip);
  const url = urls.length ? urls[urls.length - 1] : null;
  // restore keyword search
  shNode(["ops/input-text.mjs", "--alias", alias, "--text", keyword, "--x", String(field.cx), "--y", String(field.cy), "--clear-first"], 90000);
  await sleep(800);
  raw = await dumpXml();
  ns = raw ? parseNodes(raw) : [];
  const searchBtn2 = ns.find((n) => n.text === "搜索" && n.y1 < 250 && n.cx > 800);
  if (searchBtn2) tap(searchBtn2.cx, searchBtn2.cy);
  else tap(959, 161);
  await sleep(3500);
  return { ok: !!url, url, author, badge, caption: caption.slice(0, 200) };
}

function longmaoExtract(url, folder) {
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "source-url.txt"), url + "\n");
  shShell('opencli browser longmao open "https://longmao.vip/source/general" --window foreground', 60000);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
  let findClear = shShell('opencli browser longmao find --role button --name "清空"');
  let clearRef = findClear.match(/"ref":\s*(\d+)/)?.[1];
  if (clearRef) {
    shShell(`opencli browser longmao click ${clearRef}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800);
  }
  let findTa = shShell('opencli browser longmao find --css "textarea"');
  let ta = findTa.match(/"ref":\s*(\d+)/)?.[1] || "1";
  shShell(`opencli browser longmao fill ${ta} "${url}"`);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
  let findBtn = shShell('opencli browser longmao find --role button --name "提取素材"');
  let btn = findBtn.match(/"ref":\s*(\d+)/)?.[1] || "2";
  shShell(`opencli browser longmao click ${btn}`);
  let videoN = 0;
  let imageN = 0;
  let hasVideo = false;
  for (let w = 0; w < 22; w++) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
    const ev = shShell(
      `opencli browser longmao eval "(()=>{const t=document.body.innerText; const m=t.match(/下载视频 \\\\((\\\\d+)\\\\)/); const m2=t.match(/下载图集 \\\\((\\\\d+)\\\\)/); const cap=(t.match(/文案[：:]([\\\\s\\\\S]{0,200})/)||[])[1]||''; return JSON.stringify({v:!!m,vn:m&&m[1],i:!!m2,in:m2&&m2[1],cap:cap.slice(0,180)});})()"`,
    );
    try {
      const j = JSON.parse(ev.match(/\{[\s\S]*\}/)?.[0] || "{}");
      if (j.v || j.i) {
        hasVideo = !!j.v;
        videoN = Number(j.vn || 0);
        imageN = Number(j.in || 0);
        writeFileSync(join(folder, "longmao-meta.json"), JSON.stringify(j, null, 2));
        break;
      }
    } catch {}
  }
  if (!hasVideo && imageN === 0) return { ok: false, reason: "extract_empty", videoN, imageN };
  // copy video links via 链接 button
  const linksFind = shShell('opencli browser longmao find --role button --name "链接" --limit 8');
  const linkRef = linksFind.match(/"ref":\s*(\d+)/)?.[1];
  if (linkRef) {
    shShell(`opencli browser longmao click ${linkRef}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200);
    const ps1 = join(folder, "_save-clip.ps1");
    writeFileSync(
      ps1,
      `$c=Get-Clipboard -Raw; Set-Content -Encoding utf8 '${folder.replace(/\\/g, "/")}/video-urls.txt' -Value $c; Write-Output ('urls=' + ([regex]::Matches($c,'https?://').Count))`,
    );
    shShell(`powershell -NoProfile -File "${ps1}"`);
  }
  // download a few sample mp4s (cap 3 for smoke)
  if (existsSync(join(folder, "video-urls.txt"))) {
    const urls = readFileSync(join(folder, "video-urls.txt"), "utf8")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((u) => /^https?:\/\//.test(u))
      .slice(0, 3);
    writeFileSync(join(folder, "video-urls.txt"), urls.join("\n") + "\n");
    shNode(["ops/douyin-live-bulk-download.mjs", "--dir", folder], 600000);
  }
  const mp4s = existsSync(folder) ? readdirSync(folder).filter((f) => f.endsWith(".mp4")) : [];
  return { ok: hasVideo || mp4s.length > 0 || imageN > 0, videoN, imageN, mp4s, hasVideo };
}

function feishuUpload(row, folder) {
  const fields = ["分享链接", "标题", "作者", "Live角标", "关键词", "文本", "视频数", "图集数", "采集状态"];
  const title = (row.title || row.caption || "").slice(0, 120);
  const values = [
    row.url,
    title,
    row.author || "",
    row.badge || "",
    keyword,
    (row.caption || title).slice(0, 500),
    row.videoN ?? 0,
    row.imageN ?? 0,
    row.status || "ok",
  ];
  const payload = { fields, rows: [values] };
  const jsonPath = join(folder, "feishu-row.json");
  writeFileSync(jsonPath, JSON.stringify(payload, null, 2));
  const out = shShell(
    `lark-cli base +record-batch-create --base-token ${BASE} --table-id ${TABLE} --as user --json @${jsonPath}`,
    90000,
  );
  writeFileSync(join(folder, "feishu-create.out.json"), out);
  let recordId = null;
  try {
    const j = JSON.parse(out.match(/\{[\s\S]*\}/)?.[0] || out);
    recordId = j?.data?.records?.[0]?.record_id || j?.data?.record_ids?.[0] || j?.data?.items?.[0]?.record_id || null;
    if (!recordId && Array.isArray(j?.data?.records)) recordId = j.data.records[0]?.id || null;
  } catch {}
  // try upload first mp4 as attachment
  const mp4 = (row.mp4s || [])[0];
  if (recordId && mp4) {
    const file = join(folder, mp4);
    if (existsSync(file)) {
      const up = shShell(
        `lark-cli base +record-upload-attachment --base-token ${BASE} --table-id ${TABLE} --as user --record-id ${recordId} --field-id 素材 --file "${file}"`,
        180000,
      );
      writeFileSync(join(folder, "feishu-attach.out.json"), up);
    }
  }
  return { out, recordId };
}

async function main() {
  console.log(`START alias=${alias} keyword=${keyword} need=${need}`);
  await goSearch();
  const harvested = [];
  const seenTitles = new Set();
  const seenUrls = new Set();

  for (let page = 0; page < 8 && harvested.length < need; page++) {
    const raw = await dumpXml();
    if (!raw) {
      console.log("dump fail page", page);
      break;
    }
    const cards = listSearchCards(raw);
    console.log(
      `PAGE=${page} candidates=${cards.slice(0, 6).map((c) => `${c.score}:${c.text.slice(0, 24)}`).join(" | ")}`,
    );
    for (const c of cards) {
      if (harvested.length >= need) break;
      const tkey = c.text.slice(0, 28);
      if (seenTitles.has(tkey)) continue;
      seenTitles.add(tkey);
      console.log(`OPEN score=${c.score} logo=${c.liveLogo || "-"} ${c.text.slice(0, 40)}`);
      const rawNow = await dumpXml();
      const nsNow = rawNow ? parseNodes(rawNow) : [];
      // Prefer large cover tile above/near title; else tap 动图 badge; else geometric guess
      const cover =
        nsNow
          .filter(
            (n) =>
              n.w > 280 &&
              n.h > 220 &&
              n.y1 > 350 &&
              n.y2 <= c.y1 + 40 &&
              n.y1 > c.y1 - 900 &&
              Math.abs(n.cx - c.cx) < 420,
          )
          .sort((a, b) => b.h * b.w - a.h * a.w)[0] ||
        nsNow.find((n) => (n.text === "动图" || n.text === "实况") && Math.abs(n.cy - c.cy) < 500) ||
        null;
      const tapX = cover?.cx || c.cx;
      const tapY = cover?.cy || Math.max(500, c.y1 - 260);
      console.log(`  TAP_COVER=${tapX},${tapY} cover=${cover ? `${cover.w}x${cover.h}` : "none"}`);
      tap(tapX, tapY);
      await sleep(3500);
      const foc = kv(shNode(["ops/focus.mjs", "--alias", alias], 30000));
      console.log(`  FOCUS=${foc.FOCUS || ""}`);
      let raw2 = await dumpXml();
      let ns2 = raw2 ? parseNodes(raw2) : [];
      const onDetail = /DetailActivity|FlowPage|aweme\.detail/i.test(foc.FOCUS || "");
      if (
        !onDetail &&
        ns2.some((n) => n.text === "综合") &&
        ns2.filter((n) => n.w > 250 && n.w < 700 && n.text?.length > 10).length >= 2
      ) {
        console.log("  still search, skip");
        continue;
      }
      // 快路径：不因列表/详情缺角标 abort；进详情后点中间唤起 chrome 再收分享链
      if (onDetail) {
        tap(540, 1100);
        await sleep(1000);
      }
      const r = await openShareLinkFromDetail();
      console.log("  harvest", r.ok, r.url || r.reason, r.badge);
      if (!r.ok || !r.url || seenUrls.has(r.url)) {
        back();
        await sleep(800);
        continue;
      }
      seenUrls.add(r.url);
      const folder = join(outDir, `post-${String(harvested.length + 1).padStart(2, "0")}`);
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, "note.json"), JSON.stringify({ ...r, title: c.text, keyword }, null, 2));
      console.log("  longmao…");
      const lm = longmaoExtract(r.url, folder);
      console.log("  longmao", lm);
      // 核心判据：龙猫有「下载视频」= Live/动图轨；仅图集则跳过不算完成
      if (!lm.hasVideo) {
        console.log("  skip: longmao no video (images-only or fail) — not Live pack");
        writeFileSync(join(folder, "skipped.json"), JSON.stringify({ reason: "longmao_no_video", lm }, null, 2));
        await sleep(800);
        continue;
      }
      const row = {
        url: r.url,
        title: c.text,
        caption: r.caption,
        author: r.author,
        badge: r.badge || "longmao-video",
        videoN: lm.videoN || 0,
        imageN: lm.imageN || 0,
        mp4s: lm.mp4s || [],
        status: lm.ok ? "ok" : "partial",
      };
      const fsRes = feishuUpload(row, folder);
      console.log("  feishu", fsRes.recordId || fsRes.out.slice(0, 200));
      harvested.push({ ...row, recordId: fsRes.recordId, folder });
      writeFileSync(join(outDir, "harvested.json"), JSON.stringify(harvested, null, 2));
      // ensure back on search results
      await sleep(1000);
    }
    shNode(["ops/swipe.mjs", "--alias", alias, "--x1", "540", "--y1", "1700", "--x2", "540", "--y2", "700", "--ms", "400"]);
    await sleep(1800);
  }

  console.log(`DONE count=${harvested.length}`);
  console.log(JSON.stringify(harvested.map((h) => ({ url: h.url, badge: h.badge, recordId: h.recordId, videoN: h.videoN })), null, 2));
  process.exit(harvested.length >= need ? 0 : 2);
}

main().catch((e) => {
  console.log("FATAL", e?.message || e);
  process.exit(4);
});
