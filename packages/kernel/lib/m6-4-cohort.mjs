import { createHash } from "node:crypto";

import {
  deriveM6ActionSlotSpec,
  deriveM6TrustedParameterHash,
} from "./m6-action-slot.mjs";

export const M6_4_COHORT_RULES = Object.freeze({
  M6_4_SHADOW: Object.freeze({ attempts: 5, minimumSucceeded: 5, actionPolicy: "ZERO" }),
  M6_4_HOT_CLOSE: Object.freeze({
    attempts: 1,
    minimumSucceeded: 0,
    actionPolicy: "ZERO",
    aggregateStatus: "FAILED",
    attemptStatus: "ABORTED_PENDING_CLOSEOUT",
    closeoutStatus: "FAILURE_CLOSEOUT",
  }),
  M6_4_ACTION_SMOKE: Object.freeze({ attempts: 3, minimumSucceeded: 3, actionPolicy: "BOUNDED" }),
  M6_4_RELIABILITY: Object.freeze({ attempts: 20, minimumSucceeded: 19, actionPolicy: "BOUNDED" }),
  M6_4_SMOOTH: Object.freeze({ attempts: 30, minimumSucceeded: 27, actionPolicy: "BOUNDED" }),
});

export const M6_4_COHORT_PURPOSES = Object.freeze([
  "M6_4_SHADOW",
  "M6_4_HOT_CLOSE",
  "M6_4_ACTION_SMOKE",
  "M6_4_RELIABILITY",
  "M6_4_SMOOTH",
]);

export const M6_4_SMOOTH_DISTRIBUTION = Object.freeze({
  "app-launch": 4, "app-switch": 4, search: 4, "text-input": 4,
  scroll: 4, "tab-back": 4, "form-edit": 3, "settings-nav": 3,
});

export const M6_4_FAMILY_ACTION_SEQUENCES = Object.freeze({
  "app-launch": Object.freeze([
    Object.freeze({ primitive: "open_app", targetKind: "none", role: "launch" }),
    Object.freeze({ primitive: "back", targetKind: "none", role: "reset-back" }),
  ]),
  "app-switch": Object.freeze([
    Object.freeze({ primitive: "open_app", targetKind: "none", role: "open-source" }),
    Object.freeze({ primitive: "open_app", targetKind: "none", role: "switch-destination" }),
    Object.freeze({ primitive: "back", targetKind: "none", role: "reset-back" }),
  ]),
  search: Object.freeze([
    Object.freeze({ primitive: "open_app", targetKind: "none", role: "open-app" }),
    Object.freeze({ primitive: "tap", targetKind: "block", role: "focus-search" }),
    Object.freeze({ primitive: "type_search_text", targetKind: "block", role: "type-query" }),
    Object.freeze({ primitive: "tap", targetKind: "block", role: "open-result" }),
    Object.freeze({ primitive: "back", targetKind: "none", role: "reset-back" }),
  ]),
  "text-input": Object.freeze([
    Object.freeze({ primitive: "tap", targetKind: "block", role: "focus-input" }),
    Object.freeze({ primitive: "type_search_text", targetKind: "block", role: "type-text" }),
    Object.freeze({ primitive: "back", targetKind: "none", role: "reset-back" }),
  ]),
  scroll: Object.freeze([
    Object.freeze({ primitive: "scroll", targetKind: "screen", role: "scroll-down" }),
    Object.freeze({ primitive: "scroll", targetKind: "screen", role: "reset-scroll" }),
  ]),
  "tab-back": Object.freeze([
    Object.freeze({ primitive: "tap", targetKind: "block", role: "open-tab" }),
    Object.freeze({ primitive: "back", targetKind: "none", role: "reset-back" }),
  ]),
  "form-edit": Object.freeze([
    Object.freeze({ primitive: "tap", targetKind: "block", role: "focus-field" }),
    Object.freeze({ primitive: "type_search_text", targetKind: "block", role: "edit-field" }),
    Object.freeze({ primitive: "back", targetKind: "none", role: "reset-back" }),
  ]),
  "settings-nav": Object.freeze([
    Object.freeze({ primitive: "open_app", targetKind: "none", role: "open-settings" }),
    Object.freeze({ primitive: "tap", targetKind: "block", role: "open-safe-setting" }),
    Object.freeze({ primitive: "back", targetKind: "none", role: "reset-back" }),
  ]),
});

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const HEX64 = /^[0-9a-f]{64}$/u;
const WRITE_PRIMITIVES = new Set(["open_app", "back", "tap", "scroll", "type_search_text"]);
const TARGET_KINDS = new Set(["block", "screen", "none"]);
const SLOT_KEYS = Object.freeze([
  "schemaId", "sequenceIndex", "logicalStepId", "actionSlotOrdinal", "primitive", "actionFamily",
  "intentRef", "intentPolicyHash", "targetKind", "targetEligibilityHash", "trustedParams",
  "trustedParameterHash", "allowedStateHash", "effectBoundaryHash", "budgetPolicyHash",
  "redlinePolicyHash", "resetPolicyHash", "oracleHash", "verificationPolicyHash", "slotAuthorityHash",
]);
const SLOT_HASH_FIELDS = Object.freeze([
  "intentRef", "intentPolicyHash", "targetEligibilityHash", "trustedParameterHash", "allowedStateHash",
  "effectBoundaryHash", "budgetPolicyHash", "redlinePolicyHash", "resetPolicyHash", "oracleHash",
  "verificationPolicyHash",
]);
const ACTION_PLAN_KEYS = Object.freeze(["schemaId", "maxActionCount", "slots", "actionPlanHash"]);
const REQUEST_KEYS = Object.freeze(["primitive", "intentRef", "targetKind", "trustedParams"]);
const MANIFEST_REQUIRED_KEYS = Object.freeze([
  "schemaId", "purpose", "alias", "gateFEligible", "liveAuthorizationRef", "scenarios", "manifestHash",
]);
const MANIFEST_OPTIONAL_KEYS = Object.freeze(["qualification"]);
const SCENARIO_KEYS = Object.freeze([
  "scenarioKey", "alias", "primaryFamily", "authorized", "executionStatus", "oracleHash",
  "effectBoundaryHash", "actionPlan",
]);

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && canonical(Object.keys(value).sort()) === canonical([...keys].sort());
}

