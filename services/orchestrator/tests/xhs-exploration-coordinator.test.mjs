// xhs-exploration-coordinator.test.mjs — P3 exact [03,04] coordination gate.
//
// The coordinator runs against the REAL control plane (sessions, exploration
// authority, hash-chained lane journals, target ledger, budget ledger, lease
// oracle) while every plan V2 §6/P3 fault is injected at the dep seam:
// acquire failure (03 and 04), authority-registration failure, lane crash,
// lane hang, view failure, and release failure. Proves:
//   - no downgrade/work stealing: a failed barrier never starts lanes and
//     never registers a single-device authority; the peer stops at its next
//     safe checkpoint on the shared cancel channel;
//   - races cannot overspend or double-open: a concurrent stable-key claim
//     across both lanes credits novelty exactly once, and a reservation race
//     against the last budget slot yields at most one winner;
//   - every owned session/lease is independently closed (shielded release +
//     independent listLeases oracle) or the aggregate is BLOCKED;
//   - the verdict reads the CP authority view (server-side COMMITTED markers),
//     never a child-supplied summary;
//   - the recovery append is ABORTED only, never SUCCESS.
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

import {
  compileExplorationMission,
  canonicalJson,
} from "../scripts/lib/xhs-exploration-mission.mjs";
import {
  assertExplorationLanePair,
  createExplorationCoordinator,
} from "../scripts/lib/xhs-exploration-coordinator.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const registry = CapabilityRegistry.load(join(here, "../../control-plane/apps"));
const capability = registry.require("xiaowei.explorer.primitive");
const runtimeBase = join(here, "../../control-plane/control-plane/runtime");

const PLAN_HASH = "a".repeat(64);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function digestKey() {
  return createHash("sha256").update("v3-coordinator-fixture-key").digest();
}

