// ops-health.mjs — declared ≠ observed overlay. Read-only. No Date.now() inside scoreCommands.
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

export const SCHEMA_ID = "xhs.ops-health.v1";
export const SCHEMA_VERSION = 1;

export const DEFAULT_TUNABLES = Object.freeze({
  WINDOW_N: 10,
  WINDOW_DAYS: 14,
  MIN_HEALTHY_SAMPLES: 3,
  MIN_FLAKY_SAMPLES: 3,
  FLAKY_FAIL_RATE: 0.3,
  FLAKY_MIN_FAILS_WHEN_THIN: 2,
  STALL_P95_MULTIPLIER: 3.0,
  MIN_DURATION_BASELINE: 3,
  ABANDONED_AFTER_MS: 14_400_000,
  SCAN_DIR_CAP: 500,
  STALL_READ_LIMIT: 200,
  EXPLORE_LIVE_MTIME_MS: 1_800_000,
  SESSION_FOREIGN_PREFIXES: Object.freeze(["wechat-balance-", "xw-locator-", "xy-idle-", "codex-share-"]),
  AMOUNT_RE: /¥\s*\d[\d,]*(?:\.\d+)?/g,
  AMOUNT_KEY_EXACT: Object.freeze(["amountCny", "balanceCny", "display"]),
  PERCENTILE_METHOD: "nearest-rank",
});

const HARVEST_DIR_RE = /^run_[A-Za-z0-9._-]+$/;
const EXPLORER_SCHEMA = "xhs.explorer-session-context.v1";

export const COMMAND_INDEX = Object.freeze([
  {
    commandId: "wechat-balance",
    skill: "wechat-balance",
    script: "ops/xw-wechat-balance.mjs",
    skillScript: "ops/xw-wechat-balance.mjs",
    scoreKind: "runner",
    goalExact: [],
    goalPrefixes: ["并发只读查看01至04号机微信服务页展示的余额"],
    artifactPathPrefixes: [],
    commandOrRefExact: ["ops/xw-wechat-balance.mjs"],
    childOf: "balance",
    abandonedAfterMs: null,
    declared: { kind: "workflow", id: "workflow.wechat.balance-read.v1" },
  },
  {
    commandId: "weigou-balance",
    skill: "weigou-balance",
    script: "ops/xw-weigou-balance.mjs",
    skillScript: "ops/xw-weigou-balance.mjs",
    scoreKind: "child-step",
    goalExact: [],
    goalPrefixes: [],
    artifactPathPrefixes: [],
    commandOrRefExact: ["ops/xw-weigou-balance.mjs"],
    childOf: "balance",
    abandonedAfterMs: null,
    declared: { kind: "workflow", id: "workflow.weigou.balance-read.v1" },
  },
  {
    commandId: "messages",
    skill: "messages",
    script: "ops/xw-xhs-messages.mjs",
    skillScript: "ops/xw-xhs-messages.mjs",
    scoreKind: "runner",
    goalExact: ["小红书消息页未读只读检查（/xw messages）"],
    goalPrefixes: ["四机打开小红书消息页并查看有无新消息"],
    artifactPathPrefixes: [],
    commandOrRefExact: [],
    childOf: null,
    abandonedAfterMs: null,
    declared: { kind: "unspecified" },
  },
  {
    commandId: "xianyu-idle",
    skill: "xianyu-idle",
    script: "ops/xw-xianyu-qingdao-listing.mjs",
    skillScript: "ops/feishu-to-xianyu-idle-publish.mjs",
    scoreKind: "runner",
    goalExact: [],
    goalPrefixes: ["青岛飞书商品资料与图片上架闲鱼（发布前停页确认）", "青岛飞书商品资料与图片上架闲鱼"],
    artifactPathPrefixes: ["runtime/plans/qingdao-idle-"],
    commandOrRefExact: [],
    childOf: null,
    abandonedAfterMs: 12 * 60 * 60 * 1000,
    declared: { kind: "task-template", id: "task.xianyu.qingdao-idle-listing" },
  },
  {
    commandId: "balance",
    skill: "balance",
    script: "ops/xw-balance.mjs",
    skillScript: "ops/xw-balance.mjs",
    scoreKind: "runner",
    goalExact: [],
    goalPrefixes: ["三平台账户余额只读（单 Task、单 closeout）", "三平台账户余额只读"],
    artifactPathPrefixes: ["runtime/plans/balance-unified-"],
    commandOrRefExact: [],
    childOf: null,
    abandonedAfterMs: null,
    declared: { kind: "task-template", id: "task.balance.read-all" },
  },
  {
    commandId: "mission",
    skill: "mission",
    script: "ops/xw-mission.mjs",
    skillScript: "ops/xw-mission.mjs",
    scoreKind: "skip",
    skipScore: true,
    goalExact: [],
    goalPrefixes: [],
    artifactPathPrefixes: [],
    commandOrRefExact: [],
    childOf: null,
    declared: { kind: "tooling" },
  },
  {
    commandId: "explore",
    skill: "explore",
    script: "ops/xw-explore-session.mjs",
    skillScript: "ops/xw-explore-session.mjs",
    scoreKind: "explore_leftover",
    goalExact: [],
    goalPrefixes: [],
    artifactPathPrefixes: [],
    commandOrRefExact: [],
    childOf: null,
    declared: { kind: "tooling" },
  },
  ...["start", "skills", "task", "locator", "closeout", "evolve", "auto-adopt", "canary", "stall", "sediment-check", "ops-health"].map((id) => ({
    commandId: id,
    skill: id,
    script: id === "sediment-check" ? "ops/xw-sediment-check.mjs"
      : id === "auto-adopt" ? "ops/xw-auto-adopt.mjs"
        : id === "canary" ? "ops/xw-session-canary-noop.mjs"
          : `ops/xw-${id}.mjs`,
    skillScript: null,
    scoreKind: "skip",
    skipScore: true,
    goalExact: [],
    goalPrefixes: [],
    artifactPathPrefixes: [],
    commandOrRefExact: [],
    childOf: null,
    declared: { kind: id === "locator" ? "foundation" : "tooling", id: id === "locator" ? "locator.visual-block.v1" : null },
  })),
]);

