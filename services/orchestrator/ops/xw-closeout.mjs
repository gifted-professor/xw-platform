#!/usr/bin/env node
/**
 * xw task closeout / capability harvest v1 — Windows producer (minimal).
 *
 *   node ops/xw-closeout.mjs begin --mode <...> --actor <actor> [--goal <text>] [--brief <json>]
 *   node ops/xw-closeout.mjs step --run <runId> --input <explicit-step-json-path>
 *   node ops/xw-closeout.mjs close --run <runId> --input <explicit-json-path>
 *   node ops/xw-closeout.mjs self-test
 *
 * Never touches devices, jobs, sessions, control.db, deploy/reload, or root Skill.
 * Console: use console.log only (Windows bridge treats stderr as fatal).
 */

import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sealRecipeSpec } from "../scripts/lib/recipe-spec.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PRODUCER_NAME = "xw-closeout";
const PRODUCER_VERSION = "1";
const SCHEMA_ID = "xhs.task-closeout.v1";
const SCHEMA_VERSION = 1;
const CONTRACT_SHA256 =
  "c65448325d5a7a587a803908c78bf4c189926aec468999e646f2b10d5e64eba2";

const DEFAULT_OUTBOX = "C:\\Users\\Public\\xhs-registry\\outbox\\harvest";
const DEFAULT_WORK = "C:\\Users\\Public\\xhs-registry\\outbox\\work";
const DEFAULT_ROOTS = Object.freeze({
  "windows:xhs-registry": "C:\\Users\\Public\\xhs-registry",
  "windows:xhs-agent-runs": "C:\\Users\\Public\\xhs-agent-runs",
  "windows:routing": "C:\\Users\\Public\\xhs-routing-v1-1",
});

const MODES = new Set(["explorer", "runner", "repair", "engineering", "recover"]);
const STEP_KINDS = new Set(["script", "job", "decision", "blocker", "effect", "evidence"]);
const STEP_STATUSES = new Set(["ok", "fail", "blocked", "skipped", "unverified"]);
const SECRET_KEY_RE =
  /(token|password|secret|authorization|api[_-]?key|cookie|credential)/i;

/**
 * Enums / shapes from Mac contract SHA
 * c65448325d5a7a587a803908c78bf4c189926aec468999e646f2b10d5e64eba2
 * (contracts/task-closeout.v1.schema.json). No custom canonical sets.
 * Limited aliases only map INTO these contract enums; unmapped → CLOSEOUT_FAILED.
 */
const CHECK_KINDS = new Set(["test", "check", "scope_guard", "secret_scan", "other"]);
const CHECK_KIND_ALIASES = Object.freeze({
  e2e: "test",
  preflight: "check",
  observe: "other",
  observation: "other",
});
const CHECK_STATUSES = new Set(["pass", "fail", "not_run", "unverified"]);
const ARTIFACT_KINDS = new Set([
  "screenshot",
  "ui_dump",
  "log",
  "table",
  "attachment",
  "manifest",
  "source",
  "receipt",
  "recipe_spec",
  "other",
]);
const ARTIFACT_KIND_ALIASES = Object.freeze({
  image: "screenshot",
  img: "screenshot",
  data: "other",
  note: "other",
  json: "other",
  text: "other",
});
const RECIPE_CANDIDATE_EXTRA_KEYS = Object.freeze([
  "recipeSpec",
  "spec",
  "capabilityId",
  "appId",
  "recipeId",
]);
const CLAIM_STATUSES = new Set(["proven", "contradicted", "unverified"]);
const CLAIM_STATUS_ALIASES = Object.freeze({
  supported: "proven",
});
const RUNTIME_KEYS = Object.freeze(["deployment", "reload", "serve"]);
const RUNTIME_STATUSES = new Set([
  "performed",
  "not_performed",
  "not_applicable",
  "unverified",
]);
const DEVICE_REF_KEYS = Object.freeze([
  "devices",
  "runs",
  "jobs",
  "sessions",
  "leases",
  "evidenceRefs",
]);
const CANDIDATE_KINDS = new Set([
  "recipe",
  "capability",
  "skill",
  "knowledge",
  "repair",
  "debt",
]);
const CANDIDATE_BASES = new Set([
  "repeatable_workflow",
  "verified_pitfall",
  "source_defect",
  "evidence_gap",
  "temporary_asset",
]);
const CANDIDATE_STATUSES = new Set([
  "proposed",
  "promotion_required",
  "blocked",
  "unverified",
]);
const CLOSURE_STATUSES = new Set(["completed", "partial", "blocked", "unverified"]);
const CHANGED_FILE_STATUSES = new Set([
  "added",
  "modified",
  "deleted",
  "renamed",
  "untracked",
  "unknown",
]);
const WORKTREE_STATUSES = new Set(["clean", "dirty", "not_applicable", "unverified"]);
const ARTIFACT_AVAIL = new Set(["present", "missing", "unverified"]);
const EFFECT_KINDS = new Set([
  "feishu_upload",
  "draft_saved",
  "content_published",
  "file_written",
  "external_api",
  "payment",
  "other",
]);
const EFFECT_STATUSES = new Set(["occurred", "not_occurred", "partial", "unverified"]);
const MACHINE_PLATFORMS = new Set(["windows", "macos", "linux", "other"]);
const DEBT_SEVERITIES = new Set(["low", "medium", "high"]);
const DEBT_CODE_RE = /^[A-Z0-9_]+$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const GIT_HASH_RE = /^[0-9a-f]{40}$/;
const RUN_ID_RE = /^run_[A-Za-z0-9._-]+$/;
const DATE_TIME_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function sha256Bytes(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function sha256File(path) {
  return sha256Bytes(readFileSync(path));
}

function scriptSha256() {
  return sha256File(SCRIPT_PATH);
}

function nowIso() {
  return new Date().toISOString();
}

function fail(msg, code = 2) {
  console.log(`CLOSEOUT_FAILED ${msg}`);
  process.exit(code);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--") && i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      out[a.slice(2)] = argv[++i];
    } else if (a.startsWith("--")) {
      out[a.slice(2)] = true;
    } else {
      out._.push(a);
    }
  }
  return out;
}

function stableStringify(value) {
  return JSON.stringify(sortKeys(value)) + "\n";
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = sortKeys(value[k]);
    return out;
  }
  return value;
}

function isSafeRelativePath(p) {
  if (typeof p !== "string" || !p) return false;
  if (/^[A-Za-z]:/.test(p)) return false;
  if (p.startsWith("/") || p.startsWith("\\")) return false;
  if (/[\u0000-\u001f]/.test(p)) return false;
  const norm = normalize(p).replace(/\\/g, "/");
  if (norm === ".." || norm.startsWith("../") || norm.includes("/../")) return false;
  if (norm.split("/").some((part) => part === "..")) return false;
  return true;
}

function loadRootMap() {
  const map = { ...DEFAULT_ROOTS };
  const raw = process.env.XW_CLOSEOUT_ROOTS_JSON;
  if (raw) {
    let extra;
    try {
      extra = JSON.parse(raw);
    } catch {
      fail("XW_CLOSEOUT_ROOTS_JSON is not valid JSON");
    }
    if (!extra || typeof extra !== "object" || Array.isArray(extra)) {
      fail("XW_CLOSEOUT_ROOTS_JSON must be an object");
    }
    for (const [k, v] of Object.entries(extra)) {
      if (typeof k !== "string" || typeof v !== "string" || !k || !v) {
        fail(`invalid root map entry: ${k}`);
      }
      map[k] = v;
    }
  }
  return map;
}

function outboxRoot() {
  return process.env.XW_CLOSEOUT_OUTBOX || DEFAULT_OUTBOX;
}

function workRoot() {
  return process.env.XW_CLOSEOUT_WORK || DEFAULT_WORK;
}

function parseJsonBytes(buf) {
  let text = Buffer.isBuffer(buf) ? buf.toString("utf8") : String(buf);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return JSON.parse(text);
}

function readJsonFileBom(path) {
  return parseJsonBytes(readFileSync(path));
}

function workArtifactRelPath(runId, name) {
  return `outbox/work/${runId}/${name}`.replace(/\\/g, "/");
}

function pathUnderRoot(candidateAbs, rootReal) {
  const rootPrefix = rootReal.endsWith(sep) ? rootReal : rootReal + sep;
  const c = candidateAbs.toLowerCase();
  const r = rootReal.toLowerCase();
  const p = rootPrefix.toLowerCase();
  return c === r || c.startsWith(p);
}

function resolveWorkRootReal() {
  const root = workRoot();
  mkdirSync(root, { recursive: true });
  let st;
  try {
    st = lstatSync(root);
  } catch (err) {
    fail(`work root unreadable: ${err.message}`);
  }
  if (st.isSymbolicLink()) fail("work root is a symlink");
  if (!st.isDirectory()) fail("work root is not a directory");
  try {
    return realpathSync(root);
  } catch (err) {
    fail(`work root realpath failed: ${err.message}`);
  }
}

function resolveRunWorkDir(runId, { create = false, allowMissing = false } = {}) {
  if (!/^run_[A-Za-z0-9._-]+$/.test(runId)) fail(`invalid runId: ${runId}`);
  if (runId.includes("..") || runId.includes("/") || runId.includes("\\")) {
    fail(`invalid runId path chars: ${runId}`);
  }
  const rootReal = resolveWorkRootReal();
  const joined = resolve(rootReal, runId);
  if (!pathUnderRoot(joined, rootReal)) fail("run work dir escapes work root");
  if (create) mkdirSync(joined, { recursive: true });
  if (!existsSync(joined)) {
    if (allowMissing) return { rootReal, dir: joined, missing: true };
    fail(`work ledger missing for ${runId}; run begin first`);
  }
  const st = lstatSync(joined);
  if (st.isSymbolicLink()) fail("run work dir is a symlink");
  if (!st.isDirectory()) fail("run work dir is not a directory");
  let dirReal;
  try {
    dirReal = realpathSync(joined);
  } catch (err) {
    fail(`run work dir realpath failed: ${err.message}`);
  }
  if (!pathUnderRoot(dirReal, rootReal)) fail("run work dir realpath escapes work root");
  return { rootReal, dir: joined, dirReal, missing: false };
}

function assertRegularLedgerFile(absPath, rootReal, label) {
  if (!existsSync(absPath)) return null;
  const st = lstatSync(absPath);
  if (st.isSymbolicLink()) fail(`${label} is a symlink`);
  if (!st.isFile()) fail(`${label} is not a regular file`);
  let real;
  try {
    real = realpathSync(absPath);
  } catch (err) {
    fail(`${label} realpath failed: ${err.message}`);
  }
  if (!pathUnderRoot(real, rootReal)) fail(`${label} realpath escapes work root`);
  return { st, real };
}

function demoteCompleted(closure, reason) {
  const next = { ...(closure || {}) };
  if (next.status === "completed") next.status = "unverified";
  const blockers = Array.isArray(next.blockers) ? [...next.blockers] : [];
  if (!blockers.includes(reason)) blockers.push(reason);
  next.blockers = blockers;
  const remaining = Array.isArray(next.remainingWork) ? [...next.remainingWork] : [];
  if (!remaining.includes("fix work ledger")) remaining.push("fix work ledger");
  next.remainingWork = remaining;
  return next;
}

function parseAndValidateStepsJournal(stepsAbs) {
  const text = readFileSync(stepsAbs, "utf8");
  const lines = text.split(/\r?\n/);
  const seen = new Set();
  let nonEmpty = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    nonEmpty += 1;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (err) {
      return { ok: false, code: "STEPS_JOURNAL_INVALID", reason: `line ${i + 1} is not valid JSON: ${err.message}` };
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
      return { ok: false, code: "STEPS_JOURNAL_INVALID", reason: `line ${i + 1} is not a JSON object` };
    }
    for (const key of ["stepId", "kind", "title", "status", "ts"]) {
      if (typeof obj[key] !== "string" || !obj[key].trim()) {
        return {
          ok: false,
          code: "STEPS_JOURNAL_INVALID",
          reason: `line ${i + 1} missing or invalid ${key}`,
        };
      }
    }
    if (!STEP_KINDS.has(obj.kind)) {
      return { ok: false, code: "STEPS_JOURNAL_INVALID", reason: `line ${i + 1} invalid kind` };
    }
    if (!STEP_STATUSES.has(obj.status)) {
      return { ok: false, code: "STEPS_JOURNAL_INVALID", reason: `line ${i + 1} invalid status` };
    }
    if (seen.has(obj.stepId)) {
      return {
        ok: false,
        code: "STEPS_JOURNAL_INVALID",
        reason: `duplicate stepId ${obj.stepId}`,
      };
    }
    seen.add(obj.stepId);
  }
  if (nonEmpty === 0) {
    return { ok: false, code: "STEPS_JOURNAL_MISSING", reason: "steps.jsonl has no entries" };
  }
  return { ok: true, count: nonEmpty };
}

function attachWorkLedger(runId, closeout) {
  const resolved = resolveRunWorkDir(runId, { create: false, allowMissing: true });
  const debts = Array.isArray(closeout.evidenceDebt) ? [...closeout.evidenceDebt] : [];
  const artifacts = Array.isArray(closeout.artifacts) ? [...closeout.artifacts] : [];
  let taskOk = false;
  let stepsOk = false;
  let closure = { ...(closeout.closure || {}) };

  if (resolved.missing) {
    debts.push({
      debtId: `debt_task_missing_${sha256Bytes(Buffer.from(runId)).slice(0, 12)}`,
      code: "TASK_BRIEF_MISSING",
      severity: "high",
      summary: `Missing work ledger task.json for ${runId}`,
      evidenceRefs: [],
    });
    debts.push({
      debtId: `debt_steps_missing_${sha256Bytes(Buffer.from(runId)).slice(0, 12)}`,
      code: "STEPS_JOURNAL_MISSING",
      severity: "high",
      summary: `Missing work ledger steps.jsonl for ${runId}`,
      evidenceRefs: [],
    });
    closure = demoteCompleted(closure, "work ledger incomplete");
    closeout.artifacts = artifacts;
    closeout.evidenceDebt = debts;
    closeout.closure = closure;
    return closeout;
  }

  const { rootReal, dir } = resolved;
  const taskAbs = join(dir, "task.json");
  const stepsAbs = join(dir, "steps.jsonl");

  const taskMeta = assertRegularLedgerFile(taskAbs, rootReal, "task.json");
  if (!taskMeta) {
    debts.push({
      debtId: `debt_task_missing_${sha256Bytes(Buffer.from(runId)).slice(0, 12)}`,
      code: "TASK_BRIEF_MISSING",
      severity: "high",
      summary: `Missing work ledger task.json for ${runId}`,
      evidenceRefs: [],
    });
  } else {
    try {
      const task = readJsonFileBom(taskAbs);
      const identityOk =
        task &&
        typeof task.goal === "string" &&
        task.goal.trim() &&
        task.runId === runId &&
        task.taskId === closeout.taskId &&
        task.actor === closeout.actor &&
        task.mode === closeout.mode;
      if (!identityOk) {
        debts.push({
          debtId: `debt_task_invalid_${sha256Bytes(Buffer.from(runId)).slice(0, 12)}`,
          code: "TASK_BRIEF_INVALID",
          severity: "high",
          summary: `task.json identity mismatch or missing goal for ${runId}`,
          evidenceRefs: [`work_task_${runId}`],
        });
        closure = demoteCompleted(closure, "work ledger invalid");
      } else {
        taskOk = true;
        artifacts.push({
          artifactId: `work_task_${runId}`,
          kind: "other",
          rootRef: "windows:xhs-registry",
          path: workArtifactRelPath(runId, "task.json"),
          sha256: sha256File(taskAbs),
          bytes: taskMeta.st.size,
          availability: "present",
          redacted: false,
        });
      }
    } catch (err) {
      debts.push({
        debtId: `debt_task_bad_${sha256Bytes(Buffer.from(String(err.message))).slice(0, 12)}`,
        code: "TASK_BRIEF_INVALID",
        severity: "high",
        summary: `task.json unreadable for ${runId}: ${err.message}`,
        evidenceRefs: [],
      });
      closure = demoteCompleted(closure, "work ledger invalid");
    }
  }

  const stepsMeta = assertRegularLedgerFile(stepsAbs, rootReal, "steps.jsonl");
  if (!stepsMeta) {
    debts.push({
      debtId: `debt_steps_missing_${sha256Bytes(Buffer.from(runId)).slice(0, 12)}`,
      code: "STEPS_JOURNAL_MISSING",
      severity: "high",
      summary: `Missing work ledger steps.jsonl for ${runId}`,
      evidenceRefs: [],
    });
  } else {
    const parsed = parseAndValidateStepsJournal(stepsAbs);
    if (!parsed.ok) {
      debts.push({
        debtId: `debt_steps_${parsed.code.toLowerCase()}_${sha256Bytes(Buffer.from(parsed.reason)).slice(0, 12)}`,
        code: parsed.code,
        severity: "high",
        summary: parsed.reason,
        evidenceRefs: [`work_steps_${runId}`],
      });
      closure = demoteCompleted(closure, "work ledger invalid");
    } else {
      stepsOk = true;
      artifacts.push({
        artifactId: `work_steps_${runId}`,
        kind: "log",
        rootRef: "windows:xhs-registry",
        path: workArtifactRelPath(runId, "steps.jsonl"),
        sha256: sha256File(stepsAbs),
        bytes: stepsMeta.st.size,
        availability: "present",
        redacted: false,
      });
    }
  }

  if ((!taskOk || !stepsOk) && closure.status === "completed") {
    closure = demoteCompleted(closure, "work ledger incomplete");
  }

  closeout.artifacts = artifacts;
  closeout.evidenceDebt = debts;
  closeout.closure = closure;
  return closeout;
}

