import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DshXwProcessAdapter } from "../src/process-adapter.mjs";

for (const failpoint of [
  "kill-before-call",
  "kill-after-prompt-ack",
  "kill-after-tool-journal-before-dsh-result",
  "kill-after-tool-result-before-checkpoint",
  "kill-after-checkpoint-before-shutdown",
]) test(`${failpoint}: real child dies closed with one verified cleanup sequence`, { timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), `xw-m6-3-fault-${failpoint}-`));
  const closeReceiptPath = join(root, "process-close.json");
  const replayRoot = join(root, "replay");
  const harness = new DshXwProcessAdapter({
    persistenceRoot: join(root, "sessions"),
    replayRoot,
    closeReceiptPath,
    failpoint,
    requestTimeoutMs: 10_000,
  }).createHarness();
  await assert.rejects(() => harness.run("run happy replay", { sessionId: "session-fault-0001" }));
  await harness.close();
  assert.equal(existsSync(closeReceiptPath), true);
  assert.equal(JSON.parse(readFileSync(closeReceiptPath, "utf8")).verifiedClosed, true);
  const journalPath = join(replayRoot, "worker-run-0001.journal.jsonl");
  if (existsSync(journalPath)) {
    const records = readFileSync(journalPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
    const operations = records.filter((record) => record.tool === "phone_act");
    assert.ok(operations.length <= 1, "fault recovery must never duplicate synthetic transition");
    assert.ok(records.every((record) => record.result?.externalEffect === false && record.result?.actionCount === 0));
  }
});
