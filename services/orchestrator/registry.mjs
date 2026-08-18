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
import { createHash, createHmac, createPrivateKey, randomBytes, sign as cryptoSign, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureRecipeTables,
  ingestRecipeCandidate,
  recordAttempt,
  recordVerifiedAttempt,
  degradeRecipe,
  evaluatePromotion,
  listRecipes,
  getRecipe,
} from "./scripts/lib/recipe-catalog.mjs";
import {
  buildAttemptReceiptFromJob,
  fetchControlJob,
} from "./scripts/lib/recipe-attempt-receipt.mjs";
import {
  ensureStallTables,
  enqueueStall,
  buildL2DiagnosticPacket,
  buildL2ShadowDecision,
  claimNextStallItem,
  completeStallItem,
} from "./scripts/lib/stall-triage.mjs";
import { compileTaskPlan } from "./scripts/lib/task-plan.mjs";
import { loadFoundationCapabilities } from "./scripts/lib/foundation-capabilities.mjs";
import { loadWorkflows, summarizeWorkflow } from "./scripts/lib/workflow-catalog.mjs";

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
// REX Phase 6 P6-A: cross-repo release manifest 所在目录（control-plane-task.ps1 安装时在
// 同目录写 cross-repo-release.json）。Windows 上与 control-plane 同机；Mac 本地调试缺省走
// runtime/（通常不存在 → release 块降级 present=false，绝不 500）。
const CONTROL_PLANE_STATE_DIR = argOf("control-plane-state-dir",
  process.env.CONTROL_PLANE_STATE_DIR
  || (process.platform === "win32" ? "C:\\Users\\Public\\xhs-agent-control" : path.join(__dirname, "runtime")));
const TOKEN = argOf("token", "");
const AGENT_TOKEN = argOf("agent-token", TOKEN);
const HUMAN_TOKEN = argOf("human-token", "");
const HUMAN_ACTOR = argOf("human-actor", "console");
// 没有 human token = LEGACY 模式：单 token/loopback 管一切，行为与旧版一致（迁移期兼容）。
const LEGACY_AUTH = !HUMAN_TOKEN;
const IDENTITY_STALE_S = Math.max(60, Number(argOf("identity-stale-s", "900")) || 900);
const TRUST_LOOPBACK = argOf("trust-loopback", "true") !== "false";
// 只读观察者 / 受控代提交者凭证（abtop 远程通道）：observer 只读；operator 仅能调 /api/operator/*。
const OBSERVER_TOKEN = argOf("observer-token", "");
const OPERATOR_TOKEN = argOf("operator-token", "");
// REX Phase 2 收尾: 资金最终提交人类确认面。signer 私钥只能从受限文件读取，绝不来自
// argv 值/URL/日志/HTML/DB/仓库/fixture——argv 只接受文件路径。文件缺失或不可读 = signer
// unavailable：approve 必须明确 503，绝不退化成 unsigned approve；deny 仍可用。确认短语与
// 旧审批 APPROVE 区分，避免把非支付任务和资金最终提交混在一个按钮上。
const PAYMENT_SIGNER_KEYS_FILE = argOf("payment-signer-keys-file", "");
const PAYMENT_CONFIRM_PHRASE = argOf("payment-confirm-phrase", "APPROVE_PAYMENT");
// 角色 token 去重：鉴权按 human→agent→observer→operator 顺序匹配，任意两个非空角色 token
// 相同会让低权限凭证被解析成更高权限角色（如 observer==human 时 observer 命中 human）。
// 启动期即拒绝，避免静默提权。
{
  const _roleTokens = [AGENT_TOKEN, HUMAN_TOKEN, OBSERVER_TOKEN, OPERATOR_TOKEN].filter(Boolean);
  if (_roleTokens.length !== new Set(_roleTokens).size) {
    console.log("[registry] 拒绝启动：两个或多个非空角色 token 重复，会导致低权限凭证被解析成更高权限角色。请确保四个角色 token 互不相同。");
    process.exit(1);
  }
}
// 控制面已采集的 evidence 截图根目录（cache-only Screen API 读字节用，绝不触发设备）。
const RUNS_ROOT = argOf("runs-root", process.env.CONTROL_PLANE_RUNS_ROOT || "");
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

// ---------- Recipe Catalog tables (Phase 2/3 scaffolding; additive, idempotent) ----------
ensureRecipeTables(db);
ensureStallTables(db);

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
      // REX Phase 6 P6-A: 运行时策略/release 从 control-plane health 带出，供 agent-entry 显示。
      policyMode: health?.policyMode ?? null,
      releaseId: health?.releaseId ?? null,
      runtimePolicyVersion: health?.runtimePolicyVersion ?? null,
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

// ---------- 能力库（Foundation PR1）----------
// 停止本地推导 approvalRequired/autonomous/runnableAsJob 作为授权真源。
// 授权只在 Control Plane；这里只暴露静态事实 + authorizationHint。
const EXTERNAL_RISK = new Set(["R2", "R3"]);
const EXTERNAL_IDEMPOTENCY = new Set(["external_effect", "ambiguous_on_timeout"]);
const LOW_MATURITY = new Set(["E0", "E1"]);

function derivePolicy(capability) {
  const mode = capability.automationPolicy?.mode ?? null;
  const canaryOnlyFlag = capability.automationPolicy?.canaryOnly === true;
  const availability = capability.availability ?? "implemented";
  // externalEffect remains a static business-effect description, not an approval signal
  const externalEffect = EXTERNAL_RISK.has(capability.risk) || EXTERNAL_IDEMPOTENCY.has(capability.idempotency)
    || (capability.normalizedEffect && ["social", "publish", "payment", "delete"].includes(capability.normalizedEffect.class));
  const canaryRequired = LOW_MATURITY.has(capability.maturity) || canaryOnlyFlag || availability === "canary_only";
  const labOnly = mode === "lab_only";
  const disabled = mode === "disabled";
  const available = availability === "implemented";
  // Implementation support hints (NOT authorization). Consumers must not treat null as allow/block.
  // Business-effect capabilities are still "implemented", but task-packet does not hand out a
  // naive job skeleton for them — Control Plane decides allow/block/wait on submit.
  const supportJob = available && !labOnly && !disabled && !canaryRequired && !externalEffect;
  const supportCanarySession = (available || availability === "canary_only") && !labOnly && !disabled && canaryRequired;
  return {
    mode,
    availability,
    externalEffect,
    // deprecated authorization fields — always null (Foundation freeze)
    approvalRequired: null,
    autonomous: null,
    runnableAsJob: null,
    runnableAsCanarySession: null,
    legacyAuthorizationFieldsDeprecated: true,
    authorizationHint: "context_required",
    canaryRequired,
    labOnly,
    disabled,
    // non-authorization support hints for UI only
    implementationSupport: {
      job: supportJob,
      canarySession: supportCanarySession,
    },
  };
}

function capabilityLint(capability, policy) {
  const warnings = [];
  if (policy.externalEffect && capability.restoration?.required === false) {
    warnings.push("有外部效应且不要求 restoration——副作用不会被自动回收");
  }
  if (policy.canaryRequired && policy.mode === "automatic") {
    warnings.push(`maturity=${capability.maturity} 需 canary session，automatic 模式下 job 直提可能被 CP 拒绝`);
  }
  warnings.push("authorization: 仅 Control Plane 决策；policy.approvalRequired/runnableAsJob 已废弃为 null");
  return warnings;
}