function resolveUnderRoot(rootAbs, relPath) {
  if (!isSafeRelativePath(relPath)) {
    throw new Error(`unsafe relative path: ${relPath}`);
  }
  const rootReal = realpathSync(rootAbs);
  const joined = resolve(rootReal, relPath);
  const relCheck = normalize(relPath).replace(/\\/g, "/");
  if (relCheck.includes("..")) throw new Error(`path traversal: ${relPath}`);
  // Ensure joined stays under root (case-insensitive on Windows).
  const rootPrefix = rootReal.endsWith(sep) ? rootReal : rootReal + sep;
  const joinedNorm = joined.toLowerCase();
  const rootNorm = rootPrefix.toLowerCase();
  if (joinedNorm !== rootReal.toLowerCase() && !joinedNorm.startsWith(rootNorm)) {
    throw new Error(`path escapes root: ${relPath}`);
  }
  return joined;
}

function assertNotSymlinkEscape(absPath, rootAbs) {
  const st = lstatSync(absPath);
  if (st.isSymbolicLink()) {
    const target = realpathSync(absPath);
    const rootReal = realpathSync(rootAbs);
    const rootPrefix = rootReal.endsWith(sep) ? rootReal : rootReal + sep;
    if (
      target.toLowerCase() !== rootReal.toLowerCase() &&
      !target.toLowerCase().startsWith(rootPrefix.toLowerCase())
    ) {
      throw new Error(`symlink escapes root: ${absPath}`);
    }
  }
}

function redactSecrets(value, path = "") {
  if (Array.isArray(value)) {
    return value.map((v, i) => redactSecrets(v, `${path}[${i}]`));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY_RE.test(k) && typeof v === "string") {
        out[k] = "[REDACTED]";
      } else {
        out[k] = redactSecrets(v, path ? `${path}.${k}` : k);
      }
    }
    return out;
  }
  return value;
}

function runGit(repoRoot, args) {
  try {
    return execFileSync("git", ["-C", repoRoot, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }).trim();
  } catch (err) {
    const msg = err?.stderr?.toString?.() || err?.message || String(err);
    throw new Error(msg.trim() || "git failed");
  }
}

function observeGitSource(src, debts) {
  const repo = src.repo;
  const root = src.repoRoot;
  const normHash = (v) => {
    if (v == null) return null;
    if (typeof v !== "string") return v;
    const lower = v.toLowerCase();
    return GIT_HASH_RE.test(lower) ? lower : v;
  };
  if (!root) {
    return {
      repo,
      branch: src.branch ?? null,
      head: normHash(src.head ?? null),
      worktree: WORKTREE_STATUSES.has(src.worktree) ? src.worktree : "unverified",
      changedFiles: Array.isArray(src.changedFiles) ? src.changedFiles : [],
      commit: normHash(src.commit ?? null),
      ahead: src.ahead ?? null,
      behind: src.behind ?? null,
      pushed: src.pushed ?? null,
    };
  }
  if (!existsSync(root)) {
    debts.push({
      debtId: `debt_missing_repo_${sha256Bytes(Buffer.from(repo)).slice(0, 12)}`,
      code: "SOURCE_ROOT_MISSING",
      severity: "high",
      summary: `Listed source root missing: ${repo}`,
      evidenceRefs: [],
    });
    return {
      repo,
      branch: null,
      head: null,
      worktree: "unverified",
      changedFiles: [],
      commit: null,
      ahead: null,
      behind: null,
      pushed: null,
    };
  }
  const gitDir = join(root, ".git");
  if (!existsSync(gitDir)) {
    return {
      repo,
      branch: null,
      head: null,
      worktree: "not_applicable",
      changedFiles: Array.isArray(src.changedFiles) ? src.changedFiles : [],
      commit: null,
      ahead: null,
      behind: null,
      pushed: null,
    };
  }
  try {
    const head = runGit(root, ["rev-parse", "HEAD"]);
    let branch = null;
    try {
      branch = runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
      if (branch === "HEAD") branch = null;
    } catch {
      branch = null;
    }
    const statusPorcelain = runGit(root, ["status", "--porcelain"]);
    const worktree = statusPorcelain ? "dirty" : "clean";
    const changedFiles = [];
    if (statusPorcelain) {
      for (const line of statusPorcelain.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const code = line.slice(0, 2);
        let filePath = line.slice(3).trim();
        if (filePath.includes(" -> ")) filePath = filePath.split(" -> ").pop();
        if (!isSafeRelativePath(filePath.replace(/\\/g, "/"))) continue;
        let status = "unknown";
        if (code.includes("A") || code === "??") status = code === "??" ? "untracked" : "added";
        else if (code.includes("D")) status = "deleted";
        else if (code.includes("R")) status = "renamed";
        else if (code.includes("M") || code.includes(" ")) status = "modified";
        changedFiles.push({ path: filePath.replace(/\\/g, "/"), status, sha256: null });
      }
    }
    let ahead = null;
    let behind = null;
    let pushed = null;
    try {
      const upstream = runGit(root, ["rev-parse", "--abbrev-ref", "@{upstream}"]);
      if (upstream) {
        const counts = runGit(root, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]);
        const [a, b] = counts.split(/\s+/).map((n) => Number(n));
        ahead = Number.isFinite(a) ? a : null;
        behind = Number.isFinite(b) ? b : null;
        pushed = ahead === 0;
      }
    } catch {
      // no upstream
      pushed = false;
      ahead = null;
      behind = null;
    }
    return {
      repo,
      branch,
      head: /^[0-9a-f]{40}$/.test(head) ? head : null,
      worktree,
      changedFiles,
      commit: /^[0-9a-f]{40}$/.test(head) ? head : null,
      ahead,
      behind,
      pushed,
    };
  } catch (err) {
    debts.push({
      debtId: `debt_git_${sha256Bytes(Buffer.from(String(err.message))).slice(0, 12)}`,
      code: "GIT_OBSERVE_FAILED",
      severity: "medium",
      summary: `Git observe failed for ${repo}: ${err.message}`,
      evidenceRefs: [],
    });
    return {
      repo,
      branch: null,
      head: null,
      worktree: "unverified",
      changedFiles: [],
      commit: null,
      ahead: null,
      behind: null,
      pushed: null,
    };
  }
}

function materializeArtifacts(list, rootMap, debts) {
  const out = [];
  for (const raw of list || []) {
    const artifactId = raw.artifactId;
    const kind = raw.kind;
    const rootRef = raw.rootRef;
    const path = raw.path;
    const redacted = Boolean(raw.redacted);
    if (!artifactId || !kind || !rootRef || !path) {
      fail(`artifact missing required fields: ${JSON.stringify(raw)}`);
    }
    if (!isSafeRelativePath(path)) {
      fail(`artifact path not safe: ${path}`);
    }
    if (!(rootRef in rootMap)) {
      fail(`unknown artifact rootRef: ${rootRef}`);
    }
    const rootAbs = rootMap[rootRef];
    let availability = "missing";
    let sha = null;
    let bytes = null;
    try {
      if (!existsSync(rootAbs)) {
        debts.push({
          debtId: `debt_root_${sha256Bytes(Buffer.from(rootRef)).slice(0, 12)}`,
          code: "ARTIFACT_ROOT_MISSING",
          severity: "high",
          summary: `Artifact root missing for ${rootRef}`,
          evidenceRefs: [artifactId],
        });
      } else {
        const abs = resolveUnderRoot(rootAbs, path);
        if (!existsSync(abs)) {
          availability = "missing";
          debts.push({
            debtId: `debt_art_miss_${sha256Bytes(Buffer.from(artifactId)).slice(0, 12)}`,
            code: "ARTIFACT_MISSING",
            severity: "medium",
            summary: `Artifact missing: ${rootRef}:${path}`,
            evidenceRefs: [artifactId],
          });
        } else {
          assertNotSymlinkEscape(abs, rootAbs);
          const st = lstatSync(abs);
          if (st.isDirectory()) {
            fail(`artifact path is a directory (no recursion): ${path}`);
          }
          // If expected hash provided and mismatches → conflict fail closed
          const computed = sha256File(abs);
          if (raw.sha256 && raw.sha256 !== computed) {
            fail(
              `artifact hash conflict for ${artifactId}: expected ${raw.sha256} got ${computed}`,
            );
          }
          // Present artifacts keep sha256/bytes even when redacted=true.
          // Never copy attachment bytes into the bundle — only hash metadata.
          sha = computed;
          bytes = st.size;
          availability = "present";
        }
      }
    } catch (err) {
      fail(`artifact resolve failed for ${artifactId}: ${err.message}`);
    }
    out.push({
      artifactId,
      kind,
      rootRef,
      path: path.replace(/\\/g, "/"),
      sha256: sha,
      bytes,
      availability,
      redacted,
    });
  }
  return out;
}

function requireInputFields(input) {
  const need = [
    "taskId",
    "actor",
    "machine",
    "mode",
    "startedAt",
    "sources",
    "checks",
    "runtime",
    "deviceRefs",
    "effects",
    "artifacts",
    "candidates",
    "closure",
    "claims",
    "evidenceDebt",
    "acceptanceConditions",
  ];
  for (const k of need) {
    if (!(k in input)) fail(`input missing field: ${k}`);
  }
  if (!MODES.has(input.mode)) fail(`invalid mode: ${input.mode}`);
  if (!input.machine?.id || !input.machine?.platform) fail("input.machine incomplete");
  if (!Array.isArray(input.sources) || input.sources.length < 1) {
    fail("input.sources must be a non-empty array");
  }
  if (!input.closure?.status) fail("input.closure.status required");
}

function mapEnum(value, allowed, aliases, label) {
  if (typeof value !== "string" || !value) fail(`${label} must be a non-empty string`);
  const mapped =
    aliases && Object.prototype.hasOwnProperty.call(aliases, value) ? aliases[value] : value;
  if (!allowed.has(mapped)) {
    fail(`${label} invalid enum '${value}' (contract: ${[...allowed].join("|")})`);
  }
  return mapped;
}

function assertNoExtraKeys(obj, allowedKeys, label) {
  for (const k of Object.keys(obj)) {
    if (!allowedKeys.has(k)) fail(`${label} additionalProperties not allowed: ${k}`);
  }
}

function isDateTime(value) {
  if (typeof value !== "string" || !DATE_TIME_RE.test(value)) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms);
}

function requireDateTime(value, label) {
  if (!isDateTime(value)) fail(`${label} must be date-time`);
  return value;
}

function requireDateTimeOrNull(value, label) {
  if (value == null) return null;
  return requireDateTime(value, label);
}

function requireText(value, label) {
  if (typeof value !== "string" || value.length < 1) fail(`${label} must be non-empty string`);
  return value;
}

function requireIntegerOrNull(value, label, { minimum = null } = {}) {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    fail(`${label} must be integer or null`);
  }
  if (minimum != null && value < minimum) fail(`${label} must be >= ${minimum}`);
  return value;
}

function requireInteger(value, label, { minimum = null } = {}) {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    fail(`${label} must be integer`);
  }
  if (minimum != null && value < minimum) fail(`${label} must be >= ${minimum}`);
  return value;
}

function requireSha256OrNull(value, label) {
  if (value == null) return null;
  if (typeof value !== "string") fail(`${label} must be sha256 or null`);
  const lower = value.toLowerCase();
  if (!SHA256_RE.test(lower)) fail(`${label} must match sha256`);
  return lower;
}

function normalizeChangedFiles(list, label) {
  if (list == null) return [];
  if (!Array.isArray(list)) fail(`${label} must be an array`);
  return list.map((item, i) => {
    const at = `${label}[${i}]`;
    if (typeof item === "string") {
      const path = item.replace(/\\/g, "/");
      if (!isSafeRelativePath(path)) fail(`${at} path not safe: ${item}`);
      return { path, status: "unknown", sha256: null };
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      fail(`${at} must be a string path or {path,status,sha256?}`);
    }
    assertNoExtraKeys(item, new Set(["path", "status", "sha256"]), at);
    if (typeof item.path !== "string" || !item.path) fail(`${at}.path required`);
    const path = item.path.replace(/\\/g, "/");
    if (!isSafeRelativePath(path)) fail(`${at}.path not safe: ${item.path}`);
    let status = item.status == null || item.status === "" ? "unknown" : item.status;
    if (typeof status !== "string" || !CHANGED_FILE_STATUSES.has(status)) {
      fail(`${at}.status invalid: ${status}`);
    }
    return { path, status, sha256: requireSha256OrNull(item.sha256 ?? null, `${at}.sha256`) };
  });
}

function normalizeStringList(list, label, { allowTextObject = true } = {}) {
  if (!Array.isArray(list)) fail(`${label} must be an array`);
  const out = list.map((item, i) => {
    const at = `${label}[${i}]`;
    if (typeof item === "string") {
      if (!item) fail(`${at} must be non-empty string`);
      return item;
    }
    if (
      allowTextObject &&
      item &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      typeof item.text === "string"
    ) {
      if (!item.text) fail(`${at}.text must be non-empty`);
      return item.text;
    }
    fail(`${at} must be a string`);
  });
  const seen = new Set();
  for (let i = 0; i < out.length; i++) {
    if (seen.has(out[i])) fail(`${label} uniqueItems violated: ${out[i]}`);
    seen.add(out[i]);
  }
  return out;
}

function normalizeIdList(list, label) {
  if (list == null) return [];
  if (typeof list === "string") {
    if (!list) fail(`${label} must be non-empty string when scalar`);
    return [list];
  }
  if (!Array.isArray(list)) fail(`${label} must be an array of strings`);
  return normalizeStringList(list, label, { allowTextObject: false });
}

function normalizePayment(payment, label) {
  if (payment == null) return paymentNone();
  if (typeof payment !== "object" || Array.isArray(payment)) {
    fail(`${label} must be an object`);
  }
  assertNoExtraKeys(payment, new Set(["involved", "transportCount", "finalCommit"]), label);
  if (
    !("involved" in payment) ||
    !("transportCount" in payment) ||
    !("finalCommit" in payment)
  ) {
    fail(`${label} must include involved/transportCount/finalCommit`);
  }
  if (typeof payment.involved !== "boolean") fail(`${label}.involved must be boolean`);
  if (typeof payment.finalCommit !== "boolean") fail(`${label}.finalCommit must be boolean`);
  return {
    involved: payment.involved,
    transportCount: requireInteger(payment.transportCount, `${label}.transportCount`, {
      minimum: 0,
    }),
    finalCommit: payment.finalCommit,
  };
}

function normalizeRuntimeSlot(slot, label) {
  if (slot == null) {
    return { status: "not_performed", observedAt: null, evidenceRefs: [] };
  }
  if (typeof slot !== "object" || Array.isArray(slot)) fail(`${label} must be an object`);
  assertNoExtraKeys(slot, new Set(["status", "observedAt", "evidenceRefs"]), label);
  const status = mapEnum(slot.status, RUNTIME_STATUSES, null, `${label}.status`);
  return {
    status,
    observedAt: requireDateTimeOrNull(slot.observedAt ?? null, `${label}.observedAt`),
    evidenceRefs: normalizeIdList(slot.evidenceRefs, `${label}.evidenceRefs`),
  };
}

function normalizeRuntime(runtime, label = "runtime") {
  if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) {
    fail(`${label} must be an object`);
  }
  const out = {};
  for (const key of RUNTIME_KEYS) {
    out[key] = normalizeRuntimeSlot(runtime[key], `${label}.${key}`);
  }
  return out;
}

function normalizeDeviceRefs(refs, label = "deviceRefs") {
  if (!refs || typeof refs !== "object" || Array.isArray(refs)) {
    fail(`${label} must be an object`);
  }
  const out = {};
  for (const key of DEVICE_REF_KEYS) {
    out[key] = normalizeIdList(refs[key], `${label}.${key}`);
  }
  return out;
}

