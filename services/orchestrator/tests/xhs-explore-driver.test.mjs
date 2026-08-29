// xhs-explore-driver.test.mjs — P2 typed-driver integration gate.
//
// For every lane: the PURE machine drives, the typed driver resolves payloads
// from the CURRENT dump and executes navigations through the REAL control
// plane (authority → single-use permit → fresh re-observation → byte-exact
// consume → exactly one job) against a scripted device transport that records
// every physical primitive. Proves (plan V2 §5.3 P2 gate):
//   - feed lane E2E: open → comment panel (read-only) → restoration, exact
//     novel claims on the CP target ledger, honest journal, COMMITTED marker;
//   - search lane E2E: OPEN_SEARCH → IME submit → honest retry on the SAME
//     sealed query → claim/confirm one result → comment panel → scroll budget
//     stop → semantic restoration back to HOME;
//   - two consecutive IME failures stop the lane (no endless retype loop);
//   - exit surfaces restore honestly (no fake "restored" for EXIT_PRODUCT,
//     no permit ever issued there);
//   - vision pause is fail-closed (disabled / navigator absent);
//   - zero coordinate fallback (private titles never reach the journal and no
//     remembered coordinate is ever replayed).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { CapabilityRegistry } from "../../control-plane/control-plane/lib/capability-registry.mjs";
import { AdapterRegistry, ControlPlane } from "../../control-plane/control-plane/lib/control-plane.mjs";
import { EvidenceStore } from "../../control-plane/control-plane/lib/evidence-store.mjs";
import { StateStore } from "../../control-plane/control-plane/lib/state-store.mjs";
import { createXiaoweiAdapter } from "../../control-plane/apps/xiaowei/adapter.mjs";

import { createExploreLaneState } from "../scripts/lib/xhs-goal-explore-machine.mjs";
import { createExplorerTypedDriver, runExploreLane } from "../scripts/lib/xhs-explore-driver.mjs";
import {
  homeFeedXml,
  searchHomeXml,
  searchResultsXml,
  imageNoteXml,
  commentPanelXml,
  productEntryXml,
} from "./fixtures/xhs-explore-fixtures.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const registry = CapabilityRegistry.load(join(here, "../../control-plane/apps"));
const capability = registry.require("xiaowei.explorer.primitive");
const runtimeBase = join(here, "../../control-plane/control-plane/runtime");

const BRIDGE_IME = "com.android.xwkeyboard/.XwIME";

// --- scripted device -------------------------------------------------------

/**
 * One scene device per alias. observe() returns the CURRENT scene; every
 * physical primitive recorded through the transport advances the scene.
 */
function createSceneDevice({ scenes }) {
  const state = {
    scenes,
    pointer: 0,
    taps: [], swipes: [], backs: [], enters: [], clears: [], inputTexts: [], launches: [],
  };
  const advance = () => { state.pointer = Math.min(state.pointer + 1, state.scenes.length - 1); };
  const transport = {
    async invoke(input) {
      const code10000 = { code: 10000, data: "" };
      const action = String(input?.action ?? "");
      if (action === "adb_shell") {
        const cmd = String(input?.data?.command ?? "");
        const tap = cmd.match(/^input tap (\d+) (\d+)$/);
        if (tap) { state.taps.push({ x: Number(tap[1]), y: Number(tap[2]) }); advance(); return code10000; }
        const swipe = cmd.match(/^input swipe (\d+) (\d+) (\d+) (\d+)/);
        if (swipe) {
          state.swipes.push({ x1: Number(swipe[1]), y1: Number(swipe[2]), x2: Number(swipe[3]), y2: Number(swipe[4]) });
          advance(); return code10000;
        }
        if (cmd.trim() === "input keyevent 4") { state.backs.push(1); advance(); return code10000; }
        if (cmd.includes("KEYCODE_ENTER")) { state.enters.push(1); advance(); return code10000; }
        if (cmd.includes("KEYCODE_MOVE_END")) { state.clears.push(1); return code10000; }
        if (cmd.startsWith("settings get secure default_input_method")) {
          return { code: 10000, data: `${BRIDGE_IME}\n` };
        }
        if (cmd.startsWith("monkey -p ") || cmd.startsWith("am start")) {
          state.launches.push(cmd.slice(0, 80)); advance(); return { code: 10000, data: "Events injected: 1" };
        }
        if (cmd.includes("dumpsys")) {
          const scene = state.scenes[state.pointer];
          return { code: 10000, data: `mCurrentFocus=Window{123 u0 ${scene.focus}}` };
        }
        return code10000;
      }
      if (action === "inputText") {
        state.inputTexts.push(String(input?.data?.content ?? ""));
        return code10000;
      }
      if (action === "selectIme") return code10000;
      return code10000;
    },
  };
  return {
    state, transport,
    observe: async () => {
      const scene = state.scenes[state.pointer];
      return { focus: scene.focus, xml: scene.xml };
    },
  };
}

