/**
 * xhs-feed-card-select.test.mjs — offline tests for the pure feed-card
 * selection module backing the `tapFeedCard` recipe primitive.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  parseNodes,
  parseFeedCards,
  selectFeedCard,
  feedCardFingerprint,
} from "../control-plane/lib/xhs-feed-card-select.mjs";

/** Minimal uiautomator dump with a full-screen root node. */
function nodeXml({ desc = "", text = "", bounds, clickable = false, extra = "" }) {
  return `<node index="0" text="${text}" content-desc="${desc}" class="android.view.View" ` +
    `clickable="${clickable}" enabled="true" bounds="${bounds}"${extra}></node>`;
}

function feedXml({ screen = "1080x2400", nodes = [] } = {}) {
  const [w, h] = screen.split("x").map(Number);
  const inner = nodes.map(nodeXml).join("");
  return `<hierarchy rotation="0"><node index="0" text="" content-desc="" class="android.view.View" ` +
    `clickable="false" enabled="true" bounds="[0,0][${w},${h}]">${inner}</node></hierarchy>`;
}

const BASE_1080 = feedXml({
  screen: "1080x2400",
  nodes: [
    { desc: "笔记 标题A 来自作者A 123赞", bounds: "[10,300][530,900]" },
    { desc: "视频 标题B 来自作者B 6.3万赞", bounds: "[550,300][1070,900]" },
    { desc: "笔记 标题C 来自作者C 45赞", bounds: "[10,950][530,1500]" },
    { desc: "笔记 标题D 来自作者D 45赞", bounds: "[550,950][1070,1500]" },
    { desc: "笔记 太小 来自x 1赞", bounds: "[10,1600][150,1700]" },
    { desc: "笔记 越界 来自x 1赞", bounds: "[10,2350][530,2390]" },
  ],
});

test("parseNodes reads screen size from the root bounds", () => {
  const a = parseNodes(BASE_1080);
  assert.deepEqual({ w: a.screenWidth, h: a.screenHeight }, { w: 1080, h: 2400 });
  const b = parseNodes(BASE_1080.replace("[0,0][1080,2400]", "[0,0][1220,2712]"));
  assert.deepEqual({ w: b.screenWidth, h: b.screenHeight }, { w: 1220, h: 2712 });
  assert.ok(b.nodes.length >= 2, "nodes parsed");
});

test("parseFeedCards filters by kind, size, and relative band; parses desc fields", () => {
  const cards = parseFeedCards(BASE_1080);
  // 越界 card (cy 2370 > 0.92*2400=2208) and 太小 card (100x100) are excluded.
  assert.equal(cards.length, 4);
  const first = cards[0];
  assert.equal(first.kind, "note");
  assert.equal(first.title, "标题A");
  assert.equal(first.author, "作者A");
  assert.equal(first.likes, 123);
  // 万赞 parsing
  assert.equal(cards[1].kind, "video");
  assert.equal(cards[1].likes, 63000);
  // dedupe: same tile reported twice yields one card
  const dup = feedXml({
    nodes: [
      { desc: "笔记 重复 来自x 1赞", bounds: "[10,300][530,900]" },
      { desc: "笔记 重复 来自x 1赞", bounds: "[12,302][532,902]" },
    ],
  });
  assert.equal(parseFeedCards(dup).length, 1);
});

test("selectFeedCard is deterministic and prefers notes by default params", () => {
  const a = selectFeedCard(BASE_1080, { pickIndex: 0, preferKind: "image", fallbackToAny: true });
  const b = selectFeedCard(BASE_1080, { pickIndex: 0, preferKind: "image", fallbackToAny: true });
  assert.deepEqual(a, b, "same fixture → same selection");
  assert.equal(a.kind, "note");
  assert.equal(a.resolvedBy, "prefer");
  assert.equal(a.x, 270);
  assert.equal(a.y, 600);
  assert.equal(a.title, "标题A");
  assert.equal(a.author, "作者A");
  assert.match(a.fingerprint, /^[0-9a-f]{16}$/);
  assert.equal(a.fingerprint, feedCardFingerprint({ kind: "note", title: "标题A", author: "作者A" }));
});

test("1220x2712 scaled dump selects the same card via relative band", () => {
  const scaled = feedXml({
    screen: "1220x2712",
    nodes: [
      { desc: "笔记 标题A 来自作者A 123赞", bounds: "[11,339][599,1016]" },
      { desc: "视频 标题B 来自作者B 6.3万赞", bounds: "[620,339][1190,1016]" },
    ],
  });
  const sel = selectFeedCard(scaled, { pickIndex: 0, preferKind: "image", fallbackToAny: true });
  assert.equal(sel.kind, "note");
  assert.equal(sel.title, "标题A");
  assert.equal(sel.screenWidth, 1220);
  assert.equal(sel.screenHeight, 2712);
  // 0.12*2712=325 < cy 678; 0.92*2712=2495 > 678 → in band on the tall screen.
  assert.equal(sel.y, 678);
});

test("pickIndex walks the ordered card list", () => {
  assert.equal(selectFeedCard(BASE_1080, { pickIndex: 0 }).title, "标题A");
  assert.equal(selectFeedCard(BASE_1080, { pickIndex: 2 }).title, "标题C");
  // preferKind image skips the video card
  assert.equal(selectFeedCard(BASE_1080, { pickIndex: 1, preferKind: "image" }).title, "标题C");
});

test("error codes: DUMP_EMPTY / NO_CARDS / KIND_MISS / PICK_INDEX_OOB", () => {
  assert.throws(() => selectFeedCard(""), (e) => e.code === "TAP_FEED_CARD_DUMP_EMPTY");
  assert.throws(() => selectFeedCard(feedXml({ nodes: [] })), (e) => e.code === "TAP_FEED_CARD_NO_CARDS");
  const notesOnly = feedXml({
    nodes: [{ desc: "笔记 标题N 来自作者N 9赞", bounds: "[10,300][530,900]" }],
  });
  assert.throws(
    () => selectFeedCard(notesOnly, { preferKind: "video", fallbackToAny: false }),
    (e) => e.code === "TAP_FEED_CARD_KIND_MISS",
  );
  assert.throws(
    () => selectFeedCard(BASE_1080, { pickIndex: 99 }),
    (e) => e.code === "TAP_FEED_CARD_PICK_INDEX_OOB" && e.details.poolSize === 4,
  );
});

test("fallbackToAny: no image card → tap topmost video card", () => {
  const onlyVideo = feedXml({
    nodes: [{ desc: "视频 标题V 来自作者V 9赞", bounds: "[10,300][530,900]" }],
  });
  const sel = selectFeedCard(onlyVideo, { preferKind: "image", fallbackToAny: true });
  assert.equal(sel.kind, "video");
  assert.equal(sel.resolvedBy, "fallback");
  assert.equal(sel.y, 600);
});

test("invalid params are rejected with typed codes", () => {
  assert.throws(() => selectFeedCard(BASE_1080, { pickIndex: -1 }), (e) => e.code === "TAP_FEED_CARD_PICK_INDEX_OOB");
  assert.throws(() => selectFeedCard(BASE_1080, { preferKind: "audio" }), (e) => e.code === "TAP_FEED_CARD_PARAMS_INVALID");
});