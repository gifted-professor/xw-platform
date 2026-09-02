import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createServer, isIP } from "node:net";
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
  "QUALIFICATION_LEGACY_WINDOW",
]);
const HELD_LOCKS = new WeakSet();
const WINDOWS_EXCLUSIVE_SOCKET_PROGRAM = String.raw`
$ErrorActionPreference = "Stop"
$sockets = [Collections.Generic.List[Net.Sockets.Socket]]::new()
$stage = "parse"
try {
    $document = $env:XW_M6_GUARD_ENDPOINTS | ConvertFrom-Json -ErrorAction Stop
    $rows = @($document.rows)
    foreach ($row in $rows) {
        $stage = "address"
        $address = [Net.IPAddress]::Parse([string]$row.host)
        $stage = "socket"
        $socket = [Net.Sockets.Socket]::new(
            $address.AddressFamily,
            [Net.Sockets.SocketType]::Stream,
            [Net.Sockets.ProtocolType]::Tcp
        )
        $socket.ExclusiveAddressUse = $true
        if ($address.AddressFamily -eq [Net.Sockets.AddressFamily]::InterNetworkV6) {
            $socket.DualMode = $false
        }
        $stage = "bind"
        $socket.Bind([Net.IPEndPoint]::new($address, [int]$row.port))
        $socket.Listen(1)
        $sockets.Add($socket)
    }
    [Console]::Out.WriteLine('{"ready":true}')
    [Console]::Out.Flush()
    while ($null -ne ($line = [Console]::In.ReadLine())) {
        if ($line -notmatch '^PING ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$') {
            throw [InvalidOperationException]::new("heartbeat command invalid")
        }
        [Console]::Out.WriteLine('{"owned":"' + $Matches[1] + '"}')
        [Console]::Out.Flush()
    }
} catch {
    $deepest = $_.Exception
    while ($null -ne $deepest.InnerException) { $deepest = $deepest.InnerException }
    $socketError = if ($deepest -is [Net.Sockets.SocketException]) { $deepest } else { $null }
    $reason = if ($null -ne $socketError) {
        [string]$socketError.SocketErrorCode
    } else { $deepest.GetType().Name }
    [Console]::Out.WriteLine(([ordered]@{ ready = $false; stage = $stage; reason = $reason } | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
    exit 23
} finally {
    foreach ($socket in $sockets) { try { $socket.Dispose() } catch {} }
}
`;

function fail(code, message, details = {}) {
  throw new ControlPlaneError(code, message, { status: 503, details });
}

function minimalWindowsEnvironment(extra) {
  const root = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  return Object.freeze(Object.fromEntries(Object.entries({
    SystemRoot: root,
    WINDIR: root,
    ComSpec: process.env.ComSpec || join(root, "System32", "cmd.exe"),
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    ...extra,
  }).filter(([, value]) => typeof value === "string" && value !== "")));
}

function childHasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForChildExitProof(child, timeoutMs) {
  if (childHasExited(child)) return true;
  return new Promise((resolveExit) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      resolveExit(value);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(childHasExited(child)), timeoutMs);
    child.once("exit", onExit);
  });
}

