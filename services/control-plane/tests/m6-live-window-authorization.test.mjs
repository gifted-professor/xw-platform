import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  M64_LIVE_WINDOW_RUNTIME_BINDING_FIELDS,
  canonicalM64LiveWindowAuthorizationSigningBytes,
  deriveM64LiveWindowAuthorizationBodyHash,
  deriveM64LiveWindowAuthorizationEnvelopeHash,
  selectM64LiveWindowRuntimeBinding,
} from "../../../packages/kernel/lib/m6-4-live-window-authorization.mjs";
import { canonicalJson, sha256 } from "../control-plane/lib/canonical.mjs";
import {
  M64_LIVE_WINDOW_ISSUER_ALLOWLIST_SCHEMA_ID,
  normalizeM64LiveWindowIssuerAllowlist,
  verifyM64LiveWindowAuthorization,
} from "../control-plane/lib/m6-live-window-authorization.mjs";
import {
  deriveM6GateFSafetyClosePackageHash,
  deriveM6GateFSafetyCloseProofHash,
} from "../control-plane/lib/m6-gate-safety-close-arm.mjs";
import { StateStore } from "../control-plane/lib/state-store.mjs";

const NOW = Date.parse("2030-01-01T00:10:00.000Z");
const H = (character) => character.repeat(64);

function baseBody(overrides = {}) {
  return {
    schemaId: "xw.m6-4-live-window-authorization.v1",
    authorizationId: "m64-live-auth-test-0001",
    issuer: "owner:codex-thread-user",
    keyId: "owner-key-1",
    allowlistVersion: 1,
    signatureAlgorithm: "ed25519",
    nonce: "m64-live-nonce-00000001",
    alias: "01",
    releaseId: "m64-release-test",
    releaseHash: H("1"),
    sourceCommit: "a".repeat(40),
    gateId: "m6-gate",
    gateEpochHash: H("2"),
    gateGeneration: 1,
    purpose: "M6_4_ACTION_SMOKE",
    scenarioManifestHash: H("3"),
    runtimeProfileHash: H("4"),
    modelProfileHash: H("5"),
    providerHash: H("6"),
    toolProfileHash: H("7"),
    policyHash: H("8"),
    locksHash: H("9"),
    environmentAttestationHash: H("a"),
    operatorHash: H("b"),
    emergencyCloseAuthorizationHash: H("c"),
    emergencyCloseReasonCodeAllowlist: ["SAFETY_STOP", "OPERATOR_STOP"],
    closeoutGraceMs: 30 * 60 * 1000,
    effectBoundary: "BOUNDED_READ_TRACE",
    independentOracleHash: H("d"),
    resetObligationsHash: H("e"),
    issuedAt: "2030-01-01T00:00:00.000Z",
    expiresAt: "2030-01-01T00:30:00.000Z",
    ...overrides,
  };
}

function signedAuthorization(body, privateKey) {
  const withBodyHash = { ...body, bodyHash: deriveM64LiveWindowAuthorizationBodyHash(body) };
  const withSignature = {
    ...withBodyHash,
    signature: sign(null, canonicalM64LiveWindowAuthorizationSigningBytes(withBodyHash), privateKey).toString("base64"),
  };
  return { ...withSignature, envelopeHash: deriveM64LiveWindowAuthorizationEnvelopeHash(withSignature) };
}

function fixture() {
  const owner = generateKeyPairSync("ed25519");
  const attacker = generateKeyPairSync("ed25519");
  const allowlistRaw = {
    schemaId: M64_LIVE_WINDOW_ISSUER_ALLOWLIST_SCHEMA_ID,
    version: 1,
    keys: [{
      issuer: "owner:codex-thread-user",
      keyId: "owner-key-1",
      publicKey: owner.publicKey.export({ type: "spki", format: "pem" }),
      status: "active",
    }],
  };
  const authorization = signedAuthorization(baseBody(), owner.privateKey);
  return {
    owner,
    attacker,
    allowlistRaw,
    allowlist: normalizeM64LiveWindowIssuerAllowlist(allowlistRaw),
    authorization,
    runtime: selectM64LiveWindowRuntimeBinding(authorization),
  };
}

