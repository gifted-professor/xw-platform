import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureStallTables,
  enqueueStall,
  buildL2DiagnosticPacket,
  buildL2ShadowDecision,
  claimNextStallItem,
  completeStallItem,
} from "../scripts/lib/stall-triage.mjs";
import { buildAttemptReceiptFromJob } from "../scripts/lib/recipe-attempt-receipt.mjs";

test("L2 shadow decision maps ui_stall to retry_once without model calls", () => {
  const packet = buildL2DiagnosticPacket({
    runId: "run_1",
    jobId: "job_1",
    stallVerdict: { signalType: "ui_stall", hash: "a".repeat(64), llmEscalationRecommended: true },
  });
  const decision = buildL2ShadowDecision(packet);
  assert.equal(decision.mode, "shadow");
  assert.equal(decision.recommendedAction, "retry_once");
  assert.equal(decision.calls, 0);
  assert.ok(decision.forbiddenActions.includes("bypass_lease"));
  assert.match(decision.decisionHash, /^[a-f0-9]{64}$/);
});

test("stall queue claim + shadow complete", () => {
  const dir = mkdtempSync(join(tmpdir(), "stall-q-"));
  const db = new DatabaseSync(join(dir, "t.db"));
  try {
    ensureStallTables(db);
    const packet = buildL2DiagnosticPacket({
      runId: "run_s",
      stallVerdict: { signalType: "contract_violation", hash: "b".repeat(64), llmEscalationRecommended: true },
    });
    enqueueStall(db, { runId: "run_s", jobId: "job_s", packet });
    const claimed = claimNextStallItem(db);
    assert.equal(claimed.run_id, "run_s");
    const decision = buildL2ShadowDecision(packet);
    assert.equal(decision.recommendedAction, "escalate_human");
    completeStallItem(db, claimed.queue_id, { decision });
    assert.equal(claimNextStallItem(db), null);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("attempt receipt rejects non-succeeded and run mismatch", () => {
  const bad = buildAttemptReceiptFromJob({
    jobId: "job_1",
    runId: "run_1",
    status: "failed",
    capabilityId: "douyin.observe.snapshot",
    result: { verification: { ok: true }, restoration: { ok: true } },
  }, { recipeId: "r", revision: 1, expectedRunId: "run_1" });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, "NOT_SUCCEEDED");

  const mismatch = buildAttemptReceiptFromJob({
    jobId: "job_1",
    runId: "run_real",
    status: "succeeded",
    capabilityId: "douyin.observe.snapshot",
    result: { verification: { ok: true }, restoration: { ok: true } },
    capability: { restoration: { required: false } },
  }, { recipeId: "r", revision: 1, expectedRunId: "run_spoof" });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.code, "RUN_MISMATCH");
});

test("attempt receipt accepts succeeded job", () => {
  const ok = buildAttemptReceiptFromJob({
    jobId: "job_ok",
    runId: "run_ok",
    status: "succeeded",
    capabilityId: "douyin.observe.snapshot",
    deviceId: "dev_1",
    finishedAt: new Date().toISOString(),
    result: { verification: { ok: true, hash: null }, restoration: { ok: true } },
    capability: { restoration: { required: false } },
    routeDecision: { selectedDevice: { alias: "01" } },
  }, {
    recipeId: "douyin.observe.snapshot.wrap",
    revision: 1,
    expectedCapabilityId: "douyin.observe.snapshot",
    expectedRunId: "run_ok",
    workerWindowId: "ww1",
    runsRoot: join(tmpdir(), "no-such-runs"),
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.receipt.alias, "01");
  assert.match(ok.receipt.receiptHash, /^[a-f0-9]{64}$/);
});
