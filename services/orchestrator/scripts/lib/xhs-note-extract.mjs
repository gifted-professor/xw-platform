/**
 * xhs-note-extract.mjs — offline semantic extraction of an XHS note-detail
 * screen from an already-captured uiautomator dump (zero device I/O).
 *
 * Pure post-processing over the read-only evidence the CP already seals per
 * run (runs/<runId>/dump-ui.xml). Field resolution:
 *   - resource-id first (com.xingin.xhs:id/...), heuristic fallback otherwise;
 *   - missing fields are null — never thrown, so partial dumps still yield a
 *     usable record;
 *   - interactions come from the detail bottom bar (parseBottomBar/likeState).
 *
 * v2 (2026-09-02) adds:
 *   - postTime {date,timeOfDay,location} parsed from the publish-meta node
 *     (live samples: "昨天 下午4:41河北" / "08-27河南");
 *   - comments [] (visible comment rows: user/text/timeText/likes), with
 *     commentTotal + commentsTruncated so truncated captures are honest.
 *
 * Reuses the shared parsing idioms in orchestrator ops/_xhs-parse.mjs
 * (decodeEntities / parseBottomBar / likeState); allNodes is carried here with
 * resource-id support because the main-repo copy does not export it yet.
 */
import { createHash } from "node:crypto";

import {
  decodeEntities,
  likeState,
  parseBottomBar,
} from "../../ops/_xhs-parse.mjs";

export const NOTE_RECORD_SCHEMA_ID = "xhs.note.record.v1";
export const NOTE_RECORD_SCHEMA_ID_V2 = "xhs.note.record.v2";
export const BODY_MAX_CHARS = 2000;

/** Bottom-bar / nav chrome labels that are never content. */
const UI_LABEL =
  /^(关注|已关注|回关|相互关注|点赞|已点赞|收藏|已收藏|评论|分享|说点什么|说点什么\.\.\.|说点什么\.\.\.|评论框|发送|发布|下一步|返回|首页|消息|我|展开|收起|查看更多评论|作者|置顶|回复|赞|抢首评|首评)$/;

/** Comment-row chrome: section head / input placeholder / dislike / bottom bar. */
const COMMENT_CHROME_RE = /^(共\s*\d+\s*条评论|说点什么(\.\.\.)?|评论框|不喜欢|爱评论的人运气都不差|猜你想搜|展开\d+条回复?|查看更多评论|收起|(点赞|已点赞|收藏|已收藏|评论)\s*\d*|有话要说，快来评论|让大家听到你的声音|留下你的想法吧|你还没填写内容)$/;

/** Publish-meta shapes seen live on device 04/05 (2026-09-02). */
const DATE_SPAN_RE = /\d+\s*(?:秒|分钟|小时|天|周|个月|年)前|编辑于.{0,12}|(?:昨天|前天|今天)\s*[^，。;；已]{0,10}|\d{4}[-/年]\d{1,2}[-/月]\d{1,2}[日号]?|\d{1,2}-\d{1,2}/;

/** Comment time rows: relative ("2天前"), absolute ("09-02"), or 昨天/今天, optionally with 回复 tail. */
const COMMENT_TIME_RE = /^(?:\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}-\d{1,2}|\d+\s*(?:秒|分钟|小时|天|周|个月|年)前|昨天|前天|今天|编辑于.{0,12})/;
const COMMENT_TIME_FULL_RE = new RegExp(
  COMMENT_TIME_RE.source.replace("$", "") + "[^,，。;；]{0,10}$"
);

