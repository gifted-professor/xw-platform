#!/usr/bin/env node
/**
 * Windows Repair Inbox CLI — default read-only discover of backlog repair proposals.
 *
 *   node scripts/repair-inbox.mjs list
 *   node scripts/repair-inbox.mjs discover [--expect-id <proposalId>]
 *   node scripts/repair-inbox.mjs claim --proposal-id <id> --outbox <dir> --actor <id> --i-understand-claim --checkpoint <file>
 *
 * Live vs offline is decided by presence of --fixture, NOT by optional --live-knowledge:
 *   - no --fixture  => live (real registry); claim requires --checkpoint before any writes
 *   - --fixture     => offline; may use fixture knowledge only
 *
 * Default is list/discover (no claim, no outbox writes, no device/job).
 * Claim requires --i-understand-claim. Failure summaries go to stdout only (never sealed outbox).
 *
 * Does NOT: self-approve, mark deployable, deploy, replay, submit job/session, operate phones.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createKnowledgeClient, parseKnowledgeProposal } from "./lib/repair-consumer.mjs";
import { proposalKnowledgeEnvelope } from "./lib/repair-proposal.mjs";
import {
  claimRepairInbox,
  createFixtureKnowledgeClient,
  discoverRepairInbox,
  WINDOWS_CANNOT,
} from "./lib/repair-inbox.mjs";

function option(argv, name, fallback = undefined) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
}
function flag(argv, name) {
  return argv.includes(name);
}

/** Live = no fixture. Optional --live-knowledge must not be what decides the gate. */
function isLiveClaimMode(argv) {
  return !option(argv, "--fixture");
}

function printHelp() {
  console.log(`用法:
  node scripts/repair-inbox.mjs list|discover [--endpoint <url>] [--expect-id <proposalId>] [--fixture <knowledge-or-proposal.json>] [--skills-root <dir>]
  node scripts/repair-inbox.mjs claim --proposal-id <id> --outbox <dir> --actor <id> --i-understand-claim --checkpoint <file> [--endpoint <url>]
  node scripts/repair-inbox.mjs claim --fixture <file> --proposal-id <id> --outbox <dir> --actor <id> --i-understand-claim [--checkpoint <file>]

无 --fixture = live（真实 registry）。live claim 必须带 --checkpoint，且在 mkdir/outbox/claim/knowledge 写入之前校验。
--live-knowledge 只是明示 live 的别名文档位，不能用来绕过「无 fixture ⇒ live」判定。
失败摘要只写 stdout，不写 sealed outbox。
`);
}

function loadFixtureItems(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (Array.isArray(raw)) return raw;
  if (raw.knowledge && Array.isArray(raw.knowledge)) return raw.knowledge;
  const proposal = parseKnowledgeProposal(raw) || (raw.schemaId === "xhs.repair-proposal.v1" ? raw : null);
  if (proposal) return [proposalKnowledgeEnvelope(proposal)];
  if (raw.needsEngineer != null && raw.lifecycle != null) return [raw];
  throw new Error("fixture must be knowledge item(s) or xhs.repair-proposal.v1");
}

function writeStdout(result) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function writeSuccessSummary(outbox, proposalId, result) {
  const summaryPath = join(resolve(outbox), `repair/${proposalId}`, "inbox-summary.json");
  mkdirSync(dirname(summaryPath), { recursive: true });
  writeFileSync(summaryPath, `${JSON.stringify(result, null, 2)}\n`);
}

function createOfflineKnowledgeClient(fixtureItems) {
  return createFixtureKnowledgeClient(fixtureItems);
}

