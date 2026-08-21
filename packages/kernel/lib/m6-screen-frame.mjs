// M6-2 shared strict frame assembler. The M6-1 replay GroundingRuntime and the
// M6-2 Control Plane live capture path BOTH delegate the pure frame validation,
// canonical manifest and frameId assembly to this module — there is exactly one
// manifest/frameId derivation for the agentic grounding pipeline.
//
// Mode discipline (task brief §3.2, Plan V2 ADV-F3): `mode` is REQUIRED with no
// default. `assembleReplayFrame` and `assembleLiveStrictFrame` are the two named
// entry points; `buildCanonicalFrame` is the shared core and also takes a
// required mode, so a caller that omits mode fails closed structurally instead
// of silently degrading the live path to the permissive replay semantics.
//
// Live-strict adds the fail-closed hardware gates on top of the replay contract:
//   * A/B are complete PNGs (signature + IHDR) within size caps, and their FULL
//     raw bytes SHA-256 exactly — no crop, no mask, no perceptual threshold.
//   * PNG IHDR dimensions must equal the display observation; orientation and
//     density come only from the display observation.
//   * Focus A/B must agree on the stable window/app/screen/rotation fields.
//   * A→B skew ≤4s and B→focus B skew ≤1s; capturedAt is the focus-B completion
//     time; the frame is returned only while ≥2s of the 5s TTL remains.
//
// Pure functions only: no device IO, no network, no ambient clock (`nowMs` is
// injected), no Math.random. Identical durable input bundles produce identical
// frameIds on Windows, Linux and disk replay.
import { createHash } from "node:crypto";

import { stableStringify } from "./skill-runtime.mjs";

export const M6_FRAME_CONSTANTS = Object.freeze({
  frameTtlMs: 5000,
  maxAToBSkewMs: 4000,
  maxBToFocusBSkewMs: 1000,
  minTtlOnReturnMs: 2000,
  maxScreenshotBytes: 16 * 1024 * 1024,
  maxDumpBytes: 4 * 1024 * 1024,
  maxFocusBytes: 64 * 1024,
});

export const M6_FRAME_MODES = Object.freeze(["replay", "live_strict"]);

export const PNG_SIGNATURE = Object.freeze([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function fail(errors, code, message) {
  errors.push({ code, message });
}

export function sha256Hex(input) {
  const buffer = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return createHash("sha256").update(buffer).digest("hex");
}

// Validates a complete PNG: 8-byte signature plus a parseable IHDR chunk with
// width/height. Returns { ok, width, height } or { ok:false, error }.
export function pngHeaderOf(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 8 + 4 + 4 + 13) {
    return { ok: false, error: "too short for a PNG header" };
  }
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return { ok: false, error: "invalid PNG signature" };
  }
  // After the signature: IHDR chunk length (4 bytes, must be 13) + type (4 bytes).
  const length = bytes.readUInt32BE(8);
  const type = bytes.toString("latin1", 12, 16);
  if (length !== 13 || type !== "IHDR") return { ok: false, error: "missing or malformed IHDR chunk" };
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < 1 || height < 1) return { ok: false, error: "invalid IHDR dimensions" };
  return { ok: true, width, height };
}

export function parseFocusStableFields(focus) {
  // The only fields live capture is allowed to bind: the package/activity of the
  // focused window and the screen/rotation state. Keys are canonical and ordered.
  //
  // Real Xiaowei focus observations are dumpsys lines like
  //   mCurrentFocus=Window{3c8e05b u0 com.tencent.mm/com.tencent.mm.ui.LauncherUI}
  // A replay fixture may already be a bare "pkg/activity" token. Both shapes are
  // normalized to the same {package, activity} pair.
  const s = String(focus?.raw ?? focus ?? "");
  let token = s;
  const line = /mCurrentFocus=Window\{([^}]*)\}/.exec(s);
  if (line) {
    const parts = line[1].trim().split(/\s+/);
    token = parts[parts.length - 1] || "";
  }
  const m = /^([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)\/(\S+)/.exec(token);
  return {
    package: m ? m[1] : null,
    activity: m ? m[2].replace(/[\}\s].*$/, "") : null,
    screenOn: focus?.screenOn ?? null,
    keyboardVisible: focus?.keyboardVisible ?? null,
    rotation: focus?.rotation ?? null,
  };
}

