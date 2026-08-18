#!/usr/bin/env node
/**
 * XHS: open one note → scan first 3 comment screens → copy highest-liked → send.
 *
 *   node ops/xhs-comment-copy-top.mjs --alias 01
 *   node ops/xhs-comment-copy-top.mjs --alias 01 --dry-run
 *   node ops/xhs-comment-copy-top.mjs --alias 01 --prefer video
 *
 * Real send requires human authorization (this session: user asked to copy+publish).
 */
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./_explore-lib.mjs";
import { bizRecord } from "./_biz-trace.mjs";
import { spawnSync } from "node:child_process";
import {
  parseFeedCards,
  pickFeedCard,
  parseBottomBar,
  parseComments,
  isSystemCommentChrome,
  findSendBtn,
  findEditText,
  isHomeFocus,
  isDetailFocus,
} from "./_xhs-parse.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PKG = "com.xingin.xhs";
const CPA_SCRIPT = join(
  process.env.USERPROFILE || process.env.HOME || "",
  ".codex",
  "skills",
  "remote-cpa",
  "scripts",
  "cpa_request.py",
);

const { opt, flag } = parseArgs(process.argv.slice(2));
if (flag("--help") || flag("-h")) {
  console.log(`用法: node ops/xhs-comment-copy-top.mjs --alias <01-04> [--prefer note|video|any] [--screens 3] [--dry-run] [--no-llm] [--llm-model <id>] [--no-force-stop]
流程: 扫前N屏 → 启发式过滤系统文案 → LLM 判定真人评论 → dry-run 定位 → 通过才真发
stdout: COMMENT=ok|fail|skip|dry-run COPIED_TEXT=... LLM=pass|reject|error`);
  process.exit(0);
}

const alias = opt("--alias");
const ssh = opt("--ssh", "xhs-windows");
const prefer = opt("--prefer", "any");
const screens = Math.max(1, Math.min(5, Number(opt("--screens", "3")) || 3));
const dryRun = flag("--dry-run");
const forceStop = !flag("--no-force-stop");
const skipLlm = flag("--no-llm");
const llmModel = opt("--llm-model", "gemini-2.5-flash-lite");
if (!alias) {
  console.log("✗ need --alias");
  process.exit(4);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runOps(args, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn("node", args, { cwd: ROOT, env: process.env });
    let out = "";
    const timer = setTimeout(() => {
      try {
        p.kill("SIGKILL");
      } catch {}
      resolve({ code: 124, out, ms: Date.now() - t0 });
    }, timeoutMs);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, out: out.trim(), ms: Date.now() - t0 });
    });
  });
}

function kv(t) {
  const o = {};
  for (const line of String(t || "").split(/\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) o[m[1]] = m[2];
  }
  return o;
}

let t0 = Date.now();

function fail(reason, extra = {}) {
  console.log(`COMMENT=fail`);
  console.log(`REASON=${reason}`);
  for (const [k, v] of Object.entries(extra)) if (v != null && v !== "") console.log(`${k}=${v}`);
  console.log(`ALIAS=${alias}`);
  bizRecord({ op: "comment-copy-top", outcome: "fail", reason, extra, alias, serial: null, startMs: t0 });
  process.exit(2);
}

async function focusNow() {
  const r = await runOps(["ops/focus.mjs", "--alias", alias, "--ssh", ssh], 30000);
  return { ...r, ...kv(r.out) };
}
async function dumpNow() {
  const r = await runOps(["ops/dump-ui.mjs", "--alias", alias, "--ssh", ssh], 50000);
  return { ...r, ...kv(r.out) };
}
async function tapXY(x, y) {
  return runOps(["ops/tap.mjs", "--alias", alias, "--x", String(x), "--y", String(y), "--ssh", ssh], 20000);
}
async function swipeUp() {
  // comment sheet: shorter swipe to keep sheet open
  return runOps(
    ["ops/swipe.mjs", "--alias", alias, "--x1", "540", "--y1", "1700", "--x2", "540", "--y2", "900", "--ms", "320", "--ssh", ssh],
    20000,
  );
}
async function backHome() {
  for (let i = 0; i < 4; i++) {
    await runOps(["ops/back.mjs", "--alias", alias, "--ssh", ssh], 15000);
    await sleep(1000);
    const f = await focusNow();
    if (isHomeFocus(f.FOCUS)) return true;
  }
  return false;
}

