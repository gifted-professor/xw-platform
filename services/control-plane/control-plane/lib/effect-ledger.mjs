import { ControlPlaneError } from "./errors.mjs";
import { evaluateMissionEffect, targetFingerprint } from "./mission-policy.mjs";

export class EffectLedger {
  // REX Phase 5 §8.4 (P5b): policyMode threads nonpayment_v1 into the durable budget gate
  // (softBudget) and debtSink records the resulting budget_debt. Defaults null = legacy
  // fail-closed, byte-for-byte unchanged.
  constructor({ state, policyMode = null, debtSink = null } = {}) {
    if (!state) throw new TypeError("EffectLedger requires a StateStore");
    this.state = state;
    this.policyMode = policyMode;
    this.debtSink = debtSink;
  }

  beginEffect({ mission, deviceRunId, action, target, intent = {}, idempotencyKey, allowProtected = false, policyMode = null }) {
    // REX Phase 5 §8.4 (P5b): policyMode threads the ECP's nonpayment_v1 scope soft-budget
    // into beginEffect; legacy (null) keeps scope_violation fail-closed. PHC/allowProtected
    // paths never pass policyMode, so payment scope is untouched.
    const policy = evaluateMissionEffect(mission, { action, target }, { policyMode });
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
      // REX Phase 5 §8.4 (P5b): only the soft out-of-scope path (policy.debt) relaxes the
      // durable scope gate; in-scope and payment/protected effects keep softScope=false.
      softScope: Boolean(policy.debt),
      // REX P5b: an exhausted count/frequency budget under nonpayment_v1 is a budget_debt, not
      // a block. Payment/protected effects never reach here soft (they keep policy.debt false).
      softBudget: (policyMode ?? this.policyMode)?.active === true,
      debtSink: this.debtSink,
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
