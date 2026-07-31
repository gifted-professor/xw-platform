#!/usr/bin/env node
/**
 * Publish draft path: open publish → album → select 1 image → next → fill caption.
 * 默认不点最终发布；--publish 经人授权才点（不可逆动作，点一次不重试）。
 *
 *   node ops/xhs-publish-draft.mjs --alias 04
 *   node ops/xhs-publish-draft.mjs --alias 04 --caption "今天天气不错"
 *   node ops/xhs-publish-draft.mjs --alias 04 --caption "今天天气不错" --publish  # 真发布
 */
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./_explore-lib.mjs";
import { decodeEntities, findEditText, isHomeFocus } from "./_xhs-parse.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PKG = "com.xingin.xhs";

const { opt, flag } = parseArgs(process.argv.slice(2));
if (flag("--help") || flag("-h")) {
  console.log(`用法: node ops/xhs-publish-draft.mjs --alias <01-04> [--caption 文案] [--publish]
选1图+填文案，默认不点发布；--publish 经人授权才点。`);
  process.exit(0);
}

const alias = opt("--alias");
const caption = opt("--caption") || "自动化草稿测试，不会发布";
const ssh = opt("--ssh", "xhs-windows");
const forceStop = !flag("--no-force-stop");
const doPublish = flag("--publish");
if (!alias) {
  console.log("✗ need --alias");
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
  console.log(`PUBLISH_DRAFT=fail`);
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
      selected: /selected="true"/.test(tag),
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

async function abortHome() {
  for (let i = 0; i < 5; i++) {
    await runOps(["ops/back.mjs", "--alias", alias, "--ssh", ssh], 15000);
    await sleep(800);
    const f = await focusNow();
    if (isHomeFocus(f.FOCUS)) return true;
  }
  return false;
}

async function main() {
  console.log(`CAPTION=${caption}`);
  const launchArgs = ["ops/launch-app.mjs", "--alias", alias, "--package", PKG, "--ssh", ssh];
  if (forceStop) launchArgs.push("--force-stop");
  let r = await runOps(launchArgs, 45000);
  if (r.code !== 0) fail("launch");
  await sleep(2600);

  // publish tab
  let d = await dumpNow();
  if (!d.DUMP || !existsSync(d.DUMP)) fail("dump_home");
  let xml = readFileSync(d.DUMP, "utf8");
  let pub = findLabel(xml, [/^发布$/, /desc.*发布/]) || { cx: 540, cy: 2295, matched: "fallback" };
  const n0 = allNodes(xml).find((n) => n.desc === "发布" || n.text === "发布");
  if (n0) pub = { ...n0, matched: n0.desc || n0.text };
  console.log(`PUBLISH_TAB=${pub.matched}@${pub.cx},${pub.cy}`);
  await tapXY(pub.cx, pub.cy);
  await sleep(2000);

  d = await dumpNow();
  if (!d.DUMP || !existsSync(d.DUMP)) fail("dump_sheet");
  xml = readFileSync(d.DUMP, "utf8");
  const album = findLabel(xml, [/从相册选择/, /^相册$/]);
  if (!album) fail("album_option_missing", { LABELS: allNodes(xml).map((n) => n.text || n.desc).filter(Boolean).slice(0, 20).join("|") });
  console.log(`ALBUM=${album.matched}@${album.cx},${album.cy}`);
  await tapXY(album.cx, album.cy);
  await sleep(2500);

  let f = await focusNow();
  console.log(`FOCUS_ALBUM=${f.FOCUS || ""}`);
  d = await dumpNow();
  if (!d.DUMP || !existsSync(d.DUMP)) fail("dump_album");
  xml = readFileSync(d.DUMP, "utf8");
  const hints = allNodes(xml)
    .filter((n) => n.text || n.desc)
    .map((n) => n.text || n.desc)
    .filter((t) => /相册|照片|视频|下一步|所有|最近|取消|预览/.test(t))
    .slice(0, 20);
  console.log(`ALBUM_HINTS=${[...new Set(hints)].join("|")}`);

  // select first image thumbnail: large clickable grid cell in upper area
  const nodes = allNodes(xml);
  const thumbs = nodes
    .filter(
      (n) =>
        n.clickable &&
        n.w >= 200 &&
        n.h >= 200 &&
        n.w <= 600 &&
        n.h <= 600 &&
        n.cy >= 250 &&
        n.cy <= 1600 &&
        !n.text,
    )
    .sort((a, b) => a.cy - b.cy || a.cx - b.cx);
  // sometimes checkbox is corner of thumb — prefer top-left-ish first grid
  let thumb = thumbs[0];
  if (!thumb) {
    // fallback percentage first cell
    thumb = { cx: 180, cy: 450, matched: "fallback-grid" };
  }
  console.log(`THUMB_TAP=${thumb.cx},${thumb.cy} countCandidates=${thumbs.length}`);
  await tapXY(thumb.cx, thumb.cy);
  await sleep(1500);

  d = await dumpNow();
  if (d.DUMP && existsSync(d.DUMP)) {
    xml = readFileSync(d.DUMP, "utf8");
  }
  let next = findLabel(xml, [/^下一步$/, /下一步\s*\(?\d+\)?/]);
  // sometimes 下一步(1)
  if (!next) {
    next = allNodes(xml).find((n) => /下一步/.test(n.text || n.desc || ""));
    if (next) next = { ...next, matched: next.text || next.desc };
  }
  if (!next) {
    // try select again lower
    if (thumbs[1]) {
      await tapXY(thumbs[1].cx, thumbs[1].cy);
      await sleep(1200);
      d = await dumpNow();
      if (d.DUMP && existsSync(d.DUMP)) xml = readFileSync(d.DUMP, "utf8");
      next = findLabel(xml, [/下一步/]);
    }
  }
  if (!next) fail("next_missing_after_select", { HINTS: hints.join("|") });
  console.log(`NEXT=${next.matched}@${next.cx},${next.cy}`);
  await tapXY(next.cx, next.cy);
  await sleep(3000);

  // may land on edit/filter page with another 下一步
  // 3 轮：相册→(滤镜)→文案 偶尔需要两次 下一步，22222 排队致 tap 丢失时多给一拍
  for (let i = 0; i < 3; i++) {
    f = await focusNow();
    console.log(`FOCUS_STEP${i}=${f.FOCUS || ""}`);
    d = await dumpNow();
    if (!d.DUMP || !existsSync(d.DUMP)) break;
    xml = readFileSync(d.DUMP, "utf8");
    const labels = allNodes(xml)
      .filter((n) => n.text || n.desc)
      .map((n) => n.text || n.desc)
      .filter(Boolean)
      .slice(0, 30);
    console.log(`STEP${i}_HINTS=${labels.slice(0, 20).join("|")}`);

    // caption page markers
    const capHint = labels.some((t) => /添加标题|添加正文|说点什么|标题|正文|话题/.test(t));
    const edit = findEditText(xml);
    const postBtn = findLabel(xml, [/^发布$/]);
    if (postBtn) console.log(`POST_BTN_LOCATED_NOT_TAPPED=${postBtn.cx},${postBtn.cy}`);

    if (capHint || (edit && postBtn) || labels.some((t) => /添加正文|添加标题/.test(t))) {
      // fill caption
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
      // tap field first
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
      d = await dumpNow();
      let has = false;
      let post2 = null;
      if (d.DUMP && existsSync(d.DUMP)) {
        xml = readFileSync(d.DUMP, "utf8");
        const e2 = findEditText(xml);
        console.log(`CAPTION_AFTER=${(e2?.text || "").slice(0, 80)}`);
        has = xml.includes(caption) || (e2?.text || "").includes(caption.slice(0, 6));
        console.log(`CAPTION_LANDED=${has ? "yes" : "maybe"}`);
        post2 = findLabel(xml, [/^发布$/]);
        if (post2) console.log(`POST_BTN_STILL_NOT_TAPPED=${post2.cx},${post2.cy}`);
      }

      if (doPublish) {
        // 发布=不可逆外部动作：caption 非空 + 已落 + 按钮在 才点；点一次不重试。
        if (!caption) { console.log(`PUBLISHED=no`); fail("publish-no-caption"); }
        if (!post2) { console.log(`PUBLISHED=no`); fail("publish-btn-missing"); }
        if (!has) { console.log(`PUBLISHED=no`); fail("publish-caption-not-landed"); }
        console.log(`ABOUT_TO_PUBLISH=yes`);
        console.log(`PUBLISH_BTN=${post2.cx},${post2.cy}`);
        console.log(`CAPTION=${caption.slice(0, 60)}`);
        await tapXY(post2.cx, post2.cy);
        await sleep(3000);
        // verify：发布后离开文案页（无 EditText + 无「发布」按钮）或回到主页
        const fv = await focusNow();
        const dv = await dumpNow();
        let published = isHomeFocus(fv.FOCUS);
        if (!published && dv.DUMP && existsSync(dv.DUMP)) {
          const vx = readFileSync(dv.DUMP, "utf8");
          published = !findEditText(vx) && !findLabel(vx, [/^发布$/]);
        }
        console.log(`PUBLISHED=${published ? "yes" : "no"}`);
        console.log(`POST_FOCUS=${fv.FOCUS || ""}`);
        await abortHome();
        if (!published) fail("publish-not-confirmed");
        console.log(`PUBLISH=ok`);
        console.log(`ALIAS=${alias}`);
        process.exit(0);
      }

      console.log(`PUBLISHED=no`);
      console.log(`STAGE=caption-filled`);
      // 默认不点发布，留待人授权 --publish
      await abortHome();
      console.log(`PUBLISH_DRAFT=ok`);
      console.log(`ALIAS=${alias}`);
      process.exit(0);
    }

    // else maybe filter page — tap 下一步 again if present, never 发布
    const next2 = findLabel(xml, [/^下一步/, /下一步/]);
    if (next2 && !postBtn) {
      const focusBefore = f.FOCUS;
      console.log(`NEXT_AGAIN=${next2.cx},${next2.cy}`);
      await tapXY(next2.cx, next2.cy);
      await sleep(3000);
      // lost-tap retry：22222 排队偶发 tap 丢失，页没动就重点一次
      const f2 = await focusNow();
      if (f2.FOCUS === focusBefore) {
        console.log(`NEXT_AGAIN_RETRY=${next2.cx},${next2.cy}`);
        await tapXY(next2.cx, next2.cy);
        await sleep(3000);
      }
      continue;
    }
    // if only 发布 visible without caption markers, stop safely
    if (postBtn) {
      console.log(`STAGE=post-btn-visible-no-caption-fill`);
      console.log(`PUBLISHED=no`);
      await abortHome();
      console.log(`PUBLISH_DRAFT=ok`);
      console.log(`ALIAS=${alias}`);
      process.exit(0);
    }
    break;
  }

  console.log(`STAGE=unknown-after-album`);
  console.log(`PUBLISHED=no`);
  await abortHome();
  fail("caption_page_not_reached");
}

main().catch((e) => {
  console.log(`PUBLISH_DRAFT=fail`);
  console.log(`REASON=exception`);
  console.log(`DETAIL=${String(e.message || e).slice(0, 300)}`);
  console.log(`ALIAS=${alias}`);
  process.exit(4);
});
