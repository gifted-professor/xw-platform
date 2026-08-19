// M3-R2 数据库只读探查与 snapshot。
// 原则：绝不向旧目录/源 DB 写任何字节——源 DB 一律 readOnly 打开，
// snapshot 通过 VACUUM INTO 落到调用方指定目录；失败时退化为文件拷贝 + 在副本上 checkpoint。
import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { fileInfo, sha256File, sha256Text } from "./util.mjs";

export function walShmInfo(dbPath) {
  const wal = fileInfo(`${dbPath}-wal`);
  const shm = fileInfo(`${dbPath}-shm`);
  return {
    wal: { present: wal.exists, sizeBytes: wal.sizeBytes },
    shm: { present: shm.exists, sizeBytes: shm.sizeBytes },
  };
}

// 只读打开源 DB 取 user_version；失败（如 WAL 只读恢复受限）返回 "unknown"，绝不猜。
export function readUserVersion(sourcePath) {
  try {
    const db = new DatabaseSync(sourcePath, { readOnly: true });
    try {
      const row = db.prepare("PRAGMA user_version").get();
      return Number(row.user_version);
    } finally {
      db.close();
    }
  } catch {
    return "unknown";
  }
}

export function inspectDbFile(dbPath) {
  const info = fileInfo(dbPath);
  return {
    path: dbPath,
    exists: info.exists,
    sizeBytes: info.sizeBytes,
    mtime: info.mtime,
    userVersion: info.exists ? readUserVersion(dbPath) : "unknown",
    ...walShmInfo(dbPath),
  };
}

// 分析一个属于我们自己的 DB 副本（可读写打开）：user_version / integrity / schema hash / 表与行数。
export function analyzeDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    const userVersion = Number(db.prepare("PRAGMA user_version").get().user_version);
    const integrity = db.prepare("PRAGMA integrity_check").get().integrity_check;
    const schemaRows = db
      .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name")
      .all();
    const schemaHash = sha256Text(schemaRows.map((row) => `${row.type}|${row.name}|${row.tbl_name}|${row.sql}`).join("\n"));
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((row) => row.name);
    const rowCounts = {};
    for (const table of tables) {
      rowCounts[table] = Number(db.prepare(`SELECT COUNT(*) AS n FROM "${table.replaceAll('"', '""')}"`).get().n);
    }
    return { userVersion, integrityCheck: integrity, schemaHash, tableCount: tables.length, tables, rowCounts };
  } finally {
    db.close();
  }
}

function vacuumInto(sourcePath, destPath) {
  const db = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    db.exec(`VACUUM INTO '${destPath.replaceAll("'", "''")}'`);
  } finally {
    db.close();
  }
}

function copyWithCheckpoint(sourcePath, destPath) {
  copyFileSync(sourcePath, destPath);
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(`${sourcePath}${suffix}`)) copyFileSync(`${sourcePath}${suffix}`, `${destPath}${suffix}`);
  }
  const db = new DatabaseSync(destPath);
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
}

// 生成一个一致性 snapshot 到 destPath（destPath 必须位于 rehearsal/工作目录，绝不落在源目录）。
// 返回 receipt 条目；所有无法确定的事实记 "unknown"。
export function snapshotDatabase({ sourcePath, destDir, label }) {
  if (!sourcePath || !existsSync(sourcePath)) {
    return { label, ok: false, source: { path: sourcePath ?? "unknown", exists: false }, error: "SOURCE_DB_NOT_FOUND" };
  }
  const source = {
    path: sourcePath,
    ...fileInfo(sourcePath),
    sha256: sha256File(sourcePath),
    ...walShmInfo(sourcePath),
  };
  mkdirSync(destDir, { recursive: true });
  const destPath = join(destDir, `${label}.snapshot.db`);
  let method = "vacuum-into-readonly";
  try {
    vacuumInto(sourcePath, destPath);
  } catch (error) {
    method = `file-copy-checkpoint (${error.message})`;
    copyWithCheckpoint(sourcePath, destPath);
  }
  const analysis = analyzeDb(destPath);
  const destInfo = fileInfo(destPath);
  return {
    label,
    ok: analysis.integrityCheck === "ok",
    method,
    source,
    snapshot: { path: destPath, sizeBytes: destInfo.sizeBytes, sha256: sha256File(destPath) },
    ...analysis,
    snapshottedAt: new Date().toISOString(),
  };
}

// 从 snapshot 恢复一个工作副本到 targetPath（覆盖 targetPath 及其 wal/shm，只动工作目录内文件）。
export function restoreSnapshot({ snapshotPath, targetPath }) {
  mkdirSync(dirname(targetPath), { recursive: true });
  copyFileSync(snapshotPath, targetPath);
  return analyzeDb(targetPath);
}

export function copySnapshotTo(snapshotPath, targetPath) {
  return restoreSnapshot({ snapshotPath, targetPath });
}
