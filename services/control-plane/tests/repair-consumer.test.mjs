import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertProposalReadyForClaim,
  assertSafeOutboxRef,
  createKnowledgeClient,
  createRepairConsumer,
  exclusiveCreateFile,
  exclusiveWriteJson,
  rejectUnauthorizedWindowsEvent,
  writeAppendOnlyEvent,
} from "../scripts/lib/repair-consumer.mjs";
import {
  applyRepairEvent,
  createRepairEvent,
  initialRepairProjection,
  proposalKnowledgeEnvelope,
  proposalSha256,
} from "../scripts/lib/repair-proposal.mjs";

const FIRST_PROPOSAL = JSON.parse(
  readFileSync(new URL("../docs/handoffs/2026-08-02-xhs-observe-feed-repair-proposal.v1.json", import.meta.url), "utf8"),
);
const EXPECTED_SHA = "a828ec422c42e9914f9508136268a572cbdb15e9d7621c3f105f825b6fba1dae";

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

test("first proposal fixture matches Mac contract anchors", () => {
  const checked = assertProposalReadyForClaim(FIRST_PROPOSAL, {
    expectedProposalId: "repair_ff7fc51b35aec35227cf5eb6",
    expectedProposalSha256: EXPECTED_SHA,
    expectedBaseCommit: "5677e61e3363d2afc415e9add5f89f873fc7a32d",
  });
  assert.equal(checked.proposalSha256, EXPECTED_SHA);
  assert.equal(FIRST_PROPOSAL.target.capabilityId, "xhs.observe.feed");
  assert.equal(FIRST_PROPOSAL.target.skillBinding.sourceSha256, "2baba76b8c9c877c1f63e2a824096c2065f90031db119238a6e33bf864e9720d");
});

