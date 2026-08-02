import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

const ROOT = path.resolve(import.meta.dirname, "..");
const TOKEN = "registry-test-token";
const HUMAN_TOKEN = "registry-test-human-token";
const OBSERVER_TOKEN = "registry-test-observer-token";
const OPERATOR_TOKEN = "registry-test-operator-token";
// 真实 PNG 头字节（魔数 89 50 4E 47）+ IHDR 片段；Screen API 只校验魔数/SHA/字节数，不需完整可解码 PNG。
const SCREEN_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);
const SCREEN_SHA = createHash("sha256").update(SCREEN_PNG).digest("hex");
const now = Date.now();

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function createRegistryDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE knowledge (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL DEFAULT 'global', app TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'pitfall', title TEXT NOT NULL, content TEXT NOT NULL,
      verified_by_json TEXT NOT NULL DEFAULT '[]', needs_engineer INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);
  const insert = db.prepare(`INSERT INTO knowledge
    (id,scope,app,category,title,content,verified_by_json,needs_engineer,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const iso = new Date(now).toISOString();
  insert.run("xianyu-2x5-timeout-restoration-recovery-20260726", "global", "xianyu", "pitfall", "02 老超时", "已解决", "[]", 1, iso, iso);
  insert.run("xianyu-02-sku-not-on-compose-recovery-20260726", "global", "xianyu", "pitfall", "02 老指纹", "已解决", "[]", 1, iso, iso);
  insert.run("xianyu-03-physical-disconnect-gateway-probe-20260726", "device:REPLACE_SERIAL_03", "xianyu", "pitfall", "03 物理断连", "等待现场重插", "[]", 0, iso, iso);
  db.close();
}

function createControlDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE devices (device_id TEXT PRIMARY KEY, alias TEXT, routing_json TEXT);
    CREATE TABLE jobs (
      job_id TEXT PRIMARY KEY, run_id TEXT, actor_id TEXT, device_id TEXT, capability_id TEXT,
      capability_json TEXT, params_json TEXT, status TEXT, error_code TEXT,
      created_at INTEGER, updated_at INTEGER, started_at INTEGER, finished_at INTEGER
    );
    CREATE TABLE approvals (
      approval_id TEXT PRIMARY KEY, job_id TEXT, decision TEXT, actor_id TEXT, reason TEXT, created_at INTEGER
    );
    CREATE TABLE evidence (
      evidence_id TEXT PRIMARY KEY, job_id TEXT, run_id TEXT, kind TEXT, path TEXT,
      sha256 TEXT, bytes INTEGER, created_at INTEGER
    );
  `);
  // dev-01 已采集截图（run-succ-2）—— cache-only Screen API 读这条
  db.prepare("INSERT INTO evidence VALUES (?,?,?,?,?,?,?,?)").run(
    "ev-1", "job-succ-2", "run-succ-2", "screenshot", "evidence/shot-aaaaaaaaaaaa.png",
    SCREEN_SHA, SCREEN_PNG.length, now - 5000);
  db.prepare("INSERT INTO devices VALUES (?,?,?)").run("dev-01", "01",
    JSON.stringify({ enabled: true, tags: ["slot:01"], capabilityIds: ["xianyu.publish.open_dry_run", "xianyu.publish.save_draft_dry_run"] }));
  db.prepare("INSERT INTO devices VALUES (?,?,?)").run("dev-03", "03",
    JSON.stringify({ enabled: true, tags: ["slot:03"], capabilityIds: ["xianyu.publish.open_dry_run"] }));
  // dev-02：routing.enabled=false——placement 会拒，eligibleAliases 必须不含 02（disabled-routing 反例守卫）
  db.prepare("INSERT INTO devices VALUES (?,?,?)").run("dev-02", "02",
    JSON.stringify({ enabled: false, tags: ["slot:02"], capabilityIds: ["xianyu.publish.open_dry_run"] }));
  const insert = db.prepare(`INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  insert.run("job-running", "run-running", "agent-alpha", "dev-01", "xianyu.publish.open_dry_run",
    JSON.stringify({ id: "xianyu.publish.open_dry_run", appId: "xianyu", risk: "R0" }), "{}", "running", null,
    now - 5000, now - 1000, now - 4000, null);
  insert.run("job-failed", "run-failed", "agent-beta", "dev-03", "xianyu.publish.open_dry_run",
    JSON.stringify({ id: "xianyu.publish.open_dry_run", appId: "xianyu", risk: "R0" }), "{}", "recovery_required", "ADAPTER_FAILED",
    now - 9000, now - 2000, now - 8000, now - 2000);
  insert.run("job-approval", "run-approval", "human-request", "dev-01", "xhs.comment.send",
    JSON.stringify({ id: "xhs.comment.send", appId: "xhs", risk: "R2" }), JSON.stringify({ text: "secret parameter must stay off entry" }), "waiting_approval", null,
    now - 3000, now - 3000, null, null);
  // dev-01：老失败之后连续两次成功 → unresolvedFailure 应为 null、streak=2（recentFailure 语义修正的核心用例）
  insert.run("job-old-fail", "run-old-fail", "agent-alpha", "dev-01", "xianyu.publish.open_dry_run",
    JSON.stringify({ id: "xianyu.publish.open_dry_run", appId: "xianyu", risk: "R0" }), "{}", "failed", "ADAPTER_INVALID_JSON",
    now - 20000, now - 8000, now - 19000, now - 8000);
  insert.run("job-succ-1", "run-succ-1", "agent-alpha", "dev-01", "xianyu.publish.open_dry_run",
    JSON.stringify({ id: "xianyu.publish.open_dry_run", appId: "xianyu", risk: "R0" }), "{}", "succeeded", null,
    now - 7000, now - 6000, now - 6900, now - 6000);
  insert.run("job-succ-2", "run-succ-2", "agent-alpha", "dev-01", "xianyu.publish.full_draft_dry_run",
    JSON.stringify({ id: "xianyu.publish.full_draft_dry_run", appId: "xianyu", risk: "R1" }), "{}", "succeeded", null,
    now - 5600, now - 5000, now - 5500, now - 5000);
  db.close();
}

function createControlServer() {
  const decisions = [];
  const submissions = [];
  const paymentDecisions = [];
  // 固定一个待确认的资金最终提交；binding 字段满足 xhs.payment-approval.v1 schema 形状。
  const paymentCommits = [{
    commitId: "protected_commit_pay_fixture",
    status: "waiting_authorization",
    action: "payment",
    effectId: "effect-payment-1",
    expiresAt: new Date(now + 120000).toISOString(),
    approvalBinding: {
      runId: "run_pay_fixture",
      effectId: "effect-payment-1",
      app: "fixture-pay",
      accountRef: "redacted:account",
      payeeRef: "redacted:merchant",
      amount: "88.00",
      currency: "CNY",
      targetControlFingerprint: "fp:observed-final-control",
      snapshotHash: "a".repeat(64),
      deviceId: "fixture-device",
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 120000).toISOString(),
    },
  }];
  const server = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/control/v1/health") return json(res, 200, {
      nodeId: "test-node", authority: true, activeLeases: 1,
      policyMode: { mode: "shadow", active: false, effectiveDecisionSource: "shadow", adapterKind: "real" },
      releaseId: "health-release-fallback",
      runtimePolicyVersion: "xhs.nonpayment-autonomy.v1",
    });
    if (req.method === "GET" && req.url === "/control/v1/devices") return json(res, 200, { devices: [
      { deviceId: "dev-01", alias: "01", online: true, quarantined: false },
      { deviceId: "dev-03", alias: "03", online: true, quarantined: true, quarantineReason: "ADAPTER_FAILED" },
    ] });
    if (req.method === "GET" && req.url === "/control/v1/capabilities") return json(res, 200, { capabilities: [
      { id: "xianyu.publish.open_dry_run", appId: "xianyu", risk: "R1", maturity: "E2", idempotency: "replay_safe",
        timeoutMs: 60000, resources: ["device"], restoration: { required: true }, verification: { mode: "state" },
        automationPolicy: { mode: "automatic" } },
      // 字面 automatic 但外部效应 → 必须被推导成 approvalRequired 并触发 lint
      { id: "xianyu.publish.save_draft_dry_run", appId: "xianyu", risk: "R1", maturity: "E2", idempotency: "external_effect",
        timeoutMs: 90000, resources: ["device"], restoration: { required: false }, verification: { mode: "state" },
        automationPolicy: { mode: "automatic" } },
      { id: "xhs.comment.send", appId: "xhs", risk: "R2", maturity: "E2", idempotency: "ambiguous_on_timeout",
        timeoutMs: 90000, resources: ["device"], restoration: { required: true }, verification: { mode: "state" },
        automationPolicy: { mode: "approval_required" } },
    ] });
    if (req.method === "GET" && req.url === "/control/v1/leases") return json(res, 200, { leases: [
      { deviceId: "dev-01", holderId: "agent-alpha", kind: "job", expiresAt: new Date(now + 60000).toISOString() },
    ] });
    if (req.method === "POST" && req.url.startsWith("/control/v1/approvals/")) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      decisions.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && req.url === "/control/v1/jobs") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      submissions.push(body);
      const jobId = `job-op-${submissions.length}`;
      return json(res, 202, { ok: true, job: { jobId, deviceId: body.deviceId, capabilityId: body.capabilityId, actorId: body.actor, status: "queued" } });
    }
    const jobMatch = req.url.match(/^\/control\/v1\/jobs\/([^/]+)$/);
    if (req.method === "GET" && jobMatch) {
      return json(res, 200, { ok: true, job: { jobId: jobMatch[1], status: "queued" } });
    }
    if (req.method === "GET" && req.url === "/control/v1/payment-commits") {
      return json(res, 200, { paymentCommits });
    }
    const payDecideMatch = req.url.match(/^\/control\/v1\/payment-commits\/([^/]+)\/decide$/);
    if (req.method === "POST" && payDecideMatch) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      paymentDecisions.push({ commitId: payDecideMatch[1], ...body });
      const status = body.decision === "approve" ? "verified" : "cancelled";
      return json(res, 200, { ok: true, paymentCommit: { status } });
    }
    return json(res, 404, { ok: false });
  });
  return { server, decisions, submissions, paymentDecisions, paymentCommits };
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

async function startRegistry({ root, controlUrl, requireAuth = true, extraArgs = [], probeToken = null, nodeArgs = [], env = {} }) {
  const port = await freePort();
  const args = [...nodeArgs, path.join(ROOT, "registry.mjs"), "--port", String(port), "--host", "127.0.0.1",
    "--control", controlUrl, "--db", path.join(root, "registry.db"), "--seed", path.join(root, "seed.json"),
    "--control-db", path.join(root, "control.db")];
  if (requireAuth) args.push("--agent-token", TOKEN, "--human-token", HUMAN_TOKEN, "--trust-loopback", "false",
    "--observer-token", OBSERVER_TOKEN, "--operator-token", OPERATOR_TOKEN);
  args.push(...extraArgs);
  const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`registry exited early: ${logs}`);
    try {
      const probe = probeToken || (requireAuth ? TOKEN : null);
      const response = await fetch(`${base}/api/health`, probe ? { headers: { "x-registry-token": probe } } : {});
      if (response.ok) return { child, base, logs: () => logs };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  child.kill("SIGTERM");
  throw new Error(`registry did not start: ${logs}`);
}

async function stopRegistry(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 1000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

let tempRoot;
let control;
let registry;
let runsRoot;
let paymentSignerKeysFile;
let paymentSignerPublicKey;

test.before(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "xhs-registry-test-"));
  createRegistryDb(path.join(tempRoot, "registry.db"));
  createControlDb(path.join(tempRoot, "control.db"));
  await writeFile(path.join(tempRoot, "seed.json"), JSON.stringify({ identities: [
    { alias: "01", serial: "serial-01", label: "一号 <script>alert(1)</script>", model: "M1", accounts: { xhs: "private-account" }, notes: "private-note" },
    { alias: "03", serial: "REPLACE_SERIAL_03", label: "三店", model: "M3" },
  ] }));
  // REX Phase 2 收尾: 人类支付签名 oracle 的 Ed25519 私钥（受限文件，绝不进 argv 值/URL/日志/HTML/DB/仓库）。
  const paymentKeypair = generateKeyPairSync("ed25519");
  paymentSignerPublicKey = paymentKeypair.publicKey;
  paymentSignerKeysFile = path.join(tempRoot, "payment-signer-keys.json");
  await writeFile(paymentSignerKeysFile, JSON.stringify({
    keyId: "payment-human-1",
    subject: "human:owner",
    allowlistVersion: 3,
    privateKeyPem: paymentKeypair.privateKey.export({ type: "pkcs8", format: "pem" }),
  }));
  // cache-only Screen API 的 runs-root：放一张假截图供 evidence 行读取
  runsRoot = path.join(tempRoot, "runs");
  await mkdir(path.join(runsRoot, "run-succ-2", "evidence"), { recursive: true });
  await writeFile(path.join(runsRoot, "run-succ-2", "evidence", "shot-aaaaaaaaaaaa.png"), SCREEN_PNG);
  control = createControlServer();
  control.server.listen(0, "127.0.0.1");
  await once(control.server, "listening");
  registry = await startRegistry({ root: tempRoot, controlUrl: `http://127.0.0.1:${control.server.address().port}`,
    extraArgs: ["--runs-root", runsRoot, "--payment-signer-keys-file", paymentSignerKeysFile] });
});

