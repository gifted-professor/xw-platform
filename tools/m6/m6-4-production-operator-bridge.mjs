#!/usr/bin/env node

// Production-only operator bridge for the five M6-4 alias-01 canary windows.
//
// This file deliberately owns no signing key and has no epoch/bundle builder.
// Every mutable operation is delegated to the loopback Control Plane, while
// every window, close package and independent process observation is loaded
// through an explicit raw-SHA-256 descriptor.  Missing post-aggregate close
// authority is a normal fail-closed state, never an invitation to mint locally.

import {
  createHash,
  createPublicKey,
  randomUUID,
  verify as verifySignature,
} from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, parse, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { validateM64EffectBoundary } from "../../packages/kernel/lib/m6-effect-boundary.mjs";
import {
  M64_EXPECTATION_INDEX_SCHEMA_ID,
  M64_FORBIDDEN_ORACLE_SOURCE_KINDS,
  M64_INDEPENDENT_ORACLE_POLICY_SCHEMA_ID,
  deriveM64ExpectationIndexHash,
  deriveM64IndependentActorHash,
  deriveM64IndependentOraclePolicyHash,
} from "../../services/control-plane/control-plane/lib/m6-live-production-dependencies.mjs";
import { deriveM6LiveEntryRunId } from "../../services/control-plane/control-plane/lib/m6-live-entry.mjs";
import {
  M64_STAGED_CANARY_ORDER,
  createM64LoopbackCanaryClient,
  deriveM64ActionCanaryReceiptHash,
  deriveM64ResourceProbeHash,
  deriveM64ResourceCloseoutHash,
  loadM64CanaryWindowInventory,
  loadM64SealedJsonArtifact,
  loadM64SealedJsonArtifactRecord,
  runM64StagedCanary,
  validateM64CanaryWindowInput,
  validateM64ResourceProbe,
  validateM64StagedCanaryInputs,
} from "./m6-4-canary-orchestrator.mjs";
import { validateM64LoopbackControlPlaneUrl } from "./m6-4-canary-runner.mjs";
import { assertM64PrivateAuditRootAcl } from "./m6-4-private-audit-root-acl.mjs";

const HASH = /^[0-9a-f]{64}$/u;
const ED25519_SIGNATURE = /^[A-Za-z0-9+/]{86}==$/u;
const KEY_ID = /^[A-Za-z0-9._-]{1,128}$/u;
const ENV_NAME = /^[A-Z][A-Z0-9_]{2,95}$/u;
const DEFAULT_CONTROL_PLANE_URL = "http://127.0.0.1:17920/";
const DEFAULT_GATE_TOKEN_ENV = "XW_M6_GATE_F_OPERATIONS_TOKEN";
const DEFAULT_LIVE_TOKEN_ENV = "XW_M6_LIVE_ENTRY_TOKEN";
const DEFAULT_WAIT_MS = 5 * 60 * 1000;
const DEFAULT_POLL_MS = 500;
const DEFAULT_RELEASE_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
export const M64_CONTRACT_AUDIT_ROOT = resolve("C:/Users/Public/xw-runtime/m6-audit");
const MAX_OBSERVER_AGE_MS = 30_000;
const MAX_MUTABLE_DESCRIPTOR_BYTES = 64 * 1024;
const MAX_HANDOFF_REQUEST_BYTES = 2 * 1024 * 1024;

const GATE_STATUS_KEYS = Object.freeze([
  "actionCount", "activeAuthorizationCount", "epochHash", "errors", "generation", "locksHash",
  "mode", "phase", "purpose", "resourceCounts", "schemaId", "tripleConsistent",
]);
const PUBLIC_RUN_KEYS = Object.freeze([
  "actionCount", "authorizationHash", "authorizationId", "bindingHash", "closed", "close",
  "manifestHash", "manifestRef", "runId", "scenarioClaimHash", "scenarioKey", "schemaId", "status", "workerRunRef",
]);
const PUBLIC_CLOSE_KEYS = Object.freeze([
  "attemptEvidence", "attemptEvidenceHash", "brokerClosed", "callFenceDrained",
  "controlResourcesClosed", "processClosed", "reasonCode", "schemaId", "verifiedClosed", "workerProtocolClosed",
]);
const PUBLIC_RUN_AUTHORITY_KEYS = Object.freeze([
  "authorizationHash", "authorizationId", "bindingHash", "manifestHash", "manifestRef",
  "runId", "scenarioClaimHash", "scenarioKey", "schemaId", "workerRunRef",
]);
const PROCESS_INVENTORY_KEYS = Object.freeze([
  "activeBrokerRefs", "activePipeRefs", "activeProcessRefs", "activeScenarioClaimRefs", "capturedAt", "closeReceiptHashes",
  "gateClosedEpochHash", "inventoryHash", "observerClass", "observerHash", "observerKeyId", "orphanProcessRefs",
  "purpose", "rawDeviceIdentityFindings", "requestHash", "schemaId", "secretMaterialFindings", "signature", "signatureAlgorithm",
]);
const PROCESS_INVENTORY_ARRAY_KEYS = Object.freeze([
  "activeBrokerRefs", "activePipeRefs", "activeProcessRefs", "activeScenarioClaimRefs", "closeReceiptHashes", "orphanProcessRefs",
  "rawDeviceIdentityFindings", "secretMaterialFindings",
]);
const PROBE_KEYS = Object.freeze([
  "actionCount", "activeActions", "activeAuthorizationCount", "activeBrokers", "activeDshProcesses",
  "activeJobs", "activeLeases", "activePipes", "activeScenarioClaimCount", "activeSessions", "capturedAt",
  "gateClosedEpochHash", "independentOracleArtifactSha256", "orphanProcessRefs", "pendingApprovals",
  "probeHash", "processInventoryHash", "processInventorySha256", "purpose", "rawDeviceIdentityPresent",
  "resourceObservationRequestHash", "resourceObservedAt", "resourceObserverHash", "resourceObserverKeyId",
  "schemaId", "secretMaterialPresent",
]);
const CLOSE_PROOF_KEYS = Object.freeze(["algorithm", "allowlistVersion", "keyId", "signature", "subject"]);
const ORACLE_POLICY_KEYS = Object.freeze([
  "allowedSourceKinds", "effectBoundaryHash", "expectationAuthorKeyId", "expectationAuthorPublicKey",
  "expectationIndex", "forbiddenSourceKinds", "independentAuthorHash", "independentObserverHash",
  "maxObservationAgeMs", "observationObserverKeyId", "observationObserverPublicKey", "observationRoot",
  "policyHash", "requiredSourceKinds", "schemaId",
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

function rawSha(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactObject(value, keys) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && canonical(Object.keys(value).sort()) === canonical([...keys].sort()));
}

function fail(code, message, details = {}) {
  throw Object.assign(new Error(message), { code, details });
}

function unique(values) {
  return [...new Set(values)];
}

function tokenPresent(value, token) {
  if (typeof value === "string") return token.length > 0 && value.includes(token);
  if (Array.isArray(value)) return value.some((entry) => tokenPresent(entry, token));
  if (value && typeof value === "object") {
    return Object.entries(value).some(([key, nested]) => tokenPresent(key, token) || tokenPresent(nested, token));
  }
  return false;
}

function assertPlainDirectory(root, { create = false, code = "M64_OPERATOR_INBOX_INVALID" } = {}) {
  if (typeof root !== "string" || !isAbsolute(root)) fail(code, "operator directory must be absolute");
  if (create) mkdirSync(root, { recursive: true });
  let stat;
  try { stat = lstatSync(root); } catch { fail(code, "operator directory is unavailable"); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(code, "operator directory must be one plain directory");
  const actual = realpathSync(root);
  if (normalizedFilesystemPath(actual) !== normalizedFilesystemPath(root)) {
    fail(code, "operator directory must not traverse a symlink, junction, or reparse point");
  }
  return actual;
}

function normalizedFilesystemPath(value) {
  let normalized = resolve(value);
  const volumeRoot = parse(normalized).root;
  while (normalized.length > volumeRoot.length && /[\\/]$/u.test(normalized)) normalized = normalized.slice(0, -1);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function assertOutsideReleaseRoot(path, releaseRoot, label) {
  if (releaseRoot === null || releaseRoot === undefined) return;
  if (typeof path !== "string" || !isAbsolute(path)) {
    fail("M64_SEALED_ARTIFACT_DESCRIPTOR_INVALID", `${label} path must be absolute`);
  }
  if (typeof releaseRoot !== "string" || !isAbsolute(releaseRoot)) {
    fail("M64_OPERATOR_RELEASE_ROOT_INVALID", "release root must be absolute");
  }
  const release = resolve(releaseRoot);
  const target = resolve(path);
  const rel = relative(release, target);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    fail("M64_LIVE_ARTIFACT_INSIDE_RELEASE", `${label} must be independently published outside the deployed release tree`);
  }
}

function filesystemPathsOverlap(left, right) {
  const a = resolve(left);
  const b = resolve(right);
  const aToB = relative(a, b);
  const bToA = relative(b, a);
  return aToB === "" || (!aToB.startsWith("..") && !isAbsolute(aToB))
    || (!bToA.startsWith("..") && !isAbsolute(bToA));
}

function filesystemIdentity(stat) {
  return [stat.dev, stat.ino, stat.mode, stat.nlink, stat.birthtimeNs ?? stat.birthtimeMs]
    .map((value) => String(value)).join(":");
}

function closeAuditDirectoryGuard(guard) {
  for (const entry of [...(guard?.entries || [])].reverse()) {
    try { closeSync(entry.fd); } catch {}
  }
  if (guard) guard.entries.length = 0;
}

function openPlainAuditDirectoryEntry(path, code) {
  let fd = null;
  try {
    const before = lstatSync(path, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) {
      fail(code, "audit path components must be plain directories, never symlinks, junctions, or reparse points");
    }
    const actual = realpathSync(path);
    if (normalizedFilesystemPath(actual) !== normalizedFilesystemPath(path)) {
      fail(code, "audit path components must not traverse a symlink, junction, or reparse point");
    }
    fd = openSync(path, "r");
    const opened = fstatSync(fd, { bigint: true });
    const after = lstatSync(path, { bigint: true });
    if (!opened.isDirectory() || !after.isDirectory() || after.isSymbolicLink()
      || filesystemIdentity(before) !== filesystemIdentity(opened)
      || filesystemIdentity(opened) !== filesystemIdentity(after)) {
      fail(code, "audit directory identity changed while it was being opened");
    }
    return Object.freeze({ fd, identity: filesystemIdentity(opened), path });
  } catch (error) {
    if (fd !== null) try { closeSync(fd); } catch {}
    if (error?.code === code) throw error;
    fail(code, "audit directory component is unavailable", { cause: error?.code ?? null });
  }
}

function revalidateAuditDirectoryGuard(guard) {
  for (const entry of guard.entries) {
    let pathStat;
    let handleStat;
    let actual;
    try {
      pathStat = lstatSync(entry.path, { bigint: true });
      handleStat = fstatSync(entry.fd, { bigint: true });
      actual = realpathSync(entry.path);
    } catch (error) {
      fail(guard.code, "audit directory identity cannot be revalidated", { cause: error?.code ?? null });
    }
    if (!pathStat.isDirectory() || pathStat.isSymbolicLink() || !handleStat.isDirectory()
      || normalizedFilesystemPath(actual) !== normalizedFilesystemPath(entry.path)
      || filesystemIdentity(pathStat) !== entry.identity || filesystemIdentity(handleStat) !== entry.identity) {
      fail(guard.code, "audit directory was replaced or rebound during publication");
    }
  }
  return guard;
}

function openPlainAuditDirectoryTree(root, { create = false, code = "M64_AUDIT_ROOT_INVALID" } = {}) {
  if (typeof root !== "string" || !isAbsolute(root)) fail(code, "audit directory must be absolute");
  const absolute = resolve(root);
  const volumeRoot = parse(absolute).root;
  const tail = relative(volumeRoot, absolute);
  const candidates = [volumeRoot];
  let cursor = volumeRoot;
  for (const part of tail.split(/[\\/]+/u).filter(Boolean)) {
    cursor = resolve(cursor, part);
    candidates.push(cursor);
  }
  const guard = { code, entries: [], root: absolute };
  try {
    for (const candidate of candidates) {
      let missing = false;
      try { lstatSync(candidate); } catch (error) {
        if (error?.code !== "ENOENT") fail(code, "audit directory component is unavailable", { cause: error?.code ?? null });
        missing = true;
      }
      if (missing) {
        if (!create || candidate === volumeRoot) fail(code, "audit directory is unavailable");
        revalidateAuditDirectoryGuard(guard);
        try { mkdirSync(candidate, { mode: 0o700 }); } catch (error) {
          if (error?.code !== "EEXIST") fail(code, "audit directory could not be created safely", { cause: error?.code ?? null });
        }
      }
      guard.entries.push(openPlainAuditDirectoryEntry(candidate, code));
    }
    revalidateAuditDirectoryGuard(guard);
    return guard;
  } catch (error) {
    closeAuditDirectoryGuard(guard);
    throw error;
  }
}

function ensurePlainAuditChildDirectory(guard, name) {
  revalidateAuditDirectoryGuard(guard);
  const path = childPath(guard.root, name, guard.code);
  let missing = false;
  try { lstatSync(path); } catch (error) {
    if (error?.code !== "ENOENT") fail(guard.code, "audit child directory is unavailable", { cause: error?.code ?? null });
    missing = true;
  }
  if (missing) {
    try { mkdirSync(path, { mode: 0o700 }); } catch (error) {
      if (error?.code !== "EEXIST") fail(guard.code, "audit child directory could not be created safely", { cause: error?.code ?? null });
    }
  }
  guard.entries.push(openPlainAuditDirectoryEntry(path, guard.code));
  revalidateAuditDirectoryGuard(guard);
  return path;
}

function stableAuditFileBytes(path, guard, { missingOk = false } = {}) {
  revalidateAuditDirectoryGuard(guard);
  let before;
  try { before = lstatSync(path, { bigint: true }); } catch (error) {
    if (missingOk && error?.code === "ENOENT") return null;
    fail(guard.code, "audit receipt path is unavailable", { cause: error?.code ?? null });
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
    fail(guard.code, "audit receipts must be single-link plain regular files, never aliases or reparse points");
  }
  let fd = null;
  try {
    const actual = realpathSync(path);
    if (normalizedFilesystemPath(actual) !== normalizedFilesystemPath(path)) {
      fail(guard.code, "audit receipt path traversed a symlink, junction, or reparse point");
    }
    fd = openSync(path, "r");
    const opened = fstatSync(fd, { bigint: true });
    const afterOpen = lstatSync(path, { bigint: true });
    if (!opened.isFile() || !afterOpen.isFile() || afterOpen.isSymbolicLink()
      || filesystemIdentity(before) !== filesystemIdentity(opened)
      || filesystemIdentity(opened) !== filesystemIdentity(afterOpen)) {
      fail(guard.code, "audit receipt identity changed while it was being opened");
    }
    const bytes = readFileSync(fd);
    const afterRead = lstatSync(path, { bigint: true });
    const handleAfterRead = fstatSync(fd, { bigint: true });
    if (afterRead.isSymbolicLink() || filesystemIdentity(afterRead) !== filesystemIdentity(opened)
      || filesystemIdentity(handleAfterRead) !== filesystemIdentity(opened)) {
      fail(guard.code, "audit receipt identity changed during readback");
    }
    closeSync(fd);
    fd = null;
    revalidateAuditDirectoryGuard(guard);
    return bytes;
  } catch (error) {
    if (fd !== null) try { closeSync(fd); } catch {}
    if (error?.code === guard.code) throw error;
    fail(guard.code, "audit receipt could not be read safely", { cause: error?.code ?? null });
  }
}

function assertAuditPathMatchesHandle(path, fd, expectedIdentity, guard) {
  revalidateAuditDirectoryGuard(guard);
  let pathStat;
  let handleStat;
  let actual;
  try {
    pathStat = lstatSync(path, { bigint: true });
    handleStat = fstatSync(fd, { bigint: true });
    actual = realpathSync(path);
  } catch (error) {
    fail(guard.code, "audit temporary/target identity cannot be verified", { cause: error?.code ?? null });
  }
  if (!pathStat.isFile() || pathStat.isSymbolicLink() || !handleStat.isFile()
    || normalizedFilesystemPath(actual) !== normalizedFilesystemPath(path)
    || filesystemIdentity(pathStat) !== expectedIdentity || filesystemIdentity(handleStat) !== expectedIdentity) {
    fail(guard.code, "audit temporary/target file was replaced during publication");
  }
}

function bestEffortFsyncAuditDirectory(guard) {
  revalidateAuditDirectoryGuard(guard);
  try {
    fsyncSync(guard.entries.at(-1).fd);
  } catch (error) {
    if (!["EBADF", "EINVAL", "EISDIR", "ENOSYS", "ENOTSUP", "EPERM"].includes(error?.code)) {
      fail("M64_AUDIT_WRITE_FAILED", "audit directory durability sync failed", { cause: error?.code ?? null });
    }
  }
}

function childPath(root, name, code) {
  const target = resolve(root, name);
  const rel = relative(root, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) fail(code, "operator inbox path escaped its root");
  return target;
}

function readMutableDescriptor(path, label, { expectedRequestHash = null } = {}) {
  let before;
  try { before = lstatSync(path, { bigint: true }); } catch (error) {
    if (error?.code === "ENOENT") return null;
    fail("M64_OPERATOR_DESCRIPTOR_UNAVAILABLE", `${label} descriptor is unavailable`);
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
    || before.size < 2n || before.size > BigInt(MAX_MUTABLE_DESCRIPTOR_BYTES)) {
    fail("M64_OPERATOR_DESCRIPTOR_INVALID", `${label} descriptor must be one bounded single-link plain file`);
  }
  let fd = null;
  let bytes;
  try {
    const actual = realpathSync(path);
    if (normalizedFilesystemPath(actual) !== normalizedFilesystemPath(path)) {
      fail("M64_OPERATOR_DESCRIPTOR_INVALID", `${label} descriptor traversed a symlink, junction, or reparse point`);
    }
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const opened = fstatSync(fd, { bigint: true });
    const afterOpen = lstatSync(path, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || afterOpen.isSymbolicLink()
      || filesystemIdentity(before) !== filesystemIdentity(opened)
      || filesystemIdentity(opened) !== filesystemIdentity(afterOpen)) {
      fail("M64_OPERATOR_DESCRIPTOR_INVALID", `${label} descriptor changed while it was opened`);
    }
    bytes = readFileSync(fd);
    const afterRead = fstatSync(fd, { bigint: true });
    const pathAfterRead = lstatSync(path, { bigint: true });
    if (filesystemIdentity(afterRead) !== filesystemIdentity(opened)
      || filesystemIdentity(pathAfterRead) !== filesystemIdentity(opened)
      || pathAfterRead.size !== BigInt(bytes.length)) {
      fail("M64_OPERATOR_DESCRIPTOR_INVALID", `${label} descriptor changed while it was read`);
    }
  } catch (error) {
    if (error?.code?.startsWith?.("M64_")) throw error;
    fail("M64_OPERATOR_DESCRIPTOR_UNAVAILABLE", `${label} descriptor is unavailable`, { cause: error?.code ?? null });
  } finally {
    if (fd !== null) closeSync(fd);
  }
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); } catch {
    fail("M64_OPERATOR_DESCRIPTOR_INVALID", `${label} descriptor is malformed`);
  }
  const expectedKeys = expectedRequestHash === null ? ["path", "sha256"] : ["path", "requestHash", "sha256"];
  if (!exactObject(value, expectedKeys) || !isAbsolute(value.path || "") || !HASH.test(value.sha256 || "")
    || (expectedRequestHash !== null && value.requestHash !== expectedRequestHash)) {
    fail("M64_OPERATOR_DESCRIPTOR_INVALID", `${label} descriptor is not bound to the exact request and raw SHA-256`);
  }
  return Object.freeze({
    path: value.path,
    sha256: value.sha256,
    ...(expectedRequestHash === null ? {} : { requestHash: value.requestHash }),
  });
}

export function parseM64SealedDescriptorSpec(value, label = "sealed artifact") {
  if (typeof value !== "string") fail("M64_OPERATOR_DESCRIPTOR_INVALID", `${label} must use absolute-path@sha256`);
  const split = value.lastIndexOf("@");
  const path = split > 0 ? value.slice(0, split) : "";
  const sha256 = split > 0 ? value.slice(split + 1) : "";
  if (!isAbsolute(path) || !HASH.test(sha256)) fail("M64_OPERATOR_DESCRIPTOR_INVALID", `${label} must use absolute-path@sha256`);
  return Object.freeze({ path: resolve(path), sha256 });
}

