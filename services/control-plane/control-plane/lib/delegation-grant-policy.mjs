import { canonicalJson, fingerprint } from "./canonical.mjs";
import { ControlPlaneError } from "./errors.mjs";

const PRIMITIVES = new Set(["screenshot", "dump", "focus", "launch", "back", "home", "tap", "swipe", "input", "restore"]);
const SOCIAL = new Set(["follow", "like", "collect", "comment", "dm"]);
const MISSION_ONLY = new Set();
const PROHIBITED = new Set(["payment", "publish"]);
const PUBLIC_FIELDS = new Set(["alias", "fingerprint", "counts", "states", "evidenceHash"]);
const DISCOVERY_ANCHOR_RELATIONS = new Map([
  ["searchQueryHash", new Set(["search_result"])],
  ["seedIdentityFingerprint", new Set(["seed_profile_relation"])],
  ["contentContextHash", new Set(["content_author", "content_mentioned_profile"])],
  ["identityFingerprint", new Set(["explicit_target"])],
]);
const DISCOVERY_RELATIONS = new Set([...new Set([...DISCOVERY_ANCHOR_RELATIONS.values()].flatMap((items) => [...items]))]);
const DISCOVERY_LIMITS = Object.freeze({
  defaults: Object.freeze({ durationMs: 600000, maxPrimitives: 80, maxCandidates: 10 }),
  maxima: Object.freeze({ durationMs: 1800000, maxPrimitives: 300, maxCandidates: 50 }),
});
const HASH = /^[0-9a-f]{64}$/i;