// Canonical hash of the stable focus fields shared by focus A and focus B.
// Null when either side is missing a required stable field — the strict path
// then fails closed.
export function focusStableFieldsHash(focusA, focusB) {
  const a = parseFocusStableFields(focusA);
  const b = parseFocusStableFields(focusB);
  if (!a || !b || !a.package || !b.package) return null;
  for (const key of Object.keys(a)) {
    if (a[key] !== b[key]) return null;
  }
  return sha256Hex(`xw.focus-pair.stable:${stableStringify(a)}`);
}

// Core canonical assembler. `mode` is required; a missing or unknown mode is a
// hard error (never a silent fallback). Returns { ok:false, errors } or
// { ok:true, frame }.
export function buildCanonicalFrame({
  mode,
  evidence,          // { screenshotA, screenshotB, dump, focus, observation } opaque {id,sha256}
  screenshotASha256,
  screenshotBSha256,
  width,
  height,
  orientation,
  density,
  capturedAt,        // ISO string
  linkage,           // { sessionId, leaseRef, alias, appId }
  pageFingerprint,
  focusFingerprint,
  stabilityVerdict,  // "stable" | "unstable"
  flagsPartial,
  flagsMissing,
  frameTtlMs = M6_FRAME_CONSTANTS.frameTtlMs,
} = {}) {
  const errors = [];
  if (!M6_FRAME_MODES.includes(mode)) {
    fail(errors, "M6_FRAME_MODE_REQUIRED", "mode must be one of replay|live_strict and must be explicit");
    return { ok: false, frame: null, errors };
  }
  for (const key of ["screenshotA", "screenshotB", "dump", "focus", "observation"]) {
    if (!evidence?.[key]?.id || !evidence[key]?.sha256) {
      fail(errors, "M6_FRAME_EVIDENCE_INCOMPLETE", `evidence.${key} is required`);
    }
  }
  if (errors.length > 0) return { ok: false, frame: null, errors };
  const { screenshotA, screenshotB, dump, focus, observation } = evidence;
  const manifestSha256 = sha256Hex(`xw.screen-frame.v1:manifest:${stableStringify({
    observationRef: observation,
    screenshotARef: screenshotA,
    screenshotBRef: screenshotB,
    dumpRef: dump,
    focusRef: focus,
    screenshotASha256,
    screenshotBSha256,
    width,
    height,
    orientation,
    density,
    capturedAt,
    linkage,
    pageFingerprint,
    focusFingerprint,
  })}`);
  const frameId = sha256Hex(`xw.screen-frame.v1:${manifestSha256}`);
  const capturedMs = Date.parse(capturedAt);
  if (!Number.isFinite(capturedMs)) {
    fail(errors, "M6_FRAME_CAPTURED_AT_INVALID", "capturedAt must be a valid date-time string");
    return { ok: false, frame: null, errors };
  }
  const expiresAt = new Date(capturedMs + frameTtlMs).toISOString().replace(/\.\d{3}/, ".000");
  return {
    ok: true,
    frame: {
      schemaId: "xw.screen-frame.v1",
      mode,
      frameId,
      manifestSha256,
      observationRef: observation,
      screenshotARef: screenshotA,
      screenshotBRef: screenshotB,
      dumpRef: dump,
      focusRef: focus,
      screenshotASha256,
      screenshotBSha256,
      width,
      height,
      orientation,
      density,
      capturedAt,
      expiresAt,
      linkage: {
        sessionId: linkage.sessionId || "sess-unknown",
        leaseRef: linkage.leaseRef || "lease-unknown",
        alias: linkage.alias || "00",
        appId: linkage.appId || "app-unknown",
      },
      stability: {
        verdict: stabilityVerdict === "stable" ? "stable" : "unstable",
        pageFingerprint,
        focusFingerprint,
      },
      flags: { partial: Boolean(flagsPartial), missing: Boolean(flagsMissing) },
    },
    errors,
  };
}

