import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { sha256 } from "../control-plane/lib/canonical.mjs";
import {
  main,
  M64_QUALIFICATION_LEGACY_DATABASE_TCB_SELF_RELEASE_PATH,
  parseM64QualificationLegacyDatabaseTcbProvisionFixedArgs,
  provisionM64QualificationLegacyDatabaseTcbFixed,
} from "../ops/m6-qualification-legacy-database-tcb-provision-fixed.mjs";

const EXECUTING_RELEASE_ID = "xw-successor-database-fixture";
const LEGACY_RELEASE_ID = "xw-legacy-database-fixture";

function samePath(left, right) {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function writeRelease(releasesRoot, {
  releaseId,
  sourceCommit,
  sourceTreeSha,
  includeProvisioner = false,
}) {
  const root = join(releasesRoot, releaseId);
  mkdirSync(root, { recursive: true });
  const files = [];
  let operatorPath = null;
  if (includeProvisioner) {
    operatorPath = join(root, ...M64_QUALIFICATION_LEGACY_DATABASE_TCB_SELF_RELEASE_PATH.split("/"));
    mkdirSync(dirname(operatorPath), { recursive: true });
    const bytes = Buffer.from("export const formalFixture = true;\n", "utf8");
    writeFileSync(operatorPath, bytes);
    files.push({
      path: M64_QUALIFICATION_LEGACY_DATABASE_TCB_SELF_RELEASE_PATH,
      sha256: sha256(bytes),
    });
  }
  const manifest = {
    schemaId: "xw.runtime.release-manifest.v1",
    releaseId,
    sourceCommit,
    sourceTreeSha,
    files,
  };
  const manifestPath = join(root, "release-manifest.v1.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { root, operatorPath, manifestPath };
}

function linkCurrent(runtimeRoot, target) {
  const currentPath = join(runtimeRoot, "current");
  try { unlinkSync(currentPath); } catch {}
  symlinkSync(target, currentPath, process.platform === "win32" ? "junction" : "dir");
  return currentPath;
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "xw-m64-legacy-database-tcb-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtimeRoot = join(root, "runtime");
  const releasesRoot = join(runtimeRoot, "releases");
  mkdirSync(releasesRoot, { recursive: true });
  const executing = writeRelease(releasesRoot, {
    releaseId: EXECUTING_RELEASE_ID,
    sourceCommit: "a".repeat(40),
    sourceTreeSha: "b".repeat(40),
    includeProvisioner: true,
  });
  const legacy = writeRelease(releasesRoot, {
    releaseId: LEGACY_RELEASE_ID,
    sourceCommit: "c".repeat(40),
    sourceTreeSha: "d".repeat(40),
  });
  const other = writeRelease(releasesRoot, {
    releaseId: "xw-other-database-fixture",
    sourceCommit: "e".repeat(40),
    sourceTreeSha: "f".repeat(40),
  });
  linkCurrent(runtimeRoot, legacy.root);
  const databases = {
    controlDb: join(runtimeRoot, "state", "control-plane", "control.db"),
    registryDb: join(runtimeRoot, "state", "orchestrator", "registry.db"),
  };
  for (const [key, path] of Object.entries(databases)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(`SQLite format 3\u0000${key}\n`, "utf8"));
    writeFileSync(`${path}-wal`, Buffer.from(`wal:${key}\n`, "utf8"));
    writeFileSync(`${path}-shm`, Buffer.from(`shm:${key}\n`, "utf8"));
  }
  return { runtimeRoot, executing, legacy, other, databases };
}

function manifestVerifier() {
  const calls = [];
  return {
    calls,
    verify({ manifestPath, root }) {
      calls.push({ manifestPath, root });
      return { ok: true, mismatches: [] };
    },
  };
}

function targetKey(f, path) {
  if (samePath(path, f.executing.root)) return "executing";
  if (samePath(path, f.legacy.root)) return "legacy";
  if (samePath(path, dirname(f.databases.controlDb))) return "controlState";
  if (samePath(path, dirname(f.databases.registryDb))) return "registryState";
  if (samePath(path, f.databases.controlDb)) return "controlDb";
  if (samePath(path, f.databases.registryDb)) return "registryDb";
  return "unknown";
}

function recordingController(f, {
  initialErrors = {},
  onProtect = null,
  onVerify = null,
} = {}) {
  const calls = [];
  const verifyCounts = new Map();
  const recordVerify = (operation, plan) => {
    const key = targetKey(f, plan.targetPath);
    const count = (verifyCounts.get(key) ?? 0) + 1;
    verifyCounts.set(key, count);
    calls.push({ operation, key, ...plan });
    onVerify?.({ key, count, operation, plan });
    if (count === 1 && Object.hasOwn(initialErrors, key)) {
      const error = new Error("native fixture rejection");
      if (initialErrors[key] !== undefined) error.code = initialErrors[key];
      throw error;
    }
    return { ok: true, entryCount: plan.recursive ? 9 : 1 };
  };
  const verify = (plan) => recordVerify("verify", plan);
  const verifyTarget = (plan) => recordVerify("verify-target", plan);
  const protect = (plan) => {
    const key = targetKey(f, plan.targetPath);
    calls.push({ operation: "protect", key, ...plan });
    onProtect?.({ key, operation: "protect", plan });
    return { ok: true, entryCount: 1 };
  };
  const protectTarget = (plan) => {
    const key = targetKey(f, plan.targetPath);
    calls.push({ operation: "protect-target", key, ...plan });
    onProtect?.({ key, operation: "protect-target", plan });
    return { ok: true, entryCount: 1 };
  };
  return { calls, protect, protectTarget, verify, verifyTarget };
}

function run(f, {
  manifest = manifestVerifier(),
  controller = recordingController(f),
} = {}) {
  const result = provisionM64QualificationLegacyDatabaseTcbFixed({
    runtimeRoot: f.runtimeRoot,
    operatorPath: f.executing.operatorPath,
    verifyManifest: manifest.verify,
    tcbAclController: controller,
  });
  return { result, manifest, controller };
}

test("fixed legacy-database TCB CLI exposes no caller-selected path or identity", () => {
  assert.deepEqual(parseM64QualificationLegacyDatabaseTcbProvisionFixedArgs([]), { provision: true });
  for (const argv of [
    ["--runtime-root", "C:\\attacker"],
    ["--database", "control.db"],
    ["C:\\attacker\\database"],
    [LEGACY_RELEASE_ID, "c".repeat(40)],
  ]) {
    assert.throws(() => parseM64QualificationLegacyDatabaseTcbProvisionFixedArgs(argv), {
      code: "M64_QUALIFICATION_LEGACY_DATABASE_TCB_CLI_INVALID",
    });
  }
});

test("both databases preflight before exact target-DACL migrations protect the fixed files", (t) => {
  const f = fixture(t);
  const manifest = manifestVerifier();
  const controller = recordingController(f, {
    initialErrors: {
      controlState: "SYSTEM_TCB_ACL_TARGET_DACL_INVALID",
      registryState: "SYSTEM_TCB_ACL_TARGET_DACL_INVALID",
      controlDb: "SYSTEM_TCB_ACL_TARGET_DACL_INVALID",
      registryDb: "SYSTEM_TCB_ACL_TARGET_DACL_INVALID",
    },
  });
  const { result } = run(f, { manifest, controller });
  assert.equal(result.status, "VERIFIED");
  assert.equal(result.directoryClosureCount, 2);
  assert.equal(result.normalizedDirectoryClosureCount, 2);
  assert.equal(result.databaseCount, 2);
  assert.equal(result.normalizedCount, 2);
  assert.deepEqual(result.databases.map((row) => [row.key, row.normalized, row.entryCount]), [
    ["controlDb", true, 1],
    ["registryDb", true, 1],
  ]);
  assert.match(result.receiptHash, /^[0-9a-f]{64}$/u);
  assert.deepEqual(controller.calls.map((row) => [row.operation, row.key, row.recursive]), [
    ["verify", "executing", true],
    ["verify", "legacy", true],
    ["verify", "controlState", false],
    ["verify", "registryState", false],
    ["verify-target", "controlDb", false],
    ["verify-target", "registryDb", false],
    ["protect", "controlState", false],
    ["protect", "registryState", false],
    ["verify", "controlState", false],
    ["verify", "registryState", false],
    ["verify", "controlState", false],
    ["protect-target", "controlDb", false],
    ["verify", "registryState", false],
    ["protect-target", "registryDb", false],
    ["verify", "controlDb", false],
    ["verify", "registryDb", false],
  ]);
  assert.deepEqual(manifest.calls.map((row) => resolve(row.root)), [
    resolve(f.executing.root),
    resolve(f.legacy.root),
    resolve(f.legacy.root),
  ]);
  assert.doesNotMatch(JSON.stringify(result), /[\\/]|path|root|secret|private/iu);

  let stdout = "";
  const replay = main([], {
    stdout: { write(value) { stdout += value; } },
    dependencies: {
      runtimeRoot: f.runtimeRoot,
      operatorPath: f.executing.operatorPath,
      verifyManifest: manifestVerifier().verify,
      tcbAclController: recordingController(f),
    },
  });
  assert.deepEqual(JSON.parse(stdout), replay);
  assert.doesNotMatch(stdout, /[\\/]|path|root|secret|private/iu);
});

test("a non-exact error on either database prevents every protect", (t) => {
  for (const errorCode of [
    "SYSTEM_TCB_ACL_STRUCTURE_INVALID",
    "SYSTEM_TCB_ACL_TARGET_DACL_INVALID_SUFFIX",
    "system_tcb_acl_target_dacl_invalid",
    undefined,
  ]) {
    const f = fixture(t);
    const controller = recordingController(f, {
      initialErrors: {
        controlDb: "SYSTEM_TCB_ACL_TARGET_DACL_INVALID",
        registryDb: errorCode,
      },
    });
    assert.throws(() => run(f, { controller }), {
      code: "M64_QUALIFICATION_LEGACY_DATABASE_TCB_VERIFICATION_FAILED",
    });
    assert.equal(controller.calls.filter((row) => row.operation.startsWith("protect")).length, 0);
  }
});

test("current drift after database preflight prevents every protect", (t) => {
  const f = fixture(t);
  const controller = recordingController(f, {
    initialErrors: {
      controlDb: "SYSTEM_TCB_ACL_TARGET_DACL_INVALID",
      registryDb: "SYSTEM_TCB_ACL_TARGET_DACL_INVALID",
    },
    onVerify({ key, count }) {
      if (key === "registryDb" && count === 1) linkCurrent(f.runtimeRoot, f.other.root);
    },
  });
  assert.throws(() => run(f, { controller }), {
    code: "M64_QUALIFICATION_LEGACY_DATABASE_TCB_CURRENT_DRIFT",
  });
  assert.equal(controller.calls.filter((row) => row.operation.startsWith("protect")).length, 0);
});

test("already-protected databases verify twice without protect", (t) => {
  const f = fixture(t);
  const { result, controller } = run(f);
  assert.equal(result.normalizedCount, 0);
  assert.equal(result.normalizedDirectoryClosureCount, 0);
  assert.equal(controller.calls.filter((row) => row.operation === "protect").length, 0);
  assert.equal(controller.calls.filter((row) => row.operation === "protect-target").length, 0);
  assert.equal(controller.calls.filter((row) => row.key === "controlDb").length, 2);
  assert.equal(controller.calls.filter((row) => row.key === "registryDb").length, 2);
});

test("DB or sidecar byte drift after an ACL operation fails closed", (t) => {
  const mutations = [
    (f) => writeFileSync(f.databases.controlDb, Buffer.from("SQLite format 3\u0000drift\n", "utf8")),
    (f) => writeFileSync(`${f.databases.controlDb}-wal`, Buffer.from("wal-drift\n", "utf8")),
  ];
  for (const mutate of mutations) {
    const f = fixture(t);
    const controller = recordingController(f, {
      initialErrors: { controlState: "SYSTEM_TCB_ACL_TARGET_DACL_INVALID" },
      onProtect({ key }) {
        if (key === "controlState") mutate(f);
      },
    });
    assert.throws(() => run(f, { controller }), {
      code: "M64_QUALIFICATION_LEGACY_DATABASE_TCB_CONTENT_DRIFT",
    });
    assert.equal(controller.calls.filter((row) => row.operation === "protect-target").length, 0);
  }
});

test("executing provisioner must match its full formal manifest", (t) => {
  const f = fixture(t);
  writeFileSync(f.executing.operatorPath, "export const drifted = true;\n");
  const controller = recordingController(f);
  assert.throws(() => run(f, { controller }), {
    code: "M64_QUALIFICATION_LEGACY_DATABASE_TCB_EXECUTING_RELEASE_INVALID",
  });
  assert.equal(controller.calls.length, 0);
});
