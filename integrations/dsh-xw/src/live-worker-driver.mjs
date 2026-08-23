import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { PassThrough } from "node:stream";

import { canonicalJson } from "./canonical-json.mjs";
import { StdioSupervisor } from "./stdio-supervisor.mjs";

const HASH = /^[0-9a-f]{64}$/u;
const REF = /^[a-z0-9][a-z0-9:_-]{7,127}$/u;
const PURPOSES = new Set([
  "M6_4_SHADOW",
  "M6_4_HOT_CLOSE",
  "M6_4_ACTION_SMOKE",
  "M6_4_RELIABILITY",
  "M6_4_SMOOTH",
]);
const ZERO_ACTION_PURPOSES = new Set(["M6_4_SHADOW", "M6_4_HOT_CLOSE"]);
const MAX_LINE_BYTES = 1024 * 1024;
const ACTION_FAMILY = /^[a-z0-9][a-z0-9:-]{2,95}$/u;

function driverError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function exactRef(value, label) {
  if (typeof value !== "string" || !(REF.test(value) || HASH.test(value))) {
    throw driverError("M6_LIVE_WORKER_DIRECTIVE_INVALID", `${label} is not one opaque reference`);
  }
  return value;
}

function buildSteps(scenario, purpose) {
  const plan = scenario?.actionPlan;
  if (!plan || plan.schemaId !== "xw.m6-scenario-action-plan.v1"
    || !Number.isSafeInteger(plan.maxActionCount) || plan.maxActionCount < 0
    || !Array.isArray(plan.slots) || plan.slots.length !== plan.maxActionCount
    || !HASH.test(plan.actionPlanHash || "")) {
    throw driverError("M6_LIVE_WORKER_DIRECTIVE_INVALID", "scenario action plan is not closed and content addressed");
  }
  if (ZERO_ACTION_PURPOSES.has(purpose) !== (plan.maxActionCount === 0)) {
    throw driverError("M6_LIVE_WORKER_DIRECTIVE_INVALID", "scenario action cardinality does not match its cohort purpose");
  }
  return Object.freeze(plan.slots.map((slot, index) => {
    if (!slot || slot.sequenceIndex !== index || slot.actionSlotOrdinal !== 0
      || !["tap", "scroll", "back", "open_app", "type_search_text"].includes(slot.primitive)
      || !["block", "screen", "none"].includes(slot.targetKind)
      || !ACTION_FAMILY.test(slot.actionFamily || "")
      || !HASH.test(slot.intentRef || "") || !HASH.test(slot.oracleHash || "")
      || !HASH.test(slot.slotAuthorityHash || "")) {
      throw driverError("M6_LIVE_WORKER_DIRECTIVE_INVALID", `scenario slot ${index} is not exact`);
    }
    return Object.freeze({
      sequenceIndex: index,
      stepRef: exactRef(slot.logicalStepId, `slot ${index} logicalStepId`),
      intentRef: slot.intentRef,
      expectationRef: slot.oracleHash,
      primitive: slot.primitive,
      targetKind: slot.targetKind,
      actionFamily: slot.actionFamily,
      slotAuthorityHash: slot.slotAuthorityHash,
    });
  }));
}

export function buildM64LiveWorkerDirective({
  binding,
  workerRunRef,
  manifest,
  scenario,
  scenarioKey,
} = {}) {
  if (!binding || binding.alias !== "01" || !PURPOSES.has(binding.purpose)
    || !HASH.test(binding.bindingHash || "") || !HASH.test(binding.scenarioManifestHash || "")
    || binding.scenarioManifestHash !== manifest?.manifestHash
    || scenarioKey !== scenario?.scenarioKey || !REF.test(scenarioKey || "")
    || scenario?.alias !== "01" || !HASH.test(scenario?.oracleHash || "")) {
    throw driverError("M6_LIVE_WORKER_DIRECTIVE_INVALID", "worker directive does not bind one exact alias-01 scenario");
  }
  const steps = buildSteps(scenario, binding.purpose);
  const body = Object.freeze({
    schemaId: "xw.m6-4-live-worker-directive.v1",
    mode: binding.purpose === "M6_4_SHADOW"
      ? "SHADOW_OBSERVE"
      : binding.purpose === "M6_4_HOT_CLOSE"
        ? "HOT_CLOSE_WAIT"
        : "BOUNDED_ACTION",
    runRef: exactRef(binding.runId, "runRef"),
    workerRunRef: exactRef(workerRunRef, "workerRunRef"),
    scenarioRef: scenarioKey,
    probeStepRef: scenarioKey,
    purpose: binding.purpose,
    manifestHash: manifest.manifestHash,
    bindingHash: binding.bindingHash,
    actionPlanHash: scenario.actionPlan.actionPlanHash,
    traceRef: scenario.oracleHash,
    maxActionCount: scenario.actionPlan.maxActionCount,
    steps,
  });
  return Object.freeze({
    ...body,
    directiveHash: sha256(`xw.m6-4-live-worker-directive.v1:${canonicalJson(body)}`),
  });
}

