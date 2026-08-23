import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { deriveLiveModelProfileHash } from "../../integrations/dsh-xw/src/live-model-profile.mjs";
import {
  canonicalM64LiveWindowAuthorizationSigningBytes,
  deriveM64LiveWindowAuthorizationBodyHash,
  deriveM64LiveWindowAuthorizationEnvelopeHash,
  selectM64LiveWindowRuntimeBinding,
} from "../../packages/kernel/lib/m6-4-live-window-authorization.mjs";
import {
  M64_LIVE_WINDOW_ISSUER_ALLOWLIST_SCHEMA_ID,
  normalizeM64LiveWindowIssuerAllowlist,
} from "../../services/control-plane/control-plane/lib/m6-live-window-authorization.mjs";
import { deriveM6AggregateSealHash } from "../../packages/kernel/lib/m6-aggregate-closeout.mjs";
import {
  M64_LIVE_ACTION_EVIDENCE_SCHEMA_ID,
  M64_LIVE_ATTEMPT_EVIDENCE_SCHEMA_ID,
  deriveM64ActionEvidence,
  deriveM64AttemptEvidence,
  deriveM64IndependentEffectObservation,
} from "../../packages/kernel/lib/m6-live-evidence.mjs";
import { deriveM6V2EpochHash } from "../../services/control-plane/control-plane/lib/m6-live-gate-v2.mjs";
import { deriveM6CloseoutHash } from "../../services/control-plane/control-plane/lib/m6-live-gate.mjs";
import { deriveM6LiveEntryRunId } from "../../services/control-plane/control-plane/lib/m6-live-entry.mjs";
import {
  M64_LOOPBACK_REQUEST_TIMEOUTS_MS,
  requestM64LiveEntry,
  resolveM64LoopbackRequestTimeoutMs,
  runM64Canary,
  validateM64LiveWindowAuthorization,
  validateM64LoopbackControlPlaneUrl,
  withM64LoopbackRequestDeadline,
} from "./m6-4-canary-runner.mjs";
import {
  M64_LIVE_CLOSE_RECONCILIATION_TIMEOUT_MS,
  M64_STAGED_CANARY_ORDER,
  createM64LoopbackCanaryClient,
  deriveM64CanaryWindowInventoryHash,
  deriveM64ExpectedOracleHash,
  deriveM64ResourceProbeHash,
  loadM64CanaryWindowInventory,
  runM64StagedCanary,
  verifyM64ActionCanaryCompletion,
} from "./m6-4-canary-orchestrator.mjs";

const H = "a".repeat(64);
function fixture({ scenarioManifestHash = H, modelProfileHash = H } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const body = {
    schemaId: "xw.m6-4-live-window-authorization.v1",
    authorizationId: "runner-live-auth-0001",
    issuer: "owner:runner-test",
    keyId: "runner-owner-key",
    allowlistVersion: 1,
    signatureAlgorithm: "ed25519",
    nonce: "runner-live-nonce-00001",
    alias: "01",
    releaseId: "runner-release",
    releaseHash: "1".repeat(64),
    sourceCommit: "a".repeat(40),
    gateId: "m6-gate",
    gateEpochHash: "2".repeat(64),
    gateGeneration: 4,
    purpose: "M6_4_ACTION_SMOKE",
    scenarioManifestHash,
    runtimeProfileHash: "3".repeat(64),
    modelProfileHash,
    providerHash: "4".repeat(64),
    toolProfileHash: "5".repeat(64),
    policyHash: "6".repeat(64),
    locksHash: "7".repeat(64),
    environmentAttestationHash: "8".repeat(64),
    operatorHash: "9".repeat(64),
    emergencyCloseAuthorizationHash: "b".repeat(64),
    emergencyCloseReasonCodeAllowlist: ["SAFETY_STOP"],
    closeoutGraceMs: 30 * 60 * 1000,
    effectBoundary: "BOUNDED_READ_TRACE",
    independentOracleHash: "c".repeat(64),
    resetObligationsHash: "d".repeat(64),
    issuedAt: "2030-01-01T00:00:00.000Z",
    expiresAt: "2030-01-01T01:00:00.000Z",
  };
  const withBodyHash = { ...body, bodyHash: deriveM64LiveWindowAuthorizationBodyHash(body) };
  const withSignature = { ...withBodyHash, signature: sign(null, canonicalM64LiveWindowAuthorizationSigningBytes(withBodyHash), privateKey).toString("base64") };
  const authorization = { ...withSignature, envelopeHash: deriveM64LiveWindowAuthorizationEnvelopeHash(withSignature) };
  const issuerAllowlistDocument = {
    schemaId: M64_LIVE_WINDOW_ISSUER_ALLOWLIST_SCHEMA_ID,
    version: 1,
    keys: [{ issuer: body.issuer, keyId: body.keyId, publicKey: publicKey.export({ type: "spki", format: "pem" }), status: "active" }],
  };
  const issuerAllowlist = normalizeM64LiveWindowIssuerAllowlist(issuerAllowlistDocument);
  return { authorization, issuerAllowlist, issuerAllowlistDocument, runtime: selectM64LiveWindowRuntimeBinding(authorization) };
}

test("canary runner uses the production signature verifier plus exact manifest/model/runtime binding", () => {
  const f = fixture();
  const manifest = { manifestHash: H };
  const qualifiedModel = { status: "QUALIFIED", gateFEligible: true, contentHash: H };
  assert.ok(validateM64LiveWindowAuthorization(f.authorization, {
    manifest,
    modelManifest: { status: "UNQUALIFIED", gateFEligible: false, contentHash: null },
    issuerAllowlist: f.issuerAllowlist,
    runtime: f.runtime,
    nowMs: Date.parse("2030-01-01T00:10:00.000Z"),
  }).errors.includes("M64_LIVE_MODEL_UNQUALIFIED"));
  assert.equal(validateM64LiveWindowAuthorization(f.authorization, {
    manifest,
    modelManifest: qualifiedModel,
    issuerAllowlist: f.issuerAllowlist,
    runtime: f.runtime,
    nowMs: Date.parse("2030-01-01T00:10:00.000Z"),
  }).ok, true);
  assert.ok(validateM64LiveWindowAuthorization(f.authorization, {
    manifest,
    modelManifest: qualifiedModel,
    issuerAllowlist: f.issuerAllowlist,
    runtime: { ...f.runtime, providerHash: "e".repeat(64) },
    nowMs: Date.parse("2030-01-01T00:10:00.000Z"),
  }).errors.includes("M64_LIVE_AUTH_RUNTIME_BINDING_MISMATCH"));
  assert.ok(validateM64LiveWindowAuthorization(f.authorization, {
    manifest,
    modelManifest: qualifiedModel,
    nowMs: Date.parse("2030-01-01T00:10:00.000Z"),
  }).errors.includes("M64_LIVE_AUTH_RUNTIME_BINDING_MISSING"));
});

test("standalone --execute is rejected before any loopback request or live resource can be created", async () => {
  const calls = [];
  await assert.rejects(() => runM64Canary([
    "--manifest", resolve("artifacts/m6-4/cohort-manifests/m6_4_action_smoke.json"),
    "--execute",
  ], {
    env: { XW_M6_LIVE_ENTRY_TOKEN: "runner-internal-token-32-bytes-minimum" },
    fetchImpl: async (...args) => { calls.push(args); throw new Error("must not fetch"); },
  }), { code: "M64_STANDALONE_EXECUTE_FORBIDDEN" });
  assert.equal(calls.length, 0);
});

