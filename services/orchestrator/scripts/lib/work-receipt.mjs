const TECHNICAL = new Set(["succeeded", "failed", "blocked", "ambiguous"]);
const BUSINESS = new Set(["accepted", "rejected", "not_evaluated", "ambiguous"]);
const ALIAS_RE = /^0[1-4]$/;

function text(value) {
  return typeof value === "string" && value.length > 0;
}

export function validateWorkReceipt(receipt) {
  const errors = [];
  const add = (path, message) => errors.push({ path, message });
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return [{ path: "$", message: "receipt must be an object" }];
  if (receipt.schemaId !== "xhs.work-receipt.v1" || receipt.schemaVersion !== 1) add("schema", "must be xhs.work-receipt.v1 version 1");
  for (const key of ["taskRunId", "planHash", "nodeId", "shardId", "shardKey", "attemptId", "workerId", "capabilityId", "startedAt", "finishedAt"]) {
    if (!text(receipt[key])) add(key, "is required");
  }
  for (const key of ["nodeIndex", "shardIndex", "attemptIndex"]) {
    if (!Number.isInteger(receipt[key]) || receipt[key] < 0) add(key, "must be a non-negative integer");
  }
  if (!ALIAS_RE.test(receipt.alias || "")) add("alias", "must be 01-04");
  if (!TECHNICAL.has(receipt.technicalStatus)) add("technicalStatus", "is invalid");
  if (!BUSINESS.has(receipt.businessStatus)) add("businessStatus", "is invalid");
  if (typeof receipt.retryable !== "boolean") add("retryable", "must be boolean");
  return errors;
}

export function assertWorkReceipt(receipt) {
  const errors = validateWorkReceipt(receipt);
  if (errors.length) throw new Error(`invalid work receipt: ${JSON.stringify(errors)}`);
  return receipt;
}

export function receiptAccepted(receipt) {
  return receipt?.technicalStatus === "succeeded" && receipt?.businessStatus === "accepted";
}

export function createWorkReceipt({ assignment, technicalStatus, businessStatus, retryable = false, job = {}, output = null, error = null, startedAt, finishedAt }) {
  const receipt = {
    schemaId: "xhs.work-receipt.v1",
    schemaVersion: 1,
    taskRunId: assignment.taskRunId,
    planHash: assignment.planHash,
    nodeId: assignment.node.nodeId,
    nodeIndex: assignment.node.nodeIndex,
    shardId: assignment.shard.shardId,
    shardIndex: assignment.shard.shardIndex,
    shardKey: assignment.shard.shardKey,
    attemptId: assignment.attemptId,
    attemptIndex: assignment.attemptIndex,
    workerId: assignment.workerId,
    alias: assignment.alias,
    capabilityId: assignment.node.executor.capabilityId,
    technicalStatus,
    businessStatus,
    retryable,
    jobId: job.jobId || job.id || null,
    runId: job.runId || null,
    output,
    error,
    startedAt,
    finishedAt,
  };
  return assertWorkReceipt(receipt);
}
