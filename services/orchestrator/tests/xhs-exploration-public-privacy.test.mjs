// xhs-exploration-public-privacy.test.mjs — V3-I09 public privacy requirement.
//
// Everything PUBLIC (sealed mission, canonical plan, authority view, journal
// payloads, receipts) carries only opaque keyed digests; the raw goal/query
// text lives ONLY in the private execution binder payload and never crosses
// any receipt/plan/authority surface.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import { compileExplorationMission } from "../scripts/lib/xhs-exploration-mission.mjs";
import { planExplorationGoalRoutine } from "../scripts/lib/xhs-routine-plan.mjs";

import { CapabilityRegistry } from "../../control-plane/control-plane/lib/capability-registry.mjs";
import { AdapterRegistry, ControlPlane } from "../../control-plane/control-plane/lib/control-plane.mjs";
import { EvidenceStore } from "../../control-plane/control-plane/lib/evidence-store.mjs";
import { StateStore } from "../../control-plane/control-plane/lib/state-store.mjs";
import { createXiaoweiAdapter } from "../../control-plane/apps/xiaowei/adapter.mjs";

const GOAL = "探索城市咖啡店的拉花风格";
const QUERY = "拉花";
const KEY = Buffer.from(createHash("sha256").update("privacy-offline-key").digest("hex"), "utf8").subarray(0, 32);

const capability = CapabilityRegistry.load(fileURLToPath(new URL("../../control-plane/apps", import.meta.url))).require("xiaowei.explorer.primitive");
const tempBase = fileURLToPath(new URL("../../control-plane/control-plane/runtime", import.meta.url));

const mission = () => compileExplorationMission({ goal: GOAL, queries: [QUERY], digestKey: KEY }).mission;

function fixture() {
  const noop = { async invoke() { return { code: 10000, data: "" }; } };
  const root = mkdtempSync(join(tempBase, "exploration-privacy-"));
  const state = new StateStore({ dbPath: join(root, "control.db") });
  const evidence = new EvidenceStore({
    runsRoot: join(root, "runs"), state, minFreeBytes: 0, minExternalEffectFreeBytes: 0,
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
    capabilities: CapabilityRegistry.load(fileURLToPath(new URL("../../control-plane/apps", import.meta.url))),
    adapters: new AdapterRegistry([createXiaoweiAdapter({ transport: noop })]),
    evidence,
    leaseHeartbeatMs: 5000,
    leaseTtlMs: 60000,
    schedulerIntervalMs: 5,
  });
  control.start();
  return {
    root, state, control,
    async pair() {
      const s03 = await control.createSession({ actorId: "explorer-privacy-a", placement: { alias: "03" }, capabilityId: capability.id, canary: true });
      const s04 = await control.createSession({ actorId: "explorer-privacy-b", placement: { alias: "04" }, capabilityId: capability.id, canary: true });
      const authority = control.registerExplorationAuthority({
        sessions: [
          { alias: "03", sessionId: s03.sessionId, token: s03.token },
          { alias: "04", sessionId: s04.sessionId, token: s04.token },
        ],
        executionRunId: "exec-v3-privacy",
        routineRunId: "routine-v3-privacy",
        mission: mission(),
        planHash: "p".repeat(64),
        releaseId: "xw-v3-offline",
        accountFingerprint: "acct-priv",
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

test("sealed mission and canonical plan carry ZERO raw goal/query text", () => {
  const { mission, privatePayload } = compileExplorationMission({ goal: GOAL, queries: [QUERY], digestKey: KEY });
  const sealedText = JSON.stringify(mission);
  assert.ok(!sealedText.includes(GOAL));
  assert.ok(!sealedText.includes(QUERY));
  const plan = planExplorationGoalRoutine({ mission });
  const planText = JSON.stringify(plan);
  assert.ok(!planText.includes(GOAL));
  assert.ok(!planText.includes(QUERY));
  void privatePayload;
});

test("authority view + budgets + lanes expose no goal text", async () => {
  const f = fixture();
  try {
    const { authority } = await f.pair();
    const viewText = JSON.stringify(authority);
    assert.ok(!viewText.includes(GOAL));
    assert.ok(!viewText.includes(QUERY));
    assert.ok(authority.missionHash, "authority binds the mission by hash only");
  } finally { await f.close(); }
});

test("lane journal payloads hold structural events only — no goal/query text", async () => {
  const f = fixture();
  try {
    const { s03, authority } = await f.pair();
    f.control.appendExplorationJournal({
      sessionId: s03.sessionId, token: s03.token, authorityId: authority.authorityId,
      alias: "03", type: "SCREEN_PARSE", payload: { page: "HOME_FEED", cards: 5, novelTargets: 1 },
    });
    const journalText = JSON.stringify(f.state.readExplorationLaneJournal(authority.authorityId, "03"));
    assert.ok(!journalText.includes(GOAL));
    assert.ok(!journalText.includes(QUERY));
const lane = f.state.readExplorationLaneJournal(authority.authorityId, "03");
    assert.equal(lane.length, 1);
    assert.equal(lane[0].type, "SCREEN_PARSE");
  } finally { await f.close(); }
});

test("permit rows expose navigation roles/pages — never goal or query text", async () => {
  const f = fixture();
  try {
    const { s03, authority } = await f.pair();
    f.control.issueExplorationPermit({
      sessionId: s03.sessionId, token: s03.token, authorityId: authority.authorityId,
      navigationRole: "OPEN_SEARCH", page: "HOME_FEED",
      evidenceHash: createHash("sha256").update("e").digest("hex"),
      resolvedPayload: { primitive: "tap", x: 100, y: 100 },
    });
    const rows = f.state.db.prepare("SELECT navigation_role, page, payload_json FROM exploration_permits WHERE authority_id=?").all(authority.authorityId);
    const permitsText = JSON.stringify(rows);
    assert.ok(!permitsText.includes(GOAL));
    assert.ok(!permitsText.includes(QUERY));
    assert.ok(permitsText.includes("OPEN_SEARCH"));
  } finally { await f.close(); }
});

test("compileExplorationMission private payload keeps raw text ONLY in the private form", () => {
  const { mission, privatePayload } = compileExplorationMission({ goal: GOAL, queries: [QUERY], digestKey: KEY });
  assert.equal(privatePayload.goal, GOAL);
  assert.deepEqual([...privatePayload.queries], [QUERY]);
  const sealedText = JSON.stringify(mission);
  assert.ok(!sealedText.includes(GOAL));
  assert.ok(!sealedText.includes(QUERY));
});