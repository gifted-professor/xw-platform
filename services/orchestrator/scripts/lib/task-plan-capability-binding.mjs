/**
 * Raw TaskPlan → ExecutionPlan binder (Foundation PR1).
 * Binds live capability contracts; does NOT authorize.
 * ExecutionPlan carries placement constraints only (no final deviceId).
 */

import { createHash } from "node:crypto";
import { canonicalize, canonicalJson, sha256, validateTaskPlanV2 } from "./task-plan-v2.mjs";
import { resolveCapabilityContractHashAlgorithm } from "./capability-contract-hash.mjs";

export const EXECUTION_PLAN_SCHEMA_ID = "xhs.execution-plan.v2";

function planHash(value) {
  return sha256(value);
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
      // Workflow runtime injection of actions/actionOverrides is banned (INV-07).
      const shardParams = (node.shards || []).map((s) => s.params || {});
      const injected = node.params?.actions || node.params?.actionOverrides
        || executor.actions || executor.actionOverrides || executor.primitive_steps
        || shardParams.some((p) => p.actions || p.actionOverrides || p.primitive_steps);
      if (injected) {
        const err = new Error("WORKFLOW_CONTRACT_UNBOUND");
        err.code = "WORKFLOW_CONTRACT_UNBOUND";
        err.details = { nodeId: node.nodeId, reason: "runtime actions/actionOverrides/primitive_steps forbidden" };
        throw err;
      }
      nodes.push({
        nodeId: node.nodeId,
        kind: "session_workflow",
        workflowId: executor.workflowId,
        placementConstraint: extractPlacementConstraint(node),
        // effect/retry from raw only as assertion fields — not authority until workflow catalog bind (later)
        expectedEffectClass: executor.effectClass || null,
        expectedReplaySafety: executor.replaySafety || null,
      });
      continue;
    }

    const capabilityId = executor.capabilityId;
    if (!capabilityId || !byId.has(capabilityId)) {
      const err = new Error("NO_EXECUTOR_BINDING");
      err.code = "NO_EXECUTOR_BINDING";
      err.details = { nodeId: node.nodeId, capabilityId };
      throw err;
    }
    const cap = byId.get(capabilityId);
    if (cap.runnable === false || cap.availability === "classification_required" || cap.lifecycle === "draft") {
      const err = new Error("EFFECT_CLASSIFICATION_REQUIRED");
      err.code = "EFFECT_CLASSIFICATION_REQUIRED";
      err.details = { capabilityId };
      throw err;
    }

    const liveEffect = cap.normalizedEffect || null;
    const liveRetry = mapIdempotencyToRetry(cap.idempotency);
    // Raw self-reported effect/retry are assertions only
    if (executor.effectClass && liveEffect) {
      const rawIsBusiness = executor.effectClass === "external_effect";
      const liveIsBusiness = liveEffect.class && ["social", "publish", "payment", "delete"].includes(liveEffect.class);
      if (rawIsBusiness !== liveIsBusiness && executor.effectClass === "none" && liveIsBusiness) {
        const err = new Error("PLAN_CONTRACT_MISMATCH");
        err.code = "PLAN_CONTRACT_MISMATCH";
        err.details = { capabilityId, raw: executor.effectClass, live: liveEffect };
        throw err;
      }
    }
    if (executor.replaySafety && liveRetry && executor.replaySafety !== liveRetry && executor.replaySafety === "read_only" && liveRetry !== "read_only") {
      const err = new Error("PLAN_CONTRACT_MISMATCH");
      err.code = "PLAN_CONTRACT_MISMATCH";
      err.details = { capabilityId, field: "replaySafety", raw: executor.replaySafety, live: liveRetry };
      throw err;
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
      placementConstraint: extractPlacementConstraint(node),
      // ExecutionPlan does NOT include final deviceId
    });
  }

  const executionPlan = {
    schemaId: EXECUTION_PLAN_SCHEMA_ID,
    schemaVersion: 1,
    sourcePlanHash: plan.planHash || null,
    nodes,
    constraints: {
      // business effect plans must use single worker — enforced when any business node present
      maxWorkers: nodes.some((n) => n.normalizedEffect && isBusiness(n.normalizedEffect.class)) ? 1 : (plan.maxWorkers || 4),
      allowReassign: !nodes.some((n) => n.normalizedEffect && isBusiness(n.normalizedEffect.class)),
      maxAttemptsPerShard: nodes.some((n) => n.normalizedEffect && isBusiness(n.normalizedEffect.class)) ? 1 : (plan.maxAttemptsPerShard || 2),
    },
  };
  const executionPlanHash = planHash(executionPlan);
  return {
    executionPlan: { ...executionPlan, executionPlanHash },
    executionPlanHash,
    warnings,
  };
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
  // Prefer first shard placement (TaskPlanV2 stores placement on shards)
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

function isBusiness(cls) {
  return ["social", "publish", "payment", "delete"].includes(cls);
}

export function isExecutionPlan(value) {
  return Boolean(value && value.schemaId === EXECUTION_PLAN_SCHEMA_ID && value.executionPlanHash);
}
