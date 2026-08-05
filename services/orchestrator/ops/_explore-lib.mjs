// 双端共享：alias→serial、helper、调 _win-xiaowei
// Mac = SSH/SCP；Windows = 本地短路（XHS_LOCAL=1 / --local / win32 自动）
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyExplorerSession } from "./_explore-lease.mjs";
import {
  copyExplorerEvidence,
  executeExplorerSessionAction,
  mapExplorerOpToPrimitive,
} from "./_explore-session-action.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// 丝滑交互：所有 ssh/scp 走一条常驻 ControlMaster TCP，握手一次复用全程。
// 每个 ops 脚本都是独立 node 进程，靠固定 ControlPath 共享同一个 master socket。
// 无锁——不串行化任何动作，只省掉重复的 SSH 握手开销。
const SSH_CTRL = join(homedir(), ".ssh", "cm-xhs-windows");
export const SSH_OPTS = [
  "-o", "ControlMaster=auto",
  "-o", `ControlPath=${SSH_CTRL}`,
  "-o", "ControlPersist=600",
  "-o", "ConnectTimeout=8",
];

// serial 是物理锚点（稳定），热路径不必每次 ssh+curl 查 registry。带 TTL + env 逃生口。
const SERIAL_CACHE = join(homedir(), ".xhs-serial-cache.json");
const SERIAL_TTL_MS = 5 * 60 * 1000;
let explorerAuthorization = null;

export async function authorizeExplorerLease(ssh, alias, sessionFile) {
  if (!sessionFile) {
    throw Object.assign(
      new Error("Explorer device access requires --session-file from xw-explore-session acquire"),
      { code: 2, controlCode: "CONTROL_LEASE_REQUIRED" },
    );
  }
  if (!isLocalMode()) {
    throw Object.assign(
      new Error("Explorer lease hard gate currently requires Windows local mode"),
      { code: 4, controlCode: "EXPLORER_LOCAL_MODE_REQUIRED" },
    );
  }
  const verified = await verifyExplorerSession({ contextPath: sessionFile, alias });
  explorerAuthorization = { ...verified, ssh };
  return verified;
}

function requireTransportAuthorization({ alias = null, serial = null } = {}) {
  if (!explorerAuthorization) {
    throw Object.assign(new Error("CONTROL_LEASE_REQUIRED: no verified Explorer session"), { code: 2 });
  }
  if (alias && explorerAuthorization.alias !== alias) {
    throw Object.assign(new Error(`EXPLORER_SESSION_ALIAS_MISMATCH: ${alias}`), { code: 2 });
  }
  if (serial && explorerAuthorization.serial !== serial) {
    throw Object.assign(new Error("EXPLORER_SESSION_SERIAL_MISMATCH"), { code: 2 });
  }
  return explorerAuthorization;
}

export function parseArgs(argv) {
  const opt = (n, fb = null) => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : fb;
  };
  const flag = (n) => argv.includes(n);
  return { opt, flag };
}

/**
 * 本地模式：不经 SSH，本机直连 17930/17920 + session_action（不再直连 22222）。
 * 触发：XHS_LOCAL=1 | --local | win32 自动；XHS_LOCAL=0 显式关掉自动。
 */
export function isLocalMode(argv = process.argv) {
  if (process.env.XHS_LOCAL === "0") return false;
  if (process.env.XHS_LOCAL === "1") return true;
  if (argv.includes("--local")) return true;
  return process.platform === "win32";
}

function localCurl(url) {
  try {
    return execFileSync("curl.exe", ["-s", "-m", "12", url], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    // curl 不可用时用 Node http 子进程兜底
    try {
      return execFileSync(
        process.execPath,
        [
          "-e",
          `const http=require('http');http.get(${JSON.stringify(url)},{timeout:12000},r=>{const a=[];r.on('data',d=>a.push(d));r.on('end',()=>process.stdout.write(Buffer.concat(a)))}).on('error',e=>{console.error(e.message);process.exit(1)})`,
        ],
        { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], timeout: 15000 },
      );
    } catch (e2) {
      const msg = `${e.stderr || e.message || ""} / ${e2.stderr || e2.message || ""}`;
      throw new Error(`localCurl ${url} failed: ${msg.slice(0, 300)}`);
    }
  }
}

