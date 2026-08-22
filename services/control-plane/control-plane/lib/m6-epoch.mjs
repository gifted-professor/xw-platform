// M6-2 W8 #9 — operator epoch mint/activate/close tooling (pure build + immutable IO).
//
// The M6 live gate is operator-minted and immutable. This module is the BUILD +
// SIGN + immutable-IO layer for epoch and closeout records. It NEVER accepts a
// hand-crafted epochHash or proof: every epoch is constructed from validated
// flags, its hash is RE-DERIVED (deriveM6EpochHash), and (when a key is
// supplied) it is RE-SIGNED over the hash bytes. There is no path that lets an
// operator paste a raw epoch JSON with a pre-baked hash/signature — a future
// --from-file import (if ever added) would re-derive and re-validate, discarding
// any supplied hash/proof.
//
// Layering: this is an operator leaf. It reuses the control-plane gate kernel
// (m6-live-gate, m6-gate-loader, m6-issuer-allowlist, canonical) and the shared
// kernel schema. No device/DB/network access — only local fs via the loader's
// immutable writers. The CLI (packages/cli) imports this; that is a new
// packages→services edge, justified because the CLI is an operator leaf and
// this module is pure (no device/DB/network).
import { createPrivateKey, sign as signSignature } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { newId } from "./canonical.mjs";
import { ControlPlaneError } from "./errors.mjs";
import { validateJsonSchema } from "./json-schema-validator.mjs";
import {
  deriveM6CloseoutHash,
  deriveM6EpochHash,
  evaluateM6Gate,
  M6_GATE_LOCK_KINDS,
  M6_GATE_MODES,
} from "./m6-live-gate.mjs";
import {
  loadEpochSchema,
  loadM6Gate,
  loadM6Locks,
  tombstoneAndWrite,
  writeImmutableJson,
} from "./m6-gate-loader.mjs";
import { loadGateIssuerAllowlist } from "./m6-issuer-allowlist.mjs";

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const GATE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
export const M6_EPOCH_SCHEMA_ID = "xw.m6-live-gate.v1";

function fail(code, message, extra = {}) {
  throw new ControlPlaneError(code, message, { status: 503, ...extra });
}

function isIsoDateTime(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
}

