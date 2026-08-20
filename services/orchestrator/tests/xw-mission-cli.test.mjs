import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { loadLiveFleet, reconcileLiveCapabilityCatalog } from "../ops/xw-mission.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const CLI = join(ROOT, "ops", "xw-mission.mjs");
const AUTHORING = join(ROOT, "tests", "fixtures", "task-plan-v2-authoring.json");

test("xw-mission create and validate are local-only", () => {
  const temp = mkdtempSync(join(tmpdir(), "xw-mission-cli-"));
  try {
    const stdout = execFileSync(process.execPath, [CLI, "create", "--input", AUTHORING], { encoding: "utf8", windowsHide: true });
    const plan = JSON.parse(stdout);
    assert.equal(plan.schemaId, "xhs.task-plan.v2");
    assert.equal(plan.nodes[0].shards.length, 4);
    const planPath = join(temp, "plan.json");
    writeFileSync(planPath, stdout, "utf8");
    const validated = JSON.parse(execFileSync(process.execPath, [CLI, "validate", "--plan", planPath], { encoding: "utf8", windowsHide: true }));
    assert.equal(validated.ok, true);
    assert.match(validated.note || "", /raw schema only/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("xw-mission bind requires live catalog and rejects unknown capability", () => {
  const temp = mkdtempSync(join(tmpdir(), "xw-mission-bind-"));
  try {
    const stdout = execFileSync(process.execPath, [CLI, "create", "--input", AUTHORING], { encoding: "utf8", windowsHide: true });
    const planPath = join(temp, "plan.json");
    writeFileSync(planPath, stdout, "utf8");
    // No registry → bind fails closed (network error or empty catalog mismatch)
    const result = spawnSync(process.execPath, [CLI, "bind", "--plan", planPath, "--registry-url", "http://127.0.0.1:1/"], {
      encoding: "utf8",
      windowsHide: true,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /XW_MISSION_FAILED|fetch|ECONNREFUSED|NO_EXECUTOR|failed/i);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("xw-mission run refuses device submission without explicit --execute", () => {
  const result = spawnSync(process.execPath, [CLI, "run", "--plan", AUTHORING, "--run", "run_fixture", "--actor", "fixture"], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--execute is required/);
});

test("xw-mission plan-goal is a strict zero-state dry-run", () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "xw-mission-m5-dry-"));
  try {
    const stdout = execFileSync(process.execPath, [
      CLI,
      "plan-goal",
      "--goal", "四台机器各刷一次首页并汇总卡片数",
      "--aliases", "01,02,03,04",
      "--trace-id", "trace-mission-dry",
      "--dry-run",
    ], {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, XW_RUNTIME_ROOT: runtimeRoot },
    });
    const payload = JSON.parse(stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.dryRun, true);
    assert.equal(payload.dag.nodes.filter(({ skillId }) => skillId === "xhs.observe.feed").length, 4);
    assert.equal(existsSync(join(runtimeRoot, "state", "orchestrator", "trace")), false);
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("xw-mission status resolves orchestration state from XW_RUNTIME_ROOT", () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "xw-mission-m5-status-"));
  try {
    const stateRoot = join(runtimeRoot, "state", "orchestrator", "outbox", "work", "run_env_fixture", "orchestration");
    mkdirSync(stateRoot, { recursive: true });
    writeFileSync(join(stateRoot, "state.v1.json"), `${JSON.stringify({ status: "completed", source: "env-root" })}\n`, "utf8");
    const stdout = execFileSync(process.execPath, [CLI, "status", "--run", "run_env_fixture"], {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, XW_RUNTIME_ROOT: runtimeRoot },
    });
    const payload = JSON.parse(stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.state.source, "env-root");
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("live fleet uses current implementationSupport while keeping authorization in Control Plane", async () => {
  const server = (await import("node:http")).createServer((request, response) => {
    response.setHeader("content-type", request.url === "/agent-entry.md" ? "text/markdown" : "application/json");
    if (request.url === "/agent-entry.md") {
      response.end("- 01 | online=yes | ready=yes | lease=free | quarantined=no | unresolvedFailure=none\n");
      return;
    }
    response.end(JSON.stringify({
      capabilities: [
        {
          id: "xhs.observe.feed",
          idempotency: "read_only",
          normalizedEffect: { class: "none" },
          policy: { availability: "implemented", runnableAsJob: null, approvalRequired: null, implementationSupport: { job: true } },
        },
        {
          id: "xhs.comment.send",
          idempotency: "replay_safe",
          normalizedEffect: { class: "social" },
          policy: { availability: "implemented", implementationSupport: { job: true } },
        },
      ],
      routingByAlias: { "01": { capabilityIds: ["xhs.observe.feed", "xhs.comment.send"] } },
    }));
  });
  await new Promise((resolveServer) => server.listen(0, "127.0.0.1", resolveServer));
  try {
    const address = server.address();
    const fleet = await loadLiveFleet({ registryUrl: `http://127.0.0.1:${address.port}/` });
    assert.deepEqual(fleet[0].capabilityIds, ["xhs.observe.feed", "xiaowei.explorer.primitive"]);
  } finally {
    await new Promise((resolveServer, rejectServer) => server.close((error) => error ? rejectServer(error) : resolveServer()));
  }
});

test("M5 live binding takes integrity metadata from Control Plane and rejects registry drift", () => {
  const registry = [{ id: "xhs.observe.feed", capabilityContractHash: "a".repeat(64) }];
  const control = [{
    id: "xhs.observe.feed",
    capabilityContractHash: "a".repeat(64),
    capabilityContractHashAlgorithm: "xhs.capability-contract.sha256-canonical-json.v2",
  }];
  const reconciled = reconcileLiveCapabilityCatalog(registry, control);
  assert.equal(reconciled[0].capabilityContractHashAlgorithm, "xhs.capability-contract.sha256-canonical-json.v2");
  assert.throws(
    () => reconcileLiveCapabilityCatalog(registry, [{ ...control[0], capabilityContractHash: "b".repeat(64) }]),
    (error) => error.code === "IMPLEMENTATION_CONTRACT_CHANGED",
  );
});
