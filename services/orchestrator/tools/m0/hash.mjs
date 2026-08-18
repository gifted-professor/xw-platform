// M0 canonical file-manifest hashing (plan §2.2).
//
// Algorithm:
//   1. File paths normalized to forward slashes, case preserved. Windows case
//      collisions (two paths differing only by case) are rejected — BLOCK.
//   2. Entries sorted by the UTF-8 byte sequence of the path (NOT default JS string
//      sort, which is UTF-16 code units — the two differ for non-ASCII paths).
//   3. Each entry records {path, gitMode, size, sha256} where sha256 is over the raw
//      file content bytes (reproducible across fresh clones of identical content).
//   4. The manifest is JCS-canonicalized (RFC 8785) — see jcs.mjs.
//   5. The projection hash is SHA-256 over the canonical UTF-8 bytes.
//
// gitMode: from `git ls-files --stage` for tracked files (100644/100755/120000/160000);
// for untracked files a filesystem-derived mode is used (regular->100644,
// executable->100755, symlink->120000).

import { createHash } from "node:crypto";
import { readFileSync, readlinkSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { canonicalSha256 } from "./jcs.mjs";

export const MANIFEST_SCHEMA_ID = "xhs.m0.file-manifest.v1";
export const MANIFEST_SCHEMA_VERSION = 1;

/** SHA-256 over raw bytes, lowercase hex. */
export function hashBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Normalize a path to forward slashes, case preserved. */
export function toPosixPath(p) {
  return String(p).replace(/\\/g, "/");
}

/**
 * Detect Windows case collisions: two paths that differ only by case. On a
 * case-insensitive filesystem these would be the same file, so listing both is
 * ambiguous and must BLOCK. Throws on collision.
 * @param {string[]} posixPaths
 */
export function detectCaseCollisions(posixPaths) {
  const seen = new Map(); // lowercase path -> first original
  for (const p of posixPaths) {
    const lower = p.toLowerCase();
    if (seen.has(lower) && seen.get(lower) !== p) {
      throw new Error(
        `case collision: ${JSON.stringify(seen.get(lower))} vs ${JSON.stringify(p)}`,
      );
    }
    seen.set(lower, p);
  }
}

/** Filesystem-derived git mode for an absolute path (for untracked files). */
export function fsGitMode(absPath) {
  const st = lstatSync(absPath);
  if (st.isSymbolicLink()) return "120000";
  if (st.isFile() && (st.mode & 0o111)) return "100755";
  if (st.isFile()) return "100644";
  throw new Error(`unsupported fs entry type: ${absPath}`);
}

/** Compare two paths by UTF-8 byte sequence (stable sort comparator). */
function comparePathUtf8(a, b) {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  const n = Math.min(ba.length, bb.length);
  for (let i = 0; i < n; i++) {
    const d = ba[i] - bb[i];
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return ba.length - bb.length;
}

/**
 * Build the canonical manifest object from entries. Entries are
 * {path (posix, relative), gitMode, size, sha256}. Sorted by UTF-8 path bytes;
 * the input array is not mutated.
 * @param {{path:string, gitMode:string, size:number, sha256:string}[]} entries
 */
export function buildManifest(entries) {
  const files = entries
    .slice()
    .map((e) => ({ path: toPosixPath(e.path), gitMode: e.gitMode, size: e.size, sha256: e.sha256 }))
    .sort((a, b) => comparePathUtf8(a.path, b.path));
  return { schemaId: MANIFEST_SCHEMA_ID, schemaVersion: MANIFEST_SCHEMA_VERSION, files };
}

/**
 * Projection hash = SHA-256 over the JCS canonical bytes of the manifest.
 * @param {{path:string, gitMode:string, size:number, sha256:string}[]} entries
 */
export function manifestHash(entries) {
  return canonicalSha256(buildManifest(entries));
}

/**
 * Collect file entries under a root for a list of relative posix paths. Reads each
 * file's bytes (sha256 over content + size). gitModeMap: Map<path, gitMode> from
 * `git ls-files --stage`; missing entries fall back to fsGitMode. Symlinks are
 * recorded with mode 120000 and content = link target string.
 * @param {string} root
 * @param {string[]} relPosixPaths
 * @param {{gitModeMap?: Map<string,string>}} [opts]
 */
export function collectEntries(root, relPosixPaths, opts = {}) {
  detectCaseCollisions(relPosixPaths);
  const entries = [];
  for (const rel of relPosixPaths) {
    const abs = join(root, rel);
    const st = lstatSync(abs);
    let gitMode;
    let bytes;
    if (st.isSymbolicLink()) {
      gitMode = "120000";
      bytes = Buffer.from(readlinkSync(abs), "utf8");
    } else {
      gitMode = opts.gitModeMap?.get(rel) ?? fsGitMode(abs);
      bytes = readFileSync(abs);
    }
    entries.push({ path: toPosixPath(rel), gitMode, size: bytes.length, sha256: hashBytes(bytes) });
  }
  return entries;
}

/** Build + hash in one call. Returns {manifest, hash, fileCount, totalBytes}. */
export function buildProjection(entries) {
  const manifest = buildManifest(entries);
  const totalBytes = entries.reduce((s, e) => s + e.size, 0);
  return {
    manifest,
    hash: canonicalSha256(manifest),
    fileCount: entries.length,
    totalBytes,
  };
}