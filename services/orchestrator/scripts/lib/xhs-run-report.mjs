import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

export const RUN_EVENT_SCHEMA_ID = "xhs.run-event.v1";
export const RUN_SUMMARY_SCHEMA_ID = "xhs.run-summary.v1";
export const RUN_METRICS_SCHEMA_ID = "xhs.run-metrics.v1";
export const MATURITY = "engineering_canary_not_production";

export const RUN_EVENT_TYPES = new Set([
  "run_started", "run_step", "validation_recorded", "closeout_recorded",
  "attempt_started", "session_acquired", "preflight_completed", "concurrency_started",
  "heartbeat", "worker_started", "sequence_started", "action_started",
  "command_started", "retry_started", "retry_finished", "command_finished",
  "action_finished", "sequence_finished", "stop_requested", "evidence_failure",
  "cleanup_started", "cleanup_finished", "worker_finished", "session_released",
  "attempt_finished",
]);

const EVENT_SOURCES = new Set(["parent", "worker", "backfill", "task", "validation", "closeout"]);
const PROVENANCE_MODES = new Set(["live", "backfill"]);
const PRECISIONS = new Set(["exact", "inferred", "unobserved"]);
const SUMMARY_STATUSES = new Set([
  "passed", "partial", "controlled_stop", "failed", "evidence_failed",
  "unverified", "completed", "passed_unclosed",
]);
const ATTEMPT_DIR_RE = /^xhs-compose-conc4(?:-attempt([1-9]\d*))?$/;
const ALIAS_RE = /^0[1-4]$/;

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function validTime(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function normalizedPath(value) {
  return String(value || "").replaceAll("\\", "/");
}

function safeRelative(root, path) {
  const rel = relative(resolve(root), resolve(path));
  if (!rel || rel === ".") return ".";
  if (rel === ".." || rel.startsWith(`..${sep}`) || /^[/\\]/.test(rel)) {
    throw new Error(`path escapes report root: ${path}`);
  }
  return normalizedPath(rel);
}

function atomicWrite(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, bytes);
  renameSync(temp, path);
}

function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8"));
}

function readJsonLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`${path}:${index + 1}: invalid JSONL: ${error.message}`);
      }
    });
}

function walkFiles(root, { excludeReports = true } = {}) {
  if (!existsSync(root)) return [];
  const output = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (excludeReports && entry.isDirectory() && entry.name === "report") continue;
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) output.push(path);
    }
  };
  walk(root);
  return output.sort((left, right) => normalizedPath(left).localeCompare(normalizedPath(right)));
}

export function collectInputManifest(root) {
  const files = walkFiles(root, { excludeReports: true }).map((path) => {
    const bytes = readFileSync(path);
    return {
      path: safeRelative(root, path),
      bytes: bytes.length,
      sha256: sha256(bytes),
    };
  });
  return {
    files,
    inputFileCount: files.length,
    inputBytes: files.reduce((total, file) => total + file.bytes, 0),
    sourceDigest: sha256(files.map((file) => `${file.path}\0${file.bytes}\0${file.sha256}\n`).join("")),
  };
}

function normalizeDraft(draft, defaults = {}) {
  return {
    occurredAt: draft.occurredAt || new Date().toISOString(),
    runId: draft.runId || defaults.runId,
    attempt: draft.attempt ?? defaults.attempt ?? null,
    source: draft.source || defaults.source || "parent",
    event: draft.event,
    status: draft.status ?? null,
    alias: draft.alias ?? null,
    sequenceIndex: draft.sequenceIndex ?? null,
    actionId: draft.actionId ?? null,
    commandId: draft.commandId ?? null,
    retryIndex: draft.retryIndex ?? null,
    detail: draft.detail && typeof draft.detail === "object" && !Array.isArray(draft.detail) ? draft.detail : {},
    evidenceRefs: [...new Set((draft.evidenceRefs || []).map(normalizedPath))],
    provenance: {
      mode: draft.provenance?.mode || defaults.mode || "live",
      precision: draft.provenance?.precision || "exact",
    },
  };
}

export function validateRunEventDraft(draft) {
  const errors = [];
  if (!validTime(draft?.occurredAt)) errors.push("occurredAt must be a date-time");
  if (!/^run_[A-Za-z0-9._-]+$/.test(String(draft?.runId || ""))) errors.push("runId invalid");
  if (draft?.attempt !== null && (!Number.isInteger(draft?.attempt) || draft.attempt < 1)) errors.push("attempt invalid");
  if (!EVENT_SOURCES.has(draft?.source)) errors.push("source invalid");
  if (!RUN_EVENT_TYPES.has(draft?.event)) errors.push("event invalid");
  if (draft?.alias !== null && !ALIAS_RE.test(String(draft.alias))) errors.push("alias invalid");
  if (draft?.sequenceIndex !== null && (!Number.isInteger(draft.sequenceIndex) || draft.sequenceIndex < 0)) errors.push("sequenceIndex invalid");
  if (draft?.retryIndex !== null && (!Number.isInteger(draft.retryIndex) || draft.retryIndex < 0)) errors.push("retryIndex invalid");
  if (!draft?.detail || typeof draft.detail !== "object" || Array.isArray(draft.detail)) errors.push("detail invalid");
  if (!Array.isArray(draft?.evidenceRefs) || draft.evidenceRefs.some((item) => typeof item !== "string" || !item)) errors.push("evidenceRefs invalid");
  if (!PROVENANCE_MODES.has(draft?.provenance?.mode)) errors.push("provenance.mode invalid");
  if (!PRECISIONS.has(draft?.provenance?.precision)) errors.push("provenance.precision invalid");
  return errors;
}

function finalizeEvent(draft, seq, recordedAt = new Date().toISOString()) {
  const body = {
    schemaId: RUN_EVENT_SCHEMA_ID,
    schemaVersion: 1,
    seq,
    ...draft,
    recordedAt,
  };
  const eventId = `evt_${sha256(canonicalJson(body)).slice(0, 24)}`;
  return { ...body, eventId };
}

export function validateRunEvent(event, { expectedSeq = null } = {}) {
  const draft = normalizeDraft(event, { runId: event?.runId, attempt: event?.attempt, source: event?.source, mode: event?.provenance?.mode });
  const errors = validateRunEventDraft(draft);
  if (event?.schemaId !== RUN_EVENT_SCHEMA_ID || event?.schemaVersion !== 1) errors.push("schema invalid");
  if (!Number.isInteger(event?.seq) || event.seq < 1) errors.push("seq invalid");
  if (expectedSeq !== null && event?.seq !== expectedSeq) errors.push(`seq must be ${expectedSeq}`);
  if (!validTime(event?.recordedAt)) errors.push("recordedAt must be a date-time");
  const { eventId, ...unsigned } = event || {};
  const expectedId = `evt_${sha256(canonicalJson(unsigned)).slice(0, 24)}`;
  if (eventId !== expectedId) errors.push("eventId binding invalid");
  return errors;
}

function validNullableTime(value) {
  return value === null || validTime(value);
}

