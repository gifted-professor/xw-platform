#!/usr/bin/env node
/**
 * M6-0 DSH inventory/lock conformance check.
 *
 * Verifies, for integrations/dsh-xw:
 *  - lock.json carries the full pinned shape (repo, version, commit, tree,
 *    packageManager) and matches packages/harness-protocol/locks/dsh.lock.v1.json;
 *  - the frozen inventory (services/orchestrator/contracts/m6/dsh-inventory.v1.json)
 *    agrees with the lock and records an explicit license status;
 *  - the adapter is explicitly marked as a fixture: README says Source-only with
 *    DSH_LIVE_GATE CLOSED, and plugin.mjs never spawns a real process
 *    (no node:child_process / spawn / exec references).
 *
 * Any missing field, drift, or removed fixture marker exits non-zero.
 *
 * Usage: node tools/m6/dsh-inventory-check.mjs [--json]
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const LOCK_PATH = "integrations/dsh-xw/lock.json";
const PROTOCOL_LOCK_PATH = "packages/harness-protocol/locks/dsh.lock.v1.json";
const PLUGIN_PATH = "integrations/dsh-xw/plugin.mjs";
const README_PATH = "integrations/dsh-xw/README.md";
const INVENTORY_PATH = "services/orchestrator/contracts/m6/dsh-inventory.v1.json";

const REQUIRED_LOCK_FIELDS = ["schemaId", "repo", "version", "commit", "tree", "packageManager"];
const HEX40 = /^[0-9a-f]{40}$/;

export function checkDshInventory(rootDir = REPO_ROOT) {
  const failures = [];
  const read = (rel) => {
    try {
      return JSON.parse(readFileSync(path.join(rootDir, rel), "utf8"));
    } catch (error) {
      failures.push(`${rel}: unreadable (${error.message})`);
      return null;
    }
  };
  const readText = (rel) => {
    try {
      return readFileSync(path.join(rootDir, rel), "utf8");
    } catch (error) {
      failures.push(`${rel}: unreadable (${error.message})`);
      return "";
    }
  };

  const lock = read(LOCK_PATH);
  const protocolLock = read(PROTOCOL_LOCK_PATH);
  const inventory = read(INVENTORY_PATH);
  const plugin = readText(PLUGIN_PATH);
  const readme = readText(README_PATH);

  if (lock) {
    for (const field of REQUIRED_LOCK_FIELDS) {
      if (!lock[field]) failures.push(`lock.json: missing field ${field}`);
    }
    if (lock.schemaId && lock.schemaId !== "xw.dsh.lock.v1") failures.push(`lock.json: schemaId ${lock.schemaId}`);
    if (lock.commit && !HEX40.test(lock.commit)) failures.push("lock.json: commit is not a 40-hex sha");
    if (lock.tree && !HEX40.test(lock.tree)) failures.push("lock.json: tree is not a 40-hex sha");
    if (lock.repo && lock.repo !== "deepseek-ai/deepseek-harness") failures.push(`lock.json: unexpected repo ${lock.repo}`);
  }
  if (lock && protocolLock) {
    for (const field of ["repo", "version", "commit", "tree", "packageManager"]) {
      if (lock[field] !== protocolLock[field]) {
        failures.push(`lock drift vs ${PROTOCOL_LOCK_PATH}: ${field} ${lock[field]} != ${protocolLock[field]}`);
      }
    }
  }

  if (inventory) {
    if (inventory.schemaId !== "xw.dsh-inventory.v1") failures.push("dsh-inventory: schemaId mismatch");
    for (const field of ["repo", "version", "commit", "tree", "packageManager"]) {
      if (lock && inventory.lock?.[field] !== lock[field]) {
        failures.push(`dsh-inventory: lock.${field} does not match lock.json`);
      }
    }
    if (inventory.fixture?.isFixture !== true) failures.push("dsh-inventory: fixture.isFixture marker missing or false");
    if (!inventory.license || !["verified", "unverified"].includes(inventory.license.status)) {
      failures.push("dsh-inventory: license.status must be explicit (verified|unverified)");
    }
    if (inventory.license?.status === "verified" && !inventory.license?.spdx) {
      failures.push("dsh-inventory: license verified but spdx missing");
    }
    if (!Array.isArray(inventory.apiShape?.allowedTools) || inventory.apiShape.allowedTools.length === 0) {
      failures.push("dsh-inventory: apiShape.allowedTools missing");
    }
  }

  // Fixture markers: the adapter must not pose as a real DSH/Cordis process.
  if (plugin) {
    if (/node:child_process|spawnSync|\bspawn\(|\bexec(File)?\(/.test(plugin)) {
      failures.push("plugin.mjs: process-spawn reference found; adapter must remain an in-memory fixture at M6-0");
    }
    if (!plugin.includes("DSH_LOCK_DRIFT")) {
      failures.push("plugin.mjs: lock-drift guard (DSH_LOCK_DRIFT) missing");
    }
  }
  if (readme) {
    if (!readme.includes("Source-only")) failures.push("README.md: 'Source-only' fixture marker removed");
    if (!/DSH_LIVE_GATE\s*=\s*CLOSED/.test(readme)) failures.push("README.md: 'DSH_LIVE_GATE = CLOSED' marker removed");
  }

  // No fabricated src/index.ts interface may appear in the fixture package.
  if (existsSync(path.join(rootDir, "integrations/dsh-xw/src"))) {
    failures.push("integrations/dsh-xw/src exists; M6-0 forbids a fabricated src/index.ts interface");
  }

  return { ok: failures.length === 0, failures };
}

function main() {
  const result = checkDshInventory();
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.ok) {
    process.stdout.write("DSH_INVENTORY_OK lock pinned, adapter marked fixture, license status recorded\n");
  } else {
    process.stdout.write(`DSH_INVENTORY_FAILED failures=${result.failures.length}\n`);
    for (const failure of result.failures) process.stdout.write(`  - ${failure}\n`);
  }
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
