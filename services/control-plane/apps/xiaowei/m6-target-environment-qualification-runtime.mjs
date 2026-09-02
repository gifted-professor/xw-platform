import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import {
  isAbsolute,
  join,
  parse as parsePath,
  relative,
  resolve,
  sep,
} from "node:path";

import { deriveTargetEnvironmentAttestation } from "../../../../packages/kernel/lib/m6-live-grounding.mjs";
import { canonicalJson, sha256 } from "../../control-plane/lib/canonical.mjs";
import { ControlPlaneError } from "../../control-plane/lib/errors.mjs";
import {
  deriveM64TargetEnvironmentCommandRegistryHash,
  M6_TARGET_ENVIRONMENT_QUALIFICATION_TTL_MS,
} from "./m6-target-environment-qualification.mjs";

const HASH = /^[0-9a-f]{64}$/u;
const GATE_STATUS_PATH = "/control/v1/internal/m6/gate-f/status";
const DEVICES_PATH = "/control/v1/devices";
const JOBS_PATH = "/control/v1/jobs";
const QUALIFICATION_CAPABILITY_ID = "xiaowei.m6.qualify_environment";
const DEFAULT_CONTROL_PLANE_URL = "http://127.0.0.1:17920/";
const TERMINAL_JOB_STATES = new Set(["succeeded", "failed", "ambiguous", "recovery_required", "cancelled"]);

const ATTESTATION_KEYS = Object.freeze([
  "accessibilityHash", "accountBindingHash", "accountIsolationHash", "appBuildHash", "appPackageHash",
  "attestationHash", "capturedAt", "displayHash", "expiresAt", "imeHash",
  "localeThemeHash", "osBuildHash", "schemaId", "signingHash",
]);
const QUALIFICATION_KEYS = Object.freeze([
  "actionCount", "alias", "capturedAt", "commandRegistryHash", "effectBoundary",
  "expiresAt", "gateFEligible", "qualifiedAttestationHashes", "rawDeviceIdentityPresent",
  "sampleCount", "schemaId", "secretMaterialPresent", "status",
]);
const SECRET_SHAPED_VALUE = /(?:\bBearer\s+|\bsk-[A-Za-z0-9_-]{6,}|api[_-]?key|credential|password|private-runtime|runtimeId|deviceSerial|authorizationToken)/iu;

function fail(code, message, { status = 503, cause } = {}) {
  throw new ControlPlaneError(code, message, { status, cause });
}

function exactKeys(value, keys, code, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || canonicalJson(Object.keys(value).sort()) !== canonicalJson([...keys].sort())) {
    fail(code, `${label} is not the exact sealed record`);
  }
  return value;
}

