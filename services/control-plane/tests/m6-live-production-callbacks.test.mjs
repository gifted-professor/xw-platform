import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { resolveM64CohortActionSlot } from "../../../packages/kernel/lib/m6-4-cohort.mjs";
import { deriveTargetEnvironmentAttestation } from "../../../packages/kernel/lib/m6-live-grounding.mjs";
import { createM6LivePipeBinding } from "../../../integrations/dsh-xw/src/live-pipe-client.mjs";
import { CapabilityRegistry } from "../control-plane/lib/capability-registry.mjs";
import { canonicalJson, sha256 } from "../control-plane/lib/canonical.mjs";
import {
  createM6LiveProductionCallbacks,
  deriveM64IndependentEffectObservation,
  deriveM64IndependentOracleMatch,
  deriveM64OracleExpectation,
} from "../control-plane/lib/m6-live-production-callbacks.mjs";
import { StateStore } from "../control-plane/lib/state-store.mjs";

const H = (value) => sha256(value);
const NOW = Date.parse("2030-01-01T00:00:00.000Z");

function seedFence(state) {
  const raw = {
    schemaId: "xw.m6-live-gate.v1",
    gateId: "m6-gate",
    mode: "CLOSED",
    status: "closed",
    releaseId: "release-m64",
    sourceCommit: "a".repeat(40),
    actor: "operator:test",
    lockHashes: { runtimeProfile: H("r"), hardRedlinePolicy: H("h"), groundingRuntime: H("g") },
    allowlist: ["01"],
    issuedAt: "2029-12-31T23:00:00.000Z",
    expiresAt: "2030-01-02T00:00:00.000Z",
    parentEpochHash: null,
    closeoutRef: { id: "c", sha256: H("c") },
    aggregateSealRef: { id: "a", sha256: H("a") },
    rollbackTargetEpochHash: null,
  };
  const epoch = { ...raw, epochHash: H(`xw.m6-live-gate.v1:${canonicalJson(raw)}`) };
  state.seedM6GateFence({ epoch, locksHash: H("locks") });
  return state.promoteM6GateFence({
    expectedEpochHash: epoch.epochHash,
    expectedGeneration: 0,
    next: {
      gateId: raw.gateId,
      epochHash: H("action-epoch"),
      mode: "GROUNDED_ACTION",
      purpose: "M6_4_ACTION_SMOKE",
      allowlist: ["01"],
      expiresAt: "2030-01-01T01:00:00.000Z",
      releaseId: raw.releaseId,
      sourceCommit: raw.sourceCommit,
      locksHash: H("locks-v2"),
    },
  });
}

function environment() {
  return deriveTargetEnvironmentAttestation({
    appPackageHash: H("pkg"),
    appBuildHash: H("build"),
    signingHash: H("sign"),
    osBuildHash: H("os"),
    displayHash: H("display"),
    localeThemeHash: H("locale"),
    imeHash: H("ime"),
    accessibilityHash: H("access"),
    accountIsolationHash: H("account"),
    capturedAt: "2029-12-31T23:55:00.000Z",
    expiresAt: "2030-01-01T00:10:00.000Z",
  });
}

function qualification(env) {
  return Object.freeze({
    schemaId: "xw.m6-environment-qualification.v1",
    status: "QUALIFIED",
    gateFEligible: true,
    alias: "01",
    effectBoundary: "READ_ONLY",
    commandRegistryHash: H("commands"),
    qualifiedAttestationHashes: [env.attestationHash],
    sampleCount: 2,
    capturedAt: env.capturedAt,
    expiresAt: env.expiresAt,
    secretMaterialPresent: false,
    rawDeviceIdentityPresent: false,
    actionCount: 0,
  });
}

function inMemoryAudit() {
  const artifacts = [];
  return {
    artifacts,
    commit(kind, payload) {
      const artifactHash = H(`${kind}:${canonicalJson(payload)}`);
      artifacts.push({ kind, payload, artifactHash });
      return { artifactHash, artifactRef: artifactHash };
    },
  };
}

