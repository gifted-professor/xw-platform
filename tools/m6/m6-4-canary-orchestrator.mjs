import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import {
  dirname,
  isAbsolute,
  parse,
  resolve,
} from "node:path";

import { validateQualifiedLiveModelProfile } from "../../integrations/dsh-xw/src/live-model-profile.mjs";
import { deriveM6AggregateSealHash } from "../../packages/kernel/lib/m6-aggregate-closeout.mjs";
import {
  M6_4_COHORT_PURPOSES,
  M6_4_COHORT_RULES,
  deriveM64CohortAggregateHash,
  deriveM64CohortScenarioKeys,
  validateM64CohortAggregate,
  validateM64CohortManifest,
} from "../../packages/kernel/lib/m6-4-cohort.mjs";
import {
  validateM64EffectBoundary,
} from "../../packages/kernel/lib/m6-effect-boundary.mjs";
import {
  deriveM64AttemptEvidence as deriveSharedM64AttemptEvidence,
  deriveM64ExpectedStateArtifact,
  validateM64AttemptEvidence,
  validateM64ExpectedStateArtifact,
} from "../../packages/kernel/lib/m6-live-evidence.mjs";
import { deriveM6V2EpochHash } from "../../services/control-plane/control-plane/lib/m6-live-gate-v2.mjs";
import { deriveM6CloseoutHash } from "../../services/control-plane/control-plane/lib/m6-live-gate.mjs";
import { deriveM6LiveEntryRunId } from "../../services/control-plane/control-plane/lib/m6-live-entry.mjs";
import { normalizeM64LiveWindowIssuerAllowlist } from "../../services/control-plane/control-plane/lib/m6-live-window-authorization.mjs";
import {
  closeM64LiveEntry,
  preflightM64LiveEntry,
  recoverM64LiveEntryEpoch,
  startM64LiveEntry,
  statusM64LiveEntry,
  validateM64LiveWindowAuthorization,
  validateM64LoopbackControlPlaneUrl,
  withM64LoopbackRequestDeadline,
} from "./m6-4-canary-runner.mjs";

export const M64_STAGED_CANARY_ORDER = Object.freeze([...M6_4_COHORT_PURPOSES]);
export const M64_ACTION_CANARY_TERMINAL_STATUS = "M6_4_ACTION_CANARY_CLOSED";

const HASH = /^[0-9a-f]{64}$/u;
const MAX_SEALED_ARTIFACT_BYTES = 16 * 1024 * 1024;
const GATE_PATH = "/control/v1/internal/m6/gate-f";
const GATE_RECOVERY_KEYS = Object.freeze([
  "priorEpochHash", "recovered", "schemaId", "status", "terminalEpochHash", "tripleConsistent",
]);
const GATE_RECOVERY_STATUS_KEYS = Object.freeze([
  "actionCount", "activeAuthorizationCount", "epochHash", "errors", "generation", "locksHash",
  "mode", "phase", "purpose", "resourceCounts", "schemaId", "tripleConsistent",
]);
const GATE_RECOVERY_RESOURCE_COUNT_KEYS = Object.freeze(["jobs", "leases", "runs", "sessions"]);
export const M64_LIVE_CLOSE_RECONCILIATION_TIMEOUT_MS = 195_000;
const NORMAL_TERMINAL_RUN_STATUSES = new Set(["COMPLETED", "FAILED", "WAITING"]);
const RESOURCE_PROBE_KEYS = Object.freeze([
  "actionCount", "activeActions", "activeAuthorizationCount", "activeBrokers", "activeDshProcesses",
  "activeJobs", "activeLeases", "activePipes", "activeScenarioClaimCount", "activeSessions", "capturedAt",
  "gateClosedEpochHash", "independentOracleArtifactSha256", "orphanProcessRefs", "pendingApprovals",
  "probeHash", "processInventoryHash", "processInventorySha256", "purpose", "rawDeviceIdentityPresent",
  "resourceObservationRequestHash", "resourceObservedAt", "resourceObserverHash", "resourceObserverKeyId",
  "schemaId", "secretMaterialPresent",
]);
const RECEIPT_KEYS = Object.freeze([
  "alias", "cohortOrder", "effectBoundaryHash", "finalGateEpochHash", "finalGateGeneration", "gateTripleConsistent", "generatedAt", "masterCompletionClaim",
  "receiptHash", "resourceCloseoutHash", "schemaId", "terminalStatus", "windows",
]);
const SEALED_DESCRIPTOR_KEYS = Object.freeze(["path", "sha256"]);
const WINDOW_INVENTORY_KEYS = Object.freeze([
  "expectedOracles", "files", "inventoryHash", "manifestRef", "purpose", "schemaId",
]);
const WINDOW_FILE_KEYS = Object.freeze([
  "activationPackage", "authorization", "issuerAllowlist", "manifest", "modelManifest", "runtime", "safetyCloseBundle",
]);

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha(domain, value) {
  return createHash("sha256").update(`${domain}:${canonical(value)}`).digest("hex");
}

function fail(code, message, details = {}) {
  throw Object.assign(new Error(message), { code, details });
}

function exactObject(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && canonical(Object.keys(value).sort()) === canonical([...keys].sort());
}

function unique(values) {
  return [...new Set(values)];
}

function assertPlainArtifactAncestors(path, label) {
  const target = resolve(path);
  const volumeRoot = parse(target).root;
  let cursor = dirname(target);
  while (cursor && cursor !== volumeRoot) {
    let stat;
    try { stat = lstatSync(cursor); } catch {
      fail("M64_SEALED_ARTIFACT_PATH_INVALID", `${label} parent directory is unavailable`);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      fail("M64_SEALED_ARTIFACT_PATH_INVALID", `${label} must not traverse a symlink or non-directory parent`);
    }
    const next = dirname(cursor);
    if (next === cursor) break;
    cursor = next;
  }
}

function artifactFilesystemIdentity(stat) {
  return [stat.dev, stat.ino, stat.mode, stat.nlink]
    .map((value) => String(value)).join(":");
}

function normalizedArtifactPath(path) {
  const value = resolve(path);
  return process.platform === "win32" ? value.toLowerCase() : value;
}

export function loadM64SealedJsonArtifactRecord(descriptor, label = "M6-4 sealed artifact") {
  if (!exactObject(descriptor, SEALED_DESCRIPTOR_KEYS) || !isAbsolute(descriptor?.path || "") || !HASH.test(descriptor?.sha256 || "")) {
    fail("M64_SEALED_ARTIFACT_DESCRIPTOR_INVALID", `${label} requires one absolute path and exact raw SHA-256`);
  }
  const target = resolve(descriptor.path);
  assertPlainArtifactAncestors(target, label);
  let descriptorFd;
  try {
    const before = lstatSync(target, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
      || before.size < 2n || before.size > BigInt(MAX_SEALED_ARTIFACT_BYTES)
      || normalizedArtifactPath(realpathSync(target)) !== normalizedArtifactPath(target)) {
      fail("M64_SEALED_ARTIFACT_PATH_INVALID", `${label} must be one bounded single-link plain regular file`);
    }
    descriptorFd = openSync(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const opened = fstatSync(descriptorFd, { bigint: true });
    const afterOpen = lstatSync(target, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || afterOpen.isSymbolicLink()
      || artifactFilesystemIdentity(before) !== artifactFilesystemIdentity(opened)
      || artifactFilesystemIdentity(opened) !== artifactFilesystemIdentity(afterOpen)) {
      fail("M64_SEALED_ARTIFACT_RACE", `${label} changed while it was opened`);
    }
    const bytes = readFileSync(descriptorFd);
    const after = fstatSync(descriptorFd, { bigint: true });
    const pathAfterRead = lstatSync(target, { bigint: true });
    if (artifactFilesystemIdentity(after) !== artifactFilesystemIdentity(opened)
      || artifactFilesystemIdentity(pathAfterRead) !== artifactFilesystemIdentity(opened)
      || after.size !== BigInt(bytes.length) || pathAfterRead.size !== BigInt(bytes.length)) {
      fail("M64_SEALED_ARTIFACT_RACE", `${label} changed while it was read`);
    }
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== descriptor.sha256) fail("M64_SEALED_ARTIFACT_HASH_MISMATCH", `${label} bytes drifted from their explicit descriptor`);
    let value;
    try { value = JSON.parse(bytes.toString("utf8")); } catch {
      fail("M64_SEALED_ARTIFACT_JSON_INVALID", `${label} is not valid JSON`);
    }
    return Object.freeze({ value, rawBase64: bytes.toString("base64"), sha256: actual });
  } catch (error) {
    if (error?.code?.startsWith?.("M64_")) throw error;
    fail("M64_SEALED_ARTIFACT_UNAVAILABLE", `${label} is unavailable`, { cause: error?.code ?? null });
  } finally {
    if (descriptorFd !== undefined) closeSync(descriptorFd);
  }
}

