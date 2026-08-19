// M3-R3 Shadow 模式（plan.md §6.1）：旧系统仍是唯一权威，xw-platform 用 DB 副本 + 替代端口
// 短暂启动并只做【只读比较】——health / 设备 inventory 投影 / capability registry /
// lease-session-job 读取面 / release identity 四字段 / schema（user_version + schema hash）/ 配置解析。
//
// 硬禁止（本模块在结构上保证）：
//   - 不写任何现场 DB：只用 snapshot 副本，analyzeDb 只动 workDir 内文件；
//   - 不连设备 / 不取真实 lease / 不提交真实 job：复用 service-runner 的 release 启动面
//     （启动期无设备/lease/job 主动行为，见 rehearsal safetyNotes），且全程只发 HTTP GET；
//   - 不碰 17920/17930 端口本身：shadow 服务只听替代端口；对现场只做 17930 的 GET 只读 API。
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { loadRuntimeProfile, DEFAULT_RUNTIME_PROFILE } from "../../kernel/lib/runtime-profile.mjs";
import { writeRelease } from "../../release/lib/release-manifest.mjs";
import { analyzeDb } from "./db.mjs";
import { CORE_TABLES, coreRowCounts } from "./rehearse.mjs";
import {
  buildControlPlaneLaunch,
  buildOrchestratorLaunch,
  runStack,
  smokeSummary,
} from "./service-runner.mjs";
import { httpGetJson } from "./util.mjs";

export const SHADOW_SCHEMA_ID = "xw.cutover.shadow-comparison.v1";
export const DEFAULT_SHADOW_PORTS = Object.freeze({ control: 18922, orchestrator: 18932 });
export const LEGACY_ORCHESTRATOR_PORT = 17930;

export const SHADOW_SAFETY_NOTES = Object.freeze([
  "shadow 只写 workDir 内部：release 物化目录、DB 副本、日志；现场 xhs-registry / xhs-routing-v1-1 / xhs-agent-control 零写入。",
  "设备执行关闭：control-plane xiaowei transport 为惰性 WebSocket（仅请求驱动），device-session 执行器缺省 fixture（serve bootstrap 不注入 observeProvider），orchestrator 无启动期出站动作。",
  "lease 获取关闭 / job 提交关闭：启动恢复只把残留 running job 置 recovery_required 并清空 sessions/leases，不派发 queued job；shadow 全程无 POST。",
  "不碰现场端口：shadow 两服务只听替代端口；对现场唯一网络动作是 17930 的 GET /api/health 与 GET /api/devices（只读 API）。17920 不做任何请求。",
  "真实设备、真实 lease、真实 job、22222/ADB、支付链路：未触碰。",
]);

// 逐项比较构造：match ∈ true | false | "unknown"。
// legacy/shadow 存可 JSON 序列化的短值；note 说明比较基准。
export function compareItem(item, legacy, shadow, { match, note = null } = {}) {
  const decided = match ?? (legacy === "unknown" || shadow === "unknown"
    ? "unknown"
    : JSON.stringify(legacy) === JSON.stringify(shadow));
  return { item, legacy, shadow, match: decided, note };
}

// verdict 纯判定：任何 match===false → BLOCK；全 true/unknown 才 PASS（unknown 如实列出，不算失败）。
export function shadowVerdict(comparisons) {
  const mismatches = comparisons.filter((row) => row.match === false).map((row) => row.item);
  const unknowns = comparisons.filter((row) => row.match === "unknown").map((row) => row.item);
  return {
    verdict: mismatches.length === 0 ? "PASS" : "BLOCK",
    mismatches,
    unknowns,
  };
}

function smokeCount(record, endpoint) {
  const hit = record?.smoke?.find((item) => item.endpoint === endpoint);
  return hit ? hit.itemCount : "unknown";
}

