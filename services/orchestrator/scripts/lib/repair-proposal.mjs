import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

export const REPAIR_STATUSES = Object.freeze([
  "proposed",
  "claimed",
  "fixing",
  "source_review",
  "approved",
  "request_changes",
  "deployable",
  "replaying",
  "completed",
  "failed",
  "cancelled",
]);

export const REPAIR_EVENT_TYPES = Object.freeze([
  "claim",
  "heartbeat",
  "start_fixing",
  "source_checkpoint",
  "review_approved",
  "review_request_changes",
  "mark_deployable",
  "start_replay",
  "complete",
  "attempt_failed",
  "fail",
  "claim_expired",
  "cancel",
]);

export const REQUIRED_FORBIDDEN_PATHS = Object.freeze([
  "skills/SKILL.md",
  "registry.mjs",
  "control.db",
  "**/control.db",
  "**/*payment*",
  "**/*approval*",
  "**/*standing-grant*",
  "**/*auth*",
  "**/*token*",
  "**/*secret*",
  "install-registry-task.ps1",
  "task-launch.json",
]);

const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const ACTIVE_CLAIM = new Set(["claimed", "fixing", "request_changes"]);
const WINDOWS_EVENTS = new Set([
  "claim",
  "heartbeat",
  "start_fixing",
  "source_checkpoint",
  "start_replay",
  "complete",
  "attempt_failed",
  "fail",
  "claim_expired",
]);
const MAC_EVENTS = new Set([
  "review_approved",
  "review_request_changes",
  "mark_deployable",
  "cancel",
]);

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value) {
  return createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : canonicalJson(value)).digest("hex");
}

export function repairIdempotencyKey({ source, finding, target, policy, supersession }) {
  const stable = {
    schemaId: "xhs.repair-proposal.v1",
    source: clone(source),
    finding: clone(finding),
    target: clone(target),
    policy: clone(policy),
    supersedes: [...(supersession?.supersedes ?? [])].sort(),
  };
  return `repair:${sha256(stable)}`;
}

export function createRepairProposal(input, { now = () => new Date().toISOString() } = {}) {
  const createdAt = input.createdAt ?? now();
  const policy = normalizePolicy(input.policy);
  const idempotencyKey = repairIdempotencyKey({ ...input, policy });
  const proposalId = input.proposalId ?? `repair_${idempotencyKey.slice("repair:".length, "repair:".length + 24)}`;
  const proposal = {
    schemaId: "xhs.repair-proposal.v1",
    schemaVersion: 1,
    proposalId,
    idempotencyKey,
    createdAt,
    status: "proposed",
    source: clone(input.source),
    target: clone(input.target),
    finding: clone(input.finding),
    policy,
    attempt: { current: 0, max: policy.limits.maxAttempts },
    claim: { holder: null, claimEventId: null, claimedAt: null, heartbeatAt: null, expiresAt: null, lockRef: null, lockSha256: null },
    supersession: {
      supersedes: [...(input.supersession?.supersedes ?? [])],
      supersededBy: input.supersession?.supersededBy ?? null,
    },
    circuitBreaker: {
      state: "closed",
      consecutiveFailures: 0,
      threshold: policy.circuitBreaker.failureThreshold,
      windowSeconds: policy.circuitBreaker.windowSeconds,
      openedAt: null,
      reason: null,
    },
    transport: {
      discovery: "registry.knowledge",
      updates: "registry.knowledge+sealed_outbox",
      knowledgeId: proposalId,
      outboxNamespace: `repair/${proposalId}`,
    },
  };
  const validation = validateRepairProposal(proposal);
  if (!validation.ok) throw new Error(`repair proposal invalid: ${validation.errors.join("; ")}`);
  return proposal;
}

function normalizePolicy(policy = {}) {
  const limits = policy.limits ?? {};
  const heartbeat = policy.heartbeat ?? {};
  const circuitBreaker = policy.circuitBreaker ?? {};
  return {
    lane: "source_only",
    effectClass: "none",
    evidenceFailureMode: "debt_only",
    allowedChangeKinds: [...(policy.allowedChangeKinds ?? [])],
    allowedPaths: [...(policy.allowedPaths ?? [])],
    forbiddenPaths: [...new Set([...(policy.forbiddenPaths ?? []), ...REQUIRED_FORBIDDEN_PATHS])],
    acceptanceConditions: [...(policy.acceptanceConditions ?? [])],
    prohibitions: [...(policy.prohibitions ?? [])],
    limits: {
      maxFiles: limits.maxFiles ?? 8,
      maxDiffLines: limits.maxDiffLines ?? 500,
      maxAttempts: limits.maxAttempts ?? 3,
    },
    heartbeat: {
      intervalSeconds: heartbeat.intervalSeconds ?? 60,
      claimTtlSeconds: heartbeat.claimTtlSeconds ?? 900,
    },
    circuitBreaker: {
      failureThreshold: circuitBreaker.failureThreshold ?? 2,
      windowSeconds: circuitBreaker.windowSeconds ?? 3600,
    },
    authorities: {
      windows: ["claim", "heartbeat", "fix", "source_checkpoint", "completion_bundle"],
      mac: ["source_review", "review_verdict", "deployable", "cancel"],
      windowsCannot: ["self_approve", "write_mac", "modify_review_verdict", "deploy_without_authority", "operate_device_without_authority"],
      macCannot: ["operate_device", "submit_job_or_session", "deploy_windows"],
    },
  };
}

