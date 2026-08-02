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
  canonicalJson,
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
const MIRROR_RECEIPT_SCHEMA = "xhs.repair-knowledge-mirror-receipt.v1";
const EVIDENCE_DEBT_SCHEMA = "xhs.repair-evidence-debt.v1";
const EVENT_ID_RE = /^repair_event_[0-9a-f]{24}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

export function createKnowledgeClient({
  endpoint = DEFAULT_REGISTRY,
  fetchImpl = globalThis.fetch,
  timeoutMs = 10000,
} = {}) {
  async function readJsonSafe(response) {
    if (typeof response.text === "function") {
      const text = await response.text();
      if (!text) return {};
      try {
        return JSON.parse(text);
      } catch (error) {
        const err = new Error(`malformed JSON: ${error.message}`);
        err.code = "MALFORMED_JSON";
        throw err;
      }
    }
    if (typeof response.json === "function") return response.json();
    return {};
  }

  return {
    async listRepairProposals() {
      const url = `${endpoint}/api/knowledge?appliesTo=${encodeURIComponent("repair-proposal-v1")}&lifecycle=backlog`;
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new Error(`knowledge list failed: ${response.status}`);
      const data = await readJsonSafe(response);
      const items = data.knowledge || data.items || [];
      return items.map((item) => parseKnowledgeProposal(item)).filter(Boolean);
    },
    async getKnowledge(id) {
      const response = await fetchImpl(`${endpoint}/api/knowledge/${encodeURIComponent(id)}`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status === 404) return { ok: false, status: 404, knowledge: null };
      const data = await readJsonSafe(response);
      if (!response.ok) {
        return { ok: false, status: response.status, error: data.error || data.reason || "GET_FAILED" };
      }
      return { ok: true, status: response.status, knowledge: data.knowledge || data };
    },
    async postKnowledge(envelope) {
      try {
        const response = await fetchImpl(`${endpoint}/api/knowledge`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(envelope),
          signal: AbortSignal.timeout(timeoutMs),
        });
        let data = {};
        try {
          data = await readJsonSafe(response);
        } catch (error) {
          if (response.ok || response.status === 201) {
            return { ok: false, debt: true, status: response.status, code: "MALFORMED_JSON", error: error.message };
          }
          // non-OK with bad body still surfaces status
          data = { error: error.message };
        }

        if (response.status === 409) {
          const got = await this.getKnowledge(envelope.id);
          if (got.ok && knowledgeEnvelopeCanonicallyEqual(envelope, got.knowledge)) {
            return {
              ok: true,
              debt: false,
              id: envelope.id,
              reconciled: true,
              status: 409,
            };
          }
          return {
            ok: false,
            debt: true,
            status: 409,
            code: got.ok ? "KNOWLEDGE_CONTENT_CONFLICT" : "KNOWLEDGE_CONFLICT_UNREADABLE",
            error: data.error || "knowledge id already exists",
          };
        }

        if (!response.ok) {
          return {
            ok: false,
            debt: true,
            status: response.status,
            code: data.error || data.reason || "KNOWLEDGE_WRITE_FAILED",
          };
        }
        return {
          ok: true,
          debt: false,
          id: data.knowledge?.id || envelope.id,
          status: response.status,
        };
      } catch (error) {
        const message = error?.message || String(error);
        const timedOut = error?.name === "TimeoutError" || /aborted|timeout/i.test(message);
        if (timedOut) {
          // Timeout after server commit: reconcile via GET when possible.
          try {
            const got = await this.getKnowledge(envelope.id);
            if (got.ok && knowledgeEnvelopeCanonicallyEqual(envelope, got.knowledge)) {
              return { ok: true, debt: false, id: envelope.id, reconciled: true, status: "timeout-reconciled" };
            }
          } catch {
            // fall through to debt
          }
        }
        return {
          ok: false,
          debt: true,
          error: message,
          code: timedOut ? "KNOWLEDGE_TIMEOUT" : "KNOWLEDGE_TRANSPORT_ERROR",
        };
      }
    },
  };
}