async function main(argv = process.argv.slice(2)) {
  const command = argv[0] || "list";
  if (flag(argv, "--help") || flag(argv, "-h")) {
    printHelp();
    return;
  }

  const endpoint = option(argv, "--endpoint", "http://127.0.0.1:17930");
  const fixturePath = option(argv, "--fixture");
  const fixtureItems = fixturePath ? loadFixtureItems(fixturePath) : null;
  const skillsRoot = option(argv, "--skills-root", null);
  const expectId = option(argv, "--expect-id") || option(argv, "--proposal-id");
  const expectSha = option(argv, "--expect-sha256");
  const expectBase = option(argv, "--expect-base");
  const liveMode = isLiveClaimMode(argv);

  if (command === "list" || command === "discover") {
    const knowledgeClient = fixtureItems
      ? createOfflineKnowledgeClient(fixtureItems)
      : createKnowledgeClient({ endpoint });
    const result = await discoverRepairInbox({
      knowledgeClient,
      expectedProposalId: expectId || null,
      expectedProposalSha256: expectSha || null,
      expectedBaseCommit: expectBase || null,
      skillsRoot,
      fixtureItems,
    });
    writeStdout(result);
    process.exitCode = result.ok ? 0 : 2;
    return;
  }

  if (command === "claim") {
    const proposalId = option(argv, "--proposal-id") || option(argv, "--expect-id");
    const outbox = option(argv, "--outbox");
    const actor = option(argv, "--actor", "windows-repair-inbox");
    const claimAuthorized = flag(argv, "--i-understand-claim");
    const checkpointPath = option(argv, "--checkpoint");

    if (!claimAuthorized) {
      writeStdout({
        schemaId: "xhs.repair-inbox.v1",
        mode: "claim",
        ok: false,
        reason: "CLAIM_NOT_AUTHORIZED",
        liveKnowledge: liveMode,
        hint: "Default is read-only. Re-run with --i-understand-claim to claim. This entry never auto-claims.",
        actionsPerformed: [],
        actionsNotPerformed: ["claim", "heartbeat", "start_fixing", "source_checkpoint", ...WINDOWS_CANNOT],
      });
      process.exitCode = 2;
      return;
    }

    if (flag(argv, "--live-knowledge") && fixturePath) {
      writeStdout({
        ok: false,
        reason: "LIVE_KNOWLEDGE_AND_FIXTURE_CONFLICT",
        liveKnowledge: true,
        hint: "Use either live (no --fixture) or --fixture (offline), not both.",
        actionsPerformed: [],
        actionsNotPerformed: ["claim", ...WINDOWS_CANNOT],
      });
      process.exitCode = 2;
      return;
    }
    if (liveMode && flag(argv, "--offline-demo-checkpoint")) {
      writeStdout({
        ok: false,
        reason: "OFFLINE_DEMO_FORBIDDEN_WITH_LIVE_KNOWLEDGE",
        liveKnowledge: true,
        actionsPerformed: [],
        actionsNotPerformed: ["claim", ...WINDOWS_CANNOT],
      });
      process.exitCode = 2;
      return;
    }

    if (!proposalId || !outbox) {
      throw new Error("--proposal-id and --outbox required for claim");
    }

    const checkpoint = checkpointPath
      ? JSON.parse(readFileSync(checkpointPath, "utf8"))
      : null;

    // Live (no fixture): require checkpoint BEFORE mkdir / summary / claim / knowledge writes.
    if (liveMode && !checkpoint) {
      writeStdout({
        schemaId: "xhs.repair-inbox.v1",
        mode: "claim",
        ok: false,
        reason: "SOURCE_CHECKPOINT_REQUIRED",
        liveKnowledge: true,
        proposalId,
        hint: "No --fixture ⇒ live. Provide --checkpoint <real.json> before any outbox/registry writes.",
        actionsPerformed: [],
        actionsNotPerformed: [
          "mkdir_outbox",
          "discover",
          "claim",
          "heartbeat",
          "start_fixing",
          "source_checkpoint",
          "knowledge_post",
          "inbox_summary_write",
          ...WINDOWS_CANNOT,
        ],
      });
      process.exitCode = 2;
      return;
    }

    const knowledgeClient = fixtureItems
      ? createOfflineKnowledgeClient(fixtureItems)
      : createKnowledgeClient({ endpoint });

    mkdirSync(outbox, { recursive: true });
    const result = await claimRepairInbox({
      knowledgeClient,
      outboxRoot: resolve(outbox),
      actorId: actor,
      proposalId,
      claimAuthorized: true,
      expectedProposalSha256: expectSha || null,
      expectedBaseCommit: expectBase || null,
      skillsRoot,
      checkpoint,
      fixtureItems,
      liveKnowledge: liveMode,
    });

    // Failures: stdout only. Never write sealed-outbox summary on failure.
    if (result.ok) {
      writeSuccessSummary(outbox, proposalId, result);
    }
    writeStdout(result);
    process.exitCode = result.ok ? 0 : 2;
    return;
  }

  printHelp();
  throw new Error(`unknown command: ${command}`);
}

const invoked = process.argv[1]
  ? fileURLToPath(new URL(`file://${process.argv[1]}`))
  : null;
if (invoked === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    writeStdout({
      ok: false,
      error: error.message,
      actionsNotPerformed: ["claim", ...WINDOWS_CANNOT],
    });
    process.exitCode = 1;
  });
}

export { isLiveClaimMode, loadFixtureItems, main, writeSuccessSummary };
