import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

function safeSegment(value, label) {
  const text = String(value || "");
  if (!/^[a-zA-Z0-9._-]+$/.test(text)) throw new Error(`${label} has unsafe path characters`);
  return text;
}

function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temp, path);
}

export class OrchestrationStore {
  constructor({ taskRunId, workRoot = "C:\\Users\\Public\\xhs-registry\\outbox\\work" } = {}) {
    this.taskRunId = safeSegment(taskRunId, "taskRunId");
    this.root = resolve(workRoot, this.taskRunId, "orchestration");
    this.planPath = join(this.root, "plan.v2.json");
    this.statePath = join(this.root, "state.v1.json");
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

  init(plan) {
    mkdirSync(this.root, { recursive: true });
    if (existsSync(this.planPath)) {
      const existing = JSON.parse(readFileSync(this.planPath, "utf8"));
      if (existing.planHash !== plan.planHash) throw new Error("TASK_RUN_PLAN_CONFLICT");
    } else {
      atomicJson(this.planPath, plan);
    }
    if (!existsSync(this.statePath)) {
      this.writeState({
        schemaId: "xhs.orchestration-state.v1",
        schemaVersion: 1,
        taskRunId: this.taskRunId,
        planHash: plan.planHash,
        status: "queued",
        workUnits: {},
        receiptRefs: [],
        capabilityBlocks: [],
        updatedAt: new Date().toISOString(),
      });
    }
    return this.loadState();
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
