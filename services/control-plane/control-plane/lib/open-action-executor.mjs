import { MUTATING_PRIMITIVES, validatePrimitiveAction } from "../../../../packages/kernel/lib/open-action.mjs";
import { ControlPlaneError } from "./errors.mjs";
import { classifyPaymentFirewall } from "./payment-firewall.mjs";

export const ACTION_RESULT_SCHEMA_ID = "xw.open-action.result.v1";

export function requirePrimitiveAction(action) {
  const check = validatePrimitiveAction(action);
  if (!check.ok) {
    const first = check.errors[0] || { code: "PRIMITIVE_NOT_SUPPORTED", message: "invalid primitive" };
    const status = first.code === "STALE_OBSERVATION" ? 409 : 405;
    throw new ControlPlaneError(first.code, first.message, {
      status,
      details: { errors: check.errors },
    });
  }
  if (!action.kind || action.kind === "observe") {
    throw new ControlPlaneError(
      "PRIMITIVE_NOT_SUPPORTED",
      "observe must use POST /control/v1/device-sessions/:id/observe",
      { status: 405, details: { kind: action.kind || null } },
    );
  }
  return action;
}

export function isMutatingPrimitive(kind) {
  return MUTATING_PRIMITIVES.includes(kind);
}

export function paymentHoldResult({ action, observation, assessment }) {
  const category = assessment.category;
  const errorCode = category === "payment_credential"
    ? "PAYMENT_CREDENTIAL_HOLD"
    : category === "payment_final_commit"
      ? "PAYMENT_FINAL_COMMIT_REQUIRED"
      : "PAYMENT_CONTEXT_UNCERTAIN";
  const nextAction = category === "payment_context_uncertain" ? "REOBSERVE" : "HUMAN";
  return {
    schemaId: ACTION_RESULT_SCHEMA_ID,
    schemaVersion: 1,
    actionId: action.actionId || null,
    ok: false,
    retryable: false,
    nextAction,
    errorCode,
    beforeObservationId: observation?.observationId ?? action.basedOnObservationId ?? null,
    afterObservationId: null,
    effect: assessment,
    evidenceRefs: [],
  };
}

export function fixtureExecuteResult({ action, observation, afterObservation, assessment }) {
  return {
    schemaId: ACTION_RESULT_SCHEMA_ID,
    schemaVersion: 1,
    actionId: action.actionId || null,
    ok: true,
    retryable: false,
    nextAction: afterObservation ? "NONE" : "REOBSERVE",
    errorCode: null,
    beforeObservationId: observation?.observationId ?? null,
    afterObservationId: afterObservation?.observationId ?? null,
    effect: assessment,
    evidenceRefs: afterObservation?.evidenceRefs || [],
  };
}

export function assessObservation(observation, { agentClaimedCategory = null } = {}) {
  return classifyPaymentFirewall(observation, { agentClaimedCategory });
}

export function assertAllowWithTrace(assessment) {
  if (assessment.decision === "ALLOW_WITH_TRACE") return assessment;
  return null;
}

export function actionFingerprint(action) {
  return {
    kind: action.kind,
    actionId: action.actionId ?? null,
    basedOnObservationId: action.basedOnObservationId ?? null,
    target: action.target ?? null,
    text: action.text ?? null,
    key: action.key ?? null,
    packageName: action.packageName ?? null,
    durationMs: action.durationMs ?? null,
  };
}
