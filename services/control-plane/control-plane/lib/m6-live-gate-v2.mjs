import { canonicalJson, sha256 } from "./canonical.mjs";
import {
  deriveM6EpochHash,
  evaluateM6Gate,
  resolveM6AggregateSeal,
  resolveM6Closeout,
} from "./m6-live-gate.mjs";

export const M6_GATE_V2_SCHEMA_ID = "xw.m6-live-gate.v2";
export const M6_LOCKS_V2_SCHEMA_ID = "xw.m6-locks.v2";
export const M6_GATE_V2_MODES = Object.freeze(["CLOSED", "OBSERVE_ONLY", "GROUNDED_ACTION"]);
export const M6_GATE_V2_PURPOSES = Object.freeze([
  "M6_4_SHADOW",
  "M6_4_HOT_CLOSE",
  "M6_4_ACTION_SMOKE",
  "M6_4_RELIABILITY",
  "M6_4_SMOOTH",
  "M6_4_CLOSEOUT",
]);
export const M6_GATE_V2_LOCK_KINDS = Object.freeze([
  "runtimeProfile", "hardRedlinePolicy", "groundingRuntime",
  "dshSource", "dshProfile", "liveToolSpec", "modelProfile",
  "liveProvider", "grantActionPolicy", "brokerProtocol",
  "typedTransport", "scenarioManifest",
]);

const HEX64 = /^[0-9a-f]{64}$/;

export function deriveM6V2EpochHash(epoch) {
  if (!epoch || typeof epoch !== "object") return null;
  const { epochHash: _ignored, ...payload } = epoch;
  return sha256(`xw.m6-live-gate.v2:${canonicalJson(payload)}`);
}

export function deriveM6V2LockSetHash(lockSet) {
  if (!lockSet || typeof lockSet !== "object") return null;
  const { lockSetHash: _ignored, ...payload } = lockSet;
  return sha256(`xw.m6-locks.v2:${canonicalJson(payload)}`);
}

export function deriveM6EmergencyCloseAuthorizationHash(authorization) {
  if (!authorization || typeof authorization !== "object") return null;
  const { authorizationHash: _ignored, ...payload } = authorization;
  return sha256(`xw.m6-emergency-close-authorization.v1:${canonicalJson(payload)}`);
}

export function deriveM6ActionEpochBindingHash(epoch) {
  if (!epoch || typeof epoch !== "object") return null;
  const {
    epochHash: _ignoredEpochHash,
    emergencyCloseAuthorizationRef: _ignoredEmergencyRef,
    ...payload
  } = epoch;
  return sha256(`xw.m6-live-gate.v2:action-binding:${canonicalJson(payload)}`);
}

function closed(code, message, activeEpoch = null) {
  return {
    mode: "CLOSED",
    purpose: null,
    activeEpochHash: activeEpoch?.epochHash || null,
    activeEpoch,
    errors: [{ code, message }],
  };
}

function validRef(ref) {
  return Boolean(ref && typeof ref === "object" && typeof ref.id === "string" && ref.id && HEX64.test(ref.sha256 || ""));
}

function resolveRecord(ref, records) {
  if (!validRef(ref)) return null;
  const record = records?.[ref.id];
  if (!record || typeof record !== "object") return null;
  return record;
}

