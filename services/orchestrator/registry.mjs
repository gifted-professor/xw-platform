#!/usr/bin/env node
/**
 * registry.mjs — 设备身份注册 + 控制面状态聚合 + 人的视图
 *
 * 零第三方依赖：node:http + node:sqlite（Node 22.5+，Windows 上 Node 24 已验证）。
 * 设计原则：
 *   - 控制面（17920）代码一行不碰，只读聚合它的公开 API。
 *   - 身份真相在飞书多维表格；本服务只做缓存（TTL 内直接用，过期仍返回并标注 stale）。
 *   - 控制面不可达时降级为只显示身份缓存，不 500。
 *   - 审批（Phase 3）：不重建审批状态机。pending 列表只读查询控制面 control.db
 *     （控制面没有 jobs 列表 API；WAL 模式下并发只读安全，registry 绝不写 control.db）；
 *     批准/拒绝代理到控制面 POST /control/v1/approvals/:jobId，由控制面落库。
 *
 * 用法:
 *   node registry.mjs [--port 17930] [--host 127.0.0.1] [--control http://127.0.0.1:17920] [--db ./registry.db] [--seed ./identities.seed.json] [--control-db <path>]
 *                     [--agent-token <str>] [--human-token <str>] [--human-actor <name>] [--identity-stale-s 900] [--token <str> 兼容旧参]
 *
 * 鉴权模型（v2）：
 *   - --agent-token：agent 凭证，可读一切、写知识库/身份，禁止审批。缺省回落旧 --token。
 *   - --human-token：人类凭证，唯一能 approve/deny 的角色。未提供时进入 LEGACY 模式（行为与旧版完全一致）。
 *   - loopback 免凭证只授予只读 + 知识库/身份写入，永远不含审批。
 *
 * 注意（Windows bridge exec 约束）：本脚本禁止 console.error，一律 console.log。
 */
