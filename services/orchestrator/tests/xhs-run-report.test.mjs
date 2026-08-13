import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  backfillRunReport,
  createRunEventWriter,
  readTimeline,
  validateRunReports,
} from "../scripts/lib/xhs-run-report.mjs";
import { actionCommand } from "../scripts/lib/xhs-compose-canary.mjs";
import { assertZeroEffectCommand, runFailureCleanup } from "../ops/xw-xhs-compose-canary-v2.mjs";

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function hashFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), "xhs-run-report-"));
  const runId = "run_fixture";
  const runRoot = join(root, "outbox", "work", runId);
  const attemptRoot = join(runRoot, "xhs-compose-conc4");
  writeJson(join(runRoot, "task.json"), {
    taskId: "task_fixture", runId, actor: "fixture", mode: "explorer",
    goal: "zero effect fixture", startedAt: "2026-08-13T00:00:00.000Z",
  });
  writeFileSync(join(runRoot, "steps.jsonl"), `${JSON.stringify({
    stepId: "step_fixture", title: "fixture passed", status: "ok", exitCode: 0,
    ts: "2026-08-13T00:00:03.000Z", evidence: [], notes: null,
  })}\n`);
  writeJson(join(attemptRoot, "parent.json"), {
    schemaId: "xhs.compose-conc4-parent.v1", runId, attempt: 1, nonce: "fixture",
    createdAt: "2026-08-13T00:00:00.100Z",
  });
  writeJson(join(attemptRoot, "plan.json"), { schemaId: "xhs.compose-conc4-canary-plan.v1", attempt: 1 });
  const commandPath = join(attemptRoot, "01", "seq-1", "1-search_notes", "1000-search_notes.json");
  writeJson(commandPath, {
    alias: "01", actionId: "search_notes", command: ["node", "ops/xhs-search.mjs", "--pages", "1"],
    startedAt: "2026-08-13T00:00:00.500Z", endedAt: "2026-08-13T00:00:01.500Z",
    durationMs: 1000, exitCode: 0, signal: null, timedOut: false, stdout: "SEARCH=ok\n",
    stderr: "", retryCount: 0, attempts: [{ exitCode: 0, stdout: "SEARCH=ok\n", stderr: "" }],
  });
  writeJson(join(attemptRoot, "summary.json"), {
    schemaId: "xhs.compose-conc4-canary-plan.v1", mode: "execute", runId, attempt: 1,
    ok: true, aliases: ["01"], coverage: { expectedPairs: 0, coveredPairs: 0, missing: [] },
    results: [{
      alias: "01", actor: "fixture", ok: true,
      startedAt: "2026-08-13T00:00:00.400Z", endedAt: "2026-08-13T00:00:02.000Z",
      sequences: [{ index: 0, ok: true, actions: [{ actionId: "search_notes", ok: true, durationMs: 1000 }] }],
      effects: { like: 0, collect: 0, follow: 0, comment: 0, publish: 0 }, reason: null, stopClass: null,
    }],
    releases: [{ alias: "01", ok: true, status: 0 }], workerExits: [{ alias: "01", code: 0, signal: null }], stop: null,
  });
  writeJson(join(root, "outbox", "harvest", runId, "closeout.v1.json"), {
    taskId: "task_fixture", runId, actor: "fixture",
    startedAt: "2026-08-13T00:00:00.000Z", endedAt: "2026-08-13T00:00:03.000Z",
    closure: { status: "completed", completed: ["fixture"], remainingWork: [], blockers: [] },
    evidenceDebt: [], artifacts: [],
  });
  return { root, runId, runRoot, attemptRoot };
}