function evaluateV2Epoch(epoch, {
  nowMs,
  expectedRelease,
  lockSets,
  emergencyCloseAuthorizations,
  closeouts,
  aggregates,
  priorHash,
  index,
}) {
  if (deriveM6V2EpochHash(epoch) !== epoch.epochHash) return closed("M6_GATE_EPOCH_FORGED", `v2 epoch ${index} self-hash mismatch`);
  if (!M6_GATE_V2_MODES.includes(epoch.mode)) return closed("M6_GATE_MODE_INVALID", `v2 epoch ${index} has unknown mode`);
  if (!M6_GATE_V2_PURPOSES.includes(epoch.purpose)) return closed("M6_GATE_PURPOSE_INVALID", `v2 epoch ${index} has unknown purpose`);
  if (epoch.parentEpochHash !== priorHash) return closed("M6_GATE_PARENT_MISMATCH", `v2 epoch ${index} parent mismatch`);
  if (expectedRelease && (epoch.releaseId !== expectedRelease.releaseId || epoch.sourceCommit !== expectedRelease.sourceCommit)) {
    return closed("M6_GATE_RELEASE_MISMATCH", `v2 epoch ${index} release mismatch`);
  }
  const expiresAt = Date.parse(epoch.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) return closed("M6_GATE_EXPIRED", `v2 epoch ${index} is expired`);
  if (!Array.isArray(epoch.allowlist) || epoch.allowlist.length === 0 || new Set(epoch.allowlist).size !== epoch.allowlist.length) {
    return closed("M6_GATE_ALLOWLIST_INVALID", `v2 epoch ${index} allowlist invalid`);
  }
  if (epoch.mode === "GROUNDED_ACTION" && (epoch.allowlist.length !== 1 || epoch.allowlist[0] !== "01")) {
    return closed("M6_GATE_ACTION_ALLOWLIST_INVALID", "M6-4 GROUNDED_ACTION allowlist must be exactly alias 01");
  }
  const lockSet = resolveRecord(epoch.lockSetRef, lockSets);
  if (!lockSet || lockSet.schemaId !== M6_LOCKS_V2_SCHEMA_ID || deriveM6V2LockSetHash(lockSet) !== lockSet.lockSetHash
    || lockSet.lockSetHash !== epoch.lockSetRef.sha256) {
    return closed("M6_GATE_LOCK_MISMATCH", `v2 epoch ${index} lock set is absent or forged`);
  }
  if (M6_GATE_V2_LOCK_KINDS.some((kind) => !HEX64.test(lockSet.lockHashes?.[kind] || ""))) {
    return closed("M6_GATE_LOCK_MISMATCH", `v2 epoch ${index} lock set is incomplete`);
  }
  if (epoch.mode === "CLOSED") {
    if (epoch.status !== "closed" || !validRef(epoch.closeoutRef) || !validRef(epoch.aggregateSealRef)
      || epoch.emergencyCloseAuthorizationRef !== null) {
      return closed("M6_GATE_CLOSEOUT_FORGED", `v2 CLOSED epoch ${index} seal bindings invalid`);
    }
    const closeout = resolveM6Closeout(epoch.closeoutRef, closeouts);
    const aggregate = resolveM6AggregateSeal(epoch.aggregateSealRef, aggregates);
    if (!closeout.ok || !aggregate.ok || aggregate.aggregate.epochHash !== closeout.closeout.epochHash) {
      return closed("M6_GATE_CLOSEOUT_FORGED", `v2 CLOSED epoch ${index} closeout or aggregate is absent, forged, or cross-bound`);
    }
  } else {
    if (epoch.status !== "active" || epoch.closeoutRef !== null || epoch.aggregateSealRef !== null
      || epoch.rollbackTargetEpochHash !== null) {
      return closed("M6_GATE_EPOCH_FORGED", `v2 active epoch ${index} carries CLOSED-only fields`);
    }
    const emergency = resolveRecord(epoch.emergencyCloseAuthorizationRef, emergencyCloseAuthorizations);
    if (!emergency || emergency.authorizationHash !== epoch.emergencyCloseAuthorizationRef.sha256
      || deriveM6EmergencyCloseAuthorizationHash(emergency) !== emergency.authorizationHash
      || emergency.actionEpochBindingHash !== deriveM6ActionEpochBindingHash(epoch)
      || emergency.expectedCurrentEpochHash !== epoch.parentEpochHash
      || emergency.expectedParentEpochHash !== epoch.parentEpochHash
      || emergency.releaseId !== epoch.releaseId
      || emergency.alias !== epoch.allowlist[0]
      || !Number.isFinite(Date.parse(emergency.expiresAt))
      || Date.parse(emergency.expiresAt) < expiresAt + 30 * 60 * 1000) {
      return closed("M6_GATE_EMERGENCY_CLOSE_INVALID", `v2 active epoch ${index} lacks covering emergency-close authorization`);
    }
  }
  return null;
}

export function evaluateM6MixedGate({
  chain = [],
  closeouts = {},
  aggregates = {},
  lockSets = {},
  emergencyCloseAuthorizations = {},
  nowMs,
  expectedRelease = null,
  v1LockHashes = null,
} = {}) {
  if (!Number.isFinite(nowMs)) return closed("M6_GATE_CLOCK_INVALID", "mixed gate evaluation requires nowMs");
  if (!Array.isArray(chain) || chain.length === 0) return closed("M6_GATE_EMPTY", "mixed gate chain is empty");
  const firstV2 = chain.findIndex((epoch) => epoch?.schemaId === M6_GATE_V2_SCHEMA_ID);
  if (chain.some((epoch) => !["xw.m6-live-gate.v1", M6_GATE_V2_SCHEMA_ID].includes(epoch?.schemaId))) {
    return closed("M6_GATE_SCHEMA_UNKNOWN", "mixed gate chain contains an unknown schemaId");
  }
  if (firstV2 >= 0 && chain.slice(firstV2 + 1).some((epoch) => epoch.schemaId === "xw.m6-live-gate.v1")) {
    return closed("M6_GATE_SCHEMA_DOWNGRADE", "v1 epoch may not follow a v2 epoch");
  }
  const v1Prefix = firstV2 < 0 ? chain : chain.slice(0, firstV2);
  if (v1Prefix.length > 0) {
    const v1 = evaluateM6Gate({ chain: v1Prefix, closeouts, aggregates, nowMs, expectedRelease, lockHashes: v1LockHashes });
    if (v1.errors.length > 0) return { ...v1, purpose: null };
  }
  if (firstV2 < 0) {
    const v1 = evaluateM6Gate({ chain, closeouts, aggregates, nowMs, expectedRelease, lockHashes: v1LockHashes });
    return { ...v1, purpose: null };
  }
  let priorHash = firstV2 === 0 ? null : chain[firstV2 - 1].epochHash;
  for (let index = firstV2; index < chain.length; index += 1) {
    const epoch = chain[index];
    const failure = evaluateV2Epoch(epoch, {
      nowMs,
      expectedRelease,
      lockSets,
      emergencyCloseAuthorizations,
      closeouts,
      aggregates,
      priorHash,
      index,
    });
    if (failure) return failure;
    priorHash = epoch.epochHash;
  }
  const activeEpoch = chain[chain.length - 1];
  return {
    mode: activeEpoch.mode === "CLOSED" ? "CLOSED" : activeEpoch.mode,
    purpose: activeEpoch.purpose,
    activeEpochHash: activeEpoch.epochHash,
    activeEpoch,
    errors: [],
  };
}

export function deriveEpochHashBySchema(epoch) {
  if (epoch?.schemaId === "xw.m6-live-gate.v1") return deriveM6EpochHash(epoch);
  if (epoch?.schemaId === M6_GATE_V2_SCHEMA_ID) return deriveM6V2EpochHash(epoch);
  return null;
}
