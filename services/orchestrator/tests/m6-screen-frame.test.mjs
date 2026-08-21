import assert from "node:assert/strict";
import test from "node:test";
import { deflateSync } from "node:zlib";

import {
  M6_FRAME_CONSTANTS,
  assembleLiveStrictFrame,
  assembleReplayFrame,
  buildCanonicalFrame,
  focusStableFieldsHash,
  parseFocusStableFields,
  pngHeaderOf,
} from "../../../packages/kernel/lib/m6-screen-frame.mjs";

// ---------------------------------------------------------------------------
// Deterministic real PNG bytes (signature + IHDR + IDAT + IEND with valid CRC)
// so the strict tests exercise actual PNG structure, not mocks.
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function makePng(width, height, seed = 0) {
  const rowBytes = 1 + width * 3;
  const raw = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * rowBytes] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      raw[y * rowBytes + 1 + x * 3] = (x + seed) % 256;
      raw[y * rowBytes + 1 + x * 3 + 1] = (y + seed) % 256;
      raw[y * rowBytes + 1 + x * 3 + 2] = (x + y + seed) % 256;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  const chunk = (type, data) => {
    const buf = Buffer.alloc(12 + data.length);
    buf.writeUInt32BE(data.length, 0);
    buf.write(type, 4, "latin1");
    data.copy(buf, 8);
    buf.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "latin1"), data])), 8 + data.length);
    return buf;
  };
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const PNG_240 = makePng(240, 320);
const PNG_240_ALT = makePng(240, 320, 7); // same dims, different pixels
const PNG_120 = makePng(120, 160);        // different dims
const OBS = { width: 240, height: 320, orientation: "portrait", density: 3 };
const FOCUS_LINE = "mCurrentFocus=Window{3c8e05b u0 com.tencent.mm/com.tencent.mm.ui.LauncherUI}";
const FOCUS_A = { raw: FOCUS_LINE, screenOn: true, keyboardVisible: false, rotation: 0 };
const FOCUS_B = { raw: FOCUS_LINE, screenOn: true, keyboardVisible: false, rotation: 0 };
const CAPTURED_AT = "2026-08-21T12:00:00.000Z";

function liveInput(overrides = {}) {
  return {
    screenshotABytes: PNG_240,
    screenshotBBytes: PNG_240,
    dumpBytes: Buffer.from("u0 com.tencent.mm home dump"),
    focusA: FOCUS_A,
    focusB: FOCUS_B,
    displayObservation: OBS,
    skew: { aToBMs: 350, bToFocusBMs: 120 },
    nowMs: Date.parse("2026-08-21T12:00:00.500Z"),
    capturedAt: CAPTURED_AT,
    evidence: {
      screenshotA: { id: "att-screen-a-x", sha256: "a".repeat(64) },
      screenshotB: { id: "att-screen-b-x", sha256: "b".repeat(64) },
      dump: { id: "att-dump-x", sha256: "c".repeat(64) },
      focus: { id: "att-focus-x", sha256: "d".repeat(64) },
      observation: { id: "att-obs-x", sha256: "e".repeat(64) },
    },
    linkage: { sessionId: "sess-m6-0001", leaseRef: "lease-m6-0001", alias: "01", appId: "com.tencent.mm" },
    pageFingerprint: "0".repeat(64),
    focusFingerprint: "1".repeat(64),
    ...overrides,
  };
}

test("focus stable fields parse from dumpsys line and bare token identically", () => {
  const fromLine = parseFocusStableFields(FOCUS_A);
  assert.equal(fromLine.package, "com.tencent.mm");
  assert.equal(fromLine.activity, "com.tencent.mm.ui.LauncherUI");
  assert.equal(fromLine.screenOn, true);
  assert.equal(fromLine.rotation, 0);

  const bare = parseFocusStableFields("com.tencent.mm/com.tencent.mm.ui.LauncherUI");
  assert.deepEqual(
    { package: bare.package, activity: bare.activity },
    { package: fromLine.package, activity: fromLine.activity },
  );

  assert.equal(parseFocusStableFields("garbage with no window token").package, null);
  assert.equal(focusStableFieldsHash(FOCUS_A, FOCUS_B), focusStableFieldsHash(FOCUS_B, FOCUS_A));
  assert.equal(focusStableFieldsHash(FOCUS_A, { ...FOCUS_B, rotation: 90 }), null);
});

test("pngHeaderOf validates real PNGs and rejects truncated/bad signatures", () => {
  const ok = pngHeaderOf(PNG_240);
  assert.deepEqual({ ok: ok.ok, width: ok.width, height: ok.height }, { ok: true, width: 240, height: 320 });

  assert.equal(pngHeaderOf(PNG_240.subarray(0, 20)).ok, false);            // truncated IDAT absent
  assert.equal(pngHeaderOf(Buffer.from("not a png at all")).ok, false);    // bad signature
  assert.equal(pngHeaderOf(Buffer.from("")).ok, false);                    // empty
  assert.equal(pngHeaderOf("text").ok, false);                             // non-buffer
});

