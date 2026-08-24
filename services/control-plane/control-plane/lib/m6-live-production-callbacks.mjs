import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import {
  materializeM64ActionSlotSpec,
} from "../../../../packages/kernel/lib/m6-4-cohort.mjs";
import {
  validateM64EffectBoundary,
  verifyM64EffectObservation,
} from "../../../../packages/kernel/lib/m6-effect-boundary.mjs";
import {
  M64_LIVE_ACTION_EVIDENCE_SCHEMA_ID,
  M64_LIVE_ATTEMPT_EVIDENCE_SCHEMA_ID,
  deriveM64ActionEvidence,
  deriveM64AttemptEvidence,
  deriveM64ExpectedStateArtifact,
  deriveM64IndependentEffectObservation as deriveSharedM64IndependentEffectObservation,
  validateM64ExpectedStateArtifact,
  validateM64IndependentEffectObservation,
} from "../../../../packages/kernel/lib/m6-live-evidence.mjs";
import {
  M64_CANARY_SEARCH_QUERY,
  deriveM6LogicalActionIdentity,
  deriveM6TrustedApplicationRef,
  deriveM6TrustedTextRef,
} from "../../../../packages/kernel/lib/m6-action-slot.mjs";
import {
  decideLiveGrounding,
  deriveLiveVisualBlockSet,
  deriveTargetEnvironmentAttestation,
} from "../../../../packages/kernel/lib/m6-live-grounding.mjs";
import {
  assembleLiveStrictFrame,
  focusStableFieldsHash,
  verifyFrameManifest,
} from "../../../../packages/kernel/lib/m6-screen-frame.mjs";
import { createM6GroundedTcb } from "../../apps/xiaowei/m6-grounded-tcb.mjs";
import { readObservation } from "../../apps/xiaowei/read-observation.mjs";
import { canonicalJson, sha256 } from "./canonical.mjs";
import { ControlPlaneError } from "./errors.mjs";
import { createM6GroundedActionFacade } from "./m6-grounded-action-facade.mjs";
import { verifyM6GroundedRunCapabilitySeal } from "./m6-grounded-run-capability-seal.mjs";
import {
  M64_CONTROL_PLANE_FRESH_FRAME_SCHEMA_ID,
  M64_FRESH_CAPTURE_SOURCE_CLASS,
  M64_FRESH_CAPTURE_SOURCE_KIND,
  createM64ServerOwnedFreshCaptureReader,
  deriveM64DispatchCurrentState,
} from "./m6-live-fresh-state-capture.mjs";
import { createM6TypedTransport } from "./m6-typed-transport.mjs";

const HASH = /^[0-9a-f]{64}$/u;
const TERMINAL_JOBS = new Set(["succeeded", "failed", "ambiguous", "cancelled", "recovery_required"]);
const ZERO_ACTION_PURPOSES = new Set(["M6_4_SHADOW", "M6_4_HOT_CLOSE"]);
// Settings *effects* remain forbidden by the effect boundary and semantic
// redlines. The frozen smooth cohort contains navigation-only settings slots,
// so rejecting the word "settings" here made the exact 30-run cohort
// structurally impossible before the effect firewall was consulted.
const HARD_FORBIDDEN_ACTION = /(payment|pay|delete|publish|public|social|comment|follow|message|account|security|draft)/iu;
const MATCH_KEYS = Object.freeze([
  "schemaId", "matched", "selfDerived", "expectedStateHash", "beforeObservationHash",
  "afterObservationHash", "slotAuthorityHash", "independentAuthorHash", "matchHash",
]);

function fail(code, message, details = {}) {
  throw new ControlPlaneError(code, message, { status: 409, details });
}

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort());
}

function hashPayload(schemaId, value) {
  return sha256(`${schemaId}:${canonicalJson(value)}`);
}

function reasonRef(reason) {
  return sha256(`xw.m6-live-reason.v1:${reason}`);
}

function validIso(value) {
  return Number.isFinite(Date.parse(value));
}

function seamError(code, seam, status = 504) {
  return new ControlPlaneError(code, `M6 production ${seam} seam did not settle inside its authority window`, {
    status,
    details: { seam },
  });
}

function assertSignalActive(signal, seam) {
  if (signal?.aborted) throw seamError("M6_LIVE_SEAM_ABORTED", seam, 409);
}

async function runExternalSeam({ seam, signal = null, timeoutMs }, invoke) {
  assertSignalActive(signal, seam);
  const timeoutController = new AbortController();
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;
  let timer;
  let removeAbortListener = () => {};
  const aborted = new Promise((_, reject) => {
    const rejectAborted = () => reject(seamError("M6_LIVE_SEAM_ABORTED", seam, 409));
    if (signal) {
      signal.addEventListener("abort", rejectAborted, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", rejectAborted);
    }
  });
  const timedOut = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = seamError("M6_LIVE_SEAM_TIMEOUT", seam);
      timeoutController.abort(error);
      reject(error);
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => {
        assertSignalActive(combinedSignal, seam);
        return invoke(combinedSignal);
      }),
      aborted,
      timedOut,
    ]);
    assertSignalActive(combinedSignal, seam);
    return result;
  } finally {
    clearTimeout(timer);
    removeAbortListener();
  }
}

function redactError(error) {
  const code = typeof error?.code === "string" && /^[A-Z0-9_]{3,96}$/u.test(error.code)
    ? error.code : "M6_LIVE_CALLBACK_FAILURE";
  return Object.freeze({ code, errorHash: sha256(`xw.m6-live-error.v1:${code}`) });
}

function terminalizeJob(state, jobId, { succeeded, errorCode = null, result = undefined } = {}) {
  let current = state.getJob(jobId);
  if (!current || TERMINAL_JOBS.has(current.status)) return current;
  if (!succeeded) return state.transitionJob(jobId, "failed", { errorCode, result });
  if (current.status === "running") current = state.transitionJob(jobId, "verifying");
  if (current.status === "verifying") current = state.transitionJob(jobId, "restoring");
  if (current.status !== "restoring") fail("M6_LIVE_JOB_TERMINAL_INVALID", "grounded-run job cannot enter the required restoration phase");
  return state.transitionJob(jobId, "succeeded", { result });
}

export function deriveM64OracleExpectation(input) {
  return deriveM64ExpectedStateArtifact(input);
}

export function deriveM64IndependentEffectObservation(input) {
  return deriveSharedM64IndependentEffectObservation(input);
}

export function deriveM64IndependentOracleMatch(input) {
  const raw = Object.fromEntries(MATCH_KEYS.filter((key) => key !== "matchHash").map((key) => [key, input?.[key]]));
  return Object.freeze({ ...raw, matchHash: hashPayload("xw.m6-4-independent-oracle-match.v1", raw) });
}

export class M6LiveAuditStore {
  constructor({ root } = {}) {
    if (typeof root !== "string" || !isAbsolute(root)) {
      throw new TypeError("M6 live audit root must be absolute");
    }
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true });
    const stat = lstatSync(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new TypeError("M6 live audit root must be one plain directory");
    }
  }

  commit(kind, payload) {
    if (!/^[a-z][a-z0-9-]{2,48}$/u.test(kind || "")) throw new TypeError("invalid M6 live audit kind");
    const envelope = Object.freeze({ schemaId: "xw.m6-live-audit-artifact.v1", kind, payload });
    const bytes = Buffer.from(canonicalJson(envelope), "utf8");
    const artifactHash = createHash("sha256").update(bytes).digest("hex");
    const target = join(this.root, `${kind}-${artifactHash}.json`);
    if (existsSync(target)) {
      if (!lstatSync(target).isFile() || !readFileSync(target).equals(bytes)) {
        fail("M6_LIVE_AUDIT_CAS_CONFLICT", "existing audit artifact does not match its content address");
      }
      return Object.freeze({ artifactHash, artifactRef: artifactHash });
    }
    const temporary = `${target}.${process.pid}.tmp`;
    let descriptor;
    try {
      descriptor = openSync(temporary, "wx", 0o600);
      writeSync(descriptor, bytes);
      fsyncSync(descriptor);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
    renameSync(temporary, target);
    if (!readFileSync(target).equals(bytes)) fail("M6_LIVE_AUDIT_READBACK_FAILED", "audit artifact readback failed");
    return Object.freeze({ artifactHash, artifactRef: artifactHash });
  }
}