function summarizeCapability(capability, routingByCapability) {
  const policy = derivePolicy(capability);
  return {
    id: capability.id,
    appId: capability.appId ?? null,
    ...(capability.description !== undefined ? { description: capability.description } : {}),
    ...(capability.inputSchema !== undefined ? { inputSchema: capability.inputSchema } : {}),
    ...(capability.outputSchema !== undefined ? { outputSchema: capability.outputSchema } : {}),
    ...(capability.preconditions !== undefined ? { preconditions: capability.preconditions } : {}),
    ...(capability.verification !== undefined ? { verification: capability.verification } : {}),
    ...(capability.restoration !== undefined ? { restoration: capability.restoration } : {}),
    ...(capability.composition !== undefined ? { composition: capability.composition } : {}),
    risk: capability.risk ?? null,
    maturity: capability.maturity ?? null,
    idempotency: capability.idempotency ?? null,
    timeoutMs: capability.timeoutMs ?? null,
    resources: capability.resources ?? [],
    restorationRequired: capability.restoration?.required ?? null,
    verificationMode: capability.verification?.mode ?? null,
    normalizedEffect: capability.normalizedEffect ?? null,
    capabilityContractHash: capability.capabilityContractHash ?? null,
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

function buildFoundationCapabilityCatalog() {
  try {
    const capabilities = loadFoundationCapabilities().sort((a, b) => a.id.localeCompare(b.id));
    return {
      ok: true,
      error: null,
      generatedAt: new Date().toISOString(),
      count: capabilities.length,
      capabilities,
    };
  } catch (error) {
    return {
      ok: false,
      error: String(error?.message || error),
      generatedAt: new Date().toISOString(),
      count: 0,
      capabilities: [],
    };
  }
}

function buildWorkflowCatalog() {
  try {
    const workflows = loadWorkflows()
      .map((item) => summarizeWorkflow(item))
      .sort((a, b) => a.workflowId.localeCompare(b.workflowId));
    return {
      ok: true,
      error: null,
      generatedAt: new Date().toISOString(),
      count: workflows.length,
      workflows,
      note: "Workflow catalog is versioned and discoverable; session_workflow runtime may still be offline. canary_only entries are not production-runnable.",
    };
  } catch (error) {
    return {
      ok: false,
      error: String(error?.message || error),
      generatedAt: new Date().toISOString(),
      count: 0,
      workflows: [],
      note: null,
    };
  }
}

// ---------- 任务包（P1，只推荐不代提交）----------
const TASK_KEYWORDS = [
  { match: /闲鱼|xianyu/i, appId: "xianyu" },
  { match: /小红书|xhs|笔记/i, appId: "xhs" },
  { match: /抖音|douyin/i, appId: "douyin" },
  { match: /微信|wechat|客服|会话/i, appId: "wechat" },
  { match: /微购|weigou/i, appId: "weigou" },
  { match: /设备|device|网关|小薇|xiaowei/i, appId: "xiaowei" },
];
const TASK_IMPLICIT_APP_KEYWORDS = [
  // Compatibility for legacy shorthand only after every explicit App name was
  // checked, so "抖音草稿" cannot be stolen by an action word such as 草稿.
  { match: /上架|发布商品|保存草稿/i, appId: "xianyu" },
];
const INTENT_KEYWORDS = [
  { match: /只读|观察|快照|observe|snapshot|巡检/i, prefer: /observe/ },
  { match: /搜索|search/i, prefer: /search/ },
  { match: /余额|balance/i, prefer: /balance/ },
  { match: /指标|metrics/i, prefer: /metrics/ },
  { match: /图片|image|相册/i, prefer: /image/ },
  { match: /输入|文案|描述|text/i, prefer: /input/ },
  { match: /全链|完整|full|标准链|发布|发商品|上架|不保存|no.?save/i, prefer: /full_dry_run$/ },
  { match: /打开|进入|open/i, prefer: /open/ },
  { match: /草稿|保存草稿|save.?draft/i, prefer: /save_draft/ },
];

function buildTaskPacket(taskText, catalog, entry) {
  const text = String(taskText || "");
  const app = TASK_KEYWORDS.find((k) => k.match.test(text))?.appId
    ?? TASK_IMPLICIT_APP_KEYWORDS.find((k) => k.match.test(text))?.appId
    ?? null;
  const intent = INTENT_KEYWORDS.filter((k) => k.match.test(text)).map((k) => k.prefer);
  const pool = catalog.capabilities.filter((c) => (app ? c.appId === app : true));
  const readyAliases = new Set(entry.devices.filter((d) => d.state.ready).map((d) => d.alias));
  // 只推荐被路由到至少一台设备的能力（无路由=placement 会拒，推荐了也跑不了）。
  // 无意图匹配时不按基础分瞎猜——返回空推荐 + 提示，避免误导（如把 open_dry_run 排在 save_draft 前）。
  const routed = pool.filter((c) => c.eligibleAliases.length);
  let recommendations = [];
  if (intent.length) {
    const scored = routed.map((c) => {
      let intentScore = 0;
      for (const rx of intent) if (rx.test(c.id)) intentScore += 3;
      let score = intentScore;
      // implementationSupport is a static support hint, NOT Control Plane authorization
      if (c.policy.implementationSupport?.job) score += 2;
      if (c.risk === "R0") score += 1;
      return { c, score, intentScore };
    }).filter(({ intentScore }) => intentScore > 0)
      .sort((a, b) => b.score - a.score || a.c.id.localeCompare(b.c.id));
    recommendations = scored.slice(0, 3).map(({ c, score }) => {
      const eligible = c.eligibleAliases.map((alias) => ({
        alias,
        routed: true,
        ready: readyAliases.has(alias),
        reason: readyAliases.has(alias) ? "ready" : "not ready（离线/隔离/占用/有未解决失败，见 devices[].state）",
      }));
      const why = [
        app ? `App 匹配 ${app}` : "未指定 App",
        c.policy.implementationSupport?.job
          ? "实现可用（job 入口；最终 allow/block 由 Control Plane 决定）"
          : c.policy.implementationSupport?.canarySession
            ? "需 canary session（低成熟度/canary_only）"
            : c.policy.externalEffect
              ? "业务外效：授权由 Control Plane 按 pilot/policy 决定（非本地人审推导）"
              : `availability=${c.policy.availability}，实现支持有限`,
        `路由允许：${c.eligibleAliases.join("/")}`,
        "authorizationHint=context_required",
      ];
      // Skeleton only for static implementationSupport.job; CP still re-authorizes on submit.
      let submitSkeleton = null;
      let submitNote = null;
      if (c.policy.implementationSupport?.job) {
        submitSkeleton = `node control-plane/devicectl.mjs --ssh xhs-windows job submit --actor <actor> --capability ${c.id} --device <deviceId 见 /api/devices> --idempotency-key <唯一键> --params '<json>'`;
      } else if (c.policy.implementationSupport?.canarySession) {
        submitNote = "需先建立 canary session 再提交（见控制面 canary 文档），不可直接 job submit";
      } else {
        submitNote = c.policy.externalEffect
          ? "业务外效：不因 R2 本地推导审批；提交后由 Control Plane 按 policyMode/pilot 返回 allow/block/wait"
          : `不可直接提交：${c.policy.labOnly ? "lab_only" : c.policy.disabled ? "disabled" : `availability=${c.policy.availability}`}`;
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
  // Optional enrichment: compile TaskPlan against catalog + implemented/canary recipes (non-breaking).
  let taskPlan = null;
  try {
    const recipes = listRecipes(db, { includeAll: false }).map((r) => ({
      recipeId: r.recipeId,
      status: r.status,
      spec: r.spec,
    }));
    taskPlan = compileTaskPlan({
      goal: text,
      catalogCapabilities: catalog.capabilities || [],
      recipes,
      foundationCapabilities: loadFoundationCapabilities(),
    });
  } catch {
    taskPlan = null;
  }
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
    taskPlan,
    matchedRecipe: taskPlan?.matched?.recipeId
      ? { recipeId: taskPlan.matched.recipeId, capabilityId: taskPlan.matched.capabilityId, modelTier: taskPlan.modelTier }
      : null,
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

// ---------- REX Phase 2 收尾: 资金最终提交人类确认面 ----------
// Registry 是签名 oracle：持有人类 Ed25519 私钥（受限文件），对控制面原样提供的 binding
// 签 xhs.payment-approval.v1。浏览器只点按钮 + 输确认短语 + CSRF，不能改 amount/payee/
// target/snapshot——approve 的 binding 一律取自控制面 list，不取自 body。这与 B 仓
// payment-approval-verifier 的 canonicalPaymentApprovalBytes 逐字节一致（递归排序键后 JSON）。
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonicalize(value[k])]));
  }
  return value;
}
function canonicalJson(value) { return JSON.stringify(canonicalize(value)); }

// 签名器私钥缓存：只在首次 approve 时懒加载，加载失败永不退化 unsigned。私钥明文绝不进日志。
let paymentSignerCache = undefined; // undefined=未尝试, null=不可用, object=已加载
function loadPaymentSigner() {
  if (paymentSignerCache !== undefined) return paymentSignerCache;
  paymentSignerCache = null;
  if (!PAYMENT_SIGNER_KEYS_FILE) return null;
  try {
    const raw = fs.readFileSync(PAYMENT_SIGNER_KEYS_FILE, "utf8");
    const cfg = JSON.parse(raw);
    if (!cfg || typeof cfg.keyId !== "string" || typeof cfg.subject !== "string"
      || typeof cfg.privateKeyPem !== "string" || !Number.isInteger(cfg.allowlistVersion)) {
      console.log("[registry] payment signer keys file malformed; approve will 503");
      return null;
    }
    paymentSignerCache = {
      keyId: cfg.keyId,
      subject: cfg.subject,
      allowlistVersion: cfg.allowlistVersion,
      privateKey: createPrivateKey(cfg.privateKeyPem),
    };
    return paymentSignerCache;
  } catch (e) {
    console.log(`[registry] payment signer unavailable; approve will 503: ${e.message}`);
    return null;
  }
}

// 用控制面原样提供的 binding 构造并签名一份一次性支付批准。binding 字段逐项取自控制面，
// 调用方不得传入来自浏览器的 amount/payee/target/snapshot。
function signPaymentApproval(binding) {
  const signer = loadPaymentSigner();
  if (!signer) return { ok: false, code: "PAYMENT_SIGNER_UNAVAILABLE" };
  const unsigned = {
    schemaId: "xhs.payment-approval.v1",
    schemaVersion: 1,
    commitId: binding.commitId,
    runId: binding.runId,
    effectId: binding.effectId,
    app: binding.app,
    accountRef: binding.accountRef,
    payeeRef: binding.payeeRef,
    amount: binding.amount,
    currency: binding.currency,
    targetControlFingerprint: binding.targetControlFingerprint,
    snapshotHash: binding.snapshotHash,
    deviceId: binding.deviceId,
    createdAt: binding.createdAt,
    expiresAt: binding.expiresAt,
    purpose: "financial_commit",
    issuer: { subject: signer.subject, role: "human", keyId: signer.keyId, allowlistVersion: signer.allowlistVersion },
  };
  const signature = cryptoSign(null, Buffer.from(canonicalJson(unsigned)), signer.privateKey).toString("base64");
  return { ok: true, approval: { ...unsigned, signature } };
}

// 只读控制面 payment-commits list（已脱敏）。控制面不可达时降级为空列表 + sourceOk:false，绝不 500。
async function listPaymentCommitsFromControl() {
  try {
    const res = await fetch(`${CONTROL}/control/v1/payment-commits`, { signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS) });
    if (!res.ok) return { ok: false, paymentCommits: [], sourceOk: false };
    const data = await res.json();
    return { ok: true, paymentCommits: Array.isArray(data.paymentCommits) ? data.paymentCommits : [], sourceOk: true };
  } catch (e) {
    console.log(`[registry] payment-commits list degraded (control plane unreachable): ${e.message}`);
    return { ok: false, paymentCommits: [], sourceOk: false };
  }
}

async function proxyPaymentCommitDecision(commitId, body) {
  let res;
  try {
    res = await fetch(`${CONTROL}/control/v1/payment-commits/${encodeURIComponent(commitId)}/decide`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS + 2000),
    });
  } catch (e) {
    return { status: 502, data: { ok: false, error: `控制面不可达: ${e.message}` } };
  }
  let data = {};
  try { data = await res.json(); } catch { /* keep {} */ }
  return { status: res.status, data };
}

