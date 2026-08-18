/**
 * Test helper: bind a TaskPlanV2 through the live-capability binder so
 * orchestrator/store tests satisfy EXECUTION_PLAN_REQUIRED.
 */
import { bindTaskPlanToLiveCapabilities } from "../../scripts/lib/task-plan-capability-binding.mjs";
import { CAPABILITY_CONTRACT_HASH_ALGORITHM_V2 } from "../../scripts/lib/capability-contract-hash.mjs";

export function fixtureCatalogForPlan(plan, overridesById = {}) {
  const caps = [];
  const seen = new Set();
  for (const node of plan.nodes || []) {
    if (node.executor?.kind === "session_workflow") continue;
    const id = node.executor?.capabilityId;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const over = overridesById[id] || {};
    caps.push({
      id,
      appId: node.executor.appId,
      availability: "implemented",
      idempotency: node.executor.replaySafety || "read_only",
      capabilityContractHash: over.capabilityContractHash ?? null,
      capabilityContractHashAlgorithm: over.capabilityContractHashAlgorithm
        ?? (over.capabilityContractHash ? CAPABILITY_CONTRACT_HASH_ALGORITHM_V2 : null),
      implementationClosureHash: over.implementationClosureHash ?? null,
      tcbManifestRef: over.tcbManifestRef ?? null,
      normalizedEffect: over.normalizedEffect ?? (
        node.executor.effectClass === "external_effect"
          ? { class: "publish", phase: "prepare", commitBoundary: "automatic" }
          : { class: "observe", phase: "read", commitBoundary: "automatic" }
      ),
      ...over,
    });
  }
  return caps;
}

export function bindFixturePlan(plan, overridesById = {}) {
  return bindTaskPlanToLiveCapabilities(plan, fixtureCatalogForPlan(plan, overridesById));
}
