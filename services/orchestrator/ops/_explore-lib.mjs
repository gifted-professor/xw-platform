// 双端共享：alias→serial、helper、调 _win-xiaowei
// Mac = SSH/SCP；Windows = 本地短路（XHS_LOCAL=1 / --local / win32 自动）
import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyExplorerSession } from "./_explore-lease.mjs";

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

// 推导调用本 lib 的脚本名（如 xhs-like-one），供 trace --tag 使用。
function callerScriptName() {
  try {
    const p = process.argv[1];
    if (!p) return null;
    return String(p).split(/[\\/]/).pop().replace(/\.mjs$/, "") || null;
  } catch { return null; }
}

/**
 * 本地模式：不经 SSH，本机直连 17930/17920/22222 + 本机 node helper。
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
  const finalArgs = [...args];
  const serialIndex = finalArgs.indexOf("--serial");
  const serial = serialIndex >= 0 ? finalArgs[serialIndex + 1] : null;
  requireTransportAuthorization({ serial });
  if (!finalArgs.includes("--session-file")) {
    finalArgs.push("--session-file", explorerAuthorization.path);
  }
  if (!finalArgs.includes("--alias")) {
    finalArgs.push("--alias", explorerAuthorization.alias);
  }
  // 注入调用方脚本名供 trace --tag；alias 由调用方可选传（原子脚本暂无则跳过）
  const scriptName = callerScriptName();
  if (scriptName && !finalArgs.includes("--tag")) {
    finalArgs.push("--tag", scriptName);
  }
  try {
    if (isLocalMode()) {
      return execFileSync(process.execPath, [remoteHelper, ...finalArgs], {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      });
    }
    return execFileSync("ssh", [...SSH_OPTS, ssh, "node", remoteHelper, ...finalArgs], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    const msg = `${e.stdout || ""}${e.stderr || e.message || ""}`;
    throw new Error(msg.slice(0, 800));
  }
}

/**
 * adb shell via Xiaowei. Always send command as --cmd-b64 so spaces survive SSH.
 * Returns parsed JSON line from _win-xiaowei.
 */
export function runWinShell(ssh, serial, cmd, remoteHelper = null) {
  const helper = remoteHelper || ensureWinHelper(ssh);
  const b64 = Buffer.from(String(cmd), "utf8").toString("base64");
  const raw = runWinXiaowei(ssh, helper, [
    "--serial",
    serial,
    "--action",
    "shell",
    "--cmd-b64",
    b64,
  ]);
  return parseJsonLine(raw);
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
 * 常驻 pipe session：Mac 开一条 ssh channel + node repl；Windows 本地直接 spawn node repl。
 * 单动作延迟从 ~1.2s（每动作新握手）降到 ~0.2s（只走本地 WS 回环）。
 * 无锁、无新服务生命周期——pipe 由调用方 own，close() 即结束。
 *
 *   const s = await openWinXwSession(ssh, alias);
 *   await s.cmd({ op: "tap", x: 540, y: 1200 });
 *   await s.cmd({ op: "back", times: 2 });
 *   s.close();
 */
export function openWinXwSession(ssh, alias) {
  requireTransportAuthorization({ alias });
  const { serial } = resolveDevice(ssh, alias);
  const helper = ensureWinHelper(ssh);
  const scriptName = callerScriptName();
  const replArgs = ["--serial", serial, "--action", "repl", "--alias", alias];
  replArgs.push("--session-file", explorerAuthorization.path);
  if (scriptName) replArgs.push("--tag", scriptName);
  const child = isLocalMode()
    ? spawn(process.execPath, [helper, ...replArgs], {
        stdio: ["pipe", "pipe", "ignore"],
      })
    : spawn("ssh", [...SSH_OPTS, ssh, "node", helper, ...replArgs], {
        stdio: ["pipe", "pipe", "ignore"],
      });
  const pending = [];
  const rl = createInterface({ input: child.stdout });
  const readyResolvers = [];
  rl.on("line", (line) => {
    if (readyResolvers.length) {
      try {
        const j = JSON.parse(line);
        if (j.action === "repl-ready") {
          readyResolvers.shift()(j);
          return;
        }
      } catch { /* not the ready line */ }
    }
    const r = pending.shift();
    if (r) r(line);
  });
  let closed = false;
  const ready = new Promise((resolveP, reject) => {
    readyResolvers.push(resolveP);
    const t = setTimeout(() => reject(new Error("repl ready timeout (no repl-ready line)")), 15000);
    child.on("error", (e) => { clearTimeout(t); reject(e); });
    child.on("exit", (code) => {
      clearTimeout(t);
      closed = true;
      if (pending.length) pending.shift()(null); // unblock waiters → they throw
      if (code !== 0 && code !== null) reject(new Error(`repl exited code=${code}`));
    });
  });

  async function cmd(payload, timeoutMs = 60000) {
    if (closed) throw new Error("repl session closed");
    const p = new Promise((resolveP, reject) => {
      const t = setTimeout(() => reject(new Error(`repl cmd timeout ${payload.op}`)), timeoutMs);
      pending.push((line) => {
        clearTimeout(t);
        if (line == null) reject(new Error("repl exited mid-cmd"));
        else {
          try { resolveP(JSON.parse(line)); } catch (e) { reject(new Error(`repl bad json: ${line.slice(0, 200)}`)); }
        }
      });
    });
    child.stdin.write(JSON.stringify(payload) + "\n");
    return p;
  }

  function close() {
    closed = true;
    try { child.stdin.end(); } catch { /* */ }
    try { rl.close(); } catch { /* */ }
    try { child.kill(); } catch { /* */ }
  }

  return { ready, cmd, close, serial, child };
}