function error(message) { throw new ControlPlaneError("GRANT_POLICY_INVALID", message, { status: 400 }); }
function object(value, name) { if (!value || typeof value !== "object" || Array.isArray(value)) error(`${name} must be an object`); return value; }
function text(value, name) { if (typeof value !== "string" || value.trim() === "") error(`${name} must be a non-empty string`); return value.trim(); }
function positive(value, name) { if (!Number.isInteger(value) || value < 1) error(`${name} must be positive`); return value; }
function values(value, name, allowed = null) {
  if (!Array.isArray(value) || value.length === 0) error(`${name} must be non-empty`);
  const result = value.map((item) => text(item, name));
  if (new Set(result).size !== result.length || (allowed && result.some((item) => !allowed.has(item)))) error(`${name} is invalid`);
  return result;
}
function keys(value, name, allowed) {
  const actual = Object.keys(value);
  if (actual.some((key) => !allowed.includes(key)) || allowed.some((key) => !actual.includes(key))) {
    error(`${name} has unknown or missing fields`);
  }
}
function optionalValues(value, name, allowed = null) {
  if (!Array.isArray(value)) error(`${name} must be an array`);
  if (value.length === 0) return [];
  return values(value, name, allowed);
}
function deepFreeze(value) { if (Array.isArray(value)) value.forEach(deepFreeze); else if (value && typeof value === "object") Object.values(value).forEach(deepFreeze); return Object.freeze(value); }
function hash(value, name) {
  const result = text(value, name);
  if (!HASH.test(result)) error(name + " must be a SHA-256 hex hash");
  return result.toLowerCase();
}
function limit(value, name) {
  const input = object(value, name);
  keys(input, name, ["durationMs", "maxPrimitives", "maxCandidates"]);
  return {
    durationMs: positive(input.durationMs, name + ".durationMs"),
    maxPrimitives: positive(input.maxPrimitives, name + ".maxPrimitives"),
    maxCandidates: positive(input.maxCandidates, name + ".maxCandidates"),
  };
}
function discoveryPolicy(value) {
  const input = object(value, "discoveryPolicy");
  keys(input, "discoveryPolicy", ["enabled", "allowedPrimitives", "defaults", "maxima", "maxParallelism", "targetScope", "identityPolicy", "clocks", "retention", "accessPolicy"]);
  if (typeof input.enabled !== "boolean") error("discoveryPolicy.enabled must be boolean");
  if (input.maxParallelism !== 1) throw new ControlPlaneError("PARALLELISM_UNSUPPORTED", "DiscoveryPolicy parallelism must be 1", { status: 400 });
  const defaults = limit(input.defaults, "discoveryPolicy.defaults");
  const maxima = limit(input.maxima, "discoveryPolicy.maxima");
  for (const key of Object.keys(DISCOVERY_LIMITS.maxima)) {
    if (defaults[key] !== DISCOVERY_LIMITS.defaults[key] || maxima[key] !== DISCOVERY_LIMITS.maxima[key]) error("discoveryPolicy defaults/maxima must match v1 limits");
  }
  const scope = object(input.targetScope, "discoveryPolicy.targetScope");
  keys(scope, "discoveryPolicy.targetScope", ["anchors", "relationKinds", "maxHops"]);
  if (scope.maxHops !== 1) error("discoveryPolicy.targetScope.maxHops must be 1");
  if (!Array.isArray(scope.anchors) || scope.anchors.length === 0) error("discoveryPolicy.targetScope.anchors must be non-empty");
  const anchors = scope.anchors.map((raw, index) => {
    const label = "discoveryPolicy.targetScope.anchors[" + index + "]";
    const item = object(raw, label);
    keys(item, label, ["type", "hash"]);
    const type = text(item.type, label + ".type");
    if (!DISCOVERY_ANCHOR_RELATIONS.has(type)) error("discoveryPolicy target anchor is invalid");
    return { type, hash: hash(item.hash, label + ".hash") };
  }).sort((left, right) => left.type.localeCompare(right.type) || left.hash.localeCompare(right.hash));
  if (new Set(anchors.map(({ type, hash: value }) => type + ":" + value)).size !== anchors.length) error("discoveryPolicy target anchors must be unique");
  const relationKinds = values(scope.relationKinds, "discoveryPolicy.targetScope.relationKinds", DISCOVERY_RELATIONS).sort();
  for (const relation of relationKinds) {
    if (!anchors.some(({ type }) => DISCOVERY_ANCHOR_RELATIONS.get(type).has(relation))) error("discoveryPolicy relation has no signed anchor");
  }
  for (const { type } of anchors) {
    if (!relationKinds.some((relation) => DISCOVERY_ANCHOR_RELATIONS.get(type).has(relation))) error("discoveryPolicy anchor has no allowed relation");
  }
  const identity = object(input.identityPolicy, "discoveryPolicy.identityPolicy");
  keys(identity, "discoveryPolicy.identityPolicy", ["stableUserId", "fallback", "onAmbiguity"]);
  if (identity.stableUserId !== "preferred" || identity.fallback !== "exact_nickname_avatar_profile_fingerprint" || identity.onAmbiguity !== "stop") error("discoveryPolicy identity policy is invalid");
  const clocks = object(input.clocks, "discoveryPolicy.clocks");
  keys(clocks, "discoveryPolicy.clocks", ["snapshotFreshnessMs", "observationCompileWindowMs"]);
  if (clocks.snapshotFreshnessMs !== 5000 || clocks.observationCompileWindowMs !== 60000) error("discoveryPolicy clocks are invalid");
  const retention = object(input.retention, "discoveryPolicy.retention");
  keys(retention, "discoveryPolicy.retention", ["rawScreenshotDays", "redactedHashAuditDays"]);
  if (retention.rawScreenshotDays !== 7 || retention.redactedHashAuditDays !== 90) error("discoveryPolicy retention is invalid");
  const accessPolicy = object(input.accessPolicy, "discoveryPolicy.accessPolicy");
  keys(accessPolicy, "discoveryPolicy.accessPolicy", ["ownerSubjectHash", "reviewerAllowlistVersion"]);
  return {
    enabled: input.enabled,
    allowedPrimitives: values(input.allowedPrimitives, "discoveryPolicy.allowedPrimitives", PRIMITIVES).sort(),
    defaults,
    maxima,
    maxParallelism: 1,
    targetScope: { anchors, relationKinds, maxHops: 1 },
    identityPolicy: { stableUserId: "preferred", fallback: "exact_nickname_avatar_profile_fingerprint", onAmbiguity: "stop" },
    clocks: { snapshotFreshnessMs: 5000, observationCompileWindowMs: 60000 },
    retention: { rawScreenshotDays: 7, redactedHashAuditDays: 90 },
    accessPolicy: { ownerSubjectHash: hash(accessPolicy.ownerSubjectHash, "discoveryPolicy.accessPolicy.ownerSubjectHash"), reviewerAllowlistVersion: positive(accessPolicy.reviewerAllowlistVersion, "discoveryPolicy.accessPolicy.reviewerAllowlistVersion") },
  };
}
function budget(value) {
  const input = object(value, "budget");
  keys(input, "budget", ["maxima", "defaults"]);
  const limit = (raw, name) => {
    const item = object(raw, name); keys(item, name, ["totalCount", "perTargetCount", "frequency"]);
    const frequency = object(item.frequency, `${name}.frequency`); keys(frequency, `${name}.frequency`, ["count", "windowSeconds"]);
    return { totalCount: positive(item.totalCount, `${name}.totalCount`), perTargetCount: positive(item.perTargetCount, `${name}.perTargetCount`), frequency: { count: positive(frequency.count, `${name}.frequency.count`), windowSeconds: positive(frequency.windowSeconds, `${name}.frequency.windowSeconds`) } };
  };
  const maxima = limit(input.maxima, "budget.maxima"); const defaults = limit(input.defaults, "budget.defaults");
  if (defaults.totalCount > maxima.totalCount || defaults.perTargetCount > maxima.perTargetCount || defaults.frequency.count > maxima.frequency.count || defaults.frequency.windowSeconds > maxima.frequency.windowSeconds) error("budget.defaults must not exceed maxima");
  return { maxima, defaults };
}

