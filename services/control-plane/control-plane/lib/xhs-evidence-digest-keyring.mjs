/**
 * xhs-evidence-digest-keyring.mjs — V3-I09 deployment-keyed digest key ring.
 *
 * Private keyed digests use HMAC-SHA-256 with 256-bit random keys held in a
 * SYSTEM/Administrators-only, deny-by-default key-ring file. The public
 * `digestKeyId` is a non-secret identifier; the key bytes are never derived
 * from a release hash and are never exposed to client/compiler/reviewer
 * output. Startup FAILS CLOSED when the active key, ACL, or manifest is
 * missing/drifted. Rotation creates a new active key id; historical keys
 * stay read-only across the evidence retention horizon and historical
 * digests are never rehashed.
 *
 * Zero third-party deps: node:fs + node:crypto only.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import {
  createSystemAdministratorsPrivateAclChecker,
  createSystemAdministratorsPrivateAclHardener,
} from "./windows-private-acl.mjs";

const KEYRING_SCHEMA_ID = "xw.digest-keyring.v1";

export class DigestKeyringError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "DigestKeyringError";
  }
}

const systemAdministratorsPrivateAclCheck = createSystemAdministratorsPrivateAclChecker();
const systemAdministratorsPrivateAclHarden = createSystemAdministratorsPrivateAclHardener();

function denyByDefaultAclCheck(path) {
  // Windows uses a native PowerShell/.NET ACL probe with a minimal child
  // environment. It requires a protected DACL containing exactly SYSTEM and
  // BUILTIN\Administrators on both the keyring and its plain parent directory.
  // POSIX retains the 0600 portable floor.
  try {
    systemAdministratorsPrivateAclCheck(path);
  } catch (error) {
    if (error instanceof DigestKeyringError) throw error;
    const code = error?.code === "KEYRING_ACL_INVALID" ? "KEYRING_ACL_INVALID" : "KEYRING_ACL_UNVERIFIABLE";
    throw new DigestKeyringError(code, `digest key ring ACL could not be verified: ${code}`);
  }
}

export function createDigestKeyring({
  path,
  aclChecker = denyByDefaultAclCheck,
  aclHardener = systemAdministratorsPrivateAclHarden,
  randomBytesFn = randomBytes,
  fsImpl = { readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync, existsSync },
  requireAcl = true,
} = {}) {
  if (!path || typeof path !== "string") {
    throw new DigestKeyringError("KEYRING_PATH_REQUIRED", "digest key ring path is required");
  }

  function load() {
    if (!fsImpl.existsSync(path)) {
      throw new DigestKeyringError("KEYRING_MISSING", `digest key ring is missing at ${path}; fail-closed (V3-I09)`);
    }
    if (requireAcl && aclChecker) aclChecker(path);
    let raw;
    try {
      raw = JSON.parse(fsImpl.readFileSync(path, "utf8"));
    } catch (error) {
      throw new DigestKeyringError("KEYRING_MANIFEST_INVALID", `digest key ring manifest is not valid JSON: ${error?.message || error}`);
    }
    if (raw.schemaId !== KEYRING_SCHEMA_ID || !Array.isArray(raw.keys) || raw.keys.length === 0) {
      throw new DigestKeyringError("KEYRING_MANIFEST_INVALID", "digest key ring schema mismatch");
    }
    const seen = new Set();
    const keys = new Map();
    for (const entry of raw.keys) {
      if (!entry?.keyId || !/^[a-zA-Z0-9-]{1,64}$/.test(entry.keyId)) {
        throw new DigestKeyringError("KEYRING_MANIFEST_INVALID", "key id missing/malformed");
      }
      if (seen.has(entry.keyId)) {
        throw new DigestKeyringError("KEYRING_MANIFEST_INVALID", `duplicate key id ${entry.keyId}`);
      }
      seen.add(entry.keyId);
      const keyBytes = Buffer.from(String(entry.keyBase64 ?? ""), "base64");
      if (keyBytes.length !== 32) {
        throw new DigestKeyringError("KEYRING_KEY_INVALID", `key ${entry.keyId} must be 256 bits`);
      }
      if (entry.algorithm !== "HMAC-SHA-256") {
        throw new DigestKeyringError("KEYRING_MANIFEST_INVALID", `key ${entry.keyId} must be HMAC-SHA-256`);
      }
      if (!new Set(["active", "retained"]).has(entry.status)) {
        throw new DigestKeyringError("KEYRING_MANIFEST_INVALID", `key ${entry.keyId} status is invalid`);
      }
      keys.set(entry.keyId, {
        keyId: entry.keyId,
        keyBytes,
        // "active" is the only live status; retained/retired keys stay
        // read-only for the retention horizon (never re-activated)
        status: entry.status === "active" ? "active" : "retained-readonly",
        createdAt: entry.createdAt ?? null,
      });
    }
    const active = [...keys.values()].filter((k) => k.status === "active");
    if (active.length !== 1 || !raw.activeKeyId || !keys.has(raw.activeKeyId)
      || keys.get(raw.activeKeyId).status !== "active") {
      throw new DigestKeyringError("KEYRING_ACTIVE_KEY_INVALID", "exactly one active 256-bit key is required");
    }
    return { activeKeyId: raw.activeKeyId, keys };
  }

  function writePrivateManifest(manifest, operation, { createOnly }) {
    const suffix = randomBytesFn(8).toString("hex");
    const tmp = `${path}.tmp-${operation}-${suffix}`;
    fsImpl.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    let tempCreated = false;
    try {
      fsImpl.writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
        flush: true,
      });
      tempCreated = true;
      if (requireAcl) {
        if (!aclHardener || !aclChecker) {
          throw new DigestKeyringError("KEYRING_ACL_UNVERIFIABLE", "private ACL writer/checker is unavailable");
        }
        aclHardener(tmp);
        aclChecker(tmp);
      }
      if (createOnly && fsImpl.existsSync(path)) {
        throw new DigestKeyringError("KEYRING_EXISTS", "refusing to overwrite an existing digest key ring");
      }
      fsImpl.renameSync(tmp, path);
      tempCreated = false;
      if (requireAcl) aclChecker(path);
    } catch (error) {
      if (tempCreated && typeof fsImpl.unlinkSync === "function") {
        try { fsImpl.unlinkSync(tmp); } catch { /* best-effort private temp cleanup */ }
      }
      if (error instanceof DigestKeyringError) throw error;
      const code = error?.code === "EEXIST" ? "KEYRING_TEMP_CONFLICT" : "KEYRING_WRITE_FAILED";
      throw new DigestKeyringError(code, `digest key ring ${operation} failed closed`);
    }
  }

  return {
    /** Load and validate the ring; throws every documented fail-closed code. */
    load,

    /** Non-secret public key id of the active key. */
    activeKeyId() {
      return load().activeKeyId;
    },

    /** HMAC-SHA-256 over a kinded domain with the ACTIVE key. */
    sign({ kind, value }) {
      const { activeKeyId, keys } = load();
      const key = keys.get(activeKeyId);
      const digest = createHmac("sha256", key.keyBytes)
        .update(`xhs-explore-v1:${activeKeyId}:${kind}:${value}`, "utf8")
        .digest("hex");
      return { digestKeyId: activeKeyId, digest };
    },

    /**
     * Verify a record's digest. Active key OR retained read-only history —
     * rotation never invalidates historical receipts; they are never rehashed.
     */
    verify({ digestKeyId, kind, value, digest }) {
      const { keys } = load();
      const key = keys.get(String(digestKeyId ?? ""));
      if (!key) throw new DigestKeyringError("KEYRING_KEY_ID_UNKNOWN", `digest key id ${digestKeyId} is not in the ring`);
      const expected = createHmac("sha256", key.keyBytes)
        .update(`xhs-explore-v1:${key.keyId}:${kind}:${value}`, "utf8")
        .digest("hex");
      const ok = expected.length === String(digest ?? "").length
        && timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(String(digest), "utf8"));
      return { ok, keyStatus: key.status };
    },

    /**
     * Rotate: new active key id, previous keys retained read-only. Atomic
     * write (tmp + rename); ring stays deny-by-default.
     */
    rotate({ newKeyId } = {}) {
      const { activeKeyId, keys } = load();
      const id = newKeyId || `ka-${randomBytesFn(4).toString("hex")}`;
      if (keys.has(id)) throw new DigestKeyringError("KEYRING_KEY_ID_COLLISION", `key id ${id} already exists`);
      const keyBase64 = randomBytesFn(32).toString("base64");
      const now = new Date().toISOString();
      const entries = [...keys.values()].map((k) => ({
        keyId: k.keyId,
        keyBase64: k.keyBytes.toString("base64"),
        algorithm: "HMAC-SHA-256",
        // every existing key (including the previously active one) becomes
        // retained read-only; the new key below is the single active entry
        status: "retained",
        createdAt: k.createdAt,
      }));
      entries.push({ keyId: id, keyBase64, algorithm: "HMAC-SHA-256", status: "active", createdAt: now });
      const manifest = { schemaId: KEYRING_SCHEMA_ID, activeKeyId: id, rotatedAt: now, keys: entries };
      writePrivateManifest(manifest, "rotate", { createOnly: false });
      return { activeKeyId: id, previousKeyId: activeKeyId };
    },

    /**
     * Provision an initial ring with one active key (offline provisioning).
     * Atomic create; refuses to overwrite an existing ring.
     */
    provision() {
      if (fsImpl.existsSync(path)) {
        throw new DigestKeyringError("KEYRING_EXISTS", "refusing to overwrite an existing digest key ring");
      }
      const keyBase64 = randomBytesFn(32).toString("base64");
      const id = "ka-1";
      const manifest = {
        schemaId: KEYRING_SCHEMA_ID,
        activeKeyId: id,
        createdAt: new Date().toISOString(),
        keys: [{ keyId: id, keyBase64, algorithm: "HMAC-SHA-256", status: "active", createdAt: new Date().toISOString() }],
      };
      writePrivateManifest(manifest, "provision", { createOnly: true });
      return { activeKeyId: id, path };
    },
  };
}

export { KEYRING_SCHEMA_ID };
