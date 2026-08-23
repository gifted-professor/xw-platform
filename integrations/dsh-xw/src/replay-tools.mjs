import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { computeRedlinePolicySha256 } from "../../../services/orchestrator/scripts/lib/m6/m6-contracts.mjs";
import { createEvidenceStore, createGroundingRuntime } from "../../../services/orchestrator/scripts/lib/m6/m6-grounding-runtime.mjs";
import { M6_TOOL_NAMES, M6_TOOL_SPEC, validateToolCall, validateToolResult } from "../../../services/orchestrator/scripts/lib/m6/m6-tool-surface.mjs";

import { sha256Json } from "./canonical-json.mjs";
import { ReplayJournal } from "./replay-journal.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const policy = JSON.parse(readFileSync(join(here, "..", "config", "hard-redline-policy.v1.json"), "utf8"));
const policySha256 = computeRedlinePolicySha256(policy);
const CAPTURED_AT = "2026-08-20T10:00:00.000Z";
const NOW_MS = Date.parse("2026-08-20T10:00:01.000Z");

function opaque(prefix, value) {
  return `${prefix}-${sha256Json(value).slice(0, 32)}`;
}

function baseResult(extra = {}) {
  return { ...extra, externalEffect: false, actionCount: 0 };
}

function assertValid(validation, boundary) {
  if (!validation.ok) {
    const error = new Error(`${boundary}: ${validation.errors.map((entry) => entry.message ?? entry).join("; ")}`);
    error.code = boundary;
    throw error;
  }
}

export class ReplayToolRuntime {
  constructor(ctx, root, options = {}) {
    this.ctx = ctx;
    this.root = root;
    this.profileHash = options.profileHash;
    this.state = {
      workerRunRef: undefined,
      frame: undefined,
      blockSet: undefined,
      decision: undefined,
      actionReceiptRef: undefined,
      verificationRef: undefined,
      calls: [],
    };
    const built = createGroundingRuntime({
      policy,
      expectedPolicySha256: policySha256,
      evidence: createEvidenceStore(),
    });
    assertValid(built, "GROUNDING_RUNTIME_INIT");
    this.grounding = built.runtime;
  }

  definitions() {
    return M6_TOOL_NAMES.map((name) => ({
      name,
      description: M6_TOOL_SPEC[name].description,
      parameters: M6_TOOL_SPEC[name].inputSchema,
      output: {
        schema: M6_TOOL_SPEC[name].outputSchema,
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
      },
      execute: (args, exec) => this.execute(name, args, exec),
    }));
  }

  register() {
    const disposers = this.definitions().map((definition) => this.ctx.tools.register(definition));
    return () => disposers.reverse().forEach((dispose) => dispose());
  }

  requireJournal() {
    if (!this.journal) throw new Error("worker_start or worker_continue must run first");
    return this.journal;
  }

  record(tool, args, result) {
    const journal = this.requireJournal();
    journal.append({ tool, argsHash: sha256Json(args), result });
    if (process.env.XW_DSH_FAILPOINT === "kill-after-tool-journal-before-dsh-result" && tool === "phone_observe") process.exit(86);
    this.state.calls.push({ tool, result });
    return result;
  }

  scheduleCheckpoint(args, exec, result) {
    this.checkpointTask = new Promise((resolve, reject) => {
      const dispose = this.ctx.on("session/event", async (session, event) => {
        if (String(session.id) !== String(exec.agent.session.id)
          || event.type !== "tool/result"
          || event.data?.message?.source?.callId !== exec.callId) return;
        dispose();
        try {
          if (process.env.XW_DSH_FAILPOINT === "kill-after-tool-result-before-checkpoint") process.exit(86);
          await this.ctx.sessions.flush(exec.agent.session);
          const checkpoint = this.requireJournal().checkpoint({
            workerRunRef: this.state.workerRunRef,
            sessionId: String(exec.agent.session.id),
            stateRefs: args.stateRefs,
            priorCallCount: this.state.calls.length,
            toolSpecHash: sha256Json(M6_TOOL_SPEC),
            policySha256,
            profileHash: this.profileHash,
          });
          if (process.env.XW_DSH_FAILPOINT === "kill-after-checkpoint-before-shutdown") process.exit(86);
          resolve(checkpoint);
        } catch (error) {
          reject(error);
        }
      });
    });
    this.checkpointTask.catch(() => {});
    return result;
  }

