import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { assertExecutionPlan, isExecutionPlan } from "./task-plan-capability-binding.mjs";

function safeSegment(value, label) {
  const text = String(value || "");
  if (!/^[a-zA-Z0-9._-]+$/.test(text)) throw new Error(`${label} has unsafe path characters`);
  return text;
}

function codeError(code, message) {
  return Object.assign(new Error(message), { code });
}

/** write temp → fsync → atomic rename */
function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const body = `${JSON.stringify(value, null, 2)}\n`;
  const fd = openSync(temp, "w");
  try {
    writeFileSync(fd, body, "utf8");
    try { fsyncSync(fd); } catch { /* best-effort on platforms without fsync */ }
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
}

const BUSINESS_EFFECT_CLASSES = new Set(["social", "publish", "payment", "delete"]);

/**
 * Build Foundation run-manifest.v2 work units from raw plan + ExecutionPlan.
 * New runs MUST supply a bound ExecutionPlan (INV-07). Durable readers of old
 * manifests remain separate — this factory does not create unbound runs.
 * operationKey is stable: m2:{taskRunId}:{shardKey} (no attemptIndex).
 */
export function buildRunManifest({
  taskRunId,
  plan,
  executionPlan = null,
  executionPlanHash = null,
  runtimeReleaseId = null,
  runtimeTreeHash = null,
} = {}) {
  if (!taskRunId) throw new Error("taskRunId is required");
  if (!plan?.planHash) throw new Error("plan.planHash is required");
  if (!isExecutionPlan(executionPlan)) {
    throw codeError("EXECUTION_PLAN_REQUIRED", "buildRunManifest requires a bound ExecutionPlan");
  }
  assertExecutionPlan(executionPlan, plan);
  const workUnits = [];
  for (const node of plan.nodes || []) {
    const bound = executionPlan.nodes?.find((n) => n.nodeId === node.nodeId) || null;
    if (!bound) {
      throw codeError("EXECUTION_PLAN_NODE_MISSING", `ExecutionPlan missing node ${node.nodeId}`);
    }
    for (const shard of node.shards || []) {
      const alias = shard.placement?.alias || bound?.placementConstraint?.alias || null;
      workUnits.push({
        nodeId: node.nodeId,
        shardId: shard.shardId,
        shardKey: shard.shardKey,
        operationKey: `m2:${taskRunId}:${shard.shardKey}`,
        alias,
        // final deviceId is resolved at preflight/run assignment time; null here is intentional
        deviceId: null,
        capabilityId: node.executor?.capabilityId || bound.capabilityId || null,
        capabilityContractHash: bound.capabilityContractHash || null,
        capabilityContractHashAlgorithm: bound.capabilityContractHashAlgorithm || null,
        implementationClosureHash: bound.implementationClosureHash || null,
        normalizedEffect: bound.normalizedEffect || null,
      });
    }
  }
  return {
    schemaId: "xhs.run-manifest.v2",
    schemaVersion: 1,
    taskRunId,
    planHash: plan.planHash,
    executionPlanHash: executionPlanHash || executionPlan.executionPlanHash,
    runtimeReleaseId,
    runtimeTreeHash,
    workUnits,
    createdAt: new Date().toISOString(),
  };
}

export function isBusinessEffectPlan(plan, executionPlan = null) {
  if (executionPlan?.nodes?.some((n) => BUSINESS_EFFECT_CLASSES.has(n?.normalizedEffect?.class))) {
    return true;
  }
  // Fallback: raw assertion external_effect
  return (plan?.nodes || []).some((n) => n?.executor?.effectClass === "external_effect");
}

