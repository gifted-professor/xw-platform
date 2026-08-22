#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
import { baselineFromRehearsalReceipt, deviceCountFromInventory, runShadow } from "../cutover/lib/shadow.mjs";
import { buildTasksProposedReceipt, buildProposedTasks, RUNTIME_ROOT_DEFAULT } from "../cutover/lib/tasks.mjs";
import { buildCanaryProfile, runCanaryDryRun } from "../cutover/lib/canary.mjs";
import {
  buildEpochRecord,
  buildCloseoutRecord,
  signEpochProof,
  mintEpoch,
  writeCloseout,
  activateGate,
  readActiveGate,
  resolveLatestEpoch,
  rollbackGate,
  loadM6Locks,
  loadGateIssuerAllowlist,
  loadM6Gate,
  evaluateM6Gate,
} from "../../services/control-plane/control-plane/lib/m6-epoch.mjs";
import { deriveM6AggregateSealHash, verifyAggregateCloseout } from "../kernel/lib/m6-aggregate-closeout.mjs";
import { writeImmutableJson } from "../../services/control-plane/control-plane/lib/m6-gate-loader.mjs";

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function usage() {
  return `xw phone attach|observe|act|trace|replay|release [--json] [--jsonl] [--non-interactive] [--context-file PATH] [--trace-id ID]
Token is read from XW_CONTROL_TOKEN or --token-file. Never pass tokens on argv, query, or stdout.
xw m6 frame preflight|capture|status|closeout — closed M6-2 observe-capture (see: xw m6 frame --help)
xw m6 epoch mint|activate|close|status|verify|rollback|aggregate-closeout — M6-2 offline gate operator tools (see: xw m6 epoch --help)
xw cutover collect|package|verify|preflight — offline release tools, see: xw cutover --help`;
}

