import { m6LiveSha256 } from "./m6-live-grounding.mjs";

const HASH = /^[0-9a-f]{64}$/u;
const PRIMITIVES = new Set(["observe", "open_app", "back", "wait", "tap", "scroll", "type_search_text"]);
const TARGET_KINDS = new Set(["block", "screen", "none"]);
const HASH_FIELDS = [
  "scenarioManifestHash", "intentRef", "intentPolicyHash", "targetEligibilityHash",
  "trustedParameterHash", "allowedStateHash", "effectBoundaryHash", "budgetPolicyHash",
  "redlinePolicyHash", "verificationPolicyHash",
];

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function fail(message) {
  throw Object.assign(new Error(message), { code: "M6_ACTION_SLOT_INVALID" });
}

export function deriveM6ActionSlotSpec(input) {
  const raw = {
    schemaId: "xw.m6-action-slot-spec.v1",
    scenarioManifestHash: input?.scenarioManifestHash,
    scenarioId: input?.scenarioId,
    logicalStepId: input?.logicalStepId,
    actionSlotOrdinal: input?.actionSlotOrdinal,
    alias: input?.alias,
    primitive: input?.primitive,
    actionFamily: input?.actionFamily,
    intentRef: input?.intentRef,
    intentPolicyHash: input?.intentPolicyHash,
    targetKind: input?.targetKind,
    targetEligibilityHash: input?.targetEligibilityHash,
    trustedParameterHash: input?.trustedParameterHash,
    allowedStateHash: input?.allowedStateHash,
    effectBoundaryHash: input?.effectBoundaryHash,
    budgetPolicyHash: input?.budgetPolicyHash,
    redlinePolicyHash: input?.redlinePolicyHash,
    verificationPolicyHash: input?.verificationPolicyHash,
  };
  if (raw.alias !== "01" || !PRIMITIVES.has(raw.primitive) || !TARGET_KINDS.has(raw.targetKind)) fail("action slot authority is outside M6-4 scope");
  if (!Number.isInteger(raw.actionSlotOrdinal) || raw.actionSlotOrdinal < 0 || raw.actionSlotOrdinal > 255) fail("action slot ordinal is invalid");
  if (![raw.scenarioId, raw.logicalStepId, raw.actionFamily].every((value) => typeof value === "string" && value.length > 0 && value.length <= 128)) fail("action slot identity is invalid");
  if (HASH_FIELDS.some((field) => !HASH.test(raw[field] || ""))) fail("action slot hash binding is invalid");
  return Object.freeze({ ...raw, actionSlotSpecHash: m6LiveSha256(`xw.m6-action-slot-spec.v1:${canonical(raw)}`) });
}

export function deriveM6LogicalActionIdentity({ planHash, actionSlotSpec }) {
  if (!HASH.test(planHash || "") || actionSlotSpec?.actionSlotSpecHash !== deriveM6ActionSlotSpec(actionSlotSpec).actionSlotSpecHash) fail("action slot spec is not self-consistent");
  const authority = `${planHash}:${actionSlotSpec.scenarioManifestHash}:${actionSlotSpec.scenarioId}:${actionSlotSpec.logicalStepId}:${actionSlotSpec.actionSlotOrdinal}:${actionSlotSpec.alias}:${actionSlotSpec.actionFamily}:${actionSlotSpec.actionSlotSpecHash}`;
  return Object.freeze({
    logicalActionId: m6LiveSha256(`xw.m6-logical-action.v1:${authority}`),
    operationKey: m6LiveSha256(`xw.m6-operation-key.v1:${authority}`),
  });
}

export function deriveM6TrustedParameterHash(trustedParams) {
  if (!trustedParams || typeof trustedParams !== "object" || Array.isArray(trustedParams)) fail("trusted parameters must be a closed object");
  return m6LiveSha256(`xw.m6-trusted-parameters.v1:${canonical(trustedParams)}`);
}

export function assertM6ActionSlotDispatch({ actionSlotSpec, intent, manifestStep }) {
  const canonicalSpec = deriveM6ActionSlotSpec(actionSlotSpec);
  if (canonicalSpec.actionSlotSpecHash !== actionSlotSpec.actionSlotSpecHash
    || canonicalSpec.primitive !== manifestStep?.primitive
    || canonicalSpec.targetKind !== intent?.targetKind
    || canonicalSpec.intentRef !== intent?.intentRef
    || canonicalSpec.trustedParameterHash !== manifestStep?.trustedParameterHash
    || canonicalSpec.trustedParameterHash !== deriveM6TrustedParameterHash(manifestStep?.trustedParams)) {
    fail("dispatch authority drifted from the frozen action slot");
  }
  return canonicalSpec;
}
