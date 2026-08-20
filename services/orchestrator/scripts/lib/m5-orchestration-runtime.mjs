import path from "node:path";
import { pathToFileURL } from "node:url";
import { TraceStore } from "../../../../packages/harness-protocol/lib/trace-store.mjs";
import { compileDag } from "./dag-compiler.mjs";
import { OrchestrationTraceBridge } from "./orchestration-trace-bridge.mjs";
import { loadM5SkillCatalog } from "./skill-catalog.mjs";
import { classifyTask, classificationHash } from "./task-router.mjs";
import { createTaskPlanV2 } from "./task-plan-v2.mjs";
import { bindTaskPlanToLiveCapabilities } from "./task-plan-capability-binding.mjs";
import { runTaskOrchestrator } from "./task-orchestrator.mjs";

function fail(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  throw error;
}

function normalizeAliases(aliases = []) {
  if (!Array.isArray(aliases)) fail("M5_ALIAS_INVALID", "aliases must be an array");
  const normalized = [...new Set(aliases.map(String))].sort();
  if (normalized.some((alias) => !/^0[1-4]$/.test(alias))) fail("M5_ALIAS_INVALID", "aliases must contain only 01..04");
  return normalized;
}

export async function planM5Goal({ goal, aliases = [], traceId = null, catalog = null, repoRoot } = {}) {
  const registeredCatalog = catalog || await loadM5SkillCatalog({ ...(repoRoot ? { repoRoot } : {}) });
  const targetAliases = normalizeAliases(aliases);
  const classification = classifyTask({
    goal,
    catalog: registeredCatalog,
    devices: targetAliases.length || 4,
    aliases: targetAliases,
  });
  if (classification.taskType === "needs_human") {
    return { ok: false, executionReady: false, classification, dag: null, catalog: registeredCatalog };
  }
  const resolvedTraceId = traceId || `dry_${classificationHash(classification).slice(0, 24)}`;
  const dag = compileDag({ classification, catalog: registeredCatalog, aliases: targetAliases, traceId: resolvedTraceId });
  return { ok: true, executionReady: dag.executionReady, classification, dag, catalog: registeredCatalog };
}

export function lowerM5DagToTaskPlan({ dag, catalog, goal }) {
  if (!dag || dag.schemaId !== "xw.orchestration.dag.v1") fail("M5_DAG_REQUIRED", "canonical M5 DAG is required");
  if (!dag.executionReady) fail("M5_WAIT_HUMAN", "DAG is not execution-ready without human approval");
  const bySkill = new Map((catalog || []).map((entry) => [entry.skillId, entry]));
  const validatorNodes = dag.nodes.filter((node) => node.localValidator);
  if (validatorNodes.length > 1) fail("M5_VALIDATOR_INVALID", "M5 DAG supports exactly one terminal local validator");
  const validatorNode = validatorNodes[0] || null;
  const primaryNodes = dag.nodes.filter((node) => !node.localValidator);
  const primaryIds = new Set(primaryNodes.map((node) => node.nodeId));
  const skillByNode = {};
  const authoringNodes = primaryNodes.map((node) => {
    const registration = bySkill.get(node.skillId);
    if (!registration || registration.executor?.kind !== "capability") {
      fail("M5_EXECUTOR_BINDING", `node ${node.nodeId} has no registered capability executor`);
    }
    if (node.targetAliases.length > 1) fail("M5_ALIAS_INVALID", `node ${node.nodeId} must target at most one alias`);
    skillByNode[node.nodeId] = node.skillId;
    return {
      nodeId: node.nodeId,
      dependsOn: node.dependsOn.filter((dependency) => primaryIds.has(dependency)),
      executor: {
        kind: "typed_job",
        capabilityId: registration.executor.capabilityId,
        appId: registration.executor.capabilityId.split(".")[0],
        replaySafety: "read_only",
        effectClass: node.requiresHuman ? "external_effect" : "none",
        resources: ["device"],
      },
      shards: [{
        params: structuredClone(node.inputs),
        placement: node.targetAliases.length ? { alias: node.targetAliases[0] } : {},
      }],
    };
  });
  if (authoringNodes.length === 0) fail("M5_NO_DEVICE_WORK", "M5 execution requires at least one device node");
  const taskPlan = createTaskPlanV2({
    goal: String(goal || dag.taskType),
    requestKey: `m5:${dag.planHash}`,
    nodes: authoringNodes,
    execution: {
      maxWorkers: Math.min(4, authoringNodes.length),
      allowReassign: !primaryNodes.some((node) => node.targetAliases.length > 0),
      maxAttemptsPerShard: 2,
    },
  });
  const expectedAliases = [...new Set(primaryNodes.flatMap((node) => node.targetAliases))].sort();
  return {
    taskPlan,
    skillByNode,
    validatorNode,
    expectedAliases,
  };
}