// 与 B 仓 payment-approval-verifier 的 canonicalPaymentApprovalBytes 逐字节一致：递归排序键后 JSON。
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonicalize(value[k])]));
  }
  return value;
}
function canonicalJson(value) { return JSON.stringify(canonicalize(value)); }

test.after(async () => {
  await stopRegistry(registry.child);
  control.server.close();
  await rm(tempRoot, { recursive: true, force: true });
});

test("agent entry aggregates leases, jobs, blockers and omits private identity fields", async () => {
  const response = await fetch(`${registry.base}/api/agent-entry`, { headers: { "x-registry-token": TOKEN } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const entry = await response.json();
  assert.equal(entry.schemaVersion, "xhs.agent-entry.v2");
  assert.match(entry.protocol.entrypoints.controlPlaneReload, /XhsDeviceControlPlaneV1|control-plane-task\.ps1/);
  for (const alias of ["01", "02", "03", "04"]) {
    assert.match(entry.protocol.entrypoints[`serveReload${alias}`], new RegExp(`serve-restart-${alias}\\.ps1`));
  }
  const protocol = JSON.stringify(entry.protocol);
  assert.doesNotMatch(protocol, /--serial\b|--token\b|x-control-token|22222|XHS_ALLOW_BYPASS|fast-operator\.mjs/i);
  const dev01 = entry.devices.find((item) => item.alias === "01");
  const dev03 = entry.devices.find((item) => item.alias === "03");
  assert.equal(dev01.activeJobs[0].jobId, "job-running");
  // 语义修正核心：01 有历史失败但之后连续成功 → 不算未解决失败
  assert.equal(dev01.jobStatus.unresolvedFailure, null);
  assert.equal(dev01.recentFailure, null);
  assert.equal(dev01.jobStatus.consecutiveSuccesses, 2);
  assert.equal(dev01.jobStatus.lastSuccess.jobId, "job-succ-2");
  assert.equal(dev01.jobStatus.lastFailure.jobId, "job-old-fail");
  assert.equal(dev01.state.online, true);
  assert.equal(dev01.state.leaseFree, false);
  assert.equal(dev01.state.ready, false);
  // 03 失败后无成功 → unresolved 保持可见；隔离中 ready=false
  assert.equal(dev03.recentFailure.errorCode, "ADAPTER_FAILED");
  assert.equal(dev03.jobStatus.unresolvedFailure.jobId, "job-failed");
  assert.equal(dev03.state.quarantined, true);
  assert.equal(dev03.state.ready, false);
  assert.equal(entry.sources.identityCache.stale, false);
  assert.equal(typeof entry.sources.identityCache.ageSeconds, "number");
  assert.equal(entry.blockers.active[0].id, "xianyu-03-physical-disconnect-gateway-probe-20260726");
  assert.equal(entry.blockers.active.length, 1);
  assert.equal(entry.blockers.resolved.length, 2);
  assert.equal(entry.approvals.pendingCount, 1);
  const serialized = JSON.stringify(entry);
  assert.doesNotMatch(serialized, /private-account|private-note|secret parameter/);
  assert.doesNotMatch(serialized, /"accounts"|"notes"|"customer"/);
});

// REX Phase 6 P6-A: agent-entry must display runtime policy, releaseId and the full
// policyDocDebt from the cross-repo release manifest (written by control-plane-task.ps1).
test("agent-entry exposes the cross-repo release manifest (release/modes/schema/policyDocDebt)", async () => {
  const releaseDir = path.join(tempRoot, "release-state-present");
  await mkdir(releaseDir, { recursive: true });
  const manifest = {
    schemaId: "xhs.cross-repo-release.v1",
    schemaVersion: 1,
    releaseId: "rel-shadow-test-01",
    registryCommit: "a".repeat(40),
    deviceAgentCommit: "b".repeat(40),
    windowsRegistryCommit: "c".repeat(40),
    taskLaunchCommit: "d".repeat(40),
    policyMode: "shadow",
    evidenceMode: "dual",
    runtimePolicyVersion: "xhs.nonpayment-autonomy.v1",
    effectiveDecisionSource: "shadow",
    policyDocDebt: [
      { path: "skills/xhs/SKILL.md", legacyRule: "needs approval", supersededForRelease: "rel-shadow-test-01" },
    ],
    schemaContracts: [],
    deployedAt: new Date().toISOString(),
  };
  await writeFile(path.join(releaseDir, "cross-repo-release.json"), JSON.stringify(manifest));
  const reg = await startRegistry({ root: tempRoot, controlUrl: `http://127.0.0.1:${control.server.address().port}`,
    extraArgs: ["--runs-root", runsRoot, "--payment-signer-keys-file", paymentSignerKeysFile],
    env: { CONTROL_PLANE_STATE_DIR: releaseDir } });
  try {
    const response = await fetch(`${reg.base}/api/agent-entry`, { headers: { "x-registry-token": TOKEN } });
    assert.equal(response.status, 200);
    const entry = await response.json();
    assert.equal(entry.release.present, true);
    assert.equal(entry.release.releaseId, "rel-shadow-test-01");
    assert.equal(entry.release.policyMode, "shadow");
    assert.equal(entry.release.evidenceMode, "dual");
    assert.equal(entry.release.runtimePolicyVersion, "xhs.nonpayment-autonomy.v1");
    assert.equal(entry.release.effectiveDecisionSource, "shadow");
    assert.deepEqual(entry.release.policyDocDebt, manifest.policyDocDebt);
    assert.equal(entry.release.policyDocDebtCount, 1);
    assert.equal(entry.release.policyDocDebtClean, false);
  } finally {
    await stopRegistry(reg.child);
  }
});

test("agent-entry release block degrades (present=false, empty debt) without a release manifest", async () => {
  const emptyDir = path.join(tempRoot, "release-state-absent");
  await mkdir(emptyDir, { recursive: true });
  const reg = await startRegistry({ root: tempRoot, controlUrl: `http://127.0.0.1:${control.server.address().port}`,
    extraArgs: ["--runs-root", runsRoot, "--payment-signer-keys-file", paymentSignerKeysFile],
    env: { CONTROL_PLANE_STATE_DIR: emptyDir } });
  try {
    const response = await fetch(`${reg.base}/api/agent-entry`, { headers: { "x-registry-token": TOKEN } });
    assert.equal(response.status, 200);
    const entry = await response.json();
    assert.equal(entry.release.present, false);
    // manifest 缺省时以 control-plane health 上报的 policy/release 兜底（不猜、不 500）。
    assert.equal(entry.release.releaseId, "health-release-fallback");
    assert.equal(entry.release.policyMode, "shadow");
    assert.equal(entry.release.runtimePolicyVersion, "xhs.nonpayment-autonomy.v1");
    assert.equal(entry.release.effectiveDecisionSource, "shadow");
    assert.deepEqual(entry.release.policyDocDebt, []);
    assert.equal(entry.release.policyDocDebtCount, 0);
    assert.equal(entry.release.policyDocDebtClean, true);
  } finally {
    await stopRegistry(reg.child);
  }
});

test("authenticated endpoints reject requests without credentials", async () => {
  const response = await fetch(`${registry.base}/api/health`);
  assert.equal(response.status, 401);
});

test("markdown entry is curl-readable and carries protocol red lines", async () => {
  const response = await fetch(`${registry.base}/agent-entry.md`, { headers: { "x-registry-token": TOKEN } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^text\/markdown/);
  const body = await response.text();
  assert.match(body, /03 物理断连/);
  assert.match(body, /job 还是 session/);
  assert.match(body, /5038/);
  assert.match(body, /--ssh xhs-windows/);
  assert.match(body, /controlPlaneReload/);
  assert.match(body, /XhsDeviceControlPlaneV1|control-plane-task\.ps1/);
  for (const alias of ["01", "02", "03", "04"]) {
    assert.match(body, new RegExp(`serveReload${alias}.*serve-restart-${alias}\\.ps1`));
  }
  assert.match(body, /online=yes/);
  assert.match(body, /ready=/);
  assert.match(body, /unresolvedFailure=none/);
  assert.match(body, /streak=2/);
  assert.match(body, /identityCache: fresh/);
  assert.doesNotMatch(body, /private-account|private-note/);
});

test("remote page exchanges human query token for HttpOnly cookie and renders zero-JS escaped SSR", async () => {
  // agent token 不能换 session：不重定向（没有 human 凭证就没有审批页会话）
  const agentAttempt = await fetch(`${registry.base}/?token=${TOKEN}`, { redirect: "manual" });
  assert.equal(agentAttempt.status, 200);
  const first = await fetch(`${registry.base}/?token=${HUMAN_TOKEN}`, { redirect: "manual" });
  assert.equal(first.status, 303);
  assert.equal(first.headers.get("location"), "/");
  const cookie = first.headers.get("set-cookie");
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.doesNotMatch(cookie, new RegExp(HUMAN_TOKEN));
  const page = await fetch(`${registry.base}/`, { headers: { cookie } });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.doesNotMatch(html, /<script\b/i);
  assert.match(html, /一号 &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /private-account|private-note/);
  assert.match(html, /03 物理断连/);
  assert.match(html, /输入 APPROVE/);
});

test("human form requires CSRF and explicit APPROVE confirmation, then uses 303 PRG", async () => {
  const first = await fetch(`${registry.base}/?token=${HUMAN_TOKEN}`, { redirect: "manual" });
  const cookie = first.headers.get("set-cookie");
  const page = await fetch(`${registry.base}/`, { headers: { cookie } });
  const html = await page.text();
  const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1];
  assert.ok(csrf);
  const noCsrf = await fetch(`${registry.base}/ui/approvals/job-approval/approve`, {
    method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: "confirmation=APPROVE", redirect: "manual",
  });
  assert.equal(noCsrf.status, 403);
  const noConfirmation = await fetch(`${registry.base}/ui/approvals/job-approval/approve`, {
    method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf }), redirect: "manual",
  });
  assert.equal(noConfirmation.status, 400);
  const approved = await fetch(`${registry.base}/ui/approvals/job-approval/approve`, {
    method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf, confirmation: "APPROVE", actor: "human:forged", reason: "test" }), redirect: "manual",
  });
  assert.equal(approved.status, 303);
  assert.equal(approved.headers.get("location"), "/?notice=approved");
  assert.equal(control.decisions.at(-1).decision, "approve");
  // actor 由凭证推导，表单自报的 human:forged 被忽略
  assert.equal(control.decisions.at(-1).actorId, "human:console");
  const audit = await (await fetch(`${registry.base}/api/approvals/audit`, { headers: { "x-registry-token": TOKEN } })).json();
  assert.equal(audit.audit[0].jobId, "job-approval");
  assert.equal(audit.audit[0].channel, "ui");
  assert.equal(audit.audit[0].actorSource, "human-session");
  assert.equal(audit.audit[0].proxiedOk, true);
});

