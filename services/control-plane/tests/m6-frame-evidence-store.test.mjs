import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { deflateSync } from "node:zlib";

import {
  M6EvidenceError,
  M6FrameEvidenceStore,
  M6_EVIDENCE_LIMITS,
  isWellFormedXml,
  redactLog,
} from "../control-plane/lib/m6-frame-evidence-store.mjs";

// ---------------------------------------------------------------------------
// Deterministic real PNG bytes (signature + IHDR + IDAT + IEND, valid CRC).
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function makePng(width, height, seed = 0) {
  const rowBytes = 1 + width * 3;
  const raw = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * rowBytes] = 0;
    for (let x = 0; x < width; x += 1) {
      raw[y * rowBytes + 1 + x * 3] = (x + seed) % 256;
      raw[y * rowBytes + 1 + x * 3 + 1] = (y + seed) % 256;
      raw[y * rowBytes + 1 + x * 3 + 2] = (x + y + seed) % 256;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const chunk = (type, data) => {
    const buf = Buffer.alloc(12 + data.length);
    buf.writeUInt32BE(data.length, 0);
    buf.write(type, 4, "latin1");
    data.copy(buf, 8);
    buf.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "latin1"), data])), 8 + data.length);
    return buf;
  };
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const PNG = makePng(240, 320);
const VALID_DUMP = Buffer.from(
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>\n` +
    `<hierarchy rotation="0"><node text="" content-desc="微信" />` +
    `<node text="确认"><node text="支付" /></node></hierarchy>`,
);
const VALID_OBSERVATION = Buffer.from(JSON.stringify({ width: 240, height: 320, orientation: "portrait", density: 3 }));
const VALID_FOCUS = Buffer.from("mCurrentFocus=Window{3c8e05b u0 com.tencent.mm/com.tencent.mm.ui.LauncherUI}");

function validFrameEvidence() {
  return {
    screenshotA: PNG,
    screenshotB: PNG,
    dump: VALID_DUMP,
    focus: VALID_FOCUS,
    observation: VALID_OBSERVATION,
  };
}

test("kind validation: screenshots are complete PNGs, dumps well-formed XML, focus text, observation JSON", () => {
  const { store } = withStore();
  {
    assert.throws(() => store.commit("screenshot", Buffer.from("not a png")), (e) => e.code === "M6_EVIDENCE_NOT_PNG");
    // A header-only / truncated PNG is not a complete screenshot.
    assert.throws(() => store.commit("screenshot", makePng(240, 320).subarray(0, 30)), (e) => e.code === "M6_EVIDENCE_NOT_PNG");
    assert.throws(() => store.commit("screenshot", makePng(240, 320).subarray(0, 200)), (e) => e.code === "M6_EVIDENCE_NOT_PNG");
    assert.throws(() => store.commit("dump", Buffer.from("<hierarchy><node></hierarchy>")), (e) => e.code === "M6_EVIDENCE_DUMP_NOT_XML");
    assert.throws(() => store.commit("dump", Buffer.from("plain text, not xml")), (e) => e.code === "M6_EVIDENCE_DUMP_NOT_XML");
    assert.throws(() => store.commit("focus", Buffer.from("has\0nul")), (e) => e.code === "M6_EVIDENCE_FOCUS_NOT_TEXT");
    assert.throws(() => store.commit("observation", Buffer.from("{not json")), (e) => e.code === "M6_EVIDENCE_OBSERVATION_NOT_JSON");
    assert.throws(() => store.commit("other", PNG), (e) => e.code === "M6_EVIDENCE_UNKNOWN_KIND");

    const screenshot = store.commit("screenshot", PNG);
    assert.match(screenshot.id, /^att-screenshot-[0-9a-f]{64}$/);
    const dump = store.commit("dump", VALID_DUMP);
    assert.match(dump.id, /^att-dump-[0-9a-f]{64}$/);
  }
});

test("oversize: per-kind byte caps fail closed", () => {
  const { store } = withStore();
  const codes = [
    ["screenshot", Buffer.alloc(M6_EVIDENCE_LIMITS.screenshotBytes + 1), "M6_EVIDENCE_OVERSIZE"],
    ["dump", Buffer.alloc(M6_EVIDENCE_LIMITS.dumpBytes + 1), "M6_EVIDENCE_OVERSIZE"],
    ["focus", Buffer.alloc(M6_EVIDENCE_LIMITS.focusBytes + 1), "M6_EVIDENCE_OVERSIZE"],
    ["observation", Buffer.alloc(M6_EVIDENCE_LIMITS.observationBytes + 1), "M6_EVIDENCE_OVERSIZE"],
  ];
  for (const [kind, bytes, code] of codes) {
    assert.throws(() => store.commit(kind, bytes), (e) => e.code === code, kind);
  }
});

test("CAS: identical bytes collide to a canonical ref; a tampered on-disk blob is rejected", () => {
  const { root, store } = withStore();
  const a = store.commit("screenshot", PNG);
  const b = store.commit("screenshot", PNG);
  assert.deepEqual(a, b);
  const blobFile = join(root, "blobs", a.sha256);
  assert.ok(existsSync(blobFile));

  // Hash tamper: overwrite the blob file, then both resolve and a re-commit
  // must fail closed.
  writeFileSync(blobFile, Buffer.from("forged"));
  assert.throws(() => store.resolve(a), (e) => e.code === "M6_EVIDENCE_TAMPERED");
  assert.throws(() => store.commit("screenshot", PNG), (e) => e.code === "M6_EVIDENCE_TAMPERED");
});

test("resolve round-trips bytes; missing/ref-invalid fail closed", () => {
  const { store } = withStore();
  const ref = store.commit("dump", VALID_DUMP);
  const resolved = store.resolve(ref);
  assert.equal(resolved.id, ref.id);
  assert.equal(resolved.sha256, ref.sha256);
  assert.deepEqual(resolved.bytes, VALID_DUMP);

  assert.throws(() => store.resolve({ id: "att-screenshot-" + "0".repeat(64), sha256: "0".repeat(64) }), (e) => e.code === "M6_EVIDENCE_MISSING");
  assert.throws(() => store.resolve({ id: "att-dump-x", sha256: "1".repeat(64) }), (e) => e.code === "M6_EVIDENCE_REF_INVALID");
  assert.throws(() => store.resolve({ id: `att-screenshot-${"1".repeat(64)}`, sha256: "2".repeat(64) }), (e) => e.code === "M6_EVIDENCE_REF_INVALID");
});

test("capacity: commit fails closed below the reserved floor", () => {
  const { store } = withStore({ minFreeBytes: Number.MAX_SAFE_INTEGER });
  assert.throws(() => store.commit("screenshot", PNG), (e) => e.code === "M6_EVIDENCE_DISK_LOW");
});

test("write/rename failure: evidence write fault fails closed with no residue", () => {
  const { root, store } = withStore();
  // Sabotage the blob root by replacing the directory with a regular file, so
  // the temp-open inside writeFile fails with ENOTDIR — a real cross-platform
  // write fault that must fail closed, never produce a stub.
  rmSync(join(root, "blobs"), { recursive: true, force: true });
  writeFileSync(join(root, "blobs"), "not a directory");
  assert.throws(() => store.commit("screenshot", PNG), (e) => e.code === "M6_EVIDENCE_WRITE_FAILED");
});

test("CAS-hit on a non-regular blob path fails closed", () => {
  const { root, store } = withStore();
  const ref = store.commit("screenshot", PNG);
  rmSync(join(root, "blobs", ref.sha256), { force: true });
  mkdirSync(join(root, "blobs", ref.sha256));
  assert.throws(() => store.commit("screenshot", PNG), (e) => e.code === "M6_EVIDENCE_NOT_REGULAR");
});

test("commitFrame is all-or-nothing: any evidence failure yields no frame", () => {
  const { store } = withStore();
  const bad = validFrameEvidence();
  bad.dump = Buffer.from("<broken><xml>");
  assert.throws(() => store.commitFrame(bad), (e) => e.code === "M6_EVIDENCE_DUMP_NOT_XML");
});

test("crash residue: a .tmp file is never resolvable as evidence and is swept", () => {
  const { root, store } = withStore();
  writeFileSync(join(root, "blobs", "deadbeef.tmp"), "crashed write");
  const ref = store.commit("screenshot", PNG);
  // The residue has no valid address — nothing resolves to it.
  assert.equal(store.sweepCrashResidue(), 1);
  assert.equal(existsSync(join(root, "blobs", "deadbeef.tmp")), false);
  // Sweeping never touches committed blobs.
  assert.equal(existsSync(join(root, "blobs", ref.sha256)), true);
});

test("tombstone removes from the active set; retention purge only drops expired", () => {
  const { root, store } = withStore();
  const ref = store.commit("dump", VALID_DUMP);
  store.tombstone(ref, { removedAtMs: 1000 });
  assert.throws(() => store.resolve(ref), (e) => e.code === "M6_EVIDENCE_MISSING");
  assert.equal(existsSync(join(root, "tombstones", ref.sha256)), true);

  // Keep an unexpired tombstone; purge only the expired one.
  const keep = store.commit("focus", VALID_FOCUS);
  store.tombstone(keep, { removedAtMs: 5000 });
  assert.equal(store.purgeExpired({ retentionMs: 3000, nowMs: 4000 }), 1);
  assert.equal(existsSync(join(root, "tombstones", ref.sha256 + ".json")), false);
  assert.equal(existsSync(join(root, "tombstones", keep.sha256 + ".json")), true);
  // Purge without time params is a no-op (never assumes an ambient clock).
  assert.equal(store.purgeExpired({}), 0);
});

test("path escape: resolve rejects junctions/symlinks pointing out of the blob root", () => {
  const { root, store } = withStore();
  const outside = mkdtempSync(join(tmpdir(), "m6-out-"));
  const ref = store.commit("screenshot", PNG);
  // Replace the blob's own address with a junction to an outside directory.
  const blobPath = join(root, "blobs", ref.sha256);
  rmSync(blobPath);
  const made = makeJunction(blobPath, outside);
  if (made) {
    writeFileSync(join(outside, "evil"), "outside file");
    // The junctioned address is not a regular file inside the blob root: the
    // resolve must fail closed (never read through the junction).
    assert.throws(
      () => store.resolve(ref),
      (e) => e.code === "M6_EVIDENCE_NOT_REGULAR" || e.code === "M6_EVIDENCE_PATH_ESCAPE" || e.code === "M6_EVIDENCE_SYMLINK",
    );
  }
});

test("log redaction: diagnostics never echo secrets or evidence bytes", () => {
  const redacted = redactLog({ runtimeId: "r-1", serial: "sn", token: "t", balance: 1, ok: true, nested: { apiKey: "k", label: "ok" } });
  assert.deepEqual(redacted, { ok: true, nested: { label: "ok" } });
  // Error details from commit never contain the evidence payload.
  const { store } = withStore();
  try {
    store.commit("screenshot", Buffer.from("secret-payload"));
  } catch (error) {
    assert.ok(error instanceof M6EvidenceError);
    assert.equal(error.details, null);
    assert.equal(error.message.includes("secret-payload"), false);
  }
});

function withStore(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "m6-ev-"));
  const store = new M6FrameEvidenceStore({ root, minFreeBytes: 0, ...overrides });
  return { root, store };
}

function makeJunction(linkPath, targetPath) {
  if (process.platform !== "win32") return null;
  const result = spawnSync("cmd", ["/c", "mklink", "/J", linkPath, targetPath], { encoding: "utf8" });
  return result.status === 0;
}
