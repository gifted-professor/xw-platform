#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { deriveM64CohortManifestHash, M6_4_COHORT_RULES, M6_4_SMOOTH_DISTRIBUTION, validateM64CohortManifest } from "../../packages/kernel/lib/m6-4-cohort.mjs";
import { deriveM64EffectBoundary, M6_4_EFFECT_FAMILIES, M6_4_FORBIDDEN_EFFECT_CLASSES, validateM64EffectBoundary } from "../../packages/kernel/lib/m6-effect-boundary.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
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
for (const [purpose, rule] of Object.entries(M6_4_COHORT_RULES)) {
  const families = purpose === "M6_4_SMOOTH"
    ? Object.entries(M6_4_SMOOTH_DISTRIBUTION).flatMap(([family, count]) => Array(count).fill(family))
    : Array(rule.attempts).fill(purpose === "M6_4_RELIABILITY" ? "search" : purpose === "M6_4_ACTION_SMOKE" ? "tab-back" : "app-launch");
  const raw = {
    schemaId: "xw.m6-4-cohort-manifest.v1", purpose, alias: "01", gateFEligible: false, liveAuthorizationRef: null,
    qualification: "OFFLINE_TEMPLATE_NOT_LIVE_AUTHORIZATION",
    scenarios: families.map((primaryFamily, indexValue) => ({
      scenarioKey: `${purpose.toLowerCase()}-${String(indexValue + 1).padStart(2, "0")}`, alias: "01", primaryFamily,
      authorized: false, executionStatus: "NOT_RUN", oracleHash: effectBoundary.families.find((entry) => entry.primaryFamily === primaryFamily)?.oracleHash || sha(`independent-oracle:${primaryFamily}`), effectBoundaryHash: effectBoundary.boundaryHash,
    })),
  };
  const manifest = { ...raw, manifestHash: deriveM64CohortManifestHash(raw) };
  const validation = validateM64CohortManifest(manifest);
  if (!validation.ok) throw new Error(`${purpose}: ${validation.errors.join(",")}`);
  const path = resolve(destination, `${purpose.toLowerCase()}.json`);
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  index.push({ purpose, path, manifestHash: manifest.manifestHash, scenarioCount: manifest.scenarios.length });
}
process.stdout.write(`${JSON.stringify({ ok: true, gateFEligible: false, effectBoundaryHash: effectBoundary.boundaryHash, manifests: index }, null, 2)}\n`);