test("knowledge lifecycle migration and terminal transition rules are enforced", async () => {
  const headers = { "x-registry-token": TOKEN, "content-type": "application/json" };
  const list = await (await fetch(`${registry.base}/api/knowledge`, { headers })).json();
  assert.equal(list.knowledge.find((item) => item.id.startsWith("xianyu-2x5")).lifecycle, "resolved");
  assert.equal(list.knowledge.find((item) => item.id.includes("physical-disconnect")).lifecycle, "active_blocker");
  const terminal = await fetch(`${registry.base}/api/knowledge/xianyu-2x5-timeout-restoration-recovery-20260726`, {
    method: "PATCH", headers, body: JSON.stringify({ lifecycle: "backlog" }),
  });
  assert.equal(terminal.status, 409);
  const invalidActiveTransition = await fetch(`${registry.base}/api/knowledge/xianyu-03-physical-disconnect-gateway-probe-20260726`, {
    method: "PATCH", headers, body: JSON.stringify({ lifecycle: "backlog" }),
  });
  assert.equal(invalidActiveTransition.status, 409);
  const resolved03 = await fetch(`${registry.base}/api/knowledge/xianyu-03-physical-disconnect-gateway-probe-20260726`, {
    method: "PATCH", headers, body: JSON.stringify({ lifecycle: "resolved", resolution: "现场恢复并完成验证" }),
  });
  assert.equal(resolved03.status, 200);
  const created = await fetch(`${registry.base}/api/knowledge`, {
    method: "POST", headers, body: JSON.stringify({ id: "probe-one", title: "probe", content: "unknown", lifecycle: "probe_unknown" }),
  });
  assert.equal(created.status, 201);
  const promoted = await fetch(`${registry.base}/api/knowledge/probe-one/flag-engineer`, {
    method: "POST", headers, body: JSON.stringify({ needs: true }),
  });
  assert.equal(promoted.status, 200);
  assert.equal((await promoted.json()).knowledge.lifecycle, "backlog");
  const cleared = await fetch(`${registry.base}/api/knowledge/probe-one/flag-engineer`, {
    method: "POST", headers, body: JSON.stringify({ needs: false }),
  });
  assert.equal(cleared.status, 200);
  const clearedKnowledge = (await cleared.json()).knowledge;
  assert.equal(clearedKnowledge.lifecycle, "resolved");
  assert.equal(clearedKnowledge.needsEngineer, false);
  const defaulted = await fetch(`${registry.base}/api/knowledge`, {
    method: "POST", headers, body: JSON.stringify({ id: "default-life", title: "default", content: "normal recipe", category: "recipe" }),
  });
  assert.equal(defaulted.status, 201);
  assert.equal((await defaulted.json()).knowledge.lifecycle, "resolved");

  await stopRegistry(registry.child);
  registry = await startRegistry({ root: tempRoot, controlUrl: `http://127.0.0.1:${control.server.address().port}`,
    extraArgs: ["--runs-root", runsRoot, "--payment-signer-keys-file", paymentSignerKeysFile] });
  const afterRestart = await (await fetch(`${registry.base}/api/agent-entry`, { headers: { "x-registry-token": TOKEN } })).json();
  assert.equal(afterRestart.blockers.active.length, 0);
  assert.equal(afterRestart.blockers.resolved.find((item) => item.id.includes("physical-disconnect")).resolution, "现场恢复并完成验证");
});

test("legacy endpoints remain available", async () => {
  const headers = { "x-registry-token": TOKEN };
  for (const endpoint of ["/api/health", "/api/devices", "/api/knowledge", "/api/approvals/pending", "/api/approvals/recent?limit=2", "/api/approvals/audit", "/watchdog"]) {
    const response = await fetch(`${registry.base}${endpoint}`, { headers });
    assert.equal(response.status, 200, endpoint);
  }
});

test("agent entry degrades without returning 500 when control plane is unreachable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xhs-registry-degraded-"));
  createRegistryDb(path.join(root, "registry.db"));
  createControlDb(path.join(root, "control.db"));
  await writeFile(path.join(root, "seed.json"), JSON.stringify({ identities: [{ alias: "03", serial: "REPLACE_SERIAL_03", label: "三店" }] }));
  const unavailablePort = await freePort();
  const degraded = await startRegistry({ root, controlUrl: `http://127.0.0.1:${unavailablePort}`, requireAuth: false });
  try {
    const response = await fetch(`${degraded.base}/api/agent-entry`);
    assert.equal(response.status, 200);
    const entry = await response.json();
    assert.equal(entry.sources.controlPlane.reachable, false);
    assert.equal(entry.sources.controlPlane.stale, true);
  } finally {
    await stopRegistry(degraded.child);
    await rm(root, { recursive: true, force: true });
  }
});

