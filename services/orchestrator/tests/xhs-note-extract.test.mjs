/**
 * xhs-note-extract.test.mjs — offline tests for the note-detail semantic
 * extractor (xhs.note.record.v1/v2). Hand-written dump XML plus one real
 * live-captured dump fixture; no device I/O.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  allNodes,
  extractNoteRecord,
  extractNoteRecordV2,
  looksLikeNoteDetail,
  parseCommentRows,
  parseCountText,
  parsePostTime,
} from "../scripts/lib/xhs-note-extract.mjs";
import { spawnSync } from "node:child_process";

const FIXTURE_LIVE = new URL("./fixtures/xhs-note-detail-live-04.xml", import.meta.url);

function node({ text = "", desc = "", rid = "", bounds, clickable = false }) {
  return `<node index="0" text="${text}" content-desc="${desc}" resource-id="${rid}" ` +
    `class="android.widget.TextView" clickable="${clickable}" enabled="true" bounds="${bounds}"/>`;
}

/** Realistic image-note detail layout (1080x2400). */
const DETAIL_XML =
  '<hierarchy><node bounds="[0,0][1080,2400]"/>' +
  node({ text: "", desc: "返回", bounds: "[20,100][100,180]" }) +
  node({ text: "小岩", bounds: "[140,120][300,180]" }) +
  node({ text: "关注", bounds: "[900,120][1020,180]" }) +
  node({ text: "3天前", bounds: "[140,190][260,240]" }) +
  node({ text: "新手攀岩入门：三条室内抱石路线全讲解", bounds: "[40,540][960,700]" }) +
  node({ text: "第一条适合第一次进馆的朋友，重心贴墙慢慢来；第二条练侧拉；第三条练换手。装备清单见评论区。", rid: "com.xingin.xhs:id/content_tv", bounds: "[40,720][1000,900]" }) +
  node({ text: "共 12 条评论", bounds: "[40,1000][240,1050]" }) +
  node({ text: "攀岩小白", bounds: "[40,1100][160,1150]" }) +
  node({ text: "这条路线讲解得非常清楚，收藏了", bounds: "[40,1160][600,1220]" }) +
  node({ text: "2天前", bounds: "[40,1230][120,1270]" }) +
  node({ text: "回复", bounds: "[700,1160][660,1200]" }) +
  node({ text: "", desc: "点赞 1.2万", bounds: "[60,2200][160,2300]" }) +
  node({ text: "", desc: "收藏 890", bounds: "[260,2200][360,2300]" }) +
  node({ text: "", desc: "评论 12", bounds: "[460,2200][560,2300]" }) +
  node({ text: "说点什么", desc: "评论框", bounds: "[600,2210][1000,2290]" }) +
  "</hierarchy>";

test("parseCountText handles plain, 万, and missing suffixes", () => {
  assert.equal(parseCountText("点赞 123"), 123);
  assert.equal(parseCountText("点赞 1.2万"), 12000);
  assert.equal(parseCountText("已收藏 890"), 890);
  assert.equal(parseCountText("评论"), null);
  assert.equal(parseCountText(""), null);
});

test("parsePostTime splits date / timeOfDay / location from live meta strings", () => {
  assert.deepEqual(
    { ...parsePostTime("昨天 下午4:41河北"), raw: undefined },
    { date: "昨天", timeOfDay: "下午4:41", location: "河北", raw: undefined },
  );
  assert.deepEqual(
    { ...parsePostTime("08-27河南"), raw: undefined },
    { date: "08-27", timeOfDay: null, location: "河南", raw: undefined },
  );
  assert.deepEqual(
    { ...parsePostTime("08-15 北京"), raw: undefined },
    { date: "08-15", timeOfDay: null, location: "北京", raw: undefined },
  );
  assert.deepEqual(
    { ...parsePostTime("3天前"), raw: undefined },
    { date: "3天前", timeOfDay: null, location: null, raw: undefined },
  );
  assert.equal(parsePostTime("").date, null);
});