function validEffects(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && ["like", "collect", "follow", "comment", "publish"].every((key) => Number.isFinite(value[key]) && value[key] >= 0);
}

export function validateRunSummary(summary, { scope, runId, attempt = null } = {}) {
  const errors = [];
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) return ["summary must be an object"];
  if (summary.schemaId !== RUN_SUMMARY_SCHEMA_ID || summary.schemaVersion !== 1) errors.push("schema invalid");
  if (!new Set(["attempt", "run"]).has(summary.scope) || (scope && summary.scope !== scope)) errors.push("scope invalid");
  if (!/^run_[A-Za-z0-9._-]+$/.test(String(summary.runId || "")) || (runId && summary.runId !== runId)) errors.push("runId invalid");
  const expectedAttempt = summary.scope === "attempt" ? attempt : null;
  if (summary.scope === "attempt") {
    if (!Number.isInteger(summary.attempt) || summary.attempt < 1 || (expectedAttempt !== null && summary.attempt !== expectedAttempt)) errors.push("attempt invalid");
  } else if (summary.attempt !== null) errors.push("run attempt must be null");
  if (!SUMMARY_STATUSES.has(summary.status)) errors.push("status invalid");
  if (typeof summary.ok !== "boolean") errors.push("ok invalid");
  if (!validNullableTime(summary.startedAt) || !validNullableTime(summary.endedAt)) errors.push("time invalid");
  if (!validEffects(summary.effects)) errors.push("effects invalid");
  if (summary.maturity !== MATURITY) errors.push("maturity invalid");
  const provenance = summary.provenance;
  if (!provenance || !PROVENANCE_MODES.has(provenance.mode)
    || !Number.isInteger(provenance.inputFileCount) || provenance.inputFileCount < 0
    || !Number.isInteger(provenance.inputBytes) || provenance.inputBytes < 0
    || !/^[a-f0-9]{64}$/.test(String(provenance.sourceDigest || ""))) errors.push("provenance invalid");
  if (summary.scope === "run" && !Array.isArray(summary.attempts)) errors.push("attempts invalid");
  return errors;
}

export function validateRunMetrics(metrics, { scope, runId, attempt = null } = {}) {
  const errors = [];
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) return ["metrics must be an object"];
  if (metrics.schemaId !== RUN_METRICS_SCHEMA_ID || metrics.schemaVersion !== 1) errors.push("schema invalid");
  if (!new Set(["attempt", "run"]).has(metrics.scope) || (scope && metrics.scope !== scope)) errors.push("scope invalid");
  if (!/^run_[A-Za-z0-9._-]+$/.test(String(metrics.runId || "")) || (runId && metrics.runId !== runId)) errors.push("runId invalid");
  if (metrics.scope === "attempt") {
    if (!Number.isInteger(metrics.attempt) || metrics.attempt < 1 || (attempt !== null && metrics.attempt !== attempt)) errors.push("attempt invalid");
    if (!metrics.phases || typeof metrics.phases !== "object") errors.push("phases invalid");
    if (!metrics.commands || typeof metrics.commands !== "object" || !Number.isInteger(metrics.commands.count)) errors.push("commands invalid");
    if (!Array.isArray(metrics.workers) || !Array.isArray(metrics.actions)) errors.push("worker/action metrics invalid");
    if (metrics.phases?.queueWaitMs !== null || metrics.phases?.queueWaitObservation !== "unobserved") errors.push("queue wait observation invalid");
    if (metrics.phases?.transportLockWaitMs !== null || metrics.phases?.transportLockObservation !== "unobserved") errors.push("transport lock observation invalid");
  } else {
    if (metrics.attempt !== null) errors.push("run attempt must be null");
    if (!Array.isArray(metrics.attempts)) errors.push("attempts invalid");
  }
  if (!validNullableTime(metrics.startedAt) || !validNullableTime(metrics.endedAt)) errors.push("time invalid");
  if (metrics.wallClockMs !== null && (!Number.isInteger(metrics.wallClockMs) || metrics.wallClockMs < 0)) errors.push("wallClockMs invalid");
  if (!metrics.evidenceCoverage || typeof metrics.evidenceCoverage !== "object") errors.push("evidenceCoverage invalid");
  return errors;
}

export function formatLiveEvent(event) {
  const fields = [
    `seq=${event.seq}`,
    `event=${event.event}`,
    event.alias ? `alias=${event.alias}` : null,
    event.sequenceIndex !== null ? `sequence=${event.sequenceIndex}` : null,
    event.actionId ? `action=${event.actionId}` : null,
    event.status ? `status=${event.status}` : null,
  ].filter(Boolean);
  return `LIVE_PROGRESS ${fields.join(" ")}`;
}

export function createRunEventWriter({
  path,
  runId,
  attempt,
  source = "parent",
  mode = "live",
  append = appendFileSync,
  now = () => new Date().toISOString(),
  onPersisted = null,
  onFailure = null,
} = {}) {
  if (!path) throw new Error("event writer path required");
  mkdirSync(dirname(path), { recursive: true });
  let seq = readJsonLines(path).length;
  let failure = null;
  return {
    get seq() { return seq; },
    get failure() { return failure; },
    append(draft) {
      if (failure) throw failure;
      const normalized = normalizeDraft(draft, { runId, attempt, source, mode });
      const errors = validateRunEventDraft(normalized);
      if (errors.length) throw new Error(`run event invalid: ${errors.join("; ")}`);
      const event = finalizeEvent(normalized, seq + 1, now());
      try {
        append(path, `${canonicalJson(event)}\n`, "utf8");
      } catch (cause) {
        failure = Object.assign(new Error(`timeline write failed: ${cause.message || cause}`), {
          code: "XHS_RUN_EVENT_WRITE_FAILED",
          cause,
        });
        onFailure?.(failure, normalized);
        throw failure;
      }
      seq += 1;
      onPersisted?.(event);
      return event;
    },
  };
}

export function readTimeline(path) {
  const events = readJsonLines(path);
  const errors = events.flatMap((event, index) => validateRunEvent(event, { expectedSeq: index + 1 }).map((message) => `${index + 1}:${message}`));
  return { events, errors };
}

export function attemptNumberFromDirectory(name) {
  const match = String(name || "").match(ATTEMPT_DIR_RE);
  if (!match) return null;
  return match[1] ? Number(match[1]) : 1;
}

export function listAttemptDirectories(runRoot) {
  if (!existsSync(runRoot)) return [];
  const entries = readdirSync(runRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, attempt: attemptNumberFromDirectory(entry.name), path: join(runRoot, entry.name) }))
    .filter((entry) => entry.attempt !== null)
    .sort((left, right) => left.attempt - right.attempt);
  const duplicates = entries.filter((entry, index) => entries.some((candidate, other) => other < index && candidate.attempt === entry.attempt));
  if (duplicates.length) throw new Error(`duplicate canary attempt number: ${duplicates.map((entry) => entry.attempt).join(",")}`);
  return entries;
}

