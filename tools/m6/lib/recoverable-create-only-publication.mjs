import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const WINDOWS_DIRECTORY_FSYNC_UNSUPPORTED = new Set([
  "EACCES", "EBADF", "EINVAL", "EISDIR", "ENOTSUP", "EPERM",
]);

export const RECOVERABLE_PUBLICATION_CUTS = Object.freeze([
  "PENDING_CREATED",
  "PENDING_MID_WRITE",
  "PENDING_WRITTEN",
  "PENDING_FSYNCED",
  "FINAL_PUBLISHED",
  "PENDING_UNLINKED",
  "DIRECTORY_FSYNCED",
]);

export class RecoverablePublicationError extends Error {
  constructor(reason, message, cause = null) {
    super(message, cause ? { cause } : undefined);
    this.name = "RecoverablePublicationError";
    this.code = "M6_RECOVERABLE_PUBLICATION_FAILED";
    this.reason = reason;
    this.causeCode = cause?.code ?? null;
  }
}

class InjectedPublicationFault extends Error {
  constructor(cause) {
    super("publication fault injected", { cause });
    this.injectedCause = cause;
  }
}

function fail(reason, message, cause = null) {
  throw new RecoverablePublicationError(reason, message, cause);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedPath(value) {
  const path = resolve(value);
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function sameFile(left, right) {
  return String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino);
}

function sameIdentity(left, right) {
  return sameFile(left, right)
    && String(left.mode) === String(right.mode)
    && String(left.nlink) === String(right.nlink)
    && String(left.size) === String(right.size)
    && String(left.mtimeNs ?? left.mtimeMs) === String(right.mtimeNs ?? right.mtimeMs);
}

function assertPlainParent(target) {
  const parent = dirname(target);
  let stat;
  let real;
  try {
    stat = lstatSync(parent, { bigint: true });
    real = realpathSync(parent);
  } catch (cause) {
    fail("PARENT_UNAVAILABLE", "publication parent directory is unavailable", cause);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || normalizedPath(real) !== normalizedPath(parent)) {
    fail("PARENT_UNSAFE", "publication parent must be one plain directory without reparse traversal");
  }
  return parent;
}

function readEntry(path, label, { maxBytes, allowMissing = false } = {}) {
  const target = resolve(path);
  let before;
  try {
    before = lstatSync(target, { bigint: true });
  } catch (cause) {
    if (allowMissing && cause?.code === "ENOENT") return null;
    fail(`${label}_UNAVAILABLE`, `${label.toLowerCase()} is unavailable`, cause);
  }
  if (!before.isFile() || before.isSymbolicLink()
    || before.nlink < 1n || before.nlink > 2n
    || before.size < 0n || before.size > BigInt(maxBytes)) {
    fail(`${label}_UNSAFE`, `${label.toLowerCase()} must be one bounded plain file with at most the recoverable two links`);
  }
  try {
    if (normalizedPath(realpathSync(target)) !== normalizedPath(target)) {
      fail(`${label}_UNSAFE`, `${label.toLowerCase()} must not be a symlink or reparse target`);
    }
  } catch (cause) {
    if (cause instanceof RecoverablePublicationError) throw cause;
    fail(`${label}_UNAVAILABLE`, `${label.toLowerCase()} real path is unavailable`, cause);
  }
  let descriptor;
  try {
    descriptor = openSync(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const opened = fstatSync(descriptor, { bigint: true });
    const bytes = readFileSync(descriptor);
    const afterDescriptor = fstatSync(descriptor, { bigint: true });
    const afterPath = lstatSync(target, { bigint: true });
    if (!sameIdentity(before, opened) || !sameIdentity(opened, afterDescriptor)
      || !sameIdentity(afterDescriptor, afterPath)
      || afterPath.isSymbolicLink() || afterPath.size !== BigInt(bytes.length)) {
      fail(`${label}_RACE`, `${label.toLowerCase()} changed while it was read`);
    }
    return Object.freeze({ bytes, identity: afterPath, path: target });
  } catch (cause) {
    if (cause instanceof RecoverablePublicationError) throw cause;
    fail(`${label}_UNAVAILABLE`, `${label.toLowerCase()} could not be opened or read`, cause);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function unlinkExact(entry, label, maxBytes) {
  const current = readEntry(entry.path, label, { maxBytes });
  if (!sameIdentity(entry.identity, current.identity)) {
    fail(`${label}_RACE`, `${label.toLowerCase()} changed before unlink`);
  }
  try { unlinkSync(entry.path); } catch (cause) {
    fail(`${label}_UNLINK_FAILED`, `${label.toLowerCase()} could not be unlinked`, cause);
  }
}

function syncFile(entry, label, maxBytes) {
  const current = readEntry(entry.path, label, { maxBytes });
  if (!sameIdentity(entry.identity, current.identity)) {
    fail(`${label}_RACE`, `${label.toLowerCase()} changed before file fsync`);
  }
  let descriptor;
  try {
    // Windows rejects fsync on a read-only file handle. O_RDWR is used only to
    // obtain a flush-capable handle; this function never writes through it.
    descriptor = openSync(entry.path, fsConstants.O_RDWR | (fsConstants.O_NOFOLLOW || 0));
    const opened = fstatSync(descriptor, { bigint: true });
    if (!sameIdentity(current.identity, opened)) {
      fail(`${label}_RACE`, `${label.toLowerCase()} changed before file fsync`);
    }
    fsyncSync(descriptor);
  } catch (cause) {
    if (cause instanceof RecoverablePublicationError) throw cause;
    fail("FILE_FSYNC_FAILED", `${label.toLowerCase()} fsync failed`, cause);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function syncDirectory(parent) {
  let descriptor;
  try {
    descriptor = openSync(parent, fsConstants.O_RDONLY);
    fsyncSync(descriptor);
  } catch (cause) {
    if (!(process.platform === "win32" && WINDOWS_DIRECTORY_FSYNC_UNSUPPORTED.has(cause?.code))) {
      fail("DIRECTORY_FSYNC_FAILED", "publication parent directory fsync failed", cause);
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function invokeFault(faultAfter, point, context) {
  try { faultAfter(point, context); } catch (cause) {
    throw new InjectedPublicationFault(cause);
  }
}

export function recoverablePublicationPendingPath(targetPath, bytes) {
  if (typeof targetPath !== "string" || !isAbsolute(targetPath) || !Buffer.isBuffer(bytes)) {
    fail("INPUT_INVALID", "recoverable publication requires an absolute target and Buffer bytes");
  }
  const target = resolve(targetPath);
  const address = sha256(`xw.m6-recoverable-publication.v1\0${normalizedPath(target)}\0${sha256(bytes)}`);
  return join(dirname(target), `.m6-publish-${address}.pending`);
}

export function inspectRecoverableCreateOnlyPublication({
  targetPath,
  bytes,
  maxBytes = DEFAULT_MAX_BYTES,
} = {}) {
  if (typeof targetPath !== "string" || !isAbsolute(targetPath)
    || !Buffer.isBuffer(bytes) || bytes.length < 1
    || !Number.isSafeInteger(maxBytes) || maxBytes < bytes.length) {
    fail("INPUT_INVALID", "recoverable publication inspection inputs are invalid");
  }
  const target = resolve(targetPath);
  assertPlainParent(target);
  const pendingPath = recoverablePublicationPendingPath(target, bytes);
  const final = readEntry(target, "TARGET", { maxBytes, allowMissing: true });
  const pending = readEntry(pendingPath, "PENDING", { maxBytes, allowMissing: true });
  if (pending && pending.identity.nlink !== 1n && pending.identity.nlink !== 2n) {
    fail("PENDING_EXTERNAL_HARDLINK", "deterministic pending file has an unsupported link count");
  }
  if (!final) {
    if (pending?.identity.nlink === 2n) {
      fail("PENDING_EXTERNAL_HARDLINK", "pending publication has a second link without the deterministic final path");
    }
    return Object.freeze({
      exactFinal: false,
      finalLinkCount: 0,
      needsRecovery: Boolean(pending),
      pending: pending ? (pending.bytes.equals(bytes) ? "EXACT" : "PARTIAL") : "ABSENT",
      recoverable: true,
      pendingPath,
      targetPath: target,
    });
  }
  if (!final.bytes.equals(bytes)) {
    fail("TARGET_DIFFERENT", "existing final publication contains different bytes");
  }
  if (final.identity.nlink === 2n) {
    if (!pending || pending.identity.nlink !== 2n
      || !sameFile(final.identity, pending.identity) || !pending.bytes.equals(bytes)) {
      fail("TARGET_EXTERNAL_HARDLINK", "two-link final publication is not paired with its deterministic pending file");
    }
  } else if (final.identity.nlink === 1n) {
    if (pending && pending.identity.nlink !== 1n) {
      fail("PENDING_EXTERNAL_HARDLINK", "detached pending file has an external hard link");
    }
  } else {
    fail("TARGET_EXTERNAL_HARDLINK", "final publication has an unsupported link count");
  }
  return Object.freeze({
    exactFinal: true,
    finalLinkCount: Number(final.identity.nlink),
    needsRecovery: final.identity.nlink !== 1n || Boolean(pending),
    pending: pending ? (pending.bytes.equals(bytes) ? "EXACT" : "PARTIAL") : "ABSENT",
    recoverable: true,
    pendingPath,
    targetPath: target,
  });
}

function recoverExistingFinal({ target, pendingPath, expectedBytes, maxBytes, recovered }) {
  const final = readEntry(target, "TARGET", { maxBytes });
  if (!final.bytes.equals(expectedBytes)) {
    fail("TARGET_DIFFERENT", "existing final publication contains different bytes");
  }
  const pending = readEntry(pendingPath, "PENDING", { maxBytes, allowMissing: true });
  if (final.identity.nlink === 2n) {
    if (!pending || pending.identity.nlink !== 2n
      || !sameFile(final.identity, pending.identity)
      || !pending.bytes.equals(expectedBytes)) {
      fail("TARGET_EXTERNAL_HARDLINK", "two-link final publication is not paired with its exact deterministic pending file");
    }
    unlinkExact(pending, "PENDING", maxBytes);
    recovered.push("FINAL_PUBLISHED_PENDING_LINKED");
  } else if (final.identity.nlink === 1n) {
    if (pending) {
      if (pending.identity.nlink !== 1n) {
        fail("PENDING_EXTERNAL_HARDLINK", "detached deterministic pending file has an external hard link");
      }
      unlinkExact(pending, "PENDING", maxBytes);
      recovered.push(pending.bytes.equals(expectedBytes) ? "DETACHED_EXACT_PENDING" : "DETACHED_PARTIAL_PENDING");
    }
  } else {
    fail("TARGET_EXTERNAL_HARDLINK", "final publication has an unsupported link count");
  }
  const stable = readEntry(target, "TARGET", { maxBytes });
  if (stable.identity.nlink !== 1n || !stable.bytes.equals(expectedBytes)) {
    fail("TARGET_VERIFY_FAILED", "recovered final publication is not one exact single-link file");
  }
  syncFile(stable, "TARGET", maxBytes);
  syncDirectory(dirname(target));
  return Object.freeze({
    status: "REPLAYED",
    created: false,
    replay: true,
    recovered: Object.freeze([...recovered]),
    pendingPath,
    sha256: sha256(expectedBytes),
    targetPath: target,
  });
}

export function publishRecoverableCreateOnly({
  targetPath,
  bytes,
  maxBytes = DEFAULT_MAX_BYTES,
  faultAfter = () => {},
} = {}) {
  if (typeof targetPath !== "string" || !isAbsolute(targetPath)
    || !Buffer.isBuffer(bytes) || bytes.length < 1
    || !Number.isSafeInteger(maxBytes) || maxBytes < bytes.length
    || typeof faultAfter !== "function") {
    fail("INPUT_INVALID", "recoverable publication inputs are invalid");
  }
  const target = resolve(targetPath);
  const parent = assertPlainParent(target);
  const pendingPath = recoverablePublicationPendingPath(target, bytes);
  const context = Object.freeze({ pendingPath, targetPath: target });
  const recovered = [];
  const initialFinal = readEntry(target, "TARGET", { maxBytes, allowMissing: true });
  if (initialFinal) {
    return recoverExistingFinal({ target, pendingPath, expectedBytes: bytes, maxBytes, recovered });
  }

  let pending = readEntry(pendingPath, "PENDING", { maxBytes, allowMissing: true });
  if (pending && pending.identity.nlink !== 1n) {
    fail("PENDING_EXTERNAL_HARDLINK", "deterministic pending file has an external hard link");
  }
  if (pending && !pending.bytes.equals(bytes)) {
    unlinkExact(pending, "PENDING", maxBytes);
    syncDirectory(parent);
    recovered.push("PARTIAL_PENDING");
    pending = null;
  } else if (pending) {
    // A crash can leave exact bytes after PENDING_WRITTEN but before the
    // original descriptor fsync. Re-flush every recovered exact pending inode
    // before it is eligible to become the final create-only hard link.
    syncFile(pending, "PENDING", maxBytes);
    recovered.push("EXACT_PENDING_REFLUSHED");
  }

  if (!pending) {
    let descriptor;
    try {
      descriptor = openSync(pendingPath, "wx", 0o600);
      invokeFault(faultAfter, "PENDING_CREATED", context);
      const midpoint = Math.max(1, Math.floor(bytes.length / 2));
      writeFileSync(descriptor, bytes.subarray(0, midpoint));
      invokeFault(faultAfter, "PENDING_MID_WRITE", context);
      writeFileSync(descriptor, bytes.subarray(midpoint));
      invokeFault(faultAfter, "PENDING_WRITTEN", context);
      fsyncSync(descriptor);
      invokeFault(faultAfter, "PENDING_FSYNCED", context);
    } catch (cause) {
      if (cause instanceof InjectedPublicationFault) throw cause.injectedCause;
      fail("PENDING_WRITE_FAILED", "pending publication write or fsync failed", cause);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
    pending = readEntry(pendingPath, "PENDING", { maxBytes });
    if (pending.identity.nlink !== 1n || !pending.bytes.equals(bytes)) {
      fail("PENDING_VERIFY_FAILED", "pending publication failed exact read-back");
    }
  }

  try {
    linkSync(pendingPath, target);
  } catch (cause) {
    if (cause?.code === "EEXIST") {
      return recoverExistingFinal({ target, pendingPath, expectedBytes: bytes, maxBytes, recovered });
    }
    fail("FINAL_PUBLISH_FAILED", "create-only final hard-link publication failed", cause);
  }
  try {
    invokeFault(faultAfter, "FINAL_PUBLISHED", context);
  } catch (cause) {
    if (cause instanceof InjectedPublicationFault) throw cause.injectedCause;
    throw cause;
  }
  const linkedFinal = readEntry(target, "TARGET", { maxBytes });
  const linkedPending = readEntry(pendingPath, "PENDING", { maxBytes });
  if (linkedFinal.identity.nlink !== 2n || linkedPending.identity.nlink !== 2n
    || !sameFile(linkedFinal.identity, linkedPending.identity)
    || !linkedFinal.bytes.equals(bytes) || !linkedPending.bytes.equals(bytes)) {
    fail("FINAL_VERIFY_FAILED", "published final is not the exact pending inode pair");
  }
  unlinkExact(linkedPending, "PENDING", maxBytes);
  try {
    invokeFault(faultAfter, "PENDING_UNLINKED", context);
  } catch (cause) {
    if (cause instanceof InjectedPublicationFault) throw cause.injectedCause;
    throw cause;
  }
  const final = readEntry(target, "TARGET", { maxBytes });
  if (final.identity.nlink !== 1n || !final.bytes.equals(bytes)) {
    fail("FINAL_VERIFY_FAILED", "final publication failed exact single-link read-back");
  }
  syncFile(final, "TARGET", maxBytes);
  syncDirectory(parent);
  try {
    invokeFault(faultAfter, "DIRECTORY_FSYNCED", context);
  } catch (cause) {
    if (cause instanceof InjectedPublicationFault) throw cause.injectedCause;
    throw cause;
  }
  return Object.freeze({
    status: "CREATED",
    created: true,
    replay: false,
    recovered: Object.freeze([...recovered]),
    pendingPath,
    sha256: sha256(bytes),
    targetPath: target,
  });
}

export function recoverPublishedCreateOnlyBytes({
  targetPath,
  maxBytes = DEFAULT_MAX_BYTES,
} = {}) {
  if (typeof targetPath !== "string" || !isAbsolute(targetPath)
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    fail("INPUT_INVALID", "recoverable publication read inputs are invalid");
  }
  const target = resolve(targetPath);
  assertPlainParent(target);
  const existing = readEntry(target, "TARGET", { maxBytes });
  const publication = publishRecoverableCreateOnly({
    targetPath: target,
    bytes: existing.bytes,
    maxBytes,
  });
  const stable = readEntry(target, "TARGET", { maxBytes });
  if (stable.identity.nlink !== 1n || !stable.bytes.equals(existing.bytes)) {
    fail("TARGET_VERIFY_FAILED", "recovered publication read did not finish as one exact final file");
  }
  return Object.freeze({ bytes: stable.bytes, publication });
}
