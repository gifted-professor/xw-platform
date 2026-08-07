#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DEFAULT_TASK_TEMPLATE_DIR,
  loadTaskTemplates,
  matchTaskTemplate,
  resolveTaskTemplate,
  saveTaskTemplate,
  validateTaskTemplate,
} from "../scripts/lib/task-template.mjs";
import { createTaskPlanV2 } from "../scripts/lib/task-plan-v2.mjs";
import {
  compileWorkflowNodeAuthoring,
  getWorkflow,
  loadWorkflows,
  workflowIsDirectlyRunnable,
} from "../scripts/lib/workflow-catalog.mjs";

const REGISTRY = (process.env.XHS_REGISTRY_URL || "http://127.0.0.1:17930").replace(/\/$/, "");

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--") && argv[i + 1] && !argv[i + 1].startsWith("--")) out[arg.slice(2)] = argv[++i];
    else if (arg.startsWith("--")) out[arg.slice(2)] = true;
    else out._.push(arg);
  }
  return out;
}

function fail(message) {
  console.log(`XW_TASK_FAILED ${message}`);
  process.exit(2);
}

function readJson(path, label) {
  if (!path || !existsSync(path)) fail(`${label} not found: ${path || "<missing>"}`);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`${label} is invalid JSON: ${error.message}`);
  }
}

function catalog(args) {
  const dir = resolve(args.dir || DEFAULT_TASK_TEMPLATE_DIR);
  const loaded = loadTaskTemplates({ dir, includeAll: Boolean(args.all) });
  if (loaded.errors.length) fail(`template catalog invalid: ${loaded.errors.map((item) => `${item.file}:${item.message}`).join("; ")}`);
  return { dir, templates: loaded.templates };
}

function findTemplate(args) {
  const query = args.task || args.name || args._.slice(1).join(" ");
  if (!query) fail("missing --task <name-or-id>");
  const loaded = catalog(args);
  const matched = matchTaskTemplate(loaded.templates, query);
  if (matched.ambiguous.length) fail(`task is ambiguous: ${matched.ambiguous.map((item) => item.name).join(", ")}`);
  if (!matched.match) fail(`task template not found: ${query}`);
  return { ...loaded, template: matched.match };
}

async function fetchLiveTaskPlan(goal) {
  const response = await globalThis.fetch(`${REGISTRY}/api/task-plans`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ goal }),
  });
  let payload = null;
  try { payload = await response.json(); } catch { /* handled below */ }
  if (!response.ok || !payload?.ok || !payload?.plan) {
    throw new Error(`live TaskPlan unavailable: HTTP ${response.status}${payload?.error ? ` — ${payload.error}` : ""}`);
  }
  return payload.plan;
}

async function buildLiveTemplatePlan(prepared) {
  if (!prepared.ready) {
    return {
      schemaId: "xw.task-template-live-plan.v1",
      executionReady: false,
      reason: "parameters_incomplete",
      stagePlans: [],
      foundationDependencies: [],
      unresolvedDependencies: [],
    };
  }
  const stagePlans = await Promise.all(prepared.steps.map(async (step) => {
    const goal = [prepared.targetApp, step.intent, step.workflowId].filter(Boolean).join(" ");
    return {
      stepId: step.id,
      kind: step.kind,
      plan: await fetchLiveTaskPlan(goal),
    };
  }));
  return {
    schemaId: "xw.task-template-live-plan.v1",
    generatedAt: new Date().toISOString(),
    source: `${REGISTRY}/api/task-plans`,
    templateId: prepared.templateId,
    revision: prepared.revision,
    targetApp: prepared.targetApp,
    executionReady: false,
    reason: prepared.status === "draft" ? "template_is_draft" : "task_executor_binding_required",
    stagePlans,
    foundationDependencies: prepared.foundationDependencies,
    unresolvedDependencies: prepared.unresolvedDependencies,
    locatorPolicy: prepared.locatorPolicy,
  };
}

function matchWorkflowByGoal(goal) {
  const text = String(goal || "").trim().toLowerCase();
  if (!text) return { match: null, ambiguous: [] };
  const workflows = loadWorkflows();
  const scored = [];
  for (const workflow of workflows) {
    const aliases = [workflow.workflowId, workflow.title, ...(workflow.intentAliases || [])]
      .filter(Boolean)
      .map((item) => String(item).toLowerCase());
    if (aliases.some((alias) => text.includes(alias) || alias.includes(text))) {
      scored.push(workflow);
    }
  }
  if (scored.length === 1) return { match: scored[0], ambiguous: [] };
  if (scored.length > 1) return { match: null, ambiguous: scored };
  // Chinese shorthand: 微信 + 余额/零钱
  if ((/微信|wechat/.test(text)) && (/余额|零钱|balance|wallet/.test(text))) {
    const balance = getWorkflow("workflow.wechat.balance-read.v1");
    if (balance) return { match: balance, ambiguous: [] };
  }
  return { match: null, ambiguous: [] };
}

