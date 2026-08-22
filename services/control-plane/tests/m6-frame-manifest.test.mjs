// M6-2 W8 #8 — ScreenFrame manifest completeness + A/B independent observation.
//
// `verifyFrameManifest` is the defense-in-depth verifier the facade runs on the
// accepted frame before commit (and an offline auditor can reuse). Given a
// frozen frame + a resolver `(ref) => bytes`, it re-resolves every evidence ref,
// re-derives the screenshot content hashes, re-derives the manifest + frame id,
// re-confirms the focus A/B agreement, and re-derives the page fingerprint —
// all from the resolved bytes. Pure; no device I/O.
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCanonicalFrame,
  derivePageFingerprint,
  focusStableFieldsHash,
  sha256Hex,
  verifyFrameManifest,
} from "../../../packages/kernel/lib/m6-screen-frame.mjs";
import { stableStringify } from "../../../packages/kernel/lib/skill-runtime.mjs";

const FOCUS_LINE = "mCurrentFocus=Window{3c8e05b u0 com.tencent.mm/com.tencent.mm.ui.LauncherUI}";
const DISPLAY = { screenOn: "Awake", keyboardVisible: false, rotation: 0 };

function makeFrame({
  screenshotABytes = Buffer.from("png-a-bytes"),
  screenshotBBytes = Buffer.from("png-a-bytes"), // A/B bit-identical (strict gate)
  observationOverrides = {},
  focusAText = FOCUS_LINE,
  focusBText = FOCUS_LINE,
  dumpBytes = Buffer.from("<hierarchy></hierarchy>"),
  overrides = {},
} = {}) {
  const observation = {
    package: "com.tencent.mm",
    activity: "com.tencent.mm.ui.LauncherUI",
    width: 1080,
    height: 2400,
    orientation: "portrait",
    density: 440,
    ...DISPLAY,
    ...observationOverrides,
  };
  const observationBuffer = Buffer.from(stableStringify(observation), "utf8");
  const focusBlob = Buffer.concat([Buffer.from(focusAText, "utf8"), Buffer.from("\n---FOCUS-B---\n", "utf8"), Buffer.from(focusBText, "utf8")]);
  const screenshotASha256 = sha256Hex(screenshotABytes);
  const screenshotBSha256 = sha256Hex(screenshotBBytes);
  const refs = {
    screenshotA: { id: "ref-shot-a", sha256: screenshotASha256 },
    screenshotB: { id: "ref-shot-b", sha256: screenshotBSha256 },
    dump: { id: "ref-dump", sha256: sha256Hex(dumpBytes) },
    focus: { id: "ref-focus", sha256: sha256Hex(focusBlob) },
    observation: { id: "ref-obs", sha256: sha256Hex(observationBuffer) },
  };
  const focusFingerprint = focusStableFieldsHash({ raw: focusAText, ...DISPLAY }, { raw: focusBText, ...DISPLAY });
  const pageFingerprint = derivePageFingerprint(observation);
  const built = buildCanonicalFrame({
    mode: "live_strict",
    evidence: refs,
    screenshotASha256,
    screenshotBSha256,
    width: observation.width,
    height: observation.height,
    orientation: observation.orientation,
    density: observation.density,
    capturedAt: "2026-08-22T00:00:00.000Z",
    linkage: { sessionId: "sess-1", leaseRef: "lease-1", alias: "01", appId: "xiaowei" },
    pageFingerprint,
    focusFingerprint,
    stabilityVerdict: "stable",
    flagsPartial: false,
    flagsMissing: false,
  });
  if (!built.ok) throw new Error(`buildCanonicalFrame failed: ${built.errors.map((e) => e.message).join("; ")}`);
  const bytesById = new Map([
    [refs.screenshotA.id, screenshotABytes],
    [refs.screenshotB.id, screenshotBBytes],
    [refs.dump.id, dumpBytes],
    [refs.focus.id, focusBlob],
    [refs.observation.id, observationBuffer],
  ]);
  return { frame: { ...built.frame, ...overrides }, refs, resolve: (ref) => bytesById.get(ref.id) ?? null, bytesById };
}

test("a faithful frame verifies clean (ok + no errors)", () => {
  const { frame, resolve } = makeFrame();
  const result = verifyFrameManifest(frame, resolve);
  assert.equal(result.ok, true, result.errors.map((e) => e.message).join(";"));
  assert.deepEqual(result.errors, []);
});

test("a missing ref fails (M6_FRAME_MANIFEST_INCOMPLETE)", () => {
  const { frame, refs, bytesById } = makeFrame();
  // Resolver returns null for the dump ref.
  const resolve = (ref) => ref.id === refs.dump.id ? null : bytesById.get(ref.id) ?? null;
  const result = verifyFrameManifest(frame, resolve);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === "M6_FRAME_MANIFEST_INCOMPLETE" && e.message.includes("dumpRef")));
});

test("tampered ref content (sha256 mismatch) fails (M6_FRAME_MANIFEST_FORGED)", () => {
  const { frame, refs, bytesById } = makeFrame();
  const resolve = (ref) => ref.id === refs.screenshotA.id ? Buffer.from("tampered") : bytesById.get(ref.id) ?? null;
  const result = verifyFrameManifest(frame, resolve);
  assert.ok(result.errors.some((e) => e.code === "M6_FRAME_MANIFEST_FORGED" && e.message.includes("screenshotARef")));
});