test("standalone runner remains a zero-action manifest validator", async () => {
  const manifestPath = resolve("artifacts/m6-4/cohort-manifests/m6_4_action_smoke.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const result = await runM64Canary(["--manifest", manifestPath]);
  assert.deepEqual(result, {
    ok: true,
    mode: "PREFLIGHT_ONLY",
    gateFEligible: false,
    actionCount: 0,
    manifestHash: manifest.manifestHash,
  });
});

test("execute client never permits a non-loopback Control Plane or body/response token echo", async () => {
  assert.throws(() => validateM64LoopbackControlPlaneUrl("https://control.example.test/"), { code: "M64_CONTROL_PLANE_NOT_LOOPBACK" });
  assert.throws(() => validateM64LoopbackControlPlaneUrl("http://127.0.0.1:18000/"), { code: "M64_CONTROL_PLANE_NOT_LOOPBACK" });
  const token = "runner-internal-token-32-bytes-minimum";
  let alternatePortFetchCount = 0;
  await assert.rejects(() => requestM64LiveEntry({
    operation: "preflight",
    body: { opaque: true },
    controlPlaneUrl: "http://127.0.0.1:18000/",
    token,
    fetchImpl: async () => { alternatePortFetchCount += 1; throw new Error("must not disclose token"); },
  }), { code: "M64_CONTROL_PLANE_NOT_LOOPBACK" });
  assert.equal(alternatePortFetchCount, 0);
  await assert.rejects(() => requestM64LiveEntry({
    operation: "preflight",
    body: { opaque: true },
    controlPlaneUrl: "http://127.0.0.1:17920/",
    token,
    fetchImpl: async () => ({ ok: true, async json() { return { echoed: token }; } }),
  }), { code: "M64_LIVE_ENTRY_TOKEN_ECHO" });
});

test("loopback deadlines are fixed by exact authority and operation with production-safe bounds", async () => {
  assert.deepEqual(M64_LOOPBACK_REQUEST_TIMEOUTS_MS, {
    "gate-f": {
      status: 5_000,
      preflight: 10_000,
      activate: 15_000,
      close: 15_000,
      reconcile: 15_000,
      "recover-armed-active": 30_000,
    },
    "live-entry": {
      status: 5_000,
      preflight: 10_000,
      start: 25_000,
      close: 90_000,
      "recover-epoch": 300_000,
    },
  });
  assert.equal(resolveM64LoopbackRequestTimeoutMs("live-entry", "start"), 25_000);
  assert.equal(resolveM64LoopbackRequestTimeoutMs("live-entry", "close"), 90_000);
  assert.equal(M64_LIVE_CLOSE_RECONCILIATION_TIMEOUT_MS, 195_000);
  assert.equal(resolveM64LoopbackRequestTimeoutMs("gate-f", "status"), 5_000);
  assert.equal(resolveM64LoopbackRequestTimeoutMs("gate-f", "recover-armed-active"), 30_000);
  assert.equal(resolveM64LoopbackRequestTimeoutMs("live-entry", "recover-epoch"), 300_000);
  assert.throws(() => resolveM64LoopbackRequestTimeoutMs("live-entry", "execute"), {
    code: "M64_LOOPBACK_REQUEST_INVALID",
  });
  assert.throws(() => resolveM64LoopbackRequestTimeoutMs("device", "status"), {
    code: "M64_LOOPBACK_REQUEST_INVALID",
  });
  assert.equal(await withM64LoopbackRequestDeadline("live-entry", "status", async (signal) => {
    assert.ok(signal instanceof AbortSignal);
    return "bounded";
  }), "bounded");
});

test("production canary client routes Gate/live recovery with separate tokens, exact bodies, and fixed deadlines", async () => {
  const calls = [];
  const gateToken = "staged-canary-gate-token-32-bytes";
  const liveToken = "staged-canary-live-token-32-bytes";
  const priorEpochHash = "1".repeat(64);
  const terminalEpochHash = "2".repeat(64);
  const locksHash = "3".repeat(64);
  const purpose = "M6_4_ACTION_SMOKE";
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    const path = new URL(url).pathname;
    const payload = path.endsWith("/gate-f/status") ? { gate: { phase: "CLOSED" } }
      : path.endsWith("/gate-f/preflight") ? { preflight: { status: "SEALED_PREFLIGHT", resourceCount: 0 } }
        : path.endsWith("/gate-f/activate") || path.endsWith("/gate-f/close") ? { promotion: { phase: path.endsWith("/close") ? "CLOSED" : "GROUNDED_ACTION" } }
          : path.endsWith("/gate-f/reconcile") ? { reconciliation: { phase: "CLOSED", tripleConsistent: true } }
          : path.endsWith("/gate-f/recover-armed-active") ? {
            recovery: {
              schemaId: "xw.m6-gate-f-armed-active-recovery.v1",
              recovered: true,
              priorEpochHash,
              terminalEpochHash,
              tripleConsistent: true,
              status: "EMERGENCY_CLOSED",
            },
            gate: {
              schemaId: "xw.m6-gate-f-operations-status.v1",
              mode: "CLOSED",
              phase: "CLOSED",
              purpose: null,
              epochHash: terminalEpochHash,
              generation: 8,
              locksHash,
              tripleConsistent: true,
              errors: [],
              activeAuthorizationCount: 0,
              actionCount: 2,
              resourceCounts: { jobs: 0, leases: 0, runs: 2, sessions: 0 },
            },
          }
          : path.endsWith("/live/preflight") ? { preflight: { status: "SEALED_PREFLIGHT", resourceCount: 0 } }
            : path.endsWith("/live/start") ? { run: { runId: "run:production-client", status: "COMPLETED" } }
              : path.endsWith("/live/status") ? { run: { runId: "run:production-client", status: "COMPLETED" } }
                : path.endsWith("/live/close") ? { run: { runId: "run:production-client", status: "CLOSED", closed: true } }
                  : {
                    recovery: {
                      schemaId: "xw.m6-live-entry-epoch-recovery.v1",
                      status: "RECOVERED",
                      gateEpochHash: priorEpochHash,
                      purpose,
                      stopNewStarts: true,
                      inFlightStartsSettled: 0,
                      attempted: 2,
                      verifiedClosed: 2,
                      activeMatchingRuns: 0,
                      controlPlaneOwnedActiveRuns: 0,
                      externalResourceState: "NOT_ASSERTED",
                      closeReceipts: [
                        { runId: "run:recovery-0001", closeReceiptHash: "4".repeat(64), attemptEvidenceHash: null },
                        { runId: "run:recovery-0002", closeReceiptHash: "5".repeat(64), attemptEvidenceHash: "6".repeat(64) },
                      ],
                    },
                  };
    return { ok: true, async json() { return payload; } };
  };
  const client = createM64LoopbackCanaryClient({ gateToken, liveToken, fetchImpl });
  const gatePackage = { operation: "ACTIVATE" };
  await client.gateStatus();
  await client.gatePreflight(gatePackage);
  await client.gateActivate(gatePackage);
  await client.gateClose({ operation: "NORMAL_CLOSE" });
  await client.gateReconcile({ operation: "NORMAL_CLOSE" });
  const gateRecovery = await client.recoverArmedActive();
  await client.livePreflight({ manifestRef: "sealed" });
  await client.liveStart({ manifestRef: "sealed" });
  await client.liveStatus("run:production-client");
  await client.liveClose("run:production-client", "CANARY_COMPLETE");
  const liveRecovery = await client.liveRecoverEpoch({ gateEpochHash: priorEpochHash, purpose });
  assert.equal(gateRecovery.recovery.status, "EMERGENCY_CLOSED");
  assert.equal(liveRecovery.verifiedClosed, 2);
  assert.deepEqual(calls.map((call) => new URL(call.url).pathname), [
    "/control/v1/internal/m6/gate-f/status",
    "/control/v1/internal/m6/gate-f/preflight",
    "/control/v1/internal/m6/gate-f/activate",
    "/control/v1/internal/m6/gate-f/close",
    "/control/v1/internal/m6/gate-f/reconcile",
    "/control/v1/internal/m6/gate-f/recover-armed-active",
    "/control/v1/internal/m6/live/preflight",
    "/control/v1/internal/m6/live/start",
    "/control/v1/internal/m6/live/status",
    "/control/v1/internal/m6/live/close",
    "/control/v1/internal/m6/live/recover-epoch",
  ]);
  assert.equal(new URL(calls[8].url).searchParams.get("runId"), "run:production-client");
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[8].options.method, "GET");
  assert.deepEqual(JSON.parse(calls[5].options.body), {});
  assert.deepEqual(JSON.parse(calls[10].options.body), { gateEpochHash: priorEpochHash, purpose });
  assert.ok(calls.every((call) => call.options.signal instanceof AbortSignal));
  assert.ok(calls.slice(0, 6).every((call) => call.options.headers["x-control-token"] === gateToken));
  assert.ok(calls.slice(6).every((call) => call.options.headers["x-control-token"] === liveToken));
  assert.ok(calls.filter((call) => call.options.body).every((call) => !call.options.body.includes(gateToken)
    && !call.options.body.includes(liveToken)));
});

