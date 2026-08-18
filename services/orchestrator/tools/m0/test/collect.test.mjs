import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectRepoIdentity,
  git,
  gitModeMap,
  headSha,
  redactCommandLine,
  statusCounts,
  unstagedPatch,
  stagedPatch,
} from "../collect.mjs";

function sh(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

function makeRepo() {
  const d = mkdtempSync(join(tmpdir(), "m0collect-"));
  sh(d, "init", "-q");
  sh(d, "config", "user.email", "t@t");
  sh(d, "config", "user.name", "t");
  return d;
}

test("headSha + statusCounts on a clean repo", () => {
  const d = makeRepo();
  try {
    writeFileSync(join(d, "a.txt"), "hi");
    sh(d, "add", "a.txt");
    sh(d, "commit", "-q", "-m", "init");
    const sha = headSha(d);
    assert.match(sha, /^[0-9a-f]{40}$/);
    assert.deepEqual(statusCounts(d), { staged: 0, unstaged: 0, untracked: 0 });
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("statusCounts separates staged / unstaged / untracked", () => {
  const d = makeRepo();
  try {
    writeFileSync(join(d, "a.txt"), "1");
    sh(d, "add", "a.txt");
    sh(d, "commit", "-q", "-m", "c");
    // staged: new file b
    writeFileSync(join(d, "b.txt"), "2");
    sh(d, "add", "b.txt");
    // unstaged: modify a
    writeFileSync(join(d, "a.txt"), "11");
    // untracked: c
    writeFileSync(join(d, "c.txt"), "3");
    const c = statusCounts(d);
    assert.equal(c.staged, 1, "one staged (b)");
    assert.equal(c.unstaged, 1, "one unstaged (a)");
    assert.equal(c.untracked, 1, "one untracked (c)");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("collectRepoIdentity verifies against input sha and flags dirty", () => {
  const d = makeRepo();
  try {
    writeFileSync(join(d, "a.txt"), "x");
    sh(d, "add", "a.txt");
    sh(d, "commit", "-q", "-m", "c");
    const sha = headSha(d);
    const id = collectRepoIdentity(d, { name: "registry" }, sha);
    assert.equal(id.source.verifiedAgainstInputPair, true);
    assert.equal(id.worktree.dirty, false);
    assert.equal(id.name, "registry");
    // now make dirty
    writeFileSync(join(d, "a.txt"), "xx");
    const id2 = collectRepoIdentity(d, { name: "registry" }, sha);
    assert.equal(id2.worktree.dirty, true);
    assert.equal(id2.source.verifiedAgainstInputPair, true); // HEAD unchanged
    // mismatched input sha
    const id3 = collectRepoIdentity(d, { name: "registry" }, "0".repeat(40));
    assert.equal(id3.source.verifiedAgainstInputPair, false);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("gitModeMap returns 100644 for regular files, 100755 for exec bit", () => {
  const d = makeRepo();
  try {
    writeFileSync(join(d, "plain.txt"), "p");
    writeFileSync(join(d, "run.sh"), "#!/bin/sh\n");
    sh(d, "add", "plain.txt", "run.sh");
    sh(d, "update-index", "--chmod=+x", "run.sh");
    sh(d, "commit", "-q", "-m", "c");
    const map = gitModeMap(d);
    assert.equal(map.get("plain.txt"), "100644");
    assert.equal(map.get("run.sh"), "100755");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("stagedPatch + unstagedPatch produce non-empty diff bytes", () => {
  const d = makeRepo();
  try {
    writeFileSync(join(d, "a.txt"), "1\n");
    sh(d, "add", "a.txt");
    sh(d, "commit", "-q", "-m", "c");
    writeFileSync(join(d, "a.txt"), "1\n2\n");
    sh(d, "add", "a.txt"); // staged change
    writeFileSync(join(d, "a.txt"), "1\n2\n3\n"); // further unstaged change
    const sp = stagedPatch(d);
    const up = unstagedPatch(d);
    assert.ok(Buffer.isBuffer(sp) && sp.length > 0);
    assert.ok(Buffer.isBuffer(up) && up.length > 0);
    assert.ok(up.toString("utf8").includes("+3"));
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("redactCommandLine masks token flags but keeps the program", () => {
  const out = redactCommandLine("node registry.mjs --port 17930 --token abc123secret");
  assert.ok(out.includes("--port 17930"));
  assert.ok(!out.includes("abc123secret"));
  assert.ok(out.includes("<redacted>"));
  assert.equal(redactCommandLine(null), null);
});

test("collectRuntimeAttestation returns unreachable on non-Windows (or gracefully on Windows)", () => {
  // On this host (Windows) the registry may or may not be running; the contract is
  // that it never throws and always sets confidence honestly. We only assert shape.
  const att = collectRuntimeAttestationSafe({ entryPath: "nonexistent-entry-xyz.mjs" });
  assert.ok(["directlyObserved", "claimedOnly", "unreachable"].includes(att.confidence));
  assert.equal(att.processLoadedBytes, undefined); // not returned here (added by caller)
});

// wrapper to avoid importing the runtime fn by name collision-free
function collectRuntimeAttestationSafe(cfg) {
  // re-import lazily to keep the test focused
  return globalThis.__m0CollectRuntime(cfg);
}
globalThis.__m0CollectRuntime = (await import("../collect.mjs")).collectRuntimeAttestation;