function assertEnvironment({ environmentAttestation, environmentQualification, nowMs }) {
  const { attestationHash: _ignored, ...raw } = environmentAttestation || {};
  const rebound = deriveTargetEnvironmentAttestation(raw);
  if (environmentAttestation?.attestationHash !== rebound.attestationHash
    || environmentQualification?.schemaId !== "xw.m6-environment-qualification.v1"
    || environmentQualification.status !== "QUALIFIED"
    || environmentQualification.gateFEligible !== true
    || environmentQualification.alias !== "01"
    || environmentQualification.effectBoundary !== "READ_ONLY"
    || environmentQualification.actionCount !== 0
    || environmentQualification.secretMaterialPresent !== false
    || environmentQualification.rawDeviceIdentityPresent !== false
    || !Array.isArray(environmentQualification.qualifiedAttestationHashes)
    || !environmentQualification.qualifiedAttestationHashes.includes(rebound.attestationHash)
    || !validIso(rebound.expiresAt) || Date.parse(rebound.expiresAt) <= nowMs
    || !validIso(environmentQualification.expiresAt) || Date.parse(environmentQualification.expiresAt) <= nowMs) {
    fail("M6_ENV_ATTESTATION_UNQUALIFIED", "production callbacks require one current qualified alias-01 environment attestation");
  }
  return rebound;
}

function assertExpectation(value, authority, nowMs) {
  const validation = validateM64ExpectedStateArtifact(value, {
    bindings: {
      purpose: authority.purpose,
      manifestHash: authority.manifestHash,
      scenarioKey: authority.scenarioKey,
      primaryFamily: authority.primaryFamily,
      oracleHash: authority.oracleHash,
      effectBoundaryHash: authority.effectBoundaryHash,
      environmentAttestationHash: authority.environmentAttestationHash,
      accountIsolationHash: authority.accountIsolationHash,
    },
    authoredNoLaterThan: authority.liveAuthorizationIssuedAt,
    expiresNoEarlierThan: authority.liveAuthorizationExpiresAt,
    nowMs,
  });
  if (!validation.ok) {
    fail("M6_ORACLE_EXPECTATION_INVALID", "independently authored expected data is absent, stale, or rebound");
  }
  return Object.freeze({ ...value });
}

function assertIndependentObservation(value, { authority, expectation, phase, nowMs }) {
  const validation = validateM64IndependentEffectObservation(value, {
    expectation,
    bindings: {
      scenarioKey: authority.scenarioKey,
      primaryFamily: authority.primaryFamily,
      oracleHash: authority.oracleHash,
      effectBoundaryHash: authority.effectBoundaryHash,
      environmentAttestationHash: authority.environmentAttestationHash,
      accountIsolationHash: authority.accountIsolationHash,
    },
    phase,
    nowMs,
  });
  if (!validation.ok) {
    fail("M6_ORACLE_OBSERVATION_INVALID", "independent effect observation changed authority or source");
  }
  return value;
}

function assertOracleMatch(value, { expectation, before, after, slotAuthority }) {
  if (!exactKeys(value, MATCH_KEYS)) fail("M6_ORACLE_MATCH_INVALID", "independent oracle match is not closed");
  const rebound = deriveM64IndependentOracleMatch(value);
  if (value.schemaId !== "xw.m6-4-independent-oracle-match.v1" || value.matchHash !== rebound.matchHash
    || value.matched !== true || value.selfDerived !== false || value.expectedStateHash !== expectation.expectedStateHash
    || value.beforeObservationHash !== before.observationHash || value.afterObservationHash !== after.observationHash
    || value.slotAuthorityHash !== slotAuthority.slotAuthorityHash
    || value.independentAuthorHash !== expectation.independentAuthorHash) {
    fail("M6_ORACLE_EXPECTED_STATE_MISMATCH", "independent business oracle did not match the pre-dispatch expectation");
  }
  return Object.freeze({ ...value });
}

function qualifiedFrameId({ frame, environmentAttestation, fence, runId, session }) {
  return sha256(`xw.m6-qualified-live-frame.v1:${canonicalJson({
    sourceFrameId: frame.frameId,
    manifestSha256: frame.manifestSha256,
    environmentAttestationHash: environmentAttestation.attestationHash,
    gateEpochHash: fence.epochHash,
    gateGeneration: fence.generation,
    runId,
    sessionId: session.sessionId,
    leaseId: session.leaseId,
  })}`);
}

async function captureQualifiedFrame({
  state,
  transport,
  evidence,
  device,
  session,
  environmentAttestation,
  fence,
  runId,
  observeDevice,
  now,
  generation,
  signal,
  timeoutMs,
}) {
  state.assertM6GateFence(fence);
  const captured = await runExternalSeam({ seam: "observe-device", signal, timeoutMs }, (activeSignal) => observeDevice({
    transport,
    serial: device.runtimeId,
    now,
    signal: activeSignal,
  }));
  const raw = captured?.evidence || {};
  const focusBlob = Buffer.concat([
    Buffer.isBuffer(raw.focusA) ? raw.focusA : Buffer.from(String(raw.focusA ?? ""), "utf8"),
    Buffer.from("\n---FOCUS-B---\n", "utf8"),
    Buffer.isBuffer(raw.focusB) ? raw.focusB : Buffer.from(String(raw.focusB ?? ""), "utf8"),
  ]);
  const refs = evidence.commitFrame({
    screenshotA: raw.screenshotA,
    screenshotB: raw.screenshotB,
    dump: raw.dump,
    focus: focusBlob,
    observation: Buffer.from(canonicalJson(captured.observation), "utf8"),
  });
  const focusA = {
    raw: Buffer.isBuffer(raw.focusA) ? raw.focusA.toString("utf8") : String(raw.focusA ?? ""),
    screenOn: captured.focusA?.screenOn ?? null,
    keyboardVisible: captured.focusA?.keyboardVisible ?? null,
    rotation: captured.focusA?.rotation ?? null,
  };
  const focusB = {
    raw: Buffer.isBuffer(raw.focusB) ? raw.focusB.toString("utf8") : String(raw.focusB ?? ""),
    screenOn: captured.focusB?.screenOn ?? null,
    keyboardVisible: captured.focusB?.keyboardVisible ?? null,
    rotation: captured.focusB?.rotation ?? null,
  };
  const focusHash = focusStableFieldsHash(focusA, focusB);
  if (!focusHash) fail("M6_FRAME_FOCUS_UNSTABLE", "production frame focus pair is unstable");
  const pageFingerprint = sha256(`xw.page.v1:${canonicalJson({
    package: captured.observation?.package ?? null,
    activity: captured.observation?.activity ?? null,
    width: captured.observation?.width ?? null,
    height: captured.observation?.height ?? null,
    orientation: captured.observation?.orientation ?? null,
    density: captured.observation?.density ?? null,
  })}`);
  const frozen = assembleLiveStrictFrame({
    screenshotABytes: raw.screenshotA,
    screenshotBBytes: raw.screenshotB,
    dumpBytes: raw.dump,
    focusA,
    focusB,
    displayObservation: captured.observation,
    skew: captured.skew,
    nowMs: now(),
    capturedAt: captured.capturedAt,
    evidence: refs,
    linkage: { sessionId: session.sessionId, leaseRef: `lease-${session.leaseId}`, alias: "01", appId: "xiaowei" },
    pageFingerprint,
    focusFingerprint: focusHash,
  });
  if (!frozen.ok || !frozen.frame) fail(frozen.errors?.[0]?.code || "M6_FRAME_INVALID", "strict live frame assembly failed");
  const observationBytes = Buffer.from(canonicalJson(captured.observation), "utf8");
  const manifestCheck = verifyFrameManifest(frozen.frame, (ref) => ({
    [refs.screenshotA.id]: raw.screenshotA,
    [refs.screenshotB.id]: raw.screenshotB,
    [refs.dump.id]: raw.dump,
    [refs.focus.id]: focusBlob,
    [refs.observation.id]: observationBytes,
  })[ref.id] ?? null);
  if (!manifestCheck.ok) fail("M6_FRAME_MANIFEST_INVALID", "strict live frame evidence did not re-verify");
  state.assertM6GateFence(fence);
  const frameId = qualifiedFrameId({ frame: frozen.frame, environmentAttestation, fence, runId, session });
  const frame = Object.freeze({
    ...frozen.frame,
    sourceFrameId: frozen.frame.frameId,
    frameId,
    focusHash,
    environmentAttestationHash: environmentAttestation.attestationHash,
  });
  const evidenceRefs = [...new Map(Object.values(refs).map((entry) => [entry.id, entry.id])).values()];
  return Object.freeze({
    frame,
    frameRef: frameId,
    dumpXml: Buffer.isBuffer(raw.dump) ? raw.dump.toString("utf8") : String(raw.dump ?? ""),
    observation: Object.freeze({ observationId: `obs_${frameId}`, evidenceRefs }),
    observationRaw: Object.freeze({ ...captured.observation }),
    refs: Object.freeze({ ...refs }),
    generation,
  });
}

