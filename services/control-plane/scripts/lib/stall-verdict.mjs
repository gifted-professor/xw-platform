/**
 * stall-verdict.mjs — read bounded progress.jsonl and classify timeout/failure.
 * Fail-closed on path escape, oversize, bad JSONL, run/job mismatch, or missing progress.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

export const VERDICT_SCHEMA = "xhs.stall-verdict.v1";
export const DEFAULT_MAX_PROGRESS_BYTES = 2 * 1024 * 1024;

function safeResolveUnder(root, relativeName) {
  const rootResolved = resolve(root);
  const target = resolve(rootResolved, relativeName);
  if (target !== rootResolved && !target.startsWith(rootResolved + "\\") && !target.startsWith(rootResolved + "/")) {
    return null;
  }
  if (basename(target) !== "progress.jsonl") return null;
  return target;
}

export function readProgressJsonl(evidenceDir, {
  maxBytes = DEFAULT_MAX_PROGRESS_BYTES,
  expectedRunId = null,
  expectedJobId = null,
} = {}) {
  const path = safeResolveUnder(evidenceDir, "progress.jsonl");
  if (!path) {
    return { ok: false, code: "PROGRESS_PATH_INVALID", events: [], bytes: 0, path: null };
  }
  if (!existsSync(path)) {
    return { ok: false, code: "PROGRESS_MISSING", events: [], bytes: 0, path };
  }
  let st;
  try {
    st = statSync(path);
  } catch {
    return { ok: false, code: "PROGRESS_UNREADABLE", events: [], bytes: 0, path };
  }
  if (!Number.isFinite(st.size) || st.size <= 0) {
    return { ok: false, code: "PROGRESS_EMPTY", events: [], bytes: st.size || 0, path };
  }
  if (st.size > maxBytes) {
    return { ok: false, code: "PROGRESS_TOO_LARGE", events: [], bytes: st.size, path };
  }
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { ok: false, code: "PROGRESS_UNREADABLE", events: [], bytes: st.size, path };
  }
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const events = [];
  let lastSeq = 0;
  for (let i = 0; i < lines.length; i += 1) {
    let row;
    try {
      row = JSON.parse(lines[i]);
    } catch {
      return { ok: false, code: "PROGRESS_JSONL_INVALID", events, bytes: st.size, path, line: i + 1 };
    }
    if (!row || typeof row !== "object") {
      return { ok: false, code: "PROGRESS_JSONL_INVALID", events, bytes: st.size, path, line: i + 1 };
    }
    const seq = Number(row.seq);
    if (!Number.isInteger(seq) || seq <= lastSeq) {
      return { ok: false, code: "PROGRESS_SEQ_INVALID", events, bytes: st.size, path, line: i + 1, seq };
    }
    lastSeq = seq;
    if (expectedRunId && row.runId && row.runId !== expectedRunId) {
      return { ok: false, code: "PROGRESS_RUN_MISMATCH", events, bytes: st.size, path };
    }
    if (expectedJobId && row.jobId && row.jobId !== expectedJobId) {
      return { ok: false, code: "PROGRESS_JOB_MISMATCH", events, bytes: st.size, path };
    }
    events.push(row);
  }
  if (!events.length) {
    return { ok: false, code: "PROGRESS_EMPTY", events: [], bytes: st.size, path };
  }
  return { ok: true, code: null, events, bytes: st.size, path };
}

export function classifyStallVerdict({
  progress,
  errorCode = null,
  phase = "post-failure",
} = {}) {
  const events = progress?.events || [];
  const hasStart = events.some((e) => e.phase === "start" || e.phase === "step_start");
  const hasHeartbeat = events.some((e) => e.phase === "heartbeat");
  const uiStall = events.some((e) => e.signalType === "ui_stall" || e.stallEvent?.signalType === "ui_stall");
  const silence = events.some((e) => e.signalType === "progress_silence" || e.stallEvent?.signalType === "progress_silence");
  const cleared = events.some((e) => e.stallEvent?.kind === "stall_cleared");

  let signalType = "unknown";
  let llmEscalationRecommended = false;

  if (!progress?.ok) {
    if (errorCode === "ADAPTER_TIMEOUT" || errorCode === "ADAPTER_FAILED") {
      signalType = "contract_violation";
      llmEscalationRecommended = true;
    } else {
      signalType = "contract_violation";
    }
  } else if (uiStall) {
    signalType = "ui_stall";
    llmEscalationRecommended = true;
  } else if (silence) {
    signalType = "progress_silence";
    llmEscalationRecommended = true;
  } else if (cleared || events.some((e) => e.freshness === "fresh_ui")) {
    signalType = "slow_progress";
    llmEscalationRecommended = false;
  } else if (errorCode === "ADAPTER_TIMEOUT" && (!hasStart || !hasHeartbeat)) {
    signalType = "contract_violation";
    llmEscalationRecommended = true;
  } else if (errorCode === "ADAPTER_TIMEOUT") {
    signalType = "progress_silence";
    llmEscalationRecommended = true;
  }

  const body = {
    schemaId: VERDICT_SCHEMA,
    schemaVersion: 1,
    phase,
    signalType,
    errorCode: errorCode || null,
    progressOk: progress?.ok === true,
    progressCode: progress?.code || null,
    progressBytes: progress?.bytes ?? null,
    eventCount: events.length,
    seqFirst: events[0]?.seq ?? null,
    seqLast: events.length ? events[events.length - 1].seq : null,
    hasStepStart: hasStart,
    hasHeartbeat,
    llmEscalationRecommended,
    eventRange: events.length
      ? { fromSeq: events[0].seq, toSeq: events[events.length - 1].seq, fromT: events[0].t, toT: events[events.length - 1].t }
      : null,
  };
  const canonical = `${JSON.stringify(body)}\n`;
  return {
    ...body,
    hash: createHash("sha256").update(canonical).digest("hex"),
  };
}

export function buildStallVerdictFromEvidenceDir(evidenceDir, {
  runId = null,
  jobId = null,
  errorCode = null,
  phase = "post-failure",
  maxBytes = DEFAULT_MAX_PROGRESS_BYTES,
} = {}) {
  const progress = readProgressJsonl(evidenceDir, {
    maxBytes,
    expectedRunId: runId,
    expectedJobId: jobId,
  });
  return classifyStallVerdict({ progress, errorCode, phase });
}

export function progressJsonlPath(evidenceDir) {
  return join(evidenceDir, "progress.jsonl");
}