test("capability catalog derives approval policy, lints misleading modes, and maps device routing", async () => {
  const headers = { "x-registry-token": TOKEN };
  const catalog = await (await fetch(`${registry.base}/api/capabilities`, { headers })).json();
  assert.equal(catalog.ok, true);
  assert.equal(catalog.count, 3);
  const open = catalog.capabilities.find((c) => c.id === "xianyu.publish.open_dry_run");
  const saveDraft = catalog.capabilities.find((c) => c.id === "xianyu.publish.save_draft_dry_run");
  const send = catalog.capabilities.find((c) => c.id === "xhs.comment.send");
  // R1 + replay_safe + automatic → agent 可自跑
  assert.equal(open.policy.autonomous, true);
  assert.equal(open.policy.approvalRequired, false);
  assert.deepEqual(open.eligibleAliases, ["01", "03"]);
  // 字面 automatic 但 external_effect → 推导为需审批，且必须 lint 出来
  assert.equal(saveDraft.policy.approvalRequired, true);
  assert.equal(saveDraft.policy.autonomous, false);
  assert.ok(saveDraft.lint.some((w) => /误导性/.test(w)));
  assert.ok(saveDraft.lint.some((w) => /副作用不会被自动回收/.test(w)));
  assert.deepEqual(saveDraft.eligibleAliases, ["01"]);
  // R2 → 外部效应 + 需审批
  assert.equal(send.policy.externalEffect, true);
  assert.equal(send.policy.approvalRequired, true);
  assert.ok(catalog.lintWarnings.length >= 1);
  // runnableAsJob：已实现+免审批+非 canary 才能给 job 骨架；save_draft/send 不可直接 job 自跑
  assert.equal(open.policy.runnableAsJob, true);
  assert.equal(saveDraft.policy.runnableAsJob, false);
  assert.equal(send.policy.runnableAsJob, false);
  assert.equal(open.policy.availability, "implemented");

  const autonomousOnly = await (await fetch(`${registry.base}/api/capabilities?autonomous=1`, { headers })).json();
  assert.deepEqual(autonomousOnly.capabilities.map((c) => c.id), ["xianyu.publish.open_dry_run"]);
  const byAlias = await (await fetch(`${registry.base}/api/capabilities?alias=03`, { headers })).json();
  assert.deepEqual(byAlias.capabilities.map((c) => c.id), ["xianyu.publish.open_dry_run"]);
  const single = await fetch(`${registry.base}/api/capabilities/xhs.comment.send`, { headers });
  assert.equal(single.status, 200);
  assert.equal((await single.json()).capability.risk, "R2");
  assert.equal((await fetch(`${registry.base}/api/capabilities/nope.nope`, { headers })).status, 404);
});

test("task packet recommends autonomous capabilities with eligible devices and never submits", async () => {
  const headers = { "x-registry-token": TOKEN };
  assert.equal((await fetch(`${registry.base}/api/task-packet`, { headers })).status, 400);
  const packet = await (await fetch(`${registry.base}/api/task-packet?task=${encodeURIComponent("闲鱼打开页面 dry-run 验证")}`, { headers })).json();
  assert.equal(packet.inferredApp, "xianyu");
  assert.equal(packet.recommendations[0].capabilityId, "xianyu.publish.open_dry_run");
  assert.equal(packet.recommendations[0].policy.autonomous, true);
  const dev01 = packet.recommendations[0].eligibleDevices.find((d) => d.alias === "01");
  assert.equal(dev01.routed, true);
  assert.equal(dev01.ready, false); // 01 有活跃 lease，不 ready
  assert.match(packet.recommendations[0].submitSkeleton, /--ssh xhs-windows job submit/);
  assert.ok(packet.acceptance.length >= 2 && packet.stopConditions.length >= 2);
  assert.equal(packet.note.includes("不代提交"), true);
  // save_draft 任务：草稿意图匹配 save_draft_dry_run，但它 approvalRequired → 不可直接 job，给 submitNote 不给骨架
  const draftPacket = await (await fetch(`${registry.base}/api/task-packet?task=${encodeURIComponent("闲鱼保存草稿")}`, { headers })).json();
  const draftRec = draftPacket.recommendations.find((r) => r.capabilityId === "xianyu.publish.save_draft_dry_run");
  assert.ok(draftRec, "save_draft 应出现在推荐里（路由到 01）");
  assert.equal(draftRec.submitSkeleton, null);
  assert.ok(draftRec.submitNote && /需人工审批/.test(draftRec.submitNote));
  // 无意图匹配不瞎猜：只给 app 不给意图 → 空推荐 + noIntentNote
  const vague = await (await fetch(`${registry.base}/api/task-packet?task=${encodeURIComponent("闲鱼")}`, { headers })).json();
  assert.equal(vague.inferredApp, "xianyu");
  assert.deepEqual(vague.recommendations, []);
  assert.ok(vague.noIntentNote && /未匹配到明确意图/.test(vague.noIntentNote));
});

test("layered health reports readiness, fleet and capability lint; shallow health stays compatible", async () => {
  const headers = { "x-registry-token": TOKEN };
  const shallow = await (await fetch(`${registry.base}/api/health`, { headers })).json();
  assert.equal(shallow.ok, true);
  assert.equal(typeof shallow.identities, "number");
  const deep = await (await fetch(`${registry.base}/api/health?deep=1`, { headers })).json();
  assert.equal(deep.liveness.ok, true);
  assert.equal(deep.readiness.controlPlane.reachable, true);
  assert.equal(deep.fleet.totalCount, 2);
  assert.deepEqual(deep.fleet.notReady.find((d) => d.alias === "03").reason, "quarantined");
  assert.equal(deep.approvals.humanTokenEnforced, true);
  assert.equal(deep.capabilities.count, 3);
  assert.equal(deep.capabilities.autonomousCount, 1);
  assert.ok(deep.degraded.some((d) => /能力策略不变量告警/.test(d)));
});

test("knowledge supports single fetch, lifecycle/appliesTo filters, id search and honest counts", async () => {
  const headers = { "x-registry-token": TOKEN, "content-type": "application/json" };
  // 自给自足：不依赖前序测试是否改过存量条目的 lifecycle
  await fetch(`${registry.base}/api/knowledge`, {
    method: "POST", headers,
    body: JSON.stringify({ id: "p1-filter-blocker", title: "查询用卡点", content: "c", lifecycle: "active_blocker", appliesTo: ["registry.mjs"] }),
  });
  const one = await fetch(`${registry.base}/api/knowledge/p1-filter-blocker`, { headers });
  assert.equal(one.status, 200);
  assert.equal((await one.json()).knowledge.lifecycle, "active_blocker");
  assert.equal((await fetch(`${registry.base}/api/knowledge/does-not-exist`, { headers })).status, 404);
  const list = await (await fetch(`${registry.base}/api/knowledge`, { headers })).json();
  assert.equal(typeof list.count, "number");
  assert.equal(list.count, list.knowledge.length);
  assert.equal(typeof list.total, "number");
  const blockers = await (await fetch(`${registry.base}/api/knowledge?lifecycle=active_blocker`, { headers })).json();
  assert.equal(blockers.knowledge.every((k) => k.lifecycle === "active_blocker"), true);
  assert.equal(blockers.knowledge.some((k) => k.id === "p1-filter-blocker"), true);
  // q 现在也搜 id：agent 常常已知 id 却搜不到内容
  const byId = await (await fetch(`${registry.base}/api/knowledge?q=p1-filter-blocker`, { headers })).json();
  assert.equal(byId.knowledge.length, 1);
  const byApplies = await (await fetch(`${registry.base}/api/knowledge?appliesTo=registry.mjs`, { headers })).json();
  assert.equal(byApplies.knowledge.some((k) => k.id === "p1-filter-blocker"), true);
  // json_each 精确匹配：通配符 %/_ 不再当 LIKE 元字符，前缀也不再误匹配
  const wildcard = await (await fetch(`${registry.base}/api/knowledge?appliesTo=%`, { headers })).json();
  assert.equal(wildcard.knowledge.length, 0);
  const prefix = await (await fetch(`${registry.base}/api/knowledge?appliesTo=registry`, { headers })).json();
  assert.equal(prefix.knowledge.length, 0);
});

test("api approvals require human token, derive actor from credential, and leave audit trail", async () => {
  const agentHeaders = { "x-registry-token": TOKEN, "content-type": "application/json" };
  const humanHeaders = { "x-registry-token": HUMAN_TOKEN, "content-type": "application/json" };
  const agentDeny = await fetch(`${registry.base}/api/approvals/job-approval/deny`, { method: "POST", headers: agentHeaders, body: "{}" });
  assert.equal(agentDeny.status, 403);
  const noConfirm = await fetch(`${registry.base}/api/approvals/job-approval/approve`, { method: "POST", headers: humanHeaders, body: "{}" });
  assert.equal(noConfirm.status, 400);
  const approved = await fetch(`${registry.base}/api/approvals/job-approval/approve`, {
    method: "POST", headers: humanHeaders, body: JSON.stringify({ confirm: "APPROVE", actor: "human:forged", reason: "api test" }),
  });
  assert.equal(approved.status, 200);
  assert.equal(control.decisions.at(-1).decision, "approve");
  assert.equal(control.decisions.at(-1).actorId, "human:console");
  const audit = await (await fetch(`${registry.base}/api/approvals/audit?limit=1`, { headers: agentHeaders })).json();
  assert.equal(audit.audit[0].channel, "api");
  assert.equal(audit.audit[0].actorSource, "human-token");
  assert.equal(audit.audit[0].actor, "human:console");
  assert.equal(audit.audit[0].proxiedOk, true);
});

test("loopback without credentials can read and write knowledge but never approve", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xhs-registry-loopback-"));
  createRegistryDb(path.join(root, "registry.db"));
  createControlDb(path.join(root, "control.db"));
  await writeFile(path.join(root, "seed.json"), JSON.stringify({ identities: [{ alias: "01", serial: "serial-01", label: "一号" }] }));
  const loop = await startRegistry({
    root, controlUrl: `http://127.0.0.1:${control.server.address().port}`,
    requireAuth: false, extraArgs: ["--human-token", HUMAN_TOKEN],
  });
  try {
    const read = await fetch(`${loop.base}/api/agent-entry`);
    assert.equal(read.status, 200);
    const write = await fetch(`${loop.base}/api/knowledge`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "loop-recipe", title: "loopback recipe", content: "still allowed", category: "recipe" }),
    });
    assert.equal(write.status, 201);
    const approve = await fetch(`${loop.base}/api/approvals/job-approval/approve`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: "APPROVE" }),
    });
    assert.equal(approve.status, 403);
    const deny = await fetch(`${loop.base}/api/approvals/job-approval/deny`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    assert.equal(deny.status, 403);
  } finally {
    await stopRegistry(loop.child);
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy single-token mode keeps old behavior until human token is introduced", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xhs-registry-legacy-"));
  createRegistryDb(path.join(root, "registry.db"));
  createControlDb(path.join(root, "control.db"));
  await writeFile(path.join(root, "seed.json"), JSON.stringify({ identities: [{ alias: "01", serial: "serial-01", label: "一号" }] }));
  const legacy = await startRegistry({
    root, controlUrl: `http://127.0.0.1:${control.server.address().port}`,
    requireAuth: false, extraArgs: ["--token", TOKEN, "--trust-loopback", "false"], probeToken: TOKEN,
  });
  try {
    const noToken = await fetch(`${legacy.base}/api/health`);
    assert.equal(noToken.status, 401);
    const approve = await fetch(`${legacy.base}/api/approvals/job-approval/approve`, {
      method: "POST", headers: { "x-registry-token": TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ actor: "human:boss", reason: "legacy" }),
    });
    assert.equal(approve.status, 200);
    assert.equal(control.decisions.at(-1).actorId, "human:boss");
    const audit = await (await fetch(`${legacy.base}/api/approvals/audit?limit=1`, { headers: { "x-registry-token": TOKEN } })).json();
    assert.equal(audit.audit[0].actorSource, "legacy-body");
    const mint = await fetch(`${legacy.base}/?token=${TOKEN}`, { redirect: "manual" });
    assert.equal(mint.status, 303);
  } finally {
    await stopRegistry(legacy.child);
    await rm(root, { recursive: true, force: true });
  }
});