function sha256Hex(value) {
  return createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

function compiledMission({ budgetOverrides = {} } = {}) {
  const { mission } = compileExplorationMission({
    goal: "安静的浏览一些咖啡与骑行笔记，只看不动手",
    queries: ["咖啡", "骑行"],
    budgets: budgetOverrides,
    digestKey: digestKey(),
    seed: "coordinator",
  });
  return mission;
}

// --- real-CP fixture ---------------------------------------------------------

function fixture({ laneTimeoutMs = 60_000, releaseTimeoutMs = 5_000 } = {}) {
  const root = mkdtempSync(join(runtimeBase, "explore-coordinator-"));
  const state = new StateStore({ dbPath: join(root, "control.db") });
  const evidence = new EvidenceStore({ runsRoot: join(root, "runs"), state, minFreeBytes: 0, minExternalEffectFreeBytes: 0 });
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
    adapters: new AdapterRegistry([createXiaoweiAdapter({
      transport: { async invoke() { return { code: 404, data: "no device in this fixture" }; } },
    })]),
    evidence,
    leaseHeartbeatMs: 5000,
    leaseTtlMs: 60000,
    schedulerIntervalMs: 5,
  });
  control.start();

  const track = {
    tokens: [], // every session token this run minted (privacy assertions)
    sessionAlias: new Map(), // sessionId -> alias (targeted fault injection)
    createSessionAliases: [],
    releaseCalls: [],
    authorityCalls: 0,
    viewCalls: 0,
    closeCalled: false,
  };
  const faults = {};
  let currentStartLane = null;

  const coordinator = createExplorationCoordinator({
    startLane: async (lane) => {
      if (!currentStartLane) {
        throw Object.assign(new Error("no startLane bound"), { code: "STARTLANE_UNBOUND" });
      }
      return currentStartLane(lane);
    },
    createSession: async ({ actorId, alias }) => {
      track.createSessionAliases.push(alias);
      if (faults.createSession?.[alias]) {
        throw Object.assign(new Error("dep down"), { code: faults.createSession[alias] });
      }
      const session = await control.createSession({
        actorId,
        placement: { alias },
        capabilityId: capability.id,
        canary: true,
      });
      track.tokens.push(session.token);
      track.sessionAlias.set(session.sessionId, alias);
      return { ...session, alias };
    },
    releaseSession: async (sessionId, token) => {
      track.releaseCalls.push(sessionId);
      if (faults.release || (faults.releaseFor === track.sessionAlias.get(sessionId))) {
        // fails BEFORE the CP call: the lease stays owned — exactly the
        // unrecovered-cleanup shape the independent oracle must catch
        throw Object.assign(new Error("release down"), { code: "RELEASE_DOWN" });
      }
      return control.releaseSession(sessionId, token);
    },
    listLeases: async () => state.listLeases(),
    registerExplorationAuthority: async (args) => {
      track.authorityCalls += 1;
      if (faults.authority) {
        throw Object.assign(new Error("authority down"), { code: faults.authority });
      }
      return control.registerExplorationAuthority(args);
    },
    getExplorationAuthorityView: async (args) => {
      track.viewCalls += 1;
      if (faults.view) {
        throw Object.assign(new Error("view down"), { code: faults.view });
      }
      return control.getExplorationAuthorityView(args);
    },
    appendLaneRecord: async ({ sessionId, token, alias, authorityId, type, payload }) => {
      const recordHash = control.appendExplorationJournal({
        sessionId, token, authorityId, alias, type, payload,
      });
      return { recordHash };
    },
    closeExplorationAuthority: async ({ sessionId, token, authorityId, reason }) => {
      track.closeCalled = true;
      return control.closeExplorationAuthority({ sessionId, token, authorityId, reason });
    },
    laneTimeoutMs,
    releaseTimeoutMs,
  });

  return {
    root, state, control, track, faults, coordinator,
    setStartLane(fn) { currentStartLane = fn; },
    mission: () => compiledMission(),
    authorityStatus(authorityId) {
      return state.db.prepare("SELECT status FROM exploration_authorities WHERE authority_id=?").get(authorityId)?.status;
    },
    journalTypes(authorityId, alias) {
      return state.readExplorationLaneJournal(authorityId, alias).map((r) => r.type);
    },
    targetRows(authorityId) {
      return state.db.prepare(
        "SELECT key_kind, key_value, novelty, state FROM exploration_targets WHERE authority_id=?",
      ).all(authorityId);
    },
    async close() {
      await control.stop();
      state.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

// --- shared lane fixtures ----------------------------------------------------

/**
 * Cooperative lane walk: checkpoints against the SHARED cancel channel, then
 * journal + COMMITTED through the lane's own session. `overrides` injects
 * per-alias behavior (crash/hang/race): an async override that throws or never
 * resolves replaces the walk; a sync override runs first and the walk
 * continues when it returns null.
 */
function laneRunner({ control, log, overrides = {} }) {
  return async ({ alias, session, authority, batchControl }) => {
    log.aliases.push(alias);
    if (overrides[alias]) {
      const injected = overrides[alias]({ alias, session, authority, batchControl, log });
      if (injected) return injected;
    }
    let navigations = 0;
    for (let i = 0; i < 5; i += 1) {
      if (batchControl.cancelled) break;
      navigations += 1;
      await sleep(10);
    }
    control.appendExplorationJournal({
      sessionId: session.sessionId, token: session.token, authorityId: authority.authorityId,
      alias, type: "LANE_RESULT", payload: { cancelled: batchControl.cancelled },
    });
    const committed = control.commitExplorationLane({
      sessionId: session.sessionId, token: session.token, authorityId: authority.authorityId,
    });
    const receipt = {
      laneId: `lane-${alias}`,
      alias,
      laneRole: alias === "03" ? "feed_lane" : "search_lane",
      outcome: { kind: "STOP", reason: batchControl.cancelled ? "PEER_STOPPED" : "BUDGET_EXHAUSTED" },
      navigations,
      restored: { restored: true, backs: 0, trail: [] },
    };
    return {
      receipt,
      receiptHash: sha256Hex(canonicalJson(receipt)),
      journalReceiptHash: committed.receiptHash,
    };
  };
}

function noLeak(aggregate, f) {
  const serialized = JSON.stringify(aggregate);
  for (const token of f.track.tokens) {
    assert.equal(serialized.includes(token), false, "aggregate must not carry a session token");
  }
  assert.equal(serialized.includes("sessionId"), false, "aggregate must not carry session ids");
  assert.equal(serialized.includes("leaseId"), false, "aggregate must not carry lease ids");
}

// --- tests -------------------------------------------------------------------

test("P3-A pair/seal/planHash guards reject before ANY session I/O", async () => {
  const f = fixture();
  try {
    // (a) tampered mission: digest mutation breaks the seal
    const mission = f.mission();
    const tampered = JSON.parse(JSON.stringify(mission));
    tampered.goalRef.digest = "0".repeat(64);
    await assert.rejects(
      () => f.coordinator.startExplorationRun({ mission: tampered, planHash: PLAN_HASH }),
      (error) => error.code === "EXPLORATION_MISSION_TAMPERED",
    );
    // (b) swapped/wrong lanes and parallelism fail closed (frozen policy)
    assert.throws(
      () => assertExplorationLanePair({
        placement: { parallelism: 2, automaticFallback: false, perDeviceConcurrency: 1, acquireOrder: ["03", "04"],
          lanes: [{ index: 0, alias: "04", role: "feed_lane" }, { index: 1, alias: "03", role: "search_lane" }] },
      }),
      (error) => error.code === "EXPLORATION_PAIR_INVALID",
    );
    assert.throws(
      () => assertExplorationLanePair({
        placement: { parallelism: 1, automaticFallback: false, perDeviceConcurrency: 1, acquireOrder: ["03"],
          lanes: [{ index: 0, alias: "03", role: "feed_lane" }] },
      }),
      (error) => error.code === "EXPLORATION_PAIR_INVALID",
      "a single-lane batch is a downgrade, never accepted",
    );
    // (c) missing planHash: rejected before the acquire barrier
    await assert.rejects(
      () => f.coordinator.startExplorationRun({ mission, planHash: "zz" }),
      (error) => error.code === "EXPLORATION_PLAN_HASH_REQUIRED",
    );
    // the positive case returns the frozen pair
    assert.deepEqual(assertExplorationLanePair(f.mission()), [
      { index: 0, alias: "03", role: "feed_lane" },
      { index: 1, alias: "04", role: "search_lane" },
    ]);
    // nothing above touched a device
    assert.equal(f.track.createSessionAliases.length, 0, "rejection must precede the acquire barrier");
    assert.equal(f.track.authorityCalls, 0);
  } finally { f.close(); }
});

test("R3 without the task-owned pre-acquire E-Corpus verifier creates zero sessions/leases", async () => {
  const f = fixture();
  try {
    const provider = {
      providerBundleDigest: "1".repeat(64),
      pythonHash: "2".repeat(64),
      modelHash: "3".repeat(64),
      scriptHash: "4".repeat(64),
      configHash: "5".repeat(64),
    };
    const ref = {
      schemaId: "xw.xhs.e-corpus-pass-ref.v1",
      artifactHash: "6".repeat(64),
      bindingHash: "7".repeat(64),
      gateEpoch: "8".repeat(64),
      expiresAtMs: 9_999_999_999_999,
    };
    const { mission } = compileExplorationMission({
      goal: "安静浏览视频笔记",
      queries: [],
      digestKey: digestKey(),
      vision: { mode: "canary1", provider },
      rolloutPhase: "R3",
      eCorpusPassRef: ref,
      eCorpusVerifier: () => ({
        ok: true,
        status: "PASS",
        artifactHash: ref.artifactHash,
        effectiveVisualPermitBudget: 1,
      }),
    });
    await assert.rejects(
      () => f.coordinator.startExplorationRun({
        mission,
        planHash: PLAN_HASH,
        releaseId: "xw-r3-test",
        sourceCommit: "9".repeat(40),
      }),
      (error) => error.code === "ECORPUS_INTERLOCK_NOT_CONFIGURED",
    );
    assert.deepEqual(f.track.createSessionAliases, []);
    assert.equal(f.track.authorityCalls, 0);
    assert.equal(f.state.listLeases().length, 0);
  } finally {
    await f.close();
  }
});

test("P3-B 03 acquire failure: nothing starts, no authority, zero device action", async () => {
  const f = fixture();
  try {
    f.faults.createSession = { "03": "DEP_DOWN" };
    const aggregate = await f.coordinator.startExplorationRun({ mission: f.mission(), planHash: PLAN_HASH });
    assert.equal(aggregate.ok, false);
    assert.equal(aggregate.status, "BLOCKED");
    assert.equal(aggregate.error.code, "DEP_DOWN");
    assert.equal(aggregate.authorityId, null, "no authority without the exact pair");
    assert.equal(aggregate.serverVerified, false);
    assert.deepEqual(aggregate.children, [], "no lane receipt may exist");
    assert.ok(aggregate.cleanup.leaseOracle.checked, "the oracle still enumerated the lease table");
    assert.equal(aggregate.cleanup.leaseOracle.ok, true);
    noLeak(aggregate, f);
  } finally { await f.close(); }
});

test("P3-C 04 acquire failure: 03 released before any device action, no downgrade", async () => {
  const f = fixture();
  try {
    f.faults.createSession = { "04": "DEP_DOWN" };
    const aggregate = await f.coordinator.startExplorationRun({ mission: f.mission(), planHash: PLAN_HASH });
    assert.equal(aggregate.status, "BLOCKED");
    assert.equal(aggregate.authorityId, null, "never a single-device authority");
    assert.deepEqual(f.track.createSessionAliases, ["03", "04"], "fixed barrier order 03 then 04");
    assert.deepEqual(
      aggregate.cleanup.releases.map((r) => [r.alias, r.ok]),
      [["03", true]],
      "the already-acquired primary is released, never stolen",
    );
    assert.equal(aggregate.cleanup.leaseOracle.ok, true, "no owned lease remains");
    noLeak(aggregate, f);
  } finally { await f.close(); }
});

test("P3-D authority registration failure: both sessions released, devices free", async () => {
  const f = fixture();
  try {
    f.faults.authority = "AUTHORITY_DOWN";
    const aggregate = await f.coordinator.startExplorationRun({ mission: f.mission(), planHash: PLAN_HASH });
    assert.equal(aggregate.status, "BLOCKED");
    assert.equal(aggregate.error.code, "AUTHORITY_DOWN");
    assert.equal(aggregate.authorityId, null);
    assert.deepEqual(
      aggregate.cleanup.releases.map((r) => [r.alias, r.ok]).sort(),
      [["03", true], ["04", true]],
    );
    assert.equal(aggregate.cleanup.leaseOracle.ok, true);
    // the devices are genuinely free again: a fresh session acquires cleanly
    const retry = await f.control.createSession({ actorId: "probe", placement: { alias: "03" }, capabilityId: capability.id, canary: true });
    assert.ok(retry.sessionId);
    await f.control.releaseSession(retry.sessionId, retry.token);
    noLeak(aggregate, f);
  } finally { await f.close(); }
});

test("P3-E success: COMMITTED lanes, oracle zero, close ok, no double-credit", async () => {
  const f = fixture();
  try {
    const log = { aliases: [], claims: [] };
    const stableKey = `note_id:${"d".repeat(24)}`;
    // claim race: both lanes claim the SAME stable id inside the batch — the
    // CP must credit novelty exactly once (V3-I05 double-open probe)
    const claimOverride = ({ session, authority }) => {
      const result = f.control.claimExplorationTarget({
        sessionId: session.sessionId, token: session.token, authorityId: authority.authorityId,
        keyKind: "stable", keyValue: stableKey, alias: session.alias,
      });
      log.claims.push(result);
      return null;
    };
    f.setStartLane(laneRunner({
      control: f.control, log,
      overrides: { "03": claimOverride, "04": claimOverride },
    }));
    const aggregate = await f.coordinator.startExplorationRun({ mission: f.mission(), planHash: PLAN_HASH });

    assert.equal(aggregate.ok, true, JSON.stringify(aggregate.error));
    assert.equal(aggregate.status, "SUCCEEDED");
    assert.equal(aggregate.serverVerified, true);
    assert.ok(aggregate.authorityId, "authority id present");
    assert.deepEqual(aggregate.children.map((c) => [c.alias, c.laneRole, c.status, c.committed]), [
      ["03", "feed_lane", "COMPLETED", true],
      ["04", "search_lane", "COMPLETED", true],
    ], "fixed roles, fixed order, both server-committed");
    for (const child of aggregate.children) {
      assert.equal(child.outcome.kind, "STOP");
      assert.equal(child.receipt.outcome.reason, "BUDGET_EXHAUSTED");
      assert.equal(child.receiptHash, sha256Hex(canonicalJson(child.receipt)));
    }
    assert.equal(aggregate.view.allSettled, true);
    assert.equal(aggregate.cleanup.authorityClosed.ok, true);
    assert.deepEqual(
      aggregate.cleanup.releases.map((r) => [r.alias, r.ok]).sort(),
      [["03", true], ["04", true]],
    );
    assert.equal(aggregate.cleanup.leaseOracle.ok, true, "independent lease oracle: zero active owned leases");
    assert.deepEqual(aggregate.recovery.attempts, [], "no recovery on a clean batch");
    // exactly one novelty credit for the raced claim
    assert.equal(log.claims.filter((c) => c.novel === true).length, 1);
    const rows = f.targetRows(aggregate.authorityId);
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].key_kind === "stable", rows[0].novelty], [true, 1]);
    assert.deepEqual(f.journalTypes(aggregate.authorityId, "03").slice(-1), ["COMMITTED"]);
    assert.deepEqual(f.journalTypes(aggregate.authorityId, "04").slice(-1), ["COMMITTED"]);
    noLeak(aggregate, f);
  } finally { await f.close(); }
});