async function acquireWindowsExclusiveSocketAuthority({ hosts, ports }) {
  const root = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  const executable = join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const endpoints = hosts.flatMap((host) => ports.map((port) => Object.freeze({ host, port })));
  const child = spawn(executable, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-Command", WINDOWS_EXCLUSIVE_SOCKET_PROGRAM,
  ], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "ignore"],
    env: minimalWindowsEnvironment({ XW_M6_GUARD_ENDPOINTS: JSON.stringify({ rows: endpoints }) }),
  });
  let startupBuffer = "";
  await new Promise((resolveReady, rejectReady) => {
    let settled = false;
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
      if (error) rejectReady(error); else resolveReady();
    };
    const onError = (cause) => finish(cause);
    const onExit = () => finish(Object.assign(new Error("exclusive socket helper exited"), {
      code: "M6_C1_WINDOWS_SOCKET_HELPER_EXITED",
    }));
    const onData = (chunk) => {
      startupBuffer += chunk.toString("utf8");
      if (Buffer.byteLength(startupBuffer, "utf8") > 256) {
        finish(Object.assign(new Error("exclusive socket helper output invalid"), {
          code: "M6_C1_WINDOWS_SOCKET_HELPER_INVALID",
        }));
        return;
      }
      const newline = startupBuffer.indexOf("\n");
      if (newline === -1) return;
      const line = startupBuffer.slice(0, newline).trim();
      if (line !== '{"ready":true}') {
        let reason = "INVALID";
        try {
          const value = JSON.parse(line);
          if (value?.ready === false && ["parse", "address", "socket", "bind"].includes(value.stage)
            && /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(value.reason || "")) {
            reason = `${value.stage.toUpperCase()}_${value.reason.toUpperCase()}`;
          }
        } catch {}
        finish(Object.assign(new Error("exclusive socket helper refused endpoints"), {
          code: `M6_C1_WINDOWS_SOCKET_HELPER_REFUSED_${reason}`,
        }));
        return;
      }
      finish();
    };
    const timer = setTimeout(() => finish(Object.assign(new Error("exclusive socket helper timed out"), {
      code: "M6_C1_WINDOWS_SOCKET_HELPER_TIMEOUT",
    })), 10_000);
    child.once("error", onError);
    child.once("exit", onExit);
    child.stdout.on("data", onData);
  }).catch(async (cause) => {
    try { child.stdin.end(); } catch {}
    let exited = await waitForChildExitProof(child, 5_000);
    if (!exited) {
      try { child.kill(); } catch {}
      exited = await waitForChildExitProof(child, 5_000);
    }
    if (!exited) {
      throw Object.assign(new Error("exclusive socket helper startup cleanup was not proven"), {
        code: "M6_C1_WINDOWS_SOCKET_HELPER_RELEASE_UNPROVEN",
      });
    }
    throw cause;
  });
  child.stdout.pause();
  let released = false;
  let releasing = false;
  let releasePromise = null;
  let fault = null;
  child.once("error", (cause) => { fault = cause; });
  child.once("exit", (code) => {
    if (!released && !releasing) {
      fault = Object.assign(new Error("exclusive socket helper exited"), { code });
    }
  });
  const heartbeat = async () => {
    if (released || releasing || fault !== null || childHasExited(child)) {
      fail(
        "M6_C1_STOPPED_RUNTIME_GUARD_DRIFT",
        "M6-C1 stopped runtime guard lost its Windows exclusive socket helper",
      );
    }
    const nonce = randomUUID();
    try {
      await new Promise((resolveHeartbeat, rejectHeartbeat) => {
        let settled = false;
        let buffer = "";
        const finish = (cause = null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          child.stdout.off("data", onData);
          child.stdout.off("end", onEnd);
          child.off("exit", onExit);
          child.stdout.pause();
          if (cause) rejectHeartbeat(cause); else resolveHeartbeat();
        };
        const onEnd = () => finish(new Error("exclusive socket helper stdout ended"));
        const onExit = () => finish(new Error("exclusive socket helper exited"));
        const onData = (chunk) => {
          buffer += chunk.toString("utf8");
          if (Buffer.byteLength(buffer, "utf8") > 128) {
            finish(new Error("exclusive socket helper heartbeat output invalid"));
            return;
          }
          const newline = buffer.indexOf("\n");
          if (newline === -1) return;
          const line = buffer.slice(0, newline).trim();
          if (line !== `{"owned":"${nonce}"}`) {
            finish(new Error("exclusive socket helper heartbeat mismatch"));
            return;
          }
          finish();
        };
        const timer = setTimeout(() => finish(new Error("exclusive socket helper heartbeat timed out")), 5_000);
        child.stdout.on("data", onData);
        child.stdout.once("end", onEnd);
        child.once("exit", onExit);
        child.stdout.resume();
        try {
          child.stdin.write(`PING ${nonce}\n`, "utf8", (cause) => {
            if (cause) finish(cause);
          });
        } catch (cause) { finish(cause); }
      });
    } catch (cause) {
      fault = cause;
      fail(
        "M6_C1_STOPPED_RUNTIME_GUARD_DRIFT",
        "M6-C1 stopped runtime guard lost its Windows exclusive socket helper",
      );
    }
    return true;
  };
  let heartbeatChain = Promise.resolve();
  return Object.freeze({
    async assertOwned() {
      heartbeatChain = heartbeatChain.then(heartbeat, heartbeat);
      return heartbeatChain;
    },
    async release() {
      if (released) return true;
      if (releasePromise !== null) return releasePromise;
      const driftedBeforeRelease = fault !== null || childHasExited(child);
      releasing = true;
      releasePromise = (async () => {
        try { child.stdin.end(); } catch {}
        let exited = await waitForChildExitProof(child, 5_000);
        if (!exited) {
          try { child.kill(); } catch {}
          exited = await waitForChildExitProof(child, 5_000);
        }
        if (!exited) {
          fault = new Error("exclusive socket helper exit was not proven");
          fail(
            "M6_C1_WINDOWS_SOCKET_HELPER_RELEASE_UNPROVEN",
            "M6-C1 stopped runtime guard could not prove Windows helper exit",
          );
        }
        released = true;
        if (driftedBeforeRelease) {
          fail(
            "M6_C1_STOPPED_RUNTIME_GUARD_DRIFT",
            "M6-C1 stopped runtime guard lost its Windows exclusive socket helper",
          );
        }
        return true;
      })().finally(() => { releasing = false; });
      return releasePromise;
    },
  });
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

