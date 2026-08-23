import { createHash, timingSafeEqual } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import {
  resolveM64CohortActionSlot,
  validateM64CohortManifest,
} from "../../../../packages/kernel/lib/m6-4-cohort.mjs";
import {
  cloneM64PublicAttemptEvidence,
} from "../../../../packages/kernel/lib/m6-live-evidence.mjs";
import { createM6LivePipeBinding } from "../../../../integrations/dsh-xw/src/live-pipe-client.mjs";
import {
  M6LiveProcessAdapter,
  sealedM6LiveChildSpec,
  validateM6LiveDependencyEnvironment,
  validateM6LiveCredentialEnvironment,
  validateM6LiveLaunchQualification,
  validateM6LiveRuntimeEnvironment,
} from "../../../../integrations/dsh-xw/src/live-process-adapter.mjs";
import { verifyM6LiveRuntimeDependencyLayer } from "../../../../integrations/dsh-xw/src/live-runtime-dependency-layer.mjs";
import { loadContentAddressedLiveModelProfile } from "../../../../integrations/dsh-xw/src/live-model-profile.mjs";
import { canonicalJson } from "./canonical.mjs";
import { ControlPlaneError } from "./errors.mjs";
import { assertM6FileDbPointerConsistency } from "./m6-gate-promoter.mjs";
import { createM6GroundedActionRunManager } from "./m6-grounded-action-run-manager.mjs";
import { loadM6Gate } from "./m6-gate-loader.mjs";
import { createM6LiveBrokerHandler } from "./m6-live-broker.mjs";
import {
  loadM64LiveWindowIssuerAllowlist,
  verifyM64LiveWindowAuthorization,
} from "./m6-live-window-authorization.mjs";

const HASH = /^[0-9a-f]{64}$/u;
const MANIFEST_REF = /^[a-z0-9][a-z0-9._:-]{2,127}$/u;
const RUN_REF = /^[a-z0-9][a-z0-9:_-]{7,127}$/u;
const LIVE_PURPOSES = Object.freeze(new Set([
  "M6_4_SHADOW", "M6_4_HOT_CLOSE", "M6_4_ACTION_SMOKE", "M6_4_RELIABILITY", "M6_4_SMOOTH",
]));
const CALLBACK_NAMES = Object.freeze([
  "observe", "ground", "act", "verify", "checkpointAudit", "trace",
  "waitHuman", "complete", "close",
]);
const REQUEST_KEYS = Object.freeze([
  "authorization", "authorizationHash", "authorizationId", "manifestHash", "manifestRef", "scenarioKey",
]);
const CLOSE_KEYS = Object.freeze(["reasonCode", "runId"]);
const EPOCH_RECOVERY_KEYS = Object.freeze(["gateEpochHash", "purpose"]);
const CLOSE_REASONS = Object.freeze(new Set([
  "BROKER_FAILURE", "CANARY_COMPLETE", "OPERATOR_STOP", "SAFETY_STOP", "SHUTDOWN", "START_FAILED",
]));

function fail(code, message, { status = 409, details = {}, cause } = {}) {
  throw new ControlPlaneError(code, message, { status, details, cause });
}

function exactObject(value, keys, code, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) {
    fail(code, `${label} must contain exactly ${keys.join(", ")}`, { status: 400, details: { resourceCount: 0 } });
  }
  return value;
}

function readJsonFile(path, label) {
  if (typeof path !== "string" || !isAbsolute(path)) {
    fail("M6_LIVE_ENTRY_CONFIG_INVALID", `${label} must be an absolute sealed JSON path`, { status: 503 });
  }
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      fail("M6_LIVE_ENTRY_CONFIG_INVALID", `${label} must be one plain JSON file`, { status: 503 });
    }
    return JSON.parse(readFileSync(realpathSync(path), "utf8"));
  } catch (error) {
    if (error instanceof ControlPlaneError) throw error;
    fail("M6_LIVE_ENTRY_CONFIG_INVALID", `${label} is unavailable or malformed`, { status: 503, cause: error });
  }
}

function defaultManifestLoader(manifestRef, config) {
  if (typeof config.manifestRoot !== "string" || !isAbsolute(config.manifestRoot)) {
    fail("M6_LIVE_ENTRY_CONFIG_INVALID", "manifestRoot must be an absolute sealed directory", { status: 503 });
  }
  try {
    const rootStat = lstatSync(config.manifestRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      fail("M6_LIVE_ENTRY_CONFIG_INVALID", "manifestRoot must be one plain sealed directory", { status: 503 });
    }
    const root = realpathSync(config.manifestRoot);
    const target = resolve(root, `${manifestRef}.json`);
    const rel = relative(root, target);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
      fail("M6_LIVE_ENTRY_MANIFEST_REF_INVALID", "manifestRef escapes the sealed manifest root", { status: 400 });
    }
    const targetStat = lstatSync(target);
    if (targetStat.isSymbolicLink() || !targetStat.isFile()) {
      fail("M6_LIVE_ENTRY_MANIFEST_REF_INVALID", "manifestRef must resolve to one plain JSON file", { status: 400 });
    }
    const realTarget = realpathSync(target);
    const realRel = relative(root, realTarget);
    if (!realRel || realRel.startsWith("..") || isAbsolute(realRel)) {
      fail("M6_LIVE_ENTRY_MANIFEST_REF_INVALID", "manifestRef real path escapes the sealed manifest root", { status: 400 });
    }
    return JSON.parse(readFileSync(realTarget, "utf8"));
  } catch (error) {
    if (error instanceof ControlPlaneError) throw error;
    fail("M6_LIVE_ENTRY_MANIFEST_UNAVAILABLE", "the frozen cohort manifest is unavailable or malformed", { status: 503, cause: error });
  }
}

function deriveRef(kind, authorizationHash, scenarioKey) {
  const digest = createHash("sha256").update(`xw.m6-live-entry.v1:${kind}:${authorizationHash}:${scenarioKey}`).digest("hex");
  return `${kind}:${digest}`;
}

function deriveRecoveryCloseReceiptHash(receipt) {
  return createHash("sha256")
    .update(`xw.m6-4-public-live-close-receipt.v1:${canonicalJson(receipt)}`)
    .digest("hex");
}

// The operator must know the one possible run reference before a start request
// crosses the loopback boundary.  Keep that commit-ambiguity key derived by the
// exact same production function used below; a second copy in the operator
// would make response-loss recovery vulnerable to derivation drift.
export function deriveM6LiveEntryRunId({ authorizationHash, scenarioKey } = {}) {
  if (!HASH.test(authorizationHash || "") || !MANIFEST_REF.test(scenarioKey || "")) {
    throw Object.assign(new Error("live-entry run authority is invalid"), {
      code: "M6_LIVE_ENTRY_RUN_AUTHORITY_INVALID",
    });
  }
  return deriveRef("run", authorizationHash, scenarioKey);
}

function safeCode(error, fallback = "M6_LIVE_ENTRY_CONFIG_INVALID") {
  return typeof error?.code === "string" && /^[A-Z0-9_]{3,96}$/u.test(error.code) ? error.code : fallback;
}

