/**
 * xhs-feed-routine-machine.mjs — CP-owned deterministic XHSFeedRoutineMachine
 * (direct-routine plan V2 §4/§6). NOT an Agent: no model chooses the next
 * step. State transitions, loop bounds, dwell range, probabilities and stop
 * reasons are all decided by the sealed plan.
 *
 * Pure module: the machine never touches a device. All device interaction
 * goes through the injected session-bound `driver` (Explorer primitives /
 * FastOperator semantics); tests inject a scripted fake driver.
 *
 * States (plan V2 §4):
 *   ENSURE_FEED -> REFRESH_CAPTURE -> DISCOVER_VISIBLE_CARDS -> PICK_SEEDED_TARGET
 *   -> OPEN_BOUND_TARGET -> ASSERT_DETAIL_KIND -> DWELL -> MAYBE_READ_COMMENTS
 *   -> MAYBE_DRAFT_COMMENT -> MAYBE_COMMIT_EFFECT -> BACK_VERIFY_FEED
 *   -> NEXT_OR_CLOSEOUT
 *
 * Invariants (plan V2 §10.4):
 *   - each item is opened at most once per run;
 *   - video main surface comment swipe count = 0 (control-tap path only);
 *   - dwell and comment screens bounded by plan;
 *   - back must semantically confirm the feed, else closeout partial/blocked;
 *   - UNKNOWN surfaces -> skip or STOP, never coordinate guessing;
 *   - effect steps (S1): transport 0, recorded as deferred with reason;
 *   - seeded sampling is deterministic: same seed + observations -> same picks,
 *     and the seed + picks are recorded in the receipt for replay.
 */
import {
  PAGE_CLASS,
  CARD_KIND,
  classifyPage,
  classifyCardKind,
  commentEntryDecision,
  bindTargetFingerprint,
} from "./xhs-feed-surface.mjs";
import { seedToRngState } from "./xhs-routine-plan.mjs";

export const ROUTINE_MACHINE_STATE = Object.freeze({
  ENSURE_FEED: "ENSURE_FEED",
  REFRESH_CAPTURE: "REFRESH_CAPTURE",
  DISCOVER_VISIBLE_CARDS: "DISCOVER_VISIBLE_CARDS",
  PICK_SEEDED_TARGET: "PICK_SEEDED_TARGET",
  OPEN_BOUND_TARGET: "OPEN_BOUND_TARGET",
  ASSERT_DETAIL_KIND: "ASSERT_DETAIL_KIND",
  DWELL: "DWELL",
  MAYBE_READ_COMMENTS: "MAYBE_READ_COMMENTS",
  MAYBE_DRAFT_COMMENT: "MAYBE_DRAFT_COMMENT",
  MAYBE_COMMIT_EFFECT: "MAYBE_COMMIT_EFFECT",
  BACK_VERIFY_FEED: "BACK_VERIFY_FEED",
  NEXT_OR_CLOSEOUT: "NEXT_OR_CLOSEOUT",
  CLOSEOUT: "CLOSEOUT",
});

export const ROUTINE_TERMINAL = Object.freeze(["SUCCEEDED", "FAILED", "CANCELLED", "BLOCKED"]);

