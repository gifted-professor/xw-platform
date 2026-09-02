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
 * Reuses the shared parsing idioms in orchestrator ops/_xhs-parse.mjs (the
 * single parser source on this side of the repo).
 */
import { createHash } from "node:crypto";

import {
  allNodes,
  likeState,
  parseBottomBar,
} from "../../ops/_xhs-parse.mjs";

export const NOTE_RECORD_SCHEMA_ID = "xhs.note.record.v1";
export const BODY_MAX_CHARS = 2000;

/** Bottom-bar / nav chrome labels that are never content. */
const UI_LABEL =
  /^(关注|已关注|回关|相互关注|点赞|已点赞|收藏|已收藏|评论|分享|说点什么|说点什么\.\.\.|评论框|发送|发布|下一步|返回|首页|消息|我|展开|收起|查看更多评论|作者|置顶|回复|赞|抢首评|首评)$/;

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

/**
 * Extract one xhs.note.record.v1 from a note-detail dump.
 *
 * @param {string} xml uiautomator dump XML
 * @param {{ maxBodyChars?: number }} [opts]
 * @returns {object} record (schemaId xhs.note.record.v1)
 */
export function extractNoteRecord(xml, opts = {}) {
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
  const titleNode = titleRid
    || titleCands.find((n) => !n.content.startsWith("#"))
    || titleCands[0]
    || legacyNode
    || null;
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

  // --- date: first timestamp-shaped text above the bottom bar (publish meta
  // lines sit low on detail screens and mix in location/原创 markers — surface
  // only the matched span, not the whole concatenated node) ---
  const dateSpanRe = /\d+\s*(?:秒|分钟|小时|天|周|个月|年)前|编辑于.{0,12}|(?:昨天|前天|今天)\s*[^，。;；已]{0,10}|\d{4}[-/年]\d{1,2}[-/月]\d{1,2}[日号]?|\d{1,2}-\d{1,2}/;
  const dateNode = contentNodes.find((n) => n.cy < barTop && dateSpanRe.test(contentOf(n)));
  const date = dateNode ? (contentOf(dateNode).match(dateSpanRe)?.[0] ?? "").trim() || null : null;

  // --- interactions from the bottom bar ---
  const likeCount = parseCountText(bar.like?.desc ?? "");
  const collectCount = parseCountText(bar.collect?.desc ?? "");
  const commentCount = parseCountText(bar.comment?.desc ?? "");

  return {
    schemaId: NOTE_RECORD_SCHEMA_ID,
    sourceDumpHash: xml ? sha256Hex(xml) : null,
    noteFingerprint: sha256Hex(`${title ?? ""}|${author ?? ""}`).slice(0, 16),
    title,
    author,
    body,
    date,
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
      date: dateNode ? "medium" : null,
    },
    screen: { width: W, height: H },
  };
}

/** Signature check: does this dump look like a note-detail page? */
export function looksLikeNoteDetail(xml) {
  const bar = parseBottomBar(String(xml || ""));
  return Boolean(bar.like || bar.collect || bar.comment);
}