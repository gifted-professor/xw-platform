// M6-2 W8 #5 — four-alias aggregate closeout verifier.
//
// The frame-capture facade seals each accepted capture per-attempt
// (`<attemptId>.closeout.json`, domain `xw.m6-frame-capture.v1:closeout`). The
// AGGREGATE layer proves the whole OBSERVE window sealed cleanly: every allowlist
// alias has exactly one accepted capture + one closeout, every closeout re-hashes,
// no attempt is left unsealed, attribution ids are distinct, and mints a
// deterministic seal. Pure verifier + a CLI integration run. Zero device I/O.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  deriveM6FrameCloseoutHash,
  verifyAggregateCloseout,
} from "../../../packages/kernel/lib/m6-aggregate-closeout.mjs";
import { writeImmutableJson } from "../control-plane/lib/m6-gate-loader.mjs";
import {
  buildEpochRecord,
  signEpochProof,
  mintEpoch,
  activateGate,
} from "../control-plane/lib/m6-epoch.mjs";
import { M6_GATE_ISSUER_ALLOWLIST_SCHEMA_ID } from "../control-plane/lib/m6-issuer-allowlist.mjs";

const xwPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages", "cli", "xw.mjs");

const HEX40 = "a".repeat(40);
const LOCKS = Object.freeze({
  runtimeProfile: "11".repeat(32),
  hardRedlinePolicy: "22".repeat(32),
  groundingRuntime: "33".repeat(32),
});
const ALIASES = ["01", "02", "03", "04"];
const EPOCH_HASH = "ff".repeat(32);
const ACTOR = "agent:m6-facade";
const COMMITTED = "2026-08-22T00:00:00.000Z";

function makeReceipt({ attemptId, alias, runId, jobId, status = "accepted", epochHash = EPOCH_HASH, sessionId = null, leaseRef = null }) {
  return {
    schemaId: "xw.capture-attempt-receipt.v1",
    attemptId, runId, jobId, sessionId, leaseRef, alias,
    scenarioLabel: "observe", epochHash, status,
    frameRef: null, gateMode: "OBSERVE_ONLY", errorCodes: [],
    evidenceRefs: [], skew: null, remainingTtlMs: null, capturedAt: null,
    committedAt: COMMITTED,
  };
}

function makeCloseout({ attemptId, runId, jobId, epochHash = EPOCH_HASH, sessionId = null, leaseRef = null }) {
  const fields = {
    closeoutId: `m6closeout_${attemptId}`,
    attemptId, epochHash, runId, jobId, sessionId, leaseRef,
    actor: ACTOR, reason: "operator", committedAt: COMMITTED,
  };
  return { ...fields, closeoutHash: deriveM6FrameCloseoutHash(fields) };
}

// Build the canonical four-alias accepted set, attempt order deliberately
// shuffled so the verifier must sort by alias for the seal.
function fourAliasAttempts() {
  return [
    { alias: "03", attemptId: "att-03", runId: "run-03", jobId: "job-03" },
    { alias: "01", attemptId: "att-01", runId: "run-01", jobId: "job-01" },
    { alias: "04", attemptId: "att-04", runId: "run-04", jobId: "job-04" },
    { alias: "02", attemptId: "att-02", runId: "run-02", jobId: "job-02" },
  ].map((d) => ({
    receipt: makeReceipt({ attemptId: d.attemptId, alias: d.alias, runId: d.runId, jobId: d.jobId }),
    closeout: makeCloseout({ attemptId: d.attemptId, runId: d.runId, jobId: d.jobId }),
  }));
}

const epoch = Object.freeze({
  schemaId: "xw.m6-live-gate.v1",
  gateId: "gate-agg",
  mode: "OBSERVE_ONLY",
  status: "active",
  releaseId: "release-agg",
  sourceCommit: HEX40,
  actor: "operator:agg",
  lockHashes: { ...LOCKS },
  allowlist: ALIASES,
  issuedAt: "2026-08-22T00:00:00.000Z",
  expiresAt: "2026-08-23T00:00:00.000Z",
  parentEpochHash: null,
  closeoutRef: null,
  epochHash: EPOCH_HASH,
});

test("four-alias accepted set seals cleanly: ok + sorted aliases + 64-hex seal", () => {
  const result = verifyAggregateCloseout({ epoch, attempts: fourAliasAttempts() });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.aliases, ["01", "02", "03", "04"]);
  assert.match(result.sealHash, /^[0-9a-f]{64}$/);
});

