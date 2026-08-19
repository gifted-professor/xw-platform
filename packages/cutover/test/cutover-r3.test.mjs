import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  buildCanaryProfile,
  buildCanarySequence,
  evaluateRollbackTriggers,
  ROLLBACK_TRIGGERS,
  runCanaryDryRun,
  validateCanaryProfile,
} from "../lib/canary.mjs";
import {
  baselineFromRehearsalReceipt,
  buildComparisons,
  compareItem,
  deviceCountFromInventory,
  runShadow,
  shadowVerdict,
} from "../lib/shadow.mjs";
import {
  buildProposedTasks,
  buildTaskXml,
  buildTasksProposedReceipt,
  diffAgainstBefore,
} from "../lib/tasks.mjs";
import { snapshotDatabase } from "../lib/db.mjs";

function tmp(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeFixtureDb(path) {
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE devices (id TEXT PRIMARY KEY)");
  db.exec("CREATE TABLE leases (id TEXT PRIMARY KEY)");
  db.exec("PRAGMA user_version = 15");
  db.close();
  return path;
}

function makeGitRepo(dir) {
  mkdirSync(join(dir, "services/orchestrator"), { recursive: true });
  mkdirSync(join(dir, "services/control-plane"), { recursive: true });
  writeFileSync(join(dir, "services/orchestrator/registry.mjs"), "// orch\n");
  writeFileSync(join(dir, "services/control-plane/server.mjs"), "// cp\n");
  const git = (args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git(["init", "-q"]);
  git(["config", "user.email", "t@t.invalid"]);
  git(["config", "user.name", "t"]);
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);
}

const BASELINE = {
  control: { userVersion: 18, schemaHash: "c-hash", coreRowCounts: { devices: 4, capabilities: 32, jobs: 14185, leases: 0, sessions: 0 }, apiItemCounts: { capabilities: 32 } },
  registry: { userVersion: 0, schemaHash: "r-hash", coreRowCounts: { identities: 4 } },
  deviceCount: 4,
};

function goodSummary() {
  return {
    ok: true,
    controlPlane: {
      ok: true,
      healthOk: true,
      identity: { sourceRepo: "r", sourceCommit: "s", releaseId: "rel", runtimeProfile: "legacy_compat" },
      smoke: [
        { endpoint: "/control/v1/devices", ok: true, itemCount: 4 },
        { endpoint: "/control/v1/capabilities", ok: true, itemCount: 32 },
        { endpoint: "/control/v1/leases", ok: true, itemCount: 0 },
      ],
    },
    orchestrator: {
      ok: true,
      healthOk: true,
      identity: { sourceRepo: "r", sourceCommit: "s", releaseId: "rel", runtimeProfile: "legacy_compat" },
      smoke: [
        { endpoint: "/api/devices", ok: true, itemCount: 4 },
        { endpoint: "/api/capabilities", ok: true, itemCount: 32 },
      ],
    },
  };
}

function goodDbAfter() {
  return {
    control: { userVersion: 18, schemaHash: "c-hash", coreRowCounts: { devices: 4, capabilities: 32, jobs: 14185, leases: 0, sessions: 0 } },
    registry: { userVersion: 0, schemaHash: "r-hash", coreRowCounts: { identities: 4 } },
  };
}

const MANIFEST = { sourceRepo: "r", sourceCommit: "s", releaseId: "rel", runtimeProfile: "legacy_compat" };

function legacyCompatProfile() {
  return {
    orchestratorEnabled: true,
    controlPlaneEnabled: true,
    legacyCapabilitiesEnabled: true,
    legacyWorkflowsEnabled: true,
    openActionLiveEnabled: false,
    agentGatewayLiveEnabled: false,
    dshEnabled: false,
    graphV2Enabled: false,
    multiAgentEnabled: false,
    paymentCredentialRequiresHuman: true,
    paymentFinalCommitRequiresHuman: true,
  };
}

test("compareItem/shadowVerdict：false → BLOCK，unknown 不算失败但如实列出", () => {
  assert.equal(compareItem("a", 1, 1).match, true);
  assert.equal(compareItem("a", 1, 2).match, false);
  assert.equal(compareItem("a", "unknown", 2).match, "unknown");
  const rows = [compareItem("a", 1, 1), compareItem("b", "unknown", 1)];
  assert.equal(shadowVerdict(rows).verdict, "PASS");
  assert.deepEqual(shadowVerdict(rows).unknowns, ["b"]);
  assert.equal(shadowVerdict([...rows, compareItem("c", 1, 2)]).verdict, "BLOCK");
});

test("buildComparisons：全对得上 → PASS；设备数不一致 → BLOCK", () => {
  const good = buildComparisons({
    summary: goodSummary(),
    dbAfter: goodDbAfter(),
    legacyOrchestrator: { reachable: true, healthOk: true, deviceCount: 4 },
    baseline: BASELINE,
    manifest: MANIFEST,
    runtimeProfile: legacyCompatProfile(),
  });
  assert.equal(shadowVerdict(good).verdict, "PASS", JSON.stringify(good.filter((r) => r.match !== true)));
  const items = good.map((row) => row.item);
  for (const expected of [
    "health.control-plane", "devices.inventory.count", "capability-registry.api.count", "capability-registry.db.rows",
    "leases.read.count", "jobs.read.count", "release-identity.sourceCommit",
    "schema.control.schema_hash", "config.runtime-profile",
  ]) {
    assert.ok(items.includes(expected), `missing comparison ${expected}`);
  }

  const drift = goodSummary();
  drift.controlPlane.smoke[0].itemCount = 3;
  const bad = buildComparisons({
    summary: drift,
    dbAfter: goodDbAfter(),
    legacyOrchestrator: { reachable: true, healthOk: true, deviceCount: 4 },
    baseline: BASELINE,
    manifest: MANIFEST,
    runtimeProfile: legacyCompatProfile(),
  });
  const verdict = shadowVerdict(bad);
  assert.equal(verdict.verdict, "BLOCK");
  assert.ok(verdict.mismatches.includes("devices.inventory.count"));
});

test("buildComparisons：17930 不可达 → legacy 记 unknown，不手写 match", () => {
  const rows = buildComparisons({
    summary: goodSummary(),
    dbAfter: goodDbAfter(),
    legacyOrchestrator: { reachable: false, error: "timeout" },
    baseline: BASELINE,
    manifest: MANIFEST,
    runtimeProfile: legacyCompatProfile(),
  });
  const health = rows.find((row) => row.item === "health.orchestrator");
  assert.equal(health.legacy, "unknown");
  const devices = rows.find((row) => row.item === "devices.inventory.count");
  assert.equal(devices.legacy, 4, "17930 不可达时回退 R2 采集基线");
});

test("baselineFromRehearsalReceipt / deviceCountFromInventory：提取与缺失兜底", () => {
  const receipt = { rounds: [{ dbAfter: { control: { userVersion: 18, schemaHash: "h", coreRowCounts: { jobs: 1 } }, registry: { userVersion: 0, schemaHash: "r" } } }] };
  const baseline = baselineFromRehearsalReceipt(receipt);
  assert.equal(baseline.control.userVersion, 18);
  assert.equal(baseline.registry.schemaHash, "r");
  assert.equal(baselineFromRehearsalReceipt({}).control.userVersion, "unknown");
  assert.equal(deviceCountFromInventory({ services: { orchestratorApi: { deviceCount: 4 } } }), 4);
  assert.equal(deviceCountFromInventory({}), "unknown");
});

test("runShadow 编排：注入假 spawn/http，端到端比较 PASS（离线）", async (t) => {
  const dir = tmp(t, "xw-cutover-shadow-");
  const root = join(dir, "repo");
  makeGitRepo(root);
  const snapsDir = join(dir, "snaps");
  mkdirSync(snapsDir);
  const registry = snapshotDatabase({ sourcePath: makeFixtureDb(join(dir, "registry-src.db")), destDir: snapsDir, label: "registry" });
  const control = snapshotDatabase({ sourcePath: makeFixtureDb(join(dir, "control-src.db")), destDir: snapsDir, label: "control" });

  const { buildReleaseManifest } = await import("../../release/lib/release-manifest.mjs");
  const expected = buildReleaseManifest({ root });
  const fakeChild = { exitCode: 0, signalCode: null, kill() {}, once() {} };
  const spawnImpl = () => ({ child: fakeChild, logPath: join(dir, "fake.log") });
  const identityBody = {
    sourceRepo: expected.sourceRepo,
    sourceCommit: expected.sourceCommit,
    releaseId: expected.releaseId,
    runtimeProfile: expected.runtimeProfile,
  };
  const httpGet = async (url) => {
    if (url.includes(":17930/api/health")) return { reachable: true, status: 200, body: { ok: true, identities: 4 } };
    if (url.includes(":17930/api/devices")) return { reachable: true, status: 200, body: { devices: [{}, {}, {}, {}] } };
    if (url.endsWith("/control/v1/health")) return { reachable: true, status: 200, body: { ok: true, authority: true, ...identityBody } };
    if (url.endsWith("/api/health")) return { reachable: true, status: 200, body: { ok: true, ...identityBody } };
    if (url.includes("/control/v1/devices")) return { reachable: true, status: 200, body: { devices: [{}, {}, {}, {}] } };
    if (url.includes("/control/v1/capabilities")) return { reachable: true, status: 200, body: { capabilities: new Array(32).fill({}) } };
    if (url.includes("/control/v1/leases")) return { reachable: true, status: 200, body: { leases: [] } };
    if (url.includes("/api/devices")) return { reachable: true, status: 200, body: { devices: [{}, {}, {}, {}] } };
    if (url.includes("/api/capabilities")) return { reachable: true, status: 200, body: { capabilities: new Array(32).fill({}) } };
    throw new Error(`unexpected url ${url}`);
  };
  const controlAnalysis = snapshotDatabase({ sourcePath: makeFixtureDb(join(dir, "x.db")), destDir: join(dir, "s2"), label: "x" });
  const receipt = await runShadow({
    sourceRoot: root,
    snapshots: { registry: registry.snapshot.path, control: control.snapshot.path },
    workDir: join(dir, "work"),
    baseline: {
      control: { userVersion: 15, schemaHash: controlAnalysis.schemaHash, coreRowCounts: { devices: 0, capabilities: "absent", jobs: "absent", leases: 0, sessions: "absent" }, apiItemCounts: { capabilities: 32 } },
      registry: { userVersion: 15, schemaHash: registry.schemaHash, coreRowCounts: {} },
      deviceCount: 4,
    },
    deps: { httpGet, spawnImpl },
  });
  assert.equal(receipt.schemaId, "xw.cutover.shadow-comparison.v1");
  assert.equal(receipt.liveCanaryGate, "CLOSED");
  assert.equal(receipt.legacyOrchestrator.reachable, true);
  assert.equal(receipt.legacyOrchestrator.deviceCount, 4);
  const devicesRow = receipt.comparisons.find((row) => row.item === "devices.inventory.count");
  assert.equal(devicesRow.match, true);
  const schemaRow = receipt.comparisons.find((row) => row.item === "schema.control.schema_hash");
  assert.equal(schemaRow.match, true, "fixture DB 未迁移，schema hash 应与 snapshot 基准一致");
  assert.equal(receipt.verdict, "PASS", JSON.stringify(receipt.mismatches));
  assert.ok(receipt.safetyNotes.length > 0);
  assert.equal(receipt.disabledMechanisms.jobSubmission.includes("无 POST"), true);
});

test("buildTaskXml：Disabled 硬编码、BootTrigger、可转义", () => {
  const xml = buildTaskXml({
    name: "XW Platform Orchestrator",
    description: "d",
    command: "node.exe",
    arguments: '"C:\\a\\b.mjs" --x "1&2"',
    workingDirectory: "C:\\a",
    logonType: "S4U",
    runLevel: "LeastPrivilege",
  });
  assert.match(xml, /<Enabled>false<\/Enabled>/);
  assert.match(xml, /<BootTrigger>/);
  assert.match(xml, /1&amp;2/);
  assert.ok(!xml.includes("<Enabled>true</Enabled></Settings>"), "Settings.Enabled 必须恒 false");
});

test("buildProposedTasks/diffAgainstBefore：入口缺失记 pending，旧任务 unchanged，无注册动作", () => {
  const tasks = buildProposedTasks({ runtimeRoot: "C:\\rt", exists: () => false });
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].name, "XW Platform Control Plane");
  assert.ok(tasks[1].arguments.includes("current"));
  assert.ok(tasks[1].pending.some((line) => line.includes("入口不存在")));
  assert.ok(tasks.every((task) => task.state === "Disabled"));
  const diff = diffAgainstBefore({ proposed: tasks, beforeTasks: [{ name: "XhsDeviceRegistry", state: "Running" }] });
  assert.equal(diff.collisions.length, 0);
  assert.equal(diff.newTasks[1].legacyCounterpart, "XhsDeviceRegistry");
  assert.equal(diff.legacyTasks[0].action, "unchanged");
  const receipt = buildTasksProposedReceipt({ runtimeRoot: "C:\\rt", beforeTasks: [], exists: () => false });
  assert.equal(receipt.schemaId, "xw.cutover.scheduled-tasks-proposed.v1");
  assert.equal(receipt.registration, "NOT_REGISTERED");
  assert.equal(receipt.ok, true);
  const collision = buildTasksProposedReceipt({
    runtimeRoot: "C:\\rt",
    beforeTasks: [{ name: "XW Platform Orchestrator", state: "Ready" }],
    exists: () => false,
  });
  assert.equal(collision.ok, false, "与现有任务重名必须如实标 NAME_COLLISION");
});