function commandRecords(attemptRoot, repoRoot = resolve(attemptRoot, "..", "..", "..", "..")) {
  const records = [];
  for (const path of walkFiles(attemptRoot, { excludeReports: true }).filter((item) => item.endsWith(".json"))) {
    let value;
    try { value = readJson(path); } catch { continue; }
    if (!value || !Object.hasOwn(value, "durationMs") || !Array.isArray(value.command)) continue;
    records.push({
      ...value,
      evidenceRef: normalizedPath(relative(repoRoot, path)),
      localRef: safeRelative(attemptRoot, path),
    });
  }
  return records.sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt) || left.localRef.localeCompare(right.localRef));
}

function commandScope(record) {
  const parts = normalizedPath(record.localRef).split("/");
  const alias = ALIAS_RE.test(parts[0]) ? parts[0] : record.alias;
  const sequencePart = parts.find((part) => /^seq-\d+$/.test(part));
  const actionPart = parts.find((part) => /^\d+-/.test(part));
  return {
    alias,
    sequenceIndex: sequencePart ? Number(sequencePart.slice(4)) - 1 : null,
    actionId: actionPart ? actionPart.replace(/^\d+-/, "") : null,
  };
}

function eventSort(left, right) {
  const delta = Date.parse(left.occurredAt) - Date.parse(right.occurredAt);
  if (delta) return delta;
  const rank = {
    attempt_started: 0, worker_started: 1, sequence_started: 2, action_started: 3,
    command_started: 4, retry_started: 5, retry_finished: 6, command_finished: 7,
    action_finished: 8, sequence_finished: 9, stop_requested: 10, cleanup_started: 11,
    cleanup_finished: 12, worker_finished: 13, session_released: 14, attempt_finished: 15,
  };
  return (rank[left.event] ?? 50) - (rank[right.event] ?? 50)
    || canonicalJson(left).localeCompare(canonicalJson(right));
}

function minTime(values) {
  const valid = values.filter(validTime).sort((left, right) => Date.parse(left) - Date.parse(right));
  return valid[0] || null;
}

function maxTime(values) {
  const valid = values.filter(validTime).sort((left, right) => Date.parse(right) - Date.parse(left));
  return valid[0] || null;
}

function historicalAttemptDrafts({ repoRoot, runId, attempt, attemptRoot, raw, commands, stop }) {
  const parent = readJson(join(attemptRoot, "parent.json"), {});
  const rawSummaryPath = join(attemptRoot, "summary.json");
  const startedAt = minTime([
    parent.createdAt,
    ...(raw.results || []).map((result) => result.startedAt),
    ...commands.map((command) => command.startedAt),
  ]);
  if (!startedAt) throw new Error(`historical attempt has no stable timestamp: ${attemptRoot}`);
  const endedAt = maxTime([
    ...(raw.results || []).map((result) => result.endedAt),
    ...commands.map((command) => command.endedAt),
    stop?.observedAt,
  ]) || startedAt;
  const drafts = [{
    occurredAt: startedAt, runId, attempt, source: "backfill", event: "attempt_started", status: "running",
    detail: { attemptDirectory: basename(attemptRoot) }, evidenceRefs: [],
    provenance: { mode: "backfill", precision: parent.createdAt ? "exact" : "inferred" },
  }];

  const groupedActions = new Map();
  for (const command of commands) {
    const scope = commandScope(command);
    const commandId = command.commandId || `cmd_${sha256(`${command.localRef}\0${command.startedAt}`).slice(0, 24)}`;
    const key = `${scope.alias}\0${scope.sequenceIndex}\0${scope.actionId}`;
    if (scope.sequenceIndex !== null && scope.actionId) {
      if (!groupedActions.has(key)) groupedActions.set(key, { ...scope, commands: [] });
      groupedActions.get(key).commands.push(command);
    }
    const common = {
      runId, attempt, source: "backfill", alias: scope.alias, sequenceIndex: scope.sequenceIndex,
      actionId: scope.actionId || command.actionId || null, commandId,
      evidenceRefs: [command.evidenceRef], provenance: { mode: "backfill", precision: "exact" },
    };
    drafts.push({
      ...common, occurredAt: command.startedAt, event: "command_started", status: "running",
      detail: { actionId: command.actionId, command: command.command, timeoutObserved: Boolean(command.timedOut) },
    });
    if (Number(command.retryCount || 0) > 0) {
      drafts.push({
        ...common, occurredAt: command.endedAt, event: "retry_finished", status: command.exitCode === 0 ? "succeeded" : "failed",
        retryIndex: Number(command.retryCount),
        detail: {
          retryCount: Number(command.retryCount), durationMs: null,
          reason: "historical attempt records have no per-retry timestamps",
        },
        provenance: { mode: "backfill", precision: "unobserved" },
      });
    }
    drafts.push({
      ...common, occurredAt: command.endedAt, event: "command_finished", status: command.exitCode === 0 ? "succeeded" : "failed",
      detail: { actionId: command.actionId, durationMs: command.durationMs, exitCode: command.exitCode, retryCount: command.retryCount || 0 },
    });
  }

  const sequences = new Map();
  for (const group of groupedActions.values()) {
    const first = minTime(group.commands.map((command) => command.startedAt));
    const last = maxTime(group.commands.map((command) => command.endedAt));
    const sequenceKey = `${group.alias}\0${group.sequenceIndex}`;
    if (!sequences.has(sequenceKey)) sequences.set(sequenceKey, { alias: group.alias, sequenceIndex: group.sequenceIndex, first, last });
    else {
      const sequence = sequences.get(sequenceKey);
      sequence.first = minTime([sequence.first, first]);
      sequence.last = maxTime([sequence.last, last]);
    }
    drafts.push({
      occurredAt: first, runId, attempt, source: "backfill", event: "action_started", status: "running",
      alias: group.alias, sequenceIndex: group.sequenceIndex, actionId: group.actionId,
      detail: {}, evidenceRefs: group.commands.map((command) => command.evidenceRef),
      provenance: { mode: "backfill", precision: "inferred" },
    });
    const worker = (raw.results || []).find((result) => result.alias === group.alias);
    const rawAction = worker?.sequences?.[group.sequenceIndex]?.actions?.find((action) => action.actionId === group.actionId);
    drafts.push({
      occurredAt: last, runId, attempt, source: "backfill", event: "action_finished",
      status: rawAction?.ok === false ? "failed" : "succeeded", alias: group.alias,
      sequenceIndex: group.sequenceIndex, actionId: group.actionId,
      detail: { durationMs: rawAction?.durationMs ?? Math.max(0, Date.parse(last) - Date.parse(first)) },
      evidenceRefs: group.commands.map((command) => command.evidenceRef),
      provenance: { mode: "backfill", precision: rawAction?.durationMs != null ? "exact" : "inferred" },
    });
  }

  for (const sequence of sequences.values()) {
    drafts.push({
      occurredAt: sequence.first, runId, attempt, source: "backfill", event: "sequence_started", status: "running",
      alias: sequence.alias, sequenceIndex: sequence.sequenceIndex, detail: {}, evidenceRefs: [],
      provenance: { mode: "backfill", precision: "inferred" },
    });
    drafts.push({
      occurredAt: sequence.last, runId, attempt, source: "backfill", event: "sequence_finished", status: "terminal",
      alias: sequence.alias, sequenceIndex: sequence.sequenceIndex, detail: {}, evidenceRefs: [],
      provenance: { mode: "backfill", precision: "inferred" },
    });
  }

  for (const result of raw.results || []) {
    drafts.push({
      occurredAt: result.startedAt || startedAt, runId, attempt, source: "backfill", event: "worker_started", status: "running",
      alias: result.alias, detail: { actor: result.actor || null }, evidenceRefs: [],
      provenance: { mode: "backfill", precision: result.startedAt ? "exact" : "inferred" },
    });
    drafts.push({
      occurredAt: result.endedAt || endedAt, runId, attempt, source: "backfill", event: "worker_finished",
      status: result.ok ? "succeeded" : (result.stopClass || "failed"), alias: result.alias,
      detail: { reason: result.reason || null, effects: result.effects || {} }, evidenceRefs: [],
      provenance: { mode: "backfill", precision: result.endedAt ? "exact" : "inferred" },
    });
  }
  if (stop) {
    drafts.push({
      occurredAt: stop.observedAt || endedAt, runId, attempt, source: "backfill", event: "stop_requested",
      status: stop.code || "stop", alias: stop.alias || null, detail: stop,
      evidenceRefs: [normalizedPath(relative(repoRoot, join(attemptRoot, "STOP.json")))],
      provenance: { mode: "backfill", precision: stop.observedAt ? "exact" : "inferred" },
    });
  }
  for (const release of raw.releases || []) {
    drafts.push({
      occurredAt: endedAt, runId, attempt, source: "backfill", event: "session_released",
      status: release.ok ? "succeeded" : "failed", alias: release.alias,
      detail: { exitCode: release.status ?? null }, evidenceRefs: [],
      provenance: { mode: "backfill", precision: "unobserved" },
    });
  }
  drafts.push({
    occurredAt: endedAt, runId, attempt, source: "backfill", event: "attempt_finished",
    status: raw.ok ? "passed" : stop ? "controlled_stop" : "failed",
    detail: { rawOk: Boolean(raw.ok), stop: stop || null },
    evidenceRefs: [normalizedPath(relative(repoRoot, rawSummaryPath))],
    provenance: { mode: "backfill", precision: "exact" },
  });
  return drafts.sort(eventSort);
}