function closedSeed() {
  const raw = {
    schemaId: "xw.m6-live-gate.v1",
    gateId: "m6-gate",
    mode: "CLOSED",
    status: "closed",
    releaseId: "m64-release-test",
    sourceCommit: "a".repeat(40),
    actor: "operator:test",
    lockHashes: { runtimeProfile: H("1"), hardRedlinePolicy: H("2"), groundingRuntime: H("3") },
    allowlist: ["01"],
    issuedAt: "2030-01-01T00:00:00.000Z",
    expiresAt: "2030-01-01T02:00:00.000Z",
    parentEpochHash: null,
    closeoutRef: { id: "seed-closeout", sha256: H("4") },
    aggregateSealRef: { id: "seed-aggregate", sha256: H("5") },
    rollbackTargetEpochHash: null,
  };
  return { ...raw, epochHash: sha256(`xw.m6-live-gate.v1:${canonicalJson(raw)}`) };
}

function openSeededFence(dbPath) {
  const state = new StateStore({ dbPath, now: () => NOW });
  const seed = closedSeed();
  state.seedM6GateFence({ epoch: seed, locksHash: H("f") });
  return { state, seed };
}

function activeFence(runtime, expiresAt = "2030-01-01T01:00:00.000Z") {
  return {
    gateId: runtime.gateId,
    epochHash: runtime.gateEpochHash,
    mode: "GROUNDED_ACTION",
    purpose: runtime.purpose,
    allowlist: [runtime.alias],
    expiresAt,
    releaseId: runtime.releaseId,
    sourceCommit: runtime.sourceCommit,
    locksHash: runtime.locksHash,
  };
}

function safetyCloseArm(runtime) {
  const proof = {
    algorithm: "ed25519",
    allowlistVersion: 1,
    keyId: "gate-key-1",
    signature: "activation-verified-signature",
    subject: "operator:test",
  };
  const closeEpochHash = H("6");
  const packageValue = {
    authorization: null,
    epoch: { epochHash: closeEpochHash, parentEpochHash: runtime.gateEpochHash },
    operation: "EMERGENCY_CLOSE",
    phase: null,
    proof,
    reasonCode: "SAFETY_STOP",
  };
  return {
    packageValue,
    arm: {
      schemaId: "xw.m6-gate-safety-close-arm.v1",
      gateId: runtime.gateId,
      purpose: runtime.purpose,
      activeEpochHash: runtime.gateEpochHash,
      closeEpochHash,
      packageHash: deriveM6GateFSafetyClosePackageHash(packageValue),
      activationProofHash: H("7"),
      proofHash: deriveM6GateFSafetyCloseProofHash(proof),
      reasonCode: packageValue.reasonCode,
      expiresAtMs: Date.parse("2030-01-01T00:45:00.000Z"),
      authorizationExpiresAtMs: Date.parse("2030-01-01T00:45:00.000Z"),
      packageExpiresAtMs: Date.parse("2030-01-01T01:00:00.000Z"),
      package: packageValue,
    },
  };
}

function changedRuntimeValue(field, value) {
  if (Array.isArray(value)) return [...value, "SECOND_REASON"];
  if (typeof value === "number") return value + 1;
  if (field === "alias") return "02";
  if (field === "sourceCommit") return "b".repeat(40);
  if (field === "purpose") return "M6_4_RELIABILITY";
  if (field === "effectBoundary") return "UNBOUNDED";
  if (/Hash$/.test(field)) return value === H("f") ? H("0") : H("f");
  return `${value}-changed`;
}

function runConsumeWorker({ dbPath, authorizationPath, allowlistPath, runtimePath }) {
  const workerPath = fileURLToPath(new URL("./fixtures/m6-live-window-auth-consume-worker.mjs", import.meta.url));
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [workerPath, dbPath, authorizationPath, allowlistPath, runtimePath, String(NOW)], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", () => {
      try { resolveResult(JSON.parse(stdout.trim())); } catch { reject(new Error(`worker output invalid: ${stdout} ${stderr}`)); }
    });
  });
}

