/**
 * Windows Repair Inbox — minimal discovery front door for backlog repair proposals.
 *
 * Reuses registry knowledge + repair consumer + sealed outbox.
 * Default mode is read-only list/discover. Claim requires an explicit opt-in.
 * Never self-approves, marks deployable, deploys, replays, or touches devices.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  assertProposalReadyForClaim,
  createKnowledgeClient,
  createRepairConsumer,
  parseKnowledgeProposal,
} from "./repair-consumer.mjs";
import {
  REQUIRED_FORBIDDEN_PATHS,
  isAllowedRepairPath,
  proposalSha256,
  scanForSecrets,
  validateRepairProposal,
} from "./repair-proposal.mjs";

export const INBOX_SCHEMA = "xhs.repair-inbox.v1";
export const WINDOWS_CANNOT = Object.freeze([
  "self_approve",
  "modify_review_verdict",
  "write_mac",
  "mark_deployable",
  "deploy",
  "replay",
  "submit_job_or_session",
  "operate_device",
]);

/**
 * Offline-only knowledge client. Never calls fetch / network.
 * Used whenever fixtureItems are supplied so tests cannot leak into live registry.
 */
export function createFixtureKnowledgeClient(fixtureItems) {
  if (!Array.isArray(fixtureItems)) throw new Error("fixtureItems array required");
  const backlog = () => fixtureItems.filter((item) => item && item.needsEngineer === true && item.lifecycle === "backlog");
  return {
    mode: "fixture-only",
    async listRepairKnowledgeItems() {
      return backlog();
    },
    async listRepairProposals() {
      return backlog().map((item) => parseKnowledgeProposal(item)).filter(Boolean);
    },
    async postKnowledge() {
      return {
        ok: false,
        debt: true,
        skipped: true,
        code: "FIXTURE_ONLY_NO_NETWORK",
      };
    },
    async getKnowledge(id) {
      const hit = backlog().find((item) => {
        if (item.id === id) return true;
        const proposal = parseKnowledgeProposal(item);
        return proposal?.proposalId === id;
      });
      if (!hit) return { ok: false, status: 404, knowledge: null };
      return { ok: true, status: 200, knowledge: hit };
    },
  };
}

/**
 * Resolve the knowledge client for inbox operations.
 * fixtureItems ⇒ always fixture-only (never fall back to live registry).
 * Otherwise require an explicit client or liveKnowledge opt-in.
 */
export function resolveInboxKnowledgeClient({
  knowledgeClient = null,
  fixtureItems = null,
  liveKnowledge = false,
  endpoint = "http://127.0.0.1:17930",
  fetchImpl = globalThis.fetch,
} = {}) {
  if (Array.isArray(fixtureItems)) {
    return createFixtureKnowledgeClient(fixtureItems);
  }
  if (knowledgeClient) return knowledgeClient;
  if (liveKnowledge) return createKnowledgeClient({ endpoint, fetchImpl });
  throw new Error("knowledgeClient or fixtureItems required (refusing implicit live registry client)");
}

function sha256Hex(bytesOrString) {
  return createHash("sha256").update(bytesOrString).digest("hex");
}

/**
 * Full inbox gate: contract + hash + skill binding + allow/forbid paths + secrets.
 * Does not claim. Optional skillsRoot verifies binding bytes when the Skill file exists.
 */