function pickCard(cards) {
  if (prefer === "video") {
    const v = cards.find((c) => c.kind === "video" && c.cy >= 400 && c.cy <= 1600);
    if (v) return v;
  }
  if (prefer === "note") return pickFeedCard(cards, { prefer: "note", avoidWan: true });
  // any: alternate preference by wall clock second
  const wantVideo = Math.floor(Date.now() / 1000) % 2 === 0;
  if (wantVideo) {
    const v = cards.find((c) => c.kind === "video" && c.cy >= 400 && c.cy <= 1600);
    if (v) return v;
  }
  return pickFeedCard(cards, { prefer: "note", avoidWan: true });
}

function mergeComments(byKey, items) {
  for (const it of items || []) {
    const text = String(it.text || "").trim();
    if (text.length < 4) continue;
    if (isSystemCommentChrome(text)) continue;
    if (/说点什么|爱评论的人|展开|收起|查看更多|作者/.test(text)) continue;
    const key = text.slice(0, 80);
    const prev = byKey.get(key);
    const likes = Number.isFinite(it.likes) ? it.likes : null;
    if (!prev) {
      byKey.set(key, { text, user: it.user || "", likes, y: it.y });
      continue;
    }
    if (likes != null && (prev.likes == null || likes > prev.likes)) prev.likes = likes;
    if (it.user && !prev.user) prev.user = it.user;
  }
}

function rankedCandidates(byKey) {
  const all = [...byKey.values()].filter((a) => !isSystemCommentChrome(a.text) && a.text.trim().length >= 6);
  const withLikes = all.filter((a) => a.likes != null && a.likes >= 0).sort((a, b) => b.likes - a.likes || b.text.length - a.text.length);
  if (withLikes.length) return { mode: "likes", list: withLikes };
  // a11y 常无评论赞数：退化为按正文长度，交给 LLM 门禁精选
  return {
    mode: "llm-fallback",
    list: all.sort((a, b) => b.text.length - a.text.length),
  };
}

/**
 * LLM gate before dry-run/send. Fail-closed on error.
 * Returns { ok, verdict, raw }.
 */
function llmApproveComment(text, meta = {}) {
  if (skipLlm) return { ok: true, verdict: "skipped", raw: "no-llm" };
  if (!existsSync(CPA_SCRIPT)) return { ok: false, verdict: "error", raw: "cpa_script_missing" };
  const prompt = `你是小红书评论质检。判断下面「候选文本」是不是真人发的评论正文。
必须拒绝：时间戳(如2天前)、地区(如广东)、按钮文案(评论/回复/展开)、话题标签串、笔记正文误抓、纯表情堆、无意义碎片。
必须通过：像用户随口说的一句完整评论（可含表情）。

笔记标题: ${(meta.title || "").slice(0, 80)}
候选用户: ${(meta.user || "").slice(0, 40)}
候选赞数: ${meta.likes ?? ""}
候选文本: ${String(text).slice(0, 200)}

只输出一行 JSON：{"ok":true|false,"reason":"短原因"}`;
  const r = spawnSync(
    "python",
    [CPA_SCRIPT, "chat", "--model", llmModel, "--message", prompt],
    { encoding: "utf8", timeout: 60000 },
  );
  const raw = `${r.stdout || ""}${r.stderr || ""}`.trim();
  if (r.status !== 0) return { ok: false, verdict: "error", raw: raw.slice(0, 300) };
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return { ok: false, verdict: "error", raw: raw.slice(0, 300) };
  try {
    const j = JSON.parse(m[0]);
    return { ok: !!j.ok, verdict: j.ok ? "pass" : "reject", raw: String(j.reason || "").slice(0, 120) };
  } catch {
    return { ok: false, verdict: "error", raw: raw.slice(0, 300) };
  }
}

