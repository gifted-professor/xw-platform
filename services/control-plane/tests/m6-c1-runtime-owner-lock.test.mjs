import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { createServer } from "node:net";
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

function windowsGuardHelperPids() {
  const root = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  const executable = join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const program = String.raw`
$parent = [int64]$env:XW_TEST_PARENT_PID
$self = [int64][Diagnostics.Process]::GetCurrentProcess().Id
$rows = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
    [int64]$_.ParentProcessId -eq $parent -and
    [int64]$_.ProcessId -ne $self -and
    [string]$_.Name -ieq "powershell.exe" -and
    [string]$_.CommandLine -like "*XW_M6_GUARD_ENDPOINTS*"
} | ForEach-Object { [int64]$_.ProcessId })
[ordered]@{ pids = [object[]]$rows } | ConvertTo-Json -Compress
`;
  const output = execFileSync(executable, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", program,
  ], {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
    env: Object.fromEntries(Object.entries({
      SystemRoot: root,
      WINDIR: root,
      ComSpec: process.env.ComSpec || join(root, "System32", "cmd.exe"),
      XW_TEST_PARENT_PID: String(process.pid),
    }).filter(([, value]) => typeof value === "string" && value !== "")),
  });
  return JSON.parse(output).pids;
}

function listenHost(server, host, port) {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (error) => rejectListen(error);
    server.once("error", onError);
    server.listen({ host, port, exclusive: true }, () => {
      server.off("error", onError);
      resolveListen(server.address().port);
    });
  });
}

function listen(server, port) {
  return listenHost(server, "127.0.0.1", port);
}

function close(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolveClose) => server.close(() => resolveClose()));
}

let portFixtureSequence = 0;

async function unusedPorts(count) {
  const reservations = [];
  try {
    let candidate = 20_000 + ((process.pid * 17) % 10_000) + (portFixtureSequence * 16);
    portFixtureSequence += 1;
    while (reservations.length < count && candidate < 45_000) {
      const server = createServer();
      try {
        const port = await listen(server, candidate);
        reservations.push({ port, server });
      } catch {
        await close(server);
      }
      candidate += 1;
    }
    assert.equal(reservations.length, count, "could not reserve bounded non-ephemeral fixture ports");
    return reservations.map((row) => row.port);
  } finally {
    await Promise.all(reservations.map((row) => close(row.server)));
  }
}

async function assertPortIsExclusive(port) {
  const probe = createServer();
  try {
    await assert.rejects(
      listen(probe, port),
      (error) => ["EADDRINUSE", "EACCES"].includes(error?.code),
    );
  } finally {
    await close(probe);
  }
}

async function assertHostIsExclusive(host, port) {
  const probe = createServer();
  try {
    await assert.rejects(
      listenHost(probe, host, port),
      (error) => ["EADDRINUSE", "EACCES"].includes(error?.code),
    );
  } finally {
    await close(probe);
  }
}

