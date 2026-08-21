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
import { join } from "node:path";

import { assembleLiveStrictFrame, focusStableFieldsHash } from "../../../../packages/kernel/lib/m6-screen-frame.mjs";
import { canonicalJson, newId, sha256 } from "./canonical.mjs";
import { ControlPlaneError } from "./errors.mjs";
import { evaluateM6Gate, m6AliasAllowed } from "./m6-live-gate.mjs";

export const M6_OBSERVE_CAPABILITY_ID = "xiaowei.m6.observe_frame";
export const M6_PROVIDER_ADAPTER_ID = "xiaowei";
export const M6_SERVER_ACTOR = "agent:m6-facade";
export const M6_SCENARIO_LABELS = Object.freeze(["observe"]);
export const M6_ALIAS_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
export const M6_IDEMPOTENCY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

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
  release = null,    // { releaseId, sourceCommit } — gate drift check
  profile = null,    // { runtimeProfile, agenticGroundingEnabled } — immutable release profile
  devices = null,    // { findByAlias(alias) } — server-side alias resolution
  now = Date.now,
  lockHashes = null,
} = {}) {
  if (!control || !state || !capabilities || !evidence) {
    throw new M6FrameCaptureError("M6_FACADE_DEPS_INVALID", "createM6FrameCapture requires control, state, capabilities, and evidence", { status: 503 });
  }
  const resolveDevice = devices && typeof devices.findByAlias === "function"
    ? (alias) => devices.findByAlias(alias) || null
    : (alias) => state.listDevices().find((d) => d.alias === alias) ?? null;

  // Fail-closed gate + profile evaluation. Called BEFORE any lease/session/read
  // resource exists; nothing here touches a device or the transport.
  function resolveGate(alias, nowMs) {
    const result = evaluateM6Gate({ chain: gate.chain, closeouts: gate.closeouts, nowMs, expectedRelease: release, lockHashes });
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
    return { mode: result.mode, epochHash: result.activeEpochHash, epoch: result.activeEpoch };
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
    const s = requireString(scenarioLabel ?? "observe", "scenarioLabel", "M6_SCENARIO_LABEL_INVALID", /^[A-Za-z0-9._-]{0,64}$/);
    if (!M6_SCENARIO_LABELS.includes(s)) {
      throw new M6FrameCaptureError("M6_SCENARIO_LABEL_INVALID", `scenarioLabel must be one of ${M6_SCENARIO_LABELS.join(", ")}`, { status: 400 });
    }
    const gateState = resolveGate(a, now());
    requireObserveCapability();
    const device = resolveDevice(a);
    if (!device || !device.deviceId) {
      throw new M6FrameCaptureError("M6_DEVICE_NOT_FOUND", `no control-plane device is bound to alias '${a}'`, { status: 404 });
    }
    return { ok: true, gateMode: gateState.mode, epochHash: gateState.epochHash, alias: a, scenarioLabel: s };
  }

  async function capture({ alias, scenarioLabel = "observe", idempotencyKey, nowMs } = {}) {
    const a = requireString(alias, "alias", "M6_ALIAS_INVALID", M6_ALIAS_PATTERN);
    const s = requireString(scenarioLabel, "scenarioLabel", "M6_SCENARIO_LABEL_INVALID", /^[A-Za-z0-9._-]{0,64}$/);
    const ik = requireString(idempotencyKey, "idempotencyKey", "M6_IDEMPOTENCY_REQUIRED", M6_IDEMPOTENCY_PATTERN);
    if (!M6_SCENARIO_LABELS.includes(s)) {
      throw new M6FrameCaptureError("M6_SCENARIO_LABEL_INVALID", `scenarioLabel must be one of ${M6_SCENARIO_LABELS.join(", ")}`, { status: 400 });
    }
    const at = Number.isFinite(nowMs) ? nowMs : now();
    const gateState = resolveGate(a, at);
    const capability = requireObserveCapability();

    const device = resolveDevice(a);
    if (!device || !device.deviceId) {
      throw new M6FrameCaptureError("M6_DEVICE_NOT_FOUND", `no control-plane device is bound to alias '${a}'`, { status: 404 });
    }

    const attemptId = newId("m6attempt");
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
      capturedAt: null,
      committedAt: null,
    };
    let session = null;
    let jobRow = null;
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
      audit.evidenceRefs = Object.keys(refs).map((key) => refs[key].id);

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
      writeAuditJson(auditRoot, attemptId, { receipt, frame });
      return receipt;
    } catch (error) {
      audit.errorCodes = [error.code || "M6_CAPTURE_FAILED"];
      audit.committedAt = iso(now());
      audit.status = "rejected";
      try { writeAuditJson(auditRoot, attemptId, { receipt: audit }); } catch { /* audit is best-effort */ }
      throw error;
    } finally {
      if (session) {
        try {
          if (jobRow) {
            const current = state.getJob(jobRow.jobId);
            if (current && ["queued", "waiting_approval", "running"].includes(current.status)) state.cancelJob(jobRow.jobId);
          }
        } catch { /* convergence is best-effort */ }
        try { control.releaseSession(session.sessionId, session.token); } catch { /* convergence is best-effort */ }
      }
    }
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
  // capture's finally; closeout only seals the audit trail.
  function closeout({ attemptId, reason = "operator" } = {}) {
    const a = requireString(attemptId, "attemptId", "M6_ATTEMPT_ID_REQUIRED", /^[A-Za-z0-9._-]{1,128}$/);
    const record = readAuditJson(auditRoot, a);
    if (!record) throw new M6FrameCaptureError("M6_ATTEMPT_NOT_FOUND", `attempt '${a}' not found`, { status: 404 });
    const base = record.receipt || record;
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

  return { preflight, capture, status, closeout };
}
