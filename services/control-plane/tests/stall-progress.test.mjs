import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createProgressTracker,
  observeStall,
  observeProgressSilence,
  uiFingerprint,
  DEFAULT_STALL_MS,
} from "../scripts/lib/stall-progress.mjs";
import {
  readProgressJsonl,
  classifyStallVerdict,
  buildStallVerdictFromEvidenceDir,
} from "../scripts/lib/stall-verdict.mjs";

test("uiFingerprint is stable for same labels and changes when UI changes", () => {
  const a = uiFingerprint({
    focus: { package: "com.taobao.idlefish", activity: "Main" },
    nodes: [{ label: "存草稿" }, { label: "发布" }],
  });
  const b = uiFingerprint({
    focus: { package: "com.taobao.idlefish", activity: "Main" },
    nodes: [{ label: "发布" }, { label: "存草稿" }],
  });
  const c = uiFingerprint({
    focus: { package: "com.taobao.idlefish", activity: "Main" },
    nodes: [{ label: "存草稿" }, { label: "我知道了" }],
  });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("ui_stall requires two fresh identical fingerprints spanning stallMs", () => {
  let state = null;
  const t0 = 1_000_000;
  let event = null;
  ({ state, event } = observeStall(state, { fingerprint: "aaa", now: t0, stallMs: 1000, fresh: true }));
  assert.equal(event, null);
  assert.equal(state.freshCount, 1);

  ({ state, event } = observeStall(state, { fingerprint: "aaa", now: t0 + 999, stallMs: 1000, fresh: true }));
  assert.equal(event, null);
  assert.equal(state.freshCount, 2);

  ({ state, event } = observeStall(state, { fingerprint: "aaa", now: t0 + 1000, stallMs: 1000, fresh: true }));
  assert.equal(event?.signalType, "ui_stall");
  assert.equal(event?.diagnosisHint, "ui_stall");
  assert.equal(state.uiStalled, true);

  ({ state, event } = observeStall(state, { fingerprint: "bbb", now: t0 + 3000, stallMs: 1000, fresh: true }));
  assert.equal(event?.kind, "stall_cleared");
  assert.equal(state.uiStalled, false);
});

test("non-fresh notes must not create ui_stall via fingerprint reuse", () => {
  let state = null;
  const t0 = 2_000_000;
  ({ state } = observeStall(state, { fingerprint: "same", now: t0, stallMs: 500, fresh: true }));
  let event = null;
  ({ state, event } = observeStall(state, {
    fingerprint: "same",
    now: t0 + 5000,
    stallMs: 500,
    fresh: false,
  }));
  assert.equal(event, null);
  assert.equal(state.uiStalled, false);

  const silence = observeProgressSilence(state, { now: t0 + 5000, stallMs: 500 });
  assert.equal(silence.event?.signalType, "progress_silence");
});

test("createProgressTracker writes monotonic seq and progress_silence without snap", async () => {
  const dir = mkdtempSync(join(tmpdir(), "stall-progress-"));
  try {
    let clock = 5_000_000;
    const tracker = createProgressTracker({
      evidenceDir: dir,
      stallMs: 200,
      heartbeatMs: 50,
      now: () => clock,
      runId: "run_test",
      jobId: "job_test",
    });
    tracker.note({ phase: "start", name: "open" });
    assert.equal(tracker.getSeq(), 1);
    clock += 250;
    const silenced = tracker.note({ phase: "heartbeat", name: "open" });
    assert.equal(silenced.signalType, "progress_silence");
    assert.equal(silenced.llmEscalationRecommended, true);
    assert.equal(silenced.seq, 2);

    const snap = {
      focus: { package: "com.taobao.idlefish", activity: "Compose" },
      nodes: [{ label: "宝贝描述" }],
    };
    clock += 10;
    tracker.note({ phase: "ok", name: "open", snap, ok: true });
    clock += 250;
    const stalled = tracker.note({ phase: "ok", name: "images", snap, ok: true });
    assert.equal(stalled.signalType, "ui_stall");

    const lines = readFileSync(tracker.path, "utf8").trim().split(/\n/).map((l) => JSON.parse(l));
    assert.equal(lines[0].seq, 1);
    assert.equal(lines[1].seq, 2);
    assert.equal(lines[2].seq, 3);
    assert.ok(DEFAULT_STALL_MS >= 1000);

    // heartbeat timer during long await (real clock; stallMs high so silence does not fire)
    const hbDir = join(dir, "hb");
    mkdirSync(hbDir, { recursive: true });
    const t2 = createProgressTracker({
      evidenceDir: hbDir,
      stallMs: 60_000,
      heartbeatMs: 20,
    });
    t2.startHeartbeat({ name: "upload", intervalMs: 50 });
    await new Promise((r) => setTimeout(r, 180));
    t2.stopHeartbeat();
    assert.ok(t2.getSeq() >= 2, `expected heartbeats, got seq=${t2.getSeq()}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stall verdict: contract_violation on timeout without progress", () => {
  const dir = mkdtempSync(join(tmpdir(), "stall-verdict-"));
  try {
    const verdict = buildStallVerdictFromEvidenceDir(dir, {
      errorCode: "ADAPTER_TIMEOUT",
      phase: "pre-restore",
    });
    assert.equal(verdict.signalType, "contract_violation");
    assert.equal(verdict.llmEscalationRecommended, true);
    assert.match(verdict.hash, /^[a-f0-9]{64}$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stall verdict rejects non-monotonic seq", () => {
  const dir = mkdtempSync(join(tmpdir(), "stall-verdict-bad-"));
  try {
    writeFileSync(
      join(dir, "progress.jsonl"),
      `${JSON.stringify({ seq: 1, phase: "start", t: "t1" })}\n${JSON.stringify({ seq: 1, phase: "heartbeat", t: "t2" })}\n`,
      "utf8",
    );
    const bad = readProgressJsonl(dir);
    assert.equal(bad.ok, false);
    assert.equal(bad.code, "PROGRESS_SEQ_INVALID");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("slow success with changing UI does not recommend LLM", () => {
  const dir = mkdtempSync(join(tmpdir(), "stall-slow-"));
  try {
    let clock = 7_000_000;
    const tracker = createProgressTracker({
      evidenceDir: dir,
      stallMs: 100,
      now: () => clock,
    });
    tracker.note({
      phase: "ok",
      name: "a",
      snap: { focus: { package: "p", activity: "A" }, nodes: [{ label: "1" }] },
      ok: true,
    });
    clock += 500;
    tracker.note({
      phase: "ok",
      name: "b",
      snap: { focus: { package: "p", activity: "A" }, nodes: [{ label: "2" }] },
      ok: true,
    });
    const summary = tracker.summary();
    assert.equal(summary.stalled, false);
    assert.equal(summary.diagnosisHint, "ok");
    const progress = readProgressJsonl(dir);
    const verdict = classifyStallVerdict({ progress, errorCode: null, phase: "success" });
    assert.equal(verdict.signalType, "slow_progress");
    assert.equal(verdict.llmEscalationRecommended, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
