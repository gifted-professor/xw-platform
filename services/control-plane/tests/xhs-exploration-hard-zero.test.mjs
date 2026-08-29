// xhs-exploration-hard-zero.test.mjs — V3 plan §5.2 / V3-I01+I02.
//
// The exploration authority is hard-zero: zero social authority, zero ECP,
// zero effect transport — and its sessions carry a profile that rejects every
// interactive primitive on the generic session-action path, even with the
// caller's real session token and even while global policyMode.active=true.
// Everything runs against the REAL ControlPlane/StateStore stack; only the
// vendor transport is scripted (and never invoked here: hard-zero means no
// interactive transport happens without a permit).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CapabilityRegistry } from "../control-plane/lib/capability-registry.mjs";
import { AdapterRegistry, ControlPlane } from "../control-plane/lib/control-plane.mjs";
import { EvidenceStore } from "../control-plane/lib/evidence-store.mjs";
import { StateStore } from "../control-plane/lib/state-store.mjs";
import { createXiaoweiAdapter } from "../apps/xiaowei/adapter.mjs";

const registry = CapabilityRegistry.load(fileURLToPath(new URL("../apps", import.meta.url)));
const capability = registry.require("xiaowei.explorer.primitive");
const tempBase = fileURLToPath(new URL("../control-plane/runtime", import.meta.url));

function mission(seal) {
  return {
    schemaId: "xw.xhs.exploration-mission.v1",
    schemaVersion: 1,
    templateId: "xhs.explore.goal.v1",
    profile: "xhs_goal_explore_v1",
    externalEffects: 0,
    missionHash: seal?.missionHash ?? "a".repeat(64),
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
    },
    queries: seal?.enumerated
      ? [...Array(seal.enumerated).keys()].map((i) => `q${i}`)
      : [],
  };
}

function noopTransport() {
  return {
    async invoke(input) {
      // hard-zero: this transport must NEVER see an interactive action in this
      // suite — a tap/swipe/input here means the gate leaked.
      const cmd = String(input?.data?.command || "");
      if (cmd.startsWith("input tap") || cmd.startsWith("input swipe") || cmd.startsWith("input text")) {
        throw new Error(`HARD-ZERO VIOLATION: interactive transport observed: ${cmd}`);
      }
      return { code: 10000, data: "" };
    },
  };
}