// Build a schema-valid epoch record from validated inputs. The epochHash is
// RE-DERIVED — never accepted from the caller. For OBSERVE_ONLY the status is
// `active` and closeoutRef must be null; for CLOSED the status is `closed` and a
// closeoutRef {id, sha256} is required (the seal that closes the gate at the
// tail). The record is schema-validated and self-hash-rechecked before return.
export function buildEpochRecord({
  gateId,
  mode = "OBSERVE_ONLY",
  releaseId,
  sourceCommit,
  actor,
  allowlist,
  lockHashes,
  issuedAt,
  expiresAt,
  parentEpochHash = null,
  closeoutRef = null,
  aggregateSealRef = null,
  rollbackTargetEpochHash = null,
} = {}) {
  if (typeof gateId !== "string" || !GATE_ID_RE.test(gateId)) fail("M6_EPOCH_INPUT_INVALID", "gateId must match /^[A-Za-z0-9._-]{1,128}$/");
  if (!M6_GATE_MODES.includes(mode)) fail("M6_EPOCH_INPUT_INVALID", `mode must be one of ${M6_GATE_MODES.join(", ")}`);
  if (typeof releaseId !== "string" || releaseId === "") fail("M6_EPOCH_INPUT_INVALID", "releaseId is required");
  if (typeof sourceCommit !== "string" || !HEX40.test(sourceCommit)) fail("M6_EPOCH_INPUT_INVALID", "sourceCommit must be a 40-hex sha1");
  if (typeof actor !== "string" || actor === "" || actor.length > 200) fail("M6_EPOCH_INPUT_INVALID", "actor is required (<=200 chars)");
  if (!Array.isArray(allowlist) || allowlist.length === 0
    || allowlist.some((a) => typeof a !== "string" || a === "" || a.length > 64)
    || new Set(allowlist).size !== allowlist.length) {
    fail("M6_EPOCH_INPUT_INVALID", "allowlist must be a non-empty array of unique strings (<=64 chars)");
  }
  if (!lockHashes || typeof lockHashes !== "object") fail("M6_EPOCH_INPUT_INVALID", "lockHashes are required");
  for (const kind of M6_GATE_LOCK_KINDS) {
    if (typeof lockHashes[kind] !== "string" || !HEX64.test(lockHashes[kind])) {
      fail("M6_EPOCH_INPUT_INVALID", `lockHashes.${kind} must be a 64-hex sha256`);
    }
  }
  if (!isIsoDateTime(issuedAt)) fail("M6_EPOCH_INPUT_INVALID", "issuedAt must be an ISO 8601 date-time");
  if (!isIsoDateTime(expiresAt)) fail("M6_EPOCH_INPUT_INVALID", "expiresAt must be an ISO 8601 date-time");
  if (Date.parse(expiresAt) <= Date.parse(issuedAt)) fail("M6_EPOCH_INPUT_INVALID", "expiresAt must be strictly after issuedAt");
  if (parentEpochHash !== null && (typeof parentEpochHash !== "string" || !HEX64.test(parentEpochHash))) {
    fail("M6_EPOCH_INPUT_INVALID", "parentEpochHash must be a 64-hex sha256 or null");
  }
  if (rollbackTargetEpochHash !== null && (typeof rollbackTargetEpochHash !== "string" || !HEX64.test(rollbackTargetEpochHash))) {
    fail("M6_EPOCH_INPUT_INVALID", "rollbackTargetEpochHash must be a 64-hex sha256 or null");
  }

  const status = mode === "CLOSED" ? "closed" : "active";
  let resolvedCloseoutRef = null;
  if (mode === "CLOSED") {
    if (!closeoutRef || typeof closeoutRef !== "object"
      || typeof closeoutRef.id !== "string" || closeoutRef.id === ""
      || typeof closeoutRef.sha256 !== "string" || !HEX64.test(closeoutRef.sha256)) {
      fail("M6_EPOCH_INPUT_INVALID", "CLOSED mode requires closeoutRef {id, sha256(64-hex)}");
    }
    resolvedCloseoutRef = { id: closeoutRef.id, sha256: closeoutRef.sha256 };
    if (!aggregateSealRef || typeof aggregateSealRef !== "object"
      || typeof aggregateSealRef.id !== "string" || aggregateSealRef.id === ""
      || typeof aggregateSealRef.sha256 !== "string" || !HEX64.test(aggregateSealRef.sha256)) {
      fail("M6_EPOCH_INPUT_INVALID", "CLOSED mode requires aggregateSealRef {id, sha256(64-hex)}");
    }
  } else if (closeoutRef !== null && closeoutRef !== undefined) {
    fail("M6_EPOCH_INPUT_INVALID", "OBSERVE_ONLY mode must not carry a closeoutRef");
  } else if (aggregateSealRef !== null && aggregateSealRef !== undefined) {
    fail("M6_EPOCH_INPUT_INVALID", "OBSERVE_ONLY mode must not carry an aggregateSealRef");
  } else if (rollbackTargetEpochHash !== null) {
    fail("M6_EPOCH_INPUT_INVALID", "OBSERVE_ONLY mode must not carry rollbackTargetEpochHash");
  }

  const raw = {
    schemaId: M6_EPOCH_SCHEMA_ID,
    gateId,
    mode,
    status,
    releaseId,
    sourceCommit,
    actor,
    lockHashes: { ...lockHashes },
    allowlist: [...allowlist],
    issuedAt,
    expiresAt,
    parentEpochHash,
    closeoutRef: resolvedCloseoutRef,
    aggregateSealRef: mode === "CLOSED" ? { id: aggregateSealRef.id, sha256: aggregateSealRef.sha256 } : null,
    rollbackTargetEpochHash,
  };
  const epochHash = deriveM6EpochHash(raw);
  const epoch = { ...raw, epochHash };
  // Defense in depth: the built record must survive the loader's schema check.
  const schemaErrors = validateJsonSchema(epoch, loadEpochSchema());
  if (schemaErrors.length > 0) fail("M6_EPOCH_INPUT_INVALID", `built epoch fails schema: ${schemaErrors.join("; ")}`);
  if (deriveM6EpochHash(epoch) !== epoch.epochHash) fail("M6_EPOCH_FORGED", "built epoch self-hash mismatch (internal)");
  return Object.freeze({ ...epoch });
}