function closedKeys(value, requiredKeys, optionalKeys = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  return requiredKeys.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function sha(prefix, value) {
  return createHash("sha256").update(`${prefix}:${canonical(value)}`).digest("hex");
}

function validTrustedParams(primitive, params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) return false;
  const keys = Object.keys(params).sort();
  if (primitive === "open_app") return canonical(keys) === canonical(["appRef"]) && HEX64.test(params.appRef || "");
  if (primitive === "type_search_text") return canonical(keys) === canonical(["textRef"]) && HEX64.test(params.textRef || "");
  if (primitive === "scroll") return canonical(keys) === canonical(["direction", "distanceTier"])
    && ["up", "down"].includes(params.direction) && ["short", "medium"].includes(params.distanceTier);
  return ["tap", "back"].includes(primitive) && keys.length === 0;
}

export function deriveM64ActionSlotAuthority(input) {
  const raw = Object.fromEntries(SLOT_KEYS.filter((key) => key !== "slotAuthorityHash").map((key) => [key, input?.[key]]));
  if (raw.schemaId !== "xw.m6-action-slot-authority.v1"
    || !Number.isInteger(raw.sequenceIndex) || raw.sequenceIndex < 0 || raw.sequenceIndex > 255
    || !Number.isInteger(raw.actionSlotOrdinal) || raw.actionSlotOrdinal < 0 || raw.actionSlotOrdinal > 255
    || typeof raw.logicalStepId !== "string" || raw.logicalStepId.length < 1 || raw.logicalStepId.length > 128
    || typeof raw.actionFamily !== "string" || raw.actionFamily.length < 1 || raw.actionFamily.length > 64
    || !WRITE_PRIMITIVES.has(raw.primitive) || !TARGET_KINDS.has(raw.targetKind)
    || SLOT_HASH_FIELDS.some((field) => !HEX64.test(raw[field] || ""))
    || !validTrustedParams(raw.primitive, raw.trustedParams)
    || raw.trustedParameterHash !== deriveM6TrustedParameterHash(raw.trustedParams)) {
    throw Object.assign(new Error("M6-4 action-slot authority is invalid"), { code: "M64_ACTION_SLOT_AUTHORITY_INVALID" });
  }
  const targetMatches = (["tap", "type_search_text"].includes(raw.primitive) && raw.targetKind === "block")
    || (raw.primitive === "scroll" && raw.targetKind === "screen")
    || (["open_app", "back"].includes(raw.primitive) && raw.targetKind === "none");
  if (!targetMatches) throw Object.assign(new Error("M6-4 action-slot target is invalid"), { code: "M64_ACTION_SLOT_AUTHORITY_INVALID" });
  return Object.freeze({ ...raw, slotAuthorityHash: sha("xw.m6-action-slot-authority.v1", raw) });
}

