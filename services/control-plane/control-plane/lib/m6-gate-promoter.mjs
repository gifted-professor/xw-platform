import { existsSync } from "node:fs";
import { join } from "node:path";

import { ControlPlaneError } from "./errors.mjs";
import { validateJsonSchema } from "./json-schema-validator.mjs";
import {
  loadEpochSchema,
  loadEpochSchemaV2,
  loadM6Gate,
  tombstoneAndWrite,
  writeImmutableJson,
} from "./m6-gate-loader.mjs";
import { loadGateIssuerAllowlist, verifyEpochProof } from "./m6-issuer-allowlist.mjs";
import {
  deriveEpochHashBySchema,
  deriveM6ActionEpochBindingHash,
  deriveM6EmergencyCloseAuthorizationHash,
} from "./m6-live-gate-v2.mjs";
import { canonicalJson, sha256 } from "./canonical.mjs";

function fail(code, message, details = {}) {
  throw new ControlPlaneError(code, message, { status: 409, details });
}

function locksHashForEpoch(epoch) {
  if (epoch.schemaId === "xw.m6-live-gate.v2") return epoch.lockSetRef?.sha256 || null;
  if (epoch.schemaId === "xw.m6-live-gate.v1") {
    return sha256(`xw.m6-locks.v1:${canonicalJson(epoch.lockHashes)}`);
  }
  return null;
}

function fenceFromEpoch(epoch, generation) {
  return {
    gateId: epoch.gateId,
    epochHash: epoch.epochHash,
    generation,
    mode: epoch.mode,
    purpose: epoch.schemaId === "xw.m6-live-gate.v2" ? epoch.purpose : null,
    allowlist: epoch.allowlist,
    expiresAt: epoch.expiresAt,
    releaseId: epoch.releaseId,
    sourceCommit: epoch.sourceCommit,
    locksHash: locksHashForEpoch(epoch),
  };
}

export function assertM6FileDbPointerConsistency({ loaded, fence, pointer }) {
  const tail = loaded?.chain?.[loaded.chain.length - 1] || null;
  const consistent = tail && fence && pointer
    && tail.epochHash === fence.epochHash
    && tail.epochHash === pointer.tailEpochHash
    && fence.generation === pointer.generation
    && pointer.chain?.[pointer.chain.length - 1] === tail.epochHash
    && tail.mode === fence.mode
    && (tail.schemaId === "xw.m6-live-gate.v2" ? tail.purpose : null) === fence.purpose
    && canonicalJson(tail.allowlist) === canonicalJson(fence.allowlist)
    && tail.expiresAt === fence.expiresAt
    && tail.releaseId === fence.releaseId
    && tail.sourceCommit === fence.sourceCommit
    && locksHashForEpoch(tail) === fence.locksHash;
  if (!consistent) fail("M6_GATE_TRIPLE_MISMATCH", "file chain, DB fence, and current pointer do not identify the same gate generation");
  return { ...fence };
}

