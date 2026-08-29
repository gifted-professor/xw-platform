// xhs-goal-explore-machine.test.mjs — P2 pure lane-machine transitions.
// Proves with fixtures ONLY (plan V2 §6 P2 gate): closed-vocabulary decisions,
// exact consecutive-failure / no-novel stops, budget stops, deadline, exit
// surfaces, IME resubmit, and semantic final restoration (BACK→HOME→DONE).
// The machine emits NAVIGATE intents only — never a primitive, token, or
// coordinate field.
import test from "node:test";
import assert from "node:assert/strict";

import {
  createExploreLaneState,
  exploreStep,
  EXPLORE_PHASES,
  EXPLORE_STOP_REASONS,
} from "../scripts/lib/xhs-goal-explore-machine.mjs";

const CLOSED_ROLES = new Set([
  "OPEN_SEARCH", "SUBMIT_SEARCH", "SCROLL_FEED", "SCROLL_RESULTS",
  "OPEN_CONTENT_CARD", "OPEN_COMMENT_PANEL", "SCROLL_COMMENTS",
  "PAUSE_VIDEO_SAFE_ZONE", "BACK", "RESTORE",
]);

const BUDGETS = Object.freeze({
  missionDurationSec: 600,
  reservedPrimitives: 80,
  novelOpens: 8,
  sealedQueries: 2,
  resultScreensPerQuery: 2,
  commentScreens: 6,
  consecutiveNavigationFailures: 2,
  noNovelScreens: 2,
  visionAnalysisAttempts: 6,
  visionMaxIssuedPermits: 1,
  visionMaxPhysicalTaps: 1,
  vision: 0,
});

function home(keys) {
  return {
    page: "HOME_FEED",
    candidates: keys.map((keyValue) => ({ identity: { keyKind: "fallback", keyValue } })),
  };
}
const searchHome = { page: "SEARCH_HOME" };
const results = (keys) => ({
  page: "SEARCH_RESULTS",
  candidates: keys.map((keyValue) => ({ identity: { keyKind: "fallback", keyValue } })),
});
const imageNote = { page: "IMAGE_NOTE", commentControl: { x: 360, y: 1950 } };
const videoNote = { page: "VIDEO_NOTE" };
const commentPanel = { page: "COMMENT_PANEL" };

/** Assert a NAVIGATE decision inside the closed vocabulary, carrying no
 *  physical anything (no coordinates, no text, no primitive, no token). */
function assertIntent(step, role, extra = {}) {
  assert.equal(step.decision.action, "NAVIGATE", `expected NAVIGATE ${role}, got ${JSON.stringify(step.decision)}`);
  assert.equal(step.decision.navigationRole, role);
  assert.ok(CLOSED_ROLES.has(role));
  for (const forbidden of ["x", "y", "x1", "y1", "x2", "y2", "text", "token", "primitive", "path"]) {
    assert.equal(step.decision[forbidden], undefined, `machine decision must never carry ${forbidden}`);
  }
  for (const [key, value] of Object.entries(extra)) {
    assert.deepEqual(step.decision[key], value);
  }
  return step;
}

function expectStop(step, reason) {
  assert.equal(step.decision.action, "STOP");
  assert.equal(step.decision.reason, reason);
  assert.equal(step.state.phase, EXPLORE_PHASES.STOPPED);
  assert.equal(step.state.stopReason, reason);
  return step;
}

