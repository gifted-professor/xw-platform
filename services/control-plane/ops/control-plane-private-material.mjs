import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { createSystemAdministratorsPrivateAclChecker } from
  "../control-plane/lib/windows-private-acl.mjs";

export const CONTROL_PLANE_SECRET_ENVIRONMENT_SCHEMA_ID =
  "xw.runtime.control-plane-secret-environment.v1";
export const CONTROL_PLANE_SECRET_ENVIRONMENT_FILENAME =
  "control-plane-secret-environment.v1.json";
export const XHS_EVIDENCE_DIGEST_KEYRING_FILENAME =
  "xhs-evidence-digest-keyring.v1.json";
export const XHS_EVIDENCE_DIGEST_KEYRING_SCHEMA_ID = "xw.digest-keyring.v1";
export const CONTROL_PLANE_REQUIRED_PRIVATE_ENVIRONMENT = Object.freeze([
  "DEEPSEEK_API_KEY",
  "XW_M6_ACCOUNT_ISOLATION_BINDING_HASH",
  "XW_M6_GATE_F_OPERATIONS_TOKEN",
  "XW_M6_LIVE_ENTRY_TOKEN",
]);

const HEX64 = /^(?!0{64}$)[0-9a-f]{64}$/u;
const KEY_ID = /^[A-Za-z0-9-]{1,64}$/u;
const BASE64_256 = /^[A-Za-z0-9+/]{43}=$/u;
const verifySystemAdministratorsPrivateAcl = createSystemAdministratorsPrivateAclChecker();

function fail(code, message) {
  throw Object.assign(new Error(`${code}: ${message}`), { code });
}

function exactObject(value, keys) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertPlainDirectory(path, code) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(code, "directory is missing or is a reparse link");
}

function readPlainFile(path, code, maximumBytes) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || !Number.isSafeInteger(stat.size) || stat.size < 2 || stat.size > maximumBytes) {
    fail(code, "file is missing, linked, or outside its bounded size");
  }
  return readFileSync(path);
}

function parseJson(bytes, code) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(code, "file is not valid UTF-8 JSON");
  }
}

function validSecret(value, minimumLength) {
  return typeof value === "string" && value.length >= minimumLength && value.length <= 4096
    && !/[\u0000\r\n]/u.test(value);
}

export function validateControlPlaneSecretEnvironmentBytes(bytes) {
  const value = parseJson(bytes, "GATE_F_SECRET_ENVIRONMENT_INVALID");
  if (!exactObject(value, ["schemaId", "variables"])
    || value.schemaId !== CONTROL_PLANE_SECRET_ENVIRONMENT_SCHEMA_ID
    || !exactObject(value.variables, CONTROL_PLANE_REQUIRED_PRIVATE_ENVIRONMENT)) {
    fail("GATE_F_SECRET_ENVIRONMENT_INVALID", "secret environment exact schema drifted");
  }
  const variables = value.variables;
  if (!validSecret(variables.DEEPSEEK_API_KEY, 8)
    || !validSecret(variables.XW_M6_GATE_F_OPERATIONS_TOKEN, 32)
    || !validSecret(variables.XW_M6_LIVE_ENTRY_TOKEN, 32)
    || !HEX64.test(variables.XW_M6_ACCOUNT_ISOLATION_BINDING_HASH)) {
    fail("GATE_F_SECRET_ENVIRONMENT_INVALID", "a required private value is absent or malformed");
  }
  if (variables.XW_M6_GATE_F_OPERATIONS_TOKEN === variables.XW_M6_LIVE_ENTRY_TOKEN
    || variables.XW_M6_GATE_F_OPERATIONS_TOKEN === variables.DEEPSEEK_API_KEY
    || variables.XW_M6_LIVE_ENTRY_TOKEN === variables.DEEPSEEK_API_KEY) {
    fail("GATE_F_SECRET_ENVIRONMENT_INVALID", "private authorities are not independently bound");
  }
  return Object.freeze({
    schemaId: value.schemaId,
    requiredEnvironment: Object.freeze(Object.fromEntries(
      CONTROL_PLANE_REQUIRED_PRIVATE_ENVIRONMENT.map((name) => [name, "present"]),
    )),
  });
}

function validTimestamp(value) {
  return typeof value === "string" && value.length >= 20 && value.length <= 40
    && Number.isFinite(Date.parse(value));
}