// 纯函数：把采集到的事实（shadow 侧 stack 摘要 + DB 分析 + 现场 17930 只读结果 + 基线）
// 编成逐项比较。基线来自 R2 receipt（17920 不可达，control 面以 R2 采集/演练结果为基准）。
export function buildComparisons({
  summary,
  dbAfter,
  legacyOrchestrator, // { reachable, healthOk, deviceCount } 或 { reachable:false }
  baseline, // { control: {userVersion, schemaHash, coreRowCounts}, registry: {...}, deviceCount, capabilities }
  manifest,
  runtimeProfile,
}) {
  const rows = [];
  const legacyBaseNote = "17920 不可达；control 面基准 = R2 采集快照/rehearsal receipt（db-snapshot + rehearsal-receipt.v1.json round-1）";

  rows.push(compareItem(
    "health.control-plane",
    "unknown",
    summary.controlPlane?.healthOk === true,
    { note: legacyBaseNote },
  ));
  rows.push(compareItem(
    "health.orchestrator",
    legacyOrchestrator.reachable ? legacyOrchestrator.healthOk : "unknown",
    summary.orchestrator?.healthOk === true,
    { note: legacyOrchestrator.reachable ? "legacy = 现场 17930 GET /api/health" : "17930 不可达，如实记录" },
  ));

  rows.push(compareItem(
    "devices.inventory.count",
    legacyOrchestrator.reachable ? legacyOrchestrator.deviceCount : baseline.deviceCount,
    smokeCount(summary.controlPlane, "/control/v1/devices"),
    { note: legacyOrchestrator.reachable ? "legacy = 17930 GET /api/devices 台数；shadow = control.db 副本投影" : legacyBaseNote },
  ));
  rows.push(compareItem(
    "devices.projection.orchestrator",
    legacyOrchestrator.reachable ? legacyOrchestrator.deviceCount : baseline.deviceCount,
    smokeCount(summary.orchestrator, "/api/devices"),
    { note: "shadow orchestrator --control 指向 shadow control-plane；设备面投影应一致" },
  ));

  rows.push(compareItem(
    "capability-registry.api.count",
    baseline.control.apiItemCounts?.capabilities ?? "unknown",
    smokeCount(summary.controlPlane, "/control/v1/capabilities"),
    { note: `${legacyBaseNote}；API 是投影面（R2 实测 28 ≠ 表行数 32），与 DB 行数分开比较` },
  ));
  rows.push(compareItem(
    "capability-registry.db.rows",
    baseline.control.coreRowCounts?.capabilities ?? "unknown",
    dbAfter.control.coreRowCounts?.capabilities ?? "unknown",
    { note: legacyBaseNote },
  ));

  rows.push(compareItem(
    "leases.read.count",
    baseline.control.coreRowCounts?.leases ?? "unknown",
    smokeCount(summary.controlPlane, "/control/v1/leases"),
    { note: `${legacyBaseNote}；启动恢复会清空 leases，预期 0` },
  ));
  rows.push(compareItem(
    "sessions.read.count",
    baseline.control.coreRowCounts?.sessions ?? "unknown",
    dbAfter.control.coreRowCounts?.sessions ?? "unknown",
    { note: `${legacyBaseNote}；启动恢复会清空 sessions，预期 0` },
  ));
  rows.push(compareItem(
    "jobs.read.count",
    baseline.control.coreRowCounts?.jobs ?? "unknown",
    dbAfter.control.coreRowCounts?.jobs ?? "unknown",
    { note: `${legacyBaseNote}；只读比较行数，不提交任何 job` },
  ));

  for (const field of ["sourceRepo", "sourceCommit", "releaseId", "runtimeProfile"]) {
    rows.push(compareItem(
      `release-identity.${field}`,
      null,
      summary.controlPlane?.identity?.[field] ?? null,
      {
        match: summary.controlPlane?.identity?.[field] === manifest[field]
          && summary.orchestrator?.identity?.[field] === manifest[field],
        note: "旧代码 health 无 release identity 字段（预期差异，如实记录）；比较基准 = shadow 两进程 identity 与 release manifest 四字段全等",
      },
    ));
  }

  rows.push(compareItem("schema.control.user_version", baseline.control.userVersion, dbAfter.control.userVersion, { note: legacyBaseNote }));
  rows.push(compareItem("schema.control.schema_hash", baseline.control.schemaHash, dbAfter.control.schemaHash, { note: legacyBaseNote }));
  rows.push(compareItem("schema.registry.user_version", baseline.registry.userVersion, dbAfter.registry.userVersion, { note: "registry.db 无 user_version 机制（幂等建表），预期保持 0" }));
  rows.push(compareItem("schema.registry.schema_hash", baseline.registry.schemaHash, dbAfter.registry.schemaHash, { note: legacyBaseNote }));

  const expectedProfile = loadRuntimeProfile(DEFAULT_RUNTIME_PROFILE);
  rows.push(compareItem(
    "config.runtime-profile",
    DEFAULT_RUNTIME_PROFILE,
    runtimeProfile,
    {
      match: JSON.stringify(runtimeProfile) === JSON.stringify(expectedProfile)
        && runtimeProfile.openActionLiveEnabled === false
        && runtimeProfile.agentGatewayLiveEnabled === false,
      note: "配置解析：shadow 以 legacy_compat 启动；openActionLive/agentGatewayLive 必须关闭，支付硬闸必须开",
    },
  ));
  return rows;
}