export class OrchestrationStore {
  constructor({ taskRunId, workRoot = "C:\\Users\\Public\\xhs-registry\\outbox\\work" } = {}) {
    this.taskRunId = safeSegment(taskRunId, "taskRunId");
    this.root = resolve(workRoot, this.taskRunId, "orchestration");
    this.planPath = join(this.root, "plan.v2.json");
    this.statePath = join(this.root, "state.v1.json");
    this.manifestPath = join(this.root, "run-manifest.v2.json");
    this.eventsPath = join(this.root, "events.jsonl");
    this.assignmentsPath = join(this.root, "assignments.jsonl");
    this.resultPath = join(this.root, "result.v1.json");
    this.lockPath = join(this.root, "lead.lock.json");
  }

  acquireLeadLock(planHash) {
    mkdirSync(this.root, { recursive: true });
    const token = randomUUID();
    const payload = { schemaId: "xhs.lead-lock.v1", taskRunId: this.taskRunId, planHash, pid: process.pid, token, acquiredAt: new Date().toISOString() };
    const create = () => {
      const fd = openSync(this.lockPath, "wx");
      try {
        writeFileSync(fd, `${JSON.stringify(payload)}\n`, "utf8");
      } finally {
        closeSync(fd);
      }
    };
    try {
      create();
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let existing = null;
      try { existing = JSON.parse(readFileSync(this.lockPath, "utf8")); } catch { /* fail closed below */ }
      let alive = true;
      if (Number.isInteger(existing?.pid)) {
        try { process.kill(existing.pid, 0); } catch (probeError) { alive = probeError?.code === "EPERM"; }
      }
      if (alive) throw new Error(`LEAD_ALREADY_RUNNING pid=${existing?.pid || "unknown"}`);
      unlinkSync(this.lockPath);
      create();
    }
    return () => {
      if (!existsSync(this.lockPath)) return;
      const current = JSON.parse(readFileSync(this.lockPath, "utf8"));
      if (current.token !== token) throw new Error("LEAD_LOCK_FENCING_MISMATCH");
      unlinkSync(this.lockPath);
    };
  }

  /**
   * Initialize durable run. For business-effect plans, run-manifest.v2.json is written
   * atomically BEFORE scheduler state advances (Foundation durable run contract).
   */
  init(plan, {
    executionPlan = null,
    executionPlanHash = null,
    runtimeReleaseId = null,
    runtimeTreeHash = null,
  } = {}) {
    mkdirSync(this.root, { recursive: true });

    if (existsSync(this.planPath)) {
      const existing = JSON.parse(readFileSync(this.planPath, "utf8"));
      if (existing.planHash !== plan.planHash) throw new Error("TASK_RUN_PLAN_CONFLICT");
    }

    if (existsSync(this.manifestPath)) {
      const existingManifest = JSON.parse(readFileSync(this.manifestPath, "utf8"));
      if (existingManifest.planHash !== plan.planHash) throw new Error("TASK_RUN_PLAN_CONFLICT");
      if (executionPlanHash && existingManifest.executionPlanHash
        && existingManifest.executionPlanHash !== executionPlanHash) {
        throw new Error("TASK_RUN_EXECUTION_PLAN_CONFLICT");
      }
    } else {
      // Atomic manifest first for any new run (required for business effects; always written for resume stability)
      const manifest = buildRunManifest({
        taskRunId: this.taskRunId,
        plan,
        executionPlan,
        executionPlanHash,
        runtimeReleaseId,
        runtimeTreeHash,
      });
      atomicJson(this.manifestPath, manifest);
    }

    if (!existsSync(this.planPath)) {
      atomicJson(this.planPath, plan);
    }

    if (!existsSync(this.statePath)) {
      const manifest = this.loadManifest();
      this.writeState({
        schemaId: "xhs.orchestration-state.v1",
        schemaVersion: 1,
        taskRunId: this.taskRunId,
        planHash: plan.planHash,
        executionPlanHash: manifest.executionPlanHash || executionPlanHash || null,
        status: "queued",
        workUnits: {},
        receiptRefs: [],
        capabilityBlocks: [],
        updatedAt: new Date().toISOString(),
      });
    }
    return this.loadState();
  }

  loadManifest() {
    if (!existsSync(this.manifestPath)) return null;
    return JSON.parse(readFileSync(this.manifestPath, "utf8"));
  }