export function validateInboxCandidate(knowledgeItem, {
  expectedProposalId = null,
  expectedProposalSha256 = null,
  expectedBaseCommit = null,
  skillsRoot = null,
} = {}) {
  const errors = [];
  if (!knowledgeItem || typeof knowledgeItem !== "object") {
    return { ok: false, errors: ["knowledge item missing"], proposal: null, proposalSha256: null };
  }
  if (knowledgeItem.needsEngineer !== true) errors.push("needsEngineer must be true");
  if (knowledgeItem.lifecycle !== "backlog") errors.push("lifecycle must be backlog");
  const appliesTo = Array.isArray(knowledgeItem.appliesTo) ? knowledgeItem.appliesTo : [];
  if (!appliesTo.includes("repair-proposal-v1")) errors.push("appliesTo must include repair-proposal-v1");

  const proposal = parseKnowledgeProposal(knowledgeItem);
  if (!proposal) {
    return { ok: false, errors: [...errors, "content is not xhs.repair-proposal.v1"], proposal: null, proposalSha256: null };
  }

  const schema = validateRepairProposal(proposal);
  if (!schema.ok) errors.push(...schema.errors.map((e) => `schema: ${e}`));

  let digest = null;
  try {
    const ready = assertProposalReadyForClaim(proposal, {
      expectedProposalId,
      expectedProposalSha256,
      expectedBaseCommit,
    });
    digest = ready.proposalSha256;
  } catch (error) {
    errors.push(error.message);
    digest = proposalSha256(proposal);
  }

  const binding = proposal.target?.skillBinding;
  if (!binding || typeof binding !== "object") {
    errors.push("target.skillBinding required for inbox");
  } else {
    if (!binding.path || !binding.version || !binding.sourceSha256) {
      errors.push("skillBinding must include path, version, sourceSha256");
    } else if (!isAllowedRepairPath(binding.path, {
      allowedPaths: ["**"],
      forbiddenPaths: proposal.policy?.forbiddenPaths || REQUIRED_FORBIDDEN_PATHS,
    })) {
      // Skill binding path itself must not land in forbidden globs (e.g. skills/SKILL.md).
      errors.push(`skillBinding.path hits forbidden policy: ${binding.path}`);
    }
    if (skillsRoot && binding?.path) {
      const skillFile = resolve(skillsRoot, binding.path);
      if (!existsSync(skillFile)) {
        errors.push(`skillBinding file missing under skillsRoot: ${binding.path}`);
      } else {
        const actual = sha256Hex(readFileSync(skillFile));
        if (actual !== binding.sourceSha256) {
          errors.push(`skillBinding.sourceSha256 mismatch for ${binding.path}`);
        }
      }
    }
  }

  const allowed = proposal.policy?.allowedPaths || [];
  const forbidden = proposal.policy?.forbiddenPaths || [];
  if (!allowed.length) errors.push("policy.allowedPaths empty");
  for (const required of REQUIRED_FORBIDDEN_PATHS) {
    if (!forbidden.includes(required)) errors.push(`missing required forbidden path: ${required}`);
  }
  for (const path of allowed) {
    if (!isAllowedRepairPath(path, proposal.policy)) {
      errors.push(`allowedPath also forbidden or invalid: ${path}`);
    }
  }

  const secrets = scanForSecrets(proposal);
  if (secrets.length) errors.push(...secrets.map((s) => `secret material: ${s}`));

  const windowsCannot = proposal.policy?.authorities?.windowsCannot || [];
  for (const required of [
    "self_approve",
    "write_mac",
    "modify_review_verdict",
    "deploy_without_authority",
    "operate_device_without_authority",
  ]) {
    if (!windowsCannot.includes(required)) {
      errors.push(`authorities.windowsCannot missing ${required}`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    proposal,
    proposalSha256: digest,
    knowledgeId: knowledgeItem.id || proposal?.proposalId || null,
    skillBinding: binding || null,
    findingSummary: proposal?.finding?.summary || null,
    capabilityId: proposal?.target?.capabilityId || null,
    status: proposal?.status || null,
  };
}

export function summarizeInboxEntry(validated) {
  return {
    proposalId: validated.proposal?.proposalId || null,
    proposalSha256: validated.proposalSha256,
    knowledgeId: validated.knowledgeId,
    status: validated.status,
    capabilityId: validated.capabilityId,
    findingSummary: validated.findingSummary,
    skillBinding: validated.skillBinding,
    outboxNamespace: validated.proposal?.transport?.outboxNamespace || null,
    baseCommit: validated.proposal?.target?.baseCommit || null,
    ok: validated.ok,
    errors: validated.errors,
  };
}

/**
 * Read-only discover: query registry backlog + needsEngineer, validate each candidate.
 */
export async function discoverRepairInbox({
  knowledgeClient,
  expectedProposalId = null,
  expectedProposalSha256 = null,
  expectedBaseCommit = null,
  skillsRoot = null,
  fixtureItems = null,
} = {}) {
  let items;
  if (Array.isArray(fixtureItems)) {
    items = fixtureItems.filter((item) => item && item.needsEngineer === true && item.lifecycle === "backlog");
  } else {
    if (!knowledgeClient?.listRepairKnowledgeItems) {
      throw new Error("knowledgeClient.listRepairKnowledgeItems required");
    }
    items = await knowledgeClient.listRepairKnowledgeItems();
  }

  const entries = [];
  for (const item of items) {
    const validated = validateInboxCandidate(item, {
      expectedProposalId: expectedProposalId && item.id === expectedProposalId ? expectedProposalId : null,
      expectedProposalSha256: expectedProposalId && item.id === expectedProposalId ? expectedProposalSha256 : null,
      expectedBaseCommit: expectedProposalId && item.id === expectedProposalId ? expectedBaseCommit : null,
      skillsRoot,
    });
    // When filtering for a specific id, skip non-matches without failing the whole inbox.
    if (expectedProposalId && (item.id !== expectedProposalId && validated.proposal?.proposalId !== expectedProposalId)) {
      continue;
    }
    entries.push(summarizeInboxEntry(validated));
  }

  if (expectedProposalId) {
    const hit = entries.find((e) => e.proposalId === expectedProposalId);
    if (!hit) {
      return {
        schemaId: INBOX_SCHEMA,
        mode: "discover",
        ok: false,
        reason: "PROPOSAL_NOT_IN_INBOX",
        count: 0,
        entries: [],
        actionsPerformed: ["discover"],
        actionsNotPerformed: ["claim", ...WINDOWS_CANNOT],
      };
    }
    if (expectedProposalSha256 && hit.proposalSha256 !== expectedProposalSha256) {
      return {
        schemaId: INBOX_SCHEMA,
        mode: "discover",
        ok: false,
        reason: "PROPOSAL_HASH_MISMATCH",
        count: entries.length,
        entries,
        actionsPerformed: ["discover"],
        actionsNotPerformed: ["claim", ...WINDOWS_CANNOT],
      };
    }
  }

  const allValid = entries.filter((e) => e.ok);
  const anyInvalid = entries.some((e) => !e.ok);
  let ok = false;
  let reason = null;
  if (entries.length === 0) {
    reason = "INBOX_EMPTY";
  } else if (expectedProposalId) {
    ok = Boolean(allValid.find((e) => e.proposalId === expectedProposalId));
    reason = ok ? null : "INBOX_VALIDATION_FAILED";
  } else {
    // Batch discover: surface valid entries; ok when at least one candidate validates.
    ok = allValid.length > 0;
    reason = ok ? (anyInvalid ? "INBOX_PARTIAL" : null) : "INBOX_VALIDATION_FAILED";
  }
  return {
    schemaId: INBOX_SCHEMA,
    mode: "discover",
    ok,
    reason,
    count: entries.length,
    validCount: allValid.length,
    entries,
    actionsPerformed: ["discover"],
    actionsNotPerformed: ["claim", "heartbeat", "start_fixing", "source_checkpoint", ...WINDOWS_CANNOT],
    note: "Ordinary Skills describe how to run a capability; Repair Inbox decides what to fix now. Do not hardcode proposalId into capability Skills.",
  };
}

/**
 * Explicit claim path. Hands off to existing repair consumer after inbox validation.
 * Live callers (no fixture / liveKnowledge=true) must supply checkpoint before any
 * outbox or knowledge mutation; the CLI enforces this before mkdirSync as well.
 * Offline fixture may omit checkpoint only for lock/restart unit tests — those
 * paths return ok:false with SOURCE_CHECKPOINT_REQUIRED after fixing and never
 * pretend source_review readiness.
 */
export async function claimRepairInbox({
  knowledgeClient,
  outboxRoot,
  actorId,
  proposalId,
  claimAuthorized = false,
  expectedProposalSha256 = null,
  expectedBaseCommit = null,
  skillsRoot = null,
  checkpoint = null,
  at = new Date(),
  fixtureItems = null,
  liveKnowledge = false,
} = {}) {
  if (!claimAuthorized) {
    return {
      schemaId: INBOX_SCHEMA,
      mode: "claim",
      ok: false,
      reason: "CLAIM_NOT_AUTHORIZED",
      hint: "Pass --i-understand-claim (or claimAuthorized:true). Default Repair Inbox is read-only discover.",
      actionsPerformed: [],
      actionsNotPerformed: ["claim", "heartbeat", "start_fixing", "source_checkpoint", ...WINDOWS_CANNOT],
    };
  }
  if (!proposalId) throw new Error("proposalId required for claim");
  if (!outboxRoot) throw new Error("outboxRoot required for claim");
  if (!actorId) throw new Error("actorId required for claim");

  // Live claim must supply a real checkpoint before any outbox/knowledge mutation.
  if (liveKnowledge && !checkpoint) {
    return {
      schemaId: INBOX_SCHEMA,
      mode: "claim",
      ok: false,
      reason: "SOURCE_CHECKPOINT_REQUIRED",
      hint: "Live claim requires --checkpoint <real.json> before any claim/outbox writes. Demo/fake checkpoints are forbidden.",
      proposalId,
      actionsPerformed: [],
      actionsNotPerformed: ["discover", "claim", "heartbeat", "start_fixing", "source_checkpoint", ...WINDOWS_CANNOT],
      liveKnowledge,
    };
  }

  // fixtureItems always win: never fall back to createKnowledgeClient() / live registry.
  const resolvedClient = resolveInboxKnowledgeClient({
    knowledgeClient,
    fixtureItems,
    liveKnowledge,
  });

  const discovered = await discoverRepairInbox({
    knowledgeClient: resolvedClient,
    expectedProposalId: proposalId,
    expectedProposalSha256,
    expectedBaseCommit,
    skillsRoot,
    fixtureItems,
  });
  const entry = discovered.entries.find((e) => e.proposalId === proposalId);
  if (!entry?.ok) {
    return {
      schemaId: INBOX_SCHEMA,
      mode: "claim",
      ok: false,
      reason: discovered.reason || "INBOX_VALIDATION_FAILED",
      entries: discovered.entries,
      actionsPerformed: ["discover"],
      actionsNotPerformed: ["claim", ...WINDOWS_CANNOT],
    };
  }

  const consumer = createRepairConsumer({
    outboxRoot,
    actorId,
    knowledgeClient: resolvedClient,
  });
  const actionsPerformed = ["discover"];
  await consumer.discoverAndSelect({
    expectedProposalId: proposalId,
    expectedProposalSha256: entry.proposalSha256,
    expectedBaseCommit: expectedBaseCommit || entry.baseCommit,
  });

  const claim = await consumer.ensureClaim({ at });
  if (!claim.ok) {
    return {
      schemaId: INBOX_SCHEMA,
      mode: "claim",
      ok: false,
      reason: claim.reason || "CLAIM_FAILED",
      proposalId,
      proposalSha256: entry.proposalSha256,
      status: consumer.projection.status,
      actionsPerformed,
      actionsNotPerformed: [...WINDOWS_CANNOT],
      liveKnowledge,
    };
  }
  actionsPerformed.push(claim.resumed ? "resume_claim" : "claim");

  const heartbeatAt = new Date(Date.parse(at.toISOString?.() ? at.toISOString() : at) + 60_000);
  await consumer.heartbeat({ at: heartbeatAt });
  actionsPerformed.push("heartbeat");
  const fixingAt = new Date(Date.parse(heartbeatAt.toISOString()) + 60_000);
  await consumer.startFixing({ at: fixingAt });
  actionsPerformed.push("start_fixing");

  if (!checkpoint) {
    return {
      schemaId: INBOX_SCHEMA,
      mode: "claim",
      ok: false,
      reason: "SOURCE_CHECKPOINT_REQUIRED",
      proposalId,
      proposalSha256: entry.proposalSha256,
      status: consumer.projection.status,
      attempt: consumer.projection.attempt,
      lockRef: claim.lockRef || consumer.projection.claim?.lockRef || null,
      resumed: Boolean(claim.resumed),
      waitingFor: "source_checkpoint_then_mac_review",
      evidenceDebt: consumer.evidenceDebt || [],
      actionsPerformed,
      actionsNotPerformed: ["source_checkpoint", ...WINDOWS_CANNOT],
      liveKnowledge,
    };
  }

  const sealed = await consumer.sealSourceCheckpoint(checkpoint, {
    at: new Date(Date.parse(fixingAt.toISOString()) + 60_000),
  });
  actionsPerformed.push("source_checkpoint");
  const stop = consumer.assertStoppedForMacReview();

  return {
    schemaId: INBOX_SCHEMA,
    mode: "claim",
    ok: true,
    proposalId,
    proposalSha256: entry.proposalSha256,
    status: stop.status,
    attempt: consumer.projection.attempt,
    lockRef: claim.lockRef || consumer.projection.claim?.lockRef || null,
    resumed: Boolean(claim.resumed),
    sourceCheckpoint: {
      outboxRef: sealed.checkpoint.outboxRef,
      bundleSha256: sealed.checkpoint.bundleSha256,
    },
    waitingFor: stop.waitingFor,
    evidenceDebt: consumer.evidenceDebt || [],
    actionsPerformed,
    actionsNotPerformed: [...WINDOWS_CANNOT],
    note: "Stop at source_review after checkpoint. Mac independent review required before deployable/replay.",
    liveKnowledge,
  };
}

export function createRepairInbox({
  endpoint = "http://127.0.0.1:17930",
  knowledgeClient = null,
  fetchImpl = globalThis.fetch,
  fixtureItems = null,
} = {}) {
  const client = resolveInboxKnowledgeClient({
    knowledgeClient,
    fixtureItems,
    liveKnowledge: !fixtureItems,
    endpoint,
    fetchImpl,
  });
  return {
    knowledgeClient: client,
    discover(opts = {}) {
      const nextFixtures = opts.fixtureItems ?? fixtureItems;
      return discoverRepairInbox({
        knowledgeClient: resolveInboxKnowledgeClient({
          knowledgeClient: opts.knowledgeClient || client,
          fixtureItems: nextFixtures,
          liveKnowledge: !nextFixtures,
          endpoint,
          fetchImpl,
        }),
        ...opts,
        fixtureItems: nextFixtures,
      });
    },
    claim(opts = {}) {
      const nextFixtures = opts.fixtureItems ?? fixtureItems;
      return claimRepairInbox({
        ...opts,
        fixtureItems: nextFixtures,
        knowledgeClient: resolveInboxKnowledgeClient({
          knowledgeClient: opts.knowledgeClient || client,
          fixtureItems: nextFixtures,
          liveKnowledge: opts.liveKnowledge ?? !nextFixtures,
          endpoint,
          fetchImpl,
        }),
      });
    },
  };
}