test("canonical live-window signing/body/envelope hashes reproduce independent of object key order", () => {
  const f = fixture();
  const reversed = Object.fromEntries(Object.entries(f.authorization).reverse());
  assert.equal(deriveM64LiveWindowAuthorizationBodyHash(reversed), f.authorization.bodyHash);
  assert.equal(deriveM64LiveWindowAuthorizationEnvelopeHash(reversed), f.authorization.envelopeHash);
  const verified = verifyM64LiveWindowAuthorization({
    authorization: reversed,
    issuerAllowlist: f.allowlist,
    runtime: f.runtime,
    nowMs: NOW,
  });
  assert.equal(verified.envelopeHash, f.authorization.envelopeHash);
  assert.equal(f.authorization.sourceCommit.length, 40);
});

test("verifier binds every exact runtime value and rejects H64 Git commits", () => {
  const f = fixture();
  for (const field of M64_LIVE_WINDOW_RUNTIME_BINDING_FIELDS) {
    const runtime = { ...f.runtime, [field]: changedRuntimeValue(field, f.runtime[field]) };
    assert.throws(() => verifyM64LiveWindowAuthorization({
      authorization: f.authorization,
      issuerAllowlist: f.allowlist,
      runtime,
      nowMs: NOW,
    }), { code: "M64_LIVE_AUTH_RUNTIME_BINDING_MISMATCH" }, field);
  }
  const badBody = baseBody({ sourceCommit: "a".repeat(64) });
  const h64 = signedAuthorization(badBody, f.owner.privateKey);
  assert.throws(() => verifyM64LiveWindowAuthorization({
    authorization: h64,
    issuerAllowlist: f.allowlist,
    runtime: selectM64LiveWindowRuntimeBinding(h64),
    nowMs: NOW,
  }), { code: "M64_LIVE_AUTH_SCHEMA_INVALID" });
});

test("unsigned, wrong-key, revoked, altered, self-issued, and signature-mutated envelopes fail closed", () => {
  const f = fixture();
  assert.throws(() => normalizeM64LiveWindowIssuerAllowlist({
    ...f.allowlistRaw,
    keys: [{
      ...f.allowlistRaw.keys[0],
      publicKey: f.owner.privateKey.export({ type: "pkcs8", format: "pem" }),
    }],
  }), { code: "M64_LIVE_AUTH_ISSUER_KEY_INVALID" });
  assert.throws(() => verifyM64LiveWindowAuthorization({
    authorization: f.authorization,
    issuerAllowlist: { ...f.allowlist, keys: new Map(f.allowlist.keys) },
    runtime: f.runtime,
    nowMs: NOW,
  }), { code: "M64_LIVE_AUTH_ALLOWLIST_MALFORMED" });
  const unsigned = { ...f.authorization };
  delete unsigned.signature;
  assert.throws(() => verifyM64LiveWindowAuthorization({ authorization: unsigned, issuerAllowlist: f.allowlist, runtime: f.runtime, nowMs: NOW }), {
    code: "M64_LIVE_AUTH_SCHEMA_INVALID",
  });

  const wrongKey = signedAuthorization(baseBody(), f.attacker.privateKey);
  assert.throws(() => verifyM64LiveWindowAuthorization({ authorization: wrongKey, issuerAllowlist: f.allowlist, runtime: f.runtime, nowMs: NOW }), {
    code: "M64_LIVE_AUTH_SIGNATURE_INVALID",
  });

  const revoked = normalizeM64LiveWindowIssuerAllowlist({
    ...f.allowlistRaw,
    keys: [{ ...f.allowlistRaw.keys[0], status: "revoked" }],
  });
  assert.throws(() => verifyM64LiveWindowAuthorization({ authorization: f.authorization, issuerAllowlist: revoked, runtime: f.runtime, nowMs: NOW }), {
    code: "M64_LIVE_AUTH_ISSUER_REVOKED",
  });

  assert.throws(() => verifyM64LiveWindowAuthorization({
    authorization: { ...f.authorization, releaseHash: H("f") },
    issuerAllowlist: f.allowlist,
    runtime: f.runtime,
    nowMs: NOW,
  }), { code: "M64_LIVE_AUTH_BODY_HASH_INVALID" });

  const selfIssued = signedAuthorization(baseBody({ issuer: "owner:attacker", keyId: "attacker-key" }), f.attacker.privateKey);
  f.allowlist.keys.set("attacker-key", {
    issuer: "owner:attacker",
    keyId: "attacker-key",
    publicKey: f.attacker.publicKey,
    status: "active",
    notBefore: null,
    expiresAt: null,
  });
  assert.throws(() => verifyM64LiveWindowAuthorization({
    authorization: selfIssued,
    issuerAllowlist: f.allowlist,
    runtime: selectM64LiveWindowRuntimeBinding(selfIssued),
    nowMs: NOW,
  }), { code: "M64_LIVE_AUTH_ISSUER_UNKNOWN" });

  const signatureBytes = Buffer.from(f.authorization.signature, "base64");
  signatureBytes[0] ^= 0xff;
  const mutatedSignature = { ...f.authorization, signature: signatureBytes.toString("base64") };
  mutatedSignature.envelopeHash = deriveM64LiveWindowAuthorizationEnvelopeHash(mutatedSignature);
  assert.throws(() => verifyM64LiveWindowAuthorization({
    authorization: mutatedSignature,
    issuerAllowlist: f.allowlist,
    runtime: f.runtime,
    nowMs: NOW,
  }), { code: "M64_LIVE_AUTH_SIGNATURE_INVALID" });
});

