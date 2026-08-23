import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { deriveLiveVisualBlockSet, deriveTargetEnvironmentAttestation } from "../../../packages/kernel/lib/m6-live-grounding.mjs";
import { deriveM64ActionSlotAuthority } from "../../../packages/kernel/lib/m6-4-cohort.mjs";
import { deriveM6TrustedParameterHash } from "../../../packages/kernel/lib/m6-action-slot.mjs";
import {
  assembleLiveStrictFrame,
  focusStableFieldsHash,
} from "../../../packages/kernel/lib/m6-screen-frame.mjs";
import { canonicalJson, sha256 } from "../control-plane/lib/canonical.mjs";
import { M6FrameEvidenceStore } from "../control-plane/lib/m6-frame-evidence-store.mjs";
import {
  M64_CONTROL_PLANE_FRESH_FRAME_SCHEMA_ID,
  M64_DISPATCH_COMPARABLE_STATE_FIELDS,
  M64_FRESH_CAPTURE_SOURCE_CLASS,
  M64_FRESH_CAPTURE_SOURCE_KIND,
  createM64ServerOwnedFreshCaptureReader,
  deriveM64DispatchCurrentState,
} from "../control-plane/lib/m6-live-fresh-state-capture.mjs";
import {
  M64_FRESH_STATE_CAPTURE_SCHEMA_ID,
  deriveM64FreshStateCaptureHash,
} from "../control-plane/lib/m6-live-production-dependencies.mjs";

const NOW = Date.parse("2030-01-01T00:00:00.000Z");
const H = (value) => sha256(value);
const PNG = readFileSync(new URL("./fixtures/m6-xiaowei/screen-a.png", import.meta.url));
const BASE_DUMP = "<hierarchy><node text=\"安全标签\" resource-id=\"com.xingin.xhs:id/tab\" class=\"android.view.View\" package=\"com.xingin.xhs\" clickable=\"true\" bounds=\"[10,100][900,500]\"/><node text=\"\" class=\"android.view.View\" package=\"com.xingin.xhs\" clickable=\"false\" bounds=\"[0,0][1080,2400]\"/></hierarchy>";

const SLOT_AUTHORITY = Object.freeze({
  schemaId: "xw.m6-action-slot-authority.v1",
  sequenceIndex: 0,
  logicalStepId: "m6-fresh-state:step-01",
  actionSlotOrdinal: 0,
  primitive: "tap",
  actionFamily: "tab-back:open-tab",
  intentRef: H("intent"),
  intentPolicyHash: H("intent-policy"),
  targetKind: "block",
  targetEligibilityHash: H("target-eligibility"),
  trustedParams: Object.freeze({}),
  trustedParameterHash: deriveM6TrustedParameterHash({}),
  allowedStateHash: H("allowed-state"),
  effectBoundaryHash: H("effect-boundary"),
  budgetPolicyHash: H("budget-policy"),
  redlinePolicyHash: H("redline-policy"),
  resetPolicyHash: H("reset-policy"),
  oracleHash: H("oracle"),
  verificationPolicyHash: H("verification-policy"),
});

// Re-derive with the shared kernel domain instead of hard-coding a fixture
// authority hash/trusted-parameter hash.
const EMPTY_TRUSTED_PARAMETER_HASH = deriveM6TrustedParameterHash({});

function environment() {
  return deriveTargetEnvironmentAttestation({
    appPackageHash: H("env-package"),
    appBuildHash: H("env-build"),
    signingHash: H("env-sign"),
    osBuildHash: H("env-os"),
    displayHash: H("display"),
    localeThemeHash: H("env-locale"),
    imeHash: H("env-ime"),
    accessibilityHash: H("env-access"),
    accountIsolationHash: H("env-account"),
    capturedAt: "2029-12-31T23:30:00.000Z",
    expiresAt: "2030-01-01T01:00:00.000Z",
  });
}

function actionSlotAuthority() {
  return deriveM64ActionSlotAuthority({
    ...SLOT_AUTHORITY,
    trustedParameterHash: EMPTY_TRUSTED_PARAMETER_HASH,
  });
}