test("seal is deterministic + order-independent (sorted closeout set)", () => {
  const a = verifyAggregateCloseout({ epoch, attempts: fourAliasAttempts() });
  const reversed = [...fourAliasAttempts()].reverse();
  const b = verifyAggregateCloseout({ epoch, attempts: reversed });
  assert.equal(a.sealHash, b.sealHash);
});

test("missing alias fails (M6_AGGREGATE_ALIAS_MISSING)", () => {
  const attempts = fourAliasAttempts().filter((at) => at.receipt.alias !== "02");
  const result = verifyAggregateCloseout({ epoch, attempts });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === "M6_AGGREGATE_ALIAS_MISSING" && e.message.includes("'02'")));
  assert.equal(result.sealHash, null);
});

test("duplicate accepted alias fails (M6_AGGREGATE_ALIAS_DUPLICATE)", () => {
  const attempts = fourAliasAttempts();
  const dupe = makeReceipt({ attemptId: "att-01b", alias: "01", runId: "run-01b", jobId: "job-01b" });
  attempts.push({ receipt: dupe, closeout: makeCloseout({ attemptId: "att-01b", runId: "run-01b", jobId: "job-01b" }) });
  const result = verifyAggregateCloseout({ epoch, attempts });
  assert.ok(result.errors.some((e) => e.code === "M6_AGGREGATE_ALIAS_DUPLICATE"));
});

test("accepted attempt without a closeout fails (M6_AGGREGATE_UNSEALED)", () => {
  const attempts = fourAliasAttempts();
  attempts[0] = { receipt: attempts[0].receipt, closeout: null };
  const result = verifyAggregateCloseout({ epoch, attempts });
  assert.ok(result.errors.some((e) => e.code === "M6_AGGREGATE_UNSEALED"));
});

test("tampered closeout hash fails (M6_AGGREGATE_CLOSEOUT_FORGED)", () => {
  const attempts = fourAliasAttempts();
  attempts[0] = { ...attempts[0], closeout: { ...attempts[0].closeout, closeoutHash: "00".repeat(32) } };
  const result = verifyAggregateCloseout({ epoch, attempts });
  assert.ok(result.errors.some((e) => e.code === "M6_AGGREGATE_CLOSEOUT_FORGED"));
});

test("rejected attempt left unsealed fails (M6_AGGREGATE_UNSEALED)", () => {
  const attempts = fourAliasAttempts();
  attempts.push({
    receipt: makeReceipt({ attemptId: "att-rej", alias: "01", runId: "run-rej", jobId: "job-rej", status: "rejected" }),
    closeout: null,
  });
  const result = verifyAggregateCloseout({ epoch, attempts });
  assert.ok(result.errors.some((e) => e.code === "M6_AGGREGATE_UNSEALED" && e.message.includes("att-rej")));
});

test("repeated runId across accepted attempts fails (M6_AGGREGATE_RUN_DUPLICATE)", () => {
  const attempts = fourAliasAttempts();
  // Re-assign alias 02's attempt to reuse run-01's runId.
  attempts[3] = {
    receipt: makeReceipt({ attemptId: "att-02", alias: "02", runId: "run-01", jobId: "job-02" }),
    closeout: makeCloseout({ attemptId: "att-02", runId: "run-01", jobId: "job-02" }),
  };
  const result = verifyAggregateCloseout({ epoch, attempts });
  assert.ok(result.errors.some((e) => e.code === "M6_AGGREGATE_RUN_DUPLICATE"));
});

test("an accepted alias not in the allowlist fails (M6_AGGREGATE_ALIAS_NOT_ALLOWED)", () => {
  const attempts = fourAliasAttempts().filter((at) => at.receipt.alias !== "04");
  attempts.push({
    receipt: makeReceipt({ attemptId: "att-99", alias: "99", runId: "run-99", jobId: "job-99" }),
    closeout: makeCloseout({ attemptId: "att-99", runId: "run-99", jobId: "job-99" }),
  });
  const result = verifyAggregateCloseout({ epoch, attempts });
  assert.ok(result.errors.some((e) => e.code === "M6_AGGREGATE_ALIAS_NOT_ALLOWED" && e.message.includes("'99'")));
  assert.ok(result.errors.some((e) => e.code === "M6_AGGREGATE_ALIAS_MISSING" && e.message.includes("'04'")));
});

