import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  mkdirSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  deriveM6AggregateSealHash,
  deriveM6ResourceSnapshotSha256,
} from "../../../packages/kernel/lib/m6-aggregate-closeout.mjs";
import { snapshotDatabase } from "../../../packages/cutover/lib/db.mjs";
import { canonicalJson, sha256 } from "../control-plane/lib/canonical.mjs";
import { writeImmutableJson } from "../control-plane/lib/m6-gate-loader.mjs";
import { deriveM6CloseoutHash, deriveM6EpochHash } from "../control-plane/lib/m6-live-gate.mjs";
import {
  bootstrapM6Qualification,
  buildM6QualificationBootstrapBinding,
  deriveM6QualificationBootstrapPackageHash,
  deriveM6QualificationBootstrapScenarioManifestHash,
  isM6QualificationCleanupVerifiedError,
  M6_QUALIFICATION_BOOTSTRAP_PACKAGE_SCHEMA_ID,
  M6_QUALIFICATION_BOOTSTRAP_SCENARIO_SCHEMA_ID,
  validateM6QualificationBootstrapPackage,
} from "../control-plane/lib/m6-qualification-bootstrap.mjs";
import { CURRENT_CONTROL_SCHEMA_VERSION, StateStore } from "../control-plane/lib/state-store.mjs";

const NOW = Date.parse("2030-01-01T00:00:05.000Z");
const ACTOR = "operator:m6-qualification-bootstrap-test";
const RELEASE = "xw-m6-c1-bootstrap-test";
const SOURCE = "a".repeat(40);
const GATE = "m6-c1-bootstrap-a00000000000";
const LOCKS = Object.freeze({
  runtimeProfile: "1".repeat(64),
  hardRedlinePolicy: "2".repeat(64),
  groundingRuntime: "3".repeat(64),
});

