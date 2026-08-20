import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DSH_LIVE_GATE,
  HARNESS_ALLOWED_TOOLS,
  HARNESS_FORBIDDEN_TOOLS,
  SkillRunMachine,
  assertHarnessToolAllowed,
  loadSkillFixtureSpec,
} from "../../kernel/lib/skill-runtime.mjs";
import { loadRuntimeProfile } from "../../kernel/lib/runtime-profile.mjs";
import { TraceStore } from "./trace-store.mjs";

const here = dirname(fileURLToPath(import.meta.url));

export const HARNESS_METHODS = Object.freeze([
  "createSession",
  "restoreSession",
  "submitGoal",
  "continueSkill",
  "checkpoint",
  "queryTrace",
  "interrupt",
  "close",
]);

export const DSH_EVENT_TYPES = Object.freeze([
  "turn/start",
  "step/start",
  "assistant/message",
  "tool/call",
  "tool/result",
  "step/end",
  "turn/end",
]);

export const XW_EVENT_TYPES = Object.freeze([
  "xw/skill-started",
  "xw/skill-checkpoint",
  "xw/action-requested",
  "xw/action-receipt",
  "xw/skill-exited",
]);

export function loadDshLock() {
  return JSON.parse(readFileSync(join(here, "../locks/dsh.lock.v1.json"), "utf8"));
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export class EventBridge {
  constructor() {
    this.seq = 0;
    this.events = [];
  }

  emit(kind, type, data = {}, refs = {}) {
    this.seq += 1;
    const row = {
      schemaId: "xw.harness.event.v1",
      schemaVersion: 1,
      kind,
      type,
      seq: this.seq,
      at: Date.now(),
      turnId: data.turnId ?? null,
      stepId: data.stepId ?? null,
      toolCallId: data.toolCallId ?? null,
      data,
      refs,
    };
    this.events.push(row);
    return row;
  }

  mapToolCall({ toolCallId, actionId, harnessSessionId, skillRunId }) {
    return this.emit("dsh", "tool/call", { toolCallId }, {
      actionId,
      harnessSessionId,
      skillRunId,
      receiptRef: null,
    });
  }

  mapToolResult({ toolCallId, actionId, receiptRef, harnessSessionId, skillRunId }) {
    return this.emit("dsh", "tool/result", { toolCallId }, {
      actionId,
      receiptRef,
      harnessSessionId,
      skillRunId,
    });
  }

  snapshot() {
    return JSON.parse(JSON.stringify(this.events));
  }
}

export class HarnessRuntime {
  constructor({
    harness,
    harnessVersion,
    harnessCommit,
    now = () => Date.now(),
    traceStore = null,
  }) {
    this.harness = harness;
    this.harnessVersion = harnessVersion;
    this.harnessCommit = harnessCommit;
    this.now = now;
    this.traceStore = traceStore || new TraceStore();
    this.sessions = new Map();
    this.closed = new Set();
    this.dshLiveGate = DSH_LIVE_GATE;
    this.profile = loadRuntimeProfile("legacy_compat");
  }

  assertLiveClosed() {
    if (this.dshLiveGate !== "CLOSED") throw codedError("DSH_LIVE_GATE", "DSH live must stay CLOSED in M4-B");
    if (this.profile.dshEnabled) throw codedError("DSH_LIVE_GATE", "runtimeProfile.dshEnabled must be false");
    if (this.profile.openActionLiveEnabled) {
      throw codedError("OPEN_ACTION_LIVE_GATE", "openActionLiveEnabled must be false");
    }
  }

  createSession() {
    this.assertLiveClosed();
    const harnessSessionId = `harness_${randomUUID()}`;
    const machine = new SkillRunMachine({ now: this.now });
    const bridge = new EventBridge();
    const session = {
      ref: {
        schemaId: "xw.harness.session-ref.v1",
        schemaVersion: 1,
        harnessSessionId,
        harness: this.harness,
        harnessVersion: this.harnessVersion,
        harnessCommit: this.harnessCommit,
        skillRunId: null,
        lastDurableTurn: 0,
        lastDurableStep: 0,
        xwCheckpointSeq: 0,
        createdAt: this.now(),
      },
      machine,
      bridge,
      dshLog: [],
      dshFlushedSeq: 0,
      openToolCall: null,
      restored: false,
    };
    this.sessions.set(harnessSessionId, session);
    return { ...session.ref };
  }

  #require(harnessSessionId) {
    if (this.closed.has(harnessSessionId)) throw codedError("HARNESS_SESSION_CLOSED", "session already closed");
    const session = this.sessions.get(harnessSessionId);
    if (!session) throw codedError("HARNESS_SESSION_UNKNOWN", "unknown harness session");
    return session;
  }

  submitGoal({ harnessSessionId, spec = loadSkillFixtureSpec(), ids = { traceId: `tr_${harnessSessionId}` } }) {
    const session = this.#require(harnessSessionId);
    const run = session.machine.start({ spec, ids: { ...ids, harnessSessionId } });
    session.ref.skillRunId = run.skillRunId;
    session.bridge.emit("xw", "xw/skill-started", { skillRunId: run.skillRunId }, {
      skillRunId: run.skillRunId,
      harnessSessionId,
    });
    this.#dsh(session, "turn/start", { turn: 1 });
    this.#dsh(session, "step/start", { step: 1 });
    session.ref.lastDurableTurn = 1;
    session.ref.lastDurableStep = 1;
    return run;
  }

  invokeTool(harnessSessionId, name, payload = {}) {
    assertHarnessToolAllowed(name);
    const session = this.#require(harnessSessionId);
    if (name === "xw_phone_act") {
      const toolCallId = payload.toolCallId || `tool_${randomUUID()}`;
      const result = session.machine.noteActionRequested(payload.actionId);
      session.openToolCall = { toolCallId, actionId: result };
      session.bridge.mapToolCall({
        toolCallId,
        actionId: result,
        harnessSessionId,
        skillRunId: session.ref.skillRunId,
      });
      this.#dsh(session, "tool/call", { toolCallId, tool: name, actionId: result });
      return { accepted: false, executed: false, reason: "open-action-live-closed", actionId: result, toolCallId };
    }
    if (name === "xw_phone_verify") {
      if (!session.openToolCall) throw codedError("HARNESS_TOOL_RESULT_ORPHAN", "no open tool/call");
      const receiptRef = session.machine.noteActionVerified(payload.receiptRef);
      session.bridge.mapToolResult({
        toolCallId: session.openToolCall.toolCallId,
        actionId: session.openToolCall.actionId,
        receiptRef,
        harnessSessionId,
        skillRunId: session.ref.skillRunId,
      });
      this.#dsh(session, "tool/result", {
        toolCallId: session.openToolCall.toolCallId,
        receiptRef,
      });
      session.openToolCall = null;
      return { ok: false, reason: "no-live-effect", receiptRef };
    }
    if (name === "xw_skill_checkpoint") return this.checkpoint({ harnessSessionId });
    if (name === "xw_skill_complete") {
      return session.machine.applyExit({
        schemaId: "xw.skill.exit.v1",
        schemaVersion: 1,
        exit: "COMPLETED",
        reason: payload.reason || "harness-complete",
        factsProduced: [],
        openQuestions: [],
        candidateIntents: [],
      });
    }
    if (name === "xw_skill_continue") return session.machine.applyExit(payload.exit);
    if (name === "xw_trace_query") return this.queryTrace({ harnessSessionId });
    if (name === "xw_phone_observe") {
      return {
        executionMode: "fixture",
        partial: true,
        partialReason: "fixture_provider_no_device_artifact",
      };
    }
    if (name === "xw_skill_start") {
      return this.submitGoal({ harnessSessionId, spec: payload.spec, ids: payload.ids });
    }
    throw codedError("HARNESS_TOOL_UNKNOWN", name);
  }

  checkpoint({ harnessSessionId, flushDsh = true } = {}) {
    const session = this.#require(harnessSessionId);
    const xw = session.machine.checkpoint();
    session.ref.xwCheckpointSeq = xw.seq;
    if (flushDsh) session.dshFlushedSeq = session.dshLog.length;
    session.bridge.emit("xw", "xw/skill-checkpoint", { seq: xw.seq, dshSeq: session.dshFlushedSeq }, {
      skillRunId: session.ref.skillRunId,
      harnessSessionId,
    });
    return {
      schemaId: "xw.harness.checkpoint.v1",
      schemaVersion: 1,
      harnessSessionId,
      createdAt: this.now(),
      xw: session.machine.serialize(),
      harness: {
        name: this.harness,
        version: this.harnessVersion,
        commit: this.harnessCommit,
        seq: session.dshLog.length,
        turn: session.ref.lastDurableTurn,
        step: session.ref.lastDurableStep,
        flushed: session.dshFlushedSeq === session.dshLog.length,
      },
    };
  }

  serialize(harnessSessionId) {
    const session = this.#require(harnessSessionId);
    return JSON.parse(JSON.stringify({
      ref: session.ref,
      xw: session.machine.run ? session.machine.serialize() : null,
      dshLog: session.dshLog,
      dshFlushedSeq: session.dshFlushedSeq,
      openToolCall: session.openToolCall,
      bridge: session.bridge.snapshot(),
    }));
  }

  restoreSession({ snapshot, reconciliation, harnessCommit = this.harnessCommit }) {
    this.assertLiveClosed();
    if (!snapshot) throw codedError("HARNESS_SNAPSHOT_MISSING", "restore requires a snapshot");
    if (snapshot.ref.harnessCommit !== harnessCommit) {
      throw codedError("DSH_VERSION_MISMATCH", "cannot silently restore a session across DSH versions");
    }
    if (this.sessions.has(snapshot.ref.harnessSessionId) && !this.closed.has(snapshot.ref.harnessSessionId)) {
      throw codedError("HARNESS_SESSION_ALREADY_ACTIVE", "duplicate restore of a live session");
    }
    if (snapshot.openToolCall && reconciliation?.status !== "ALREADY_VERIFIED") {
      if (reconciliation?.status === "AMBIGUOUS_EFFECT") {
        throw codedError("SKILL_RESUME_AMBIGUOUS", "open tool/call with AMBIGUOUS_EFFECT");
      }
      throw codedError("SKILL_RECONCILIATION_REQUIRED", "open tool/call has no tool/result; inspect Action Ledger");
    }
    if (snapshot.dshFlushedSeq !== snapshot.dshLog.length && reconciliation?.status !== "ALREADY_VERIFIED") {
      throw codedError("DSH_FLUSH_INCOMPLETE", "DSH log was not flushed before crash");
    }
    if (!snapshot.xw?.checkpoint) throw codedError("SKILL_CHECKPOINT_MISSING", "XW checkpoint missing; refuse silent resume");
    const machine = SkillRunMachine.restore({
      ...snapshot.xw,
      reconciliation: reconciliation || { status: "NO_UNRESOLVED_EFFECTS" },
    });
    const bridge = new EventBridge();
    bridge.events = snapshot.bridge || [];
    bridge.seq = bridge.events.length;
    const session = {
      ref: { ...snapshot.ref },
      machine,
      bridge,
      dshLog: snapshot.dshLog || [],
      dshFlushedSeq: snapshot.dshFlushedSeq,
      openToolCall: snapshot.openToolCall,
      restored: true,
    };
    this.sessions.set(session.ref.harnessSessionId, session);
    return { ref: { ...session.ref }, run: machine.run, phoneActsEmitted: 0 };
  }

  continueSkill({ harnessSessionId, exit }) {
    const session = this.#require(harnessSessionId);
    return session.machine.applyExit(exit);
  }

  queryTrace({ harnessSessionId, traceId } = {}) {
    if (traceId !== undefined) {
      if (harnessSessionId !== undefined) throw codedError("TRACE_QUERY_AMBIGUOUS", "queryTrace accepts either traceId or harnessSessionId, not both");
      return this.traceStore.query(traceId);
    }
    if (harnessSessionId === undefined) throw codedError("TRACE_QUERY_REQUIRED", "queryTrace requires traceId or harnessSessionId");
    const session = this.#require(harnessSessionId);
    return {
      ref: { ...session.ref },
      xwEvents: [...session.machine.events],
      dshLog: [...session.dshLog],
      bridge: session.bridge.snapshot(),
    };
  }

  interrupt({ harnessSessionId, reason = "subagent-exit" }) {
    const session = this.#require(harnessSessionId);
    if (session.openToolCall) {
      return session.machine.markAmbiguous(reason || "subagent-exit-with-open-tool");
    }
    return session.machine.applyExit({
      schemaId: "xw.skill.exit.v1",
      schemaVersion: 1,
      exit: "ABORTED",
      reason,
      factsProduced: [],
      openQuestions: [],
      candidateIntents: [],
    });
  }

  close({ harnessSessionId }) {
    this.#require(harnessSessionId);
    this.sessions.delete(harnessSessionId);
    this.closed.add(harnessSessionId);
    return { closed: true, harnessSessionId };
  }

  #dsh(session, type, data) {
    session.dshLog.push({ type, at: this.now(), ...data });
  }
}

export function assertAdapterConformance(adapter) {
  for (const method of HARNESS_METHODS) {
    if (typeof adapter[method] !== "function") {
      throw codedError("HARNESS_CONFORMANCE", `adapter missing ${method}`);
    }
  }
  for (const name of HARNESS_FORBIDDEN_TOOLS) {
    try {
      assertHarnessToolAllowed(name);
      throw codedError("HARNESS_CONFORMANCE", `${name} must stay forbidden`);
    } catch (error) {
      if (error.code !== "HARNESS_TOOL_FORBIDDEN") throw error;
    }
  }
  return { ok: true, methods: [...HARNESS_METHODS] };
}
