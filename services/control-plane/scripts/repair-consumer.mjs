#!/usr/bin/env node
/**
 * Windows repair consumer CLI (offline-safe by default).
 *
 *   node scripts/repair-consumer.mjs discover --fixture <proposal.json>
 *   node scripts/repair-consumer.mjs claim-cycle --fixture <proposal.json> --outbox <dir> --actor <id>
 *
 * Live / production claim-cycle MUST supply --checkpoint <real.json>.
 * --offline-demo-checkpoint is fixture/test only and never used on live paths.
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

/** Offline fixture helper only — never call from live consumer paths. */
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

function resolveCheckpoint(argv, proposal, actor) {
  const checkpointPath = option(argv, "--checkpoint");
  if (checkpointPath) {
    return { checkpoint: JSON.parse(readFileSync(checkpointPath, "utf8")), source: "file" };
  }
  if (flag(argv, "--offline-demo-checkpoint")) {
    return { checkpoint: demoCheckpoint(proposal, actor), source: "offline-demo" };
  }
  return { checkpoint: null, source: null };
}

function buildSummary({
  ok,
  status,
  proposal,
  consumer,
  claim,
  actionsPerformed,
  sealed = null,
  stop = null,
  reason = null,
  liveKnowledge = false,
}) {
  const knownSideEffects = {
    deploy: false,
    device_job: false,
    replay: false,
    self_approve: false,
    live_claim_to_production_registry: liveKnowledge,
  };
  const actionsNotPerformed = Object.entries(knownSideEffects)
    .filter(([, performed]) => !performed)
    .map(([name]) => name);
  return {
    ok,
    status,
    reason,
    proposalId: proposal.proposalId,
    proposalSha256: proposalSha256(proposal),
    attempt: consumer.projection?.attempt ?? 0,
    lockRef: claim?.lockRef || consumer.projection?.claim?.lockRef || null,
    lockSha256: claim?.lockSha256 || consumer.projection?.claim?.lockSha256 || null,
    resumed: Boolean(claim?.resumed),
    sourceCheckpoint: sealed
      ? { outboxRef: sealed.checkpoint.outboxRef, bundleSha256: sealed.checkpoint.bundleSha256 }
      : null,
    evidenceDebt: consumer.evidenceDebt,
    waitingFor: stop?.waitingFor || null,
    actionsPerformed,
    actionsNotPerformed,
  };
}

async function main(argv = process.argv.slice(2)) {
  const command = argv[0];
  if (!command || flag(argv, "--help") || flag(argv, "-h")) {
    console.log(`用法:
  node scripts/repair-consumer.mjs discover --fixture <proposal.json>
  node scripts/repair-consumer.mjs claim-cycle --fixture <proposal.json> --outbox <dir> --actor <id> (--checkpoint <file> | --offline-demo-checkpoint)
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
    const liveKnowledge = flag(argv, "--live-knowledge");
    const knowledgeClient = liveKnowledge
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
    const actionsPerformed = ["discover"];
    await consumer.discoverAndSelect({
      expectedProposalId: proposal.proposalId,
      expectedProposalSha256: proposalSha256(proposal),
      expectedBaseCommit: proposal.target.baseCommit,
    });

    const claim = await consumer.ensureClaim({ at: new Date("2026-08-02T12:00:00.000Z") });
    if (!claim.ok) {
      const summary = buildSummary({
        ok: false,
        status: consumer.projection.status,
        proposal,
        consumer,
        claim,
        actionsPerformed,
        reason: claim.reason,
        liveKnowledge,
      });
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      process.exitCode = 2;
      return;
    }
    actionsPerformed.push(claim.resumed ? "resume_claim" : "claim");

    await consumer.heartbeat({ at: new Date("2026-08-02T12:01:00.000Z") });
    actionsPerformed.push("heartbeat");
    await consumer.startFixing({ at: new Date("2026-08-02T12:02:00.000Z") });
    actionsPerformed.push("start_fixing");

    const resolved = resolveCheckpoint(argv, proposal, actor);
    if (!resolved.checkpoint) {
      const summary = buildSummary({
        ok: false,
        status: consumer.projection.status,
        proposal,
        consumer,
        claim,
        actionsPerformed,
        reason: "SOURCE_CHECKPOINT_REQUIRED",
        liveKnowledge,
      });
      const summaryPath = join(resolve(outbox), proposal.transport.outboxNamespace, "consumer-summary.json");
      mkdirSync(dirname(summaryPath), { recursive: true });
      writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      process.exitCode = 2;
      return;
    }

    const sealed = await consumer.sealSourceCheckpoint(resolved.checkpoint, {
      at: new Date("2026-08-02T12:03:00.000Z"),
    });
    actionsPerformed.push(resolved.source === "offline-demo" ? "offline_demo_checkpoint" : "source_checkpoint");
    const stop = consumer.assertStoppedForMacReview();
    const summary = buildSummary({
      ok: true,
      status: stop.status,
      proposal,
      consumer,
      claim,
      actionsPerformed,
      sealed,
      stop,
      liveKnowledge,
    });
    const summaryPath = join(resolve(outbox), proposal.transport.outboxNamespace, "consumer-summary.json");
    mkdirSync(dirname(summaryPath), { recursive: true });
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

export { demoCheckpoint, loadFixture, main, resolveCheckpoint };
