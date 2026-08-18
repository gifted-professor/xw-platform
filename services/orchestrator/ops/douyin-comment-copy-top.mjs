#!/usr/bin/env node
/**
 * Douyin: open comments → scan first N screens → copy highest-liked pure-text → send.
 * Send path (default): dry-run pick → LLM gate APPROVE → then send.
 *
 *   node ops/douyin-comment-copy-top.mjs --alias 01
 *   node ops/douyin-comment-copy-top.mjs --alias 01 --screens 3 --no-force-stop
 *   node ops/douyin-comment-copy-top.mjs --alias 01 --dry-run
 *
 * stdout: COMMENT=ok|fail|dry-run|skip COPIED_TEXT=… LLM_VERDICT=…
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { parseArgs } from "./_explore-lib.mjs";
import { bizRecord } from "./_biz-trace.mjs";
import { decodeEntities } from "./_xhs-parse.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PKG = "com.ss.android.ugc.aweme";

const { opt, flag } = parseArgs(process.argv.slice(2));
if (flag("--help") || flag("-h")) {
  console.log(`用法: node ops/douyin-comment-copy-top.mjs --alias <01-04> [--screens 3] [--dry-run] [--no-force-stop] [--llm-model <id>] [--no-llm-gate]
默认真发前：选文(dry) → CPA LLM 闸门 APPROVE 才发送；LLM 失败/拒绝则 skip 不发。
stdout: COMMENT=ok|fail|dry-run|skip COPIED_TEXT=… LLM_VERDICT=…`);
  process.exit(0);
}

const alias = opt("--alias");
const ssh = opt("--ssh", "xhs-windows");
const screens = Math.max(1, Math.min(5, Number(opt("--screens", "3")) || 3));
const dryRun = flag("--dry-run");
const forceStop = !flag("--no-force-stop");
const requireLlmGate = !flag("--no-llm-gate");
const llmModel = opt("--llm-model", "gemini-2.5-flash-lite");
if (!alias) {
  console.log("✗ need --alias");
  process.exit(4);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const outDir = join(ROOT, "runtime", "douyin-comment");
mkdirSync(outDir, { recursive: true });

function runOps(args, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn("node", args, { cwd: ROOT, env: { ...process.env, XHS_LOCAL: "1" } });
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
  for (const [k, v] of Object.entries(extra)) if (v != null) console.log(`${k}=${String(v).slice(0, 220)}`);
  console.log(`ALIAS=${alias}`);
  bizRecord({ op: "douyin-comment-copy-top", outcome: "fail", reason, extra, alias, serial: null, startMs: t0 });
  process.exit(2);
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
      text: get("text").replace(/&#10;/g, "\n"),
      desc: get("content-desc"),
      cls: get("class"),
      x1: +b[1],
      y1: +b[2],
      x2: +b[3],
      y2: +b[4],
      cx: ((+b[1] + +b[3]) / 2) | 0,
      cy: ((+b[2] + +b[4]) / 2) | 0,
    });
  }
  return nodes;
}

function isEmojiHeavy(s) {
  const t = String(s || "");
  const letters = t.replace(/[\s\p{Emoji_Presentation}\p{Extended_Pictographic}\uFE0F\u200D]/gu, "");
  if (t.length <= 6 && letters.length <= 1) return true;
  if (/^\[.+\]$/.test(t.trim())) return true;
  return false;
}

function collectComments(raw) {
  const nodes = parseNodes(raw).filter((n) => n.y1 >= 750 && n.y2 <= 2120);
  const metas = nodes.filter((n) => n.text === "回复" && n.x1 < 600);
  const out = [];

  for (const meta of metas) {
    const my = meta.cy;
    const like = nodes.find((n) => Math.abs(n.cy - my) < 40 && n.x1 > 800 && /赞\d+/.test(n.desc));
    let likes = 0;
    if (like) {
      const m = like.desc.match(/赞(\d+)/);
      if (m) likes = +m[1];
    }
    for (const n of nodes) {
      if (Math.abs(n.cy - my) > 45 || n.x1 < 720) continue;
      let v = null;
      if (/^[\d.]+万$/.test(n.text)) v = Math.round(parseFloat(n.text) * 10000);
      else if (/^\d{1,7}$/.test(n.text)) v = +n.text;
      if (v != null && v > likes) likes = v;
    }

    const time = nodes.find(
      (n) =>
        Math.abs(n.cy - my) < 30 &&
        n.x1 < 400 &&
        /刚刚|分钟前|小时前|昨天|前天|\d+天前|^\d{2}-\d{2}/.test(n.text),
    );
    const topY = time ? time.y1 : meta.y1;

    const bodyNode = nodes
      .filter(
        (n) =>
          n.cls.endsWith("TextView") &&
          n.y2 <= topY - 2 &&
          n.y1 >= topY - 220 &&
          n.x1 >= 140 &&
          n.x1 < 700 &&
          n.text &&
          n.text !== "回复" &&
          !/大家都在搜|AI 解析|评论\s*\d+|展开\d+条|同时发布/.test(n.text),
      )
      .sort((a, b) => b.y1 - a.y1)[0];
    if (!bodyNode) continue;

    const userNode = nodes
      .filter(
        (n) =>
          n.cls.endsWith("TextView") &&
          n.y2 <= bodyNode.y1 - 2 &&
          n.y1 >= bodyNode.y1 - 120 &&
          n.x1 >= 140 &&
          n.x1 < 700 &&
          n.text &&
          !/大家都在搜|AI 解析/.test(n.text),
      )
      .sort((a, b) => b.y1 - a.y1)[0];

    const body = bodyNode.text.trim();
    const user = (userNode?.text || "").trim();
    if (body.length < 2) continue;
    if (/大家都在搜|AI 解析|评论\s*\d+|展开\d+条回复/.test(body)) continue;

    const hasImage = nodes.some(
      (n) =>
        n.y1 >= (userNode?.y1 ?? bodyNode.y1 - 80) &&
        n.y2 <= my &&
        n.x1 > 140 &&
        (n.desc === "image" ||
          n.desc === "图片" ||
          (n.cls.includes("ImageView") && n.x2 - n.x1 > 150 && n.y2 - n.y1 > 100)),
    );

    out.push({
      user: user.slice(0, 40),
      text: body.slice(0, 200),
      likes,
      pureText: !hasImage && !isEmojiHeavy(body),
      likeCx: like?.cx ?? 894,
      likeCy: like?.cy ?? my,
      bodyCy: bodyNode.cy,
    });
  }
  return out;
}

function commentCount(descOrText) {
  const m = String(descOrText || "").match(/评论([\d.]+)(万)?/);
  if (!m) return 0;
  return m[2] ? Math.round(parseFloat(m[1]) * 10000) : +m[1];
}

async function dumpXml() {
  const r = await runOps(["ops/dump-ui.mjs", "--alias", alias, "--ssh", ssh], 50000);
  const k = kv(r.out);
  if (k.DUMP && existsSync(k.DUMP)) return readFileSync(k.DUMP, "utf8");
  // fallback: newest dump-alias file
  try {
    const dir = join(tmpdir(), "xhs-explore");
    if (!existsSync(dir)) return null;
    const dumps = readdirSync(dir)
      .filter((f) => f.startsWith(`dump-${alias}-`) && f.endsWith(".xml"))
      .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    if (dumps[0]) return readFileSync(join(dir, dumps[0].f), "utf8");
  } catch {}
  return null;
}

async function tapXY(x, y) {
  return runOps(["ops/tap.mjs", "--alias", alias, "--x", String(x), "--y", String(y), "--ssh", ssh], 20000);
}

async function swipe(x1, y1, x2, y2, ms = 350) {
  return runOps(
    [
      "ops/swipe.mjs",
      "--alias",
      alias,
      "--x1",
      String(x1),
      "--y1",
      String(y1),
      "--x2",
      String(x2),
      "--y2",
      String(y2),
      "--ms",
      String(ms),
      "--ssh",
      ssh,
    ],
    20000,
  );
}

async function backOnce() {
  return runOps(["ops/back.mjs", "--alias", alias, "--ssh", ssh], 15000);
}

async function main() {
  t0 = Date.now();
  const launchArgs = ["ops/launch-app.mjs", "--alias", alias, "--package", PKG, "--ssh", ssh];
  if (forceStop) launchArgs.push("--force-stop");
  let r = await runOps(launchArgs, 45000);
  if (r.code !== 0) fail("launch", { DETAIL: r.out.slice(0, 160) });
  await sleep(forceStop ? 5500 : 2000);

  let raw = await dumpXml();
  let nodes = raw ? parseNodes(raw) : [];

  // close composer if open; never blind-back from feed
  if (nodes.some((n) => n.text === "发送" || /^回复 @/.test(n.text))) {
    await backOnce();
    await sleep(800);
    raw = await dumpXml();
    nodes = raw ? parseNodes(raw) : [];
  }

  let inComments = nodes.some((n) => n.text === "回复" && n.x1 < 600);
  if (!inComments) {
    for (let i = 0; i < 6; i++) {
      raw = await dumpXml();
      nodes = raw ? parseNodes(raw) : [];
      const btn = nodes
        .filter((n) => /评论/.test(n.desc) && /按钮/.test(n.desc) && n.cx > 850)
        .map((n) => ({ ...n, c: commentCount(n.desc) }))
        .sort((a, b) => b.c - a.c)[0];
      if (btn && btn.c >= 50) {
        console.log(`COMMENT_BTN=${btn.desc}`);
        await tapXY(btn.cx, btn.cy);
        await sleep(2800);
        break;
      }
      if (i === 5 && btn) {
        console.log(`COMMENT_BTN=${btn.desc}`);
        await tapXY(btn.cx, btn.cy);
        await sleep(2800);
        break;
      }
      await swipe(540, 1600, 540, 600, 320);
      await sleep(1800);
    }
    raw = await dumpXml();
    nodes = raw ? parseNodes(raw) : [];
    inComments = nodes.some((n) => n.text === "回复" && n.x1 < 600);
    if (!inComments) {
      // last resort: rail comment button coords
      const rail = nodes.find((n) => /评论/.test(n.desc) && /按钮/.test(n.desc) && n.cx > 850);
      if (rail) {
        await tapXY(rail.cx, rail.cy);
        await sleep(2800);
      } else {
        await tapXY(997, 1450);
        await sleep(2800);
      }
      raw = await dumpXml();
      nodes = raw ? parseNodes(raw) : [];
      inComments = nodes.some((n) => n.text === "回复" && n.x1 < 600);
    }
  }

  if (!inComments) fail("comments_not_open");

  // prefer 热门 sort
  const hot = nodes.find((n) => n.text === "热门" || n.text.includes("按热度"));
  if (hot) {
    await tapXY(hot.cx, hot.cy);
    await sleep(1200);
  }

  const all = [];
  for (let i = 0; i < screens; i++) {
    if (i > 0) {
      await swipe(540, 1700, 540, 1000, 350);
      await sleep(1100);
    }
    raw = await dumpXml();
    if (!raw) continue;
    const cs = collectComments(raw);
    console.log(`SCREEN=${i} comments=${cs.length} pure=${cs.filter((c) => c.pureText).length}`);
    for (const c of cs) all.push(c);
  }

  const pure = all.filter((c) => c.pureText && c.text.length >= 4);
  const map = new Map();
  for (const c of pure) {
    const prev = map.get(c.text);
    if (!prev || c.likes > prev.likes) map.set(c.text, c);
  }
  const ranked = [...map.values()].sort((a, b) => b.likes - a.likes || a.bodyCy - b.bodyCy);
  writeFileSync(join(outDir, `candidates-${alias}.json`), JSON.stringify({ ranked: ranked.slice(0, 12) }, null, 2));

  if (!ranked.length) fail("no_pure_text");

  const best = ranked[0];
  console.log(`COPIED_LIKES=${best.likes}`);
  console.log(`COPIED_TEXT=${best.text.slice(0, 160)}`);
  console.log(`COPIED_USER=${best.user}`);

  if (/大家都在搜|AI 解析|评论\s*\d+/.test(best.text)) fail("polluted_pick");

  // Phase A: dry-run pick complete (always printed before any send)
  console.log(`PHASE=dry-run-pick`);
  writeFileSync(
    join(outDir, `dryrun-${alias}.json`),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        alias,
        likes: best.likes,
        user: best.user,
        text: best.text,
        rankedTop: ranked.slice(0, 5).map((c) => ({ likes: c.likes, text: c.text.slice(0, 80) })),
      },
      null,
      2,
    ),
  );

  if (dryRun) {
    console.log(`COMMENT=dry-run`);
    console.log(`REASON=located-not-sent`);
    console.log(`ALIAS=${alias}`);
    bizRecord({
      op: "douyin-comment-copy-top",
      outcome: "dry-run",
      reason: "located-not-sent",
      extra: { text: best.text.slice(0, 80), likes: best.likes },
      alias,
      serial: null,
      startMs: t0,
    });
    await backOnce();
    process.exit(0);
  }

  // Phase B: LLM gate (required by default; fail-closed → skip, never send)
  let llmVerdict = "SKIPPED";
  let llmReason = "no_llm_gate";
  if (requireLlmGate) {
    console.log(`PHASE=llm-gate`);
    console.log(`LLM_MODEL=${llmModel}`);
    const gate = await runOps(
      ["ops/_llm-comment-gate.mjs", "--text", best.text.slice(0, 200), "--model", llmModel],
      120000,
    );
    const gk = kv(gate.out);
    llmVerdict = gk.LLM_VERDICT || "ERROR";
    llmReason = gk.LLM_REASON || gate.out.slice(0, 160) || "llm_no_output";
    console.log(`LLM_VERDICT=${llmVerdict}`);
    console.log(`LLM_REASON=${llmReason}`);
    if (llmVerdict !== "APPROVE") {
      console.log(`COMMENT=skip`);
      console.log(`REASON=${llmVerdict === "DENY" ? "llm_denied" : "llm_unavailable"}`);
      console.log(`ALIAS=${alias}`);
      bizRecord({
        op: "douyin-comment-copy-top",
        outcome: "skip",
        reason: llmVerdict === "DENY" ? "llm_denied" : "llm_unavailable",
        extra: { text: best.text.slice(0, 80), likes: best.likes, llmVerdict, llmReason },
        alias,
        serial: null,
        startMs: t0,
      });
      await backOnce();
      process.exit(0);
    }
  } else {
    console.log(`LLM_VERDICT=BYPASS`);
    console.log(`LLM_REASON=no_llm_gate_flag`);
  }

  // Phase C: send only after APPROVE
  console.log(`PHASE=send`);
  raw = await dumpXml();
  nodes = raw ? parseNodes(raw) : [];
  if (nodes.some((n) => /^回复 @/.test(n.text))) {
    await backOnce();
    await sleep(800);
  }
  await tapXY(250, 2145);
  await sleep(1200);

  const text = best.text.slice(0, 80);
  r = await runOps(["ops/input-text.mjs", "--alias", alias, "--text", text, "--ssh", ssh], 90000);
  if (r.code !== 0) fail("input", { DETAIL: r.out.slice(0, 160) });
  await sleep(1000);

  raw = await dumpXml();
  let send = raw ? parseNodes(raw).find((n) => n.text === "发送") : null;
  if (send) await tapXY(send.cx, send.cy);
  else await tapXY(975, 1488);
  await sleep(3200);

  // like the top pure-text comment (scroll toward top)
  for (let i = 0; i < 2; i++) {
    await swipe(540, 1000, 540, 1700, 300);
    await sleep(500);
  }
  raw = await dumpXml();
  if (raw) {
    const again = collectComments(raw);
    const hit =
      again.find((c) => c.text.includes(best.text.slice(0, 10))) ||
      again.filter((c) => c.pureText).sort((a, b) => b.likes - a.likes)[0];
    if (hit) {
      await tapXY(hit.likeCx, hit.likeCy);
      await sleep(1000);
    }
  }

  // leave comment panel back to feed
  await backOnce();
  await sleep(800);

  console.log(`COMMENT=ok`);
  console.log(`ALIAS=${alias}`);
  writeFileSync(
    join(outDir, `last-${alias}.json`),
    JSON.stringify(
      {
        ok: true,
        copied: best.text,
        likes: best.likes,
        user: best.user,
        llmVerdict,
        llmReason,
        at: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  bizRecord({
    op: "douyin-comment-copy-top",
    outcome: "ok",
    extra: { text: best.text.slice(0, 80), likes: best.likes, user: best.user, llmVerdict, llmReason },
    alias,
    serial: null,
    startMs: t0,
  });
  process.exit(0);
}

main().catch((e) => {
  console.log(`COMMENT=fail`);
  console.log(`REASON=exception`);
  console.log(`DETAIL=${String(e.message || e).slice(0, 300)}`);
  console.log(`ALIAS=${alias}`);
  bizRecord({
    op: "douyin-comment-copy-top",
    outcome: "fail",
    reason: "exception",
    extra: { detail: String(e.message || e).slice(0, 300) },
    alias,
    serial: null,
    startMs: t0,
  });
  process.exit(4);
});
