// xhs-exploration-evidence.test.mjs — V3-I09 deployment-keyed digest key ring.
//
// Private evidence digests are HMAC-SHA-256 over a domain-separated string
// with 256-bit keys held in a SYSTEM-only ring. Startup fails closed on a
// missing/drifted manifest or ACL; rotation retains historical keys read-only
// and historical digests are NEVER rehashed.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createDigestKeyring,
  DigestKeyringError,
  KEYRING_SCHEMA_ID,
} from "../../control-plane/control-plane/lib/xhs-evidence-digest-keyring.mjs";
import { createHmac } from "node:crypto";

const tempBase = fileURLToPath(new URL("../../control-plane/control-plane/runtime", import.meta.url));

function fsHarness() {
  const root = mkdtempSync(join(tempBase, "digest-keyring-"));
  const files = new Map();
  const fsImpl = {
    existsSync: (p) => files.has(p) && !files.get(p).deleted,
    readFileSync: (p) => {
      const f = files.get(p);
      if (!f || f.deleted) throw new Error("ENOENT");
      return f.content;
    },
    writeFileSync: (p, content, _opts) => {
      files.set(p, { content: String(content) });
    },
    renameSync: (from, to) => {
      const f = files.get(from);
      files.delete(from);
      const dest = files.get(to);
      files.set(to, { content: f.content, acl: f.acl ?? dest?.acl });
    },
    mkdirSync: () => {},
  };
  const aclChecker = (p) => {
    const f = files.get(p);
    if (f?.acl === undefined) throw new DigestKeyringError("KEYRING_ACL_UNVERIFIABLE", "ACL is unknown in harness");
    if (f.acl !== "deny-by-default") {
      throw new DigestKeyringError("KEYRING_ACL_INVALID", `digest key ring ${p} ACL drifted`);
    }
  };
  return { root, files, fsImpl, aclChecker };
}

test("provision creates a deny-by-default ring with exactly one active 256-bit key", () => {
  const h = fsHarness();
  try {
    const path = join(h.root, "keys", "digest-keyring.json");
    const ring = createDigestKeyring({ path, aclChecker: h.aclChecker, fsImpl: h.fsImpl });
    const provisioned = ring.provision();
    assert.equal(provisioned.activeKeyId, "ka-1");
    h.files.get(path).acl = "deny-by-default";
    assert.equal(ring.activeKeyId(), "ka-1");
    const raw = JSON.parse(h.fsImpl.readFileSync(path, "utf8"));
    assert.equal(raw.schemaId, KEYRING_SCHEMA_ID);
    assert.equal(raw.keys.length, 1);
    assert.equal(Buffer.from(raw.keys[0].keyBase64, "base64").length, 32);
  } finally { rmSync(h.root, { recursive: true, force: true }); }
});

test("sign/verify round-trip is domain-separated and key-bound", () => {
  const h = fsHarness();
  try {
    const path = join(h.root, "digest-keyring.json");
    const ring = createDigestKeyring({ path, aclChecker: h.aclChecker, fsImpl: h.fsImpl });
    ring.provision();
    h.files.get(path).acl = "deny-by-default";
    const signed = ring.sign({ kind: "goal", value: "探索低卡早餐" });
    assert.match(signed.digest, /^[0-9a-f]{64}$/);
    assert.equal(ring.verify({ ...signed, kind: "goal", value: "探索低卡早餐" }).ok, true);
    assert.equal(ring.verify({ ...signed, kind: "query", value: "探索低卡早餐" }).ok, false, "digest domain includes the kind");
    assert.equal(ring.verify({ ...signed, kind: "goal", value: "低卡早餐探索" }).ok, false);
  } finally { rmSync(h.root, { recursive: true, force: true }); }
});

