#!/usr/bin/env node
/**
 * xw-stall-worker.mjs — process one stall_queue item into a shadow L2 decision.
 * Does not touch devices or call LLM providers.
 *
 * Usage: node ops/xw-stall-worker.mjs [--db ./registry.db] [--once]
 */
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import {
  ensureStallTables,
  claimNextStallItem,
  completeStallItem,
  buildL2DiagnosticPacket,
  buildL2ShadowDecision,
} from "../scripts/lib/stall-triage.mjs";

function argOf(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const dbPath = resolve(argOf("--db", "C:\\Users\\Public\\xhs-registry\\registry.db"));
const db = new DatabaseSync(dbPath);
ensureStallTables(db);

const claimed = claimNextStallItem(db);
if (!claimed) {
  console.log(JSON.stringify({ ok: true, empty: true }));
  process.exit(0);
}

let packet = null;
try {
  packet = claimed.packet_json ? JSON.parse(claimed.packet_json) : null;
} catch {
  packet = null;
}
if (!packet) {
  packet = buildL2DiagnosticPacket({
    runId: claimed.run_id,
    jobId: claimed.job_id,
  });
}
const decision = buildL2ShadowDecision(packet);
completeStallItem(db, claimed.queue_id, { decision });
console.log(JSON.stringify({
  ok: true,
  queueId: claimed.queue_id,
  diagnosisCode: decision.diagnosisCode,
  recommendedAction: decision.recommendedAction,
  mode: decision.mode,
  decisionHash: decision.decisionHash,
}));