function pathKey(path) {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function pathInside(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function assertNotLink(path, stat, label) {
  if (stat.isSymbolicLink()) {
    fail("M6_ENV_ARTIFACT_PATH_UNSAFE", `${label} contains a symbolic link or junction`);
  }
}

function pathComponents(absolute) {
  const root = parsePath(absolute).root;
  const tail = relative(root, absolute);
  return {
    root,
    parts: tail === "" ? [] : tail.split(sep).filter(Boolean),
  };
}

function assertPlainExistingPath(path, { leaf = "file", label = "path" } = {}) {
  if (typeof path !== "string" || !isAbsolute(path)) {
    fail("M6_ENV_INPUT_PATH_INVALID", `${label} must be an absolute path`);
  }
  const absolute = resolve(path);
  const { root, parts } = pathComponents(absolute);
  let cursor = root;
  for (let index = 0; index < parts.length; index += 1) {
    cursor = join(cursor, parts[index]);
    let stat;
    try { stat = lstatSync(cursor); } catch (cause) {
      fail("M6_ENV_INPUT_UNAVAILABLE", `${label} is unavailable`, { cause });
    }
    assertNotLink(cursor, stat, label);
    const isLeaf = index === parts.length - 1;
    if ((!isLeaf || leaf === "directory") && !stat.isDirectory()) {
      fail("M6_ENV_INPUT_PATH_INVALID", `${label} has a non-directory path component`);
    }
    if (isLeaf && leaf === "file" && !stat.isFile()) {
      fail("M6_ENV_INPUT_PATH_INVALID", `${label} must be a regular file`);
    }
    let real;
    try { real = realpathSync(cursor); } catch (cause) {
      fail("M6_ENV_INPUT_UNAVAILABLE", `${label} cannot be resolved`, { cause });
    }
    if (pathKey(real) !== pathKey(cursor)) {
      fail("M6_ENV_ARTIFACT_PATH_UNSAFE", `${label} resolves through a symbolic link, junction, or path alias`);
    }
  }
  return absolute;
}

function ensurePlainDirectory(path, label) {
  if (typeof path !== "string" || !isAbsolute(path)) {
    fail("M6_ENV_ARTIFACT_ROOT_INVALID", `${label} must be an absolute path`);
  }
  const absolute = resolve(path);
  const { root, parts } = pathComponents(absolute);
  let cursor = root;
  for (const part of parts) {
    cursor = join(cursor, part);
    if (!existsSync(cursor)) {
      try { mkdirSync(cursor, { mode: 0o700 }); } catch (cause) {
        if (!existsSync(cursor)) fail("M6_ENV_ARTIFACT_WRITE_FAILED", `${label} could not be created`, { cause });
      }
    }
    let stat;
    try { stat = lstatSync(cursor); } catch (cause) {
      fail("M6_ENV_ARTIFACT_WRITE_FAILED", `${label} is unavailable`, { cause });
    }
    assertNotLink(cursor, stat, label);
    if (!stat.isDirectory()) fail("M6_ENV_ARTIFACT_ROOT_INVALID", `${label} contains a non-directory component`);
    let real;
    try { real = realpathSync(cursor); } catch (cause) {
      fail("M6_ENV_ARTIFACT_WRITE_FAILED", `${label} cannot be resolved`, { cause });
    }
    if (pathKey(real) !== pathKey(cursor)) {
      fail("M6_ENV_ARTIFACT_PATH_UNSAFE", `${label} resolves through a symbolic link, junction, or path alias`);
    }
  }
  return absolute;
}

export function validateM64GateFLoopbackUrl(value = DEFAULT_CONTROL_PLANE_URL) {
  let url;
  try { url = new URL(value); } catch {
    fail("M6_ENV_CONTROL_PLANE_URL_INVALID", "Control Plane URL is invalid");
  }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password
    || url.search || url.hash || !["", "/"].includes(url.pathname)) {
    fail("M6_ENV_CONTROL_PLANE_NOT_LOOPBACK", "environment qualification requires an exact credential-free loopback Control Plane origin");
  }
  return url;
}

function containsValue(value, expected) {
  if (typeof value === "string") return value.includes(expected);
  if (Array.isArray(value)) return value.some((item) => containsValue(item, expected));
  return value && typeof value === "object"
    ? Object.entries(value).some(([key, item]) => key.includes(expected) || containsValue(item, expected))
    : false;
}

function validateClosedGateStatus(payload) {
  const gate = payload?.gate;
  const zeroResources = { jobs: 0, leases: 0, runs: 0, sessions: 0 };
  if (gate?.schemaId !== "xw.m6-gate-f-operations-status.v1"
    || gate.mode !== "CLOSED" || gate.phase !== "CLOSED" || gate.purpose !== null
    || gate.tripleConsistent !== true || !Array.isArray(gate.errors) || gate.errors.length !== 0
    || gate.activeAuthorizationCount !== 0 || gate.actionCount !== 0
    || canonicalJson(gate.resourceCounts) !== canonicalJson(zeroResources)
    || !HASH.test(gate.epochHash ?? "") || !HASH.test(gate.locksHash ?? "")
    || !Number.isInteger(gate.generation) || gate.generation < 0) {
    fail("M6_ENV_QUALIFICATION_GATE_NOT_CLOSED", "Gate F did not prove one triple-consistent CLOSED generation with zero active resources", { status: 409 });
  }
  return Object.freeze({
    mode: "CLOSED",
    epochHash: gate.epochHash,
    generation: gate.generation,
    locksHash: gate.locksHash,
  });
}

export async function requestClosedM64GateFStatus({
  fetchImpl = globalThis.fetch,
  controlPlaneUrl = DEFAULT_CONTROL_PLANE_URL,
  token,
  timeoutMs = 5_000,
} = {}) {
  if (typeof fetchImpl !== "function") fail("M6_ENV_CONTROL_PLANE_CLIENT_UNAVAILABLE", "Control Plane HTTP client is unavailable");
  if (typeof token !== "string" || token.length < 32 || /[\0\r\n]/u.test(token)) {
    fail("M6_ENV_CONTROL_TOKEN_REQUIRED", "Gate-F operations token must be injected through the environment", { status: 403 });
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 15_000) {
    fail("M6_ENV_CONTROL_PLANE_TIMEOUT_INVALID", "Control Plane timeout is outside the fixed safety envelope");
  }
  const origin = validateM64GateFLoopbackUrl(controlPlaneUrl);
  const endpoint = new URL(GATE_STATUS_PATH, origin);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: "GET",
      redirect: "error",
      headers: { accept: "application/json", "x-control-token": token },
      signal: controller.signal,
    });
  } catch {
    fail("M6_ENV_CONTROL_PLANE_UNAVAILABLE", "Gate-F status could not be obtained from the loopback Control Plane");
  } finally {
    clearTimeout(timer);
  }
  if (response?.url && response.url !== endpoint.href) {
    fail("M6_ENV_CONTROL_PLANE_RESPONSE_INVALID", "Gate-F status response was not bound to the exact loopback endpoint");
  }
  let payload;
  try { payload = await response.json(); } catch {
    fail("M6_ENV_CONTROL_PLANE_RESPONSE_INVALID", "Gate-F status response was not valid JSON");
  }
  if (containsValue(payload, token)) fail("M6_ENV_CONTROL_TOKEN_ECHO", "Control Plane echoed the internal token");
  if (!response?.ok || response.status !== 200) {
    fail("M6_ENV_CONTROL_PLANE_REJECTED", "Gate-F status request was rejected by the loopback Control Plane");
  }
  return validateClosedGateStatus(payload);
}