test("P3-F lane crash: peer stops at its checkpoint, ABORTED appended, verdict BLOCKED", async () => {
  const f = fixture();
  try {
    const log = { aliases: [] };
    const crash = async ({ alias }) => {
      await sleep(30); // the walk HAS started; then it dies mid-I/O
      throw Object.assign(new Error(`lane ${alias} crashed mid-walk`), { code: "L04_CRASH" });
    };
    f.setStartLane(laneRunner({ control: f.control, log, overrides: { "03": () => null, "04": crash } }));
    const aggregate = await f.coordinator.startExplorationRun({ mission: f.mission(), planHash: PLAN_HASH });

    assert.equal(aggregate.ok, false);
    assert.equal(aggregate.status, "BLOCKED");
    const child03 = aggregate.children.find((c) => c.alias === "03");
    const child04 = aggregate.children.find((c) => c.alias === "04");
    assert.equal(child04.status, "FAILED");
    assert.equal(child04.error.code, "L04_CRASH");
    assert.equal(child04.committed, false);
    assert.equal(child03.status, "COMPLETED", "the peer still completes its own safe stop");
    assert.equal(child03.outcome.reason, "PEER_STOPPED", "the peer honored the shared cancel channel");
    assert.ok(child03.receipt.navigations <= 3, `no work stealing: peer ran ${child03.receipt.navigations} steps`);
    assert.equal(aggregate.view.allSettled, false);
    // recovery: exactly ONE ABORTED append for the crashed lane, never SUCCESS
    const aborts = aggregate.recovery.attempts.filter((a) => a.appended && a.alias === "04");
    assert.equal(aborts.length, 1);
    const types04 = f.journalTypes(aggregate.authorityId, "04");
    assert.ok(types04.includes("ABORTED"), "crashed lane journal carries ABORTED");
    assert.equal(types04.includes("COMMITTED"), false);
    assert.ok(f.journalTypes(aggregate.authorityId, "03").includes("COMMITTED"));
    // close was NOT attempted: a BLOCKED batch never seals the authority
    assert.equal(f.track.closeCalled, false);
    assert.equal(f.authorityStatus(aggregate.authorityId), "active");
    // cleanups still ran: every owned lease closed
    assert.deepEqual(
      aggregate.cleanup.releases.map((r) => [r.alias, r.ok]).sort(),
      [["03", true], ["04", true]],
    );
    assert.equal(aggregate.cleanup.leaseOracle.ok, true);
    noLeak(aggregate, f);
  } finally { await f.close(); }
});

