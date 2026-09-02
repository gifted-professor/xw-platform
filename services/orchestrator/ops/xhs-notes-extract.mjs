#!/usr/bin/env node
/**
 * xhs-notes-extract.mjs — notes-library extractor CLI.
 *
 * Scans per-alias Control Plane run directories
 * (C:\Users\Public\xw-lab-cp\per-alias\<alias>\runs\run_*\dump-ui.xml),
 * extracts a structured record from every note-detail dump, dedupes by note
 * fingerprint, and writes an organized notes library under the output root
 * (default D:\沉淀链路信息\notes) so production artifacts stop piling up on C:.
 *
 *   node ops/xhs-notes-extract.mjs --scan-root C:\Users\Public\xw-lab-cp\per-alias
 *   node ops/xhs-notes-extract.mjs --scan-root ... --out D:\沉淀链路信息\notes --aliases 04,05
 *
 * Output layout:
 *   notes.jsonl        one line per unique note (deduped, seenRuns merged)
 *   runs-index.jsonl   one line per captured detail dump (traceability)
 *   comments.jsonl     every extracted comment row keyed by noteFingerprint
 *   summary.json       scan statistics
 *
 * Progress lines and the final summary JSON go to stdout (console.log only —
 * the Windows bridge treats stderr as fatal).
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  extractNoteRecordV2,
  looksLikeNoteDetail,
} from "../scripts/lib/xhs-note-extract.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--") && argv[i + 1] && !argv[i + 1].startsWith("-")) {
      out[a.slice(2)] = argv[++i];
    } else if (a.startsWith("--")) {
      out[a.slice(2)] = true;
    } else {
      out._.push(a);
    }
  }
  return out;
}

function usage() {
  console.log(`用法:
  node ops/xhs-notes-extract.mjs [--scan-root C:\\Users\\Public\\xw-lab-cp\\per-alias]
      [--out D:\\沉淀链路信息\\notes] [--aliases 04,05,06,07] [--runs-root <alias>/runs 相对名]

扫描每机 CP 的 run 目录里的详情页 dump，提炼笔记结构化记录（标题/正文/作者/
帖子时间/互动数/可见评论），按指纹去重后写入 out 目录四件套：
notes.jsonl / runs-index.jsonl / comments.jsonl / summary.json`);
}

function csv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function listRunDirs(aliasRoot) {
  const runsRoot = join(aliasRoot, "runs");
  if (!existsSync(runsRoot)) return [];
  return readdirSync(runsRoot)
    .filter((name) => name.startsWith("run_"))
    .map((name) => {
      const full = join(runsRoot, name);
      try {
        return statSync(full).isDirectory() ? { runId: name.slice(4), dir: full } : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/** Read capture metadata out of the CP run manifest (best effort). */
function manifestMeta(dir, runId, dumpPath) {
  const out = { runId, jobId: null, actorId: null, deviceAlias: null, capturedAt: null };
  try {
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    out.jobId = manifest.jobId ?? null;
    out.actorId = manifest.actorId ?? null;
    out.deviceAlias = manifest.routeDecision?.selectedDevice?.alias ?? manifest.deviceAlias ?? null;
    out.capturedAt = manifest.createdAt ?? null;
  } catch {
    out.capturedAt = statSync(dumpPath).mtime.toISOString();
  }
  return out;
}

