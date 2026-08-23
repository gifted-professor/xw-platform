import { existsSync, readFileSync } from "node:fs";
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
  assertM6GateFSafetyCloseArmMatchesPackage,
  createM6GateFSafetyCloseLoadAuthority,
  deriveM6GateFSafetyCloseProofHash,
  validateM6GateFSafetyClosePackage,
} from "./m6-gate-safety-close-arm.mjs";
import {
  loadM64LiveWindowIssuerAllowlist,
  verifyM64LiveWindowAuthorization,
} from "./m6-live-window-authorization.mjs";
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

function verifyCandidateEnvelope({ epoch, proof, issuerAllowlistPath }) {
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
}

function assertExistingEpochMatches(epochPath, epoch, proof) {
  let existing;
  try {
    existing = JSON.parse(readFileSync(epochPath, "utf8"));
  } catch (cause) {
    fail("M6_GATE_RECONCILE_EPOCH_INVALID", "existing candidate epoch is unreadable or malformed", { cause: cause?.message ?? null });
  }
  if (canonicalJson(existing) !== canonicalJson({ ...epoch, proof })) {
    fail("M6_GATE_RECONCILE_EPOCH_MISMATCH", "existing immutable candidate differs from the signed reconcile input");
  }
}

function assertLiveWindowConsumption(state, authorization, generation) {
  const consumption = state.getM64LiveWindowAuthorizationConsumption?.(authorization.authorizationId);
  if (!consumption || consumption.authorizationId !== authorization.authorizationId
    || consumption.bodyHash !== authorization.bodyHash
    || consumption.envelopeHash !== authorization.envelopeHash
    || consumption.gateEpochHash !== authorization.gateEpochHash
    || consumption.gateGeneration !== generation) {
    fail("M64_LIVE_AUTH_CONSUMPTION_MISMATCH", "reconcile cannot prove the exact live-window authorization was atomically consumed");
  }
  return consumption;
}

function assertEmergencyConsumption(state, emergencyCloseConsumption) {
  const consumption = state.getM6EmergencyCloseConsumption?.(emergencyCloseConsumption.nonce);
  if (!consumption || consumption.authorizationHash !== emergencyCloseConsumption.authorizationHash
    || consumption.reasonCode !== emergencyCloseConsumption.reasonCode) {
    fail("M6_GATE_EMERGENCY_CLOSE_CONSUMPTION_MISMATCH", "reconcile cannot prove the exact emergency-close authorization was atomically consumed");
  }
  return consumption;
}

function assertSafetyCloseTerminalization(state, terminalization) {
  const arm = state.getM6GateSafetyCloseArm?.(terminalization.activeEpochHash);
  if (!arm || arm.packageHash !== terminalization.packageHash
    || arm.closeEpochHash !== terminalization.armCloseEpochHash
    || arm.status !== terminalization.status
    || arm.terminalEpochHash !== terminalization.terminalEpochHash
    || arm.terminalProofHash !== terminalization.terminalProofHash) {
    fail("M6_GATE_SAFETY_CLOSE_TERMINAL_MISMATCH", "reconcile cannot prove the exact safety-close arm was atomically terminalized");
  }
  return arm;
}

