import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { verifyReleaseManifest } from
  "../../../../packages/release/lib/release-manifest.mjs";
import {
  CONTROL_PLANE_SECRET_ENVIRONMENT_FILENAME,
  inspectControlPlanePrivateMaterial,
  validateControlPlaneSecretEnvironmentBytes,
} from "../../ops/control-plane-private-material.mjs";
import { ControlPlaneError } from "./errors.mjs";
import {
  buildSystemTcbAclPlan,
  createSystemTcbAclController,
} from "./windows-system-tcb-acl.mjs";

export const XHS_V3_FIXED_OPERATOR_AUTH_SCHEMA_ID =
  "xw.xhs.v3-fixed-operator-request-authorization.v1";
export const XHS_V3_FIXED_OPERATOR_RELEASE_PATH =
  "services/control-plane/ops/xhs-v3-production-operator.mjs";
export const XHS_V3_FIXED_OPERATOR_AUTH_HEADER =
  "x-xhs-v3-fixed-operator-authorization";
export const XHS_V3_FIXED_OPERATOR_NONCE_HEADER =
  "x-xhs-v3-fixed-operator-nonce";
export const XHS_V3_FIXED_OPERATOR_TIMESTAMP_HEADER =
  "x-xhs-v3-fixed-operator-timestamp";
export const XHS_V3_FIXED_OPERATOR_GATE_HEADER =
  "x-control-token";
export const XHS_V3_FIXED_OPERATOR_RUNTIME_ROOT =
  "C:\\Users\\Public\\xw-runtime";

const HASH = /^(?!0{64}$)[0-9a-f]{64}$/u;
const HEX40 = /^(?!0{40}$)[0-9a-f]{40}$/u;
const RELEASE_ID = /^[a-z0-9][a-z0-9._-]{2,127}$/u;
const NONCE = /^[0-9a-f]{32}$/u;
const METHOD = /^(?:GET|POST)$/u;
const PATH = /^\/control\/v1\/internal\/xhs\/(?:exploration|rpa)\/[a-z0-9/-]+$/u;
const DEFAULT_MAX_AGE_MS = 30_000;
const DEFAULT_FUTURE_SKEW_MS = 5_000;
const DEFAULT_MAX_NONCES = 4_096;

function fail(code, message, status = 503) {
  throw new ControlPlaneError(code, message, { status });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactObject(value, keys) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()));
}

function canonicalValue(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object"
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  fail("XHS_V3_FIXED_OPERATOR_BODY_INVALID", "operator request body is not canonical JSON", 400);
}

export function canonicalXhsV3FixedOperatorJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function hashXhsV3FixedOperatorBody(body) {
  return sha256(Buffer.from(canonicalXhsV3FixedOperatorJson(body === undefined ? null : body), "utf8"));
}

function pathKey(value) {
  const full = resolve(value);
  return process.platform === "win32" ? full.toLowerCase() : full;
}

function samePath(left, right) {
  return pathKey(left) === pathKey(right);
}

function readPlainBytes(path, code, maximumBytes) {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || !Number.isSafeInteger(stat.size) || stat.size < 2 || stat.size > maximumBytes
      || !samePath(realpathSync(path), path)) {
      fail(code, "fixed private or release material is not one plain file");
    }
    return readFileSync(path);
  } catch (error) {
    if (error instanceof ControlPlaneError) throw error;
    fail(code, "fixed private or release material is unavailable");
  }
}

function parseJson(bytes, code) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(code, "fixed material is not valid UTF-8 JSON");
  }
}

function releaseBinding(value) {
  if (!exactObject(value, ["releaseId", "sourceCommit", "operatorSha256"])
    || !RELEASE_ID.test(value.releaseId || "")
    || !HEX40.test(value.sourceCommit || "")
    || !HASH.test(value.operatorSha256 || "")) {
    fail("XHS_V3_FIXED_OPERATOR_RELEASE_INVALID", "fixed operator release binding is invalid");
  }
  return Object.freeze({ ...value });
}

function headerValue(headers, name) {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return null;
  let found = null;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    if (found !== null || typeof value !== "string") return null;
    found = value;
  }
  return found;
}

