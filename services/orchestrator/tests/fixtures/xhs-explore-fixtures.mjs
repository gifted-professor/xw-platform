/**
 * xhs-explore-fixtures.mjs — P2 standalone uiautomator XML scene builders for
 * the V3 free-exploration driver tests.
 *
 * Every builder emits a dump that the REAL production parsers classify exactly
 * (classifyPage / parseFeedCards / parseSearchResults / parseBottomBar /
 * parseComments / parseExploreSurface). Constraints honored here (see
 * ops/_xhs-parse.mjs + scripts/lib/xhs-feed-surface.mjs):
 *   - feed cards: content-desc "笔记|视频 ... 来自 <author> N赞" BEFORE bounds
 *     in the tag, cy 180..2100, tile ≥200×200;
 *   - stable V3-I05 identity comes from a `notes/<24hex>` path inside desc;
 *     NO node may carry a resource-id matching /note_id|noteId/ (that regex
 *     scans the whole xml and would override per-card identity);
 *   - search tiles: clickable, w≥400 h≥280, cy 280..2200, empty text attr;
 *     a title text ≥6 chars sits inside the tile;
 *   - forbidden markers must never appear (商品|带货|购买|加入购物车|立即购买,
 *     验证码|安全验证..., 从相册选择|拍摄与直播|写文字|编辑器|说点什么，分享你的生活)
 *     and no class matching AlertDialog|DialogWindow|PopupWindow.
 */

const PKG = "com.xingin.xhs";
const DISPLAY = { w: 1080, h: 2400 };

/** One self-closing uiautomator node. */
function node({ id, text = "", desc = "", resourceId = "", cls = "android.widget.TextView", clickable = false, focused = false, enabled = true, bounds }) {
  const [L, T, R, B] = bounds;
  return `<node index="${id}" text="${text}" resource-id="${resourceId}" class="${cls}" package="${PKG}" content-desc="${desc}" checkable="false" clickable="${clickable}" enabled="${enabled}" focused="${focused}" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[${L},${T}][${R},${B}]" />`;
}

function document(children) {
  return `<?xml version="1.0" encoding="UTF-8"?><hierarchy rotation="0"><node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="${PKG}" content-desc="" checkable="false" clickable="false" enabled="true" focused="false" scrollable="false" bounds="[0,0][${DISPLAY.w},${DISPLAY.h}]">${children.join("")}</node></hierarchy>`;
}

/** Map a fixture id to a distinct 24-hex note id (V3-I05 stable evidence). */
export function noteHex(id) {
  return String(id).split("").map((ch) => ch.charCodeAt(0).toString(16).padStart(2, "0")).join("").padEnd(24, "a").slice(0, 24);
}

function feedCard(index, { id, title, author, kind = "note" }) {
  const T = 200 + index * 760; // cy 520, 1280, 2040 — all inside 180..2100
  return node({
    id: `card-${id}`,
    resourceId: `${PKG}:id/card_${id}`,
    cls: "android.widget.FrameLayout",
    clickable: true,
    desc: `${kind === "video" ? "视频" : "笔记"} ${title} 来自 ${author} 赞 128 notes/${noteHex(id)}`,
    bounds: [24, T, 1032, T + 640],
  });
}

/**
 * HOME feed (IndexActivityV2). `cards` are candidates in visual (top-first)
 * order. `withSearchEntry` adds the self-closing 搜索 entry that
 * resolveTapTarget requires; `empty` forces the explicit HOME_FEED_EMPTY state.
 */
export function homeFeedXml({ cards = [], withSearchEntry = false, empty = false } = {}) {
  const children = [];
  if (withSearchEntry) {
    children.push(node({
      id: "search-entry",
      resourceId: `${PKG}:id/search_entry`,
      desc: "搜索",
      cls: "android.widget.ImageView",
      clickable: true,
      bounds: [900, 100, 1050, 180],
    }));
  }
  if (empty) {
    children.push(node({ id: "empty", text: "网络不给力，请稍后再试", bounds: [200, 1000, 880, 1080] }));
  } else {
    children.push(...cards.map((card, index) => feedCard(index, {
      id: card.id, title: card.title, author: card.author, kind: card.kind,
    })));
  }
  children.push(node({ id: "nav", text: "首页", bounds: [0, 2300, 270, 2380] }));
  children.push(node({ id: "nav2", text: "市集", bounds: [270, 2300, 540, 2380] }));
  children.push(node({ id: "nav3", text: "发布", bounds: [540, 2300, 810, 2380] }));
  children.push(node({ id: "nav4", text: "消息", bounds: [810, 2300, 1080, 2380] }));
  return {
    focus: `${PKG}/com.xingin.matrix.index.index.IndexActivityV2`,
    xml: document(children),
  };
}

