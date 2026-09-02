import {
  XHS_RPA_CATALOG_SCHEMA_ID,
  XHS_RPA_BUDGET_POLICY,
  XHS_RPA_EVIDENCE_POLICY,
  XHS_RPA_FAILURE_POLICY,
  XHS_RPA_FORBIDDEN_ACTIONS,
  XHS_RPA_MISFIRE_POLICY,
  XHS_RPA_PROGRAM_SCHEMA_ID,
  XHS_RPA_RETENTION_POLICY,
  XHS_RPA_SEED_POLICY,
  canonicalXhsRpaJson,
  hashXhsRpa,
  reproduceXhsRpaTaskPlan,
} from "./xhs-rpa-program.mjs";

export const XHS_RPA_M5_ADAPTER_ID = "xw.xhs.rpa-to-m5.v1";

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function exact(value, keys) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && Object.keys(value).every((key) => keys.includes(key)));
}

const PROGRAM_KEYS = [
  "schemaId", "schemaVersion", "programId", "programVersion", "ownerRef", "generation",
  "rollbackGeneration", "enabled", "recurringEnabled", "accountRef", "externalEffects",
  "writeTransportBudget", "forbiddenActions", "runtime", "schedule", "pacing", "seedPolicy",
  "budgetPolicy", "failurePolicy", "misfirePolicy", "evidencePolicy", "retentionPolicy",
  "nodes", "edges", "dagHash", "taskPlanHash", "programHash",
];
const PROCEDURE_KEY = /(?:shell|command|executable|module|path|file|endpoint|url|host|port|coordinate|^x$|^y$|transport|adb|serial|token|secret|alias|provider|role|edata)/i;

function assertSafeParams(value, pointer) {
  if (typeof value === "string") {
    if (XHS_RPA_FORBIDDEN_ACTIONS.includes(value.toLowerCase())) {
      fail("XHS_RPA_TRANSITIVE_EFFECT_FORBIDDEN", `forbidden action value at ${pointer}`);
    }
    if (/:\/\//.test(value) || /^[A-Za-z]:[\\/]/.test(value) || /^[/\\]{1,2}/.test(value)
      || /^(?:adb|powershell|pwsh|cmd(?:\.exe)?|bash|sh)(?:\s|$)/i.test(value)) {
      fail("XHS_RPA_FORBIDDEN_FIELD", `procedure-bearing value at ${pointer}`);
    }
    return;
  }
  if (Array.isArray(value)) return value.forEach((entry, index) => assertSafeParams(entry, `${pointer}[${index}]`));
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (PROCEDURE_KEY.test(key)) fail("XHS_RPA_FORBIDDEN_FIELD", `forbidden procedure field ${pointer}.${key}`);
    assertSafeParams(entry, `${pointer}.${key}`);
  }
}

/**
 * Deterministically projects a sealed RPA program onto the existing M5 DAG and
 * TaskPlanV2 contracts. It does not choose an executor, load a module, schedule
 * work, or accept any procedure-bearing override from its caller.
 */
