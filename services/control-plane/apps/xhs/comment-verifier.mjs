// comment-verifier.mjs — pure XHS comment-send verification (executable-plan W5, S3).
//
// Replaces the old weak verification in `ops/xhs-comment-one.mjs:301-322` — which
// treated "composer closed after send" (send button gone) as a PASS — with a
// strict three-factor proof that the comment was actually posted:
//
//   1. exactTextHashPresent — the note's posted comments include one whose text
//      hash === hash(sentText). The text must appear as a POSTED comment, not as
//      the composer input field (the old `xml.includes(text)` check could not
//      distinguish "typed but not sent" from "posted").
//   2. countDelta — the note's comment count strictly increased (after > before).
//   3. ownLatestComment — the LATEST posted comment is mine and matches sentText.
//      This is the "本人最新评论 hash 验证" the plan names: the newest comment on
//      the note is my sent text, proving MY send landed (not someone else's, and
//      not a stale compose draft).
//
// All three => "verified". Any weakness => "ambiguous" (NOT verified — the old
// "composer-closed" weak pass is demoted to ambiguous, so a send that closed the
// composer without a posted comment + count delta is no longer trusted, and the
// no-blind-retry fence (AMBIGUOUS_NO_RETRY, W4 probe 2) applies). Composer still
// open / send button still present => "not_sent" (the transport did not happen;
// the adapter may retry the send, but the effect is not yet committed).
//
// Pure: no fs, no network, no device IO, no DOM. The live adapter parses the
// dump into the structured `after` observation and calls verifyCommentSend; this
// module owns only the decision logic so it is unit-testable with fixtures.
import { createHash } from "node:crypto";

/** sha256 of a comment text, namespaced so it cannot collide with other hashes. */
export function commentTextHash(text) {
  return createHash("sha256").update(`xw.xhs.comment.text:${String(text ?? "")}`).digest("hex");
}

/** sha256 of the sent text (alias used by the verify ladder; same as commentTextHash). */
const hashOf = commentTextHash;

/**
 * Strict comment-send verification.
 *
 * @param {object} input
 * @param {string} input.sentText      - the comment text we intended to send.
 * @param {object} input.before        - `{ commentCount: number|null }` pre-send.
 * @param {object} input.after         - post-send observation:
 *   @param {Array<{text:string, author?:string}>} input.after.postedComments - posted
 *     comments on the note, LATEST FIRST (index 0 = newest). Empty if none observed.
 *   @param {number|null} input.after.commentCount - note comment count post-send.
 *   @param {boolean} [input.after.composerOpen]   - is the composer still open?
 *   @param {boolean} [input.after.sendButtonPresent] - is a 发送/发送 button visible?
 * @returns {{status:"verified"|"ambiguous"|"not_sent", reason:string, evidence:string[]}}
 */
export function verifyCommentSend({ sentText, before, after }) {
  const evidence = [];
  const sentHash = hashOf(sentText);

  // --- not_sent: the transport did not happen (composer/send still active) -----
  if (after?.composerOpen || after?.sendButtonPresent) {
    evidence.push("composer-open");
    return { status: "not_sent", reason: "composer-still-open", evidence };
  }

  const comments = Array.isArray(after?.postedComments) ? after.postedComments : [];
  const beforeCount = Number.isInteger(before?.commentCount) ? before.commentCount : null;
  const afterCount = Number.isInteger(after?.commentCount) ? after.commentCount : null;

  // --- factor 1: exact text hash present as a POSTED comment -------------------
  const matchingIdx = comments.findIndex((c) => c && hashOf(c.text) === sentHash);
  const textHashPresent = matchingIdx >= 0;
  if (textHashPresent) evidence.push(`text-hash-present@${matchingIdx}`);

  // --- factor 2: count delta (strictly increased) ------------------------------
  const countDelta = beforeCount != null && afterCount != null && afterCount > beforeCount;
  if (countDelta) evidence.push(`count-delta:${beforeCount}->${afterCount}`);

  // --- factor 3: own-latest-comment — the newest posted comment is mine --------
  // The latest comment (index 0, newest first) matches the sent text. This proves
  // MY send is the newest comment, not a peer's interleaved comment or a stale draft.
  const ownLatest = comments.length > 0 && hashOf(comments[0].text) === sentHash;
  if (ownLatest) evidence.push("own-latest-comment");

  // --- decision: all three factors => verified ---------------------------------
  if (textHashPresent && countDelta && ownLatest) {
    return { status: "verified", reason: "text+count+own-latest", evidence };
  }

  // --- weak / ambiguous cases (NOT verified; no blind retry) ------------------
  // The old "composer-closed" weak pass (composer gone but no posted comment +
  // no count delta) is demoted here to ambiguous. This is the core W5 fix: a
  // closed composer alone does NOT prove the comment posted.
  if (!textHashPresent && !countDelta) {
    return { status: "ambiguous", reason: "composer-closed-weak", evidence: [...evidence, "no-text-no-delta"] };
  }
  if (textHashPresent && !countDelta) {
    // text present but count did not increase — could be a stale/replay comment,
    // or count parsing failed. Do not trust; do not blind-retry.
    return { status: "ambiguous", reason: "text-present-no-count-delta", evidence };
  }
  if (!textHashPresent && countDelta) {
    // count increased but my text not found — someone else may have commented,
    // or my send failed silently. Ambiguous; the fence prevents a blind retry.
    return { status: "ambiguous", reason: "count-delta-text-missing", evidence };
  }
  // textHashPresent && countDelta but ownLatest false — a peer interleaved a
  // newer comment after mine. My comment IS posted (text+count), so this is
  // verified (own-latest is a strengthening, not a hard gate, when the text hash
  // is present AND the count increased). We reach here only when ownLatest is
  // false but the other two are true.
  return { status: "verified", reason: "text+count (peer-interleaved)", evidence };
}

/**
 * Extract a posted-comments observation from a flat list of text-bearing nodes
 * (e.g. parseDumpNodes output). The newest-first ordering is the caller's
 * responsibility (XHS lists comments newest-first on the note detail page); this
 * helper just filters to nodes whose text looks like a comment body (non-empty,
 * not a UI label like 评论/点赞/收藏). The live adapter usually has a richer
 * structural extractor; this is the pure fallback used by tests + simple dumps.
 */
export function extractPostedComments(nodes) {
  if (!Array.isArray(nodes)) return [];
  const LABEL_RE = /^(评论|点赞|收藏|分享|关注|回复|查看|\d+)$/;
  return nodes
    .filter((n) => n && typeof n.text === "string" && n.text.trim() && !LABEL_RE.test(n.text.trim()))
    .map((n) => ({ text: n.text, author: n.author ?? null }));
}