export function assembleReplayFrame({
  evidence,
  screenshotASha256,
  screenshotBSha256,
  width,
  height,
  orientation,
  density,
  capturedAt,
  linkage,
  pageFingerprint,
  focusFingerprint,
  stable,
  flags,
  frameTtlMs,
}) {
  const result = buildCanonicalFrame({
    mode: "replay",
    evidence,
    screenshotASha256,
    screenshotBSha256,
    width,
    height,
    orientation,
    density,
    capturedAt,
    linkage,
    pageFingerprint,
    focusFingerprint,
    stabilityVerdict: stable ? "stable" : "unstable",
    flagsPartial: flags?.partial === true,
    flagsMissing: flags?.missing === true,
    frameTtlMs,
  });
  return result;
}

// Live-strict entry: the fail-closed hardware gates for M6-2. Everything here is
// pure — `nowMs` is injected (never the ambient clock) so a durable bundle
// replays to an identical verdict on Windows, Linux and disk. On any gate
// failure the result is { ok:false, frame:null, errors } — there is no degraded
// path and no partial frame.
export function assembleLiveStrictFrame({
  screenshotABytes,
  screenshotBBytes,
  dumpBytes,
  focusA,            // raw focus observation (string) or { raw, screenOn, keyboardVisible, rotation }
  focusB,
  displayObservation, // { width, height, orientation, density }
  skew,              // { aToBMs, bToFocusBMs }
  nowMs,             // injected clock: TTL-on-return gate uses this
  capturedAt,        // ISO string; MUST be the focus-B completion time (caller-provided)
  evidence,          // { screenshotA, screenshotB, dump, focus, observation } opaque {id,sha256}
  linkage,           // { sessionId, leaseRef, alias, appId }
  pageFingerprint,
  focusFingerprint,
  frameTtlMs = M6_FRAME_CONSTANTS.frameTtlMs,
} = {}) {
  const errors = [];
  const { maxAToBSkewMs, maxBToFocusBSkewMs, minTtlOnReturnMs, maxScreenshotBytes, maxDumpBytes, maxFocusBytes } =
    M6_FRAME_CONSTANTS;

  // --- PNG A/B: complete files, full raw bytes SHA-256, size caps ------------
  const a = pngHeaderOf(screenshotABytes);
  if (!a.ok) fail(errors, "M6_FRAME_A_NOT_PNG", a.error);
  const b = pngHeaderOf(screenshotBBytes);
  if (!b.ok) fail(errors, "M6_FRAME_B_NOT_PNG", b.error);
  if (screenshotABytes.length > maxScreenshotBytes) {
    fail(errors, "M6_FRAME_A_TOO_LARGE", `screenshot A exceeds ${maxScreenshotBytes} bytes`);
  }
  if (screenshotBBytes.length > maxScreenshotBytes) {
    fail(errors, "M6_FRAME_B_TOO_LARGE", `screenshot B exceeds ${maxScreenshotBytes} bytes`);
  }
  if (dumpBytes && dumpBytes.length > maxDumpBytes) {
    fail(errors, "M6_FRAME_DUMP_TOO_LARGE", `dump exceeds ${maxDumpBytes} bytes`);
  }
  const screenshotASha256 = sha256Hex(screenshotABytes);
  const screenshotBSha256 = sha256Hex(screenshotBBytes);
  if (screenshotASha256 !== screenshotBSha256) {
    fail(errors, "M6_FRAME_A_B_MISMATCH", "screenshot A and B raw bytes differ; no perceptual tolerance");
  }

  // PNG IHDR dimensions must equal the display observation; the observation is
  // the only source of truth for orientation/density.
  const width = displayObservation?.width;
  const height = displayObservation?.height;
  const orientation = displayObservation?.orientation;
  const density = displayObservation?.density;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    fail(errors, "M6_FRAME_OBSERVATION_DIMS_INVALID", "displayObservation width/height are required integers");
  }
  if (orientation !== "portrait" && orientation !== "landscape") {
    fail(errors, "M6_FRAME_OBSERVATION_ORIENTATION_INVALID", "displayObservation.orientation must be portrait|landscape");
  }
  if (!Number.isFinite(density) || density <= 0) {
    fail(errors, "M6_FRAME_OBSERVATION_DENSITY_INVALID", "displayObservation.density must be a positive number");
  }
  if (a.ok && a.width !== width) fail(errors, "M6_FRAME_A_DIMS_MISMATCH", "screenshot A IHDR width != display observation");
  if (a.ok && a.height !== height) fail(errors, "M6_FRAME_B_DIMS_MISMATCH", "screenshot B IHDR width != display observation");
  if (b.ok && b.width !== width) fail(errors, "M6_FRAME_B_DIMS_MISMATCH", "screenshot B IHDR width != display observation");
  if (b.ok && b.height !== height) fail(errors, "M6_FRAME_B_DIMS_MISMATCH", "screenshot B IHDR height != display observation");

  // Focus pair must agree on the stable window/app/screen/rotation fields.
  const focusStableHash = focusStableFieldsHash(focusA, focusB);
  if (!focusStableHash) {
    fail(errors, "M6_FRAME_FOCUS_PAIR_UNSTABLE", "focus A/B disagree or miss stable window/screen/rotation fields");
  }

  // Skew gates.
  const aToBMs = skew?.aToBMs;
  const bToFocusBMs = skew?.bToFocusBMs;
  if (!Number.isInteger(aToBMs) || aToBMs < 0) {
    fail(errors, "M6_FRAME_SKEW_INVALID", "skew.aToBMs must be a non-negative integer");
  }
  if (!Number.isInteger(bToFocusBMs) || bToFocusBMs < 0) {
    fail(errors, "M6_FRAME_SKEW_INVALID", "skew.bToFocusBMs must be a non-negative integer");
  }
  if (aToBMs > maxAToBSkewMs) fail(errors, "M6_FRAME_A_TO_B_SKEW", `A→B skew ${aToBMs}ms exceeds ${maxAToBSkewMs}ms`);
  if (bToFocusBMs > maxBToFocusBSkewMs) {
    fail(errors, "M6_FRAME_B_TO_FOCUS_B_SKEW", `B→focus B skew ${bToFocusBMs}ms exceeds ${maxBToFocusBSkewMs}ms`);
  }

  // TTL-on-return: the frame must still be valid for ≥2s at `nowMs`.
  const capturedMs = Date.parse(capturedAt);
  if (!Number.isFinite(capturedMs)) {
    fail(errors, "M6_FRAME_CAPTURED_AT_INVALID", "capturedAt must be a valid date-time string");
  } else if (!Number.isFinite(nowMs)) {
    fail(errors, "M6_FRAME_CLOCK_INVALID", "nowMs must be injected (no ambient clock)");
  } else if (capturedMs + frameTtlMs - nowMs < minTtlOnReturnMs) {
    fail(errors, "M6_FRAME_TTL_EXPIRING", `fewer than ${minTtlOnReturnMs}ms of TTL remain at return`);
  }

  if (errors.length > 0) return { ok: false, frame: null, errors };

  return buildCanonicalFrame({
    mode: "live_strict",
    evidence,
    screenshotASha256,
    screenshotBSha256,
    width,
    height,
    orientation,
    density,
    capturedAt,
    linkage,
    pageFingerprint,
    focusFingerprint,
    stabilityVerdict: "stable",
    flagsPartial: false,
    flagsMissing: false,
    frameTtlMs,
  });
}
