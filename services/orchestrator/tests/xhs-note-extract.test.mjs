/**
 * xhs-note-extract.test.mjs — offline tests for the note-detail semantic
 * extractor (xhs.note.record.v1). Hand-written dump XML, no device I/O.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  extractNoteRecord,
  looksLikeNoteDetail,
  parseCountText,
} from "../scripts/lib/xhs-note-extract.mjs";
import { allNodes } from "../ops/_xhs-parse.mjs";

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

test("extractNoteRecord pulls title/author/body/date/interactions", () => {
  const r = extractNoteRecord(DETAIL_XML);
  assert.equal(r.schemaId, "xhs.note.record.v1");
  assert.equal(r.title, "新手攀岩入门：三条室内抱石路线全讲解");
  assert.equal(r.author, "小岩");
  assert.match(r.body, /第一条适合第一次进馆的朋友/);
  assert.equal(r.date, "3天前");
  assert.deepEqual(r.interactions, {
    likeCount: 12000,
    likeState: "unliked",
    collectCount: 890,
    commentCount: 12,
  });
  assert.equal(r.confidence.title, "medium");
  assert.equal(r.confidence.body, "high"); // resource-id matched
  assert.match(r.sourceDumpHash, /^[0-9a-f]{64}$/);
  assert.match(r.noteFingerprint, /^[0-9a-f]{16}$/);
  assert.equal(r.screen.height, 2400);
});

test("liked state flips with 已点赞 and count parsing stays numeric", () => {
  const liked = DETAIL_XML.replace('desc="点赞 1.2万"', 'desc="已点赞 1.2万"');
  const r = extractNoteRecord(liked);
  assert.equal(r.interactions.likeState, "liked");
  assert.equal(r.interactions.likeCount, 12000);
});

test("missing fields are null, never thrown", () => {
  const sparse = '<hierarchy><node bounds="[0,0][1080,2400]"/>' +
    node({ text: "", desc: "点赞", bounds: "[60,2200][160,2300]" }) +
    "</hierarchy>";
  const r = extractNoteRecord(sparse);
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
});

test("body is capped at maxBodyChars", () => {
  const long = "字".repeat(3000);
  const xml = '<hierarchy><node bounds="[0,0][1080,2400]"/>' +
    node({ text: "这里是一个标题", bounds: "[40,300][400,360]" }) +
    node({ text: long, bounds: "[40,540][1000,900]" }) +
    node({ text: "", desc: "点赞", bounds: "[60,2200][160,2300]" }) +
    "</hierarchy>";
  const r = extractNoteRecord(xml);
  assert.equal(r.title, "这里是一个标题");
  assert.equal(r.body.length, 2000);
});

test("looksLikeNoteDetail discriminates detail vs feed dumps", () => {
  assert.equal(looksLikeNoteDetail(DETAIL_XML), true);
  const feed =
    '<hierarchy><node bounds="[0,0][1080,2400]"/>' +
    node({ text: "", desc: "笔记 攀岩入门 来自小岩 123赞", bounds: "[40,400][500,900]" }) +
    "</hierarchy>";
  assert.equal(looksLikeNoteDetail(feed), false);
});

test("allNodes now carries resource-id", () => {
  const nodes = allNodes(DETAIL_XML);
  const withRid = nodes.filter((n) => n.rid);
  assert.ok(withRid.length >= 1);
  assert.ok(withRid.some((n) => n.rid === "com.xingin.xhs:id/content_tv"));
});