test("recovery clients reject malformed or secret-bearing success responses and invalid live recovery refs", async () => {
  const gateToken = "staged-canary-gate-token-32-bytes";
  const liveToken = "staged-canary-live-token-32-bytes";
  const gateEpochHash = "7".repeat(64);
  const purpose = "M6_4_ACTION_SMOKE";
  let fetchCount = 0;
  const client = createM64LoopbackCanaryClient({
    gateToken,
    liveToken,
    fetchImpl: async (url) => {
      fetchCount += 1;
      if (new URL(url).pathname.endsWith("/gate-f/recover-armed-active")) {
        return {
          ok: true,
          async json() {
            return {
              recovery: {
                schemaId: "xw.m6-gate-f-armed-active-recovery.v1",
                recovered: false,
                priorEpochHash: gateEpochHash,
                terminalEpochHash: gateEpochHash,
                tripleConsistent: true,
                status: "ALREADY_CLOSED",
              },
              gate: {},
              safetyClosePackage: { signature: "must-not-cross-client-boundary" },
            };
          },
        };
      }
      return {
        ok: true,
        async json() {
          return {
            recovery: {
              schemaId: "xw.m6-live-entry-epoch-recovery.v1",
              status: "RECOVERED",
              gateEpochHash,
              purpose,
              stopNewStarts: true,
              inFlightStartsSettled: 0,
              attempted: 1,
              verifiedClosed: 1,
              activeMatchingRuns: 0,
              controlPlaneOwnedActiveRuns: 0,
              externalResourceState: "NOT_ASSERTED",
              closeReceipts: [{
                runId: "run:recovery-0001",
                closeReceiptHash: "8".repeat(64),
                attemptEvidenceHash: null,
                signature: "must-not-cross-client-boundary",
              }],
            },
          };
        },
      };
    },
  });
  await assert.rejects(() => client.recoverArmedActive(), { code: "M64_GATE_F_RECOVERY_RESPONSE_INVALID" });
  await assert.rejects(() => client.liveRecoverEpoch({ gateEpochHash, purpose }), {
    code: "M64_LIVE_EPOCH_RECOVERY_RESPONSE_INVALID",
  });
  await assert.rejects(() => client.liveRecoverEpoch({ gateEpochHash: "not-a-hash", purpose }), {
    code: "M64_LIVE_EPOCH_RECOVERY_INPUT_INVALID",
  });
  await assert.rejects(() => client.liveRecoverEpoch({ gateEpochHash, purpose: "M6_6_FORBIDDEN" }), {
    code: "M64_LIVE_EPOCH_RECOVERY_INPUT_INVALID",
  });
  await assert.rejects(() => client.recoverArmedActive({ safetyClosePackage: "forbidden" }), {
    code: "M64_GATE_F_RECOVERY_INPUT_INVALID",
  });
  await assert.rejects(() => client.liveRecoverEpoch({ gateEpochHash, purpose, token: "forbidden" }), {
    code: "M64_LIVE_EPOCH_RECOVERY_INPUT_INVALID",
  });
  assert.equal(fetchCount, 2, "invalid recovery refs must fail before fetch or token disclosure");
});

const digest = (value) => createHash("sha256").update(String(value)).digest("hex");
const expectedRunId = (window, scenarioKey) => deriveM6LiveEntryRunId({
  authorizationHash: window.authorization.envelopeHash,
  scenarioKey,
});

function signedWindowAuthorization({ privateKey, manifest, gateEpoch, generation, modelProfileHash, emergencyHash }) {
  const body = {
    schemaId: "xw.m6-4-live-window-authorization.v1",
    authorizationId: `auth-${manifest.purpose.toLowerCase()}-${generation}`,
    issuer: "owner:staged-canary-test",
    keyId: "staged-canary-owner-key",
    allowlistVersion: 1,
    signatureAlgorithm: "ed25519",
    nonce: `staged-canary-${manifest.purpose.toLowerCase()}-${generation}`,
    alias: "01",
    releaseId: "m6-c1-test-release",
    releaseHash: digest("m6-c1-test-release"),
    sourceCommit: "a".repeat(40),
    gateId: "m6-gate",
    gateEpochHash: gateEpoch.epochHash,
    gateGeneration: generation,
    purpose: manifest.purpose,
    scenarioManifestHash: manifest.manifestHash,
    runtimeProfileHash: digest("runtime-profile"),
    modelProfileHash,
    providerHash: digest("provider"),
    toolProfileHash: digest("tools"),
    policyHash: digest("policy"),
    locksHash: digest("locks"),
    environmentAttestationHash: digest("environment"),
    operatorHash: digest("operator"),
    emergencyCloseAuthorizationHash: emergencyHash,
    emergencyCloseReasonCodeAllowlist: ["SAFETY_STOP"],
    closeoutGraceMs: 60 * 60 * 1000,
    effectBoundary: "BOUNDED_READ_TRACE",
    independentOracleHash: digest("independent-oracle"),
    resetObligationsHash: digest("reset-obligations"),
    issuedAt: "2030-01-01T00:00:00.000Z",
    expiresAt: "2030-01-01T01:00:00.000Z",
  };
  const withBodyHash = { ...body, bodyHash: deriveM64LiveWindowAuthorizationBodyHash(body) };
  const withSignature = {
    ...withBodyHash,
    signature: sign(null, canonicalM64LiveWindowAuthorizationSigningBytes(withBodyHash), privateKey).toString("base64"),
  };
  return { ...withSignature, envelopeHash: deriveM64LiveWindowAuthorizationEnvelopeHash(withSignature) };
}

function gateCloseBundle({ window, aggregate = null, emergency, label }) {
  const attempts = aggregate?.attempts ?? [];
  const sealPayload = {
    epochHash: window.authorization.gateEpochHash,
    attempts,
    allowlist: ["01"],
    ...(aggregate ? { cohortAggregate: aggregate } : {}),
  };
  const sealHash = deriveM6AggregateSealHash(sealPayload);
  const aggregateSeal = {
    schemaId: "xw.m6-aggregate-closeout.v1",
    epochHash: window.authorization.gateEpochHash,
    sealPayload,
    sealHash,
    attemptCount: attempts.length,
    aliases: ["01"],
  };
  const reasonCode = emergency ? "SAFETY_STOP" : "NORMAL_COMPLETE";
  const closeoutRaw = {
    closeoutId: `${label}-closeout`,
    epochHash: window.authorization.gateEpochHash,
    actor: "owner:staged-canary-test",
    reason: reasonCode,
    committedAt: "2030-01-01T00:30:00.000Z",
  };
  const closeout = { ...closeoutRaw, closeoutHash: deriveM6CloseoutHash(closeoutRaw) };
  const epochRaw = {
    schemaId: "xw.m6-live-gate.v2",
    gateId: "m6-gate",
    mode: "CLOSED",
    purpose: window.manifest.purpose,
    status: "closed",
    releaseId: window.authorization.releaseId,
    sourceCommit: window.authorization.sourceCommit,
    actor: "owner:staged-canary-test",
    lockSetRef: { id: "m6-c1-locks", sha256: window.authorization.locksHash },
    allowlist: ["01"],
    issuedAt: "2030-01-01T00:30:00.000Z",
    expiresAt: "2030-01-01T02:00:00.000Z",
    parentEpochHash: window.authorization.gateEpochHash,
    closeoutRef: { id: closeout.closeoutId, sha256: closeout.closeoutHash },
    aggregateSealRef: { id: sealHash, sha256: sealHash },
    rollbackTargetEpochHash: null,
    emergencyCloseAuthorizationRef: null,
  };
  const epoch = { ...epochRaw, epochHash: deriveM6V2EpochHash(epochRaw) };
  return {
    schemaId: "xw.m6-4-gate-close-bundle.v1",
    package: {
      authorization: emergency ? null : window.authorization,
      epoch,
      operation: emergency ? "EMERGENCY_CLOSE" : "NORMAL_CLOSE",
      phase: null,
      proof: { schemaId: "xw.m6-gate-proof.test.v1", signature: "offline-test-only" },
      reasonCode,
    },
    cohortAggregate: aggregate,
    aggregateSeal,
    closeout,
  };
}

