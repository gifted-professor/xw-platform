// M6-2 W8 #4/#9 — `xw m6 frame`/`xw m6 epoch` CLI namespace dispatch + dry-run.
//
// #4: `xw m6 frame ...` treats `frame` as a no-op namespace prefix (so
// `xw m6 frame preflight` routes to preflight), and `xw m6 epoch ...` dispatches
// to the operator epoch tools. #9: a `mint` dry-run (no --yes) constructs a
// signed schema-valid epoch from flags, prints the candidate + path, and writes
// nothing. Runs the real CLI as a subprocess (exercises the main guard).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  deriveM6CaptureReceiptSha256,
  deriveM6FrameCloseoutHash,
  deriveM6ScenarioManifestSha256,
  verifyAggregateCloseout,
} from "../../kernel/lib/m6-aggregate-closeout.mjs";
import { deriveFrameId, deriveFrameManifestSha256 } from "../../kernel/lib/m6-screen-frame.mjs";

const xwPath = join(dirname(fileURLToPath(import.meta.url)), "../xw.mjs");

function run(args, { cwd } = {}) {
  const result = spawnSync(process.execPath, [xwPath, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const code = result.status ?? 1;
  const line = stdout.trim().split("\n").at(-1);
  let json = null;
  try { if (line) json = JSON.parse(line); } catch { json = null; }
  return { code, stdout, stderr, json };
}

const HEX40 = "a".repeat(40);
const LOCKS = { runtimeProfile: "11".repeat(32), hardRedlinePolicy: "22".repeat(32), groundingRuntime: "33".repeat(32) };

function makeGateRoot() {
  const m6Root = mkdtempSync(join(tmpdir(), "xw-m6-cli-root-"));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  mkdirSync(join(m6Root, "m6-gate"), { recursive: true });
  writeFileSync(join(m6Root, "m6-gate", "locks.v1.json"), `${JSON.stringify({
    schemaId: "xw.m6-locks.v1", releaseId: "release-cli", sourceCommit: HEX40, lockHashes: { ...LOCKS },
  }, null, 2)}\n`);
  writeFileSync(join(m6Root, "m6-gate", "issuer-keys.json"), `${JSON.stringify({
    schemaId: "xw.m6-gate-issuer-allowlist.v1", version: 1,
    keys: [{ keyId: "key-1", subject: "operator:cli", publicKey: publicKey.export({ type: "spki", format: "pem" }), status: "active" }],
  }, null, 2)}\n`);
  const keyFile = join(m6Root, "m6-gate", "operator-key.pem");
  writeFileSync(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }));
  return { m6Root, keyFile, issuerKeysPath: join(m6Root, "m6-gate", "issuer-keys.json") };
}

test("xw m6 frame --help prints the frame usage", () => {
  const { code, stderr } = run(["m6", "frame", "--help"]);
  assert.equal(code, 0);
  assert.match(stderr, /xw m6 frame/);
});

test("xw m6 frame (no command) exits 2 with usage", () => {
  const { code, stderr } = run(["m6", "frame"]);
  assert.equal(code, 2);
  assert.match(stderr, /xw m6 frame/);
});

test("xw m6 epoch --help prints the epoch usage", () => {
  const { code, stderr } = run(["m6", "epoch", "--help"]);
  assert.equal(code, 0);
  assert.match(stderr, /xw m6 epoch mint/);
  assert.match(stderr, /xw m6 epoch aggregate-closeout/);
});

test("xw m6 epoch (no command) exits 2 with usage", () => {
  const { code, stderr } = run(["m6", "epoch"]);
  assert.equal(code, 2);
  assert.match(stderr, /xw m6 epoch/);
});

test("xw m6 epoch status without --gate-id exits 2", () => {
  const { code, stderr } = run(["m6", "epoch", "status", "--m6-root", mkdtempSync(join(tmpdir(), "xw-m6-cli-nogate-"))]);
  assert.equal(code, 2);
  assert.match(stderr, /--gate-id is required/);
});