test("valid live-strict bundle freezes; fields bind to the display observation only", () => {
  const result = assembleLiveStrictFrame(liveInput());
  assert.equal(result.ok, true, result.errors?.map((e) => e.message).join("; "));
  const frame = result.frame;
  assert.equal(frame.schemaId, "xw.screen-frame.v1");
  assert.equal(frame.mode, "live_strict"); // explicit mode, no default
  assert.match(frame.frameId, /^[0-9a-f]{64}$/);
  assert.match(frame.manifestSha256, /^[0-9a-f]{64}$/);
  assert.equal(frame.width, 240);
  assert.equal(frame.height, 320);
  assert.equal(frame.orientation, "portrait");
  assert.equal(frame.density, 3);
  assert.equal(frame.capturedAt, CAPTURED_AT); // focus-B completion time, verbatim
  assert.equal(frame.expiresAt, "2026-08-21T12:00:05.000Z"); // capturedAt + 5s TTL, truncated to ms
  assert.equal(frame.stability.verdict, "stable");
  assert.deepEqual(frame.flags, { partial: false, missing: false });
  assert.equal(frame.linkage.sessionId, "sess-m6-0001");
  assert.equal(frame.linkage.appId, "com.tencent.mm");
});

test("live-strict determinism: identical durable bundles yield identical frameId", () => {
  const a = assembleLiveStrictFrame(liveInput());
  const b = assembleLiveStrictFrame(liveInput());
  assert.equal(a.ok && b.ok, true);
  assert.equal(a.frame.frameId, b.frame.frameId);

  // A different capturedAt changes the manifest, hence the frameId.
  const later = assembleLiveStrictFrame(liveInput({ capturedAt: "2026-08-21T12:00:01.000Z" }));
  assert.notEqual(a.frame.frameId, later.frame.frameId);
});

test("live-strict never degrades to replay: A≠B raw bytes fails even though replay accepts it", () => {
  const live = assembleLiveStrictFrame(liveInput({ screenshotBBytes: PNG_240_ALT }));
  assert.equal(live.ok, false);
  assert.ok(live.errors.some((e) => e.code === "M6_FRAME_A_B_MISMATCH"));

  // Replay path has no pixel gate: A≠B is recorded as an unstable frame.
  const replay = assembleReplayFrame({
    evidence: liveInput().evidence,
    screenshotASha256: "a".repeat(64),
    screenshotBSha256: "b".repeat(64),
    width: 240,
    height: 320,
    orientation: "portrait",
    density: 3,
    capturedAt: CAPTURED_AT,
    linkage: liveInput().linkage,
    pageFingerprint: "0".repeat(64),
    focusFingerprint: "1".repeat(64),
    stable: false,
  });
  assert.equal(replay.ok, true);
  assert.equal(replay.frame.mode, "replay"); // never degrades: mode is explicit per path
  assert.equal(replay.frame.stability.verdict, "unstable");
});

test("live-strict rejects non-PNG screenshots and PNG/observation dimension mismatches", () => {
  const notPng = assembleLiveStrictFrame(
    liveInput({ screenshotABytes: Buffer.from("PNG but fake, no signature"), screenshotBBytes: Buffer.from("junk") }),
  );
  assert.equal(notPng.ok, false);
  assert.ok(notPng.errors.some((e) => e.code === "M6_FRAME_A_NOT_PNG"));

  // PNG IHDR dims must equal the display observation.
  const wrongDims = assembleLiveStrictFrame(liveInput({ screenshotABytes: PNG_120, screenshotBBytes: PNG_120 }));
  assert.equal(wrongDims.ok, false);
  assert.ok(wrongDims.errors.some((e) => e.code === "M6_FRAME_A_DIMS_MISMATCH"));

  // Observation dims disagree with the PNGs.
  const obsMismatch = assembleLiveStrictFrame(liveInput({ displayObservation: { ...OBS, width: 480 } }));
  assert.equal(obsMismatch.ok, false);

  // Matched PNGs and observation pass.
  assert.equal(assembleLiveStrictFrame(liveInput({ screenshotABytes: PNG_240, screenshotBBytes: PNG_240 })).ok, true);

  const noDims = assembleLiveStrictFrame(liveInput({ displayObservation: { orientation: "portrait", density: 3 } }));
  assert.equal(noDims.ok, false);
  assert.ok(noDims.errors.some((e) => e.code === "M6_FRAME_OBSERVATION_DIMS_INVALID"));

  const badOrientation = assembleLiveStrictFrame(liveInput({ displayObservation: { ...OBS, orientation: "diagonal" } }));
  assert.equal(badOrientation.ok, false);
  assert.ok(badOrientation.errors.some((e) => e.code === "M6_FRAME_OBSERVATION_ORIENTATION_INVALID"));
});