function expectedOracle({ window, scenario }) {
  const raw = {
    schemaId: "xw.m6-4-independent-expected-state.v1",
    purpose: window.manifest.purpose,
    scenarioKey: scenario.scenarioKey,
    manifestHash: window.manifest.manifestHash,
    primaryFamily: scenario.primaryFamily,
    oracleHash: scenario.oracleHash,
    effectBoundaryHash: scenario.effectBoundaryHash,
    environmentAttestationHash: window.authorization.environmentAttestationHash,
    accountIsolationHash: digest("alias-01-account-isolation"),
    sourceClass: "INDEPENDENT_PRE_DISPATCH",
    selfDerived: false,
    authoredAt: "2029-12-31T23:00:00.000Z",
    expiresAt: "2030-01-01T02:00:00.000Z",
    expectedStateHash: digest(`expected:${scenario.scenarioKey}`),
    independentAuthorHash: digest("independent-author"),
  };
  return { ...raw, expectedArtifactHash: deriveM64ExpectedOracleHash(raw) };
}

function makeResourceProbe({ purpose, gateClosedEpochHash, capturedAt = "2030-01-01T00:40:00.000Z" }) {
  const raw = {
    schemaId: "xw.m6-4-live-resource-probe.v1", purpose, gateClosedEpochHash, capturedAt,
    resourceObservedAt: capturedAt,
    processInventoryHash: digest(`process-inventory:${purpose}`),
    processInventorySha256: digest(`process-inventory-bytes:${purpose}`),
    resourceObservationRequestHash: digest(`resource-request:${purpose}`),
    resourceObserverKeyId: "staged-canary-resource-observer",
    resourceObserverHash: digest("staged-canary-resource-observer"),
    independentOracleArtifactSha256: digest("staged-canary-independent-oracle"),
    activeJobs: 0, activeSessions: 0, activeLeases: 0, pendingApprovals: 0, activeActions: 0,
    activeAuthorizationCount: 0, activeScenarioClaimCount: 0, actionCount: 0, activeDshProcesses: 0,
    activeBrokers: 0, activePipes: 0, orphanProcessRefs: [], rawDeviceIdentityPresent: false, secretMaterialPresent: false,
  };
  return { ...raw, probeHash: deriveM64ResourceProbeHash(raw) };
}

function createFakeCanaryClient(manifests, { failedScenarioKeys = new Set() } = {}) {
  const log = [];
  const runs = new Map();
  const runAuthority = new Map();
  const byHash = new Map(manifests.map((manifest) => [manifest.manifestHash, manifest]));
  let attemptEvidenceFactory = null;
  let gate = { active: false, epochHash: digest("initial-closed"), generation: 0, purpose: null, phase: "CLOSED", mode: "CLOSED" };
  function gateStatus() {
    const activeRuns = [...runs.values()].filter((run) => run.closed !== true).length;
    return {
      schemaId: "xw.m6-gate-f-operations-status.v1",
      mode: gate.mode,
      phase: gate.phase,
      purpose: gate.purpose,
      epochHash: gate.epochHash,
      generation: gate.generation,
      locksHash: digest("locks"),
      tripleConsistent: true,
      errors: [],
      activeAuthorizationCount: gate.active ? 1 : 0,
      actionCount: 0,
      resourceCounts: { jobs: 0, leases: 0, runs: activeRuns, sessions: 0 },
    };
  }
  return {
    log,
    setAttemptEvidenceFactory(factory) { attemptEvidenceFactory = factory; },
    async gateStatus() {
      log.push("gate:status");
      const status = gateStatus();
      log.push(`gate:status:runs:${status.resourceCounts.runs}`);
      return status;
    },
    async gatePreflight(pkg) { log.push(`gate:preflight:${pkg.operation}:${pkg.epoch.purpose}`); return { status: "SEALED_PREFLIGHT", resourceCount: 0 }; },
    async gateActivate(pkg) {
      log.push(`gate:activate:${pkg.epoch.purpose}`);
      gate = { active: true, epochHash: pkg.epoch.epochHash, generation: pkg.authorization.gateGeneration, purpose: pkg.epoch.purpose, phase: pkg.phase, mode: pkg.epoch.mode };
      return { phase: pkg.phase, tripleConsistent: true };
    },
    async gateClose(pkg) {
      log.push(`gate:close:${pkg.operation}:${pkg.epoch.purpose}`);
      gate = { active: false, epochHash: pkg.epoch.epochHash, generation: gate.generation + 1, purpose: pkg.epoch.purpose, phase: "CLOSED", mode: "CLOSED" };
      return { phase: "CLOSED", tripleConsistent: true };
    },
    async gateReconcile(pkg) { log.push(`gate:reconcile:${pkg.operation}:${pkg.epoch.purpose}`); return { phase: gate.phase, tripleConsistent: true }; },
    async livePreflight(body) { log.push(`live:preflight:${body.scenarioKey}`); return { status: "SEALED_PREFLIGHT", resourceCount: 0 }; },
    async liveStart(body) {
      log.push(`live:start:${body.scenarioKey}`);
      const manifest = byHash.get(body.manifestHash);
      const scenario = manifest.scenarios.find((item) => item.scenarioKey === body.scenarioKey);
      const hot = manifest.purpose === "M6_4_HOT_CLOSE";
      const failed = failedScenarioKeys.has(scenario.scenarioKey);
      const run = {
        schemaId: "xw.m6-live-entry-run.v1",
        runId: deriveM6LiveEntryRunId({
          authorizationHash: body.authorizationHash,
          scenarioKey: body.scenarioKey,
        }),
        workerRunRef: `workerrun:${digest(`worker:${body.scenarioKey}`)}`,
        manifestRef: manifest.purpose.toLowerCase(), manifestHash: manifest.manifestHash, scenarioKey: scenario.scenarioKey,
        scenarioClaimHash: digest(`claim:${body.scenarioKey}`), authorizationId: body.authorizationId,
        authorizationHash: body.authorizationHash, bindingHash: digest(`binding:${body.scenarioKey}`),
        status: hot ? "WAITING" : failed ? "FAILED" : "COMPLETED",
        actionCount: hot || failed ? 0 : scenario.actionPlan.maxActionCount,
        closed: false,
      };
      runs.set(run.runId, run);
      runAuthority.set(run.runId, { body, manifest, scenario });
      return { ...run };
    },
    async liveStatus(runId) {
      log.push(`live:status:${runId}`);
      const prior = runs.get(runId);
      if (!prior) throw Object.assign(new Error("run not found"), { code: "M6_LIVE_RUN_NOT_FOUND" });
      return { ...prior };
    },
    async liveClose(runId, reasonCode) {
      log.push(`live:close:${reasonCode}:${runId}`);
      const prior = runs.get(runId);
      if (!prior) throw Object.assign(new Error("run not found"), { code: "M6_LIVE_RUN_NOT_FOUND" });
      const attempt = attemptEvidenceFactory?.({ run: { ...prior }, ...runAuthority.get(runId) });
      const closed = {
        ...prior,
        status: "CLOSED",
        closed: true,
        close: {
          reasonCode,
          brokerClosed: true,
          processClosed: true,
          controlResourcesClosed: true,
          callFenceDrained: true,
          attemptEvidence: attempt,
          attemptEvidenceHash: attempt?.attemptHash ?? null,
          verifiedClosed: true,
        },
      };
      runs.set(runId, closed);
      return { ...closed };
    },
  };
}

