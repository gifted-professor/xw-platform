import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acquireM6C1RuntimeOwnerLock,
  acquireM6C1StoppedRuntimeGuard,
  m6C1RuntimeOwnerLockPath,
} from "../control-plane/lib/m6-c1-runtime-owner-lock.mjs";

function runtimeRoot() {
  const root = mkdtempSync(join(tmpdir(), "m6-final-owner-lock-"));
  mkdirSync(join(root, "state", "control-plane"), { recursive: true });
  return root;
}

test("M6-C1 runtime owner lock is create-only, process-held, and exactly released", () => {
  const root = runtimeRoot();
  try {
    const owner = acquireM6C1RuntimeOwnerLock({
      runtimeRoot: root,
      ownerKind: "CONTROL_PLANE_M6_C1",
      ownerNonce: "control-plane-owner-nonce-0001",
      nowMs: 1_900_000_000_000,
    });
    assert.equal(owner.assertOwned(), true);
    assert.equal(existsSync(owner.lockPath), true);
    assert.throws(() => acquireM6C1RuntimeOwnerLock({
      runtimeRoot: root,
      ownerKind: "STAGE_LIVE_WINDOW",
      ownerNonce: "stage-owner-nonce-000000001",
      nowMs: 1_900_000_000_001,
    }), { code: "M6_C1_RUNTIME_OWNER_LOCKED" });
    assert.equal(owner.release(), true);
    assert.equal(existsSync(owner.lockPath), false);
    assert.throws(() => owner.assertOwned(), { code: "M6_C1_RUNTIME_OWNER_AUTHORITY_INVALID" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stale owner lock is never guessed away", () => {
  const root = runtimeRoot();
  try {
    const path = m6C1RuntimeOwnerLockPath(root);
    writeFileSync(path, '{"schemaId":"stale-crash-lock"}\n', "utf8");
    assert.throws(() => acquireM6C1RuntimeOwnerLock({
      runtimeRoot: root,
      ownerKind: "CONTROL_PLANE_M6_C1",
      ownerNonce: "control-plane-owner-nonce-0002",
    }), { code: "M6_C1_RUNTIME_OWNER_LOCKED" });
    assert.equal(existsSync(path), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("qualification bootstrap stopped guard shares the same owner lock", async () => {
  const root = runtimeRoot();
  let guard;
  try {
    guard = await acquireM6C1StoppedRuntimeGuard({
      runtimeRoot: root,
      ownerKind: "QUALIFICATION_BOOTSTRAP",
      port: 0,
    });
    assert.equal(guard.schemaId, "xw.m6-c1-stopped-runtime-guard.v1");
    assert.equal(guard.owner.schemaId, "xw.m6-c1-runtime-owner-authority.v1");
    assert.equal(guard.assertOwned(), true);
    assert.throws(() => acquireM6C1RuntimeOwnerLock({
      runtimeRoot: root,
      ownerKind: "CONTROL_PLANE_M6_C1",
      ownerNonce: "control-plane-owner-nonce-0003",
    }), { code: "M6_C1_RUNTIME_OWNER_LOCKED" });
    await guard.release();
    guard = null;
    assert.equal(existsSync(m6C1RuntimeOwnerLockPath(root)), false);
  } finally {
    if (guard) await guard.release();
    rmSync(root, { recursive: true, force: true });
  }
});

test("stopped guard can close its listener while retaining an audited stale lock", async () => {
  const root = runtimeRoot();
  let guard;
  try {
    guard = await acquireM6C1StoppedRuntimeGuard({
      runtimeRoot: root,
      ownerKind: "QUALIFICATION_BOOTSTRAP",
      port: 0,
    });
    assert.equal(await guard.retainStaleLock(), true);
    assert.equal(existsSync(m6C1RuntimeOwnerLockPath(root)), true);
    assert.throws(() => guard.assertOwned(), { code: "M6_C1_RUNTIME_OWNER_AUTHORITY_INVALID" });
    assert.throws(() => acquireM6C1RuntimeOwnerLock({
      runtimeRoot: root,
      ownerKind: "CONTROL_PLANE_M6_C1",
      ownerNonce: "control-plane-owner-nonce-0004",
    }), { code: "M6_C1_RUNTIME_OWNER_LOCKED" });
    guard = null;
  } finally {
    if (guard) await guard.retainStaleLock();
    rmSync(root, { recursive: true, force: true });
  }
});

test("owner lock identity drift fails closed and retains the replacement", () => {
  const root = runtimeRoot();
  try {
    const owner = acquireM6C1RuntimeOwnerLock({
      runtimeRoot: root,
      ownerKind: "STAGE_LIVE_WINDOW",
      ownerNonce: "stage-owner-nonce-000000002",
    });
    const moved = `${owner.lockPath}.moved`;
    renameSync(owner.lockPath, moved);
    writeFileSync(owner.lockPath, '{"schemaId":"foreign-lock"}\n', "utf8");
    assert.throws(() => owner.assertOwned(), { code: "M6_C1_RUNTIME_OWNER_LOCK_DRIFT" });
    assert.throws(() => owner.release(), { code: "M6_C1_RUNTIME_OWNER_LOCK_DRIFT" });
    assert.equal(existsSync(owner.lockPath), true);
    assert.equal(existsSync(moved), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("owner lock rejects a symlink or junction ancestor", (t) => {
  const root = mkdtempSync(join(tmpdir(), "m6-final-owner-link-"));
  const outside = runtimeRoot();
  try {
    mkdirSync(join(root, "state"), { recursive: true });
    const target = join(root, "state", "control-plane");
    try {
      symlinkSync(join(outside, "state", "control-plane"), target, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (process.platform === "win32" && error?.code === "EPERM") {
        t.skip("Windows symlink privilege is unavailable");
        return;
      }
      throw error;
    }
    assert.throws(() => acquireM6C1RuntimeOwnerLock({
      runtimeRoot: root,
      ownerKind: "STAGE_LIVE_WINDOW",
      ownerNonce: "stage-owner-nonce-000000003",
    }), { code: "M6_C1_RUNTIME_OWNER_ROOT_REPARSE" });
    assert.equal(existsSync(m6C1RuntimeOwnerLockPath(root)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
