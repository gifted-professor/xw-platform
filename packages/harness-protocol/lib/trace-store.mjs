import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const ORCHESTRATION_TRACE_TYPES = Object.freeze([
  "TaskCreated",
  "PlanGenerated",
  "WorkerAssigned",
  "SkillStarted",
  "SkillFinished",
  "ValidationPassed",
  "RepairTriggered",
]);

const TYPE_SET = new Set(ORCHESTRATION_TRACE_TYPES);
const STATUS_BY_TYPE = Object.freeze({
  TaskCreated: new Set(["created"]),
  PlanGenerated: new Set(["planned"]),
  WorkerAssigned: new Set(["assigned"]),
  SkillStarted: new Set(["running"]),
  SkillFinished: new Set(["succeeded", "failed", "blocked"]),
  ValidationPassed: new Set(["succeeded"]),
  RepairTriggered: new Set(["repair_needed"]),
});
const ROW_KEYS = new Set([
  "schemaId", "schemaVersion", "eventId", "traceId", "seq", "at", "type", "ids",
  "nodeId", "skillId", "alias", "jobId", "status", "payload",
]);
const DRAFT_KEYS = new Set(["traceId", "type", "ids", "nodeId", "skillId", "alias", "jobId", "status", "payload"]);
const ID_KEYS = new Set([
  "traceId", "missionRunId", "nodeRunId", "skillRunId", "harnessSessionId", "turnId", "stepId",
  "toolCallId", "actionId", "effectId", "evidenceRef", "planRunId", "shardRunId", "workerRunId",
  "placementDecisionId", "leaseId", "joinRunId", "reducerRunId", "verificationRunId",
]);
const SENSITIVE_KEY = /token|secret|authorization|cookie|password|credential|payment|rawvalue/i;
const SENSITIVE_TEXT = /bearer\s+[a-z0-9._~-]+|(?:token|authorization|cookie|password|secret)\s*[:=]/i;
const SKILL_ID = /^[a-z0-9]+(\.[a-z0-9-]+)+$/;
const ALIAS = /^0[1-4]$/;
const DEFAULT_MAX_EVENT_BYTES = 64 * 1024;

function fail(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  throw error;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function exactKeys(value, allowed, label, code = "TRACE_EVENT_INVALID") {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code, `${label} must be an object`);
  const extras = Object.keys(value).filter((key) => !allowed.has(key));
  if (extras.length) fail(code, `${label} has unknown fields: ${extras.join(", ")}`);
}

function assertNoSensitive(value, location = "payload") {
  if (typeof value === "string") {
    if (SENSITIVE_TEXT.test(value)) fail("TRACE_SENSITIVE_DATA", `${location} contains credential-like text`);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) fail("TRACE_SENSITIVE_DATA", `${location}.${key} is forbidden in trace`);
    assertNoSensitive(child, `${location}.${key}`);
  }
}

function normalizeAt(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) fail("TRACE_CLOCK_INVALID", "trace clock returned an invalid timestamp");
  return date.toISOString();
}

function validateIds(ids, traceId) {
  exactKeys(ids, ID_KEYS, "ids");
  if (ids.traceId !== traceId) fail("TRACE_ID_MISMATCH", `ids.traceId must equal event traceId ${traceId}`);
  for (const [key, value] of Object.entries(ids)) {
    if (key === "traceId") continue;
    if (value !== null && typeof value !== "string") fail("TRACE_EVENT_INVALID", `ids.${key} must be string or null`);
  }
}

export function validateTraceEvent(event, { expectedTraceId, expectedSeq } = {}) {
  exactKeys(event, ROW_KEYS, "event", "TRACE_CORRUPT");
  if (event.schemaId !== "xw.orchestration.trace-event.v1" || event.schemaVersion !== 1) fail("TRACE_CORRUPT", "trace event contract identity is invalid");
  if (typeof event.traceId !== "string" || !event.traceId || event.traceId.length > 512) fail("TRACE_CORRUPT", "traceId is invalid");
  if (expectedTraceId !== undefined && event.traceId !== expectedTraceId) fail("TRACE_ID_MISMATCH", `trace file contains ${event.traceId}, expected ${expectedTraceId}`);
  if (!Number.isInteger(event.seq) || event.seq < 1 || (expectedSeq !== undefined && event.seq !== expectedSeq)) fail("TRACE_SEQUENCE_BROKEN", `expected seq ${expectedSeq}, got ${event.seq}`);
  if (event.eventId !== `evt_${sha256(event.traceId).slice(0, 12)}_${event.seq}`) fail("TRACE_CORRUPT", `eventId is not bound to trace/seq at ${event.seq}`);
  if (!TYPE_SET.has(event.type)) fail("TRACE_CORRUPT", `unknown trace event type ${event.type}`);
  if (!STATUS_BY_TYPE[event.type].has(event.status)) fail("TRACE_CORRUPT", `${event.type} has invalid status ${event.status}`);
  if (typeof event.at !== "string" || Number.isNaN(Date.parse(event.at))) fail("TRACE_CORRUPT", `invalid timestamp at seq ${event.seq}`);
  validateIds(event.ids, event.traceId);
  if (event.nodeId !== undefined && event.nodeId !== null && typeof event.nodeId !== "string") fail("TRACE_CORRUPT", "nodeId must be string or null");
  if (event.skillId !== undefined && event.skillId !== null && !SKILL_ID.test(event.skillId)) fail("TRACE_CORRUPT", "skillId is invalid");
  if (event.alias !== undefined && event.alias !== null && !ALIAS.test(event.alias)) fail("TRACE_CORRUPT", "alias is invalid");
  if (event.jobId !== undefined && event.jobId !== null && typeof event.jobId !== "string") fail("TRACE_CORRUPT", "jobId must be string or null");
  if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) fail("TRACE_CORRUPT", "payload must be an object");
  assertNoSensitive(event.payload);
  return true;
}

