#!/usr/bin/env node
/**
 * Scope guard for windows-repair-consumer-v1 source commits.
 *
 * Exact 16-path allowlist (no glob/regex wildcards for contracts).
 * Always unions base...HEAD + staged + unstaged + untracked.
 * Any git command failure or invalid baseline => fail closed.
 */
import { spawnSync } from "node:child_process";

export const REPAIR_CONSUMER_ALLOWED_PATHS = new Set([
  "contracts/repair-completion.v1.schema.json",
  "contracts/repair-event.v1.schema.json",
  "contracts/repair-proposal.v1.schema.json",
  "contracts/repair-replay-authorization.v1.schema.json",
  "contracts/repair-review-authority.v1.schema.json",
  "contracts/repair-source-checkpoint.v1.schema.json",
  "docs/handoffs/2026-08-02-windows-repair-consumer-contract.md",
  "docs/handoffs/2026-08-02-xhs-observe-feed-repair-proposal.v1.json",
  "scripts/create-repair-proposal.mjs",
  "scripts/lib/repair-authority-verifiers.mjs",
  "scripts/lib/repair-consumer.mjs",
  "scripts/lib/repair-proposal.mjs",
  "scripts/repair-consumer-scope-guard.mjs",
  "scripts/repair-consumer.mjs",
  "tests/repair-consumer.test.mjs",
  "tests/repair-proposal.test.mjs",
]);

export const REPAIR_CONSUMER_FORBIDDEN_PATHS = [
  /^skills\/SKILL\.md$/,
  /(^|\/)control\.db$/,
  /payment/i,
  /standing[-_]?grant/i,
  /(^|\/).*approval.*/i,
  /(^|\/).*token.*/i,
  /(^|\/).*secret.*/i,
  /^install-registry-task\.ps1$/,
  /^task-launch\.json$/,
  /^registry\.mjs$/,
];

function runGit(args) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.error) {
    throw new Error(`git ${args.join(" ")} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(`git ${args.join(" ")} failed: status=${result.status}${detail ? ` ${detail}` : ""}`);
  }
  return (result.stdout || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export function collectTouchedFiles(base = "origin/main") {
  // Invalid / unknown baseline must fail closed (never silently empty-ok).
  runGit(["rev-parse", "--verify", base]);
  return [...new Set([
    ...runGit(["diff", "--name-only", `${base}...HEAD`]),
    ...runGit(["diff", "--cached", "--name-only"]),
    ...runGit(["diff", "--name-only"]),
    ...runGit(["ls-files", "--others", "--exclude-standard"]),
  ])];
}

export function evaluateScopeGuard(files, {
  allowed = REPAIR_CONSUMER_ALLOWED_PATHS,
  forbidden = REPAIR_CONSUMER_FORBIDDEN_PATHS,
} = {}) {
  const allowedSet = allowed instanceof Set ? allowed : new Set(allowed);
  const unauthorized = [];
  const forbiddenHits = [];
  for (const file of files) {
    for (const pattern of forbidden) {
      if (pattern.test(file)) forbiddenHits.push({ file, pattern: String(pattern) });
    }
    if (!allowedSet.has(file)) unauthorized.push(file);
  }
  return {
    ok: forbiddenHits.length === 0 && unauthorized.length === 0,
    unauthorized,
    forbiddenHits,
    fileCount: files.length,
    files,
  };
}

const isDirectRun = process.argv[1]
  && /repair-consumer-scope-guard\.mjs$/.test(process.argv[1].replaceAll("\\", "/"));
if (isDirectRun) {
  const base = process.argv[2] || "origin/main";
  try {
    const result = evaluateScopeGuard(collectTouchedFiles(base));
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exit(2);
  } catch (error) {
    console.log(JSON.stringify({
      ok: false,
      error: error.message,
      fileCount: 0,
      files: [],
    }, null, 2));
    process.exit(2);
  }
}
