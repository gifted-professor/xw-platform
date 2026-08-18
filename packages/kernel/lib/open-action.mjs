import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const kernelRoot = join(here, "..");

export const PUBLIC_PRIMITIVES = Object.freeze([
  "observe",
  "tap",
  "long_press",
  "swipe",
  "drag",
  "scroll",
  "type_text",
  "press_key",
  "back",
  "home",
  "recents",
  "open_app",
  "wait",
]);

export const FORBIDDEN_PUBLIC_PRIMITIVES = Object.freeze([
  "raw_adb",
  "shell",
  "arbitrary_subprocess",
  "payment_override",
  "policy_override",
]);

export const MUTATING_PRIMITIVES = Object.freeze([
  "tap",
  "long_press",
  "swipe",
  "drag",
  "scroll",
  "type_text",
  "press_key",
  "back",
  "home",
  "recents",
  "open_app",
]);

export const EFFECT_POLICY = Object.freeze({
  nonpayment: "ALLOW_WITH_TRACE",
  payment_credential: "HUMAN_REQUIRED",
  payment_final_commit: "HUMAN_REQUIRED",
  payment_context_uncertain: "REOBSERVE_REQUIRED",
});

const SELECTOR_KEYS = [
  "elementId",
  "absoluteCoordinate",
  "normalizedCoordinate",
  "text",
  "resourceId",
  "imageAnchor",
  "boundingBoxRelativePoint",
];

export function loadKernelJson(rel) {
  return JSON.parse(readFileSync(join(kernelRoot, rel), "utf8"));
}

export function isPublicPrimitive(kind) {
  return PUBLIC_PRIMITIVES.includes(kind);
}

function fail(errors, code, message) {
  errors.push({ code, message });
}

function selectorModes(target) {
  if (!target || typeof target !== "object") return [];
  const modes = SELECTOR_KEYS.filter((key) => target[key] != null);
  if (target.accessibilityRole != null || target.accessibilityName != null) modes.push("accessibility");
  return modes;
}

export function validatePrimitiveAction(action) {
  const errors = [];
  if (!action || typeof action !== "object") {
    return { ok: false, errors: [{ code: "INVALID_ACTION", message: "action must be an object" }] };
  }
  if (FORBIDDEN_PUBLIC_PRIMITIVES.includes(action.kind)) {
    fail(errors, "PRIMITIVE_NOT_SUPPORTED", `${action.kind} is not a public primitive`);
  } else if (!isPublicPrimitive(action.kind)) {
    fail(errors, "PRIMITIVE_NOT_SUPPORTED", `unknown primitive: ${action.kind}`);
  }
  if (MUTATING_PRIMITIVES.includes(action.kind)) {
    if (!action.actionId) fail(errors, "INVALID_ACTION", "mutating action requires actionId");
    if (!action.idempotencyKey) fail(errors, "INVALID_ACTION", "mutating action requires idempotencyKey");
    if (!action.basedOnObservationId) fail(errors, "STALE_OBSERVATION", "mutating action requires basedOnObservationId");
  }
  if (action.target != null) {
    const modes = selectorModes(action.target);
    if (modes.length > 1) fail(errors, "INVALID_ACTION", `target selectors are exclusive: ${modes.join(",")}`);
    if (action.target.accessibilityRole && !action.target.accessibilityName) {
      fail(errors, "INVALID_ACTION", "accessibilityRole requires accessibilityName");
    }
    if (action.target.accessibilityName && !action.target.accessibilityRole) {
      fail(errors, "INVALID_ACTION", "accessibilityName requires accessibilityRole");
    }
  }
  return { ok: errors.length === 0, errors };
}

export function validateEffectAssessment(assessment) {
  const errors = [];
  if (!assessment || typeof assessment !== "object") {
    return { ok: false, errors: [{ code: "INVALID_ACTION", message: "assessment must be an object" }] };
  }
  const expected = EFFECT_POLICY[assessment.category];
  if (!expected) {
    fail(errors, "INVALID_ACTION", `unknown effect category: ${assessment.category}`);
    return { ok: false, errors };
  }
  if (assessment.decision !== expected) {
    fail(errors, assessment.category === "payment_context_uncertain" ? "PAYMENT_CONTEXT_UNCERTAIN" : "INVALID_ACTION",
      `${assessment.category} must decide ${expected}, got ${assessment.decision}`);
  }
  if (assessment.category !== "nonpayment" && assessment.decision === "ALLOW_WITH_TRACE") {
    const code = assessment.category === "payment_credential"
      ? "PAYMENT_CREDENTIAL_HOLD"
      : assessment.category === "payment_final_commit"
        ? "PAYMENT_FINAL_COMMIT_REQUIRED"
        : "PAYMENT_CONTEXT_UNCERTAIN";
    fail(errors, code, `${assessment.category} cannot ALLOW_WITH_TRACE`);
  }
  if (assessment.authority && assessment.authority !== "control_plane") {
    fail(errors, "INVALID_ACTION", "effect authority must be control_plane");
  }
  return { ok: errors.length === 0, errors };
}

export function validateObservation(observation) {
  const errors = [];
  if (!observation || typeof observation !== "object") {
    return { ok: false, errors: [{ code: "OBSERVATION_INCOMPLETE", message: "observation must be an object" }] };
  }
  if (!observation.observationId) fail(errors, "OBSERVATION_INCOMPLETE", "observationId required");
  if (observation.screenshotBytes != null || observation.uiTree != null) {
    fail(errors, "OBSERVATION_INCOMPLETE", "screenshot/uiTree bytes must use evidence refs");
  }
  if (observation.partial === true && !observation.partialReason) {
    fail(errors, "OBSERVATION_INCOMPLETE", "partial observation requires partialReason");
  }
  return { ok: errors.length === 0, errors };
}

export function validateDeviceSession(session) {
  const errors = [];
  if (!session || typeof session !== "object") {
    return { ok: false, errors: [{ code: "INVALID_ACTION", message: "session must be an object" }] };
  }
  if (!["capability", "open_action", "discovery"].includes(session.sessionKind)) {
    fail(errors, "SESSION_KIND_MISMATCH", `unknown sessionKind: ${session.sessionKind}`);
  }
  if (session.sessionKind === "open_action" && session.capabilityId != null) {
    fail(errors, "SESSION_KIND_MISMATCH", "open_action session must not require capabilityId");
  }
  if (session.sessionKind === "capability" && !session.capabilityId) {
    fail(errors, "SESSION_KIND_MISMATCH", "capability session requires capabilityId");
  }
  return { ok: errors.length === 0, errors };
}
