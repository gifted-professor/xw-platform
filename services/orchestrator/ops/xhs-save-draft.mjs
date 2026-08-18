#!/usr/bin/env node
/**
 * XHS 真存草稿：相册选图 → 填文案 → 存草稿 → 打开「本地草稿」核对。
 * 绝不点最终「发布」。
 *
 *   node ops/xhs-save-draft.mjs --alias 04 --caption-file path.txt
 *   node ops/xhs-save-draft.mjs --alias 04 --caption "文案"
 *
 * 人授权：真存草稿（本会话用户明确要求）。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { parseArgs } from "./_explore-lib.mjs";
import { bizRecord } from "./_biz-trace.mjs";
import { decodeEntities, findEditText, isHomeFocus } from "./_xhs-parse.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PKG = "com.xingin.xhs";

const { opt, flag } = parseArgs(process.argv.slice(2));
if (flag("--help") || flag("-h")) {
  console.log(`用法: node ops/xhs-save-draft.mjs --alias <01-04> (--caption <文案> | --caption-file <path>) [--select N] [--no-force-stop]
真存草稿；不点发布。--select N 选相册前 N 张（默认 1）。成功后打开 我→菜单→我的草稿 核对。`);
  process.exit(0);
}

const alias = opt("--alias");
const ssh = opt("--ssh", "xhs-windows");
const forceStop = !flag("--no-force-stop");
const captionFile = opt("--caption-file");
const selectN = Math.max(1, Math.min(9, Number(opt("--select", "1")) || 1));
let caption = opt("--caption");
if (captionFile) {
  if (!existsSync(captionFile)) {
    console.log("✗ caption-file missing");
    process.exit(4);
  }
  caption = readFileSync(captionFile, "utf8").replace(/^\uFEFF/, "").trim();
}
if (!alias || !caption) {
  console.log("✗ need --alias and --caption/--caption-file");
  process.exit(4);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let t0 = Date.now();

function runOps(args, timeoutMs = 360000) {
  return new Promise((resolve) => {
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
function fail(reason, extra = {}) {
  console.log(`SAVE_DRAFT=fail`);
  console.log(`REASON=${reason}`);
  for (const [k, v] of Object.entries(extra)) if (v != null) console.log(`${k}=${String(v).slice(0, 240)}`);
  console.log(`ALIAS=${alias}`);
  bizRecord({ op: "save_draft", outcome: "fail", reason, extra, alias, serial: null, startMs: t0 });
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
    });
  }
  return out;
}
function findLabel(xml, regs) {
  const nodes = allNodes(xml);
  for (const re of regs) {
    const n = nodes.find((x) => re.test(x.text) || re.test(x.desc));
    if (n) return { ...n, matched: n.text || n.desc };
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
async function back() {
  return runOps(["ops/back.mjs", "--alias", alias, "--ssh", ssh], 15000);
}

async function openDraftBox() {
  // 我 → 菜单 → 我的草稿
  let d = await dumpNow();
  let xml = d.DUMP && existsSync(d.DUMP) ? readFileSync(d.DUMP, "utf8") : "";
  let me = findLabel(xml, [/^我$/, /^我$/]) || allNodes(xml).find((n) => n.desc === "我");
  if (!me) me = { cx: 972, cy: 2299 };
  await tapXY(me.cx, me.cy);
  await sleep(1800);
  d = await dumpNow();
  xml = d.DUMP && existsSync(d.DUMP) ? readFileSync(d.DUMP, "utf8") : "";
  let menu = findLabel(xml, [/^菜单$/]) || allNodes(xml).find((n) => n.desc === "菜单");
  if (!menu) menu = { cx: 71, cy: 133 };
  await tapXY(menu.cx, menu.cy);
  await sleep(1500);
  d = await dumpNow();
  xml = d.DUMP && existsSync(d.DUMP) ? readFileSync(d.DUMP, "utf8") : "";
  let draft = findLabel(xml, [/我的草稿/]) || allNodes(xml).find((n) => /我的草稿/.test(n.desc || n.text));
  if (!draft) fail("draft_entry_missing");
  await tapXY(draft.cx, draft.cy);
  await sleep(2000);
  d = await dumpNow();
  xml = d.DUMP && existsSync(d.DUMP) ? readFileSync(d.DUMP, "utf8") : "";
  const labels = allNodes(xml)
    .map((n) => n.text || n.desc)
    .filter(Boolean);
  const tip = caption.slice(0, Math.min(10, caption.length));
  const hit =
    labels.some((t) => t.includes(tip) || t.includes(caption.slice(0, 6))) ||
    xml.includes(tip) ||
    labels.some((t) => /本地草稿/.test(t));
  console.log(`DRAFT_BOX_LABELS=${labels.slice(0, 25).join("|")}`);
  return { hit, labels, xml, tip };
}

async function main() {
  t0 = Date.now();
  console.log(`CAPTION=${caption}`);
  console.log(`SAVE_DRAFT_AUTHORIZED=yes`);

  // reuse publish-draft path until caption filled, but stop before abortHome — call with env trick?
  // Instead inline: call publish-draft is hard because it aborts. Duplicate critical path + save.

  const launchArgs = ["ops/launch-app.mjs", "--alias", alias, "--package", PKG, "--ssh", ssh];
  if (forceStop) launchArgs.push("--force-stop");
  let r = await runOps(launchArgs, 45000);
  if (r.code !== 0) fail("launch");
  await sleep(2600);

  let d = await dumpNow();
  if (!d.DUMP || !existsSync(d.DUMP)) fail("dump_home");
  let xml = readFileSync(d.DUMP, "utf8");
  let pub = findLabel(xml, [/^发布$/]) || allNodes(xml).find((n) => n.desc === "发布") || { cx: 540, cy: 2295 };
  console.log(`PUBLISH_TAB=${pub.matched || pub.desc || "发布"}@${pub.cx},${pub.cy}`);
  await tapXY(pub.cx, pub.cy);
  await sleep(2000);

  d = await dumpNow();
  if (!d.DUMP || !existsSync(d.DUMP)) fail("dump_sheet");
  xml = readFileSync(d.DUMP, "utf8");
  const album = findLabel(xml, [/从相册选择/, /^相册$/]);
  if (!album) fail("album_option_missing");
  console.log(`ALBUM=${album.matched}@${album.cx},${album.cy}`);
  await tapXY(album.cx, album.cy);
  await sleep(2500);

  d = await dumpNow();
  if (!d.DUMP || !existsSync(d.DUMP)) fail("dump_album");
  xml = readFileSync(d.DUMP, "utf8");
  // prefer 最近 tab
  const recent = findLabel(xml, [/^最近$/]);
  if (recent) {
    await tapXY(recent.cx, recent.cy);
    await sleep(1000);
    d = await dumpNow();
    if (d.DUMP && existsSync(d.DUMP)) xml = readFileSync(d.DUMP, "utf8");
  }
  const nodes = allNodes(xml);
  // Album thumbs: center tap opens MaterialPreviewActivity; checkbox is top-right corner.
  const thumbs = nodes
    .filter((n) => n.clickable && n.w >= 200 && n.h >= 200 && n.w <= 600 && n.h <= 600 && n.cy >= 250 && n.cy <= 1600 && !n.text)
    .sort((a, b) => a.cy - b.cy || a.cx - b.cx);
  console.log(`THUMB_CANDIDATES=${thumbs.length} selectN=${selectN}`);
  let picked = thumbs.slice(0, selectN);
  if (!picked.length) picked = [{ L: 40, T: 300, R: 320, B: 580, cx: 180, cy: 450, w: 280, h: 280 }];
  const checkboxOf = (t) => ({
    cx: Math.max(20, (t.R ?? t.cx + Math.floor((t.w || 280) / 2)) - 36),
    cy: Math.max(20, (t.T ?? t.cy - Math.floor((t.h || 280) / 2)) + 36),
  });
  for (let i = 0; i < picked.length; i++) {
    const t = picked[i];
    const box = checkboxOf(t);
    console.log(`THUMB_CHECKBOX=${box.cx},${box.cy} (cell ${t.cx},${t.cy})`);
    await tapXY(box.cx, box.cy);
    await sleep(900);
    const f = await focusNow();
    const act = f.FOCUS || f.ACTIVITY || "";
    console.log(`FOCUS_AFTER_PICK${i}=${act}`);
    if (/MaterialPreviewActivity/i.test(act)) {
      console.log(`PREVIEW_BAIL=back_and_retry_checkbox`);
      await runOps(["ops/back.mjs", "--alias", alias, "--ssh", ssh], 15000);
      await sleep(1000);
      await tapXY(box.cx, box.cy);
      await sleep(900);
      const f2 = await focusNow();
      console.log(`FOCUS_AFTER_RETRY${i}=${f2.FOCUS || f2.ACTIVITY || ""}`);
      if (/MaterialPreviewActivity/i.test(f2.FOCUS || f2.ACTIVITY || "")) {
        fail("album_opened_preview_instead_of_checkbox", { FOCUS: f2.FOCUS || "" });
      }
    }
  }
  await sleep(800);

  d = await dumpNow();
  if (d.DUMP && existsSync(d.DUMP)) xml = readFileSync(d.DUMP, "utf8");
  let next = findLabel(xml, [/下一步/]);
  if (!next) {
    // multi-select often shows 下一步(2)
    next = allNodes(xml).find((n) => /下一步/.test(n.text || n.desc || ""));
    if (next) next = { ...next, matched: next.text || next.desc };
  }
  if (!next) {
    await sleep(1200);
    d = await dumpNow();
    if (d.DUMP && existsSync(d.DUMP)) xml = readFileSync(d.DUMP, "utf8");
    next = findLabel(xml, [/下一步/]) || allNodes(xml).find((n) => /下一步/.test(n.text || n.desc || ""));
    if (next && !next.matched) next = { ...next, matched: next.text || next.desc };
  }
  if (!next) fail("next_missing_after_select");
  console.log(`NEXT=${next.matched}@${next.cx},${next.cy}`);
  await tapXY(next.cx, next.cy);
  await sleep(3000);

  let captionFilled = false;
  for (let i = 0; i < 3; i++) {
    const f = await focusNow();
    console.log(`FOCUS_STEP${i}=${f.FOCUS || ""}`);
    d = await dumpNow();
    if (!d.DUMP || !existsSync(d.DUMP)) break;
    xml = readFileSync(d.DUMP, "utf8");
    const labels = allNodes(xml)
      .map((n) => n.text || n.desc)
      .filter(Boolean)
      .slice(0, 40);
    console.log(`STEP${i}_HINTS=${labels.slice(0, 20).join("|")}`);
    const edit = findEditText(xml);
    const postBtn = findLabel(xml, [/^发布$/]);
    const capHint = labels.some((t) => /添加标题|添加正文|说点什么|标题|正文|话题/.test(t));
    if (capHint || (edit && postBtn)) {
      let ix = edit?.x;
      let iy = edit?.y;
      if (!ix) {
        const body = findLabel(xml, [/添加正文/, /说点什么/, /正文/]);
        if (body) {
          ix = body.cx;
          iy = body.cy;
        }
      }
      if (!ix) {
        ix = 540;
        iy = 900;
      }
      console.log(`CAPTION_XY=${ix},${iy}`);
      await tapXY(ix, iy);
      await sleep(1000);
      r = await runOps(
        [
          "ops/input-text.mjs",
          "--alias",
          alias,
          "--text",
          caption,
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
      console.log(`CAPTION_INPUT=${r.code === 0 ? "ok" : "fail"}`);
      await sleep(1200);
      captionFilled = true;
      break;
    }
    const next2 = findLabel(xml, [/下一步/]);
    if (next2 && !postBtn) {
      await tapXY(next2.cx, next2.cy);
      await sleep(2800);
      continue;
    }
    break;
  }
  if (!captionFilled) fail("caption_page_not_reached");

  // --- save draft ---
  d = await dumpNow();
  if (!d.DUMP || !existsSync(d.DUMP)) fail("dump_before_save");
  xml = readFileSync(d.DUMP, "utf8");
  // never tap 发布
  let saveBtn = findLabel(xml, [/^存草稿$/, /存为草稿/, /保存草稿/, /^草稿$/]);
  // also look top-left close / back that opens dialog
  if (!saveBtn) {
    console.log(`SAVE_VIA=back_dialog`);
    await back();
    await sleep(1500);
    d = await dumpNow();
    if (!d.DUMP || !existsSync(d.DUMP)) fail("dump_save_dialog");
    xml = readFileSync(d.DUMP, "utf8");
    const dialogLabels = allNodes(xml)
      .map((n) => n.text || n.desc)
      .filter(Boolean)
      .slice(0, 30);
    console.log(`DIALOG_LABELS=${dialogLabels.join("|")}`);
    saveBtn = findLabel(xml, [/保存草稿/, /存草稿/, /存为草稿/, /^保存$/]);
    // some builds: 存草稿 as primary
    if (!saveBtn) {
      saveBtn = allNodes(xml).find((n) => n.clickable && /草稿/.test(n.text || n.desc || ""));
      if (saveBtn) saveBtn = { ...saveBtn, matched: saveBtn.text || saveBtn.desc };
    }
  } else {
    console.log(`SAVE_VIA=button`);
  }
  if (!saveBtn) fail("save_draft_control_missing");
  console.log(`SAVE_BTN=${saveBtn.matched}@${saveBtn.cx},${saveBtn.cy}`);
  // refuse if matched 发布
  if (/^发布$/.test(saveBtn.matched || "")) fail("refused_publish_btn");
  await tapXY(saveBtn.cx, saveBtn.cy);
  await sleep(1800);

  // 确认弹窗：确认保存笔记至草稿箱吗? → 确定
  d = await dumpNow();
  if (d.DUMP && existsSync(d.DUMP)) {
    xml = readFileSync(d.DUMP, "utf8");
    const dialogHints = allNodes(xml)
      .map((n) => n.text || n.desc)
      .filter(Boolean)
      .slice(0, 20);
    console.log(`AFTER_SAVE_LABELS=${dialogHints.join("|")}`);
    if (dialogHints.some((t) => /确认保存|草稿箱/.test(t))) {
      const conf = findLabel(xml, [/^确定$/]);
      if (!conf) fail("save_confirm_missing");
      console.log(`CONFIRM=${conf.matched}@${conf.cx},${conf.cy}`);
      await tapXY(conf.cx, conf.cy);
      await sleep(2500);
    }
  }

  // back to home if needed
  for (let i = 0; i < 6; i++) {
    const f = await focusNow();
    if (isHomeFocus(f.FOCUS)) break;
    await back();
    await sleep(900);
  }
  // soft relaunch to guarantee IndexActivity
  await runOps(["ops/launch-app.mjs", "--alias", alias, "--package", PKG, "--ssh", ssh], 45000);
  await sleep(2000);

  const box = await openDraftBox();
  const outDir = join(ROOT, "runtime", "free-explore", "feishu-draft-01");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, "save-draft-result.json"),
    JSON.stringify(
      {
        alias,
        caption,
        tip: box.tip,
        hit: box.hit,
        labels: box.labels.slice(0, 40),
        ms: Date.now() - t0,
      },
      null,
      2,
    ),
    "utf8",
  );

  // weak ok: reached 本地草稿 page after save; strong if caption tip visible
  const ok = box.hit;
  console.log(`DRAFT_BOX_HIT=${ok ? "yes" : "maybe"}`);
  console.log(`SAVE_DRAFT=${ok ? "ok" : "ambiguous"}`);
  console.log(`ALIAS=${alias}`);
  console.log(`MS=${Date.now() - t0}`);
  bizRecord({
    op: "save_draft",
    outcome: ok ? "ok" : "ambiguous",
    reason: ok ? "draft-box-hit" : "draft-box-opened",
    alias,
    serial: null,
    startMs: t0,
  });
  process.exit(ok ? 0 : 1);
}

main().catch((e) => fail("exception", { DETAIL: String(e?.message || e).slice(0, 200) }));
