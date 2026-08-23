import {
  deriveM64ActionSlotAuthority,
} from "../../../../packages/kernel/lib/m6-4-cohort.mjs";
import {
  deriveLiveVisualBlockSet,
  deriveTargetEnvironmentAttestation,
} from "../../../../packages/kernel/lib/m6-live-grounding.mjs";
import { verifyFrameManifest } from "../../../../packages/kernel/lib/m6-screen-frame.mjs";
import { canonicalJson, sha256 } from "./canonical.mjs";
import { ControlPlaneError } from "./errors.mjs";
import {
  M64_FRESH_STATE_CAPTURE_SCHEMA_ID,
  deriveM64FreshStateCaptureHash,
} from "./m6-live-production-dependencies.mjs";

export const M64_CONTROL_PLANE_FRESH_FRAME_SCHEMA_ID = "xw.m6-4-control-plane-fresh-frame.v1";
export const M64_FRESH_CAPTURE_SOURCE_CLASS = "SERVER_OWNED_FRESH_CAPTURE";
export const M64_FRESH_CAPTURE_SOURCE_KIND = "CONTROL_PLANE_FRAME_GUARD";

export const M64_DISPATCH_STATE_FIELDS = Object.freeze([
  "appPackageHash",
  "blockId",
  "displayHash",
  "environmentAttestationHash",
  "focusHash",
  "frameId",
  "pageFingerprint",
  "rotation",
  "slotSpecHash",
  "uiStateGeneration",
]);

// Frame/block ids are content-addressed identities and therefore change on a
// genuinely new capture. These seven fields are the independently re-derived
// dispatch guard: unchanged UI semantics produce the same values, while an
// application/focus/page/target/geometry/environment drift changes at least
// one value before transport linearization.
export const M64_DISPATCH_COMPARABLE_STATE_FIELDS = Object.freeze([
  "uiStateGeneration",
  "appPackageHash",
  "focusHash",
  "pageFingerprint",
  "rotation",
  "displayHash",
  "environmentAttestationHash",
]);

const HASH = /^[0-9a-f]{64}$/u;
const RUN_REF = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/u;
const TARGET_KINDS = new Set(["block", "screen", "none"]);
const READER_INPUT_KEYS = Object.freeze(["environmentAttestationHash", "frameRef", "runRef", "signal"]);
const CAPTURE_KEYS = Object.freeze([
  "capturedAt",
  "dumpXml",
  "environmentAttestationHash",
  "frame",
  "frameRef",
  "observationRaw",
  "refs",
  "requestFrameRef",
  "runRef",
  "schemaId",
  "slotContext",
  "sourceClass",
  "sourceKind",
]);
const SLOT_CONTEXT_KEYS = Object.freeze(["scenarioKey", "slotAuthority", "slotSpecHash", "targetKind"]);
const REF_KEYS = Object.freeze(["id", "sha256"]);
const REFS_KEYS = Object.freeze(["dump", "focus", "observation", "screenshotA", "screenshotB"]);
const QUALIFIED_FRAME_EXTRA_KEYS = Object.freeze(["environmentAttestationHash", "focusHash", "sourceFrameId"]);
const CANONICAL_FRAME_KEYS = Object.freeze([
  "capturedAt",
  "density",
  "dumpRef",
  "expiresAt",
  "flags",
  "focusRef",
  "frameId",
  "height",
  "linkage",
  "manifestSha256",
  "mode",
  "observationRef",
  "schemaId",
  "screenshotARef",
  "screenshotASha256",
  "screenshotBRef",
  "screenshotBSha256",
  "stability",
  "width",
  "orientation",
]);
const FORBIDDEN_SOURCE_KEYS = /^(?:command|deviceSerial|expectedState|ledger|model|path|rawShell|runtimeId|serial|state|transport)$/iu;

function fail(code, message, details = {}) {
  throw new ControlPlaneError(code, message, { status: 409, details });
}

function exactObject(value, keys) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort()));
}

