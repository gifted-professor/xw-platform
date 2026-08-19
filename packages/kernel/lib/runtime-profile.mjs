import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_RUNTIME_PROFILE = "legacy_compat";

const PROFILE_FIELDS = Object.freeze([
  "orchestratorEnabled",
  "controlPlaneEnabled",
  "legacyCapabilitiesEnabled",
  "legacyWorkflowsEnabled",
  "openActionLiveEnabled",
  "agentGatewayLiveEnabled",
  "dshEnabled",
  "graphV2Enabled",
  "multiAgentEnabled",
  "paymentCredentialRequiresHuman",
  "paymentFinalCommitRequiresHuman",
]);

let cachedProfiles = null;

function loadProfiles() {
  if (!cachedProfiles) {
    const file = join(here, "../contracts/runtime-profile.v1.json");
    const doc = JSON.parse(readFileSync(file, "utf8"));
    if (doc.schemaId !== "xw.runtime.profile.v1") throw new Error("RUNTIME_PROFILE_SCHEMA: unexpected schemaId");
    cachedProfiles = doc.profiles || {};
  }
  return cachedProfiles;
}

export function loadRuntimeProfile(name = DEFAULT_RUNTIME_PROFILE) {
  const profiles = loadProfiles();
  const profile = profiles[name];
  if (!profile) {
    throw new Error(`UNKNOWN_RUNTIME_PROFILE: ${name}`);
  }
  for (const field of PROFILE_FIELDS) {
    if (typeof profile[field] !== "boolean") {
      throw new Error(`RUNTIME_PROFILE_INVALID: ${name}.${field} must be boolean`);
    }
  }
  const copy = {};
  for (const field of PROFILE_FIELDS) copy[field] = profile[field];
  return Object.freeze(copy);
}
