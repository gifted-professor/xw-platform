/**
 * Deterministic implementation closure (Foundation PR2 / RI-01).
 * Hash is independent of OS path separators, absolute roots, mtime, and enum order.
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";

import { canonicalJson, sha256 } from "./canonical.mjs";
import { ControlPlaneError } from "./errors.mjs";

export const CLOSURE_SCHEMA_ID = "xhs.implementation-closure.v1";
export const CLOSURE_ALGORITHM = "sha256-canonical-json-v1";
export const M6_GROUNDED_RUN_CAPABILITY_SELF_BINDING_CONTENT_HASH_PROFILE =
  "xhs.m6-grounded-run-capability-self-binding.v1";
export const M6_GROUNDED_RUN_CAPABILITIES_PATH =
  "services/control-plane/apps/xiaowei/capabilities.json";

const M6_GROUNDED_RUN_CAPABILITY_ID = "xiaowei.m6.grounded_run";
const ZERO_IMPLEMENTATION_CLOSURE_HASH = "0".repeat(64);
// Preserve a UTF-8 BOM as content: this profile canonicalizes line endings only.
const STRICT_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function isSupportedImplementationClosureContentHashProfile(contentHashProfile) {
  return contentHashProfile === undefined
    || contentHashProfile === M6_GROUNDED_RUN_CAPABILITY_SELF_BINDING_CONTENT_HASH_PROFILE;
}

function assertSupportedContentHashProfile(contentHashProfile) {
  if (!isSupportedImplementationClosureContentHashProfile(contentHashProfile)) {
    throw new ControlPlaneError(
      "IMPLEMENTATION_CLOSURE_CONTENT_HASH_PROFILE_UNKNOWN",
      `unknown implementation-closure contentHashProfile: ${String(contentHashProfile)}`,
      { status: 400, details: { contentHashProfile } },
    );
  }
}

function assertProfilePathPresent(entries, contentHashProfile) {
  if (contentHashProfile !== M6_GROUNDED_RUN_CAPABILITY_SELF_BINDING_CONTENT_HASH_PROFILE) return;
  if (!Array.isArray(entries)
    || !entries.some((entry) => entry?.path === M6_GROUNDED_RUN_CAPABILITIES_PATH)) {
    throw new ControlPlaneError(
      "IMPLEMENTATION_CLOSURE_CONTENT_HASH_PROFILE_PATH_MISSING",
      `${contentHashProfile} requires ${M6_GROUNDED_RUN_CAPABILITIES_PATH}`,
      {
        status: 400,
        details: {
          contentHashProfile,
          requiredPath: M6_GROUNDED_RUN_CAPABILITIES_PATH,
        },
      },
    );
  }
}

function normalizeProfileText(bytes, path) {
  let text;
  try {
    text = STRICT_UTF8_DECODER.decode(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
  } catch (err) {
    throw new ControlPlaneError(
      "IMPLEMENTATION_CLOSURE_CONTENT_HASH_PROFILE_TEXT_INVALID",
      `${path} must be strict UTF-8 text for the selected contentHashProfile`,
      { status: 400, details: { path, cause: err?.message || String(err) } },
    );
  }
  if (text.includes("\0")) {
    throw new ControlPlaneError(
      "IMPLEMENTATION_CLOSURE_CONTENT_HASH_PROFILE_TEXT_INVALID",
      `${path} must not contain NUL bytes for the selected contentHashProfile`,
      { status: 400, details: { path, cause: "NUL" } },
    );
  }
  return text.replace(/\r\n?/gu, "\n");
}

function hashM6GroundedRunCapabilities(normalizedText) {
  let capabilityDocument;
  try {
    capabilityDocument = JSON.parse(normalizedText);
  } catch (err) {
    throw new ControlPlaneError(
      "IMPLEMENTATION_CLOSURE_CONTENT_HASH_PROFILE_DOCUMENT_INVALID",
      `${M6_GROUNDED_RUN_CAPABILITIES_PATH} must contain valid JSON`,
      { status: 400, details: { path: M6_GROUNDED_RUN_CAPABILITIES_PATH, cause: err?.message || String(err) } },
    );
  }

  const matches = Array.isArray(capabilityDocument?.capabilities)
    ? capabilityDocument.capabilities.filter((capability) => capability?.id === M6_GROUNDED_RUN_CAPABILITY_ID)
    : [];
  if (matches.length !== 1) {
    throw new ControlPlaneError(
      "IMPLEMENTATION_CLOSURE_CONTENT_HASH_PROFILE_TARGET_INVALID",
      `${M6_GROUNDED_RUN_CAPABILITIES_PATH} must contain exactly one ${M6_GROUNDED_RUN_CAPABILITY_ID}`,
      {
        status: 400,
        details: {
          path: M6_GROUNDED_RUN_CAPABILITIES_PATH,
          capabilityId: M6_GROUNDED_RUN_CAPABILITY_ID,
          matchCount: matches.length,
        },
      },
    );
  }

  const target = matches[0];
  if (!target.implementation
    || typeof target.implementation !== "object"
    || Array.isArray(target.implementation)
    || !/^[a-f0-9]{64}$/u.test(target.implementation.implementationClosureHash ?? "")) {
    throw new ControlPlaneError(
      "IMPLEMENTATION_CLOSURE_CONTENT_HASH_PROFILE_TARGET_HASH_INVALID",
      `${M6_GROUNDED_RUN_CAPABILITY_ID}.implementation.implementationClosureHash must be 64 hex`,
      {
        status: 400,
        details: {
          path: M6_GROUNDED_RUN_CAPABILITIES_PATH,
          capabilityId: M6_GROUNDED_RUN_CAPABILITY_ID,
        },
      },
    );
  }

  target.implementation.implementationClosureHash = ZERO_IMPLEMENTATION_CLOSURE_HASH;
  return hashFileContent(Buffer.from(canonicalJson(capabilityDocument), "utf8"));
}

function hashEntryContent({ path, bytes, contentHashProfile }) {
  if (contentHashProfile === M6_GROUNDED_RUN_CAPABILITY_SELF_BINDING_CONTENT_HASH_PROFILE) {
    const normalizedText = normalizeProfileText(bytes, path);
    if (path === M6_GROUNDED_RUN_CAPABILITIES_PATH) {
      return hashM6GroundedRunCapabilities(normalizedText);
    }
    return hashFileContent(Buffer.from(normalizedText, "utf8"));
  }
  return hashFileContent(bytes);
}

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
 * @param {{ contentHashProfile?: string }} [options]
 */
