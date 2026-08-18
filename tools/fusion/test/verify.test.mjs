import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { verifyRepo } from "../verify.mjs";

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
  assert.equal(registry.trackedFileCount, 399);
  assert.equal(deviceAgent.trackedFileCount, 256);
  assert.equal(registry.blobMismatchCount, 0);
  assert.equal(deviceAgent.blobMismatchCount, 0);
  assert.ok(registry.probes.every((p) => p.reachable));
  assert.ok(deviceAgent.probes.every((p) => p.reachable));
});

test("verifyRepo blocks when a receipt is missing", () => {
  const report = verifyRepo(here);
  assert.equal(report.status, "BLOCK");
  assert.ok(report.blockers.some((b) => b.includes("missing")));
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