export function validateRepairProposal(proposal) {
  const errors = [];
  requireExactKeys(proposal, ["schemaId", "schemaVersion", "proposalId", "idempotencyKey", "createdAt", "status", "source", "target", "finding", "policy", "attempt", "claim", "supersession", "circuitBreaker", "transport"], "proposal", errors);
  if (proposal?.schemaId !== "xhs.repair-proposal.v1" || proposal?.schemaVersion !== 1) errors.push("schema must be xhs.repair-proposal.v1@1");
  if (!/^repair_[0-9a-f]{24}$/.test(proposal?.proposalId ?? "")) errors.push("proposalId must be repair_<24hex>");
  if (!/^repair:[0-9a-f]{64}$/.test(proposal?.idempotencyKey ?? "")) errors.push("idempotencyKey must be repair:<sha256>");
  if (proposal?.proposalId !== `repair_${String(proposal?.idempotencyKey ?? "").slice("repair:".length, "repair:".length + 24)}`) errors.push("proposalId must derive from idempotencyKey");
  if (!validIso(proposal?.createdAt)) errors.push("createdAt must be an ISO date-time");
  if (proposal?.status !== "proposed") errors.push("immutable proposal initial status must be proposed");
  requireExactKeys(proposal?.source, ["bundleId", "manifestSha256", "primaryRunId", "runIds", "producerCommit", "releaseId", "review"], "source", errors);
  if (!nonEmpty(proposal?.source?.bundleId)) errors.push("source.bundleId required");
  if (!SHA256.test(proposal?.source?.manifestSha256 ?? "")) errors.push("source.manifestSha256 must be sha256");
  if (!SHA40.test(proposal?.source?.producerCommit ?? "")) errors.push("source.producerCommit must be full git sha");
  if (!(proposal?.source?.releaseId === null || nonEmpty(proposal?.source?.releaseId))) errors.push("source.releaseId must be a string or null");
  const runIds = proposal?.source?.runIds;
  if (!Array.isArray(runIds) || runIds.length < 1 || new Set(runIds).size !== runIds.length || runIds.some((id) => !String(id).startsWith("run_"))) errors.push("source.runIds must contain unique run_ ids");
  if (!String(proposal?.source?.primaryRunId ?? "").startsWith("run_") || !runIds?.includes(proposal.source.primaryRunId)) errors.push("source.primaryRunId must be included in runIds");
  requireExactKeys(proposal?.source?.review, ["reviewId", "receiptSha256", "reviewedAt", "disposition"], "source.review", errors);
  if (!nonEmpty(proposal?.source?.review?.reviewId) || !SHA256.test(proposal?.source?.review?.receiptSha256 ?? "") || !validIso(proposal?.source?.review?.reviewedAt)) errors.push("source.review must bind reviewId, receiptSha256 and reviewedAt");
  if (!["repairable_debt", "request_changes", "approved_with_debt"].includes(proposal?.source?.review?.disposition)) errors.push("source.review.disposition invalid");
  requireExactKeys(proposal?.target, ["repository", "branch", "baseCommit", "app", "capabilityId", "skillBinding"], "target", errors, { optional: ["skillBinding"] });
  if (![proposal?.target?.repository, proposal?.target?.branch, proposal?.target?.app, proposal?.target?.capabilityId].every(nonEmpty)) errors.push("target repository/branch/app/capabilityId required");
  if (!SHA40.test(proposal?.target?.baseCommit ?? "")) errors.push("target.baseCommit must be full git sha");
  if (proposal?.target?.skillBinding !== undefined) {
    requireExactKeys(proposal.target.skillBinding, ["path", "version", "sourceSha256"], "target.skillBinding", errors);
    if (!safeRepoPath(proposal.target.skillBinding?.path) || !nonEmpty(proposal.target.skillBinding?.version) || !SHA256.test(proposal.target.skillBinding?.sourceSha256 ?? "")) errors.push("target.skillBinding invalid");
  }
  requireExactKeys(proposal?.finding, ["findingId", "code", "severity", "summary", "repairable", "evidenceRefs", "observed", "evidenceDebt"], "finding", errors);
  if (proposal?.finding?.repairable !== true || !nonEmpty(proposal?.finding?.findingId) || !/^[A-Z0-9_]+$/.test(proposal?.finding?.code ?? "") || !["low", "medium", "high"].includes(proposal?.finding?.severity) || !nonEmpty(proposal?.finding?.summary)) errors.push("finding identity/severity/summary/repairable invalid");
  if (!nonEmptyStringArray(proposal?.finding?.evidenceRefs) || !plainObject(proposal?.finding?.observed) || !objectArray(proposal?.finding?.evidenceDebt)) errors.push("finding evidenceRefs/observed/evidenceDebt invalid");
  requireExactKeys(proposal?.policy, ["lane", "effectClass", "evidenceFailureMode", "allowedChangeKinds", "allowedPaths", "forbiddenPaths", "acceptanceConditions", "prohibitions", "limits", "heartbeat", "circuitBreaker", "authorities"], "policy", errors);
  if (proposal?.policy?.lane !== "source_only" || proposal?.policy?.effectClass !== "none" || proposal?.policy?.evidenceFailureMode !== "debt_only") errors.push("policy lane/effect/debt mode invalid");
  if (!Array.isArray(proposal?.policy?.allowedPaths) || proposal.policy.allowedPaths.length < 1) errors.push("policy.allowedPaths must be explicit");
  if (!Array.isArray(proposal?.policy?.allowedChangeKinds) || proposal.policy.allowedChangeKinds.length < 1) errors.push("policy.allowedChangeKinds must be explicit");
  for (const [label, items] of [["allowedChangeKinds", proposal?.policy?.allowedChangeKinds], ["allowedPaths", proposal?.policy?.allowedPaths], ["forbiddenPaths", proposal?.policy?.forbiddenPaths]]) {
    if (!nonEmptyStringArray(items) || new Set(items).size !== items.length) errors.push(`policy.${label} must contain unique non-empty strings`);
  }
  if (!nonEmptyStringArray(proposal?.policy?.acceptanceConditions)) errors.push("acceptanceConditions must be explicit");
  if (!nonEmptyStringArray(proposal?.policy?.prohibitions)) errors.push("prohibitions must be explicit");
  for (const path of proposal?.policy?.allowedPaths ?? []) if (!safePolicyGlob(path)) errors.push(`unsafe allowed path: ${path}`);
  for (const path of proposal?.policy?.forbiddenPaths ?? []) if (!safePolicyGlob(path)) errors.push(`unsafe forbidden path: ${path}`);
  for (const required of REQUIRED_FORBIDDEN_PATHS) {
    if (!(proposal?.policy?.forbiddenPaths ?? []).includes(required)) errors.push(`missing required forbidden path: ${required}`);
  }
  const limits = proposal?.policy?.limits ?? {};
  requireExactKeys(limits, ["maxFiles", "maxDiffLines", "maxAttempts"], "policy.limits", errors);
  if (!positiveInt(limits.maxFiles) || limits.maxFiles > 20) errors.push("maxFiles must be 1..20");
  if (!positiveInt(limits.maxDiffLines) || limits.maxDiffLines > 2000) errors.push("maxDiffLines must be 1..2000");
  if (!positiveInt(limits.maxAttempts) || limits.maxAttempts > 5) errors.push("maxAttempts must be 1..5");
  const heartbeat = proposal?.policy?.heartbeat ?? {};
  requireExactKeys(heartbeat, ["intervalSeconds", "claimTtlSeconds"], "policy.heartbeat", errors);
  if (!positiveInt(heartbeat.intervalSeconds) || heartbeat.intervalSeconds < 15 || heartbeat.intervalSeconds > 600
    || !positiveInt(heartbeat.claimTtlSeconds) || heartbeat.claimTtlSeconds < 60 || heartbeat.claimTtlSeconds > 7200
    || heartbeat.claimTtlSeconds < heartbeat.intervalSeconds * 2) errors.push("heartbeat/claim TTL outside contract bounds");
  requireExactKeys(proposal?.policy?.circuitBreaker, ["failureThreshold", "windowSeconds"], "policy.circuitBreaker", errors);
  if (!positiveInt(proposal?.policy?.circuitBreaker?.failureThreshold) || proposal.policy.circuitBreaker.failureThreshold > 5
    || !positiveInt(proposal?.policy?.circuitBreaker?.windowSeconds) || proposal.policy.circuitBreaker.windowSeconds < 60
    || proposal.policy.circuitBreaker.windowSeconds > 86400) errors.push("policy circuit breaker invalid");
  requireExactKeys(proposal?.policy?.authorities, ["windows", "mac", "windowsCannot", "macCannot"], "policy.authorities", errors);
  if (![proposal?.policy?.authorities?.windows, proposal?.policy?.authorities?.mac, proposal?.policy?.authorities?.windowsCannot, proposal?.policy?.authorities?.macCannot].every(nonEmptyStringArray)) errors.push("policy authorities invalid");
  requireExactKeys(proposal?.attempt, ["current", "max"], "attempt", errors);
  if (proposal?.attempt?.current !== 0 || proposal?.attempt?.max !== limits.maxAttempts) errors.push("initial attempt must be 0 and match policy maxAttempts");
  requireExactKeys(proposal?.claim, ["holder", "claimEventId", "claimedAt", "heartbeatAt", "expiresAt", "lockRef", "lockSha256"], "claim", errors);
  if (["holder", "claimEventId", "claimedAt", "heartbeatAt", "expiresAt", "lockRef", "lockSha256"].some((key) => proposal?.claim?.[key] !== null)) errors.push("initial claim fields must be null");
  const expectedKey = repairIdempotencyKey(proposal);
  if (proposal?.idempotencyKey !== expectedKey) errors.push("idempotencyKey does not match proposal binding");
  requireExactKeys(proposal?.transport, ["discovery", "updates", "knowledgeId", "outboxNamespace"], "transport", errors);
  if (proposal?.transport?.discovery !== "registry.knowledge" || proposal?.transport?.updates !== "registry.knowledge+sealed_outbox" || proposal?.transport?.knowledgeId !== proposal?.proposalId || proposal?.transport?.outboxNamespace !== `repair/${proposal?.proposalId}`) errors.push("transport identifiers must bind proposalId and existing transports");
  requireExactKeys(proposal?.supersession, ["supersedes", "supersededBy"], "supersession", errors);
  const supersedes = proposal?.supersession?.supersedes ?? [];
  if (!Array.isArray(supersedes) || new Set(supersedes).size !== supersedes.length || supersedes.some((id) => !/^repair_[0-9a-f]{24}$/.test(id) || id === proposal?.proposalId)) errors.push("supersession.supersedes must contain unique prior proposal ids");
  if (proposal?.supersession?.supersededBy !== null) errors.push("immutable new proposal must start with supersededBy=null; supersession is an append-only cancel event");
  requireExactKeys(proposal?.circuitBreaker, ["state", "consecutiveFailures", "threshold", "windowSeconds", "openedAt", "reason"], "circuitBreaker", errors);
  if (proposal?.circuitBreaker?.state !== "closed" || proposal?.circuitBreaker?.consecutiveFailures !== 0 || proposal?.circuitBreaker?.threshold !== proposal?.policy?.circuitBreaker?.failureThreshold || proposal?.circuitBreaker?.windowSeconds !== proposal?.policy?.circuitBreaker?.windowSeconds || proposal?.circuitBreaker?.openedAt !== null || proposal?.circuitBreaker?.reason !== null) errors.push("initial circuit breaker invalid");
  errors.push(...scanForSecrets(proposal).map((item) => `secret material rejected at ${item}`));
  return { ok: errors.length === 0, errors };
}