async function requestLoopbackJson({ fetchImpl, controlPlaneUrl, token, method, path, body = null, timeoutMs = 15_000 }) {
  if (typeof fetchImpl !== "function") fail("M6_ENV_CONTROL_PLANE_CLIENT_UNAVAILABLE", "Control Plane HTTP client is unavailable");
  if (typeof token !== "string" || token.length < 32 || /[\0\r\n]/u.test(token)) {
    fail("M6_ENV_CONTROL_TOKEN_REQUIRED", "qualification-only requests require the inherited Gate-F control token", { status: 403 });
  }
  const origin = validateM64GateFLoopbackUrl(controlPlaneUrl);
  const endpoint = new URL(path, origin);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method,
      redirect: "error",
      headers: {
        accept: "application/json",
        "x-control-token": token,
        ...(body === null ? {} : { "content-type": "application/json" }),
      },
      ...(body === null ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
  } catch {
    fail("M6_ENV_CONTROL_PLANE_UNAVAILABLE", "qualification job Control Plane request failed");
  } finally {
    clearTimeout(timer);
  }
  if (response?.url && response.url !== endpoint.href) {
    fail("M6_ENV_CONTROL_PLANE_RESPONSE_INVALID", "qualification job response was not bound to the exact loopback endpoint");
  }
  let payload;
  try { payload = await response.json(); } catch {
    fail("M6_ENV_CONTROL_PLANE_RESPONSE_INVALID", "qualification job response was not valid JSON");
  }
  if (!response?.ok) {
    fail(payload?.error?.code || "M6_ENV_CONTROL_PLANE_REJECTED", "qualification job request was rejected", { status: response?.status || 503 });
  }
  return payload;
}

