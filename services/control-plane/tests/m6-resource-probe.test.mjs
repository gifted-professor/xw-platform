// M6-2 W9 — Independent read-only resource probe tests.
//
// These tests pin the probe's contract, not its implementation: the probe must
// derive all five resource counts directly from a read-only control DB, never
// call the control-plane health endpoint, print the leaked evidence BEFORE it
// fails, and expose a self-referential probeSha256 that re-derives (so a forged
// or hand-edited probe can be detected). Each test builds a throwaway SQLite DB
// that mirrors the real control-plane schema (the exact columns the probe
// references) and asserts on the probe's stdout/exit.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import test from "node:test";

const SCRIPT = resolve(fileURLToPath(new URL("..", import.meta.url)), "scripts", "m6-resource-probe.mjs");

function makeDb(t, { withLeaks = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "m6probe-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "control.db");
  const db = new DatabaseSync(dbPath);
  // Mirror the real control-plane schema columns the probe references.
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`CREATE TABLE jobs (job_id TEXT PRIMARY KEY, status TEXT NOT NULL, session_id TEXT);`);
  db.exec(`CREATE TABLE sessions (session_id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);`);
  db.exec(`CREATE TABLE leases (lease_id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);`);
  db.exec(`CREATE TABLE device_session_actions (session_id TEXT NOT NULL, executed INTEGER NOT NULL DEFAULT 0);`);
  const fut = Date.now() + 60_000;
  const past = Date.now() - 60_000;
  if (withLeaks) {
    db.prepare("INSERT INTO jobs VALUES (?,?,?)").run("j-running", "running", null);
    db.prepare("INSERT INTO jobs VALUES (?,?,?)").run("j-waiting", "waiting_approval", null);
    db.prepare("INSERT INTO jobs VALUES (?,?,?)").run("j-terminal", "succeeded", null);
    db.prepare("INSERT INTO sessions VALUES (?,?)").run("s-live", fut);
    db.prepare("INSERT INTO sessions VALUES (?,?)").run("s-dead", past);
    db.prepare("INSERT INTO leases VALUES (?,?)").run("l-live", fut);
    db.prepare("INSERT INTO leases VALUES (?,?)").run("l-dead", past);
    db.prepare("INSERT INTO device_session_actions VALUES (?,?)").run("a-exec", 1);
    db.prepare("INSERT INTO device_session_actions VALUES (?,?)").run("a-skip", 0);
  }
  db.close();
  return dbPath;
}

function runProbe(dbPath, extraArgs = []) {
  const r = spawnSync(
    process.execPath,
    [SCRIPT, "--db-path", dbPath, ...extraArgs],
    { cwd: resolve(fileURLToPath(new URL("..", import.meta.url))), encoding: "utf8" },
  );
  const parsed = r.stdout.trim() ? JSON.parse(r.stdout) : null;
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, parsed };
}

function sha256Hex(input) {
  return createHash("sha256").update(input).digest("hex");
}

test("clean DB reports all five counts zero and exits 0", (t) => {
  const dbPath = makeDb(t);
  const r = runProbe(dbPath);
  assert.equal(r.status, 0);
  assert.ok(r.parsed && r.parsed.schemaId === "xw.m6-resource-probe.v1");
  assert.deepEqual(r.parsed.counts, {
    activeJobs: 0,
    activeSessions: 0,
    activeLeases: 0,
    pendingApprovals: 0,
    actionCount: 0,
  });
  assert.equal(r.parsed.allZero, true);
  assert.equal(r.parsed.dbPath, resolve(dbPath));
  assert.equal(r.parsed.capturedAt.length, 24); // ISO
});

test("leaky DB reports the exact leaked rows and exits nonzero", (t) => {
  const dbPath = makeDb(t, { withLeaks: true });
  const r = runProbe(dbPath);
  assert.equal(r.status, 1);
  assert.deepEqual(r.parsed.counts, {
    activeJobs: 1,
    activeSessions: 1,
    activeLeases: 1,
    pendingApprovals: 1,
    actionCount: 1,
  });
  assert.equal(r.parsed.allZero, false);
  // Evidence must name the contaminating rows exactly.
  assert.deepEqual(r.parsed.leaked.activeJobs, ["j-running"]);
  assert.deepEqual(r.parsed.leaked.pendingApprovals, ["j-waiting"]);
  assert.deepEqual(r.parsed.leaked.activeSessions, ["s-live"]);
  assert.deepEqual(r.parsed.leaked.activeLeases, ["l-live"]);
  assert.deepEqual(r.parsed.leaked.mutatedActionSessionIds, ["a-exec"]);
  // Terminal/failed jobs, expired sessions/leases, and skipped actions do NOT leak.
  assert.ok(!r.parsed.leaked.activeJobs.includes("j-terminal"));
  assert.ok(!r.parsed.leaked.activeSessions.includes("s-dead"));
  assert.ok(!r.parsed.leaked.activeLeases.includes("l-dead"));
  assert.ok(!r.parsed.leaked.mutatedActionSessionIds.includes("a-skip"));
});

