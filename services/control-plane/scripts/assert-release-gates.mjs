#!/usr/bin/env node
/**
 * Pre-start release gates for the control-plane worker.
 *
 * Exit 0 when gates pass. Prints one JSON line to stdout:
 *   { ok, dirty, allowDirty, trackedContentSha256, fileCount }
 *
 * Env:
 *   XHS_ALLOW_DIRTY_WORKTREE=1  — allow a dirty worktree (default: refuse)
 *   XHS_REQUIRE_TEST_RECEIPT=1  — require runtime/release-test-receipt.json {ok:true}
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

const repoRoot = resolve(process.argv[2] || process.cwd());
const allowDirty = process.env.XHS_ALLOW_DIRTY_WORKTREE === "1";
const requireReceipt = process.env.XHS_REQUIRE_TEST_RECEIPT === "1";

function fail(message, extra = {}) {
  const payload = {
    ok: false,
    dirty: extra.dirty ?? null,
    allowDirty,
    trackedContentSha256: extra.trackedContentSha256 ?? null,
    fileCount: extra.fileCount ?? null,
    error: message,
  };
  console.log(JSON.stringify(payload));
  console.log(message);
  process.exit(1);
}

function git(args, { buffer = false } = {}) {
  const result = spawnSync("git", ["-C", repoRoot, ...args], {
    encoding: buffer ? undefined : "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) fail(`git ${args[0]} failed: ${result.error.message}`);
  if (result.status !== 0) {
    const err = (buffer ? result.stderr?.toString("utf8") : result.stderr) || `git ${args.join(" ")} exited ${result.status}`;
    fail(String(err).trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout;
}

if (!existsSync(repoRoot)) {
  fail(`release gates failed: repo root missing: ${repoRoot}`);
}

const porcelain = git(["status", "--porcelain"]);
const dirty = porcelain.trim().length > 0;
if (dirty && !allowDirty) {
  fail(
    "release gates failed: worktree is dirty; set XHS_ALLOW_DIRTY_WORKTREE=1 to allow, or commit/clean first",
    { dirty },
  );
}

const tracked = git(["ls-files", "-z"])
  .split("\0")
  .filter(Boolean)
  .filter((path) => (
    path.startsWith("apps/")
    || path === "control-plane/bootstrap.mjs"
    || path === "control-plane/lib/capability-registry.mjs"
  ))
  .sort();

const hasher = createHash("sha256");
for (const path of tracked) {
  // Prefer git blob (index) so the fingerprint is path+blob, not arbitrary worktree noise.
  // Fall back to HEAD blob, then working-tree bytes if the path is newly staged.
  let blob;
  const index = spawnSync("git", ["-C", repoRoot, "cat-file", "blob", `:${path}`], {
    maxBuffer: 64 * 1024 * 1024,
  });
  if (index.status === 0 && index.stdout) {
    blob = index.stdout;
  } else {
    const head = spawnSync("git", ["-C", repoRoot, "cat-file", "blob", `HEAD:${path}`], {
      maxBuffer: 64 * 1024 * 1024,
    });
    if (head.status === 0 && head.stdout) {
      blob = head.stdout;
    } else {
      blob = readFileSync(join(repoRoot, path));
    }
  }
  hasher.update(path);
  hasher.update("\0");
  hasher.update(blob);
  hasher.update("\0");
}

const trackedContentSha256 = hasher.digest("hex");
const fileCount = tracked.length;

if (requireReceipt) {
  const receiptPath = join(repoRoot, "runtime", "release-test-receipt.json");
  if (!existsSync(receiptPath)) {
    fail(`release gates failed: missing test receipt at ${receiptPath}`, {
      dirty,
      trackedContentSha256,
      fileCount,
    });
  }
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  } catch (error) {
    fail(`release gates failed: unreadable test receipt: ${error.message}`, {
      dirty,
      trackedContentSha256,
      fileCount,
    });
  }
  if (receipt?.ok !== true) {
    fail("release gates failed: runtime/release-test-receipt.json must have {ok:true}", {
      dirty,
      trackedContentSha256,
      fileCount,
    });
  }
}

const result = {
  ok: true,
  dirty,
  allowDirty,
  trackedContentSha256,
  fileCount,
};
console.log(JSON.stringify(result));
process.exit(0);
