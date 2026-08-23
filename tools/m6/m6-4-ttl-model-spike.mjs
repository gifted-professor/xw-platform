#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA_ID = "xw.m6-ttl-model-spike.v1";
const LIVE_PROFILE = resolve("integrations/dsh-xw/profiles/live/package.json");
const INVENTORY = resolve("services/orchestrator/contracts/m6/dsh-inventory.v1.json");
const SLO = resolve("services/orchestrator/contracts/m6/smoothness-slo.v1.json");

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

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

async function main() {
  const outIndex = process.argv.indexOf("--out");
  const out = resolve(outIndex >= 0 && process.argv[outIndex + 1]
    ? process.argv[outIndex + 1]
    : "artifacts/m6-4/m6-4-ttl-model-spike.json");
  const inventory = readJson(INVENTORY);
  const slo = readJson(SLO);
  const inventoryText = JSON.stringify(inventory);
  const hasLiveInventory = /(?:profiles[\\/]live|executionMode["']?\s*:\s*["']live)/i.test(inventoryText);
  const liveProfilePresent = existsSync(LIVE_PROFILE);
  const replayOnly = !hasLiveInventory && /profiles[\\/]replay/i.test(inventoryText);
  const frozenThresholds = {
    frameTtlMs: 5_000,
    minRemainingTtlMs: 1_000,
    bridgeP95MaxMs: 100,
    groundingDecisionP95MaxMs: 1_000,
    groundResultToActIngressP95MaxMs: 2_500,
    capturedToFinalPrecheckP95MaxMs: 4_000,
    minimumValidLoops: 99,
    requiredWarmLoops: 100,
  };
  const profileResolved = liveProfilePresent && hasLiveInventory;
  const qualification = profileResolved
    ? "PROFILE_PRESENT_REQUIRES_EXPLICIT_NO_EFFECT_MODEL_RUN"
    : "LIVE_PROFILE_UNRESOLVED_OFFLINE_IMPLEMENTATION_ONLY";
  const core = {
    schemaId: SCHEMA_ID,
    qualification,
    candidateLiveProfile: {
      path: "integrations/dsh-xw/profiles/live/package.json",
      present: liveProfilePresent,
      presentInRuntimeInventory: hasLiveInventory,
      locked: false,
      modelIdentityResolved: false,
      providerIdentityResolved: false,
      licenseProvenanceResolved: false,
      secretInjectionResolved: false,
      healthResolved: false,
    },
    currentInventory: {
      sha256: sha256(readFileSync(INVENTORY)),
      replayOnly,
    },
    frozenSloContractSha256: sha256(readFileSync(SLO)),
    frozenThresholds,
    warmCompleteToolLoopsAttempted: 0,
    warmCompleteToolLoopsQualified: 0,
    externalModelInvoked: false,
    deviceEffect: false,
    deviceTransportCalls: 0,
    thresholdsRelaxed: false,
    liveHardGatePassed: false,
    offlineImplementationAllowed: !profileResolved,
    gateFEligible: false,
    requiredNextEvidence: [
      "target-runtime live model/provider inventory",
      "content-addressed live profile and license/provenance record",
      "approved secret-injection path without secret disclosure",
      "100 warm no-device-effect complete tool loops satisfying every frozen SLO",
    ],
    sourceSha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
  };
  const artifact = { ...core, artifactSha256: sha256(`${SCHEMA_ID}:${canonical(core)}`) };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({
    ok: true,
    hardGatePassed: false,
    qualification,
    offlineImplementationAllowed: artifact.offlineImplementationAllowed,
    gateFEligible: false,
    out,
    artifactSha256: artifact.artifactSha256,
  }, null, 2)}\n`);
  return 0;
}

main().then((code) => { process.exitCode = code; }).catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error.message, code: error.code, stack: error.stack }, null, 2)}\n`);
  process.exitCode = 2;
});
