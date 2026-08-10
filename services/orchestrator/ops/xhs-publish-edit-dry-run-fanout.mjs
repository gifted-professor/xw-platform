#!/usr/bin/env node
/**
 * Fan-out formal xhs.publish.edit_dry_run / xhs.publish.discard_editor jobs (Windows local).
 *
 *   node ops/xhs-publish-edit-dry-run-fanout.mjs --aliases 02,03,04 --title 标题 --body 正文 --tags Adidas,百搭 --stay
 *   node ops/xhs-publish-edit-dry-run-fanout.mjs --aliases 02,03,04 --discard
 *   node ops/xhs-publish-edit-dry-run-fanout.mjs --dry-run --aliases 01,02,03,04 --caption 测试
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const CONTROL = (process.env.XHS_CONTROL_URL || "http://127.0.0.1:17920").replace(/\/$/, "");
const REGISTRY = (process.env.XHS_REGISTRY_URL || "http://127.0.0.1:17930").replace(/\/$/, "");

const argv = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
};
const flag = (name) => argv.includes(name);

if (flag("--help") || flag("-h")) {
  console.log(`用法:
  node ops/xhs-publish-edit-dry-run-fanout.mjs --aliases 01,02,03,04 [--title 标题] [--body 正文] [--caption 正文] [--tags tag1,tag2] [--stay] [--discard] [--actor ID] [--dry-run] [--json]

  --title     发布标题（可选，≤20字）
  --body      发布正文（与 --caption 二选一/同义，至少填 title 或 body 之一）
  --caption   已废弃别名，等同 --body
  --tags      话题数组，逗号分隔，不含 #（如 Adidas,百搭,标题）

  --stay      提交 xhs.publish.edit_dry_run 且 stayForAccept=true（停编辑页验收）
  --discard   提交 xhs.publish.discard_editor（验收后退出不存草稿）
  默认        提交 xhs.publish.edit_dry_run 完整 dry-run（自动退出不存草稿）

  actor 默认读取 control /health 的 pilotActors（pilotOnly 单 actor 时自动选用）`);
  process.exit(0);
}

const ALIASES = (opt("--aliases", "01,02,03,04") || "01,02,03,04")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const TITLE = opt("--title", "");
const BODY = opt("--body", opt("--caption", "测试"));
const TAGS = (opt("--tags", "") || "")
  .split(/[,，]/)
  .map((value) => value.trim().replace(/^#+/, ""))
  .filter(Boolean);
const STAY = flag("--stay");
const DISCARD = flag("--discard");
const DRY = flag("--dry-run");
const JSON_OUT = flag("--json");
const TIMEOUT_S = Number(opt("--timeout-s", DISCARD ? "120" : "240")) || (DISCARD ? 120 : 240);
const POLL_S = Number(opt("--poll-s", "5")) || 5;
const CAPABILITY = DISCARD ? "xhs.publish.discard_editor" : "xhs.publish.edit_dry_run";
const TS = Date.now();

async function fetchJson(url, { method = "GET", body = null, timeoutMs = 60000 } = {}) {
  const response = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`invalid JSON from ${url}: ${text.slice(0, 240)}`);
  }
  if (!response.ok || data?.ok === false) {
    throw new Error(data?.error?.message || data?.error || `request failed ${response.status}`);
  }
  return data;
}

function chooseActor(explicit, controlHealth) {
  if (explicit) return explicit;
  const actors = controlHealth?.policyMode?.pilotActors || [];
  if (controlHealth?.policyMode?.pilotOnly === true && actors.length === 1) return actors[0];
  return null;
}

function parseAgentEntryDevices(markdown) {
  const rows = [];
  for (const line of String(markdown).split(/\r?\n/)) {
    const match = line.match(/^- (0[1-4]) \| online=(yes|no) \| ready=(yes|no).*?\| lease=([^ |]+).*?\| quarantined=(yes|no).*?\| unresolvedFailure=([^ |]+)/);
    if (!match) continue;
    rows.push({
      alias: match[1],
      online: match[2] === "yes",
      ready: match[3] === "yes",
      lease: match[4],
      quarantined: match[5] === "yes",
      unresolvedFailure: match[6] === "none" ? null : match[6],
    });
  }
  return rows;
}

function buildPublishParams() {
  const title = String(TITLE || "").trim();
  const body = String(BODY || "").trim();
  const params = { ...(STAY ? { stayForAccept: true } : {}) };
  if (title) params.title = title;
  if (body) params.body = body;
  if (TAGS.length) params.tags = TAGS;
  return params;
}

async function preflight() {
  const [entryText, controlDevices, controlHealth] = await Promise.all([
    fetch(`${REGISTRY}/agent-entry.md`, { signal: AbortSignal.timeout(60000) }).then((r) => r.text()),
    fetchJson(`${CONTROL}/control/v1/devices`),
    fetchJson(`${CONTROL}/control/v1/health`),
  ]);
  const entryRows = parseAgentEntryDevices(entryText);
  const byAlias = new Map((controlDevices.devices || []).map((device) => [String(device.alias), device]));
  const problems = [];
  const rows = [];
  for (const alias of ALIASES) {
    const entry = entryRows.find((row) => row.alias === alias);
    const control = byAlias.get(alias);
    if (!entry || !control?.deviceId) {
      problems.push(`${alias}: missing device mapping`);
      continue;
    }
    if (entry.ready !== true) problems.push(`${alias}: ready=no`);
    if (entry.lease !== "free") problems.push(`${alias}: lease=${entry.lease}`);
    if (entry.quarantined) problems.push(`${alias}: quarantined`);
    if (entry.unresolvedFailure) problems.push(`${alias}: unresolvedFailure=${entry.unresolvedFailure}`);
    if (!entry.online) problems.push(`${alias}: offline`);
    rows.push({ alias, deviceId: control.deviceId, physicalLabel: control.physicalLabel || null });
  }
  const actor = chooseActor(opt("--actor"), controlHealth);
  if (!actor) problems.push("pilot actor unresolved; pass --actor explicitly");
  if (!DISCARD && !String(TITLE || "").trim() && !String(BODY || "").trim()) {
    problems.push("title or body required unless --discard");
  }
  return { rows, problems, actor, controlHealth };
}

async function routePlan(alias, deviceId, physicalLabel, actor, params) {
  return fetchJson(`${CONTROL}/control/v1/routes/plan`, {
    method: "POST",
    body: {
      actorId: actor,
      capabilityId: CAPABILITY,
      params,
      canary: false,
      placement: physicalLabel ? { alias, physicalLabel } : { alias },
    },
  });
}

async function submitOne(row, actor, params) {
  const route = await routePlan(row.alias, row.deviceId, row.physicalLabel, actor, params);
  if (route?.route?.decision !== "dispatchable" || route?.route?.authorization?.decision !== "allow") {
    throw new Error(`${row.alias}: route blocked (${route?.route?.decision || "unknown"})`);
  }
  const submission = await fetchJson(`${CONTROL}/control/v1/jobs`, {
    method: "POST",
    body: {
      actorId: actor,
      capabilityId: CAPABILITY,
      params,
      canary: false,
      placement: row.physicalLabel ? { alias: row.alias, physicalLabel: row.physicalLabel } : { alias: row.alias },
      idempotencyKey: `xhs-pub-fanout-${row.alias}-${TS}-${randomUUID().slice(0, 8)}`,
    },
  });
  const job = submission.job;
  if (!job?.jobId) throw new Error(`${row.alias}: submit missing jobId`);
  return { alias: row.alias, jobId: job.jobId, runId: job.runId || null, status: job.status || "queued" };
}

function terminal(status) {
  return ["succeeded", "failed", "recovery_required", "cancelled", "denied", "ambiguous"].includes(status);
}

function summarize(job) {
  const result = job.result || {};
  const output = result.output || {};
  return {
    status: job.status,
    step: output.step || result.step || null,
    awaitingAccept: output.awaitingAccept === true,
    restored: output.restored === true || result.restoration?.ok === true,
    verificationOk: result.verification?.ok !== false,
    errorCode: job.errorCode || null,
  };
}

async function pollJobs(jobs) {
  const deadline = Date.now() + TIMEOUT_S * 1000;
  const state = new Map(jobs.map((job) => [job.alias, { ...job, summary: null }]));
  while (Date.now() < deadline) {
    let pending = 0;
    for (const [alias, entry] of state) {
      const payload = await fetchJson(`${CONTROL}/control/v1/jobs/${encodeURIComponent(entry.jobId)}`);
      const job = payload.job || payload;
      const summary = summarize(job);
      state.set(alias, { ...entry, status: job.status, summary });
      if (!terminal(job.status)) pending += 1;
    }
    if (pending === 0) break;
    await new Promise((resolve) => setTimeout(resolve, POLL_S * 1000));
  }
  return [...state.values()];
}

async function main() {
  const pre = await preflight();
  const params = DISCARD ? {} : buildPublishParams();

  if (pre.problems.length) {
    const message = { ok: false, step: "preflight_failed", problems: pre.problems };
    if (JSON_OUT) console.log(JSON.stringify(message, null, 2));
    else {
      console.log("XHS_PUBLISH_FANOUT=preflight_failed");
      for (const problem of pre.problems) console.log(`PROBLEM=${problem}`);
    }
    process.exit(2);
  }

  if (DRY) {
    const plan = {
      ok: true,
      dryRun: true,
      actor: pre.actor,
      capability: CAPABILITY,
      aliases: ALIASES,
      params,
    };
    console.log(JSON_OUT ? JSON.stringify(plan, null, 2) : [
      "XHS_PUBLISH_FANOUT=dry_run",
      `ACTOR=${pre.actor}`,
      `CAPABILITY=${CAPABILITY}`,
      `ALIASES=${ALIASES.join(",")}`,
      `PARAMS=${JSON.stringify(params)}`,
    ].join("\n"));
    process.exit(0);
  }

  const submitted = [];
  for (const row of pre.rows) {
    submitted.push(await submitOne(row, pre.actor, params));
  }

  const results = await pollJobs(submitted);
  const okCount = results.filter((item) => item.status === "succeeded" && item.summary?.verificationOk !== false).length;
  const allOk = okCount === results.length;
  const out = {
    ok: allOk,
    actor: pre.actor,
    capability: CAPABILITY,
    params,
    results,
    okCount,
    total: results.length,
  };

  try {
    const logDir = join(ROOT, "outbox", "work", `xhs-pub-fanout-${TS}`);
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, "result.json"), `${JSON.stringify(out, null, 2)}\n`, "utf8");
    out.logDir = logDir;
  } catch { /* ignore */ }

  if (JSON_OUT) console.log(JSON.stringify(out, null, 2));
  else {
    console.log(`XHS_PUBLISH_FANOUT=${allOk ? "ok" : "partial"}`);
    console.log(`ACTOR=${pre.actor}`);
    console.log(`CAPABILITY=${CAPABILITY}`);
    for (const item of results) {
      console.log(`ALIAS=${item.alias} jobId=${item.jobId} status=${item.status} step=${item.summary?.step || ""} awaitingAccept=${item.summary?.awaitingAccept ? "yes" : "no"}`);
    }
  }
  process.exit(allOk ? 0 : 1);
}

main().catch((error) => {
  console.log(`XHS_PUBLISH_FANOUT=error`);
  console.log(`REASON=${String(error.message || error).slice(0, 300)}`);
  process.exit(4);
});
