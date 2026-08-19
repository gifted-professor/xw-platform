import assert from "node:assert/strict";
import test from "node:test";

import {
  DSH_LIVE_GATE,
  HARNESS_ALLOWED_TOOLS,
  HARNESS_FORBIDDEN_TOOLS,
  M4_EXECUTION_MODE,
  MISSION_RUN_OWNER,
  ReferenceHarness,
  SkillRunMachine,
  assertHarnessToolAllowed,
  loadSkillFixtureSpec,
  validateSkillExit,
  validateSkillSpec,
} from "../lib/skill-runtime.mjs";

function exitOf(kind, extra = {}) {
  return {
    schemaId: "xw.skill.exit.v1",
    schemaVersion: 1,
    exit: kind,
    reason: extra.reason || `exit-${kind.toLowerCase()}`,
    factsProduced: extra.factsProduced || [],
    openQuestions: extra.openQuestions || [],
    candidateIntents: extra.candidateIntents || [],
  };
}

function routedSpec() {
  const spec = loadSkillFixtureSpec();
  return { ...spec, nextSkill: "xhs.publish" };
}

test("DSH live gate stays closed and fixture mode is the only M4 execution mode", () => {
  assert.equal(DSH_LIVE_GATE, "CLOSED");
  assert.equal(M4_EXECUTION_MODE, "fixture");
  assert.equal(MISSION_RUN_OWNER, "orchestrator");
});

test("xhs.collect fixture spec is a valid leaf skill", () => {
  const spec = loadSkillFixtureSpec();
  const r = validateSkillSpec(spec);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(spec.skillId, "xhs.collect");
  assert.equal(spec.sourcePath, "services/orchestrator/skills/xhs/xhs-collect/SKILL.md");
});

test("leaf skill must not hardcode the next skill", () => {
  const r = validateSkillSpec(routedSpec());
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === "LEAF_SKILL_ROUTED_AHEAD"));
});

test("typed exit cannot name the next skill", () => {
  const r = validateSkillExit({
    ...exitOf("REROUTE", { reason: "target-page-not-found", candidateIntents: ["repair-navigation"] }),
    nextSkill: "xhs.publish",
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === "LEAF_SKILL_ROUTED_AHEAD"));
});

test("SkillRun has explicit states and typed exits", () => {
  const machine = new SkillRunMachine({ now: () => 1 });
  const run = machine.start({ spec: loadSkillFixtureSpec(), ids: { traceId: "tr-1" } });
  assert.equal(run.state, "RUNNING");
  assert.equal(run.skillVersion, "1.1.0");
  assert.equal(run.ids.traceId, "tr-1");
  const reroute = machine.applyExit(exitOf("REROUTE", {
    reason: "target-page-not-found",
    candidateIntents: ["repair-navigation", "reobserve-app-state"],
  }));
  assert.equal(reroute.state, "SUCCEEDED");
  assert.equal(reroute.exit, "REROUTE");
  assert.deepEqual(machine.run.lastExit.candidateIntents, ["repair-navigation", "reobserve-app-state"]);
});

test("WAIT_HUMAN and ABORTED map onto waiting / cancelled states", () => {
  const machine = new SkillRunMachine({ now: () => 2 });
  machine.start({ spec: loadSkillFixtureSpec(), ids: { traceId: "tr-2" } });
  const waiting = machine.applyExit(exitOf("WAIT_HUMAN", { reason: "captcha" }));
  assert.equal(waiting.state, "WAITING_INPUT");
  const cancelled = machine.applyExit(exitOf("ABORTED", { reason: "operator-stop" }));
  assert.equal(cancelled.state, "CANCELLED");
});

test("bound skillVersion cannot change mid-run", () => {
  const machine = new SkillRunMachine({ now: () => 3 });
  machine.start({ spec: loadSkillFixtureSpec(), ids: { traceId: "tr-3" } });
  assert.throws(() => machine.rebindVersion("1.2.0"), { code: "SKILL_VERSION_IMMUTABLE" });
  assert.equal(machine.run.skillVersion, "1.1.0");
});

test("crash without checkpoint becomes AMBIGUOUS and refuses resume", () => {
  const machine = new SkillRunMachine({ now: () => 4 });
  machine.start({ spec: loadSkillFixtureSpec(), ids: { traceId: "tr-4" } });
  const crashed = machine.crash();
  assert.equal(crashed.state, "AMBIGUOUS");
  assert.throws(() => machine.resume(), { code: "SKILL_RESUME_AMBIGUOUS" });
});

test("crash after checkpoint resumes without emitting phone acts", () => {
  const machine = new SkillRunMachine({ now: () => 5 });
  machine.start({ spec: loadSkillFixtureSpec(), ids: { traceId: "tr-5" } });
  const ckpt = machine.checkpoint({ lastDurableStep: 2, payload: { page: "detail" } });
  assert.equal(ckpt.seq, 1);
  machine.crash();
  const resumed = machine.resume();
  assert.equal(resumed.run.state, "RUNNING");
  assert.equal(resumed.run.lastDurableStep, 2);
  assert.equal(resumed.phoneActsEmitted, 0);
  assert.equal(machine.phoneActs.length, 0);
});

test("forbidden harness tools stay forbidden", () => {
  for (const name of HARNESS_FORBIDDEN_TOOLS) {
    assert.throws(() => assertHarnessToolAllowed(name), { code: "HARNESS_TOOL_FORBIDDEN" });
  }
  for (const name of HARNESS_ALLOWED_TOOLS) {
    assert.doesNotThrow(() => assertHarnessToolAllowed(name));
  }
  assert.throws(() => assertHarnessToolAllowed("raw_adb"), { code: "HARNESS_TOOL_UNKNOWN" });
});

test("reference harness proves XW is not welded to DSH", () => {
  const harness = new ReferenceHarness({ now: () => 6 });
  harness.invoke("xw_skill_start", { spec: loadSkillFixtureSpec(), ids: { traceId: "tr-6" } });
  const observed = harness.invoke("xw_phone_observe");
  assert.equal(observed.executionMode, "fixture");
  assert.equal(observed.partial, true);
  assert.equal(observed.partialReason, "fixture_provider_no_device_artifact");
  const act = harness.invoke("xw_phone_act", { actionId: "act-1" });
  assert.equal(act.executed, false);
  harness.invoke("xw_skill_checkpoint", { lastDurableStep: 1 });
  const done = harness.invoke("xw_skill_complete", { reason: "count-plus-one" });
  assert.equal(done.state, "SUCCEEDED");
  assert.equal(done.exit, "COMPLETED");
  const trace = harness.invoke("xw_trace_query");
  assert.ok(trace.events.some((event) => event.type === "xw/skill-started"));
  assert.ok(trace.events.some((event) => event.type === "xw/skill-exited"));
  assert.throws(() => harness.invoke("lease_mutation"), { code: "HARNESS_TOOL_FORBIDDEN" });
  assert.throws(() => harness.invoke("ADB"), { code: "HARNESS_TOOL_FORBIDDEN" });
});

test("undeclared exit is rejected", () => {
  const machine = new SkillRunMachine({ now: () => 7 });
  machine.start({ spec: loadSkillFixtureSpec(), ids: { traceId: "tr-7" } });
  assert.throws(() => machine.applyExit(exitOf("CONTINUE")), { code: "INVALID_SKILL_EXIT" });
});