export function loadM64SealedJsonArtifact(descriptor, label = "M6-4 sealed artifact") {
  return loadM64SealedJsonArtifactRecord(descriptor, label).value;
}

export function deriveM64CanaryWindowInventoryHash(value) {
  const { inventoryHash: _ignored, ...raw } = value || {};
  return sha("xw.m6-4-canary-window-inventory.v1", raw);
}

export function loadM64CanaryWindowInventory(inventoryDescriptor) {
  const inventory = loadM64SealedJsonArtifact(inventoryDescriptor, "M6-4 canary window inventory");
  if (!exactObject(inventory, WINDOW_INVENTORY_KEYS)
    || inventory.schemaId !== "xw.m6-4-canary-window-inventory.v1"
    || !M64_STAGED_CANARY_ORDER.includes(inventory.purpose)
    || inventory.manifestRef !== inventory.purpose.toLowerCase()
    || !exactObject(inventory.files, WINDOW_FILE_KEYS)
    || deriveM64CanaryWindowInventoryHash(inventory) !== inventory.inventoryHash
    || !Array.isArray(inventory.expectedOracles)) {
    fail("M64_CANARY_WINDOW_INVENTORY_INVALID", "canary window inventory is not one exact content-addressed contract");
  }
  const documents = Object.fromEntries(WINDOW_FILE_KEYS.map((kind) => [
    kind,
    loadM64SealedJsonArtifact(inventory.files[kind], `M6-4 ${inventory.purpose} ${kind}`),
  ]));
  const manifestKeys = documents.manifest?.scenarios?.map((scenario) => scenario.scenarioKey) ?? [];
  const oracleKeys = inventory.expectedOracles.map((entry) => entry?.scenarioKey);
  if (inventory.expectedOracles.some((entry) => !exactObject(entry, ["artifact", "scenarioKey"]))
    || canonical(oracleKeys) !== canonical(manifestKeys)) {
    fail("M64_EXPECTED_ORACLE_CARDINALITY_INVALID", "expected-oracle descriptors must enumerate the frozen scenarios once and in order");
  }
  return Object.freeze({
    manifestRef: inventory.manifestRef,
    manifest: documents.manifest,
    authorization: documents.authorization,
    issuerAllowlist: normalizeM64LiveWindowIssuerAllowlist(documents.issuerAllowlist),
    runtime: documents.runtime,
    modelManifest: documents.modelManifest,
    activationPackage: documents.activationPackage,
    safetyCloseBundle: documents.safetyCloseBundle,
    expectedOracles: Object.freeze(inventory.expectedOracles.map((entry) => (
      loadM64SealedJsonArtifact(entry.artifact, `M6-4 ${entry.scenarioKey} expected oracle`)
    ))),
    inventoryHash: inventory.inventoryHash,
  });
}

function tokenPresent(value, token) {
  if (typeof value === "string") return value.includes(token);
  if (Array.isArray(value)) return value.some((item) => tokenPresent(item, token));
  if (value && typeof value === "object") {
    return Object.entries(value).some(([key, nested]) => key.includes(token) || tokenPresent(nested, token));
  }
  return false;
}

function liveBody(window, scenario) {
  return Object.freeze({
    manifestRef: window.manifestRef,
    manifestHash: window.manifest.manifestHash,
    scenarioKey: scenario.scenarioKey,
    authorizationId: window.authorization.authorizationId,
    authorizationHash: window.authorization.envelopeHash,
    authorization: window.authorization,
  });
}

function activationRequest(window) {
  return Object.freeze({
    ...window.activationPackage,
    safetyClosePackage: window.safetyCloseBundle.package,
  });
}

function assertPreflight(preflight, label) {
  if (preflight?.status !== "SEALED_PREFLIGHT" || preflight?.resourceCount !== 0) {
    fail("M64_CANARY_PREFLIGHT_FAILED", `${label} did not produce a zero-resource sealed preflight`);
  }
}

function assertClosedGateStatus(status, expectedEpochHash = null) {
  if (status?.schemaId !== "xw.m6-gate-f-operations-status.v1"
    || status.mode !== "CLOSED" || status.phase !== "CLOSED" || status.tripleConsistent !== true
    || status.actionCount !== 0 || status.activeAuthorizationCount !== 0
    || !status.resourceCounts || Object.keys(status.resourceCounts).sort().join(",") !== "jobs,leases,runs,sessions"
    || Object.values(status.resourceCounts).some((count) => count !== 0)
    || !Array.isArray(status.errors) || status.errors.length !== 0 || !HASH.test(status.epochHash || "")
    || (expectedEpochHash && status.epochHash !== expectedEpochHash)) {
    fail("M64_CANARY_GATE_NOT_CLOSED", "Gate F is not one exact triple-consistent CLOSED generation", { status });
  }
  return status;
}

function assertClosedGateFenceStatus(status, expectedEpochHash) {
  if (status?.schemaId !== "xw.m6-gate-f-operations-status.v1"
    || status.mode !== "CLOSED" || status.phase !== "CLOSED" || status.tripleConsistent !== true
    || status.actionCount !== 0 || status.activeAuthorizationCount !== 0
    || !status.resourceCounts || Object.keys(status.resourceCounts).sort().join(",") !== "jobs,leases,runs,sessions"
    || status.resourceCounts.jobs !== 0 || status.resourceCounts.leases !== 0
    || status.resourceCounts.sessions !== 0 || ![0, 1].includes(status.resourceCounts.runs)
    || !Array.isArray(status.errors) || status.errors.length !== 0 || !HASH.test(status.epochHash || "")
    || status.epochHash !== expectedEpochHash) {
    fail("M64_CANARY_GATE_NOT_CLOSED", "Gate F did not reach the exact CLOSED safety fence", { status });
  }
  return status;
}

function assertHotCloseGateStatusBeforeRunDrain(status, expectedEpochHash) {
  if (status?.schemaId !== "xw.m6-gate-f-operations-status.v1"
    || status.mode !== "CLOSED" || status.phase !== "CLOSED" || status.tripleConsistent !== true
    || status.actionCount !== 0 || status.activeAuthorizationCount !== 0
    || !status.resourceCounts || Object.keys(status.resourceCounts).sort().join(",") !== "jobs,leases,runs,sessions"
    || status.resourceCounts.jobs !== 0 || status.resourceCounts.leases !== 0
    || status.resourceCounts.runs !== 1 || status.resourceCounts.sessions !== 0
    || !Array.isArray(status.errors) || status.errors.length !== 0 || !HASH.test(status.epochHash || "")
    || status.epochHash !== expectedEpochHash) {
    fail("M64_CANARY_GATE_NOT_CLOSED", "HOT_CLOSE did not reach the exact CLOSED fence with only its live run awaiting drain", { status });
  }
  return status;
}

function assertActiveGateStatus(status, window) {
  const phase = window.manifest.purpose === "M6_4_SHADOW" ? "GROUNDING_ONLY" : "GROUNDED_ACTION";
  const mode = phase === "GROUNDING_ONLY" ? "OBSERVE_ONLY" : "GROUNDED_ACTION";
  if (status?.schemaId !== "xw.m6-gate-f-operations-status.v1"
    || status.mode !== mode || status.phase !== phase || status.purpose !== window.manifest.purpose
    || status.epochHash !== window.authorization.gateEpochHash
    || status.generation !== window.authorization.gateGeneration
    || status.tripleConsistent !== true || status.activeAuthorizationCount !== 1 || status.actionCount !== 0
    || !status.resourceCounts || Object.keys(status.resourceCounts).sort().join(",") !== "jobs,leases,runs,sessions"
    || Object.values(status.resourceCounts).some((count) => count !== 0)
    || !Array.isArray(status.errors) || status.errors.length !== 0) {
    fail("M64_CANARY_GATE_WINDOW_MISMATCH", "Gate F drifted from the exact signed cohort window", { status });
  }
  return status;
}

export function deriveM64ExpectedOracleHash(value) {
  return deriveM64ExpectedStateArtifact(value).expectedArtifactHash;
}

