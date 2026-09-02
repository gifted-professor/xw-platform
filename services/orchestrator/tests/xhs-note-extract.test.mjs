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
  commentFingerprint,
  extractNoteRecord,
  extractNoteRecordV2,
  extractScrolledDetail,
  looksLikeNoteDetail,
  mergeNoteRunFamily,
  parseCommentRows,
  parseCountText,
  parsePostTime,
  recipeRunDumpJobs,
} from "../scripts/lib/xhs-note-extract.mjs";
import { spawnSync } from "node:child_process";

const FIXTURE_LIVE = new URL("./fixtures/xhs-note-detail-live-04.xml", import.meta.url);
const FIXTURE_TOP = new URL("./fixtures/xhs-note-detail-top-live-04.xml", import.meta.url);
const FIXTURE_C1 = new URL("./fixtures/xhs-note-comments-c1-live-04.xml", import.meta.url);
const FIXTURE_C2 = new URL("./fixtures/xhs-note-comments-c2-live-04.xml", import.meta.url);

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
// Scrolled comment-panel extraction (probe rr_4d3a2df2, live 04 dumps)
// ---------------------------------------------------------------------------

test("extractScrolledDetail parses live c1 dump: 7 rows, no head, total from bottom bar", () => {
  const r = extractScrolledDetail(readFileSync(FIXTURE_C1, "utf8"));
  assert.equal(r.isScrolledDetail, true);
  assert.equal(r.commentTotal, 124);
  assert.equal(r.comments.length, 7);
  // first visible comment — user → body → time row with location+回复 → likes
  const first = r.comments[0];
  assert.equal(first.user, "合衬");
  assert.equal(first.text, "求推荐");
  assert.equal(first.timeText, "5天前 江苏 回复");
  assert.equal(first.likes, 3);
  // the "小红薯69CAEB62"/"咋入" pair is assigned by width, not by user-length
  assert.equal(r.comments[3].user, "小红薯69CAEB62");
  assert.equal(r.comments[3].text, "咋入");
  // sticky author bar + 说点什么 + 展开 N 条回复 never become rows
  assert.ok(r.comments.every((c) => c.user !== "喂你别哭了"));
  assert.ok(r.comments.every((c) => !/^说点什么/.test(c.text || "")));
});

test("extractScrolledDetail parses live c2 dump: 6 rows, deeper comments", () => {
  const r = extractScrolledDetail(readFileSync(FIXTURE_C2, "utf8"));
  assert.equal(r.isScrolledDetail, true);
  assert.equal(r.commentTotal, 124);
  assert.equal(r.comments.length, 6);
  assert.equal(r.comments[4].user, "乄困了就睡");
  assert.equal(r.comments[5].user, "午夜伤心玫瑰");
});

test("extractScrolledDetail on the unscrolled top dump reports scrolled=false and defers to v2", () => {
  const r = extractScrolledDetail(readFileSync(FIXTURE_TOP, "utf8"));
  // head "共 N 条评论" still present → not scrolled; caller uses extractNoteRecordV2
  assert.equal(r.isScrolledDetail, false);
  assert.equal(r.comments.length, 0);
});

test("commentFingerprint is stable across dumps and sensitive to user/text", () => {
  const a = { user: "合衬", text: "求推荐" };
  const b = { user: "合衬", text: "求推荐", timeText: "5天前 江苏 回复", likes: 3 };
  assert.equal(commentFingerprint(a), commentFingerprint(b));
  assert.notEqual(commentFingerprint(a), commentFingerprint({ user: "社会你鸡哥", text: "求推荐" }));
  assert.match(commentFingerprint(a), /^[0-9a-f]{12}$/);
});

