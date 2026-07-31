#!/usr/bin/env node
/**
 * XHS DM path explorer / opener.
 *
 * Path A (default): feed note → author avatar/name area → profile → 发私信
 * Path B: --from-me  bottom 我 → (best-effort) followers/history — weaker, exploratory
 *
 *   node ops/xhs-dm-open.mjs --alias 02                 # open DM composer, no send
 *   node ops/xhs-dm-open.mjs --alias 02 --text "你好"   # type only, no send
 *   node ops/xhs-dm-open.mjs --alias 02 --text "你好" --send   # REAL send (needs auth)
 *
 * Never sends unless --send is explicit.
 */
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./_explore-lib.mjs";
import { bizRecord } from "./_biz-trace.mjs";
import {
  parseFeedCards,
  pickFeedCard,
  findEditText,
  findSendBtn,
  isHomeFocus,
  isDetailFocus,
  decodeEntities,
} from "./_xhs-parse.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PKG = "com.xingin.xhs";

const { opt, flag } = parseArgs(process.argv.slice(2));
if (flag("--help") || flag("-h")) {
  console.log(`用法: node ops/xhs-dm-open.mjs --alias <01-04> [--text 你好] [--send] [--no-force-stop]
默认只打开私信页；--text 输入；--send 才真正发送。`);
  process.exit(0);
}