test("search lane: full 2-query walk ends DONE at HOME with exact consumption", () => {
  let s = createExploreLaneState({
    laneRole: "search_lane", alias: "04", seed: "s1",
    queries: ["咖啡", "低卡早餐"], budgets: BUDGETS, startedAtMs: 1000,
  });
  const REP = { navigated: true, novel: null };

  // home → open search
  let r = exploreStep({ state: s, observation: home([]), nowMs: 1100 });
  s = r.state; assertIntent(r, "OPEN_SEARCH");
  assert.equal(s.phase, EXPLORE_PHASES.NEED_SUBMIT_QUERY);

  // search home → submit q0
  r = exploreStep({ state: s, observation: searchHome, report: REP, nowMs: 1200 });
  s = r.state; assertIntent(r, "SUBMIT_SEARCH", { queryIndex: 0 });
  assert.equal(s.phase, EXPLORE_PHASES.READ_RESULTS);

  // results → open r1
  r = exploreStep({ state: s, observation: results(["r1"]), report: REP, nowMs: 1300 });
  s = r.state; assertIntent(r, "OPEN_CONTENT_CARD", { candidateKey: "r1", candidateKind: "fallback" });
  assert.equal(s.pendingClaimKey, "r1");

  // IMAGE_NOTE → comments requested (novel credit folded)
  r = exploreStep({ state: s, observation: imageNote, report: { navigated: true, novel: true }, nowMs: 1400 });
  s = r.state; assertIntent(r, "OPEN_COMMENT_PANEL");
  assert.equal(s.novelOpensUsed, 1);
  assert.deepEqual([...s.claimedKeys], ["r1"]);
  assert.equal(s.phase, EXPLORE_PHASES.VIEW_COMMENTS);

  // COMMENT_PANEL → BACK, one comment screen consumed
  r = exploreStep({ state: s, observation: commentPanel, report: REP, nowMs: 1500 });
  s = r.state; assertIntent(r, "BACK");
  assert.equal(s.commentScreensUsed, 1);
  assert.equal(s.phase, EXPLORE_PHASES.BACK_TO_RESULTS);

  // BACK lands on results with the claimed key filtered out → scroll budget
  r = exploreStep({ state: s, observation: results([]), report: REP, nowMs: 1600 });
  s = r.state; assertIntent(r, "SCROLL_RESULTS");
  assert.equal(s.resultScreensUsed, 1);
  r = exploreStep({ state: s, observation: results([]), report: REP, nowMs: 1700 });
  s = r.state; assertIntent(r, "SCROLL_RESULTS");
  assert.equal(s.resultScreensUsed, 2);

  // scroll budget spent → next sealed query (via BACK toward search home)
  r = exploreStep({ state: s, observation: results([]), report: REP, nowMs: 1800 });
  s = r.state; assertIntent(r, "BACK");
  assert.equal(s.queryIndex, 1);
  assert.equal(s.phase, EXPLORE_PHASES.NEED_SUBMIT_QUERY);

  // search home on the way back → submit q1
  r = exploreStep({ state: s, observation: searchHome, report: REP, nowMs: 1900 });
  s = r.state; assertIntent(r, "SUBMIT_SEARCH", { queryIndex: 1 });

  // results → open r2 → comments → back
  r = exploreStep({ state: s, observation: results(["r2"]), report: REP, nowMs: 2000 });
  s = r.state; assertIntent(r, "OPEN_CONTENT_CARD", { candidateKey: "r2" });
  r = exploreStep({ state: s, observation: imageNote, report: { navigated: true, novel: true }, nowMs: 2100 });
  s = r.state; assertIntent(r, "OPEN_COMMENT_PANEL");
  assert.equal(s.novelOpensUsed, 2);
  r = exploreStep({ state: s, observation: commentPanel, report: REP, nowMs: 2200 });
  s = r.state; assertIntent(r, "BACK");

  // results dried up → scrolls → queries exhausted → semantic restoration
  r = exploreStep({ state: s, observation: results([]), report: REP, nowMs: 2300 });
  s = r.state; assertIntent(r, "SCROLL_RESULTS");
  r = exploreStep({ state: s, observation: results([]), report: REP, nowMs: 2400 });
  s = r.state; assertIntent(r, "SCROLL_RESULTS");
  r = exploreStep({ state: s, observation: results([]), report: REP, nowMs: 2500 });
  s = r.state; assertIntent(r, "BACK");
  assert.equal(s.phase, EXPLORE_PHASES.BACK_TO_HOME, "no further query — restore toward HOME");

  // BACK walks through SEARCH_HOME without treating it as a submit surface
  r = exploreStep({ state: s, observation: searchHome, report: REP, nowMs: 2600 });
  s = r.state; assertIntent(r, "BACK");
  assert.equal(s.phase, EXPLORE_PHASES.BACK_TO_HOME);

  // HOME re-observed → DONE (semantic final restoration complete)
  r = exploreStep({ state: s, observation: home([]), report: REP, nowMs: 2700 });
  assert.equal(r.decision.action, "DONE");
  assert.equal(r.decision.reason, "FINISHED");
  assert.equal(r.state.phase, EXPLORE_PHASES.DONE);
  // terminal lanes are stable: repeated steps return the same DONE
  const again = exploreStep({ state: r.state, observation: home([]) });
  assert.equal(again.decision.action, "DONE");
  assert.equal(s.commentScreensUsed, 2);
  assert.equal(s.novelOpensUsed, 2);
});

