// social-verifiers.mjs — pure XHS social state verifiers (executable-plan W4, F3).
//
// Extracted from the old ops scripts so the control-plane adapter and the ECP
// share ONE source of truth for the "already-true skip" decision, and the old
// `xhs-{like,collect,follow,engage}-one.mjs` explorer scripts are no longer the
// live backdoor for social effects. The classifier semantics are faithful to the
// originals in `ops/_xhs-parse.mjs` (likeState:136-142, followState:503-509) and
// `ops/xhs-collect-one.mjs:88-93` (collectState, previously duplicated in
// xhs-engage-one.mjs) — same regex, same order — so behavior does not drift.
//
// The already-true skip (plan V2 §5.4 / F3 acceptance "already-true verified
// skip"): if the serve reports the target is ALREADY in the desired terminal
// state (liked / collected / followed), the workflow skips the tap entirely — no
// transport, no ECP reservation, no retry. This is the idempotent short-circuit
// that makes a re-run of an already-completed like/collect/follow a zero-effect
// no-op rather than a double-send.
//
// Pure: no fs, no network, no device IO. Tested directly + consumed by the
// adapter verify path and the dispatcher's run-time decision ladder.

/**
 * like state classifier (faithful to _xhs-parse.mjs:136-142).
 * "已点赞" -> "liked" (terminal); "点赞" -> "unliked"; "" -> "missing"; else "unknown".
 * 已点赞 is checked BEFORE 点赞 because "已点赞" contains the "点赞" substring.
 */
export function likeState(descOrBtn) {
  const desc = typeof descOrBtn === "string" ? descOrBtn : descOrBtn?.desc;
  if (!desc) return "missing";
  if (/已点赞/.test(desc)) return "liked";
  if (/点赞/.test(desc)) return "unliked";
  return "unknown";
}

/**
 * collect state classifier (faithful to xhs-collect-one.mjs:88-93).
 * "已收藏" -> "collected" (terminal); "收藏" -> "uncollected"; "" -> "missing"; else "unknown".
 */
export function collectState(desc) {
  const s = typeof desc === "string" ? desc : desc?.desc;
  if (!s) return "missing";
  if (/已收藏/.test(s)) return "collected";
  if (/收藏/.test(s)) return "uncollected";
  return "unknown";
}

/**
 * follow state classifier (faithful to _xhs-parse.mjs:503-509).
 * "已关注"|"相互关注" -> "followed" (terminal, checked first to avoid the "关注"
 * substring false-positive); "关注"|"回关" -> "unfollowed"; "" -> "missing"; else "unknown".
 *
 * NOTE: this is a substring/regex classifier. To avoid false positives like
 * "关注的话题" (which contains "关注" but is NOT a follow button), callers that
 * locate the button from a dump MUST use an EXACT-set locator (FOLLOW_LABELS =
 * new Set(["关注","已关注","回关","相互关注"]) on the node's text/desc) and then pass
 * the matched label here. see findFollowBtn in _xhs-parse.mjs:374-391.
 */
export function followState(desc) {
  const s = String(desc ?? "");
  if (!s) return "missing";
  if (/已关注|相互关注/.test(s)) return "followed";
  if (/关注|回关/.test(s)) return "unfollowed";
  return "unknown";
}

/** The terminal already-true state for each social action. */
export const ALREADY_TRUE_STATE = Object.freeze({
  like: "liked",
  collect: "collected",
  follow: "followed",
});

/** The classifier for each social action. */
export const STATE_CLASSIFIER = Object.freeze({
  like: likeState,
  collect: collectState,
  follow: followState,
});

/**
 * Is `beforeState` the already-true terminal for `action`?
 * The idempotent skip guard: true => the target is already in the desired state.
 */
export function isAlreadyTrue(action, beforeState) {
  return ALREADY_TRUE_STATE[action] === beforeState;
}

/**
 * The F3 already-true skip decision. Given a social action + the serve-reported
 * beforeState, returns { skip, reason, transport }:
 *   - skip=true  when already-true (liked/collected/followed): no tap, no ECP
 *     reservation, no retry. reason="already-<action>".
 *   - skip=false when the target is in the actionable pre-state (unliked /
 *     uncollected / unfollowed): proceed to the ECP strict reservation + single
 *     transport. reason="proceed".
 *   - skip=false, reason="unknown-state" when the state is missing/unknown: the
 *     caller must NOT blind-tap; it re-observes (REPLAN) rather than skipping.
 *
 * This is the decision the run-time ladder makes BEFORE calling beginMissionEffect:
 * an already-true target never enters the ECP, so perTargetCount=1 is never
 * consumed against an already-completed target — the budget guards a genuine
 * state transition, not a redundant one.
 */
export function socialEffectDecision({ action, beforeState }) {
  const terminal = ALREADY_TRUE_STATE[action];
  if (!terminal) {
    return { skip: false, reason: "unknown-action", transport: 0 };
  }
  if (beforeState === terminal) {
    return { skip: true, reason: `already-${action}`, transport: 0 };
  }
  const actionable = { like: "unliked", collect: "uncollected", follow: "unfollowed" }[action];
  if (beforeState === actionable) {
    return { skip: false, reason: "proceed", transport: 1 };
  }
  // missing / unknown / unexpected => do NOT blind-tap; re-observe.
  return { skip: false, reason: "unknown-state", transport: 0 };
}