function buildHarness(t) {
  const root = mkdtempSync(join(tmpdir(), "m64-fresh-state-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const evidenceStore = new M6FrameEvidenceStore({ root: join(root, "frames"), minFreeBytes: 0 });
  const attestation = environment();
  let ordinal = 0;

  async function buildCapture({
    input,
    dumpXml = BASE_DUMP,
    packageName = "com.xingin.xhs",
    activity = "com.xingin.xhs.MainActivity",
    focusPackage = packageName,
    capturedAtMs = NOW,
    overrides = {},
  } = {}) {
    ordinal += 1;
    const capturedAt = new Date(capturedAtMs).toISOString();
    const observationRaw = Object.freeze({
      package: packageName,
      activity,
      width: 1080,
      height: 2400,
      orientation: "portrait",
      density: 440,
      rotation: 0,
      screenOn: true,
      keyboardVisible: false,
    });
    const focusA = Object.freeze({
      raw: `mCurrentFocus=Window{a u0 ${focusPackage}/.MainActivity}`,
      screenOn: true,
      keyboardVisible: false,
      rotation: 0,
    });
    const focusB = Object.freeze({ ...focusA });
    const focusHash = focusStableFieldsHash(focusA, focusB);
    assert.match(focusHash, /^[0-9a-f]{64}$/u);
    const focusBlob = Buffer.from(`${focusA.raw}\n---FOCUS-B---\n${focusB.raw}`, "utf8");
    const refs = evidenceStore.commitFrame({
      screenshotA: PNG,
      screenshotB: PNG,
      dump: Buffer.from(dumpXml, "utf8"),
      focus: focusBlob,
      observation: Buffer.from(canonicalJson(observationRaw), "utf8"),
    });
    const pageFingerprint = H(`xw.page.v1:${canonicalJson({
      package: observationRaw.package,
      activity: observationRaw.activity,
      width: observationRaw.width,
      height: observationRaw.height,
      orientation: observationRaw.orientation,
      density: observationRaw.density,
    })}`);
    const assembled = assembleLiveStrictFrame({
      screenshotABytes: PNG,
      screenshotBBytes: PNG,
      dumpBytes: Buffer.from(dumpXml, "utf8"),
      focusA,
      focusB,
      displayObservation: observationRaw,
      skew: { aToBMs: 10, bToFocusBMs: 10 },
      nowMs: capturedAtMs,
      capturedAt,
      evidence: refs,
      linkage: { sessionId: "sess-m64", leaseRef: "lease-m64", alias: "01", appId: "xiaowei" },
      pageFingerprint,
      focusFingerprint: focusHash,
    });
    assert.equal(assembled.ok, true, assembled.errors?.map((entry) => entry.code).join(","));
    const sourceFrame = assembled.frame;
    const frameRef = H(`xw.m6-qualified-live-frame.v1:${sourceFrame.frameId}:${ordinal}`);
    const frame = Object.freeze({
      ...sourceFrame,
      sourceFrameId: sourceFrame.frameId,
      frameId: frameRef,
      focusHash,
      environmentAttestationHash: attestation.attestationHash,
    });
    const slotAuthority = actionSlotAuthority();
    const raw = {
      schemaId: M64_CONTROL_PLANE_FRESH_FRAME_SCHEMA_ID,
      sourceClass: M64_FRESH_CAPTURE_SOURCE_CLASS,
      sourceKind: M64_FRESH_CAPTURE_SOURCE_KIND,
      runRef: input.runRef,
      requestFrameRef: input.requestFrameRef,
      environmentAttestationHash: input.environmentAttestationHash,
      capturedAt,
      frameRef,
      frame,
      dumpXml,
      observationRaw,
      refs: Object.freeze(refs),
      slotContext: Object.freeze({
        scenarioKey: "m6-fresh-state-scenario",
        slotAuthority,
        slotSpecHash: H("slot-spec"),
        targetKind: "block",
      }),
      ...overrides,
    };
    return Object.freeze(raw);
  }

  return Object.freeze({ root, evidenceStore, attestation, buildCapture });
}

function inputFor(attestation, overrides = {}) {
  return Object.freeze({
    runRef: "run:m64-fresh-state",
    frameRef: H("request-frame"),
    environmentAttestationHash: attestation.attestationHash,
    signal: null,
    ...overrides,
  });
}

function createReader(harness, overrides = {}) {
  let sourceOverride = overrides.sourceOverride || null;
  const captureFreshFrame = overrides.captureFreshFrame || (async (input) => {
    const capture = await harness.buildCapture({ input, ...(sourceOverride || {}) });
    return capture;
  });
  return Object.freeze({
    setSourceOverride(value) { sourceOverride = value; },
    read: createM64ServerOwnedFreshCaptureReader({
      captureFreshFrame,
      selectFreshTarget: overrides.selectFreshTarget || (async ({ blockSet }) => blockSet.blocks[0].blockId),
      evidenceStore: harness.evidenceStore,
      environmentAttestation: harness.attestation,
      now: overrides.now || (() => NOW),
      maxCaptureAgeMs: overrides.maxCaptureAgeMs || 250,
    }),
  });
}

test("server-owned reader re-verifies a fresh Control Plane frame and emits the exact capture hash contract", async (t) => {
  const harness = buildHarness(t);
  const reader = createReader(harness);
  const input = inputFor(harness.attestation);
  const result = await reader.read(input);

  assert.deepEqual(Object.keys(result).sort(), [
    "captureHash", "capturedAt", "requestFrameRef", "runRef", "schemaId", "sourceClass", "sourceKind", "state",
  ].sort());
  assert.equal(result.schemaId, M64_FRESH_STATE_CAPTURE_SCHEMA_ID);
  assert.equal(result.sourceClass, M64_FRESH_CAPTURE_SOURCE_CLASS);
  assert.equal(result.sourceKind, M64_FRESH_CAPTURE_SOURCE_KIND);
  assert.equal(result.runRef, input.runRef);
  assert.equal(result.requestFrameRef, input.frameRef);
  assert.notEqual(result.state.frameId, input.frameRef, "a fresh guard must not replay the grounding frame");
  assert.equal(result.state.environmentAttestationHash, harness.attestation.attestationHash);
  assert.equal(Number.isSafeInteger(result.state.uiStateGeneration), true);
  assert.equal(result.captureHash, deriveM64FreshStateCaptureHash(result));
});

test("stable dispatch state survives content-addressed frame/block identity rotation and rejects semantic drift", async (t) => {
  const harness = buildHarness(t);
  const input = {
    runRef: "run:m64-fresh-state",
    requestFrameRef: H("request-frame"),
    environmentAttestationHash: harness.attestation.attestationHash,
    signal: null,
  };
  const first = await harness.buildCapture({ input, capturedAtMs: NOW });
  const second = await harness.buildCapture({ input, capturedAtMs: NOW + 1 });
  const changed = await harness.buildCapture({
    input,
    capturedAtMs: NOW + 2,
    dumpXml: BASE_DUMP.replace("安全标签", "另一个标签"),
  });

  const derive = (capture) => {
    const provider = deriveLiveVisualBlockSet({
      frame: capture.frame,
      dumpXml: capture.dumpXml,
      environmentAttestation: harness.attestation,
    });
    assert.ok(provider.blockSet);
    return deriveM64DispatchCurrentState({
      capture,
      provider,
      candidateBlockId: provider.blockSet.blocks[0].blockId,
      slotSpecHash: H("slot-spec"),
      targetKind: "block",
      environmentAttestation: harness.attestation,
    });
  };
  const firstState = derive(first);
  const secondState = derive(second);
  const changedState = derive(changed);

  assert.notEqual(firstState.frameId, secondState.frameId);
  assert.notEqual(firstState.blockId, secondState.blockId);
  assert.deepEqual(
    Object.fromEntries(M64_DISPATCH_COMPARABLE_STATE_FIELDS.map((field) => [field, firstState[field]])),
    Object.fromEntries(M64_DISPATCH_COMPARABLE_STATE_FIELDS.map((field) => [field, secondState[field]])),
  );
  assert.notEqual(changedState.uiStateGeneration, firstState.uiStateGeneration);
});

test("reader rejects stale, empty, cross-run, cross-frame, cross-environment, default, and tautological sources", async (t) => {
  const harness = buildHarness(t);
  const input = inputFor(harness.attestation);

  const cases = [
    {
      code: "M6_LIVE_FRESH_CAPTURE_STALE",
      captureFreshFrame: (request) => harness.buildCapture({ input: request, capturedAtMs: NOW - 251 }),
    },
    {
      code: "M6_LIVE_FRESH_CAPTURE_SOURCE_INVALID",
      captureFreshFrame: (request) => harness.buildCapture({ input: request, overrides: { runRef: "run:foreign" } }),
    },
    {
      code: "M6_LIVE_FRESH_CAPTURE_SOURCE_INVALID",
      captureFreshFrame: (request) => harness.buildCapture({ input: request, overrides: { requestFrameRef: H("foreign-frame") } }),
    },
    {
      code: "M6_LIVE_FRESH_CAPTURE_SOURCE_INVALID",
      captureFreshFrame: (request) => harness.buildCapture({ input: request, overrides: { environmentAttestationHash: H("foreign-env") } }),
    },
    {
      code: "M6_LIVE_FRESH_CAPTURE_SOURCE_INVALID",
      captureFreshFrame: (request) => harness.buildCapture({ input: request, overrides: { dumpXml: "" } }),
    },
    {
      code: "M6_LIVE_FRESH_CAPTURE_SOURCE_INVALID",
      captureFreshFrame: (request) => harness.buildCapture({ input: request, overrides: { frameRef: request.requestFrameRef } }),
    },
    {
      code: "M6_LIVE_FRESH_CAPTURE_SOURCE_INVALID",
      captureFreshFrame: async (request) => ({
        schemaId: M64_CONTROL_PLANE_FRESH_FRAME_SCHEMA_ID,
        sourceClass: M64_FRESH_CAPTURE_SOURCE_CLASS,
        sourceKind: M64_FRESH_CAPTURE_SOURCE_KIND,
        runRef: request.runRef,
        requestFrameRef: request.requestFrameRef,
        environmentAttestationHash: request.environmentAttestationHash,
        capturedAt: new Date(NOW).toISOString(),
        // A copied expected state is intentionally not a capture contract.
        state: { frameId: request.requestFrameRef },
      }),
    },
  ];

  for (const entry of cases) {
    const reader = createReader(harness, { captureFreshFrame: entry.captureFreshFrame });
    await assert.rejects(reader.read(input), (error) => error?.code === entry.code);
  }

  const exactReader = createReader(harness);
  await assert.rejects(
    exactReader.read({ ...input, expectedState: { frameId: input.frameRef } }),
    (error) => error?.code === "M6_LIVE_FRESH_CAPTURE_INPUT_INVALID",
  );
});

test("reader burns each fresh frame after verification and rejects replay", async (t) => {
  const harness = buildHarness(t);
  const input = inputFor(harness.attestation);
  const source = await harness.buildCapture({
    input: {
      runRef: input.runRef,
      requestFrameRef: input.frameRef,
      environmentAttestationHash: input.environmentAttestationHash,
      signal: null,
    },
  });
  const reader = createReader(harness, { captureFreshFrame: async () => source });
  await reader.read(input);
  await assert.rejects(reader.read(input), (error) => error?.code === "M6_LIVE_FRESH_CAPTURE_REPLAY");
});

test("capture acquisition may be slow when the returned frame itself is fresh", async (t) => {
  const harness = buildHarness(t);
  const input = inputFor(harness.attestation);
  const clock = [NOW, NOW + 5_000, NOW + 5_000];
  const reader = createReader(harness, {
    now: () => clock.shift() ?? NOW + 5_000,
    captureFreshFrame: (request) => harness.buildCapture({ input: request, capturedAtMs: NOW + 5_000 }),
  });
  const result = await reader.read(input);
  assert.equal(result.capturedAt, new Date(NOW + 5_000).toISOString());
});

test("capture freshness is checked again after the semantic selector returns", async (t) => {
  const harness = buildHarness(t);
  const input = inputFor(harness.attestation);
  const clock = [NOW, NOW, NOW + 251];
  const reader = createReader(harness, {
    now: () => clock.shift() ?? NOW + 251,
    selectFreshTarget: async ({ blockSet }) => blockSet.blocks[0].blockId,
  });
  await assert.rejects(reader.read(input), (error) => error?.code === "M6_LIVE_FRESH_CAPTURE_STALE");
});

test("M6 frame CAS symlinks cannot satisfy a server-owned fresh capture", async (t) => {
  const harness = buildHarness(t);
  const input = inputFor(harness.attestation);
  const source = await harness.buildCapture({
    input: {
      runRef: input.runRef,
      requestFrameRef: input.frameRef,
      environmentAttestationHash: input.environmentAttestationHash,
      signal: null,
    },
  });
  const target = harness.evidenceStore.blobPath(source.refs.dump.sha256);
  const replacement = join(harness.root, "replacement-dump.xml");
  const bytes = harness.evidenceStore.resolve(source.refs.dump).bytes;
  const { writeFileSync } = await import("node:fs");
  writeFileSync(replacement, bytes);
  unlinkSync(target);
  try {
    symlinkSync(replacement, target, "file");
  } catch (error) {
    t.skip(`symlink creation is unavailable: ${error.code || error.message}`);
    return;
  }
  const reader = createReader(harness, { captureFreshFrame: async () => source });
  await assert.rejects(reader.read(input), (error) => error?.code === "M6_LIVE_FRESH_CAPTURE_EVIDENCE_INVALID");
});
