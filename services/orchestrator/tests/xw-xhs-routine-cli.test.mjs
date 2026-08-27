/**
 * xw-xhs-routine-cli.test.mjs — CLI surface integration (direct-routine plan
 * V2 §1/§6/§10.1): three call surfaces converge on one planHash; --execute
 * fails closed without a session-bound driver (plan printing is never
 * execution evidence); social templates are canary-gated; sealed plan-file
 * tamper is rejected before any I/O.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = new URL("../ops/xw-xhs-routine.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const FAKE_DRIVER = new URL("./fixtures/xhs-routine-fake-driver.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

function runCli(argv) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...argv], { encoding: "utf8" }, (err, stdout) => {
      resolve({ stdout: stdout || "", code: err ? (err.code ?? 1) : 0 });
    });
  });
}

test("catalog lists exactly the four V2 templates, alias 04", async () => {
  const { code, stdout } = await runCli(["catalog"]);
  assert.equal(code, 0);
  const out = JSON.parse(stdout);
  assert.equal(out.ok, true);
  assert.equal(out.alias, "04");
  assert.deepEqual(out.templates.map((t) => t.id), [
    "xhs.scout.home.v1",
    "xhs.feed-play.v1",
    "xhs.nurture-lite.v1",
    "xhs.nurture-grounded.v1",
  ]);
});

test("run --plan emits the sealed plan and never executes (executionReady=false)", async () => {
  const { code, stdout } = await runCli(["run", "--template", "feed-play", "--items", "3", "--plan"]);
  assert.equal(code, 0);
  const plan = JSON.parse(stdout);
  assert.equal(plan.ok, true);
  assert.equal(plan.executionReady, false);
  assert.equal(plan.template, "xhs.feed-play.v1");
  assert.equal(plan.alias, "04");
  assert.match(plan.planHash, /^[a-f0-9]{64}$/);
  assert.equal(plan.routineRunId, `rr_${plan.planHash.slice(0, 16)}`);
  assert.equal(plan.templateSpec, undefined, "templateSpec is server-sealed, never emitted");
});

test("CLI flags and NL goal surface converge on the same planHash", async () => {
  const flags = await runCli(["run", "--template", "feed-play", "--items", "3", "--dwell", "5:12", "--plan"]);
  const goal = await runCli(["goal", "帮我刷一会小红书 feed", "--items", "3", "--dwell", "5:12"]);
  assert.equal(flags.code, 0);
  assert.equal(goal.code, 0);
  const a = JSON.parse(flags.stdout);
  const b = JSON.parse(goal.stdout);
  assert.equal(b.template, "xhs.feed-play.v1", "goal maps to feed-play");
  assert.equal(b.goalSignature, "帮我刷一会小红书 feed");
  assert.equal(a.planHash, b.planHash, "same semantic plan -> same planHash regardless of surface");
});

test("unresolvable goal -> ROUTINE_GOAL_UNRESOLVED, no plan invented", async () => {
  const { code, stdout } = await runCli(["goal", "帮我把这条笔记删掉"]);
  assert.equal(code, 4);
  const out = JSON.parse(stdout);
  assert.equal(out.ok, false);
  assert.equal(out.error.code, "ROUTINE_GOAL_UNRESOLVED");
});

test("alias 01 rejected at CLI plan stage, exit 3", async () => {
  const { code, stdout } = await runCli(["run", "--template", "feed-play", "--alias", "01", "--plan"]);
  assert.equal(code, 3);
  const out = JSON.parse(stdout);
  assert.equal(out.error.code, "ROUTINE_ALIAS_NOT_04");
});

test("--execute without driver fails closed ROUTINE_EXECUTOR_UNAVAILABLE, exit 4", async () => {
  const { code, stdout } = await runCli(["run", "--template", "feed-play", "--items", "2", "--execute"]);
  assert.equal(code, 4);
  const out = JSON.parse(stdout);
  assert.equal(out.ok, false);
  assert.equal(out.error.code, "ROUTINE_EXECUTOR_UNAVAILABLE");
});

test("social template --execute is canary-gated before the driver check", async () => {
  const { code, stdout } = await runCli(["run", "--template", "nurture-lite", "--items", "2", "--execute"]);
  assert.equal(code, 4);
  const out = JSON.parse(stdout);
  assert.equal(out.error.code, "ROUTINE_EFFECT_GATED");
});

test("--execute with fake driver-module runs the machine and emits a full receipt", async () => {
  const { code, stdout } = await runCli([
    "run", "--template", "feed-play", "--items", "2", "--dwell", "2:3",
    "--execute", "--driver-module", FAKE_DRIVER,
  ]);
  assert.equal(code, 0);
  const out = JSON.parse(stdout);
  assert.equal(out.ok, true);
  assert.equal(out.command, "execute");
  assert.equal(out.receipt.status, "SUCCEEDED");
  assert.equal(out.receipt.items.length, 2);
  assert.equal(out.receipt.transport.count, 0, "feed-play is effectClass none — zero transport");
  assert.equal(out.receipt.cleanup.activeLeases, 0);
  assert.ok(out.receipt.items.every((it) => it.opened === true));
});

test("tampered sealed plan-file -> ROUTINE_PLAN_TAMPERED before any I/O", async () => {
  const planOut = await runCli(["run", "--template", "feed-play", "--items", "2", "--plan"]);
  const plan = JSON.parse(planOut.stdout);
  const tampered = { ...plan, params: { ...plan.params, items: 99 } };
  const dir = mkdtempSync(join(tmpdir(), "xhs-routine-"));
  const file = join(dir, "plan.json");
  writeFileSync(file, JSON.stringify(tampered), "utf8");
  const { code, stdout } = await runCli(["run", "--plan-file", file, "--execute"]);
  assert.equal(code, 4);
  const out = JSON.parse(stdout);
  assert.equal(out.error.code, "ROUTINE_PLAN_TAMPERED");
});