export async function requestM64TargetEnvironmentQualificationJob({
  fetchImpl = globalThis.fetch,
  controlPlaneUrl = DEFAULT_CONTROL_PLANE_URL,
  accountIsolationBindingHash,
  gateSnapshot,
  token,
  now = Date.now,
  maxStatusPolls = 360,
  waitForPoll = (delayMs) => new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs)),
  statusPollDelayMs = 1_000,
} = {}) {
  if (!HASH.test(accountIsolationBindingHash ?? "")
    || gateSnapshot?.mode !== "CLOSED" || !HASH.test(gateSnapshot?.epochHash || "")
    || !HASH.test(gateSnapshot?.locksHash || "")
    || !Number.isInteger(gateSnapshot?.generation) || gateSnapshot.generation < 0
    || !Number.isInteger(maxStatusPolls) || maxStatusPolls < 1 || maxStatusPolls > 600
    || !Number.isInteger(statusPollDelayMs) || statusPollDelayMs < 0 || statusPollDelayMs > 5_000
    || typeof waitForPoll !== "function") {
    fail("M6_ENV_QUALIFICATION_JOB_INPUT_INVALID", "qualification job requires one exact CLOSED snapshot and bounded poll policy");
  }
  const devicesPayload = await requestLoopbackJson({
    fetchImpl, controlPlaneUrl, token, method: "GET", path: DEVICES_PATH,
  });
  const matches = (Array.isArray(devicesPayload?.devices) ? devicesPayload.devices : [])
    .filter((device) => device?.alias === "01" && device.online === true && device.quarantined !== true);
  if (matches.length !== 1 || typeof matches[0].deviceId !== "string" || matches[0].deviceId === "") {
    fail("M6_ENV_ALIAS01_BINDING_INVALID", "Control Plane has no unique online public alias-01 binding");
  }
  const deviceId = matches[0].deviceId;
  const requestHash = sha256(`xw.m6-target-environment-job.v1:${canonicalJson({
    accountIsolationBindingHash,
    deviceId,
    gateEpochHash: gateSnapshot.epochHash,
    gateGeneration: gateSnapshot.generation,
    gateLocksHash: gateSnapshot.locksHash,
  })}`);
  const submitted = await requestLoopbackJson({
    fetchImpl,
    controlPlaneUrl,
    token,
    method: "POST",
    path: JOBS_PATH,
    body: {
      actorId: "operator:m6-target-environment-qualification",
      capabilityId: QUALIFICATION_CAPABILITY_ID,
      idempotencyKey: `m6-env-${requestHash}`,
      params: {
        accountIsolationBindingHash,
        gateEpochHash: gateSnapshot.epochHash,
        gateGeneration: gateSnapshot.generation,
        gateLocksHash: gateSnapshot.locksHash,
      },
      canary: true,
      deviceId,
      expectedGateEpochHash: gateSnapshot.epochHash,
      expectedGateGeneration: gateSnapshot.generation,
      expectedGateLocksHash: gateSnapshot.locksHash,
    },
  });
  const jobId = submitted?.job?.jobId;
  if (typeof jobId !== "string" || jobId === "") {
    fail("M6_ENV_QUALIFICATION_JOB_INVALID", "Control Plane did not return one durable qualification job");
  }
  let job = submitted.job;
  for (let poll = 0; poll < maxStatusPolls && !TERMINAL_JOB_STATES.has(job?.status); poll += 1) {
    if (poll > 0 || job?.status !== "succeeded") await waitForPoll(statusPollDelayMs);
    const status = await requestLoopbackJson({
      fetchImpl,
      controlPlaneUrl,
      token,
      method: "GET",
      path: `${JOBS_PATH}/${encodeURIComponent(jobId)}`,
    });
    job = status?.job;
  }
  if (job?.status !== "succeeded" || job.capabilityId !== QUALIFICATION_CAPABILITY_ID
    || job.deviceId !== deviceId || job.canary !== true) {
    fail("M6_ENV_QUALIFICATION_JOB_FAILED", "formal alias-01 qualification job did not succeed", { status: 409 });
  }
  const result = job.result?.output?.m6EnvironmentQualification;
  validateArtifactRecords(result?.attestation, result?.qualification);
  const nowMs = Number(now());
  if (!Number.isFinite(nowMs) || Date.parse(result.attestation.capturedAt) > nowMs + 5_000
    || Date.parse(result.attestation.expiresAt) <= nowMs) {
    fail("M6_ENV_QUALIFICATION_JOB_STALE", "formal qualification job returned stale or future evidence");
  }
  return Object.freeze({
    jobId,
    runId: job.runId,
    attestation: result.attestation,
    qualification: result.qualification,
  });
}

function assertNoSecretShapedValues(value) {
  const visit = (item) => {
    if (typeof item === "string" && SECRET_SHAPED_VALUE.test(item)) {
      fail("M6_ENV_ARTIFACT_SECRET_MATERIAL", "environment qualification artifact contains secret-shaped material");
    }
    if (Array.isArray(item)) item.forEach(visit);
    else if (item && typeof item === "object") Object.values(item).forEach(visit);
  };
  visit(value);
}