import http from "node:http";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- 参数 ----------
function argOf(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const PORT = Number(argOf("port", "17930"));
const HOST = argOf("host", "127.0.0.1");
const CONTROL = argOf("control", "http://127.0.0.1:17920").replace(/\/+$/, "");
const DB_PATH = argOf("db", path.join(__dirname, "registry.db"));
const SEED_PATH = argOf("seed", path.join(__dirname, "identities.seed.json"));
const CONTROL_DB_PATH = argOf("control-db", "C:\\Users\\Public\\xhs-agent-control\\control.db");
const TOKEN = argOf("token", "");
const AGENT_TOKEN = argOf("agent-token", TOKEN);
const HUMAN_TOKEN = argOf("human-token", "");
const HUMAN_ACTOR = argOf("human-actor", "console");
// 没有 human token = LEGACY 模式：单 token/loopback 管一切，行为与旧版一致（迁移期兼容）。
const LEGACY_AUTH = !HUMAN_TOKEN;
const IDENTITY_STALE_S = Math.max(60, Number(argOf("identity-stale-s", "900")) || 900);
const TRUST_LOOPBACK = argOf("trust-loopback", "true") !== "false";
const CONTROL_TIMEOUT_MS = 3000;
const SESSION_TTL_S = 30 * 60;
const SESSION_COOKIE = "xhs_registry_session";
const SESSION_SECRET = HUMAN_TOKEN || AGENT_TOKEN || randomBytes(32).toString("hex");

// ---------- DB ----------
const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS identities (
    alias TEXT PRIMARY KEY,
    serial TEXT,
    label TEXT,
    model TEXT,
    accounts_json TEXT NOT NULL DEFAULT '{}',
    customer TEXT,
    notes TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sync_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS knowledge (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL DEFAULT 'global',
    app TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'pitfall',
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    verified_by_json TEXT NOT NULL DEFAULT '[]',
    needs_engineer INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS knowledge_app_idx ON knowledge(app, category);
  CREATE TABLE IF NOT EXISTS approval_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL,
    decision TEXT NOT NULL,
    actor TEXT NOT NULL,
    actor_source TEXT NOT NULL,
    reason TEXT,
    channel TEXT NOT NULL,
    remote_addr TEXT,
    proxied_status INTEGER,
    proxied_ok INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS approval_audit_job_idx ON approval_audit(job_id, created_at);
`);

// ---------- 幂等迁移：knowledge 扩展列 ----------
{
  const cols = db.prepare("PRAGMA table_info(knowledge)").all().map((c) => c.name);
  if (!cols.includes("applies_to_json")) db.exec("ALTER TABLE knowledge ADD COLUMN applies_to_json TEXT NOT NULL DEFAULT '[]'");
  if (!cols.includes("steps_json"))      db.exec("ALTER TABLE knowledge ADD COLUMN steps_json TEXT NOT NULL DEFAULT '[]'");
  if (!cols.includes("verify_mode"))     db.exec("ALTER TABLE knowledge ADD COLUMN verify_mode TEXT");
  if (!cols.includes("lifecycle"))       db.exec("ALTER TABLE knowledge ADD COLUMN lifecycle TEXT");
  if (!cols.includes("resolved_at"))     db.exec("ALTER TABLE knowledge ADD COLUMN resolved_at TEXT");
  if (!cols.includes("resolution"))      db.exec("ALTER TABLE knowledge ADD COLUMN resolution TEXT");

  const now = new Date().toISOString();
  db.prepare(`UPDATE knowledge
    SET lifecycle='resolved', needs_engineer=0, resolved_at=COALESCE(resolved_at, ?),
        resolution=COALESCE(resolution, '02 已于 2026-07-26 18:59 完成全链验证'), updated_at=?
    WHERE id IN ('xianyu-2x5-timeout-restoration-recovery-20260726',
                 'xianyu-02-sku-not-on-compose-recovery-20260726')
      AND lifecycle IS NULL`).run(now, now);
  db.prepare(`UPDATE knowledge
    SET lifecycle='active_blocker', needs_engineer=1, resolved_at=NULL, resolution=NULL, updated_at=?
    WHERE id='xianyu-03-physical-disconnect-gateway-probe-20260726'
      AND lifecycle IS NULL`).run(now);
  db.prepare(`UPDATE knowledge SET
    lifecycle=CASE WHEN needs_engineer=1 THEN 'backlog' WHEN category='unknown' THEN 'probe_unknown' ELSE 'resolved' END,
    needs_engineer=CASE WHEN needs_engineer=1 THEN 1 ELSE 0 END,
    resolved_at=CASE WHEN needs_engineer=1 OR category='unknown' THEN NULL ELSE COALESCE(resolved_at, updated_at, created_at, ?) END,
    resolution=CASE WHEN needs_engineer=1 OR category='unknown' THEN NULL ELSE COALESCE(resolution, '存量知识迁移为非活动状态') END
    WHERE lifecycle IS NULL`).run(now);
}

function listIdentities() {
  return db.prepare("SELECT * FROM identities ORDER BY alias").all().map((r) => ({
    alias: r.alias,
    serial: r.serial,
    label: r.label,
    model: r.model,
    accounts: JSON.parse(r.accounts_json || "{}"),
    customer: r.customer,
    notes: r.notes,
    updatedAt: r.updated_at,
  }));
}

function replaceIdentities(identities) {
  const now = new Date().toISOString();
  const up = db.prepare(`
    INSERT INTO identities (alias, serial, label, model, accounts_json, customer, notes, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(alias) DO UPDATE SET
      serial=excluded.serial, label=excluded.label, model=excluded.model,
      accounts_json=excluded.accounts_json, customer=excluded.customer,
      notes=excluded.notes, updated_at=excluded.updated_at
  `);
  try {
    db.exec("BEGIN");
    for (const it of identities) {
      up.run(
        String(it.alias ?? ""),
        it.serial ?? null,
        it.label ?? null,
        it.model ?? null,
        JSON.stringify(it.accounts ?? {}),
        it.customer ?? null,
        it.notes ?? null,
        now,
      );
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  db.prepare("INSERT INTO sync_meta (key, value) VALUES ('last_identity_sync', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(now);
}

function metaGet(key) {
  const r = db.prepare("SELECT value FROM sync_meta WHERE key=?").get(key);
  return r ? r.value : null;
}

// ---------- 知识库 ----------
const KNOW_CATEGORIES = new Set(["pitfall", "recipe", "unknown"]);
const KNOW_LIFECYCLES = new Set(["active_blocker", "backlog", "resolved", "probe_unknown"]);

function rowToKnowledge(r) {
  return {
    id: r.id,
    scope: r.scope,
    app: r.app,
    category: r.category,
    title: r.title,
    content: r.content,
    verifiedBy: JSON.parse(r.verified_by_json || "[]"),
    needsEngineer: Boolean(r.needs_engineer),
    appliesTo: JSON.parse(r.applies_to_json || "[]"),
    steps: JSON.parse(r.steps_json || "[]"),
    verifyMode: r.verify_mode ?? null,
    lifecycle: r.lifecycle ?? null,
    resolvedAt: r.resolved_at ?? null,
    resolution: r.resolution ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function listKnowledge({ app, category, q, limit, lifecycle, appliesTo } = {}) {
  const where = [];
  const args = [];
  if (app) { where.push("app=?"); args.push(app); }
  if (category) { where.push("category=?"); args.push(category); }
  if (lifecycle) { where.push("lifecycle=?"); args.push(lifecycle); }
  if (appliesTo) { where.push("EXISTS (SELECT 1 FROM json_each(applies_to_json) WHERE value=?)"); args.push(appliesTo); }
  // q 同时搜 id：入口只给最近 N 条，agent 常常已知 id（如 routing-table-v2）却搜不到
  if (q) { where.push("(id LIKE ? OR title LIKE ? OR content LIKE ?)"); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const lim = limit ? ` LIMIT ${Math.max(1, Math.min(100, Number(limit)))}` : "";
  const sql = `SELECT * FROM knowledge ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY updated_at DESC${lim}`;
  return db.prepare(sql).all(...args).map(rowToKnowledge);
}

function getKnowledge(id) {
  const r = db.prepare("SELECT * FROM knowledge WHERE id=?").get(id);
  if (!r) { const e = new Error(`knowledge not found: ${id}`); e.status = 404; throw e; }
  return rowToKnowledge(r);
}

function slugify(title, app) {
  const base = `${app || "misc"}-${title}`.toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return base || `k-${Date.now()}`;
}

const VALID_VERIFY_MODES = new Set(["replay", "constraint", "human"]);

function addKnowledge(input) {
  const now = new Date().toISOString();
  let id = input.id ? String(input.id) : slugify(String(input.title || ""), String(input.app || ""));
  const exists = db.prepare("SELECT id FROM knowledge WHERE id=?").get(id);
  if (exists) {
    const err = new Error(`knowledge id already exists: ${id}`);
    err.status = 409;
    throw err;
  }
  if (!input.title || !input.content) {
    const err = new Error("title and content are required");
    err.status = 400;
    throw err;
  }
  const category = KNOW_CATEGORIES.has(input.category) ? input.category : "pitfall";
  const appliesTo = Array.isArray(input.appliesTo) ? input.appliesTo : [];
  const steps = Array.isArray(input.steps) ? input.steps : [];
  const verifyMode = input.verifyMode != null ? String(input.verifyMode) : null;
  if (verifyMode !== null && !VALID_VERIFY_MODES.has(verifyMode)) {
    const err = new Error(`verifyMode must be one of replay|constraint|human|null`);
    err.status = 400;
    throw err;
  }
  const lifecycle = input.lifecycle == null
    ? (input.needsEngineer === true ? "backlog" : category === "unknown" ? "probe_unknown" : "resolved")
    : String(input.lifecycle);
  if (!KNOW_LIFECYCLES.has(lifecycle)) {
    const err = new Error("lifecycle must be one of active_blocker|backlog|resolved|probe_unknown");
    err.status = 400;
    throw err;
  }
  const resolvedAt = lifecycle === "resolved" ? now : null;
  const resolution = lifecycle === "resolved" && input.resolution ? String(input.resolution).slice(0, 1000) : null;
  const needsEngineer = ["active_blocker", "backlog"].includes(lifecycle);
  db.prepare(`INSERT INTO knowledge (id, scope, app, category, title, content, verified_by_json, needs_engineer,
              applies_to_json, steps_json, verify_mode, lifecycle, resolved_at, resolution, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id,
    String(input.scope || "global"),
    String(input.app || ""),
    category,
    String(input.title),
    String(input.content),
    JSON.stringify(Array.isArray(input.verifiedBy) ? input.verifiedBy : []),
    needsEngineer ? 1 : 0,
    JSON.stringify(appliesTo),
    JSON.stringify(steps),
    verifyMode,
    lifecycle,
    resolvedAt,
    resolution,
    now,
    now,
  );
  return rowToKnowledge(db.prepare("SELECT * FROM knowledge WHERE id=?").get(id));
}

function verifyKnowledge(id, by) {
  const r = db.prepare("SELECT * FROM knowledge WHERE id=?").get(id);
  if (!r) { const e = new Error(`knowledge not found: ${id}`); e.status = 404; throw e; }
  const list = JSON.parse(r.verified_by_json || "[]");
  const who = String(by || "anonymous").slice(0, 60);
  if (!list.includes(who)) list.push(who);
  db.prepare("UPDATE knowledge SET verified_by_json=?, updated_at=? WHERE id=?").run(JSON.stringify(list), new Date().toISOString(), id);
  return rowToKnowledge(db.prepare("SELECT * FROM knowledge WHERE id=?").get(id));
}

function flagEngineer(id, needs) {
  const r = db.prepare("SELECT * FROM knowledge WHERE id=?").get(id);
  if (!r) { const e = new Error(`knowledge not found: ${id}`); e.status = 404; throw e; }
  if (needs && r.lifecycle === "resolved") {
    const e = new Error("resolved lifecycle is terminal; create a new knowledge item for a recurrence"); e.status = 409; throw e;
  }
  const lifecycle = needs
    ? (r.lifecycle === "active_blocker" ? "active_blocker" : "backlog")
    : (["active_blocker", "backlog"].includes(r.lifecycle) ? "resolved" : r.lifecycle);
  return updateKnowledge(id, {
    lifecycle,
    resolution: !needs && lifecycle === "resolved" ? "已由 flag-engineer 解除" : undefined,
  });
}

function updateKnowledge(id, input) {
  const r = db.prepare("SELECT * FROM knowledge WHERE id=?").get(id);
  if (!r) { const e = new Error(`knowledge not found: ${id}`); e.status = 404; throw e; }
  const appliesTo = input.appliesTo !== undefined ? input.appliesTo : JSON.parse(r.applies_to_json || "[]");
  const steps = input.steps !== undefined ? input.steps : JSON.parse(r.steps_json || "[]");
  const verifyMode = input.verifyMode !== undefined ? input.verifyMode : r.verify_mode;
  if (!Array.isArray(appliesTo)) { const e = new Error("appliesTo must be an array"); e.status = 400; throw e; }
  if (!Array.isArray(steps)) { const e = new Error("steps must be an array"); e.status = 400; throw e; }
  if (verifyMode !== null && verifyMode !== undefined && !VALID_VERIFY_MODES.has(String(verifyMode))) {
    const e = new Error("verifyMode must be one of replay|constraint|human|null"); e.status = 400; throw e;
  }

  const currentLifecycle = r.lifecycle ?? null;
  const lifecycle = input.lifecycle !== undefined ? input.lifecycle : currentLifecycle;
  if (!KNOW_LIFECYCLES.has(String(lifecycle))) {
    const e = new Error("lifecycle must be one of active_blocker|backlog|resolved|probe_unknown"); e.status = 400; throw e;
  }
  if (currentLifecycle === "resolved" && lifecycle !== "resolved") {
    const e = new Error("resolved lifecycle is terminal"); e.status = 409; throw e;
  }
  const allowed = {
    active_blocker: new Set(["active_blocker", "resolved"]),
    backlog: new Set(["backlog", "resolved"]),
    probe_unknown: new Set(["probe_unknown", "backlog", "active_blocker"]),
    resolved: new Set(["resolved"]),
  };
  if (currentLifecycle && lifecycle && !allowed[currentLifecycle]?.has(String(lifecycle))) {
    const e = new Error(`invalid lifecycle transition: ${currentLifecycle} -> ${lifecycle}`); e.status = 409; throw e;
  }
  const nextLifecycle = String(lifecycle);
  const now = new Date().toISOString();
  const resolvedAt = nextLifecycle === "resolved" ? (r.resolved_at || now) : null;
  const resolution = nextLifecycle === "resolved"
    ? String(input.resolution ?? r.resolution ?? "已解决").slice(0, 1000)
    : null;
  const needsEngineer = ["active_blocker", "backlog"].includes(nextLifecycle) ? 1 : 0;
  db.prepare(`UPDATE knowledge SET applies_to_json=?, steps_json=?, verify_mode=?, lifecycle=?,
              resolved_at=?, resolution=?, needs_engineer=?, updated_at=? WHERE id=?`)
    .run(JSON.stringify(appliesTo), JSON.stringify(steps), verifyMode ?? null, nextLifecycle,
      resolvedAt, resolution, needsEngineer, now, id);
  return rowToKnowledge(db.prepare("SELECT * FROM knowledge WHERE id=?").get(id));
}

// seed：DB 为空且 seed 文件存在时灌入
if (db.prepare("SELECT COUNT(*) AS c FROM identities").get().c === 0 && fs.existsSync(SEED_PATH)) {
  try {
    const seed = JSON.parse(fs.readFileSync(SEED_PATH, "utf8"));
    if (Array.isArray(seed.identities) && seed.identities.length > 0) {
      replaceIdentities(seed.identities);
      console.log(`[registry] seeded ${seed.identities.length} identities from ${SEED_PATH}`);
    }
  } catch (e) {
    console.log(`[registry] seed skipped: ${e.message}`);
  }
}

// ---------- 控制面聚合 ----------
async function fetchJson(url, timeoutMs = CONTROL_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function aggregate() {
  const identities = listIdentities();
  const byAlias = new Map(identities.map((i) => [i.alias, i]));
  const lastAt = metaGet("last_identity_sync");
  const parsedAt = lastAt ? Date.parse(lastAt) : NaN;
  const ageSeconds = Number.isFinite(parsedAt) ? Math.max(0, Math.round((Date.now() - parsedAt) / 1000)) : null;
  const identityCacheStale = ageSeconds === null || ageSeconds > IDENTITY_STALE_S;
  const out = {
    ok: true,
    now: new Date().toISOString(),
    controlPlane: { reachable: false, url: CONTROL },
    identitySync: { lastAt, ageSeconds, staleAfterSeconds: IDENTITY_STALE_S, stale: identityCacheStale, count: identities.length },
    devices: [],
  };

  let ctlDevices = [], ctlLeases = [], health = null;
  try {
    [health, { devices: ctlDevices = [] } = {}, { leases: ctlLeases = [] } = {}] = await Promise.all([
      fetchJson(`${CONTROL}/control/v1/health`),
      fetchJson(`${CONTROL}/control/v1/devices`),
      fetchJson(`${CONTROL}/control/v1/leases`),
    ]);
    out.controlPlane = {
      reachable: true,
      url: CONTROL,
      nodeId: health?.nodeId ?? null,
      authority: health?.authority ?? null,
      activeLeases: health?.activeLeases ?? null,
    };
  } catch (e) {
    out.controlPlane.error = String(e.message || e);
  }

  const leaseByDeviceId = new Map(ctlLeases.map((l) => [l.deviceId ?? l.device_id, l]));
  const seen = new Set();

  // 控制面在线设备 ∪ 本地身份（以 alias 关联）
  for (const d of ctlDevices) {
    const id = byAlias.get(d.alias) || null;
    seen.add(d.alias);
    const lease = leaseByDeviceId.get(d.deviceId) || null;
    out.devices.push({
      alias: d.alias,
      serial: id?.serial ?? null,
      label: id?.label ?? null,
      model: id?.model ?? null,
      accounts: id?.accounts ?? {},
      customer: id?.customer ?? null,
      notes: id?.notes ?? null,
      identityKnown: Boolean(id),
      identityStale: identityCacheStale,
      control: {
        deviceId: d.deviceId,
        online: Boolean(d.online),
        quarantined: Boolean(d.quarantined),
        quarantineReason: d.quarantineReason ?? null,
        lease: lease
          ? { holderId: lease.holderId ?? lease.holder_id, kind: lease.kind, expiresAt: lease.expiresAt ?? lease.expires_at }
          : null,
      },
    });
  }
  // 本地有身份但控制面没列出的（如 03 离线机）
  for (const id of identities) {
    if (seen.has(id.alias)) continue;
    out.devices.push({
      alias: id.alias,
      serial: id.serial,
      label: id.label,
      model: id.model,
      accounts: id.accounts,
      customer: id.customer,
      notes: id.notes,
      identityKnown: true,
      identityStale: identityCacheStale,
      control: out.controlPlane.reachable
        ? { deviceId: null, online: false, notListed: true, quarantined: false, lease: null }
        : null,
    });
  }
  out.devices.sort((a, b) => String(a.alias).localeCompare(String(b.alias)));
  return out;
}

// ---------- 审批（Phase 3）----------
// 控制面没有 jobs 列表 API，pending 只能只读查 control.db（WAL 并发只读，绝不写入）。
// 批准/拒绝一律代理到控制面 REST，由控制面自己的 decideApproval 落库。
let controlDb;
let controlDbRetryAfter = 0; // 打开/查询失败后 30s 再重试，避免一次失败永久降级
function openControlDb() {
  if (controlDb) return controlDb;
  if (Date.now() < controlDbRetryAfter) return null;
  try {
    controlDb = new DatabaseSync(CONTROL_DB_PATH, { readOnly: true });
    return controlDb;
  } catch (e) {
    controlDbRetryAfter = Date.now() + 30000;
    console.log(`[registry] control.db open failed (approvals degraded, retry in 30s): ${e.message}`);
    return null;
  }
}

function closeControlDb() {
  try { controlDb?.close(); } catch { /* ignore */ }
  controlDb = undefined;
  controlDbRetryAfter = Date.now() + 30000;
}

// 控制面重启/迁移时 control.db 可能被锁定或重建，查询一律走这里：出错关句柄、降级、稍后重试
function queryControlDb(fn, degraded) {
  const cdb = openControlDb();
  if (!cdb) return degraded;
  try {
    return fn(cdb);
  } catch (e) {
    console.log(`[registry] control.db query failed (approvals degraded, will reopen): ${e.message}`);
    closeControlDb();
    return degraded;
  }
}

function truncateParams(params, maxLen = 200) {
  const out = {};
  for (const [k, v] of Object.entries(params || {})) {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    out[k] = s.length > maxLen ? s.slice(0, maxLen) + "…" : s;
  }
  return out;
}

function jobRowToApproval(r, byAlias) {
  let capability = null;
  try {
    const c = JSON.parse(r.capability_json || "{}");
    capability = { id: c.id ?? r.capability_id, appId: c.appId ?? null, risk: c.risk ?? null, maturity: c.maturity ?? null };
  } catch {
    capability = { id: r.capability_id, appId: null, risk: null, maturity: null };
  }
  let params = {};
  try { params = JSON.parse(r.params_json || "{}"); } catch { /* keep {} */ }
  const id = r.alias ? byAlias.get(r.alias) : null;
  return {
    jobId: r.job_id,
    actorId: r.actor_id,
    deviceId: r.device_id,
    alias: r.alias ?? null,
    device: id ? { label: id.label, serial: id.serial } : null,
    capability,
    params: truncateParams(params),
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
  };
}

function listPendingApprovals() {
  const byAlias = new Map(listIdentities().map((i) => [i.alias, i]));
  return queryControlDb((cdb) => {
    const rows = cdb.prepare(`
    SELECT j.job_id, j.actor_id, j.device_id, j.capability_id, j.capability_json, j.params_json, j.created_at, d.alias
    FROM jobs j LEFT JOIN devices d ON d.device_id = j.device_id
    WHERE j.status = 'waiting_approval'
    ORDER BY j.created_at ASC
  `).all();
    return { ok: true, pending: rows.map((r) => jobRowToApproval(r, byAlias)) };
  }, { ok: false, error: "control.db 暂不可读", pending: [] });
}

function listRecentApprovals(limit = 20) {
  const byAlias = new Map(listIdentities().map((i) => [i.alias, i]));
  return queryControlDb((cdb) => {
    const rows = cdb.prepare(`
    SELECT a.approval_id, a.job_id, a.decision, a.actor_id AS decider, a.reason, a.created_at AS decided_at,
           j.actor_id, j.device_id, j.capability_id, j.capability_json, j.params_json, j.status AS job_status, d.alias
    FROM approvals a
    JOIN jobs j ON j.job_id = a.job_id
    LEFT JOIN devices d ON d.device_id = j.device_id
    ORDER BY a.created_at DESC LIMIT ?
  `).all(Math.max(1, Math.min(100, Number(limit) || 20)));
    return {
      ok: true,
      recent: rows.map((r) => ({
        ...jobRowToApproval(r, byAlias),
        decision: r.decision,
        decider: r.decider,
        reason: r.reason,
        decidedAt: r.decided_at ? new Date(r.decided_at).toISOString() : null,
        jobStatus: r.job_status,
      })),
    };
  }, { ok: false, error: "control.db 暂不可读", recent: [] });
}

function jobRowToSummary(r, byAlias) {
  const id = r.alias ? byAlias.get(r.alias) : null;
  return {
    jobId: r.job_id,
    runId: r.run_id,
    actorId: r.actor_id,
    deviceId: r.device_id,
    alias: r.alias ?? null,
    serial: id?.serial ?? null,
    capabilityId: r.capability_id,
    status: r.status,
    errorCode: r.error_code ?? null,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
    startedAt: r.started_at ? new Date(r.started_at).toISOString() : null,
    finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
  };
}

function listJobOverview(limit = 20) {
  const byAlias = new Map(listIdentities().map((i) => [i.alias, i]));
  return queryControlDb((cdb) => {
    const base = `SELECT j.job_id, j.run_id, j.actor_id, j.device_id, j.capability_id, j.status,
                         j.error_code, j.created_at, j.updated_at, j.started_at, j.finished_at, d.alias
                  FROM jobs j LEFT JOIN devices d ON d.device_id=j.device_id`;
    const activeRows = cdb.prepare(`${base}
      WHERE j.status IN ('queued','waiting_approval','running','verifying','restoring')
      ORDER BY j.created_at ASC`).all();
    const recentRows = cdb.prepare(`${base} ORDER BY j.updated_at DESC LIMIT ?`)
      .all(Math.max(1, Math.min(100, Number(limit) || 20)));
    const failureRows = cdb.prepare(`${base}
      WHERE j.status IN ('failed','ambiguous','recovery_required')
      ORDER BY COALESCE(j.finished_at,j.updated_at) DESC LIMIT ?`)
      .all(Math.max(1, Math.min(100, Number(limit) || 20)));
    return {
      ok: true,
      active: activeRows.map((r) => jobRowToSummary(r, byAlias)),
      recent: recentRows.map((r) => jobRowToSummary(r, byAlias)),
      failures: failureRows.map((r) => jobRowToSummary(r, byAlias)),
    };
  }, { ok: false, error: "control.db 暂不可读", active: [], recent: [], failures: [] });
}

// per-device 任务状态：区别于「历史最后一条失败」，只有发生在最后一次成功之后的失败才算 unresolved。
const JOB_SUCCESS_STATUSES = new Set(["succeeded"]);
const JOB_FAILURE_STATUSES = new Set(["failed", "ambiguous", "recovery_required"]);
const DEVICE_JOB_WINDOW = 50;

function emptyDeviceJobStatus(sourceOk) {
  return { latestJob: null, lastSuccess: null, lastFailure: null, unresolvedFailure: null, consecutiveSuccesses: 0, window: DEVICE_JOB_WINDOW, sourceOk };
}

function listDeviceJobStatus(windowPerDevice = DEVICE_JOB_WINDOW) {
  const byAlias = new Map(listIdentities().map((i) => [i.alias, i]));
  const win = Math.max(1, Math.min(200, Number(windowPerDevice) || DEVICE_JOB_WINDOW));
  return queryControlDb((cdb) => {
    // tiebreaker 用 job_id 而不是 rowid：WITHOUT ROWID 表引用 rowid 会抛错并把整块降级
    const rows = cdb.prepare(`SELECT * FROM (
      SELECT j.job_id, j.run_id, j.actor_id, j.device_id, j.capability_id, j.status,
             j.error_code, j.created_at, j.updated_at, j.started_at, j.finished_at, d.alias,
             ROW_NUMBER() OVER (PARTITION BY j.device_id
               ORDER BY COALESCE(j.finished_at, j.updated_at, j.created_at) DESC, j.job_id DESC) AS rn
      FROM jobs j LEFT JOIN devices d ON d.device_id = j.device_id
    ) WHERE rn <= ? ORDER BY device_id, rn`).all(win);
    const perDevice = {};
    for (const r of rows) {
      if (!r.device_id) continue;
      const s = perDevice[r.device_id] ??= { ...emptyDeviceJobStatus(true), window: win, _streakOpen: true };
      const summary = jobRowToSummary(r, byAlias);
      if (!s.latestJob) s.latestJob = summary;
      if (JOB_SUCCESS_STATUSES.has(r.status)) {
        if (!s.lastSuccess) s.lastSuccess = summary;
        if (s._streakOpen) s.consecutiveSuccesses += 1;
      } else if (JOB_FAILURE_STATUSES.has(r.status)) {
        if (!s.lastFailure) s.lastFailure = summary;
        s._streakOpen = false;
      }
      // 其余状态（活跃中、cancelled/denied 等中性态）不计入 streak 也不作为成败取样
    }
    const jobTs = (job) => {
      const t = Date.parse(job.finishedAt || job.updatedAt || job.createdAt || "");
      return Number.isFinite(t) ? t : 0;
    };
    for (const s of Object.values(perDevice)) {
      // 时间相等按未解决处理（悲观），失败不会被同刻成功悄悄掩盖
      s.unresolvedFailure = s.lastFailure && (!s.lastSuccess || jobTs(s.lastFailure) >= jobTs(s.lastSuccess))
        ? s.lastFailure : null;
      delete s._streakOpen;
    }
    return { ok: true, window: win, perDevice };
  }, { ok: false, error: "control.db 暂不可读", window: win, perDevice: {} });
}

// ---------- 能力库（P1）----------
// 控制面 /control/v1/capabilities 不返回 externalEffect/approvalRequired，registry 按控制面
// policy.mjs 同款规则本地推导，避免 save_draft_dry_run 这类「标 automatic 实则需审批」误导 agent。
const EXTERNAL_RISK = new Set(["R2", "R3"]);
const EXTERNAL_IDEMPOTENCY = new Set(["external_effect", "ambiguous_on_timeout"]);
const LOW_MATURITY = new Set(["E0", "E1"]);

function derivePolicy(capability) {
  const mode = capability.automationPolicy?.mode ?? null;
  const canaryOnlyFlag = capability.automationPolicy?.canaryOnly === true;
  const availability = capability.availability ?? "implemented";
  const externalEffect = EXTERNAL_RISK.has(capability.risk) || EXTERNAL_IDEMPOTENCY.has(capability.idempotency);
  const approvalRequired = externalEffect || mode === "approval_required" || availability === "approval_gated";
  const canaryRequired = LOW_MATURITY.has(capability.maturity) || canaryOnlyFlag || availability === "canary_only";
  const labOnly = mode === "lab_only";
  const disabled = mode === "disabled";
  const available = availability === "implemented";
  // autonomous = 无需人工审批（审批维度）；但未必能直接 job 自跑——见 runnableAsJob
  const autonomous = !approvalRequired && !labOnly && !disabled;
  // runnableAsJob = 可直接 devicectl job submit 自跑（已实现 + 免审批 + 非 lab + 非 disabled + 非 canary-only）
  const runnableAsJob = available && !approvalRequired && !labOnly && !disabled && !canaryRequired;
  // runnableAsCanarySession = 需要 canary session 才能跑（低成熟度 / canary_only availability）
  const runnableAsCanarySession = (available || availability === "canary_only") && !approvalRequired && !labOnly && !disabled && canaryRequired;
  return {
    mode,
    availability,
    externalEffect,
    approvalRequired,
    canaryRequired,
    labOnly,
    disabled,
    autonomous,
    runnableAsJob,
    runnableAsCanarySession,
  };
}

// 启动/请求期不变量检查：策略字面值与实际推导不一致时亮红灯（控制塔与 API 都显示）
function capabilityLint(capability, policy) {
  const warnings = [];
  if (policy.mode === "automatic" && policy.approvalRequired) {
    warnings.push(`automationPolicy.mode=automatic 但 idempotency=${capability.idempotency}/risk=${capability.risk} 推导出需人工审批——字面值有误导性`);
  }
  if (policy.externalEffect && capability.restoration?.required === false) {
    warnings.push("有外部效应且不要求 restoration——副作用不会被自动回收");
  }
  if (policy.canaryRequired && policy.mode === "automatic") {
    warnings.push(`maturity=${capability.maturity} 需 canary session，automatic 模式下 job 直提会被拒`);
  }
  if (policy.autonomous && !policy.runnableAsJob) {
    warnings.push(`autonomous=true 但 availability=${policy.availability} 实际不可直接 job 自跑——task-packet 不会生成 job 骨架`);
  }
  return warnings;
}

function summarizeCapability(capability, routingByCapability) {
  const policy = derivePolicy(capability);
  return {
    id: capability.id,
    appId: capability.appId ?? null,
    risk: capability.risk ?? null,
    maturity: capability.maturity ?? null,
    idempotency: capability.idempotency ?? null,
    timeoutMs: capability.timeoutMs ?? null,
    resources: capability.resources ?? [],
    restorationRequired: capability.restoration?.required ?? null,
    verificationMode: capability.verification?.mode ?? null,
    policy,
    lint: capabilityLint(capability, policy),
    eligibleAliases: routingByCapability.get(capability.id) ?? [],
  };
}

function routingMatrix() {
  return queryControlDb((cdb) => {
    const rows = cdb.prepare("SELECT alias, routing_json FROM devices WHERE alias IS NOT NULL ORDER BY alias").all();
    const byAlias = {};
    const byCapability = new Map();
    for (const r of rows) {
      let routing = {};
      try { routing = JSON.parse(r.routing_json || "{}"); } catch { /* keep {} */ }
      const ids = Array.isArray(routing.capabilityIds) ? routing.capabilityIds : [];
      byAlias[r.alias] = { enabled: routing.enabled !== false, tags: routing.tags ?? [], capabilityIds: ids };
      // 只有 routing.enabled !== false 的设备才计入 byCapability——placement 明确拒绝 disabled profile，
      // 把它标 eligible 会误导 agent 提交后被控制面拒。
      if (routing.enabled !== false) {
        for (const id of ids) {
          if (!byCapability.has(id)) byCapability.set(id, []);
          byCapability.get(id).push(r.alias);
        }
      }
    }
    return { ok: true, byAlias, byCapability };
  }, { ok: false, error: "control.db 暂不可读", byAlias: {}, byCapability: new Map() });
}

async function buildCapabilityCatalog() {
  const matrix = routingMatrix();
  let capabilities = [];
  let error = null;
  try {
    const data = await fetchJson(`${CONTROL}/control/v1/capabilities`);
    capabilities = Array.isArray(data?.capabilities) ? data.capabilities : [];
  } catch (e) {
    error = String(e.message || e);
  }
  const items = capabilities.map((c) => summarizeCapability(c, matrix.byCapability)).sort((a, b) => a.id.localeCompare(b.id));
  return {
    ok: !error,
    error,
    generatedAt: new Date().toISOString(),
    count: items.length,
    routingSourceOk: matrix.ok,
    capabilities: items,
    routingByAlias: matrix.byAlias,
    lintWarnings: items.flatMap((item) => item.lint.map((w) => ({ capabilityId: item.id, warning: w }))),
  };
}

// ---------- 任务包（P1，只推荐不代提交）----------
const TASK_KEYWORDS = [
  { match: /闲鱼|xianyu|上架|发布商品|草稿/i, appId: "xianyu" },
  { match: /小红书|xhs|评论|笔记/i, appId: "xhs" },
  { match: /微信|wechat|客服|会话/i, appId: "wechat" },
  { match: /设备|device|网关|小薇|xiaowei/i, appId: "xiaowei" },
];
const INTENT_KEYWORDS = [
  { match: /只读|观察|快照|observe|snapshot|巡检/i, prefer: /observe/ },
  { match: /图片|image|相册/i, prefer: /image/ },
  { match: /输入|文案|描述|text/i, prefer: /input/ },
  { match: /全链|完整|full|标准链|发布|发商品|上架|不保存|no.?save/i, prefer: /full_dry_run$/ },
  { match: /打开|进入|open/i, prefer: /open/ },
  { match: /草稿|保存草稿|save.?draft/i, prefer: /save_draft/ },
];

function buildTaskPacket(taskText, catalog, entry) {
  const text = String(taskText || "");
  const app = TASK_KEYWORDS.find((k) => k.match.test(text))?.appId ?? null;
  const intent = INTENT_KEYWORDS.filter((k) => k.match.test(text)).map((k) => k.prefer);
  const pool = catalog.capabilities.filter((c) => (app ? c.appId === app : true));
  const readyAliases = new Set(entry.devices.filter((d) => d.state.ready).map((d) => d.alias));
  // 只推荐被路由到至少一台设备的能力（无路由=placement 会拒，推荐了也跑不了）。
  // 无意图匹配时不按基础分瞎猜——返回空推荐 + 提示，避免误导（如把 open_dry_run 排在 save_draft 前）。
  const routed = pool.filter((c) => c.eligibleAliases.length);
  let recommendations = [];
  if (intent.length) {
    const scored = routed.map((c) => {
      let score = 0;
      for (const rx of intent) if (rx.test(c.id)) score += 3;
      if (c.policy.runnableAsJob) score += 2;       // 可直接 job 自跑优先
      if (c.risk === "R0") score += 1;
      return { c, score };
    }).sort((a, b) => b.score - a.score || a.c.id.localeCompare(b.c.id));
    recommendations = scored.slice(0, 3).map(({ c, score }) => {
      const eligible = c.eligibleAliases.map((alias) => ({
        alias,
        routed: true,
        ready: readyAliases.has(alias),
        reason: readyAliases.has(alias) ? "ready" : "not ready（离线/隔离/占用/有未解决失败，见 devices[].state）",
      }));
      const why = [
        app ? `App 匹配 ${app}` : "未指定 App",
        c.policy.runnableAsJob ? "可直接 job 自跑（已实现+免审批+非 canary）" : c.policy.runnableAsCanarySession ? "需 canary session（低成熟度/canary_only）" : c.policy.approvalRequired ? "需人工审批（human token）" : `availability=${c.policy.availability}，暂不可跑`,
        `路由允许：${c.eligibleAliases.join("/")}`,
      ];
      // 只对 runnableAsJob 生成 job submit 骨架；canary session 给 canary 提示；其余不给骨架（避免误导提交后被拒）
      let submitSkeleton = null;
      let submitNote = null;
      if (c.policy.runnableAsJob) {
        submitSkeleton = `node control-plane/devicectl.mjs --ssh xhs-windows job submit --actor <actor> --capability ${c.id} --device <deviceId 见 /api/devices> --idempotency-key <唯一键> --params '<json>'`;
      } else if (c.policy.runnableAsCanarySession) {
        submitNote = "需先建立 canary session 再提交（见控制面 canary 文档），不可直接 job submit";
      } else {
        submitNote = `不可直接提交：${c.policy.approvalRequired ? "需人工审批" : c.policy.labOnly ? "lab_only" : c.policy.disabled ? "disabled" : `availability=${c.policy.availability}`}`;
      }
      return {
        capabilityId: c.id,
        score,
        why,
        policy: c.policy,
        lint: c.lint,
        timeoutMs: c.timeoutMs,
        restorationRequired: c.restorationRequired,
        eligibleDevices: eligible,
        submitSkeleton,
        submitNote,
      };
    });
  }
  const noIntentNote = intent.length ? null : "未匹配到明确意图关键词（observe/image/input/full/open/save_draft 等），请细化任务描述；不按基础分瞎猜推荐。";
  const knowledge = listKnowledge({ app: app || undefined, limit: 8 }).map((item) => ({
    id: item.id, title: item.title, category: item.category, lifecycle: item.lifecycle, verifyMode: item.verifyMode,
  }));
  return {
    ok: true,
    task: text,
    inferredApp: app,
    recommendations,
    acceptance: [
      "job 终态 succeeded 且 result.verification.ok !== false",
      "restoration.required 的能力还需 result.restoration.ok !== false",
      "收尾 leases=[]、pending=[]、本机 quarantined=false",
    ],
    stopConditions: [
      "waiting_approval 出现在标称免审批能力上 → 停，系统异常",
      "recovery_required → 设备已隔离，只允许 main-safe 零动作恢复，其余保持隔离报告",
      "验证码/风控/登录墙/未知页面 → 立即停",
    ],
    knowledge,
    protocol: ENTRY_PROTOCOL,
    noIntentNote,
    note: "本接口只推荐与解释，不代提交任何 job。",
  };
}

async function proxyApprovalDecision(jobId, decision, actor, reason) {
  let res;
  try {
    res = await fetch(`${CONTROL}/control/v1/approvals/${encodeURIComponent(jobId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision, actorId: actor, reason: reason ?? null }),
      signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS + 2000),
    });
  } catch (e) {
    return { status: 502, data: { ok: false, error: `控制面不可达: ${e.message}` } };
  }
  let data = {};
  try { data = await res.json(); } catch { /* keep {} */ }
  return { status: res.status, data };
}

// 审批审计：registry 侧独立留痕（控制面自己也落库，这里记「谁经由 registry 按了钮」）。
// 审计写失败绝不影响审批请求本身。
function recordApprovalAudit({ jobId, decision, actor, actorSource, reason, channel, remoteAddr, proxiedStatus, proxiedOk }) {
  try {
    db.prepare(`INSERT INTO approval_audit (job_id, decision, actor, actor_source, reason, channel, remote_addr, proxied_status, proxied_ok, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      String(jobId), String(decision), String(actor), String(actorSource), reason ?? null,
      String(channel), remoteAddr ?? null, proxiedStatus ?? null, proxiedOk ? 1 : 0, new Date().toISOString());
  } catch (e) {
    console.log(`[registry] approval audit write failed: ${e.message}`);
  }
}

function listApprovalAudit(limit = 50) {
  const rows = db.prepare("SELECT * FROM approval_audit ORDER BY id DESC LIMIT ?")
    .all(Math.max(1, Math.min(200, Number(limit) || 50)));
  return rows.map((r) => ({
    id: r.id,
    jobId: r.job_id,
    decision: r.decision,
    actor: r.actor,
    actorSource: r.actor_source,
    reason: r.reason,
    channel: r.channel,
    remoteAddr: r.remote_addr,
    proxiedStatus: r.proxied_status,
    proxiedOk: Boolean(r.proxied_ok),
    createdAt: r.created_at,
  }));
}

const ENTRY_PROTOCOL = {
  questions: [
    "本次使用 job 还是 session？",
    "我的 lease 是否能在 GET /control/v1/leases 或面板看见？",
    "本次 capability id 是什么？",
  ],
  cwd: "/Volumes/GPFS/Users/a1234/Desktop/Coding/xhs-device-agent-routing-v1-1（Mac 上运行；devicectl 自带 --ssh，不要手写 ssh 包裹）",
  entrypoints: {
    routePlan: "node control-plane/devicectl.mjs --ssh xhs-windows route plan --actor <actor> --capability <id>",
    job: "node control-plane/devicectl.mjs --ssh xhs-windows job submit --capability <id> --actor <actor> --idempotency-key <key> --params '<json>'",
    jobStatus: "node control-plane/devicectl.mjs --ssh xhs-windows job status --job <jobId>",
    session: "node control-plane/devicectl.mjs --ssh xhs-windows session acquire --actor <actor> --capability <id> --alias <01-04>",
  },
  redLines: [
    "禁止无 lease 调 GatewayOperator、临时脚本或旧 runner 碰手机",
    "禁止直写 control.db、直接清隔离或调用内部 approve 路径",
    "R2/R3 只提交，批准或拒绝只能由人完成",
    "验证码、风控、登录墙或未知页面立即停止",
    "小薇 ADB 使用端口 5038，不是默认 5037",
  ],
};

function blockerOverview() {
  const items = listKnowledge().filter((item) => item.lifecycle && KNOW_LIFECYCLES.has(item.lifecycle));
  const group = (status) => items.filter((item) => item.lifecycle === status).map((item) => ({
    id: item.id,
    app: item.app,
    title: item.title,
    lifecycle: item.lifecycle,
    needsEngineer: item.needsEngineer,
    updatedAt: item.updatedAt,
    resolvedAt: item.resolvedAt,
    resolution: item.resolution,
  }));
  return {
    active: group("active_blocker"),
    backlog: group("backlog"),
    resolved: group("resolved"),
    unknown: group("probe_unknown"),
  };
}

async function buildAgentEntry() {
  const devices = await aggregate();
  const jobs = listJobOverview(20);
  const deviceJobs = listDeviceJobStatus();
  const pending = listPendingApprovals();
  const recentApprovals = listRecentApprovals(10);
  const knowledge = listKnowledge({ limit: 12 }).map((item) => ({
    id: item.id,
    app: item.app,
    category: item.category,
    title: item.title,
    lifecycle: item.lifecycle,
    needsEngineer: item.needsEngineer,
    updatedAt: item.updatedAt,
  }));
  const controlDbOk = Boolean(jobs.ok && deviceJobs.ok && pending.ok && recentApprovals.ok);
  return {
    ok: true,
    schemaVersion: "xhs.agent-entry.v2",
    generatedAt: new Date().toISOString(),
    sources: {
      controlPlane: {
        reachable: Boolean(devices.controlPlane.reachable),
        stale: !devices.controlPlane.reachable,
        error: devices.controlPlane.reachable ? null : "control plane unavailable",
      },
      controlDb: {
        reachable: controlDbOk,
        stale: !controlDbOk,
        error: controlDbOk ? null : "control.db temporarily unreadable",
      },
      identityCache: {
        reachable: true,
        stale: devices.identitySync.stale,
        error: null,
        lastAt: devices.identitySync.lastAt,
        ageSeconds: devices.identitySync.ageSeconds,
        staleAfterSeconds: devices.identitySync.staleAfterSeconds,
      },
    },
    controlPlane: {
      reachable: Boolean(devices.controlPlane.reachable),
      nodeId: devices.controlPlane.nodeId ?? null,
      activeLeases: devices.controlPlane.activeLeases ?? null,
    },
    devices: devices.devices.map((device) => {
      const control = device.control;
      const deviceId = control?.deviceId ?? null;
      const jobStatus = deviceId && deviceJobs.perDevice[deviceId]
        ? { ...deviceJobs.perDevice[deviceId], sourceOk: deviceJobs.ok }
        : emptyDeviceJobStatus(deviceJobs.ok);
      const online = control ? Boolean(control.online) : null;
      const quarantined = control ? Boolean(control.quarantined) : null;
      const leaseFree = control ? !control.lease : null;
      const hasUnresolvedFailure = deviceJobs.ok ? Boolean(jobStatus.unresolvedFailure) : null;
      // ready 只在全部输入已知时给结论，任一输入未知则 null——绝不假阳性
      const readyInputs = [online, quarantined, leaseFree, hasUnresolvedFailure];
      const ready = readyInputs.some((v) => v === null)
        ? null
        : online && !quarantined && leaseFree && !hasUnresolvedFailure;
      return {
        alias: device.alias,
        serial: device.serial,
        label: device.label,
        model: device.model,
        identityKnown: device.identityKnown,
        identityStale: device.identityStale,
        control,
        state: { online, quarantined, leaseFree, identityKnown: device.identityKnown, identityStale: device.identityStale, hasUnresolvedFailure, ready },
        jobStatus,
        activeJobs: deviceId ? jobs.active.filter((job) => job.deviceId === deviceId) : [],
        // 废弃别名：v1 里是「全局失败列表里该设备最后一条」，v2 起改为 unresolvedFailure 语义
        recentFailure: jobStatus.unresolvedFailure,
      };
    }),
    jobs,
    approvals: {
      sourceOk: pending.ok,
      pendingCount: pending.pending.length,
      recent: recentApprovals.ok ? recentApprovals.recent.map((item) => ({
        jobId: item.jobId,
        decision: item.decision,
        capabilityId: item.capability?.id ?? null,
        alias: item.alias,
        decidedAt: item.decidedAt,
      })) : [],
    },
    blockers: blockerOverview(),
    knowledge,
    protocol: ENTRY_PROTOCOL,
  };
}

function renderAgentEntryMarkdown(entry) {
  const yn = (v) => (v === null || v === undefined ? "unknown" : v ? "yes" : "no");
  const identityCache = entry.sources.identityCache;
  const lines = [
    "# XHS Agent Entry",
    "",
    `- generatedAt: ${entry.generatedAt}`,
    `- controlPlane: ${entry.controlPlane.reachable ? "reachable" : "unreachable"}`,
    `- identityCache: ${identityCache.stale ? "stale" : "fresh"} (age ${identityCache.ageSeconds ?? "?"}s / ttl ${identityCache.staleAfterSeconds}s)`,
    `- activeLeases: ${entry.controlPlane.activeLeases ?? "unknown"}`,
    `- runningJobs: ${entry.jobs.active.length}`,
    `- pendingApprovals: ${entry.approvals.pendingCount}`,
    "",
    "## Current active blockers",
    "",
    ...(entry.blockers.active.length
      ? entry.blockers.active.map((item) => `- [${item.app || "infra"}] ${item.title} (${item.id})`)
      : ["- none"]),
    "",
    "## Device occupancy",
    "",
    ...entry.devices.map((device) => {
      const control = device.control;
      const lease = control?.lease ? `${control.lease.holderId} / ${control.lease.kind}` : "free";
      const jobs = device.activeJobs.length ? device.activeJobs.map((job) => `${job.status}:${job.capabilityId}`).join(", ") : "none";
      const quarantine = control?.quarantined ? `yes (${control.quarantineReason || "unknown"})` : "no";
      const failure = device.jobStatus.unresolvedFailure
        ? `${device.jobStatus.unresolvedFailure.errorCode || device.jobStatus.unresolvedFailure.status}@${device.jobStatus.unresolvedFailure.finishedAt || device.jobStatus.unresolvedFailure.updatedAt || "?"}`
        : device.jobStatus.sourceOk ? "none" : "unknown";
      return `- ${device.alias} | online=${yn(device.state.online)} | ready=${yn(device.state.ready)} | serial=${device.serial || "unknown"} | lease=${lease} | jobs=${jobs} | quarantined=${quarantine} | streak=${device.jobStatus.consecutiveSuccesses} | unresolvedFailure=${failure}`;
    }),
    "",
    "registry 观测不到的维度（不要臆断）：PnP 物理在位、App 登录态、电量/网络。",
    "",
    "## Entry questions",
    "",
    ...entry.protocol.questions.map((item, index) => `${index + 1}. ${item}`),
    "",
    "## Approved command skeletons",
    "",
    `- cwd: ${entry.protocol.cwd}`,
    ...Object.entries(entry.protocol.entrypoints).map(([name, cmd]) => `- ${name}: \`${cmd}\``),
    "",
    "## Red lines",
    "",
    ...entry.protocol.redLines.map((item) => `- ${item}`),
    "",
  ];
  return lines.join("\n");
}

// ---------- 页面 ----------
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}


function formatTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("zh-CN", { hour12: false });
}

function renderControlTower(entry, { csrfToken = "", pendingApprovals = [], notice = null } = {}) {
  const noticeText = {
    approved: "审批已提交，控制面已接收批准决定。",
    denied: "拒绝决定已提交，任务不会执行。",
    failed: "审批操作失败，任务状态未被页面更改。",
  }[notice] || null;
  const sourceState = entry.sources.controlPlane.reachable ? "ONLINE" : "DEGRADED";
  const deviceCards = entry.devices.map((device) => {
    const control = device.control;
    const quarantined = Boolean(control?.quarantined);
    const stateClass = quarantined ? "state-warn" : control?.online ? "state-ok" : "state-off";
    const stateText = quarantined ? "QUARANTINED" : control?.online ? "ONLINE" : "OFFLINE";
    const lease = control?.lease;
    const jobs = device.activeJobs.length
      ? device.activeJobs.map((job) => `<div class="jobline"><b>${esc(job.status)}</b> ${esc(job.capabilityId)}<small>${esc(job.actorId)}</small></div>`).join("")
      : '<div class="empty">无在跑 job</div>';
    const unresolved = device.jobStatus?.unresolvedFailure ?? null;
    const failure = unresolved
      ? `<div class="fault"><span>${esc(unresolved.errorCode || unresolved.status)}</span><time>${esc(formatTime(unresolved.finishedAt || unresolved.updatedAt))}</time></div>`
      : device.jobStatus?.sourceOk === false
        ? '<div class="empty">control.db 不可读</div>'
        : '<div class="empty">无未解决失败</div>';
    const lastSuccess = device.jobStatus?.lastSuccess
      ? `<div class="jobline"><b>LAST SUCCESS</b> ${esc(formatTime(device.jobStatus.lastSuccess.finishedAt || device.jobStatus.lastSuccess.updatedAt))}<small>STREAK ${Number(device.jobStatus.consecutiveSuccesses) || 0}</small></div>`
      : "";
    return `<article class="device-card ${stateClass}"><header><div><span class="slot">${esc(device.alias)}</span><h3>${esc(device.label || "未命名设备")}</h3></div><span class="state">${stateText}</span></header>
      <dl><div><dt>SERIAL</dt><dd>${esc(device.serial || "unknown")}</dd></div><div><dt>MODEL</dt><dd>${esc(device.model || "unknown")}</dd></div>
      <div><dt>LEASE</dt><dd>${lease ? `${esc(lease.holderId)} / ${esc(lease.kind || "unknown")}` : "FREE"}</dd></div><div><dt>QUARANTINE</dt><dd>${quarantined ? esc(control.quarantineReason || "unknown") : "NO"}</dd></div></dl>
      <section><h4>ACTIVE JOBS</h4>${jobs}</section><section><h4>UNRESOLVED FAILURE</h4>${failure}${lastSuccess}</section></article>`;
  }).join("");
  const blockers = entry.blockers.active.length
    ? entry.blockers.active.map((item) => `<article class="blocker"><span>ACTIVE BLOCKER</span><h2>${esc(item.title)}</h2><p>${esc(item.id)}</p><time>${esc(formatTime(item.updatedAt))}</time></article>`).join("")
    : '<article class="blocker clear"><span>ACTIVE BLOCKER</span><h2>当前无硬卡点</h2><p>继续按控制面入口和 lease 纪律工作</p></article>';
  const recentJobs = entry.jobs.recent.slice(0, 10).map((job) => {
    const tone = ["failed", "ambiguous", "recovery_required"].includes(job.status) ? "bad" : job.status === "succeeded" ? "good" : "live";
    return `<li><span class="event-dot event-${tone}"></span><div><b>${esc(job.capabilityId)}</b><small>${esc(job.alias || "?")} · ${esc(job.actorId)} · ${esc(job.status)}</small></div><time>${esc(formatTime(job.updatedAt))}</time></li>`;
  }).join("") || '<li class="empty">暂无 job 记录</li>';
  const recentKnowledge = entry.knowledge.slice(0, 8).map((item) => `<li><span class="event-dot event-note"></span><div><b>${esc(item.title)}</b><small>${esc(item.app || "infra")} · ${esc(item.category)}${item.lifecycle ? ` · ${esc(item.lifecycle)}` : ""}</small></div><time>${esc(formatTime(item.updatedAt))}</time></li>`).join("") || '<li class="empty">暂无知识条目</li>';
  const approvalCards = pendingApprovals.length ? pendingApprovals.map((approval) => {
    const capability = approval.capability || {};
    return `<article class="approval-card"><div class="approval-head"><span>${esc(capability.risk || "R?")}</span><h3>${esc(capability.id || "unknown capability")}</h3></div><p>${esc(approval.alias || "?")} · ${esc(approval.actorId || "unknown")} · ${esc(approval.jobId)}</p>
      <div class="approval-actions"><form method="post" action="/ui/approvals/${encodeURIComponent(approval.jobId)}/approve"><input type="hidden" name="csrf" value="${esc(csrfToken)}"><input name="reason" placeholder="批准理由（可选）" aria-label="批准理由"><input name="confirmation" required pattern="APPROVE" placeholder="输入 APPROVE" aria-label="确认批准"><button class="approve" type="submit">批准并执行</button></form>
      <form method="post" action="/ui/approvals/${encodeURIComponent(approval.jobId)}/deny"><input type="hidden" name="csrf" value="${esc(csrfToken)}"><input name="reason" placeholder="拒绝理由（可选）" aria-label="拒绝理由"><button class="deny" type="submit">拒绝任务</button></form></div></article>`;
  }).join("") : '<div class="empty-panel">当前没有待人工审批任务</div>';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>XHS Agent Control Tower</title><style>
:root{--ink:#15191c;--paper:#f0efe9;--panel:#fbfaf5;--line:#c7c3b8;--muted:#6f756f;--green:#0b7a53;--amber:#d47b12;--red:#b7372d;--blue:#1e5f86;--shadow:0 12px 30px rgba(30,38,38,.08)}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font-family:"Avenir Next Condensed","DIN Alternate","PingFang SC",sans-serif;background-image:linear-gradient(rgba(21,25,28,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(21,25,28,.035) 1px,transparent 1px);background-size:24px 24px}a{color:inherit}.shell{max-width:1480px;margin:auto;padding:24px}.topbar{display:grid;grid-template-columns:1fr auto;align-items:end;border-bottom:3px solid var(--ink);padding-bottom:16px}.eyebrow,.section-kicker{font:700 11px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.18em;color:var(--muted)}h1{font-size:clamp(34px,6vw,72px);line-height:.85;letter-spacing:-.055em;margin:6px 0 0;text-transform:uppercase}.topnav{display:flex;gap:8px;flex-wrap:wrap}.topnav a{font:700 12px ui-monospace,SFMono-Regular,Menlo,monospace;text-decoration:none;border:1px solid var(--ink);padding:9px 12px;background:var(--panel)}
.status-strip{display:grid;grid-template-columns:repeat(5,1fr);gap:1px;background:var(--ink);border:1px solid var(--ink);margin:18px 0}.metric{background:var(--panel);padding:14px}.metric b{display:block;font-size:25px}.metric small{font:10px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted);letter-spacing:.12em}.metric.primary{background:var(--ink);color:white}.metric.primary small{color:#b9c0bd}.notice{border-left:6px solid var(--blue);padding:12px 16px;background:#e7f1f5;margin:14px 0}.blockers{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px;margin:18px 0 26px}.blocker{background:#261b18;color:#fff;padding:22px;border-top:7px solid var(--red);box-shadow:var(--shadow)}.blocker span{font:700 10px ui-monospace,monospace;letter-spacing:.16em;color:#f0a69f}.blocker h2{margin:8px 0 5px;font-size:24px}.blocker p,.blocker time{font:11px ui-monospace,monospace;color:#c7bbb8}.blocker.clear{background:#17342a;border-color:var(--green)}
.section-head{display:flex;justify-content:space-between;align-items:end;margin:28px 0 12px}.section-head h2{font-size:26px;margin:4px 0 0}.section-head p{margin:0;color:var(--muted);font-size:12px}.device-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(270px,1fr));gap:12px}.device-card{background:var(--panel);border:1px solid var(--line);border-top:7px solid var(--muted);padding:16px;box-shadow:var(--shadow)}.device-card.state-ok{border-top-color:var(--green)}.device-card.state-warn{border-top-color:var(--amber)}.device-card header{display:flex;justify-content:space-between;align-items:start}.device-card header>div{display:flex;gap:10px;align-items:center}.slot{display:grid;place-items:center;width:42px;height:42px;background:var(--ink);color:white;font:bold 16px ui-monospace,monospace}.device-card h3{font-size:19px;margin:0}.state{font:700 9px ui-monospace,monospace;letter-spacing:.1em;border:1px solid currentColor;padding:4px 6px}.device-card dl{display:grid;grid-template-columns:1fr 1fr;border-top:1px solid var(--line);border-left:1px solid var(--line);margin:16px 0}.device-card dl div{padding:8px;border-right:1px solid var(--line);border-bottom:1px solid var(--line);min-width:0}.device-card dt,.device-card h4{font:700 9px ui-monospace,monospace;letter-spacing:.12em;color:var(--muted)}.device-card dd{margin:3px 0 0;font:12px ui-monospace,monospace;overflow-wrap:anywhere}.device-card section{border-top:1px solid var(--line);padding-top:10px;margin-top:10px}.jobline{font:12px ui-monospace,monospace;padding:5px 0}.jobline small{display:block;color:var(--muted)}.fault{display:flex;justify-content:space-between;font:11px ui-monospace,monospace;color:var(--red)}.empty{color:var(--muted);font-size:12px}
.split{display:grid;grid-template-columns:1fr 1fr;gap:14px}.timeline{list-style:none;margin:0;padding:0;background:var(--panel);border:1px solid var(--line)}.timeline li{display:grid;grid-template-columns:12px 1fr auto;gap:10px;padding:12px;border-bottom:1px solid var(--line);align-items:center}.timeline li:last-child{border:0}.timeline b,.timeline small{display:block}.timeline b{font-size:13px}.timeline small,.timeline time{font:10px ui-monospace,monospace;color:var(--muted)}.event-dot{width:9px;height:9px;border-radius:50%;background:var(--blue)}.event-good{background:var(--green)}.event-bad{background:var(--red)}.event-live{background:var(--amber)}.event-note{background:var(--blue)}.approval-warning{background:#fff1d8;border:1px solid #e2b667;padding:12px;margin-bottom:10px;font-size:13px}.approval-card{background:var(--panel);border:1px solid var(--line);padding:16px;margin-bottom:10px}.approval-head{display:flex;gap:10px;align-items:center}.approval-head span{background:var(--red);color:white;padding:5px 8px;font:bold 11px ui-monospace,monospace}.approval-head h3{margin:0}.approval-card p{font:11px ui-monospace,monospace;color:var(--muted);overflow-wrap:anywhere}.approval-actions{display:grid;grid-template-columns:1fr 1fr;gap:10px}.approval-actions form{display:grid;gap:7px}.approval-actions input{width:100%;border:1px solid var(--line);background:white;padding:9px;font:12px ui-monospace,monospace}.approval-actions button{border:0;color:white;padding:10px;font-weight:800;cursor:pointer}.approve{background:var(--green)}.deny{background:var(--red)}.empty-panel{padding:20px;background:var(--panel);border:1px dashed var(--line);color:var(--muted)}footer{border-top:3px solid var(--ink);margin-top:32px;padding:14px 0;font:10px ui-monospace,monospace;color:var(--muted)}@media(max-width:800px){.shell{padding:14px}.topbar{grid-template-columns:1fr}.topnav{margin-top:14px}.status-strip{grid-template-columns:1fr 1fr}.split,.approval-actions{grid-template-columns:1fr}.device-grid{grid-template-columns:1fr}h1{font-size:45px}}
</style></head><body><main class="shell"><header class="topbar"><div><div class="eyebrow">XHS MULTI-DEVICE OPERATIONS / REQUEST-TIME SNAPSHOT</div><h1>Agent<br>Control Tower</h1></div><nav class="topnav"><a href="/">刷新快照</a><a href="/agent-entry.md">Agent Entry</a><a href="/api/agent-entry">JSON</a><a href="/watchdog">Watchdog</a></nav></header>${noticeText ? `<div class="notice">${esc(noticeText)}</div>` : ""}
<section class="status-strip"><div class="metric primary"><small>CONTROL PLANE</small><b>${esc(sourceState)}</b></div><div class="metric"><small>ACTIVE LEASES</small><b>${esc(entry.controlPlane.activeLeases ?? "?")}</b></div><div class="metric"><small>ACTIVE JOBS</small><b>${entry.jobs.active.length}</b></div><div class="metric"><small>PENDING APPROVALS</small><b>${entry.approvals.pendingCount}</b></div><div class="metric"><small>SNAPSHOT</small><b>${esc(new Date(entry.generatedAt).toLocaleTimeString("zh-CN", { hour12: false }))}</b></div></section><section class="blockers">${blockers}</section>
<div class="section-head"><div><span class="section-kicker">DEVICE OCCUPANCY</span><h2>设备控制权与运行态</h2></div><p>lease 和 job 分别取证，不互相推断</p></div><section class="device-grid">${deviceCards}</section><div class="section-head"><div><span class="section-kicker">EVENT STREAM</span><h2>最近动态</h2></div><p>服务端生成 · 无 JavaScript</p></div><section class="split"><ol class="timeline">${recentJobs}</ol><ol class="timeline">${recentKnowledge}</ol></section>
<div class="section-head"><div><span class="section-kicker">HUMAN GATE</span><h2>待人工审批</h2></div><p>Agent 禁止调用 approve / deny</p></div><div class="approval-warning">批准会触发真实外部效果。只有人可以操作；批准前必须手工输入 APPROVE。</div>${approvalCards}<footer>SCHEMA ${esc(entry.schemaVersion)} · GENERATED ${esc(entry.generatedAt)} · CONTROL DB ${entry.sources.controlDb.reachable ? "READABLE" : "DEGRADED"}</footer></main></body></html>`;
}

function renderStatusPage(status, title, message) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>body{font-family:"Avenir Next Condensed","PingFang SC",sans-serif;background:#f0efe9;color:#15191c;margin:0;padding:32px}.box{max-width:680px;margin:auto;background:#fbfaf5;border-top:8px solid #b7372d;padding:24px}a{color:#1e5f86}</style></head><body><main class="box"><small>HTTP ${esc(status)}</small><h1>${esc(title)}</h1><p>${esc(message)}</p><a href="/">返回控制台</a></main></body></html>`;
}

// ---------- Auth ----------
function isLoopback(req) {
  const addr = req.socket?.remoteAddress || "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

function sign(value) {
  return createHmac("sha256", SESSION_SECRET).update(value).digest("base64url");
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

const SESSION_ROLES = new Set(["human", "agent"]);

function issueSession(role = "human") {
  const payload = `${role}.${Math.floor(Date.now() / 1000) + SESSION_TTL_S}.${randomBytes(18).toString("base64url")}`;
  return `${payload}.${sign(payload)}`;
}

// 返回 session 角色（"human"|"agent"）或 null
function validSession(value) {
  const parts = String(value || "").split(".");
  if (parts.length !== 4) return null;
  const [role, exp, rand, sig] = parts;
  if (!SESSION_ROLES.has(role)) return null;
  const payload = `${role}.${exp}.${rand}`;
  return Number(exp) > Math.floor(Date.now() / 1000) && safeEqual(sig, sign(payload)) ? role : null;
}

function csrfFor(sessionValue, req) {
  if (validSession(sessionValue)) return sign(`csrf:${sessionValue}`);
  // loopback 免 session 的 CSRF 兜底只在 LEGACY 模式保留；新模式审批必须有 human session
  if (LEGACY_AUTH && isLoopback(req)) return sign("csrf:trusted-loopback");
  return "";
}

function providedToken(req) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  return url.searchParams.get("token") || String(req.headers["x-registry-token"] || "");
}

// 请求角色："human" | "agent" | "loopback" | null（拒绝）
function resolveAuth(req) {
  if (!AGENT_TOKEN && !HUMAN_TOKEN) return "human"; // 无任何 token = 开放调试模式（与旧版一致）
  const provided = providedToken(req);
  if (HUMAN_TOKEN && provided && safeEqual(provided, HUMAN_TOKEN)) return "human";
  const sessionRole = validSession(parseCookies(req)[SESSION_COOKIE]);
  if (sessionRole) return sessionRole;
  if (AGENT_TOKEN && provided && safeEqual(provided, AGENT_TOKEN)) return LEGACY_AUTH ? "human" : "agent";
  if (TRUST_LOOPBACK && isLoopback(req)) return LEGACY_AUTH ? "human" : "loopback";
  return null;
}

// /?token= 换 session：只有能代表「人」的 token 才发 session（LEGACY 模式下旧 token 即人）
function queryTokenRole(req) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const q = url.searchParams.get("token");
  if (!q) return null;
  if (HUMAN_TOKEN && safeEqual(q, HUMAN_TOKEN)) return "human";
  if (LEGACY_AUTH && AGENT_TOKEN && safeEqual(q, AGENT_TOKEN)) return "human";
  return null;
}

// ---------- HTTP ----------
function sendJson(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), ...headers });
  res.end(body);
}