export function renderM64LiveWorkerPrompt(directive) {
  if (!directive || directive.schemaId !== "xw.m6-4-live-worker-directive.v1"
    || !HASH.test(directive.directiveHash || "")) {
    throw driverError("M6_LIVE_WORKER_DIRECTIVE_INVALID", "worker prompt requires one verified directive");
  }
  const instructions = directive.mode === "SHADOW_OBSERVE"
    ? [
      "Call worker_start once with workerRunRef.",
      "Call phone_observe once with runRef and probeStepRef.",
      "Call trace_query once with traceRef.",
      "Call worker_complete once with workerRunRef and outcome SUCCEEDED, then stop.",
    ]
    : directive.mode === "HOT_CLOSE_WAIT"
      ? [
        "Call worker_start once with workerRunRef.",
        "Call phone_observe once with runRef and probeStepRef.",
        "Call wait_human once with reasonRef=traceRef and evidenceRefs containing only the returned frameRef, then stop. Never call phone_act or worker_complete.",
      ]
      : [
        "Call worker_start once with workerRunRef.",
        "For each steps entry, in ascending sequenceIndex: call phone_observe(runRef, stepRef); call phone_ground with the returned frameRef and the step intentRef (do not invent candidateBlockId).",
        "Only when phone_ground returns ALLOW_ONCE, call phone_act with exactly its decisionRef and operationKey. Then call phone_verify with the returned actionReceiptRef and the step expectationRef.",
        "After each verified action call checkpoint_save with stateRefs containing exactly the actionReceiptRef and verificationRef returned by the tools.",
        "If grounding is REPLAN or HARD_STOP, or an action is not VERIFIED, call wait_human with only returned opaque evidence refs, then call worker_complete with FAILED or AMBIGUOUS and stop.",
        "After every step verifies, call trace_query once with traceRef, then call worker_complete once with workerRunRef and outcome SUCCEEDED, then stop.",
      ];
  return [
    "You are the bounded M6-4 live execution worker. The JSON directive below is your entire authority.",
    "Use only the registered ten tools. Pass only exact opaque references returned by the directive or prior tool results.",
    "Never invent a reference, retry a physical action, add a step, expose raw device data, or perform any action outside the listed sequence.",
    ...instructions,
    canonicalJson(directive),
  ].join("\n");
}