export function validateDigestKeyringBytes(bytes) {
  const value = parseJson(bytes, "GATE_F_DIGEST_KEYRING_INVALID");
  const initialKeys = ["activeKeyId", "createdAt", "keys", "schemaId"];
  const rotatedKeys = ["activeKeyId", "keys", "rotatedAt", "schemaId"];
  const timestamp = exactObject(value, initialKeys) ? value.createdAt
    : exactObject(value, rotatedKeys) ? value.rotatedAt
      : null;
  if (value?.schemaId !== XHS_EVIDENCE_DIGEST_KEYRING_SCHEMA_ID
    || !KEY_ID.test(value?.activeKeyId || "") || !validTimestamp(timestamp)
    || !Array.isArray(value?.keys) || value.keys.length < 1 || value.keys.length > 256) {
    fail("GATE_F_DIGEST_KEYRING_INVALID", "digest keyring exact schema drifted");
  }
  const seen = new Set();
  let activeCount = 0;
  for (const entry of value.keys) {
    if (!exactObject(entry, ["algorithm", "createdAt", "keyBase64", "keyId", "status"])
      || !KEY_ID.test(entry?.keyId || "") || seen.has(entry.keyId)
      || entry.algorithm !== "HMAC-SHA-256"
      || !["active", "retained"].includes(entry.status)
      || !validTimestamp(entry.createdAt)
      || !BASE64_256.test(entry.keyBase64 || "")) {
      fail("GATE_F_DIGEST_KEYRING_INVALID", "digest key entry is malformed or duplicated");
    }
    const decoded = Buffer.from(entry.keyBase64, "base64");
    if (decoded.length !== 32 || decoded.toString("base64") !== entry.keyBase64) {
      fail("GATE_F_DIGEST_KEYRING_INVALID", "digest key must be exactly 256 random bits");
    }
    seen.add(entry.keyId);
    if (entry.status === "active") activeCount += 1;
  }
  const active = value.keys.find((entry) => entry.keyId === value.activeKeyId);
  if (activeCount !== 1 || active?.status !== "active") {
    fail("GATE_F_DIGEST_KEYRING_INVALID", "exactly one declared active digest key is required");
  }
  return Object.freeze({ schemaId: value.schemaId, activeKeyId: "present", keyMaterial: "present" });
}

export function inspectControlPlanePrivateMaterial({ runtimeRoot } = {}) {
  if (typeof runtimeRoot !== "string" || !isAbsolute(runtimeRoot)) {
    fail("GATE_F_RUNTIME_ROOT_INVALID", "runtime root must be absolute");
  }
  const root = resolve(runtimeRoot);
  const secretsRoot = join(root, "secrets");
  const secretEnvironmentPath = join(secretsRoot, CONTROL_PLANE_SECRET_ENVIRONMENT_FILENAME);
  const digestKeyringPath = join(secretsRoot, XHS_EVIDENCE_DIGEST_KEYRING_FILENAME);
  try {
    assertPlainDirectory(secretsRoot, "GATE_F_SECRETS_ROOT_INVALID");
    const secretEnvironmentBytes = readPlainFile(
      secretEnvironmentPath,
      "GATE_F_SECRET_ENVIRONMENT_INVALID",
      32 * 1024,
    );
    const digestKeyringBytes = readPlainFile(
      digestKeyringPath,
      "GATE_F_DIGEST_KEYRING_INVALID",
      1024 * 1024,
    );
    if (process.platform === "win32") {
      verifySystemAdministratorsPrivateAcl(secretEnvironmentPath);
      verifySystemAdministratorsPrivateAcl(digestKeyringPath);
    }
    const secretEnvironment = validateControlPlaneSecretEnvironmentBytes(secretEnvironmentBytes);
    const digestKeyring = validateDigestKeyringBytes(digestKeyringBytes);
    return Object.freeze({
      secretEnvironment: Object.freeze({
        path: secretEnvironmentPath,
        sha256: sha256(secretEnvironmentBytes),
        requiredEnvironment: secretEnvironment.requiredEnvironment,
      }),
      digestKeyring: Object.freeze({
        path: digestKeyringPath,
        sha256: sha256(digestKeyringBytes),
        activeKeyId: digestKeyring.activeKeyId,
        keyMaterial: digestKeyring.keyMaterial,
      }),
    });
  } catch (error) {
    if (/^GATE_F_/u.test(error?.code || "") || /^GATE_F_/u.test(error?.message || "")) throw error;
    fail("GATE_F_PRIVATE_MATERIAL_UNAVAILABLE", "private material is absent or unreadable");
  }
}
