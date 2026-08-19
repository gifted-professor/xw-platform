import { createHash, randomUUID } from "node:crypto";

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

export const INTENT_PATTERN = /^intent:[a-z0-9][a-z0-9._-]*$/;
export const SKILL_ID_PATTERN = /^[a-z0-9]+(\.[a-z0-9-]+)+$/;
export const SEMVER_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+$/;
export const SHA256_PATTERN = /^[0-9a-f]{64}$/;
export const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

export const RECONCILIATION_STATUSES = Object.freeze([
  "NO_UNRESOLVED_EFFECTS",
  "ALREADY_VERIFIED",
  "AMBIGUOUS_EFFECT",
]);

const ROUTE_AHEAD_KEYS = Object.freeze(["nextSkill", "next_skill", "hardcodedNext"]);

export const EXIT_TRANSITIONS = Object.freeze({
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

const SPEC_KEYS = Object.freeze([
  "schemaId",
  "schemaVersion",
  "skillId",
  "version",
  "implementationMode",
  "sourcePath",
  "sourceCommit",
  "sourceBlobSha",
  "inputSchema",
  "outputSchema",
  "preconditions",
  "budgets",
  "requiredCapabilities",
  "states",
  "exits",
  "verifiers",
  "recoveryStrategies",
  "fixtures",
]);

const EXIT_KEYS = Object.freeze([
  "schemaId",
  "schemaVersion",
  "exit",
  "reason",
  "factsProduced",
  "openQuestions",
  "candidateIntents",
]);

const CHECKPOINT_KEYS = Object.freeze([
  "schemaId",
  "schemaVersion",
  "checkpointId",
  "skillRunId",
  "skillId",
  "skillVersion",
  "skillVersionRef",
  "state",
  "seq",
  "createdAt",
  "lastDurableStep",
  "exit",
  "ids",
  "payload",
  "actionLedgerRevision",
  "lastActionId",
  "lastEffectId",
  "lastVerifiedReceiptRef",
  "harnessEventSeq",
]);

const RUN_KEYS = Object.freeze([
  "schemaId",
  "schemaVersion",
  "skillRunId",
  "skillId",
  "skillVersion",
  "skillVersionRef",
  "implementationMode",
  "state",
  "exit",
  "exitReason",
  "attempt",
  "ids",
  "createdAt",
  "updatedAt",
  "checkpointSeq",
  "lastDurableStep",
  "lastExit",
  "recoveryRequired",
  "actionLedgerRevision",
  "lastActionId",
  "lastEffectId",
  "lastVerifiedReceiptRef",
  "harnessEventSeq",
]);

const VERSION_REF_KEYS = Object.freeze([
  "skillId",
  "skillVersion",
  "skillSpecSha256",
  "sourceCommit",
  "sourcePath",
  "sourceBlobSha",
]);

function fail(errors, code, message) {
  errors.push({ code, message });
}

function codedError(code, message, errors) {
  const error = new Error(message);
  error.code = code;
  if (errors) error.errors = errors;
  return error;
}

function throwIfInvalid(check, fallbackCode) {
  if (check.ok) return;
  throw codedError(check.errors[0].code || fallbackCode, check.errors.map((item) => item.message).join("; "), check.errors);
}

function rejectExtra(obj, allowed, errors, code) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) fail(errors, code, `unexpected field: ${key}`);
  }
}