class ParentProtocolClient {
  constructor({ input, output, onFatal, requestTimeoutMs = 15_000 } = {}) {
    this.input = input;
    this.output = output;
    this.onFatal = onFatal;
    this.requestTimeoutMs = requestTimeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.statuses = new Map();
    this.idleWaiters = new Map();
    this.buffer = Buffer.alloc(0);
    this.failed = null;
    this.closed = false;
    output.on("data", (chunk) => this.#onData(chunk));
    output.on("error", (error) => this.fail(driverError("M6_LIVE_WORKER_PROTOCOL_IO", "worker protocol output failed", error)));
    output.on("end", () => {
      if (!this.closed && this.pending.size > 0) this.fail(driverError("M6_LIVE_WORKER_PROTOCOL_EARLY_END", "worker protocol ended with pending requests"));
    });
  }

  request(method, params, timeoutMs = this.requestTimeoutMs) {
    if (this.failed) return Promise.reject(this.failed);
    if (this.closed) return Promise.reject(driverError("M6_LIVE_WORKER_PROTOCOL_CLOSED", "worker protocol is closed"));
    const id = `m64:${this.nextId++}`;
    const encoded = Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    if (encoded.length > MAX_LINE_BYTES) return Promise.reject(driverError("M6_LIVE_WORKER_PROTOCOL_LINE_LIMIT", "worker protocol request is too large"));
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = driverError("M6_LIVE_WORKER_PROTOCOL_TIMEOUT", `${method} did not settle in time`);
        rejectRequest(error);
        this.fail(error);
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { method, resolve: resolveRequest, reject: rejectRequest, timer });
      try { this.input.write(encoded); } catch (cause) {
        clearTimeout(timer);
        this.pending.delete(id);
        const error = driverError("M6_LIVE_WORKER_PROTOCOL_IO", "worker protocol request could not be written", cause);
        rejectRequest(error);
        this.fail(error);
      }
    });
  }

  waitForIdle(sessionId, timeoutMs = 90_000) {
    if (this.statuses.get(sessionId) === "idle") return Promise.resolve(true);
    if (this.failed) return Promise.reject(this.failed);
    return new Promise((resolveIdle, rejectIdle) => {
      const timer = setTimeout(() => {
        this.idleWaiters.delete(sessionId);
        rejectIdle(driverError("M6_LIVE_WORKER_IDLE_TIMEOUT", "worker did not become idle"));
      }, timeoutMs);
      timer.unref?.();
      this.idleWaiters.set(sessionId, { resolve: resolveIdle, reject: rejectIdle, timer });
    });
  }

  fail(error) {
    if (this.failed) return;
    this.failed = error instanceof Error ? error : driverError("M6_LIVE_WORKER_PROTOCOL_FAILED", "worker protocol failed");
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(this.failed);
    }
    this.pending.clear();
    for (const waiter of this.idleWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(this.failed);
    }
    this.idleWaiters.clear();
    try { this.onFatal?.(this.failed); } catch {}
  }

  markClosed() {
    this.closed = true;
    this.input.end();
    this.output.destroy();
  }

  #onData(chunk) {
    if (this.failed || this.closed) return;
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    if (this.buffer.length > MAX_LINE_BYTES && !this.buffer.includes(0x0a)) {
      this.fail(driverError("M6_LIVE_WORKER_PROTOCOL_LINE_LIMIT", "worker protocol emitted an oversized incomplete line"));
      return;
    }
    while (!this.failed) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) break;
      const raw = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      if (raw.length > MAX_LINE_BYTES) {
        this.fail(driverError("M6_LIVE_WORKER_PROTOCOL_LINE_LIMIT", "worker protocol emitted an oversized line"));
        return;
      }
      let message;
      try { message = JSON.parse(raw.toString("utf8")); } catch {
        this.fail(driverError("M6_LIVE_WORKER_PROTOCOL_INVALID", "worker protocol emitted malformed JSON"));
        return;
      }
      if (!message || message.jsonrpc !== "2.0" || typeof message !== "object" || Array.isArray(message)) {
        this.fail(driverError("M6_LIVE_WORKER_PROTOCOL_INVALID", "worker protocol emitted an invalid envelope"));
        return;
      }
      if (typeof message.method === "string") {
        if (Object.keys(message).sort().join(",") !== "jsonrpc,method,params"
          || !["session.event", "session.status"].includes(message.method)) {
          this.fail(driverError("M6_LIVE_WORKER_PROTOCOL_INVALID", "worker protocol emitted a forbidden notification"));
          return;
        }
        if (message.method === "session.status" && typeof message.params?.sessionId === "string" && typeof message.params?.status === "string") {
          const { sessionId, status } = message.params;
          this.statuses.set(sessionId, status);
          if (status === "idle") {
            const waiter = this.idleWaiters.get(sessionId);
            if (waiter) {
              clearTimeout(waiter.timer);
              this.idleWaiters.delete(sessionId);
              waiter.resolve(true);
            }
          }
        }
        continue;
      }
      const pending = this.pending.get(message.id);
      const responseKeys = Object.keys(message).sort().join(",");
      if (!pending || (Object.hasOwn(message, "result") === Object.hasOwn(message, "error"))
        || !["id,jsonrpc,result", "error,id,jsonrpc"].includes(responseKeys)) {
        this.fail(driverError("M6_LIVE_WORKER_PROTOCOL_INVALID", "worker protocol response is unknown or ambiguous"));
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(driverError("M6_LIVE_WORKER_PROTOCOL_REJECTED", `${pending.method} was rejected by the sealed child`));
      else pending.resolve(message.result);
    }
  }
}

