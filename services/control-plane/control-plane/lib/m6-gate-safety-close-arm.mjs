import { canonicalJson, sha256 } from "./canonical.mjs";
import { ControlPlaneError } from "./errors.mjs";
import {
  deriveM6ActionEpochBindingHash,
  deriveM6EmergencyCloseAuthorizationHash,
  deriveM6V2EpochHash,
} from "./m6-live-gate-v2.mjs";

const HASH = /^[0-9a-f]{64}$/u;
const PACKAGE_KEYS = Object.freeze(["authorization", "epoch", "operation", "phase", "proof", "reasonCode"]);
const PROOF_KEYS = Object.freeze(["algorithm", "allowlistVersion", "keyId", "signature", "subject"]);
const SAFETY_CLOSE_LOAD_AUTHORITY = Symbol("m6-gate-safety-close-load-authority");

function fail(code, message) {
  throw new ControlPlaneError(code, message, { status: 409 });
}

function hasExactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort());
}

export function deriveM6GateFSafetyClosePackageHash(value) {
  return sha256(`xw.m6-gate-f-safety-close-package.v1:${canonicalJson(value)}`);
}

export function deriveM6GateFSafetyCloseProofHash(proof) {
  return sha256(`xw.m6-gate-f-safety-close-proof.v1:${canonicalJson(proof)}`);
}

// This helper validates the immutable semantic binding. Signature verification is
// deliberately performed by m6-gate-promoter against the configured public-key
// allowlist before this exact record may be armed in StateStore.
export function validateM6GateFSafetyClosePackage({
  activationEpoch,
  activationProof,
  emergencyAuthorization,
  safetyClosePackage,
  nowMs,
} = {}) {
  if (!hasExactKeys(activationProof, PROOF_KEYS)
    || !hasExactKeys(safetyClosePackage, PACKAGE_KEYS)
    || safetyClosePackage.operation !== "EMERGENCY_CLOSE"
    || safetyClosePackage.authorization !== null
    || safetyClosePackage.phase !== null
    || typeof safetyClosePackage.reasonCode !== "string"
    || !/^[A-Z][A-Z0-9_]{2,63}$/u.test(safetyClosePackage.reasonCode)
    || !hasExactKeys(safetyClosePackage.proof, PROOF_KEYS)) {
    fail("M6_GATE_SAFETY_CLOSE_PACKAGE_INVALID", "safety-close package is not the exact emergency-close envelope");
  }
  const closeEpoch = safetyClosePackage.epoch;
  const activationRef = activationEpoch?.emergencyCloseAuthorizationRef;
  if (!activationEpoch || activationEpoch.schemaId !== "xw.m6-live-gate.v2"
    || activationEpoch.mode === "CLOSED" || activationEpoch.status !== "active"
    || !closeEpoch || closeEpoch.schemaId !== "xw.m6-live-gate.v2"
    || closeEpoch.mode !== "CLOSED" || closeEpoch.status !== "closed"
    || deriveM6V2EpochHash(closeEpoch) !== closeEpoch.epochHash
    || closeEpoch.parentEpochHash !== activationEpoch.epochHash
    || closeEpoch.gateId !== activationEpoch.gateId
    || closeEpoch.purpose !== activationEpoch.purpose
    || closeEpoch.releaseId !== activationEpoch.releaseId
    || closeEpoch.sourceCommit !== activationEpoch.sourceCommit
    || closeEpoch.actor !== activationEpoch.actor
    || canonicalJson(closeEpoch.lockSetRef) !== canonicalJson(activationEpoch.lockSetRef)
    || canonicalJson(closeEpoch.allowlist) !== canonicalJson(activationEpoch.allowlist)
    || closeEpoch.emergencyCloseAuthorizationRef !== null
    || !closeEpoch.closeoutRef || !closeEpoch.aggregateSealRef
    || closeEpoch.rollbackTargetEpochHash !== null) {
    fail("M6_GATE_SAFETY_CLOSE_BINDING_MISMATCH", "safety-close epoch is not the exact CLOSED child of the activation epoch");
  }
  if (!emergencyAuthorization
    || emergencyAuthorization.authorizationId !== activationRef?.id
    || emergencyAuthorization.authorizationHash !== activationRef?.sha256
    || deriveM6EmergencyCloseAuthorizationHash(emergencyAuthorization) !== emergencyAuthorization.authorizationHash
    || emergencyAuthorization.actionEpochBindingHash !== deriveM6ActionEpochBindingHash(activationEpoch)
    || emergencyAuthorization.expectedCurrentEpochHash !== activationEpoch.parentEpochHash
    || emergencyAuthorization.expectedParentEpochHash !== activationEpoch.parentEpochHash
    || emergencyAuthorization.releaseId !== activationEpoch.releaseId
    || emergencyAuthorization.alias !== activationEpoch.allowlist?.[0]
    || emergencyAuthorization.operator !== activationEpoch.actor
    || !emergencyAuthorization.reasonCodeAllowlist?.includes(safetyClosePackage.reasonCode)) {
    fail("M6_GATE_SAFETY_CLOSE_AUTHORIZATION_MISMATCH", "safety-close package is outside the activation emergency authorization");
  }
  const authorizationExpiresAtMs = Date.parse(emergencyAuthorization.expiresAt ?? "");
  const packageIssuedAtMs = Date.parse(closeEpoch.issuedAt ?? "");
  const packageExpiresAtMs = Date.parse(closeEpoch.expiresAt ?? "");
  const expiresAtMs = Math.min(authorizationExpiresAtMs, packageExpiresAtMs);
  if (!Number.isFinite(authorizationExpiresAtMs) || !Number.isFinite(packageIssuedAtMs)
    || !Number.isFinite(packageExpiresAtMs) || !Number.isFinite(nowMs)
    || packageIssuedAtMs > nowMs || packageExpiresAtMs <= packageIssuedAtMs || expiresAtMs <= nowMs) {
    fail("M6_GATE_SAFETY_CLOSE_EXPIRED", "safety-close package or its emergency authorization is expired");
  }
  return Object.freeze({
    schemaId: "xw.m6-gate-safety-close-arm.v1",
    gateId: activationEpoch.gateId,
    purpose: activationEpoch.purpose,
    activeEpochHash: activationEpoch.epochHash,
    closeEpochHash: closeEpoch.epochHash,
    packageHash: deriveM6GateFSafetyClosePackageHash(safetyClosePackage),
    activationProofHash: deriveM6GateFSafetyCloseProofHash(activationProof),
    proofHash: deriveM6GateFSafetyCloseProofHash(safetyClosePackage.proof),
    reasonCode: safetyClosePackage.reasonCode,
    expiresAtMs,
    authorizationExpiresAtMs,
    packageExpiresAtMs,
    package: safetyClosePackage,
  });
}