function validateArtifactRecords(attestation, qualification) {
  exactKeys(attestation, ATTESTATION_KEYS, "M6_ENV_ATTESTATION_INVALID", "target environment attestation");
  exactKeys(qualification, QUALIFICATION_KEYS, "M6_ENV_QUALIFICATION_INVALID", "environment qualification");
  let derived;
  try {
    const { attestationHash: _ignored, ...body } = attestation;
    derived = deriveTargetEnvironmentAttestation(body);
  } catch {
    fail("M6_ENV_ATTESTATION_INVALID", "target environment attestation cannot be re-derived");
  }
  if (derived.attestationHash !== attestation.attestationHash
    || qualification.schemaId !== "xw.m6-environment-qualification.v1"
    || qualification.status !== "QUALIFIED" || qualification.gateFEligible !== true
    || qualification.alias !== "01" || qualification.effectBoundary !== "READ_ONLY"
    || qualification.commandRegistryHash !== deriveM64TargetEnvironmentCommandRegistryHash()
    || canonicalJson(qualification.qualifiedAttestationHashes) !== canonicalJson([attestation.attestationHash])
    || qualification.sampleCount !== 2 || qualification.secretMaterialPresent !== false
    || qualification.rawDeviceIdentityPresent !== false || qualification.actionCount !== 0
    || qualification.capturedAt !== attestation.capturedAt || qualification.expiresAt !== attestation.expiresAt
    || Date.parse(attestation.expiresAt) - Date.parse(attestation.capturedAt) !== M6_TARGET_ENVIRONMENT_QUALIFICATION_TTL_MS) {
    fail("M6_ENV_QUALIFICATION_INVALID", "environment qualification is not bound to the exact target attestation");
  }
  assertNoSecretShapedValues(attestation);
  assertNoSecretShapedValues(qualification);
}

function syncDirectory(path) {
  let fd;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } catch (cause) {
    // Windows may reject fsync on directory handles even after both files have
    // been individually fsynced and read back. Do not weaken any other error.
    if (process.platform !== "win32" || !["EINVAL", "EPERM", "EISDIR"].includes(cause?.code)) {
      fail("M6_ENV_ARTIFACT_FSYNC_FAILED", "environment artifact directory fsync failed", { cause });
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function writeContentAddressedFile({ root, directory, address, bytes }) {
  if (!HASH.test(address ?? "")) fail("M6_ENV_ARTIFACT_ADDRESS_INVALID", "environment artifact address is invalid");
  const artifactDirectory = ensurePlainDirectory(join(root, directory), `${directory} artifact directory`);
  const target = join(artifactDirectory, `${address}.json`);
  if (!pathInside(root, target)) fail("M6_ENV_ARTIFACT_PATH_ESCAPE", "environment artifact path escaped its explicit root");
  if (existsSync(target)) {
    const existingPath = assertPlainExistingPath(target, { leaf: "file", label: "content-addressed artifact" });
    const existing = readFileSync(existingPath);
    if (!existing.equals(bytes)) fail("M6_ENV_ARTIFACT_COLLISION", "content-addressed artifact already exists with different bytes");
    if (sha256(existing) !== sha256(bytes)) fail("M6_ENV_ARTIFACT_READBACK_FAILED", "content-addressed artifact hash changed during readback");
    return target;
  }

  const temporary = join(artifactDirectory, `.tmp-${process.pid}-${randomUUID()}`);
  let fd;
  try {
    fd = openSync(temporary, "wx", 0o600);
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, target);
    syncDirectory(artifactDirectory);
  } catch (cause) {
    if (cause instanceof ControlPlaneError) throw cause;
    fail("M6_ENV_ARTIFACT_WRITE_FAILED", "environment artifact atomic commit failed", { cause });
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* the original failure remains authoritative */ }
    }
    try { if (existsSync(temporary)) unlinkSync(temporary); } catch { /* an uncommitted temp never becomes an artifact */ }
  }

  const committedPath = assertPlainExistingPath(target, { leaf: "file", label: "committed environment artifact" });
  const readback = readFileSync(committedPath);
  if (!readback.equals(bytes)) fail("M6_ENV_ARTIFACT_READBACK_FAILED", "environment artifact readback did not match committed bytes");
  return target;
}

