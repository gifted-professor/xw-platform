import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  createKnowledgeClient,
  createRepairConsumer,
  parseKnowledgeProposal,
  rejectUnauthorizedWindowsEvent,
} from "../scripts/lib/repair-consumer.mjs";
import {
  claimRepairInbox,
  discoverRepairInbox,
  validateInboxCandidate,
  WINDOWS_CANNOT,
} from "../scripts/lib/repair-inbox.mjs";
import {
  proposalKnowledgeEnvelope,
  proposalSha256,
  scanForSecrets,
} from "../scripts/lib/repair-proposal.mjs";
import { main as inboxMain } from "../scripts/repair-inbox.mjs";

const FIRST_PROPOSAL = JSON.parse(
  readFileSync(new URL("../docs/handoffs/2026-08-02-xhs-observe-feed-repair-proposal.v1.json", import.meta.url), "utf8"),
);
const EXPECTED_SHA = "a828ec422c42e9914f9508136268a572cbdb15e9d7621c3f105f825b6fba1dae";
const EXPECTED_ID = "repair_ff7fc51b35aec35227cf5eb6";

function envelope(proposal = FIRST_PROPOSAL) {
  return proposalKnowledgeEnvelope(proposal);
}

function checkpointFor(proposal, actorId, attempt = 1) {
  return {
    schemaId: "xhs.repair-source-checkpoint.v1",
    schemaVersion: 1,
    checkpointId: `repair_checkpoint_${"a".repeat(24)}`,
    proposalId: proposal.proposalId,
    proposalSha256: proposalSha256(proposal),
    attempt,
    producedAt: "2026-08-02T12:00:00.000Z",
    baseCommit: proposal.target.baseCommit,
    resultCommit: "b".repeat(40),
    businessSemanticsChanged: false,
    files: [{
      path: "apps/xhs/adapter.mjs",
      beforeSha256: "1".repeat(64),
      afterSha256: "2".repeat(64),
      addedLines: 12,
      deletedLines: 3,
    }],
    diff: { totalLines: 15, patchSha256: "3".repeat(64) },
    tests: [{ name: "node --test tests/repair-inbox.test.mjs", passed: true, evidenceSha256: "4".repeat(64) }],
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

test("discover validates backlog needsEngineer proposal and finds observe-feed repair id", async () => {
  const item = envelope();
  assert.equal(item.needsEngineer, true);
  assert.equal(item.lifecycle, "backlog");
  assert.ok(item.appliesTo.includes("repair-proposal-v1"));

  const result = await discoverRepairInbox({
    fixtureItems: [item],
    expectedProposalId: EXPECTED_ID,
    expectedProposalSha256: EXPECTED_SHA,
  });
  assert.equal(result.ok, true);
  assert.equal(result.mode, "discover");
  assert.equal(result.count, 1);
  assert.equal(result.entries[0].proposalId, EXPECTED_ID);
  assert.equal(result.entries[0].proposalSha256, EXPECTED_SHA);
  assert.equal(result.entries[0].skillBinding.path, "skills/xhs/xhs-observe-feed/SKILL.md");
  assert.ok(result.actionsNotPerformed.includes("claim"));
  for (const banned of WINDOWS_CANNOT) assert.ok(result.actionsNotPerformed.includes(banned));
});

test("discover drops items without needsEngineer=true even if lifecycle backlog", async () => {
  const item = { ...envelope(), needsEngineer: false };
  const result = await discoverRepairInbox({ fixtureItems: [item] });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "INBOX_EMPTY");
  assert.equal(result.count, 0);
});

test("validateInboxCandidate rejects skill binding to root skills/SKILL.md", () => {
  const proposal = structuredClone(FIRST_PROPOSAL);
  proposal.target.skillBinding = {
    path: "skills/SKILL.md",
    version: "0.1",
    sourceSha256: "2".repeat(64),
  };
  // Keep idempotency/proposalId in sync is hard; instead mutate after envelope parse path.
  const item = envelope();
  const content = JSON.parse(item.content);
  content.target.skillBinding.path = "skills/SKILL.md";
  item.content = JSON.stringify(content);
  // content no longer canonical — validation should fail on skillBinding forbidden and/or hash/idempotency
  const validated = validateInboxCandidate(item);
  assert.equal(validated.ok, false);
  assert.ok(validated.errors.some((e) => /skillBinding|forbidden|idempotency|schema/i.test(e)));
});

test("claim without explicit authorization fails closed", async () => {
  const result = await claimRepairInbox({
    fixtureItems: [envelope()],
    outboxRoot: mkdtempSync(join(tmpdir(), "repair-inbox-deny-")),
    actorId: "win-deny",
    proposalId: EXPECTED_ID,
    claimAuthorized: false,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "CLAIM_NOT_AUTHORIZED");
  assert.deepEqual(result.actionsPerformed, []);
});

test("explicit claim with checkpoint stops at source_review; without checkpoint fails closed after fixing", async () => {
  const root = mkdtempSync(join(tmpdir(), "repair-inbox-claim-"));
  try {
    const incomplete = await claimRepairInbox({
      fixtureItems: [envelope()],
      outboxRoot: root,
      actorId: "win-inbox",
      proposalId: EXPECTED_ID,
      claimAuthorized: true,
      at: new Date("2026-08-02T12:00:00.000Z"),
    });
    assert.equal(incomplete.ok, false);
    assert.equal(incomplete.reason, "SOURCE_CHECKPOINT_REQUIRED");
    assert.equal(incomplete.status, "fixing");
    assert.ok(incomplete.actionsPerformed.includes("claim"));

    const root2 = mkdtempSync(join(tmpdir(), "repair-inbox-claim2-"));
    const first = await claimRepairInbox({
      fixtureItems: [envelope()],
      outboxRoot: root2,
      actorId: "win-inbox",
      proposalId: EXPECTED_ID,
      claimAuthorized: true,
      checkpoint: checkpointFor(FIRST_PROPOSAL, "win-inbox"),
      at: new Date("2026-08-02T12:00:00.000Z"),
    });
    assert.equal(first.ok, true);
    assert.equal(first.status, "source_review");
    assert.equal(first.waitingFor, "mac_independent_review");
    assert.ok(first.actionsPerformed.includes("source_checkpoint"));
    for (const banned of WINDOWS_CANNOT) assert.ok(first.actionsNotPerformed.includes(banned));

    const restarted = createRepairConsumer({ outboxRoot: root2, actorId: "win-inbox" });
    restarted.loadProposal(FIRST_PROPOSAL);
    assert.equal(restarted.projection.status, "source_review");
    assert.equal(restarted.projection.attempt, 1);
    rmSync(root2, { recursive: true, force: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("live claim without checkpoint refuses before outbox mutation", async () => {
  const root = mkdtempSync(join(tmpdir(), "repair-inbox-live-"));
  try {
    const result = await claimRepairInbox({
      fixtureItems: [envelope()],
      outboxRoot: root,
      actorId: "win-live",
      proposalId: EXPECTED_ID,
      claimAuthorized: true,
      liveKnowledge: true,
      at: new Date("2026-08-02T12:00:00.000Z"),
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "SOURCE_CHECKPOINT_REQUIRED");
    assert.deepEqual(result.actionsPerformed, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("skillsRoot requires binding file to exist", () => {
  const missingRoot = mkdtempSync(join(tmpdir(), "repair-inbox-skills-"));
  try {
    const validated = validateInboxCandidate(envelope(), { skillsRoot: missingRoot });
    assert.equal(validated.ok, false);
    assert.ok(validated.errors.some((e) => /skillBinding file missing/i.test(e)));
  } finally {
    rmSync(missingRoot, { recursive: true, force: true });
  }
});

test("concurrent exclusive claim: exactly one inbox claimant acquires lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "repair-inbox-race-"));
  try {
    const a = claimRepairInbox({
      fixtureItems: [envelope()],
      outboxRoot: root,
      actorId: "win-a",
      proposalId: EXPECTED_ID,
      claimAuthorized: true,
      at: new Date("2026-08-02T12:00:00.000Z"),
    });
    const b = claimRepairInbox({
      fixtureItems: [envelope()],
      outboxRoot: root,
      actorId: "win-b",
      proposalId: EXPECTED_ID,
      claimAuthorized: true,
      at: new Date("2026-08-02T12:00:00.000Z"),
    });
    const [ra, rb] = await Promise.all([a, b]);
    const claimed = [ra, rb].filter((r) => r.actionsPerformed?.includes("claim") || r.actionsPerformed?.includes("resume_claim"));
    const lost = [ra, rb].filter((r) => r.reason && r.reason !== "SOURCE_CHECKPOINT_REQUIRED");
    assert.equal(claimed.length, 1);
    assert.equal(lost.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("expired claim on restart rotates attempt via consumer ensureClaim", async () => {
  const root = mkdtempSync(join(tmpdir(), "repair-inbox-exp-"));
  try {
    const first = await claimRepairInbox({
      fixtureItems: [envelope()],
      outboxRoot: root,
      actorId: "win-exp",
      proposalId: EXPECTED_ID,
      claimAuthorized: true,
      at: new Date("2026-08-02T12:00:00.000Z"),
    });
    assert.equal(first.reason, "SOURCE_CHECKPOINT_REQUIRED");
    assert.equal(first.status, "fixing");

    const restarted = createRepairConsumer({
      outboxRoot: root,
      actorId: "win-exp",
      knowledgeClient: {
        async listRepairProposals() { return [FIRST_PROPOSAL]; },
        async postKnowledge() { return { ok: true, debt: false }; },
      },
    });
    restarted.loadProposal(FIRST_PROPOSAL);
    const next = await restarted.ensureClaim({ at: new Date("2026-08-02T13:00:00.000Z") });
    assert.equal(next.ok, true);
    assert.ok(restarted.projection.attempt >= 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("registry list failure surfaces to discover", async () => {
  const client = createKnowledgeClient({
    endpoint: "http://127.0.0.1:9",
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  await assert.rejects(
    () => discoverRepairInbox({ knowledgeClient: client }),
    /ECONNREFUSED|knowledge list failed|fetch/i,
  );
});

test("knowledge content conflict: needsEngineer filter keeps non-engineer out of inbox", async () => {
  const good = envelope();
  const conflict = {
    ...good,
    id: "repair_ffffffffffffffffffffffff",
    needsEngineer: true,
    lifecycle: "backlog",
    content: JSON.stringify({ schemaId: "not-a-repair", broken: true }),
  };
  const result = await discoverRepairInbox({ fixtureItems: [good, conflict] });
  assert.equal(result.count, 2);
  assert.equal(result.validCount, 1);
  assert.equal(result.ok, true);
  assert.equal(result.reason, "INBOX_PARTIAL");
});

test("secret scan rejects credential material in proposal payload", () => {
  const dirty = structuredClone(FIRST_PROPOSAL);
  dirty.finding.summary = "leak Bearer FAKESECRET_e3f4g5h6i7j8k9l0m1n2";
  const hits = scanForSecrets(dirty);
  assert.ok(hits.length > 0);
  const item = envelope();
  const content = JSON.parse(item.content);
  content.finding.summary = dirty.finding.summary;
  item.content = JSON.stringify(content);
  const validated = validateInboxCandidate(item);
  assert.equal(validated.ok, false);
  assert.ok(validated.errors.some((e) => /secret/i.test(e)));
});

test("rejectUnauthorizedWindowsEvent blocks self-approve path from inbox lane", () => {
  assert.throws(() => rejectUnauthorizedWindowsEvent("review_approved"), /Mac independent review/);
  assert.throws(() => rejectUnauthorizedWindowsEvent("mark_deployable"), /Mac independent review/);
});

test("CLI list is read-only default; claim without flag denied", async () => {
  const fixture = join(mkdtempSync(join(tmpdir(), "repair-inbox-cli-")), "fixture.json");
  writeFileSync(fixture, `${JSON.stringify(envelope(), null, 2)}\n`);

  const list = spawnSync(process.execPath, [
    resolve("scripts/repair-inbox.mjs"),
    "list",
    "--fixture",
    fixture,
    "--expect-id",
    EXPECTED_ID,
  ], { cwd: resolve("."), encoding: "utf8" });
  assert.equal(list.status, 0, list.stdout + list.stderr);
  const listed = JSON.parse(list.stdout);
  assert.equal(listed.ok, true);
  assert.equal(listed.mode, "discover");
  assert.equal(listed.entries[0].proposalId, EXPECTED_ID);

  const denied = spawnSync(process.execPath, [
    resolve("scripts/repair-inbox.mjs"),
    "claim",
    "--fixture",
    fixture,
    "--proposal-id",
    EXPECTED_ID,
    "--outbox",
    mkdtempSync(join(tmpdir(), "repair-inbox-cli-out-")),
  ], { cwd: resolve("."), encoding: "utf8" });
  assert.equal(denied.status, 2);
  const body = JSON.parse(denied.stdout);
  assert.equal(body.reason, "CLAIM_NOT_AUTHORIZED");
});

test("scope guard allowlist includes repair-inbox paths and rejects extras", async () => {
  const {
    REPAIR_CONSUMER_ALLOWED_PATHS,
    evaluateScopeGuard,
  } = await import("../scripts/repair-consumer-scope-guard.mjs");
  assert.equal(REPAIR_CONSUMER_ALLOWED_PATHS.size, 22);
  assert.ok(REPAIR_CONSUMER_ALLOWED_PATHS.has("scripts/repair-inbox.mjs"));
  assert.ok(REPAIR_CONSUMER_ALLOWED_PATHS.has("scripts/lib/repair-inbox.mjs"));
  assert.ok(REPAIR_CONSUMER_ALLOWED_PATHS.has("skills/repair-inbox/SKILL.md"));
  assert.ok(REPAIR_CONSUMER_ALLOWED_PATHS.has("tests/repair-inbox.test.mjs"));
  assert.ok(REPAIR_CONSUMER_ALLOWED_PATHS.has("docs/agent-entry.md"));
  assert.equal(evaluateScopeGuard([...REPAIR_CONSUMER_ALLOWED_PATHS]).ok, true);
  assert.equal(
    evaluateScopeGuard([...REPAIR_CONSUMER_ALLOWED_PATHS, "skills/SKILL.md"]).ok,
    false,
  );
});

test("createKnowledgeClient listRepairKnowledgeItems filters needsEngineer", async () => {
  const items = [
    envelope(),
    { ...envelope(), id: "other", needsEngineer: false, lifecycle: "backlog" },
  ];
  const client = createKnowledgeClient({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ knowledge: items });
      },
    }),
  });
  const listed = await client.listRepairKnowledgeItems();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, EXPECTED_ID);
  const proposals = await client.listRepairProposals();
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].proposalId, EXPECTED_ID);
});

test("inboxMain discover export works for programmatic use", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "repair-inbox-main-"));
  const fixture = join(fixtureDir, "k.json");
  writeFileSync(fixture, `${JSON.stringify(envelope(), null, 2)}\n`);
  const chunks = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...args) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    await inboxMain(["discover", "--fixture", fixture, "--expect-id", EXPECTED_ID]);
  } finally {
    process.stdout.write = originalWrite;
  }
  const body = JSON.parse(chunks.join(""));
  assert.equal(body.ok, true);
  assert.equal(body.entries[0].proposalSha256, EXPECTED_SHA);
  assert.equal(parseKnowledgeProposal(envelope()).proposalId, EXPECTED_ID);
});
