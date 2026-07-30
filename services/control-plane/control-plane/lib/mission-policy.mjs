import { canonicalJson, fingerprint } from "./canonical.mjs";
import { ControlPlaneError } from "./errors.mjs";

export const MISSION_SCHEMA_VERSION = 1;
export const SOCIAL_ACTIONS = new Set(["follow", "like", "collect", "comment", "dm"]);
export const RELEASEABLE_ACTIONS = new Set(["publish", "delete"]);
export const PROTECTED_ACTIONS = new Set(["payment", "publish", "delete"]);
export const SNAPSHOT_MAX_AGE_MS = 5 * 60 * 1000;

const ALLOWED_POLICY_KEYS = new Set(["publish", "delete", "payment"]);
const TARGET_KINDS = new Set(["fingerprint", "verified_discovery"]);

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepFreeze(value) {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
  } else if (isObject(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return Object.freeze(value);
}

function requireString(value, path) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ControlPlaneError("MISSION_POLICY_INVALID", `${path} must be a non-empty string`, { status: 400 });
  }
  return value.trim();
}

function requireStringArray(value, path) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ControlPlaneError("MISSION_POLICY_INVALID", `${path} must be a non-empty array`, { status: 400 });
  }
  const trimmed = [];
  for (const item of value) {
    if (typeof item !== "string" || item.trim() === "") {
      throw new ControlPlaneError("MISSION_POLICY_INVALID", `${path} must contain non-empty strings`, { status: 400 });
    }
    trimmed.push(item.trim());
  }
  if (new Set(trimmed).size !== trimmed.length) {
    throw new ControlPlaneError("MISSION_POLICY_INVALID", `${path} must not contain duplicates`, { status: 400 });
  }
  return trimmed;
}

function requirePositiveInteger(value, path) {
  if (!Number.isInteger(value) || value < 1) {
    throw new ControlPlaneError("MISSION_POLICY_INVALID", `${path} must be a positive integer`, { status: 400 });
  }
  return value;
}

function requireIsoTimestamp(value, path) {
  const text = requireString(value, path);
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) {
    throw new ControlPlaneError("MISSION_POLICY_INVALID", `${path} must be an ISO 8601 timestamp`, { status: 400 });
  }
  return { text, ms: parsed };
}

