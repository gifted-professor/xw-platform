// routine-effect-bridge.mjs — the single commitRoutineEffect bridge for the 04
// XHS deterministic routine (direct-routine plan V2 §6.3/§6.4/§7).
//
// The routine state machine (orchestrator, S1) discovers targets and decides
// WHEN an effect may be attempted; this bridge owns HOW it is committed. It
// receives the existing owner's session binding (sessionId/leaseRef/
// leaseAuthorization/routineRunId) and routes the effect through the
// server-hard routine effect ledger + a typed, session-bound capability
// transport. It never opens a competing job on the lease and never lets a CLI
// or live driver touch the StateStore directly.
//
// Rejected before transport (§6.4):
//   - missing/mismatched owner tuple          -> ROUTINE_CONTEXT_INVALID / SESSION_MISMATCH
//   - a nested normal job on the lease        -> NESTED_JOB_REJECTED
//   - raw adapter/coordinate effect taps      -> EFFECT_TAP_SURFACE_REJECTED
//     (classifier output can never authorize an effect control)
//   - caller-self-reported target fingerprint -> TARGET_BINDING_MISMATCH
//   - unwired actions (comment arrives in S3) -> ROUTINE_ACTION_NOT_WIRED
//
// Like pre-state (§7.7): the ONLY transportable state is `unliked`, classified
// by the exact control label from a fresh same-session observation (<=5s).
// `liked` skips without any reservation; `missing/unknown` re-observes once and
// otherwise STOP_EFFECT with zero transport. Never a blind toggle.
//
// Post-state (§7.8): verified only when the post-observation classifies
// `liked`; timeout/unclear -> ambiguous (slot consumed, no retry).
//
// mode=hard: budget lives in StateStore.beginRoutineEffect — same transaction,
// no soft path; nonpayment-autonomy policyMode is not consulted anywhere here.
import { ControlPlaneError } from "../../control-plane/lib/errors.mjs";
import { likeState } from "./social-verifiers.mjs";
import { bindOperationKey } from "../../../orchestrator/scripts/lib/xw-xhs-dispatcher.mjs";

export const ROUTINE_EFFECT_BUDGET = Object.freeze({
  mode: "hard",
  actions: Object.freeze({
    like: Object.freeze({ max: 1, perTarget: 1 }),
    comment: Object.freeze({ max: 2, perTarget: 1 }),
  }),
});

/** Freshness window for a like pre-state observation (§7.7). */
export const LIKE_OBSERVATION_MAX_AGE_MS = 5000;
/** Delay before the single re-observe of a missing/unknown state (§7.7). */
export const LIKE_REOBSERVE_DELAY_MS = 5000;

function code(name, message, status = 409, details = undefined) {
  return new ControlPlaneError(name, message, { status, ...(details !== undefined ? { details } : {}) });
}

/**
 * Create the routine effect bridge bound to ONE owner tuple.
 *
 * @param {object} input
 * @param {object} input.state - Control-plane StateStore
 * @param {object} input.owner - frozen owner binding:
 *   { sessionId, leaseRef, leaseAuthorization, routineRunId, planHash }
 * @param {object} input.transport - session-bound TYPED capability surface. It
 *   intentionally has no tapAt/coordinates API — an effect tap cannot even be
 *   expressed outside `commitLike`, and `commitLike` refuses to fire without a
 *   ledger reservation token:
 *     observe({ reason })  -> { hash, targetFingerprint, likeLabel, observedAt }
 *     commitLike({ operationKey, reservationToken }) -> { ok }
 * @param {object} [input.clock] - { nowMs(), sleep(ms) } (tests inject)
 */
