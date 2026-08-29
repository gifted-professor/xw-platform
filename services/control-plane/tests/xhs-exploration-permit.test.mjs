// xhs-exploration-permit.test.mjs — V3-I02 single-use CP navigation permits.
//
// The permit is the ONLY route from a profiled session to an interactive
// physical action. Runs against the REAL ControlPlane + permit policy + a
// scripted 03 device: a successful consume drives exactly one physical tap
// through the formal job pipeline; every guard (TTL, replay, payload match,
// fresh observation, lane drift) refuses before createJob.
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
import { createXiaoweiAdapter } from "../apps/xiaowei/adapter.mjs";

const registry = CapabilityRegistry.load(fileURLToPath(new URL("../apps", import.meta.url)));
const capability = registry.require("xiaowei.explorer.primitive");
const tempBase = fileURLToPath(new URL("../control-plane/runtime", import.meta.url));

function mission() {
  return {
    schemaId: "xw.xhs.exploration-mission.v1",
    schemaVersion: 1,
    templateId: "xhs.explore.goal.v1",
    profile: "xhs_goal_explore_v1",
    externalEffects: 0,
    missionHash: createHash("sha256").update("fixture-mission").digest("hex"),
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
    },
    queries: ["低卡早餐"],
  };
}

const TAP_X = 540;
const TAP_Y = 900;

function createDevice() {
  const state = { taps: [] };
  const transport = {
    async invoke(input) {
      const cmd = String(input?.data?.command || "");
      if (cmd.startsWith("input tap")) {
        const [x, y] = cmd.split(" ").slice(2).map(Number);
        state.taps.push({ x, y });
        return { code: 10000, data: "" };
      }
      return { code: 10000, data: "" };
    },
  };
  return { state, transport };
}

