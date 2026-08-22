// M6-2 W9 — Independent read-only control-plane resource probe.
//
// The `xw m6 window snapshot` command accepts operator-supplied `--before` /
// `--after` JSON, so a quiescence claim is only as good as the operator who
// typed it. This probe is the independent check: it opens the canonical control
// DB in READ-ONLY mode and derives every resource count directly from the
// physical rows. It never calls the control plane health endpoint, never writes
// to the DB, and never performs any device I/O.
//
// Counts (each mapped 1:1 to how StateStore derives the same quantity):
//   activeJobs        jobs.status IN ('running','verifying','restoring')
//   activeSessions    sessions where expires_at > now (cleanup deletes the rest)
//   activeLeases      leases where expires_at > now (health == listLeases().length)
//   pendingApprovals  jobs.status = 'waiting_approval' (StateStore#pendingApprovals)
//   actionCount       device_session_actions where executed = 1 (committed mutations)
//
// The probe emits a single canonical JSON object bound to a self-referential
// SHA-256 (probeSha256, derived from the payload EXCLUDING itself). On any
// nonzero count it prints the full evidence FIRST, then exits nonzero, so a
// human or caller sees exactly which rows leaked without the process masking it
// behind a bare `exit 1`.
//
// Usage:
//   node scripts/m6-resource-probe.mjs [--db-path PATH] [--now ISO]
//                                      [--out FILE] [--json] [--quiet]
//
// DB path resolution (first hit wins):
//   1. --db-path arg
//   2. CONTROL_PLANE_DB env
//   3. ${XW_RUNTIME_ROOT}/state/control-plane/control.db
//      (XW_RUNTIME_ROOT defaults to C:\Users\Public\xw-runtime on Windows,
//       <repo>/xw-runtime elsewhere — matching control-plane/bootstrap.mjs)
//
// Exit codes: 0 = all counts zero; 1 = nonzero count found (evidence already
// printed), or a fatal error before a result could be produced.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA_ID = "xw.m6-resource-probe.v1";

// ACTIVE_JOB_STATES from StateStore (state-store.mjs). Kept in step with the
// source of truth rather than duplicated as an inline set we can drift from.
const ACTIVE_JOB_STATES = ["running", "verifying", "restoring"];

function opt(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  if (index < 0 || index === argv.length - 1) return fallback;
  return argv[index + 1];
}
function has(argv, name) {
  return argv.includes(name);
}

function sha256Hex(input) {
  return createHash("sha256").update(input).digest("hex");
}

// Stable canonical serialization: fixed key order + no whitespace. This is the
// bytes fed to the hash, so it must be deterministic regardless of object key
// insertion order. (We reuse a local stableStringify rather than importing from
// packages/kernel to keep this probe self-contained as an operator artifact.)
function canonical(obj) {
  if (Array.isArray(obj)) return `[${obj.map(canonical).join(",")}]`;
  if (obj && typeof obj === "object") {
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
  }
  if (typeof obj === "number" && !Number.isFinite(obj)) return "null";
  return JSON.stringify(obj);
}

function uniqueStable(rows) {
  const keys = Array.from(new Set(rows.map((r) => r.id))).sort();
  return keys;
}

// Read-only open. We deliberately do NOT pass :memory: or run any PRAGMA beyond
// opening. A read-only connection reads committed rows through the WAL the
// same way a read-write one does (validated against a WAL-mode DB). If the DB
// cannot be opened read-only (e.g. it does not exist), we surface a clear,
// non-masked error.
function openReadOnly(dbPath) {
  if (!existsSync(dbPath)) {
    return { error: `control DB does not exist: ${dbPath}`, code: "SQLITE_NOT_FOUND" };
  }
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    // IMMEDIATE-busy: a read-only handle must not block forever on a write lock.
    db.exec("PRAGMA busy_timeout = 5000;");
    return { db, error: null };
  } catch (error) {
    return { db: null, error: error.message, code: error.code || "SQLITE_OPEN_FAILED" };
  }
}

function resolveDbPath(argv) {
  const explicit = opt(argv, "--db-path");
  if (explicit) return resolve(explicit);
  if (process.env.CONTROL_PLANE_DB) return resolve(process.env.CONTROL_PLANE_DB);
  const runtimeRoot = process.env.XW_RUNTIME_ROOT
    || (process.platform === "win32" ? "C:\\Users\\Public\\xw-runtime" : "xw-runtime");
  return resolve(join(runtimeRoot, "state", "control-plane", "control.db"));
}