function attemptEvidence({ window, scenario, run, expected, overrides = {} }) {
  const rule = JSON.parse(readFileSync(resolve("artifacts/m6-4/cohort-manifests/xw.m6-effect-boundary.v1.json"), "utf8"))
    .families.find((item) => item.primaryFamily === scenario.primaryFamily);
  const hot = window.manifest.purpose === "M6_4_HOT_CLOSE";
  const actionCount = overrides.actionEvidence?.actionCount ?? run.actionCount;
  const counters = {
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
    ...(overrides.oracleEvidence?.counters || {}),
  };
  const actionEvidence = deriveM64ActionEvidence({
    schemaId: M64_LIVE_ACTION_EVIDENCE_SCHEMA_ID,
    actionCount,
    transportCount: overrides.actionEvidence?.transportCount ?? actionCount,
    verifiedActionCount: overrides.actionEvidence?.verifiedActionCount ?? actionCount,
    actionTraceHashes: overrides.actionEvidence?.actionTraceHashes
      ?? Array.from({ length: actionCount }, (_, index) => digest(`trace:${scenario.scenarioKey}:${index}`)),
  });
  const oracleEvidence = deriveM64IndependentEffectObservation({
    schemaId: "xw.m6-4-independent-effect-observation.v1",
    phase: "final",
    sourceClass: "INDEPENDENT_POST_DISPATCH",
    selfDerived: false,
    scenarioKey: scenario.scenarioKey,
    primaryFamily: scenario.primaryFamily,
    oracleHash: scenario.oracleHash,
    effectBoundaryHash: scenario.effectBoundaryHash,
    environmentAttestationHash: expected.environmentAttestationHash,
    accountIsolationHash: expected.accountIsolationHash,
    expectedArtifactHash: expected.expectedArtifactHash,
    independentObserverHash: digest("independent-observer"),
    actualStateHash: expected.expectedStateHash,
    sourceEvidenceHash: digest(`independent-observation:${scenario.scenarioKey}`),
    observedAt: "2030-01-01T00:20:00.000Z",
    observedEffects: [],
    resetResults: Object.fromEntries(rule.resetObligations.map((obligation) => [obligation, true])),
    counters,
    ...(overrides.oracleEvidence || {}),
  });
  const raw = {
    schemaId: M64_LIVE_ATTEMPT_EVIDENCE_SCHEMA_ID,
    purpose: window.manifest.purpose, scenarioKey: scenario.scenarioKey, manifestHash: window.manifest.manifestHash,
    liveAuthorizationHash: window.authorization.envelopeHash, gateEpochHash: window.authorization.gateEpochHash,
    runId: run.runId, bindingHash: run.bindingHash, runStatusBeforeClose: run.status,
    status: hot ? "ABORTED_PENDING_CLOSEOUT" : run.status === "FAILED" ? "FAILED" : "SUCCEEDED",
    expectedArtifactHash: expected.expectedArtifactHash,
    actionEvidence,
    oracleEvidence,
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => !["actionEvidence", "oracleEvidence"].includes(key))),
  };
  return deriveM64AttemptEvidence(raw);
}

async function executeStagedFixture({
  mutateAttempt = ({ evidence }) => evidence,
  mutateResourceProbe = ({ probe }) => probe,
  configureClient = () => {},
  failedScenarioKeys = new Set(),
  capture = {},
} = {}) {
  const manifests = M64_STAGED_CANARY_ORDER.map((purpose) => JSON.parse(readFileSync(
    resolve(`artifacts/m6-4/cohort-manifests/${purpose.toLowerCase()}.json`), "utf8",
  )));
  const boundary = JSON.parse(readFileSync(resolve("artifacts/m6-4/cohort-manifests/xw.m6-effect-boundary.v1.json"), "utf8"));
  const ownerKeys = generateKeyPairSync("ed25519");
  const allowlistDocument = {
    schemaId: M64_LIVE_WINDOW_ISSUER_ALLOWLIST_SCHEMA_ID,
    version: 1,
    keys: [{
      issuer: "owner:staged-canary-test", keyId: "staged-canary-owner-key",
      publicKey: ownerKeys.publicKey.export({ type: "spki", format: "pem" }), status: "active",
    }],
  };
  const allowlist = normalizeM64LiveWindowIssuerAllowlist(allowlistDocument);
  const modelRaw = {
    schemaId: "xw.m6-live-model-profile.v1", status: "QUALIFIED", provider: "deepseek-official",
    model: "deepseek-model-qualified", exactVersion: "owner-qualified-version",
    adapterPackage: "@deepseek-ai/dsh-llm-deepseek", adapterVersion: "0.1.0-rc.8",
    contextWindow: 64_000, maxTokens: 4_096, streamIdleTimeoutMs: 30_000, thinking: "disabled", reasoningEffort: "off",
    credentialRef: "DEEPSEEK_API_KEY", license: "MIT", secretMaterialPresent: false, deploymentSecretInjectionRequired: true,
    adapterIntegrityHash: digest("adapter-integrity"), adapterSourceHash: digest("adapter-source"), licenseHash: digest("license"),
    endpointHash: digest("endpoint"), provenanceHash: digest("provenance"), qualificationHash: digest("qualification"),
    toolCallHealthHash: digest("tool-health"), warmHealthHash: digest("warm-health"), coldHealthHash: digest("cold-health"),
    ttlHealthHash: digest("ttl-health"), secretInjectionAttestationHash: digest("secret-injection"),
    runtimeAttestationHashes: [digest("runtime-attestation")], gateFEligible: true,
  };
  const modelManifest = { ...modelRaw, contentHash: deriveLiveModelProfileHash(modelRaw) };
  const modelProfileHash = modelManifest.contentHash;
  const client = createFakeCanaryClient(manifests, { failedScenarioKeys });
  configureClient(client);
  const windows = [];
  client.setAttemptEvidenceFactory(({ run, manifest, scenario }) => {
    const window = windows.find((candidate) => candidate.manifest.manifestHash === manifest.manifestHash);
    const scenarioIndex = manifest.scenarios.findIndex((candidate) => candidate.scenarioKey === scenario.scenarioKey);
    const evidence = attemptEvidence({ window, scenario, run, expected: window.expectedOracles[scenarioIndex] });
    return mutateAttempt({ evidence, window, scenario, scenarioIndex, run });
  });
  Object.assign(capture, { allowlistDocument, boundary, client, manifests, windows });
  const result = await runM64StagedCanary({
    effectBoundary: boundary,
    client,
    now: () => Date.parse("2030-01-01T00:10:00.000Z"),
    async loadWindow({ purpose, priorClosedStatus }) {
      const manifest = manifests.find((item) => item.purpose === purpose);
      const emergencyHash = digest(`emergency:${purpose}:${priorClosedStatus.generation + 1}`);
      const epochRaw = {
        schemaId: "xw.m6-live-gate.v2", gateId: "m6-gate",
        mode: purpose === "M6_4_SHADOW" ? "OBSERVE_ONLY" : "GROUNDED_ACTION",
        purpose, status: "active", releaseId: "m6-c1-test-release", sourceCommit: "a".repeat(40),
        actor: "owner:staged-canary-test", lockSetRef: { id: "m6-c1-locks", sha256: digest("locks") }, allowlist: ["01"],
        issuedAt: "2030-01-01T00:00:01.000Z", expiresAt: "2030-01-01T01:00:00.000Z",
        parentEpochHash: priorClosedStatus.epochHash, closeoutRef: null, aggregateSealRef: null,
        rollbackTargetEpochHash: null, emergencyCloseAuthorizationRef: { id: `emergency-${purpose}`, sha256: emergencyHash },
      };
      const epoch = { ...epochRaw, epochHash: deriveM6V2EpochHash(epochRaw) };
      const authorization = signedWindowAuthorization({
        privateKey: ownerKeys.privateKey, manifest, gateEpoch: epoch,
        generation: priorClosedStatus.generation + 1, modelProfileHash, emergencyHash,
      });
      const window = {
        manifestRef: purpose.toLowerCase(), manifest, authorization, issuerAllowlist: allowlist,
        runtime: selectM64LiveWindowRuntimeBinding(authorization), modelManifest,
        activationPackage: {
          authorization, epoch, operation: "ACTIVATE", phase: purpose === "M6_4_SHADOW" ? "GROUNDING_ONLY" : "GROUNDED_ACTION",
          proof: { schemaId: "xw.m6-gate-proof.test.v1", signature: "offline-test-only" }, reasonCode: null,
        },
        expectedOracles: [],
        safetyCloseBundle: null,
      };
      window.expectedOracles = manifest.scenarios.map((scenario) => expectedOracle({ window, scenario }));
      window.safetyCloseBundle = gateCloseBundle({ window, emergency: true, label: `safety-${purpose}` });
      windows.push(window);
      return window;
    },
    async resolveCloseBundle({ window, aggregate, emergency }) {
      return gateCloseBundle({ window, aggregate, emergency, label: `expected-${window.manifest.purpose}` });
    },
    async loadResourceProbe({ window, gateClosedStatus }) {
      const probe = makeResourceProbe({ purpose: window.manifest.purpose, gateClosedEpochHash: gateClosedStatus.epochHash });
      return mutateResourceProbe({ probe, window, gateClosedStatus });
    },
    async loadFinalResourceProbe({ finalGateStatus }) {
      return makeResourceProbe({ purpose: "M6_4_FINAL", gateClosedEpochHash: finalGateStatus.epochHash, capturedAt: "2030-01-01T00:41:00.000Z" });
    },
    waitForPoll: async () => {},
  });
  return { boundary, client, manifests, result, windows };
}

