import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { snapshotDatabase } from "../../packages/cutover/lib/db.mjs";
import { canonicalJson, sha256 } from "../../services/control-plane/control-plane/lib/canonical.mjs";
import {
  acquireM6C1StoppedRuntimeGuard,
  acquireM6C1RuntimeOwnerLock,
  m6C1RuntimeOwnerLockPath,
} from "../../services/control-plane/control-plane/lib/m6-c1-runtime-owner-lock.mjs";
import { bootstrapM6Qualification } from "../../services/control-plane/control-plane/lib/m6-qualification-bootstrap.mjs";
import { StateStore } from "../../services/control-plane/control-plane/lib/state-store.mjs";
import {
  RECOVERABLE_PUBLICATION_CUTS,
} from "./lib/recoverable-create-only-publication.mjs";
import {
  assembleM64QualificationBootstrapPackage,
  buildM64QualificationBootstrapSigningDraft,
  M64_QUALIFICATION_INVENTORY_SENTINEL_HASH,
  operateM64QualificationBootstrap,
  planM64QualificationBootstrap,
} from "./m6-4-qualification-bootstrap-operator.mjs";

const NOW = Date.parse("2030-01-01T00:00:05.000Z");
const RELEASE = "xw-m6-c1-qualification-test";
const SOURCE = "a".repeat(40);
const GATE = "m6-c1-qualification-a00000000000";
const ACTOR = "operator:m6-qualification-test";
const LOCKS = Object.freeze({
  runtimeProfile: "1".repeat(64),
  hardRedlinePolicy: "2".repeat(64),
  groundingRuntime: "3".repeat(64),
});

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return path;
}

function makeV18Db(path, { activeJob = false } = {}) {
  mkdirSync(dirname(path), { recursive: true });
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
        "legacy-device", "99", "legacy", "legacy-node", null, "{}",
        '{"enabled":false,"tags":[],"capabilityIds":[]}', 1, 0, NOW - 9_000,
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
    const m6Tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'm6_%'").all();
    for (const { name } of m6Tables) db.exec(`DROP TABLE "${name.replaceAll('"', '""')}"`);
    db.exec("PRAGMA user_version=18");
  } finally {
    db.close();
  }
}

function dbVersion(path) {
  const db = new DatabaseSync(`${pathToFileURL(path).href}?mode=ro&immutable=1`, { readOnly: true });
  try {
    return Number(db.prepare("PRAGMA user_version").get().user_version);
  } finally {
    db.close();
  }
}

function publicAllowlist({ publicKey }) {
  return {
    schemaId: "xw.m6-gate-issuer-allowlist.v1",
    version: 1,
    keys: [{
      keyId: "qualification-key",
      subject: ACTOR,
      publicKey: publicKey.export({ type: "spki", format: "pem" }),
      status: "active",
    }],
  };
}

function epochProof(epochHash, privateKey) {
  return {
    keyId: "qualification-key",
    subject: ACTOR,
    allowlistVersion: 1,
    signature: sign(null, Buffer.from(epochHash, "hex"), privateKey).toString("base64"),
    algorithm: "ed25519",
  };
}

function treeSnapshot(root) {
  const rows = [];
  const visit = (path, relative = "") => {
    if (!existsSync(path)) return;
    const entries = readdirSync(path, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const child = join(path, entry.name);
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        rows.push([rel, "dir"]);
        visit(child, rel);
      } else {
        rows.push([rel, "file", statSync(child).size, sha256(readFileSync(child))]);
      }
    }
  };
  visit(root);
  return canonicalJson(rows);
}

function releaseDependencies({ tcbHash = "4".repeat(64) } = {}) {
  return {
    verifyReleaseManifest: () => ({ ok: true, mismatches: [] }),
    verifyCapabilitySeal: () => ({
      capabilityId: "xiaowei.m6.grounded_run",
      implementationClosureHash: tcbHash,
      tcbManifestRef: "xw.m6-grounded-run.tcb.v1",
    }),
  };
}