export function validateDelegationGrantDraft(input) {
  const draft = object(input, "grant");
  keys(draft, "grant", ["schemaVersion", "grantId", "issuanceNonce", "issuer", "app", "accountFingerprint", "controllers", "maxParallelism", "authorization", "targets", "budget", "discoveryPolicy", "validity", "redaction"]);
  if (draft.schemaVersion !== 1) error("schemaVersion must be 1");
  if (draft.maxParallelism !== 1) throw new ControlPlaneError("PARALLELISM_UNSUPPORTED", "Standing Grant parallelism must be 1", { status: 400 });
  const issuer = object(draft.issuer, "issuer");
  keys(issuer, "issuer", ["subject", "keyId"]);
  if (text(issuer.subject, "issuer.subject") !== "user:a1234") error("issuer.subject is not allowed");
  const authorization = object(draft.authorization, "authorization");
  keys(authorization, "authorization", ["primitives", "socialActions", "missionOnlyActions", "prohibitedActions"]);
  const prohibitedActions = values(authorization.prohibitedActions, "authorization.prohibitedActions", PROHIBITED);
  if (prohibitedActions.length !== 2 || !prohibitedActions.includes("payment") || !prohibitedActions.includes("publish")) error("payment and publish must remain prohibited");
  const targets = object(draft.targets, "targets");
  let normalizedTargets;
  if (targets.mode === "verified_discovery" && Object.keys(targets).length === 1) normalizedTargets = { mode: "verified_discovery" };
  else if (targets.mode === "explicit_fingerprints" && Object.keys(targets).every((key) => ["mode", "values"].includes(key))) normalizedTargets = { mode: "explicit_fingerprints", values: values(targets.values, "targets.values") };
  else error("targets must be one explicit mode");
  const validity = object(draft.validity, "validity");
  keys(validity, "validity", ["expiresAt"]);
  const expiresAt = validity.expiresAt == null ? null : text(validity.expiresAt, "validity.expiresAt");
  if (expiresAt !== null && !Number.isFinite(Date.parse(expiresAt))) error("validity.expiresAt must be ISO 8601 or null");
  const redaction = object(draft.redaction, "redaction");
  keys(redaction, "redaction", ["publicFields"]);
  return deepFreeze({ schemaVersion: 1, grantId: text(draft.grantId, "grantId"), issuanceNonce: text(draft.issuanceNonce, "issuanceNonce"), issuer: { subject: "user:a1234", keyId: text(issuer.keyId, "issuer.keyId") }, app: text(draft.app, "app"), accountFingerprint: text(draft.accountFingerprint, "accountFingerprint"), controllers: values(draft.controllers, "controllers"), maxParallelism: 1, authorization: { primitives: values(authorization.primitives, "authorization.primitives", PRIMITIVES), socialActions: values(authorization.socialActions, "authorization.socialActions", SOCIAL), missionOnlyActions: optionalValues(authorization.missionOnlyActions, "authorization.missionOnlyActions", MISSION_ONLY), prohibitedActions }, targets: normalizedTargets, budget: budget(draft.budget), discoveryPolicy: discoveryPolicy(draft.discoveryPolicy), validity: { expiresAt }, redaction: { publicFields: values(redaction.publicFields, "redaction.publicFields", PUBLIC_FIELDS) } });
}

export function delegationGrantContentHash(grant) { return fingerprint(validateDelegationGrantDraft(grant)); }
export function grantIssueSigningPayload({ subject, grantId, issuanceNonce, allowlistVersion, grantHash, grant }) {
  if (subject !== "user:a1234" || !Number.isInteger(allowlistVersion) || allowlistVersion < 1) error("invalid signing payload");
  return Object.freeze({ kind: "delegation_grant.issue.v1", subject, grantId: text(grantId, "grantId"), issuanceNonce: text(issuanceNonce, "issuanceNonce"), allowlistVersion, grantHash: text(grantHash, "grantHash"), grant: validateDelegationGrantDraft(grant) });
}
export function canonicalGrantIssueSigningBytes(input) { return canonicalJson(grantIssueSigningPayload(input)); }
