// M3-R2 回滚演练（plan.md §5.4）：实际证明
//   xw-platform rehearsal 启动并完成 migration → 停止 → 从 snapshot 恢复旧 DB 副本
//   → 用旧代码（现场 checkout，只读执行，不写旧目录）启动 → health 恢复。
// 只有实际恢复成功才 ROLLBACK_GATE=PASS；任何失败如实 BLOCK。
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { analyzeDb } from "./db.mjs";
import { CONTROL_PLANE_CHECKOUT, ORCHESTRATOR_CHECKOUT } from "./live-collect.mjs";
import {
  buildControlPlaneLaunch,
  buildOrchestratorLaunch,
  runStack,
  smokeSummary,
} from "./service-runner.mjs";
import { execText, tryExec } from "./util.mjs";

export const ROLLBACK_SCHEMA_ID = "xw.cutover.rollback-certification.v1";
export const DEFAULT_ROLLBACK_PORTS = Object.freeze({
  xw: { control: 18922, orchestrator: 18932 },
  legacy: { control: 18921, orchestrator: 18931 },
});

// 纯判定：所有步骤 ok 才 PASS。
export function decideRollbackGate(steps) {
  const failed = steps.filter((step) => !step.ok);
  return {
    gate: failed.length === 0 && steps.length > 0 ? "PASS" : "BLOCK",
    failedSteps: failed.map((step) => ({ step: step.step, detail: step.detail ?? null })),
  };
}

function legacyCheckoutFacts(exec) {
  const facts = {};
  for (const [name, path] of Object.entries({ orchestrator: ORCHESTRATOR_CHECKOUT, controlPlane: CONTROL_PLANE_CHECKOUT })) {
    const head = tryExec("git", ["-C", path, "rev-parse", "HEAD"], { exec });
    const status = tryExec("git", ["-C", path, "status", "--porcelain"], { exec });
    facts[name] = {
      checkout: path,
      headSha: head.ok ? head.stdout : "unknown",
      // 旧现场工作树带 WIP（orchestrator 约 108 个）；只读执行工作树代码 = 现场实际运行的代码，不清理不提交。
      dirtyFileCount: status.ok ? status.stdout.split(/\r?\n/).filter(Boolean).length : "unknown",
    };
  }
  return facts;
}

