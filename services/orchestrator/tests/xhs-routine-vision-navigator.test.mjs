import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createRoutineVisionNavigator,
  ROUTINE_VISION_MODES,
} from "../scripts/lib/xhs-routine-vision-navigator.mjs";
import {
  createControlPlaneRoutineDriver,
} from "../scripts/lib/xhs-routine-runner.mjs";

const FEED_FOCUS = {
  package: "com.xingin.xhs",
  activity: "com.xingin.xhs.index.v2.IndexActivityV2",
};
const DETAIL_FOCUS = {
  package: "com.xingin.xhs",
  activity: "com.xingin.xhs.note.NoteDetailActivity",
};
const FEED_XML = '<node class="android.widget.ImageView" content-desc="笔记 攀岩入门三条路线 来自小岩 123赞" text="" clickable="true" bounds="[40,400][500,900]"/>';
const DETAIL_XML = '<node class="android.widget.TextView" content-desc="点赞" text="" bounds="[40,2200][140,2300]"/>'
  + '<node class="android.widget.TextView" content-desc="评论 3" text="" bounds="[240,2200][340,2300]"/>'
  + '<node class="android.widget.TextView" text="小岩" bounds="[40,600][120,660]"/>';

// minimal PNG: 8-byte signature + a full IHDR chunk (33 bytes); readPngDims
// only needs the signature and the big-endian width/height at bytes 16-23
function makePngBytes(width = 1080, height = 2400) {
  const buf = Buffer.alloc(33);
  buf[0] = 0x89; buf[1] = 0x50; buf[2] = 0x4e; buf[3] = 0x47;
  buf[4] = 0x0d; buf[5] = 0x0a; buf[6] = 0x1a; buf[7] = 0x0a;
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  buf.writeUInt32BE(0xdeadbeef >>> 0, 29);
  return buf;
}

function pinnedProvider(blocks) {
  return {
    id: "real-provider",
    version: "1.0.0",
    modelSha256: "a".repeat(64),
    segment: () => blocks,
  };
}

const CANARY_BINDING = {
  executionRunId: "exec-vision-1",
  planHash: "planhash-vision-1",
  alias: "03",
  sessionId: "session-03",
  deviceId: "device-03",
};