const alias = opt("--alias");
const ssh = opt("--ssh", "xhs-windows");
const text = opt("--text");
const doSend = flag("--send");
const forceStop = !flag("--no-force-stop");
if (!alias) {
  console.log("✗ need --alias");
  process.exit(4);
}
if (doSend && !text) {
  console.log("✗ --send requires --text");
  process.exit(4);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runOps(args, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn("node", args, { cwd: ROOT });
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

let t0 = Date.now(); // 业务动作起点（module-scope，fail/catch 也能引用）

function fail(reason, extra = {}) {
  console.log(`DM=fail`);
  console.log(`REASON=${reason}`);
  for (const [k, v] of Object.entries(extra)) if (v != null) console.log(`${k}=${String(v).slice(0, 200)}`);
  console.log(`ALIAS=${alias}`);
  // biz trace：终态同步落盘（SSH 路径同步 execFileSync），落完再 exit
  bizRecord({ op: "dm", outcome: "fail", reason, extra, alias, serial: null, startMs: t0 });
  process.exit(2);
}

function allNodes(xml) {
  const out = [];
  const re = /<node\b[^>]*>/g;
  let m;
  while ((m = re.exec(xml))) {
    const tag = m[0];
    const b = tag.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (!b) continue;
    out.push({
      L: +b[1],
      T: +b[2],
      R: +b[3],
      B: +b[4],
      cx: Math.round((+b[1] + +b[3]) / 2),
      cy: Math.round((+b[2] + +b[4]) / 2),
      w: +b[3] - +b[1],
      h: +b[4] - +b[2],
      text: decodeEntities((tag.match(/text="([^"]*)"/) || [])[1] || ""),
      desc: decodeEntities((tag.match(/content-desc="([^"]*)"/) || [])[1] || ""),
      clickable: /clickable="true"/.test(tag),
      cls: ((tag.match(/class="([^"]*)"/) || [])[1] || "").split(".").pop(),
    });
  }
  return out;
}

function findByTextOrDesc(xml, patterns) {
  const nodes = allNodes(xml);
  for (const pat of patterns) {
    const re = typeof pat === "string" ? new RegExp(pat) : pat;
    const hit = nodes.find((n) => re.test(n.text || "") || re.test(n.desc || ""));
    if (hit) return { ...hit, matched: hit.text || hit.desc };
  }
  return null;
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

async function main() {
  t0 = Date.now();
  const launchArgs = ["ops/launch-app.mjs", "--alias", alias, "--package", PKG, "--ssh", ssh];
  if (forceStop) launchArgs.push("--force-stop");
  let r = await runOps(launchArgs, 45000);
  if (r.code !== 0) fail("launch");
  await sleep(2600);

  // open a note
  let d = await dumpNow();
  if (!d.DUMP || !existsSync(d.DUMP)) fail("dump_feed");
  let xml = readFileSync(d.DUMP, "utf8");
  let card = pickFeedCard(parseFeedCards(xml), { prefer: "note", avoidWan: true });
  if (!card) {
    await runOps(["ops/swipe.mjs", "--alias", alias, "--up", "--ssh", ssh], 20000);
    await sleep(900);
    d = await dumpNow();
    if (d.DUMP && existsSync(d.DUMP)) card = pickFeedCard(parseFeedCards(readFileSync(d.DUMP, "utf8")), { prefer: "note" });
  }
  if (!card) fail("no_card");
  console.log(`CARD_TITLE=${card.title.slice(0, 60)}`);
  console.log(`CARD_AUTHOR=${card.author || ""}`);
  await tapXY(card.cx, card.cy);
  await sleep(2800);
  let f = await focusNow();
  if (!isDetailFocus(f.FOCUS)) fail("not_detail", { FOCUS: f.FOCUS || "" });
  console.log(`FOCUS_DETAIL=${f.FOCUS}`);

  // on detail: tap author name (NOT back button at left ~x<100)
  d = await dumpNow();
  if (!d.DUMP || !existsSync(d.DUMP)) fail("dump_detail");
  xml = readFileSync(d.DUMP, "utf8");
  const nodes = allNodes(xml);
  // Prefer author nickname TextView: top bar, x>100, short text, not 关注
  let authorTap = nodes
    .filter(
      (n) =>
        n.cy >= 100 &&
        n.cy <= 280 &&
        n.cx >= 120 &&
        n.cx <= 700 &&
        n.text &&
        n.text.length >= 1 &&
        n.text.length <= 20 &&
        !/关注|已关注|回关|分享|搜索/.test(n.text),
    )
    .sort((a, b) => a.cy - b.cy || a.cx - b.cx)[0];
  // fallback: clickable near author name (avatar), avoid back (x<100)
  if (!authorTap) {
    authorTap = nodes
      .filter((n) => n.clickable && n.cy >= 100 && n.cy <= 300 && n.cx >= 120 && n.cx <= 500)
      .sort((a, b) => a.cx - b.cx || a.cy - b.cy)[0];
  }
  const ax = authorTap?.cx ?? 280;
  const ay = authorTap?.cy ?? 160;
  console.log(`AUTHOR_TAP=${ax},${ay}`);
  console.log(`AUTHOR_LABEL=${(authorTap?.text || authorTap?.desc || "").slice(0, 40)}`);
  await tapXY(ax, ay);
  await sleep(2800);

  f = await focusNow();
  console.log(`FOCUS_AFTER_AUTHOR=${f.FOCUS || ""}`);
  d = await dumpNow();
  if (!d.DUMP || !existsSync(d.DUMP)) fail("dump_profile");
  xml = readFileSync(d.DUMP, "utf8");
  writeHints(xml, "profile");

  // find 发私信 / 私信
  let dmBtn = findByTextOrDesc(xml, [/^发私信$/, /发私信/, /^私信$/, /私信/]);
  // sometimes button is "私信" near bottom of header
  if (!dmBtn) {
    const n2 = allNodes(xml).find(
      (n) => n.clickable && (/私信/.test(n.text) || /私信/.test(n.desc)),
    );
    if (n2) dmBtn = { ...n2, matched: n2.text || n2.desc };
  }
  if (!dmBtn) {
    // scroll profile a bit and retry
    await runOps(["ops/swipe.mjs", "--alias", alias, "--up", "--ssh", ssh], 20000);
    await sleep(1000);
    d = await dumpNow();
    if (d.DUMP && existsSync(d.DUMP)) {
      xml = readFileSync(d.DUMP, "utf8");
      dmBtn = findByTextOrDesc(xml, [/^发私信$/, /发私信/, /^私信$/]);
    }
  }
  if (!dmBtn) {
    // dump interesting texts for engineer
    const texts = allNodes(xml)
      .filter((n) => n.text || n.desc)
      .map((n) => n.text || n.desc)
      .filter(Boolean)
      .slice(0, 40);
    fail("dm_btn_missing", { FOCUS: f.FOCUS || "", TEXTS: texts.join("|") });
  }
  console.log(`DM_BTN=${dmBtn.matched}@${dmBtn.cx},${dmBtn.cy}`);
  await tapXY(dmBtn.cx, dmBtn.cy);
  await sleep(2500);

  f = await focusNow();
  console.log(`FOCUS_DM=${f.FOCUS || ""}`);
  d = await dumpNow();
  if (!d.DUMP || !existsSync(d.DUMP)) fail("dump_dm");
  xml = readFileSync(d.DUMP, "utf8");
  writeHints(xml, "dm");
  const edit = findEditText(xml);
  const send = findSendBtn(xml) || findByTextOrDesc(xml, [/^发送$/]);
  console.log(`DM_EDIT=${edit ? `${edit.x},${edit.y}` : ""}`);
  console.log(`DM_EDIT_TEXT=${(edit?.text || "").slice(0, 40)}`);
  console.log(`DM_SEND=${send ? `${send.cx || send.x},${send.cy || send.y}` : ""}`);

  const opened = !!(edit || send || /chat|message|im|私信|Conversation/i.test(f.FOCUS || "") || xml.includes("发送"));
  if (!opened) fail("dm_page_uncertain", { FOCUS: f.FOCUS || "" });

  if (!text) {
    console.log(`DM=ok`);
    console.log(`MODE=open-only`);
    console.log(`ALIAS=${alias}`);
    bizRecord({ op: "dm", outcome: "ok", reason: "open-only", alias, serial: null, startMs: t0 });
    process.exit(0);
  }

  // type
  const ix = edit?.x ?? 540;
  const iy = edit?.y ?? 2200;
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
  if (r.code !== 0) fail("input", { DETAIL: r.out.slice(0, 160) });
  console.log(`INPUT=ok`);
  console.log(`TEXT=${text}`);
  await sleep(1000);
  d = await dumpNow();
  xml = d.DUMP && existsSync(d.DUMP) ? readFileSync(d.DUMP, "utf8") : "";
  const edit2 = findEditText(xml);
  console.log(`DM_EDIT_AFTER=${(edit2?.text || "").slice(0, 40)}`);

  if (!doSend) {
    console.log(`DM=ok`);
    console.log(`MODE=typed-no-send`);
    console.log(`ALIAS=${alias}`);
    bizRecord({ op: "dm", outcome: "ok", reason: "typed-no-send", alias, serial: null, startMs: t0 });
    process.exit(0);
  }

  let send2 = findSendBtn(xml) || findByTextOrDesc(xml, [/^发送$/]);
  if (!send2) fail("send_missing_before_send");
  await tapXY(send2.cx || send2.x, send2.cy || send2.y);
  await sleep(2000);
  d = await dumpNow();
  xml = d.DUMP && existsSync(d.DUMP) ? readFileSync(d.DUMP, "utf8") : "";
  const verified = xml.includes(text);
  console.log(`VERIFY=${verified ? "text-in-dump" : "tapped-send"}`);
  console.log(`DM=ok`);
  console.log(`MODE=sent`);
  console.log(`ALIAS=${alias}`);
  bizRecord({ op: "dm", outcome: "ok", reason: "sent", alias, serial: null, startMs: t0 });
  process.exit(0);
}

function writeHints(xml, tag) {
  const nodes = allNodes(xml);
  const interesting = nodes
    .filter((n) => n.text || n.desc)
    .map((n) => n.text || n.desc)
    .filter((t) => /私信|关注|粉丝|获赞|发送|消息|笔记|编辑|回关/.test(t))
    .slice(0, 25);
  if (interesting.length) console.log(`HINTS_${tag}=${interesting.join("|")}`);
}

main().catch((e) => {
  console.log(`DM=fail`);
  console.log(`REASON=exception`);
  console.log(`DETAIL=${String(e.message || e).slice(0, 300)}`);
  console.log(`ALIAS=${alias}`);
  bizRecord({ op: "dm", outcome: "fail", reason: "exception", extra: { detail: String(e.message || e).slice(0, 300) }, alias, serial: null, startMs: t0 });
  process.exit(4);
});