test("extractNoteRecordV2 pulls title/author/body/postTime/interactions from the live 04 fixture", () => {
  const xml = readFileSync(FIXTURE_LIVE, "utf8");
  const r = extractNoteRecordV2(xml);
  assert.equal(r.schemaId, "xhs.note.record.v2");
  assert.equal(r.title, "有没有平价的推荐啊。");
  assert.equal(r.author, "阿兜兜");
  assert.match(r.body, /上学家里开销大/);
  assert.match(r.body, /#平替/);
  assert.deepEqual(r.postTime, {
    date: "昨天", timeOfDay: "下午4:41", location: "河北", raw: "昨天 下午4:41河北",
  });
  assert.equal(r.date, "昨天");
  assert.equal(r.interactions.likeCount, 24);
  assert.equal(r.interactions.collectCount, 7);
  assert.equal(r.interactions.commentCount, 140);
  // this capture never scrolled the comment panel — honest truncation
  assert.equal(r.comments.length, 0);
  assert.equal(r.commentTotal, 140);
  assert.equal(r.commentsTruncated, true);
  assert.match(r.sourceDumpHash, /^[0-9a-f]{64}$/);
  assert.match(r.noteFingerprint, /^[0-9a-f]{16}$/);
});

test("two captures of the same note share a fingerprint (dedupe key)", () => {
  const xml = readFileSync(FIXTURE_LIVE, "utf8");
  const a = extractNoteRecordV2(xml);
  const b = extractNoteRecordV2(xml.replace(/drawing-order="\d+"/, 'drawing-order="9"'));
  assert.equal(a.noteFingerprint, b.noteFingerprint);
  // a genuinely different note (different title+author) must differ
  const c = extractNoteRecordV2(xml.replace("阿兜兜", "别的作者"));
  assert.notEqual(a.noteFingerprint, c.noteFingerprint);
});

test("parseCommentRows extracts user/text/timeText/likes and drops chrome rows", () => {
  const xml =
    '<hierarchy><node bounds="[0,0][1080,2400]"/>' +
    node({ text: "共 2 条评论", bounds: "[40,1000][240,1050]" }) +
    node({ text: "攀岩小白", bounds: "[40,1100][160,1150]" }) +
    node({ text: "这条路线讲解得非常清楚，收藏了", bounds: "[40,1160][600,1220]" }) +
    node({ text: "2天前", bounds: "[40,1230][120,1270]" }) +
    node({ text: "99", bounds: "[980,1170][1010,1200]" }) +
    node({ text: "小张", bounds: "[40,1400][120,1450]" }) +
    node({ text: "请问装备哪里买的", bounds: "[40,1460][400,1500]" }) +
    node({ text: "09-02", bounds: "[40,1500][140,1540]" }) +
    node({ text: "说点什么...", desc: "评论框", bounds: "[600,2210][1000,2290]" }) +
    "</hierarchy>";
  const rows = parseCommentRows(allNodes(xml));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    user: "攀岩小白", text: "这条路线讲解得非常清楚，收藏了", timeText: "2天前", likes: 99, y: 1125,
  });
  assert.equal(rows[1].user, "小张");
  assert.equal(rows[1].text, "请问装备哪里买的");
  assert.equal(rows[1].timeText, "09-02");
});

test("v2 record carries visible comments when the panel is scrolled into view", () => {
  const withPanel = DETAIL_XML
    .replace(/<node index="0" text="回复"[^>]*\/>/, "")
    .replace('text="共 12 条评论"', 'text="共 1 条评论"')
    .replace('desc="评论 12"', 'desc="评论 1"');
  const r = extractNoteRecordV2(withPanel);
  assert.equal(r.comments.length, 1);
  assert.equal(r.comments[0].user, "攀岩小白");
  assert.equal(r.comments[0].text, "这条路线讲解得非常清楚，收藏了");
  assert.equal(r.comments[0].timeText, "2天前");
  assert.equal(r.commentsTruncated, false);
  // v1 shape stays compatible on the same core
  const v1 = extractNoteRecord(withPanel);
  assert.equal(v1.schemaId, "xhs.note.record.v1");
  assert.equal(v1.date, "3天前");
  assert.equal(v1.title, r.title);
});

