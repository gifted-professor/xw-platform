import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { createRepairAuthorityVerifiers } from "../scripts/lib/repair-authority-verifiers.mjs";

import {
  applyRepairEvent,
  createRepairEvent,
  createRepairProposal,
  initialRepairProjection,
  isAllowedRepairPath,
  proposalKnowledgeEnvelope,
  proposalSha256,
  repairIdempotencyKey,
  scanForSecrets,
  validateCompletionBundle,
  validateRepairProposal,
  validateSourceCheckpoint,
} from "../scripts/lib/repair-proposal.mjs";

function proposalInput(overrides = {}) {
  return {
    source: {
      bundleId: "bundle-feed",
      manifestSha256: "a".repeat(64),
      primaryRunId: "run_feed_primary",
      runIds: ["run_feed_primary", "run_feed_replay"],
      producerCommit: "b".repeat(40),
      releaseId: "rel-shadow",
      review: {
        reviewId: "review_feed",
        receiptSha256: "c".repeat(64),
        reviewedAt: "2026-08-02T08:22:59.000Z",
        disposition: "repairable_debt",
      },
    },
    target: {
      repository: "gifted-professor/xhs-device-agent",
      branch: "main",
      baseCommit: "b".repeat(40),
      app: "xhs",
      capabilityId: "xhs.observe.feed",
      skillBinding: {
        path: "skills/xhs/xhs-observe-feed/SKILL.md",
        version: "0.1",
        sourceSha256: "d".repeat(64),
      },
    },
    finding: {
      findingId: "finding_feed_evidence",
      code: "XHS_OBSERVE_FEED_EVIDENCE_INCOMPLETE",
      severity: "low",
      summary: "feed result lacks screenshot, UI dump and redacted projection",
      repairable: true,
      evidenceRefs: ["manifest:" + "a".repeat(64), "run:run_feed_primary"],
      observed: { outputWasEmpty: true, missing: ["screenshot", "ui_dump", "pageClass", "cardCount", "artifactRefs"] },
      evidenceDebt: [{ layer: "adapter-evidence", code: "MISSING_SCREENSHOT", cause: "business result unchanged" }],
    },
    policy: {
      allowedChangeKinds: ["evidence_exporter", "screenshot_or_ui_dump_artifact", "redacted_observation_projection", "test_fixture"],
      allowedPaths: [
        "apps/xhs/adapter.mjs",
        "control-plane/lib/evidence-exporter.mjs",
        "tests/control-plane-adapters.test.mjs",
        "tests/fixtures/**",
      ],
      acceptanceConditions: [
        "read-only business semantics stay unchanged",
        "evidence failure is debt-only",
      ],
      prohibitions: [
        "no payment, approval, deployment, device action or root skills change",
      ],
      limits: { maxFiles: 4, maxDiffLines: 120, maxAttempts: 3 },
      heartbeat: { intervalSeconds: 60, claimTtlSeconds: 900 },
      circuitBreaker: { failureThreshold: 2, windowSeconds: 3600 },
    },
    createdAt: "2026-08-02T09:00:00.000Z",
    ...overrides,
  };
}

function makeProposal(overrides = {}) {
  return createRepairProposal(proposalInput(overrides));
}

function event(proposal, projection, eventType, role, id, occurredAt, payload = {}) {
  return createRepairEvent(proposal, projection, {
    eventType,
    actor: { role, id },
    occurredAt,
    payload,
  });
}

const trustedMac = { verifyMacReviewAuthority: () => true };
const trustedClaim = { verifyClaimLock: () => true };
const trustedReplay = { verifyReplayAuthorization: () => true };
const trustedCompletion = { verifyCompletionBundle: () => true };

function claimPayload(proposal, attempt, expiresAt) {
  return {
    expiresAt,
    lockRef: `${proposal.transport.outboxNamespace}/attempt-${attempt}/claim.lock`,
    lockSha256: "7".repeat(64),
  };
}

function macAuthority(checkpointSha256 = "e".repeat(64)) {
  return {
    macCommit: "8".repeat(40),
    reviewReceiptPath: "docs/handoffs/repair-reviews/feed-review.json",
    reviewReceiptSha256: "f".repeat(64),
    reviewedCheckpointSha256: checkpointSha256,
  };
}