export function deriveM64ResourceObservationRequestHash({
  purpose,
  gateClosedEpochHash,
  closeReceiptHashes,
  notBefore,
} = {}) {
  return sha("xw.m6-4-resource-observation-request.v1", {
    purpose,
    gateClosedEpochHash,
    closeReceiptHashes,
    notBefore,
  });
}

export function deriveM64NormalCloseSigningRequestHash(value) {
  return sha("xw.m6-4-normal-close-signing-request.v1", value);
}

function deriveM64HandoffLocatorHash(value) {
  return sha("xw.m6-4-external-handoff-request-locator.v1", value);
}

function assertBoundedSecretFreeHandoffRequest(request, forbiddenTokens = []) {
  const bytes = exactJsonBytes(request);
  if (bytes.length < 2 || bytes.length > MAX_HANDOFF_REQUEST_BYTES
    || !Array.isArray(forbiddenTokens)
    || forbiddenTokens.some((token) => typeof token !== "string")
    || forbiddenTokens.some((token) => token.length > 0 && bytes.includes(Buffer.from(token, "utf8")))
    || /PRIVATE KEY|BEGIN OPENSSH PRIVATE|api[_-]?key|access[_-]?token|refresh[_-]?token/iu.test(bytes.toString("utf8"))) {
    fail("M64_HANDOFF_REQUEST_SECRET_OR_SIZE_INVALID", "external handoff request is unbounded or contains credential material");
  }
  return bytes;
}

function publishM64ExternalHandoffRequest({
  requestsRoot,
  kind,
  purpose,
  request,
  requestHash,
  responseDescriptorFileName,
  forbiddenTokens = [],
} = {}) {
  const root = assertPlainDirectory(requestsRoot, { code: "M64_HANDOFF_REQUEST_ROOT_INVALID" });
  if (!HASH.test(requestHash || "") || !/^[A-Z][A-Z0-9_]{2,96}$/u.test(purpose || "")
    || !/^[A-Z][A-Z0-9_]{2,96}$/u.test(kind || "")
    || typeof responseDescriptorFileName !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,220}\.json$/u.test(responseDescriptorFileName)) {
    fail("M64_HANDOFF_REQUEST_INVALID", "external handoff request identity is invalid");
  }
  const requestBytes = assertBoundedSecretFreeHandoffRequest(request, forbiddenTokens);
  const requestSha256 = rawSha(requestBytes);
  const artifactFileName = `${requestHash}.${kind.toLowerCase().replaceAll("_", "-")}.json`;
  const locatorRaw = {
    schemaId: "xw.m6-4-external-handoff-request-locator.v1",
    kind,
    purpose,
    requestHash,
    requestSha256,
    artifactFileName,
    responseDescriptorFileName,
  };
  const locator = Object.freeze({ ...locatorRaw, locatorHash: deriveM64HandoffLocatorHash(locatorRaw) });
  const requestArtifact = atomicWriteExactJsonArtifact(root, artifactFileName, request, {
    code: "M64_HANDOFF_REQUEST_ROOT_INVALID",
  });
  if (requestArtifact.sha256 !== requestSha256) {
    fail("M64_HANDOFF_REQUEST_INVALID", "external handoff request failed exact readback");
  }
  const locatorArtifact = atomicWriteExactJsonArtifact(
    root,
    `${purpose}.${requestHash}.${kind.toLowerCase().replaceAll("_", "-")}.locator.json`,
    locator,
    { code: "M64_HANDOFF_REQUEST_ROOT_INVALID" },
  );
  return Object.freeze({
    request: Object.freeze(request),
    requestHash,
    requestSha256,
    requestRawBase64: requestBytes.toString("base64"),
    locator,
    locatorSha256: locatorArtifact.sha256,
  });
}

export function deriveM64ProcessInventoryHash(value) {
  const { inventoryHash: _ignored, signature: _ignoredSignature, ...raw } = value || {};
  return sha("xw.m6-4-independent-process-inventory.v1", raw);
}

export function canonicalM64ProcessInventorySigningBytes(value) {
  const { signature: _ignored, ...signed } = value || {};
  return Buffer.from(`xw.m6-4-independent-process-inventory.v1:${canonical(signed)}`, "utf8");
}

export function loadM64ResourceObserverPolicy(descriptor, {
  effectBoundaryHash = null,
  releaseRoot = DEFAULT_RELEASE_ROOT,
} = {}) {
  assertOutsideReleaseRoot(descriptor?.path, releaseRoot, "independent oracle/resource-observer policy");
  const policy = loadM64SealedJsonArtifact(descriptor, "M6-4 independent oracle/resource-observer policy");
  if (!exactObject(policy, ORACLE_POLICY_KEYS)
    || policy.schemaId !== M64_INDEPENDENT_ORACLE_POLICY_SCHEMA_ID
    || policy.policyHash !== deriveM64IndependentOraclePolicyHash(policy)
    || !HASH.test(policy.effectBoundaryHash || "")
    || !exactObject(policy.expectationIndex, ["path", "sha256"])
    || !isAbsolute(policy.expectationIndex?.path || "") || !HASH.test(policy.expectationIndex?.sha256 || "")
    || !isAbsolute(policy.observationRoot || "")
    || !KEY_ID.test(policy.expectationAuthorKeyId || "")
    || !KEY_ID.test(policy.observationObserverKeyId || "")
    || typeof policy.expectationAuthorPublicKey !== "string"
    || typeof policy.observationObserverPublicKey !== "string"
    || /PRIVATE KEY/u.test(policy.expectationAuthorPublicKey)
    || /PRIVATE KEY/u.test(policy.observationObserverPublicKey)
    || !HASH.test(policy.independentAuthorHash || "")
    || !HASH.test(policy.independentObserverHash || "")
    || !Number.isSafeInteger(policy.maxObservationAgeMs)
    || policy.maxObservationAgeMs < 1 || policy.maxObservationAgeMs > 60_000
    || !Array.isArray(policy.allowedSourceKinds) || policy.allowedSourceKinds.length === 0
    || !Array.isArray(policy.requiredSourceKinds) || policy.requiredSourceKinds.length === 0
    || !Array.isArray(policy.forbiddenSourceKinds)) {
    fail("M64_RESOURCE_OBSERVER_POLICY_INVALID", "resource observer policy is malformed or not content-addressed");
  }
  for (const list of [policy.allowedSourceKinds, policy.requiredSourceKinds, policy.forbiddenSourceKinds]) {
    if (new Set(list).size !== list.length || list.some((item) => !/^[A-Z][A-Z0-9_]{2,96}$/u.test(item || ""))) {
      fail("M64_RESOURCE_OBSERVER_POLICY_INVALID", "resource observer source kinds are invalid");
    }
  }
  if (policy.requiredSourceKinds.some((kind) => !policy.allowedSourceKinds.includes(kind))
    || policy.allowedSourceKinds.some((kind) => policy.forbiddenSourceKinds.includes(kind))
    || M64_FORBIDDEN_ORACLE_SOURCE_KINDS.some((kind) => !policy.forbiddenSourceKinds.includes(kind))) {
    fail("M64_RESOURCE_OBSERVER_POLICY_INVALID", "resource observer policy permits a circular SUT-derived source");
  }
  let authorKey;
  let publicKey;
  try {
    authorKey = createPublicKey(policy.expectationAuthorPublicKey);
    publicKey = createPublicKey(policy.observationObserverPublicKey);
  } catch {
    fail("M64_RESOURCE_OBSERVER_POLICY_INVALID", "resource observer public key is invalid");
  }
  if (authorKey.asymmetricKeyType !== "ed25519" || publicKey.asymmetricKeyType !== "ed25519"
    || deriveM64IndependentActorHash(authorKey) !== policy.independentAuthorHash
    || deriveM64IndependentActorHash(publicKey) !== policy.independentObserverHash
    || policy.independentObserverHash === policy.independentAuthorHash) {
    fail("M64_RESOURCE_OBSERVER_POLICY_INVALID", "resource observer identity is not an independent Ed25519 actor");
  }
  if (effectBoundaryHash !== null && policy.effectBoundaryHash !== effectBoundaryHash) {
    fail("M64_RESOURCE_OBSERVER_POLICY_REBOUND", "resource observer policy is not bound to the current effect boundary");
  }
  const expectationIndex = loadM64SealedJsonArtifact(
    policy.expectationIndex,
    "M6-4 independent expectation index",
  );
  assertOutsideReleaseRoot(policy.expectationIndex.path, releaseRoot, "independent expectation index");
  if (!exactObject(expectationIndex, ["entries", "indexHash", "schemaId"])
    || expectationIndex.schemaId !== M64_EXPECTATION_INDEX_SCHEMA_ID
    || expectationIndex.indexHash !== deriveM64ExpectationIndexHash(expectationIndex)
    || !Array.isArray(expectationIndex.entries) || expectationIndex.entries.length === 0
    || expectationIndex.entries.some((entry) => !exactObject(entry, ["expectationEnvelope", "lookupHash"])
      || !HASH.test(entry.lookupHash || "")
      || !exactObject(entry.expectationEnvelope, ["path", "sha256"])
      || !isAbsolute(entry.expectationEnvelope?.path || "")
      || !HASH.test(entry.expectationEnvelope?.sha256 || ""))
    || new Set(expectationIndex.entries.map((entry) => entry.lookupHash)).size !== expectationIndex.entries.length) {
    fail("M64_RESOURCE_OBSERVER_POLICY_INVALID", "resource observer expectation index is malformed or rebound");
  }
  const observationRoot = assertPlainDirectory(policy.observationRoot, { code: "M64_RESOURCE_OBSERVER_POLICY_INVALID" });
  const requestsRoot = assertPlainDirectory(resolve(observationRoot, "requests"), { code: "M64_RESOURCE_OBSERVER_POLICY_INVALID" });
  const observationsRoot = assertPlainDirectory(resolve(observationRoot, "observations"), { code: "M64_RESOURCE_OBSERVER_POLICY_INVALID" });
  for (const [path, label] of [
    [observationRoot, "independent observation root"],
    [requestsRoot, "independent observation request root"],
    [observationsRoot, "independent observation artifact root"],
  ]) assertOutsideReleaseRoot(path, releaseRoot, label);
  return Object.freeze({
    artifactSha256: descriptor.sha256,
    expectationIndexHash: expectationIndex.indexHash,
    keyId: policy.observationObserverKeyId,
    observationRoot,
    observationsRoot,
    observerHash: policy.independentObserverHash,
    policyHash: policy.policyHash,
    maxObservationAgeMs: policy.maxObservationAgeMs,
    policy: Object.freeze(policy),
    publicKey,
    requestsRoot,
  });
}

export function deriveM64PublicRunReceiptHash(value) {
  return sha("xw.m6-4-public-live-close-receipt.v1", value);
}

export function validateM64IndependentProcessInventory(value, {
  purpose,
  gateClosedEpochHash,
  closeReceiptHashes = [],
  observerPolicy,
  notBeforeMs,
  nowMs = Date.now(),
  maxAgeMs = MAX_OBSERVER_AGE_MS,
} = {}) {
  const errors = [];
  if (!exactObject(value, PROCESS_INVENTORY_KEYS)
    || value?.schemaId !== "xw.m6-4-independent-process-inventory.v1"
    || value?.observerClass !== "INDEPENDENT_OS_AND_CONTROL_DB_OBSERVER"
    || value?.purpose !== purpose || value?.gateClosedEpochHash !== gateClosedEpochHash
    || value?.observerKeyId !== observerPolicy?.keyId
    || value?.observerHash !== observerPolicy?.observerHash
    || value?.signatureAlgorithm !== "ed25519"
    || !ED25519_SIGNATURE.test(value?.signature || "")) {
    errors.push("M64_PROCESS_INVENTORY_SCHEMA_INVALID");
  }
  for (const key of PROCESS_INVENTORY_ARRAY_KEYS) {
    const entries = value?.[key];
    if (!Array.isArray(entries) || entries.some((entry) => !HASH.test(entry || ""))
      || new Set(entries || []).size !== entries?.length) errors.push("M64_PROCESS_INVENTORY_REFS_INVALID");
  }
  if (canonical(value?.closeReceiptHashes) !== canonical(closeReceiptHashes)) {
    errors.push("M64_PROCESS_INVENTORY_CLOSE_BINDING_MISMATCH");
  }
  const expectedRequestHash = deriveM64ResourceObservationRequestHash({
    purpose,
    gateClosedEpochHash,
    closeReceiptHashes,
    notBefore: Number.isFinite(notBeforeMs) ? new Date(notBeforeMs).toISOString() : null,
  });
  if (value?.requestHash !== expectedRequestHash) errors.push("M64_PROCESS_INVENTORY_REQUEST_MISMATCH");
  const capturedAtMs = Date.parse(value?.capturedAt);
  if (!Number.isFinite(capturedAtMs) || !Number.isFinite(notBeforeMs)
    || capturedAtMs < notBeforeMs || capturedAtMs > nowMs + 5_000 || nowMs - capturedAtMs > maxAgeMs) {
    errors.push("M64_PROCESS_INVENTORY_STALE");
  }
  if (deriveM64ProcessInventoryHash(value) !== value?.inventoryHash) errors.push("M64_PROCESS_INVENTORY_HASH_INVALID");
  let signatureValid = false;
  if (observerPolicy?.publicKey && ED25519_SIGNATURE.test(value?.signature || "")) {
    try {
      const signature = Buffer.from(value.signature, "base64");
      signatureValid = signature.length === 64
        && signature.toString("base64") === value.signature
        && verifySignature(null, canonicalM64ProcessInventorySigningBytes(value), observerPolicy.publicKey, signature);
    } catch {}
  }
  if (!signatureValid) errors.push("M64_PROCESS_INVENTORY_SIGNATURE_INVALID");
  return Object.freeze({ ok: errors.length === 0, errors: unique(errors) });
}

function assertClosedGateSource(status) {
  if (!exactObject(status, GATE_STATUS_KEYS)
    || status.schemaId !== "xw.m6-gate-f-operations-status.v1"
    || status.mode !== "CLOSED" || status.phase !== "CLOSED" || status.tripleConsistent !== true
    || status.activeAuthorizationCount !== 0 || status.actionCount !== 0
    || !HASH.test(status.epochHash || "") || !HASH.test(status.locksHash || "")
    || !Number.isSafeInteger(status.generation) || status.generation < 0
    || !Array.isArray(status.errors) || status.errors.length !== 0
    || !exactObject(status.resourceCounts, ["jobs", "leases", "runs", "sessions"])
    || Object.values(status.resourceCounts).some((count) => !Number.isSafeInteger(count) || count < 0)) {
    fail("M64_RESOURCE_GATE_SOURCE_INVALID", "resource evidence requires one exact token-auth CLOSED Gate status");
  }
  return status;
}

function assertClosedRunSource(run) {
  if (!exactObject(run, PUBLIC_RUN_KEYS) || run.schemaId !== "xw.m6-live-entry-run.v1"
    || run.status !== "CLOSED" || run.closed !== true || !exactObject(run.close, PUBLIC_CLOSE_KEYS)
    || run.close.schemaId !== "xw.m6-live-entry-close.v1" || run.close.verifiedClosed !== true
    || run.close.brokerClosed !== true || run.close.workerProtocolClosed !== true
    || run.close.processClosed !== true || run.close.controlResourcesClosed !== true
    || run.close.callFenceDrained !== true
    || run.close.attemptEvidenceHash !== run.close.attemptEvidence?.attemptHash
    || !Number.isSafeInteger(run.actionCount) || run.actionCount < 0
    || run.close.attemptEvidence?.actionEvidence?.actionCount !== run.actionCount) {
    fail("M64_RESOURCE_LIVE_CLOSE_SOURCE_INVALID", "resource evidence requires verified live/status/process-close receipts");
  }
  return run;
}

// This low-level derivation intentionally accepts the already-validated source
// snapshot so it can be independently tested.  The production provider below
// obtains that snapshot only from its private audited loopback client.
export function deriveM64ProductionResourceProbe({
  purpose,
  gateStatus,
  closeReceipts,
  statusReceipts,
  processInventory,
  processInventorySha256,
  observerPolicy,
  tokens = [],
  processInventoryNotBeforeMs = Date.parse(processInventory?.capturedAt),
  capturedAt = new Date().toISOString(),
} = {}) {
  const gate = assertClosedGateSource(gateStatus);
  if (!Array.isArray(closeReceipts) || !Array.isArray(statusReceipts)
    || closeReceipts.length !== statusReceipts.length) {
    fail("M64_RESOURCE_LIVE_CLOSE_SOURCE_INVALID", "close and status receipts must be complete and cardinality-equal");
  }
  const closeByRun = new Map();
  for (const receipt of closeReceipts) {
    const run = assertClosedRunSource(receipt);
    if (closeByRun.has(run.runId)) fail("M64_RESOURCE_LIVE_CLOSE_SOURCE_INVALID", "duplicate close receipt");
    closeByRun.set(run.runId, run);
  }
  for (const receipt of statusReceipts) {
    const run = assertClosedRunSource(receipt);
    const closed = closeByRun.get(run.runId);
    if (!closed || canonical(run) !== canonical(closed)) {
      fail("M64_RESOURCE_LIVE_STATUS_MISMATCH", "live status did not preserve the exact process-close receipt");
    }
  }
  const closeReceiptHashes = closeReceipts.map(deriveM64PublicRunReceiptHash).sort();
  const processValidation = validateM64IndependentProcessInventory(processInventory, {
    purpose,
    gateClosedEpochHash: gate.epochHash,
    closeReceiptHashes,
    observerPolicy,
    notBeforeMs: processInventoryNotBeforeMs,
    nowMs: Date.parse(capturedAt),
  });
  if (!processValidation.ok) fail("M64_PROCESS_INVENTORY_INVALID", processValidation.errors.join(","), { errors: processValidation.errors });

  if (!Array.isArray(tokens) || tokens.some((value) => typeof value !== "string")) {
    fail("M64_RESOURCE_PROBE_INTERNAL_INVALID", "resource probe token redaction inputs are invalid");
  }
  const secretMaterialPresent = processInventory.secretMaterialFindings.length > 0
    || tokens.some((secret) => tokenPresent(gate, secret)
      || tokenPresent(closeReceipts, secret) || tokenPresent(statusReceipts, secret));
  const rawDeviceIdentityPresent = processInventory.rawDeviceIdentityFindings.length > 0;
  const raw = {
    schemaId: "xw.m6-4-live-resource-probe.v1",
    purpose,
    gateClosedEpochHash: gate.epochHash,
    capturedAt,
    resourceObservedAt: processInventory.capturedAt,
    processInventoryHash: processInventory.inventoryHash,
    processInventorySha256,
    resourceObservationRequestHash: processInventory.requestHash,
    resourceObserverKeyId: processInventory.observerKeyId,
    resourceObserverHash: processInventory.observerHash,
    independentOracleArtifactSha256: observerPolicy?.artifactSha256,
    activeJobs: gate.resourceCounts.jobs,
    activeSessions: gate.resourceCounts.sessions,
    activeLeases: gate.resourceCounts.leases,
    // waiting_approval is included in Gate-F's jobs counter.  Treating the
    // total as a conservative upper bound cannot turn a leak green.
    pendingApprovals: gate.resourceCounts.jobs,
    actionCount: gate.actionCount,
    activeActions: gate.actionCount,
    activeAuthorizationCount: gate.activeAuthorizationCount,
    // Durable STARTED scenario claims are not exposed by Gate status.  They
    // therefore come only from the independent read-only resource observer;
    // inferring zero from the in-memory run count would miss crash orphans.
    activeScenarioClaimCount: processInventory.activeScenarioClaimRefs.length,
    activeBrokers: processInventory.activeBrokerRefs.length,
    activeDshProcesses: processInventory.activeProcessRefs.length,
    activePipes: processInventory.activePipeRefs.length,
    orphanProcessRefs: [...processInventory.orphanProcessRefs],
    rawDeviceIdentityPresent,
    secretMaterialPresent,
  };
  const probe = Object.freeze({ ...raw, probeHash: deriveM64ResourceProbeHash(raw) });
  if (!exactObject(probe, PROBE_KEYS)) fail("M64_RESOURCE_PROBE_INTERNAL_INVALID", "derived resource probe shape drifted");
  return probe;
}