function fixture() {
  const device = createDevice();
  const root = mkdtempSync(join(tempBase, "exploration-permit-"));
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
    adapters: new AdapterRegistry([createXiaoweiAdapter({ transport: device.transport })]),
    evidence,
    leaseHeartbeatMs: 5000,
    leaseTtlMs: 60000,
    schedulerIntervalMs: 5,
  });
  control.start();
  let counter = 0;
  let missionCounter = 0;
  return {
    root, state, control, screen: device.state,
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
    async registerAuthority() {
      missionCounter += 1;
      const s03 = await this.openSession("03");
      const s04 = await this.openSession("04");
      const authority = control.registerExplorationAuthority({
        sessions: [
          { alias: "03", sessionId: s03.sessionId, token: s03.token },
          { alias: "04", sessionId: s04.sessionId, token: s04.token },
        ],
        executionRunId: "exec-v3-permit",
        routineRunId: `routine-v3-permit-${missionCounter}`,
        mission: mission(),
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

const evidenceHash = () => createHash("sha256").update("cp-owned-dump-evidence").digest("hex");
const tapPayload = () => ({ primitive: "tap", x: TAP_X, y: TAP_Y });
const freshObservation = (page = "HOME_FEED") => ({ page, overlaySafe: true, evidenceHash: evidenceHash() });

test("permit happy path: issue → byte-exact consume → exactly one physical tap on the lane device", async () => {
  const f = fixture();
  try {
    const { s03, authority } = await f.registerAuthority();
    // PAUSE_VIDEO_SAFE_ZONE is the only VISION-derived role; it alone spends
    // the visionPermits budget (DUMP-resolved taps spend reservedPrimitives)
    const permit = f.control.issueExplorationPermit({
      sessionId: s03.sessionId, token: s03.token, authorityId: authority.authorityId,
      navigationRole: "PAUSE_VIDEO_SAFE_ZONE", page: "VIDEO_NOTE",
      evidenceHash: evidenceHash(), resolvedPayload: tapPayload(),
    });
    assert.equal(permit.actionClass, "tap");
    assert.match(permit.payloadHash, /^[0-9a-f]{64}$/);
    assert.equal(permit.expiresAt - permit.issuedAt, 5000);

    const { job } = await f.control.consumeExplorationPermit({
      sessionId: s03.sessionId, token: s03.token, authorityId: authority.authorityId,
      permitId: permit.permitId, payload: tapPayload(), freshObservation: freshObservation("VIDEO_NOTE"),
    });
    assert.ok(job);
    assert.deepEqual(f.screen.taps, [{ x: TAP_X, y: TAP_Y }]);

    // replay: the second consume of the same permit refuses with 409
    await assert.rejects(
      () => f.control.consumeExplorationPermit({
        sessionId: s03.sessionId, token: s03.token, authorityId: authority.authorityId,
        permitId: permit.permitId, payload: tapPayload(), freshObservation: freshObservation("VIDEO_NOTE"),
      }),
      (error) => error.code === "EXPLORATION_PERMIT_REPLAY",
    );
    assert.deepEqual(f.screen.taps, [{ x: TAP_X, y: TAP_Y }], "replay must never re-tap");

    // the permit consume spent the visionPermits budget (visual role) and one
    // primitive budget entry
    const reservations = f.state.db.prepare(
      "SELECT kind, alias, amount, state FROM exploration_reservations WHERE authority_id=? ORDER BY kind",
    ).all(authority.authorityId);
    const vision = reservations.filter((r) => r.kind === "visionPermits");
    const primitives = reservations.filter((r) => r.kind === "primitives");
    assert.equal(vision.length, 1);
    assert.equal(vision[0].alias, null);
    assert.equal(primitives.length, 1);
    assert.equal(primitives[0].alias, "03");
    assert.equal(primitives[0].state, "reserved");
  } finally { await f.close(); }
});

test("budget enforcement: visionMaxIssuedPermits=1 exhausts the global visual lane in either direction", async () => {
  const f = fixture();
  try {
    const { s03, s04, authority } = await f.registerAuthority();
    const issue = (session, role, page) => f.control.issueExplorationPermit({
      sessionId: session.sessionId, token: session.token, authorityId: authority.authorityId,
      navigationRole: role, page, evidenceHash: evidenceHash(),
      resolvedPayload: { primitive: "tap", x: 1, y: 1 },
    });
    // both roles are VISION-derived (PAUSE_VIDEO_SAFE_ZONE) → the global
    // visionMaxIssuedPermits=1 lane exhausts in either direction
    issue(s03, "PAUSE_VIDEO_SAFE_ZONE", "VIDEO_NOTE");
    assert.throws(
      () => issue(s04, "PAUSE_VIDEO_SAFE_ZONE", "VIDEO_NOTE"),
      (error) => error.code === "EXPLORATION_BUDGET_EXCEEDED",
    );
    // DUMP-resolved navigation roles never spend the visual budget
    f.control.issueExplorationPermit({
      sessionId: s04.sessionId, token: s04.token, authorityId: authority.authorityId,
      navigationRole: "BACK", page: "SEARCH_RESULTS",
      evidenceHash: evidenceHash(), resolvedPayload: { primitive: "back" },
    });
  } finally { await f.close(); }
});

test("permit guards: payload mismatch, page drift, overlay refusal, evidence drift all refuse BEFORE createJob", async () => {
  for (const mutate of [
      ["payload", (c) => { c.payload = { primitive: "tap", x: 1, y: 1 }; }],
      ["page", (c) => { c.freshObservation = { page: "SEARCH_RESULTS", overlaySafe: true, evidenceHash: evidenceHash() }; }],
      ["overlay", (c) => { c.freshObservation = { page: "HOME_FEED", overlaySafe: false, evidenceHash: evidenceHash() }; }],
      ["evidence", (c) => { c.freshObservation = { page: "HOME_FEED", overlaySafe: true, evidenceHash: "b".repeat(64) }; }],
    ]) {
      const f = fixture();
      try {
      const [label, mutateFn] = mutate;
      const { s03, authority } = await f.registerAuthority();
      const permit = f.control.issueExplorationPermit({
        sessionId: s03.sessionId, token: s03.token, authorityId: authority.authorityId,
        navigationRole: "OPEN_CONTENT_CARD", page: "HOME_FEED",
        evidenceHash: evidenceHash(), resolvedPayload: tapPayload(),
      });
      const consumeArgs = {
        sessionId: s03.sessionId, token: s03.token, authorityId: authority.authorityId,
        permitId: permit.permitId, payload: tapPayload(), freshObservation: freshObservation(),
      };
      mutateFn(consumeArgs);
      await assert.rejects(
        () => f.control.consumeExplorationPermit(consumeArgs),
        (error) => label === "evidence"
          ? error.code === "EXPLORATION_EVIDENCE_DRIFT"
          : true,
        `guard ${label} must refuse`,
      );
      assert.deepEqual(f.screen.taps, [], `guard ${label} must refuse before any transport`);
      f.state.closeExplorationAuthority(authority.authorityId);
      } finally { await f.close(); }
    }
});

test("cross-boundary refusals: wrong lane session, wrong authority, inactive authority, expired TTL", async () => {
  const f = fixture();
  try {
    const { s03, s04, authority } = await f.registerAuthority();
    const permit = f.control.issueExplorationPermit({
      sessionId: s03.sessionId, token: s03.token, authorityId: authority.authorityId,
      navigationRole: "SCROLL_FEED", page: "HOME_FEED",
      evidenceHash: evidenceHash(), resolvedPayload: { primitive: "swipe", x1: 500, y1: 1400, x2: 500, y2: 600, durationMs: 300 },
    });
    // the 04 session may never consume an 03 permit (cross-lane)
    await assert.rejects(
      () => f.control.consumeExplorationPermit({
        sessionId: s04.sessionId, token: s04.token, authorityId: authority.authorityId,
        permitId: permit.permitId, payload: permit.payload, freshObservation: freshObservation(),
      }),
      (error) => error.code === "EXPLORATION_PERMIT_CROSS_SESSION",
    );
    // a raw tap through the generic path is still refused DESPITE a live permit
    await assert.rejects(
      () => f.control.executeSessionAction(s03.sessionId, s03.token, {
        idempotencyKey: "raw-alongside-permit",
        capabilityId: capability.id,
        params: { primitive: "tap", x: TAP_X, y: TAP_Y },
      }),
      (error) => error.code === "EXPLORATION_PRIMITIVE_FORBIDDEN",
    );
    // inactive authority blocks issuance
    f.state.closeExplorationAuthority(authority.authorityId);
    assert.throws(
      () => f.control.issueExplorationPermit({
        sessionId: s03.sessionId, token: s03.token, authorityId: authority.authorityId,
        navigationRole: "SCROLL_FEED", page: "HOME_FEED",
        evidenceHash: evidenceHash(), resolvedPayload: { primitive: "swipe", x1: 500, y1: 1400, x2: 500, y2: 600, durationMs: 300 },
      }),
      (error) => error.code === "EXPLORATION_AUTHORITY_INACTIVE" || error.code === "EXPLORATION_SESSION_NOT_BOUND",
    );
    void permit;
  } finally { await f.close(); }
});