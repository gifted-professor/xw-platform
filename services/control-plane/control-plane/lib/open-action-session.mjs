import { createHash, randomUUID } from "node:crypto";

import { ControlPlaneError } from "./errors.mjs";
import {
  validateDeviceSession,
  validateObservation,
} from "../../../../packages/kernel/lib/open-action.mjs";

export const DEVICE_SESSION_SCHEMA_ID = "xw.open-action.device-session.v1";
export const OBSERVATION_SCHEMA_ID = "xw.open-action.observation.v1";

const ZERO_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function sha256Text(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

export function assertSessionKind(session, expected) {
  const kind = session?.sessionKind || "capability";
  if (kind !== expected) {
    throw new ControlPlaneError(
      "SESSION_KIND_MISMATCH",
      `sessionKind ${kind} cannot use the ${expected} lane`,
      { status: 409, details: { sessionKind: kind, expected } },
    );
  }
  return session;
}

export function toDeviceSessionView(session, { actorId, createdAt, capabilityId = null } = {}) {
  return {
    schemaId: DEVICE_SESSION_SCHEMA_ID,
    schemaVersion: 1,
    sessionId: session.sessionId,
    sessionKind: session.sessionKind || "open_action",
    deviceId: session.deviceId,
    leaseId: session.leaseId,
    actor: actorId || session.actorId,
    createdAt: createdAt || session.createdAt,
    capabilityId: capabilityId === undefined ? session.scopeCapabilityId ?? null : capabilityId,
  };
}

export function requireOpenActionContract({ sessionKind = "open_action", capabilityId = null } = {}) {
  const check = validateDeviceSession({ sessionKind, capabilityId });
  if (!check.ok) {
    const first = check.errors[0] || { code: "SESSION_KIND_MISMATCH", message: "invalid device session" };
    throw new ControlPlaneError(first.code, first.message, {
      status: 409,
      details: { errors: check.errors },
    });
  }
  return check;
}

export function requireObservationContract(observation) {
  const check = validateObservation(observation);
  if (!check.ok) {
    const first = check.errors[0] || { code: "OBSERVATION_INCOMPLETE", message: "invalid observation" };
    throw new ControlPlaneError(first.code, first.message, {
      status: 422,
      details: { errors: check.errors },
    });
  }
  return observation;
}

export function rejectMutatingObserveInput(input = {}) {
  const kind = input.kind || input.primitive || input.action;
  if (kind && kind !== "observe") {
    throw new ControlPlaneError(
      "PRIMITIVE_NOT_SUPPORTED",
      `M3-B device-sessions accept observe only, got ${kind}`,
      { status: 405, details: { kind } },
    );
  }
}

export function createFakeObserveProvider({ fixture = {}, now = Date.now } = {}) {
  const state = { observeCount: 0, mutatingCalls: 0 };
  return {
    get observeCount() {
      return state.observeCount;
    },
    get mutatingCalls() {
      return state.mutatingCalls;
    },
    async observe(session) {
      state.observeCount += 1;
      const capturedAt = new Date(now()).toISOString();
      const observationId = `obs_${randomUUID()}`;
      const screenshotRef = `evidence:fixture-screenshot:${observationId}`;
      const ocrRef = `evidence:fixture-ocr:${observationId}`;
      const accessibilityRef = `evidence:fixture-a11y:${observationId}`;
      const uiTreeRef = `evidence:fixture-uitree:${observationId}`;
      return {
        schemaId: OBSERVATION_SCHEMA_ID,
        schemaVersion: 1,
        observationId,
        deviceId: session.deviceId,
        deviceAlias: session.deviceAlias || "fixture",
        sessionId: session.sessionId,
        capturedAt,
        packageName: "fixture.app",
        activityName: "fixture.Home",
        orientation: "portrait",
        viewport: { width: 1080, height: 1920 },
        screenOn: true,
        keyboardVisible: false,
        screenshotRef,
        screenshotSha256: sha256Text(screenshotRef),
        ocrRef,
        accessibilityRef,
        uiTreeRef,
        elements: [],
        pageHash: sha256Text(`${session.deviceId}:${observationId}`),
        paymentSignals: [],
        evidenceRefs: [screenshotRef, ocrRef, accessibilityRef, uiTreeRef],
        partial: false,
        partialReason: null,
        ...fixture,
      };
    },
  };
}

export function emptyScreenshotDigest() {
  return ZERO_SHA256;
}