test("feed lane: video note never triggers comments (vision canary only)", () => {
  let s = createExploreLaneState({
    laneRole: "feed_lane", alias: "03", seed: "s1",
    budgets: { ...BUDGETS, novelOpens: 2, commentScreens: 6 },
  });
  let r = exploreStep({ state: s, observation: home(["v1"]) });
  s = r.state; assertIntent(r, "OPEN_CONTENT_CARD", { candidateKey: "v1" });
  r = exploreStep({ state: s, observation: videoNote, report: { navigated: true, novel: true } });
  s = r.state; assertIntent(r, "BACK"); // never PAUSE without the vision canary
  r = exploreStep({ state: s, observation: home(["v2"]), report: { navigated: true, novel: null } });
  s = r.state; assertIntent(r, "OPEN_CONTENT_CARD", { candidateKey: "v2" });
  r = exploreStep({ state: s, observation: videoNote, report: { navigated: true, novel: true } });
  s = r.state; assertIntent(r, "BACK");
  r = exploreStep({ state: s, observation: home(["v3"]), report: { navigated: true, novel: null } });
  expectStop(r, EXPLORE_STOP_REASONS.NOVEL_OPEN_BUDGET);
});

test("feed lane without candidates scrolls the HOME feed", () => {
  let s = createExploreLaneState({ laneRole: "feed_lane", alias: "03", seed: "s1", budgets: BUDGETS });
  let r = exploreStep({ state: s, observation: home([]) });
  assertIntent(r, "SCROLL_FEED");
  r = exploreStep({ state: r.state, observation: { page: "HOME_FEED_EMPTY", candidates: [] }, report: { navigated: true, novel: null } });
  assertIntent(r, "SCROLL_FEED");
});

test("consecutive-failure stop trips EXACTLY at the sealed cap and resets on success", () => {
  const budgets = { ...BUDGETS, consecutiveNavigationFailures: 2 };
  const fresh = () => createExploreLaneState({ laneRole: "feed_lane", alias: "03", seed: "s1", budgets });
  // failure 1 (from an OPEN_CONTENT decision): below cap → the lane retreats, no stop
  let s = { ...createExploreLaneState({ laneRole: "feed_lane", alias: "03", seed: "s1", budgets }), phase: EXPLORE_PHASES.OPEN_CONTENT, pendingClaimKey: "a" };
  let r = exploreStep({ state: s, observation: imageNote, report: { navigated: false, novel: null } });
  s = r.state;
  assertIntent(r, "OPEN_COMMENT_PANEL"); // the open landed on the note; the walk continues
  assert.equal(s.consecutiveNavigationFailures, 1);
  assert.notEqual(s.phase, EXPLORE_PHASES.STOPPED);
  // failure 2 from the same browsing phase: EXACTLY at cap → stop
  const trip = exploreStep({
    state: { ...fresh(), phase: EXPLORE_PHASES.OPEN_CONTENT, consecutiveNavigationFailures: 1 },
    observation: imageNote,
    report: { navigated: false, novel: null },
  });
  expectStop(trip, EXPLORE_STOP_REASONS.CONSECUTIVE_NAVIGATION_FAILURES);
  // a successful novel navigation resets the counter to zero
  s = { ...fresh(), phase: EXPLORE_PHASES.OPEN_CONTENT, consecutiveNavigationFailures: 1, pendingClaimKey: "a" };
  r = exploreStep({ state: s, observation: imageNote, report: { navigated: true, novel: true } });
  s = r.state; assertIntent(r, "OPEN_COMMENT_PANEL");
  assert.equal(s.consecutiveNavigationFailures, 0);
});

