import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createXhsRpaLedger } from "../../control-plane/control-plane/lib/xhs-rpa-ledger.mjs";
import { createXhsRpaRuntime } from "../scripts/lib/xhs-rpa-runtime.mjs";
import {
  childReceipt,
  CLEAN,
  makeProgram,
  p6Artifact,
  RPA_NOW,
  ZERO_SAFETY,
} from "./fixtures/xhs-rpa-fixtures.mjs";

function harness() {
  const database = new DatabaseSync(":memory:");
  const ledger = createXhsRpaLedger({ database, now: () => RPA_NOW });
  return { database, ledger };
}

function reserve(ledger, program, id = "journal:manual:12345678") {
  return ledger.reserveTick({
    programId: program.programId,
    generation: program.generation,
    idempotencyKey: id,
    trigger: "manual_once",
    scheduledAtMs: RPA_NOW,
    p6Artifact: p6Artifact(program),
  });
}

function commitInput(tick, nodeId = "feed_read") {
  return {
    tickId: tick.tickId,
    killGeneration: tick.killGeneration,
    schedulerTraceHash: "2".repeat(64),
    childReceipts: [childReceipt(nodeId)],
    validator: { passed: true, reportHash: "3".repeat(64) },
    cleanup: CLEAN,
    aggregateSafety: ZERO_SAFETY,
  };
}

function recoveryRuntime(ledger, { restoreError = null, leases = [] } = {}) {
  const calls = { submits: 0, restores: 0, leases: 0 };
  const runtime = createXhsRpaRuntime({
    ledger,
    async loadProgram() { return null; },
    async loadCatalogSnapshot() { return null; },
    async loadP6Artifact() { return null; },
    async submitM5TaskPlan() { calls.submits += 1; throw new Error("must not dispatch"); },
    async restoreOwnedResources() {
      calls.restores += 1;
      if (restoreError) throw restoreError;
      return { restored: true };
    },
    async listOwnedLeases() { calls.leases += 1; return leases; },
    clock: () => RPA_NOW,
  });
  return { runtime, calls };
}

test("durable journal commits only child+aggregate zero-social, validator-pass, zero-lease closeout", () => {
  const h = harness();
  const { program } = makeProgram("feed");
  h.ledger.registerProgram(program);
  const tick = reserve(h.ledger, program);
  h.ledger.recordPreIoAttempt({ tickId: tick.tickId });
  h.ledger.markDispatched({ tickId: tick.tickId, killGeneration: tick.killGeneration });
  h.ledger.beginCleanup({ tickId: tick.tickId });
  const done = h.ledger.commitTick(commitInput(tick));
  assert.equal(done.status, "SUCCEEDED");
  assert.equal(done.receipt.committed, true);
  assert.match(done.receipt.receiptHash, /^[0-9a-f]{64}$/);
  const journal = h.ledger.listJournal(tick.tickId);
  assert.deepEqual(journal.map((row) => row.seq), journal.map((_, index) => index + 1));
  assert.equal(journal[0].previousHash, "genesis");
  for (let index = 1; index < journal.length; index += 1) {
    assert.equal(journal[index].previousHash, journal[index - 1].recordHash);
  }
  assert.equal(journal.at(-1).type, "TICK_COMMITTED");
  assert.deepEqual(h.ledger.verifyJournal(tick.tickId), {
    valid: true,
    length: journal.length,
    headHash: journal.at(-1).recordHash,
  });
  h.database.close();
});

test("nonzero transitive child or aggregate effect cannot commit", () => {
  for (const [mutationIndex, mutate] of [
    (input) => { input.childReceipts[0] = { ...input.childReceipts[0], safety: { ...ZERO_SAFETY, likes: 1 } }; },
    (input) => { input.aggregateSafety = { ...ZERO_SAFETY, comments: 1 }; },
    (input) => { input.cleanup = { restored: true, zeroOwnedLeases: false, ownedLeaseCount: 1 }; },
    (input) => { input.childReceipts[0] = { ...input.childReceipts[0], schemaId: "xhs.forged-receipt.v1" }; },
    (input) => { input.childReceipts[0] = { ...input.childReceipts[0], cleanupContractHash: "f".repeat(64) }; },
  ].entries()) {
    const h = harness();
    const { program } = makeProgram("feed");
    h.ledger.registerProgram(program);
    const tick = reserve(h.ledger, program, `unsafe:${mutationIndex}:12345678`);
    h.ledger.markDispatched({ tickId: tick.tickId, killGeneration: tick.killGeneration });
    const input = commitInput(tick);
    mutate(input);
    assert.throws(() => h.ledger.commitTick(input));
    h.ledger.beginCleanup({ tickId: tick.tickId });
    h.ledger.blockTick({ tickId: tick.tickId, cleanup: CLEAN, reason: "unsafe_receipt" });
    h.database.close();
  }
});