export function writeM64TargetEnvironmentQualificationArtifacts({
  artifactRoot,
  attestation,
  qualification,
} = {}) {
  if (typeof artifactRoot !== "string" || !isAbsolute(artifactRoot)) {
    fail("M6_ENV_ARTIFACT_ROOT_INVALID", "execute requires an explicit absolute runtime artifact root");
  }
  validateArtifactRecords(attestation, qualification);
  const root = ensurePlainDirectory(artifactRoot, "environment artifact root");
  const attestationBytes = Buffer.from(`${canonicalJson(attestation)}\n`, "utf8");
  const qualificationBytes = Buffer.from(`${canonicalJson(qualification)}\n`, "utf8");
  const qualificationHash = sha256(qualificationBytes);
  const attestationPath = writeContentAddressedFile({
    root, directory: "attestations", address: attestation.attestationHash, bytes: attestationBytes,
  });
  const qualificationPath = writeContentAddressedFile({
    root, directory: "qualifications", address: qualificationHash, bytes: qualificationBytes,
  });
  return Object.freeze({
    root,
    attestationHash: attestation.attestationHash,
    qualificationHash,
    attestationPath,
    qualificationPath,
  });
}

function sameGateGeneration(left, right) {
  return left.epochHash === right.epochHash
    && left.generation === right.generation
    && left.locksHash === right.locksHash;
}

export async function runM64TargetEnvironmentQualification({
  execute = false,
  artifactRoot = null,
  accountIsolationBindingHash,
  controlPlaneUrl = DEFAULT_CONTROL_PLANE_URL,
  controlToken,
  fetchImpl = globalThis.fetch,
  jobClient = requestM64TargetEnvironmentQualificationJob,
  artifactWriter = writeM64TargetEnvironmentQualificationArtifacts,
  now = Date.now,
} = {}) {
  if (execute !== true && execute !== false) fail("M6_ENV_EXECUTION_MODE_INVALID", "environment qualification execute mode must be boolean");
  if (!HASH.test(accountIsolationBindingHash ?? "")) {
    fail("M6_ENV_ACCOUNT_ISOLATION_BINDING_REQUIRED", "an opaque account-isolation binding hash is required");
  }
  if (artifactRoot !== null && (typeof artifactRoot !== "string" || !isAbsolute(artifactRoot))) {
    fail("M6_ENV_ARTIFACT_ROOT_INVALID", "runtime artifact root must be absolute");
  }
  validateM64GateFLoopbackUrl(controlPlaneUrl);
  const commandRegistryHash = deriveM64TargetEnvironmentCommandRegistryHash();
  if (!execute) return Object.freeze({ commandRegistryHash, actionCount: 0 });
  if (!artifactRoot) fail("M6_ENV_ARTIFACT_ROOT_INVALID", "--execute requires an explicit runtime artifact root");
  if (typeof jobClient !== "function" || typeof artifactWriter !== "function") {
    fail("M6_ENV_RUNTIME_DEPENDENCY_INVALID", "environment qualification runtime dependencies are unavailable");
  }

  // The first external operation is always a loopback Gate-F status proof.
  // No transport is constructed and no device read is possible before it.
  const before = await requestClosedM64GateFStatus({ fetchImpl, controlPlaneUrl, token: controlToken });
  const result = await jobClient({
    fetchImpl,
    controlPlaneUrl,
    accountIsolationBindingHash,
    gateSnapshot: before,
    token: controlToken,
    now,
  });
  // Re-prove the same CLOSED generation before persisting any evidence. An
  // activation or close generation change during sampling invalidates it.
  const after = await requestClosedM64GateFStatus({ fetchImpl, controlPlaneUrl, token: controlToken });
  if (!sameGateGeneration(before, after)) {
    fail("M6_ENV_QUALIFICATION_GATE_DRIFT", "Gate F changed generation during target environment qualification", { status: 409 });
  }
  const artifacts = artifactWriter({
    artifactRoot,
    attestation: result.attestation,
    qualification: result.qualification,
  });
  return Object.freeze({
    attestationHash: artifacts.attestationHash,
    qualificationHash: artifacts.qualificationHash,
    commandRegistryHash,
    actionCount: 0,
  });
}
