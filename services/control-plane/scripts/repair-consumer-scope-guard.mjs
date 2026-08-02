#!/usr/bin/env node
/**
 * Scope guard for windows-repair-consumer-v1 source commits.
 *
 * Fail closed unless every touched path is on the explicit allowlist for this
 * batch. Always unions base...HEAD + staged + unstaged + untracked. Absolute
 * bans (root skills/SKILL.md, payment/approval/Standing Grant, secrets,
 * control.db, deploy configs) remain enforced.
 */
import { spawnSync } from "node:child_process";

export const REPAIR_CONSUMER_ALLOWED_PATHS = [
  /^contracts\/repair-[a-z0-9-]+\.v1\.schema\.json$/,
  /^docs\/handoffs\/2026-08-02-windows-repair-consumer-contract\.md$/,
  /^docs\/handoffs\/2026-08-02-xhs-observe-feed-repair-proposal\.v1\.json$/,
  /^scripts\/create-repair-proposal\.mjs$/,
  /^scripts\/lib\/repair-authority-verifiers\.mjs$/,
  /^scripts\/lib\/repair-consumer\.mjs$/,
  /^scripts\/lib\/repair-proposal\.mjs$/,
  /^scripts\/repair-consumer-scope-guard\.mjs$/,
  /^scripts\/repair-consumer\.mjs$/,
  /^tests\/repair-consumer\.test\.mjs$/,
  /^tests\/repair-proposal\.test\.mjs$/,
];

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

export function collectTouchedFiles(base = "origin/main") {
  function namesFrom(args) {
    const result = spawnSync("git", args, { encoding: "utf8" });
    if (result.status !== 0) return [];
    return (result.stdout || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  }
  return [...new Set([
    ...namesFrom(["diff", "--name-only", `${base}...HEAD`]),
    ...namesFrom(["diff", "--cached", "--name-only"]),
    ...namesFrom(["diff", "--name-only"]),
    ...namesFrom(["ls-files", "--others", "--exclude-standard"]),
  ])];
}

export function evaluateScopeGuard(files, {
  allowed = REPAIR_CONSUMER_ALLOWED_PATHS,
  forbidden = REPAIR_CONSUMER_FORBIDDEN_PATHS,
} = {}) {
  const unauthorized = [];
  const forbiddenHits = [];
  for (const file of files) {
    for (const pattern of forbidden) {
      if (pattern.test(file)) forbiddenHits.push({ file, pattern: String(pattern) });
    }
    if (!allowed.some((pattern) => pattern.test(file))) {
      unauthorized.push(file);
    }
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
  const result = evaluateScopeGuard(collectTouchedFiles(base));
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(2);
}
