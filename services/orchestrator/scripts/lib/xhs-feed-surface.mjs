/**
 * xhs-feed-surface.mjs — page/media surface classifier for the 04 XHS feed
 * routine (direct-routine plan V2 §5). Pure: XML dump + focus string in,
 * classification out. No device I/O, no coordinates guessing.
 *
 * Decision ladder (plan V2 §5) — the classifier is rungs 1–2; vision shadow
 * (S4) adds rung 3; R0 one-shot permit adds rung 4; anything unresolved is
 * UNKNOWN -> the machine skips or STOPs, never guesses.
 *
 * Rules implemented (plan V2 §5):
 *   HOME_FEED   = package com.xingin.xhs + IndexActivityV2 + (feed cards>0 or
 *                 explicit empty state).
 *   feed card   = unique content-desc starting 视频/笔记 -> video|note;
 *                 conflict / duplicate / missing -> UNKNOWN.
 *   IMAGE_NOTE  = NoteDetailActivity + detail anchors (bottom-bar
 *                 like/comment controls), and no conflict with the source
 *                 card kind (video card -> never IMAGE_NOTE).
 *   VIDEO_NOTE  = DetailFeedActivity AND (video surface node OR source card
 *                 is video); the activity alone is NOT sufficient.
 *   comments    = image-note comment area requires a comment marker or
 *                 parseable comment rows before any bounded swipe. Video main
 *                 surface NEVER swipes up for comments; a unique explicit
 *                 comment control must be located and asserted first.
 *   forbidden   = NoteCommentActivity, publish editor, product/带货 entry,
 *                 system overlay, login/captcha/risk pages -> these are not
 *                 read-only comment surfaces; the machine must exit or STOP.
 *   Visual output can never authorize like/comment-send effect controls;
 *   effects go through the typed capability only (S2+).
 */
import { createHash } from "node:crypto";
import { parseFeedCards, parseBottomBar, parseComments } from "../../ops/_xhs-parse.mjs";

export const XHS_PACKAGE = "com.xingin.xhs";

export const PAGE_CLASS = Object.freeze({
  HOME_FEED: "HOME_FEED",
  HOME_FEED_EMPTY: "HOME_FEED_EMPTY",
  IMAGE_NOTE: "IMAGE_NOTE",
  VIDEO_NOTE: "VIDEO_NOTE",
  COMMENT_PANEL: "COMMENT_PANEL",
  NOTE_COMMENT_ACTIVITY: "NOTE_COMMENT_ACTIVITY",
  PUBLISH_EDITOR: "PUBLISH_EDITOR",
  PRODUCT_ENTRY: "PRODUCT_ENTRY",
  SYSTEM_OVERLAY: "SYSTEM_OVERLAY",
  AUTH_RISK: "AUTH_RISK",
  UNKNOWN: "UNKNOWN",
});

export const CARD_KIND = Object.freeze({
  VIDEO: "video",
  NOTE: "note",
  UNKNOWN: "UNKNOWN",
});

/** Page markers that mean "not a read-only comment surface" (plan V2 §5). */
const FORBIDDEN_MARKERS = Object.freeze([
  { page: PAGE_CLASS.NOTE_COMMENT_ACTIVITY, activityRe: /NoteCommentActivity/i },
  // xml markers must be publish-editor-distinctive: a bare "发布" also appears
  // in the persistent feed bottom navigation (首页|市集|发布|消息) and would
  // misclassify every main-screen feed dump (live R1 finding, 2026-08-28).
  { page: PAGE_CLASS.PUBLISH_EDITOR, activityRe: /(?:Publish|Edit)Activity|NoteEdit|PublishActivity/i, xmlRe: /(?:从相册选择|拍摄与直播|写文字|编辑器|说点什么，分享你的生活)/ },
  { page: PAGE_CLASS.PRODUCT_ENTRY, xmlRe: /(?:商品|带货|购买|加入购物车|立即购买)/ },
  { page: PAGE_CLASS.AUTH_RISK, xmlRe: /(?:验证码|安全验证|异常行为|账号存在风险|解除限制|登录后操作)/ },
]);

function isXhsPackage(pkg) {
  return String(pkg || "").includes(XHS_PACKAGE);
}

function isFeedFocus(focus) {
  return /IndexActivityV2/i.test(focus || "");
}