function requestDomain({ binding, method, path, bodyHash, timestamp, nonce }) {
  return canonicalXhsV3FixedOperatorJson({
    schemaId: XHS_V3_FIXED_OPERATOR_AUTH_SCHEMA_ID,
    releaseId: binding.releaseId,
    sourceCommit: binding.sourceCommit,
    operatorSha256: binding.operatorSha256,
    timestamp,
    nonce,
    method,
    path,
    bodySha256: bodyHash,
  });
}

function validateRequestCoordinates({ method, path, timestamp, nonce, bodyHash }) {
  if (!METHOD.test(method || "") || !PATH.test(path || "")
    || !/^[0-9]{13}$/u.test(timestamp || "") || !NONCE.test(nonce || "")
    || !HASH.test(bodyHash || "")) {
    fail("XHS_V3_FIXED_OPERATOR_AUTH_INPUT_INVALID", "fixed request binding is invalid", 400);
  }
}

function requestMac({ liveEntryToken, binding, method, path, bodyHash, timestamp, nonce }) {
  validateRequestCoordinates({ method, path, timestamp, nonce, bodyHash });
  return createHmac("sha256", liveEntryToken)
    .update(requestDomain({ binding, method, path, bodyHash, timestamp, nonce }), "utf8")
    .digest("hex");
}

export function createInMemoryXhsV3FixedOperatorNonceStoreForTest({ maxNonces = DEFAULT_MAX_NONCES } = {}) {
  const rows = new Map();
  return Object.freeze({
    consume({ nonce, signedAt, expiresAt, requestHash }) {
      if (!NONCE.test(nonce || "") || !Number.isSafeInteger(signedAt)
        || !Number.isSafeInteger(expiresAt) || expiresAt <= signedAt || !HASH.test(requestHash || "")) {
        fail("XHS_V3_FIXED_OPERATOR_NONCE_RECORD_INVALID", "nonce record is invalid", 503);
      }
      for (const [key, row] of rows) if (row.expiresAt < signedAt) rows.delete(key);
      if (rows.has(nonce)) fail("XHS_V3_FIXED_OPERATOR_REPLAY_REJECTED", "task-owned operator nonce was already consumed", 409);
      if (rows.size >= maxNonces) fail("XHS_V3_FIXED_OPERATOR_REPLAY_CACHE_FULL", "fixed request replay cache is full", 503);
      rows.set(nonce, { expiresAt, requestHash });
      return true;
    },
  });
}

