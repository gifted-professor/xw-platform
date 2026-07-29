import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
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
  const server = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/control/v1/health") return json(res, 200, { nodeId: "test-node", authority: true, activeLeases: 1 });
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
    return json(res, 404, { ok: false });
  });
  return { server, decisions, submissions };
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

async function startRegistry({ root, controlUrl, requireAuth = true, extraArgs = [], probeToken = null }) {
  const port = await freePort();
  const args = [path.join(ROOT, "registry.mjs"), "--port", String(port), "--host", "127.0.0.1",
    "--control", controlUrl, "--db", path.join(root, "registry.db"), "--seed", path.join(root, "seed.json"),
    "--control-db", path.join(root, "control.db")];
  if (requireAuth) args.push("--agent-token", TOKEN, "--human-token", HUMAN_TOKEN, "--trust-loopback", "false",
    "--observer-token", OBSERVER_TOKEN, "--operator-token", OPERATOR_TOKEN);
  args.push(...extraArgs);
  const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
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

test.before(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "xhs-registry-test-"));
  createRegistryDb(path.join(tempRoot, "registry.db"));
  createControlDb(path.join(tempRoot, "control.db"));
  await writeFile(path.join(tempRoot, "seed.json"), JSON.stringify({ identities: [
    { alias: "01", serial: "serial-01", label: "一号 <script>alert(1)</script>", model: "M1", accounts: { xhs: "private-account" }, notes: "private-note" },
    { alias: "03", serial: "REPLACE_SERIAL_03", label: "三店", model: "M3" },
  ] }));
  // cache-only Screen API 的 runs-root：放一张假截图供 evidence 行读取
  runsRoot = path.join(tempRoot, "runs");
  await mkdir(path.join(runsRoot, "run-succ-2", "evidence"), { recursive: true });
  await writeFile(path.join(runsRoot, "run-succ-2", "evidence", "shot-aaaaaaaaaaaa.png"), SCREEN_PNG);
  control = createControlServer();
  control.server.listen(0, "127.0.0.1");
  await once(control.server, "listening");
  registry = await startRegistry({ root: tempRoot, controlUrl: `http://127.0.0.1:${control.server.address().port}`,
    extraArgs: ["--runs-root", runsRoot] });
});

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
    extraArgs: ["--runs-root", runsRoot] });
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
async function bootScreenRegistry({ specs, runsFiles = [], seedIdentities, extraArgs = [] }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "xhs-registry-screen-"));
  createRegistryDb(path.join(root, "registry.db"));
  buildScreenControlDb(path.join(root, "control.db"), specs);
  await writeFile(path.join(root, "seed.json"), JSON.stringify({ identities: seedIdentities ?? specs.map((s) => ({ alias: s.alias, serial: `s-${s.alias}`, label: s.label ?? `设备${s.alias}`, model: s.model ?? "M1" })) }));
  const runsRoot = path.join(root, "runs");
  await mkdir(runsRoot, { recursive: true });
  for (const f of runsFiles) await writeRunsFile(runsRoot, f.runId, f.relPath, f.content);
  const reg = await startRegistry({
    root, controlUrl: `http://127.0.0.1:${control.server.address().port}`,
    extraArgs: ["--runs-root", runsRoot, "--screen-cache-ttl-ms", "200", "--screen-min-interval-ms", "0", ...extraArgs],
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

test("concurrent observer screen requests share one load and do not trigger capture", async () => {
  // 单飞是进程内机制；此处验证可观测契约：并发请求返回一致字节/ETag 且不触发采集。
  const specs = [{
    deviceId: "dev-c", alias: "cc", jobId: "job-c", runId: "run-c", evidenceId: "ev-c",
    path: "evidence/shot-c.png", sha256: SCREEN_SHA, bytes: SCREEN_PNG.length, createdAt: now - 1000,
  }];
  const { reg, root } = await bootScreenRegistry({ specs, runsFiles: [{ runId: "run-c", relPath: "evidence/shot-c.png", content: SCREEN_PNG }] });
  try {
    const h = { "x-registry-token": OBSERVER_TOKEN };
    const before = control.submissions.length;
    const responses = await Promise.all(Array.from({ length: 8 }, () => fetch(`${reg.base}/api/observer/v1/screen/cc`, { headers: h })));
    for (const r of responses) {
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("etag"), `"${SCREEN_SHA}"`);
    }
    const bodies = await Promise.all(responses.map((r) => r.arrayBuffer()));
    assert.ok(bodies.every((b) => Buffer.from(b).equals(SCREEN_PNG)), "all concurrent responses identical");
    assert.equal(control.submissions.length, before, "no capture triggered");
  } finally {
    await stopIsolated(reg, root);
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
