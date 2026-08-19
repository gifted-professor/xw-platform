import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ControlPlaneError } from "./errors.mjs";
import { validateJsonSchema } from "./json-schema-validator.mjs";
import {
  validateDeviceSession,
  validateObservation,
} from "../../../../packages/kernel/lib/open-action.mjs";

export const DEVICE_SESSION_SCHEMA_ID = "xw.open-action.device-session.v1";
export const OBSERVATION_SCHEMA_ID = "xw.open-action.observation.v1";
export const FIXTURE_NO_ARTIFACT_REASON = "fixture_provider_no_device_artifact";
export const FIXTURE_PAGE_KEY = "fixture.home";

const here = dirname(fileURLToPath(import.meta.url));
const OBSERVATION_SCHEMA = JSON.parse(readFileSync(
  join(here, "../../../../packages/kernel/contracts/open-action/observation.v1.schema.json"),
  "utf8",
));

const AUTHORITATIVE_OBSERVATION_KEYS = Object.freeze([
  "schemaId",
  "schemaVersion",
  "observationId",
  "deviceId",
  "sessionId",
  "capturedAt",
]);

const FIXTURE_SURFACE_KEYS = Object.freeze([
  "packageName",
  "activityName",
  "orientation",
  "viewport",
  "screenOn",
  "keyboardVisible",
  "elements",
  "paymentSignals",
  "paymentSignalSetVersion",
  "paymentClassificationComplete",
  "pageKey",
]);

function sha256Text(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

export function fixturePageHash(pageKey = FIXTURE_PAGE_KEY) {
  return sha256Text(`fixture-page:${pageKey}`);
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

export function assertObservationBinding(observation, session) {
  if (!observation || !session) {
    throw new ControlPlaneError("OBSERVATION_BINDING_MISMATCH", "observation is not bound to the authorized session", {
      status: 409,
    });
  }
  if (observation.sessionId !== session.sessionId || observation.deviceId !== session.deviceId) {
    throw new ControlPlaneError(
      "OBSERVATION_BINDING_MISMATCH",
      "observation deviceId/sessionId must match the authorized session",
      {
        status: 409,
        details: {
          observationSessionId: observation.sessionId,
          observationDeviceId: observation.deviceId,
          sessionId: session.sessionId,
          deviceId: session.deviceId,
        },
      },
    );
  }
}

export function requireObservationContract(observation, session) {
  const schemaErrors = validateJsonSchema(observation, OBSERVATION_SCHEMA);
  if (schemaErrors.length) {
    throw new ControlPlaneError(
      "OBSERVATION_INCOMPLETE",
      "observation does not satisfy ObservationV1",
      { status: 422, details: { errors: schemaErrors } },
    );
  }
  const check = validateObservation(observation);
  if (!check.ok) {
    const first = check.errors[0] || { code: "OBSERVATION_INCOMPLETE", message: "invalid observation" };
    throw new ControlPlaneError(first.code, first.message, {
      status: 422,
      details: { errors: check.errors },
    });
  }
  assertObservationBinding(observation, session);
  return observation;
}

export function rejectMutatingObserveInput(input = {}) {
  const fields = ["kind", "primitive", "action"];
  const present = fields
    .map((field) => ({ field, value: input[field] }))
    .filter((item) => item.value != null && item.value !== "");
  if (present.length === 0) return;
  const conflicting = new Set(present.map((item) => item.value));
  const disallowed = present.filter((item) => item.value !== "observe");
  if (disallowed.length || conflicting.size > 1) {
    throw new ControlPlaneError(
      "PRIMITIVE_NOT_SUPPORTED",
      "M3-B device-sessions accept observe only",
      {
        status: 405,
        details: Object.fromEntries(present.map((item) => [item.field, item.value])),
      },
    );
  }
}

function pickFixtureSurface(fixture = {}) {
  const out = {};
  for (const key of FIXTURE_SURFACE_KEYS) {
    if (fixture[key] !== undefined) out[key] = fixture[key];
  }
  return out;
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
      const surface = pickFixtureSurface(fixture);
      const pageKey = surface.pageKey || FIXTURE_PAGE_KEY;
      delete surface.pageKey;
      const capturedAt = new Date(now()).toISOString();
      const observationId = `obs_${randomUUID()}`;
      const observation = {
        ...surface,
        schemaId: OBSERVATION_SCHEMA_ID,
        schemaVersion: 1,
        observationId,
        deviceId: session.deviceId,
        deviceAlias: session.deviceAlias || "fixture",
        sessionId: session.sessionId,
        capturedAt,
        packageName: surface.packageName ?? "fixture.app",
        activityName: surface.activityName ?? "fixture.Home",
        orientation: surface.orientation ?? "portrait",
        viewport: surface.viewport ?? { width: 1080, height: 1920 },
        screenOn: surface.screenOn ?? true,
        keyboardVisible: surface.keyboardVisible ?? false,
        screenshotRef: null,
        screenshotSha256: null,
        ocrRef: null,
        accessibilityRef: null,
        uiTreeRef: null,
        elements: surface.elements ?? [],
        pageHash: fixturePageHash(pageKey),
        paymentSignals: surface.paymentSignals ?? [],
        paymentSignalSetVersion: surface.paymentSignalSetVersion ?? 1,
        paymentClassificationComplete: surface.paymentClassificationComplete ?? true,
        evidenceRefs: [],
        partial: true,
        partialReason: FIXTURE_NO_ARTIFACT_REASON,
      };
      for (const key of AUTHORITATIVE_OBSERVATION_KEYS) {
        if (key === "schemaId") observation.schemaId = OBSERVATION_SCHEMA_ID;
        if (key === "schemaVersion") observation.schemaVersion = 1;
        if (key === "observationId") observation.observationId = observationId;
        if (key === "deviceId") observation.deviceId = session.deviceId;
        if (key === "sessionId") observation.sessionId = session.sessionId;
        if (key === "capturedAt") observation.capturedAt = capturedAt;
      }
      return observation;
    },
  };
}
