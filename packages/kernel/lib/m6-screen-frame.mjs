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
//   * A→B skew ≤15s and B→focus B skew ≤8s; capturedAt is the focus-B completion
//     time; the frame is returned only while ≥2s of the 5s TTL remains.
//
// Pure functions only: no device IO, no network, no ambient clock (`nowMs` is
// injected), no Math.random. Identical durable input bundles produce identical
// frameIds on Windows, Linux and disk replay.
import { createHash } from "node:crypto";

import { stableStringify } from "./skill-runtime.mjs";

export const M6_FRAME_CONSTANTS = Object.freeze({
  frameTtlMs: 5000,
  // Real-device capture budgets (observed 2026-08-22 on physical Xiaowei):
  // screencap ~1.6s ×2 + uiautomator dump ~2.3s ⇒ A→B ≈ 5-6s. The byte-identity
  // A/B screenshot gate (M6_FRAME_A_B_MISMATCH) is the true stability check, so
  // these skew gates are generous guardrails, not the stability authority.
  maxAToBSkewMs: 15000,
  maxBToFocusBSkewMs: 8000,
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

// The frame's page fingerprint: a canonical hash of the focused package/activity
// + display dimensions. Pure + shared so the verifier can re-derive it from the
// resolved observation blob and detect a swapped observation that left the
// stored fingerprint intact. (control-plane's canonicalJson ≡ stableStringify.)
export function derivePageFingerprint(observation) {
  return sha256Hex(`xw.page.v1:${stableStringify({
    package: observation?.package ?? null,
    activity: observation?.activity ?? null,
    width: observation?.width ?? null,
    height: observation?.height ?? null,
    orientation: observation?.orientation ?? null,
    density: observation?.density ?? null,
  })}`);
}

// The frame manifest hash: covers every ref + the screenshot content hashes +
// dims + capturedAt + linkage + the two fingerprints. Pure + shared so the
// verifier re-derives it from a frame's recorded fields and detects tampering.
export function deriveFrameManifestSha256(fields) {
  return sha256Hex(`xw.screen-frame.v1:manifest:${stableStringify({
    mode: fields.mode,
    observationRef: fields.observationRef,
    screenshotARef: fields.screenshotARef,
    screenshotBRef: fields.screenshotBRef,
    dumpRef: fields.dumpRef,
    focusRef: fields.focusRef,
    screenshotASha256: fields.screenshotASha256,
    screenshotBSha256: fields.screenshotBSha256,
    width: fields.width,
    height: fields.height,
    orientation: fields.orientation,
    density: fields.density,
    capturedAt: fields.capturedAt,
    expiresAt: fields.expiresAt,
    linkage: fields.linkage,
    stability: fields.stability,
    flags: fields.flags,
  })}`);
}

export function deriveFrameId(manifestSha256) {
  return sha256Hex(`xw.screen-frame.v1:${manifestSha256}`);
}

// M6-2 W8 #8 — verify a frozen frame's manifest is complete + untampered.
// Given a frame + a resolver `(ref) => bytes` (the evidence CAS lookup), this
// re-resolves every ref, re-derives the screenshot content hashes, re-derives
// the manifest + frame id, re-confirms the A/B focus-pair agreement, and
// re-derives the page fingerprint — all from the resolved bytes. Any missing
// ref, content-hash mismatch, slot swap, or manifest/fingerprint drift fails.
// Pure; the facade calls it on the accepted frame before commit (defense in
// depth) and the same verifier is reusable by an offline auditor.
export function verifyFrameManifest(frame, resolve) {
  const errors = [];
  if (!frame || typeof frame !== "object") {
    return { ok: false, errors: [{ code: "M6_FRAME_MANIFEST_INCOMPLETE", message: "a frozen frame is required" }] };
  }
  const REF_KEYS = ["observationRef", "screenshotARef", "screenshotBRef", "dumpRef", "focusRef"];
  const bytes = {};
  for (const key of REF_KEYS) {
    const ref = frame[key];
    if (!ref || !ref.id || !ref.sha256) {
      fail(errors, "M6_FRAME_MANIFEST_INCOMPLETE", `frame.${key} is missing a content-addressed ref`);
      continue;
    }
    if (typeof resolve !== "function") {
      fail(errors, "M6_FRAME_MANIFEST_INCOMPLETE", "a resolver (ref) => bytes is required");
      continue;
    }
    const content = resolve(ref);
    if (!content) {
      fail(errors, "M6_FRAME_MANIFEST_INCOMPLETE", `evidence ref ${key} (${ref.id}) could not be resolved`);
      continue;
    }
    const hash = sha256Hex(content);
    if (hash !== ref.sha256) {
      fail(errors, "M6_FRAME_MANIFEST_FORGED", `${key} content sha256 does not match its ref.sha256`);
    }
    bytes[key] = content;
  }

  // Slot mapping + screenshot content hashes (A slot -> screenshotASha256).
  if (bytes.screenshotARef && bytes.screenshotBRef) {
    const aHash = sha256Hex(bytes.screenshotARef);
    const bHash = sha256Hex(bytes.screenshotBRef);
    if (aHash !== frame.screenshotASha256) {
      if (aHash === frame.screenshotBSha256) fail(errors, "M6_FRAME_SLOT_SWAPPED", "screenshot A slot content hashes to the B sha256 (slots swapped)");
      else fail(errors, "M6_FRAME_MANIFEST_FORGED", "screenshotASha256 does not re-derive from slot A content");
    }
    if (bHash !== frame.screenshotBSha256) {
      if (bHash === frame.screenshotASha256) fail(errors, "M6_FRAME_SLOT_SWAPPED", "screenshot B slot content hashes to the A sha256 (slots swapped)");
      else fail(errors, "M6_FRAME_MANIFEST_FORGED", "screenshotBSha256 does not re-derive from slot B content");
    }
  }

  // Manifest + frame id re-derivation from the recorded fields.
  const manifestSha256 = deriveFrameManifestSha256({
    mode: frame.mode,
    observationRef: frame.observationRef,
    screenshotARef: frame.screenshotARef,
    screenshotBRef: frame.screenshotBRef,
    dumpRef: frame.dumpRef,
    focusRef: frame.focusRef,
    screenshotASha256: frame.screenshotASha256,
    screenshotBSha256: frame.screenshotBSha256,
    width: frame.width,
    height: frame.height,
    orientation: frame.orientation,
    density: frame.density,
    capturedAt: frame.capturedAt,
    expiresAt: frame.expiresAt,
    linkage: frame.linkage,
    stability: frame.stability,
    flags: frame.flags,
  });
  if (manifestSha256 !== frame.manifestSha256) {
    fail(errors, "M6_FRAME_MANIFEST_FORGED", "manifestSha256 does not re-derive from the frame's recorded fields");
  }
  if (deriveFrameId(manifestSha256) !== frame.frameId) {
    fail(errors, "M6_FRAME_MANIFEST_FORGED", "frameId does not re-derive from manifestSha256");
  }

  // Re-confirm the focus A/B agreement + page fingerprint from resolved bytes.
  // The focus blob stores raw focus A + "\n---FOCUS-B---\n" + raw focus B; the
  // display-state fields (rotation/screenOn/keyboardVisible) live in the
  // observation blob, and A/B stability guarantees they are equal across A and
  // B, so the focus-pair fingerprint re-derives faithfully from the two blobs.
  if (bytes.focusRef && bytes.observationRef) {
    const text = bytes.focusRef.toString("utf8");
    const sep = "\n---FOCUS-B---\n";
    const idx = text.indexOf(sep);
    if (idx < 0) {
      fail(errors, "M6_FRAME_MANIFEST_INCOMPLETE", "focus blob is missing the A/B separator");
    } else {
      let observation;
      try { observation = JSON.parse(bytes.observationRef.toString("utf8")); } catch { observation = null; }
      const display = {
        screenOn: observation?.screenOn ?? null,
        keyboardVisible: observation?.keyboardVisible ?? null,
        rotation: observation?.rotation ?? null,
      };
      const focusA = { raw: text.slice(0, idx), ...display };
      const focusB = { raw: text.slice(idx + sep.length), ...display };
      const focusHash = focusStableFieldsHash(focusA, focusB);
      if (!focusHash) {
        fail(errors, "M6_FRAME_FOCUS_PAIR_UNSTABLE", "focus A/B do not agree on stable package/activity fields");
      } else if (frame.stability?.focusFingerprint && focusHash !== frame.stability.focusFingerprint) {
        fail(errors, "M6_FRAME_MANIFEST_FORGED", "focusFingerprint does not re-derive from the resolved focus blob");
      }
      if (observation) {
        const pageHash = derivePageFingerprint(observation);
        if (frame.stability?.pageFingerprint && pageHash !== frame.stability.pageFingerprint) {
          fail(errors, "M6_FRAME_MANIFEST_FORGED", "pageFingerprint does not re-derive from the resolved observation");
        }
      }
    }
  }

  return { ok: errors.length === 0, errors };
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
  const capturedMs = Date.parse(capturedAt);
  if (!Number.isFinite(capturedMs)) {
    fail(errors, "M6_FRAME_CAPTURED_AT_INVALID", "capturedAt must be a valid date-time string");
    return { ok: false, frame: null, errors };
  }
  const expiresAt = new Date(capturedMs + frameTtlMs).toISOString().replace(/\.\d{3}/, ".000");
  const normalizedLinkage = {
    sessionId: linkage?.sessionId || "sess-unknown",
    leaseRef: linkage?.leaseRef || "lease-unknown",
    alias: linkage?.alias || "00",
    appId: linkage?.appId || "app-unknown",
  };
  const stability = {
    verdict: stabilityVerdict === "stable" ? "stable" : "unstable",
    pageFingerprint,
    focusFingerprint,
  };
  const flags = { partial: Boolean(flagsPartial), missing: Boolean(flagsMissing) };
  const manifestSha256 = deriveFrameManifestSha256({
    mode,
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
    linkage: normalizedLinkage,
    stability,
    flags,
  });
  const frameId = deriveFrameId(manifestSha256);
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
      linkage: normalizedLinkage,
      stability,
      flags,
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
