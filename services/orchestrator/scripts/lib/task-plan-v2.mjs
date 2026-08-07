import { createHash } from "node:crypto";

export const TASK_PLAN_V2_SCHEMA_ID = "xhs.task-plan.v2";
export const TASK_PLAN_V2_SCHEMA_VERSION = 2;

const EXECUTOR_KINDS = new Set(["typed_job", "session_workflow"]);
const REPLAY_SAFETY = new Set(["read_only", "replay_safe", "ambiguous_on_timeout"]);
const EFFECT_CLASSES = new Set(["none", "external_effect"]);
const ALIAS_RE = /^(0[1-4])$/;
const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const DEFAULT_FIXED_ALIASES = Object.freeze(["01", "02", "03", "04"]);

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value)).digest("hex");
}

function object(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function issue(errors, path, message) {
  errors.push({ path, message });
}

function planHashBody(plan) {
  const { planId: _planId, planHash: _planHash, createdAt: _createdAt, ...body } = plan || {};
  return body;
}

export function computeTaskPlanHash(plan) {
  return sha256(planHashBody(plan));
}

function normalizePlacement(placement = {}) {
  const aliases = Array.isArray(placement.eligibleAliases)
    ? [...new Set(placement.eligibleAliases.map(String))].sort()
    : [];
  return {
    ...(placement.alias ? { alias: String(placement.alias) } : {}),
    ...(aliases.length ? { eligibleAliases: aliases } : {}),
  };
}

function normalizeExecutor(executor = {}) {
  const kind = executor.kind || "typed_job";
  const base = {
    kind,
    capabilityId: String(executor.capabilityId || ""),
    appId: String(executor.appId || ""),
    replaySafety: executor.replaySafety || "read_only",
    effectClass: executor.effectClass || "none",
    resources: [...new Set((executor.resources || []).map(String))].sort(),
    ...(executor.expectedApp ? { expectedApp: canonicalize(executor.expectedApp) } : {}),
  };
  if (kind === "session_workflow") {
    return {
      ...base,
      workflowId: String(executor.workflowId || ""),
    };
  }
  return base;
}

function computeShardKey({ requestKeyHash, nodeId, shardIndex, params, executorKind, alias }) {
  if (executorKind === "session_workflow") {
    return sha256({ requestKeyHash, nodeId, shardIndex, alias: alias || null, params });
  }
  return sha256({ requestKeyHash, nodeId, shardIndex, params });
}

/**
 * Fixed placement shards for session_workflow ("every device" → 01-04).
 * Typed-job callers should continue authoring shards explicitly.
 */
export function createFixedAliasShards({
  aliases = DEFAULT_FIXED_ALIASES,
  params = {},
  paramsByAlias = null,
} = {}) {
  const list = [...new Set((aliases || []).map(String))];
  if (!list.length) throw new Error("aliases must be non-empty");
  for (const alias of list) {
    if (!ALIAS_RE.test(alias)) throw new Error(`invalid alias ${alias}`);
  }
  return list.map((alias) => ({
    placement: { alias },
    params: canonicalize(
      paramsByAlias && object(paramsByAlias[alias]) ? paramsByAlias[alias] : (params || {}),
    ),
  }));
}

export function createTaskPlanV2({ goal, requestKey, nodes, execution = {} } = {}) {
  if (!text(goal)) throw new Error("goal is required");
  if (!text(requestKey)) throw new Error("requestKey is required");
  if (!Array.isArray(nodes) || nodes.length === 0) throw new Error("nodes must be a non-empty array");

  const requestKeyHash = sha256(String(requestKey));
  const hasSessionWorkflow = nodes.some((node) => (node?.executor?.kind || "typed_job") === "session_workflow");
  const normalizedNodes = nodes.map((node, nodeIndex) => {
    const nodeId = String(node.nodeId || `node_${nodeIndex}`);
    const executor = normalizeExecutor(node.executor);
    const shards = (node.shards || []).map((shard, shardIndex) => {
      const params = canonicalize(shard.params || {});
      const placement = normalizePlacement(shard.placement);
      const shardKey = computeShardKey({
        requestKeyHash,
        nodeId,
        shardIndex,
        params,
        executorKind: executor.kind,
        alias: placement.alias || null,
      });
      return {
        shardId: `${nodeId}.${shardIndex}`,
        shardIndex,
        shardKey,
        params,
        placement,
        ...(shard.acceptance ? { acceptance: canonicalize(shard.acceptance) } : {}),
      };
    });
    return {
      nodeId,
      nodeIndex,
      dependsOn: [...new Set((node.dependsOn || []).map(String))],
      executor,
      shards,
      ...(node.acceptance ? { acceptance: canonicalize(node.acceptance) } : {}),
    };
  });

  const draft = {
    schemaId: TASK_PLAN_V2_SCHEMA_ID,
    schemaVersion: TASK_PLAN_V2_SCHEMA_VERSION,
    requestKeyHash,
    goal: String(goal).trim(),
    execution: {
      maxWorkers: execution.maxWorkers ?? 4,
      perDeviceConcurrency: 1,
      sharedTransport: "control_plane_serialized",
      // Session workflow pins alias per shard; reassignment would violate fixed placement.
      allowReassign: execution.allowReassign ?? (hasSessionWorkflow ? false : true),
      maxAttemptsPerShard: execution.maxAttemptsPerShard ?? 2,
    },
    nodes: normalizedNodes,
    reduce: {
      orderBy: ["nodeIndex", "shardIndex", "itemIndex"],
      arrivalOrderIgnored: true,
      judgeBy: "technical_and_business_acceptance",
    },
  };
  const planHash = computeTaskPlanHash(draft);
  const plan = {
    ...draft,
    planId: `plan_${planHash}`,
    planHash,
    createdAt: new Date().toISOString(),
  };
  const errors = validateTaskPlanV2(plan);
  if (errors.length) throw new Error(`invalid task plan: ${JSON.stringify(errors)}`);
  return plan;
}

export function validateTaskPlanV2(plan) {
  const errors = [];
  if (!object(plan)) return [{ path: "$", message: "plan must be an object" }];
  if (plan.schemaId !== TASK_PLAN_V2_SCHEMA_ID || plan.schemaVersion !== TASK_PLAN_V2_SCHEMA_VERSION) {
    issue(errors, "schema", "must be xhs.task-plan.v2 version 2");
  }
  if (!text(plan.goal)) issue(errors, "goal", "is required");
  if (!/^[a-f0-9]{64}$/.test(plan.requestKeyHash || "")) issue(errors, "requestKeyHash", "must be sha256");
  if (!/^[a-f0-9]{64}$/.test(plan.planHash || "")) issue(errors, "planHash", "must be sha256");
  if (plan.planId !== `plan_${plan.planHash}`) issue(errors, "planId", "must be derived from planHash");
  if (plan.planHash && plan.planHash !== computeTaskPlanHash(plan)) issue(errors, "planHash", "does not match canonical plan");

  const execution = plan.execution;
  if (!object(execution)) {
    issue(errors, "execution", "is required");
  } else {
    if (!Number.isInteger(execution.maxWorkers) || execution.maxWorkers < 1 || execution.maxWorkers > 4) {
      issue(errors, "execution.maxWorkers", "must be an integer from 1 to 4");
    }
    if (execution.perDeviceConcurrency !== 1) issue(errors, "execution.perDeviceConcurrency", "must be 1");
    if (execution.sharedTransport !== "control_plane_serialized") {
      issue(errors, "execution.sharedTransport", "must remain control_plane_serialized");
    }
    if (typeof execution.allowReassign !== "boolean") issue(errors, "execution.allowReassign", "must be boolean");
    if (!Number.isInteger(execution.maxAttemptsPerShard) || execution.maxAttemptsPerShard < 1 || execution.maxAttemptsPerShard > 3) {
      issue(errors, "execution.maxAttemptsPerShard", "must be an integer from 1 to 3");
    }
  }

  if (!Array.isArray(plan.nodes) || plan.nodes.length === 0) {
    issue(errors, "nodes", "must be a non-empty array");
    return errors;
  }

  const nodeIds = new Set();
  const shardKeys = new Set();
  for (const [nodeIndex, node] of plan.nodes.entries()) {
    const path = `nodes[${nodeIndex}]`;
    if (!object(node)) {
      issue(errors, path, "must be an object");
      continue;
    }
    if (!ID_RE.test(node.nodeId || "")) issue(errors, `${path}.nodeId`, "has invalid format");
    if (nodeIds.has(node.nodeId)) issue(errors, `${path}.nodeId`, "must be unique");
    nodeIds.add(node.nodeId);
    if (node.nodeIndex !== nodeIndex) issue(errors, `${path}.nodeIndex`, "must match array position");
    if (!Array.isArray(node.dependsOn) || node.dependsOn.some((id) => !text(id))) {
      issue(errors, `${path}.dependsOn`, "must be string[]");
    }

    const executor = node.executor;
    if (!object(executor) || !EXECUTOR_KINDS.has(executor.kind)) {
      issue(errors, `${path}.executor.kind`, "must be typed_job or session_workflow");
    }
    if (!text(executor?.capabilityId)) issue(errors, `${path}.executor.capabilityId`, "is required");
    if (!text(executor?.appId)) issue(errors, `${path}.executor.appId`, "is required");
    if (!REPLAY_SAFETY.has(executor?.replaySafety)) issue(errors, `${path}.executor.replaySafety`, "is invalid");
    if (!EFFECT_CLASSES.has(executor?.effectClass)) issue(errors, `${path}.executor.effectClass`, "is invalid");
    if (executor?.effectClass !== "none") {
      issue(errors, `${path}.executor.effectClass`, "external effects are outside current orchestration scope");
    }
    if (!Array.isArray(executor?.resources)) issue(errors, `${path}.executor.resources`, "must be string[]");
    if (executor?.kind === "session_workflow") {
      if (!text(executor.workflowId)) issue(errors, `${path}.executor.workflowId`, "is required for session_workflow");
      if (executor.capabilityId !== "xiaowei.explorer.primitive") {
        issue(errors, `${path}.executor.capabilityId`, "session_workflow must use xiaowei.explorer.primitive");
      }
      if (plan.execution && plan.execution.allowReassign !== false) {
        issue(errors, "execution.allowReassign", "must be false when any node uses session_workflow");
      }
    } else if (executor?.kind === "typed_job" && text(executor.workflowId)) {
      issue(errors, `${path}.executor.workflowId`, "must not be set on typed_job");
    }

    if (!Array.isArray(node.shards) || node.shards.length === 0) {
      issue(errors, `${path}.shards`, "must be a non-empty array");
      continue;
    }
    for (const [shardIndex, shard] of node.shards.entries()) {
      const shardPath = `${path}.shards[${shardIndex}]`;
      if (!object(shard)) {
        issue(errors, shardPath, "must be an object");
        continue;
      }
      if (shard.shardIndex !== shardIndex) issue(errors, `${shardPath}.shardIndex`, "must match array position");
      if (shard.shardId !== `${node.nodeId}.${shardIndex}`) issue(errors, `${shardPath}.shardId`, "must be stable nodeId.index");
      if (!/^[a-f0-9]{64}$/.test(shard.shardKey || "")) issue(errors, `${shardPath}.shardKey`, "must be sha256");
      if (!object(shard.params)) issue(errors, `${shardPath}.params`, "must be an object");
      if (!object(shard.placement)) issue(errors, `${shardPath}.placement`, "must be an object");
      if (shard.placement?.alias && !ALIAS_RE.test(shard.placement.alias)) issue(errors, `${shardPath}.placement.alias`, "must be 01-04");
      if (shard.placement?.eligibleAliases && (
        !Array.isArray(shard.placement.eligibleAliases) ||
        shard.placement.eligibleAliases.some((alias) => !ALIAS_RE.test(alias))
      )) issue(errors, `${shardPath}.placement.eligibleAliases`, "must contain aliases 01-04");
      if (executor?.kind === "session_workflow") {
        if (!text(shard.placement?.alias)) {
          issue(errors, `${shardPath}.placement.alias`, "is required for session_workflow (fixed per-device placement)");
        }
      }
      const expectedShardKey = computeShardKey({
        requestKeyHash: plan.requestKeyHash,
        nodeId: node.nodeId,
        shardIndex,
        params: shard.params || {},
        executorKind: executor?.kind,
        alias: shard.placement?.alias || null,
      });
      if (shard.shardKey !== expectedShardKey) {
        issue(
          errors,
          `${shardPath}.shardKey`,
          executor?.kind === "session_workflow"
            ? "does not match request/node/index/alias/params"
            : "does not match request/node/index/params",
        );
      }
      if (shardKeys.has(shard.shardKey)) issue(errors, `${shardPath}.shardKey`, "must be unique across the plan");
      shardKeys.add(shard.shardKey);
    }
  }

  const byId = new Map(plan.nodes.map((node) => [node.nodeId, node]));
  for (const [index, node] of plan.nodes.entries()) {
    for (const dependency of node.dependsOn || []) {
      if (!byId.has(dependency) || dependency === node.nodeId) issue(errors, `nodes[${index}].dependsOn`, `invalid dependency ${dependency}`);
    }
  }
  const visiting = new Set();
  const visited = new Set();
  function cyclic(id) {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn || []) if (cyclic(dependency)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  }
  if ([...byId.keys()].some(cyclic)) issue(errors, "nodes", "dependency graph must not contain a cycle");
  return errors;
}

export function assertTaskPlanV2(plan) {
  const errors = validateTaskPlanV2(plan);
  if (errors.length) throw new Error(`invalid task plan: ${JSON.stringify(errors)}`);
  return plan;
}