test("no-novel stop trips EXACTLY at the sealed cap; novel:true resets; BACK does not", () => {
  const budgets = { ...BUDGETS, noNovelScreens: 2 };
  const REP = { navigated: true, novel: null };
  let s = createExploreLaneState({ laneRole: "feed_lane", alias: "03", seed: "s1", budgets });
  // first non-novel open (counter 1, below cap) — video detail needs no comment
  // budget, so the walk continues cleanly
  let r = exploreStep({ state: s, observation: home(["a"]) });
  s = r.state; assertIntent(r, "OPEN_CONTENT_CARD");
  r = exploreStep({ state: s, observation: videoNote, report: { navigated: true, novel: false } });
  s = r.state; assertIntent(r, "BACK");
  assert.equal(s.noNovelScreens, 1);
  // BACK (novel:null) does NOT reset and does NOT increment
  r = exploreStep({ state: s, observation: home(["b"]), report: REP });
  s = r.state; assertIntent(r, "OPEN_CONTENT_CARD", { candidateKey: "b" });
  assert.equal(s.noNovelScreens, 1, "novel:null keeps the counter");
  // second non-novel claim: exactly at cap → stop
  r = exploreStep({ state: s, observation: videoNote, report: { navigated: true, novel: false } });
  expectStop(r, EXPLORE_STOP_REASONS.NO_NOVEL_SCREENS);
  // novel:true resets the counter before the cap
  let f = createExploreLaneState({ laneRole: "feed_lane", alias: "03", seed: "s1", budgets });
  f = exploreStep({ state: f, observation: home(["a"]) }).state;
  f = exploreStep({ state: f, observation: videoNote, report: { navigated: true, novel: false } }).state;
  f = exploreStep({ state: f, observation: home(["b"]), report: REP }).state;
  f = exploreStep({ state: f, observation: videoNote, report: { navigated: true, novel: true } }).state;
  f = exploreStep({ state: f, observation: home(["c"]), report: REP }).state;
  assert.equal(f.noNovelScreens, 0, "novel:true resets");
});

test("budget stops: aggregate resultScreens cap across queries and commentScreens", () => {
  const budgets = { ...BUDGETS, resultScreensPerQuery: 2 };
  const REP = { navigated: true, novel: null };
  let s = createExploreLaneState({
    laneRole: "search_lane", alias: "04", seed: "s1", budgets,
    queries: ["咖啡", "低卡早餐"],
  });
  s = exploreStep({ state: s, observation: home([]) }).state; // OPEN_SEARCH
  s = exploreStep({ state: s, observation: searchHome, report: REP }).state; // SUBMIT q0
  s = exploreStep({ state: s, observation: results(["r1"]), report: REP }).state; // OPEN r1
  s = exploreStep({ state: s, observation: imageNote, report: { navigated: true, novel: true } }).state; // COMMENT
  s = exploreStep({ state: s, observation: commentPanel, report: REP }).state; // BACK
  s = exploreStep({ state: s, observation: results([]), report: REP }).state; // SCROLL 1
  s = exploreStep({ state: s, observation: results([]), report: REP }).state; // SCROLL 2
  let r = exploreStep({ state: s, observation: results([]), report: REP });
  s = r.state; assertIntent(r, "BACK"); // scroll budget spent → next query
  r = exploreStep({ state: s, observation: searchHome, report: REP });
  s = r.state; assertIntent(r, "SUBMIT_SEARCH", { queryIndex: 1 }); // fresh per-query budget
  r = exploreStep({ state: s, observation: results([]), report: REP });
  s = r.state; assertIntent(r, "SCROLL_RESULTS");
  // forced exhaustion: the aggregate cap always wins before another scroll
  const forced = { ...s, phase: EXPLORE_PHASES.READ_RESULTS, resultScreensUsed: 4 };
  expectStop(exploreStep({ state: forced, observation: results([]), report: REP }), EXPLORE_STOP_REASONS.RESULT_SCREEN_BUDGET);
});

test("commentScreens cap: a lane at the cap keeps browsing but never requests a panel", () => {
  const REP = { navigated: true, novel: null };
  let s = createExploreLaneState({
    laneRole: "feed_lane", alias: "03", seed: "s1", budgets: { ...BUDGETS, commentScreens: 1 },
  });
  s = exploreStep({ state: s, observation: home(["a"]) }).state; // OPEN a
  s = exploreStep({ state: s, observation: imageNote, report: { navigated: true, novel: true } }).state; // OPEN_COMMENT
  s = exploreStep({ state: s, observation: commentPanel, report: REP }).state; // BACK, consumed 1
  s = exploreStep({ state: s, observation: home(["b"]), report: REP }).state; // OPEN b — browsing continues
  const r = exploreStep({ state: s, observation: imageNote, report: { navigated: true, novel: true } });
  s = r.state;
  assertIntent(r, "BACK"); // cap spent — no second comment panel request
  assert.equal(s.commentScreensUsed, 1);
});

