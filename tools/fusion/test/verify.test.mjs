import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { applyPostImportAllowlist, assertPostImportAllowlistSafe, verifyRepo } from "../verify.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

test("verifyRepo passes against the imported xw-platform checkout", () => {
  const report = verifyRepo(repoRoot);
  assert.equal(report.status, "PASS", report.blockers.join("\n"));
  assert.equal(report.runtimeCutoverAllowed, false);
  assert.equal(report.services.length, 2);
  const [registry, deviceAgent] = report.services;
  assert.equal(registry.importDir, "services/orchestrator");
  assert.equal(deviceAgent.importDir, "services/control-plane");
  assert.equal(registry.expectedCount, 399);
  assert.equal(deviceAgent.expectedCount, 256);
  assert.equal(registry.blobMismatchCount, 0);
  assert.equal(deviceAgent.blobMismatchCount, 0);
  assert.equal(registry.extraFileCount, 0);
  assert.equal(deviceAgent.extraFileCount, 0);
  assert.equal(deviceAgent.missingFileCount, 0);
  assert.equal(registry.missingFileCount, 0);
  assert.ok(registry.probes.every((p) => p.reachable));
  assert.ok(deviceAgent.probes.every((p) => p.reachable));
});

test("verifyRepo blocks when a receipt is missing", () => {
  const report = verifyRepo(here);
  assert.equal(report.status, "BLOCK");
  assert.ok(report.blockers.some((b) => b.includes("missing")));
});

test("cli test-gate --suite does not treat the flag as a repo root", () => {
  const cli = join(repoRoot, "tools/fusion/cli.mjs");
  const r = spawnSync(process.execPath, [cli, "test-gate", "--suite", "does-not-exist", repoRoot], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(r.status, 1, r.stderr || r.stdout);
  const json = JSON.parse(r.stdout.trim().split("\n").at(-1));
  assert.equal(json.status, "BLOCK");
  assert.deepEqual(json.unexpectedFailures, ["unknown suite: does-not-exist"]);
});

test("cli verify emits PASS JSON and exit 0", () => {
  const cli = join(repoRoot, "tools/fusion/cli.mjs");
  const r = spawnSync(process.execPath, [cli, "verify", repoRoot], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const json = JSON.parse(r.stdout.trim().split("\n").at(-1));
  assert.equal(json.subcommand, "verify");
  assert.equal(json.status, "PASS");
  assert.equal(json.cliVersion, "xhs.fusion.cli.v1");
});

test("allowlisted blob is not an allowlisted mode; missing and unknown extra stay BLOCK", () => {
  const gated = applyPostImportAllowlist({
    blobMismatchCount: 1,
    modeMismatchCount: 1,
    missingFileCount: 1,
    extraFileCount: 2,
    expectedCount: 4,
    actualCount: 5,
    details: [
      { path: "keep.mjs", kind: "blob" },
      { path: "keep.mjs", kind: "mode" },
      { path: "gone.mjs", kind: "missing" },
      { path: "new.mjs", kind: "extra" },
      { path: "other.mjs", kind: "extra" },
    ],
  }, {
    allowedBlobModified: ["keep.mjs"],
    allowedModeModified: [],
    allowedExtra: ["new.mjs"],
  });
  assert.equal(gated.blobMismatchCount, 0);
  assert.equal(gated.modeMismatchCount, 1, "blob allowlist must not swallow mode mismatch");
  assert.equal(gated.missingFileCount, 1);
  assert.equal(gated.extraFileCount, 1);
  assert.deepEqual(gated.details.map((d) => `${d.kind}:${d.path}`).sort(), [
    "extra:other.mjs",
    "missing:gone.mjs",
    "mode:keep.mjs",
  ]);
  assert.throws(
    () => assertPostImportAllowlistSafe({ runtimeCutoverAllowed: true }),
    /runtimeCutoverAllowed must be false/,
  );
});