test("staged orchestrator runs only exact 5/1/3/20/30 scenarios and seals HOT_CLOSE before live cleanup", async () => {
  const { boundary, client, result, windows } = await executeStagedFixture();
  assert.equal(result.terminalStatus, "M6_4_ACTION_CANARY_CLOSED");
  assert.equal(result.windowResults.length, 5);
  assert.deepEqual(result.windowResults.map((item) => item.attemptEvidence.length), [5, 1, 3, 20, 30]);
  assert.equal(result.windowResults.flatMap((item) => item.attemptEvidence).length, 59);
  assert.equal(new Set(result.windowResults.flatMap((item) => item.attemptEvidence.map((attempt) => attempt.scenarioKey))).size, 59);
  assert.equal(result.windowResults[1].aggregate.attempts[0].transportCount, 0);
  assert.equal(result.windowResults[1].aggregate.attempts[0].actionCount, 0);
  assert.equal(result.windowResults[1].aggregate.attempts[0].status, "ABORTED_PENDING_CLOSEOUT");
  const hotGateClose = client.log.indexOf("gate:close:EMERGENCY_CLOSE:M6_4_HOT_CLOSE");
  const hotLiveClose = client.log.findIndex((entry) => entry === `live:close:SAFETY_STOP:${expectedRunId(windows[1], "m6_4_hot_close-01")}`);
  assert.ok(hotGateClose >= 0 && hotLiveClose > hotGateClose);
  const hotClosedStatuses = client.log
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry, index }) => entry.startsWith("gate:status:runs:") && index > hotGateClose);
  assert.ok(hotClosedStatuses.some(({ entry, index }) => entry === "gate:status:runs:1" && index < hotLiveClose));
  assert.ok(hotClosedStatuses.some(({ entry, index }) => entry === "gate:status:runs:0" && index > hotLiveClose));
  assert.equal(result.windowResults[1].gateClosedStatus.resourceCounts.runs, 0);
  assert.equal(client.log.filter((entry) => entry.startsWith("live:start:")).length, 59);
  assert.equal(client.log.filter((entry) => entry.startsWith("live:close:")).length, 59);
  assert.equal(verifyM64ActionCanaryCompletion({
    receipt: result.receipt, windows, windowResults: result.windowResults, effectBoundary: boundary,
    resourceCloseout: result.resourceCloseout, finalGateStatus: result.finalGateStatus,
    finalResourceProbe: result.finalResourceProbe, nowMs: Date.parse("2030-01-01T00:10:00.000Z"),
  }).ok, true);
});

test("a lost Gate-F close response reconciles the same signed package without rerunning a scenario", async () => {
  let injected = false;
  const { client, result } = await executeStagedFixture({
    configureClient(target) {
      const applyClose = target.gateClose.bind(target);
      target.gateClose = async (pkg) => {
        const promotion = await applyClose(pkg);
        if (!injected && pkg.operation === "NORMAL_CLOSE" && pkg.epoch.purpose === "M6_4_ACTION_SMOKE") {
          injected = true;
          throw Object.assign(new Error("simulated response loss after close commit"), { code: "SIMULATED_GATE_RESPONSE_LOSS" });
        }
        return promotion;
      };
    },
  });
  assert.equal(injected, true);
  assert.equal(result.terminalStatus, "M6_4_ACTION_CANARY_CLOSED");
  assert.equal(client.log.filter((entry) => entry === "gate:reconcile:NORMAL_CLOSE:M6_4_ACTION_SMOKE").length, 1);
  assert.equal(client.log.filter((entry) => entry.startsWith("live:start:")).length, 59);
});

for (const closeCase of [
  { operation: "EMERGENCY_CLOSE", purpose: "M6_4_HOT_CLOSE" },
  { operation: "NORMAL_CLOSE", purpose: "M6_4_ACTION_SMOKE" },
]) {
  test(`a false ${closeCase.operation} success response keeps Gate F potentially active until status proof`, async () => {
    const capture = {};
    let injected = false;
    await assert.rejects(() => executeStagedFixture({
      capture,
      configureClient(target) {
        const applyClose = target.gateClose.bind(target);
        target.gateClose = async (pkg) => {
          if (!injected && pkg.operation === closeCase.operation && pkg.epoch.purpose === closeCase.purpose) {
            injected = true;
            target.log.push(`gate:close:${pkg.operation}:${pkg.epoch.purpose}`);
            return { phase: "CLOSED", tripleConsistent: true };
          }
          return applyClose(pkg);
        };
      },
    }), { code: "M64_CANARY_GATE_NOT_CLOSED" });
    assert.equal(injected, true);
    assert.equal((await capture.client.gateStatus()).phase, "CLOSED");
    assert.equal(
      capture.client.log.filter((entry) => entry === `gate:close:EMERGENCY_CLOSE:${closeCase.purpose}`).length,
      closeCase.operation === "EMERGENCY_CLOSE" ? 2 : 1,
    );
  });
}

test("a committed activation with a malformed success response emergency-closes before any live start", async () => {
  const capture = {};
  await assert.rejects(() => executeStagedFixture({
    capture,
    configureClient(target) {
      const applyActivate = target.gateActivate.bind(target);
      target.gateActivate = async (pkg) => {
        await applyActivate(pkg);
        return { phase: "REBOUND", tripleConsistent: false };
      };
    },
  }), { code: "M64_CANARY_ACTIVATION_FAILED" });
  assert.equal(capture.client.log.filter((entry) => entry.startsWith("live:start:")).length, 0);
  assert.equal(capture.client.log.filter((entry) => entry === "gate:close:EMERGENCY_CLOSE:M6_4_SHADOW").length, 1);
  assert.equal((await capture.client.gateStatus()).phase, "CLOSED");
});

test("a start committed before its delayed response is lost closes the deterministic run and Gate", async () => {
  const capture = {};
  let injected = false;
  await assert.rejects(() => executeStagedFixture({
    capture,
    configureClient(target) {
      const applyStart = target.liveStart.bind(target);
      target.liveStart = async (body) => {
        const committed = await applyStart(body);
        if (!injected) {
          injected = true;
          await Promise.resolve();
          throw Object.assign(new Error("simulated deadline after committed start"), {
            code: "M64_LOOPBACK_REQUEST_TIMEOUT",
            details: { authority: "live-entry", operation: "start", timeoutMs: 25_000 },
          });
        }
        return committed;
      };
    },
  }), { code: "M64_LOOPBACK_REQUEST_TIMEOUT" });
  assert.equal(injected, true);
  const expected = expectedRunId(capture.windows[0], "m6_4_shadow-01");
  assert.ok(capture.client.log.includes(`live:status:${expected}`));
  assert.ok(capture.client.log.includes(`live:close:SAFETY_STOP:${expected}`));
  assert.equal(capture.client.log.filter((entry) => entry === "gate:close:EMERGENCY_CLOSE:M6_4_SHADOW").length, 1);
  const final = await capture.client.gateStatus();
  assert.equal(final.phase, "CLOSED");
  assert.equal(final.resourceCounts.runs, 0);
});