test("P3-G lane hang: wall-clock guard fires, lane marked HANG, ABORTED appended", async () => {
  const f = fixture({ laneTimeoutMs: 80 });
  try {
    const log = { aliases: [] };
    let abortSeen = false;
    const never = ({ batchControl }) => new Promise((resolve) => {
      batchControl.signal.addEventListener("abort", () => {
        abortSeen = true;
        resolve(undefined);
      }, { once: true });
    });
    f.setStartLane(laneRunner({ control: f.control, log, overrides: { "04": never } }));
    const aggregate = await f.coordinator.startExplorationRun({ mission: f.mission(), planHash: PLAN_HASH });

    assert.equal(aggregate.ok, false);
    assert.equal(aggregate.status, "BLOCKED");
    const child04 = aggregate.children.find((c) => c.alias === "04");
    assert.equal(child04.status, "HANG");
    assert.equal(child04.error.code, "EXPLORATION_LANE_HANG");
    assert.equal(abortSeen, true, "hang cancellation reaches the underlying lane/provider signal");
    assert.equal(child04.committed, false);
    const types04 = f.journalTypes(aggregate.authorityId, "04");
    assert.ok(types04.includes("ABORTED"), "hung lane journal carries ABORTED via its own session");
    assert.equal(types04.includes("COMMITTED"), false);
    assert.equal(f.authorityStatus(aggregate.authorityId), "active");
    assert.equal(aggregate.cleanup.leaseOracle.ok, true);
    noLeak(aggregate, f);
  } finally { await f.close(); }
});