function fixture() {
  const root = mkdtempSync(join(tempBase, "exploration-hard-zero-"));
  const state = new StateStore({ dbPath: join(root, "control.db") });
  const evidence = new EvidenceStore({
    runsRoot: join(root, "runs"),
    state,
    minFreeBytes: 0,
    minExternalEffectFreeBytes: 0,
  });
  const devices = ["03", "04"].map((alias) => state.upsertDevice({
    alias,
    physicalLabel: `rack-${alias}`,
    nodeId: "DESKTOP-3I1EVHE",
    runtimeId: `exploration-${alias}-runtime`,
    routingProfile: { enabled: true, tags: [`slot:${alias}`], capabilityIds: [capability.id] },
  }));
  const control = new ControlPlane({
    state,
    capabilities: registry,
    adapters: new AdapterRegistry([createXiaoweiAdapter({ transport: noopTransport() })]),
    evidence,
    leaseHeartbeatMs: 5000,
    leaseTtlMs: 60000,
    schedulerIntervalMs: 5,
  });
  control.start();
  let counter = 0;
  return {
    root, state, control,
    deviceByAlias: Object.fromEntries(devices.map((d) => [d.alias, d])),
    async openSession(alias) {
      counter += 1;
      return control.createSession({
        actorId: `explorer-operator-${counter}`,
        placement: { alias },
        capabilityId: capability.id,
        canary: true,
      });
    },
    async registerAuthority(overrides = {}) {
      const s03 = await this.openSession("03");
      const s04 = await this.openSession("04");
      return { s03, s04, authority: control.registerExplorationAuthority({
        sessions: [
          { alias: "03", sessionId: s03.sessionId, token: s03.token },
          { alias: "04", sessionId: s04.sessionId, token: s04.token },
        ],
        executionRunId: "exec-v3-1",
        routineRunId: `routine-v3-${counter}`,
        mission: mission({ enumerated: 2 }),
        planHash: "p".repeat(64),
        releaseId: "xw-v3-offline",
        accountFingerprint: "acct-expl",
        ...overrides,
      }) };
    },
    async close() {
      await control.stop();
      state.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("exploration authority registers [03,04] with profile stamped on BOTH sessions", async () => {
  const f = fixture();
  try {
    const { s03, s04, authority } = await f.registerAuthority();
    assert.equal(authority.status, "active");
    assert.deepEqual(authority.lanes, [{ index: 0, alias: "03", role: "feed_lane" }, { index: 1, alias: "04", role: "search_lane" }]);
    assert.equal(authority.sessionBindings[0].alias, "03");
    assert.equal(authority.sessionBindings[0].laneRole, "feed_lane");
    assert.equal(authority.sessionBindings[1].alias, "04");
    assert.equal(authority.sessionBindings[1].laneRole, "search_lane");
    // profile visible on the stored sessions
    const a = f.state.validateSession(s03.sessionId, s03.token);
    const b = f.state.validateSession(s04.sessionId, s04.token);
    assert.equal(a.profile, "xhs_goal_explore_v1");
    assert.equal(b.profile, "xhs_goal_explore_v1");
  } finally { await f.close(); }
});

test("hard-zero: a profiled session cannot tap/swipe/input/back/launch via the generic path", async () => {
  const f = fixture();
  try {
    const { s03 } = await f.registerAuthority();
    for (const primitive of ["tap", "swipe", "input_text", "back", "launch_app"]) {
      await assert.rejects(
        () => f.control.executeSessionAction(s03.sessionId, s03.token, {
          idempotencyKey: `raw-${primitive}`,
          capabilityId: capability.id,
          params: primitive === "tap" ? { primitive, x: 100, y: 200 } : { primitive },
        }),
        (error) => error.code === "EXPLORATION_PRIMITIVE_FORBIDDEN",
        `primitive ${primitive} must be refused`,
      );
    }
  } finally { await f.close(); }
});

test("hard-zero: a profiled session cannot use any other capability", async () => {
  const f = fixture();
  try {
    const { s03 } = await f.registerAuthority();
    await assert.rejects(
      () => f.control.executeSessionAction(s03.sessionId, s03.token, {
        idempotencyKey: "raw-cap",
        capabilityId: "xiaowei.lab.raw",
        params: { action: "adb_shell", data: { command: "input tap 10 20" } },
      }),
      (error) => error.code === "EXPLORATION_CAPABILITY_FORBIDDEN",
    );
  } finally { await f.close(); }
});

test("hard-zero: sessions without the profile keep the pre-existing behavior (observation primitives allowed)", async () => {
  const f = fixture();
  try {
    const session = await f.openSession("03");
    // dump_ui is in the observation set; the gate only rejects interactivity
    // (the noop transport answers it, no assertion on output needed)
    const job = await f.control.executeSessionAction(session.sessionId, session.token, {
      idempotencyKey: "obs-dump",
      capabilityId: capability.id,
      params: { primitive: "dump_ui" },
    });
    assert.ok(job);
  } finally { await f.close(); }
});

test("authority negatives: alias pair other than exactly [03,04] is refused", async () => {
  const f = fixture();
  try {
    const s03 = await f.openSession("03");
    const s04 = await f.openSession("04");
    const args = {
      executionRunId: "exec-v3-1",
      routineRunId: "routine-v3-bad",
      mission: mission({ enumerated: 2 }),
      planHash: "p".repeat(64),
    };
    assert.throws(
      () => f.control.registerExplorationAuthority({
        sessions: [{ alias: "01", sessionId: s03.sessionId, token: s03.token }, { alias: "02", sessionId: s04.sessionId, token: s04.token }],
        ...args,
      }),
      (error) => error.code === "EXPLORATION_ALIAS_NOT_ALLOWED",
    );
    assert.throws(
      () => f.control.registerExplorationAuthority({
        sessions: [{ alias: "03", sessionId: s03.sessionId, token: s03.token }],
        ...args,
      }),
      (error) => error.code === "EXPLORATION_SESSION_PAIR_REQUIRED",
    );
  } finally { await f.close(); }
});

test("authority negatives: mission schema/caps/lane drift re-checked inside CP trust boundary", async () => {
  const f = fixture();
  try {
    const s03 = await f.openSession("03");
    const s04 = await f.openSession("04");
    const sessions = [
      { alias: "03", sessionId: s03.sessionId, token: s03.token },
      { alias: "04", sessionId: s04.sessionId, token: s04.token },
    ];
    const bad = (patch) => {
      const m = mission({ enumerated: 2 });
      patch(m);
      return m;
    };
    assert.throws(
      () => f.control.registerExplorationAuthority({ sessions, executionRunId: "e", routineRunId: "r1", planHash: "p".repeat(64), mission: bad((m) => { m.externalEffects = 2; }) }),
      (error) => error.code === "EXPLORATION_EFFECTS_NOT_ZERO",
    );
    assert.throws(
      () => f.control.registerExplorationAuthority({ sessions, executionRunId: "e", routineRunId: "r2", planHash: "p".repeat(64), mission: bad((m) => { m.budgets.reservedPrimitives = 9999; }) }),
      // CP re-checks only that budgets are integers ≥ 0 — the FLOOR lives in
      // the compiler's seal; even here a hash-mismatched mission still must
      // not silently register with untouched caps — see HD-2 below.
      (error) => error.code === "EXPLORATION_BUDGET_INVALID" || error.code === "EXPLORATION_MISSION_HASH",
    );
  } finally { await f.close(); }
});

test("hard-zero: per-session authority — second registration over a profiled session is rejected", async () => {
  const f = fixture();
  try {
    const { s03, s04 } = await f.registerAuthority();
    assert.throws(
      () => f.control.registerExplorationAuthority({
        sessions: [
          { alias: "03", sessionId: s03.sessionId, token: s03.token },
          { alias: "04", sessionId: s04.sessionId, token: s04.token },
        ],
        executionRunId: "exec-v3-2",
        routineRunId: "routine-v3-second",
        mission: mission({ enumerated: 2 }),
        planHash: "p".repeat(64),
      }),
      (error) => error.code === "EXPLORATION_SESSION_ALREADY_PROFILED",
    );
  } finally { await f.close(); }
});