function uniqueOrFail(values, label, errors, code) {
  if (new Set(values).size !== values.length) fail(errors, code, `${label} must be unique`);
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

export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

export function canonicalSkillSpecSha256(spec) {
  return createHash("sha256").update(stableStringify(spec), "utf8").digest("hex");
}

export function buildSkillVersionRef(spec) {
  return {
    skillId: spec.skillId,
    skillVersion: spec.version,
    skillSpecSha256: canonicalSkillSpecSha256(spec),
    sourceCommit: spec.sourceCommit,
    sourcePath: spec.sourcePath,
    sourceBlobSha: spec.sourceBlobSha,
  };
}

export function validateSkillVersionRef(ref, { code = "INVALID_SKILL_RUN" } = {}) {
  const errors = [];
  if (!ref || typeof ref !== "object") {
    return { ok: false, errors: [{ code, message: "skillVersionRef must be an object" }] };
  }
  rejectExtra(ref, VERSION_REF_KEYS, errors, code);
  if (!SKILL_ID_PATTERN.test(ref.skillId || "")) fail(errors, code, "skillVersionRef.skillId is invalid");
  if (!SEMVER_PATTERN.test(ref.skillVersion || "")) fail(errors, code, "skillVersionRef.skillVersion is invalid");
  if (!SHA256_PATTERN.test(ref.skillSpecSha256 || "")) fail(errors, code, "skillVersionRef.skillSpecSha256 is invalid");
  if (!GIT_SHA_PATTERN.test(ref.sourceCommit || "")) fail(errors, code, "skillVersionRef.sourceCommit is invalid");
  if (typeof ref.sourcePath !== "string" || !ref.sourcePath) fail(errors, code, "skillVersionRef.sourcePath is required");
  if (!GIT_SHA_PATTERN.test(ref.sourceBlobSha || "")) fail(errors, code, "skillVersionRef.sourceBlobSha is invalid");
  return { ok: errors.length === 0, errors };
}

export function validateCandidateIntent(intent) {
  if (typeof intent !== "string") return { ok: false, code: "INVALID_CANDIDATE_INTENT", message: "intent must be a string" };
  if (intent.startsWith("skill:")) {
    return { ok: false, code: "INVALID_CANDIDATE_INTENT", message: "candidateIntents cannot name a skill:" };
  }
  if (SKILL_ID_PATTERN.test(intent)) {
    return { ok: false, code: "INVALID_CANDIDATE_INTENT", message: `candidateIntents cannot be a skillId: ${intent}` };
  }
  if (!INTENT_PATTERN.test(intent)) {
    return { ok: false, code: "INVALID_CANDIDATE_INTENT", message: `candidateIntents must match ${INTENT_PATTERN}` };
  }
  return { ok: true };
}

export function loadSkillFixtureSpec() {
  return loadKernelJson("contracts/skill/fixtures/xhs-collect.spec.v1.json");
}

export function validateCorrelationIds(ids, { code = "INVALID_SKILL_RUN" } = {}) {
  const errors = [];
  if (!ids || typeof ids !== "object") {
    return { ok: false, errors: [{ code, message: "ids must be an object" }] };
  }
  rejectExtra(ids, CORRELATION_ID_KEYS, errors, code);
  if (!ids.traceId) fail(errors, code, "traceId is required");
  return { ok: errors.length === 0, errors };
}

export function validateSkillSpec(spec) {
  const errors = [];
  if (!spec || typeof spec !== "object") {
    return { ok: false, errors: [{ code: "INVALID_SKILL_SPEC", message: "spec must be an object" }] };
  }
  rejectExtra(spec, SPEC_KEYS, errors, "INVALID_SKILL_SPEC");
  if (spec.schemaId !== "xw.skill.spec.v1") fail(errors, "INVALID_SKILL_SPEC", "schemaId must be xw.skill.spec.v1");
  if (spec.schemaVersion !== 1) fail(errors, "INVALID_SKILL_SPEC", "schemaVersion must be 1");
  if (!SKILL_ID_PATTERN.test(spec.skillId || "")) {
    fail(errors, "INVALID_SKILL_SPEC", "skillId must be dotted lowercase (e.g. xhs.collect)");
  }
  if (!SEMVER_PATTERN.test(spec.version || "")) {
    fail(errors, "INVALID_SKILL_SPEC", "version must be semver x.y.z");
  }
  if (!IMPLEMENTATION_MODES.includes(spec.implementationMode)) {
    fail(errors, "INVALID_SKILL_SPEC", `unknown implementationMode: ${spec.implementationMode}`);
  }
  if (spec.sourceCommit != null && !GIT_SHA_PATTERN.test(spec.sourceCommit)) {
    fail(errors, "INVALID_SKILL_SPEC", "sourceCommit must be a 40-char git SHA");
  }
  if (spec.sourceBlobSha != null && !GIT_SHA_PATTERN.test(spec.sourceBlobSha)) {
    fail(errors, "INVALID_SKILL_SPEC", "sourceBlobSha must be a 40-char git SHA");
  }
  if (!Array.isArray(spec.states) || spec.states.length === 0) {
    fail(errors, "INVALID_SKILL_SPEC", "states must be a non-empty array");
  } else {
    uniqueOrFail(spec.states, "states", errors, "INVALID_SKILL_SPEC");
    for (const state of spec.states) {
      if (!SKILL_STATES.includes(state)) fail(errors, "INVALID_SKILL_SPEC", `unknown state: ${state}`);
    }
    if (!spec.states.includes("READY")) fail(errors, "INVALID_SKILL_SPEC", "states must include READY");
    if (!spec.states.includes("RUNNING")) fail(errors, "INVALID_SKILL_SPEC", "states must include RUNNING");
  }
  if (!Array.isArray(spec.exits) || spec.exits.length === 0) {
    fail(errors, "INVALID_SKILL_SPEC", "exits must be a non-empty array");
  } else {
    uniqueOrFail(spec.exits, "exits", errors, "INVALID_SKILL_SPEC");
    for (const exit of spec.exits) {
      if (!SKILL_EXITS.includes(exit)) fail(errors, "INVALID_SKILL_SPEC", `unknown exit: ${exit}`);
      const target = EXIT_TRANSITIONS[exit];
      if (target && spec.states && !spec.states.includes(target)) {
        fail(errors, "INVALID_SKILL_SPEC", `exit ${exit} requires state ${target}`);
      }
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
  rejectExtra(exit, EXIT_KEYS, errors, "INVALID_SKILL_EXIT");
  if (exit.schemaId !== "xw.skill.exit.v1") fail(errors, "INVALID_SKILL_EXIT", "schemaId must be xw.skill.exit.v1");
  if (exit.schemaVersion !== 1) fail(errors, "INVALID_SKILL_EXIT", "schemaVersion must be 1");
  if (!SKILL_EXITS.includes(exit.exit)) fail(errors, "INVALID_SKILL_EXIT", `unknown exit: ${exit.exit}`);
  if (typeof exit.reason !== "string" || exit.reason.length === 0) {
    fail(errors, "INVALID_SKILL_EXIT", "reason is required");
  }
  if (allowedExits && !allowedExits.includes(exit.exit)) {
    fail(errors, "INVALID_SKILL_EXIT", `exit ${exit.exit} is not declared on this skill`);
  }
  if (exit.candidateIntents) {
    if (!Array.isArray(exit.candidateIntents)) {
      fail(errors, "INVALID_SKILL_EXIT", "candidateIntents must be an array");
    } else {
      for (const intent of exit.candidateIntents) {
        const check = validateCandidateIntent(intent);
        if (!check.ok) fail(errors, check.code, check.message);
      }
    }
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
  rejectExtra(checkpoint, CHECKPOINT_KEYS, errors, "INVALID_SKILL_CHECKPOINT");
  if (checkpoint.schemaId !== "xw.skill.checkpoint.v1") {
    fail(errors, "INVALID_SKILL_CHECKPOINT", "schemaId must be xw.skill.checkpoint.v1");
  }
  if (checkpoint.schemaVersion !== 1) fail(errors, "INVALID_SKILL_CHECKPOINT", "schemaVersion must be 1");
  for (const key of ["checkpointId", "skillRunId", "skillId", "skillVersion", "state"]) {
    if (!checkpoint[key]) fail(errors, "INVALID_SKILL_CHECKPOINT", `${key} is required`);
  }
  if (!SEMVER_PATTERN.test(checkpoint.skillVersion || "")) {
    fail(errors, "INVALID_SKILL_CHECKPOINT", "skillVersion must be semver x.y.z");
  }
  if (!SKILL_STATES.includes(checkpoint.state)) {
    fail(errors, "INVALID_SKILL_CHECKPOINT", `unknown checkpoint state: ${checkpoint.state}`);
  }
  if (checkpoint.exit != null && !SKILL_EXITS.includes(checkpoint.exit)) {
    fail(errors, "INVALID_SKILL_CHECKPOINT", `unknown checkpoint exit: ${checkpoint.exit}`);
  }
  if (!Number.isInteger(checkpoint.seq) || checkpoint.seq < 1) {
    fail(errors, "INVALID_SKILL_CHECKPOINT", "seq must be a positive integer");
  }
  if (!Number.isInteger(checkpoint.createdAt)) {
    fail(errors, "INVALID_SKILL_CHECKPOINT", "createdAt is required");
  }
  const ids = validateCorrelationIds(checkpoint.ids || {}, { code: "INVALID_SKILL_CHECKPOINT" });
  errors.push(...ids.errors);
  const ref = validateSkillVersionRef(checkpoint.skillVersionRef, { code: "INVALID_SKILL_CHECKPOINT" });
  errors.push(...ref.errors);
  return { ok: errors.length === 0, errors };
}

export function validateSkillRun(run) {
  const errors = [];
  if (!run || typeof run !== "object") {
    return { ok: false, errors: [{ code: "INVALID_SKILL_RUN", message: "run must be an object" }] };
  }
  rejectExtra(run, RUN_KEYS, errors, "INVALID_SKILL_RUN");
  if (run.schemaId !== "xw.skill.run.v1") fail(errors, "INVALID_SKILL_RUN", "schemaId must be xw.skill.run.v1");
  if (run.schemaVersion !== 1) fail(errors, "INVALID_SKILL_RUN", "schemaVersion must be 1");
  if (!run.skillRunId) fail(errors, "INVALID_SKILL_RUN", "skillRunId is required");
  if (!SKILL_ID_PATTERN.test(run.skillId || "")) fail(errors, "INVALID_SKILL_RUN", "skillId is invalid");
  if (!SEMVER_PATTERN.test(run.skillVersion || "")) fail(errors, "INVALID_SKILL_RUN", "skillVersion must be semver");
  if (!SKILL_STATES.includes(run.state)) fail(errors, "INVALID_SKILL_RUN", `unknown run state: ${run.state}`);
  if (run.exit != null && !SKILL_EXITS.includes(run.exit)) fail(errors, "INVALID_SKILL_RUN", `unknown run exit: ${run.exit}`);
  if (!Number.isInteger(run.attempt) || run.attempt < 1) fail(errors, "INVALID_SKILL_RUN", "attempt must be >= 1");
  if (!Number.isInteger(run.createdAt) || !Number.isInteger(run.updatedAt)) {
    fail(errors, "INVALID_SKILL_RUN", "createdAt/updatedAt are required");
  }
  if (!Number.isInteger(run.checkpointSeq) || run.checkpointSeq < 0) {
    fail(errors, "INVALID_SKILL_RUN", "checkpointSeq is required");
  }
  if (typeof run.recoveryRequired !== "boolean") fail(errors, "INVALID_SKILL_RUN", "recoveryRequired must be boolean");
  const ids = validateCorrelationIds(run.ids || {});
  errors.push(...ids.errors);
  const ref = validateSkillVersionRef(run.skillVersionRef);
  errors.push(...ref.errors);
  return { ok: errors.length === 0, errors };
}

export function assertHarnessToolAllowed(name) {
  if (HARNESS_FORBIDDEN_TOOLS.includes(name)) {
    throw codedError("HARNESS_TOOL_FORBIDDEN", `${name} is not exposable to a harness`);
  }
  if (!HARNESS_ALLOWED_TOOLS.includes(name)) {
    throw codedError("HARNESS_TOOL_UNKNOWN", `unknown harness tool: ${name}`);
  }
}

export function versionRefsEqual(left, right) {
  if (!left || !right) return false;
  return VERSION_REF_KEYS.every((key) => left[key] === right[key]);
}

export function hasUnresolvedEffect(record) {
  return Boolean(record?.lastActionId) && !record?.lastVerifiedReceiptRef;
}

function snapshotRun(run) {
  return {
    schemaId: "xw.skill.run.v1",
    schemaVersion: 1,
    skillRunId: run.skillRunId,
    skillId: run.skillId,
    skillVersion: run.skillVersion,
    skillVersionRef: { ...run.skillVersionRef },
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
    recoveryRequired: run.recoveryRequired,
    actionLedgerRevision: run.actionLedgerRevision,
    lastActionId: run.lastActionId,
    lastEffectId: run.lastEffectId,
    lastVerifiedReceiptRef: run.lastVerifiedReceiptRef,
    harnessEventSeq: run.harnessEventSeq,
  };
}

function assertCheckpointBinding(run, checkpoint) {
  const mismatches = [];
  if (checkpoint.skillRunId !== run.skillRunId) mismatches.push("skillRunId");
  if (checkpoint.skillId !== run.skillId) mismatches.push("skillId");
  if (checkpoint.skillVersion !== run.skillVersion) mismatches.push("skillVersion");
  if ((checkpoint.ids?.traceId || null) !== (run.ids?.traceId || null)) mismatches.push("ids.traceId");
  if ((checkpoint.ids?.missionRunId || null) !== (run.ids?.missionRunId || null)) mismatches.push("ids.missionRunId");
  if (checkpoint.seq > run.checkpointSeq) mismatches.push("seq");
  if (!versionRefsEqual(checkpoint.skillVersionRef, run.skillVersionRef)) mismatches.push("skillVersionRef");
  if (mismatches.length) {
    throw codedError("SKILL_CHECKPOINT_BINDING_MISMATCH", `checkpoint binding mismatch: ${mismatches.join(", ")}`);
  }
}

function assertSpecDigest(spec, run, checkpoint) {
  const loaded = canonicalSkillSpecSha256(spec);
  const runHash = run.skillVersionRef?.skillSpecSha256;
  const ckptHash = checkpoint?.skillVersionRef?.skillSpecSha256;
  if (loaded !== runHash || (checkpoint && loaded !== ckptHash)) {
    throw codedError("SKILL_SPEC_DIGEST_MISMATCH", "SkillSpec SHA does not match bound SkillRun/Checkpoint");
  }
}

function applyReconciliation(run, reconciliation) {
  const status = reconciliation?.status;
  if (!RECONCILIATION_STATUSES.includes(status)) {
    throw codedError("SKILL_RECONCILIATION_REQUIRED", "restore requires reconciliation.status");
  }
  const unresolved = hasUnresolvedEffect(run);
  if (status === "AMBIGUOUS_EFFECT") {
    run.state = "AMBIGUOUS";
    run.exit = "REPAIR_REQUIRED";
    run.recoveryRequired = true;
    run.exitReason = "ambiguous-effect-on-restore";
    throw codedError("SKILL_RESUME_AMBIGUOUS", "Action Ledger reported AMBIGUOUS_EFFECT");
  }
  if (unresolved && status === "NO_UNRESOLVED_EFFECTS") {
    throw codedError("SKILL_RECONCILIATION_REQUIRED", "unresolved action contradicts NO_UNRESOLVED_EFFECTS");
  }
  if (unresolved && status !== "ALREADY_VERIFIED") {
    throw codedError("SKILL_RECONCILIATION_REQUIRED", "unresolved action requires ALREADY_VERIFIED");
  }
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
    if (!this.run) throw codedError("INVALID_SKILL_RUN", "no skill run");
    return this.run;
  }

  #emit(type, data) {
    this.events.push({ type, at: this.now(), data });
    if (this.run) this.run.harnessEventSeq = (this.run.harnessEventSeq || 0) + 1;
  }

  #move(nextState, { exit, reason, recoveryRequired, clearExit = false } = {}) {
    const run = this.#requireRun();
    const from = run.state;
    run.state = nextState;
    if (clearExit) {
      run.exit = null;
      run.exitReason = reason ?? null;
    } else if (exit !== undefined && exit !== null) {
      run.exit = exit;
      run.exitReason = reason;
    }
    if (recoveryRequired != null) run.recoveryRequired = recoveryRequired;
    run.updatedAt = this.now();
    this.#emit("xw/skill-state-changed", {
      skillRunId: run.skillRunId,
      from,
      to: nextState,
      exit: run.exit,
      skillVersionRef: run.skillVersionRef,
    });
    return snapshotRun(run);
  }

  start({ spec, ids = {}, input = null } = {}) {
    if (this.run && !TERMINAL_SKILL_STATES.includes(this.run.state)) {
      throw codedError("SKILL_RUN_ALREADY_ACTIVE", "a non-terminal SkillRun is already active");
    }
    throwIfInvalid(validateSkillSpec(spec), "INVALID_SKILL_SPEC");
    if (!spec.sourceCommit || !spec.sourcePath || !spec.sourceBlobSha) {
      throw codedError("INVALID_SKILL_SPEC", "spec must carry sourceCommit, sourcePath, and sourceBlobSha");
    }
    const skillRunId = ids.skillRunId || `skillrun_${randomUUID()}`;
    const mergedIds = {
      ...ids,
      skillRunId,
      missionRunId: ids.missionRunId ?? null,
    };
    throwIfInvalid(validateCorrelationIds(mergedIds), "INVALID_SKILL_RUN");
    const skillVersionRef = buildSkillVersionRef(spec);
    const ts = this.now();
    this.spec = spec;
    this.lastCheckpoint = null;
    this.phoneActs = [];
    this.events = [];
    this.run = {
      skillRunId,
      skillId: spec.skillId,
      skillVersion: spec.version,
      skillVersionRef,
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
      recoveryRequired: false,
      actionLedgerRevision: 0,
      lastActionId: null,
      lastEffectId: null,
      lastVerifiedReceiptRef: null,
      harnessEventSeq: 0,
      input,
    };
    this.#emit("xw/skill-started", {
      skillRunId,
      skillId: spec.skillId,
      skillVersion: spec.version,
      skillVersionRef,
      missionRunOwner: MISSION_RUN_OWNER,
    });
    return this.#move("RUNNING");
  }

  applyExit(exit) {
    const run = this.#requireRun();
    if (TERMINAL_SKILL_STATES.includes(run.state)) {
      throw codedError("SKILL_STATE_ILLEGAL", `skill run already terminal: ${run.state}`);
    }
    throwIfInvalid(validateSkillExit(exit, { allowedExits: this.spec.exits }), "INVALID_SKILL_EXIT");
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
        skillVersionRef: run.skillVersionRef,
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
      throw codedError("SKILL_STATE_ILLEGAL", `beginVerify requires RUNNING, got ${run.state}`);
    }
    if (!this.spec.states.includes("VERIFYING")) {
      throw codedError("SKILL_STATE_ILLEGAL", "spec does not declare VERIFYING");
    }
    return this.#move("VERIFYING");
  }

  rebindVersion(nextVersion) {
    this.#requireRun();
    throw codedError(
      "SKILL_VERSION_IMMUTABLE",
      `skillVersion is immutable for a running SkillRun (bound ${this.run.skillVersion}, refused ${nextVersion})`,
    );
  }

  noteActionRequested(actionId) {
    const run = this.#requireRun();
    run.lastActionId = actionId || `action_${randomUUID()}`;
    run.lastVerifiedReceiptRef = null;
    run.actionLedgerRevision = (run.actionLedgerRevision || 0) + 1;
    run.updatedAt = this.now();
    this.phoneActs.push({ requested: true, executed: false, actionId: run.lastActionId });
    this.#emit("xw/action-requested", { actionId: run.lastActionId, receiptRef: null });
    return run.lastActionId;
  }

  noteActionVerified(receiptRef) {
    const run = this.#requireRun();
    run.lastVerifiedReceiptRef = receiptRef || `xw://action-receipts/${run.lastActionId}`;
    run.updatedAt = this.now();
    this.#emit("xw/action-receipt", { actionId: run.lastActionId, receiptRef: run.lastVerifiedReceiptRef });
    return run.lastVerifiedReceiptRef;
  }

  checkpoint({ lastDurableStep = null, payload = null } = {}) {
    const run = this.#requireRun();
    if (TERMINAL_SKILL_STATES.includes(run.state)) {
      throw codedError("SKILL_STATE_ILLEGAL", "cannot checkpoint a terminal skill run");
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
      skillVersionRef: { ...run.skillVersionRef },
      state: run.state,
      seq: run.checkpointSeq,
      createdAt: run.updatedAt,
      lastDurableStep: run.lastDurableStep,
      exit: run.exit,
      ids: { ...run.ids },
      payload,
      actionLedgerRevision: run.actionLedgerRevision,
      lastActionId: run.lastActionId,
      lastEffectId: run.lastEffectId,
      lastVerifiedReceiptRef: run.lastVerifiedReceiptRef,
      harnessEventSeq: run.harnessEventSeq,
    };
    throwIfInvalid(validateSkillCheckpoint(row), "INVALID_SKILL_CHECKPOINT");
    this.lastCheckpoint = row;
    this.#emit("xw/skill-checkpoint", {
      skillRunId: run.skillRunId,
      seq: row.seq,
      skillVersionRef: run.skillVersionRef,
    });
    return { ...row, skillVersionRef: { ...row.skillVersionRef }, ids: { ...row.ids } };
  }

  crash() {
    const run = this.#requireRun();
    if (TERMINAL_SKILL_STATES.includes(run.state)) return snapshotRun(run);
    if (!this.lastCheckpoint) {
      const snapshot = this.#move("AMBIGUOUS", {
        clearExit: true,
        reason: "crash-without-durable-checkpoint",
        recoveryRequired: true,
      });
      this.#emit("xw/recovery-required", {
        skillRunId: run.skillRunId,
        reason: "crash-without-durable-checkpoint",
      });
      return snapshot;
    }
    run.updatedAt = this.now();
    return snapshotRun(run);
  }

  serialize() {
    const run = this.#requireRun();
    return JSON.parse(JSON.stringify({
      spec: this.spec,
      run: snapshotRun(run),
      checkpoint: this.lastCheckpoint,
    }));
  }

  resume({ checkpoint = this.lastCheckpoint, reconciliation = { status: "NO_UNRESOLVED_EFFECTS" } } = {}) {
    const run = this.#requireRun();
    if (run.state === "AMBIGUOUS") {
      throw codedError("SKILL_RESUME_AMBIGUOUS", "ambiguous skill run cannot auto-resume; inspect Action Ledger first");
    }
    if (!checkpoint) throw codedError("SKILL_CHECKPOINT_MISSING", "no durable checkpoint");
    throwIfInvalid(validateSkillCheckpoint(checkpoint), "INVALID_SKILL_CHECKPOINT");
    assertCheckpointBinding(run, checkpoint);
    assertSpecDigest(this.spec, run, checkpoint);
    applyReconciliation(run, reconciliation);
    run.state = checkpoint.state;
    run.checkpointSeq = checkpoint.seq;
    run.lastDurableStep = checkpoint.lastDurableStep;
    run.updatedAt = this.now();
    this.lastCheckpoint = JSON.parse(JSON.stringify(checkpoint));
    this.#emit("xw/skill-state-changed", {
      skillRunId: run.skillRunId,
      from: "CRASHED",
      to: run.state,
      resumedFrom: checkpoint.seq,
      skillVersionRef: run.skillVersionRef,
    });
    return { run: snapshotRun(run), phoneActsEmitted: 0, restored: false };
  }

  static restore({ spec, run, checkpoint, reconciliation, now } = {}) {
    throwIfInvalid(validateSkillSpec(spec), "INVALID_SKILL_SPEC");
    throwIfInvalid(validateSkillRun(run), "INVALID_SKILL_RUN");
    if (!checkpoint) throw codedError("SKILL_CHECKPOINT_MISSING", "restore requires a durable checkpoint");
    throwIfInvalid(validateSkillCheckpoint(checkpoint), "INVALID_SKILL_CHECKPOINT");
    assertCheckpointBinding(run, checkpoint);
    assertSpecDigest(spec, run, checkpoint);
    const machine = new SkillRunMachine({ now });
    machine.spec = JSON.parse(JSON.stringify(spec));
    machine.run = JSON.parse(JSON.stringify(run));
    machine.lastCheckpoint = JSON.parse(JSON.stringify(checkpoint));
    machine.events = [];
    machine.phoneActs = [];
    try {
      applyReconciliation(machine.run, reconciliation);
    } catch (error) {
      if (error.code === "SKILL_RESUME_AMBIGUOUS") {
        machine.#emit("xw/recovery-required", {
          skillRunId: machine.run.skillRunId,
          reason: machine.run.exitReason,
        });
      }
      throw error;
    }
    if (machine.run.state === "AMBIGUOUS") {
      throw codedError("SKILL_RESUME_AMBIGUOUS", "ambiguous skill run cannot auto-resume; inspect Action Ledger first");
    }
    machine.run.state = checkpoint.state;
    machine.run.updatedAt = machine.now();
    machine.#emit("xw/skill-state-changed", {
      skillRunId: machine.run.skillRunId,
      from: "RESTORED",
      to: machine.run.state,
      resumedFrom: checkpoint.seq,
      skillVersionRef: machine.run.skillVersionRef,
    });
    return machine;
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
        return {
          accepted: false,
          executed: false,
          reason: "open-action-live-closed",
          actionId: this.machine.noteActionRequested(payload.actionId),
        };
      case "xw_phone_verify":
        return {
          ok: false,
          reason: "no-live-effect",
          receiptRef: this.machine.noteActionVerified(payload.receiptRef),
        };
      case "xw_trace_query":
        return { events: [...this.machine.events], receipts: [...this.receipts] };
      default:
        assertHarnessToolAllowed(name);
    }
  }
}