function isNoteDetailFocus(focus) {
  return /NoteDetailActivity|notedetail/i.test(focus || "");
}

function isVideoDetailFocus(focus) {
  return /DetailFeedActivity/i.test(focus || "");
}

function hasOverlayWindow(xml) {
  // system overlay/dialog windows render as separate window roots or masked
  // Dialog frames on top of the activity content
  return /class="[^"]*(?:AlertDialog|DialogWindow|PopupWindow)/i.test(xml || "");
}

/**
 * Classify the current page from a fresh dump + focus.
 * @param {object} input
 * @param {string} input.xml - uiautomator dump XML (fresh, same session)
 * @param {string} input.focus - "package/activity" from dumpsys currentFocus
 * @param {string} [input.pkg] - package override if focus lacks it
 * @param {string|null} [input.sourceCardKind] - video|note|UNKNOWN from the
 *        feed card that was tapped (conflict guard for detail assertion)
 * @returns {{page: string, evidence: string[], cards?: array, reason?: string}}
 */
export function classifyPage({ xml = "", focus = "", pkg = null, sourceCardKind = null } = {}) {
  const evidence = [];
  const activity = String(focus || "").split("/").pop() || "";
  const pkgOk = isXhsPackage(pkg) || isXhsPackage(focus);
  if (!pkgOk) {
    return { page: PAGE_CLASS.UNKNOWN, evidence: ["package_not_xhs"], reason: "package drift — not com.xingin.xhs" };
  }
  evidence.push(`activity=${activity || "unknown"}`);

  if (hasOverlayWindow(xml)) {
    evidence.push("overlay_window_root");
    return { page: PAGE_CLASS.SYSTEM_OVERLAY, evidence };
  }
  // forbidden / non-read-only surfaces first — they win over detail heuristics.
  // PRODUCT_ENTRY is checked after the feed branch below: the main feed mixes
  // commerce cards into the list and a card title mentioning 商品/购买 must not
  // misclassify the whole read-only feed screen (live R1 finding, 2026-08-28).
  for (const m of FORBIDDEN_MARKERS) {
    if (m.page === PAGE_CLASS.PRODUCT_ENTRY) continue;
    if (m.activityRe && m.activityRe.test(activity)) {
      evidence.push(`forbidden_activity:${m.page}`);
      return { page: m.page, evidence };
    }
    if (m.xmlRe && m.xmlRe.test(xml)) {
      evidence.push(`forbidden_marker:${m.page}`);
      return { page: m.page, evidence };
    }
  }

  if (isFeedFocus(focus) && isXhsPackage(focus || pkg)) {
    const cards = parseFeedCards(xml);
    if (cards.length > 0) {
      evidence.push(`feed_cards=${cards.length}`);
      return { page: PAGE_CLASS.HOME_FEED, evidence, cards };
    }
    if (/没有更多|暂无内容|空空如也|没有更多|网络不给力/.test(xml)) {
      evidence.push("explicit_empty_state");
      return { page: PAGE_CLASS.HOME_FEED_EMPTY, evidence, cards };
    }
    evidence.push("index_focus_without_feed_evidence");
    return { page: PAGE_CLASS.UNKNOWN, evidence, cards };
  }

  // commerce/product surfaces are still forbidden on every non-feed surface
  const productMarker = FORBIDDEN_MARKERS.find((m) => m.page === PAGE_CLASS.PRODUCT_ENTRY);
  if (productMarker.xmlRe.test(xml)) {
    evidence.push("forbidden_marker:PRODUCT_ENTRY");
    return { page: PAGE_CLASS.PRODUCT_ENTRY, evidence };
  }

  // Note detail (image note): NoteDetailActivity + detail anchors
  if (isNoteDetailFocus(focus)) {
    const bar = parseBottomBar(xml);
    const anchors = Boolean(bar.like) && (Boolean(bar.comment) || Boolean(bar.commentBox));
    if (!anchors) {
      evidence.push("note_detail_focus_without_anchors");
      return { page: PAGE_CLASS.UNKNOWN, evidence };
    }
    evidence.push("detail_anchors=like+comment");
    if (sourceCardKind === CARD_KIND.VIDEO) {
      // a video feed card must never assert as an image note
      evidence.push("source_card_kind_conflict=video");
      return { page: PAGE_CLASS.UNKNOWN, evidence };
    }
    const comments = parseComments(xml);
    if (comments.items.length > 0 || comments.count != null) {
      evidence.push("comment_rows_present");
    }
    return { page: PAGE_CLASS.IMAGE_NOTE, evidence, comments, commentControl: bar.comment || null };
  }

  // Video detail: DetailFeedActivity + video surface (activity alone insufficient)
  if (isVideoDetailFocus(focus)) {
    const hasVideoSurface = /class="[^"]*(?:VideoView|TextureView|SurfaceView)/i.test(xml)
      || /content-desc="[^"]*(?:播放|暂停|视频进度)[^"]*"/.test(xml);
    const cardIsVideo = sourceCardKind === CARD_KIND.VIDEO;
    if (!hasVideoSurface && !cardIsVideo) {
      evidence.push("detailfeed_without_video_evidence");
      return { page: PAGE_CLASS.UNKNOWN, evidence };
    }
    evidence.push(hasVideoSurface ? "video_surface" : "source_card_video");
    const bar = parseBottomBar(xml);
    return { page: PAGE_CLASS.VIDEO_NOTE, evidence, commentControl: bar.comment || null };
  }

  evidence.push("unrecognized_focus");
  return { page: PAGE_CLASS.UNKNOWN, evidence };
}