async function assertPortIsBindable(port) {
  const probe = createServer();
  try {
    assert.equal(await listen(probe, port), port);
  } finally {
    await close(probe);
  }
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
    assert.equal(await guard.assertOwned(), true);
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

test("stopped guard owns every requested fixed port exclusively and releases all of them", async () => {
  const root = runtimeRoot();
  const [firstPort, secondPort] = await unusedPorts(2);
  let guard;
  try {
    guard = await acquireM6C1StoppedRuntimeGuard({
      runtimeRoot: root,
      ownerKind: "QUALIFICATION_LEGACY_WINDOW",
      ports: [firstPort, secondPort],
    });
    assert.equal(await guard.assertOwned(), true);
    await assertPortIsExclusive(firstPort);
    await assertPortIsExclusive(secondPort);
    await guard.release();
    guard = null;
    await assertPortIsBindable(firstPort);
    await assertPortIsBindable(secondPort);
  } finally {
    if (guard) await guard.release();
    rmSync(root, { recursive: true, force: true });
  }
});

test("wildcard dual-stack guard blocks loopback binds on every interface family", async () => {
  const root = runtimeRoot();
  const [port] = await unusedPorts(1);
  let guard;
  try {
    guard = await acquireM6C1StoppedRuntimeGuard({
      runtimeRoot: root,
      ownerKind: "QUALIFICATION_LEGACY_WINDOW",
      hosts: ["0.0.0.0", "::"],
      ports: [port],
    });
    assert.equal(await guard.assertOwned(), true);
    await assertPortIsExclusive(port);
    const lanAddress = Object.values(networkInterfaces()).flat().find((row) =>
      row?.family === "IPv4" && row.internal === false)?.address;
    if (lanAddress) await assertHostIsExclusive(lanAddress, port);
    await assertHostIsExclusive("::1", port);
    await guard.release();
    guard = null;
    await assertPortIsBindable(port);
  } finally {
    if (guard) await guard.release();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a dead Windows socket helper fails the next awaited heartbeat and retains a stale owner lock", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows helper lifecycle fixture");
    return;
  }
  const root = runtimeRoot();
  const [port] = await unusedPorts(1);
  let guard = null;
  try {
    guard = await acquireM6C1StoppedRuntimeGuard({
      runtimeRoot: root,
      ownerKind: "QUALIFICATION_LEGACY_WINDOW",
      hosts: ["0.0.0.0", "::"],
      ports: [port],
    });
    assert.equal(await guard.assertOwned(), true);
    const helperPids = windowsGuardHelperPids();
    assert.equal(helperPids.length, 1);
    process.kill(helperPids[0]);
    await assert.rejects(guard.assertOwned(), { code: "M6_C1_STOPPED_RUNTIME_GUARD_DRIFT" });
    await assert.rejects(guard.release(), { code: "M6_C1_STOPPED_RUNTIME_GUARD_DRIFT" });
    guard = null;
    assert.equal(existsSync(m6C1RuntimeOwnerLockPath(root)), true);
    await assertPortIsBindable(port);
  } finally {
    if (guard) {
      try { await guard.retainStaleLock(); } catch {}
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("a busy second port closes the first guard socket and leaves no owner lock", async () => {
  const root = runtimeRoot();
  const [firstPort] = await unusedPorts(1);
  const blocker = createServer();
  try {
    const secondPort = await listen(blocker, 0);
    await assert.rejects(acquireM6C1StoppedRuntimeGuard({
      runtimeRoot: root,
      ownerKind: "QUALIFICATION_LEGACY_WINDOW",
      ports: [firstPort, secondPort],
    }), { code: "M6_C1_RUNTIME_NOT_STOPPED" });
    assert.equal(existsSync(m6C1RuntimeOwnerLockPath(root)), false);
    await assertPortIsBindable(firstPort);
    await assertPortIsExclusive(secondPort);
  } finally {
    await close(blocker);
    rmSync(root, { recursive: true, force: true });
  }
});

test("beforeOwner runs only after every requested port is exclusively held", async () => {
  const root = runtimeRoot();
  const [firstPort, secondPort] = await unusedPorts(2);
  let guard;
  let callbackCount = 0;
  try {
    guard = await acquireM6C1StoppedRuntimeGuard({
      runtimeRoot: root,
      ownerKind: "QUALIFICATION_LEGACY_WINDOW",
      ports: [firstPort, secondPort],
      beforeOwner: async () => {
        callbackCount += 1;
        assert.equal(existsSync(m6C1RuntimeOwnerLockPath(root)), false);
        await assertPortIsExclusive(firstPort);
        await assertPortIsExclusive(secondPort);
      },
    });
    assert.equal(callbackCount, 1);
    assert.equal(guard.owner.ownerKind, "QUALIFICATION_LEGACY_WINDOW");
    assert.equal(await guard.assertOwned(), true);
  } finally {
    if (guard) await guard.release();
    rmSync(root, { recursive: true, force: true });
  }
});

test("beforeOwner failure closes every port and rethrows the original error", async () => {
  const root = runtimeRoot();
  const [firstPort, secondPort] = await unusedPorts(2);
  const sentinel = Object.assign(new Error("before-owner-fixture"), { code: "BEFORE_OWNER_FIXTURE" });
  try {
    await assert.rejects(acquireM6C1StoppedRuntimeGuard({
      runtimeRoot: root,
      ownerKind: "QUALIFICATION_LEGACY_WINDOW",
      ports: [firstPort, secondPort],
      beforeOwner: async () => { throw sentinel; },
    }), (error) => error === sentinel);
    assert.equal(existsSync(m6C1RuntimeOwnerLockPath(root)), false);
    await assertPortIsBindable(firstPort);
    await assertPortIsBindable(secondPort);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("owner-lock acquisition failure closes every previously bound guard port", async () => {
  const root = runtimeRoot();
  const [firstPort, secondPort] = await unusedPorts(2);
  const existing = acquireM6C1RuntimeOwnerLock({
    runtimeRoot: root,
    ownerKind: "CONTROL_PLANE_M6_C1",
    ownerNonce: "control-plane-owner-nonce-guard-failure",
  });
  try {
    await assert.rejects(acquireM6C1StoppedRuntimeGuard({
      runtimeRoot: root,
      ownerKind: "QUALIFICATION_LEGACY_WINDOW",
      ports: [firstPort, secondPort],
    }), { code: "M6_C1_RUNTIME_OWNER_LOCKED" });
    assert.equal(existing.assertOwned(), true);
    await assertPortIsBindable(firstPort);
    await assertPortIsBindable(secondPort);
  } finally {
    existing.release();
    rmSync(root, { recursive: true, force: true });
  }
});

test("qualification legacy window is an admitted runtime owner kind", () => {
  const root = runtimeRoot();
  try {
    const owner = acquireM6C1RuntimeOwnerLock({
      runtimeRoot: root,
      ownerKind: "QUALIFICATION_LEGACY_WINDOW",
      ownerNonce: "qualification-legacy-window-owner-0001",
    });
    assert.equal(owner.ownerKind, "QUALIFICATION_LEGACY_WINDOW");
    assert.equal(owner.assertOwned(), true);
    assert.equal(owner.release(), true);
  } finally {
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
    await assert.rejects(guard.assertOwned(), { code: "M6_C1_RUNTIME_OWNER_AUTHORITY_INVALID" });
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