  async execute(tool, args, exec) {
    assertValid(validateToolCall({ tool, args }), "XW_TOOL_INPUT_REJECTED");
    if (this.journal && tool !== "worker_start" && tool !== "worker_continue") {
      const replayed = this.journal.find(tool, sha256Json(args));
      if (replayed) {
        assertValid(validateToolResult({ tool, result: replayed }), "XW_TOOL_OUTPUT_REJECTED");
        return replayed;
      }
    }
    let result;
    switch (tool) {
      case "worker_start": {
        if (this.journal) throw new Error("worker already started in this process");
        this.state.workerRunRef = args.workerRunRef;
        this.journal = new ReplayJournal(this.root, args.workerRunRef);
        result = baseResult({ workerRunRef: args.workerRunRef, status: "STARTED" });
        break;
      }
      case "worker_continue": {
        if (this.journal) throw new Error("worker already attached in this process");
        this.state.workerRunRef = args.workerRunRef;
        this.journal = new ReplayJournal(this.root, args.workerRunRef);
        this.journal.loadCheckpoint();
        result = baseResult({ workerRunRef: args.workerRunRef, status: "CONTINUED" });
        break;
      }
      case "phone_observe": {
        const observed = this.grounding.freezeFrame({
          screenshotA: "m6-3-synthetic-frame",
          screenshotB: "m6-3-synthetic-frame",
          dump: "synthetic replay page",
          focus: "synthetic replay focus",
          capturedAt: CAPTURED_AT,
          linkage: { sessionId: args.sessionRef, leaseRef: "replay-only", alias: "replay", appId: "com.xingin.xhs" },
          width: 1080,
          height: 2400,
          density: 3,
        });
        assertValid(observed, "GROUNDING_OBSERVE_REJECTED");
        const segmented = this.grounding.segmentBlocks(observed.frame);
        assertValid(segmented, "GROUNDING_SEGMENT_REJECTED");
        this.state.frame = observed.frame;
        this.state.blockSet = segmented.blockSet;
        result = baseResult({ frameRef: observed.frame.frameId, blockRefs: segmented.blockSet.blocks.map((block) => block.blockId) });
        break;
      }
      case "phone_ground": {
        if (args.frameRef !== this.state.frame?.frameId) throw new Error("frameRef does not match current synthetic frame");
        const decided = this.grounding.decide({
          frame: this.state.frame,
          blockSet: this.state.blockSet,
          blockId: args.blockId,
          intent: args.intent,
          grantRef: "grant-replay",
          goalRef: "goal-replay",
          stepRef: "step-replay",
          effectClass: "navigation",
          nowMs: args.intent === "replan" ? NOW_MS + 10_000 : NOW_MS,
        });
        assertValid(decided, "GROUNDING_DECIDE_REJECTED");
        this.state.decision = decided.decision;
        const decisionRef = decided.decision.groundingDecisionId ?? sha256Json(decided.decision);
        result = baseResult({ groundingDecisionRef: decisionRef, verdict: decided.decision.result });
        break;
      }
      case "phone_act": {
        const expected = this.state.decision?.groundingDecisionId ?? sha256Json(this.state.decision);
        if (args.groundingDecisionRef !== expected) throw new Error("groundingDecisionRef does not match issued decision");
        const resolved = this.grounding.resolveInternalPoint(this.state.decision);
        assertValid(resolved, "GROUNDING_POINT_REJECTED");
        this.state.actionReceiptRef = opaque("action", { pointRef: resolved.pointRef, operationKey: args.operationKey });
        result = baseResult({ actionReceiptRef: this.state.actionReceiptRef, outcome: "SUCCEEDED" });
        break;
      }
      case "phone_verify": {
        if (args.actionReceiptRef !== this.state.actionReceiptRef) throw new Error("actionReceiptRef does not match synthetic action");
        this.state.verificationRef = opaque("verify", args);
        result = baseResult({ verificationRef: this.state.verificationRef, outcome: "SUCCEEDED" });
        break;
      }
      case "checkpoint_save": {
        const journalHash = this.requireJournal().prefixHash();
        result = baseResult({ checkpointRef: opaque("checkpoint", { workerRunRef: this.state.workerRunRef, stateRefs: args.stateRefs, journalHash }), journalHash });
        break;
      }
      case "trace_query":
        result = baseResult({ traceRef: opaque("trace", { traceId: args.traceId, calls: this.state.calls }), eventCount: this.state.calls.length });
        break;
      case "wait_human":
        result = baseResult({ waitRef: opaque("wait", args), status: "WAITING" });
        break;
      case "worker_complete":
        if (this.checkpointTask) await this.checkpointTask;
        if (args.workerRunRef !== this.state.workerRunRef) throw new Error("workerRunRef does not match active replay worker");
        result = baseResult({ workerRunRef: args.workerRunRef, status: "COMPLETED" });
        break;
      default:
        throw new Error(`unhandled replay tool: ${tool}`);
    }
    assertValid(validateToolResult({ tool, result }), "XW_TOOL_OUTPUT_REJECTED");
    const recorded = this.record(tool, args, result);
    return tool === "checkpoint_save" ? this.scheduleCheckpoint(args, exec, recorded) : recorded;
  }
}

export { M6_TOOL_NAMES, M6_TOOL_SPEC, policySha256 };