async function loadValidator({ validatorNode, catalog, repoRoot }) {
  if (!validatorNode) return null;
  const registration = catalog.find((entry) => entry.skillId === validatorNode.skillId);
  if (!registration?.localValidator || registration.executor?.kind !== "local") {
    fail("M5_VALIDATOR_BINDING", `validator ${validatorNode.skillId} is not a registered local executor`);
  }
  const root = path.resolve(repoRoot || path.resolve(import.meta.dirname, "../../../.."));
  const modulePath = path.resolve(root, registration.executor.module);
  const relative = path.relative(root, modulePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) fail("M5_VALIDATOR_BINDING", "validator module escapes repository root");
  const imported = await import(pathToFileURL(modulePath).href);
  const validator = imported[registration.executor.exportName];
  if (typeof validator !== "function") fail("M5_VALIDATOR_BINDING", "registered validator export is not callable");
  return validator;
}

export async function executeM5Goal({
  goal,
  aliases = [],
  traceId,
  taskRunId,
  catalog = null,
  liveCatalog,
  fleetProvider,
  worker,
  store,
  traceStore = new TraceStore(),
  repoRoot,
} = {}) {
  if (!taskRunId) fail("M5_TASK_RUN_REQUIRED", "taskRunId is required");
  if (!traceId) fail("M5_TRACE_REQUIRED", "traceId is required for execution");
  if (!Array.isArray(liveCatalog)) fail("M5_LIVE_CATALOG_REQUIRED", "live capability catalog is required");
  const planned = await planM5Goal({ goal, aliases, traceId, catalog, repoRoot });
  if (!planned.ok) fail("M5_NEEDS_HUMAN", planned.classification.needsHumanReason || "goal needs human clarification");
  if (!planned.executionReady) fail("M5_WAIT_HUMAN", "DAG requires human approval before execution");
  const lowered = lowerM5DagToTaskPlan({ dag: planned.dag, catalog: planned.catalog, goal });
  const bound = bindTaskPlanToLiveCapabilities(lowered.taskPlan, liveCatalog);
  const validator = await loadValidator({ validatorNode: lowered.validatorNode, catalog: planned.catalog, repoRoot });
  const traceBridge = new OrchestrationTraceBridge({
    traceId,
    taskRunId,
    traceStore,
    skillByNode: lowered.skillByNode,
    validationNode: lowered.validatorNode,
  });
  traceBridge.begin({ taskType: planned.dag.taskType, dagId: planned.dag.dagId, planHash: planned.dag.planHash });
  const result = await runTaskOrchestrator({
    taskRunId,
    plan: lowered.taskPlan,
    executionPlan: bound.executionPlan,
    executionPlanHash: bound.executionPlanHash,
    fleetProvider,
    worker,
    store,
    traceBridge,
    resultValidator: validator
      ? (missionResult) => validator({ results: missionResult.results, expectedAliases: lowered.expectedAliases })
      : null,
  });
  return {
    ...result,
    traceId,
    dagId: planned.dag.dagId,
    dagPlanHash: planned.dag.planHash,
    executionPlanHash: bound.executionPlanHash,
  };
}
