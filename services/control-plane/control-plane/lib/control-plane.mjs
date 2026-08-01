import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ControlPlaneError, asControlError } from "./errors.mjs";
import { fingerprint } from "./canonical.mjs";
import { validateJsonSchema } from "./json-schema-validator.mjs";
import { DiscoverySessionRuntime } from "./discovery-session.mjs";
import { evaluateCapabilityPolicy } from "./policy.mjs";
import { inspectTransportLock } from "./xiaowei-transport.mjs";
import { normalizeRecoveryVisualAnalysis } from "./recovery-inspection.mjs";
import { MissionRuntime } from "./mission-runtime.mjs";
import { DeviceRunRuntime } from "./device-run.mjs";
import { EffectFirewall } from "./effect-firewall.mjs";
import { EffectLedger } from "./effect-ledger.mjs";
import { EffectCommitProtocol } from "./effect-commit-protocol.mjs";
import { ProtectedHumanCommit } from "./protected-human-commit.mjs";
import { guardFinancialCommit } from "./financial-commit-classifier.mjs";
import { acquireTransportLock as defaultAcquireTransportLock } from "./xiaowei-transport.mjs";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(moduleDir, "..", "..");
const EFFECT_INTENT_SCHEMA_PATH = join(moduleDir, "..", "schema", "effect-intent.schema.json");
const DEFAULT_ADR_0008_PATH = join(REPO_ROOT, "docs", "adr", "0008-mission-driven-exploration-authorization.md");
const DEFAULT_ADR_0009_PATH = join(REPO_ROOT, "docs", "adr", "0009-standing-grant-delegation.md");
const DEFAULT_ADR_0010_PATH = join(REPO_ROOT, "docs", "adr", "0010-standing-grant-discovery-session.md");

// Load the canonical effect-intent envelope schema once at module load so the runtime
// validation is driven by the schema file (the source of truth), not a parallel copy.
let EFFECT_INTENT_SCHEMA = null;
try {
  if (existsSync(EFFECT_INTENT_SCHEMA_PATH)) {
    EFFECT_INTENT_SCHEMA = JSON.parse(readFileSync(EFFECT_INTENT_SCHEMA_PATH, "utf8"));
  }
} catch {
  // A missing/unreadable schema must fail closed for envelopes, handled per-call below.
  EFFECT_INTENT_SCHEMA = null;
}

// ADR 0008 acceptance is decided OUTSIDE code review (by the authorized decision maker). The
// guard reads the ADR's Status line so enabling the automatic-R2 Mission path requires a real
// accepted ADR on disk, not a code change. A missing ADR (still Proposed / not yet written) is
// treated as not accepted. Tests may inject adrAccepted to exercise the enabled branch without
// touching the ADR file.
function readAdrStatusAccepted(adrPath) {
  try {
    if (!existsSync(adrPath)) return false;
    const text = readFileSync(adrPath, "utf8");
    return /^\s*(?:[-*]\s*)?Status:\s*Accepted\b/im.test(text);
  } catch {
    return false;
  }
}

function collectEvidenceFiles(...values) {
  return values.flatMap((value) => Array.isArray(value?.evidenceFiles) ? value.evidenceFiles : []);
}

function boundedAdapterCode(error) {
  const value = error?.details?.adapterCode;
  return typeof value === "string" && /^[A-Z0-9_]{1,96}$/.test(value) ? value : null;
}

function boundedTransportEvidence(value) {
  if (!value || typeof value !== "object") return undefined;
  const counters = ["httpTapAttempts", "httpTapSucceeded", "gatewayTapFallbacks"];
  if (value.mode !== "typed-http"
    || value.httpReady !== true
    || counters.some((key) => !Number.isSafeInteger(value[key]) || value[key] < 0)) return undefined;
  return {
    mode: "typed-http",
    httpReady: true,
    httpTapAttempts: value.httpTapAttempts,
    httpTapSucceeded: value.httpTapSucceeded,
    gatewayTapFallbacks: value.gatewayTapFallbacks,
  };
}

function resultSummary(execution, verification, restoration, error = null) {
  const out = execution?.output;
  const transportEvidence = boundedTransportEvidence(out?.transportEvidence);
  return {
    vendorCode: execution?.vendorCode ?? null,
    // 执行细节摘要（ok/step/verified/counts/text），便于 VERIFICATION_FAILED 时回溯，不落完整 dump
    output: out && typeof out === "object"
      ? Object.fromEntries(
        ["ok", "step", "verified", "verifyMethod", "beforeCount", "afterCount", "text", "diagnostic"]
          .filter((k) => out[k] !== undefined)
          .map((k) => [k, out[k]]),
      )
      : null,
    ...(transportEvidence ? { transportEvidence } : {}),
    error: error
      ? { code: error.code || null, message: String(error.message || error), details: error.details ?? null }
      : null,
    verification: verification ? {
      ok: verification.ok !== false,
      mode: verification.mode || null,
      hash: verification.hash || null,
    } : null,
    restoration: restoration ? { ok: restoration.ok !== false } : null,
  };
}

export class AdapterRegistry {
  constructor(adapters = []) {
    this.adapters = new Map();
    for (const adapter of adapters) {
      if (!adapter?.id) throw new TypeError("adapter.id is required");
      if (this.adapters.has(adapter.id)) throw new TypeError(`duplicate adapter ${adapter.id}`);
      if (typeof adapter.execute !== "function") throw new TypeError(`${adapter.id}.execute is required`);
      this.adapters.set(adapter.id, adapter);
    }
  }

  require(id) {
    const adapter = this.adapters.get(id);
    if (!adapter) {
      throw new ControlPlaneError("ADAPTER_NOT_FOUND", `adapter ${id} is not installed`, { status: 503 });
    }
    return adapter;
  }
}

export class ControlPlane {
  constructor({
    state,
    capabilities,
    adapters,
    evidence,
    authorityNodeId = "DESKTOP-3I1EVHE",
    operatorControlUrl = process.env.CONTROL_PLANE_INTERNAL_URL || "http://127.0.0.1:17920",
    transportStatus = inspectTransportLock,
    schedulerIntervalMs = 100,
    leaseTtlMs = 60000,
    leaseHeartbeatMs = 10000,
    missions = null,
    acquireTransportLock = null,
    missionAutoApprovalEnabled = process.env.MISSION_AUTO_APPROVAL_ENABLED === "1",
    standingGrantEnabled = process.env.STANDING_GRANT_ENABLED === "1",
    discoveryIssuerReady = false,
    discoveryProducer = null,
    adrAccepted = null,
    adrPath = DEFAULT_ADR_0008_PATH,
    standingGrantAdrAccepted = null,
    standingGrantAdrPath = DEFAULT_ADR_0009_PATH,
    discoveryAdrAccepted = null,
    discoveryAdrPath = DEFAULT_ADR_0010_PATH,
    receiptAuthorityAllowlist = [],
    effectIntentSchema = EFFECT_INTENT_SCHEMA,
    paymentApprovalVerifier = null,
    policyMode = null,
    now = Date.now,
  }) {
    this.state = state;
    this.capabilities = capabilities;
    this.adapters = adapters instanceof AdapterRegistry ? adapters : new AdapterRegistry(adapters);
    this.evidence = evidence;
    this.authorityNodeId = authorityNodeId;
    // REX Phase 5 §8.1 item 1：nonpayment_v1 模式（resolvePolicyMode 解析结果）。
    // 默认 null = legacy，旧行为全保留，既有测试不破。active（fake adapter）时，
    // evaluateCapabilityPolicy 对非支付 capability 不再 approvalRequired（非支付一律自由）。
    this.policyMode = policyMode;
    // REX Phase 5 §8.4：非支付 evidence 容量失败走 debt 旁路。policyMode.active 时，
    // assertCapacity 热路径传 debtOnLowDisk=true + debtSink 记录到 this.evidenceDebt；
    // 资金最终提交走单独 PHC 流，不经此 submitJob 热路径，故 nonpayment_v1 下 submitJob
    // 容量失败恒为 debt 而非 block。默认 null/legacy 时 debtOnLowDisk=false，fail-closed 不变。
    this.evidenceDebt = [];
    this.debtOnLowDisk = policyMode && policyMode.active === true;
    // §8.4 #1：nonpayment_v1 active 时给 EvidenceStore 注入 debtRecorder，使 run 进行中的
    // 证据事件写失败（ENOSPC/ENOTDIR 等）记 evidence_debt 而非抛错——非支付不阻断派发。
    // legacy（debtOnLowDisk=false）不注入，EvidenceStore 写失败仍抛（fail-closed 不变）。
    if (this.debtOnLowDisk && this.evidence && typeof this.evidence.debtRecorder !== "undefined") {
      this.evidence.debtRecorder = (entry) => this.evidenceDebt.push(entry);
    }
    this.operatorControlUrl = operatorControlUrl;
    this.transportStatus = transportStatus;
    this.schedulerIntervalMs = schedulerIntervalMs;
    if (!Number.isFinite(leaseTtlMs) || !Number.isFinite(leaseHeartbeatMs)
      || leaseTtlMs <= 0 || leaseHeartbeatMs <= 0 || leaseHeartbeatMs >= leaseTtlMs) {
      throw new TypeError("leaseHeartbeatMs must be positive and less than leaseTtlMs");
    }
    this.leaseTtlMs = leaseTtlMs;
    this.leaseHeartbeatMs = leaseHeartbeatMs;
    this.activeJobs = new Map();
    this.started = false;
    this.pumping = false;
    this.missions = missions instanceof MissionRuntime ? missions : new MissionRuntime({ state });
    this.deviceRuns = new DeviceRunRuntime({
      state,
      missions: this.missions,
      authorityNodeId,
      leaseTtlMs,
      leaseHeartbeatMs,
    });
    this.firewall = new EffectFirewall();
    this.discoveryProducer = typeof discoveryProducer === "function" ? discoveryProducer : null;
    this.effectLedger = new EffectLedger({ state });
    this.acquireTransportLock = typeof acquireTransportLock === "function"
      ? acquireTransportLock
      : defaultAcquireTransportLock;
    // Mission automatic-R2 gating (ADR 0008). Default false: the manual per-effect gate stays
    // intact until the authorized decision maker accepts ADR 0008 outside code review AND the
    // flag is enabled. adrAccepted===null reads the ADR file lazily; an explicit boolean
    // override is for tests only and never mutates the ADR file.
    this.missionAutoApprovalEnabled = Boolean(missionAutoApprovalEnabled);
    this.standingGrantEnabled = Boolean(standingGrantEnabled);
    this.discoveryIssuerReady = Boolean(discoveryIssuerReady);
    this.adrAcceptedOverride = adrAccepted;
    this.adrPath = adrPath;
    this.standingGrantAdrAcceptedOverride = standingGrantAdrAccepted;
    this.standingGrantAdrPath = standingGrantAdrPath;
    this.discoveryAdrAcceptedOverride = discoveryAdrAccepted;
    this.discoveryAdrPath = discoveryAdrPath;
    this.effectIntentSchema = effectIntentSchema;
    // REX Phase 2 收尾: payment control surface. The live prepared handle for a financial commit
    // lives in a ProtectedHumanCommit instance's in-process Map; this index maps commitId -> the
    // instance that owns the live handle so the decide API can route to it. Only a live handle can
    // decide; a restart wipes this Map, so durable pending rows become un-decidable (recovered).
    this.paymentApprovalVerifier = paymentApprovalVerifier;
    this.paymentCommitOwners = new Map();
    this.now = now;
    this.receiptAuthorityAllowlist = new Set((Array.isArray(receiptAuthorityAllowlist) ? receiptAuthorityAllowlist : [])
      .filter((item) => item && typeof item.capabilityId === "string" && typeof item.adapterId === "string")
      .map((item) => `${item.capabilityId}:${item.adapterId}`));
    this.discoverySessions = new DiscoverySessionRuntime({
      state,
      authorityNodeId,
      leaseTtlMs,
      gates: () => ({
        missionAutoApprovalEnabled: this.missionAutoApprovalEnabled,
        standingGrantEnabled: this.standingGrantEnabled,
        adr0008Accepted: this.isAdr0008Accepted(),
        adr0010Accepted: this.isAdr0010Accepted(),
        issuerReady: this.discoveryIssuerReady,
      }),
    });
    state.upsertNode({
      nodeId: authorityNodeId,
      status: "online",
      authority: true,
      dispatchMode: "local",
    });
    state.syncCapabilities(capabilities);
  }

