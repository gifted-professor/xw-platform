import { randomUUID } from "node:crypto";
import { assertTaskPlanV2 } from "./task-plan-v2.mjs";
import {
  assertExecutionPlan,
  isBusinessEffectPlan,
} from "./task-plan-capability-binding.mjs";
import { assertWorkReceipt, receiptAccepted } from "./work-receipt.mjs";
import { reduceMission } from "./mission-reducer.mjs";

const FINAL_UNIT_STATES = new Set(["succeeded", "failed", "blocked", "ambiguous"]);

function codeError(code, message) {
  return Object.assign(new Error(message), { code });
}

function deviceAlias(device) {
  return String(device.alias || device.deviceAlias || device.slot || "");
}

function deviceCapabilityIds(device) {
  for (const key of ["capabilityIds", "eligibleCapabilityIds", "capabilities"]) {
    if (Array.isArray(device?.[key])) return device[key].map((item) => typeof item === "string" ? item : item?.id).filter(Boolean);
  }
  return [];
}

function healthy(device) {
  const lease = device.lease ?? device.leaseStatus ?? "free";
  return device.online !== false && device.ready === true && !device.quarantined && !device.unresolvedFailure && (lease === "free" || lease == null);
}

function unitKey(node, shard) {
  return `${node.nodeId}:${shard.shardId}`;
}

/** Bind raw topology nodes to ExecutionPlan authority by nodeId. */
function planUnits(plan, executionPlan) {
  return plan.nodes.flatMap((rawNode) => {
    const boundNode = executionPlan.nodes.find((candidate) => candidate.nodeId === rawNode.nodeId);
    if (!boundNode) {
      throw codeError("EXECUTION_PLAN_NODE_MISSING", `ExecutionPlan missing node ${rawNode.nodeId}`);
    }
    return rawNode.shards.map((shard) => ({
      node: rawNode,
      boundNode,
      shard,
      key: unitKey(rawNode, shard),
    }));
  });
}

function dependenciesAccepted(plan, state, node) {
  return node.dependsOn.every((dependencyId) => {
    const dependency = plan.nodes.find((candidate) => candidate.nodeId === dependencyId);
    return dependency.shards.every((shard) => state.workUnits[unitKey(dependency, shard)]?.status === "succeeded");
  });
}

function dependenciesTerminalButRejected(plan, state, node) {
  return node.dependsOn.some((dependencyId) => {
    const dependency = plan.nodes.find((candidate) => candidate.nodeId === dependencyId);
    const statuses = dependency.shards.map((shard) => state.workUnits[unitKey(dependency, shard)]?.status);
    return statuses.every((status) => FINAL_UNIT_STATES.has(status)) && statuses.some((status) => status !== "succeeded");
  });
}

function ensureWorkUnits(plan, executionPlan, state) {
  const next = { ...state, workUnits: { ...(state.workUnits || {}) }, receiptRefs: [...(state.receiptRefs || [])] };
  for (const { node, shard, key } of planUnits(plan, executionPlan)) {
    const previous = next.workUnits[key];
    next.workUnits[key] = previous
      ? {
          ...previous,
          status: previous.status === "running" || (previous.status === "ambiguous" && previous.activeJob) ? "pending" : previous.status,
          attemptedAliases: [...(previous.attemptedAliases || [])],
          receiptRefs: [...(previous.receiptRefs || [])],
        }
      : {
          nodeId: node.nodeId,
          nodeIndex: node.nodeIndex,
          shardId: shard.shardId,
          shardIndex: shard.shardIndex,
          shardKey: shard.shardKey,
          status: "pending",
          attemptCount: 0,
          attemptedAliases: [],
          receiptRefs: [],
          lastError: null,
        };
  }
  return next;
}