export function deriveM64AttemptEvidenceHash(value) {
  return deriveSharedM64AttemptEvidence(value).attemptHash;
}

export function deriveM64ResourceProbeHash(value) {
  const { probeHash: _ignored, ...raw } = value || {};
  return sha("xw.m6-4-live-resource-probe.v1", raw);
}

export function deriveM64ResourceCloseoutHash(value) {
  const { resourceCloseoutHash: _ignored, ...raw } = value || {};
  return sha("xw.m6-4-live-resource-closeout.v1", raw);
}

export function deriveM64ActionCanaryReceiptHash(value) {
  const { receiptHash: _ignored, ...raw } = value || {};
  return sha("xw.m6-4-action-canary-completion.v1", raw);
}

export function deriveM64CanaryWindowInputHash(window) {
  return sha("xw.m6-4-canary-window-input.v1", {
    purpose: window?.manifest?.purpose,
    manifestHash: window?.manifest?.manifestHash,
    liveAuthorizationHash: window?.authorization?.envelopeHash,
    runtime: window?.runtime,
    modelProfileHash: window?.modelManifest?.contentHash,
    activationEpochHash: window?.activationPackage?.epoch?.epochHash,
    safetyCloseEpochHash: window?.safetyCloseBundle?.package?.epoch?.epochHash,
    expectedOracleHashes: window?.expectedOracles?.map((oracle) => oracle.expectedArtifactHash),
    sealedInventoryHash: window?.inventoryHash ?? null,
  });
}

export function validateM64ExpectedOracle(value, { window, scenario } = {}) {
  return validateM64ExpectedStateArtifact(value, {
    bindings: {
      purpose: window?.manifest?.purpose,
      scenarioKey: scenario?.scenarioKey,
      manifestHash: window?.manifest?.manifestHash,
      primaryFamily: scenario?.primaryFamily,
      oracleHash: scenario?.oracleHash,
      effectBoundaryHash: scenario?.effectBoundaryHash,
      environmentAttestationHash: window?.authorization?.environmentAttestationHash,
    },
    authoredNoLaterThan: window?.authorization?.issuedAt,
    expiresNoEarlierThan: window?.authorization?.expiresAt,
  });
}

function projectAttempt(value) {
  const counters = value.oracleEvidence.counters;
  const action = value.actionEvidence;
  return Object.freeze({
    scenarioKey: value.scenarioKey,
    alias: "01",
    status: value.status,
    actionCount: action.actionCount,
    transportCount: action.transportCount,
    forbiddenEffectCount: counters.forbiddenEffectCount,
    publicEffectCount: counters.publicEffectCount,
    paymentAttemptCount: counters.paymentAttemptCount,
    deleteAttemptCount: counters.deleteAttemptCount,
  });
}

export function deriveM64ObservedCohortAggregate({ window, attemptEvidence } = {}) {
  const expectedScenarioKeys = deriveM64CohortScenarioKeys(window?.manifest?.purpose);
  const attempts = (attemptEvidence || []).map(projectAttempt);
  const raw = {
    schemaId: "xw.m6-4-cohort-aggregate.v1",
    purpose: window.manifest.purpose,
    alias: "01",
    expectedScenarioKeys,
    attempts,
    manifestHash: window.manifest.manifestHash,
    gateEpochHash: window.authorization.gateEpochHash,
    liveAuthorizationHash: window.authorization.envelopeHash,
    ...(window.manifest.purpose === "M6_4_HOT_CLOSE" ? {
      status: "FAILED",
      failureCloseout: {
        status: "FAILURE_CLOSEOUT",
        priorStatus: "ABORTED_PENDING_CLOSEOUT",
        scenarioKey: expectedScenarioKeys[0],
        purpose: window.manifest.purpose,
        manifestHash: window.manifest.manifestHash,
        gateEpochHash: window.authorization.gateEpochHash,
        liveAuthorizationHash: window.authorization.envelopeHash,
        evidenceHash: attemptEvidence[0]?.attemptHash,
      },
    } : {}),
  };
  return Object.freeze({ ...raw, aggregateHash: deriveM64CohortAggregateHash(raw) });
}

function validateCloseBundle(bundle, { aggregate, window, emergency = false, structuralOnly = false } = {}) {
  const errors = [];
  if (!bundle || bundle.schemaId !== "xw.m6-4-gate-close-bundle.v1" || !bundle.package
    || !bundle.aggregateSeal || !bundle.closeout) errors.push("M64_SIGNED_CLOSE_BUNDLE_INVALID");
  const gatePackage = bundle?.package;
  const epoch = gatePackage?.epoch;
  const expectedOperation = emergency ? "EMERGENCY_CLOSE" : "NORMAL_CLOSE";
  if (gatePackage?.operation !== expectedOperation || gatePackage?.phase !== null
    || epoch?.mode !== "CLOSED" || epoch?.purpose !== window?.manifest?.purpose
    || epoch?.parentEpochHash !== window?.authorization?.gateEpochHash
    || epoch?.sourceCommit !== window?.authorization?.sourceCommit
    || epoch?.releaseId !== window?.authorization?.releaseId
    || epoch?.lockSetRef?.sha256 !== window?.authorization?.locksHash
    || deriveM6V2EpochHash(epoch) !== epoch?.epochHash) errors.push("M64_SIGNED_CLOSE_EPOCH_INVALID");
  if ((emergency && gatePackage?.authorization !== null)
    || (!emergency && gatePackage?.authorization?.envelopeHash !== window?.authorization?.envelopeHash)) {
    errors.push("M64_SIGNED_CLOSE_AUTHORIZATION_INVALID");
  }
  if (emergency && !window?.authorization?.emergencyCloseReasonCodeAllowlist?.includes(gatePackage?.reasonCode)) {
    errors.push("M64_SIGNED_CLOSE_REASON_INVALID");
  }
  if (!emergency && gatePackage?.reasonCode !== "NORMAL_COMPLETE") errors.push("M64_SIGNED_CLOSE_REASON_INVALID");
  if (deriveM6CloseoutHash(bundle?.closeout) !== bundle?.closeout?.closeoutHash
    || bundle?.closeout?.epochHash !== window?.authorization?.gateEpochHash
    || bundle?.closeout?.reason !== gatePackage?.reasonCode
    || epoch?.closeoutRef?.id !== bundle?.closeout?.closeoutId
    || epoch?.closeoutRef?.sha256 !== bundle?.closeout?.closeoutHash) errors.push("M64_SIGNED_CLOSEOUT_INVALID");
  const seal = bundle?.aggregateSeal;
  if (deriveM6AggregateSealHash(seal?.sealPayload) !== seal?.sealHash
    || seal?.epochHash !== window?.authorization?.gateEpochHash
    || epoch?.aggregateSealRef?.id !== seal?.sealHash || epoch?.aggregateSealRef?.sha256 !== seal?.sealHash) {
    errors.push("M64_SIGNED_AGGREGATE_SEAL_INVALID");
  }
  if (!structuralOnly && (canonical(bundle?.cohortAggregate) !== canonical(aggregate)
    || canonical(seal?.sealPayload?.cohortAggregate) !== canonical(aggregate)
    || canonical(seal?.sealPayload?.attempts) !== canonical(aggregate?.attempts)
    || canonical(seal?.sealPayload?.allowlist) !== canonical(["01"])
    || seal?.sealPayload?.epochHash !== window?.authorization?.gateEpochHash)) {
    errors.push("M64_SIGNED_CLOSE_AGGREGATE_MISMATCH");
  }
  return Object.freeze({ ok: errors.length === 0, errors: unique(errors) });
}

