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

function consumeExplicitReceipt(state, evidence, input) {
  if (!input.mission?.parentGrantId) return null;
  if (typeof input.observationReceiptId !== "string" || input.observationReceiptId === "") {
    return "EXPLICIT_RECEIPT_REQUIRED";
  }
  const run = state.getDeviceRun(input.tuple.deviceRunId);
  try {
    const receipt = state.getExplicitObservationReceipt(input.observationReceiptId);
    if (!receipt || !evidence || typeof evidence.findByIdAndHash !== "function") return "EXPLICIT_RECEIPT_EVIDENCE_UNAVAILABLE";
    evidence.findByIdAndHash(receipt.evidenceId, receipt.evidenceHash);
    state.consumeExplicitObservationReceipt({
      receiptId: input.observationReceiptId,
      missionId: input.mission.missionId,
      deviceRunId: input.tuple.deviceRunId,
      leaseId: run?.leaseId,
      sessionId: input.tuple.sessionId,
      controllerEpoch: input.tuple.controllerEpoch,
      action: input.action,
      targetFingerprint: targetFingerprint(input.target),
    });
    return null;
  } catch (error) {
    return error?.code || "EXPLICIT_RECEIPT_INVALID";
  }
}

export class EffectCommitProtocol {
  constructor({ state, ledger, deviceRuns, missions = null, evidence = null, recheck, execute, verify, restore, recordEvidence = null } = {}) {
    if (!state || !ledger || !deviceRuns) throw new TypeError("ECP requires state, ledger, and deviceRuns");
    if (typeof recheck !== "function" || typeof execute !== "function" || typeof verify !== "function" || typeof restore !== "function") {
      throw new TypeError("ECP requires recheck, execute, verify, and restore handlers");
    }
    this.state = state;
    this.ledger = ledger;
    this.deviceRuns = deviceRuns;
    this.missions = missions;
    this.evidence = evidence;
    this.recheck = recheck;
    this.execute = execute;
    this.verify = verify;
    this.restore = restore;
    this.recordEvidence = recordEvidence;
  }

  async prepare(input) {
    const parent = this.missions?.verifyParentGrant(input.mission, { action: input.action, target: input.target });
    if (parent && !parent.ok) return blocked(parent.code);
    const discovery = this.missions?.verifyAuthoritativeDiscovery(input.mission);
    if (discovery && !discovery.ok) return blocked(discovery.code);
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
      const parent = this.missions?.verifyParentGrant(input.mission, { action: input.action, target: input.target });
      if (parent && !parent.ok) {
        outcome = this.ledger.recordOutcome(effect.effectId, { status: "cancelled" });
        return blocked(parent.code);
      }
      const discovery = this.missions?.verifyAuthoritativeDiscovery(input.mission);
      if (discovery && !discovery.ok) {
        outcome = this.ledger.recordOutcome(effect.effectId, { status: "cancelled" });
        return blocked(discovery.code);
      }
      this.deviceRuns.assertControlTuple(input.tuple);
      const current = await this.recheck(input);
      const code = correctnessCode(input.mission, input.target, current);
      if (code) {
        outcome = this.ledger.recordOutcome(effect.effectId, { status: "cancelled" });
        return blocked(code);
      }
      // This is the last synchronous boundary before the adapter.  It consumes the receipt in
      // a short SQLite transaction that rechecks the live parent and exact tuple; no adapter
      // await can run while the StateStore holds BEGIN IMMEDIATE.
      const receiptCode = consumeExplicitReceipt(this.state, this.evidence, input);
      if (receiptCode) {
        outcome = this.ledger.recordOutcome(effect.effectId, { status: "cancelled" });
        return blocked(receiptCode);
      }
      if (policy.decision === "phc") this.ledger.startAuthorizedEffect(effect.effectId);
      else this.ledger.startEffectForExecution(effect.effectId);
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

  // A not_sent retry is intentionally not exposed as a ledger-only convenience. It binds the
  // durable reservation back to its original run and repeats the same observed-state checks
  // before one retry; caller-provided booleans cannot authorize an external effect.
  async retryNotSentInPlace(input) {
    const { effectId, tuple, mission, target } = input || {};
    this.deviceRuns.assertControlTuple(tuple);
    const parent = this.missions?.verifyParentGrant(mission, { action: input?.action, target });
    if (parent && !parent.ok) return blocked(parent.code);
    const discovery = this.missions?.verifyAuthoritativeDiscovery(mission);
    if (discovery && !discovery.ok) return blocked(discovery.code);
    const effect = this.state.listMissionEffects(mission?.missionId)
      .find((candidate) => candidate.effectId === effectId);
    const action = input?.action || effect?.action;
    if (!effect || effect.deviceRunId !== tuple.deviceRunId || (input?.action && effect.action !== input.action)
      || effect.targetFingerprint !== targetFingerprint(target)) {
      return blocked("EFFECT_BINDING_MISMATCH");
    }
    const policy = evaluateMissionEffect(mission, { action, target });
    if (policy.decision === "scope_violation") return blocked("SCOPE_VIOLATION");
    if (policy.decision === "blocked") return blocked(policy.reason);
    const rechecked = await this.recheck(input);
    const code = correctnessCode(mission, target, rechecked);
    if (code) return blocked(code);

    const retried = this.ledger.retryNotSent(effectId, { rechecked: true });
    let outcome = null;
    try {
      const liveParent = this.missions?.verifyParentGrant(mission, { action, target });
      if (liveParent && !liveParent.ok) {
        outcome = this.ledger.recordOutcome(effectId, { status: "cancelled" });
        return blocked(liveParent.code);
      }
      this.deviceRuns.assertControlTuple(tuple);
      const current = await this.recheck(input);
      const currentCode = correctnessCode(mission, target, current);
      if (currentCode) {
        outcome = this.ledger.recordOutcome(effectId, { status: "cancelled" });
        return blocked(currentCode);
      }
      const receiptCode = consumeExplicitReceipt(this.state, this.evidence, input);
      if (receiptCode) {
        outcome = this.ledger.recordOutcome(effectId, { status: "cancelled" });
        return blocked(receiptCode);
      }
      this.ledger.startEffectForExecution(effectId);
      const execution = await this.execute({ ...input, action, effectId, target: current.targetFingerprint });
      const verification = await this.verify({ ...input, action, effectId, execution, afterState: current.beforeState });
      outcome = this.ledger.recordOutcome(effectId, {
        status: verification?.ok === true ? "verified" : "ambiguous",
        evidenceRefs: verification?.evidenceRefs || [],
      });
      if (typeof this.recordEvidence === "function") this.recordEvidence({ effectId, evidenceRefs: outcome.evidenceRefs });
      return { status: outcome.status, effect: outcome, retried };
    } catch (error) {
      const notSent = error?.code === "NOT_SENT";
      outcome = this.ledger.recordOutcome(effectId, { status: notSent ? "not_sent" : "ambiguous" });
      return { status: outcome.status, effect: outcome, retried, error: { code: error?.code || "EFFECT_EXECUTION_FAILED" } };
    } finally {
      await this.restore({ ...input, action, effectId, outcome: outcome?.status || "ambiguous" });
    }
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
