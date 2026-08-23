import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ReplayJournal } from "../src/replay-journal.mjs";
import { DshXwProcessAdapter, sha256File } from "../src/process-adapter.mjs";

function built() {
  const root = mkdtempSync(join(tmpdir(), "xw-m6-3-checkpoint-"));
  const worker = "worker-run-0001";
  const journal = new ReplayJournal(root, worker);
  journal.append({ tool: "worker_start", argsHash: "a".repeat(64), result: { status: "STARTED" } });
  journal.append({ tool: "phone_observe", argsHash: "b".repeat(64), result: { frameRef: "c".repeat(64) } });
  const checkpoint = journal.checkpoint({ workerRunRef: worker, stateRefs: ["state-ref-0001"] });
  return { root, worker, journal, checkpoint };
}

test("valid checkpoint binds state, journal prefix and sequence", () => {
  const fixture = built();
  assert.deepEqual(new ReplayJournal(fixture.root, fixture.worker).loadCheckpoint(), fixture.checkpoint);
});

test("missing and partial checkpoints fail with canonical code", () => {
  const missingRoot = mkdtempSync(join(tmpdir(), "xw-m6-3-missing-checkpoint-"));
  assert.throws(() => new ReplayJournal(missingRoot, "worker-run-0001").loadCheckpoint(), { code: "M6_DSH_CHECKPOINT_INVALID" });
  const fixture = built();
  writeFileSync(fixture.journal.checkpointPath, "{\"partial\":");
  assert.throws(() => new ReplayJournal(fixture.root, fixture.worker).loadCheckpoint(), { code: "M6_DSH_CHECKPOINT_INVALID" });
});

test("checkpoint hash, state and sequence mutations fail closed", async (t) => {
  for (const mutate of [
    (value) => { value.journalHash = "0".repeat(64); },
    (value) => { value.state.stateRefs = ["mutated-ref-0001"]; },
    (value) => { value.journalSeq = 999; },
  ]) await t.test(mutate.toString().slice(0, 32), () => {
    const fixture = built();
    const value = JSON.parse(readFileSync(fixture.journal.checkpointPath, "utf8"));
    mutate(value);
    writeFileSync(fixture.journal.checkpointPath, JSON.stringify(value));
    assert.throws(() => new ReplayJournal(fixture.root, fixture.worker).loadCheckpoint(), { code: "M6_DSH_JOURNAL_MISMATCH" });
  });
});

test("bad JSONL and sequence gaps fail with canonical journal code", async (t) => {
  await t.test("bad JSONL", () => {
    const fixture = built();
    writeFileSync(fixture.journal.journalPath, "{\"partial\":");
    assert.throws(() => new ReplayJournal(fixture.root, fixture.worker), { code: "M6_DSH_JOURNAL_MISMATCH" });
  });
  await t.test("partial trailing JSONL", () => {
    const fixture = built();
    const source = readFileSync(fixture.journal.journalPath, "utf8");
    writeFileSync(fixture.journal.journalPath, `${source}{\"seq\":3`);
    assert.throws(() => new ReplayJournal(fixture.root, fixture.worker), { code: "M6_DSH_JOURNAL_MISMATCH" });
  });
  await t.test("sequence gap", () => {
    const fixture = built();
    const lines = readFileSync(fixture.journal.journalPath, "utf8").trim().split("\n").map(JSON.parse);
    lines[1].seq = 9;
    writeFileSync(fixture.journal.journalPath, `${lines.map(JSON.stringify).join("\n")}\n`);
    assert.throws(() => new ReplayJournal(fixture.root, fixture.worker), { code: "M6_DSH_JOURNAL_MISMATCH" });
  });
});

test("journal operation lookup is idempotent and never derives an expected value from current output", () => {
  const fixture = built();
  const expected = fixture.journal.find("phone_observe", "b".repeat(64));
  assert.deepEqual(expected, { frameRef: "c".repeat(64) });
  assert.equal(fixture.journal.entries.length, 2);
});

test("resume rejects profile drift independently of valid journal/state hashes", () => {
  const fixture = built();
  const receipt = join(fixture.root, "close.json");
  const closedPid = spawnSync(process.execPath, ["-e", ""]).pid;
  writeFileSync(receipt, JSON.stringify({ schemaId: "xw.dsh.process-close-receipt.v1", verifiedClosed: true, spawnNonce: "prior-process-0001", pid: closedPid }));
  assert.throws(() => new DshXwProcessAdapter({
    sessionMode: "resume",
    priorCloseReceiptPath: receipt,
    priorCloseReceiptSha256: sha256File(receipt),
    persistenceRoot: join(fixture.root, "sessions"),
    replayRoot: fixture.root,
    workerRunRef: fixture.worker,
  }), { code: "M6_DSH_PROFILE_DRIFT" });
});
