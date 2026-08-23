import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { apply } from "../src/live-runtime-plugin.mjs";
import { deriveLiveModelProfileHash, validateQualifiedLiveModelProfile } from "../src/live-model-profile.mjs";
import { createM6LivePipeBinding, LivePipeToolClient, validateM6LivePipeBinding } from "../src/live-pipe-client.mjs";
import { M6_LIVE_TOOL_NAMES } from "../../../services/orchestrator/scripts/lib/m6/m6-live-tool-surface.mjs";

test("live profile is separate, secret-free, exact-ten, and unqualified runtime fails closed", async () => {
  const replay = readFileSync(new URL("../profiles/replay/cordis.patch.yml", import.meta.url), "utf8");
  const live = readFileSync(new URL("../profiles/live/cordis.patch.yml", import.meta.url), "utf8");
  const manifest = JSON.parse(readFileSync(new URL("../profiles/live/model-manifest.json", import.meta.url), "utf8"));
  assert.notEqual(live, replay);
  assert.equal(new Set(M6_LIVE_TOOL_NAMES).size, 10);
  assert.equal(manifest.secretMaterialPresent, false);
  assert.equal(manifest.gateFEligible, false);
  assert.throws(() => new LivePipeToolClient({ fd: 2, binding: {} }), { code: "M6_LIVE_PIPE_REQUIRED" });
  const binding = createM6LivePipeBinding({
    runId: "run:opaque", workerId: "worker:opaque", sessionId: "session:opaque", alias: "01", processRef: "process:opaque",
    gateEpochHash: "a".repeat(64), generation: 1, purpose: "M6_4_ACTION_SMOKE",
    scenarioManifestHash: "b".repeat(64), liveWindowAuthorizationHash: "c".repeat(64),
  });
  assert.deepEqual(validateM6LivePipeBinding(binding), binding);
  const { bindingHash: _bindingHash, ...bindingCore } = binding;
  for (const purpose of ["M6_4_SHADOW", "M6_4_HOT_CLOSE", "M6_4_ACTION_SMOKE", "M6_4_RELIABILITY", "M6_4_SMOOTH"]) {
    assert.equal(createM6LivePipeBinding({ ...bindingCore, purpose }).purpose, purpose);
  }
  assert.throws(() => validateM6LivePipeBinding({ ...binding, leaseId: "lease:secret" }), { code: "M6_LIVE_PIPE_BINDING_INVALID" });
  assert.throws(() => validateM6LivePipeBinding({ ...binding, alias: "02" }), { code: "M6_LIVE_PIPE_BINDING_INVALID" });
  await assert.rejects(() => apply(), { code: "M6_LIVE_PROFILE_UNQUALIFIED" });
});

test("qualified model profile is content addressed and sealed to one adapter, endpoint and environment", () => {
  const H = "a".repeat(64);
  const raw = {
    schemaId: "xw.m6-live-model-profile.v1", status: "QUALIFIED", provider: "deepseek-official", model: "deepseek-model-qualified",
    exactVersion: "owner-qualified-version", adapterPackage: "@deepseek-ai/dsh-llm-deepseek", adapterVersion: "0.1.0-rc.8",
    contextWindow: 64_000, maxTokens: 4_096, streamIdleTimeoutMs: 30_000, thinking: "disabled", reasoningEffort: "off",
    credentialRef: "DEEPSEEK_API_KEY", license: "MIT", secretMaterialPresent: false, deploymentSecretInjectionRequired: true,
    adapterIntegrityHash: H, adapterSourceHash: H, licenseHash: H, endpointHash: H, provenanceHash: H, qualificationHash: H,
    toolCallHealthHash: H, warmHealthHash: H, coldHealthHash: H, ttlHealthHash: H, secretInjectionAttestationHash: H,
    runtimeAttestationHashes: [H], gateFEligible: true,
  };
  const profile = { ...raw, contentHash: deriveLiveModelProfileHash(raw) };
  assert.equal(validateQualifiedLiveModelProfile(profile).ok, true);
  assert.ok(validateQualifiedLiveModelProfile({ ...profile, model: "mutated" }).errors.includes("M6_LIVE_PROFILE_CONTENT_MISMATCH"));
  assert.ok(validateQualifiedLiveModelProfile({ ...profile, adapterVersion: "latest" }).errors.includes("M6_LIVE_PROVIDER_UNSEALED"));
  assert.ok(validateQualifiedLiveModelProfile({ ...profile, runtimeAttestationHashes: [] }).errors.includes("M6_LIVE_ENVIRONMENT_UNQUALIFIED"));
});