// --- authority + CP fixture -------------------------------------------------

function missionHash(seed) {
  return createHash("sha256").update(`fixture-mission-${seed}`).digest("hex");
}

function mission(overrides = {}) {
  return {
    schemaId: "xw.xhs.exploration-mission.v1",
    schemaVersion: 1,
    templateId: "xhs.explore.goal.v1",
    profile: "xhs_goal_explore_v1",
    externalEffects: 0,
    missionHash: missionHash("budgets"),
    placement: { parallel: 2, lanes: [{ index: 0, alias: "03", role: "feed_lane" }, { index: 1, alias: "04", role: "search_lane" }] },
    budgets: {
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
      ...overrides,
    },
    queries: ["咖啡"],
  };
}

function fixture({ scenesByAlias, budgetOverrides = {} } = {}) {
  const devices = {};
  for (const alias of Object.keys(scenesByAlias)) {
    devices[alias] = createSceneDevice({ scenes: scenesByAlias[alias] });
  }
  const root = mkdtempSync(join(runtimeBase, "explore-driver-"));
  const state = new StateStore({ dbPath: join(root, "control.db") });
  const evidence = new EvidenceStore({ runsRoot: join(root, "runs"), state, minFreeBytes: 0, minExternalEffectFreeBytes: 0 });
  for (const alias of Object.keys(scenesByAlias)) {
    state.upsertDevice({
      alias,
      physicalLabel: `rack-${alias}`,
      nodeId: "DESKTOP-3I1EVHE",
      runtimeId: `exploration-${alias}-runtime`,
      routingProfile: { enabled: true, tags: [`slot:${alias}`], capabilityIds: [capability.id] },
    });
  }
  // one adapter, one composite transport: the vendor device is selected per
  // invoke by the runtime serial input.devices
  const aliasByRuntime = Object.fromEntries(
    Object.entries(devices).map(([alias, device]) => [`exploration-${alias}-runtime`, device.transport]),
  );
  const composite = {
    async invoke(input) {
      const target = aliasByRuntime[String(input?.devices ?? "")];
      if (!target) return { code: 404, data: `unknown device ${String(input?.devices ?? "")}` };
      return target.invoke(input);
    },
  };
  const control = new ControlPlane({
    state,
    capabilities: registry,
    adapters: new AdapterRegistry([createXiaoweiAdapter({ transport: composite })]),
    evidence,
    leaseHeartbeatMs: 5000,
    leaseTtlMs: 60000,
    schedulerIntervalMs: 5,
  });
  control.start();
  let counter = 0;
  return {
    root, state, control, devices,
    async registerAuthority(sessionAliases) {
      counter += 1;
      const sessions = {};
      const bindings = [];
      for (const alias of sessionAliases) {
        const session = await control.createSession({
          actorId: `explorer-operator-${counter}-${alias}`,
          placement: { alias },
          capabilityId: capability.id,
          canary: true,
        });
        sessions[alias] = session;
        bindings.push({ alias, sessionId: session.sessionId, token: session.token });
      }
      const authority = control.registerExplorationAuthority({
        sessions: bindings,
        executionRunId: "exec-v3-driver",
        routineRunId: `routine-v3-driver-${counter}`,
        mission: mission({ ...budgetOverrides, missionHash: missionHash(`run-${counter}`) }),
        planHash: "q".repeat(64),
        releaseId: "xw-v3-offline",
        accountFingerprint: "acct-expl",
      });
      return { sessions, authority };
    },
    bindLane({ session, authorityId, laneId, laneRole, queries = [], seed = null }) {
      const journalLog = [];
      const driver = createExplorerTypedDriver({
        authorityId,
        alias: session.alias,
        laneId,
        laneRole,
        session,
        queries,
        seed,
        observeDevice: devices[session.alias].observe,
        issuePermit: (args) => control.issueExplorationPermit({ ...args, sessionId: session.sessionId, token: session.token, authorityId }),
        consumePermit: (args) => control.consumeExplorationPermit({ ...args, sessionId: session.sessionId, token: session.token, authorityId }),
        claimTarget: (args) => control.claimExplorationTarget({ ...args, sessionId: session.sessionId, token: session.token, authorityId }),
        confirmTarget: (args) => control.confirmExplorationTarget({ ...args, sessionId: session.sessionId, token: session.token, authorityId }),
        journalAppend: (record) => {
          journalLog.push(record);
          const { type, ...payload } = record;
          return control.appendExplorationJournal({ sessionId: session.sessionId, token: session.token, authorityId, alias: session.alias, type, payload });
        },
        missionStartedAtMs: 1000,
        now: () => 1000 + (clock += 1), // monotonic fast-forward clock (ms)
      });
      let clock = 0;
      return { driver, journalLog };
    },
    async close() {
      await control.stop();
      state.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function targets(state, authorityId) {
  return state.db.prepare(
    "SELECT key_kind, key_value, novelty FROM exploration_targets WHERE authority_id=? ORDER BY claim_seq",
  ).all(authorityId);
}

function rolesOf(receipt) {
  return receipt.decisions.filter((d) => d.action === "NAVIGATE").map((d) => d.navigationRole);
}

test("feed lane E2E: open → read-only panel → novelty claims → budget stop → journal COMMITTED", async () => {
  const scenes03 = [
    homeFeedXml({ cards: [{ id: "f01", title: "早八人快速早餐记录", author: "阿澄" }, { id: "f02", title: "午后悔了的一杯咖啡", author: "小卡" }, { id: "f03", title: "球场边的夕阳巡航记录", author: "不吃香菜" }] }),
    imageNoteXml({}),
    commentPanelXml({}),
    imageNoteXml({}),
    homeFeedXml({ cards: [{ id: "f01", title: "早八人快速早餐记录", author: "阿澄" }, { id: "f02", title: "午后悔了的一杯咖啡", author: "小卡" }, { id: "f03", title: "球场边的夕阳巡航记录", author: "不吃香菜" }] }),
    imageNoteXml({}),
    homeFeedXml({ cards: [{ id: "f01", title: "早八人快速早餐记录", author: "阿澄" }, { id: "f02", title: "午后悔了的一杯咖啡", author: "小卡" }, { id: "f03", title: "球场边的夕阳巡航记录", author: "不吃香菜" }] }),
  ];
  const f = fixture({
    scenesByAlias: { "03": scenes03, "04": [searchHomeXml()] },
    budgetOverrides: { novelOpens: 2, commentScreens: 1 },
  });
  try {
    const { sessions, authority } = await f.registerAuthority(["03", "04"]);
    const lane = f.bindLane({
      session: { ...sessions["03"], alias: "03" },
      authorityId: authority.authorityId,
      laneId: "lane-0",
      laneRole: "feed_lane",
    });
    const laneState = createExploreLaneState({
      laneRole: "feed_lane",
      alias: "03",
      seed: null,
      budgets: mission({ novelOpens: 2, commentScreens: 1 }).budgets,
      startedAtMs: Date.now(),
    });
    const receipt = await runExploreLane({ driver: lane.driver, laneState });

    assert.equal(receipt.outcome.kind, "STOP");
    assert.equal(receipt.outcome.reason, "NOVEL_OPEN_BUDGET");
    assert.equal(receipt.laneRole, "feed_lane");
    assert.equal(receipt.restored.restored, true, "lane stopped on home — already restored");
    assert.deepEqual(rolesOf(receipt), [
      "OPEN_CONTENT_CARD", "OPEN_COMMENT_PANEL", "BACK", "BACK",
      "OPEN_CONTENT_CARD", "BACK",
    ], "closed-vocabulary walk with the comment cap ending the note visit");

    // physical realism: exactly the recorded taps/back presses drove the walk
    const device = f.devices["03"].state;
    assert.equal(device.taps.length, 3, "two card opens + one comment panel tap");
    assert.equal(device.backs.length, 3);
    assert.equal(device.swipes.length, 0);
    assert.equal(device.inputTexts.length, 0);

    // V3-I05 novelty: one 0→1 credit per claimed stable key
    const rows = targets(f.state, authority.authorityId);
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => row.key_kind === "stable" && row.novelty === 1));
    assert.equal(lane.driver.stats().claimedKeys.length, 2);

    // privacy: pages and hashes only — never a title, an author, or a query
    const serialized = JSON.stringify(lane.journalLog);
    for (const forbidden of ["早八人快速早餐记录", "午后悔了的一杯咖啡", "球场边的夕阳巡航记录", "阿澄", "小卡", "不吃香菜"]) {
      assert.equal(serialized.includes(forbidden), false, `journal must not leak ${forbidden}`);
    }
    const types = lane.journalLog.map((r) => r.type);
    assert.ok(types.includes("OBSERVATION") && types.includes("PERMIT_CONSUMED") && types.includes("TARGET_CLAIMED"));
    for (const record of lane.journalLog) {
      for (const key of ["x", "y", "xml", "token", "text", "primitive"]) {
        assert.equal(JSON.stringify(record[key]), undefined, `journal record carries no ${key}`);
      }
    }

    // lane closeout: COMMITTED marker lands through the real chained journal
    const committed = f.control.commitExplorationLane({
      sessionId: sessions["03"].sessionId, token: sessions["03"].token, authorityId: authority.authorityId,
    });
    assert.equal(committed.alias, "03");
    const view = f.control.getExplorationAuthorityView({
      sessionId: sessions["04"].sessionId, token: sessions["04"].token, authorityId: authority.authorityId,
    });
    assert.equal(view.lanes["03"].committed, true);
  } finally { await f.close(); }
});

test("search lane E2E: IME retry on the SAME query → claim one result → scroll budget stop → BACK to HOME", async () => {
  const home = homeFeedXml({ cards: [{ id: "h01", title: "首页信息流推荐位", author: "阿澄" }], withSearchEntry: true });
  const results = searchResultsXml({ tiles: [{ title: "球场边的夕阳巡航记录", author: "不吃香菜" }] });
  const scenes04 = [
    home,
    searchHomeXml(),
    searchHomeXml(),        // #1 submit did not commit (IME kept the editor)
    results,
    imageNoteXml({ title: "球场边的夕阳巡航记录" }),
    commentPanelXml({}),
    imageNoteXml({ title: "球场边的夕阳巡航记录" }),
    // BACK chain returns to real results (the tile key is now claimed, so the
    // machine scrolls twice into the RESULT_SCREEN_BUDGET stop)
    results, results, results,
    searchHomeXml(),
    home,
  ];
  const f = fixture({
    scenesByAlias: { "03": [searchHomeXml()], "04": scenes04 },
    budgetOverrides: { novelOpens: 2, commentScreens: 1, resultScreensPerQuery: 2 },
  });
  try {
    const { sessions, authority } = await f.registerAuthority(["03", "04"]);
    const session = { ...sessions["04"], alias: "04" };
    const lane = f.bindLane({
      session,
      authorityId: authority.authorityId,
      laneId: "lane-1",
      laneRole: "search_lane",
      queries: ["咖啡"],
    });
    const laneState = createExploreLaneState({
      laneRole: "search_lane",
      alias: "04",
      queries: ["咖啡"],
      budgets: mission({ novelOpens: 2, commentScreens: 1, resultScreensPerQuery: 2 }).budgets,
      startedAtMs: Date.now(),
    });
    const receipt = await runExploreLane({ driver: lane.driver, laneState });

    assert.equal(receipt.outcome.kind, "STOP");
    assert.equal(receipt.outcome.reason, "RESULT_SCREEN_BUDGET");
    const roles = rolesOf(receipt);
    assert.equal(roles.filter((r) => r === "SUBMIT_SEARCH").length, 2, "honest retry of the SAME sealed query");
    assert.deepEqual(roles[0], "OPEN_SEARCH");
    assert.equal(roles.filter((r) => r === "SCROLL_RESULTS").length, 2);
    // per-query scroll budget respected, aggregate cap trips the stop
    assert.equal(receipt.state.resultScreensUsed, 2);
    assert.equal(receipt.state.queryIndex, 0, "no unsealed query was ever submitted");
    assert.equal(receipt.state.consecutiveNavigationFailures, 0, "the IME retry reset the counter on success");
    assert.equal(receipt.restored.restored, true, "BACKs walk results → searchHome → home");
    assert.equal(receipt.restored.backs, 2);

    const device = f.devices["04"].state;
    assert.equal(device.taps.length, 3, "search entry + result card + comment panel");
    assert.deepEqual(device.inputTexts, ["咖啡", "咖啡"], "the sealed query text, twice, never a third");
    assert.equal(device.enters.length, 2);
    assert.equal(device.swipes.length, 2);
    assert.equal(device.backs.length, 4);

    const rows = targets(f.state, authority.authorityId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].key_kind, "fallback");
    assert.equal(rows[0].novelty, 1);
    const serialized = JSON.stringify(lane.journalLog);
    assert.equal(serialized.includes("咖啡"), false, "journal must never carry the sealed query text");
  } finally { await f.close(); }
});