function candidateDevices({ unit, devices, busyAliases, state, allowReassign }) {
  const capabilityId = unit.node.executor.capabilityId;
  const fixedAlias = unit.boundNode?.placementConstraint?.alias || unit.shard.placement.alias;
  const allowedAliases = new Set(unit.shard.placement.eligibleAliases || []);
  const attempted = new Set(state.workUnits[unit.key].attemptedAliases || []);
  const candidates = devices
    .filter(healthy)
    .filter((device) => !busyAliases.has(deviceAlias(device)))
    .filter((device) => deviceCapabilityIds(device).includes(capabilityId))
    .filter((device) => !(state.capabilityBlocks || []).some((block) => block.alias === deviceAlias(device) && block.capabilityId === capabilityId))
    .filter((device) => !fixedAlias || deviceAlias(device) === fixedAlias)
    .filter((device) => allowedAliases.size === 0 || allowedAliases.has(deviceAlias(device)))
    .sort((a, b) => deviceAlias(a).localeCompare(deviceAlias(b)));
  if (!allowReassign || fixedAlias) return candidates;
  const fresh = candidates.filter((device) => !attempted.has(deviceAlias(device)));
  return fresh.length ? fresh : candidates;
}

function normalizeFleet(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.devices)) return result.devices;
  if (Array.isArray(result?.fleet)) return result.fleet;
  throw new Error("fleetProvider must return devices[]");
}

function requireSchedulerConstraints(executionPlan) {
  const constraints = executionPlan.constraints;
  if (!constraints || typeof constraints !== "object") {
    throw codeError("EXECUTION_PLAN_INVALID", "executionPlan.constraints required for scheduling");
  }
  if (isBusinessEffectPlan(executionPlan)) {
    if (constraints.maxWorkers !== 1 || constraints.allowReassign !== false || constraints.maxAttemptsPerShard !== 1) {
      throw codeError("EXECUTION_PLAN_CONSTRAINT_MISMATCH", "business effect plans require maxWorkers=1, allowReassign=false, maxAttemptsPerShard=1");
    }
  }
  return {
    maxWorkers: constraints.maxWorkers,
    allowReassign: constraints.allowReassign,
    maxAttemptsPerShard: constraints.maxAttemptsPerShard,
  };
}

function buildAssignment({ taskRunId, plan, executionPlan, unit, alias, workerId, attemptIndex, attemptId }) {
  return {
    taskRunId,
    planHash: plan.planHash,
    executionPlanHash: executionPlan.executionPlanHash,
    node: unit.node,
    boundNode: unit.boundNode,
    shard: unit.shard,
    capabilityContractHash: unit.boundNode.capabilityContractHash || null,
    capabilityContractHashAlgorithm: unit.boundNode.capabilityContractHashAlgorithm || null,
    implementationClosureHash: unit.boundNode.implementationClosureHash || null,
    operationKey: `m2:${taskRunId}:${unit.shard.shardKey}`,
    alias,
    workerId,
    attemptIndex,
    attemptId,
  };
}

function assertReceiptFencing(receipt, assignment, activeJob = null) {
  const expected = {
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
  };
  for (const [key, value] of Object.entries(expected)) {
    if (receipt[key] !== value) throw new Error(`WORK_RECEIPT_FENCING_MISMATCH field=${key}`);
  }
  if (activeJob?.jobId && receipt.jobId !== activeJob.jobId) throw new Error("WORK_RECEIPT_FENCING_MISMATCH field=jobId");
  if (activeJob?.runId && (receipt.runId || receipt.controlPlaneRunId) !== activeJob.runId) {
    throw new Error("WORK_RECEIPT_FENCING_MISMATCH field=runId");
  }
  if (receipt.schemaId === "xhs.work-receipt.v2") {
    const integrityExpected = {
      executionPlanHash: assignment.executionPlanHash,
      operationKey: assignment.operationKey,
      capabilityContractHash: assignment.boundNode?.capabilityContractHash ?? assignment.capabilityContractHash ?? null,
      capabilityContractHashAlgorithm: assignment.boundNode?.capabilityContractHashAlgorithm
        ?? assignment.capabilityContractHashAlgorithm
        ?? null,
      implementationClosureHash: assignment.boundNode?.implementationClosureHash
        ?? assignment.implementationClosureHash
        ?? null,
    };
    for (const [key, value] of Object.entries(integrityExpected)) {
      if (value != null && receipt[key] !== value) {
        throw new Error(`WORK_RECEIPT_FENCING_MISMATCH field=${key}`);
      }
    }
  }
  return receipt;
}

