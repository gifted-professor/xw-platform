import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";

import { ControlPlaneError } from "./errors.mjs";

export const M6_C1_RUNTIME_OWNER_LOCK_FILE = ".m6-c1-runtime-owner.lock";
const OWNER_KINDS = new Set([
  "CONTROL_PLANE_M6_C1",
  "STAGE_LIVE_WINDOW",
  "QUALIFICATION_BOOTSTRAP",
  "QUALIFICATION_ROTATION",
]);
const HELD_LOCKS = new WeakSet();

function fail(code, message, details = {}) {
  throw new ControlPlaneError(code, message, { status: 503, details });
}

function normalizedPath(value) {
  const path = resolve(value);
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function sameIdentity(left, right) {
  return String(left.dev) === String(right.dev)
    && String(left.ino) === String(right.ino)
    && String(left.mode) === String(right.mode)
    && String(left.nlink) === String(right.nlink)
    && String(left.size) === String(right.size)
    && String(left.mtimeNs ?? left.mtimeMs) === String(right.mtimeNs ?? right.mtimeMs);
}

function assertPlainDirectory(path, label) {
  const target = resolve(path);
  let stat;
  let real;
  try {
    stat = lstatSync(target);
    real = realpathSync(target);
  } catch (cause) {
    fail("M6_C1_RUNTIME_OWNER_ROOT_UNAVAILABLE", `${label} is unavailable`, { cause: cause?.code ?? null });
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || normalizedPath(real) !== normalizedPath(target)) {
    fail("M6_C1_RUNTIME_OWNER_ROOT_REPARSE", `${label} must be a plain directory without symlink or junction traversal`);
  }
  return target;
}

function assertPlainAncestors(path) {
  const target = resolve(path);
  const volumeRoot = parse(target).root;
  let cursor = dirname(target);
  while (cursor && cursor !== volumeRoot) {
    assertPlainDirectory(cursor, "M6-C1 runtime owner-lock ancestor");
    const next = dirname(cursor);
    if (next === cursor) break;
    cursor = next;
  }
}

function syncDirectory(path) {
  let fd;
  try {
    fd = openSync(path, fsConstants.O_RDONLY);
    fsyncSync(fd);
  } catch (cause) {
    if (process.platform !== "win32") {
      fail("M6_C1_RUNTIME_OWNER_LOCK_FSYNC_FAILED", "owner-lock directory fsync failed", { cause: cause?.code ?? null });
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function m6C1RuntimeOwnerLockPath(runtimeRoot) {
  if (typeof runtimeRoot !== "string" || !isAbsolute(runtimeRoot)) {
    fail("M6_C1_RUNTIME_OWNER_ROOT_INVALID", "M6-C1 runtime owner lock requires an absolute runtime root");
  }
  return join(resolve(runtimeRoot), "state", "control-plane", M6_C1_RUNTIME_OWNER_LOCK_FILE);
}

export function m6C1ControlDbPath(runtimeRoot) {
  if (typeof runtimeRoot !== "string" || !isAbsolute(runtimeRoot)) {
    fail("M6_C1_RUNTIME_OWNER_ROOT_INVALID", "M6-C1 control DB identity requires an absolute runtime root");
  }
  return join(resolve(runtimeRoot), "state", "control-plane", "control.db");
}

export function assertM6C1ControlDbIdentity({
  runtimeRoot,
  controlDbPath,
  allowMissing = false,
} = {}) {
  const expectedPath = m6C1ControlDbPath(runtimeRoot);
  if (typeof controlDbPath !== "string" || !isAbsolute(controlDbPath)
    || normalizedPath(controlDbPath) !== normalizedPath(expectedPath)) {
    fail("M6_C1_CONTROL_DB_IDENTITY_INVALID", "M6-C1 control DB must use the canonical runtime-root path");
  }
  assertPlainAncestors(expectedPath);
  const parent = assertPlainDirectory(dirname(expectedPath), "M6-C1 control DB parent");
  let identity;
  let real;
  try {
    identity = lstatSync(expectedPath, { bigint: true });
    real = realpathSync(expectedPath);
  } catch (cause) {
    if (allowMissing && cause?.code === "ENOENT") {
      return Object.freeze({ exists: false, path: expectedPath, parent });
    }
    fail("M6_C1_CONTROL_DB_IDENTITY_INVALID", "M6-C1 control DB is unavailable", {
      cause: cause?.code ?? null,
    });
  }
  if (!identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1n
    || normalizedPath(real) !== normalizedPath(expectedPath)) {
    fail(
      "M6_C1_CONTROL_DB_IDENTITY_INVALID",
      "M6-C1 control DB must be one plain single-link file without path aliasing",
    );
  }
  return Object.freeze({
    exists: true,
    path: expectedPath,
    parent,
    dev: String(identity.dev),
    ino: String(identity.ino),
    size: String(identity.size),
  });
}

export function acquireM6C1RuntimeOwnerLock({
  runtimeRoot,
  ownerKind,
  ownerNonce = randomUUID(),
  pid = process.pid,
  nowMs = Date.now(),
} = {}) {
  if (!OWNER_KINDS.has(ownerKind)
    || typeof ownerNonce !== "string" || !/^[A-Za-z0-9._:-]{16,200}$/u.test(ownerNonce)
    || !Number.isSafeInteger(pid) || pid < 1 || !Number.isFinite(nowMs)) {
    fail("M6_C1_RUNTIME_OWNER_INPUT_INVALID", "M6-C1 runtime owner identity is invalid");
  }
  const lockPath = m6C1RuntimeOwnerLockPath(runtimeRoot);
  assertPlainAncestors(lockPath);
  const parent = assertPlainDirectory(dirname(lockPath), "M6-C1 runtime control-plane state root");
  let fd;
  let identity;
  try {
    fd = openSync(lockPath, "wx", 0o600);
    const record = Object.freeze({
      schemaId: "xw.m6-c1-runtime-owner-lock.v1",
      ownerKind,
      ownerNonce,
      pid,
      acquiredAt: new Date(nowMs).toISOString(),
      secretMaterialPresent: false,
    });
    writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    fsyncSync(fd);
    identity = fstatSync(fd, { bigint: true });
    if (!identity.isFile() || identity.nlink !== 1n) {
      fail("M6_C1_RUNTIME_OWNER_LOCK_IDENTITY_INVALID", "new M6-C1 runtime owner lock is not one single-link file");
    }
    syncDirectory(parent);
  } catch (cause) {
    try { if (fd !== undefined) closeSync(fd); } catch {}
    if (cause instanceof ControlPlaneError) throw cause;
    fail(
      cause?.code === "EEXIST" ? "M6_C1_RUNTIME_OWNER_LOCKED" : "M6_C1_RUNTIME_OWNER_LOCK_FAILED",
      cause?.code === "EEXIST"
        ? "M6-C1 runtime is already owned or a stale crash lock requires audited recovery"
        : "M6-C1 runtime owner lock could not be acquired",
      { cause: cause?.code ?? null },
    );
  }
  let released = false;
  const authority = Object.freeze({
    schemaId: "xw.m6-c1-runtime-owner-authority.v1",
    ownerKind,
    ownerNonce,
    lockPath,
    assertOwned() {
      if (released || !HELD_LOCKS.has(authority)) {
        fail("M6_C1_RUNTIME_OWNER_AUTHORITY_INVALID", "M6-C1 runtime owner authority is not held");
      }
      let pathIdentity;
      let descriptorIdentity;
      try {
        pathIdentity = lstatSync(lockPath, { bigint: true });
        descriptorIdentity = fstatSync(fd, { bigint: true });
      } catch (cause) {
        fail("M6_C1_RUNTIME_OWNER_LOCK_DRIFT", "M6-C1 runtime owner lock disappeared while held", { cause: cause?.code ?? null });
      }
      if (!sameIdentity(identity, descriptorIdentity) || !sameIdentity(descriptorIdentity, pathIdentity)
        || pathIdentity.isSymbolicLink() || pathIdentity.nlink !== 1n
        || normalizedPath(realpathSync(lockPath)) !== normalizedPath(lockPath)) {
        fail("M6_C1_RUNTIME_OWNER_LOCK_DRIFT", "M6-C1 runtime owner lock identity changed while held");
      }
      return true;
    },
    release() {
      authority.assertOwned();
      released = true;
      HELD_LOCKS.delete(authority);
      closeSync(fd);
      unlinkSync(lockPath);
      syncDirectory(parent);
      return true;
    },
    retainStaleLock() {
      authority.assertOwned();
      // Cleanup was not proven, so close this process's descriptor but leave
      // the create-only path in place. A later owner must use the explicit
      // audited-recovery procedure; it may never guess this lock away.
      closeSync(fd);
      released = true;
      HELD_LOCKS.delete(authority);
      syncDirectory(parent);
      return true;
    },
  });
  HELD_LOCKS.add(authority);
  return authority;
}

export function isM6C1RuntimeOwnerAuthority(value) {
  return Boolean(value && HELD_LOCKS.has(value));
}

export async function acquireM6C1StoppedRuntimeGuard({
  runtimeRoot,
  ownerKind,
  host = "127.0.0.1",
  port = 17920,
} = {}) {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen({ host, port, exclusive: true }, resolveListen);
  }).catch((cause) => {
    try { server.close(); } catch {}
    fail("M6_C1_RUNTIME_NOT_STOPPED", "M6-C1 mutation requires exclusive ownership of the control-plane loopback port", {
      cause: cause?.code ?? null,
    });
  });
  let owner;
  try {
    owner = acquireM6C1RuntimeOwnerLock({ runtimeRoot, ownerKind });
  } catch (cause) {
    await new Promise((resolveClose) => server.close(resolveClose));
    throw cause;
  }
  return Object.freeze({
    schemaId: "xw.m6-c1-stopped-runtime-guard.v1",
    owner,
    assertOwned() {
      return owner.assertOwned();
    },
    async release() {
      await new Promise((resolveClose) => server.close(resolveClose));
      owner.assertOwned();
      owner.release();
    },
    async retainStaleLock() {
      await new Promise((resolveClose, rejectClose) => server.close((error) => (
        error ? rejectClose(error) : resolveClose()
      )));
      owner.assertOwned();
      return owner.retainStaleLock();
    },
  });
}