function privateMaterialFor({ capture, provider, candidateBlockId, manifestStep, scenarioKey }) {
  const selected = candidateBlockId
    ? provider.blockSet?.blocks?.find((block) => block.blockId === candidateBlockId) : null;
  const region = selected ? provider.privateGeometry.get(selected.boundsRef) : null;
  switch (manifestStep.primitive) {
    case "tap":
      if (!selected || !region) fail("M6_TCB_PRIVATE_MATERIAL_INVALID", "tap requires one server-selected private block");
      return Object.freeze({
        point: Object.freeze({ x: Math.round((region.x1 + region.x2) / 2), y: Math.round((region.y1 + region.y2) / 2) }),
        bounds: region,
        boundsRef: selected.boundsRef,
      });
    case "type_search_text": {
      if (!selected || !region) fail("M6_TCB_PRIVATE_MATERIAL_INVALID", "text input requires one server-selected private block");
      const role = manifestStep.actionFamily.startsWith("search:") ? "query"
        : manifestStep.actionFamily.startsWith("text-input:") ? "input"
          : manifestStep.actionFamily.startsWith("form-edit:") ? "form" : null;
      if (!role) fail("M6_TCB_PRIVATE_MATERIAL_INVALID", "text material is outside the frozen canary roles");
      const text = role === "query"
        ? M64_CANARY_SEARCH_QUERY
        : `m6-canary-${scenarioKey}-${role}`;
      const textRef = deriveM6TrustedTextRef(text);
      if (textRef !== manifestStep.trustedParams.textRef) fail("M6_TCB_PRIVATE_MATERIAL_BINDING_MISMATCH", "trusted text ref changed");
      return Object.freeze({ text, textRef, bounds: region, boundsRef: selected.boundsRef });
    }
    case "open_app": {
      const role = manifestStep.actionFamily.split(":").at(-1);
      const app = Object.freeze({ package: ["switch-destination", "open-settings"].includes(role)
        ? "com.android.settings" : "com.xingin.xhs" });
      const appRef = deriveM6TrustedApplicationRef(app);
      if (appRef !== manifestStep.trustedParams.appRef) fail("M6_TCB_PRIVATE_MATERIAL_BINDING_MISMATCH", "trusted app ref changed");
      return Object.freeze({ app, appRef });
    }
    case "scroll": {
      const width = capture.frame.width;
      const height = capture.frame.height;
      const centerX = Math.round(width / 2);
      const lower = Math.round(height * 0.62);
      const upper = Math.round(height * 0.38);
      const down = manifestStep.trustedParams.direction === "down";
      return Object.freeze({
        screen: Object.freeze({ width, height }),
        swipe: Object.freeze({
          from: Object.freeze({ x: centerX, y: down ? lower : upper }),
          to: Object.freeze({ x: centerX, y: down ? upper : lower }),
          durationMs: 220,
        }),
      });
    }
    case "back":
      return Object.freeze({});
    default:
      fail("M6_ACTION_PRIMITIVE_FORBIDDEN", "primitive is outside the exact M6-4 typed action surface");
  }
}

function slotState({ capture, provider, candidateBlockId, slotSpec, environmentAttestation }) {
  return deriveM64DispatchCurrentState({
    capture,
    provider,
    candidateBlockId,
    slotSpecHash: slotSpec.actionSlotSpecHash,
    targetKind: slotSpec.targetKind,
    environmentAttestation,
  });
}

