import { canonicalJson, fingerprint } from "./canonical.mjs";
import { ControlPlaneError } from "./errors.mjs";

const PRIMITIVES = new Set(["screenshot", "dump", "launch", "back", "home", "tap", "swipe", "input", "restore"]);
const SOCIAL = new Set(["follow", "like", "collect", "comment", "dm"]);
const MISSION_ONLY = new Set();
const PROHIBITED = new Set(["payment", "publish"]);
const PUBLIC_FIELDS = new Set(["alias", "fingerprint", "counts", "states", "evidenceHash"]);

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
  keys(draft, "grant", ["schemaVersion", "grantId", "issuanceNonce", "issuer", "app", "accountFingerprint", "controllers", "maxParallelism", "authorization", "targets", "budget", "validity", "redaction"]);
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
  return deepFreeze({ schemaVersion: 1, grantId: text(draft.grantId, "grantId"), issuanceNonce: text(draft.issuanceNonce, "issuanceNonce"), issuer: { subject: "user:a1234", keyId: text(issuer.keyId, "issuer.keyId") }, app: text(draft.app, "app"), accountFingerprint: text(draft.accountFingerprint, "accountFingerprint"), controllers: values(draft.controllers, "controllers"), maxParallelism: 1, authorization: { primitives: values(authorization.primitives, "authorization.primitives", PRIMITIVES), socialActions: values(authorization.socialActions, "authorization.socialActions", SOCIAL), missionOnlyActions: optionalValues(authorization.missionOnlyActions, "authorization.missionOnlyActions", MISSION_ONLY), prohibitedActions }, targets: normalizedTargets, budget: budget(draft.budget), validity: { expiresAt }, redaction: { publicFields: values(redaction.publicFields, "redaction.publicFields", PUBLIC_FIELDS) } });
}

export function delegationGrantContentHash(grant) { return fingerprint(validateDelegationGrantDraft(grant)); }
export function grantIssueSigningPayload({ subject, grantId, issuanceNonce, allowlistVersion, grantHash, grant }) {
  if (subject !== "user:a1234" || !Number.isInteger(allowlistVersion) || allowlistVersion < 1) error("invalid signing payload");
  return Object.freeze({ kind: "delegation_grant.issue.v1", subject, grantId: text(grantId, "grantId"), issuanceNonce: text(issuanceNonce, "issuanceNonce"), allowlistVersion, grantHash: text(grantHash, "grantHash"), grant: validateDelegationGrantDraft(grant) });
}
export function canonicalGrantIssueSigningBytes(input) { return canonicalJson(grantIssueSigningPayload(input)); }
