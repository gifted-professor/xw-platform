import { evaluateMissionEffect, targetFingerprint } from "./mission-policy.mjs";

function blocked(code) {
  return { status: "blocked", code };
}

function correctnessCode(mission, target, result) {
  if (!result?.readiness?.ready) return "READINESS_NOT_READY";
  if (result.readiness.source !== "control-plane" || result.readiness.fresh !== true) return "READINESS_STALE";
  if (result.app !== mission.app) return "APP_MISMATCH";
  if (result.account !== mission.account) return "ACCOUNT_MISMATCH";
  if (result.targetFingerprint !== targetFingerprint(target)) return "TARGET_MISMATCH";
  if (!result.pageFingerprint) return "PAGE_MISMATCH";
  if (result.beforeState === undefined || result.beforeState === null) return "BEFORE_STATE_MISMATCH";
  if (result.control !== true) return "CONTROL_MISMATCH";
  return null;
}

export class EffectCommitProtocol {
  constructor({ state, ledger, deviceRuns, recheck, execute, verify, restore, recordEvidence = null } = {}) {
    if (!state || !ledger || !deviceRuns) throw new TypeError("ECP requires state, ledger, and deviceRuns");
    if (typeof recheck !== "function" || typeof execute !== "function" || typeof verify !== "function" || typeof restore !== "function") {
      throw new TypeError("ECP requires recheck, execute, verify, and restore handlers");
    }
    this.state = state;
    this.ledger = ledger;
    this.deviceRuns = deviceRuns;
    this.recheck = recheck;
    this.execute = execute;
    this.verify = verify;
    this.restore = restore;
    this.recordEvidence = recordEvidence;
  }

  async prepare(input) {
    const policy = evaluateMissionEffect(input.mission, { action: input.action, target: input.target });
    if (policy.decision === "scope_violation") return blocked("SCOPE_VIOLATION");
    if (policy.decision === "blocked") return blocked(policy.reason);
    this.deviceRuns.assertControlTuple(input.tuple);
    const rechecked = await this.recheck(input);
    const code = correctnessCode(input.mission, input.target, rechecked);
    if (code) return blocked(code);
    const effect = this.ledger.beginEffect({
      ...input,
      deviceRunId: input.tuple.deviceRunId,
      intent: input.intent || {},
      allowProtected: input.allowProtected === true,
    });
    return { status: "prepared", effect, rechecked, policy };
  }

  async executePrepared(prepared) {
    if (prepared.status !== "prepared") return prepared;
    const { effect, rechecked, policy, ...input } = prepared;
    let outcome = null;
    try {
      this.deviceRuns.assertControlTuple(input.tuple);
      const current = await this.recheck(input);
      const code = correctnessCode(input.mission, input.target, current);
      if (code) {
        outcome = this.ledger.recordOutcome(effect.effectId, { status: "cancelled" });
        return blocked(code);
      }
      if (policy.decision === "phc") this.ledger.startAuthorizedEffect(effect.effectId);
      const execution = await this.execute({ ...input, effectId: effect.effectId, target: current.targetFingerprint });
      const verification = await this.verify({ ...input, effectId: effect.effectId, execution, afterState: rechecked.beforeState });
      if (verification?.ok === true) {
        outcome = this.ledger.recordOutcome(effect.effectId, { status: "verified", evidenceRefs: verification.evidenceRefs || [] });
      } else {
        outcome = this.ledger.recordOutcome(effect.effectId, { status: "ambiguous", evidenceRefs: verification?.evidenceRefs || [] });
      }
      if (typeof this.recordEvidence === "function") this.recordEvidence({ effectId: effect.effectId, evidenceRefs: outcome.evidenceRefs });
      return { status: outcome.status, effect: outcome };
    } catch (error) {
      const notSent = error?.code === "NOT_SENT";
      outcome = this.ledger.recordOutcome(effect.effectId, { status: notSent ? "not_sent" : "ambiguous" });
      return { status: outcome.status, effect: outcome, error: { code: error?.code || "EFFECT_EXECUTION_FAILED" } };
    } finally {
      await this.restore({ ...input, effectId: effect.effectId, outcome: outcome?.status || "ambiguous" });
    }
  }

  async commit(input) {
    const prepared = await this.prepare(input);
    if (prepared.status !== "prepared") return prepared;
    if (prepared.policy.decision === "phc") return { status: "waiting_authorization", code: "PHC_REQUIRED", prepared };
    return this.executePrepared({ ...prepared, ...input });
  }

  async cancelPrepared(prepared) {
    if (prepared?.status !== "prepared") return prepared;
    const { effect, ...input } = prepared;
    try {
      await this.restore({ ...input, effectId: effect.effectId, outcome: "cancelled" });
    } finally {
      const cancelled = this.ledger.recordOutcome(effect.effectId, { status: "cancelled" });
      return { status: "cancelled", effect: cancelled };
    }
  }

  markWaitingAuthorization(prepared) {
    if (prepared?.status !== "prepared") return prepared;
    const effect = this.ledger.waitForAuthorization(prepared.effect.effectId);
    return { ...prepared, effect };
  }
}