function intervalUnionMs(records) {
  const intervals = records
    .map((record) => [Date.parse(record.startedAt), Date.parse(record.endedAt)])
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end >= start)
    .sort((left, right) => left[0] - right[0]);
  let total = 0;
  let current = null;
  for (const interval of intervals) {
    if (!current || interval[0] > current[1]) {
      if (current) total += current[1] - current[0];
      current = [...interval];
    } else {
      current[1] = Math.max(current[1], interval[1]);
    }
  }
  if (current) total += current[1] - current[0];
  return total;
}

function commandCategory(actionId) {
  const id = String(actionId || "");
  if (/^(?:final|failure-cleanup)/.test(id)) return "cleanup";
  if (/-restore-home$/.test(id)) return "pageRecovery";
  if (/-focus$/.test(id)) return "uiFocus";
  if (/-dump$/.test(id)) return "uiDump";
  return "actualAction";
}

function attemptStatus(raw, stop, events) {
  if (raw?.evidenceFailure || events.some((event) => event.event === "evidence_failure")) return "evidence_failed";
  if (raw?.ok === true) return "passed";
  if (stop) return "controlled_stop";
  const okCount = (raw?.results || []).filter((result) => result.ok).length;
  if (okCount > 0) return "partial";
  if (Array.isArray(raw?.results)) return "failed";
  return "unverified";
}

function actionRows(raw) {
  return (raw.results || []).flatMap((result) => (result.sequences || []).flatMap((sequence) =>
    (sequence.actions || []).map((action) => ({
      alias: result.alias,
      sequenceIndex: sequence.index ?? null,
      actionId: action.actionId,
      durationMs: Number(action.durationMs || 0),
      ok: action.ok !== false,
    }))));
}

function actionStats(rows) {
  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.actionId)) grouped.set(row.actionId, []);
    grouped.get(row.actionId).push(row);
  }
  return [...grouped.entries()].map(([actionId, items]) => {
    const totalMs = items.reduce((total, item) => total + item.durationMs, 0);
    const slowest = items.reduce((left, right) => right.durationMs > left.durationMs ? right : left, items[0]);
    return {
      actionId,
      count: items.length,
      totalMs,
      averageMs: items.length ? Math.round(totalMs / items.length) : null,
      maxMs: slowest?.durationMs ?? null,
      slowest: slowest ? { alias: slowest.alias, sequenceIndex: slowest.sequenceIndex, durationMs: slowest.durationMs } : null,
    };
  }).sort((left, right) => left.actionId.localeCompare(right.actionId));
}