export function assertM6GateFSafetyCloseArmMatchesPackage(arm, safetyClosePackage, {
  allowStatuses = ["ARMED"],
  nowMs = null,
} = {}) {
  if (!arm || !allowStatuses.includes(arm.status)
    || !HASH.test(arm.activeEpochHash ?? "") || !HASH.test(arm.closeEpochHash ?? "")
    || !HASH.test(arm.activationProofHash ?? "") || !HASH.test(arm.proofHash ?? "")
    || arm.packageHash !== deriveM6GateFSafetyClosePackageHash(safetyClosePackage)
    || arm.proofHash !== deriveM6GateFSafetyCloseProofHash(safetyClosePackage?.proof)
    || arm.closeEpochHash !== safetyClosePackage?.epoch?.epochHash
    || arm.activeEpochHash !== safetyClosePackage?.epoch?.parentEpochHash
    || arm.reasonCode !== safetyClosePackage?.reasonCode
    || canonicalJson(arm.package) !== canonicalJson(safetyClosePackage)) {
    fail("M6_GATE_SAFETY_CLOSE_ARM_MISMATCH", "requested emergency close is not the exact activation-time verified arm");
  }
  if (Number.isFinite(nowMs) && Date.parse(arm.expiresAt ?? "") <= nowMs) {
    fail("M6_GATE_SAFETY_CLOSE_EXPIRED", "activation-time verified safety-close arm is expired");
  }
  return arm;
}

export function createM6GateFSafetyCloseLoadAuthority(arm, {
  nowMs = null,
  allowStatuses = ["ARMED", "CONSUMED"],
  activationRecovery = null,
} = {}) {
  assertM6GateFSafetyCloseArmMatchesPackage(arm, arm?.package, { allowStatuses, nowMs });
  if (["CONSUMED", "RELEASED"].includes(arm.status) && !HASH.test(arm.terminalEpochHash ?? "")) {
    fail("M6_GATE_SAFETY_CLOSE_TERMINAL_MISMATCH", "terminal safety-close arm does not bind a CLOSED epoch");
  }
  if ((arm.status === "RELEASED" && !HASH.test(arm.terminalProofHash ?? ""))
    || (arm.status === "CONSUMED" && arm.terminalProofHash !== null)) {
    fail("M6_GATE_SAFETY_CLOSE_TERMINAL_MISMATCH", "terminal safety-close arm has an invalid terminal proof binding");
  }
  let recoveryParentEpochHash = null;
  if (activationRecovery !== null) {
    const recoveryEpoch = activationRecovery?.epoch;
    const recoveryProof = activationRecovery?.proof;
    if (arm.status !== "ARMED"
      || recoveryEpoch?.schemaId !== "xw.m6-live-gate.v2"
      || recoveryEpoch?.mode === "CLOSED" || recoveryEpoch?.status !== "active"
      || deriveM6V2EpochHash(recoveryEpoch) !== recoveryEpoch?.epochHash
      || recoveryEpoch.epochHash !== arm.activeEpochHash
      || recoveryEpoch.gateId !== arm.gateId
      || recoveryEpoch.purpose !== arm.purpose
      || !HASH.test(recoveryEpoch.parentEpochHash ?? "")
      || deriveM6GateFSafetyCloseProofHash(recoveryProof) !== arm.activationProofHash) {
      fail("M6_GATE_SAFETY_CLOSE_RECOVERY_MISMATCH", "activation recovery is not bound to the atomically armed epoch and proof");
    }
    recoveryParentEpochHash = recoveryEpoch.parentEpochHash;
  }
  return Object.freeze({
    [SAFETY_CLOSE_LOAD_AUTHORITY]: true,
    activeEpochHash: arm.activeEpochHash,
    closeEpochHash: arm.closeEpochHash,
    activationProofHash: arm.activationProofHash,
    closeProofHash: arm.proofHash,
    terminalEpochHash: arm.terminalEpochHash ?? null,
    terminalProofHash: arm.terminalProofHash ?? null,
    recoveryParentEpochHash,
    status: arm.status,
  });
}

export function isM6GateFSafetyCloseLoadAuthority(value) {
  return Boolean(value?.[SAFETY_CLOSE_LOAD_AUTHORITY] === true);
}
