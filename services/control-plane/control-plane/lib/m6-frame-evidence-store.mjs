// M6-2 fail-closed frame evidence store. Every frame's evidence is committed
// content-addressed and read back with a SHA-256 check; ANY failure (capacity,
// oversize, malformed type, write/rename/fsync/readback fault, hash tamper,
// path escape) throws — there is NO debt mode, NO stub record, NO degraded path.
// A frame is frozen only when all of its evidence refs exist, so an evidence
// failure always yields "no frame", never a partial or best-effort frame.
//
// Hard gates (Plan V2 W3):
//   * CAS immutable blobs: id = `att-<kind>-<sha256>`; identical bytes → same ref.
//   * Atomic commit: temp write → fsync → rename → readback hash verify. A
//     crashed write leaves a .tmp residue that is never resolvable as evidence.
//   * Per-kind validation: screenshots must be complete PNGs (signature + IHDR),
//     dumps must be well-formed XML, focus must be text, observations JSON.
//   * Path discipline: blob paths derive from the sha256 only; resolve() rejects
//     symlinks/junctions and anything that escapes the blob root.
//   * Capacity: writes fail closed below the reserved floor.
//   * Tombstones: removal is recorded; retention purge is explicit.
//   * Diagnostics are redacted: never echo evidence bytes or secret-named keys.
//
// No ambient clock for anything content-addressed; `nowMs` is injected where
// retention decisions need time.
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

export const M6_EVIDENCE_KINDS = Object.freeze(["screenshot", "dump", "focus", "observation"]);

export const M6_EVIDENCE_LIMITS = Object.freeze({
  screenshotBytes: 16 * 1024 * 1024,
  dumpBytes: 4 * 1024 * 1024,
  focusBytes: 64 * 1024,
  observationBytes: 1024 * 1024,
});

const SENSITIVE_KEYS = /(?:serial|runtime.?id|token|secret|password|authorization|cookie|api.?key|balance)/i;

export function redactLog(value) {
  if (Array.isArray(value)) return value.map(redactLog);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !SENSITIVE_KEYS.test(key))
        .map(([key, child]) => [key, redactLog(child)]),
    );
  }
  return value;
}

export class M6EvidenceError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "M6EvidenceError";
    this.code = code;
    this.details = details;
  }
}

// Complete-PNG gate: 8-byte signature, a chunk walk with valid framing (length +
// type + data + CRC), IHDR first with positive dimensions, at least one IDAT,
// and IEND as the final chunk exactly at end-of-file. A header-only or truncated
// PNG fails — screenshots committed as evidence must be decodable files, not
// fragments. (The frame assembler re-binds IHDR dims to the display observation.)
export function isCompletePng(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 8) return false;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i += 1) if (bytes[i] !== sig[i]) return false;
  let offset = 8;
  let sawIhdr = false;
  let sawIdat = false;
  let lastType = null;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    if (offset + 12 + length > bytes.length) return false; // chunk data truncated
    if (type === "IHDR") {
      if (sawIhdr || offset !== 8) return false; // IHDR must be first and unique
      sawIhdr = true;
      if (bytes.readUInt32BE(offset + 8) < 1 || bytes.readUInt32BE(offset + 12) < 1) return false;
    } else if (type === "IDAT") {
      sawIdat = true;
    } else if (type === "IEND") {
      if (length !== 0) return false;
      lastType = type;
      offset += 12 + length;
      break; // IEND is the terminal chunk; nothing may follow
    }
    lastType = type;
    offset += 12 + length;
  }
  return sawIhdr && sawIdat && lastType === "IEND" && offset === bytes.length;
}

// Minimal well-formedness check for the uiautomator-style XML dump: no NUL
// bytes, tag stack balances, no mismatched/unclosed tags. A hard gate — a
// malformed dump fails closed, it is never coerced into a plausible frame.
export function isWellFormedXml(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.includes(0)) return false;
  const s = bytes.toString("utf8").trim();
  if (!s.startsWith("<")) return false;
  const stack = [];
  const tokenRe = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]+>/g;
  let m;
  while ((m = tokenRe.exec(s)) !== null) {
    const token = m[0];
    if (token.startsWith("<!--") || token.startsWith("<?")) continue;
    if (token.startsWith("<![CDATA[")) continue;
    const selfClose = /\/\s*>$/.test(token);
    const nameMatch = /^<\/?\s*([A-Za-z0-9_.:-]+)/.exec(token);
    if (!nameMatch) return false;
    const name = nameMatch[1];
    if (selfClose) continue;
    if (token.startsWith("</")) {
      const open = stack.pop();
      if (open !== name) return false;
    } else {
      stack.push(name);
    }
  }
  return stack.length === 0;
}