export function createDurableXhsV3FixedOperatorNonceStore({
  runtimeRoot,
  binding,
  aclController = createSystemTcbAclController(),
  maxNonces = DEFAULT_MAX_NONCES,
} = {}) {
  const fixed = releaseBinding(binding);
  if (typeof runtimeRoot !== "string" || !isAbsolute(runtimeRoot)
    || !aclController || typeof aclController.protect !== "function"
    || typeof aclController.verify !== "function"
    || !Number.isInteger(maxNonces) || maxNonces < 64 || maxNonces > 65_536) {
    fail("XHS_V3_FIXED_OPERATOR_NONCE_STORE_INVALID", "durable nonce store is unavailable");
  }
  const root = resolve(runtimeRoot);
  const privateRoot = join(root, "private", "xhs-v3");
  try {
    const stat = lstatSync(privateRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(realpathSync(privateRoot), privateRoot)) {
      fail("XHS_V3_FIXED_OPERATOR_NONCE_STORE_INVALID", "task private root is linked or reparsed");
    }
  } catch (error) {
    if (error instanceof ControlPlaneError) throw error;
    fail("XHS_V3_FIXED_OPERATOR_NONCE_STORE_INVALID", "task private root is unavailable");
  }
  aclController.verify(buildSystemTcbAclPlan({ boundaryPath: root, targetPath: privateRoot, recursive: true }));
  const releaseKey = sha256(Buffer.from(`${fixed.releaseId}:${fixed.sourceCommit}:${fixed.operatorSha256}`, "utf8"));
  const storeRoot = join(privateRoot, "operator-authorization", releaseKey, "consumed-nonces");
  if (!existsSync(storeRoot)) mkdirSync(storeRoot, { recursive: true, mode: 0o700 });
  aclController.protect(buildSystemTcbAclPlan({ boundaryPath: root, targetPath: storeRoot, recursive: true }));
  aclController.verify(buildSystemTcbAclPlan({ boundaryPath: root, targetPath: storeRoot, recursive: true }));

  function loadRows(nowMs) {
    const rows = [];
    const names = readdirSync(storeRoot).sort();
    if (names.length > maxNonces + 256) {
      fail("XHS_V3_FIXED_OPERATOR_REPLAY_CACHE_FULL", "durable nonce ledger exceeded its fixed bound", 503);
    }
    for (const name of names) {
      if (!/^[0-9a-f]{64}\.v1\.json$/u.test(name)) {
        fail("XHS_V3_FIXED_OPERATOR_NONCE_STORE_DRIFT", "durable nonce ledger contains an unexpected entry", 503);
      }
      const path = join(storeRoot, name);
      aclController.verify(buildSystemTcbAclPlan({ boundaryPath: root, targetPath: path, recursive: false }));
      const bytes = readPlainBytes(path, "XHS_V3_FIXED_OPERATOR_NONCE_STORE_DRIFT", 64 * 1024);
      const value = parseJson(bytes, "XHS_V3_FIXED_OPERATOR_NONCE_STORE_DRIFT");
      if (!exactObject(value, [
        "schemaId", "schemaVersion", "releaseId", "sourceCommit", "operatorSha256",
        "nonceHash", "signedAt", "expiresAt", "requestHash", "recordHash",
      ])
        || value.schemaId !== "xw.xhs.v3-fixed-operator-consumed-nonce.v1"
        || value.schemaVersion !== 1 || value.releaseId !== fixed.releaseId
        || value.sourceCommit !== fixed.sourceCommit || value.operatorSha256 !== fixed.operatorSha256
        || !HASH.test(value.nonceHash || "") || name !== `${value.nonceHash}.v1.json`
        || !Number.isSafeInteger(value.signedAt) || !Number.isSafeInteger(value.expiresAt)
        || value.expiresAt <= value.signedAt || !HASH.test(value.requestHash || "")
        || !HASH.test(value.recordHash || "")) {
        fail("XHS_V3_FIXED_OPERATOR_NONCE_STORE_DRIFT", "durable nonce record drifted", 503);
      }
      const { recordHash, ...body } = value;
      if (recordHash !== sha256(Buffer.from(canonicalXhsV3FixedOperatorJson(body), "utf8"))
        || bytes.toString("utf8") !== `${canonicalXhsV3FixedOperatorJson(value)}\n`) {
        fail("XHS_V3_FIXED_OPERATOR_NONCE_STORE_DRIFT", "durable nonce record hash drifted", 503);
      }
      if (value.expiresAt < nowMs) {
        unlinkSync(path);
        continue;
      }
      rows.push(value);
    }
    return rows;
  }

  return Object.freeze({
    consume({ nonce, signedAt, expiresAt, requestHash }) {
      if (!NONCE.test(nonce || "") || !Number.isSafeInteger(signedAt)
        || !Number.isSafeInteger(expiresAt) || expiresAt <= signedAt || !HASH.test(requestHash || "")) {
        fail("XHS_V3_FIXED_OPERATOR_NONCE_RECORD_INVALID", "nonce record is invalid", 503);
      }
      const rows = loadRows(signedAt);
      const nonceHash = sha256(Buffer.from(`xw.xhs.v3-fixed-operator-nonce.v1\0${nonce}`, "utf8"));
      if (rows.some((row) => row.nonceHash === nonceHash)) {
        fail("XHS_V3_FIXED_OPERATOR_REPLAY_REJECTED", "task-owned operator nonce was already consumed", 409);
      }
      if (rows.length >= maxNonces) {
        fail("XHS_V3_FIXED_OPERATOR_REPLAY_CACHE_FULL", "durable nonce ledger is full", 503);
      }
      const body = Object.freeze({
        schemaId: "xw.xhs.v3-fixed-operator-consumed-nonce.v1",
        schemaVersion: 1,
        releaseId: fixed.releaseId,
        sourceCommit: fixed.sourceCommit,
        operatorSha256: fixed.operatorSha256,
        nonceHash,
        signedAt,
        expiresAt,
        requestHash,
      });
      const value = Object.freeze({
        ...body,
        recordHash: sha256(Buffer.from(canonicalXhsV3FixedOperatorJson(body), "utf8")),
      });
      const path = join(storeRoot, `${nonceHash}.v1.json`);
      try {
        writeFileSync(path, `${canonicalXhsV3FixedOperatorJson(value)}\n`, {
          flag: "wx", mode: 0o600, flush: true,
        });
      } catch (error) {
        if (error?.code === "EEXIST") {
          fail("XHS_V3_FIXED_OPERATOR_REPLAY_REJECTED", "task-owned operator nonce was already consumed", 409);
        }
        fail("XHS_V3_FIXED_OPERATOR_NONCE_STORE_UNAVAILABLE", "durable nonce could not be consumed", 503);
      }
      aclController.protect(buildSystemTcbAclPlan({ boundaryPath: root, targetPath: path, recursive: false }));
      aclController.verify(buildSystemTcbAclPlan({ boundaryPath: root, targetPath: path, recursive: false }));
      return true;
    },
  });
}

