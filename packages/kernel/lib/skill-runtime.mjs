import { randomUUID } from "node:crypto";

import { loadKernelJson } from "./open-action.mjs";

export const DSH_LIVE_GATE = "CLOSED";
export const M4_EXECUTION_MODE = "fixture";

export const SKILL_STATES = Object.freeze([
  "READY",
  "RUNNING",
  "WAITING_INPUT",
  "WAITING_EXTERNAL",
  "VERIFYING",
  "BLOCKED",
  "SUCCEEDED",
  "FAILED",
  "AMBIGUOUS",
  "CANCELLED",
]);

export const TERMINAL_SKILL_STATES = Object.freeze([
  "SUCCEEDED",
  "FAILED",
  "AMBIGUOUS",
  "CANCELLED",
]);

export const SKILL_EXITS = Object.freeze([
  "COMPLETED",
  "CONTINUE",
  "REROUTE",
  "WAIT_HUMAN",
  "WAIT_EXTERNAL",
  "RETRY",
  "FALLBACK",
  "REPAIR_REQUIRED",
  "ABORTED",
]);

export const IMPLEMENTATION_MODES = Object.freeze([
  "agentic",
  "scripted",
  "hybrid",
  "subgraph",
]);

export const SKILL_LIFECYCLE = Object.freeze([
  "DRAFT",
  "CANDIDATE",
  "REPLAY_VERIFIED",
  "CANARY",
  "STABLE",
  "DEGRADED",
  "DEPRECATED",
  "RETIRED",
]);

export const CORRELATION_ID_KEYS = Object.freeze([
  "traceId",
  "missionRunId",
  "nodeRunId",
  "skillRunId",
  "harnessSessionId",
  "turnId",
  "stepId",
  "toolCallId",
  "actionId",
  "effectId",
  "evidenceRef",
]);

export const MISSION_RUN_OWNER = "orchestrator";

export const HARNESS_ALLOWED_TOOLS = Object.freeze([
  "xw_skill_start",
  "xw_skill_continue",
  "xw_skill_checkpoint",
  "xw_skill_complete",
  "xw_phone_observe",
  "xw_phone_act",
  "xw_phone_verify",
  "xw_trace_query",
]);

export const HARNESS_FORBIDDEN_TOOLS = Object.freeze([
  "control.db",
  "registry.db",
  "ADB",
  "22222",
  "lease_mutation",
  "payment_override",
  "policy_override",
]);

const ROUTE_AHEAD_KEYS = Object.freeze(["nextSkill", "next_skill", "hardcodedNext"]);

const EXIT_TRANSITIONS = Object.freeze({
  COMPLETED: "SUCCEEDED",
  CONTINUE: "RUNNING",
  REROUTE: "SUCCEEDED",
  WAIT_HUMAN: "WAITING_INPUT",
  WAIT_EXTERNAL: "WAITING_EXTERNAL",
  RETRY: "RUNNING",
  FALLBACK: "SUCCEEDED",
  REPAIR_REQUIRED: "BLOCKED",
  ABORTED: "CANCELLED",
});

function fail(errors, code, message) {
  errors.push({ code, message });
}

function hasRouteAhead(value, path = "$") {
  if (!value || typeof value !== "object") return [];
  const hits = [];
  for (const key of ROUTE_AHEAD_KEYS) {
    if (Object.hasOwn(value, key) && value[key] != null && value[key] !== "") {
      hits.push(`${path}.${key}`);
    }
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      hits.push(...hasRouteAhead(item, `${path}[${index}]`));
    });
    return hits;
  }
  for (const [key, child] of Object.entries(value)) {
    if (ROUTE_AHEAD_KEYS.includes(key)) continue;
    hits.push(...hasRouteAhead(child, `${path}.${key}`));
  }
  return hits;
}

export function loadSkillFixtureSpec() {
  return loadKernelJson("contracts/skill/fixtures/xhs-collect.spec.v1.json");
}

