import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { analyzeDb, inspectDbFile, readUserVersion, restoreSnapshot, snapshotDatabase } from "../lib/db.mjs";
import { collectLiveInventory, discoverDbPaths, scheduledTasksReceipt } from "../lib/live-collect.mjs";
import { compareRounds, coreRowCounts, rehearsalVerdict } from "../lib/rehearse.mjs";
import { decideRollbackGate } from "../lib/rollback.mjs";
import { buildControlPlaneLaunch, buildOrchestratorLaunch } from "../lib/service-runner.mjs";
import { redactString, redactValue } from "../lib/util.mjs";

function tmp(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeFixtureDb(path, { wal = false } = {}) {
  const db = new DatabaseSync(path);
  if (wal) db.exec("PRAGMA journal_mode = WAL");
  db.exec("CREATE TABLE devices (id TEXT PRIMARY KEY, note TEXT)");
  db.exec("CREATE TABLE leases (id TEXT PRIMARY KEY)");
  db.prepare("INSERT INTO devices (id, note) VALUES (?, ?)").run("dev-1", "serial-SECRET-1");
  db.prepare("INSERT INTO leases (id) VALUES (?)").run("lease-1");
  db.exec("PRAGMA user_version = 15");
  db.close();
  return path;
}

test("redact：敏感 key / 命令行 token / 用户名路径段", () => {
  assert.equal(redactValue({ token: "abc", nested: { deviceSerial: "S1" } }).token, "[redacted]");
  assert.equal(redactValue({ nested: { deviceSerial: "S1" } }).nested.deviceSerial, "[redacted]");
  assert.equal(redactString('node registry.mjs --agent-token "tok-123" --port 17930'), "node registry.mjs --agent-token [redacted] --port 17930");
  assert.equal(redactString("C:\\Users\\alice\\secret\\x.db"), "C:\\Users\\<user>\\secret\\x.db");
  assert.equal(redactString("C:\\Users\\Public\\xhs-registry\\registry.db"), "C:\\Users\\Public\\xhs-registry\\registry.db");
  assert.equal(redactValue({ devices: [{ alias: "a", serial: "xyz" }] }).devices[0].alias, "a");
});

test("snapshotDatabase：fixture DB snapshot 含 integrity/schema/rowCounts，可恢复", (t) => {
  const dir = tmp(t, "xw-cutover-db-");
  const source = makeFixtureDb(join(dir, "source.db"), { wal: true });
  const receipt = snapshotDatabase({ sourcePath: source, destDir: join(dir, "snaps"), label: "control" });
  assert.equal(receipt.ok, true);
  assert.equal(receipt.integrityCheck, "ok");
  assert.equal(receipt.userVersion, 15);
  assert.equal(receipt.rowCounts.devices, 1);
  assert.equal(receipt.rowCounts.leases, 1);
  assert.match(receipt.snapshot.sha256, /^[0-9a-f]{64}$/);
  assert.equal(receipt.source.sha256.length, 64);

  const restored = restoreSnapshot({ snapshotPath: receipt.snapshot.path, targetPath: join(dir, "work", "control.db") });
  assert.equal(restored.schemaHash, receipt.schemaHash);
  assert.equal(restored.userVersion, 15);

  const missing = snapshotDatabase({ sourcePath: join(dir, "nope.db"), destDir: join(dir, "snaps"), label: "x" });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, "SOURCE_DB_NOT_FOUND");
});

test("inspectDbFile/readUserVersion：不存在与未知如实记录", (t) => {
  const dir = tmp(t, "xw-cutover-db2-");
  const info = inspectDbFile(join(dir, "absent.db"));
  assert.equal(info.exists, false);
  assert.equal(info.userVersion, "unknown");
  assert.equal(readUserVersion(join(dir, "absent.db")), "unknown");
  const db = makeFixtureDb(join(dir, "real.db"));
  assert.equal(readUserVersion(db), 15);
  assert.equal(inspectDbFile(db).wal.present, false);
});

test("analyzeDb：schemaHash 对表结构变化敏感", (t) => {
  const dir = tmp(t, "xw-cutover-db3-");
  const a = makeFixtureDb(join(dir, "a.db"));
  const hashA = analyzeDb(a).schemaHash;
  const db = new DatabaseSync(a);
  db.exec("ALTER TABLE devices ADD COLUMN extra TEXT");
  db.close();
  assert.notEqual(analyzeDb(a).schemaHash, hashA);
});

