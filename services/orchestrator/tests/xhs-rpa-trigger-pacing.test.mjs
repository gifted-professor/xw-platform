import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createXhsRpaLedger } from "../../control-plane/control-plane/lib/xhs-rpa-ledger.mjs";
import {
  CLEAN,
  makeProgram,
  p6Artifact,
  RPA_NOW,
} from "./fixtures/xhs-rpa-fixtures.mjs";

function harness(at = RPA_NOW) {
  let clock = at;
  const database = new DatabaseSync(":memory:");
  const ledger = createXhsRpaLedger({ database, now: () => clock });
  return { database, ledger, now: () => clock, advance: (ms) => { clock += ms; } };
}

function reserve(h, program, suffix, overrides = {}) {
  return h.ledger.reserveTick({
    programId: program.programId,
    generation: program.generation,
    idempotencyKey: `manual:${suffix}:12345678`,
    trigger: "manual_once",
    scheduledAtMs: h.now(),
    p6Artifact: p6Artifact(program),
    ...overrides,
  });
}

test("manual-once reservation is P6-gated and idempotent while recurring wake is inert", () => {
  const h = harness();
  const { program } = makeProgram("feed");
  h.ledger.registerProgram(program);
  const denied = reserve(h, program, "unverified", { p6Artifact: { verdict: "PASS" } });
  assert.equal(denied.status, "SKIPPED_P6_UNVERIFIED");
  const wake = reserve(h, program, "wake", { trigger: "recurring_wake" });
  assert.equal(wake.status, "SKIPPED_RECURRING_DISABLED");
  const admitted = reserve(h, program, "one");
  const duplicate = reserve(h, program, "one");
  assert.equal(admitted.status, "RESERVED");
  assert.equal(duplicate.tickId, admitted.tickId);
  assert.equal(h.ledger.status(program.programId).recurringEnabled, false);
  h.database.close();
});

test("BEGIN IMMEDIATE reservation enforces global per-account concurrency one", () => {
  const h = harness();
  const one = makeProgram("feed", { programId: "xrp_feed_account_one" }).program;
  const two = makeProgram("scout", { programId: "xrp_scout_account_two" }).program;
  h.ledger.registerProgram(one);
  h.ledger.registerProgram(two);
  const admitted = reserve(h, one, "global-one");
  const excluded = reserve(h, two, "global-two");
  assert.equal(admitted.status, "RESERVED");
  assert.equal(excluded.status, "SKIPPED_ACCOUNT_CONCURRENCY");
  h.ledger.cancelTick({ tickId: admitted.tickId, cleanup: CLEAN, reason: "test_close" });
  h.database.close();
});

test("daily/default interval/hard minimum/no-catchup and pre-I/O retry caps fail closed", () => {
  const h = harness();
  const daily = makeProgram("feed", { programId: "xrp_daily_cap_test" }).program;
  h.ledger.registerProgram(daily);
  const first = reserve(h, daily, "daily-first");
  h.ledger.cancelTick({ tickId: first.tickId, cleanup: CLEAN, reason: "test_close" });
  h.advance(31 * 60 * 1000);
  assert.equal(reserve(h, daily, "daily-second").status, "SKIPPED_DAILY_CAP");

  const min = makeProgram("scout", {
    programId: "xrp_hard_minimum_test",
    accountRef: "2".repeat(64),
    pacing: { dailyStarts: 4, minimumIntervalMs: 300_000 },
  }).program;
  h.ledger.registerProgram(min);
  const minFirst = reserve(h, min, "min-first");
  h.ledger.recordPreIoAttempt({ tickId: minFirst.tickId });
  h.ledger.recordPreIoAttempt({ tickId: minFirst.tickId });
  assert.throws(() => h.ledger.recordPreIoAttempt({ tickId: minFirst.tickId }), {
    code: "XHS_RPA_PRE_IO_RETRY_EXHAUSTED",
  });
  h.ledger.cancelTick({ tickId: minFirst.tickId, cleanup: CLEAN, reason: "test_close" });
  h.advance(299_999);
  assert.equal(reserve(h, min, "min-too-soon").status, "SKIPPED_MINIMUM_INTERVAL");
  h.advance(1);
  assert.equal(reserve(h, min, "min-allowed").status, "RESERVED");

  const old = makeProgram("explore", {
    programId: "xrp_no_catchup_test",
    accountRef: "3".repeat(64),
  }).program;
  h.ledger.registerProgram(old);
  assert.equal(reserve(h, old, "old", { scheduledAtMs: h.now() - 300_001 }).status, "SKIPPED_NO_CATCHUP");
  h.database.close();
});

test("pacing uses Asia/Shanghai local day and clock rollback never creates a new slot", () => {
  const h = harness();
  const daily = makeProgram("feed", { programId: "xrp_local_day_reset" }).program;
  h.ledger.registerProgram(daily);
  const first = reserve(h, daily, "local-day-first");
  h.ledger.cancelTick({ tickId: first.tickId, cleanup: CLEAN, reason: "test_close" });
  h.advance(2 * 60 * 60 * 1000 + 1);
  assert.equal(reserve(h, daily, "local-day-next").status, "RESERVED");
  h.database.close();

  const rollback = harness();
  const program = makeProgram("scout", {
    programId: "xrp_clock_rollback",
    pacing: { dailyStarts: 4, minimumIntervalMs: 300_000 },
  }).program;
  rollback.ledger.registerProgram(program);
  const started = reserve(rollback, program, "rollback-first");
  rollback.ledger.cancelTick({ tickId: started.tickId, cleanup: CLEAN, reason: "test_close" });
  rollback.advance(-1);
  assert.equal(reserve(rollback, program, "rollback-second").status, "SKIPPED_CLOCK_ROLLBACK");
  rollback.database.close();
});