test("production callbacks own one formal composite capability job/session/lease and close them after a verified typed action", async (t) => {
  const evidenceDirectoryRoot = mkdtempSync(join(tmpdir(), "m6-live-production-evidence-"));
  t.after(() => rmSync(evidenceDirectoryRoot, { recursive: true, force: true }));
  const state = new StateStore({ now: () => NOW });
  try {
    const registry = CapabilityRegistry.load(fileURLToPath(new URL("../apps", import.meta.url)));
    const capability = registry.require("xiaowei.m6.grounded_run");
    assert.deepEqual(capability.invocationPolicy.allowedModes, ["composite_action"]);
    assert.match(capability.implementation.implementationClosureHash, /^[0-9a-f]{64}$/u);
    state.syncCapabilities(registry);
    state.upsertNode({ nodeId: "node-1", authority: true });
    state.upsertDevice({
      deviceId: "device-1",
      alias: "01",
      physicalLabel: "m6-test-device",
      nodeId: "node-1",
      runtimeId: "private-runtime-1",
      routingProfile: { enabled: true, capabilityIds: [capability.id] },
    });
    const fence = seedFence(state);
    const manifest = JSON.parse(readFileSync(new URL("../../../artifacts/m6-4/cohort-manifests/m6_4_action_smoke.json", import.meta.url), "utf8"));
    const effectBoundary = JSON.parse(readFileSync(new URL("../../../artifacts/m6-4/cohort-manifests/xw.m6-effect-boundary.v1.json", import.meta.url), "utf8"));
    const scenario = manifest.scenarios[0];
    const env = environment();
    const auditStore = inMemoryAudit();
    let hangOracle = false;
    const independentOracle = {
      async loadExpectation(authority) {
        return deriveM64OracleExpectation({
          schemaId: "xw.m6-4-independent-expected-state.v1",
          purpose: authority.purpose,
          manifestHash: authority.manifestHash,
          scenarioKey: authority.scenarioKey,
          primaryFamily: authority.primaryFamily,
          oracleHash: authority.oracleHash,
          effectBoundaryHash: authority.effectBoundaryHash,
          environmentAttestationHash: authority.environmentAttestationHash,
          accountIsolationHash: authority.accountIsolationHash,
          expectedStateHash: H("expected-data"),
          independentAuthorHash: H("independent-author"),
          sourceClass: "INDEPENDENT_PRE_DISPATCH",
          selfDerived: false,
          authoredAt: "2029-12-31T23:00:00.000Z",
          expiresAt: "2030-01-01T00:05:00.000Z",
        });
      },
      async observe(authority) {
        if (hangOracle) return new Promise(() => {});
        const familyRule = effectBoundary.families.find((entry) => entry.primaryFamily === authority.primaryFamily);
        return deriveM64IndependentEffectObservation({
          schemaId: "xw.m6-4-independent-effect-observation.v1",
          phase: authority.phase,
          sourceClass: "INDEPENDENT_POST_DISPATCH",
          selfDerived: false,
          scenarioKey: authority.scenarioKey,
          primaryFamily: authority.primaryFamily,
          oracleHash: authority.oracleHash,
          effectBoundaryHash: authority.effectBoundaryHash,
          environmentAttestationHash: authority.environmentAttestationHash,
          accountIsolationHash: authority.accountIsolationHash,
          expectedArtifactHash: authority.expectedArtifactHash,
          independentObserverHash: H("independent-observer"),
          actualStateHash: authority.phase === "final" ? H("expected-data") : H(`business:${authority.phase}`),
          sourceEvidenceHash: H(`source-evidence:${authority.phase}`),
          observedEffects: [],
          resetResults: Object.fromEntries(familyRule.resetObligations.map((obligation) => [obligation, true])),
          counters: {
            forbiddenEffectCount: 0,
            publicEffectCount: 0,
            paymentAttemptCount: 0,
            deleteAttemptCount: 0,
            misclickCount: 0,
            staleActionCount: 0,
            duplicateActionCount: 0,
            unknownReplayCount: 0,
            riskChallengeCount: 0,
            unknownEffectCount: 0,
            actionApprovalPromptCount: 0,
            humanInterventionCount: 0,
          },
          observedAt: "2030-01-01T00:00:00.000Z",
        });
      },
      async compare(input) {
        return deriveM64IndependentOracleMatch({
          schemaId: "xw.m6-4-independent-oracle-match.v1",
          matched: true,
          selfDerived: false,
          expectedStateHash: input.expectedStateHash,
          beforeObservationHash: input.beforeObservationHash,
          afterObservationHash: input.afterObservationHash,
          slotAuthorityHash: input.slotAuthorityHash,
          independentAuthorHash: input.independentAuthorHash,
        });
      },
    };
    let captures = 0;
    let rawWrites = 0;
    let selectorInput = null;
    let mono = 40_000;
    const callbacks = createM6LiveProductionCallbacks({
      state,
      capabilities: registry,
      transport: { invoke() { throw new Error("raw test transport must stay behind the TCB"); } },
      evidence: {},
      environmentAttestation: env,
      environmentQualification: qualification(env),
      effectBoundary,
      independentOracle,
      targetSelector: (input) => {
        selectorInput = input;
        return input.blockSet.blocks[0].blockId;
      },
      currentStateGuard: ({ expectedState }) => ({ ...expectedState }),
      evidenceDirectoryRoot,
      auditStore,
      authorityNodeId: "node-1",
      observeDevice: async () => { throw new Error("captureFrame test seam should own observation"); },
      captureFrame: async ({ environmentAttestation: attestation, generation }) => {
        captures += 1;
        const frameId = H(`frame:${captures}`);
        return {
          frameRef: frameId,
          frame: {
            frameId,
            width: 1080,
            height: 2400,
            focusHash: H("focus"),
            stability: {
              verdict: "stable",
              pageFingerprint: H("stable-page"),
              focusFingerprint: H("focus"),
            },
            environmentAttestationHash: attestation.attestationHash,
          },
          dumpXml: "<hierarchy><node text=\"安全标签\" resource-id=\"com.xingin.xhs:id/tab\" class=\"android.view.View\" package=\"com.xingin.xhs\" clickable=\"true\" bounds=\"[10,100][900,500]\"/><node text=\"\" class=\"android.view.View\" package=\"com.xingin.xhs\" clickable=\"false\" bounds=\"[0,0][1080,2400]\"/></hierarchy>",
          observation: { observationId: `obs-${captures}`, evidenceRefs: [H(`evidence:${captures}`)] },
          observationRaw: { package: "com.xingin.xhs", rotation: 0 },
          generation,
        };
      },
      tcbFactory: () => ({
        async invokeWrite(_binding, invocation) {
          rawWrites += 1;
          assert.equal(invocation.primitive, "tap");
          return { ok: true, vendorCode: 10000 };
        },
      }),
      now: () => NOW,
      monoNow: () => { mono += 10; return mono; },
      oracleTimeoutMs: 20,
    });

    const authorizationId = "m6auth_callback_test";
    const authorizationHash = H("authorization-envelope");
    const ref = (kind) => `${kind}:${H(`xw.m6-live-entry.v1:${kind}:${authorizationHash}:${scenario.scenarioKey}`)}`;
    const binding = createM6LivePipeBinding({
      runId: ref("run"),
      workerId: ref("worker"),
      sessionId: ref("session"),
      alias: "01",
      processRef: ref("process"),
      gateEpochHash: fence.epochHash,
      generation: fence.generation,
      purpose: manifest.purpose,
      scenarioManifestHash: manifest.manifestHash,
      liveWindowAuthorizationHash: authorizationHash,
    });
    const consumptionRaw = {
      schemaId: "xw.m6-4-live-window-authorization-consumption.v1",
      authorizationId,
      nonceHash: H("callback-nonce"),
      bodyHash: H("callback-body"),
      envelopeHash: authorizationHash,
      issuer: "owner:test",
      keyId: "callback-key",
      allowlistVersion: 1,
      gateId: fence.gateId,
      gateEpochHash: fence.epochHash,
      gateGeneration: fence.generation,
      purpose: fence.purpose,
      releaseId: fence.releaseId,
      sourceCommit: fence.sourceCommit,
      locksHash: fence.locksHash,
      expiresAt: "2030-01-01T00:05:00.000Z",
      consumedAt: "2030-01-01T00:00:00.000Z",
    };
    const consumption = {
      ...consumptionRaw,
      consumptionHash: H(`xw.m6-4-live-window-authorization-consumption.v1:${canonicalJson(consumptionRaw)}`),
    };
    state.db.prepare(`
      INSERT INTO m6_live_window_authorization_consumptions (
        nonce_hash, authorization_id, body_hash, envelope_hash, issuer, key_id,
        allowlist_version, gate_id, gate_epoch_hash, gate_generation, purpose,
        release_id, source_commit, locks_hash, expires_at, consumed_at, consumption_receipt_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      consumption.nonceHash, consumption.authorizationId, consumption.bodyHash, consumption.envelopeHash,
      consumption.issuer, consumption.keyId, consumption.allowlistVersion, consumption.gateId,
      consumption.gateEpochHash, consumption.gateGeneration, consumption.purpose, consumption.releaseId,
      consumption.sourceCommit, consumption.locksHash, Date.parse(consumption.expiresAt),
      Date.parse(consumption.consumedAt), canonicalJson(consumption),
    );
    const scenarioClaimHash = H("scenario-claim");
    state.db.prepare(`
      INSERT INTO m6_live_scenario_claims (
        claim_hash, authorization_id, authorization_hash, manifest_hash, scenario_key,
        purpose, gate_epoch_hash, gate_generation, status, claimed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'STARTED', ?)
    `).run(
      scenarioClaimHash,
      authorizationId,
      authorizationHash,
      manifest.manifestHash,
      scenario.scenarioKey,
      manifest.purpose,
      fence.epochHash,
      fence.generation,
      NOW,
    );
    const context = Object.freeze({
      manifest,
      manifestHash: manifest.manifestHash,
      scenario,
      scenarioKey: scenario.scenarioKey,
      scenarioClaimHash,
      authorizationId,
      liveAuthorizationHash: authorizationHash,
      liveAuthorizationIssuedAt: "2029-12-31T23:59:00.000Z",
      liveAuthorizationExpiresAt: "2030-01-01T00:05:00.000Z",
      authorizationConsumptionHash: consumption.consumptionHash,
    });
    const run = { binding, actionPlan: scenario.actionPlan, workerRunRef: "workerrun:m64-callback-test", actionCount: 0 };
    const baseCall = { run, context, fence, authorizationConsumption: {} };
    const observed = await callbacks.observe({ ...baseCall, params: { runRef: H("run-ref"), stepRef: H("step-ref") }, slotAuthority: scenario.actionPlan.slots[0] });
    assert.equal(observed.actionCount, 0);
    assert.equal(state.listLeases().length, 1);
    assert.equal(state.listLeases()[0].expiresAt, "2030-01-01T00:04:59.000Z");
    const grounded = await callbacks.ground({
      ...baseCall,
      params: {
        frameRef: observed.frameRef,
        intentRef: scenario.actionPlan.slots[0].intentRef,
      },
      slotAuthority: scenario.actionPlan.slots[0],
    });
    assert.equal(grounded.disposition, "ALLOW_ONCE");
    assert.equal(selectorInput.candidateBlockId, null);
    const actionSlotResolution = resolveM64CohortActionSlot({
      manifest,
      scenarioId: scenario.scenarioKey,
      logicalStepId: scenario.actionPlan.slots[0].logicalStepId,
      actionSlotOrdinal: scenario.actionPlan.slots[0].actionSlotOrdinal,
      request: {
        primitive: scenario.actionPlan.slots[0].primitive,
        intentRef: scenario.actionPlan.slots[0].intentRef,
        targetKind: scenario.actionPlan.slots[0].targetKind,
        trustedParams: scenario.actionPlan.slots[0].trustedParams,
      },
    });
    const acted = await callbacks.act({
      ...baseCall,
      params: { decisionRef: grounded.decisionRef, operationKey: grounded.operationKey },
      slotAuthority: scenario.actionPlan.slots[0],
      actionSlotResolution,
    });
    assert.deepEqual({ effect: acted.externalEffect, count: acted.actionCount, status: acted.effectStatus }, { effect: true, count: 1, status: "VERIFIED" });
    assert.equal(rawWrites, 1);
    const verified = await callbacks.verify({
      ...baseCall,
      params: { actionReceiptRef: acted.actionReceiptRef, expectationRef: acted.verificationRef },
      slotAuthority: scenario.actionPlan.slots[1],
    });
    assert.equal(verified.verified, true);
    const secondObserved = await callbacks.observe({
      ...baseCall,
      params: { runRef: H("run-ref"), stepRef: H("step-ref-2") },
      slotAuthority: scenario.actionPlan.slots[1],
    });
    hangOracle = true;
    await assert.rejects(() => callbacks.ground({
      ...baseCall,
      params: { frameRef: secondObserved.frameRef, intentRef: scenario.actionPlan.slots[1].intentRef },
      slotAuthority: scenario.actionPlan.slots[1],
    }), { code: "M6_LIVE_SEAM_TIMEOUT" });
    hangOracle = false;
    assert.equal(rawWrites, 1, "a timed-out oracle seam must not reach a second transport");
    const completed = await callbacks.complete({ ...baseCall, params: { workerRunRef: run.workerRunRef, outcome: "SUCCEEDED" }, slotAuthority: null });
    assert.equal(completed.status, "COMPLETED");
    run.status = "COMPLETED";
    run.actionCount = 1;
    const closed = await callbacks.close({ run, context, reason: "CANARY_COMPLETE" });
    assert.equal(closed.verifiedClosed, true);
    assert.equal(closed.actionCount, 1);
    assert.equal(closed.transportCount, 1);
    assert.equal(closed.sessionCount, 0);
    assert.equal(closed.leaseCount, 0);
    assert.equal(closed.activeJobCount, 0);
    assert.match(closed.scenarioResultHash, /^[0-9a-f]{64}$/u);
    assert.equal(closed.attemptEvidence.expectedArtifactHash, closed.attemptEvidence.oracleEvidence.expectedArtifactHash);
    assert.equal(closed.attemptEvidence.actionEvidence.actionCount, 1);
    assert.equal(state.listLeases().length, 0);
    const actionId = auditStore.artifacts.find((artifact) => artifact.kind === "grounded-action").payload.actionId;
    const ledger = state.getM6ActionLedger(actionId);
    assert.equal(ledger.status, "COMPLETED");
    assert.equal(state.sessionExists(ledger.sessionId), false);
    assert.equal(state.getM64LiveScenarioClaim(scenarioClaimHash).status, "FINALIZED");
  } finally {
    state.close();
  }
});

test("composite_action seam is not a public session-mode widening", () => {
  const state = new StateStore({ now: () => NOW });
  try {
    const registry = CapabilityRegistry.load(fileURLToPath(new URL("../apps", import.meta.url)));
    const capability = registry.require("xiaowei.m6.grounded_run");
    state.syncCapabilities(registry);
    state.upsertNode({ nodeId: "node-1", authority: true });
    state.upsertDevice({
      deviceId: "device-1",
      alias: "01",
      physicalLabel: "m6-test-device",
      nodeId: "node-1",
      runtimeId: "private-runtime-1",
      routingProfile: { enabled: true, capabilityIds: [capability.id] },
    });
    assert.throws(() => state.createSession({
      actorId: "agent:public",
      authorityNodeId: "node-1",
      deviceId: "device-1",
      capability,
      canary: true,
    }), { code: "CAPABILITY_INVOCATION_FORBIDDEN" });
    assert.throws(() => state.createSession({
      actorId: "agent:wrong-capability",
      authorityNodeId: "node-1",
      deviceId: "device-1",
      capability: { ...capability, id: "xiaowei.m6.other" },
      canary: true,
      invocation: "composite_action",
    }), { code: "CAPABILITY_INVOCATION_FORBIDDEN" });
  } finally {
    state.close();
  }
});