test("proposal idempotency binds bundle, runs, producer, review, finding and target", () => {
  const first = makeProposal();
  const second = makeProposal({ createdAt: "2026-08-02T10:00:00.000Z" });
  assert.equal(first.idempotencyKey, repairIdempotencyKey(first));
  assert.equal(first.proposalId, second.proposalId);
  assert.equal(first.idempotencyKey, second.idempotencyKey);
  assert.equal(validateRepairProposal(first).ok, true);
  assert.match(proposalSha256(first), /^[0-9a-f]{64}$/);

  const changedFinding = makeProposal({
    finding: { ...proposalInput().finding, findingId: "finding_other" },
  });
  assert.notEqual(changedFinding.proposalId, first.proposalId);
  for (const changed of [
    { source: { ...proposalInput().source, review: { ...proposalInput().source.review, receiptSha256: "1".repeat(64) } } },
    { target: { ...proposalInput().target, baseCommit: "1".repeat(40) } },
    { target: { ...proposalInput().target, skillBinding: { ...proposalInput().target.skillBinding, sourceSha256: "1".repeat(64) } } },
    { policy: { ...proposalInput().policy, limits: { ...proposalInput().policy.limits, maxDiffLines: 121 } } },
  ]) assert.notEqual(makeProposal(changed).proposalId, first.proposalId);
});

test("runtime validators reject omitted required fields and unknown contract fields", () => {
  const proposal = makeProposal();
  for (const mutate of [
    (item) => delete item.source.releaseId,
    (item) => delete item.source.review.disposition,
    (item) => delete item.policy.authorities,
    (item) => { item.source.releaseId = 7; },
    (item) => { item.policy.allowedPaths.push(item.policy.allowedPaths[0]); },
    (item) => { item.policy.heartbeat = { intervalSeconds: 1, claimTtlSeconds: 2 }; },
    (item) => { item.policy.circuitBreaker.windowSeconds = 1; },
    (item) => { item.finding.evidenceDebt = ["not-an-object"]; },
    (item) => { item.unexpected = true; },
  ]) {
    const invalid = structuredClone(proposal);
    mutate(invalid);
    assert.equal(validateRepairProposal(invalid).ok, false);
  }
  const checkpoint = validCheckpoint(proposal);
  checkpoint.unexpected = true;
  assert.equal(validateSourceCheckpoint(proposal, checkpoint).ok, false);

  const forgedId = structuredClone(proposal);
  forgedId.proposalId = `repair_${"0".repeat(24)}`;
  forgedId.transport.knowledgeId = forgedId.proposalId;
  forgedId.transport.outboxNamespace = `repair/${forgedId.proposalId}`;
  assert.match(validateRepairProposal(forgedId).errors.join(" "), /derive from idempotencyKey/);
});

test("registry knowledge envelope carries canonical immutable proposal without adding a service", () => {
  const proposal = makeProposal();
  const envelope = proposalKnowledgeEnvelope(proposal);
  assert.equal(envelope.id, proposal.proposalId);
  assert.equal(envelope.category, "unknown");
  assert.equal(envelope.lifecycle, "backlog");
  assert.deepEqual(JSON.parse(envelope.content), proposal);
  assert.ok(envelope.appliesTo.includes(proposal.idempotencyKey));
  assert.match(proposal.transport.outboxNamespace, /^repair\/repair_/);
});

test("scope guard enforces allowlist, forbidden paths, traversal, file and diff limits", () => {
  const proposal = makeProposal();
  assert.equal(isAllowedRepairPath("apps/xhs/adapter.mjs", proposal.policy), true);
  assert.equal(isAllowedRepairPath("tests/fixtures/feed/result.json", proposal.policy), true);
  assert.equal(isAllowedRepairPath("skills/SKILL.md", proposal.policy), false);
  assert.equal(isAllowedRepairPath("control-plane/lib/payment-guard.mjs", proposal.policy), false);
  assert.equal(isAllowedRepairPath("../registry.mjs", proposal.policy), false);

  const checkpoint = validCheckpoint(proposal);
  assert.equal(validateSourceCheckpoint(proposal, checkpoint).ok, true);
  const forbidden = structuredClone(checkpoint);
  forbidden.files[0].path = "skills/SKILL.md";
  assert.match(validateSourceCheckpoint(proposal, forbidden).errors.join(" "), /outside proposal scope/);
  const oversized = structuredClone(checkpoint);
  oversized.files[0].addedLines = 121;
  oversized.diff.totalLines = 121;
  assert.match(validateSourceCheckpoint(proposal, oversized).errors.join(" "), /exceeds limit/);
});

