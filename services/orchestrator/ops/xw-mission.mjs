#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createTaskPlanV2, validateTaskPlanV2 } from "../scripts/lib/task-plan-v2.mjs";
import { bindTaskPlanToLiveCapabilities } from "../scripts/lib/task-plan-capability-binding.mjs";
import { OrchestrationStore } from "../scripts/lib/orchestration-store.mjs";
import { ControlPlaneHttpClient, TypedJobWorker } from "../scripts/lib/typed-job-worker.mjs";
import { MissionWorkerRouter, SessionWorkflowWorker } from "../scripts/lib/session-workflow-worker.mjs";
import { runTaskOrchestrator } from "../scripts/lib/task-orchestrator.mjs";

function option(argv, name, fallback = undefined) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
}

function flag(argv, name) {
  return argv.includes(name);
}

function required(argv, name) {
  const value = option(argv, name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

async function fetchJson(url, { timeoutMs = 10000 } = {}) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const result = await response.json();
  if (!response.ok || result?.ok === false) throw new Error(result?.error?.message || result?.error || `request failed ${response.status}`);
  return result;
}

function parseAgentEntry(markdown) {
  const devices = [];
  for (const line of String(markdown).split(/\r?\n/)) {
    const match = line.match(/^- (0[1-4]) \| online=(yes|no) \| ready=(yes|no).*?\| lease=([^ |]+).*?\| quarantined=(yes|no).*?\| unresolvedFailure=([^ |]+)/);
    if (!match) continue;
    devices.push({
      alias: match[1],
      online: match[2] === "yes",
      ready: match[3] === "yes",
      lease: match[4],
      quarantined: match[5] === "yes",
      unresolvedFailure: match[6] === "none" ? null : match[6],
    });
  }
  if (devices.length === 0) throw new Error("live agent-entry did not expose device occupancy");
  return devices;
}

export async function loadLiveFleet({ registryUrl = "http://127.0.0.1:17930/", timeoutMs = 10000 } = {}) {
  const [entryResponse, catalog] = await Promise.all([
    fetch(new URL("agent-entry.md", registryUrl), { signal: AbortSignal.timeout(timeoutMs) }),
    fetchJson(new URL("api/capabilities", registryUrl), { timeoutMs }),
  ]);
  if (!entryResponse.ok) throw new Error(`agent-entry unavailable (${entryResponse.status})`);
  const devices = parseAgentEntry(await entryResponse.text());
  const safeCapabilities = new Set((catalog.capabilities || [])
    .filter((capability) => capability.policy?.availability === "implemented")
    .filter((capability) => capability.policy?.runnableAsJob === true)
    .filter((capability) => capability.policy?.externalEffect === false)
    .filter((capability) => capability.policy?.approvalRequired === false)
    .filter((capability) => ["read_only", "replay_safe"].includes(capability.idempotency))
    .map((capability) => capability.id));
  for (const device of devices) {
    device.capabilityIds = [...(catalog.routingByAlias?.[device.alias]?.capabilityIds || [])].filter((id) => safeCapabilities.has(id));
    // Session workflows always enter via Explorer primitive; include it for ready/free devices
    // even when routing matrix does not list it as a runnable job capability.
    if (device.online && device.ready && device.lease === "free" && !device.quarantined && !device.unresolvedFailure) {
      if (!device.capabilityIds.includes("xiaowei.explorer.primitive")) {
        device.capabilityIds.push("xiaowei.explorer.primitive");
      }
    }
  }
  return devices;
}

function usage() {
  return `xw-mission — Foundation recommended Agent Runtime entry

  create   --input <plan-authoring.json>
  validate --plan <plan.v2.json>          # local raw schema only
  bind     --plan <plan.v2.json> [--registry-url ...]
           # Raw Plan → ExecutionPlan via live Catalog (no authorization)
  preflight (--plan <plan.v2.json> | --input <plan-authoring.json>) [--actor <actor>]
           # validate + bind + fleet eligibility (advisory)
  run      (--plan <plan.v2.json> | --input <plan-authoring.json>) --run <closeout-run-id> --actor <actor> --execute
  status   --run <closeout-run-id>

run refuses to submit jobs unless --execute is explicit.
Foundation: bind is required before preflight/run; Scheduler only sees raw plan work units after bind succeeds.
session_workflow actions come from catalog only (no params.actions injection).`;
}

async function loadCapabilityCatalog(registryUrl) {
  const result = await fetchJson(new URL("api/capabilities", registryUrl));
  return result.capabilities || [];
}

async function loadAndBindPlan({ planPath, inputPath, registryUrl, requireBind = true }) {
  if (!planPath && !inputPath) throw new Error("--plan or --input is required");
  if (planPath && inputPath) throw new Error("use only one of --plan or --input");
  const plan = planPath ? readJson(planPath) : createTaskPlanV2(readJson(inputPath));
  const errors = validateTaskPlanV2(plan);
  if (errors.length) {
    const err = new Error(`invalid plan: ${JSON.stringify(errors)}`);
    err.code = "TASK_PLAN_SCHEMA_INVALID";
    err.details = errors;
    throw err;
  }
  if (!requireBind) return { plan, executionPlan: null, executionPlanHash: null };
  const catalog = await loadCapabilityCatalog(registryUrl);
  const bound = bindTaskPlanToLiveCapabilities(plan, catalog);
  return { plan, ...bound };
}

async function main(argv = process.argv.slice(2)) {
  const command = argv[0];
  if (!command || ["help", "--help", "-h"].includes(command)) {
    console.log(usage());
    return;
  }

  if (command === "create") {
    const input = readJson(required(argv, "--input"));
    const plan = createTaskPlanV2(input);
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  if (command === "validate") {
    const planPath = option(argv, "--plan");
    const inputPath = option(argv, "--input");
    if (!planPath && !inputPath) throw new Error("--plan or --input is required");
    if (planPath && inputPath) throw new Error("use only one of --plan or --input");
    const plan = planPath ? readJson(planPath) : createTaskPlanV2(readJson(inputPath));
    const errors = validateTaskPlanV2(plan);
    console.log(JSON.stringify({ ok: errors.length === 0, errors, note: "local raw schema only; use bind for live contracts" }, null, 2));
    if (errors.length) process.exitCode = 1;
    return;
  }

  if (command === "bind") {
    const registryUrl = option(argv, "--registry-url", "http://127.0.0.1:17930/");
    const bound = await loadAndBindPlan({
      planPath: option(argv, "--plan"),
      inputPath: option(argv, "--input"),
      registryUrl,
      requireBind: true,
    });
    console.log(JSON.stringify({
      ok: true,
      schemaId: bound.executionPlan.schemaId,
      executionPlanHash: bound.executionPlanHash,
      constraints: bound.executionPlan.constraints,
      nodes: bound.executionPlan.nodes,
      warnings: bound.warnings || [],
      note: "ExecutionPlan is not authorization; Control Plane decides allow/block/wait on submit",
    }, null, 2));
    return;
  }

  if (command === "preflight") {
    const registryUrl = option(argv, "--registry-url", "http://127.0.0.1:17930/");
    const { plan, executionPlan, executionPlanHash } = await loadAndBindPlan({
      planPath: option(argv, "--plan"),
      inputPath: option(argv, "--input"),
      registryUrl,
      requireBind: true,
    });
    const devices = await loadLiveFleet({ registryUrl });
    const workUnits = plan.nodes.flatMap((node) => node.shards.map((shard) => {
      const allowed = new Set(shard.placement.eligibleAliases || []);
      const aliases = devices
        .filter((device) => device.online && device.ready && device.lease === "free" && !device.quarantined && !device.unresolvedFailure)
        .filter((device) => device.capabilityIds.includes(node.executor.capabilityId))
        .filter((device) => !shard.placement.alias || device.alias === shard.placement.alias)
        .filter((device) => allowed.size === 0 || allowed.has(device.alias))
        .map((device) => device.alias);
      const boundNode = executionPlan.nodes.find((n) => n.nodeId === node.nodeId);
      return {
        nodeId: node.nodeId,
        shardId: shard.shardId,
        capabilityId: node.executor.capabilityId,
        capabilityContractHash: boundNode?.capabilityContractHash || null,
        placementConstraint: boundNode?.placementConstraint || null,
        catalogEligibleAliases: aliases,
      };
    }));
    console.log(JSON.stringify({
      ok: workUnits.every((unit) => unit.catalogEligibleAliases.length > 0),
      executionPlanHash,
      note: "bind + catalog eligibility are advisory; Control Plane route/job remain authoritative",
      devices: devices.map(({ capabilityIds, ...device }) => ({ ...device, safeCapabilityCount: capabilityIds.length })),
      workUnits,
    }, null, 2));
    if (workUnits.some((unit) => unit.catalogEligibleAliases.length === 0)) process.exitCode = 2;
    return;
  }

  if (command === "status") {
    const taskRunId = required(argv, "--run");
    const store = new OrchestrationStore({ taskRunId });
    if (!existsSync(store.statePath)) throw new Error("orchestration state not found for explicit runId");
    const state = readJson(store.statePath);
    const result = existsSync(store.resultPath) ? readJson(store.resultPath) : null;
    console.log(JSON.stringify({ ok: true, state, result }, null, 2));
    return;
  }

  if (command === "run") {
    if (!flag(argv, "--execute")) throw new Error("--execute is required; plan validation alone never submits jobs");
    const taskRunId = required(argv, "--run");
    const actorId = required(argv, "--actor");
    const taskPath = join("C:\\Users\\Public\\xhs-registry\\outbox\\work", taskRunId, "task.json");
    if (!existsSync(taskPath)) throw new Error("explicit runId is not an active xw closeout run");
    const registryUrl = option(argv, "--registry-url", "http://127.0.0.1:17930/");
    // Foundation: bind live contracts before Scheduler; ExecutionPlan is not authorization.
    const { plan, executionPlan, executionPlanHash } = await loadAndBindPlan({
      planPath: option(argv, "--plan"),
      inputPath: option(argv, "--input"),
      registryUrl,
      requireBind: true,
    });
    const client = new ControlPlaneHttpClient({ baseUrl: option(argv, "--control-url", "http://127.0.0.1:17920/") });
    const pollMs = Number(option(argv, "--poll-ms", 1000));
    const typedJobWorker = new TypedJobWorker({ client, actorId, pollMs });
    const sessionWorkflowWorker = new SessionWorkflowWorker({ client, actorId, pollMs: 0 });
    const worker = new MissionWorkerRouter({ typedJobWorker, sessionWorkflowWorker });
    const store = new OrchestrationStore({ taskRunId });
    const result = await runTaskOrchestrator({
      taskRunId,
      plan,
      executionPlan,
      executionPlanHash,
      fleetProvider: () => loadLiveFleet({ registryUrl }),
      worker,
      store,
    });
    console.log(JSON.stringify({ ...result, executionPlanHash }, null, 2));
    if (result.status !== "completed") process.exitCode = 2;
    return;
  }

  throw new Error(`unknown command ${command}`);
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: { code: error?.code || "XW_MISSION_FAILED", message: error?.message || String(error) } }, null, 2));
  process.exit(1);
});