export function lowerXhsRpaProgramToM5(input = {}) {
  if (!exact(input, ["program", "catalogSnapshot"])) {
    fail("XHS_RPA_ADAPTER_INPUT_INVALID", "adapter accepts only program and catalogSnapshot");
  }
  const { program, catalogSnapshot } = input;
  const catalogBody = catalogSnapshot && {
    schemaId: catalogSnapshot.schemaId,
    schemaVersion: catalogSnapshot.schemaVersion,
    runtime: catalogSnapshot.runtime,
    entries: catalogSnapshot.entries,
  };
  if (!exact(program, PROGRAM_KEYS)
    || !exact(catalogSnapshot, ["schemaId", "schemaVersion", "runtime", "entries", "catalogSnapshotHash"])
    || program?.schemaId !== XHS_RPA_PROGRAM_SCHEMA_ID
    || !Number.isInteger(program.programVersion) || program.programVersion < 1
    || !/^own_[a-z0-9][a-z0-9._-]{2,127}$/.test(String(program.ownerRef ?? ""))
    || !Number.isInteger(program.generation) || program.generation < 1
    || !Number.isInteger(program.rollbackGeneration) || program.rollbackGeneration < 0
    || program.rollbackGeneration > program.generation
    || !/^[0-9a-f]{64}$/.test(String(program.accountRef ?? ""))
    || catalogSnapshot?.schemaId !== XHS_RPA_CATALOG_SCHEMA_ID
    || catalogSnapshot.catalogSnapshotHash !== hashXhsRpa(catalogBody)
    || program.enabled !== false || program.recurringEnabled !== false
    || program.externalEffects !== 0 || program.writeTransportBudget !== 0
    || canonicalXhsRpaJson(program.forbiddenActions) !== canonicalXhsRpaJson(XHS_RPA_FORBIDDEN_ACTIONS)
    || canonicalXhsRpaJson(program.seedPolicy) !== canonicalXhsRpaJson(XHS_RPA_SEED_POLICY)
    || canonicalXhsRpaJson(program.budgetPolicy) !== canonicalXhsRpaJson(XHS_RPA_BUDGET_POLICY)
    || canonicalXhsRpaJson(program.failurePolicy) !== canonicalXhsRpaJson(XHS_RPA_FAILURE_POLICY)
    || canonicalXhsRpaJson(program.misfirePolicy) !== canonicalXhsRpaJson(XHS_RPA_MISFIRE_POLICY)
    || canonicalXhsRpaJson(program.evidencePolicy) !== canonicalXhsRpaJson(XHS_RPA_EVIDENCE_POLICY)
    || canonicalXhsRpaJson(program.retentionPolicy) !== canonicalXhsRpaJson(XHS_RPA_RETENTION_POLICY)
    || program.runtime?.catalogSnapshotHash !== catalogSnapshot.catalogSnapshotHash
    || program.runtime?.releaseId !== catalogSnapshot.runtime?.releaseId
    || program.runtime?.sourceCommit !== catalogSnapshot.runtime?.sourceCommit
    || canonicalXhsRpaJson(program.schedule) !== canonicalXhsRpaJson({
      kind: "manual_once", timezone: "Asia/Shanghai", misfirePolicy: "skip_no_catchup",
    })
    || program.pacing?.accountConcurrency !== 1
    || !Number.isInteger(program.pacing?.dailyStarts) || program.pacing.dailyStarts < 1 || program.pacing.dailyStarts > 4
    || !Number.isInteger(program.pacing?.minimumIntervalMs) || program.pacing.minimumIntervalMs < 300_000
    || !Number.isInteger(program.pacing?.preIoRetryMax) || program.pacing.preIoRetryMax < 0 || program.pacing.preIoRetryMax > 1
    || program.programHash !== hashXhsRpa(Object.fromEntries(
      Object.entries(program).filter(([key]) => key !== "programHash"),
    ))) {
    fail("XHS_RPA_PROGRAM_SEAL_INVALID", "program or atomic catalog seal is invalid");
  }
  const byEntry = new Map(catalogSnapshot.entries.map((entry) => [entry.entryId, entry]));
  const m5NodeId = new Map(program.nodes.map((node, index) => [node.nodeId, `n${index + 1}`]));
  const nodes = program.nodes.map((node) => {
    if (!exact(node, ["nodeId", "catalogRef", "fixedParams", "inputPrivateRefs", "dependsOn"])
      || !/^[a-z][a-z0-9._-]{0,63}$/.test(String(node.nodeId ?? ""))
      || !node.fixedParams || typeof node.fixedParams !== "object" || Array.isArray(node.fixedParams)
      || !Array.isArray(node.inputPrivateRefs)
      || new Set(node.inputPrivateRefs).size !== node.inputPrivateRefs.length
      || node.inputPrivateRefs.some((ref) => !/^priv_[0-9a-f]{64}$/.test(String(ref)))
      || !Array.isArray(node.dependsOn)) {
      fail("XHS_RPA_PROGRAM_SEAL_INVALID", "program node contract is invalid");
    }
    const entry = byEntry.get(node.catalogRef?.entryId);
    if (!entry?.eligible || entry.effectClass !== "none" || entry.reasons?.length !== 0
      || entry.maturity !== "accepted" || entry.status !== "active"
      || entry.releaseId !== catalogSnapshot.runtime?.releaseId
      || entry.sourceCommit !== catalogSnapshot.runtime?.sourceCommit
      || !Array.isArray(entry.acceptanceReceiptHashes) || entry.acceptanceReceiptHashes.length === 0) {
      fail("XHS_RPA_CATALOG_INELIGIBLE", `catalog entry ${String(node.catalogRef?.entryId)} is not eligible`);
    }
    const exactRef = {
      entryId: entry.entryId,
      kind: entry.kind,
      revision: entry.revision,
      templateHash: entry.templateHash,
      descriptorHash: entry.descriptorHash,
      effectClass: entry.effectClass,
      placement: entry.placement,
      maturity: entry.maturity,
      status: entry.status,
      acceptanceReceiptHashes: entry.acceptanceReceiptHashes,
      runner: entry.runner,
      cleanupContractHash: entry.cleanupContractHash,
      expectedReceiptSchema: entry.expectedReceiptSchema,
    };
    if (canonicalXhsRpaJson(node.catalogRef) !== canonicalXhsRpaJson(exactRef)) {
      fail("XHS_RPA_CATALOG_DRIFT", `node ${node.nodeId} catalog reference drifted`);
    }
    assertSafeParams(node.fixedParams, `nodes.${node.nodeId}.fixedParams`);
    return Object.freeze({
      nodeId: m5NodeId.get(node.nodeId),
      skillId: entry.entryId,
      skillVersionRef: Object.freeze({
        skillId: entry.entryId,
        skillVersion: `${entry.revision}.0.0`,
        skillSpecSha256: entry.descriptorHash,
        sourceCommit: entry.sourceCommit,
        sourcePath: `urn:xw:rpa-catalog:${entry.entryId}:r${entry.revision}`,
        sourceBlobSha: entry.templateHash.slice(0, 40),
      }),
      inputs: Object.freeze({
        programNodeId: node.nodeId,
        catalogRefHash: hashXhsRpa(node.catalogRef),
        runnerContractHash: entry.runner.contractHash,
        fixedParams: node.fixedParams,
        inputPrivateRefs: node.inputPrivateRefs,
        expectedReceiptSchema: entry.expectedReceiptSchema,
      }),
      dependsOn: Object.freeze(node.dependsOn.map((dependency) => m5NodeId.get(dependency))),
      // The task-owned V3 runner is one aggregate typed job.  Its sealed
      // catalog ref still proves exact [03,04], while the M5 request carries
      // no caller-selectable lane shard/alias and invokes the pair exactly once.
      targetAliases: entry.runner.capabilityId === "xhs.v3.task.explore.manual_once"
        ? Object.freeze([])
        : entry.placement.aliases,
      expectedEffectClass: "none",
      requiresHuman: false,
      localValidator: false,
    });
  });
  const expectedEdges = program.nodes.flatMap((node) => node.dependsOn.map((from) => ({ from, to: node.nodeId })))
    .sort((left, right) => `${left.from}:${left.to}`.localeCompare(`${right.from}:${right.to}`));
  if (canonicalXhsRpaJson(program.edges) !== canonicalXhsRpaJson(expectedEdges)
    || program.dagHash !== hashXhsRpa({ nodes: program.nodes, edges: program.edges })) {
    fail("XHS_RPA_PROGRAM_SEAL_INVALID", "program DAG seal is invalid");
  }
  const structural = {
    taskType: "collection",
    catalogHash: catalogSnapshot.catalogSnapshotHash,
    nodes,
  };
  const planHash = hashXhsRpa(structural);
  const dag = Object.freeze({
    schemaId: "xw.orchestration.dag.v1",
    schemaVersion: 1,
    dagId: `dag_${planHash.slice(0, 16)}`,
    taskType: structural.taskType,
    traceId: `rpa_${program.programHash.slice(0, 24)}`,
    catalogHash: structural.catalogHash,
    nodes: Object.freeze(nodes),
    executionReady: true,
    humanGate: null,
    planHash,
  });
  const taskPlan = reproduceXhsRpaTaskPlan(program, catalogSnapshot);
  return Object.freeze({
    adapterId: XHS_RPA_M5_ADAPTER_ID,
    dag,
    taskPlan,
    dagHash: hashXhsRpa(dag),
    taskPlanHash: taskPlan.planHash,
    thirdSchedulerIntroduced: false,
  });
}