test("a start timeout with deterministic 404 plus CLOSED zero-run fence proves no run committed", async () => {
  const capture = {};
  await assert.rejects(() => executeStagedFixture({
    capture,
    configureClient(target) {
      target.liveStart = async () => {
        throw Object.assign(new Error("simulated start timeout before commit"), {
          code: "M64_LOOPBACK_REQUEST_TIMEOUT",
        });
      };
    },
  }), { code: "M64_LOOPBACK_REQUEST_TIMEOUT" });
  const expected = expectedRunId(capture.windows[0], "m6_4_shadow-01");
  assert.ok(capture.client.log.includes(`live:status:${expected}`));
  assert.equal(capture.client.log.some((entry) => entry === `live:close:SAFETY_STOP:${expected}`), false);
  const final = await capture.client.gateStatus();
  assert.equal(final.phase, "CLOSED");
  assert.equal(final.resourceCounts.runs, 0);
});

test("a lost live-close response reconciles from CLOSED status without rerunning a scenario", async () => {
  let injected = false;
  const { client, result } = await executeStagedFixture({
    configureClient(target) {
      const applyClose = target.liveClose.bind(target);
      target.liveClose = async (...args) => {
        const closed = await applyClose(...args);
        if (!injected) {
          injected = true;
          throw Object.assign(new Error("simulated close response loss"), { code: "M64_LOOPBACK_REQUEST_TIMEOUT" });
        }
        return closed;
      };
    },
  });
  assert.equal(injected, true);
  assert.equal(result.terminalStatus, "M6_4_ACTION_CANARY_CLOSED");
  assert.equal(client.log.filter((entry) => entry.startsWith("live:start:")).length, 59);
  assert.equal(client.log.filter((entry) => entry.startsWith("live:close:")).length, 59);
});

test("a pre-commit live-close timeout retries the same deterministic run within cleanup reconciliation", async () => {
  let attempts = 0;
  const { client, result } = await executeStagedFixture({
    configureClient(target) {
      const applyClose = target.liveClose.bind(target);
      target.liveClose = async (...args) => {
        attempts += 1;
        if (attempts === 1) {
          throw Object.assign(new Error("simulated close request timeout before commit"), { code: "M64_LOOPBACK_REQUEST_TIMEOUT" });
        }
        return applyClose(...args);
      };
    },
  });
  assert.ok(attempts >= 60);
  assert.equal(result.terminalStatus, "M6_4_ACTION_CANARY_CLOSED");
  assert.equal(client.log.filter((entry) => entry.startsWith("live:start:")).length, 59);
  assert.equal(client.log.filter((entry) => entry.startsWith("live:close:")).length, 59);
});

test("an ACTIVE window whose live status never returns times out into emergency close", async () => {
  const capture = {};
  let hung = false;
  await assert.rejects(() => executeStagedFixture({
    capture,
    configureClient(target) {
      const readStatus = target.liveStatus.bind(target);
      target.liveStatus = async (...args) => {
        if (hung) return readStatus(...args);
        hung = true;
        throw Object.assign(new Error("simulated bounded live-status timeout"), {
          code: "M64_LOOPBACK_REQUEST_TIMEOUT",
          details: { authority: "live-entry", operation: "status", timeoutMs: 5_000 },
        });
      };
    },
  }), { code: "M64_LOOPBACK_REQUEST_TIMEOUT" });
  assert.equal(hung, true);
  assert.equal(capture.client.log.filter((entry) => entry === "gate:close:EMERGENCY_CLOSE:M6_4_SHADOW").length, 1);
  assert.equal(capture.client.log.filter((entry) => entry.startsWith("live:close:SAFETY_STOP:")).length, 1);
  assert.equal((await capture.client.gateStatus()).phase, "CLOSED");
});

test("an unverified emergency close is surfaced as an unsafe Gate state, never generic fail-closed", async () => {
  const capture = {};
  await assert.rejects(() => executeStagedFixture({
    capture,
    configureClient(target) {
      const applyActivate = target.gateActivate.bind(target);
      target.gateActivate = async (pkg) => {
        await applyActivate(pkg);
        return { phase: "REBOUND", tripleConsistent: false };
      };
      target.gateClose = async () => {
        throw Object.assign(new Error("simulated emergency-close transport failure"), { code: "SIMULATED_CLOSE_FAILURE" });
      };
      target.gateReconcile = async () => {
        throw Object.assign(new Error("simulated emergency-close reconcile failure"), { code: "SIMULATED_RECONCILE_FAILURE" });
      };
    },
  }), (error) => error.code === "M64_GATE_SAFETY_CLOSE_UNVERIFIED"
    && error.details?.unsafeGateState === true
    && error.details?.actionCount === null);
  assert.equal(capture.client.log.filter((entry) => entry.startsWith("live:start:")).length, 0);
  assert.equal((await capture.client.gateStatus()).phase, "GROUNDING_ONLY");
});

test("an orphan Gate-F resource prevents the first window before activation", async () => {
  const capture = {};
  await assert.rejects(() => executeStagedFixture({
    capture,
    configureClient(target) {
      const readStatus = target.gateStatus.bind(target);
      let injected = false;
      target.gateStatus = async () => {
        const status = await readStatus();
        if (injected) return status;
        injected = true;
        return { ...status, resourceCounts: { ...status.resourceCounts, runs: 1 } };
      };
    },
  }), { code: "M64_CANARY_GATE_NOT_CLOSED" });
  assert.equal(capture.client.log.some((entry) => entry.startsWith("gate:activate:")), false);
  assert.equal(capture.client.log.some((entry) => entry.startsWith("live:start:")), false);
});

test("frozen reliability and smooth failure budgets close at exactly 19/20 and 27/30 without replacement", async () => {
  const failedScenarioKeys = new Set([
    "m6_4_reliability-20",
    "m6_4_smooth-28",
    "m6_4_smooth-29",
    "m6_4_smooth-30",
  ]);
  const { client, result } = await executeStagedFixture({ failedScenarioKeys });
  const reliability = result.windowResults.find((item) => item.window.manifest.purpose === "M6_4_RELIABILITY").aggregate;
  const smooth = result.windowResults.find((item) => item.window.manifest.purpose === "M6_4_SMOOTH").aggregate;
  assert.equal(reliability.attempts.filter((attempt) => attempt.status === "SUCCEEDED").length, 19);
  assert.equal(smooth.attempts.filter((attempt) => attempt.status === "SUCCEEDED").length, 27);
  assert.equal(client.log.filter((entry) => entry.startsWith("live:start:")).length, 59);
  assert.equal(new Set(client.log.filter((entry) => entry.startsWith("live:start:"))).size, 59);
  assert.equal(result.terminalStatus, "M6_4_ACTION_CANARY_CLOSED");
});