test("P3-H release failure: aggregate BLOCKED and lease oracle catches the active lease", async () => {
  const f = fixture();
  try {
    const log = { aliases: [] };
    f.setStartLane(laneRunner({ control: f.control, log }));
    f.faults.releaseFor = "04";
    const aggregate = await f.coordinator.startExplorationRun({ mission: f.mission(), planHash: PLAN_HASH });

    assert.equal(aggregate.status, "BLOCKED");
    const child04 = aggregate.children.find((c) => c.alias === "04");
    assert.equal(child04.status, "COMPLETED", "the lanes themselves were fine");
    assert.equal(aggregate.cleanup.authorityClosed.ok, true, "both lanes committed, so close proceeds");
    assert.ok(
      aggregate.cleanup.releases.some((r) => r.ok === false && r.error === "RELEASE_DOWN"),
      "the failure is recorded, never swallowed",
    );
    assert.equal(aggregate.cleanup.leaseOracle.ok, false, "the oracle still sees the active owned lease");
    assert.equal(aggregate.cleanup.leaseOracle.activeLeaseCount, 1);
  } finally { await f.close(); }
});

test("P3-I view failure: verdict never trusts the child, serverVerified false, BLOCKED", async () => {
  const f = fixture();
  try {
    const log = { aliases: [] };
    f.setStartLane(laneRunner({ control: f.control, log }));
    f.faults.view = "VIEW_DOWN";
    const aggregate = await f.coordinator.startExplorationRun({ mission: f.mission(), planHash: PLAN_HASH });

    assert.equal(aggregate.ok, false);
    assert.equal(aggregate.status, "BLOCKED");
    assert.equal(aggregate.serverVerified, false);
    for (const child of aggregate.children) {
      assert.equal(child.committed, false, "without the server view nothing may be reported committed");
    }
    assert.equal(f.track.viewCalls, 2, "initial + post-recovery reads both attempted");
    noLeak(aggregate, f);
  } finally { await f.close(); }
});