function visionHarness({
  blocks = [{ label: "笔记 攀岩入门三条路线", bounds: { x: 40, y: 400, w: 460, h: 500 }, confidence: 0.92, capturedAt: null }],
  pngBytes = makePngBytes(),
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "xhs-vision-nav-"));
  const pngPath = join(dir, "frame.png");
  writeFileSync(pngPath, pngBytes);
  const clock = { nowMs: () => 1_780_000_000_000 };
  const navigator = createRoutineVisionNavigator({
    mode: "canary",
    provider: pinnedProvider(blocks),
    captureFrame: async () => ({
      pngPath,
      bytes: pngBytes,
      frameId: "screen:rr-1:1",
      capturedAt: 1_780_000_000_000,
    }),
    ledgerPath: null,
    live: true,
    clock,
  });
  return {
    navigator,
    clock,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("navigator mode enum is the sealed fallback|shadow|canary set and rejects unknown modes", () => {
  assert.deepEqual([...ROUTINE_VISION_MODES], ["fallback", "shadow", "canary"]);
  assert.throws(
    () => createRoutineVisionNavigator({ mode: "auto", provider: pinnedProvider([]), captureFrame: async () => ({}) }),
    (error) => error.code === "ROUTINE_VISION_MODE_INVALID",
  );
});

test("fallback navigator is a no-op seam: no provider, every request refuses", async () => {
  const navigator = createRoutineVisionNavigator({ mode: "fallback" });
  assert.equal(navigator.permitsIssued, 0);
  assert.deepEqual(
    await navigator.authorizeR0Navigation({ ...CANARY_BINDING }),
    { ok: false, reason: "VISION_FALLBACK_DISABLED" },
  );
  assert.deepEqual(
    await navigator.observePage({ ...CANARY_BINDING }),
    { ok: false, reason: "VISION_FALLBACK_DISABLED" },
  );
});

test("navigator construction fails closed on unusable provider/capture/pin", () => {
  const base = { mode: "canary", captureFrame: async () => ({}) };
  assert.throws(
    () => createRoutineVisionNavigator({ ...base, provider: { id: "x", segment: "nope" } }),
    (error) => error.code === "ROUTINE_VISION_PROVIDER_INVALID",
  );
  assert.throws(
    () => createRoutineVisionNavigator({ mode: "canary", provider: pinnedProvider([]) }),
    (error) => error.code === "ROUTINE_VISION_CAPTURE_INVALID",
  );
  assert.throws(
    () => createRoutineVisionNavigator({
      ...base,
      provider: { ...pinnedProvider([]), modelSha256: "short" },
    }),
    (error) => error.code === "ROUTINE_VISION_PROVIDER_UNPINNED",
  );
  assert.throws(
    () => createRoutineVisionNavigator({
      ...base,
      provider: { ...pinnedProvider([]), id: "fixture-vision" },
    }),
    (error) => error.code === "ROUTINE_VISION_PROVIDER_REJECTED",
  );
});

test("shadow mode records observations with tapAuthorized=false and never issues a permit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "xhs-vision-nav-"));
  const pngPath = join(dir, "frame.png");
  writeFileSync(pngPath, makePngBytes());
  try {
    const shadow = createRoutineVisionNavigator({
      mode: "shadow",
      provider: pinnedProvider([{ label: "笔记 手工烘焙", bounds: { x: 10, y: 10, w: 100, h: 100 }, confidence: 0.9 }]),
      captureFrame: async () => ({ pngPath, bytes: makePngBytes(), frameId: "f1", capturedAt: 1_780_000_000_000 }),
      live: true,
      clock: { nowMs: () => 1_780_000_000_000 },
    });
    assert.equal(shadow.mode, "shadow");
    assert.deepEqual(
      await shadow.authorizeR0Navigation({ ...CANARY_BINDING }),
      { ok: false, reason: "VISION_SHADOW_NO_TAP" },
    );
    assert.equal(shadow.permitsIssued, 0);
    const observation = await shadow.observePage({ ...CANARY_BINDING });
    assert.equal(observation.ok, true);
    assert.equal(observation.observation.page, "IMAGE_NOTE");
    assert.equal(observation.observation.tapAuthorized, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("canary mode issues exactly one fully-bound R0 permit, then the cap closes", async () => {
  const { navigator, cleanup } = visionHarness();
  try {
    const result = await navigator.authorizeR0Navigation({
      ...CANARY_BINDING,
      targetLabel: "笔记",
    });
    assert.equal(result.ok, true);
    const { permit, target } = result;
    assert.equal(permit.actionClass, "R0_NAVIGATION");
    assert.equal(permit.oneShot, true);
    assert.equal(permit.consumed, false);
    assert.equal(permit.effectControl, false);
    assert.equal(permit.page, "HOME_FEED");
    assert.equal(permit.frameId, "screen:rr-1:1");
    assert.match(permit.permitId, /^act_[0-9a-f]{24}$/);
    assert.equal(permit.blockId, target.blockId);
    assert.deepEqual(permit.dims, { width: 1080, height: 2400 });
    assert.equal(permit.expiresAtMs, 1_780_000_000_000 + 30_000);
    assert.deepEqual(permit.provider, {
      id: "real-provider",
      version: "1.0.0",
      modelSha256: "a".repeat(64),
    });
    for (const key of ["executionRunId", "planHash", "alias", "sessionId", "deviceId"]) {
      assert.equal(permit[key], CANARY_BINDING[key], `permit binds ${key}`);
    }
    assert.equal(target.effectControl, false);
    assert.ok(Number.isFinite(target.x) && Number.isFinite(target.y));
    assert.equal(target.x, 40 + 460 / 2);
    assert.equal(target.y, 400 + 500 / 2);
    assert.equal(navigator.permitsIssued, 1);
    assert.deepEqual(
      await navigator.authorizeR0Navigation({ ...CANARY_BINDING }),
      { ok: false, reason: "VISION_CANARY_TAP_CAP_REACHED" },
    );
  } finally {
    cleanup();
  }
});

test("vision requests without the full binding tuple are rejected before any capture", async () => {
  const { navigator, cleanup } = visionHarness();
  try {
    const { executionRunId, ...partial } = CANARY_BINDING;
    await assert.rejects(
      () => navigator.authorizeR0Navigation(partial),
      (error) => error.code === "ROUTINE_VISION_BINDING_INVALID",
    );
    assert.equal(navigator.permitsIssued, 0);
  } finally {
    cleanup();
  }
});

test("frame bytes that do not match the CP evidence hash fail closed (drift)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "xhs-vision-nav-"));
  const pngPath = join(dir, "frame.png");
  writeFileSync(pngPath, makePngBytes());
  try {
    const navigator = createRoutineVisionNavigator({
      mode: "canary",
      provider: pinnedProvider([{ label: "笔记 测试", bounds: { x: 0, y: 0, w: 10, h: 10 }, confidence: 0.9 }]),
      // capturedAt null on blocks + a fresh capture keeps expiry out of the way
      captureFrame: async () => ({ pngPath, bytes: makePngBytes(720, 1600), frameId: "f2", capturedAt: 1_780_000_000_000 }),
      live: true,
      clock: { nowMs: () => 1_780_000_000_000 },
    });
    await assert.rejects(
      () => navigator.authorizeR0Navigation({ ...CANARY_BINDING }),
      (error) => error.code === "ROUTINE_VISION_FRAME_DRIFT",
    );
    assert.equal(navigator.permitsIssued, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("observePage classifies the open detail from pinned blocks; unknown surfaces refuse", async () => {
  const { navigator, cleanup } = visionHarness({
    blocks: [{ label: "视频 手工烘焙全流程", bounds: { x: 0, y: 0, w: 500, h: 500 }, confidence: 0.9 }],
  });
  const unknownDir = mkdtempSync(join(tmpdir(), "xhs-vision-nav-"));
  const unknownPng = join(unknownDir, "frame.png");
  writeFileSync(unknownPng, makePngBytes());
  try {
    const result = await navigator.observePage({ ...CANARY_BINDING });
    assert.equal(result.ok, true);
    assert.equal(result.observation.page, "VIDEO_NOTE");
    assert.equal(result.observation.tapAuthorized, false);
    assert.equal(result.observation.provider.modelSha256, "a".repeat(64));
    assert.equal(result.observation.executionRunId, CANARY_BINDING.executionRunId);

    const unknown = createRoutineVisionNavigator({
      mode: "canary",
      provider: pinnedProvider([{ label: "设置", bounds: { x: 0, y: 0, w: 10, h: 10 }, confidence: 0.9 }]),
      captureFrame: async () => ({ pngPath: unknownPng, bytes: makePngBytes(), frameId: "f3", capturedAt: 1 }),
      live: true,
      clock: { nowMs: () => 1_780_000_000_000 },
    });
    assert.deepEqual(
      await unknown.observePage({ ...CANARY_BINDING }),
      { ok: false, reason: "VISION_DETAIL_UNSAFE_OR_UNKNOWN" },
    );
  } finally {
    cleanup();
    rmSync(unknownDir, { recursive: true, force: true });
  }
});

function driverHarness({ pngBytes = makePngBytes() } = {}) {
  let page = "feed";
  let taps = 0;
  const calls = [];
  const driver = createControlPlaneRoutineDriver({
    execution: { executionRunId: "exec-vision-1", routineRunId: "rr-1", alias: "03" },
    session: { sessionId: "session-03", leaseId: "lease-03", token: "t", deviceId: "device-03" },
    async executeSessionAction(_sessionId, _token, action) {
      calls.push(action.params);
      const primitive = action.params.primitive;
      let output = { ok: true };
      if (primitive === "focus") output = { ok: true, ...(page === "feed" ? FEED_FOCUS : DETAIL_FOCUS) };
      if (primitive === "dump_ui") output = { ok: true, path: `C:\\trusted\\${page}.xml`, bytes: 123 };
      if (primitive === "screen") output = { ok: true, path: "C:\\trusted\\screen.png", bytes: pngBytes.length };
      if (primitive === "tap") { taps += 1; page = "detail"; }
      if (primitive === "back" || primitive === "launch_app") page = "feed";
      return { jobId: `job-${calls.length}`, status: "succeeded", runId: "rr-1", result: { output } };
    },
    heartbeatSession: async () => ({ ok: true }),
    async releaseSession() { return { released: true }; },
    listLeases: () => [],
    readDumpArtifact: ({ path }) => (String(path).includes("detail") ? DETAIL_XML : FEED_XML),
    readScreenArtifact: ({ path }) => {
      assert.equal(path, "C:\\trusted\\screen.png");
      return pngBytes;
    },
    sleepFn: async () => {},
    now: () => 1_780_000_000_000,
  });
  return { driver, calls, tapCount: () => taps };
}

const VALID_PERMIT = {
  permitId: "act_" + "0".repeat(24),
  actionClass: "R0_NAVIGATION",
  oneShot: true,
  consumed: false,
  effectControl: false,
  expiresAtMs: 1_780_000_030_000,
  frameId: "screen:rr-1:1",
};

test("driver screenshot() returns CP-bound PNG bytes with a run-scoped frameId", async () => {
  const { driver } = driverHarness();
  const frame = await driver.screenshot();
  assert.ok(Buffer.isBuffer(frame.bytes));
  assert.equal(frame.frameId, "screen:rr-1:1");
  assert.equal(frame.capturedAt, 1_780_000_000_000);
  const second = await driver.screenshot();
  assert.equal(second.frameId, "screen:rr-1:2");
});

test("driver honors exactly one vision-r0 tap from a valid permit, then caps", async () => {
  const { driver, tapCount, calls } = driverHarness();
  const first = await driver.tapAt({
    x: 270, y: 650, source: "vision-r0", cardKind: "note", visionPermit: { ...VALID_PERMIT },
  });
  assert.equal(first.ok, true);
  assert.equal(first.detailPage, "IMAGE_NOTE");
  assert.equal(first.source, "vision-r0");
  assert.equal(tapCount(), 1);
  const tap = calls.find((params) => params.primitive === "tap");
  assert.deepEqual({ x: tap.x, y: tap.y }, { x: 270, y: 650 });

  const second = await driver.tapAt({
    x: 270, y: 650, source: "vision-r0", cardKind: "note", visionPermit: { ...VALID_PERMIT },
  });
  assert.equal(second.ok, false);
  assert.equal(second.noAction, true);
  assert.equal(second.reason, "VISION_TAP_CAP_REACHED");
  assert.equal(tapCount(), 1, "no second physical tap ever leaves the permit cap");
});

test("driver re-validates the permit structurally and refuses without a tap", async () => {
  const { driver, tapCount } = driverHarness();
  const cases = [
    { visionPermit: null, reason: "VISION_PERMIT_REJECTED" },
    { visionPermit: { ...VALID_PERMIT, actionClass: "EFFECT_LIKE" }, reason: "VISION_PERMIT_REJECTED" },
    { visionPermit: { ...VALID_PERMIT, oneShot: false }, reason: "VISION_PERMIT_REJECTED" },
    { visionPermit: { ...VALID_PERMIT, consumed: true }, reason: "VISION_PERMIT_REJECTED" },
    { visionPermit: { ...VALID_PERMIT, effectControl: true }, reason: "VISION_PERMIT_REJECTED" },
    { visionPermit: { ...VALID_PERMIT, expiresAtMs: 1_779_999_999_999 }, reason: "VISION_PERMIT_EXPIRED" },
    { visionPermit: { ...VALID_PERMIT, expiresAtMs: "soon" }, reason: "VISION_PERMIT_EXPIRED" },
  ];
  for (const { visionPermit, reason } of cases) {
    const result = await driver.tapAt({
      x: 270, y: 650, source: "vision-r0", cardKind: "note", visionPermit,
    });
    assert.equal(result.reason, reason);
    assert.equal(result.ok, false);
    assert.equal(result.noAction, true);
  }
  assert.equal(tapCount(), 0, "rejected permits transport zero taps");
});

test("unknown tap sources stay rejected; dump-sourced taps keep the fingerprint recheck", async () => {
  const { driver } = driverHarness();
  const alien = await driver.tapAt({ x: 1, y: 2, source: "raw-coordinates" });
  assert.equal(alien.reason, "VISION_PROVIDER_NOT_WIRED");
  const dumpWithoutFingerprint = await driver.tapAt({ x: 270, y: 650, source: "dump" });
  assert.equal(dumpWithoutFingerprint.reason, "TAP_TARGET_RECHECK_FAILED");
});