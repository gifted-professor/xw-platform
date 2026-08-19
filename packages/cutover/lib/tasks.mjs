// M3-R3 预建计划任务的【定义生成】（plan.md §6.2）。
// 只生成 schtasks 可导入的 XML 定义 + 对照 receipt；绝不调用 schtasks /create 或 Register-ScheduledTask。
// 两个新任务均 Disabled，指向 C:\Users\Public\xw-runtime\current 的启动入口；
// 入口尚不存在时按 R1 release 布局推导，并在 receipt 标注 pending。
import { existsSync } from "node:fs";
import { join } from "node:path";

export const TASKS_PROPOSED_SCHEMA_ID = "xw.cutover.scheduled-tasks-proposed.v1";
export const RUNTIME_ROOT_DEFAULT = "C:\\Users\\Public\\xw-runtime";

export const PROPOSED_TASK_NAMES = Object.freeze([
  "XW Platform Orchestrator",
  "XW Platform Control Plane",
]);

function esc(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

// schtasks /create /xml 可导入的 Task 1.2 XML。Enabled=false 是硬编码，不允许参数覆盖。
export function buildTaskXml({ name, description, command, arguments: args, workingDirectory, logonType, runLevel }) {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>xw-platform M3-R3 (proposed, NOT registered)</Author>
    <Description>${esc(description)}</Description>
  </RegistrationInfo>
  <Triggers>
    <BootTrigger>
      <Enabled>true</Enabled>
    </BootTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>SYSTEM</UserId>
      <LogonType>${esc(logonType)}</LogonType>
      <RunLevel>${esc(runLevel)}</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <Enabled>false</Enabled>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${esc(command)}</Command>
      <Arguments>${esc(args)}</Arguments>
      <WorkingDirectory>${esc(workingDirectory)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

// 两个新任务的定义。token 类参数（--agent-token 等）不生成具体值：注册窗口由人工注入，receipt 记 pending。
export function buildProposedTasks({ runtimeRoot = RUNTIME_ROOT_DEFAULT, exists = existsSync } = {}) {
  const current = join(runtimeRoot, "current");
  const stateRoot = join(runtimeRoot, "state");
  const orchestratorEntry = join(current, "services", "orchestrator", "registry.mjs");
  const controlPlaneEntry = join(current, "services", "control-plane", "control-plane", "server.mjs");
  const controlDb = join(stateRoot, "control-plane", "control.db");
  const registryDb = join(stateRoot, "orchestrator", "registry.db");
  const runsRoot = join(stateRoot, "runs");

  const tasks = [
    {
      name: "XW Platform Control Plane",
      description: "XW Platform Control Plane (legacy_compat). Mirrors XhsDeviceControlPlaneV1; points at xw-runtime/current release.",
      state: "Disabled",
      logonType: "S4U",
      runLevel: "LeastPrivilege",
      triggers: ["BootTrigger"],
      command: "node.exe",
      arguments: `"${controlPlaneEntry}" serve`,
      workingDirectory: current,
      entry: { path: controlPlaneEntry, exists: exists(controlPlaneEntry) },
      environment: {
        CONTROL_PLANE_HOST: "127.0.0.1",
        CONTROL_PLANE_PORT: "17920",
        CONTROL_PLANE_DB: controlDb,
        CONTROL_PLANE_RUNS_ROOT: runsRoot,
        CONTROL_PLANE_STATE_DIR: join(stateRoot, "control-plane"),
        XW_RELEASE_MANIFEST: join(current, "release-manifest.v1.json"),
      },
      pending: [
        ...(exists(controlPlaneEntry) ? [] : [`入口不存在（按 R1 release 布局推导）：${controlPlaneEntry}`]),
        "schtasks XML 不支持内联 env：注册窗口需用包装脚本或机器级 env 注入以上 environment",
        "启动顺序约束：必须先于 XW Platform Orchestrator 启动（R4 runbook 负责）",
      ],
    },
    {
      name: "XW Platform Orchestrator",
      description: "XW Platform Orchestrator (legacy_compat). Mirrors XhsDeviceRegistry; points at xw-runtime/current release.",
      state: "Disabled",
      logonType: "S4U",
      runLevel: "LeastPrivilege",
      triggers: ["BootTrigger"],
      command: "node.exe",
      arguments: [
        `"${orchestratorEntry}"`,
        "--port 17930 --host 0.0.0.0",
        "--control http://127.0.0.1:17920",
        `--db "${registryDb}"`,
        `--control-db "${controlDb}"`,
        `--runs-root "${runsRoot}"`,
      ].join(" "),
      workingDirectory: current,
      entry: { path: orchestratorEntry, exists: exists(orchestratorEntry) },
      environment: {
        CONTROL_PLANE_RUNS_ROOT: runsRoot,
        CONTROL_PLANE_STATE_DIR: join(stateRoot, "control-plane"),
        XW_RELEASE_MANIFEST: join(current, "release-manifest.v1.json"),
      },
      pending: [
        ...(exists(orchestratorEntry) ? [] : [`入口不存在（按 R1 release 布局推导）：${orchestratorEntry}`]),
        "--agent-token / --human-token / --observer-token 值不生成（secret 不进 git）；注册窗口由人工从旧任务 XML/密钥来源注入",
      ],
    },
  ];
  for (const task of tasks) {
    task.xml = buildTaskXml(task);
  }
  return tasks;
}

// 与 scheduled-tasks-before.v1.json 的差异对照：旧任务保持不变；新任务全新、Disabled。
export function diffAgainstBefore({ proposed, beforeTasks }) {
  const beforeNames = new Set((beforeTasks ?? []).map((task) => task.name));
  const rows = proposed.map((task) => ({
    name: task.name,
    status: beforeNames.has(task.name) ? "NAME_COLLISION" : "new",
    legacyCounterpart: task.name === "XW Platform Orchestrator" ? "XhsDeviceRegistry" : "XhsDeviceControlPlaneV1",
    state: task.state,
    legacyStateUnchanged: true,
  }));
  return {
    newTasks: rows,
    legacyTasks: (beforeTasks ?? []).map((task) => ({ name: task.name, state: task.state ?? "unknown", action: "unchanged" })),
    collisions: rows.filter((row) => row.status === "NAME_COLLISION").map((row) => row.name),
  };
}

export function buildTasksProposedReceipt({
  runtimeRoot = RUNTIME_ROOT_DEFAULT,
  beforeTasks = [],
  exists = existsSync,
  now = () => new Date().toISOString(),
} = {}) {
  const proposed = buildProposedTasks({ runtimeRoot, exists });
  const diff = diffAgainstBefore({ proposed, beforeTasks });
  return {
    schemaId: TASKS_PROPOSED_SCHEMA_ID,
    generatedAt: now(),
    note: "仅生成定义（schtasks 可导入 XML + 本 receipt），未注册。注册属 R4 执行窗口（先禁旧任务、后启用新任务，Control Plane 先于 Orchestrator）。",
    registration: "NOT_REGISTERED",
    runtimeRoot,
    tasks: proposed.map(({ xml, ...task }) => ({ ...task, xmlFile: `proposed-tasks/${task.name}.xml` })),
    diff,
    ok: diff.collisions.length === 0,
  };
}