function parseTs(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function readJsonIfExists(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function listRunDirNames(parent, cap) {
  if (!existsSync(parent)) return { ids: [], truncated: false };
  let ents;
  try {
    ents = readdirSync(parent, { withFileTypes: true });
  } catch {
    return { ids: [], truncated: false };
  }
  const dirs = ents.filter((ent) => ent.isDirectory() && HARVEST_DIR_RE.test(ent.name)).map((ent) => {
    const path = join(parent, ent.name);
    let mtimeMs = 0;
    try { mtimeMs = lstatSync(path).mtimeMs; } catch { mtimeMs = 0; }
    return { id: ent.name, mtimeMs };
  });
  dirs.sort((a, b) => {
    if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
    return b.id.localeCompare(a.id, "en", { numeric: true });
  });
  const truncated = dirs.length > cap;
  return { ids: dirs.slice(0, cap).map((item) => item.id), truncated };
}

function goalHits(goal, row) {
  if (!goal) return false;
  if ((row.goalExact || []).some((exact) => goal === exact)) return true;
  return (row.goalPrefixes || []).some((prefix) => goal.startsWith(prefix));
}

function artifactHits(closeout, row) {
  const paths = (closeout?.artifacts || []).map((item) => item?.path).filter(Boolean);
  return (row.artifactPathPrefixes || []).some((prefix) => paths.some((path) => String(path).startsWith(prefix)));
}

function stepRefHits(steps, row) {
  const refs = (steps || []).map((step) => step?.commandOrRef).filter(Boolean);
  return (row.commandOrRefExact || []).some((exact) => refs.some((ref) => ref === exact || String(ref).startsWith(exact)));
}

export function matchCommand(goal, closeout, steps) {
  for (const row of COMMAND_INDEX) {
    if (row.skipScore && row.commandId !== "wechat-balance") continue;
    if (goalHits(goal, row)) return { commandId: row.commandId, phase: "goal" };
  }
  for (const row of COMMAND_INDEX) {
    if (row.childOf) continue;
    if (row.skipScore) continue;
    if (artifactHits(closeout, row) || stepRefHits(steps, row)) return { commandId: row.commandId, phase: "fallback" };
  }
  return { commandId: "_unmapped", phase: "none" };
}

export function classifyRunResult(closeout) {
  const closure = closeout?.closure || {};
  const checks = Array.isArray(closeout?.checks) ? closeout.checks : [];
  const status = closure.status;
  if (status === "blocked" || (Array.isArray(closure.blockers) && closure.blockers.length && status !== "completed")) {
    return "blocked";
  }
  if (status === "partial" || checks.some((item) => item?.status === "fail")) return "partial";
  if (status === "unverified") return "unverified";
  if (checks.some((item) => item?.status === "unverified" || item?.status === "not_run")) return "unverified";
  if (status === "completed" && checks.length === 0) return "unverified";
  if (status === "completed" && checks.length >= 1 && checks.every((item) => item?.status === "pass")) return "success";
  if (status === "completed") return "unverified";
  return "unverified";
}

export function deriveStepDurations(steps, startedAt) {
  const rows = Array.isArray(steps) ? steps : [];
  const startMs = parseTs(startedAt);
  return rows.map((step, index) => {
    const ts = parseTs(step.ts);
    const prev = index === 0 ? startMs : parseTs(rows[index - 1].ts);
    if (ts == null || prev == null) {
      return { ...step, durationMs: null, durationSource: "missing" };
    }
    return {
      ...step,
      durationMs: Math.max(0, ts - prev),
      durationSource: "completion_minus_prev",
    };
  });
}

export function deriveRunDurationMs(startedAt, endedAt) {
  const a = parseTs(startedAt);
  const b = parseTs(endedAt);
  if (a == null || b == null) return { durationMs: null, durationSource: "missing" };
  return { durationMs: Math.max(0, b - a), durationSource: "started_ended" };
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

function rankDeclared(value) {
  const order = ["archived", "disabled", "draft", "canary_only", "candidate", "implemented", "tooling", "unspecified"];
  const i = order.indexOf(value);
  return i < 0 ? order.length : i;
}

function mapDeclaredStatus(raw) {
  if (raw === "retired") return "archived";
  return raw;
}

export function redactAmounts(value, tunables = DEFAULT_TUNABLES) {
  const keys = new Set(tunables.AMOUNT_KEY_EXACT || []);
  const walk = (node) => {
    if (typeof node === "string") return node.replace(tunables.AMOUNT_RE, "<redacted-amount>");
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      const out = {};
      for (const [key, child] of Object.entries(node)) {
        out[key] = keys.has(key) ? "<redacted-amount>" : walk(child);
      }
      return out;
    }
    return node;
  };
  return walk(value);
}

function emptyCommand(row, declared) {
  return {
    commandId: row.commandId,
    skill: `/xw ${row.skill}`,
    script: row.script,
    skillScript: row.skillScript,
    declared,
    observed: "unobserved",
    alsoFlaky: false,
    oilEligible: false,
    scoreKind: row.skipScore ? "skip" : row.scoreKind,
    counts: { samples: 0, success: 0, failLike: 0, inProgress: 0, abandoned: 0 },
    failRate: null,
    duration: { p50Ms: null, p95Ms: null, baselineP50Ms: null, multiplier: null, stalled: false },
    stall: { hits: 0, signals: [] },
    hotspots: [],
    reasons: [],
    lastRun: null,
    runs: [],
  };
}

function resolveDeclared(row, catalog) {
  const sources = [];
  let normalized = row.declared?.kind === "tooling" ? "tooling"
    : row.declared?.kind === "unspecified" ? "unspecified"
      : "unspecified";
  if (row.declared?.kind === "task-template") {
    const template = catalog.templates.find((item) => item.templateId === row.declared.id);
    if (template) {
      const status = mapDeclaredStatus(template.status);
      sources.push({ kind: "task-template", id: `${template.templateId}@${template.revision}`, status });
      normalized = status;
    }
  }
  if (row.declared?.kind === "workflow") {
    const workflow = catalog.workflows.find((item) => item.workflowId === row.declared.id);
    if (workflow) {
      const status = mapDeclaredStatus(workflow.maturity || workflow.status);
      sources.push({ kind: "workflow", id: workflow.workflowId, status: workflow.status, maturity: workflow.maturity });
      if (rankDeclared(status) < rankDeclared(normalized) || normalized === "unspecified") normalized = status;
    }
  }
  if (row.declared?.kind === "foundation") {
    sources.push({ kind: "foundation", id: row.declared.id, status: "canary_only" });
    normalized = "canary_only";
  }
  if (row.commandId === "balance") {
    const template = catalog.templates.find((item) => item.templateId === "task.balance.read-all");
    if (template) {
      const status = mapDeclaredStatus(template.status);
      sources.push({ kind: "task-template", id: `${template.templateId}@${template.revision}`, status });
      normalized = status;
    }
  }
  return { normalized, sources };
}

function scoreRunner(samples, tunables, stallHits) {
  const n = samples.length;
  const success = samples.filter((item) => item.result === "success").length;
  const failLike = samples.filter((item) => item.result !== "success" && item.result !== "in_progress").length;
  const abandoned = samples.filter((item) => item.result === "abandoned").length;
  const inProgress = samples.filter((item) => item.result === "in_progress").length;
  const failRate = n ? failLike / n : null;
  const stallHit = stallHits.length > 0;
  const successDurations = samples
    .filter((item) => item.result === "success" && Number.isFinite(item.durationMs))
    .map((item) => item.durationMs);
  const allDurations = samples.filter((item) => Number.isFinite(item.durationMs)).map((item) => item.durationMs);
  const baselineP50 = successDurations.length >= tunables.MIN_DURATION_BASELINE
    ? percentile(successDurations, 50)
    : null;
  const windowP95 = allDurations.length ? percentile(allDurations, 95) : null;
  const durationStall = baselineP50 != null && windowP95 != null
    && windowP95 >= baselineP50 * tunables.STALL_P95_MULTIPLIER;
  let observed = "unobserved";
  let alsoFlaky = false;
  const reasons = [];
  if (n + abandoned === 0) {
    observed = "unobserved";
  } else if (stallHit || durationStall) {
    observed = "stalled";
    if (failRate != null && failRate >= tunables.FLAKY_FAIL_RATE && n >= tunables.MIN_FLAKY_SAMPLES) alsoFlaky = true;
    if (stallHit) reasons.push("stall_ui_or_silence");
    if (durationStall) reasons.push("duration_p95");
    if (!durationStall && baselineP50 == null) reasons.push("duration_baseline_insufficient");
  } else if (failRate != null && failRate >= tunables.FLAKY_FAIL_RATE && n >= tunables.MIN_FLAKY_SAMPLES) {
    observed = "flaky";
  } else if (failLike >= tunables.FLAKY_MIN_FAILS_WHEN_THIN && n < tunables.MIN_HEALTHY_SAMPLES) {
    observed = "flaky";
    reasons.push("thin_sample_fails");
  } else if (n >= tunables.MIN_HEALTHY_SAMPLES && (failRate == null || failRate < tunables.FLAKY_FAIL_RATE) && !stallHit) {
    observed = "healthy";
  } else {
    observed = "unobserved";
    if (n < tunables.MIN_HEALTHY_SAMPLES) reasons.push("insufficient_samples");
  }
  return {
    observed,
    alsoFlaky,
    reasons,
    counts: { samples: n, success, failLike, inProgress, abandoned },
    failRate,
    duration: {
      p50Ms: percentile(allDurations, 50),
      p95Ms: windowP95,
      baselineP50Ms: baselineP50,
      multiplier: tunables.STALL_P95_MULTIPLIER,
      stalled: durationStall,
    },
    stall: { hits: stallHits.length, signals: stallHits },
  };
}

function classifySession(file, tunables, nowMs) {
  const name = file.name;
  const foreign = (tunables.SESSION_FOREIGN_PREFIXES || []).some((prefix) => name.toLowerCase().startsWith(prefix));
  const expiresAt = parseTs(file.expiresAt);
  const live = expiresAt != null
    ? expiresAt > nowMs
    : (nowMs - file.mtimeMs) <= tunables.EXPLORE_LIVE_MTIME_MS;
  return { ...file, foreign, live, stale: !live, exploreAttributed: !foreign };
}

export function loadOpsHealthInputs(root, {
  sessionsRoot = join(homedir(), ".xhs-explorer-sessions"),
  dbPath = join(root, "registry.db"),
  tunables = DEFAULT_TUNABLES,
  catalog = { templates: [], workflows: [] },
} = {}) {
  const harvestRoot = join(root, "outbox", "harvest");
  const workRoot = join(root, "outbox", "work");
  const harvestList = listRunDirNames(harvestRoot, tunables.SCAN_DIR_CAP);
  const harvestIds = new Set(harvestList.ids);
  const harvests = [];
  for (const id of harvestList.ids) {
    const closeout = readJsonIfExists(join(harvestRoot, id, "closeout.v1.json"));
    const task = readJsonIfExists(join(workRoot, id, "task.json"));
    const stepsPath = join(workRoot, id, "steps.jsonl");
    let steps = [];
    if (existsSync(stepsPath)) {
      try {
        steps = readFileSync(stepsPath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
      } catch {
        steps = [];
      }
    }
    const orchestration = existsSync(join(workRoot, id, "orchestration"));
    harvests.push({ runId: id, closeout, task, steps, orchestration, closed: true });
  }
  const workList = listRunDirNames(workRoot, tunables.SCAN_DIR_CAP);
  const openWork = [];
  for (const id of workList.ids) {
    if (harvestIds.has(id)) continue;
    const task = readJsonIfExists(join(workRoot, id, "task.json"));
    if (!task) continue;
    const stepsPath = join(workRoot, id, "steps.jsonl");
    let steps = [];
    if (existsSync(stepsPath)) {
      try {
        steps = readFileSync(stepsPath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
      } catch {
        steps = [];
      }
    }
    openWork.push({
      runId: id,
      closeout: null,
      task,
      steps,
      orchestration: existsSync(join(workRoot, id, "orchestration")),
      closed: false,
    });
  }
  let stall = { ok: false, source: "unavailable", rows: [] };
  try {
    if (existsSync(dbPath)) {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const rows = db.prepare(
          "SELECT queue_id, run_id, job_id, packet_json, decision_json, state FROM stall_queue ORDER BY enqueued_at DESC LIMIT ?",
        ).all(tunables.STALL_READ_LIMIT);
        stall = { ok: true, source: "sqlite_readonly", rows };
      } finally {
        db.close();
      }
    }
  } catch {
    stall = { ok: false, source: "unavailable", rows: [] };
  }
  const sessions = [];
  if (existsSync(sessionsRoot)) {
    let ents = [];
    try { ents = readdirSync(sessionsRoot, { withFileTypes: true }); } catch { ents = []; }
    for (const ent of ents) {
      if (!ent.isFile() || !ent.name.endsWith(".json")) continue;
      const path = join(sessionsRoot, ent.name);
      let raw;
      try { raw = JSON.parse(readFileSync(path, "utf8")); } catch { continue; }
      if (raw?.schemaId !== EXPLORER_SCHEMA) continue;
      delete raw.token;
      let mtimeMs = 0;
      try { mtimeMs = statSync(path).mtimeMs; } catch { mtimeMs = 0; }
      sessions.push({
        name: ent.name,
        sessionId: raw.sessionId ?? null,
        leaseId: raw.leaseId ?? null,
        actorId: raw.actorId ?? null,
        alias: raw.alias ?? null,
        expiresAt: raw.expiresAt ?? null,
        createdAt: raw.createdAt ?? null,
        mtimeMs,
      });
    }
  }
  return {
    harvests,
    openWork,
    stall,
    sessions,
    catalog,
    sources: {
      harvest: { ok: true, count: harvests.length, truncated: harvestList.truncated },
      work: { ok: true, open: openWork.length, truncated: workList.truncated },
      stall: { ok: stall.ok, source: stall.source, unmatched: 0 },
      exploreSessions: { ok: true },
      catalog: { ok: true },
    },
  };
}

export function scoreCommands(inputs, tunables, { nowMs } = {}) {
  if (!Number.isFinite(nowMs)) throw new Error("scoreCommands requires nowMs");
  const windowMs = tunables.WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const commands = COMMAND_INDEX.map((row) => emptyCommand(row, resolveDeclared(row, inputs.catalog || { templates: [], workflows: [] })));
  const byId = new Map(commands.map((item) => [item.commandId, item]));
  const unmappedRunIds = [];
  const assigned = [];

  const consider = (record) => {
    const goal = record.task?.goal || null;
    const matched = matchCommand(goal, record.closeout, record.steps);
    if (matched.commandId === "_unmapped") {
      if (record.closed) unmappedRunIds.push(record.runId);
      return;
    }
    const row = COMMAND_INDEX.find((item) => item.commandId === matched.commandId);
    if (!row || row.skipScore) return;
    assigned.push({ record, matched, row });
  };
  for (const record of inputs.harvests || []) consider(record);
  for (const record of inputs.openWork || []) consider(record);

  const samplesByCommand = new Map();
  for (const item of assigned) {
    const { record, matched, row } = item;
    if (row.childOf && matched.phase !== "goal") continue;
    const ended = parseTs(record.closeout?.endedAt);
    if (record.closed && ended != null && nowMs - ended > windowMs) continue;
    let result;
    if (!record.closed) {
      const started = parseTs(record.task?.startedAt || record.closeout?.startedAt);
      const abandonAfter = row.abandonedAfterMs ?? tunables.ABANDONED_AFTER_MS;
      result = started != null && nowMs - started >= abandonAfter ? "abandoned" : "in_progress";
    } else {
      result = classifyRunResult(record.closeout);
    }
    if (result === "in_progress") {
      const cmd = byId.get(row.commandId);
      if (cmd) cmd.counts.inProgress += 1;
      continue;
    }
    const runDur = deriveRunDurationMs(record.closeout?.startedAt || record.task?.startedAt, record.closeout?.endedAt);
    const list = samplesByCommand.get(row.commandId) || [];
    list.push({
      runId: record.runId,
      result,
      durationMs: runDur.durationMs,
      endedAt: record.closeout?.endedAt || null,
      steps: deriveStepDurations(record.steps, record.closeout?.startedAt || record.task?.startedAt),
    });
    samplesByCommand.set(row.commandId, list);

    if (matched.commandId === "balance") {
      for (const child of COMMAND_INDEX.filter((item) => item.childOf === "balance")) {
        const childSteps = (record.steps || []).filter((step) => stepRefHits([step], child));
        if (!childSteps.length) continue;
        const childList = samplesByCommand.get(child.commandId) || [];
        childList.push({
          runId: record.runId,
          result: childSteps.every((step) => step.status === "ok") ? "success" : "partial",
          durationMs: null,
          endedAt: record.closeout?.endedAt || null,
          steps: childSteps,
          child: true,
        });
        samplesByCommand.set(child.commandId, childList);
      }
    }
  }

  const stallHitsByCommand = new Map();
  const unmatchedStall = [];
  for (const row of inputs.stall?.rows || []) {
    let signal = null;
    try {
      const packet = row.packet_json ? JSON.parse(row.packet_json) : null;
      const decision = row.decision_json ? JSON.parse(row.decision_json) : null;
      signal = packet?.stallVerdict?.signalType || decision?.diagnosisCode || null;
    } catch {
      signal = null;
    }
    if (signal !== "ui_stall" && signal !== "progress_silence") continue;
    const owner = [...samplesByCommand.entries()].find(([, samples]) => samples.some((sample) => sample.runId === row.run_id));
    if (!owner) {
      unmatchedStall.push(row.run_id);
      continue;
    }
    const hits = stallHitsByCommand.get(owner[0]) || [];
    hits.push(signal);
    stallHitsByCommand.set(owner[0], hits);
  }

  for (const [commandId, samples] of samplesByCommand.entries()) {
    const windowed = samples
      .sort((a, b) => (parseTs(b.endedAt) || 0) - (parseTs(a.endedAt) || 0))
      .slice(0, tunables.WINDOW_N);
    const cmd = byId.get(commandId);
    if (!cmd || cmd.scoreKind === "skip") continue;
    const scored = scoreRunner(windowed, tunables, stallHitsByCommand.get(commandId) || []);
    Object.assign(cmd, scored, {
      lastRun: windowed[0]?.runId || null,
      runs: windowed,
    });
    cmd.oilEligible = cmd.declared.normalized === "implemented" && cmd.observed === "healthy";
  }

  const sessionClasses = (inputs.sessions || []).map((file) => classifySession(file, tunables, nowMs));
  const liveExplore = sessionClasses.filter((item) => item.live && item.exploreAttributed);
  const staleExplore = sessionClasses.filter((item) => item.stale && item.exploreAttributed);
  const liveForeign = sessionClasses.filter((item) => item.live && item.foreign);
  const staleForeign = sessionClasses.filter((item) => item.stale && item.foreign);
  const explore = byId.get("explore");
  if (explore) {
    explore.observed = "unobserved";
    explore.scoreKind = "explore_leftover";
    if (liveExplore.length) explore.reasons.push("active_or_unreleased_insufficient_cross_evidence");
    if (staleExplore.length || staleForeign.length) {
      explore.reasons.push("stale_leftover_not_scored", "insufficient_evidence");
    }
  }

  if (inputs.sources) {
    inputs.sources.exploreSessions = {
      ok: true,
      liveExplore: liveExplore.length,
      staleExplore: staleExplore.length,
      liveForeign: liveForeign.length,
      staleForeign: staleForeign.length,
      skippedNonSchema: 0,
    };
    inputs.sources.stall = {
      ok: inputs.stall?.ok === true,
      source: inputs.stall?.source || "unavailable",
      unmatched: unmatchedStall.length,
    };
  }

  return {
    schemaId: SCHEMA_ID,
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date(nowMs).toISOString(),
    window: { n: tunables.WINDOW_N, days: tunables.WINDOW_DAYS },
    tunables: { ...tunables, AMOUNT_RE: String(tunables.AMOUNT_RE) },
    sources: inputs.sources,
    commands,
    unmappedRunIds,
    sessions: { liveExplore, staleExplore, liveForeign, staleForeign },
  };
}

export function mergeTunables(overrides = {}) {
  return { ...DEFAULT_TUNABLES, ...overrides };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify({ ok: true, commands: COMMAND_INDEX.map((row) => row.commandId) }));
}
