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

import { runRoutineCli } from "../ops/xw-xhs-routine.mjs";

const CLI = new URL("../ops/xw-xhs-routine.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const DISPATCH_CLI = new URL("../ops/xw-xhs.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const FAKE_DRIVER = new URL("./fixtures/xhs-routine-fake-driver.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const FAKE_BRIDGE = new URL("./fixtures/xhs-routine-effect-bridge-fixture.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

function runCli(argv, { env = {} } = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...argv], { encoding: "utf8", env: { ...process.env, ...env } }, (err, stdout) => {
      resolve({ stdout: stdout || "", code: err ? (err.code ?? 1) : 0 });
    });
  });
}

function runDispatchCli(argv, { env = {} } = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [DISPATCH_CLI, ...argv], { encoding: "utf8", env: { ...process.env, ...env } }, (err, stdout) => {
      resolve({ stdout: stdout || "", code: err ? (err.code ?? 1) : 0 });
    });
  });
}

async function runCliInProcess(argv, dependencies = {}) {
  const lines = [];
  const originalLog = console.log;
  const originalExitCode = process.exitCode;
  console.log = (...values) => lines.push(values.join(" "));
  process.exitCode = undefined;
  try {
    await runRoutineCli(argv, dependencies);
    return { stdout: lines.join("\n"), code: process.exitCode ?? 0 };
  } finally {
    console.log = originalLog;
    process.exitCode = originalExitCode;
  }
}

const FEED_XML = '<node class="android.widget.ImageView" content-desc="笔记 攀岩入门三条路线 来自小岩 123赞" text="" clickable="true" bounds="[40,400][500,900]"/>';
const DETAIL_XML = '<node class="android.widget.TextView" content-desc="点赞" text="" bounds="[40,2200][140,2300]"/>'
  + '<node class="android.widget.TextView" content-desc="评论 3" text="" bounds="[240,2200][340,2300]"/>';

function routineRuntimeFixture({ releaseFails = false } = {}) {
  let page = "feed";
  let creates = 0;
  const leases = [{ leaseId: "lease-03", sessionId: "session-03", deviceId: "device-03" }];
  const runtime = {
    get creates() { return creates; },
    sleepFn: async () => {},
    async createSession({ placement }) {
      creates += 1;
      assert.deepEqual(placement, { alias: "03" });
      return { sessionId: "session-03", leaseId: "lease-03", token: "private", deviceId: "device-03" };
    },
    async executeSessionAction(_sessionId, _token, action) {
      const primitive = action.params.primitive;
      let output = { ok: true };
      if (primitive === "focus") {
        output = page === "feed"
          ? { ok: true, package: "com.xingin.xhs", activity: "com.xingin.xhs.index.v2.IndexActivityV2" }
          : { ok: true, package: "com.xingin.xhs", activity: "com.xingin.xhs.note.NoteDetailActivity" };
      }
      if (primitive === "dump_ui") output = { ok: true, xml: page === "feed" ? FEED_XML : DETAIL_XML };
      if (primitive === "tap") page = "detail";
      if (primitive === "back" || primitive === "launch_app") page = "feed";
      return { jobId: `job-${primitive}`, status: "succeeded", output };
    },
    async heartbeatSession() { return { ok: true }; },
    async releaseSession() {
      if (releaseFails) throw Object.assign(new Error("release down"), { code: "RELEASE_DOWN" });
      leases.splice(0, leases.length);
      return { released: true };
    },
    async listLeases() { return [...leases]; },
    readDumpArtifact() { throw new Error("inline XML should not read an artifact"); },
    async getDevice() { return { metadata: { width: 1080, height: 2400 } }; },
  };
  return runtime;
}

function traceWriterFixture() {
  return ({ plan, routineRun }) => ({
    path: `C:\\trace\\${routineRun.executionRunId}.json`,
    trace: { schemaId: "xw.xhs.routine-trace.v1", plan, routineRun },
  });
}

test("CLI exports the same runRoutineCli entry for /xw delegation", async () => {
  const mod = await import(new URL("../ops/xw-xhs-routine.mjs", import.meta.url).href);
  assert.equal(typeof mod.runRoutineCli, "function");
});

test("/xw xhs routine delegates to the same 03-first planner", async () => {
  const direct = await runCli(["run", "feed-play", "--items", "2", "--plan"]);
  const delegated = await runDispatchCli(["routine", "feed-play", "--items", "2", "--plan"]);
  assert.equal(direct.code, 0);
  assert.equal(delegated.code, 0);
  const directPlan = JSON.parse(direct.stdout);
  const delegatedPlan = JSON.parse(delegated.stdout);
  assert.equal(delegatedPlan.planHash, directPlan.planHash);
  assert.equal(delegatedPlan.alias, "03");
  assert.deepEqual(delegatedPlan.placement.aliases, ["03"]);
});

