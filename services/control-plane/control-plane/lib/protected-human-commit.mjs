import { newId } from "./canonical.mjs";
import { evaluateMissionEffect } from "./mission-policy.mjs";

export class ProtectedHumanCommit {
  constructor({ ecp, audit = () => {} } = {}) {
    if (!ecp) throw new TypeError("ProtectedHumanCommit requires an ECP");
    this.ecp = ecp;
    this.audit = audit;
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
    const prepared = await this.ecp.prepare({ ...input, allowProtected: true });
    if (prepared.status !== "prepared") return prepared;
    const commitId = newId("protected_commit");
    const waiting = typeof this.ecp.markWaitingAuthorization === "function"
      ? this.ecp.markWaitingAuthorization(prepared)
      : prepared;
    const pending = { commitId, prepared: { ...waiting, ...input }, action: input.action, target: input.target, missionId: input.mission?.missionId };
    this.pending.set(commitId, pending);
    this.audit({ type: "protected_human_commit.waiting_authorization", commitId, missionId: pending.missionId, action: input.action });
    return { commitId, status: "waiting_authorization", effectId: prepared.effect.effectId };
  }

  async decide(commitId, { decision, actorId } = {}) {
    const pending = this.pending.get(commitId);
    if (!pending) return { status: "blocked", code: "PROTECTED_COMMIT_NOT_FOUND" };
    this.pending.delete(commitId);
    if (decision === "approve") {
      const result = await this.ecp.executePrepared(pending.prepared);
      this.audit({ type: "protected_human_commit.approved", commitId, missionId: pending.missionId, actorId, action: pending.action });
      return result;
    }
    const result = typeof this.ecp.cancelPrepared === "function"
      ? await this.ecp.cancelPrepared(pending.prepared)
      : (await this.ecp.restore(pending.prepared), { status: "cancelled" });
    this.audit({ type: "protected_human_commit.denied", commitId, missionId: pending.missionId, actorId, action: pending.action });
    return result;
  }
}