export function proposalSha256(proposal) {
  return sha256(proposal);
}

export function initialRepairProjection(proposal) {
  const validation = validateRepairProposal(proposal);
  if (!validation.ok) throw new Error(`repair proposal invalid: ${validation.errors.join("; ")}`);
  return {
    proposalId: proposal.proposalId,
    proposalSha256: proposalSha256(proposal),
    status: "proposed",
    attempt: 0,
    claim: clone(proposal.claim),
    circuitBreaker: clone(proposal.circuitBreaker),
    failureTimestamps: [],
    lastSourceCheckpoint: null,
    lastReviewEvent: null,
    lastReviewAuthority: null,
    approvedEventId: null,
    deployableEventId: null,
    deployableResultCommit: null,
    replayAuthorizationRef: null,
    replayAuthorizationSha256: null,
    replayAuthorizationCommit: null,
    eventIds: [],
    eventDigests: {},
    lastOccurredAt: null,
  };
}

export function applyRepairEvent(proposal, projection, event, {
  verifyClaimLock,
  verifyMacReviewAuthority,
  verifyReplayAuthorization,
  verifyCompletionBundle,
} = {}) {
  const current = clone(projection);
  const eventDigest = sha256(event);
  if (current.eventDigests?.[event?.eventId]) {
    if (current.eventDigests[event.eventId] !== eventDigest) throw new Error("repair event invalid: eventId collision");
    return current;
  }
  const errors = validateEventBinding(proposal, current, event);
  if (errors.length) throw new Error(`repair event invalid: ${errors.join("; ")}`);
  if (current.lastOccurredAt && Date.parse(event.occurredAt) < Date.parse(current.lastOccurredAt)) throw new Error("repair event invalid: occurredAt is older than projection");

  const payload = event.payload ?? {};
  const occurredAt = event.occurredAt;
  switch (event.eventType) {
    case "claim": {
      if (current.circuitBreaker.state !== "closed") throw new Error("repair event invalid: circuit breaker is open");
      if (current.status !== "proposed") throw new Error(`repair event invalid: claim from ${current.status}`);
      const nextAttempt = current.attempt + 1;
      if (nextAttempt > proposal.attempt.max) throw new Error("repair event invalid: max attempts exceeded");
      const expectedLockRef = `${proposal.transport.outboxNamespace}/attempt-${nextAttempt}/claim.lock`;
      if (payload.lockRef !== expectedLockRef || !SHA256.test(payload.lockSha256 ?? "")) throw new Error("repair event invalid: claim must bind the exclusive outbox lock");
      if (typeof verifyClaimLock !== "function" || verifyClaimLock({ proposal, projection: current, event, lock: payload }) !== true) throw new Error("repair event invalid: claim lock is not trusted");
      current.status = "claimed";
      current.attempt = nextAttempt;
      current.claim = {
        holder: event.actor.id,
        claimEventId: event.eventId,
        claimedAt: occurredAt,
        heartbeatAt: occurredAt,
        expiresAt: boundedExpiry(payload.expiresAt, occurredAt, proposal.policy.heartbeat.claimTtlSeconds, "claim expiresAt"),
        lockRef: payload.lockRef,
        lockSha256: payload.lockSha256,
      };
      break;
    }
    case "heartbeat":
      assertClaimHolder(current, event);
      if (!ACTIVE_CLAIM.has(current.status)) throw new Error(`repair event invalid: heartbeat in ${current.status}`);
      if (payload.lockSha256 !== current.claim.lockSha256) throw new Error("repair event invalid: heartbeat lock hash mismatch");
      current.claim.heartbeatAt = occurredAt;
      current.claim.expiresAt = boundedExpiry(payload.expiresAt, occurredAt, proposal.policy.heartbeat.claimTtlSeconds, "heartbeat expiresAt");
      break;
    case "start_fixing":
      assertClaimHolder(current, event);
      if (!["claimed", "request_changes"].includes(current.status)) throw new Error(`repair event invalid: start_fixing from ${current.status}`);
      current.status = "fixing";
      break;
    case "source_checkpoint":
      assertClaimHolder(current, event);
      if (current.status !== "fixing") throw new Error(`repair event invalid: source_checkpoint from ${current.status}`);
      if (!SHA256.test(payload.bundleSha256 ?? "")) throw new Error("repair event invalid: source checkpoint bundle hash required");
      if (!safeRepoPath(payload.outboxRef ?? "") || !String(payload.outboxRef).startsWith(`${proposal.transport.outboxNamespace}/attempt-${current.attempt}/`)) throw new Error("repair event invalid: source checkpoint outboxRef must bind proposal attempt");
      current.status = "source_review";
      current.lastSourceCheckpoint = { eventId: event.eventId, bundleSha256: payload.bundleSha256, outboxRef: payload.outboxRef };
      current.claim.expiresAt = null;
      break;
    case "review_approved":
      if (current.status !== "source_review") throw new Error(`repair event invalid: review_approved from ${current.status}`);
      assertMacReviewAuthority(payload, current, verifyMacReviewAuthority, proposal, event);
      if (payload.reviewReceiptSha256 !== payload.authority.reviewReceiptSha256) throw new Error("repair event invalid: review receipt and authority hash mismatch");
      current.status = "approved";
      current.lastReviewEvent = event.eventId;
      current.approvedEventId = event.eventId;
      current.lastReviewAuthority = clone(payload.authority);
      current.circuitBreaker.consecutiveFailures = 0;
      current.failureTimestamps = [];
      break;
    case "review_request_changes":
      if (current.status !== "source_review") throw new Error(`repair event invalid: review_request_changes from ${current.status}`);
      assertMacReviewAuthority(payload, current, verifyMacReviewAuthority, proposal, event);
      if (payload.reviewReceiptSha256 !== payload.authority.reviewReceiptSha256 || !nonEmptyStringArray(payload.findings)) throw new Error("repair event invalid: request_changes requires matching review receipt hash and findings");
      current.status = "request_changes";
      current.lastReviewEvent = event.eventId;
      current.approvedEventId = null;
      current.lastReviewAuthority = clone(payload.authority);
      current.claim.expiresAt = boundedExpiry(payload.expiresAt, occurredAt, proposal.policy.heartbeat.claimTtlSeconds, "request_changes expiresAt");
      break;
    case "mark_deployable":
      if (current.status !== "approved") throw new Error(`repair event invalid: mark_deployable from ${current.status}`);
      assertMacReviewAuthority(payload, current, verifyMacReviewAuthority, proposal, event);
      if (payload.approvedEventId !== current.lastReviewEvent
        || payload.sourceCheckpointSha256 !== current.lastSourceCheckpoint?.bundleSha256
        || !SHA40.test(payload.resultCommit ?? "")) {
        throw new Error("repair event invalid: deployable must bind approved event, source checkpoint and result commit");
      }
      current.status = "deployable";
      current.lastReviewEvent = event.eventId;
      current.deployableEventId = event.eventId;
      current.deployableResultCommit = payload.resultCommit;
      current.lastReviewAuthority = clone(payload.authority);
      current.claim = emptyClaim();
      break;
    case "start_replay":
      if (current.status !== "deployable") throw new Error(`repair event invalid: start_replay from ${current.status}`);
      if (!safeRepoPath(payload.authorizationRef ?? "") || !payload.authorizationRef.startsWith("docs/handoffs/repair-authorizations/")
        || !SHA256.test(payload.authorizationSha256 ?? "") || !SHA40.test(payload.authorizationCommit ?? "")) throw new Error("repair event invalid: replay requires a separately committed and hashed authorization artifact");
      if (typeof verifyReplayAuthorization !== "function" || verifyReplayAuthorization({ proposal, projection: current, event, authorization: payload }) !== true) throw new Error("repair event invalid: replay authorization is not trusted");
      current.status = "replaying";
      current.replayAuthorizationRef = payload.authorizationRef;
      current.replayAuthorizationSha256 = payload.authorizationSha256;
      current.replayAuthorizationCommit = payload.authorizationCommit;
      break;
    case "complete":
      if (current.status !== "replaying") throw new Error(`repair event invalid: complete from ${current.status}`);
      if (!safeRepoPath(payload.bundleRef ?? "") || !SHA256.test(payload.bundleSha256 ?? "")) throw new Error("repair event invalid: completion bundle ref/hash required");
      if (typeof verifyCompletionBundle !== "function" || verifyCompletionBundle({ proposal, projection: current, event, completion: payload }) !== true) throw new Error("repair event invalid: completion bundle is not trusted");
      current.status = "completed";
      break;
    case "attempt_failed": {
      if (!ACTIVE_CLAIM.has(current.status)) throw new Error(`repair event invalid: attempt_failed from ${current.status}`);
      assertClaimHolder(current, event);
      recordFailure(current, proposal, payload.reason ?? "attempt failed", occurredAt);
      current.status = current.circuitBreaker.state === "open" || current.attempt >= proposal.attempt.max ? "failed" : "proposed";
      current.claim = emptyClaim();
      break;
    }
    case "fail":
      if (TERMINAL.has(current.status)) throw new Error(`repair event invalid: fail from terminal ${current.status}`);
      recordFailure(current, proposal, payload.reason ?? "failed", occurredAt);
      current.status = "failed";
      current.claim = emptyClaim();
      break;
    case "claim_expired":
      if (!ACTIVE_CLAIM.has(current.status)) throw new Error(`repair event invalid: claim_expired from ${current.status}`);
      if (!current.claim.expiresAt || Date.parse(occurredAt) < Date.parse(current.claim.expiresAt)) throw new Error("repair event invalid: claim has not expired");
      recordFailure(current, proposal, "claim heartbeat expired", occurredAt);
      current.status = current.circuitBreaker.state === "open" || current.attempt >= proposal.attempt.max ? "failed" : "proposed";
      current.claim = emptyClaim();
      break;
    case "cancel":
      if (TERMINAL.has(current.status)) throw new Error(`repair event invalid: cancel from terminal ${current.status}`);
      assertMacReviewAuthority(payload, current, verifyMacReviewAuthority, proposal, event);
      current.status = "cancelled";
      current.claim = emptyClaim();
      break;
    default:
      throw new Error(`repair event invalid: unsupported event ${event.eventType}`);
  }

  current.eventIds.push(event.eventId);
  current.eventDigests[event.eventId] = eventDigest;
  current.lastOccurredAt = occurredAt;
  return current;
}

