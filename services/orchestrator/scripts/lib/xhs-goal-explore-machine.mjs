/**
 * xhs-goal-explore-machine.mjs — V3 free-exploration DUMP-only lane machine
 * (plan V2 §5.3, invariants V3-I03/I04/I05/I06/I08).
 *
 * PURE. One lane (feed_lane | search_lane) steps through closed-vocabulary
 * pages and emits NAVIGATION INTENTS only. The machine never sees a raw
 * primitive, session token, coordinate, or provider path: the typed driver
 * (openBoundSearch / submitBoundQuery / scrollBoundResults / openBoundContent
 * / openBoundComments / pauseBoundVideo / backBound / restoreBound) owns the
 * CP-owned dump, resolves the exact payload, and executes the permit.
 *
 * Input is an OBSERVATION (already classified by xhs-explore-surface.mjs):
 *   { page, candidates?, commentControl?, error? }
 * plus the driver's post-navigation report for the PREVIOUS decision:
 *   { navigated: boolean, novel: true|false|null }.
 *
 * Stops are EXACT (P2 gate): the consecutive-failure and no-novel counters trip
 * exactly at the sealed cap, budget exhaustion is checked per decision, and
 * exit/overlay surfaces stop the lane immediately. Final restoration is
 * semantic: the machine keeps requesting BACK until HOME is re-observed, and
 * only then reports DONE.
 */
import {
  EXPLORE_PAGE,
  EXPLORE_EXIT_PAGES,
  EXPLORE_DETAIL_PAGES,
} from "./xhs-explore-surface.mjs";

export const EXPLORE_PHASES = Object.freeze({
  NEED_OPEN_SEARCH: "NEED_OPEN_SEARCH",
  NEED_SUBMIT_QUERY: "NEED_SUBMIT_QUERY",
  READ_RESULTS: "READ_RESULTS",
  BROWSE_FEED: "BROWSE_FEED",
  OPEN_CONTENT: "OPEN_CONTENT",
  VIEW_COMMENTS: "VIEW_COMMENTS",
  BACK_TO_RESULTS: "BACK_TO_RESULTS",
  BACK_TO_HOME: "BACK_TO_HOME",
  DONE: "DONE",
  STOPPED: "STOPPED",
});

export const EXPLORE_STOP_REASONS = Object.freeze({
  CONSECUTIVE_NAVIGATION_FAILURES: "CONSECUTIVE_NAVIGATION_FAILURES",
  NO_NOVEL_SCREENS: "NO_NOVEL_SCREENS",
  NOVEL_OPEN_BUDGET: "NOVEL_OPEN_BUDGET",
  RESULT_SCREEN_BUDGET: "RESULT_SCREEN_BUDGET",
  COMMENT_SCREEN_BUDGET: "COMMENT_SCREEN_BUDGET",
  QUERIES_BUDGET: "QUERIES_BUDGET",
  FORBIDDEN_SURFACE: "FORBIDDEN_SURFACE",
  OBSERVATION_ERROR: "OBSERVATION_ERROR",
  DEADLINE: "DEADLINE",
});

export const EXPLORE_DECISIONS = Object.freeze(["NAVIGATE", "DONE", "STOP"]);

const DEFAULT_CAPS = Object.freeze({
  consecutiveNavigationFailures: 2,
  noNovelScreens: 2,
  novelOpens: 8,
  resultScreensPerQuery: 2,
  commentScreens: 6,
  missionDurationSec: 600,
});

function capOf(budgets, name) {
  const value = Number(budgets?.[name]);
  return Number.isInteger(value) && value >= 0 ? value : DEFAULT_CAPS[name];
}

function navDecision(navigationRole, extra = {}) {
  return { action: "NAVIGATE", navigationRole, ...extra };
}

/**
 * Initial lane state.
 * @param {object} input
 * @param {string} input.laneRole - feed_lane|search_lane
 * @param {string} input.alias - exact device alias
 * @param {string} input.seed - candidate rank seed
 * @param {string[]} input.queries - sealed queries (search lane)
 * @param {object} input.budgets - mission budgets (only ever lower than caps)
 * @param {number} input.startedAtMs - mission deadline anchor (machine time comes
 *        in via exploreStep input.nowMs; the machine itself has no clock)
 * @param {boolean} input.visionEnabled - vision canary gate (P2: false)
 */