test("secret scan rejects credentials in proposal events and source checkpoints", () => {
  assert.deepEqual(scanForSecrets({ note: "scope mentions token paths but contains no credential" }), []);
  assert.deepEqual(scanForSecrets({ authorization: "redacted" }), ["authorization"]);
  assert.deepEqual(scanForSecrets({ accessToken: "redacted", refresh_token: "redacted", cookie: "redacted" }), ["accessToken", "refresh_token", "cookie"]);
  assert.deepEqual(scanForSecrets({ oauthToken: "redacted", aws_secret_access_key: "redacted", sessionCookie: "redacted" }), ["oauthToken", "aws_secret_access_key", "sessionCookie"]);
  assert.deepEqual(scanForSecrets({ authorizationRef: "receipt:path", authorizationSha256: "1".repeat(64) }), []);
  const proposal = makeProposal();
  const checkpoint = validCheckpoint(proposal);
  checkpoint.tests[0].authorization = "redacted";
  const result = validateSourceCheckpoint(proposal, checkpoint);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /secret material/);
});

test("state machine enforces Windows claim/fix and independent Mac review through completion", () => {
  const proposal = makeProposal();
  let projection = initialRepairProjection(proposal);
  const claim = event(proposal, projection, "claim", "windows_consumer", "win-fixer", "2026-08-02T09:01:00.000Z", claimPayload(proposal, 1, "2026-08-02T09:16:00.000Z"));
  assert.throws(() => applyRepairEvent(proposal, projection, claim), /claim lock is not trusted/);
  projection = applyRepairEvent(proposal, projection, claim, trustedClaim);
  assert.deepEqual(applyRepairEvent(proposal, projection, claim), projection, "same immutable event is idempotent after state advances");
  const collided = structuredClone(claim);
  collided.payload.expiresAt = "2026-08-02T09:15:00.000Z";
  assert.throws(() => applyRepairEvent(proposal, projection, collided), /eventId collision/);
  assert.equal(projection.status, "claimed");
  assert.equal(projection.attempt, 1);
  projection = applyRepairEvent(proposal, projection, event(proposal, projection, "heartbeat", "windows_consumer", "win-fixer", "2026-08-02T09:02:00.000Z", { expiresAt: "2026-08-02T09:17:00.000Z", lockSha256: "7".repeat(64) }));
  projection = applyRepairEvent(proposal, projection, event(proposal, projection, "start_fixing", "windows_consumer", "win-fixer", "2026-08-02T09:03:00.000Z"));
  projection = applyRepairEvent(proposal, projection, event(proposal, projection, "source_checkpoint", "windows_consumer", "win-fixer", "2026-08-02T09:04:00.000Z", { bundleSha256: "e".repeat(64), outboxRef: `${proposal.transport.outboxNamespace}/attempt-1/source-checkpoint.json` }));
  assert.equal(projection.status, "source_review");

  const selfApproval = event(proposal, projection, "review_approved", "windows_consumer", "win-fixer", "2026-08-02T09:05:00.000Z");
  assert.throws(() => applyRepairEvent(proposal, projection, selfApproval), /requires mac_governance or human/);

  const approval = event(proposal, projection, "review_approved", "mac_governance", "mac-reviewer", "2026-08-02T09:06:00.000Z", { reviewReceiptSha256: "f".repeat(64), authority: macAuthority() });
  assert.throws(() => applyRepairEvent(proposal, projection, approval), /not trusted/);
  projection = applyRepairEvent(proposal, projection, approval, trustedMac);
  assert.equal(projection.status, "approved");
  projection = applyRepairEvent(proposal, projection, event(proposal, projection, "mark_deployable", "mac_governance", "mac-reviewer", "2026-08-02T09:07:00.000Z", {
    approvedEventId: projection.lastReviewEvent,
    sourceCheckpointSha256: "e".repeat(64),
    resultCommit: "9".repeat(40),
    authority: macAuthority(),
  }), trustedMac);
  assert.equal(projection.status, "deployable");

  const noAuthority = event(proposal, projection, "start_replay", "windows_consumer", "win-fixer", "2026-08-02T09:08:00.000Z");
  assert.throws(() => applyRepairEvent(proposal, projection, noAuthority), /authorizationRef required/);
  const replay = event(proposal, projection, "start_replay", "windows_consumer", "win-fixer", "2026-08-02T09:08:00.000Z", { authorizationRef: "docs/handoffs/repair-authorizations/replay.json", authorizationSha256: "2".repeat(64), authorizationCommit: "3".repeat(40) });
  assert.throws(() => applyRepairEvent(proposal, projection, replay), /not trusted/);
  projection = applyRepairEvent(proposal, projection, replay, trustedReplay);
  const completion = event(proposal, projection, "complete", "windows_consumer", "win-fixer", "2026-08-02T09:09:00.000Z", { bundleRef: "repair/completion.json", bundleSha256: "1".repeat(64) });
  assert.throws(() => applyRepairEvent(proposal, projection, completion), /not trusted/);
  projection = applyRepairEvent(proposal, projection, completion, trustedCompletion);
  assert.equal(projection.status, "completed");
});