export function loadXhsV3FixedOperatorAuthority({
  runtimeRoot = XHS_V3_FIXED_OPERATOR_RUNTIME_ROOT,
  privateMaterialInspector = inspectControlPlanePrivateMaterial,
} = {}) {
  if (typeof runtimeRoot !== "string" || !isAbsolute(runtimeRoot)
    || !samePath(runtimeRoot, XHS_V3_FIXED_OPERATOR_RUNTIME_ROOT)
    || typeof privateMaterialInspector !== "function") {
    fail("XHS_V3_FIXED_OPERATOR_AUTHORITY_INVALID", "operator authority is not fixed to the production root");
  }
  const inspected = privateMaterialInspector({ runtimeRoot: resolve(runtimeRoot) });
  const secretPath = join(resolve(runtimeRoot), "secrets", CONTROL_PLANE_SECRET_ENVIRONMENT_FILENAME);
  if (!inspected?.secretEnvironment || !samePath(inspected.secretEnvironment.path, secretPath)
    || !HASH.test(inspected.secretEnvironment.sha256 || "")) {
    fail("XHS_V3_FIXED_OPERATOR_AUTHORITY_INVALID", "private material inspection did not bind the fixed secret file");
  }
  const bytes = readPlainBytes(secretPath, "XHS_V3_FIXED_OPERATOR_AUTHORITY_INVALID", 32 * 1024);
  if (sha256(bytes) !== inspected.secretEnvironment.sha256) {
    fail("XHS_V3_FIXED_OPERATOR_AUTHORITY_DRIFT", "private material changed after ACL/schema inspection");
  }
  validateControlPlaneSecretEnvironmentBytes(bytes);
  const value = parseJson(bytes, "XHS_V3_FIXED_OPERATOR_AUTHORITY_INVALID");
  const gateToken = value.variables.XW_M6_GATE_F_OPERATIONS_TOKEN;
  const liveEntryToken = value.variables.XW_M6_LIVE_ENTRY_TOKEN;
  if (typeof gateToken !== "string" || gateToken.length < 32
    || typeof liveEntryToken !== "string" || liveEntryToken.length < 32
    || gateToken === liveEntryToken || /[\0\r\n]/u.test(gateToken + liveEntryToken)) {
    fail("XHS_V3_FIXED_OPERATOR_AUTHORITY_INVALID", "independent fixed authorities are unavailable");
  }
  return Object.freeze({ gateToken, liveEntryToken });
}

