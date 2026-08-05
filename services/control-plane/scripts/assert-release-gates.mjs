#!/usr/bin/env node
/**
 * Pre-start release gates for the control-plane worker (G0 / C0).
 *
 * Exit 0 when gates pass. Prints one JSON line to stdout.
 *
 * Env:
 *   XHS_ALLOW_DIRTY_WORKTREE=1     — allow dirty worktree
 *   XHS_REQUIRE_TEST_RECEIPT=1    — require runtime/release-test-receipt.json
 *   XHS_REQUIRE_MAIN_ORIGIN=1     — require branch main && HEAD==origin/main (fetch fail-closed)
 *   XHS_ALLOW_NON_MAIN=1          — skip main/origin check (tests only; worker must not set)
 *   XHS_RECEIPT_MAX_AGE_MS        — receipt freshness window (default 48h)
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

const repoRoot = resolve(process.argv[2] || process.cwd());
const allowDirty = process.env.XHS_ALLOW_DIRTY_WORKTREE === "1";
const requireReceipt = process.env.XHS_REQUIRE_TEST_RECEIPT === "1";
const requireMainOrigin = process.env.XHS_REQUIRE_MAIN_ORIGIN === "1"
  && process.env.XHS_ALLOW_NON_MAIN !== "1";
const receiptMaxAgeMs = Number(process.env.XHS_RECEIPT_MAX_AGE_MS || 48 * 60 * 60 * 1000);

const TRACKED_PREFIXES = ["apps/", "control-plane/", "scripts/", "contracts/"];

function fail(message, extra = {}) {
  const payload = {
    ok: false,
    dirty: extra.dirty ?? null,
    allowDirty,
    requireMainOrigin,
    requireReceipt,
    branch: extra.branch ?? null,
    head: extra.head ?? null,
    originMain: extra.originMain ?? null,
    trackedContentSha256: extra.trackedContentSha256 ?? null,
    fileCount: extra.fileCount ?? null,
    error: message,
  };
  console.log(JSON.stringify(payload));
  console.log(message);
  process.exit(1);
}

function git(args, { buffer = false, allowFail = false } = {}) {
  const result = spawnSync("git", ["-C", repoRoot, ...args], {
    encoding: buffer ? undefined : "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    if (allowFail) return null;
    fail(`git ${args[0]} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    if (allowFail) return null;
    const err = (buffer ? result.stderr?.toString("utf8") : result.stderr)
      || `git ${args.join(" ")} exited ${result.status}`;
    fail(String(err).trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout;
}

function isTrackedProductionPath(path) {
  return TRACKED_PREFIXES.some((prefix) => path === prefix.slice(0, -1) || path.startsWith(prefix));
}

function receiptBodyHash(receipt) {
  const copy = { ...receipt };
  delete copy.bodyHash;
  const canonical = `${JSON.stringify(copy, Object.keys(copy).sort())}\n`;
  return createHash("sha256").update(canonical).digest("hex");
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

const head = String(git(["rev-parse", "HEAD"])).trim();
const branch = String(git(["branch", "--show-current"])).trim();

let originMain = null;
if (requireMainOrigin) {
  const fetch = spawnSync("git", ["-C", repoRoot, "fetch", "--quiet", "origin", "main"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (fetch.error || fetch.status !== 0) {
    fail(
      `release gates failed: git fetch origin main failed (fail-closed): ${(fetch.stderr || fetch.error?.message || "").trim()}`,
      { dirty, head, branch },
    );
  }
  originMain = String(git(["rev-parse", "origin/main"])).trim();
  if (branch !== "main") {
    fail(`release gates failed: branch must be main (found ${branch || "(detached)"})`, {
      dirty, head, branch, originMain,
    });
  }
  if (head !== originMain) {
    fail(`release gates failed: HEAD (${head}) != origin/main (${originMain})`, {
      dirty, head, branch, originMain,
    });
  }
}

const tracked = git(["ls-files", "-z"])
  .split("\0")
  .filter(Boolean)
  .filter(isTrackedProductionPath)
  .sort();

const hasher = createHash("sha256");
for (const path of tracked) {
  let blob;
  const index = spawnSync("git", ["-C", repoRoot, "cat-file", "blob", `:${path}`], {
    maxBuffer: 64 * 1024 * 1024,
  });
  if (index.status === 0 && index.stdout) {
    blob = index.stdout;
  } else {
    const headBlob = spawnSync("git", ["-C", repoRoot, "cat-file", "blob", `HEAD:${path}`], {
      maxBuffer: 64 * 1024 * 1024,
    });
    if (headBlob.status === 0 && headBlob.stdout) {
      blob = headBlob.stdout;
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
      dirty, head, branch, originMain, trackedContentSha256, fileCount,
    });
  }
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  } catch (error) {
    fail(`release gates failed: unreadable test receipt: ${error.message}`, {
      dirty, head, branch, originMain, trackedContentSha256, fileCount,
    });
  }
  if (receipt?.ok !== true) {
    fail("release gates failed: receipt.ok must be true", {
      dirty, head, branch, originMain, trackedContentSha256, fileCount,
    });
  }
  if (typeof receipt.gitCommit !== "string" || receipt.gitCommit !== head) {
    fail(`release gates failed: receipt.gitCommit must equal HEAD (${head})`, {
      dirty, head, branch, originMain, trackedContentSha256, fileCount,
    });
  }
  if (typeof receipt.command !== "string" || !receipt.command.trim()) {
    fail("release gates failed: receipt.command is required", {
      dirty, head, branch, originMain, trackedContentSha256, fileCount,
    });
  }
  if (!Number.isInteger(receipt.passed) || receipt.passed < 0
    || !Number.isInteger(receipt.failed) || receipt.failed < 0) {
    fail("release gates failed: receipt.passed/failed must be non-negative integers", {
      dirty, head, branch, originMain, trackedContentSha256, fileCount,
    });
  }
  if (receipt.failed !== 0) {
    fail("release gates failed: receipt.failed must be 0", {
      dirty, head, branch, originMain, trackedContentSha256, fileCount,
    });
  }
  const completedAt = Date.parse(receipt.completedAt);
  if (!Number.isFinite(completedAt)) {
    fail("release gates failed: receipt.completedAt must be ISO time", {
      dirty, head, branch, originMain, trackedContentSha256, fileCount,
    });
  }
  const age = Date.now() - completedAt;
  if (age < 0 || age > receiptMaxAgeMs) {
    fail(`release gates failed: receipt expired or from the future (ageMs=${age})`, {
      dirty, head, branch, originMain, trackedContentSha256, fileCount,
    });
  }
  const expectedHash = receiptBodyHash(receipt);
  if (typeof receipt.bodyHash !== "string" || receipt.bodyHash !== expectedHash) {
    fail("release gates failed: receipt.bodyHash mismatch", {
      dirty, head, branch, originMain, trackedContentSha256, fileCount,
    });
  }
}

const result = {
  ok: true,
  dirty,
  allowDirty,
  requireMainOrigin,
  requireReceipt,
  branch,
  head,
  originMain,
  trackedContentSha256,
  fileCount,
};
console.log(JSON.stringify(result));
process.exit(0);