export function validateM64ExternalNormalCloseBundle(bundle, {
  window,
  aggregate,
  attemptEvidence = [],
  nowMs = Date.now(),
} = {}) {
  const errors = [];
  const purpose = window?.manifest?.purpose;
  const actualObservedAtMs = Math.max(...attemptEvidence.map((attempt) => (
    Date.parse(attempt?.oracleEvidence?.observedAt) || 0
  )), 0);
  const proof = bundle?.package?.proof;
  if (bundle?.schemaId !== "xw.m6-4-gate-close-bundle.v1" || !bundle?.package || !bundle?.aggregateSeal
    || !bundle?.closeout || !bundle?.cohortAggregate) errors.push("M64_EXTERNAL_CLOSE_SCHEMA_INVALID");
  if (bundle?.package?.operation !== "NORMAL_CLOSE" || bundle?.package?.reasonCode !== "NORMAL_COMPLETE"
    || bundle?.package?.phase !== null || bundle?.package?.epoch?.mode !== "CLOSED") {
    errors.push("M64_EXTERNAL_CLOSE_OPERATION_INVALID");
  }
  if (bundle?.package?.epoch?.purpose !== purpose || bundle?.cohortAggregate?.purpose !== purpose
    || bundle?.package?.authorization?.purpose !== purpose) errors.push("M64_EXTERNAL_CLOSE_PURPOSE_MISMATCH");
  if (bundle?.cohortAggregate?.aggregateHash !== aggregate?.aggregateHash
    || canonical(bundle?.cohortAggregate) !== canonical(aggregate)
    || canonical(bundle?.aggregateSeal?.sealPayload?.cohortAggregate) !== canonical(aggregate)) {
    errors.push("M64_EXTERNAL_CLOSE_AGGREGATE_MISMATCH");
  }
  if (bundle?.package?.epoch?.parentEpochHash !== window?.authorization?.gateEpochHash
    || bundle?.package?.authorization?.envelopeHash !== window?.authorization?.envelopeHash
    || bundle?.package?.authorization?.signature !== window?.authorization?.signature) {
    errors.push("M64_EXTERNAL_CLOSE_AUTHORIZATION_MISMATCH");
  }
  if (!ED25519_SIGNATURE.test(window?.authorization?.signature || "")
    || !exactObject(proof, CLOSE_PROOF_KEYS) || proof.algorithm !== "ed25519"
    || !ED25519_SIGNATURE.test(proof.signature || "")) {
    errors.push("M64_EXTERNAL_CLOSE_SIGNATURE_MISSING");
  }
  const issuedAtMs = Date.parse(bundle?.package?.epoch?.issuedAt);
  const committedAtMs = Date.parse(bundle?.closeout?.committedAt);
  const expiresAtMs = Date.parse(bundle?.package?.epoch?.expiresAt);
  if (!Number.isFinite(issuedAtMs) || !Number.isFinite(committedAtMs) || !Number.isFinite(expiresAtMs)
    || issuedAtMs < actualObservedAtMs || committedAtMs < actualObservedAtMs || expiresAtMs <= nowMs) {
    errors.push("M64_EXTERNAL_CLOSE_STALE");
  }
  return Object.freeze({ ok: errors.length === 0, errors: unique(errors) });
}

function observedActionCount(aggregate) {
  return (aggregate?.attempts || []).reduce((total, attempt) => total + (Number.isInteger(attempt?.actionCount) ? attempt.actionCount : 0), 0);
}

export function deriveM64ResultTotalActionCount(result) {
  if (!Array.isArray(result?.windowResults)
    || result.windowResults.length !== M64_STAGED_CANARY_ORDER.length) {
    fail("M64_TOTAL_ACTION_COUNT_INVALID", "the completed five-window result is unavailable");
  }
  let total = 0;
  for (let index = 0; index < result.windowResults.length; index += 1) {
    const entry = result.windowResults[index];
    const attempts = entry?.aggregate?.attempts;
    if (entry?.window?.manifest?.purpose !== M64_STAGED_CANARY_ORDER[index]
      || !Array.isArray(attempts)
      || !Array.isArray(entry?.attemptEvidence)
      || attempts.length !== entry.attemptEvidence.length
      || attempts.some((attempt) => !Number.isSafeInteger(attempt?.actionCount) || attempt.actionCount < 0)) {
      fail("M64_TOTAL_ACTION_COUNT_INVALID", "the completed cohort action counts are incomplete or rebound");
    }
    const windowTotal = attempts.reduce((value, attempt) => value + attempt.actionCount, 0);
    if (!Number.isSafeInteger(windowTotal) || !Number.isSafeInteger(total + windowTotal)) {
      fail("M64_TOTAL_ACTION_COUNT_INVALID", "the completed cohort action count exceeds the exact integer bound");
    }
    total += windowTotal;
  }
  return total;
}

export function loadM64ExternalNormalCloseBundle(descriptor, {
  window,
  aggregate,
  attemptEvidence = [],
  nowMs = Date.now(),
} = {}) {
  const bundle = loadM64SealedJsonArtifact(descriptor, `${window?.manifest?.purpose || "unknown"} external normal-close bundle`);
  const validation = validateM64ExternalNormalCloseBundle(bundle, { window, aggregate, attemptEvidence, nowMs });
  if (!validation.ok) {
    fail("WAIT_EXTERNAL_AUTHORITY", "an exact externally signed normal-close bundle is not available", {
      reasons: validation.errors,
      purpose: window?.manifest?.purpose ?? null,
      actionCount: observedActionCount(aggregate),
      liveCompletionClaim: null,
    });
  }
  return Object.freeze(bundle);
}

export function createM64NormalCloseInboxResolver({
  inboxRoot,
  requestsRoot = null,
  now = Date.now,
  waitForPoll = (delayMs) => new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs)),
  waitMs = DEFAULT_WAIT_MS,
  pollMs = DEFAULT_POLL_MS,
  recordAcceptedRequest = null,
  forbiddenTokens = [],
} = {}) {
  const root = assertPlainDirectory(inboxRoot, { code: "M64_CLOSE_INBOX_INVALID" });
  const requestRoot = assertPlainDirectory(requestsRoot ?? inboxRoot, { code: "M64_HANDOFF_REQUEST_ROOT_INVALID" });
  if (!Number.isFinite(waitMs) || waitMs <= 0 || waitMs > DEFAULT_WAIT_MS
    || !Number.isFinite(pollMs) || pollMs <= 0 || pollMs > waitMs
    || (recordAcceptedRequest !== null && typeof recordAcceptedRequest !== "function")) {
    fail("M64_CLOSE_INBOX_INVALID", "normal-close handoff polling bounds or recorder are invalid");
  }
  return async ({ window, aggregate, attemptEvidence }) => {
    const purpose = window?.manifest?.purpose;
    if (!M64_STAGED_CANARY_ORDER.includes(purpose)) fail("M64_CLOSE_INBOX_INVALID", "close inbox purpose is invalid");
    const currentGateEpochHash = window?.authorization?.gateEpochHash;
    const activationParentEpochHash = window?.activationPackage?.epoch?.parentEpochHash;
    const attemptEvidenceHashes = (attemptEvidence || []).map((entry) => entry?.attemptHash);
    const requestedAtMs = now();
    const deadline = requestedAtMs + waitMs;
    if (!HASH.test(currentGateEpochHash || "") || !HASH.test(activationParentEpochHash || "")
      || !HASH.test(aggregate?.aggregateHash || "") || !Array.isArray(attemptEvidence)
      || attemptEvidence.length === 0 || attemptEvidenceHashes.some((value) => !HASH.test(value || ""))) {
      fail("M64_NORMAL_CLOSE_REQUEST_INVALID", "normal-close handoff request lacks exact aggregate, evidence, or epoch bindings");
    }
    const requestRaw = {
      purpose,
      currentGateEpochHash,
      activationParentEpochHash,
      aggregate,
      aggregateHash: aggregate.aggregateHash,
      attemptEvidence,
      attemptEvidenceHashes,
      requestNonce: randomUUID(),
      requestedAt: new Date(requestedAtMs).toISOString(),
      deadline: new Date(deadline).toISOString(),
    };
    const requestHash = deriveM64NormalCloseSigningRequestHash(requestRaw);
    const request = Object.freeze({ ...requestRaw, requestHash });
    const responseDescriptorFileName = `${purpose}.${requestHash}.normal-close.descriptor.json`;
    const publishedRequest = publishM64ExternalHandoffRequest({
      requestsRoot: requestRoot,
      kind: "NORMAL_CLOSE_SIGNING",
      purpose,
      request,
      requestHash,
      responseDescriptorFileName,
      forbiddenTokens,
    });
    const path = childPath(root, responseDescriptorFileName, "M64_CLOSE_INBOX_INVALID");
    let lastAuthorityFailure = null;
    for (;;) {
      const descriptor = readMutableDescriptor(path, `${purpose} normal-close`, { expectedRequestHash: requestHash });
      if (descriptor) {
        try {
          const bundle = loadM64ExternalNormalCloseBundle({ path: descriptor.path, sha256: descriptor.sha256 }, {
            window, aggregate, attemptEvidence, nowMs: now(),
          });
          if (Date.parse(bundle.package.epoch.issuedAt) < requestedAtMs
            || Date.parse(bundle.package.epoch.issuedAt) > deadline
            || Date.parse(bundle.closeout.committedAt) < requestedAtMs
            || Date.parse(bundle.closeout.committedAt) > deadline) {
            fail("WAIT_EXTERNAL_AUTHORITY", "normal-close response was not signed inside its bounded handoff window", {
              purpose, actionCount: observedActionCount(aggregate), liveCompletionClaim: null,
              reasons: ["M64_EXTERNAL_CLOSE_AFTER_REQUEST_DEADLINE"],
            });
          }
          recordAcceptedRequest?.(publishedRequest);
          return bundle;
        } catch (error) {
          // A stale descriptor from a prior aggregate may legitimately be
          // replaced by the external signer while this bounded wait is open.
          // Byte tamper/unavailability remains an immediate hard failure.
          if (error?.code !== "WAIT_EXTERNAL_AUTHORITY") throw error;
          lastAuthorityFailure = error;
        }
      }
      if (now() >= deadline) {
        fail("WAIT_EXTERNAL_AUTHORITY", "external normal-close authority has not published the exact bundle", {
          purpose,
          actionCount: observedActionCount(aggregate),
          liveCompletionClaim: null,
          reasons: lastAuthorityFailure?.details?.reasons ?? ["M64_EXTERNAL_CLOSE_NOT_PUBLISHED"],
        });
      }
      await waitForPoll(Math.min(pollMs, Math.max(0, deadline - now())));
    }
  };
}

// Later window authorizations cannot truthfully be frozen before the preceding
// aggregate has been externally closed, because their activation parent is
// that newly signed CLOSED epoch.  These five fixed inbox slots solve that
// dependency without weakening content addressing: each mutable slot contains
// only {path, sha256}, and the referenced inventory remains immutable.
export function createM64WindowInventoryInboxLoader({
  inboxRoot,
  now = Date.now,
  waitForPoll = (delayMs) => new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs)),
  waitMs = DEFAULT_WAIT_MS,
  pollMs = DEFAULT_POLL_MS,
} = {}) {
  const root = assertPlainDirectory(inboxRoot, { code: "M64_WINDOW_INBOX_INVALID" });
  return async ({ purpose, priorClosedStatus = null }) => {
    if (!M64_STAGED_CANARY_ORDER.includes(purpose)) fail("M64_WINDOW_INBOX_INVALID", "window inbox purpose is invalid");
    const path = childPath(root, `${purpose}.window.descriptor.json`, "M64_WINDOW_INBOX_INVALID");
    const deadline = now() + waitMs;
    let lastMismatch = null;
    for (;;) {
      const descriptor = readMutableDescriptor(path, `${purpose} window inventory`);
      if (descriptor) {
        const window = loadM64CanaryWindowInventory(descriptor);
        const parentMatches = !priorClosedStatus
          || (window.activationPackage?.epoch?.parentEpochHash === priorClosedStatus.epochHash
            && window.authorization?.gateGeneration === priorClosedStatus.generation + 1);
        if (window.manifest?.purpose === purpose && parentMatches) return window;
        lastMismatch = window.manifest?.purpose !== purpose
          ? "M64_CANARY_WINDOW_ORDER_INVALID" : "M64_CANARY_ACTIVATION_PARENT_MISMATCH";
      }
      if (now() >= deadline) {
        fail("WAIT_EXTERNAL_AUTHORITY", "the exact externally authorized next-window inventory is unavailable", {
          purpose,
          actionCount: 0,
          liveCompletionClaim: null,
          reasons: [lastMismatch ?? "M64_WINDOW_INVENTORY_NOT_PUBLISHED"],
        });
      }
      await waitForPoll(Math.min(pollMs, Math.max(0, deadline - now())));
    }
  };
}

export function createM64ProcessInventoryInboxLoader({
  inboxRoot,
  now = Date.now,
  waitForPoll = (delayMs) => new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs)),
  waitMs = DEFAULT_WAIT_MS,
  pollMs = DEFAULT_POLL_MS,
} = {}) {
  const root = assertPlainDirectory(inboxRoot, { code: "M64_PROCESS_INBOX_INVALID" });
  if (!Number.isFinite(waitMs) || waitMs <= 0 || waitMs > DEFAULT_WAIT_MS
    || !Number.isFinite(pollMs) || pollMs <= 0 || pollMs > waitMs) {
    fail("M64_PROCESS_INBOX_INVALID", "process-inventory handoff polling bounds are invalid");
  }
  return async ({ purpose, requestHash }) => {
    if (!M64_STAGED_CANARY_ORDER.includes(purpose) && purpose !== "M6_4_FINAL") {
      fail("M64_PROCESS_INBOX_INVALID", "process inventory purpose is invalid");
    }
    if (!HASH.test(requestHash || "")) fail("M64_PROCESS_INBOX_INVALID", "process inventory request hash is invalid");
    const path = childPath(root, `${purpose}.${requestHash}.resource.descriptor.json`, "M64_PROCESS_INBOX_INVALID");
    const deadline = now() + waitMs;
    for (;;) {
      const descriptor = readMutableDescriptor(path, `${purpose} process inventory`, { expectedRequestHash: requestHash });
      if (descriptor) return descriptor;
      if (now() >= deadline) fail("WAIT_EXTERNAL_RESOURCE_OBSERVER", "independent process inventory is unavailable", { purpose, liveCompletionClaim: null });
      await waitForPoll(Math.min(pollMs, Math.max(0, deadline - now())));
    }
  };
}