test("missing fields are null, never thrown", () => {
  const sparse = '<hierarchy><node bounds="[0,0][1080,2400]"/>' +
    node({ text: "", desc: "点赞", bounds: "[60,2200][160,2300]" }) +
    "</hierarchy>";
  const r = extractNoteRecordV2(sparse);
  assert.equal(r.title, null);
  assert.equal(r.author, null);
  assert.equal(r.body, null);
  assert.equal(r.date, null);
  assert.deepEqual(r.interactions, {
    likeCount: null,
    likeState: "unliked",
    collectCount: null,
    commentCount: null,
  });
  assert.equal(r.commentsTruncated, false);
});

test("a media-marker dump without visible title does NOT pick the author as title", () => {
  // live 05 sample shape: image-only note, no title/body rows between media
  // and the related-search band; legacy top-band fallback must not fire
  const xml =
    '<hierarchy><node bounds="[0,0][1220,2664]"/>' +
    node({ text: "Qi柚子", rid: "com.xingin.xhs:id/nickNameTV", bounds: "[270,178][404,229]" }) +
    node({ text: "", desc: "图片,第1张,共1张,双指左划或右划即可查看更多内容", bounds: "[0,288][1220,1914]" }) +
    node({ text: "猜你想搜", bounds: "[120,2013][288,2075]" }) +
    node({ text: "阿迪达斯官网什么时候打折", bounds: "[321,2013][825,2075]" }) +
    node({ desc: "08-27河南", bounds: "[45,2132][965,2192]" }) +
    node({ text: "", desc: "点赞 30", bounds: "[623,2496][803,2664]" }) +
    node({ text: "", desc: "收藏 9", bounds: "[803,2496][1007,2664]" }) +
    node({ text: "", desc: "评论 229", bounds: "[1007,2496][1220,2664]" }) +
    "</hierarchy>";
  const r = extractNoteRecordV2(xml);
  assert.equal(r.title, null);
  assert.equal(r.author, "Qi柚子");
  assert.deepEqual({ ...r.postTime, raw: undefined }, {
    date: "08-27", timeOfDay: null, location: "河南", raw: undefined,
  });
  assert.equal(r.commentTotal, 229);
  assert.equal(r.commentsTruncated, true);
});

test("body is capped at maxBodyChars", () => {
  const long = "字".repeat(3000);
  const xml = '<hierarchy><node bounds="[0,0][1080,2400]"/>' +
    node({ text: "这里是一个标题", bounds: "[40,300][400,360]" }) +
    node({ text: long, bounds: "[40,540][1000,900]" }) +
    node({ text: "", desc: "点赞", bounds: "[60,2200][160,2300]" }) +
    "</hierarchy>";
  const r = extractNoteRecordV2(xml);
  assert.equal(r.title, "这里是一个标题");
  assert.equal(r.body.length, 2000);
});

test("looksLikeNoteDetail discriminates detail vs feed dumps", () => {
  assert.equal(looksLikeNoteDetail(DETAIL_XML), true);
  assert.equal(looksLikeNoteDetail(readFileSync(FIXTURE_LIVE, "utf8")), true);
  const feed =
    '<hierarchy><node bounds="[0,0][1080,2400]"/>' +
    node({ text: "", desc: "笔记 攀岩入门 来自小岩 123赞", bounds: "[40,400][500,900]" }) +
    "</hierarchy>";
  assert.equal(looksLikeNoteDetail(feed), false);
});

