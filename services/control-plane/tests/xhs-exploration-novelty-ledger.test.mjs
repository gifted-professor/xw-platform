// xhs-exploration-novelty-ledger.test.mjs — V3-I05 stable-ID novelty
// reconciliation.
//
// Both lanes claim identity against ONE ledger: the earliest durable claim is
// canonical; a later alias proving the same stable id becomes duplicate with
// ZERO novelty; stable and fallback keys reconcile in the same transaction.
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

const MISSION_HASH = createHash("sha256").update("fixture-novelty-mission").digest("hex");
const mission = () => ({
  schemaId: "xw.xhs.exploration-mission.v1",
  schemaVersion: 1,
  templateId: "xhs.explore.goal.v1",
  profile: "xhs_goal_explore_v1",
  externalEffects: 0,
  missionHash: MISSION_HASH,
  placement: { parallel: 2, lanes: [{ index: 0, alias: "03", role: "feed_lane" }, { index: 1, alias: "04", role: "search_lane" }] },
  budgets: {
    missionDurationSec: 600, reservedPrimitives: 80, novelOpens: 8, sealedQueries: 2,
    resultScreensPerQuery: 2, commentScreens: 6, consecutiveNavigationFailures: 2,
    noNovelScreens: 2, visionAnalysisAttempts: 6, visionMaxIssuedPermits: 1,
    visionMaxPhysicalTaps: 1, vision: 0,
  },
  queries: [],
});

function fixture() {
  const noop = { async invoke() { return { code: 10000, data: "" }; } };
  const root = mkdtempSync(join(tempBase, "exploration-novelty-"));
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
      const s03 = await control.createSession({ actorId: `explorer-operator-n${counter}a`, placement: { alias: "03" }, capabilityId: capability.id, canary: true });
      const s04 = await control.createSession({ actorId: `explorer-operator-n${counter}b`, placement: { alias: "04" }, capabilityId: capability.id, canary: true });
      const authority = control.registerExplorationAuthority({
        sessions: [
          { alias: "03", sessionId: s03.sessionId, token: s03.token },
          { alias: "04", sessionId: s04.sessionId, token: s04.token },
        ],
        executionRunId: "exec-v3-novelty",
        routineRunId: `routine-v3-novelty-${counter}`,
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

test("earliest durable claim owns the stable id; later aliases of the same id get ZERO novelty", async () => {
  const f = fixture();
  try {
    const { s03, s04, authority } = await f.pair();
    const stableKey = `note_id_${"x".repeat(24)}`;
    // lane 03 proves the stable id first
    const first = f.control.claimExplorationTarget({
      sessionId: s03.sessionId, token: s03.token, authorityId: authority.authorityId,
      keyKind: "stable", keyValue: stableKey,
    });
    assert.equal(first.novel, true);
    assert.equal(first.state, "confirmed");
    // lane 04 sees the same note (same stable id) → duplicate, no credit
    const second = f.control.claimExplorationTarget({
      sessionId: s04.sessionId, token: s04.token, authorityId: authority.authorityId,
      keyKind: "stable", keyValue: stableKey,
    });
    assert.equal(second.targetId, first.targetId, "same stable id must resolve to the same canonical target");
    assert.equal(second.novel, false);
    assert.equal(second.state, "confirmed");
    // the row attributes only the earliest claim
    const rows = f.state.db.prepare("SELECT COUNT(*) AS n FROM exploration_targets WHERE authority_id=?").all(authority.authorityId);
    assert.equal(rows[0].n, 1);
  } finally { await f.close(); }
});

test("fallback → stable reconciliation: pending fallback rekeys; the race loser duplicates", async () => {
  const f = fixture();
  try {
    const { s03, s04, authority } = await f.pair();
    const fallbackKey = "feed:card:12";
    const stableKey = "note_7788";
    // both lanes see the same card without a stable id (screen order differs)
    const fb03 = f.control.claimExplorationTarget({
      sessionId: s03.sessionId, token: s03.token, authorityId: authority.authorityId,
      keyKind: "fallback", keyValue: fallbackKey,
    });
    const fb04 = f.control.claimExplorationTarget({
      sessionId: s04.sessionId, token: s04.token, authorityId: authority.authorityId,
      keyKind: "fallback", keyValue: fallbackKey,
    });
    assert.equal(fb03.targetId, fb04.targetId, "a repeated fallback key dedupes to the pending row");
    assert.equal(fb03.state, "pending");
    assert.equal(fb03.novel, false);

    // 04 opens first and proves the stable id
    const opened = f.control.confirmExplorationTarget({
      sessionId: s04.sessionId, token: s04.token, authorityId: authority.authorityId,
      targetId: fb04.targetId, stableKeyValue: stableKey,
    });
    assert.equal(opened.novel, true, "the opening lane takes the one novelty credit");
    assert.equal(opened.state, "confirmed");

    // 03 now proves the SAME stable id through the other pending row
    const late = f.control.confirmExplorationTarget({
      sessionId: s03.sessionId, token: s03.token, authorityId: authority.authorityId,
      targetId: fb03.targetId, stableKeyValue: stableKey,
    });
    assert.equal(late.state, "duplicate");
    assert.equal(late.novel, false);
          assert.equal(late.targetId, opened.targetId, "loser maps onto the canonical stable row");
  } finally { await f.close(); }
});

test("mark-unknown clears novelty credit and never re-credits the same fallback", async () => {
  const f = fixture();
  try {
    const { s03, authority } = await f.pair();
    const fb = f.control.claimExplorationTarget({
      sessionId: s03.sessionId, token: s03.token, authorityId: authority.authorityId,
      keyKind: "fallback", keyValue: "feed:card:9",
    });
    const unknowned = f.control.markExplorationTargetUnknown({
      sessionId: s03.sessionId, token: s03.token, authorityId: authority.authorityId,
      targetId: fb.targetId,
    });
    assert.equal(unknowned.state, "unknown");
    assert.equal(unknowned.novel, false);
    // confirm-after-unknown never regains novelty (row stays unknown)
    const revived = f.control.confirmExplorationTarget({
      sessionId: s03.sessionId, token: s03.token, authorityId: authority.authorityId,
      targetId: fb.targetId, stableKeyValue: "note_99",
    });
    assert.equal(revived.state, "unknown");
    assert.equal(revived.novel, false);
  } finally { await f.close(); }
});

test("partition guard: claims under a foreign missionHash are refused", async () => {
  const f = fixture();
  try {
    const { authority } = await f.pair();
    assert.throws(
      () => f.state.claimExplorationTarget({
        authorityId: authority.authorityId,
        missionHash: createHash("sha256").update("foreign").digest("hex"),
        keyKind: "stable", keyValue: "note_foreign",
        alias: "03",
      }),
      (error) => error.code === "EXPLORATION_PARTITION_MISMATCH",
    );
    assert.throws(
      () => f.state.confirmExplorationTarget({
        authorityId: authority.authorityId,
        missionHash: createHash("sha256").update("foreign").digest("hex"),
        targetId: "fb:x:1", stableKeyValue: "note_1",
      }),
      (error) => error.code === "EXPLORATION_PARTITION_MISMATCH",
    );
  } finally { await f.close(); }
});