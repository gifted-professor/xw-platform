/**
 * TCB manifest load + verify (Foundation PR2). Parity with routing control-plane/lib/tcb-manifest.mjs.
 */

import { readFileSync } from "node:fs";

import {
  CLOSURE_ALGORITHM,
  CLOSURE_SCHEMA_ID,
  buildImplementationClosureDocument,
  computeImplementationClosureFromFiles,
  computeImplementationClosureHash,
  isCanonicalRepoRelativePath,
} from "./implementation-closure.mjs";

export const TCB_MANIFEST_SCHEMA_ID = "xhs.tcb.manifest.v1";
export const TCB_MANIFEST_SCHEMA_VERSION = 1;

function fail(code, message, details) {
  return Object.assign(new Error(message), { code, details });
}

export function validateTcbManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { ok: false, errors: ["manifest must be an object"] };
  }
  if (manifest.schemaId !== TCB_MANIFEST_SCHEMA_ID) errors.push(`schemaId must be ${TCB_MANIFEST_SCHEMA_ID}`);
  if (manifest.schemaVersion !== TCB_MANIFEST_SCHEMA_VERSION) errors.push("schemaVersion must be 1");
  if (typeof manifest.manifestId !== "string" || !manifest.manifestId) errors.push("manifestId required");
  if (typeof manifest.implementationClosureHash !== "string" || !/^[a-f0-9]{64}$/.test(manifest.implementationClosureHash)) {
    errors.push("implementationClosureHash must be 64 hex");
  }
  if (!Array.isArray(manifest.paths) || manifest.paths.length === 0) errors.push("paths must be a non-empty array");
  else {
    for (const p of manifest.paths) {
      if (typeof p !== "string" || !isCanonicalRepoRelativePath(p)) {
        errors.push(`path must be repo-relative POSIX without .. segments: ${p}`);
      }
    }
    if (new Set(manifest.paths).size !== manifest.paths.length) errors.push("paths must be unique");
  }
  if (manifest.capabilityIds !== undefined) {
    if (!Array.isArray(manifest.capabilityIds)) errors.push("capabilityIds must be an array");
    else if (manifest.capabilityIds.some((id) => typeof id !== "string" || !id)) errors.push("capabilityIds entries must be non-empty strings");
  }
  if (manifest.closure !== undefined) {
    if (!manifest.closure || manifest.closure.schemaId !== CLOSURE_SCHEMA_ID || manifest.closure.algorithm !== CLOSURE_ALGORITHM) {
      errors.push("embedded closure schema/algorithm mismatch");
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}

export function assertTcbManifest(manifest) {
  const result = validateTcbManifest(manifest);
  if (!result.ok) throw fail("TCB_MANIFEST_INVALID", result.errors.join("; "), { errors: result.errors });
  return manifest;
}

export function loadTcbManifest(filePath) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (err) {
    throw fail("TCB_MANIFEST_UNREADABLE", `cannot read ${filePath}: ${err?.message || err}`);
  }
  return assertTcbManifest(raw);
}

export function verifyTcbManifestAgainstRoot(manifest, rootDir) {
  assertTcbManifest(manifest);
  const { document, implementationClosureHash } = computeImplementationClosureFromFiles({
    rootDir,
    paths: manifest.paths,
  });
  if (implementationClosureHash !== manifest.implementationClosureHash) {
    throw fail("IMPLEMENTATION_CONTRACT_CHANGED", "TCB manifest implementationClosureHash does not match current files", {
      bound: manifest.implementationClosureHash,
      current: implementationClosureHash,
      notSent: true,
    });
  }
  if (manifest.closure) {
    const embeddedHash = computeImplementationClosureHash(buildImplementationClosureDocument(manifest.closure.entries));
    if (embeddedHash !== implementationClosureHash) {
      throw fail("TCB_MANIFEST_CLOSURE_MISMATCH", "embedded closure hash differs from paths recompute", {
        embeddedHash,
        implementationClosureHash,
      });
    }
  }
  return { document, implementationClosureHash, tcbManifestRef: manifest.manifestId };
}

export function createTcbManifest({ manifestId, rootDir, paths, capabilityIds = [] }) {
  const { document, implementationClosureHash } = computeImplementationClosureFromFiles({ rootDir, paths });
  return assertTcbManifest({
    schemaId: TCB_MANIFEST_SCHEMA_ID,
    schemaVersion: TCB_MANIFEST_SCHEMA_VERSION,
    manifestId,
    implementationClosureHash,
    paths: document.entries.map((e) => e.path),
    capabilityIds,
    closure: document,
  });
}