test("allNodes carries resource-id", () => {
  const nodes = allNodes(DETAIL_XML);
  const withRid = nodes.filter((n) => n.rid);
  assert.ok(withRid.length >= 1);
  assert.ok(withRid.some((n) => n.rid === "com.xingin.xhs:id/content_tv"));
});

// ---------------------------------------------------------------------------
// CLI end-to-end over a synthetic per-alias run tree
// ---------------------------------------------------------------------------

function buildFakeScanRoot(root) {
  const detail = readFileSync(FIXTURE_LIVE, "utf8");
  const feed =
    '<hierarchy><node bounds="[0,0][1080,2400]"/>' +
    node({ text: "", desc: "笔记 攀岩入门 来自小岩 123赞", bounds: "[40,400][500,900]" }) +
    "</hierarchy>";
  for (const [alias, runId, content] of [
    ["04", "run_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", detail],
    ["04", "run_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", feed],
    ["05", "run_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", detail], // same note, other device
    ["05", "run_cccccccccccccccccccccccccccccc", detail.replace("阿兜兜", "另一位作者")],
  ]) {
    const dir = join(root, alias, "runs", runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "dump-ui.xml"), content, "utf8");
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({
      runId, jobId: `job_${runId.slice(4, 12)}`, actorId: "agent:test",
      createdAt: "2026-09-02T08:00:00.000Z",
      routeDecision: { selectedDevice: { alias } },
    }), "utf8");
  }
}

function runCli(scanRoot, outRoot) {
  const cli = new URL("../ops/xhs-notes-extract.mjs", import.meta.url);
  const repoRoot = new URL("../..", import.meta.url);
  return spawnSync(process.execPath, [
    join(fileURLToPath(cli).replace(/\\/g, "/")),
    "--scan-root", scanRoot,
    "--out", outRoot,
  ], { cwd: fileURLToPath(repoRoot), encoding: "utf8" });
}

test("CLI scans run dirs, dedupes by fingerprint, writes the four output files", () => {
  const scanRoot = mkdtempSync(join(tmpdir(), "xhs-notes-scan-"));
  const outRoot = mkdtempSync(join(tmpdir(), "xhs-notes-out-"));
  try {
    buildFakeScanRoot(scanRoot);
    const result = runCli(scanRoot, outRoot);
    assert.equal(result.status, 0, `CLI failed: ${result.stdout}\n${result.stderr}`);

    const notes = readFileSync(join(outRoot, "notes.jsonl"), "utf8")
      .split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(notes.length, 2, "same note from 04+05 dedupes to one row");
    const main = notes.find((n) => n.author === "阿兜兜");
    assert.equal(main.seenRuns.length, 2);
    assert.deepEqual(main.seenRuns.map((s) => s.alias).sort(), ["04", "05"]);
    assert.equal(main.seenRuns[0].jobId, "job_aaaaaaaa");
    assert.equal(main.postTime.location, "河北");

    const runsIndex = readFileSync(join(outRoot, "runs-index.jsonl"), "utf8")
      .split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(runsIndex.length, 3, "every captured detail dump indexed once");

    const comments = readFileSync(join(outRoot, "comments.jsonl"), "utf8").trim();
    assert.equal(comments, "", "no visible comment rows in these captures");

    const summary = JSON.parse(readFileSync(join(outRoot, "summary.json"), "utf8"));
    assert.equal(summary.schemaId, "xhs.notes-extract.summary.v1");
    assert.equal(summary.totals.runDirs, 4);
    assert.equal(summary.totals.detailDumps, 3);
    assert.equal(summary.totals.skippedNonDetail, 1);
    assert.equal(summary.totals.uniqueNotes, 2);
    assert.equal(summary.totals.failed, 0);
  } finally {
    rmSync(scanRoot, { recursive: true, force: true });
    rmSync(outRoot, { recursive: true, force: true });
  }
});