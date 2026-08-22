// M6-2 W5 — the M6-frame capture facade.
//
// This is the ONLY surface through which an execution-grade observe frame can be
// captured in M6-2. It is strictly observe-only:
//
//   * The public face is exactly four operations: preflight / capture / status /
//     closeout. No operation accepts a coordinate, shell text, URL, device id,
//     session id, lease token, or transport token. The caller names an alias +
//     a closed scenario label + an idempotency key; the control plane resolves
//     the alias to a device server-side.
//   * Every capture creates a REAL server-owned capability session (one device,
//     one lease) and a REAL queued capability job, runs the job through the
//     ControlPlane job channel (the xiaowei closed read-only observer), then
//     commits CAS evidence blobs and freezes the strict frame. `finally` always
//     converges: queued jobs canceled, session/lease released.
//   * The gate is the immutable epoch chain from m6-live-gate.mjs. Any missing /
//     forged / expired / drifted / locked / closed gate fails closed BEFORE any
//     lease or device read exists. The immutable release profile must have
//     agenticGroundingEnabled=true and runtimeProfile=legacy_compat.
//   * No token ever leaves: returns carry opaque refs (frameId/manifestSha256,
//     session id, lease ref). The audit trail binds epoch hash + attempt/job/
//     session/lease refs and is the only persistence of attempt state.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assembleLiveStrictFrame,
  focusStableFieldsHash,
  M6_FRAME_CONSTANTS,
  verifyFrameManifest,
} from "../../../../packages/kernel/lib/m6-screen-frame.mjs";
import { canonicalJson, newId, sha256 } from "./canonical.mjs";
import { ControlPlaneError } from "./errors.mjs";
import { validateJsonSchema } from "./json-schema-validator.mjs";
import { probeWritable } from "./m6-gate-loader.mjs";
import { evaluateM6Gate, m6AliasAllowed, M6_GATE_LOCK_KINDS } from "./m6-live-gate.mjs";

export const M6_OBSERVE_CAPABILITY_ID = "xiaowei.m6.observe_frame";
export const M6_PROVIDER_ADAPTER_ID = "xiaowei";
export const M6_SERVER_ACTOR = "agent:m6-facade";
export const M6_SCENARIO_LABELS = Object.freeze(["observe"]);
export const M6_ALIAS_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
export const M6_IDEMPOTENCY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
export const M6_SCENARIO_PATTERN = /^observe(?:[._-][A-Za-z0-9._-]{1,56})?$/;

export class M6FrameCaptureError extends ControlPlaneError {
  constructor(code, message, extra = {}) {
    super(code, message, { status: extra.status ?? 502, ...extra });
    this.name = "M6FrameCaptureError";
  }
}

// Anything an M6 public surface returns is redacted by construction: no token,
// sessionToken, transportToken, or leaseToken survives a capture response.
export function redactM6Output(value) {
  if (!value || typeof value !== "object") return value;
  const out = Array.isArray(value) ? [...value] : { ...value };
  for (const key of ["token", "sessionToken", "transportToken", "leaseToken"]) delete out[key];
  if (out.receipt && typeof out.receipt === "object") {
    out.receipt = { ...out.receipt };
    for (const key of ["token", "sessionToken", "transportToken", "leaseToken"]) delete out.receipt[key];
  }
  return out;
}

function requireString(value, label, code, pattern) {
  if (typeof value !== "string" || value.trim() === "" || (pattern && !pattern.test(value))) {
    throw new M6FrameCaptureError(code, `${label} must match the closed M6 input contract`, { status: 400 });
  }
  return value.trim();
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function buildReceipt(fields) {
  const payload = {
    schemaId: "xw.capture-attempt-receipt.v1",
    attemptId: fields.attemptId,
    runId: fields.runId,
    jobId: fields.jobId,
    sessionId: fields.sessionId,
    leaseRef: fields.leaseRef,
    alias: fields.alias,
    scenarioLabel: fields.scenarioLabel,
    epochHash: fields.epochHash,
    status: fields.status,
    frameRef: fields.frameRef ?? null,
    gateMode: fields.gateMode ?? null,
    errorCodes: fields.errorCodes ?? [],
    evidenceRefs: fields.evidenceRefs ?? [],
    skew: fields.skew ?? null,
    remainingTtlMs: fields.remainingTtlMs ?? null,
    capturedAt: fields.capturedAt ?? null,
    committedAt: fields.committedAt,
  };
  return { ...payload, receiptSha256: sha256(`xw.capture-attempt-receipt.v1:${canonicalJson(payload)}`) };
}

// The shared kernel receipt schema, loaded once. The facade validates every
// receipt it emits against this schema + re-derives receiptSha256 + semantic
// checks, mirroring the orchestrator's frozen validateCaptureAttemptReceipt.
// The facade does NOT import orchestrator code — the dependency runs orchestrator
// → control-plane, never the reverse — but both sides validate the same shared
// schema with byte-identical canonicalization, so a facade-built receipt is
// accepted by the contract validator and vice versa.
let RECEIPT_SCHEMA = null;
function loadReceiptSchema() {
  if (RECEIPT_SCHEMA) return RECEIPT_SCHEMA;
  const path = join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../packages/kernel/contracts/orchestration/m6/xw.capture-attempt-receipt.v1.schema.json",
  );
  RECEIPT_SCHEMA = JSON.parse(readFileSync(path, "utf8"));
  return RECEIPT_SCHEMA;
}

