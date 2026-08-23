#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  deriveM64ActionSlotAuthority,
  deriveM64CohortManifestHash,
  deriveM64CohortScenarioKeys,
  deriveM64ScenarioActionPlan,
  M6_4_COHORT_PURPOSES,
  M6_4_COHORT_RULES,
  M6_4_SMOOTH_DISTRIBUTION,
  validateM64CohortManifest,
} from "../../packages/kernel/lib/m6-4-cohort.mjs";
import { deriveM64EffectBoundary, M6_4_EFFECT_FAMILIES, M6_4_FORBIDDEN_EFFECT_CLASSES, validateM64EffectBoundary } from "../../packages/kernel/lib/m6-effect-boundary.mjs";
import {
  deriveM6TrustedApplicationRef,
  deriveM6TrustedParameterHash,
  deriveM6TrustedTextRef,
} from "../../packages/kernel/lib/m6-action-slot.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");

function familySequence(primaryFamily, scenarioKey, zeroAction) {
  if (zeroAction) return [];
  const appRef = (role = "primary") => deriveM6TrustedApplicationRef({
    package: ["destination", "settings"].includes(role) ? "com.android.settings" : "com.xingin.xhs",
  });
  const textRef = (role = "query") => deriveM6TrustedTextRef(`m6-canary-${scenarioKey}-${role}`);
  switch (primaryFamily) {
    case "app-launch":
      return [["open_app", "none", { appRef: appRef() }, "launch"], ["back", "none", {}, "reset-back"]];
    case "app-switch":
      return [
        ["open_app", "none", { appRef: appRef("source") }, "open-source"],
        ["open_app", "none", { appRef: appRef("destination") }, "switch-destination"],
        ["back", "none", {}, "reset-back"],
      ];
    case "search":
      return [
        ["open_app", "none", { appRef: appRef() }, "open-app"],
        ["tap", "block", {}, "focus-search"],
        ["type_search_text", "block", { textRef: textRef() }, "type-query"],
        ["tap", "block", {}, "open-result"],
        ["back", "none", {}, "reset-back"],
      ];
    case "text-input":
      return [
        ["tap", "block", {}, "focus-input"],
        ["type_search_text", "block", { textRef: textRef("input") }, "type-text"],
        ["back", "none", {}, "reset-back"],
      ];
    case "scroll":
      return [
        ["scroll", "screen", { direction: "down", distanceTier: "short" }, "scroll-down"],
        ["scroll", "screen", { direction: "up", distanceTier: "short" }, "reset-scroll"],
      ];
    case "tab-back":
      return [["tap", "block", {}, "open-tab"], ["back", "none", {}, "reset-back"]];
    case "form-edit":
      return [
        ["tap", "block", {}, "focus-field"],
        ["type_search_text", "block", { textRef: textRef("form") }, "edit-field"],
        ["back", "none", {}, "reset-back"],
      ];
    case "settings-nav":
      return [
        ["open_app", "none", { appRef: appRef("settings") }, "open-settings"],
        ["tap", "block", {}, "open-safe-setting"],
        ["back", "none", {}, "reset-back"],
      ];
    default:
      throw new Error(`no frozen M6-4 action sequence for family ${primaryFamily}`);
  }
}