function sendText(res, status, body, contentType, headers = {}) {
  res.writeHead(status, { "content-type": contentType, "content-length": Buffer.byteLength(body), ...headers });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new Error("invalid JSON body"); }
}

async function readForm(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const params = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  return Object.fromEntries(params.entries());
}

// 进程级兜底：registry 是只读聚合服务，设计目标是降级不退出。
// 未捕获异常只记录不退出（node:sqlite 原生 abort 无法拦截，靠计划任务重启兜底）。
process.on("uncaughtException", (e) => console.log(`[registry] uncaughtException (kept alive): ${e.stack || e}`));
process.on("unhandledRejection", (e) => console.log(`[registry] unhandledRejection (kept alive): ${e?.stack || e}`));

const server = http.createServer(async (req, res) => {
  const role = resolveAuth(req);
  if (!role) {
    return sendJson(res, 401, { ok: false, error: "unauthorized: provide ?token= or x-registry-token header" });
  }
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    const mintRole = req.method === "GET" && url.pathname === "/" ? queryTokenRole(req) : null;
    if (mintRole) {
      const sessionValue = issueSession(mintRole);
      url.searchParams.delete("token");
      const location = `${url.pathname}${url.searchParams.size ? `?${url.searchParams}` : ""}`;
      res.writeHead(303, {
        location,
        "set-cookie": `${SESSION_COOKIE}=${encodeURIComponent(sessionValue)}; Max-Age=${SESSION_TTL_S}; Path=/; HttpOnly; SameSite=Strict`,
        "cache-control": "no-store",
      });
      return res.end();
    }
    if (req.method === "GET" && url.pathname === "/") {
      const entry = await buildAgentEntry();
      const pending = listPendingApprovals();
      const sessionValue = parseCookies(req)[SESSION_COOKIE] || "";
      const body = renderControlTower(entry, {
        csrfToken: csrfFor(sessionValue, req),
        pendingApprovals: pending.ok ? pending.pending : [],
        notice: url.searchParams.get("notice"),
      });
      return sendText(res, 200, body, "text/html; charset=utf-8", { "cache-control": "no-store" });
    }
    if (req.method === "GET" && url.pathname === "/api/health") {
      // 浅健康保持向后兼容（监控脚本在用）；?deep=1 给分层视图
      if (url.searchParams.get("deep") !== "1") {
        return sendJson(res, 200, { ok: true, port: PORT, identities: listIdentities().length, lastIdentitySync: metaGet("last_identity_sync") });
      }
      const entry = await buildAgentEntry();
      const degraded = [];
      if (!entry.sources.controlPlane.reachable) degraded.push("控制面不可达：设备/lease 视图为空，禁止据此判断设备空闲");
      if (!entry.sources.controlDb.reachable) degraded.push("control.db 不可读：job 状态/审批列表降级");
      if (entry.sources.identityCache.stale) degraded.push(`身份缓存过期（${entry.sources.identityCache.ageSeconds}s > ${entry.sources.identityCache.staleAfterSeconds}s）：飞书同步可能已停`);
      const fleetReady = entry.devices.filter((d) => d.state.ready === true);
      const catalog = await buildCapabilityCatalog();
      if (!catalog.ok) degraded.push(`能力清单不可读：${catalog.error}`);
      if (catalog.lintWarnings.length) degraded.push(`能力策略不变量告警 ${catalog.lintWarnings.length} 条（见 /api/capabilities）`);
      return sendJson(res, 200, {
        ok: true,
        liveness: { ok: true, port: PORT, uptimeSeconds: Math.round(process.uptime()) },
        readiness: {
          ok: entry.sources.controlPlane.reachable && entry.sources.controlDb.reachable && !entry.sources.identityCache.stale,
          controlPlane: entry.sources.controlPlane, controlDb: entry.sources.controlDb, identityCache: entry.sources.identityCache,
        },
        fleet: {
          ok: fleetReady.length > 0,
          readyCount: fleetReady.length, totalCount: entry.devices.length,
          ready: fleetReady.map((d) => d.alias),
          notReady: entry.devices.filter((d) => d.state.ready !== true).map((d) => ({
            alias: d.alias,
            reason: d.state.online === false ? "offline" : d.state.quarantined ? "quarantined"
              : d.state.leaseFree === false ? "leased" : d.state.hasUnresolvedFailure ? "unresolved-failure" : "unknown",
          })),
        },
        approvals: { ok: entry.approvals.sourceOk, pendingCount: entry.approvals.pendingCount, humanTokenEnforced: !LEGACY_AUTH },
        capabilities: { ok: catalog.ok, count: catalog.count, autonomousCount: catalog.capabilities.filter((c) => c.policy.autonomous).length, lintWarnings: catalog.lintWarnings },
        degraded,
      });
    }
    if (req.method === "GET" && url.pathname === "/api/capabilities") {
      const catalog = await buildCapabilityCatalog();
      const app = url.searchParams.get("app");
      const autonomousOnly = url.searchParams.get("autonomous") === "1";
      const alias = url.searchParams.get("alias");
      let items = catalog.capabilities;
      if (app) items = items.filter((c) => c.appId === app);
      if (autonomousOnly) items = items.filter((c) => c.policy.autonomous);
      if (alias) items = items.filter((c) => c.eligibleAliases.includes(alias));
      return sendJson(res, 200, { ...catalog, count: items.length, capabilities: items }, { "cache-control": "no-store" });
    }
    const capMatch = url.pathname.match(/^\/api\/capabilities\/([^/]+)$/);
    if (req.method === "GET" && capMatch) {
      const catalog = await buildCapabilityCatalog();
      const wanted = decodeURIComponent(capMatch[1]);
      const found = catalog.capabilities.find((c) => c.id === wanted);
      if (!found) return sendJson(res, 404, { ok: false, error: `capability not found: ${wanted}` });
      return sendJson(res, 200, { ok: true, capability: found, routingByAlias: catalog.routingByAlias });
    }
    if (req.method === "GET" && url.pathname === "/api/task-packet") {
      const task = url.searchParams.get("task") || "";
      if (!task) return sendJson(res, 400, { ok: false, error: "task query parameter is required, e.g. /api/task-packet?task=闲鱼三机no-save验证" });
      const [catalog, entry] = await Promise.all([buildCapabilityCatalog(), buildAgentEntry()]);
      return sendJson(res, 200, buildTaskPacket(task, catalog, entry), { "cache-control": "no-store" });
    }
    if (req.method === "GET" && url.pathname === "/watchdog") {
      const wdDir = path.join(__dirname, "watchdog");
      const statePath = path.join(wdDir, "state.json");
      let state = null;
      try { state = JSON.parse(fs.readFileSync(statePath, "utf8")); } catch { /* no state */ }
      const reportsDir = path.join(wdDir, "reports");
      let reports = [];
      try { reports = fs.readdirSync(reportsDir).filter(f => f.endsWith(".md")).sort().reverse().slice(0, 5); } catch { /* no reports */ }
      const latest = reports.length ? fs.readFileSync(path.join(reportsDir, reports[0]), "utf8") : "(无报告)";
      const body = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Watchdog</title>
<style>body{font-family:-apple-system,sans-serif;margin:16px;background:#f5f6f8;color:#222}pre{background:#fff;padding:12px;border-radius:8px;overflow-x:auto;font-size:13px}h1{font-size:18px}.meta{color:#888;font-size:12px}</style></head><body>
<h1>Watchdog 报告</h1>
<div class="meta">最后检查：${esc(state?.lastKimiRun ? new Date(state.lastKimiRun * 1000).toISOString() : '未知')} · 标记：${esc((state?.flags||[]).join(', ') || '无')}</div>
<h2 style="font-size:14px;margin-top:16px">最新报告 (${esc(reports[0]||'无')})</h2>
<pre>${esc(latest)}</pre>
${reports.length > 1 ? '<h2 style="font-size:14px;margin-top:16px">历史报告</h2><ul>' + reports.slice(1).map(r => '<li>'+esc(r)+'</li>').join('') + '</ul>' : ''}
<div class="meta" style="margin-top:16px"><a href="/">← 返回注册中心</a></div>
</body></html>`;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(body) });
      return res.end(body);
    }
    if (req.method === "GET" && url.pathname === "/api/devices") {
      return sendJson(res, 200, await aggregate());
    }
    if (req.method === "GET" && url.pathname === "/api/agent-entry") {
      return sendJson(res, 200, await buildAgentEntry(), { "cache-control": "no-store" });
    }
    if (req.method === "GET" && url.pathname === "/agent-entry.md") {
      const body = renderAgentEntryMarkdown(await buildAgentEntry());
      return sendText(res, 200, body, "text/markdown; charset=utf-8", { "cache-control": "no-store" });
    }
    if (req.method === "PUT" && url.pathname === "/api/identities") {
      const body = await readBody(req);
      if (!Array.isArray(body.identities)) return sendJson(res, 400, { ok: false, error: "identities must be an array" });
      replaceIdentities(body.identities);
      return sendJson(res, 200, { ok: true, count: body.identities.length, syncedAt: metaGet("last_identity_sync") });
    }
    if (req.method === "GET" && url.pathname === "/api/knowledge") {
      const items = listKnowledge({
        app: url.searchParams.get("app") || undefined,
        category: url.searchParams.get("category") || undefined,
        lifecycle: url.searchParams.get("lifecycle") || undefined,
        appliesTo: url.searchParams.get("appliesTo") || undefined,
        q: url.searchParams.get("q") || undefined,
        limit: url.searchParams.get("limit") || undefined,
      });
      const total = db.prepare("SELECT COUNT(*) AS c FROM knowledge").get().c;
      return sendJson(res, 200, { ok: true, count: items.length, total, knowledge: items });
    }
    if (req.method === "POST" && url.pathname === "/api/knowledge") {
      const body = await readBody(req);
      const created = addKnowledge(body);
      return sendJson(res, 201, { ok: true, knowledge: created });
    }
    let km = url.pathname.match(/^\/api\/knowledge\/([^/]+)\/verify$/);
    if (req.method === "POST" && km) {
      const body = await readBody(req);
      return sendJson(res, 200, { ok: true, knowledge: verifyKnowledge(decodeURIComponent(km[1]), body.by) });
    }
    km = url.pathname.match(/^\/api\/knowledge\/([^/]+)\/flag-engineer$/);
    if (req.method === "POST" && km) {
      const body = await readBody(req);
      return sendJson(res, 200, { ok: true, knowledge: flagEngineer(decodeURIComponent(km[1]), body.needs !== false) });
    }
    km = url.pathname.match(/^\/api\/knowledge\/([^/]+)$/);
    if (req.method === "GET" && km) {
      return sendJson(res, 200, { ok: true, knowledge: getKnowledge(decodeURIComponent(km[1])) });
    }
    if (req.method === "PATCH" && km) {
      const rawId = decodeURIComponent(km[1]);
      const body = await readBody(req);
      return sendJson(res, 200, { ok: true, knowledge: updateKnowledge(rawId, body) });
    }
    if (req.method === "GET" && url.pathname === "/api/approvals/pending") {
      return sendJson(res, 200, listPendingApprovals());
    }
    if (req.method === "GET" && url.pathname === "/api/approvals/recent") {
      return sendJson(res, 200, listRecentApprovals(url.searchParams.get("limit") || 20));
    }
    if (req.method === "GET" && url.pathname === "/api/approvals/audit") {
      return sendJson(res, 200, { ok: true, audit: listApprovalAudit(url.searchParams.get("limit") || 50) });
    }
    km = url.pathname.match(/^\/api\/approvals\/([^/]+)\/(approve|deny)$/);
    if (req.method === "POST" && km) {
      if (!LEGACY_AUTH && role !== "human") {
        return sendJson(res, 403, { ok: false, error: "approvals require the human token; agent/loopback credentials cannot approve or deny" });
      }
      const body = await readBody(req);
      if (!LEGACY_AUTH && km[2] === "approve" && body.confirm !== "APPROVE") {
        return sendJson(res, 400, { ok: false, error: 'approve requires body {"confirm":"APPROVE"}' });
      }
      // 新模式 actor 由凭证推导，body 自报无效；LEGACY 模式保持旧行为
      const actor = LEGACY_AUTH
        ? (typeof body.actor === "string" && body.actor.trim() ? body.actor.trim().slice(0, 60) : "human:registry-page")
        : `human:${HUMAN_ACTOR}`.slice(0, 60);
      const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 500) : null;
      const jobId = decodeURIComponent(km[1]);
      const proxied = await proxyApprovalDecision(jobId, km[2], actor, reason);
      recordApprovalAudit({
        jobId, decision: km[2], actor, reason, channel: "api",
        actorSource: LEGACY_AUTH ? "legacy-body" : "human-token",
        remoteAddr: req.socket?.remoteAddress || null,
        proxiedStatus: proxied.status, proxiedOk: proxied.status >= 200 && proxied.status < 300,
      });
      return sendJson(res, proxied.status, proxied.data);
    }
    km = url.pathname.match(/^\/ui\/approvals\/([^/]+)\/(approve|deny)$/);
    if (req.method === "POST" && km) {
      if (!LEGACY_AUTH && role !== "human") {
        return sendText(res, 403, renderStatusPage(403, "权限不足", "审批只能由持 human token 的人完成，agent/loopback 凭证无效。"), "text/html; charset=utf-8", { "cache-control": "no-store" });
      }
      const form = await readForm(req);
      const sessionValue = parseCookies(req)[SESSION_COOKIE] || "";
      const expectedCsrf = csrfFor(sessionValue, req);
      if (!expectedCsrf || !safeEqual(form.csrf || "", expectedCsrf)) {
        return sendText(res, 403, renderStatusPage(403, "CSRF 校验失败", "审批未提交，任务状态保持不变。"), "text/html; charset=utf-8", { "cache-control": "no-store" });
      }
      if (km[2] === "approve" && form.confirmation !== "APPROVE") {
        return sendText(res, 400, renderStatusPage(400, "批准确认不完整", "必须准确输入 APPROVE，审批未提交。"), "text/html; charset=utf-8", { "cache-control": "no-store" });
      }
      const actor = LEGACY_AUTH
        ? (typeof form.actor === "string" && form.actor.trim() ? form.actor.trim().slice(0, 60) : "human:registry-page")
        : `human:${HUMAN_ACTOR}`.slice(0, 60);
      const reason = typeof form.reason === "string" && form.reason.trim() ? form.reason.trim().slice(0, 500) : null;
      const jobId = decodeURIComponent(km[1]);
      const proxied = await proxyApprovalDecision(jobId, km[2], actor, reason);
      recordApprovalAudit({
        jobId, decision: km[2], actor, reason, channel: "ui",
        actorSource: LEGACY_AUTH ? "legacy-body" : "human-session",
        remoteAddr: req.socket?.remoteAddress || null,
        proxiedStatus: proxied.status, proxiedOk: proxied.status >= 200 && proxied.status < 300,
      });
      const notice = proxied.status >= 200 && proxied.status < 300 ? (km[2] === "approve" ? "approved" : "denied") : "failed";
      res.writeHead(303, { location: `/?notice=${notice}`, "cache-control": "no-store" });
      return res.end();
    }
    sendJson(res, 404, { ok: false, error: `${req.method} ${url.pathname} not found` });
  } catch (e) {
    sendJson(res, Number(e.status) || 500, { ok: false, error: String(e.message || e) });
  }
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    // 计划任务自动重启时旧进程可能还占着端口，等它释放而不是直接退出（退出会把任务的重启次数耗尽）
    console.log(`[registry] port ${PORT} busy, retry in 2s`);
    setTimeout(() => {
      try { server.listen(PORT, HOST); } catch { /* 下一次 error 事件会继续重试 */ }
    }, 2000);
    return;
  }
  console.log(`[registry] server error: ${e.message}`);
});

function listenServer() {
  server.listen(PORT, HOST, () => {
    console.log(`[registry] listening on http://${HOST}:${PORT} (control=${CONTROL}, db=${DB_PATH})`);
  });
}
listenServer();
