// M6-2 W8 #3 — the dedicated gate issuer allowlist for the M6 live gate.
//
// The M6 epoch chain is operator-minted and immutable. Every epoch carries an
// ed25519 detached signature over its epochHash bytes, produced by an operator
// private key held OFF-REPO. This module is the verification side: it loads the
// on-disk allowlist of authorized issuer public keys and verifies an epoch's
// proof against it. There is no sign side here — minting signs in the CLI
// (m6-epoch.mjs) with an operator-supplied --key-file.
//
// This mirrors the existing ed25519 verify pattern in the repo
// (`trusted-human-issuer.mjs` + `scripts/lib/repair-authority-verifiers.mjs`):
// `verify(null, messageBytes, createPublicKey(publicKey), signatureBytes)` with
// detached ed25519 over raw bytes — no JWT/JWS. The allowlist file is read with
// the same symlink-safe discipline used for hashed artifacts.
import { createPublicKey, verify as verifySignature } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { ControlPlaneError } from "./errors.mjs";

export const M6_GATE_ISSUER_ALLOWLIST_SCHEMA_ID = "xw.m6-gate-issuer-allowlist.v1";

function fail(code, message) {
  throw new ControlPlaneError(code, message, { status: 503 });
}

// Read a JSON file with the symlink-safe, realpath-checked discipline from
// repair-authority-verifiers.mjs: the file and every path component must be a
// real regular file inside its directory (no symlinks/junctions escaping).
function readJsonSafe(path) {
  const target = resolve(path);
  const dir = resolve(target, "..");
  if (!lstatSync(dir).isDirectory()) throw new ControlPlaneError("M6_GATE_ISSUER_DIR_INVALID", "issuer allowlist directory is missing", { status: 503 });
  if (lstatSync(target).isSymbolicLink()) throw new ControlPlaneError("M6_GATE_ISSUER_SYMLINK", "issuer allowlist path must not be a symlink", { status: 503 });
  const realDir = realpathSync(dir);
  const realTarget = realpathSync(target);
  const rel = relative(realDir, realTarget);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new ControlPlaneError("M6_GATE_ISSUER_PATH_ESCAPE", "issuer allowlist real path escapes its directory", { status: 503 });
  }
  return JSON.parse(readFileSync(realTarget, "utf8"));
}

export function normalizeGateIssuerAllowlist(value) {
  if (!value || typeof value !== "object") {
    fail("M6_GATE_ISSUER_ALLOWLIST_MALFORMED", "gate issuer allowlist is malformed");
  }
  if (value.schemaId !== M6_GATE_ISSUER_ALLOWLIST_SCHEMA_ID || !Number.isInteger(value.version) || value.version < 1 || !Array.isArray(value.keys)) {
    fail("M6_GATE_ISSUER_ALLOWLIST_MALFORMED", "gate issuer allowlist must carry schemaId, version>=1, and a keys array");
  }
  const keys = new Map();
  for (const item of value.keys) {
    if (!item || typeof item !== "object" || typeof item.keyId !== "string" || item.keyId === ""
      || typeof item.subject !== "string" || item.subject === ""
      || typeof item.publicKey !== "string" || item.publicKey === "") {
      fail("M6_GATE_ISSUER_KEY_INVALID", "gate issuer allowlist contains an invalid key entry");
    }
    try { createPublicKey(item.publicKey); } catch { fail("M6_GATE_ISSUER_KEY_INVALID", "gate issuer allowlist contains an unparseable public key"); }
    if (keys.has(item.keyId)) fail("M6_GATE_ISSUER_KEY_DUPLICATE", `gate issuer allowlist contains duplicate keyId ${item.keyId}`);
    keys.set(item.keyId, Object.freeze({
      keyId: item.keyId,
      subject: item.subject,
      publicKey: item.publicKey,
      status: item.status === "active" ? "active" : "revoked",
    }));
  }
  return Object.freeze({ version: value.version, keys });
}

export function loadGateIssuerAllowlist(path) {
  if (typeof path !== "string" || path.trim() === "") {
    fail("M6_GATE_ISSUER_ALLOWLIST_UNAVAILABLE", "gate issuer allowlist path is required");
  }
  let raw;
  try { raw = readJsonSafe(path); } catch (error) {
    if (error instanceof ControlPlaneError) throw error;
    fail("M6_GATE_ISSUER_ALLOWLIST_UNAVAILABLE", "gate issuer allowlist cannot be loaded");
  }
  return normalizeGateIssuerAllowlist(raw);
}

// Verify an epoch's detached ed25519 proof against the allowlist. The proof is
// signed over the raw epochHash bytes (`Buffer.from(epochHash, "hex")`) and is
// stored as a SIBLING field on the epoch file (not part of the canonical epoch
// payload, so it is NOT hashed and is NOT in the xw.m6-live-gate.v1 schema).
// The signer's subject MUST match the epoch's declared `actor` — an issuer
// cannot mint an epoch in another operator's name. Fails closed on any
// inconsistency.
export function verifyEpochProof({ epoch, epochHash, proof, allowlist }) {
  if (!allowlist || typeof allowlist !== "object") {
    fail("M6_GATE_ISSUER_ALLOWLIST_UNAVAILABLE", "gate issuer allowlist is required to verify an epoch");
  }
  if (!proof || typeof proof !== "object"
    || typeof proof.keyId !== "string" || proof.keyId === ""
    || !Number.isInteger(proof.allowlistVersion)
    || typeof proof.signature !== "string" || proof.signature === ""
    || (proof.algorithm !== undefined && proof.algorithm !== "ed25519")) {
    fail("M6_GATE_ISSUER_PROOF_INVALID", "epoch proof is malformed");
  }
  if (proof.allowlistVersion !== allowlist.version) {
    fail("M6_GATE_ISSUER_PROOF_INVALID", "epoch proof allowlistVersion does not match the active allowlist");
  }
  const key = allowlist.keys.get(proof.keyId);
  if (!key) fail("M6_GATE_ISSUER_KEY_UNKNOWN", `epoch proof references unknown keyId ${proof.keyId}`);
  if (key.status !== "active") fail("M6_GATE_ISSUER_KEY_REVOKED", `epoch proof references revoked keyId ${proof.keyId}`);
  // Bind the signer to the epoch's declared actor; subject must agree.
  const subject = typeof proof.subject === "string" ? proof.subject : key.subject;
  if (subject !== key.subject || subject !== epoch.actor) {
    fail("M6_GATE_ISSUER_SUBJECT_MISMATCH", "epoch proof subject does not match the issuer key or the epoch actor");
  }
  let valid = false;
  try {
    const msg = Buffer.from(String(epochHash), "hex");
    valid = verifySignature(null, msg, createPublicKey(key.publicKey), Buffer.from(proof.signature, "base64"));
  } catch { valid = false; }
  if (!valid) fail("M6_GATE_ISSUER_SIGNATURE_INVALID", "epoch signature verification failed");
  return Object.freeze({ keyId: key.keyId, subject: key.subject, allowlistVersion: allowlist.version });
}

// Validate a base64 ed25519 signature string (64 bytes, canonical base64).
export function isValidEd25519Signature(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) return false;
  const bytes = Buffer.from(value, "base64");
  return bytes.length === 64 && bytes.toString("base64") === value;
}