test("future, expired, and inactive-owner windows reject before durable consumption", () => {
  const f = fixture();
  const future = signedAuthorization(baseBody({
    issuedAt: "2030-01-01T00:11:00.000Z",
    expiresAt: "2030-01-01T00:31:00.000Z",
  }), f.owner.privateKey);
  assert.throws(() => verifyM64LiveWindowAuthorization({ authorization: future, issuerAllowlist: f.allowlist, runtime: selectM64LiveWindowRuntimeBinding(future), nowMs: NOW }), {
    code: "M64_LIVE_AUTH_NOT_YET_VALID",
  });
  const expired = signedAuthorization(baseBody({
    issuedAt: "2029-12-31T23:00:00.000Z",
    expiresAt: "2030-01-01T00:10:00.000Z",
  }), f.owner.privateKey);
  assert.throws(() => verifyM64LiveWindowAuthorization({ authorization: expired, issuerAllowlist: f.allowlist, runtime: selectM64LiveWindowRuntimeBinding(expired), nowMs: NOW }), {
    code: "M64_LIVE_AUTH_EXPIRED",
  });
  const inactive = normalizeM64LiveWindowIssuerAllowlist({
    ...f.allowlistRaw,
    keys: [{ ...f.allowlistRaw.keys[0], notBefore: "2030-01-01T00:11:00.000Z" }],
  });
  assert.throws(() => verifyM64LiveWindowAuthorization({ authorization: f.authorization, issuerAllowlist: inactive, runtime: f.runtime, nowMs: NOW }), {
    code: "M64_LIVE_AUTH_ISSUER_INACTIVE",
  });
});