/** Empty search home: an editor + hint rows, no clickable result tile. */
export function searchHomeXml() {
  return {
    focus: `${PKG}/com.xingin.xhs.search.GlobalSearchActivity`,
    xml: document([
      node({ id: "back", desc: "返回", cls: "android.widget.ImageView", bounds: [24, 120, 120, 216] }),
      node({ id: "editor", cls: "android.widget.EditText", focused: true, bounds: [140, 140, 1000, 210] }),
      node({ id: "hint", text: "猜你想搜", bounds: [24, 300, 400, 360] }),
      node({ id: "hist", text: "历史搜一搜都看看", bounds: [24, 400, 500, 460] }),
    ]),
  };
}

/** SEARCH_RESULTS. tiles: [{title, author}] laid out one tall tile per row. */
export function searchResultsXml({ tiles = [] } = {}) {
  const children = [];
  for (const tab of ["综合", "最新", "用户"]) {
    children.push(node({ id: `tab-${tab}`, text: tab, bounds: [24 + 120 * (["综合", "最新", "用户"].indexOf(tab)), 220, 144 + 120 * (["综合", "最新", "用户"].indexOf(tab)), 270] }));
  }
  tiles.forEach((tile, index) => {
    const T = 300 + index * 620;
    children.push(node({
      id: `tile-${index}`,
      resourceId: `${PKG}:id/result_tile_${index}`,
      cls: "android.widget.LinearLayout",
      clickable: true,
      text: "",
      bounds: [24, T, 1032, T + 560],
    }));
    children.push(node({ id: `title-${index}`, text: tile.title, bounds: [40, T + 440, 1000, T + 500] }));
    children.push(node({ id: `author-${index}`, text: tile.author, bounds: [40, T + 420, 300, T + 440] }));
   });
  return {
    focus: `${PKG}/com.xingin.xhs.search.GlobalSearchActivity`,
    xml: document(children.length > 0 ? children : [
      node({ id: "back", desc: "返回", cls: "android.widget.ImageView", bounds: [24, 120, 120, 216] }),
      node({ id: "editor", cls: "android.widget.EditText", focused: true, bounds: [140, 140, 1000, 210] }),
    ]),
  };
}

/** Image note detail (NoteDetailActivity) with like+comment anchors. */
export function imageNoteXml({ title } = {}) {
  return {
    focus: `${PKG}/com.xingin.matrix.module.note.NoteDetailActivity`,
    xml: document([
      node({ id: "back", desc: "返回", cls: "android.widget.ImageView", bounds: [24, 120, 120, 216] }),
      node({ id: "title", text: title ?? "一篇探索中的图文详情", bounds: [40, 200, 1040, 300] }),
      node({ id: "like", desc: "点赞", cls: "android.widget.ImageView", bounds: [60, 2220, 160, 2320] }),
      node({ id: "collect", desc: "收藏", cls: "android.widget.ImageView", bounds: [300, 2220, 400, 2320] }),
      node({ id: "comment", desc: "评论", cls: "android.widget.ImageView", bounds: [540, 2220, 640, 2320] }),
      node({ id: "share", desc: "分享", cls: "android.widget.ImageView", bounds: [840, 2220, 940, 2320] }),
    ]),
  };
}

/** Note comment panel (NOTE_COMMENT_ACTIVITY → V3 COMMENT_PANEL, read-only). */
export function commentPanelXml({ comments = 3 } = {}) {
  const children = [
    node({ id: "back", desc: "返回", cls: "android.widget.ImageView", bounds: [24, 120, 120, 216] }),
    node({ id: "header", text: `评论 ${comments}`, bounds: [24, 160, 400, 240] }),
    node({ id: "editor", cls: "android.widget.EditText", desc: "评论框", bounds: [24, 2260, 900, 2330] }),
  ];
  return {
    focus: `${PKG}/com.xingin.matrix.module.comment.NoteCommentActivity`,
    xml: document(children),
  };
}

/** Forbidden commerce exit surface (立即购买 marker). */
export function productEntryXml() {
  return {
    focus: `${PKG}/com.xingin.matrix.h5.H5Activity`,
    xml: document([
      node({ id: "buy", text: "立即购买", bounds: [24, 140, 600, 260] }),
    ]),
  };
}