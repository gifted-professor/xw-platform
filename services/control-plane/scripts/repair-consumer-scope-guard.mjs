#!/usr/bin/env node
/**
 * Scope guard for windows-repair-consumer-v1 source commits.
 * Fails if the branch diff touches payment/approval/standing-grant/auth secrets,
 * control.db, root skills/SKILL.md, or deployment task configs.
 */
import { spawnSync } from "node:child_process";

const FORBIDDEN = [
  /^skills\/SKILL\.md$/,
  /(^|\/)control\.db$/,
  /payment/i,
  /standing-grant/i,
  /(^|\/).*approval.*/i,
  /(^|\/).*token.*/i,
  /(^|\/).*secret.*/i,
  /^install-registry-task\.ps1$/,
  /^task-launch\.json$/,
  /^registry\.mjs$/,
];

const base = process.argv[2] || "origin/main";
const cachedOnly = process.argv.includes("--cached");
const args = cachedOnly
  ? ["diff", "--cached", "--name-only"]
  : ["diff", "--name-only", `${base}...HEAD`];
const diff = spawnSync("git", args, { encoding: "utf8" });
if (diff.status !== 0) {
  // Uncommitted work: fall back to cached + unstaged names against base.
  const staged = spawnSync("git", ["diff", "--cached", "--name-only"], { encoding: "utf8" });
  const unstaged = spawnSync("git", ["diff", "--name-only"], { encoding: "utf8" });
  const untracked = spawnSync("git", ["ls-files", "--others", "--exclude-standard"], { encoding: "utf8" });
  const files = [...new Set([
    ...(staged.stdout || "").split(/\r?\n/),
    ...(unstaged.stdout || "").split(/\r?\n/),
    ...(untracked.stdout || "").split(/\r?\n/),
  ].map((line) => line.trim()).filter(Boolean))];
  finish(files);
} else {
  const files = diff.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (files.length === 0 && !cachedOnly) {
    const staged = spawnSync("git", ["diff", "--cached", "--name-only"], { encoding: "utf8" });
    finish((staged.stdout || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  } else {
    finish(files);
  }
}

function finish(files) {
  const hits = [];
  for (const file of files) {
    for (const pattern of FORBIDDEN) {
      if (pattern.test(file)) hits.push({ file, pattern: String(pattern) });
    }
  }
  if (hits.length) {
    console.log(JSON.stringify({ ok: false, hits, files }, null, 2));
    process.exit(2);
  }
  console.log(JSON.stringify({ ok: true, fileCount: files.length, files }, null, 2));
}
