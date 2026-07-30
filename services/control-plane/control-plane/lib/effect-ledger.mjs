import { ControlPlaneError } from "./errors.mjs";
import { evaluateMissionEffect, targetFingerprint } from "./mission-policy.mjs";

export class EffectLedger {
  constructor({ state } = {}) {
    if (!state) throw new TypeError("EffectLedger requires a StateStore");
    this.state = state;
  }

  beginEffect({ mission, deviceRunId, action, target, intent = {}, idempotencyKey, allowProtected = false }) {
    const policy = evaluateMissionEffect(mission, { action, target });
    if (policy.decision === "scope_violation") {
      throw new ControlPlaneError("SCOPE_VIOLATION", "effect action or target is outside Mission scope", { status: 409 });
    }
    if (policy.decision === "blocked") {
      throw new ControlPlaneError(policy.reason, "Mission is not active for this effect", { status: 409 });
    }
    if (policy.decision === "phc" && !allowProtected) {
      throw new ControlPlaneError("PHC_REQUIRED", "protected effects require a human commit", { status: 409 });
    }
    const targetHash = targetFingerprint(target);
    if (!targetHash) throw new ControlPlaneError("TARGET_REQUIRED", "effect target fingerprint is required", { status: 400 });
    const result = this.state.beginMissionEffect({
      mission,
      deviceRunId,
      action,
      targetHash,
      intent,
      idempotencyKey,
      // Reserving budget is not proof that a send began.  Only ECP marks `started` at the
      // final synchronous boundary immediately before calling an effect adapter.
      status: policy.decision === "phc" ? "pending_authorization" : "not_sent",
    });
    return { ...result.effect, reused: result.reused };
  }

  recordOutcome(effectId, { status, evidenceRefs = [] } = {}) {
    const effect = this.state.recordMissionEffectOutcome(effectId, { status, evidenceRefs });
    return {
      ...effect,
      reservationConsumed: effect.reservationConsumed,
      reservationReleased: effect.reservationReleased,
    };
  }

  waitForAuthorization(effectId) {
    return this.state.setMissionEffectWaitingAuthorization(effectId);
  }

  startAuthorizedEffect(effectId) {
    return this.state.startAuthorizedMissionEffect(effectId);
  }

  startEffectForExecution(effectId) {
    return this.state.startPreparedMissionEffect(effectId);
  }

  beginEffectSend(input) {
    return this.state.beginMissionEffectSend(input);
  }

  retryNotSent(effectId, recheck) {
    if (!recheck?.rechecked) {
      throw new ControlPlaneError("EFFECT_RECHECK_REQUIRED", "not_sent retry requires a fresh full recheck", { status: 409 });
    }
    const effect = this.state.retryNotSentMissionEffect(effectId);
    return { ...effect, reservationRetained: !effect.reservationReleased };
  }

  abandonNotSent(effectId) {
    const effect = this.state.abandonNotSentMissionEffect(effectId);
    return { ...effect, reservationReleased: effect.reservationReleased };
  }
}