test("canary profile：构造可序列化 + 校验 fail-closed", () => {
  const profile = buildCanaryProfile({ deviceId: "dev-01", actorId: "agent:cli" });
  assert.equal(validateCanaryProfile(profile).ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(profile)).allowedDeviceIds, ["dev-01"]);
  for (const bad of [
    buildCanaryProfile({ deviceId: null, actorId: "a" }),
    { ...profile, openActionLiveEnabled: true },
    { ...profile, quarantineOtherDevices: false },
    { ...profile, paymentFinalCommitRequiresHuman: false },
    { ...profile, capabilities: "all" },
  ]) {
    assert.equal(validateCanaryProfile(bad).ok, false);
  }
});

test("canary 序列：6.3 顺序 —— 先 drain/收敛/snapshot，先停旧，先 Control Plane 后 Orchestrator，支付红线收尾", () => {
  const ids = buildCanarySequence().map((step) => step.id);
  const order = (name) => ids.indexOf(name);
  assert.ok(order("pause-new-job-submission") < order("drain-active-jobs"));
  assert.ok(order("drain-active-jobs") < order("snapshot-both-dbs"));
  assert.ok(order("snapshot-both-dbs") < order("stop-legacy-orchestrator"));
  assert.ok(order("stop-legacy-control-plane") < order("verify-ports-released"));
  assert.ok(order("verify-ports-released") < order("start-xw-control-plane"));
  assert.ok(order("start-xw-control-plane") < order("start-xw-orchestrator"));
  assert.ok(order("start-xw-orchestrator") < order("health"));
  assert.ok(order("health") < order("observe") && order("observe") < order("release"));
  assert.ok(order("release") < order("payment-credential-requires-human"));
  assert.ok(ids.includes("unknown-payment-env-not-executed"));
  for (const step of buildCanarySequence()) {
    assert.ok(step.pre.length > 0 && step.post.length > 0, `step ${step.id} 必须有前置/后置检查`);
  }
});