function normalizeCheck(raw, i) {
  const label = `checks[${i}]`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail(`${label} must be an object`);
  assertNoExtraKeys(
    raw,
    new Set(["id", "kind", "status", "exitCode", "observedAt", "evidenceRefs"]),
    label,
  );
  return {
    id: requireText(raw.id, `${label}.id`),
    kind: mapEnum(raw.kind, CHECK_KINDS, CHECK_KIND_ALIASES, `${label}.kind`),
    status: mapEnum(raw.status, CHECK_STATUSES, null, `${label}.status`),
    exitCode: requireIntegerOrNull(raw.exitCode ?? null, `${label}.exitCode`),
    observedAt: requireDateTimeOrNull(raw.observedAt ?? null, `${label}.observedAt`),
    evidenceRefs: normalizeIdList(raw.evidenceRefs, `${label}.evidenceRefs`),
  };
}

function normalizeArtifactInput(raw, i) {
  const label = `artifacts[${i}]`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail(`${label} must be an object`);
  assertNoExtraKeys(
    raw,
    new Set([
      "artifactId",
      "kind",
      "rootRef",
      "path",
      "sha256",
      "bytes",
      "availability",
      "redacted",
    ]),
    label,
  );
  const kind = mapEnum(raw.kind, ARTIFACT_KINDS, ARTIFACT_KIND_ALIASES, `${label}.kind`);
  return {
    artifactId: requireText(raw.artifactId, `${label}.artifactId`),
    kind,
    rootRef: requireText(raw.rootRef, `${label}.rootRef`),
    path: requireText(raw.path, `${label}.path`),
    redacted: Boolean(raw.redacted),
    sha256:
      raw.sha256 === undefined ? undefined : requireSha256OrNull(raw.sha256, `${label}.sha256`),
  };
}

function normalizeClaim(raw, i) {
  const label = `claims[${i}]`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail(`${label} must be an object`);
  assertNoExtraKeys(raw, new Set(["claimId", "narrative", "status", "evidenceRefs"]), label);
  return {
    claimId: requireText(raw.claimId, `${label}.claimId`),
    narrative: requireText(raw.narrative, `${label}.narrative`),
    status: mapEnum(raw.status, CLAIM_STATUSES, CLAIM_STATUS_ALIASES, `${label}.status`),
    evidenceRefs: normalizeIdList(raw.evidenceRefs, `${label}.evidenceRefs`),
  };
}

function normalizeEffect(raw, i) {
  const label = `effects[${i}]`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail(`${label} must be an object`);
  assertNoExtraKeys(
    raw,
    new Set(["effectId", "kind", "status", "quantity", "payment", "evidenceRefs"]),
    label,
  );
  return {
    effectId: requireText(raw.effectId, `${label}.effectId`),
    kind: mapEnum(raw.kind, EFFECT_KINDS, null, `${label}.kind`),
    status: mapEnum(raw.status, EFFECT_STATUSES, null, `${label}.status`),
    quantity: requireIntegerOrNull(raw.quantity ?? null, `${label}.quantity`, { minimum: 0 }),
    payment: normalizePayment(raw.payment, `${label}.payment`),
    evidenceRefs: normalizeIdList(raw.evidenceRefs, `${label}.evidenceRefs`),
  };
}

function normalizeCandidate(raw, i) {
  const label = `candidates[${i}]`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail(`${label} must be an object`);
  assertNoExtraKeys(
    raw,
    new Set([
      "candidateId",
      "kind",
      "title",
      "basis",
      "status",
      "evidenceRefs",
      "acceptanceConditions",
      ...RECIPE_CANDIDATE_EXTRA_KEYS,
    ]),
    label,
  );
  return {
    candidateId: requireText(raw.candidateId, `${label}.candidateId`),
    kind: mapEnum(raw.kind, CANDIDATE_KINDS, null, `${label}.kind`),
    title: requireText(raw.title, `${label}.title`),
    basis: mapEnum(raw.basis, CANDIDATE_BASES, null, `${label}.basis`),
    status: mapEnum(raw.status, CANDIDATE_STATUSES, null, `${label}.status`),
    evidenceRefs: normalizeIdList(raw.evidenceRefs, `${label}.evidenceRefs`),
    acceptanceConditions: normalizeStringList(
      raw.acceptanceConditions == null ? [] : raw.acceptanceConditions,
      `${label}.acceptanceConditions`,
    ),
  };
}

/**
 * Capture optional recipe fields from raw close input (stripped from sealed candidate).
 * @returns {Map<string, object>}
 */
function extractRecipeCandidateExtras(input) {
  const map = new Map();
  const list = Array.isArray(input?.candidates) ? input.candidates : [];
  for (const c of list) {
    if (!c || typeof c !== "object" || c.kind !== "recipe") continue;
    const candidateId = typeof c.candidateId === "string" ? c.candidateId : null;
    if (!candidateId) continue;
    map.set(candidateId, {
      recipeSpec: c.recipeSpec && typeof c.recipeSpec === "object" ? c.recipeSpec : null,
      spec: c.spec && typeof c.spec === "object" ? c.spec : null,
      capabilityId: typeof c.capabilityId === "string" ? c.capabilityId : null,
      appId: typeof c.appId === "string" ? c.appId : null,
      recipeId: typeof c.recipeId === "string" ? c.recipeId : null,
    });
  }
  return map;
}

function isRecipeSpecShape(spec) {
  return Boolean(
    spec &&
      typeof spec === "object" &&
      !Array.isArray(spec) &&
      typeof spec.recipeId === "string" &&
      spec.recipeId.trim() &&
      spec.executor &&
      typeof spec.executor === "object",
  );
}

function synthesizeRecipeSpecFromCandidate(candidate, extras, runId) {
  const recipeId = String(
    extras?.recipeId ||
      candidate.candidateId ||
      "",
  )
    .replace(/^cand_/, "recipe_")
    .replace(/[^A-Za-z0-9._-]/g, "_");
  if (!recipeId) fail(`cannot derive recipeId for candidate ${candidate.candidateId}`);
  return {
    schemaId: "xhs.recipe-candidate.v1",
    recipeId,
    revision: 1,
    appId: extras?.appId || "unknown",
    intentAliases: [candidate.title || recipeId].filter(Boolean),
    inputSchema: { type: "object", properties: {}, required: [] },
    executor: {
      capabilityId: extras?.capabilityId || "unknown.pending",
      paramsTemplate: {},
    },
    preconditions: [],
    assertions: Array.isArray(candidate.acceptanceConditions)
      ? candidate.acceptanceConditions
      : [],
    restoration: { required: false },
    validityEnvelope: {},
    riskCeiling: "R1",
    originRunId: runId,
    evidenceHashes: Array.isArray(candidate.evidenceRefs) ? candidate.evidenceRefs : [],
  };
}

/**
 * Seal recipe candidates into work-ledger recipe-specs + closeout artifacts.
 * Also returns harvest-bundle file payloads for writeAtomicBundle.
 *
 * @returns {{ path: string, bytes: Buffer, sha256: string }[]}
 */
function attachRecipeSpecArtifacts(runId, closeout, extrasMap) {
  const bundleFiles = [];
  const artifacts = Array.isArray(closeout.artifacts) ? [...closeout.artifacts] : [];
  const candidates = Array.isArray(closeout.candidates) ? [...closeout.candidates] : [];
  const existingIds = new Set(artifacts.map((a) => a.artifactId));

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    if (candidate.kind !== "recipe") continue;
    const extras = extrasMap.get(candidate.candidateId) || {};
    const rawSpec = extras.recipeSpec || extras.spec;
    const spec = isRecipeSpecShape(rawSpec)
      ? rawSpec
      : synthesizeRecipeSpecFromCandidate(candidate, extras, runId);

    let sealed;
    try {
      sealed = sealRecipeSpec(spec);
    } catch (err) {
      fail(`sealRecipeSpec failed for ${candidate.candidateId}: ${err.message}`);
    }

    const artifactRel = sealed.artifact.path.replace(/\\/g, "/");
    if (!isSafeRelativePath(artifactRel)) {
      fail(`unsafe recipe_spec path: ${artifactRel}`);
    }

    // Persist under work ledger so rootRef windows:xhs-registry can hash it.
    const workDir = resolveRunWorkDir(runId, { create: true, allowMissing: false });
    const absWork = join(workDir.dir, artifactRel);
    mkdirSync(dirname(absWork), { recursive: true });
    writeFileSync(absWork, sealed.bytes);
    assertRegularLedgerFile(absWork, workDir.rootReal, artifactRel);

    const workArtifactPath = workArtifactRelPath(runId, artifactRel);
    let artifactId = `recipe_spec_${candidate.candidateId}`;
    if (existingIds.has(artifactId)) {
      artifactId = `recipe_spec_${candidate.candidateId}_${sha256Bytes(sealed.bytes).slice(0, 8)}`;
    }
    existingIds.add(artifactId);

    artifacts.push({
      artifactId,
      kind: "recipe_spec",
      rootRef: "windows:xhs-registry",
      path: workArtifactPath,
      sha256: sealed.artifact.sha256,
      bytes: sealed.artifact.bytes,
      availability: "present",
      redacted: false,
    });

    const refs = Array.isArray(candidate.evidenceRefs) ? [...candidate.evidenceRefs] : [];
    if (!refs.includes(artifactId)) refs.push(artifactId);
    candidates[i] = { ...candidate, evidenceRefs: refs };

    bundleFiles.push({
      path: artifactRel,
      bytes: sealed.bytes,
      sha256: sealed.artifact.sha256,
    });
  }

  closeout.artifacts = artifacts;
  closeout.candidates = candidates;
  return bundleFiles;
}

function normalizeClosure(closure, label = "closure") {
  if (!closure || typeof closure !== "object" || Array.isArray(closure)) {
    fail(`${label} must be an object`);
  }
  assertNoExtraKeys(closure, new Set(["status", "completed", "remainingWork", "blockers"]), label);
  return {
    status: mapEnum(closure.status, CLOSURE_STATUSES, null, `${label}.status`),
    completed: normalizeStringList(
      Array.isArray(closure.completed) ? closure.completed : [],
      `${label}.completed`,
      { allowTextObject: false },
    ),
    remainingWork: normalizeStringList(
      Array.isArray(closure.remainingWork) ? closure.remainingWork : [],
      `${label}.remainingWork`,
      { allowTextObject: false },
    ),
    blockers: normalizeStringList(
      Array.isArray(closure.blockers) ? closure.blockers : [],
      `${label}.blockers`,
      { allowTextObject: false },
    ),
  };
}

function normalizeEvidenceDebtItem(raw, i) {
  const label = `evidenceDebt[${i}]`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail(`${label} must be an object`);
  const severity = mapEnum(raw.severity, DEBT_SEVERITIES, null, `${label}.severity`);
  const code = requireText(raw.code, `${label}.code`);
  if (!DEBT_CODE_RE.test(code)) fail(`${label}.code must match ^[A-Z0-9_]+$`);
  return {
    debtId: requireText(raw.debtId, `${label}.debtId`),
    code,
    severity,
    summary: requireText(raw.summary, `${label}.summary`),
    evidenceRefs: normalizeIdList(raw.evidenceRefs, `${label}.evidenceRefs`),
  };
}

function normalizeSourceInput(raw, i) {
  const label = `sources[${i}]`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail(`${label} must be an object`);
  if (typeof raw.repo !== "string" || !raw.repo) fail(`${label}.repo required`);
  return {
    repo: raw.repo,
    repoRoot: raw.repoRoot,
    branch: raw.branch ?? null,
    head: raw.head ?? null,
    worktree: raw.worktree,
    changedFiles: normalizeChangedFiles(raw.changedFiles, `${label}.changedFiles`),
    commit: raw.commit ?? null,
    ahead: raw.ahead ?? null,
    behind: raw.behind ?? null,
    pushed: raw.pushed ?? null,
  };
}

function normalizeMachine(machine, label = "machine") {
  if (!machine || typeof machine !== "object" || Array.isArray(machine)) {
    fail(`${label} must be an object`);
  }
  assertNoExtraKeys(machine, new Set(["id", "platform"]), label);
  return {
    id: requireText(machine.id, `${label}.id`),
    platform: mapEnum(machine.platform, MACHINE_PLATFORMS, null, `${label}.platform`),
  };
}

/**
 * Limited, deterministic agent-input normalization into contract enums/shapes.
 * Unsafe / ambiguous values → CLOSEOUT_FAILED (caller must not seal).
 */
function normalizeCloseoutInput(input) {
  requireInputFields(input);
  requireDateTime(input.startedAt, "startedAt");
  if (input.endedAt != null) requireDateTime(input.endedAt, "endedAt");
  return {
    taskId: requireText(input.taskId, "taskId"),
    runId: input.runId,
    actor: requireText(input.actor, "actor"),
    machine: normalizeMachine(input.machine),
    mode: mapEnum(input.mode, MODES, null, "mode"),
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    sources: input.sources.map((s, i) => normalizeSourceInput(s, i)),
    checks: (Array.isArray(input.checks) ? input.checks : []).map(normalizeCheck),
    runtime: normalizeRuntime(input.runtime),
    deviceRefs: normalizeDeviceRefs(input.deviceRefs),
    effects: (Array.isArray(input.effects) ? input.effects : []).map(normalizeEffect),
    artifacts: (Array.isArray(input.artifacts) ? input.artifacts : []).map(
      normalizeArtifactInput,
    ),
    candidates: (Array.isArray(input.candidates) ? input.candidates : []).map(
      normalizeCandidate,
    ),
    closure: normalizeClosure(input.closure),
    claims: (Array.isArray(input.claims) ? input.claims : []).map(normalizeClaim),
    evidenceDebt: (Array.isArray(input.evidenceDebt) ? input.evidenceDebt : []).map(
      normalizeEvidenceDebtItem,
    ),
    acceptanceConditions: normalizeStringList(
      input.acceptanceConditions,
      "acceptanceConditions",
    ),
  };
}

function assertExactKeys(obj, keys, label) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) fail(`contract ${label} must be object`);
  const have = Object.keys(obj).sort();
  const need = [...keys].sort();
  if (have.join("\0") !== need.join("\0")) {
    fail(
      `contract ${label} exact keys mismatch (have=${have.join(",")} need=${need.join(",")})`,
    );
  }
}

function assertTextArray(list, label) {
  if (!Array.isArray(list)) fail(`contract ${label} must be array`);
  const seen = new Set();
  for (let i = 0; i < list.length; i++) {
    if (typeof list[i] !== "string" || list[i].length < 1) {
      fail(`contract ${label}[${i}] must be non-empty string`);
    }
    if (seen.has(list[i])) fail(`contract ${label} uniqueItems violated`);
    seen.add(list[i]);
  }
}

function assertUniqueIds(list, idKey, label) {
  const seen = new Set();
  for (let i = 0; i < list.length; i++) {
    const id = list[i]?.[idKey];
    if (typeof id !== "string" || !id) fail(`contract ${label}[${i}].${idKey} required`);
    if (seen.has(id)) fail(`contract ${label} duplicate ${idKey}: ${id}`);
    seen.add(id);
  }
}