// 执行一次资金最终提交决定。approve 的 binding 强制取自控制面 list（按 commitId 查），
// 不接受 body 自报的金额/收款方/目标——浏览器改不动。返回 {status, data} 供路由层透传。
async function decidePaymentCommit(commitId, decision, { confirm, reason, actorId }) {
  if (decision === "approve") {
    if (confirm !== PAYMENT_CONFIRM_PHRASE) {
      return { status: 400, data: { ok: false, error: `approve requires body {"confirm":"${PAYMENT_CONFIRM_PHRASE}"}` } };
    }
    const list = await listPaymentCommitsFromControl();
    if (!list.sourceOk) return { status: 502, data: { ok: false, error: "控制面不可达，无法读取支付 binding" } };
    const row = list.paymentCommits.find((c) => c.commitId === commitId);
    if (!row || !row.approvalBinding) {
      return { status: 404, data: { ok: false, error: "payment commit not found or already decided" } };
    }
    const signed = signPaymentApproval({ ...row.approvalBinding, commitId: row.commitId });
    if (!signed.ok) return { status: 503, data: { ok: false, error: "payment signer unavailable; cannot approve" } };
    return proxyPaymentCommitDecision(commitId, { decision: "approve", approval: signed.approval, actorId, reason: reason ?? null });
  }
  // deny 不需要 signer，也不需要确认短语。
  return proxyPaymentCommitDecision(commitId, { decision: "deny", actorId, reason: reason ?? null });
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
    foundationCatalog: "ssh xhs-windows 'curl.exe -s http://127.0.0.1:17930/api/foundation-capabilities'",
    workflowCatalog: "ssh xhs-windows 'curl.exe -s http://127.0.0.1:17930/api/workflows'",
    locatorStatus: "ssh xhs-windows 'node C:\\Users\\Public\\xhs-registry\\ops\\xw-locator.mjs status'",
    routePlan: "node control-plane/devicectl.mjs --ssh xhs-windows route plan --actor <actor> --capability <id>",
    job: "node control-plane/devicectl.mjs --ssh xhs-windows job submit --capability <id> --actor <actor> --idempotency-key <key> --params '<json>'",
    jobStatus: "node control-plane/devicectl.mjs --ssh xhs-windows job status --job <jobId>",
    session: "node control-plane/devicectl.mjs --ssh xhs-windows session acquire --actor <actor> --capability <id> --alias <01-04>",
    controlPlaneReload: "ssh xhs-windows 'powershell -NoProfile -NonInteractive -File C:\\Users\\Public\\xhs-routing-v1-1\\scripts\\control-plane-task.ps1 -Action Stop; powershell -NoProfile -NonInteractive -File C:\\Users\\Public\\xhs-routing-v1-1\\scripts\\control-plane-task.ps1 -Action Start'",
    serveReload01: "ssh xhs-windows 'powershell -NoProfile -NonInteractive -File C:\\Users\\Public\\xhs-registry\\serve-restart-01.ps1'",
    serveReload02: "ssh xhs-windows 'powershell -NoProfile -NonInteractive -File C:\\Users\\Public\\xhs-registry\\serve-restart-02.ps1'",
    serveReload03: "ssh xhs-windows 'powershell -NoProfile -NonInteractive -File C:\\Users\\Public\\xhs-registry\\serve-restart-03.ps1'",
    serveReload04: "ssh xhs-windows 'powershell -NoProfile -NonInteractive -File C:\\Users\\Public\\xhs-registry\\serve-restart-04.ps1'",
  },
  redLines: [
    "部署 reload 仅限 exact reviewed revision、activeLeases=0、runningJobs=0 且 MISSION_AUTO_APPROVAL_ENABLED/STANDING_GRANT_ENABLED 均为 OFF；不得把 reload 当设备动作入口",
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
    scope: item.scope,
    app: item.app,
    title: item.title,
    lifecycle: item.lifecycle,
    needsEngineer: item.needsEngineer,
    appliesTo: item.appliesTo,
    verifyMode: item.verifyMode,
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

// REX Phase 6 P6-A: 读 control-plane 部署时写的 cross-repo release manifest。缺文件/schemaId
// 不符一律返回 null（降级），绝不抛。registry 与 control-plane 同机，直接读文件；读不到时
// agent-entry 仍以 health 上报的 policyMode/releaseId/runtimePolicyVersion 兜底。
function readReleaseManifest() {
  try {
    const file = path.join(CONTROL_PLANE_STATE_DIR, "cross-repo-release.json");
    if (!fs.existsSync(file)) return null;
    let text = fs.readFileSync(file, "utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const manifest = JSON.parse(text);
    return manifest && manifest.schemaId === "xhs.cross-repo-release.v1" ? manifest : null;
  } catch (e) {
    return null;
  }
}

async function buildAgentEntry() {
  const devices = await aggregate();
  const releaseManifest = readReleaseManifest();
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
  const foundations = buildFoundationCapabilityCatalog();
  const workflows = buildWorkflowCatalog();
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
    // REX Phase 6 P6-A: release/modes/schema + 完整 policyDocDebt（§5.5 最小执行契约明示）。
    // 以 cross-repo release manifest 为准，health 兜底；policyDocDebt 只提醒旧 Markdown，
    // 不阻止任何任务。
    release: {
      present: Boolean(releaseManifest),
      releaseId: releaseManifest?.releaseId ?? devices.controlPlane.releaseId ?? null,
      runtimePolicyVersion: releaseManifest?.runtimePolicyVersion ?? devices.controlPlane.runtimePolicyVersion ?? null,
      effectiveDecisionSource: releaseManifest?.effectiveDecisionSource ?? devices.controlPlane.policyMode?.effectiveDecisionSource ?? null,
      policyMode: releaseManifest?.policyMode ?? devices.controlPlane.policyMode?.mode ?? null,
      evidenceMode: releaseManifest?.evidenceMode ?? null,
      policyDocDebt: Array.isArray(releaseManifest?.policyDocDebt) ? releaseManifest.policyDocDebt : [],
      policyDocDebtCount: Array.isArray(releaseManifest?.policyDocDebt) ? releaseManifest.policyDocDebt.length : 0,
      policyDocDebtClean: Array.isArray(releaseManifest?.policyDocDebt) ? releaseManifest.policyDocDebt.length === 0 : true,
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
    foundations,
    workflows,
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
    "## Release / runtime policy",
    "",
    `- releaseId: ${entry.release.releaseId ?? "unknown"}${entry.release.present ? "" : " (no cross-repo-release.json)"}`,
    `- runtimePolicyVersion: ${entry.release.runtimePolicyVersion ?? "unknown"}`,
    `- effectiveDecisionSource: ${entry.release.effectiveDecisionSource ?? "unknown"}`,
    `- policyMode: ${entry.release.policyMode ?? "unknown"}`,
    `- evidenceMode: ${entry.release.evidenceMode ?? "unknown"}`,
    `- policyDocDebt: ${entry.release.policyDocDebtCount} item(s)${entry.release.policyDocDebtClean ? " (clean)" : ""}`,
    ...entry.release.policyDocDebt.map((item) => `  - ${item.path}: ${item.legacyRule || item.reason || "stale doc"} (supersededForRelease=${item.supersededForRelease || "?"})`),
    "",
    "## Current active blockers",
    "",
    ...(entry.blockers.active.length
      ? entry.blockers.active.map((item) => `- [${item.app || "infra"}] ${item.title} (${item.id})`)
      : ["- none"]),
    "",
    "## Discoverable foundation capabilities",
    "",
    ...(entry.foundations?.capabilities?.length
      ? entry.foundations.capabilities.map((item) =>
          `- ${item.id} | ${item.title} | status=${item.status} | execution=${item.executionStatus} | directRun=${yn(item.directRun)} | entry=\`${item.entry}\``)
      : [`- unavailable${entry.foundations?.error ? `: ${entry.foundations.error}` : ""}`]),
    "- catalog: `GET /api/foundation-capabilities`; `/xw skills` merges this catalog with formal capabilities, recipes, workflows, and foundation.",
    "",
    "## Discoverable workflows",
    "",
    ...(entry.workflows?.workflows?.length
      ? entry.workflows.workflows.map((item) =>
          `- ${item.workflowId} | ${item.title} | app=${item.appId} | status=${item.status} | maturity=${item.maturity} | entry=${item.entry} | directRun=${yn(item.directRun)} | tapAuthorized=${yn(item.tapAuthorized)}`)
      : [`- unavailable${entry.workflows?.error ? `: ${entry.workflows.error}` : ""}`]),
    "- catalog: `GET /api/workflows`; session_workflow multi-action descriptors (not single-job recipes). canary_only ≠ production-ready.",
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
  const sourceState = entry.sources.controlPlane.reachable ? "在线" : "降级";
  const deviceCards = entry.devices.map((device) => {
    const control = device.control;
    const quarantined = Boolean(control?.quarantined);
    const stateClass = quarantined ? "state-warn" : control?.online ? "state-ok" : "state-off";
    const stateText = quarantined ? "已隔离" : control?.online ? "在线" : "离线";
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
      ? `<div class="jobline"><b>上次成功</b> ${esc(formatTime(device.jobStatus.lastSuccess.finishedAt || device.jobStatus.lastSuccess.updatedAt))}<small>连胜 ${Number(device.jobStatus.consecutiveSuccesses) || 0}</small></div>`
      : "";
    return `<article class="device-card ${stateClass}"><header><div><span class="slot">${esc(device.alias)}</span><h3>${esc(device.label || "未命名设备")}</h3></div><span class="state">${stateText}</span></header>
      <dl><div><dt>序列号</dt><dd>${esc(device.serial || "unknown")}</dd></div><div><dt>型号</dt><dd>${esc(device.model || "unknown")}</dd></div>
      <div><dt>占用</dt><dd>${lease ? `${esc(lease.holderId)} / ${esc(lease.kind || "unknown")}` : "空闲"}</dd></div><div><dt>隔离</dt><dd>${quarantined ? esc(control.quarantineReason || "unknown") : "否"}</dd></div></dl>
      <section><h4>在跑任务</h4>${jobs}</section><section><h4>未解决失败</h4>${failure}${lastSuccess}</section></article>`;
  }).join("");
  const blockers = entry.blockers.active.length
    ? entry.blockers.active.map((item) => `<article class="blocker"><span>当前卡点</span><h2>${esc(item.title)}</h2><p>${esc(item.id)}</p><time>${esc(formatTime(item.updatedAt))}</time></article>`).join("")
    : '<article class="blocker clear"><span>当前卡点</span><h2>当前无硬卡点</h2><p>继续按控制面入口和 lease 纪律工作</p></article>';
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
  }).join("") : '<div class="empty-panel">当前没有待人工审批任务。Agent 提交有外部后果的 R2/R3 操作（如真存草稿、真发布）后，这里会出现对应的批准 / 拒绝按钮——上面的红卡是知识库记录的已知卡点，不是审批项。</div>';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>XHS Agent 控制塔</title><style>
:root{--ink:#15191c;--paper:#f0efe9;--panel:#fbfaf5;--line:#c7c3b8;--muted:#6f756f;--green:#0b7a53;--amber:#d47b12;--red:#b7372d;--blue:#1e5f86;--shadow:0 12px 30px rgba(30,38,38,.08)}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font-family:"Avenir Next Condensed","DIN Alternate","PingFang SC",sans-serif;background-image:linear-gradient(rgba(21,25,28,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(21,25,28,.035) 1px,transparent 1px);background-size:24px 24px}a{color:inherit}.shell{max-width:1480px;margin:auto;padding:24px}.topbar{display:grid;grid-template-columns:1fr auto;align-items:end;border-bottom:3px solid var(--ink);padding-bottom:16px}.eyebrow,.section-kicker{font:700 11px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.18em;color:var(--muted)}h1{font-size:clamp(34px,6vw,72px);line-height:.85;letter-spacing:-.055em;margin:6px 0 0;text-transform:uppercase}.topnav{display:flex;gap:8px;flex-wrap:wrap}.topnav a{font:700 12px ui-monospace,SFMono-Regular,Menlo,monospace;text-decoration:none;border:1px solid var(--ink);padding:9px 12px;background:var(--panel)}
.status-strip{display:grid;grid-template-columns:repeat(5,1fr);gap:1px;background:var(--ink);border:1px solid var(--ink);margin:18px 0}.metric{background:var(--panel);padding:14px}.metric b{display:block;font-size:25px}.metric small{font:10px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted);letter-spacing:.12em}.metric.primary{background:var(--ink);color:white}.metric.primary small{color:#b9c0bd}.notice{border-left:6px solid var(--blue);padding:12px 16px;background:#e7f1f5;margin:14px 0}.blockers{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px;margin:18px 0 26px}.blocker{background:#261b18;color:#fff;padding:22px;border-top:7px solid var(--red);box-shadow:var(--shadow)}.blocker span{font:700 10px ui-monospace,monospace;letter-spacing:.16em;color:#f0a69f}.blocker h2{margin:8px 0 5px;font-size:24px}.blocker p,.blocker time{font:11px ui-monospace,monospace;color:#c7bbb8}.blocker.clear{background:#17342a;border-color:var(--green)}
.section-head{display:flex;justify-content:space-between;align-items:end;margin:28px 0 12px}.section-head h2{font-size:26px;margin:4px 0 0}.section-head p{margin:0;color:var(--muted);font-size:12px}.device-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(270px,1fr));gap:12px}.device-card{background:var(--panel);border:1px solid var(--line);border-top:7px solid var(--muted);padding:16px;box-shadow:var(--shadow)}.device-card.state-ok{border-top-color:var(--green)}.device-card.state-warn{border-top-color:var(--amber)}.device-card header{display:flex;justify-content:space-between;align-items:start}.device-card header>div{display:flex;gap:10px;align-items:center}.slot{display:grid;place-items:center;width:42px;height:42px;background:var(--ink);color:white;font:bold 16px ui-monospace,monospace}.device-card h3{font-size:19px;margin:0}.state{font:700 9px ui-monospace,monospace;letter-spacing:.1em;border:1px solid currentColor;padding:4px 6px}.device-card dl{display:grid;grid-template-columns:1fr 1fr;border-top:1px solid var(--line);border-left:1px solid var(--line);margin:16px 0}.device-card dl div{padding:8px;border-right:1px solid var(--line);border-bottom:1px solid var(--line);min-width:0}.device-card dt,.device-card h4{font:700 9px ui-monospace,monospace;letter-spacing:.12em;color:var(--muted)}.device-card dd{margin:3px 0 0;font:12px ui-monospace,monospace;overflow-wrap:anywhere}.device-card section{border-top:1px solid var(--line);padding-top:10px;margin-top:10px}.jobline{font:12px ui-monospace,monospace;padding:5px 0}.jobline small{display:block;color:var(--muted)}.fault{display:flex;justify-content:space-between;font:11px ui-monospace,monospace;color:var(--red)}.empty{color:var(--muted);font-size:12px}
.split{display:grid;grid-template-columns:1fr 1fr;gap:14px}.timeline{list-style:none;margin:0;padding:0;background:var(--panel);border:1px solid var(--line)}.timeline li{display:grid;grid-template-columns:12px 1fr auto;gap:10px;padding:12px;border-bottom:1px solid var(--line);align-items:center}.timeline li:last-child{border:0}.timeline b,.timeline small{display:block}.timeline b{font-size:13px}.timeline small,.timeline time{font:10px ui-monospace,monospace;color:var(--muted)}.event-dot{width:9px;height:9px;border-radius:50%;background:var(--blue)}.event-good{background:var(--green)}.event-bad{background:var(--red)}.event-live{background:var(--amber)}.event-note{background:var(--blue)}.approval-warning{background:#fff1d8;border:1px solid #e2b667;padding:12px;margin-bottom:10px;font-size:13px}.approval-card{background:var(--panel);border:1px solid var(--line);padding:16px;margin-bottom:10px}.approval-head{display:flex;gap:10px;align-items:center}.approval-head span{background:var(--red);color:white;padding:5px 8px;font:bold 11px ui-monospace,monospace}.approval-head h3{margin:0}.approval-card p{font:11px ui-monospace,monospace;color:var(--muted);overflow-wrap:anywhere}.approval-actions{display:grid;grid-template-columns:1fr 1fr;gap:10px}.approval-actions form{display:grid;gap:7px}.approval-actions input{width:100%;border:1px solid var(--line);background:white;padding:9px;font:12px ui-monospace,monospace}.approval-actions button{border:0;color:white;padding:10px;font-weight:800;cursor:pointer}.approve{background:var(--green)}.deny{background:var(--red)}.empty-panel{padding:20px;background:var(--panel);border:1px dashed var(--line);color:var(--muted)}footer{border-top:3px solid var(--ink);margin-top:32px;padding:14px 0;font:10px ui-monospace,monospace;color:var(--muted)}@media(max-width:800px){.shell{padding:14px}.topbar{grid-template-columns:1fr}.topnav{margin-top:14px}.status-strip{grid-template-columns:1fr 1fr}.split,.approval-actions{grid-template-columns:1fr}.device-grid{grid-template-columns:1fr}h1{font-size:45px}}
</style></head><body><main class="shell"><header class="topbar"><div><div class="eyebrow">XHS 多设备运营 / 实时快照</div><h1>Agent<br>控制塔</h1></div><nav class="topnav"><a href="/">刷新快照</a><a href="/agent-entry.md">Agent 入口</a><a href="/api/agent-entry">JSON</a><a href="/watchdog">巡检报告</a></nav></header>${noticeText ? `<div class="notice">${esc(noticeText)}</div>` : ""}
<div class="section-head"><div><span class="section-kicker">已知卡点</span><h2>当前卡点（非审批项）</h2></div><p>知识库记录的已知问题，仅展示，不需在此操作</p></div><section class="blockers">${blockers}</section>
<section class="status-strip"><div class="metric primary"><small>控制面</small><b>${esc(sourceState)}</b></div><div class="metric"><small>占用中</small><b>${esc(entry.controlPlane.activeLeases ?? "?")}</b></div><div class="metric"><small>在跑任务</small><b>${entry.jobs.active.length}</b></div><div class="metric"><small>release / 策略</small><b>${esc((entry.release.releaseId || entry.release.policyMode || "?").slice(0, 20))}</b></div><div class="metric"><small>待审批</small><b>${entry.approvals.pendingCount}</b></div><div class="metric"><small>快照时间</small><b>${esc(new Date(entry.generatedAt).toLocaleTimeString("zh-CN", { hour12: false }))}</b></div></section>
<div class="section-head"><div><span class="section-kicker">设备占用</span><h2>设备控制权与运行态</h2></div><p>lease 和 job 分别取证，不互相推断</p></div><section class="device-grid">${deviceCards}</section><div class="section-head"><div><span class="section-kicker">事件流</span><h2>最近动态</h2></div><p>服务端生成 · 无 JavaScript</p></div><section class="split"><ol class="timeline">${recentJobs}</ol><ol class="timeline">${recentKnowledge}</ol></section>
<div class="section-head"><div><span class="section-kicker">人工审批闸</span><h2>待人工审批</h2></div><p>Agent 禁止调用 approve / deny</p></div><div class="approval-warning">批准会触发真实外部效果。只有人可以操作；批准前必须手工输入 APPROVE。</div>${approvalCards}<footer>协议 ${esc(entry.schemaVersion)} · 生成于 ${esc(entry.generatedAt)} · 控制面库 ${entry.sources.controlDb.reachable ? "可读" : "降级"}</footer></main></body></html>`;
}

function renderStatusPage(status, title, message) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>body{font-family:"Avenir Next Condensed","PingFang SC",sans-serif;background:#f0efe9;color:#15191c;margin:0;padding:32px}.box{max-width:680px;margin:auto;background:#fbfaf5;border-top:8px solid #b7372d;padding:24px}a{color:#1e5f86}</style></head><body><main class="box"><small>HTTP ${esc(status)}</small><h1>${esc(title)}</h1><p>${esc(message)}</p><a href="/">返回控制台</a></main></body></html>`;
}

// 资金最终提交人类确认页：只列 payment commits，绝不混入普通非支付任务。表单只回填
// commitId + 只读 binding 摘要；金额/收款方/目标由控制面提供，浏览器没有可改的输入框。
function renderPaymentConfirmPage({ csrfToken = "", paymentCommits = [], sourceOk = true, phrase = "APPROVE_PAYMENT", notice = null } = {}) {
  const noticeBanner = notice ? `<div class="approval-warning">结果：${esc(notice)}</div>` : "";
  const cards = paymentCommits.length ? paymentCommits.map((c) => {
    const b = c.approvalBinding || {};
    return `<article class="approval-card"><div class="approval-head"><span>付款</span><h3>${esc(c.commitId)}</h3></div>
      <p>${esc(b.app || "?")} · ${esc(b.accountRef || "?")} → ${esc(b.payeeRef || "?")} · ${esc(b.amount || "?")} ${esc(b.currency || "")}</p>
      <p>目标指纹 <code>${esc(b.targetControlFingerprint || "")}</code> · 设备 ${esc(b.deviceId || "?")} · 快照 ${esc((b.snapshotHash || "").slice(0,12))}</p>
      <p>有效期至 ${esc(b.expiresAt || "?")}</p>
      <div class="approval-actions"><form method="post" action="/ui/payment-commits/${encodeURIComponent(c.commitId)}/approve"><input type="hidden" name="csrf" value="${esc(csrfToken)}"><input name="reason" placeholder="批准理由（可选）" aria-label="批准理由"><input name="confirmation" required pattern="${esc(phrase)}" placeholder="输入 ${esc(phrase)}" aria-label="确认支付"><button class="approve" type="submit">确认支付</button></form>
      <form method="post" action="/ui/payment-commits/${encodeURIComponent(c.commitId)}/deny"><input type="hidden" name="csrf" value="${esc(csrfToken)}"><input name="reason" placeholder="拒绝理由（可选）" aria-label="拒绝理由"><button class="deny" type="submit">拒绝支付</button></form></div></article>`;
  }).join("") : `<div class="empty-panel">没有待确认的资金最终提交。${sourceOk ? "" : "（控制面不可达，已降级为空列表）"}</div>`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>资金最终提交确认</title><style>body{font-family:"Avenir Next Condensed","PingFang SC",sans-serif;background:#f0efe9;color:#15191c;margin:0;padding:32px}.shell{max-width:880px;margin:auto}h1{font-size:40px;margin:0 0 4px}h2{font-size:22px;margin:18px 0 8px}.section-head{display:flex;gap:14px;align-items:baseline;border-bottom:3px solid #15191c;padding-bottom:8px;margin-bottom:14px}.section-kicker{font:bold 11px ui-monospace,monospace;color:#b7372d;letter-spacing:.12em;text-transform:uppercase}a{color:#1e5f86}.approval-warning{background:#fff1d8;border:1px solid #e2b667;padding:12px;margin-bottom:10px;font-size:13px}.approval-card{background:#fbfaf5;border:1px solid #d8d4c4;padding:16px;margin-bottom:10px}.approval-head{display:flex;gap:10px;align-items:center}.approval-head span{background:#b7372d;color:white;padding:5px 8px;font:bold 11px ui-monospace,monospace}.approval-head h3{margin:0;font:12px ui-monospace,monospace}.approval-card p{font:11px ui-monospace,monospace;color:#555;margin:6px 0;overflow-wrap:anywhere}.approval-card code{font:10px ui-monospace,monospace}.approval-actions{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px}.approval-actions form{display:grid;gap:7px}.approval-actions input{width:100%;border:1px solid #d8d4c4;background:white;padding:9px;font:12px ui-monospace,monospace}.approval-actions button{border:0;color:white;padding:10px;font-weight:800;cursor:pointer}.approve{background:#2e7d32}.deny{background:#b7372d}.empty-panel{padding:20px;background:#fbfaf5;border:1px dashed #d8d4c4;color:#777}footer{border-top:3px solid #15191c;margin-top:24px;padding:12px 0;font:10px ui-monospace,monospace;color:#777}</style></head><body><main class="shell"><a href="/">← 返回控制台</a><h1>资金最终提交确认</h1>
  <div class="section-head"><div><span class="section-kicker">硬闸</span><h2>待人类确认的资金最终提交</h2></div></div>
  <div class="approval-warning">这是唯一的硬闸。确认支付会触发真实资金动作；只有人可以操作，且必须手工输入 ${esc(phrase)}。金额/收款方/目标由控制面提供，浏览器无法修改。</div>${noticeBanner}${cards}<footer>仅显示资金最终提交；普通非支付任务不在此页。</footer></main></body></html>`;
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

const SESSION_ROLES = new Set(["human", "agent", "observer"]);

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
// observer/operator 凭证只认 header，禁止走 URL query（避免 token 出现在 URL/浏览器历史/日志）。
function providedHeaderToken(req) {
  return String(req.headers["x-registry-token"] || "");
}

// 请求角色："human" | "agent" | "loopback" | null（拒绝）
function resolveAuth(req) {
  // 四种 token 均空才进入开放调试；只配了 observer/operator 不能把所有请求当 human。
  if (!AGENT_TOKEN && !HUMAN_TOKEN && !OBSERVER_TOKEN && !OPERATOR_TOKEN) return "human";
  const provided = providedToken(req);
  if (HUMAN_TOKEN && provided && safeEqual(provided, HUMAN_TOKEN)) return "human";
  const sessionRole = validSession(parseCookies(req)[SESSION_COOKIE]);
  if (sessionRole) return sessionRole;
  if (AGENT_TOKEN && provided && safeEqual(provided, AGENT_TOKEN)) return LEGACY_AUTH ? "human" : "agent";
  // observer/operator 只认 header token，绝不接受 ?token= query 形式。
  const headerToken = providedHeaderToken(req);
  if (OBSERVER_TOKEN && headerToken && safeEqual(headerToken, OBSERVER_TOKEN)) return "observer";
  if (OPERATOR_TOKEN && headerToken && safeEqual(headerToken, OPERATOR_TOKEN)) return "operator";
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

// observer 只读、operator 仅 /api/operator/*：两者都不得写知识库/身份。
function readOnlyRole(role) {
  return role === "observer" || role === "operator";
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

// ---------- Fleet / Screen / Operator API（abtop 远程通道）----------
// 设计约束：observer 只读舰队与已采集截图；operator 本轮全面冻结（501）。
// observer 绝不直接碰 17920 写口 / 22222 / ADB / control.db 写入；Screen 只读 evidence 表 + 磁盘字节。

// alias → deviceId（只读 control.db devices 表；未注册返回 null）
function deviceIdByAlias(alias) {
  return queryControlDb((cdb) => {
    const row = cdb.prepare("SELECT device_id FROM devices WHERE alias = ?").get(alias);
    return row?.device_id ?? null;
  }, null);
}

// 文本规范化：去控制字符、限长；用于对外 displayName/model。JSON 层只规范化，渲染层仍须转义。
function normalizeText(value, maxLen) {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, maxLen);
  return cleaned || null;
}

// 脱敏 fleet 设备：保留安全 displayName/model；剥 serial/accounts/customer/notes/deviceId/runId/路径/参数。
function redactFleetDevice(dev, entry) {
  const job = dev.activeJobs && dev.activeJobs[0] ? dev.activeJobs[0] : null;
  const lease = dev.control?.lease || null;
  return {
    alias: dev.alias,
    displayName: normalizeText(dev.label, 60) ?? `设备 ${dev.alias}`,
    model: normalizeText(dev.model, 60),
    online: dev.state?.online ?? null,
    ready: dev.state?.ready ?? null,
    quarantined: dev.state?.quarantined ?? null,
    quarantineReason: dev.control?.quarantineReason ?? null,
    lease: lease ? { held: true, kind: lease.kind ?? null, expiresAt: lease.expiresAt ?? null } : { held: false },
    currentTask: job
      ? { capabilityId: job.capabilityId ?? null, jobId: job.jobId ?? null, reportedActor: job.actorId ?? null, actorVerified: false, status: job.status ?? null }
      : null,
    streak: dev.jobStatus?.consecutiveSuccesses ?? null,
    unresolvedFailure: Boolean(dev.jobStatus?.unresolvedFailure),
    freshness: {
      generatedAt: entry.generatedAt,
      controlPlane: { reachable: entry.sources.controlPlane.reachable, stale: entry.sources.controlPlane.stale },
      controlDb: { reachable: entry.sources.controlDb.reachable, stale: entry.sources.controlDb.stale },
      identityAgeSeconds: entry.sources.identityCache.ageSeconds ?? null,
      identityStale: entry.sources.identityCache.stale ?? null,
    },
  };
}

async function buildFleet() {
  const entry = await buildAgentEntry();
  const degraded = Boolean(entry.sources.controlPlane.stale || entry.sources.controlDb.stale);
  return {
    ok: true,
    schemaVersion: "xhs.observer.fleet.v1",
    generatedAt: entry.generatedAt,
    degraded,
    sources: entry.sources,
    devices: entry.devices.map((d) => redactFleetDevice(d, entry)),
  };
}

// ---------- cache-only Screen API ----------
// 只返回控制面已采集的最近截图（evidence kind=screenshot）；前端刷新命中进程内缓存/304，绝不触发设备。
const _ttlMs = Number(argOf("screen-cache-ttl-ms", "10000"));
const SCREEN_CACHE_TTL_MS = Number.isFinite(_ttlMs) ? Math.max(0, _ttlMs) : 10000; // 多久重新查数据库
const SCREEN_STALE_AFTER_MS = 120000; // 截图年龄超过即标记 stale
const SCREEN_MAX_BYTES = 8 * 1024 * 1024;
const _minInterval = Number(argOf("screen-min-interval-ms", "1000"));
const SCREEN_MIN_INTERVAL_MS = Number.isFinite(_minInterval) ? Math.max(0, _minInterval) : 1000;  // 同 alias 最小请求间隔，间隔内只返回缓存/304
const screenCache = new Map();        // alias → { buf, sha, bytes, capturedAt, jobId, contentType, loadedAt, fallback }
const screenInflight = new Map();     // alias → Promise<entry|null>（单飞，防并发穿透）
const screenLastReq = new Map();      // alias → ts（限频）

const IMAGE_SIGNATURES = [
  { contentType: "image/png", head: [0x89, 0x50, 0x4e, 0x47] },
  { contentType: "image/jpeg", head: [0xff, 0xd8, 0xff] },
];

function detectImageType(buf) {
  for (const sig of IMAGE_SIGNATURES) {
    if (buf.length >= sig.head.length && sig.head.every((b, i) => buf[i] === b)) return sig.contentType;
  }
  return null;
}

// 从 evidence 表读最新截图并重新校验：路径限制（realpath 防符号链接逃逸）、SHA-256、字节数、魔数。
async function loadScreenEntry(alias, deviceId) {
  if (!deviceId || !RUNS_ROOT) return null;
  const row = queryControlDb((cdb) => cdb.prepare(`
    SELECT e.path, e.run_id, e.sha256, e.bytes, e.created_at, e.job_id
    FROM evidence e JOIN jobs j ON e.job_id = j.job_id
    WHERE j.device_id = ? AND e.kind = 'screenshot'
    ORDER BY e.created_at DESC LIMIT 1`).get(deviceId), null);
  if (!row) return null;
  if (!Number.isFinite(row.bytes) || row.bytes > SCREEN_MAX_BYTES) return { oversize: true };
  const rootReal = await fs.promises.realpath(RUNS_ROOT).catch(() => null);
  if (!rootReal) return null;
  const target = path.join(RUNS_ROOT, row.run_id, row.path);
  const targetReal = await fs.promises.realpath(target).catch(() => null);
  if (!targetReal) return null;
  if (targetReal !== rootReal && !targetReal.startsWith(rootReal + path.sep)) return null;
  const buf = await fs.promises.readFile(targetReal).catch(() => null);
  if (!buf || buf.length > SCREEN_MAX_BYTES) return null;
  if (row.bytes != null && buf.length !== row.bytes) return null;
  const sha = createHash("sha256").update(buf).digest("hex");
  // SHA 校验收严：数据库摘要必须是合法 64 位十六进制 SHA-256，且与重算值严格一致。
  // 空值或异常类型不得放行（否则绕过完整性校验），一律 404。
  const expected = typeof row.sha256 === "string" ? row.sha256.trim().toLowerCase() : "";
  if (!/^[0-9a-f]{64}$/.test(expected) || !safeEqual(sha, expected)) return null;
  const contentType = detectImageType(buf);
  if (!contentType) return null;
  return {
    buf, sha, bytes: buf.length,
    capturedAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    jobId: row.job_id, contentType, loadedAt: Date.now(), fallback: false,
  };
}

// 单飞：并发请求共用一次 DB + 文件读取。
function loadScreenSingleflight(alias, deviceId) {
  const existing = screenInflight.get(alias);
  if (existing) return existing;
  const p = (async () => {
    try { return await loadScreenEntry(alias, deviceId); }
    finally { screenInflight.delete(alias); }
  })();
  screenInflight.set(alias, p);
  return p;
}

function screenEntryStale(entry, now) {
  if (!entry) return false;
  if (entry.fallback) return true;
  if (!entry.capturedAt) return true;
  const ageMs = now - Date.parse(entry.capturedAt);
  return Number.isFinite(ageMs) && ageMs > SCREEN_STALE_AFTER_MS;
}

async function serveScreen(res, req, alias, metaOnly) {
  if (!alias) return sendJson(res, 400, { ok: false, error: "missing alias" });
  const now = Date.now();
  const lastReq = screenLastReq.get(alias) ?? 0;
  const throttled = now - lastReq < SCREEN_MIN_INTERVAL_MS;
  screenLastReq.set(alias, now);
  let cached = screenCache.get(alias);
  const cacheFresh = cached && now - cached.loadedAt <= SCREEN_CACHE_TTL_MS;

  if (!cacheFresh && !(throttled && cached)) {
    const deviceId = deviceIdByAlias(alias);
    if (!deviceId) {
      if (!cached) return sendJson(res, 404, { ok: false, error: "device not found", alias });
    } else {
      const loaded = await loadScreenSingleflight(alias, deviceId);
      if (loaded && loaded.oversize) return sendJson(res, 413, { ok: false, error: "screenshot too large", alias });
      if (loaded && !loaded.oversize) {
        cached = loaded;
        screenCache.set(alias, cached);
      } else if (cached) {
        // 无新图或校验失败：沿用旧缓存降级（标记 fallback），否则 404（绝不触发采集）
        // 必须写回缓存：否则后续请求仍取到旧的 fallback=false 条目，会重复读盘并把 stale 误报成非 stale。
        cached = { ...cached, fallback: true, loadedAt: now };
        screenCache.set(alias, cached);
      } else {
        return sendJson(res, 404, { ok: false, error: "no cached screenshot", alias });
      }
    }
  }
  if (!cached) return sendJson(res, 404, { ok: false, error: "no cached screenshot", alias });
  const stale = screenEntryStale(cached, now);
  const ageSeconds = cached.capturedAt ? Math.max(0, Math.round((now - Date.parse(cached.capturedAt)) / 1000)) : null;

  if (metaOnly) {
    const metaHeaders = { "cache-control": "private, no-cache" };
    if (cached.sha) metaHeaders.etag = `"${cached.sha}"`;
    return sendJson(res, 200, {
      ok: true, alias, sha256: cached.sha, bytes: cached.bytes,
      capturedAt: cached.capturedAt, jobId: cached.jobId, contentType: cached.contentType,
      ageSeconds, stale,
    }, metaHeaders);
  }
  const inm = String(req.headers["if-none-match"] || "").replace(/^"(.*)"$/, "$1");
  if (cached.sha && inm && safeEqual(inm, cached.sha)) {
    res.writeHead(304, { etag: `"${cached.sha}"`, "cache-control": "private, no-cache" });
    return res.end();
  }
  const headers = {
    "content-type": cached.contentType || "application/octet-stream",
    "content-length": cached.buf.length,
    "cache-control": "private, no-cache",
    "x-screen-stale": stale ? "1" : "0",
  };
  if (cached.sha) headers.etag = `"${cached.sha}"`;
  if (cached.capturedAt) {
    headers["last-modified"] = new Date(cached.capturedAt).toUTCString();
    headers["x-screen-captured-at"] = cached.capturedAt;
  }
  res.writeHead(200, headers);
  res.end(cached.buf);
}

const server = http.createServer(async (req, res) => {
  const role = resolveAuth(req);
  if (!role) {
    return sendJson(res, 401, { ok: false, error: "unauthorized: provide ?token= or x-registry-token header" });
  }
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  // ---------- 命名空间闸门 ----------
  // observer 只能命中 /api/observer/v1/*；operator 只能命中 /api/operator/*；
  // 反之 observer/operator 命名空间也只接受对应角色。其余一律 403。
  const isObserverNs = url.pathname.startsWith("/api/observer/v1/");
  const isOperatorNs = url.pathname.startsWith("/api/operator/");
  if (role === "observer" && !isObserverNs) return sendJson(res, 403, { ok: false, error: "observer is restricted to /api/observer/v1/*" });
  if (role === "operator" && !isOperatorNs) return sendJson(res, 403, { ok: false, error: "operator is restricted to /api/operator/*" });
  if (isObserverNs && role !== "observer") return sendJson(res, 403, { ok: false, error: "observer namespace requires observer token" });
  if (isOperatorNs && role !== "operator") return sendJson(res, 403, { ok: false, error: "operator namespace requires operator token" });
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
        capabilities: {
          ok: catalog.ok,
          count: catalog.count,
          // implementationSupport.job count (not authorization autonomous)
          autonomousCount: catalog.capabilities.filter((c) => c.policy.implementationSupport?.job).length,
          lintWarnings: catalog.lintWarnings,
        },
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
      // ?autonomous=1 kept for wire compatibility; means implementationSupport.job, not CP allow
      if (autonomousOnly) items = items.filter((c) => c.policy.implementationSupport?.job);
      if (alias) items = items.filter((c) => c.eligibleAliases.includes(alias));
      return sendJson(res, 200, { ...catalog, count: items.length, capabilities: items }, { "cache-control": "no-store" });
    }
    if (req.method === "GET" && url.pathname === "/api/foundation-capabilities") {
      const catalog = buildFoundationCapabilityCatalog();
      return sendJson(res, catalog.ok ? 200 : 503, catalog, { "cache-control": "no-store" });
    }
    const foundationMatch = url.pathname.match(/^\/api\/foundation-capabilities\/([^/]+)$/);
    if (req.method === "GET" && foundationMatch) {
      const catalog = buildFoundationCapabilityCatalog();
      if (!catalog.ok) return sendJson(res, 503, catalog, { "cache-control": "no-store" });
      const wanted = decodeURIComponent(foundationMatch[1]);
      const found = catalog.capabilities.find((item) => item.id === wanted);
      if (!found) return sendJson(res, 404, { ok: false, error: `foundation capability not found: ${wanted}` });
      return sendJson(res, 200, { ok: true, capability: found }, { "cache-control": "no-store" });
    }
    if (req.method === "GET" && url.pathname === "/api/workflows") {
      const catalog = buildWorkflowCatalog();
      const app = url.searchParams.get("app");
      const status = url.searchParams.get("status");
      const includeAll = url.searchParams.get("includeAll") === "1";
      let items = catalog.workflows;
      if (app) items = items.filter((item) => item.appId === app);
      if (status) items = items.filter((item) => item.status === status);
      else if (!includeAll) {
        // Default list still returns canary/candidate for discovery, but callers must not
        // treat directRun=false as production-runnable (see catalog note + maturity).
        items = items.filter((item) => item.status !== "retired" && item.status !== "disabled");
      }
      return sendJson(res, catalog.ok ? 200 : 503, {
        ...catalog,
        count: items.length,
        workflows: items,
      }, { "cache-control": "no-store" });
    }
    const workflowMatch = url.pathname.match(/^\/api\/workflows\/([^/]+)$/);
    if (req.method === "GET" && workflowMatch) {
      const catalog = buildWorkflowCatalog();
      if (!catalog.ok) return sendJson(res, 503, catalog, { "cache-control": "no-store" });
      const wanted = decodeURIComponent(workflowMatch[1]);
      const found = catalog.workflows.find((item) => item.workflowId === wanted);
      if (!found) return sendJson(res, 404, { ok: false, error: `workflow not found: ${wanted}` });
      return sendJson(res, 200, { ok: true, workflow: found }, { "cache-control": "no-store" });
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
    // ---------- Recipe Catalog + TaskPlan (Phase 2/3 scaffolding) ----------
    if (req.method === "GET" && url.pathname === "/api/recipes") {
      const status = url.searchParams.get("status") || undefined;
      const includeAll = url.searchParams.get("all") === "1" || url.searchParams.get("includeAll") === "1";
      const recipes = listRecipes(db, { status, includeAll });
      return sendJson(res, 200, { ok: true, count: recipes.length, recipes }, { "cache-control": "no-store" });
    }
    const recipeMatch = url.pathname.match(/^\/api\/recipes\/([^/]+)$/);
    if (req.method === "GET" && recipeMatch) {
      const recipe = getRecipe(db, decodeURIComponent(recipeMatch[1]));
      return sendJson(res, 200, { ok: true, recipe }, { "cache-control": "no-store" });
    }
    if (req.method === "POST" && url.pathname === "/api/recipes/ingest") {
      if (readOnlyRole(role)) return sendJson(res, 403, { ok: false, error: "observer/operator is read-only" });
      const body = await readBody(req);
      const created = ingestRecipeCandidate(db, {
        spec: body.spec || body,
        originRunId: body.originRunId,
        actor: body.actor || (role === "human" ? `human:${HUMAN_ACTOR}` : `agent:${role}`),
      });
      return sendJson(res, 201, { ok: true, recipe: created });
    }
    if (req.method === "POST" && url.pathname === "/api/recipes/attempts") {
      if (readOnlyRole(role)) return sendJson(res, 403, { ok: false, error: "observer/operator is read-only" });
      const body = await readBody(req);
      const recipeId = body.recipeId;
      const revision = body.revision;
      const jobId = body.jobId;
      const runId = body.runId;
      if (!recipeId || !revision || !jobId || !runId) {
        return sendJson(res, 400, { ok: false, error: "recipeId, revision, jobId, runId are required" });
      }
      // Reject client-trusted booleans at the API boundary.
      if (body.verificationOk != null || body.restorationOk != null || body.result != null) {
        return sendJson(res, 400, {
          ok: false,
          error: "client verificationOk/restorationOk/result are not accepted; server verifies from control-plane",
        });
      }
      let jobPayload;
      try {
        jobPayload = await fetchControlJob(jobId, { controlBase: CONTROL });
      } catch (e) {
        return sendJson(res, e.status || 502, { ok: false, error: e.message, code: e.code });
      }
      let recipe;
      try {
        recipe = getRecipe(db, recipeId);
      } catch (e) {
        return sendJson(res, e.status || 404, { ok: false, error: e.message });
      }
      const version = recipe.versions.find((v) => Number(v.revision) === Number(revision))
        || (Number(recipe.latest.revision) === Number(revision) ? recipe.latest : null);
      if (!version) {
        return sendJson(res, 404, { ok: false, error: `recipe revision not found: ${recipeId}@${revision}` });
      }
      const spec = version.spec || {};
      const expectedCapabilityId = spec?.executor?.capabilityId || null;
      const receipt = buildAttemptReceiptFromJob(jobPayload, {
        recipeId,
        revision,
        descriptorHash: version.descriptorHash || spec.descriptorHash || null,
        expectedCapabilityId,
        expectedRunId: runId,
        workerWindowId: body.workerWindowId || null,
        releaseId: body.releaseId || null,
        gitCommit: body.gitCommit || null,
      });
      if (!receipt.ok) {
        return sendJson(res, 409, { ok: false, error: receipt.message, code: receipt.code, receipt });
      }
      const attempt = recordVerifiedAttempt(db, {
        recipeId,
        revision,
        runId,
        jobId,
        workerWindowId: body.workerWindowId || null,
        receipt,
      });
      return sendJson(res, 201, { ok: true, attempt, receipt: receipt.receipt });
    }
    if (req.method === "POST" && url.pathname === "/api/recipes/degrade") {
      if (readOnlyRole(role)) {
        return sendJson(res, 403, { ok: false, error: "observer/operator cannot degrade recipes" });
      }
      const body = await readBody(req);
      try {
        const out = degradeRecipe(db, {
          recipeId: body.recipeId,
          revision: body.revision,
          reason: body.reason || "manual_degrade",
          actor: role === "human" ? `human:${HUMAN_ACTOR}` : "legacy",
          receiptHash: body.receiptHash,
        });
        return sendJson(res, 200, { ok: true, ...out });
      } catch (e) {
        return sendJson(res, e.status || 400, { ok: false, error: e.message });
      }
    }
    if (req.method === "POST" && url.pathname === "/api/recipes/evaluate") {
      if (readOnlyRole(role)) return sendJson(res, 403, { ok: false, error: "observer/operator is read-only" });
      const body = await readBody(req);
      try {
        const out = evaluatePromotion(db, body.recipeId, body.revision);
        return sendJson(res, 200, { ok: true, ...out });
      } catch (e) {
        return sendJson(res, e.status || 400, { ok: false, error: e.message });
      }
    }
    if (req.method === "POST" && url.pathname === "/api/stall/enqueue") {
      if (readOnlyRole(role)) return sendJson(res, 403, { ok: false, error: "observer/operator is read-only" });
      const body = await readBody(req);
      const packet = body.packet || buildL2DiagnosticPacket(body);
      const item = enqueueStall(db, {
        runId: body.runId || packet.runId,
        jobId: body.jobId || packet.jobId,
        verdictHash: body.verdictHash || packet.stallVerdict?.hash,
        packet,
      });
      return sendJson(res, 201, { ok: true, item, packet });
    }
    if (req.method === "POST" && url.pathname === "/api/stall/shadow-decide") {
      if (readOnlyRole(role)) return sendJson(res, 403, { ok: false, error: "observer/operator is read-only" });
      const body = await readBody(req);
      const claimed = claimNextStallItem(db);
      if (!claimed) return sendJson(res, 200, { ok: true, empty: true });
      let packet = claimed.packet_json ? JSON.parse(claimed.packet_json) : null;
      if (!packet) {
        packet = buildL2DiagnosticPacket({
          runId: claimed.run_id,
          jobId: claimed.job_id,
          stallVerdict: body.stallVerdict || null,
        });
      }
      const decision = buildL2ShadowDecision(packet);
      completeStallItem(db, claimed.queue_id, { decision });
      return sendJson(res, 200, { ok: true, queueId: claimed.queue_id, packet, decision });
    }
    if (req.method === "POST" && url.pathname === "/api/task-plans") {
      if (readOnlyRole(role)) return sendJson(res, 403, { ok: false, error: "observer/operator is read-only" });
      const body = await readBody(req);
      const goal = body.goal || body.task || "";
      if (!goal) return sendJson(res, 400, { ok: false, error: "goal is required" });
      let catalogCapabilities = [];
      try {
        const catalog = await buildCapabilityCatalog();
        catalogCapabilities = catalog.capabilities || [];
      } catch {
        catalogCapabilities = [];
      }
      const recipes = listRecipes(db, { includeAll: false }).map((r) => ({
        recipeId: r.recipeId,
        status: r.status,
        spec: r.spec,
      }));
      const plan = compileTaskPlan({
        goal,
        catalogCapabilities,
        recipes,
        foundationCapabilities: loadFoundationCapabilities(),
        mode: body.mode,
      });
      return sendJson(res, 200, { ok: true, plan }, { "cache-control": "no-store" });
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
      if (readOnlyRole(role)) return sendJson(res, 403, { ok: false, error: "observer/operator is read-only" });
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
      if (readOnlyRole(role)) return sendJson(res, 403, { ok: false, error: "observer/operator is read-only" });
      const body = await readBody(req);
      const created = addKnowledge(body);
      return sendJson(res, 201, { ok: true, knowledge: created });
    }
    let km = url.pathname.match(/^\/api\/knowledge\/([^/]+)\/verify$/);
    if (req.method === "POST" && km) {
      if (readOnlyRole(role)) return sendJson(res, 403, { ok: false, error: "observer/operator is read-only" });
      const body = await readBody(req);
      return sendJson(res, 200, { ok: true, knowledge: verifyKnowledge(decodeURIComponent(km[1]), body.by) });
    }
    km = url.pathname.match(/^\/api\/knowledge\/([^/]+)\/flag-engineer$/);
    if (req.method === "POST" && km) {
      if (readOnlyRole(role)) return sendJson(res, 403, { ok: false, error: "observer/operator is read-only" });
      const body = await readBody(req);
      return sendJson(res, 200, { ok: true, knowledge: flagEngineer(decodeURIComponent(km[1]), body.needs !== false) });
    }
    km = url.pathname.match(/^\/api\/knowledge\/([^/]+)$/);
    if (req.method === "GET" && km) {
      return sendJson(res, 200, { ok: true, knowledge: getKnowledge(decodeURIComponent(km[1])) });
    }
    if (req.method === "PATCH" && km) {
      if (readOnlyRole(role)) return sendJson(res, 403, { ok: false, error: "observer/operator is read-only" });
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
    // ---------- 资金最终提交人类确认面（REX Phase 2 收尾）----------
    // list 只读控制面脱敏 binding；agent/operator/observer/loopback 都可读（控制面已剥密）。
    if (req.method === "GET" && url.pathname === "/api/payment-commits") {
      const list = await listPaymentCommitsFromControl();
      return sendJson(res, 200, { ok: list.ok, paymentCommits: list.paymentCommits, sourceOk: list.sourceOk }, { "cache-control": "no-store" });
    }
    // decide 只能由 human 触发；approve 的 binding 取自控制面，浏览器改不动金额/收款方/目标。
    km = url.pathname.match(/^\/api\/payment-commits\/([^/]+)\/decide$/);
    if (req.method === "POST" && km) {
      if (role !== "human") {
        return sendJson(res, 403, { ok: false, error: "payment commits require the human token; agent/operator/observer/loopback cannot decide" });
      }
      const body = await readBody(req);
      const decision = body.decision === "approve" || body.decision === "deny" ? body.decision : null;
      if (!decision) return sendJson(res, 400, { ok: false, error: 'body must include {"decision":"approve"|"deny"}' });
      const actor = `human:${HUMAN_ACTOR}`.slice(0, 60);
      const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 500) : null;
      const commitId = decodeURIComponent(km[1]);
      const result = await decidePaymentCommit(commitId, decision, { confirm: body.confirm, reason, actorId: actor });
      recordApprovalAudit({
        jobId: commitId, decision, actor, reason, channel: "payment-api",
        actorSource: "human-token",
        remoteAddr: req.socket?.remoteAddress || null,
        proxiedStatus: result.status, proxiedOk: result.status >= 200 && result.status < 300,
      });
      return sendJson(res, result.status, result.data, { "cache-control": "no-store" });
    }
    // UI: 资金最终提交确认页——只列 payment commits，不混入普通非支付任务。
    if (req.method === "GET" && url.pathname === "/payment") {
      if (role !== "human") {
        return sendText(res, 403, renderStatusPage(403, "权限不足", "资金确认页只能由持 human token 的人查看。"), "text/html; charset=utf-8", { "cache-control": "no-store" });
      }
      const sessionValue = parseCookies(req)[SESSION_COOKIE] || "";
      const csrfToken = csrfFor(sessionValue, req);
      const list = await listPaymentCommitsFromControl();
      return sendText(res, 200, renderPaymentConfirmPage({ csrfToken, paymentCommits: list.paymentCommits, sourceOk: list.sourceOk, phrase: PAYMENT_CONFIRM_PHRASE }), "text/html; charset=utf-8", { "cache-control": "no-store" });
    }
    km = url.pathname.match(/^\/ui\/payment-commits\/([^/]+)\/(approve|deny)$/);
    if (req.method === "POST" && km) {
      if (role !== "human") {
        return sendText(res, 403, renderStatusPage(403, "权限不足", "资金确认只能由持 human token 的人完成。"), "text/html; charset=utf-8", { "cache-control": "no-store" });
      }
      const form = await readForm(req);
      const sessionValue = parseCookies(req)[SESSION_COOKIE] || "";
      const expectedCsrf = csrfFor(sessionValue, req);
      if (!expectedCsrf || !safeEqual(form.csrf || "", expectedCsrf)) {
        return sendText(res, 403, renderStatusPage(403, "CSRF 校验失败", "资金确认未提交，commit 状态保持不变。"), "text/html; charset=utf-8", { "cache-control": "no-store" });
      }
      if (km[2] === "approve" && form.confirmation !== PAYMENT_CONFIRM_PHRASE) {
        return sendText(res, 400, renderStatusPage(400, "确认短语不完整", `必须准确输入 ${PAYMENT_CONFIRM_PHRASE}，资金确认未提交。`), "text/html; charset=utf-8", { "cache-control": "no-store" });
      }
      const actor = `human:${HUMAN_ACTOR}`.slice(0, 60);
      const reason = typeof form.reason === "string" && form.reason.trim() ? form.reason.trim().slice(0, 500) : null;
      const commitId = decodeURIComponent(km[1]);
      const result = await decidePaymentCommit(commitId, km[2], { confirm: form.confirmation, reason, actorId: actor });
      recordApprovalAudit({
        jobId: commitId, decision: km[2], actor, reason, channel: "payment-ui",
        actorSource: "human-session",
        remoteAddr: req.socket?.remoteAddress || null,
        proxiedStatus: result.status, proxiedOk: result.status >= 200 && result.status < 300,
      });
      const notice = result.status >= 200 && result.status < 300 ? (km[2] === "approve" ? "payment-approved" : "payment-denied") : "payment-failed";
      res.writeHead(303, { location: `/payment?notice=${notice}`, "cache-control": "no-store" });
      return res.end();
    }
    // ---------- Fleet / Screen / Operator API（abtop 远程通道）----------
    // observer 只读舰队与已采集截图；operator 本轮全面冻结（501）。
    if (req.method === "GET" && url.pathname === "/api/observer/v1/fleet") {
      return sendJson(res, 200, await buildFleet(), { "cache-control": "no-store" });
    }
    const screenMetaMatch = url.pathname.match(/^\/api\/observer\/v1\/screen\/([^/]+)\/meta$/);
    if (req.method === "GET" && screenMetaMatch) {
      return serveScreen(res, req, decodeURIComponent(screenMetaMatch[1]), true);
    }
    const screenMatch = url.pathname.match(/^\/api\/observer\/v1\/screen\/([^/]+)$/);
    if (req.method === "GET" && screenMatch) {
      return serveScreen(res, req, decodeURIComponent(screenMatch[1]), false);
    }
    // Operator 全面冻结：submit/session/job 查询一律 501。
    // 未来加固（强制幂等键、capability manifest 动态风险校验、任务归属、响应脱敏、审批、完整审计）后再整体启用。
    if (url.pathname.startsWith("/api/operator/")) {
      return sendJson(res, 501, { ok: false, error: "operator frozen; future hardening pending" });
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