test("attempts from a different epoch are ignored (multi-epoch audit root)", () => {
  const otherHash = "ee".repeat(32);
  const attempts = fourAliasAttempts();
  attempts.push({
    receipt: makeReceipt({ attemptId: "att-prev", alias: "05", runId: "run-prev", jobId: "job-prev", epochHash: otherHash }),
    closeout: makeCloseout({ attemptId: "att-prev", runId: "run-prev", jobId: "job-prev", epochHash: otherHash }),
  });
  const result = verifyAggregateCloseout({ epoch, attempts });
  assert.equal(result.ok, true, result.errors.map((e) => e.code).join(","));
  assert.deepEqual(result.aliases, ["01", "02", "03", "04"]);
});

test("invalid epoch fails closed (M6_AGGREGATE_EPOCH_INVALID)", () => {
  const result = verifyAggregateCloseout({ epoch: null, attempts: [] });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, "M6_AGGREGATE_EPOCH_INVALID");
});

// --- CLI integration: full mint+activate → audit trail → aggregate-closeout ---

const GATE_ID = "gate-agg-cli";

function writeLocks(m6Root) {
  writeImmutableJson(join(m6Root, "m6-gate", "locks.v1.json"), {
    schemaId: "xw.m6-locks.v1", releaseId: "release-agg", sourceCommit: HEX40, lockHashes: { ...LOCKS },
  });
}

function newKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
  };
}

test("CLI `xw m6 epoch aggregate-closeout --yes` writes the immutable seal for a four-alias window", () => {
  const m6Root = mkdtempSync(join(tmpdir(), "m6-agg-cli-"));
  const auditRoot = mkdtempSync(join(tmpdir(), "m6-agg-audit-"));
  const key = newKey();
  writeLocks(m6Root);
  writeImmutableJson(join(m6Root, "m6-gate", "issuer-keys.json"), {
    schemaId: M6_GATE_ISSUER_ALLOWLIST_SCHEMA_ID, version: 1,
    keys: [{ keyId: "key-1", subject: "operator:agg", publicKey: key.publicKeyPem, status: "active" }],
  });
  try {
    const epochRec = buildEpochRecord({
      gateId: GATE_ID, mode: "OBSERVE_ONLY", releaseId: "release-agg", sourceCommit: HEX40,
      actor: "operator:agg", allowlist: ALIASES, lockHashes: LOCKS,
      issuedAt: "2026-08-22T00:00:00.000Z", expiresAt: "2026-08-23T00:00:00.000Z", parentEpochHash: null,
    });
    const proof = signEpochProof(epochRec, key.privateKeyPem, { keyId: "key-1", subject: "operator:agg", allowlistVersion: 1 });
    mintEpoch({ m6Root, gateId: GATE_ID, epoch: epochRec, proof });
    activateGate({ m6Root, gateId: GATE_ID, chain: [epochRec.epochHash], tailEpochHash: epochRec.epochHash, promotedAt: "2026-08-22T00:00:00.000Z" });

    // Write the four-alias audit trail exactly as the facade would.
    for (const alias of ALIASES) {
      const attemptId = `att-${alias}`;
      const runId = `run-${alias}`;
      const jobId = `job-${alias}`;
      const receipt = makeReceipt({ attemptId, alias, runId, jobId, epochHash: epochRec.epochHash });
      const closeout = makeCloseout({ attemptId, runId, jobId, epochHash: epochRec.epochHash });
      writeFileSync(join(auditRoot, `${attemptId}.json`), `${JSON.stringify({ receipt, frame: null }, null, 2)}\n`);
      writeFileSync(join(auditRoot, `${attemptId}.closeout.json`), `${JSON.stringify({ closeout }, null, 2)}\n`);
    }

    // dry-run first: writes nothing, prints the seal path.
    const dry = spawnSync(process.execPath, [xwPath, "m6", "epoch", "aggregate-closeout",
      "--m6-root", m6Root, "--gate-id", GATE_ID, "--audit-root", auditRoot, "--issuer-keys", join(m6Root, "m6-gate", "issuer-keys.json"), "--json"],
      { encoding: "utf8" });
    const dryLine = dry.stdout.trim().split("\n").at(-1);
    const dryJson = JSON.parse(dryLine);
    assert.equal(dry.status, 0, dry.stderr);
    assert.equal(dryJson.ok, true);
    assert.equal(dryJson.dryRun, true);
    assert.match(dryJson.sealHash, /^[0-9a-f]{64}$/);
    assert.equal(existsSync(join(m6Root, "m6-gate", GATE_ID, "aggregate", `${dryJson.sealHash}.json`)), false);

    // --yes writes the immutable seal.
    const wet = spawnSync(process.execPath, [xwPath, "m6", "epoch", "aggregate-closeout",
      "--m6-root", m6Root, "--gate-id", GATE_ID, "--audit-root", auditRoot, "--issuer-keys", join(m6Root, "m6-gate", "issuer-keys.json"), "--yes", "--json"],
      { encoding: "utf8" });
    const wetLine = wet.stdout.trim().split("\n").at(-1);
    const wetJson = JSON.parse(wetLine);
    assert.equal(wet.status, 0, wet.stderr);
    assert.equal(wetJson.ok, true);
    assert.equal(wetJson.dryRun, false);
    assert.deepEqual(wetJson.aliases, ["01", "02", "03", "04"]);
    assert.equal(existsSync(join(m6Root, "m6-gate", GATE_ID, "aggregate", `${wetJson.sealHash}.json`)), true);
    // Re-running --yes on the same seal fails immutable (refuse-overwrite).
    const again = spawnSync(process.execPath, [xwPath, "m6", "epoch", "aggregate-closeout",
      "--m6-root", m6Root, "--gate-id", GATE_ID, "--audit-root", auditRoot, "--issuer-keys", join(m6Root, "m6-gate", "issuer-keys.json"), "--yes"],
      { encoding: "utf8" });
    assert.notEqual(again.status, 0);
    assert.match(again.stderr, /M6_GATE_IMMUTABLE/);
  } finally {
    rmSync(m6Root, { recursive: true, force: true });
    rmSync(auditRoot, { recursive: true, force: true });
  }
});