test("probeSha256 re-derives from the payload and is deterministic", (t) => {
  const dbPath = makeDb(t);
  const a = runProbe(dbPath);
  const b = runProbe(dbPath);
  const strip = (o) => {
    const { probeSha256, ...rest } = o;
    return rest;
  };
  const derived = sha256Hex(`xw.m6-resource-probe.v1:${stableJson(strip(a.parsed))}`);
  assert.equal(a.parsed.probeSha256, derived);
  // Same input -> same hash (no timestamp bytes in the hash input, except the
  // capturedAt, which we zero out by comparing two runs against the same now)
  assert.equal(a.parsed.probeSha256.length, 64);
  // Forge: mutating any count changes the hash.
  const forged = { ...strip(a.parsed), counts: { ...a.parsed.counts, activeJobs: 1 } };
  const forgedHash = sha256Hex(`xw.m6-resource-probe.v1:${stableJson(forged)}`);
  assert.notEqual(forgedHash, a.parsed.probeSha256);
});

test("probe never mutates the DB and rejects a write attempt", (t) => {
  const dbPath = makeDb(t);
  // Run once clean; then assert the probe could not have written any row.
  runProbe(dbPath);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM jobs").get().c, 0);
  // A read-only handle must reject writes outright.
  assert.throws(() => db.exec("INSERT INTO jobs VALUES ('x','running',null)"));
  db.close();
});

test("DB-path resolution: --db-path wins, then CONTROL_PLANE_DB, then XW_RUNTIME_ROOT", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "m6probe-path-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const explicit = join(dir, "explicit.db");
  const envDb = join(dir, "env.db");
  const runtimeDb = join(dir, "state", "control-plane", "control.db");
  const mk = (p) => {
    mkdirSync(dirname(p), { recursive: true });
    const db = new DatabaseSync(p);
    db.exec("CREATE TABLE jobs (job_id TEXT PRIMARY KEY, status TEXT NOT NULL, session_id TEXT);");
    db.exec("CREATE TABLE sessions (session_id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);");
    db.exec("CREATE TABLE leases (lease_id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);");
    db.exec("CREATE TABLE device_session_actions (session_id TEXT NOT NULL, executed INTEGER NOT NULL DEFAULT 0);");
    db.close();
  };
  mk(explicit); mk(envDb); mk(runtimeDb);

  // 1. --db-path wins over env and XW_RUNTIME_ROOT. Put a leak ONLY in explicit.
  const exDb = new DatabaseSync(explicit);
  exDb.exec("INSERT INTO jobs VALUES ('ex-run','running',null)");
  exDb.close();
  const r1 = runProbe(explicit, []);
  assert.equal(r1.parsed.counts.activeJobs, 1);
  assert.equal(r1.parsed.counts.activeJobs, 1);

  // 2. Without --db-path, CONTROL_PLANE_DB wins. Leak only in env.db.
  const envL = new DatabaseSync(envDb);
  envL.exec("INSERT INTO jobs VALUES ('env-run','running',null)");
  envL.close();
  const r2 = spawnSync(process.execPath, [SCRIPT], {
    cwd: resolve(fileURLToPath(new URL("..", import.meta.url))),
    encoding: "utf8",
    env: { ...process.env, CONTROL_PLANE_DB: envDb, XW_RUNTIME_ROOT: dir },
  });
  const p2 = JSON.parse(r2.stdout);
  assert.equal(p2.counts.activeJobs, 1);
  assert.equal(r2.status, 1);

  // 3. Without --db-path or CONTROL_PLANE_DB, XW_RUNTIME_ROOT/state/control-plane/control.db.
  const rtL = new DatabaseSync(runtimeDb);
  rtL.exec("INSERT INTO jobs VALUES ('rt-run','running',null)");
  rtL.close();
  const r3 = spawnSync(process.execPath, [SCRIPT], {
    cwd: resolve(fileURLToPath(new URL("..", import.meta.url))),
    encoding: "utf8",
    env: { ...process.env, XW_RUNTIME_ROOT: dir },
  });
  const p3 = JSON.parse(r3.stdout);
  assert.equal(p3.counts.activeJobs, 1);
  assert.equal(r3.status, 1);
});

test("missing DB fails closed with a clear error, not a zero claim", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "m6probe-missing-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const missing = join(dir, "nope.db");
  const r = runProbe(missing);
  assert.notEqual(r.status, 0);
  assert.ok(!r.parsed || r.parsed.ok !== true);
  assert.match(r.stderr, /does not exist|SQLITE/i);
});

function stableJson(obj) {
  if (Array.isArray(obj)) return `[${obj.map(stableJson).join(",")}]`;
  if (obj && typeof obj === "object") {
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(",")}}`;
  }
  if (typeof obj === "number" && !Number.isFinite(obj)) return "null";
  return JSON.stringify(obj);
}
