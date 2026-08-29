/**
 * xhs-exploration-coordinator.mjs — V3 exact [03,04] exploration coordinator
 * (plan V2 §5.4 + §6/P3, invariants V3-I05/I06/I08).
 *
 * One batch = the §8.3 discipline plus the V3-exploration layer:
 *
 *   1. fixed lane pair [03=feed_lane, 04=search_lane] — validated against BOTH
 *      the sealed mission bytes and the frozen policy; a downgrade or alias
 *      swap is a fail-closed rejection (never work stealing);
 *   2. the acquire barrier is 03 -> 04: a 04 failure releases 03 BEFORE any
 *      device action and never downgrades to a single-device group;
 *   3. ONE CP exploration authority registered only AFTER both sessions are
 *      acquired (the CP rejects anything but the exact bound pair);
 *   4. one shared cooperative-cancellation channel: a lane failure/hang flips
 *      the flag and the peer stops at its next safe checkpoint;
 *   5. per-lane wall-clock hang guard (Promise.race): the lane machine owns
 *      the persisted mission deadline, the coordinator owns the hang guard; a
 *      hung lane is marked HANG, never awaited, and its eventual terminal
 *      state is recorded post-aggregate on the child object;
 *   6. Promise.allSettled: a crash in either lane never loses the peer's
 *      receipt, and complete child receipts carry server-verifiable hashes;
 *   7. cleanup owned by the PARENT (children never release their own session):
 *      ABORTED journals for failed/hung uncommitted lanes, shielded releases,
 *      then an independent `listLeases` oracle — every owned lease closed or
 *      the aggregate is BLOCKED;
 *   8. the parent verdict reads the CP authority view (committed lane journals
 *      from the server), never a child-supplied summary;
 *   9. the recovery append is ABORTED only — after a fresh server view proves
 *      the lane is uncommitted. It can never mint SUCCESS.
 *
 * All device behavior is injected (`startLane`); this module performs no I/O
 * and never touches a primitive. The public aggregate receipt carries aliases,
 * run ids, outcome kinds, and hashes — never tokens, session ids, or payloads.
 */
import { randomUUID, createHash } from "node:crypto";

import {
  canonicalJson,
  EXPLORATION_LANES,
  validateSealedMission,
} from "./xhs-exploration-mission.mjs";
import { createRoutineExecutionIdentity } from "./xhs-routine-plan.mjs";

/** The single sealed lane pair (frozen V3 policy) — re-exported for gates. */
export const EXPLORATION_LANE_PAIR = EXPLORATION_LANES;

/** Lane terminal outcome kinds that count as a completed child. */
const LANE_COMPLETE = Object.freeze(new Set(["STOP", "DONE"]));

function sha256Hex(value) {
  return createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

function coordinatorError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, details });
}

/**
 * Fail-closed lane-pair assertion against the FROZEN policy (not just the
 * mission bytes): exactly two lanes ordered [03=feed_lane, 04=search_lane],
 * parallelism 2, no automatic fallback, one primitive in flight per device.
 */
export function assertExplorationLanePair(mission) {
  const placement = mission?.placement;
  if (!placement || Array.isArray(placement) || typeof placement !== "object") {
    throw coordinatorError("EXPLORATION_PAIR_INVALID", "mission placement is required");
  }
  if (placement.parallelism !== 2
    || placement.automaticFallback !== false
    || placement.perDeviceConcurrency !== 1) {
    throw coordinatorError("EXPLORATION_PAIR_INVALID",
      "goal exploration requires parallelism=2, automaticFallback=false, perDeviceConcurrency=1");
  }
  if (canonicalJson(placement.lanes ?? []) !== canonicalJson(EXPLORATION_LANES)) {
    throw coordinatorError("EXPLORATION_PAIR_INVALID",
      `lanes must be exactly [03=feed_lane,04=search_lane]; got ${JSON.stringify(placement.lanes ?? null)}`);
  }
  if (JSON.stringify(placement.acquireOrder ?? []) !== JSON.stringify(["03", "04"])) {
    throw coordinatorError("EXPLORATION_PAIR_INVALID", "acquire order is fixed 03 then 04");
  }
  return EXPLORATION_LANES;
}

