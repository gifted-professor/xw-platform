import { canonicalJson, sha256 } from "../../control-plane/lib/canonical.mjs";

const PURPOSE_SCENARIO_PREFIX = Object.freeze({
  M6_4_SHADOW: "m6_4_shadow",
  M6_4_HOT_CLOSE: "m6_4_hot_close",
  M6_4_ACTION_SMOKE: "m6_4_action_smoke",
  M6_4_RELIABILITY: "m6_4_reliability",
  M6_4_SMOOTH: "m6_4_smooth",
});

export function seedM6CompositeAuthority(state, {
  fence,
  authorizationId = `m6auth_${sha256(fence.epochHash).slice(0, 24)}`,
  authorizationHash = sha256(`authorization:${fence.epochHash}`),
  scenarioManifestHash = sha256(`manifest:${fence.purpose}`),
  scenarioKey = `${PURPOSE_SCENARIO_PREFIX[fence.purpose]}-01`,
} = {}) {
  const ref = (kind) => `${kind}:${sha256(`xw.m6-live-entry.v1:${kind}:${authorizationHash}:${scenarioKey}`)}`;
  const bindingCore = {
    runId: ref("run"),
    workerId: ref("worker"),
    sessionId: ref("session"),
    alias: "01",
    processRef: ref("process"),
    gateEpochHash: fence.epochHash,
    generation: fence.generation,
    purpose: fence.purpose,
    scenarioManifestHash,
    liveWindowAuthorizationHash: authorizationHash,
  };
  const binding = Object.freeze({
    ...bindingCore,
    bindingHash: sha256(canonicalJson(bindingCore)),
  });
  const consumedAt = new Date(state.now()).toISOString();
  const consumptionRaw = {
    schemaId: "xw.m6-4-live-window-authorization-consumption.v1",
    authorizationId,
    nonceHash: sha256(`nonce:${authorizationId}`),
    bodyHash: sha256(`body:${authorizationId}`),
    envelopeHash: authorizationHash,
    issuer: "owner:test",
    keyId: "m6-test-key",
    allowlistVersion: 1,
    gateId: fence.gateId,
    gateEpochHash: fence.epochHash,
    gateGeneration: fence.generation,
    purpose: fence.purpose,
    releaseId: fence.releaseId,
    sourceCommit: fence.sourceCommit,
    locksHash: fence.locksHash,
    expiresAt: fence.expiresAt,
    consumedAt,
  };
  const consumption = Object.freeze({
    ...consumptionRaw,
    consumptionHash: sha256(`xw.m6-4-live-window-authorization-consumption.v1:${canonicalJson(consumptionRaw)}`),
  });
  state.db.prepare(`
    INSERT INTO m6_live_window_authorization_consumptions (
      nonce_hash, authorization_id, body_hash, envelope_hash, issuer, key_id,
      allowlist_version, gate_id, gate_epoch_hash, gate_generation, purpose,
      release_id, source_commit, locks_hash, expires_at, consumed_at, consumption_receipt_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    consumption.nonceHash,
    consumption.authorizationId,
    consumption.bodyHash,
    consumption.envelopeHash,
    consumption.issuer,
    consumption.keyId,
    consumption.allowlistVersion,
    consumption.gateId,
    consumption.gateEpochHash,
    consumption.gateGeneration,
    consumption.purpose,
    consumption.releaseId,
    consumption.sourceCommit,
    consumption.locksHash,
    Date.parse(consumption.expiresAt),
    Date.parse(consumption.consumedAt),
    canonicalJson(consumption),
  );
  const scenarioClaimHash = sha256(`claim:${authorizationId}:${scenarioKey}`);
  state.db.prepare(`
    INSERT INTO m6_live_scenario_claims (
      claim_hash, authorization_id, authorization_hash, manifest_hash, scenario_key,
      purpose, gate_epoch_hash, gate_generation, status, claimed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'STARTED', ?)
  `).run(
    scenarioClaimHash,
    authorizationId,
    authorizationHash,
    scenarioManifestHash,
    scenarioKey,
    fence.purpose,
    fence.epochHash,
    fence.generation,
    state.now(),
  );
  return Object.freeze({
    actorId: "agent:m6-production-broker",
    authority: Object.freeze({
      authorizationConsumptionHash: consumption.consumptionHash,
      authorizationId,
      binding,
      fence,
      scenarioClaimHash,
    }),
    binding,
    idempotencyKey: `m6-live:${binding.runId}`,
    params: Object.freeze({
      grantRef: consumption.consumptionHash,
      runPacketRef: binding.bindingHash,
      scenarioManifestRef: scenarioManifestHash,
    }),
  });
}