export function loadXhsV3FixedOperatorReleaseBinding({
  runtimeRoot = XHS_V3_FIXED_OPERATOR_RUNTIME_ROOT,
  releaseIdentity,
  executingOperatorPath = null,
  releaseVerifier = verifyReleaseManifest,
} = {}) {
  if (typeof runtimeRoot !== "string" || !isAbsolute(runtimeRoot)
    || !samePath(runtimeRoot, XHS_V3_FIXED_OPERATOR_RUNTIME_ROOT)
    || !RELEASE_ID.test(releaseIdentity?.releaseId || "")
    || !HEX40.test(releaseIdentity?.sourceCommit || "")
    || typeof releaseVerifier !== "function") {
    fail("XHS_V3_FIXED_OPERATOR_RELEASE_INVALID", "FINAL release identity is unavailable");
  }
  const root = resolve(runtimeRoot);
  const releaseRoot = join(root, "releases", releaseIdentity.releaseId);
  const manifestPath = join(releaseRoot, "release-manifest.v1.json");
  const operatorPath = join(releaseRoot, ...XHS_V3_FIXED_OPERATOR_RELEASE_PATH.split("/"));
  try {
    if (!samePath(realpathSync(join(root, "current")), releaseRoot)) {
      fail("XHS_V3_FIXED_OPERATOR_RELEASE_INACTIVE", "operator release is not current");
    }
  } catch (error) {
    if (error instanceof ControlPlaneError) throw error;
    fail("XHS_V3_FIXED_OPERATOR_RELEASE_INACTIVE", "current release binding is unavailable");
  }
  if (executingOperatorPath !== null && !samePath(executingOperatorPath, operatorPath)) {
    fail("XHS_V3_FIXED_OPERATOR_SELF_INVALID", "command did not execute the current manifest-pinned operator");
  }
  const verified = releaseVerifier({ manifestPath, root: releaseRoot });
  if (verified?.ok !== true) {
    fail("XHS_V3_FIXED_OPERATOR_RELEASE_DRIFT", "current release differs from its formal manifest");
  }
  const manifestBytes = readPlainBytes(manifestPath, "XHS_V3_FIXED_OPERATOR_RELEASE_INVALID", 64 * 1024 * 1024);
  const manifest = parseJson(manifestBytes, "XHS_V3_FIXED_OPERATOR_RELEASE_INVALID");
  const matches = Array.isArray(manifest.files)
    ? manifest.files.filter((entry) => entry?.path === XHS_V3_FIXED_OPERATOR_RELEASE_PATH)
    : [];
  const operatorBytes = readPlainBytes(operatorPath, "XHS_V3_FIXED_OPERATOR_SELF_INVALID", 8 * 1024 * 1024);
  if (manifest.releaseId !== releaseIdentity.releaseId
    || manifest.sourceCommit !== releaseIdentity.sourceCommit
    || matches.length !== 1 || !HASH.test(matches[0]?.sha256 || "")
    || sha256(operatorBytes) !== matches[0].sha256) {
    fail("XHS_V3_FIXED_OPERATOR_SELF_INVALID", "fixed operator bytes/source differ from the FINAL manifest");
  }
  return releaseBinding({
    releaseId: manifest.releaseId,
    sourceCommit: manifest.sourceCommit,
    operatorSha256: matches[0].sha256,
  });
}

export function createXhsV3FixedOperatorRequestSigner({
  liveEntryToken,
  binding,
  now = Date.now,
  nonceFactory = () => randomBytes(16).toString("hex"),
} = {}) {
  const fixed = releaseBinding(binding);
  if (typeof liveEntryToken !== "string" || liveEntryToken.length < 32
    || /[\0\r\n]/u.test(liveEntryToken) || typeof now !== "function"
    || typeof nonceFactory !== "function") {
    fail("XHS_V3_FIXED_OPERATOR_SIGNER_INVALID", "fixed request signer is unavailable");
  }
  return Object.freeze({
    sign({ method, path, body } = {}) {
      const timestamp = String(now());
      const nonce = nonceFactory();
      const bodyHash = hashXhsV3FixedOperatorBody(body);
      const authorization = requestMac({
        liveEntryToken,
        binding: fixed,
        method,
        path,
        bodyHash,
        timestamp,
        nonce,
      });
      return Object.freeze({
        [XHS_V3_FIXED_OPERATOR_AUTH_HEADER]: authorization,
        [XHS_V3_FIXED_OPERATOR_TIMESTAMP_HEADER]: timestamp,
        [XHS_V3_FIXED_OPERATOR_NONCE_HEADER]: nonce,
      });
    },
  });
}

