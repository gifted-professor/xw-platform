import { createHash } from "node:crypto";

import { createTaskPlanV2 } from "./task-plan-v2.mjs";

export const XHS_RPA_PROGRAM_SCHEMA_ID = "xw.xhs.rpa-program.v1";
export const XHS_RPA_CATALOG_SCHEMA_ID = "xw.xhs.rpa-catalog-snapshot.v1";
export const XHS_RPA_FOUNDATION_DEFAULTS = Object.freeze({
  accountConcurrency: 1,
  dailyStarts: 1,
  minimumIntervalMs: 30 * 60 * 1000,
  preIoRetryMax: 1,
  recurringEnabled: false,
});
export const XHS_RPA_FORBIDDEN_ACTIONS = Object.freeze([
  "like", "collect", "follow", "comment_send", "comment_reply", "comment_like",
  "dm", "publish", "delete", "payment", "purchase", "account", "settings",
  "permission_change", "share",
]);
export const XHS_RPA_SEED_POLICY = Object.freeze({
  algorithm: "sha256",
  domain: "xhs-rpa-node-seed-v1",
  timezone: "Asia/Shanghai",
  calendarSlot: "local_day",
  callerRandomness: false,
});
export const XHS_RPA_BUDGET_POLICY = Object.freeze({
  maxProgramNodes: 8,
  maxShards: 16,
  maxRunDurationMs: 600_000,
  maxReservedPrimitives: 80,
});
export const XHS_RPA_FAILURE_POLICY = Object.freeze({
  nodeFailure: "block_program",
  unknownOutcome: "block_no_retry",
  cleanup: "required_all_settled",
});
export const XHS_RPA_MISFIRE_POLICY = Object.freeze({
  mode: "skip_no_catchup",
  clockRollback: "block",
  maxLatenessMs: 300_000,
});
export const XHS_RPA_EVIDENCE_POLICY = Object.freeze({
  childReceipts: "required",
  aggregateReceipt: "required",
  validator: "required",
  publicRawText: false,
});
export const XHS_RPA_RETENTION_POLICY = Object.freeze({
  privateRawDays: 7,
  publicReceipts: "release_horizon",
  digestKeys: "evidence_replay_horizon",
});

const HASH = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const PROGRAM_ID = /^xrp_[a-z0-9][a-z0-9._-]{2,63}$/;
const OWNER_REF = /^own_[a-z0-9][a-z0-9._-]{2,127}$/;
const PRIVATE_REF = /^priv_[0-9a-f]{64}$/;
const ENTRY_ID = /^[a-z][a-z0-9._-]{2,127}$/;
const NODE_ID = /^[a-z][a-z0-9._-]{0,63}$/;
const RECEIPT_SCHEMA = /^[a-z][a-z0-9._-]{2,127}\.v[1-9][0-9]*$/;
const PROCEDURE_FORBIDDEN_KEY = /(?:shell|command|executable|module|path|file|endpoint|url|host|port|coordinate|^x$|^y$|transport|adb|serial|token|secret|alias|provider|role|edata|e_data)/i;
const SOCIAL = new Set(["social", "protected", "human_gated", "unknown", "ambiguous"]);
const ENTRY_KEYS = [
  "entryId", "kind", "revision", "descriptorHash", "templateHash", "effectClass",
  "placement", "maturity", "status", "releaseId", "sourceCommit",
  "acceptanceReceiptHashes", "runner", "cleanupContractHash", "expectedReceiptSchema",
];
const CATALOG_REF_KEYS = [
  "entryId", "kind", "revision", "templateHash", "descriptorHash", "effectClass",
  "placement", "maturity", "status", "acceptanceReceiptHashes", "runner",
  "cleanupContractHash", "expectedReceiptSchema",
];

function fail(code, message, details = {}) {
  throw Object.assign(new Error(message), { code, details });
}

function exact(value, keys) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && Object.keys(value).every((key) => keys.includes(key)));
}