export function buildAttemptMetrics({ attemptRoot, raw, events, manifest }) {
  const commands = commandRecords(attemptRoot);
  const rows = actionRows(raw);
  const parent = readJson(join(attemptRoot, "parent.json"), {});
  const startedAt = minTime([parent.createdAt, ...events.map((event) => event.event === "attempt_started" ? event.occurredAt : null)]);
  const endedAt = maxTime([
    ...events.map((event) => event.event === "attempt_finished" ? event.occurredAt : null),
    ...(raw.results || []).map((result) => result.endedAt),
  ]);
  const workerStarts = (raw.results || []).map((result) => result.startedAt).filter(validTime);
  const workerEnds = (raw.results || []).map((result) => result.endedAt).filter(validTime);
  const executionStart = minTime(workerStarts);
  const executionEnd = maxTime(workerEnds);
  const categoryTotals = { pageRecoveryMs: 0, uiFocusMs: 0, uiDumpMs: 0, actualActionMs: 0, cleanupMs: 0 };
  for (const command of commands) categoryTotals[`${commandCategory(command.actionId)}Ms`] += Number(command.durationMs || 0);
  const retries = commands.filter((command) => Number(command.retryCount || 0) > 0);
  const retryDurations = retries.flatMap((command) => (command.attempts || []).slice(1).map((item) => item.durationMs)).filter(Number.isFinite);
  const retryDurationObserved = retries.length === 0 || retryDurations.length === retries.reduce((total, command) => total + Number(command.retryCount || 0), 0);
  const perAlias = (raw.results || []).map((result) => {
    const aliasCommands = commands.filter((command) => command.alias === result.alias);
    const aliasActions = rows.filter((row) => row.alias === result.alias);
    const wallMs = validTime(result.startedAt) && validTime(result.endedAt) ? Date.parse(result.endedAt) - Date.parse(result.startedAt) : null;
    const commandUnionMs = intervalUnionMs(aliasCommands);
    const actionEnvelopeMs = aliasActions.reduce((total, row) => total + row.durationMs, 0);
    return {
      alias: result.alias,
      status: result.ok ? "passed" : (result.stopClass || "failed"),
      startedAt: result.startedAt || null,
      endedAt: result.endedAt || null,
      wallMs,
      commandCount: aliasCommands.length,
      commandEnvelopeMs: commandUnionMs,
      commandCoverageRatio: wallMs > 0 ? Number(Math.min(1, commandUnionMs / wallMs).toFixed(6)) : null,
      fullyUnattributedMs: wallMs === null ? null : Math.max(0, wallMs - commandUnionMs),
      actionEnvelopeMs,
      actionEnvelopeUnattributedMs: wallMs === null ? null : Math.max(0, wallMs - actionEnvelopeMs),
      effects: result.effects || {},
    };
  });
  const critical = perAlias.filter((item) => Number.isFinite(item.wallMs)).sort((left, right) => right.wallMs - left.wallMs)[0] || null;
  const criticalActions = critical ? rows.filter((row) => row.alias === critical.alias) : [];
  return {
    schemaId: RUN_METRICS_SCHEMA_ID,
    schemaVersion: 1,
    scope: "attempt",
    runId: raw.runId,
    attempt: raw.attempt,
    startedAt,
    endedAt,
    wallClockMs: validTime(startedAt) && validTime(endedAt) ? Date.parse(endedAt) - Date.parse(startedAt) : null,
    phases: {
      setupMs: validTime(startedAt) && validTime(executionStart) ? Math.max(0, Date.parse(executionStart) - Date.parse(startedAt)) : null,
      executionMs: validTime(executionStart) && validTime(executionEnd) ? Math.max(0, Date.parse(executionEnd) - Date.parse(executionStart)) : null,
      teardownMs: validTime(executionEnd) && validTime(endedAt) ? Math.max(0, Date.parse(endedAt) - Date.parse(executionEnd)) : null,
      queueWaitMs: null,
      queueWaitObservation: "unobserved",
      transportLockWaitMs: null,
      transportLockObservation: "unobserved",
      ...categoryTotals,
      retryMs: retryDurationObserved ? retryDurations.reduce((total, duration) => total + duration, 0) : null,
      retryObservation: retryDurationObserved ? "exact" : "unobserved",
    },
    commands: {
      count: commands.length,
      recordedDurationMs: commands.reduce((total, command) => total + Number(command.durationMs || 0), 0),
      retryCount: commands.reduce((total, command) => total + Number(command.retryCount || 0), 0),
    },
    workers: perAlias,
    actions: actionStats(rows),
    criticalPath: critical ? {
      alias: critical.alias,
      durationMs: critical.wallMs,
      actions: criticalActions.map(({ actionId, durationMs, sequenceIndex }) => ({ actionId, durationMs, sequenceIndex })),
    } : null,
    evidenceCoverage: {
      inputFileCount: manifest.inputFileCount,
      inputBytes: manifest.inputBytes,
      commandRecordCount: commands.length,
      timelineEventCount: events.length,
    },
  };
}

function aggregateEffects(results) {
  const effects = { like: 0, collect: 0, follow: 0, comment: 0, publish: 0 };
  for (const result of results || []) {
    for (const key of Object.keys(effects)) effects[key] += Number(result.effects?.[key] || 0);
  }
  return effects;
}

function buildAttemptSummary({ raw, stop, events, metrics, manifest, mode }) {
  const status = attemptStatus(raw, stop, events);
  const aliasesPassed = (raw.results || []).filter((result) => result.ok).map((result) => result.alias);
  const sequences = (raw.results || []).flatMap((result) => result.sequences || []);
  const actions = sequences.flatMap((sequence) => sequence.actions || []);
  return {
    schemaId: RUN_SUMMARY_SCHEMA_ID,
    schemaVersion: 1,
    scope: "attempt",
    runId: raw.runId,
    attempt: raw.attempt,
    status,
    ok: status === "passed",
    startedAt: metrics.startedAt,
    endedAt: metrics.endedAt,
    aliases: raw.aliases || (raw.results || []).map((result) => result.alias),
    aliasesPassed,
    workersPassed: aliasesPassed.length,
    workersExpected: (raw.aliases || []).length,
    sequencesPassed: sequences.filter((sequence) => sequence.ok).length,
    actionsPassed: actions.filter((action) => action.ok).length,
    coverage: raw.coverage || null,
    stop: stop || null,
    effects: aggregateEffects(raw.results),
    releases: (raw.releases || []).map((release) => ({ alias: release.alias, ok: Boolean(release.ok), exitCode: release.status ?? null })),
    maturity: MATURITY,
    provenance: {
      mode,
      inputFileCount: manifest.inputFileCount,
      inputBytes: manifest.inputBytes,
      sourceDigest: manifest.sourceDigest,
    },
  };
}

function seconds(ms) {
  return Number.isFinite(ms) ? `${(ms / 1000).toFixed(3)}s` : "unobserved";
}

function markdownEscape(value) {
  return String(value ?? "").replaceAll("|", "\\|").replaceAll("\r", " ").replaceAll("\n", " ");
}

export function renderAttemptReport({ summary, metrics }) {
  const lines = [
    `# xhs-compose canary attempt ${summary.attempt}`,
    "",
    `- Run: \`${summary.runId}\``,
    `- 结果: **${summary.status}**`,
    `- 成熟度: \`${summary.maturity}\``,
    `- 墙钟: ${seconds(metrics.wallClockMs)}`,
    `- 证据: ${summary.provenance.inputFileCount} files / ${summary.provenance.inputBytes} bytes / ${metrics.commands.count} command records`,
    `- 外部效果: like=${summary.effects.like}, collect=${summary.effects.collect}, follow=${summary.effects.follow}, comment=${summary.effects.comment}, publish=${summary.effects.publish}`,
    "",
    "## 设备结果",
    "",
    "| alias | status | wall | commands | command coverage | action remainder | release |",
    "|---|---:|---:|---:|---:|---:|---:|",
    ...metrics.workers.map((worker) => {
      const release = summary.releases.find((item) => item.alias === worker.alias);
      return `| ${worker.alias} | ${worker.status} | ${seconds(worker.wallMs)} | ${worker.commandCount} | ${worker.commandCoverageRatio === null ? "unobserved" : `${(worker.commandCoverageRatio * 100).toFixed(1)}%`} | ${seconds(worker.actionEnvelopeUnattributedMs)} | ${release?.ok ? "ok" : "failed"} |`;
    }),
    "",
    "## 动作耗时",
    "",
    "| action | count | average | max | slowest |",
    "|---|---:|---:|---:|---|",
    ...metrics.actions.map((action) => `| ${action.actionId} | ${action.count} | ${seconds(action.averageMs)} | ${seconds(action.maxMs)} | ${action.slowest?.alias || "-"} seq-${action.slowest?.sequenceIndex ?? "-"} |`),
    "",
    "## STOP 与关键路径",
    "",
    summary.stop
      ? `- STOP: ${summary.stop.observedAt || "unknown time"} / alias ${summary.stop.alias || "-"} / ${markdownEscape(summary.stop.detail || summary.stop.code)}`
      : "- STOP: none",
    metrics.criticalPath
      ? `- Critical worker: ${metrics.criticalPath.alias}, ${seconds(metrics.criticalPath.durationMs)}`
      : "- Critical worker: unobserved",
    `- Retry: count=${metrics.commands.retryCount}, time=${seconds(metrics.phases.retryMs)} (${metrics.phases.retryObservation})`,
    "- Queue wait: unobserved；transportLock wait: unobserved。未观测值不按 0 处理。",
    "",
    "## 证据入口",
    "",
    "- `timeline.jsonl`：全局时间序事件，仅引用底层证据。",
    "- `metrics.json`：阶段、设备、动作与覆盖率。",
    "- `summary.json`：机器可验证终态。",
    "- 原始命令 stdout/stderr 保留在本 attempt 的 alias/sequence/action 目录。",
    "",
    summary.provenance.mode === "backfill"
      ? "> 本报告由历史证据回填；无法从旧记录证明的时间字段明确标为 unobserved。"
      : "> 本报告与实时 LIVE_PROGRESS 使用同一条持久化事件流。",
    "",
  ];
  return lines.join("\n");
}