function cloneFrozen(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(cloneFrozen));
  if (value && typeof value === "object") {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneFrozen(item)])));
  }
  return value;
}

function assertNoForbiddenSourceShape(value) {
  const seen = new Set();
  const visit = (item) => {
    if (!item || typeof item !== "object" || seen.has(item)) return;
    seen.add(item);
    for (const [key, child] of Object.entries(item)) {
      if (FORBIDDEN_SOURCE_KEYS.test(key)) {
        fail("M6_LIVE_FRESH_CAPTURE_SOURCE_FORBIDDEN", "fresh capture exposed a forbidden low-level or tautological source field");
      }
      visit(child);
    }
  };
  visit(value);
}

function validateEnvironmentAttestation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("fresh-state capture requires one target environment attestation");
  }
  const { attestationHash: _ignored, ...raw } = value;
  let derived;
  try {
    derived = deriveTargetEnvironmentAttestation(raw);
  } catch (cause) {
    throw new TypeError(`fresh-state capture environment attestation is invalid: ${cause?.code || cause?.message || "unknown"}`);
  }
  if (value.attestationHash !== derived.attestationHash) {
    throw new TypeError("fresh-state capture environment attestation hash is invalid");
  }
  return derived;
}

function stableBlockProjection(block, privateGeometry) {
  const region = privateGeometry.get(block.boundsRef);
  if (!region || ![region.x1, region.y1, region.x2, region.y2].every(Number.isInteger)
    || region.x2 <= region.x1 || region.y2 <= region.y1) {
    fail("M6_LIVE_FRESH_CAPTURE_GEOMETRY_INVALID", "fresh semantic block has no server-owned geometry");
  }
  return Object.freeze({
    classHash: block.classHash ?? null,
    descriptionHash: block.descriptionHash ?? null,
    flags: cloneFrozen(block.flags),
    packageHash: block.packageHash ?? null,
    region: Object.freeze({ ...region }),
    resourceHash: block.resourceHash ?? null,
    safeRegion: block.safeRegion === true,
    structureHash: block.structureHash ?? null,
    textHash: block.textHash ?? null,
  });
}

function stableVisualFingerprint(provider) {
  if (!provider?.blockSet || !(provider.privateGeometry instanceof Map)) {
    fail("M6_LIVE_FRESH_CAPTURE_BLOCK_SET_INVALID", "fresh capture did not produce one server-owned visual block set");
  }
  const blocks = provider.blockSet.blocks
    .map((block) => stableBlockProjection(block, provider.privateGeometry))
    .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  if (blocks.length === 0) {
    fail("M6_LIVE_FRESH_CAPTURE_EMPTY", "fresh capture contains no safe semantic blocks");
  }
  return sha256(`xw.m6-4-stable-visual-state.v1:${canonicalJson(blocks)}`);
}

function stableTargetFingerprint({ provider, candidateBlockId, targetKind }) {
  if (targetKind === "block") {
    const matches = provider.blockSet.blocks.filter((block) => block.blockId === candidateBlockId);
    if (matches.length !== 1 || matches[0].safeRegion !== true || matches[0].flags?.sensitive === true
      || matches[0].flags?.advertisement === true || matches[0].flags?.keyboard === true) {
      fail("M6_LIVE_FRESH_CAPTURE_TARGET_INVALID", "fresh capture did not resolve the exact safe semantic target");
    }
    return sha256(`xw.m6-4-stable-target.v1:${canonicalJson(stableBlockProjection(matches[0], provider.privateGeometry))}`);
  }
  if (candidateBlockId !== null) {
    fail("M6_LIVE_FRESH_CAPTURE_TARGET_INVALID", "non-block fresh capture must not carry a block target");
  }
  return sha256(`xw.m6-4-stable-target.v1:${targetKind}`);
}