function validateEventBinding(proposal, projection, event) {
  const errors = [];
  requireExactKeys(event, ["schemaId", "schemaVersion", "eventId", "proposalId", "proposalSha256", "eventType", "attempt", "occurredAt", "actor", "payload"], "event", errors);
  if (event?.schemaId !== "xhs.repair-event.v1" || event?.schemaVersion !== 1) errors.push("schema must be xhs.repair-event.v1@1");
  if (!/^repair_event_[0-9a-f]{24}$/.test(event?.eventId ?? "")) errors.push("eventId invalid");
  if (event?.proposalId !== proposal.proposalId) errors.push("proposalId mismatch");
  if (event?.proposalSha256 !== projection.proposalSha256) errors.push("proposalSha256 mismatch");
  if (!REPAIR_EVENT_TYPES.includes(event?.eventType)) errors.push("eventType invalid");
  if (!Number.isInteger(event?.attempt) || event.attempt < 0) errors.push("attempt invalid");
  if (event?.eventType === "claim") {
    if (event.attempt !== projection.attempt + 1) errors.push("claim attempt must increment by one");
  } else if (event?.attempt !== projection.attempt) errors.push("event attempt must match current projection");
  if (!validIso(event?.occurredAt)) errors.push("occurredAt invalid");
  requireExactKeys(event?.actor, ["role", "id"], "event.actor", errors);
  const role = event?.actor?.role;
  if (WINDOWS_EVENTS.has(event?.eventType) && role !== "windows_consumer") errors.push(`${event.eventType} requires windows_consumer`);
  if (MAC_EVENTS.has(event?.eventType) && !["mac_governance", "human"].includes(role)) errors.push(`${event.eventType} requires mac_governance or human`);
  if (!nonEmpty(event?.actor?.id)) errors.push("actor.id required");
  if (!plainObject(event?.payload)) errors.push("event.payload must be an object");
  else errors.push(...validateEventPayload(event.eventType, event.payload));
  if (event?.eventId !== expectedRepairEventId(event)) errors.push("eventId does not match canonical event binding");
  errors.push(...scanForSecrets(event).map((item) => `secret material rejected at ${item}`));
  return errors;
}