test("identity cache reports stale once ttl is exceeded", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xhs-registry-stale-"));
  const db = new DatabaseSync(path.join(root, "registry.db"));
  db.exec(`
    CREATE TABLE identities (
      alias TEXT PRIMARY KEY, serial TEXT, label TEXT, model TEXT,
      accounts_json TEXT NOT NULL DEFAULT '{}', customer TEXT, notes TEXT, updated_at TEXT NOT NULL
    );
    CREATE TABLE sync_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  const oldIso = new Date(now - 7200 * 1000).toISOString();
  db.prepare("INSERT INTO identities (alias, serial, label, updated_at) VALUES ('01','serial-01','一号',?)").run(oldIso);
  db.prepare("INSERT INTO sync_meta VALUES ('last_identity_sync', ?)").run(oldIso);
  db.close();
  createControlDb(path.join(root, "control.db"));
  await writeFile(path.join(root, "seed.json"), JSON.stringify({ identities: [] }));
  const stale = await startRegistry({
    root, controlUrl: `http://127.0.0.1:${control.server.address().port}`,
    requireAuth: false, extraArgs: ["--identity-stale-s", "900"],
  });
  try {
    const entry = await (await fetch(`${stale.base}/api/agent-entry`)).json();
    assert.equal(entry.sources.identityCache.stale, true);
    assert.ok(entry.sources.identityCache.ageSeconds >= 7000);
    assert.equal(entry.sources.identityCache.staleAfterSeconds, 900);
    assert.equal(entry.devices.find((item) => item.alias === "01").identityStale, true);
    const md = await (await fetch(`${stale.base}/agent-entry.md`)).text();
    assert.match(md, /identityCache: stale/);
  } finally {
    await stopRegistry(stale.child);
    await rm(root, { recursive: true, force: true });
  }
});

test("agent entry marks controlDb stale when one approvals query fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xhs-registry-partial-control-db-"));
  createRegistryDb(path.join(root, "registry.db"));
  createControlDb(path.join(root, "control.db"));
  const partialDb = new DatabaseSync(path.join(root, "control.db"));
  partialDb.exec("DROP TABLE approvals");
  partialDb.close();
  await writeFile(path.join(root, "seed.json"), JSON.stringify({ identities: [{ alias: "03", serial: "REPLACE_SERIAL_03", label: "三店" }] }));
  const partial = await startRegistry({ root, controlUrl: `http://127.0.0.1:${control.server.address().port}`, requireAuth: false });
  try {
    const response = await fetch(`${partial.base}/api/agent-entry`);
    assert.equal(response.status, 200);
    const entry = await response.json();
    assert.equal(entry.sources.controlDb.reachable, false);
    assert.equal(entry.sources.controlDb.stale, true);
  } finally {
    await stopRegistry(partial.child);
    await rm(root, { recursive: true, force: true });
  }
});

// ---------- Fleet / Screen / Operator API ----------

// 隔离夹具：为 Screen 负向测试构建独立 control.db（devices/jobs/evidence）+ runsRoot 文件。
function buildScreenControlDb(dbPath, specs) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE devices (device_id TEXT PRIMARY KEY, alias TEXT, routing_json TEXT);
    CREATE TABLE jobs (job_id TEXT PRIMARY KEY, run_id TEXT, actor_id TEXT, device_id TEXT, capability_id TEXT,
      capability_json TEXT, params_json TEXT, status TEXT, error_code TEXT,
      created_at INTEGER, updated_at INTEGER, started_at INTEGER, finished_at INTEGER);
    CREATE TABLE evidence (evidence_id TEXT PRIMARY KEY, job_id TEXT, run_id TEXT, kind TEXT, path TEXT,
      sha256 TEXT, bytes INTEGER, created_at INTEGER);
  `);
  for (const s of specs) {
    db.prepare("INSERT INTO devices VALUES (?,?,?)").run(s.deviceId, s.alias,
      JSON.stringify({ enabled: true, tags: [`slot:${s.alias}`], capabilityIds: [] }));
    db.prepare("INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
      s.jobId, s.runId, "agent-x", s.deviceId, "xianyu.observe.snapshot",
      JSON.stringify({ id: "xianyu.observe.snapshot", appId: "xianyu", risk: "R0" }), "{}", "succeeded", null,
      now - 10000, now - 5000, now - 9000, now - 5000);
    db.prepare("INSERT INTO evidence VALUES (?,?,?,?,?,?,?,?)").run(
      s.evidenceId, s.jobId, s.runId, "screenshot", s.path, s.sha256 ?? "", s.bytes ?? 0, s.createdAt ?? (now - 5000));
  }
  db.close();
}

async function writeRunsFile(runsRoot, runId, relPath, content) {
  const dir = path.join(runsRoot, runId, path.dirname(relPath));
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(runsRoot, runId, relPath), content);
}

// 启动一个隔离 registry（自带 control.db + runsRoot），用 observer token 访问 Screen。
async function bootScreenRegistry({ specs, runsFiles = [], seedIdentities, extraArgs = [], nodeArgs = [], env = {}, counterFile = null }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "xhs-registry-screen-"));
  createRegistryDb(path.join(root, "registry.db"));
  buildScreenControlDb(path.join(root, "control.db"), specs);
  await writeFile(path.join(root, "seed.json"), JSON.stringify({ identities: seedIdentities ?? specs.map((s) => ({ alias: s.alias, serial: `s-${s.alias}`, label: s.label ?? `设备${s.alias}`, model: s.model ?? "M1" })) }));
  const runsRoot = path.join(root, "runs");
  await mkdir(runsRoot, { recursive: true });
  for (const f of runsFiles) await writeRunsFile(runsRoot, f.runId, f.relPath, f.content);
  if (counterFile) {
    // 在子进程里对 runsRoot 下的 fs 访问计数（runsRoot 在此处已知，避免调用方 TDZ）。
    fs.writeFileSync(counterFile, "");
    const preload = pathToFileURL(path.join(ROOT, "tests", "screen-count-preload.mjs")).href;
    nodeArgs = ["--import", preload, ...nodeArgs];
    env = { ...env, SCREEN_COUNTER_FILE: counterFile, SCREEN_COUNT_ROOT: runsRoot };
  }
  const reg = await startRegistry({
    root, controlUrl: `http://127.0.0.1:${control.server.address().port}`,
    extraArgs: ["--runs-root", runsRoot, "--screen-cache-ttl-ms", "200", "--screen-min-interval-ms", "0", ...extraArgs],
    nodeArgs, env,
  });
  return { reg, root, runsRoot };
}

async function stopIsolated(reg, root) {
  await stopRegistry(reg.child);
  await rm(root, { recursive: true, force: true });
}

test("observer fleet DTO keeps safe displayName/model, renames reportedActor, stays read-only", async () => {
  const h = { "x-registry-token": OBSERVER_TOKEN };
  const fleetRes = await fetch(`${registry.base}/api/observer/v1/fleet`, { headers: h });
  assert.equal(fleetRes.status, 200);
  const fleet = await fleetRes.json();
  assert.equal(fleet.ok, true);
  assert.equal(fleet.schemaVersion, "xhs.observer.fleet.v1");
  assert.equal(typeof fleet.degraded, "boolean");
  const dev01 = fleet.devices.find((d) => d.alias === "01");
  assert.ok(dev01, "fleet includes 01");
  // 保留安全字段
  assert.equal(dev01.displayName, "一号 <script>alert(1)</script>"); // JSON 规范化不去 HTML；渲染层转义
  assert.equal(dev01.model, "M1");
  // 脱敏：不含 serial/accounts/customer/notes/deviceId/runId
  for (const k of ["serial", "accounts", "customer", "notes", "deviceId", "runId"]) assert.equal(k in dev01, false, `${k} must be absent`);
  assert.equal(dev01.online, true);
  assert.equal(dev01.ready, false); // dev-01 有活跃 job → lease 占用 → not ready
  assert.equal(dev01.lease.held, true);
  assert.equal(dev01.lease.kind, "job");
  assert.equal(dev01.currentTask?.jobId, "job-running");
  assert.equal(dev01.currentTask?.reportedActor, "agent-alpha");
  assert.equal(dev01.currentTask?.actorVerified, false);
  assert.equal(dev01.streak, 2);
  assert.ok(dev01.freshness, "freshness present");
  // observer 不得写知识库
  const writeRes = await fetch(`${registry.base}/api/knowledge`, { method: "POST", headers: h, body: JSON.stringify({ id: "x", app: "x", title: "t", content: "c" }) });
  assert.equal(writeRes.status, 403);
  // observer 不得审批
  const approveRes = await fetch(`${registry.base}/api/approvals/job-approval/approve`, { method: "POST", headers: h, body: JSON.stringify({ confirm: "APPROVE" }) });
  assert.equal(approveRes.status, 403);
});

