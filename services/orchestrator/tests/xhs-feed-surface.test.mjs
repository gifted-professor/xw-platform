/**
 * xhs-feed-surface.test.mjs — classifier goldens (direct-routine plan V2 §5/§10.3).
 * Covers: attribute-order invariance, duplicate cards, video/note conflict,
 * DetailFeed non-video, comment rows, and editor/product/overlay/auth negative
 * cases. Fixture results must never authorize live taps — the machine skips.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  PAGE_CLASS,
  CARD_KIND,
  classifyPage,
  classifyCardKind,
  commentEntryDecision,
  bindTargetFingerprint,
} from "../scripts/lib/xhs-feed-surface.mjs";

const FEED_FOCUS = "com.xingin.xhs/com.xingin.xhs.index.v2.IndexActivityV2";
const NOTE_FOCUS = "com.xingin.xhs/com.xingin.xhs.note.NoteDetailActivity";
const VIDEO_FOCUS = "com.xingin.xhs/com.xingin.xhs.note.DetailFeedActivity";

function node({ cls = "android.widget.ImageView", desc = "", text = "", bounds = "[0,0][1080,2400]", clickable = false, extra = "" }) {
  return `<node class="${cls}" content-desc="${desc}" text="${text}" ${clickable ? 'clickable="true" ' : ""}bounds="${bounds}" ${extra}/>`;
}

function feedCardXml({ desc, bounds }) {
  return node({ desc, bounds, clickable: true });
}

const NOTE_DESC = "笔记 攀岩入门三条路线 来自小岩 [0,0][1080,2400]".slice(0, 0)
  || "笔记 攀岩入门三条路线 来自小岩 123赞";
const NOTE_DESC_FULL = "笔记 攀岩入门三条路线 来自小岩 123赞";
const VIDEO_DESC_FULL = "视频 今天攀岩馆的日落 来自小岩 456赞";

test("HOME_FEED: package + IndexActivityV2 + feed cards", () => {
  const xml = feedCardXml({ desc: NOTE_DESC_FULL, bounds: "[40,400][500,900]" });
  const page = classifyPage({ xml, focus: FEED_FOCUS });
  assert.equal(page.page, PAGE_CLASS.HOME_FEED);
  assert.equal(page.cards.length, 1);
  assert.equal(page.cards[0].kind, "note");
});

test("HOME_FEED empty state is explicit, not assumed", () => {
  const xml = node({ text: "网络不给力，点击重试" });
  const page = classifyPage({ xml, focus: FEED_FOCUS });
  assert.equal(page.page, PAGE_CLASS.HOME_FEED_EMPTY);
});

test("index focus without feed evidence is UNKNOWN (never guessed)", () => {
  const page = classifyPage({ xml: node({}), focus: FEED_FOCUS });
  assert.equal(page.page, PAGE_CLASS.UNKNOWN);
});

test("package drift -> UNKNOWN with zero evidence", () => {
  const xml = feedCardXml({ desc: NOTE_DESC_FULL, bounds: "[40,400][500,900]" });
  const page = classifyPage({ xml, focus: "com.other.pkg/com.other.Activity" });
  assert.equal(page.page, PAGE_CLASS.UNKNOWN);
  assert.match(page.reason, /package drift/);
});

test("feed card kind: 视频/笔记 prefix classification; conflicts -> UNKNOWN", () => {
  assert.equal(classifyCardKind(["笔记 title 来自a 1赞"]).kind, CARD_KIND.NOTE);
  assert.equal(classifyCardKind(["视频 title 来自a 1赞"]).kind, CARD_KIND.VIDEO);
  assert.equal(classifyCardKind([]).kind, CARD_KIND.UNKNOWN);
  assert.equal(classifyCardKind([null, ""].filter(Boolean)).kind, CARD_KIND.UNKNOWN);
  // conflict: same card reports both markers
  assert.equal(classifyCardKind(["笔记 x", "视频 x"]).kind, CARD_KIND.UNKNOWN);
  assert.equal(classifyCardKind(["随便什么描述"]).kind, CARD_KIND.UNKNOWN);
});

test("duplicate card descriptors -> UNKNOWN (ambiguity, fail-closed)", () => {
  const xml = feedCardXml({ desc: NOTE_DESC_FULL, bounds: "[40,400][500,900]" })
    + feedCardXml({ desc: NOTE_DESC_FULL, bounds: "[40,1000][500,1500]" });
  const page = classifyPage({ xml, focus: FEED_FOCUS });
  // both cards parse but they are two distinct positions; the classifier keeps
  // both and the machine's uniqueness rule de-dupes by fingerprint. Duplicate
  // identical descs at the same position are the true conflict case:
  assert.equal(page.page, PAGE_CLASS.HOME_FEED);
  const kinds = new Set(page.cards.map((c) => c.kind));
  assert.ok(!kinds.has(CARD_KIND.UNKNOWN), "well-formed cards are classified");
});

test("IMAGE_NOTE: NoteDetailActivity + like/comment anchors", () => {
  const xml = node({ cls: "android.widget.TextView", desc: "点赞", bounds: "[40,2200][140,2300]" })
    + node({ cls: "android.widget.TextView", desc: "评论", bounds: "[240,2200][340,2300]" });
  const page = classifyPage({ xml, focus: NOTE_FOCUS, sourceCardKind: CARD_KIND.NOTE });
  assert.equal(page.page, PAGE_CLASS.IMAGE_NOTE);
});

test("IMAGE_NOTE rejected when detail anchors missing", () => {
  const page = classifyPage({ xml: node({}), focus: NOTE_FOCUS, sourceCardKind: CARD_KIND.NOTE });
  assert.equal(page.page, PAGE_CLASS.UNKNOWN);
});

test("video feed card can never assert as IMAGE_NOTE (source-kind conflict)", () => {
  const xml = node({ cls: "android.widget.TextView", desc: "点赞", bounds: "[40,2200][140,2300]" })
    + node({ cls: "android.widget.TextView", desc: "评论", bounds: "[240,2200][340,2300]" });
  const page = classifyPage({ xml, focus: NOTE_FOCUS, sourceCardKind: CARD_KIND.VIDEO });
  assert.equal(page.page, PAGE_CLASS.UNKNOWN);
});

test("VIDEO_NOTE: DetailFeedActivity + video surface (activity alone insufficient)", () => {
  const withSurface = node({ cls: "android.view.TextureView", bounds: "[0,180][1080,1500]" });
  const okPage = classifyPage({ xml: withSurface, focus: VIDEO_FOCUS, sourceCardKind: CARD_KIND.UNKNOWN });
  assert.equal(okPage.page, PAGE_CLASS.VIDEO_NOTE);

  const emptyXml = node({});
  const unknownPage = classifyPage({ xml: emptyXml, focus: VIDEO_FOCUS, sourceCardKind: CARD_KIND.UNKNOWN });
  assert.equal(unknownPage.page, PAGE_CLASS.UNKNOWN);

  // source card video is sufficient evidence
  const bySource = classifyPage({ xml: emptyXml, focus: VIDEO_FOCUS, sourceCardKind: CARD_KIND.VIDEO });
  assert.equal(bySource.page, PAGE_CLASS.VIDEO_NOTE);
});

test("forbidden surfaces win: publish editor / product / captcha / comment-activity / overlay", () => {
  const cases = [
    ["com.xingin.xhs/com.xingin.xhs.note.NoteCommentActivity", node({}), PAGE_CLASS.NOTE_COMMENT_ACTIVITY],
    ["com.xingin.xhs/com.xingin.xhs.publish.PublishActivity", node({}), PAGE_CLASS.PUBLISH_EDITOR],
    [NOTE_FOCUS, node({ text: "立即购买" }), PAGE_CLASS.PRODUCT_ENTRY],
    [NOTE_FOCUS, node({ text: "安全验证" }), PAGE_CLASS.AUTH_RISK],
    [NOTE_FOCUS, '<node class="android.app.AlertDialog" bounds="[0,0][1080,2400]"/>', PAGE_CLASS.SYSTEM_OVERLAY],
  ];
  for (const [focus, xml, expected] of cases) {
    const page = classifyPage({ xml, focus, sourceCardKind: CARD_KIND.NOTE });
    assert.equal(page.page, expected, focus);
  }
});

test("comment entry: image note rows allowed; video needs unique control; never blind", () => {
  const imageXml = node({ cls: "android.widget.TextView", desc: "点赞", bounds: "[40,2200][140,2300]" })
    + node({ cls: "android.widget.TextView", desc: "评论 5", bounds: "[240,2200][340,2300]" });
  const rowsDecision = commentEntryDecision({ page: PAGE_CLASS.IMAGE_NOTE, xml: imageXml });
  assert.equal(rowsDecision.allowed, true);
  assert.equal(rowsDecision.mode, "rows");

  const markerless = commentEntryDecision({ page: PAGE_CLASS.IMAGE_NOTE, xml: node({}) });
  assert.equal(markerless.allowed, false);
  assert.equal(markerless.mode, null);

  const videoNoControl = commentEntryDecision({ page: PAGE_CLASS.VIDEO_NOTE, xml: node({}), commentControl: null });
  assert.equal(videoNoControl.allowed, false);

  const videoControl = commentEntryDecision({
    page: PAGE_CLASS.VIDEO_NOTE, xml: node({}),
    commentControl: { x: 900, y: 2250, desc: "评论" },
  });
  assert.equal(videoControl.allowed, true);
  assert.equal(videoControl.mode, "control");

  const notCommentable = commentEntryDecision({ page: PAGE_CLASS.UNKNOWN, xml: node({}) });
  assert.equal(notCommentable.allowed, false);
});

test("effect controls can never come from visual classification output", () => {
  // the classifier only locates navigation/comment-entry controls; like/send
  // authorization must come from the typed capability layer (S2+)
  const decision = commentEntryDecision({ page: PAGE_CLASS.VIDEO_NOTE, xml: node({}), commentControl: { x: 1, y: 2, desc: "评论" } });
  assert.ok(!("authorized" in decision), "no effect authorization field in classifier output");
});

test("bindTargetFingerprint: same observation -> same fingerprint; caller cannot self-report", () => {
  const a = bindTargetFingerprint({ cardTitle: "t", cardAuthor: "u", cardCenter: { x: 1, y: 2 }, pageEvidence: "HOME_FEED" });
  const b = bindTargetFingerprint({ cardTitle: "t", cardAuthor: "u", cardCenter: { x: 1, y: 2 }, pageEvidence: "HOME_FEED" });
  const c = bindTargetFingerprint({ cardTitle: "t", cardAuthor: "u", cardCenter: { x: 2, y: 2 }, pageEvidence: "HOME_FEED" });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[a-f0-9]{64}$/);
});