test("two consecutive IME failures stop the lane instead of an endless retype loop", async () => {
  const entryHome = homeFeedXml({ cards: [{ id: "h01", title: "首页信息流推荐位", author: "阿澄" }], withSearchEntry: true });
  const scenes04 = [
    entryHome,
    searchHomeXml(),
    searchHomeXml(),
    searchHomeXml(),
    entryHome,
  ];
  const f = fixture({ scenesByAlias: { "03": [homeFeedXml()], "04": scenes04 } });
  try {
    const { sessions, authority } = await f.registerAuthority(["03", "04"]);
    const lane = f.bindLane({
      session: { ...sessions["04"], alias: "04" },
      authorityId: authority.authorityId,
      laneId: "lane-1",
      laneRole: "search_lane",
      queries: ["咖啡"],
    });
    const receipt = await runExploreLane({
      driver: lane.driver,
      laneState: createExploreLaneState({
        laneRole: "search_lane", alias: "04", queries: ["咖啡"],
        budgets: mission().budgets, startedAtMs: Date.now(),
      }),
    });
    assert.equal(receipt.outcome.kind, "STOP");
    assert.equal(receipt.outcome.reason, "CONSECUTIVE_NAVIGATION_FAILURES");
    assert.equal(f.devices["04"].state.inputTexts.length, 2, "exactly two submissions — not a loop");
    assert.equal(receipt.restored.restored, true, "restoration walks back to the feed");
  } finally { await f.close(); }
});