export function buildImplementationClosureDocument(entries, { contentHashProfile } = {}) {
  assertSupportedContentHashProfile(contentHashProfile);
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
    if (!isCanonicalRepoRelativePath(path)) {
      throw new ControlPlaneError("IMPLEMENTATION_CLOSURE_INVALID", `non-canonical path: ${entry.path}`, { status: 400 });
    }
    return { path, sha256: entry.sha256 };
  });
  const paths = normalized.map((e) => e.path);
  if (new Set(paths).size !== paths.length) {
    throw new ControlPlaneError("IMPLEMENTATION_CLOSURE_DUPLICATE", "duplicate paths in closure", { status: 400 });
  }
  normalized.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  assertProfilePathPresent(normalized, contentHashProfile);
  return {
    schemaId: CLOSURE_SCHEMA_ID,
    algorithm: CLOSURE_ALGORITHM,
    ...(contentHashProfile === undefined ? {} : { contentHashProfile }),
    entries: normalized,
  };
}

export function computeImplementationClosureHash(document) {
  if (!document || document.schemaId !== CLOSURE_SCHEMA_ID || document.algorithm !== CLOSURE_ALGORITHM) {
    throw new ControlPlaneError("IMPLEMENTATION_CLOSURE_INVALID", "document schema/algorithm mismatch", { status: 400 });
  }
  assertSupportedContentHashProfile(document.contentHashProfile);
  assertProfilePathPresent(document.entries, document.contentHashProfile);
  return sha256(canonicalJson(document));
}

/**
 * Hash tracked runtime files under rootDir.
 * Fail-closed on missing, non-file, escape, or unreadable paths.
 */
export function computeImplementationClosureFromFiles({ rootDir, paths, contentHashProfile } = {}) {
  assertSupportedContentHashProfile(contentHashProfile);
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
    const sha = hashEntryContent({
      path: posixPath,
      bytes: readFileSync(abs),
      contentHashProfile,
    });
    entries.push({ path: posixPath, sha256: sha });
  }
  const document = buildImplementationClosureDocument(entries, { contentHashProfile });
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