export function createM64AuditedLoopbackCanaryClient({
  controlPlaneUrl = DEFAULT_CONTROL_PLANE_URL,
  gateToken,
  liveToken,
  fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) {
  validateM64LoopbackControlPlaneUrl(controlPlaneUrl);
  assertM64SeparatedOperatorTokens(gateToken, liveToken);
  const inner = createM64LoopbackCanaryClient({ controlPlaneUrl, gateToken, liveToken, fetchImpl });
  const runs = new Map();
  const sealedPurposes = new Set();
  let observationSequence = 0;
  let latestGateObservation = null;

  function assertNoSecret(value) {
    if ([gateToken, liveToken].some((secret) => tokenPresent(value, secret))) {
      fail("M64_OPERATOR_SECRET_LEAK", "Control Plane response contained an operator credential");
    }
    return value;
  }

  function isClosedZeroGate(status) {
    return status?.schemaId === "xw.m6-gate-f-operations-status.v1"
      && status.mode === "CLOSED" && status.phase === "CLOSED" && status.tripleConsistent === true
      && status.actionCount === 0 && status.activeAuthorizationCount === 0
      && exactObject(status.resourceCounts, ["jobs", "leases", "runs", "sessions"])
      && Object.values(status.resourceCounts).every((count) => count === 0)
      && Array.isArray(status.errors) && status.errors.length === 0;
  }

  function preserveVerifiedClosed(record, run) {
    if (!record || run?.runId !== record.runId || run.scenarioKey !== record.scenarioKey
      || run.manifestRef !== record.manifestRef || run.manifestHash !== record.manifestHash
      || run.authorizationId !== record.authorizationId || run.authorizationHash !== record.authorizationHash) {
      fail("M64_RESOURCE_LIVE_CLOSE_SOURCE_INVALID", "live close/status returned an untracked or rebound run");
    }
    const receipt = assertClosedRunSource(run);
    if (record.started && PUBLIC_RUN_AUTHORITY_KEYS.some((key) => record.started[key] !== receipt[key])) {
      fail("M64_RESOURCE_LIVE_STATUS_MISMATCH", "live close/status rebound the started run authority");
    }
    for (const prior of [record.close, record.status]) {
      if (prior && canonical(prior) !== canonical(receipt)) {
        fail("M64_RESOURCE_LIVE_STATUS_MISMATCH", "live close and status returned different canonical CLOSED receipts");
      }
    }
    record.started ??= receipt;
    record.close = receipt;
    record.status = receipt;
    record.provenAbsent = false;
    record.observedAtMs = now();
    return receipt;
  }

  function reconcileProvisionalAbsence(record) {
    if (!record || record.started || !Number.isSafeInteger(record.startFailureSequence)
      || !Number.isSafeInteger(record.notFoundObservationSequence)
      || record.notFoundObservationSequence <= record.startFailureSequence
      || latestGateObservation?.sequence <= record.startFailureSequence
      || !isClosedZeroGate(latestGateObservation?.status)) return false;
    // Keep the tombstone so a contradictory later receipt cannot become an
    // untracked run, but exclude this independently proven pre-commit failure
    // from resource snapshots.
    record.provenAbsent = true;
    return true;
  }

  const client = Object.freeze({
    async gateStatus() {
      const sequence = ++observationSequence;
      const status = assertNoSecret(await inner.gateStatus());
      latestGateObservation = { sequence, status };
      for (const record of runs.values()) reconcileProvisionalAbsence(record);
      return status;
    },
    async gatePreflight(value) { return assertNoSecret(await inner.gatePreflight(value)); },
    async gateActivate(value) { return assertNoSecret(await inner.gateActivate(value)); },
    async gateClose(value) { return assertNoSecret(await inner.gateClose(value)); },
    async gateReconcile(value) { return assertNoSecret(await inner.gateReconcile(value)); },
    async recoverArmedActive(value = {}) {
      return assertNoSecret(await inner.recoverArmedActive(value));
    },
    async livePreflight(value) { return assertNoSecret(await inner.livePreflight(value)); },
    async liveStart(value) {
      const runId = deriveM6LiveEntryRunId({
        authorizationHash: value?.authorizationHash,
        scenarioKey: value?.scenarioKey,
      });
      const record = {
        runId,
        purpose: value?.authorization?.purpose,
        manifestRef: value?.manifestRef,
        scenarioKey: value?.scenarioKey,
        manifestHash: value?.manifestHash,
        authorizationId: value?.authorizationId,
        authorizationHash: value?.authorizationHash,
        started: null,
        close: null,
        status: null,
        observedAtMs: now(),
        startFailureSequence: null,
        notFoundObservationSequence: null,
        provenAbsent: false,
      };
      // This record must exist before start crosses the loopback boundary: a
      // timeout can lose only the response, not the committed run authority.
      ++observationSequence;
      runs.set(runId, record);
      try {
        const run = assertNoSecret(await inner.liveStart(value));
        if (run?.runId !== record.runId || run.scenarioKey !== record.scenarioKey
          || run.manifestHash !== record.manifestHash || run.authorizationHash !== record.authorizationHash) {
          fail("M64_LIVE_RUN_BINDING_INVALID", "live start returned a rebound run");
        }
        record.started = run;
        record.observedAtMs = now();
        return run;
      } catch (error) {
        record.startFailureSequence = ++observationSequence;
        throw error;
      }
    },
    async liveStatus(runId) {
      const sequence = ++observationSequence;
      const record = runs.get(runId);
      let run;
      try {
        run = assertNoSecret(await inner.liveStatus(runId));
      } catch (error) {
        if (record && error?.code === "M6_LIVE_RUN_NOT_FOUND") {
          record.notFoundObservationSequence = sequence;
          reconcileProvisionalAbsence(record);
        }
        throw error;
      }
      if (run?.runId !== runId || (record && (run.scenarioKey !== record.scenarioKey
        || run.manifestHash !== record.manifestHash || run.authorizationHash !== record.authorizationHash))) {
        fail("M64_LIVE_RUN_BINDING_INVALID", "live status rebound the requested run");
      }
      if (record) {
        record.started ??= run;
        record.provenAbsent = false;
        if (run.closed === true || run.status === "CLOSED" || run.close !== undefined) {
          preserveVerifiedClosed(record, run);
        }
      }
      return run;
    },
    async liveClose(runId, reasonCode) {
      const run = assertNoSecret(await inner.liveClose(runId, reasonCode));
      const record = runs.get(runId);
      if (!record) fail("M64_RESOURCE_LIVE_CLOSE_SOURCE_INVALID", "live close returned an untracked run");
      preserveVerifiedClosed(record, run);
      return run;
    },
    async liveRecoverEpoch(value = {}) {
      return assertNoSecret(await inner.liveRecoverEpoch(value));
    },
  });

  const audit = Object.freeze({
    snapshot(purpose) {
      if (sealedPurposes.has(purpose)) fail("M64_RESOURCE_AUDIT_REPLAY", "resource source snapshot was already consumed");
      const records = [...runs.values()].filter((record) => record.purpose === purpose && record.provenAbsent !== true);
      if (records.some((record) => !record.close || !record.status)) {
        fail("M64_RESOURCE_LIVE_CLOSE_SOURCE_INVALID", "one or more live runs lack close/status preservation evidence");
      }
      const latest = records.length > 0
        ? records.reduce((value, record) => Math.max(value, record.observedAtMs), 0)
        : now();
      return Object.freeze({
        closeReceipts: Object.freeze(records.map((record) => record.close)),
        statusReceipts: Object.freeze(records.map((record) => record.status)),
        notBeforeMs: latest,
      });
    },
    seal(purpose) { sealedPurposes.add(purpose); },
    actionCount() {
      return [...runs.values()].reduce((total, record) => total + (Number.isInteger(record.close?.actionCount) ? record.close.actionCount : 0), 0);
    },
  });
  return Object.freeze({ client, audit });
}

function assertM64SeparatedOperatorTokens(gateToken, liveToken) {
  if ([gateToken, liveToken].some((value) => typeof value !== "string" || value.length < 32 || /[\0\r\n]/u.test(value))) {
    fail("M64_OPERATOR_TOKEN_REQUIRED", "distinct Gate and live-entry tokens must be injected from environment variables");
  }
  if (gateToken === liveToken) {
    fail("M64_OPERATOR_TOKEN_SEPARATION_REQUIRED", "Gate and live-entry authority must not share one credential");
  }
}

export function createM64ProductionResourceProbeProvider({
  audit,
  loadProcessInventoryDescriptor,
  observerPolicy,
  recordAcceptedEvidence = null,
  tokens = [],
  now = Date.now,
  maxObserverAgeMs = null,
} = {}) {
  if (!audit || typeof audit.snapshot !== "function" || typeof audit.seal !== "function"
    || typeof loadProcessInventoryDescriptor !== "function" || !observerPolicy?.publicKey
    || !observerPolicy?.requestsRoot
    || (recordAcceptedEvidence !== null && typeof recordAcceptedEvidence !== "function")) {
    fail("M64_RESOURCE_OBSERVER_UNAVAILABLE", "production resource provider requires audited loopback sources and an independent observer");
  }
  const effectiveMaxObserverAgeMs = Math.min(
    Number.isSafeInteger(maxObserverAgeMs) && maxObserverAgeMs > 0 ? maxObserverAgeMs : observerPolicy.maxObservationAgeMs,
    observerPolicy.maxObservationAgeMs,
  );
  return async ({ purpose, gateClosedStatus }) => {
    const sources = audit.snapshot(purpose);
    const closeReceiptHashes = sources.closeReceipts.map(deriveM64PublicRunReceiptHash).sort();
    if ((!M64_STAGED_CANARY_ORDER.includes(purpose) && purpose !== "M6_4_FINAL")
      || !HASH.test(gateClosedStatus?.epochHash || "") || !Number.isFinite(sources.notBeforeMs)
      || closeReceiptHashes.some((value) => !HASH.test(value || ""))) {
      fail("M64_RESOURCE_OBSERVATION_REQUEST_INVALID", "resource-observation request lacks exact purpose, Gate, close, or time bindings");
    }
    const notBefore = new Date(sources.notBeforeMs).toISOString();
    const requestRaw = {
      purpose,
      gateClosedEpochHash: gateClosedStatus?.epochHash,
      closeReceiptHashes,
      notBefore,
    };
    const requestHash = deriveM64ResourceObservationRequestHash(requestRaw);
    const request = Object.freeze({ ...requestRaw, requestHash });
    const responseDescriptorFileName = `${purpose}.${requestHash}.resource.descriptor.json`;
    const publishedRequest = publishM64ExternalHandoffRequest({
      requestsRoot: observerPolicy.requestsRoot,
      kind: "RESOURCE_OBSERVATION",
      purpose,
      request,
      requestHash,
      responseDescriptorFileName,
      forbiddenTokens: tokens,
    });
    const descriptor = await loadProcessInventoryDescriptor({
      ...requestRaw,
      requestHash,
      responseDescriptorFileName,
    });
    const inventoryRecord = loadM64SealedJsonArtifactRecord(
      { path: descriptor.path, sha256: descriptor.sha256 },
      `${purpose} independent process inventory`,
    );
    const inventory = inventoryRecord.value;
    const capturedAtMs = now();
    const capturedAt = new Date(capturedAtMs).toISOString();
    const validation = validateM64IndependentProcessInventory(inventory, {
      purpose,
      gateClosedEpochHash: gateClosedStatus?.epochHash,
      closeReceiptHashes,
      observerPolicy,
      notBeforeMs: sources.notBeforeMs,
      nowMs: capturedAtMs,
      maxAgeMs: effectiveMaxObserverAgeMs,
    });
    if (!validation.ok) fail("M64_PROCESS_INVENTORY_INVALID", validation.errors.join(","), { errors: validation.errors });
    const probe = deriveM64ProductionResourceProbe({
      purpose,
      gateStatus: gateClosedStatus,
      closeReceipts: sources.closeReceipts,
      statusReceipts: sources.statusReceipts,
      processInventory: inventory,
      processInventorySha256: descriptor.sha256,
      observerPolicy,
      tokens,
      processInventoryNotBeforeMs: sources.notBeforeMs,
      capturedAt,
    });
    const probeValidation = validateM64ResourceProbe(probe, { purpose, gateClosedEpochHash: gateClosedStatus.epochHash });
    if (!probeValidation.ok) fail("M64_RESOURCE_EVIDENCE_NOT_ZERO", probeValidation.errors.join(","), { errors: probeValidation.errors });
    recordAcceptedEvidence?.(Object.freeze({
      purpose,
      gateClosedEpochHash: gateClosedStatus.epochHash,
      processInventorySha256: descriptor.sha256,
      processInventoryRawBase64: inventoryRecord.rawBase64,
      processInventory: Object.freeze(inventory),
      resourceObservationRequest: publishedRequest.request,
      resourceObservationRequestHash: publishedRequest.requestHash,
      resourceObservationRequestSha256: publishedRequest.requestSha256,
      resourceObservationRequestRawBase64: publishedRequest.requestRawBase64,
      resourceObservationRequestLocator: publishedRequest.locator,
      resourceObservationRequestLocatorSha256: publishedRequest.locatorSha256,
      resourceProbe: probe,
    }));
    audit.seal(purpose);
    return probe;
  };
}

export function loadM64ProductionOperatorInputs({
  windowInventoryDescriptors,
  effectBoundaryDescriptor,
  independentOraclePolicyDescriptor,
  releaseRoot = DEFAULT_RELEASE_ROOT,
  nowMs = Date.now(),
} = {}) {
  if (!Array.isArray(windowInventoryDescriptors) || windowInventoryDescriptors.length !== M64_STAGED_CANARY_ORDER.length
    || new Set(windowInventoryDescriptors.map((entry) => `${entry?.path || ""}:${entry?.sha256 || ""}`)).size !== M64_STAGED_CANARY_ORDER.length) {
    fail("M64_OPERATOR_WINDOW_DESCRIPTORS_INVALID", "operator requires five distinct content-addressed window inventories");
  }
  const windows = windowInventoryDescriptors.map(loadM64CanaryWindowInventory);
  assertOutsideReleaseRoot(effectBoundaryDescriptor?.path, releaseRoot, "M6-4 effect boundary");
  const effectBoundary = loadM64SealedJsonArtifact(effectBoundaryDescriptor, "M6-4 effect boundary");
  const observerPolicy = loadM64ResourceObserverPolicy(independentOraclePolicyDescriptor, {
    effectBoundaryHash: effectBoundary.boundaryHash,
    releaseRoot,
  });
  const inputValidation = validateM64StagedCanaryInputs({ windows, effectBoundary, nowMs });
  if (!inputValidation.ok || validateM64EffectBoundary(effectBoundary).ok !== true
    || windows.some((window) => window.authorization?.independentOracleHash !== observerPolicy.artifactSha256)) {
    fail("M64_OPERATOR_INPUT_INVALID", inputValidation.errors.join(","), { errors: inputValidation.errors });
  }
  return Object.freeze({
    windows: Object.freeze(windows),
    effectBoundary: Object.freeze(effectBoundary),
    observerPolicy,
  });
}

function validateM64ProductionFirstWindow(window, effectBoundary, observerPolicy, nowMs) {
  const validation = validateM64CanaryWindowInput(window, effectBoundary, nowMs);
  const purpose = M64_STAGED_CANARY_ORDER[0];
  const errors = [...validation.errors];
  if (window?.manifest?.purpose !== purpose) errors.push("M64_CANARY_WINDOW_ORDER_INVALID");
  if (window?.authorization?.independentOracleHash !== observerPolicy?.artifactSha256) {
    errors.push("M64_RESOURCE_OBSERVER_POLICY_REBOUND");
  }
  if (errors.length > 0) {
    fail("M64_OPERATOR_FIRST_WINDOW_INVALID", unique(errors).join(","), { errors: unique(errors) });
  }
  return Object.freeze(window);
}

function validateAuditPublicationRootReadOnly(auditRoot) {
  const guard = openPlainAuditDirectoryTree(auditRoot, { create: false, code: "M64_AUDIT_ROOT_INVALID" });
  try {
    const child = childPath(guard.root, "m6-4-action-canary-completion", guard.code);
    try {
      lstatSync(child);
      guard.entries.push(openPlainAuditDirectoryEntry(child, guard.code));
      revalidateAuditDirectoryGuard(guard);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return guard.root;
  } finally {
    closeAuditDirectoryGuard(guard);
  }
}

export function validateM64PublicationRoots({
  auditRoot,
  repositoryRoot,
  releaseRoot = DEFAULT_RELEASE_ROOT,
  contractAuditRoot = M64_CONTRACT_AUDIT_ROOT,
} = {}) {
  if (!auditRoot || !repositoryRoot || !releaseRoot || !contractAuditRoot) {
    fail("M64_OPERATOR_PRODUCTION_INPUT_MISSING", "publication requires release, repository, and fixed audit roots");
  }
  if (normalizedFilesystemPath(auditRoot) !== normalizedFilesystemPath(contractAuditRoot)) {
    fail("M64_OPERATOR_AUDIT_ROOT_MISMATCH", "execution must publish the fixed execution-contract audit path");
  }
  // Test fixtures may bind their own isolated contract root.  The immutable
  // production contract, however, is also required to pass a read-only,
  // recursive ownership/DACL check before any live mutation or publication.
  if (normalizedFilesystemPath(contractAuditRoot)
    === normalizedFilesystemPath(M64_CONTRACT_AUDIT_ROOT)) {
    assertM64PrivateAuditRootAcl(auditRoot);
  }
  const release = assertPlainDirectory(releaseRoot, { code: "M64_OPERATOR_RELEASE_ROOT_INVALID" });
  const repository = assertPlainDirectory(repositoryRoot, { code: "M64_REPOSITORY_ROOT_INVALID" });
  const artifactRoot = assertPlainDirectory(resolve(repository, "artifacts", "m6-4"), {
    code: "M64_REPOSITORY_ROOT_INVALID",
  });
  const audit = validateAuditPublicationRootReadOnly(auditRoot);
  assertOutsideReleaseRoot(repository, release, "repository contract artifact root");
  assertOutsideReleaseRoot(audit, release, "runtime audit root");
  if (filesystemPathsOverlap(repository, audit)) {
    fail("M64_LIVE_ARTIFACT_ROOTS_OVERLAP", "repository and runtime audit publication roots must be independent and non-overlapping");
  }
  return Object.freeze({ auditRoot: audit, repositoryRoot: repository, artifactRoot, releaseRoot: release });
}

export function validateM64ProductionPreMutation({
  windowInventoryInboxRoot,
  closeInboxRoot,
  processInventoryInboxRoot,
  auditRoot,
  repositoryRoot,
  releaseRoot = DEFAULT_RELEASE_ROOT,
  contractAuditRoot = M64_CONTRACT_AUDIT_ROOT,
  controlPlaneUrl = DEFAULT_CONTROL_PLANE_URL,
  gateToken,
  liveToken,
  requireWindowInbox = true,
} = {}) {
  validateM64LoopbackControlPlaneUrl(controlPlaneUrl);
  assertM64SeparatedOperatorTokens(gateToken, liveToken);
  if ((requireWindowInbox && !windowInventoryInboxRoot) || !closeInboxRoot || !processInventoryInboxRoot) {
    fail("M64_OPERATOR_PRODUCTION_INPUT_MISSING", "operator preflight requires window when lazy, close, and independent-resource roots");
  }
  const publication = validateM64PublicationRoots({
    auditRoot, repositoryRoot, releaseRoot, contractAuditRoot,
  });
  const roots = {
    ...publication,
    windowInventoryInboxRoot: requireWindowInbox
      ? assertPlainDirectory(windowInventoryInboxRoot, { code: "M64_WINDOW_INBOX_INVALID" })
      : null,
    closeInboxRoot: assertPlainDirectory(closeInboxRoot, { code: "M64_CLOSE_INBOX_INVALID" }),
    processInventoryInboxRoot: assertPlainDirectory(processInventoryInboxRoot, { code: "M64_PROCESS_INBOX_INVALID" }),
  };
  if (roots.windowInventoryInboxRoot) {
    assertOutsideReleaseRoot(roots.windowInventoryInboxRoot, publication.releaseRoot, "window inventory inbox");
  }
  assertOutsideReleaseRoot(roots.closeInboxRoot, publication.releaseRoot, "normal-close inbox");
  assertOutsideReleaseRoot(roots.processInventoryInboxRoot, publication.releaseRoot, "independent process-inventory inbox");
  return Object.freeze(roots);
}

function loadM64DryFirstWindowFromInbox(windowInventoryInboxRoot) {
  const purpose = M64_STAGED_CANARY_ORDER[0];
  const path = childPath(windowInventoryInboxRoot, `${purpose}.window.descriptor.json`, "M64_WINDOW_INBOX_INVALID");
  const descriptor = readMutableDescriptor(path, `${purpose} window inventory`);
  return descriptor ? loadM64CanaryWindowInventory(descriptor) : null;
}

export function buildM64LazyDryPreflightResult({ firstWindow, effectBoundary, observerPolicy }) {
  const firstWindowValidated = Boolean(firstWindow);
  return Object.freeze({
    ok: true,
    mode: "PREFLIGHT_ONLY",
    terminalStatus: firstWindowValidated
      ? "PREFLIGHT_LAZY_FIRST_WINDOW_VALIDATED_WAIT_FUTURE_WINDOWS"
      : "PREFLIGHT_LAZY_WAIT_FIRST_WINDOW",
    readinessScope: "LAZY_FIRST_WINDOW_ONLY",
    fullFiveWindowReady: false,
    liveCompletionClaim: null,
    actionCount: 0,
    transportCount: 0,
    cohortOrder: Object.freeze([...M64_STAGED_CANARY_ORDER]),
    validatedWindowCount: firstWindowValidated ? 1 : 0,
    pendingWindowCount: firstWindowValidated
      ? M64_STAGED_CANARY_ORDER.length - 1
      : M64_STAGED_CANARY_ORDER.length,
    firstWindowPurpose: firstWindowValidated ? M64_STAGED_CANARY_ORDER[0] : null,
    windowInventoryHashes: Object.freeze(firstWindowValidated ? [firstWindow.inventoryHash] : []),
    effectBoundaryHash: effectBoundary.boundaryHash,
    independentOracleArtifactSha256: observerPolicy.artifactSha256,
    resourceObserverHash: observerPolicy.observerHash,
    note: firstWindowValidated
      ? "Only the first SHADOW window is validated. Four future parent-bound windows remain unavailable until prior signed close epochs exist."
      : "All production roots are valid, but no first SHADOW window is published. No future window or live completion readiness is claimed.",
  });
}

function loadM64OperatorEffectBoundary(effectBoundaryDescriptor, releaseRoot = DEFAULT_RELEASE_ROOT) {
  assertOutsideReleaseRoot(effectBoundaryDescriptor?.path, releaseRoot, "M6-4 effect boundary");
  const effectBoundary = loadM64SealedJsonArtifact(effectBoundaryDescriptor, "M6-4 effect boundary");
  const validation = validateM64EffectBoundary(effectBoundary);
  if (!validation.ok) fail("M64_OPERATOR_INPUT_INVALID", validation.errors.join(","), { errors: validation.errors });
  return Object.freeze(effectBoundary);
}

export function atomicWriteCompletionReceipt(auditRoot, receipt) {
  if (!HASH.test(receipt?.receiptHash || "")) fail("M64_AUDIT_RECEIPT_INVALID", "completion receipt lacks its semantic content hash");
  const guard = openPlainAuditDirectoryTree(auditRoot, { create: true, code: "M64_AUDIT_ROOT_INVALID" });
  let temporary = null;
  let fd = null;
  let temporaryIdentity = null;
  try {
    const dir = ensurePlainAuditChildDirectory(guard, "m6-4-action-canary-completion");
    const bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    const expectedRawHash = rawSha(bytes);
    const target = childPath(dir, `${receipt.receiptHash}.json`, "M64_AUDIT_ROOT_INVALID");
    const existing = stableAuditFileBytes(target, guard, { missingOk: true });
    if (existing) {
      if (!existing.equals(bytes)) fail("M64_AUDIT_HASH_COLLISION", "existing completion receipt differs at the same semantic hash");
      return Object.freeze({ path: target, sha256: rawSha(existing) });
    }

    temporary = childPath(dir, `.${receipt.receiptHash}.${randomUUID()}.tmp`, "M64_AUDIT_ROOT_INVALID");
    try {
      revalidateAuditDirectoryGuard(guard);
      fd = openSync(temporary, "wx", 0o600);
      const opened = fstatSync(fd, { bigint: true });
      if (!opened.isFile() || opened.nlink !== 1n) {
        fail("M64_AUDIT_ROOT_INVALID", "audit temporary must be one single-link regular file");
      }
      temporaryIdentity = filesystemIdentity(opened);
      writeFileSync(fd, bytes);
      fsyncSync(fd);
      assertAuditPathMatchesHandle(temporary, fd, temporaryIdentity, guard);

      const concurrentlyPublished = stableAuditFileBytes(target, guard, { missingOk: true });
      if (concurrentlyPublished) {
        if (!concurrentlyPublished.equals(bytes)) {
          fail("M64_AUDIT_HASH_COLLISION", "concurrent completion receipt differs at the same semantic hash");
        }
        closeSync(fd);
        fd = null;
        try { unlinkSync(temporary); } catch {}
        temporary = null;
        bestEffortFsyncAuditDirectory(guard);
        return Object.freeze({ path: target, sha256: rawSha(concurrentlyPublished) });
      }

      revalidateAuditDirectoryGuard(guard);
      renameSync(temporary, target);
      temporary = null;
      assertAuditPathMatchesHandle(target, fd, temporaryIdentity, guard);
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
      bestEffortFsyncAuditDirectory(guard);
      const published = stableAuditFileBytes(target, guard);
      const publishedHash = rawSha(published);
      if (!published.equals(bytes) || publishedHash !== expectedRawHash) {
        fail("M64_AUDIT_READBACK_MISMATCH", "published completion receipt failed exact byte/hash readback");
      }
      return Object.freeze({ path: target, sha256: publishedHash });
    } catch (error) {
      if (fd !== null) try { closeSync(fd); } catch {}
      fd = null;
      if (temporary) {
        try {
          const stat = lstatSync(temporary, { bigint: true });
          if (stat.isFile() && !stat.isSymbolicLink()
            && (!temporaryIdentity || filesystemIdentity(stat) === temporaryIdentity)) unlinkSync(temporary);
        } catch {}
      }
      const concurrent = stableAuditFileBytes(target, guard, { missingOk: true });
      if (concurrent?.equals(bytes)) {
        bestEffortFsyncAuditDirectory(guard);
        return Object.freeze({ path: target, sha256: rawSha(concurrent) });
      }
      if (error?.code?.startsWith?.("M64_")) throw error;
      fail("M64_AUDIT_WRITE_FAILED", "completion receipt could not be atomically published", { cause: error?.code ?? null });
    }
  } finally {
    if (fd !== null) try { closeSync(fd); } catch {}
    closeAuditDirectoryGuard(guard);
  }
}

export function atomicWriteExactJsonArtifact(root, fileName, value, {
  createRoot = false,
  code = "M64_AUDIT_ROOT_INVALID",
} = {}) {
  if (typeof fileName !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,190}\.json$/u.test(fileName)) {
    fail(code, "contract artifact filename is invalid");
  }
  const guard = openPlainAuditDirectoryTree(root, { create: createRoot, code });
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  const expectedRawHash = rawSha(bytes);
  const target = childPath(guard.root, fileName, code);
  let temporary = null;
  let fd = null;
  let temporaryIdentity = null;
  try {
    const existing = stableAuditFileBytes(target, guard, { missingOk: true });
    if (existing) {
      if (!existing.equals(bytes)) fail("M64_AUDIT_HASH_COLLISION", `existing ${fileName} differs from the exact contract artifact`);
      return Object.freeze({ path: target, sha256: rawSha(existing) });
    }
    temporary = childPath(guard.root, `.${fileName}.${randomUUID()}.tmp`, code);
    revalidateAuditDirectoryGuard(guard);
    fd = openSync(temporary, "wx", 0o600);
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n) fail(code, "contract artifact temporary must be one single-link regular file");
    temporaryIdentity = filesystemIdentity(opened);
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    assertAuditPathMatchesHandle(temporary, fd, temporaryIdentity, guard);
    const concurrent = stableAuditFileBytes(target, guard, { missingOk: true });
    if (concurrent) {
      if (!concurrent.equals(bytes)) fail("M64_AUDIT_HASH_COLLISION", `concurrent ${fileName} differs from the exact contract artifact`);
      closeSync(fd);
      fd = null;
      unlinkSync(temporary);
      temporary = null;
      bestEffortFsyncAuditDirectory(guard);
      return Object.freeze({ path: target, sha256: rawSha(concurrent) });
    }
    revalidateAuditDirectoryGuard(guard);
    renameSync(temporary, target);
    temporary = null;
    assertAuditPathMatchesHandle(target, fd, temporaryIdentity, guard);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    bestEffortFsyncAuditDirectory(guard);
    const published = stableAuditFileBytes(target, guard);
    if (!published.equals(bytes) || rawSha(published) !== expectedRawHash) {
      fail("M64_AUDIT_READBACK_MISMATCH", `${fileName} failed exact byte/hash readback`);
    }
    return Object.freeze({ path: target, sha256: expectedRawHash });
  } catch (error) {
    if (fd !== null) try { closeSync(fd); } catch {}
    fd = null;
    if (temporary) {
      try {
        const stat = lstatSync(temporary, { bigint: true });
        if (stat.isFile() && !stat.isSymbolicLink()
          && (!temporaryIdentity || filesystemIdentity(stat) === temporaryIdentity)) unlinkSync(temporary);
      } catch {}
    }
    const concurrent = stableAuditFileBytes(target, guard, { missingOk: true });
    if (concurrent?.equals(bytes)) {
      bestEffortFsyncAuditDirectory(guard);
      return Object.freeze({ path: target, sha256: rawSha(concurrent) });
    }
    if (error?.code?.startsWith?.("M64_")) throw error;
    fail("M64_AUDIT_WRITE_FAILED", `${fileName} could not be atomically published`, { cause: error?.code ?? null });
  } finally {
    if (fd !== null) try { closeSync(fd); } catch {}
    closeAuditDirectoryGuard(guard);
  }
}

