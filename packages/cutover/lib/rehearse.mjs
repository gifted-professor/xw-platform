// M3-R2 三轮 DB rehearsal（plan.md §5.3）与 receipt 生成。
// 流程（每轮）：DB snapshot 副本 → xw-platform legacy_compat release → 替代端口启动两服务
//   → schema migration 自然发生 → health（含 release identity）→ 只读冒烟 → 关闭 → integrity_check。
// 三轮一致性（schema hash / 表数量 / 关键行数 / 无新增失败）决定 REHEARSAL_GATE。
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { writeRelease } from "../../release/lib/release-manifest.mjs";
import { analyzeDb } from "./db.mjs";
import {
  buildControlPlaneLaunch,
  buildOrchestratorLaunch,
  runStack,
  smokeSummary,
} from "./service-runner.mjs";

export const REHEARSAL_SCHEMA_ID = "xw.cutover.rehearsal.v1";
export const REHEARSAL_ROOT = "C:\\Users\\Public\\xw-cutover-rehearsal";
export const DEFAULT_REHEARSAL_PORTS = Object.freeze({ control: 18920, orchestrator: 18930 });

// 关键行数：跨轮必须一致的表（不存在的表记 "absent"）。
export const CORE_TABLES = Object.freeze({
  control: ["devices", "capabilities", "jobs", "leases", "sessions"],
  registry: ["identities", "knowledge"],
});

export const REHEARSAL_SAFETY_NOTES = Object.freeze([
  "两服务启动期均无 ADB/22222/lease/job 主动行为：control-plane 的 xiaowei transport 为惰性 WebSocket（仅请求驱动），device-session 执行器缺省为 fixture（serve bootstrap 不注入 observeProvider）；orchestrator 无任何启动期出站动作。",
  "control-plane 启动恢复会把残留 running job 置 recovery_required 并清空 sessions/leases，不会派发 queued job。",
  "orchestrator --control 指向 rehearsal 端口，不接触现场 17920/17930。",
  "全程未调用任何 POST/审批/支付端点；仅 GET health/devices/capabilities/leases。",
  "真实设备、真实 lease、真实 job、22222/ADB、支付链路：未触碰。",
]);

export function coreRowCounts(analysis, coreTables) {
  const out = {};
  for (const table of coreTables) {
    out[table] = analysis.rowCounts && table in analysis.rowCounts ? analysis.rowCounts[table] : "absent";
  }
  return out;
}

// 纯函数：比较三轮结果。任何不一致/失败都会列出原因；绝不手写 PASS。
export function compareRounds(rounds) {
  const diffs = [];
  if (rounds.length < 2) diffs.push(`rounds < 2 (got ${rounds.length})`);
  for (const round of rounds) {
    if (!round.ok) diffs.push(`round ${round.round}: not ok (${round.failure ?? "smoke/integrity failed"})`);
    for (const dbName of ["control", "registry"]) {
      if (round.dbAfter?.[dbName]?.integrityCheck !== "ok") {
        diffs.push(`round ${round.round}: ${dbName}.db integrity_check=${round.dbAfter?.[dbName]?.integrityCheck ?? "missing"}`);
      }
    }
  }
  const [first, ...rest] = rounds;
  if (first) {
    for (const round of rest) {
      for (const dbName of ["control", "registry"]) {
        const a = first.dbAfter?.[dbName];
        const b = round.dbAfter?.[dbName];
        if (a?.schemaHash !== b?.schemaHash) diffs.push(`${dbName}.schemaHash drift: round ${first.round} vs round ${round.round}`);
        if (a?.tableCount !== b?.tableCount) diffs.push(`${dbName}.tableCount drift: ${a?.tableCount} vs ${b?.tableCount}`);
        if (a?.userVersion !== b?.userVersion) diffs.push(`${dbName}.userVersion drift: ${a?.userVersion} vs ${b?.userVersion}`);
        const coreA = JSON.stringify(a?.coreRowCounts ?? null);
        const coreB = JSON.stringify(b?.coreRowCounts ?? null);
        if (coreA !== coreB) diffs.push(`${dbName}.coreRowCounts drift: round ${first.round} vs round ${round.round}`);
      }
    }
  }
  return { consistent: diffs.length === 0, diffs };
}

export function rehearsalVerdict(rounds) {
  const comparison = compareRounds(rounds);
  return {
    gate: comparison.consistent && rounds.every((round) => round.ok) && rounds.length >= 1 ? "PASS" : "BLOCK",
    consistent: comparison.consistent,
    diffs: comparison.diffs,
  };
}