test("cache-only Screen API returns newest screenshot with quoted ETag, 304, and no runId in meta", async () => {
  const h = { "x-registry-token": OBSERVER_TOKEN };
  const metaRes = await fetch(`${registry.base}/api/observer/v1/screen/01/meta`, { headers: h });
  assert.equal(metaRes.status, 200);
  const meta = await metaRes.json();
  assert.equal(meta.ok, true);
  assert.equal(meta.sha256, SCREEN_SHA);
  assert.equal(meta.alias, "01");
  assert.equal(meta.contentType, "image/png");
  assert.equal(meta.stale, false);
  assert.equal("runId" in meta, false, "meta must not expose runId");
  const imgRes = await fetch(`${registry.base}/api/observer/v1/screen/01`, { headers: h });
  assert.equal(imgRes.status, 200);
  assert.equal(imgRes.headers.get("content-type"), "image/png");
  assert.equal(imgRes.headers.get("etag"), `"${SCREEN_SHA}"`); // 带引号
  assert.equal(imgRes.headers.get("cache-control"), "private, no-cache");
  assert.equal(imgRes.headers.get("x-screen-stale"), "0");
  const buf = Buffer.from(await imgRes.arrayBuffer());
  assert.deepEqual(buf, SCREEN_PNG);
  // 带引号 If-None-Match → 304
  const reval = await fetch(`${registry.base}/api/observer/v1/screen/01`, { headers: { ...h, "if-none-match": `"${SCREEN_SHA}"` } });
  assert.equal(reval.status, 304);
  assert.equal(reval.headers.get("etag"), `"${SCREEN_SHA}"`);
  // 无截图设备 → 404（不触发采集）
  const noneRes = await fetch(`${registry.base}/api/observer/v1/screen/03/meta`, { headers: h });
  assert.equal(noneRes.status, 404);
});

test("operator is frozen: submit/session/job all return 501; observer cannot reach operator ns", async () => {
  const opH = { "x-registry-token": OPERATOR_TOKEN, "content-type": "application/json" };
  const before = control.submissions.length;
  const submitRes = await fetch(`${registry.base}/api/operator/submit`, {
    method: "POST", headers: opH,
    body: JSON.stringify({ capability: "xianyu.observe.snapshot", alias: "01", actor: "relay-1" }),
  });
  assert.equal(submitRes.status, 501);
  assert.equal(control.submissions.length, before, "frozen submit must not reach control plane");
  const sessRes = await fetch(`${registry.base}/api/operator/session`, { method: "POST", headers: opH, body: "{}" });
  assert.equal(sessRes.status, 501);
  const jobRes = await fetch(`${registry.base}/api/operator/job/job-x`, { headers: opH });
  assert.equal(jobRes.status, 501);
  // observer 命中 operator 命名空间 → 403（命名空间闸门）
  const obsSubmit = await fetch(`${registry.base}/api/operator/submit`, {
    method: "POST", headers: { "x-registry-token": OBSERVER_TOKEN, "content-type": "application/json" },
    body: JSON.stringify({ capability: "xianyu.observe.snapshot", alias: "01" }),
  });
  assert.equal(obsSubmit.status, 403);
});