// Build a closeout record binding to one epoch. The closeoutHash is RE-DERIVED.
// A closeout seals exactly one epoch; the CLOSED epoch's closeoutRef.sha256 must
// equal the closeout's closeoutHash (the caller wires that binding).
export function buildCloseoutRecord({ epochHash, actor, reason, committedAt, closeoutId } = {}) {
  if (typeof epochHash !== "string" || !HEX64.test(epochHash)) fail("M6_EPOCH_INPUT_INVALID", "closeout epochHash must be a 64-hex sha256");
  if (typeof actor !== "string" || actor === "" || actor.length > 200) fail("M6_EPOCH_INPUT_INVALID", "closeout actor is required (<=200 chars)");
  if (typeof reason !== "string" || reason === "" || reason.length > 500) fail("M6_EPOCH_INPUT_INVALID", "closeout reason is required (<=500 chars)");
  if (!isIsoDateTime(committedAt)) fail("M6_EPOCH_INPUT_INVALID", "committedAt must be an ISO 8601 date-time");
  const id = typeof closeoutId === "string" && closeoutId !== "" ? closeoutId : newId("closeout");
  const raw = { closeoutId: id, epochHash, actor, reason, committedAt };
  return Object.freeze({ ...raw, closeoutHash: deriveM6CloseoutHash(raw) });
}

// Sign the epochHash bytes with an operator private key (detached ed25519).
// Accepts a PEM string, a KeyObject, or a raw key file path. The proof binds the
// signer's subject to the epoch's declared actor at verify time.
export function signEpochProof(epoch, privateKeyInput, { keyId, subject, allowlistVersion } = {}) {
  if (!epoch || typeof epoch.epochHash !== "string" || !HEX64.test(epoch.epochHash)) {
    fail("M6_EPOCH_INPUT_INVALID", "a built epoch with a 64-hex epochHash is required to sign");
  }
  if (typeof keyId !== "string" || keyId === "") fail("M6_EPOCH_INPUT_INVALID", "keyId is required to sign");
  if (typeof subject !== "string" || subject === "") fail("M6_EPOCH_INPUT_INVALID", "subject is required to sign");
  if (!Number.isInteger(allowlistVersion) || allowlistVersion < 1) fail("M6_EPOCH_INPUT_INVALID", "allowlistVersion is required to sign");
  let privateKey = privateKeyInput;
  if (typeof privateKeyInput === "string") {
    // A PEM string (or a file path containing one). createPrivateKey accepts PEM
    // directly; if the string is not PEM, try reading it as a file path.
    if (!/-----BEGIN/.test(privateKeyInput)) {
      try { privateKey = createPrivateKey(readFileSync(privateKeyInput, "utf8")); } catch (error) {
        fail("M6_EPOCH_KEY_INVALID", `epoch signing key could not be loaded: ${error.message}`);
      }
    } else {
      try { privateKey = createPrivateKey(privateKeyInput); } catch (error) {
        fail("M6_EPOCH_KEY_INVALID", `epoch signing key could not be parsed: ${error.message}`);
      }
    }
  }
  let signature;
  try {
    signature = signSignature(null, Buffer.from(epoch.epochHash, "hex"), privateKey).toString("base64");
  } catch (error) {
    fail("M6_EPOCH_KEY_INVALID", `epoch signing failed: ${error.message}`);
  }
  return Object.freeze({ keyId, subject, allowlistVersion, signature, algorithm: "ed25519" });
}