export function buildM64LiveResourceCloseoutArtifact({
  result,
  acceptedResourceEvidence,
  acceptedCloseRequests,
  observerPolicy,
} = {}) {
  const receipt = result?.receipt;
  const closeout = result?.resourceCloseout;
  const totalActionCount = deriveM64ResultTotalActionCount(result);
  const expectedPurposes = [...M64_STAGED_CANARY_ORDER, "M6_4_FINAL"];
  const expectedProbes = [
    ...(result?.windowResults || []).map((entry) => entry?.resourceProbe),
    result?.finalResourceProbe,
  ];
  if (!HASH.test(receipt?.receiptHash || "")
    || deriveM64ActionCanaryReceiptHash(receipt) !== receipt.receiptHash
    || !HASH.test(closeout?.resourceCloseoutHash || "")
    || deriveM64ResourceCloseoutHash(closeout) !== closeout.resourceCloseoutHash
    || receipt.resourceCloseoutHash !== closeout.resourceCloseoutHash
    || expectedProbes.length !== expectedPurposes.length
    || !Array.isArray(acceptedResourceEvidence)
    || acceptedResourceEvidence.length !== expectedPurposes.length) {
    fail("M64_LIVE_ARTIFACT_PUBLICATION_INVALID", "verified completion/resource evidence is incomplete or rebound");
  }
  const inventories = acceptedResourceEvidence.map((entry, index) => {
    const purpose = expectedPurposes[index];
    const expectedProbe = expectedProbes[index];
    let rawInventoryBytes = null;
    let rawInventoryValue = null;
    try {
      rawInventoryBytes = Buffer.from(entry?.processInventoryRawBase64 || "", "base64");
      if (rawInventoryBytes.length < 2
        || rawInventoryBytes.toString("base64") !== entry.processInventoryRawBase64
        || rawSha(rawInventoryBytes) !== entry.processInventorySha256) throw new Error("raw inventory hash mismatch");
      rawInventoryValue = JSON.parse(rawInventoryBytes.toString("utf8"));
    } catch {
      fail("M64_LIVE_ARTIFACT_PUBLICATION_INVALID", `${purpose} exact independent inventory bytes are missing or rebound`);
    }
    if (entry?.purpose !== purpose || entry?.gateClosedEpochHash !== expectedProbe?.gateClosedEpochHash
      || canonical(entry?.resourceProbe) !== canonical(expectedProbe)
      || entry?.processInventorySha256 !== expectedProbe?.processInventorySha256
      || canonical(rawInventoryValue) !== canonical(entry?.processInventory)
      || entry?.processInventory?.inventoryHash !== expectedProbe?.processInventoryHash
      || deriveM64ProcessInventoryHash(entry?.processInventory) !== entry?.processInventory?.inventoryHash) {
      fail("M64_LIVE_ARTIFACT_PUBLICATION_INVALID", `${purpose} independent resource evidence is missing or rebound`);
    }
    let requestBytes;
    let request;
    try {
      requestBytes = Buffer.from(entry.resourceObservationRequestRawBase64 || "", "base64");
      request = JSON.parse(requestBytes.toString("utf8"));
    } catch {
      fail("M64_LIVE_ARTIFACT_PUBLICATION_INVALID", `${purpose} resource-observation request bytes are missing`);
    }
    if (!exactObject(request, ["closeReceiptHashes", "gateClosedEpochHash", "notBefore", "purpose", "requestHash"])
      || !requestBytes.equals(exactJsonBytes(request))
      || requestBytes.toString("base64") !== entry.resourceObservationRequestRawBase64
      || rawSha(requestBytes) !== entry.resourceObservationRequestSha256
      || request.requestHash !== entry.resourceObservationRequestHash
      || request.requestHash !== expectedProbe.resourceObservationRequestHash
      || request.requestHash !== deriveM64ResourceObservationRequestHash(request)
      || canonical(request) !== canonical(entry.resourceObservationRequest)) {
      fail("M64_LIVE_ARTIFACT_PUBLICATION_INVALID", `${purpose} resource-observation request is missing or rebound`);
    }
    return Object.freeze({
      purpose,
      gateClosedEpochHash: entry.gateClosedEpochHash,
      processInventorySha256: entry.processInventorySha256,
      processInventoryRawBase64: entry.processInventoryRawBase64,
      processInventory: entry.processInventory,
      resourceObservationRequestHash: entry.resourceObservationRequestHash,
      resourceObservationRequestSha256: entry.resourceObservationRequestSha256,
      resourceObservationRequestRawBase64: entry.resourceObservationRequestRawBase64,
      resourceObservationRequest: request,
    });
  });
  const closePurposes = M64_STAGED_CANARY_ORDER.filter((purpose) => purpose !== "M6_4_HOT_CLOSE");
  if (!Array.isArray(acceptedCloseRequests) || acceptedCloseRequests.length !== closePurposes.length) {
    fail("M64_LIVE_ARTIFACT_PUBLICATION_INVALID", "normal-close signing request audit is incomplete");
  }
  const normalCloseSigningRequests = acceptedCloseRequests.map((entry, index) => {
    const purpose = closePurposes[index];
    const windowResult = (result?.windowResults || []).find((candidate) => candidate?.window?.manifest?.purpose === purpose);
    let requestBytes;
    let request;
    try {
      requestBytes = Buffer.from(entry?.requestRawBase64 || "", "base64");
      request = JSON.parse(requestBytes.toString("utf8"));
    } catch {
      fail("M64_LIVE_ARTIFACT_PUBLICATION_INVALID", `${purpose} normal-close request bytes are missing`);
    }
    const { requestHash, ...requestRaw } = request || {};
    if (!exactObject(request, [
      "activationParentEpochHash", "aggregate", "aggregateHash", "attemptEvidence", "attemptEvidenceHashes",
      "currentGateEpochHash", "deadline", "purpose", "requestHash", "requestNonce", "requestedAt",
    ]) || !requestBytes.equals(exactJsonBytes(request))
      || requestBytes.toString("base64") !== entry.requestRawBase64
      || rawSha(requestBytes) !== entry.requestSha256
      || requestHash !== entry.requestHash
      || requestHash !== deriveM64NormalCloseSigningRequestHash(requestRaw)
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(request.requestNonce || "")
      || purpose !== request.purpose
      || request.currentGateEpochHash !== windowResult?.window?.authorization?.gateEpochHash
      || request.activationParentEpochHash !== windowResult?.window?.activationPackage?.epoch?.parentEpochHash
      || canonical(request.aggregate) !== canonical(windowResult?.aggregate)
      || request.aggregateHash !== windowResult?.aggregate?.aggregateHash
      || canonical(request.attemptEvidence) !== canonical(windowResult?.attemptEvidence)
      || canonical(request.attemptEvidenceHashes) !== canonical(windowResult?.attemptEvidence?.map((item) => item.attemptHash))) {
      fail("M64_LIVE_ARTIFACT_PUBLICATION_INVALID", `${purpose} normal-close signing request is missing or rebound`);
    }
    return Object.freeze({
      purpose,
      requestHash,
      requestSha256: entry.requestSha256,
      requestRawBase64: entry.requestRawBase64,
      request,
    });
  });
  const raw = {
    schemaId: "xw.m6-4-live-resource-closeout-artifact.v1",
    completionReceiptHash: receipt.receiptHash,
    totalActionCount,
    resourceCloseout: closeout,
    finalGateStatus: result.finalGateStatus,
    windowResourceProbes: expectedProbes.slice(0, -1),
    finalResourceProbe: expectedProbes.at(-1),
    independentProcessInventories: inventories,
    resourceObservationRequests: inventories.map((entry) => Object.freeze({
      purpose: entry.purpose,
      requestHash: entry.resourceObservationRequestHash,
      requestSha256: entry.resourceObservationRequestSha256,
      requestRawBase64: entry.resourceObservationRequestRawBase64,
      request: entry.resourceObservationRequest,
    })),
    normalCloseSigningRequests,
    observerAuthority: {
      artifactSha256: observerPolicy?.artifactSha256,
      keyId: observerPolicy?.keyId,
      observerHash: observerPolicy?.observerHash,
      policyHash: observerPolicy?.policyHash,
      publicKey: observerPolicy?.policy?.observationObserverPublicKey,
    },
  };
  if (!HASH.test(raw.observerAuthority.artifactSha256 || "")
    || !KEY_ID.test(raw.observerAuthority.keyId || "")
    || !HASH.test(raw.observerAuthority.observerHash || "")
    || !HASH.test(raw.observerAuthority.policyHash || "")
    || typeof raw.observerAuthority.publicKey !== "string"
    || /PRIVATE KEY/u.test(raw.observerAuthority.publicKey)) {
    fail("M64_LIVE_ARTIFACT_PUBLICATION_INVALID", "independent observer authority is not publishable");
  }
  return Object.freeze({
    ...raw,
    artifactHash: sha("xw.m6-4-live-resource-closeout-artifact.v1", raw),
  });
}

const M64_PUBLICATION_JOURNAL_DIRECTORY = "m6-4-publication-journal";
const M64_PUBLICATION_JOURNAL_SCHEMA_ID = "xw.m6-4-contract-publication-bundle.v1";
const M64_EXECUTION_INTENT_DIRECTORY = "m6-4-execution-intent";
const M64_EXECUTION_INTENT_FILE = "m6-4-live-execution-intent.json";
const M64_EXECUTION_INTENT_SCHEMA_ID = "xw.m6-4-live-execution-intent.v1";
const M64_EXECUTION_RECOVERY_DIRECTORY = "m6-4-execution-recovery";
const M64_EXECUTION_RECOVERY_SCHEMA_ID = "xw.m6-4-live-execution-recovery-only.v1";
const M64_PUBLICATION_ARTIFACT_IDS = Object.freeze([
  "IMMUTABLE_AUDIT_COMPLETION",
  "AUDIT_RESOURCE_CLOSEOUT",
  "REPOSITORY_RESOURCE_CLOSEOUT",
  "REPOSITORY_COMPLETION",
  "AUDIT_COMPLETION_SENTINEL",
]);

function exactJsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function deriveM64ExecutionIntentHash(value) {
  const { intentHash: _ignored, ...raw } = value || {};
  return sha(M64_EXECUTION_INTENT_SCHEMA_ID, raw);
}

function validateM64ExecutionIntent(intent, roots, controlPlaneUrl) {
  const keys = [
    "auditRoot", "authorizationMode", "cohortOrder", "controlPlaneOrigin", "createdAt",
    "effectBoundaryHash", "independentOracleArtifactSha256", "intentHash", "invocationId",
    "releaseRoot", "repositoryRoot", "resourceObserverHash", "schemaId",
    "windowInventoryHashes", "windowInventoryRoot",
  ];
  if (!exactObject(intent, keys) || intent.schemaId !== M64_EXECUTION_INTENT_SCHEMA_ID
    || !HASH.test(intent.intentHash || "") || deriveM64ExecutionIntentHash(intent) !== intent.intentHash
    || !["FROZEN_FIVE_WINDOWS", "LAZY_PARENT_CHAIN"].includes(intent.authorizationMode)
    || canonical(intent.cohortOrder) !== canonical(M64_STAGED_CANARY_ORDER)
    || intent.controlPlaneOrigin !== new URL(controlPlaneUrl).href
    || !Number.isFinite(Date.parse(intent.createdAt))
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(intent.invocationId || "")
    || !HASH.test(intent.effectBoundaryHash || "")
    || !HASH.test(intent.independentOracleArtifactSha256 || "")
    || !HASH.test(intent.resourceObserverHash || "")
    || normalizedFilesystemPath(intent.auditRoot || "") !== normalizedFilesystemPath(roots.auditRoot)
    || normalizedFilesystemPath(intent.repositoryRoot || "") !== normalizedFilesystemPath(roots.repositoryRoot)
    || normalizedFilesystemPath(intent.releaseRoot || "") !== normalizedFilesystemPath(roots.releaseRoot)
    || (intent.windowInventoryRoot !== null
      && normalizedFilesystemPath(intent.windowInventoryRoot || "") !== normalizedFilesystemPath(roots.windowInventoryInboxRoot || ""))
    || !Array.isArray(intent.windowInventoryHashes)
    || intent.windowInventoryHashes.some((value) => !HASH.test(value || ""))
    || (intent.authorizationMode === "FROZEN_FIVE_WINDOWS"
      && intent.windowInventoryHashes.length !== M64_STAGED_CANARY_ORDER.length)
    || (intent.authorizationMode === "LAZY_PARENT_CHAIN"
      && (intent.windowInventoryRoot === null || intent.windowInventoryHashes.length !== 0))) {
    fail("M64_EXECUTION_INTENT_INVALID", "the durable no-replay execution intent is malformed or rebound");
  }
  return Object.freeze(intent);
}

function loadM64ExecutionIntentState(roots, controlPlaneUrl) {
  const intentRoot = resolve(roots.auditRoot, M64_EXECUTION_INTENT_DIRECTORY);
  let stat;
  try { stat = lstatSync(intentRoot); } catch (error) {
    if (error?.code === "ENOENT") return null;
    fail("M64_EXECUTION_INTENT_INVALID", "the execution-intent root is unavailable", { cause: error?.code ?? null });
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || normalizedFilesystemPath(realpathSync(intentRoot)) !== normalizedFilesystemPath(intentRoot)) {
    fail("M64_EXECUTION_INTENT_INVALID", "the execution-intent root must be one plain directory");
  }
  const entries = readdirSync(intentRoot).sort();
  const temporaryPattern = /^\.m6-4-live-execution-intent\.json\.[0-9a-f-]{36}\.tmp$/iu;
  if (entries.some((name) => name !== M64_EXECUTION_INTENT_FILE && !temporaryPattern.test(name))) {
    fail("M64_EXECUTION_INTENT_INVALID", "the execution-intent root contains an unexpected entry");
  }
  if (!entries.includes(M64_EXECUTION_INTENT_FILE)) {
    // Directory creation and temporary-file durability both precede rename.
    // Any interrupted form is therefore material evidence that a live attempt
    // may have started; it must block replay even when no canonical JSON exists.
    return Object.freeze({ state: "INTERRUPTED", intent: null, intentHash: null });
  }
  const bytes = stablePublicationArtifactBytes(
    intentRoot, M64_EXECUTION_INTENT_FILE, "M64_EXECUTION_INTENT_INVALID",
  );
  let intent;
  try { intent = JSON.parse(bytes.toString("utf8")); } catch {
    fail("M64_EXECUTION_INTENT_INVALID", "the durable execution intent JSON is malformed");
  }
  if (!bytes.equals(exactJsonBytes(intent))) {
    fail("M64_EXECUTION_INTENT_INVALID", "the durable execution intent encoding is not exact");
  }
  const validated = validateM64ExecutionIntent(intent, roots, controlPlaneUrl);
  return Object.freeze({ state: "DURABLE", intent: validated, intentHash: validated.intentHash });
}

function createM64ExecutionIntent({
  roots,
  controlPlaneUrl,
  windows,
  effectBoundary,
  observerPolicy,
  now,
} = {}) {
  if (loadM64ExecutionIntentState(roots, controlPlaneUrl)) {
    fail("M64_EXECUTION_RECOVERY_REQUIRED_NO_LIVE_REPLAY", "a prior live execution intent already exists");
  }
  const raw = {
    schemaId: M64_EXECUTION_INTENT_SCHEMA_ID,
    auditRoot: roots.auditRoot,
    repositoryRoot: roots.repositoryRoot,
    releaseRoot: roots.releaseRoot,
    controlPlaneOrigin: new URL(controlPlaneUrl).href,
    cohortOrder: [...M64_STAGED_CANARY_ORDER],
    authorizationMode: windows ? "FROZEN_FIVE_WINDOWS" : "LAZY_PARENT_CHAIN",
    windowInventoryRoot: windows ? null : roots.windowInventoryInboxRoot,
    windowInventoryHashes: windows ? windows.map((window) => window.inventoryHash) : [],
    effectBoundaryHash: effectBoundary?.boundaryHash,
    independentOracleArtifactSha256: observerPolicy?.artifactSha256,
    resourceObserverHash: observerPolicy?.observerHash,
    createdAt: new Date(now()).toISOString(),
    invocationId: randomUUID(),
  };
  const intent = Object.freeze({ ...raw, intentHash: deriveM64ExecutionIntentHash(raw) });
  validateM64ExecutionIntent(intent, roots, controlPlaneUrl);
  const intentRoot = resolve(roots.auditRoot, M64_EXECUTION_INTENT_DIRECTORY);
  const artifact = atomicWriteExactJsonArtifact(intentRoot, M64_EXECUTION_INTENT_FILE, intent, {
    createRoot: true,
    code: "M64_EXECUTION_INTENT_INVALID",
  });
  return Object.freeze({ intent, intentHash: intent.intentHash, artifact });
}