export async function runRollbackDrill({
  releaseDir,
  manifest,
  snapshots, // { registry, control } snapshot db 路径
  workDir,
  ports = DEFAULT_ROLLBACK_PORTS,
  legacy = { orchestratorRoot: ORCHESTRATOR_CHECKOUT, controlPlaneRoot: CONTROL_PLANE_CHECKOUT },
  deps = {},
  exec = execText,
  now = () => new Date().toISOString(),
}) {
  const steps = [];
  const stateDir = join(workDir, "rollback-state");
  const runsRoot = join(workDir, "rollback-runs");
  const sharedStateDir = join(workDir, "rollback-cp-state");
  const registryDb = join(stateDir, "registry.db");
  const controlDb = join(stateDir, "control.db");
  mkdirSync(stateDir, { recursive: true });

  // 步骤 1：从 snapshot 恢复工作副本（rollback 单元 = 旧代码 + 旧 DB snapshot + 旧 launch 配置）。
  copyFileSync(snapshots.registry, registryDb);
  copyFileSync(snapshots.control, controlDb);
  const restored = {
    registry: analyzeDb(registryDb),
    control: analyzeDb(controlDb),
  };
  steps.push({
    step: "restore-from-snapshot",
    ok: restored.registry.integrityCheck === "ok" && restored.control.integrityCheck === "ok",
    detail: `registry user_version=${restored.registry.userVersion}, control user_version=${restored.control.userVersion}`,
  });

  // 步骤 2：xw-platform release 启动（migration 自然发生）→ health → 停止。
  let xwStack = null;
  try {
    xwStack = await runStack({
      controlLaunch: buildControlPlaneLaunch({
        mode: "release", releaseDir, dbPath: controlDb, runsRoot, stateDir: sharedStateDir, port: ports.xw.control,
      }),
      orchestratorLaunch: buildOrchestratorLaunch({
        mode: "release", releaseDir, dbPath: registryDb, controlDbPath: controlDb,
        runsRoot, stateDir: sharedStateDir, port: ports.xw.orchestrator, controlPort: ports.xw.control,
      }),
      logDir: join(workDir, "logs", "rollback-xw"),
      ports: ports.xw,
      identity: {
        sourceRepo: manifest.sourceRepo,
        sourceCommit: manifest.sourceCommit,
        releaseId: manifest.releaseId,
        runtimeProfile: manifest.runtimeProfile,
      },
      ...deps,
    });
    const summary = smokeSummary(xwStack);
    steps.push({ step: "xw-platform-boot-and-migrate", ok: summary.ok, detail: summary.failed ? `${summary.failed.stage}: ${summary.failed.error}` : "health ok" });
  } catch (error) {
    steps.push({ step: "xw-platform-boot-and-migrate", ok: false, detail: error.message });
  }
  const migrated = {
    registry: safeAnalyze(registryDb),
    control: safeAnalyze(controlDb),
  };

  // 步骤 3：停止后再次从 snapshot 恢复旧 DB（只切回旧代码不恢复旧 DB 不算完整回滚）。
  copyFileSync(snapshots.registry, registryDb);
  copyFileSync(snapshots.control, controlDb);
  const restoredBack = { registry: safeAnalyze(registryDb), control: safeAnalyze(controlDb) };
  steps.push({
    step: "restore-old-db-snapshot",
    ok: restoredBack.registry.userVersion === restored.registry.userVersion
      && restoredBack.control.userVersion === restored.control.userVersion
      && restoredBack.control.integrityCheck === "ok"
      && restoredBack.registry.integrityCheck === "ok",
    detail: `control user_version back to ${restoredBack.control.userVersion} (migrated was ${migrated.control.userVersion})`,
  });

  // 步骤 4：旧代码启动（只读执行现场 checkout；DB/runs/state 全部在 rehearsal 目录，替代端口）。
  let legacyStack = null;
  try {
    legacyStack = await runStack({
      controlLaunch: buildControlPlaneLaunch({
        mode: "legacy", legacyRoot: legacy.controlPlaneRoot, dbPath: controlDb, runsRoot, stateDir: sharedStateDir, port: ports.legacy.control,
      }),
      orchestratorLaunch: buildOrchestratorLaunch({
        mode: "legacy", legacyRoot: legacy.orchestratorRoot, dbPath: registryDb, controlDbPath: controlDb,
        runsRoot, stateDir: sharedStateDir, port: ports.legacy.orchestrator, controlPort: ports.legacy.control,
      }),
      logDir: join(workDir, "logs", "rollback-legacy"),
      ports: ports.legacy,
      identity: null,
      ...deps,
    });
    const summary = smokeSummary(legacyStack);
    steps.push({ step: "legacy-code-boot", ok: summary.ok, detail: summary.failed ? `${summary.failed.stage}: ${summary.failed.error}` : "health ok" });
    steps.push({
      step: "legacy-health-restored",
      ok: summary.ok && summary.controlPlane.healthOk && summary.orchestrator.healthOk,
      detail: summary.ok ? "control-plane authority + orchestrator health ok on restored snapshot" : "legacy health not fully restored",
    });
  } catch (error) {
    steps.push({ step: "legacy-code-boot", ok: false, detail: error.message });
    steps.push({ step: "legacy-health-restored", ok: false, detail: "skipped (legacy boot failed)" });
  }

  const verdict = decideRollbackGate(steps);
  return {
    schemaId: ROLLBACK_SCHEMA_ID,
    certifiedAt: now(),
    workDir,
    ports,
    snapshots,
    rollbackUnit: "旧代码 + 旧 DB snapshot + 旧 launch 配置（计划任务 XML 见 scheduled-tasks-before.v1.json）",
    legacyCheckouts: legacyCheckoutFacts(exec),
    migration: {
      controlUserVersionBefore: restored.control.userVersion,
      controlUserVersionAfterXw: migrated.control.userVersion,
      controlUserVersionRestored: restoredBack.control.userVersion,
      registryUserVersionBefore: restored.registry.userVersion,
    },
    steps,
    rollbackGate: verdict.gate,
    failedSteps: verdict.failedSteps,
    safetyNotes: [
      "旧 checkout 全程只读执行；DB/runs/state 均位于 rehearsal 工作目录，旧目录零写入。",
      "现场 17920/17930 进程与计划任务未触碰；rehearsal 使用替代端口。",
      "未连真实设备、未取真实 lease、未提交真实 job、未碰 22222/ADB、未碰支付。",
    ],
  };
}

function safeAnalyze(path) {
  try {
    return analyzeDb(path);
  } catch (error) {
    return { userVersion: "unknown", integrityCheck: `error: ${error.message}`, schemaHash: null, tableCount: null, rowCounts: {} };
  }
}