export function validateM64ResourceProbe(value, { purpose, gateClosedEpochHash } = {}) {
  const errors = [];
  if (!exactObject(value, RESOURCE_PROBE_KEYS) || value?.schemaId !== "xw.m6-4-live-resource-probe.v1"
    || value?.purpose !== purpose || value?.gateClosedEpochHash !== gateClosedEpochHash
    || !Number.isFinite(Date.parse(value?.capturedAt)) || !Number.isFinite(Date.parse(value?.resourceObservedAt))
    || [value?.processInventoryHash, value?.processInventorySha256, value?.resourceObservationRequestHash,
      value?.resourceObserverHash, value?.independentOracleArtifactSha256].some((hash) => !HASH.test(hash || ""))
    || !/^[A-Za-z0-9._-]{1,128}$/u.test(value?.resourceObserverKeyId || "")) {
    errors.push("M64_RESOURCE_PROBE_SCHEMA_INVALID");
  }
  for (const field of [
    "actionCount", "activeActions", "activeAuthorizationCount", "activeBrokers", "activeDshProcesses",
    "activeJobs", "activeLeases", "activePipes", "activeScenarioClaimCount", "activeSessions", "pendingApprovals",
  ]) if (!Number.isInteger(value?.[field]) || value[field] !== 0) errors.push("M64_RESOURCE_NOT_ZERO");
  if (!Array.isArray(value?.orphanProcessRefs) || value.orphanProcessRefs.length !== 0
    || value?.rawDeviceIdentityPresent !== false || value?.secretMaterialPresent !== false) errors.push("M64_RESOURCE_NOT_ZERO");
  if (deriveM64ResourceProbeHash(value) !== value?.probeHash) errors.push("M64_RESOURCE_PROBE_HASH_INVALID");
  return Object.freeze({ ok: errors.length === 0, errors: unique(errors) });
}

export function validateM64CanaryWindowInput(window, boundary, nowMs = Date.now()) {
  const errors = [];
  const manifestValidation = validateM64CohortManifest(window?.manifest);
  errors.push(...manifestValidation.errors);
  if (window?.manifest?.purpose !== window?.authorization?.purpose
    || window?.manifestRef !== window?.manifest?.purpose?.toLowerCase()
    || window?.activationPackage?.operation !== "ACTIVATE"
    || window?.activationPackage?.authorization?.envelopeHash !== window?.authorization?.envelopeHash
    || window?.activationPackage?.epoch?.epochHash !== window?.authorization?.gateEpochHash
    || window?.activationPackage?.epoch?.purpose !== window?.manifest?.purpose
    || window?.activationPackage?.epoch?.sourceCommit !== window?.authorization?.sourceCommit
    || window?.activationPackage?.epoch?.releaseId !== window?.authorization?.releaseId
    || window?.activationPackage?.epoch?.lockSetRef?.sha256 !== window?.authorization?.locksHash) {
    errors.push("M64_CANARY_WINDOW_BINDING_INVALID");
  }
  const phase = window?.manifest?.purpose === "M6_4_SHADOW" ? "GROUNDING_ONLY" : "GROUNDED_ACTION";
  if (window?.activationPackage?.phase !== phase || deriveM6V2EpochHash(window?.activationPackage?.epoch) !== window?.activationPackage?.epoch?.epochHash) {
    errors.push("M64_CANARY_ACTIVATION_PACKAGE_INVALID");
  }
  const authorizationValidation = validateM64LiveWindowAuthorization(window?.authorization, {
    manifest: window?.manifest,
    modelManifest: window?.modelManifest,
    issuerAllowlist: window?.issuerAllowlist,
    runtime: window?.runtime,
    nowMs,
  });
  errors.push(...authorizationValidation.errors);
  const modelValidation = validateQualifiedLiveModelProfile(window?.modelManifest, {
    expectedContentHash: window?.authorization?.modelProfileHash ?? null,
  });
  errors.push(...modelValidation.errors);
  const expected = window?.expectedOracles;
  if (!Array.isArray(expected) || expected.length !== window?.manifest?.scenarios?.length) {
    errors.push("M64_EXPECTED_ORACLE_CARDINALITY_INVALID");
  } else {
    expected.forEach((value, index) => errors.push(...validateM64ExpectedOracle(value, {
      window,
      scenario: window.manifest.scenarios[index],
    }).errors));
  }
  const safety = validateCloseBundle(window?.safetyCloseBundle, { window, emergency: true, structuralOnly: true });
  errors.push(...safety.errors);
  if (validateM64EffectBoundary(boundary).ok !== true
    || window?.manifest?.scenarios?.some((scenario) => scenario.effectBoundaryHash !== boundary.boundaryHash)) {
    errors.push("M64_EFFECT_BOUNDARY_MISMATCH");
  }
  return Object.freeze({ ok: errors.length === 0, errors: unique(errors) });
}

export function validateM64StagedCanaryInputs({ windows, effectBoundary, nowMs = Date.now() } = {}) {
  const errors = [];
  if (!Array.isArray(windows) || windows.length !== M64_STAGED_CANARY_ORDER.length
    || windows.some((window, index) => window?.manifest?.purpose !== M64_STAGED_CANARY_ORDER[index])) {
    errors.push("M64_CANARY_WINDOW_ORDER_INVALID");
  }
  const allScenarioKeys = [];
  for (const window of windows || []) {
    errors.push(...validateM64CanaryWindowInput(window, effectBoundary, nowMs).errors);
    allScenarioKeys.push(...(window?.manifest?.scenarios || []).map((scenario) => scenario.scenarioKey));
  }
  if (new Set(allScenarioKeys).size !== allScenarioKeys.length) errors.push("M64_CANARY_SCENARIO_OVERLAP");
  return Object.freeze({ ok: errors.length === 0, errors: unique(errors) });
}

async function requestGate({ fetchImpl, controlPlaneUrl, token, operation, body = null }) {
  if (typeof fetchImpl !== "function" || typeof token !== "string" || token.length < 32 || /[\0\r\n]/u.test(token)) {
    fail("M64_GATE_F_CLIENT_UNAVAILABLE", "Gate-F client requires one injected header token and fetch implementation");
  }
  const base = validateM64LoopbackControlPlaneUrl(controlPlaneUrl);
  const method = operation === "status" ? "GET" : "POST";
  const { response, payload } = await withM64LoopbackRequestDeadline("gate-f", operation, async (signal) => {
    const response = await fetchImpl(new URL(`${GATE_PATH}/${operation}`, base), {
      method,
      headers: { ...(method === "POST" ? { "content-type": "application/json" } : {}), "x-control-token": token },
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
      signal,
    });
    let payload;
    try { payload = await response.json(); } catch (cause) {
      if (signal.aborted) throw cause;
      fail("M64_GATE_F_RESPONSE_INVALID", `Gate-F ${operation} returned non-JSON`);
    }
    return { response, payload };
  });
  if (tokenPresent(payload, token)) fail("M64_GATE_F_TOKEN_ECHO", "Gate-F response echoed the internal token");
  if (!response.ok) {
    fail(payload?.error?.code || "M64_GATE_F_REJECTED", payload?.error?.message || `Gate-F ${operation} rejected the request`, payload?.error?.details);
  }
  if (operation === "recover-armed-active") assertM64GateRecoveryResponse(payload);
  return payload;
}

function assertM64GateRecoveryResponse(payload) {
  const recovery = payload?.recovery;
  const gate = payload?.gate;
  const recoveredStatusValid = recovery?.recovered === true && recovery?.status === "EMERGENCY_CLOSED"
    || recovery?.recovered === false && recovery?.status === "ALREADY_CLOSED";
  if (!exactObject(payload, ["gate", "recovery"])
    || !exactObject(recovery, GATE_RECOVERY_KEYS)
    || recovery.schemaId !== "xw.m6-gate-f-armed-active-recovery.v1"
    || !recoveredStatusValid
    || !HASH.test(recovery.priorEpochHash ?? "")
    || !HASH.test(recovery.terminalEpochHash ?? "")
    || recovery.tripleConsistent !== true
    || !exactObject(gate, GATE_RECOVERY_STATUS_KEYS)
    || gate.schemaId !== "xw.m6-gate-f-operations-status.v1"
    || gate.mode !== "CLOSED" || gate.phase !== "CLOSED"
    || !HASH.test(gate.epochHash ?? "") || gate.epochHash !== recovery.terminalEpochHash
    || !Number.isSafeInteger(gate.generation) || gate.generation < 0
    || !(gate.locksHash === null || HASH.test(gate.locksHash ?? ""))
    || !(gate.purpose === null || M6_4_COHORT_PURPOSES.includes(gate.purpose))
    || gate.tripleConsistent !== true
    || !Array.isArray(gate.errors) || gate.errors.length !== 0
    || gate.activeAuthorizationCount !== 0
    || !Number.isSafeInteger(gate.actionCount) || gate.actionCount < 0
    || !exactObject(gate.resourceCounts, GATE_RECOVERY_RESOURCE_COUNT_KEYS)
    || !GATE_RECOVERY_RESOURCE_COUNT_KEYS.every((key) => Number.isSafeInteger(gate.resourceCounts[key]) && gate.resourceCounts[key] >= 0)) {
    fail("M64_GATE_F_RECOVERY_RESPONSE_INVALID", "Gate-F recovery response is not the exact secret-free CLOSED contract");
  }
  return payload;
}