function assertM64ExecutionIntentRecoveryBindings(intentState, effectBoundary, observerPolicy) {
  if (intentState?.state !== "DURABLE" || !intentState.intent || !HASH.test(intentState.intentHash || "")
    || intentState.intent.effectBoundaryHash !== effectBoundary?.boundaryHash
    || intentState.intent.independentOracleArtifactSha256 !== observerPolicy?.artifactSha256
    || intentState.intent.resourceObserverHash !== observerPolicy?.observerHash) {
    fail("M64_EXECUTION_INTENT_RECOVERY_BINDING_INVALID", "pending execution recovery is not bound to the sealed effect boundary and independent observer policy");
  }
  return intentState.intent;
}

function assertM64RecoveryClosedGateStatus(status, {
  epochHash = null,
  requireZeroResources = false,
} = {}) {
  if (!exactObject(status, GATE_STATUS_KEYS)
    || status.schemaId !== "xw.m6-gate-f-operations-status.v1"
    || status.mode !== "CLOSED" || status.phase !== "CLOSED" || status.tripleConsistent !== true
    || status.activeAuthorizationCount !== 0 || status.actionCount !== 0
    || !HASH.test(status.epochHash || "") || (epochHash !== null && status.epochHash !== epochHash)
    || !Number.isSafeInteger(status.generation) || status.generation < 0
    || !(status.locksHash === null || HASH.test(status.locksHash || ""))
    || !(status.purpose === null || M64_STAGED_CANARY_ORDER.includes(status.purpose))
    || !Array.isArray(status.errors) || status.errors.length !== 0
    || !exactObject(status.resourceCounts, ["jobs", "leases", "runs", "sessions"])
    || Object.values(status.resourceCounts).some((count) => !Number.isSafeInteger(count) || count < 0)
    || (requireZeroResources && Object.values(status.resourceCounts).some((count) => count !== 0))) {
    fail("M64_EXECUTION_RECOVERY_GATE_INVALID", "execution recovery requires one exact CLOSED Gate triple with the required zero-resource postcondition");
  }
  return status;
}

function assertM64GateRecoveryResult(value) {
  const recovery = value?.recovery;
  const gate = value?.gate;
  const validDisposition = recovery?.recovered === true && recovery?.status === "EMERGENCY_CLOSED"
    || recovery?.recovered === false && recovery?.status === "ALREADY_CLOSED";
  if (!exactObject(value, ["gate", "recovery"])
    || !exactObject(recovery, [
      "priorEpochHash", "recovered", "schemaId", "status", "terminalEpochHash", "tripleConsistent",
    ])
    || recovery.schemaId !== "xw.m6-gate-f-armed-active-recovery.v1"
    || !validDisposition || !HASH.test(recovery.priorEpochHash || "")
    || !HASH.test(recovery.terminalEpochHash || "") || recovery.tripleConsistent !== true) {
    fail("M64_EXECUTION_RECOVERY_GATE_INVALID", "Gate recovery response is not the exact recovery-only contract");
  }
  assertM64RecoveryClosedGateStatus(gate, { epochHash: recovery.terminalEpochHash });
  if (recovery.recovered === true && recovery.priorEpochHash === recovery.terminalEpochHash) {
    fail("M64_EXECUTION_RECOVERY_GATE_INVALID", "an emergency close must identify its distinct active predecessor epoch");
  }
  return value;
}

function assertM64LiveEpochRecoveryResult(value, { gateEpochHash, purpose } = {}) {
  const keys = [
    "activeMatchingRuns", "attempted", "closeReceipts", "controlPlaneOwnedActiveRuns",
    "externalResourceState", "gateEpochHash", "inFlightStartsSettled", "purpose",
    "schemaId", "status", "stopNewStarts", "verifiedClosed",
  ];
  if (!exactObject(value, keys)
    || value.schemaId !== "xw.m6-live-entry-epoch-recovery.v1" || value.status !== "RECOVERED"
    || value.stopNewStarts !== true || value.gateEpochHash !== gateEpochHash || value.purpose !== purpose
    || value.externalResourceState !== "NOT_ASSERTED"
    || !["inFlightStartsSettled", "attempted", "verifiedClosed", "activeMatchingRuns", "controlPlaneOwnedActiveRuns"]
      .every((key) => Number.isSafeInteger(value[key]) && value[key] >= 0)
    || value.activeMatchingRuns !== 0 || value.controlPlaneOwnedActiveRuns !== 0
    || value.attempted !== value.verifiedClosed
    || !Array.isArray(value.closeReceipts) || value.closeReceipts.length !== value.verifiedClosed) {
    fail("M64_EXECUTION_RECOVERY_LIVE_INVALID", "live epoch recovery did not prove every Control-Plane-owned run closed");
  }
  const runIds = new Set();
  const closeReceiptHashes = new Set();
  for (const receipt of value.closeReceipts) {
    if (!exactObject(receipt, ["attemptEvidenceHash", "closeReceiptHash", "runId"])
      || typeof receipt.runId !== "string" || !/^[a-z0-9][a-z0-9:_-]{7,127}$/u.test(receipt.runId)
      || !HASH.test(receipt.closeReceiptHash || "")
      || !(receipt.attemptEvidenceHash === null || HASH.test(receipt.attemptEvidenceHash || ""))
      || runIds.has(receipt.runId) || closeReceiptHashes.has(receipt.closeReceiptHash)) {
      fail("M64_EXECUTION_RECOVERY_LIVE_INVALID", "live epoch recovery close receipts are malformed, rebound, or duplicated");
    }
    runIds.add(receipt.runId);
    closeReceiptHashes.add(receipt.closeReceiptHash);
  }
  return value;
}

function assertExactRawJsonBase64(rawBase64, value, code, { exactEncoding = true } = {}) {
  let bytes;
  let parsed;
  try {
    bytes = Buffer.from(rawBase64, "base64");
    if (bytes.length < 2 || bytes.toString("base64") !== rawBase64) throw new Error("invalid base64");
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(code, "recovery artifact raw JSON evidence is malformed");
  }
  if (canonical(parsed) !== canonical(value) || (exactEncoding && !bytes.equals(exactJsonBytes(value)))) {
    fail(code, "recovery artifact raw JSON evidence is rebound or not exactly encoded");
  }
  return bytes;
}

export function deriveM64ExecutionRecoveryArtifactHash(value) {
  const { artifactHash: _ignored, ...raw } = value || {};
  return sha(M64_EXECUTION_RECOVERY_SCHEMA_ID, raw);
}

function validateM64ExecutionRecoveryArtifact(artifact, {
  intentState,
  effectBoundary,
  observerPolicy,
} = {}) {
  const keys = [
    "actionCount", "artifactHash", "closeReceiptHashes", "effectBoundaryHash", "executionIntentHash",
    "executionIntentRawBase64", "externalResourceState", "gateRecovery", "gateStatus",
    "independentOracleArtifactSha256", "liveCompletionClaim", "liveRecovery", "liveReplayPrevented",
    "processInventory", "processInventoryRawBase64", "processInventorySha256", "purpose", "recoveredAt",
    "recoveryOnly", "resourceObservationRequest", "resourceObservationRequestHash",
    "resourceObservationRequestLocator", "resourceObservationRequestLocatorSha256",
    "resourceObservationRequestRawBase64", "resourceObservationRequestSha256", "resourceObserverHash",
    "schemaId",
  ];
  const intent = assertM64ExecutionIntentRecoveryBindings(intentState, effectBoundary, observerPolicy);
  if (!exactObject(artifact, keys) || artifact.schemaId !== M64_EXECUTION_RECOVERY_SCHEMA_ID
    || !HASH.test(artifact.artifactHash || "")
    || artifact.artifactHash !== deriveM64ExecutionRecoveryArtifactHash(artifact)
    || artifact.executionIntentHash !== intentState.intentHash
    || artifact.effectBoundaryHash !== effectBoundary.boundaryHash
    || artifact.independentOracleArtifactSha256 !== observerPolicy.artifactSha256
    || artifact.resourceObserverHash !== observerPolicy.observerHash
    || artifact.recoveryOnly !== true || artifact.liveReplayPrevented !== true
    || artifact.liveCompletionClaim !== null || artifact.actionCount !== null
    || artifact.externalResourceState !== "ZERO_ASSERTED_BY_SIGNED_OBSERVER"
    || !Number.isFinite(Date.parse(artifact.recoveredAt))
    || !Array.isArray(artifact.closeReceiptHashes)
    || artifact.closeReceiptHashes.some((value) => !HASH.test(value || ""))
    || new Set(artifact.closeReceiptHashes).size !== artifact.closeReceiptHashes.length
    || canonical(artifact.closeReceiptHashes) !== canonical([...artifact.closeReceiptHashes].sort())) {
    fail("M64_EXECUTION_RECOVERY_ARTIFACT_INVALID", "execution recovery artifact identity or no-replay disposition is invalid");
  }
  assertExactRawJsonBase64(
    artifact.executionIntentRawBase64, intent, "M64_EXECUTION_RECOVERY_ARTIFACT_INVALID",
  );
  const gateRecovery = assertM64GateRecoveryResult(artifact.gateRecovery);
  const priorEpochHash = gateRecovery.recovery.priorEpochHash;
  const terminalEpochHash = gateRecovery.recovery.terminalEpochHash;
  const purpose = gateRecovery.gate.purpose ?? "M6_4_FINAL";
  if (artifact.purpose !== purpose) {
    fail("M64_EXECUTION_RECOVERY_ARTIFACT_INVALID", "execution recovery purpose is rebound from the recovered Gate");
  }
  if (priorEpochHash === terminalEpochHash) {
    if (artifact.liveRecovery !== null || artifact.closeReceiptHashes.length !== 0) {
      fail("M64_EXECUTION_RECOVERY_ARTIFACT_INVALID", "a no-predecessor Gate recovery cannot claim live epoch close receipts");
    }
  } else {
    if (!M64_STAGED_CANARY_ORDER.includes(gateRecovery.gate.purpose)) {
      fail("M64_EXECUTION_RECOVERY_ARTIFACT_INVALID", "an active predecessor requires its exact bounded Gate purpose");
    }
    assertM64LiveEpochRecoveryResult(artifact.liveRecovery, {
      gateEpochHash: priorEpochHash,
      purpose: gateRecovery.gate.purpose,
    });
    const expectedCloseHashes = artifact.liveRecovery.closeReceipts
      .map((receipt) => receipt.closeReceiptHash).sort();
    if (canonical(artifact.closeReceiptHashes) !== canonical(expectedCloseHashes)) {
      fail("M64_EXECUTION_RECOVERY_ARTIFACT_INVALID", "execution recovery close receipt hashes are incomplete or rebound");
    }
  }
  assertM64RecoveryClosedGateStatus(artifact.gateStatus, {
    epochHash: terminalEpochHash,
    requireZeroResources: true,
  });
  const request = artifact.resourceObservationRequest;
  if (!exactObject(request, ["closeReceiptHashes", "gateClosedEpochHash", "notBefore", "purpose", "requestHash"])
    || request.purpose !== purpose || request.gateClosedEpochHash !== terminalEpochHash
    || canonical(request.closeReceiptHashes) !== canonical(artifact.closeReceiptHashes)
    || !Number.isFinite(Date.parse(request.notBefore))
    || request.requestHash !== deriveM64ResourceObservationRequestHash(request)
    || artifact.resourceObservationRequestHash !== request.requestHash) {
    fail("M64_EXECUTION_RECOVERY_ARTIFACT_INVALID", "execution recovery observer request is malformed or rebound");
  }
  const requestBytes = assertExactRawJsonBase64(
    artifact.resourceObservationRequestRawBase64,
    request,
    "M64_EXECUTION_RECOVERY_ARTIFACT_INVALID",
  );
  if (artifact.resourceObservationRequestSha256 !== rawSha(requestBytes)) {
    fail("M64_EXECUTION_RECOVERY_ARTIFACT_INVALID", "execution recovery observer request raw hash is invalid");
  }
  const locator = artifact.resourceObservationRequestLocator;
  const { locatorHash, ...locatorRaw } = locator || {};
  if (!exactObject(locator, [
    "artifactFileName", "kind", "locatorHash", "purpose", "requestHash", "requestSha256", "responseDescriptorFileName", "schemaId",
  ]) || locator.schemaId !== "xw.m6-4-external-handoff-request-locator.v1"
    || locator.kind !== "RESOURCE_OBSERVATION" || locator.purpose !== purpose
    || locator.requestHash !== request.requestHash || locator.requestSha256 !== rawSha(requestBytes)
    || locator.artifactFileName !== `${request.requestHash}.resource-observation.json`
    || locator.responseDescriptorFileName !== `${purpose}.${request.requestHash}.resource.descriptor.json`
    || locatorHash !== deriveM64HandoffLocatorHash(locatorRaw)
    || artifact.resourceObservationRequestLocatorSha256 !== rawSha(exactJsonBytes(locator))) {
    fail("M64_EXECUTION_RECOVERY_ARTIFACT_INVALID", "execution recovery observer locator is malformed or rebound", {
      expectedLocatorHash: deriveM64HandoffLocatorHash(locatorRaw),
      locatorHash,
      expectedLocatorSha256: rawSha(exactJsonBytes(locator)),
      locatorSha256: artifact.resourceObservationRequestLocatorSha256,
    });
  }
  const inventoryBytes = assertExactRawJsonBase64(
    artifact.processInventoryRawBase64,
    artifact.processInventory,
    "M64_EXECUTION_RECOVERY_ARTIFACT_INVALID",
    { exactEncoding: false },
  );
  if (artifact.processInventorySha256 !== rawSha(inventoryBytes)) {
    fail("M64_EXECUTION_RECOVERY_ARTIFACT_INVALID", "signed process inventory raw hash is invalid");
  }
  const notBeforeMs = Date.parse(request.notBefore);
  const capturedAtMs = Date.parse(artifact.processInventory?.capturedAt);
  const recoveredAtMs = Date.parse(artifact.recoveredAt);
  const inventoryValidation = validateM64IndependentProcessInventory(artifact.processInventory, {
    purpose,
    gateClosedEpochHash: terminalEpochHash,
    closeReceiptHashes: artifact.closeReceiptHashes,
    observerPolicy,
    notBeforeMs,
    nowMs: capturedAtMs,
    maxAgeMs: observerPolicy.maxObservationAgeMs,
  });
  const nonzeroInventory = [
    "activeBrokerRefs", "activePipeRefs", "activeProcessRefs", "activeScenarioClaimRefs", "orphanProcessRefs",
    "rawDeviceIdentityFindings", "secretMaterialFindings",
  ].some((key) => !Array.isArray(artifact.processInventory?.[key]) || artifact.processInventory[key].length !== 0);
  if (!inventoryValidation.ok || nonzeroInventory
    || !Number.isFinite(capturedAtMs) || recoveredAtMs < capturedAtMs
    || recoveredAtMs - capturedAtMs > observerPolicy.maxObservationAgeMs) {
    fail("M64_EXECUTION_RECOVERY_ARTIFACT_INVALID", "signed independent observer inventory does not prove exact external zero");
  }
  return Object.freeze(artifact);
}

function loadM64ExecutionRecoveryArtifact({
  roots,
  intentState,
  effectBoundary,
  observerPolicy,
} = {}) {
  const recoveryRoot = resolve(roots.auditRoot, M64_EXECUTION_RECOVERY_DIRECTORY);
  let stat;
  try { stat = lstatSync(recoveryRoot); } catch (error) {
    if (error?.code === "ENOENT") return null;
    fail("M64_EXECUTION_RECOVERY_ARTIFACT_INVALID", "execution recovery artifact root is unavailable");
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || normalizedFilesystemPath(realpathSync(recoveryRoot)) !== normalizedFilesystemPath(recoveryRoot)) {
    fail("M64_EXECUTION_RECOVERY_ARTIFACT_INVALID", "execution recovery artifact root must be one plain directory");
  }
  const entries = readdirSync(recoveryRoot).sort();
  const artifactPattern = /^[0-9a-f]{64}\.json$/u;
  const temporaryPattern = /^\.[0-9a-f]{64}\.json\.[0-9a-f-]{36}\.tmp$/iu;
  if (entries.some((name) => !artifactPattern.test(name) && !temporaryPattern.test(name))) {
    fail("M64_EXECUTION_RECOVERY_ARTIFACT_INVALID", "execution recovery artifact root contains an unexpected entry");
  }
  for (const name of entries.filter((entry) => temporaryPattern.test(entry))) {
    const temporary = lstatSync(childPath(
      recoveryRoot, name, "M64_EXECUTION_RECOVERY_ARTIFACT_INVALID",
    ), { bigint: true });
    if (!temporary.isFile() || temporary.isSymbolicLink() || temporary.nlink !== 1n) {
      fail("M64_EXECUTION_RECOVERY_ARTIFACT_INVALID", "an interrupted recovery artifact temporary is not a plain single-link file");
    }
  }
  const artifacts = entries.filter((name) => artifactPattern.test(name));
  if (artifacts.length > 1) {
    fail("M64_EXECUTION_RECOVERY_ARTIFACT_AMBIGUOUS", "multiple recovery-only artifacts cannot be reconciled safely");
  }
  if (artifacts.length === 0) return null;
  const bytes = stablePublicationArtifactBytes(
    recoveryRoot, artifacts[0], "M64_EXECUTION_RECOVERY_ARTIFACT_INVALID",
  );
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); } catch {
    fail("M64_EXECUTION_RECOVERY_ARTIFACT_INVALID", "execution recovery artifact JSON is malformed");
  }
  if (!bytes.equals(exactJsonBytes(value)) || artifacts[0] !== `${value?.artifactHash}.json`) {
    fail("M64_EXECUTION_RECOVERY_ARTIFACT_INVALID", "execution recovery artifact encoding or filename is rebound");
  }
  const artifact = validateM64ExecutionRecoveryArtifact(value, {
    intentState, effectBoundary, observerPolicy,
  });
  return Object.freeze({ artifact, path: resolve(recoveryRoot, artifacts[0]), sha256: rawSha(bytes) });
}

function persistM64ExecutionRecoveryArtifact(raw, context) {
  const artifact = Object.freeze({ ...raw, artifactHash: deriveM64ExecutionRecoveryArtifactHash(raw) });
  validateM64ExecutionRecoveryArtifact(artifact, context);
  const root = resolve(context.roots.auditRoot, M64_EXECUTION_RECOVERY_DIRECTORY);
  const written = atomicWriteExactJsonArtifact(root, `${artifact.artifactHash}.json`, artifact, {
    createRoot: true,
    code: "M64_EXECUTION_RECOVERY_ARTIFACT_INVALID",
  });
  if (written.sha256 !== rawSha(exactJsonBytes(artifact))) {
    fail("M64_EXECUTION_RECOVERY_ARTIFACT_INVALID", "execution recovery artifact failed exact durable readback");
  }
  return Object.freeze({ artifact, path: written.path, sha256: written.sha256 });
}

function executionRecoveryRequiredResult(intentState, recoveryArtifact = null) {
  return Object.freeze({
    ok: false,
    mode: recoveryArtifact ? "RECOVERY_REQUIRED_NO_LIVE_REPLAY" : "EXECUTION_RECOVERY_REQUIRED",
    terminalStatus: "M6_4_RECOVERY_REQUIRED_NO_LIVE_REPLAY",
    liveCompletionClaim: null,
    completionReceiptHash: null,
    actionCount: null,
    recoveredPublication: false,
    liveReplayPrevented: true,
    executionIntentHash: intentState?.intentHash ?? null,
    recoveryArtifactHash: recoveryArtifact?.artifact?.artifactHash ?? null,
  });
}

