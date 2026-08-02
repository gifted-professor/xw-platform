/**
 * Windows repair consumer v1 — discovers backlog repair proposals, exclusive-claim,
 * heartbeat/TTL/attempt/circuit-breaker via append-only events, seals source
 * checkpoints, then stops at source_review for independent Mac review.
 *
 * Reuses registry knowledge + sealed outbox. No new service/DB/control plane.
 * Never self-approves, never marks deployable, never deploys/replays without
 * separately trusted Mac/Git + human Ed25519 authorization.
 */
import {
  closeSync,
  constants as fsConstants,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { createRepairAuthorityVerifiers } from "./repair-authority-verifiers.mjs";
import {
  applyRepairEvent,
  createRepairEvent,
  initialRepairProjection,
  isAllowedRepairPath,
  proposalKnowledgeEnvelope,
  proposalSha256,
  repairEventKnowledgeEnvelope,
  scanForSecrets,
  sha256,
  validateRepairProposal,
  validateSourceCheckpoint,
} from "./repair-proposal.mjs";

const DEFAULT_REGISTRY = "http://127.0.0.1:17930";

export function createKnowledgeClient({
  endpoint = DEFAULT_REGISTRY,
  fetchImpl = globalThis.fetch,
  timeoutMs = 10000,
} = {}) {
  return {
    async listRepairProposals() {
      const url = `${endpoint}/api/knowledge?appliesTo=${encodeURIComponent("repair-proposal-v1")}&lifecycle=backlog`;
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new Error(`knowledge list failed: ${response.status}`);
      const data = await response.json();
      const items = data.knowledge || data.items || [];
      return items.map((item) => parseKnowledgeProposal(item)).filter(Boolean);
    },
    async postKnowledge(envelope) {
      try {
        const response = await fetchImpl(`${endpoint}/api/knowledge`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(envelope),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          return {
            ok: false,
            debt: true,
            status: response.status,
            code: data.error || data.reason || "KNOWLEDGE_WRITE_FAILED",
          };
        }
        return { ok: true, debt: false, id: data.knowledge?.id || envelope.id };
      } catch (error) {
        return { ok: false, debt: true, error: error.message };
      }
    },
  };
}

export function parseKnowledgeProposal(item) {
  if (!item || typeof item !== "object") return null;
  let proposal = null;
  if (typeof item.content === "string") {
    try {
      proposal = JSON.parse(item.content);
    } catch {
      return null;
    }
  } else if (item.content && typeof item.content === "object") {
    proposal = item.content;
  } else if (item.schemaId === "xhs.repair-proposal.v1") {
    proposal = item;
  }
  if (!proposal || proposal.schemaId !== "xhs.repair-proposal.v1") return null;
  return proposal;
}

export function assertProposalReadyForClaim(proposal, {
  expectedProposalId = null,
  expectedProposalSha256 = null,
  expectedBaseCommit = null,
} = {}) {
  const validation = validateRepairProposal(proposal);
  if (!validation.ok) throw new Error(`proposal schema invalid: ${validation.errors.join("; ")}`);
  const digest = proposalSha256(proposal);
  if (expectedProposalId && proposal.proposalId !== expectedProposalId) {
    throw new Error("proposalId mismatch");
  }
  if (expectedProposalSha256 && digest !== expectedProposalSha256) {
    throw new Error("proposal canonical hash mismatch");
  }
  if (expectedBaseCommit && proposal.target.baseCommit !== expectedBaseCommit) {
    throw new Error("proposal baseCommit mismatch");
  }
  if (proposal.circuitBreaker?.state && proposal.circuitBreaker.state !== "closed") {
    throw new Error("circuit breaker is open");
  }
  if (proposal.supersession?.supersededBy) {
    throw new Error("proposal has been superseded");
  }
  if (!Array.isArray(proposal.policy?.forbiddenPaths) || !Array.isArray(proposal.policy?.allowedPaths)) {
    throw new Error("proposal missing allowlist/forbidden path policy");
  }
  return { proposal, proposalSha256: digest };
}

export function rejectUnauthorizedWindowsEvent(eventType) {
  const forbidden = new Set([
    "review_approved",
    "review_request_changes",
    "mark_deployable",
    "cancel",
  ]);
  if (forbidden.has(eventType)) {
    throw new Error(`windows consumer cannot emit ${eventType}; Mac independent review required`);
  }
}

export function assertSafeOutboxRef(ref) {
  if (
    typeof ref !== "string"
    || !ref
    || ref.includes("\\")
    || ref.includes("\0")
    || ref.includes(":")
    || ref.startsWith("/")
    || ref.split("/").includes("..")
    || ref.split("/").includes("")
  ) {
    throw new Error(`unsafe outbox ref: ${ref}`);
  }
}

export function exclusiveCreateFile(root, ref, body) {
  assertSafeOutboxRef(ref);
  const target = join(root, ...ref.split("/"));
  mkdirSync(dirname(target), { recursive: true });
  const text = typeof body === "string" ? body : `${JSON.stringify(body)}\n`;
  const digest = sha256(text);
  let fd;
  try {
    fd = openSync(target, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o644);
  } catch (error) {
    if (error?.code === "EEXIST") return { ok: false, reason: "EEXIST" };
    throw error;
  }
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
  return { ok: true, sha256: digest, path: target };
}

export function exclusiveWriteJson(root, ref, value) {
  return exclusiveCreateFile(root, ref, `${JSON.stringify(value)}\n`);
}

export function atomicReplaceJson(root, ref, value) {
  assertSafeOutboxRef(ref);
  const target = join(root, ...ref.split("/"));
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  const body = `${JSON.stringify(value)}\n`;
  writeFileSync(tmp, body);
  renameSync(tmp, target);
  return { ok: true, sha256: sha256(body), path: target };
}

export function writeAppendOnlyEvent(root, proposal, event) {
  const ref = `${proposal.transport.outboxNamespace}/events/${event.eventId}.json`;
  const body = `${JSON.stringify(event)}\n`;
  const written = exclusiveCreateFile(root, ref, body);
  if (written.ok) return written.path;
  const existingPath = join(root, ...ref.split("/"));
  const existingDigest = sha256(readFileSync(existingPath));
  const nextDigest = sha256(body);
  if (existingDigest !== nextDigest) {
    throw new Error("append-only event collision: same eventId different content");
  }
  return existingPath;
}

export function createRepairConsumer({
  outboxRoot,
  actorId,
  knowledgeClient = null,
  macRepoRoot = null,
  trustedMacRef = "refs/remotes/origin/main",
  completionRoot = null,
  replayAuthorizationPublicKeys = {},
  now = () => new Date(),
}) {
  if (!outboxRoot) throw new Error("outboxRoot required");
  if (!actorId || typeof actorId !== "string") throw new Error("actorId required");

  const verifiers = createRepairAuthorityVerifiers({
    macRepoRoot: macRepoRoot || join(outboxRoot, ".unused-mac"),
    trustedMacRef,
    outboxRoot,
    completionRoot: completionRoot || join(outboxRoot, ".unused-completion"),
    replayAuthorizationPublicKeys,
  });

  const state = {
    proposal: null,
    projection: null,
    evidenceDebt: [],
    sealedCheckpoint: null,
  };

  function iso(at = now()) {
    const date = at instanceof Date ? at : new Date(at);
    return `${date.toISOString().slice(0, 19)}.000Z`;
  }

  function loadOrInit(proposal) {
    assertProposalReadyForClaim(proposal);
    state.proposal = proposal;
    state.projection = initialRepairProjection(proposal);
    return state.projection;
  }

  function appendEvent(eventType, payload = {}, at = now()) {
    if (!state.proposal || !state.projection) throw new Error("consumer has no active proposal");
    rejectUnauthorizedWindowsEvent(eventType);
    const event = createRepairEvent(state.proposal, state.projection, {
      eventType,
      actor: { role: "windows_consumer", id: actorId },
      occurredAt: iso(at),
      payload,
    });
    state.projection = applyRepairEvent(state.proposal, state.projection, event, verifiers);
    const eventPath = writeAppendOnlyEvent(outboxRoot, state.proposal, event);
    return { event, projection: state.projection, eventPath };
  }

  async function mirrorKnowledge(envelope) {
    if (!knowledgeClient) return { ok: false, debt: true, skipped: true };
    const result = await knowledgeClient.postKnowledge(envelope);
    if (result.debt) {
      state.evidenceDebt.push({
        layer: "repair-transport",
        code: "KNOWLEDGE_MIRROR_FAILED",
        cause: result.error || result.code || `status ${result.status}`,
        at: iso(),
        businessResultUnchanged: true,
      });
    }
    return result;
  }

  return {
    get projection() {
      return state.projection;
    },
    get proposal() {
      return state.proposal;
    },
    get evidenceDebt() {
      return state.evidenceDebt.slice();
    },
    get sealedCheckpoint() {
      return state.sealedCheckpoint;
    },
    verifiers,
    loadProposal: loadOrInit,
    async discoverAndSelect({
      expectedProposalId,
      expectedProposalSha256,
      expectedBaseCommit,
    } = {}) {
      if (!knowledgeClient) throw new Error("knowledgeClient required for discovery");
      const proposals = await knowledgeClient.listRepairProposals();
      const selected = expectedProposalId
        ? proposals.find((item) => item.proposalId === expectedProposalId)
        : proposals[0];
      if (!selected) throw new Error("no backlog repair proposal discovered");
      assertProposalReadyForClaim(selected, {
        expectedProposalId,
        expectedProposalSha256,
        expectedBaseCommit,
      });
      return loadOrInit(selected);
    },
    tryClaim({ at = now() } = {}) {
      if (!state.proposal) throw new Error("load proposal before claim");
      const attempt = state.projection.attempt + 1;
      const claimedAt = iso(at);
      const ttlSeconds = state.proposal.policy.heartbeat.claimTtlSeconds;
      const expiresAt = iso(new Date(Date.parse(claimedAt) + ttlSeconds * 1000));
      const lock = {
        schemaId: "xhs.repair-claim-lock.v1",
        schemaVersion: 1,
        proposalId: state.proposal.proposalId,
        proposalSha256: state.projection.proposalSha256,
        attempt,
        actorId,
        claimedAt,
        expiresAt,
      };
      const lockRef = `${state.proposal.transport.outboxNamespace}/attempt-${attempt}/claim.lock`;
      const acquired = exclusiveWriteJson(outboxRoot, lockRef, lock);
      if (!acquired.ok) {
        return { ok: false, reason: acquired.reason || "EEXIST", lockRef };
      }
      const { event, projection, eventPath } = appendEvent("claim", {
        expiresAt,
        lockRef,
        lockSha256: acquired.sha256,
      }, at);
      return {
        ok: true,
        event,
        projection,
        eventPath,
        lockRef,
        lockSha256: acquired.sha256,
      };
    },
    heartbeat({ at = now() } = {}) {
      const heartbeatAt = iso(at);
      const ttlSeconds = state.proposal.policy.heartbeat.claimTtlSeconds;
      const expiresAt = iso(new Date(Date.parse(heartbeatAt) + ttlSeconds * 1000));
      const receiptRef = `${state.proposal.transport.outboxNamespace}/attempt-${state.projection.attempt}/heartbeat.json`;
      atomicReplaceJson(outboxRoot, receiptRef, {
        schemaId: "xhs.repair-heartbeat.v1",
        schemaVersion: 1,
        proposalId: state.proposal.proposalId,
        attempt: state.projection.attempt,
        actorId,
        heartbeatAt,
        expiresAt,
        lockSha256: state.projection.claim.lockSha256,
      });
      return appendEvent("heartbeat", {
        expiresAt,
        lockSha256: state.projection.claim.lockSha256,
      }, at);
    },
    startFixing({ at = now() } = {}) {
      return appendEvent("start_fixing", {}, at);
    },
    expireClaim({ at = now() } = {}) {
      return appendEvent("claim_expired", {}, at);
    },
    failAttempt({ reason, at = now() } = {}) {
      return appendEvent("attempt_failed", { reason: reason || "attempt failed" }, at);
    },
    sealSourceCheckpoint(checkpoint, { at = now() } = {}) {
      const validation = validateSourceCheckpoint(state.proposal, checkpoint);
      if (!validation.ok) {
        throw new Error(`source checkpoint invalid: ${validation.errors.join("; ")}`);
      }
      if (checkpoint.authority?.actorRole !== "windows_consumer") {
        throw new Error("source checkpoint authority must be windows_consumer");
      }
      if (
        checkpoint.authority.reviewVerdictModified !== false
        || checkpoint.authority.macWritePerformed !== false
        || checkpoint.authority.deploymentPerformed !== false
        || checkpoint.authority.deviceActions !== 0
      ) {
        throw new Error("source checkpoint claims forbidden authority side effects");
      }
      if (checkpoint.businessSemanticsChanged !== false) {
        throw new Error("businessSemanticsChanged must remain false");
      }
      for (const file of checkpoint.files || []) {
        if (!isAllowedRepairPath(file.path, state.proposal.policy)) {
          throw new Error(`file outside allowlist: ${file.path}`);
        }
      }
      const secrets = scanForSecrets(checkpoint);
      if (secrets.length) {
        throw new Error(`secret material in checkpoint: ${secrets.join(",")}`);
      }

      const outboxRef = `${state.proposal.transport.outboxNamespace}/attempt-${state.projection.attempt}/source-checkpoint.json`;
      const written = exclusiveWriteJson(outboxRoot, outboxRef, checkpoint);
      if (!written.ok) throw new Error(`failed to seal source checkpoint: ${written.reason}`);
      state.sealedCheckpoint = { ...checkpoint, outboxRef, bundleSha256: written.sha256 };
      const result = appendEvent("source_checkpoint", {
        bundleSha256: written.sha256,
        outboxRef,
      }, at);
      return { ...result, checkpoint: state.sealedCheckpoint };
    },
    async mirrorProposalKnowledge() {
      return mirrorKnowledge(proposalKnowledgeEnvelope(state.proposal));
    },
    async mirrorEventKnowledge(event, extras = {}) {
      return mirrorKnowledge(repairEventKnowledgeEnvelope(event, extras));
    },
    assertStoppedForMacReview() {
      if (state.projection?.status !== "source_review") {
        throw new Error(`expected source_review, got ${state.projection?.status}`);
      }
      return {
        status: "source_review",
        waitingFor: "mac_independent_review",
        windowsCannotEmit: [
          "review_approved",
          "review_request_changes",
          "mark_deployable",
          "cancel",
        ],
      };
    },
  };
}
