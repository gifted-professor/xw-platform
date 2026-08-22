#!/usr/bin/env node
// M6-2 W9 Gate A #3 — independent read-only operator resource probe.
//
// Queries the canonical control DB in SQLite read-only mode (no control-plane
// process, no /health round-trip) and emits one canonical JSON record:
// schema, dbPath, capturedAt, activeJobs (running/verifying/restoring),
// activeSessions, activeLeases (unexpired), pendingApprovals
// (jobs waiting_approval), actionCount (device_session_actions rows),
// plus the SHA-256 of the canonical form. The before/after window evidence is
// the pair of these records with identical probeSchemaVersion + dbPath and
// different capturedAt. Read-only: opens with readOnly:true so any write
// attempt fails at the driver level; never mutates, never calls health.
//
// Zero-live: this script touches no device and flips nothing. Exit 0 always
// reports; exit 2 means the probe itself could not run (missing DB, wrong
// user_version vs this tree, unreadable file) — it must not guess counts.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const PROBE_SCHEMA = "xw.m6-resource-probe.v1";
const PROBE_SCHEMA_VERSION = 1;

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function sha256Hex(text) {
  return createHash("sha256").update(text).digest("hex");
}

function argOf(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  if (index < 0 || index === argv.length - 1) return fallback;
  return argv[index + 1];
}

function fail(message) {
  process.stderr.write(`m6-resource-probe: ${message}\n`);
  process.exit(2);
}

export function probeRecord({ dbPath, nowMs, userVersion }) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const scalar = (sql) => Number(db.prepare(sql).get().n);
    return {
      probeSchemaId: PROBE_SCHEMA,
      probeSchemaVersion: PROBE_SCHEMA_VERSION,
      dbPath,
      dbUserVersion: userVersion,
      capturedAt: new Date(nowMs).toISOString(),
      activeJobs: scalar("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('running','verifying','restoring')"),
      activeSessions: scalar("SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?"),
      activeLeases: scalar("SELECT COUNT(*) AS n FROM leases WHERE expires_at > ?"),
      pendingApprovals: scalar("SELECT COUNT(*) AS n FROM jobs WHERE status = 'waiting_approval'"),
      actionCount: scalar("SELECT COUNT(*) AS n FROM device_session_actions"),
    };
  } finally {
    db.close();
  }
}

export function canonicalProbeJson(record) {
  return `${stableStringify(record)}\n`;
}

export function probeSha256(record) {
  return sha256Hex(canonicalProbeJson(record));
}

function main() {
  const dbPath = argOf(process.argv.slice(2), "--db");
  if (!dbPath) fail("--db PATH is required (canonical control.db; opened SQLite read-only)");
  let userVersion;
  try {
    userVersion = new DatabaseSync(dbPath, { readOnly: true }).prepare("PRAGMA user_version").get().user_version;
  } catch (error) {
    fail(`cannot open ${dbPath} read-only: ${error.message}`);
  }
  // The live runtime pins its schema at bootstrap; a probe against a DB this
  // tree does not understand would silently mis-report. Fail instead.
  const source = readFileSync(new URL("../control-plane/lib/state-store.mjs", import.meta.url), "utf8");
  const declared = Number(/CURRENT_CONTROL_SCHEMA_VERSION = (\d+)/.exec(source)?.[1] ?? NaN);
  if (!Number.isFinite(declared) || userVersion !== declared) {
    fail(`control.db user_version ${userVersion} != binary schema ${declared}; refusing to report`);
  }
  const record = probeRecord({ dbPath, nowMs: Date.now(), userVersion });
  const canonical = canonicalProbeJson(record);
  const hashOnly = process.argv.includes("--hash-only");
  process.stdout.write(hashOnly ? `{"probeSha256":"${probeSha256(record)}"}\n` : canonical);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  main();
}