function assertChain(events, traceId) {
  const seenIds = new Set();
  let taskCreated = false;
  let planGenerated = false;
  for (const [index, event] of events.entries()) {
    validateTraceEvent(event, { expectedTraceId: traceId, expectedSeq: index + 1 });
    if (seenIds.has(event.eventId)) fail("TRACE_EVENT_DUPLICATE", `duplicate eventId ${event.eventId}`);
    seenIds.add(event.eventId);
    if (index === 0 && event.type !== "TaskCreated") fail("TRACE_ORDER_INVALID", "TaskCreated must be the first trace event");
    if (event.type === "TaskCreated") {
      if (taskCreated) fail("TRACE_ORDER_INVALID", "TaskCreated may occur only once");
      taskCreated = true;
    }
    if (event.type === "PlanGenerated") {
      if (!taskCreated || planGenerated) fail("TRACE_ORDER_INVALID", "PlanGenerated must follow TaskCreated and occur once");
      planGenerated = true;
    }
    if (["WorkerAssigned", "SkillStarted", "SkillFinished", "ValidationPassed", "RepairTriggered"].includes(event.type) && !planGenerated) {
      fail("TRACE_ORDER_INVALID", `${event.type} requires PlanGenerated`);
    }
  }
  return true;
}

function parseJsonl(bytes, traceId) {
  if (!bytes) return [];
  const lines = bytes.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  if (lines.some((line) => line.length === 0)) fail("TRACE_CORRUPT", "trace contains a blank or partial JSONL line");
  const events = lines.map((line, index) => {
    try { return JSON.parse(line); }
    catch (cause) { fail("TRACE_CORRUPT", `trace line ${index + 1} is invalid JSON`, cause); }
  });
  assertChain(events, traceId);
  return events;
}

function defaultTraceRoot() {
  if (process.env.XW_RUNTIME_ROOT) return path.resolve(process.env.XW_RUNTIME_ROOT, "state", "orchestrator", "trace");
  const configPath = path.resolve(import.meta.dirname, "../../../config/runtime/xw-runtime.v1.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  return path.resolve(config.runtimeRoot, "state", "orchestrator", "trace");
}

export class TraceStore {
  constructor({
    traceRoot = defaultTraceRoot(),
    now = () => Date.now(),
    append = appendFileSync,
    maxEventBytes = DEFAULT_MAX_EVENT_BYTES,
    onPersisted = null,
  } = {}) {
    this.traceRoot = path.resolve(traceRoot);
    this.now = now;
    this.appendFile = append;
    this.maxEventBytes = maxEventBytes;
    this.onPersisted = onPersisted;
  }

  pathFor(traceId) {
    if (typeof traceId !== "string" || !traceId || traceId.length > 512) fail("TRACE_ID_INVALID", "traceId must be 1..512 characters");
    return path.join(this.traceRoot, `${sha256(traceId)}.jsonl`);
  }

  read(traceId, { allowMissing = false } = {}) {
    const file = this.pathFor(traceId);
    if (!existsSync(file)) {
      if (allowMissing) return [];
      fail("TRACE_NOT_FOUND", `trace ${traceId} does not exist`);
    }
    return parseJsonl(readFileSync(file, "utf8"), traceId);
  }

  append(draft) {
    exactKeys(draft, DRAFT_KEYS, "draft");
    const traceId = draft.traceId;
    const file = this.pathFor(traceId);
    const existing = this.read(traceId, { allowMissing: true });
    const seq = existing.length + 1;
    const event = {
      schemaId: "xw.orchestration.trace-event.v1",
      schemaVersion: 1,
      eventId: `evt_${sha256(traceId).slice(0, 12)}_${seq}`,
      traceId,
      seq,
      at: normalizeAt(this.now),
      type: draft.type,
      ids: structuredClone(draft.ids),
      nodeId: draft.nodeId ?? null,
      skillId: draft.skillId ?? null,
      alias: draft.alias ?? null,
      jobId: draft.jobId ?? null,
      status: draft.status ?? null,
      payload: structuredClone(draft.payload ?? {}),
    };
    validateTraceEvent(event, { expectedTraceId: traceId, expectedSeq: seq });
    assertChain([...existing, event], traceId);
    const line = `${stableStringify(event)}\n`;
    if (Buffer.byteLength(line, "utf8") > this.maxEventBytes) fail("TRACE_EVENT_TOO_LARGE", `trace event exceeds ${this.maxEventBytes} bytes`);
    mkdirSync(this.traceRoot, { recursive: true });
    try {
      this.appendFile(file, line, "utf8");
    } catch (cause) {
      fail("TRACE_WRITE_FAILED", `failed to persist trace ${traceId}`, cause);
    }
    this.onPersisted?.(structuredClone(event));
    return structuredClone(event);
  }

  query(traceId) {
    const file = this.pathFor(traceId);
    if (!existsSync(file)) fail("TRACE_NOT_FOUND", `trace ${traceId} does not exist`);
    const bytes = readFileSync(file, "utf8");
    const events = parseJsonl(bytes, traceId);
    return {
      schemaId: "xw.orchestration.trace.v1",
      schemaVersion: 1,
      traceId,
      events: structuredClone(events),
      integrity: {
        ok: true,
        eventCount: events.length,
        lastSeq: events.length,
        sha256: sha256(bytes),
      },
    };
  }
}
