#!/usr/bin/env node
/**
 * Write runtime/release-test-receipt.json bound to current HEAD.
 * Usage:
 *   node scripts/write-release-test-receipt.mjs --command "npm test" --passed 10 --failed 0
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

function opt(argv, name, fallback = null) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
}

const repoRoot = resolve(opt(process.argv.slice(2), "--repo", process.cwd()));
const command = opt(process.argv.slice(2), "--command", "npm test");
const passed = Number(opt(process.argv.slice(2), "--passed", "0"));
const failed = Number(opt(process.argv.slice(2), "--failed", "0"));

const head = spawnSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" });
if (head.status !== 0) {
  console.log(JSON.stringify({ ok: false, error: "unable to resolve HEAD" }));
  process.exit(1);
}

const receipt = {
  ok: failed === 0,
  gitCommit: head.stdout.trim(),
  command,
  passed,
  failed,
  completedAt: new Date().toISOString(),
};

const copy = { ...receipt };
const canonical = `${JSON.stringify(copy, Object.keys(copy).sort())}\n`;
receipt.bodyHash = createHash("sha256").update(canonical).digest("hex");

const dir = join(repoRoot, "runtime");
mkdirSync(dir, { recursive: true });
const path = join(dir, "release-test-receipt.json");
writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ ok: true, path, gitCommit: receipt.gitCommit, bodyHash: receipt.bodyHash }));
