import { spawnSync } from "node:child_process";

export function git(root, args, { allowFail = false } = {}) {
  const result = spawnSync("git", ["-C", root, "-c", "core.quotepath=false", ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (!allowFail && result.status !== 0) {
    const err = (result.stderr || result.stdout || `git ${args.join(" ")} failed`).trim();
    const error = new Error(err);
    error.status = result.status;
    throw error;
  }
  return {
    status: result.status ?? 1,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

export function parseLsTree(text) {
  const entries = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const meta = line.slice(0, tab);
    const path = line.slice(tab + 1);
    const [mode, type, oid] = meta.split(" ");
    entries.push({ path, mode, type, oid });
  }
  return entries;
}

export function listingIndex(entries) {
  const map = new Map();
  for (const entry of entries) map.set(entry.path, entry);
  return map;
}

export function compareListings(expected, actual) {
  const exp = listingIndex(expected);
  const act = listingIndex(actual);
  let blobMismatchCount = 0;
  let modeMismatchCount = 0;
  let missingFileCount = 0;
  let extraFileCount = 0;
  const details = [];

  for (const [path, want] of exp) {
    const got = act.get(path);
    if (!got) {
      missingFileCount += 1;
      details.push({ path, kind: "missing" });
      continue;
    }
    if (got.oid !== want.oid || got.type !== want.type) {
      blobMismatchCount += 1;
      details.push({ path, kind: "blob", expected: want.oid, actual: got.oid });
    }
    if (got.mode !== want.mode) {
      modeMismatchCount += 1;
      details.push({ path, kind: "mode", expected: want.mode, actual: got.mode });
    }
  }
  for (const path of act.keys()) {
    if (!exp.has(path)) {
      extraFileCount += 1;
      details.push({ path, kind: "extra" });
    }
  }
  return {
    blobMismatchCount,
    modeMismatchCount,
    missingFileCount,
    extraFileCount,
    expectedCount: expected.length,
    actualCount: actual.length,
    details,
  };
}
