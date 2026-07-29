import { ControlPlaneError } from "./errors.mjs";
import {
  evaluateMissionEffect as classifyEffect,
  missionContentHash,
  validateMissionPolicy,
} from "./mission-policy.mjs";

// MissionRuntime owns the Mission lifecycle: create (validate + hash + persist), require
// active, revoke, and the pure scope/policy classifier. It is storage-backed via the
// shared StateStore (additive missions / mission_events tables). It does not authorize
// correctness, readiness, budget, or device control — those belong to the ECP / DeviceRun.
export class MissionRuntime {
  constructor({ state, now = Date.now } = {}) {
    if (!state) throw new TypeError("MissionRuntime requires a StateStore");
    this.state = state;
    this.now = now;
  }

  createMission(input) {
    const policy = validateMissionPolicy(input);
    const missionHash = missionContentHash(policy);
    // Deterministic canonical identity: the same authenticated command always maps to
    // the same missionId. A material expansion yields a new hash and therefore a new id.
    const missionId = `mission_${missionHash.slice(0, 24)}`;
    const expiresAtMs = Date.parse(policy.validity.expiresAt);
    const { mission, reused } = this.state.addMission({
      missionId,
      idempotencyKey: policy.idempotencyKey,
      issuerActorId: policy.issuer.actorId,
      version: 1,
      missionHash,
      contentHash: missionHash,
      policy,
      expiresAtMs,
    });
    return { mission, reused };
  }

  requireActiveMission(missionId) {
    const mission = this.state.getMission(missionId);
    if (!mission) throw new ControlPlaneError("MISSION_NOT_FOUND", `unknown mission ${missionId}`, { status: 404 });
    if (mission.status === "revoked") {
      throw new ControlPlaneError("MISSION_REVOKED", `mission ${missionId} was revoked`, { status: 409 });
    }
    const expiresAtMs = Date.parse(mission.validity?.expiresAt);
    if (Number.isFinite(expiresAtMs) && this.now() >= expiresAtMs) {
      throw new ControlPlaneError("MISSION_EXPIRED", `mission ${missionId} has expired`, { status: 409 });
    }
    return mission;
  }

  revokeMission(missionId, { actorId, reason = null } = {}) {
    if (typeof actorId !== "string" || actorId.trim() === "") {
      throw new ControlPlaneError("ACTOR_REQUIRED", "actorId is required", { status: 400 });
    }
    const existing = this.state.getMission(missionId);
    if (!existing) throw new ControlPlaneError("MISSION_NOT_FOUND", `unknown mission ${missionId}`, { status: 404 });
    const mission = this.state.setMissionStatus(missionId, "revoked", { reason });
    this.state.appendMissionEvent({
      missionId,
      type: "mission.revoked",
      payload: { actorId: actorId.trim(), reason },
    });
    return mission;
  }

  // Authorization classifier (scope + policy only). Re-reads the CURRENT mission state from
  // storage by missionId so a stale creation-time snapshot still reflects revocation or
  // expiry decided after the caller last fetched the mission. Never inspects typed action IDs.
  // Returns { decision, reason } where decision ∈ { ecp, phc, scope_violation, blocked }.
  evaluateMissionEffect(mission, { action, target }) {
    if (!mission || typeof mission !== "object") {
      throw new ControlPlaneError("MISSION_POLICY_INVALID", "mission must be an object", { status: 400 });
    }
    const current = mission.missionId ? this.state.getMission(mission.missionId) : mission;
    if (!current) {
      return { decision: "blocked", reason: "MISSION_NOT_FOUND" };
    }
    return classifyEffect(current, { action, target }, { now: this.now });
  }
}