test("restoration is honest on an exit surface: EXIT_PRODUCT stops the lane and refuses a shielded BACK", async () => {
  const scenes03 = [
    homeFeedXml({ cards: [{ id: "f01", title: "早八人快速早餐记录", author: "阿澄" }] }),
    productEntryXml(),
    homeFeedXml({ cards: [] }),
  ];
  const f = fixture({ scenesByAlias: { "03": scenes03, "04": [imageNoteXml()] } });
  try {
    const { sessions, authority } = await f.registerAuthority(["03", "04"]);
    const lane = f.bindLane({
      session: { ...sessions["03"], alias: "03" },
      authorityId: authority.authorityId,
      laneId: "lane-0",
      laneRole: "feed_lane",
    });
    const receipt = await runExploreLane({
      driver: lane.driver,
      laneState: createExploreLaneState({
        laneRole: "feed_lane", alias: "03",
        budgets: mission().budgets, startedAtMs: Date.now(),
      }),
    });
    assert.equal(receipt.outcome.kind, "STOP");
    assert.equal(receipt.outcome.reason, "FORBIDDEN_SURFACE");
    assert.equal(receipt.restored.restored, false, "an unrestorable surface is recorded, never faked");
    assert.equal(receipt.restored.backs, 0);
    assert.equal(receipt.restored.trail?.[0]?.error, "EXPLORE_PAGE_NOT_PERMITTABLE");
    assert.equal(f.devices["03"].state.taps.length, 1, "only the card open — no permit was ever spent to escape");
    assert.equal(f.devices["03"].state.backs.length, 0);
    assert.equal(lane.driver.stats().consumedPermits, 1);
  } finally { await f.close(); }
});