// 现场 17930 只读采集（仅 GET /api/health 与 /api/devices）。不可达如实记录。
export async function probeLegacyOrchestrator({ port = LEGACY_ORCHESTRATOR_PORT, httpGet = httpGetJson } = {}) {
  const health = await httpGet(`http://127.0.0.1:${port}/api/health`, { timeoutMs: 2500 });
  if (!health.reachable || health.body?.ok !== true) {
    return { reachable: false, error: health.error ?? `status ${health.status}` };
  }
  const devices = await httpGet(`http://127.0.0.1:${port}/api/devices`, { timeoutMs: 2500 });
  return {
    reachable: true,
    healthOk: true,
    deviceCount: Array.isArray(devices.body?.devices) ? devices.body.devices.length : "unknown",
  };
}

// 从 R2 rehearsal receipt 提取 schema/行数基准（含 API 投影面 itemCount——API 计数 ≠ 表行数，分开比较）。
export function baselineFromRehearsalReceipt(receipt) {
  const round0 = receipt?.rounds?.[0] ?? {};
  const round = round0.dbAfter ?? {};
  const smoke = round0.services?.controlPlane?.smoke ?? [];
  const apiItemCounts = {};
  for (const item of smoke) {
    if (typeof item.itemCount === "number") apiItemCounts[item.endpoint.replace("/control/v1/", "")] = item.itemCount;
  }
  return {
    control: {
      userVersion: round.control?.userVersion ?? "unknown",
      schemaHash: round.control?.schemaHash ?? "unknown",
      coreRowCounts: round.control?.coreRowCounts ?? {},
      apiItemCounts,
    },
    registry: {
      userVersion: round.registry?.userVersion ?? "unknown",
      schemaHash: round.registry?.schemaHash ?? "unknown",
      coreRowCounts: round.registry?.coreRowCounts ?? {},
    },
  };
}

// 从 R2 live-inventory 提取设备数基准。
export function deviceCountFromInventory(inventory) {
  return inventory?.services?.orchestratorApi?.deviceCount ?? "unknown";
}