test("kill/disable generation fences before dispatch, during child work, and during cleanup", () => {
  {
    const h = harness();
    const { program } = makeProgram("feed");
    h.ledger.registerProgram(program);
    const disabled = h.ledger.disable({ programId: program.programId, generation: 1, reason: "operator_kill" });
    assert.equal(disabled.generation, 2);
    assert.throws(() => reserve(h.ledger, program), { code: "XHS_RPA_GENERATION_STALE" });
    h.database.close();
  }
  for (const stage of ["reserved", "dispatched", "cleanup"]) {
    const h = harness();
    const { program } = makeProgram("feed");
    h.ledger.registerProgram(program);
    const tick = reserve(h.ledger, program, `kill:${stage}:12345678`);
    if (stage !== "reserved") h.ledger.markDispatched({ tickId: tick.tickId, killGeneration: tick.killGeneration });
    if (stage === "cleanup") h.ledger.beginCleanup({ tickId: tick.tickId });
    const killed = h.ledger.kill({ reason: `kill_at_${stage}` });
    assert.equal(killed.killGeneration, tick.killGeneration + 1);
    assert.equal(h.ledger.getTick(tick.tickId).status, "CANCEL_REQUESTED");
    if (stage === "reserved") {
      assert.throws(() => h.ledger.markDispatched({ tickId: tick.tickId, killGeneration: tick.killGeneration }), {
        code: "XHS_RPA_KILL_GENERATION_STALE",
      });
    } else {
      assert.throws(() => h.ledger.commitTick(commitInput(tick)), { code: "XHS_RPA_KILL_GENERATION_STALE" });
    }
    const cancelled = h.ledger.cancelTick({ tickId: tick.tickId, cleanup: CLEAN, reason: "KILL_GENERATION" });
    assert.equal(cancelled.status, "CANCELLED");
    assert.ok(h.ledger.listJournal(tick.tickId).some((row) => row.type === "KILL_OBSERVED"));
    h.database.close();
  }
});