test("mergeNoteRunFamily unions c1+c2 comments, dedupes to 9, keeps header fields", () => {
  const headerRecord = extractNoteRecordV2(readFileSync(FIXTURE_TOP, "utf8"));
  assert.equal(headerRecord.author, "喂你别哭了");
  const c1 = extractScrolledDetail(readFileSync(FIXTURE_C1, "utf8"));
  const c2 = extractScrolledDetail(readFileSync(FIXTURE_C2, "utf8"));
  const merged = mergeNoteRunFamily({
    headerRecord,
    scrolled: [
      { stepId: "dump_c1", record: c1 },
      { stepId: "dump_c2", record: c2 },
    ],
  });
  assert.equal(merged.headerDumpFound, true);
  assert.equal(merged.title, headerRecord.title);
  assert.equal(merged.author, "喂你别哭了");
  assert.equal(merged.interactions.commentCount, 124);
  // 7 + 6 rows, overlap of 4 → 9 unique comments
  assert.equal(merged.comments.length, 9);
  // dedup filled likes/time from whichever dump carried them
  const heChen = merged.comments.find((c) => c.user === "合衬");
  assert.equal(heChen.likes, 3);
  assert.deepEqual(heChen.sources, ["dump_c1"]);
  const overlap = merged.comments.find((c) => c.user === "社会你鸡哥");
  assert.deepEqual(overlap.sources.sort(), ["dump_c1", "dump_c2"]);
  const deep = merged.comments.find((c) => c.user === "午夜伤心玫瑰");
  assert.deepEqual(deep.sources, ["dump_c2"]);
  // 124 total vs 9 visible → honest truncation
  assert.equal(merged.commentsTruncated, true);
  // comments sorted by y (reading order across the two dumps)
  for (let i = 1; i < merged.comments.length; i += 1) {
    assert.ok(merged.comments[i - 1].y <= merged.comments[i].y);
  }
});

test("mergeNoteRunFamily without a header dump still carries comments with null identity", () => {
  const c1 = extractScrolledDetail(readFileSync(FIXTURE_C1, "utf8"));
  const merged = mergeNoteRunFamily({ headerRecord: null, scrolled: [{ stepId: "dump_c1", record: c1 }] });
  assert.equal(merged.headerDumpFound, false);
  assert.equal(merged.noteFingerprint, null);
  assert.equal(merged.comments.length, 7);
  assert.equal(merged.commentsTruncated, true);
});