export function promoteM6GateEpoch({
  state,
  m6Root,
  gateId,
  epoch,
  proof,
  issuerAllowlistPath = join(m6Root, "m6-gate", "issuer-keys.json"),
  promotedAt,
  emergencyClose = null,
  faultAfter = null,
} = {}) {
  if (!state || typeof state.getM6GateFence !== "function") fail("M6_GATE_PROMOTE_INPUT_INVALID", "StateStore v19 is required");
  if (!Number.isFinite(Date.parse(promotedAt || ""))) fail("M6_GATE_PROMOTE_INPUT_INVALID", "promotedAt must be an ISO date-time");
  const schema = epoch?.schemaId === "xw.m6-live-gate.v1"
    ? loadEpochSchema()
    : epoch?.schemaId === "xw.m6-live-gate.v2"
      ? loadEpochSchemaV2()
      : null;
  if (!schema) fail("M6_GATE_SCHEMA_UNKNOWN", "only exact v1/v2 epochs may be promoted");
  const schemaErrors = validateJsonSchema(epoch, schema);
  if (schemaErrors.length > 0 || deriveEpochHashBySchema(epoch) !== epoch.epochHash) {
    fail("M6_GATE_EPOCH_FORGED", `epoch is not schema-valid and self-hashed: ${schemaErrors.join("; ")}`);
  }
  const allowlist = loadGateIssuerAllowlist(issuerAllowlistPath);
  verifyEpochProof({ epoch, epochHash: epoch.epochHash, proof, allowlist });
  const current = loadM6Gate({ m6Root, gateId, issuerAllowlistPath, requireLocks: true });
  const fence = state.getM6GateFence();
  if (!fence) fail("M6_GATE_FENCE_UNSEEDED", "v19 M6 fence must be seeded before promotion");
  if (current.tailEpochHash !== fence.epochHash || epoch.parentEpochHash !== fence.epochHash) {
    fail("M6_GATE_FENCE_CAS_MISMATCH", "epoch parent, file tail, and DB fence do not agree");
  }
  let emergencyCloseConsumption = null;
  if (emergencyClose) {
    const parent = current.chain[current.chain.length - 1];
    const ref = parent?.emergencyCloseAuthorizationRef;
    const authorization = ref?.id ? current.emergencyCloseAuthorizations?.[ref.id] : null;
    const reasonCode = emergencyClose.reasonCode;
    if (epoch.mode !== "CLOSED" || parent?.schemaId !== "xw.m6-live-gate.v2" || parent.mode === "CLOSED"
      || !authorization || deriveM6EmergencyCloseAuthorizationHash(authorization) !== ref.sha256
      || authorization.authorizationHash !== ref.sha256
      || authorization.actionEpochBindingHash !== deriveM6ActionEpochBindingHash(parent)
      || authorization.expectedCurrentEpochHash !== parent.parentEpochHash
      || authorization.expectedParentEpochHash !== parent.parentEpochHash
      || authorization.operator !== epoch.actor
      || authorization.releaseId !== epoch.releaseId
      || !authorization.reasonCodeAllowlist?.includes(reasonCode)
      || Date.parse(authorization.expiresAt) <= Date.parse(promotedAt)) {
      fail("M6_GATE_EMERGENCY_CLOSE_INVALID", "emergency close is not covered by the active epoch authorization");
    }
    emergencyCloseConsumption = {
      nonce: authorization.nonce,
      authorizationHash: authorization.authorizationHash,
      reasonCode,
    };
  }
  const epochPath = join(m6Root, "m6-gate", gateId, "epochs", `${epoch.epochHash}.json`);
  if (existsSync(epochPath)) fail("M6_GATE_IMMUTABLE", "candidate epoch already exists");
  writeImmutableJson(epochPath, { ...epoch, proof });
  if (faultAfter === "immutableEpoch") fail("M6_GATE_PROMOTE_FAULT", "injected failure after immutable epoch append");
  const promotedFence = state.promoteM6GateFence({
    expectedEpochHash: fence.epochHash,
    expectedGeneration: fence.generation,
    next: fenceFromEpoch(epoch, fence.generation + 1),
    emergencyCloseConsumption,
  });
  if (faultAfter === "dbFence") fail("M6_GATE_PROMOTE_FAULT", "injected failure after DB fence commit");
  const chain = [...current.chain.map((entry) => entry.epochHash), epoch.epochHash];
  const pointer = {
    chain,
    tailEpochHash: epoch.epochHash,
    generation: promotedFence.generation,
    promotedAt,
  };
  tombstoneAndWrite(join(m6Root, "m6-gate", gateId, "current.json"), pointer);
  if (faultAfter === "pointer") fail("M6_GATE_PROMOTE_FAULT", "injected failure after current pointer commit");
  const loaded = loadM6Gate({ m6Root, gateId, issuerAllowlistPath, requireLocks: true });
  assertM6FileDbPointerConsistency({ loaded, fence: promotedFence, pointer });
  return { epochHash: epoch.epochHash, generation: promotedFence.generation, mode: epoch.mode, purpose: promotedFence.purpose };
}