test("P3-J budget race: exactly one winner for the last global slot (V3-I06)", async () => {
  const f = fixture();
  try {
    const log = { aliases: [], winners: [], denials: [] };
    const reserve = ({ session, authority }) => {
      try {
        const reservation = f.control.reserveExplorationBudget({
          sessionId: session.sessionId, token: session.token, authorityId: authority.authorityId,
          kind: "novelOpens", amount: 1, detail: { alias: session.alias },
        });
        log.winners.push(reservation.reservationId);
      } catch (error) {
        log.denials.push(String(error.code));
      }
      return null; // the walk continues either way; the ledger decides
    };
    f.setStartLane(laneRunner({ control: f.control, log, overrides: {
      "03": reserve,
      "04": reserve,
    } }));
    // novelOpens cap sealed at 1: the pair races for a single global slot
    const mission = compiledMission({ budgetOverrides: { novelOpens: 1 } });
    const aggregate = await f.coordinator.startExplorationRun({ mission, planHash: PLAN_HASH });

    assert.equal(aggregate.status, "SUCCEEDED", JSON.stringify(aggregate.error));
    assert.equal(log.winners.length, 1, "exactly one lane holds the last slot");
    assert.deepEqual(log.denials, ["EXPLORATION_BUDGET_EXCEEDED"], "the loser is refused, never clamped");
    const reserved = f.state.db.prepare(
      "SELECT COUNT(*) AS n FROM exploration_reservations WHERE authority_id=? AND kind='novelOpens'",
    ).get(aggregate.authorityId).n;
    assert.equal(reserved, 1);
    noLeak(aggregate, f);
  } finally { await f.close(); }
});