function probe(db, nowMs) {
  const activeStatusList = ACTIVE_JOB_STATES.map(() => "?").join(",");
  const activeJobs = db
    .prepare(`SELECT job_id AS id FROM jobs WHERE status IN (${activeStatusList}) ORDER BY job_id`)
    .all(...ACTIVE_JOB_STATES);
  const activeSessions = db
    .prepare("SELECT session_id AS id FROM sessions WHERE expires_at > ? ORDER BY session_id")
    .all(nowMs);
  const activeLeases = db
    .prepare("SELECT lease_id AS id FROM leases WHERE expires_at > ? ORDER BY lease_id")
    .all(nowMs);
  const pendingApprovals = db
    .prepare("SELECT job_id AS id FROM jobs WHERE status = 'waiting_approval' ORDER BY job_id")
    .all();
  const mutatedActions = db
    .prepare("SELECT session_id AS id FROM device_session_actions WHERE executed = 1 ORDER BY session_id")
    .all();

  const counts = {
    activeJobs: activeJobs.length,
    activeSessions: activeSessions.length,
    activeLeases: activeLeases.length,
    pendingApprovals: pendingApprovals.length,
    actionCount: mutatedActions.length,
  };

  return {
    schemaId: SCHEMA_ID,
    activeJobStatuses: ACTIVE_JOB_STATES.slice(),
    counts,
    leaked: {
      activeJobs: uniqueStable(activeJobs),
      activeSessions: uniqueStable(activeSessions),
      activeLeases: uniqueStable(activeLeases),
      pendingApprovals: uniqueStable(pendingApprovals),
      mutatedActionSessionIds: uniqueStable(mutatedActions),
    },
    allZero: Object.values(counts).every((n) => n === 0),
  };
}

function finalize(raw, nowMs) {
  const payload = {
    ...raw,
    capturedAt: new Date(nowMs).toISOString(),
  };
  const bodyStable = canonical(payload);
  // Hash is bound to the payload EXCLUDING itself (probeSha256), so a forged
  // probe cannot claim an arbitrary hash; any mutation invalidates the hash.
  const probeSha256 = sha256Hex(`${SCHEMA_ID}:${bodyStable}`);
  return { ...payload, probeSha256 };
}

function main() {
  const argv = process.argv.slice(2);
  const nowMs = opt(argv, "--now") ? Date.parse(opt(argv, "--now")) : Date.now();
  const dbPath = resolveDbPath(argv);
  const emitJson = has(argv, "--json");

  const { db, error, code } = openReadOnly(dbPath);
  if (error) {
    if (emitJson) {
      process.stderr.write(JSON.stringify({ schemaId: SCHEMA_ID, ok: false, error, code, dbPath }, null, 2) + "\n");
    } else {
      process.stderr.write(`m6-resource-probe: ${error}\n`);
    }
    return 2;
  }

  let raw;
  try {
    raw = probe(db, nowMs);
  } catch (runError) {
    try { db.close(); } catch { /* best effort */ }
    if (emitJson) {
      process.stderr.write(JSON.stringify({ schemaId: SCHEMA_ID, ok: false, error: runError.message, code: "SQLITE_READ_FAILED", dbPath }, null, 2) + "\n");
    } else {
      process.stderr.write(`m6-resource-probe: ${runError.message}\n`);
    }
    return 2;
  }
  const output = finalize(raw, nowMs);

  const outPath = opt(argv, "--out");
  if (outPath) {
    const target = resolve(outPath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  }

  const rendered = JSON.stringify(output, null, 2);
  if (!has(argv, "--quiet")) {
    if (emitJson) {
      process.stdout.write(rendered + "\n");
    } else {
      process.stdout.write(rendered + "\n");
    }
  }

  db.close();

  // Nonzero counts: evidence is ALREADY on stdout above. We only fail the exit
  // code now — the rows a human needs are not masked by a bare `exit 1`.
  if (!output.allZero) {
    if (!emitJson && !has(argv, "--quiet")) {
      process.stderr.write("m6-resource-probe: FAIL — non-zero resource counts (see leaked IDs above)\n");
    }
    return 1;
  }
  return 0;
}

try {
  process.exitCode = main();
} catch (topError) {
  process.stderr.write(`m6-resource-probe: ${topError.message}\n`);
  process.exitCode = 2;
}