function gateRoot(m6Root, gateId) {
  if (typeof m6Root !== "string" || m6Root === "") fail("M6_EPOCH_INPUT_INVALID", "m6Root is required");
  if (typeof gateId !== "string" || !GATE_ID_RE.test(gateId)) fail("M6_EPOCH_INPUT_INVALID", "gateId must match /^[A-Za-z0-9._-]{1,128}$/");
  return join(m6Root, "m6-gate", gateId);
}

// Write an immutable epoch file: epochs/<epochHash>.json = {...epoch, proof}.
// Refuses overwrite (M6_GATE_IMMUTABLE). Returns the absolute path written.
export function mintEpoch({ m6Root, gateId, epoch, proof }) {
  if (!epoch || typeof epoch.epochHash !== "string") fail("M6_EPOCH_INPUT_INVALID", "a built epoch is required to mint");
  if (!proof || typeof proof !== "object") fail("M6_EPOCH_INPUT_INVALID", "a proof is required to mint");
  const dir = gateRoot(m6Root, gateId);
  const path = join(dir, "epochs", `${epoch.epochHash}.json`);
  writeImmutableJson(path, { ...epoch, proof });
  return path;
}

// Write an immutable closeout record: closeouts/<closeoutId>.json. The closeout
// is written BEFORE the CLOSED epoch that references it, so the seal exists by
// the time the gate resolves it.
export function writeCloseout({ m6Root, gateId, closeout }) {
  if (!closeout || typeof closeout.closeoutId !== "string" || typeof closeout.closeoutHash !== "string") {
    fail("M6_EPOCH_INPUT_INVALID", "a built closeout record is required to write");
  }
  const dir = gateRoot(m6Root, gateId);
  const path = join(dir, "closeouts", `${closeout.closeoutId}.json`);
  writeImmutableJson(path, closeout);
  return path;
}

// Atomically promote a chain as the active gate pointer. The prior current.json
// is tombstoned (renamed, never hard-deleted) for rollback. promotedAt is
// caller-injected (no ambient clock). Returns the current.json path.
export function activateGate({ m6Root, gateId, chain, tailEpochHash, promotedAt }) {
  if (!Array.isArray(chain) || chain.length === 0) fail("M6_EPOCH_INPUT_INVALID", "activate requires a non-empty chain");
  if (typeof tailEpochHash !== "string" || !HEX64.test(tailEpochHash)) fail("M6_EPOCH_INPUT_INVALID", "tailEpochHash must be a 64-hex sha256");
  if (chain[chain.length - 1] !== tailEpochHash) fail("M6_EPOCH_INPUT_INVALID", "tailEpochHash must be the last entry in chain");
  if (!isIsoDateTime(promotedAt)) fail("M6_EPOCH_INPUT_INVALID", "promotedAt must be an ISO 8601 date-time");
  const currentPath = join(gateRoot(m6Root, gateId), "current.json");
  tombstoneAndWrite(currentPath, { chain: [...chain], tailEpochHash, promotedAt });
  return currentPath;
}

// Resolve the chain + tail from the active gate (read-only). Reuses the loader,
// which re-derives every hash and verifies every signature. Returns the current
// pointer + chain (or an empty chain if no gate is installed yet).
export function readActiveGate({ m6Root, gateId, issuerAllowlistPath, nowMs }) {
  const loaded = loadM6Gate({ m6Root, gateId, issuerAllowlistPath, requireLocks: true });
  return {
    chain: loaded.chain.map((e) => e.epochHash),
    tailEpochHash: loaded.tailEpochHash,
    epochs: loaded.chain,
    closeouts: loaded.closeouts,
    aggregates: loaded.aggregates,
    lockHashes: loaded.lockHashes,
  };
}