test("exclusive claim lock: concurrent creators yield exactly one winner", () => {
  const root = mkdtempSync(join(tmpdir(), "repair-claim-race-"));
  try {
    const ref = "repair/repair_ff7fc51b35aec35227cf5eb6/attempt-1/claim.lock";
    const body = `${JSON.stringify({ schemaId: "xhs.repair-claim-lock.v1", n: 1 })}\n`;
    const first = exclusiveCreateFile(root, ref, body);
    const second = exclusiveCreateFile(root, ref, body);
    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
    assert.equal(second.reason, "EEXIST");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("consumer claim→heartbeat→fix→source_checkpoint stops for Mac review", async () => {
  const root = mkdtempSync(join(tmpdir(), "repair-consumer-cycle-"));
  try {
    const actorId = "win-consumer-1";
    const posts = [];
    const knowledgeClient = {
      async listRepairProposals() {
        return [FIRST_PROPOSAL];
      },
      async postKnowledge(envelope) {
        posts.push(envelope);
        return { ok: true, debt: false, id: envelope.id };
      },
    };
    const consumer = createRepairConsumer({
      outboxRoot: root,
      actorId,
      knowledgeClient,
    });
    await consumer.discoverAndSelect({
      expectedProposalId: FIRST_PROPOSAL.proposalId,
      expectedProposalSha256: EXPECTED_SHA,
      expectedBaseCommit: FIRST_PROPOSAL.target.baseCommit,
    });
    const claim = consumer.tryClaim({ at: new Date("2026-08-02T12:00:00.000Z") });
    assert.equal(claim.ok, true);
    assert.match(claim.lockRef, /attempt-1\/claim\.lock$/);
    consumer.heartbeat({ at: new Date("2026-08-02T12:01:00.000Z") });
    consumer.startFixing({ at: new Date("2026-08-02T12:02:00.000Z") });
    const sealed = consumer.sealSourceCheckpoint(
      checkpointFor(FIRST_PROPOSAL, actorId),
      { at: new Date("2026-08-02T12:03:00.000Z") },
    );
    assert.equal(consumer.projection.status, "source_review");
    assert.equal(consumer.assertStoppedForMacReview().waitingFor, "mac_independent_review");
    assert.throws(() => rejectUnauthorizedWindowsEvent("review_approved"), /cannot emit/);
    assert.throws(() => rejectUnauthorizedWindowsEvent("mark_deployable"), /cannot emit/);
    assert.equal(sealed.checkpoint.bundleSha256.length, 64);
    await consumer.mirrorEventKnowledge(sealed.event);
    assert.equal(posts.at(-1).id, sealed.event.eventId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("second claimant loses exclusive lock without mutating projection", () => {
  const root = mkdtempSync(join(tmpdir(), "repair-consumer-second-"));
  try {
    const a = createRepairConsumer({ outboxRoot: root, actorId: "win-a" });
    const b = createRepairConsumer({ outboxRoot: root, actorId: "win-b" });
    a.loadProposal(FIRST_PROPOSAL);
    b.loadProposal(FIRST_PROPOSAL);
    const first = a.tryClaim({ at: new Date("2026-08-02T12:00:00.000Z") });
    const second = b.tryClaim({ at: new Date("2026-08-02T12:00:00.000Z") });
    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
    assert.equal(second.reason, "EEXIST");
    assert.equal(b.projection.status, "proposed");
    assert.equal(a.projection.status, "claimed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("append-only events are idempotent for same bytes and reject same id different content", () => {
  const root = mkdtempSync(join(tmpdir(), "repair-events-"));
  try {
    const projection = initialRepairProjection(FIRST_PROPOSAL);
    const event = createRepairEvent(FIRST_PROPOSAL, projection, {
      eventType: "fail",
      actor: { role: "windows_consumer", id: "win" },
      occurredAt: "2026-08-02T12:00:00.000Z",
      payload: { reason: "demo" },
    });
    // fail from proposed may be invalid for apply — only test file append helper
    const path1 = writeAppendOnlyEvent(root, FIRST_PROPOSAL, event);
    const path2 = writeAppendOnlyEvent(root, FIRST_PROPOSAL, event);
    assert.equal(path1, path2);
    const collided = structuredClone(event);
    collided.payload = { reason: "other" };
    // force same eventId with different content
    assert.throws(
      () => {
        const ref = `${FIRST_PROPOSAL.transport.outboxNamespace}/events/${event.eventId}.json`;
        exclusiveCreateFile(root, ref, `${JSON.stringify(collided)}\n`);
        writeAppendOnlyEvent(root, FIRST_PROPOSAL, collided);
      },
      /collision|EEXIST/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("same eventId different content is rejected by reducer", () => {
  const root = mkdtempSync(join(tmpdir(), "repair-reducer-idem-"));
  try {
    const consumer = createRepairConsumer({ outboxRoot: root, actorId: "win-idem" });
    consumer.loadProposal(FIRST_PROPOSAL);
    const claim = consumer.tryClaim({ at: new Date("2026-08-02T12:00:00.000Z") });
    assert.equal(claim.ok, true);
    const again = applyRepairEvent(FIRST_PROPOSAL, consumer.projection, claim.event, consumer.verifiers);
    assert.equal(again.status, "claimed");
    const mutated = structuredClone(claim.event);
    mutated.payload = { ...mutated.payload, expiresAt: "2026-08-02T12:30:00.000Z" };
    assert.throws(
      () => applyRepairEvent(FIRST_PROPOSAL, consumer.projection, mutated, consumer.verifiers),
      /eventId collision/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows cannot self-approve, modify verdict, or emit Mac-only events", () => {
  assert.throws(() => rejectUnauthorizedWindowsEvent("review_approved"), /cannot emit/);
  assert.throws(() => rejectUnauthorizedWindowsEvent("mark_deployable"), /cannot emit/);
  const root = mkdtempSync(join(tmpdir(), "repair-self-approve-"));
  try {
    const consumer = createRepairConsumer({ outboxRoot: root, actorId: "win-bad" });
    consumer.loadProposal(FIRST_PROPOSAL);
    consumer.tryClaim({ at: new Date("2026-08-02T12:00:00.000Z") });
    consumer.startFixing({ at: new Date("2026-08-02T12:01:00.000Z") });
    consumer.sealSourceCheckpoint(checkpointFor(FIRST_PROPOSAL, "win-bad"), { at: new Date("2026-08-02T12:02:00.000Z") });
    assert.throws(() => consumer.assertStoppedForMacReview() && rejectUnauthorizedWindowsEvent("review_approved"), /cannot emit/);
    const forged = createRepairEvent(FIRST_PROPOSAL, consumer.projection, {
      eventType: "review_approved",
      actor: { role: "windows_consumer", id: "win-bad" },
      occurredAt: "2026-08-02T12:03:00.000Z",
      payload: {
        reviewReceiptSha256: "f".repeat(64),
        authority: {
          macCommit: "8".repeat(40),
          reviewReceiptPath: "docs/handoffs/repair-reviews/x.json",
          reviewReceiptSha256: "f".repeat(64),
          reviewedCheckpointSha256: consumer.projection.lastSourceCheckpoint.bundleSha256,
        },
      },
    });
    assert.throws(
      () => applyRepairEvent(FIRST_PROPOSAL, consumer.projection, forged, consumer.verifiers),
      /mac_governance or human|not trusted/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("knowledge write failure records transport debt without changing projection status", async () => {
  const root = mkdtempSync(join(tmpdir(), "repair-debt-"));
  try {
    const knowledgeClient = {
      async listRepairProposals() { return [FIRST_PROPOSAL]; },
      async postKnowledge() { return { ok: false, debt: true, status: 500, code: "DOWN" }; },
    };
    const consumer = createRepairConsumer({ outboxRoot: root, actorId: "win-debt", knowledgeClient });
    await consumer.discoverAndSelect({ expectedProposalId: FIRST_PROPOSAL.proposalId, expectedProposalSha256: EXPECTED_SHA });
    const claim = consumer.tryClaim({ at: new Date("2026-08-02T12:00:00.000Z") });
    assert.equal(claim.ok, true);
    const mirror = await consumer.mirrorEventKnowledge(claim.event);
    assert.equal(mirror.debt, true);
    assert.equal(consumer.projection.status, "claimed");
    assert.equal(consumer.evidenceDebt[0].businessResultUnchanged, true);
    assert.equal(consumer.evidenceDebt[0].code, "KNOWLEDGE_MIRROR_FAILED");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("outbox refs reject traversal and empty segments", () => {
  assert.throws(() => assertSafeOutboxRef("../etc/passwd"), /unsafe/);
  assert.throws(() => assertSafeOutboxRef("repair//x"), /unsafe/);
  assert.throws(() => assertSafeOutboxRef("C:/temp/x"), /unsafe/);
  assert.throws(() => exclusiveWriteJson(tmpdir(), "repair/../escape/lock", { a: 1 }), /unsafe/);
});

test("claim expiry and attempt failure drive circuit breaker via consumer events", () => {
  const root = mkdtempSync(join(tmpdir(), "repair-breaker-"));
  try {
    const consumer = createRepairConsumer({ outboxRoot: root, actorId: "win-break" });
    consumer.loadProposal(FIRST_PROPOSAL);
    assert.equal(consumer.tryClaim({ at: new Date("2026-08-02T12:00:00.000Z") }).ok, true);
    consumer.expireClaim({ at: new Date("2026-08-02T12:16:00.000Z") });
    assert.equal(consumer.projection.status, "proposed");
    assert.equal(consumer.projection.circuitBreaker.consecutiveFailures, 1);
    assert.equal(consumer.tryClaim({ at: new Date("2026-08-02T12:17:00.000Z") }).ok, true);
    consumer.failAttempt({ reason: "fixture failed", at: new Date("2026-08-02T12:17:30.000Z") });
    assert.equal(consumer.projection.status, "failed");
    assert.equal(consumer.projection.circuitBreaker.state, "open");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("forbidden path and max diff rejected at source checkpoint seal", () => {
  const root = mkdtempSync(join(tmpdir(), "repair-scope-"));
  try {
    const consumer = createRepairConsumer({ outboxRoot: root, actorId: "win-scope" });
    consumer.loadProposal(FIRST_PROPOSAL);
    consumer.tryClaim({ at: new Date("2026-08-02T12:00:00.000Z") });
    consumer.startFixing({ at: new Date("2026-08-02T12:01:00.000Z") });
    const bad = checkpointFor(FIRST_PROPOSAL, "win-scope");
    bad.files[0].path = "skills/SKILL.md";
    assert.throws(() => consumer.sealSourceCheckpoint(bad, { at: new Date("2026-08-02T12:02:00.000Z") }), /outside|allowlist|scope/i);
    const huge = checkpointFor(FIRST_PROPOSAL, "win-scope");
    huge.files[0].addedLines = 500;
    huge.diff.totalLines = 500;
    assert.throws(() => consumer.sealSourceCheckpoint(huge, { at: new Date("2026-08-02T12:02:00.000Z") }), /limit|invalid/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("knowledge client discovery parses registry envelopes offline", async () => {
  const envelope = proposalKnowledgeEnvelope(FIRST_PROPOSAL);
  const client = createKnowledgeClient({
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return { knowledge: [envelope] };
      },
    }),
  });
  const list = await client.listRepairProposals();
  assert.equal(list[0].proposalId, FIRST_PROPOSAL.proposalId);
});

test("unauthorized deploy/replay paths remain rejected without trusted keys", () => {
  const root = mkdtempSync(join(tmpdir(), "repair-noreplay-"));
  try {
    const consumer = createRepairConsumer({
      outboxRoot: root,
      actorId: "win-noreplay",
      replayAuthorizationPublicKeys: {},
    });
    consumer.loadProposal(FIRST_PROPOSAL);
    // missing public keys => verifier fail-closed for replay
    assert.equal(
      consumer.verifiers.verifyReplayAuthorization({
        proposal: FIRST_PROPOSAL,
        projection: {
          ...initialRepairProjection(FIRST_PROPOSAL),
          status: "deployable",
          deployableEventId: "repair_event_" + "a".repeat(24),
          deployableResultCommit: "9".repeat(40),
          proposalSha256: proposalSha256(FIRST_PROPOSAL),
        },
        event: { occurredAt: "2026-08-02T12:00:00.000Z" },
        authorization: {
          authorizationRef: "docs/handoffs/repair-authorizations/x.json",
          authorizationSha256: "1".repeat(64),
          authorizationCommit: "2".repeat(40),
        },
      }),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
