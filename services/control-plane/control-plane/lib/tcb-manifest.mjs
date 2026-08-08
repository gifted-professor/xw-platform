/**
 * TCB manifest load + verify against implementation closure (Foundation PR2).
 */

import { readFileSync } from "node:fs";

import { ControlPlaneError } from "./errors.mjs";
import {
  CLOSURE_ALGORITHM,
  CLOSURE_SCHEMA_ID,
  computeImplementationClosureFromFiles,
  computeImplementationClosureHash,
  buildImplementationClosureDocument,
} from "./implementation-closure.mjs";

export const TCB_MANIFEST_SCHEMA_ID = "xhs.tcb.manifest.v1";
export const TCB_MANIFEST_SCHEMA_VERSION = 1;

/**
 * Structural validation (no filesystem).
 * @returns {{ ok: true } | { ok: false, errors: string[] }}
 */
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
      if (typeof p !== "string" || !p || p.includes("\\") || p.startsWith("/") || p.includes("..")) {
        errors.push(`path must be repo-relative POSIX without ..: ${p}`);
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
  if (!result.ok) {
    throw new ControlPlaneError("TCB_MANIFEST_INVALID", result.errors.join("; "), {
      status: 400,
      details: { errors: result.errors },
    });
  }
  return manifest;
}

export function loadTcbManifest(filePath) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (err) {
    throw new ControlPlaneError("TCB_MANIFEST_UNREADABLE", `cannot read ${filePath}: ${err?.message || err}`, { status: 400 });
  }
  return assertTcbManifest(raw);
}

/**
 * Recompute closure from paths under rootDir and require hash match.
 * Fail-closed on missing/extra filesystem drift vs declared hash.
 */
export function verifyTcbManifestAgainstRoot(manifest, rootDir) {
  assertTcbManifest(manifest);
  const { document, implementationClosureHash } = computeImplementationClosureFromFiles({
    rootDir,
    paths: manifest.paths,
  });
  if (implementationClosureHash !== manifest.implementationClosureHash) {
    throw new ControlPlaneError(
      "IMPLEMENTATION_CONTRACT_CHANGED",
      "TCB manifest implementationClosureHash does not match current files",
      {
        status: 409,
        details: {
          bound: manifest.implementationClosureHash,
          current: implementationClosureHash,
          notSent: true,
        },
      },
    );
  }
  if (manifest.closure) {
    const embeddedHash = computeImplementationClosureHash(buildImplementationClosureDocument(manifest.closure.entries));
    if (embeddedHash !== implementationClosureHash) {
      throw new ControlPlaneError(
        "TCB_MANIFEST_CLOSURE_MISMATCH",
        "embedded closure hash differs from paths recompute",
        { status: 409, details: { embeddedHash, implementationClosureHash } },
      );
    }
  }
  return { document, implementationClosureHash, tcbManifestRef: manifest.manifestId };
}

/**
 * Build a manifest document for a set of paths (helper for fixtures / codegen).
 */
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