test("request_changes returns the same claimant to fixing without self-approval", () => {
  const proposal = makeProposal();
  let projection = initialRepairProjection(proposal);
  projection = applyRepairEvent(proposal, projection, event(proposal, projection, "claim", "windows_consumer", "win-fixer", "2026-08-02T09:01:00.000Z", claimPayload(proposal, 1, "2026-08-02T09:16:00.000Z")), trustedClaim);
  projection = applyRepairEvent(proposal, projection, event(proposal, projection, "start_fixing", "windows_consumer", "win-fixer", "2026-08-02T09:02:00.000Z"));
  projection = applyRepairEvent(proposal, projection, event(proposal, projection, "source_checkpoint", "windows_consumer", "win-fixer", "2026-08-02T09:03:00.000Z", { bundleSha256: "e".repeat(64), outboxRef: `${proposal.transport.outboxNamespace}/attempt-1/source-checkpoint.json` }));
  projection = applyRepairEvent(proposal, projection, event(proposal, projection, "review_request_changes", "mac_governance", "mac-reviewer", "2026-08-02T09:04:00.000Z", { reviewReceiptSha256: "f".repeat(64), expiresAt: "2026-08-02T09:19:00.000Z", findings: ["artifact hash missing"], authority: macAuthority() }), trustedMac);
  assert.equal(projection.status, "request_changes");
  projection = applyRepairEvent(proposal, projection, event(proposal, projection, "start_fixing", "windows_consumer", "win-fixer", "2026-08-02T09:05:00.000Z"));
  assert.equal(projection.status, "fixing");
  assert.equal(projection.attempt, 1);
});

test("attempt, heartbeat expiry and circuit breaker stop repeated repair failures", () => {
  const proposal = makeProposal();
  let projection = initialRepairProjection(proposal);
  projection = applyRepairEvent(proposal, projection, event(proposal, projection, "claim", "windows_consumer", "win-fixer", "2026-08-02T09:01:00.000Z", claimPayload(proposal, 1, "2026-08-02T09:02:00.000Z")), trustedClaim);
  projection = applyRepairEvent(proposal, projection, event(proposal, projection, "claim_expired", "windows_consumer", "repair-consumer", "2026-08-02T09:03:00.000Z"));
  assert.equal(projection.status, "proposed");
  assert.equal(projection.circuitBreaker.consecutiveFailures, 1);
  projection = applyRepairEvent(proposal, projection, event(proposal, projection, "claim", "windows_consumer", "win-fixer", "2026-08-02T09:04:00.000Z", claimPayload(proposal, 2, "2026-08-02T09:05:00.000Z")), trustedClaim);
  projection = applyRepairEvent(proposal, projection, event(proposal, projection, "attempt_failed", "windows_consumer", "win-fixer", "2026-08-02T09:04:30.000Z", { reason: "same fixture failed" }));
  assert.equal(projection.status, "failed");
  assert.equal(projection.circuitBreaker.state, "open");
});