export function validateCorrelationIds(ids) {
  const errors = [];
  if (!ids || typeof ids !== "object") {
    return { ok: false, errors: [{ code: "INVALID_SKILL_RUN", message: "ids must be an object" }] };
  }
  if (!ids.traceId) fail(errors, "INVALID_SKILL_RUN", "traceId is required");
  for (const key of Object.keys(ids)) {
    if (!CORRELATION_ID_KEYS.includes(key)) {
      fail(errors, "INVALID_SKILL_RUN", `unknown correlation id: ${key}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

export function validateSkillSpec(spec) {
  const errors = [];
  if (!spec || typeof spec !== "object") {
    return { ok: false, errors: [{ code: "INVALID_SKILL_SPEC", message: "spec must be an object" }] };
  }
  if (spec.schemaId !== "xw.skill.spec.v1") fail(errors, "INVALID_SKILL_SPEC", "schemaId must be xw.skill.spec.v1");
  if (spec.schemaVersion !== 1) fail(errors, "INVALID_SKILL_SPEC", "schemaVersion must be 1");
  if (typeof spec.skillId !== "string" || !/^[a-z0-9]+(\.[a-z0-9-]+)+$/.test(spec.skillId)) {
    fail(errors, "INVALID_SKILL_SPEC", "skillId must be dotted lowercase (e.g. xhs.collect)");
  }
  if (typeof spec.version !== "string" || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(spec.version)) {
    fail(errors, "INVALID_SKILL_SPEC", "version must be semver x.y.z");
  }
  if (!IMPLEMENTATION_MODES.includes(spec.implementationMode)) {
    fail(errors, "INVALID_SKILL_SPEC", `unknown implementationMode: ${spec.implementationMode}`);
  }
  if (!Array.isArray(spec.states) || spec.states.length === 0) {
    fail(errors, "INVALID_SKILL_SPEC", "states must be a non-empty array");
  } else {
    for (const state of spec.states) {
      if (!SKILL_STATES.includes(state)) fail(errors, "INVALID_SKILL_SPEC", `unknown state: ${state}`);
    }
  }
  if (!Array.isArray(spec.exits) || spec.exits.length === 0) {
    fail(errors, "INVALID_SKILL_SPEC", "exits must be a non-empty array");
  } else {
    for (const exit of spec.exits) {
      if (!SKILL_EXITS.includes(exit)) fail(errors, "INVALID_SKILL_SPEC", `unknown exit: ${exit}`);
    }
  }
  const routeHits = hasRouteAhead(spec);
  if (routeHits.length) {
    fail(errors, "LEAF_SKILL_ROUTED_AHEAD", `leaf skill must not hardcode next skill: ${routeHits.join(", ")}`);
  }
  return { ok: errors.length === 0, errors };
}

export function validateSkillExit(exit, { allowedExits } = {}) {
  const errors = [];
  if (!exit || typeof exit !== "object") {
    return { ok: false, errors: [{ code: "INVALID_SKILL_EXIT", message: "exit must be an object" }] };
  }
  if (exit.schemaId !== "xw.skill.exit.v1") fail(errors, "INVALID_SKILL_EXIT", "schemaId must be xw.skill.exit.v1");
  if (exit.schemaVersion !== 1) fail(errors, "INVALID_SKILL_EXIT", "schemaVersion must be 1");
  if (!SKILL_EXITS.includes(exit.exit)) fail(errors, "INVALID_SKILL_EXIT", `unknown exit: ${exit.exit}`);
  if (typeof exit.reason !== "string" || exit.reason.length === 0) {
    fail(errors, "INVALID_SKILL_EXIT", "reason is required");
  }
  if (allowedExits && !allowedExits.includes(exit.exit)) {
    fail(errors, "INVALID_SKILL_EXIT", `exit ${exit.exit} is not declared on this skill`);
  }
  const routeHits = hasRouteAhead(exit);
  if (routeHits.length) {
    fail(errors, "LEAF_SKILL_ROUTED_AHEAD", `exit must not hardcode next skill: ${routeHits.join(", ")}`);
  }
  return { ok: errors.length === 0, errors };
}

export function validateSkillCheckpoint(checkpoint) {
  const errors = [];
  if (!checkpoint || typeof checkpoint !== "object") {
    return { ok: false, errors: [{ code: "INVALID_SKILL_CHECKPOINT", message: "checkpoint must be an object" }] };
  }
  if (checkpoint.schemaId !== "xw.skill.checkpoint.v1") {
    fail(errors, "INVALID_SKILL_CHECKPOINT", "schemaId must be xw.skill.checkpoint.v1");
  }
  for (const key of ["checkpointId", "skillRunId", "skillId", "skillVersion", "state"]) {
    if (!checkpoint[key]) fail(errors, "INVALID_SKILL_CHECKPOINT", `${key} is required`);
  }
  if (!Number.isInteger(checkpoint.seq) || checkpoint.seq < 1) {
    fail(errors, "INVALID_SKILL_CHECKPOINT", "seq must be a positive integer");
  }
  const ids = validateCorrelationIds(checkpoint.ids || {});
  errors.push(...ids.errors);
  return { ok: errors.length === 0, errors };
}

export function assertHarnessToolAllowed(name) {
  if (HARNESS_FORBIDDEN_TOOLS.includes(name)) {
    const error = new Error(`${name} is not exposable to a harness`);
    error.code = "HARNESS_TOOL_FORBIDDEN";
    throw error;
  }
  if (!HARNESS_ALLOWED_TOOLS.includes(name)) {
    const error = new Error(`unknown harness tool: ${name}`);
    error.code = "HARNESS_TOOL_UNKNOWN";
    throw error;
  }
}

function snapshotRun(run) {
  return {
    schemaId: "xw.skill.run.v1",
    schemaVersion: 1,
    skillRunId: run.skillRunId,
    skillId: run.skillId,
    skillVersion: run.skillVersion,
    implementationMode: run.implementationMode,
    state: run.state,
    exit: run.exit,
    exitReason: run.exitReason,
    attempt: run.attempt,
    ids: { ...run.ids },
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    checkpointSeq: run.checkpointSeq,
    lastDurableStep: run.lastDurableStep,
    lastExit: run.lastExit ? { ...run.lastExit } : null,
  };
}

export class SkillRunMachine {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.run = null;
    this.spec = null;
    this.lastCheckpoint = null;
    this.events = [];
    this.phoneActs = [];
  }

  #requireRun() {
    if (!this.run) {
      const error = new Error("no skill run");
      error.code = "INVALID_SKILL_RUN";
      throw error;
    }
    return this.run;
  }

  #emit(type, data) {
    this.events.push({ type, at: this.now(), data });
  }

  #move(nextState, { exit = null, reason = null } = {}) {
    const run = this.#requireRun();
    if (run.state === nextState && exit == null) {
      run.updatedAt = this.now();
      return snapshotRun(run);
    }
    const from = run.state;
    run.state = nextState;
    if (exit != null) {
      run.exit = exit;
      run.exitReason = reason;
    }
    run.updatedAt = this.now();
    this.#emit("xw/skill-state-changed", {
      skillRunId: run.skillRunId,
      from,
      to: nextState,
      exit: run.exit,
    });
    return snapshotRun(run);
  }

  start({ spec, ids = {}, input = null } = {}) {
    const specCheck = validateSkillSpec(spec);
    if (!specCheck.ok) {
      const error = new Error(specCheck.errors.map((item) => item.message).join("; "));
      error.code = specCheck.errors[0].code;
      error.errors = specCheck.errors;
      throw error;
    }
    const skillRunId = ids.skillRunId || `skillrun_${randomUUID()}`;
    const mergedIds = {
      ...ids,
      skillRunId,
      missionRunId: ids.missionRunId ?? null,
    };
    const idCheck = validateCorrelationIds(mergedIds);
    if (!idCheck.ok) {
      const error = new Error(idCheck.errors.map((item) => item.message).join("; "));
      error.code = idCheck.errors[0].code;
      error.errors = idCheck.errors;
      throw error;
    }
    const ts = this.now();
    this.spec = spec;
    this.lastCheckpoint = null;
    this.phoneActs = [];
    this.run = {
      skillRunId,
      skillId: spec.skillId,
      skillVersion: spec.version,
      implementationMode: spec.implementationMode,
      state: "READY",
      exit: null,
      exitReason: null,
      attempt: 1,
      ids: mergedIds,
      createdAt: ts,
      updatedAt: ts,
      checkpointSeq: 0,
      lastDurableStep: null,
      lastExit: null,
      input,
    };
    this.#emit("xw/skill-started", {
      skillRunId,
      skillId: spec.skillId,
      skillVersion: spec.version,
      missionRunOwner: MISSION_RUN_OWNER,
    });
    return this.#move("RUNNING");
  }

  applyExit(exit) {
    const run = this.#requireRun();
    if (TERMINAL_SKILL_STATES.includes(run.state)) {
      const error = new Error(`skill run already terminal: ${run.state}`);
      error.code = "SKILL_STATE_ILLEGAL";
      throw error;
    }
    const check = validateSkillExit(exit, { allowedExits: this.spec.exits });
    if (!check.ok) {
      const error = new Error(check.errors.map((item) => item.message).join("; "));
      error.code = check.errors[0].code;
      error.errors = check.errors;
      throw error;
    }
    if (exit.exit === "RETRY") run.attempt += 1;
    run.lastExit = { ...exit };
    const next = EXIT_TRANSITIONS[exit.exit];
    const snapshot = this.#move(next, { exit: exit.exit, reason: exit.reason });
    if (TERMINAL_SKILL_STATES.includes(next) || next === "BLOCKED") {
      this.#emit("xw/skill-exited", {
        skillRunId: run.skillRunId,
        exit: exit.exit,
        reason: exit.reason,
        candidateIntents: exit.candidateIntents || [],
      });
    }
    if (exit.exit === "REPAIR_REQUIRED") {
      this.#emit("xw/recovery-required", { skillRunId: run.skillRunId, reason: exit.reason });
    }
    return snapshot;
  }

  beginVerify() {
    const run = this.#requireRun();
    if (run.state !== "RUNNING") {
      const error = new Error(`beginVerify requires RUNNING, got ${run.state}`);
      error.code = "SKILL_STATE_ILLEGAL";
      throw error;
    }
    return this.#move("VERIFYING");
  }

  rebindVersion(nextVersion) {
    this.#requireRun();
    const error = new Error(`skillVersion is immutable for a running SkillRun (bound ${this.run.skillVersion}, refused ${nextVersion})`);
    error.code = "SKILL_VERSION_IMMUTABLE";
    throw error;
  }

  checkpoint({ lastDurableStep = null, payload = null } = {}) {
    const run = this.#requireRun();
    if (TERMINAL_SKILL_STATES.includes(run.state)) {
      const error = new Error("cannot checkpoint a terminal skill run");
      error.code = "SKILL_STATE_ILLEGAL";
      throw error;
    }
    run.checkpointSeq += 1;
    if (lastDurableStep != null) run.lastDurableStep = lastDurableStep;
    run.updatedAt = this.now();
    const row = {
      schemaId: "xw.skill.checkpoint.v1",
      schemaVersion: 1,
      checkpointId: `ckpt_${run.skillRunId}_${run.checkpointSeq}`,
      skillRunId: run.skillRunId,
      skillId: run.skillId,
      skillVersion: run.skillVersion,
      state: run.state,
      seq: run.checkpointSeq,
      createdAt: run.updatedAt,
      lastDurableStep: run.lastDurableStep,
      exit: run.exit,
      ids: { ...run.ids },
      payload,
    };
    const check = validateSkillCheckpoint(row);
    if (!check.ok) {
      const error = new Error(check.errors.map((item) => item.message).join("; "));
      error.code = check.errors[0].code;
      error.errors = check.errors;
      throw error;
    }
    this.lastCheckpoint = row;
    this.#emit("xw/skill-checkpoint", { skillRunId: run.skillRunId, seq: row.seq });
    return { ...row };
  }

  crash() {
    const run = this.#requireRun();
    if (TERMINAL_SKILL_STATES.includes(run.state)) return snapshotRun(run);
    if (!this.lastCheckpoint) return this.#move("AMBIGUOUS", { exit: "ABORTED", reason: "crash-without-checkpoint" });
    run.updatedAt = this.now();
    return snapshotRun(run);
  }

  resume(checkpoint = this.lastCheckpoint) {
    const run = this.#requireRun();
    if (run.state === "AMBIGUOUS") {
      const error = new Error("ambiguous skill run cannot auto-resume; inspect Action Ledger first");
      error.code = "SKILL_RESUME_AMBIGUOUS";
      throw error;
    }
    if (!checkpoint) {
      const error = new Error("no durable checkpoint");
      error.code = "SKILL_CHECKPOINT_MISSING";
      throw error;
    }
    const check = validateSkillCheckpoint(checkpoint);
    if (!check.ok) {
      const error = new Error(check.errors.map((item) => item.message).join("; "));
      error.code = check.errors[0].code;
      throw error;
    }
    if (checkpoint.skillVersion !== run.skillVersion) {
      const error = new Error("checkpoint skillVersion does not match bound run");
      error.code = "SKILL_VERSION_IMMUTABLE";
      throw error;
    }
    run.state = checkpoint.state;
    run.checkpointSeq = checkpoint.seq;
    run.lastDurableStep = checkpoint.lastDurableStep;
    run.updatedAt = this.now();
    this.lastCheckpoint = { ...checkpoint };
    this.#emit("xw/skill-state-changed", {
      skillRunId: run.skillRunId,
      from: "CRASHED",
      to: run.state,
      resumedFrom: checkpoint.seq,
    });
    return { run: snapshotRun(run), phoneActsEmitted: 0 };
  }
}

export class ReferenceHarness {
  constructor({ now } = {}) {
    this.machine = new SkillRunMachine({ now });
    this.receipts = [];
  }

  invoke(name, payload = {}) {
    assertHarnessToolAllowed(name);
    switch (name) {
      case "xw_skill_start":
        return this.machine.start(payload);
      case "xw_skill_continue":
        return this.machine.applyExit(payload.exit);
      case "xw_skill_checkpoint":
        return this.machine.checkpoint(payload);
      case "xw_skill_complete":
        return this.machine.applyExit({
          schemaId: "xw.skill.exit.v1",
          schemaVersion: 1,
          exit: "COMPLETED",
          reason: payload.reason || "reference-harness-complete",
          factsProduced: payload.factsProduced || [],
          openQuestions: [],
          candidateIntents: [],
        });
      case "xw_phone_observe":
        return {
          executionMode: M4_EXECUTION_MODE,
          partial: true,
          partialReason: "fixture_provider_no_device_artifact",
          observationId: `obs_fixture_${randomUUID()}`,
        };
      case "xw_phone_act":
        this.machine.phoneActs.push({ requested: true, executed: false, actionId: payload.actionId || null });
        this.machine.events.push({
          type: "xw/action-requested",
          at: this.machine.now(),
          data: { actionId: payload.actionId || null, receiptRef: null },
        });
        return { accepted: false, executed: false, reason: "open-action-live-closed" };
      case "xw_phone_verify":
        return { ok: false, reason: "no-live-effect" };
      case "xw_trace_query":
        return { events: [...this.machine.events], receipts: [...this.receipts] };
      default:
        assertHarnessToolAllowed(name);
    }
  }
}
