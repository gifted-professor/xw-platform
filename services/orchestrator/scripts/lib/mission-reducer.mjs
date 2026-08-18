import { receiptAccepted } from "./work-receipt.mjs";

function byAttempt(a, b) {
  return a.attemptIndex - b.attemptIndex;
}

function selectReceipt(receipts) {
  const ordered = [...receipts].sort(byAttempt);
  const accepted = ordered.filter(receiptAccepted);
  return accepted.at(-1) || ordered.at(-1) || null;
}

function outputItems(output) {
  if (Array.isArray(output)) return output;
  for (const key of ["items", "posts", "cards", "results"]) {
    if (Array.isArray(output?.[key])) return output[key];
  }
  return [];
}

export function reduceMission({ taskRunId, plan, receipts, workUnits = {} }) {
  const grouped = new Map();
  for (const receipt of receipts || []) {
    const key = `${receipt.nodeId}\u0000${receipt.shardId}`;
    const list = grouped.get(key) || [];
    list.push(receipt);
    grouped.set(key, list);
  }

  const results = [];
  for (const node of plan.nodes) {
    for (const shard of node.shards) {
      const attempts = grouped.get(`${node.nodeId}\u0000${shard.shardId}`) || [];
      const selected = selectReceipt(attempts);
      const workState = workUnits[`${node.nodeId}:${shard.shardId}`];
      results.push({
        nodeId: node.nodeId,
        nodeIndex: node.nodeIndex,
        shardId: shard.shardId,
        shardIndex: shard.shardIndex,
        shardKey: shard.shardKey,
        selectedAttemptIndex: selected?.attemptIndex ?? null,
        attemptCount: attempts.length,
        technicalStatus: selected?.technicalStatus || "blocked",
        businessStatus: selected?.businessStatus || "not_evaluated",
        accepted: receiptAccepted(selected),
        alias: selected?.alias || null,
        output: selected?.output ?? null,
        error: selected?.error ?? workState?.lastError ?? (attempts.length ? null : { code: "NO_ATTEMPT", message: "work unit was not executed" }),
      });
    }
  }

  results.sort((a, b) => a.nodeIndex - b.nodeIndex || a.shardIndex - b.shardIndex);
  const orderedItems = results.filter((result) => result.accepted).flatMap((result) => outputItems(result.output).map((item, itemIndex) => ({
    nodeId: result.nodeId,
    nodeIndex: result.nodeIndex,
    shardId: result.shardId,
    shardIndex: result.shardIndex,
    itemIndex,
    alias: result.alias,
    item,
  })));
  const accepted = results.filter((item) => item.accepted).length;
  const ambiguous = results.filter((item) => item.technicalStatus === "ambiguous" || item.businessStatus === "ambiguous").length;
  const blocked = results.filter((item) => item.technicalStatus === "blocked" && item.businessStatus !== "ambiguous").length;
  let status;
  if (ambiguous > 0) status = "ambiguous";
  else if (accepted === results.length) status = "completed";
  else if (accepted > 0) status = "partial";
  else if (blocked === results.length) status = "blocked";
  else status = "failed";

  return {
    schemaId: "xhs.mission-result.v1",
    schemaVersion: 1,
    taskRunId,
    planId: plan.planId,
    planHash: plan.planHash,
    status,
    summary: {
      total: results.length,
      accepted,
      failed: results.length - accepted - blocked - ambiguous,
      blocked,
      ambiguous,
      itemCount: orderedItems.length,
    },
    results,
    orderedItems,
  };
}