export function createExploreLaneState({
  laneRole,
  alias,
  seed,
  queries = [],
  budgets = {},
  startedAtMs = null,
  visionEnabled = false,
} = {}) {
  if (!["feed_lane", "search_lane"].includes(laneRole)) {
    throw new TypeError("createExploreLaneState requires laneRole feed_lane|search_lane");
  }
  if (laneRole === "search_lane" && (!Array.isArray(queries) || queries.length === 0)) {
    throw new TypeError("search_lane requires at least one sealed query");
  }
  return Object.freeze({
    schemaId: "xw.xhs.explore-lane-state.v1",
    laneRole,
    alias: String(alias),
    seed: String(seed ?? "").slice(0, 64),
    queries: Object.freeze([...(queries ?? []).map((q) => String(q))]),
    budgets: Object.freeze({ ...budgets }),
    startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : null,
    visionEnabled: visionEnabled === true,
    phase: laneRole === "search_lane" ? EXPLORE_PHASES.NEED_OPEN_SEARCH : EXPLORE_PHASES.BROWSE_FEED,
    queryIndex: 0,
    resultScreensUsed: 0,
    commentScreensUsed: 0,
    novelOpensUsed: 0,
    scrollsOnCurrentResults: 0,
    claimedKeys: Object.freeze([]),
    pendingClaimKey: null,
    consecutiveNavigationFailures: 0,
    noNovelScreens: 0,
    lastPage: null,
    stopReason: null,
    doneReason: null,
  });
}

function isHome(page) {
  return page === EXPLORE_PAGE.HOME_FEED || page === EXPLORE_PAGE.HOME_FEED_EMPTY;
}

// Budget checks are scoped to the DECISION they gate: a budget is consumed by
// the action that needs it, so exhaustion only blocks that action class.
function novelOpenBudgetExhausted(state) {
  return state.novelOpensUsed >= capOf(state.budgets, "novelOpens")
    ? EXPLORE_STOP_REASONS.NOVEL_OPEN_BUDGET
    : null;
}

function resultScreenBudgetExhausted(state) {
  return state.resultScreensUsed >= capOf(state.budgets, "resultScreensPerQuery") * Math.max(1, state.queries.length)
    ? EXPLORE_STOP_REASONS.RESULT_SCREEN_BUDGET
    : null;
}

/**
 * One decision cycle from a fresh OBSERVATION.
 * @param {object} input
 * @param {object} input.state - current lane state
 * @param {object} input.observation - parseExploreSurface output, or a driver
 *        observation failure: { error: true, code }
 * @param {object|null} input.report - driver report for the PREVIOUS decision:
 *        { navigated: boolean, novel: true|false|null }
 * @param {number|null} input.nowMs - current wall time (deadline check)
 * @returns {{state, decision}} decision is exactly one of
 *   { action:"NAVIGATE", navigationRole, candidateKey?, candidateKind?, queryIndex? } |
 *   { action:"DONE", reason } | { action:"STOP", reason }
 */
export function exploreStep({ state, observation, report = null, nowMs = null } = {}) {
  if (!state || state.phase === EXPLORE_PHASES.STOPPED || state.phase === EXPLORE_PHASES.DONE) {
    const decision = state?.phase === EXPLORE_PHASES.DONE
      ? { action: "DONE", reason: state.doneReason ?? "FINISHED" }
      : { action: "STOP", reason: state?.stopReason ?? "LANE_TERMINAL" };
    return { state, decision };
  }

  // 1) fold the driver report of the previous navigation
  let working = state;
  if (report) {
    const failures = report.navigated === false
      ? state.consecutiveNavigationFailures + 1
      : 0;
    let noNovel = state.noNovelScreens;
    let novelOpensUsed = state.novelOpensUsed;
    let claimedKeys = state.claimedKeys;
    if (report.novel === true) {
      noNovel = 0;
      novelOpensUsed += 1;
      if (state.pendingClaimKey && !claimedKeys.includes(state.pendingClaimKey)) {
        claimedKeys = [...claimedKeys, state.pendingClaimKey];
      }
    } else if (report.novel === false) {
      noNovel += 1;
    }
    working = {
      ...state,
      consecutiveNavigationFailures: failures,
      noNovelScreens: noNovel,
      novelOpensUsed,
      claimedKeys,
      pendingClaimKey: null,
    };
    if (failures >= capOf(state.budgets, "consecutiveNavigationFailures")) {
      return finishStop(working, EXPLORE_STOP_REASONS.CONSECUTIVE_NAVIGATION_FAILURES);
    }
    // non-novel reports count wherever they arrive: only navigation decisions
    // that claim a target can report novel:true/false, and BACK/comment navs
    // report novel:null so restoration never pollutes the counter
    if (report.novel === false && noNovel >= capOf(state.budgets, "noNovelScreens")) {
      return finishStop(working, EXPLORE_STOP_REASONS.NO_NOVEL_SCREENS);
    }
  }

  // 2) deadline (machine itself has no clock — time is handed in)
  if (working.startedAtMs !== null
    && Number.isFinite(nowMs)
    && (nowMs - working.startedAtMs) / 1000 >= capOf(working.budgets, "missionDurationSec")) {
    return finishStop(working, EXPLORE_STOP_REASONS.DEADLINE);
  }

  // 3) fold the observation
  if (observation?.error) {
    return finishStop({ ...working, lastPage: null }, EXPLORE_STOP_REASONS.OBSERVATION_ERROR);
  }
  const page = observation?.page ?? null;
  if (page !== null && EXPLORE_EXIT_PAGES.has(page)) {
    return finishStop(working, EXPLORE_STOP_REASONS.FORBIDDEN_SURFACE);
  }
  working = { ...working, lastPage: page };

  return decide(working, observation ?? {}, 0);
}

