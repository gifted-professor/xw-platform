// M0-A SQLite read-only forensics (one-off, not part of tools/m0 CLI).
// mode=ro + PRAGMA query_only=ON; reads sqlite_schema + necessary PRAGMAs only,
// never business rows. Records WAL/SHM state and user_version as OBSERVED values
// (not health truth). stdout: versioned JSON; stderr: diagnostics.
import { DatabaseSync } from "node:sqlite";
import { statSync, existsSync } from "node:fs";

const VERSION = "xhs.m0.sqlite-ro-forensics.v1";

function roForensics(label, path) {
  if (!existsSync(path)) {
    return { label, path, present: false };
  }
  const st = statSync(path);
  const sidecars = {};
  for (const suffix of ["-wal", "-shm"]) {
    const p = path + suffix;
    sidecars[suffix] = existsSync(p) ? statSync(p).size : null;
  }
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON;");
    const userVersion = db.prepare("PRAGMA user_version;").get().user_version;
    const journalMode = db.prepare("PRAGMA journal_mode;").get().journal_mode;
    const integrity = db.prepare("PRAGMA integrity_check;").get().integrity_check;
    const tables = db
      .prepare("SELECT name, type FROM sqlite_schema WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name;")
      .all()
      .map((t) => ({ name: t.name, type: t.type }));
    return {
      label, path, present: true,
      size: st.size, mtimeIso: st.mtime.toISOString(),
      sidecars,
      userVersion, journalMode, integrityCheck: integrity,
      schemaObjects: tables,
    };
  } finally {
    db.close();
  }
}

const out = {
  schemaId: "xhs.m0.sqlite-ro-forensics.v1",
  schemaVersion: 1,
  baselineId: "xw-m0-20260817-r0",
  capturedAt: new Date().toISOString(),
  dbs: [
    roForensics("registry.db", "C:\\Users\\Public\\xhs-registry\\registry.db"),
    roForensics("control.db", "C:\\Users\\Public\\xhs-agent-control\\control.db"),
  ],
};
process.stdout.write(JSON.stringify(out, null, 2) + "\n");
