import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  deriveM6FrameCloseoutHash,
  deriveM6CaptureReceiptSha256,
  deriveM6ResourceSnapshotSha256,
  deriveM6ScenarioManifestSha256,
  MATRIX_SIZE,
  verifyAggregateCloseout,
} from "../../../packages/kernel/lib/m6-aggregate-closeout.mjs";
import { deriveFrameId, deriveFrameManifestSha256 } from "../../../packages/kernel/lib/m6-screen-frame.mjs";
import { writeImmutableJson } from "../control-plane/lib/m6-gate-loader.mjs";
import { activateGate, buildEpochRecord, mintEpoch, signEpochProof } from "../control-plane/lib/m6-epoch.mjs";
import { M6_GATE_ISSUER_ALLOWLIST_SCHEMA_ID } from "../control-plane/lib/m6-issuer-allowlist.mjs";

const xwPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages", "cli", "xw.mjs");
const HEX40 = "a".repeat(40);
const LOCKS = { runtimeProfile: "11".repeat(32), hardRedlinePolicy: "22".repeat(32), groundingRuntime: "33".repeat(32) };
const ALIASES = ["01", "02", "03", "04"];
const EPOCH_HASH = "ff".repeat(32);
const COMMITTED = "2026-08-22T00:00:00.000Z";
const epoch = { epochHash: EPOCH_HASH, allowlist: ALIASES };

function oracle(epochHash = EPOCH_HASH) {
  const scenarios = [];
  for (const alias of ALIASES) {
    for (let ordinal = 1; ordinal <= 20; ordinal += 1) {
      const stable = ordinal < 20;
      scenarios.push({
        scenarioId: `observe-${alias}-${String(ordinal).padStart(2, "0")}`,
        alias,
        ordinal,
        expectedStatus: stable ? "accepted" : "rejected",
        expectedStability: stable ? "stable" : "unstable",
        zeroAction: true,
      });
    }
  }
  const raw = { schemaId: "xw.m6-scenario-manifest.v1", epochHash, runsPerAlias: 20, scenarios };
  return { ...raw, manifestSha256: deriveM6ScenarioManifestSha256(raw) };
}

function resourceSnapshot(epochHash = EPOCH_HASH) {
  const raw = {
    schemaId: "xw.m6-resource-snapshot.v1",
    epochHash,
    before: { activeJobs: 0, activeSessions: 0, activeLeases: 0 },
    after: { activeJobs: 0, activeSessions: 0, activeLeases: 0 },
    actionCount: 0,
  };
  return { ...raw, snapshotSha256: deriveM6ResourceSnapshotSha256(raw) };
}

function matrixAttempts(manifest = oracle()) {
  return manifest.scenarios.map((scenario) => {
    const attemptId = `att-${scenario.scenarioId}`;
    const accepted = scenario.expectedStatus === "accepted";
    let frame = null;
    if (accepted) {
      frame = {
        schemaId: "xw.screen-frame.v1",
        mode: "live_strict",
        observationRef: { id: `observation-${scenario.scenarioId}`, sha256: "01".repeat(32) },
        screenshotARef: { id: `screen-a-${scenario.scenarioId}`, sha256: "02".repeat(32) },
        screenshotBRef: { id: `screen-b-${scenario.scenarioId}`, sha256: "03".repeat(32) },
        dumpRef: { id: `dump-${scenario.scenarioId}`, sha256: "04".repeat(32) },
        focusRef: { id: `focus-${scenario.scenarioId}`, sha256: "05".repeat(32) },
        screenshotASha256: "02".repeat(32),
        screenshotBSha256: "03".repeat(32),
        width: 1080,
        height: 2400,
        orientation: "portrait",
        density: 440,
        capturedAt: COMMITTED,
        expiresAt: "2026-08-22T00:00:05.000Z",
        linkage: { sessionId: `session-${scenario.scenarioId}`, leaseRef: `lease-${scenario.scenarioId}`, alias: scenario.alias, appId: "com.example" },
        stability: { verdict: "stable", pageFingerprint: "06".repeat(32), focusFingerprint: "07".repeat(32) },
        flags: { partial: false, missing: false },
      };
      frame.manifestSha256 = deriveFrameManifestSha256(frame);
      frame.frameId = deriveFrameId(frame.manifestSha256);
    }
    const receipt = {
      attemptId,
      runId: `run-${scenario.scenarioId}`,
      jobId: `job-${scenario.scenarioId}`,
      sessionId: `session-${scenario.scenarioId}`,
      leaseRef: `lease-${scenario.scenarioId}`,
      alias: scenario.alias,
      scenarioLabel: scenario.scenarioId,
      epochHash: manifest.epochHash,
      status: scenario.expectedStatus,
      frameRef: accepted ? { id: frame.frameId, sha256: frame.manifestSha256 } : null,
      errorCodes: accepted ? [] : ["M6_FRAME_FOCUS_PAIR_UNSTABLE"],
      receiptSha256: "",
    };
    receipt.receiptSha256 = deriveM6CaptureReceiptSha256(receipt);
    const closeoutFields = {
      closeoutId: `closeout-${scenario.scenarioId}`,
      attemptId,
      epochHash: manifest.epochHash,
      runId: receipt.runId,
      jobId: receipt.jobId,
      sessionId: `session-${scenario.scenarioId}`,
      leaseRef: `lease-${scenario.scenarioId}`,
      actor: "agent:m6-facade",
      reason: "matrix",
      committedAt: COMMITTED,
    };
    return {
      receipt,
      closeout: { ...closeoutFields, closeoutHash: deriveM6FrameCloseoutHash(closeoutFields) },
      frame,
    };
  });
}