function validateKind(kind, bytes) {
  const limits = M6_EVIDENCE_LIMITS;
  if (kind === "screenshot") {
    if (bytes.length > limits.screenshotBytes) return "M6_EVIDENCE_OVERSIZE";
    if (!isCompletePng(bytes)) return "M6_EVIDENCE_NOT_PNG";
  } else if (kind === "dump") {
    if (bytes.length > limits.dumpBytes) return "M6_EVIDENCE_OVERSIZE";
    if (!isWellFormedXml(bytes)) return "M6_EVIDENCE_DUMP_NOT_XML";
  } else if (kind === "focus") {
    if (bytes.length > limits.focusBytes) return "M6_EVIDENCE_OVERSIZE";
    if (bytes.includes(0)) return "M6_EVIDENCE_FOCUS_NOT_TEXT";
  } else if (kind === "observation") {
    if (bytes.length > limits.observationBytes) return "M6_EVIDENCE_OVERSIZE";
    try {
      JSON.parse(bytes.toString("utf8"));
    } catch {
      return "M6_EVIDENCE_OBSERVATION_NOT_JSON";
    }
  } else {
    return "M6_EVIDENCE_UNKNOWN_KIND";
  }
  return null;
}

export class M6FrameEvidenceStore {
  constructor({ root, minFreeBytes = 128 * 1024 * 1024 } = {}) {
    if (!root) throw new M6EvidenceError("M6_EVIDENCE_ROOT_REQUIRED", "evidence store requires a root");
    this.root = resolve(root);
    this.blobRoot = join(this.root, "blobs");
    this.tombstoneRoot = join(this.root, "tombstones");
    this.minFreeBytes = minFreeBytes;
    mkdirSync(this.blobRoot, { recursive: true });
    mkdirSync(this.tombstoneRoot, { recursive: true });
  }

  freeBytes() {
    const info = statfsSync(this.root);
    return Number(info.bavail) * Number(info.bsize);
  }

  assertCapacity() {
    if (this.freeBytes() < this.minFreeBytes) {
      throw new M6EvidenceError("M6_EVIDENCE_DISK_LOW", "not enough free space for frame evidence", {
        freeBytes: this.freeBytes(),
        requiredBytes: this.minFreeBytes,
      });
    }
  }

  // Blob path derives from the SHA-256 alone — no user input in the address, so
  // there is no injection or escape surface via the id.
  blobPath(sha256) {
    if (!/^[0-9a-f]{64}$/.test(sha256)) {
      throw new M6EvidenceError("M6_EVIDENCE_ID_INVALID", "blob address must be a 64-hex sha256");
    }
    return join(this.blobRoot, sha256);
  }

  parseRef(ref) {
    const id = typeof ref === "string" ? ref : ref?.id;
    const sha256 = typeof ref === "string" ? null : ref?.sha256;
    if (typeof id !== "string") return null;
    const m = /^att-([a-z]+)-([0-9a-f]{64})$/.exec(id);
    if (!m) return null;
    if (sha256 !== null && sha256 !== undefined && sha256 !== m[2]) return null;
    return { kind: m[1], sha256: m[2] };
  }