export const WINDOWS_SEAL_OWNER_LOCK_PROGRAM = String.raw`
$ErrorActionPreference = "Stop"
$path = [string]$env:XW_M6_OWNER_LOCK_PATH
Get-Item -LiteralPath $path -Force | Out-Null
$administrators = New-Object Security.Principal.SecurityIdentifier("S-1-5-32-544")
$system = New-Object Security.Principal.SecurityIdentifier("S-1-5-18")
$security = New-Object Security.AccessControl.FileSecurity($path, [Security.AccessControl.AccessControlSections]::All)
$security.SetOwner($administrators)
$security.SetAccessRuleProtection($true, $false)
foreach ($sid in @($system, $administrators)) {
    $rule = New-Object Security.AccessControl.FileSystemAccessRule(
        $sid,
        [Security.AccessControl.FileSystemRights]::FullControl,
        [Security.AccessControl.InheritanceFlags]::None,
        [Security.AccessControl.PropagationFlags]::None,
        [Security.AccessControl.AccessControlType]::Allow
    )
    $security.AddAccessRule($rule)
}
[IO.File]::SetAccessControl($path, $security)
$verify = New-Object Security.AccessControl.FileSecurity($path, [Security.AccessControl.AccessControlSections]::All)
$owner = [string]$verify.GetOwner([Security.Principal.SecurityIdentifier]).Value
$rules = @($verify.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
if ($verify.AreAccessRulesProtected -ne $true -or (@("S-1-5-18", "S-1-5-32-544") -notcontains $owner) -or $rules.Count -ne 2) {
    exit 23
}
exit 0
`;

