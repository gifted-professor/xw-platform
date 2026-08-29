// xhs-exploration-budget.test.mjs — V3-I06 atomic shared budgets.
//
// Every lane reserves against the SAME authority ledger: two lanes racing for
// the final slot yield at most one reservation, settles are conservative
// (crash/timeout still consume), and re-settles replay without transition.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import { CapabilityRegistry } from "../control-plane/lib/capability-registry.mjs";
import { AdapterRegistry, ControlPlane } from "../control-plane/lib/control-plane.mjs";
import { EvidenceStore } from "../control-plane/lib/evidence-store.mjs";
import { StateStore } from "../control-plane/lib/state-store.mjs";
import { ControlRouter } from "../control-plane/router.mjs";
import { createXiaoweiAdapter } from "../apps/xiaowei/adapter.mjs";

const registry = CapabilityRegistry.load(fileURLToPath(new URL("../apps", import.meta.url)));
const capability = registry.require("xiaowei.explorer.primitive");
const tempBase = fileURLToPath(new URL("../control-plane/runtime", import.meta.url));
const PROVIDER = Object.freeze({
  kind: "local-pinned",
  pythonHash: "1".repeat(64),
  modelHash: "2".repeat(64),
  scriptHash: "3".repeat(64),
  configHash: "4".repeat(64),
});

function mission(budgets = {}) {
  return {
    schemaId: "xw.xhs.exploration-mission.v1",
    schemaVersion: 1,
    templateId: "xhs.explore.goal.v1",
    profile: "xhs_goal_explore_v1",
    externalEffects: 0,
    missionHash: createHash("sha256").update("fixture-budget-mission").digest("hex"),
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
      providerDecisionDeadlineMs: 8000,
      frameMaxAgeMs: 10000,
      permitTtlMs: 5000,
      perDeviceConcurrency: 1,
      vision: 0,
      ...budgets,
    },
    vision: { mode: "shadow", remoteEgress: false, provider: PROVIDER },
    queries: [],
  };
}

function visionDetail(attempt = 1) {
  return {
    navigationRole: "PAUSE_VIDEO_SAFE_ZONE",
    page: "VIDEO_NOTE",
    evidenceHash: "a".repeat(64),
    frameId: createHash("sha256").update(`frame-${attempt}`).digest("hex"),
    frameHash: createHash("sha256").update(`bytes-${attempt}`).digest("hex"),
    capturedAt: Date.now(),
    dims: { width: 1080, height: 2400 },
    dumpVerdict: "AMBIGUOUS_SAFE",
    positiveRegion: { x: 0, y: 120, w: 1080, h: 1760 },
    protectedZones: [
      { x: 0, y: 0, w: 1080, h: 120 },
      { x: 0, y: 1880, w: 1080, h: 520 },
    ],
    providerIdentity: PROVIDER,
  };
}

