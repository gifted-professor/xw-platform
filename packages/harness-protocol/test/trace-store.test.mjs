import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { validateJsonSchema } from "../../../services/control-plane/control-plane/lib/json-schema-validator.mjs";
import { ReferenceHarnessAdapter } from "../lib/reference-adapter.mjs";
import { ORCHESTRATION_TRACE_TYPES, TraceStore } from "../lib/trace-store.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const roots = [];

function tempRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "xw-trace-store-"));
  roots.push(root);
  return root;
}

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function append(store, traceId, type, status, overrides = {}) {
  return store.append({
    traceId,
    type,
    ids: { traceId, ...(overrides.ids ?? {}) },
    status,
    payload: overrides.payload ?? {},
    nodeId: overrides.nodeId,
    skillId: overrides.skillId,
    alias: overrides.alias,
    jobId: overrides.jobId,
  });
}

function startTrace(store, traceId) {
  append(store, traceId, "TaskCreated", "created", { ids: { planRunId: `plan-${traceId}` } });
  append(store, traceId, "PlanGenerated", "planned", { payload: { planHash: "a".repeat(64) } });
}

test("all seven event types persist as canonical schema-valid contiguous JSONL", () => {
  const root = tempRoot();
  const store = new TraceStore({ traceRoot: root, now: () => "2026-08-20T12:00:00.000Z" });
  const traceId = "trace-seven";
  startTrace(store, traceId);
  append(store, traceId, "WorkerAssigned", "assigned", { nodeId: "n1", skillId: "xhs.observe.feed", alias: "01" });
  append(store, traceId, "SkillStarted", "running", { nodeId: "n1", skillId: "xhs.observe.feed", alias: "01", jobId: "job-1" });
  append(store, traceId, "SkillFinished", "succeeded", { nodeId: "n1", skillId: "xhs.observe.feed", alias: "01", jobId: "job-1" });
  append(store, traceId, "ValidationPassed", "succeeded", { nodeId: "n2", skillId: "xw.validate.business-output" });
  append(store, traceId, "RepairTriggered", "repair_needed", { nodeId: "n3", payload: { reasonCode: "SERVE_UNAVAILABLE" } });

  const query = store.query(traceId);
  assert.deepEqual([...new Set(query.events.map(({ type }) => type))], ORCHESTRATION_TRACE_TYPES);
  assert.deepEqual(query.events.map(({ seq }) => seq), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(query.integrity.ok, true);
  assert.equal(readFileSync(store.pathFor(traceId), "utf8").split("\n").filter(Boolean).length, 7);

  const schema = JSON.parse(readFileSync(path.join(ROOT, "packages/kernel/contracts/orchestration/trace-event.v1.schema.json"), "utf8"));
  schema.$defs = { ids: JSON.parse(readFileSync(path.join(ROOT, "packages/kernel/contracts/skill/correlation-ids.v1.schema.json"), "utf8")) };
  schema.properties.ids = { $ref: "#/$defs/ids" };
  for (const event of query.events) assert.deepEqual(validateJsonSchema(event, schema), []);
});

test("traceId is hashed into a confined filename even for traversal and Windows path text", () => {
  const root = tempRoot();
  const store = new TraceStore({ traceRoot: root });
  const traceId = "../..\\C:\\Windows\\CON";
  const file = store.pathFor(traceId);
  assert.equal(path.dirname(file), path.resolve(root));
  assert.match(path.basename(file), /^[0-9a-f]{64}\.jsonl$/);
  append(store, traceId, "TaskCreated", "created");
  assert.equal(store.read(traceId).length, 1);
});

test("four worker writes remain contiguous and restart continues at the next sequence", async () => {
  const root = tempRoot();
  const traceId = "trace-four-workers";
  const first = new TraceStore({ traceRoot: root });
  startTrace(first, traceId);
  await Promise.all(["01", "02", "03", "04"].map(async (alias, index) => {
    append(first, traceId, "WorkerAssigned", "assigned", { nodeId: `n${index + 1}`, alias, skillId: "xhs.observe.feed" });
  }));
  const restarted = new TraceStore({ traceRoot: root });
  const row = append(restarted, traceId, "SkillStarted", "running", { nodeId: "n1", alias: "01", skillId: "xhs.observe.feed" });
  assert.equal(row.seq, 7);
  assert.deepEqual(restarted.read(traceId).map(({ seq }) => seq), [1, 2, 3, 4, 5, 6, 7]);
});

test("corrupt JSON, sequence gaps, and traceId breaks fail closed", () => {
  const root = tempRoot();
  const store = new TraceStore({ traceRoot: root });
  const traceId = "trace-corrupt";
  append(store, traceId, "TaskCreated", "created");
  const file = store.pathFor(traceId);
  writeFileSync(file, `${readFileSync(file, "utf8")}{bad-json}\n`, "utf8");
  assert.throws(() => store.read(traceId), { code: "TRACE_CORRUPT" });

  const other = "trace-gap";
  append(store, other, "TaskCreated", "created");
  const otherFile = store.pathFor(other);
  const event = JSON.parse(readFileSync(otherFile, "utf8"));
  event.seq = 3;
  event.eventId = `${event.eventId.slice(0, event.eventId.lastIndexOf("_") + 1)}3`;
  writeFileSync(otherFile, `${JSON.stringify(event)}\n`, "utf8");
  assert.throws(() => store.read(other), { code: "TRACE_SEQUENCE_BROKEN" });

  const broken = "trace-id-break";
  append(store, broken, "TaskCreated", "created");
  const brokenFile = store.pathFor(broken);
  const brokenEvent = JSON.parse(readFileSync(brokenFile, "utf8"));
  brokenEvent.traceId = "different-trace";
  brokenEvent.ids.traceId = "different-trace";
  writeFileSync(brokenFile, `${JSON.stringify(brokenEvent)}\n`, "utf8");
  assert.throws(() => store.read(broken), { code: "TRACE_ID_MISMATCH" });
});

test("write failure publishes nothing and sensitive or oversized payloads are rejected", () => {
  const root = tempRoot();
  const published = [];
  const failed = new TraceStore({
    traceRoot: root,
    append: () => { throw new Error("disk full"); },
    onPersisted: (event) => published.push(event),
  });
  assert.throws(() => append(failed, "trace-disk-full", "TaskCreated", "created"), { code: "TRACE_WRITE_FAILED" });
  assert.deepEqual(published, []);

  const store = new TraceStore({ traceRoot: root, maxEventBytes: 512 });
  assert.throws(() => append(store, "trace-secret", "TaskCreated", "created", { payload: { authToken: "abc" } }), { code: "TRACE_SENSITIVE_DATA" });
  assert.throws(() => append(store, "trace-large", "TaskCreated", "created", { payload: { text: "x".repeat(1000) } }), { code: "TRACE_EVENT_TOO_LARGE" });
});

test("queryTrace(traceId) survives session close and a new runtime while legacy shape stays identical", () => {
  const root = tempRoot();
  const traceStore = new TraceStore({ traceRoot: root });
  startTrace(traceStore, "trace-persistent");
  const first = new ReferenceHarnessAdapter({ traceStore, now: () => 1 });
  const session = first.createSession();
  first.submitGoal({ harnessSessionId: session.harnessSessionId, ids: { traceId: "legacy-trace" } });
  const legacy = first.queryTrace({ harnessSessionId: session.harnessSessionId });
  assert.deepEqual(Object.keys(legacy), ["ref", "xwEvents", "dshLog", "bridge"]);
  first.close({ harnessSessionId: session.harnessSessionId });

  const restarted = new ReferenceHarnessAdapter({ traceStore: new TraceStore({ traceRoot: root }), now: () => 2 });
  const persistent = restarted.queryTrace({ traceId: "trace-persistent" });
  assert.equal(persistent.integrity.ok, true);
  assert.equal(persistent.events.length, 2);
  assert.throws(() => restarted.queryTrace({ traceId: "trace-persistent", harnessSessionId: "x" }), { code: "TRACE_QUERY_AMBIGUOUS" });
});