export function deriveM64ScenarioActionPlan({ slots, maxActionCount = slots?.length } = {}) {
  if (!Array.isArray(slots) || !Number.isInteger(maxActionCount) || maxActionCount !== slots.length || maxActionCount > 255) {
    throw Object.assign(new Error("M6-4 scenario action plan cardinality is invalid"), { code: "M64_ACTION_PLAN_INVALID" });
  }
  const canonicalSlots = slots.map((slot, sequenceIndex) => {
    const derived = deriveM64ActionSlotAuthority(slot);
    if (slot?.slotAuthorityHash !== undefined && slot.slotAuthorityHash !== derived.slotAuthorityHash) {
      throw Object.assign(new Error("M6-4 slot authority hash is invalid"), { code: "M64_ACTION_PLAN_INVALID" });
    }
    if (derived.sequenceIndex !== sequenceIndex) {
      throw Object.assign(new Error("M6-4 slots are not in their frozen order"), { code: "M64_ACTION_PLAN_INVALID" });
    }
    return derived;
  });
  const pairs = canonicalSlots.map((slot) => `${slot.logicalStepId}\u0000${slot.actionSlotOrdinal}`);
  if (new Set(pairs).size !== pairs.length) {
    throw Object.assign(new Error("M6-4 logical action slot is reused"), { code: "M64_ACTION_PLAN_INVALID" });
  }
  const raw = { schemaId: "xw.m6-scenario-action-plan.v1", maxActionCount, slots: canonicalSlots };
  return Object.freeze({ ...raw, actionPlanHash: sha("xw.m6-scenario-action-plan.v1", raw) });
}

export function materializeM64ActionSlotSpec({ manifest, scenario, slotAuthority }) {
  return deriveM6ActionSlotSpec({
    ...slotAuthority,
    scenarioManifestHash: manifest.manifestHash,
    scenarioId: scenario.scenarioKey,
    alias: scenario.alias,
  });
}

export function resolveM64CohortActionSlot({
  manifest,
  scenarioId,
  logicalStepId,
  actionSlotOrdinal,
  request,
} = {}) {
  const validation = validateM64CohortManifest(manifest);
  if (!validation.ok) {
    throw Object.assign(new Error(`frozen cohort manifest is invalid: ${validation.errors.join(",")}`), { code: "M64_ACTION_SLOT_MANIFEST_INVALID" });
  }
  const scenario = manifest.scenarios.find((candidate) => candidate.scenarioKey === scenarioId);
  const slotAuthority = scenario?.actionPlan?.slots?.find((candidate) => (
    candidate.logicalStepId === logicalStepId && candidate.actionSlotOrdinal === actionSlotOrdinal
  ));
  if (!slotAuthority || !request || typeof request !== "object" || Array.isArray(request)) {
    throw Object.assign(new Error("requested action slot was not enumerated"), { code: "M64_ACTION_SLOT_UNENUMERATED" });
  }
  if (!exactKeys(request, REQUEST_KEYS)) {
    throw Object.assign(new Error("requested action slot binding is not closed"), { code: "M64_ACTION_SLOT_REQUEST_MISMATCH" });
  }
  const requestBinding = {
    primitive: request.primitive,
    intentRef: request.intentRef,
    targetKind: request.targetKind,
    trustedParams: request.trustedParams,
  };
  const frozenBinding = {
    primitive: slotAuthority.primitive,
    intentRef: slotAuthority.intentRef,
    targetKind: slotAuthority.targetKind,
    trustedParams: slotAuthority.trustedParams,
  };
  if (canonical(requestBinding) !== canonical(frozenBinding)) {
    throw Object.assign(new Error("requested primitive/ref/target/params drift from frozen authority"), { code: "M64_ACTION_SLOT_REQUEST_MISMATCH" });
  }
  const actionSlotSpec = materializeM64ActionSlotSpec({ manifest, scenario, slotAuthority });
  return Object.freeze({
    scenario,
    sequenceIndex: slotAuthority.sequenceIndex,
    maxActionCount: scenario.actionPlan.maxActionCount,
    slotAuthority,
    actionSlotSpec,
    manifestStep: Object.freeze({ ...slotAuthority }),
  });
}

export function deriveM64CohortScenarioKeys(purpose) {
  const rule = M6_4_COHORT_RULES[purpose];
  if (!rule) return [];
  return Array.from(
    { length: rule.attempts },
    (_, index) => `${purpose.toLowerCase()}-${String(index + 1).padStart(2, "0")}`,
  );
}

export function deriveM64CohortAggregateHash(aggregate) {
  const { aggregateHash: _ignored, ...payload } = aggregate || {};
  return createHash("sha256").update(`xw.m6-4-cohort-aggregate.v1:${canonical(payload)}`).digest("hex");
}