function appendJsonl(filePath, rows) {
  if (rows.length === 0) return;
  writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", { flag: "a" });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    usage();
    return;
  }
  const scanRoot = resolve(args["scan-root"] || "C:\\Users\\Public\\xw-lab-cp\\per-alias");
  const outRoot = resolve(args["out"] || "D:\\沉淀链路信息\\notes");
  const aliases = csv(args.aliases || "04,05,06,07");

  mkdirSync(outRoot, { recursive: true });
  const notesPath = join(outRoot, "notes.jsonl");
  const runsIndexPath = join(outRoot, "runs-index.jsonl");
  const commentsPath = join(outRoot, "comments.jsonl");
  for (const p of [notesPath, runsIndexPath, commentsPath]) {
    // fresh scan overwrites previous indexes (full rescan is cheap and honest)
    writeFileSync(p, "", "utf8");
  }

  /** fingerprint → merged note row (first record + provenance list) */
  const notes = new Map();
  const totals = {
    aliases: 0, runDirs: 0, dumpFiles: 0, detailDumps: 0,
    skippedNonDetail: 0, failed: 0, uniqueNotes: 0,
    commentRows: 0, truncatedNotes: 0,
  };
  const failedRuns = [];
  let processed = 0;

  for (const alias of aliases) {
    const aliasRoot = join(scanRoot, alias);
    const runDirs = listRunDirs(aliasRoot);
    totals.aliases += 1;
    totals.runDirs += runDirs.length;
    const batchRuns = [];
    const batchComments = [];
    for (const { runId, dir } of runDirs) {
      const dumpPath = join(dir, "dump-ui.xml");
      if (!existsSync(dumpPath)) continue;
      totals.dumpFiles += 1;
      processed += 1;
      let xml;
      try {
        xml = readFileSync(dumpPath, "utf8");
      } catch (error) {
        totals.failed += 1;
        failedRuns.push({ alias, runId, error: String(error?.code || error?.message || error).slice(0, 120) });
        continue;
      }
      if (!looksLikeNoteDetail(xml)) {
        totals.skippedNonDetail += 1;
        continue;
      }
      totals.detailDumps += 1;
      try {
        const record = extractNoteRecordV2(xml);
        const meta = manifestMeta(dir, runId, dumpPath);
        const provenance = { alias, runId, jobId: meta.jobId, capturedAt: meta.capturedAt };
        const existing = notes.get(record.noteFingerprint);
        if (existing) {
          existing.seenRuns.push(provenance);
        } else {
          notes.set(record.noteFingerprint, { ...record, seenRuns: [provenance] });
        }
        batchRuns.push({
          alias, runId, jobId: meta.jobId, capturedAt: meta.capturedAt,
          noteFingerprint: record.noteFingerprint, ok: true,
          title: record.title, author: record.author,
        });
        for (const comment of record.comments) {
          batchComments.push({ noteFingerprint: record.noteFingerprint, title: record.title, author: record.author, comment });
        }
        totals.commentRows += record.comments.length;
        if (record.commentsTruncated) totals.truncatedNotes += 1;
      } catch (error) {
        totals.failed += 1;
        failedRuns.push({ alias, runId, error: String(error?.code || error?.message || error).slice(0, 120) });
        batchRuns.push({ alias, runId, ok: false, error: String(error?.code || error?.message || error).slice(0, 120) });
      }
      if (processed % 100 === 0) {
        console.log(`[notes-extract] scanned ${processed} dumps, details=${totals.detailDumps}, unique=${notes.size}`);
      }
    }
    appendJsonl(runsIndexPath, batchRuns);
    appendJsonl(commentsPath, batchComments);
    console.log(`[notes-extract] alias ${alias}: runs=${runDirs.length} details=${batchRuns.length}`);
  }

  // notes.jsonl: one line per unique fingerprint
  const noteRows = [...notes.values()];
  appendJsonl(notesPath, noteRows);
  totals.uniqueNotes = noteRows.length;

  const summary = {
    schemaId: "xhs.notes-extract.summary.v1",
    generatedAt: new Date().toISOString(),
    scanRoot,
    outRoot,
    aliases,
    totals,
    failedRuns: failedRuns.slice(0, 20),
    outputs: { notesPath, runsIndexPath, commentsPath },
  };
  writeFileSync(join(outRoot, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
  console.log("=== NOTES-EXTRACT SUMMARY ===");
  console.log(JSON.stringify(summary, null, 2));
  process.exitCode = totals.failed > 0 ? 4 : 0;
}

main().catch((error) => {
  console.log(`✗ NOTES_EXTRACT_FAILED: ${error?.message || error}`);
  process.exitCode = 4;
});