export function createM6LiveWorkerDriver({
  workingDirectory,
  requestTimeoutMs = 15_000,
  supervisorLimits = {},
  supervisorTimeouts = {},
} = {}) {
  if (typeof workingDirectory !== "string" || !isAbsolute(workingDirectory)) {
    throw driverError("M6_LIVE_WORKER_CWD_INVALID", "live worker requires an absolute sealed working directory");
  }
  const cwd = resolve(workingDirectory);
  const active = new Map();

  return async function driveM64Worker(input = {}) {
    const { live, binding, workerRunRef, manifest, scenario, scenarioKey, qualification } = input;
    if (!live?.processRef || live.processRef.schemaId !== "xw.dsh.process-ref.v1"
      || !live.processRef.child?.stdin || !live.processRef.child?.stdout || !live.processRef.child?.stderr
      || typeof live?.broker?.abort !== "function"
      || qualification?.status !== "QUALIFIED" || qualification?.gateFEligible !== true
      || qualification?.contentHash !== live.modelProfileHash
      || typeof qualification?.provider !== "string" || typeof qualification?.model !== "string"
      || !Number.isSafeInteger(qualification?.maxTokens) || qualification.maxTokens < 1) {
      throw driverError("M6_LIVE_WORKER_LAUNCH_INVALID", "live worker child or qualified model binding is unavailable");
    }
    if (active.has(binding.runId)) throw driverError("M6_LIVE_WORKER_DUPLICATE", "one worker protocol already owns this run");
    const directive = buildM64LiveWorkerDirective({ binding, workerRunRef, manifest, scenario, scenarioKey });
    const prompt = renderM64LiveWorkerPrompt(directive);
    const upstreamInput = new PassThrough();
    const upstreamOutput = new PassThrough();
    let client;
    const fatal = (error) => {
      client?.fail(error);
      try { live.broker.abort(error); } catch {}
    };
    const supervisor = new StdioSupervisor({
      upstreamInput,
      upstreamOutput,
      childRef: live.processRef,
      limits: supervisorLimits,
      timeouts: supervisorTimeouts,
      onFatal: fatal,
    }).start();
    client = new ParentProtocolClient({ input: upstreamInput, output: upstreamOutput, onFatal: (error) => {
      try { live.broker.abort(error); } catch {}
    }, requestTimeoutMs });
    active.set(binding.runId, { client, supervisor });
    try {
      await client.request("initialize", {
        cwd,
        provider: qualification.provider,
        model: qualification.model,
        maxTokens: qualification.maxTokens,
      });
      const prompted = await client.request("session/prompt", {
        sessionId: binding.sessionId,
        contentBlocks: [{ type: "text", text: prompt }],
      });
      if (typeof prompted?.messageId !== "string" || prompted.messageId.length < 1) {
        throw driverError("M6_LIVE_WORKER_PROMPT_REJECTED", "sealed child did not acknowledge the worker directive");
      }
      let closePromise = null;
      return Object.freeze({
        schemaId: "xw.m6-live-worker-protocol.v1",
        runId: binding.runId,
        sessionId: binding.sessionId,
        directiveHash: directive.directiveHash,
        messageRef: sha256(`xw.m6-live-worker-message.v1:${prompted.messageId}`),
        whenIdle: (timeoutMs) => client.waitForIdle(binding.sessionId, timeoutMs),
        close() {
          closePromise ??= (async () => {
            let shutdownAcknowledged = false;
            try {
              await client.request("shutdown", {}, 5_000);
              shutdownAcknowledged = true;
            } finally {
              client.markClosed();
              active.delete(binding.runId);
            }
            return Object.freeze({
              schemaId: "xw.m6-live-worker-protocol-close.v1",
              runId: binding.runId,
              directiveHash: directive.directiveHash,
              shutdownAcknowledged,
              verifiedClosed: shutdownAcknowledged,
            });
          })();
          return closePromise;
        },
      });
    } catch (error) {
      client.markClosed();
      active.delete(binding.runId);
      fatal(error);
      throw error;
    }
  };
}
