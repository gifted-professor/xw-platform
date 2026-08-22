// M6-2 W8 #2/#3 — the PRODUCTION M6 gate config loader.
//
// In production the M6 live gate is NOT an in-memory default: it is materialized
// from immutable, content-addressed epoch files on disk under
// `<XW_RUNTIME_ROOT>/m6-gate/<gateId>/`. This module reads them back, re-derives
// every epoch hash, validates every epoch against the shared schema, verifies
// every epoch's ed25519 issuer signature against the gate issuer allowlist, and
// reconstructs the chain. Any tampering, missing file, bad hash, bad signature,
// or missing pinned locks fails closed — the gate stays CLOSED, no capture runs.
//
// Control-plane never imports orchestrator code. The lock hashes are PINNED
// VALUES read from `m6-gate/locks.v1.json` (produced by the release pipeline);
// they are not re-derived here. Both this loader and the `xw m6 epoch mint` CLI
// read the same pinned file, so an epoch and the runtime agree by construction.
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
  fsyncSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { canonicalJson, sha256 } from "./canonical.mjs";
import { ControlPlaneError } from "./errors.mjs";
import { validateJsonSchema } from "./json-schema-validator.mjs";
import { deriveM6CloseoutHash, deriveM6EpochHash } from "./m6-live-gate.mjs";
import { loadGateIssuerAllowlist, verifyEpochProof } from "./m6-issuer-allowlist.mjs";

export const M6_LOCKS_SCHEMA_ID = "xw.m6-locks.v1";
const HEX64 = /^[0-9a-f]{64}$/;

let EPOCH_SCHEMA = null;
export function loadEpochSchema() {
  if (EPOCH_SCHEMA) return EPOCH_SCHEMA;
  // Shared kernel schema — the same file the orchestrator validates against.
  const path = join(import.meta.dirname, "..", "..", "..", "..", "packages", "kernel", "contracts", "orchestration", "m6", "xw.m6-live-gate.v1.schema.json");
  EPOCH_SCHEMA = JSON.parse(readFileSync(path, "utf8"));
  return EPOCH_SCHEMA;
}

function fail(code, message, extra = {}) {
  throw new ControlPlaneError(code, message, { status: 503, ...extra });
}

// Symlink-safe, realpath-checked read (mirrors repair-authority-verifiers.mjs).
// The file must be a regular file inside its configured directory; symlinks and
// junctions that escape are refused. This is the only disk-read primitive here.
function readRegularJson(filePath, expectedSha256 = null) {
  const target = resolve(filePath);
  if (!existsSync(target)) return null;
  const stat = lstatSync(target);
  if (stat.isSymbolicLink()) fail("M6_GATE_PATH_SYMLINK", "gate artifact path must not be a symlink");
  if (!stat.isFile()) fail("M6_GATE_PATH_NOT_REGULAR", "gate artifact path is not a regular file");
  const real = realpathSync(target);
  const bytes = readFileSync(real);
  if (expectedSha256 && sha256(bytes) !== expectedSha256) {
    fail("M6_GATE_PATH_HASH_MISMATCH", "gate artifact file hash does not match its address");
  }
  try { return JSON.parse(bytes.toString("utf8")); } catch { fail("M6_GATE_FILE_INVALID", "gate artifact is not valid JSON"); }
}

// Read the pinned lock hashes. These are PINNED by the release pipeline — never
// re-derived. Missing locks while M6 is enabled is fail-closed (M6_LOCKS_MISSING).
export function loadM6Locks(m6Root, { requireLocks = true } = {}) {
  const path = join(m6Root, "m6-gate", "locks.v1.json");
  const raw = readRegularJson(path);
  if (!raw) {
    if (requireLocks) fail("M6_LOCKS_MISSING", "pinned M6 lock hashes (m6-gate/locks.v1.json) are required when M6 is enabled");
    return null;
  }
  if (raw.schemaId !== M6_LOCKS_SCHEMA_ID) fail("M6_LOCKS_INVALID", "locks.v1.json schemaId mismatch");
  const locks = raw.lockHashes;
  if (!locks || typeof locks !== "object") fail("M6_LOCKS_INVALID", "locks.v1.json missing lockHashes");
  for (const kind of ["runtimeProfile", "hardRedlinePolicy", "groundingRuntime"]) {
    if (typeof locks[kind] !== "string" || !HEX64.test(locks[kind])) {
      fail("M6_LOCKS_INVALID", `locks.v1.json ${kind} must be a 64-hex sha256`);
    }
  }
  return Object.freeze({ ...locks });
}

function gateDir(m6Root, gateId) {
  if (typeof gateId !== "string" || gateId === "" || !/^[A-Za-z0-9._-]{1,128}$/.test(gateId)) {
    fail("M6_GATE_ID_INVALID", "gateId must match /^[A-Za-z0-9._-]{1,128}$/");
  }
  return join(m6Root, "m6-gate", gateId);
}