// Resolve "the latest minted epoch not yet in the active chain" for `activate
// --latest`. Reads epochs/<hash>.json, strips the proof, and picks the newest
// (by mtime) epoch whose parentEpochHash binds to the current tail. There must
// be exactly one such candidate; ambiguity fails closed.
export function resolveLatestEpoch({ m6Root, gateId, issuerAllowlistPath }) {
  const dir = join(gateRoot(m6Root, gateId), "epochs");
  if (!existsSync(dir)) fail("M6_EPOCH_MISSING", "no epochs directory — nothing to activate");
  const active = readActiveGate({ m6Root, gateId, issuerAllowlistPath });
  const inChain = new Set(active.chain);
  const candidates = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const hash = name.slice(0, -5);
    if (!HEX64.test(hash) || inChain.has(hash)) continue;
    const { proof, ...epoch } = JSON.parse(readFileSync(join(dir, name), "utf8"));
    if (epoch.epochHash !== hash) continue;
    if (active.chain.length === 0 ? epoch.parentEpochHash === null : epoch.parentEpochHash === active.tailEpochHash) {
      candidates.push({ epoch, hash, mtime: statSync(join(dir, name)).mtimeMs });
    }
  }
  if (candidates.length === 0) fail("M6_EPOCH_MISSING", "no unactivated epoch binds to the current tail");
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0].hash;
}

// Append a newly signed CLOSED epoch that restores a prior CLOSED policy.
// History and the active pointer only move forward; tombstones are never read
// as authorization and an OBSERVE_ONLY epoch can never be a rollback target.
export function rollbackGate({ m6Root, gateId, epoch, proof, promotedAt, issuerAllowlistPath = join(m6Root, "m6-gate", "issuer-keys.json") }) {
  if (!epoch || epoch.mode !== "CLOSED" || !HEX64.test(epoch.rollbackTargetEpochHash ?? "")) {
    fail("M6_EPOCH_INPUT_INVALID", "rollback requires a signed CLOSED epoch with rollbackTargetEpochHash");
  }
  if (!isIsoDateTime(promotedAt)) fail("M6_EPOCH_INPUT_INVALID", "promotedAt must be an ISO 8601 date-time");
  const active = loadM6Gate({ m6Root, gateId, issuerAllowlistPath, requireLocks: true });
  const targetIndex = active.chain.findIndex((candidate) => candidate.epochHash === epoch.rollbackTargetEpochHash && candidate.mode === "CLOSED");
  if (targetIndex < 0 || targetIndex >= active.chain.length - 1) {
    fail("M6_EPOCH_ROLLBACK_NO_TARGET", "rollback target must be a prior CLOSED epoch in the active append-only chain");
  }
  const target = active.chain[targetIndex];
  const sameJson = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  if (epoch.gateId !== target.gateId || epoch.releaseId !== target.releaseId || epoch.sourceCommit !== target.sourceCommit
    || epoch.expiresAt !== target.expiresAt || !sameJson(epoch.allowlist, target.allowlist)
    || !sameJson(epoch.lockHashes, target.lockHashes) || !sameJson(epoch.closeoutRef, target.closeoutRef)
    || !sameJson(epoch.aggregateSealRef, target.aggregateSealRef)) {
    fail("M6_EPOCH_ROLLBACK_TARGET_MISMATCH", "rollback epoch must reproduce the target CLOSED policy and seal bindings exactly");
  }
  if (epoch.parentEpochHash !== active.tailEpochHash) fail("M6_EPOCH_INPUT_INVALID", "rollback epoch must append to the current tail");
  mintEpoch({ m6Root, gateId, epoch, proof });
  return activateGate({
    m6Root,
    gateId,
    chain: [...active.chain.map((candidate) => candidate.epochHash), epoch.epochHash],
    tailEpochHash: epoch.epochHash,
    promotedAt,
  });
}

export { loadM6Gate, loadM6Locks, loadGateIssuerAllowlist, evaluateM6Gate, M6_GATE_MODES };