test("catalog lists four templates and versioned 03-first placement", async () => {
  const { code, stdout } = await runCli(["catalog"]);
  assert.equal(code, 0);
  const out = JSON.parse(stdout);
  assert.equal(out.ok, true);
  assert.equal(out.alias, "03");
  assert.equal(out.primaryAlias, "03");
  assert.equal(out.secondaryAlias, "04");
  assert.equal(out.placementPolicy.id, "xw.xhs.placement.03-first.v1");
  assert.equal(out.placementPolicy.automaticFallback, false);
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
  assert.equal(plan.alias, "03");
  assert.deepEqual(plan.placement.aliases, ["03"]);
  assert.match(plan.planHash, /^[a-f0-9]{64}$/);
  assert.equal(plan.routineRunId, undefined, "plan-only serialization has no execution identity");
  assert.equal(plan.executionRunId, undefined);
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

test("goal surface applies the same social-on-04 fail-closed placement policy", async () => {
  const { code, stdout } = await runCli(["goal", "养号", "--parallel", "2"]);
  assert.equal(code, 3);
  assert.equal(JSON.parse(stdout).error.code, "ROUTINE_SECONDARY_EFFECT_CLASS_FORBIDDEN");
});

test("aliases 01/02 rejected and alias 04 single requires explicit concurrency", async () => {
  const { code, stdout } = await runCli(["run", "--template", "feed-play", "--alias", "01", "--plan"]);
  assert.equal(code, 3);
  const out = JSON.parse(stdout);
  assert.equal(out.error.code, "ROUTINE_ALIAS_NOT_ALLOWED");

  const secondary = await runCli(["run", "--template", "feed-play", "--alias", "04", "--plan"]);
  assert.equal(secondary.code, 3);
  assert.equal(JSON.parse(secondary.stdout).error.code, "ROUTINE_SECONDARY_REQUIRES_EXPLICIT_CONCURRENCY");
});

test("module injection without the double fixture gate is rejected before import or CP", async () => {
  const { code, stdout } = await runCli([
    "run", "--template", "feed-play", "--items", "2", "--execute", "--driver-module", FAKE_DRIVER,
  ]);
  assert.equal(code, 4);
  const out = JSON.parse(stdout);
  assert.equal(out.ok, false);
  assert.equal(out.error.code, "ROUTINE_FIXTURE_FLAG_REQUIRED");
});

test("--offline-fixture also requires XW_ROUTINE_ALLOW_FIXTURE=1", async () => {
  const { code, stdout } = await runCli([
    "run", "--template", "feed-play", "--items", "2", "--execute",
    "--offline-fixture", "--driver-module", FAKE_DRIVER,
  ], { env: { XW_ROUTINE_ALLOW_FIXTURE: "0" } });
  assert.equal(code, 4);
  assert.equal(JSON.parse(stdout).error.code, "ROUTINE_FIXTURE_ENV_REQUIRED");
});

test("fixture unlock is disabled unless NODE_ENV=test", async () => {
  const { code, stdout } = await runCli([
    "run", "--template", "feed-play", "--items", "2", "--execute",
    "--offline-fixture", "--driver-module", FAKE_DRIVER,
  ], { env: { XW_ROUTINE_ALLOW_FIXTURE: "1", NODE_ENV: "production" } });
  assert.equal(code, 4);
  assert.equal(JSON.parse(stdout).error.code, "ROUTINE_FIXTURE_TEST_ENV_REQUIRED");
});

test("fixture realpath is confined to services/orchestrator/tests/fixtures", async () => {
  const { code, stdout } = await runCli([
    "run", "--template", "feed-play", "--items", "2", "--execute",
    "--offline-fixture", "--driver-module", CLI,
  ], { env: { XW_ROUTINE_ALLOW_FIXTURE: "1", NODE_ENV: "test" } });
  assert.equal(code, 4);
  assert.equal(JSON.parse(stdout).error.code, "ROUTINE_FIXTURE_PATH_FORBIDDEN");
});

test("production --execute uses one formal 03 runtime and writes a bound aggregate trace", async () => {
  const runtime = routineRuntimeFixture();
  const { code, stdout } = await runCliInProcess([
    "run", "--template", "feed-play", "--items", "1", "--dwell", "2:2", "--execute",
  ], {
    routineRuntimeFactory: () => runtime,
    routineTraceWriter: traceWriterFixture(),
  });
  assert.equal(code, 0);
  const out = JSON.parse(stdout);
  assert.equal(out.ok, true);
  assert.equal(out.routineRun.alias, "03");
  assert.equal(out.routineRun.serverVerified, true);
  assert.equal(out.routineRun.receipt.cleanup.verified, true);
  assert.equal(runtime.creates, 1);
  assert.match(out.trace.path, /xe_[a-f0-9]{32}\.json$/u);
});

test("an unresolved formal lease is traced but never reported as successful", async () => {
  const runtime = routineRuntimeFixture({ releaseFails: true });
  const { code, stdout } = await runCliInProcess([
    "run", "--template", "feed-play", "--items", "1", "--dwell", "2:2", "--execute",
  ], {
    routineRuntimeFactory: () => runtime,
    routineTraceWriter: traceWriterFixture(),
  });
  assert.equal(code, 4);
  const out = JSON.parse(stdout);
  assert.equal(out.ok, false);
  assert.equal(out.error.code, "ROUTINE_RUN_NOT_VERIFIED");
  assert.equal(out.routineRun.status, "BLOCKED");
  assert.equal(out.routineRun.cleanupRecovery.activeOwnedLeases, 1);
  assert.ok(out.trace.path);
});

test("explicit read-only --parallel 2 seals [03,04] but creates zero sessions until its coordinator exists", async () => {
  const planned = await runCli(["plan", "--template", "feed-play", "--items", "1", "--parallel", "2"]);
  assert.deepEqual(JSON.parse(planned.stdout).placement.aliases, ["03", "04"]);
  const runtime = routineRuntimeFixture();
  const { code, stdout } = await runCliInProcess([
    "run", "--template", "feed-play", "--items", "1", "--parallel", "2", "--execute",
  ], { routineRuntimeFactory: () => runtime, routineTraceWriter: traceWriterFixture() });
  assert.equal(code, 4);
  assert.equal(JSON.parse(stdout).error.code, "ROUTINE_PARALLEL_EXECUTOR_UNAVAILABLE");
  assert.equal(runtime.creates, 0);
});

test("caller-selected production endpoint is rejected before runtime/session creation", async () => {
  const runtime = routineRuntimeFixture();
  const { code, stdout } = await runCliInProcess([
    "run", "--template", "feed-play", "--items", "1", "--execute", "--control-url", "http://127.0.0.1:1",
  ], { routineRuntimeFactory: () => runtime, routineTraceWriter: traceWriterFixture() });
  assert.equal(code, 4);
  assert.equal(JSON.parse(stdout).error.code, "ROUTINE_ENDPOINT_OVERRIDE_FORBIDDEN");
  assert.equal(runtime.creates, 0);
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
    "--execute", "--offline-fixture", "--driver-module", FAKE_DRIVER,
  ], { env: { XW_ROUTINE_ALLOW_FIXTURE: "1", NODE_ENV: "test" } });
  assert.equal(code, 0);
  const out = JSON.parse(stdout);
  assert.equal(out.ok, true);
  assert.equal(out.command, "execute");
  assert.match(out.executionRunId, /^xe_[a-f0-9]{32}$/);
  assert.match(out.routineRunId, /^rr_[a-f0-9]{32}$/);
  assert.notEqual(out.routineRunId, `rr_${out.planHash.slice(0, 16)}`);
  assert.equal(out.receipt.status, "SUCCEEDED");
  assert.equal(out.receipt.items.length, 2);
  assert.equal(out.receipt.transport.count, 0, "feed-play is effectClass none — zero transport");
  assert.equal(out.receipt.cleanup.activeLeases, 0);
  assert.equal(out.receipt.cleanup.verified, true);
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

test("S2: canary-authorized social run without a bridge fails closed ROUTINE_EFFECT_BRIDGE_REQUIRED", async () => {
  const { code, stdout } = await runCli([
    "run", "--template", "nurture-lite", "--items", "2",
    "--execute", "--canary-authorized", "--offline-fixture", "--driver-module", FAKE_DRIVER,
  ], { env: { XW_ROUTINE_ALLOW_FIXTURE: "1", NODE_ENV: "test" } });
  assert.equal(code, 4);
  const out = JSON.parse(stdout);
  assert.equal(out.error.code, "ROUTINE_EFFECT_BRIDGE_REQUIRED");
  assert.ok(!("receipt" in out), "no receipt is emitted — a social run never executes without its bridge");
});

test("S2: canary-authorized social run with a bridge module commits the like through the ledger", async () => {
  const { code, stdout } = await runCli([
    "run", "--template", "nurture-lite", "--items", "2", "--like-max", "1", "--dwell", "2:3",
    "--execute", "--canary-authorized", "--offline-fixture", "--driver-module", FAKE_DRIVER, "--effect-bridge-module", FAKE_BRIDGE,
  ], { env: { XW_ROUTINE_ALLOW_FIXTURE: "1", NODE_ENV: "test" } });
  assert.equal(code, 0);
  const out = JSON.parse(stdout);
  assert.equal(out.ok, true);
  assert.equal(out.receipt.status, "SUCCEEDED");
  assert.equal(out.receipt.transport.count, 1, "likeMax=1: exactly one transport via the CP ledger");
  assert.equal(out.receipt.cleanup.activeLeases, 0);
  const liked = out.receipt.items.find((it) => it.effects.like === "verified");
  assert.ok(liked, "exactly one item reports a verified like");
  const capped = out.receipt.items.filter((it) => /cap_reached/.test(it.effects.like));
  assert.ok(capped.length >= 1, "remaining items are capped, not re-attempted");
});