function m6FrameUsage() {
  return `xw m6 frame — M6-2 closed observe frame capture (zero-live, gate stays CLOSED/OBSERVE_ONLY)

  xw m6 frame preflight --alias ALPHA [--scenario observe] [--control URL] --json
  xw m6 frame capture --alias ALPHA [--scenario observe] --idempotency-key K --json
  xw m6 frame status --attempt-id ID [--control URL] --json
  xw m6 frame closeout --attempt-id ID --reason R --control URL --json

JSON output is machine-readable and redacted; it never carries a device token,
serial, coordinate, or action. Default does not loop and does not flip the gate.`;
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
  xw cutover shadow --work-dir DIR [--registry-snapshot P] [--control-snapshot P] [--receipt FILE]
                    [--baseline-rehearsal FILE] [--baseline-inventory FILE]
                                                    M3-R3 shadow：DB 副本 + 替代端口启动，只读比较（17930 仅 GET），旧系统仍是唯一权威
  xw cutover tasks [--receipt FILE] [--xml-dir DIR] [--runtime-root P]
                                                    生成两个新计划任务的定义（Disabled，schtasks 可导入 XML），绝不注册
  xw cutover canary --dry-run --device ID --actor ID [--out FILE]
                                                    输出 canary 步骤序列 + 前置/后置检查 + 回滚触发器清单；不执行任何一步

不实现（属于后续阶段）：canary 真实执行 / promote / closeout / deploy。`;
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
      // M6-2 profile proof: the packaged release's immutable profile bit must be
      // true and the release must be on the legacy_compat runtime. Both facts are
      // validated directly from the packaged bytes (never from live runtime).
      const profileRel = "packages/kernel/contracts/runtime-profile.v1.json";
      const profilePath = join(dir, profileRel);
      let profileOk = false;
      let profileDetail = null;
      if (existsSync(profilePath)) {
        try {
          const doc = JSON.parse(readFileSync(profilePath, "utf8"));
          const legacy = doc?.profiles?.legacy_compat;
          profileOk = legacy?.agenticGroundingEnabled === true;
          profileDetail = {
            runtimeProfile: DEFAULT_RUNTIME_PROFILE,
            agenticGroundingEnabled: legacy?.agenticGroundingEnabled ?? null,
          };
        } catch (error) {
          profileDetail = { error: error.message };
        }
      } else {
        profileDetail = { missing: profileRel };
      }
      checks.push({
        id: "release:m6-2:runtime-profile",
        ok: profileOk,
        detail: profileOk ? profileDetail : profileDetail,
      });
      checks.push({
        id: "release:m6-2:agentic-grounding-enabled",
        ok: profileOk,
        detail: profileDetail,
      });
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

  if (command === "shadow") {
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
    const readJson = (path) => JSON.parse(readFileSync(resolve(path), "utf8"));
    const rehearsalBaseline = readJson(argOf(argv, "--baseline-rehearsal", join(cliRoot, "docs/cutover/m3-r/rehearsal-receipt.v1.json")));
    const inventoryBaseline = readJson(argOf(argv, "--baseline-inventory", join(cliRoot, "docs/cutover/m3-r/live-inventory.v1.json")));
    const baseline = {
      ...baselineFromRehearsalReceipt(rehearsalBaseline),
      deviceCount: deviceCountFromInventory(inventoryBaseline),
    };
    const receipt = await runShadow({
      sourceRoot: findRepoRoot(),
      snapshots,
      workDir: resolve(workDir),
      baseline,
    });
    const receiptOut = resolve(argOf(argv, "--receipt", join(cliRoot, "docs/cutover/m3-r/shadow-comparison.v1.json")));
    writeFileSync(receiptOut, `${JSON.stringify(receipt, null, 2)}\n`);
    emit(argv, { ok: receipt.verdict === "PASS", verdict: receipt.verdict, mismatches: receipt.mismatches, unknowns: receipt.unknowns, receipt: receiptOut });
    return receipt.verdict === "PASS" ? 0 : 1;
  }

  if (command === "tasks") {
    const runtimeRoot = argOf(argv, "--runtime-root", RUNTIME_ROOT_DEFAULT);
    const beforePath = join(cliRoot, "docs/cutover/m3-r/scheduled-tasks-before.v1.json");
    const beforeTasks = existsSync(beforePath) ? JSON.parse(readFileSync(beforePath, "utf8")).tasks ?? [] : [];
    const receipt = buildTasksProposedReceipt({ runtimeRoot, beforeTasks });
    const receiptOut = resolve(argOf(argv, "--receipt", join(cliRoot, "docs/cutover/m3-r/scheduled-tasks-proposed.v1.json")));
    const xmlDir = resolve(argOf(argv, "--xml-dir", join(dirname(receiptOut), "proposed-tasks")));
    mkdirSync(xmlDir, { recursive: true });
    for (const task of buildProposedTasks({ runtimeRoot })) {
      // UTF-16 LE（带 BOM）是 schtasks /create /xml 的推荐编码
      writeFileSync(join(xmlDir, `${task.name}.xml`), task.xml, "utf16le");
    }
    writeFileSync(receiptOut, `${JSON.stringify(receipt, null, 2)}\n`);
    emit(argv, { ok: receipt.ok, registration: receipt.registration, receipt: receiptOut, xmlDir });
    return receipt.ok ? 0 : 1;
  }

  if (command === "canary") {
    if (!has(argv, "--dry-run")) {
      process.stderr.write("canary 只支持 --dry-run（LIVE_CANARY_GATE=CLOSED）；真实执行属后续门\n");
      return 2;
    }
    const deviceId = argOf(argv, "--device");
    const actorId = argOf(argv, "--actor");
    if (!deviceId || !actorId) {
      process.stderr.write("missing --device ID / --actor ID\n");
      return 2;
    }
    const plan = runCanaryDryRun({ profile: buildCanaryProfile({ deviceId, actorId }) });
    const out = resolve(argOf(argv, "--out", join(cliRoot, "docs/cutover/m3-r/canary-plan.v1.json")));
    writeFileSync(out, `${JSON.stringify(plan, null, 2)}\n`);
    emit(argv, { ok: plan.ok, executed: plan.executed, liveCanaryGate: plan.liveCanaryGate, out, profileProblems: plan.profileValidation.problems });
    return plan.ok ? 0 : 1;
  }

  process.stderr.write(`${cutoverUsage()}\n`);
  return 2;
}

async function main(argv = process.argv.slice(2)) {
  if (argv[0] === "cutover") return cutoverMain(argv.slice(1));
  if (argv[0] === "m6") {
    const sub = argv.slice(1);
    if (sub[0] === "epoch") return m6EpochMain(sub.slice(1));
    return m6FrameMain(sub);
  }
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

// M6-2 closed frame capture thin client: forwards only alias/scenarioLabel/
// idempotencyKey (closedM6Input on the server rejects anything else). Output is
// redacted and machine-ready; it never loops and never flips the live gate.
async function m6FrameMain(argv) {
  // `xw m6 frame ...` — `frame` is a no-op sub-namespace prefix; strip it so the
  // command is the next token. (`xw m6 preflight ...` still works without it.)
  if (argv[0] === "frame") argv = argv.slice(1);
  const command = argv[0];
  if (!command || has(argv, "--help")) {
    process.stderr.write(`${m6FrameUsage()}\n`);
    return has(argv, "--help") ? 0 : 2;
  }
  const baseUrl = argOf(argv, "--control", process.env.XW_CONTROL_URL || "http://127.0.0.1:17920");
  const token = readToken(argv);
  const client = new ControlClient({ baseUrl, token });

  if (command === "preflight") {
    const result = await client.m6Preflight({
      alias: argOf(argv, "--alias"),
      scenarioLabel: argOf(argv, "--scenario", "observe"),
    });
    emit(argv, redact(result));
    return 0;
  }
  if (command === "capture") {
    const result = await client.m6Capture({
      alias: argOf(argv, "--alias"),
      scenarioLabel: argOf(argv, "--scenario", "observe"),
      idempotencyKey: argOf(argv, "--idempotency-key", argOf(argv, "--idempotency", "")),
    });
    emit(argv, redact(result));
    return 0;
  }
  if (command === "status") {
    const result = await client.m6Status(argOf(argv, "--attempt-id", ""));
    emit(argv, redact(result));
    return 0;
  }
  if (command === "closeout") {
    const result = await client.m6Closeout({
      attemptId: argOf(argv, "--attempt-id"),
      reason: argOf(argv, "--reason"),
    });
    emit(argv, redact(result));
    return 0;
  }
  process.stderr.write(`${m6FrameUsage()}\n`);
  return 2;
}

// M6-2 W8 #9 — `xw m6 epoch` offline gate operator tools. All commands are
// DRY-RUN BY DEFAULT (print the candidate + would-write paths); --yes performs
// the immutable write. No device I/O; the gate stays CLOSED/OBSERVE_ONLY on
// disk. The operator private key is OFF-REPO (--key-file); the CLI re-derives
// every epoch hash and re-signs over the hash bytes — no hand-crafted JSON.
function m6EpochUsage() {
  return `xw m6 epoch — M6-2 offline live-gate operator tools (zero-live, dry-run first)

  xw m6 epoch mint --gate-id G --release-id R --source-commit C --actor A
                   --allowlist 01,02 --expires-at ISO [--mode OBSERVE_ONLY]
                   --key-file priv.pem --key-id K [--issued-at ISO]
                   [--parent-hash H] [--m6-root DIR] [--issuer-keys FILE] [--yes]
  xw m6 epoch activate --gate-id G [--epoch-hash H | --latest]
                       [--promoted-at ISO] [--yes]
  xw m6 epoch close --gate-id G --reason R --key-file priv.pem --key-id K
                    --aggregate-seal H [--epoch-hash H] [--committed-at ISO]
                    [--closeout-id ID] [--yes]
  xw m6 epoch status --gate-id G
  xw m6 epoch verify --gate-id G            (re-verify all epochs: hash+signature+chain)
  xw m6 epoch rollback --gate-id G --to H --key-file priv.pem --key-id K
                       [--promoted-at ISO] [--yes]
  xw m6 epoch aggregate-closeout --gate-id G --audit-root DIR
                    --scenario-manifest FILE --resource-snapshot FILE [--yes]

--m6-root defaults to XW_RUNTIME_ROOT then the platform canonical root.
--issuer-keys defaults to <m6-root>/m6-gate/issuer-keys.json. Lock hashes are read
from the pinned <m6-root>/m6-gate/locks.v1.json (absent -> M6_LOCKS_MISSING).
Every write is immutable (refuse-overwrite, atomic temp->fsync->rename).`;
}

function epochErr(msg) {
  process.stderr.write(`m6 epoch: ${msg}\n`);
  return 2;
}

function m6RootOf(argv) {
  return argOf(argv, "--m6-root") || process.env.XW_RUNTIME_ROOT
    || (process.platform === "win32" ? "C:\\Users\\Public\\xw-runtime" : join(cliRoot, "xw-runtime"));
}

function issuerKeysDefault(m6Root) {
  return join(m6Root, "m6-gate", "issuer-keys.json");
}

function nowIso() {
  return new Date().toISOString();
}

function resolveSigner(argv, issuerKeysPath) {
  const keyId = argOf(argv, "--key-id");
  if (!keyId) return { error: "--key-id is required (the gate issuer allowlist key to sign with)" };
  const allowlist = loadGateIssuerAllowlist(issuerKeysPath);
  const key = allowlist.keys.get(keyId);
  if (!key) return { error: `--key-id ${keyId} is not in the issuer allowlist` };
  if (key.status !== "active") return { error: `--key-id ${keyId} is revoked in the issuer allowlist` };
  return { keyId, subject: key.subject, allowlistVersion: allowlist.version, allowlist };
}

async function m6EpochMint(argv) {
  const m6Root = m6RootOf(argv);
  const gateId = argOf(argv, "--gate-id");
  if (!gateId) return epochErr("--gate-id is required");
  const issuerKeysPath = argOf(argv, "--issuer-keys", issuerKeysDefault(m6Root));
  const releaseId = argOf(argv, "--release-id");
  const sourceCommit = argOf(argv, "--source-commit");
  const allowlistRaw = argOf(argv, "--allowlist", "");
  const allowlist = allowlistRaw ? allowlistRaw.split(",").map((s) => s.trim()).filter(Boolean) : [];
  const expiresAt = argOf(argv, "--expires-at");
  const mode = argOf(argv, "--mode", "OBSERVE_ONLY");
  const keyFile = argOf(argv, "--key-file");
  const issuedAt = argOf(argv, "--issued-at", nowIso());
  if (!releaseId) return epochErr("--release-id is required");
  if (!sourceCommit) return epochErr("--source-commit is required (40-hex sha1)");
  if (allowlist.length === 0) return epochErr("--allowlist is required (comma-separated aliases)");
  if (!expiresAt) return epochErr("--expires-at is required (ISO date-time, must be in the future)");
  if (!keyFile) return epochErr("--key-file is required (operator ed25519 private key, off-repo)");
  const signer = resolveSigner(argv, issuerKeysPath);
  if (signer.error) return epochErr(signer.error);
  const lockHashes = loadM6Locks(m6Root); // absent -> M6_LOCKS_MISSING fail-closed
  // Parent defaults to the active tail (chain continuity); null for the first epoch.
  let parentHash = argOf(argv, "--parent-hash", null);
  if (parentHash === null) {
    const active = readActiveGate({ m6Root, gateId, issuerAllowlistPath: issuerKeysPath });
    parentHash = active.tailEpochHash; // null when the chain is empty
  }
  // The epoch actor MUST equal the signing key's subject (verifyEpochProof binds them).
  const actor = signer.subject;
  const epoch = buildEpochRecord({
    gateId, mode, releaseId, sourceCommit, actor, allowlist, lockHashes,
    issuedAt, expiresAt, parentEpochHash: parentHash,
  });
  const proof = signEpochProof(epoch, keyFile, { keyId: signer.keyId, subject: signer.subject, allowlistVersion: signer.allowlistVersion });
  const epochPath = join(m6Root, "m6-gate", gateId, "epochs", `${epoch.epochHash}.json`);
  const plan = {
    dryRun: !has(argv, "--yes"),
    gateId,
    epoch: { epochHash: epoch.epochHash, mode: epoch.mode, actor: epoch.actor, allowlist: epoch.allowlist, parentEpochHash: epoch.parentEpochHash, expiresAt: epoch.expiresAt },
    lockHashes,
    proof: { keyId: proof.keyId, subject: proof.subject, allowlistVersion: proof.allowlistVersion, algorithm: proof.algorithm },
    path: epochPath,
  };
  if (plan.dryRun) {
    emit(argv, plan);
    return 0;
  }
  const written = mintEpoch({ m6Root, gateId, epoch, proof });
  emit(argv, { ...plan, dryRun: false, written });
  return 0;
}

async function m6EpochActivate(argv) {
  const m6Root = m6RootOf(argv);
  const gateId = argOf(argv, "--gate-id");
  if (!gateId) return epochErr("--gate-id is required");
  const issuerKeysPath = argOf(argv, "--issuer-keys", issuerKeysDefault(m6Root));
  const promotedAt = argOf(argv, "--promoted-at", nowIso());
  const useLatest = has(argv, "--latest");
  const explicitHash = argOf(argv, "--epoch-hash");
  if (!useLatest && !explicitHash) return epochErr("activate requires --epoch-hash or --latest");
  if (useLatest && explicitHash) return epochErr("activate: use --epoch-hash OR --latest, not both");
  const active = readActiveGate({ m6Root, gateId, issuerAllowlistPath: issuerKeysPath });
  const epochHash = explicitHash || (useLatest ? resolveLatestEpoch({ m6Root, gateId, issuerAllowlistPath: issuerKeysPath }) : null);
  if (!epochHash) return epochErr("--latest found no unactivated epoch binding to the current tail");
  if (active.chain.includes(epochHash)) return epochErr(`epoch ${epochHash} is already active`);
  const newChain = [...active.chain, epochHash];
  const currentPath = join(m6Root, "m6-gate", gateId, "current.json");
  const plan = {
    dryRun: !has(argv, "--yes"),
    gateId, epochHash, newChain, tailEpochHash: epochHash, currentPath, promotedAt,
  };
  if (plan.dryRun) {
    emit(argv, plan);
    return 0;
  }
  const written = activateGate({ m6Root, gateId, chain: newChain, tailEpochHash: epochHash, promotedAt });
  emit(argv, { ...plan, dryRun: false, written });
  return 0;
}

async function m6EpochClose(argv) {
  const m6Root = m6RootOf(argv);
  const gateId = argOf(argv, "--gate-id");
  if (!gateId) return epochErr("--gate-id is required");
  const issuerKeysPath = argOf(argv, "--issuer-keys", issuerKeysDefault(m6Root));
  const reason = argOf(argv, "--reason");
  const keyFile = argOf(argv, "--key-file");
  const aggregateSealHash = argOf(argv, "--aggregate-seal");
  if (!reason) return epochErr("--reason is required");
  if (!keyFile) return epochErr("--key-file is required (to sign the CLOSED sealing epoch)");
  if (!aggregateSealHash || !/^[0-9a-f]{64}$/.test(aggregateSealHash)) return epochErr("--aggregate-seal is required (64-hex seal from the complete 80-run oracle)");
  const signer = resolveSigner(argv, issuerKeysPath);
  if (signer.error) return epochErr(signer.error);
  const committedAt = argOf(argv, "--committed-at", nowIso());
  const closeoutId = argOf(argv, "--closeout-id");
  const active = readActiveGate({ m6Root, gateId, issuerAllowlistPath: issuerKeysPath });
  if (active.chain.length === 0) return epochErr("cannot close a gate with no active epoch");
  const epochHash = argOf(argv, "--epoch-hash", active.tailEpochHash);
  if (epochHash !== active.tailEpochHash) return epochErr("--epoch-hash must be the current tail epoch (close seals the active gate)");
  const target = active.epochs.find((e) => e.epochHash === epochHash);
  if (!target) return epochErr(`epoch ${epochHash} is not in the active chain`);
  const aggregatePath = join(m6Root, "m6-gate", gateId, "aggregate", `${aggregateSealHash}.json`);
  if (!existsSync(aggregatePath)) return epochErr(`aggregate seal not found: ${aggregateSealHash}`);
  const aggregate = JSON.parse(readFileSync(aggregatePath, "utf8"));
  if (aggregate.schemaId !== "xw.m6-aggregate-closeout.v1" || aggregate.sealHash !== aggregateSealHash
    || aggregate.epochHash !== epochHash || deriveM6AggregateSealHash(aggregate.sealPayload) !== aggregateSealHash
    || aggregate.sealPayload?.attempts?.length !== 80 || aggregate.attemptCount !== 80) {
    return epochErr("aggregate seal is forged, incomplete, or bound to another epoch");
  }
  const actor = signer.subject;
  const closeout = buildCloseoutRecord({ epochHash, actor, reason, committedAt, closeoutId });
  const closedEpoch = buildEpochRecord({
    gateId,
    mode: "CLOSED",
    releaseId: target.releaseId,
    sourceCommit: target.sourceCommit,
    actor,
    allowlist: target.allowlist,
    lockHashes: active.lockHashes,
    issuedAt: committedAt,
    expiresAt: target.expiresAt,
    parentEpochHash: active.tailEpochHash,
    closeoutRef: { id: closeout.closeoutId, sha256: closeout.closeoutHash },
    aggregateSealRef: { id: aggregateSealHash, sha256: aggregateSealHash },
  });
  const proof = signEpochProof(closedEpoch, keyFile, { keyId: signer.keyId, subject: signer.subject, allowlistVersion: signer.allowlistVersion });
  const newChain = [...active.chain, closedEpoch.epochHash];
  const promotedAt = argOf(argv, "--promoted-at", committedAt);
  const plan = {
    dryRun: !has(argv, "--yes"),
    gateId,
    closeout: { closeoutId: closeout.closeoutId, closeoutHash: closeout.closeoutHash, epochHash, path: join(m6Root, "m6-gate", gateId, "closeouts", `${closeout.closeoutId}.json`) },
    closedEpoch: { epochHash: closedEpoch.epochHash, parentEpochHash: closedEpoch.parentEpochHash, closeoutRef: closedEpoch.closeoutRef, aggregateSealRef: closedEpoch.aggregateSealRef, path: join(m6Root, "m6-gate", gateId, "epochs", `${closedEpoch.epochHash}.json`) },
    newChain, tailEpochHash: closedEpoch.epochHash, currentPath: join(m6Root, "m6-gate", gateId, "current.json"), promotedAt,
  };
  if (plan.dryRun) {
    emit(argv, plan);
    return 0;
  }
  writeCloseout({ m6Root, gateId, closeout });
  mintEpoch({ m6Root, gateId, epoch: closedEpoch, proof });
  const written = activateGate({ m6Root, gateId, chain: newChain, tailEpochHash: closedEpoch.epochHash, promotedAt });
  emit(argv, { ...plan, dryRun: false, written });
  return 0;
}

async function m6EpochStatus(argv) {
  const m6Root = m6RootOf(argv);
  const gateId = argOf(argv, "--gate-id");
  if (!gateId) return epochErr("--gate-id is required");
  const issuerKeysPath = argOf(argv, "--issuer-keys", issuerKeysDefault(m6Root));
  const active = readActiveGate({ m6Root, gateId, issuerAllowlistPath: issuerKeysPath });
  const result = evaluateM6Gate({ chain: active.epochs, closeouts: active.closeouts, aggregates: active.aggregates, nowMs: Date.now(), lockHashes: active.lockHashes });
  emit(argv, {
    gateId,
    mode: result.mode,
    activeEpochHash: result.activeEpochHash,
    epochCount: active.epochs.length,
    tailEpochHash: active.tailEpochHash,
    allowlist: result.activeEpoch?.allowlist ?? [],
    expiresAt: result.activeEpoch?.expiresAt ?? null,
    lockHashes: active.lockHashes,
    errors: result.errors.map((e) => e.code),
  });
  return 0;
}

async function m6EpochVerify(argv) {
  const m6Root = m6RootOf(argv);
  const gateId = argOf(argv, "--gate-id");
  if (!gateId) return epochErr("--gate-id is required");
  const issuerKeysPath = argOf(argv, "--issuer-keys", issuerKeysDefault(m6Root));
  const loaded = loadM6Gate({ m6Root, gateId, issuerAllowlistPath: issuerKeysPath });
  const result = evaluateM6Gate({ chain: loaded.chain, closeouts: loaded.closeouts, aggregates: loaded.aggregates, nowMs: Date.now(), lockHashes: loaded.lockHashes });
  const ok = result.errors.length === 0 && loaded.chain.length > 0;
  emit(argv, { gateId, ok, epochs: loaded.chain.length, mode: result.mode, errors: result.errors.map((e) => e.code) });
  return ok ? 0 : 1;
}

async function m6EpochRollback(argv) {
  const m6Root = m6RootOf(argv);
  const gateId = argOf(argv, "--gate-id");
  if (!gateId) return epochErr("--gate-id is required");
  const to = argOf(argv, "--to");
  if (!to) return epochErr("--to is required (a prior CLOSED epoch hash)");
  const issuerKeysPath = argOf(argv, "--issuer-keys", issuerKeysDefault(m6Root));
  const keyFile = argOf(argv, "--key-file");
  if (!keyFile) return epochErr("--key-file is required (rollback appends a newly signed CLOSED epoch)");
  const signer = resolveSigner(argv, issuerKeysPath);
  if (signer.error) return epochErr(signer.error);
  const promotedAt = argOf(argv, "--promoted-at", nowIso());
  const active = readActiveGate({ m6Root, gateId, issuerAllowlistPath: issuerKeysPath });
  const target = active.epochs.find((epoch) => epoch.epochHash === to);
  if (!target || target.mode !== "CLOSED") return epochErr("--to must identify a prior CLOSED epoch in the active chain; OBSERVE_ONLY rollback is forbidden");
  const rollbackEpoch = buildEpochRecord({
    gateId,
    mode: "CLOSED",
    releaseId: target.releaseId,
    sourceCommit: target.sourceCommit,
    actor: signer.subject,
    allowlist: target.allowlist,
    lockHashes: target.lockHashes,
    issuedAt: promotedAt,
    expiresAt: target.expiresAt,
    parentEpochHash: active.tailEpochHash,
    closeoutRef: target.closeoutRef,
    aggregateSealRef: target.aggregateSealRef,
    rollbackTargetEpochHash: target.epochHash,
  });
  const proof = signEpochProof(rollbackEpoch, keyFile, { keyId: signer.keyId, subject: signer.subject, allowlistVersion: signer.allowlistVersion });
  const currentPath = join(m6Root, "m6-gate", gateId, "current.json");
  const plan = { dryRun: !has(argv, "--yes"), gateId, rollbackTargetEpochHash: to, epochHash: rollbackEpoch.epochHash, parentEpochHash: rollbackEpoch.parentEpochHash, currentPath, promotedAt };
  if (plan.dryRun) {
    emit(argv, plan);
    return 0;
  }
  const written = rollbackGate({ m6Root, gateId, epoch: rollbackEpoch, proof, promotedAt, issuerAllowlistPath: issuerKeysPath });
  emit(argv, { ...plan, dryRun: false, written });
  return 0;
}

// M6-2 W8 #5 — `xw m6 epoch aggregate-closeout`. Loads the active OBSERVE_ONLY
// epoch + the per-attempt audit records (receipt + closeout) from --audit-root,
// runs the pure four-alias verifier, and (with --yes) writes the immutable
// aggregate seal to m6-gate/<gateId>/aggregate/<sealHash>.json. Dry-run default.
async function m6EpochAggregateCloseout(argv) {
  const m6Root = m6RootOf(argv);
  const gateId = argOf(argv, "--gate-id");
  if (!gateId) return epochErr("--gate-id is required");
  const auditRoot = argOf(argv, "--audit-root");
  if (!auditRoot) return epochErr("--audit-root is required (the frame-capture audit root holding <attemptId>.json + <attemptId>.closeout.json)");
  const scenarioManifestPath = argOf(argv, "--scenario-manifest");
  if (!scenarioManifestPath) return epochErr("--scenario-manifest is required (pre-written 4-alias x 20-run oracle)");
  const resourceSnapshotPath = argOf(argv, "--resource-snapshot");
  if (!resourceSnapshotPath) return epochErr("--resource-snapshot is required (independent before/after zero-resource proof)");
  const issuerKeysPath = argOf(argv, "--issuer-keys", issuerKeysDefault(m6Root));
  const active = readActiveGate({ m6Root, gateId, issuerAllowlistPath: issuerKeysPath });
  if (active.chain.length === 0) return epochErr("gate has no active epoch — mint + activate an OBSERVE_ONLY epoch first");
  const tailEpoch = active.epochs[active.epochs.length - 1];
  if (tailEpoch.mode !== "OBSERVE_ONLY") return epochErr(`active tail epoch is ${tailEpoch.mode}, not OBSERVE_ONLY — aggregate closeout seals an observe window`);

  // Read the audit trail: <attemptId>.json = { receipt, frame } and
  // <attemptId>.closeout.json = { closeout }. Pair by attemptId.
  const root = resolve(auditRoot);
  if (!existsSync(root)) return epochErr(`--audit-root not found: ${root}`);
  const scenarioManifest = JSON.parse(readFileSync(resolve(scenarioManifestPath), "utf8"));
  const resourceSnapshot = JSON.parse(readFileSync(resolve(resourceSnapshotPath), "utf8"));
  const closeoutsByAttempt = new Map();
  const receiptFiles = [];
  for (const name of readdirSync(root)) {
    if (!name.endsWith(".json")) continue;
    if (name.endsWith(".closeout.json")) {
      const attemptId = name.slice(0, -".closeout.json".length);
      let record;
      try { record = JSON.parse(readFileSync(join(root, name), "utf8")); } catch { continue; }
      closeoutsByAttempt.set(attemptId, record && record.closeout ? record.closeout : null);
    } else {
      receiptFiles.push(name);
    }
  }
  const attempts = [];
  for (const name of receiptFiles) {
    const attemptId = name.slice(0, -".json".length);
    let record;
    try { record = JSON.parse(readFileSync(join(root, name), "utf8")); } catch { continue; }
    const receipt = record && record.receipt ? record.receipt : null;
    attempts.push({ receipt, frame: record?.frame ?? null, closeout: closeoutsByAttempt.get(attemptId) || null });
  }
  // Closeouts with no receipt file are still surfaced (orphan detection).
  for (const [attemptId, closeout] of closeoutsByAttempt) {
    if (!receiptFiles.includes(`${attemptId}.json`)) attempts.push({ receipt: null, closeout });
  }

  const result = verifyAggregateCloseout({ epoch: tailEpoch, attempts, scenarioManifest, resourceSnapshot });
  const plan = {
    dryRun: !has(argv, "--yes"),
    gateId,
    epochHash: tailEpoch.epochHash,
    allowlist: tailEpoch.allowlist,
    auditRoot: root,
    scenarioManifest: resolve(scenarioManifestPath),
    resourceSnapshot: resolve(resourceSnapshotPath),
    ok: result.ok,
    sealHash: result.sealHash,
    aliases: result.aliases,
    attemptCount: result.attemptCount,
    errors: result.errors,
  };
  if (!result.ok) {
    emit(argv, plan);
    return 1;
  }
  const sealPath = join(m6Root, "m6-gate", gateId, "aggregate", `${result.sealHash}.json`);
  if (plan.dryRun) {
    emit(argv, { ...plan, sealPath });
    return 0;
  }
  const written = writeImmutableJson(sealPath, {
    schemaId: "xw.m6-aggregate-closeout.v1",
    gateId,
    epochHash: tailEpoch.epochHash,
    sealHash: result.sealHash,
    sealPayload: result.sealPayload,
    aliases: result.aliases,
    attemptCount: result.attemptCount,
    committedAt: nowIso(),
  });
  emit(argv, { ...plan, dryRun: false, sealPath, written });
  return 0;
}

async function m6EpochMain(argv) {
  const command = argv[0];
  if (!command || has(argv, "--help")) {
    process.stderr.write(`${m6EpochUsage()}\n`);
    return has(argv, "--help") ? 0 : 2;
  }
  try {
    if (command === "mint") return await m6EpochMint(argv);
    if (command === "activate") return await m6EpochActivate(argv);
    if (command === "close") return await m6EpochClose(argv);
    if (command === "status") return await m6EpochStatus(argv);
    if (command === "verify") return await m6EpochVerify(argv);
    if (command === "rollback") return await m6EpochRollback(argv);
    if (command === "aggregate-closeout") return await m6EpochAggregateCloseout(argv);
    process.stderr.write(`${m6EpochUsage()}\n`);
    return 2;
  } catch (error) {
    process.stderr.write(`${error.code || "M6_EPOCH_ERROR"}: ${error.message}\n`);
    return 1;
  }
}

export { main, redact };
