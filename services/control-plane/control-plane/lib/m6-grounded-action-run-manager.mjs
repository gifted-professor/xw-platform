import { canonicalJson } from "./canonical.mjs";
import { ControlPlaneError } from "./errors.mjs";
import { deriveM64ScenarioActionPlan } from "../../../../packages/kernel/lib/m6-4-cohort.mjs";

const REQUIRED_CALLBACKS = Object.freeze(["observe", "ground", "act", "verify", "checkpointAudit", "trace", "waitHuman", "complete", "close"]);
const ZERO_ACTION_PURPOSES = new Set(["M6_4_SHADOW", "M6_4_HOT_CLOSE"]);

function fail(code, message, details = {}) {
  throw new ControlPlaneError(code, message, { status: 409, details });
}

function requireRef(value, label) {
  if (typeof value !== "string" || !/^(?:[a-z0-9][a-z0-9:_-]{7,127}|[0-9a-f]{64})$/iu.test(value)) fail("M6_LIVE_RUN_REF_INVALID", `${label} is not an opaque reference`);
  return value;
}

function publicRun(run) {
  return Object.freeze({
    runId: run.binding.runId,
    workerRunRef: run.workerRunRef,
    status: run.status,
    started: run.started,
    actionCount: run.actionCount,
    maxActionCount: run.actionPlan.maxActionCount,
    completedActionSlots: run.nextSlotIndex,
    closeStarted: run.closeStarted,
    closed: run.closed,
  });
}

function requireActionPlan(context, purpose) {
  const plan = context?.scenario?.actionPlan;
  const zero = ZERO_ACTION_PURPOSES.has(purpose);
  let derived;
  try {
    derived = deriveM64ScenarioActionPlan(plan || {});
  } catch {}
  if (!derived || plan?.actionPlanHash !== derived.actionPlanHash) {
    fail("M6_LIVE_SCENARIO_PLAN_INVALID", "the run requires one closed ordered action plan from its frozen scenario");
  }
  if ((zero && derived.maxActionCount !== 0) || (!zero && derived.maxActionCount < 1)) {
    fail("M6_LIVE_SCENARIO_PLAN_INVALID", "the action-plan cardinality does not match the cohort purpose");
  }
  return derived;
}