  /**
   * Persist resolved deviceId for a work unit after scoped preflight/assignment.
   * Does not rewrite operationKey or plan hashes.
   */
  bindWorkUnitDevice({ shardKey, alias, deviceId }) {
    const manifest = this.loadManifest();
    if (!manifest) throw new Error("RUN_MANIFEST_MISSING");
    const unit = (manifest.workUnits || []).find((u) => u.shardKey === shardKey);
    if (!unit) throw new Error(`RUN_MANIFEST_UNIT_MISSING shardKey=${shardKey}`);
    if (unit.deviceId && deviceId && unit.deviceId !== deviceId) {
      throw new Error("RUN_MANIFEST_DEVICE_CONFLICT");
    }
    if (unit.alias && alias && unit.alias !== alias) {
      throw new Error("RUN_MANIFEST_ALIAS_CONFLICT");
    }
    unit.alias = alias || unit.alias;
    unit.deviceId = deviceId || unit.deviceId;
    atomicJson(this.manifestPath, { ...manifest, updatedAt: new Date().toISOString() });
    return unit;
  }

  loadState() {
    return JSON.parse(readFileSync(this.statePath, "utf8"));
  }

  writeState(state) {
    atomicJson(this.statePath, { ...state, updatedAt: new Date().toISOString() });
  }

  appendEvent(event) {
    mkdirSync(this.root, { recursive: true });
    appendFileSync(this.eventsPath, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, "utf8");
  }

  appendAssignment(assignment) {
    mkdirSync(this.root, { recursive: true });
    const record = {
      at: new Date().toISOString(),
      taskRunId: assignment.taskRunId,
      planHash: assignment.planHash,
      nodeId: assignment.node.nodeId,
      shardId: assignment.shard.shardId,
      shardKey: assignment.shard.shardKey,
      attemptId: assignment.attemptId,
      attemptIndex: assignment.attemptIndex,
      workerId: assignment.workerId,
      alias: assignment.alias,
      capabilityId: assignment.node.executor.capabilityId,
      operationKey: `m2:${assignment.taskRunId}:${assignment.shard.shardKey}`,
    };
    appendFileSync(this.assignmentsPath, `${JSON.stringify(record)}\n`, "utf8");
  }

  receiptPath(shardId, attemptIndex) {
    const shard = safeSegment(shardId, "shardId");
    if (!Number.isInteger(attemptIndex) || attemptIndex < 0) throw new Error("attemptIndex must be a non-negative integer");
    return join(this.root, "work-units", shard, "attempts", `${attemptIndex}.receipt.json`);
  }

  findReceipt(shardId, attemptIndex) {
    const path = this.receiptPath(shardId, attemptIndex);
    if (!existsSync(path)) return null;
    return {
      receipt: JSON.parse(readFileSync(path, "utf8")),
      relative: path.slice(this.root.length + 1).replaceAll("\\", "/"),
    };
  }

  writeReceipt(receipt) {
    const path = this.receiptPath(receipt.shardId, receipt.attemptIndex);
    if (existsSync(path)) {
      const existing = JSON.parse(readFileSync(path, "utf8"));
      if (JSON.stringify(existing) !== JSON.stringify(receipt)) throw new Error("ATTEMPT_RECEIPT_CONFLICT");
      return path.slice(this.root.length + 1).replaceAll("\\", "/");
    }
    atomicJson(path, receipt);
    return path.slice(this.root.length + 1).replaceAll("\\", "/");
  }

  loadReceipts(state = this.loadState()) {
    return (state.receiptRefs || []).map((relative) => {
      if (typeof relative !== "string" || relative.includes("..") || relative.startsWith("/") || /^[a-zA-Z]:/.test(relative)) {
        throw new Error("unsafe receipt ref");
      }
      return JSON.parse(readFileSync(join(this.root, relative), "utf8"));
    });
  }

  writeResult(result) {
    atomicJson(this.resultPath, result);
  }
}
