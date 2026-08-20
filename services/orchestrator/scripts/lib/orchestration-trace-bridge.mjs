// Thin mapping from the existing TaskPlanV2 scheduler lifecycle to M5 trace events.
// It persists through TraceStore before control returns to the scheduler.
import { TraceStore } from "../../../../packages/harness-protocol/lib/trace-store.mjs";

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

export class OrchestrationTraceBridge {
  constructor({
    traceId,
    taskRunId,
    planRunId = taskRunId,
    traceStore = new TraceStore(),
    skillByNode,
    validationNode = null,
  } = {}) {
    if (typeof traceId !== "string" || !traceId) fail("TRACE_BRIDGE_ID", "traceId is required");
    if (typeof taskRunId !== "string" || !taskRunId) fail("TRACE_BRIDGE_RUN", "taskRunId is required");
    this.traceId = traceId;
    this.taskRunId = taskRunId;
    this.planRunId = planRunId;
    this.traceStore = traceStore;
    this.skillByNode = skillByNode instanceof Map ? new Map(skillByNode) : new Map(Object.entries(skillByNode || {}));
    this.validationNode = validationNode;
  }

  #skill(nodeId) {
    const skillId = this.skillByNode.get(nodeId);
    if (!skillId) fail("TRACE_SKILL_BINDING_MISSING", `no registered skill binding for node ${nodeId}`);
    return skillId;
  }

  #ids({ nodeId = null, shardId = null, assignment = null, verification = false } = {}) {
    return {
      traceId: this.traceId,
      missionRunId: this.taskRunId,
      planRunId: this.planRunId,
      ...(nodeId ? { nodeRunId: `${this.taskRunId}:${nodeId}` } : {}),
      ...(shardId ? { shardRunId: `${this.taskRunId}:${shardId}` } : {}),
      ...(assignment ? { workerRunId: `${this.taskRunId}:${assignment.workerId}:${assignment.attemptId}` } : {}),
      ...(verification ? { verificationRunId: `${this.taskRunId}:validation` } : {}),
    };
  }

  begin({ taskType, dagId, planHash }) {
    this.traceStore.append({
      traceId: this.traceId,
      type: "TaskCreated",
      ids: this.#ids(),
      status: "created",
      payload: { taskType, dagId },
    });
    this.traceStore.append({
      traceId: this.traceId,
      type: "PlanGenerated",
      ids: this.#ids(),
      status: "planned",
      payload: { dagId, planHash },
    });
  }

  workerAssigned({ nodeId, shardId, assignment }) {
    this.traceStore.append({
      traceId: this.traceId,
      type: "WorkerAssigned",
      ids: this.#ids({ nodeId, shardId, assignment }),
      nodeId,
      skillId: this.#skill(nodeId),
      alias: assignment.alias,
      status: "assigned",
      payload: { workerId: assignment.workerId, attemptIndex: assignment.attemptIndex },
    });
  }

  skillStarted({ nodeId, shardId, assignment }) {
    this.traceStore.append({
      traceId: this.traceId,
      type: "SkillStarted",
      ids: this.#ids({ nodeId, shardId, assignment }),
      nodeId,
      skillId: this.#skill(nodeId),
      alias: assignment.alias,
      jobId: assignment.resumeJobId || null,
      status: "running",
      payload: { attemptIndex: assignment.attemptIndex, resumed: assignment.resume === true },
    });
  }

  skillFinished({ nodeId, shardId, assignment, receipt, status }) {
    this.traceStore.append({
      traceId: this.traceId,
      type: "SkillFinished",
      ids: this.#ids({ nodeId, shardId, assignment }),
      nodeId,
      skillId: this.#skill(nodeId),
      alias: assignment.alias,
      jobId: receipt.jobId || null,
      status,
      payload: {
        technicalStatus: receipt.technicalStatus,
        businessStatus: receipt.businessStatus,
        retryable: receipt.retryable === true,
        ...(receipt.error?.code ? { errorCode: receipt.error.code } : {}),
      },
    });
  }

  repairTriggered({ nodeId, shardId, assignment, reasonCode }) {
    this.traceStore.append({
      traceId: this.traceId,
      type: "RepairTriggered",
      ids: this.#ids({ nodeId, shardId, assignment }),
      nodeId,
      skillId: this.#skill(nodeId),
      alias: assignment.alias,
      status: "repair_needed",
      payload: { reasonCode },
    });
  }

  validationPassed({ result }) {
    const nodeId = this.validationNode?.nodeId ?? null;
    const skillId = this.validationNode?.skillId ?? null;
    this.traceStore.append({
      traceId: this.traceId,
      type: "ValidationPassed",
      ids: this.#ids({ nodeId, verification: true }),
      nodeId,
      skillId,
      status: "succeeded",
      payload: { accepted: result.summary?.accepted ?? 0, failed: result.summary?.failed ?? 0 },
    });
  }

  localValidationStarted() {
    const nodeId = this.validationNode?.nodeId;
    const skillId = this.validationNode?.skillId;
    if (!nodeId || !skillId) fail("TRACE_VALIDATOR_BINDING_MISSING", "local validation requires a registered validator node");
    this.traceStore.append({
      traceId: this.traceId,
      type: "SkillStarted",
      ids: this.#ids({ nodeId, verification: true }),
      nodeId,
      skillId,
      status: "running",
      payload: { localValidator: true },
    });
  }

  localValidationFinished({ validation }) {
    const nodeId = this.validationNode?.nodeId;
    const skillId = this.validationNode?.skillId;
    if (!nodeId || !skillId) fail("TRACE_VALIDATOR_BINDING_MISSING", "local validation requires a registered validator node");
    this.traceStore.append({
      traceId: this.traceId,
      type: "SkillFinished",
      ids: this.#ids({ nodeId, verification: true }),
      nodeId,
      skillId,
      status: validation?.ok ? "succeeded" : "failed",
      payload: validation?.ok
        ? { resultCode: validation.code || "VALIDATION_PASSED" }
        : { errorCode: validation?.code || "VALIDATION_FAILED" },
    });
  }
}