export function deriveM64DispatchCurrentState({
  capture,
  provider,
  candidateBlockId = null,
  slotSpecHash,
  targetKind,
  environmentAttestation,
} = {}) {
  if (!capture || !capture.frame || capture.frame.frameId !== capture.frameRef
    || !HASH.test(capture.frameRef || "") || !HASH.test(slotSpecHash || "")
    || !TARGET_KINDS.has(targetKind) || !environmentAttestation
    || capture.frame.environmentAttestationHash !== environmentAttestation.attestationHash
    || !HASH.test(capture.frame.focusHash || "")
    || capture.frame.focusHash !== capture.frame.stability?.focusFingerprint
    || !HASH.test(capture.frame.stability?.pageFingerprint || "")
    || typeof capture.observationRaw?.package !== "string" || capture.observationRaw.package.trim() === ""
    || capture.observationRaw.package === "unknown"
    || !Number.isInteger(capture.observationRaw.rotation)
    || capture.observationRaw.rotation < 0 || capture.observationRaw.rotation > 3) {
    fail("M6_LIVE_FRESH_CAPTURE_STATE_INVALID", "fresh capture cannot independently derive a closed dispatch state");
  }
  const visualFingerprint = stableVisualFingerprint(provider);
  const targetFingerprint = stableTargetFingerprint({ provider, candidateBlockId, targetKind });
  const dynamic = Object.freeze({
    appPackageHash: sha256(`xw.m6-focused-package.v1:${capture.observationRaw.package}`),
    displayHash: environmentAttestation.displayHash,
    environmentAttestationHash: environmentAttestation.attestationHash,
    focusHash: capture.frame.focusHash,
    pageFingerprint: capture.frame.stability.pageFingerprint,
    rotation: capture.observationRaw.rotation,
    targetFingerprint,
    visualFingerprint,
  });
  const generationHash = sha256(`xw.m6-4-stable-ui-generation.v1:${canonicalJson(dynamic)}`);
  // Thirteen hex digits are 52 bits, so the number is exact and safe in JS.
  const uiStateGeneration = Number.parseInt(generationHash.slice(0, 13), 16);
  if (!Number.isSafeInteger(uiStateGeneration)) {
    fail("M6_LIVE_FRESH_CAPTURE_GENERATION_INVALID", "stable UI generation is not a safe integer");
  }
  return Object.freeze({
    slotSpecHash,
    frameId: capture.frameRef,
    blockId: targetKind === "block" ? candidateBlockId : null,
    uiStateGeneration,
    appPackageHash: dynamic.appPackageHash,
    focusHash: dynamic.focusHash,
    pageFingerprint: dynamic.pageFingerprint,
    rotation: dynamic.rotation,
    displayHash: dynamic.displayHash,
    environmentAttestationHash: dynamic.environmentAttestationHash,
  });
}

function validateReaderInput(value) {
  const keys = value?.signal === undefined
    ? READER_INPUT_KEYS.filter((key) => key !== "signal")
    : READER_INPUT_KEYS;
  if (!exactObject(value, keys) || !RUN_REF.test(value.runRef || "")
    || !HASH.test(value.frameRef || "") || !HASH.test(value.environmentAttestationHash || "")) {
    fail("M6_LIVE_FRESH_CAPTURE_INPUT_INVALID", "fresh capture input is not an exact closed run/frame/environment request");
  }
  if (value.signal !== undefined && value.signal !== null
    && (typeof value.signal !== "object" || typeof value.signal.aborted !== "boolean")) {
    fail("M6_LIVE_FRESH_CAPTURE_INPUT_INVALID", "fresh capture signal is invalid");
  }
  if (value.signal?.aborted) fail("M6_LIVE_FRESH_CAPTURE_ABORTED", "fresh capture was aborted before acquisition");
}

