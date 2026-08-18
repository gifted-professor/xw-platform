import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { checkKernel, KERNEL_CONTRACTS } from "../kernel.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

test("kernel copies are byte-identical with both services", () => {
  const report = checkKernel(repoRoot);
  assert.equal(report.status, "PASS", report.blockers.join("\n"));
  assert.equal(report.fileCount, 6);
  assert.equal(KERNEL_CONTRACTS.length, 6);
  assert.ok(report.files.every((f) => f.match));
});

test("cli kernel emits PASS JSON", () => {
  const cli = join(repoRoot, "tools/fusion/cli.mjs");
  const r = spawnSync(process.execPath, [cli, "kernel", repoRoot], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const json = JSON.parse(r.stdout.trim().split("\n").at(-1));
  assert.equal(json.subcommand, "kernel");
  assert.equal(json.status, "PASS");
  assert.equal(json.copiedNotDeleted, true);
});