async function main() {
  t0 = Date.now();
  const launchArgs = ["ops/launch-app.mjs", "--alias", alias, "--package", PKG, "--ssh", ssh];
  if (forceStop) launchArgs.push("--force-stop");
  let r = await runOps(launchArgs, 45000);
  if (r.code !== 0) fail("launch");
  await sleep(2800);

  let d = await dumpNow();
  if (!d.DUMP || !existsSync(d.DUMP)) fail("dump_feed");
  let xml = readFileSync(d.DUMP, "utf8");
  let cards = parseFeedCards(xml);
  let card = pickCard(cards);
  if (!card) {
    await runOps(["ops/swipe.mjs", "--alias", alias, "--up", "--ssh", ssh], 20000);
    await sleep(1200);
    d = await dumpNow();
    if (d.DUMP && existsSync(d.DUMP)) {
      cards = parseFeedCards(readFileSync(d.DUMP, "utf8"));
      card = pickCard(cards);
    }
  }
  if (!card) fail("no_card");
  console.log(`CARD_KIND=${card.kind}`);
  console.log(`CARD_TITLE=${card.title.slice(0, 80)}`);
  console.log(`CARD_AUTHOR=${card.author}`);
  console.log(`CARD_XY=${card.cx},${card.cy}`);

  r = await tapXY(card.cx, card.cy);
  if (r.code !== 0) fail("tap_card");
  await sleep(2800);
  let f = await focusNow();
  if (!isDetailFocus(f.FOCUS)) fail("not_detail", { FOCUS: f.FOCUS || "" });
  console.log(`FOCUS_DETAIL=${f.FOCUS}`);

  d = await dumpNow();
  if (!d.DUMP || !existsSync(d.DUMP)) fail("dump_detail");
  xml = readFileSync(d.DUMP, "utf8");
  let bar = parseBottomBar(xml);
  if (!bar.comment && !bar.commentBox) {
    await tapXY(540, 900);
    await sleep(800);
    d = await dumpNow();
    if (d.DUMP && existsSync(d.DUMP)) {
      xml = readFileSync(d.DUMP, "utf8");
      bar = parseBottomBar(xml);
    }
  }
  // Prefer opening the comment list (评论 N) so we can scan likes; fall back to sheet via swipe.
  const openBtn = bar.comment || bar.commentBox;
  if (!openBtn) fail("comment_entry_missing");
  console.log(`COMMENT_ENTRY=${openBtn.desc}@${openBtn.x},${openBtn.y}`);
  r = await tapXY(openBtn.x, openBtn.y);
  if (r.code !== 0) fail("tap_comment_entry");
  await sleep(2200);

  const byKey = new Map();
  for (let i = 0; i < screens; i++) {
    d = await dumpNow();
    if (!d.DUMP || !existsSync(d.DUMP)) fail("dump_comments", { SCREEN: String(i + 1) });
    xml = readFileSync(d.DUMP, "utf8");
    const parsed = parseComments(xml);
    mergeComments(byKey, parsed.items);
    console.log(`SCREEN=${i + 1} ITEMS=${parsed.items.length} MERGED=${byKey.size} COUNT=${parsed.count ?? ""}`);
    if (i < screens - 1) {
      await swipeUp();
      await sleep(1400);
    }
  }

  const rankedPack = rankedCandidates(byKey);
  const ranked = rankedPack.list;
  console.log(`RANK_MODE=${rankedPack.mode}`);
  if (!ranked.length) {
    console.log(`COMMENT=skip`);
    console.log(`REASON=no_liked_comments`);
    console.log(`MERGED=${byKey.size}`);
    await backHome();
    console.log(`ALIAS=${alias}`);
    bizRecord({
      op: "comment-copy-top",
      outcome: "skip",
      reason: "no_liked_comments",
      extra: { MERGED: byKey.size },
      alias,
      serial: null,
      startMs: t0,
    });
    process.exit(0);
  }

  let best = null;
  let llm = null;
  for (const cand of ranked.slice(0, 5)) {
    console.log(`CANDIDATE_TEXT=${cand.text.slice(0, 120)}`);
    console.log(`CANDIDATE_LIKES=${cand.likes ?? ""}`);
    console.log(`CANDIDATE_USER=${cand.user || ""}`);
    // LLM gate BEFORE dry-run / send（失败则换下一条，全拒则 skip）
    llm = llmApproveComment(cand.text, {
      title: card.title,
      user: cand.user,
      likes: cand.likes,
    });
    console.log(`LLM=${llm.verdict}`);
    console.log(`LLM_REASON=${llm.raw}`);
    console.log(`LLM_MODEL=${skipLlm ? "none" : llmModel}`);
    if (llm.ok) {
      best = cand;
      break;
    }
  }
  if (!best) {
    console.log(`COMMENT=skip`);
    console.log(`REASON=llm_rejected_all`);
    await backHome();
    console.log(`ALIAS=${alias}`);
    bizRecord({
      op: "comment-copy-top",
      outcome: "skip",
      reason: "llm_rejected_all",
      extra: { TRIED: ranked.slice(0, 5).map((c) => c.text.slice(0, 40)) },
      alias,
      serial: null,
      startMs: t0,
    });
    process.exit(0);
  }

  const text = best.text.slice(0, 120);
  console.log(`COPIED_USER=${best.user}`);
  console.log(`COPIED_LIKES=${best.likes ?? ""}`);
  console.log(`COPIED_TEXT=${text}`);
  console.log(`CANDIDATES=${byKey.size}`);
  console.log(`DRYRUN_GATE=llm_pass`);

  // Ensure composer is open
  d = await dumpNow();
  if (!d.DUMP || !existsSync(d.DUMP)) fail("dump_before_compose");
  xml = readFileSync(d.DUMP, "utf8");
  let edit = findEditText(xml);
  let box = parseBottomBar(xml).commentBox || bar.commentBox || bar.comment;
  if (!edit && !findSendBtn(xml)) {
    if (box) {
      await tapXY(box.x, box.y);
      await sleep(1800);
      d = await dumpNow();
      if (d.DUMP && existsSync(d.DUMP)) {
        xml = readFileSync(d.DUMP, "utf8");
        edit = findEditText(xml);
        box = parseBottomBar(xml).commentBox || box;
      }
    }
  }
  if (!edit && !box) fail("composer_missing");
  const ix = edit?.x ?? box.x;
  const iy = edit?.y ?? box.y;
  console.log(`INPUT_XY=${ix},${iy}`);

  if (dryRun) {
    console.log(`COMMENT=dry-run`);
    console.log(`REASON=top-liked-located`);
    await backHome();
    console.log(`ALIAS=${alias}`);
    bizRecord({
      op: "comment-copy-top",
      outcome: "dry-run",
      reason: "top-liked-located",
      extra: { COPIED_TEXT: text, COPIED_LIKES: best.likes },
      alias,
      serial: null,
      startMs: t0,
    });
    process.exit(0);
  }

  r = await runOps(
    [
      "ops/input-text.mjs",
      "--alias",
      alias,
      "--text",
      text,
      "--x",
      String(ix),
      "--y",
      String(iy),
      "--clear-first",
      "--keep-ime",
      "--ssh",
      ssh,
    ],
    60000,
  );
  if (r.code !== 0) fail("input_text", { DETAIL: r.out.slice(0, 200) });
  console.log(`INPUT=ok`);
  await sleep(1200);

  d = await dumpNow();
  if (!d.DUMP || !existsSync(d.DUMP)) fail("dump_before_send");
  xml = readFileSync(d.DUMP, "utf8");
  let send = findSendBtn(xml);
  if (!send) {
    const m =
      xml.match(/text="发送"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/) ||
      xml.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^>]*text="发送"/);
    if (m) {
      send = {
        desc: "发送",
        x: Math.round((+m[1] + +m[3]) / 2),
        y: Math.round((+m[2] + +m[4]) / 2),
      };
    }
  }
  if (!send) fail("send_btn_missing");
  console.log(`SEND_XY=${send.x},${send.y}`);

  r = await tapXY(send.x, send.y);
  if (r.code !== 0) fail("tap_send");
  await sleep(2500);

  d = await dumpNow();
  let verified = false;
  let verifyHow = "";
  if (d.DUMP && existsSync(d.DUMP)) {
    xml = readFileSync(d.DUMP, "utf8");
    const tip = text.slice(0, Math.min(8, text.length));
    if (xml.includes(text) || (tip && xml.includes(tip))) {
      verified = true;
      verifyHow = "text-in-dump";
    } else if (!findSendBtn(xml) && !/text="发送"/.test(xml)) {
      verified = true;
      verifyHow = "composer-closed";
    }
  }

  await backHome();
  console.log(`COMMENT=${verified ? "ok" : "ambiguous"}`);
  console.log(`VERIFY=${verifyHow || "none"}`);
  console.log(`ALIAS=${alias}`);
  console.log(`MS=${Date.now() - t0}`);
  bizRecord({
    op: "comment-copy-top",
    outcome: verified ? "ok" : "ambiguous",
    reason: verifyHow || "sent",
    extra: { COPIED_TEXT: text, COPIED_LIKES: best.likes },
    alias,
    serial: null,
    startMs: t0,
  });
  process.exit(verified ? 0 : 1);
}

main().catch((e) => fail("exception", { DETAIL: String(e?.message || e).slice(0, 200) }));