test("live-strict enforces skew gates A→B ≤4s and B→focusB ≤1s", () => {
  const tooSlow = assembleLiveStrictFrame(liveInput({ skew: { aToBMs: 4001, bToFocusBMs: 120 } }));
  assert.equal(tooSlow.ok, false);
  assert.ok(tooSlow.errors.some((e) => e.code === "M6_FRAME_A_TO_B_SKEW"));

  const focusSlow = assembleLiveStrictFrame(liveInput({ skew: { aToBMs: 350, bToFocusBMs: 1001 } }));
  assert.equal(focusSlow.ok, false);
  assert.ok(focusSlow.errors.some((e) => e.code === "M6_FRAME_B_TO_FOCUS_B_SKEW"));

  const negative = assembleLiveStrictFrame(liveInput({ skew: { aToBMs: -1, bToFocusBMs: 120 } }));
  assert.equal(negative.ok, false);

  const boundary = assembleLiveStrictFrame(liveInput({ skew: { aToBMs: 4000, bToFocusBMs: 1000 } }));
  assert.equal(boundary.ok, true);
});

test("live-strict requires focus A/B agreement on the stable window/screen/rotation fields", () => {
  const diffApp = assembleLiveStrictFrame(
    liveInput({ focusB: { raw: "mCurrentFocus=Window u0 com.tencent.mm/com.tencent.mm.plugin.webview.ui.tools.WebViewUI", screenOn: true, keyboardVisible: false, rotation: 0 } }),
  );
  assert.equal(diffApp.ok, false);
  assert.ok(diffApp.errors.some((e) => e.code === "M6_FRAME_FOCUS_PAIR_UNSTABLE"));

  const noFocus = assembleLiveStrictFrame(liveInput({ focusB: { raw: "", screenOn: true, keyboardVisible: false, rotation: 0 } }));
  assert.equal(noFocus.ok, false);

  const rotationChange = assembleLiveStrictFrame(liveInput({ focusB: { raw: FOCUS_LINE, screenOn: true, keyboardVisible: false, rotation: 90 } }));
  assert.equal(rotationChange.ok, false);
});

test("live-strict enforces TTL-on-return ≥2s with an injected clock (no ambient clock)", () => {
  // Returned only while ≥2s of the 5s TTL remains.
  const atBoundary = assembleLiveStrictFrame(liveInput({ nowMs: Date.parse("2026-08-21T12:00:03.000Z") }));
  assert.equal(atBoundary.ok, true); // exactly 2000ms remain

  const tooLate = assembleLiveStrictFrame(liveInput({ nowMs: Date.parse("2026-08-21T12:00:03.001Z") }));
  assert.equal(tooLate.ok, false);
  assert.ok(tooLate.errors.some((e) => e.code === "M6_FRAME_TTL_EXPIRING"));

  const noClock = assembleLiveStrictFrame(liveInput({ nowMs: undefined }));
  assert.equal(noClock.ok, false);
  assert.ok(noClock.errors.some((e) => e.code === "M6_FRAME_CLOCK_INVALID"));
});

test("live-strict fails closed on invalid capturedAt, oversized dump, and incomplete evidence refs", () => {
  const badTime = assembleLiveStrictFrame(liveInput({ capturedAt: "not-a-time" }));
  assert.equal(badTime.ok, false);

  const bigDump = assembleLiveStrictFrame(
    liveInput({ dumpBytes: Buffer.alloc(M6_FRAME_CONSTANTS.maxDumpBytes + 1) }),
  );
  assert.equal(bigDump.ok, false);
  assert.ok(bigDump.errors.some((e) => e.code === "M6_FRAME_DUMP_TOO_LARGE"));

  const missingRef = assembleLiveStrictFrame(liveInput({ evidence: { ...liveInput().evidence, dump: { id: "", sha256: "" } } }));
  assert.equal(missingRef.ok, false);
  assert.ok(missingRef.errors.some((e) => e.code === "M6_FRAME_EVIDENCE_INCOMPLETE"));
});

test("mode is required: omitting it fails closed structurally", () => {
  const noMode = buildCanonicalFrame({ mode: undefined });
  assert.equal(noMode.ok, false);
  assert.ok(noMode.errors.some((e) => e.code === "M6_FRAME_MODE_REQUIRED"));

  const unknown = buildCanonicalFrame({ mode: "permissive" });
  assert.equal(unknown.ok, false);

  // The replay entry is a thin wrapper over the same core with mode "replay".
  const replayWithLiveBytes = assembleReplayFrame({
    evidence: liveInput().evidence,
    screenshotASha256: "a".repeat(64),
    screenshotBSha256: "a".repeat(64),
    width: 240,
    height: 320,
    orientation: "portrait",
    density: 3,
    capturedAt: CAPTURED_AT,
    linkage: liveInput().linkage,
    pageFingerprint: "0".repeat(64),
    focusFingerprint: "1".repeat(64),
    stable: true,
  });
  assert.equal(replayWithLiveBytes.ok, true);
  assert.equal(replayWithLiveBytes.frame.stability.verdict, "stable");
});