function finishStop(state, reason) {
  return {
    state: Object.freeze({ ...state, phase: EXPLORE_PHASES.STOPPED, stopReason: reason }),
    decision: { action: "STOP", reason },
  };
}

function finishDone(state, reason) {
  return {
    state: Object.freeze({ ...state, phase: EXPLORE_PHASES.DONE, doneReason: reason }),
    decision: { action: "DONE", reason },
  };
}

// Single tail-recursive re-entry: a BACK that lands on its target surface
// continues the SAME cycle against the same observation (depth-bounded).
function decide(state, observation, depth) {
  const page = state.lastPage;

  if (isHome(page)) {
    if (state.phase === EXPLORE_PHASES.BACK_TO_HOME) {
      return finishDone(state, state.stopReason ?? "FINISHED");
    }
  } else if (state.phase === EXPLORE_PHASES.BACK_TO_HOME) {
    return { state, decision: navDecision("BACK") };
  }

  switch (state.phase) {
    case EXPLORE_PHASES.NEED_OPEN_SEARCH:
      return {
        state: Object.freeze({ ...state, phase: EXPLORE_PHASES.NEED_SUBMIT_QUERY }),
        decision: navDecision("OPEN_SEARCH"),
      };

    case EXPLORE_PHASES.NEED_SUBMIT_QUERY: {
      if (page !== EXPLORE_PAGE.SEARCH_HOME) {
        return { state, decision: navDecision("BACK") };
      }
      if (state.queryIndex >= state.queries.length) {
        return finishStop(state, EXPLORE_STOP_REASONS.QUERIES_BUDGET);
      }
      return {
        state: Object.freeze({
          ...state,
          phase: EXPLORE_PHASES.READ_RESULTS,
          resultScreensUsed: 0,
          scrollsOnCurrentResults: 0,
        }),
        decision: navDecision("SUBMIT_SEARCH", { queryIndex: state.queryIndex }),
      };
    }

    case EXPLORE_PHASES.READ_RESULTS: {
      if (page === EXPLORE_PAGE.SEARCH_HOME) {
        // submit failed to commit (IME kept the editor): retry the SAME sealed
        // query instead of heading BACK — consecutive failures still cap this
        if (depth >= 2) return { state, decision: navDecision("BACK") };
        return decide({ ...state, phase: EXPLORE_PHASES.NEED_SUBMIT_QUERY }, observation, depth + 1);
      }
      if (page !== EXPLORE_PAGE.SEARCH_RESULTS) {
        return { state, decision: navDecision("BACK") };
      }
      const budget = novelOpenBudgetExhausted(state) ?? resultScreenBudgetExhausted(state);
      if (budget) return finishStop(state, budget);
      const candidate = observation.candidates?.[0] ?? null;
      if (candidate?.identity?.keyValue) {
        return {
          state: Object.freeze({ ...state, phase: EXPLORE_PHASES.OPEN_CONTENT, pendingClaimKey: candidate.identity.keyValue }),
          decision: navDecision("OPEN_CONTENT_CARD", {
            candidateKey: candidate.identity.keyValue,
            candidateKind: candidate.identity.keyKind,
          }),
        };
      }
      if (state.resultScreensUsed < capOf(state.budgets, "resultScreensPerQuery")) {
        return {
          state: Object.freeze({
            ...state,
            resultScreensUsed: state.resultScreensUsed + 1,
            scrollsOnCurrentResults: state.scrollsOnCurrentResults + 1,
          }),
          decision: navDecision("SCROLL_RESULTS"),
        };
      }
      return advanceQuery(state);
    }

    case EXPLORE_PHASES.BROWSE_FEED: {
      if (!isHome(page)) {
        return { state, decision: navDecision("BACK") };
      }
      const budget = novelOpenBudgetExhausted(state);
      if (budget) return finishStop(state, budget);
      const candidate = observation.candidates?.[0] ?? null;
      if (candidate?.identity?.keyValue) {
        return {
          state: Object.freeze({ ...state, phase: EXPLORE_PHASES.OPEN_CONTENT, pendingClaimKey: candidate.identity.keyValue }),
          decision: navDecision("OPEN_CONTENT_CARD", {
            candidateKey: candidate.identity.keyValue,
            candidateKind: candidate.identity.keyKind,
          }),
        };
      }
      return { state, decision: navDecision("SCROLL_FEED") };
    }

    case EXPLORE_PHASES.OPEN_CONTENT: {
      if (EXPLORE_DETAIL_PAGES.has(page)) {
        const commentBudgetLeft = state.commentScreensUsed < capOf(state.budgets, "commentScreens");
        if (page === EXPLORE_PAGE.IMAGE_NOTE && commentBudgetLeft) {
          return {
            state: Object.freeze({ ...state, phase: EXPLORE_PHASES.VIEW_COMMENTS }),
            decision: navDecision("OPEN_COMMENT_PANEL"),
          };
        }
        return { state: Object.freeze({ ...state, phase: afterDetailPhase(state) }), decision: navDecision("BACK") };
      }
      // open did not land on a detail page: the driver already reported the
      // failure (or will next cycle); head BACK and resume
      return { state: Object.freeze({ ...state, phase: afterDetailPhase(state) }), decision: navDecision("BACK") };
    }

    case EXPLORE_PHASES.VIEW_COMMENTS: {
      if (page === EXPLORE_PAGE.COMMENT_PANEL) {
        return {
          state: Object.freeze({
            ...state,
            phase: afterDetailPhase(state),
            commentScreensUsed: state.commentScreensUsed + 1,
          }),
          decision: navDecision("BACK"),
        };
      }
      // panel never opened — no screen consumed, head BACK
      return { state: Object.freeze({ ...state, phase: afterDetailPhase(state) }), decision: navDecision("BACK") };
    }

    case EXPLORE_PHASES.BACK_TO_RESULTS: {
      if (state.laneRole === "search_lane" && page === EXPLORE_PAGE.SEARCH_RESULTS) {
        if (depth >= 2) return { state, decision: navDecision("BACK") };
        return decide({ ...state, phase: EXPLORE_PHASES.READ_RESULTS }, observation, depth + 1);
      }
      if (state.laneRole === "feed_lane" && isHome(page)) {
        if (depth >= 2) return { state, decision: navDecision("BACK") };
        return decide({ ...state, phase: EXPLORE_PHASES.BROWSE_FEED }, observation, depth + 1);
      }
      // search lane landed all the way back on SEARCH_HOME → next sealed query
      if (state.laneRole === "search_lane" && page === EXPLORE_PAGE.SEARCH_HOME) {
        return advanceQuery({ ...state, queryIndex: state.queryIndex + 1 });
      }
      return { state, decision: navDecision("BACK") };
    }

    case EXPLORE_PHASES.BACK_TO_HOME: {
      return { state, decision: navDecision("BACK") };
    }

    default:
      return finishStop(state, EXPLORE_STOP_REASONS.OBSERVATION_ERROR);
  }
}

function afterDetailPhase(state) {
  return state.laneRole === "search_lane"
    ? EXPLORE_PHASES.BACK_TO_RESULTS
    : EXPLORE_PHASES.BROWSE_FEED;
}

// Either submit the next sealed query (from SEARCH_HOME) or start semantic
// restoration toward HOME.
function advanceQuery(state) {
  if (state.laneRole === "search_lane" && state.queryIndex + 1 < state.queries.length) {
    return {
      state: Object.freeze({ ...state, phase: EXPLORE_PHASES.NEED_SUBMIT_QUERY, queryIndex: state.queryIndex + 1 }),
      decision: navDecision("BACK"),
    };
  }
  return {
    state: Object.freeze({ ...state, phase: EXPLORE_PHASES.BACK_TO_HOME }),
    decision: navDecision("BACK"),
  };
}