test("vision pause is fail-closed at the driver: disabled and navigator-absent", async (t) => {
  const f = fixture({
    scenesByAlias: { "03": [imageNoteXml()], "04": [imageNoteXml()] },
    budgetOverrides: { visionAnalysisAttempts: 6 },
  });
  try {
    const { sessions, authority } = await f.registerAuthority(["03", "04"]);
    const disabled = f.bindLane({
      session: { ...sessions["03"], alias: "03" },
      authorityId: authority.authorityId,
      laneId: "lane-0",
      laneRole: "feed_lane",
    });
    await assert.rejects(
      () => disabled.driver.pauseBoundVideo(),
      (error) => error.code === "EXPLORE_VISION_DISABLED",
    );
    // driver bound with the canary flag still refuses: P4 wires the navigator
    const enabledDriver = createExplorerTypedDriver({
      authorityId: authority.authorityId,
      alias: "04",
      laneId: "lane-1",
      laneRole: "search_lane",
      session: { ...sessions["04"], alias: "04" },
      observeDevice: f.devices["04"].observe,
      issuePermit: (args) => f.control.issueExplorationPermit({ ...args, sessionId: sessions["04"].sessionId, token: sessions["04"].token, authorityId: authority.authorityId }),
      consumePermit: (args) => f.control.consumeExplorationPermit({ ...args, sessionId: sessions["04"].sessionId, token: sessions["04"].token, authorityId: authority.authorityId }),
      visionEnabled: true,
    });
    await assert.rejects(
      () => enabledDriver.pauseBoundVideo(),
      (error) => error.code === "EXPLORE_VISION_NAVIGATOR_ABSENT",
    );
    assert.equal(f.devices["03"].state.taps.length, 0);
  } finally { await f.close(); }
});