async function recoverM64PendingExecutionIntent({
  intentState,
  roots,
  controlPlaneUrl,
  gateToken,
  liveToken,
  fetchImpl,
  effectBoundary,
  observerPolicy,
  now,
  waitForPoll,
  waitMs,
  pollMs,
} = {}) {
  const intent = assertM64ExecutionIntentRecoveryBindings(intentState, effectBoundary, observerPolicy);
  const priorArtifact = loadM64ExecutionRecoveryArtifact({ roots, intentState, effectBoundary, observerPolicy });
  if (priorArtifact) return executionRecoveryRequiredResult(intentState, priorArtifact);

  const audited = createM64AuditedLoopbackCanaryClient({
    controlPlaneUrl, gateToken, liveToken, fetchImpl, now,
  });
  const gateRecovery = assertM64GateRecoveryResult(await audited.client.recoverArmedActive({}));
  const priorEpochHash = gateRecovery.recovery.priorEpochHash;
  const terminalEpochHash = gateRecovery.recovery.terminalEpochHash;
  const gatePurpose = gateRecovery.gate.purpose;
  const purpose = gatePurpose ?? "M6_4_FINAL";
  let liveRecovery = null;
  if (priorEpochHash !== terminalEpochHash) {
    if (!M64_STAGED_CANARY_ORDER.includes(gatePurpose)) {
      fail("M64_EXECUTION_RECOVERY_GATE_INVALID", "active predecessor recovery lacks its exact bounded Gate purpose");
    }
    liveRecovery = assertM64LiveEpochRecoveryResult(await audited.client.liveRecoverEpoch({
      gateEpochHash: priorEpochHash,
      purpose: gatePurpose,
    }), { gateEpochHash: priorEpochHash, purpose: gatePurpose });
  }
  const closeReceiptHashes = liveRecovery
    ? liveRecovery.closeReceipts.map((receipt) => receipt.closeReceiptHash).sort()
    : [];
  const freshGateStatus = assertM64RecoveryClosedGateStatus(await audited.client.gateStatus(), {
    epochHash: terminalEpochHash,
    requireZeroResources: true,
  });
  const notBeforeMs = now();
  const requestRaw = {
    purpose,
    gateClosedEpochHash: terminalEpochHash,
    closeReceiptHashes,
    notBefore: new Date(notBeforeMs).toISOString(),
  };
  const requestHash = deriveM64ResourceObservationRequestHash(requestRaw);
  const request = Object.freeze({ ...requestRaw, requestHash });
  const responseDescriptorFileName = `${purpose}.${requestHash}.resource.descriptor.json`;
  const publishedRequest = publishM64ExternalHandoffRequest({
    requestsRoot: observerPolicy.requestsRoot,
    kind: "RESOURCE_OBSERVATION",
    purpose,
    request,
    requestHash,
    responseDescriptorFileName,
    forbiddenTokens: [gateToken, liveToken],
  });
  const processLoader = createM64ProcessInventoryInboxLoader({
    inboxRoot: roots.processInventoryInboxRoot,
    now,
    waitForPoll,
    waitMs,
    pollMs,
  });
  const descriptor = await processLoader({
    ...requestRaw,
    requestHash,
    responseDescriptorFileName,
  });
  const inventoryRecord = loadM64SealedJsonArtifactRecord(
    { path: descriptor.path, sha256: descriptor.sha256 },
    `${purpose} recovery-only independent process inventory`,
  );
  const inventory = inventoryRecord.value;
  const observedAtMs = now();
  const inventoryValidation = validateM64IndependentProcessInventory(inventory, {
    purpose,
    gateClosedEpochHash: terminalEpochHash,
    closeReceiptHashes,
    observerPolicy,
    notBeforeMs,
    nowMs: observedAtMs,
    maxAgeMs: observerPolicy.maxObservationAgeMs,
  });
  const nonzeroInventory = [
    "activeBrokerRefs", "activePipeRefs", "activeProcessRefs", "activeScenarioClaimRefs", "orphanProcessRefs",
    "rawDeviceIdentityFindings", "secretMaterialFindings",
  ].some((key) => !Array.isArray(inventory?.[key]) || inventory[key].length !== 0);
  if (!inventoryValidation.ok || nonzeroInventory) {
    fail("M64_EXECUTION_RECOVERY_EXTERNAL_RESOURCES_NOT_ZERO", "independent signed observer did not prove all external recovery resources zero", {
      errors: inventoryValidation.errors,
    });
  }
  const raw = {
    schemaId: M64_EXECUTION_RECOVERY_SCHEMA_ID,
    executionIntentHash: intentState.intentHash,
    executionIntentRawBase64: exactJsonBytes(intent).toString("base64"),
    effectBoundaryHash: effectBoundary.boundaryHash,
    independentOracleArtifactSha256: observerPolicy.artifactSha256,
    resourceObserverHash: observerPolicy.observerHash,
    purpose,
    gateRecovery,
    liveRecovery,
    gateStatus: freshGateStatus,
    closeReceiptHashes,
    resourceObservationRequest: publishedRequest.request,
    resourceObservationRequestHash: publishedRequest.requestHash,
    resourceObservationRequestSha256: publishedRequest.requestSha256,
    resourceObservationRequestRawBase64: publishedRequest.requestRawBase64,
    resourceObservationRequestLocator: publishedRequest.locator,
    resourceObservationRequestLocatorSha256: publishedRequest.locatorSha256,
    processInventory: Object.freeze(inventory),
    processInventorySha256: descriptor.sha256,
    processInventoryRawBase64: inventoryRecord.rawBase64,
    recoveredAt: new Date(observedAtMs).toISOString(),
    externalResourceState: "ZERO_ASSERTED_BY_SIGNED_OBSERVER",
    recoveryOnly: true,
    liveReplayPrevented: true,
    liveCompletionClaim: null,
    actionCount: null,
  };
  if ([gateToken, liveToken].some((token) => tokenPresent(raw, token))) {
    fail("M64_OPERATOR_SECRET_LEAK", "execution recovery artifact contains operator credential material");
  }
  const recoveryArtifact = persistM64ExecutionRecoveryArtifact(raw, {
    roots, intentState, effectBoundary, observerPolicy,
  });
  return executionRecoveryRequiredResult(intentState, recoveryArtifact);
}

function publicationArtifactDescriptor(id, value) {
  const bytes = exactJsonBytes(value);
  return Object.freeze({ id, sha256: rawSha(bytes), rawBase64: bytes.toString("base64") });
}

function buildM64PublicationBundle({ roots, result, resourceArtifact, executionIntentHash }) {
  const totalActionCount = deriveM64ResultTotalActionCount(result);
  if (resourceArtifact?.totalActionCount !== totalActionCount || !HASH.test(executionIntentHash || "")) {
    fail("M64_PUBLICATION_JOURNAL_INVALID", "publication action count is not bound to the exact resource closeout");
  }
  const raw = {
    schemaId: M64_PUBLICATION_JOURNAL_SCHEMA_ID,
    auditRoot: roots.auditRoot,
    repositoryRoot: roots.repositoryRoot,
    receiptHash: result.receipt.receiptHash,
    terminalStatus: result.receipt.terminalStatus,
    totalActionCount,
    executionIntentHash,
    resourceArtifactHash: resourceArtifact.artifactHash,
    artifacts: [
      publicationArtifactDescriptor("IMMUTABLE_AUDIT_COMPLETION", result.receipt),
      publicationArtifactDescriptor("AUDIT_RESOURCE_CLOSEOUT", resourceArtifact),
      publicationArtifactDescriptor("REPOSITORY_RESOURCE_CLOSEOUT", resourceArtifact),
      publicationArtifactDescriptor("REPOSITORY_COMPLETION", result.receipt),
      publicationArtifactDescriptor("AUDIT_COMPLETION_SENTINEL", result.receipt),
    ],
  };
  return Object.freeze({ ...raw, bundleHash: sha(M64_PUBLICATION_JOURNAL_SCHEMA_ID, raw) });
}

function decodeM64PublicationArtifact(artifact) {
  if (!exactObject(artifact, ["id", "rawBase64", "sha256"])
    || !M64_PUBLICATION_ARTIFACT_IDS.includes(artifact.id)
    || !HASH.test(artifact.sha256 || "") || typeof artifact.rawBase64 !== "string") {
    fail("M64_PUBLICATION_JOURNAL_INVALID", "publication journal artifact descriptor is invalid");
  }
  let bytes;
  let value;
  try {
    bytes = Buffer.from(artifact.rawBase64, "base64");
    if (bytes.length < 2 || bytes.toString("base64") !== artifact.rawBase64 || rawSha(bytes) !== artifact.sha256) {
      throw new Error("artifact byte/hash mismatch");
    }
    value = JSON.parse(bytes.toString("utf8"));
    if (!bytes.equals(exactJsonBytes(value))) throw new Error("artifact JSON encoding mismatch");
  } catch {
    fail("M64_PUBLICATION_JOURNAL_INVALID", "publication journal artifact bytes are malformed or rebound");
  }
  return Object.freeze({ bytes, value });
}

function validateM64PublicationBundle(bundle, roots, expectedFileHash = null) {
  const keys = [
    "artifacts", "auditRoot", "bundleHash", "executionIntentHash", "receiptHash", "repositoryRoot",
    "resourceArtifactHash", "schemaId", "terminalStatus", "totalActionCount",
  ];
  if (!exactObject(bundle, keys) || bundle.schemaId !== M64_PUBLICATION_JOURNAL_SCHEMA_ID
    || !HASH.test(bundle.bundleHash || "") || !HASH.test(bundle.receiptHash || "")
    || !HASH.test(bundle.resourceArtifactHash || "") || !HASH.test(bundle.executionIntentHash || "")
    || typeof bundle.terminalStatus !== "string"
    || !Number.isSafeInteger(bundle.totalActionCount) || bundle.totalActionCount < 0
    || typeof bundle.auditRoot !== "string" || !isAbsolute(bundle.auditRoot)
    || typeof bundle.repositoryRoot !== "string" || !isAbsolute(bundle.repositoryRoot)
    || normalizedFilesystemPath(bundle.auditRoot || "") !== normalizedFilesystemPath(roots.auditRoot)
    || normalizedFilesystemPath(bundle.repositoryRoot || "") !== normalizedFilesystemPath(roots.repositoryRoot)
    || (expectedFileHash && bundle.bundleHash !== expectedFileHash)) {
    fail("M64_PUBLICATION_JOURNAL_INVALID", "publication journal identity or root binding is invalid");
  }
  const { bundleHash, ...raw } = bundle;
  if (sha(M64_PUBLICATION_JOURNAL_SCHEMA_ID, raw) !== bundleHash
    || !Array.isArray(bundle.artifacts) || bundle.artifacts.length !== M64_PUBLICATION_ARTIFACT_IDS.length
    || canonical(bundle.artifacts.map((entry) => entry?.id)) !== canonical(M64_PUBLICATION_ARTIFACT_IDS)) {
    fail("M64_PUBLICATION_JOURNAL_INVALID", "publication journal content address or ordered artifact set is invalid");
  }
  const decoded = bundle.artifacts.map(decodeM64PublicationArtifact);
  const receipt = decoded[0].value;
  const resourceArtifact = decoded[1].value;
  if (!decoded[0].bytes.equals(decoded[3].bytes) || !decoded[0].bytes.equals(decoded[4].bytes)
    || !decoded[1].bytes.equals(decoded[2].bytes)
    || receipt?.receiptHash !== bundle.receiptHash
    || deriveM64ActionCanaryReceiptHash(receipt) !== receipt.receiptHash
    || receipt?.terminalStatus !== bundle.terminalStatus
    || resourceArtifact?.artifactHash !== bundle.resourceArtifactHash
    || resourceArtifact?.completionReceiptHash !== bundle.receiptHash
    || resourceArtifact?.totalActionCount !== bundle.totalActionCount) {
    fail("M64_PUBLICATION_JOURNAL_INVALID", "publication journal receipt/resource content is incomplete or rebound");
  }
  const { artifactHash, ...resourceRaw } = resourceArtifact;
  if (sha("xw.m6-4-live-resource-closeout-artifact.v1", resourceRaw) !== artifactHash) {
    fail("M64_PUBLICATION_JOURNAL_INVALID", "publication journal resource artifact hash is invalid");
  }
  return Object.freeze({ bundle: Object.freeze(bundle), decoded: Object.freeze(decoded) });
}

function publicationArtifactLocation(roots, bundle, artifactId) {
  switch (artifactId) {
    case "IMMUTABLE_AUDIT_COMPLETION":
      return Object.freeze({ root: resolve(roots.auditRoot, "m6-4-action-canary-completion"), fileName: `${bundle.receiptHash}.json` });
    case "AUDIT_RESOURCE_CLOSEOUT":
      return Object.freeze({ root: roots.auditRoot, fileName: "m6-4-live-resource-closeout.json" });
    case "REPOSITORY_RESOURCE_CLOSEOUT":
      return Object.freeze({ root: roots.artifactRoot, fileName: "m6-4-live-resource-closeout.json" });
    case "REPOSITORY_COMPLETION":
      return Object.freeze({ root: roots.artifactRoot, fileName: "m6-4-action-canary-completion.json" });
    case "AUDIT_COMPLETION_SENTINEL":
      return Object.freeze({ root: roots.auditRoot, fileName: "m6-4-action-canary-completion.json" });
    default:
      fail("M64_PUBLICATION_JOURNAL_INVALID", "publication journal contains an unknown artifact id");
  }
}