  // REX Phase 5 §8.4：构造 assertCapacity 选项。policyMode.active（nonpayment_v1，
  // fake adapter）时传 debtOnLowDisk=true + debtSink 记 evidenceDebt；否则 legacy fail-closed。
  // 资金最终提交走单独 PHC 流，不经 submitJob/session 热路径，故 nonpayment_v1 下容量失败
  // 恒为 debt 而非 block。legacy（debtOnLowDisk=false）行为与旧版完全一致。
  capacityOpts(externalEffect) {
    return {
      externalEffect,
      debtOnLowDisk: this.debtOnLowDisk,
      debtSink: this.debtOnLowDisk ? (entry) => this.evidenceDebt.push(entry) : null,
    };
  }

  // 提交前预检：nonpayment_v1 下只解除 fail-closed 抛错（debtOnLowDisk 但无 debtSink，
  // 不重复记 debt），由后续 initializeRun 做唯一一次 debt 记录。legacy 下 debtOnLowDisk=false，
  // 仍 fail-closed 抛 EVIDENCE_DISK_LOW（与旧版一致）。
  capacityBypassOpts(externalEffect) {
    return { externalEffect, debtOnLowDisk: this.debtOnLowDisk, debtSink: null };
  }

  start() {
    if (this.started) return;
    this.started = true;
    // REX Phase 5 §8.1 item 3：nonpayment_v1 启动期迁移历史 waiting_approval job。
    // legacy（policyMode 未 active）不迁移，保留所有 waiting_approval 人工闸。迁移在
    // pump 启动前做，确保 fresh queued job 立即被首轮 pump 派发。
    this.migrateLegacyPending();
    this.scheduler = setInterval(() => this.pump().catch(() => {}), this.schedulerIntervalMs);
    this.scheduler.unref?.();
    // Defense-in-depth: never let the initial pump become an unhandled rejection
    // (e.g. quarantined/offline devices with leftover queued jobs after restart).
    void this.pump().catch(() => {});
  }

  // 迁移历史 waiting_approval job。nonpayment_v1 active 时返回 {total,migrated,
  // reconciled,paymentLike} 报告并存 this.legacyMigrationReport；legacy 返回 null（不迁移）。
  // 幂等：已 queued_migrated 的旧行不再命中 waiting_approval 扫描，重复调用安全。
  migrateLegacyPending() {
    if (!this.debtOnLowDisk || !this.state || typeof this.state.migrateNonpaymentWaitingApprovals !== "function") {
      this.legacyMigrationReport = null;
      return null;
    }
    this.legacyMigrationReport = this.state.migrateNonpaymentWaitingApprovals({
      isPaymentLike: (job) => this.#isPaymentLikeJob(job),
      onMigrated: (freshJob) => this.#initializeMigratedRun(freshJob),
    });
    return this.legacyMigrationReport;
  }

