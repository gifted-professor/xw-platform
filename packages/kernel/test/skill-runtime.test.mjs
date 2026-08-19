import assert from "node:assert/strict";
import test from "node:test";

import {
  DSH_LIVE_GATE,
  HARNESS_FORBIDDEN_TOOLS,
  M4_EXECUTION_MODE,
  MISSION_RUN_OWNER,
  ReferenceHarness,
  SkillRunMachine,
  assertHarnessToolAllowed,
  canonicalSkillSpecSha256,
  loadSkillFixtureSpec,
  validateSkillCheckpoint,
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

function startMachine(ids = { traceId: "tr-1" }) {
  const machine = new SkillRunMachine({ now: () => 1 });
  machine.start({ spec: loadSkillFixtureSpec(), ids });
  return machine;
}

test("DSH live gate stays closed and fixture mode is the only M4 execution mode", () => {
  assert.equal(DSH_LIVE_GATE, "CLOSED");
  assert.equal(M4_EXECUTION_MODE, "fixture");
  assert.equal(MISSION_RUN_OWNER, "orchestrator");
});

test("xhs.collect fixture spec is a valid leaf skill with identity fields", () => {
  const spec = loadSkillFixtureSpec();
  const r = validateSkillSpec(spec);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(spec.skillId, "xhs.collect");
  assert.match(spec.sourceCommit, /^[0-9a-f]{40}$/);
});

test("spec must declare READY/RUNNING and every exit target state", () => {
  const r = validateSkillSpec({
    schemaId: "xw.skill.spec.v1",
    schemaVersion: 1,
    skillId: "xhs.collect",
    version: "1.1.0",
    implementationMode: "scripted",
    states: ["READY"],
    exits: ["COMPLETED"],
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.message.includes("RUNNING")));
});

test("leaf skill must not hardcode the next skill", () => {
  const r = validateSkillSpec({ ...loadSkillFixtureSpec(), nextSkill: "xhs.publish" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === "LEAF_SKILL_ROUTED_AHEAD"));
});

test("typed exit cannot name the next skill", () => {
  const r = validateSkillExit({
    ...exitOf("REROUTE", { reason: "target-page-not-found", candidateIntents: ["intent:repair-navigation"] }),
    nextSkill: "xhs.publish",
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === "LEAF_SKILL_ROUTED_AHEAD"));
});

test("candidateIntents must use intent: namespace, not skill ids", () => {
  const asSkill = validateSkillExit(exitOf("REROUTE", { candidateIntents: ["xhs.publish"] }));
  assert.equal(asSkill.ok, false);
  assert.ok(asSkill.errors.some((e) => e.code === "INVALID_CANDIDATE_INTENT"));
  const prefixed = validateSkillExit(exitOf("REROUTE", { candidateIntents: ["skill:xhs.publish"] }));
  assert.equal(prefixed.ok, false);
  const ok = validateSkillExit(exitOf("REROUTE", { candidateIntents: ["intent:repair-navigation"] }));
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
});

test("SkillRun has explicit states and typed exits", () => {
  const machine = startMachine();
  assert.equal(machine.run.state, "RUNNING");
  assert.equal(machine.run.skillVersion, "1.1.0");
  assert.match(machine.run.skillVersionRef.skillSpecSha256, /^[0-9a-f]{64}$/);
  const reroute = machine.applyExit(exitOf("REROUTE", {
    reason: "target-page-not-found",
    candidateIntents: ["intent:repair-navigation", "intent:reobserve-app-state"],
  }));
  assert.equal(reroute.state, "SUCCEEDED");
  assert.equal(reroute.exit, "REROUTE");
});

test("WAIT_HUMAN and ABORTED map onto waiting / cancelled states", () => {
  const machine = startMachine({ traceId: "tr-2" });
  assert.equal(machine.applyExit(exitOf("WAIT_HUMAN", { reason: "captcha" })).state, "WAITING_INPUT");
  assert.equal(machine.applyExit(exitOf("ABORTED", { reason: "operator-stop" })).state, "CANCELLED");
});

test("bound skillVersion cannot change mid-run, and start cannot overlay an active run", () => {
  const machine = startMachine({ traceId: "tr-3" });
  assert.throws(() => machine.rebindVersion("1.2.0"), { code: "SKILL_VERSION_IMMUTABLE" });
  assert.throws(
    () => machine.start({ spec: loadSkillFixtureSpec(), ids: { traceId: "tr-3b" } }),
    { code: "SKILL_RUN_ALREADY_ACTIVE" },
  );
});

test("crash without checkpoint is AMBIGUOUS with null exit, not ABORTED", () => {
  const machine = startMachine({ traceId: "tr-4" });
  const crashed = machine.crash();
  assert.equal(crashed.state, "AMBIGUOUS");
  assert.equal(crashed.exit, null);
  assert.equal(crashed.recoveryRequired, true);
  assert.ok(machine.events.some((event) => event.type === "xw/recovery-required"));
  assert.throws(() => machine.resume(), { code: "SKILL_RESUME_AMBIGUOUS" });
});

test("fresh process restore from serialized JSON does not share object identity", () => {
  const a = startMachine({ traceId: "tr-5", missionRunId: "mission-5" });
  a.checkpoint({ lastDurableStep: 2, payload: { page: "detail" } });
  const json = JSON.stringify(a.serialize());
  const detached = JSON.parse(json);
  const b = SkillRunMachine.restore({
    ...detached,
    reconciliation: { status: "NO_UNRESOLVED_EFFECTS" },
  });
  assert.notEqual(b, a);
  assert.notEqual(b.run, a.run);
  assert.equal(b.run.state, "RUNNING");
  assert.equal(b.run.lastDurableStep, 2);
  assert.equal(b.phoneActs.length, 0);
});

test("checkpoint from another run is rejected even if semver matches", () => {
  const a = startMachine({ traceId: "tr-a" });
  a.checkpoint();
  const b = startMachine({ traceId: "tr-b" });
  b.checkpoint();
  assert.throws(
    () => b.resume({ checkpoint: a.lastCheckpoint, reconciliation: { status: "NO_UNRESOLVED_EFFECTS" } }),
    { code: "SKILL_CHECKPOINT_BINDING_MISMATCH" },
  );
});

test("spec digest mismatch refuses restore", () => {
  const a = startMachine({ traceId: "tr-digest" });
  a.checkpoint();
  const frozen = a.serialize();
  const mutated = { ...loadSkillFixtureSpec(), version: "1.1.1" };
  frozen.spec = mutated;
  frozen.run.skillVersion = "1.1.0";
  assert.throws(
    () => SkillRunMachine.restore({ ...frozen, reconciliation: { status: "NO_UNRESOLVED_EFFECTS" } }),
    { code: "SKILL_SPEC_DIGEST_MISMATCH" },
  );
  assert.notEqual(canonicalSkillSpecSha256(mutated), a.run.skillVersionRef.skillSpecSha256);
});

test("action requested without verified receipt cannot auto-restore", () => {
  const harness = new ReferenceHarness({ now: () => 9 });
  harness.invoke("xw_skill_start", { spec: loadSkillFixtureSpec(), ids: { traceId: "tr-act" } });
  harness.invoke("xw_skill_checkpoint", { lastDurableStep: 1 });
  harness.invoke("xw_phone_act", { actionId: "act-1" });
  const frozen = JSON.parse(JSON.stringify(harness.machine.serialize()));
  assert.throws(
    () => SkillRunMachine.restore({ ...frozen, reconciliation: { status: "NO_UNRESOLVED_EFFECTS" } }),
    { code: "SKILL_RECONCILIATION_REQUIRED" },
  );
  assert.throws(
    () => SkillRunMachine.restore({ ...frozen, reconciliation: { status: "AMBIGUOUS_EFFECT" } }),
    { code: "SKILL_RESUME_AMBIGUOUS" },
  );
});

test("ALREADY_VERIFIED allows restore after an unresolved-looking action id", () => {
  const harness = new ReferenceHarness({ now: () => 10 });
  harness.invoke("xw_skill_start", { spec: loadSkillFixtureSpec(), ids: { traceId: "tr-ver" } });
  harness.invoke("xw_skill_checkpoint");
  harness.invoke("xw_phone_act", { actionId: "act-2" });
  const frozen = JSON.parse(JSON.stringify(harness.machine.serialize()));
  const restored = SkillRunMachine.restore({ ...frozen, reconciliation: { status: "ALREADY_VERIFIED" } });
  assert.equal(restored.run.state, "RUNNING");
});

test("canonical checkpoint validator rejects unknown state, extra fields, and bad schemaVersion", () => {
  const machine = startMachine({ traceId: "tr-val" });
  const ckpt = machine.checkpoint();
  assert.equal(validateSkillCheckpoint({ ...ckpt, state: "WHATEVER" }).ok, false);
  assert.equal(validateSkillCheckpoint({ ...ckpt, schemaVersion: 999 }).ok, false);
  assert.equal(validateSkillCheckpoint({ ...ckpt, extra: true }).ok, false);
  assert.equal(validateSkillCheckpoint({ ...ckpt, exit: "UNKNOWN" }).ok, false);
  const missingCreated = { ...ckpt };
  delete missingCreated.createdAt;
  assert.equal(validateSkillCheckpoint(missingCreated).ok, false);
  assert.equal(validateSkillCheckpoint({ ...ckpt, skillVersion: "v1" }).ok, false);
});

test("forbidden harness tools stay forbidden", () => {
  for (const name of HARNESS_FORBIDDEN_TOOLS) {
    assert.throws(() => assertHarnessToolAllowed(name), { code: "HARNESS_TOOL_FORBIDDEN" });
  }
  assert.throws(() => assertHarnessToolAllowed("raw_adb"), { code: "HARNESS_TOOL_UNKNOWN" });
});

test("reference harness proves XW is not welded to DSH", () => {
  const harness = new ReferenceHarness({ now: () => 6 });
  harness.invoke("xw_skill_start", { spec: loadSkillFixtureSpec(), ids: { traceId: "tr-6" } });
  const observed = harness.invoke("xw_phone_observe");
  assert.equal(observed.executionMode, "fixture");
  assert.equal(observed.partial, true);
  const done = harness.invoke("xw_skill_complete", { reason: "count-plus-one" });
  assert.equal(done.state, "SUCCEEDED");
  assert.equal(done.exit, "COMPLETED");
  assert.throws(() => harness.invoke("lease_mutation"), { code: "HARNESS_TOOL_FORBIDDEN" });
});

test("undeclared exit is rejected", () => {
  const machine = startMachine({ traceId: "tr-7" });
  assert.throws(() => machine.applyExit(exitOf("CONTINUE")), { code: "INVALID_SKILL_EXIT" });
});
