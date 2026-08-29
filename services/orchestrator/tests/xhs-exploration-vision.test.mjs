import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createExplorationVisionNavigator,
  createLaneVisionQueue,
  resolvePinnedVisionConfig,
  runBoundedVisionWork,
} from "../scripts/lib/xhs-exploration-vision.mjs";
import { buildPinnedVisionConfig } from "../ops/xw-xhs-vision-pin.mjs";

function png(width = 1080, height = 2400) {
  const bytes = Buffer.alloc(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

const IDENTITY = Object.freeze({
  pythonHash: "9".repeat(64),
  modelHash: "a".repeat(64),
  scriptHash: "b".repeat(64),
  configHash: "c".repeat(64),
});

function dumpDecision(verdict = "ABSENT_OR_INVALID") {
  return {
    verdict,
    page: "VIDEO_NOTE",
    navigationRole: "PAUSE_VIDEO_SAFE_ZONE",
    positiveRegion: { x: 0, y: 120, w: 1080, h: 1760 },
    protectedZones: [
      { x: 0, y: 0, w: 1080, h: 120 },
      { x: 0, y: 1880, w: 1080, h: 520 },
    ],
  };
}

function block(overrides = {}) {
  return {
    label: "暂停视频安全区",
    bounds: { x: 420, y: 800, w: 240, h: 240 },
    confidence: 0.96,
    ...overrides,
  };
}

function navigatorHarness({ mode = "canary1", workRun = async () => [block()], nowMs = 1_000 } = {}) {
  const bytes = png();
  const reservations = [];
  const settlements = [];
  const journals = [];
  let currentNow = nowMs;
  const navigator = createExplorationVisionNavigator({
    mode,
    providerIdentity: IDENTITY,
    clock: { nowMs: () => currentNow },
    captureFrame: async () => ({ frameId: "screen:03:1", bytes, capturedAt: 1_000 }),
    work: { run: workRun },
    reserveAnalysisAttempt: async (input) => {
      reservations.push(input);
      return { reservationId: `res-${reservations.length}` };
    },
    settleAnalysisAttempt: async (input) => { settlements.push(input); },
    journalAppend: async (record) => { journals.push(record); },
  });
  return {
    navigator,
    bytes,
    reservations,
    settlements,
    journals,
    setNow(value) { currentNow = value; },
  };
}

const REQUEST = Object.freeze({
  navigationRole: "PAUSE_VIDEO_SAFE_ZONE",
  page: "VIDEO_NOTE",
  evidenceHash: "d".repeat(64),
  dumpDecision: dumpDecision(),
  deadlineMs: 8000,
});

test("pin config hashes python/script/model plus every semantic rule and timing field", () => {
  const root = mkdtempSync(join(tmpdir(), "xhs-v3-vision-pin-"));
  try {
    const python = join(root, "python.exe");
    const script = join(root, "analyze.py");
    const model = join(root, "model.bin");
    const configPath = join(root, "provider.json");
    writeFileSync(python, "python-bytes");
    writeFileSync(script, "script-bytes");
    writeFileSync(model, "model-bytes");
    const config = buildPinnedVisionConfig({ mode: "shadow", python, script, model, timeoutMs: 7000 });
    writeFileSync(configPath, JSON.stringify(config));
    const resolved = resolvePinnedVisionConfig(configPath);
    assert.match(resolved.provider.pythonHash, /^[a-f0-9]{64}$/);
    assert.equal(resolved.analysis.timeoutMs, 7000);
    const firstHash = resolved.provider.configHash;
    config.analysis.timeoutMs = 6999;
    writeFileSync(configPath, JSON.stringify(config));
    assert.notEqual(resolvePinnedVisionConfig(configPath).provider.configHash, firstHash);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bounded work rejects caller deadline widening and aborts an in-flight provider", async () => {
  await assert.rejects(
    () => runBoundedVisionWork({ analyze: async () => [], deadlineMs: 8001 }),
    (error) => error.code === "EXPLORATION_VISION_DEADLINE_INVALID",
  );
  let aborted = false;
  await assert.rejects(
    () => runBoundedVisionWork({
      deadlineMs: 20,
      analyze: ({ signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("child-killed"));
        }, { once: true });
      }),
    }),
    (error) => error.code === "EXPLORATION_VISION_DEADLINE",
  );
  assert.equal(aborted, true);
});

