import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

const ROOT = path.resolve(import.meta.dirname, "..");
const TOKEN = "registry-test-token";
const HUMAN_TOKEN = "registry-test-human-token";
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
    CREATE TABLE devices (device_id TEXT PRIMARY KEY, alias TEXT);
    CREATE TABLE jobs (
      job_id TEXT PRIMARY KEY, run_id TEXT, actor_id TEXT, device_id TEXT, capability_id TEXT,
      capability_json TEXT, params_json TEXT, status TEXT, error_code TEXT,
      created_at INTEGER, updated_at INTEGER, started_at INTEGER, finished_at INTEGER
    );
    CREATE TABLE approvals (
      approval_id TEXT PRIMARY KEY, job_id TEXT, decision TEXT, actor_id TEXT, reason TEXT, created_at INTEGER
    );
  `);
  db.prepare("INSERT INTO devices VALUES (?,?)").run("dev-01", "01");
  db.prepare("INSERT INTO devices VALUES (?,?)").run("dev-03", "03");
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
  const server = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/control/v1/health") return json(res, 200, { nodeId: "test-node", authority: true, activeLeases: 1 });
    if (req.method === "GET" && req.url === "/control/v1/devices") return json(res, 200, { devices: [
      { deviceId: "dev-01", alias: "01", online: true, quarantined: false },
      { deviceId: "dev-03", alias: "03", online: true, quarantined: true, quarantineReason: "ADAPTER_FAILED" },
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
    return json(res, 404, { ok: false });
  });
  return { server, decisions };
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
  if (requireAuth) args.push("--agent-token", TOKEN, "--human-token", HUMAN_TOKEN, "--trust-loopback", "false");
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

test.before(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "xhs-registry-test-"));
  createRegistryDb(path.join(tempRoot, "registry.db"));
  createControlDb(path.join(tempRoot, "control.db"));
  await writeFile(path.join(tempRoot, "seed.json"), JSON.stringify({ identities: [
    { alias: "01", serial: "serial-01", label: "一号 <script>alert(1)</script>", model: "M1", accounts: { xhs: "private-account" }, notes: "private-note" },
    { alias: "03", serial: "REPLACE_SERIAL_03", label: "三店", model: "M3" },
  ] }));
  control = createControlServer();
  control.server.listen(0, "127.0.0.1");
  await once(control.server, "listening");
  registry = await startRegistry({ root: tempRoot, controlUrl: `http://127.0.0.1:${control.server.address().port}` });
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
  registry = await startRegistry({ root: tempRoot, controlUrl: `http://127.0.0.1:${control.server.address().port}` });
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