test("evaluateRollbackTriggers：全 true → ok；false/unknown/缺失 → 触发（fail-closed）", () => {
  const allGood = Object.fromEntries(ROLLBACK_TRIGGERS.map((trigger) => [trigger.checkId, true]));
  assert.deepEqual(evaluateRollbackTriggers(allGood), { ok: true, triggered: [] });
  const oneBad = { ...allGood, dbIntegrityOk: false };
  const result = evaluateRollbackTriggers(oneBad);
  assert.equal(result.ok, false);
  assert.equal(result.triggered[0].id, "db-integrity-failure");
  const unknown = evaluateRollbackTriggers({ ...allGood, deviceCountMatches: "unknown" });
  assert.equal(unknown.triggered[0].id, "device-count-mismatch");
  const missing = evaluateRollbackTriggers({});
  assert.equal(missing.triggered.length, ROLLBACK_TRIGGERS.length, "检查缺失视同触发");
});

test("canary dry-run：executed=false、gate CLOSED、步骤+触发器齐全、不落 canary-receipt", () => {
  const plan = runCanaryDryRun({ profile: buildCanaryProfile({ deviceId: "dev-01", actorId: "agent:cli" }) });
  assert.equal(plan.schemaId, "xw.cutover.canary-plan.v1");
  assert.equal(plan.executed, false);
  assert.equal(plan.liveCanaryGate, "CLOSED");
  assert.equal(plan.ok, true);
  assert.ok(plan.steps.length >= 20);
  assert.equal(plan.rollbackTriggers.length, ROLLBACK_TRIGGERS.length);
  const badPlan = runCanaryDryRun({ profile: buildCanaryProfile({ deviceId: null, actorId: null }) });
  assert.equal(badPlan.ok, false);
  assert.equal(badPlan.executed, false, "profile 不合法也只输出计划，不执行");
});
