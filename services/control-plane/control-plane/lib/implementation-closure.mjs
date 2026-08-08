/**
 * Deterministic implementation closure (Foundation PR2 / RI-01).
 * Hash is independent of OS path separators, absolute roots, mtime, and enum order.
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { canonicalJson, sha256 } from "./canonical.mjs";
import { ControlPlaneError } from "./errors.mjs";

export const CLOSURE_SCHEMA_ID = "xhs.implementation-closure.v1";
export const CLOSURE_ALGORITHM = "sha256-canonical-json-v1";

/** Normalize to repo-relative POSIX path (forward slashes, no leading ./). */
export function toPosixRepoPath(rootDir, filePath) {
  if (typeof filePath !== "string" || filePath.length === 0) {
    throw new ControlPlaneError("IMPLEMENTATION_CLOSURE_INVALID", "path must be a non-empty string", { status: 400 });
  }
  const root = resolve(rootDir);
  const abs = isAbsolute(filePath) ? resolve(filePath) : resolve(root, filePath);
  const rel = relative(root, abs);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new ControlPlaneError(
      "IMPLEMENTATION_CLOSURE_PATH_ESCAPE",
      `path escapes closure root: ${filePath}`,
      { status: 400, details: { path: filePath } },
    );
  }
  return rel.split(sep).join("/");
}

export function hashFileContent(bytes) {
  const input = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Build canonical closure document from already-hashed entries.
 * @param {{ path: string, sha256: string }[]} entries
 */
export function buildImplementationClosureDocument(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new ControlPlaneError("IMPLEMENTATION_CLOSURE_EMPTY", "closure requires at least one entry", { status: 400 });
  }
  const normalized = entries.map((entry) => {
    if (!entry || typeof entry.path !== "string" || typeof entry.sha256 !== "string") {
      throw new ControlPlaneError("IMPLEMENTATION_CLOSURE_INVALID", "each entry needs path + sha256", { status: 400 });
    }
    if (!/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new ControlPlaneError("IMPLEMENTATION_CLOSURE_INVALID", `bad sha256 for ${entry.path}`, { status: 400 });
    }
    const path = entry.path.replace(/\\/g, "/").replace(/^\.\//, "");
    if (!path || path.startsWith("/") || path.includes("..")) {
      throw new ControlPlaneError("IMPLEMENTATION_CLOSURE_INVALID", `non-canonical path: ${entry.path}`, { status: 400 });
    }
    return { path, sha256: entry.sha256 };
  });
  const paths = normalized.map((e) => e.path);
  if (new Set(paths).size !== paths.length) {
    throw new ControlPlaneError("IMPLEMENTATION_CLOSURE_DUPLICATE", "duplicate paths in closure", { status: 400 });
  }
  normalized.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    schemaId: CLOSURE_SCHEMA_ID,
    algorithm: CLOSURE_ALGORITHM,
    entries: normalized,
  };
}

export function computeImplementationClosureHash(document) {
  if (!document || document.schemaId !== CLOSURE_SCHEMA_ID || document.algorithm !== CLOSURE_ALGORITHM) {
    throw new ControlPlaneError("IMPLEMENTATION_CLOSURE_INVALID", "document schema/algorithm mismatch", { status: 400 });
  }
  return sha256(canonicalJson(document));
}

/**
 * Hash tracked runtime files under rootDir.
 * Fail-closed on missing, non-file, escape, or unreadable paths.
 */
export function computeImplementationClosureFromFiles({ rootDir, paths }) {
  if (!rootDir) {
    throw new ControlPlaneError("IMPLEMENTATION_CLOSURE_INVALID", "rootDir is required", { status: 400 });
  }
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new ControlPlaneError("IMPLEMENTATION_CLOSURE_EMPTY", "paths required", { status: 400 });
  }
  const entries = [];
  for (const raw of paths) {
    const posixPath = toPosixRepoPath(rootDir, raw);
    const abs = resolve(rootDir, ...posixPath.split("/"));
    let st;
    try {
      st = statSync(abs);
    } catch (err) {
      throw new ControlPlaneError(
        "IMPLEMENTATION_CLOSURE_MISSING",
        `missing runtime dependency: ${posixPath}`,
        { status: 400, details: { path: posixPath, cause: err?.code || String(err) } },
      );
    }
    if (!st.isFile()) {
      throw new ControlPlaneError(
        "IMPLEMENTATION_CLOSURE_NOT_FILE",
        `not a file: ${posixPath}`,
        { status: 400, details: { path: posixPath } },
      );
    }
    const sha = hashFileContent(readFileSync(abs));
    entries.push({ path: posixPath, sha256: sha });
  }
  const document = buildImplementationClosureDocument(entries);
  return {
    document,
    implementationClosureHash: computeImplementationClosureHash(document),
  };
}

/** Compare two closures; used by drift checks (RI-04). */
export function implementationClosureMatches(boundHash, currentHash) {
  return typeof boundHash === "string"
    && typeof currentHash === "string"
    && /^[a-f0-9]{64}$/.test(boundHash)
    && boundHash === currentHash;
}
