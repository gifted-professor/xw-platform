// M3-R2 现场只读采集（plan.md §5.1）。
// 只读：git rev-parse/status、netstat、tasklist、schtasks 导出、只读 HTTP GET、DB 只读打开。
// 不修改任何现场文件，不触碰旧服务进程。
import { hostname } from "node:os";

import { inspectDbFile } from "./db.mjs";
import {
  execText,
  findListeningPid,
  httpGetJson,
  processInfo,
  redactString,
  redactValue,
  tryExec,
} from "./util.mjs";

export const LIVE_INVENTORY_SCHEMA_ID = "xw.cutover.live-inventory.v1";
export const SCHEDULED_TASKS_SCHEMA_ID = "xw.cutover.scheduled-tasks-before.v1";

export const ORCHESTRATOR_CHECKOUT = "C:\\Users\\Public\\xhs-registry";
export const CONTROL_PLANE_CHECKOUT = "C:\\Users\\Public\\xhs-routing-v1-1";
export const CONTROL_DB_DEFAULT = "C:\\Users\\Public\\xhs-agent-control\\control.db";
export const LIVE_PORTS = Object.freeze({ orchestrator: 17930, controlPlane: 17920 });
export const TASK_NAME_PATTERN = "xhs|xw|device|registry|control";

function gitCheckoutInfo(path, exec) {
  const head = tryExec("git", ["-C", path, "rev-parse", "HEAD"], { exec });
  const status = tryExec("git", ["-C", path, "status", "--porcelain"], { exec });
  const remote = tryExec("git", ["-C", path, "remote", "get-url", "origin"], { exec });
  return {
    path,
    headSha: head.ok ? head.stdout : "unknown",
    dirtyFileCount: status.ok ? status.stdout.split(/\r?\n/).filter(Boolean).length : "unknown",
    remote: remote.ok ? remote.stdout : "unknown",
  };
}

// 从 schtasks XML 里抽最少必要字段（无 XML 解析器依赖），命令行整体过 redact。
function parseTaskXml(xml) {
  const grab = (tag) => {
    const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i"));
    return match ? match[1].trim() : null;
  };
  const actions = [];
  const actionRe = /<Command>([\s\S]*?)<\/Command>(?:\s*<Arguments>([\s\S]*?)<\/Arguments>)?/gi;
  let match;
  while ((match = actionRe.exec(xml)) !== null) {
    actions.push({ command: redactString(match[1].trim()), arguments: redactString((match[2] || "").trim()) });
  }
  const triggers = [];
  for (const type of ["BootTrigger", "LogonTrigger", "TimeTrigger", "CalendarTrigger", "RegistrationTrigger"]) {
    if (xml.includes(`<${type}`)) triggers.push(type);
  }
  return {
    author: grab("Author"),
    runLevel: grab("RunLevel"),
    logonType: grab("LogonType"),
    enabled: grab("Enabled"),
    triggers,
    actions,
  };
}

export function collectScheduledTasks({ exec = execText } = {}) {
  const discovered = tryExec("powershell", [
    "-NoProfile", "-NonInteractive", "-Command",
    `Get-ScheduledTask | Where-Object { $_.TaskName -match '${TASK_NAME_PATTERN}' } | ForEach-Object { "$($_.TaskName)|$($_.State)" }`,
  ], { exec });
  const tasks = [];
  if (!discovered.ok || !discovered.stdout) return { tasks, discoveryError: discovered.ok ? null : discovered.error };
  for (const line of discovered.stdout.split(/\r?\n/).filter(Boolean)) {
    const [name, state] = line.split("|");
    const entry = { name, state: state || "unknown" };
    const xml = tryExec("schtasks", ["/query", "/tn", name, "/xml"], { exec });
    if (xml.ok) Object.assign(entry, parseTaskXml(xml.stdout));
    else entry.xmlError = xml.error;
    tasks.push(entry);
  }
  return { tasks, discoveryError: null };
}

// DB 路径发现：registry 从计划任务启动参数 --db 推；control 从旧仓代码默认路径推。
// 找不到就记 unknown，不猜。
export function discoverDbPaths({ scheduledTasks, exists = defaultExists } = {}) {
  const out = {
    registry: { path: "unknown", discoveredVia: null },
    control: { path: "unknown", discoveredVia: null },
  };
  const task = (scheduledTasks?.tasks || []).find((item) => item.name === "XhsDeviceRegistry");
  const args = task?.actions?.[0]?.arguments || "";
  const dbMatch = args.match(/--db\s+"([^"]+registry\.db)"/i) || args.match(/--db\s+(\S+registry\.db)/i);
  if (dbMatch && exists(dbMatch[1])) {
    out.registry = { path: dbMatch[1], discoveredVia: "scheduled-task:XhsDeviceRegistry --db" };
  } else {
    const candidate = `${ORCHESTRATOR_CHECKOUT}\\registry.db`;
    if (exists(candidate)) out.registry = { path: candidate, discoveredVia: "checkout-default (registry.mjs --db default)" };
  }
  if (exists(CONTROL_DB_DEFAULT)) {
    out.control = { path: CONTROL_DB_DEFAULT, discoveredVia: "code-default (bootstrap.mjs defaultRuntimePaths win32)" };
  }
  return out;
}

