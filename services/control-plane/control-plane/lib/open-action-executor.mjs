import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  FORBIDDEN_PUBLIC_PRIMITIVES,
  MUTATING_PRIMITIVES,
  isPublicPrimitive,
  validatePrimitiveAction,
} from "../../../../packages/kernel/lib/open-action.mjs";
import { ControlPlaneError } from "./errors.mjs";
import { validateJsonSchema } from "./json-schema-validator.mjs";
import { classifyPaymentFirewall } from "./payment-firewall.mjs";

export const ACTION_REQUEST_SCHEMA_ID = "xw.open-action.action-request.v1";
export const ACTION_RESULT_SCHEMA_ID = "xw.open-action.result.v1";
export const M3D_SUPPORTED_PRIMITIVES = Object.freeze(["tap"]);

const here = dirname(fileURLToPath(import.meta.url));
const kernelContracts = join(here, "../../../../packages/kernel/contracts/open-action");
const ACTION_REQUEST_SCHEMA = JSON.parse(readFileSync(join(kernelContracts, "action-request.v1.schema.json"), "utf8"));
const PRIMITIVE_ACTION_SCHEMA = JSON.parse(readFileSync(join(kernelContracts, "primitive-action.v1.schema.json"), "utf8"));
const ACTION_RESULT_SCHEMA = JSON.parse(readFileSync(join(kernelContracts, "action-result.v1.schema.json"), "utf8"));

function throwSchemaError(code, message, errors, status = 400) {
  throw new ControlPlaneError(code, message, {
    status,
    details: { errors },
  });
}

function throwSemanticError(first, errors) {
  const status = first.code === "STALE_OBSERVATION"
    ? 409
    : first.code === "INVALID_ACTION"
      ? 400
      : 405;
  throw new ControlPlaneError(first.code, first.message, {
    status,
    details: { errors },
  });
}

export function requireActionRequest(input) {
  const requestErrors = validateJsonSchema(input, ACTION_REQUEST_SCHEMA);
  if (requestErrors.length) {
    throwSchemaError("INVALID_ACTION", "request does not satisfy ActionRequestV1", requestErrors);
  }
  const action = input.action;
  const kind = action?.kind;
  if (kind === "observe") {
    throw new ControlPlaneError(
      "PRIMITIVE_NOT_SUPPORTED",
      "observe must use POST /control/v1/device-sessions/:id/observe",
      { status: 405, details: { kind } },
    );
  }
  if (FORBIDDEN_PUBLIC_PRIMITIVES.includes(kind) || !isPublicPrimitive(kind) || !M3D_SUPPORTED_PRIMITIVES.includes(kind)) {
    throw new ControlPlaneError(
      "PRIMITIVE_NOT_SUPPORTED",
      kind && isPublicPrimitive(kind)
        ? `M3-D fixture executor only supports tap; ${kind} is not open yet`
        : `${kind || "unknown"} is not a public primitive`,
      { status: 405, details: { kind: kind || null } },
    );
  }
  const primitiveErrors = validateJsonSchema(action, PRIMITIVE_ACTION_SCHEMA);
  if (primitiveErrors.length) {
    throwSchemaError("INVALID_ACTION", "action does not satisfy PrimitiveActionV1", primitiveErrors);
  }
  const check = validatePrimitiveAction(action);
  if (!check.ok) {
    const first = check.errors[0] || { code: "INVALID_ACTION", message: "invalid primitive" };
    throwSemanticError(first, check.errors);
  }
  if (action.target == null) {
    throw new ControlPlaneError("INVALID_ACTION", "tap requires target", { status: 400 });
  }
  return {
    action,
    agentClaimedCategory: input.agentClaimedCategory ?? null,
  };
}

export function requirePrimitiveAction(input) {
  return requireActionRequest(input).action;
}

export function requireActionResult(result) {
  const errors = validateJsonSchema(result, ACTION_RESULT_SCHEMA);
  if (errors.length) {
    throwSchemaError("INVALID_ACTION", "result does not satisfy ActionResultV1", errors, 500);
  }
  return result;
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
  const reobserve = category === "payment_context_uncertain";
  return {
    schemaId: ACTION_RESULT_SCHEMA_ID,
    schemaVersion: 1,
    actionId: action.actionId,
    ok: false,
    retryable: reobserve,
    nextAction: reobserve ? "REOBSERVE" : "HUMAN",
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
    actionId: action.actionId,
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