test("registry refuses to start when two non-empty role tokens are identical", async () => {
  // 鉴权按 human→agent→observer→operator 顺序匹配；重复 token 会让低权限凭证命中更高权限角色。
  // 启动期即拒绝（exit 1），不得进入监听。
  const root = await mkdtemp(path.join(os.tmpdir(), "xhs-registry-dup-"));
  createRegistryDb(path.join(root, "registry.db"));
  await writeFile(path.join(root, "seed.json"), JSON.stringify({ identities: [] }));
  try {
    await startRegistry({
      root, controlUrl: `http://127.0.0.1:${control.server.address().port}`,
      requireAuth: false,
      extraArgs: ["--observer-token", "DUP", "--human-token", "DUP", "--agent-token", "A", "--trust-loopback", "false"],
    });
    assert.fail("registry must not start with duplicate role tokens");
  } catch (e) {
    assert.match(String(e.message), /拒绝启动.*token 重复|token 重复/, `expected dup-token rejection in logs, got: ${e.message}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 读取 preload 计数文件中指定 tag（READ/REAL）的行数；文件不存在记 0。
function countTag(counterFile, tag) {
  if (!fs.existsSync(counterFile)) return 0;
  return fs.readFileSync(counterFile, "utf8").split("\n").filter((l) => l.startsWith(`${tag} `)).length;
}

// ---------- 负向测试 ----------

test("observer is locked to /api/observer/v1/* and 403 elsewhere", async () => {
  const h = { "x-registry-token": OBSERVER_TOKEN };
  for (const p of ["/api/agent-entry", "/api/knowledge", "/api/approvals/pending", "/api/devices", "/", "/api/fleet", "/api/capabilities"]) {
    const r = await fetch(`${registry.base}${p}`, { headers: h });
    assert.equal(r.status, 403, `observer must be 403 on ${p}`);
  }
  const ok = await fetch(`${registry.base}/api/observer/v1/fleet`, { headers: h });
  assert.equal(ok.status, 200);
});

test("observer token in URL query is rejected (header-only)", async () => {
  const r = await fetch(`${registry.base}/api/observer/v1/fleet?token=${encodeURIComponent(OBSERVER_TOKEN)}`);
  assert.equal(r.status, 401);
});

test("GET screen does not produce job/session/lease on the control plane", async () => {
  const h = { "x-registry-token": OBSERVER_TOKEN };
  const before = control.submissions.length;
  await fetch(`${registry.base}/api/observer/v1/screen/01`, { headers: h });
  await fetch(`${registry.base}/api/observer/v1/screen/01/meta`, { headers: h });
  assert.equal(control.submissions.length, before, "screen GET must not submit any job");
});

test("concurrent observer screen requests share one disk load (singleflight) and do not trigger capture", async () => {
  // 单飞 + 限频是进程内机制；用 --import preload 在子进程里对 runsRoot 下的 readFile 计数，
  // 直接证明并发请求只发生一次磁盘加载（而非仅"响应一致"）。
  const specs = [{
    deviceId: "dev-c", alias: "cc", jobId: "job-c", runId: "run-c", evidenceId: "ev-c",
    path: "evidence/shot-c.png", sha256: SCREEN_SHA, bytes: SCREEN_PNG.length, createdAt: now - 1000,
  }];
  const counterFile = path.join(os.tmpdir(), `screen-count-${process.pid}-${Math.floor(now)}.txt`);
  const { reg, root } = await bootScreenRegistry({
    specs, runsFiles: [{ runId: "run-c", relPath: "evidence/shot-c.png", content: SCREEN_PNG }],
    counterFile,
  });
  try {
    const h = { "x-registry-token": OBSERVER_TOKEN };
    const before = control.submissions.length;
    // 预热：第一次 GET 把缓存填好。清零计数后并发，验证并发只读 0 次（命中单飞/缓存）。
    const warm = await fetch(`${reg.base}/api/observer/v1/screen/cc`, { headers: h });
    assert.equal(warm.status, 200);
    await warm.arrayBuffer();
    // 等待计数文件落盘并清零，使后续并发从干净计数开始。
    await new Promise((r) => setTimeout(r, 30));
    fs.writeFileSync(counterFile, "");

    const responses = await Promise.all(Array.from({ length: 8 }, () => fetch(`${reg.base}/api/observer/v1/screen/cc`, { headers: h })));
    for (const r of responses) {
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("etag"), `"${SCREEN_SHA}"`);
    }
    const bodies = await Promise.all(responses.map((r) => r.arrayBuffer()));
    assert.ok(bodies.every((b) => Buffer.from(b).equals(SCREEN_PNG)), "all concurrent responses identical");
    assert.equal(control.submissions.length, before, "no capture triggered");
    // 并发命中缓存（TTL 200ms 内），不应再读盘；若读盘则单飞/缓存失效。
    await new Promise((r) => setTimeout(r, 30));
    const reads = countTag(counterFile, "READ");
    assert.equal(reads, 0, `concurrent screen requests must not re-read disk (got ${reads} READ calls); singleflight/cache must serve from memory`);
  } finally {
    await stopIsolated(reg, root);
    try { fs.unlinkSync(counterFile); } catch {}
  }
});

test("concurrent observer screen requests on a cold cache share exactly one disk load (singleflight)", async () => {
  // 冷缓存并发：8 个请求同时打到未填充的 alias，单飞应保证只发生一次磁盘加载。
  const specs = [{
    deviceId: "dev-c2", alias: "c2", jobId: "job-c2", runId: "run-c2", evidenceId: "ev-c2",
    path: "evidence/shot-c2.png", sha256: SCREEN_SHA, bytes: SCREEN_PNG.length, createdAt: now - 1000,
  }];
  const counterFile = path.join(os.tmpdir(), `screen-count-cold-${process.pid}-${Math.floor(now)}.txt`);
  const { reg, root } = await bootScreenRegistry({
    specs, runsFiles: [{ runId: "run-c2", relPath: "evidence/shot-c2.png", content: SCREEN_PNG }],
    counterFile,
  });
  try {
    const h = { "x-registry-token": OBSERVER_TOKEN };
    const responses = await Promise.all(Array.from({ length: 8 }, () => fetch(`${reg.base}/api/observer/v1/screen/c2`, { headers: h })));
    for (const r of responses) {
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("etag"), `"${SCREEN_SHA}"`);
    }
    await Promise.all(responses.map((r) => r.arrayBuffer()));
    await new Promise((r) => setTimeout(r, 30));
    const reads = countTag(counterFile, "READ");
    assert.equal(reads, 1, `cold-cache concurrent requests must share exactly one disk load (got ${reads} READ calls); singleflight must coalesce`);
  } finally {
    await stopIsolated(reg, root);
    try { fs.unlinkSync(counterFile); } catch {}
  }
});

test("screen rejects path traversal evidence row", async () => {
  const specs = [{
    deviceId: "dev-e", alias: "ee", jobId: "job-e", runId: "run-e", evidenceId: "ev-e",
    path: "../../evil.png", sha256: SCREEN_SHA, bytes: SCREEN_PNG.length, createdAt: now - 1000,
  }];
  const { reg, root } = await bootScreenRegistry({ specs, runsFiles: [{ runId: "run-e", relPath: "../../evil.png", content: SCREEN_PNG }] });
  try {
    const r = await fetch(`${reg.base}/api/observer/v1/screen/ee`, { headers: { "x-registry-token": OBSERVER_TOKEN } });
    assert.equal(r.status, 404);
  } finally {
    await stopIsolated(reg, root);
  }
});

test("screen rejects evidence whose sha256 does not match file content", async () => {
  const specs = [{
    deviceId: "dev-b", alias: "bb", jobId: "job-b", runId: "run-b", evidenceId: "ev-b",
    path: "evidence/shot-b.png", sha256: "deadbeef".repeat(8), bytes: SCREEN_PNG.length, createdAt: now - 1000,
  }];
  const { reg, root } = await bootScreenRegistry({ specs, runsFiles: [{ runId: "run-b", relPath: "evidence/shot-b.png", content: SCREEN_PNG }] });
  try {
    const r = await fetch(`${reg.base}/api/observer/v1/screen/bb`, { headers: { "x-registry-token": OBSERVER_TOKEN } });
    assert.equal(r.status, 404);
  } finally {
    await stopIsolated(reg, root);
  }
});

test("screen rejects evidence with empty or non-hex sha256 (strict digest required)", async () => {
  // 数据库摘要为空或非合法 64 位十六进制时，不得绕过完整性校验放行，一律 404。
  for (const bad of ["", "not-a-sha", "abcd".repeat(7) /* 56 chars, too short */]) {
    const alias = `badsha-${bad.length || "empty"}`;
    const specs = [{
      deviceId: `dev-${alias}`, alias, jobId: `job-${alias}`, runId: `run-${alias}`, evidenceId: `ev-${alias}`,
      path: "evidence/shot.png", sha256: bad, bytes: SCREEN_PNG.length, createdAt: now - 1000,
    }];
    const { reg, root } = await bootScreenRegistry({ specs, runsFiles: [{ runId: `run-${alias}`, relPath: "evidence/shot.png", content: SCREEN_PNG }] });
    try {
      const r = await fetch(`${reg.base}/api/observer/v1/screen/${alias}`, { headers: { "x-registry-token": OBSERVER_TOKEN } });
      assert.equal(r.status, 404, `empty/non-hex sha256 '${bad}' must be rejected (got ${r.status})`);
    } finally {
      await stopIsolated(reg, root);
    }
  }
});

test("screen rejects oversized screenshot", async () => {
  const huge = 8 * 1024 * 1024 + 1; // 大于生产 SCREEN_MAX_BYTES（8 MiB）
  const specs = [{
    deviceId: "dev-h", alias: "hh", jobId: "job-h", runId: "run-h", evidenceId: "ev-h",
    path: "evidence/shot-h.png", sha256: SCREEN_SHA, bytes: huge, createdAt: now - 1000,
  }];
  const { reg, root } = await bootScreenRegistry({ specs, runsFiles: [{ runId: "run-h", relPath: "evidence/shot-h.png", content: SCREEN_PNG }] });
  try {
    const r = await fetch(`${reg.base}/api/observer/v1/screen/hh`, { headers: { "x-registry-token": OBSERVER_TOKEN } });
    assert.equal(r.status, 413);
  } finally {
    await stopIsolated(reg, root);
  }
});

test("screen failure (runs-root missing) does not affect fleet or control plane", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xhs-registry-noruns-"));
  createRegistryDb(path.join(root, "registry.db"));
  createControlDb(path.join(root, "control.db"));
  await writeFile(path.join(root, "seed.json"), JSON.stringify({ identities: [{ alias: "01", serial: "s1", label: "一号", model: "M1" }] }));
  const reg = await startRegistry({ root, controlUrl: `http://127.0.0.1:${control.server.address().port}`, extraArgs: ["--runs-root", path.join(root, "does-not-exist")] });
  try {
    const screen = await fetch(`${reg.base}/api/observer/v1/screen/01`, { headers: { "x-registry-token": OBSERVER_TOKEN } });
    assert.equal(screen.status, 404);
    const fleet = await fetch(`${reg.base}/api/observer/v1/fleet`, { headers: { "x-registry-token": OBSERVER_TOKEN } });
    assert.equal(fleet.status, 200);
  } finally {
    await stopIsolated(reg, root);
  }
});

test("screen meta marks stale when screenshot age exceeds stale-after threshold", async () => {
  const specs = [{
    deviceId: "dev-s", alias: "ss", jobId: "job-s", runId: "run-s", evidenceId: "ev-s",
    path: "evidence/shot-s.png", sha256: SCREEN_SHA, bytes: SCREEN_PNG.length, createdAt: now - 200000, // 200s > 120s
  }];
  const { reg, root } = await bootScreenRegistry({ specs, runsFiles: [{ runId: "run-s", relPath: "evidence/shot-s.png", content: SCREEN_PNG }] });
  try {
    const meta = await (await fetch(`${reg.base}/api/observer/v1/screen/ss/meta`, { headers: { "x-registry-token": OBSERVER_TOKEN } })).json();
    assert.equal(meta.stale, true);
    assert.ok(meta.ageSeconds >= 120);
  } finally {
    await stopIsolated(reg, root);
  }
});

test("screen meta marks stale when fresh load fails and old cache is reused (fallback)", async () => {
  const specs = [{
    deviceId: "dev-f", alias: "ff", jobId: "job-f", runId: "run-f", evidenceId: "ev-f",
    path: "evidence/shot-f.png", sha256: SCREEN_SHA, bytes: SCREEN_PNG.length, createdAt: now - 1000,
  }];
  const { reg, root, runsRoot } = await bootScreenRegistry({ specs, runsFiles: [{ runId: "run-f", relPath: "evidence/shot-f.png", content: SCREEN_PNG }] });
  try {
    const h = { "x-registry-token": OBSERVER_TOKEN };
    // 首次加载填充缓存
    const first = await fetch(`${reg.base}/api/observer/v1/screen/ff`, { headers: h });
    assert.equal(first.status, 200);
    // 删除磁盘文件，等缓存 TTL（200ms）过期后重载 → 失败 → 沿用旧缓存 fallback → stale
    await rm(path.join(runsRoot, "run-f", "evidence", "shot-f.png"), { force: true });
    await new Promise((r) => setTimeout(r, 260));
    const meta = await (await fetch(`${reg.base}/api/observer/v1/screen/ff/meta`, { headers: h })).json();
    assert.equal(meta.stale, true);
  } finally {
    await stopIsolated(reg, root);
  }
});

test("fallback marker is written back to cache so the next request stays stale without re-reading", async () => {
  // 回归 P1：fallback=true 必须写回 screenCache。否则后续请求取到旧 fallback=false 条目，
  // 在旧 loadedAt 的 TTL 已过后会再次重载（这里用 REAL 计数观测）。
  // 写回后，紧接的第二次请求落在 fallback 条目的新 TTL 内 → 命中缓存、不再重载、仍 stale。
  const specs = [{
    deviceId: "dev-fb", alias: "fb", jobId: "job-fb", runId: "run-fb", evidenceId: "ev-fb",
    path: "evidence/shot-fb.png", sha256: SCREEN_SHA, bytes: SCREEN_PNG.length, createdAt: now - 1000,
  }];
  const counterFile = path.join(os.tmpdir(), `screen-fb-${process.pid}-${Math.floor(now)}.txt`);
  const { reg, root, runsRoot } = await bootScreenRegistry({
    specs, runsFiles: [{ runId: "run-fb", relPath: "evidence/shot-fb.png", content: SCREEN_PNG }],
    counterFile,
  });
  try {
    const h = { "x-registry-token": OBSERVER_TOKEN };
    // 首次加载填充缓存（fallback=false）
    const first = await fetch(`${reg.base}/api/observer/v1/screen/fb`, { headers: h });
    assert.equal(first.status, 200);
    await first.arrayBuffer();
    // 删除磁盘文件，等 TTL（200ms）过期后重载必失败 → 沿用旧缓存 fallback
    await rm(path.join(runsRoot, "run-fb", "evidence", "shot-fb.png"), { force: true });
    await new Promise((r) => setTimeout(r, 260));
    // 第一次 fallback 请求：触发一次重载尝试（realpath 失败，无 readFile），写回 fallback 缓存
    const meta1 = await (await fetch(`${reg.base}/api/observer/v1/screen/fb/meta`, { headers: h })).json();
    assert.equal(meta1.stale, true, "first fallback request must be stale");
    await new Promise((r) => setTimeout(r, 30));
    const realAfter1 = countTag(counterFile, "REAL");
    assert.ok(realAfter1 >= 2, `first fallback must have attempted a reload (got ${realAfter1} REAL calls)`);
    // 紧接第二次请求：落在 fallback 条目新 TTL 内 → 应命中缓存，不再重载，仍 stale。
    const meta2 = await (await fetch(`${reg.base}/api/observer/v1/screen/fb/meta`, { headers: h })).json();
    assert.equal(meta2.stale, true, "second request must stay stale via written-back fallback cache");
    await new Promise((r) => setTimeout(r, 30));
    const realAfter2 = countTag(counterFile, "REAL");
    assert.equal(realAfter2, realAfter1, `second request must not reload (REAL went ${realAfter1}->${realAfter2}); fallback must be served from cache`);
  } finally {
    await stopIsolated(reg, root);
    try { fs.unlinkSync(counterFile); } catch {}
  }
});

test("displayName/model are normalized (control chars stripped, length capped) and actorVerified is false", async () => {
  const longLabel = "店" + "a".repeat(200);
  const specs = [{
    deviceId: "dev-n", alias: "nn", jobId: "job-n", runId: "run-n", evidenceId: "ev-n",
    path: "evidence/shot-n.png", sha256: SCREEN_SHA, bytes: SCREEN_PNG.length, createdAt: now - 1000,
  }];
  const { reg, root } = await bootScreenRegistry({
    specs,
    runsFiles: [{ runId: "run-n", relPath: "evidence/shot-n.png", content: SCREEN_PNG }],
    seedIdentities: [{ alias: "nn", serial: "s-nn", label: `a\nb<script>\x00${longLabel}`, model: "M\tModel" }],
  });
  try {
    const fleet = await (await fetch(`${reg.base}/api/observer/v1/fleet`, { headers: { "x-registry-token": OBSERVER_TOKEN } })).json();
    const dev = fleet.devices.find((d) => d.alias === "nn");
    assert.ok(dev.displayName.length <= 60);
    assert.equal(/[\x00-\x1f\x7f]/.test(dev.displayName), false, "no control chars in displayName");
    assert.equal(dev.displayName.includes("<script>"), true); // HTML 不由 JSON 层剥离
    assert.equal(/[\x00-\x1f\x7f]/.test(dev.model || ""), false);
  } finally {
    await stopIsolated(reg, root);
  }
});

test("fleet reports ready=null and degraded=true when control plane is unreachable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xhs-registry-degraded-"));
  createRegistryDb(path.join(root, "registry.db"));
  createControlDb(path.join(root, "control.db"));
  await writeFile(path.join(root, "seed.json"), JSON.stringify({ identities: [{ alias: "03", serial: "REPLACE_SERIAL_03", label: "三店", model: "M3" }] }));
  // 控制面不可达：设备只来自身份缓存，online/quarantined/lease 全部未知 → ready=null，绝不假 Ready
  const reg = await startRegistry({ root, controlUrl: "http://127.0.0.1:1" });
  try {
    const fleet = await (await fetch(`${reg.base}/api/observer/v1/fleet`, { headers: { "x-registry-token": OBSERVER_TOKEN } })).json();
    assert.equal(fleet.degraded, true);
    const dev = fleet.devices.find((d) => d.alias === "03");
    assert.ok(dev, "03 present");
    assert.equal(dev.ready, null, "ready must be unknown, not fake-Ready");
  } finally {
    await stopIsolated(reg, root);
  }
});

