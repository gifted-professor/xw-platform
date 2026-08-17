// M0 two-phase double tag (M0-E / B4).
//
// Two repos (registry, deviceAgent) get paired annotated tags. The pair must be
// atomic: both pushed, or neither. Phase 1 (prepare): neither remote tag exists;
// create two LOCAL annotated tags whose annotations record baselineId + both
// targets + input pair + projection/tooling/dossier hashes. The two tag object IDs
// are NOT written into each other's annotations (prepare does not know the peer's
// object ID until both exist; the annotation references the peer by name + target,
// not by object ID). Phase 2 (commit, B4): push registry tag first, re-fetch verify,
// then push deviceAgent tag, re-fetch verify. On second-push transient failure,
// retry the SAME tag object. On remote conflict: do NOT delete or move existing
// tags; record PAIR_INCOMPLETE; M1 must not start; retry as xw-m0-baseline-r1.
//
// This module implements prepare + verify (read-only git). The push (commit) phase
// is invoked only at B4 after independent review.

import { execFileSync } from "node:child_process";

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }).replace(/\n$/, "");
}

/** Read-only: does a remote tag already exist? Returns the object id or null. */
export function remoteTagExists(cwd, remote, tagName) {
  try {
    const ls = execFileSync("git", ["-C", cwd, "ls-remote", remote, `refs/tags/${tagName}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const m = /^([0-9a-f]{40})\s+/m.exec(ls);
    return m ? m[1] : null;
  } catch {
    return null; // remote unreachable or tag absent
  }
}

/** Read-only: local annotated tag object id, or null if missing. */
export function localTagObject(cwd, tagName) {
  try {
    return git(cwd, "rev-parse", `refs/tags/${tagName}^{tag}`); // returns tag object id
  } catch {
    return null;
  }
}

/** Read-only: peeled commit the tag points to. */
export function tagPeeledCommit(cwd, tagName) {
  try {
    return git(cwd, "rev-list", "-n", "1", `refs/tags/${tagName}`);
  } catch {
    return null;
  }
}

/** Read-only: annotation message of an annotated tag. */
export function tagAnnotation(cwd, tagName) {
  try {
    return git(cwd, "for-each-ref", "--format=%(contents)", `refs/tags/${tagName}`);
  } catch {
    return null;
  }
}

/**
 * Build the canonical annotation body for one side of the pair. The body records
 * baselineId, both targets, input pair, projection/tooling hashes, dossier manifest
 * hash, and the peer tag's NAME (not object id). Two sides share the same body
 * template with their roles swapped.
 */
export function buildAnnotation(spec) {
  const lines = [
    `baselineId: ${spec.baselineId}`,
    `tag: ${spec.thisSide.tagName} -> ${spec.thisSide.repo}:${spec.thisSide.target}`,
    `peer: ${spec.peerSide.tagName} -> ${spec.peerSide.repo}:${spec.peerSide.target}`,
    `inputPair:`,
    `  registry: ${spec.inputPair.registry}`,
    `  deviceAgent: ${spec.inputPair.deviceAgent}`,
    `projectionHash:`,
    `  registry: ${spec.projectionHashes.registry}`,
    `  deviceAgent: ${spec.projectionHashes.deviceAgent}`,
    `toolingHash: ${spec.toolingHash}`,
    `dossierManifestHash: ${spec.dossierManifestHash}`,
    `pairPolicy: both-or-neither; on conflict do not delete/move; retry as xw-m0-baseline-r1`,
  ];
  return lines.join("\n") + "\n";
}

/**
 * Phase 1 prepare for one repo: assert no remote tag, no local tag, create a local
 * annotated tag at target. Returns {tagName, object, peeled, annotation}. Does NOT
 * push. Throws BLOCK if the remote or local tag already exists (caller decides r1).
 */
export function prepareTag(cwd, remote, { tagName, target, annotation }) {
  const remoteObj = remoteTagExists(cwd, remote, tagName);
  if (remoteObj) {
    throw new Error(`BLOCK: remote tag ${tagName} already exists (${remoteObj})`);
  }
  const localObj = localTagObject(cwd, tagName);
  if (localObj) {
    throw new Error(`BLOCK: local tag ${tagName} already exists (${localObj})`);
  }
  git(cwd, "tag", "-a", tagName, target, "-m", annotation);
  return {
    tagName,
    object: localTagObject(cwd, tagName),
    peeled: tagPeeledCommit(cwd, tagName),
    annotation,
  };
}

/**
 * Verify a tag after fetch: object exists locally, peeled commit matches expected
 * target, annotation contains the baselineId. Returns {ok, object, peeled, details}.
 */
export function verifyTag(cwd, tagName, expectedTarget, expectedBaselineId) {
  const object = localTagObject(cwd, tagName);
  const peeled = tagPeeledCommit(cwd, tagName);
  const annotation = tagAnnotation(cwd, tagName);
  const ok = !!object
    && peeled === expectedTarget
    && !!annotation
    && annotation.includes(`baselineId: ${expectedBaselineId}`);
  return { ok, object, peeled, annotation, details: ok ? "verified" : "mismatch" };
}