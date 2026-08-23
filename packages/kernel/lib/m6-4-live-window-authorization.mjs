import { createHash } from "node:crypto";

export const M64_LIVE_WINDOW_AUTHORIZATION_SCHEMA_ID = "xw.m6-4-live-window-authorization.v1";
export const M64_LIVE_WINDOW_AUTHORIZATION_SIGNATURE_ALGORITHM = "ed25519";

export const M64_LIVE_WINDOW_RUNTIME_BINDING_FIELDS = Object.freeze([
  "alias",
  "releaseId",
  "releaseHash",
  "sourceCommit",
  "gateId",
  "gateEpochHash",
  "gateGeneration",
  "purpose",
  "scenarioManifestHash",
  "runtimeProfileHash",
  "modelProfileHash",
  "providerHash",
  "toolProfileHash",
  "policyHash",
  "locksHash",
  "environmentAttestationHash",
  "operatorHash",
  "emergencyCloseAuthorizationHash",
  "emergencyCloseReasonCodeAllowlist",
  "closeoutGraceMs",
  "effectBoundary",
  "independentOracleHash",
  "resetObligationsHash",
]);

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalM64LiveWindowAuthorizationBody(authorization) {
  if (!authorization || typeof authorization !== "object" || Array.isArray(authorization)) return null;
  const {
    bodyHash: _ignoredBodyHash,
    signature: _ignoredSignature,
    envelopeHash: _ignoredEnvelopeHash,
    ...body
  } = authorization;
  return body;
}

export function canonicalM64LiveWindowAuthorizationSigningBytes(authorization) {
  const body = canonicalM64LiveWindowAuthorizationBody(authorization);
  if (!body) return null;
  return Buffer.from(`${M64_LIVE_WINDOW_AUTHORIZATION_SCHEMA_ID}:${canonical(body)}`, "utf8");
}

export function deriveM64LiveWindowAuthorizationBodyHash(authorization) {
  const bytes = canonicalM64LiveWindowAuthorizationSigningBytes(authorization);
  return bytes ? sha256(bytes) : null;
}

export function deriveM64LiveWindowAuthorizationEnvelopeHash(authorization) {
  if (!authorization || typeof authorization !== "object" || Array.isArray(authorization)) return null;
  const { envelopeHash: _ignoredEnvelopeHash, ...envelope } = authorization;
  return sha256(`${M64_LIVE_WINDOW_AUTHORIZATION_SCHEMA_ID}:envelope:${canonical(envelope)}`);
}

export function selectM64LiveWindowRuntimeBinding(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return Object.fromEntries(M64_LIVE_WINDOW_RUNTIME_BINDING_FIELDS.map((field) => [field, value[field]]));
}

export function equalM64LiveWindowRuntimeBinding(authorization, runtime) {
  const left = selectM64LiveWindowRuntimeBinding(authorization);
  const right = selectM64LiveWindowRuntimeBinding(runtime);
  return left !== null && right !== null && canonical(left) === canonical(right);
}