export function deriveM64CohortManifestHash(manifest) {
  const { manifestHash: _ignored, ...payload } = manifest || {};
  return createHash("sha256").update(`xw.m6-4-cohort-manifest.v1:${canonical(payload)}`).digest("hex");
}

export function validateM64CohortManifest(manifest) {
  const errors = [];
  const rule = M6_4_COHORT_RULES[manifest?.purpose];
  if (!closedKeys(manifest, MANIFEST_REQUIRED_KEYS, MANIFEST_OPTIONAL_KEYS)
    || (Object.hasOwn(manifest || {}, "qualification")
      && (typeof manifest.qualification !== "string" || manifest.qualification.length < 1))) {
    errors.push("M64_MANIFEST_SCHEMA_INVALID");
  }
  if (manifest?.schemaId !== "xw.m6-4-cohort-manifest.v1") errors.push("M64_MANIFEST_SCHEMA_INVALID");
  if (!rule) errors.push("M64_COHORT_PURPOSE_INVALID");
  if (manifest?.alias !== "01") errors.push("M64_COHORT_ALIAS_INVALID");
  if (!Array.isArray(manifest?.scenarios) || (rule && manifest.scenarios.length !== rule.attempts)) errors.push("M64_COHORT_CARDINALITY_INVALID");
  if (Array.isArray(manifest?.scenarios)) {
    const keys = manifest.scenarios.map((scenario) => scenario?.scenarioKey);
    const frozenKeys = deriveM64CohortScenarioKeys(manifest?.purpose);
    if ((rule && keys.some((key, index) => key !== frozenKeys[index]))
      || new Set(keys).size !== keys.length || manifest.scenarios.some((scenario) => !exactKeys(scenario, SCENARIO_KEYS)
      || scenario?.alias !== "01" || scenario?.authorized !== false
      || scenario?.executionStatus !== "NOT_RUN" || !HEX64.test(scenario?.oracleHash || "")
      || !HEX64.test(scenario?.effectBoundaryHash || ""))) errors.push("M64_COHORT_SCENARIO_INVALID");
    for (const scenario of manifest.scenarios) {
      try {
        if (!exactKeys(scenario?.actionPlan, ACTION_PLAN_KEYS)) throw new Error("closed action plan required");
        const plan = deriveM64ScenarioActionPlan(scenario.actionPlan);
        if (plan.actionPlanHash !== scenario.actionPlan.actionPlanHash
          || plan.slots.some((slot) => slot.effectBoundaryHash !== scenario.effectBoundaryHash || slot.oracleHash !== scenario.oracleHash)) {
          throw new Error("action plan binding mismatch");
        }
        if (rule?.actionPolicy === "ZERO" && plan.maxActionCount !== 0) throw new Error("zero-action purpose has slots");
        if (rule?.actionPolicy === "BOUNDED" && plan.maxActionCount < 1) throw new Error("bounded purpose has no slots");
        const expectedSequence = rule?.actionPolicy === "ZERO" ? [] : M6_4_FAMILY_ACTION_SEQUENCES[scenario.primaryFamily];
        if (!expectedSequence || canonical(plan.slots.map((slot) => ({
          primitive: slot.primitive,
          targetKind: slot.targetKind,
          role: slot.actionFamily,
        }))) !== canonical(expectedSequence.map((item) => ({
          primitive: item.primitive,
          targetKind: item.targetKind,
          role: `${scenario.primaryFamily}:${item.role}`,
        })))) throw new Error("family action sequence drifted");
        if (scenario.primaryFamily === "scroll" && (
          canonical(plan.slots.map((slot) => slot.trustedParams)) !== canonical([
            { direction: "down", distanceTier: "short" },
            { direction: "up", distanceTier: "short" },
          ])
        )) throw new Error("scroll reset sequence drifted");
        if (scenario.primaryFamily === "app-switch"
          && plan.slots[0]?.trustedParams?.appRef === plan.slots[1]?.trustedParams?.appRef) {
          throw new Error("app switch refs are not distinct");
        }
        for (const slot of plan.slots) {
          if (!exactKeys(slot, SLOT_KEYS)) throw new Error("slot authority is not closed");
          materializeM64ActionSlotSpec({ manifest, scenario, slotAuthority: slot });
        }
      } catch {
        errors.push("M64_COHORT_ACTION_PLAN_INVALID");
      }
    }
    if (manifest?.purpose === "M6_4_SMOOTH") {
      const counts = Object.fromEntries(Object.keys(M6_4_SMOOTH_DISTRIBUTION).map((family) => [family, 0]));
      for (const scenario of manifest.scenarios) if (Object.hasOwn(counts, scenario.primaryFamily)) counts[scenario.primaryFamily] += 1;
      if (canonical(counts) !== canonical(M6_4_SMOOTH_DISTRIBUTION)) errors.push("M64_SMOOTH_DISTRIBUTION_INVALID");
    }
  }
  if (manifest?.liveAuthorizationRef !== null || manifest?.gateFEligible !== false) errors.push("M64_MANIFEST_MUST_BE_OFFLINE");
  if (deriveM64CohortManifestHash(manifest) !== manifest?.manifestHash) errors.push("M64_MANIFEST_HASH_INVALID");
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

export function validateM64CohortAggregate(aggregate) {
  const errors = [];
  const rule = M6_4_COHORT_RULES[aggregate?.purpose];
  if (aggregate?.schemaId !== "xw.m6-4-cohort-aggregate.v1") errors.push("M64_COHORT_SCHEMA_INVALID");
  if (!rule) errors.push("M64_COHORT_PURPOSE_INVALID");
  if (aggregate?.alias !== "01") errors.push("M64_COHORT_ALIAS_INVALID");
  if (!Array.isArray(aggregate?.expectedScenarioKeys) || !Array.isArray(aggregate?.attempts)) {
    errors.push("M64_COHORT_ATTEMPTS_INVALID");
  } else if (rule) {
    const frozenKeys = deriveM64CohortScenarioKeys(aggregate.purpose);
    if (aggregate.expectedScenarioKeys.length !== rule.attempts || aggregate.attempts.length !== rule.attempts) {
      errors.push("M64_COHORT_CARDINALITY_INVALID");
    }
    const expected = aggregate.expectedScenarioKeys;
    const actual = aggregate.attempts.map((attempt) => attempt?.scenarioKey);
    if (expected.some((key, index) => key !== frozenKeys[index])
      || actual.some((key, index) => key !== frozenKeys[index])) {
      errors.push("M64_COHORT_SCENARIO_SUBSTITUTION");
    }
    const successCount = aggregate.attempts.filter((attempt) => attempt?.status === "SUCCEEDED").length;
    if (successCount < rule.minimumSucceeded) errors.push("M64_COHORT_SUCCESS_THRESHOLD");
    if (aggregate.attempts.some((attempt) => attempt?.alias !== "01" || attempt?.forbiddenEffectCount !== 0
      || attempt?.publicEffectCount !== 0 || attempt?.paymentAttemptCount !== 0 || attempt?.deleteAttemptCount !== 0)) {
      errors.push("M64_COHORT_FORBIDDEN_EFFECT");
    }
    if (rule.actionPolicy === "ZERO" && aggregate.attempts.some((attempt) => attempt?.actionCount !== 0 || attempt?.transportCount !== 0)) {
      errors.push("M64_COHORT_ZERO_ACTION_VIOLATION");
    }
    if (aggregate.purpose === "M6_4_HOT_CLOSE") {
      const [attempt] = aggregate.attempts;
      const closeout = aggregate.failureCloseout;
      const windowHashes = [aggregate.manifestHash, aggregate.gateEpochHash, aggregate.liveAuthorizationHash];
      if (aggregate.status !== rule.aggregateStatus || attempt?.status !== rule.attemptStatus) {
        errors.push("M64_COHORT_HOT_CLOSE_LIFECYCLE_INVALID");
      }
      if (windowHashes.some((value) => !HEX64.test(value || ""))) {
        errors.push("M64_COHORT_HOT_CLOSE_BINDING_INVALID");
      }
      if (!closeout || typeof closeout !== "object"
        || closeout.status !== rule.closeoutStatus
        || closeout.priorStatus !== rule.attemptStatus
        || closeout.scenarioKey !== frozenKeys[0]
        || closeout.scenarioKey !== attempt?.scenarioKey
        || closeout.purpose !== aggregate.purpose
        || !HEX64.test(closeout.evidenceHash || "")) {
        errors.push("M64_COHORT_HOT_CLOSE_CLOSEOUT_INVALID");
      }
      if (closeout && typeof closeout === "object"
        && (closeout.manifestHash !== aggregate.manifestHash
          || closeout.gateEpochHash !== aggregate.gateEpochHash
          || closeout.liveAuthorizationHash !== aggregate.liveAuthorizationHash)) {
        errors.push("M64_COHORT_HOT_CLOSE_BINDING_MISMATCH");
      }
    }
  }
  if (deriveM64CohortAggregateHash(aggregate) !== aggregate?.aggregateHash) errors.push("M64_COHORT_HASH_INVALID");
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}