export function createRepairEvent(proposal, projection, { eventType, actor, payload = {}, occurredAt = new Date().toISOString() }) {
  const attempt = eventType === "claim" ? projection.attempt + 1 : projection.attempt;
  const stable = { proposalId: proposal.proposalId, proposalSha256: projection.proposalSha256, eventType, attempt, actor, payload, occurredAt };
  return {
    schemaId: "xhs.repair-event.v1",
    schemaVersion: 1,
    eventId: `repair_event_${sha256(stable).slice(0, 24)}`,
    proposalId: proposal.proposalId,
    proposalSha256: projection.proposalSha256,
    eventType,
    attempt,
    occurredAt,
    actor: clone(actor),
    payload: clone(payload),
  };
}

export function validateSourceCheckpoint(proposal, checkpoint) {
  const errors = [];
  requireExactKeys(checkpoint, ["schemaId", "schemaVersion", "checkpointId", "proposalId", "proposalSha256", "attempt", "producedAt", "baseCommit", "resultCommit", "businessSemanticsChanged", "files", "diff", "tests", "scopeGuard", "secretScan", "evidenceDebt", "authority"], "checkpoint", errors);
  if (checkpoint?.schemaId !== "xhs.repair-source-checkpoint.v1" || checkpoint?.schemaVersion !== 1) errors.push("checkpoint schema invalid");
  if (!/^repair_checkpoint_[0-9a-f]{24}$/.test(checkpoint?.checkpointId ?? "") || !validIso(checkpoint?.producedAt)) errors.push("checkpointId or producedAt invalid");
  if (checkpoint?.proposalId !== proposal.proposalId || checkpoint?.proposalSha256 !== proposalSha256(proposal)) errors.push("checkpoint proposal binding mismatch");
  if (!positiveInt(checkpoint?.attempt) || checkpoint.attempt > proposal.attempt.max) errors.push("checkpoint attempt invalid");
  if (checkpoint?.baseCommit !== proposal.target.baseCommit || !SHA40.test(checkpoint?.resultCommit ?? "")) errors.push("checkpoint commit binding invalid");
  if (checkpoint?.authority?.actorRole !== "windows_consumer") errors.push("checkpoint must be produced by windows_consumer");
  if (checkpoint?.authority?.reviewVerdictModified !== false || checkpoint?.authority?.macWritePerformed !== false || checkpoint?.authority?.deploymentPerformed !== false || checkpoint?.authority?.deviceActions !== 0) errors.push("checkpoint authority boundary violated");
  if (checkpoint?.businessSemanticsChanged !== false) errors.push("business semantics changes are forbidden");
  const files = checkpoint?.files ?? [];
  if (!Array.isArray(files) || files.length < 1 || files.length > proposal.policy.limits.maxFiles) errors.push("checkpoint file count outside proposal limit");
  const seen = new Set();
  let diffLines = 0;
  for (const file of files) {
    requireExactKeys(file, ["path", "beforeSha256", "afterSha256", "addedLines", "deletedLines"], `checkpoint.files.${file?.path ?? "unknown"}`, errors);
    if (!isAllowedRepairPath(file?.path, proposal.policy)) errors.push(`path outside proposal scope: ${file?.path}`);
    if (seen.has(file?.path)) errors.push(`duplicate checkpoint path: ${file?.path}`);
    seen.add(file?.path);
    if (!(file?.beforeSha256 === null || SHA256.test(file?.beforeSha256 ?? "")) || !SHA256.test(file?.afterSha256 ?? "")) errors.push(`invalid file hash: ${file?.path}`);
    if (!Number.isInteger(file?.addedLines) || file.addedLines < 0 || !Number.isInteger(file?.deletedLines) || file.deletedLines < 0) errors.push(`invalid diff stats: ${file?.path}`);
    diffLines += (file?.addedLines ?? 0) + (file?.deletedLines ?? 0);
  }
  requireExactKeys(checkpoint?.diff, ["totalLines", "patchSha256"], "checkpoint.diff", errors);
  if (diffLines > proposal.policy.limits.maxDiffLines || checkpoint?.diff?.totalLines !== diffLines || !SHA256.test(checkpoint?.diff?.patchSha256 ?? "")) errors.push("checkpoint diff exceeds limit, totalLines mismatches files, or patchSha256 invalid");
  if (!Array.isArray(checkpoint?.tests) || checkpoint.tests.length < 1) errors.push("checkpoint tests must be present");
  for (const item of checkpoint?.tests ?? []) {
    requireExactKeys(item, ["name", "passed", "evidenceSha256"], "checkpoint.test", errors);
    if (!nonEmpty(item?.name) || item?.passed !== true || !SHA256.test(item?.evidenceSha256 ?? "")) errors.push("checkpoint tests must all pass with evidence hash");
  }
  for (const [label, receipt] of [["scopeGuard", checkpoint?.scopeGuard], ["secretScan", checkpoint?.secretScan]]) {
    requireExactKeys(receipt, ["passed", "evidenceSha256"], `checkpoint.${label}`, errors);
    if (receipt?.passed !== true || !SHA256.test(receipt?.evidenceSha256 ?? "")) errors.push(`${label} must pass with evidence hash`);
  }
  if (!objectArray(checkpoint?.evidenceDebt)) errors.push("checkpoint.evidenceDebt must be an object array");
  requireExactKeys(checkpoint?.authority, ["actorId", "actorRole", "reviewVerdictModified", "macWritePerformed", "deploymentPerformed", "deviceActions"], "checkpoint.authority", errors);
  if (!nonEmpty(checkpoint?.authority?.actorId)) errors.push("checkpoint authority actorId required");
  errors.push(...scanForSecrets(checkpoint).map((item) => `secret material rejected at ${item}`));
  return { ok: errors.length === 0, errors };
}