  // Durable CAS commit of one evidence resource. Identical bytes → the same ref,
  // so concurrent captures of equal content collide safely into one blob.
  commit(kind, bytes) {
    this.assertCapacity();
    const invalid = validateKind(kind, bytes);
    if (invalid) throw new M6EvidenceError(invalid, `evidence kind '${kind}' rejected`);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const target = this.blobPath(sha256);
    if (existsSync(target)) {
      // CAS hit — the address must still name a real regular file and hash
      // correctly; a corrupted or substituted blob is never served as evidence.
      if (!lstatSync(target).isFile()) {
        throw new M6EvidenceError("M6_EVIDENCE_NOT_REGULAR", "evidence address is not a regular file", { id: `att-${kind}-${sha256}` });
      }
      if (this.readFileHash(target) !== sha256) {
        throw new M6EvidenceError("M6_EVIDENCE_TAMPERED", "existing blob no longer matches its address", { id: `att-${kind}-${sha256}` });
      }
      return { id: `att-${kind}-${sha256}`, sha256 };
    }
    // Atomic commit: temp write → fsync → rename. The temp marker makes a
    // crashed write a never-resolvable residue rather than evidence.
    const tmp = `${target}.${process.pid}.tmp`;
    let fd;
    try {
      fd = openSync(tmp, "wx", 0o600);
      writeSync(fd, bytes);
      fsyncSync(fd);
    } catch (error) {
      throw new M6EvidenceError("M6_EVIDENCE_WRITE_FAILED", "evidence blob write/fsync failed", {
        cause: error.code || String(error.message || error),
      });
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    try {
      renameSync(tmp, target);
    } catch (error) {
      try { unlinkSync(tmp); } catch { /* best effort cleanup */ }
      throw new M6EvidenceError("M6_EVIDENCE_COMMIT_FAILED", "evidence blob rename commit failed", {
        cause: error.code || String(error.message || error),
      });
    }
    if (this.readFileHash(target) !== sha256) {
      throw new M6EvidenceError("M6_EVIDENCE_READBACK_MISMATCH", "evidence blob readback hash does not match", { id: `att-${kind}-${sha256}` });
    }
    return { id: `att-${kind}-${sha256}`, sha256 };
  }

  // All-or-nothing frame commit: any evidence failure throws and the caller
  // gets no frame. There is no stub and no debt path.
  commitFrame(evidence) {
    const refs = {};
    for (const key of ["screenshotA", "screenshotB", "dump", "focus", "observation"]) {
      const kind = key === "screenshotA" || key === "screenshotB" ? "screenshot" : key;
      const { id, sha256 } = this.commit(kind, evidence[key]);
      refs[key] = { id, sha256 };
    }
    return refs;
  }

  // Resolve a blob back to bytes, fail-closed on any inconsistency: missing,
  // tampered, escaped (symlink/junction out of root), or kind-mismatched.
  resolve(ref) {
    const parsed = this.parseRef(ref);
    if (!parsed) throw new M6EvidenceError("M6_EVIDENCE_REF_INVALID", "evidence ref is malformed");
    if (!M6_EVIDENCE_KINDS.includes(parsed.kind)) {
      throw new M6EvidenceError("M6_EVIDENCE_UNKNOWN_KIND", "evidence kind is not allowed");
    }
    const path = this.blobPath(parsed.sha256);
    if (!existsSync(path)) {
      throw new M6EvidenceError("M6_EVIDENCE_MISSING", "evidence blob is absent", { id: `att-${parsed.kind}-${parsed.sha256}` });
    }
    // The address must name a real regular file inside the blob root. This
    // rejects Windows junctions and POSIX symlinks pointing out of the root.
    const stat = lstatSync(path);
    if (!stat.isFile()) throw new M6EvidenceError("M6_EVIDENCE_NOT_REGULAR", "evidence address is not a regular file", { id: `att-${parsed.kind}-${parsed.sha256}` });
    if (stat.isSymbolicLink()) throw new M6EvidenceError("M6_EVIDENCE_SYMLINK", "evidence address is a symlink", { id: `att-${parsed.kind}-${parsed.sha256}` });
    const real = realpathSync(path);
    const allowed = `${realpathSync(this.blobRoot)}${process.platform === "win32" ? "\\" : "/"}`;
    if (!real.startsWith(allowed)) {
      throw new M6EvidenceError("M6_EVIDENCE_PATH_ESCAPE", "evidence address escapes the blob root", { id: `att-${parsed.kind}-${parsed.sha256}` });
    }
    const bytes = readFileSync(path);
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== parsed.sha256) {
      throw new M6EvidenceError("M6_EVIDENCE_TAMPERED", "evidence blob hash does not match its address", { id: `att-${parsed.kind}-${parsed.sha256}` });
    }
    return { id: `att-${parsed.kind}-${parsed.sha256}`, sha256: parsed.sha256, bytes };
  }

  // Removal is an explicit tombstone: the blob leaves the active set and a
  // tombstone record keeps the deletion observable for retention.
  tombstone(ref, { removedAtMs = 0 } = {}) {
    const parsed = this.parseRef(ref);
    if (!parsed) throw new M6EvidenceError("M6_EVIDENCE_REF_INVALID", "tombstone requires a valid ref");
    const target = this.blobPath(parsed.sha256);
    if (existsSync(target)) {
      renameSync(target, join(this.tombstoneRoot, parsed.sha256));
    }
    writeFileSync(
      join(this.tombstoneRoot, `${parsed.sha256}.json`),
      `${JSON.stringify({ id: `att-${parsed.kind}-${parsed.sha256}`, sha256: parsed.sha256, removedAtMs })}\n`,
      { mode: 0o600 },
    );
  }

  sweepCrashResidue() {
    // A `.tmp` marker in the blob root is a write-crash residue: never
    // resolvable as evidence. Remove it on open/maintenance.
    let removed = 0;
    for (const name of readdirSync(this.blobRoot)) {
      if (name.endsWith(".tmp")) {
        try { unlinkSync(join(this.blobRoot, name)); removed += 1; } catch { /* best effort */ }
      }
    }
    return removed;
  }

  purgeExpired({ retentionMs, nowMs }) {
    if (retentionMs === undefined || nowMs === undefined) return 0;
    let purged = 0;
    for (const name of readdirSync(this.tombstoneRoot)) {
      if (!name.endsWith(".json")) continue;
      let record;
      try {
        record = JSON.parse(readFileSync(join(this.tombstoneRoot, name), "utf8"));
      } catch {
        continue;
      }
      if (record.removedAtMs && nowMs - record.removedAtMs >= retentionMs) {
        try { unlinkSync(join(this.tombstoneRoot, name)); } catch { /* best effort */ }
        try { unlinkSync(join(this.tombstoneRoot, record.sha256)); } catch { /* best effort */ }
        purged += 1;
      }
    }
    return purged;
  }

  readFileHash(target) {
    return createHash("sha256").update(readFileSync(target)).digest("hex");
  }
}
