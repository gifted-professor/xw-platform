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
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

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
const ACTIVE_CLAIM = new Set(["claimed", "fixing", "request_changes"]);

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
    || ref.startsWith("./")
    || ref.split("/").includes("..")
    || ref.split("/").includes("")
  ) {
    throw new Error(`unsafe outbox ref: ${ref}`);
  }
}

function assertNotSymlink(path, label) {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error(`${label} symlink forbidden: ${path}`);
  }
}

function assertRealContained(realRoot, candidate, label) {
  const realCandidate = realpathSync(candidate);
  const rel = relative(realRoot, realCandidate);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`${label} escapes outbox root`);
  }
  return realCandidate;
}

/**
 * Lexical + realpath containment + per-component symlink rejection for write targets.
 * Creates missing ancestor directories only when they are real (non-symlink) dirs under root.
 */
export function resolveWritableOutboxPath(root, ref) {
  assertSafeOutboxRef(ref);
  if (!root || typeof root !== "string") throw new Error("outbox root required");
  const rootPath = resolve(root);
  if (!existsSync(rootPath)) mkdirSync(rootPath, { recursive: true });
  assertNotSymlink(rootPath, "outbox root");
  const realRoot = realpathSync(rootPath);
  assertNotSymlink(realRoot, "outbox real root");

  const parts = ref.split("/");
  let cursor = rootPath;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    const next = join(cursor, part);
    const lexicalRel = relative(rootPath, next);
    if (!lexicalRel || lexicalRel.startsWith("..") || isAbsolute(lexicalRel)) {
      throw new Error(`outbox path escapes root lexically: ${ref}`);
    }
    const isFinal = i === parts.length - 1;
    if (existsSync(next)) {
      assertNotSymlink(next, isFinal ? "outbox target" : "outbox ancestor");
      if (!isFinal && !lstatSync(next).isDirectory()) {
        throw new Error(`outbox ancestor is not a directory: ${next}`);
      }
      assertRealContained(realRoot, next, isFinal ? "outbox target" : "outbox ancestor");
    } else if (!isFinal) {
      mkdirSync(next, { recursive: false });
      assertNotSymlink(next, "outbox ancestor");
      if (!lstatSync(next).isDirectory()) throw new Error(`failed to create outbox directory: ${next}`);
      assertRealContained(realRoot, next, "outbox ancestor");
    }
    cursor = next;
  }

  const parent = dirname(cursor);
  assertNotSymlink(parent, "outbox parent");
  const realParent = assertRealContained(realRoot, parent, "outbox parent");
  return {
    rootPath,
    realRoot,
    target: cursor,
    parent,
    realParent,
  };
}

export function exclusiveCreateFile(root, ref, body) {
  const { target, realParent, realRoot } = resolveWritableOutboxPath(root, ref);
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
    assertNotSymlink(target, "outbox target");
    assertRealContained(realRoot, target, "outbox target");
    writeSync(fd, text);
  } catch (error) {
    try { closeSync(fd); } catch { /* ignore */ }
    try { unlinkSync(target); } catch { /* ignore */ }
    throw error;
  }
  closeSync(fd);
  assertNotSymlink(target, "outbox target");
  assertRealContained(realRoot, dirname(target), "outbox parent");
  if (realpathSync(dirname(target)) !== realParent) {
    try { unlinkSync(target); } catch { /* ignore */ }
    throw new Error("outbox parent realpath changed during write");
  }
  return { ok: true, sha256: digest, path: target };
}

export function exclusiveWriteJson(root, ref, value) {
  return exclusiveCreateFile(root, ref, `${JSON.stringify(value)}\n`);
}

export function atomicReplaceJson(root, ref, value) {
  const { target, realParent, realRoot } = resolveWritableOutboxPath(root, ref);
  const body = `${JSON.stringify(value)}\n`;
  const tmpName = `.${ref.split("/").at(-1)}.${process.pid}.${Date.now()}.tmp`;
  const tmp = join(realParent, tmpName);
  const tmpRel = relative(realRoot, tmp);
  if (!tmpRel || tmpRel.startsWith("..") || isAbsolute(tmpRel) || tmpRel.split(sep).includes("..")) {
    throw new Error("temporary outbox file escapes root");
  }
  writeFileSync(tmp, body);
  try {
    assertNotSymlink(tmp, "outbox temp");
    assertRealContained(realRoot, tmp, "outbox temp");
    if (existsSync(target)) assertNotSymlink(target, "outbox target");
    renameSync(tmp, target);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw error;
  }
  assertNotSymlink(target, "outbox target");
  assertRealContained(realRoot, target, "outbox target");
  return { ok: true, sha256: sha256(body), path: target };
}