// Load + validate one epoch file. The file is the canonical epoch record plus a
// sibling `proof` field (ed25519 over the epochHash bytes). The proof is NOT
// part of the hashed payload and NOT in the schema; it is stripped here.
function loadEpochFile(fileDir, epochHash, allowlist) {
  if (typeof epochHash !== "string" || !HEX64.test(epochHash)) {
    fail("M6_GATE_EPOCH_HASH_INVALID", `epoch file address is not a 64-hex sha256: ${epochHash}`);
  }
  const filePath = join(fileDir, "epochs", `${epochHash}.json`);
  const raw = readRegularJson(filePath);
  if (!raw) fail("M6_GATE_EPOCH_MISSING", `epoch file ${epochHash}.json is absent`);
  const { proof, ...epoch } = raw;
  // Schema (no proof field — additionalProperties: false).
  const schemaErrors = validateJsonSchema(epoch, loadEpochSchema());
  if (schemaErrors.length > 0) fail("M6_GATE_EPOCH_SCHEMA_INVALID", `epoch ${epochHash} fails schema: ${schemaErrors.join("; ")}`);
  // Re-derive the self-hash; must match the embedded hash AND the file address.
  const derived = deriveM6EpochHash(epoch);
  if (derived !== epoch.epochHash) fail("M6_GATE_EPOCH_FORGED", `epoch ${epochHash} self-hash does not match its payload`);
  if (derived !== epochHash) fail("M6_GATE_EPOCH_ADDRESS_MISMATCH", `epoch file address does not match its hash`);
  // Verify the issuer signature.
  verifyEpochProof({ epoch, epochHash, proof, allowlist });
  return epoch;
}

// Load all closeout records for the gate into a {closeoutId: record} map. Each
// record must self-hash via deriveM6CloseoutHash (resolveM6Closeout re-checks).
function loadCloseouts(gateDirPath) {
  const dir = join(gateDirPath, "closeouts");
  const closeouts = {};
  if (!existsSync(dir)) return closeouts;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const record = readRegularJson(join(dir, name));
    if (!record || typeof record !== "object") continue;
    const id = record.closeoutId ?? name.slice(0, -5);
    const derived = deriveM6CloseoutHash(record);
    if (typeof record.closeoutHash !== "string" || record.closeoutHash !== derived) {
      fail("M6_GATE_CLOSEOUT_FORGED", `closeout ${id} self-hash does not match its payload`);
    }
    closeouts[id] = record;
  }
  return closeouts;
}

// Load the active gate from disk: current pointer → ordered chain → per-epoch
// validation + signature verification → closeout registry → pinned locks.
// Returns { chain, closeouts, lockHashes, gateId, tailEpochHash }.
// Missing gate directory → empty chain (fail closed via M6_GATE_EMPTY upstream).
export function loadM6Gate({
  m6Root,
  gateId,
  issuerAllowlistPath,
  requireLocks = true,
} = {}) {
  if (!m6Root) fail("M6_GATE_ROOT_REQUIRED", "M6 runtime root is required");
  const dir = gateDir(m6Root, gateId);
  if (!existsSync(dir)) {
    // No gate installed → empty chain (gate evaluates to M6_GATE_EMPTY, CLOSED).
    return { chain: [], closeouts: {}, lockHashes: loadM6Locks(m6Root, { requireLocks }), gateId, tailEpochHash: null };
  }
  const allowlist = loadGateIssuerAllowlist(issuerAllowlistPath);
  const currentPath = join(dir, "current.json");
  const current = readRegularJson(currentPath);
  if (!current || !Array.isArray(current.chain) || current.chain.length === 0) {
    return { chain: [], closeouts: {}, lockHashes: loadM6Locks(m6Root, { requireLocks }), gateId, tailEpochHash: null };
  }
  const chain = [];
  for (const epochHash of current.chain) {
    const epoch = loadEpochFile(dir, epochHash, allowlist);
    chain.push(epoch);
  }
  const closeouts = loadCloseouts(dir);
  return { chain, closeouts, lockHashes: loadM6Locks(m6Root, { requireLocks }), gateId, tailEpochHash: current.tailEpochHash ?? current.chain[current.chain.length - 1] };
}

// Probe that a directory is writable (mkdir + temp write + fsync + unlink).
// Used by preflight/health to PROVE the evidence/audit roots are usable.
export function probeWritable(dir) {
  try {
    mkdirSync(dir, { recursive: true });
    const marker = join(dir, `.m6-probe-${process.pid}-${Date.now()}.tmp`);
    let fd;
    try {
      fd = openSync(marker, "wx", 0o600);
      writeSync(fd, "m6-probe");
      fsyncSync(fd);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    try { unlinkSync(marker); } catch { /* best effort */ }
    return true;
  } catch {
    return false;
  }
}

// Atomic immutable writer (refuse-overwrite): temp write → fsync → rename. Used
// by the epoch CLI to mint epoch/closeout/pointer files. Mirrors the evidence
// store's atomic commit and writeRelease's refuse-overwrite discipline.
export function writeImmutableJson(filePath, record) {
  const target = resolve(filePath);
  if (existsSync(target)) fail("M6_GATE_IMMUTABLE", `immutable artifact already exists: ${target}`);
  mkdirSync(resolve(target, ".."), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  let fd;
  try {
    fd = openSync(tmp, "r+");
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  try { renameSync(tmp, target); } catch (error) {
    try { unlinkSync(tmp); } catch { /* best effort */ }
    fail("M6_GATE_WRITE_FAILED", `immutable artifact rename failed: ${error.code || error.message}`);
  }
  return target;
}

// Tombstone (rename, never hard-delete) for rollback of the current pointer.
export function tombstoneAndWrite(filePath, record) {
  const target = resolve(filePath);
  if (existsSync(target)) {
    const tombDir = resolve(target, "..", "tombstones");
    mkdirSync(tombDir, { recursive: true });
    renameSync(target, join(tombDir, `${Date.now()}.${target.split(/[\\/]/).pop()}`));
  }
  return writeImmutableJson(filePath, record);
}

export { canonicalJson, sha256 };