function stoppedGuardTracker() {
  const tracker = { acquisitions: 0, releases: 0, retains: 0, held: false };
  tracker.acquire = async ({ ownerKind }) => {
    assert.equal(ownerKind, "QUALIFICATION_BOOTSTRAP");
    tracker.acquisitions += 1;
    tracker.held = true;
    return Object.freeze({
      assertOwned() {
        assert.equal(tracker.held, true);
        return true;
      },
      async release() {
        assert.equal(tracker.held, true);
        tracker.held = false;
        tracker.releases += 1;
      },
      async retainStaleLock() {
        assert.equal(tracker.held, true);
        tracker.held = false;
        tracker.retains += 1;
      },
    });
  };
  return tracker;
}

function fixture({ activeJob = false } = {}) {
  // The production operator intentionally rejects alternate short-name path
  // spellings.  Canonicalize Windows' 8.3-form tmpdir before deriving any
  // bound absolute paths.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "m64-qualification-operator-")));
  const runtimeRoot = join(root, "runtime");
  const releaseRoot = join(root, "release");
  const snapshotRoot = join(root, "snapshots");
  const dbPath = join(runtimeRoot, "state", "control-plane", "control.db");
  makeV18Db(dbPath, { activeJob });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const issuerAllowlistPath = writeJson(
    join(runtimeRoot, "m6-gate", "issuer-keys.json"),
    publicAllowlist({ publicKey }),
  );
  const draft = buildM64QualificationBootstrapSigningDraft({
    releaseId: RELEASE,
    sourceCommit: SOURCE,
    gateId: GATE,
    locksRecord: {
      schemaId: "xw.m6-locks.v1",
      releaseId: RELEASE,
      sourceCommit: SOURCE,
      lockHashes: { ...LOCKS },
    },
    actor: ACTOR,
    rootIssuedAt: "2030-01-01T00:00:00.000Z",
    closeoutCommittedAt: "2030-01-01T00:00:01.000Z",
    closedIssuedAt: "2030-01-01T00:00:02.000Z",
    promotedAt: "2030-01-01T00:00:03.000Z",
    expiresAt: "2030-01-02T00:00:00.000Z",
    issuerAllowlistSha256: sha256(readFileSync(issuerAllowlistPath)),
  });
  const pkg = assembleM64QualificationBootstrapPackage({
    draft,
    rootProof: epochProof(draft.rootEpoch.epochHash, privateKey),
    closedProof: epochProof(draft.closedEpoch.epochHash, privateKey),
    issuerAllowlistPath,
    runtimeRoot,
    nowMs: NOW,
  });
  const bootstrapPackagePath = writeJson(join(root, "handoff", `${pkg.packageHash}.json`), pkg);
  writeJson(join(releaseRoot, "release-manifest.v1.json"), {
    schemaId: "xw.runtime.release-manifest.v1",
    releaseId: RELEASE,
    sourceCommit: SOURCE,
  });
  writeJson(join(releaseRoot, "services", "control-plane", "apps", "xiaowei", "capabilities.json"), {
    capabilities: [{
      id: "xiaowei.m6.grounded_run",
      implementation: {
        adapter: "xiaowei",
        action: "m6_grounded_run",
        tcbManifestRef: "xw.m6-grounded-run.tcb.v1",
        implementationClosureHash: "4".repeat(64),
      },
    }],
  });
  const input = {
    bootstrapPackagePath,
    issuerAllowlistPath,
    releaseRoot,
    runtimeRoot,
    snapshotRoot,
    nowMs: NOW,
  };
  return {
    root,
    runtimeRoot,
    releaseRoot,
    snapshotRoot,
    dbPath,
    issuerAllowlistPath,
    bootstrapPackagePath,
    draft,
    pkg,
    privateKey,
    input,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("default operator preflight verifies package/release/TCB/DB with zero writes", async () => {
  const f = fixture();
  const before = treeSnapshot(f.root);
  try {
    const result = await operateM64QualificationBootstrap(f.input, {
      dependencies: {
        ...releaseDependencies(),
        acquireStoppedRuntimeGuard: async () => {
          throw new Error("read-only preflight must not acquire the mutation guard");
        },
      },
    });
    assert.equal(result.schemaId, "xw.m6-c1-qualification-bootstrap-operator-preflight.v1");
    assert.equal(result.writesPerformed, 0);
    assert.equal(result.databaseVersion, 18);
    assert.equal(result.bindingPresent, false);
    assert.equal(result.gateFArtifactInventoryHash, M64_QUALIFICATION_INVENTORY_SENTINEL_HASH);
    assert.equal(result.privateKeyAccessed, false);
    assert.equal(result.providerAccessed, false);
    assert.equal(result.deviceAccessed, false);
    assert.equal(result.networkAccessed, false);
    assert.equal(treeSnapshot(f.root), before);
    assert.equal(existsSync(f.snapshotRoot), false);
    assert.equal(dbVersion(f.dbPath), 18);
  } finally {
    f.cleanup();
  }
});

test("secret-free draft requires both external signatures and rejects forgery", () => {
  const f = fixture();
  try {
    assert.deepEqual(f.draft.signingRequests.map((request) => request.payloadHex), [
      f.draft.rootEpoch.epochHash,
      f.draft.closedEpoch.epochHash,
    ]);
    assert.equal(JSON.stringify(f.draft).includes("PRIVATE KEY"), false);
    assert.throws(() => assembleM64QualificationBootstrapPackage({
      draft: f.draft,
      rootProof: undefined,
      closedProof: epochProof(f.draft.closedEpoch.epochHash, f.privateKey),
      issuerAllowlistPath: f.issuerAllowlistPath,
      runtimeRoot: f.runtimeRoot,
      nowMs: NOW,
    }), { code: "M64_QUALIFICATION_PROOF_INVALID" });
    assert.throws(() => assembleM64QualificationBootstrapPackage({
      draft: f.draft,
      rootProof: {
        ...epochProof(f.draft.rootEpoch.epochHash, f.privateKey),
        signature: "A".repeat(88),
      },
      closedProof: epochProof(f.draft.closedEpoch.epochHash, f.privateKey),
      issuerAllowlistPath: f.issuerAllowlistPath,
      runtimeRoot: f.runtimeRoot,
      nowMs: NOW,
    }), { code: "M6_GATE_ISSUER_SIGNATURE_INVALID" });
  } finally {
    f.cleanup();
  }
});

test("preflight rejects forged package, wrong release, and wrong TCB before mutation", async () => {
  const forged = fixture();
  try {
    const raw = JSON.parse(readFileSync(forged.bootstrapPackagePath, "utf8"));
    raw.rootEpochRecord.proof.signature = "A".repeat(88);
    const { packageHash: _old, ...body } = raw;
    raw.packageHash = sha256(`xw.m6-c1-qualification-bootstrap-package.v1:${canonicalJson(body)}`);
    writeJson(forged.bootstrapPackagePath, raw);
    await assert.rejects(
      operateM64QualificationBootstrap(forged.input, { dependencies: releaseDependencies() }),
      { code: "M6_GATE_ISSUER_SIGNATURE_INVALID" },
    );
    assert.equal(dbVersion(forged.dbPath), 18);
    assert.equal(existsSync(forged.snapshotRoot), false);
  } finally {
    forged.cleanup();
  }

  const wrongRelease = fixture();
  try {
    writeJson(join(wrongRelease.releaseRoot, "release-manifest.v1.json"), {
      schemaId: "xw.runtime.release-manifest.v1",
      releaseId: "wrong-release",
      sourceCommit: SOURCE,
    });
    await assert.rejects(
      operateM64QualificationBootstrap(wrongRelease.input, { dependencies: releaseDependencies() }),
      { code: "M64_QUALIFICATION_OPERATOR_RELEASE_REBOUND" },
    );
  } finally {
    wrongRelease.cleanup();
  }

  const wrongTcb = fixture();
  try {
    await assert.rejects(
      operateM64QualificationBootstrap(wrongTcb.input, {
        dependencies: releaseDependencies({ tcbHash: "0".repeat(64) }),
      }),
      { code: "M64_QUALIFICATION_OPERATOR_TCB_INVALID" },
    );
  } finally {
    wrongTcb.cleanup();
  }
});

test("active resources, snapshot overlap, and a materialized sentinel fail closed", async () => {
  const active = fixture({ activeJob: true });
  try {
    await assert.rejects(
      operateM64QualificationBootstrap(active.input, { dependencies: releaseDependencies() }),
      { code: "M64_QUALIFICATION_OPERATOR_RESOURCES_NOT_ZERO" },
    );
    assert.equal(dbVersion(active.dbPath), 18);
  } finally {
    active.cleanup();
  }

  const overlap = fixture();
  try {
    await assert.rejects(
      operateM64QualificationBootstrap({
        ...overlap.input,
        snapshotRoot: join(overlap.runtimeRoot, "backups"),
      }, { dependencies: releaseDependencies() }),
      { code: "M64_QUALIFICATION_OPERATOR_SNAPSHOT_ROOT_INVALID" },
    );
  } finally {
    overlap.cleanup();
  }

  const sentinel = fixture();
  try {
    writeJson(join(sentinel.runtimeRoot, "qualification-bootstrap", "final-inventory-unavailable.json"), {
      forbidden: true,
    });
    await assert.rejects(
      operateM64QualificationBootstrap(sentinel.input, { dependencies: releaseDependencies() }),
      { code: "M64_QUALIFICATION_OPERATOR_SENTINEL_PRESENT" },
    );
  } finally {
    sentinel.cleanup();
  }
});

test("execute holds the shared guard, writes exact nine-key binding, then content-addressed receipt", async () => {
  const f = fixture();
  const guard = stoppedGuardTracker();
  const dependencies = {
    ...releaseDependencies(),
    acquireStoppedRuntimeGuard: guard.acquire,
    bootstrapQualification(args) {
      assert.equal(guard.held, true);
      return bootstrapM6Qualification(args);
    },
  };
  try {
    const first = await operateM64QualificationBootstrap(f.input, { execute: true, dependencies });
    assert.equal(first.status, "BOOTSTRAPPED");
    assert.equal(guard.acquisitions, 1);
    assert.equal(guard.releases, 1);
    assert.equal(guard.held, false);
    assert.equal(dbVersion(f.dbPath), 20);
    assert.equal(existsSync(first.snapshotPath), true);
    assert.equal(first.snapshotPath.startsWith(f.snapshotRoot), true);
    assert.equal(existsSync(join(f.runtimeRoot, "qualification-bootstrap", "final-inventory-unavailable.json")), false);
    const binding = JSON.parse(readFileSync(first.bindingPath, "utf8"));
    assert.deepEqual(Object.keys(binding).sort(), [
      "gateFArtifactInventoryHash", "gateFArtifactInventoryPath", "gateId", "gateIssuerAllowlistPath",
      "releaseId", "releaseManifestSha256", "schemaId", "sourceCommit", "sourceReleaseRoot",
    ].sort());
    assert.equal(binding.gateFArtifactInventoryHash, M64_QUALIFICATION_INVENTORY_SENTINEL_HASH);
    assert.equal(existsSync(first.receiptPath), true);
    assert.equal(first.receiptPath.endsWith(`${first.receipt.receiptHash}.json`), true);
    assert.equal(first.receipt.secretMaterialPresent, false);
    assert.equal(first.receipt.deviceAccessed, false);
    assert.equal(first.receipt.networkAccessed, false);

    const replay = await operateM64QualificationBootstrap(f.input, { execute: true, dependencies });
    assert.equal(replay.status, "EXACT_REPLAY");
    assert.equal(replay.receipt.receiptHash, first.receipt.receiptHash);
    assert.equal(replay.receiptPath, first.receiptPath);
  } finally {
    f.cleanup();
  }
});

test("crash after bootstrap or binding recovers idempotently without resnapshotting", async () => {
  const afterBootstrap = fixture();
  const guardA = stoppedGuardTracker();
  let snapshotCallsA = 0;
  const depsA = {
    ...releaseDependencies(),
    acquireStoppedRuntimeGuard: guardA.acquire,
    snapshotDatabase(request) {
      snapshotCallsA += 1;
      return snapshotDatabase(request);
    },
  };
  try {
    await assert.rejects(
      operateM64QualificationBootstrap(afterBootstrap.input, {
        execute: true,
        dependencies: depsA,
        publicationFaultAfter(stage) {
          if (stage === "bootstrap") throw Object.assign(new Error("crash"), { code: "TEST_CRASH" });
        },
      }),
      { code: "TEST_CRASH" },
    );
    assert.equal(dbVersion(afterBootstrap.dbPath), 20);
    assert.equal(snapshotCallsA, 1);
    assert.equal(existsSync(join(afterBootstrap.runtimeRoot, "config", "m6-c1-qualification-bootstrap.v1.json")), false);
    const recovered = await operateM64QualificationBootstrap(afterBootstrap.input, {
      execute: true,
      dependencies: {
        ...depsA,
        snapshotDatabase() {
          throw new Error("persisted snapshot receipt must be reused");
        },
      },
    });
    assert.equal(recovered.status, "RECOVERED_AFTER_BOOTSTRAP");
    assert.equal(snapshotCallsA, 1);
  } finally {
    afterBootstrap.cleanup();
  }

  const afterBinding = fixture();
  const guardB = stoppedGuardTracker();
  const depsB = { ...releaseDependencies(), acquireStoppedRuntimeGuard: guardB.acquire };
  try {
    await assert.rejects(
      operateM64QualificationBootstrap(afterBinding.input, {
        execute: true,
        dependencies: depsB,
        publicationFaultAfter(stage) {
          if (stage === "binding") throw Object.assign(new Error("crash"), { code: "TEST_CRASH" });
        },
      }),
      { code: "TEST_CRASH" },
    );
    const bindingPath = join(afterBinding.runtimeRoot, "config", "m6-c1-qualification-bootstrap.v1.json");
    assert.equal(existsSync(bindingPath), true);
    assert.equal(existsSync(join(afterBinding.runtimeRoot, "qualification-bootstrap", "receipts")), false);
    const recovered = await operateM64QualificationBootstrap(afterBinding.input, {
      execute: true,
      dependencies: depsB,
    });
    assert.equal(recovered.status, "RECOVERED_RECEIPT");
  } finally {
    afterBinding.cleanup();
  }
});

test("operator recovers every binding publication cut, including paired nlink=2, through its normal retry", async (t) => {
  for (const cut of RECOVERABLE_PUBLICATION_CUTS) {
    await t.test(cut, async () => {
      const f = fixture();
      const guard = stoppedGuardTracker();
      const dependencies = { ...releaseDependencies(), acquireStoppedRuntimeGuard: guard.acquire };
      let pendingPath = null;
      try {
        const crash = Object.assign(new Error(`binding publication crash:${cut}`), {
          code: `TEST_QUALIFICATION_${cut}`,
        });
        await assert.rejects(() => operateM64QualificationBootstrap(f.input, {
          execute: true,
          dependencies,
          publicationFaultAfter(stage, context) {
            if (stage === `binding:${cut}`) {
              pendingPath = context.pendingPath;
              throw crash;
            }
          },
        }), { code: crash.code });
        assert.equal(typeof pendingPath, "string");
        assert.equal(guard.releases, 1, "successful core cleanup permits release after publication failure");
        assert.equal(guard.retains, 0);

        const crashedPlan = planM64QualificationBootstrap(f.input, releaseDependencies());
        const publicationComplete = new Set(["PENDING_UNLINKED", "DIRECTORY_FSYNCED"]).has(cut);
        assert.equal(crashedPlan.bindingNeedsRecovery, !publicationComplete);
        if (cut === "FINAL_PUBLISHED") {
          assert.equal(crashedPlan.bindingPresent, true);
          assert.equal(lstatSync(crashedPlan.bindingPath, { bigint: true }).nlink, 2n);
          assert.equal(lstatSync(pendingPath, { bigint: true }).nlink, 2n);
        }

        const recovered = await operateM64QualificationBootstrap(f.input, {
          execute: true,
          dependencies,
        });
        assert.equal(existsSync(recovered.bindingPath), true);
        assert.equal(lstatSync(recovered.bindingPath, { bigint: true }).nlink, 1n);
        assert.equal(existsSync(pendingPath), false);
        const finalPlan = planM64QualificationBootstrap(f.input, releaseDependencies());
        assert.equal(finalPlan.bindingPresent, true);
        assert.equal(finalPlan.bindingNeedsRecovery, false);
      } finally { f.cleanup(); }
    });
  }
});

test("operator releases only cleanup-verified bootstrap failures and otherwise retains the stale owner lock", async () => {
  const unproven = fixture();
  const unprovenGuard = stoppedGuardTracker();
  try {
    await assert.rejects(() => operateM64QualificationBootstrap(unproven.input, {
      execute: true,
      dependencies: {
        ...releaseDependencies(),
        acquireStoppedRuntimeGuard: unprovenGuard.acquire,
        bootstrapQualification() {
          throw Object.assign(new Error("unproven bootstrap cleanup"), { code: "TEST_UNPROVEN_CLEANUP" });
        },
      },
    }), { code: "TEST_UNPROVEN_CLEANUP" });
    assert.equal(unprovenGuard.releases, 0);
    assert.equal(unprovenGuard.retains, 1);
  } finally { unproven.cleanup(); }

  const verified = fixture();
  const verifiedGuard = stoppedGuardTracker();
  try {
    await assert.rejects(() => operateM64QualificationBootstrap(verified.input, {
      execute: true,
      dependencies: {
        ...releaseDependencies(),
        acquireStoppedRuntimeGuard: verifiedGuard.acquire,
        bootstrapQualification(args) {
          return bootstrapM6Qualification({ ...args, faultAfter: "migration" });
        },
      },
    }), { code: "M6_QUALIFICATION_BOOTSTRAP_FAULT" });
    assert.equal(verifiedGuard.releases, 1);
    assert.equal(verifiedGuard.retains, 0);
  } finally { verified.cleanup(); }
});

test("operator unproven cleanup retains the production stale lock and blocks the next owner", async () => {
  const f = fixture();
  const lockPath = m6C1RuntimeOwnerLockPath(f.runtimeRoot);
  try {
    await assert.rejects(() => operateM64QualificationBootstrap(f.input, {
      execute: true,
      dependencies: {
        ...releaseDependencies(),
        acquireStoppedRuntimeGuard(args) {
          return acquireM6C1StoppedRuntimeGuard({ ...args, port: 0 });
        },
        bootstrapQualification() {
          throw Object.assign(new Error("unproven production cleanup"), { code: "TEST_UNPROVEN_PRODUCTION_CLEANUP" });
        },
      },
    }), { code: "TEST_UNPROVEN_PRODUCTION_CLEANUP" });
    assert.equal(existsSync(lockPath), true);
    await assert.rejects(() => acquireM6C1StoppedRuntimeGuard({
      runtimeRoot: f.runtimeRoot,
      ownerKind: "STAGE_LIVE_WINDOW",
      port: 0,
    }), { code: "M6_C1_RUNTIME_OWNER_LOCKED" });
  } finally { f.cleanup(); }
});

test("snapshot callback escape and binding drift are rejected without publishing a receipt", async () => {
  const escaped = fixture();
  const guard = stoppedGuardTracker();
  try {
    await assert.rejects(
      operateM64QualificationBootstrap(escaped.input, {
        execute: true,
        dependencies: {
          ...releaseDependencies(),
          acquireStoppedRuntimeGuard: guard.acquire,
          snapshotDatabase(request) {
            const raw = snapshotDatabase(request);
            const outside = join(escaped.root, "escaped.snapshot.db");
            copyFileSync(raw.snapshot.path, outside);
            return { ...raw, snapshot: { ...raw.snapshot, path: outside } };
          },
        },
      }),
      { code: "M6_QUALIFICATION_BOOTSTRAP_DB_SNAPSHOT_INVALID" },
    );
    assert.equal(dbVersion(escaped.dbPath), 18);
    assert.equal(existsSync(join(escaped.runtimeRoot, "config", "m6-c1-qualification-bootstrap.v1.json")), false);
  } finally {
    escaped.cleanup();
  }

  const drift = fixture();
  const guard2 = stoppedGuardTracker();
  const deps = { ...releaseDependencies(), acquireStoppedRuntimeGuard: guard2.acquire };
  try {
    const result = await operateM64QualificationBootstrap(drift.input, { execute: true, dependencies: deps });
    writeJson(result.bindingPath, { drifted: true });
    await assert.rejects(
      operateM64QualificationBootstrap(drift.input, { dependencies: releaseDependencies() }),
      { code: "M64_QUALIFICATION_OPERATOR_BINDING_DRIFT" },
    );
  } finally {
    drift.cleanup();
  }
});

test("operator refuses execute when the shared M6-C1 runtime owner lock is held", async () => {
  const f = fixture();
  const owner = acquireM6C1RuntimeOwnerLock({
    runtimeRoot: f.runtimeRoot,
    ownerKind: "CONTROL_PLANE_M6_C1",
    ownerNonce: "control-plane-test-owner-0001",
    nowMs: NOW,
  });
  let bootstrapCalls = 0;
  try {
    await assert.rejects(
      operateM64QualificationBootstrap(f.input, {
        execute: true,
        dependencies: {
          ...releaseDependencies(),
          async acquireStoppedRuntimeGuard({ runtimeRoot }) {
            const contender = acquireM6C1RuntimeOwnerLock({
              runtimeRoot,
              ownerKind: "QUALIFICATION_BOOTSTRAP",
              ownerNonce: "qualification-test-owner-0001",
              nowMs: NOW,
            });
            return {
              assertOwned: () => contender.assertOwned(),
              release: async () => contender.release(),
            };
          },
          bootstrapQualification(args) {
            bootstrapCalls += 1;
            return bootstrapM6Qualification(args);
          },
        },
      }),
      { code: "M6_C1_RUNTIME_OWNER_LOCKED" },
    );
    assert.equal(bootstrapCalls, 0);
    assert.equal(dbVersion(f.dbPath), 18);
    assert.equal(existsSync(f.snapshotRoot), false);
  } finally {
    owner.release();
    f.cleanup();
  }
});

test("binding published ahead of the v18 DB fence is rejected even when its bytes are exact", () => {
  const f = fixture();
  try {
    const preflight = planM64QualificationBootstrap(f.input, releaseDependencies());
    writeJson(preflight.paths.bindingPath, preflight.binding);
    assert.throws(
      () => planM64QualificationBootstrap(f.input, releaseDependencies()),
      { code: "M64_QUALIFICATION_OPERATOR_BINDING_AHEAD" },
    );
    assert.equal(dbVersion(f.dbPath), 18);
  } finally {
    f.cleanup();
  }
});