async function runOneRound({ round, releaseDir, manifest, snapshots, workDir, ports, deps }) {
  const roundDir = join(workDir, "state-copy", `round-${round}`);
  const logDir = join(workDir, "logs", `round-${round}`);
  mkdirSync(roundDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  const registryDb = join(roundDir, "registry.db");
  const controlDb = join(roundDir, "control.db");
  copyFileSync(snapshots.registry, registryDb);
  copyFileSync(snapshots.control, controlDb);
  const runsRoot = join(workDir, "runs", `round-${round}`);
  const stateDir = join(workDir, "state");
  const identity = {
    sourceRepo: manifest.sourceRepo,
    sourceCommit: manifest.sourceCommit,
    releaseId: manifest.releaseId,
    runtimeProfile: manifest.runtimeProfile,
  };
  const stack = await runStack({
    controlLaunch: buildControlPlaneLaunch({
      mode: "release", releaseDir, dbPath: controlDb, runsRoot, stateDir, port: ports.control,
    }),
    orchestratorLaunch: buildOrchestratorLaunch({
      mode: "release", releaseDir, dbPath: registryDb, controlDbPath: controlDb,
      runsRoot, stateDir, port: ports.orchestrator, controlPort: ports.control,
    }),
    logDir,
    ports,
    identity,
    ...deps,
  });
  const summary = smokeSummary(stack);
  const controlAnalysis = analyzeDb(controlDb);
  const registryAnalysis = analyzeDb(registryDb);
  return {
    round,
    ok: summary.ok && controlAnalysis.integrityCheck === "ok" && registryAnalysis.integrityCheck === "ok",
    failure: summary.failed ? `${summary.failed.stage}: ${summary.failed.error}` : null,
    services: summary,
    dbAfter: {
      control: {
        ...pickAnalysis(controlAnalysis),
        coreRowCounts: coreRowCounts(controlAnalysis, CORE_TABLES.control),
      },
      registry: {
        ...pickAnalysis(registryAnalysis),
        coreRowCounts: coreRowCounts(registryAnalysis, CORE_TABLES.registry),
      },
    },
  };
}

function pickAnalysis(analysis) {
  return {
    userVersion: analysis.userVersion,
    integrityCheck: analysis.integrityCheck,
    schemaHash: analysis.schemaHash,
    tableCount: analysis.tableCount,
  };
}

// 完整 rehearsal：物化 release → 三轮。deps 可注入 { httpGet, spawnImpl } 便于测试。
export async function runRehearsal({
  sourceRoot,
  snapshots, // { registry: <snapshot db path>, control: <snapshot db path> }
  workDir,
  rounds = 3,
  ports = DEFAULT_REHEARSAL_PORTS,
  releaseId = null,
  deps = {},
  now = () => new Date().toISOString(),
}) {
  for (const [name, path] of Object.entries(snapshots)) {
    if (!path || !existsSync(path)) throw new Error(`REHEARSAL: missing ${name} snapshot at ${path ?? "unknown"}`);
  }
  mkdirSync(workDir, { recursive: true });
  const manifest = writeRelease({ root: sourceRoot, outDir: join(workDir, "release"), releaseId });
  const releaseDir = join(workDir, "release", "releases", manifest.releaseId);
  const roundResults = [];
  for (let round = 1; round <= rounds; round += 1) {
    roundResults.push(await runOneRound({ round, releaseDir, manifest, snapshots, workDir, ports, deps }));
  }
  const verdict = rehearsalVerdict(roundResults);
  return {
    schemaId: REHEARSAL_SCHEMA_ID,
    rehearsalId: `reh-${now().replaceAll(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-")}`,
    startedAt: now(),
    sourceRoot,
    workDir,
    ports,
    release: {
      releaseId: manifest.releaseId,
      sourceCommit: manifest.sourceCommit,
      sourceTreeSha: manifest.sourceTreeSha,
      runtimeProfile: manifest.runtimeProfile,
      runtimeCutoverAllowed: manifest.runtimeCutoverAllowed,
    },
    snapshots,
    safetyNotes: [...REHEARSAL_SAFETY_NOTES],
    envRecord: {
      controlPlane: "CONTROL_PLANE_PORT/HOST=127.0.0.1 替代端口; CONTROL_PLANE_DB/RUNS_ROOT/STATE_DIR 指向 rehearsal; XW_RELEASE_MANIFEST 指向 rehearsal release manifest",
      orchestrator: "--port/--control/--db/--control-db/--runs-root 全部指向 rehearsal; XW_RELEASE_MANIFEST 同上",
    },
    rounds: roundResults,
    consistency: verdict,
    rehearsalGate: verdict.gate,
  };
}
