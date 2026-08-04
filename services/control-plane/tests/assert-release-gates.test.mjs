import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(repoRoot, "scripts", "assert-release-gates.mjs");

test("assert-release-gates passes with XHS_ALLOW_DIRTY_WORKTREE=1", () => {
  const result = spawnSync(process.execPath, [script, repoRoot], {
    encoding: "utf8",
    env: { ...process.env, XHS_ALLOW_DIRTY_WORKTREE: "1" },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const line = result.stdout.trim().split(/\r?\n/).find((row) => row.startsWith("{"));
  assert.ok(line, "expected JSON stdout");
  const body = JSON.parse(line);
  assert.equal(body.ok, true);
  assert.equal(body.allowDirty, true);
  assert.equal(typeof body.trackedContentSha256, "string");
  assert.match(body.trackedContentSha256, /^[a-f0-9]{64}$/);
  assert.ok(body.fileCount >= 1);
});

test("AdapterRegistry requires verify and restore", async () => {
  const { AdapterRegistry } = await import("../control-plane/lib/control-plane.mjs");
  assert.throws(
    () => new AdapterRegistry([{ id: "stub", async execute() {} }]),
    /stub\.verify is required/,
  );
  assert.throws(
    () => new AdapterRegistry([{ id: "stub", async execute() {}, async verify() {} }]),
    /stub\.restore is required/,
  );
  assert.doesNotThrow(() => new AdapterRegistry([{
    id: "stub",
    async execute() {},
    async verify() {},
    async restore() {},
  }]));
});
