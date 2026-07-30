import { ControlPlaneError } from "./errors.mjs";
import {
  evaluateMissionEffect as classifyEffect,
  missionContentHash,
  SNAPSHOT_MAX_AGE_MS,
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

  createMission(input, { parentGrantId = null, parentGrantHash = null } = {}) {
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
      parentGrantId,
      parentGrantHash,
    });
    return { mission, reused };
  }

  createMissionFromGrant({ parentGrantId, input }) {
    if (typeof parentGrantId !== "string" || parentGrantId.trim() === "") {
      throw new ControlPlaneError("PARENT_GRANT_REQUIRED", "parentGrantId is required", { status: 400 });
    }
    const record = this.state.getDelegationGrantRecord(parentGrantId);
    if (!record || record.status !== "active") {
      throw new ControlPlaneError("PARENT_GRANT_INACTIVE", "parent grant is not active", { status: 409 });
    }
    const parent = record.grant;
    const parentExpiry = parent.validity.expiresAt == null ? null : Date.parse(parent.validity.expiresAt);
    if (parentExpiry !== null && this.now() >= parentExpiry) {
      throw new ControlPlaneError("PARENT_GRANT_EXPIRED", "parent grant is expired", { status: 409 });
    }
    if (!input || typeof input !== "object" || !input.scope || typeof input.scope !== "object") {
      throw new ControlPlaneError("GRANT_SUBSET_INVALID", "child mission scope is required", { status: 400 });
    }
    if (input.app !== parent.app || input.account !== parent.accountFingerprint) {
      throw new ControlPlaneError("GRANT_SUBSET_INVALID", "child mission app/account must match its parent grant", { status: 400 });
    }
    const controllers = Array.isArray(input.controllers) ? input.controllers : [];
    if (controllers.length === 0 || controllers.some((controller) => !parent.controllers.includes(controller))) {
      throw new ControlPlaneError("GRANT_SUBSET_INVALID", "child mission controllers exceed parent grant", { status: 400 });
    }
    const allowedActions = new Set([
      ...parent.authorization.primitives,
      ...parent.authorization.socialActions,
      ...parent.authorization.missionOnlyActions,
    ]);
    const actions = input.scope.actions;
    if (!Array.isArray(actions) || actions.some((action) => !allowedActions.has(action) || parent.authorization.prohibitedActions.includes(action))) {
      throw new ControlPlaneError("GRANT_SUBSET_INVALID", "child mission actions exceed parent grant", { status: 400 });
    }
    const targets = input.scope.targets;
    if (!targets || typeof targets !== "object" || targets.kind !== (parent.targets.mode === "verified_discovery" ? "verified_discovery" : "fingerprint")) {
      throw new ControlPlaneError("GRANT_SUBSET_INVALID", "child mission targets exceed parent grant", { status: 400 });
    }
    if (parent.targets.mode === "explicit_fingerprints") {
      if (!Array.isArray(targets.values) || targets.values.some((target) => !parent.targets.values.includes(target))) {
        throw new ControlPlaneError("GRANT_SUBSET_INVALID", "child mission targets exceed parent grant", { status: 400 });
      }
    } else {
      const provenance = targets.provenance;
      const observedAt = Date.parse(provenance?.observedAt);
      if (!provenance || !Number.isFinite(observedAt) || this.now() - observedAt > SNAPSHOT_MAX_AGE_MS
        || provenance.accountFingerprint !== parent.accountFingerprint || !provenance.snapshotHash
        || !provenance.pageFingerprint || !provenance.observedTargetFingerprint || !provenance.identityEvidenceHash) {
        throw new ControlPlaneError("GRANT_SUBSET_INVALID", "verified discovery provenance is stale or incomplete", { status: 400 });
      }
    }
    const defaults = parent.budget.defaults;
    const maxima = parent.budget.maxima;
    const scope = {
      ...input.scope,
      totalCount: input.scope.totalCount ?? defaults.totalCount,
      perTargetCount: input.scope.perTargetCount ?? defaults.perTargetCount,
      frequency: { count: input.scope.frequency?.count ?? defaults.frequency.count, windowSeconds: input.scope.frequency?.windowSeconds ?? defaults.frequency.windowSeconds },
    };
    if (scope.totalCount > maxima.totalCount || scope.perTargetCount > maxima.perTargetCount
      || scope.frequency.count > maxima.frequency.count || scope.frequency.windowSeconds > maxima.frequency.windowSeconds) {
      throw new ControlPlaneError("GRANT_SUBSET_INVALID", "child mission budget exceeds parent grant", { status: 400 });
    }
    const childExpiry = Date.parse(input.validity?.expiresAt);
    if (!Number.isFinite(childExpiry) || (parentExpiry !== null && childExpiry > parentExpiry)) {
      throw new ControlPlaneError("GRANT_SUBSET_INVALID", "child mission expiry is invalid for parent grant", { status: 400 });
    }
    const policy = {
      ...input,
      issuer: { actorId: record.issuer.subject },
      scope,
      parentGrant: { grantId: record.grantId, grantHash: record.grantHash },
    };
    return this.createMission(policy, { parentGrantId: record.grantId, parentGrantHash: record.grantHash });
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