test("comment screen is consumed only when the panel actually opened", () => {
  const budgets = { ...BUDGETS, commentScreens: 2 };
  let s = createExploreLaneState({ laneRole: "feed_lane", alias: "03", seed: "s1", budgets });
  s = exploreStep({ state: s, observation: home(["a"]) }).state; // OPEN a
  // the step that lands on the note emits the panel request
  const panelRequest = exploreStep({ state: s, observation: imageNote, report: { navigated: true, novel: true } });
  assertIntent(panelRequest, "OPEN_COMMENT_PANEL");
  const before = panelRequest.state.commentScreensUsed;
  assert.equal(before, 0);
  // report says the panel never opened (navigation failed) → no screen consumed
  const failed = exploreStep({
    state: panelRequest.state, observation: imageNote, report: { navigated: false, novel: null },
  });
  assert.equal(failed.state.commentScreensUsed, before);
  // a confirmed panel press consumes exactly one screen
  const opened = exploreStep({
    state: panelRequest.state, observation: commentPanel, report: { navigated: true, novel: null },
  });
  assertIntent(opened, "BACK");
  assert.equal(opened.state.commentScreensUsed, 1);
});

test("deadline stop is exact: before the mission duration the lane continues", () => {
  const budgets = { ...BUDGETS, missionDurationSec: 600 };
  let s = createExploreLaneState({
    laneRole: "feed_lane", alias: "03", seed: "s1", budgets, startedAtMs: 1000,
  });
  const beforeDeadline = exploreStep({ state: s, observation: home(["a"]), nowMs: 1000 + 599_000 });
  assertIntent(beforeDeadline, "OPEN_CONTENT_CARD");
  const atDeadline = exploreStep({
    state: beforeDeadline.state, observation: home(["a"]), nowMs: 1000 + 600_000,
  });
  expectStop(atDeadline, EXPLORE_STOP_REASONS.DEADLINE);
});

test("no wall clock: a lane without startedAtMs never trips the deadline", () => {
  const s = createExploreLaneState({
    laneRole: "feed_lane", alias: "03", seed: "s1", budgets: BUDGETS, startedAtMs: null,
  });
  const r = exploreStep({ state: s, observation: home(["a"]), nowMs: 999_999_999_999 });
  assertIntent(r, "OPEN_CONTENT_CARD");
});

test("forbidden and unreadable observations stop the lane immediately", () => {
  let s = createExploreLaneState({ laneRole: "feed_lane", alias: "03", seed: "s1", budgets: BUDGETS });
  expectStop(exploreStep({ state: s, observation: { page: "EXIT_PRODUCT" } }), EXPLORE_STOP_REASONS.FORBIDDEN_SURFACE);
  expectStop(exploreStep({ state: s, observation: { page: "EXIT_AUTH_RISK" } }), EXPLORE_STOP_REASONS.FORBIDDEN_SURFACE);
  const err = exploreStep({ state: s, observation: { error: true, code: "EXPLORER_DUMP_TIMEOUT" } });
  expectStop(err, EXPLORE_STOP_REASONS.OBSERVATION_ERROR);
});

test("queries budget: a submit decision beyond the sealed query list is a stop", () => {
  const s = createExploreLaneState({
    laneRole: "search_lane", alias: "04", seed: "s1", budgets: BUDGETS,
    queries: ["咖啡", "低卡早餐"],
  });
  const forced = { ...s, phase: EXPLORE_PHASES.NEED_SUBMIT_QUERY, queryIndex: 5 };
  const r = exploreStep({ state: forced, observation: searchHome });
  expectStop(r, EXPLORE_STOP_REASONS.QUERIES_BUDGET);
});

test("IME failure: READ_RESULTS landing back on SEARCH_HOME resubmits the SAME query index", () => {
  const REP = { navigated: true, novel: null };
  let s = createExploreLaneState({
    laneRole: "search_lane", alias: "04", seed: "s1", budgets: BUDGETS,
    queries: ["咖啡", "低卡早餐"],
  });
  s = exploreStep({ state: s, observation: home([]) }).state; // OPEN_SEARCH
  s = exploreStep({ state: s, observation: searchHome, report: REP }).state; // SUBMIT q0
  // submit #1 did not commit (IME kept the editor) — still SEARCH_HOME
  let r = exploreStep({ state: s, observation: searchHome, report: { navigated: false, novel: null } });
  s = r.state;
  assertIntent(r, "SUBMIT_SEARCH", { queryIndex: 0 });
  assert.equal(s.consecutiveNavigationFailures, 1);
  // a second consecutive failure is the sealed stop, not an endless retype loop
  const trip = exploreStep({ state: s, observation: searchHome, report: { navigated: false, novel: null } });
  expectStop(trip, EXPLORE_STOP_REASONS.CONSECUTIVE_NAVIGATION_FAILURES);
});