// M6-2 W9 Gate A #3 — read-only operator resource probe tests.
//
// The probe must (a) report exact zero/non-zero counts from a real SQLite DB
// it can write nothing to, (b) emit deterministic canonical JSON whose
// SHA-256 is stable across calls with the same content, and (c) fail closed
// when the file is not a usable control DB or the schema version differs.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CURRENT_CONTROL_SCHEMA_VERSION, StateStore } from "../control-plane/lib/state-store.mjs";
import { canonicalProbeJson, probeRecord, probeSha256 } from "../scripts/m6-resource-probe.mjs";

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "m6-resource-probe.mjs");

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "xw-m6-probe-"));
  const store = new StateStore({ dbPath: join(dir, "control.db") });
  // Windows cannot rm an open SQLite file — close the writer handle up front;
  // the probe opens its own read-only connection.
  store.db.close();
  return { dbPath: join(dir, "control.db"), dir };
}

function runCli(args) {
  try {
    const stdout = execFileSync(process.execPath, [scriptPath, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.status ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? String(error) };
  }
}

test("probe reports zero counts on an empty store and binds dbPath + schema version", () => {
  const { dbPath, dir } = makeStore();
  try {
    const record = probeRecord({ dbPath, nowMs: Date.parse("2026-08-22T00:00:00.000Z"), userVersion: CURRENT_CONTROL_SCHEMA_VERSION });
    assert.equal(record.probeSchemaId, "xw.m6-resource-probe.v1");
    assert.equal(record.activeJobs, 0);
    assert.equal(record.activeSessions, 0);
    assert.equal(record.activeLeases, 0);
    assert.equal(record.pendingApprovals, 0);
    assert.equal(record.actionCount, 0);
    assert.match(record.capturedAt, /^2026-08-22T/);
    assert.ok(dbPath.endsWith("control.db"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probe counts each resource class independently from live rows", () => {
  const { dbPath, dir } = makeStore();
  try {
    const db = new DatabaseSync(dbPath);
    try {
      for (let i = 1; i <= 5; i += 1) {
        db.prepare(
          "INSERT INTO devices (device_id, alias, physical_label, node_id, runtime_id, metadata_json, routing_json, online, updated_at) VALUES (?,?,'p','n1','r','{}','{}',1,?)",
        ).run(`d${i}`, `0${i}`, Date.now());
      }
      db.prepare("INSERT INTO capabilities (capability_id, app_id, maturity, risk, enabled, manifest_json, updated_at) VALUES ('cap-x','app','ga','low',1,'{}',?)").run(Date.now());
      const statuses = ["running", "verifying", "restoring", "waiting_approval", "succeeded"];
      statuses.forEach((status, i) => {
        const n = i + 1;
        db.prepare(
          `INSERT INTO jobs (job_id, run_id, idempotency_key, request_fingerprint, actor_id, device_id, capability_id, capability_json,
            params_json, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(`j${n}`, `r${n}`, `ik${n}`, `fp${n}`, "actor", `d${n}`, "cap-x", "{}", "{}", status, Date.now(), Date.now());
      });
      db.prepare(
        "INSERT INTO device_session_actions (session_id, idempotency_key, fingerprint_json, result_json, executed, created_at) VALUES ('s1','ik','{}','{}',1,?)",
      ).run(Date.now());
    } finally {
      db.close();
    }
    const record = probeRecord({ dbPath, nowMs: Date.now(), userVersion: CURRENT_CONTROL_SCHEMA_VERSION });
    assert.equal(record.activeJobs, 3); // running+verifying+restoring only
    assert.equal(record.pendingApprovals, 1); // waiting_approval is not an active job state
    assert.equal(record.actionCount, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("canonical JSON is stable and its SHA-256 changes when counts change", () => {
  const base = { a: 0, b: 0, capturedAt: "2026-08-22T00:00:00.000Z" };
  const text1 = canonicalProbeJson(base);
  const text2 = canonicalProbeJson({ b: 0, capturedAt: "2026-08-22T00:00:00.000Z", a: 0 });
  assert.equal(text1, text2); // key order does not matter
  assert.match(probeSha256(base), /^[0-9a-f]{64}$/);
  const bumped = { ...base, activeJobs: 1 };
  assert.notEqual(probeSha256(base), probeSha256(bumped));
});

test("CLI fails closed on a non-SQLite file", () => {
  const dir = mkdtempSync(join(tmpdir(), "xw-m6-probe-cli-"));
  try {
    const fake = join(dir, "not-a-db.db");
    writeFileSync(fake, "this is not sqlite\n");
    const r = runCli(["--db", fake]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /cannot open|read-only|user_version/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI fails closed when the DB schema version differs from this tree", () => {
  const { dbPath, dir } = makeStore();
  try {
    const db = new DatabaseSync(dbPath);
    db.prepare("PRAGMA user_version = 9999").run();
    db.close();
    const r = runCli(["--db", dbPath]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /refusing to report/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