function makeV18Db(path, { activeJob = false, recoveryResidue = false } = {}) {
  const state = new StateStore({ dbPath: path, now: () => NOW });
  state.close();
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA foreign_keys=OFF");
    db.prepare("INSERT INTO nodes (node_id,status,authority,dispatch_mode,metadata_json,last_seen_at) VALUES (?,?,?,?,?,?)")
      .run("legacy-node", "online", 1, "local", '{"sentinel":"unchanged"}', NOW - 10_000);
    if (activeJob) {
      db.prepare(`INSERT INTO devices (
        device_id,alias,physical_label,node_id,runtime_id,metadata_json,routing_json,online,quarantined,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
        "legacy-device", "99", "legacy", "legacy-node", null, "{}", '{"enabled":false,"tags":[],"capabilityIds":[]}', 1, 0, NOW - 9_000,
      );
      db.prepare(`INSERT INTO capabilities (
        capability_id,app_id,maturity,risk,enabled,manifest_json,updated_at
      ) VALUES (?,?,?,?,?,?,?)`).run("legacy.capability", "legacy", "stable", "low", 1, "{}", NOW - 9_000);
      db.prepare(`INSERT INTO jobs (
        job_id,run_id,idempotency_key,request_fingerprint,actor_id,device_id,capability_id,
        capability_json,params_json,canary,session_id,status,approval_required,external_effect,
        created_at,updated_at,placement_request_json
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        "legacy-job", "legacy-run", "legacy-idempotency", "legacy-fingerprint", "legacy-actor",
        "legacy-device", "legacy.capability", "{}", "{}", 0, null, "queued", 0, 0,
        NOW - 8_000, NOW - 8_000, "{}",
      );
    }
    if (recoveryResidue) {
      db.prepare(`INSERT OR IGNORE INTO devices (
        device_id,alias,physical_label,node_id,runtime_id,metadata_json,routing_json,online,quarantined,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
        "legacy-device", "99", "legacy", "legacy-node", null, "{}", '{"enabled":false,"tags":[],"capabilityIds":[]}', 1, 0, NOW - 9_000,
      );
      db.prepare(`INSERT INTO leases (
        lease_id,device_id,kind,holder_id,job_id,token_hash,created_at,heartbeat_at,expires_at
      ) VALUES (?,?,?,?,?,?,?,?,?)`).run(
        "legacy-expired-lease", "legacy-device", "session", "legacy-holder", null, "legacy-token-hash",
        NOW - 20_000, NOW - 15_000, NOW - 10_000,
      );
      db.prepare(`INSERT INTO sessions (
        session_id,lease_id,actor_id,device_id,token_hash,canary,scope_capability_id,
        placement_decision_json,session_kind,created_at,expires_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
        "legacy-expired-session", "legacy-expired-lease", "legacy-actor", "legacy-device", "legacy-token-hash",
        0, null, null, "capability", NOW - 20_000, NOW - 10_000,
      );
      db.prepare(`INSERT INTO device_session_actions (
        session_id,idempotency_key,action_id,fingerprint_json,result_json,executed,created_at,
        status,execution_mode,transport_called,error_code,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        "legacy-expired-session", "legacy-interrupted-action", null, "{}", "{}", 0, NOW - 15_000,
        "REQUESTED", "fixture", 0, null, NOW - 15_000,
      );
    }
    const m6Tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'm6_%'").all();
    for (const { name } of m6Tables) db.exec(`DROP TABLE "${name.replaceAll('"', '""')}"`);
    db.exec("PRAGMA user_version=18");
  } finally { db.close(); }
}

function proof(epoch, privateKey) {
  return {
    keyId: "bootstrap-key",
    subject: ACTOR,
    allowlistVersion: 1,
    signature: sign(null, Buffer.from(epoch.epochHash, "hex"), privateKey).toString("base64"),
    algorithm: "ed25519",
  };
}

function buildPackage({ issuerPath, privateKey }) {
  const locksRecord = {
    schemaId: "xw.m6-locks.v1",
    releaseId: RELEASE,
    sourceCommit: SOURCE,
    lockHashes: { ...LOCKS },
  };
  const rootRaw = {
    schemaId: "xw.m6-live-gate.v1",
    gateId: GATE,
    mode: "OBSERVE_ONLY",
    status: "active",
    releaseId: RELEASE,
    sourceCommit: SOURCE,
    actor: ACTOR,
    lockHashes: { ...LOCKS },
    allowlist: ["01"],
    issuedAt: "2030-01-01T00:00:00.000Z",
    expiresAt: "2030-01-02T00:00:00.000Z",
    parentEpochHash: null,
    closeoutRef: null,
    aggregateSealRef: null,
    rollbackTargetEpochHash: null,
  };
  const rootEpoch = { ...rootRaw, epochHash: deriveM6EpochHash(rootRaw) };
  const rootEpochRecord = { ...rootEpoch, proof: proof(rootEpoch, privateKey) };
  const scenarioRaw = {
    schemaId: M6_QUALIFICATION_BOOTSTRAP_SCENARIO_SCHEMA_ID,
    epochHash: rootEpoch.epochHash,
    allowlist: ["01"],
    attemptCount: 0,
    scenarios: [],
  };
  const scenarioManifest = {
    ...scenarioRaw,
    manifestSha256: deriveM6QualificationBootstrapScenarioManifestHash(scenarioRaw),
  };
  const zeroPoint = {
    activeActions: 0,
    activeJobs: 0,
    activeLeases: 0,
    activeRuns: 0,
    activeSessions: 0,
  };
  const resourceRaw = {
    schemaId: "xw.m6-resource-snapshot.v1",
    epochHash: rootEpoch.epochHash,
    before: { ...zeroPoint },
    after: { ...zeroPoint },
    actionCount: 0,
  };
  const resourceSnapshot = {
    ...resourceRaw,
    snapshotSha256: deriveM6ResourceSnapshotSha256(resourceRaw),
  };
  const sealPayload = {
    epochHash: rootEpoch.epochHash,
    allowlist: ["01"],
    scenarioManifestSha256: scenarioManifest.manifestSha256,
    resourceSnapshotSha256: resourceSnapshot.snapshotSha256,
    attempts: [],
  };
  const sealHash = deriveM6AggregateSealHash(sealPayload);
  const aggregate = {
    schemaId: "xw.m6-aggregate-closeout.v1",
    epochHash: rootEpoch.epochHash,
    sealPayload,
    sealHash,
    attemptCount: 0,
    aliases: ["01"],
  };
  const closeoutRaw = {
    closeoutId: "qualification-bootstrap-zero-attempt-closeout",
    epochHash: rootEpoch.epochHash,
    actor: ACTOR,
    reason: "seal never-activated qualification bootstrap root",
    committedAt: "2030-01-01T00:00:01.000Z",
  };
  const closeout = { ...closeoutRaw, closeoutHash: deriveM6CloseoutHash(closeoutRaw) };
  const closedRaw = {
    ...rootRaw,
    mode: "CLOSED",
    status: "closed",
    issuedAt: "2030-01-01T00:00:02.000Z",
    parentEpochHash: rootEpoch.epochHash,
    closeoutRef: { id: closeout.closeoutId, sha256: closeout.closeoutHash },
    aggregateSealRef: { id: sealHash, sha256: sealHash },
  };
  const closedEpoch = { ...closedRaw, epochHash: deriveM6EpochHash(closedRaw) };
  const closedEpochRecord = { ...closedEpoch, proof: proof(closedEpoch, privateKey) };
  const raw = {
    schemaId: M6_QUALIFICATION_BOOTSTRAP_PACKAGE_SCHEMA_ID,
    gateId: GATE,
    releaseId: RELEASE,
    sourceCommit: SOURCE,
    locksRecord,
    issuerAllowlistSha256: sha256(readFileSync(issuerPath)),
    rootEpochRecord,
    closedEpochRecord,
    closeout,
    aggregate,
    scenarioManifest,
    resourceSnapshot,
    promotedAt: "2030-01-01T00:00:03.000Z",
  };
  return { ...raw, packageHash: deriveM6QualificationBootstrapPackageHash(raw) };
}

function fixture(options = {}) {
  const root = mkdtempSync(join(tmpdir(), "m6-qualification-bootstrap-"));
  const m6Root = join(root, "runtime");
  const dbPath = join(root, "state", "control.db");
  makeV18Db(dbPath, options);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const issuerPath = join(m6Root, "m6-gate", "issuer-keys.json");
  writeImmutableJson(issuerPath, {
    schemaId: "xw.m6-gate-issuer-allowlist.v1",
    version: 1,
    keys: [{
      keyId: "bootstrap-key",
      subject: ACTOR,
      publicKey: publicKey.export({ type: "spki", format: "pem" }),
      status: "active",
    }],
  });
  const pkg = buildPackage({ issuerPath, privateKey });
  let snapshotCalls = 0;
  const snapshot = (request) => {
    snapshotCalls += 1;
    return snapshotDatabase(request);
  };
  return {
    root,
    m6Root,
    dbPath,
    issuerPath,
    pkg,
    snapshot,
    snapshotCalls: () => snapshotCalls,
    args: {
      package: pkg,
      m6Root,
      dbPath,
      issuerAllowlistPath: issuerPath,
      snapshotDatabase: snapshot,
      snapshotDirectory: join(root, "backups"),
      snapshotLabel: "pre-m6-c1-control",
      activeRunCount: () => 0,
      now: () => NOW,
    },
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
}

function userVersion(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return Number(db.prepare("PRAGMA user_version").get().user_version); } finally { db.close(); }
}

function recoveryResidue(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const action = db.prepare(`
      SELECT status,error_code,updated_at FROM device_session_actions
      WHERE session_id='legacy-expired-session' AND idempotency_key='legacy-interrupted-action'
    `).get();
    return {
      leaseCount: Number(db.prepare("SELECT COUNT(*) AS count FROM leases WHERE lease_id='legacy-expired-lease'").get().count),
      sessionCount: Number(db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE session_id='legacy-expired-session'").get().count),
      action: action ? { ...action } : null,
    };
  } finally { db.close(); }
}

test("production bootstrap snapshots v18 before migration, preserves legacy rows, and publishes only the two-epoch CLOSED generation", () => {
  const f = fixture();
  let result;
  try {
    result = bootstrapM6Qualification(f.args);
    assert.equal(result.mode, "CLOSED");
    assert.equal(result.generation, 0);
    assert.equal(result.actionCount, 0);
    assert.deepEqual(result.resourceCounts, { jobs: 0, leases: 0, runs: 0, sessions: 0 });
    assert.equal(f.snapshotCalls(), 1);
    assert.equal(userVersion(f.dbPath), CURRENT_CONTROL_SCHEMA_VERSION);
    const migrated = new DatabaseSync(f.dbPath, { readOnly: true });
    try {
      assert.equal(migrated.prepare("SELECT metadata_json FROM nodes WHERE node_id='legacy-node'").get().metadata_json, '{"sentinel":"unchanged"}');
    } finally { migrated.close(); }

    const currentPath = join(f.m6Root, "m6-gate", GATE, "current.json");
    const current = JSON.parse(readFileSync(currentPath, "utf8"));
    assert.deepEqual(current.chain, [f.pkg.rootEpochRecord.epochHash, f.pkg.closedEpochRecord.epochHash]);
    assert.equal(current.tailEpochHash, f.pkg.closedEpochRecord.epochHash);
    assert.equal(current.generation, 0);
    assert.equal(existsSync(join(f.m6Root, "m6-gate", GATE, "tombstones")), false, "root was never separately activated");
    assert.equal(existsSync(join(f.m6Root, "m6-gate", GATE, "locks.v1.json")), true);
    assert.equal(existsSync(join(f.m6Root, "m6-gate", "locks.v1.json")), false, "bootstrap does not overwrite the legacy global lock slot");

    const restoredPath = join(f.root, "restored", "control.db");
    mkdirSync(join(f.root, "restored"), { recursive: true });
    copyFileSync(result.dbSnapshotReceipt.snapshotPath, restoredPath);
    const restored = new DatabaseSync(restoredPath, { readOnly: true });
    try {
      assert.equal(Number(restored.prepare("PRAGMA user_version").get().user_version), 18);
      assert.equal(restored.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      assert.equal(restored.prepare("SELECT metadata_json FROM nodes WHERE node_id='legacy-node'").get().metadata_json, '{"sentinel":"unchanged"}');
      assert.equal(restored.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name LIKE 'm6_%'").get().count, 0);
    } finally { restored.close(); }
  } finally {
    f.cleanup();
  }
});

test("qualification-only migration preserves expired resources and interrupted legacy residue while ordinary runtimes recover it", () => {
  const qualification = fixture({ recoveryResidue: true });
  try {
    const before = recoveryResidue(qualification.dbPath);
    assert.deepEqual(before, {
      leaseCount: 1,
      sessionCount: 1,
      action: { status: "REQUESTED", error_code: null, updated_at: NOW - 15_000 },
    });

    const result = bootstrapM6Qualification(qualification.args);
    assert.equal(result.mode, "CLOSED");
    assert.deepEqual(result.resourceCounts, { jobs: 0, leases: 0, runs: 0, sessions: 0 });
    assert.equal(result.actionCount, 0);
    assert.equal(userVersion(qualification.dbPath), CURRENT_CONTROL_SCHEMA_VERSION);
    assert.deepEqual(recoveryResidue(qualification.dbPath), before, "bootstrap migration must not run ordinary recovery before the legacy-state assertion");
  } finally { qualification.cleanup(); }

  for (const m6RuntimeMode of ["STANDARD", "FINAL"]) {
    const root = mkdtempSync(join(tmpdir(), `m6-${m6RuntimeMode.toLowerCase()}-recovery-`));
    const dbPath = join(root, "state", "control.db");
    try {
      makeV18Db(dbPath, { recoveryResidue: true });
      const state = new StateStore({ dbPath, now: () => NOW, m6RuntimeMode });
      state.close();
      assert.deepEqual(recoveryResidue(dbPath), {
        leaseCount: 0,
        sessionCount: 0,
        action: { status: "AMBIGUOUS", error_code: "CONTROL_PLANE_RESTART", updated_at: NOW },
      }, `${m6RuntimeMode} must retain ordinary startup recovery`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("bootstrap refuses to open/migrate v18 without a verified pre-migration snapshot", () => {
  const f = fixture();
  try {
    assert.throws(() => bootstrapM6Qualification({ ...f.args, snapshotDatabase: null }), {
      code: "M6_QUALIFICATION_BOOTSTRAP_DB_SNAPSHOT_REQUIRED",
    });
    assert.equal(userVersion(f.dbPath), 18);
    assert.equal(existsSync(join(f.m6Root, "m6-gate", GATE, "current.json")), false);
  } finally { f.cleanup(); }
});

for (const stage of ["snapshotReceipt", "artifacts", "migration", "dbFence", "pointer"]) {
  test(`bootstrap exact retry converges after injected ${stage} crash without another snapshot`, () => {
    const f = fixture();
    let result;
    try {
      assert.throws(() => bootstrapM6Qualification({ ...f.args, faultAfter: stage }), {
        code: "M6_QUALIFICATION_BOOTSTRAP_FAULT",
      });
      assert.equal(f.snapshotCalls(), 1);
      if (["snapshotReceipt", "artifacts"].includes(stage)) {
        assert.equal(userVersion(f.dbPath), 18);
        assert.equal(existsSync(join(f.m6Root, "m6-gate", GATE, "current.json")), false);
      } else {
        assert.equal(userVersion(f.dbPath), CURRENT_CONTROL_SCHEMA_VERSION);
      }
      result = bootstrapM6Qualification({ ...f.args, snapshotDatabase: () => { throw new Error("must reuse receipt"); } });
      assert.equal(result.generation, 0);
      assert.equal(result.mode, "CLOSED");
      assert.equal(f.snapshotCalls(), 1);
      assert.equal(existsSync(join(f.m6Root, "m6-gate", GATE, "tombstones")), false);
    } finally {
      f.cleanup();
    }
  });
}

test("qualification bootstrap brands only failures whose StateStore cleanup is proven", () => {
  const beforeStateStore = fixture();
  try {
    let beforeStateStoreError;
    assert.throws(() => bootstrapM6Qualification({
      ...beforeStateStore.args,
      snapshotDatabase: null,
    }), (error) => {
      beforeStateStoreError = error;
      return error?.code === "M6_QUALIFICATION_BOOTSTRAP_DB_SNAPSHOT_REQUIRED";
    });
    assert.equal(isM6QualificationCleanupVerifiedError(beforeStateStoreError), true);
  } finally {
    beforeStateStore.cleanup();
  }

  const verifiedCleanup = fixture();
  try {
    let verifiedError;
    assert.throws(() => bootstrapM6Qualification({
      ...verifiedCleanup.args,
      faultAfter: "migration",
    }), (error) => {
      verifiedError = error;
      return error?.code === "M6_QUALIFICATION_BOOTSTRAP_FAULT";
    });
    assert.equal(isM6QualificationCleanupVerifiedError(verifiedError), true);
  } finally {
    verifiedCleanup.cleanup();
  }

  const failedCleanup = fixture();
  try {
    let cleanupError;
    assert.throws(() => bootstrapM6Qualification({
      ...failedCleanup.args,
      faultAfter: "migration",
      stateFactory(options) {
        const state = new StateStore(options);
        const close = state.close.bind(state);
        state.close = () => {
          close();
          throw Object.assign(new Error("injected close failure"), { code: "TEST_STATE_CLOSE_FAILED" });
        };
        return state;
      },
    }), (error) => {
      cleanupError = error;
      return error?.code === "M6_QUALIFICATION_BOOTSTRAP_CLEANUP_UNPROVEN";
    });
    assert.equal(isM6QualificationCleanupVerifiedError(cleanupError), false);
    assert.deepEqual(cleanupError.details, {
      primaryErrorCode: "M6_QUALIFICATION_BOOTSTRAP_FAULT",
      cleanupErrorCode: "TEST_STATE_CLOSE_FAILED",
    });
  } finally {
    failedCleanup.cleanup();
  }
});

test("complete bootstrap replay is idempotent while any immutable artifact drift fails closed", () => {
  const f = fixture();
  let first;
  let replay;
  try {
    first = bootstrapM6Qualification(f.args);
    replay = bootstrapM6Qualification({ ...f.args, snapshotDatabase: () => { throw new Error("must not resnapshot"); } });
    assert.equal(replay.resultHash, first.resultHash);

    const scenarioPath = join(
      f.m6Root,
      "m6-gate",
      GATE,
      "qualification-bootstrap",
      `${f.pkg.scenarioManifest.manifestSha256}.scenario-manifest.json`,
    );
    writeFileSync(scenarioPath, `${JSON.stringify({ ...f.pkg.scenarioManifest, attemptCount: 1 }, null, 2)}\n`);
    assert.throws(() => bootstrapM6Qualification(f.args), { code: "M6_QUALIFICATION_BOOTSTRAP_ARTIFACT_DRIFT" });
  } finally {
    f.cleanup();
  }
});

test("v20 replay rechecks migrated legacy row hashes against the pre-migration snapshot receipt", () => {
  const f = fixture();
  try {
    bootstrapM6Qualification(f.args);
    const db = new DatabaseSync(f.dbPath);
    try { db.prepare("UPDATE nodes SET metadata_json=? WHERE node_id='legacy-node'").run('{"sentinel":"drifted"}'); } finally { db.close(); }
    assert.throws(() => bootstrapM6Qualification({
      ...f.args,
      snapshotDatabase: () => { throw new Error("must use persisted pre-migration snapshot"); },
    }), { code: "M6_QUALIFICATION_BOOTSTRAP_LEGACY_STATE_DRIFT" });
  } finally { f.cleanup(); }
});

test("package verifier rejects forged proof and zero-attempt/resource drift before filesystem mutation", () => {
  const f = fixture();
  try {
    const forgedRaw = {
      ...f.pkg,
      rootEpochRecord: { ...f.pkg.rootEpochRecord, proof: { ...f.pkg.rootEpochRecord.proof, signature: "A".repeat(88) } },
    };
    const forged = { ...forgedRaw, packageHash: deriveM6QualificationBootstrapPackageHash(forgedRaw) };
    assert.throws(() => validateM6QualificationBootstrapPackage({
      package: forged,
      issuerAllowlistPath: f.issuerPath,
      nowMs: NOW,
    }), { code: "M6_GATE_ISSUER_SIGNATURE_INVALID" });

    const leakyPoint = { ...f.pkg.resourceSnapshot.after, activeRuns: 1 };
    const leakyResourceRaw = { ...f.pkg.resourceSnapshot, after: leakyPoint };
    const leakyResource = {
      ...leakyResourceRaw,
      snapshotSha256: deriveM6ResourceSnapshotSha256(leakyResourceRaw),
    };
    const leakyRaw = { ...f.pkg, resourceSnapshot: leakyResource };
    const leaky = { ...leakyRaw, packageHash: deriveM6QualificationBootstrapPackageHash(leakyRaw) };
    assert.throws(() => validateM6QualificationBootstrapPackage({
      package: leaky,
      issuerAllowlistPath: f.issuerPath,
      nowMs: NOW,
    }), { code: "M6_QUALIFICATION_BOOTSTRAP_RESOURCE_SNAPSHOT_INVALID" });
  } finally { f.cleanup(); }
});

test("package verifier uses the same pinned issuer bytes across a transient path swap", () => {
  const f = fixture();
  const { privateKey: alternatePrivateKey, publicKey: alternatePublicKey } = generateKeyPairSync("ed25519");
  const alternatePath = join(f.m6Root, "m6-gate", "alternate-issuer-keys.json");
  const savedPath = join(f.m6Root, "m6-gate", "issuer-keys.saved.json");
  writeImmutableJson(alternatePath, {
    schemaId: "xw.m6-gate-issuer-allowlist.v1",
    version: 1,
    keys: [{
      keyId: "bootstrap-key",
      subject: ACTOR,
      publicKey: alternatePublicKey.export({ type: "spki", format: "pem" }),
      status: "active",
    }],
  });
  const forgedRaw = {
    ...f.pkg,
    rootEpochRecord: {
      ...f.pkg.rootEpochRecord,
      proof: proof(f.pkg.rootEpochRecord, alternatePrivateKey),
    },
    closedEpochRecord: {
      ...f.pkg.closedEpochRecord,
      proof: proof(f.pkg.closedEpochRecord, alternatePrivateKey),
    },
  };
  const forged = {
    ...forgedRaw,
    packageHash: deriveM6QualificationBootstrapPackageHash(forgedRaw),
  };
  let swapped = false;
  try {
    assert.throws(() => validateM6QualificationBootstrapPackage({
      package: forged,
      issuerAllowlistPath: f.issuerPath,
      m6Root: f.m6Root,
      nowMs: NOW,
      issuerReadObserver() {
        renameSync(f.issuerPath, savedPath);
        renameSync(alternatePath, f.issuerPath);
        swapped = true;
      },
    }), { code: "M6_GATE_ISSUER_SIGNATURE_INVALID" });
    assert.equal(swapped, true);
  } finally {
    if (swapped) {
      renameSync(f.issuerPath, alternatePath);
      renameSync(savedPath, f.issuerPath);
    }
    f.cleanup();
  }
});

test("pointer-ahead and live database resources are hard fail-closed boundaries", () => {
  const pointerAhead = fixture();
  try {
    assert.throws(() => bootstrapM6Qualification({ ...pointerAhead.args, faultAfter: "artifacts" }), {
      code: "M6_QUALIFICATION_BOOTSTRAP_FAULT",
    });
    writeImmutableJson(join(pointerAhead.m6Root, "m6-gate", GATE, "current.json"), {
      chain: [pointerAhead.pkg.rootEpochRecord.epochHash, pointerAhead.pkg.closedEpochRecord.epochHash],
      tailEpochHash: pointerAhead.pkg.closedEpochRecord.epochHash,
      generation: 0,
      promotedAt: pointerAhead.pkg.promotedAt,
    });
    assert.throws(() => bootstrapM6Qualification(pointerAhead.args), {
      code: "M6_QUALIFICATION_BOOTSTRAP_POINTER_AHEAD",
    });
    assert.equal(userVersion(pointerAhead.dbPath), 18);
  } finally { pointerAhead.cleanup(); }

  const nonzero = fixture({ activeJob: true });
  try {
    assert.throws(() => bootstrapM6Qualification(nonzero.args), {
      code: "M6_QUALIFICATION_BOOTSTRAP_RESOURCES_NOT_ZERO",
    });
    assert.equal(existsSync(join(nonzero.m6Root, "m6-gate", GATE, "current.json")), false);
    assert.equal(existsSync(join(nonzero.m6Root, "m6-gate", GATE, "qualification-bootstrap", "db-snapshot-receipt.json")), false);
    assert.equal(existsSync(join(nonzero.m6Root, "m6-gate", GATE, "epochs")), false);
    assert.equal(userVersion(nonzero.dbPath), 18);
  } finally { nonzero.cleanup(); }
});

test("gate-local lock loading is release-bound while legacy global locks remain a fallback", () => {
  const f = fixture();
  let result;
  try {
    result = bootstrapM6Qualification(f.args);
    const state = new StateStore({ dbPath: f.dbPath, now: () => NOW, m6RuntimeMode: "QUALIFICATION_ONLY" });
    try {
      const fence = state.getM6GateFence();
      assert.equal(fence.locksHash, sha256(`xw.m6-locks.v1:${canonicalJson(LOCKS)}`));
      assert.equal(fence.releaseId, RELEASE);
    } finally { state.close(); }
  } finally {
    f.cleanup();
  }
});

test("qualification bootstrap exposes the exact nine-key assembler binding without inventing deployment facts", () => {
  const f = fixture();
  try {
    const binding = buildM6QualificationBootstrapBinding({
      package: f.pkg,
      sourceReleaseRoot: join(f.root, "release"),
      releaseManifestSha256: "4".repeat(64),
      gateIssuerAllowlistPath: f.issuerPath,
      gateFArtifactInventoryPath: join(f.root, "runtime", "qualification-bootstrap", "final-inventory-unavailable.json"),
      gateFArtifactInventoryHash: "5".repeat(64),
    });
    assert.deepEqual(Object.keys(binding).sort(), [
      "gateFArtifactInventoryHash", "gateFArtifactInventoryPath", "gateId", "gateIssuerAllowlistPath",
      "releaseId", "releaseManifestSha256", "schemaId", "sourceCommit", "sourceReleaseRoot",
    ].sort());
    assert.equal(binding.schemaId, "xw.runtime.m6-c1-qualification-bootstrap.v1");
    assert.equal(binding.gateId, GATE);
  } finally { f.cleanup(); }
});

test("snapshot callback is pinned to its exact label/directory and rejects path escape or hardlink aliasing", () => {
  const escaped = fixture();
  try {
    const escapingSnapshot = (request) => {
      const raw = snapshotDatabase(request);
      const outside = join(escaped.root, "outside.snapshot.db");
      copyFileSync(raw.snapshot.path, outside);
      return { ...raw, snapshot: { ...raw.snapshot, path: outside } };
    };
    assert.throws(() => bootstrapM6Qualification({ ...escaped.args, snapshotDatabase: escapingSnapshot }), {
      code: "M6_QUALIFICATION_BOOTSTRAP_DB_SNAPSHOT_INVALID",
    });
    assert.equal(userVersion(escaped.dbPath), 18);
  } finally { escaped.cleanup(); }

  const hardlinked = fixture();
  try {
    const aliasedSnapshot = (request) => {
      const raw = snapshotDatabase(request);
      linkSync(raw.snapshot.path, join(hardlinked.root, "snapshot-hardlink-alias.db"));
      return raw;
    };
    assert.throws(() => bootstrapM6Qualification({ ...hardlinked.args, snapshotDatabase: aliasedSnapshot }), {
      code: "M6_QUALIFICATION_BOOTSTRAP_DB_SNAPSHOT_INVALID",
    });
    assert.equal(userVersion(hardlinked.dbPath), 18);
  } finally { hardlinked.cleanup(); }
});

test("snapshot callback cannot replace or mutate the control DB path before migration", () => {
  const f = fixture();
  try {
    const replacingSnapshot = (request) => {
      const raw = snapshotDatabase(request);
      const replacement = join(f.root, "replacement-control.db");
      copyFileSync(raw.snapshot.path, replacement);
      renameSync(f.dbPath, join(f.root, "original-control.db"));
      renameSync(replacement, f.dbPath);
      return raw;
    };
    assert.throws(() => bootstrapM6Qualification({ ...f.args, snapshotDatabase: replacingSnapshot }), {
      code: "M6_QUALIFICATION_BOOTSTRAP_DB_PATH_RACE",
    });
    assert.equal(userVersion(f.dbPath), 18);
    assert.equal(existsSync(join(f.m6Root, "m6-gate", GATE, "current.json")), false);
  } finally { f.cleanup(); }
});

test("bootstrap rejects hardlinked DB/issuer files and an ancestor junction before migration", (t) => {
  const hardDb = fixture();
  try {
    linkSync(hardDb.dbPath, join(hardDb.root, "control-hardlink.db"));
    assert.throws(() => bootstrapM6Qualification(hardDb.args), {
      code: "M6_QUALIFICATION_BOOTSTRAP_DB_PATH_INVALID",
    });
    assert.equal(userVersion(hardDb.dbPath), 18);
  } finally { hardDb.cleanup(); }

  const hardIssuer = fixture();
  try {
    linkSync(hardIssuer.issuerPath, join(hardIssuer.root, "issuer-hardlink.json"));
    assert.throws(() => validateM6QualificationBootstrapPackage({
      package: hardIssuer.pkg,
      issuerAllowlistPath: hardIssuer.issuerPath,
      m6Root: hardIssuer.m6Root,
      nowMs: NOW,
    }), { code: "M6_QUALIFICATION_BOOTSTRAP_ISSUER_INVALID" });
  } finally { hardIssuer.cleanup(); }

  const junction = fixture();
  try {
    const outside = join(junction.root, "plain-backup-target");
    const link = join(junction.root, "backup-junction");
    mkdirSync(outside, { recursive: true });
    try { symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir"); } catch (error) {
      if (process.platform === "win32" && ["EPERM", "EACCES", "UNKNOWN"].includes(error?.code)) {
        t.diagnostic(`exact Windows junction fixture unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    assert.throws(() => bootstrapM6Qualification({ ...junction.args, snapshotDirectory: link }), {
      code: "M6_QUALIFICATION_BOOTSTRAP_DB_SNAPSHOT_INVALID",
    });
    assert.equal(userVersion(junction.dbPath), 18);
  } finally { junction.cleanup(); }
});
