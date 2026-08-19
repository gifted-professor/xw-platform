#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ControlClient } from "../control-client/lib/control-client.mjs";
import { DEFAULT_RUNTIME_PROFILE, loadRuntimeProfile } from "../kernel/lib/runtime-profile.mjs";
import {
  RELEASE_MANIFEST_FILENAME,
  RUNTIME_CUTOVER_ALLOWED,
  detectNpmVersion,
  verifyReleaseManifest,
  writeRelease,
} from "../release/lib/release-manifest.mjs";
import { discoverDbPaths, collectLiveInventory, collectScheduledTasks, scheduledTasksReceipt } from "../cutover/lib/live-collect.mjs";
import { snapshotDatabase } from "../cutover/lib/db.mjs";
import { runRehearsal, REHEARSAL_ROOT } from "../cutover/lib/rehearse.mjs";
import { runRollbackDrill } from "../cutover/lib/rollback.mjs";

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function usage() {
  return `xw phone attach|observe|act|trace|replay|release [--json] [--jsonl] [--non-interactive] [--context-file PATH] [--trace-id ID]
Token is read from XW_CONTROL_TOKEN or --token-file. Never pass tokens on argv, query, or stdout.
xw cutover collect|package|verify|preflight — offline release tools, see: xw cutover --help`;
}

function cutoverUsage() {
  return `xw cutover — M3-R 离线 release / 现场只读采集 / DB rehearsal 工具（不 deploy / 不 restart / 不改计划任务 / 不碰设备）

  xw cutover collect [--json]                       收集本机离线事实（版本 / 平台 / repo HEAD / 工作树是否脏）
  xw cutover collect --live [--out FILE]            现场只读采集 → live-inventory.v1.json（旁出 scheduled-tasks-before.v1.json）
  xw cutover package --out DIR [--release-id ID]    在 DIR/releases/<releaseId>/ 物化不可变 release
  xw cutover verify --release DIR [--json]          重算并比对 release 目录全部 hash
  xw cutover preflight [--release DIR] [--json]     离线预检，任一失败 exit 1
  xw cutover snapshot --work-dir DIR [--receipt FILE] [--registry-db P] [--control-db P]
                                                    两个现场 DB 只读 snapshot 到 DIR/snapshots/ + db-snapshot-receipt
  xw cutover rehearse --work-dir DIR [--rounds 3] [--registry-snapshot P] [--control-snapshot P] [--receipt FILE]
                                                    在 DB 副本上跑 N 轮 xw-platform rehearsal（替代端口，不碰现场）
  xw cutover rollback --work-dir DIR [--registry-snapshot P] [--control-snapshot P] [--receipt FILE]
                                                    回滚演练：xw migration → 恢复 snapshot → 旧代码启动 → health 恢复

不实现（属于后续阶段）：canary / promote / closeout / deploy。`;
}

function argOf(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  if (index < 0 || index === argv.length - 1) return fallback;
  return argv[index + 1];
}

function has(argv, name) {
  return argv.includes(name);
}

function readToken(argv) {
  const file = argOf(argv, "--token-file");
  if (file) return readFileSync(resolve(file), "utf8").trim();
  return process.env.XW_CONTROL_TOKEN || process.env.XHS_CONTROL_TOKEN || null;
}

function loadContext(argv) {
  const file = argOf(argv, "--context-file");
  if (!file || !existsSync(resolve(file))) return {};
  return JSON.parse(readFileSync(resolve(file), "utf8"));
}

function saveContext(argv, context) {
  const file = argOf(argv, "--context-file");
  if (!file) return;
  writeFileSync(resolve(file), `${JSON.stringify(context, null, 2)}\n`);
}