test("lane queue is bounded and queued cancellation never starts provider work", async () => {
  let releaseFirst;
  let calls = 0;
  const queue = createLaneVisionQueue({
    queueMax: 2,
    analyze: async ({ ordinal }) => {
      calls += 1;
      if (ordinal === 1) await new Promise((resolve) => { releaseFirst = resolve; });
      return [];
    },
  });
  const first = queue.run({ ordinal: 1, deadlineMs: 1000 });
  await new Promise((resolve) => setImmediate(resolve));
  const controller = new AbortController();
  const queued = queue.run({ ordinal: 2, deadlineMs: 1000, signal: controller.signal });
  controller.abort();
  await assert.rejects(queued, (error) => error.code === "EXPLORATION_VISION_CANCELLED");
  releaseFirst();
  await first;
  assert.equal(calls, 1);
  assert.deepEqual(queue.stats(), { inflight: 0, queued: 0 });
});

test("forbidden DUMP stops before capture, provider, and CP analysis reservation", async () => {
  const h = navigatorHarness();
  await assert.rejects(
    () => h.navigator.proposeNavigationCandidate({ ...REQUEST, dumpDecision: dumpDecision("FORBIDDEN_OR_RISKY") }),
    (error) => error.code === "EXPLORATION_VISION_DUMP_FORBIDDEN",
  );
  assert.equal(h.reservations.length, 0);
  assert.deepEqual(h.navigator.stats(), { analysisAttempts: 0, permitsIssued: 0, permitsConsumed: 0, physicalTaps: 0 });
});

test("shadow binds provider to the exact frame bytes, spends one attempt, and always authorizes zero taps", async () => {
  let observedFrame = null;
  const h = navigatorHarness({
    mode: "shadow",
    workRun: async ({ frame }) => {
      observedFrame = frame;
      return [block()];
    },
  });
  const result = await h.navigator.observeShadow(REQUEST);
  assert.equal(result.ok, true);
  assert.equal(result.tapAuthorized, false);
  assert.ok(Buffer.isBuffer(observedFrame.bytes));
  assert.match(observedFrame.frameHash, /^[a-f0-9]{64}$/);
  assert.equal(h.reservations.length, 1);
  assert.equal(h.settlements[0].outcome, "consumed");
  assert.equal(h.settlements[0].result.candidate.confidence, 0.96);
  assert.deepEqual(h.navigator.stats(), { analysisAttempts: 1, permitsIssued: 0, permitsConsumed: 0, physicalTaps: 0 });
  assert.equal(h.journals.at(-1).tapAuthorized, false);
});

test("frame age is rechecked after provider analysis and a stale completion cannot become a candidate", async () => {
  let h;
  h = navigatorHarness({
    workRun: async () => {
      h.setNow(11_001);
      return [block()];
    },
  });
  const result = await h.navigator.proposeCanaryTap(REQUEST);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "EXPLORATION_VISION_FRAME_STALE");
  assert.equal(h.settlements[0].outcome, "failed");
  assert.deepEqual(h.navigator.stats(), { analysisAttempts: 1, permitsIssued: 0, permitsConsumed: 0, physicalTaps: 0 });
});

test("canary returns a candidate only; the four counters advance at their real lifecycle boundaries", async () => {
  const h = navigatorHarness();
  const proposed = await h.navigator.proposeCanaryTap(REQUEST);
  assert.equal(proposed.ok, true);
  assert.equal(proposed.candidateReady, true);
  assert.equal(proposed.tapAuthorized, false, "provider output is not a CP permit");
  assert.deepEqual(proposed.target.bounds, block().bounds);
  assert.deepEqual(h.navigator.stats(), { analysisAttempts: 1, permitsIssued: 0, permitsConsumed: 0, physicalTaps: 0 });
  h.navigator.recordPermitIssued();
  h.navigator.recordPermitConsumed();
  h.navigator.recordPhysicalTap();
  assert.deepEqual(h.navigator.stats(), { analysisAttempts: 1, permitsIssued: 1, permitsConsumed: 1, physicalTaps: 1 });
  assert.deepEqual(
    await h.navigator.proposeCanaryTap(REQUEST),
    { ok: false, reason: "VISION_CANARY_TAP_CAP_REACHED" },
  );
});

test("duplicate, low-confidence, protected-zone, and effect-control candidates all yield tap=0", async () => {
  const cases = [
    [block(), block({ bounds: { x: 100, y: 500, w: 100, h: 100 } })],
    [block({ confidence: 0.89 })],
    [block({ bounds: { x: 420, y: 1900, w: 240, h: 200 } })],
    [block({ label: "评论发送 暂停" })],
  ];
  for (const blocks of cases) {
    const h = navigatorHarness({ workRun: async () => blocks });
    const result = await h.navigator.proposeCanaryTap(REQUEST);
    assert.equal(result.ok, false);
    assert.equal(h.navigator.stats().permitsIssued, 0);
    assert.equal(h.navigator.stats().physicalTaps, 0);
  }
});