// Validate and normalize a Mission policy input. Returns a frozen canonical policy object
// safe to persist. Never accepts raw credentials or sensitive target text — targets are
// fingerprints (already-hashed anchors), so including them in the content hash is safe.
export function validateMissionPolicy(input) {
  if (!isObject(input)) {
    throw new ControlPlaneError("MISSION_POLICY_INVALID", "mission policy must be an object", { status: 400 });
  }
  if (input.schemaVersion !== undefined && input.schemaVersion !== MISSION_SCHEMA_VERSION) {
    throw new ControlPlaneError("MISSION_SCHEMA_VERSION", "unsupported mission schemaVersion", { status: 400 });
  }
  const issuer = input.issuer;
  if (!isObject(issuer)) {
    throw new ControlPlaneError("MISSION_POLICY_INVALID", "issuer must be an object", { status: 400 });
  }
  const issuerActorId = requireString(issuer.actorId, "issuer.actorId");

  const idempotencyKey = requireString(input.idempotencyKey, "idempotencyKey");
  const app = requireString(input.app, "app");
  const account = requireString(input.account, "account");
  let parentGrant = null;
  if (input.parentGrant !== undefined) {
    if (!isObject(input.parentGrant)) {
      throw new ControlPlaneError("MISSION_POLICY_INVALID", "parentGrant must be an object", { status: 400 });
    }
    parentGrant = {
      grantId: requireString(input.parentGrant.grantId, "parentGrant.grantId"),
      grantHash: requireString(input.parentGrant.grantHash, "parentGrant.grantHash"),
    };
  }
  let verifiedDiscovery = null;
  if (input.verifiedDiscovery !== undefined) {
    if (!parentGrant || !isObject(input.verifiedDiscovery)
      || Object.keys(input.verifiedDiscovery).some((key) => !["snapshotHash", "identityEvidenceHash"].includes(key))) {
      throw new ControlPlaneError("MISSION_POLICY_INVALID", "verifiedDiscovery is only an internal parent-grant record", { status: 400 });
    }
    verifiedDiscovery = {
      snapshotHash: requireString(input.verifiedDiscovery.snapshotHash, "verifiedDiscovery.snapshotHash"),
      identityEvidenceHash: requireString(input.verifiedDiscovery.identityEvidenceHash, "verifiedDiscovery.identityEvidenceHash"),
    };
  }

  const parallelism = input.parallelism ?? 1;
  if (!Number.isInteger(parallelism) || parallelism !== 1) {
    // MVP fixes a single device. Multi-device support requires a fresh design and revalidation.
    throw new ControlPlaneError("PARALLELISM_UNSUPPORTED", "parallelism must be 1 for the freedom MVP", {
      status: 400,
      details: { parallelism },
    });
  }

  const controllers = requireStringArray(input.controllers, "controllers");

  const scope = input.scope;
  if (!isObject(scope)) {
    throw new ControlPlaneError("MISSION_POLICY_INVALID", "scope must be an object", { status: 400 });
  }
  const actions = requireStringArray(scope.actions, "scope.actions");
  for (const action of actions) {
    if (PROTECTED_ACTIONS.has(action) && !RELEASEABLE_ACTIONS.has(action)) {
      // payment may never appear in scope.actions; publish/delete may, to release them.
      throw new ControlPlaneError(
        "ACTION_NOT_AUTHORIZABLE",
        `${action} cannot be declared inside scope.actions`,
        { status: 400, details: { action } },
      );
    }
  }
  const targets = scope.targets;
  if (!isObject(targets)) {
    throw new ControlPlaneError("MISSION_POLICY_INVALID", "scope.targets must be an object", { status: 400 });
  }
  if (!TARGET_KINDS.has(targets.kind)) {
    throw new ControlPlaneError("MISSION_POLICY_INVALID", "scope.targets.kind must be fingerprint", { status: 400 });
  }
  let normalizedTargets;
  if (targets.kind === "verified_discovery") {
    if (Object.keys(targets).some((key) => !["kind", "provenance"].includes(key))) {
      throw new ControlPlaneError("MISSION_POLICY_INVALID", "verified_discovery must not carry target values", { status: 400 });
    }
    let provenance;
    if (targets.provenance !== undefined) {
      if (!isObject(targets.provenance)) throw new ControlPlaneError("MISSION_POLICY_INVALID", "verified discovery provenance must be an object", { status: 400 });
      const observedAt = requireIsoTimestamp(targets.provenance.observedAt, "scope.targets.provenance.observedAt");
      provenance = {
        snapshotHash: requireString(targets.provenance.snapshotHash, "scope.targets.provenance.snapshotHash"),
        observedAt: observedAt.text,
        accountFingerprint: requireString(targets.provenance.accountFingerprint, "scope.targets.provenance.accountFingerprint"),
        pageFingerprint: requireString(targets.provenance.pageFingerprint, "scope.targets.provenance.pageFingerprint"),
        observedTargetFingerprint: requireString(targets.provenance.observedTargetFingerprint, "scope.targets.provenance.observedTargetFingerprint"),
        identityEvidenceHash: requireString(targets.provenance.identityEvidenceHash, "scope.targets.provenance.identityEvidenceHash"),
      };
    }
    normalizedTargets = { kind: "verified_discovery", ...(provenance ? { provenance } : {}) };
  } else {
    const targetValues = requireStringArray(targets.values, "scope.targets.values");
    normalizedTargets = { kind: "fingerprint", values: targetValues };
  }
  const totalCount = requirePositiveInteger(scope.totalCount, "scope.totalCount");
  const perTargetCount = requirePositiveInteger(scope.perTargetCount, "scope.perTargetCount");
  const frequency = scope.frequency;
  if (!isObject(frequency)) {
    throw new ControlPlaneError("MISSION_POLICY_INVALID", "scope.frequency must be an object", { status: 400 });
  }
  const freqCount = requirePositiveInteger(frequency.count, "scope.frequency.count");
  const freqWindow = requirePositiveInteger(frequency.windowSeconds, "scope.frequency.windowSeconds");

  const validity = input.validity;
  if (!isObject(validity)) {
    throw new ControlPlaneError("MISSION_POLICY_INVALID", "validity must be an object", { status: 400 });
  }
  const expiresAt = requireIsoTimestamp(validity.expiresAt, "validity.expiresAt");
  let notBefore = null;
  if (validity.notBefore !== undefined && validity.notBefore !== null) {
    notBefore = requireIsoTimestamp(validity.notBefore, "validity.notBefore");
  }

  const policy = input.policy || {};
  if (!isObject(policy)) {
    throw new ControlPlaneError("MISSION_POLICY_INVALID", "policy must be an object", { status: 400 });
  }
  for (const key of Object.keys(policy)) {
    if (!ALLOWED_POLICY_KEYS.has(key)) {
      throw new ControlPlaneError("MISSION_POLICY_INVALID", `unknown policy field ${key}`, { status: 400 });
    }
  }
  // payment is the one non-overridable permanent human commit gate.
  if (policy.payment !== undefined && policy.payment !== "confirm") {
    throw new ControlPlaneError(
      "PAYMENT_POLICY_INVALID",
      "payment is always confirm and can never be released",
      { status: 400, details: { payment: policy.payment } },
    );
  }
  const publish = normalizeReleaseFlag(policy.publish, "publish", actions);
  const deleteFlag = normalizeReleaseFlag(policy.delete, "delete", actions);

  const redactionInput = input.redaction || {};
  if (!isObject(redactionInput)) {
    throw new ControlPlaneError("MISSION_POLICY_INVALID", "redaction must be an object", { status: 400 });
  }
  const publicFields = Array.isArray(redactionInput.publicFields)
    ? requireStringArray(redactionInput.publicFields, "redaction.publicFields")
    : ["alias", "fingerprint", "counts", "states", "evidenceHash"];

  const normalized = {
    schemaVersion: MISSION_SCHEMA_VERSION,
    issuer: { actorId: issuerActorId },
    idempotencyKey,
    app,
    account,
    ...(parentGrant ? { parentGrant } : {}),
    ...(verifiedDiscovery ? { verifiedDiscovery } : {}),
    parallelism,
    controllers,
    scope: {
      actions,
      targets: normalizedTargets,
      totalCount,
      perTargetCount,
      frequency: { count: freqCount, windowSeconds: freqWindow },
    },
    validity: { expiresAt: expiresAt.text, ...(notBefore ? { notBefore: notBefore.text } : {}) },
    policy: { publish, delete: deleteFlag, payment: "confirm" },
    redaction: { publicFields },
  };
  return deepFreeze(normalized);
}