export function createXhsV3FixedOperatorAuthorizer({
  liveEntryToken,
  binding,
  now = Date.now,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  futureSkewMs = DEFAULT_FUTURE_SKEW_MS,
  nonceStore,
} = {}) {
  const fixed = releaseBinding(binding);
  if (typeof liveEntryToken !== "string" || liveEntryToken.length < 32
    || /[\0\r\n]/u.test(liveEntryToken) || typeof now !== "function"
    || !Number.isInteger(maxAgeMs) || maxAgeMs < 1_000 || maxAgeMs > 60_000
    || !Number.isInteger(futureSkewMs) || futureSkewMs < 0 || futureSkewMs > 10_000
    || !nonceStore || typeof nonceStore.consume !== "function") {
    fail("XHS_V3_FIXED_OPERATOR_AUTHORIZER_INVALID", "fixed request authorizer is unavailable");
  }

  return Object.freeze({
    binding: fixed,
    assertAuthorized({ method, path, body, headers } = {}) {
      const authorization = headerValue(headers, XHS_V3_FIXED_OPERATOR_AUTH_HEADER);
      const timestamp = headerValue(headers, XHS_V3_FIXED_OPERATOR_TIMESTAMP_HEADER);
      const nonce = headerValue(headers, XHS_V3_FIXED_OPERATOR_NONCE_HEADER);
      const bodyHash = hashXhsV3FixedOperatorBody(body);
      if (!HASH.test(authorization || "")) {
        fail("XHS_V3_FIXED_OPERATOR_UNAUTHORIZED", "task-owned operator authorization is required", 403);
      }
      validateRequestCoordinates({ method, path, bodyHash, timestamp, nonce });
      const nowMs = now();
      const signedAt = Number(timestamp);
      if (!Number.isSafeInteger(nowMs) || !Number.isSafeInteger(signedAt)
        || signedAt < nowMs - maxAgeMs || signedAt > nowMs + futureSkewMs) {
        fail("XHS_V3_FIXED_OPERATOR_AUTH_EXPIRED", "task-owned operator authorization is outside its short window", 403);
      }
      const expected = requestMac({
        liveEntryToken,
        binding: fixed,
        method,
        path,
        bodyHash,
        timestamp,
        nonce,
      });
      const left = Buffer.from(authorization, "hex");
      const right = Buffer.from(expected, "hex");
      if (left.length !== right.length || !timingSafeEqual(left, right)) {
        fail("XHS_V3_FIXED_OPERATOR_UNAUTHORIZED", "task-owned operator authorization is invalid", 403);
      }
      nonceStore.consume({
        nonce,
        signedAt,
        expiresAt: signedAt + maxAgeMs + futureSkewMs,
        requestHash: sha256(Buffer.from(requestDomain({
          binding: fixed, method, path, bodyHash, timestamp, nonce,
        }), "utf8")),
      });
      return Object.freeze({ ok: true, releaseId: fixed.releaseId, sourceCommit: fixed.sourceCommit });
    },
  });
}

export function createFixedXhsV3OperatorAuthorization({
  runtimeRoot = XHS_V3_FIXED_OPERATOR_RUNTIME_ROOT,
  releaseIdentity,
  privateMaterialInspector = inspectControlPlanePrivateMaterial,
  releaseVerifier = verifyReleaseManifest,
  now = Date.now,
} = {}) {
  const authority = loadXhsV3FixedOperatorAuthority({ runtimeRoot, privateMaterialInspector });
  const binding = loadXhsV3FixedOperatorReleaseBinding({
    runtimeRoot,
    releaseIdentity,
    releaseVerifier,
  });
  const nonceStore = createDurableXhsV3FixedOperatorNonceStore({ runtimeRoot, binding });
  return createXhsV3FixedOperatorAuthorizer({
    liveEntryToken: authority.liveEntryToken,
    binding,
    now,
    nonceStore,
  });
}