export function validateCompletionBundle(proposal, completion) {
  const errors = [];
  requireExactKeys(completion, ["schemaId", "schemaVersion", "completionId", "proposalId", "proposalSha256", "attempt", "completedAt", "sourceCheckpointSha256", "resultCommit", "macReview", "replay", "evidenceDebt", "evidenceDebtAffectsBusinessResult", "authority"], "completion", errors);
  if (completion?.schemaId !== "xhs.repair-completion.v1" || completion?.schemaVersion !== 1) errors.push("completion schema invalid");
  if (!/^repair_completion_[0-9a-f]{24}$/.test(completion?.completionId ?? "") || !positiveInt(completion?.attempt) || completion.attempt > proposal.attempt.max || !validIso(completion?.completedAt)) errors.push("completion id/attempt/completedAt invalid");
  if (completion?.proposalId !== proposal.proposalId || completion?.proposalSha256 !== proposalSha256(proposal)) errors.push("completion proposal binding mismatch");
  if (!SHA256.test(completion?.sourceCheckpointSha256 ?? "") || !SHA40.test(completion?.resultCommit ?? "")) errors.push("completion source binding invalid");
  requireExactKeys(completion?.macReview, ["approvedEventId", "deployableEventId"], "completion.macReview", errors);
  if (![completion?.macReview?.approvedEventId, completion?.macReview?.deployableEventId].every((id) => /^repair_event_[0-9a-f]{24}$/.test(id ?? ""))) errors.push("completion must reference exact Mac approval and deployable events");
  requireExactKeys(completion?.replay, ["authorizationRef", "authorizationSha256", "authorizationCommit", "runId", "manifestSha256", "externalEffect", "paymentTransport"], "completion.replay", errors);
  if (!safeRepoPath(completion?.replay?.authorizationRef ?? "") || !completion.replay.authorizationRef.startsWith("docs/handoffs/repair-authorizations/")
    || !String(completion?.replay?.runId ?? "").startsWith("run_") || !SHA256.test(completion?.replay?.manifestSha256 ?? "")) errors.push("completion replay binding invalid");
  if (!SHA256.test(completion?.replay?.authorizationSha256 ?? "")) errors.push("completion replay authorizationSha256 invalid");
  if (!SHA40.test(completion?.replay?.authorizationCommit ?? "")) errors.push("completion replay authorizationCommit invalid");
  if (completion?.replay?.externalEffect !== false || completion?.replay?.paymentTransport !== 0) errors.push("completion must remain effect-free with paymentTransport=0");
  if (!objectArray(completion?.evidenceDebt)) errors.push("completion.evidenceDebt must be an object array");
  if (completion?.evidenceDebtAffectsBusinessResult !== false) errors.push("evidence debt must not change business result");
  requireExactKeys(completion?.authority, ["actorId", "actorRole", "reviewVerdictModified", "macWritePerformed"], "completion.authority", errors);
  if (completion?.authority?.actorRole !== "windows_consumer" || completion?.authority?.reviewVerdictModified !== false || completion?.authority?.macWritePerformed !== false) errors.push("completion authority boundary violated");
  if (!nonEmpty(completion?.authority?.actorId)) errors.push("completion authority actorId required");
  errors.push(...scanForSecrets(completion).map((item) => `secret material rejected at ${item}`));
  return { ok: errors.length === 0, errors };
}