function defaultExists(path) {
  try {
    return Boolean(path) && inspectDbFile(path).exists;
  } catch {
    return false;
  }
}

async function collectOrchestratorApi(port, httpGet) {
  const base = `http://127.0.0.1:${port}`;
  const health = await httpGet(`${base}/api/health`);
  if (!health.reachable) return { reachable: false, error: health.error ?? `status ${health.status}` };
  const devices = await httpGet(`${base}/api/devices`);
  const entry = await httpGet(`${base}/api/agent-entry`);
  const result = {
    reachable: true,
    health: redactValue(health.body),
    deviceCount: Array.isArray(devices.body?.devices) ? devices.body.devices.length : "unknown",
    controlPlaneView: devices.body?.controlPlane
      ? redactValue({
          reachable: devices.body.controlPlane.reachable,
          activeLeases: devices.body.controlPlane.activeLeases,
          policyMode: devices.body.controlPlane.policyMode,
          releaseId: devices.body.controlPlane.releaseId,
        })
      : "unknown",
    agentEntrySchema: entry.body?.schemaVersion ?? "unknown",
  };
  if (entry.body?.jobs && typeof entry.body.jobs === "object") {
    result.jobs = redactValue(entry.body.jobs);
  }
  return result;
}

async function collectControlPlaneApi(port, httpGet) {
  const health = await httpGet(`http://127.0.0.1:${port}/control/v1/health`, { timeoutMs: 2500 });
  if (!health.reachable || !health.body) {
    return { reachable: false, error: health.error ?? `status ${health.status}` };
  }
  return { reachable: true, health: redactValue(health.body) };
}

export async function collectLiveInventory({
  exec = execText,
  httpGet = httpGetJson,
  ports = LIVE_PORTS,
  checkouts = { orchestrator: ORCHESTRATOR_CHECKOUT, controlPlane: CONTROL_PLANE_CHECKOUT },
  exists = defaultExists,
  now = () => new Date().toISOString(),
} = {}) {
  const scheduledTasks = collectScheduledTasks({ exec });
  const dbPaths = discoverDbPaths({ scheduledTasks, exists });
  const portReport = {};
  for (const [name, port] of Object.entries(ports)) {
    const pid = findListeningPid(port, { exec });
    portReport[name] = { port, listening: pid !== null, pid, process: pid !== null ? processInfo(pid, { exec }) : null };
  }
  const orchestratorApi = await collectOrchestratorApi(ports.orchestrator, httpGet);
  const controlPlaneApi = await collectControlPlaneApi(ports.controlPlane, httpGet);
  const databases = {};
  for (const [name, found] of Object.entries(dbPaths)) {
    databases[name] = found.path === "unknown"
      ? { path: "unknown", discoveredVia: found.discoveredVia }
      : { discoveredVia: found.discoveredVia, ...inspectDbFile(found.path) };
  }
  const inventory = {
    schemaId: LIVE_INVENTORY_SCHEMA_ID,
    collectedAt: now(),
    host: { hostname: hostname(), platform: process.platform, arch: process.arch, nodeVersion: process.versions.node },
    checkouts: {
      orchestrator: gitCheckoutInfo(checkouts.orchestrator, exec),
      controlPlane: gitCheckoutInfo(checkouts.controlPlane, exec),
    },
    ports: portReport,
    scheduledTasks,
    databases,
    services: { orchestratorApi, controlPlaneApi },
    redaction: {
      rules: [
        "keys matching /token|secret|authorization|password|credential|serial/i → [redacted]",
        "--*token/--*secret/--*key CLI 参数值 → [redacted]",
        "C:\\Users\\<name>\\ 用户名路径段（Public 除外）→ <user>",
      ],
    },
  };
  return inventory;
}

export function scheduledTasksReceipt(inventory, { now = () => new Date().toISOString() } = {}) {
  return {
    schemaId: SCHEDULED_TASKS_SCHEMA_ID,
    exportedAt: now(),
    note: "只读导出（Get-ScheduledTask + schtasks /query /xml）；未创建/修改/删除任何计划任务。",
    tasks: inventory.scheduledTasks.tasks,
    discoveryError: inventory.scheduledTasks.discoveryError,
  };
}