test("HOT_CLOSE counter-one evidence aborts immediately, safety-closes Gate F, and never starts a replacement", async () => {
  const capture = {};
  await assert.rejects(() => executeStagedFixture({
    capture,
    mutateAttempt({ evidence, window }) {
      if (window.manifest.purpose !== "M6_4_HOT_CLOSE") return evidence;
      const actionEvidence = deriveM64ActionEvidence({
        schemaId: M64_LIVE_ACTION_EVIDENCE_SCHEMA_ID,
        actionCount: 1,
        transportCount: 1,
        verifiedActionCount: 1,
        actionTraceHashes: [digest("forbidden-hot-close-transport")],
      });
      return deriveM64AttemptEvidence({ ...evidence, actionEvidence });
    },
  }), { code: "M64_CANARY_CRITICAL_EVIDENCE" });
  assert.equal(capture.client.log.filter((entry) => entry.startsWith("live:start:")).length, 6);
  assert.equal(capture.client.log.some((entry) => entry === "live:start:m6_4_action_smoke-01"), false);
  assert.equal(capture.client.log.filter((entry) => entry === "gate:close:EMERGENCY_CLOSE:M6_4_HOT_CLOSE").length, 1);
  const gateClose = capture.client.log.indexOf("gate:close:EMERGENCY_CLOSE:M6_4_HOT_CLOSE");
  const liveClose = capture.client.log.findIndex((entry) => entry === `live:close:SAFETY_STOP:${expectedRunId(capture.windows[1], "m6_4_hot_close-01")}`);
  assert.ok(gateClose >= 0 && liveClose > gateClose);
});

test("first public effect is a hard abort and no later scenario or cohort can run", async () => {
  const capture = {};
  await assert.rejects(() => executeStagedFixture({
    capture,
    mutateAttempt({ evidence, window, scenarioIndex }) {
      if (window.manifest.purpose !== "M6_4_ACTION_SMOKE" || scenarioIndex !== 0) return evidence;
      const oracleEvidence = deriveM64IndependentEffectObservation({
        ...evidence.oracleEvidence,
        counters: { ...evidence.oracleEvidence.counters, publicEffectCount: 1 },
        observedEffects: [{ effectClass: "public", effectHash: digest("public-effect") }],
      });
      return deriveM64AttemptEvidence({ ...evidence, oracleEvidence });
    },
  }), { code: "M64_CANARY_CRITICAL_EVIDENCE" });
  assert.equal(capture.client.log.filter((entry) => entry.startsWith("live:start:")).length, 7);
  assert.equal(capture.client.log.some((entry) => entry === "live:start:m6_4_action_smoke-02"), false);
  assert.equal(capture.client.log.some((entry) => entry === "gate:activate:M6_4_RELIABILITY"), false);
  assert.equal(capture.client.log.filter((entry) => entry === "gate:close:EMERGENCY_CLOSE:M6_4_ACTION_SMOKE").length, 1);
});

test("SUT-safe counters cannot override an independent expected/actual state mismatch", async () => {
  const capture = {};
  await assert.rejects(() => executeStagedFixture({
    capture,
    mutateAttempt({ evidence, window, scenarioIndex }) {
      if (window.manifest.purpose !== "M6_4_ACTION_SMOKE" || scenarioIndex !== 0) return evidence;
      const oracleEvidence = deriveM64IndependentEffectObservation({
        ...evidence.oracleEvidence,
        actualStateHash: digest("sut-reported-success-but-business-state-drifted"),
      });
      return deriveM64AttemptEvidence({ ...evidence, oracleEvidence });
    },
  }), (error) => error.code === "M64_CANARY_CRITICAL_EVIDENCE"
    && error.details.errors.includes("M64_ATTEMPT_EXPECTED_STATE_MISMATCH"));
  assert.equal(capture.client.log.some((entry) => entry === "live:start:m6_4_action_smoke-02"), false);
  assert.equal(capture.client.log.some((entry) => entry === "gate:activate:M6_4_RELIABILITY"), false);
});

test("resource leakage prevents the next cohort even when every scenario result is otherwise safe", async () => {
  const capture = {};
  await assert.rejects(() => executeStagedFixture({
    capture,
    mutateResourceProbe({ probe, window }) {
      if (window.manifest.purpose !== "M6_4_SHADOW") return probe;
      const mutated = { ...probe, activeDshProcesses: 1 };
      return { ...mutated, probeHash: deriveM64ResourceProbeHash(mutated) };
    },
  }), { code: "M64_RESOURCE_CLOSEOUT_INVALID" });
  assert.equal(capture.client.log.filter((entry) => entry.startsWith("live:start:")).length, 5);
  assert.equal(capture.client.log.some((entry) => entry === "gate:activate:M6_4_HOT_CLOSE"), false);
});

test("completion verifier rejects scenario substitution, nonzero final resources, and CLOSED-tail drift", async () => {
  const { boundary, result, windows } = await executeStagedFixture();
  const base = {
    receipt: result.receipt,
    windows,
    windowResults: result.windowResults,
    effectBoundary: boundary,
    resourceCloseout: result.resourceCloseout,
    finalGateStatus: result.finalGateStatus,
    finalResourceProbe: result.finalResourceProbe,
    nowMs: Date.parse("2030-01-01T00:10:00.000Z"),
  };
  const substitutedResults = [...result.windowResults];
  substitutedResults[4] = {
    ...substitutedResults[4],
    attemptEvidence: substitutedResults[4].attemptEvidence.slice(0, -1),
  };
  assert.ok(verifyM64ActionCanaryCompletion({ ...base, windowResults: substitutedResults }).errors.includes("M64_COMPLETION_SCENARIO_SUBSTITUTION"));

  const nonzeroRaw = { ...result.finalResourceProbe, activeJobs: 1 };
  const nonzeroFinal = { ...nonzeroRaw, probeHash: deriveM64ResourceProbeHash(nonzeroRaw) };
  assert.ok(verifyM64ActionCanaryCompletion({ ...base, finalResourceProbe: nonzeroFinal }).errors.includes("M64_RESOURCE_NOT_ZERO"));

  const driftedGate = { ...result.finalGateStatus, epochHash: digest("drifted-closed-tail") };
  assert.ok(verifyM64ActionCanaryCompletion({ ...base, finalGateStatus: driftedGate }).errors.includes("M64_CANARY_GATE_NOT_CLOSED"));
});

test("window inventory loads only explicit absolute paths with exact raw hashes and ordered pre-dispatch oracles", async () => {
  const capture = {};
  const { windows } = await executeStagedFixture({ capture });
  const window = windows[0];
  const root = mkdtempSync(join(tmpdir(), "m64-window-inventory-"));
  const descriptor = (name, value) => {
    const path = join(root, `${name}.json`);
    const bytes = `${JSON.stringify(value, null, 2)}\n`;
    writeFileSync(path, bytes, "utf8");
    return { path, sha256: createHash("sha256").update(bytes).digest("hex") };
  };
  try {
    const files = {
      activationPackage: descriptor("activation", window.activationPackage),
      authorization: descriptor("authorization", window.authorization),
      issuerAllowlist: descriptor("issuer-allowlist", capture.allowlistDocument),
      manifest: descriptor("manifest", window.manifest),
      modelManifest: descriptor("model-manifest", window.modelManifest),
      runtime: descriptor("runtime", window.runtime),
      safetyCloseBundle: descriptor("safety-close", window.safetyCloseBundle),
    };
    const expectedOracles = window.expectedOracles.map((oracle) => ({
      scenarioKey: oracle.scenarioKey,
      artifact: descriptor(`expected-${oracle.scenarioKey}`, oracle),
    }));
    const inventoryRaw = {
      schemaId: "xw.m6-4-canary-window-inventory.v1",
      purpose: window.manifest.purpose,
      manifestRef: window.manifestRef,
      files,
      expectedOracles,
    };
    const inventory = { ...inventoryRaw, inventoryHash: deriveM64CanaryWindowInventoryHash(inventoryRaw) };
    const inventoryDescriptor = descriptor("window-inventory", inventory);
    const loaded = loadM64CanaryWindowInventory(inventoryDescriptor);
    assert.equal(loaded.manifest.manifestHash, window.manifest.manifestHash);
    assert.equal(loaded.authorization.envelopeHash, window.authorization.envelopeHash);
    assert.equal(loaded.expectedOracles.length, 5);
    assert.equal(loaded.inventoryHash, inventory.inventoryHash);

    writeFileSync(files.runtime.path, `${JSON.stringify({ ...window.runtime, providerHash: digest("drift") })}\n`, "utf8");
    assert.throws(() => loadM64CanaryWindowInventory(inventoryDescriptor), { code: "M64_SEALED_ARTIFACT_HASH_MISMATCH" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