export function isAllowedRepairPath(path, policy) {
  if (!safeRepoPath(path)) return false;
  if ((policy?.forbiddenPaths ?? []).some((glob) => globMatch(path, glob))) return false;
  return (policy?.allowedPaths ?? []).some((glob) => globMatch(path, glob));
}

export function proposalKnowledgeEnvelope(proposal) {
  const validation = validateRepairProposal(proposal);
  if (!validation.ok) throw new Error(`repair proposal invalid: ${validation.errors.join("; ")}`);
  return {
    id: proposal.proposalId,
    scope: "global",
    app: proposal.target.app,
    category: "unknown",
    title: `Repair proposal: ${proposal.finding.summary}`,
    content: canonicalJson(proposal),
    verifiedBy: [`mac-review:${proposal.source.review.reviewId}`],
    needsEngineer: true,
    appliesTo: ["repair-proposal-v1", proposal.target.repository, proposal.target.capabilityId, proposal.idempotencyKey],
    steps: [
      "Parse content as xhs.repair-proposal.v1 and verify proposal hash/idempotency key.",
      "Claim by appending xhs.repair-event.v1 to registry knowledge plus the existing sealed outbox namespace.",
      "Submit a source checkpoint; wait for independent Mac review before any deployable/replay state.",
    ],
    verifyMode: "constraint",
    lifecycle: "backlog",
  };
}

export function repairEventKnowledgeEnvelope(event, { outboxRef = null, terminal = false, app = "xhs" } = {}) {
  return {
    id: event.eventId,
    scope: "global",
    app,
    category: "unknown",
    title: `Repair event ${event.eventType}: ${event.proposalId}`,
    content: canonicalJson({ ...event, outboxRef }),
    verifiedBy: [`${event.actor.role}:${event.actor.id}`],
    needsEngineer: !terminal,
    appliesTo: ["repair-event-v1", event.proposalId, event.proposalSha256],
    steps: [],
    verifyMode: "constraint",
    lifecycle: terminal ? "resolved" : "backlog",
  };
}

export function scanForSecrets(value) {
  const hits = [];
  const safeReferenceKeys = new Set(["authorizationref", "authorizationsha256", "secretscan", "secretscansha256"]);
  const sensitiveKey = (key) => {
    const normalized = String(key).replaceAll("_", "").replaceAll("-", "").toLowerCase();
    if (safeReferenceKeys.has(normalized)) return false;
    return /^(?:(?:[a-z0-9]*)(?:token|cookie)|password|passwd|secret|authorization|authheader|privatekey|clientsecret|apikey|credential|awssecretaccesskey)$/.test(normalized);
  };
  const sensitiveValue = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/=-]{12,}|\b(?:ghp|github_pat|sk)-[A-Za-z0-9_-]{16,}/;
  const walk = (item, path) => {
    if (Array.isArray(item)) return item.forEach((entry, index) => walk(entry, `${path}[${index}]`));
    if (item && typeof item === "object") {
      for (const [key, entry] of Object.entries(item)) {
        const next = path ? `${path}.${key}` : key;
        if (sensitiveKey(key) && entry != null && entry !== "") hits.push(next);
        walk(entry, next);
      }
      return;
    }
    if (typeof item === "string" && sensitiveValue.test(item)) hits.push(path || "$");
  };
  walk(value, "");
  return [...new Set(hits)];
}