  // 为 migration spawn 出的 fresh queued job 补建 evidence run 目录。submitJob 路径在
  // 派发前已 initializeRun，但 migration 绕过 submitJob 直接 INSERT queued job，pump 派发
  // 时 #runJob 不调 initializeRun，故在此补建，否则末尾 writeJson 落 result-*.json ENOENT。
  // low-disk/debt 情形由 initializeRun 内部 debt 旁路处理；此处失败不阻断 migration。
  #initializeMigratedRun(freshJob) {
    if (!freshJob) return;
    try {
      const device = this.state.requireDevice(freshJob.deviceId, { includeRuntime: true });
      this.evidence.initializeRun({ job: freshJob, device, ...this.capacityOpts(false) });
    } catch {}
  }

  // 保守、fail-safe 的 job 级支付分类（无 target/context，用 capability 启发式）：
  // ambiguous_on_timeout 幂等性 或 capability id 命中金融关键词 → payment-like（保持
  // waiting_approval，不迁移）；其余 → 非支付（可迁移）。歧义一律归 payment-like，
  // 保留人工闸，绝不误放支付。
  #isPaymentLikeJob(job) {
    if (!job) return false;
    const cap = job.capability || (job.capabilityId ? { id: job.capabilityId } : null);
    if (cap && cap.idempotency === "ambiguous_on_timeout") return true;
    const id = (cap && cap.id) || job.capabilityId || "";
    return /pay|payment|financial|checkout|recharge|transfer|wallet|redpacket|topup|deposit/i.test(id);
  }

  async stop() {
    this.started = false;
    clearInterval(this.scheduler);
    for (const deviceRunId of [...this.deviceRuns.heartbeats.keys()]) {
      this.deviceRuns.stopRunnerHeartbeat(deviceRunId);
    }
    await Promise.allSettled([...this.activeJobs.values()]);
  }

  // Mission-bound DeviceRun entry point. The runner auto-heartbeats its lease server-side
  // once the control loop is started, so normal progress does not depend on a caller.
  openDeviceRun(input) {
    const run = this.deviceRuns.openDeviceRun(input);
    if (this.started) this.deviceRuns.startRunnerHeartbeat(run.deviceRunId, run.token);
    return run;
  }

  assertControlTuple(tuple) {
    return this.deviceRuns.assertControlTuple(tuple);
  }

  openDiscoveryRun(input) {
    return this.discoverySessions.openDiscoveryRun(input);
  }

  heartbeatDiscoveryRun(input) {
    return this.discoverySessions.heartbeatDiscoveryRun(input);
  }

  sealDiscoveryRun(input) {
    return this.discoverySessions.sealDiscoveryRun(input);
  }

  abortDiscoveryRun(input) {
    return this.discoverySessions.abortDiscoveryRun(input);
  }

  getDiscoveryRun(discoveryRunId) {
    return this.discoverySessions.getDiscoveryRun(discoveryRunId);
  }

  // Bootstrap opts into this explicit production wiring. Unit callers that do not install it
  // fail closed rather than treating a bare reservation as a completed Discovery action.
  installDiscoveryProducer({ capabilityForPrimitive = {} } = {}) {
    // The bootstrap owns this map.  It is deliberately not accepted from a client envelope;
    // an unmapped primitive fails closed instead of inventing an adapter action.
    this.discoveryCapabilityForPrimitive = Object.freeze({ ...capabilityForPrimitive });
    this.discoveryProducer = (input) => this.#dispatchDiscoveryR0(input);
  }

  executeDiscoveryPrimitive(input) {
    // Client envelope is declared intent only.  The final firewall decision is made from the
    // producer/parser receipt in #recordDiscoveryReceipt, immediately after the read-only R0
    // operation and before that receipt can be ingested as authority.
    // A reservation is an externally visible durable allocation.  Do not create one unless
    // the authority-owned producer is actually wired: callers must never be able to turn a
    // missing production dispatcher into a misleading successful R0 reservation.
    if (!this.discoveryProducer) {
      throw new ControlPlaneError("DISCOVERY_PRODUCER_UNAVAILABLE", "Discovery R0 producer is not installed", { status: 503 });
    }
    // `installDiscoveryProducer()` marks bootstrap-owned dispatch.  Its empty default map is
    // an explicit rollout denial, so reject before reserving any durable primitive or job.
    if (this.discoveryCapabilityForPrimitive
      && typeof this.discoveryCapabilityForPrimitive[input?.primitive] !== "string") {
      throw new ControlPlaneError("DISCOVERY_PRIMITIVE_UNAVAILABLE", "no control-plane-owned R0 producer is installed for this primitive", { status: 503 });
    }
    const reservation = this.discoverySessions.executeDiscoveryPrimitive(input);
    // Reservation is committed before this isolated R0 producer is invoked. A replay never
    // reaches the producer again, so a crash leaves a durable intent rather than a duplicate.
    if (reservation.reused) return reservation;
    const evidence = this.discoveryProducer({
      discoveryRunId: reservation.discoveryRunId,
      reservationId: reservation.reservationId,
      primitive: reservation.primitive,
      tuple: input.tuple,
      token: input.token,
      envelope: input.envelope,
    });
    if (evidence && typeof evidence.then === "function") {
      return evidence.then((value) => value && typeof value === "object" ? { ...reservation, ...value } : reservation);
    }
    return evidence && typeof evidence === "object" ? { ...reservation, ...evidence } : reservation;
  }

  // Deliberately internal-only: no router or devicectl endpoint calls this path. The
  // evidence index is consulted here, before StateStore accepts any purported lineage.
  ingestDiscoveryObservation(input) {
    if (!this.evidence || typeof this.evidence.findByIdAndHash !== "function") {
      throw new ControlPlaneError("DISCOVERY_EVIDENCE_UNAVAILABLE", "Discovery observation ingestion needs the evidence index", { status: 503 });
    }
    if (typeof input?.receiptId !== "string" || input.receiptId === "") {
      throw new ControlPlaneError("DISCOVERY_INGEST_INPUT_INVALID", "Discovery ingest accepts only an opaque producer receipt", { status: 400 });
    }
    try {
      const receipt = this.state.getDiscoveryProducerReceipt?.(input.receiptId);
      if (!receipt || receipt.discoveryRunId !== input?.discoveryRunId) {
        throw new ControlPlaneError("DISCOVERY_RECEIPT_INVALID", "Discovery ingest requires a control-plane producer receipt", { status: 409 });
      }
      this.evidence.findByIdAndHash(receipt.evidenceId, receipt.evidenceHash);
      return this.discoverySessions.ingestDiscoveryObservation(input);
    } catch (error) {
      // Ingest is an internal producer boundary.  A bad/tampered receipt cannot leave an
      // active authority run behind; the StateStore CAS protects foreign leases on a stale
      // tuple and commits the terminal typed event before this error is surfaced.
      try { this.discoverySessions.abortDiscoveryRun({ discoveryRunId: input.discoveryRunId, tuple: input.tuple, reason: error.code || "DISCOVERY_INGEST_FAILED" }); } catch {}
      throw error;
    }
  }

  async #dispatchDiscoveryR0({ discoveryRunId, reservationId, primitive, tuple, token }) {
    const run = this.discoverySessions.getDiscoveryRun(discoveryRunId);
    const capabilityId = this.discoveryCapabilityForPrimitive?.[primitive];
    if (typeof capabilityId !== "string") {
      throw new ControlPlaneError("DISCOVERY_PRIMITIVE_UNAVAILABLE", "no control-plane-owned R0 producer is installed for this primitive", { status: 503 });
    }
    const session = this.state.validateSession(run.sessionId, token);
    const capability = this.capabilities.validateParams(capabilityId, {});
    const policy = evaluateCapabilityPolicy(capability, { canary: session.canary, invocation: "session", policyMode: this.policyMode });
    if (capability.risk !== "R0" || policy.approvalRequired || capability.idempotency !== "read_only") {
      throw new ControlPlaneError("DISCOVERY_PRODUCER_POLICY_INVALID", "Discovery producer must be an automatic read-only R0 capability", { status: 409 });
    }
    if (this.activeJobs.has(session.deviceId)) {
      throw new ControlPlaneError("DEVICE_BUSY", "Discovery device already has an action in progress", { status: 423 });
    }
    this.evidence.assertCapacity(this.capacityBypassOpts(false));
    const created = this.state.createJob({
      idempotencyKey: `discovery:${reservationId}`,
      actorId: session.actorId,
      authorityNodeId: this.authorityNodeId,
      deviceId: session.deviceId,
      placement: {}, capability, params: {}, canary: session.canary, sessionId: session.sessionId,
      status: "queued", approvalRequired: false, externalEffect: false,
    });
    if (created.reused) {
      if (created.job.sessionId !== session.sessionId) throw new ControlPlaneError("DISCOVERY_JOB_BINDING_CONFLICT", "Discovery reservation belongs to another session", { status: 409 });
      const prior = this.state.getDiscoveryProducerReceiptForReservation?.(reservationId);
      if (!prior) throw new ControlPlaneError("DISCOVERY_RECEIPT_UNAVAILABLE", "durable Discovery job has no completed producer receipt", { status: 409 });
      return prior;
    }
    this.state.bindDiscoveryReservationJob({ discoveryRunId, reservationId, tuple, job: created.job, gates: this.discoverySessions.gates() });
    const device = this.state.requireDevice(session.deviceId);
    this.evidence.initializeRun({ job: created.job, device, ...this.capacityOpts(false) });
    let receipt = null;
    const promise = this.#runJob(created.job, {
      lease: { leaseId: session.leaseId, token }, releaseLease: false,
      onVerified: async ({ job, execution, verification }) => {
        receipt = await this.#recordDiscoveryReceipt({ discoveryRunId, reservationId, tuple, job, execution, verification });
      },
    }).finally(() => {
      if (this.activeJobs.get(session.deviceId) === promise) this.activeJobs.delete(session.deviceId);
    });
    this.activeJobs.set(session.deviceId, promise);
    const job = await promise;
    if (job.status !== "succeeded" || !receipt) {
      throw new ControlPlaneError("DISCOVERY_PRODUCER_FAILED", "Discovery R0 producer did not yield a verified observed receipt", { status: 409, details: { jobId: job.jobId, status: job.status } });
    }
    return receipt;
  }

  async #recordDiscoveryReceipt({ discoveryRunId, reservationId, tuple, job, execution, verification }) {
    const observed = execution?.output?.discoveryReceipt;
    if (!observed || typeof observed !== "object") {
      throw new ControlPlaneError("DISCOVERY_RECEIPT_INVALID", "R0 producer must emit a parser-observed receipt", { status: 409 });
    }
    const snapshot = observed.snapshot;
    const observedVerdict = this.firewall.classifyDiscovery({
      declaredIntent: null,
      observedTargetFingerprint: observed.observedTargetFingerprint,
      snapshot,
    });
    if (observedVerdict.decision !== "auto") {
      throw new ControlPlaneError("DISCOVERY_SURFACE_BLOCKED", "parser-observed surface is not reversible R0", { status: 409, details: { reason: observedVerdict.reason } });
    }
    const required = ["snapshotHash", "app", "accountFingerprint", "pageFingerprint", "observedTargetFingerprint", "identityEvidenceHash", "anchor", "relationKind", "observedAt"];
    if (required.some((key) => observed[key] === undefined) || !observed.anchor?.type || !observed.anchor?.hash) {
      throw new ControlPlaneError("DISCOVERY_RECEIPT_INVALID", "parser receipt lacks immutable observation lineage", { status: 409 });
    }
    const payload = {
      snapshotHash: observed.snapshotHash, app: observed.app, accountFingerprint: observed.accountFingerprint,
      pageFingerprint: observed.pageFingerprint, observedTargetFingerprint: observed.observedTargetFingerprint,
      identityEvidenceHash: observed.identityEvidenceHash, anchor: observed.anchor, relationKind: observed.relationKind,
      observedAt: observed.observedAt, snapshot, recorder: `adapter:${job.capabilityId}`,
      sourceHash: fingerprint({ jobId: job.jobId, runId: job.runId, verification }),
      contentHash: fingerprint(observed),
    };
    const evidence = this.evidence.writeJson({ job, kind: "discovery_receipt", label: `discovery-receipt-${reservationId}`, value: payload });
    return this.state.recordDiscoveryProducerReceipt({ discoveryRunId, reservationId, tuple, job, evidence, receipt: payload, gates: this.discoverySessions.gates() });
  }

  markControlLost(deviceRunId, input) {
    const run = this.deviceRuns.markControlLost(deviceRunId, input);
    this.deviceRuns.stopRunnerHeartbeat(deviceRunId);
    return run;
  }

  // Internal-only control-plane ingestion point. No router exposes this method: callers must
  // already hold the full fenced tuple for a control-plane-owned DeviceRun before a hash-only
  // observation can become authority for a later Standing Grant Mission.
  recordAuthoritativeObservation({ tuple, observation }) {
    const run = this.assertControlTuple(tuple);
    const mission = this.missions.requireActiveMission(run.missionId);
    if (!observation || observation.app !== mission.app || observation.accountFingerprint !== mission.account) {
      throw new ControlPlaneError("AUTHORITATIVE_OBSERVATION_MISMATCH", "observation does not match the controlled Mission", { status: 409 });
    }
    return this.state.recordAuthoritativeObservation(observation);
  }

  // Internal-only parser boundary.  Client hints are discarded; only a known parser can supply
  // the observed surface and the ControlPlane supplies every authority tuple field itself.
  recordExplicitObservationReceipt({ tuple, sourceJobId, adapterReceiptId }) {
    const run = this.assertControlTuple(tuple);
    const mission = this.missions.requireActiveMission(run.missionId);
    if (!mission.parentGrantId || typeof sourceJobId !== "string" || typeof adapterReceiptId !== "string") {
      throw new ControlPlaneError("EXPLICIT_RECEIPT_PROVENANCE_REQUIRED", "explicit receipt requires an opaque adapter receipt and source job", { status: 409 });
    }
    const sourceJob = this.state.getJob(sourceJobId);
    const adapterId = sourceJob?.capability?.implementation?.adapter;
    let adapter = null;
    try { adapter = typeof adapterId === "string" ? this.adapters.require(adapterId) : null; } catch { adapter = null; }
    if (!sourceJob || sourceJob.status !== "succeeded" || sourceJob.sessionId !== run.sessionId || sourceJob.deviceId !== run.deviceId
      || typeof adapter?.getExplicitObservationReceipt !== "function") {
      throw new ControlPlaneError("EXPLICIT_RECEIPT_PROVENANCE_INVALID", "no allowlisted adapter-produced receipt is available", { status: 409 });
    }
    if (!this.receiptAuthorityAllowlist.has(`${sourceJob.capabilityId}:${adapterId}`)) {
      throw new ControlPlaneError("EXPLICIT_RECEIPT_PRODUCER_NOT_ALLOWED", "receipt source is not explicitly authorized", { status: 409 });
    }
    const parserReceipt = adapter.getExplicitObservationReceipt({ job: sourceJob, receiptId: adapterReceiptId });
    const fields = ["pageFingerprint", "targetFingerprint", "observedAt", "evidenceId", "evidenceHash"];
    if (fields.some((key) => typeof parserReceipt?.[key] !== "string" || parserReceipt[key] === "")) throw new ControlPlaneError("EXPLICIT_RECEIPT_INVALID", "adapter receipt is incomplete", { status: 409 });
    try {
      if (typeof this.evidence?.findByIdAndHash !== "function") throw new Error("evidence lookup unavailable");
      this.evidence.findByIdAndHash(parserReceipt.evidenceId, parserReceipt.evidenceHash);
    } catch {
      throw new ControlPlaneError("EXPLICIT_RECEIPT_EVIDENCE_UNAVAILABLE", "receipt evidence cannot be read and hash-verified", { status: 409 });
    }
    return this.state.recordExplicitObservationReceipt({
      grantId: mission.parentGrantId, grantHash: mission.parentGrantHash, missionId: mission.missionId,
      deviceRunId: run.deviceRunId, leaseId: run.leaseId, sessionId: run.sessionId,
      controllerEpoch: run.controllerEpoch, app: mission.app, accountFingerprint: mission.account,
      pageFingerprint: parserReceipt.pageFingerprint, targetFingerprint: parserReceipt.targetFingerprint,
      observedAt: parserReceipt.observedAt, evidenceId: parserReceipt.evidenceId, evidenceHash: parserReceipt.evidenceHash,
      sourceJobId: sourceJob.jobId, sourceRunId: sourceJob.runId, sourceAdapterId: adapterId, sourceCapabilityId: sourceJob.capabilityId,
    });
  }

  createEffectCommitProtocol(handlers) {
    return new EffectCommitProtocol({
      state: this.state,
      ledger: this.effectLedger,
      deviceRuns: this.deviceRuns,
      missions: this.missions,
      evidence: this.evidence,
      ...handlers,
    });
  }

  createProtectedHumanCommit(handlers) {
    return new ProtectedHumanCommit({
      state: this.state,
      audit: (event) => {
        if (event?.missionId) {
          this.state.appendMissionEvent({
            missionId: event.missionId,
            type: event.type,
            payload: { commitId: event.commitId, action: event.action, actorId: event.actorId || null },
          });
        }
      },
      ...handlers,
    });
  }

  // ADR 0008 acceptance is read out-of-band from the ADR file unless a boolean override was
  // injected (tests). The file remains the source of truth; this method never mutates it.
  isAdr0008Accepted() {
    if (this.adrAcceptedOverride !== null && this.adrAcceptedOverride !== undefined) {
      return Boolean(this.adrAcceptedOverride);
    }
    return readAdrStatusAccepted(this.adrPath);
  }

  // Standing Grant delegation is independently governed by ADR 0009.  As with ADR 0008,
  // an override exists only for isolated tests; production reads the status lazily and never
  // changes the ADR document.
  isAdr0009Accepted() {
    if (this.standingGrantAdrAcceptedOverride !== null && this.standingGrantAdrAcceptedOverride !== undefined) {
      return Boolean(this.standingGrantAdrAcceptedOverride);
    }
    return readAdrStatusAccepted(this.standingGrantAdrPath);
  }

  // DiscoverySession has its own rollout decision. ADR 0008 authorizes the Mission
  // auto-approval lane only; it must never open pre-Mission discovery by implication.
  isAdr0010Accepted() {
    if (this.discoveryAdrAcceptedOverride !== null && this.discoveryAdrAcceptedOverride !== undefined) {
      return Boolean(this.discoveryAdrAcceptedOverride);
    }
    return readAdrStatusAccepted(this.discoveryAdrPath);
  }

  // The automatic-R2 Mission path requires BOTH the feature flag AND an accepted ADR 0008.
  // On either failure it must block before any DeviceRun/lease/Session/effect is allocated and
  // never degrade to legacy manual-per-effect handling. The single failure code is
  // ADR_0008_NOT_ACCEPTED so callers cannot tell "flag off" from "ADR not accepted" and
  // infer a partial rollout state.
  #missionAutoApprovalGate() {
    if (!this.missionAutoApprovalEnabled || !this.isAdr0008Accepted()) {
      return { ok: false, code: "ADR_0008_NOT_ACCEPTED" };
    }
    return { ok: true };
  }

  #standingGrantGate() {
    if (!this.standingGrantEnabled || !this.missionAutoApprovalEnabled || !this.isAdr0008Accepted() || !this.isAdr0009Accepted()) {
      return { ok: false, code: "STANDING_GRANT_NOT_ENABLED" };
    }
    return { ok: true };
  }

  // The one authenticated command that creates/reuses the immutable Mission and runs it. It
  // never accepts a client-selected private runtime/device id (placement is server-side). With
  // the gate closed it persists only a blocked Mission/audit event and returns
  // ADR_0008_NOT_ACCEPTED before any run/lease/Session/effect row exists. With the gate open an
  // in-scope social Mission opens its atomic DeviceRun with no whole-Mission or per-job
  // approval; payment and unreleased publish/delete still route to the PHC at effect time.
  submitMission({ actor, idempotencyKey, policy, parentGrantId = null, controllerAgent, placement = {} }) {
    if (typeof actor !== "string" || actor.trim() === "") {
      throw new ControlPlaneError("ACTOR_REQUIRED", "actor is required", { status: 400 });
    }
    if (typeof idempotencyKey !== "string" || idempotencyKey.trim() === "") {
      throw new ControlPlaneError("IDEMPOTENCY_KEY_REQUIRED", "idempotencyKey is required", { status: 400 });
    }
    if (!policy || typeof policy !== "object") {
      throw new ControlPlaneError("MISSION_POLICY_INVALID", "policy is required", { status: 400 });
    }
    // The bound device runtime is selected by the control plane, never by the caller. Rejecting
    // a client-supplied runtimeId/deviceId keeps a private runtime anchor from being spoofed.
    if (policy.runtimeId !== undefined || policy.deviceId !== undefined) {
      throw new ControlPlaneError(
        "CLIENT_RUNTIME_FORBIDDEN",
        "mission submit does not accept a client-selected private runtime or device id",
        { status: 400 },
      );
    }
    const controller = (typeof controllerAgent === "string" && controllerAgent.trim())
      ? controllerAgent.trim()
      : "agent:runner";
    const controllers = (Array.isArray(policy.controllers) && policy.controllers.length)
      ? policy.controllers
      : [controller];
    if (parentGrantId && policy.issuer !== undefined) {
      throw new ControlPlaneError("CLIENT_ISSUER_FORBIDDEN", "a parent-grant Mission cannot select its issuer", { status: 400 });
    }
    const missionInput = {
      ...policy,
      issuer: { actorId: actor.trim() },
      idempotencyKey: idempotencyKey.trim(),
      controllers,
    };
    const { mission, reused } = parentGrantId
      ? this.missions.createMissionFromGrant({ parentGrantId, input: missionInput })
      : this.missions.createMission(missionInput);
    const gate = parentGrantId ? this.#standingGrantGate() : this.#missionAutoApprovalGate();
    if (!gate.ok) {
      this.state.appendMissionEvent({
        missionId: mission.missionId,
        type: "mission.submit.blocked",
        payload: { code: gate.code, actorId: actor.trim(), controllerAgent: controller },
      });
      return { status: "blocked", reason: gate.code, mission, reused, approvalRequired: false };
    }
    const run = this.openDeviceRun({ missionId: mission.missionId, controllerAgent: controller, placement });
    this.state.appendMissionEvent({
      missionId: mission.missionId,
      type: "mission.submitted",
      payload: { actorId: actor.trim(), deviceRunId: run.deviceRunId, controllerAgent: controller },
    });
    return { status: "running", mission, reused, run, approvalRequired: false };
  }

  async runStandingGrantCollectCanary({ actor, idempotencyKey, parentGrantId, sourceJobId, adapterReceiptId, controllerAgent = "agent:runner" }) {
    const sourceJob = this.state.getJob(sourceJobId);
    const parent = this.state.getDelegationGrantRecord(parentGrantId);
    if (!sourceJob || sourceJob.status !== "succeeded" || sourceJob.capabilityId !== "xhs.observe.note_detail" || !parent || parent.status !== "active") {
      throw new ControlPlaneError("CANARY_PREREQUISITE_INVALID", "active signed Grant and succeeded note-detail observation are required", { status: 409 });
    }
    const sourceAdapter = this.adapters.require(sourceJob.capability.implementation.adapter);
    const sourceReceipt = sourceAdapter.getExplicitObservationReceipt?.({ job: sourceJob, receiptId: adapterReceiptId });
    if (!sourceReceipt || !parent.grant.targets?.values?.includes(sourceReceipt.targetFingerprint)
      || parent.grant.authorization?.socialActions?.length !== 1 || parent.grant.authorization.socialActions[0] !== "collect") {
      throw new ControlPlaneError("CANARY_TARGET_NOT_SIGNED", "note-detail target is not the signed collect-only Grant target", { status: 409 });
    }
    this.evidence.findByIdAndHash(sourceReceipt.evidenceId, sourceReceipt.evidenceHash);
    const reservation = this.state.reserveStandingGrantCanary({ idempotencyKey, grantId: parentGrantId, sourceJobId });
    if (reservation.reused) {
      return { reused: true, status: reservation.marker.status, outcome: reservation.marker.outcome };
    }
    const device = this.state.requireDevice(sourceJob.deviceId);
    const parentExpiry = Date.parse(parent.grant.validity?.expiresAt);
    const expiresAt = new Date(Number.isFinite(parentExpiry) ? Math.min(Date.now() + 10 * 60 * 1000, parentExpiry - 1) : Date.now() + 10 * 60 * 1000).toISOString();
    const policy = {
      app: parent.grant.app,
      account: parent.grant.accountFingerprint,
      parallelism: 1,
      controllers: [controllerAgent],
      scope: { actions: ["collect"], targets: { kind: "fingerprint", values: [sourceReceipt.targetFingerprint] }, totalCount: 1, perTargetCount: 1, frequency: { count: 1, windowSeconds: 3600 } },
      validity: { expiresAt },
      policy: { payment: "confirm", publish: "confirm", delete: "confirm" },
    };
    let submission;
    let run;
    let collectJob = null;
    let collectCreated = null;
    let terminalStatus = "failed";
    let outcome = "CANARY_FAILED";
    let retainCanaryMarker = false;
    try {
      submission = this.submitMission({ actor, idempotencyKey: `${idempotencyKey}:mission`, parentGrantId, controllerAgent, policy, placement: { physicalLabel: device.physicalLabel } });
      if (submission.status !== "running") throw new ControlPlaneError(submission.reason || "CANARY_GATE_CLOSED", "Standing Grant canary gate is closed", { status: 409 });
      run = submission.run;
      this.state.bindStandingGrantCanary({ missionId: submission.mission.missionId, deviceRunId: run.deviceRunId });

      const observeCapability = this.capabilities.validateParams("xhs.observe.note_detail", {});
      const observeCreated = this.state.createJob({
        idempotencyKey: `${idempotencyKey}:observe`, actorId: controllerAgent, authorityNodeId: this.authorityNodeId,
        deviceId: run.deviceId, placement: {}, capability: observeCapability, params: {}, canary: true,
        sessionId: run.sessionId, status: "queued", approvalRequired: false, externalEffect: false,
      });
      if (!observeCreated.reused) this.evidence.initializeRun({ job: observeCreated.job, device, ...this.capacityOpts(false) });
      const observationJob = observeCreated.reused ? observeCreated.job : await this.#runJob(observeCreated.job, { lease: { leaseId: run.leaseId, token: run.token }, releaseLease: false });
      if (observationJob.status !== "succeeded") throw new ControlPlaneError("CANARY_OBSERVATION_FAILED", "in-Mission note re-observation failed", { status: 409 });
      const sealed = observationJob.result?.explicitObservationReceipt;
      if (!sealed || sealed.targetFingerprint !== sourceReceipt.targetFingerprint) throw new ControlPlaneError("CANARY_TARGET_DRIFT", "note target changed before collect", { status: 409 });
      const receipt = this.recordExplicitObservationReceipt({ tuple: run.tuple, sourceJobId: observationJob.jobId, adapterReceiptId: sealed.receiptId });
      if (receipt.status !== "recorded") throw new ControlPlaneError("EXPLICIT_RECEIPT_INVALID", "fresh explicit receipt was not recorded", { status: 409 });

      const params = { observationReceiptId: receipt.receiptId, targetFingerprint: sealed.targetFingerprint };
      const collectCapability = this.capabilities.validateParams("xhs.collect.standing_grant", params);
      evaluateCapabilityPolicy(collectCapability, { canary: true, invocation: "mission_effect", policyMode: this.policyMode });
      collectCreated = this.state.createJob({
        idempotencyKey: `${idempotencyKey}:collect`, actorId: controllerAgent, authorityNodeId: this.authorityNodeId,
        deviceId: run.deviceId, placement: {}, capability: collectCapability, params, canary: true,
        sessionId: run.sessionId, status: "queued", approvalRequired: false, externalEffect: true,
      });
      if (!collectCreated.reused) this.evidence.initializeRun({ job: collectCreated.job, device, ...this.capacityOpts(false) });
      this.state.bindStandingGrantCanary({ missionId: submission.mission.missionId, deviceRunId: run.deviceRunId, collectJobId: collectCreated.job.jobId });
      const ecp = this.createEffectCommitProtocol({
        recheck: async () => ({ readiness: { ready: true, source: "control-plane", fresh: true }, app: parent.grant.app, account: parent.grant.accountFingerprint, targetFingerprint: sealed.targetFingerprint, pageFingerprint: sealed.pageFingerprint, beforeState: "not_collected", control: true }),
        execute: async () => {
          collectJob = collectCreated.reused ? collectCreated.job : await this.#runJob(collectCreated.job, { lease: { leaseId: run.leaseId, token: run.token }, releaseLease: false });
          if (collectJob.status !== "succeeded") {
            const error = new ControlPlaneError(collectJob.status === "failed" ? "NOT_SENT" : (collectJob.errorCode || "CANARY_COLLECT_FAILED"), "collect job did not succeed", { status: 409, details: { jobErrorCode: collectJob.errorCode || null } });
            error.ambiguous = ["ambiguous", "recovery_required"].includes(collectJob.status);
            error.notSent = collectJob.status === "failed";
            throw error;
          }
          return { jobId: collectJob.jobId, runId: collectJob.runId, result: collectJob.result };
        },
        verify: async () => ({ ok: collectJob?.status === "succeeded", evidenceRefs: collectJob ? [collectJob.runId] : [] }),
        restore: async () => ({ ok: true }),
      });
      const effect = await ecp.commit({ tuple: run.tuple, mission: submission.mission, action: "collect", target: sealed.targetFingerprint, idempotencyKey: `${idempotencyKey}:effect`, observationReceiptId: receipt.receiptId });
      const explicitlyNoEffect = ["blocked", "not_sent", "cancelled"].includes(effect.status)
        || (effect.status === "failed" && effect.noExternalEffect === true);
      retainCanaryMarker = !explicitlyNoEffect;
      terminalStatus = effect.status === "verified" ? "completed" : retainCanaryMarker ? "ambiguous" : "failed";
      outcome = effect.status;
      return { status: terminalStatus, missionId: submission.mission.missionId, deviceRunId: run.deviceRunId, jobId: collectJob?.jobId || null, runId: collectJob?.runId || null, effectStatus: effect.status, restoration: collectJob?.result?.restoration || null };
    } catch (error) {
      retainCanaryMarker = Boolean(collectCreated && error?.notSent !== true);
      terminalStatus = retainCanaryMarker ? "ambiguous" : "blocked";
      outcome = error?.code || "CANARY_FAILED";
      throw error;
    } finally {
      if (run) {
        this.deviceRuns.stopRunnerHeartbeat(run.deviceRunId);
        try { this.state.finishDeviceRunStorage({ tuple: run.tuple, phase: terminalStatus === "completed" ? "succeeded" : terminalStatus === "ambiguous" ? "ambiguous" : "blocked", outcome }); } catch {}
      }
      if (submission?.mission?.missionId) {
        try { this.missions.revokeMission(submission.mission.missionId, { actorId: actor, reason: `canary_terminal:${outcome}` }); } catch {}
      }
      const collectJobState = collectCreated ? this.state.getJob(collectCreated.job.jobId) : null;
      if (["queued", "waiting_approval"].includes(collectJobState?.status)) {
        try { this.state.cancelJob(collectJobState.jobId); } catch {}
      }
      if (retainCanaryMarker) {
        try { this.state.finishStandingGrantCanary({ status: terminalStatus, outcome }); } catch {}
      } else if (!collectCreated) {
        try { this.state.releaseStandingGrantCanaryReservation({ idempotencyKey }); } catch {}
      } else {
        try { this.state.releaseStandingGrantCanaryNoEffect({ idempotencyKey, outcome }); } catch {}
      }
    }
  }

  showMission(missionId) {
    const mission = this.state.getMission(missionId);
    if (!mission) throw new ControlPlaneError("MISSION_NOT_FOUND", `unknown mission ${missionId}`, { status: 404 });
    return {
      mission,
      deviceRuns: this.state.listDeviceRuns({ missionId }),
      events: this.state.listMissionEvents(missionId),
    };
  }

  missionStatus(missionId) {
    const mission = this.state.getMission(missionId);
    if (!mission) throw new ControlPlaneError("MISSION_NOT_FOUND", `unknown mission ${missionId}`, { status: 404 });
    const deviceRuns = this.state.listDeviceRuns({ missionId });
    return {
      missionId,
      status: mission.status,
      deviceRunCount: deviceRuns.length,
      effectCount: this.state.listMissionEffects(missionId).length,
    };
  }

  // revoke cancels further work: the mission flips to revoked so every later primitive/effect
  // is blocked by the classifier. It makes no claim that an already-ambiguous external effect
  // was undone (terminal effects stay terminal). It does not fabricate a human approval.
  revokeMission(missionId, { actorId, reason = null } = {}) {
    return this.missions.revokeMission(missionId, { actorId, reason });
  }

  // Mission-bound Explorer primitive. Validates the complete control tuple, classifies the
  // effect-intent envelope against the fresh observed surface, takes the shared transport lock,
  // records a durable primitive event, and releases the lock. No typed action ID, actionId, or
  // Workflow DSL is required. The verdict drives the ECP/PHC (Task 4); a blocked verdict is
  // recorded and returned, never silently dropped or disguised as an approval.
  async executeMissionPrimitive(tuple, { primitive, envelope }) {
    if (typeof primitive !== "string" || primitive.trim() === "") {
      throw new ControlPlaneError("PRIMITIVE_REQUIRED", "primitive is required", { status: 400 });
    }
    if (!envelope || typeof envelope !== "object") {
      throw new ControlPlaneError("ENVELOPE_REQUIRED", "effect-intent envelope is required", { status: 400 });
    }
    // Validate the envelope against the canonical effect-intent schema. The primitive is part
    // of the envelope contract, so it is merged in before validation; this keeps existing
    // callers (which pass primitive separately) compliant without changing their payloads.
    // A schema-invalid envelope is rejected before any tuple check, classification, or effect.
    const mergedEnvelope = { schemaVersion: 1, primitive, ...envelope };
    if (!this.effectIntentSchema) {
      throw new ControlPlaneError(
        "EFFECT_INTENT_SCHEMA_UNAVAILABLE",
        "effect-intent schema is unavailable; Mission primitives are blocked",
        { status: 503 },
      );
    }
    const errors = validateJsonSchema(mergedEnvelope, this.effectIntentSchema);
    if (errors.length > 0) {
      throw new ControlPlaneError(
        "ENVELOPE_SCHEMA_INVALID",
        "effect-intent envelope does not match the runtime schema",
        { status: 400, details: { errors: errors.slice(0, 10) } },
      );
    }
    const run = this.assertControlTuple(tuple);
    const mission = this.missions.requireActiveMission(tuple.missionId);
    const verdict = this.firewall.classify(mergedEnvelope, mission);
    const release = await this.acquireTransportLock();
    try {
      const payload = {
        deviceRunId: run.deviceRunId,
        primitive,
        verdict: {
          code: verdict.code,
          decision: verdict.decision,
          surface: verdict.surface ?? null,
          reason: verdict.reason,
          ...(verdict.effectAction ? { effectAction: verdict.effectAction } : {}),
        },
      };
      this.state.appendMissionEvent({ missionId: tuple.missionId, type: "mission.primitive", payload });
      this.state.appendEvent({ runId: run.deviceRunId, type: "mission.primitive", payload });
      try {
        this.evidence.appendEvent(run.deviceRunId, {
          type: "mission.primitive",
          primitive,
          verdict: payload.verdict,
          createdAt: new Date().toISOString(),
        });
      } catch {
        // SQLite is the durable audit authority; JSONL evidence mirroring is best-effort.
      }
      return { deviceRunId: run.deviceRunId, primitive, verdict, recorded: true };
    } finally {
      try { release(); } catch {}
    }
  }

  submitJob({
    idempotencyKey,
    actorId,
    deviceId = null,
    placement = {},
    capabilityId,
    params = {},
    canary = false,
  }) {
    const capability = this.capabilities.validateParams(capabilityId, params);
    const policy = evaluateCapabilityPolicy(capability, { canary, invocation: "job", policyMode: this.policyMode });
    this.evidence.assertCapacity(this.capacityBypassOpts(policy.externalEffect));
    const created = this.state.createJob({
      idempotencyKey,
      actorId,
      authorityNodeId: this.authorityNodeId,
      deviceId,
      placement,
      capability,
      params,
      canary,
      status: policy.approvalRequired ? "waiting_approval" : "queued",
      approvalRequired: policy.approvalRequired,
      externalEffect: policy.externalEffect,
    });
    if (!created.reused) {
      const device = this.state.requireDevice(created.job.deviceId);
      this.evidence.initializeRun({ job: created.job, device, ...this.capacityOpts(policy.externalEffect) });
      if (created.job.status === "queued") queueMicrotask(() => void this.pump());
    }
    return {
      ...created,
      storage: this.evidence.storageForRun(created.job.runId),
    };
  }

  planRoute({
    actorId,
    capabilityId,
    params = {},
    canary = false,
    deviceId = null,
    placement = {},
    invocation = "job",
  }) {
    if (typeof actorId !== "string" || actorId.trim() === "") {
      throw new ControlPlaneError("ACTOR_REQUIRED", "actorId is required");
    }
    try {
      const capability = this.capabilities.validateParams(capabilityId, params);
      const policy = evaluateCapabilityPolicy(capability, { canary, invocation, policyMode: this.policyMode });
      const route = this.state.planPlacement({
        authorityNodeId: this.authorityNodeId,
        capability,
        deviceId,
        placement,
        invocation,
        canary,
      });
      return {
        ...route,
        approvalRequired: policy.approvalRequired,
        externalEffect: policy.externalEffect,
        transport: capability.resources.includes("transport:xiaowei:22222")
          ? this.transportStatus()
          : { status: "not_required", ageMs: null },
      };
    } catch (error) {
      if (["NO_ELIGIBLE_DEVICE", "NODE_UNAVAILABLE", "PLACEMENT_CONFLICT", "DEVICE_BUSY"].includes(error?.code)) {
        return {
          decision: "blocked",
          advisory: true,
          error: {
            code: error.code,
            message: error.message,
            details: error.details || {},
          },
        };
      }
      throw error;
    }
  }

  listNodes() {
    const transport = this.transportStatus();
    return this.state.listNodes().map((node) => ({
      ...node,
      transport: node.nodeId === this.authorityNodeId ? transport : { status: "unknown", ageMs: null },
    }));
  }

  decideApproval(jobId, input) {
    const job = this.state.decideApproval(jobId, input);
    if (job.status === "queued") queueMicrotask(() => void this.pump());
    return job;
  }

  // REX Phase 2 收尾: payment control surface. list/decide operate on durable protected_commits
  // rows + the in-process live handle index. The DTO returns only the redacted human-confirmation
  // binding; it never exposes control tokens, internal tuples, adapter params or private keys.
  listPaymentCommits() {
    return this.state.listProtectedCommits({ action: "payment", status: "waiting_authorization" })
      .map((row) => this.#publicPaymentCommit(row));
  }

  // The execution path (or a test) calls this after a financial_commit tripwire hold to register
  // the live PHC handle that owns commitId. Only a registered live handle can be decided.
  registerPaymentCommitOwner(commitId, phc) {
    if (!commitId || !phc) throw new TypeError("commitId and phc are required");
    this.paymentCommitOwners.set(commitId, phc);
  }

  // Convenience for the execution path / tests: create a payment PHC with this plane's verifier
  // and state, begin a commit, and register its live handle. Returns the PHC begin() result.
  async beginPaymentCommit(input, { ecp } = {}) {
    if (!ecp) throw new TypeError("beginPaymentCommit requires an ecp");
    const phc = new ProtectedHumanCommit({
      ecp,
      state: this.state,
      approvalVerifier: this.paymentApprovalVerifier,
      now: this.now,
      audit: (event) => {
        if (event?.missionId) {
          this.state.appendMissionEvent({
            missionId: event.missionId,
            type: event.type,
            payload: { commitId: event.commitId, action: event.action, actorId: event.actorId || null },
          });
        }
      },
    });
    const begun = await phc.begin(input);
    if (begun?.commitId) this.registerPaymentCommitOwner(begun.commitId, phc);
    return begun;
  }

  async decidePaymentCommit(commitId, { decision, approval = null, actorId = null } = {}) {
    if (!commitId) throw new ControlPlaneError("PAYMENT_COMMIT_REQUIRED", "commitId is required", { status: 400 });
    if (!["approve", "deny"].includes(decision)) {
      throw new ControlPlaneError("PAYMENT_COMMIT_DECISION_INVALID", "decision must be approve or deny", { status: 400 });
    }
    const owner = this.paymentCommitOwners.get(commitId);
    if (!owner) {
      const row = this.state.getProtectedCommit(commitId);
      if (!row) {
        throw new ControlPlaneError("PAYMENT_COMMIT_NOT_FOUND", `unknown payment commit ${commitId}`, { status: 404 });
      }
      // A durable row without a live handle means control was lost (e.g. restart). The human must
      // re-observe and begin a new commit; the old row stays as a terminal audit record.
      throw new ControlPlaneError(
        row.status === "waiting_authorization" ? "PAYMENT_COMMIT_NOT_LIVE" : "PAYMENT_COMMIT_ALREADY_DECIDED",
        row.status === "waiting_authorization"
          ? "payment commit lost its live handle; re-observe and begin a new commit"
          : `payment commit already ${row.status}`,
        { status: 409 },
      );
    }
    const result = await owner.decide(commitId, { decision, approval, actorId });
    // Terminal decisions release the live handle; the durable audit row is retained by the PHC.
    if (result?.status !== "waiting_authorization") this.paymentCommitOwners.delete(commitId);
    return result;
  }

  #publicPaymentCommit(row) {
    const binding = row.approvalBinding || null;
    return {
      commitId: row.commitId,
      status: row.status,
      action: row.action,
      effectId: row.effectId,
      expiresAt: row.expiresAt,
      approvalBinding: binding ? {
        runId: binding.runId,
        effectId: binding.effectId,
        app: binding.app,
        accountRef: binding.accountRef,
        payeeRef: binding.payeeRef,
        amount: binding.amount,
        currency: binding.currency,
        targetControlFingerprint: binding.targetControlFingerprint,
        snapshotHash: binding.snapshotHash,
        deviceId: binding.deviceId,
        createdAt: binding.createdAt,
        expiresAt: binding.expiresAt,
      } : null,
    };
  }

  cancelJob(jobId) {
    return this.state.cancelJob(jobId);
  }

  async recoverJob({ jobId, actorId, idempotencyKey }) {
    if (typeof actorId !== "string" || actorId.trim() === "") {
      throw new ControlPlaneError("ACTOR_REQUIRED", "actorId is required");
    }
    if (typeof idempotencyKey !== "string" || idempotencyKey.trim() === "") {
      throw new ControlPlaneError("IDEMPOTENCY_KEY_REQUIRED", "idempotencyKey is required");
    }
    const job = this.state.requireJob(jobId);
    const prior = this.state.listJobEvents(jobId).find((event) =>
      ["job.recovery.succeeded", "job.recovery.failed"].includes(event.type)
      && event.payload?.idempotencyKey === idempotencyKey);
    if (prior?.type === "job.recovery.succeeded") {
      return { ...prior.payload.recovery, reused: true };
    }
    if (prior?.type === "job.recovery.failed") {
      throw new ControlPlaneError(
        "RECOVERY_PREVIOUSLY_FAILED",
        "this recovery idempotency key already failed; inspect evidence before using a new key",
        { status: 409, details: { jobId, deviceId: job.deviceId } },
      );
    }
    if (job.status !== "recovery_required") {
      throw new ControlPlaneError("RECOVERY_NOT_REQUIRED", "job is not recovery_required", {
        status: 409,
        details: { jobId, status: job.status },
      });
    }
    const device = this.state.requireDevice(job.deviceId, {
      includeRuntime: true,
      requireReady: false,
    });
    if (!device.online) {
      throw new ControlPlaneError("DEVICE_OFFLINE", `${device.alias} is offline`, { status: 409 });
    }
    if (!device.quarantined) {
      throw new ControlPlaneError("DEVICE_NOT_QUARANTINED", `${device.alias} is not quarantined`, {
        status: 409,
      });
    }
    const capability = this.capabilities.require(job.capabilityId);
    const adapter = this.adapters.require(capability.implementation.adapter);
    if (typeof adapter.restore !== "function") {
      throw new ControlPlaneError("RECOVERY_UNAVAILABLE", "capability adapter has no restoration path", {
        status: 409,
      });
    }

    let lease = this.state.acquireLease({
      deviceId: job.deviceId,
      kind: "recovery",
      holderId: `recovery:${actorId.trim()}`,
      jobId: job.jobId,
      ttlMs: this.leaseTtlMs,
      allowQuarantined: true,
    });
    let heartbeatError = null;
    const heartbeat = setInterval(() => {
      try {
        this.state.heartbeatLease(lease.leaseId, lease.token, this.leaseTtlMs);
      } catch (error) {
        heartbeatError = error;
      }
    }, this.leaseHeartbeatMs);
    heartbeat.unref?.();
    const appendRecoveryEvent = (type, payload) => {
      const eventId = this.state.appendEvent({ jobId: job.jobId, runId: job.runId, type, payload });
      try {
        this.evidence.appendEvent(job.runId, {
          type,
          jobId: job.jobId,
          createdAt: new Date().toISOString(),
          ...payload,
        });
      } catch {
        // SQLite is the durable audit authority; JSONL mirroring is best-effort.
      }
      return eventId;
    };
    try {
      const recoveryStartedEventId = appendRecoveryEvent("job.recovery.started", {
        actorId: actorId.trim(),
        idempotencyKey,
        deviceId: job.deviceId,
      });
      const restoration = await adapter.restore({
        job,
        capability,
        device,
        params: job.params,
        evidenceDirectory: this.evidence.runDirectory(job.runId),
        leaseAuthorization: {
          leaseId: lease.leaseId,
          token: lease.token,
          deviceId: job.deviceId,
          controlUrl: this.operatorControlUrl,
        },
        execution: null,
        verification: null,
        error: null,
        recoveryAttempt: true,
      });
      if (heartbeatError) throw heartbeatError;
      const attached = [];
      for (const file of collectEvidenceFiles(restoration)) {
        attached.push(await this.evidence.attachFile({
          job,
          sourcePath: file.path,
          kind: file.kind || "adapter",
          label: file.label,
        }));
      }
      if (restoration?.evidenceRequired === true
        && !attached.some((item) => item.kind === "screenshot")) {
        throw new ControlPlaneError(
          "RECOVERY_SCREENSHOT_MISSING",
          "device recovery must attach a fresh screenshot before clearing quarantine",
          { status: 500 },
        );
      }
      if (restoration?.ok !== true) {
        throw new ControlPlaneError("RESTORATION_FAILED", "adapter restoration did not verify a safe state", {
          status: 409,
        });
      }
      let visualConfirmation = null;
      if (restoration?.visualConfirmationRequired === true) {
        const events = this.state.listJobEvents(job.jobId);
        const safeAnalysis = events.findLast((event) => event.type === "job.recovery.analysis.recorded"
          && event.eventId < recoveryStartedEventId
          && event.payload?.analysisResult?.pageClassification?.pageType === "main-safe"
          && event.payload?.analysisResult?.pageClassification?.safeStateVerified === true);
        const analysisAgeMs = safeAnalysis ? Date.now() - Date.parse(safeAnalysis.createdAt) : Infinity;
        const interveningRecovery = safeAnalysis && events.some((event) =>
          event.type === "job.recovery.started"
          && event.eventId > safeAnalysis.eventId
          && event.eventId < recoveryStartedEventId);
        if (restoration.zeroActionVerified !== true || !safeAnalysis
          || !Number.isFinite(analysisAgeMs) || analysisAgeMs < 0 || analysisAgeMs > 5 * 60 * 1000
          || interveningRecovery) {
          throw new ControlPlaneError(
            "RECOVERY_VISUAL_CONFIRMATION_REQUIRED",
            "fresh visual main-page confirmation and a zero-action recovery are required before clearing quarantine",
            {
              status: 409,
              details: {
                zeroActionVerified: restoration.zeroActionVerified === true,
                safeAnalysisFound: Boolean(safeAnalysis),
                analysisFresh: Number.isFinite(analysisAgeMs) && analysisAgeMs >= 0
                  && analysisAgeMs <= 5 * 60 * 1000,
                interveningRecovery: Boolean(interveningRecovery),
              },
            },
          );
        }
        visualConfirmation = {
          inspectionId: safeAnalysis.payload.analysisResult.inspectionId,
          imageSha256: safeAnalysis.payload.analysisResult.imageSha256,
          confidence: safeAnalysis.payload.analysisResult.pageClassification.confidence,
          analysisEvidenceId: safeAnalysis.payload.analysisResult.analysisEvidence?.evidenceId || null,
        };
      }
      clearInterval(heartbeat);
      this.state.releaseLease(lease.leaseId, lease.token);
      lease = null;
      const recovery = {
        ok: true,
        reused: false,
        jobId: job.jobId,
        runId: job.runId,
        deviceId: job.deviceId,
        restoration: {
          ok: true,
          step: restoration.step || null,
          safeStateVerified: restoration.safeStateVerified === true,
          evidenceIds: attached.map((item) => item.evidenceId),
          visualConfirmation,
        },
        quarantineCleared: true,
      };
      const successPayload = {
        actorId: actorId.trim(),
        idempotencyKey,
        deviceId: job.deviceId,
        recovery,
      };
      this.state.completeDeviceRecovery({
        deviceId: job.deviceId,
        jobId: job.jobId,
        runId: job.runId,
        payload: successPayload,
      });
      try {
        this.evidence.appendEvent(job.runId, {
          type: "job.recovery.succeeded",
          jobId: job.jobId,
          createdAt: new Date().toISOString(),
          ...successPayload,
        });
      } catch {
        // The transactional SQLite event remains authoritative.
      }
      return recovery;
    } catch (error) {
      const cause = asControlError(error, "RECOVERY_FAILED");
      appendRecoveryEvent("job.recovery.failed", {
        actorId: actorId.trim(),
        idempotencyKey,
        deviceId: job.deviceId,
        causeCode: cause.code,
        // 只落结构化诊断。原始 stdout/stderr 可能含 private runtime 或设备内容，禁止持久化。
        adapterCode: cause.details?.adapterCode ?? null,
        adapterExitCode: cause.details?.exitCode ?? null,
        adapterStderrPresent: cause.details?.stderrPresent === true,
      });
      throw new ControlPlaneError("RECOVERY_FAILED", "device recovery did not verify a safe state", {
        status: 409,
        details: { jobId: job.jobId, deviceId: job.deviceId, causeCode: cause.code },
        cause,
      });
    } finally {
      clearInterval(heartbeat);
      if (lease) {
        try {
          this.state.releaseLease(lease.leaseId, lease.token);
        } catch {
          // Lease expiry remains fail-closed; the device stays quarantined.
        }
      }
    }
  }

  async inspectRecovery({ jobId, actorId, idempotencyKey }) {
    if (typeof actorId !== "string" || actorId.trim() === "") {
      throw new ControlPlaneError("ACTOR_REQUIRED", "actorId is required");
    }
    if (typeof idempotencyKey !== "string" || idempotencyKey.trim() === "") {
      throw new ControlPlaneError("IDEMPOTENCY_KEY_REQUIRED", "idempotencyKey is required");
    }
    const normalizedIdempotencyKey = idempotencyKey.trim();
    const job = this.state.requireJob(jobId);
    const prior = this.state.listJobEvents(jobId).find((event) =>
      ["job.recovery.inspect.succeeded", "job.recovery.inspect.failed"].includes(event.type)
      && event.payload?.idempotencyKey === normalizedIdempotencyKey);
    if (prior?.type === "job.recovery.inspect.succeeded") {
      return { ...prior.payload.inspection, reused: true };
    }
    if (prior?.type === "job.recovery.inspect.failed") {
      throw new ControlPlaneError(
        "RECOVERY_INSPECTION_PREVIOUSLY_FAILED",
        "this recovery inspection idempotency key already failed; inspect its evidence before using a new key",
        { status: 409, details: { jobId, deviceId: job.deviceId } },
      );
    }
    if (job.status !== "recovery_required") {
      throw new ControlPlaneError("RECOVERY_NOT_REQUIRED", "job is not recovery_required", {
        status: 409,
        details: { jobId, status: job.status },
      });
    }
    const device = this.state.requireDevice(job.deviceId, {
      includeRuntime: true,
      requireReady: false,
    });
    if (!device.online) {
      throw new ControlPlaneError("DEVICE_OFFLINE", `${device.alias} is offline`, { status: 409 });
    }
    if (!device.quarantined) {
      throw new ControlPlaneError("DEVICE_NOT_QUARANTINED", `${device.alias} is not quarantined`, {
        status: 409,
      });
    }
    const capability = this.capabilities.require(job.capabilityId);
    const adapter = this.adapters.require(capability.implementation.adapter);
    if (typeof adapter.inspectRecovery !== "function") {
      throw new ControlPlaneError(
        "RECOVERY_INSPECTION_UNAVAILABLE",
        "capability adapter has no read-only recovery inspection path",
        { status: 409 },
      );
    }

    let lease = this.state.acquireLease({
      deviceId: job.deviceId,
      kind: "recovery",
      holderId: `recovery-inspection:${actorId.trim()}`,
      jobId: job.jobId,
      ttlMs: this.leaseTtlMs,
      allowQuarantined: true,
    });
    let heartbeatError = null;
    const heartbeat = setInterval(() => {
      try {
        this.state.heartbeatLease(lease.leaseId, lease.token, this.leaseTtlMs);
      } catch (error) {
        heartbeatError = error;
      }
    }, this.leaseHeartbeatMs);
    heartbeat.unref?.();
    const appendInspectionEvent = (type, payload) => {
      const eventId = this.state.appendEvent({ jobId: job.jobId, runId: job.runId, type, payload });
      try {
        this.evidence.appendEvent(job.runId, {
          type,
          jobId: job.jobId,
          createdAt: new Date().toISOString(),
          ...payload,
        });
      } catch {
        // SQLite is the durable audit authority; JSONL mirroring is best-effort.
      }
      return eventId;
    };
    try {
      const startedEventId = appendInspectionEvent("job.recovery.inspect.started", {
        actorId: actorId.trim(),
        idempotencyKey: normalizedIdempotencyKey,
        deviceId: job.deviceId,
      });
      if (heartbeatError) throw heartbeatError;
      this.state.heartbeatLease(lease.leaseId, lease.token, this.leaseTtlMs);
      const output = await adapter.inspectRecovery({
        job,
        capability,
        device,
        params: job.params,
        evidenceDirectory: this.evidence.runDirectory(job.runId),
        leaseAuthorization: {
          leaseId: lease.leaseId,
          token: lease.token,
          deviceId: job.deviceId,
          controlUrl: this.operatorControlUrl,
        },
      });
      if (heartbeatError) throw heartbeatError;
      if (output?.ok !== true || output?.stoppedBeforeAction !== true) {
        throw new ControlPlaneError(
          "RECOVERY_INSPECTION_REJECTED",
          "adapter did not produce a verified read-only recovery inspection",
          { status: 409, details: { step: output?.step || null } },
        );
      }

      const attached = [];
      for (const file of collectEvidenceFiles(output)) {
        attached.push(await this.evidence.attachFile({
          job,
          sourcePath: file.path,
          kind: file.kind || "adapter",
          label: file.label,
        }));
      }
      const screenshot = attached.find((item) => item.kind === "screenshot");
      if (!screenshot) {
        throw new ControlPlaneError(
          "RECOVERY_INSPECTION_SCREENSHOT_MISSING",
          "recovery inspection must attach a screenshot",
          { status: 500 },
        );
      }
      const pageClassification = output?.observation?.pageClassification || {
        schemaVersion: 1,
        pageType: "unknown",
        confidence: 0,
        safeStateVerified: false,
        reasons: ["visual analysis pending"],
      };
      const inspectionId = `inspection_${startedEventId}`;
      const record = this.evidence.writeJson({
        job,
        kind: "recovery_inspection",
        label: `recovery-inspection-${inspectionId}`,
        value: {
          schemaVersion: 1,
          inspectionId,
          jobId: job.jobId,
          runId: job.runId,
          deviceId: job.deviceId,
          stoppedBeforeAction: true,
          quarantineCleared: false,
          screenshot: {
            evidenceId: screenshot.evidenceId,
            path: screenshot.path,
            sha256: screenshot.sha256,
            bytes: screenshot.bytes,
          },
          observation: output.observation || {},
          analysis: {
            status: pageClassification.pageType === "unknown" ? "pending" : "semantic_hint_only",
            requiredImageSha256: screenshot.sha256,
            protocol: "xhs.visual-elements.v1",
          },
        },
      });
      const inspection = {
        ok: true,
        reused: false,
        inspectionId,
        jobId: job.jobId,
        runId: job.runId,
        deviceId: job.deviceId,
        stoppedBeforeAction: true,
        quarantineCleared: false,
        screenshot: {
          evidenceId: screenshot.evidenceId,
          kind: screenshot.kind,
          path: screenshot.path,
          sha256: screenshot.sha256,
          bytes: screenshot.bytes,
        },
        inspectionEvidence: {
          evidenceId: record.evidenceId,
          path: record.path,
          sha256: record.sha256,
        },
        pageClassification,
        focus: {
          package: String(output?.observation?.focus?.package || "").slice(0, 160),
          activity: String(output?.observation?.focus?.activity || "").slice(0, 240),
        },
        analysis: {
          status: pageClassification.pageType === "unknown" ? "pending" : "semantic_hint_only",
          requiredImageSha256: screenshot.sha256,
          protocol: "xhs.visual-elements.v1",
        },
      };
      appendInspectionEvent("job.recovery.inspect.succeeded", {
        actorId: actorId.trim(),
        idempotencyKey: normalizedIdempotencyKey,
        deviceId: job.deviceId,
        inspection,
      });
      return inspection;
    } catch (error) {
      const cause = asControlError(error, "RECOVERY_INSPECTION_FAILED");
      const adapterCode = boundedAdapterCode(cause);
      appendInspectionEvent("job.recovery.inspect.failed", {
        actorId: actorId.trim(),
        idempotencyKey: normalizedIdempotencyKey,
        deviceId: job.deviceId,
        causeCode: cause.code,
        adapterCode,
        step: cause.details?.step || null,
      });
      throw new ControlPlaneError(
        "RECOVERY_INSPECTION_FAILED",
        "read-only recovery inspection did not produce durable evidence",
        {
          status: 409,
          details: { jobId: job.jobId, deviceId: job.deviceId, causeCode: cause.code, adapterCode },
          cause,
        },
      );
    } finally {
      clearInterval(heartbeat);
      if (lease) {
        try {
          this.state.releaseLease(lease.leaseId, lease.token);
        } catch (releaseError) {
          try {
            appendInspectionEvent("job.recovery.inspect.lease_release_failed", {
              actorId: actorId.trim(),
              idempotencyKey: normalizedIdempotencyKey,
              deviceId: job.deviceId,
              causeCode: releaseError?.code || "LEASE_RELEASE_FAILED",
            });
          } catch {
            // Lease expiry and quarantine remain fail-closed even if audit mirroring also fails.
          }
        }
      }
    }
  }

  async recordRecoveryInspectionAnalysis({
    jobId,
    inspectionId,
    actorId,
    idempotencyKey,
    analysis,
  }) {
    if (typeof actorId !== "string" || actorId.trim() === "") {
      throw new ControlPlaneError("ACTOR_REQUIRED", "actorId is required");
    }
    if (typeof idempotencyKey !== "string" || idempotencyKey.trim() === "") {
      throw new ControlPlaneError("IDEMPOTENCY_KEY_REQUIRED", "idempotencyKey is required");
    }
    if (typeof inspectionId !== "string" || inspectionId.trim() === "") {
      throw new ControlPlaneError("RECOVERY_INSPECTION_ID_REQUIRED", "inspectionId is required", { status: 400 });
    }
    const normalizedIdempotencyKey = idempotencyKey.trim();
    const normalizedInspectionId = inspectionId.trim();
    let analysisRequestHash;
    try {
      analysisRequestHash = fingerprint({ inspectionId: normalizedInspectionId, analysis });
    } catch {
      throw new ControlPlaneError(
        "RECOVERY_ANALYSIS_SCHEMA_INVALID",
        "analysis must be JSON-serializable",
        { status: 400 },
      );
    }
    const job = this.state.requireJob(jobId);
    const prior = this.state.listJobEvents(jobId).find((event) =>
      event.type === "job.recovery.analysis.recorded"
      && event.payload?.idempotencyKey === normalizedIdempotencyKey);
    if (prior) {
      if (prior.payload?.analysisRequestHash !== analysisRequestHash
        || prior.payload?.inspectionId !== normalizedInspectionId) {
        throw new ControlPlaneError(
          "IDEMPOTENCY_KEY_CONFLICT",
          "idempotency key was already used with a different recovery analysis request",
          { status: 409, details: { jobId, inspectionId: normalizedInspectionId } },
        );
      }
      return { ...prior.payload.analysisResult, reused: true };
    }
    if (job.status !== "recovery_required") {
      throw new ControlPlaneError("RECOVERY_NOT_REQUIRED", "job is not recovery_required", {
        status: 409,
        details: { jobId, status: job.status },
      });
    }
    const inspectionEvent = this.state.listJobEvents(jobId).find((event) =>
      event.type === "job.recovery.inspect.succeeded"
      && event.payload?.inspection?.inspectionId === normalizedInspectionId);
    if (!inspectionEvent) {
      throw new ControlPlaneError(
        "RECOVERY_INSPECTION_NOT_FOUND",
        "analysis must reference a successful audited recovery inspection",
        { status: 404, details: { jobId, inspectionId: normalizedInspectionId } },
      );
    }
    const inspection = inspectionEvent.payload.inspection;
    try {
      const normalized = normalizeRecoveryVisualAnalysis(analysis, {
        expectedImageSha256: inspection.screenshot.sha256,
        focus: inspection.focus,
      });
      const evidence = this.evidence.writeJson({
        job,
        kind: "recovery_analysis",
        label: `recovery-analysis-${normalizedInspectionId}`,
        value: {
          inspectionId: normalizedInspectionId,
          jobId: job.jobId,
          runId: job.runId,
          deviceId: job.deviceId,
          stoppedBeforeAction: true,
          quarantineCleared: false,
          ...normalized,
        },
      });
      const analysisResult = {
        ok: true,
        reused: false,
        inspectionId: normalizedInspectionId,
        jobId: job.jobId,
        runId: job.runId,
        deviceId: job.deviceId,
        stoppedBeforeAction: true,
        quarantineCleared: false,
        imageSha256: normalized.image.sha256,
        analyzer: normalized.analyzer,
        elementCount: normalized.elementCount,
        pageClassification: normalized.pageClassification,
        analysisEvidence: {
          evidenceId: evidence.evidenceId,
          path: evidence.path,
          sha256: evidence.sha256,
        },
      };
      const payload = {
        actorId: actorId.trim(),
        idempotencyKey: normalizedIdempotencyKey,
        deviceId: job.deviceId,
        inspectionId: normalizedInspectionId,
        analysisRequestHash,
        analysisResult,
      };
      this.state.appendEvent({
        jobId: job.jobId,
        runId: job.runId,
        type: "job.recovery.analysis.recorded",
        payload,
      });
      try {
        this.evidence.appendEvent(job.runId, {
          type: "job.recovery.analysis.recorded",
          jobId: job.jobId,
          createdAt: new Date().toISOString(),
          ...payload,
        });
      } catch {
        // SQLite is the durable audit authority; JSONL mirroring is best-effort.
      }
      return analysisResult;
    } catch (error) {
      const cause = asControlError(error, "RECOVERY_ANALYSIS_REJECTED");
      const payload = {
        actorId: actorId.trim(),
        idempotencyKey: normalizedIdempotencyKey,
        deviceId: job.deviceId,
        inspectionId: normalizedInspectionId,
        analysisRequestHash,
        causeCode: cause.code,
      };
      this.state.appendEvent({
        jobId: job.jobId,
        runId: job.runId,
        type: "job.recovery.analysis.rejected",
        payload,
      });
      try {
        this.evidence.appendEvent(job.runId, {
          type: "job.recovery.analysis.rejected",
          jobId: job.jobId,
          createdAt: new Date().toISOString(),
          ...payload,
        });
      } catch {
        // SQLite is the durable audit authority; JSONL mirroring is best-effort.
      }
      throw new ControlPlaneError(
        "RECOVERY_ANALYSIS_REJECTED",
        "visual analysis did not match the audited recovery screenshot contract",
        {
          status: 409,
          details: { jobId: job.jobId, inspectionId: normalizedInspectionId, causeCode: cause.code },
          cause,
        },
      );
    }
  }

  createSession({
    actorId,
    deviceId = null,
    placement = {},
    capabilityId = null,
    canary = false,
  }) {
    const capability = capabilityId ? this.capabilities.require(capabilityId) : null;
    if (capability) evaluateCapabilityPolicy(capability, { canary, invocation: "session", policyMode: this.policyMode });
    return this.state.createSession({
      actorId,
      authorityNodeId: this.authorityNodeId,
      deviceId,
      placement,
      capability,
      canary,
      ttlMs: this.leaseTtlMs,
    });
  }

  heartbeatSession(sessionId, token) {
    return this.state.heartbeatSession(sessionId, token, this.leaseTtlMs);
  }

  releaseSession(sessionId, token) {
    const session = this.state.validateSession(sessionId, token);
    if (this.activeJobs.has(session.deviceId)) {
      throw new ControlPlaneError(
        "SESSION_ACTION_RUNNING",
        "cannot release a session while its action is running",
        { status: 423, details: { sessionId } },
      );
    }
    return this.state.releaseSession(sessionId, token);
  }

  async executeSessionAction(sessionId, token, {
    idempotencyKey,
    capabilityId,
    params = {},
  }) {
    const session = this.state.validateSession(sessionId, token);
    if (this.state.getDiscoveryRunForSession(sessionId)) {
      throw new ControlPlaneError("DISCOVERY_SESSION_EXCLUSIVE", "Discovery-owned sessions only accept the fenced Discovery primitive path", { status: 403 });
    }
    if (session.scopeCapabilityId && session.scopeCapabilityId !== capabilityId) {
      throw new ControlPlaneError(
        "SESSION_CAPABILITY_MISMATCH",
        `session is scoped to ${session.scopeCapabilityId}`,
        { status: 409, details: { scopeCapabilityId: session.scopeCapabilityId } },
      );
    }
    const capability = this.capabilities.validateParams(capabilityId, params);
    const policy = evaluateCapabilityPolicy(capability, { canary: session.canary, invocation: "session", policyMode: this.policyMode });
    if (policy.approvalRequired) {
      throw new ControlPlaneError(
        "APPROVAL_REQUIRED",
        "external effects must be submitted as an approvable job",
        { status: 403 },
      );
    }
    if (this.activeJobs.has(session.deviceId)) {
      throw new ControlPlaneError(
        "DEVICE_BUSY",
        "device already has an action in progress",
        { status: 423, details: { sessionId } },
      );
    }
    this.evidence.assertCapacity(this.capacityBypassOpts(false));
    const created = this.state.createJob({
      idempotencyKey,
      actorId: session.actorId,
      authorityNodeId: this.authorityNodeId,
      deviceId: session.deviceId,
      placement: {},
      capability,
      params,
      canary: session.canary,
      sessionId,
      status: "queued",
      approvalRequired: false,
      externalEffect: false,
    });
    if (created.reused) {
      if (created.job.sessionId !== sessionId) {
        throw new ControlPlaneError(
          "IDEMPOTENCY_CONFLICT",
          "idempotency key belongs to a different session",
          { status: 409, details: { jobId: created.job.jobId } },
        );
      }
      return {
        ...created.job,
        storage: this.evidence.storageForRun(created.job.runId),
      };
    }
    const device = this.state.requireDevice(session.deviceId);
    this.evidence.initializeRun({ job: created.job, device, ...this.capacityOpts(false) });
    const promise = this.#runJob(created.job, {
      lease: { leaseId: session.leaseId, token },
      releaseLease: false,
    }).finally(() => {
      if (this.activeJobs.get(session.deviceId) === promise) {
        this.activeJobs.delete(session.deviceId);
      }
      if (this.started) queueMicrotask(() => void this.pump());
    });
    this.activeJobs.set(session.deviceId, promise);
    const job = await promise;
    return {
      ...job,
      storage: this.evidence.storageForRun(job.runId),
    };
  }

  async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (const job of this.state.nextQueuedJobs()) {
        if (this.activeJobs.has(job.deviceId)) continue;
        let lease;
        try {
          lease = this.state.acquireLease({
            deviceId: job.deviceId,
            kind: "job",
            holderId: `job:${job.jobId}`,
            jobId: job.jobId,
            ttlMs: this.leaseTtlMs,
          });
        } catch (error) {
          // Skip jobs that cannot acquire a lease right now; leave them queued so they
          // retry after the device recovers (busy / quarantined / offline).
          if (["DEVICE_BUSY", "DEVICE_QUARANTINED", "DEVICE_OFFLINE"].includes(error?.code)) {
            continue;
          }
          throw error;
        }
        try {
          this.state.appendEvent({
            jobId: job.jobId,
            runId: job.runId,
            type: "job.lease.acquired",
            payload: {
              leaseId: lease.leaseId,
              deviceId: job.deviceId,
              jobId: job.jobId,
              holderId: lease.holderId,
              createdAt: new Date().toISOString(),
              expiresAt: lease.expiresAt,
              outcome: "acquired",
            },
          });
        } catch {}
        const promise = this.#runJob(job, { lease, releaseLease: true })
          .finally(() => {
            this.activeJobs.delete(job.deviceId);
            if (this.started) queueMicrotask(() => void this.pump());
          });
        this.activeJobs.set(job.deviceId, promise);
      }
    } finally {
      this.pumping = false;
    }
  }

  async waitForJob(jobId, { timeoutMs = 5000, pollMs = 10 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const job = this.state.requireJob(jobId);
      if (["succeeded", "failed", "ambiguous", "recovery_required", "cancelled", "waiting_approval"].includes(job.status)) {
        return job;
      }
      if (Date.now() >= deadline) {
        throw new ControlPlaneError("JOB_WAIT_TIMEOUT", `timed out waiting for ${jobId}`, { status: 504 });
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  async #runJob(initialJob, { lease, releaseLease, onVerified = null }) {
    let job = this.state.requireJob(initialJob.jobId);
    let execution;
    let verification;
    let restoration;
    let primaryError;
    let restoreError;
    let heartbeatError;
    let explicitObservationReceipt = null;
    const capability = job.capability;
    const adapter = this.adapters.require(capability.implementation.adapter);
    const device = this.state.requireDevice(job.deviceId, { includeRuntime: true });
    const context = {
      job,
      capability,
      device,
      params: job.params,
      evidenceDirectory: this.evidence.runDirectory(job.runId),
    };
    const authorizedContext = {
      ...context,
      leaseAuthorization: {
        leaseId: lease.leaseId,
        token: lease.token,
        deviceId: job.deviceId,
        controlUrl: this.operatorControlUrl,
      },
    };
    const heartbeat = setInterval(() => {
      try {
        this.state.heartbeatLease(lease.leaseId, lease.token, this.leaseTtlMs);
      } catch (error) {
        heartbeatError = error;
      }
    }, this.leaseHeartbeatMs);
    heartbeat.unref?.();

    try {
      job = this.state.transitionJob(job.jobId, "running");
      this.evidence.appendEvent(job.runId, { type: "job.running", jobId: job.jobId, createdAt: new Date().toISOString() });
      // REX Phase 2 收尾 §4.2.A：所有控制面派发效果（job/session/mission ECP）的唯一
      // 共用 chokepoint。对 job.params 做一次轻量 classify——generic capability 被用来
      // 点支付按钮（params 带 financial_commit target/context）即在此 fail-closed。
      // 唯一放行路径是携带经 paymentApprovalVerifier 验证通过的人类签名批准（PHC 流）。
      await guardFinancialCommit(
        { ...job.params, app: capability.appId, deviceId: job.deviceId },
        { verifyApproval: this.paymentApprovalVerifier },
      );
      execution = await adapter.execute(authorizedContext);
      if (heartbeatError) throw heartbeatError;

      job = this.state.transitionJob(job.jobId, "verifying");
      this.evidence.appendEvent(job.runId, { type: "job.verifying", jobId: job.jobId, createdAt: new Date().toISOString() });
      verification = adapter.verify
        ? await adapter.verify({ ...context, execution })
        : { ok: true, mode: "none" };
      if (verification?.ok === false) {
        const error = new ControlPlaneError("VERIFICATION_FAILED", "capability postcondition was not verified", {
          status: 409,
          details: { mode: verification.mode || capability.verification.mode },
        });
        error.ambiguous = Boolean(verification.ambiguous);
        throw error;
      }
      const receiptSourceKey = `${capability.id}:${adapter.id}`;
      if (this.receiptAuthorityAllowlist.has(receiptSourceKey)) {
        if (typeof adapter.buildExplicitObservationReceipt !== "function") {
          throw new ControlPlaneError("EXPLICIT_RECEIPT_PROVENANCE_INVALID", "allowlisted receipt adapter has no parser-owned receipt builder", { status: 409 });
        }
        const draft = adapter.buildExplicitObservationReceipt({ job, capability, execution, verification });
        if (!draft || typeof draft.pageFingerprint !== "string" || typeof draft.targetFingerprint !== "string"
          || !Number.isFinite(Date.parse(draft.observedAt))) {
          throw new ControlPlaneError("EXPLICIT_RECEIPT_INVALID", "allowlisted parser did not produce a complete note observation", { status: 409 });
        }
        const evidenceRecord = this.evidence.writeJson({
          job,
          kind: "explicit_observation",
          label: "explicit-note-observation",
          value: draft,
        });
        explicitObservationReceipt = {
          receiptId: fingerprint({
            jobId: job.jobId,
            runId: job.runId,
            pageFingerprint: draft.pageFingerprint,
            targetFingerprint: draft.targetFingerprint,
            observedAt: draft.observedAt,
            evidenceHash: evidenceRecord.sha256,
          }),
          ...draft,
          evidenceId: evidenceRecord.evidenceId,
          evidenceHash: evidenceRecord.sha256,
        };
      }
      if (onVerified) await onVerified({ job, execution, verification });
    } catch (error) {
      primaryError = asControlError(error);
      if (error?.sent) primaryError.sent = true;
      if (error?.ambiguous) primaryError.ambiguous = true;
    }

    try {
      job = this.state.transitionJob(job.jobId, "restoring", {
        payload: { required: capability.restoration.required },
      });
      this.evidence.appendEvent(job.runId, { type: "job.restoring", jobId: job.jobId, createdAt: new Date().toISOString() });
      restoration = adapter.restore
        ? await adapter.restore({ ...authorizedContext, execution, verification, error: primaryError })
        : { ok: !capability.restoration.required };
      if (capability.restoration.required && restoration?.ok === false) {
        throw new ControlPlaneError("RESTORATION_FAILED", "adapter restoration failed", { status: 409 });
      }
    } catch (error) {
      restoreError = asControlError(error, "RESTORATION_FAILED");
    }

    try {
      for (const file of collectEvidenceFiles(execution, verification, restoration)) {
        await this.evidence.attachFile({
          job,
          sourcePath: file.path,
          kind: file.kind || "adapter",
          label: file.label,
        });
      }
      const summary = {
        ...resultSummary(execution, verification, restoration, primaryError),
        ...(explicitObservationReceipt ? { explicitObservationReceipt } : {}),
      };
      this.evidence.writeJson({ job, kind: "result", label: "result", value: summary });
      if (restoreError || heartbeatError) {
        const code = restoreError?.code || heartbeatError?.code || "RECOVERY_REQUIRED";
        this.state.quarantineDevice(job.deviceId, code);
        job = this.state.transitionJob(job.jobId, "recovery_required", { errorCode: code, result: summary });
      } else if (primaryError) {
        const ambiguous = !primaryError.notSent
          && (primaryError.sent
            || primaryError.ambiguous
            || capability.idempotency === "ambiguous_on_timeout");
        job = this.state.transitionJob(job.jobId, ambiguous ? "ambiguous" : "failed", {
          errorCode: primaryError.code,
          result: summary,
        });
      } else {
        job = this.state.transitionJob(job.jobId, "succeeded", { result: summary });
      }
      this.evidence.appendEvent(job.runId, {
        type: `job.${job.status}`,
        jobId: job.jobId,
        errorCode: job.errorCode,
        createdAt: new Date().toISOString(),
      });
      return job;
    } finally {
      clearInterval(heartbeat);
      if (releaseLease) {
        let outcome = "released";
        try { this.state.releaseLease(lease.leaseId, lease.token); } catch { outcome = "release_failed"; }
        try {
          this.state.appendEvent({
            jobId: job.jobId,
            runId: job.runId,
            type: "job.lease.released",
            payload: {
              leaseId: lease.leaseId,
              deviceId: job.deviceId,
              jobId: job.jobId,
              holderId: lease.holderId,
              createdAt: new Date().toISOString(),
              expiresAt: lease.expiresAt,
              outcome,
            },
          });
        } catch {}
      }
    }
  }
}
