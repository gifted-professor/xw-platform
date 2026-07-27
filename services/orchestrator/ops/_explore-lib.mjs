// Mac 侧共享：alias→serial、scp helper、调 Windows _win-xiaowei
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function parseArgs(argv) {
  const opt = (n, fb = null) => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : fb;
  };
  const flag = (n) => argv.includes(n);
  return { opt, flag };
}

export function sshCurl(ssh, url) {
  return execFileSync("ssh", [ssh, "curl.exe", "-s", "-m", "12", url], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function resolveDevice(ssh, alias) {
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

export function ensureWinHelper(ssh, localName = "_win-xiaowei.mjs") {
  const local = join(__dirname, localName);
  const remote = `C:/Users/Public/xhs-registry/tmp-know/${localName}`;
  if (!existsSync(local)) throw new Error(`missing ${local}`);
  execFileSync("scp", [local, `${ssh}:${remote}`], { stdio: ["ignore", "pipe", "pipe"] });
  return remote;
}

export function runWinXiaowei(ssh, remoteHelper, args) {
  try {
    return execFileSync("ssh", [ssh, "node", remoteHelper, ...args], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    const msg = `${e.stdout || ""}${e.stderr || e.message || ""}`;
    throw new Error(msg.slice(0, 800));
  }
}

export function parseJsonLine(raw) {
  const a = String(raw).indexOf("{");
  if (a < 0) throw new Error(`no json: ${String(raw).slice(0, 200)}`);
  return JSON.parse(String(raw).slice(a));
}

export function scpFrom(ssh, remote, local) {
  mkdirSync(dirname(local), { recursive: true });
  execFileSync("scp", [`${ssh}:${remote}`, local], { stdio: ["ignore", "pipe", "pipe"] });
}
