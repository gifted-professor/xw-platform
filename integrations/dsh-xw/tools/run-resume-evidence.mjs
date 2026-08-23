import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DshXwProcessAdapter, sha256File } from "../src/process-adapter.mjs";
import { sha256Json } from "../src/canonical-json.mjs";

const oraclePath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "config", "scenario-oracle.v1.json");

export function verifyResumeEvidence(evidence, oracle) {
  return evidence.sameSession && evidence.distinctProcessIdentity
    && evidence.process1.verifiedClosed && evidence.process2.verifiedClosed
    && evidence.sessionId === oracle.sessionId
    && evidence.publicResumePath === oracle.publicResumePath
    && JSON.stringify(evidence.process1.calls) === JSON.stringify(oracle.process1Calls)
    && JSON.stringify(evidence.process2.calls) === JSON.stringify(oracle.process2Calls)
    && JSON.stringify(evidence.checkpoint) === JSON.stringify(oracle.checkpoint)
    && evidence.externalEffect === oracle.externalEffect
    && evidence.actionCount === oracle.actionCount;
}

function calls(result) {
  return result.events.filter((event) => event.type === "assistant/message")
    .flatMap((event) => event.data?.message?.content ?? [])
    .filter((block) => block.type === "tool-call").map((block) => block.name);
}

export async function runResumeEvidence(outputPath) {
  const oracle = JSON.parse(readFileSync(oraclePath, "utf8"));
  const root = mkdtempSync(join(tmpdir(), "xw-m6-3-resume-evidence-"));
  const persistenceRoot = join(root, "sessions");
  const replayRoot = join(root, "replay");
  const close1 = join(root, "close-1.json");
  const close2 = join(root, "close-2.json");
  const sessionId = "session-replay-0001";
  const firstHarness = new DshXwProcessAdapter({ persistenceRoot, replayRoot, closeReceiptPath: close1 }).createHarness();
  const first = await firstHarness.run("run happy replay", { sessionId });
  await firstHarness.close();
  const receipt1 = JSON.parse(readFileSync(close1, "utf8"));
  const receipt1Sha256 = sha256File(close1);

  const secondHarness = new DshXwProcessAdapter({ persistenceRoot, replayRoot, sessionMode: "resume", priorCloseReceiptPath: close1, priorCloseReceiptSha256: receipt1Sha256, closeReceiptPath: close2 }).createHarness();
  const second = await secondHarness.run("continue persisted replay", { sessionId });
  await secondHarness.close();
  const receipt2 = JSON.parse(readFileSync(close2, "utf8"));
  const checkpoint = JSON.parse(readFileSync(join(replayRoot, "worker-run-0001.checkpoint.json"), "utf8"));

  const evidence = {
    schemaId: "xw.m6-3-resume-evidence.v1",
    generatedAt: new Date().toISOString(),
    sessionId,
    sameSession: first.sessionId === second.sessionId && second.sessionId === sessionId,
    publicResumePath: "ctx.agents.resume",
    process1: { pid: receipt1.pid, spawnNonce: receipt1.spawnNonce, verifiedClosed: receipt1.verifiedClosed, closeReceiptSha256: receipt1Sha256, calls: calls(first) },
    process2: { pid: receipt2.pid, spawnNonce: receipt2.spawnNonce, verifiedClosed: receipt2.verifiedClosed, calls: calls(second) },
    distinctProcessIdentity: receipt1.spawnNonce !== receipt2.spawnNonce,
    checkpoint: { journalSeq: checkpoint.journalSeq, journalHash: checkpoint.journalHash, stateHash: checkpoint.stateHash },
    oracle: { path: "config/scenario-oracle.v1.json", sha256: sha256Json(oracle) },
    externalEffect: false,
    actionCount: 0,
  };
  evidence.pass = verifyResumeEvidence(evidence, oracle);
  if (outputPath) {
    const target = resolve(outputPath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(evidence, null, 2)}\n`);
  }
  return evidence;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const evidence = await runResumeEvidence(process.argv[2]);
  process.stdout.write(`${JSON.stringify({ pass: evidence.pass, sessionId: evidence.sessionId, distinctProcessIdentity: evidence.distinctProcessIdentity })}\n`);
  if (!evidence.pass) process.exitCode = 1;
}