test("fail-closed: missing manifest, drifted schema, short key, two active keys, ACL drift", () => {
  const h = fsHarness();
  try {
    const path = join(h.root, "digest-keyring.json");
    const ring = createDigestKeyring({ path, aclChecker: h.aclChecker, fsImpl: h.fsImpl });
    assert.throws(() => ring.load(), (error) => error.code === "KEYRING_MISSING");
    const valid = JSON.stringify({
      schemaId: KEYRING_SCHEMA_ID,
      activeKeyId: "ka-1",
      keys: [{ keyId: "ka-1", keyBase64: Buffer.alloc(32, 7).toString("base64"), algorithm: "HMAC-SHA-256", status: "active", createdAt: "2026-08-29T00:00:00.000Z" }],
    });
    h.files.set(path, { content: valid, acl: "open" });
    assert.throws(() => ring.load(), (error) => error.code === "KEYRING_ACL_INVALID");
    h.files.get(path).acl = "deny-by-default";

    h.files.get(path).content = valid.replace('"activeKeyId": "ka-1"', '"activeKeyId": "ka-1", "extra": 1');
    h.fsImpl.writeFileSync(path + "2", valid.replace(KEYRING_SCHEMA_ID, "xw.digest-keyring.v0"));
    h.files.set(path, { content: valid.replace(KEYRING_SCHEMA_ID, "xw.digest-keyring.v0"), acl: "deny-by-default" });
    assert.throws(() => ring.load(), (error) => error.code === "KEYRING_MANIFEST_INVALID");

    h.files.set(path, { content: valid.replace('Buffer.alloc(32, 7)', ''), acl: "deny-by-default" });
    h.files.set(path, { content: valid, acl: "deny-by-default" });
    // short key
    h.files.set(path, {
      acl: "deny-by-default",
      content: JSON.stringify({
        schemaId: KEYRING_SCHEMA_ID, activeKeyId: "ka-1",
        keys: [{ keyId: "ka-1", keyBase64: Buffer.alloc(16, 1).toString("base64"), algorithm: "HMAC-SHA-256", status: "active" }],
      }),
    });
    assert.throws(() => ring.load(), (error) => error.code === "KEYRING_KEY_INVALID");
    // two active keys
    h.files.set(path, {
      acl: "deny-by-default",
      content: JSON.stringify({
        schemaId: KEYRING_SCHEMA_ID, activeKeyId: "ka-1",
        keys: [
          { keyId: "ka-1", keyBase64: Buffer.alloc(32, 1).toString("base64"), algorithm: "HMAC-SHA-256", status: "active" },
          { keyId: "ka-2", keyBase64: Buffer.alloc(32, 2).toString("base64"), algorithm: "HMAC-SHA-256", status: "active" },
        ],
      }),
    });
    assert.throws(() => ring.load(), (error) => error.code === "KEYRING_ACTIVE_KEY_INVALID");
  } finally { rmSync(h.root, { recursive: true, force: true }); }
});

test("rotation retains the previous key read-only; historical digests verify WITHOUT rehash", () => {
  const h = fsHarness();
  try {
    const path = join(h.root, "digest-keyring.json");
    const ring = createDigestKeyring({ path, aclChecker: h.aclChecker, fsImpl: h.fsImpl, randomBytesFn: (n) => Buffer.alloc(n, 9) });
    ring.provision();
    h.files.get(path).acl = "deny-by-default";
    const before = ring.sign({ kind: "goal", value: "原始目标" });
    const rotated = ring.rotate({ newKeyId: "ka-2" });
    assert.equal(rotated.activeKeyId, "ka-2");
    assert.equal(rotated.previousKeyId, "ka-1");
    // new digests use the new key
    const after = ring.sign({ kind: "goal", value: "原始目标" });
    assert.equal(after.digestKeyId, "ka-2");
    assert.notEqual(after.digest, before.digest);
    // the HISTORICAL digest still verifies against the retained key, untouched
    const historical = ring.verify({ digestKeyId: "ka-1", kind: "goal", value: "原始目标", digest: before.digest });
    assert.equal(historical.ok, true);
    assert.equal(historical.keyStatus, "retained-readonly");
    // tampered digest fails
    assert.equal(ring.verify({ digestKeyId: "ka-1", kind: "goal", value: "其他", digest: before.digest }).ok, false);
  } finally { rmSync(h.root, { recursive: true, force: true }); }
});

test("provision refuses to overwrite an existing ring", () => {
  const h = fsHarness();
  try {
    const path = join(h.root, "digest-keyring.json");
    const ring = createDigestKeyring({ path, aclChecker: h.aclChecker, fsImpl: h.fsImpl });
    ring.provision();
    assert.throws(() => ring.provision(), (error) => error.code === "KEYRING_EXISTS");
  } finally { rmSync(h.root, { recursive: true, force: true }); }
});

test("key bytes are never derived from a release hash — they are 32 random bytes per key", () => {
  const h = fsHarness();
  try {
    const path = join(h.root, "digest-keyring.json");
    const ring = createDigestKeyring({ path, aclChecker: h.aclChecker, fsImpl: h.fsImpl, randomBytesFn: (n) => Buffer.alloc(n, 3) });
    ring.provision();
    const raw = JSON.parse(h.fsImpl.readFileSync(path, "utf8"));
    const keyBytes = Buffer.from(raw.keys[0].keyBase64, "base64");
    assert.equal(keyBytes.length, 32);
    assert.deepEqual(keyBytes, Buffer.alloc(32, 3), "key bytes come from the injected RNG exactly");
  } finally { rmSync(h.root, { recursive: true, force: true }); }
});

test("real filesystem: provisioned ring decrypts/loads and verify matches manual HMAC", () => {
  const root = mkdtempSync(join(tempBase, "digest-keyring-real-"));
  try {
    const path = join(root, "digest-keyring.json");
    const ring = createDigestKeyring({ path, aclChecker: null, requireAcl: false });
    ring.provision();
    assert.ok(existsSync(path));
    const diskRing = createDigestKeyring({ path, aclChecker: null, requireAcl: false });
    const signed = diskRing.sign({ kind: "query", value: "低卡早餐" });
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const manual = createHmac("sha256", Buffer.from(raw.keys[0].keyBase64, "base64"))
      .update(`xhs-explore-v1:ka-1:query:低卡早餐`, "utf8").digest("hex");
    assert.equal(signed.digest, manual);
  } finally { rmSync(root, { recursive: true, force: true }); }
});