function validateSlotContext(value) {
  if (!exactObject(value, SLOT_CONTEXT_KEYS) || typeof value.scenarioKey !== "string" || value.scenarioKey.length < 1
    || value.scenarioKey.length > 128 || !HASH.test(value.slotSpecHash || "")
    || !TARGET_KINDS.has(value.targetKind) || value.slotAuthority?.targetKind !== value.targetKind) {
    fail("M6_LIVE_FRESH_CAPTURE_SLOT_INVALID", "fresh capture did not bind one active server-owned slot");
  }
  let derived;
  try {
    derived = deriveM64ActionSlotAuthority(value.slotAuthority);
  } catch (cause) {
    fail("M6_LIVE_FRESH_CAPTURE_SLOT_INVALID", "fresh capture slot authority is invalid", { cause: cause?.code || null });
  }
  if (derived.slotAuthorityHash !== value.slotAuthority.slotAuthorityHash) {
    fail("M6_LIVE_FRESH_CAPTURE_SLOT_INVALID", "fresh capture slot authority hash changed");
  }
  return Object.freeze({ ...value, slotAuthority: derived });
}

function resolveAndVerifyEvidence(capture, evidenceStore) {
  if (!exactObject(capture.refs, REFS_KEYS) || typeof evidenceStore?.resolve !== "function") {
    fail("M6_LIVE_FRESH_CAPTURE_EVIDENCE_INVALID", "fresh capture requires the M6 frame CAS resolver");
  }
  const resolved = new Map();
  for (const key of REFS_KEYS) {
    const ref = capture.refs[key];
    if (!exactObject(ref, REF_KEYS) || !HASH.test(ref.sha256 || "")
      || typeof ref.id !== "string" || !ref.id.endsWith(ref.sha256)) {
      fail("M6_LIVE_FRESH_CAPTURE_EVIDENCE_INVALID", "fresh capture evidence reference is malformed");
    }
    let blob;
    try {
      blob = evidenceStore.resolve(ref);
    } catch (cause) {
      fail("M6_LIVE_FRESH_CAPTURE_EVIDENCE_INVALID", "fresh capture evidence is absent, linked, or tampered", {
        cause: cause?.code || null,
      });
    }
    if (blob.id !== ref.id || blob.sha256 !== ref.sha256 || !Buffer.isBuffer(blob.bytes)) {
      fail("M6_LIVE_FRESH_CAPTURE_EVIDENCE_INVALID", "fresh capture evidence resolver returned a rebound blob");
    }
    resolved.set(ref.id, blob.bytes);
  }
  if (!Buffer.from(capture.dumpXml, "utf8").equals(resolved.get(capture.refs.dump.id))) {
    fail("M6_LIVE_FRESH_CAPTURE_EVIDENCE_INVALID", "fresh dump is not the committed M6 frame evidence");
  }
  let observation;
  try {
    observation = JSON.parse(resolved.get(capture.refs.observation.id).toString("utf8"));
  } catch {
    fail("M6_LIVE_FRESH_CAPTURE_EVIDENCE_INVALID", "fresh observation evidence is invalid JSON");
  }
  if (canonicalJson(observation) !== canonicalJson(capture.observationRaw)) {
    fail("M6_LIVE_FRESH_CAPTURE_EVIDENCE_INVALID", "fresh observation is not the committed M6 frame evidence");
  }
  return Object.freeze({ resolved, observation: cloneFrozen(observation) });
}

function validateQualifiedFrame(capture, resolved) {
  const frame = capture.frame;
  const expectedKeys = [...CANONICAL_FRAME_KEYS, ...QUALIFIED_FRAME_EXTRA_KEYS];
  if (!exactObject(frame, expectedKeys) || frame.schemaId !== "xw.screen-frame.v1" || frame.mode !== "live_strict"
    || frame.frameId !== capture.frameRef || frame.environmentAttestationHash !== capture.environmentAttestationHash
    || !HASH.test(frame.sourceFrameId || "") || frame.sourceFrameId === frame.frameId
    || !HASH.test(frame.focusHash || "") || frame.focusHash !== frame.stability?.focusFingerprint
    || frame.stability?.verdict !== "stable" || !HASH.test(frame.stability?.pageFingerprint || "")
    || frame.capturedAt !== capture.capturedAt) {
    fail("M6_LIVE_FRESH_CAPTURE_FRAME_INVALID", "fresh capture is not one qualified live-strict M6 frame");
  }
  for (const key of REFS_KEYS) {
    const frameKey = key === "dump" ? "dumpRef" : key === "focus" ? "focusRef"
      : key === "observation" ? "observationRef" : `${key}Ref`;
    if (canonicalJson(frame[frameKey]) !== canonicalJson(capture.refs[key])) {
      fail("M6_LIVE_FRESH_CAPTURE_FRAME_INVALID", "fresh qualified frame changed its evidence binding");
    }
  }
  const sourceFrame = Object.freeze({
    ...Object.fromEntries(CANONICAL_FRAME_KEYS.map((key) => [key, frame[key]])),
    frameId: frame.sourceFrameId,
  });
  const verified = verifyFrameManifest(sourceFrame, (ref) => resolved.get(ref.id) ?? null);
  if (!verified.ok) {
    fail("M6_LIVE_FRESH_CAPTURE_FRAME_INVALID", "fresh qualified frame manifest did not re-verify", {
      errors: verified.errors?.map((error) => error.code) || [],
    });
  }
}