test("compareRounds / rehearsalVerdict：一致 PASS，漂移或失败 BLOCK", () => {
  const dbAfter = (hash) => ({
    control: { userVersion: 18, integrityCheck: "ok", schemaHash: hash, tableCount: 30, coreRowCounts: { devices: 4 } },
    registry: { userVersion: 0, integrityCheck: "ok", schemaHash: "r1", tableCount: 9, coreRowCounts: { identities: 4 } },
  });
  const good = [
    { round: 1, ok: true, dbAfter: dbAfter("c1") },
    { round: 2, ok: true, dbAfter: dbAfter("c1") },
    { round: 3, ok: true, dbAfter: dbAfter("c1") },
  ];
  assert.deepEqual(rehearsalVerdict(good).gate, "PASS");
  const drift = [good[0], { round: 2, ok: true, dbAfter: dbAfter("c2") }];
  const verdict = rehearsalVerdict(drift);
  assert.equal(verdict.gate, "BLOCK");
  assert.ok(verdict.diffs.some((line) => line.includes("schemaHash drift")));
  const failed = [good[0], { round: 2, ok: false, failure: "control-plane: WAIT_TIMEOUT", dbAfter: dbAfter("c1") }];
  assert.equal(rehearsalVerdict(failed).gate, "BLOCK");
  const badIntegrity = [{ round: 1, ok: true, dbAfter: { ...dbAfter("c1"), control: { ...dbAfter("c1").control, integrityCheck: "corrupt" } } }];
  assert.equal(rehearsalVerdict(badIntegrity).gate, "BLOCK");
  assert.deepEqual(coreRowCounts({ rowCounts: { devices: 4 } }, ["devices", "leases"]), { devices: 4, leases: "absent" });
});

test("decideRollbackGate：全步 ok 才 PASS，任何失败如实 BLOCK", () => {
  assert.equal(decideRollbackGate([{ step: "a", ok: true }, { step: "b", ok: true }]).gate, "PASS");
  const blocked = decideRollbackGate([{ step: "a", ok: true }, { step: "legacy-code-boot", ok: false, detail: "SCHEMA_VERSION_TOO_NEW" }]);
  assert.equal(blocked.gate, "BLOCK");
  assert.equal(blocked.failedSteps[0].step, "legacy-code-boot");
  assert.equal(decideRollbackGate([]).gate, "BLOCK");
});

test("launch 构造：release 带 XW_RELEASE_MANIFEST，legacy 不带", () => {
  const release = buildControlPlaneLaunch({
    mode: "release", releaseDir: "/rel", dbPath: "/w/control.db", runsRoot: "/w/runs", stateDir: "/w/state", port: 18920,
  });
  assert.equal(release.env.CONTROL_PLANE_PORT, "18920");
  assert.equal(release.env.CONTROL_PLANE_DB, "/w/control.db");
  assert.ok(release.env.XW_RELEASE_MANIFEST.endsWith("release-manifest.v1.json"));
  const legacy = buildOrchestratorLaunch({
    mode: "legacy", legacyRoot: "C:\\Users\\Public\\xhs-registry", dbPath: "/w/registry.db",
    controlDbPath: "/w/control.db", runsRoot: "/w/runs", stateDir: "/w/state", port: 18931, controlPort: 18921,
  });
  assert.equal(legacy.env.XW_RELEASE_MANIFEST, undefined);
  assert.ok(legacy.args.includes("--port") && legacy.args.includes("18931"));
  assert.ok(legacy.args.includes("--control-db"));
});