export function validateCaptureAttemptReceipt(receipt) {
  const errors = [];
  if (!receipt || typeof receipt !== "object") return { ok: false, errors: ["receipt must be an object"] };
  errors.push(...validateJsonSchema(receipt, loadReceiptSchema()));
  const { receiptSha256: _ignored, ...rest } = receipt;
  if (receipt.receiptSha256 !== sha256(`xw.capture-attempt-receipt.v1:${canonicalJson(rest)}`)) {
    errors.push("receiptSha256 does not match the canonical receipt payload");
  }
  if (receipt.status === "accepted" && !receipt.frameRef) errors.push("accepted receipts must carry a frameRef");
  if (receipt.status === "accepted") {
    for (const idField of ["runId", "jobId", "sessionId", "leaseRef"]) {
      if (typeof receipt[idField] !== "string" || receipt[idField] === "") errors.push(`accepted receipts must carry a non-null ${idField}`);
    }
  }
  if (receipt.status === "rejected" && receipt.frameRef) errors.push("rejected receipts must not carry a frameRef");
  if (receipt.status === "rejected" && !(Array.isArray(receipt.errorCodes) && receipt.errorCodes.length > 0)) {
    errors.push("rejected receipts must carry at least one M6_ error code");
  }
  if (receipt.status === "accepted" && Array.isArray(receipt.errorCodes) && receipt.errorCodes.length > 0) {
    errors.push("accepted receipts must not carry error codes");
  }
  if (!Number.isFinite(Date.parse(receipt.capturedAt)) || !Number.isFinite(Date.parse(receipt.committedAt))) {
    errors.push("capturedAt/committedAt must be valid date-time strings");
  } else if (Date.parse(receipt.committedAt) < Date.parse(receipt.capturedAt)) {
    errors.push("committedAt must be at or after capturedAt");
  }
  if (receipt.skew) {
    if (!Number.isInteger(receipt.skew.aToBMs) || receipt.skew.aToBMs < 0) errors.push("skew.aToBMs must be a non-negative integer");
    if (!Number.isInteger(receipt.skew.bToFocusBMs) || receipt.skew.bToFocusBMs < 0) errors.push("skew.bToFocusBMs must be a non-negative integer");
  }
  return { ok: errors.length === 0, errors };
}

function writeAuditJson(auditRoot, attemptId, record) {
  mkdirSync(auditRoot, { recursive: true });
  const target = join(auditRoot, `${attemptId}.json`);
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  renameSync(tmp, target);
}