test("CLI aggregate-closeout exits 1 when an alias is missing (unsealed window)", () => {
  const m6Root = mkdtempSync(join(tmpdir(), "m6-agg-cli-missing-"));
  const auditRoot = mkdtempSync(join(tmpdir(), "m6-agg-audit-missing-"));
  const key = newKey();
  writeLocks(m6Root);
  writeImmutableJson(join(m6Root, "m6-gate", "issuer-keys.json"), {
    schemaId: M6_GATE_ISSUER_ALLOWLIST_SCHEMA_ID, version: 1,
    keys: [{ keyId: "key-1", subject: "operator:agg", publicKey: key.publicKeyPem, status: "active" }],
  });
  try {
    const epochRec = buildEpochRecord({
      gateId: GATE_ID, mode: "OBSERVE_ONLY", releaseId: "release-agg", sourceCommit: HEX40,
      actor: "operator:agg", allowlist: ALIASES, lockHashes: LOCKS,
      issuedAt: "2026-08-22T00:00:00.000Z", expiresAt: "2026-08-23T00:00:00.000Z", parentEpochHash: null,
    });
    const proof = signEpochProof(epochRec, key.privateKeyPem, { keyId: "key-1", subject: "operator:agg", allowlistVersion: 1 });
    mintEpoch({ m6Root, gateId: GATE_ID, epoch: epochRec, proof });
    activateGate({ m6Root, gateId: GATE_ID, chain: [epochRec.epochHash], tailEpochHash: epochRec.epochHash, promotedAt: "2026-08-22T00:00:00.000Z" });

    // Only three aliases sealed.
    for (const alias of ["01", "02", "03"]) {
      const attemptId = `att-${alias}`;
      const receipt = makeReceipt({ attemptId, alias, runId: `run-${alias}`, jobId: `job-${alias}`, epochHash: epochRec.epochHash });
      const closeout = makeCloseout({ attemptId, runId: `run-${alias}`, jobId: `job-${alias}`, epochHash: epochRec.epochHash });
      writeFileSync(join(auditRoot, `${attemptId}.json`), `${JSON.stringify({ receipt, frame: null }, null, 2)}\n`);
      writeFileSync(join(auditRoot, `${attemptId}.closeout.json`), `${JSON.stringify({ closeout }, null, 2)}\n`);
    }

    const res = spawnSync(process.execPath, [xwPath, "m6", "epoch", "aggregate-closeout",
      "--m6-root", m6Root, "--gate-id", GATE_ID, "--audit-root", auditRoot, "--issuer-keys", join(m6Root, "m6-gate", "issuer-keys.json"), "--json"],
      { encoding: "utf8" });
    const line = res.stdout.trim().split("\n").at(-1);
    const json = JSON.parse(line);
    assert.equal(res.status, 1);
    assert.equal(json.ok, false);
    assert.ok(json.errors.some((e) => e.code === "M6_AGGREGATE_ALIAS_MISSING" && e.message.includes("'04'")));
    assert.equal(json.sealHash, null);
  } finally {
    rmSync(m6Root, { recursive: true, force: true });
    rmSync(auditRoot, { recursive: true, force: true });
  }
});