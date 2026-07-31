#!/usr/bin/env node
/**
 * XHS: open one feed note → comment → send → verify → back home.
 *
 *   node ops/xhs-comment-one.mjs --alias 01 --text "学到了"
 *   node ops/xhs-comment-one.mjs --alias 01 --text "学到了" --dry-run
 *
 * Real send requires human authorization (not --dry-run).
 */
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./_explore-lib.mjs";
import {
  parseFeedCards,
  pickFeedCard,
  parseBottomBar,
  findSendBtn,
  findEditText,
  isHomeFocus,
  isDetailFocus,
} from "./_xhs-parse.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PKG = "com.xingin.xhs";

const { opt, flag } = parseArgs(process.argv.slice(2));
if (flag("--help") || flag("-h")) {
  console.log(`用法: node ops/xhs-comment-one.mjs --alias <01-04> --text <评论> [--dry-run] [--no-force-stop]
stdout: COMMENT=ok|fail ...`);
  process.exit(0);
}

const alias = opt("--alias");
const text = opt("--text") || "学到了👍";
const ssh = opt("--ssh", "xhs-windows");
const dryRun = flag("--dry-run");
const forceStop = !flag("--no-force-stop");
if (!alias) {
  console.log("✗ need --alias");
  process.exit(4);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runOps(args, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn("node", args, { cwd: ROOT });
    let out = "";
    const timer = setTimeout(() => {
      try { p.kill("SIGKILL"); } catch {}
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

function fail(reason, extra = {}) {
  console.log(`COMMENT=fail`);
  console.log(`REASON=${reason}`);
  for (const [k, v] of Object.entries(extra)) if (v != null && v !== "") console.log(`${k}=${v}`);
  console.log(`ALIAS=${alias}`);
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
async function backHome() {
  for (let i = 0; i < 3; i++) {
    await runOps(["ops/back.mjs", "--alias", alias, "--ssh", ssh], 15000);
    await sleep(1200);
    const f = await focusNow();
    if (isHomeFocus(f.FOCUS)) return true;
  }
  return false;
}

async function main() {
  const launchArgs = ["ops/launch-app.mjs", "--alias", alias, "--package", PKG, "--ssh", ssh];
  if (forceStop) launchArgs.push("--force-stop");
  let r = await runOps(launchArgs, 45000);
  if (r.code !== 0) fail("launch");
  await sleep(2800);

  let d = await dumpNow();
  if (!d.DUMP || !existsSync(d.DUMP)) fail("dump_feed");
  let xml = readFileSync(d.DUMP, "utf8");
  let cards = parseFeedCards(xml);
  let card = pickFeedCard(cards, { prefer: "note", avoidWan: true });
  if (!card) {
    await runOps(["ops/swipe.mjs", "--alias", alias, "--up", "--ssh", ssh], 20000);
    await sleep(1000);
    d = await dumpNow();
    if (d.DUMP && existsSync(d.DUMP)) {
      cards = parseFeedCards(readFileSync(d.DUMP, "utf8"));
      card = pickFeedCard(cards, { prefer: "note", avoidWan: false });
    }
  }
  if (!card) fail("no_card");
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
  if (!bar.commentBox && !bar.comment) {
    await tapXY(540, 900);
    await sleep(800);
    d = await dumpNow();
    if (d.DUMP && existsSync(d.DUMP)) {
      xml = readFileSync(d.DUMP, "utf8");
      bar = parseBottomBar(xml);
    }
  }
  const box = bar.commentBox || bar.comment;
  if (!box) fail("comment_box_missing");
  console.log(`COMMENT_BOX=${box.desc}@${box.x},${box.y}`);
  console.log(`COMMENT_COUNT_BEFORE=${bar.comment?.desc || ""}`);

  // open composer
  r = await tapXY(box.x, box.y);
  if (r.code !== 0) fail("tap_comment_box");
  await sleep(2000);

  d = await dumpNow();
  if (!d.DUMP || !existsSync(d.DUMP)) fail("dump_composer");
  xml = readFileSync(d.DUMP, "utf8");
  // If composer not fully up, retap comment box once
  if (!findEditText(xml) && !findSendBtn(xml)) {
    await tapXY(box.x, box.y);
    await sleep(1800);
    d = await dumpNow();
    if (!d.DUMP || !existsSync(d.DUMP)) fail("dump_composer_retry");
    xml = readFileSync(d.DUMP, "utf8");
  }
  // Prefer focused EditText in composer (not random mid-screen)
  const edit = findEditText(xml);
  let ix = edit?.x ?? box.x;
  let iy = edit?.y ?? box.y;
  // fallback comment box again
  if (!edit) {
    const cb = parseBottomBar(xml).commentBox;
    if (cb) {
      ix = cb.x;
      iy = cb.y;
    }
  }
  console.log(`INPUT_XY=${ix},${iy}`);
  console.log(`EDIT_TEXT_BEFORE=${(edit?.text || "").slice(0, 40)}`);
  console.log(`TEXT=${text}`);

  if (dryRun) {
    console.log(`COMMENT=dry-run`);
    console.log(`REASON=composer-located`);
    const send0 = findSendBtn(xml);
    if (send0) console.log(`SEND_XY=${send0.x},${send0.y}`);
    await backHome();
    console.log(`ALIAS=${alias}`);
    process.exit(0);
  }

  // keep-ime: restoring IME often dismisses XHS composer before 发送
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
  const editAfter = findEditText(xml);
  console.log(`EDIT_TEXT_AFTER=${(editAfter?.text || "").slice(0, 40)}`);
  const textLanded =
    (editAfter?.text && editAfter.text.includes(text)) ||
    xml.includes(text) ||
    (editAfter?.text && editAfter.text !== edit?.text && editAfter.text.length > 0 && !/说点什么|爱评论的人/.test(editAfter.text));

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
  // If text didn't land or send missing, one retry: retap box + input keep-ime
  if (!send || !textLanded) {
    console.log(`WARN_RETRY=composer`);
    await tapXY(box.x, box.y);
    await sleep(1000);
    d = await dumpNow();
    if (d.DUMP && existsSync(d.DUMP)) {
      xml = readFileSync(d.DUMP, "utf8");
      const e2 = findEditText(xml);
      if (e2) {
        ix = e2.x;
        iy = e2.y;
      }
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
    if (r.code !== 0) fail("input_text_retry", { DETAIL: r.out.slice(0, 200) });
    await sleep(1200);
    d = await dumpNow();
    if (!d.DUMP || !existsSync(d.DUMP)) fail("dump_before_send_retry");
    xml = readFileSync(d.DUMP, "utf8");
    send = findSendBtn(xml);
    const e3 = findEditText(xml);
    console.log(`EDIT_TEXT_RETRY=${(e3?.text || "").slice(0, 40)}`);
    if (!send) fail("send_btn_missing", { EDIT: (e3?.text || "").slice(0, 40) });
  }
  console.log(`SEND_XY=${send.x},${send.y}`);

  r = await tapXY(send.x, send.y);
  if (r.code !== 0) fail("tap_send");
  await sleep(2500);

  // verify: dump contains comment text OR comment count changed OR send gone
  d = await dumpNow();
  let verified = false;
  let verifyHow = "";
  if (d.DUMP && existsSync(d.DUMP)) {
    xml = readFileSync(d.DUMP, "utf8");
    if (xml.includes(text) || xml.includes(text.slice(0, Math.min(6, text.length)))) {
      verified = true;
      verifyHow = "text-in-dump";
    } else {
      const bar2 = parseBottomBar(xml);
      if (bar2.comment && bar.comment && bar2.comment.desc !== bar.comment.desc) {
        verified = true;
        verifyHow = "count-changed";
        console.log(`COMMENT_COUNT_AFTER=${bar2.comment.desc}`);
      } else if (!findSendBtn(xml) && !/text="发送"/.test(xml)) {
        // composer closed after send — weak pass
        verified = true;
        verifyHow = "composer-closed";
      }
    }
  }
  console.log(`VERIFY=${verifyHow || "none"}`);

  const home = await backHome();
  console.log(`BACK_HOME=${home ? "yes" : "no"}`);
  f = await focusNow();
  console.log(`FOCUS=${f.FOCUS || ""}`);

  if (!verified) fail("not_verified", { VERIFY: verifyHow || "none" });
  console.log(`COMMENT=ok`);
  console.log(`ALIAS=${alias}`);
  process.exit(0);
}

main().catch((e) => {
  console.log(`COMMENT=fail`);
  console.log(`REASON=exception`);
  console.log(`DETAIL=${String(e.message || e).slice(0, 300)}`);
  console.log(`ALIAS=${alias}`);
  process.exit(4);
});