test("xw m6 epoch mint dry-run (no --yes) builds + signs + prints and writes nothing", () => {
  const gate = makeGateRoot();
  try {
    const args = ["m6", "epoch", "mint",
      "--m6-root", gate.m6Root,
      "--gate-id", "gate-cli",
      "--release-id", "release-cli",
      "--source-commit", HEX40,
      "--allowlist", "01,02",
      "--expires-at", "2099-01-01T00:00:00.000Z",
      "--key-file", gate.keyFile,
      "--key-id", "key-1",
      "--issuer-keys", gate.issuerKeysPath,
      "--json",
    ];
    const { code, json } = run(args);
    assert.equal(code, 0);
    assert.equal(json.dryRun, true);
    assert.match(json.epoch.epochHash, /^[0-9a-f]{64}$/);
    assert.equal(json.proof.keyId, "key-1");
    assert.equal(json.epoch.actor, "operator:cli");
    // Dry-run wrote nothing — no epochs directory yet.
    assert.equal(existsSync(join(gate.m6Root, "m6-gate", "gate-cli", "epochs")), false);
  } finally {
    rmSync(gate.m6Root, { recursive: true, force: true });
  }
});

test("xw m6 epoch mint --yes writes the immutable epoch file", () => {
  const gate = makeGateRoot();
  try {
    const args = ["m6", "epoch", "mint",
      "--m6-root", gate.m6Root, "--gate-id", "gate-cli", "--release-id", "release-cli",
      "--source-commit", HEX40, "--allowlist", "01,02", "--expires-at", "2099-01-01T00:00:00.000Z",
      "--key-file", gate.keyFile, "--key-id", "key-1", "--issuer-keys", gate.issuerKeysPath,
      "--yes", "--json",
    ];
    const { code, json } = run(args);
    assert.equal(code, 0);
    assert.equal(json.dryRun, false);
    assert.equal(json.written !== null, true);
    assert.equal(existsSync(join(gate.m6Root, "m6-gate", "gate-cli", "epochs", `${json.epoch.epochHash}.json`)), true);
  } finally {
    rmSync(gate.m6Root, { recursive: true, force: true });
  }
});

test("xw m6 epoch verify on an empty gate reports ok:false (closed)", () => {
  const gate = makeGateRoot();
  try {
    const { code, json } = run(["m6", "epoch", "verify", "--m6-root", gate.m6Root, "--gate-id", "gate-cli", "--issuer-keys", gate.issuerKeysPath, "--json"]);
    assert.equal(code, 1);
    assert.equal(json.ok, false);
    assert.equal(json.epochs, 0);
  } finally {
    rmSync(gate.m6Root, { recursive: true, force: true });
  }
});

test("xw m6 epoch close cannot mint CLOSED without an explicit aggregate seal", () => {
  const gate = makeGateRoot();
  try {
    const common = ["--m6-root", gate.m6Root, "--gate-id", "gate-cli", "--issuer-keys", gate.issuerKeysPath, "--json"];
    const minted = run(["m6", "epoch", "mint", ...common,
      "--release-id", "release-cli", "--source-commit", HEX40, "--allowlist", "01,02,03,04",
      "--expires-at", "2099-01-01T00:00:00.000Z", "--key-file", gate.keyFile, "--key-id", "key-1", "--yes"]);
    assert.equal(minted.code, 0, minted.stderr);
    const activated = run(["m6", "epoch", "activate", ...common, "--epoch-hash", minted.json.epoch.epochHash, "--yes"]);
    assert.equal(activated.code, 0, activated.stderr);
    const closed = run(["m6", "epoch", "close", ...common, "--reason", "probe", "--key-file", gate.keyFile, "--key-id", "key-1", "--yes"]);
    assert.equal(closed.code, 2);
    assert.match(closed.stderr, /--aggregate-seal is required/);
    assert.equal(existsSync(join(gate.m6Root, "m6-gate", "gate-cli", "closeouts")), false);
  } finally {
    rmSync(gate.m6Root, { recursive: true, force: true });
  }
});

// --- xw m6 window — W8/W9 live closeout offline inputs -----------------------

const WINDOW_EPOCH = "cc".repeat(32);
const WINDOW_COMMITTED = "2026-08-22T00:00:00.000Z";

// Reconstruct the per-attempt audit records a live capture+closeout would have
// left in the audit root, in the exact shape m6EpochAggregateCloseout reads:
// <attemptId>.json = { receipt, frame }, <attemptId>.closeout.json = { closeout }.
function windowMatrixAttempts(manifest) {
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
        capturedAt: WINDOW_COMMITTED,
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
    const closeout = {
      closeoutId: `closeout-${scenario.scenarioId}`,
      attemptId,
      epochHash: manifest.epochHash,
      runId: receipt.runId,
      jobId: receipt.jobId,
      sessionId: `session-${scenario.scenarioId}`,
      leaseRef: `lease-${scenario.scenarioId}`,
      actor: "agent:m6-facade",
      reason: "matrix",
      committedAt: WINDOW_COMMITTED,
    };
    return { receipt, closeout: { ...closeout, closeoutHash: deriveM6FrameCloseoutHash(closeout) }, frame };
  });
}