export function sshCurl(ssh, url) {
  if (isLocalMode()) {
    return localCurl(url);
  }
  return execFileSync("ssh", [...SSH_OPTS, ssh, "curl.exe", "-s", "-m", "12", url], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// 读 serial 缓存；命中且未过期直接返回。失效/env 逃生口 → 走 live resolveDeviceLive。
function readSerialCache(alias) {
  if (process.env.XHS_NO_SERIAL_CACHE === "1") return null;
  try {
    const c = JSON.parse(readFileSync(SERIAL_CACHE, "utf8"));
    const e = c && c[alias];
    if (e && typeof e.serial === "string" && Date.now() - e.t < SERIAL_TTL_MS) {
      return e.serial;
    }
  } catch { /* no cache yet / corrupt → miss */ }
  return null;
}

function writeSerialCache(alias, serial) {
  try {
    let c = {};
    try { c = JSON.parse(readFileSync(SERIAL_CACHE, "utf8")) || {}; } catch { c = {}; }
    c[alias] = { serial, t: Date.now() };
    writeFileSync(SERIAL_CACHE, JSON.stringify(c), "utf8");
  } catch { /* cache write failure is non-fatal */ }
}

function resolveDeviceLive(ssh, alias) {
  const entry = JSON.parse(sshCurl(ssh, "http://127.0.0.1:17930/api/agent-entry"));
  const dev = (entry.devices || []).find((d) => d.alias === alias);
  if (!dev) throw Object.assign(new Error(`alias ${alias} not in agent-entry`), { code: 2 });
  const serial = dev.serial;
  const online = (dev.state || {}).online ?? (dev.control || {}).online;
  const deviceId = (dev.control || {}).deviceId || dev.deviceId;
  if (!serial) throw Object.assign(new Error(`${alias} missing serial`), { code: 2 });
  if (online === false) throw Object.assign(new Error(`${alias} offline`), { code: 2 });
  return { serial, deviceId, online, dev };
}

export function resolveDevice(ssh, alias) {
  if (explorerAuthorization) {
    const authorization = requireTransportAuthorization({ alias });
    return {
      serial: authorization.serial,
      deviceId: authorization.deviceId,
      online: true,
      dev: null,
      leased: true,
    };
  }
  const cached = readSerialCache(alias);
  if (cached) {
    // 命中缓存：热路径跳过 registry 查询。offline guard 让位给交互响应；
    // 设备真离线时 adb 动作会立刻失败，可清缓存或设 XHS_NO_SERIAL_CACHE=1 重查。
    return { serial: cached, deviceId: null, online: null, dev: null, cached: true };
  }
  const r = resolveDeviceLive(ssh, alias);
  writeSerialCache(alias, r.serial);
  return r;
}

export function ensureWinHelper(ssh, localName = "_win-xiaowei.mjs") {
  const local = join(__dirname, localName);
  if (!existsSync(local)) throw new Error(`missing ${local}`);
  if (isLocalMode()) {
    // 本机即执行面：直接用 ops/ 下 helper，禁止 scp
    return local;
  }
  const remote = `C:/Users/Public/xhs-registry/tmp-know/${localName}`;
  // 仅在远端 size≠本地时才 scp——dev 改了 helper 会自动重传（size 变），其余动作零传输。
  const localSize = statSync(local).size;
  let remoteSize = "";
  try {
    remoteSize = execFileSync(
      "ssh",
      [...SSH_OPTS, ssh, "node", "-e", `console.log(require('fs').statSync(${JSON.stringify(remote)}).size)`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  } catch { remoteSize = ""; } // 远端没有文件或路径不存在 → 重传
  if (String(remoteSize) !== String(localSize)) {
    execFileSync("scp", [...SSH_OPTS, local, `${ssh}:${remote}`], { stdio: ["ignore", "pipe", "pipe"] });
  }
  return remote;
}

export function runWinXiaowei(ssh, remoteHelper, args) {
  // Fail closed: Explorer device I/O must go through control-plane session actions.
  // Keep the CONTROL_LEASE_REQUIRED gate for callers that never authorized.
  requireTransportAuthorization();
  throw Object.assign(
    new Error("EXPLORER_RAW_HELPER_DISABLED: use openWinXwSession / executeExplorerSessionAction (no direct 22222/ADB)"),
    { code: 2, controlCode: "EXPLORER_RAW_HELPER_DISABLED" },
  );
}

/**
 * adb shell via Xiaowei. Always send command as --cmd-b64 so spaces survive SSH.
 * Returns parsed JSON line from _win-xiaowei.
 * @deprecated arbitrary shell is not a bounded Explorer primitive — fail closed.
 */
export function runWinShell(ssh, serial, cmd, remoteHelper = null) {
  requireTransportAuthorization({ serial });
  throw Object.assign(
    new Error("EXPLORER_SHELL_NOT_BOUNDED: arbitrary shell is not an Explorer primitive"),
    { code: 2, controlCode: "EXPLORER_SHELL_NOT_BOUNDED" },
  );
}

export async function runExplorerPrimitive(params, { idempotencyKey = null } = {}) {
  const auth = requireTransportAuthorization();
  return executeExplorerSessionAction({
    contextPath: auth.path,
    alias: auth.alias,
    params,
    idempotencyKey,
  });
}

export function parseJsonLine(raw) {
  const a = String(raw).indexOf("{");
  if (a < 0) throw new Error(`no json: ${String(raw).slice(0, 200)}`);
  return JSON.parse(String(raw).slice(a));
}

function samePath(a, b) {
  try {
    return normalize(resolve(String(a).replace(/\//g, "\\"))).toLowerCase()
      === normalize(resolve(String(b).replace(/\//g, "\\"))).toLowerCase();
  } catch {
    return String(a).replace(/\\/g, "/").toLowerCase() === String(b).replace(/\\/g, "/").toLowerCase();
  }
}

export function scpFrom(ssh, remote, local) {
  mkdirSync(dirname(local), { recursive: true });
  if (isLocalMode()) {
    if (samePath(remote, local)) return;
    copyFileSync(remote, local);
    return;
  }
  execFileSync("scp", [...SSH_OPTS, `${ssh}:${remote}`, local], { stdio: ["ignore", "pipe", "pipe"] });
}

export function parseKVLines(text) {
  const o = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) o[m[1]] = m[2];
  }
  return o;
}

/**
 * Explorer session action client (replaces raw 22222 REPL).
 * Same surface as the old helper: ready / cmd / close / serial.
 * Each cmd() is one formal control-plane session_action.
 *
 *   const s = openWinXwSession(ssh, alias);
 *   await s.ready;
 *   await s.cmd({ op: "tap", x: 540, y: 1200 });
 *   s.close();
 */
export function openWinXwSession(ssh, alias) {
  const auth = requireTransportAuthorization({ alias });
  const { serial } = resolveDevice(ssh, alias);
  let closed = false;

  async function cmd(payload, _timeoutMs = 60000) {
    if (closed) throw new Error("explorer session client closed");
    // Re-verify lease identity before every formal action.
    requireTransportAuthorization({ alias, serial });
    const params = mapExplorerOpToPrimitive(payload);
    const result = await executeExplorerSessionAction({
      contextPath: auth.path,
      alias: auth.alias,
      params,
    });
    const output = { ok: true, action: params.primitive, ...(result.output || {}), jobId: result.jobId, runId: result.runId };
    if (params.primitive === "dump_ui" && payload.out) {
      copyExplorerEvidence(result, "dump-ui.xml", payload.out);
      output.path = payload.out;
    }
    if (params.primitive === "screen" && payload.out) {
      copyExplorerEvidence(result, "screen.png", payload.out);
      output.path = payload.out;
    }
    return output;
  }

  function close() {
    closed = true;
  }

  return {
    ready: Promise.resolve({ action: "repl-ready", ok: true, mode: "session_action" }),
    cmd,
    close,
    serial,
    child: null,
  };
}