export function writeAppendOnlyEvent(root, proposal, event) {
  const ref = `${proposal.transport.outboxNamespace}/events/${event.eventId}.json`;
  const body = `${JSON.stringify(event)}\n`;
  const written = exclusiveCreateFile(root, ref, body);
  if (written.ok) return written.path;
  const existingPath = resolveWritableOutboxPath(root, ref).target;
  const existingDigest = sha256(readFileSync(existingPath));
  const nextDigest = sha256(body);
  if (existingDigest !== nextDigest) {
    throw new Error("append-only event collision: same eventId different content");
  }
  return existingPath;
}

export function sortRepairEvents(events) {
  return [...events].sort((a, b) => {
    const at = Date.parse(a.occurredAt) - Date.parse(b.occurredAt);
    if (at !== 0) return at;
    return String(a.eventId).localeCompare(String(b.eventId));
  });
}

export function listOutboxEvents(root, proposal) {
  const ref = `${proposal.transport.outboxNamespace}/events`;
  assertSafeOutboxRef(`${ref}/placeholder.json`);
  const rootPath = resolve(root);
  if (!existsSync(rootPath)) return [];
  assertNotSymlink(rootPath, "outbox root");
  const eventsDir = join(rootPath, ...ref.split("/"));
  if (!existsSync(eventsDir)) return [];
  assertNotSymlink(eventsDir, "events dir");
  const realRoot = realpathSync(rootPath);
  assertRealContained(realRoot, eventsDir, "events dir");
  const events = [];
  for (const name of readdirSync(eventsDir)) {
    if (!name.endsWith(".json")) continue;
    const eventRef = `${ref}/${name}`;
    assertSafeOutboxRef(eventRef);
    const full = join(eventsDir, name);
    assertNotSymlink(full, "event file");
    assertRealContained(realRoot, full, "event file");
    events.push(JSON.parse(readFileSync(full, "utf8")));
  }
  return sortRepairEvents(events);
}

export function reduceOutboxEvents(proposal, events, verifiers) {
  let projection = initialRepairProjection(proposal);
  for (const event of sortRepairEvents(events)) {
    projection = applyRepairEvent(proposal, projection, event, verifiers);
  }
  return projection;
}

function readJsonIfPresent(path) {
  if (!existsSync(path)) return null;
  assertNotSymlink(path, "json file");
  return JSON.parse(readFileSync(path, "utf8"));
}

