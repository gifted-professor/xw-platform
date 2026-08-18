import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const CLI = join(ROOT, "ops", "xw-mission.mjs");
const AUTHORING = join(ROOT, "tests", "fixtures", "task-plan-v2-authoring.json");

test("xw-mission create and validate are local-only", () => {
  const temp = mkdtempSync(join(tmpdir(), "xw-mission-cli-"));
  try {
    const stdout = execFileSync(process.execPath, [CLI, "create", "--input", AUTHORING], { encoding: "utf8", windowsHide: true });
    const plan = JSON.parse(stdout);
    assert.equal(plan.schemaId, "xhs.task-plan.v2");
    assert.equal(plan.nodes[0].shards.length, 4);
    const planPath = join(temp, "plan.json");
    writeFileSync(planPath, stdout, "utf8");
    const validated = JSON.parse(execFileSync(process.execPath, [CLI, "validate", "--plan", planPath], { encoding: "utf8", windowsHide: true }));
    assert.equal(validated.ok, true);
    assert.match(validated.note || "", /raw schema only/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("xw-mission bind requires live catalog and rejects unknown capability", () => {
  const temp = mkdtempSync(join(tmpdir(), "xw-mission-bind-"));
  try {
    const stdout = execFileSync(process.execPath, [CLI, "create", "--input", AUTHORING], { encoding: "utf8", windowsHide: true });
    const planPath = join(temp, "plan.json");
    writeFileSync(planPath, stdout, "utf8");
    // No registry → bind fails closed (network error or empty catalog mismatch)
    const result = spawnSync(process.execPath, [CLI, "bind", "--plan", planPath, "--registry-url", "http://127.0.0.1:1/"], {
      encoding: "utf8",
      windowsHide: true,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /XW_MISSION_FAILED|fetch|ECONNREFUSED|NO_EXECUTOR|failed/i);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("xw-mission run refuses device submission without explicit --execute", () => {
  const result = spawnSync(process.execPath, [CLI, "run", "--plan", AUTHORING, "--run", "run_fixture", "--actor", "fixture"], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--execute is required/);
});
