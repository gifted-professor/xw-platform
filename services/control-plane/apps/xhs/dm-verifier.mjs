// dm-verifier.mjs — pure XHS DM (私信) reply verification (executable-plan W5, S3).
//
// The old `ops/xhs-dm-user.mjs` matched the target user with a FUZZY ladder —
// exact → includes(user) → user.slice(0,4) partial (lines 216-221) — and verified
// the send with "tapped-send" / "input-cleared" weak passes (lines 340-344). W5
// forbids both:
//
//   PRE-SEND GATES (decideDmReplySend — "username contains/maybe 禁入 send"):
//     * usernameMatch MUST be exact. contains / partial / maybe => NO SEND
//       (USERNAME_FUZZY). This prevents replying to the wrong person when the
//       target name is a substring of another user's name (e.g. "天才" inside
//       "天才较瘦", or a 4-char prefix collision).
//     * the thread MUST be unique (exactly one thread matches the fingerprint).
//       0 or >1 matches => NO SEND (THREAD_NOT_UNIQUE) — the W3 "唯一才进，不唯一
//       stop" gate, now bound into the DM send decision.
//     * the thread's last-message fingerprint MUST match the expected (the last
//       message observed when we decided to reply). If it drifted — someone (the
//       peer) replied in between — => NO SEND (LAST_MESSAGE_DRIFT). This prevents
//       replying to a conversation that has moved on (stale-context reply).
//
//   POST-SEND VERIFY (verifyDmReplySend):
//     * the thread's NEW last-message fingerprint === hash(sentText). My reply is
//       now the last message. If not => ambiguous (the reply did not land as the
//       newest message; no blind retry).
//
// The thread + last-message fingerprints come from `xhs-thread-fingerprint.mjs`
// (W3), formalized here as the DM binding's identity layer (the plan's "inbox/
// read thread fingerprint 补齐 — W3 部分的正式化"). The post-send verify reuses
// `lastMessageFingerprintOf` so "my reply is the last message" is checked with
// the SAME fingerprint scheme the pre-send drift check uses — one identity layer,
// not two. Pure: no fs/net/device IO.
import { lastMessageFingerprintOf } from "../../../orchestrator/scripts/lib/xhs-thread-fingerprint.mjs";

/**
 * The expected last-message fingerprint AFTER a successful reply: the thread's
 * newest message is now my sent text, so lastMessageFingerprintOf({snippet:
 * sentText}) must equal the observed post-send last-message fingerprint. Using
 * the shared W3 scheme keeps the pre-send drift check and post-send verify on
 * one identity layer (the `xw.xhs.lastmsg:` namespace).
 */
export function expectedReplyLastMessageFingerprint(sentText) {
  return lastMessageFingerprintOf({ snippet: sentText });
}

/**
 * Classify how `observed` matches the `target` username.
 *   "exact"  — observed === target (after trim+collapse whitespace).
 *   "fuzzy"  — target is a substring of observed, or observed startsWith a
 *              4-char+ prefix of target, but NOT exact. This is the forbidden
 *              "contains/maybe" case — a name that merely CONTAINS the target.
 *   "none"   — no relationship.
 *
 * The old ops ladder (xhs-dm-user.mjs:216-221) accepted fuzzy; W5 forbids it.
 * Send requires "exact" only.
 */
export function usernameMatch(target, observed) {
  const norm = (s) => String(s ?? "").trim().replace(/\s+/g, " ");
  const t = norm(target);
  const o = norm(observed);
  if (!t || !o) return "none";
  if (o === t) return "exact";
  // fuzzy: one contains the other, or a 4-char+ prefix collision. These are the
  // cases the old ladder's `.includes(user)` / `user.slice(0,4)` would have hit.
  if (o.includes(t) || t.includes(o)) return "fuzzy";
  if (t.length >= 4 && o.startsWith(t.slice(0, 4))) return "fuzzy";
  if (o.length >= 4 && t.startsWith(o.slice(0, 4))) return "fuzzy";
  return "none";
}

/**
 * PRE-SEND decision for a DM reply. Returns { send, reason }. `send=false` means
 * the reply MUST NOT be sent (a binding gate failed); the adapter stops and
 * reports the reason. `send=true` means proceed to send + post-send verify.
 *
 * @param {object} input
 * @param {string} input.targetUsername   - the intended recipient's display name.
 * @param {string} input.observedUsername - the username shown on the open thread.
 * @param {number} input.threadMatchCount - how many inbox threads matched the
 *   target fingerprint (1 = unique, 0 = none, >1 = ambiguous). From resolveUniqueThread.
 * @param {string} input.expectedLastMessageFingerprint   - last-msg fp when we
 *   decided to reply (the W3 lastMessageFingerprintOf of the thread entry then).
 * @param {string} input.observedLastMessageFingerprint    - last-msg fp on the
 *   open thread NOW.
 */
export function decideDmReplySend({
  targetUsername,
  observedUsername,
  threadMatchCount,
  expectedLastMessageFingerprint,
  observedLastMessageFingerprint,
}) {
  const match = usernameMatch(targetUsername, observedUsername);
  if (match !== "exact") {
    return { send: false, reason: match === "fuzzy" ? "USERNAME_FUZZY" : "USERNAME_NONE" };
  }
  if (threadMatchCount !== 1) {
    return { send: false, reason: threadMatchCount === 0 ? "THREAD_NOT_UNIQUE" : "THREAD_AMBIGUOUS" };
  }
  if (observedLastMessageFingerprint !== expectedLastMessageFingerprint) {
    return { send: false, reason: "LAST_MESSAGE_DRIFT" };
  }
  return { send: true, reason: "proceed" };
}

/**
 * POST-SEND verification for a DM reply. The thread's newest last-message
 * fingerprint must equal the hash of the sent text (my reply is now the last
 * message). "tapped-send" / "input-cleared" alone (the old weak passes) do NOT
 * verify — they are demoted to ambiguous.
 *
 * @param {object} input
 * @param {string} input.sentText               - the reply text we sent.
 * @param {string} input.afterLastMessageFingerprint - the thread's last-msg fp
 *   observed AFTER the send.
 * @param {boolean} [input.composerOpen]        - is the composer still open?
 * @param {boolean} [input.sendButtonPresent]  - is a 发送 button still visible?
 * @returns {{status:"verified"|"ambiguous"|"not_sent", reason:string, evidence:string[]}}
 */
export function verifyDmReplySend({ sentText, afterLastMessageFingerprint, composerOpen, sendButtonPresent }) {
  const evidence = [];
  if (composerOpen || sendButtonPresent) {
    return { status: "not_sent", reason: "composer-still-open", evidence: ["composer-open"] };
  }
  const expected = expectedReplyLastMessageFingerprint(sentText);
  if (afterLastMessageFingerprint === expected) {
    return { status: "verified", reason: "last-message-is-mine", evidence: ["last-msg-hash-match"] };
  }
  // The old "tapped-send" / "input-cleared" weak passes land here: the composer
  // closed / input cleared, but the last message is NOT my reply. Ambiguous —
  // do not blind-retry (the AMBIGUOUS_NO_RETRY fence from W4 applies).
  return { status: "ambiguous", reason: "last-message-not-mine", evidence: ["last-msg-hash-mismatch"] };
}