function writeWindowAudit(auditRoot, attempts) {
  mkdirSync(auditRoot, { recursive: true });
  for (const attempt of attempts) {
    writeFileSync(join(auditRoot, `${attempt.receipt.attemptId}.json`), `${JSON.stringify({ receipt: attempt.receipt, frame: attempt.frame })}\n`);
    writeFileSync(join(auditRoot, `${attempt.receipt.attemptId}.closeout.json`), `${JSON.stringify({ closeout: attempt.closeout })}\n`);
  }
}

test("xw m6 window --help prints the window usage; bare xw m6 window exits 2", () => {
  const help = run(["m6", "window", "--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stderr, /xw m6 window manifest/);
  assert.match(help.stderr, /xw m6 window snapshot/);
  const bare = run(["m6", "window"]);
  assert.equal(bare.code, 2);
  assert.match(bare.stderr, /xw m6 window/);
});

test("xw m6 window manifest dry-run prints the frozen matrix and writes nothing", () => {
  const tmp = mkdtempSync(join(tmpdir(), "xw-m6-window-man-"));
  try {
    const out = join(tmp, "scenario-manifest.json");
    const { code, json } = run(["m6", "window", "manifest", "--epoch-hash", WINDOW_EPOCH, "--out", out, "--json"]);
    assert.equal(code, 0);
    assert.equal(json.dryRun, true);
    assert.equal(json.scenarioCount, 80);
    assert.equal(json.stableCount, 76);
    assert.equal(json.unstableCount, 4);
    assert.match(json.manifestSha256, /^[0-9a-f]{64}$/);
    assert.equal(existsSync(out), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("xw m6 window manifest --yes writes an immutable file the aggregate oracle accepts", () => {
  const tmp = mkdtempSync(join(tmpdir(), "xw-m6-window-man-yes-"));
  try {
    const manifestPath = join(tmp, "scenario-manifest.json");
    const snapshotPath = join(tmp, "resource-snapshot.json");
    const m = run(["m6", "window", "manifest", "--epoch-hash", WINDOW_EPOCH, "--out", manifestPath, "--yes", "--json"]);
    assert.equal(m.code, 0, m.stderr);
    assert.equal(m.json.dryRun, false);
    assert.equal(existsSync(manifestPath), true);
    const s = run(["m6", "window", "snapshot", "--epoch-hash", WINDOW_EPOCH, "--out", snapshotPath, "--yes", "--json"]);
    assert.equal(s.code, 0, s.stderr);
    assert.equal(existsSync(snapshotPath), true);

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
    const auditRoot = join(tmp, "audit");
    writeWindowAudit(auditRoot, windowMatrixAttempts(manifest));
    const aliases = [...new Set(manifest.scenarios.map((scenario) => scenario.alias))];
    const result = verifyAggregateCloseout({
      epoch: { epochHash: manifest.epochHash, allowlist: aliases },
      attempts: windowMatrixAttempts(manifest),
      scenarioManifest: manifest,
      resourceSnapshot: snapshot,
    });
    assert.equal(result.ok, true, result.errors.map((error) => error.code).join(","));
    assert.equal(result.attemptCount, 80);
    assert.equal(result.sealPayload.attempts.length, 80);

    // The manifest really is frozen — a tampered expectation fails the oracle.
    const tampered = {
      ...manifest,
      scenarios: manifest.scenarios.map((scenario) => ({ ...scenario, expectedStability: "unstable", expectedStatus: "rejected" })),
    };
    tampered.manifestSha256 = deriveM6ScenarioManifestSha256(tampered);
    const result2 = verifyAggregateCloseout({
      epoch: { epochHash: manifest.epochHash, allowlist: aliases },
      attempts: windowMatrixAttempts(manifest),
      scenarioManifest: tampered,
      resourceSnapshot: snapshot,
    });
    assert.equal(result2.ok, false);
    assert.ok(result2.errors.some((error) => error.code === "M6_AGGREGATE_DISTRIBUTION_INVALID"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("xw m6 window snapshot fails closed on a non-zero resource point", () => {
  const tmp = mkdtempSync(join(tmpdir(), "xw-m6-window-snap-"));
  try {
    const bad = run(["m6", "window", "snapshot", "--epoch-hash", WINDOW_EPOCH,
      "--before", '{"activeJobs":1,"activeSessions":0,"activeLeases":0}', "--json"]);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /exactly 0/);
    assert.equal(existsSync(join(tmp, "m6-window-resource-snapshot.json")), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