function validateSourceCapture(capture, input, environmentAttestation, evidenceStore, startedAtMs, finishedAtMs, maxCaptureAgeMs) {
  if (!exactObject(capture, CAPTURE_KEYS) || capture.schemaId !== M64_CONTROL_PLANE_FRESH_FRAME_SCHEMA_ID
    || capture.sourceClass !== M64_FRESH_CAPTURE_SOURCE_CLASS || capture.sourceKind !== M64_FRESH_CAPTURE_SOURCE_KIND
    || capture.runRef !== input.runRef || capture.requestFrameRef !== input.frameRef
    || capture.environmentAttestationHash !== input.environmentAttestationHash
    || capture.environmentAttestationHash !== environmentAttestation.attestationHash
    || capture.frameRef === input.frameRef || !HASH.test(capture.frameRef || "")
    || typeof capture.dumpXml !== "string" || capture.dumpXml.length === 0) {
    fail("M6_LIVE_FRESH_CAPTURE_SOURCE_INVALID", "control-plane fresh capture is empty, cross-run, cross-frame, or rebound");
  }
  assertNoForbiddenSourceShape(capture);
  const capturedAtMs = Date.parse(capture.capturedAt);
  if (!Number.isFinite(capturedAtMs) || capturedAtMs < startedAtMs - 5
    || finishedAtMs - capturedAtMs < -5_000 || finishedAtMs - capturedAtMs > maxCaptureAgeMs) {
    fail("M6_LIVE_FRESH_CAPTURE_STALE", "control-plane frame was not freshly captured for this dispatch");
  }
  const evidence = resolveAndVerifyEvidence(capture, evidenceStore);
  validateQualifiedFrame(capture, evidence.resolved);
  return Object.freeze({ evidence, slotContext: validateSlotContext(capture.slotContext) });
}

function assertCaptureStillFresh(capturedAt, nowMs, maxCaptureAgeMs) {
  const capturedAtMs = Date.parse(capturedAt);
  if (!Number.isFinite(nowMs) || !Number.isFinite(capturedAtMs)
    || nowMs - capturedAtMs < -5_000 || nowMs - capturedAtMs > maxCaptureAgeMs) {
    fail("M6_LIVE_FRESH_CAPTURE_STALE", "fresh capture expired before semantic state sealing");
  }
}