/**
 * Classify a feed card's media kind from its content-desc, enforcing the
 * uniqueness rule: conflict (both 视频 and 笔记 markers), duplicates, or
 * missing desc -> UNKNOWN (never guess).
 */
export function classifyCardKind(cardDescs) {
  const descs = (cardDescs || []).filter(Boolean);
  if (descs.length === 0) return { kind: CARD_KIND.UNKNOWN, reason: "desc_missing" };
  const unique = [...new Set(descs.map((d) => String(d).trim()))];
  if (unique.length > 1) return { kind: CARD_KIND.UNKNOWN, reason: "desc_conflict" };
  const d = unique[0];
  const isVideo = /^视频/.test(d);
  const isNote = /^笔记/.test(d);
  if (isVideo && isNote) return { kind: CARD_KIND.UNKNOWN, reason: "kind_conflict" };
  if (isVideo) return { kind: CARD_KIND.VIDEO, reason: "desc_prefix=视频" };
  if (isNote) return { kind: CARD_KIND.NOTE, reason: "desc_prefix=笔记" };
  return { kind: CARD_KIND.UNKNOWN, reason: "desc_prefix_missing" };
}

/**
 * Comment-entry decision for a detail page (plan V2 §5):
 *   - IMAGE_NOTE: allowed only when a comment marker or parseable rows exist.
 *   - VIDEO_NOTE: a direct swipe-up is NEVER allowed; only a unique explicit
 *     comment control (exactly one 评论 button) may be asserted into a panel.
 * @returns {{ allowed: boolean, mode: "rows"|"control"|null, reason: string,
 *             control?: {x,y,desc} }}
 */
export function commentEntryDecision({ page, xml, commentControl = null } = {}) {
  const ctrl = commentControl || parseBottomBar(xml).comment || null;
  if (page === PAGE_CLASS.IMAGE_NOTE) {
    const comments = parseComments(xml);
    if (comments.count != null || comments.items.length > 0) {
      return { allowed: true, mode: "rows", reason: "comment_rows_parseable" };
    }
    if (ctrl) {
      return { allowed: true, mode: "control", reason: "unique_comment_control", control: ctrl };
    }
    return { allowed: false, mode: null, reason: "comment_marker_missing" };
  }
  if (page === PAGE_CLASS.VIDEO_NOTE) {
    if (!ctrl) {
      return { allowed: false, mode: null, reason: "video_comment_control_missing" };
    }
    return { allowed: true, mode: "control", reason: "unique_comment_control", control: ctrl };
  }
  return { allowed: false, mode: null, reason: `page_not_commentable:${page}` };
}

/**
 * Target binding for an effect: fingerprint of the discovered target, derived
 * only from the fresh authoritative observation (plan V2 §7.4). The caller
 * may not self-report arbitrary fingerprints.
 */
export function bindTargetFingerprint({ cardTitle = "", cardAuthor = "", cardCenter = null, pageEvidence = "" } = {}) {
  return createHash("sha256")
    .update([cardTitle, cardAuthor, cardCenter ? `${cardCenter.x},${cardCenter.y}` : "", pageEvidence].join("\0"))
    .digest("hex");
}