function fixture(missionOverride) {
  const noop = { async invoke() { return { code: 10000, data: "" }; } };
  const root = mkdtempSync(join(tempBase, "exploration-budget-"));
  const state = new StateStore({ dbPath: join(root, "control.db") });
  const evidence = new EvidenceStore({
    runsRoot: join(root, "runs"),
    state,
    minFreeBytes: 0,
    minExternalEffectFreeBytes: 0,
  });
  for (const alias of ["03", "04"]) {
    state.upsertDevice({
      alias,
      physicalLabel: `rack-${alias}`,
      nodeId: "DESKTOP-3I1EVHE",
      runtimeId: `exploration-${alias}-runtime`,
      routingProfile: { enabled: true, tags: [`slot:${alias}`], capabilityIds: [capability.id] },
    });
  }
  const control = new ControlPlane({
    state,
    capabilities: registry,
    adapters: new AdapterRegistry([createXiaoweiAdapter({ transport: noop })]),
    evidence,
    leaseHeartbeatMs: 5000,
    leaseTtlMs: 60000,
    schedulerIntervalMs: 5,
  });
  control.start();
  let counter = 0;
  return {
    root, state, control,
    async pair() {
      counter += 1;
      const s03 = await control.createSession({ actorId: `explorer-operator-${counter}a`, placement: { alias: "03" }, capabilityId: capability.id, canary: true });
      const s04 = await control.createSession({ actorId: `explorer-operator-${counter}b`, placement: { alias: "04" }, capabilityId: capability.id, canary: true });
      const authority = control.registerExplorationAuthority({
        sessions: [
          { alias: "03", sessionId: s03.sessionId, token: s03.token },
          { alias: "04", sessionId: s04.sessionId, token: s04.token },
        ],
        executionRunId: "exec-v3-budget",
        routineRunId: `routine-v3-budget-${counter}`,
        mission: missionOverride ?? mission(),
        planHash: "p".repeat(64),
        releaseId: "xw-v3-offline",
        accountFingerprint: "acct-expl",
      });
      return { s03, s04, authority };
    },
    async close() {
      await control.stop();
      state.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("racing lanes get at most cap reservations; the loser refuses with EXPLORATION_BUDGET_EXCEEDED", async () => {
  const f = fixture(mission({ novelOpens: 1 }));
  try {
    const { s03, s04, authority } = await f.pair();
    const first = f.control.reserveExplorationBudget({
      sessionId: s03.sessionId, token: s03.token, authorityId: authority.authorityId,
      alias: "03", kind: "novelOpens", amount: 1, detail: { lane: "feed" },
    });
    assert.equal(first.cap, 1);
    assert.equal(first.used, 1);
    assert.throws(
      () => f.control.reserveExplorationBudget({
        sessionId: s04.sessionId, token: s04.token, authorityId: authority.authorityId,
        alias: "04", kind: "novelOpens", amount: 1, detail: { lane: "search" },
      }),
      (error) => error.code === "EXPLORATION_BUDGET_EXCEEDED",
    );
    // a failed settle conservatively consumes the slot (it stays spent)
    const settled = f.control.settleExplorationReservation({
      sessionId: s03.sessionId, token: s03.token, authorityId: authority.authorityId,
      reservationId: first.reservationId, outcome: "failed",
    });
    assert.equal(settled.state, "failed");
    // budget does NOT come back — a crashed navigation still spent the slot
    assert.throws(
      () => f.control.reserveExplorationBudget({
        sessionId: s04.sessionId, token: s04.token, authorityId: authority.authorityId,
        alias: "04", kind: "novelOpens", amount: 1,
      }),
      (error) => error.code === "EXPLORATION_BUDGET_EXCEEDED",
    );
    // re-settle replays without a second transition
    const replay = f.control.settleExplorationReservation({
      sessionId: s03.sessionId, token: s03.token, authorityId: authority.authorityId,
      reservationId: first.reservationId, outcome: "failed",
    });
    assert.equal(replay.replayed, true);
  } finally { await f.close(); }
});

test("a consumed reservation keeps counting against the cap until the mission ends", async () => {
  const f = fixture(mission({ resultScreensPerQuery: 2 }));
  try {
    const { s03, s04, authority } = await f.pair();
    for (let i = 0; i < 2; i += 1) {
      f.control.reserveExplorationBudget({
        sessionId: s03.sessionId, token: s03.token, authorityId: authority.authorityId,
        kind: "resultScreens", amount: 1, detail: { query: "q1", screen: i },
      });
    }
    assert.throws(
      () => f.control.reserveExplorationBudget({
        sessionId: s04.sessionId, token: s04.token, authorityId: authority.authorityId,
        kind: "resultScreens", amount: 1,
      }),
      (error) => error.code === "EXPLORATION_BUDGET_EXCEEDED",
    );
  } finally { await f.close(); }
});

test("mission partition guard: a reservation under a foreign missionHash is refused", async () => {
  const f = fixture();
  try {
    const { s03, authority } = await f.pair();
    assert.throws(
      () => f.state.reserveExplorationBudget({
        authorityId: authority.authorityId,
        missionHash: createHash("sha256").update("foreign").digest("hex"),
        alias: "03", kind: "primitives", amount: 1,
      }),
      (error) => error.code === "EXPLORATION_PARTITION_MISMATCH",
    );
    void s03;
  } finally { await f.close(); }
});

test("unknown budget kind cannot reserve against an unmapped cap", async () => {
  const f = fixture();
  try {
    const { s03, authority } = await f.pair();
    assert.throws(
      () => f.control.reserveExplorationBudget({
        sessionId: s03.sessionId, token: s03.token, authorityId: authority.authorityId,
        kind: "unbounded" , amount: 1,
      }),
      (error) => error.code === "EXPLORATION_BUDGET_EXCEEDED",
    );
  } finally { await f.close(); }
});

test("vision analysis has a dedicated alias03/feed-only global six-attempt reservation path", async () => {
  const f = fixture();
  try {
    const { s03, s04, authority } = await f.pair();

    // The generic caller-controlled budget API cannot forge either internal
    // vision counter, regardless of which real lane token it holds.
    for (const [session, kind] of [
      [s03, "visionAnalysis"],
      [s04, "visionAnalysis"],
      [s03, "visionPermits"],
      [s04, "visionPermits"],
    ]) {
      assert.throws(
        () => f.control.reserveExplorationBudget({
          sessionId: session.sessionId, token: session.token, authorityId: authority.authorityId,
          kind, amount: 1,
        }),
        (error) => error.code === "EXPLORATION_BUDGET_KIND_INTERNAL",
      );
    }
    assert.equal(f.state.db.prepare(
      "SELECT COUNT(*) AS n FROM exploration_reservations WHERE authority_id=? AND kind IN ('visionAnalysis','visionPermits')",
    ).get(authority.authorityId).n, 0);

    assert.throws(
      () => f.control.reserveExplorationVisionAnalysis({
        sessionId: s04.sessionId, token: s04.token, authorityId: authority.authorityId,
      }),
      (error) => error.code === "EXPLORATION_VISUAL_ALIAS_INELIGIBLE",
    );

    for (let i = 1; i <= 6; i += 1) {
      const reservation = f.control.reserveExplorationVisionAnalysis({
        sessionId: s03.sessionId, token: s03.token, authorityId: authority.authorityId,
        detail: visionDetail(i),
      });
      assert.equal(reservation.used, i);
      assert.equal(reservation.cap, 6);
      assert.equal(reservation.alias, "03");
    }
    assert.throws(
      () => f.control.reserveExplorationVisionAnalysis({
        sessionId: s03.sessionId, token: s03.token, authorityId: authority.authorityId,
        detail: visionDetail(7),
      }),
      (error) => error.code === "EXPLORATION_BUDGET_EXCEEDED",
    );

    const view = f.control.getExplorationAuthorityView({
      sessionId: s03.sessionId, token: s03.token, authorityId: authority.authorityId,
    });
    assert.deepEqual(view.visionCounters, {
      analysisAttempts: 6,
      permitsIssued: 0,
      permitsConsumed: 0,
      physicalTaps: 0,
    });
  } finally { await f.close(); }
});

test("exploration reservations reject zero, negative, fractional, and string amounts", async () => {
  const f = fixture();
  try {
    const { s03, authority } = await f.pair();
    for (const amount of [0, -1, 0.5, "1"]) {
      assert.throws(
        () => f.control.reserveExplorationBudget({
          sessionId: s03.sessionId, token: s03.token, authorityId: authority.authorityId,
          kind: "primitives", amount,
        }),
        (error) => error.code === "EXPLORATION_BUDGET_AMOUNT_INVALID",
      );
    }
  } finally { await f.close(); }
});

test("vision-analysis RPC fixes kind, amount, and alias inside the control plane", async () => {
  const f = fixture();
  try {
    const { s03, authority } = await f.pair();
    const router = new ControlRouter({
      control: f.control,
      state: f.state,
      capabilities: registry,
      evidence: null,
    });
    const path = `/control/v1/exploration-authority/${authority.authorityId}/vision-analysis`;
    const accepted = await router.handle({
      method: "POST",
      path,
      body: { sessionId: s03.sessionId, token: s03.token, detail: visionDetail(1) },
    });
    assert.equal(accepted.status, 201);
    assert.equal(accepted.body.reservation.alias, "03");
    assert.equal(accepted.body.reservation.amount, 1);
    assert.equal(accepted.body.reservation.kind, "visionAnalysisAttempts");
    const settled = await router.handle({
      method: "POST",
      path,
      body: {
        sessionId: s03.sessionId,
        token: s03.token,
        action: "settle",
        reservationId: accepted.body.reservation.reservationId,
        outcome: "failed",
      },
    });
    assert.equal(settled.status, 200);
    assert.equal(settled.body.reservation.state, "failed");

    for (const forged of [{ alias: "04" }, { amount: 6 }, { kind: "visionPermits" }]) {
      await assert.rejects(
        () => router.handle({
          method: "POST",
          path,
          body: { sessionId: s03.sessionId, token: s03.token, ...forged },
        }),
        (error) => error.code === "EXPLORATION_VISION_ANALYSIS_INPUT_FORBIDDEN",
      );
    }
    assert.equal(f.state.getExplorationVisionCounters(authority.authorityId).analysisAttempts, 1);
  } finally { await f.close(); }
});