function recordFailure(projection, proposal, reason, occurredAt) {
  const cutoff = Date.parse(occurredAt) - proposal.policy.circuitBreaker.windowSeconds * 1000;
  projection.failureTimestamps = (projection.failureTimestamps ?? []).filter((value) => Date.parse(value) >= cutoff);
  projection.failureTimestamps.push(occurredAt);
  projection.circuitBreaker.consecutiveFailures = projection.failureTimestamps.length;
  if (projection.circuitBreaker.consecutiveFailures >= proposal.policy.circuitBreaker.failureThreshold) {
    projection.circuitBreaker.state = "open";
    projection.circuitBreaker.openedAt = occurredAt;
    projection.circuitBreaker.reason = reason;
  }
}

function assertClaimHolder(projection, event) {
  if (!projection.claim.holder || projection.claim.holder !== event.actor.id) throw new Error("repair event invalid: actor does not hold claim");
}

function emptyClaim() {
  return { holder: null, claimEventId: null, claimedAt: null, heartbeatAt: null, expiresAt: null, lockRef: null, lockSha256: null };
}

function assertMacReviewAuthority(payload, projection, verifier, proposal, event) {
  const authority = payload?.authority;
  const valid = plainObject(authority)
    && SHA40.test(authority.macCommit ?? "")
    && safeRepoPath(authority.reviewReceiptPath)
    && authority.reviewReceiptPath.startsWith("docs/handoffs/repair-reviews/")
    && SHA256.test(authority.reviewReceiptSha256 ?? "")
    && authority.reviewedCheckpointSha256 === (projection.lastSourceCheckpoint?.bundleSha256 ?? null);
  if (!valid) throw new Error("repair event invalid: Mac review authority artifact is incomplete");
  if (typeof verifier !== "function" || verifier({ proposal, projection, event, authority }) !== true) throw new Error("repair event invalid: Mac review authority is not trusted");
}

function expectedRepairEventId(event) {
  const stable = {
    proposalId: event?.proposalId,
    proposalSha256: event?.proposalSha256,
    eventType: event?.eventType,
    attempt: event?.attempt,
    actor: event?.actor,
    payload: event?.payload,
    occurredAt: event?.occurredAt,
  };
  return `repair_event_${sha256(stable).slice(0, 24)}`;
}

function validateEventPayload(eventType, payload) {
  const specs = {
    claim: { required: ["expiresAt", "lockRef", "lockSha256"] },
    heartbeat: { required: ["expiresAt", "lockSha256"] },
    start_fixing: { required: [] },
    source_checkpoint: { required: ["bundleSha256", "outboxRef"] },
    review_approved: { required: ["reviewReceiptSha256", "authority"] },
    review_request_changes: { required: ["reviewReceiptSha256", "expiresAt", "findings", "authority"] },
    mark_deployable: { required: ["approvedEventId", "sourceCheckpointSha256", "resultCommit", "authority"] },
    start_replay: { required: ["authorizationRef", "authorizationSha256", "authorizationCommit"] },
    complete: { required: ["bundleRef", "bundleSha256"] },
    attempt_failed: { required: [], optional: ["reason"] },
    fail: { required: [], optional: ["reason"] },
    claim_expired: { required: [] },
    cancel: { required: ["authority"], optional: ["reason", "supersededBy"] },
  };
  const spec = specs[eventType];
  if (!spec) return [];
  const allowed = new Set([...spec.required, ...(spec.optional ?? [])]);
  const errors = [];
  for (const key of spec.required) if (!Object.hasOwn(payload, key)) errors.push(`event.payload.${key} required`);
  for (const key of Object.keys(payload)) if (!allowed.has(key)) errors.push(`event.payload.${key} is not allowed`);
  return errors;
}

function requiredFutureIso(value, after, label) {
  if (!Number.isFinite(Date.parse(value)) || Date.parse(value) <= Date.parse(after)) throw new Error(`repair event invalid: ${label} must be in the future`);
  return value;
}

function boundedExpiry(value, after, maxSeconds, label) {
  const expiresAt = requiredFutureIso(value, after, label);
  if (Date.parse(expiresAt) - Date.parse(after) > maxSeconds * 1000) throw new Error(`repair event invalid: ${label} exceeds proposal TTL`);
  return expiresAt;
}

function safeRepoPath(value) {
  return typeof value === "string" && value.length > 0 && !isAbsolute(value) && !value.includes("\\") && !value.split("/").includes("..") && !value.startsWith("./");
}

function safePolicyGlob(value) {
  return safeRepoPath(value) && !value.includes("***");
}

function globMatch(path, glob) {
  const placeholder = "\u0000";
  let source = glob.replaceAll("**", placeholder).replace(/[.+^${}()|[\]\\]/g, "\\$&");
  source = source.replaceAll("*", "[^/]*").replaceAll(placeholder, ".*").replaceAll("?", "[^/]");
  return new RegExp(`^${source}$`).test(path);
}

function positiveInt(value) {
  return Number.isInteger(value) && value > 0;
}

function requireExactKeys(value, keys, label, errors, { optional = [] } = {}) {
  if (!plainObject(value)) {
    errors.push(`${label} must be an object`);
    return;
  }
  const allowed = new Set(keys);
  const optionalSet = new Set(optional);
  for (const key of keys) {
    if (!optionalSet.has(key) && !Object.hasOwn(value, key)) errors.push(`${label}.${key} required`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${label}.${key} is not allowed`);
  }
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function nonEmptyStringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every(nonEmpty);
}

function objectArray(value) {
  return Array.isArray(value) && value.every(plainObject);
}

function validIso(value) {
  return nonEmpty(value) && Number.isFinite(Date.parse(value));
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}