export function createM6LiveProductionCallbacks({
  state,
  capabilities,
  transport,
  evidence,
  environmentAttestation,
  environmentQualification,
  effectBoundary,
  independentOracle,
  targetSelector,
  currentStateGuard,
  createCurrentStateGuard = null,
  evidenceDirectoryRoot,
  auditRoot = null,
  auditStore = null,
  authorityNodeId,
  observeDevice = readObservation,
  captureFrame = null,
  tcbFactory = createM6GroundedTcb,
  now = Date.now,
  monoNow = () => performance.now(),
  captureTimeoutMs = 35_000,
  oracleTimeoutMs = 5_000,
  selectorTimeoutMs = 2_000,
  transportTimeoutMs = 35_000,
} = {}) {
  if (!state || !capabilities || !transport || !evidence || typeof observeDevice !== "function"
    || !independentOracle || typeof independentOracle.loadExpectation !== "function"
    || typeof independentOracle.observe !== "function" || typeof independentOracle.compare !== "function"
    || typeof targetSelector !== "function"
    || (typeof currentStateGuard !== "function" && typeof createCurrentStateGuard !== "function")
    || typeof tcbFactory !== "function" || typeof authorityNodeId !== "string" || authorityNodeId === ""
    || typeof evidenceDirectoryRoot !== "string" || !isAbsolute(evidenceDirectoryRoot)) {
    throw new TypeError("M6 production callbacks require sealed state/capability/device/evidence/oracle/selector/guard dependencies");
  }
  const store = auditStore || new M6LiveAuditStore({ root: auditRoot });
  if (!store || typeof store.commit !== "function") throw new TypeError("M6 production callbacks require a durable audit store");
  for (const [name, value] of Object.entries({
    captureTimeoutMs,
    oracleTimeoutMs,
    selectorTimeoutMs,
    transportTimeoutMs,
  })) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 120_000) throw new TypeError(`${name} must be a bounded positive timeout`);
  }
  const boundaryValidation = validateM64EffectBoundary(effectBoundary);
  if (!boundaryValidation.ok) throw new TypeError(`M6 effect boundary is invalid: ${boundaryValidation.errors.join(",")}`);
  const environment = assertEnvironment({ environmentAttestation, environmentQualification, nowMs: now() });
  const capability = capabilities.require("xiaowei.m6.grounded_run");
  if (capability.id !== "xiaowei.m6.grounded_run" || capability.implementation?.action !== "m6_grounded_run"
    || !HASH.test(capability.capabilityContractHash || "")
    || !HASH.test(capability.implementation?.implementationClosureHash || "")
    || canonicalJson(capability.invocationPolicy?.allowedModes) !== canonicalJson(["composite_action"])) {
    throw new TypeError("M6 grounded-run capability closure is not production sealed");
  }
  verifyM6GroundedRunCapabilitySeal({ capability });

  const runs = new Map();
  const setupPromises = new Map();
  const signalFor = (call) => call?.signal ?? call?.context?.abortSignal ?? null;

  function authorityFor(call) {
    assertEnvironment({
      environmentAttestation: environment,
      environmentQualification,
      nowMs: now(),
    });
    const context = call?.context;
    const scenario = context?.scenario;
    const binding = call?.run?.binding;
    const familyRule = effectBoundary.families.find((entry) => entry.primaryFamily === scenario?.primaryFamily);
    if (!context || !scenario || !binding || binding.alias !== "01" || scenario.alias !== "01"
      || context.manifestHash !== context.manifest?.manifestHash || context.scenarioKey !== scenario.scenarioKey
      || binding.scenarioManifestHash !== context.manifestHash || binding.purpose !== context.manifest?.purpose
      || context.liveAuthorizationHash !== binding.liveWindowAuthorizationHash
      || !validIso(context.liveAuthorizationIssuedAt) || !validIso(context.liveAuthorizationExpiresAt)
      || scenario.effectBoundaryHash !== effectBoundary.boundaryHash || !familyRule
      || scenario.oracleHash !== familyRule.oracleHash || Date.parse(environment.expiresAt) <= now()) {
      fail("M6_LIVE_CALLBACK_AUTHORITY_INVALID", "callback authority changed from the frozen alias-01 scenario/environment");
    }
    return Object.freeze({
      manifestHash: context.manifestHash,
      scenarioKey: context.scenarioKey,
      primaryFamily: scenario.primaryFamily,
      oracleHash: scenario.oracleHash,
      effectBoundaryHash: scenario.effectBoundaryHash,
      environmentAttestationHash: environment.attestationHash,
      accountIsolationHash: environment.accountIsolationHash,
      bindingHash: binding.bindingHash,
      gateEpochHash: binding.gateEpochHash,
      gateGeneration: binding.generation,
      purpose: binding.purpose,
      runId: binding.runId,
      liveAuthorizationHash: binding.liveWindowAuthorizationHash,
      liveAuthorizationIssuedAt: context.liveAuthorizationIssuedAt,
      liveAuthorizationExpiresAt: context.liveAuthorizationExpiresAt,
      familyRule,
    });
  }

  async function initialize(call) {
    const authority = authorityFor(call);
    state.assertM6GateFence(call.fence);
    const compositeAuthority = Object.freeze({
      authorizationConsumptionHash: call.context.authorizationConsumptionHash,
      authorizationId: call.context.authorizationId,
      binding: call.run.binding,
      fence: call.fence,
      scenarioClaimHash: call.context.scenarioClaimHash,
    });
    const consumption = state.getM6LiveWindowAuthorizationConsumption?.(call.context.authorizationId) ?? null;
    const sessionExpiryCeilingMs = Math.min(
      Date.parse(call.fence.expiresAt),
      Date.parse(call.context.liveAuthorizationExpiresAt),
      Date.parse(consumption?.expiresAt),
      Date.parse(environment.expiresAt),
    );
    // Session/lease ownership must never outlive any authority that makes the
    // composite action legal.  Keep a one-second margin because StateStore
    // re-reads its own clock inside the transaction.
    const sessionTtlMs = Math.min(
      15 * 60_000,
      capability.timeoutMs,
      sessionExpiryCeilingMs - now() - 1_000,
    );
    if (consumption?.authorizationId !== call.context.authorizationId
      || consumption?.consumptionHash !== call.context.authorizationConsumptionHash
      || consumption?.expiresAt !== call.context.liveAuthorizationExpiresAt
      || !Number.isSafeInteger(sessionTtlMs) || sessionTtlMs < 1) {
      fail("M6_LIVE_CALLBACK_AUTHORITY_INVALID", "composite session has no remaining bound Gate, authorization, and environment lifetime");
    }
    const expectationInput = await runExternalSeam({
      seam: "oracle-load-expectation",
      signal: call.signal ?? call.context?.abortSignal,
      timeoutMs: oracleTimeoutMs,
    }, (signal) => independentOracle.loadExpectation(Object.freeze({ ...authority, signal })));
    const expectation = assertExpectation(expectationInput, authority, now());
    const listed = state.listDevices().find((device) => device.alias === "01");
    if (!listed) fail("M6_ALIAS_01_UNAVAILABLE", "alias 01 is not registered");
    const device = state.requireDevice(listed.deviceId, { includeRuntime: true, requireReady: true });
    if (device.alias !== "01" || typeof device.runtimeId !== "string" || device.runtimeId === "") {
      fail("M6_ALIAS_01_UNAVAILABLE", "alias 01 has no ready private runtime binding");
    }
    let session;
    let job;
    try {
      session = state.createSession({
        actorId: "agent:m6-production-broker",
        authorityNodeId,
        deviceId: device.deviceId,
        capability,
        canary: true,
        ttlMs: sessionTtlMs,
        invocation: "composite_action",
        m6CompositeAuthority: compositeAuthority,
      });
      const created = state.createJob({
        idempotencyKey: `m6-live:${authority.runId}`,
        operationKey: `m6-live:${authority.runId}`,
        actorId: "agent:m6-production-broker",
        authorityNodeId,
        deviceId: device.deviceId,
        capability,
        params: {
          runPacketRef: authority.bindingHash,
          grantRef: call.context.authorizationConsumptionHash,
          scenarioManifestRef: authority.manifestHash,
        },
        canary: true,
        sessionId: session.sessionId,
        status: "running",
        approvalRequired: false,
        externalEffect: true,
        invocation: "composite_action",
        m6CompositeAuthority: compositeAuthority,
      });
      if (created.reused) fail("M6_LIVE_CAPABILITY_JOB_REPLAY", "grounded-run capability job was unexpectedly reused");
      job = created.job;
      const active = state.validateSession(session.sessionId, session.token);
      if (active.leaseId !== session.leaseId || active.deviceId !== device.deviceId
        || active.scopeCapabilityId !== capability.id || active.canary !== true
        || job.sessionId !== session.sessionId || job.deviceId !== device.deviceId
        || job.capabilityId !== capability.id || job.status !== "running" || job.canary !== true) {
        fail("M6_LIVE_CAPABILITY_BINDING_INVALID", "formal capability job/session/lease binding did not close");
      }
    } catch (error) {
      if (job && !TERMINAL_JOBS.has(state.getJob(job.jobId)?.status)) {
        try { state.transitionJob(job.jobId, "failed", { errorCode: redactError(error).code }); } catch {}
      }
      if (session && state.sessionExists(session.sessionId)) {
        try { state.releaseSession(session.sessionId, session.token); } catch {}
      }
      throw error;
    }
    let tcb;
    try {
      tcb = tcbFactory({
        transport,
        device,
        leaseAuthorization: { deviceId: device.deviceId, leaseId: session.leaseId },
        job,
        evidenceDirectory: join(resolve(evidenceDirectoryRoot), authority.runId.replaceAll(":", "_")),
      });
      if (!tcb || typeof tcb.invokeWrite !== "function") throw new TypeError("M6 grounded TCB factory returned no write boundary");
    } catch (error) {
      if (!TERMINAL_JOBS.has(state.getJob(job.jobId)?.status)) {
        try { state.transitionJob(job.jobId, "failed", { errorCode: redactError(error).code }); } catch {}
      }
      if (state.sessionExists(session.sessionId)) {
        try { state.releaseSession(session.sessionId, session.token); } catch {}
      }
      throw error;
    }
    const runState = {
      authority,
      expectation,
      device,
      session,
      job,
      tcb,
      captureGeneration: 0,
      lastCapture: null,
      ground: null,
      actionReceipts: [],
      typedAuthorizations: [],
      oracleObservations: [],
      auditRefs: [expectation.expectedArtifactHash],
      completion: null,
      resetReceipt: null,
      closeReceipt: null,
      closed: false,
    };
    runs.set(authority.runId, runState);
    return runState;
  }

  async function ensureRun(call) {
    const id = call?.run?.binding?.runId;
    if (runs.has(id)) return runs.get(id);
    if (!setupPromises.has(id)) {
      const promise = initialize(call).finally(() => setupPromises.delete(id));
      setupPromises.set(id, promise);
    }
    return setupPromises.get(id);
  }

  async function capture(runState, call, { commitAsLatest = true } = {}) {
    runState.captureGeneration += 1;
    const input = {
      state,
      transport,
      evidence,
      device: runState.device,
      session: runState.session,
      environmentAttestation: environment,
      fence: call.fence,
      runId: runState.job.runId,
      observeDevice,
      now,
      generation: runState.captureGeneration,
      signal: call.signal ?? call.context?.abortSignal,
      timeoutMs: captureTimeoutMs,
    };
    const value = captureFrame
      ? await runExternalSeam({
          seam: "capture-frame",
          signal: input.signal,
          timeoutMs: captureTimeoutMs,
        }, (signal) => captureFrame({ ...input, signal }))
      : await captureQualifiedFrame(input);
    if (!value || !HASH.test(value.frameRef || "") || value.frame?.frameId !== value.frameRef
      || value.frame.environmentAttestationHash !== environment.attestationHash
      || typeof value.dumpXml !== "string" || !value.observation?.observationId) {
      fail("M6_LIVE_CAPTURE_INVALID", "qualified in-session frame capture is invalid");
    }
    if (commitAsLatest) runState.lastCapture = value;
    return value;
  }

  async function observeOracle(runState, phase, signal = null) {
    const value = await runExternalSeam({
      seam: `oracle-observe-${phase}`,
      signal,
      timeoutMs: oracleTimeoutMs,
    }, (signal) => independentOracle.observe(Object.freeze({
      phase,
      manifestHash: runState.authority.manifestHash,
      scenarioKey: runState.authority.scenarioKey,
      primaryFamily: runState.authority.primaryFamily,
      oracleHash: runState.authority.oracleHash,
      effectBoundaryHash: runState.authority.effectBoundaryHash,
      environmentAttestationHash: runState.authority.environmentAttestationHash,
      accountIsolationHash: runState.authority.accountIsolationHash,
      expectedArtifactHash: runState.expectation.expectedArtifactHash,
      independentAuthorHash: runState.expectation.independentAuthorHash,
      signal,
    })));
    const checked = assertIndependentObservation(value, {
      authority: runState.authority,
      expectation: runState.expectation,
      phase,
      nowMs: now(),
    });
    runState.oracleObservations.push(checked);
    runState.auditRefs.push(checked.observationHash);
    return checked;
  }

  function baseBindings(runState, call, slotSpec) {
    return Object.freeze({
      runId: runState.job.runId,
      sessionId: runState.session.sessionId,
      leaseId: runState.session.leaseId,
      gateEpochHash: call.fence.epochHash,
      gateGeneration: call.fence.generation,
      grantHash: call.context.authorizationConsumptionHash,
      stepId: slotSpec.logicalStepId,
      environmentAttestationHash: environment.attestationHash,
    });
  }

  function expandedBindings(runState, bindings, slotSpec) {
    return Object.freeze({
      ...bindings,
      jobId: runState.job.jobId,
      deviceId: runState.device.deviceId,
      capabilityId: capability.id,
      capabilityContractHash: capability.capabilityContractHash,
      implementationClosureHash: capability.implementation.implementationClosureHash,
      sessionScopeCapabilityId: capability.id,
      canary: true,
      alias: "01",
      actionSlotSpecHash: slotSpec.actionSlotSpecHash,
      logicalStepId: slotSpec.logicalStepId,
      actionSlotOrdinal: slotSpec.actionSlotOrdinal,
      primitive: slotSpec.primitive,
      targetKind: slotSpec.targetKind,
      trustedParameterHash: slotSpec.trustedParameterHash,
      effectBoundaryHash: slotSpec.effectBoundaryHash,
      resetPolicyHash: slotSpec.resetPolicyHash,
      oracleHash: slotSpec.oracleHash,
    });
  }

  async function observe(call) {
    assertSignalActive(signalFor(call), "observe");
    const runState = await ensureRun(call);
    const value = await capture(runState, call);
    if (runState.oracleObservations.length === 0) await observeOracle(runState, "before", signalFor(call));
    return Object.freeze({ externalEffect: false, actionCount: 0, frameRef: value.frameRef });
  }

  async function ground(call) {
    assertSignalActive(signalFor(call), "ground");
    const runState = await ensureRun(call);
    if (runState.ground) fail("M6_LIVE_GROUNDING_REPLAY", "one unconsumed grounded decision already owns the current slot");
    if (!runState.lastCapture || call.params.frameRef !== runState.lastCapture.frameRef) {
      fail("M6_LIVE_FRAME_REF_MISMATCH", "grounding did not bind the latest qualified frame");
    }
    if (!call.slotAuthority || ZERO_ACTION_PURPOSES.has(runState.authority.purpose)) {
      return Object.freeze({
        externalEffect: false,
        actionCount: 0,
        disposition: "HARD_STOP",
        reasonRef: reasonRef("M6_LIVE_ZERO_ACTION_PURPOSE"),
      });
    }
    if (HARD_FORBIDDEN_ACTION.test(`${call.slotAuthority.primitive}:${call.slotAuthority.actionFamily}`)) {
      return Object.freeze({
        externalEffect: false,
        actionCount: 0,
        disposition: "HARD_STOP",
        reasonRef: reasonRef("M6_LIVE_HARD_FORBIDDEN_ACTION"),
      });
    }
    const slotSpec = materializeM64ActionSlotSpec({
      manifest: call.context.manifest,
      scenario: call.context.scenario,
      slotAuthority: call.slotAuthority,
    });
    const identity = deriveM6LogicalActionIdentity({ planHash: call.run.actionPlan.actionPlanHash, actionSlotSpec: slotSpec });
    const captureValue = runState.lastCapture;
    const provider = deriveLiveVisualBlockSet({
      frame: captureValue.frame,
      dumpXml: captureValue.dumpXml,
      environmentAttestation: environment,
    });
    if (!provider.blockSet) {
      runState.ground = null;
      return Object.freeze({
        externalEffect: false,
        actionCount: 0,
        disposition: provider.disposition,
        reasonRef: reasonRef(provider.reason || "M6_LIVE_NO_SAFE_BLOCKS"),
      });
    }
    let candidateBlockId = null;
    if (slotSpec.targetKind === "block") {
      candidateBlockId = await runExternalSeam({
        seam: "target-selector",
        signal: signalFor(call),
        timeoutMs: selectorTimeoutMs,
      }, (signal) => targetSelector(Object.freeze({
        scenarioKey: runState.authority.scenarioKey,
        slotAuthority: call.slotAuthority,
        candidateBlockId: call.params.candidateBlockId ?? null,
        blockSet: provider.blockSet,
        dumpXml: captureValue.dumpXml,
        signal,
      })));
      if (!HASH.test(candidateBlockId || "") || !provider.blockSet.blocks.some((entry) => entry.blockId === candidateBlockId)
        || (call.params.candidateBlockId !== undefined && call.params.candidateBlockId !== candidateBlockId)) {
        runState.ground = null;
        return Object.freeze({
          externalEffect: false,
          actionCount: 0,
          disposition: "REPLAN",
          reasonRef: reasonRef("M6_LIVE_TARGET_SELECTOR_MISMATCH"),
        });
      }
    }
    const stateSlot = slotState({
      capture: captureValue,
      provider,
      candidateBlockId,
      slotSpec,
      environmentAttestation: environment,
    });
    const bindings = baseBindings(runState, call, slotSpec);
    const authorityBindings = expandedBindings(runState, bindings, slotSpec);
    const intent = Object.freeze({
      operationKey: identity.operationKey,
      operation: slotSpec.primitive,
      targetKind: slotSpec.targetKind,
      intentRef: slotSpec.intentRef,
    });
    const decision = decideLiveGrounding({
      frame: captureValue.frame,
      blockSet: provider.blockSet,
      intent,
      candidateBlockId,
      bindings: authorityBindings,
    });
    if (decision.disposition !== "ALLOW_ONCE") {
      runState.ground = null;
      return Object.freeze({
        externalEffect: false,
        actionCount: 0,
        disposition: decision.disposition,
        reasonRef: reasonRef(`M6_LIVE_DECISION_${decision.disposition}`),
      });
    }
    const beforeOracle = await observeOracle(runState, "before", signalFor(call));
    assertSignalActive(signalFor(call), "ground-authorize");
    const issuedAtMs = now();
    const typedAuthorization = state.issueTransportActionAuthorization({
      kind: "capability_job",
      purpose: "execute",
      jobId: runState.job.jobId,
      runId: runState.job.runId,
      leaseId: runState.session.leaseId,
      deviceId: runState.device.deviceId,
      operationKey: identity.operationKey,
      capabilityContractHash: capability.capabilityContractHash,
      implementationClosureHash: capability.implementation.implementationClosureHash,
      jobStatus: "running",
      source: "m6-parent-broker",
      ttlMs: 5_000,
      now: () => issuedAtMs,
    });
    runState.typedAuthorizations.push(typedAuthorization);
    runState.ground = Object.freeze({
      slotSpec,
      identity,
      intent,
      candidateBlockId,
      provider,
      stateSlot,
      bindings,
      decision,
      beforeOracle,
      typedAuthorization,
      issuedAtMs,
      expiresAtMs: issuedAtMs + 5_000,
      dispatchDeadlineMonoMs: monoNow() + 4_000,
    });
    return Object.freeze({
      externalEffect: false,
      actionCount: 0,
      disposition: "ALLOW_ONCE",
      decisionRef: decision.decisionRef,
      operationKey: decision.operationKey,
    });
  }

  function facadeFor(runState, call) {
    const active = runState.ground;
    const actionCurrentStateGuard = currentStateGuard ?? createCurrentStateGuard({
      readFreshCapture: createM64ServerOwnedFreshCaptureReader({
        captureFreshFrame: async (input) => {
          const fresh = await capture(runState, call, { commitAsLatest: false });
          return Object.freeze({
            schemaId: M64_CONTROL_PLANE_FRESH_FRAME_SCHEMA_ID,
            sourceClass: M64_FRESH_CAPTURE_SOURCE_CLASS,
            sourceKind: M64_FRESH_CAPTURE_SOURCE_KIND,
            runRef: input.runRef,
            requestFrameRef: input.requestFrameRef,
            environmentAttestationHash: input.environmentAttestationHash,
            capturedAt: fresh.frame.capturedAt,
            frameRef: fresh.frameRef,
            frame: fresh.frame,
            dumpXml: fresh.dumpXml,
            observationRaw: fresh.observationRaw,
            refs: fresh.refs,
            slotContext: Object.freeze({
              scenarioKey: runState.authority.scenarioKey,
              slotAuthority: call.slotAuthority,
              slotSpecHash: active.slotSpec.actionSlotSpecHash,
              targetKind: active.slotSpec.targetKind,
            }),
          });
        },
        selectFreshTarget: ({ scenarioKey, slotAuthority, blockSet, signal }) => targetSelector(Object.freeze({
          scenarioKey,
          slotAuthority,
          blockSet,
          signal,
        })),
        evidenceStore: evidence,
        environmentAttestation: environment,
        now,
        maxCaptureAgeMs: createCurrentStateGuard.maxCaptureAgeMs ?? 250,
      }),
    });
    const typedTransport = createM6TypedTransport({
      invokeWrite: (binding, invocation, material) => runExternalSeam({
        seam: "tcb-transport-write",
        signal: signalFor(call),
        timeoutMs: transportTimeoutMs,
      }, (signal) => runState.tcb.invokeWrite(binding, invocation, material, { signal })),
    });
    return createM6GroundedActionFacade({
      state,
      typedTransport,
      async captureWithinRun({ phase }) {
        if (phase === "before") return runState.lastCapture;
        const after = await capture(runState, call);
        runState.afterOracle = await observeOracle(runState, "after", signalFor(call));
        return after;
      },
      async readCurrentState() {
        const value = await runExternalSeam({
          seam: "current-state-guard",
          signal: signalFor(call),
          // This seam performs a real live-strict capture. Its wall-clock
          // budget is the capture budget; the 250ms send guard starts only
          // after the verified fresh state returns inside the TCB facade.
          timeoutMs: captureTimeoutMs,
        }, (signal) => actionCurrentStateGuard(Object.freeze({
          runRef: runState.authority.runId,
          expectedState: active.stateSlot,
          frameRef: runState.lastCapture.frameRef,
          environmentAttestationHash: environment.attestationHash,
          signal,
        })));
        return value;
      },
      async materializePrivate() {
        assertSignalActive(signalFor(call), "private-material");
        return privateMaterialFor({
          capture: runState.lastCapture,
          provider: active.provider,
          candidateBlockId: active.candidateBlockId,
          manifestStep: call.actionSlotResolution.manifestStep,
          scenarioKey: runState.authority.scenarioKey,
        });
      },
      async verifyAfter() {
        const after = runState.afterOracle;
        const matchInput = await runExternalSeam({
          seam: "oracle-compare",
          signal: signalFor(call),
          timeoutMs: oracleTimeoutMs,
        }, (signal) => independentOracle.compare(Object.freeze({
          expectedStateHash: runState.expectation.expectedStateHash,
          expectedArtifactHash: runState.expectation.expectedArtifactHash,
          independentAuthorHash: runState.expectation.independentAuthorHash,
          beforeObservationHash: active.beforeOracle.observationHash,
          afterObservationHash: after.observationHash,
          slotAuthorityHash: call.slotAuthority.slotAuthorityHash,
          signal,
        })));
        const match = assertOracleMatch(matchInput, {
          expectation: runState.expectation,
          before: active.beforeOracle,
          after,
          slotAuthority: call.slotAuthority,
        });
        const actionBoundary = verifyM64EffectObservation({
          boundary: effectBoundary,
          family: runState.authority.primaryFamily,
          oracle: { selfDerived: false, oracleHash: runState.authority.oracleHash, stale: false },
          observedEffects: after.observedEffects,
          resetResults: after.resetResults,
        });
        if (!actionBoundary.ok) fail("M6_ORACLE_FORBIDDEN_EFFECT", "independent oracle observed an out-of-bound effect");
        const receipt = store.commit("action-oracle", {
          scenarioKey: runState.authority.scenarioKey,
          slotAuthorityHash: call.slotAuthority.slotAuthorityHash,
          expectationHash: runState.expectation.expectedArtifactHash,
          beforeObservationHash: active.beforeOracle.observationHash,
          afterObservationHash: after.observationHash,
          matchHash: match.matchHash,
        });
        runState.auditRefs.push(receipt.artifactHash);
        runState.lastVerification = Object.freeze({
          ok: true,
          stateChanged: active.beforeOracle.actualStateHash !== after.actualStateHash,
          oracleMatchHash: match.matchHash,
          oracleObservationHash: after.observationHash,
          verificationRef: receipt.artifactHash,
        });
        return runState.lastVerification;
      },
      monoNow,
    });
  }

  async function act(call) {
    assertSignalActive(signalFor(call), "act");
    const runState = await ensureRun(call);
    const active = runState.ground;
    if (!active || call.params.decisionRef !== active.decision.decisionRef
      || call.params.operationKey !== active.identity.operationKey
      || call.actionSlotResolution?.actionSlotSpec?.actionSlotSpecHash !== active.slotSpec.actionSlotSpecHash) {
      fail("M6_LIVE_DECISION_REF_MISMATCH", "act did not consume the exact server-owned frozen decision");
    }
    state.assertM6GateFence(call.fence);
    const facade = facadeFor(runState, call);
    try {
      const executed = await facade.execute({
        session: runState.session,
        environmentAttestation: environment,
        intent: active.intent,
        candidateBlockId: active.candidateBlockId,
        bindings: active.bindings,
        slot: active.stateSlot,
        actionSlotSpec: active.slotSpec,
        planHash: call.run.actionPlan.actionPlanHash,
        timing: {
          issuedAtMs: active.issuedAtMs,
          expiresAtMs: active.expiresAtMs,
          dispatchDeadlineMonoMs: active.dispatchDeadlineMonoMs,
        },
        fence: call.fence,
        manifestStep: call.actionSlotResolution.manifestStep,
        typedAuthorization: active.typedAuthorization,
      });
      if (executed.actionCount !== 1 || executed.effectStatus !== "VERIFIED" || !runState.lastVerification?.verificationRef) {
        fail("M6_LIVE_ACTION_RESULT_INVALID", "grounded facade did not close exactly one verified transport");
      }
      const actionReceipt = store.commit("grounded-action", {
        scenarioKey: runState.authority.scenarioKey,
        jobId: runState.job.jobId,
        actionId: executed.actionId,
        operationKey: active.identity.operationKey,
        decisionRef: active.decision.decisionRef,
        slotAuthorityHash: call.slotAuthority.slotAuthorityHash,
        verificationRef: runState.lastVerification.verificationRef,
        transportCount: 1,
      });
      const record = Object.freeze({
        actionId: executed.actionId,
        actionReceiptRef: actionReceipt.artifactHash,
        verificationRef: runState.lastVerification.verificationRef,
        verified: true,
      });
      runState.actionReceipts.push(record);
      runState.auditRefs.push(actionReceipt.artifactHash);
      runState.ground = null;
      return Object.freeze({
        externalEffect: true,
        actionCount: 1,
        effectStatus: "VERIFIED",
        actionReceiptRef: record.actionReceiptRef,
        verificationRef: record.verificationRef,
      });
    } catch (error) {
      const ledgers = state.listM6ActionLedgersForRun(runState.job.runId);
      const sent = ledgers.findLast((ledger) => ledger.operationKey === active.identity.operationKey && ledger.transportCounter === 1);
      runState.ground = null;
      if (!sent) throw error;
      const failure = redactError(error);
      const actionReceipt = store.commit("grounded-action-ambiguous", {
        scenarioKey: runState.authority.scenarioKey,
        actionId: sent.actionId,
        operationKey: sent.operationKey,
        status: sent.status,
        transportCount: 1,
        errorHash: failure.errorHash,
      });
      const record = Object.freeze({
        actionId: sent.actionId,
        actionReceiptRef: actionReceipt.artifactHash,
        verificationRef: failure.errorHash,
        verified: false,
      });
      runState.actionReceipts.push(record);
      runState.auditRefs.push(actionReceipt.artifactHash);
      return Object.freeze({
        externalEffect: true,
        actionCount: 1,
        effectStatus: "SENT_UNVERIFIED",
        actionReceiptRef: record.actionReceiptRef,
        errorRef: failure.errorHash,
      });
    }
  }

  async function verify(call) {
    assertSignalActive(signalFor(call), "verify");
    const runState = await ensureRun(call);
    const record = runState.actionReceipts.findLast((entry) => entry.actionReceiptRef === call.params.actionReceiptRef);
    if (!record) fail("M6_LIVE_ACTION_REF_MISMATCH", "verification did not bind the current server action receipt");
    const expectationMatches = call.params.expectationRef === runState.expectation.expectedArtifactHash
      || call.params.expectationRef === record.verificationRef;
    if (!expectationMatches) fail("M6_LIVE_EXPECTATION_REF_MISMATCH", "verification expectation ref changed");
    return Object.freeze({
      externalEffect: false,
      actionCount: 0,
      verified: record.verified,
      verificationRef: record.verificationRef,
    });
  }

  async function checkpointAudit(call) {
    assertSignalActive(signalFor(call), "checkpoint-audit");
    const runState = await ensureRun(call);
    const ledgers = state.listM6ActionLedgersForRun(runState.job.runId);
    const artifact = store.commit("checkpoint", {
      runId: runState.authority.runId,
      scenarioKey: runState.authority.scenarioKey,
      stateRefs: [...call.params.stateRefs],
      actionRefs: runState.actionReceipts.map((entry) => entry.actionReceiptRef),
      ledgerHashes: ledgers.map((ledger) => hashPayload("xw.m6-ledger-snapshot.v1", ledger)),
      environmentAttestationHash: environment.attestationHash,
    });
    runState.auditRefs.push(artifact.artifactHash);
    return Object.freeze({ externalEffect: false, actionCount: 0, checkpointRef: artifact.artifactHash });
  }

  async function trace(call) {
    assertSignalActive(signalFor(call), "trace");
    const runState = await ensureRun(call);
    const traceArtifact = store.commit("trace-index", {
      runId: runState.authority.runId,
      requestedTraceRef: call.params.traceRef,
      auditRefs: [...new Set(runState.auditRefs)],
    });
    runState.auditRefs.push(traceArtifact.artifactHash);
    return Object.freeze({
      externalEffect: false,
      actionCount: 0,
      traceRefs: [...new Set([traceArtifact.artifactHash, ...runState.auditRefs])],
    });
  }

  async function waitHuman(call) {
    assertSignalActive(signalFor(call), "wait-human");
    const runState = await ensureRun(call);
    const artifact = store.commit("wait-human", {
      runId: runState.authority.runId,
      reasonRef: call.params.reasonRef,
      evidenceRefs: [...call.params.evidenceRefs],
      status: "WAITING",
    });
    runState.auditRefs.push(artifact.artifactHash);
    return Object.freeze({ externalEffect: false, actionCount: 0, status: "WAITING" });
  }

  async function complete(call) {
    assertSignalActive(signalFor(call), "complete");
    const runState = await ensureRun(call);
    const finalObservation = await observeOracle(runState, "final", signalFor(call));
    const boundary = verifyM64EffectObservation({
      boundary: effectBoundary,
      family: runState.authority.primaryFamily,
      oracle: { selfDerived: false, oracleHash: runState.authority.oracleHash, stale: false },
      observedEffects: finalObservation.observedEffects,
      resetResults: finalObservation.resetResults,
    });
    const resetArtifact = store.commit("reset-receipt", {
      scenarioKey: runState.authority.scenarioKey,
      oracleObservationHash: finalObservation.observationHash,
      obligations: [...runState.authority.familyRule.resetObligations],
      results: finalObservation.resetResults,
      verified: boundary.ok,
      errors: boundary.errors,
    });
    runState.resetReceipt = resetArtifact;
    runState.auditRefs.push(resetArtifact.artifactHash);
    const succeeded = call.params.outcome === "SUCCEEDED" && boundary.ok
      && runState.actionReceipts.every((entry) => entry.verified);
    if (!TERMINAL_JOBS.has(state.getJob(runState.job.jobId)?.status)) {
      terminalizeJob(state, runState.job.jobId, {
        succeeded,
        ...(succeeded ? {} : { errorCode: "M6_LIVE_ORACLE_OR_WORKER_FAILED" }),
        result: { status: succeeded ? "COMPLETED" : "FAILED", resetReceiptHash: resetArtifact.artifactHash },
      });
    }
    runState.completion = Object.freeze({ succeeded, status: succeeded ? "COMPLETED" : "FAILED" });
    return Object.freeze({
      externalEffect: false,
      actionCount: 0,
      workerRunRef: call.run.workerRunRef,
      status: runState.completion.status,
    });
  }

  async function close({ run, context, reason }) {
    const runId = run?.binding?.runId;
    let runState = runs.get(runId);
    if (!runState && setupPromises.has(runId)) {
      try { runState = await setupPromises.get(runId); } catch {}
    }
    if (runState?.closeReceipt) return runState.closeReceipt;
    const closeAuthority = runState?.authority || Object.freeze({
      runId,
      scenarioKey: context?.scenarioKey,
      purpose: run?.binding?.purpose,
    });
    if (runState) {
      const closeReasonCode = `M6_LIVE_CLOSE_${String(reason || "UNKNOWN").replaceAll(/[^A-Z0-9_]/giu, "_").toUpperCase()}`;
      state.closeM6GroundedRunActions({
        runId: runState.job.runId,
        sessionId: runState.session.sessionId,
        reasonCode: closeReasonCode,
      });
      for (const issued of runState.typedAuthorizations) {
        const stored = state.getTransportActionAuthorization(issued.authorization.authorizationId);
        if (!stored?.consumedAt && Date.parse(stored?.expiresAt || 0) > now()) {
          state.consumeTransportActionAuthorization({
            authorizationId: issued.authorization.authorizationId,
            token: issued.token,
            expectedPurpose: "execute",
            expectedDeviceId: runState.device.deviceId,
            expectedLeaseId: runState.session.leaseId,
          });
        }
      }
      const currentJob = state.getJob(runState.job.jobId);
      if (currentJob && !TERMINAL_JOBS.has(currentJob.status)) {
        terminalizeJob(state, currentJob.jobId, {
          succeeded: false,
          errorCode: closeReasonCode,
        });
      }
      if (state.sessionExists(runState.session.sessionId)) {
        state.releaseSession(runState.session.sessionId, runState.session.token);
      }
      if (state.sessionExists(runState.session.sessionId) || state.leaseExists(runState.session.leaseId)
        || !TERMINAL_JOBS.has(state.getJob(runState.job.jobId)?.status)
        || state.listM6ActionLedgersForRun(runState.job.runId).some((ledger) => !["COMPLETED", "BLOCKED", "AMBIGUOUS"].includes(ledger.status))
        || runState.typedAuthorizations.some((issued) => {
          const stored = state.getTransportActionAuthorization(issued.authorization.authorizationId);
          return !stored?.consumedAt && Date.parse(stored?.expiresAt || 0) > now();
        })) {
        fail("M6_LIVE_RUN_CLOSE_UNVERIFIED", "formal capability job/session/lease did not converge to zero");
      }
    }
    const ledgers = runState ? state.listM6ActionLedgersForRun(runState.job.runId) : [];
    const transportCount = ledgers.reduce((sum, ledger) => sum + ledger.transportCounter, 0);
    const actionCount = transportCount;
    let outcome = closeAuthority.purpose === "M6_4_HOT_CLOSE"
      ? "ABORTED_PENDING_CLOSEOUT"
      : runState?.completion?.succeeded === true ? "SUCCEEDED" : "FAILED";
    let richAttemptEvidence = null;
    let attemptAuditHash = null;
    let oracleObservationHash = null;
    let resetReceiptHash = null;
    let evidenceFailure = null;
    let evidenceErrorHash = null;
    if (runState) {
      try {
        let finalObservation = runState.oracleObservations.findLast((observation) => observation.phase === "final");
        if (!finalObservation) finalObservation = await observeOracle(runState, "final", null);
        const boundary = verifyM64EffectObservation({
          boundary: effectBoundary,
          family: runState.authority.primaryFamily,
          oracle: { selfDerived: false, oracleHash: runState.authority.oracleHash, stale: false },
          observedEffects: finalObservation.observedEffects,
          resetResults: finalObservation.resetResults,
        });
        if (!boundary.ok) fail("M6_ORACLE_FORBIDDEN_EFFECT", "final independent oracle evidence did not close the effect boundary");
        if (!runState.resetReceipt) {
          runState.resetReceipt = store.commit("reset-receipt", {
            scenarioKey: runState.authority.scenarioKey,
            oracleObservationHash: finalObservation.observationHash,
            obligations: [...runState.authority.familyRule.resetObligations],
            results: finalObservation.resetResults,
            verified: true,
            errors: [],
          });
          runState.auditRefs.push(runState.resetReceipt.artifactHash);
        }
        if (runState.actionReceipts.length !== transportCount
          || runState.actionReceipts.some((receipt) => !HASH.test(receipt.actionReceiptRef || ""))) {
          fail("M6_LIVE_ATTEMPT_ACTION_CHAIN_INVALID", "the closed action ledger did not match its durable action receipts");
        }
        const actionEvidence = deriveM64ActionEvidence({
          schemaId: M64_LIVE_ACTION_EVIDENCE_SCHEMA_ID,
          actionCount,
          transportCount,
          verifiedActionCount: runState.actionReceipts.filter((receipt) => receipt.verified).length,
          actionTraceHashes: runState.actionReceipts.map((receipt) => receipt.actionReceiptRef),
        });
        const runStatusBeforeClose = run.status === "OPEN" ? "BROKER_READY" : run.status;
        richAttemptEvidence = deriveM64AttemptEvidence({
          schemaId: M64_LIVE_ATTEMPT_EVIDENCE_SCHEMA_ID,
          purpose: runState.authority.purpose,
          manifestHash: runState.authority.manifestHash,
          scenarioKey: runState.authority.scenarioKey,
          liveAuthorizationHash: runState.authority.liveAuthorizationHash,
          gateEpochHash: runState.authority.gateEpochHash,
          bindingHash: runState.authority.bindingHash,
          runId: runState.authority.runId,
          runStatusBeforeClose,
          status: outcome,
          expectedArtifactHash: runState.expectation.expectedArtifactHash,
          actionEvidence,
          oracleEvidence: finalObservation,
        });
        const attemptArtifact = store.commit("scenario-attempt", richAttemptEvidence);
        attemptAuditHash = attemptArtifact.artifactHash;
        oracleObservationHash = finalObservation.observationHash;
        resetReceiptHash = runState.resetReceipt.artifactHash;
      } catch (error) {
        evidenceFailure = error;
      }
    }
    if (!richAttemptEvidence) {
      if (closeAuthority.purpose !== "M6_4_HOT_CLOSE") outcome = "FAILED";
      const failure = redactError(evidenceFailure);
      evidenceErrorHash = failure.errorHash;
      attemptAuditHash = store.commit("scenario-attempt-unavailable", {
        runId,
        scenarioKey: closeAuthority.scenarioKey,
        reason,
        status: "UNAVAILABLE",
        errorHash: failure.errorHash,
      }).artifactHash;
      oracleObservationHash = store.commit("oracle-unavailable", {
        runId,
        scenarioKey: closeAuthority.scenarioKey,
        reason,
        status: "UNAVAILABLE",
        errorHash: failure.errorHash,
      }).artifactHash;
      resetReceiptHash = store.commit("reset-unavailable", {
        runId,
        scenarioKey: closeAuthority.scenarioKey,
        reason,
        status: "UNAVAILABLE",
        errorHash: failure.errorHash,
      }).artifactHash;
    }
    const closeEvidence = store.commit("scenario-close", {
      runId,
      scenarioKey: closeAuthority.scenarioKey,
      outcome,
      reason,
      actionCount,
      transportCount,
      sessionCount: 0,
      leaseCount: 0,
      activeJobCount: 0,
    });
    let finalized = null;
    if (context?.scenarioClaimHash) {
      finalized = state.finalizeM64LiveScenarioClaim({
        claimHash: context.scenarioClaimHash,
        outcome,
        actionCount,
        transportCount,
        attemptEvidenceHash: richAttemptEvidence?.attemptHash ?? attemptAuditHash,
        oracleObservationHash,
        resetReceiptHash,
        closeReceiptHash: closeEvidence.artifactHash,
      });
    }
    const receipt = Object.freeze({
      schemaId: "xw.m6-live-production-callback-close.v1",
      runId,
      outcome,
      actionCount,
      transportCount,
      attemptEvidence: richAttemptEvidence,
      attemptEvidenceHash: richAttemptEvidence?.attemptHash ?? null,
      attemptAuditHash,
      evidenceVerified: richAttemptEvidence !== null,
      evidenceErrorHash,
      oracleObservationHash,
      resetReceiptHash,
      closeReceiptHash: closeEvidence.artifactHash,
      scenarioResultHash: finalized?.result?.resultHash ?? null,
      sessionCount: 0,
      leaseCount: 0,
      activeJobCount: 0,
      verifiedClosed: true,
    });
    if (runState) {
      runState.closed = true;
      runState.closeReceipt = receipt;
    }
    return receipt;
  }

  return Object.freeze({ observe, ground, act, verify, checkpointAudit, trace, waitHuman, complete, close });
}