export function knowledgeEnvelopeCanonicallyEqual(posted, existing) {
  if (!posted || !existing) return false;
  if (posted.id !== existing.id) return false;
  const postedContent = typeof posted.content === "string" ? posted.content : canonicalJson(posted.content);
  const existingContent = typeof existing.content === "string" ? existing.content : canonicalJson(existing.content);
  return sha256(postedContent) === sha256(existingContent);
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
  afterEventPersist = null,
  faultInject = null,
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

  async function inject(phase, ctx = {}) {
    if (typeof faultInject === "function") await faultInject(phase, ctx);
  }

  function toIsoMs(at = now()) {
    const date = at instanceof Date ? at : new Date(at);
    if (Number.isNaN(date.getTime())) throw new Error(`invalid time: ${at}`);
    return date.toISOString();
  }

  /** Strictly after projection.lastOccurredAt; bumps at least +1ms when caller time stalls or goes backward. */
  function nextOccurredAt(at = now()) {
    let ms = Date.parse(toIsoMs(at));
    const last = state.projection?.lastOccurredAt
      ? Date.parse(state.projection.lastOccurredAt)
      : Number.NaN;
    if (!Number.isNaN(last) && ms <= last) ms = last + 1;
    return new Date(ms).toISOString();
  }

  function mirrorReceiptRef(eventId) {
    return `${state.proposal.transport.outboxNamespace}/knowledge-mirrors/${eventId}.json`;
  }

  function debtRef(eventId) {
    return `${state.proposal.transport.outboxNamespace}/evidence-debt/${eventId}.json`;
  }

  function buildMirrorReceipt(event, envelope, knowledgeId) {
    const eventDigest = sha256(event);
    const envelopeDigest = sha256(envelope);
    const body = {
      schemaId: MIRROR_RECEIPT_SCHEMA,
      schemaVersion: 1,
      eventId: event.eventId,
      eventSha256: eventDigest,
      envelopeSha256: envelopeDigest,
      knowledgeId: knowledgeId || event.eventId,
      mirroredAt: toIsoMs(),
    };
    return { ...body, receiptSha256: sha256({ ...body }) };
  }

  function validateMirrorReceipt(receipt, eventId, event = null) {
    if (!receipt || typeof receipt !== "object") return { ok: false, reason: "missing" };
    if (receipt.schemaId !== MIRROR_RECEIPT_SCHEMA || receipt.schemaVersion !== 1) {
      return { ok: false, reason: "schema" };
    }
    if (receipt.eventId !== eventId || !EVENT_ID_RE.test(receipt.eventId || "")) {
      return { ok: false, reason: "eventId" };
    }
    if (!SHA256_RE.test(receipt.eventSha256 || "") || !SHA256_RE.test(receipt.envelopeSha256 || "")) {
      return { ok: false, reason: "hash" };
    }
    if (!SHA256_RE.test(receipt.receiptSha256 || "")) return { ok: false, reason: "receiptSha256" };
    const { receiptSha256, ...unsigned } = receipt;
    if (sha256(unsigned) !== receiptSha256) return { ok: false, reason: "receipt_integrity" };
    if (event) {
      if (sha256(event) !== receipt.eventSha256) return { ok: false, reason: "event_binding" };
      const expectedEnvelope = sha256(repairEventKnowledgeEnvelope(event));
      if (receipt.envelopeSha256 !== expectedEnvelope) return { ok: false, reason: "envelope_binding" };
    }
    return { ok: true };
  }

  function validateEvidenceDebt(debt, eventId = null) {
    if (!debt || typeof debt !== "object") return { ok: false, reason: "missing" };
    if (debt.schemaId !== EVIDENCE_DEBT_SCHEMA || debt.schemaVersion !== 1) {
      return { ok: false, reason: "schema" };
    }
    if (debt.layer !== "repair-transport") return { ok: false, reason: "layer" };
    if (typeof debt.code !== "string" || !debt.code) return { ok: false, reason: "code" };
    if (debt.businessResultUnchanged !== true) return { ok: false, reason: "businessResultUnchanged" };
    if (eventId && debt.envelopeId && debt.envelopeId !== eventId) return { ok: false, reason: "envelopeId" };
    return { ok: true };
  }

  async function persistMirrorDebt(eventId, cause, code = "KNOWLEDGE_MIRROR_FAILED") {
    const debt = {
      schemaId: EVIDENCE_DEBT_SCHEMA,
      schemaVersion: 1,
      layer: "repair-transport",
      code,
      cause,
      at: toIsoMs(),
      businessResultUnchanged: true,
      envelopeId: eventId,
    };
    try {
      await inject("before_debt_write", { eventId, debt });
      atomicReplaceJson(outboxRoot, debtRef(eventId), debt);
      await inject("after_debt_write", { eventId, debt });
    } catch (error) {
      // Best-effort durable debt; never undo a durable claim/event because debt I/O failed.
      try {
        atomicReplaceJson(outboxRoot, debtRef(eventId), debt);
      } catch { /* ignore */ }
    }
    const without = state.evidenceDebt.filter((item) => item.envelopeId !== eventId);
    without.push(debt);
    state.evidenceDebt = without;
    return debt;
  }

  function readValidatedJsonRef(ref, validate) {
    try {
      const { target } = resolveWritableOutboxPath(outboxRoot, ref);
      if (!existsSync(target)) return null;
      assertNotSymlink(target, ref);
      const raw = readFileSync(target, "utf8");
      if (!raw || !raw.trim()) return null;
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return null;
      }
      const check = validate(parsed);
      return check.ok ? parsed : null;
    } catch {
      return null;
    }
  }

  function hydrateMirrorStateFromOutbox() {
    if (!state.proposal) return;
    const events = listOutboxEvents(outboxRoot, state.proposal);
    const byId = new Map(events.map((event) => [event.eventId, event]));
    state.mirroredEventIds = new Set();
    state.evidenceDebt = [];
    for (const event of events) {
      const receipt = readValidatedJsonRef(
        mirrorReceiptRef(event.eventId),
        (value) => validateMirrorReceipt(value, event.eventId, event),
      );
      if (receipt) state.mirroredEventIds.add(event.eventId);
      const debt = readValidatedJsonRef(
        debtRef(event.eventId),
        (value) => validateEvidenceDebt(value, event.eventId),
      );
      if (debt) state.evidenceDebt.push(debt);
    }
    // Scan debt dir for orphans with valid schema (still visible after restart).
    const ns = state.proposal.transport.outboxNamespace;
    const debtDir = join(outboxRoot, ...`${ns}/evidence-debt`.split("/"));
    if (existsSync(debtDir)) {
      assertNotSymlink(debtDir, "evidence-debt dir");
      for (const name of readdirSync(debtDir).sort()) {
        if (!name.endsWith(".json")) continue;
        const eventId = name.replace(/\.json$/, "");
        if (state.evidenceDebt.some((item) => item.envelopeId === eventId)) continue;
        const debt = readValidatedJsonRef(debtRef(eventId), (value) => validateEvidenceDebt(value, eventId));
        if (debt) state.evidenceDebt.push(debt);
      }
    }
    // Reject fake receipts that don't bind a known event.
    const mirrorsDir = join(outboxRoot, ...`${ns}/knowledge-mirrors`.split("/"));
    if (existsSync(mirrorsDir)) {
      assertNotSymlink(mirrorsDir, "knowledge-mirrors dir");
      for (const name of readdirSync(mirrorsDir)) {
        if (!name.endsWith(".json")) continue;
        const eventId = name.replace(/\.json$/, "");
        const event = byId.get(eventId) || null;
        const receipt = readValidatedJsonRef(
          mirrorReceiptRef(eventId),
          (value) => validateMirrorReceipt(value, eventId, event),
        );
        if (receipt && event) state.mirroredEventIds.add(eventId);
      }
    }
  }

  function recoverProjection(proposal) {
    return reduceOutboxEvents(proposal, listOutboxEvents(outboxRoot, proposal), verifiers);
  }

  async function loadOrInit(proposal) {
    assertProposalReadyForClaim(proposal);
    state.proposal = proposal;
    state.projection = recoverProjection(proposal);
    hydrateMirrorStateFromOutbox();
    await retryPendingMirrors();
    return state.projection;
  }

  async function mirrorKnowledge(envelope) {
    if (!knowledgeClient) {
      return { ok: false, debt: true, skipped: true, code: "KNOWLEDGE_CLIENT_ABSENT" };
    }
    try {
      await inject("before_knowledge_post", { envelope });
      const result = await knowledgeClient.postKnowledge(envelope);
      await inject("after_knowledge_post", { envelope, result });
      if (result?.debt) {
        if (!result.skipped && envelope?.id) {
          await persistMirrorDebt(
            envelope.id,
            result.error || result.code || `status ${result.status}`,
            "KNOWLEDGE_MIRROR_FAILED",
          );
        } else {
          state.evidenceDebt.push({
            schemaId: EVIDENCE_DEBT_SCHEMA,
            schemaVersion: 1,
            layer: "repair-transport",
            code: "KNOWLEDGE_MIRROR_FAILED",
            cause: result.error || result.code || `status ${result.status}`,
            at: toIsoMs(),
            businessResultUnchanged: true,
            envelopeId: envelope?.id || null,
          });
        }
      }
      return result;
    } catch (error) {
      if (envelope?.id) {
        await persistMirrorDebt(envelope.id, error.message || "postKnowledge threw");
      } else {
        state.evidenceDebt.push({
          schemaId: EVIDENCE_DEBT_SCHEMA,
          schemaVersion: 1,
          layer: "repair-transport",
          code: "KNOWLEDGE_MIRROR_FAILED",
          cause: error.message || "postKnowledge threw",
          at: toIsoMs(),
          businessResultUnchanged: true,
          envelopeId: null,
        });
      }
      return { ok: false, debt: true, error: error.message || String(error) };
    }
  }

  async function writeMirrorReceipt(event, envelope, knowledgeId) {
    const receipt = buildMirrorReceipt(event, envelope, knowledgeId);
    try {
      await inject("before_receipt_write", { event, receipt });
      const written = exclusiveWriteJson(outboxRoot, mirrorReceiptRef(event.eventId), receipt);
      if (!written.ok) {
        if (written.reason === "EEXIST") {
          const existing = readValidatedJsonRef(
            mirrorReceiptRef(event.eventId),
            (value) => validateMirrorReceipt(value, event.eventId, event),
          );
          if (existing && existing.envelopeSha256 === receipt.envelopeSha256) {
            await inject("after_receipt_write", { event, receipt: existing, idempotent: true });
            return { ok: true, receipt: existing, idempotent: true };
          }
          // Conflicting receipt bytes — remove unsafe file so hydrate cannot trust it.
          try {
            const path = resolveWritableOutboxPath(outboxRoot, mirrorReceiptRef(event.eventId)).target;
            assertNotSymlink(path, "conflicting receipt");
            unlinkSync(path);
          } catch { /* ignore */ }
          return { ok: false, reason: "RECEIPT_CONFLICT" };
        }
        return { ok: false, reason: written.reason || "RECEIPT_WRITE_FAILED" };
      }
      await inject("after_receipt_write", { event, receipt });
      return { ok: true, receipt };
    } catch (error) {
      return { ok: false, reason: error.message || "RECEIPT_WRITE_FAILED" };
    }
  }

  async function mirrorEventAfterPersist(event) {
    try {
      if (state.mirroredEventIds.has(event.eventId)) {
        return { ok: true, debt: false, idempotent: true, id: event.eventId };
      }
      const existingReceipt = readValidatedJsonRef(
        mirrorReceiptRef(event.eventId),
        (value) => validateMirrorReceipt(value, event.eventId, event),
      );
      if (existingReceipt) {
        state.mirroredEventIds.add(event.eventId);
        return { ok: true, debt: false, idempotent: true, id: event.eventId };
      }

      const envelope = repairEventKnowledgeEnvelope(event);
      const result = await mirrorKnowledge(envelope);
      if (!result.ok) return result;

      const written = await writeMirrorReceipt(event, envelope, result.id || event.eventId);
      if (!written.ok) {
        // POST/reconcile succeeded but local receipt failed — keep claim durable; record receipt debt.
        // Reconcile again via GET when possible so restart can finish the receipt.
        if (knowledgeClient?.getKnowledge) {
          try {
            const got = await knowledgeClient.getKnowledge(event.eventId);
            if (got.ok && knowledgeEnvelopeCanonicallyEqual(envelope, got.knowledge)) {
              const retry = await writeMirrorReceipt(event, envelope, event.eventId);
              if (retry.ok) {
                state.mirroredEventIds.add(event.eventId);
                clearDebt(event.eventId);
                return { ok: true, debt: false, id: event.eventId, reconciled: true };
              }
            }
          } catch {
            // fall through to receipt debt
          }
        }
        await persistMirrorDebt(
          event.eventId,
          written.reason || "receipt persist failed after successful knowledge write",
          "KNOWLEDGE_RECEIPT_PERSIST_FAILED",
        );
        // Knowledge is durable remotely; leave mirrored unset so restart retries receipt.
        return {
          ok: true,
          debt: true,
          receiptFailed: true,
          id: event.eventId,
          code: "KNOWLEDGE_RECEIPT_PERSIST_FAILED",
        };
      }

      state.mirroredEventIds.add(event.eventId);
      clearDebt(event.eventId);
      return result;
    } catch (error) {
      await persistMirrorDebt(event.eventId, error.message || "mirrorEventAfterPersist threw");
      return { ok: false, debt: true, error: error.message || String(error) };
    }
  }

  function clearDebt(eventId) {
    const debtPath = join(outboxRoot, ...debtRef(eventId).split("/"));
    if (existsSync(debtPath)) {
      try {
        assertNotSymlink(debtPath, "evidence debt");
        unlinkSync(debtPath);
      } catch { /* ignore */ }
    }
    state.evidenceDebt = state.evidenceDebt.filter((item) => item.envelopeId !== eventId);
  }

  async function retryPendingMirrors() {
    if (!state.proposal || !knowledgeClient) return [];
    const results = [];
    for (const event of listOutboxEvents(outboxRoot, state.proposal)) {
      if (state.mirroredEventIds.has(event.eventId)) continue;
      results.push(await mirrorEventAfterPersist(event));
    }
    return results;
  }

  async function appendEvent(eventType, payload = {}, at = now()) {
    if (!state.proposal || !state.projection) throw new Error("consumer has no active proposal");
    rejectUnauthorizedWindowsEvent(eventType);
    const occurredAt = nextOccurredAt(at);
    const event = createRepairEvent(state.proposal, state.projection, {
      eventType,
      actor: { role: "windows_consumer", id: actorId },
      occurredAt,
      payload,
    });
    const nextProjection = applyRepairEvent(state.proposal, state.projection, event, verifiers);
    await inject("before_event_append", { event, eventType });
    const eventPath = writeEventImpl(outboxRoot, state.proposal, event);
    state.projection = nextProjection;
    await inject("after_event_append", { event, eventPath });
    // Crash after durable event must not roll back claim/business projection.
    try {
      if (typeof afterEventPersist === "function") {
        await afterEventPersist({ event, eventPath, projection: state.projection });
      }
    } catch (error) {
      return {
        event,
        projection: state.projection,
        eventPath,
        occurredAt,
        mirror: { ok: false, deferred: true, error: error.message || String(error) },
        crashedAfterPersist: true,
      };
    }
    const mirror = await mirrorEventAfterPersist(event);
    return { event, projection: state.projection, eventPath, mirror, occurredAt };
  }

  function clearOrphanClaimLock(lockRef, lockPath, at) {
    const orphan = readJsonIfPresent(lockPath);
    if (!orphan || orphan.schemaId !== "xhs.repair-claim-lock.v1") return false;
    if (orphan.proposalId !== state.proposal.proposalId) return false;
    if (orphan.attempt !== state.projection.attempt + 1) return false;
    if (state.projection.status !== "proposed") return false;
    const expired = !orphan.expiresAt || Date.parse(toIsoMs(at)) >= Date.parse(orphan.expiresAt);
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
        && Date.parse(toIsoMs(at)) >= Date.parse(state.projection.claim.expiresAt);
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
    const claimedAt = nextOccurredAt(at);
    const ttlSeconds = state.proposal.policy.heartbeat.claimTtlSeconds;
    const expiresAt = new Date(Date.parse(claimedAt) + ttlSeconds * 1000).toISOString();
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

    await inject("before_claim_lock", { lockRef, lock });
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
      await inject("after_claim_lock", { lockRef, lock, acquired });
    } catch (error) {
      return {
        ok: false,
        reason: error.message || "CRASH_AFTER_CLAIM_LOCK",
        lockRef,
        lockSha256: acquired.sha256,
        orphanLock: true,
        error,
      };
    }

    try {
      const appended = await appendEvent("claim", {
        expiresAt,
        lockRef,
        lockSha256: acquired.sha256,
      }, claimedAt);
      // Durable claim event succeeded — never report unclaimed because mirror/receipt failed.
      return {
        ok: true,
        resumed: false,
        event: appended.event,
        projection: state.projection,
        eventPath: appended.eventPath,
        lockRef,
        lockSha256: acquired.sha256,
        mirror: appended.mirror,
        crashedAfterPersist: appended.crashedAfterPersist || false,
      };
    } catch (error) {
      // Re-read outbox: if claim event landed, claim is durable despite later failures.
      state.projection = recoverProjection(state.proposal);
      if (state.projection.status !== "proposed" && state.projection.claim?.holder === actorId) {
        return {
          ok: true,
          resumed: false,
          projection: state.projection,
          lockRef,
          lockSha256: acquired.sha256,
          mirror: { ok: false, deferred: true },
          recoveredAfterError: true,
        };
      }
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
    retryPendingMirrors,
    recoverFromOutbox() {
      if (!state.proposal) throw new Error("load proposal before recover");
      state.projection = recoverProjection(state.proposal);
      hydrateMirrorStateFromOutbox();
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
        && Date.parse(toIsoMs(at)) >= Date.parse(state.projection.claim.expiresAt)
      ) {
        await appendEvent("claim_expired", {}, at);
      }
      return tryClaim({ at });
    },
    async heartbeat({ at = now() } = {}) {
      const heartbeatAt = nextOccurredAt(at);
      const ttlSeconds = state.proposal.policy.heartbeat.claimTtlSeconds;
      const expiresAt = new Date(Date.parse(heartbeatAt) + ttlSeconds * 1000).toISOString();
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
      }, heartbeatAt);
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
      await inject("before_checkpoint_write", { outboxRef, checkpoint });
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
      await inject("after_checkpoint_write", { outboxRef, written });
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