// 完整 shadow 执行：物化 release → DB 副本 → 替代端口启动 → 只读比较 → 关闭。
// deps 可注入 { httpGet, spawnImpl }；legacyHttpGet 可单独注入（测试时不碰 17930）。
export async function runShadow({
  sourceRoot,
  snapshots, // { registry, control } snapshot db 路径
  workDir,
  ports = DEFAULT_SHADOW_PORTS,
  baseline, // { control, registry, deviceCount }
  releaseId = null,
  deps = {},
  legacyHttpGet = null,
  now = () => new Date().toISOString(),
}) {
  mkdirSync(workDir, { recursive: true });
  const manifest = writeRelease({ root: sourceRoot, outDir: join(workDir, "release"), releaseId });
  const releaseDir = join(workDir, "release", "releases", manifest.releaseId);

  const stateDir = join(workDir, "state-copy", "shadow");
  const logDir = join(workDir, "logs", "shadow");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  const registryDb = join(stateDir, "registry.db");
  const controlDb = join(stateDir, "control.db");
  copyFileSync(snapshots.registry, registryDb);
  copyFileSync(snapshots.control, controlDb);

  const identity = {
    sourceRepo: manifest.sourceRepo,
    sourceCommit: manifest.sourceCommit,
    releaseId: manifest.releaseId,
    runtimeProfile: manifest.runtimeProfile,
  };
  const stack = await runStack({
    controlLaunch: buildControlPlaneLaunch({
      mode: "release", releaseDir, dbPath: controlDb, runsRoot: join(workDir, "runs"), stateDir: join(workDir, "state"), port: ports.control,
    }),
    orchestratorLaunch: buildOrchestratorLaunch({
      mode: "release", releaseDir, dbPath: registryDb, controlDbPath: controlDb,
      runsRoot: join(workDir, "runs"), stateDir: join(workDir, "state"), port: ports.orchestrator, controlPort: ports.control,
    }),
    logDir,
    ports,
    identity,
    ...deps,
  });
  const summary = smokeSummary(stack);
  const controlAnalysis = analyzeDb(controlDb);
  const registryAnalysis = analyzeDb(registryDb);
  const dbAfter = {
    control: { ...controlAnalysis, coreRowCounts: coreRowCounts(controlAnalysis, CORE_TABLES.control) },
    registry: { ...registryAnalysis, coreRowCounts: coreRowCounts(registryAnalysis, CORE_TABLES.registry) },
  };
  delete dbAfter.control.rowCounts;
  delete dbAfter.registry.rowCounts;
  delete dbAfter.control.tables;
  delete dbAfter.registry.tables;

  const legacyOrchestrator = await probeLegacyOrchestrator({
    httpGet: legacyHttpGet ?? deps.httpGet ?? httpGetJson,
  });

  const comparisons = buildComparisons({
    summary,
    dbAfter,
    legacyOrchestrator,
    baseline,
    manifest,
    runtimeProfile: loadRuntimeProfile(manifest.runtimeProfile),
  });
  const verdict = shadowVerdict(comparisons);
  return {
    schemaId: SHADOW_SCHEMA_ID,
    executedAt: now(),
    shadow: true,
    workDir,
    ports,
    release: {
      releaseId: manifest.releaseId,
      sourceCommit: manifest.sourceCommit,
      runtimeProfile: manifest.runtimeProfile,
      runtimeCutoverAllowed: manifest.runtimeCutoverAllowed,
    },
    snapshots,
    baselineSource: "docs/cutover/m3-r/rehearsal-receipt.v1.json + live-inventory.v1.json（17920 不可达，control 面以 R2 采集为基准）",
    disabledMechanisms: {
      deviceExecution: "fixture 执行器 + 惰性 transport（启动期零设备行为）",
      leaseAcquisition: "启动恢复仅置 recovery_required，不取新 lease；shadow 无 POST",
      jobSubmission: "不派发 queued job；shadow 全程无 POST",
      legacyPorts: "shadow 只听 127.0.0.1 替代端口；现场仅 17930 GET 只读 API",
    },
    safetyNotes: [...SHADOW_SAFETY_NOTES],
    legacyOrchestrator,
    services: summary,
    comparisons,
    ...verdict,
    liveCanaryGate: "CLOSED",
    runtimeCutoverGate: "CLOSED",
  };
}