test("collectLiveInventory：注入假 exec/http，脱敏与 unreachable 如实记录", async () => {
  const exec = (command, args) => {
    const key = `${command} ${args.join(" ")}`;
    if (key.startsWith("git -C") && key.includes("rev-parse HEAD")) return "a".repeat(40);
    if (key.startsWith("git -C") && key.includes("status --porcelain")) return " M a.mjs\n M b.mjs";
    if (key.startsWith("git -C") && key.includes("remote get-url")) return "https://example.invalid/repo.git";
    if (command === "netstat") return "  TCP    0.0.0.0:17930     0.0.0.0:0    LISTENING    4242";
    if (command === "tasklist") return '"node.exe","4242"';
    if (command === "powershell" && key.includes("Win32_Process")) return 'node.exe registry.mjs --agent-token "super-secret" --db C:\\Users\\Public\\xhs-registry\\registry.db';
    if (command === "powershell" && key.includes("Get-ScheduledTask")) return "XhsDeviceRegistry|Running";
    if (command === "schtasks") return "<Task><RegistrationInfo><Author>ops</Author></RegistrationInfo><Settings><Enabled>true</Enabled></Settings><Triggers><BootTrigger></BootTrigger></Triggers><Actions><Exec><Command>node.exe</Command><Arguments>registry.mjs --agent-token tok-1 --db \"C:\\Users\\Public\\xhs-registry\\registry.db\"</Arguments></Exec></Actions></Task>";
    throw new Error(`unexpected exec: ${key}`);
  };
  const httpGet = async (url) => {
    if (url.includes("17930/api/health")) return { reachable: true, status: 200, body: { ok: true, identities: 4 } };
    if (url.includes("17930/api/devices")) return { reachable: true, status: 200, body: { devices: [{ alias: "a", serial: "SERIAL-9" }], controlPlane: { reachable: false } } };
    if (url.includes("17930/api/agent-entry")) return { reachable: true, status: 200, body: { schemaVersion: "xhs.agent-entry.v2" } };
    return { reachable: false, status: null, body: null, error: "timeout" };
  };
  const inventory = await collectLiveInventory({ exec, httpGet, exists: () => false });
  assert.equal(inventory.schemaId, "xw.cutover.live-inventory.v1");
  assert.equal(inventory.checkouts.orchestrator.dirtyFileCount, 2);
  assert.equal(inventory.ports.orchestrator.listening, true);
  assert.equal(inventory.ports.orchestrator.pid, 4242);
  assert.ok(!JSON.stringify(inventory).includes("super-secret"), "命令行 token 必须脱敏");
  assert.equal(inventory.services.orchestratorApi.reachable, true);
  assert.equal(inventory.services.orchestratorApi.deviceCount, 1);
  assert.equal(inventory.services.controlPlaneApi.reachable, false, "17920 不可达必须如实记录");
  assert.equal(inventory.databases.control.path, "unknown", "发现不了就记 unknown");
  const tasks = scheduledTasksReceipt(inventory);
  assert.equal(tasks.schemaId, "xw.cutover.scheduled-tasks-before.v1");
  assert.ok(!JSON.stringify(tasks).includes("tok-1"), "计划任务参数 token 必须脱敏");
});

test("discoverDbPaths：从计划任务 --db 参数发现，发现不了记 unknown", () => {
  const found = discoverDbPaths({
    scheduledTasks: { tasks: [{ name: "XhsDeviceRegistry", actions: [{ arguments: 'registry.mjs --db "D:\\live\\registry.db"' }] }] },
    exists: (path) => path === "D:\\live\\registry.db",
  });
  assert.equal(found.registry.path, "D:\\live\\registry.db");
  assert.equal(found.control.path, "unknown");
  const none = discoverDbPaths({ scheduledTasks: { tasks: [] }, exists: () => false });
  assert.equal(none.registry.path, "unknown");
});

test("runRehearsal 编排：注入假 spawn/http，两轮一致 → PASS（离线）", async (t) => {
  const { runRehearsal } = await import("../lib/rehearse.mjs");
  const dir = tmp(t, "xw-cutover-reh-");
  // 源 git 仓（writeRelease 需要）
  const root = join(dir, "repo");
  mkdirSync(join(root, "services/orchestrator"), { recursive: true });
  mkdirSync(join(root, "services/control-plane"), { recursive: true });
  writeFileSync(join(root, "services/orchestrator/registry.mjs"), "// orch\n");
  writeFileSync(join(root, "services/control-plane/server.mjs"), "// cp\n");
  const git = (args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git(["init", "-q"]);
  git(["config", "user.email", "t@t.invalid"]);
  git(["config", "user.name", "t"]);
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);
  // fixture snapshots
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
    if (url.endsWith("/control/v1/health")) {
      return { reachable: true, status: 200, body: { ok: true, authority: true, ...identityBody } };
    }
    if (url.endsWith("/api/health")) {
      return { reachable: true, status: 200, body: { ok: true, ...identityBody } };
    }
    if (url.includes("/devices")) return { reachable: true, status: 200, body: { devices: [{ id: 1 }] } };
    if (url.includes("/capabilities")) return { reachable: true, status: 200, body: { capabilities: [] } };
    if (url.includes("/leases")) return { reachable: true, status: 200, body: { leases: [] } };
    throw new Error(`unexpected url ${url}`);
  };
  const receipt = await runRehearsal({
    sourceRoot: root,
    snapshots: { registry: registry.snapshot.path, control: control.snapshot.path },
    workDir: join(dir, "work"),
    rounds: 2,
    deps: { httpGet, spawnImpl },
  });
  assert.equal(receipt.schemaId, "xw.cutover.rehearsal.v1");
  assert.equal(receipt.rounds.length, 2);
  assert.equal(receipt.rehearsalGate, "PASS", JSON.stringify(receipt.consistency.diffs));
  assert.ok(existsSync(join(dir, "work", "state-copy", "round-1", "control.db")));
  assert.ok(receipt.safetyNotes.length > 0);
});