test("crash/restart preserves consumed start, idempotency and journal head", () => {
  const dir = mkdtempSync(join(tmpdir(), "xhs-rpa-ledger-"));
  const dbPath = join(dir, "ledger.sqlite");
  try {
    const firstDb = new DatabaseSync(dbPath);
    const first = createXhsRpaLedger({ database: firstDb, now: () => RPA_NOW });
    const { program } = makeProgram("feed");
    first.registerProgram(program);
    const tick = reserve(first, program, "restart:idempotent:12345678");
    const head = first.verifyJournal(tick.tickId).headHash;
    firstDb.close();

    const secondDb = new DatabaseSync(dbPath);
    const second = createXhsRpaLedger({ database: secondDb, now: () => RPA_NOW + 1 });
    const duplicate = reserve(second, program, "restart:idempotent:12345678");
    assert.equal(duplicate.tickId, tick.tickId);
    assert.equal(duplicate.status, "RESERVED");
    assert.equal(second.verifyJournal(tick.tickId).headHash, head);
    assert.equal(reserve(second, program, "restart:new-work:12345678").status, "SKIPPED_ACCOUNT_CONCURRENCY");
    second.kill({ reason: "restart_recovery_kill" });
    second.cancelTick({ tickId: tick.tickId, cleanup: CLEAN, reason: "KILL_GENERATION" });
    secondDb.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runtime restart reconciles every durable crash point without replaying M5 child I/O", async () => {
  const dir = mkdtempSync(join(tmpdir(), "xhs-rpa-runtime-recovery-"));
  try {
    for (const stage of ["reserved", "dispatched", "cleaning", "cancel_requested"]) {
      const dbPath = join(dir, `${stage}.sqlite`);
      const firstDb = new DatabaseSync(dbPath);
      const first = createXhsRpaLedger({ database: firstDb, now: () => RPA_NOW });
      const { program } = makeProgram("feed", { programId: `xrp_recovery_${stage}` });
      first.registerProgram(program);
      const tick = reserve(first, program, `recovery:${stage}:12345678`);
      if (stage !== "reserved") first.markDispatched({ tickId: tick.tickId, killGeneration: tick.killGeneration });
      if (stage === "cleaning") first.beginCleanup({ tickId: tick.tickId });
      if (stage === "cancel_requested") first.kill({ reason: "restart_recovery_test" });
      const priorHead = first.verifyJournal(tick.tickId).headHash;
      firstDb.close();

      const secondDb = new DatabaseSync(dbPath);
      const second = createXhsRpaLedger({ database: secondDb, now: () => RPA_NOW + 1 });
      assert.equal(second.listActiveTicks().length, 1);
      const recovery = recoveryRuntime(second);
      const summary = await recovery.runtime.reconcileActiveTicks();
      assert.deepEqual(summary, {
        status: "RECOVERED",
        discoveredActiveTicks: 1,
        settledTicks: 1,
        failedTicks: 0,
        remainingActiveTicks: 0,
        schedulerDispatches: 0,
        recurringEnabled: false,
      });
      assert.equal(second.getTick(tick.tickId).status,
        stage === "cancel_requested" ? "CANCELLED" : "BLOCKED");
      assert.equal(recovery.calls.submits, 0);
      assert.equal(recovery.calls.restores, 1);
      assert.equal(recovery.calls.leases, 1);
      assert.equal(second.verifyJournal(tick.tickId).valid, true);
      assert.notEqual(second.verifyJournal(tick.tickId).headHash, priorHead);
      if (stage !== "cancel_requested") {
        assert.equal(reserve(second, program, `recovery:${stage}:new:12345678`).status, "SKIPPED_DAILY_CAP");
      }
      secondDb.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restart recovery remains active and fail-visible until restore and zero-lease both pass", async () => {
  const dir = mkdtempSync(join(tmpdir(), "xhs-rpa-runtime-recovery-fail-"));
  try {
    for (const [name, options] of [
      ["restore-rejected", { restoreError: new Error("restore unavailable") }],
      ["lease-remains", { leases: [{ leaseId: "opaque-owned-lease" }] }],
    ]) {
      const dbPath = join(dir, `${name}.sqlite`);
      const firstDb = new DatabaseSync(dbPath);
      const first = createXhsRpaLedger({ database: firstDb, now: () => RPA_NOW });
      const { program } = makeProgram("feed", { programId: `xrp_recovery_${name}` });
      first.registerProgram(program);
      const tick = reserve(first, program, `recovery:${name}:12345678`);
      first.markDispatched({ tickId: tick.tickId, killGeneration: tick.killGeneration });
      firstDb.close();

      const secondDb = new DatabaseSync(dbPath);
      const second = createXhsRpaLedger({ database: secondDb, now: () => RPA_NOW + 1 });
      const failed = recoveryRuntime(second, options);
      await assert.rejects(failed.runtime.reconcileActiveTicks(), (error) => {
        assert.equal(error.code, "XHS_RPA_RECOVERY_INCOMPLETE");
        assert.equal(error.cause?.remainingActiveTicks, 1);
        assert.equal(error.cause?.schedulerDispatches, 0);
        return true;
      });
      assert.equal(second.getTick(tick.tickId).status, "DISPATCHED");
      assert.equal(second.listActiveTicks().length, 1);
      assert.equal(failed.calls.submits, 0);
      assert.equal(failed.calls.restores, 1);
      assert.equal(failed.calls.leases, 1);
      assert.equal(reserve(second, program, `recovery:${name}:new:12345678`).status,
        "SKIPPED_ACCOUNT_CONCURRENCY");

      const retry = recoveryRuntime(second);
      assert.equal((await retry.runtime.reconcileActiveTicks()).status, "RECOVERED");
      assert.equal(second.getTick(tick.tickId).status, "BLOCKED");
      assert.equal(retry.calls.submits, 0);
      secondDb.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
