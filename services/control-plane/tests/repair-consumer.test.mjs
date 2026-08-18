import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  assertProposalReadyForClaim,
  assertSafeOutboxRef,
  atomicReplaceJson,
  createKnowledgeClient,
  createRepairConsumer,
  exclusiveCreateFile,
  exclusiveWriteJson,
  listOutboxEvents,
  reduceOutboxEvents,
  rejectUnauthorizedWindowsEvent,
  resolveWritableOutboxPath,
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

function listFilesRecursive(root) {
  const out = [];
  function walk(dir) {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, name.name);
      if (name.isDirectory()) walk(full);
      else out.push(full);
    }
  }
  walk(root);
  return out;
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
    const claim = await consumer.tryClaim({ at: new Date("2026-08-02T12:00:00.000Z") });
    assert.equal(claim.ok, true);
    assert.match(claim.lockRef, /attempt-1\/claim\.lock$/);
    await consumer.heartbeat({ at: new Date("2026-08-02T12:01:00.000Z") });
    await consumer.startFixing({ at: new Date("2026-08-02T12:02:00.000Z") });
    const sealed = await consumer.sealSourceCheckpoint(
      checkpointFor(FIRST_PROPOSAL, actorId),
      { at: new Date("2026-08-02T12:03:00.000Z") },
    );
    assert.equal(consumer.projection.status, "source_review");
    assert.equal(consumer.assertStoppedForMacReview().waitingFor, "mac_independent_review");
    assert.throws(() => rejectUnauthorizedWindowsEvent("review_approved"), /cannot emit/);
    assert.throws(() => rejectUnauthorizedWindowsEvent("mark_deployable"), /cannot emit/);
    assert.equal(sealed.checkpoint.bundleSha256.length, 64);
    assert.equal(posts.length, 4);
    assert.deepEqual(posts.map((item) => item.id), [
      claim.event.eventId,
      consumer.listEvents().find((e) => e.eventType === "heartbeat").eventId,
      consumer.listEvents().find((e) => e.eventType === "start_fixing").eventId,
      sealed.event.eventId,
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("second claimant loses exclusive lock without mutating projection", async () => {
  const root = mkdtempSync(join(tmpdir(), "repair-consumer-second-"));
  try {
    const a = createRepairConsumer({ outboxRoot: root, actorId: "win-a" });
    const b = createRepairConsumer({ outboxRoot: root, actorId: "win-b" });
    await a.loadProposal(FIRST_PROPOSAL);
    await b.loadProposal(FIRST_PROPOSAL);
    const first = await a.tryClaim({ at: new Date("2026-08-02T12:00:00.000Z") });
    const second = await b.tryClaim({ at: new Date("2026-08-02T12:00:00.000Z") });
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
    const path1 = writeAppendOnlyEvent(root, FIRST_PROPOSAL, event);
    const path2 = writeAppendOnlyEvent(root, FIRST_PROPOSAL, event);
    assert.equal(path1, path2);
    const collided = structuredClone(event);
    collided.payload = { reason: "other" };
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

test("same eventId different content is rejected by reducer", async () => {
  const root = mkdtempSync(join(tmpdir(), "repair-reducer-idem-"));
  try {
    const consumer = createRepairConsumer({ outboxRoot: root, actorId: "win-idem" });
    await consumer.loadProposal(FIRST_PROPOSAL);
    const claim = await consumer.tryClaim({ at: new Date("2026-08-02T12:00:00.000Z") });
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

test("Windows cannot self-approve, modify verdict, or emit Mac-only events", async () => {
  assert.throws(() => rejectUnauthorizedWindowsEvent("review_approved"), /cannot emit/);
  assert.throws(() => rejectUnauthorizedWindowsEvent("mark_deployable"), /cannot emit/);
  const root = mkdtempSync(join(tmpdir(), "repair-self-approve-"));
  try {
    const consumer = createRepairConsumer({ outboxRoot: root, actorId: "win-bad" });
    await consumer.loadProposal(FIRST_PROPOSAL);
    await consumer.tryClaim({ at: new Date("2026-08-02T12:00:00.000Z") });
    await consumer.startFixing({ at: new Date("2026-08-02T12:01:00.000Z") });
    await consumer.sealSourceCheckpoint(checkpointFor(FIRST_PROPOSAL, "win-bad"), { at: new Date("2026-08-02T12:02:00.000Z") });
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
    const claim = await consumer.tryClaim({ at: new Date("2026-08-02T12:00:00.000Z") });
    assert.equal(claim.ok, true);
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

test("claim expiry and attempt failure drive circuit breaker via consumer events", async () => {
  const root = mkdtempSync(join(tmpdir(), "repair-breaker-"));
  try {
    const consumer = createRepairConsumer({ outboxRoot: root, actorId: "win-break" });
    await consumer.loadProposal(FIRST_PROPOSAL);
    assert.equal((await consumer.tryClaim({ at: new Date("2026-08-02T12:00:00.000Z") })).ok, true);
    await consumer.expireClaim({ at: new Date("2026-08-02T12:16:00.000Z") });
    assert.equal(consumer.projection.status, "proposed");
    assert.equal(consumer.projection.circuitBreaker.consecutiveFailures, 1);
    assert.equal((await consumer.tryClaim({ at: new Date("2026-08-02T12:17:00.000Z") })).ok, true);
    await consumer.failAttempt({ reason: "fixture failed", at: new Date("2026-08-02T12:17:30.000Z") });
    assert.equal(consumer.projection.status, "failed");
    assert.equal(consumer.projection.circuitBreaker.state, "open");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("forbidden path and max diff rejected at source checkpoint seal", async () => {
  const root = mkdtempSync(join(tmpdir(), "repair-scope-"));
  try {
    const consumer = createRepairConsumer({ outboxRoot: root, actorId: "win-scope" });
    await consumer.loadProposal(FIRST_PROPOSAL);
    await consumer.tryClaim({ at: new Date("2026-08-02T12:00:00.000Z") });
    await consumer.startFixing({ at: new Date("2026-08-02T12:01:00.000Z") });
    const bad = checkpointFor(FIRST_PROPOSAL, "win-scope");
    bad.files[0].path = "skills/SKILL.md";
    await assert.rejects(
      () => consumer.sealSourceCheckpoint(bad, { at: new Date("2026-08-02T12:02:00.000Z") }),
      /outside|allowlist|scope/i,
    );
    const huge = checkpointFor(FIRST_PROPOSAL, "win-scope");
    huge.files[0].addedLines = 500;
    huge.diff.totalLines = 500;
    await assert.rejects(
      () => consumer.sealSourceCheckpoint(huge, { at: new Date("2026-08-02T12:02:00.000Z") }),
      /limit|invalid/i,
    );
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

test("unauthorized deploy/replay paths remain rejected without trusted keys", async () => {
  const root = mkdtempSync(join(tmpdir(), "repair-noreplay-"));
  try {
    const consumer = createRepairConsumer({
      outboxRoot: root,
      actorId: "win-noreplay",
      replayAuthorizationPublicKeys: {},
    });
    await consumer.loadProposal(FIRST_PROPOSAL);
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

test("restart recovery resumes same-actor claim and continues heartbeat/fixing", async () => {
  const root = mkdtempSync(join(tmpdir(), "repair-restart-"));
  try {
    const first = createRepairConsumer({ outboxRoot: root, actorId: "win-restart" });
    await first.loadProposal(FIRST_PROPOSAL);
    const claim = await first.tryClaim({ at: new Date("2026-08-02T12:00:00.000Z") });
    assert.equal(claim.ok, true);
    await first.heartbeat({ at: new Date("2026-08-02T12:01:00.000Z") });

    const restarted = createRepairConsumer({ outboxRoot: root, actorId: "win-restart" });
    await restarted.loadProposal(FIRST_PROPOSAL);
    assert.equal(restarted.projection.status, "claimed");
    assert.equal(restarted.projection.claim.holder, "win-restart");
    assert.equal(restarted.projection.attempt, 1);
    const resumed = await restarted.tryClaim({ at: new Date("2026-08-02T12:02:00.000Z") });
    assert.equal(resumed.ok, true);
    assert.equal(resumed.resumed, true);
    await restarted.heartbeat({ at: new Date("2026-08-02T12:03:00.000Z") });
    await restarted.startFixing({ at: new Date("2026-08-02T12:04:00.000Z") });
    assert.equal(restarted.projection.status, "fixing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restart after expired claim writes claim_expired then claims next attempt", async () => {
  const root = mkdtempSync(join(tmpdir(), "repair-expired-restart-"));
  try {
    const first = createRepairConsumer({ outboxRoot: root, actorId: "win-exp" });
    await first.loadProposal(FIRST_PROPOSAL);
    assert.equal((await first.tryClaim({ at: new Date("2026-08-02T12:00:00.000Z") })).ok, true);

    const restarted = createRepairConsumer({ outboxRoot: root, actorId: "win-exp" });
    await restarted.loadProposal(FIRST_PROPOSAL);
    const next = await restarted.ensureClaim({ at: new Date("2026-08-02T12:16:00.000Z") });
    assert.equal(next.ok, true);
    assert.equal(restarted.projection.attempt, 2);
    assert.equal(restarted.projection.status, "claimed");
    assert.match(next.lockRef, /attempt-2\/claim\.lock$/);
    const types = restarted.listEvents().map((e) => e.eventType);
    assert.ok(types.includes("claim_expired"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("duplicate events and event collisions are handled on recovery", async () => {
  const root = mkdtempSync(join(tmpdir(), "repair-dup-events-"));
  try {
    const consumer = createRepairConsumer({ outboxRoot: root, actorId: "win-dup" });
    await consumer.loadProposal(FIRST_PROPOSAL);
    const claim = await consumer.tryClaim({ at: new Date("2026-08-02T12:00:00.000Z") });
    writeAppendOnlyEvent(root, FIRST_PROPOSAL, claim.event); // idempotent re-append
    const reduced = reduceOutboxEvents(FIRST_PROPOSAL, listOutboxEvents(root, FIRST_PROPOSAL), consumer.verifiers);
    assert.equal(reduced.status, "claimed");
    assert.equal(reduced.eventIds.length, 1);

    const mutated = structuredClone(claim.event);
    mutated.payload = { ...mutated.payload, expiresAt: "2026-08-02T15:00:00.000Z" };
    assert.throws(
      () => applyRepairEvent(FIRST_PROPOSAL, reduced, mutated, consumer.verifiers),
      /eventId collision/,
    );
    assert.throws(
      () => writeAppendOnlyEvent(root, FIRST_PROPOSAL, mutated),
      /collision/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("orphan claim.lock after event write failure is cleared on restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "repair-orphan-lock-"));
  try {
    let failWrite = true;
    const consumer = createRepairConsumer({
      outboxRoot: root,
      actorId: "win-orphan",
      writeEventImpl: (outboxRoot, proposal, event) => {
        if (failWrite) throw new Error("injected event write failure");
        return writeAppendOnlyEvent(outboxRoot, proposal, event);
      },
    });
    await consumer.loadProposal(FIRST_PROPOSAL);
    const failed = await consumer.tryClaim({ at: new Date("2026-08-02T12:00:00.000Z") });
    assert.equal(failed.ok, false);
    assert.equal(failed.orphanLock, true);
    assert.equal(consumer.projection.status, "proposed");
    assert.equal(listOutboxEvents(root, FIRST_PROPOSAL).length, 0);

    failWrite = false;
    const restarted = createRepairConsumer({ outboxRoot: root, actorId: "win-orphan" });
    await restarted.loadProposal(FIRST_PROPOSAL);
    const claimed = await restarted.tryClaim({ at: new Date("2026-08-02T12:01:00.000Z") });
    assert.equal(claimed.ok, true);
    assert.equal(restarted.projection.status, "claimed");
    assert.equal(restarted.projection.attempt, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("event write failure does not advance in-memory projection", async () => {
  const root = mkdtempSync(join(tmpdir(), "repair-atomic-"));
  try {
    const consumer = createRepairConsumer({
      outboxRoot: root,
      actorId: "win-atomic",
      writeEventImpl: () => {
        throw new Error("disk full");
      },
    });
    await consumer.loadProposal(FIRST_PROPOSAL);
    const before = structuredClone(consumer.projection);
    const result = await consumer.tryClaim({ at: new Date("2026-08-02T12:00:00.000Z") });
    assert.equal(result.ok, false);
    assert.equal(consumer.projection.status, before.status);
    assert.equal(consumer.projection.attempt, before.attempt);
    assert.deepEqual(consumer.projection.eventIds, before.eventIds);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("claim/heartbeat/checkpoint symlink escapes are rejected with no outside files", () => {
  const root = mkdtempSync(join(tmpdir(), "repair-symlink-"));
  const outside = mkdtempSync(join(tmpdir(), "repair-outside-"));
  try {
    const ns = FIRST_PROPOSAL.transport.outboxNamespace;
    mkdirSync(join(root, ns, "attempt-1"), { recursive: true });

    // Symlink final target for claim.lock
    const claimOutside = join(outside, "claim.lock");
    writeFileSync(claimOutside, "outside\n");
    symlinkSync(claimOutside, join(root, ns, "attempt-1", "claim.lock"));
    assert.throws(
      () => exclusiveWriteJson(root, `${ns}/attempt-1/claim.lock`, { a: 1 }),
      /symlink|escape/i,
    );

    // Symlink ancestor for heartbeat
    unlinkSync(join(root, ns, "attempt-1", "claim.lock"));
    const realAttempt = join(outside, "attempt-real");
    mkdirSync(realAttempt, { recursive: true });
    rmSync(join(root, ns, "attempt-1"), { recursive: true, force: true });
    symlinkSync(realAttempt, join(root, ns, "attempt-1"));
    assert.throws(
      () => atomicReplaceJson(root, `${ns}/attempt-1/heartbeat.json`, { a: 1 }),
      /symlink|escape/i,
    );

    // Symlink root
    const linkedRoot = join(outside, "linked-root");
    mkdirSync(linkedRoot, { recursive: true });
    const rootLink = join(outside, "root-link");
    symlinkSync(linkedRoot, rootLink);
    assert.throws(
      () => exclusiveWriteJson(rootLink, `${ns}/attempt-1/source-checkpoint.json`, { a: 1 }),
      /symlink|escape/i,
    );

    // Prove nothing landed under the outside bait dirs beyond the fixtures we created.
    const outsideFiles = listFilesRecursive(outside).map((p) => resolve(p));
    assert.ok(outsideFiles.every((p) => p.startsWith(resolve(outside))));
    assert.equal(outsideFiles.includes(resolve(claimOutside)), true);
    assert.ok(!outsideFiles.some((p) => p.endsWith("heartbeat.json")));
    assert.ok(!outsideFiles.some((p) => p.endsWith("source-checkpoint.json")));
    assert.throws(() => resolveWritableOutboxPath(root, `${ns}/attempt-1/heartbeat.json`), /symlink|escape/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("every successful event is auto-mirrored to knowledge", async () => {
  const root = mkdtempSync(join(tmpdir(), "repair-auto-mirror-"));
  try {
    const posts = [];
    const knowledgeClient = {
      async listRepairProposals() { return [FIRST_PROPOSAL]; },
      async postKnowledge(envelope) {
        posts.push(envelope.id);
        return { ok: true, debt: false, id: envelope.id };
      },
    };
    const consumer = createRepairConsumer({ outboxRoot: root, actorId: "win-mirror", knowledgeClient });
    await consumer.discoverAndSelect({ expectedProposalId: FIRST_PROPOSAL.proposalId, expectedProposalSha256: EXPECTED_SHA });
    await consumer.tryClaim({ at: new Date("2026-08-02T12:00:00.000Z") });
    await consumer.heartbeat({ at: new Date("2026-08-02T12:01:00.000Z") });
    await consumer.startFixing({ at: new Date("2026-08-02T12:02:00.000Z") });
    await consumer.sealSourceCheckpoint(checkpointFor(FIRST_PROPOSAL, "win-mirror"), { at: new Date("2026-08-02T12:03:00.000Z") });
    assert.equal(posts.length, 4);
    assert.deepEqual(
      consumer.listEvents().map((e) => e.eventType),
      ["claim", "heartbeat", "start_fixing", "source_checkpoint"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("live CLI refuses fake demo checkpoint without --offline-demo-checkpoint", async () => {
  const root = mkdtempSync(join(tmpdir(), "repair-cli-failclosed-"));
  const fixture = join(root, "proposal.json");
  writeFileSync(fixture, `${JSON.stringify(FIRST_PROPOSAL)}\n`);
  const outbox = join(root, "outbox");
  mkdirSync(outbox, { recursive: true });
  const result = spawnSync(
    process.execPath,
    [
      "scripts/repair-consumer.mjs",
      "claim-cycle",
      "--fixture", fixture,
      "--outbox", outbox,
      "--actor", "win-cli",
    ],
    { cwd: resolve("."), encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.ok, false);
  assert.equal(summary.reason, "SOURCE_CHECKPOINT_REQUIRED");
  assert.equal(summary.status, "fixing");
  assert.ok(!summary.actionsPerformed.includes("source_checkpoint"));
  assert.ok(!summary.actionsPerformed.includes("offline_demo_checkpoint"));
  rmSync(root, { recursive: true, force: true });
});

test("live-knowledge + offline-demo-checkpoint fails closed with zero posts/events", async () => {
  const http = await import("node:http");
  const root = mkdtempSync(join(tmpdir(), "repair-live-demo-forbid-"));
  const fixture = join(root, "proposal.json");
  const outbox = join(root, "outbox");
  writeFileSync(fixture, `${JSON.stringify(FIRST_PROPOSAL)}\n`);
  mkdirSync(outbox, { recursive: true });

  let posts = 0;
  let gets = 0;
  const server = http.createServer((req, res) => {
    if (req.method === "GET") gets += 1;
    if (req.method === "POST") posts += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ knowledge: [] }));
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const { port } = server.address();
  try {
    const { main } = await import("../scripts/repair-consumer.mjs");
    await main([
      "claim-cycle",
      "--fixture", fixture,
      "--outbox", outbox,
      "--actor", "win-live-demo",
      "--live-knowledge",
      "--offline-demo-checkpoint",
      "--endpoint", `http://127.0.0.1:${port}`,
    ]);
    assert.equal(process.exitCode, 2);
    process.exitCode = 0;
    const ns = join(outbox, FIRST_PROPOSAL.transport.outboxNamespace);
    assert.equal(existsSync(join(ns, "events")), false);
    assert.equal(posts, 0);
    assert.equal(gets, 0);
    const files = existsSync(outbox) ? readdirSync(outbox) : [];
    assert.ok(!files.some((name) => name.includes("source-checkpoint")));
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    rmSync(root, { recursive: true, force: true });
  }
});

test("same now claim→heartbeat→start_fixing survives restart reduce as fixing", async () => {
  const root = mkdtempSync(join(tmpdir(), "repair-same-now-"));
  try {
    const frozen = new Date("2026-08-02T12:00:00.000Z");
    const first = createRepairConsumer({
      outboxRoot: root,
      actorId: "win-same-now",
      now: () => frozen,
    });
    await first.loadProposal(FIRST_PROPOSAL);
    assert.equal((await first.tryClaim({ at: frozen })).ok, true);
    await first.heartbeat({ at: frozen });
    await first.startFixing({ at: frozen });
    assert.equal(first.projection.status, "fixing");
    const events = first.listEvents();
    assert.equal(events.length, 3);
    assert.ok(Date.parse(events[0].occurredAt) < Date.parse(events[1].occurredAt));
    assert.ok(Date.parse(events[1].occurredAt) < Date.parse(events[2].occurredAt));
    assert.ok(events.every((e) => e.occurredAt.includes(".00"))); // ms present, not truncated away incorrectly
    // Explicitly ensure not all truncated to identical whole-second stamps.
    assert.equal(new Set(events.map((e) => e.occurredAt)).size, 3);
    const lockPath = join(root, FIRST_PROPOSAL.transport.outboxNamespace, "attempt-1", "claim.lock");
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    assert.equal(lock.claimedAt, events[0].occurredAt);

    const restarted = createRepairConsumer({ outboxRoot: root, actorId: "win-same-now" });
    await restarted.loadProposal(FIRST_PROPOSAL);
    assert.equal(restarted.projection.status, "fixing");
    assert.equal(restarted.projection.attempt, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("crash before mirror keeps durable claim and restarts retry mirror", async () => {
  const root = mkdtempSync(join(tmpdir(), "repair-crash-mirror-"));
  try {
    let crash = true;
    const posts = [];
    const knowledgeClient = {
      async listRepairProposals() { return [FIRST_PROPOSAL]; },
      async postKnowledge(envelope) {
        posts.push(envelope.id);
        return { ok: true, debt: false, id: envelope.id };
      },
      async getKnowledge() { return { ok: false, status: 404 }; },
    };
    const first = createRepairConsumer({
      outboxRoot: root,
      actorId: "win-crash-mirror",
      knowledgeClient,
      afterEventPersist: async () => {
        if (crash) throw new Error("simulated crash before mirror");
      },
    });
    await first.loadProposal(FIRST_PROPOSAL);
    const claim = await first.tryClaim({ at: new Date("2026-08-02T12:00:00.000Z") });
    assert.equal(claim.ok, true);
    assert.equal(first.projection.status, "claimed");
    assert.equal(posts.length, 0);
    assert.equal(first.listEvents().length, 1);

    crash = false;
    const restarted = createRepairConsumer({
      outboxRoot: root,
      actorId: "win-crash-mirror",
      knowledgeClient,
    });
    await restarted.loadProposal(FIRST_PROPOSAL);
    assert.equal(restarted.projection.status, "claimed");
    assert.equal(posts.length, 1);
    assert.equal(readdirSync(join(root, FIRST_PROPOSAL.transport.outboxNamespace, "knowledge-mirrors")).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("knowledge mirror failure persists debt and thrown postKnowledge becomes debt", async () => {
  const root = mkdtempSync(join(tmpdir(), "repair-debt-persist-"));
  try {
    let mode = "fail";
    const knowledgeClient = {
      async listRepairProposals() { return [FIRST_PROPOSAL]; },
      async postKnowledge(envelope) {
        if (mode === "fail") return { ok: false, debt: true, status: 500, code: "DOWN" };
        if (mode === "throw") throw new Error("boom");
        return { ok: true, debt: false, id: envelope.id };
      },
    };
    const consumer = createRepairConsumer({ outboxRoot: root, actorId: "win-debt-persist", knowledgeClient });
    await consumer.discoverAndSelect({ expectedProposalId: FIRST_PROPOSAL.proposalId, expectedProposalSha256: EXPECTED_SHA });
    const claim = await consumer.tryClaim({ at: new Date("2026-08-02T12:00:00.000Z") });
    assert.equal(claim.ok, true);
    assert.equal(consumer.projection.status, "claimed");
    assert.equal(consumer.evidenceDebt[0].code, "KNOWLEDGE_MIRROR_FAILED");
    const debtDir = join(root, FIRST_PROPOSAL.transport.outboxNamespace, "evidence-debt");
    assert.equal(readdirSync(debtDir).length, 1);

    const restarted = createRepairConsumer({ outboxRoot: root, actorId: "win-debt-persist", knowledgeClient });
    mode = "throw";
    await restarted.loadProposal(FIRST_PROPOSAL);
    assert.ok(restarted.evidenceDebt.length >= 1);
    assert.equal(restarted.projection.status, "claimed");

    mode = "ok";
    await restarted.retryPendingMirrors();
    assert.equal(restarted.evidenceDebt.length, 0);
    assert.equal(readdirSync(join(root, FIRST_PROPOSAL.transport.outboxNamespace, "knowledge-mirrors")).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scope guard exact allowlist rejects repair-extra and invalid baseline", async () => {
  const {
    REPAIR_CONSUMER_ALLOWED_PATHS,
    evaluateScopeGuard,
    collectTouchedFiles,
  } = await import("../scripts/repair-consumer-scope-guard.mjs");
  assert.equal(REPAIR_CONSUMER_ALLOWED_PATHS.size, 22);
  assert.equal(REPAIR_CONSUMER_ALLOWED_PATHS instanceof Set, true);
  const authorized = [...REPAIR_CONSUMER_ALLOWED_PATHS];
  assert.equal(evaluateScopeGuard(authorized).ok, true);
  assert.equal(
    evaluateScopeGuard([...authorized, "contracts/repair-extra.v1.schema.json"]).ok,
    false,
  );
  assert.deepEqual(
    evaluateScopeGuard([...authorized, "contracts/repair-extra.v1.schema.json"]).unauthorized,
    ["contracts/repair-extra.v1.schema.json"],
  );

  assert.throws(
    () => collectTouchedFiles("definitely-not-a-valid-git-ref-zzzz"),
    /failed|unknown|invalid|Needed a single revision/i,
  );

  const live = spawnSync(process.execPath, [
    resolve("scripts/repair-consumer-scope-guard.mjs"),
    "5677e61e3363d2afc415e9add5f89f873fc7a32d",
  ], { cwd: resolve("."), encoding: "utf8" });
  assert.equal(live.status, 0, live.stdout + live.stderr);
  assert.equal(JSON.parse(live.stdout).ok, true);

  const badBase = spawnSync(process.execPath, [
    resolve("scripts/repair-consumer-scope-guard.mjs"),
    "not-a-real-baseline-ref",
  ], { cwd: resolve("."), encoding: "utf8" });
  assert.notEqual(badBase.status, 0);
  const body = JSON.parse(badBase.stdout);
  assert.equal(body.ok, false);
  assert.ok(body.error);
});
