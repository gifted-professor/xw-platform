/**
 * Raw TaskPlan → ExecutionPlan binder (Foundation PR1/PR2).
 * Binds live capability contracts; does NOT authorize.
 * ExecutionPlan carries placement constraints only (no final deviceId).
 */

import { sha256, validateTaskPlanV2 } from "./task-plan-v2.mjs";
import { resolveCapabilityContractHashAlgorithm } from "./capability-contract-hash.mjs";

export const EXECUTION_PLAN_SCHEMA_ID = "xhs.execution-plan.v2";
export const BUSINESS_EFFECT_CLASSES = Object.freeze(["social", "publish", "payment", "delete"]);

function codeError(code, message, details) {
  return Object.assign(new Error(message), { code, details });
}

function hex64(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isBusiness(cls) {
  return BUSINESS_EFFECT_CLASSES.includes(cls);
}

export function isBusinessEffectPlan(executionPlan) {
  return (executionPlan?.nodes || []).some((n) => n?.normalizedEffect && isBusiness(n.normalizedEffect.class));
}

/** Hash body excludes executionPlanHash (same preimage Binder uses). */
export function computeExecutionPlanHash(executionPlan) {
  if (!executionPlan || typeof executionPlan !== "object") {
    throw codeError("EXECUTION_PLAN_INVALID", "executionPlan must be an object");
  }
  const {
    executionPlanHash: _drop,
    ...body
  } = executionPlan;
  return sha256(body);
}

export function isExecutionPlan(value) {
  return Boolean(value && value.schemaId === EXECUTION_PLAN_SCHEMA_ID && value.executionPlanHash);
}

/**
 * Strict ExecutionPlan gate: schema + canonical hash recompute + plan topology parity.
 */
export function assertExecutionPlan(executionPlan, plan = null) {
  if (!isExecutionPlan(executionPlan)) {
    throw codeError("EXECUTION_PLAN_REQUIRED", "bound ExecutionPlan is required");
  }
  if (executionPlan.schemaVersion !== 1) {
    throw codeError("EXECUTION_PLAN_INVALID", "executionPlan.schemaVersion must be 1");
  }
  if (!Array.isArray(executionPlan.nodes) || executionPlan.nodes.length === 0) {
    throw codeError("EXECUTION_PLAN_INVALID", "executionPlan.nodes required");
  }
  const nodeIds = executionPlan.nodes.map((n) => n?.nodeId);
  if (nodeIds.some((id) => !id) || new Set(nodeIds).size !== nodeIds.length) {
    throw codeError("EXECUTION_PLAN_INVALID", "executionPlan nodeId must be unique and present");
  }
  if (!executionPlan.constraints || typeof executionPlan.constraints !== "object") {
    throw codeError("EXECUTION_PLAN_INVALID", "executionPlan.constraints required");
  }
  for (const node of executionPlan.nodes) {
    if (node.capabilityContractHash != null && !hex64(node.capabilityContractHash)) {
      throw codeError("EXECUTION_PLAN_INVALID", `bad capabilityContractHash on ${node.nodeId}`);
    }
    if (node.implementationClosureHash != null && !hex64(node.implementationClosureHash)) {
      throw codeError("EXECUTION_PLAN_INVALID", `bad implementationClosureHash on ${node.nodeId}`);
    }
  }

  const recomputed = computeExecutionPlanHash(executionPlan);
  if (recomputed !== executionPlan.executionPlanHash) {
    throw codeError("EXECUTION_PLAN_HASH_MISMATCH", "executionPlanHash does not match canonical content", {
      expected: recomputed,
      actual: executionPlan.executionPlanHash,
    });
  }

  if (plan) {
    if (executionPlan.sourcePlanHash !== plan.planHash) {
      throw codeError("EXECUTION_PLAN_SOURCE_MISMATCH", "executionPlan.sourcePlanHash must equal plan.planHash");
    }
    const rawIds = (plan.nodes || []).map((n) => n.nodeId);
    if (rawIds.length !== nodeIds.length || rawIds.some((id, i) => id !== nodeIds[i] && !nodeIds.includes(id))) {
      const rawSet = new Set(rawIds);
      const boundSet = new Set(nodeIds);
      for (const id of rawSet) {
        if (!boundSet.has(id)) throw codeError("EXECUTION_PLAN_NODE_MISSING", `ExecutionPlan missing node ${id}`);
      }
      for (const id of boundSet) {
        if (!rawSet.has(id)) throw codeError("EXECUTION_PLAN_INVALID", `ExecutionPlan has extra node ${id}`);
      }
    }
    if (rawIds.length !== nodeIds.length || ![...rawIds].every((id) => nodeIds.includes(id))) {
      throw codeError("EXECUTION_PLAN_INVALID", "ExecutionPlan nodes must match Raw Plan node set exactly");
    }
  }

  return executionPlan;
}

/**
 * @param {object} rawPlan - TaskPlanV2 input (untrusted)
 * @param {Map<string, object>|object[]} liveCatalog - capability id → public capability
 * @returns {{ executionPlan, executionPlanHash, warnings }}
 */
export function bindTaskPlanToLiveCapabilities(rawPlan, liveCatalog) {
  const validationErrors = validateTaskPlanV2(rawPlan);
  if (Array.isArray(validationErrors) && validationErrors.length > 0) {
    const err = new Error("TASK_PLAN_SCHEMA_INVALID");
    err.code = "TASK_PLAN_SCHEMA_INVALID";
    err.details = validationErrors;
    throw err;
  }
  const plan = rawPlan;
  const byId = catalogToMap(liveCatalog);
  const nodes = [];
  const warnings = [];

  for (const node of plan.nodes || []) {
    const executor = node.executor || {};
    if (executor.kind === "session_workflow") {
      const shardParams = (node.shards || []).map((s) => s.params || {});
      const injected = node.params?.actions || node.params?.actionOverrides
        || executor.actions || executor.actionOverrides || executor.primitive_steps
        || shardParams.some((p) => p.actions || p.actionOverrides || p.primitive_steps);
      if (injected) {
        throw codeError("WORKFLOW_CONTRACT_UNBOUND", "runtime actions/actionOverrides/primitive_steps forbidden", {
          nodeId: node.nodeId,
        });
      }
      nodes.push({
        nodeId: node.nodeId,
        kind: "session_workflow",
        workflowId: executor.workflowId,
        placementConstraint: extractPlacementConstraint(node),
        expectedEffectClass: executor.effectClass || null,
        expectedReplaySafety: executor.replaySafety || null,
      });
      continue;
    }

    const capabilityId = executor.capabilityId;
    if (!capabilityId || !byId.has(capabilityId)) {
      throw codeError("NO_EXECUTOR_BINDING", "capability not in live catalog", { nodeId: node.nodeId, capabilityId });
    }
    const cap = byId.get(capabilityId);
    if (cap.runnable === false || cap.availability === "classification_required" || cap.lifecycle === "draft") {
      throw codeError("EFFECT_CLASSIFICATION_REQUIRED", "capability not runnable", { capabilityId });
    }

    const liveEffect = cap.normalizedEffect || null;
    const liveRetry = mapIdempotencyToRetry(cap.idempotency);
    assertRawEffectMatchesLive(executor, liveEffect, capabilityId);
    assertRawRetryMatchesLive(executor, liveRetry, capabilityId);

    const placementConstraint = extractPlacementConstraint(node);
    if (liveEffect && isBusiness(liveEffect.class)) {
      assertBusinessShardsShareFixedAlias(node, placementConstraint);
    }

    nodes.push({
      nodeId: node.nodeId,
      kind: "typed_job",
      capabilityId,
      appId: cap.appId || executor.appId || null,
      capabilityContractHash: cap.capabilityContractHash || null,
      capabilityContractHashAlgorithm: resolveCapabilityContractHashAlgorithm(cap),
      implementationClosureHash: cap.implementationClosureHash
        || cap.implementation?.implementationClosureHash
        || null,
      tcbManifestRef: cap.tcbManifestRef || cap.implementation?.tcbManifestRef || null,
      normalizedEffect: liveEffect,
      retryClass: liveRetry,
      placementConstraint,
    });
  }

  const hasBusiness = nodes.some((n) => n.normalizedEffect && isBusiness(n.normalizedEffect.class));
  const rawMaxWorkers = plan.execution?.maxWorkers ?? plan.maxWorkers ?? 4;
  const rawMaxAttempts = plan.execution?.maxAttemptsPerShard ?? plan.maxAttemptsPerShard ?? 2;
  const rawAllowReassign = plan.execution?.allowReassign;
  const constraints = hasBusiness
    ? { maxWorkers: 1, allowReassign: false, maxAttemptsPerShard: 1 }
    : {
        maxWorkers: rawMaxWorkers,
        allowReassign: typeof rawAllowReassign === "boolean" ? rawAllowReassign : true,
        maxAttemptsPerShard: rawMaxAttempts,
      };

  const executionPlanBody = {
    schemaId: EXECUTION_PLAN_SCHEMA_ID,
    schemaVersion: 1,
    sourcePlanHash: plan.planHash || null,
    nodes,
    constraints,
  };
  const executionPlanHash = computeExecutionPlanHash(executionPlanBody);
  return {
    executionPlan: { ...executionPlanBody, executionPlanHash },
    executionPlanHash,
    warnings,
  };
}

function assertRawEffectMatchesLive(executor, liveEffect, capabilityId) {
  if (!executor.effectClass || !liveEffect) return;
  const rawIsBusiness = executor.effectClass === "external_effect";
  const liveIsBusiness = liveEffect.class && isBusiness(liveEffect.class);
  if (rawIsBusiness !== liveIsBusiness) {
    throw codeError("PLAN_CONTRACT_MISMATCH", "raw effectClass assertion mismatches live normalizedEffect", {
      capabilityId,
      raw: executor.effectClass,
      live: liveEffect,
    });
  }
}

function assertRawRetryMatchesLive(executor, liveRetry, capabilityId) {
  if (!executor.replaySafety || !liveRetry) return;
  if (executor.replaySafety !== liveRetry) {
    throw codeError("PLAN_CONTRACT_MISMATCH", "raw replaySafety assertion mismatches live retryClass", {
      capabilityId,
      field: "replaySafety",
      raw: executor.replaySafety,
      live: liveRetry,
    });
  }
}

function assertBusinessShardsShareFixedAlias(node, placementConstraint) {
  const aliases = (node.shards || []).map((shard) => shard.placement?.alias || null);
  const fixed = placementConstraint?.alias || null;
  if (!fixed) {
    throw codeError("EXECUTION_PLAN_PLACEMENT_MISMATCH", "business effect node requires fixed alias", {
      nodeId: node.nodeId,
    });
  }
  if (aliases.some((alias) => alias !== fixed)) {
    throw codeError("EXECUTION_PLAN_PLACEMENT_MISMATCH", "business effect shards must share one fixed alias", {
      nodeId: node.nodeId,
      expected: fixed,
      aliases,
    });
  }
}

function catalogToMap(liveCatalog) {
  if (liveCatalog instanceof Map) return liveCatalog;
  const map = new Map();
  const list = Array.isArray(liveCatalog) ? liveCatalog : (liveCatalog?.capabilities || []);
  for (const item of list) {
    if (item?.id) map.set(item.id, item);
  }
  return map;
}

function extractPlacementConstraint(node) {
  const shardPlacement = node.shards?.[0]?.placement || {};
  const placement = node.placement || shardPlacement || {};
  if (placement.alias) return { alias: String(placement.alias) };
  if (Array.isArray(placement.eligibleAliases) && placement.eligibleAliases.length === 1) {
    return { alias: String(placement.eligibleAliases[0]) };
  }
  return { alias: null, eligibleAliases: placement.eligibleAliases || null };
}

function mapIdempotencyToRetry(idem) {
  if (idem === "read_only") return "read_only";
  if (idem === "replay_safe") return "replay_safe";
  if (idem === "ambiguous_on_timeout") return "ambiguous_on_timeout";
  return "external_effect";
}