export function createRepairConsumer({
  outboxRoot,
  actorId,
  knowledgeClient = null,
  macRepoRoot = null,
  trustedMacRef = "refs/remotes/origin/main",
  completionRoot = null,
  replayAuthorizationPublicKeys = {},
  writeEventImpl = writeAppendOnlyEvent,
  now = () => new Date(),
} = {}) {
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
    mirroredEventIds: new Set(),
  };

  function iso(at = now()) {
    const date = at instanceof Date ? at : new Date(at);
    return `${date.toISOString().slice(0, 19)}.000Z`;
  }

  function recoverProjection(proposal) {
    return reduceOutboxEvents(proposal, listOutboxEvents(outboxRoot, proposal), verifiers);
  }

  function loadOrInit(proposal) {
    assertProposalReadyForClaim(proposal);
    state.proposal = proposal;
    state.projection = recoverProjection(proposal);
    return state.projection;
  }

  async function mirrorKnowledge(envelope) {
    if (!knowledgeClient) {
      return { ok: false, debt: true, skipped: true, code: "KNOWLEDGE_CLIENT_ABSENT" };
    }
    const result = await knowledgeClient.postKnowledge(envelope);
    if (result.debt) {
      state.evidenceDebt.push({
        layer: "repair-transport",
        code: "KNOWLEDGE_MIRROR_FAILED",
        cause: result.error || result.code || `status ${result.status}`,
        at: iso(),
        businessResultUnchanged: true,
        envelopeId: envelope?.id || null,
      });
    }
    return result;
  }

  async function mirrorEventAfterPersist(event) {
    if (state.mirroredEventIds.has(event.eventId)) {
      return { ok: true, debt: false, idempotent: true, id: event.eventId };
    }
    const result = await mirrorKnowledge(repairEventKnowledgeEnvelope(event));
    if (result.ok) state.mirroredEventIds.add(event.eventId);
    return result;
  }

  async function appendEvent(eventType, payload = {}, at = now()) {
    if (!state.proposal || !state.projection) throw new Error("consumer has no active proposal");
    rejectUnauthorizedWindowsEvent(eventType);
    const event = createRepairEvent(state.proposal, state.projection, {
      eventType,
      actor: { role: "windows_consumer", id: actorId },
      occurredAt: iso(at),
      payload,
    });
    // Pure reducer first — memory projection advances only after durable append succeeds.
    const nextProjection = applyRepairEvent(state.proposal, state.projection, event, verifiers);
    const eventPath = writeEventImpl(outboxRoot, state.proposal, event);
    state.projection = nextProjection;
    const mirror = await mirrorEventAfterPersist(event);
    return { event, projection: state.projection, eventPath, mirror };
  }

  function clearOrphanClaimLock(lockRef, lockPath, at) {
    const orphan = readJsonIfPresent(lockPath);
    if (!orphan || orphan.schemaId !== "xhs.repair-claim-lock.v1") return false;
    if (orphan.proposalId !== state.proposal.proposalId) return false;
    if (orphan.attempt !== state.projection.attempt + 1) return false;
    // Lock without a matching claim event (projection still proposed) is an orphan.
    if (state.projection.status !== "proposed") return false;
    const expired = !orphan.expiresAt || Date.parse(iso(at)) >= Date.parse(orphan.expiresAt);
    if (orphan.actorId !== actorId && !expired) return false;
    assertSafeOutboxRef(lockRef);
    const resolved = resolveWritableOutboxPath(outboxRoot, lockRef);
    assertNotSymlink(resolved.target, "orphan lock");
    unlinkSync(resolved.target);
    return true;
  }

  async function tryClaim({ at = now() } = {}) {
    if (!state.proposal) throw new Error("load proposal before claim");
    if (ACTIVE_CLAIM.has(state.projection.status) && state.projection.claim?.holder === actorId) {
      const expired = state.projection.claim.expiresAt
        && Date.parse(iso(at)) >= Date.parse(state.projection.claim.expiresAt);
      if (!expired) {
        return {
          ok: true,
          resumed: true,
          event: null,
          projection: state.projection,
          lockRef: state.projection.claim.lockRef,
          lockSha256: state.projection.claim.lockSha256,
        };
      }
    }

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

    let acquired = exclusiveWriteJson(outboxRoot, lockRef, lock);
    if (!acquired.ok) {
      const lockPath = resolveWritableOutboxPath(outboxRoot, lockRef).target;
      if (clearOrphanClaimLock(lockRef, lockPath, at)) {
        acquired = exclusiveWriteJson(outboxRoot, lockRef, lock);
      }
    }
    if (!acquired.ok) {
      return { ok: false, reason: acquired.reason || "EEXIST", lockRef };
    }

    try {
      const { event, projection, eventPath, mirror } = await appendEvent("claim", {
        expiresAt,
        lockRef,
        lockSha256: acquired.sha256,
      }, at);
      return {
        ok: true,
        resumed: false,
        event,
        projection,
        eventPath,
        lockRef,
        lockSha256: acquired.sha256,
        mirror,
      };
    } catch (error) {
      // Leave orphan lock for restart recovery; projection must not advance.
      return {
        ok: false,
        reason: error.message || "CLAIM_EVENT_WRITE_FAILED",
        lockRef,
        lockSha256: acquired.sha256,
        orphanLock: true,
        error,
      };
    }
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
    recoverFromOutbox() {
      if (!state.proposal) throw new Error("load proposal before recover");
      state.projection = recoverProjection(state.proposal);
      return state.projection;
    },
    listEvents() {
      if (!state.proposal) return [];
      return listOutboxEvents(outboxRoot, state.proposal);
    },
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
    tryClaim,
    async ensureClaim({ at = now() } = {}) {
      if (
        ACTIVE_CLAIM.has(state.projection.status)
        && state.projection.claim?.expiresAt
        && Date.parse(iso(at)) >= Date.parse(state.projection.claim.expiresAt)
      ) {
        await appendEvent("claim_expired", {}, at);
      }
      return tryClaim({ at });
    },
    async heartbeat({ at = now() } = {}) {
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
    async startFixing({ at = now() } = {}) {
      return appendEvent("start_fixing", {}, at);
    },
    async expireClaim({ at = now() } = {}) {
      return appendEvent("claim_expired", {}, at);
    },
    async failAttempt({ reason, at = now() } = {}) {
      return appendEvent("attempt_failed", { reason: reason || "attempt failed" }, at);
    },
    async sealSourceCheckpoint(checkpoint, { at = now() } = {}) {
      if (!checkpoint || typeof checkpoint !== "object") {
        throw new Error("source checkpoint required; live consumer refuses demo/fake checkpoints");
      }
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
      let written = exclusiveWriteJson(outboxRoot, outboxRef, checkpoint);
      if (!written.ok) {
        const existingPath = resolveWritableOutboxPath(outboxRoot, outboxRef).target;
        const existingBody = `${readFileSync(existingPath)}`;
        const expectedBody = `${JSON.stringify(checkpoint)}\n`;
        if (sha256(existingBody) !== sha256(expectedBody)) {
          throw new Error(`failed to seal source checkpoint: ${written.reason}`);
        }
        written = { ok: true, sha256: sha256(expectedBody), path: existingPath };
      }
      const result = await appendEvent("source_checkpoint", {
        bundleSha256: written.sha256,
        outboxRef,
      }, at);
      state.sealedCheckpoint = { ...checkpoint, outboxRef, bundleSha256: written.sha256 };
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