test("supersession creates a new proposal and cancels the old one by append-only Mac event", () => {
  const oldProposal = makeProposal();
  const newProposal = makeProposal({
    finding: { ...proposalInput().finding, findingId: "finding_feed_evidence_v2" },
    supersession: { supersedes: [oldProposal.proposalId] },
  });
  assert.notEqual(newProposal.proposalId, oldProposal.proposalId);
  assert.deepEqual(newProposal.supersession.supersedes, [oldProposal.proposalId]);
  let projection = initialRepairProjection(oldProposal);
  projection = applyRepairEvent(oldProposal, projection, event(oldProposal, projection, "cancel", "mac_governance", "mac-reviewer", "2026-08-02T09:01:00.000Z", {
    reason: "superseded",
    supersededBy: newProposal.proposalId,
    authority: macAuthority(null),
  }), trustedMac);
  assert.equal(projection.status, "cancelled");
});

test("completion bundle requires Mac approval refs and separately authorized effect-free replay", () => {
  const proposal = makeProposal();
  const completion = {
    schemaId: "xhs.repair-completion.v1",
    schemaVersion: 1,
    completionId: "repair_completion_" + "1".repeat(24),
    proposalId: proposal.proposalId,
    proposalSha256: proposalSha256(proposal),
    attempt: 1,
    completedAt: "2026-08-02T11:00:00.000Z",
    sourceCheckpointSha256: "2".repeat(64),
    resultCommit: "3".repeat(40),
    macReview: { approvedEventId: "repair_event_" + "a".repeat(24), deployableEventId: "repair_event_" + "b".repeat(24) },
    replay: {
      authorizationRef: "docs/handoffs/repair-authorizations/replay.json",
      authorizationSha256: "5".repeat(64),
      authorizationCommit: "6".repeat(40),
      runId: "run_repair_replay",
      manifestSha256: "4".repeat(64),
      externalEffect: false,
      paymentTransport: 0,
    },
    evidenceDebt: [],
    evidenceDebtAffectsBusinessResult: false,
    authority: { actorId: "win-fixer", actorRole: "windows_consumer", reviewVerdictModified: false, macWritePerformed: false },
  };
  assert.equal(validateCompletionBundle(proposal, completion).ok, true);
  completion.replay.paymentTransport = 1;
  assert.match(validateCompletionBundle(proposal, completion).errors.join(" "), /effect-free/);
});

test("committed first trial proposal binds the reviewed feed bundle and current Skill hash", () => {
  const proposal = JSON.parse(readFileSync(new URL("../docs/handoffs/2026-08-02-xhs-observe-feed-repair-proposal.v1.json", import.meta.url), "utf8"));
  assert.equal(validateRepairProposal(proposal).ok, true);
  assert.equal(proposal.proposalId, "repair_ff7fc51b35aec35227cf5eb6");
  assert.equal(proposal.source.manifestSha256, "14ab37290468fd6dd82ed11dd615d5dea9494b6fabea8c4166f8a814ff3fae7d");
  assert.equal(proposal.target.skillBinding.version, "0.1");
  assert.equal(proposal.target.skillBinding.sourceSha256, "2baba76b8c9c877c1f63e2a824096c2065f90031db119238a6e33bf864e9720d");
  assert.equal(proposal.finding.observed.externalEffect, false);
  assert.equal(proposal.finding.observed.paymentTransport, 0);
});

test("all repair contract schemas are valid JSON with distinct v1 ids", () => {
  const files = [
    "repair-proposal.v1.schema.json",
    "repair-event.v1.schema.json",
    "repair-source-checkpoint.v1.schema.json",
    "repair-completion.v1.schema.json",
    "repair-review-authority.v1.schema.json",
    "repair-replay-authorization.v1.schema.json",
  ];
  const ids = files.map((file) => JSON.parse(readFileSync(new URL(`../contracts/${file}`, import.meta.url), "utf8")).$id);
  assert.equal(new Set(ids).size, files.length);
  assert.ok(ids.every((id) => id.endsWith(":v1")));
});