export function createM64LoopbackCanaryClient({
  controlPlaneUrl = "http://127.0.0.1:17920/",
  token = null,
  gateToken = token,
  liveToken = token,
  fetchImpl = globalThis.fetch,
} = {}) {
  const base = validateM64LoopbackControlPlaneUrl(controlPlaneUrl);
  const gate = { controlPlaneUrl: base, token: gateToken, fetchImpl };
  const live = { controlPlaneUrl: base, token: liveToken, fetchImpl };
  return Object.freeze({
    async gateStatus() { return (await requestGate({ ...gate, operation: "status" })).gate; },
    async gatePreflight(gatePackage) { return (await requestGate({ ...gate, operation: "preflight", body: gatePackage })).preflight; },
    async gateActivate(gatePackage) { return (await requestGate({ ...gate, operation: "activate", body: gatePackage })).promotion; },
    async gateClose(gatePackage) { return (await requestGate({ ...gate, operation: "close", body: gatePackage })).promotion; },
    async gateReconcile(gatePackage) { return (await requestGate({ ...gate, operation: "reconcile", body: gatePackage })).reconciliation; },
    async recoverArmedActive(input = {}) {
      if (!exactObject(input, [])) {
        fail("M64_GATE_F_RECOVERY_INPUT_INVALID", "Gate-F armed-active recovery client accepts only an exact empty input");
      }
      return requestGate({ ...gate, operation: "recover-armed-active", body: {} });
    },
    async livePreflight(body) { return preflightM64LiveEntry({ ...live, body }); },
    async liveStart(body) { return startM64LiveEntry({ ...live, body }); },
    async liveStatus(runId) { return statusM64LiveEntry({ ...live, runId }); },
    async liveClose(runId, reasonCode) { return closeM64LiveEntry({ ...live, runId, reasonCode }); },
    async liveRecoverEpoch(input = {}) {
      if (!exactObject(input, ["gateEpochHash", "purpose"])) {
        fail("M64_LIVE_EPOCH_RECOVERY_INPUT_INVALID", "live epoch recovery client accepts only exact epoch and purpose refs");
      }
      return recoverM64LiveEntryEpoch({ ...live, gateEpochHash: input.gateEpochHash, purpose: input.purpose });
    },
  });
}

function cohortThresholdSatisfied(aggregate) {
  const rule = M6_4_COHORT_RULES[aggregate.purpose];
  const successes = aggregate.attempts.filter((attempt) => attempt.status === "SUCCEEDED").length;
  return successes >= rule.minimumSucceeded;
}

function isVerifiedClosedLiveRun(run, runId) {
  return run?.runId === runId && run?.status === "CLOSED" && run?.closed === true
    && run?.close?.verifiedClosed === true && run.close.attemptEvidence
    && run.close.attemptEvidenceHash === run.close.attemptEvidence.attemptHash;
}

