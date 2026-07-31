// Mac 侧共享：alias→serial、scp helper、调 Windows _win-xiaowei
import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// 丝滑交互：所有 ssh/scp 走一条常驻 ControlMaster TCP，握手一次复用全程。
// 每个 ops 脚本都是独立 node 进程，靠固定 ControlPath 共享同一个 master socket。
// 无锁——不串行化任何动作，只省掉重复的 SSH 握手开销。
const SSH_CTRL = join(homedir(), ".ssh", "cm-xhs-windows");
const SSH_OPTS = [
  "-o", "ControlMaster=auto",
  "-o", `ControlPath=${SSH_CTRL}`,
  "-o", "ControlPersist=600",
  "-o", "ConnectTimeout=8",
];

// serial 是物理锚点（稳定），热路径不必每次 ssh+curl 查 registry。带 TTL + env 逃生口。
const SERIAL_CACHE = join(homedir(), ".xhs-serial-cache.json");
const SERIAL_TTL_MS = 5 * 60 * 1000;

export function parseArgs(argv) {
  const opt = (n, fb = null) => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : fb;
  };
  const flag = (n) => argv.includes(n);
  return { opt, flag };
}

export function sshCurl(ssh, url) {
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
  const remote = `C:/Users/Public/xhs-registry/tmp-know/${localName}`;
  if (!existsSync(local)) throw new Error(`missing ${local}`);
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
  try {
    return execFileSync("ssh", [...SSH_OPTS, ssh, "node", remoteHelper, ...args], {
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

export function scpFrom(ssh, remote, local) {
  mkdirSync(dirname(local), { recursive: true });
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
 * 常驻 pipe session：开一条 ssh channel + 一个 node repl 进程，一串动作复用。
 * 单动作延迟从 ~1.2s（每动作新握手）降到 ~0.2s（只走本地 WS 回环）。
 * 无锁、无新服务生命周期——pipe 由调用方 own，close() 即结束。
 *
 *   const s = await openWinXwSession(ssh, alias);
 *   await s.cmd({ op: "tap", x: 540, y: 1200 });
 *   await s.cmd({ op: "back", times: 2 });
 *   s.close();
 */
export function openWinXwSession(ssh, alias) {
  const { serial } = resolveDevice(ssh, alias);
  const helper = ensureWinHelper(ssh);
  const child = spawn("ssh", [...SSH_OPTS, ssh, "node", helper, "--serial", serial, "--action", "repl"], {
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
  const ready = new Promise((resolve, reject) => {
    readyResolvers.push(resolve);
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
    const p = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`repl cmd timeout ${payload.op}`)), timeoutMs);
      pending.push((line) => {
        clearTimeout(t);
        if (line == null) reject(new Error("repl exited mid-cmd"));
        else {
          try { resolve(JSON.parse(line)); } catch (e) { reject(new Error(`repl bad json: ${line.slice(0, 200)}`)); }
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
