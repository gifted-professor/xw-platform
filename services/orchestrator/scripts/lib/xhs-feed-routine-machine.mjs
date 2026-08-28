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
import { isEffectControlLabel } from "./xhs-vision-shadow.mjs";

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
 * @param {object} input.driver - session-bound primitives. A production
 *   driver must expose getExecutionBinding(), refresh(), release()/close(),
 *   and getCleanupStatus()/inspectCleanup() in addition to the interaction
 *   primitives. Missing ownership/cleanup interfaces fail closed.
 * @param {object} [input.clock] - { nowMs(), sleep(ms) } (tests inject fake)
 * @param {object} [input.effects] - S2+ commitRoutineEffect bridge; when
 *        absent, effect steps are recorded as deferred (transport 0).
 * @param {object} [input.visionNavigator] - optional production vision seam.
 *   It may observe a detail page, or issue a one-shot R0 navigation permit
 *   for a unique feed card. The machine does not provide a production vision
 *   provider; callers must inject one and all bindings are verified here.
 */
export function createRoutineRun({
  plan,
  driver,
  clock = defaultClock(),
  effects = null,
  visionNavigator = null,
  limits = {},
} = {}) {
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
  const executionRunId = plan.executionRunId || plan.routineRunId;

  const run = {
    template,
    planHash: plan.planHash,
    routineRunId: plan.routineRunId,
    executionRunId,
    alias: plan.alias,
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
    executionBinding: null,
    vision: [],
  };

  const openedTargets = new Set();
  const consumedVisionPermits = new Set();

  function finish(status, reason) {
    run.terminal = status;
    run.stopReason = reason ?? run.stopReason;
    return { status, reason: run.stopReason };
  }

  function nonEmpty(value) {
    return typeof value === "string" && value.trim().length > 0;
  }

  function normalizeExecutionBinding(raw) {
    const binding = {
      alias: String(raw?.alias ?? ""),
      sessionId: String(raw?.sessionId ?? raw?.sessionRef ?? ""),
      deviceId: String(raw?.deviceId ?? raw?.deviceRef ?? raw?.serial ?? ""),
    };
    if (binding.alias !== String(plan.alias)
      || !nonEmpty(binding.sessionId)
      || !nonEmpty(binding.deviceId)) {
      return null;
    }
    return Object.freeze(binding);
  }

  async function initializeExecutionBinding() {
    if (typeof driver.getExecutionBinding !== "function") {
      finish("BLOCKED", "DRIVER_BINDING_INTERFACE_UNAVAILABLE");
      return false;
    }
    let raw;
    try {
      raw = await driver.getExecutionBinding({ executionRunId, planHash: plan.planHash, alias: plan.alias });
    } catch {
      finish("BLOCKED", "DRIVER_BINDING_LOOKUP_FAILED");
      return false;
    }
    const binding = normalizeExecutionBinding(raw);
    if (!binding) {
      finish("BLOCKED", "DRIVER_BINDING_MISMATCH");
      return false;
    }
    run.executionBinding = binding;
    return true;
  }

  function providerIdOf(provider) {
    return typeof provider === "string" ? provider : provider?.id;
  }

  function providerIsPinned(provider) {
    return provider && typeof provider === "object"
      && nonEmpty(provider.id)
      && nonEmpty(provider.version)
      && /^[a-f0-9]{64}$/.test(String(provider.modelSha256 || ""));
  }

  function bindingMatches(candidate, expectedPage) {
    const binding = run.executionBinding;
    return candidate?.executionRunId === executionRunId
      && candidate?.planHash === plan.planHash
      && String(candidate?.alias) === String(plan.alias)
      && String(candidate?.sessionId ?? candidate?.sessionRef ?? "") === binding?.sessionId
      && String(candidate?.deviceId ?? candidate?.deviceRef ?? candidate?.serial ?? "") === binding?.deviceId
      && candidate?.page === expectedPage
      && nonEmpty(candidate?.frameId)
      && nonEmpty(providerIdOf(candidate?.provider));
  }

  function validateR0VisionPermit(result, expectedPage = PAGE_CLASS.HOME_FEED) {
    const permit = result?.permit;
    const target = result?.target;
    if (result?.ok !== true || !permit || !target || !bindingMatches(permit, expectedPage)) {
      return { ok: false, reason: "VISION_PERMIT_BINDING_INVALID" };
    }
    const permitId = permit.permitId || permit.actionRef;
    const actionClass = permit.actionClass || permit.riskClass;
    const providerId = providerIdOf(permit.provider);
    const fixtureProvider = /(^|[-_.])fixture($|[-_.])/i.test(providerId);
    const effectSemantics = [target.label, target.action, target.category, target.controlType]
      .some((value) => isEffectControlLabel(value));
    const width = Number(permit.dims?.width);
    const height = Number(permit.dims?.height);
    if (!nonEmpty(permitId)
      || (actionClass !== "R0_NAVIGATION" && actionClass !== "R0")
      || permit.oneShot !== true
      || permit.consumed === true
      || consumedVisionPermits.has(permitId)
      || fixtureProvider
      || !providerIsPinned(permit.provider)
      || !nonEmpty(target.blockId)
      || (permit.blockId && permit.blockId !== target.blockId)
      || !Number.isFinite(target.x)
      || !Number.isFinite(target.y)
      || !Number.isFinite(width)
      || !Number.isFinite(height)
      || width <= 0
      || height <= 0
      || target.x < 0
      || target.y < 0
      || target.x >= width
      || target.y >= height
      || permit.effectControl === true
      || target.effectControl === true
      || effectSemantics) {
      return { ok: false, reason: "VISION_PERMIT_UNSAFE" };
    }
    if (!Number.isFinite(permit.expiresAtMs) || Number(permit.expiresAtMs) <= clock.nowMs()) {
      return { ok: false, reason: "VISION_PERMIT_EXPIRED" };
    }
    return { ok: true, permit, target, permitId, provider: Object.freeze({ ...permit.provider }), providerId };
  }

  async function resolveVisionFeedTarget({ index, reason }) {
    const authorize = visionNavigator?.authorizeR0Navigation
      || visionNavigator?.resolveNavigationTarget;
    if (typeof authorize !== "function") {
      return { ok: false, reason: "VISION_NAVIGATOR_UNAVAILABLE" };
    }
    let result;
    try {
      result = await authorize.call(visionNavigator, {
        purpose: "open_unique_feed_card",
        reason,
        executionRunId,
        planHash: plan.planHash,
        alias: plan.alias,
        sessionId: run.executionBinding.sessionId,
        deviceId: run.executionBinding.deviceId,
        page: PAGE_CLASS.HOME_FEED,
        index,
        seed: run.seed,
      });
    } catch {
      return { ok: false, reason: "VISION_NAVIGATOR_FAILED" };
    }
    return validateR0VisionPermit(result);
  }

  function validateVisionObservation(result) {
    const observation = result?.observation || result;
    if (result?.ok === false || !bindingMatches(observation, observation?.page)) {
      return { ok: false, reason: "VISION_OBSERVATION_BINDING_INVALID" };
    }
    if (observation.page !== PAGE_CLASS.IMAGE_NOTE && observation.page !== PAGE_CLASS.VIDEO_NOTE) {
      return { ok: false, reason: "VISION_DETAIL_UNSAFE_OR_UNKNOWN" };
    }
    const providerId = providerIdOf(observation.provider);
    if (/(^|[-_.])fixture($|[-_.])/i.test(providerId) || !providerIsPinned(observation.provider)) {
      return { ok: false, reason: "VISION_PROVIDER_UNSAFE" };
    }
    return { ok: true, observation, provider: Object.freeze({ ...observation.provider }), providerId };
  }

  async function observeDetailWithVision({ index, reason }) {
    if (typeof visionNavigator?.observePage !== "function") {
      return { ok: false, reason: "VISION_NAVIGATOR_UNAVAILABLE" };
    }
    let result;
    try {
      result = await visionNavigator.observePage({
        purpose: "classify_open_detail",
        reason,
        executionRunId,
        planHash: plan.planHash,
        alias: plan.alias,
        sessionId: run.executionBinding.sessionId,
        deviceId: run.executionBinding.deviceId,
        expectedPage: "XHS_NOTE_DETAIL",
        index,
      });
    } catch {
      return { ok: false, reason: "VISION_NAVIGATOR_FAILED" };
    }
    return validateVisionObservation(result);
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
    if (typeof driver.ensureFeed !== "function") {
      item.stopReason = "ENSURE_FEED_INTERFACE_UNAVAILABLE";
      return { item, stop: finish("BLOCKED", "ENSURE_FEED_INTERFACE_UNAVAILABLE") };
    }
    const feed = await driver.ensureFeed();
    if (!feed || feed.ok !== true) {
      item.stopReason = "ENSURE_FEED_FAILED";
      return { item, stop: finish("BLOCKED", "ENSURE_FEED_FAILED") };
    }

    // --- REFRESH_CAPTURE ---------------------------------------------------
    // Refresh is an actual session-bound primitive, not a state-machine label.
    // A driver that cannot perform it is not a production routine driver.
    if (typeof driver.refresh !== "function") {
      item.stopReason = "REFRESH_INTERFACE_UNAVAILABLE";
      return { item, stop: finish("BLOCKED", "REFRESH_INTERFACE_UNAVAILABLE") };
    }
    const refreshed = await driver.refresh({
      executionRunId,
      planHash: plan.planHash,
      alias: plan.alias,
      sessionId: run.executionBinding.sessionId,
      deviceId: run.executionBinding.deviceId,
      index,
    });
    if (!refreshed || refreshed.ok !== true) {
      item.stopReason = "REFRESH_FAILED";
      return { item, stop: finish("BLOCKED", "REFRESH_FAILED") };
    }

    // --- CAPTURE + DISCOVER_VISIBLE_CARDS ---------------------------------
    let dumped = null;
    if (typeof driver.dump === "function") {
      dumped = await driver.dump({ label: `routine-${template}-${index}` });
    }
    const page = dumped?.xml ? classifyPage({
      xml: dumped.xml,
      focus: dumped.focus,
      pkg: dumped.pkg,
      sourceCardKind: null,
    }) : { page: PAGE_CLASS.UNKNOWN, cards: [] };
    run.dumpHashes = run.dumpHashes || [];
    if (dumped?.hash) run.dumpHashes.push(dumped.hash);
    let targetFingerprint;
    let openPoint;
    let visionPermit = null;

    if (page.page === PAGE_CLASS.HOME_FEED && page.cards?.length) {
      // --- PICK_SEEDED_TARGET ----------------------------------------------
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
      targetFingerprint = bindTargetFingerprint({
        cardTitle: card.title,
        cardAuthor: card.author,
        cardCenter: { x: card.cx, y: card.cy },
        pageEvidence: page.page,
      });
      item.cardKind = classifyCardKind([card.desc]).kind;
      openPoint = { x: card.cx, y: card.cy };
      run.picks.push({
        index,
        targetFingerprint,
        cardKind: item.cardKind,
        prefer: params.prefer ?? "any",
        selectionMode: "dump_seeded",
      });
    } else {
      // Dump absent/sparse/ambiguous may use an injected, production-pinned
      // vision navigator. It must return a fully bound, one-shot R0 permit.
      // Without that exact contract the run stops with tap=0.
      const reason = !dumped?.xml ? "DUMP_UNAVAILABLE" : `FEED_NOT_RECOGNIZED:${page.page}`;
      const visual = await resolveVisionFeedTarget({ index, reason });
      if (!visual.ok) {
        item.stopReason = `${reason}:${visual.reason}`;
        return { item, stop: finish("FAILED", visual.reason === "VISION_NAVIGATOR_UNAVAILABLE" ? reason : visual.reason) };
      }
      visionPermit = visual.permit;
      openPoint = { x: visual.target.x, y: visual.target.y };
      targetFingerprint = visual.target.targetFingerprint
        || `vision:${visionPermit.frameId}:${visual.target.blockId}`;
      if (openedTargets.has(targetFingerprint)) {
        item.stopReason = "VISION_TARGET_REPLAY";
        return { item, stop: finish("FAILED", "VISION_TARGET_REPLAY") };
      }
      item.cardKind = classifyCardKind([visual.target.label, visual.target.cardKind]).kind;
      run.picks.push({
        index,
        targetFingerprint,
        cardKind: item.cardKind,
        prefer: params.prefer ?? "any",
        selectionMode: "vision_unique_r0",
        frameId: visionPermit.frameId,
        provider: visual.provider,
        blockId: visual.target.blockId,
        permitId: visual.permitId,
      });
      run.vision.push({
        purpose: "open_unique_feed_card",
        frameId: visionPermit.frameId,
        provider: visual.provider,
        blockId: visual.target.blockId,
        permitId: visual.permitId,
        tapAuthorized: true,
      });
    }

    openedTargets.add(targetFingerprint);
    item.targetFingerprint = targetFingerprint;

    // --- OPEN_BOUND_TARGET (exactly once per item) --------------------------
    if (typeof driver.tapAt !== "function") {
      item.stopReason = "TAP_INTERFACE_UNAVAILABLE";
      return { item, stop: finish("BLOCKED", "TAP_INTERFACE_UNAVAILABLE") };
    }
    if (visionPermit) {
      consumedVisionPermits.add(visionPermit.permitId || visionPermit.actionRef);
    }
    item.openAttempts = 1;
    const opened = await driver.tapAt({
      ...openPoint,
      source: visionPermit ? "vision-r0" : "dump",
      targetFingerprint,
      cardKind: item.cardKind,
      visionPermit,
      executionRunId,
      planHash: plan.planHash,
      alias: plan.alias,
      sessionId: run.executionBinding.sessionId,
      deviceId: run.executionBinding.deviceId,
    });
    if (!opened || opened.ok !== true) {
      item.stopReason = "OPEN_FAILED";
      run.skipsConsecutive += 1;
      if (run.skipsConsecutive > MAX_CONSECUTIVE_SKIPS) {
        return { item, stop: finish("FAILED", "OPEN_EXHAUSTED") };
      }
      if (opened?.noAction === true) {
        // A pre-tap target recheck/permit rejection leaves the feed unchanged;
        // pressing Back here would itself be an unplanned navigation.
        return { item, stop: null };
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
    const detailDump = typeof driver.dump === "function"
      ? await driver.dump({ label: `detail-${index}` })
      : null;
    if (detailDump?.hash) run.dumpHashes.push(detailDump.hash);
    let detail = classifyPage({
      xml: detailDump?.xml || "",
      focus: detailDump?.focus || "",
      pkg: detailDump?.pkg,
      sourceCardKind: item.cardKind,
    });
    if (!detailDump?.xml || detail.page === PAGE_CLASS.UNKNOWN) {
      const visualDetail = await observeDetailWithVision({
        index,
        reason: !detailDump?.xml ? "DETAIL_DUMP_UNAVAILABLE" : "DETAIL_DUMP_AMBIGUOUS",
      });
      if (visualDetail.ok) {
        detail = {
          page: visualDetail.observation.page,
          cards: [],
          commentControl: null,
          source: "vision_observation",
        };
        run.vision.push({
          purpose: "classify_open_detail",
          frameId: visualDetail.observation.frameId,
          provider: visualDetail.provider,
          tapAuthorized: false,
        });
      } else if (!detailDump?.xml) {
        item.stopReason = `DETAIL_DUMP_UNAVAILABLE:${visualDetail.reason}`;
        const back = typeof driver.back === "function" ? await driver.back() : null;
        if (!back || back.ok !== true) {
          return { item, stop: finish("BLOCKED", "RESTORE_AFTER_UNRECOGNIZED") };
        }
        return { item, stop: finish("FAILED", visualDetail.reason === "VISION_NAVIGATOR_UNAVAILABLE"
          ? "DETAIL_DUMP_UNAVAILABLE"
          : visualDetail.reason) };
      }
    }
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

  async function closeAndInspect() {
    const releaseMethod = typeof driver.release === "function"
      ? "release"
      : (typeof driver.close === "function" ? "close" : null);
    let releaseResult = null;
    let releaseError = null;
    if (releaseMethod) {
      try {
        releaseResult = await driver[releaseMethod]({
          executionRunId,
          planHash: plan.planHash,
          alias: plan.alias,
          sessionId: run.executionBinding?.sessionId ?? null,
          deviceId: run.executionBinding?.deviceId ?? null,
        });
      } catch (error) {
        releaseError = String(error?.code || error?.name || "RELEASE_FAILED");
      }
    } else {
      releaseError = "RELEASE_INTERFACE_UNAVAILABLE";
    }

    const inspectMethod = typeof driver.getCleanupStatus === "function"
      ? "getCleanupStatus"
      : (typeof driver.inspectCleanup === "function" ? "inspectCleanup" : null);
    let inspected = null;
    let inspectError = null;
    if (inspectMethod) {
      try {
        inspected = await driver[inspectMethod]({
          executionRunId,
          planHash: plan.planHash,
          alias: plan.alias,
          sessionId: run.executionBinding?.sessionId ?? null,
          deviceId: run.executionBinding?.deviceId ?? null,
        });
      } catch (error) {
        inspectError = String(error?.code || error?.name || "CLEANUP_INSPECTION_FAILED");
      }
    } else {
      inspectError = "CLEANUP_INSPECTION_INTERFACE_UNAVAILABLE";
    }

    // These values come only from the driver's post-release authority. Null
    // means "not observed"; the machine never invents lease/restoration facts.
    const activeLeases = Number.isInteger(inspected?.activeLeases)
      ? inspected.activeLeases
      : null;
    const restored = typeof inspected?.restored === "boolean"
      ? inspected.restored
      : null;
    const releaseOk = releaseResult?.ok === true;
    const cleanupVerified = releaseOk
      && !releaseError
      && !inspectError
      && activeLeases === 0
      && restored === true;
    run.cleanup = Object.freeze({
      releaseMethod,
      releaseOk,
      releaseError,
      inspectionMethod: inspectMethod,
      inspectionError: inspectError,
      activeLeases,
      restored,
      verified: cleanupVerified,
      authorityRef: inspected?.authorityRef ?? null,
      observedAtMs: Number.isFinite(inspected?.observedAtMs) ? inspected.observedAtMs : null,
    });

    if (!cleanupVerified && run.terminal === "SUCCEEDED") {
      let reason = "CLEANUP_NOT_VERIFIED";
      if (!releaseMethod) reason = "RELEASE_INTERFACE_UNAVAILABLE";
      else if (!inspectMethod) reason = "CLEANUP_INSPECTION_INTERFACE_UNAVAILABLE";
      else if (releaseError || !releaseOk) reason = "DRIVER_RELEASE_FAILED";
      else if (activeLeases !== 0) reason = "ACTIVE_LEASES_REMAIN";
      else if (restored !== true) reason = "DEVICE_NOT_RESTORED";
      finish("BLOCKED", reason);
    }
  }

  /** Main loop — items in bound order, deterministic stop. */
  async function execute() {
    const results = [];
    try {
      const bindingReady = await initializeExecutionBinding();
      if (bindingReady) {
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
      }
    } catch (error) {
      if (!run.terminal) {
        const code = String(error?.reasonCode || error?.code || error?.name || "UNKNOWN");
        finish("FAILED", `ROUTINE_EXECUTION_ERROR:${code}`);
      }
    } finally {
      await closeAndInspect();
    }
    return buildReceipt();
  }

  function buildReceipt() {
    return Object.freeze({
      schemaId: "xw.xhs.execute-receipt.v1",
      runId: run.executionRunId,
      routineRunId: run.routineRunId,
      planHash: run.planHash,
      alias: run.alias,
      executionBinding: run.executionBinding,
      status: run.terminal,
      template,
      seed: run.seed,
      picks: run.picks,
      items: run.items,
      effects: run.effects,
      transport: { count: run.transport.count },
      cleanup: run.cleanup,
      vision: run.vision,
      dumpHashes: run.dumpHashes || [],
      stopReason: run.stopReason,
    });
  }

  return { execute, run, runItem, buildReceipt };
}

function pickIdxSafe(arr, idx) {
  return Math.min(Math.max(0, idx), arr.length - 1);
}