/** mulberry32 — small deterministic PRNG; state derived from the plan seed. */
function mulberry32(state) {
  let a = state >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashOf(s) {
  // cheap stable 32-bit hash for target ordering keys (replay only)
  let h = 0;
  const str = String(s || "");
  for (let i = 0; i < str.length; i += 1) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}
void hashOf;

function defaultClock() {
  return {
    nowMs: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

/**
 * Create a routine run executor.
 * @param {object} input
 * @param {object} input.plan - sealed plan from planRoutine/acceptSealedRoutinePlan
 * @param {object} input.driver - session-bound primitives:
 *   { ensureFeed(), refresh(), dump({label}), tapAt({x,y}), back(),
 *     waitFor(ms) } — every primitive returns an observation; the machine
 *     classifies and decides.
 * @param {object} [input.clock] - { nowMs(), sleep(ms) } (tests inject fake)
 * @param {object} [input.effects] - S2+ commitRoutineEffect bridge; when
 *        absent, effect steps are recorded as deferred (transport 0).
 */
export function createRoutineRun({ plan, driver, clock = defaultClock(), effects = null, limits = {} } = {}) {
  if (!plan || plan.ok !== true || plan.schemaId !== "xw.xhs.routine-plan.v1") {
    throw new TypeError("createRoutineRun: sealed routine plan required");
  }
  if (!driver) throw new TypeError("createRoutineRun: session-bound driver required");

  const MAX_CONSECUTIVE_SKIPS = limits.maxConsecutiveSkips ?? 2;
  const MAX_BACK_ATTEMPTS = limits.maxBackAttempts ?? 5;
  const template = plan.template;
  const params = plan.params;
  const dwell = params.dwell ?? { min: 5, max: 12 };
  const rng = mulberry32(seedToRngState(params.seed ?? "daily"));

  const run = {
    template,
    planHash: plan.planHash,
    routineRunId: plan.routineRunId,
    seed: params.seed ?? "daily",
    picks: [],
    items: [],
    effects: {
      like: { planned: params.likeMax ?? 0, transported: 0, remaining: params.likeMax ?? 0 },
      comment: { planned: params.commentMax ?? 0, transported: 0, remaining: params.commentMax ?? 0 },
    },
    transport: { count: 0 },
    skipsConsecutive: 0,
    // an ambiguous effect consumes its slot and closes that action for the run
    // (plan V2 §7.6: ambiguous 禁止同 target 重试; comment ambiguous 关闭本 run 其余评论)
    closedActions: new Set(),
    terminal: null,
    stopReason: null,
    cleanup: null,
  };

  const openedTargets = new Set();

  function finish(status, reason) {
    run.terminal = status;
    run.stopReason = reason ?? run.stopReason;
    return { status, reason: run.stopReason };
  }

  /** One full item loop. Returns an item receipt. */
  async function runItem(index) {
    const item = {
      index,
      targetFingerprint: null,
      cardKind: CARD_KIND.UNKNOWN,
      opened: false,
      openAttempts: 0,
      detailPage: null,
      dwellMs: 0,
      commentScreens: 0,
      commentsRead: 0,
      effects: { like: "none", comment: "deferred" },
      stopReason: null,
    };

    // --- ENSURE_FEED -------------------------------------------------------
    const feed = await driver.ensureFeed();
    if (!feed || feed.ok !== true) {
      item.stopReason = "ENSURE_FEED_FAILED";
      return { item, stop: finish("BLOCKED", "ENSURE_FEED_FAILED") };
    }

    // --- REFRESH_CAPTURE + DISCOVER_VISIBLE_CARDS --------------------------
    const dumped = await driver.dump({ label: `routine-${template}-${index}` });
    if (!dumped || !dumped.xml) {
      item.stopReason = "DUMP_UNAVAILABLE";
      return { item, stop: finish("FAILED", "DUMP_UNAVAILABLE") };
    }
    const page = classifyPage({
      xml: dumped.xml,
      focus: dumped.focus,
      pkg: dumped.pkg,
      sourceCardKind: null,
    });
    run.dumpHashes = run.dumpHashes || [];
    if (dumped.hash) run.dumpHashes.push(dumped.hash);
    if (page.page !== PAGE_CLASS.HOME_FEED || !page.cards?.length) {
      item.stopReason = `FEED_NOT_RECOGNIZED:${page.page}`;
      run.skipsConsecutive += 1;
      if (run.skipsConsecutive > MAX_CONSECUTIVE_SKIPS) {
        return { item, stop: finish("FAILED", "FEED_RECOGNITION_EXHAUSTED") };
      }
      return { item, stop: null };
    }

    // --- PICK_SEEDED_TARGET ------------------------------------------------
    const eligible = page.cards.filter((c) => {
      const fp = bindTargetFingerprint({ cardTitle: c.title, cardAuthor: c.author, cardCenter: { x: c.cx, y: c.cy }, pageEvidence: page.page });
      return !openedTargets.has(fp);
    });
    if (!eligible.length) {
      item.stopReason = "NO_UNTRIED_CARDS";
      return { item, stop: finish("SUCCEEDED", "NO_UNTRIED_CARDS") };
    }
    const pickIdx = Math.floor(rng() * eligible.length);
    const card = eligible[pickIdxSafe(eligible, pickIdx)];
    const targetFingerprint = bindTargetFingerprint({
      cardTitle: card.title,
      cardAuthor: card.author,
      cardCenter: { x: card.cx, y: card.cy },
      pageEvidence: page.page,
    });
    openedTargets.add(targetFingerprint);
    item.targetFingerprint = targetFingerprint;
    item.cardKind = classifyCardKind([card.desc]).kind;
    run.picks.push({ index, targetFingerprint, cardKind: item.cardKind, prefer: params.prefer ?? "any" });

    // --- OPEN_BOUND_TARGET (exactly once per item) --------------------------
    item.openAttempts = 1;
    const opened = await driver.tapAt({ x: card.cx, y: card.cy });
    if (!opened || opened.ok !== true) {
      item.stopReason = "OPEN_FAILED";
      run.skipsConsecutive += 1;
      if (run.skipsConsecutive > MAX_CONSECUTIVE_SKIPS) {
        return { item, stop: finish("FAILED", "OPEN_EXHAUSTED") };
      }
      const backFeed = await driver.back();
      // even a failed open must land back on feed before next item
      if (!backFeed || backFeed.ok !== true) {
        return { item, stop: finish("BLOCKED", "RESTORE_FEED_AFTER_OPEN_FAILED") };
      }
      return { item, stop: null };
    }
    item.opened = true;

    // --- ASSERT_DETAIL_KIND -------------------------------------------------
    const detailDump = await driver.dump({ label: `detail-${index}` });
    if (detailDump?.hash) run.dumpHashes.push(detailDump.hash);
    const detail = classifyPage({
      xml: detailDump?.xml || "",
      focus: detailDump?.focus || "",
      pkg: detailDump?.pkg,
      sourceCardKind: item.cardKind,
    });
    item.detailPage = detail.page;
    if (detail.page === PAGE_CLASS.PUBLISH_EDITOR
      || detail.page === PAGE_CLASS.PRODUCT_ENTRY
      || detail.page === PAGE_CLASS.AUTH_RISK
      || detail.page === PAGE_CLASS.NOTE_COMMENT_ACTIVITY
      || detail.page === PAGE_CLASS.SYSTEM_OVERLAY) {
      item.stopReason = `FORBIDDEN_SURFACE:${detail.page}`;
      // leave the forbidden surface immediately, then restore feed
      const back = await driver.back();
      if (!back || back.ok !== true) {
        return { item, stop: finish("BLOCKED", "RESTORE_AFTER_FORBIDDEN_FAILED") };
      }
      // social transport frozen for the rest of the run; run stops here
      run.socialTransportFrozen = true;
      return { item, stop: finish("BLOCKED", "FORBIDDEN_SURFACE") };
    }
    if (detail.page !== PAGE_CLASS.IMAGE_NOTE && detail.page !== PAGE_CLASS.VIDEO_NOTE) {
      item.stopReason = `DETAIL_UNRECOGNIZED:${detail.page}`;
      const back = await driver.back();
      if (!back || back.ok !== true) {
        return { item, stop: finish("BLOCKED", "RESTORE_AFTER_UNRECOGNIZED") };
      }
      run.skipsConsecutive += 1;
      if (run.skipsConsecutive > MAX_CONSECUTIVE_SKIPS) {
        return { item, stop: finish("FAILED", "DETAIL_RECOGNITION_EXHAUSTED") };
      }
      return { item, stop: null };
    }

    // --- DWELL ---------------------------------------------------------------
    const dwellMs = Math.round((dwell.min + rng() * (dwell.max - dwell.min)) * 1000);
    await driver.waitFor(dwellMs);
    item.dwellMs = dwellMs;

    // --- MAYBE_READ_COMMENTS --------------------------------------------------
    const screensBound = params.commentScreens ?? 0;
    if (screensBound > 0) {
      const decision = commentEntryDecision({
        page: detail.page,
        xml: detailDump?.xml || "",
        commentControl: detail.commentControl,
      });
      if (decision.allowed) {
        if (decision.mode === "rows") {
          // image-note comment area: bounded swipe screens allowed
          item.commentScreens = screensBound;
          const sw = await driver.swipeComments({ screens: screensBound });
          item.commentsRead = sw && sw.ok === true ? screensBound : 0;
          if (!sw || sw.ok !== true) item.commentStop = "COMMENT_SWIPE_FAILED";
        } else if (decision.mode === "control") {
          // S1 dump-only: a video-surface comment entry requires asserting the
          // comment panel after the control tap; the panel assertion is not
          // wired yet, so the branch is skipped — never tap unverified.
          item.commentStop = "COMMENT_PANEL_ASSERTION_PENDING_S1";
        }
      } else {
        item.commentStop = decision.reason;
      }
    }

    // --- MAYBE_DRAFT_COMMENT + MAYBE_COMMIT_EFFECT ----------------------------
    const effectCapable = plan.effectClass === "social";
    if (effectCapable && !run.socialTransportFrozen) {
      if (effects && typeof effects.commitRoutineEffect === "function") {
        const likeRemaining = run.effects.like.remaining;
        if (run.closedActions.has("like") || likeRemaining <= 0) {
          item.effects.like = likeRemaining <= 0 ? "cap_reached" : "closed:ambiguous";
        } else if (item.detailPage === PAGE_CLASS.IMAGE_NOTE || item.detailPage === PAGE_CLASS.VIDEO_NOTE) {
          if (!detailDump?.hash) {
            // §7.2: routineRunId+action+target+observationHash must bind before
            // reservation — an unbound observation can never transport
            item.effects.like = "stopped:observation_unbound";
          } else {
            const intent = { action: "like", targetFingerprint, observationHash: detailDump.hash };
            const res = await effects.commitRoutineEffect({ plan, run: { routineRunId: run.routineRunId, seed: run.seed }, item, intent });
            const outcome = res?.outcome ?? "bridge_error";
            item.effects.like = outcome;
            if (res?.transported) {
              run.transport.count += 1;
              run.effects.like.transported += 1;
              run.effects.like.remaining = Math.max(0, run.effects.like.remaining - 1);
            }
            if (outcome === "ambiguous" || outcome === "ambiguous_no_retry") {
              // slot consumed (transported), no retry, action closed for the run
              run.closedActions.add("like");
            }
          }
        } else {
          item.effects.like = "skipped:surface_not_effect_capable";
        }
      } else {
        item.effects.like = "deferred:effect_bridge_not_wired";
        item.effects.comment = "deferred:effect_bridge_not_wired";
      }
    } else if (effectCapable && run.socialTransportFrozen) {
      item.effects.like = "frozen:forbidden_surface";
      item.effects.comment = "frozen:forbidden_surface";
    }

    // --- MAYBE_DRAFT_COMMENT: grounded comment chain (S3) ----------------------
    // Fired only when the machine actually read the comment rows (grounding),
    // the plan still has comment budget, and the action is not closed — a
    // closed comment (ambiguous) never re-opens, but read-only browsing continues.
    if (effectCapable && !run.socialTransportFrozen
      && effects && typeof effects.commitRoutineEffect === "function"
      && item.commentsRead > 0
      && detailDump?.hash
      && (item.detailPage === PAGE_CLASS.IMAGE_NOTE || item.detailPage === PAGE_CLASS.VIDEO_NOTE)) {
      if (run.closedActions.has("comment")) {
        // §7.6: comment ambiguous closes ALL remaining comments this run
        item.effects.comment = "closed:ambiguous";
      } else if ((run.effects.comment.remaining ?? 0) <= 0) {
        item.effects.comment = "cap_reached";
      } else {
        const intent = { action: "comment", targetFingerprint, observationHash: detailDump.hash };
        const res = await effects.commitRoutineEffect({ plan, run: { routineRunId: run.routineRunId, seed: run.seed }, item, intent });
        const outcome = res?.outcome ?? "bridge_error";
        item.effects.comment = outcome;
        if (res?.transported) {
          run.transport.count += 1;
          run.effects.comment.transported += 1;
          run.effects.comment.remaining = Math.max(0, run.effects.comment.remaining - 1);
        }
        if (outcome === "ambiguous" || outcome === "ambiguous_no_retry") {
          run.closedActions.add("comment");
        }
      }
    }

    // --- BACK_VERIFY_FEED ------------------------------------------------------
    let backOk = false;
    for (let b = 0; b < MAX_BACK_ATTEMPTS && !backOk; b += 1) {
      const back = await driver.back();
      if (back && back.focusVerified) backOk = true;
    }
    if (!backOk) {
      item.stopReason = "BACK_FEED_NOT_CONFIRMED";
      return { item, stop: finish("BLOCKED", "BACK_FEED_NOT_CONFIRMED") };
    }

    // a fully completed item resets the consecutive-skip budget
    run.skipsConsecutive = 0;

    return { item, stop: null };
  }

  /** Main loop — items in bound order, deterministic stop. */
  async function execute() {
    const results = [];
    for (let i = 0; i < (params.items ?? 5); i += 1) {
      const { item, stop } = await runItem(i);
      results.push(item);
      run.items = results;
      if (stop) {
        // stop reason already recorded by finish()
        break;
      }
    }
    if (!run.terminal) {
      finish("SUCCEEDED", "ITEMS_BOUND_REACHED");
    }
    run.cleanup = { activeLeases: 0, restored: true };
    return buildReceipt();
  }

  function buildReceipt() {
    return Object.freeze({
      schemaId: "xw.xhs.execute-receipt.v1",
      runId: run.routineRunId,
      planHash: run.planHash,
      status: run.terminal,
      template,
      seed: run.seed,
      picks: run.picks,
      items: run.items,
      effects: run.effects,
      transport: { count: run.transport.count },
      cleanup: run.cleanup,
      dumpHashes: run.dumpHashes || [],
      stopReason: run.stopReason,
    });
  }

  return { execute, run, runItem, buildReceipt };
}

function pickIdxSafe(arr, idx) {
  return Math.min(Math.max(0, idx), arr.length - 1);
}