function cleanupTimeout(code, label) {
  return Object.assign(new Error(`${label} exceeded its bounded cleanup deadline`), { code });
}

async function withinCleanupDeadline(work, timeoutMs, code, label) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(cleanupTimeout(code, label)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function unsealed(blockers, cause) {
  fail("M6_LIVE_ENTRY_UNSEALED", "M6 production live entry is not sealed for resource creation", {
    status: 503,
    details: { blockers: [...new Set(blockers)].sort(), resourceCount: 0 },
    cause,
  });
}

function defaultQualifyLaunch(config, qualification) {
  const runtimeEnv = validateM6LiveRuntimeEnvironment(config.runtimeEnv, { required: true });
  const credentialEnv = validateM6LiveCredentialEnvironment(config.credentialEnv, { required: true });
  const dependencyEnv = validateM6LiveDependencyEnvironment(config.dependencyEnv, { required: true });
  if (typeof config.sourceReleaseRoot !== "string" || !isAbsolute(config.sourceReleaseRoot)) {
    const error = new Error("deployed immutable source release root is required");
    error.code = "M6_LIVE_SOURCE_RELEASE_UNAVAILABLE";
    throw error;
  }
  const dependencyLayer = verifyM6LiveRuntimeDependencyLayer({
    layerRoot: dependencyEnv.XW_M6_LIVE_DEPENDENCY_ROOT,
    expectedLayerHash: dependencyEnv.XW_M6_LIVE_DEPENDENCY_LAYER_HASH,
    sourceRoot: config.sourceReleaseRoot,
  });
  const authority = validateM6LiveLaunchQualification("PRODUCTION", qualification, {
    runtimeEndpoint: runtimeEnv.XW_M6_LIVE_PROVIDER_BASE_URL,
    installed: dependencyLayer.installedAdapter,
    requiredRuntimeAttestationHash: dependencyLayer.qualification.qualificationHash,
  });
  if (runtimeEnv.XW_M6_LIVE_MODEL_PROFILE_HASH !== authority.modelProfileHash) {
    const error = new Error("runtime model profile hash does not match qualification evidence");
    error.code = "M6_LIVE_MODEL_PROFILE_HASH_MISMATCH";
    throw error;
  }
  return Object.freeze({
    authority,
    childSpec: sealedM6LiveChildSpec(dependencyLayer, runtimeEnv),
    credentialEnv,
    dependencyEnv,
    dependencyLayer,
    qualification,
    runtimeEnv,
  });
}

function defaultProcessAdapterFactory({
  binding,
  config,
  handleToolCall,
  launch,
  onFatal,
  requiredTargetEnvironmentAttestationHash,
  requiredLiveWindowExpiresAt,
}) {
  return new M6LiveProcessAdapter({
    command: launch.childSpec.command,
    args: launch.childSpec.args,
    cwd: launch.childSpec.cwd,
    binding,
    handleToolCall,
    executionClass: "PRODUCTION",
    qualification: launch.qualification,
    runtimeEnv: launch.runtimeEnv,
    credentialEnv: launch.credentialEnv,
    dependencyEnv: launch.dependencyEnv,
    requiredTargetEnvironmentAttestationHash,
    requiredLiveWindowExpiresAt,
    brokerOptions: config.brokerOptions,
    terminationOptions: config.terminationOptions,
    onFatal,
  });
}

function createLiveCallFence() {
  const controller = new AbortController();
  const inFlight = new Set();
  let generation = 1;
  let aborted = false;

  function dispatch(handler, input) {
    if (aborted) fail("M6_LIVE_CALL_FENCE_CLOSED", "the live-entry generation no longer admits broker calls");
    const admittedGeneration = generation;
    const operation = Promise.resolve()
      .then(() => handler(input))
      .then((result) => {
        if (aborted || generation !== admittedGeneration) {
          fail("M6_LIVE_CALL_FENCE_CLOSED", "a broker call settled after its live-entry generation was invalidated");
        }
        return result;
      });
    inFlight.add(operation);
    const remove = () => inFlight.delete(operation);
    operation.then(remove, remove);
    return operation;
  }

  function abort(cause) {
    if (aborted) return false;
    aborted = true;
    generation += 1;
    controller.abort(cause);
    return true;
  }

  async function drain() {
    const admitted = [...inFlight];
    await Promise.allSettled(admitted);
    return Object.freeze({
      schemaId: "xw.m6-live-call-fence-close.v1",
      aborted,
      drained: inFlight.size === 0,
      admittedCalls: admitted.length,
      pendingCalls: inFlight.size,
    });
  }

  return Object.freeze({ signal: controller.signal, dispatch, abort, drain });
}

function publicRun(run, extra = {}) {
  return Object.freeze({
    schemaId: "xw.m6-live-entry-run.v1",
    runId: run.runId,
    workerRunRef: run.workerRunRef,
    manifestRef: run.manifestRef,
    manifestHash: run.manifestHash,
    scenarioKey: run.scenarioKey,
    scenarioClaimHash: run.scenarioClaimHash,
    authorizationId: run.authorizationId,
    authorizationHash: run.authorizationHash,
    bindingHash: run.bindingHash,
    status: run.status,
    actionCount: run.actionCount,
    closed: run.closed,
    ...extra,
  });
}

function safeAttemptEvidence(managerResult, record) {
  if (managerResult?.attemptEvidence === null || managerResult?.attemptEvidence === undefined) return null;
  let evidence;
  try {
    evidence = cloneM64PublicAttemptEvidence(managerResult.attemptEvidence);
  } catch (error) {
    fail("M6_LIVE_ATTEMPT_EVIDENCE_INVALID", "control cleanup returned malformed public attempt evidence", {
      status: 503,
      cause: error,
    });
  }
  if (managerResult.attemptEvidenceHash !== evidence.attemptHash
    || evidence.runId !== record.runId || evidence.bindingHash !== record.bindingHash
    || evidence.manifestHash !== record.manifestHash || evidence.scenarioKey !== record.scenarioKey
    || evidence.liveAuthorizationHash !== record.authorizationHash) {
    fail("M6_LIVE_ATTEMPT_EVIDENCE_REBOUND", "control cleanup attempt evidence changed the live-entry authority", { status: 503 });
  }
  return evidence;
}

// Production configuration is intentionally explicit. There is no replay child,
// fixture command, fake provider, repository credential, or test callback fallback.
// A missing value remains missing and is reported by preflight as UNSEALED before
// authorization consumption or process/session/device resource creation.
export function loadM6LiveEntryConfigFromEnv({
  env = process.env,
} = {}) {
  return Object.freeze({
    internalToken: env.XW_M6_LIVE_ENTRY_TOKEN ?? null,
    manifestRoot: env.XW_M6_LIVE_MANIFEST_ROOT ?? null,
    issuerAllowlistPath: env.XW_M6_LIVE_AUTH_ISSUER_KEYS_PATH ?? null,
    m6Root: env.XW_RUNTIME_ROOT ?? null,
    gateId: env.XW_GATE_ID ?? null,
    gateIssuerAllowlistPath: env.XW_GATE_ISSUER_KEYS_PATH ?? null,
    runtimeSnapshotPath: env.XW_M6_LIVE_RUNTIME_SNAPSHOT_PATH ?? null,
    sourceReleaseRoot: env.XW_M6_SOURCE_RELEASE_ROOT ?? null,
    productionDependencyRuntimeBinding: Object.freeze({
      schemaId: "xw.runtime.m6-c1-runtime.v1",
      releaseId: env.CONTROL_PLANE_RELEASE_ID ?? null,
      sourceCommit: env.CONTROL_PLANE_GIT_COMMIT ?? null,
      sourceReleaseRoot: env.XW_M6_SOURCE_RELEASE_ROOT ?? null,
      productionDependencyBindingPath: env.XW_M6_PRODUCTION_DEPENDENCY_BINDING_PATH ?? null,
      productionDependencyBindingHash: env.XW_M6_PRODUCTION_DEPENDENCY_BINDING_HASH ?? null,
      targetEnvironmentAttestationPath: env.XW_M6_TARGET_ENVIRONMENT_ATTESTATION_PATH ?? null,
      targetEnvironmentAttestationHash: env.XW_M6_TARGET_ENVIRONMENT_ATTESTATION_HASH ?? null,
      environmentQualificationPath: env.XW_M6_ENVIRONMENT_QUALIFICATION_PATH ?? null,
      environmentQualificationSha256: env.XW_M6_ENVIRONMENT_QUALIFICATION_SHA256 ?? null,
    }),
    runtimeEnv: Object.freeze({
      XW_M6_LIVE_PROVIDER_BASE_URL: env.XW_M6_LIVE_PROVIDER_BASE_URL,
      XW_M6_LIVE_MODEL_PROFILE_HASH: env.XW_M6_LIVE_MODEL_PROFILE_HASH,
      XW_M6_LIVE_MODEL_PROFILE_ROOT: env.XW_M6_LIVE_MODEL_PROFILE_ROOT,
      XW_DSH_PERSISTENCE_ROOT: env.XW_DSH_PERSISTENCE_ROOT,
    }),
    dependencyEnv: Object.freeze({
      XW_M6_LIVE_DEPENDENCY_ROOT: env.XW_M6_LIVE_DEPENDENCY_ROOT,
      XW_M6_LIVE_DEPENDENCY_LAYER_HASH: env.XW_M6_LIVE_DEPENDENCY_LAYER_HASH,
    }),
    credentialEnv: Object.freeze({ DEEPSEEK_API_KEY: env.DEEPSEEK_API_KEY }),
  });
}

export function createM6LiveEntry({
  state,
  config = {},
  callbacks = null,
  manifestLoader = defaultManifestLoader,
  qualifyLaunch = defaultQualifyLaunch,
  processAdapterFactory = defaultProcessAdapterFactory,
  workerDriver = null,
  loadGateSnapshot = null,
  now = Date.now,
} = {}) {
  const activeRuns = new Map();
  const closedRuns = new Map();
  const inFlightStarts = new Set();
  const unverifiedEpochRecoveries = new Map();
  const staticBlockers = [];
  let stopNewStarts = false;
  let recoveryBarrier = Promise.resolve();
  const cleanupDrainTimeoutMs = config.cleanupDrainTimeoutMs ?? 2_000;
  const cleanupStepTimeoutMs = config.cleanupStepTimeoutMs ?? 20_000;

  if (![cleanupDrainTimeoutMs, cleanupStepTimeoutMs]
    .every((value) => Number.isSafeInteger(value) && value >= 1 && value <= 120_000)) {
    staticBlockers.push("M6_LIVE_CLEANUP_TIMEOUT_INVALID");
  }

  if (!state || typeof state.getM6GateFence !== "function"
    || typeof state.getM64LiveWindowAuthorizationConsumption !== "function"
    || typeof state.claimM64LiveScenarioStart !== "function") {
    staticBlockers.push("M6_LIVE_ENTRY_STATE_STORE_UNAVAILABLE");
  }
  if (!callbacks || CALLBACK_NAMES.some((name) => typeof callbacks[name] !== "function")) {
    staticBlockers.push("M6_LIVE_DEVICE_CALLBACKS_UNAVAILABLE");
  }
  if (typeof manifestLoader !== "function" || typeof qualifyLaunch !== "function" || typeof processAdapterFactory !== "function") {
    staticBlockers.push("M6_LIVE_ENTRY_FACTORY_INVALID");
  }
  if (typeof workerDriver !== "function") {
    staticBlockers.push("M6_LIVE_CHILD_PROTOCOL_DRIVER_UNAVAILABLE");
  }
  if (qualifyLaunch === defaultQualifyLaunch
    && (typeof config.sourceReleaseRoot !== "string" || !isAbsolute(config.sourceReleaseRoot))) {
    staticBlockers.push("M6_LIVE_SOURCE_RELEASE_UNAVAILABLE");
  }
  if (qualifyLaunch === defaultQualifyLaunch
    && (typeof config.dependencyEnv?.XW_M6_LIVE_DEPENDENCY_ROOT !== "string"
      || !isAbsolute(config.dependencyEnv.XW_M6_LIVE_DEPENDENCY_ROOT)
      || !HASH.test(config.dependencyEnv?.XW_M6_LIVE_DEPENDENCY_LAYER_HASH || ""))) {
    staticBlockers.push("M6_LIVE_DEPENDENCY_LAYER_UNAVAILABLE");
  }
  if (!config.runtimeSnapshot && (typeof config.runtimeSnapshotPath !== "string" || !isAbsolute(config.runtimeSnapshotPath))) {
    staticBlockers.push("M6_LIVE_RUNTIME_SNAPSHOT_UNAVAILABLE");
  }
  if (!config.issuerAllowlist && (typeof config.issuerAllowlistPath !== "string" || !isAbsolute(config.issuerAllowlistPath))) {
    staticBlockers.push("M6_LIVE_AUTH_ALLOWLIST_UNAVAILABLE");
  }
  if (!config.qualification
    && (typeof config.runtimeEnv?.XW_M6_LIVE_MODEL_PROFILE_ROOT !== "string"
      || !isAbsolute(config.runtimeEnv.XW_M6_LIVE_MODEL_PROFILE_ROOT)
      || !HASH.test(config.runtimeEnv?.XW_M6_LIVE_MODEL_PROFILE_HASH || ""))) {
    staticBlockers.push("M6_LIVE_PROFILE_QUALIFICATION_UNAVAILABLE");
  }
  if (manifestLoader === defaultManifestLoader
    && (typeof config.manifestRoot !== "string" || !isAbsolute(config.manifestRoot))) {
    staticBlockers.push("M6_LIVE_MANIFEST_ROOT_UNAVAILABLE");
  }
  if (typeof loadGateSnapshot !== "function"
    && (typeof config.m6Root !== "string" || !isAbsolute(config.m6Root)
      || typeof config.gateId !== "string" || !MANIFEST_REF.test(config.gateId)
      || typeof config.gateIssuerAllowlistPath !== "string" || !isAbsolute(config.gateIssuerAllowlistPath))) {
    staticBlockers.push("M6_LIVE_GATE_SNAPSHOT_UNAVAILABLE");
  }

  const manager = callbacks && CALLBACK_NAMES.every((name) => typeof callbacks[name] === "function")
    ? createM6GroundedActionRunManager(Object.freeze({
        ...callbacks,
        async act(call) {
          const slot = call.slotAuthority;
          const actionSlotResolution = resolveM64CohortActionSlot({
            manifest: call.context?.manifest,
            scenarioId: call.context?.scenarioKey,
            logicalStepId: slot?.logicalStepId,
            actionSlotOrdinal: slot?.actionSlotOrdinal,
            request: slot && {
              primitive: slot.primitive,
              intentRef: slot.intentRef,
              targetKind: slot.targetKind,
              trustedParams: slot.trustedParams,
            },
          });
          return callbacks.act(Object.freeze({ ...call, actionSlotResolution }));
        },
      }))
    : null;
  const readGateSnapshot = typeof loadGateSnapshot === "function"
    ? loadGateSnapshot
    : () => loadM6Gate({
      m6Root: config.m6Root,
      gateId: config.gateId,
      issuerAllowlistPath: config.gateIssuerAllowlistPath,
      requireLocks: true,
    });

  function assertAuthorized(headers = {}) {
    const expected = config.internalToken;
    if (typeof expected !== "string" || expected.length < 32 || /[\0\r\n]/u.test(expected)) {
      unsealed(["M6_LIVE_INTERNAL_TOKEN_UNAVAILABLE"]);
    }
    const actual = headers["x-control-token"] ?? headers["X-Control-Token"];
    if (typeof actual !== "string") {
      fail("M6_LIVE_ENTRY_ACCESS_DENIED", "M6 internal live entry requires X-Control-Token", { status: 403 });
    }
    const expectedHash = createHash("sha256").update(expected).digest();
    const actualHash = createHash("sha256").update(actual).digest();
    if (!timingSafeEqual(expectedHash, actualHash)) {
      fail("M6_LIVE_ENTRY_ACCESS_DENIED", "M6 internal live entry token is invalid", { status: 403 });
    }
    return true;
  }

  function closedRequest(value) {
    const input = exactObject(value, REQUEST_KEYS, "M6_LIVE_ENTRY_INPUT_CLOSED", "M6 live-entry request");
    if (!MANIFEST_REF.test(input.manifestRef || "") || !MANIFEST_REF.test(input.scenarioKey || "") || !HASH.test(input.manifestHash || "")
      || typeof input.authorizationId !== "string" || !RUN_REF.test(input.authorizationId)
      || !HASH.test(input.authorizationHash || "")
      || !input.authorization || typeof input.authorization !== "object" || Array.isArray(input.authorization)) {
      fail("M6_LIVE_ENTRY_INPUT_INVALID", "M6 live-entry request contains an invalid frozen ref, hash, or authorization", { status: 400, details: { resourceCount: 0 } });
    }
    if (input.authorization.authorizationId !== input.authorizationId
      || input.authorization.envelopeHash !== input.authorizationHash) {
      fail("M6_LIVE_ENTRY_AUTH_REF_MISMATCH", "authorization refs do not match the signed envelope", { status: 409, details: { resourceCount: 0 } });
    }
    return input;
  }

  function assertActivatedAuthorization(authorization) {
    const nowMs = now();
    const fence = state.getM6GateFence();
    const requiredMode = authorization.purpose === "M6_4_SHADOW" ? "OBSERVE_ONLY" : "GROUNDED_ACTION";
    const fenceMatches = fence
      && fence.mode === requiredMode
      && fence.gateId === authorization.gateId
      && fence.epochHash === authorization.gateEpochHash
      && fence.generation === authorization.gateGeneration
      && fence.purpose === authorization.purpose
      && fence.releaseId === authorization.releaseId
      && fence.sourceCommit === authorization.sourceCommit
      && fence.locksHash === authorization.locksHash
      && JSON.stringify(fence.allowlist) === JSON.stringify(["01"])
      && Date.parse(fence.expiresAt) > nowMs;
    if (!fenceMatches) {
      fail("M6_LIVE_ENTRY_GATE_FENCE_MISMATCH", "the current gate fence does not activate this signed live window", {
        details: {
          expectedMode: requiredMode,
          expectedEpochHash: authorization.gateEpochHash,
          expectedGeneration: authorization.gateGeneration,
          actualMode: fence?.mode ?? null,
          actualEpochHash: fence?.epochHash ?? null,
          actualGeneration: fence?.generation ?? null,
        },
      });
    }
    const loaded = readGateSnapshot();
    assertM6FileDbPointerConsistency({ loaded, fence, pointer: loaded?.currentPointer });
    const consumption = state.getM64LiveWindowAuthorizationConsumption(authorization.authorizationId);
    const consumptionMatches = consumption
      && consumption.authorizationId === authorization.authorizationId
      && consumption.bodyHash === authorization.bodyHash
      && consumption.envelopeHash === authorization.envelopeHash
      && consumption.gateId === authorization.gateId
      && consumption.gateEpochHash === authorization.gateEpochHash
      && consumption.gateGeneration === authorization.gateGeneration
      && consumption.purpose === authorization.purpose
      && consumption.releaseId === authorization.releaseId
      && consumption.sourceCommit === authorization.sourceCommit
      && consumption.locksHash === authorization.locksHash
      && consumption.expiresAt === authorization.expiresAt
      && Date.parse(consumption.expiresAt) > nowMs;
    if (!consumptionMatches) {
      fail("M6_LIVE_ENTRY_AUTH_NOT_ACTIVATED", "the signed live-window authorization was not atomically consumed by gate activation", { status: 403 });
    }
    return Object.freeze({ consumption, fence, loaded });
  }

  function prepare(value, { requireActivation = false } = {}) {
    const input = closedRequest(value);
    if (staticBlockers.length > 0) unsealed(staticBlockers);

    let manifest;
    let issuerAllowlist;
    let runtimeSnapshot;
    let qualification;
    let launch;
    try {
      manifest = manifestLoader(input.manifestRef, config);
      issuerAllowlist = config.issuerAllowlist ?? loadM64LiveWindowIssuerAllowlist(config.issuerAllowlistPath);
      runtimeSnapshot = config.runtimeSnapshot ?? readJsonFile(config.runtimeSnapshotPath, "runtimeSnapshotPath");
      qualification = config.qualification ?? loadContentAddressedLiveModelProfile({
        qualificationRoot: config.runtimeEnv.XW_M6_LIVE_MODEL_PROFILE_ROOT,
        expectedContentHash: config.runtimeEnv.XW_M6_LIVE_MODEL_PROFILE_HASH,
      });
      launch = qualifyLaunch(config, qualification);
    } catch (error) {
      unsealed([safeCode(error)], error);
    }

    const manifestValidation = validateM64CohortManifest(manifest);
    if (!manifestValidation.ok || !LIVE_PURPOSES.has(manifest?.purpose)
      || manifest.alias !== "01" || manifest.manifestHash !== input.manifestHash) {
      fail("M6_LIVE_ENTRY_MANIFEST_MISMATCH", "the resolved frozen cohort manifest is invalid or rebound", {
        details: { errors: manifestValidation.errors, resourceCount: 0 },
      });
    }
    const scenario = manifest.scenarios.find((candidate) => candidate.scenarioKey === input.scenarioKey);
    if (!scenario) {
      fail("M6_LIVE_ENTRY_SCENARIO_MISMATCH", "scenarioKey is not an exact member of the resolved frozen cohort manifest", {
        details: { resourceCount: 0 },
      });
    }
    const authorization = input.authorization;
    if (authorization.alias !== "01" || authorization.purpose !== manifest.purpose
      || authorization.scenarioManifestHash !== manifest.manifestHash
      || authorization.modelProfileHash !== qualification.contentHash) {
      fail("M6_LIVE_ENTRY_AUTH_BINDING_MISMATCH", "signed authorization does not bind the resolved manifest and qualified model", { status: 403, details: { resourceCount: 0 } });
    }
    const verification = verifyM64LiveWindowAuthorization({
      authorization,
      issuerAllowlist,
      runtime: runtimeSnapshot,
      nowMs: now(),
    });
    // Preflight proves that every immutable input is sealed and re-verifies the
    // signed envelope, but it never consumes or requires consumption. Gate
    // promotion is the sole atomic consumer; start checks that receipt together
    // with the current triple-consistent fence immediately before any resource
    // can be constructed.
    const activation = requireActivation ? assertActivatedAuthorization(authorization) : null;
    return Object.freeze({ input, manifest, scenario, issuerAllowlist, runtimeSnapshot, qualification, launch, verification, activation });
  }

  function preflight(value) {
    if (stopNewStarts) {
      fail("M6_LIVE_EPOCH_RECOVERY_LATCHED", "M6 live-entry recovery permanently stopped new starts for this process", {
        status: 503,
        details: { resourceCount: 0 },
      });
    }
    const prepared = prepare(value);
    return Object.freeze({
      schemaId: "xw.m6-live-entry-preflight.v1",
      status: "SEALED_PREFLIGHT",
      manifestRef: prepared.input.manifestRef,
      manifestHash: prepared.input.manifestHash,
      scenarioKey: prepared.input.scenarioKey,
      authorizationId: prepared.input.authorizationId,
      authorizationHash: prepared.input.authorizationHash,
      qualificationStatus: prepared.launch.authority?.qualificationStatus ?? "QUALIFIED",
      resourceCount: 0,
    });
  }

  async function drainRecordCalls(record) {
    const result = await withinCleanupDeadline(
      () => record.callFence.drain(),
      cleanupDrainTimeoutMs,
      "M6_LIVE_CALL_FENCE_DRAIN_TIMEOUT",
      "live call-fence drain",
    );
    if (result.drained !== true || result.pendingCalls !== 0) {
      fail("M6_LIVE_CALL_FENCE_DRAIN_UNVERIFIED", "M6 live-entry broker calls did not drain after generation invalidation", {
        status: 503,
        details: { runId: record.runId, pendingCalls: result.pendingCalls },
      });
    }
    return result;
  }

  async function closeRecord(record, reasonCode, cause = null) {
    if (record.closePromise) return record.closePromise;
    const startupNeverOwnedWorkerProtocol = record.status === "STARTING" && !record.workerProtocol;
    record.status = "CLOSING";
    // Assign before executing any abort hook: the process adapter's broker
    // onFatal callback is synchronous and may re-enter closeRecord.
    record.closePromise = Promise.resolve().then(async () => {
      const abortCause = cause instanceof Error
        ? cause
        : Object.assign(new Error(`M6 live-entry closing: ${reasonCode}`), { code: "M6_LIVE_ENTRY_ABORTED" });
      let callFenceAbortError = null;
      try {
        record.callFence.abort(abortCause);
      } catch (error) {
        callFenceAbortError = error;
      }
      const callFenceResult = await drainRecordCalls(record).catch((error) => ({ error }));

      // Control-plane action authority is terminalized before any transport or
      // child resource is stopped. Every later cleanup step is attempted even
      // when an earlier one fails so close never strands a lower-layer owner.
      const managerResult = await withinCleanupDeadline(
        () => manager.closeRun(record.runId, reasonCode),
        cleanupStepTimeoutMs,
        "M6_LIVE_CONTROL_RESOURCES_CLOSE_TIMEOUT",
        "control resource cleanup",
      ).catch((error) => ({ error }));
      let brokerStopResult;
      try {
        brokerStopResult = await withinCleanupDeadline(
          () => (cause || reasonCode === "BROKER_FAILURE")
            ? record.live?.broker?.abort?.(abortCause)
            : record.live?.broker?.close?.(),
          cleanupStepTimeoutMs,
          "M6_LIVE_BROKER_CLOSE_TIMEOUT",
          "parent broker cleanup",
        );
      } catch (error) {
        brokerStopResult = { error };
      }
      const protocolResult = record.workerProtocol
        ? await withinCleanupDeadline(
            () => record.workerProtocol.close(),
            cleanupStepTimeoutMs,
            "M6_LIVE_WORKER_PROTOCOL_CLOSE_TIMEOUT",
            "worker protocol cleanup",
          ).catch((error) => ({ error }))
        : startupNeverOwnedWorkerProtocol
          ? { verifiedClosed: true, startupNeverOwned: true }
          : { error: Object.assign(new Error("live worker protocol handle is absent"), { code: "M6_LIVE_WORKER_PROTOCOL_UNAVAILABLE" }) };
      const processResult = await withinCleanupDeadline(
        () => record.live.close(),
        cleanupStepTimeoutMs,
        "M6_LIVE_PROCESS_CLOSE_TIMEOUT",
        "owned process cleanup",
      ).catch((error) => ({ error }));

      let attemptEvidence = null;
      let attemptEvidenceError = null;
      if (!managerResult?.error && managerResult?.verifiedClosed === true) {
        try {
          attemptEvidence = safeAttemptEvidence(managerResult, record);
        } catch (error) {
          attemptEvidenceError = error;
        }
      }

      const blockers = [];
      const addBlocker = (error, fallback) => blockers.push(safeCode(error, fallback));
      if (callFenceAbortError) addBlocker(callFenceAbortError, "M6_LIVE_CALL_FENCE_ABORT_UNVERIFIED");
      if (callFenceResult?.error || callFenceResult?.drained !== true || callFenceResult?.pendingCalls !== 0) {
        addBlocker(callFenceResult?.error, "M6_LIVE_CALL_FENCE_DRAIN_UNVERIFIED");
      }
      if (managerResult?.error || managerResult?.verifiedClosed !== true) {
        addBlocker(managerResult?.error, "M6_LIVE_CONTROL_RESOURCES_CLOSE_UNVERIFIED");
      }
      if (attemptEvidenceError) addBlocker(attemptEvidenceError, "M6_LIVE_ATTEMPT_EVIDENCE_INVALID");
      if (brokerStopResult?.error) addBlocker(brokerStopResult.error, "M6_LIVE_BROKER_CLOSE_UNVERIFIED");
      if (protocolResult?.error || protocolResult?.verifiedClosed !== true) {
        addBlocker(protocolResult?.error, "M6_LIVE_WORKER_PROTOCOL_CLOSE_UNVERIFIED");
      }
      if (processResult?.error || processResult?.verifiedClosed !== true
        || processResult?.broker?.pipeClosed !== true || processResult?.process?.verifiedClosed !== true) {
        addBlocker(processResult?.error, "M6_LIVE_PROCESS_CLOSE_UNVERIFIED");
      }
      if (blockers.length > 0) {
        const firstCause = callFenceAbortError ?? callFenceResult?.error ?? managerResult?.error ?? attemptEvidenceError
          ?? brokerStopResult?.error ?? protocolResult?.error ?? processResult?.error;
        const lowerLayersTerminal = managerResult?.verifiedClosed === true
          && processResult?.verifiedClosed === true
          && processResult?.broker?.pipeClosed === true
          && processResult?.process?.verifiedClosed === true;
        if (lowerLayersTerminal) {
          const current = manager.getRun(record.runId);
          record.status = "FAILED_CLOSED";
          record.actionCount = current?.actionCount ?? record.actionCount;
          record.closed = true;
          activeRuns.delete(record.runId);
          manager.forgetClosedRun(record.runId);
          const result = publicRun(record, {
            close: Object.freeze({
              schemaId: "xw.m6-live-entry-close.v1",
              reasonCode,
              brokerClosed: true,
              workerProtocolClosed: protocolResult?.verifiedClosed === true,
              processClosed: true,
              controlResourcesClosed: true,
              callFenceDrained: callFenceResult?.drained === true && callFenceResult?.pendingCalls === 0,
              blockers: Object.freeze([...new Set(blockers)]),
              attemptEvidence,
              attemptEvidenceHash: attemptEvidence?.attemptHash ?? null,
              verifiedClosed: false,
            }),
          });
          closedRuns.set(record.runId, result);
          return result;
        }
        fail("M6_LIVE_RUN_CLOSE_UNVERIFIED", "M6 live-entry cleanup did not prove every owned resource closed", {
          status: 503,
          details: {
            blocker: blockers[0],
            blockers: Object.freeze([...new Set(blockers)]),
            runId: record.runId,
            cleanup: Object.freeze({
              callFenceDrained: callFenceResult?.drained === true && callFenceResult?.pendingCalls === 0,
              controlResourcesClosed: managerResult?.verifiedClosed === true,
              brokerStopAttempted: true,
              workerProtocolClosed: protocolResult?.verifiedClosed === true,
              brokerClosed: processResult?.broker?.pipeClosed === true,
              processClosed: processResult?.process?.verifiedClosed === true,
            }),
          },
          cause: firstCause,
        });
      }
      const current = manager.getRun(record.runId);
      record.status = "CLOSED";
      record.actionCount = current?.actionCount ?? record.actionCount;
      record.closed = true;
      activeRuns.delete(record.runId);
      manager.forgetClosedRun(record.runId);
      const result = publicRun(record, {
        close: Object.freeze({
          schemaId: "xw.m6-live-entry-close.v1",
          reasonCode,
          brokerClosed: processResult.broker?.pipeClosed === true,
          workerProtocolClosed: protocolResult.verifiedClosed === true,
          processClosed: processResult.process?.verifiedClosed === true,
          controlResourcesClosed: managerResult.verifiedClosed === true,
          callFenceDrained: callFenceResult.drained === true,
          attemptEvidence,
          attemptEvidenceHash: attemptEvidence?.attemptHash ?? null,
          verifiedClosed: true,
        }),
      });
      closedRuns.set(record.runId, result);
      return result;
    });
    return record.closePromise;
  }

  async function startAdmitted(value) {
    const prepared = prepare(value, { requireActivation: true });
    const authorization = prepared.input.authorization;
    const runId = deriveM6LiveEntryRunId({
      authorizationHash: prepared.input.authorizationHash,
      scenarioKey: prepared.input.scenarioKey,
    });
    if (activeRuns.has(runId) || closedRuns.has(runId) || manager.getRun(runId)) {
      fail("M6_LIVE_RUN_EXISTS", "this signed authorization and scenario already own a live-entry run", {
        details: { resourceCount: 0 },
      });
    }
    let scenarioClaim;
    try {
      scenarioClaim = await state.claimM64LiveScenarioStart({
        verification: prepared.verification,
        scenarioKey: prepared.scenario.scenarioKey,
      });
    } catch (error) {
      fail(safeCode(error, "M6_LIVE_SCENARIO_CLAIM_REJECTED"), "the frozen cohort scenario could not be claimed exactly once", {
        status: error?.status ?? 409,
        details: { resourceCount: 0 },
        cause: error,
      });
    }
    if (!scenarioClaim || scenarioClaim.schemaId !== "xw.m6-4-live-scenario-claim.v1"
      || scenarioClaim.status !== "STARTED"
      || scenarioClaim.authorizationId !== authorization.authorizationId
      || scenarioClaim.authorizationHash !== authorization.envelopeHash
      || scenarioClaim.manifestHash !== prepared.manifest.manifestHash
      || scenarioClaim.scenarioKey !== prepared.scenario.scenarioKey
      || scenarioClaim.purpose !== authorization.purpose
      || scenarioClaim.gateEpochHash !== authorization.gateEpochHash
      || scenarioClaim.gateGeneration !== authorization.gateGeneration
      || !HASH.test(scenarioClaim.claimHash || "")) {
      fail("M6_LIVE_SCENARIO_CLAIM_INVALID", "the durable scenario claim receipt is absent or rebound", {
        details: { resourceCount: 0 },
      });
    }
    const binding = createM6LivePipeBinding({
      runId,
      workerId: deriveRef("worker", prepared.input.authorizationHash, prepared.input.scenarioKey),
      sessionId: deriveRef("session", prepared.input.authorizationHash, prepared.input.scenarioKey),
      alias: "01",
      processRef: deriveRef("process", prepared.input.authorizationHash, prepared.input.scenarioKey),
      gateEpochHash: authorization.gateEpochHash,
      generation: authorization.gateGeneration,
      purpose: authorization.purpose,
      scenarioManifestHash: authorization.scenarioManifestHash,
      liveWindowAuthorizationHash: authorization.envelopeHash,
    });
    const workerRunRef = deriveRef("workerrun", prepared.input.authorizationHash, prepared.input.scenarioKey);
    const callFence = createLiveCallFence();
    const dispatchToolCall = createM6LiveBrokerHandler({
      state,
      runManager: manager,
      binding,
      authorizationId: authorization.authorizationId,
      now,
      loadGateSnapshot: readGateSnapshot,
    });
    const handleToolCall = (input) => callFence.dispatch(dispatchToolCall, input);

    let adapter;
    let record = null;
    let pendingFatal = null;
    const onFatal = (error) => {
      pendingFatal = error instanceof Error ? error : Object.assign(new Error("M6 live broker failed"), { code: "M6_LIVE_BROKER_FATAL" });
      if (record) {
        record.fatalError = pendingFatal;
        record.callFence.abort(pendingFatal);
        const fatalBarrier = drainRecordCalls(record);
        void closeRecord(record, "BROKER_FAILURE", pendingFatal).catch((closeError) => {
          record.closeError = closeError;
        });
        return fatalBarrier;
      }
      return Promise.resolve();
    };
    try {
      // Gate promotion has already consumed the authorization atomically. The
      // production adapter constructor performs only sealed, resource-free
      // command/profile/environment validation; launch() is the first process I/O.
      adapter = processAdapterFactory({
        binding,
        config,
        handleToolCall,
        launch: prepared.launch,
        onFatal,
        requiredTargetEnvironmentAttestationHash: authorization.environmentAttestationHash,
        requiredLiveWindowExpiresAt: authorization.expiresAt,
      });
      if (!adapter || typeof adapter.launch !== "function") {
        fail("M6_LIVE_PROCESS_ADAPTER_INVALID", "production live process adapter is unavailable", { status: 503 });
      }
    } catch (error) {
      unsealed([safeCode(error, "M6_LIVE_PROCESS_ADAPTER_INVALID")], error);
    }

    manager.openRun({
      binding,
      authorizationId: authorization.authorizationId,
      workerRunRef,
      context: Object.freeze({
        manifestRef: prepared.input.manifestRef,
        manifestHash: prepared.input.manifestHash,
        manifest: prepared.manifest,
        scenario: prepared.scenario,
        scenarioKey: prepared.input.scenarioKey,
        scenarioClaimHash: scenarioClaim.claimHash,
        authorizationId: authorization.authorizationId,
        liveAuthorizationHash: authorization.envelopeHash,
        liveAuthorizationIssuedAt: authorization.issuedAt,
        liveAuthorizationExpiresAt: authorization.expiresAt,
        authorizationConsumptionHash: prepared.activation.consumption.consumptionHash,
        abortSignal: callFence.signal,
      }),
    });

    record = {
      runId,
      workerRunRef,
      manifestRef: prepared.input.manifestRef,
      manifestHash: prepared.input.manifestHash,
      scenarioKey: prepared.input.scenarioKey,
      scenarioClaimHash: scenarioClaim.claimHash,
      authorizationId: prepared.input.authorizationId,
      authorizationHash: prepared.input.authorizationHash,
      gateEpochHash: authorization.gateEpochHash,
      purpose: authorization.purpose,
      bindingHash: binding.bindingHash,
      status: "STARTING",
      actionCount: 0,
      closed: false,
      adapter,
      live: null,
      callFence,
      fatalError: pendingFatal,
      closeError: null,
      closePromise: null,
      workerProtocol: null,
    };
    try {
      if (pendingFatal) throw pendingFatal;
      record.live = adapter.launch();
      if (!record.live || typeof record.live.close !== "function" || !record.live.ready) {
        fail("M6_LIVE_PROCESS_ADAPTER_INVALID", "live process launch did not return an owned ready/close handle", { status: 503 });
      }
      activeRuns.set(runId, record);
      await record.live.ready;
      // The production process adapter owns the existing child and FD3 pipe but
      // deliberately does not create a second SDK child. A sealed driver must
      // initialize/prompt that exact child over its existing stdin/stdout. Until
      // such a driver is wired by bootstrap, static preflight blocks launch.
      const workerProtocol = await workerDriver(Object.freeze({
        live: record.live,
        binding,
        workerRunRef,
        manifest: prepared.manifest,
        manifestRef: prepared.input.manifestRef,
        scenario: prepared.scenario,
        scenarioKey: prepared.input.scenarioKey,
        qualification: prepared.qualification,
      }));
      if (record.fatalError) throw record.fatalError;
      if (!workerProtocol || workerProtocol.schemaId !== "xw.m6-live-worker-protocol.v1"
        || workerProtocol.runId !== runId || workerProtocol.sessionId !== binding.sessionId
        || !HASH.test(workerProtocol.directiveHash || "") || typeof workerProtocol.close !== "function") {
        fail("M6_LIVE_WORKER_PROTOCOL_UNAVAILABLE", "sealed worker driver did not return the owned protocol handle", { status: 503 });
      }
      record.workerProtocol = workerProtocol;
      if (record.fatalError || record.closed || record.closePromise) {
        throw record.fatalError ?? record.closeError ?? Object.assign(new Error("M6 live entry closed during child protocol startup"), { code: "M6_LIVE_ENTRY_START_ABORTED" });
      }
      const managed = manager.getRun(runId);
      record.status = managed?.status === "RUNNING" ? "RUNNING" : "BROKER_READY";
      record.actionCount = managed?.actionCount ?? 0;
      return publicRun(record);
    } catch (error) {
      if (record.live) {
        activeRuns.set(runId, record);
        await closeRecord(record, "START_FAILED", error).catch(() => {});
      } else {
        await manager.closeRun(runId, "START_FAILED").then(() => manager.forgetClosedRun(runId)).catch(() => {});
      }
      if (error instanceof ControlPlaneError) throw error;
      fail(safeCode(error, "M6_LIVE_ENTRY_START_FAILED"), "M6 production live entry failed to start", { status: 503, cause: error });
    }
  }

  async function start(value) {
    if (stopNewStarts) {
      fail("M6_LIVE_EPOCH_RECOVERY_LATCHED", "M6 live-entry recovery permanently stopped new starts for this process", {
        status: 503,
        details: { resourceCount: 0 },
      });
    }
    const operation = startAdmitted(value);
    inFlightStarts.add(operation);
    try {
      return await operation;
    } finally {
      inFlightStarts.delete(operation);
    }
  }

  function status(value) {
    const input = exactObject(value, ["runId"], "M6_LIVE_ENTRY_INPUT_CLOSED", "M6 live-entry status query");
    if (typeof input.runId !== "string" || !RUN_REF.test(input.runId)) {
      fail("M6_LIVE_RUN_REF_INVALID", "runId is not an opaque live-entry reference", { status: 400 });
    }
    const closed = closedRuns.get(input.runId);
    if (closed) return closed;
    const record = activeRuns.get(input.runId);
    if (!record) fail("M6_LIVE_RUN_NOT_FOUND", "the live-entry run is not owned by this Control Plane", { status: 404 });
    const managed = manager.getRun(input.runId);
    record.status = managed?.status ?? record.status;
    record.actionCount = managed?.actionCount ?? record.actionCount;
    return publicRun(record);
  }

  async function close(value) {
    const input = exactObject(value, CLOSE_KEYS, "M6_LIVE_ENTRY_INPUT_CLOSED", "M6 live-entry close request");
    if (typeof input.runId !== "string" || !RUN_REF.test(input.runId) || !CLOSE_REASONS.has(input.reasonCode)) {
      fail("M6_LIVE_ENTRY_CLOSE_INVALID", "close requires an opaque runId and a bounded reasonCode", { status: 400 });
    }
    const prior = closedRuns.get(input.runId);
    if (prior) return prior;
    const record = activeRuns.get(input.runId);
    if (!record) fail("M6_LIVE_RUN_NOT_FOUND", "the live-entry run is not owned by this Control Plane", { status: 404 });
    return closeRecord(record, input.reasonCode);
  }

  async function settleAdmittedStarts() {
    let settled = 0;
    while (inFlightStarts.size > 0) {
      const admitted = [...inFlightStarts];
      settled += admitted.length;
      await Promise.allSettled(admitted);
    }
    return settled;
  }

  async function recoverExactEpoch(input) {
    let inFlightStartsSettled = await settleAdmittedStarts();
    const recoveryKey = `${input.gateEpochHash}:${input.purpose}`;
    const priorFailure = unverifiedEpochRecoveries.get(recoveryKey);
    if (priorFailure) {
      const activeMatchingRuns = [...activeRuns.values()]
        .filter((record) => record.gateEpochHash === input.gateEpochHash && record.purpose === input.purpose)
        .length;
      fail("M6_LIVE_EPOCH_RECOVERY_UNVERIFIED", "a prior close in this epoch recovery remains unverified", {
        status: 503,
        details: {
          ...priorFailure,
          repeated: true,
          inFlightStartsSettled: priorFailure.inFlightStartsSettled + inFlightStartsSettled,
          activeRuns: activeRuns.size,
          activeMatchingRuns,
        },
      });
    }
    const attemptedRunIds = new Set();
    const closeReceipts = [];
    const failures = [];

    // The admission latch is already closed. Re-scan after every close batch so
    // an admitted start that was between durable claim and active-map ownership
    // cannot escape the recovery barrier.
    while (true) {
      inFlightStartsSettled += await settleAdmittedStarts();
      const candidates = [...activeRuns.values()]
        .filter((record) => record.gateEpochHash === input.gateEpochHash
          && record.purpose === input.purpose
          && !attemptedRunIds.has(record.runId))
        .sort((left, right) => left.runId.localeCompare(right.runId));
      if (candidates.length === 0) break;
      for (const record of candidates) attemptedRunIds.add(record.runId);
      const results = await Promise.allSettled(candidates.map((record) => closeRecord(record, "RECOVERY")));
      for (let index = 0; index < results.length; index += 1) {
        const result = results[index];
        const runId = candidates[index].runId;
        if (result.status !== "fulfilled" || result.value?.close?.verifiedClosed !== true) {
          failures.push(Object.freeze({
            runId,
            blocker: result.status === "rejected"
              ? safeCode(result.reason, "M6_LIVE_RUN_CLOSE_UNVERIFIED")
              : "M6_LIVE_RUN_CLOSE_UNVERIFIED",
          }));
          continue;
        }
        closeReceipts.push(Object.freeze({
          runId,
          closeReceiptHash: deriveRecoveryCloseReceiptHash(result.value),
          attemptEvidenceHash: result.value.close.attemptEvidenceHash ?? null,
        }));
      }
    }

    const remainingMatchingRuns = [...activeRuns.values()]
      .filter((record) => record.gateEpochHash === input.gateEpochHash && record.purpose === input.purpose)
      .map((record) => record.runId)
      .sort();
    closeReceipts.sort((left, right) => left.runId.localeCompare(right.runId));
    if (failures.length > 0 || remainingMatchingRuns.length > 0) {
      const failureDetails = Object.freeze({
        gateEpochHash: input.gateEpochHash,
        purpose: input.purpose,
        attempted: attemptedRunIds.size,
        verifiedClosed: closeReceipts.length,
        failed: failures.length,
        inFlightStartsSettled,
        activeRuns: activeRuns.size,
        activeMatchingRuns: remainingMatchingRuns.length,
        failures: Object.freeze(failures),
        closeReceipts: Object.freeze(closeReceipts),
      });
      unverifiedEpochRecoveries.set(recoveryKey, failureDetails);
      fail("M6_LIVE_EPOCH_RECOVERY_UNVERIFIED", "one or more Control-Plane-owned live runs failed verified epoch recovery", {
        status: 503,
        details: failureDetails,
      });
    }

    return Object.freeze({
      schemaId: "xw.m6-live-entry-epoch-recovery.v1",
      status: "RECOVERED",
      gateEpochHash: input.gateEpochHash,
      purpose: input.purpose,
      stopNewStarts: true,
      inFlightStartsSettled,
      attempted: attemptedRunIds.size,
      verifiedClosed: closeReceipts.length,
      activeMatchingRuns: 0,
      controlPlaneOwnedActiveRuns: activeRuns.size,
      externalResourceState: "NOT_ASSERTED",
      closeReceipts: Object.freeze(closeReceipts),
    });
  }

  function closeActiveEpoch(value) {
    const input = exactObject(value, EPOCH_RECOVERY_KEYS, "M6_LIVE_EPOCH_RECOVERY_INPUT_INVALID", "M6 live epoch recovery request");
    if (!HASH.test(input.gateEpochHash || "") || !LIVE_PURPOSES.has(input.purpose)) {
      fail("M6_LIVE_EPOCH_RECOVERY_INPUT_INVALID", "epoch recovery requires an exact gateEpochHash and bounded live purpose", {
        status: 400,
        details: { resourceCount: 0 },
      });
    }
    // This latch is intentionally permanent for the current Control Plane
    // process. Recovery never resumes work or re-opens live admission.
    stopNewStarts = true;
    const operation = recoveryBarrier.then(
      () => recoverExactEpoch(input),
      () => recoverExactEpoch(input),
    );
    recoveryBarrier = operation.catch(() => {});
    return operation;
  }

  function recoverEpoch(value) {
    return closeActiveEpoch(value);
  }

  async function shutdown() {
    const runIds = [...activeRuns.keys()];
    const results = await Promise.allSettled(runIds.map((runId) => closeRecord(activeRuns.get(runId), "SHUTDOWN")));
    const failed = results.filter((result) => result.status === "rejected"
      || result.value?.close?.verifiedClosed !== true);
    if (failed.length > 0) {
      fail("M6_LIVE_ENTRY_SHUTDOWN_UNVERIFIED", "one or more M6 live-entry runs failed verified shutdown", {
        status: 503,
        details: { attempted: runIds.length, failed: failed.length, activeRuns: activeRuns.size },
      });
    }
    return Object.freeze({
      schemaId: "xw.m6-live-entry-shutdown.v1",
      attempted: runIds.length,
      verifiedClosed: results.length - failed.length,
      activeRuns: activeRuns.size,
    });
  }

  function health() {
    return Object.freeze({
      installed: true,
      status: stopNewStarts ? "RECOVERY_LATCHED" : staticBlockers.length === 0 ? "PREFLIGHT_REQUIRED" : "UNSEALED",
      activeRuns: activeRuns.size,
      blockers: [...new Set(staticBlockers)].sort(),
    });
  }

  return Object.freeze({ assertAuthorized, preflight, start, status, close, closeActiveEpoch, recoverEpoch, shutdown, health });
}