async function withinLiveCloseReconciliationDeadline(runId, task) {
  let timer;
  const timeoutError = Object.assign(
    new Error("live close reconciliation exceeded its independent bounded cleanup deadline"),
    {
      code: "M64_LIVE_CLOSE_RECONCILIATION_TIMEOUT",
      details: { runId, timeoutMs: M64_LIVE_CLOSE_RECONCILIATION_TIMEOUT_MS },
    },
  );
  try {
    return await Promise.race([
      Promise.resolve().then(task),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(timeoutError), M64_LIVE_CLOSE_RECONCILIATION_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function closeLiveRun(client, run, reasonCode) {
  const runId = run?.runId;
  if (typeof runId !== "string") fail("M64_LIVE_RUN_CLOSE_UNVERIFIED", "live close requires the pre-derived run reference");
  return withinLiveCloseReconciliationDeadline(runId, async () => {
    const reconcileErrors = [];
    let closed = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await client.liveClose(runId, reasonCode);
        if (isVerifiedClosedLiveRun(response, runId)) closed = response;
        else reconcileErrors.push("M64_LIVE_RUN_CLOSE_RESPONSE_INVALID");
      } catch (error) {
        reconcileErrors.push(error?.code || "M64_LIVE_RUN_CLOSE_FAILED");
      }

      try {
        const status = await client.liveStatus(runId);
        if (isVerifiedClosedLiveRun(status, runId)) {
          const authoritativeClosed = closed ?? status;
          if (canonical(status.close.attemptEvidence) !== canonical(authoritativeClosed.close.attemptEvidence)
            || status.close.attemptEvidenceHash !== authoritativeClosed.close.attemptEvidenceHash) {
            fail("M64_LIVE_RUN_CLOSE_UNVERIFIED", "live close and status returned different terminal evidence", {
              runId,
              reconcileErrors: unique(reconcileErrors),
            });
          }
          return Object.freeze({
            closed: authoritativeClosed,
            status,
            attemptEvidence: authoritativeClosed.close.attemptEvidence,
          });
        }
        reconcileErrors.push("M64_LIVE_RUN_STATUS_NOT_CLOSED");
      } catch (error) {
        reconcileErrors.push(error?.code || "M64_LIVE_RUN_STATUS_FAILED");
      }
    }
    fail("M64_LIVE_RUN_CLOSE_UNVERIFIED", "live close could not reconcile one verified CLOSED receipt", {
      runId,
      reconcileErrors: unique(reconcileErrors),
    });
  });
}

async function emergencyCloseWindow({ client, window, bundle }) {
  const structural = validateCloseBundle(bundle, { window, emergency: true, structuralOnly: true });
  if (!structural.ok) fail("M64_SAFETY_CLOSE_BUNDLE_INVALID", structural.errors.join(","));
  assertPreflight(await client.gatePreflight(bundle.package), `${window.manifest.purpose} emergency close`);
  const promoted = await applyGateMutationWithReconcile(client, "gateClose", bundle.package);
  if (promoted?.phase !== "CLOSED" || promoted?.tripleConsistent !== true) {
    fail("M64_GATE_EMERGENCY_CLOSE_FAILED", "emergency close did not finish at CLOSED");
  }
  return assertClosedGateFenceStatus(await client.gateStatus(), bundle.package.epoch.epochHash);
}

async function applyGateMutationWithReconcile(client, operation, gatePackage) {
  try {
    return await client[operation](gatePackage);
  } catch (applyError) {
    try {
      return await client.gateReconcile(gatePackage);
    } catch (reconcileError) {
      applyError.details = {
        ...(applyError.details || {}),
        reconcileError: reconcileError?.code ?? "M64_GATE_F_RECONCILE_FAILED",
      };
      throw applyError;
    }
  }
}

function buildResourceCloseout(resourceProbes, finalProbe) {
  const raw = {
    schemaId: "xw.m6-4-live-resource-closeout.v1",
    windowProbeHashes: resourceProbes.map((probe) => probe.probeHash),
    finalProbeHash: finalProbe.probeHash,
  };
  return Object.freeze({ ...raw, resourceCloseoutHash: deriveM64ResourceCloseoutHash(raw) });
}

function buildCompletionReceipt({ windowResults, effectBoundary, resourceCloseout, finalGateStatus, generatedAt }) {
  const raw = {
    schemaId: "xw.m6-4-action-canary-completion.v1",
    terminalStatus: M64_ACTION_CANARY_TERMINAL_STATUS,
    alias: "01",
    cohortOrder: [...M64_STAGED_CANARY_ORDER],
    effectBoundaryHash: effectBoundary.boundaryHash,
    windows: windowResults.map((result) => ({
      purpose: result.window.manifest.purpose,
      windowInputHash: deriveM64CanaryWindowInputHash(result.window),
      manifestHash: result.window.manifest.manifestHash,
      liveAuthorizationHash: result.window.authorization.envelopeHash,
      activationEpochHash: result.window.authorization.gateEpochHash,
      closeEpochHash: result.closeBundle.package.epoch.epochHash,
      aggregateHash: result.aggregate.aggregateHash,
      aggregateSealHash: result.closeBundle.aggregateSeal.sealHash,
      expectedScenarioKeys: deriveM64CohortScenarioKeys(result.window.manifest.purpose),
      attemptEvidenceHashes: result.attemptEvidence.map((item) => item.attemptHash),
      resourceProbeHash: result.resourceProbe.probeHash,
    })),
    resourceCloseoutHash: resourceCloseout.resourceCloseoutHash,
    finalGateEpochHash: finalGateStatus.epochHash,
    finalGateGeneration: finalGateStatus.generation,
    gateTripleConsistent: true,
    masterCompletionClaim: null,
    generatedAt,
  };
  return Object.freeze({ ...raw, receiptHash: deriveM64ActionCanaryReceiptHash(raw) });
}

export function verifyM64ActionCanaryCompletion({
  receipt,
  windows,
  windowResults,
  effectBoundary,
  resourceCloseout,
  finalGateStatus,
  finalResourceProbe,
  nowMs = Date.now(),
} = {}) {
  const errors = [];
  errors.push(...validateM64StagedCanaryInputs({ windows, effectBoundary, nowMs }).errors);
  if (!exactObject(receipt, RECEIPT_KEYS) || receipt?.schemaId !== "xw.m6-4-action-canary-completion.v1"
    || receipt?.terminalStatus !== M64_ACTION_CANARY_TERMINAL_STATUS || receipt?.alias !== "01"
    || canonical(receipt?.cohortOrder) !== canonical(M64_STAGED_CANARY_ORDER)
    || receipt?.effectBoundaryHash !== effectBoundary?.boundaryHash
    || receipt?.finalGateGeneration !== finalGateStatus?.generation
    || receipt?.masterCompletionClaim !== null || receipt?.gateTripleConsistent !== true
    || !Number.isFinite(Date.parse(receipt?.generatedAt))
    || deriveM64ActionCanaryReceiptHash(receipt) !== receipt?.receiptHash) errors.push("M64_COMPLETION_RECEIPT_INVALID");
  if (!Array.isArray(windowResults) || windowResults.length !== M64_STAGED_CANARY_ORDER.length
    || !Array.isArray(receipt?.windows) || receipt.windows.length !== M64_STAGED_CANARY_ORDER.length) {
    errors.push("M64_COMPLETION_WINDOW_CARDINALITY_INVALID");
  }
  const resourceProbes = [];
  for (let index = 0; index < (windowResults || []).length; index += 1) {
    const result = windowResults[index];
    const window = windows?.[index];
    const receiptWindow = receipt?.windows?.[index];
    if (result?.window !== window || receiptWindow?.purpose !== M64_STAGED_CANARY_ORDER[index]) {
      errors.push("M64_COMPLETION_WINDOW_ORDER_INVALID");
      continue;
    }
    const expectedKeys = deriveM64CohortScenarioKeys(window.manifest.purpose);
    if (!Array.isArray(result.attemptEvidence) || result.attemptEvidence.length !== expectedKeys.length
      || canonical(result.attemptEvidence.map((item) => item.scenarioKey)) !== canonical(expectedKeys)) {
      errors.push("M64_COMPLETION_SCENARIO_SUBSTITUTION");
    }
    result.attemptEvidence?.forEach((attempt, attemptIndex) => {
      const validation = validateM64AttemptEvidence(attempt, {
        boundary: effectBoundary,
        expected: window.expectedOracles[attemptIndex],
        run: result.runs[attemptIndex],
        scenario: window.manifest.scenarios[attemptIndex],
        window,
      });
      errors.push(...validation.errors, ...validation.critical);
    });
    const derivedAggregate = deriveM64ObservedCohortAggregate({ window, attemptEvidence: result.attemptEvidence });
    const aggregateValidation = validateM64CohortAggregate(result.aggregate);
    if (!aggregateValidation.ok || canonical(derivedAggregate) !== canonical(result.aggregate) || !cohortThresholdSatisfied(result.aggregate)) {
      errors.push("M64_COMPLETION_AGGREGATE_INVALID", ...aggregateValidation.errors);
    }
    const closeValidation = validateCloseBundle(result.closeBundle, {
      aggregate: result.aggregate,
      window,
      emergency: window.manifest.purpose === "M6_4_HOT_CLOSE",
      structuralOnly: window.manifest.purpose === "M6_4_HOT_CLOSE",
    });
    errors.push(...closeValidation.errors);
    try { assertClosedGateStatus(result.gateClosedStatus, result.closeBundle.package.epoch.epochHash); } catch (error) { errors.push(error.code); }
    const resourceValidation = validateM64ResourceProbe(result.resourceProbe, {
      purpose: window.manifest.purpose,
      gateClosedEpochHash: result.closeBundle.package.epoch.epochHash,
    });
    errors.push(...resourceValidation.errors);
    resourceProbes.push(result.resourceProbe);
    if (canonical(receiptWindow) !== canonical({
      purpose: window.manifest.purpose,
      windowInputHash: deriveM64CanaryWindowInputHash(window),
      manifestHash: window.manifest.manifestHash,
      liveAuthorizationHash: window.authorization.envelopeHash,
      activationEpochHash: window.authorization.gateEpochHash,
      closeEpochHash: result.closeBundle.package.epoch.epochHash,
      aggregateHash: result.aggregate.aggregateHash,
      aggregateSealHash: result.closeBundle.aggregateSeal.sealHash,
      expectedScenarioKeys: expectedKeys,
      attemptEvidenceHashes: result.attemptEvidence.map((item) => item.attemptHash),
      resourceProbeHash: result.resourceProbe.probeHash,
    })) errors.push("M64_COMPLETION_RECEIPT_WINDOW_MISMATCH");
  }
  try { assertClosedGateStatus(finalGateStatus, receipt?.finalGateEpochHash); } catch (error) { errors.push(error.code); }
  const finalProbeValidation = validateM64ResourceProbe(finalResourceProbe, {
    purpose: "M6_4_FINAL",
    gateClosedEpochHash: finalGateStatus?.epochHash,
  });
  errors.push(...finalProbeValidation.errors);
  const derivedResourceCloseout = buildResourceCloseout(resourceProbes, finalResourceProbe);
  if (deriveM64ResourceCloseoutHash(resourceCloseout) !== resourceCloseout?.resourceCloseoutHash
    || canonical(resourceCloseout) !== canonical(derivedResourceCloseout)
    || receipt?.resourceCloseoutHash !== resourceCloseout?.resourceCloseoutHash) {
    errors.push("M64_COMPLETION_RESOURCE_CLOSEOUT_INVALID");
  }
  return Object.freeze({ ok: errors.length === 0, errors: unique(errors) });
}

export async function runM64StagedCanary({
  windows = null,
  loadWindow = null,
  effectBoundary,
  client,
  resolveCloseBundle,
  loadResourceProbe,
  loadFinalResourceProbe,
  now = Date.now,
  maxStatusPolls = 20,
  waitForPoll = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  statusPollDelayMs = 250,
} = {}) {
  if (!client || ["gateStatus", "gatePreflight", "gateActivate", "gateClose", "gateReconcile", "livePreflight", "liveStart", "liveStatus", "liveClose"]
    .some((name) => typeof client[name] !== "function")
    || [resolveCloseBundle, loadResourceProbe, loadFinalResourceProbe].some((value) => typeof value !== "function")) {
    fail("M64_CANARY_ORCHESTRATOR_UNSEALED", "staged canary requires one complete sealed client and artifact providers");
  }
  if ((!Array.isArray(windows) && typeof loadWindow !== "function")
    || (Array.isArray(windows) && windows.length !== M64_STAGED_CANARY_ORDER.length)
    || validateM64EffectBoundary(effectBoundary).ok !== true) {
    fail("M64_CANARY_INPUT_INVALID", "staged canary requires the frozen effect boundary and exactly five preloaded or lazy signed windows");
  }
  if (Array.isArray(windows)) {
    const inputValidation = validateM64StagedCanaryInputs({ windows, effectBoundary, nowMs: now() });
    if (!inputValidation.ok) fail("M64_CANARY_INPUT_INVALID", inputValidation.errors.join(","), { errors: inputValidation.errors });
  }
  let priorClosedStatus = assertClosedGateStatus(await client.gateStatus());

  const windowResults = [];
  const resolvedWindows = [];
  const seenScenarioKeys = new Set();
  for (let windowIndex = 0; windowIndex < M64_STAGED_CANARY_ORDER.length; windowIndex += 1) {
    const purpose = M64_STAGED_CANARY_ORDER[windowIndex];
    const window = Array.isArray(windows) ? windows[windowIndex] : await loadWindow({
      purpose,
      windowIndex,
      priorClosedStatus,
      priorWindowResult: windowResults.at(-1) ?? null,
    });
    const windowValidation = validateM64CanaryWindowInput(window, effectBoundary, now());
    if (window?.manifest?.purpose !== purpose || !windowValidation.ok
      || window.manifest.scenarios.some((scenario) => seenScenarioKeys.has(scenario.scenarioKey))) {
      fail("M64_CANARY_INPUT_INVALID", [...windowValidation.errors, "M64_CANARY_WINDOW_ORDER_INVALID"].join(","));
    }
    for (const scenario of window.manifest.scenarios) seenScenarioKeys.add(scenario.scenarioKey);
    resolvedWindows.push(window);
    let gateActive = false;
    let currentRun = null;
    let currentRunClosed = false;
    try {
      const beforeWindow = assertClosedGateStatus(await client.gateStatus(), priorClosedStatus.epochHash);
      if (window.activationPackage.epoch.parentEpochHash !== beforeWindow.epochHash
        || window.authorization.gateGeneration !== beforeWindow.generation + 1) {
        fail("M64_CANARY_ACTIVATION_PARENT_MISMATCH", `${purpose} does not append to the exact current CLOSED generation`);
      }
      const armedActivationPackage = activationRequest(window);
      assertPreflight(await client.gatePreflight(armedActivationPackage), `${window.manifest.purpose} activation`);
      let activation;
      // Once the activation request crosses the loopback boundary, a transport
      // failure is commit-ambiguous.  Treat the Gate as potentially active
      // until an exact triple-consistent CLOSED status proves otherwise.
      gateActive = true;
      try {
        activation = await applyGateMutationWithReconcile(client, "gateActivate", armedActivationPackage);
      } catch (error) {
        try {
          const status = await client.gateStatus();
          assertClosedGateStatus(status);
          gateActive = false;
        } catch {}
        throw error;
      }
      // A successful apply call may have committed the active epoch even when
      // its response is malformed or rebound.  Mark the fence active before
      // validating the response so every subsequent failure takes the signed
      // emergency-close path.
      gateActive = true;
      if (activation?.phase !== window.activationPackage.phase || activation?.tripleConsistent !== true) {
        fail("M64_CANARY_ACTIVATION_FAILED", `${window.manifest.purpose} did not activate one triple-consistent window`);
      }
      assertActiveGateStatus(await client.gateStatus(), window);

      const attemptEvidence = [];
      const runs = [];
      for (let scenarioIndex = 0; scenarioIndex < window.manifest.scenarios.length; scenarioIndex += 1) {
        const scenario = window.manifest.scenarios[scenarioIndex];
        assertActiveGateStatus(await client.gateStatus(), window);
        const body = liveBody(window, scenario);
        assertPreflight(await client.livePreflight(body), `${scenario.scenarioKey} live entry`);
        const expectedRunId = deriveM6LiveEntryRunId({
          authorizationHash: body.authorizationHash,
          scenarioKey: body.scenarioKey,
        });
        // Start creates durable/owned resources before its response is emitted.
        // Preserve the production-derived reference before crossing loopback so
        // timeout, disconnect, malformed JSON, and rebound responses all close
        // the only run that could have committed.
        currentRun = Object.freeze({
          runId: expectedRunId,
          scenarioKey: scenario.scenarioKey,
          manifestHash: window.manifest.manifestHash,
          authorizationHash: window.authorization.envelopeHash,
        });
        currentRunClosed = false;
        const startedRun = await client.liveStart(body);
        if (!startedRun || startedRun.runId !== expectedRunId
          || startedRun.scenarioKey !== scenario.scenarioKey || startedRun.manifestHash !== window.manifest.manifestHash
          || startedRun.authorizationHash !== window.authorization.envelopeHash || !HASH.test(startedRun.bindingHash || "")) {
          fail("M64_LIVE_RUN_BINDING_INVALID", `${scenario.scenarioKey} live start returned a rebound run`);
        }
        currentRun = startedRun;
        let run = await client.liveStatus(currentRun.runId);
        if (window.manifest.purpose !== "M6_4_HOT_CLOSE") {
          for (let poll = 1; poll < maxStatusPolls && !NORMAL_TERMINAL_RUN_STATUSES.has(run?.status); poll += 1) {
            await waitForPoll(statusPollDelayMs);
            run = await client.liveStatus(currentRun.runId);
          }
          if (!NORMAL_TERMINAL_RUN_STATUSES.has(run?.status)) {
            fail("M64_LIVE_RUN_TERMINAL_TIMEOUT", `${scenario.scenarioKey} did not reach a bounded terminal status`);
          }
        } else if (run?.actionCount !== 0 || !["WAITING", "RUNNING", "BROKER_READY"].includes(run?.status)) {
          fail("M64_HOT_CLOSE_PRE_SEND_VIOLATION", "HOT_CLOSE reached transport/action authority before emergency close");
        }

        runs.push(Object.freeze({ ...run }));

        if (window.manifest.purpose === "M6_4_HOT_CLOSE") {
          const closeBundle = window.safetyCloseBundle;
          const closeValidation = validateCloseBundle(closeBundle, { window, emergency: true, structuralOnly: true });
          if (!closeValidation.ok) fail("M64_SIGNED_CLOSE_BUNDLE_INVALID", closeValidation.errors.join(","));
          assertPreflight(await client.gatePreflight(closeBundle.package), `${window.manifest.purpose} expected emergency close`);
          const promotion = await applyGateMutationWithReconcile(client, "gateClose", closeBundle.package);
          if (promotion?.phase !== "CLOSED" || promotion?.tripleConsistent !== true) fail("M64_GATE_EMERGENCY_CLOSE_FAILED", "HOT_CLOSE did not close Gate F");
          assertHotCloseGateStatusBeforeRunDrain(await client.gateStatus(), closeBundle.package.epoch.epochHash);
          // The mutation response is not proof that the durable fence closed.
          // Retain the potentially-active marker until an independent status
          // read proves the exact signed CLOSED epoch, so a lying/stale success
          // response still enters the safety-close path below.
          gateActive = false;
          const closedRun = await closeLiveRun(client, run, "SAFETY_STOP");
          currentRunClosed = true;
          // Gate close deliberately precedes live-run cleanup in HOT_CLOSE.  Its
          // first CLOSED status therefore still accounts for the one run being
          // drained.  Only this fresh, post-close read is a zero-resource
          // closeout suitable for the resource oracle and the next epoch parent.
          const gateClosedStatus = assertClosedGateStatus(await client.gateStatus(), closeBundle.package.epoch.epochHash);
          const evidence = closedRun.attemptEvidence;
          const attemptValidation = validateM64AttemptEvidence(evidence, {
            boundary: effectBoundary,
            expected: window.expectedOracles[scenarioIndex],
            run,
            scenario,
            window,
          });
          if (attemptValidation.critical.length > 0) {
            fail("M64_CANARY_CRITICAL_EVIDENCE", attemptValidation.critical.join(","), { errors: attemptValidation.critical });
          }
          if (attemptValidation.errors.length > 0) {
            fail("M64_CANARY_ATTEMPT_INVALID", attemptValidation.errors.join(","), { errors: attemptValidation.errors });
          }
          attemptEvidence.push(evidence);
          const aggregate = deriveM64ObservedCohortAggregate({ window, attemptEvidence });
          const resourceProbe = await loadResourceProbe({ window, gateClosedStatus, closeBundle });
          const probeValidation = validateM64ResourceProbe(resourceProbe, {
            purpose: window.manifest.purpose,
            gateClosedEpochHash: closeBundle.package.epoch.epochHash,
          });
          if (!probeValidation.ok) fail("M64_RESOURCE_CLOSEOUT_INVALID", probeValidation.errors.join(","));
          windowResults.push(Object.freeze({ window, runs, attemptEvidence, aggregate, closeBundle, gateClosedStatus, resourceProbe }));
          priorClosedStatus = gateClosedStatus;
          currentRun = null;
          break;
        }

        const closedRun = await closeLiveRun(client, run, "CANARY_COMPLETE");
        currentRunClosed = true;
        const evidence = closedRun.attemptEvidence;
        const attemptValidation = validateM64AttemptEvidence(evidence, {
          boundary: effectBoundary,
          expected: window.expectedOracles[scenarioIndex],
          run,
          scenario,
          window,
        });
        if (attemptValidation.critical.length > 0) {
          fail("M64_CANARY_CRITICAL_EVIDENCE", attemptValidation.critical.join(","), { errors: attemptValidation.critical });
        }
        if (attemptValidation.errors.length > 0) {
          fail("M64_CANARY_ATTEMPT_INVALID", attemptValidation.errors.join(","), { errors: attemptValidation.errors });
        }
        attemptEvidence.push(evidence);
        currentRun = null;
        const failedSoFar = attemptEvidence.filter((item) => item.status !== "SUCCEEDED").length;
        const maximumFailures = M6_4_COHORT_RULES[window.manifest.purpose].attempts
          - M6_4_COHORT_RULES[window.manifest.purpose].minimumSucceeded;
        if (failedSoFar > maximumFailures) {
          fail("M64_CANARY_SUCCESS_THRESHOLD_IMPOSSIBLE", `${window.manifest.purpose} exceeded its frozen failure budget`);
        }
      }

      if (window.manifest.purpose !== "M6_4_HOT_CLOSE") {
        const aggregate = deriveM64ObservedCohortAggregate({ window, attemptEvidence });
        const aggregateValidation = validateM64CohortAggregate(aggregate);
        if (!aggregateValidation.ok || !cohortThresholdSatisfied(aggregate)) {
          fail("M64_CANARY_AGGREGATE_INVALID", aggregateValidation.errors.join(","));
        }
        const closeBundle = await resolveCloseBundle({ window, aggregate, attemptEvidence: [...attemptEvidence], emergency: false });
        const closeValidation = validateCloseBundle(closeBundle, { aggregate, window, emergency: false });
        if (!closeValidation.ok) fail("M64_SIGNED_CLOSE_BUNDLE_INVALID", closeValidation.errors.join(","));
        assertPreflight(await client.gatePreflight(closeBundle.package), `${window.manifest.purpose} normal close`);
        const promotion = await applyGateMutationWithReconcile(client, "gateClose", closeBundle.package);
        if (promotion?.phase !== "CLOSED" || promotion?.tripleConsistent !== true) fail("M64_GATE_NORMAL_CLOSE_FAILED", `${window.manifest.purpose} did not close Gate F`);
        const gateClosedStatus = assertClosedGateStatus(await client.gateStatus(), closeBundle.package.epoch.epochHash);
        gateActive = false;
        const resourceProbe = await loadResourceProbe({ window, gateClosedStatus, closeBundle });
        const probeValidation = validateM64ResourceProbe(resourceProbe, {
          purpose: window.manifest.purpose,
          gateClosedEpochHash: closeBundle.package.epoch.epochHash,
        });
        if (!probeValidation.ok) fail("M64_RESOURCE_CLOSEOUT_INVALID", probeValidation.errors.join(","));
        windowResults.push(Object.freeze({ window, runs, attemptEvidence, aggregate, closeBundle, gateClosedStatus, resourceProbe }));
        priorClosedStatus = gateClosedStatus;
      }
    } catch (error) {
      const closeErrors = [];
      const needsSafetyProof = gateActive || (currentRun && !currentRunClosed);
      let gateSafetyFence = null;
      let gateSafetyStatus = null;
      let resourceSafetyProbe = null;
      if (needsSafetyProof) {
        const safetyEpochHash = window.safetyCloseBundle?.package?.epoch?.epochHash ?? null;
        if (gateActive) {
          try {
            gateSafetyFence = await emergencyCloseWindow({ client, window, bundle: window.safetyCloseBundle });
          } catch (closeError) {
            closeErrors.push(closeError.code || "M64_GATE_EMERGENCY_CLOSE_FAILED");
          }
        }
        // HOT_CLOSE already crossed its signed emergency-close boundary before
        // run cleanup.  For all other failures this fresh status also recovers a
        // close response lost after commit.
        if (!gateSafetyFence && safetyEpochHash) {
          try {
            gateSafetyFence = assertClosedGateFenceStatus(await client.gateStatus(), safetyEpochHash);
          } catch (statusError) {
            closeErrors.push(statusError?.code || "M64_GATE_STATUS_UNAVAILABLE");
          }
        }

        let expectedRunNotFound = false;
        if (currentRun && !currentRunClosed) {
          let runAbsentAfterClosedFence = false;
          let observedRun = null;
          try {
            observedRun = await client.liveStatus(currentRun.runId);
            if (observedRun?.runId !== currentRun.runId) {
              fail("M64_LIVE_RUN_BINDING_INVALID", "live status rebound the pre-derived commit-ambiguity run reference");
            }
          } catch (statusError) {
            expectedRunNotFound = statusError?.code === "M6_LIVE_RUN_NOT_FOUND";
            if (expectedRunNotFound
              && gateSafetyFence?.resourceCounts?.runs === 0) {
              // The exact CLOSED fence has no run owner and the deterministic
              // production reference is absent: start provably did not leave a
              // live run even if its HTTP result was lost.
              runAbsentAfterClosedFence = true;
              currentRunClosed = true;
            } else {
              closeErrors.push(statusError?.code || "M64_LIVE_RUN_STATUS_FAILED");
            }
          }
          if (!runAbsentAfterClosedFence) {
            try {
              await closeLiveRun(client, observedRun ?? currentRun, "SAFETY_STOP");
              currentRunClosed = true;
            } catch (closeError) {
              closeErrors.push(closeError.code || "M64_LIVE_RUN_CLOSE_UNVERIFIED");
            }
          }
        }

        if (safetyEpochHash) {
          try {
            gateSafetyStatus = assertClosedGateStatus(await client.gateStatus(), safetyEpochHash);
          } catch (statusError) {
            closeErrors.push(statusError?.code || "M64_GATE_STATUS_UNAVAILABLE");
          }
        }
        if (expectedRunNotFound && gateSafetyStatus?.resourceCounts?.runs === 0) {
          currentRunClosed = true;
        }
        if (gateSafetyStatus) {
          try {
            resourceSafetyProbe = await loadResourceProbe({
              window,
              gateClosedStatus: gateSafetyStatus,
              closeBundle: window.safetyCloseBundle,
            });
            const safetyProbeValidation = validateM64ResourceProbe(resourceSafetyProbe, {
              purpose: window.manifest.purpose,
              gateClosedEpochHash: gateSafetyStatus.epochHash,
            });
            if (!safetyProbeValidation.ok) {
              closeErrors.push(...safetyProbeValidation.errors);
              resourceSafetyProbe = null;
            }
          } catch (probeError) {
            closeErrors.push(probeError?.code || "M64_RESOURCE_CLOSEOUT_UNAVAILABLE");
          }
        }
        if (!gateSafetyStatus || !resourceSafetyProbe || (currentRun && !currentRunClosed)) {
          fail("M64_GATE_SAFETY_CLOSE_UNVERIFIED", "Gate F and live resources could not be proven independently safe after a commit-ambiguous operation", {
            purpose: window.manifest.purpose,
            closeErrors: unique(closeErrors),
            actionCount: null,
            unsafeGateState: !gateSafetyStatus,
            unsafeLiveResourceState: !resourceSafetyProbe || (currentRun && !currentRunClosed),
            originalCode: error?.code ?? "M64_CANARY_FAILED",
          });
        }
      }
      error.details = { ...(error.details || {}), purpose: window.manifest.purpose, closeErrors };
      throw error;
    }
  }

  const finalGateStatus = assertClosedGateStatus(await client.gateStatus(), windowResults.at(-1).closeBundle.package.epoch.epochHash);
  const finalResourceProbe = await loadFinalResourceProbe({ finalGateStatus, windowResults: [...windowResults] });
  const finalProbeValidation = validateM64ResourceProbe(finalResourceProbe, {
    purpose: "M6_4_FINAL",
    gateClosedEpochHash: finalGateStatus.epochHash,
  });
  if (!finalProbeValidation.ok) fail("M64_FINAL_RESOURCE_CLOSEOUT_INVALID", finalProbeValidation.errors.join(","));
  const resourceCloseout = buildResourceCloseout(windowResults.map((result) => result.resourceProbe), finalResourceProbe);
  const receipt = buildCompletionReceipt({
    windowResults,
    effectBoundary,
    resourceCloseout,
    finalGateStatus,
    generatedAt: new Date(now()).toISOString(),
  });
  const verification = verifyM64ActionCanaryCompletion({
    receipt,
    windows: resolvedWindows,
    windowResults,
    effectBoundary,
    resourceCloseout,
    finalGateStatus,
    finalResourceProbe,
    nowMs: now(),
  });
  if (!verification.ok) fail("M64_COMPLETION_VERIFICATION_FAILED", verification.errors.join(","), { errors: verification.errors });
  return Object.freeze({
    ok: true,
    terminalStatus: M64_ACTION_CANARY_TERMINAL_STATUS,
    receipt,
    resourceCloseout,
    finalResourceProbe,
    finalGateStatus,
    windowResults: Object.freeze([...windowResults]),
  });
}
