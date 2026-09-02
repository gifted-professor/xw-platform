// xhs-routine-artifact.mjs — the strict artifact binding rule shared by the
// routine runner (dump XML) and the Control Plane effect transport (dump XML)
// and the vision navigator (PNG, §8.2.1). An artifact is only readable when it
// is a regular file INSIDE its owning CP runDirectory realpath, with the
// expected extension and size — a path outside the run (or a symlink escape)
// is rejected before any byte is read.
import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, relative } from "node:path";

export function readBoundArtifact({
  path,
  runId,
  storage,
  extensions = [".xml"],
  maxBytes = 8 * 1024 * 1024,
} = {}) {
  if (typeof runId !== "string" || !runId || typeof path !== "string" || !path) {
    throw Object.assign(new Error("dump artifact needs path and owning runId"), { code: "ROUTINE_ARTIFACT_BINDING_INVALID", status: 409 });
  }
  const declaredRunRoot = storage?.runDirectory;
  if (typeof declaredRunRoot !== "string" || !declaredRunRoot) {
    throw Object.assign(new Error("dump artifact needs its CP runDirectory"), { code: "ROUTINE_ARTIFACT_BINDING_INVALID", status: 409 });
  }
  let runRoot;
  let artifact;
  try {
    runRoot = realpathSync(declaredRunRoot);
    artifact = realpathSync(path);
  } catch {
    throw Object.assign(new Error("dump artifact is absent"), { code: "ROUTINE_ARTIFACT_MISSING", status: 409 });
  }
  if (basename(runRoot) !== runId) {
    throw Object.assign(new Error("CP runDirectory does not match the primitive runId"), { code: "ROUTINE_ARTIFACT_BINDING_INVALID", status: 409 });
  }
  const inside = relative(runRoot, artifact);
  if (!inside || inside.startsWith("..") || isAbsolute(inside)
    || !extensionsInclude(extname(artifact).toLowerCase(), extensions)) {
    throw Object.assign(new Error("dump artifact escapes its CP run or has the wrong type"), { code: "ROUTINE_ARTIFACT_PATH_INVALID", status: 409 });
  }
  const stats = statSync(artifact);
  if (!stats.isFile() || stats.size <= 0 || stats.size > maxBytes) {
    throw Object.assign(new Error("dump artifact is empty, oversized, or not a regular file"), { code: "ROUTINE_ARTIFACT_INVALID", status: 409, details: { maxBytes } });
  }
  return readFileSync(artifact);
}

function extensionsInclude(ext, extensions) {
  return extensions.includes(ext);
}

/** XML convenience wrapper for the dump path. */
export function readBoundUtf8Artifact(input) {
  return readBoundArtifact({ ...input, extensions: [".xml"] }).toString("utf8");
}