test("the frozen 4-alias x 20-run matrix seals all 80 scenarios", () => {
  const manifest = oracle();
  const result = verifyAggregateCloseout({ epoch, attempts: matrixAttempts(manifest), scenarioManifest: manifest, resourceSnapshot: resourceSnapshot() });
  assert.equal(result.ok, true, result.errors.map((error) => error.code).join(","));
  assert.equal(result.attemptCount, MATRIX_SIZE);
  assert.deepEqual(result.aliases, ALIASES);
  assert.match(result.sealHash, /^[0-9a-f]{64}$/);
  assert.equal(result.sealPayload.attempts.length, 80);
});

test("the old one-capture-per-alias shape cannot seal", () => {
  const manifest = oracle();
  const result = verifyAggregateCloseout({
    epoch,
    attempts: matrixAttempts(manifest).filter((_, index) => index % 20 === 0),
    scenarioManifest: manifest,
    resourceSnapshot: resourceSnapshot(),
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === "M6_AGGREGATE_SCENARIO_MISSING"));
});

test("scenario manifest and stable/unstable distribution are enforced", () => {
  const manifest = oracle();
  const forged = { ...manifest, scenarios: manifest.scenarios.map((scenario) => ({ ...scenario, expectedStability: "stable", expectedStatus: "accepted" })) };
  forged.manifestSha256 = deriveM6ScenarioManifestSha256(forged);
  const result = verifyAggregateCloseout({ epoch, attempts: matrixAttempts(manifest), scenarioManifest: forged, resourceSnapshot: resourceSnapshot() });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === "M6_AGGREGATE_DISTRIBUTION_INVALID"));
  assert.ok(result.errors.some((error) => error.code === "M6_AGGREGATE_SCENARIO_OUTCOME_MISMATCH"));
});

test("missing/forged oracle and nonzero action/resource snapshots fail closed", () => {
  const manifest = oracle();
  const attempts = matrixAttempts(manifest);
  assert.ok(verifyAggregateCloseout({ epoch, attempts, resourceSnapshot: resourceSnapshot() }).errors.some((error) => error.code === "M6_AGGREGATE_SCENARIO_MANIFEST_REQUIRED"));
  const snapshot = resourceSnapshot();
  const leaky = { ...snapshot, after: { ...snapshot.after, activeLeases: 1 }, actionCount: 1 };
  leaky.snapshotSha256 = deriveM6ResourceSnapshotSha256(leaky);
  const result = verifyAggregateCloseout({ epoch, attempts, scenarioManifest: manifest, resourceSnapshot: leaky });
  assert.ok(result.errors.some((error) => error.code === "M6_AGGREGATE_RESOURCE_LEAK"));
  assert.ok(result.errors.some((error) => error.code === "M6_AGGREGATE_ACTION_NONZERO"));
});

