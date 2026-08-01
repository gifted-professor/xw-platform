import { newId } from "./canonical.mjs";
import { evaluateMissionEffect, targetFingerprint } from "./mission-policy.mjs";

export class ProtectedHumanCommit {
  constructor({ ecp, state = null, audit = () => {}, approvalVerifier = null, now = Date.now, approvalTtlMs = 120000 } = {}) {
    if (!ecp) throw new TypeError("ProtectedHumanCommit requires an ECP");
    if (approvalVerifier !== null && typeof approvalVerifier?.verify !== "function") {
      throw new TypeError("approvalVerifier.verify is required");
    }
    if (!Number.isFinite(approvalTtlMs) || approvalTtlMs <= 0) {
      throw new TypeError("approvalTtlMs must be positive");
    }
    this.ecp = ecp;
    this.state = state;
    this.audit = audit;
    this.approvalVerifier = approvalVerifier;
    this.now = now;
    this.approvalTtlMs = approvalTtlMs;
    // The live prepared handle is kept in-process for the per-commit decision. When a durable
    // StateStore is wired (via the control plane), the commitId is also persisted so the
    // pending commit is observable and survives a StateStore reconstruct instead of living
    // only in this Map. Control-plane restart cannot resume a pending commit (control was
    // lost); the store's recovery cancels it fail-closed.
    this.pending = new Map();
  }

  async route({ mission, action, target }) {
    const policy = evaluateMissionEffect(mission, { action, target });
    if (policy.decision === "scope_violation") return { decision: "blocked", code: "SCOPE_VIOLATION" };
    if (policy.decision === "blocked") return { decision: "blocked", code: policy.reason };
    return { decision: policy.decision };
  }

  async begin(input) {
    const route = await this.route(input);
    if (route.decision !== "phc") return route;
    if (input.action === "payment" && this.approvalVerifier) {
      const required = [
        input.runId,
        input.mission?.app,
        input.mission?.account,
        input.payment?.payeeRef,
        input.payment?.amount,
        input.payment?.currency,
        input.payment?.snapshotHash,
        input.payment?.deviceId,
        targetFingerprint(input.target),
      ];
      if (required.some((value) => typeof value !== "string" || value.trim() === "")) {
        return { status: "blocked", code: "PAYMENT_BINDING_INCOMPLETE" };
      }
    }
    const prepared = await this.ecp.prepare({ ...input, allowProtected: true });
    if (prepared.status !== "prepared") return prepared;
    const commitId = newId("protected_commit");
    const waiting = typeof this.ecp.markWaitingAuthorization === "function"
      ? this.ecp.markWaitingAuthorization(prepared)
      : prepared;
    const createdAt = new Date(this.now()).toISOString();
    const expiresAt = new Date(Date.parse(createdAt) + this.approvalTtlMs).toISOString();
    const approvalBinding = input.action === "payment" && this.approvalVerifier
      ? Object.freeze({
        commitId,
        runId: input.runId,
        effectId: prepared.effect.effectId,
        app: input.mission.app,
        accountRef: input.mission.account,
        payeeRef: input.payment.payeeRef,
        amount: input.payment.amount,
        currency: input.payment.currency,
        targetControlFingerprint: targetFingerprint(input.target),
        snapshotHash: input.payment.snapshotHash,
        deviceId: input.payment.deviceId,
        createdAt,
        expiresAt,
      })
      : null;
    const pending = {
      commitId,
      prepared: { ...waiting, ...input },
      action: input.action,
      target: input.target,
      missionId: input.mission?.missionId,
      approvalBinding,
      createdAt,
      expiresAt,
    };
    this.pending.set(commitId, pending);
    if (this.state) {
      this.state.addProtectedCommit({
        commitId,
        missionId: pending.missionId,
        effectId: prepared.effect.effectId,
        action: input.action,
        targetHash: targetFingerprint(input.target) || String(input.target ?? ""),
        status: "waiting_authorization",
        approvalBinding,
        expiresAt,
      });
    }
    this.audit({ type: "protected_human_commit.waiting_authorization", commitId, missionId: pending.missionId, action: input.action });
    return {
      commitId,
      status: "waiting_authorization",
      effectId: prepared.effect.effectId,
      ...(approvalBinding ? { approvalBinding } : {}),
    };
  }

  async decide(commitId, { decision, actorId, approval = null } = {}) {
    const pending = this.pending.get(commitId);
    if (!pending) return { status: "blocked", code: "PROTECTED_COMMIT_NOT_FOUND" };
    if (!["approve", "deny"].includes(decision)) {
      return { status: "blocked", code: "PROTECTED_COMMIT_DECISION_INVALID" };
    }
    if (this.now() >= Date.parse(pending.expiresAt)) {
      this.pending.delete(commitId);
      if (this.state) this.state.setProtectedCommitStatus(commitId, "expired");
      const result = typeof this.ecp.cancelPrepared === "function"
        ? await this.ecp.cancelPrepared(pending.prepared)
        : (await this.ecp.restore(pending.prepared), { status: "cancelled" });
      this.audit({ type: "protected_human_commit.expired", commitId, missionId: pending.missionId, action: pending.action });
      return { ...result, code: "PAYMENT_APPROVAL_EXPIRED" };
    }
    let verifiedActorId = actorId;
    if (decision === "approve" && pending.action === "payment" && this.approvalVerifier) {
      const verified = this.approvalVerifier.verify({ approval, binding: pending.approvalBinding });
      if (verified.ok !== true) {
        return { status: "waiting_authorization", code: verified.code, commitId };
      }
      verifiedActorId = verified.subject;
    }
    this.pending.delete(commitId);
    if (decision === "approve") {
      if (this.state) this.state.setProtectedCommitStatus(commitId, "approved");
      const result = await this.ecp.executePrepared(pending.prepared);
      this.audit({ type: "protected_human_commit.approved", commitId, missionId: pending.missionId, actorId: verifiedActorId, action: pending.action });
      return result;
    }
    if (this.state) this.state.setProtectedCommitStatus(commitId, "denied");
    const result = typeof this.ecp.cancelPrepared === "function"
      ? await this.ecp.cancelPrepared(pending.prepared)
      : (await this.ecp.restore(pending.prepared), { status: "cancelled" });
    this.audit({ type: "protected_human_commit.denied", commitId, missionId: pending.missionId, actorId, action: pending.action });
    return result;
  }
}