function sealWindowsOwnerLockAcl(lockPath) {
  if (process.platform !== "win32") return;
  try {
    spawnSync("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      WINDOWS_SEAL_OWNER_LOCK_PROGRAM,
    ], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
      env: {
        SystemRoot: process.env.SystemRoot || process.env.WINDIR || "C:\\Windows",
        WINDIR: process.env.WINDIR || process.env.SystemRoot || "C:\\Windows",
        PATHEXT: process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD",
        XW_M6_OWNER_LOCK_PATH: lockPath,
      },
    });
  } catch {
    // Best-effort sealing: the quiesce/qualification TCB verification is the
    // enforcing gate; a sealed lock that later drifts fails closed there.
  }
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
    // Seal the create-only lock into the SYSTEM/Administrators TCB ACL shape
    // (owner Administrators + protected 2-rule DACL) so qualification/quiesce
    // TCB verification accepts the lock the live control-plane just created.
    sealWindowsOwnerLockAcl(lockPath);
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
  hosts = undefined,
  port = 17920,
  ports = undefined,
  beforeOwner = undefined,
} = {}) {
  if (beforeOwner !== undefined && typeof beforeOwner !== "function") {
    fail(
      "M6_C1_STOPPED_RUNTIME_GUARD_INPUT_INVALID",
      "M6-C1 stopped runtime guard beforeOwner must be a function when supplied",
    );
  }
  const portInput = ports === undefined ? [port] : ports;
  const hostInput = hosts === undefined ? [host] : hosts;
  if (!Array.isArray(portInput) || portInput.length < 1 || portInput.length > 16) {
    fail(
      "M6_C1_STOPPED_RUNTIME_GUARD_INPUT_INVALID",
      "M6-C1 stopped runtime guard ports must be one bounded list of distinct TCP ports",
    );
  }
  const requestedPorts = Object.freeze([...portInput]);
  if (!Array.isArray(hostInput) || hostInput.length < 1 || hostInput.length > 4
    || hostInput.some((value) => typeof value !== "string" || value.length < 2
      || value.length > 64 || isIP(value) === 0)
    || new Set(hostInput.map((value) => value.toLowerCase())).size !== hostInput.length) {
    fail(
      "M6_C1_STOPPED_RUNTIME_GUARD_INPUT_INVALID",
      "M6-C1 stopped runtime guard hosts must be one bounded list of distinct IP literals",
    );
  }
  const requestedHosts = Object.freeze([...hostInput]);
  const fixedPorts = requestedPorts.filter((value) => value !== 0);
  if (requestedPorts.some((value) => !Number.isInteger(value) || value < 0 || value > 65_535)
    || new Set(fixedPorts).size !== fixedPorts.length) {
    fail(
      "M6_C1_STOPPED_RUNTIME_GUARD_INPUT_INVALID",
      "M6-C1 stopped runtime guard ports must be one bounded list of distinct TCP ports",
    );
  }
  const servers = [];
  const serverErrors = new WeakMap();
  let windowsSocketAuthority = null;
  const closeServers = async () => {
    if (windowsSocketAuthority !== null) await windowsSocketAuthority.release();
    await Promise.all(servers.map((server) => new Promise((resolveClose) => {
      if (!server.listening) {
        resolveClose();
        return;
      }
      server.close(() => resolveClose());
    })));
  };
  try {
    if (process.platform === "win32") {
      windowsSocketAuthority = await acquireWindowsExclusiveSocketAuthority({
        hosts: requestedHosts,
        ports: requestedPorts,
      });
    } else {
      for (const requestedHost of requestedHosts) {
        for (const requestedPort of requestedPorts) {
          const server = createServer((socket) => socket.destroy());
          await new Promise((resolveListen, rejectListen) => {
            const onError = (cause) => rejectListen(cause);
            server.once("error", onError);
            server.listen({
              host: requestedHost,
              port: requestedPort,
              exclusive: true,
              ...(requestedHost.includes(":") ? { ipv6Only: true } : {}),
            }, () => {
              server.off("error", onError);
              server.on("error", (cause) => serverErrors.set(server, cause));
              resolveListen();
            });
          });
          servers.push(server);
        }
      }
    }
  } catch (cause) {
    await closeServers();
    fail("M6_C1_RUNTIME_NOT_STOPPED", "M6-C1 mutation requires exclusive ownership of the control-plane loopback port", {
      cause: cause?.code ?? null,
    });
  }
  if (beforeOwner !== undefined) {
    try {
      await beforeOwner();
    } catch (cause) {
      await closeServers();
      throw cause;
    }
  }
  let owner;
  try {
    owner = acquireM6C1RuntimeOwnerLock({ runtimeRoot, ownerKind });
  } catch (cause) {
    await closeServers();
    throw cause;
  }
  let drifted = false;
  return Object.freeze({
    schemaId: "xw.m6-c1-stopped-runtime-guard.v1",
    owner,
    async assertOwned() {
      try {
        owner.assertOwned();
        if (windowsSocketAuthority !== null) await windowsSocketAuthority.assertOwned();
        if (servers.some((server) => !server.listening || serverErrors.has(server))) {
          fail(
            "M6_C1_STOPPED_RUNTIME_GUARD_DRIFT",
            "M6-C1 stopped runtime guard lost one or more exclusive listener sockets",
          );
        }
        return true;
      } catch (cause) {
        drifted = true;
        throw cause;
      }
    },
    async release() {
      owner.assertOwned();
      if (drifted) {
        try { await closeServers(); } catch {}
        owner.assertOwned();
        owner.retainStaleLock();
        fail(
          "M6_C1_STOPPED_RUNTIME_GUARD_DRIFT",
          "M6-C1 stopped runtime guard drifted and retained its owner lock",
        );
      }
      try {
        await closeServers();
      } catch (cause) {
        owner.assertOwned();
        owner.retainStaleLock();
        throw cause;
      }
      owner.assertOwned();
      return owner.release();
    },
    async retainStaleLock() {
      owner.assertOwned();
      try {
        await closeServers();
      } catch (cause) {
        owner.assertOwned();
        owner.retainStaleLock();
        throw cause;
      }
      owner.assertOwned();
      return owner.retainStaleLock();
    },
  });
}