function emit(argv, value) {
  if (has(argv, "--jsonl") && Array.isArray(value)) {
    for (const item of value) process.stdout.write(`${JSON.stringify(item)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function redact(value) {
  if (!value || typeof value !== "object") return value;
  const copy = Array.isArray(value) ? [...value] : { ...value };
  for (const key of Object.keys(copy)) {
    if (/token|authorization|password|secret/i.test(key)) copy[key] = "[redacted]";
    else if (copy[key] && typeof copy[key] === "object") copy[key] = redact(copy[key]);
  }
  return copy;
}

function gitOut(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function findRepoRoot() {
  try {
    return gitOut(["rev-parse", "--show-toplevel"]);
  } catch {
    return cliRoot;
  }
}

// cutover 离线命令只读本机 git/版本信息；--live / snapshot / rehearse / rollback 为 M3-R2：
// 现场一律只读，所有写入都落在 --work-dir / --out 指定目录。
async function cutoverMain(argv) {
  const command = argv[0];
  if (!command || has(argv, "--help")) {
    process.stderr.write(`${cutoverUsage()}\n`);
    return has(argv, "--help") ? 0 : 2;
  }

  if (command === "collect") {
    if (has(argv, "--live")) {
      const inventory = await collectLiveInventory();
      const out = resolve(argOf(argv, "--out", join(cliRoot, "docs/cutover/m3-r/live-inventory.v1.json")));
      writeFileSync(out, `${JSON.stringify(inventory, null, 2)}\n`);
      const tasksOut = join(dirname(out), "scheduled-tasks-before.v1.json");
      writeFileSync(tasksOut, `${JSON.stringify(scheduledTasksReceipt(inventory), null, 2)}\n`);
      emit(argv, { ok: true, inventory: out, scheduledTasks: tasksOut, schemaId: inventory.schemaId });
      return 0;
    }
    const root = findRepoRoot();
    let sourceCommit = null;
    let sourceTreeSha = null;
    let gitDirty = null;
    try {
      sourceCommit = gitOut(["rev-parse", "HEAD"]);
      sourceTreeSha = gitOut(["rev-parse", "HEAD^{tree}"]);
      gitDirty = gitOut(["status", "--porcelain"]).length > 0;
    } catch {
      gitDirty = null;
    }
    emit(argv, {
      ok: true,
      nodeVersion: process.versions.node,
      npmVersion: detectNpmVersion(),
      platform: process.platform,
      arch: process.arch,
      repoRoot: root,
      sourceCommit,
      sourceTreeSha,
      gitDirty,
      runtimeProfile: DEFAULT_RUNTIME_PROFILE,
      runtimeCutoverAllowed: RUNTIME_CUTOVER_ALLOWED,
    });
    return 0;
  }

  if (command === "package") {
    const out = argOf(argv, "--out");
    if (!out) {
      process.stderr.write("missing --out DIR\n");
      return 2;
    }
    const manifest = writeRelease({
      root: findRepoRoot(),
      outDir: resolve(out),
      releaseId: argOf(argv, "--release-id"),
    });
    emit(argv, {
      ok: true,
      releaseId: manifest.releaseId,
      releaseDir: join(resolve(out), "releases", manifest.releaseId),
      sourceCommit: manifest.sourceCommit,
      fileCount: manifest.files.length,
      runtimeCutoverAllowed: manifest.runtimeCutoverAllowed,
    });
    return 0;
  }

  if (command === "verify") {
    const releaseDir = argOf(argv, "--release");
    if (!releaseDir) {
      process.stderr.write("missing --release DIR\n");
      return 2;
    }
    const dir = resolve(releaseDir);
    const required = [
      RELEASE_MANIFEST_FILENAME,
      "services/orchestrator",
      "services/control-plane",
      "packages",
    ];
    const checks = required.map((path) => ({ id: `exists:${path}`, ok: existsSync(join(dir, path)) }));
    const manifestPath = join(dir, RELEASE_MANIFEST_FILENAME);
    let verified = { ok: false, mismatches: [{ path: manifestPath, kind: "missing" }] };
    if (existsSync(manifestPath)) {
      verified = verifyReleaseManifest({ manifestPath, root: dir });
    }
    checks.push({ id: "manifest:verify", ok: verified.ok });
    const ok = checks.every((check) => check.ok);
    emit(argv, { ok, releaseDir: dir, checks, mismatches: verified.mismatches });
    return ok ? 0 : 1;
  }

  if (command === "preflight") {
    const checks = [];
    const nodeMajor = Number(process.versions.node.split(".")[0]);
    checks.push({ id: "node-major>=20", ok: nodeMajor >= 20, detail: process.versions.node });
    try {
      loadRuntimeProfile(DEFAULT_RUNTIME_PROFILE);
      checks.push({ id: "runtime-profile:loadable", ok: true, detail: DEFAULT_RUNTIME_PROFILE });
    } catch (error) {
      checks.push({ id: "runtime-profile:loadable", ok: false, detail: error.message });
    }
    checks.push({ id: "runtimeCutoverAllowed:false", ok: RUNTIME_CUTOVER_ALLOWED === false });

    const releaseDir = argOf(argv, "--release");
    if (releaseDir) {
      const dir = resolve(releaseDir);
      const manifestPath = join(dir, RELEASE_MANIFEST_FILENAME);
      let manifest = null;
      try {
        manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      } catch {
        manifest = null;
      }
      checks.push({
        id: "release:runtimeCutoverAllowed:false",
        ok: manifest?.runtimeCutoverAllowed === false,
      });
      const verified = manifest
        ? verifyReleaseManifest({ manifestPath, root: dir })
        : { ok: false, mismatches: [{ path: manifestPath, kind: "missing" }] };
      checks.push({
        id: "release:manifest-verify",
        ok: verified.ok,
        detail: verified.ok ? undefined : `${verified.mismatches.length} mismatch(es)`,
      });
      for (const entry of ["services/orchestrator/registry.mjs", "services/control-plane/control-plane/router.mjs"]) {
        checks.push({ id: `release:entry:${entry}`, ok: existsSync(join(dir, entry)) });
      }
    }
    const ok = checks.every((check) => check.ok);
    emit(argv, { ok, checks });
    return ok ? 0 : 1;
  }

  if (command === "snapshot") {
    const workDir = argOf(argv, "--work-dir");
    if (!workDir) {
      process.stderr.write("missing --work-dir DIR\n");
      return 2;
    }
    const discovered = discoverDbPaths({ scheduledTasks: collectScheduledTasks() });
    const registryDb = argOf(argv, "--registry-db") || discovered.registry.path;
    const controlDb = argOf(argv, "--control-db") || discovered.control.path;
    const destDir = join(resolve(workDir), "snapshots");
    const receipt = {
      schemaId: "xw.cutover.db-snapshot.v1",
      generatedAt: new Date().toISOString(),
      note: "snapshot 本体不进 git（体积与数据），位于 rehearsal 工作目录；receipt 是事实源。源 DB 只读访问，旧目录零写入。",
      sources: { registry: discovered.registry, control: discovered.control },
      databases: {
        registry: registryDb === "unknown"
          ? { label: "registry", ok: false, error: "SOURCE_DB_UNKNOWN" }
          : snapshotDatabase({ sourcePath: registryDb, destDir, label: "registry" }),
        control: controlDb === "unknown"
          ? { label: "control", ok: false, error: "SOURCE_DB_UNKNOWN" }
          : snapshotDatabase({ sourcePath: controlDb, destDir, label: "control" }),
      },
    };
    receipt.ok = receipt.databases.registry.ok === true && receipt.databases.control.ok === true;
    const receiptOut = resolve(argOf(argv, "--receipt", join(cliRoot, "docs/cutover/m3-r/db-snapshot-receipt.v1.json")));
    writeFileSync(receiptOut, `${JSON.stringify(receipt, null, 2)}\n`);
    emit(argv, { ok: receipt.ok, receipt: receiptOut, snapshots: destDir });
    return receipt.ok ? 0 : 1;
  }

  if (command === "rehearse" || command === "rollback") {
    const workDir = argOf(argv, "--work-dir");
    if (!workDir) {
      process.stderr.write("missing --work-dir DIR\n");
      return 2;
    }
    const snapshotsDir = join(resolve(workDir), "snapshots");
    const snapshots = {
      registry: argOf(argv, "--registry-snapshot") || join(snapshotsDir, "registry.snapshot.db"),
      control: argOf(argv, "--control-snapshot") || join(snapshotsDir, "control.snapshot.db"),
    };
    if (command === "rehearse") {
      const receipt = await runRehearsal({
        sourceRoot: findRepoRoot(),
        snapshots,
        workDir: resolve(workDir),
        rounds: Number(argOf(argv, "--rounds", "3")),
      });
      const receiptOut = resolve(argOf(argv, "--receipt", join(cliRoot, "docs/cutover/m3-r/rehearsal-receipt.v1.json")));
      writeFileSync(receiptOut, `${JSON.stringify(receipt, null, 2)}\n`);
      emit(argv, { ok: receipt.rehearsalGate === "PASS", rehearsalGate: receipt.rehearsalGate, receipt: receiptOut, diffs: receipt.consistency.diffs });
      return receipt.rehearsalGate === "PASS" ? 0 : 1;
    }
    const releasesDir = join(resolve(workDir), "release", "releases");
    const releaseIds = existsSync(releasesDir) ? readdirSync(releasesDir) : [];
    if (releaseIds.length !== 1) {
      process.stderr.write(`expected exactly 1 materialized release under ${releasesDir}, got ${releaseIds.length}\n`);
      return 2;
    }
    const releaseDir = join(releasesDir, releaseIds[0]);
    const manifest = JSON.parse(readFileSync(join(releaseDir, RELEASE_MANIFEST_FILENAME), "utf8"));
    const receipt = await runRollbackDrill({
      releaseDir,
      manifest,
      snapshots,
      workDir: resolve(workDir),
    });
    const receiptOut = resolve(argOf(argv, "--receipt", join(cliRoot, "docs/cutover/m3-r/rollback-certification.v1.json")));
    writeFileSync(receiptOut, `${JSON.stringify(receipt, null, 2)}\n`);
    emit(argv, { ok: receipt.rollbackGate === "PASS", rollbackGate: receipt.rollbackGate, receipt: receiptOut, failedSteps: receipt.failedSteps });
    return receipt.rollbackGate === "PASS" ? 0 : 1;
  }

  process.stderr.write(`${cutoverUsage()}\n`);
  return 2;
}

async function main(argv = process.argv.slice(2)) {
  if (argv[0] === "cutover") return cutoverMain(argv.slice(1));
  if (argv[0] !== "phone" || !argv[1] || argv.includes("--help")) {
    process.stderr.write(`${usage()}\n`);
    return argv.includes("--help") ? 0 : 2;
  }
  const command = argv[1];
  const baseUrl = argOf(argv, "--control", process.env.XW_CONTROL_URL || "http://127.0.0.1:17920");
  const token = readToken(argv);
  const client = new ControlClient({ baseUrl, token });
  const context = loadContext(argv);
  const sessionId = argOf(argv, "--session", context.sessionId);
  const sessionToken = context.token || null;

  if (["observe", "act", "trace", "release"].includes(command) && (!sessionId || !sessionToken)) {
    process.stderr.write("missing --context-file session\n");
    return 2;
  }

  if (command === "attach") {
    const created = await client.createDeviceSession({
      actorId: argOf(argv, "--actor", "agent:cli"),
      deviceId: argOf(argv, "--device"),
    });
    saveContext(argv, {
      sessionId: created.session.sessionId,
      token: created.token,
      traceId: argOf(argv, "--trace-id", created.session.sessionId),
    });
    emit(argv, redact({ ok: true, session: created.session, expiresAt: created.expiresAt }));
    return 0;
  }
  if (command === "observe") {
    const observed = await client.observe(sessionId, sessionToken, {});
    context.lastObservationId = observed.observation.observationId;
    saveContext(argv, context);
    emit(argv, redact(observed));
    return 0;
  }
  if (command === "act") {
    const requestPath = argOf(argv, "--request");
    const request = requestPath ? JSON.parse(readFileSync(resolve(requestPath), "utf8")) : JSON.parse(argOf(argv, "--request-json", "{}"));
    const acted = await client.act(sessionId, sessionToken, request);
    saveContext(argv, context);
    emit(argv, redact(acted));
    return 0;
  }
  if (command === "trace") {
    const events = await client.events(sessionId, sessionToken, Number(argOf(argv, "--after", "0")));
    emit(argv, has(argv, "--jsonl") ? events.events : redact(events));
    return 0;
  }
  if (command === "replay") {
    emit(argv, { ok: true, mode: "recorded_replay", transportCalled: false, liveCanaryGate: "CLOSED" });
    return 0;
  }
  if (command === "release") {
    const released = await client.release(sessionId, sessionToken);
    saveContext(argv, {});
    emit(argv, redact(released));
    return 0;
  }
  process.stderr.write(`${usage()}\n`);
  return 2;
}

if (import.meta.url === `file://${process.argv[1].replaceAll("\\", "/")}` || process.argv[1]?.endsWith("xw.mjs")) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(`${error.code || "CLI_ERROR"}: ${error.message}\n`);
    process.exitCode = 1;
  });
}

export { main, redact };