function readAuditJson(auditRoot, attemptId) {
  const file = join(auditRoot, `${attemptId}.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8"));
}

export function createM6FrameCapture({
  control,
  state,
  capabilities,
  evidence,          // M6FrameEvidenceStore (CAS frame blobs)
  auditRoot,         // directory for attempt/closeout records
  gate = { chain: [], closeouts: {} },
  gateProvider = null, // production: reloads signed gate + locks from disk per decision
  release = null,    // { releaseId, sourceCommit } — gate drift check
  profile = null,    // { runtimeProfile, agenticGroundingEnabled } — immutable release profile
  devices = null,    // { findByAlias(alias) } — server-side alias resolution
  now = Date.now,
  lockHashes = null,
} = {}) {
  if (!control || !state || !capabilities || !evidence) {
    throw new M6FrameCaptureError("M6_FACADE_DEPS_INVALID", "createM6FrameCapture requires control, state, capabilities, and evidence", { status: 503 });
  }
  // #2: the live surface MUST refuse a fail-open null lock set. The release
  // pipeline pins lockHashes; the production loader supplies them from
  // m6-gate/locks.v1.json. A facade built without pinned locks cannot evaluate
  // the gate safely (an epoch with forged lockHashes would skip the lock check),
  // so construction fails closed here rather than at capture time.
  if (!lockHashes || typeof lockHashes !== "object") {
    throw new M6FrameCaptureError("M6_LOCK_HASHES_REQUIRED", "M6 requires pinned lockHashes {runtimeProfile, hardRedlinePolicy, groundingRuntime}", { status: 503 });
  }
  for (const kind of M6_GATE_LOCK_KINDS) {
    if (typeof lockHashes[kind] !== "string" || !/^[0-9a-f]{64}$/.test(lockHashes[kind])) {
      throw new M6FrameCaptureError("M6_LOCK_HASHES_REQUIRED", `M6 lockHashes.${kind} must be a 64-hex sha256`, { status: 503 });
    }
  }
  const resolveDevice = devices && typeof devices.findByAlias === "function"
    ? (alias) => devices.findByAlias(alias) || null
    : (alias) => state.listDevices().find((d) => d.alias === alias) ?? null;

  function currentGateSnapshot() {
    const loaded = typeof gateProvider === "function" ? gateProvider() : null;
    const snapshot = loaded
      ? { chain: loaded.chain, closeouts: loaded.closeouts, aggregates: loaded.aggregates ?? {}, lockHashes: loaded.lockHashes }
      : { chain: gate.chain, closeouts: gate.closeouts, aggregates: gate.aggregates ?? {}, lockHashes };
    if (!snapshot.lockHashes || typeof snapshot.lockHashes !== "object") {
      throw new M6FrameCaptureError("M6_LOCK_HASHES_REQUIRED", "fresh M6 gate snapshot has no pinned lock hashes", { status: 503 });
    }
    for (const kind of M6_GATE_LOCK_KINDS) {
      if (typeof snapshot.lockHashes[kind] !== "string" || !/^[0-9a-f]{64}$/.test(snapshot.lockHashes[kind])) {
        throw new M6FrameCaptureError("M6_LOCK_HASHES_REQUIRED", `fresh M6 gate snapshot lockHashes.${kind} is invalid`, { status: 503 });
      }
    }
    return snapshot;
  }

  // Fail-closed gate + profile evaluation. Called BEFORE any lease/session/read
  // resource exists; nothing here touches a device or the transport.
  function resolveGate(alias, nowMs) {
    const snapshot = currentGateSnapshot();
    const result = evaluateM6Gate({
      chain: snapshot.chain,
      closeouts: snapshot.closeouts,
      aggregates: snapshot.aggregates,
      nowMs,
      expectedRelease: release,
      lockHashes: snapshot.lockHashes,
    });
    if (result.errors.length > 0) {
      throw new M6FrameCaptureError(result.errors[0].code, `M6 live gate failed closed: ${result.errors[0].message}`, {
        status: 409,
        details: { errors: result.errors },
      });
    }
    if (result.mode !== "OBSERVE_ONLY") {
      throw new M6FrameCaptureError("M6_GATE_CLOSED", "M6 live gate is CLOSED; observe capture is not active", {
        status: 409,
        details: { mode: result.mode, epochHash: result.activeEpochHash },
      });
    }
    if (!profile || profile.agenticGroundingEnabled !== true || profile.runtimeProfile !== "legacy_compat") {
      throw new M6FrameCaptureError("M6_PROFILE_DISABLED", "agenticGroundingEnabled is not true on the immutable release profile", {
        status: 409,
        details: { runtimeProfile: profile?.runtimeProfile ?? null, agenticGroundingEnabled: profile?.agenticGroundingEnabled ?? false },
      });
    }
    if (!m6AliasAllowed(alias, result.activeEpoch)) {
      throw new M6FrameCaptureError("M6_ALIAS_NOT_ALLOWED", `alias '${alias}' is not in the active epoch allowlist`, { status: 403 });
    }
    return { mode: result.mode, epochHash: result.activeEpochHash, epoch: result.activeEpoch, lockHashes: snapshot.lockHashes };
  }

  // The M6 observe capability must be the closed contract: empty params, R0,
  // read-only, effect none, canary-only, and the REAL xiaowei provider. A
  // hermetic/fixture provider is structurally unreachable in a live capture.
  function requireObserveCapability() {
    const capability = capabilities.validateParams(M6_OBSERVE_CAPABILITY_ID, {});
    if (capability.risk !== "R0" || capability.idempotency !== "read_only"
      || capability.effect?.class !== "none" || capability.automationPolicy?.canaryOnly !== true) {
      throw new M6FrameCaptureError("M6_CAPABILITY_POLICY_INVALID", "observe_frame capability violates the closed M6 contract", { status: 409 });
    }
    if (capability.implementation?.adapter !== M6_PROVIDER_ADAPTER_ID) {
      throw new M6FrameCaptureError("M6_FIXTURE_PROVIDER_FORBIDDEN", "a hermetic/fixture provider is not allowed for live observe capture", { status: 409 });
    }
    return capability;
  }

  // preflight: pure gate/profile/alias/capability/device check. No lease, no
  // session, no device read. This is the fail-fast gate the CLI and router call
  // first.
  function preflight({ alias, scenarioLabel } = {}) {
    const a = requireString(alias, "alias", "M6_ALIAS_INVALID", M6_ALIAS_PATTERN);
    const s = requireString(scenarioLabel ?? "observe", "scenarioLabel", "M6_SCENARIO_LABEL_INVALID", M6_SCENARIO_PATTERN);
    const gateState = resolveGate(a, now());
    requireObserveCapability();
    const device = resolveDevice(a);
    if (!device || !device.deviceId) {
      throw new M6FrameCaptureError("M6_DEVICE_NOT_FOUND", `no control-plane device is bound to alias '${a}'`, { status: 404 });
    }
    // #3: preflight PROVES the M6 runtime is live-capable — the canonical
    // evidence + audit roots are writable, the release identity is loaded, and
    // the gate holds an active OBSERVE_ONLY epoch. These are proven BEFORE any
    // capture so a misconfigured runtime fails fast, not mid-capture.
    const evidenceRootWritable = probeWritable(evidence.root);
    const auditRootWritable = probeWritable(auditRoot);
    const releaseLoaded = Boolean(release && release.releaseId && release.sourceCommit);
    if (!evidenceRootWritable) {
      throw new M6FrameCaptureError("M6_EVIDENCE_ROOT_NOT_WRITABLE", "M6 frame evidence root is not writable", { status: 503 });
    }
    if (!auditRootWritable) {
      throw new M6FrameCaptureError("M6_AUDIT_ROOT_NOT_WRITABLE", "M6 audit root is not writable", { status: 503 });
    }
    if (!releaseLoaded) {
      throw new M6FrameCaptureError("M6_RELEASE_NOT_LOADED", "M6 release identity (releaseId + sourceCommit) is not loaded", { status: 503 });
    }
    return {
      ok: true,
      gateMode: gateState.mode,
      epochHash: gateState.epochHash,
      alias: a,
      scenarioLabel: s,
      evidenceRootWritable,
      auditRootWritable,
      releaseLoaded,
      epochActive: gateState.mode === "OBSERVE_ONLY",
      locksPinned: Boolean(gateState.lockHashes),
    };
  }

  // #3: a read-only M6 health snapshot for /control/v1/health. No device I/O.
  function health(nowMs) {
    const t = Number.isFinite(nowMs) ? nowMs : now();
    let snapshot;
    let result;
    try {
      snapshot = currentGateSnapshot();
      result = evaluateM6Gate({ chain: snapshot.chain, closeouts: snapshot.closeouts, aggregates: snapshot.aggregates, nowMs: t, expectedRelease: release, lockHashes: snapshot.lockHashes });
    } catch (error) {
      return {
        enabled: true,
        gateMode: "CLOSED",
        activeEpochHash: null,
        epochCount: 0,
        allowlist: [],
        evidenceRootWritable: probeWritable(evidence.root),
        auditRootWritable: probeWritable(auditRoot),
        releaseId: release?.releaseId ?? null,
        sourceCommit: release?.sourceCommit ?? null,
        locksPinned: false,
        profile: profile?.runtimeProfile ?? null,
        gateErrors: [error?.code ?? "M6_GATE_RELOAD_FAILED"],
      };
    }
    const active = result.activeEpoch || null;
    return {
      enabled: true,
      gateMode: result.mode,
      activeEpochHash: result.activeEpochHash,
      epochCount: Array.isArray(snapshot.chain) ? snapshot.chain.length : 0,
      allowlist: active?.allowlist ?? [],
      evidenceRootWritable: probeWritable(evidence.root),
      auditRootWritable: probeWritable(auditRoot),
      releaseId: release?.releaseId ?? null,
      sourceCommit: release?.sourceCommit ?? null,
      locksPinned: Boolean(snapshot.lockHashes && typeof snapshot.lockHashes === "object"),
      profile: profile?.runtimeProfile ?? null,
      gateErrors: result.errors.map((e) => e.code),
    };
  }

  async function capture({ alias, scenarioLabel = "observe", idempotencyKey, nowMs } = {}) {
    const a = requireString(alias, "alias", "M6_ALIAS_INVALID", M6_ALIAS_PATTERN);
    const s = requireString(scenarioLabel, "scenarioLabel", "M6_SCENARIO_LABEL_INVALID", M6_SCENARIO_PATTERN);
    const ik = requireString(idempotencyKey, "idempotencyKey", "M6_IDEMPOTENCY_REQUIRED", M6_IDEMPOTENCY_PATTERN);
    const at = Number.isFinite(nowMs) ? nowMs : now();
    const gateState = resolveGate(a, at);
    const capability = requireObserveCapability();

    const device = resolveDevice(a);
    if (!device || !device.deviceId) {
      throw new M6FrameCaptureError("M6_DEVICE_NOT_FOUND", `no control-plane device is bound to alias '${a}'`, { status: 404 });
    }

    const attemptId = newId("m6attempt");
    const attemptStartedAt = iso(at);
    const audit = {
      schemaId: "xw.capture-attempt-receipt.v1",
      attemptId,
      runId: null,
      jobId: null,
      sessionId: null,
      leaseRef: null,
      alias: a,
      scenarioLabel: s,
      epochHash: gateState.epochHash,
      status: "rejected",
      frameRef: null,
      gateMode: gateState.mode,
      errorCodes: [],
      evidenceRefs: [],
      // capturedAt is set at attempt start so even a pre-session rejected receipt
      // (no observation produced) carries a valid capturedAt, per the receipt schema.
      capturedAt: attemptStartedAt,
      committedAt: null,
    };
    let session = null;
    let jobRow = null;
    let acceptedRecord = null;
    let captureError = null;
    try {
      try {
        // Server-owned capability session: policy is re-evaluated by the control
        // plane (canary-only, read-only, R0), then one device gets one lease.
        session = control.createSession({
          actorId: M6_SERVER_ACTOR,
          deviceId: device.deviceId,
          capabilityId: M6_OBSERVE_CAPABILITY_ID,
          canary: true,
        });
      } catch (error) {
        if (error?.code === "DEVICE_BUSY") {
          throw new M6FrameCaptureError("M6_LEASE_CONFLICT", "device already has an active lease", { status: 423, details: { cause: error.message } });
        }
        throw error;
      }
      audit.sessionId = session.sessionId;
      audit.leaseRef = session.leaseId;
      const lease = { leaseId: session.leaseId, token: session.token };

      const created = state.createJob({
        idempotencyKey: `m6:${ik}:observe`,
        actorId: M6_SERVER_ACTOR,
        authorityNodeId: control.authorityNodeId,
        deviceId: device.deviceId,
        placement: {},
        capability,
        params: {},
        canary: true,
        sessionId: session.sessionId,
        status: "queued",
        approvalRequired: false,
        externalEffect: false,
      });
      jobRow = created.reused ? state.requireJob(created.jobId) : created.job;
      if (jobRow.sessionId !== session.sessionId) {
        throw new M6FrameCaptureError("M6_JOB_BINDING_CONFLICT", "idempotency key collided with a foreign M6 attempt", { status: 409 });
      }
      audit.jobId = jobRow.jobId;
      audit.runId = jobRow.runId;

      let observation = null;
      const terminalJob = await control.m6RunFrameJob({
        job: jobRow,
        lease,
        onVerified: ({ execution }) => { observation = execution?.output ?? null; },
      });
      if (terminalJob.status !== "succeeded" || !observation || observation.ok !== true) {
        throw new M6FrameCaptureError("M6_CAPTURE_JOB_FAILED", "observe capture job did not produce a complete observation", {
          status: 502,
          details: { jobStatus: terminalJob.status, jobErrorCode: terminalJob.errorCode ?? null },
        });
      }

      // Commit CAS evidence: A/B PNGs (bit-identical), dump XML, focus pair, and
      // the JSON observation. Any evidence failure fails the capture — no
      // debt/stub path.
      const raw = observation.evidence || {};
      const focusBlob = Buffer.concat([
        Buffer.isBuffer(raw.focusA) ? raw.focusA : Buffer.from(String(raw.focusA ?? ""), "utf8"),
        Buffer.from("\n---FOCUS-B---\n", "utf8"),
        Buffer.isBuffer(raw.focusB) ? raw.focusB : Buffer.from(String(raw.focusB ?? ""), "utf8"),
      ]);
      const refs = evidence.commitFrame({
        screenshotA: raw.screenshotA,
        screenshotB: raw.screenshotB,
        dump: raw.dump,
        focus: focusBlob,
        observation: Buffer.from(canonicalJson(observation.observation), "utf8"),
      });
      // Evidence refs are the unique CAS blobs referenced by this attempt. A/B
      // screenshots that are bit-identical share one blob (same id+sha256); the
      // receipt lists it once and the frozen frame manifest records the A/B slot
      // mapping. The receipt schema requires uniqueItems, so dedupe by ref id.
      const refList = Object.keys(refs).map((key) => refs[key]);
      audit.evidenceRefs = [...new Map(refList.map((r) => [r.id, r])).values()];

      const focusA = {
        raw: String(raw.focusA ?? ""),
        screenOn: observation.focusA?.screenOn ?? null,
        keyboardVisible: observation.focusA?.keyboardVisible ?? null,
        rotation: observation.focusA?.rotation ?? null,
      };
      const focusB = {
        raw: String(raw.focusB ?? ""),
        screenOn: observation.focusB?.screenOn ?? null,
        keyboardVisible: observation.focusB?.keyboardVisible ?? null,
        rotation: observation.focusB?.rotation ?? null,
      };
      const focusFingerprint = focusStableFieldsHash(focusA, focusB);
      if (!focusFingerprint) {
        throw new M6FrameCaptureError("M6_FRAME_FOCUS_UNSTABLE", "focus A/B disagree on stable fields; capture fails closed", { status: 409 });
      }
      const pageFingerprint = sha256(`xw.page.v1:${canonicalJson({
        package: observation.observation?.package ?? null,
        activity: observation.observation?.activity ?? null,
        width: observation.observation?.width ?? null,
        height: observation.observation?.height ?? null,
        orientation: observation.observation?.orientation ?? null,
        density: observation.observation?.density ?? null,
      })}`);

      // Fail-closed drift check: re-evaluate the gate immediately before the
      // manifest commit. The gate was resolved at capture start; if the active
      // epoch has since drifted (closed/expired/sealed/replaced) the capture
      // must NOT commit a frame against a stale epoch hash. resolveGate throws
      // on any closed/expired state; an epoch-hash change is M6_GATE_DRIFT.
      const recheck = resolveGate(a, now());
      if (recheck.epochHash !== gateState.epochHash) {
        throw new M6FrameCaptureError("M6_GATE_DRIFT", "active epoch changed between gate resolution and manifest commit", {
          status: 409,
          details: { startEpochHash: gateState.epochHash, recheckEpochHash: recheck.epochHash },
        });
      }

      const frozen = assembleLiveStrictFrame({
        screenshotABytes: raw.screenshotA,
        screenshotBBytes: raw.screenshotB,
        dumpBytes: raw.dump,
        focusA,
        focusB,
        displayObservation: observation.observation,
        skew: observation.skew,
        nowMs: now(),
        capturedAt: observation.capturedAt,
        evidence: refs,
        linkage: { sessionId: session.sessionId, leaseRef: `lease-${session.leaseId}`, alias: a, appId: "xiaowei" },
        pageFingerprint,
        focusFingerprint,
      });
      if (!frozen.ok || !frozen.frame) {
        const code = frozen.errors?.[0]?.code ?? "M6_FRAME_INVALID";
        throw new M6FrameCaptureError(code, `strict frame freeze rejected the capture: ${frozen.errors?.[0]?.message ?? "unknown"}`, { status: 409 });
      }
      const frame = frozen.frame;
      // #8: defense in depth — re-verify the frozen manifest against the raw
      // evidence bytes before commit. The frame was just assembled from these
      // bytes, so this should always pass; it guards against any future drift
      // between assembly and the durable audit trail.
      const observationBuffer = Buffer.from(canonicalJson(observation.observation), "utf8");
      const manifestResolve = (ref) => ({
        [refs.screenshotA.id]: raw.screenshotA,
        [refs.screenshotB.id]: raw.screenshotB,
        [refs.dump.id]: raw.dump,
        [refs.focus.id]: focusBlob,
        [refs.observation.id]: observationBuffer,
      })[ref.id] ?? null;
      const manifestCheck = verifyFrameManifest(frame, manifestResolve);
      if (!manifestCheck.ok) {
        const code = manifestCheck.errors[0].code ?? "M6_FRAME_MANIFEST_INVALID";
        throw new M6FrameCaptureError(code, `frame manifest verification failed: ${manifestCheck.errors[0].message}`, {
          status: 409,
          details: { errors: manifestCheck.errors },
        });
      }
      const committedAt = iso(now());
      const remainingTtlMs = Math.max(0, Date.parse(frame.expiresAt) - Date.parse(committedAt));
      const receipt = buildReceipt({
        attemptId,
        runId: audit.runId,
        jobId: audit.jobId,
        sessionId: audit.sessionId,
        leaseRef: audit.leaseRef,
        alias: a,
        scenarioLabel: s,
        epochHash: gateState.epochHash,
        status: "accepted",
        frameRef: { id: frame.frameId, sha256: frame.manifestSha256 },
        gateMode: gateState.mode,
        errorCodes: [],
        evidenceRefs: audit.evidenceRefs,
        skew: observation.skew,
        remainingTtlMs,
        capturedAt: observation.capturedAt,
        committedAt,
      });
      // The facade never emits a receipt the frozen contract would reject.
      const acceptedValidation = validateCaptureAttemptReceipt(receipt);
      if (!acceptedValidation.ok) {
        throw new M6FrameCaptureError("M6_RECEIPT_INVALID", `accepted receipt failed contract validation: ${acceptedValidation.errors.join("; ")}`, {
          status: 500,
          details: { errors: acceptedValidation.errors },
        });
      }
      // Do not persist or return accepted state yet. Cleanup is part of the
      // transaction: a frame becomes consumable only after job/session/lease
      // convergence succeeds.
      acceptedRecord = { receipt, frame };
    } catch (error) {
      captureError = error;
    }

    const cleanupErrors = [];
    if (session) {
      try {
        if (jobRow) {
          const current = state.getJob(jobRow.jobId);
          if (current && ["queued", "waiting_approval", "running"].includes(current.status)) state.cancelJob(jobRow.jobId);
        }
      } catch (e) { cleanupErrors.push({ phase: "cancelJob", code: e?.code ?? null, message: e?.message ?? String(e) }); }
      try { control.releaseSession(session.sessionId, session.token); }
      catch (e) { cleanupErrors.push({ phase: "releaseSession", code: e?.code ?? null, message: e?.message ?? String(e) }); }
    }
    if (cleanupErrors.length > 0) {
      captureError = new M6FrameCaptureError("M6_CLEANUP_FAILED", "session/lease/job cleanup failed after capture convergence", {
        status: 500,
        details: { cleanupErrors },
      });
      acceptedRecord = null;
    }

    // The final commit decision happens after cleanup and reloads the signed
    // gate from its trusted source. A close/rollback that lands while cleanup
    // is running therefore prevents an accepted receipt from being committed.
    if (!captureError && acceptedRecord) {
      try {
        const commitGate = resolveGate(a, now());
        if (commitGate.epochHash !== gateState.epochHash) {
          throw new M6FrameCaptureError("M6_GATE_DRIFT", "active epoch changed before accepted receipt commit", {
            status: 409,
            details: { startEpochHash: gateState.epochHash, commitEpochHash: commitGate.epochHash },
          });
        }
        const committedAt = iso(now());
        const remainingTtlMs = Math.max(0, Date.parse(acceptedRecord.frame.expiresAt) - Date.parse(committedAt));
        if (remainingTtlMs < M6_FRAME_CONSTANTS.minTtlOnReturnMs) {
          throw new M6FrameCaptureError(
            "M6_FRAME_TTL_EXPIRING",
            `fewer than ${M6_FRAME_CONSTANTS.minTtlOnReturnMs}ms of TTL remain after cleanup`,
            { status: 409, details: { remainingTtlMs } },
          );
        }
        acceptedRecord.receipt = buildReceipt({
          ...acceptedRecord.receipt,
          remainingTtlMs,
          committedAt,
        });
        const finalReceiptValidation = validateCaptureAttemptReceipt(acceptedRecord.receipt);
        if (!finalReceiptValidation.ok) {
          throw new M6FrameCaptureError(
            "M6_RECEIPT_INVALID",
            `post-cleanup receipt failed contract validation: ${finalReceiptValidation.errors.join("; ")}`,
            { status: 500, details: { errors: finalReceiptValidation.errors } },
          );
        }
        writeAuditJson(auditRoot, attemptId, acceptedRecord);
        return acceptedRecord.receipt;
      } catch (error) {
        captureError = error;
        acceptedRecord = null;
      }
    }

    audit.errorCodes = [captureError?.code || "M6_CAPTURE_FAILED"];
    audit.committedAt = iso(now());
    audit.status = "rejected";
    const rejectedReceipt = buildReceipt({
      attemptId,
      runId: audit.runId,
      jobId: audit.jobId,
      sessionId: audit.sessionId,
      leaseRef: audit.leaseRef,
      alias: a,
      scenarioLabel: s,
      epochHash: gateState.epochHash,
      status: "rejected",
      frameRef: null,
      gateMode: gateState.mode,
      errorCodes: audit.errorCodes,
      evidenceRefs: audit.evidenceRefs,
      skew: null,
      remainingTtlMs: null,
      capturedAt: audit.capturedAt,
      committedAt: audit.committedAt,
    });
    const rejectedValidation = validateCaptureAttemptReceipt(rejectedReceipt);
    try {
      writeAuditJson(auditRoot, attemptId, rejectedValidation.ok
        ? { receipt: rejectedReceipt, tombstone: { acceptedFrameCommitted: false, reason: audit.errorCodes[0] } }
        : { receipt: rejectedReceipt, receiptValidationErrors: rejectedValidation.errors, tombstone: { acceptedFrameCommitted: false, reason: audit.errorCodes[0] } });
    } catch { /* audit persistence is best-effort; the capture error still propagates */ }
    throw captureError;
  }

  // status: read-only replay of the durable attempt trail. Returns only opaque
  // refs; never a token or raw pixels.
  function status({ attemptId } = {}) {
    const a = requireString(attemptId, "attemptId", "M6_ATTEMPT_ID_REQUIRED", /^[A-Za-z0-9._-]{1,128}$/);
    const record = readAuditJson(auditRoot, a);
    if (!record) throw new M6FrameCaptureError("M6_ATTEMPT_NOT_FOUND", `unknown attempt '${a}'`, { status: 404 });
    return { ok: true, attempt: redactM6Output(record.receipt) };
  }

  // closeout: writes a content-addressed closeout marker binding epoch hash +
  // attempt/job/session/lease refs. Sessions/leases are already converged by
  // capture's finally; closeout re-confirms that convergence before sealing.
  function closeout({ attemptId, reason = "operator" } = {}) {
    const a = requireString(attemptId, "attemptId", "M6_ATTEMPT_ID_REQUIRED", /^[A-Za-z0-9._-]{1,128}$/);
    const record = readAuditJson(auditRoot, a);
    if (!record) throw new M6FrameCaptureError("M6_ATTEMPT_NOT_FOUND", `attempt '${a}' not found`, { status: 404 });
    const base = record.receipt || record;
    // #7: convergence gate before sealing. capture's finally cancels the job +
    // releases the session/lease; closeout must refuse to seal a window whose
    // job is still non-terminal or whose session/lease survived (a leak). Read-
    // only probes (state.getJob / sessionExists / leaseExists); no re-release.
    const NON_TERMINAL_JOB = new Set(["queued", "waiting_approval", "running"]);
    const convergenceErrors = [];
    if (base.jobId) {
      const job = typeof state.getJob === "function" ? state.getJob(base.jobId) : null;
      if (job && NON_TERMINAL_JOB.has(job.status)) {
        convergenceErrors.push({ ref: "job", id: base.jobId, status: job.status });
      }
    }
    if (base.sessionId && typeof state.sessionExists === "function" && state.sessionExists(base.sessionId)) {
      convergenceErrors.push({ ref: "session", id: base.sessionId });
    }
    if (base.leaseRef && typeof state.leaseExists === "function" && state.leaseExists(base.leaseRef)) {
      convergenceErrors.push({ ref: "lease", id: base.leaseRef });
    }
    if (convergenceErrors.length > 0) {
      throw new M6FrameCaptureError("M6_CLOSEOUT_CONVERGENCE_FAILED", "closeout refused: job/session/lease not converged (leak detected)", {
        status: 409,
        details: { convergenceErrors },
      });
    }
    const closeoutId = newId("m6closeout");
    const finalReason = typeof reason === "string" && reason.length > 0 && reason.length <= 128 ? reason : "operator";
    const committedAt = iso(now());
    const closeout = {
      closeoutId,
      attemptId: a,
      epochHash: base.epochHash ?? null,
      runId: base.runId ?? null,
      jobId: base.jobId ?? null,
      sessionId: base.sessionId ?? null,
      leaseRef: base.leaseRef ?? null,
      actor: M6_SERVER_ACTOR,
      reason: finalReason,
      committedAt,
      closeoutHash: sha256(`xw.m6-frame-capture.v1:closeout:${canonicalJson({
        closeoutId,
        attemptId: a,
        epochHash: base.epochHash ?? null,
        runId: base.runId ?? null,
        jobId: base.jobId ?? null,
        sessionId: base.sessionId ?? null,
        leaseRef: base.leaseRef ?? null,
        actor: M6_SERVER_ACTOR,
        reason: finalReason,
        committedAt,
      })}`),
    };
    writeAuditJson(auditRoot, `${a}.closeout`, { closeout });
    return redactM6Output({ ok: true, closeout });
  }

  return { preflight, capture, status, closeout, health };
}