function onlyKeys(value, allowed, required) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every((key) => allowed.includes(key))
    && required.every((key) => Object.hasOwn(value, key)));
}

export function canonicalizeXhsRpa(value, pointer = "$") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("XHS_RPA_JSON_INVALID", `non-finite number at ${pointer}`);
    return value;
  }
  if (Array.isArray(value)) return value.map((entry, index) => canonicalizeXhsRpa(entry, `${pointer}[${index}]`));
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    fail("XHS_RPA_JSON_INVALID", `non-plain value at ${pointer}`);
  }
  return Object.fromEntries(Object.keys(value).sort().map((key) => {
    return [key, canonicalizeXhsRpa(value[key], `${pointer}.${key}`)];
  }));
}

function assertNoProcedureFields(value, pointer) {
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
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoProcedureFields(entry, `${pointer}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (PROCEDURE_FORBIDDEN_KEY.test(key)) {
      fail("XHS_RPA_FORBIDDEN_FIELD", `forbidden procedure field ${pointer}.${key}`);
    }
    assertNoProcedureFields(entry, `${pointer}.${key}`);
  }
}

export function canonicalXhsRpaJson(value) {
  return JSON.stringify(canonicalizeXhsRpa(value));
}

export function hashXhsRpa(value) {
  return createHash("sha256").update(canonicalXhsRpaJson(value), "utf8").digest("hex");
}

export function deriveNodeSeed(programHash, localCalendarSlot, nodeId) {
  if (!HASH.test(String(programHash ?? ""))
    || !/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/.test(String(localCalendarSlot ?? ""))
    || !NODE_ID.test(String(nodeId ?? ""))) {
    fail("XHS_RPA_SEED_INPUT_INVALID", "seed derivation needs program hash, Asia/Shanghai local day, and node id");
  }
  return hashXhsRpa({
    domain: XHS_RPA_SEED_POLICY.domain,
    programHash,
    timezone: XHS_RPA_SEED_POLICY.timezone,
    localCalendarSlot,
    nodeId,
  });
}

function assertFixedPolicy(value, expected, code, label) {
  if (canonicalXhsRpaJson(value) !== canonicalXhsRpaJson(expected)) {
    fail(code, `${label} must equal the sealed V3 foundation policy`);
  }
  return Object.freeze(canonicalizeXhsRpa(expected));
}

function normalizePlacement(value) {
  if (!exact(value, ["mode", "aliases"]) || !["fixed", "exact_pair"].includes(value.mode)
    || !Array.isArray(value.aliases) || value.aliases.length < 1
    || value.aliases.some((alias) => !/^0[1-4]$/.test(alias))
    || new Set(value.aliases).size !== value.aliases.length) {
    fail("XHS_RPA_CATALOG_PLACEMENT_INVALID", "catalog placement must be fixed aliases 01..04");
  }
  const aliases = [...value.aliases];
  if (value.mode === "exact_pair" && canonicalXhsRpaJson(aliases) !== canonicalXhsRpaJson(["03", "04"])) {
    fail("XHS_RPA_CATALOG_PLACEMENT_INVALID", "exact_pair placement is fixed [03,04]");
  }
  return Object.freeze({ mode: value.mode, aliases: Object.freeze(aliases) });
}

function normalizeRunner(value) {
  const keys = ["kind", "capabilityId", "appId", "workflowId", "contractHash"];
  if (!exact(value, keys) || !["typed_job", "session_workflow"].includes(value.kind)
    || !ENTRY_ID.test(String(value.capabilityId ?? ""))
    || !/^[a-z][a-z0-9._-]{0,63}$/.test(String(value.appId ?? ""))
    || (value.kind === "session_workflow" && !ENTRY_ID.test(String(value.workflowId ?? "")))
    || (value.kind === "typed_job" && value.workflowId !== null)
    || !HASH.test(String(value.contractHash ?? ""))) {
    fail("XHS_RPA_CATALOG_RUNNER_INVALID", "catalog runner is not an approved M5 executor binding");
  }
  if (value.kind === "session_workflow" && value.capabilityId !== "xiaowei.explorer.primitive") {
    fail("XHS_RPA_CATALOG_RUNNER_INVALID", "session workflow must use the formal Explorer capability");
  }
  return Object.freeze({ ...value });
}

function projectEntry(raw, runtime) {
  if (!exact(raw, ENTRY_KEYS) || !ENTRY_ID.test(String(raw.entryId ?? ""))
    || !["routine_template", "recipe_revision"].includes(raw.kind)
    || !Number.isInteger(raw.revision) || raw.revision < 1
    || ![raw.descriptorHash, raw.templateHash, raw.cleanupContractHash].every((hash) => HASH.test(String(hash ?? "")))
    || !["none", "social", "protected", "human_gated", "unknown", "ambiguous"].includes(raw.effectClass)
    || !["accepted", "candidate", "draft"].includes(raw.maturity)
    || !["active", "inactive"].includes(raw.status)
    || !Array.isArray(raw.acceptanceReceiptHashes)
    || raw.acceptanceReceiptHashes.some((hash) => !HASH.test(String(hash)))
    || !RECEIPT_SCHEMA.test(String(raw.expectedReceiptSchema ?? ""))) {
    fail("XHS_RPA_CATALOG_ENTRY_INVALID", `catalog entry ${String(raw?.entryId ?? "<unknown>")} is malformed`);
  }
  const placement = normalizePlacement(raw.placement);
  const runner = normalizeRunner(raw.runner);
  const reasons = [];
  if (SOCIAL.has(raw.effectClass)) reasons.push("EFFECT_NOT_NONE");
  if (raw.maturity !== "accepted") reasons.push(`MATURITY_${raw.maturity.toUpperCase()}`);
  if (raw.status !== "active") reasons.push("REVISION_INACTIVE");
  if (raw.releaseId !== runtime.releaseId || raw.sourceCommit !== runtime.sourceCommit) reasons.push("STALE_RELEASE");
  if (raw.acceptanceReceiptHashes.length === 0) reasons.push("ACCEPTANCE_MISSING");
  // Explicitly preserve the observed current search/browse candidate fact.
  if (/^(?:xhs\.)?(?:search|browse)(?:[.@_-]|$)/.test(raw.entryId) && raw.maturity !== "accepted") {
    if (!reasons.includes("CURRENT_CANDIDATE_INELIGIBLE")) reasons.push("CURRENT_CANDIDATE_INELIGIBLE");
  }
  return Object.freeze({
    ...Object.fromEntries(ENTRY_KEYS.map((key) => [key, raw[key]])),
    placement,
    runner,
    acceptanceReceiptHashes: Object.freeze([...raw.acceptanceReceiptHashes].sort()),
    eligible: reasons.length === 0,
    reasons: Object.freeze([...new Set(reasons)].sort()),
  });
}

/** Pure catalog projection. Presence never implies eligibility. */
export function projectXhsRpaCatalog(input = {}) {
  if (!exact(input, ["entries", "runtime"])) {
    fail("XHS_RPA_CATALOG_INPUT_INVALID", "catalog projection accepts only exact entries/runtime input");
  }
  const { entries, runtime } = input;
  if (!exact(runtime, ["releaseId", "sourceCommit"])
    || !/^[A-Za-z0-9._-]{3,128}$/.test(String(runtime.releaseId ?? ""))
    || !COMMIT.test(String(runtime.sourceCommit ?? ""))
    || !Array.isArray(entries)) {
    fail("XHS_RPA_CATALOG_INPUT_INVALID", "catalog projection needs exact runtime and entries");
  }
  const projected = entries.map((entry) => projectEntry(entry, runtime))
    .sort((left, right) => left.entryId.localeCompare(right.entryId));
  if (new Set(projected.map((entry) => entry.entryId)).size !== projected.length) {
    fail("XHS_RPA_CATALOG_DUPLICATE", "catalog entry ids must be unique");
  }
  const body = {
    schemaId: XHS_RPA_CATALOG_SCHEMA_ID,
    schemaVersion: 1,
    runtime: Object.freeze({ ...runtime }),
    entries: Object.freeze(projected),
  };
  return Object.freeze({ ...body, catalogSnapshotHash: hashXhsRpa(body) });
}

function taskPlanFor({ programId, generation, catalogSnapshot, nodes, pacing }) {
  const byId = new Map(catalogSnapshot.entries.map((entry) => [entry.entryId, entry]));
  const shardCount = nodes.reduce((sum, node) => {
    const entry = byId.get(node.catalogRef.entryId);
    return sum + (entry.runner.capabilityId === "xhs.v3.task.explore.manual_once"
      ? 1 : entry.placement.aliases.length);
  }, 0);
  return createTaskPlanV2({
    goal: `xhs-rpa:${programId}`,
    requestKey: `xhs-rpa:${programId}:g${generation}:${catalogSnapshot.catalogSnapshotHash}`,
    nodes: nodes.map((node) => {
      const entry = byId.get(node.catalogRef.entryId);
      return {
        nodeId: node.nodeId,
        dependsOn: node.dependsOn,
        executor: {
          kind: entry.runner.kind,
          capabilityId: entry.runner.capabilityId,
          appId: entry.runner.appId,
          ...(entry.runner.kind === "session_workflow" ? { workflowId: entry.runner.workflowId } : {}),
          replaySafety: "read_only",
          effectClass: "none",
          resources: ["device"],
        },
        shards: (entry.runner.capabilityId === "xhs.v3.task.explore.manual_once"
          ? [null] : entry.placement.aliases).map((alias) => ({
          placement: alias === null ? {} : { alias },
          params: {
            catalogEntryId: entry.entryId,
            revision: entry.revision,
            descriptorHash: entry.descriptorHash,
            catalogRefHash: hashXhsRpa(node.catalogRef),
            runnerContractHash: entry.runner.contractHash,
            programNodeId: node.nodeId,
            fixedParams: node.fixedParams,
            inputPrivateRefs: node.inputPrivateRefs,
          },
          acceptance: {
            expectedReceiptSchema: entry.expectedReceiptSchema,
            cleanupContractHash: entry.cleanupContractHash,
          },
        })),
        acceptance: {
          expectedReceiptSchema: entry.expectedReceiptSchema,
          cleanupContractHash: entry.cleanupContractHash,
        },
      };
    }),
    execution: {
      maxWorkers: Math.min(4, shardCount),
      allowReassign: false,
      maxAttemptsPerShard: pacing.preIoRetryMax + 1,
    },
  });
}

function catalogRefFor(entry) {
  return Object.freeze(Object.fromEntries(CATALOG_REF_KEYS.map((key) => [key, entry[key]])));
}

function normalizeNodes(nodes, catalogSnapshot) {
  if (!Array.isArray(nodes) || nodes.length === 0 || nodes.length > XHS_RPA_BUDGET_POLICY.maxProgramNodes) {
    fail("XHS_RPA_NODES_REQUIRED", "program needs 1..8 nodes");
  }
  const catalog = new Map(catalogSnapshot.entries.map((entry) => [entry.entryId, entry]));
  const seen = new Set();
  const normalized = nodes.map((node) => {
    const keys = ["nodeId", "catalogRef", "fixedParams", "inputPrivateRefs", "dependsOn"];
    if (!exact(node, keys) || !NODE_ID.test(String(node.nodeId ?? "")) || seen.has(node.nodeId)
      || !exact(node.catalogRef, CATALOG_REF_KEYS)
      || !ENTRY_ID.test(String(node.catalogRef.entryId ?? ""))
      || !Array.isArray(node.inputPrivateRefs)
      || new Set(node.inputPrivateRefs).size !== node.inputPrivateRefs.length
      || node.inputPrivateRefs.some((ref) => !PRIVATE_REF.test(String(ref)))
      || !Array.isArray(node.dependsOn) || new Set(node.dependsOn).size !== node.dependsOn.length
      || node.dependsOn.some((dep) => !NODE_ID.test(String(dep)))) {
      fail("XHS_RPA_NODE_INVALID", "program node exact schema is invalid");
    }
    const entry = catalog.get(node.catalogRef.entryId);
    if (!entry || entry.eligible !== true || entry.reasons?.length !== 0
      || entry.maturity !== "accepted" || entry.status !== "active"
      || entry.releaseId !== catalogSnapshot.runtime.releaseId
      || entry.sourceCommit !== catalogSnapshot.runtime.sourceCommit
      || !Array.isArray(entry.acceptanceReceiptHashes) || entry.acceptanceReceiptHashes.length === 0) {
      fail("XHS_RPA_CATALOG_INELIGIBLE", `catalog entry ${node.catalogRef.entryId} is not eligible`);
    }
    if (entry.effectClass !== "none") fail("XHS_RPA_TRANSITIVE_EFFECT_FORBIDDEN", "every transitive node effect must be none");
    const expectedRef = catalogRefFor(entry);
    if (canonicalXhsRpaJson(expectedRef) !== canonicalXhsRpaJson(node.catalogRef)) {
      fail("XHS_RPA_CATALOG_DRIFT", `node ${node.nodeId} differs from its atomic catalog snapshot`);
    }
    assertNoProcedureFields(node.fixedParams, `nodes.${node.nodeId}.fixedParams`);
    seen.add(node.nodeId);
    return Object.freeze({
      nodeId: node.nodeId,
      catalogRef: expectedRef,
      fixedParams: Object.freeze(canonicalizeXhsRpa(node.fixedParams, `nodes.${node.nodeId}.fixedParams`)),
      inputPrivateRefs: Object.freeze([...node.inputPrivateRefs].sort()),
      dependsOn: Object.freeze([...node.dependsOn].sort()),
    });
  }).sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  const shardCount = normalized.reduce((sum, node) => sum + catalog.get(node.catalogRef.entryId).placement.aliases.length, 0);
  if (shardCount > XHS_RPA_BUDGET_POLICY.maxShards) fail("XHS_RPA_SHARD_BUDGET_EXCEEDED", "program exceeds sealed shard cap");
  const ids = new Set(normalized.map((node) => node.nodeId));
  for (const node of normalized) {
    if (node.dependsOn.some((dep) => !ids.has(dep) || dep === node.nodeId)) fail("XHS_RPA_DAG_INVALID", "dependency is missing or self-referential");
  }
  const visiting = new Set();
  const visited = new Set();
  const byId = new Map(normalized.map((node) => [node.nodeId, node]));
  function visit(id) {
    if (visiting.has(id)) fail("XHS_RPA_DAG_CYCLE", "program DAG contains a cycle");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of byId.get(id).dependsOn) visit(dep);
    visiting.delete(id);
    visited.add(id);
  }
  for (const node of normalized) visit(node.nodeId);
  return Object.freeze(normalized);
}

export function compileXhsRpaProgram(input = {}) {
  const allowed = [
    "programId", "programVersion", "ownerRef", "accountRef", "generation", "rollbackGeneration",
    "catalogSnapshot", "nodes", "schedule", "pacing", "seedPolicy", "budgetPolicy",
    "failurePolicy", "misfirePolicy", "evidencePolicy", "retentionPolicy", "externalEffects",
    "writeTransportBudget", "forbiddenActions",
  ];
  if (!onlyKeys(input, allowed, [
    "programId", "programVersion", "ownerRef", "accountRef", "rollbackGeneration", "catalogSnapshot", "nodes",
  ])) {
    fail("XHS_RPA_PROGRAM_INPUT_INVALID", "program compiler input contains missing or unknown keys");
  }
  const {
    programId,
    programVersion,
    ownerRef,
    accountRef,
    generation = 1,
    rollbackGeneration,
    catalogSnapshot,
    nodes,
    schedule = { kind: "manual_once", timezone: "Asia/Shanghai", misfirePolicy: "skip_no_catchup" },
    pacing = {},
    seedPolicy = XHS_RPA_SEED_POLICY,
    budgetPolicy = XHS_RPA_BUDGET_POLICY,
    failurePolicy = XHS_RPA_FAILURE_POLICY,
    misfirePolicy = XHS_RPA_MISFIRE_POLICY,
    evidencePolicy = XHS_RPA_EVIDENCE_POLICY,
    retentionPolicy = XHS_RPA_RETENTION_POLICY,
    externalEffects = 0,
    writeTransportBudget = 0,
    forbiddenActions = XHS_RPA_FORBIDDEN_ACTIONS,
  } = input;
  if (!PROGRAM_ID.test(String(programId ?? "")) || !OWNER_REF.test(String(ownerRef ?? ""))
    || !HASH.test(String(accountRef ?? "")) || !Number.isInteger(programVersion) || programVersion < 1
    || !Number.isInteger(generation) || generation < 1
    || !Number.isInteger(rollbackGeneration) || rollbackGeneration < 0 || rollbackGeneration > generation) {
    fail("XHS_RPA_PROGRAM_IDENTITY_INVALID", "program/version/owner/account/generation identity is invalid");
  }
  if (!catalogSnapshot || catalogSnapshot.schemaId !== XHS_RPA_CATALOG_SCHEMA_ID
    || catalogSnapshot.catalogSnapshotHash !== hashXhsRpa({
      schemaId: catalogSnapshot.schemaId,
      schemaVersion: catalogSnapshot.schemaVersion,
      runtime: catalogSnapshot.runtime,
      entries: catalogSnapshot.entries,
    })) {
    fail("XHS_RPA_CATALOG_SNAPSHOT_INVALID", "atomic catalog snapshot hash is invalid");
  }
  if (!exact(schedule, ["kind", "timezone", "misfirePolicy"])
    || schedule.kind !== "manual_once" || schedule.timezone !== "Asia/Shanghai"
    || schedule.misfirePolicy !== "skip_no_catchup") {
    fail("XHS_RPA_SCHEDULE_INVALID", "foundation supports manual_once with skip/no-catchup only");
  }
  const pacingKeys = ["accountConcurrency", "dailyStarts", "minimumIntervalMs", "preIoRetryMax"];
  if (!pacing || typeof pacing !== "object" || Array.isArray(pacing)
    || Object.keys(pacing).some((key) => !pacingKeys.includes(key))) {
    fail("XHS_RPA_PACING_INVALID", "pacing contains unknown fields");
  }
  const normalizedSeedPolicy = assertFixedPolicy(seedPolicy, XHS_RPA_SEED_POLICY, "XHS_RPA_SEED_POLICY_INVALID", "seed policy");
  const normalizedBudgetPolicy = assertFixedPolicy(budgetPolicy, XHS_RPA_BUDGET_POLICY, "XHS_RPA_BUDGET_POLICY_INVALID", "budget policy");
  const normalizedFailurePolicy = assertFixedPolicy(failurePolicy, XHS_RPA_FAILURE_POLICY, "XHS_RPA_FAILURE_POLICY_INVALID", "failure policy");
  const normalizedMisfirePolicy = assertFixedPolicy(misfirePolicy, XHS_RPA_MISFIRE_POLICY, "XHS_RPA_MISFIRE_POLICY_INVALID", "misfire policy");
  const normalizedEvidencePolicy = assertFixedPolicy(evidencePolicy, XHS_RPA_EVIDENCE_POLICY, "XHS_RPA_EVIDENCE_POLICY_INVALID", "evidence policy");
  const normalizedRetentionPolicy = assertFixedPolicy(retentionPolicy, XHS_RPA_RETENTION_POLICY, "XHS_RPA_RETENTION_POLICY_INVALID", "retention policy");
  if (externalEffects !== 0 || writeTransportBudget !== 0
    || canonicalXhsRpaJson(forbiddenActions) !== canonicalXhsRpaJson(XHS_RPA_FORBIDDEN_ACTIONS)) {
    fail("XHS_RPA_EFFECT_POLICY_INVALID", "external/write effects must be zero and the full forbidden set must remain sealed");
  }
  const normalizedPacing = Object.freeze({
    accountConcurrency: pacing.accountConcurrency ?? XHS_RPA_FOUNDATION_DEFAULTS.accountConcurrency,
    dailyStarts: pacing.dailyStarts ?? XHS_RPA_FOUNDATION_DEFAULTS.dailyStarts,
    minimumIntervalMs: pacing.minimumIntervalMs ?? XHS_RPA_FOUNDATION_DEFAULTS.minimumIntervalMs,
    preIoRetryMax: pacing.preIoRetryMax ?? XHS_RPA_FOUNDATION_DEFAULTS.preIoRetryMax,
  });
  if (normalizedPacing.accountConcurrency !== 1
    || !Number.isInteger(normalizedPacing.dailyStarts) || normalizedPacing.dailyStarts < 1 || normalizedPacing.dailyStarts > 4
    || !Number.isInteger(normalizedPacing.minimumIntervalMs) || normalizedPacing.minimumIntervalMs < 5 * 60 * 1000
    || !Number.isInteger(normalizedPacing.preIoRetryMax) || normalizedPacing.preIoRetryMax < 0 || normalizedPacing.preIoRetryMax > 1) {
    fail("XHS_RPA_PACING_INVALID", "pacing violates concurrency/daily/interval/retry hard caps");
  }
  const normalizedNodes = normalizeNodes(nodes, catalogSnapshot);
  const edges = Object.freeze(normalizedNodes.flatMap((node) => node.dependsOn.map((from) => Object.freeze({ from, to: node.nodeId })))
    .sort((left, right) => `${left.from}:${left.to}`.localeCompare(`${right.from}:${right.to}`)));
  const dagHash = hashXhsRpa({ nodes: normalizedNodes, edges });
  const taskPlan = taskPlanFor({
    programId,
    generation,
    catalogSnapshot,
    nodes: normalizedNodes,
    pacing: normalizedPacing,
  });
  const body = {
    schemaId: XHS_RPA_PROGRAM_SCHEMA_ID,
    schemaVersion: 1,
    programId,
    programVersion,
    ownerRef,
    generation,
    rollbackGeneration,
    enabled: false,
    recurringEnabled: false,
    accountRef,
    externalEffects: 0,
    writeTransportBudget: 0,
    forbiddenActions: XHS_RPA_FORBIDDEN_ACTIONS,
    runtime: Object.freeze({
      releaseId: catalogSnapshot.runtime.releaseId,
      sourceCommit: catalogSnapshot.runtime.sourceCommit,
      catalogSnapshotHash: catalogSnapshot.catalogSnapshotHash,
    }),
    schedule: Object.freeze({ ...schedule }),
    pacing: normalizedPacing,
    seedPolicy: normalizedSeedPolicy,
    budgetPolicy: normalizedBudgetPolicy,
    failurePolicy: normalizedFailurePolicy,
    misfirePolicy: normalizedMisfirePolicy,
    evidencePolicy: normalizedEvidencePolicy,
    retentionPolicy: normalizedRetentionPolicy,
    nodes: normalizedNodes,
    edges,
    dagHash,
    taskPlanHash: taskPlan.planHash,
  };
  return Object.freeze({ ...body, programHash: hashXhsRpa(body) });
}

export function reproduceXhsRpaTaskPlan(program, catalogSnapshot) {
  const taskPlan = taskPlanFor({
    programId: program.programId,
    generation: program.generation,
    catalogSnapshot,
    nodes: program.nodes,
    pacing: program.pacing,
  });
  if (taskPlan.planHash !== program.taskPlanHash) fail("XHS_RPA_TASK_PLAN_DRIFT", "TaskPlanV2 hash differs from sealed program");
  return taskPlan;
}
