#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CapabilityRegistry } from "../../services/control-plane/control-plane/lib/capability-registry.mjs";
import { StateStore } from "../../services/control-plane/control-plane/lib/state-store.mjs";

const SCHEMA_ID = "xw.m6-same-lease-spike.v1";
const CAPABILITY_ID = "xiaowei.m6.grounded_run";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function invariant(condition, code) {
  if (!condition) throw Object.assign(new Error(code), { code });
}

function observation(id, phase) {
  return {
    schemaId: "xw.m6-spike-observation.v1",
    observationId: id,
    phase,
    frameRef: sha256(`frame:${phase}`),
    evidenceRefs: [sha256(`evidence:${phase}`)],
    externalEffect: false,
  };
}

async function main() {
  const outIndex = process.argv.indexOf("--out");
  const out = resolve(outIndex >= 0 && process.argv[outIndex + 1]
    ? process.argv[outIndex + 1]
    : "artifacts/m6-4/m6-4-same-lease-spike.json");
  const appsRoot = fileURLToPath(new URL("../../services/control-plane/apps", import.meta.url));
  const sourceCapability = CapabilityRegistry.load(appsRoot).require("xiaowei.explorer.primitive");
  const capability = {
    ...sourceCapability,
    id: CAPABILITY_ID,
    lifecycle: "canary_only",
    invocationPolicy: { allowedModes: ["session"] },
  };
  const state = new StateStore();
  const checkpoints = [];
  try {
    state.syncCapabilities({ capabilities: [capability] });
    state.upsertNode({ nodeId: "m6-4-spike-node", status: "online", authority: true });
    const device = state.upsertDevice({
      deviceId: "m6-4-spike-device",
      alias: "01",
      physicalLabel: "redacted-spike-device",
      nodeId: "m6-4-spike-node",
      runtimeId: "m6-4-spike-runtime",
      routingProfile: { enabled: true, tags: ["m6-4-spike"], capabilityIds: [CAPABILITY_ID] },
    });
    const session = state.createSession({
      actorId: "agent:m6-4-spike",
      authorityNodeId: "m6-4-spike-node",
      deviceId: device.deviceId,
      capability,
      canary: true,
      ttlMs: 60_000,
    });
    checkpoints.push({ phase: "session_created", leaseRef: sha256(session.leaseId), scope: session.scopeCapabilityId });

    const created = state.createJob({
      idempotencyKey: "m6-4-same-lease-spike",
      actorId: session.actorId,
      authorityNodeId: "m6-4-spike-node",
      deviceId: session.deviceId,
      capability,
      params: { spike: true },
      canary: true,
      sessionId: session.sessionId,
      status: "waiting_approval",
      approvalRequired: false,
      externalEffect: false,
    });
    let job = created.job;
    invariant(job.status === "waiting_approval", "JOB_MUST_START_NON_PUMPABLE");
    invariant(job.sessionId === session.sessionId, "JOB_SESSION_BINDING_MISMATCH");
    invariant(job.deviceId === session.deviceId, "JOB_DEVICE_BINDING_MISMATCH");
    invariant(job.capabilityId === CAPABILITY_ID, "JOB_CAPABILITY_BINDING_MISMATCH");
    invariant(state.validateSession(session.sessionId, session.token).leaseId === session.leaseId, "LEASE_CHANGED_BEFORE_RUN");
    checkpoints.push({ phase: "job_non_pumpable", leaseRef: sha256(session.leaseId), jobStatus: job.status });

    state.transitionJob(job.jobId, "queued", { payload: { validated: ["policy", "adapter", "dispatchRef"] } });
    state.transitionJob(job.jobId, "running");
    job = state.getJob(job.jobId);
    invariant(job.status === "running", "JOB_NOT_RUNNING_AFTER_VALIDATION");

    const before = observation("obs-before", "observe");
    state.recordObservationCapture({ sessionId: session.sessionId, observation: before, mutatingCalls: 0 });
    checkpoints.push({ phase: "observe", leaseRef: sha256(state.validateSession(session.sessionId, session.token).leaseId) });

    state.recordDeviceSessionEvent({
      sessionId: session.sessionId,
      type: "grounding.decided",
      payload: { decisionRef: sha256("grounding-decision"), transportCalled: false },
    });
    checkpoints.push({ phase: "ground", leaseRef: sha256(state.validateSession(session.sessionId, session.token).leaseId) });

    const action = { actionId: "spike-action", idempotencyKey: "spike-action-1", primitive: "tap" };
    const actionRecord = state.recordDeviceSessionAction({
      sessionId: session.sessionId,
      action,
      fingerprint: { operation: "fake_dispatch", targetRef: sha256("target") },
      result: { ok: true, fakeTransport: true, externalEffect: false, transportCalls: 0 },
      executed: true,
    });
    invariant(actionRecord.reused === false, "FAKE_DISPATCH_NOT_RECORDED");
    checkpoints.push({ phase: "fake_dispatch", leaseRef: sha256(state.validateSession(session.sessionId, session.token).leaseId) });

    const after = observation("obs-after", "after-observe");
    state.recordObservationCapture({ sessionId: session.sessionId, observation: after, mutatingCalls: 0 });
    state.recordDeviceSessionEvent({
      sessionId: session.sessionId,
      type: "action.verified",
      payload: { actionId: action.actionId, beforeObservationId: before.observationId, afterObservationId: after.observationId },
    });
    checkpoints.push({ phase: "after_observe_verify", leaseRef: sha256(state.validateSession(session.sessionId, session.token).leaseId) });

    state.transitionJob(job.jobId, "verifying");
    state.transitionJob(job.jobId, "restoring");
    state.transitionJob(job.jobId, "succeeded", {
      result: { externalEffect: false, transportCalls: 0, sameLease: true },
    });
    const finalJob = state.getJob(job.jobId);
    const events = state.listDeviceSessionEvents(session.sessionId);
    const mutations = state.countDeviceSessionMutations(session.sessionId);
    const liveLeaseBeforeClose = state.validateSession(session.sessionId, session.token).leaseId;
    invariant(liveLeaseBeforeClose === session.leaseId, "LEASE_CHANGED_DURING_RUN");
    invariant(finalJob.status === "succeeded", "JOB_NOT_TERMINAL");
    invariant(events.some((event) => event.type === "grounding.decided"), "GROUND_EVENT_MISSING");
    invariant(events.some((event) => event.type === "action.verified"), "VERIFY_EVENT_MISSING");
    invariant(mutations === 1, "LEDGER_MUTATION_COUNT_MISMATCH");
    state.releaseSession(session.sessionId, session.token);
    invariant(!state.sessionExists(session.sessionId), "SESSION_RESIDUE");
    invariant(!state.leaseExists(session.leaseId), "LEASE_RESIDUE");
    checkpoints.push({ phase: "close", leaseRef: sha256(session.leaseId), resourcesReleased: true });

    const leaseRefs = new Set(checkpoints.map((entry) => entry.leaseRef));
    const core = {
      schemaId: SCHEMA_ID,
      compositeCapabilityId: CAPABILITY_ID,
      initialJobPumpable: false,
      validationBeforeRunning: ["policy", "adapter", "dispatchRef"],
      phases: checkpoints,
      oneSession: true,
      oneLease: leaseRefs.size === 1,
      scopeCapabilityStable: checkpoints.every((entry) => !entry.scope || entry.scope === CAPABILITY_ID),
      jobTerminalStatus: finalJob.status,
      fakeTransportCalls: 0,
      externalEffect: false,
      actionLedgerCount: mutations,
      sessionResidue: false,
      leaseResidue: false,
      allPassed: leaseRefs.size === 1 && finalJob.status === "succeeded",
      sourceSha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
    };
    const artifact = { ...core, artifactSha256: sha256(`${SCHEMA_ID}:${canonical(core)}`) };
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({ ok: artifact.allPassed, out, artifactSha256: artifact.artifactSha256 }, null, 2)}\n`);
    return artifact.allPassed ? 0 : 1;
  } finally {
    state.close();
  }
}

main().then((code) => { process.exitCode = code; }).catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error.message, code: error.code, stack: error.stack }, null, 2)}\n`);
  process.exitCode = 2;
});