function executePromotion({
  state,
  m6Root,
  gateId,
  epoch,
  proof,
  issuerAllowlistPath = join(m6Root, "m6-gate", "issuer-keys.json"),
  promotedAt,
  emergencyClose = null,
  faultAfter = null,
  liveWindowAuthorization = null,
  liveWindowIssuerAllowlist = null,
  liveWindowIssuerAllowlistPath = join(m6Root, "m6-gate", "live-window-owner-keys.json"),
  liveWindowRuntime = null,
  safetyClosePackage = null,
  requireSafetyCloseArm = false,
}, { mode = "PROMOTE" } = {}) {
  const preflightOnly = mode === "PREFLIGHT";
  const reconcile = mode === "RECONCILE";
  if (!state || typeof state.getM6GateFence !== "function") fail("M6_GATE_PROMOTE_INPUT_INVALID", "StateStore v20 is required");
  if (!Number.isFinite(Date.parse(promotedAt || ""))) fail("M6_GATE_PROMOTE_INPUT_INVALID", "promotedAt must be an ISO date-time");
  const fence = state.getM6GateFence();
  if (!fence) fail("M6_GATE_FENCE_UNSEEDED", "v20 M6 fence must be seeded before promotion");
  const requestedEmergencyPackage = emergencyClose ? (safetyClosePackage || {
    authorization: null,
    epoch,
    operation: "EMERGENCY_CLOSE",
    phase: null,
    proof,
    reasonCode: emergencyClose.reasonCode,
  }) : null;
  const persistedSafetyArm = emergencyClose
    ? state.getM6GateSafetyCloseArm?.(epoch?.parentEpochHash)
    : null;
  const dbAlreadyClosed = fence.epochHash === epoch?.epochHash;
  const armedEmergencyClose = Boolean(persistedSafetyArm);
  const activationRecoveryArm = reconcile && !emergencyClose && dbAlreadyClosed
    ? state.getM6GateSafetyCloseArm?.(epoch?.epochHash)
    : null;
  if (armedEmergencyClose) {
    assertM6GateFSafetyCloseArmMatchesPackage(persistedSafetyArm, requestedEmergencyPackage, {
      allowStatuses: dbAlreadyClosed ? ["CONSUMED"] : ["ARMED"],
    });
  } else if (activationRecoveryArm) {
    assertM6GateFSafetyCloseArmMatchesPackage(activationRecoveryArm, safetyClosePackage, {
      allowStatuses: ["ARMED"],
    });
  } else {
    verifyCandidateEnvelope({ epoch, proof, issuerAllowlistPath });
  }
  const safetyCloseLoadAuthority = armedEmergencyClose
    ? createM6GateFSafetyCloseLoadAuthority(persistedSafetyArm, {
      allowStatuses: dbAlreadyClosed ? ["CONSUMED"] : ["ARMED"],
    })
    : activationRecoveryArm
      ? createM6GateFSafetyCloseLoadAuthority(activationRecoveryArm, {
        allowStatuses: ["ARMED"],
        activationRecovery: { epoch, proof },
      })
    : null;
  const current = loadM6Gate({
    m6Root,
    gateId,
    issuerAllowlistPath,
    requireLocks: true,
    safetyCloseLoadAuthority,
  });
  const pointer = current.currentPointer;
  const pointerHasCandidate = current.tailEpochHash === epoch.epochHash;
  const dbHasCandidate = fence.epochHash === epoch.epochHash;
  const pointerHasParent = current.tailEpochHash === epoch.parentEpochHash;
  const dbHasParent = fence.epochHash === epoch.parentEpochHash;
  const pointerGeneration = pointer?.generation;
  const fullyCurrent = pointerHasCandidate && dbHasCandidate && pointerGeneration === fence.generation;
  const dbAhead = pointerHasParent && dbHasCandidate && fence.generation === pointerGeneration + 1;
  const parentCurrent = pointerHasParent && dbHasParent && fence.generation === pointerGeneration;
  if ((!reconcile && !parentCurrent) || (reconcile && ![fullyCurrent, dbAhead, parentCurrent].some(Boolean))) {
    fail("M6_GATE_FENCE_CAS_MISMATCH", "candidate parent, file pointer, and DB fence are not a recoverable promotion state");
  }
  if (parentCurrent) assertM6FileDbPointerConsistency({ loaded: current, fence, pointer });
  const candidateGeneration = fullyCurrent || dbAhead ? fence.generation : fence.generation + 1;
  const nextFence = fenceFromEpoch(epoch, candidateGeneration);
  const parentEpoch = pointerHasCandidate ? current.chain.at(-2) : current.chain.at(-1);
  if (!parentEpoch || parentEpoch.epochHash !== epoch.parentEpochHash) {
    fail("M6_GATE_FENCE_CAS_MISMATCH", "candidate epoch does not append to the verified current chain");
  }
  let liveWindowAuthorizationConsumption = null;
  let verifiedSafetyCloseArm = null;
  if (epoch.schemaId === "xw.m6-live-gate.v2" && epoch.mode !== "CLOSED") {
    if (!liveWindowAuthorization || !liveWindowRuntime) {
      fail("M64_LIVE_AUTH_REQUIRED", "an exact signed live-window authorization and sealed runtime binding are required before v2 activation");
    }
    const lockSet = current.lockSets?.[epoch.lockSetRef?.id] || null;
    const emergencyAuthorization = current.emergencyCloseAuthorizations?.[epoch.emergencyCloseAuthorizationRef?.id] || null;
    const closeoutGraceMs = Date.parse(emergencyAuthorization?.expiresAt) - Date.parse(epoch.expiresAt);
    const emergencyMatchesCandidate = emergencyAuthorization
      && emergencyAuthorization.authorizationHash === epoch.emergencyCloseAuthorizationRef?.sha256
      && emergencyAuthorization.actionEpochBindingHash === deriveM6ActionEpochBindingHash(epoch)
      && emergencyAuthorization.expectedCurrentEpochHash === epoch.parentEpochHash
      && emergencyAuthorization.expectedParentEpochHash === epoch.parentEpochHash
      && emergencyAuthorization.releaseId === epoch.releaseId
      && emergencyAuthorization.alias === epoch.allowlist?.[0]
      && emergencyAuthorization.operator === epoch.actor
      && Number.isFinite(closeoutGraceMs)
      && closeoutGraceMs >= 30 * 60 * 1000;
    const runtimeMatchesCandidate = lockSet
      && lockSet.lockSetHash === epoch.lockSetRef?.sha256
      && emergencyMatchesCandidate
      && liveWindowRuntime.gateId === nextFence.gateId
      && liveWindowRuntime.gateEpochHash === nextFence.epochHash
      && liveWindowRuntime.gateGeneration === nextFence.generation
      && liveWindowRuntime.purpose === nextFence.purpose
      && liveWindowRuntime.releaseId === nextFence.releaseId
      && liveWindowRuntime.sourceCommit === nextFence.sourceCommit
      && liveWindowRuntime.locksHash === nextFence.locksHash
      && liveWindowRuntime.alias === "01"
      && canonicalJson(nextFence.allowlist) === canonicalJson([liveWindowRuntime.alias])
      && liveWindowRuntime.scenarioManifestHash === lockSet.lockHashes?.scenarioManifest
      && liveWindowRuntime.runtimeProfileHash === lockSet.lockHashes?.runtimeProfile
      && liveWindowRuntime.modelProfileHash === lockSet.lockHashes?.modelProfile
      && liveWindowRuntime.providerHash === lockSet.lockHashes?.liveProvider
      && liveWindowRuntime.toolProfileHash === lockSet.lockHashes?.liveToolSpec
      && liveWindowRuntime.policyHash === lockSet.lockHashes?.grantActionPolicy
      && liveWindowRuntime.emergencyCloseAuthorizationHash === emergencyAuthorization.authorizationHash
      && canonicalJson(liveWindowRuntime.emergencyCloseReasonCodeAllowlist) === canonicalJson(emergencyAuthorization.reasonCodeAllowlist)
      && liveWindowRuntime.closeoutGraceMs === closeoutGraceMs;
    if (!runtimeMatchesCandidate) {
      fail("M64_LIVE_AUTH_RUNTIME_BINDING_MISMATCH", "sealed runtime binding does not identify the candidate gate generation");
    }
    const priorConsumption = dbHasCandidate
      ? state.getM64LiveWindowAuthorizationConsumption?.(liveWindowAuthorization.authorizationId)
      : null;
    if (dbHasCandidate) {
      assertLiveWindowConsumption(state, liveWindowAuthorization, candidateGeneration);
      liveWindowAuthorizationConsumption = { authorization: liveWindowAuthorization, verification: null };
    } else {
      const ownerAllowlist = liveWindowIssuerAllowlist
        || loadM64LiveWindowIssuerAllowlist(liveWindowIssuerAllowlistPath);
      const verification = verifyM64LiveWindowAuthorization({
        authorization: liveWindowAuthorization,
        issuerAllowlist: ownerAllowlist,
        runtime: liveWindowRuntime,
        nowMs: state.now(),
      });
      liveWindowAuthorizationConsumption = { authorization: liveWindowAuthorization, verification };
    }
    if (safetyClosePackage) {
      verifiedSafetyCloseArm = validateM6GateFSafetyClosePackage({
        activationEpoch: epoch,
        activationProof: proof,
        emergencyAuthorization,
        safetyClosePackage,
        nowMs: dbHasCandidate
          ? Date.parse(state.getM6GateSafetyCloseArm?.(epoch.epochHash)?.armedAt ?? promotedAt)
          : Date.parse(promotedAt),
      });
      const existingArm = state.getM6GateSafetyCloseArm?.(epoch.epochHash);
      if (dbHasCandidate) {
        assertM6GateFSafetyCloseArmMatchesPackage(existingArm, safetyClosePackage, { allowStatuses: ["ARMED"] });
      } else {
        verifyCandidateEnvelope({
          epoch: safetyClosePackage.epoch,
          proof: safetyClosePackage.proof,
          issuerAllowlistPath,
        });
      }
    } else if (requireSafetyCloseArm) {
      fail("M6_GATE_SAFETY_CLOSE_REQUIRED", "FINAL activation requires an exact pre-signed safety-close package");
    }
  }
  let emergencyCloseConsumption = null;
  let safetyCloseArmTerminalization = null;
  if (emergencyClose) {
    const parent = parentEpoch;
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
      || (!armedEmergencyClose && Date.parse(authorization.expiresAt) <= (dbHasCandidate
        ? Date.parse(state.getM6EmergencyCloseConsumption?.(authorization.nonce)?.consumedAt ?? "")
        : Date.parse(promotedAt)))) {
      fail("M6_GATE_EMERGENCY_CLOSE_INVALID", "emergency close is not covered by the active epoch authorization");
    }
    emergencyCloseConsumption = {
      nonce: authorization.nonce,
      authorizationHash: authorization.authorizationHash,
      reasonCode,
    };
  }
  if (epoch.mode === "CLOSED") {
    const parentArm = state.getM6GateSafetyCloseArm?.(parentEpoch.epochHash);
    if (parentArm) {
      if (emergencyClose) {
        assertM6GateFSafetyCloseArmMatchesPackage(parentArm, requestedEmergencyPackage, {
          allowStatuses: dbHasCandidate ? ["CONSUMED"] : ["ARMED"],
        });
      } else if (parentArm.status !== (dbHasCandidate ? "RELEASED" : "ARMED")) {
        fail("M6_GATE_SAFETY_CLOSE_TERMINAL_MISMATCH", "normal close found a non-terminalizable safety-close arm");
      }
      safetyCloseArmTerminalization = {
        activeEpochHash: parentArm.activeEpochHash,
        armCloseEpochHash: parentArm.closeEpochHash,
        packageHash: parentArm.packageHash,
        terminalEpochHash: epoch.epochHash,
        terminalProofHash: emergencyClose ? null : deriveM6GateFSafetyCloseProofHash(proof),
        status: emergencyClose ? "CONSUMED" : "RELEASED",
      };
    } else if (emergencyClose && requireSafetyCloseArm) {
      fail("M6_GATE_SAFETY_CLOSE_ARM_MISSING", "FINAL emergency close requires the activation-time verified durable arm");
    }
  }
  const epochPath = join(m6Root, "m6-gate", gateId, "epochs", `${epoch.epochHash}.json`);
  const epochExists = existsSync(epochPath);
  if (epochExists && !reconcile) fail("M6_GATE_IMMUTABLE", "candidate epoch already exists");
  if (epochExists) assertExistingEpochMatches(epochPath, epoch, proof);
  if (preflightOnly) {
    return Object.freeze({
      schemaId: "xw.m6-gate-f-promotion-preflight.v1",
      candidateEpochHash: epoch.epochHash,
      expectedGeneration: candidateGeneration,
      currentEpochHash: fence.epochHash,
      currentGeneration: fence.generation,
      mode: epoch.mode,
      purpose: epoch.schemaId === "xw.m6-live-gate.v2" ? epoch.purpose : null,
      authorizationHash: liveWindowAuthorization?.envelopeHash ?? null,
      resourceCount: 0,
    });
  }
  if (!epochExists) writeImmutableJson(epochPath, { ...epoch, proof });
  if (faultAfter === "immutableEpoch") fail("M6_GATE_PROMOTE_FAULT", "injected failure after immutable epoch append");
  let promotedFence;
  if (dbHasCandidate) {
    promotedFence = fence;
    if (liveWindowAuthorizationConsumption) {
      assertLiveWindowConsumption(state, liveWindowAuthorization, candidateGeneration);
    }
    if (emergencyCloseConsumption) assertEmergencyConsumption(state, emergencyCloseConsumption);
    if (safetyCloseArmTerminalization) assertSafetyCloseTerminalization(state, safetyCloseArmTerminalization);
  } else {
    promotedFence = state.promoteM6GateFence({
      expectedEpochHash: fence.epochHash,
      expectedGeneration: fence.generation,
      next: nextFence,
      emergencyCloseConsumption,
      liveWindowAuthorizationConsumption,
      safetyCloseArm: verifiedSafetyCloseArm,
      safetyCloseArmTerminalization,
    });
  }
  if (faultAfter === "dbFence") fail("M6_GATE_PROMOTE_FAULT", "injected failure after DB fence commit");
  const chain = pointerHasCandidate
    ? current.chain.map((entry) => entry.epochHash)
    : [...current.chain.map((entry) => entry.epochHash), epoch.epochHash];
  const nextPointer = {
    chain,
    tailEpochHash: epoch.epochHash,
    generation: promotedFence.generation,
    promotedAt,
  };
  if (!pointerHasCandidate) tombstoneAndWrite(join(m6Root, "m6-gate", gateId, "current.json"), nextPointer);
  if (faultAfter === "pointer") fail("M6_GATE_PROMOTE_FAULT", "injected failure after current pointer commit");
  const finalSafetyCloseLoadAuthority = armedEmergencyClose
    ? createM6GateFSafetyCloseLoadAuthority(
      state.getM6GateSafetyCloseArm?.(epoch.parentEpochHash),
      { allowStatuses: ["CONSUMED"] },
    )
    : safetyCloseArmTerminalization?.status === "RELEASED"
      ? createM6GateFSafetyCloseLoadAuthority(
        state.getM6GateSafetyCloseArm?.(epoch.parentEpochHash),
        { allowStatuses: ["RELEASED"] },
      )
    : activationRecoveryArm
      ? createM6GateFSafetyCloseLoadAuthority(
        state.getM6GateSafetyCloseArm?.(epoch.epochHash),
        { allowStatuses: ["ARMED"] },
      )
    : null;
  const loaded = loadM6Gate({
    m6Root,
    gateId,
    issuerAllowlistPath,
    requireLocks: true,
    safetyCloseLoadAuthority: finalSafetyCloseLoadAuthority,
  });
  assertM6FileDbPointerConsistency({ loaded, fence: promotedFence, pointer: loaded.currentPointer });
  return {
    epochHash: epoch.epochHash,
    generation: promotedFence.generation,
    mode: epoch.mode,
    purpose: promotedFence.purpose,
    liveWindowAuthorizationHash: liveWindowAuthorization?.envelopeHash ?? null,
    reconciled: reconcile,
  };
}

export function preflightM6GateEpochPromotion(input = {}) {
  return executePromotion(input, { mode: "PREFLIGHT" });
}

export function promoteM6GateEpoch(input = {}) {
  return executePromotion(input, { mode: "PROMOTE" });
}

export function reconcileM6GateEpochPromotion(input = {}) {
  return executePromotion(input, { mode: "RECONCILE" });
}
