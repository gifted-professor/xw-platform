import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "ops", "xw-task.mjs");
const TASK_NAME = "小红书多阶段检索草案";

function templateFixture() {
  return {
    schemaId: "xhs.task-template.v1",
    schemaVersion: 1,
    templateId: "task.xhs.multi-stage-search",
    revision: 1,
    name: TASK_NAME,
    aliases: ["小红书检索工作流"],
    status: "draft",
    description: "在小红书按参数完成 Explore、workflow 和 recipe 三阶段检索",
    parameterSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", prompt: "搜索词是什么？" },
      },
    },
    steps: [
      {
        id: "explore_entry",
        kind: "explore",
        intent: "探索小红书搜索入口 {{query}}",
      },
      {
        id: "known_workflow",
        kind: "workflow",
        intent: "运行已知小红书检索工作流 {{query}}",
        workflowId: "workflow.xhs.search",
        dependsOn: ["explore_entry"],
      },
      {
        id: "recipe_collect",
        kind: "recipe",
        intent: "按 recipe 收集小红书检索结果 {{query}}",
        dependsOn: ["known_workflow"],
      },
    ],
    effectPolicy: { kind: "none", confirmation: "none" },
    checkpointPolicy: { enabled: true, dedupe: true },
    originRunId: "run_xw_task_cli_fixture",
  };
}

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "xw-task-cli-"));
  const templates = join(root, "templates");
  const params = join(root, "params.input");
  // The CLI creates no directories for reads, so place the catalog in its own
  // directory and keep the params file outside its *.json scan.
  mkdirSync(templates);
  writeFileSync(
    join(templates, "task.xhs.multi-stage-search@1.json"),
    `${JSON.stringify(templateFixture(), null, 2)}\n`,
  );
  writeFileSync(params, `${JSON.stringify({ query: "新疆夏天" })}\n`);
  return { root, templates, params };
}

function runCli(args, { registryUrl, timeoutMs = 10_000 } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      env: {
        ...process.env,
        ...(registryUrl ? { XHS_REGISTRY_URL: registryUrl } : {}),
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill();
      rejectRun(new Error(`xw-task CLI timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectRun(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolveRun({ code, signal, stdout, stderr });
    });
  });
}

function parsePayload(result) {
  assert.equal(result.signal, null);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout);
}

async function startMockRegistry() {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString("utf8");
    const body = rawBody ? JSON.parse(rawBody) : null;
    requests.push({ method: request.method, path: request.url, body });

    if (request.method === "POST" && request.url === "/api/task-plans") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        ok: true,
        plan: {
          schemaId: "xhs.task-plan.v1",
          schemaVersion: 1,
          goal: body?.goal,
          resolverPath: "mock",
          modelTier: "L2",
        },
      }));
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false, error: "not found" }));
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  return {
    server,
    requests,
    url: `http://127.0.0.1:${address.port}`,
  };
}

async function closeServer(server) {
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
}

async function reserveThenReleaseUrl() {
  const server = http.createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const { port } = server.address();
  await closeServer(server);
  return `http://127.0.0.1:${port}`;
}

test("prepare is registry-independent and keeps a complete draft non-executable", async () => {
  const fixture = makeFixture();
  const registry = await startMockRegistry();
  try {
    const result = await runCli([
      "prepare",
      "--task", TASK_NAME,
      "--dir", fixture.templates,
      "--params", fixture.params,
    ], { registryUrl: registry.url });
    assert.equal(result.code, 0);
    const payload = parsePayload(result);
    assert.equal(payload.ok, true);
    assert.equal(payload.command, "prepare");
    assert.equal(payload.prepared.ready, true);
    assert.equal(payload.prepared.status, "draft");
    assert.equal(payload.prepared.executionReady, false);
    assert.equal(payload.prepared.nextAction, "review_template");
    assert.equal(registry.requests.length, 0);
  } finally {
    await closeServer(registry.server);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("plan posts every stage to Registry and returns a locator-bound live plan", async () => {
  const fixture = makeFixture();
  const registry = await startMockRegistry();
  try {
    const result = await runCli([
      "plan",
      "--task", TASK_NAME,
      "--dir", fixture.templates,
      "--params", fixture.params,
    ], { registryUrl: registry.url });
    assert.equal(result.code, 0);
    const payload = parsePayload(result);
    assert.equal(payload.ok, true);
    assert.equal(payload.prepared.executionReady, false);
    assert.equal(payload.livePlan.schemaId, "xw.task-template-live-plan.v1");
    assert.equal(payload.livePlan.executionReady, false);
    assert.equal(payload.livePlan.reason, "template_is_draft");
    assert.deepEqual(
      payload.livePlan.stagePlans.map((stage) => stage.stepId),
      ["explore_entry", "known_workflow", "recipe_collect"],
    );
    assert.equal(payload.livePlan.stagePlans.every((stage) => stage.plan.schemaId === "xhs.task-plan.v1"), true);

    assert.equal(registry.requests.length, 3);
    assert.equal(registry.requests.every((request) => request.method === "POST"), true);
    assert.equal(registry.requests.every((request) => request.path === "/api/task-plans"), true);
    assert.equal(registry.requests.every((request) => request.body?.goal?.includes("xhs")), true);

    assert.equal(payload.livePlan.foundationDependencies.length, 1);
    const [locator] = payload.livePlan.foundationDependencies;
    assert.equal(locator.capabilityId, "locator.visual-block.v1");
    assert.equal(locator.role, "locator");
    assert.equal(locator.bundled, true);
    assert.equal(locator.executionStatus, "canary_only");
    assert.deepEqual(locator.appliesToStepIds, ["explore_entry", "known_workflow", "recipe_collect"]);
  } finally {
    await closeServer(registry.server);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("plan fails closed with a nonzero exit when Registry is unreachable", async () => {
  const fixture = makeFixture();
  try {
    const unavailableRegistry = await reserveThenReleaseUrl();
    const result = await runCli([
      "plan",
      "--task", TASK_NAME,
      "--dir", fixture.templates,
      "--params", fixture.params,
    ], { registryUrl: unavailableRegistry });
    assert.notEqual(result.code, 0);
    const payload = parsePayload(result);
    assert.equal(payload.ok, false);
    assert.equal(payload.prepared.executionReady, false);
    assert.equal(payload.livePlan, null);
    assert.equal(typeof payload.livePlanError, "string");
    assert.ok(payload.livePlanError.length > 0);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("compile-workflow plans wechat balance offline as session_workflow without executionReady", async () => {
  const result = await runCli([
    "compile-workflow",
    "--goal", "每台机器读取微信余额",
    "--request-key", "fixture-xw-task-wechat-balance",
  ]);
  assert.equal(result.code, 0);
  const payload = parsePayload(result);
  assert.equal(payload.ok, true);
  assert.equal(payload.executionReady, false);
  assert.equal(payload.workflowId, "workflow.wechat.balance-read.v1");
  assert.equal(payload.plan.nodes[0].executor.kind, "session_workflow");
  assert.equal(payload.plan.execution.allowReassign, false);
  assert.equal(payload.plan.nodes[0].shards.length, 4);
  assert.deepEqual(
    payload.plan.nodes[0].shards.map((shard) => shard.placement.alias),
    ["01", "02", "03", "04"],
  );
  assert.equal(payload.paymentTransport, 0);
  assert.equal(payload.finalCommit, false);
});