function actionPlan({ primaryFamily, scenarioKey, oracleHash, effectBoundaryHash, zeroAction }) {
  const resetPolicyHash = sha(`m6-4:reset-policy:${scenarioKey}:${primaryFamily}`);
  const slots = familySequence(primaryFamily, scenarioKey, zeroAction).map(([primitive, targetKind, trustedParams, role], sequenceIndex) => (
    deriveM64ActionSlotAuthority({
      schemaId: "xw.m6-action-slot-authority.v1",
      sequenceIndex,
      logicalStepId: `${scenarioKey}:step-${String(sequenceIndex + 1).padStart(2, "0")}`,
      actionSlotOrdinal: 0,
      primitive,
      actionFamily: `${primaryFamily}:${role}`,
      intentRef: sha(`m6-4:intent:${scenarioKey}:${role}`),
      intentPolicyHash: sha(`m6-4:intent-policy:${scenarioKey}:${role}`),
      targetKind,
      targetEligibilityHash: sha(`m6-4:target-eligibility:${scenarioKey}:${role}`),
      trustedParams,
      trustedParameterHash: deriveM6TrustedParameterHash(trustedParams),
      allowedStateHash: sha(`m6-4:allowed-state:${scenarioKey}:${role}`),
      effectBoundaryHash,
      budgetPolicyHash: sha(`m6-4:budget-policy:${scenarioKey}:${sequenceIndex}`),
      redlinePolicyHash: sha("m6-4:hard-redline-policy:payment-delete-social-account"),
      resetPolicyHash,
      oracleHash,
      verificationPolicyHash: sha(`m6-4:verification-policy:${scenarioKey}:${role}`),
    })
  ));
  return deriveM64ScenarioActionPlan({ slots, maxActionCount: slots.length });
}
const outIndex = process.argv.indexOf("--out");
const destination = resolve(outIndex >= 0 && process.argv[outIndex + 1] ? process.argv[outIndex + 1] : "artifacts/m6-4/cohort-manifests");
mkdirSync(destination, { recursive: true });
const effectBoundaryRaw = {
  a03Mode: "BOUNDED_READ_TRACE",
  testIdentityHash: sha("m6-4-isolated-test-account-and-device"),
  families: M6_4_EFFECT_FAMILIES.map((primaryFamily) => ({
    primaryFamily,
    oracleHash: sha(`independent-oracle:${primaryFamily}`),
    forbiddenEffectClasses: [...M6_4_FORBIDDEN_EFFECT_CLASSES],
    allowedBoundedReadTraces: primaryFamily === "search" ? ["private-search-history"]
      : ["app-launch", "app-switch", "settings-nav"].includes(primaryFamily) ? ["private-recent-app"]
        : ["scroll", "tab-back"].includes(primaryFamily) ? ["private-read-analytics"]
          : ["text-input", "form-edit"].includes(primaryFamily) ? ["private-ime-suggestion"] : [],
    resetObligations: ["search", "text-input", "form-edit"].includes(primaryFamily) ? [`reset-${primaryFamily}`] : [],
  })),
};
const effectBoundary = deriveM64EffectBoundary(effectBoundaryRaw);
const effectValidation = validateM64EffectBoundary(effectBoundary);
if (!effectValidation.ok) throw new Error(`effect boundary: ${effectValidation.errors.join(",")}`);
writeFileSync(resolve(destination, "xw.m6-effect-boundary.v1.json"), `${JSON.stringify(effectBoundary, null, 2)}\n`, "utf8");
const index = [];
for (const purpose of M6_4_COHORT_PURPOSES) {
  const rule = M6_4_COHORT_RULES[purpose];
  const scenarioKeys = deriveM64CohortScenarioKeys(purpose);
  const families = purpose === "M6_4_SMOOTH"
    ? Object.entries(M6_4_SMOOTH_DISTRIBUTION).flatMap(([family, count]) => Array(count).fill(family))
    : Array(rule.attempts).fill(purpose === "M6_4_RELIABILITY" ? "search" : purpose === "M6_4_ACTION_SMOKE" ? "tab-back" : "app-launch");
  const raw = {
    schemaId: "xw.m6-4-cohort-manifest.v1", purpose, alias: "01", gateFEligible: false, liveAuthorizationRef: null,
    qualification: "OFFLINE_TEMPLATE_NOT_LIVE_AUTHORIZATION",
    scenarios: families.map((primaryFamily, indexValue) => {
      const scenarioKey = scenarioKeys[indexValue];
      const oracleHash = effectBoundary.families.find((entry) => entry.primaryFamily === primaryFamily)?.oracleHash
        || sha(`independent-oracle:${primaryFamily}`);
      return {
        scenarioKey,
        alias: "01",
        primaryFamily,
        authorized: false,
        executionStatus: "NOT_RUN",
        oracleHash,
        effectBoundaryHash: effectBoundary.boundaryHash,
        actionPlan: actionPlan({
          primaryFamily,
          scenarioKey,
          oracleHash,
          effectBoundaryHash: effectBoundary.boundaryHash,
          zeroAction: rule.actionPolicy === "ZERO",
        }),
      };
    }),
  };
  const manifest = { ...raw, manifestHash: deriveM64CohortManifestHash(raw) };
  const validation = validateM64CohortManifest(manifest);
  if (!validation.ok) throw new Error(`${purpose}: ${validation.errors.join(",")}`);
  const path = resolve(destination, `${purpose.toLowerCase()}.json`);
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  index.push({ purpose, path, manifestHash: manifest.manifestHash, scenarioCount: manifest.scenarios.length });
}
process.stdout.write(`${JSON.stringify({ ok: true, gateFEligible: false, effectBoundaryHash: effectBoundary.boundaryHash, manifests: index }, null, 2)}\n`);