/** Per-lane rr ids: 32 lowercase hex derived from the batch token + alias, so
 * both children provably share one execution identity painting (rr_<32hex>). */
function perLaneRoutineRunId(batchToken, alias) {
  return `rr_${sha256Hex(`${batchToken}:${alias}:lane`).slice(0, 32)}`;
}

/**
 * Build the coordinator. Every interaction with the CP/leases/lanes is
 * injected. Dep contracts (adapted 1:1 by callers from the production CP):
 *   createSession({actorId, alias}) -> {sessionId, token, ...}
 *   releaseSession(sessionId, token) -> {released}
 *   listLeases() -> [{sessionId, status, ...}]
 *   registerExplorationAuthority({sessions, executionRunId, routineRunId,
 *     mission, planHash, releaseId, accountFingerprint}) -> {authorityId, ...}
 *   getExplorationAuthorityView({sessionId, token, authorityId})
 *     -> {authority, lanes, allSettled}
 *   startLane({child, session, alias, authority, mission, batchControl,
 *     executionRunId, routineRunId}) -> {receipt, receiptHash}
 *   appendLaneRecord({sessionId, token, alias, authorityId, type, payload})
 *     -> {recordHash}  (ABORTED recovery append, CP hash-chained)
 *   closeExplorationAuthority({sessionId, token, authorityId, reason})
 */