function compileWorkflowPlan({ goal, workflowId = null, aliases = null, requestKey = null }) {
  const workflow = workflowId
    ? getWorkflow(workflowId)
    : matchWorkflowByGoal(goal).match;
  if (!workflow) {
    const matched = matchWorkflowByGoal(goal);
    if (matched.ambiguous.length) {
      return {
        ok: false,
        executionReady: false,
        reason: "workflow_ambiguous",
        candidates: matched.ambiguous.map((item) => item.workflowId),
      };
    }
    return {
      ok: false,
      executionReady: false,
      reason: "workflow_not_matched",
      goal,
    };
  }
  const node = compileWorkflowNodeAuthoring(workflow, {
    nodeId: workflow.workflowId.replace(/[^a-zA-Z0-9._-]/g, "_"),
    ...(aliases ? { aliases } : {}),
  });
  const plan = createTaskPlanV2({
    goal: String(goal || workflow.title).trim(),
    requestKey: requestKey || `xw-task-workflow:${workflow.workflowId}:${Date.now()}`,
    execution: { maxWorkers: 4, allowReassign: false, maxAttemptsPerShard: 2 },
    nodes: [node],
  });
  const direct = workflowIsDirectlyRunnable(workflow);
  // Runtime session_workflow fan-out is implemented offline, but catalog is still canary_only.
  // Never claim production executionReady until maturity=implemented and live gates pass.
  return {
    ok: true,
    executionReady: false,
    reason: direct
      ? "live_device_gate_required"
      : `workflow_maturity_${workflow.maturity}_not_production`,
    workflowId: workflow.workflowId,
    maturity: workflow.maturity,
    status: workflow.status,
    tapAuthorized: workflow.tapAuthorized === true,
    paymentTransport: workflow.acceptance?.paymentTransport ?? 0,
    finalCommit: workflow.acceptance?.finalCommit ?? false,
    note: "plan is offline-safe; begin/run requires explicit xw-mission --execute after canary authorization",
    plan,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || "list";
  if (command === "list") {
    const loaded = catalog(args);
    console.log(JSON.stringify({ ok: true, command, count: loaded.templates.length, templates: loaded.templates.map((item) => ({ templateId: item.templateId, revision: item.revision, name: item.name, aliases: item.aliases, status: item.status })) }, null, 2));
    return;
  }
  if (command === "show") {
    const found = findTemplate(args);
    console.log(JSON.stringify({ ok: true, command, template: found.template }, null, 2));
    return;
  }
  if (command === "prepare") {
    const found = findTemplate(args);
    const params = args.params ? readJson(resolve(args.params), "params") : {};
    const prepared = resolveTaskTemplate(found.template, params);
    console.log(JSON.stringify({ ok: prepared.ok, command, prepared }, null, 2));
    if (!prepared.ok || prepared.invalid.length) process.exitCode = 3;
    return;
  }
  if (command === "plan") {
    const found = findTemplate(args);
    const params = args.params ? readJson(resolve(args.params), "params") : {};
    const prepared = resolveTaskTemplate(found.template, params);
    let livePlan = null;
    let livePlanError = null;
    if (prepared.ok && prepared.ready) {
      try {
        livePlan = await buildLiveTemplatePlan(prepared);
      } catch (error) {
        livePlanError = String(error?.message || error);
      }
    } else {
      livePlan = await buildLiveTemplatePlan(prepared);
    }
    const ok = prepared.ok && !prepared.invalid.length && !livePlanError;
    console.log(JSON.stringify({ ok, command, prepared, livePlan, livePlanError }, null, 2));
    if (!ok) process.exitCode = 3;
    return;
  }
  if (command === "validate") {
    const input = readJson(resolve(args.input || ""), "template input");
    const errors = validateTaskTemplate(input);
    console.log(JSON.stringify({ ok: errors.length === 0, command, errors }, null, 2));
    if (errors.length) process.exitCode = 3;
    return;
  }
  if (command === "save") {
    const input = readJson(resolve(args.input || ""), "template input");
    const saved = saveTaskTemplate(input, { dir: resolve(args.dir || DEFAULT_TASK_TEMPLATE_DIR) });
    console.log(JSON.stringify({ ok: true, command, result: saved.result, path: saved.path, templateId: saved.template.templateId, revision: saved.template.revision, descriptorHash: saved.template.descriptorHash }, null, 2));
    return;
  }
  if (command === "compile-workflow" || command === "plan-workflow") {
    // Offline: natural language / workflowId → TaskPlan v2 (session_workflow). Never touches devices.
    const goal = args.goal || args.task || args._.slice(1).join(" ");
    const workflowId = args.workflow || args["workflow-id"] || null;
    const aliases = args.aliases
      ? String(args.aliases).split(/[,:\s]+/).filter(Boolean)
      : null;
    const compiled = compileWorkflowPlan({
      goal: goal || workflowId || "",
      workflowId,
      aliases,
      requestKey: args["request-key"] || null,
    });
    console.log(JSON.stringify({
      ok: compiled.ok,
      command,
      ...compiled,
    }, null, 2));
    if (!compiled.ok) process.exitCode = 3;
    return;
  }
  fail("usage: xw-task.mjs list|show|prepare|plan|compile-workflow|validate|save");
}

main().catch((error) => fail(error?.message || String(error)));