test("recipeRunDumpJobs maps VERIFIED dump steps to header vs scrolled jobIds", () => {
  const receipt = {
    recipeRunId: "rr_4d3a2df2c0ea48aa",
    alias: "04",
    stepResults: [
      { stepId: "dump_top", status: "VERIFIED", result: { jobId: "job_ceb5b591" } },
      { stepId: "screenshot_top", status: "VERIFIED", result: { jobId: "job_shot1" } },
      { stepId: "dump_c1", status: "VERIFIED", result: { jobId: "job_c144e226" } },
      { stepId: "dump_c2", status: "VERIFIED", result: { jobId: "job_d8964a46" } },
      { stepId: "dump_c3", status: "FAILED", result: { jobId: "job_deadbeef" } },
      { stepId: "return_feed", status: "VERIFIED", result: { jobId: "job_back" } },
    ],
  };
  const jobs = recipeRunDumpJobs(receipt);
  assert.equal(jobs.recipeRunId, "rr_4d3a2df2c0ea48aa");
  assert.equal(jobs.alias, "04");
  assert.deepEqual(jobs.headerJobIds, ["job_ceb5b591"]);
  assert.deepEqual(jobs.scrolledJobIds, [
    { stepId: "dump_c1", jobId: "job_c144e226" },
    { stepId: "dump_c2", jobId: "job_d8964a46" },
  ]);
  // non-dump steps and non-VERIFIED steps are excluded
  assert.ok(!jobs.headerJobIds.includes("job_shot1"));
  assert.ok(!jobs.scrolledJobIds.some((s) => s.jobId === "job_deadbeef"));
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

function runCli(scanRoot, outRoot, extraArgs = []) {
  const cli = new URL("../ops/xhs-notes-extract.mjs", import.meta.url);
  const repoRoot = new URL("../..", import.meta.url);
  return spawnSync(process.execPath, [
    join(fileURLToPath(cli).replace(/\\/g, "/")),
    "--scan-root", scanRoot,
    "--out", outRoot,
    ...extraArgs,
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
// ---------------------------------------------------------------------------
// CLI --receipts mode: one receipt (jobId family) → one merged note
// ---------------------------------------------------------------------------

function buildFakeReceiptTree(root) {
  const top = readFileSync(FIXTURE_TOP, "utf8");
  const c1 = readFileSync(FIXTURE_C1, "utf8");
  const c2 = readFileSync(FIXTURE_C2, "utf8");
  // per-alias run tree: each dump step gets its own run dir + manifest jobId
  const dumpRuns = [
    ["job_ceb5b591", "run_673e54f7", top],
    ["job_c144e226", "run_6b026cf6", c1],
    ["job_d8964a46", "run_192dfdaa", c2],
  ];
  for (const [jobId, runId, content] of dumpRuns) {
    const dir = join(root, "04", "runs", runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "dump-ui.xml"), content, "utf8");
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({
      runId, jobId, actorId: "agent:xhs-collect-loop",
      createdAt: "2026-09-02T10:00:00.000Z",
      routeDecision: { selectedDevice: { alias: "04" } },
    }), "utf8");
  }
  // receipt persisted by the collection driver: stepResults carry the jobIds
  const receiptsDir = join(root, "..", "receipts");
  mkdirSync(receiptsDir, { recursive: true });
  writeFileSync(join(receiptsDir, "04_rr_4d3a2df2.json"), JSON.stringify({
    recipeRunId: "rr_4d3a2df2c0ea48aa",
    alias: "04",
    status: "SUCCEEDED",
    stepResults: [
      { stepId: "tap_feed_card", status: "VERIFIED", result: { jobId: "job_tap" } },
      { stepId: "dump_top", status: "VERIFIED", result: { jobId: "job_ceb5b591" } },
      { stepId: "dump_c1", status: "VERIFIED", result: { jobId: "job_c144e226" } },
      { stepId: "dump_c2", status: "VERIFIED", result: { jobId: "job_d8964a46" } },
      { stepId: "return_feed", status: "VERIFIED", result: { jobId: "job_back" } },
    ],
  }), "utf8");
  return receiptsDir;
}

test("CLI --receipts mode merges a run family into one note with comments", () => {
  const scanRoot = mkdtempSync(join(tmpdir(), "xhs-recv-scan-"));
  const outRoot = mkdtempSync(join(tmpdir(), "xhs-recv-out-"));
  try {
    const receiptsDir = buildFakeReceiptTree(scanRoot);
    const result = runCli(scanRoot, outRoot, ["--receipts", receiptsDir, "--aliases", "04"]);
    assert.equal(result.status, 0, `CLI failed: ${result.stdout}\n${result.stderr}`);

    const notes = readFileSync(join(outRoot, "notes.jsonl"), "utf8")
      .split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(notes.length, 1);
    const note = notes[0];
    assert.equal(note.recipeRunId, "rr_4d3a2df2c0ea48aa");
    assert.equal(note.author, "喂你别哭了");
    assert.equal(note.comments.length, 9, "7+6 rows dedupe to 9 by fingerprint");
    assert.equal(note.commentTotal, 124);
    assert.equal(note.commentsTruncated, true);
    assert.equal(note.headerDumpFound, true);
    assert.ok(note.dumpFamily.scrolled.length === 2);

    const comments = readFileSync(join(outRoot, "comments.jsonl"), "utf8")
      .split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(comments.length, 9);
    assert.ok(comments.every((c) => c.recipeRunId === "rr_4d3a2df2c0ea48aa"));
    assert.ok(comments.some((c) => c.comment.user === "合衬" && c.comment.text === "求推荐"));

    const runsIndex = readFileSync(join(outRoot, "runs-index.jsonl"), "utf8")
      .split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(runsIndex.length, 1);
    assert.equal(runsIndex[0].recipeRunId, "rr_4d3a2df2c0ea48aa");
    assert.equal(runsIndex[0].comments, 9);

    const summary = JSON.parse(readFileSync(join(outRoot, "summary.json"), "utf8"));
    assert.equal(summary.mode, "receipts");
    assert.equal(summary.totals.receipts, 1);
    assert.equal(summary.totals.detailDumps, 1);
    assert.equal(summary.totals.commentRows, 9);
    assert.equal(summary.totals.truncatedNotes, 1);
    assert.equal(summary.totals.failed, 0);
  } finally {
    rmSync(scanRoot, { recursive: true, force: true });
    rmSync(outRoot, { recursive: true, force: true });
  }
});
