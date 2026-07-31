#!/usr/bin/env node
/**
 * Search XHS user by name → open profile → 发私信 → optional send.
 *
 *   node ops/xhs-dm-user.mjs --alias 01 --user 天才较瘦
 *   node ops/xhs-dm-user.mjs --alias 01 --user 天才较瘦 --text "你好" --send
 */
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./_explore-lib.mjs";
import {
  decodeEntities,
  findEditText,
  findSendBtn,
  isHomeFocus,
} from "./_xhs-parse.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PKG = "com.xingin.xhs";

const { opt, flag } = parseArgs(process.argv.slice(2));
if (flag("--help") || flag("-h")) {
  console.log(`用法: node ops/xhs-dm-user.mjs --alias <01-04> --user <昵称> [--text 你好] [--send]
默认打开私信页；--send 才发送。`);
  process.exit(0);
}

const alias = opt("--alias");
const user = opt("--user") || opt("--keyword");
const text = opt("--text") || "你好，测试一下自动化私信～";
const doSend = flag("--send");
const ssh = opt("--ssh", "xhs-windows");
const forceStop = !flag("--no-force-stop");
if (!alias || !user) {
  console.log("✗ need --alias --user");
  process.exit(4);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runOps(args, timeoutMs = 360000) {
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

function fail(reason, extra = {}) {
  console.log(`DM_USER=fail`);
  console.log(`REASON=${reason}`);
  for (const [k, v] of Object.entries(extra)) if (v != null) console.log(`${k}=${String(v).slice(0, 240)}`);
  console.log(`ALIAS=${alias}`);
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

function findLabel(xml, patterns) {
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
  console.log(`USER=${user}`);
  console.log(`TEXT=${text}`);
  console.log(`SEND=${doSend ? "yes" : "no"}`);

  const launchArgs = ["ops/launch-app.mjs", "--alias", alias, "--package", PKG, "--ssh", ssh];
  if (forceStop) launchArgs.push("--force-stop");
  let r = await runOps(launchArgs, 45000);
  if (r.code !== 0) fail("launch");
  await sleep(2600);

  // open search
  let d = await dumpNow();
  if (!d.DUMP || !existsSync(d.DUMP)) fail("dump_home");
  let xml = readFileSync(d.DUMP, "utf8");
  let sbtn = findLabel(xml, [/^搜索$/, /content-desc="搜索/]) || { cx: 1005, cy: 156, matched: "fallback" };
  // content-desc search often top-right
  const nodes0 = allNodes(xml);
  const s2 = nodes0.find((n) => n.desc === "搜索" || n.text === "搜索");
  if (s2) sbtn = { ...s2, matched: s2.desc || s2.text };
  console.log(`SEARCH_BTN=${sbtn.matched}@${sbtn.cx},${sbtn.cy}`);
  await tapXY(sbtn.cx, sbtn.cy);
  await sleep(1800);

  d = await dumpNow();
  if (!d.DUMP || !existsSync(d.DUMP)) fail("dump_search");
  xml = readFileSync(d.DUMP, "utf8");
  let ix = 520;
  let iy = 160;
  const edit0 = findEditText(xml);
  if (edit0) {
    ix = edit0.x;
    iy = edit0.y;
  } else {
    const tm = findLabel(xml, [/搜索/]);
    if (tm && tm.cy < 300) {
      ix = tm.cx;
      iy = tm.cy;
    }
  }
  console.log(`INPUT_XY=${ix},${iy}`);
  r = await runOps(
    [
      "ops/input-text.mjs",
      "--alias",
      alias,
      "--text",
      user,
      "--x",
      String(ix),
      "--y",
      String(iy),
      "--enter",
      "--ssh",
      ssh,
    ],
    60000,
  );
  if (r.code !== 0) fail("input_user", { DETAIL: r.out.slice(0, 160) });
  await sleep(3000);

  // switch to 用户 tab
  d = await dumpNow();
  if (!d.DUMP || !existsSync(d.DUMP)) fail("dump_results");
  xml = readFileSync(d.DUMP, "utf8");
  let userTab = findLabel(xml, [/^用户$/]);
  if (userTab) {
    console.log(`USER_TAB=${userTab.cx},${userTab.cy}`);
    await tapXY(userTab.cx, userTab.cy);
    await sleep(2200);
    d = await dumpNow();
    if (d.DUMP && existsSync(d.DUMP)) xml = readFileSync(d.DUMP, "utf8");
  } else {
    console.log(`WARN=no_user_tab`);
  }

  // find user row containing name
  const nodes = allNodes(xml);
  let hit = nodes.find((n) => n.text === user || n.desc === user);
  if (!hit) hit = nodes.find((n) => (n.text && n.text.includes(user)) || (n.desc && n.desc.includes(user)));
  // also partial
  if (!hit) {
    const short = user.slice(0, 4);
    hit = nodes.find((n) => n.text && n.text.includes(short) && n.cy > 300 && n.cy < 2000);
  }
  if (!hit) {
    const texts = nodes
      .filter((n) => n.text && n.cy > 280)
      .map((n) => `${n.text}@${n.cx},${n.cy}`)
      .slice(0, 30);
    fail("user_not_found", { TEXTS: texts.join("|") });
  }
  // tap left side of row (avatar) — if text node, go left
  let tx = hit.cx;
  let ty = hit.cy;
  if (hit.cx > 400) tx = 160;
  // prefer clickable parent-ish: clickable node covering same y
  const rowClick = nodes
    .filter((n) => n.clickable && Math.abs(n.cy - hit.cy) < 80 && n.w > 400)
    .sort((a, b) => a.cy - b.cy)[0];
  if (rowClick) {
    tx = Math.min(rowClick.cx, 200);
    ty = rowClick.cy;
  }
  console.log(`USER_HIT=${(hit.text || hit.desc).slice(0, 40)}@${hit.cx},${hit.cy}`);
  console.log(`USER_TAP=${tx},${ty}`);
  await tapXY(tx, ty);
  await sleep(2800);

  let f = await focusNow();
  console.log(`FOCUS_PROFILE=${f.FOCUS || ""}`);
  d = await dumpNow();
  if (!d.DUMP || !existsSync(d.DUMP)) fail("dump_profile");
  xml = readFileSync(d.DUMP, "utf8");
  // confirm name on profile
  const onProfile =
    xml.includes(user) ||
    allNodes(xml).some((n) => (n.text && n.text.includes(user.slice(0, 3))) || (n.desc && n.desc.includes(user.slice(0, 3))));
  console.log(`PROFILE_NAME_MATCH=${onProfile ? "yes" : "maybe"}`);

  let dmBtn = findLabel(xml, [/^发私信$/, /发私信/, /^私信$/]);
  if (!dmBtn) {
    await runOps(["ops/swipe.mjs", "--alias", alias, "--up", "--ssh", ssh], 20000);
    await sleep(1000);
    d = await dumpNow();
    if (d.DUMP && existsSync(d.DUMP)) {
      xml = readFileSync(d.DUMP, "utf8");
      dmBtn = findLabel(xml, [/^发私信$/, /发私信/, /^私信$/]);
    }
  }
  if (!dmBtn) {
    const labels = allNodes(xml)
      .filter((n) => n.text || n.desc)
      .map((n) => n.text || n.desc)
      .filter((t) => /私信|关注|粉丝|获赞|消息|笔记/.test(t))
      .slice(0, 25);
    fail("dm_btn_missing", { LABELS: labels.join("|"), FOCUS: f.FOCUS || "" });
  }
  console.log(`DM_BTN=${dmBtn.matched}@${dmBtn.cx},${dmBtn.cy}`);
  await tapXY(dmBtn.cx, dmBtn.cy);
  await sleep(2500);

  f = await focusNow();
  console.log(`FOCUS_DM=${f.FOCUS || ""}`);
  d = await dumpNow();
  if (!d.DUMP || !existsSync(d.DUMP)) fail("dump_dm");
  xml = readFileSync(d.DUMP, "utf8");
  let edit = findEditText(xml);
  let send = findSendBtn(xml) || findLabel(xml, [/^发送$/]);
  console.log(`DM_EDIT=${edit ? `${edit.x},${edit.y}` : ""}`);
  console.log(`DM_EDIT_HINT=${(edit?.text || "").slice(0, 40)}`);
  console.log(`DM_SEND=${send ? `${send.cx || send.x},${send.cy || send.y}` : ""}`);
  if (!edit && !send && !/Chat|im|message/i.test(f.FOCUS || "")) {
    fail("dm_not_open", { FOCUS: f.FOCUS || "" });
  }

  // type
  const ex = edit?.x ?? 500;
  const ey = edit?.y ?? 2150;
  r = await runOps(
    [
      "ops/input-text.mjs",
      "--alias",
      alias,
      "--text",
      text,
      "--x",
      String(ex),
      "--y",
      String(ey),
      "--clear-first",
      "--keep-ime",
      "--ssh",
      ssh,
    ],
    60000,
  );
  if (r.code !== 0) fail("input_dm", { DETAIL: r.out.slice(0, 160) });
  console.log(`INPUT=ok`);
  await sleep(1200);
  d = await dumpNow();
  xml = d.DUMP && existsSync(d.DUMP) ? readFileSync(d.DUMP, "utf8") : "";
  edit = findEditText(xml);
  console.log(`DM_EDIT_AFTER=${(edit?.text || "").slice(0, 60)}`);
  const landed = (edit?.text || "").includes(text) || xml.includes(text);
  if (!landed) console.log(`WARN=text_maybe_not_landed`);

  if (!doSend) {
    console.log(`DM_USER=ok`);
    console.log(`MODE=typed-no-send`);
    console.log(`ALIAS=${alias}`);
    process.exit(0);
  }

  send = findSendBtn(xml) || findLabel(xml, [/^发送$/]);
  if (!send) fail("send_missing");
  console.log(`SEND_TAP=${send.cx || send.x},${send.cy || send.y}`);
  await tapXY(send.cx || send.x, send.cy || send.y);
  await sleep(2500);
  d = await dumpNow();
  xml = d.DUMP && existsSync(d.DUMP) ? readFileSync(d.DUMP, "utf8") : "";
  const verified = xml.includes(text);
  // after send, edit may clear
  const edit3 = findEditText(xml);
  const cleared = edit3 && !(edit3.text || "").includes(text);
  console.log(`VERIFY=${verified ? "text-in-dump" : cleared ? "input-cleared" : "tapped-send"}`);
  console.log(`DM_USER=ok`);
  console.log(`MODE=sent`);
  console.log(`ALIAS=${alias}`);
  process.exit(0);
}

main().catch((e) => {
  console.log(`DM_USER=fail`);
  console.log(`REASON=exception`);
  console.log(`DETAIL=${String(e.message || e).slice(0, 300)}`);
  console.log(`ALIAS=${alias}`);
  process.exit(4);
});