export function createM6GroundedActionRunManager(callbacks = {}) {
  for (const name of REQUIRED_CALLBACKS) if (typeof callbacks[name] !== "function") throw new TypeError(`M6 run manager callback ${name} is required`);
  const runs = new Map();

  function requireRun(runId) {
    const run = runs.get(runId);
    if (!run) fail("M6_LIVE_RUN_NOT_FOUND", "the broker run is not owned by this Control Plane");
    return run;
  }

  function requireOpen(run) {
    if (run.closeStarted || run.closed) fail("M6_LIVE_RUN_CLOSED", "the live run is closing or closed");
  }

  const manager = {
    openRun({ binding, authorizationId, workerRunRef, context = null } = {}) {
      if (!binding || typeof binding.runId !== "string" || typeof authorizationId !== "string" || authorizationId === "") {
        throw new TypeError("M6 live run requires exact binding and authorizationId");
      }
      requireRef(workerRunRef, "workerRunRef");
      if (runs.has(binding.runId)) fail("M6_LIVE_RUN_EXISTS", "one DSH run already exists for this runId");
      const actionPlan = requireActionPlan(context, binding.purpose);
      const run = {
        binding: Object.freeze({ ...binding }),
        authorizationId,
        workerRunRef,
        context,
        actionPlan,
        status: "OPEN",
        started: false,
        actionCount: 0,
        nextSlotIndex: 0,
        lastFrameRef: null,
        decision: null,
        actions: new Map(),
        pendingAction: null,
        failedAction: false,
        terminal: false,
        closeStarted: false,
        closed: false,
        closeReceipt: null,
      };
      runs.set(binding.runId, run);
      return publicRun(run);
    },

    getRunBinding(runId) {
      return runs.get(runId)?.binding ?? null;
    },

    getRun(runId) {
      const run = runs.get(runId);
      return run ? publicRun(run) : null;
    },

    async handleToolCall({ method, params, binding, fence, authorizationConsumption, signal = null }) {
      const run = requireRun(binding.runId);
      requireOpen(run);
      const inheritedSignal = run.context?.abortSignal;
      const abortSignal = signal && inheritedSignal
        ? AbortSignal.any([signal, inheritedSignal])
        : signal ?? inheritedSignal ?? null;
      if (abortSignal?.aborted) fail("M6_LIVE_CALL_ABORTED", "the live tool call was aborted before callback dispatch");
      if (canonicalJson(run.binding) !== canonicalJson(binding)) fail("M6_LIVE_RUN_BINDING_MISMATCH", "tool call binding changed after run creation");
      if (run.terminal) fail("M6_LIVE_RUN_TERMINAL", "no tool call is admitted after worker completion");
      if (run.status === "WAITING" && method !== "worker_complete") {
        fail("M6_LIVE_RUN_WAITING", "a waiting M6-4 run may only terminate; resume begins in M6-5");
      }
      const slotAuthority = run.actionPlan.slots[run.nextSlotIndex] ?? null;
      const context = run.context && Object.freeze({ ...run.context, abortSignal });
      const call = Object.freeze({ run, params, fence, authorizationConsumption, context, slotAuthority, signal: abortSignal });
      switch (method) {
        case "worker_start":
          if (run.started || params.workerRunRef !== run.workerRunRef) fail("M6_LIVE_RUN_START_INVALID", "worker_start must occur once for the server-owned worker reference");
          run.started = true;
          run.status = "RUNNING";
          return { externalEffect: false, actionCount: 0, workerRunRef: run.workerRunRef, status: "RUNNING" };
        case "worker_continue":
          fail("M6_LIVE_RESUME_NOT_ENABLED", "M6-4 live runs cannot resume; checkpoint/reconcile begins in M6-5");
          break;
        case "phone_observe": {
          if (!run.started) fail("M6_LIVE_RUN_NOT_STARTED", "phone_observe requires worker_start");
          if (run.pendingAction || run.failedAction) fail("M6_LIVE_ACTION_UNVERIFIED", "the prior logical action must reach a terminal verification before reobserve");
          if (run.nextSlotIndex >= run.actionPlan.maxActionCount && run.actionPlan.maxActionCount > 0) {
            fail("M6_LIVE_ACTION_PLAN_EXHAUSTED", "the frozen scenario has no remaining logical action slot");
          }
          const result = await callbacks.observe(call);
          run.lastFrameRef = result.frameRef;
          run.decision = null;
          return result;
        }
        case "phone_ground": {
          if (!run.lastFrameRef || params.frameRef !== run.lastFrameRef) fail("M6_LIVE_FRAME_REF_MISMATCH", "phone_ground must use the latest server-owned frame");
          if (run.pendingAction || run.failedAction || (!slotAuthority && !ZERO_ACTION_PURPOSES.has(run.binding.purpose))) {
            fail("M6_LIVE_ACTION_PLAN_EXHAUSTED", "phone_ground has no available frozen action slot");
          }
          const result = await callbacks.ground(call);
          run.decision = result.disposition === "ALLOW_ONCE"
            ? Object.freeze({
                decisionRef: result.decisionRef,
                operationKey: result.operationKey,
                sequenceIndex: run.nextSlotIndex,
                slotAuthorityHash: slotAuthority?.slotAuthorityHash ?? null,
              })
            : null;
          if (run.decision && run.actions.has(run.decision.operationKey)) {
            fail("M6_LIVE_ACTION_REPLAY", "the grounded operationKey already belongs to a consumed logical slot");
          }
          return result;
        }
        case "phone_act": {
          if (ZERO_ACTION_PURPOSES.has(run.binding.purpose)) {
            fail("M6_LIVE_ZERO_ACTION_PURPOSE", `${run.binding.purpose} forbids every physical action`);
          }
          if (run.actions.has(params.operationKey)) {
            fail("M6_LIVE_ACTION_REPLAY", "the requested operationKey already consumed one frozen logical slot");
          }
          if (!run.decision || params.decisionRef !== run.decision.decisionRef || params.operationKey !== run.decision.operationKey) {
            fail("M6_LIVE_DECISION_REF_MISMATCH", "phone_act must use the latest server-owned one-shot decision");
          }
          if (run.pendingAction || run.decision.sequenceIndex !== run.nextSlotIndex
            || run.decision.slotAuthorityHash !== slotAuthority?.slotAuthorityHash
            || run.actions.has(run.decision.operationKey)) {
            fail("M6_LIVE_ACTION_REPLAY", "M6-4 never dispatches the same frozen logical slot twice");
          }
          const result = await callbacks.act(call);
          if (![0, 1].includes(result.actionCount)
            || run.actionCount + result.actionCount > run.actionPlan.maxActionCount) {
            fail("M6_LIVE_ACTION_COUNTER_INVALID", "per-call action counter exceeds the frozen cumulative budget");
          }
          const action = Object.freeze({ decision: run.decision, slotAuthority, result });
          run.actions.set(run.decision.operationKey, action);
          run.actionCount += result.actionCount;
          run.nextSlotIndex += 1;
          run.pendingAction = action;
          run.decision = null;
          run.lastFrameRef = null;
          return result;
        }
        case "phone_verify": {
          if (!run.pendingAction || run.pendingAction.result.actionCount !== 1
            || params.actionReceiptRef !== run.pendingAction.result.actionReceiptRef) {
            fail("M6_LIVE_ACTION_REF_MISMATCH", "phone_verify must bind the current sent action receipt");
          }
          const result = await callbacks.verify(call);
          run.pendingAction = null;
          run.failedAction = result.verified !== true;
          return result;
        }
        case "checkpoint_save":
          return callbacks.checkpointAudit(call);
        case "trace_query":
          return callbacks.trace(call);
        case "wait_human":
          run.status = "WAITING";
          return callbacks.waitHuman(call);
        case "worker_complete": {
          if (!run.started || params.workerRunRef !== run.workerRunRef) fail("M6_LIVE_RUN_COMPLETE_INVALID", "worker_complete does not bind the active worker");
          if (run.pendingAction) fail("M6_LIVE_ACTION_UNVERIFIED", "worker_complete cannot hide an unresolved physical action");
          const successful = params.outcome === "SUCCEEDED";
          if (successful && (run.failedAction
            || run.nextSlotIndex !== run.actionPlan.maxActionCount
            || run.actionCount !== run.actionPlan.maxActionCount)) {
            fail("M6_LIVE_RUN_INCOMPLETE", "successful completion must consume and verify every frozen physical slot exactly once");
          }
          const result = await callbacks.complete(call);
          run.status = result.status;
          run.terminal = true;
          return result;
        }
        default:
          fail("M6_LIVE_TOOL_FORBIDDEN", "method is outside the exact live run state machine");
      }
      return null;
    },

    async closeRun(runId, reason = "operator") {
      const run = requireRun(runId);
      if (run.closed) return run.closeReceipt;
      if (run.closeStarted) return run.closePromise;
      run.closeStarted = true;
      run.closePromise = Promise.resolve(callbacks.close({ run, context: run.context, reason })).then((receipt) => {
        if (!receipt || receipt.verifiedClosed !== true) fail("M6_LIVE_RUN_CLOSE_UNVERIFIED", "run cleanup did not prove all owned resources closed");
        run.closeReceipt = Object.freeze({ ...receipt });
        run.closed = true;
        run.status = "CLOSED";
        run.context = null;
        return run.closeReceipt;
      });
      return run.closePromise;
    },

    forgetClosedRun(runId) {
      const run = requireRun(runId);
      if (!run.closed) fail("M6_LIVE_RUN_NOT_CLOSED", "a live run cannot be forgotten before verified cleanup");
      runs.delete(runId);
      return true;
    },
  };
  return Object.freeze(manager);
}
