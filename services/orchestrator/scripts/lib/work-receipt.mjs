const TECHNICAL = new Set(["succeeded", "failed", "blocked", "ambiguous"]);
const BUSINESS = new Set(["accepted", "rejected", "not_evaluated", "ambiguous"]);
const ALIAS_RE = /^0[1-4]$/;

function text(value) {
  return typeof value === "string" && value.length > 0;
}

function hex64(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export function validateWorkReceipt(receipt) {
  const errors = [];
  const add = (path, message) => errors.push({ path, message });
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return [{ path: "$", message: "receipt must be an object" }];
  if (receipt.schemaId === "xhs.work-receipt.v2" && receipt.schemaVersion === 2) {
    return validateWorkReceiptV2(receipt);
  }
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

export function validateWorkReceiptV2(receipt) {
  const errors = [];
  const add = (path, message) => errors.push({ path, message });
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return [{ path: "$", message: "receipt must be an object" }];
  if (receipt.schemaId !== "xhs.work-receipt.v2" || receipt.schemaVersion !== 2) add("schema", "must be xhs.work-receipt.v2 version 2");
  for (const key of [
    "taskRunId",
    "planHash",
    "executionPlanHash",
    "capabilityContractHash",
    "implementationClosureHash",
    "operationKey",
    "authorizationDecisionId",
    "jobId",
    "controlPlaneRunId",
    "terminalStatus",
    "nodeId",
    "shardId",
    "shardKey",
    "attemptId",
    "workerId",
    "capabilityId",
    "startedAt",
    "finishedAt",
  ]) {
    if (!text(receipt[key])) add(key, "is required");
  }
  for (const key of ["planHash", "executionPlanHash", "capabilityContractHash", "implementationClosureHash"]) {
    if (receipt[key] != null && !hex64(receipt[key])) add(key, "must be 64 hex");
  }
  for (const key of ["nodeIndex", "shardIndex", "attemptIndex"]) {
    if (!Number.isInteger(receipt[key]) || receipt[key] < 0) add(key, "must be a non-negative integer");
  }
  if (!ALIAS_RE.test(receipt.alias || "")) add("alias", "must be 01-04");
  if (!TECHNICAL.has(receipt.technicalStatus)) add("technicalStatus", "is invalid");
  if (!BUSINESS.has(receipt.businessStatus)) add("businessStatus", "is invalid");
  if (typeof receipt.retryable !== "boolean") add("retryable", "must be boolean");
  if (typeof receipt.reconcileRequired !== "boolean") add("reconcileRequired", "must be boolean");
  if (receipt.runtimeReleaseId != null && !text(receipt.runtimeReleaseId)) add("runtimeReleaseId", "must be non-empty when set");
  return errors;
}

export function assertWorkReceipt(receipt) {
  const errors = validateWorkReceipt(receipt);
  if (errors.length) throw new Error(`invalid work receipt: ${JSON.stringify(errors)}`);
  return receipt;
}

export function assertWorkReceiptV2(receipt) {
  const errors = validateWorkReceiptV2(receipt);
  if (errors.length) throw new Error(`invalid work receipt v2: ${JSON.stringify(errors)}`);
  return receipt;
}

export function receiptAccepted(receipt) {
  return receipt?.technicalStatus === "succeeded" && receipt?.businessStatus === "accepted";
}

/** v1 factory — keep required fields unchanged (RI-05 compatibility). */
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

/**
 * WorkReceipt v2 — proves which implementation ran (RI-05).
 * Does not mutate v1 required shape; callers opt in explicitly.
 */
export function createWorkReceiptV2({
  assignment,
  technicalStatus,
  businessStatus,
  retryable = false,
  job = {},
  output = null,
  error = null,
  startedAt,
  finishedAt,
  integrity = {},
  terminalStatus = null,
  reconcileRequired = null,
}) {
  const status = terminalStatus || technicalStatus;
  const reconcile = reconcileRequired ?? (status === "ambiguous" || technicalStatus === "ambiguous");
  const receipt = {
    schemaId: "xhs.work-receipt.v2",
    schemaVersion: 2,
    taskRunId: assignment.taskRunId,
    planHash: assignment.planHash,
    executionPlanHash: integrity.executionPlanHash || assignment.executionPlanHash || assignment.boundPlanHash || "",
    runtimeReleaseId: integrity.runtimeReleaseId || assignment.runtimeReleaseId || null,
    capabilityContractHash: integrity.capabilityContractHash || assignment.capabilityContractHash || assignment.node?.capabilityContractHash || "",
    implementationClosureHash: integrity.implementationClosureHash || assignment.implementationClosureHash || assignment.node?.implementationClosureHash || "",
    operationKey: integrity.operationKey || assignment.operationKey || `m2:${assignment.taskRunId}:${assignment.shard.shardKey}`,
    authorizationDecisionId: integrity.authorizationDecisionId || job.authorization?.decisionId || assignment.authorizationDecisionId || "",
    jobId: String(job.jobId || job.id || integrity.jobId || ""),
    controlPlaneRunId: String(job.runId || integrity.controlPlaneRunId || ""),
    terminalStatus: status,
    reconcileRequired: Boolean(reconcile),
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
    output,
    error,
    startedAt,
    finishedAt,
  };
  return assertWorkReceiptV2(receipt);
}

/** Read either v1 or v2; never require v2 fields on v1 documents. */
export function readWorkReceipt(receipt) {
  if (receipt?.schemaId === "xhs.work-receipt.v2") return assertWorkReceiptV2(receipt);
  return assertWorkReceipt(receipt);
}