function writeTimeline(path, drafts) {
  mkdirSync(dirname(path), { recursive: true });
  const events = drafts.map((draft, index) => {
    if (!validTime(draft.occurredAt)) throw new Error(`backfill event ${index + 1} invalid: occurredAt must be a date-time`);
    const normalized = normalizeDraft(draft, {
      runId: draft.runId,
      attempt: draft.attempt,
      source: draft.source,
      mode: draft.provenance?.mode,
    });
    const draftErrors = validateRunEventDraft(normalized);
    if (draftErrors.length) throw new Error(`backfill event ${index + 1} invalid: ${draftErrors.join("; ")}`);
    const event = finalizeEvent(normalized, index + 1, draft.recordedAt || draft.occurredAt);
    const eventErrors = validateRunEvent(event, { expectedSeq: index + 1 });
    if (eventErrors.length) throw new Error(`backfill event ${index + 1} invalid: ${eventErrors.join("; ")}`);
    return event;
  });
  atomicWrite(path, events.map((event) => `${canonicalJson(event)}\n`).join(""));
  return events;
}

function writeAttemptOutputs({ attemptRoot, events, metrics, summary }) {
  const summaryErrors = validateRunSummary(summary, { scope: "attempt", runId: summary.runId, attempt: summary.attempt });
  const metricsErrors = validateRunMetrics(metrics, { scope: "attempt", runId: summary.runId, attempt: summary.attempt });
  if (summaryErrors.length || metricsErrors.length) {
    throw new Error(`attempt report invalid: ${[...summaryErrors.map((item) => `summary:${item}`), ...metricsErrors.map((item) => `metrics:${item}`)].join("; ")}`);
  }
  const reportRoot = join(attemptRoot, "report");
  mkdirSync(reportRoot, { recursive: true });
  atomicWrite(join(reportRoot, "metrics.json"), `${JSON.stringify(metrics, null, 2)}\n`);
  atomicWrite(join(reportRoot, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  atomicWrite(join(reportRoot, "run-report.md"), renderAttemptReport({ summary, metrics }));
  return reportRoot;
}

export function backfillAttemptReport({ repoRoot, runId, attemptRoot }) {
  const attempt = attemptNumberFromDirectory(basename(attemptRoot));
  if (!attempt) throw new Error(`not a canary attempt directory: ${attemptRoot}`);
  const rawPath = join(attemptRoot, "summary.json");
  const raw = readJson(rawPath);
  if (!raw) throw new Error(`raw summary missing: ${rawPath}`);
  raw.runId ||= runId;
  raw.attempt ||= attempt;
  const stop = readJson(join(attemptRoot, "STOP.json"), raw.stop || null);
  const commands = commandRecords(attemptRoot, repoRoot);
  const manifest = collectInputManifest(attemptRoot);
  const drafts = historicalAttemptDrafts({ repoRoot, runId, attempt, attemptRoot, raw, commands, stop });
  const timelinePath = join(attemptRoot, "report", "timeline.jsonl");
  const events = writeTimeline(timelinePath, drafts);
  const metrics = buildAttemptMetrics({ attemptRoot, raw, events, manifest });
  const summary = buildAttemptSummary({ raw, stop, events, metrics, manifest, mode: "backfill" });
  const reportRoot = writeAttemptOutputs({ attemptRoot, events, metrics, summary });
  return { attempt, reportRoot, summary, metrics, events };
}

export function finalizeLiveAttemptReport({ repoRoot, runId, attemptRoot, evidenceFailure = null }) {
  const attempt = attemptNumberFromDirectory(basename(attemptRoot));
  const rawPath = join(attemptRoot, "summary.json");
  const raw = readJson(rawPath);
  if (!raw) throw new Error(`raw summary missing: ${rawPath}`);
  raw.runId ||= runId;
  raw.attempt ||= attempt;
  if (evidenceFailure) raw.evidenceFailure = String(evidenceFailure.message || evidenceFailure);
  const stop = readJson(join(attemptRoot, "STOP.json"), raw.stop || null);
  const timelinePath = join(attemptRoot, "report", "timeline.jsonl");
  const { events, errors } = readTimeline(timelinePath);
  if (errors.length && !raw.evidenceFailure) raw.evidenceFailure = `timeline invalid: ${errors.join("; ")}`;
  const manifest = collectInputManifest(attemptRoot);
  const metrics = buildAttemptMetrics({ attemptRoot, raw, events, manifest });
  const summary = buildAttemptSummary({ raw, stop, events, metrics, manifest, mode: "live" });
  const reportRoot = writeAttemptOutputs({ attemptRoot, events, metrics, summary });
  return { attempt, reportRoot, summary, metrics, events, errors };
}

function taskRunDrafts({ runId, runRoot, attemptReports, closeout }) {
  const task = readJson(join(runRoot, "task.json"), null);
  const steps = readJsonLines(join(runRoot, "steps.jsonl"));
  const validationPath = join(runRoot, "validation-summary.json");
  const validation = readJson(validationPath, null);
  const drafts = [];
  if (task) drafts.push({
    occurredAt: task.startedAt, runId, attempt: null, source: "task", event: "run_started", status: "running",
    detail: { taskId: task.taskId, actor: task.actor, goal: task.goal, mode: task.mode },
    evidenceRefs: [normalizedPath(relative(resolve(runRoot, "..", "..", ".."), join(runRoot, "task.json")))],
    provenance: { mode: "backfill", precision: "exact" },
  });
  for (const step of steps) drafts.push({
    occurredAt: step.ts, runId, attempt: null, source: "task", event: "run_step", status: step.status,
    detail: { stepId: step.stepId, title: step.title, notes: step.notes || null, exitCode: step.exitCode ?? null },
    evidenceRefs: (step.evidence || []).map((item) => item.path),
    provenance: { mode: "backfill", precision: "exact" },
  });
  for (const report of attemptReports) {
    for (const event of report.events) {
      const { schemaId, schemaVersion, eventId, seq, recordedAt, ...draft } = event;
      drafts.push({
        ...draft,
        detail: { ...draft.detail, attemptEventId: eventId },
      });
    }
  }
  const validationOccurredAt = closeout?.endedAt || maxTime(attemptReports.map((report) => report.summary.endedAt)) || task?.startedAt;
  if (validation && validationOccurredAt) drafts.push({
    occurredAt: validationOccurredAt, runId, attempt: null, source: "validation", event: "validation_recorded",
    status: validation.status || "unverified", detail: { maturity: validation.maturity || null },
    evidenceRefs: [normalizedPath(relative(resolve(runRoot, "..", "..", ".."), validationPath))],
    provenance: { mode: "backfill", precision: "inferred" },
  });
  if (closeout) drafts.push({
    occurredAt: closeout.endedAt, runId, attempt: null, source: "closeout", event: "closeout_recorded",
    status: closeout.closure?.status || "unverified", detail: { taskId: closeout.taskId, closure: closeout.closure },
    evidenceRefs: [`outbox/harvest/${runId}/closeout.v1.json`],
    provenance: { mode: "backfill", precision: "exact" },
  });
  return drafts.sort(eventSort);
}

function runStatus(closeout, attempts) {
  if (closeout?.closure?.status === "completed") return "completed";
  if (attempts.some((attempt) => attempt.summary.status === "passed")) return "passed_unclosed";
  if (attempts.some((attempt) => attempt.summary.status === "partial" || attempt.summary.status === "controlled_stop")) return "partial";
  if (attempts.length) return "failed";
  return "unverified";
}

function buildRunSummary({ runId, runRoot, attempts, closeout, manifest }) {
  const task = readJson(join(runRoot, "task.json"), {});
  const status = runStatus(closeout, attempts);
  const effects = attempts.reduce((total, attempt) => {
    for (const key of Object.keys(total)) total[key] += Number(attempt.summary.effects?.[key] || 0);
    return total;
  }, { like: 0, collect: 0, follow: 0, comment: 0, publish: 0 });
  return {
    schemaId: RUN_SUMMARY_SCHEMA_ID,
    schemaVersion: 1,
    scope: "run",
    runId,
    attempt: null,
    taskId: closeout?.taskId || task.taskId || null,
    actor: closeout?.actor || task.actor || null,
    goal: task.goal || null,
    status,
    ok: status === "completed" || status === "passed_unclosed",
    startedAt: closeout?.startedAt || task.startedAt || minTime(attempts.map((item) => item.summary.startedAt)),
    endedAt: closeout?.endedAt || maxTime(attempts.map((item) => item.summary.endedAt)),
    attempts: attempts.map((item) => ({
      attempt: item.attempt,
      status: item.summary.status,
      startedAt: item.summary.startedAt,
      endedAt: item.summary.endedAt,
      workersPassed: item.summary.workersPassed,
      workersExpected: item.summary.workersExpected,
      actionsPassed: item.summary.actionsPassed,
      stop: item.summary.stop,
    })),
    effects,
    closeout: closeout ? {
      status: closeout.closure?.status || "unverified",
      completed: closeout.closure?.completed || [],
      remainingWork: closeout.closure?.remainingWork || [],
      blockers: closeout.closure?.blockers || [],
      evidenceDebt: closeout.evidenceDebt || [],
    } : null,
    maturity: MATURITY,
    provenance: {
      mode: "backfill",
      inputFileCount: manifest.inputFileCount,
      inputBytes: manifest.inputBytes,
      sourceDigest: manifest.sourceDigest,
    },
  };
}

function buildRunMetrics({ summary, attempts, events, manifest }) {
  return {
    schemaId: RUN_METRICS_SCHEMA_ID,
    schemaVersion: 1,
    scope: "run",
    runId: summary.runId,
    attempt: null,
    startedAt: summary.startedAt,
    endedAt: summary.endedAt,
    wallClockMs: validTime(summary.startedAt) && validTime(summary.endedAt)
      ? Date.parse(summary.endedAt) - Date.parse(summary.startedAt)
      : null,
    attempts: attempts.map((attempt) => ({
      attempt: attempt.attempt,
      status: attempt.summary.status,
      wallClockMs: attempt.metrics.wallClockMs,
      commandCount: attempt.metrics.commands.count,
      retryCount: attempt.metrics.commands.retryCount,
      criticalPath: attempt.metrics.criticalPath,
    })),
    slowestAttempt: attempts
      .filter((attempt) => Number.isFinite(attempt.metrics.wallClockMs))
      .sort((left, right) => right.metrics.wallClockMs - left.metrics.wallClockMs)
      .slice(0, 1)
      .map((attempt) => ({ attempt: attempt.attempt, wallClockMs: attempt.metrics.wallClockMs }))[0] || null,
    evidenceCoverage: {
      inputFileCount: manifest.inputFileCount,
      inputBytes: manifest.inputBytes,
      timelineEventCount: events.length,
    },
  };
}

export function renderRunReport({ summary, metrics, attempts }) {
  const lines = [
    `# xhs-compose run report`,
    "",
    `- Run: \`${summary.runId}\``,
    `- Task: \`${summary.taskId || "unobserved"}\``,
    `- Actor: \`${summary.actor || "unobserved"}\``,
    `- 目标: ${summary.goal || "unobserved"}`,
    `- 终态: **${summary.status}**`,
    `- 成熟度: \`${summary.maturity}\``,
    `- 总墙钟: ${seconds(metrics.wallClockMs)}`,
    `- 外部效果: like=${summary.effects.like}, collect=${summary.effects.collect}, follow=${summary.effects.follow}, comment=${summary.effects.comment}, publish=${summary.effects.publish}`,
    "",
    "## 执行演进",
    "",
    "| attempt | result | wall | workers | actions | STOP |",
    "|---:|---|---:|---:|---:|---|",
    ...attempts.map((attempt) => {
      const stop = attempt.summary.stop;
      return `| ${attempt.attempt} | ${attempt.summary.status} | ${seconds(attempt.metrics.wallClockMs)} | ${attempt.summary.workersPassed}/${attempt.summary.workersExpected} | ${attempt.summary.actionsPassed} | ${stop ? `${stop.alias || "-"}: ${markdownEscape(stop.detail || stop.code)}` : "none"} |`;
    }),
    "",
    "## 结论",
    "",
    ...(summary.closeout?.completed?.length
      ? summary.closeout.completed.map((item) => `- ${item}`)
      : ["- 无 closeout completed 声明。"]) ,
    ...(summary.closeout?.evidenceDebt?.length
      ? summary.closeout.evidenceDebt.map((item) => `- 证据债 ${item.code}: ${item.summary}`)
      : ["- 无 closeout 证据债。"]) ,
    "- Queue/transportLock 精确等待未被历史 Explorer 证据观测，统一保持 unobserved。",
    "- 这是 engineering canary 证据，不构成日常 runner 或真实赞/藏/关的 production 晋级。",
    "",
    "## 钻取顺序",
    "",
    "1. 本页理解任务与 attempt 演进。",
    "2. 查看 `summary.json` 与 `metrics.json` 做机器验收。",
    "3. 进入对应 attempt 的 `report/run-report.md`。",
    "4. 出错先看原 attempt 的 `STOP.json`，再沿 timeline 的 evidenceRefs 进入命令记录。",
    "",
    "> 本入口由原始证据 append-only 回填生成；原 attempt summary、STOP、命令 JSON 与 closeout 均未覆盖。",
    "",
  ];
  return lines.join("\n");
}

export function buildRunReport({ repoRoot, runId, attemptReports = null }) {
  const runRoot = join(repoRoot, "outbox", "work", runId);
  if (!existsSync(runRoot)) throw new Error(`run work directory missing: ${runRoot}`);
  const attempts = attemptReports || listAttemptDirectories(runRoot).map((entry) => {
    const reportRoot = join(entry.path, "report");
    const summary = readJson(join(reportRoot, "summary.json"));
    const metrics = readJson(join(reportRoot, "metrics.json"));
    const { events, errors } = readTimeline(join(reportRoot, "timeline.jsonl"));
    const structuralErrors = [
      ...validateRunSummary(summary, { scope: "attempt", runId, attempt: entry.attempt }).map((item) => `summary:${item}`),
      ...validateRunMetrics(metrics, { scope: "attempt", runId, attempt: entry.attempt }).map((item) => `metrics:${item}`),
    ];
    if (errors.length || structuralErrors.length) {
      throw new Error(`attempt ${entry.attempt} report missing or invalid: ${[...errors, ...structuralErrors].join("; ")}`);
    }
    return { attempt: entry.attempt, reportRoot, summary, metrics, events };
  });
  const closeoutPath = join(repoRoot, "outbox", "harvest", runId, "closeout.v1.json");
  const closeout = readJson(closeoutPath, null);
  const drafts = taskRunDrafts({ runId, runRoot, attemptReports: attempts, closeout });
  const reportRoot = join(runRoot, "report");
  const events = writeTimeline(join(reportRoot, "timeline.jsonl"), drafts);
  const manifest = collectInputManifest(runRoot);
  const summary = buildRunSummary({ runId, runRoot, attempts, closeout, manifest });
  const metrics = buildRunMetrics({ summary, attempts, events, manifest });
  const summaryErrors = validateRunSummary(summary, { scope: "run", runId });
  const metricsErrors = validateRunMetrics(metrics, { scope: "run", runId });
  if (summaryErrors.length || metricsErrors.length) {
    throw new Error(`run report invalid: ${[...summaryErrors.map((item) => `summary:${item}`), ...metricsErrors.map((item) => `metrics:${item}`)].join("; ")}`);
  }
  mkdirSync(reportRoot, { recursive: true });
  atomicWrite(join(reportRoot, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  atomicWrite(join(reportRoot, "metrics.json"), `${JSON.stringify(metrics, null, 2)}\n`);
  atomicWrite(join(reportRoot, "run-report.md"), renderRunReport({ summary, metrics, attempts }));
  return { reportRoot, summary, metrics, events, attempts };
}

export function backfillRunReport({ repoRoot, runId }) {
  const runRoot = join(repoRoot, "outbox", "work", runId);
  const attempts = listAttemptDirectories(runRoot).map((entry) => backfillAttemptReport({ repoRoot, runId, attemptRoot: entry.path }));
  return buildRunReport({ repoRoot, runId, attemptReports: attempts });
}

function artifactClass(path) {
  const normalized = normalizedPath(path);
  if (normalized.startsWith("outbox/work/") || normalized.startsWith("outbox/harvest/")) return "run_evidence";
  return "mutable_source";
}

export function auditCloseoutArtifacts({ repoRoot, runId }) {
  const closeoutPath = join(repoRoot, "outbox", "harvest", runId, "closeout.v1.json");
  const closeout = readJson(closeoutPath, null);
  if (!closeout) return { present: false, runEvidenceMismatches: [], mutableSourceDrift: [] };
  const rows = [];
  for (const artifact of closeout.artifacts || []) {
    if (artifact.availability !== "present") continue;
    const path = resolve(repoRoot, artifact.path);
    let currentSha256 = null;
    try {
      const lst = lstatSync(path);
      if (lst.isFile() && !lst.isSymbolicLink()) currentSha256 = sha256(readFileSync(path));
    } catch { /* missing remains null */ }
    rows.push({
      artifactId: artifact.artifactId,
      path: artifact.path,
      class: artifactClass(artifact.path),
      sealedSha256: artifact.sha256,
      currentSha256,
      match: currentSha256 === artifact.sha256,
    });
  }
  return {
    present: true,
    runEvidenceMismatches: rows.filter((row) => row.class === "run_evidence" && !row.match),
    mutableSourceDrift: rows.filter((row) => row.class === "mutable_source" && !row.match),
    rows,
  };
}

export function validateRunReports({ repoRoot, runId }) {
  const runRoot = join(repoRoot, "outbox", "work", runId);
  const errors = [];
  const attempts = [];
  for (const entry of listAttemptDirectories(runRoot)) {
    const reportRoot = join(entry.path, "report");
    const timeline = readTimeline(join(reportRoot, "timeline.jsonl"));
    errors.push(...timeline.errors.map((error) => `attempt${entry.attempt}.timeline:${error}`));
    const summary = readJson(join(reportRoot, "summary.json"), null);
    const metrics = readJson(join(reportRoot, "metrics.json"), null);
    errors.push(...validateRunSummary(summary, { scope: "attempt", runId, attempt: entry.attempt })
      .map((error) => `attempt${entry.attempt}.summary:${error}`));
    errors.push(...validateRunMetrics(metrics, { scope: "attempt", runId, attempt: entry.attempt })
      .map((error) => `attempt${entry.attempt}.metrics:${error}`));
    if (summary && metrics && summary.runId !== metrics.runId) errors.push(`attempt${entry.attempt}.runId mismatch`);
    attempts.push({ attempt: entry.attempt, summary, metrics });
  }
  const rootTimeline = readTimeline(join(runRoot, "report", "timeline.jsonl"));
  errors.push(...rootTimeline.errors.map((error) => `run.timeline:${error}`));
  const rootSummary = readJson(join(runRoot, "report", "summary.json"), null);
  const rootMetrics = readJson(join(runRoot, "report", "metrics.json"), null);
  errors.push(...validateRunSummary(rootSummary, { scope: "run", runId }).map((error) => `run.summary:${error}`));
  errors.push(...validateRunMetrics(rootMetrics, { scope: "run", runId }).map((error) => `run.metrics:${error}`));
  if (rootSummary && rootSummary.attempts?.length !== attempts.length) errors.push("run attempt count mismatch");
  const closeoutAudit = auditCloseoutArtifacts({ repoRoot, runId });
  if (closeoutAudit.runEvidenceMismatches.length) errors.push(`sealed run evidence mismatch: ${closeoutAudit.runEvidenceMismatches.map((item) => item.path).join(", ")}`);
  return { ok: errors.length === 0, errors, attempts, rootSummary, rootMetrics, closeoutAudit };
}