export async function runTaskOrchestrator({
  taskRunId,
  plan,
  executionPlan = null,
  executionPlanHash = null,
  fleetProvider,
  worker,
  store,
}) {
  assertTaskPlanV2(plan);
  if (!taskRunId) throw new Error("taskRunId is required");
  if (typeof fleetProvider !== "function") throw new Error("fleetProvider is required");
  if (!worker || typeof worker.execute !== "function") throw new Error("worker.execute is required");
  if (!store) throw new Error("store is required");

  assertExecutionPlan(executionPlan, plan);
  const resolvedExecutionPlanHash = executionPlanHash || executionPlan.executionPlanHash;
  if (resolvedExecutionPlanHash !== executionPlan.executionPlanHash) {
    throw codeError("EXECUTION_PLAN_SOURCE_MISMATCH", "executionPlanHash does not match ExecutionPlan");
  }
  const scheduler = requireSchedulerConstraints(executionPlan);

  const releaseLeadLock = typeof store.acquireLeadLock === "function" ? store.acquireLeadLock(plan.planHash) : () => {};
  try {

  let state = ensureWorkUnits(plan, executionPlan, store.init(plan, {
    executionPlan,
    executionPlanHash: resolvedExecutionPlanHash,
  }));
  if (state.planHash !== plan.planHash) throw new Error("TASK_RUN_PLAN_CONFLICT");
  state.capabilityBlocks = [...(state.capabilityBlocks || [])];
  state.status = "running";
  store.writeState(state);
  store.appendEvent({
    type: "task_started",
    taskRunId,
    planHash: plan.planHash,
    executionPlanHash: resolvedExecutionPlanHash,
  });

  const units = planUnits(plan, executionPlan);
  const active = new Map();
  const busyAliases = new Set();
  const busyWorkers = new Set();

  function saveState() {
    store.writeState(state);
  }

  function allocateWorkerId() {
    for (let index = 1; index <= scheduler.maxWorkers; index += 1) {
      const id = `worker-${index}`;
      if (!busyWorkers.has(id)) return id;
    }
    return null;
  }

  function startWork(unit, assignment, { resume = false } = {}) {
    const record = state.workUnits[unit.key];
    assignment.resume = resume;
    assignment.resumeJobId = record.activeJob?.jobId || null;
    assignment.onProgress = async (progress) => {
      if (record.inflight?.attemptId !== assignment.attemptId) throw new Error("WORK_PROGRESS_FENCING_MISMATCH");
      if (progress?.type === "job_bound") {
        record.activeJob = {
          jobId: progress.jobId,
          runId: progress.runId || null,
          alias: assignment.alias,
          status: progress.status || null,
          boundAt: new Date().toISOString(),
        };
        record.attempts = [...(record.attempts || [])];
        record.attempts[assignment.attemptIndex] = {
          ...(record.attempts[assignment.attemptIndex] || {
            attemptId: assignment.attemptId,
            attemptIndex: assignment.attemptIndex,
            alias: assignment.alias,
            workerId: assignment.workerId,
          }),
          jobId: progress.jobId,
          runId: progress.runId || null,
        };
        store.appendEvent({
          type: "job_bound",
          nodeId: unit.node.nodeId,
          shardId: unit.shard.shardId,
          attemptId: assignment.attemptId,
          alias: assignment.alias,
          jobId: progress.jobId,
          runId: progress.runId || null,
        });
        saveState();
      }
    };
    record.status = "running";
    busyAliases.add(assignment.alias);
    busyWorkers.add(assignment.workerId);
    if (!resume) {
      record.attemptCount += 1;
      record.attemptedAliases.push(assignment.alias);
      record.inflight = {
        attemptId: assignment.attemptId,
        attemptIndex: assignment.attemptIndex,
        alias: assignment.alias,
        workerId: assignment.workerId,
      };
      record.attempts = [...(record.attempts || [])];
      record.attempts[assignment.attemptIndex] = {
        attemptId: assignment.attemptId,
        attemptIndex: assignment.attemptIndex,
        alias: assignment.alias,
        workerId: assignment.workerId,
      };
      store.appendAssignment(assignment);
      store.appendEvent({ type: "work_assigned", nodeId: unit.node.nodeId, shardId: unit.shard.shardId, attemptId: assignment.attemptId, workerId: assignment.workerId, alias: assignment.alias });
    } else {
      store.appendEvent({ type: "work_resumed", nodeId: unit.node.nodeId, shardId: unit.shard.shardId, attemptId: assignment.attemptId, workerId: assignment.workerId, alias: assignment.alias, jobId: assignment.resumeJobId });
    }
    saveState();
    const promise = Promise.resolve(worker.execute(assignment)).then((receipt) => ({ unit, assignment, receipt }));
    active.set(assignment.attemptId, promise);
  }

  while (true) {
    for (const unit of units) {
      const record = state.workUnits[unit.key];
      if (record.status !== "pending") continue;
      if (dependenciesTerminalButRejected(plan, state, unit.node)) {
        record.status = "blocked";
        record.lastError = { code: "DEPENDENCY_NOT_ACCEPTED", message: "a dependency did not pass business acceptance" };
        store.appendEvent({ type: "work_blocked", nodeId: unit.node.nodeId, shardId: unit.shard.shardId, error: record.lastError });
      }
    }

    const finalCount = units.filter((unit) => FINAL_UNIT_STATES.has(state.workUnits[unit.key].status)).length;
    if (finalCount === units.length && active.size === 0) break;

    let dispatched = false;
    if (active.size < scheduler.maxWorkers) {
      const runnable = units
        .filter((unit) => state.workUnits[unit.key].status === "pending")
        .filter((unit) => dependenciesAccepted(plan, state, unit.node))
        .sort((a, b) => a.node.nodeIndex - b.node.nodeIndex || a.shard.shardIndex - b.shard.shardIndex);

      for (const unit of runnable.filter((candidate) => state.workUnits[candidate.key].inflight)) {
        if (active.size >= scheduler.maxWorkers) break;
        const record = state.workUnits[unit.key];
        if (busyAliases.has(record.inflight.alias)) continue;
        const workerId = record.inflight.workerId || allocateWorkerId();
        if (!workerId) break;
        startWork(unit, buildAssignment({
          taskRunId,
          plan,
          executionPlan,
          unit,
          alias: record.inflight.alias,
          workerId,
          attemptIndex: record.inflight.attemptIndex,
          attemptId: record.inflight.attemptId,
        }), { resume: true });
        dispatched = true;
      }

      const devices = normalizeFleet(await fleetProvider());

      for (const unit of runnable.filter((candidate) => !state.workUnits[candidate.key].inflight)) {
        if (active.size >= scheduler.maxWorkers) break;
        const workerId = allocateWorkerId();
        if (!workerId) break;
        const candidates = candidateDevices({
          unit,
          devices,
          busyAliases,
          state,
          allowReassign: scheduler.allowReassign,
        });
        const device = candidates[0];
        if (!device) continue;

        const alias = deviceAlias(device);
        const record = state.workUnits[unit.key];
        const attemptIndex = record.attemptCount;
        const assignment = buildAssignment({
          taskRunId,
          plan,
          executionPlan,
          unit,
          alias,
          workerId,
          attemptIndex,
          attemptId: `attempt_${unit.shard.shardKey.slice(0, 16)}_${attemptIndex}_${randomUUID().slice(0, 8)}`,
        });
        startWork(unit, assignment);
        dispatched = true;
      }
    }

    if (active.size === 0) {
      const pending = units.filter((unit) => state.workUnits[unit.key].status === "pending");
      if (pending.length) {
        for (const unit of pending) {
          const record = state.workUnits[unit.key];
          record.status = "blocked";
          record.lastError = dependenciesAccepted(plan, state, unit.node)
            ? { code: "NO_ELIGIBLE_DEVICE", message: "no ready/free device can prove the required capability" }
            : { code: "DEPENDENCY_UNRESOLVED", message: "dependencies never became eligible" };
          store.appendEvent({ type: "work_blocked", nodeId: unit.node.nodeId, shardId: unit.shard.shardId, error: record.lastError });
        }
        saveState();
        continue;
      }
      if (!dispatched) break;
    }

    if (active.size > 0) {
      const completed = await Promise.race(active.values());
      active.delete(completed.assignment.attemptId);
      busyAliases.delete(completed.assignment.alias);
      busyWorkers.delete(completed.assignment.workerId);
      const receipt = assertWorkReceipt(completed.receipt);
      const record = state.workUnits[completed.unit.key];
      assertReceiptFencing(receipt, completed.assignment, record.activeJob);
      const relative = store.writeReceipt(receipt);
      record.receiptRefs.push(relative);
      if (!state.receiptRefs.includes(relative)) state.receiptRefs.push(relative);
      record.lastError = receipt.error || null;
      const ambiguousReceipt = receipt.technicalStatus === "ambiguous" || receipt.businessStatus === "ambiguous";
      if (ambiguousReceipt && record.activeJob) {
        const reconciliationIndex = record.attemptCount;
        const reconciliation = {
          attemptId: `reconcile_${completed.unit.shard.shardKey.slice(0, 16)}_${reconciliationIndex}_${randomUUID().slice(0, 8)}`,
          attemptIndex: reconciliationIndex,
          alias: receipt.alias,
          workerId: receipt.workerId,
          jobId: record.activeJob.jobId,
          runId: record.activeJob.runId || null,
        };
        record.attemptCount += 1;
        record.inflight = reconciliation;
        record.attempts = [...(record.attempts || [])];
        record.attempts[reconciliationIndex] = reconciliation;
      } else if (!ambiguousReceipt) {
        record.inflight = null;
        record.activeJob = null;
      }
      if (/^(ADAPTER_HTTP_UNAVAILABLE|EXPECTED_APP_MISMATCH|EXPECTED_APP_ID_MISMATCH|EXPECTED_ACTIVITY_MISMATCH)$/.test(receipt.error?.code || "")) {
        const capabilityId = completed.unit.node.executor.capabilityId;
        if (!state.capabilityBlocks.some((block) => block.alias === receipt.alias && block.capabilityId === capabilityId)) {
          const block = { alias: receipt.alias, capabilityId, code: receipt.error.code, observedAt: new Date().toISOString() };
          state.capabilityBlocks.push(block);
          store.appendEvent({ type: "capability_blocked", ...block });
        }
      }
      if (receiptAccepted(receipt)) record.status = "succeeded";
      else if (ambiguousReceipt) record.status = "ambiguous";
      else if (receipt.retryable && record.attemptCount < scheduler.maxAttemptsPerShard) record.status = "pending";
      else if (receipt.technicalStatus === "blocked") record.status = "blocked";
      else record.status = "failed";
      store.appendEvent({
        type: "work_finished",
        nodeId: completed.unit.node.nodeId,
        shardId: completed.unit.shard.shardId,
        attemptId: receipt.attemptId,
        alias: receipt.alias,
        technicalStatus: receipt.technicalStatus,
        businessStatus: receipt.businessStatus,
        retryable: receipt.retryable,
      });
      saveState();
    }
  }

  state.status = "reducing";
  saveState();
  const receipts = store.loadReceipts(state).map((receipt) => {
    assertWorkReceipt(receipt);
    const unit = units.find((candidate) => candidate.node.nodeId === receipt.nodeId && candidate.shard.shardId === receipt.shardId);
    if (!unit) throw new Error("WORK_RECEIPT_FENCING_MISMATCH field=workUnit");
    const attempt = state.workUnits[unit.key].attempts?.[receipt.attemptIndex];
    if (!attempt) throw new Error("WORK_RECEIPT_FENCING_MISMATCH field=attemptIndex");
    return assertReceiptFencing(receipt, {
      taskRunId,
      planHash: plan.planHash,
      executionPlanHash: executionPlan.executionPlanHash,
      operationKey: `m2:${taskRunId}:${unit.shard.shardKey}`,
      boundNode: unit.boundNode,
      capabilityContractHash: unit.boundNode.capabilityContractHash || null,
      capabilityContractHashAlgorithm: unit.boundNode.capabilityContractHashAlgorithm || null,
      implementationClosureHash: unit.boundNode.implementationClosureHash || null,
      node: unit.node,
      shard: unit.shard,
      ...attempt,
    }, attempt);
  });
  const result = reduceMission({ taskRunId, plan, receipts, workUnits: state.workUnits });
  state.status = result.status;
  state.finishedAt = new Date().toISOString();
  saveState();
  store.writeResult(result);
  store.appendEvent({ type: "task_finished", status: result.status, summary: result.summary });
  return result;
  } finally {
    releaseLeadLock();
  }
}