function normalizeReleaseFlag(value, name, scopeActions) {
  if (value === undefined || value === "confirm") return "confirm";
  if (value === "allow_within_scope") {
    // releasing publish/delete requires the action be declared in scope so the ECP
    // can scope-check it; otherwise the release is meaningless.
    if (!scopeActions.includes(name)) {
      throw new ControlPlaneError(
        "MISSION_POLICY_INVALID",
        `${name}=allow_within_scope requires ${name} in scope.actions`,
        { status: 400, details: { action: name } },
      );
    }
    return "allow_within_scope";
  }
  throw new ControlPlaneError("MISSION_POLICY_INVALID", `policy.${name} must be confirm or allow_within_scope`, {
    status: 400,
  });
}

// Deterministic content hash over the canonical policy. The same authenticated command
// always produces the same missionHash; a material scope expansion produces a new one.
export function missionContentHash(policy) {
  const { idempotencyKey, ...content } = policy;
  return fingerprint(content);
}

export function targetFingerprint(target) {
  if (target === null || target === undefined) return null;
  if (typeof target === "string") return target;
  if (isObject(target)) {
    if (typeof target.fingerprint === "string") return target.fingerprint;
    if (typeof target.target === "string") return target.target;
  }
  return null;
}

// Pure classification: authorization (scope/policy) only. Never inspects typed action IDs.
// Returns { decision, reason } where decision ∈ { ecp, phc, scope_violation, blocked }.
// Budget, readiness, lease, and page correctness are handled later by the ECP, not here.
export function evaluateMissionEffect(mission, { action, target }, { now = Date.now } = {}) {
  if (!isObject(mission)) {
    throw new ControlPlaneError("MISSION_POLICY_INVALID", "mission must be an object", { status: 400 });
  }
  if (typeof action !== "string" || action.trim() === "") {
    throw new ControlPlaneError("MISSION_POLICY_INVALID", "action is required", { status: 400 });
  }
  if (mission.status === "revoked") {
    return { decision: "blocked", reason: "MISSION_REVOKED" };
  }
  const expiresAtMs = Date.parse(mission.validity?.expiresAt);
  if (Number.isFinite(expiresAtMs) && now() >= expiresAtMs) {
    return { decision: "blocked", reason: "MISSION_EXPIRED" };
  }

  // payment is always the Protected Human Commit, regardless of scope declaration.
  if (action === "payment") {
    return { decision: "phc", reason: "PAYMENT_HUMAN_COMMIT" };
  }

  if (action === "publish") {
    if (mission.policy?.publish === "allow_within_scope") {
      return scopeOrTargetViolation(mission, action, target) ?? { decision: "ecp", reason: "PUBLISH_RELEASED" };
    }
    return { decision: "phc", reason: "PUBLISH_HUMAN_COMMIT" };
  }
  if (action === "delete") {
    if (mission.policy?.delete === "allow_within_scope") {
      return scopeOrTargetViolation(mission, action, target) ?? { decision: "ecp", reason: "DELETE_RELEASED" };
    }
    return { decision: "phc", reason: "DELETE_HUMAN_COMMIT" };
  }

  // social effects (follow/like/collect/comment/dm) and any other declared action
  if (!Array.isArray(mission.scope?.actions) || !mission.scope.actions.includes(action)) {
    return { decision: "scope_violation", reason: "ACTION_OUT_OF_SCOPE" };
  }
  return scopeOrTargetViolation(mission, action, target) ?? { decision: "ecp", reason: "IN_SCOPE_SOCIAL_EFFECT" };
}

function scopeOrTargetViolation(mission, action, target) {
  const fp = targetFingerprint(target);
  if (fp === null) return null;
  if (!mission.scope.targets.values.includes(fp)) {
    return { decision: "scope_violation", reason: "TARGET_OUT_OF_SCOPE" };
  }
  return null;
}

export { canonicalJson };