test("cross-epoch receipts, attribution drift, and forged frame bindings fail closed", () => {
  const manifest = oracle();
  const attempts = matrixAttempts(manifest);
  const crossEpoch = structuredClone(attempts);
  crossEpoch[0].receipt.epochHash = "ee".repeat(32);
  crossEpoch[0].receipt.receiptSha256 = deriveM6CaptureReceiptSha256(crossEpoch[0].receipt);
  assert.ok(verifyAggregateCloseout({ epoch, attempts: crossEpoch, scenarioManifest: manifest, resourceSnapshot: resourceSnapshot() })
    .errors.some((error) => error.code === "M6_AGGREGATE_RECEIPT_EPOCH_MISMATCH"));

  const attributionDrift = structuredClone(attempts);
  attributionDrift[0].closeout.jobId = "job-other";
  attributionDrift[0].closeout.closeoutHash = deriveM6FrameCloseoutHash(attributionDrift[0].closeout);
  assert.ok(verifyAggregateCloseout({ epoch, attempts: attributionDrift, scenarioManifest: manifest, resourceSnapshot: resourceSnapshot() })
    .errors.some((error) => error.code === "M6_AGGREGATE_CLOSEOUT_MISMATCH"));

  const forgedFrame = structuredClone(attempts);
  forgedFrame[0].frame.flags.partial = true;
  assert.ok(verifyAggregateCloseout({ epoch, attempts: forgedFrame, scenarioManifest: manifest, resourceSnapshot: resourceSnapshot() })
    .errors.some((error) => ["M6_AGGREGATE_STABILITY_MISMATCH", "M6_AGGREGATE_FRAME_FORGED"].includes(error.code)));
});

test("CLI consumes both independent inputs and writes a re-verifiable 80-run seal", () => {
  const m6Root = mkdtempSync(join(tmpdir(), "m6-agg-root-"));
  const auditRoot = mkdtempSync(join(tmpdir(), "m6-agg-audit-"));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  try {
    writeImmutableJson(join(m6Root, "m6-gate", "locks.v1.json"), {
      schemaId: "xw.m6-locks.v1", releaseId: "release-agg", sourceCommit: HEX40, lockHashes: LOCKS,
    });
    writeImmutableJson(join(m6Root, "m6-gate", "issuer-keys.json"), {
      schemaId: M6_GATE_ISSUER_ALLOWLIST_SCHEMA_ID,
      version: 1,
      keys: [{ keyId: "key-1", subject: "operator:agg", publicKey: publicKey.export({ type: "spki", format: "pem" }), status: "active" }],
    });
    const liveEpoch = buildEpochRecord({
      gateId: "gate-agg",
      mode: "OBSERVE_ONLY",
      releaseId: "release-agg",
      sourceCommit: HEX40,
      actor: "operator:agg",
      allowlist: ALIASES,
      lockHashes: LOCKS,
      issuedAt: "2026-08-22T00:00:00.000Z",
      expiresAt: "2026-08-23T00:00:00.000Z",
    });
    const proof = signEpochProof(liveEpoch, privateKey, { keyId: "key-1", subject: "operator:agg", allowlistVersion: 1 });
    mintEpoch({ m6Root, gateId: "gate-agg", epoch: liveEpoch, proof });
    activateGate({ m6Root, gateId: "gate-agg", chain: [liveEpoch.epochHash], tailEpochHash: liveEpoch.epochHash, promotedAt: COMMITTED });
    const manifest = oracle(liveEpoch.epochHash);
    const snapshot = resourceSnapshot(liveEpoch.epochHash);
    const manifestPath = join(m6Root, "scenario-manifest.json");
    const snapshotPath = join(m6Root, "resource-snapshot.json");
    writeFileSync(manifestPath, JSON.stringify(manifest));
    writeFileSync(snapshotPath, JSON.stringify(snapshot));
    for (const attempt of matrixAttempts(manifest)) {
      writeFileSync(join(auditRoot, `${attempt.receipt.attemptId}.json`), JSON.stringify({ receipt: attempt.receipt, frame: attempt.frame }));
      writeFileSync(join(auditRoot, `${attempt.receipt.attemptId}.closeout.json`), JSON.stringify({ closeout: attempt.closeout }));
    }
    const args = [xwPath, "m6", "epoch", "aggregate-closeout", "--m6-root", m6Root, "--gate-id", "gate-agg",
      "--audit-root", auditRoot, "--scenario-manifest", manifestPath, "--resource-snapshot", snapshotPath,
      "--issuer-keys", join(m6Root, "m6-gate", "issuer-keys.json"), "--yes", "--json"];
    const run = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(run.stdout.trim().split("\n").at(-1));
    assert.equal(result.attemptCount, 80);
    assert.ok(existsSync(join(m6Root, "m6-gate", "gate-agg", "aggregate", `${result.sealHash}.json`)));
  } finally {
    rmSync(m6Root, { recursive: true, force: true });
    rmSync(auditRoot, { recursive: true, force: true });
  }
});