test("screen meta response body never contains runId key", async () => {
  const h = { "x-registry-token": OBSERVER_TOKEN };
  const meta = await (await fetch(`${registry.base}/api/observer/v1/screen/01/meta`, { headers: h })).json();
  assert.equal("runId" in meta, false);
  assert.deepEqual(meta, {
    ok: true, alias: "01", sha256: SCREEN_SHA, bytes: SCREEN_PNG.length,
    capturedAt: meta.capturedAt, jobId: "job-succ-2", contentType: "image/png",
    ageSeconds: meta.ageSeconds, stale: false,
  });
});

// ─── REX Phase 2 收尾: Registry 资金最终提交人类确认面 ───
const PAYMENT_COMMIT_ID = "protected_commit_pay_fixture";

test("payment commit list is readable, redacted, and carries no secrets", async () => {
  const res = await fetch(`${registry.base}/api/payment-commits`, { headers: { "x-registry-token": TOKEN } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.sourceOk, true);
  assert.equal(body.paymentCommits.length, 1);
  const row = body.paymentCommits[0];
  assert.equal(row.commitId, PAYMENT_COMMIT_ID);
  assert.equal(row.approvalBinding.amount, "88.00");
  assert.equal(row.approvalBinding.payeeRef, "redacted:merchant");
  // 控制面 DTO 已脱敏：无私钥/control token/内部 params。
  assert.doesNotMatch(JSON.stringify(body), /BEGIN PRIVATE|privateKey|controlToken|x-control-token/);
});

test("payment approve signs the control-plane binding verbatim (browser cannot tamper amount)", async () => {
  control.paymentDecisions.length = 0;
  // 浏览器尝试在 body 里改 amount——Registry 必须忽略，按控制面 binding 签 88.00。
  const res = await fetch(`${registry.base}/api/payment-commits/${PAYMENT_COMMIT_ID}/decide`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-registry-token": HUMAN_TOKEN },
    body: JSON.stringify({ decision: "approve", confirm: "APPROVE_PAYMENT", amount: "9999.00", payeeRef: "impostor" }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.paymentCommit.status, "verified");
  assert.equal(control.paymentDecisions.length, 1);
  const posted = control.paymentDecisions[0];
  assert.equal(posted.decision, "approve");
  assert.equal(posted.commitId, PAYMENT_COMMIT_ID);
  const approval = posted.approval;
  // binding 取自控制面，不是 body：amount 仍是 88.00，payee 仍是 redacted:merchant。
  assert.equal(approval.amount, "88.00");
  assert.equal(approval.payeeRef, "redacted:merchant");
  assert.equal(approval.purpose, "financial_commit");
  assert.equal(approval.issuer.role, "human");
  assert.equal(approval.issuer.keyId, "payment-human-1");
  assert.equal(approval.issuer.allowlistVersion, 3);
  // 签名对控制面原样 binding + 人类 issuer 可验。
  const { signature, ...unsigned } = approval;
  const valid = verify(null, Buffer.from(canonicalJson(unsigned)), paymentSignerPublicKey, Buffer.from(signature, "base64"));
  assert.equal(valid, true);
});

test("payment approve requires the exact confirmation phrase", async () => {
  control.paymentDecisions.length = 0;
  const res = await fetch(`${registry.base}/api/payment-commits/${PAYMENT_COMMIT_ID}/decide`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-registry-token": HUMAN_TOKEN },
    body: JSON.stringify({ decision: "approve", confirm: "APPROVE" }),
  });
  assert.equal(res.status, 400);
  assert.equal(control.paymentDecisions.length, 0);
});

test("payment decide is human-only: agent, observer, operator, loopback all 403", async () => {
  for (const [name, headers] of [
    ["agent", { "x-registry-token": TOKEN }],
    ["observer", { "x-registry-token": OBSERVER_TOKEN }],
    ["operator", { "x-registry-token": OPERATOR_TOKEN }],
  ]) {
    const res = await fetch(`${registry.base}/api/payment-commits/${PAYMENT_COMMIT_ID}/decide`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ decision: "deny" }),
    });
    assert.equal(res.status, 403, `${name} must not decide payment`);
  }
});

test("payment deny works without a signer", async () => {
  control.paymentDecisions.length = 0;
  const res = await fetch(`${registry.base}/api/payment-commits/${PAYMENT_COMMIT_ID}/decide`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-registry-token": HUMAN_TOKEN },
    body: JSON.stringify({ decision: "deny", reason: "wrong amount on screen" }),
  });
  assert.equal(res.status, 200);
  assert.equal(control.paymentDecisions.length, 1);
  assert.equal(control.paymentDecisions[0].decision, "deny");
  assert.equal(control.paymentDecisions[0].approval, undefined);
  assert.equal(control.paymentDecisions[0].reason, "wrong amount on screen");
});

test("payment approve 503 when signer unavailable; deny still works", async () => {
  // 单独启一个不带 signer 文件的 registry（signer unavailable）。
  const reg = await startRegistry({ root: tempRoot, controlUrl: `http://127.0.0.1:${control.server.address().port}`,
    extraArgs: ["--runs-root", runsRoot] });
  try {
    control.paymentDecisions.length = 0;
    const approve = await fetch(`${reg.base}/api/payment-commits/${PAYMENT_COMMIT_ID}/decide`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-registry-token": HUMAN_TOKEN },
      body: JSON.stringify({ decision: "approve", confirm: "APPROVE_PAYMENT" }),
    });
    assert.equal(approve.status, 503);
    assert.equal(control.paymentDecisions.length, 0);
    const deny = await fetch(`${reg.base}/api/payment-commits/${PAYMENT_COMMIT_ID}/decide`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-registry-token": HUMAN_TOKEN },
      body: JSON.stringify({ decision: "deny" }),
    });
    assert.equal(deny.status, 200);
    assert.equal(control.paymentDecisions.length, 1);
    assert.equal(control.paymentDecisions[0].decision, "deny");
  } finally { await stopRegistry(reg.child); }
});

test("payment confirm UI is human-only, shows only payment commits, and enforces CSRF + phrase", async () => {
  // 非 human 看不到确认页。
  const agentPage = await fetch(`${registry.base}/payment`, { headers: { "x-registry-token": TOKEN } });
  assert.equal(agentPage.status, 403);

  // human 换 session 后看确认页：只含资金最终提交，不含普通审批 job-approval。
  const cookieRes = await fetch(`${registry.base}/?token=${HUMAN_TOKEN}`, { redirect: "manual" });
  const cookie = cookieRes.headers.get("set-cookie").split(";")[0];
  const pageRes = await fetch(`${registry.base}/payment`, { headers: { cookie } });
  assert.equal(pageRes.status, 200);
  const page = await pageRes.text();
  assert.match(page, /protected_commit_pay_fixture/);
  assert.match(page, /88\.00/);
  assert.match(page, /APPROVE_PAYMENT/);
  // 普通非支付审批任务不得出现在资金确认页。
  assert.doesNotMatch(page, /job-approval/);

  // 取页面里的 CSRF token。
  const csrf = (page.match(/name="csrf" value="([^"]+)"/) || [])[1];
  assert.ok(csrf, "CSRF token must be present on the payment page");

  // 缺确认短语 → 400，不提交。
  control.paymentDecisions.length = 0;
  const noPhrase = await fetch(`${registry.base}/ui/payment-commits/${PAYMENT_COMMIT_ID}/approve`, {
    method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf, confirmation: "NO" }).toString(),
    redirect: "manual",
  });
  assert.equal(noPhrase.status, 400);
  assert.equal(control.paymentDecisions.length, 0);

  // 错 CSRF → 403，不提交。
  const badCsrf = await fetch(`${registry.base}/ui/payment-commits/${PAYMENT_COMMIT_ID}/deny`, {
    method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf: "wrong", confirmation: "" }).toString(),
    redirect: "manual",
  });
  assert.equal(badCsrf.status, 403);
  assert.equal(control.paymentDecisions.length, 0);

  // 正确 CSRF + 短语 → 303 重定向，控制面收到 signed approve。
  const ok = await fetch(`${registry.base}/ui/payment-commits/${PAYMENT_COMMIT_ID}/approve`, {
    method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf, confirmation: "APPROVE_PAYMENT" }).toString(),
    redirect: "manual",
  });
  assert.equal(ok.status, 303);
  assert.equal(control.paymentDecisions.length, 1);
  assert.equal(control.paymentDecisions[0].approval.amount, "88.00");
});