function stablePublicationArtifactBytes(root, fileName, code) {
  let rootStat;
  try { rootStat = lstatSync(root); } catch (error) {
    if (error?.code === "ENOENT") return null;
    fail(code, "publication artifact root is unavailable", { cause: error?.code ?? null });
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail(code, "publication artifact root is not a plain directory");
  const guard = openPlainAuditDirectoryTree(root, { create: false, code });
  try {
    return stableAuditFileBytes(childPath(guard.root, fileName, code), guard, { missingOk: true });
  } finally {
    closeAuditDirectoryGuard(guard);
  }
}

function inspectM64PublicationBundleState(validated, roots) {
  let presentCount = 0;
  let missingCount = 0;
  let completionPresent = false;
  for (let index = 0; index < validated.bundle.artifacts.length; index += 1) {
    const artifact = validated.bundle.artifacts[index];
    const location = publicationArtifactLocation(roots, validated.bundle, artifact.id);
    const existing = stablePublicationArtifactBytes(location.root, location.fileName,
      artifact.id.startsWith("REPOSITORY_") ? "M64_REPOSITORY_ROOT_INVALID" : "M64_AUDIT_ROOT_INVALID");
    if (existing === null) {
      missingCount += 1;
      continue;
    }
    presentCount += 1;
    if (!existing.equals(validated.decoded[index].bytes)) {
      fail("M64_AUDIT_HASH_COLLISION", `existing ${artifact.id} differs from its immutable publication journal`);
    }
    if (artifact.id === "AUDIT_COMPLETION_SENTINEL") completionPresent = true;
  }
  if (completionPresent && missingCount > 0) {
    fail("M64_PUBLICATION_SENTINEL_INCONSISTENT", "fixed audit completion exists while earlier publication artifacts are missing");
  }
  return Object.freeze({ complete: missingCount === 0, pending: missingCount > 0, presentCount, missingCount });
}

function publicationArtifactsResult(validated, roots) {
  const byId = new Map(validated.bundle.artifacts.map((artifact) => [artifact.id, artifact]));
  const resultFor = (id) => {
    const artifact = byId.get(id);
    const location = publicationArtifactLocation(roots, validated.bundle, id);
    return Object.freeze({ path: resolve(location.root, location.fileName), sha256: artifact.sha256 });
  };
  return Object.freeze({
    immutableAuditArtifact: resultFor("IMMUTABLE_AUDIT_COMPLETION"),
    auditCompletion: resultFor("AUDIT_COMPLETION_SENTINEL"),
    auditResourceCloseout: resultFor("AUDIT_RESOURCE_CLOSEOUT"),
    repositoryCompletion: resultFor("REPOSITORY_COMPLETION"),
    repositoryResourceCloseout: resultFor("REPOSITORY_RESOURCE_CLOSEOUT"),
    resourceArtifactHash: validated.bundle.resourceArtifactHash,
    publicationBundleHash: validated.bundle.bundleHash,
  });
}

function invokePublicationCutpoint(faultAfterPublicationStep, step) {
  if (faultAfterPublicationStep === null || faultAfterPublicationStep === undefined) return;
  if (typeof faultAfterPublicationStep !== "function") {
    fail("M64_PUBLICATION_FAULT_INJECTION_INVALID", "publication cutpoint hook must be a function");
  }
  faultAfterPublicationStep(step);
}

function invokeExecutionCutpoint(faultAfterExecutionStep, step) {
  if (faultAfterExecutionStep === null || faultAfterExecutionStep === undefined) return;
  if (typeof faultAfterExecutionStep !== "function") {
    fail("M64_EXECUTION_FAULT_INJECTION_INVALID", "execution cutpoint hook must be a function");
  }
  faultAfterExecutionStep(step);
}

function applyM64PublicationBundle(validated, roots, faultAfterPublicationStep = null) {
  for (let index = 0; index < validated.bundle.artifacts.length; index += 1) {
    const artifact = validated.bundle.artifacts[index];
    const value = validated.decoded[index].value;
    let written;
    if (artifact.id === "IMMUTABLE_AUDIT_COMPLETION") {
      written = atomicWriteCompletionReceipt(roots.auditRoot, value);
    } else {
      const location = publicationArtifactLocation(roots, validated.bundle, artifact.id);
      written = atomicWriteExactJsonArtifact(location.root, location.fileName, value, {
        code: artifact.id.startsWith("REPOSITORY_") ? "M64_REPOSITORY_ROOT_INVALID" : "M64_AUDIT_ROOT_INVALID",
      });
    }
    if (written.sha256 !== artifact.sha256) {
      fail("M64_AUDIT_READBACK_MISMATCH", `${artifact.id} did not match its immutable publication journal`);
    }
    invokePublicationCutpoint(faultAfterPublicationStep, artifact.id);
  }
  const state = inspectM64PublicationBundleState(validated, roots);
  if (!state.complete) fail("M64_PUBLICATION_RECOVERY_INCOMPLETE", "publication journal recovery did not reach its final sentinel");
  return publicationArtifactsResult(validated, roots);
}

function publicationJournalFiles(auditRoot) {
  const journalRoot = resolve(auditRoot, M64_PUBLICATION_JOURNAL_DIRECTORY);
  let stat;
  try { stat = lstatSync(journalRoot); } catch (error) {
    if (error?.code === "ENOENT") return Object.freeze({
      journalRoot,
      files: Object.freeze([]),
      interruptedTemporaryFiles: Object.freeze([]),
    });
    fail("M64_PUBLICATION_JOURNAL_INVALID", "publication journal directory is unavailable", { cause: error?.code ?? null });
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || normalizedFilesystemPath(realpathSync(journalRoot)) !== normalizedFilesystemPath(journalRoot)) {
    fail("M64_PUBLICATION_JOURNAL_INVALID", "publication journal root must be one plain directory");
  }
  const entries = readdirSync(journalRoot).sort();
  const journalPattern = /^[0-9a-f]{64}\.json$/u;
  const interruptedTemporaryPattern = /^\.[0-9a-f]{64}\.json\.[0-9a-f-]{36}\.tmp$/iu;
  if (entries.some((name) => !journalPattern.test(name) && !interruptedTemporaryPattern.test(name))) {
    fail("M64_PUBLICATION_JOURNAL_INVALID", "publication journal directory contains an unexpected entry");
  }
  const interruptedTemporaryFiles = entries.filter((name) => interruptedTemporaryPattern.test(name));
  for (const name of interruptedTemporaryFiles) {
    const temporary = lstatSync(childPath(journalRoot, name, "M64_PUBLICATION_JOURNAL_INVALID"), { bigint: true });
    if (!temporary.isFile() || temporary.isSymbolicLink() || temporary.nlink !== 1n) {
      fail("M64_PUBLICATION_JOURNAL_INVALID", "an interrupted publication temporary is not a plain single-link file");
    }
  }
  const files = entries.filter((name) => journalPattern.test(name));
  if (files.length > 1) {
    fail("M64_PUBLICATION_JOURNAL_AMBIGUOUS", "multiple publication journals cannot be reconciled safely");
  }
  // A process crash before the atomic rename may leave a private temporary.
  // It is not a durable journal and is deliberately ignored here; the earlier
  // durable execution intent remains authoritative and blocks live replay.
  return Object.freeze({
    journalRoot,
    files: Object.freeze(files),
    interruptedTemporaryFiles: Object.freeze(interruptedTemporaryFiles),
  });
}

function assertNoOrphanedM64PublicationArtifacts(roots) {
  const candidates = [
    [roots.auditRoot, "m6-4-live-resource-closeout.json", "M64_AUDIT_ROOT_INVALID"],
    [roots.auditRoot, "m6-4-action-canary-completion.json", "M64_AUDIT_ROOT_INVALID"],
    [roots.artifactRoot, "m6-4-live-resource-closeout.json", "M64_REPOSITORY_ROOT_INVALID"],
    [roots.artifactRoot, "m6-4-action-canary-completion.json", "M64_REPOSITORY_ROOT_INVALID"],
  ];
  if (candidates.some(([root, name, code]) => stablePublicationArtifactBytes(root, name, code) !== null)) {
    fail("M64_PUBLICATION_ORPHANED_ARTIFACT", "contract publication artifacts exist without their immutable journal");
  }
  const immutableRoot = resolve(roots.auditRoot, "m6-4-action-canary-completion");
  try {
    const stat = lstatSync(immutableRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || normalizedFilesystemPath(realpathSync(immutableRoot)) !== normalizedFilesystemPath(immutableRoot)
      || readdirSync(immutableRoot).length > 0) {
      fail("M64_PUBLICATION_ORPHANED_ARTIFACT", "immutable completion receipts exist without their publication journal");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function loadM64PublicationJournal(roots) {
  const journal = publicationJournalFiles(roots.auditRoot);
  if (journal.files.length === 0) {
    assertNoOrphanedM64PublicationArtifacts(roots);
    return null;
  }
  const fileName = journal.files[0];
  const bytes = stablePublicationArtifactBytes(journal.journalRoot, fileName, "M64_PUBLICATION_JOURNAL_INVALID");
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); } catch {
    fail("M64_PUBLICATION_JOURNAL_INVALID", "publication journal JSON is malformed");
  }
  if (!bytes.equals(exactJsonBytes(value))) fail("M64_PUBLICATION_JOURNAL_INVALID", "publication journal encoding is not exact");
  return validateM64PublicationBundle(value, roots, fileName.slice(0, -5));
}

export function recoverM64ContractPublication({
  auditRoot,
  repositoryRoot,
  releaseRoot = DEFAULT_RELEASE_ROOT,
  contractAuditRoot = M64_CONTRACT_AUDIT_ROOT,
  expectedExecutionIntentHash = null,
  faultAfterPublicationStep = null,
} = {}) {
  const roots = validateM64PublicationRoots({ auditRoot, repositoryRoot, releaseRoot, contractAuditRoot });
  const validated = loadM64PublicationJournal(roots);
  if (!validated) return null;
  if (!HASH.test(expectedExecutionIntentHash || "")
    || validated.bundle.executionIntentHash !== expectedExecutionIntentHash) {
    fail("M64_EXECUTION_INTENT_PUBLICATION_MISMATCH", "publication recovery requires the exact durable execution intent before applying any output");
  }
  const before = inspectM64PublicationBundleState(validated, roots);
  const publicationArtifacts = before.complete
    ? publicationArtifactsResult(validated, roots)
    : applyM64PublicationBundle(validated, roots, faultAfterPublicationStep);
  return Object.freeze({
    recovered: before.pending,
    bundleHash: validated.bundle.bundleHash,
    receiptHash: validated.bundle.receiptHash,
    terminalStatus: validated.bundle.terminalStatus,
    totalActionCount: validated.bundle.totalActionCount,
    executionIntentHash: validated.bundle.executionIntentHash,
    publicationArtifacts,
  });
}

export function publishM64ContractArtifacts({
  auditRoot,
  repositoryRoot,
  releaseRoot = DEFAULT_RELEASE_ROOT,
  contractAuditRoot = M64_CONTRACT_AUDIT_ROOT,
  result,
  acceptedResourceEvidence,
  acceptedCloseRequests,
  observerPolicy,
  executionIntentHash,
  faultAfterPublicationStep = null,
} = {}) {
  const roots = validateM64PublicationRoots({ auditRoot, repositoryRoot, releaseRoot, contractAuditRoot });
  const resourceArtifact = buildM64LiveResourceCloseoutArtifact({
    result, acceptedResourceEvidence, acceptedCloseRequests, observerPolicy,
  });
  const bundle = buildM64PublicationBundle({ roots, result, resourceArtifact, executionIntentHash });
  const prior = loadM64PublicationJournal(roots);
  if (prior) {
    if (prior.bundle.bundleHash !== bundle.bundleHash) {
      fail("M64_PUBLICATION_ALREADY_BOUND", "contract publication is already bound to a different immutable bundle");
    }
    const state = inspectM64PublicationBundleState(prior, roots);
    return state.complete
      ? publicationArtifactsResult(prior, roots)
      : applyM64PublicationBundle(prior, roots, faultAfterPublicationStep);
  }
  const journalRoot = resolve(roots.auditRoot, M64_PUBLICATION_JOURNAL_DIRECTORY);
  const journalArtifact = atomicWriteExactJsonArtifact(
    journalRoot,
    `${bundle.bundleHash}.json`,
    bundle,
    { createRoot: true, code: "M64_PUBLICATION_JOURNAL_INVALID" },
  );
  if (journalArtifact.sha256 !== rawSha(exactJsonBytes(bundle))) {
    fail("M64_PUBLICATION_JOURNAL_INVALID", "publication journal failed exact durable readback");
  }
  invokePublicationCutpoint(faultAfterPublicationStep, "JOURNAL_DURABLE");
  const validated = validateM64PublicationBundle(bundle, roots, bundle.bundleHash);
  return applyM64PublicationBundle(validated, roots, faultAfterPublicationStep);
}

export function publicM64OperatorFailure(error) {
  const code = typeof error?.code === "string" && /^[A-Z0-9_]{3,96}$/u.test(error.code)
    ? error.code : "M64_OPERATOR_FAILED_CLOSED";
  return Object.freeze({
    ok: false,
    terminalStatus: code === "M64_GATE_SAFETY_CLOSE_UNVERIFIED"
      ? "UNSAFE_GATE_ACTIVE_OR_UNKNOWN"
      : code === "WAIT_EXTERNAL_AUTHORITY" || code === "WAIT_EXTERNAL_RESOURCE_OBSERVER"
        ? code : "FAIL_CLOSED",
    code,
    actionCount: Number.isSafeInteger(error?.details?.actionCount) && error.details.actionCount >= 0
      ? error.details.actionCount : null,
    liveCompletionClaim: null,
  });
}

export async function runM64ProductionOperator({
  windowInventoryDescriptors = null,
  windowInventoryInboxRoot = null,
  effectBoundaryDescriptor,
  independentOraclePolicyDescriptor,
  releaseRoot = DEFAULT_RELEASE_ROOT,
  closeInboxRoot = null,
  processInventoryInboxRoot = null,
  auditRoot = null,
  repositoryRoot = null,
  contractAuditRoot = M64_CONTRACT_AUDIT_ROOT,
  controlPlaneUrl = DEFAULT_CONTROL_PLANE_URL,
  gateToken = null,
  liveToken = null,
  fetchImpl = globalThis.fetch,
  dryPreflight = true,
  now = Date.now,
  waitForPoll,
  waitMs = DEFAULT_WAIT_MS,
  pollMs = DEFAULT_POLL_MS,
  maxStatusPolls = 20,
  statusPollDelayMs = 250,
  faultAfterPublicationStep = null,
  faultAfterExecutionStep = null,
} = {}) {
  const hasFrozenFiveWindows = Array.isArray(windowInventoryDescriptors)
    && windowInventoryDescriptors.length === M64_STAGED_CANARY_ORDER.length;
  const productionRoots = validateM64ProductionPreMutation({
    windowInventoryInboxRoot,
    closeInboxRoot,
    processInventoryInboxRoot,
    auditRoot,
    repositoryRoot,
    releaseRoot,
    contractAuditRoot,
    controlPlaneUrl,
    gateToken,
    liveToken,
    requireWindowInbox: !hasFrozenFiveWindows,
  });
  if (!dryPreflight) {
    const intentState = loadM64ExecutionIntentState(productionRoots, controlPlaneUrl);
    // Startup must validate the immutable journal's intent binding before it
    // writes even one missing publication artifact.  Calling the general
    // recovery helper here would apply first and compare the intent later.
    const publicationJournal = loadM64PublicationJournal(productionRoots);
    if (publicationJournal) {
      if (intentState?.state !== "DURABLE"
        || intentState.intentHash !== publicationJournal.bundle.executionIntentHash) {
        fail("M64_EXECUTION_INTENT_PUBLICATION_MISMATCH", "publication recovery is not bound to the durable execution intent");
      }
      const before = inspectM64PublicationBundleState(publicationJournal, productionRoots);
      const publicationArtifacts = before.complete
        ? publicationArtifactsResult(publicationJournal, productionRoots)
        : applyM64PublicationBundle(publicationJournal, productionRoots, faultAfterPublicationStep);
      return Object.freeze({
        ok: true,
        mode: "PUBLICATION_RECOVERY",
        terminalStatus: "M6_4_PUBLICATION_RECOVERED_NO_LIVE_REPLAY",
        completedTerminalStatus: publicationJournal.bundle.terminalStatus,
        liveCompletionClaim: publicationJournal.bundle.receiptHash,
        completionReceiptHash: publicationJournal.bundle.receiptHash,
        actionCount: publicationJournal.bundle.totalActionCount,
        recoveredPublication: true,
        liveReplayPrevented: true,
        publicationArtifacts,
      });
    }
    const publicationState = publicationJournalFiles(productionRoots.auditRoot);
    if (!intentState && publicationState.interruptedTemporaryFiles.length > 0) {
      // A pre-rename journal temporary is proof that live work may have
      // completed even if a legacy/tampered execution intent is unavailable.
      return executionRecoveryRequiredResult(Object.freeze({
        state: "INTERRUPTED_PUBLICATION",
        intent: null,
        intentHash: null,
      }));
    }
    if (intentState?.state === "DURABLE") {
      const recoveryEffectBoundary = loadM64OperatorEffectBoundary(effectBoundaryDescriptor, releaseRoot);
      const recoveryObserverPolicy = loadM64ResourceObserverPolicy(independentOraclePolicyDescriptor, {
        effectBoundaryHash: recoveryEffectBoundary.boundaryHash,
        releaseRoot,
      });
      return recoverM64PendingExecutionIntent({
        intentState,
        roots: productionRoots,
        controlPlaneUrl,
        gateToken,
        liveToken,
        fetchImpl,
        effectBoundary: recoveryEffectBoundary,
        observerPolicy: recoveryObserverPolicy,
        now,
        waitForPoll,
        waitMs,
        pollMs,
      });
    }
    if (intentState) return executionRecoveryRequiredResult(intentState);
  }
  let windows = null;
  let firstWindow = null;
  let effectBoundary;
  let observerPolicy;
  if (Array.isArray(windowInventoryDescriptors)) {
    if (windowInventoryDescriptors.length === M64_STAGED_CANARY_ORDER.length) {
      ({ windows, effectBoundary, observerPolicy } = loadM64ProductionOperatorInputs({
        windowInventoryDescriptors,
        effectBoundaryDescriptor,
        independentOraclePolicyDescriptor,
        releaseRoot,
        nowMs: now(),
      }));
    } else if (dryPreflight && windowInventoryDescriptors.length === 1) {
      effectBoundary = loadM64OperatorEffectBoundary(effectBoundaryDescriptor, releaseRoot);
      observerPolicy = loadM64ResourceObserverPolicy(independentOraclePolicyDescriptor, {
        effectBoundaryHash: effectBoundary.boundaryHash,
        releaseRoot,
      });
      firstWindow = loadM64CanaryWindowInventory(windowInventoryDescriptors[0]);
    } else {
      fail("M64_OPERATOR_WINDOW_DESCRIPTORS_INVALID", "operator requires either the first SHADOW descriptor for lazy dry preflight or all five frozen descriptors");
    }
  } else {
    effectBoundary = loadM64OperatorEffectBoundary(effectBoundaryDescriptor, releaseRoot);
    observerPolicy = loadM64ResourceObserverPolicy(independentOraclePolicyDescriptor, {
      effectBoundaryHash: effectBoundary.boundaryHash,
      releaseRoot,
    });
  }
  if (dryPreflight) {
    if (windows) {
      return Object.freeze({
        ok: true,
        mode: "PREFLIGHT_ONLY",
        terminalStatus: "PREFLIGHT_READY_WAIT_EXTERNAL_AUTHORITY",
        readinessScope: "FROZEN_FIVE_WINDOWS",
        fullFiveWindowReady: true,
        liveCompletionClaim: null,
        actionCount: 0,
        transportCount: 0,
        cohortOrder: Object.freeze([...M64_STAGED_CANARY_ORDER]),
        validatedWindowCount: M64_STAGED_CANARY_ORDER.length,
        pendingWindowCount: 0,
        windowInventoryHashes: Object.freeze(windows.map((window) => window.inventoryHash)),
        effectBoundaryHash: effectBoundary.boundaryHash,
        independentOracleArtifactSha256: observerPolicy.artifactSha256,
        resourceObserverHash: observerPolicy.observerHash,
        note: "Normal-close packages are accepted only after the observed aggregate exists; this preflight is not live completion.",
      });
    }
    if (!firstWindow) firstWindow = loadM64DryFirstWindowFromInbox(productionRoots.windowInventoryInboxRoot);
    if (firstWindow) firstWindow = validateM64ProductionFirstWindow(firstWindow, effectBoundary, observerPolicy, now());
    return buildM64LazyDryPreflightResult({ firstWindow, effectBoundary, observerPolicy });
  }
  const executionIntent = createM64ExecutionIntent({
    roots: productionRoots,
    controlPlaneUrl,
    windows,
    effectBoundary,
    observerPolicy,
    now,
  });
  invokeExecutionCutpoint(faultAfterExecutionStep, "EXECUTION_INTENT_DURABLE");
  const audited = createM64AuditedLoopbackCanaryClient({ controlPlaneUrl, gateToken, liveToken, fetchImpl, now });
  const inboxWindowLoader = windows ? null : createM64WindowInventoryInboxLoader({
    inboxRoot: productionRoots.windowInventoryInboxRoot,
    now,
    waitForPoll,
    waitMs,
    pollMs,
  });
  const loadWindow = inboxWindowLoader ? async (input) => {
    const window = await inboxWindowLoader(input);
    if (window.authorization?.independentOracleHash !== observerPolicy.artifactSha256) {
      fail("M64_RESOURCE_OBSERVER_POLICY_REBOUND", "window authorization does not bind the configured independent observer policy");
    }
    return window;
  } : null;
  const acceptedCloseRequests = [];
  const resolveCloseBundle = createM64NormalCloseInboxResolver({
    inboxRoot: productionRoots.closeInboxRoot,
    now,
    waitForPoll,
    waitMs,
    pollMs,
    recordAcceptedRequest: (entry) => acceptedCloseRequests.push(entry),
    forbiddenTokens: [gateToken, liveToken],
  });
  const processLoader = createM64ProcessInventoryInboxLoader({ inboxRoot: productionRoots.processInventoryInboxRoot, now, waitForPoll, waitMs, pollMs });
  const acceptedResourceEvidence = [];
  const loadProbe = createM64ProductionResourceProbeProvider({
    audit: audited.audit,
    loadProcessInventoryDescriptor: processLoader,
    observerPolicy,
    recordAcceptedEvidence: (entry) => acceptedResourceEvidence.push(entry),
    tokens: [gateToken, liveToken],
    now,
  });
  const result = await runM64StagedCanary({
    windows,
    loadWindow,
    effectBoundary,
    client: audited.client,
    resolveCloseBundle,
    loadResourceProbe: ({ window, gateClosedStatus }) => loadProbe({ purpose: window.manifest.purpose, gateClosedStatus }),
    loadFinalResourceProbe: ({ finalGateStatus }) => loadProbe({ purpose: "M6_4_FINAL", gateClosedStatus: finalGateStatus }),
    now,
    maxStatusPolls,
    waitForPoll,
    statusPollDelayMs,
  });
  const totalActionCount = deriveM64ResultTotalActionCount(result);
  const auditedActionCount = audited.audit.actionCount();
  if (auditedActionCount !== totalActionCount) {
    fail("M64_TOTAL_ACTION_COUNT_INVALID", "audited close receipts disagree with the completed five-window aggregate", {
      actionCount: auditedActionCount,
      aggregateActionCount: totalActionCount,
    });
  }
  invokeExecutionCutpoint(faultAfterExecutionStep, "STAGED_RESULT_READY");
  const publicationArtifacts = publishM64ContractArtifacts({
    auditRoot: productionRoots.auditRoot,
    repositoryRoot: productionRoots.repositoryRoot,
    releaseRoot: productionRoots.releaseRoot,
    contractAuditRoot,
    result,
    acceptedResourceEvidence,
    acceptedCloseRequests,
    observerPolicy,
    executionIntentHash: executionIntent.intentHash,
    faultAfterPublicationStep,
  });
  return Object.freeze({
    ok: true,
    mode: "LIVE",
    terminalStatus: result.terminalStatus,
    liveCompletionClaim: result.receipt.receiptHash,
    actionCount: totalActionCount,
    completionReceiptHash: result.receipt.receiptHash,
    publicationArtifacts,
  });
}

function values(argv, name) {
  const result = [];
  for (let index = 0; index < argv.length; index += 1) if (argv[index] === name) result.push(argv[index + 1]);
  return result;
}

function option(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
}

export async function runM64ProductionOperatorCli(argv = process.argv.slice(2), {
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) {
  const execute = argv.includes("--execute");
  if (argv.includes("--control-token-env")) {
    fail("M64_OPERATOR_TOKEN_ENV_INVALID", "one shared control token is forbidden; select separate Gate and live token variables");
  }
  if (argv.includes("--audit-root")) {
    fail("M64_OPERATOR_AUDIT_ROOT_MISMATCH", "the production CLI audit root is fixed and cannot be overridden");
  }
  const gateTokenEnv = option(argv, "--gate-token-env", DEFAULT_GATE_TOKEN_ENV);
  const liveTokenEnv = option(argv, "--live-token-env", DEFAULT_LIVE_TOKEN_ENV);
  if (!ENV_NAME.test(gateTokenEnv || "") || !ENV_NAME.test(liveTokenEnv || "") || gateTokenEnv === liveTokenEnv) {
    fail("M64_OPERATOR_TOKEN_ENV_INVALID", "Gate and live token selectors must name two distinct environment variables");
  }
  const windowInventoryDescriptors = values(argv, "--window-descriptor")
    .map((value, index) => parseM64SealedDescriptorSpec(value, `window descriptor ${index + 1}`));
  const effectBoundaryDescriptor = parseM64SealedDescriptorSpec(
    option(argv, "--effect-boundary-descriptor"),
    "effect boundary descriptor",
  );
  const independentOraclePolicyDescriptor = parseM64SealedDescriptorSpec(
    option(argv, "--independent-oracle-policy-descriptor"),
    "independent oracle/resource-observer policy descriptor",
  );
  const waitMs = Number(option(argv, "--wait-ms", DEFAULT_WAIT_MS));
  const pollMs = Number(option(argv, "--poll-ms", DEFAULT_POLL_MS));
  return runM64ProductionOperator({
    windowInventoryDescriptors: windowInventoryDescriptors.length > 0 ? windowInventoryDescriptors : null,
    windowInventoryInboxRoot: option(argv, "--window-inventory-inbox"),
    effectBoundaryDescriptor,
    independentOraclePolicyDescriptor,
    closeInboxRoot: option(argv, "--normal-close-inbox"),
    processInventoryInboxRoot: option(argv, "--process-inventory-inbox"),
    auditRoot: M64_CONTRACT_AUDIT_ROOT,
    repositoryRoot: option(argv, "--repository-root"),
    controlPlaneUrl: option(argv, "--control-plane-url", env.CONTROL_PLANE_URL || DEFAULT_CONTROL_PLANE_URL),
    gateToken: env[gateTokenEnv],
    liveToken: env[liveTokenEnv],
    fetchImpl,
    dryPreflight: !execute,
    now,
    waitMs,
    pollMs,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  runM64ProductionOperatorCli().then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    // Never print server messages/details here: they are outside the bridge's
    // public schema and could contain secret-bearing provider diagnostics.
    process.stderr.write(`${JSON.stringify(publicM64OperatorFailure(error), null, 2)}\n`);
    process.exitCode = 1;
  });
}
