// M3-R2 共享工具：脱敏、hash、HTTP 只读 GET、进程/端口查询。
// 全部为只读本机操作；不写任何现场目录。
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

export const REDACTED = "[redacted]";

const REDACT_KEY = /token|secret|authorization|password|passwd|credential|serial/i;
const REDACT_TOKEN_ARG = /(--[\w-]*(?:token|secret|password|passwd|key)[\w-]*)(=|\s+)("[^"]*"|'[^']*'|\S+)/gi;
const USER_PATH = /([A-Za-z]:[\\/]+Users[\\/]+)([^\\/]+)/g;

export function redactString(value) {
  if (typeof value !== "string") return value;
  let out = value.replace(REDACT_TOKEN_ARG, (_m, flag, sep) => `${flag}${sep}${REDACTED}`);
  out = out.replace(USER_PATH, (m, prefix, name) => (name === "Public" ? m : `${prefix}<user>`));
  return out;
}

// 深度脱敏：key 命中敏感词（token/secret/serial…）直接遮蔽；字符串值再清一遍命令行 token 与用户名路径段。
export function redactValue(value) {
  if (typeof value === "string") return redactString(value);
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  const copy = {};
  for (const [key, item] of Object.entries(value)) {
    copy[key] = REDACT_KEY.test(key) ? REDACTED : redactValue(item);
  }
  return copy;
}

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function sha256Text(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function fileInfo(path) {
  try {
    const stat = statSync(path);
    return { exists: true, sizeBytes: stat.size, mtime: stat.mtime.toISOString() };
  } catch {
    return { exists: false, sizeBytes: null, mtime: null };
  }
}

export function execText(command, args, { timeoutMs = 15000 } = {}) {
  return execFileSync(command, args, { encoding: "utf8", timeout: timeoutMs, windowsHide: true }).trim();
}

export function tryExec(command, args, { exec = execText, timeoutMs = 15000 } = {}) {
  try {
    return { ok: true, stdout: exec(command, args, { timeoutMs }) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

// 只读 HTTP GET，返回 { reachable, status, body }；绝不向外发任何非 GET 请求。
export async function httpGetJson(url, { timeoutMs = 3000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: "GET", signal: controller.signal });
    const text = await response.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return { reachable: true, status: response.status, body };
  } catch (error) {
    return { reachable: false, status: null, body: null, error: error.name === "AbortError" ? "timeout" : error.message };
  } finally {
    clearTimeout(timer);
  }
}

// netstat -ano 解析指定端口的 LISTENING pid（Windows）。
export function findListeningPid(port, { exec = execText } = {}) {
  const out = exec("netstat", ["-ano"]);
  for (const line of out.split(/\r?\n/)) {
    if (!line.includes("LISTENING")) continue;
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5) continue;
    const local = cols[1];
    if (local.endsWith(`:${port}`)) return Number(cols[cols.length - 1]);
  }
  return null;
}

export function processInfo(pid, { exec = execText } = {}) {
  if (!pid) return null;
  const info = { pid, processName: null, commandLine: null };
  const list = tryExec("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { exec });
  if (list.ok) {
    const match = list.stdout.match(/^"([^"]+)"/);
    if (match) info.processName = match[1];
  }
  const ps = tryExec("powershell", [
    "-NoProfile", "-NonInteractive", "-Command",
    `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
  ], { exec });
  if (ps.ok && ps.stdout) info.commandLine = redactString(ps.stdout);
  return info;
}

export async function waitFor(check, { timeoutMs = 30000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await check();
    if (last && last.ok) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  const error = new Error(`WAIT_TIMEOUT: condition not met within ${timeoutMs}ms`);
  error.last = last;
  throw error;
}