test("event writer persists before publishing and binds contiguous sequence ids", () => {
  const root = mkdtempSync(join(tmpdir(), "xhs-run-events-"));
  try {
    const timeline = join(root, "timeline.jsonl");
    const published = [];
    const writer = createRunEventWriter({
      path: timeline, runId: "run_fixture", attempt: 1,
      now: () => "2026-08-13T00:00:00.000Z",
      onPersisted: (event) => published.push(event),
    });
    writer.append({ event: "attempt_started", status: "running", detail: {}, evidenceRefs: [] });
    writer.append({ event: "heartbeat", status: "running", detail: { activeWorkers: 4 }, evidenceRefs: [] });
    const parsed = readTimeline(timeline);
    assert.deepEqual(parsed.errors, []);
    assert.deepEqual(parsed.events.map((event) => event.seq), [1, 2]);
    assert.deepEqual(published.map((event) => event.event), ["attempt_started", "heartbeat"]);
    assert.match(parsed.events[0].eventId, /^evt_[a-f0-9]{24}$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("event writer fails closed and never reports an unpersisted event", () => {
  const root = mkdtempSync(join(tmpdir(), "xhs-run-events-fail-"));
  try {
    const published = [];
    const writer = createRunEventWriter({
      path: join(root, "timeline.jsonl"), runId: "run_fixture", attempt: 1,
      append: () => { throw new Error("disk full"); },
      onPersisted: (event) => published.push(event),
    });
    assert.throws(
      () => writer.append({ event: "attempt_started", status: "running", detail: {}, evidenceRefs: [] }),
      (error) => error.code === "XHS_RUN_EVENT_WRITE_FAILED" && /disk full/.test(error.message),
    );
    assert.equal(published.length, 0);
    assert.equal(writer.seq, 0);
    assert.equal(writer.failure.code, "XHS_RUN_EVENT_WRITE_FAILED");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("backfill creates deterministic two-level reports without changing raw evidence", () => {
  const fixture = fixtureRepo();
  try {
    const rawPath = join(fixture.attemptRoot, "summary.json");
    const rawHash = hashFile(rawPath);
    const first = backfillRunReport({ repoRoot: fixture.root, runId: fixture.runId });
    assert.equal(first.summary.status, "completed");
    assert.equal(first.attempts[0].summary.status, "passed");
    assert.equal(first.attempts[0].metrics.commands.count, 1);
    assert.equal(first.attempts[0].summary.effects.publish, 0);
    assert.ok(existsSync(join(fixture.runRoot, "report", "run-report.md")));
    assert.ok(existsSync(join(fixture.attemptRoot, "report", "timeline.jsonl")));
    const timelineHash = hashFile(join(fixture.runRoot, "report", "timeline.jsonl"));
    utimesSync(rawPath, new Date("2030-01-01T00:00:00.000Z"), new Date("2030-01-01T00:00:00.000Z"));
    backfillRunReport({ repoRoot: fixture.root, runId: fixture.runId });
    assert.equal(hashFile(join(fixture.runRoot, "report", "timeline.jsonl")), timelineHash);
    assert.equal(hashFile(rawPath), rawHash);
    const validated = validateRunReports({ repoRoot: fixture.root, runId: fixture.runId });
    assert.equal(validated.ok, true, validated.errors.join("; "));
    const reportSummaryPath = join(fixture.attemptRoot, "report", "summary.json");
    const damaged = JSON.parse(readFileSync(reportSummaryPath, "utf8"));
    delete damaged.provenance;
    writeJson(reportSummaryPath, damaged);
    const rejected = validateRunReports({ repoRoot: fixture.root, runId: fixture.runId });
    assert.equal(rejected.ok, false);
    assert.match(rejected.errors.join("; "), /attempt1\.summary:provenance invalid/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("backfill rejects invalid raw timestamps before publishing a timeline", () => {
  const fixture = fixtureRepo();
  try {
    const commandPath = join(fixture.attemptRoot, "01", "seq-1", "1-search_notes", "1000-search_notes.json");
    const command = JSON.parse(readFileSync(commandPath, "utf8"));
    command.startedAt = "not-a-date";
    writeJson(commandPath, command);
    assert.throws(
      () => backfillRunReport({ repoRoot: fixture.root, runId: fixture.runId }),
      /backfill event .* (?:occurredAt|recordedAt) must be a date-time/,
    );
    assert.equal(existsSync(join(fixture.attemptRoot, "report", "timeline.jsonl")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("duplicate attempt numbers fail closed", () => {
  const fixture = fixtureRepo();
  try {
    mkdirSync(join(fixture.runRoot, "xhs-compose-conc4-attempt1"));
    assert.throws(
      () => backfillRunReport({ repoRoot: fixture.root, runId: fixture.runId }),
      /duplicate canary attempt number: 1/,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("v2 canary keeps dry-run effects and uses parent-owned IPC evidence", () => {
  const source = readFileSync(new URL("../ops/xw-xhs-compose-canary-v2.mjs", import.meta.url), "utf8");
  assert.match(source, /stdio: \["ignore", "pipe", "pipe", "ipc"\]/);
  assert.match(source, /createRunEventWriter/);
  assert.match(source, /XHS_RUN_EVENT_WRITE_FAILED/);
  assert.match(source, /xhs-run-event-ack/);
  assert.match(source, /await persistWorkerEvent\(\{\s*event: "action_started"/);
  assert.match(source, /await persistWorkerEvent\(\{\s*event: "action_finished"/);
  assert.ok(actionCommand("like_note", { alias: "01", sessionFile: "fixture.json" }).includes("--dry-run"));
  assert.match(source, /xhs\.compose-conc4-canary-execution-summary\.v1/);
});

test("evidence failure cannot skip worker cleanup", async () => {
  const calls = [];
  const ok = await runFailureCleanup({
    persistEvent: async (event) => {
      calls.push(event);
      throw new Error("timeline unavailable");
    },
    restore: () => calls.push("restore"),
  });
  assert.equal(ok, true);
  assert.deepEqual(calls, ["cleanup_started", "restore", "cleanup_finished"]);
});

test("effect commands are re-verified at dispatch", () => {
  const command = actionCommand("like_note", { alias: "01", sessionFile: "fixture.json" });
  assert.equal(assertZeroEffectCommand("like_note", command), command);
  assert.throws(
    () => assertZeroEffectCommand("like_note", command.filter((token) => token !== "--dry-run")),
    (error) => error.stopClass === "unexpected_effect_risk",
  );
  assert.throws(
    () => assertZeroEffectCommand("like_note", ["ops/xhs-collect-one.mjs", "--dry-run"]),
    /exact dry-run command/,
  );
});
