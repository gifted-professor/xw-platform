import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DshXwProcessAdapter, sha256File } from "../src/process-adapter.mjs";
import { verifyResumeEvidence } from "../tools/run-resume-evidence.mjs";

test("two fresh OS processes resume one durable DSH session through public agents.resume", { timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "xw-m6-3-resume-"));
  const persistenceRoot = join(root, "sessions");
  const replayRoot = join(root, "replay");
  const close1 = join(root, "close-1.json");
  const close2 = join(root, "close-2.json");
  const sessionId = "session-replay-0001";

  const process1 = new DshXwProcessAdapter({ persistenceRoot, replayRoot, closeReceiptPath: close1 }).createHarness();
  const first = await process1.run("run the M6-3 happy replay", { sessionId });
  assert.match(first.finalResponse, /happy replay complete/u);
  await process1.close();
  assert.equal(existsSync(close1), true);
  const receipt1 = JSON.parse(readFileSync(close1, "utf8"));
  assert.equal(receipt1.verifiedClosed, true);

  const createNegative = new DshXwProcessAdapter({ persistenceRoot, replayRoot: join(root, "negative-replay") }).createHarness();
  try {
    await assert.rejects(() => createNegative.run("run the M6-3 happy replay", { sessionId }));
  } finally {
    await createNegative.close();
  }

  const process2 = new DshXwProcessAdapter({
    persistenceRoot,
    replayRoot,
    sessionMode: "resume",
    priorCloseReceiptPath: close1,
    priorCloseReceiptSha256: sha256File(close1),
    closeReceiptPath: close2,
  }).createHarness();
  const second = await process2.run("continue the persisted M6-3 replay", { sessionId });
  assert.match(second.finalResponse, /continue replay complete/u);
  const calls = second.events.filter((event) => event.type === "assistant/message")
    .flatMap((event) => event.data?.message?.content ?? []).filter((block) => block.type === "tool-call").map((block) => block.name);
  assert.deepEqual(calls, ["worker_continue", "trace_query", "worker_complete"]);
  await process2.close();
  assert.equal(JSON.parse(readFileSync(close2, "utf8")).verifiedClosed, true);

  const sessionLogs = readdirSync(persistenceRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl.zstd"));
  assert.ok(sessionLogs.length > 0, "DSH JSONL persistence file must exist");
  assert.ok(sessionLogs.every((entry) => readFileSync(join(entry.parentPath, entry.name)).byteLength > 0));
  const journal = readFileSync(join(replayRoot, "worker-run-0001.journal.jsonl"), "utf8");
  assert.match(journal, /worker_start/u);
  assert.match(journal, /worker_continue/u);
});

test("resume refuses missing or forged process-close evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "xw-m6-3-close-proof-"));
  assert.throws(() => new DshXwProcessAdapter({ sessionMode: "resume", persistenceRoot: join(root, "s"), replayRoot: join(root, "r") }), /priorCloseReceiptPath/u);
  const forged = join(root, "forged.json");
  writeFileSync(forged, JSON.stringify({ schemaId: "xw.dsh.process-close-receipt.v1", verifiedClosed: false, spawnNonce: "forged", pid: process.pid }));
  assert.throws(() => new DshXwProcessAdapter({ sessionMode: "resume", priorCloseReceiptPath: forged, priorCloseReceiptSha256: sha256File(forged), persistenceRoot: join(root, "s"), replayRoot: join(root, "r") }), /invalid/u);
});

test("resume rejects a process-close receipt changed after its hash was recorded", () => {
  const root = mkdtempSync(join(tmpdir(), "xw-m6-3-close-hash-"));
  const receipt = join(root, "close.json");
  writeFileSync(receipt, JSON.stringify({ schemaId: "xw.dsh.process-close-receipt.v1", verifiedClosed: true, spawnNonce: "prior-process-0001", pid: 2147483646 }));
  const recordedSha256 = sha256File(receipt);
  writeFileSync(receipt, `${readFileSync(receipt, "utf8")}\n`);
  assert.throws(() => new DshXwProcessAdapter({
    sessionMode: "resume",
    priorCloseReceiptPath: receipt,
    priorCloseReceiptSha256: recordedSha256,
    persistenceRoot: join(root, "s"),
    replayRoot: join(root, "r"),
  }), { code: "M6_DSH_PROCESS_CLOSE_UNPROVEN" });
});

test("resume refuses a hash-bound close receipt while its recorded process is alive", () => {
  const root = mkdtempSync(join(tmpdir(), "xw-m6-3-old-alive-"));
  const receipt = join(root, "close.json");
  writeFileSync(receipt, JSON.stringify({ schemaId: "xw.dsh.process-close-receipt.v1", verifiedClosed: true, spawnNonce: "still-alive", pid: process.pid }));
  assert.throws(() => new DshXwProcessAdapter({
    sessionMode: "resume",
    priorCloseReceiptPath: receipt,
    priorCloseReceiptSha256: sha256File(receipt),
    persistenceRoot: join(root, "s"),
    replayRoot: join(root, "r"),
  }), { code: "M6_DSH_PROCESS_CLOSE_UNPROVEN" });
});

test("independent resume oracle rejects route and checkpoint mutations", () => {
  const oracle = JSON.parse(readFileSync(new URL("../config/scenario-oracle.v1.json", import.meta.url), "utf8"));
  const evidence = {
    sameSession: true,
    distinctProcessIdentity: true,
    sessionId: oracle.sessionId,
    publicResumePath: oracle.publicResumePath,
    process1: { verifiedClosed: true, calls: [...oracle.process1Calls] },
    process2: { verifiedClosed: true, calls: [...oracle.process2Calls] },
    checkpoint: { ...oracle.checkpoint },
    externalEffect: false,
    actionCount: 0,
  };
  assert.equal(verifyResumeEvidence(evidence, oracle), true);
  for (const mutate of [
    (value) => { value.sessionId = "mutated-session"; },
    (value) => { value.process2.calls = ["worker_start"]; },
    (value) => { value.checkpoint.journalHash = "0".repeat(64); },
    (value) => { value.checkpoint.stateHash = "0".repeat(64); },
  ]) {
    const changed = structuredClone(evidence);
    mutate(changed);
    assert.equal(verifyResumeEvidence(changed, oracle), false);
  }
});