/** Full contract validation before staging/seal. */
function validateCanonicalCloseout(closeout) {
  if (!closeout || typeof closeout !== "object" || Array.isArray(closeout)) {
    fail("contract closeout missing");
  }
  assertExactKeys(
    closeout,
    [
      "schemaId",
      "schemaVersion",
      "taskId",
      "runId",
      "actor",
      "machine",
      "mode",
      "startedAt",
      "endedAt",
      "producer",
      "sources",
      "checks",
      "runtime",
      "deviceRefs",
      "effects",
      "artifacts",
      "candidates",
      "closure",
      "claims",
      "evidenceDebt",
      "acceptanceConditions",
    ],
    "closeout",
  );
  if (closeout.schemaId !== SCHEMA_ID) fail("contract schemaId mismatch");
  if (closeout.schemaVersion !== 1) fail("contract schemaVersion mismatch");
  requireText(closeout.taskId, "taskId");
  if (typeof closeout.runId !== "string" || !RUN_ID_RE.test(closeout.runId)) {
    fail("contract runId pattern mismatch");
  }
  requireText(closeout.actor, "actor");
  assertExactKeys(closeout.machine, ["id", "platform"], "machine");
  requireText(closeout.machine.id, "machine.id");
  if (!MACHINE_PLATFORMS.has(closeout.machine.platform)) fail("contract machine.platform invalid");
  if (!MODES.has(closeout.mode)) fail("contract mode invalid");
  requireDateTime(closeout.startedAt, "startedAt");
  requireDateTime(closeout.endedAt, "endedAt");

  assertExactKeys(
    closeout.producer,
    ["name", "version", "commit", "scriptSha256", "contractSha256"],
    "producer",
  );
  requireText(closeout.producer.name, "producer.name");
  requireText(closeout.producer.version, "producer.version");
  if (closeout.producer.commit != null && !GIT_HASH_RE.test(closeout.producer.commit)) {
    fail("contract producer.commit invalid");
  }
  if (!SHA256_RE.test(closeout.producer.scriptSha256)) fail("contract producer.scriptSha256 invalid");
  if (closeout.producer.contractSha256 !== CONTRACT_SHA256) {
    fail("contract producer.contractSha256 mismatch");
  }

  if (!Array.isArray(closeout.sources) || closeout.sources.length < 1) {
    fail("contract sources minItems=1");
  }
  for (let i = 0; i < closeout.sources.length; i++) {
    const s = closeout.sources[i];
    const label = `sources[${i}]`;
    assertExactKeys(
      s,
      ["repo", "branch", "head", "worktree", "changedFiles", "commit", "ahead", "behind", "pushed"],
      label,
    );
    requireText(s.repo, `${label}.repo`);
    if (s.branch != null && typeof s.branch !== "string") fail(`${label}.branch invalid`);
    if (s.head != null && !GIT_HASH_RE.test(s.head)) fail(`${label}.head invalid`);
    if (!WORKTREE_STATUSES.has(s.worktree)) fail(`${label}.worktree invalid`);
    if (!Array.isArray(s.changedFiles)) fail(`${label}.changedFiles must be array`);
    for (let j = 0; j < s.changedFiles.length; j++) {
      const f = s.changedFiles[j];
      const at = `${label}.changedFiles[${j}]`;
      if (!f || typeof f !== "object" || Array.isArray(f)) fail(`${at} must be object`);
      const keys = Object.keys(f);
      if (!keys.includes("path") || !keys.includes("status")) fail(`${at} required path/status`);
      for (const k of keys) {
        if (!["path", "status", "sha256"].includes(k)) fail(`${at} additionalProperties: ${k}`);
      }
      if (!isSafeRelativePath(f.path)) fail(`${at}.path unsafe`);
      if (!CHANGED_FILE_STATUSES.has(f.status)) fail(`${at}.status invalid`);
      if (f.sha256 != null && !SHA256_RE.test(f.sha256)) fail(`${at}.sha256 invalid`);
    }
    if (s.commit != null && !GIT_HASH_RE.test(s.commit)) fail(`${label}.commit invalid`);
    if (s.ahead != null && (!Number.isInteger(s.ahead) || s.ahead < 0)) fail(`${label}.ahead invalid`);
    if (s.behind != null && (!Number.isInteger(s.behind) || s.behind < 0)) {
      fail(`${label}.behind invalid`);
    }
    if (s.pushed != null && typeof s.pushed !== "boolean") fail(`${label}.pushed invalid`);
  }

  if (!Array.isArray(closeout.checks)) fail("contract checks must be array");
  assertUniqueIds(closeout.checks, "id", "checks");
  for (let i = 0; i < closeout.checks.length; i++) {
    const c = closeout.checks[i];
    const label = `checks[${i}]`;
    assertExactKeys(c, ["id", "kind", "status", "exitCode", "observedAt", "evidenceRefs"], label);
    if (!CHECK_KINDS.has(c.kind)) fail(`${label}.kind invalid`);
    if (!CHECK_STATUSES.has(c.status)) fail(`${label}.status invalid`);
    if (c.exitCode != null && !Number.isInteger(c.exitCode)) fail(`${label}.exitCode invalid`);
    if (c.observedAt != null && !isDateTime(c.observedAt)) fail(`${label}.observedAt invalid`);
    assertTextArray(c.evidenceRefs, `${label}.evidenceRefs`);
  }

  assertExactKeys(closeout.runtime, ["deployment", "reload", "serve"], "runtime");
  for (const key of RUNTIME_KEYS) {
    const slot = closeout.runtime[key];
    const label = `runtime.${key}`;
    assertExactKeys(slot, ["status", "observedAt", "evidenceRefs"], label);
    if (!RUNTIME_STATUSES.has(slot.status)) fail(`${label}.status invalid`);
    if (slot.observedAt != null && !isDateTime(slot.observedAt)) fail(`${label}.observedAt invalid`);
    assertTextArray(slot.evidenceRefs, `${label}.evidenceRefs`);
  }

  assertExactKeys(closeout.deviceRefs, [...DEVICE_REF_KEYS], "deviceRefs");
  for (const key of DEVICE_REF_KEYS) {
    assertTextArray(closeout.deviceRefs[key], `deviceRefs.${key}`);
  }

  if (!Array.isArray(closeout.effects)) fail("contract effects must be array");
  assertUniqueIds(closeout.effects, "effectId", "effects");
  for (let i = 0; i < closeout.effects.length; i++) {
    const e = closeout.effects[i];
    const label = `effects[${i}]`;
    assertExactKeys(
      e,
      ["effectId", "kind", "status", "quantity", "payment", "evidenceRefs"],
      label,
    );
    if (!EFFECT_KINDS.has(e.kind)) fail(`${label}.kind invalid`);
    if (!EFFECT_STATUSES.has(e.status)) fail(`${label}.status invalid`);
    if (e.quantity != null && (!Number.isInteger(e.quantity) || e.quantity < 0)) {
      fail(`${label}.quantity invalid`);
    }
    assertExactKeys(e.payment, ["involved", "transportCount", "finalCommit"], `${label}.payment`);
    if (typeof e.payment.involved !== "boolean") fail(`${label}.payment.involved invalid`);
    if (typeof e.payment.finalCommit !== "boolean") fail(`${label}.payment.finalCommit invalid`);
    if (!Number.isInteger(e.payment.transportCount) || e.payment.transportCount < 0) {
      fail(`${label}.payment.transportCount invalid`);
    }
    assertTextArray(e.evidenceRefs, `${label}.evidenceRefs`);
  }

  if (!Array.isArray(closeout.artifacts)) fail("contract artifacts must be array");
  assertUniqueIds(closeout.artifacts, "artifactId", "artifacts");
  for (let i = 0; i < closeout.artifacts.length; i++) {
    const a = closeout.artifacts[i];
    const label = `artifacts[${i}]`;
    assertExactKeys(
      a,
      ["artifactId", "kind", "rootRef", "path", "sha256", "bytes", "availability", "redacted"],
      label,
    );
    if (!ARTIFACT_KINDS.has(a.kind)) fail(`${label}.kind invalid`);
    requireText(a.rootRef, `${label}.rootRef`);
    if (!isSafeRelativePath(a.path)) fail(`${label}.path unsafe`);
    if (a.sha256 != null && !SHA256_RE.test(a.sha256)) fail(`${label}.sha256 invalid`);
    if (a.bytes != null && (!Number.isInteger(a.bytes) || a.bytes < 0)) fail(`${label}.bytes invalid`);
    if (!ARTIFACT_AVAIL.has(a.availability)) fail(`${label}.availability invalid`);
    if (typeof a.redacted !== "boolean") fail(`${label}.redacted invalid`);
  }

  if (!Array.isArray(closeout.candidates)) fail("contract candidates must be array");
  assertUniqueIds(closeout.candidates, "candidateId", "candidates");
  for (let i = 0; i < closeout.candidates.length; i++) {
    const c = closeout.candidates[i];
    const label = `candidates[${i}]`;
    assertExactKeys(
      c,
      ["candidateId", "kind", "title", "basis", "status", "evidenceRefs", "acceptanceConditions"],
      label,
    );
    if (!CANDIDATE_KINDS.has(c.kind)) fail(`${label}.kind invalid`);
    if (!CANDIDATE_BASES.has(c.basis)) fail(`${label}.basis invalid`);
    if (!CANDIDATE_STATUSES.has(c.status)) fail(`${label}.status invalid`);
    requireText(c.title, `${label}.title`);
    assertTextArray(c.evidenceRefs, `${label}.evidenceRefs`);
    assertTextArray(c.acceptanceConditions, `${label}.acceptanceConditions`);
  }

  assertExactKeys(
    closeout.closure,
    ["status", "completed", "remainingWork", "blockers"],
    "closure",
  );
  if (!CLOSURE_STATUSES.has(closeout.closure.status)) fail("contract closure.status invalid");
  assertTextArray(closeout.closure.completed, "closure.completed");
  assertTextArray(closeout.closure.remainingWork, "closure.remainingWork");
  assertTextArray(closeout.closure.blockers, "closure.blockers");

  if (!Array.isArray(closeout.claims)) fail("contract claims must be array");
  assertUniqueIds(closeout.claims, "claimId", "claims");
  for (let i = 0; i < closeout.claims.length; i++) {
    const c = closeout.claims[i];
    const label = `claims[${i}]`;
    assertExactKeys(c, ["claimId", "narrative", "status", "evidenceRefs"], label);
    requireText(c.narrative, `${label}.narrative`);
    if (!CLAIM_STATUSES.has(c.status)) fail(`${label}.status invalid`);
    assertTextArray(c.evidenceRefs, `${label}.evidenceRefs`);
  }

  if (!Array.isArray(closeout.evidenceDebt)) fail("contract evidenceDebt must be array");
  assertUniqueIds(closeout.evidenceDebt, "debtId", "evidenceDebt");
  for (let i = 0; i < closeout.evidenceDebt.length; i++) {
    const d = closeout.evidenceDebt[i];
    const label = `evidenceDebt[${i}]`;
    assertExactKeys(d, ["debtId", "code", "severity", "summary", "evidenceRefs"], label);
    if (!DEBT_CODE_RE.test(d.code)) fail(`${label}.code invalid`);
    if (!DEBT_SEVERITIES.has(d.severity)) fail(`${label}.severity invalid`);
    requireText(d.summary, `${label}.summary`);
    assertTextArray(d.evidenceRefs, `${label}.evidenceRefs`);
  }

  assertTextArray(closeout.acceptanceConditions, "acceptanceConditions");
}

function buildCloseout(runId, rawInput, rootMap) {
  let secretKeysSeen = false;
  for (const d of rawInput.evidenceDebt || []) {
    if (d && typeof d === "object") {
      for (const k of Object.keys(d)) {
        if (SECRET_KEY_RE.test(k)) secretKeysSeen = true;
      }
    }
  }

  const input = normalizeCloseoutInput(rawInput);
  if (input.runId && input.runId !== runId) {
    fail(`input.runId ${input.runId} does not match --run ${runId}`);
  }
  if (!/^run_[A-Za-z0-9._-]+$/.test(runId)) fail(`invalid runId: ${runId}`);

  const debts = [];
  for (const d of input.evidenceDebt || []) {
    debts.push({
      debtId: d.debtId,
      code: d.code,
      severity: d.severity,
      summary: d.summary,
      evidenceRefs: Array.isArray(d.evidenceRefs) ? d.evidenceRefs : [],
    });
  }
  if (secretKeysSeen) {
    debts.push({
      debtId: `debt_secret_redacted_${sha256Bytes(Buffer.from(runId)).slice(0, 12)}`,
      code: "SECRET_FIELD_REDACTED",
      severity: "low",
      summary: "Secret-looking keys were present in input evidenceDebt and stripped.",
      evidenceRefs: [],
    });
  }

  // Expected: producer.commit is null until Mac Git adopts helper.
  debts.push({
    debtId: `debt_producer_commit_${sha256Bytes(Buffer.from(runId)).slice(0, 12)}`,
    code: "PRODUCER_COMMIT_UNAVAILABLE",
    severity: "low",
    summary:
      "xw-closeout.mjs is not yet adopted into Mac Git; producer.commit is null by contract.",
    evidenceRefs: [],
  });

  const sources = input.sources.map((s) => observeGitSource(s, debts));
  const artifacts = materializeArtifacts(input.artifacts, rootMap, debts);

  const claims = (input.claims || []).map((c) => ({
    claimId: c.claimId,
    narrative: c.narrative,
    status: c.status,
    evidenceRefs: Array.isArray(c.evidenceRefs) ? c.evidenceRefs : [],
  }));

  const closeout = redactSecrets({
    schemaId: SCHEMA_ID,
    schemaVersion: SCHEMA_VERSION,
    taskId: input.taskId,
    runId,
    actor: input.actor,
    machine: input.machine,
    mode: input.mode,
    startedAt: input.startedAt,
    endedAt: input.endedAt || nowIso(),
    producer: {
      name: PRODUCER_NAME,
      version: PRODUCER_VERSION,
      commit: null,
      scriptSha256: scriptSha256(),
      contractSha256: CONTRACT_SHA256,
    },
    sources,
    checks: input.checks,
    runtime: input.runtime,
    deviceRefs: input.deviceRefs,
    effects: input.effects,
    artifacts,
    candidates: input.candidates,
    closure: input.closure,
    claims,
    evidenceDebt: debts,
    acceptanceConditions: input.acceptanceConditions,
  });

  return closeout;
}

function writeAtomicBundle(runId, closeout, inputBytes, bundleFiles = []) {
  const harvestRoot = outboxRoot();
  const finalDir = join(harvestRoot, runId);
  const inputHash = sha256Bytes(inputBytes);
  const stagingParent = join(harvestRoot, ".staging");
  const stagingDir = join(stagingParent, `${runId}-${inputHash}`);

  mkdirSync(harvestRoot, { recursive: true });
  mkdirSync(stagingParent, { recursive: true });

  // Conflict: other staging for same runId with different input hash
  if (existsSync(stagingParent)) {
    for (const name of readdirSync(stagingParent)) {
      if (!name.startsWith(`${runId}-`)) continue;
      if (name !== `${runId}-${inputHash}`) {
        fail(
          `staging conflict for ${runId}: existing ${name} differs from input hash ${inputHash}`,
        );
      }
    }
  }

  const closeoutText = stableStringify(closeout);
  const closeoutBuf = Buffer.from(closeoutText, "utf8");
  const closeoutSha = sha256Bytes(closeoutBuf);

  const extraManifestFiles = [];
  for (const f of bundleFiles || []) {
    if (!f || typeof f.path !== "string" || !isSafeRelativePath(f.path)) {
      fail(`bundle extra file path unsafe: ${f?.path}`);
    }
    if (!Buffer.isBuffer(f.bytes)) fail(`bundle extra file bytes missing: ${f.path}`);
    const sha = f.sha256 || sha256Bytes(f.bytes);
    extraManifestFiles.push({
      path: f.path.replace(/\\/g, "/"),
      sha256: sha,
      bytes: f.bytes.length,
      bytesBuf: f.bytes,
    });
  }
  extraManifestFiles.sort((a, b) => a.path.localeCompare(b.path));

  const manifest = {
    schemaId: "xhs.task-closeout-manifest.v1",
    schemaVersion: 1,
    runId,
    createdAt: closeout.endedAt,
    producerCommit: closeout.producer.commit,
    contractSha256: closeout.producer.contractSha256,
    files: [
      {
        path: "closeout.v1.json",
        sha256: closeoutSha,
        bytes: closeoutBuf.length,
      },
      ...extraManifestFiles.map(({ path, sha256, bytes }) => ({ path, sha256, bytes })),
    ],
  };
  const manifestText = stableStringify(manifest);
  const manifestBuf = Buffer.from(manifestText, "utf8");
  const manifestSha = sha256Bytes(manifestBuf);

  if (existsSync(finalDir)) {
    const existingClose = join(finalDir, "closeout.v1.json");
    const existingMan = join(finalDir, "manifest.json");
    const existingShaFile = join(finalDir, "manifest.sha256");
    if (
      !existsSync(existingClose) ||
      !existsSync(existingMan) ||
      !existsSync(existingShaFile)
    ) {
      fail(`incomplete existing bundle at ${finalDir}`);
    }
    const sameClose = Buffer.compare(readFileSync(existingClose), closeoutBuf) === 0;
    const sameMan = Buffer.compare(readFileSync(existingMan), manifestBuf) === 0;
    const sameSha =
      readFileSync(existingShaFile, "utf8").trim().toLowerCase() === manifestSha;
    if (sameClose && sameMan && sameSha) {
      return {
        result: "already_harvested",
        status: closeout.closure.status,
        bundle: finalDir,
        manifestSha256: manifestSha,
      };
    }
    fail(`conflict: bundle already exists for ${runId} with different content`);
  }

  // Prepare / reuse staging for same runId+inputHash
  mkdirSync(stagingDir, { recursive: true });
  writeFileSync(join(stagingDir, "closeout.v1.json"), closeoutBuf);
  for (const f of extraManifestFiles) {
    const abs = join(stagingDir, f.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.bytesBuf);
  }
  writeFileSync(join(stagingDir, "manifest.json"), manifestBuf);
  writeFileSync(join(stagingDir, "manifest.sha256"), manifestSha + "\n");

  // Atomic promote: rename staging → final (dest must not exist)
  try {
    renameSync(stagingDir, finalDir);
  } catch (err) {
    // If final appeared concurrently, re-check already_harvested / conflict
    if (existsSync(finalDir)) {
      const existingClose = readFileSync(join(finalDir, "closeout.v1.json"));
      const existingMan = readFileSync(join(finalDir, "manifest.json"));
      const existingSha = readFileSync(join(finalDir, "manifest.sha256"), "utf8")
        .trim()
        .toLowerCase();
      if (
        Buffer.compare(existingClose, closeoutBuf) === 0 &&
        Buffer.compare(existingMan, manifestBuf) === 0 &&
        existingSha === manifestSha
      ) {
        rmSync(stagingDir, { recursive: true, force: true });
        return {
          result: "already_harvested",
          status: closeout.closure.status,
          bundle: finalDir,
          manifestSha256: manifestSha,
        };
      }
      fail(`conflict: concurrent bundle for ${runId} differs (${err.message})`);
    }
    fail(`atomic promote failed: ${err.message}`);
  }

  return {
    result: "created",
    status: closeout.closure.status,
    bundle: finalDir,
    manifestSha256: manifestSha,
  };
}