/** Parse a bottom-bar count suffix: "点赞 1.2万" → 12000; "评论 3" → 3. */
export function parseCountText(text) {
  const m = String(text || "").match(/([\d.]+)\s*(万)?/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  return m[2] ? Math.round(n * 10000) : Math.round(n);
}

function sha256Hex(s) {
  return createHash("sha256").update(String(s), "utf8").digest("hex");
}

/** Screen height estimate: tallest node bottom (dumps are truncated-safe). */
function screenHeight(nodes) {
  return nodes.reduce((max, n) => Math.max(max, n.B), 0) || 2400;
}

/** Flatten uiautomator XML into node records (with resource-id support). */
export function allNodes(xml) {
  const out = [];
  const re = /<node\b[^>]*>/g;
  let m;
  while ((m = re.exec(xml))) {
    const tag = m[0];
    const b = tag.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (!b) continue;
    const L = +b[1];
    const T = +b[2];
    const R = +b[3];
    const B = +b[4];
    out.push({
      L,
      T,
      R,
      B,
      cx: Math.round((L + R) / 2),
      cy: Math.round((T + B) / 2),
      w: R - L,
      h: B - T,
      text: decodeEntities((tag.match(/text="([^"]*)"/) || [])[1] || ""),
      desc: decodeEntities((tag.match(/content-desc="([^"]*)"/) || [])[1] || ""),
      rid: decodeEntities((tag.match(/resource-id="([^"]*)"/) || [])[1] || ""),
      clickable: /clickable="true"/.test(tag),
      enabled: !/enabled="false"/.test(tag),
      focused: /focused="true"/.test(tag),
      cls: ((tag.match(/class="([^"]*)"/) || [])[1] || "").split(".").pop(),
    });
  }
  return out;
}

/**
 * Parse a publish-meta string into {date,timeOfDay,location}.
 *   "昨天 下午4:41河北" → {date:"昨天", timeOfDay:"下午4:41", location:"河北"}
 *   "08-27河南"        → {date:"08-27", timeOfDay:null,       location:"河南"}
 *   "08-15 北京"       → {date:"08-15", timeOfDay:null,       location:"北京"}
 *   "3天前"            → {date:"3天前", timeOfDay:null,       location:null}
 */
export function parsePostTime(raw) {
  const s = String(raw || "").trim();
  if (!s) return { date: null, timeOfDay: null, location: null, raw: null };
  // date: try absolute forms first, then relative counts, then 昨天/前天/今天 —
  // DATE_SPAN_RE's 昨天 branch is greedy and would swallow the time+location
  let rest = s;
  let date = null;
  for (const re of [
    /\d{4}[-/年]\d{1,2}[-/月]\d{1,2}[日号]?/,
    /\d{1,2}-\d{1,2}/,
    /\d+\s*(?:秒|分钟|小时|天|周|个月|年)前/,
    /(?:昨天|前天|今天)/,
  ]) {
    const m = rest.match(re);
    if (m) {
      date = m[0].trim();
      rest = rest.replace(m[0], " ");
      break;
    }
  }
  const timeMatch = rest.match(/(上午|下午|凌晨|中午|早上|晚上)?\d{1,2}:\d{2}/);
  const timeOfDay = timeMatch ? timeMatch[0].trim() : null;
  if (timeMatch) rest = rest.replace(timeMatch[0], " ");
  // drop editorial markers that trail the place (已声明原创/拍摄于/信息来自作者…)
  rest = rest.replace(/已声明原创|拍摄于[^，。；]*|信息来自作者自主声明|信息来自作者|编辑于/g, " ");
  // location = a real place run, NOT an arbitrary CJK grab-bag (which would
  // swallow the editorial markers above). XHS emits provinces bare (河南 not
  // 河南省) and municipalities/cities with their suffix — accept both.
  const PROVINCES =
    "北京|天津|上海|重庆|河北|河南|云南|辽宁|吉林|黑龙江|湖南|湖北|山东|山西|江苏|浙江|安徽|福建|江西|广东|广西|海南|四川|贵州|甘肃|青海|陕西|内蒙古|宁夏|新疆|西藏|香港|澳门|台湾";
  const LOCATION_RE = new RegExp(
    `((?:${PROVINCES})|(?:[一-龥]{2,7}(?:省|自治区|特别行政区|市|地区|自治州|县|区|盟)))$`
  );
  const locMatch = rest.trim().match(LOCATION_RE);
  const location = locMatch ? locMatch[0].trim() : null;
  return { date, timeOfDay, location, raw: s };
}

/**
 * Parse visible comment rows from flattened detail-dump nodes.
 * Geometry per live comment panel (fast-operator live-copy + 05 samples):
 *   short row starts an item (username); the next longer row below is the
 *   body; a short row matching a time shape ("2天前", "09-02", optionally
 *   "… 回复") attaches to the item above; a narrow pure-digit row is its
 *   like count. Chrome rows (共 N 条评论 / 说点什么 / 回复 / 置顶) never
 *   become items. Accepts both text= and content-desc= carriers.
 */
export function parseCommentRows(nodes, { maxComments = 200 } = {}) {
  const items = [];
  let current = null;
  const pool = [...nodes];
  const W = pool.reduce((max, n) => Math.max(max, n.R), 0) || 1080;
  const sorted = pool
    .filter((n) => String(n.text || "").trim() || String(n.desc || "").trim())
    .sort((a, b) => a.cy - b.cy || a.cx - b.cx);

  for (const n of sorted) {
    const content = (String(n.text || "").trim() || String(n.desc || "").trim());
    // like-count column: narrow pure digit (or "赞") on the right side
    if (/^\d+$/.test(content) && n.w <= Math.round(0.25 * W) && n.cx > 0.4 * W) {
      if (current) current.likes = parseCountText(content);
      continue;
    }
    if (UI_LABEL.test(content) || COMMENT_CHROME_RE.test(content) || /^\d+$/.test(content)) continue;
    if (/^回复$/.test(content)) continue;
    if (COMMENT_TIME_FULL_RE.test(content) && content.length <= 20) {
      if (current) {
        current.timeText = content.trim();
      }
      continue;
    }
    if (!current) {
      current = { user: content.slice(0, 40), text: null, timeText: null, likes: null, y: n.cy };
      continue;
    }
    if (current.text == null && content.length >= current.user.length) {
      current.text = content.slice(0, 500);
      continue;
    }
    // another short row → previous item was user-only; start the next item
    items.push(current);
    if (items.length >= maxComments) return items;
    current = { user: content.slice(0, 40), text: null, timeText: null, likes: null, y: n.cy };
  }
  if (current) items.push(current);
  return items;
}

/**
 * Shared extraction core: v1 fields only (title/author/body/date/interactions).
 * @param {string} xml uiautomator dump XML
 * @param {{ maxBodyChars?: number }} [opts]
 */
function extractRecordCore(xml, opts = {}) {
  const maxBodyChars = opts.maxBodyChars ?? BODY_MAX_CHARS;
  const nodes = allNodes(String(xml || ""));
  const H = screenHeight(nodes);
  const W = nodes.reduce((max, n) => Math.max(max, n.R), 0) || 1080;
  // Live detail dumps (device 04, 2026-09-02) carry body/date content in
  // content-desc with text="" — read one unified content view per node.
  const contentOf = (n) => String(n.text || "").trim() || String(n.desc || "").trim();
  const contentNodes = nodes.filter((n) => contentOf(n));

  const byRid = (re) =>
    nodes.find((n) => n.rid && re.test(n.rid) && contentOf(n)) || null;

  // --- section anchors from the live detail layout (device 04, 2026-09-02):
  // media a11y line ("图片,第N张..." / "视频,..."), related-search label
  // ("猜你想搜"), bottom bar. XHS renders the title BELOW the media area
  // (cy ~0.7H), not in a top band — band-based heuristics pick the author.
  const mediaNode = nodes.find((n) => /^(?:图片|视频),/.test(contentOf(n)));
  const mediaBottom = mediaNode ? mediaNode.cy : Math.round(0.25 * H);
  const guessNode = contentNodes.find((n) => contentOf(n) === "猜你想搜");
  const bar = parseBottomBar(String(xml || ""));
  const barTop = Math.min(...[bar.like, bar.collect, bar.comment].filter(Boolean).map((b) => b.T), H);
  const contentEnd = guessNode ? guessNode.cy : barTop;
  const commentHead = contentNodes.find((n) => /^共\s*\d+\s*条评论$/.test(contentOf(n)));
  const commentTop = commentHead ? commentHead.cy : H;

  // Detail-specific chrome: bottom-bar labels, media a11y lines, pure counts,
  // comment-section head. (parseComments-era rules like 话题串 do NOT apply
  // here — a pure-hashtag line under the media is the note body.)
  const isDetailChrome = (t) =>
    UI_LABEL.test(t)
    || /^(不喜欢|已声明原创|实况|置顶)$/.test(t)
    || /^(图片|视频),/.test(t)
    || /^共\s*\d+\s*条评论$/.test(t)
    || /^\d+$/.test(t);
  const contents = contentNodes
    .map((n) => ({ ...n, content: contentOf(n) }))
    .filter((n) => !isDetailChrome(n.content) && n.cy < commentTop);

  // --- title: rid first; when the media a11y line is present, topmost
  // non-hashtag text between media and the related-search section; otherwise
  // fall back to the legacy top band (text-note dumps without media markers).
  const titleRid = byRid(/title|main_content/i);
  const titleCands = mediaNode
    ? contents
        .filter((n) => n.cy >= mediaBottom && n.cy < contentEnd && n.content.length >= 4)
        .sort((a, b) => a.cy - b.cy || b.content.length - a.content.length)
    : [];
  const legacyCands = contents.filter((n) => n.cy < 0.35 * H);
  const legacyNode =
    legacyCands.filter((n) => n.content.length >= 6).sort((a, b) => a.cy - b.cy || b.content.length - a.content.length)[0]
    || legacyCands.sort((a, b) => a.cy - b.cy || b.content.length - a.content.length)[0]
    || null;
  // with a media marker present, the legacy top band is the AUTHOR row —
  // never fall back to it (live 05 sample: title-less note picked nickNameTV)
  const titleNode = titleRid
    || (mediaNode
      ? titleCands.find((n) => !n.content.startsWith("#")) || titleCands[0] || null
      : legacyNode);
  const title = titleNode?.content.slice(0, 200) || null;

  // --- author: rid first, else short text near the top (below title row) ---
  const authorRid = byRid(/author|nickname|user_name|name/i);
  const authorFallback = contents
    .filter((n) => n !== titleNode && n.content.length <= 24 && n.cy < 0.5 * H && !/^\d+$/.test(n.content))
    .sort((a, b) => a.cy - b.cy)[0] || null;
  const author = (authorRid ? contentOf(authorRid) : authorFallback?.content || "").trim() || null;

  // --- body: longest non-chrome, non-date text between the title and the
  // related-search section (hashtag body lines live directly under the title) ---
  const dateRe = /(\d{4}[-/年]\d{1,2}[-/月]\d{1,2}|\d{1,2}-\d{1,2}|\d+\s*(?:秒|分钟|小时|天|周|个月|年)前|编辑于.{0,12}|(?<!\S)(昨天|前天)(?!\S))/;
  const titleBottom = titleNode?.B ?? mediaBottom;
  const bodyCands = contents.filter(
    (n) => n !== titleNode && n.content !== title && n.cy >= titleBottom && n.cy < contentEnd && !dateRe.test(n.content),
  );
  const bodyNode = bodyCands.reduce(
    (best, n) => (best == null || n.content.length > best.content.length ? n : best),
    null,
  );
  const body = bodyNode ? bodyNode.content.slice(0, maxBodyChars) || null : null;

  // --- publish meta: first timestamp-shaped node above the bottom bar; keep
  // the FULL node content (time+location mix) for v2 postTime parsing ---
  const metaNode = contentNodes.find((n) => n.cy < barTop && DATE_SPAN_RE.test(contentOf(n)));
  const postTime = parsePostTime(metaNode ? contentOf(metaNode) : null);

  // --- interactions from the bottom bar ---
  const likeCount = parseCountText(bar.like?.desc ?? "");
  const collectCount = parseCountText(bar.collect?.desc ?? "");
  const commentCount = parseCountText(bar.comment?.desc ?? "");

  return {
    title,
    author,
    body,
    postTime,
    date: postTime.date,
    interactions: {
      likeCount,
      likeState: likeState(bar.like),
      collectCount,
      commentCount,
    },
    confidence: {
      title: titleRid ? "high" : titleNode ? "medium" : null,
      author: authorRid ? "high" : authorFallback ? "medium" : null,
      body: bodyNode ? (bodyNode.rid ? "high" : "medium") : null,
      date: metaNode ? "medium" : null,
    },
    screen: { width: W, height: H },
    _internals: { nodes, W, H, bar },
  };
}

/**
 * Extract one xhs.note.record.v1 from a note-detail dump (legacy shape).
 */
export function extractNoteRecord(xml, opts = {}) {
  const core = extractRecordCore(xml, opts);
  return {
    schemaId: NOTE_RECORD_SCHEMA_ID,
    sourceDumpHash: xml ? sha256Hex(xml) : null,
    noteFingerprint: sha256Hex(`${core.title ?? ""}|${core.author ?? ""}|${(core.body ?? "").slice(0, 40)}`).slice(0, 16),
    title: core.title,
    author: core.author,
    body: core.body,
    date: core.date,
    interactions: core.interactions,
    confidence: core.confidence,
    screen: core.screen,
  };
}

/**
 * Extract one xhs.note.record.v2: v1 fields + postTime{date,timeOfDay,location}
 * + visible comment rows (user/text/timeText/likes) + commentTotal and
 * commentsTruncated honesty flags.
 */
export function extractNoteRecordV2(xml, opts = {}) {
  const core = extractRecordCore(xml, opts);
  const nodes = core._internals.nodes;
  const commentHead = nodes.find((n) => /^共\s*\d+\s*条评论$/.test(String(n.text || "").trim() || String(n.desc || "").trim()));
  const commentTotal = commentHead
    ? parseCountText(commentHead.text || commentHead.desc)
    : core.interactions.commentCount;
  // visible comment list = strictly between the "共 N 条评论" head and the
  // bottom bar; without the head the panel is not scrolled into view
  const barButtons = [core._internals.bar?.like, core._internals.bar?.collect, core._internals.bar?.comment].filter(Boolean);
  const barTop = barButtons.length ? Math.min(...barButtons.map((b) => b.T)) : core.screen.height;
  const comments = commentHead
    ? parseCommentRows(
        nodes.filter((n) => n.cy >= commentHead.cy && n.cy < barTop),
        { maxComments: opts.maxComments ?? 200 },
      )
    : [];
  const commentCount = core.interactions.commentCount;
  const commentsTruncated = commentCount != null ? commentCount > comments.length : false;

  return {
    schemaId: NOTE_RECORD_SCHEMA_ID_V2,
    sourceDumpHash: xml ? sha256Hex(xml) : null,
    noteFingerprint: sha256Hex(`${core.title ?? ""}|${core.author ?? ""}|${(core.body ?? "").slice(0, 40)}`).slice(0, 16),
    title: core.title,
    author: core.author,
    body: core.body,
    postTime: core.postTime,
    date: core.date,
    interactions: core.interactions,
    comments,
    commentTotal,
    commentsTruncated,
    confidence: core.confidence,
    screen: core.screen,
  };
}

/** Signature check: does this dump look like a note-detail page? */
export function looksLikeNoteDetail(xml) {
  const bar = parseBottomBar(String(xml || ""));
  return Boolean(bar.like || bar.collect || bar.comment);
}