export function createRoutineEffectBridge({ state, owner, transport, clock = { nowMs: () => Date.now(), sleep: () => Promise.resolve() } } = {}) {
  if (!state) throw new TypeError("createRoutineEffectBridge: state store required");
  if (!owner || !owner.sessionId || !owner.leaseRef || !owner.leaseAuthorization || !owner.routineRunId || !owner.planHash) {
    throw new TypeError("createRoutineEffectBridge: owner tuple (sessionId/leaseRef/leaseAuthorization/routineRunId/planHash) required");
  }
  if (!transport || typeof transport.observe !== "function" || typeof transport.commitLike !== "function") {
    throw new TypeError("createRoutineEffectBridge: typed capability transport { observe, commitLike } required");
  }
  const ownerTuple = Object.freeze({
    sessionId: owner.sessionId,
    leaseRef: owner.leaseRef,
    leaseAuthorization: owner.leaseAuthorization,
    routineRunId: owner.routineRunId,
    planHash: owner.planHash,
  });

  async function observeFresh(reason, targetFingerprint = null) {
    const obs = await transport.observe({ reason, targetFingerprint });
    if (!obs || typeof obs !== "object" || !obs.hash || typeof obs.likeLabel !== "string") {
      throw code("ROUTINE_OBSERVATION_INVALID", "transport observation is not a fresh same-session dump");
    }
    const age = clock.nowMs() - Number(obs.observedAt ?? clock.nowMs());
    if (!Number.isFinite(age) || age < 0 || age > LIKE_OBSERVATION_MAX_AGE_MS) {
      return { obs, fresh: false };
    }
    return { obs, fresh: true };
  }

  /**
   * commitRoutineEffect(routineContext, effectIntent) — the machine seam.
   * @param {object} routineContext - { sessionId, leaseRef, leaseAuthorization,
   *   routineRunId, planHash, targetFingerprint, observationHash, payloadHash? }
   * @param {object} effectIntent - { action: "like" }
   * @returns {{ outcome: string, transported: boolean, effectId?: string }}
   */
  async function commitRoutineEffect(routineContext, effectIntent) {
    // --- owner/bypass validation (all before any transport) ----------------
    if (!routineContext || typeof routineContext !== "object") {
      throw code("ROUTINE_CONTEXT_INVALID", "routineContext required", 400);
    }
    for (const key of ["sessionId", "leaseRef", "leaseAuthorization", "routineRunId", "planHash", "targetFingerprint", "observationHash"]) {
      if (!routineContext[key]) {
        throw code("ROUTINE_CONTEXT_INVALID", `routineContext.${key} required`, 400);
      }
    }
    if (routineContext.sessionId !== ownerTuple.sessionId
      || routineContext.leaseRef !== ownerTuple.leaseRef
      || routineContext.leaseAuthorization !== ownerTuple.leaseAuthorization) {
      throw code("SESSION_MISMATCH", "routine effect context does not match the owning session/lease tuple");
    }
    if (routineContext.routineRunId !== ownerTuple.routineRunId || routineContext.planHash !== ownerTuple.planHash) {
      throw code("SESSION_MISMATCH", "routine effect context does not match the owning routineRunId/planHash");
    }
    // nested-job bypass: a routine effect must never arrive as (or carry) a
    // normal job — that would compete with the owner lease
    if (routineContext.jobId || routineContext.asJob || effectIntent?.jobId || effectIntent?.job) {
      throw code("NESTED_JOB_REJECTED", "routine effects commit through this bridge, never as a nested job");
    }
    // direct-adapter / Explorer effect tap bypass: coordinates or a classifier-
    // located control can never authorize an effect (plan V2 §5)
    if (effectIntent?.control || effectIntent?.x != null || effectIntent?.y != null || effectIntent?.bounds) {
      throw code("EFFECT_TAP_SURFACE_REJECTED", "effect taps are not expressible through the classifier/control surface");
    }
    const action = String(effectIntent?.action || "");
    if (action !== "like") {
      // S3 wires comment through the same bridge; nothing else exists
      throw code("ROUTINE_ACTION_NOT_WIRED", `routine action ${action || "(none)"} is not wired through this bridge`, 400);
    }

    // --- fresh like pre-state (§7.7) ----------------------------------------
    let { obs, fresh } = await observeFresh("pre_like", routineContext.targetFingerprint);
    if (!fresh) {
      // stale dump: one fresh re-observation, same session
      ({ obs, fresh } = await observeFresh("pre_like_refresh", routineContext.targetFingerprint));
    }
    if (!fresh) {
      return { outcome: "stopped:observation_stale", transported: false };
    }
    // the caller cannot self-report a fingerprint: the CP-owned observation
    // must bind to the same target the machine picked
    if (obs.targetFingerprint !== routineContext.targetFingerprint) {
      throw code("TARGET_BINDING_MISMATCH", "routine target fingerprint is not bound by the authoritative observation");
    }
    let label = likeState(obs.likeLabel);
    if (label === "missing" || label === "unknown") {
      // exactly one re-observe after the delay; still unsure -> zero transport
      await clock.sleep(LIKE_REOBSERVE_DELAY_MS);
      const retry = await observeFresh("pre_like_reobserve", routineContext.targetFingerprint);
      if (!retry.fresh) {
        return { outcome: "stopped:observation_stale", transported: false };
      }
      label = likeState(retry.obs.likeLabel);
      obs = retry.obs;
    }
    if (label === "liked") {
      // already-true skip: no reservation, no transport, no retry
      return { outcome: "skipped:already_liked", transported: false };
    }
    if (label !== "unliked") {
      // missing/unknown after the single re-observe: STOP_EFFECT, slot not consumed
      return { outcome: "stopped:effect_state_unprovable", transported: false };
    }

    // --- server-hard reservation (same transaction, mode=hard) --------------
    const operationKey = bindOperationKey({
      actionRunId: routineContext.routineRunId,
      action,
      targetFingerprint: routineContext.targetFingerprint,
      payloadHash: routineContext.payloadHash ?? null,
    });
    let reservation;
    let reused = false;
    try {
      ({ effect: reservation, reused } = state.beginRoutineEffect({
        routineRunId: routineContext.routineRunId,
        planHash: routineContext.planHash,
        action,
        targetFingerprint: routineContext.targetFingerprint,
        observationHash: routineContext.observationHash,
        payloadHash: routineContext.payloadHash ?? null,
        intent: { surface: "xhs-routine", sessionId: routineContext.sessionId, leaseRef: routineContext.leaseRef },
        idempotencyKey: operationKey,
        budget: ROUTINE_EFFECT_BUDGET,
      }));
    } catch (e) {
      if (e instanceof ControlPlaneError && e.code === "ROUTINE_BUDGET_EXCEEDED") {
        return { outcome: "cap_reached", transported: false };
      }
      if (e instanceof ControlPlaneError && e.code === "ROUTINE_BUDGET_PER_TARGET_EXCEEDED") {
        return { outcome: "cap_reached:per_target", transported: false };
      }
      if (e instanceof ControlPlaneError && e.code === "AMBIGUOUS_NO_RETRY") {
        return { outcome: "ambiguous_no_retry", transported: false };
      }
      if (e instanceof ControlPlaneError && e.code === "ROUTINE_ACTION_CLOSED") {
        return { outcome: "closed:ambiguous", transported: false };
      }
      throw e;
    }
    if (reused) {
      // stable operation key replay: reuse the original receipt, never re-send
      return { outcome: "replayed", transported: false, effectId: reservation.effectId };
    }

    // --- single transport + post-state verification (§7.8) ------------------
    let commitOk = false;
    try {
      const res = await transport.commitLike({ operationKey, reservationToken: reservation.effectId });
      commitOk = res?.ok === true;
    } catch {
      commitOk = false;
    }
    let postState = null;
    try {
      const post = await transport.observe({ reason: "post_like", targetFingerprint: routineContext.targetFingerprint });
      postState = likeState(post?.likeLabel);
    } catch {
      postState = "unknown";
    }
    if (commitOk && postState === "liked") {
      state.recordRoutineEffectOutcome(reservation.effectId, { status: "verified", evidenceRefs: [operationKey] });
      return { outcome: "verified", transported: true, effectId: reservation.effectId };
    }
    // adapter timeout / post-state unclear: ambiguous — slot consumed, no retry
    state.recordRoutineEffectOutcome(reservation.effectId, { status: "ambiguous", evidenceRefs: [operationKey] });
    return { outcome: "ambiguous", transported: true, effectId: reservation.effectId };
  }

  return Object.freeze({ commitRoutineEffect, owner: ownerTuple, budget: ROUTINE_EFFECT_BUDGET });
}

/**
 * Machine seam adapter: wraps the bridge into the effects surface the S1
 * state machine expects — `effects.commitRoutineEffect({ plan, run, item,
 * intent })`. The routineContext is assembled from the MACHINE's plan identity
 * (not the owner's) so a plan/owner mismatch is caught by the bridge's
 * SESSION_MISMATCH fence rather than silently passing.
 */
export function bridgeAsMachineEffects({ bridge, owner }) {
  return {
    commitRoutineEffect: ({ plan, run, intent }) => bridge.commitRoutineEffect(
      {
        sessionId: owner.sessionId,
        leaseRef: owner.leaseRef,
        leaseAuthorization: owner.leaseAuthorization,
        routineRunId: run?.routineRunId ?? null,
        planHash: plan?.planHash ?? null,
        targetFingerprint: intent?.targetFingerprint ?? null,
        observationHash: intent?.observationHash ?? null,
        payloadHash: intent?.payloadHash ?? null,
      },
      intent,
    ),
  };
}