export function createM64ServerOwnedFreshCaptureReader({
  captureFreshFrame,
  selectFreshTarget,
  evidenceStore,
  environmentAttestation,
  now = Date.now,
  maxCaptureAgeMs = 250,
} = {}) {
  if (typeof captureFreshFrame !== "function" || typeof selectFreshTarget !== "function"
    || typeof evidenceStore?.resolve !== "function" || typeof now !== "function"
    || !Number.isSafeInteger(maxCaptureAgeMs) || maxCaptureAgeMs < 1 || maxCaptureAgeMs > 1_000) {
    throw new TypeError("fresh-state reader requires Control Plane capture, semantic selector, M6 CAS, clock, and bounded freshness");
  }
  const environment = validateEnvironmentAttestation(environmentAttestation);
  const consumedFreshFrameRefs = new Set();

  return async function readFreshCapture(input) {
    validateReaderInput(input);
    if (input.environmentAttestationHash !== environment.attestationHash) {
      fail("M6_LIVE_FRESH_CAPTURE_ENVIRONMENT_MISMATCH", "fresh capture request changed its target environment");
    }
    const startedAtMs = Number(now());
    if (!Number.isFinite(startedAtMs)) throw new TypeError("fresh-state capture clock must be finite");
    const source = await captureFreshFrame(Object.freeze({
      runRef: input.runRef,
      requestFrameRef: input.frameRef,
      environmentAttestationHash: input.environmentAttestationHash,
      signal: input.signal ?? null,
    }));
    if (input.signal?.aborted) fail("M6_LIVE_FRESH_CAPTURE_ABORTED", "fresh capture was aborted after acquisition");
    const finishedAtMs = Number(now());
    if (!Number.isFinite(finishedAtMs) || finishedAtMs < startedAtMs) {
      throw new TypeError("fresh-state capture clock moved backwards");
    }
    const validated = validateSourceCapture(
      source,
      input,
      environment,
      evidenceStore,
      startedAtMs,
      finishedAtMs,
      maxCaptureAgeMs,
    );
    if (consumedFreshFrameRefs.has(source.frameRef)) {
      fail("M6_LIVE_FRESH_CAPTURE_REPLAY", "one server-owned fresh frame cannot guard more than one dispatch");
    }
    // Burn after CAS + manifest verification. A later selector/state failure
    // must not make the same physical observation reusable as a fresh proof.
    consumedFreshFrameRefs.add(source.frameRef);
    const provider = deriveLiveVisualBlockSet({
      frame: source.frame,
      dumpXml: source.dumpXml,
      environmentAttestation: environment,
    });
    if (!provider.blockSet) {
      fail("M6_LIVE_FRESH_CAPTURE_EMPTY", "fresh control-plane capture cannot derive a safe semantic UI state", {
        disposition: provider.disposition,
        reason: provider.reason,
      });
    }
    let candidateBlockId = null;
    if (validated.slotContext.targetKind === "block") {
      candidateBlockId = await selectFreshTarget(Object.freeze({
        scenarioKey: validated.slotContext.scenarioKey,
        slotAuthority: validated.slotContext.slotAuthority,
        blockSet: provider.blockSet,
        signal: input.signal ?? null,
      }));
      if (!HASH.test(candidateBlockId || "")
        || provider.blockSet.blocks.filter((block) => block.blockId === candidateBlockId).length !== 1) {
        fail("M6_LIVE_FRESH_CAPTURE_TARGET_INVALID", "fresh semantic selector did not return one server-owned block");
      }
    }
    if (input.signal?.aborted) fail("M6_LIVE_FRESH_CAPTURE_ABORTED", "fresh capture was aborted before state sealing");
    const state = deriveM64DispatchCurrentState({
      capture: source,
      provider,
      candidateBlockId,
      slotSpecHash: validated.slotContext.slotSpecHash,
      targetKind: validated.slotContext.targetKind,
      environmentAttestation: environment,
    });
    // Selection and semantic derivation are awaited work. Recheck after both,
    // otherwise a capture that was fresh at arrival could expire before the
    // state guard is returned to the transport TCB.
    assertCaptureStillFresh(source.capturedAt, Number(now()), maxCaptureAgeMs);
    const raw = Object.freeze({
      schemaId: M64_FRESH_STATE_CAPTURE_SCHEMA_ID,
      sourceClass: M64_FRESH_CAPTURE_SOURCE_CLASS,
      sourceKind: M64_FRESH_CAPTURE_SOURCE_KIND,
      runRef: input.runRef,
      requestFrameRef: input.frameRef,
      capturedAt: source.capturedAt,
      state,
    });
    return Object.freeze({ ...raw, captureHash: deriveM64FreshStateCaptureHash(raw) });
  };
}