function printCloseoutLine(runId, status, result, bundle, manifestSha256) {
  console.log(
    `CLOSEOUT run=${runId} status=${status} result=${result}\nbundle=${bundle}\nmanifestSha256=${manifestSha256}\nmacReview=pending`,
  );
}

function cmdBegin(args) {
  const mode = args.mode;
  const actor = args.actor;
  if (!mode || !MODES.has(mode)) {
    fail("begin requires --mode explorer|runner|repair|engineering|recover");
  }
  if (!actor || typeof actor !== "string") fail("begin requires --actor <actor>");

  let brief = null;
  if (args.brief) {
    if (!existsSync(args.brief)) fail(`brief not found: ${args.brief}`);
    try {
      brief = readJsonFileBom(args.brief);
    } catch (err) {
      fail(`cannot read brief JSON: ${err.message}`);
    }
    if (!brief?.goal || typeof brief.goal !== "string" || !brief.goal.trim()) {
      fail("brief JSON requires non-empty goal");
    }
  } else if (!args.goal || typeof args.goal !== "string" || !String(args.goal).trim()) {
    fail("begin requires --goal <text> or --brief <json-path>");
  }

  const taskId = brief?.taskId || `task_${randomUUID()}`;
  const runId = brief?.runId || `run_${randomUUID()}`;
  if (!/^run_[A-Za-z0-9._-]+$/.test(runId)) fail(`invalid runId: ${runId}`);
  const startedAt = brief?.startedAt || nowIso();
  const goal = String(brief?.goal || args.goal).trim();
  const { dir, rootReal } = resolveRunWorkDir(runId, { create: true });

  const task = {
    taskId,
    runId,
    goal,
    mode,
    actor,
    acceptance: Array.isArray(brief?.acceptance) ? brief.acceptance : [],
    outOfScope: Array.isArray(brief?.outOfScope) ? brief.outOfScope : [],
    startedAt,
  };
  const taskPath = join(dir, "task.json");
  const stepsPath = join(dir, "steps.jsonl");
  writeFileSync(taskPath, stableStringify(task));
  if (!existsSync(stepsPath)) writeFileSync(stepsPath, "");
  assertRegularLedgerFile(taskPath, rootReal, "task.json");
  assertRegularLedgerFile(stepsPath, rootReal, "steps.jsonl");

  const payload = { taskId, runId, startedAt, mode, actor, goal, workDir: dir };
  console.log(stableStringify(payload).trimEnd());
}

function normalizeStepEvidence(list) {
  if (list == null) return [];
  if (!Array.isArray(list)) fail("step.evidence must be an array");
  const out = [];
  for (const item of list) {
    if (!item?.rootRef || !item?.path) fail("step.evidence entries need rootRef and path");
    if (!isSafeRelativePath(item.path)) fail(`step.evidence path not safe: ${item.path}`);
    out.push({
      rootRef: String(item.rootRef),
      path: String(item.path).replace(/\\/g, "/"),
    });
  }
  return out;
}

function cmdStep(args) {
  const runId = args.run;
  const inputPath = args.input;
  if (!runId) fail("step requires --run <runId>");
  if (!inputPath) fail("step requires --input <explicit-json-path>");
  if (!existsSync(inputPath)) fail(`input not found: ${inputPath}`);
  const { dir, rootReal } = resolveRunWorkDir(runId, { create: false });
  const taskPath = join(dir, "task.json");
  const stepsPath = join(dir, "steps.jsonl");
  if (!assertRegularLedgerFile(taskPath, rootReal, "task.json")) {
    fail(`work ledger missing for ${runId}; run begin first`);
  }
  if (!existsSync(stepsPath)) writeFileSync(stepsPath, "");
  assertRegularLedgerFile(stepsPath, rootReal, "steps.jsonl");

  let raw;
  try {
    raw = readJsonFileBom(inputPath);
  } catch (err) {
    fail(`cannot read step JSON: ${err.message}`);
  }
  raw = redactSecrets(raw);
  if (!raw || typeof raw !== "object") fail("step input must be a JSON object");
  const kind = raw.kind;
  const title = raw.title;
  const status = raw.status || "unverified";
  if (!STEP_KINDS.has(kind)) {
    fail(`step.kind must be one of ${[...STEP_KINDS].join("|")}`);
  }
  if (!title || typeof title !== "string" || !title.trim()) fail("step.title required");
  if (!STEP_STATUSES.has(status)) {
    fail(`step.status must be one of ${[...STEP_STATUSES].join("|")}`);
  }

  const step = {
    ts: raw.ts || nowIso(),
    stepId: raw.stepId || `step_${randomUUID()}`,
    kind,
    title: title.trim(),
    status,
    commandOrRef: raw.commandOrRef == null ? null : String(raw.commandOrRef),
    exitCode: raw.exitCode == null ? null : Number(raw.exitCode),
    evidence: normalizeStepEvidence(raw.evidence),
    blockerReason: raw.blockerReason == null ? null : String(raw.blockerReason),
    notes: raw.notes == null ? null : String(raw.notes),
  };
  if (step.exitCode != null && !Number.isFinite(step.exitCode)) {
    fail("step.exitCode must be a number or null");
  }

  appendFileSync(stepsPath, JSON.stringify(sortKeys(step)) + "\n", "utf8");
  assertRegularLedgerFile(stepsPath, rootReal, "steps.jsonl");
  console.log(stableStringify({ ok: true, runId, stepId: step.stepId, kind: step.kind }).trimEnd());
}

function cmdClose(args) {
  const runId = args.run;
  const inputPath = args.input;
  if (!runId) fail("close requires --run <runId>");
  if (!inputPath) fail("close requires --input <explicit-json-path>");
  if (!existsSync(inputPath)) fail(`input not found: ${inputPath}`);
  // Input path itself may be absolute; that is the CLI arg, not an artifact path.
  let inputBytes;
  let input;
  try {
    inputBytes = readFileSync(inputPath);
    input = parseJsonBytes(inputBytes);
  } catch (err) {
    fail(`cannot read input JSON: ${err.message}`);
  }
  if (!input || typeof input !== "object") fail("input must be a JSON object");

  const rootMap = loadRootMap();
  const recipeExtras = extractRecipeCandidateExtras(input);
  let closeout;
  let bundleFiles = [];
  try {
    closeout = buildCloseout(runId, input, rootMap);
    closeout = attachWorkLedger(runId, closeout);
    bundleFiles = attachRecipeSpecArtifacts(runId, closeout, recipeExtras);
    validateCanonicalCloseout(closeout);
  } catch (err) {
    // Never stage/seal on normalize or schema failure.
    fail(err.message || String(err));
  }
  let result;
  try {
    result = writeAtomicBundle(runId, closeout, inputBytes, bundleFiles);
  } catch (err) {
    fail(err.message || String(err));
  }
  printCloseoutLine(
    runId,
    result.status,
    result.result,
    result.bundle,
    result.manifestSha256,
  );
  if (result.result === "already_harvested") {
    console.log("already_harvested");
  }
}

function paymentNone() {
  return { involved: false, transportCount: 0, finalCommit: false };
}

function baseRuntime(overrides = {}) {
  return {
    deployment: {
      status: "not_performed",
      observedAt: null,
      evidenceRefs: [],
      ...overrides.deployment,
    },
    reload: {
      status: "not_performed",
      observedAt: null,
      evidenceRefs: [],
      ...overrides.reload,
    },
    serve: {
      status: "not_performed",
      observedAt: null,
      evidenceRefs: [],
      ...overrides.serve,
    },
  };
}

function emptyDeviceRefs(extra = {}) {
  return {
    devices: [],
    runs: [],
    jobs: [],
    sessions: [],
    leases: [],
    evidenceRefs: [],
    ...extra,
  };
}

function writeJson(path, obj) {
  writeFileSync(path, stableStringify(obj));
}

