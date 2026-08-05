import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createProgressTracker,
  observeStall,
  uiFingerprint,
  DEFAULT_STALL_MS,
} from "../scripts/lib/stall-progress.mjs";

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

test("observeStall stays quiet while UI changes, then escalates after stallMs", () => {
  let state = { fingerprint: null, screenSha256: null, changedAt: null, stalled: false, stalledAt: null };
  const t0 = 1_000_000;
  ({ state } = observeStall(state, { fingerprint: "aaa", now: t0, stallMs: 1000 }));
  assert.equal(state.stalled, false);

  let event = null;
  ({ state, event } = observeStall(state, { fingerprint: "bbb", now: t0 + 500, stallMs: 1000 }));
  assert.equal(event, null);
  assert.equal(state.fingerprint, "bbb");

  ({ state, event } = observeStall(state, { fingerprint: "bbb", now: t0 + 500 + 999, stallMs: 1000 }));
  assert.equal(event, null);

  ({ state, event } = observeStall(state, { fingerprint: "bbb", now: t0 + 500 + 1000, stallMs: 1000 }));
  assert.equal(event?.kind, "stall");
  assert.equal(event?.llmEscalationRecommended, true);
  assert.equal(event?.diagnosisHint, "stuck_or_slow");
  assert.equal(state.stalled, true);

  ({ state, event } = observeStall(state, { fingerprint: "ccc", now: t0 + 3000, stallMs: 1000 }));
  assert.equal(event?.kind, "stall_cleared");
  assert.equal(state.stalled, false);
});

test("createProgressTracker writes progress.jsonl and flags stall", () => {
  const dir = mkdtempSync(join(tmpdir(), "stall-progress-"));
  try {
    let clock = 5_000_000;
    const tracker = createProgressTracker({
      evidenceDir: dir,
      stallMs: 2000,
      now: () => clock,
    });
    const snapA = {
      focus: { package: "com.taobao.idlefish", activity: "Compose" },
      nodes: [{ label: "宝贝描述" }],
    };
    const snapSame = {
      focus: { package: "com.taobao.idlefish", activity: "Compose" },
      nodes: [{ label: "宝贝描述" }],
    };
    tracker.note({ phase: "start", name: "open", snap: snapA });
    clock += 2500;
    const stalled = tracker.note({ phase: "ok", name: "images", snap: snapSame });
    assert.equal(stalled.stalled, true);
    assert.equal(stalled.llmEscalationRecommended, true);
    assert.equal(stalled.diagnosisHint, "stuck_or_slow");
    assert.ok(tracker.path.endsWith("progress.jsonl"));
    const lines = readFileSync(tracker.path, "utf8").trim().split(/\n/);
    assert.equal(lines.length, 2);
    const summary = tracker.summary();
    assert.equal(summary.stalled, true);
    assert.equal(summary.stallEvents.length, 1);
    assert.equal(DEFAULT_STALL_MS >= 1000, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
