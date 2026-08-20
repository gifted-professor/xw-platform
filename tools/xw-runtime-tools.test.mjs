import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("FastOperator installer registers SYSTEM tasks with an AtStartup trigger", () => {
  const source = read("services/control-plane/scripts/fast-operator-serve-task.ps1");
  assert.match(source, /New-ScheduledTaskTrigger\s+-AtStartup/);
  assert.match(source, /Register-ScheduledTask[^\r\n]+-Trigger\s+\$trigger/);
  assert.match(source, /New-ScheduledTaskPrincipal\s+-UserId\s+"SYSTEM"/);
});

test("runtime checker requires enabled healthy tasks, exact principal, run level and trigger", () => {
  const source = read("tools/check-xw-runtime.ps1");
  for (const signal of ["$enabled", "$stateOk", "$principalOk", "$runLevelOk", "$triggerOk"]) {
    assert.match(source, new RegExp(`\\${signal}\\b`));
  }
  const contract = JSON.parse(read("config/runtime/xw-runtime.v1.json"));
  assert.ok(contract.directories.includes("state/orchestrator/trace"));
  assert.equal(contract.scheduledTasks.length, 6);
  for (const task of contract.scheduledTasks) {
    assert.equal(task.principal, "SYSTEM");
    assert.equal(task.requiredTrigger, "MSFT_TaskBootTrigger");
    assert.ok(["Limited", "Highest"].includes(task.runLevel));
  }
});

test("skill install validates staging before swapping and preserves a rollback backup", () => {
  const source = read("tools/sync-xw-skill.ps1");
  assert.match(source, /Assert-SafeManagedTarget/);
  assert.match(source, /Assert-FileSet\s+\$source\s+\$staging/);
  assert.match(source, /Move-Item\s+-LiteralPath\s+\$target\s+-Destination\s+\$backup/);
  assert.match(source, /Move-Item\s+-LiteralPath\s+\$backup\s+-Destination\s+\$target/);
});