function runCloseExpect(runId, inputPath, env, expect) {
  const node = process.execPath;
  const args = [SCRIPT_PATH, "close", "--run", runId, "--input", inputPath];
  let stdout = "";
  let stderr = "";
  let code = 0;
  try {
    stdout = execFileSync(node, args, {
      encoding: "utf8",
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    code = typeof err.status === "number" ? err.status : 1;
    stdout = err.stdout?.toString?.() || "";
    stderr = err.stderr?.toString?.() || "";
  }
  const combined = `${stdout}\n${stderr}`;
  if (expect.ok) {
    if (code !== 0) throw new Error(`expected ok, got code=${code}\n${combined}`);
    if (expect.result && !combined.includes(`result=${expect.result}`)) {
      throw new Error(`expected result=${expect.result}\n${combined}`);
    }
    if (expect.status && !combined.includes(`status=${expect.status}`)) {
      throw new Error(`expected status=${expect.status}\n${combined}`);
    }
    if (expect.includes) {
      for (const s of expect.includes) {
        if (!combined.includes(s)) throw new Error(`expected include ${s}\n${combined}`);
      }
    }
  } else {
    if (code === 0) throw new Error(`expected failure, got success\n${combined}`);
    if (expect.includes) {
      for (const s of expect.includes) {
        if (!combined.includes(s)) throw new Error(`expected include ${s}\n${combined}`);
      }
    }
  }
  return combined;
}

function cmdSelfTest() {
  const root = join(tmpdir(), `xw-closeout-selftest-${randomUUID()}`);
  const registryRoot = join(root, "registry");
  const work = join(registryRoot, "outbox", "work");
  const outbox = join(root, "harvest");
  const artRoot = join(root, "artifacts");
  mkdirSync(artRoot, { recursive: true });
  mkdirSync(outbox, { recursive: true });
  mkdirSync(work, { recursive: true });

  const env = {
    XW_CLOSEOUT_OUTBOX: outbox,
    XW_CLOSEOUT_WORK: work,
    XW_CLOSEOUT_ROOTS_JSON: JSON.stringify({
      "windows:self-test": artRoot,
      "windows:xhs-registry": registryRoot,
    }),
  };

  function seedWork(runId, { goal, taskId, actor = "self-test", mode = "engineering" }, steps) {
    const dir = join(work, runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "task.json"),
      stableStringify({
        taskId: taskId || `task_${runId}`,
        runId,
        goal,
        mode,
        actor,
        acceptance: [],
        outOfScope: [],
        startedAt: "2026-08-03T00:00:00.000Z",
      }),
    );
    const lines = (steps || []).map((s) => JSON.stringify(sortKeys(s))).join("\n");
    writeFileSync(join(dir, "steps.jsonl"), lines ? lines + "\n" : "");
  }

  const results = [];
  const note = (name, ok, detail = "") => {
    results.push({ name, ok, detail });
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  };

  try {
    // shared sample artifact files
    const sampleLog = join(artRoot, "sample.log");
    writeFileSync(sampleLog, "sample evidence\n");
    const sampleSha = sha256File(sampleLog);

    // --- 1 XHS partial ---
    {
      const runId = `run_xhs_${randomUUID().slice(0, 8)}`;
      const inputPath = join(root, "xhs-input.json");
      writeJson(inputPath, {
        taskId: "task_xhs_fixture",
        actor: "self-test",
        machine: { id: "windows-self-test", platform: "windows" },
        mode: "engineering",
        startedAt: "2026-08-03T01:00:00.000Z",
        endedAt: "2026-08-03T02:00:00.000Z",
        sources: [
          {
            repo: "windows:routing",
            // no repoRoot → do not scan; explicit git facts
            branch: "main",
            head: "2bab4eaaee1522881e3d3b6a9341768f7712c52e",
            worktree: "clean",
            changedFiles: [],
            commit: "2bab4eaaee1522881e3d3b6a9341768f7712c52e",
            ahead: 1,
            behind: 0,
            pushed: false,
          },
        ],
        checks: [
          {
            id: "check_tests",
            kind: "test",
            status: "pass",
            exitCode: 0,
            observedAt: "2026-08-03T01:30:00.000Z",
            evidenceRefs: [],
          },
        ],
        runtime: baseRuntime({
          deployment: {
            status: "performed",
            observedAt: "2026-08-03T01:40:00.000Z",
            evidenceRefs: ["art_deploy_note"],
          },
          serve: {
            status: "performed",
            observedAt: "2026-08-03T01:41:00.000Z",
            evidenceRefs: ["art_deploy_note"],
          },
        }),
        deviceRefs: emptyDeviceRefs({ devices: ["04"], jobs: [] }),
        effects: [
          {
            effectId: "eff_draft",
            kind: "draft_saved",
            status: "occurred",
            quantity: 1,
            payment: paymentNone(),
            evidenceRefs: ["art_log"],
          },
        ],
        artifacts: [
          {
            artifactId: "art_log",
            kind: "log",
            rootRef: "windows:self-test",
            path: "sample.log",
            redacted: false,
          },
          {
            artifactId: "art_deploy_note",
            kind: "receipt",
            rootRef: "windows:self-test",
            path: "missing-deploy.txt",
            redacted: false,
          },
        ],
        candidates: [
          {
            candidateId: "cand_locator",
            kind: "capability",
            title: "note locator still fail-closed",
            basis: "source_defect",
            status: "blocked",
            evidenceRefs: [],
            acceptanceConditions: ["stable note locator on serve"],
          },
        ],
        closure: {
          status: "partial",
          completed: ["source fix committed", "control-plane/serve reload observed", "real draft saved"],
          remainingWork: ["push commit", "locator fail-closed remains"],
          blockers: ["locator fail-closed"],
        },
        claims: [
          {
            claimId: "claim_pushed",
            narrative: "changes were pushed",
            status: "contradicted",
            evidenceRefs: [],
          },
          {
            claimId: "claim_deployed",
            narrative: "deployed but not pushed; locator still fail-closed",
            status: "unverified",
            evidenceRefs: ["art_deploy_note"],
          },
        ],
        evidenceDebt: [],
        acceptanceConditions: [
          "partial is required when deployed but unpushed",
          "locator fail-closed must remain a blocker",
        ],
      });
      const out = runCloseExpect(runId, inputPath, env, {
        ok: true,
        result: "created",
        status: "partial",
      });
      const bundle = join(outbox, runId, "closeout.v1.json");
      const co = JSON.parse(readFileSync(bundle, "utf8"));
      if (co.producer.commit !== null) throw new Error("producer.commit must be null");
      if (co.producer.contractSha256 !== CONTRACT_SHA256) {
        throw new Error("contractSha256 mismatch");
      }
      if (co.sources[0].pushed !== false) throw new Error("expected pushed=false");
      note("1_xhs_partial", true, `run=${runId}`);
    }

    // --- 2 Douyin partial 18/60 ---
    {
      const runId = `run_dy_${randomUUID().slice(0, 8)}`;
      const inputPath = join(root, "dy-input.json");
      writeJson(inputPath, {
        taskId: "task_dy_fixture",
        actor: "self-test",
        machine: { id: "windows-self-test", platform: "windows" },
        mode: "runner",
        startedAt: "2026-08-03T03:00:00.000Z",
        endedAt: "2026-08-03T04:00:00.000Z",
        sources: [
          {
            repo: "windows:xhs-registry",
            branch: null,
            head: null,
            worktree: "not_applicable",
            changedFiles: [],
            commit: null,
            ahead: null,
            behind: null,
            pushed: null,
          },
        ],
        checks: [
          {
            id: "check_not_run",
            kind: "test",
            status: "not_run",
            exitCode: null,
            observedAt: null,
            evidenceRefs: [],
          },
        ],
        runtime: baseRuntime(),
        deviceRefs: emptyDeviceRefs({ devices: ["01"] }),
        effects: [
          {
            effectId: "eff_feishu",
            kind: "feishu_upload",
            status: "partial",
            quantity: 18,
            payment: paymentNone(),
            evidenceRefs: ["art_log"],
          },
        ],
        artifacts: [
          {
            artifactId: "art_log",
            kind: "log",
            rootRef: "windows:self-test",
            path: "sample.log",
            redacted: false,
            sha256: sampleSha,
          },
        ],
        candidates: [
          {
            candidateId: "cand_tmp_launcher",
            kind: "skill",
            title: "runtime/_*.mjs temporary harvest launcher",
            basis: "temporary_asset",
            status: "promotion_required",
            evidenceRefs: ["art_log"],
            acceptanceConditions: ["promote launcher into ops/ before formal skill"],
          },
        ],
        closure: {
          status: "partial",
          completed: ["feishu upload 18 links"],
          remainingWork: ["42 remaining of 60", "promote temporary launcher"],
          blockers: [],
        },
        claims: [
          {
            claimId: "claim_60",
            narrative: "completed 60/60 harvest",
            status: "contradicted",
            evidenceRefs: ["art_log"],
          },
        ],
        evidenceDebt: [],
        acceptanceConditions: ["18/60 partial", "tmp launcher is promotion candidate"],
      });
      runCloseExpect(runId, inputPath, env, {
        ok: true,
        result: "created",
        status: "partial",
      });
      note("2_douyin_partial_18_60", true, `run=${runId}`);
    }

    // --- 3 WeChat partial 30 captions / 9 of first 10 originals ---
    {
      const runId = `run_wx_${randomUUID().slice(0, 8)}`;
      const inputPath = join(root, "wx-input.json");
      writeJson(inputPath, {
        taskId: "task_wx_fixture",
        actor: "self-test",
        machine: { id: "windows-self-test", platform: "windows" },
        mode: "explorer",
        startedAt: "2026-08-03T05:00:00.000Z",
        endedAt: "2026-08-03T06:00:00.000Z",
        sources: [
          {
            repo: "windows:xhs-registry",
            branch: null,
            head: null,
            worktree: "not_applicable",
            changedFiles: [],
            commit: null,
            ahead: null,
            behind: null,
            pushed: null,
          },
        ],
        checks: [],
        runtime: baseRuntime(),
        deviceRefs: emptyDeviceRefs({ devices: ["01", "03"] }),
        effects: [
          {
            effectId: "eff_captions",
            kind: "file_written",
            status: "occurred",
            quantity: 30,
            payment: paymentNone(),
            evidenceRefs: ["art_log"],
          },
          {
            effectId: "eff_originals",
            kind: "other",
            status: "partial",
            quantity: 9,
            payment: paymentNone(),
            evidenceRefs: ["art_log"],
          },
        ],
        artifacts: [
          {
            artifactId: "art_log",
            kind: "log",
            rootRef: "windows:self-test",
            path: "sample.log",
            redacted: false,
          },
        ],
        candidates: [],
        closure: {
          status: "partial",
          completed: ["30 captions uploaded", "first-ten originals 9/10"],
          remainingWork: ["20 posts without original harvest", "post #8 missing image"],
          blockers: ["must not claim 30 nine-image completes"],
        },
        claims: [
          {
            claimId: "claim_30_nine",
            narrative: "30 posts each have nine original images",
            status: "contradicted",
            evidenceRefs: ["art_log"],
          },
        ],
        evidenceDebt: [],
        acceptanceConditions: [
          "partial: 30 captions, first-ten originals 9/10",
          "forbid narrative of 30 nine-image completion",
        ],
      });
      runCloseExpect(runId, inputPath, env, {
        ok: true,
        result: "created",
        status: "partial",
      });
      note("3_wechat_partial_30_9of10", true, `run=${runId}`);
    }

    // --- 4 Weigou/Xianyu blocked waiting approval ---
    {
      const runId = `run_xy_${randomUUID().slice(0, 8)}`;
      const inputPath = join(root, "xy-input.json");
      writeJson(inputPath, {
        taskId: "task_xy_fixture",
        actor: "self-test",
        machine: { id: "windows-self-test", platform: "windows" },
        mode: "runner",
        startedAt: "2026-08-03T07:00:00.000Z",
        endedAt: "2026-08-03T08:00:00.000Z",
        sources: [
          {
            repo: "windows:xhs-registry",
            branch: null,
            head: null,
            worktree: "not_applicable",
            changedFiles: [],
            commit: null,
            ahead: null,
            behind: null,
            pushed: null,
          },
        ],
        checks: [],
        runtime: baseRuntime(),
        deviceRefs: emptyDeviceRefs({
          devices: ["02"],
          jobs: ["job_waiting_approval_fixture"],
        }),
        effects: [
          {
            effectId: "eff_draft",
            kind: "draft_saved",
            status: "not_occurred",
            quantity: 0,
            payment: paymentNone(),
            evidenceRefs: [],
          },
        ],
        artifacts: [
          {
            artifactId: "art_log",
            kind: "log",
            rootRef: "windows:self-test",
            path: "sample.log",
            redacted: false,
          },
        ],
        candidates: [],
        closure: {
          status: "blocked",
          completed: ["material prepared", "job submitted"],
          remainingWork: ["human approval", "verify savedDraft business effect"],
          blockers: ["waiting_approval"],
        },
        claims: [
          {
            claimId: "claim_draft_done",
            narrative: "draft already saved on device",
            status: "contradicted",
            evidenceRefs: [],
          },
        ],
        evidenceDebt: [],
        acceptanceConditions: [
          "blocked while waiting_approval",
          "draft_saved must remain not_occurred",
        ],
      });
      runCloseExpect(runId, inputPath, env, {
        ok: true,
        result: "created",
        status: "blocked",
      });
      note("4_xianyu_blocked_waiting_approval", true, `run=${runId}`);
    }

    // --- 5 already_harvested ---
    {
      const runId = `run_idem_${randomUUID().slice(0, 8)}`;
      const inputPath = join(root, "idem-input.json");
      const body = {
        taskId: "task_idem",
        actor: "self-test",
        machine: { id: "windows-self-test", platform: "windows" },
        mode: "engineering",
        startedAt: "2026-08-03T09:00:00.000Z",
        endedAt: "2026-08-03T09:05:00.000Z",
        sources: [
          {
            repo: "windows:self-test",
            branch: null,
            head: null,
            worktree: "not_applicable",
            changedFiles: [],
            commit: null,
            ahead: null,
            behind: null,
            pushed: null,
          },
        ],
        checks: [],
        runtime: baseRuntime(),
        deviceRefs: emptyDeviceRefs(),
        effects: [],
        artifacts: [],
        candidates: [],
        closure: {
          status: "completed",
          completed: ["idempotency fixture"],
          remainingWork: [],
          blockers: [],
        },
        claims: [],
        evidenceDebt: [],
        acceptanceConditions: ["repeat close => already_harvested"],
      };
      writeJson(inputPath, body);
      seedWork(
        runId,
        { goal: "idempotency fixture", taskId: "task_idem", actor: "self-test", mode: "engineering" },
        [
        {
          ts: "2026-08-03T09:01:00.000Z",
          stepId: "step_idem_1",
          kind: "decision",
          title: "idempotent close",
          status: "ok",
          commandOrRef: null,
          exitCode: null,
          evidence: [],
          blockerReason: null,
          notes: null,
        },
      ],
      );
      runCloseExpect(runId, inputPath, env, { ok: true, result: "created", status: "completed" });
      runCloseExpect(runId, inputPath, env, {
        ok: true,
        result: "already_harvested",
        includes: ["already_harvested"],
      });
      note("5_already_harvested", true, `run=${runId}`);
    }

    // --- 6a crash/restart same staging ---
    {
      const runId = `run_crash_${randomUUID().slice(0, 8)}`;
      const inputPath = join(root, "crash-input.json");
      const body = {
        taskId: "task_crash",
        actor: "self-test",
        machine: { id: "windows-self-test", platform: "windows" },
        mode: "engineering",
        startedAt: "2026-08-03T10:00:00.000Z",
        endedAt: "2026-08-03T10:01:00.000Z",
        sources: [
          {
            repo: "windows:self-test",
            branch: null,
            head: null,
            worktree: "not_applicable",
            changedFiles: [],
            commit: null,
            ahead: null,
            behind: null,
            pushed: null,
          },
        ],
        checks: [],
        runtime: baseRuntime(),
        deviceRefs: emptyDeviceRefs(),
        effects: [],
        artifacts: [],
        candidates: [],
        closure: {
          status: "unverified",
          completed: [],
          remainingWork: ["finish crash fixture"],
          blockers: [],
        },
        claims: [],
        evidenceDebt: [],
        acceptanceConditions: ["crash staging resume"],
      };
      writeJson(inputPath, body);
      const inputBytes = readFileSync(inputPath);
      const inputHash = sha256Bytes(inputBytes);
      const staging = join(outbox, ".staging", `${runId}-${inputHash}`);
      mkdirSync(staging, { recursive: true });
      writeFileSync(join(staging, "closeout.v1.json"), "{}\n");
      runCloseExpect(runId, inputPath, env, { ok: true, result: "created" });
      if (!existsSync(join(outbox, runId, "manifest.sha256"))) {
        throw new Error("final bundle missing after crash resume");
      }
      note("6a_crash_restart_staging", true, `run=${runId}`);
    }

    // --- 6b conflict different content same runId ---
    {
      const runId = `run_conflict_${randomUUID().slice(0, 8)}`;
      const input1 = join(root, "conflict-a.json");
      const input2 = join(root, "conflict-b.json");
      const mk = (title) => ({
        taskId: "task_conflict",
        actor: "self-test",
        machine: { id: "windows-self-test", platform: "windows" },
        mode: "engineering",
        startedAt: "2026-08-03T11:00:00.000Z",
        endedAt: "2026-08-03T11:01:00.000Z",
        sources: [
          {
            repo: "windows:self-test",
            branch: null,
            head: null,
            worktree: "not_applicable",
            changedFiles: [],
            commit: null,
            ahead: null,
            behind: null,
            pushed: null,
          },
        ],
        checks: [],
        runtime: baseRuntime(),
        deviceRefs: emptyDeviceRefs(),
        effects: [],
        artifacts: [],
        candidates: [],
        closure: {
          status: "completed",
          completed: [title],
          remainingWork: [],
          blockers: [],
        },
        claims: [],
        evidenceDebt: [],
        acceptanceConditions: ["conflict"],
      });
      writeJson(input1, mk("first"));
      writeJson(input2, mk("second-different"));
      seedWork(
        runId,
        { goal: "conflict fixture", taskId: "task_conflict", actor: "self-test", mode: "engineering" },
        [
        {
          ts: "2026-08-03T11:00:30.000Z",
          stepId: "step_conflict_1",
          kind: "decision",
          title: "first close",
          status: "ok",
          commandOrRef: null,
          exitCode: null,
          evidence: [],
          blockerReason: null,
          notes: null,
        },
      ],
      );
      runCloseExpect(runId, input1, env, { ok: true, result: "created" });
      runCloseExpect(runId, input2, env, {
        ok: false,
        includes: ["CLOSEOUT_FAILED", "conflict"],
      });
      note("6b_manifest_hash_conflict", true, `run=${runId}`);
    }

    // --- 6c path traversal ---
    {
      const runId = `run_trav_${randomUUID().slice(0, 8)}`;
      const inputPath = join(root, "trav-input.json");
      writeJson(inputPath, {
        taskId: "task_trav",
        actor: "self-test",
        machine: { id: "windows-self-test", platform: "windows" },
        mode: "engineering",
        startedAt: "2026-08-03T12:00:00.000Z",
        endedAt: "2026-08-03T12:01:00.000Z",
        sources: [
          {
            repo: "windows:self-test",
            branch: null,
            head: null,
            worktree: "not_applicable",
            changedFiles: [],
            commit: null,
            ahead: null,
            behind: null,
            pushed: null,
          },
        ],
        checks: [],
        runtime: baseRuntime(),
        deviceRefs: emptyDeviceRefs(),
        effects: [],
        artifacts: [
          {
            artifactId: "art_bad",
            kind: "log",
            rootRef: "windows:self-test",
            path: "../outside.txt",
            redacted: false,
          },
        ],
        candidates: [],
        closure: {
          status: "unverified",
          completed: [],
          remainingWork: [],
          blockers: [],
        },
        claims: [],
        evidenceDebt: [],
        acceptanceConditions: ["reject traversal"],
      });
      runCloseExpect(runId, inputPath, env, {
        ok: false,
        includes: ["CLOSEOUT_FAILED"],
      });
      note("6c_path_traversal", true, `run=${runId}`);
    }

    // --- 6d symlink escape ---
    {
      const runId = `run_sym_${randomUUID().slice(0, 8)}`;
      const outside = join(root, "outside-secret.txt");
      writeFileSync(outside, "secret-outside\n");
      const linkPath = join(artRoot, "escape-link.txt");
      let symlinkOk = false;
      try {
        try {
          rmSync(linkPath, { force: true });
        } catch {
          // ignore
        }
        symlinkSync(outside, linkPath);
        symlinkOk = existsSync(linkPath) && lstatSync(linkPath).isSymbolicLink();
      } catch {
        symlinkOk = false;
      }
      if (!symlinkOk) {
        note("6d_symlink_escape", true, "skipped (symlink privilege unavailable)");
      } else {
        const inputPath = join(root, "sym-input.json");
        writeJson(inputPath, {
          taskId: "task_sym",
          actor: "self-test",
          machine: { id: "windows-self-test", platform: "windows" },
          mode: "engineering",
          startedAt: "2026-08-03T12:10:00.000Z",
          endedAt: "2026-08-03T12:11:00.000Z",
          sources: [
            {
              repo: "windows:self-test",
              branch: null,
              head: null,
              worktree: "not_applicable",
              changedFiles: [],
              commit: null,
              ahead: null,
              behind: null,
              pushed: null,
            },
          ],
          checks: [],
          runtime: baseRuntime(),
          deviceRefs: emptyDeviceRefs(),
          effects: [],
          artifacts: [
            {
              artifactId: "art_sym",
              kind: "log",
              rootRef: "windows:self-test",
              path: "escape-link.txt",
              redacted: false,
            },
          ],
          candidates: [],
          closure: {
            status: "unverified",
            completed: [],
            remainingWork: [],
            blockers: [],
          },
          claims: [],
          evidenceDebt: [],
          acceptanceConditions: ["reject symlink escape"],
        });
        runCloseExpect(runId, inputPath, env, {
          ok: false,
          includes: ["CLOSEOUT_FAILED"],
        });
        note("6d_symlink_escape", true, `run=${runId}`);
      }
    }

    // --- 6e secret redaction ---
    {
      const runId = `run_sec_${randomUUID().slice(0, 8)}`;
      const inputPath = join(root, "sec-input.json");
      writeJson(inputPath, {
        taskId: "task_sec",
        actor: "self-test",
        machine: { id: "windows-self-test", platform: "windows" },
        mode: "engineering",
        startedAt: "2026-08-03T13:00:00.000Z",
        endedAt: "2026-08-03T13:01:00.000Z",
        sources: [
          {
            repo: "windows:self-test",
            branch: null,
            head: null,
            worktree: "not_applicable",
            changedFiles: [],
            commit: null,
            ahead: null,
            behind: null,
            pushed: null,
          },
        ],
        checks: [],
        runtime: baseRuntime(),
        deviceRefs: emptyDeviceRefs(),
        effects: [],
        artifacts: [],
        candidates: [],
        closure: {
          status: "completed",
          completed: ["secret redaction"],
          remainingWork: [],
          blockers: [],
        },
        claims: [
          {
            claimId: "claim_sec",
            narrative: "a credential field was present in input metadata",
            status: "unverified",
            evidenceRefs: [],
          },
        ],
        evidenceDebt: [
          {
            debtId: "debt_sec_meta",
            code: "SECRET_IN_INPUT",
            severity: "low",
            summary: "input contained a secret-looking field that must be stripped",
            evidenceRefs: [],
            api_token: "super-secret-value",
          },
        ],
        acceptanceConditions: ["secrets redacted"],
      });
      seedWork(
        runId,
        { goal: "secret redaction fixture", taskId: "task_sec", actor: "self-test", mode: "engineering" },
        [
        {
          ts: "2026-08-03T13:00:30.000Z",
          stepId: "step_sec_1",
          kind: "decision",
          title: "strip secret fields",
          status: "ok",
          commandOrRef: null,
          exitCode: null,
          evidence: [],
          blockerReason: null,
          notes: null,
        },
      ],
      );
      runCloseExpect(runId, inputPath, env, { ok: true, result: "created", status: "completed" });
      const co = JSON.parse(
        readFileSync(join(outbox, runId, "closeout.v1.json"), "utf8"),
      );
      const blob = JSON.stringify(co);
      if (blob.includes("super-secret-value")) {
        throw new Error("secret value leaked into closeout");
      }
      if (!co.evidenceDebt.some((d) => d.code === "SECRET_FIELD_REDACTED")) {
        throw new Error("expected SECRET_FIELD_REDACTED debt");
      }
      if (co.evidenceDebt.some((d) => Object.prototype.hasOwnProperty.call(d, "api_token"))) {
        throw new Error("api_token key must be stripped from debt objects");
      }
      note("6e_secret_redaction", true, `run=${runId}`);
    }

    // --- 6f artifact missing records debt ---
    {
      const runId = `run_miss_${randomUUID().slice(0, 8)}`;
      const inputPath = join(root, "miss-input.json");
      writeJson(inputPath, {
        taskId: "task_miss",
        actor: "self-test",
        machine: { id: "windows-self-test", platform: "windows" },
        mode: "engineering",
        startedAt: "2026-08-03T14:00:00.000Z",
        endedAt: "2026-08-03T14:01:00.000Z",
        sources: [
          {
            repo: "windows:self-test",
            branch: null,
            head: null,
            worktree: "not_applicable",
            changedFiles: [],
            commit: null,
            ahead: null,
            behind: null,
            pushed: null,
          },
        ],
        checks: [],
        runtime: baseRuntime(),
        deviceRefs: emptyDeviceRefs(),
        effects: [],
        artifacts: [
          {
            artifactId: "art_missing",
            kind: "log",
            rootRef: "windows:self-test",
            path: "does-not-exist.log",
            redacted: false,
          },
        ],
        candidates: [],
        closure: {
          status: "unverified",
          completed: [],
          remainingWork: ["provide missing artifact"],
          blockers: [],
        },
        claims: [],
        evidenceDebt: [],
        acceptanceConditions: ["missing artifact => debt"],
      });
      runCloseExpect(runId, inputPath, env, { ok: true, result: "created" });
      const co = JSON.parse(
        readFileSync(join(outbox, runId, "closeout.v1.json"), "utf8"),
      );
      if (co.artifacts[0].availability !== "missing") {
        throw new Error("expected availability=missing");
      }
      if (!co.evidenceDebt.some((d) => d.code === "ARTIFACT_MISSING")) {
        throw new Error("expected ARTIFACT_MISSING debt");
      }
      note("6f_artifact_missing_debt", true, `run=${runId}`);
    }

    // --- Phase 0 compat: manifest fields + redacted keeps hash + UTF-8 BOM ---
    {
      const runId = `run_p0_${randomUUID().slice(0, 8)}`;
      const inputPath = join(root, "p0-input.json");
      const secretArt = join(artRoot, "secret-meta.bin");
      writeFileSync(secretArt, Buffer.from("redacted-present-bytes\n"));
      const secretSha = sha256File(secretArt);
      const secretSize = lstatSync(secretArt).size;
      const body = {
        taskId: "task_phase0",
        actor: "self-test",
        machine: { id: "windows-self-test", platform: "windows" },
        mode: "engineering",
        startedAt: "2026-08-03T15:00:00.000Z",
        endedAt: "2026-08-03T15:01:00.000Z",
        sources: [
          {
            repo: "windows:self-test",
            branch: null,
            head: null,
            worktree: "not_applicable",
            changedFiles: [],
            commit: null,
            ahead: null,
            behind: null,
            pushed: null,
          },
        ],
        checks: [],
        runtime: baseRuntime(),
        deviceRefs: emptyDeviceRefs(),
        effects: [],
        artifacts: [
          {
            artifactId: "art_redacted_present",
            kind: "attachment",
            rootRef: "windows:self-test",
            path: "secret-meta.bin",
            redacted: true,
          },
        ],
        candidates: [],
        closure: {
          status: "partial",
          completed: ["phase0 compat fixture"],
          remainingWork: [],
          blockers: [],
        },
        claims: [],
        evidenceDebt: [],
        acceptanceConditions: ["phase0 manifest/redacted/bom"],
      };
      // Write with UTF-8 BOM
      const jsonText = stableStringify(body);
      writeFileSync(inputPath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(jsonText, "utf8")]));
      runCloseExpect(runId, inputPath, env, { ok: true, result: "created", status: "partial" });
      const co = JSON.parse(readFileSync(join(outbox, runId, "closeout.v1.json"), "utf8"));
      const man = JSON.parse(readFileSync(join(outbox, runId, "manifest.json"), "utf8"));
      if (man.schemaVersion !== 1) throw new Error("manifest.schemaVersion must be 1");
      if (!("producerCommit" in man)) throw new Error("manifest.producerCommit missing");
      if (man.producerCommit !== co.producer.commit) {
        throw new Error("manifest.producerCommit must equal closeout.producer.commit");
      }
      if (man.contractSha256 !== co.producer.contractSha256) {
        throw new Error("manifest.contractSha256 must equal closeout.producer.contractSha256");
      }
      if (man.contractSha256 !== CONTRACT_SHA256) {
        throw new Error("manifest.contractSha256 mismatch vs fixed contract");
      }
      const art = co.artifacts.find((a) => a.artifactId === "art_redacted_present");
      if (!art || art.redacted !== true || art.availability !== "present") {
        throw new Error("redacted artifact must remain present+redacted");
      }
      if (art.sha256 !== secretSha) {
        throw new Error(`redacted artifact must keep sha256, got ${art.sha256}`);
      }
      if (art.bytes !== secretSize) {
        throw new Error(`redacted artifact must keep bytes, got ${art.bytes}`);
      }
      // Bundle must not embed attachment content
      const closeBlob = readFileSync(join(outbox, runId, "closeout.v1.json"), "utf8");
      if (closeBlob.includes("redacted-present-bytes")) {
        throw new Error("closeout must not copy attachment content");
      }
      note("phase0_manifest_redacted_bom", true, `run=${runId}`);
    }

    // --- Phase 1: work ledger complete / missing / step CLI ---
    {
      const beginOut = execFileSync(
        process.execPath,
        [
          SCRIPT_PATH,
          "begin",
          "--mode",
          "explorer",
          "--actor",
          "self-test",
          "--goal",
          "phase1 ledger complete",
        ],
        { encoding: "utf8", env: { ...process.env, ...env }, windowsHide: true },
      );
      const began = JSON.parse(beginOut);
      const runId = began.runId;
      const stepPath = join(root, "phase1-step.json");
      writeJson(stepPath, {
        kind: "script",
        title: "run sample script",
        status: "ok",
        commandOrRef: "node ops/example.mjs",
        exitCode: 0,
        evidence: [{ rootRef: "windows:self-test", path: "sample.log" }],
      });
      execFileSync(
        process.execPath,
        [SCRIPT_PATH, "step", "--run", runId, "--input", stepPath],
        { encoding: "utf8", env: { ...process.env, ...env }, windowsHide: true },
      );
      const inputPath = join(root, "phase1-complete-input.json");
      writeJson(inputPath, {
        taskId: began.taskId,
        actor: "self-test",
        machine: { id: "windows-self-test", platform: "windows" },
        mode: "explorer",
        startedAt: began.startedAt,
        endedAt: "2026-08-03T16:00:00.000Z",
        sources: [
          {
            repo: "windows:self-test",
            branch: null,
            head: null,
            worktree: "not_applicable",
            changedFiles: [],
            commit: null,
            ahead: null,
            behind: null,
            pushed: null,
          },
        ],
        checks: [],
        runtime: baseRuntime(),
        deviceRefs: emptyDeviceRefs(),
        effects: [],
        artifacts: [],
        candidates: [],
        closure: {
          status: "completed",
          completed: ["phase1 ledger"],
          remainingWork: [],
          blockers: [],
        },
        claims: [],
        evidenceDebt: [],
        acceptanceConditions: ["task+steps present allows completed"],
      });
      runCloseExpect(runId, inputPath, env, {
        ok: true,
        result: "created",
        status: "completed",
      });
      const co = JSON.parse(readFileSync(join(outbox, runId, "closeout.v1.json"), "utf8"));
      if (!co.artifacts.some((a) => a.artifactId === `work_task_${runId}` && a.sha256)) {
        throw new Error("missing work_task artifact hash");
      }
      if (!co.artifacts.some((a) => a.artifactId === `work_steps_${runId}` && a.sha256)) {
        throw new Error("missing work_steps artifact hash");
      }
      if (co.evidenceDebt.some((d) => d.code === "TASK_BRIEF_MISSING" || d.code === "STEPS_JOURNAL_MISSING")) {
        throw new Error("complete ledger should not have task/steps missing debt");
      }
      note("phase1_ledger_complete", true, `run=${runId}`);
    }

    {
      const runId = `run_p1_miss_${randomUUID().slice(0, 8)}`;
      const inputPath = join(root, "phase1-missing-input.json");
      writeJson(inputPath, {
        taskId: "task_p1_miss",
        actor: "self-test",
        machine: { id: "windows-self-test", platform: "windows" },
        mode: "engineering",
        startedAt: "2026-08-03T16:10:00.000Z",
        endedAt: "2026-08-03T16:11:00.000Z",
        sources: [
          {
            repo: "windows:self-test",
            branch: null,
            head: null,
            worktree: "not_applicable",
            changedFiles: [],
            commit: null,
            ahead: null,
            behind: null,
            pushed: null,
          },
        ],
        checks: [],
        runtime: baseRuntime(),
        deviceRefs: emptyDeviceRefs(),
        effects: [],
        artifacts: [],
        candidates: [],
        closure: {
          status: "completed",
          completed: ["should be demoted"],
          remainingWork: [],
          blockers: [],
        },
        claims: [],
        evidenceDebt: [],
        acceptanceConditions: ["missing ledger demotes completed"],
      });
      // no seedWork
      runCloseExpect(runId, inputPath, env, {
        ok: true,
        result: "created",
        status: "unverified",
      });
      const co = JSON.parse(readFileSync(join(outbox, runId, "closeout.v1.json"), "utf8"));
      if (!co.evidenceDebt.some((d) => d.code === "TASK_BRIEF_MISSING")) {
        throw new Error("expected TASK_BRIEF_MISSING");
      }
      if (!co.evidenceDebt.some((d) => d.code === "STEPS_JOURNAL_MISSING")) {
        throw new Error("expected STEPS_JOURNAL_MISSING");
      }
      if (co.closure.status === "completed") {
        throw new Error("completed forbidden without ledger");
      }
      note("phase1_ledger_missing_debt", true, `run=${runId}`);
    }

    // --- Phase1 NO-GO fixes: symlink escape / wrong-run / malformed steps ---
    {
      const runId = `run_p1_sym_${randomUUID().slice(0, 8)}`;
      const outside = join(root, "outside-steps.jsonl");
      const outsideBody = '{"ts":"2026-08-03T17:00:00.000Z","stepId":"step_out","kind":"script","title":"outside","status":"ok"}\n';
      writeFileSync(outside, outsideBody);
      seedWork(
        runId,
        { goal: "symlink escape", taskId: "task_sym", actor: "self-test", mode: "engineering" },
        [
          {
            ts: "2026-08-03T17:00:00.000Z",
            stepId: "step_ok",
            kind: "decision",
            title: "before replace",
            status: "ok",
            commandOrRef: null,
            exitCode: null,
            evidence: [],
            blockerReason: null,
            notes: null,
          },
        ],
      );
      const stepsPath = join(work, runId, "steps.jsonl");
      let linked = false;
      try {
        rmSync(stepsPath, { force: true });
        symlinkSync(outside, stepsPath);
        linked = existsSync(stepsPath) && lstatSync(stepsPath).isSymbolicLink();
      } catch {
        linked = false;
      }
      if (!linked) {
        note("phase1_steps_symlink_escape", true, "skipped (symlink privilege unavailable)");
      } else {
        const inputPath = join(root, "phase1-sym-input.json");
        writeJson(inputPath, {
          taskId: "task_sym",
          actor: "self-test",
          machine: { id: "windows-self-test", platform: "windows" },
          mode: "engineering",
          startedAt: "2026-08-03T17:00:00.000Z",
          endedAt: "2026-08-03T17:01:00.000Z",
          sources: [
            {
              repo: "windows:self-test",
              branch: null,
              head: null,
              worktree: "not_applicable",
              changedFiles: [],
              commit: null,
              ahead: null,
              behind: null,
              pushed: null,
            },
          ],
          checks: [],
          runtime: baseRuntime(),
          deviceRefs: emptyDeviceRefs(),
          effects: [],
          artifacts: [],
          candidates: [],
          closure: {
            status: "completed",
            completed: ["should fail closed"],
            remainingWork: [],
            blockers: [],
          },
          claims: [],
          evidenceDebt: [],
          acceptanceConditions: ["symlink fail closed"],
        });
        runCloseExpect(runId, inputPath, env, {
          ok: false,
          includes: ["CLOSEOUT_FAILED", "symlink"],
        });
        const after = readFileSync(outside, "utf8");
        if (after !== outsideBody) {
          throw new Error("outside symlink target bytes changed");
        }
        note("phase1_steps_symlink_escape", true, `run=${runId}`);
      }
    }

    {
      const runId = `run_p1_wrong_${randomUUID().slice(0, 8)}`;
      seedWork(
        runId,
        {
          goal: "wrong run identity",
          taskId: "task_wrong",
          actor: "self-test",
          mode: "engineering",
        },
        [
          {
            ts: "2026-08-03T17:10:00.000Z",
            stepId: "step_wrong_1",
            kind: "decision",
            title: "ok step",
            status: "ok",
            commandOrRef: null,
            exitCode: null,
            evidence: [],
            blockerReason: null,
            notes: null,
          },
        ],
      );
      // Corrupt identity: different runId inside task.json
      writeFileSync(
        join(work, runId, "task.json"),
        stableStringify({
          taskId: "task_wrong",
          runId: "run_other_identity",
          goal: "wrong run identity",
          mode: "engineering",
          actor: "self-test",
          acceptance: [],
          outOfScope: [],
          startedAt: "2026-08-03T17:10:00.000Z",
        }),
      );
      const inputPath = join(root, "phase1-wrong-input.json");
      writeJson(inputPath, {
        taskId: "task_wrong",
        actor: "self-test",
        machine: { id: "windows-self-test", platform: "windows" },
        mode: "engineering",
        startedAt: "2026-08-03T17:10:00.000Z",
        endedAt: "2026-08-03T17:11:00.000Z",
        sources: [
          {
            repo: "windows:self-test",
            branch: null,
            head: null,
            worktree: "not_applicable",
            changedFiles: [],
            commit: null,
            ahead: null,
            behind: null,
            pushed: null,
          },
        ],
        checks: [],
        runtime: baseRuntime(),
        deviceRefs: emptyDeviceRefs(),
        effects: [],
        artifacts: [],
        candidates: [],
        closure: {
          status: "completed",
          completed: ["should demote"],
          remainingWork: [],
          blockers: [],
        },
        claims: [],
        evidenceDebt: [],
        acceptanceConditions: ["wrong-run demote"],
      });
      runCloseExpect(runId, inputPath, env, {
        ok: true,
        result: "created",
        status: "unverified",
      });
      const co = JSON.parse(readFileSync(join(outbox, runId, "closeout.v1.json"), "utf8"));
      if (!co.evidenceDebt.some((d) => d.code === "TASK_BRIEF_INVALID")) {
        throw new Error("expected TASK_BRIEF_INVALID");
      }
      if (co.closure.status === "completed") throw new Error("wrong-run must demote completed");
      note("phase1_wrong_run_task", true, `run=${runId}`);
    }

    {
      const runId = `run_p1_badsteps_${randomUUID().slice(0, 8)}`;
      seedWork(
        runId,
        {
          goal: "malformed steps",
          taskId: "task_badsteps",
          actor: "self-test",
          mode: "engineering",
        },
        [],
      );
      writeFileSync(
        join(work, runId, "steps.jsonl"),
        '{"ts":"2026-08-03T17:20:00.000Z","stepId":"step_a","kind":"decision","title":"ok","status":"ok"}\n{not-json\n',
      );
      const inputPath = join(root, "phase1-badsteps-input.json");
      writeJson(inputPath, {
        taskId: "task_badsteps",
        actor: "self-test",
        machine: { id: "windows-self-test", platform: "windows" },
        mode: "engineering",
        startedAt: "2026-08-03T17:20:00.000Z",
        endedAt: "2026-08-03T17:21:00.000Z",
        sources: [
          {
            repo: "windows:self-test",
            branch: null,
            head: null,
            worktree: "not_applicable",
            changedFiles: [],
            commit: null,
            ahead: null,
            behind: null,
            pushed: null,
          },
        ],
        checks: [],
        runtime: baseRuntime(),
        deviceRefs: emptyDeviceRefs(),
        effects: [],
        artifacts: [],
        candidates: [],
        closure: {
          status: "completed",
          completed: ["should demote"],
          remainingWork: [],
          blockers: [],
        },
        claims: [],
        evidenceDebt: [],
        acceptanceConditions: ["malformed steps demote"],
      });
      runCloseExpect(runId, inputPath, env, {
        ok: true,
        result: "created",
        status: "unverified",
      });
      const co = JSON.parse(readFileSync(join(outbox, runId, "closeout.v1.json"), "utf8"));
      if (!co.evidenceDebt.some((d) => d.code === "STEPS_JOURNAL_INVALID")) {
        throw new Error("expected STEPS_JOURNAL_INVALID");
      }
      if (co.closure.status === "completed") {
        throw new Error("malformed steps must demote completed");
      }
      note("phase1_malformed_steps", true, `run=${runId}`);
    }

    {
      const runId = `run_p1_dirsteps_${randomUUID().slice(0, 8)}`;
      seedWork(
        runId,
        {
          goal: "steps is directory",
          taskId: "task_dirsteps",
          actor: "self-test",
          mode: "engineering",
        },
        [
          {
            ts: "2026-08-03T17:30:00.000Z",
            stepId: "step_tmp",
            kind: "decision",
            title: "tmp",
            status: "ok",
            commandOrRef: null,
            exitCode: null,
            evidence: [],
            blockerReason: null,
            notes: null,
          },
        ],
      );
      const stepsPath = join(work, runId, "steps.jsonl");
      rmSync(stepsPath, { force: true });
      mkdirSync(stepsPath);
      const inputPath = join(root, "phase1-dirsteps-input.json");
      writeJson(inputPath, {
        taskId: "task_dirsteps",
        actor: "self-test",
        machine: { id: "windows-self-test", platform: "windows" },
        mode: "engineering",
        startedAt: "2026-08-03T17:30:00.000Z",
        endedAt: "2026-08-03T17:31:00.000Z",
        sources: [
          {
            repo: "windows:self-test",
            branch: null,
            head: null,
            worktree: "not_applicable",
            changedFiles: [],
            commit: null,
            ahead: null,
            behind: null,
            pushed: null,
          },
        ],
        checks: [],
        runtime: baseRuntime(),
        deviceRefs: emptyDeviceRefs(),
        effects: [],
        artifacts: [],
        candidates: [],
        closure: {
          status: "completed",
          completed: ["should fail closed"],
          remainingWork: [],
          blockers: [],
        },
        claims: [],
        evidenceDebt: [],
        acceptanceConditions: ["non-regular steps fail closed"],
      });
      runCloseExpect(runId, inputPath, env, {
        ok: false,
        includes: ["CLOSEOUT_FAILED", "regular file"],
      });
      note("phase1_steps_nonregular_file", true, `run=${runId}`);
    }

    // --- schema v1: Phase2-shaped TEMP normalize (positive) ---
    {
      const runId = `run_schema_p2norm_${randomUUID().slice(0, 8)}`;
      const inputPath = join(root, "schema-p2-norm-input.json");
      // Desensitized structure only — no real Phase2 attachment bytes.
      writeJson(inputPath, {
        taskId: "task_schema_p2_norm",
        actor: "self-test",
        machine: { id: "windows-self-test", platform: "windows" },
        mode: "explorer",
        startedAt: "2026-08-03T12:00:00.000Z",
        endedAt: "2026-08-03T13:00:00.000Z",
        sources: [
          {
            repo: "windows:self-test",
            branch: "main",
            head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            worktree: "dirty",
            changedFiles: ["AGENTS.md", { path: "ops/xw-closeout.mjs", status: "modified" }],
            commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            ahead: 0,
            behind: 0,
            pushed: true,
          },
        ],
        checks: [
          {
            id: "check_e2e",
            kind: "e2e",
            status: "pass",
            exitCode: 0,
            observedAt: "2026-08-03T12:10:00.000Z",
            evidenceRefs: ["art_log"],
          },
          {
            id: "check_preflight",
            kind: "preflight",
            status: "pass",
            exitCode: 0,
            observedAt: "2026-08-03T12:11:00.000Z",
            evidenceRefs: [],
          },
          {
            id: "check_observe",
            kind: "observe",
            status: "pass",
            exitCode: 0,
            observedAt: "2026-08-03T12:12:00.000Z",
            evidenceRefs: ["art_shot"],
          },
        ],
        runtime: {
          controlPlane: {
            status: "not_performed",
            observedAt: null,
            evidenceRefs: [],
          },
          deployment: {
            status: "not_performed",
            observedAt: null,
            evidenceRefs: [],
          },
          reload: {
            status: "not_performed",
            observedAt: null,
            evidenceRefs: [],
          },
          serve: {
            status: "not_performed",
            observedAt: null,
            evidenceRefs: [],
          },
        },
        deviceRefs: {
          devices: ["01"],
          // runs/sessions intentionally omitted → filled to []
          jobs: ["job_schema_fixture"],
          leases: [],
          evidenceRefs: [],
          aliases: ["01"],
        },
        effects: [
          {
            effectId: "eff_links",
            kind: "other",
            status: "occurred",
            quantity: 3,
            payment: paymentNone(),
            evidenceRefs: ["art_log"],
          },
        ],
        artifacts: [
          {
            artifactId: "art_log",
            kind: "data",
            rootRef: "windows:self-test",
            path: "sample.log",
            redacted: false,
          },
          {
            artifactId: "art_shot",
            kind: "image",
            rootRef: "windows:self-test",
            path: "sample.log",
            redacted: false,
          },
          {
            artifactId: "art_note",
            kind: "note",
            rootRef: "windows:self-test",
            path: "sample.log",
            redacted: false,
          },
        ],
        candidates: [
          {
            candidateId: "cand_schema_recipe",
            kind: "recipe",
            title: "desensitized phase2-shaped recipe",
            basis: "repeatable_workflow",
            status: "proposed",
            evidenceRefs: ["art_log"],
            acceptanceConditions: [
              "normalized enums seal",
              { text: "acceptanceConditions become strings" },
            ],
          },
        ],
        closure: {
          status: "completed",
          completed: ["schema normalize"],
          remainingWork: [],
          blockers: [],
        },
        claims: [
          {
            claimId: "claim_norm",
            narrative: "aliases mapped to canonical enums",
            status: "supported",
            evidenceRefs: ["art_log"],
          },
        ],
        evidenceDebt: [],
        acceptanceConditions: [
          "top-level AC string",
          { text: "top-level AC from text object", id: "ac_tmp", status: "met" },
        ],
      });
      seedWork(
        runId,
        {
          goal: "schema p2 normalize",
          taskId: "task_schema_p2_norm",
          actor: "self-test",
          mode: "explorer",
        },
        [
          {
            ts: "2026-08-03T12:05:00.000Z",
            stepId: "step_schema_norm",
            kind: "decision",
            title: "schema normalize fixture",
            status: "ok",
            commandOrRef: null,
            exitCode: null,
            evidence: [],
            blockerReason: null,
            notes: null,
          },
        ],
      );
      runCloseExpect(runId, inputPath, env, {
        ok: true,
        result: "created",
        status: "completed",
      });
      const co = JSON.parse(readFileSync(join(outbox, runId, "closeout.v1.json"), "utf8"));
      if (!co.sources[0].changedFiles.every((f) => f && typeof f.path === "string" && f.status)) {
        throw new Error("changedFiles not normalized to objects");
      }
      if (co.sources[0].changedFiles[0].path !== "AGENTS.md") {
        throw new Error("string changedFile path lost");
      }
      if (co.checks.map((c) => c.kind).join(",") !== "test,check,other") {
        throw new Error(`check.kind aliases not mapped: ${co.checks.map((c) => c.kind)}`);
      }
      if (co.artifacts.filter((a) => a.artifactId.startsWith("art_")).map((a) => a.kind).join(",") !==
        "other,screenshot,other") {
        throw new Error(`artifact.kind aliases not mapped`);
      }
      if (Object.keys(co.runtime).sort().join(",") !== "deployment,reload,serve") {
        throw new Error("runtime must drop controlPlane");
      }
      for (const k of DEVICE_REF_KEYS) {
        if (!Array.isArray(co.deviceRefs[k])) throw new Error(`deviceRefs.${k} missing`);
      }
      if (co.deviceRefs.aliases) throw new Error("deviceRefs.aliases must be dropped");
      if (co.claims[0].status !== "proven") throw new Error("supported→proven failed");
      if (co.candidates[0].basis !== "repeatable_workflow" || co.candidates[0].status !== "proposed") {
        throw new Error("candidate contract enums not sealed");
      }
      if (!Array.isArray(co.acceptanceConditions) || co.acceptanceConditions.some((s) => typeof s !== "string")) {
        throw new Error("acceptanceConditions must be string[]");
      }
      if (
        !Array.isArray(co.candidates[0].acceptanceConditions) ||
        co.candidates[0].acceptanceConditions.some((s) => typeof s !== "string")
      ) {
        throw new Error("candidate.acceptanceConditions must be string[]");
      }
      const recipeArts = co.artifacts.filter((a) => a.kind === "recipe_spec");
      if (recipeArts.length !== 1) {
        throw new Error(`expected 1 recipe_spec artifact, got ${recipeArts.length}`);
      }
      if (recipeArts[0].availability !== "present" || !recipeArts[0].sha256) {
        throw new Error("recipe_spec artifact must be present with sha256");
      }
      if (!co.candidates[0].evidenceRefs.includes(recipeArts[0].artifactId)) {
        throw new Error("recipe candidate must reference recipe_spec artifact");
      }
      const man = JSON.parse(readFileSync(join(outbox, runId, "manifest.json"), "utf8"));
      const specFiles = (man.files || []).filter((f) => String(f.path).startsWith("recipe-specs/"));
      if (specFiles.length !== 1) {
        throw new Error(`manifest missing recipe-specs file (got ${specFiles.length})`);
      }
      const harvestSpec = join(outbox, runId, specFiles[0].path);
      if (!existsSync(harvestSpec)) throw new Error("harvest recipe-spec file missing");
      if (sha256File(harvestSpec) !== specFiles[0].sha256) {
        throw new Error("harvest recipe-spec sha mismatch");
      }
      note("schema_phase2_normalize_positive", true, `run=${runId}`);
    }

    // --- schema-negative fixtures (invalid input must not seal) ---
    function schemaNegative(name, mutate, includes) {
      const runId = `run_schema_neg_${name}_${randomUUID().slice(0, 8)}`;
      const inputPath = join(root, `schema-neg-${name}.json`);
      const base = {
        taskId: `task_schema_neg_${name}`,
        actor: "self-test",
        machine: { id: "windows-self-test", platform: "windows" },
        mode: "explorer",
        startedAt: "2026-08-03T14:00:00.000Z",
        endedAt: "2026-08-03T14:30:00.000Z",
        sources: [
          {
            repo: "windows:self-test",
            branch: null,
            head: null,
            worktree: "not_applicable",
            changedFiles: [],
            commit: null,
            ahead: null,
            behind: null,
            pushed: null,
          },
        ],
        checks: [
          {
            id: "check_ok",
            kind: "test",
            status: "pass",
            exitCode: 0,
            observedAt: "2026-08-03T14:01:00.000Z",
            evidenceRefs: [],
          },
        ],
        runtime: baseRuntime(),
        deviceRefs: emptyDeviceRefs({ devices: ["02"] }),
        effects: [
          {
            effectId: "eff_ok",
            kind: "other",
            status: "occurred",
            quantity: 1,
            payment: paymentNone(),
            evidenceRefs: [],
          },
        ],
        artifacts: [
          {
            artifactId: "art_log",
            kind: "log",
            rootRef: "windows:self-test",
            path: "sample.log",
            redacted: false,
          },
        ],
        candidates: [],
        closure: {
          status: "partial",
          completed: [],
          remainingWork: ["schema negative"],
          blockers: [],
        },
        claims: [
          {
            claimId: "claim_ok",
            narrative: "baseline claim",
            status: "unverified",
            evidenceRefs: [],
          },
        ],
        evidenceDebt: [],
        acceptanceConditions: ["schema negative must not seal"],
      };
      mutate(base);
      writeJson(inputPath, base);
      seedWork(
        runId,
        { goal: `schema neg ${name}`, taskId: `task_schema_neg_${name}`, mode: "explorer" },
        [],
      );
      runCloseExpect(runId, inputPath, env, {
        ok: false,
        includes: ["CLOSEOUT_FAILED", ...(includes || [])],
      });
      if (existsSync(join(outbox, runId))) {
        throw new Error(`schema-negative ${name} sealed harvest unexpectedly`);
      }
      const stagingParent = join(outbox, ".staging");
      if (existsSync(stagingParent)) {
        for (const nameEnt of readdirSync(stagingParent)) {
          if (nameEnt.startsWith(`${runId}-`)) {
            throw new Error(`schema-negative ${name} left staging ${nameEnt}`);
          }
        }
      }
      note(`schema_negative_${name}`, true, `run=${runId}`);
    }

    schemaNegative(
      "artifact_kind",
      (b) => {
        b.artifacts[0].kind = "banana";
      },
      ["artifact", "kind"],
    );
    schemaNegative(
      "check_kind",
      (b) => {
        b.checks[0].kind = "lint";
      },
      ["check", "kind"],
    );
    schemaNegative(
      "claim_status",
      (b) => {
        b.claims[0].status = "maybe";
      },
      ["claim", "status"],
    );
    schemaNegative(
      "claim_narrative",
      (b) => {
        delete b.claims[0].narrative;
      },
      ["narrative"],
    );
    schemaNegative(
      "runtime_status",
      (b) => {
        b.runtime.serve.status = "done";
      },
      ["runtime", "status"],
    );
    schemaNegative(
      "device_refs_type",
      (b) => {
        b.deviceRefs.devices = { alias: "02" };
      },
      ["deviceRefs"],
    );
    schemaNegative(
      "candidate_kind",
      (b) => {
        b.candidates = [
          {
            candidateId: "cand_bad",
            kind: "playbook",
            title: "bad",
            basis: "temporary_asset",
            status: "proposed",
            evidenceRefs: [],
            acceptanceConditions: ["x"],
          },
        ];
      },
      ["candidate", "kind"],
    );
    schemaNegative(
      "candidate_ac",
      (b) => {
        b.candidates = [
          {
            candidateId: "cand_bad_ac",
            kind: "recipe",
            title: "bad ac",
            basis: "temporary_asset",
            status: "proposed",
            evidenceRefs: [],
            acceptanceConditions: [{ id: "no_text_field" }],
          },
        ];
      },
      ["acceptanceConditions"],
    );
    schemaNegative(
      "old_basis_explorer_run",
      (b) => {
        b.candidates = [
          {
            candidateId: "cand_old_basis",
            kind: "recipe",
            title: "old basis",
            basis: "explorer_run",
            status: "proposed",
            evidenceRefs: [],
            acceptanceConditions: ["x"],
          },
        ];
      },
      ["basis", "explorer_run"],
    );
    schemaNegative(
      "old_status_ready_for_review",
      (b) => {
        b.candidates = [
          {
            candidateId: "cand_old_status",
            kind: "recipe",
            title: "old status",
            basis: "repeatable_workflow",
            status: "ready_for_review",
            evidenceRefs: [],
            acceptanceConditions: ["x"],
          },
        ];
      },
      ["status", "ready_for_review"],
    );
    schemaNegative(
      "payment_shape",
      (b) => {
        b.effects[0].payment = {
          amount: null,
          currency: null,
          occurred: false,
          evidenceRefs: [],
        };
      },
      ["payment"],
    );
    schemaNegative(
      "changed_files_bad",
      (b) => {
        b.sources[0].changedFiles = [123];
      },
      ["changedFiles"],
    );

    // --- begin smoke ---
    {
      const out = execFileSync(
        process.execPath,
        [
          SCRIPT_PATH,
          "begin",
          "--mode",
          "explorer",
          "--actor",
          "self-test",
          "--goal",
          "begin smoke",
        ],
        { encoding: "utf8", env: { ...process.env, ...env }, windowsHide: true },
      );
      const j = JSON.parse(out);
      if (!j.runId?.startsWith("run_") || !j.taskId?.startsWith("task_")) {
        throw new Error("begin payload invalid");
      }
      if (!existsSync(join(work, j.runId, "task.json"))) {
        throw new Error("begin did not write task.json");
      }
      note("begin_smoke", true, j.runId);
    }
  } catch (err) {
    note("self-test_aborted", false, err.message || String(err));
  } finally {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(
    `SELF_TEST summary pass=${results.filter((r) => r.ok).length} fail=${failed.length} outbox_real=false temp=${root}`,
  );
  if (failed.length) process.exit(1);
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));
  if (cmd === "begin") return cmdBegin(args);
  if (cmd === "step") return cmdStep(args);
  if (cmd === "close" || cmd === "harvest") return cmdClose(args);
  if (cmd === "self-test") return await cmdSelfTest();
  console.log(`Usage:
  node ops/xw-closeout.mjs begin --mode <explorer|runner|repair|engineering|recover> --actor <actor> --goal <text>
  node ops/xw-closeout.mjs begin --mode <...> --actor <actor> --brief <json-path>
  node ops/xw-closeout.mjs step --run <runId> --input <explicit-step-json-path>
  node ops/xw-closeout.mjs close --run <runId> --input <explicit-json-path>
  node ops/xw-closeout.mjs self-test`);
  process.exit(2);
}

main().catch((err) => {
  console.log(`CLOSEOUT_FAILED ${err?.message || String(err)}`);
  process.exit(1);
});