export function createExplorationCoordinator({
  createSession,
  releaseSession,
  listLeases,
  registerExplorationAuthority,
  getExplorationAuthorityView,
  startLane,
  appendLaneRecord = null,
  closeExplorationAuthority = null,
  laneTimeoutMs = 10 * 60 * 1000,
  releaseTimeoutMs = 10_000,
  randomUUIDFn = randomUUID,
  now = () => Date.now(),
} = {}) {
  for (const [name, fn] of Object.entries({
    createSession, releaseSession, listLeases, registerExplorationAuthority,
    getExplorationAuthorityView, startLane,
  })) {
    if (typeof fn !== "function") {
      throw new TypeError(`createExplorationCoordinator requires ${name}`);
    }
  }
  if (appendLaneRecord !== null && typeof appendLaneRecord !== "function") {
    throw new TypeError("createExplorationCoordinator requires appendLaneRecord to be a function or null");
  }
  if (closeExplorationAuthority !== null && typeof closeExplorationAuthority !== "function") {
    throw new TypeError("createExplorationCoordinator requires closeExplorationAuthority to be a function or null");
  }

  /** One promise + a wall-clock budget; a timeout rejects with `code`. */
  async function withBudget(fn, ms, code) {
    let timer = null;
    try {
      return await Promise.race([
        fn(),
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(
            Object.assign(new Error(`${code} after ${ms}ms`), { code }),
          ), ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Parent-owned shielded release; failures are recorded, never thrown. */
  async function releaseShielded(session, cleanup) {
    let record;
    try {
      const released = await withBudget(
        () => releaseSession(session.sessionId, session.token),
        releaseTimeoutMs,
        "EXPLORATION_RELEASE_TIMEOUT",
      );
      record = { alias: session.alias, ok: released?.released !== false };
    } catch (error) {
      record = {
        alias: session.alias,
        ok: false,
        error: String(error?.code || error?.message || error),
      };
    }
    cleanup.releases.push(record);
    return record;
  }

  /** Independent server oracle: no lease row may remain for an owned lease. */
  async function leaseOracle(ownedLeaseIds, cleanup) {
    let oracle;
    try {
      const leases = await listLeases();
      if (!Array.isArray(leases)) throw new TypeError("lease list is not an array");
      const activeForOwned = leases
        .filter((l) => ownedLeaseIds.has(String(l?.leaseId ?? "")))
        .map((l) => ({ status: String(l?.kind ?? "unknown") }));
      oracle = { ok: activeForOwned.length === 0, checked: true, activeLeaseCount: activeForOwned.length };
    } catch (error) {
      oracle = {
        ok: false,
        checked: false,
        activeLeaseCount: null,
        error: String(error?.code || error?.message || error),
      };
    }
    cleanup.leaseOracle = oracle;
    return oracle;
  }

  /** Server verdict read (parent NEVER trusts a child-supplied summary). */
  async function authorityView(sessionRef, authorityId) {
    try {
      const view = await withBudget(
        () => getExplorationAuthorityView({
          sessionId: sessionRef.sessionId,
          token: sessionRef.token,
          authorityId,
        }),
        releaseTimeoutMs,
        "EXPLORATION_VIEW_TIMEOUT",
      );
      return { view, verified: true, error: null };
    } catch (error) {
      return { view: null, verified: false, error: String(error?.code || error?.message || error) };
    }
  }

  function publicView(view) {
    if (!view) return null;
    return {
      allSettled: view.allSettled === true,
      lanes: Object.fromEntries(Object.entries(view.lanes ?? {}).map(([alias, lane]) => [
        alias,
        { laneRole: lane.laneRole, journalLength: lane.journalLength, committed: lane.committed === true },
      ])),
    };
  }

  /**
   * Own a lane promise so it can NEVER produce an unhandled rejection, and
   * observe its eventual terminal state even after the parent stopped
   * awaiting it (hang case): the child object is mutated in place.
   */
  function track(child, promise) {
    child._guard = promise.then(
      (value) => { child._settled = { ok: true, value }; return value; },
      (error) => { child._settled = { ok: false, error }; throw error; },
    );
    child._guard.catch(() => { /* observed; terminal state lives in _settled */ });
  }

  /** Race a tracked lane against the wall-clock hang guard. */
  async function raceWithHangGuard(child, batchControl) {
    try {
      const value = await Promise.race([
        child._guard,
        new Promise((_resolve, reject) => {
          const timer = setTimeout(() => reject(
            Object.assign(new Error(`lane hang guard ${laneTimeoutMs}ms exceeded`), {
              code: "EXPLORATION_LANE_HANG",
            }),
          ), laneTimeoutMs);
          if (typeof timer.unref === "function") timer.unref();
          child._timer = timer;
        }),
      ]);
      clearTimeout(child._timer);
      child.outcome = value?.receipt?.outcome ?? { kind: "FAILED", reason: "LANE_RECEIPT_MISSING" };
      child.receipt = value?.receipt ?? null;
      child.receiptHash = value?.receiptHash ?? null;
      if (LANE_COMPLETE.has(child.outcome.kind)) {
        child.status = "COMPLETED";
      } else {
        child.status = "FAILED";
        child.error = {
          code: "EXPLORATION_LANE_INCOMPLETE",
          message: `lane terminal outcome ${String(child.outcome.kind)}`,
        };
        batchControl.cancel(`lane-failed:${child.alias}`);
      }
      return child;
    } catch (error) {
      clearTimeout(child._timer);
      if (error?.code === "EXPLORATION_LANE_HANG") {
        child.status = "HANG";
        child.error = { code: "EXPLORATION_LANE_HANG", message: error.message };
      } else {
        child.status = "FAILED";
        child.error = {
          code: String(error?.code || "EXPLORATION_LANE_FAILED"),
          message: String(error?.message || error),
        };
      }
      // a failed/hung lane flips the SHARED channel: the peer stops at its
      // next safe checkpoint (V3-I08)
      batchControl.cancel(`${child.status.toLowerCase()}:${child.alias}:${child.error.code}`);
      return child;
    }
  }

  /**
   * Run ONE exploration batch end-to-end.
   * @returns {object} public aggregate receipt (no tokens/session ids/leases)
   */
  async function startExplorationRun({
    mission,
    actorId = "agent:xhs-goal-explore",
    executionRunId = null,
    planHash = null,
    releaseId = null,
    accountFingerprint = null,
  } = {}) {
    // seal discipline BEFORE any session/lease/authority I/O (plan §3.2/§5.1):
    // a tampered or unsealed mission is a whole-run rejection, never a clamp
    const sealed = validateSealedMission(mission);
    assertExplorationLanePair(sealed);
    if (!planHash || !/^[a-f0-9]{64}$/.test(String(planHash))) {
      throw coordinatorError("EXPLORATION_PLAN_HASH_REQUIRED", "a 64-hex planHash is required to bind the authority");
    }

    const identity = createRoutineExecutionIdentity({ executionRunId, randomUUIDFn });
    const batchToken = identity.routineRunId.slice(3);
    const aggregate = {
      executionRunId: identity.executionRunId,
      routineRunId: identity.routineRunId,
      missionHash: sealed.missionHash,
      planHash,
      status: "ACQUIRING",
      ok: false,
      serverVerified: false,
      authorityId: null,
      children: [],
      cleanup: { releases: [], leaseOracle: null, authorityClosed: null },
      recovery: { attempts: [] },
      view: null,
      error: null,
      receiptHash: null,
    };

    const batchControl = {
      cancelled: false,
      reason: null,
      cancel(reason) {
        if (this.cancelled) return;
        this.cancelled = true;
        this.reason = String(reason || "batch-cancelled");
      },
    };

    const sessions = {};
    const acquire = async (alias) => {
      const session = await createSession({ actorId, alias });
      if (!session?.sessionId || typeof session.token !== "string" || !session.token) {
        throw coordinatorError("EXPLORATION_SESSION_INVALID", `session for alias ${alias} is malformed`);
      }
      const bounded = session.alias ?? alias;
      if (bounded !== alias) {
        throw coordinatorError("EXPLORATION_SESSION_ALIAS_DRIFT",
          `requested ${alias} but the session drifted to ${bounded}`);
      }
      sessions[alias] = {
        alias,
        sessionId: session.sessionId,
        token: session.token,
        leaseId: session.leaseId ?? null,
      };
      return sessions[alias];
    };

    // §8.3 acquire barrier: 03 then 04; nothing starts between. A failure
    // short-circuits the batch — a partial pair is released, never downgraded.
    try {
      await acquire("03");
      await acquire("04");
    } catch (error) {
      for (const alias of ["03", "04"]) {
        if (sessions[alias]) await releaseShielded(sessions[alias], aggregate.cleanup);
      }
      await leaseOracle(new Set(Object.values(sessions).map((s) => s.leaseId).filter(Boolean)), aggregate.cleanup);
      aggregate.status = "BLOCKED";
      aggregate.error = {
        code: String(error?.code || "EXPLORATION_ACQUIRE_FAILED"),
        message: `acquire barrier failed: ${String(error?.message || error)}`,
      };
      return finish(aggregate);
    }

    // ONE authority for BOTH sessions — registered only after the barrier; the
    // CP refuses anything but the exact [03,04] pair, so a downgrade cannot be
    // smuggled through a partial registration either.
    let authority = null;
    try {
      authority = await registerExplorationAuthority({
        sessions: [
          { alias: "03", sessionId: sessions["03"].sessionId, token: sessions["03"].token },
          { alias: "04", sessionId: sessions["04"].sessionId, token: sessions["04"].token },
        ],
        executionRunId: identity.executionRunId,
        routineRunId: identity.routineRunId,
        mission: sealed,
        planHash,
        releaseId,
        accountFingerprint,
      });
      if (!authority?.authorityId) {
        throw coordinatorError("EXPLORATION_AUTHORITY_RESPONSE_INVALID", "authority registration response is malformed");
      }
      aggregate.authorityId = authority.authorityId;
    } catch (error) {
      for (const alias of ["03", "04"]) {
        await releaseShielded(sessions[alias], aggregate.cleanup);
      }
      await leaseOracle(new Set(Object.values(sessions).map((s) => s.leaseId).filter(Boolean)), aggregate.cleanup);
      aggregate.status = "BLOCKED";
      aggregate.error = {
        code: String(error?.code || "EXPLORATION_AUTHORITY_FAILED"),
        message: `exploration authority registration failed: ${String(error?.message || error)}`,
      };
      return finish(aggregate);
    }

    // both lanes launch through allSettled; neither is prioritized and the
    // fixed roles come from the sealed placement (no reassignment here).
    aggregate.status = "RUNNING";
    const children = EXPLORATION_LANES.map((lane) => ({
      alias: lane.alias,
      laneRole: lane.role,
      routineRunId: perLaneRoutineRunId(batchToken, lane.alias),
      status: "RUNNING",
      outcome: null,
      receipt: null,
      receiptHash: null,
      committed: false,
      error: null,
      _settled: null,
      _timer: null,
      _guard: null,
    }));
    for (const child of children) {
      track(child, startLane({
        child,
        alias: child.alias,
        session: sessions[child.alias],
        authority,
        mission: sealed,
        batchControl,
        executionRunId: identity.executionRunId,
        routineRunId: child.routineRunId,
      }));
    }
    await Promise.allSettled(children.map((child) => raceWithHangGuard(child, batchControl)));

    // server verdict source, first read
    let viewed = await authorityView(sessions["03"], authority.authorityId);
    aggregate.serverVerified = viewed.verified;
    aggregate.view = publicView(viewed.view);

    // parent-owned recovery: any FAILED/HANG lane the CP shows NOT committed
    // gets ONE ABORTED append (never SUCCESS) through that lane's own session
    for (const child of children) {
      const committed = aggregate.view?.lanes?.[child.alias]?.committed === true;
      child.committed = committed;
      if (committed || (child.status === "COMPLETED" && child._settled?.ok)) continue;
      if (typeof appendLaneRecord !== "function" || !["FAILED", "HANG"].includes(child.status)) continue;
      try {
        const appended = await withBudget(
          () => appendLaneRecord({
            sessionId: sessions[child.alias].sessionId,
            token: sessions[child.alias].token,
            alias: child.alias,
            authorityId: authority.authorityId,
            type: "ABORTED",
            payload: {
              laneStatus: child.status,
              reason: child.error?.code ?? batchControl.reason ?? "lane-unsettled",
            },
          }),
          releaseTimeoutMs,
          "EXPLORATION_RECOVERY_TIMEOUT",
        );
        aggregate.recovery.attempts.push({
          alias: child.alias, appended: true, recordHash: appended?.recordHash ?? null,
        });
      } catch (error) {
        aggregate.recovery.attempts.push({
          alias: child.alias, appended: false,
          error: String(error?.code || error?.message || error),
        });
      }
    }

    // fresh read AFTER recovery appends — the verdict uses this one
    viewed = await authorityView(sessions["03"], authority.authorityId);
    if (viewed.verified) {
      aggregate.serverVerified = true;
      aggregate.view = publicView(viewed.view);
      for (const child of children) {
        child.committed = aggregate.view.lanes?.[child.alias]?.committed === true;
      }
    }

    // hard pre-verdict: every lane COMPLETED with a server-committed journal,
    // the shared channel stayed quiet (no peer-cancel), and the CP view was
    // actually read. Everything else stays BLOCKED — no downgrade, no partial
    // success.
    const allLanesOk = children.every((child) => child.status === "COMPLETED"
      && LANE_COMPLETE.has(child.outcome?.kind)
      && child.committed === true);
    const preverdictOk = allLanesOk
      && !batchControl.cancelled
      && viewed.verified
      && aggregate.view?.allSettled === true;

    // close the authority BEFORE the releases: the CP close path validates the
    // owning session, so it must run while the parent still holds the tokens.
    // Every lane journal already carries COMMITTED or the CP refuses and the
    // aggregate stays BLOCKED.
    if (preverdictOk && typeof closeExplorationAuthority === "function") {
      try {
        const closed = await withBudget(
          () => closeExplorationAuthority({
            sessionId: sessions["03"].sessionId,
            token: sessions["03"].token,
            authorityId: authority.authorityId,
            reason: "batch-succeeded",
          }),
          releaseTimeoutMs,
          "EXPLORATION_CLOSE_TIMEOUT",
        );
        aggregate.cleanup.authorityClosed = { ok: closed?.status === "closed", status: closed?.status ?? null };
      } catch (error) {
        aggregate.cleanup.authorityClosed = {
          ok: false,
          error: String(error?.code || error?.message || error),
        };
      }
    }

    // parent-owned cleanup: shielded releases, then the independent oracle
    const oracleInput = new Set(Object.values(sessions).map((s) => s.leaseId).filter(Boolean));
    for (const alias of ["03", "04"]) {
      await releaseShielded(sessions[alias], aggregate.cleanup);
    }
    const oracle = await leaseOracle(oracleInput, aggregate.cleanup);
    const cleanupOk = aggregate.cleanup.releases.every((r) => r.ok) && oracle.ok;
    aggregate.ok = preverdictOk
      && cleanupOk
      && (aggregate.cleanup.authorityClosed?.ok !== false);
    aggregate.status = aggregate.ok ? "SUCCEEDED" : "BLOCKED";

    aggregate.children = children.map(toPublicChild);
    if (!aggregate.ok && !aggregate.error) {
      aggregate.error = {
        code: "EXPLORATION_BATCH_BLOCKED",
        message: blockedReason(aggregate, batchControl),
      };
    }
    return finish(aggregate);
  }

  return { startExplorationRun };
}

function toPublicChild(child) {
  return {
    alias: child.alias,
    laneRole: child.laneRole,
    routineRunId: child.routineRunId,
    status: child.status,
    outcome: child.outcome,
    receipt: child.receipt,
    receiptHash: child.receiptHash,
    committed: child.committed === true,
    error: child.error,
  };
}

function blockedReason(aggregate, batchControl) {
  const parts = [];
  if (batchControl.cancelled) parts.push(`shared channel cancelled (${batchControl.reason})`);
  for (const release of aggregate.cleanup.releases) {
    if (!release.ok) parts.push(`release ${release.alias} unresolved`);
  }
  const oracle = aggregate.cleanup.leaseOracle;
  if (oracle && oracle.ok !== true) {
    parts.push(oracle.checked ? `lease oracle found active leases` : "lease oracle unavailable");
  }
  for (const child of aggregate.children) {
    if (child.status !== "COMPLETED") parts.push(`lane ${child.alias} ${child.status}`);
    else if (child.committed !== true) parts.push(`lane ${child.alias} journal uncommitted`);
  }
  return parts.join("; ") || "batch invariants unmet";
}

/** Strip internal handles and seal the aggregate with a content hash. */
function finish(aggregate) {
  const pub = {
    executionRunId: aggregate.executionRunId,
    routineRunId: aggregate.routineRunId,
    missionHash: aggregate.missionHash,
    planHash: aggregate.planHash,
    status: aggregate.status,
    ok: aggregate.ok === true,
    serverVerified: aggregate.serverVerified === true,
    authorityId: aggregate.authorityId,
    children: aggregate.children,
    cleanup: {
      releases: aggregate.cleanup.releases,
      leaseOracle: aggregate.cleanup.leaseOracle,
      authorityClosed: aggregate.cleanup.authorityClosed,
    },
    recovery: { attempts: aggregate.recovery.attempts },
    view: aggregate.view,
    error: aggregate.error,
    receiptHash: null,
  };
  pub.receiptHash = sha256Hex(canonicalJson(pub));
  return pub;
}