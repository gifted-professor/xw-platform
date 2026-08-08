/**
 * Deterministic implementation closure (Foundation PR2 / RI-01).
 * Must produce the same hash as routing control-plane/lib/implementation-closure.mjs
 * for identical relative paths + file bytes.
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const CLOSURE_SCHEMA_ID = "xhs.implementation-closure.v1";
export const CLOSURE_ALGORITHM = "sha256-canonical-json-v1";

/**
 * Repo-relative POSIX path check aligned with closure/TCB schema:
 * reject `/`, `\`, `../` segments — allow filenames that merely contain `..` (e.g. v1..0.mjs).
 */
export function isCanonicalRepoRelativePath(path) {
  if (typeof path !== "string" || path.length === 0) return false;
  if (path.includes("\\") || path.startsWith("/")) return false;
  if (path === ".." || path.startsWith("../") || path.endsWith("/..") || path.includes("/../")) return false;
  if (path.split("/").includes("..")) return false;
  return true;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  const input = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  return createHash("sha256").update(input).digest("hex");
}

function fail(code, message, details) {
  return Object.assign(new Error(message), { code, details });
}

/** Normalize to repo-relative POSIX path (forward slashes, no leading ./). */
export function toPosixRepoPath(rootDir, filePath) {
  if (typeof filePath !== "string" || filePath.length === 0) {
    throw fail("IMPLEMENTATION_CLOSURE_INVALID", "path must be a non-empty string");
  }
  const root = resolve(rootDir);
  const abs = isAbsolute(filePath) ? resolve(filePath) : resolve(root, filePath);
  const rel = relative(root, abs);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw fail("IMPLEMENTATION_CLOSURE_PATH_ESCAPE", `path escapes closure root: ${filePath}`, { path: filePath });
  }
  return rel.split(sep).join("/");
}

export function hashFileContent(bytes) {
  const input = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return createHash("sha256").update(input).digest("hex");
}

export function buildImplementationClosureDocument(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw fail("IMPLEMENTATION_CLOSURE_EMPTY", "closure requires at least one entry");
  }
  const normalized = entries.map((entry) => {
    if (!entry || typeof entry.path !== "string" || typeof entry.sha256 !== "string") {
      throw fail("IMPLEMENTATION_CLOSURE_INVALID", "each entry needs path + sha256");
    }
    if (!/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw fail("IMPLEMENTATION_CLOSURE_INVALID", `bad sha256 for ${entry.path}`);
    }
    const path = entry.path.replace(/\\/g, "/").replace(/^\.\//, "");
    if (!isCanonicalRepoRelativePath(path)) {
      throw fail("IMPLEMENTATION_CLOSURE_INVALID", `non-canonical path: ${entry.path}`);
    }
    return { path, sha256: entry.sha256 };
  });
  const paths = normalized.map((e) => e.path);
  if (new Set(paths).size !== paths.length) {
    throw fail("IMPLEMENTATION_CLOSURE_DUPLICATE", "duplicate paths in closure");
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
    throw fail("IMPLEMENTATION_CLOSURE_INVALID", "document schema/algorithm mismatch");
  }
  return sha256(canonicalJson(document));
}

export function computeImplementationClosureFromFiles({ rootDir, paths }) {
  if (!rootDir) throw fail("IMPLEMENTATION_CLOSURE_INVALID", "rootDir is required");
  if (!Array.isArray(paths) || paths.length === 0) {
    throw fail("IMPLEMENTATION_CLOSURE_EMPTY", "paths required");
  }
  const entries = [];
  for (const raw of paths) {
    const posixPath = toPosixRepoPath(rootDir, raw);
    const abs = resolve(rootDir, ...posixPath.split("/"));
    let st;
    try {
      st = statSync(abs);
    } catch (err) {
      throw fail("IMPLEMENTATION_CLOSURE_MISSING", `missing runtime dependency: ${posixPath}`, {
        path: posixPath,
        cause: err?.code || String(err),
      });
    }
    if (!st.isFile()) {
      throw fail("IMPLEMENTATION_CLOSURE_NOT_FILE", `not a file: ${posixPath}`, { path: posixPath });
    }
    entries.push({ path: posixPath, sha256: hashFileContent(readFileSync(abs)) });
  }
  const document = buildImplementationClosureDocument(entries);
  return {
    document,
    implementationClosureHash: computeImplementationClosureHash(document),
  };
}

export function implementationClosureMatches(boundHash, currentHash) {
  return typeof boundHash === "string"
    && typeof currentHash === "string"
    && /^[a-f0-9]{64}$/.test(boundHash)
    && boundHash === currentHash;
}
