#!/usr/bin/env node
/**
 * Windows Repair Inbox CLI — default read-only discover of backlog repair proposals.
 *
 *   node scripts/repair-inbox.mjs list
 *   node scripts/repair-inbox.mjs discover [--expect-id <proposalId>]
 *   node scripts/repair-inbox.mjs claim --proposal-id <id> --outbox <dir> --actor <id> --i-understand-claim
 *
 * Default is list/discover (no claim, no outbox writes, no device/job).
 * Claim requires --i-understand-claim. This round must not claim live proposals
 * unless a human explicitly opts in.
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
  createRepairInbox,
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

function printHelp() {
  console.log(`用法:
  node scripts/repair-inbox.mjs list|discover [--endpoint <url>] [--expect-id <proposalId>] [--fixture <knowledge-or-proposal.json>] [--skills-root <dir>]
  node scripts/repair-inbox.mjs claim --proposal-id <id> --outbox <dir> --actor <id> --i-understand-claim [--checkpoint <file>] [--endpoint <url>] [--fixture <file>] [--live-knowledge]

默认只读。普通 Skill 说明能力怎么跑；Repair Inbox 决定现在修什么。
禁止把动态 proposalId 硬编码进普通 capability Skill。
领取后只能 heartbeat / 修源码 / source checkpoint（停在 source_review）；不得自批、mark deployable、部署、replay、job/session、碰手机。
`);
}

function loadFixtureItems(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (Array.isArray(raw)) return raw;
  if (raw.knowledge && Array.isArray(raw.knowledge)) return raw.knowledge;
  // Bare proposal → wrap as knowledge envelope so needsEngineer/lifecycle gates apply.
  const proposal = parseKnowledgeProposal(raw) || (raw.schemaId === "xhs.repair-proposal.v1" ? raw : null);
  if (proposal) return [proposalKnowledgeEnvelope(proposal)];
  if (raw.needsEngineer != null && raw.lifecycle != null) return [raw];
  throw new Error("fixture must be knowledge item(s) or xhs.repair-proposal.v1");
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

  const knowledgeClient = fixtureItems
    ? {
      async listRepairKnowledgeItems() {
        return fixtureItems.filter((item) => item?.needsEngineer === true && item?.lifecycle === "backlog");
      },
      async listRepairProposals() {
        const items = await this.listRepairKnowledgeItems();
        return items.map((item) => parseKnowledgeProposal(item)).filter(Boolean);
      },
      async postKnowledge() {
        return { ok: false, debt: true, skipped: true };
      },
      async getKnowledge() {
        return { ok: false, status: 404, knowledge: null };
      },
    }
    : createKnowledgeClient({ endpoint });

  if (command === "list" || command === "discover") {
    const result = await discoverRepairInbox({
      knowledgeClient,
      expectedProposalId: expectId || null,
      expectedProposalSha256: expectSha || null,
      expectedBaseCommit: expectBase || null,
      skillsRoot,
      fixtureItems,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.ok ? 0 : 2;
    return;
  }

  if (command === "claim") {
    const proposalId = option(argv, "--proposal-id") || option(argv, "--expect-id");
    const outbox = option(argv, "--outbox");
    const actor = option(argv, "--actor", "windows-repair-inbox");
    const claimAuthorized = flag(argv, "--i-understand-claim");
    const liveKnowledge = flag(argv, "--live-knowledge");
    const checkpointPath = option(argv, "--checkpoint");

    if (!claimAuthorized) {
      const denied = {
        schemaId: "xhs.repair-inbox.v1",
        mode: "claim",
        ok: false,
        reason: "CLAIM_NOT_AUTHORIZED",
        hint: "Default is read-only. Re-run with --i-understand-claim to claim. This entry never auto-claims.",
        actionsPerformed: [],
        actionsNotPerformed: ["claim", "heartbeat", "start_fixing", "source_checkpoint", ...WINDOWS_CANNOT],
      };
      process.stdout.write(`${JSON.stringify(denied, null, 2)}\n`);
      process.exitCode = 2;
      return;
    }

    if (liveKnowledge && fixturePath) {
      const denied = {
        ok: false,
        reason: "LIVE_KNOWLEDGE_AND_FIXTURE_CONFLICT",
        hint: "Use either --live-knowledge (registry) or --fixture (offline), not both.",
        actionsPerformed: [],
        actionsNotPerformed: ["claim", ...WINDOWS_CANNOT],
      };
      process.stdout.write(`${JSON.stringify(denied, null, 2)}\n`);
      process.exitCode = 2;
      return;
    }
    if (liveKnowledge && flag(argv, "--offline-demo-checkpoint")) {
      const denied = {
        ok: false,
        reason: "OFFLINE_DEMO_FORBIDDEN_WITH_LIVE_KNOWLEDGE",
        actionsPerformed: [],
        actionsNotPerformed: ["claim", ...WINDOWS_CANNOT],
      };
      process.stdout.write(`${JSON.stringify(denied, null, 2)}\n`);
      process.exitCode = 2;
      return;
    }

    if (!proposalId || !outbox) {
      throw new Error("--proposal-id and --outbox required for claim");
    }

    mkdirSync(outbox, { recursive: true });
    const checkpoint = checkpointPath
      ? JSON.parse(readFileSync(checkpointPath, "utf8"))
      : null;

    const client = liveKnowledge
      ? createKnowledgeClient({ endpoint })
      : knowledgeClient;

    const result = await claimRepairInbox({
      knowledgeClient: client,
      outboxRoot: resolve(outbox),
      actorId: actor,
      proposalId,
      claimAuthorized: true,
      expectedProposalSha256: expectSha || null,
      expectedBaseCommit: expectBase || null,
      skillsRoot,
      checkpoint,
      fixtureItems: liveKnowledge ? null : fixtureItems,
      liveKnowledge,
    });

    if (outbox && proposalId) {
      const summaryPath = join(resolve(outbox), `repair/${proposalId}`, "inbox-summary.json");
      mkdirSync(dirname(summaryPath), { recursive: true });
      writeFileSync(summaryPath, `${JSON.stringify(result, null, 2)}\n`);
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
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
    console.log(JSON.stringify({
      ok: false,
      error: error.message,
      actionsNotPerformed: ["claim", ...WINDOWS_CANNOT],
    }));
    process.exitCode = 1;
  });
}

export { loadFixtureItems, main };