test("A/B screenshot slot swap fails (M6_FRAME_SLOT_SWAPPED)", () => {
  // Distinct A/B content (both valid PNG-shaped bytes) so the slots are
  // distinguishable; the ref sha256 + frame hashes still point at the originals.
  const { frame, refs, bytesById } = makeFrame({
    screenshotABytes: Buffer.from("png-A-unique"),
    screenshotBBytes: Buffer.from("png-B-unique"),
  });
  // Swap the bytes behind A and B ids.
  const resolve = (ref) => {
    if (ref.id === refs.screenshotA.id) return bytesById.get(refs.screenshotB.id);
    if (ref.id === refs.screenshotB.id) return bytesById.get(refs.screenshotA.id);
    return bytesById.get(ref.id) ?? null;
  };
  const result = verifyFrameManifest(frame, resolve);
  assert.ok(result.errors.some((e) => e.code === "M6_FRAME_SLOT_SWAPPED"), result.errors.map((e) => e.code).join(","));
});

test("a forged manifestSha256 fails (M6_FRAME_MANIFEST_FORGED)", () => {
  const { frame, resolve } = makeFrame({ overrides: { manifestSha256: "00".repeat(32) } });
  const result = verifyFrameManifest(frame, resolve);
  assert.ok(result.errors.some((e) => e.code === "M6_FRAME_MANIFEST_FORGED" && e.message.includes("manifestSha256")));
});

test("a forged frameId fails (M6_FRAME_MANIFEST_FORGED)", () => {
  const { frame, resolve } = makeFrame({ overrides: { frameId: "ff".repeat(32) } });
  const result = verifyFrameManifest(frame, resolve);
  assert.ok(result.errors.some((e) => e.code === "M6_FRAME_MANIFEST_FORGED" && e.message.includes("frameId")));
});

for (const [label, mutate] of [
  ["mode", (frame) => ({ ...frame, mode: "replay" })],
  ["expiresAt", (frame) => ({ ...frame, expiresAt: "2099-01-01T00:00:00.000Z" })],
  ["stability.verdict", (frame) => ({ ...frame, stability: { ...frame.stability, verdict: "unstable" } })],
  ["flags", (frame) => ({ ...frame, flags: { partial: true, missing: true } })],
]) {
  test(`manifest binds safety field ${label}`, () => {
    const { frame, resolve } = makeFrame();
    const result = verifyFrameManifest(mutate(frame), resolve);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.code === "M6_FRAME_MANIFEST_FORGED"));
  });
}

test("focus A/B disagreement fails (M6_FRAME_FOCUS_PAIR_UNSTABLE)", () => {
  const { frame, resolve } = makeFrame({
    focusAText: "mCurrentFocus=Window{a u0 com.tencent.mm/com.tencent.mm.ui.LauncherUI}",
    focusBText: "mCurrentFocus=Window{b u0 com.other.app/other.MainActivity}",
  });
  const result = verifyFrameManifest(frame, resolve);
  assert.ok(result.errors.some((e) => e.code === "M6_FRAME_FOCUS_PAIR_UNSTABLE"), result.errors.map((e) => e.code).join(","));
});

test("a tampered focusFingerprint field fails (M6_FRAME_MANIFEST_FORGED)", () => {
  const { frame, resolve } = makeFrame();
  // The focus blobs agree, but the stored fingerprint was tampered.
  const tampered = { ...frame, stability: { ...frame.stability, focusFingerprint: "ab".repeat(32) } };
  const result = verifyFrameManifest(tampered, resolve);
  assert.ok(result.errors.some((e) => e.code === "M6_FRAME_MANIFEST_FORGED" && e.message.includes("focusFingerprint")));
});

test("a tampered pageFingerprint field fails (M6_FRAME_MANIFEST_FORGED)", () => {
  const { frame, resolve } = makeFrame();
  const tampered = { ...frame, stability: { ...frame.stability, pageFingerprint: "cd".repeat(32) } };
  const result = verifyFrameManifest(tampered, resolve);
  assert.ok(result.errors.some((e) => e.code === "M6_FRAME_MANIFEST_FORGED" && e.message.includes("pageFingerprint")));
});

test("a swapped observation (same dims, different app) fails the page fingerprint", () => {
  // Build a frame whose pageFingerprint/observation bind com.tencent.mm, then
  // resolve the observation ref to a different-app observation with the same
  // dims. The manifest sha256 (which covers the ref + stored fingerprint) still
  // re-derives, but the verifier re-derives the page fingerprint from the
  // resolved observation and catches the swap.
  const { frame, refs, bytesById } = makeFrame();
  const swapped = { ...frame };
  const swappedObservation = {
    package: "com.evil.app", activity: "com.evil.app.MainActivity",
    width: 1080, height: 2400, orientation: "portrait", density: 440, ...DISPLAY,
  };
  const resolve = (ref) => ref.id === refs.observation.id
    ? Buffer.from(stableStringify(swappedObservation), "utf8")
    : bytesById.get(ref.id) ?? null;
  const result = verifyFrameManifest(frame, resolve);
  assert.ok(result.errors.some((e) => e.code === "M6_FRAME_MANIFEST_FORGED" && e.message.includes("pageFingerprint")), result.errors.map((e) => e.code).join(","));
});
