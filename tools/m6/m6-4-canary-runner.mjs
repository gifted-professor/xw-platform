#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import { validateM64CohortManifest } from "../../packages/kernel/lib/m6-4-cohort.mjs";

export function validateM64LiveWindowAuthorization(value, { manifest, modelManifest }) {
  const hashes = ["releaseHash", "sourceCommit", "gateEpochHash", "scenarioManifestHash", "modelProfileHash", "providerHash", "toolProfileHash", "operatorHash", "emergencyCloseAuthorizationHash"];
  const errors = [];
  if (value?.schemaId !== "xw.m6-4-live-window-authorization.v1" || value?.alias !== "01") errors.push("M64_LIVE_AUTH_SCHEMA_INVALID");
  if (hashes.some((key) => !/^[0-9a-f]{64}$/u.test(value?.[key] || ""))) errors.push("M64_LIVE_AUTH_HASH_INVALID");
  if (value?.scenarioManifestHash !== manifest?.manifestHash) errors.push("M64_LIVE_AUTH_MANIFEST_MISMATCH");
  if (value?.modelProfileHash !== modelManifest?.contentHash || modelManifest?.gateFEligible !== true || modelManifest?.status !== "QUALIFIED") errors.push("M64_LIVE_MODEL_UNQUALIFIED");
  if (!Number.isFinite(Date.parse(value?.issuedAt)) || !Number.isFinite(Date.parse(value?.expiresAt)) || Date.parse(value.expiresAt) <= Date.now()) errors.push("M64_LIVE_AUTH_EXPIRED");
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

async function main() {
  const manifestIndex = process.argv.indexOf("--manifest");
  const authIndex = process.argv.indexOf("--authorization");
  const manifestPath = manifestIndex >= 0 ? process.argv[manifestIndex + 1] : null;
  const authPath = authIndex >= 0 ? process.argv[authIndex + 1] : null;
  const execute = process.argv.includes("--execute");
  if (!manifestPath) throw Object.assign(new Error("--manifest is required"), { code: "M64_CANARY_MANIFEST_REQUIRED" });
  const manifest = JSON.parse(readFileSync(resolve(manifestPath), "utf8"));
  const manifestValidation = validateM64CohortManifest(manifest);
  if (!manifestValidation.ok) throw Object.assign(new Error(manifestValidation.errors.join(",")), { code: "M64_CANARY_MANIFEST_INVALID" });
  const modelManifest = JSON.parse(readFileSync(resolve("integrations/dsh-xw/profiles/live/model-manifest.json"), "utf8"));
  if (!execute) return { ok: true, mode: "PREFLIGHT_ONLY", gateFEligible: false, actionCount: 0, manifestHash: manifest.manifestHash };
  if (!authPath) throw Object.assign(new Error("exact live-window authorization is required"), { code: "M64_LIVE_AUTH_REQUIRED" });
  const auth = JSON.parse(readFileSync(resolve(authPath), "utf8"));
  const validation = validateM64LiveWindowAuthorization(auth, { manifest, modelManifest });
  if (!validation.ok) throw Object.assign(new Error(validation.errors.join(",")), { code: "M64_LIVE_AUTH_INVALID" });
  throw Object.assign(new Error("live dispatch requires the separately sealed deployed broker release"), { code: "M64_DEPLOYED_BROKER_REQUIRED" });
}

if (process.argv[1] && basename(process.argv[1]).toLowerCase() === "m6-4-canary-runner.mjs") {
  main().then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch((error) => { process.stderr.write(`${JSON.stringify({ ok: false, code: error.code, error: error.message }, null, 2)}\n`); process.exitCode = 1; });
}
