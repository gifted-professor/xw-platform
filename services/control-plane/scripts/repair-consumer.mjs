#!/usr/bin/env node
/**
 * Windows repair consumer CLI (offline-safe by default).
 *
 *   node scripts/repair-consumer.mjs discover --fixture <proposal.json>
 *   node scripts/repair-consumer.mjs claim-cycle --fixture <proposal.json> --outbox <dir> --actor <id>
 *
 * Does NOT deploy, submit jobs, touch devices, or POST live registry unless
 * --endpoint is explicitly provided with --live-knowledge (still never deploys).
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import {
  assertProposalReadyForClaim,
  createKnowledgeClient,
  createRepairConsumer,
  parseKnowledgeProposal,
} from "./lib/repair-consumer.mjs";
import { proposalSha256 } from "./lib/repair-proposal.mjs";

function option(argv, name, fallback = undefined) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
}
function flag(argv, name) {
  return argv.includes(name);
}

function loadFixture(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return parseKnowledgeProposal(raw) || raw;
}

function demoCheckpoint(proposal, actorId) {
  return {
    schemaId: "xhs.repair-source-checkpoint.v1",
    schemaVersion: 1,
    checkpointId: `repair_checkpoint_${"c".repeat(24)}`,
    proposalId: proposal.proposalId,
    proposalSha256: proposalSha256(proposal),
    attempt: 1,
    producedAt: "2026-08-02T12:00:00.000Z",
    baseCommit: proposal.target.baseCommit,
    resultCommit: "d".repeat(40),
    businessSemanticsChanged: false,
    files: [{
      path: proposal.policy.allowedPaths.find((p) => !p.includes("*")) || "apps/xhs/adapter.mjs",
      beforeSha256: "1".repeat(64),
      afterSha256: "2".repeat(64),
      addedLines: 10,
      deletedLines: 2,
    }],
    diff: { totalLines: 12, patchSha256: "3".repeat(64) },
    tests: [{ name: "node --test tests/repair-consumer.test.mjs", passed: true, evidenceSha256: "4".repeat(64) }],
    scopeGuard: { passed: true, evidenceSha256: "5".repeat(64) },
    secretScan: { passed: true, evidenceSha256: "6".repeat(64) },
    evidenceDebt: [],
    authority: {
      actorId,
      actorRole: "windows_consumer",
      reviewVerdictModified: false,
      macWritePerformed: false,
      deploymentPerformed: false,
      deviceActions: 0,
    },
  };
}

async function main(argv = process.argv.slice(2)) {
  const command = argv[0];
  if (!command || flag(argv, "--help") || flag(argv, "-h")) {
    console.log(`用法:
  node scripts/repair-consumer.mjs discover --fixture <proposal.json>
  node scripts/repair-consumer.mjs claim-cycle --fixture <proposal.json> --outbox <dir> --actor <id>
`);
    process.exitCode = command ? 0 : 4;
    return;
  }

  if (command === "discover") {
    const fixture = option(argv, "--fixture");
    if (!fixture) throw new Error("--fixture required for offline discover");
    const proposal = loadFixture(fixture);
    const checked = assertProposalReadyForClaim(proposal, {
      expectedProposalId: option(argv, "--expect-id"),
      expectedProposalSha256: option(argv, "--expect-sha256"),
      expectedBaseCommit: option(argv, "--expect-base"),
    });
    process.stdout.write(`${JSON.stringify({
      ok: true,
      proposalId: checked.proposal.proposalId,
      proposalSha256: checked.proposalSha256,
      status: checked.proposal.status,
      outboxNamespace: checked.proposal.transport.outboxNamespace,
    }, null, 2)}\n`);
    return;
  }

  if (command === "claim-cycle") {
    const fixture = option(argv, "--fixture");
    const outbox = option(argv, "--outbox");
    const actor = option(argv, "--actor", "windows-repair-consumer");
    if (!fixture || !outbox) throw new Error("--fixture and --outbox required");
    mkdirSync(outbox, { recursive: true });
    const proposal = loadFixture(fixture);
    const knowledgeClient = flag(argv, "--live-knowledge")
      ? createKnowledgeClient({ endpoint: option(argv, "--endpoint", "http://127.0.0.1:17930") })
      : {
        async listRepairProposals() { return [proposal]; },
        async postKnowledge() { return { ok: false, debt: true, skipped: true }; },
      };
    const consumer = createRepairConsumer({
      outboxRoot: resolve(outbox),
      actorId: actor,
      knowledgeClient,
    });
    await consumer.discoverAndSelect({
      expectedProposalId: proposal.proposalId,
      expectedProposalSha256: proposalSha256(proposal),
      expectedBaseCommit: proposal.target.baseCommit,
    });
    const claim = consumer.tryClaim({ at: new Date("2026-08-02T12:00:00.000Z") });
    if (!claim.ok) {
      process.stdout.write(`${JSON.stringify({ ok: false, phase: "claim", reason: claim.reason }, null, 2)}\n`);
      process.exitCode = 2;
      return;
    }
    consumer.heartbeat({ at: new Date("2026-08-02T12:01:00.000Z") });
    consumer.startFixing({ at: new Date("2026-08-02T12:02:00.000Z") });
    const checkpoint = demoCheckpoint(proposal, actor);
    const sealed = consumer.sealSourceCheckpoint(checkpoint, { at: new Date("2026-08-02T12:03:00.000Z") });
    const stop = consumer.assertStoppedForMacReview();
    const debt = await consumer.mirrorEventKnowledge(sealed.event);
    const summary = {
      ok: true,
      status: stop.status,
      proposalId: proposal.proposalId,
      proposalSha256: proposalSha256(proposal),
      attempt: consumer.projection.attempt,
      lockRef: claim.lockRef,
      lockSha256: claim.lockSha256,
      sourceCheckpoint: {
        outboxRef: sealed.checkpoint.outboxRef,
        bundleSha256: sealed.checkpoint.bundleSha256,
      },
      knowledgeMirror: debt,
      evidenceDebt: consumer.evidenceDebt,
      waitingFor: stop.waitingFor,
      notPerformed: ["deploy", "live_claim_to_production_registry", "device_job", "replay", "self_approve"],
    };
    const summaryPath = join(resolve(outbox), proposal.transport.outboxNamespace, "consumer-summary.json");
    writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }

  throw new Error(`unknown command: ${command}`);
}

const invoked = process.argv[1] ? fileURLToPath(new URL(`file://${process.argv[1]}`)) : null;
if (invoked === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.log(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 1;
  });
}

export { demoCheckpoint, loadFixture, main };