test("filesystem and Git verifiers enforce real lock, Mac receipt, replay authorization and completion bindings", () => {
  const root = mkdtempSync(join(tmpdir(), "repair-authority-"));
  try {
    const macRepo = join(root, "mac");
    const outboxRoot = join(root, "outbox");
    const completionRoot = join(root, "completion");
    for (const dir of [macRepo, outboxRoot, completionRoot]) mkdirSync(dir, { recursive: true });
    const git = (...args) => {
      const result = spawnSync("git", args, { cwd: macRepo, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git("init", "-q");
    git("config", "user.name", "Repair Reviewer");
    git("config", "user.email", "repair-review@example.invalid");
    const humanKeys = generateKeyPairSync("ed25519");
    const publicKeyPem = humanKeys.publicKey.export({ type: "spki", format: "pem" });

    const proposal = makeProposal();
    let projection = initialRepairProjection(proposal);
    const claimAt = "2026-08-02T09:01:00.000Z";
    const expiresAt = "2026-08-02T09:16:00.000Z";
    const lockRef = `${proposal.transport.outboxNamespace}/attempt-1/claim.lock`;
    const lock = {
      schemaId: "xhs.repair-claim-lock.v1",
      schemaVersion: 1,
      proposalId: proposal.proposalId,
      proposalSha256: projection.proposalSha256,
      attempt: 1,
      actorId: "win-fixer",
      claimedAt: claimAt,
      expiresAt,
    };
    const lockBytes = Buffer.from(`${JSON.stringify(lock)}\n`);
    writeArtifact(outboxRoot, lockRef, lockBytes);
    const claim = event(proposal, projection, "claim", "windows_consumer", "win-fixer", claimAt, { expiresAt, lockRef, lockSha256: digest(lockBytes) });
    const verifiers = createRepairAuthorityVerifiers({
      macRepoRoot: macRepo,
      outboxRoot,
      completionRoot,
      replayAuthorizationPublicKeys: { "human-deploy-1": publicKeyPem },
    });
    const attemptRoot = join(outboxRoot, proposal.transport.outboxNamespace);
    const attemptDir = join(attemptRoot, "attempt-1");
    const realAttemptDir = join(attemptRoot, "attempt-real");
    renameSync(attemptDir, realAttemptDir);
    symlinkSync(realAttemptDir, attemptDir);
    assert.equal(verifiers.verifyClaimLock({ proposal, projection, event: claim, lock: claim.payload }), false);
    // Windows: symlink-to-dir must be unlinked; rmSync without recursive throws EISDIR.
    unlinkSync(attemptDir);
    renameSync(realAttemptDir, attemptDir);
    projection = applyRepairEvent(proposal, projection, claim, verifiers);
    const lockPath = join(outboxRoot, lockRef);
    const outsideLock = join(root, "outside-claim.lock");
    writeFileSync(outsideLock, lockBytes);
    rmSync(lockPath);
    symlinkSync(outsideLock, lockPath);
    assert.equal(verifiers.verifyClaimLock({ proposal, projection: initialRepairProjection(proposal), event: claim, lock: claim.payload }), false);
    projection = applyRepairEvent(proposal, projection, event(proposal, projection, "start_fixing", "windows_consumer", "win-fixer", "2026-08-02T09:02:00.000Z"));
    projection = applyRepairEvent(proposal, projection, event(proposal, projection, "source_checkpoint", "windows_consumer", "win-fixer", "2026-08-02T09:03:00.000Z", { bundleSha256: "e".repeat(64), outboxRef: `${proposal.transport.outboxNamespace}/attempt-1/source-checkpoint.json` }));

    const approvalAt = "2026-08-02T09:04:00.000Z";
    const approvalReceipt = repairReviewReceipt(proposal, projection, "approved", approvalAt, null);
    const approvalPath = "docs/handoffs/repair-reviews/approval.json";
    writeArtifact(macRepo, approvalPath, Buffer.from(`${JSON.stringify(approvalReceipt)}\n`));
    git("add", approvalPath);
    git("commit", "-qm", "approval receipt");
    let macCommit = git("rev-parse", "HEAD");
    git("update-ref", "refs/remotes/origin/main", macCommit);
    let authority = { macCommit, reviewReceiptPath: approvalPath, reviewReceiptSha256: digest(readFileSync(join(macRepo, approvalPath))), reviewedCheckpointSha256: "e".repeat(64) };
    const approval = event(proposal, projection, "review_approved", "mac_governance", "mac-reviewer", approvalAt, { reviewReceiptSha256: authority.reviewReceiptSha256, authority });
    projection = applyRepairEvent(proposal, projection, approval, verifiers);

    const deployAt = "2026-08-02T09:05:00.000Z";
    const resultCommit = "9".repeat(40);
    const deployReceipt = repairReviewReceipt(proposal, projection, "deployable", deployAt, resultCommit);
    const deployPath = "docs/handoffs/repair-reviews/deployable.json";
    writeArtifact(macRepo, deployPath, Buffer.from(`${JSON.stringify(deployReceipt)}\n`));
    git("add", deployPath);
    git("commit", "-qm", "deployable receipt");
    macCommit = git("rev-parse", "HEAD");
    git("update-ref", "refs/remotes/origin/main", macCommit);
    authority = { macCommit, reviewReceiptPath: deployPath, reviewReceiptSha256: digest(readFileSync(join(macRepo, deployPath))), reviewedCheckpointSha256: "e".repeat(64) };
    const deploy = event(proposal, projection, "mark_deployable", "mac_governance", "mac-reviewer", deployAt, { approvedEventId: projection.approvedEventId, sourceCheckpointSha256: "e".repeat(64), resultCommit, authority });
    projection = applyRepairEvent(proposal, projection, deploy, verifiers);

    const authorizationRef = "docs/handoffs/repair-authorizations/replay.json";
    const unsignedAuthorization = {
      schemaId: "xhs.repair-replay-authorization.v1", schemaVersion: 1,
      proposalId: proposal.proposalId, proposalSha256: projection.proposalSha256,
      deployableEventId: projection.deployableEventId, resultCommit,
      scope: "windows_deploy_and_read_only_replay", authorizedAt: "2026-08-02T09:05:30.000Z", expiresAt: "2026-08-02T10:00:00.000Z",
      issuer: { subject: "human-reviewer", role: "human", keyId: "human-deploy-1" }, externalEffect: false, paymentTransport: 0,
    };
    const authorization = { ...unsignedAuthorization, signature: sign(null, Buffer.from(testCanonicalJson(unsignedAuthorization)), humanKeys.privateKey).toString("base64") };
    const authorizationBytes = Buffer.from(`${JSON.stringify(authorization)}\n`);
    writeArtifact(macRepo, authorizationRef, authorizationBytes);
    git("add", authorizationRef);
    git("commit", "-qm", "replay authorization");
    const authorizationCommit = git("rev-parse", "HEAD");
    git("update-ref", "refs/remotes/origin/main", authorizationCommit);
    const replay = event(proposal, projection, "start_replay", "windows_consumer", "win-fixer", "2026-08-02T09:06:00.000Z", { authorizationRef, authorizationSha256: digest(authorizationBytes), authorizationCommit });
    const noHumanTrust = createRepairAuthorityVerifiers({ macRepoRoot: macRepo, outboxRoot, completionRoot });
    assert.equal(noHumanTrust.verifyReplayAuthorization({ proposal, projection, event: replay, authorization: replay.payload }), false);
    const rsaKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const wrongKeyType = createRepairAuthorityVerifiers({
      macRepoRoot: macRepo, outboxRoot, completionRoot,
      replayAuthorizationPublicKeys: { "human-deploy-1": rsaKeys.publicKey.export({ type: "spki", format: "pem" }) },
    });
    assert.equal(wrongKeyType.verifyReplayAuthorization({ proposal, projection, event: replay, authorization: replay.payload }), false);

    const malformedRef = "docs/handoffs/repair-authorizations/malformed.json";
    const malformedBytes = Buffer.from(`${JSON.stringify({ ...unsignedAuthorization, signature: "not-base64" })}\n`);
    writeArtifact(macRepo, malformedRef, malformedBytes);
    git("add", malformedRef);
    git("commit", "-qm", "malformed replay authorization fixture");
    const malformedCommit = git("rev-parse", "HEAD");
    git("update-ref", "refs/remotes/origin/main", malformedCommit);
    const malformedPayload = { authorizationRef: malformedRef, authorizationSha256: digest(malformedBytes), authorizationCommit: malformedCommit };
    assert.equal(verifiers.verifyReplayAuthorization({ proposal, projection, event: replay, authorization: malformedPayload }), false);
    projection = applyRepairEvent(proposal, projection, replay, verifiers);

    const completionRef = "repair/completion.json";
    const completion = validCompletion(proposal, projection, resultCommit);
    const completionBytes = Buffer.from(`${JSON.stringify(completion)}\n`);
    writeArtifact(completionRoot, completionRef, completionBytes);
    const complete = event(proposal, projection, "complete", "windows_consumer", "win-fixer", "2026-08-02T09:08:00.000Z", { bundleRef: completionRef, bundleSha256: digest(completionBytes) });
    projection = applyRepairEvent(proposal, projection, complete, verifiers);
    assert.equal(projection.status, "completed");

    const forgedAuthorization = { ...replay.payload, authorizationSha256: "0".repeat(64) };
    assert.equal(verifiers.verifyReplayAuthorization({ proposal, projection: { ...projection, status: "deployable" }, event: replay, authorization: forgedAuthorization }), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function testCanonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(testCanonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${testCanonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function writeArtifact(root, ref, bytes) {
  const target = join(root, ref);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, bytes);
}

function repairReviewReceipt(proposal, projection, verdict, reviewedAt, resultCommit) {
  return {
    schemaId: "xhs.repair-review-authority.v1",
    schemaVersion: 1,
    proposalId: proposal.proposalId,
    proposalSha256: projection.proposalSha256,
    sourceCheckpointSha256: projection.lastSourceCheckpoint?.bundleSha256 ?? null,
    verdict,
    resultCommit,
    reviewedAt,
    reviewerId: "mac-reviewer",
  };
}

function validCompletion(proposal, projection, resultCommit) {
  return {
    schemaId: "xhs.repair-completion.v1",
    schemaVersion: 1,
    completionId: `repair_completion_${"1".repeat(24)}`,
    proposalId: proposal.proposalId,
    proposalSha256: proposalSha256(proposal),
    attempt: projection.attempt,
    completedAt: "2026-08-02T09:07:00.000Z",
    sourceCheckpointSha256: projection.lastSourceCheckpoint.bundleSha256,
    resultCommit,
    macReview: { approvedEventId: projection.approvedEventId, deployableEventId: projection.deployableEventId },
    replay: {
      authorizationRef: projection.replayAuthorizationRef,
      authorizationSha256: projection.replayAuthorizationSha256,
      authorizationCommit: projection.replayAuthorizationCommit,
      runId: "run_repair_replay",
      manifestSha256: "4".repeat(64),
      externalEffect: false,
      paymentTransport: 0,
    },
    evidenceDebt: [],
    evidenceDebtAffectsBusinessResult: false,
    authority: { actorId: "win-fixer", actorRole: "windows_consumer", reviewVerdictModified: false, macWritePerformed: false },
  };
}

function validCheckpoint(proposal) {
  return {
    schemaId: "xhs.repair-source-checkpoint.v1",
    schemaVersion: 1,
    checkpointId: "repair_checkpoint_" + "1".repeat(24),
    proposalId: proposal.proposalId,
    proposalSha256: proposalSha256(proposal),
    attempt: 1,
    producedAt: "2026-08-02T10:00:00.000Z",
    baseCommit: proposal.target.baseCommit,
    resultCommit: "e".repeat(40),
    businessSemanticsChanged: false,
    files: [{
      path: "apps/xhs/adapter.mjs",
      beforeSha256: "1".repeat(64),
      afterSha256: "2".repeat(64),
      addedLines: 20,
      deletedLines: 4,
    }],
    diff: { totalLines: 24, patchSha256: "3".repeat(64) },
    tests: [{ name: "node --test tests/control-plane-adapters.test.mjs", passed: true, evidenceSha256: "4".repeat(64) }],
    scopeGuard: { passed: true, evidenceSha256: "5".repeat(64) },
    secretScan: { passed: true, evidenceSha256: "6".repeat(64) },
    evidenceDebt: [],
    authority: {
      actorId: "win-fixer",
      actorRole: "windows_consumer",
      reviewVerdictModified: false,
      macWritePerformed: false,
      deploymentPerformed: false,
      deviceActions: 0,
    },
  };
}