test("v20 consumes owner authorization only inside the gate-fence promotion transaction", () => {
  const root = mkdtempSync(join(tmpdir(), "m64-live-auth-state-"));
  const dbPath = join(root, "control.db");
  const f = fixture();
  const opened = openSeededFence(dbPath);
  let state = opened.state;
  try {
    const brandedVerification = verifyM64LiveWindowAuthorization({
      authorization: f.authorization,
      issuerAllowlist: f.allowlist,
      runtime: f.runtime,
      nowMs: NOW,
    });
    assert.throws(() => state.promoteM6GateFence({
      expectedEpochHash: opened.seed.epochHash,
      expectedGeneration: 0,
      next: activeFence(f.runtime),
      liveWindowAuthorizationConsumption: {
        authorization: f.authorization,
        verification: { ...brandedVerification },
      },
    }), { code: "M64_LIVE_AUTH_UNVERIFIED" });
    assert.equal(state.db.prepare("SELECT COUNT(*) AS count FROM m6_live_window_authorization_consumptions").get().count, 0);
    assert.equal(state.getM6GateFence().generation, 0);
    const promoted = state.promoteM6GateFence({
      expectedEpochHash: opened.seed.epochHash,
      expectedGeneration: 0,
      next: activeFence(f.runtime),
      liveWindowAuthorizationConsumption: { authorization: f.authorization, verification: brandedVerification },
    });
    const receipt = state.getM64LiveWindowAuthorizationConsumption(f.authorization.authorizationId);
    assert.equal(promoted.generation, 1);
    assert.equal(receipt.gateGeneration, 1);
    assert.equal(state.getM64LiveWindowAuthorizationConsumption(f.authorization.authorizationId).consumptionHash, receipt.consumptionHash);
    assert.equal(typeof state.consumeM64LiveWindowAuthorization, "undefined");
    state.close();
    state = new StateStore({ dbPath, now: () => NOW });
    const current = state.getM6GateFence();
    assert.throws(() => state.promoteM6GateFence({
      expectedEpochHash: current.epochHash,
      expectedGeneration: current.generation,
      next: { ...current, epochHash: H("f"), generation: undefined, expiresAt: "2030-01-01T01:30:00.000Z" },
      liveWindowAuthorizationConsumption: {
        authorization: f.authorization,
        verification: verifyM64LiveWindowAuthorization({
          authorization: f.authorization,
          issuerAllowlist: f.allowlist,
          runtime: f.runtime,
          nowMs: NOW,
        }),
      },
    }), { code: "M64_LIVE_AUTH_GENERATION_CAS_MISMATCH" });
    assert.equal(state.db.prepare("PRAGMA user_version").get().user_version, 20);
  } finally {
    try { state.close(); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});

test("v20 atomically terminalizes every armed close and exact-consume cannot be substituted", () => {
  const root = mkdtempSync(join(tmpdir(), "m64-safety-close-terminal-"));
  const dbPath = join(root, "control.db");
  const f = fixture();
  const opened = openSeededFence(dbPath);
  const state = opened.state;
  try {
    const verification = verifyM64LiveWindowAuthorization({
      authorization: f.authorization,
      issuerAllowlist: f.allowlist,
      runtime: f.runtime,
      nowMs: NOW,
    });
    const safety = safetyCloseArm(f.runtime);
    state.promoteM6GateFence({
      expectedEpochHash: opened.seed.epochHash,
      expectedGeneration: 0,
      next: activeFence(f.runtime),
      liveWindowAuthorizationConsumption: { authorization: f.authorization, verification },
      safetyCloseArm: safety.arm,
    });
    const closeFence = (epochHash) => ({
      ...activeFence(f.runtime),
      epochHash,
      mode: "CLOSED",
    });
    const emergencyCloseConsumption = {
      nonce: "safety-close-emergency-nonce-0001",
      authorizationHash: f.authorization.emergencyCloseAuthorizationHash,
      reasonCode: safety.packageValue.reasonCode,
    };
    const terminalization = {
      activeEpochHash: f.runtime.gateEpochHash,
      armCloseEpochHash: safety.arm.closeEpochHash,
      packageHash: safety.arm.packageHash,
      terminalEpochHash: safety.arm.closeEpochHash,
      terminalProofHash: null,
      status: "CONSUMED",
    };

    assert.throws(() => state.promoteM6GateFence({
      expectedEpochHash: f.runtime.gateEpochHash,
      expectedGeneration: 1,
      next: closeFence(H("8")),
    }), { code: "M6_GATE_SAFETY_CLOSE_TERMINAL_REQUIRED" });
    assert.throws(() => state.promoteM6GateFence({
      expectedEpochHash: f.runtime.gateEpochHash,
      expectedGeneration: 1,
      next: closeFence(safety.arm.closeEpochHash),
      safetyCloseArmTerminalization: terminalization,
    }), { code: "M6_GATE_SAFETY_CLOSE_TERMINAL_INVALID" });
    assert.throws(() => state.promoteM6GateFence({
      expectedEpochHash: f.runtime.gateEpochHash,
      expectedGeneration: 1,
      next: closeFence(H("8")),
      emergencyCloseConsumption,
      safetyCloseArmTerminalization: terminalization,
    }), { code: "M6_GATE_SAFETY_CLOSE_TERMINAL_INVALID" });
    assert.throws(() => state.promoteM6GateFence({
      expectedEpochHash: f.runtime.gateEpochHash,
      expectedGeneration: 1,
      next: closeFence(H("8")),
      emergencyCloseConsumption,
      safetyCloseArmTerminalization: { ...terminalization, status: "RELEASED", terminalEpochHash: H("8") },
    }), { code: "M6_GATE_SAFETY_CLOSE_TERMINAL_INVALID" });
    assert.equal(state.getM6GateFence().generation, 1);
    assert.equal(state.getM6GateSafetyCloseArm(f.runtime.gateEpochHash).status, "ARMED");
    assert.equal(state.getM6EmergencyCloseConsumption(emergencyCloseConsumption.nonce), null);

    const closed = state.promoteM6GateFence({
      expectedEpochHash: f.runtime.gateEpochHash,
      expectedGeneration: 1,
      next: closeFence(safety.arm.closeEpochHash),
      emergencyCloseConsumption,
      safetyCloseArmTerminalization: terminalization,
    });
    assert.equal(closed.mode, "CLOSED");
    assert.equal(closed.epochHash, safety.arm.closeEpochHash);
    assert.equal(state.getM6GateSafetyCloseArm(f.runtime.gateEpochHash).status, "CONSUMED");
    assert.equal(state.getM6GateSafetyCloseArm(f.runtime.gateEpochHash).terminalEpochHash, safety.arm.closeEpochHash);
    assert.equal(state.getM6GateSafetyCloseArm(f.runtime.gateEpochHash).terminalProofHash, null);
    assert.equal(state.getM6EmergencyCloseConsumption(emergencyCloseConsumption.nonce).reasonCode, "SAFETY_STOP");
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("v20 durably claims each frozen live scenario once before resource creation", () => {
  const root = mkdtempSync(join(tmpdir(), "m64-live-scenario-claim-"));
  const dbPath = join(root, "control.db");
  const f = fixture();
  const opened = openSeededFence(dbPath);
  let state = opened.state;
  try {
    const verification = verifyM64LiveWindowAuthorization({
      authorization: f.authorization,
      issuerAllowlist: f.allowlist,
      runtime: f.runtime,
      nowMs: NOW,
    });
    state.promoteM6GateFence({
      expectedEpochHash: opened.seed.epochHash,
      expectedGeneration: 0,
      next: activeFence(f.runtime),
      liveWindowAuthorizationConsumption: { authorization: f.authorization, verification },
    });
    assert.throws(() => state.claimM64LiveScenarioStart({
      verification: { ...verification },
      scenarioKey: "m6_4_action_smoke-01",
    }), { code: "M6_LIVE_SCENARIO_AUTH_UNVERIFIED" });
    assert.throws(() => state.claimM64LiveScenarioStart({
      verification,
      scenarioKey: "m6_4_reliability-01",
    }), { code: "M6_LIVE_SCENARIO_BINDING_MISMATCH" });
    const claimed = state.claimM64LiveScenarioStart({
      verification,
      scenarioKey: "m6_4_action_smoke-01",
    });
    assert.equal(claimed.status, "STARTED");
    assert.equal(claimed.manifestHash, f.authorization.scenarioManifestHash);
    assert.throws(() => state.claimM64LiveScenarioStart({
      verification,
      scenarioKey: "m6_4_action_smoke-01",
    }), { code: "M6_LIVE_SCENARIO_ALREADY_CLAIMED" });
    const finalized = state.finalizeM64LiveScenarioClaim({
      claimHash: claimed.claimHash,
      outcome: "SUCCEEDED",
      actionCount: 2,
      transportCount: 2,
      attemptEvidenceHash: H("1"),
      oracleObservationHash: H("2"),
      resetReceiptHash: H("3"),
      closeReceiptHash: H("4"),
    });
    assert.equal(finalized.status, "FINALIZED");
    assert.equal(finalized.result.actionCount, 2);
    assert.throws(() => state.finalizeM64LiveScenarioClaim({
      claimHash: claimed.claimHash,
      outcome: "SUCCEEDED",
      actionCount: 2,
      transportCount: 2,
      attemptEvidenceHash: H("1"),
      oracleObservationHash: H("2"),
      resetReceiptHash: H("3"),
      closeReceiptHash: H("4"),
    }), { code: "M6_LIVE_SCENARIO_FINALIZE_REPLAY" });
    state.close();
    state = new StateStore({ dbPath, now: () => NOW });
    assert.equal(state.listM64LiveScenarioClaims(f.authorization.authorizationId).length, 1);
    assert.equal(state.getM64LiveScenarioClaim(claimed.claimHash).result.resultHash, finalized.result.resultHash);
  } finally {
    try { state.close(); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});

test("two reopened processes racing one v20 authorization produce one atomic promotion", async () => {
  const root = mkdtempSync(join(tmpdir(), "m64-live-auth-race-"));
  const dbPath = join(root, "control.db");
  const authorizationPath = join(root, "authorization.json");
  const allowlistPath = join(root, "allowlist.json");
  const runtimePath = join(root, "runtime.json");
  const f = fixture();
  openSeededFence(dbPath).state.close();
  writeFileSync(authorizationPath, JSON.stringify(f.authorization));
  writeFileSync(allowlistPath, JSON.stringify(f.allowlistRaw));
  writeFileSync(runtimePath, JSON.stringify(f.runtime));
  try {
    const results = await Promise.all([
      runConsumeWorker({ dbPath, authorizationPath, allowlistPath, runtimePath }),
      runConsumeWorker({ dbPath, authorizationPath, allowlistPath, runtimePath }),
    ]);
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.ok(["M6_GATE_FENCE_CAS_MISMATCH", "M64_LIVE_AUTH_GENERATION_CAS_MISMATCH"].includes(results.find((result) => !result.ok)?.code));
    const reopened = new StateStore({ dbPath, now: () => NOW });
    try {
      assert.equal(reopened.db.prepare("SELECT COUNT(*) AS count FROM m6_live_window_authorization_consumptions").get().count, 1);
    } finally { reopened.close(); }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("user_version 19 migrates to v20 and adds the durable normal-close proof column", () => {
  const root = mkdtempSync(join(tmpdir(), "m64-live-auth-migration-"));
  const dbPath = join(root, "control.db");
  let state = new StateStore({ dbPath, now: () => NOW });
  state.db.exec("ALTER TABLE m6_gate_safety_close_arms DROP COLUMN terminal_proof_hash");
  state.db.exec("PRAGMA user_version = 19");
  state.close();
  state = new StateStore({ dbPath, now: () => NOW });
  try {
    assert.equal(state.db.prepare("PRAGMA user_version").get().user_version, 20);
    assert.equal(state.db.prepare("SELECT COUNT(*) AS count FROM m6_live_window_authorization_consumptions").get().count, 0);
    assert.equal(state.db.prepare("SELECT COUNT(*) AS count FROM m6_gate_safety_close_arms").get().count, 0);
    assert.ok(state.db.prepare("PRAGMA table_info(m6_gate_safety_close_arms)").all()
      .some((column) => column.name === "terminal_proof_hash"));
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});
