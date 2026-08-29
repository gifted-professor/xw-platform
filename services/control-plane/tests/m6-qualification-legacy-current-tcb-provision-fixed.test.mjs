import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
  M64_QUALIFICATION_LEGACY_CURRENT_TCB_SELF_RELEASE_PATH,
  parseM64QualificationLegacyCurrentTcbProvisionFixedArgs,
  provisionM64QualificationLegacyCurrentTcbFixed,
} from "../ops/m6-qualification-legacy-current-tcb-provision-fixed.mjs";

const EXECUTING_RELEASE_ID = "xw-successor-fixture";
const LEGACY_RELEASE_ID = "xw-legacy-fixture";

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
    operatorPath = join(root, ...M64_QUALIFICATION_LEGACY_CURRENT_TCB_SELF_RELEASE_PATH.split("/"));
    mkdirSync(dirname(operatorPath), { recursive: true });
    const bytes = Buffer.from("export const formalFixture = true;\n", "utf8");
    writeFileSync(operatorPath, bytes);
    files.push({
      path: M64_QUALIFICATION_LEGACY_CURRENT_TCB_SELF_RELEASE_PATH,
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
  return { root, operatorPath, manifestPath, manifest };
}

function linkCurrent(runtimeRoot, target) {
  const currentPath = join(runtimeRoot, "current");
  try { unlinkSync(currentPath); } catch {}
  symlinkSync(target, currentPath, process.platform === "win32" ? "junction" : "dir");
  return currentPath;
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "xw-m64-legacy-current-tcb-"));
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
    releaseId: "xw-other-fixture",
    sourceCommit: "e".repeat(40),
    sourceTreeSha: "f".repeat(40),
  });
  const currentPath = linkCurrent(runtimeRoot, legacy.root);
  return { runtimeRoot, releasesRoot, executing, legacy, other, currentPath };
}

function manifestVerifier({ rejectLegacyCall = null } = {}) {
  const calls = [];
  let legacyCalls = 0;
  const verify = ({ manifestPath, root }) => {
    calls.push({ manifestPath, root });
    if (root.endsWith(LEGACY_RELEASE_ID)) {
      legacyCalls += 1;
      if (legacyCalls === rejectLegacyCall) return { ok: false, mismatches: ["fixture"] };
    }
    return { ok: true, mismatches: [] };
  };
  return { calls, verify };
}

function recordingController(f, {
  legacyInitialError = null,
  beforeLegacyVerify = null,
} = {}) {
  const calls = [];
  let legacyVerifyCount = 0;
  const verify = (plan) => {
    calls.push({ operation: "verify", ...plan });
    if (samePath(plan.targetPath, f.legacy.root)) {
      legacyVerifyCount += 1;
      beforeLegacyVerify?.(legacyVerifyCount);
      if (legacyVerifyCount === 1 && legacyInitialError !== null) {
        const error = new Error("native fixture rejection");
        if (legacyInitialError !== undefined) error.code = legacyInitialError;
        throw error;
      }
    }
    return { ok: true, entryCount: 11 };
  };
  const protect = (plan) => {
    calls.push({ operation: "protect", ...plan });
    return { ok: true, entryCount: 11 };
  };
  return { calls, verify, protect };
}

function run(f, { manifest = manifestVerifier(), controller = recordingController(f) } = {}) {
  const result = provisionM64QualificationLegacyCurrentTcbFixed({
    runtimeRoot: f.runtimeRoot,
    operatorPath: f.executing.operatorPath,
    verifyManifest: manifest.verify,
    tcbAclController: controller,
  });
  return { result, manifest, controller };
}

test("fixed legacy-current TCB CLI exposes no caller-selected path or identity", () => {
  assert.deepEqual(parseM64QualificationLegacyCurrentTcbProvisionFixedArgs([]), { provision: true });
  for (const argv of [
    ["--runtime-root", "C:\\attacker"],
    ["--release", LEGACY_RELEASE_ID],
    ["C:\\attacker\\release"],
    [LEGACY_RELEASE_ID, "c".repeat(40)],
  ]) {
    assert.throws(() => parseM64QualificationLegacyCurrentTcbProvisionFixedArgs(argv), {
      code: "M64_QUALIFICATION_LEGACY_CURRENT_TCB_CLI_INVALID",
    });
  }
});

test("only the exact native target-DACL migration error protects current once", (t) => {
  const f = fixture(t);
  const manifest = manifestVerifier();
  const controller = recordingController(f, {
    legacyInitialError: "SYSTEM_TCB_ACL_TARGET_DACL_INVALID",
  });
  const { result } = run(f, { manifest, controller });

  assert.equal(result.status, "VERIFIED");
  assert.equal(result.normalized, true);
  assert.equal(result.operatorReleaseId, EXECUTING_RELEASE_ID);
  assert.equal(result.legacyReleaseId, LEGACY_RELEASE_ID);
  assert.equal(result.entryCount, 11);
  assert.match(result.receiptHash, /^[0-9a-f]{64}$/u);
  assert.deepEqual(manifest.calls.map((row) => resolve(row.root)), [
    resolve(f.executing.root),
    resolve(f.legacy.root),
    resolve(f.legacy.root),
  ]);
  assert.deepEqual(controller.calls.map((row) => [
    row.operation,
    samePath(row.targetPath, f.executing.root) ? "executing" : "legacy",
    row.recursive,
  ]), [
    ["verify", "executing", true],
    ["verify", "legacy", true],
    ["protect", "legacy", true],
    ["verify", "legacy", true],
  ]);
  const publicJson = JSON.stringify(result);
  assert.doesNotMatch(publicJson, /[\\/]|path|root|secret|private/iu);

  let stdout = "";
  const replayManifest = manifestVerifier();
  const replayController = recordingController(f);
  const replay = main([], {
    stdout: { write(value) { stdout += value; } },
    dependencies: {
      runtimeRoot: f.runtimeRoot,
      operatorPath: f.executing.operatorPath,
      verifyManifest: replayManifest.verify,
      tcbAclController: replayController,
    },
  });
  assert.deepEqual(JSON.parse(stdout), replay);
  assert.doesNotMatch(stdout, /[\\/]|path|root|secret|private/iu);
});

test("every non-exact native verification error fails with zero protect", (t) => {
  for (const code of [
    "SYSTEM_TCB_ACL_STRUCTURE_INVALID",
    "SYSTEM_TCB_ACL_REPARSE_FORBIDDEN",
    "SYSTEM_TCB_ACL_TARGET_DACL_INVALID_SUFFIX",
    "system_tcb_acl_target_dacl_invalid",
    false,
  ]) {
    const f = fixture(t);
    const controller = recordingController(f, { legacyInitialError: code });
    assert.throws(() => run(f, { controller }), {
      code: "M64_QUALIFICATION_LEGACY_CURRENT_TCB_VERIFICATION_FAILED",
    });
    assert.equal(controller.calls.filter((row) => row.operation === "protect").length, 0);
  }
});

test("manifest verification brackets ACL migration and fails closed", (t) => {
  const pre = fixture(t);
  const preManifest = manifestVerifier({ rejectLegacyCall: 1 });
  const preController = recordingController(pre, {
    legacyInitialError: "SYSTEM_TCB_ACL_TARGET_DACL_INVALID",
  });
  assert.throws(() => run(pre, { manifest: preManifest, controller: preController }), {
    code: "M64_QUALIFICATION_LEGACY_CURRENT_TCB_CURRENT_INVALID",
  });
  assert.equal(preController.calls.filter((row) => row.operation === "protect").length, 0);

  const post = fixture(t);
  const postManifest = manifestVerifier({ rejectLegacyCall: 2 });
  const postController = recordingController(post, {
    legacyInitialError: "SYSTEM_TCB_ACL_TARGET_DACL_INVALID",
  });
  assert.throws(() => run(post, { manifest: postManifest, controller: postController }), {
    code: "M64_QUALIFICATION_LEGACY_CURRENT_TCB_POSTVERIFY_FAILED",
  });
  assert.equal(postController.calls.filter((row) => row.operation === "protect").length, 1);
});

test("current CAS rejects drift before protect and after final verification", (t) => {
  const before = fixture(t);
  const beforeController = recordingController(before, {
    legacyInitialError: "SYSTEM_TCB_ACL_TARGET_DACL_INVALID",
    beforeLegacyVerify(count) {
      if (count === 1) linkCurrent(before.runtimeRoot, before.other.root);
    },
  });
  assert.throws(() => run(before, { controller: beforeController }), {
    code: "M64_QUALIFICATION_LEGACY_CURRENT_TCB_CURRENT_DRIFT",
  });
  assert.equal(beforeController.calls.filter((row) => row.operation === "protect").length, 0);

  const after = fixture(t);
  const afterController = recordingController(after, {
    legacyInitialError: "SYSTEM_TCB_ACL_TARGET_DACL_INVALID",
    beforeLegacyVerify(count) {
      if (count === 2) linkCurrent(after.runtimeRoot, after.other.root);
    },
  });
  assert.throws(() => run(after, { controller: afterController }), {
    code: "M64_QUALIFICATION_LEGACY_CURRENT_TCB_CURRENT_DRIFT",
  });
  assert.equal(afterController.calls.filter((row) => row.operation === "protect").length, 1);
});

test("an already-protected legacy current verifies without protect", (t) => {
  const f = fixture(t);
  const { result, controller } = run(f);
  assert.equal(result.normalized, false);
  assert.equal(controller.calls.filter((row) => row.operation === "protect").length, 0);
  assert.equal(controller.calls.filter(
    (row) => row.operation === "verify" && samePath(row.targetPath, f.legacy.root),
  ).length, 2);
});

test("executing provisioner must match its full formal manifest", (t) => {
  const f = fixture(t);
  writeFileSync(f.executing.operatorPath, "export const drifted = true;\n");
  const controller = recordingController(f);
  assert.throws(() => run(f, { controller }), {
    code: "M64_QUALIFICATION_LEGACY_CURRENT_TCB_EXECUTING_RELEASE_INVALID",
  });
  assert.equal(controller.calls.length, 0);
});

test("legacy-window current inspection remains read-only", () => {
  const source = readFileSync(
    new URL("../ops/m6-qualification-legacy-window-operator.mjs", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("function inspectCurrentRelease");
  const end = source.indexOf("\nfunction inspectTargetRelease", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const body = source.slice(start, end);
  assert.match(body, /inspectRelease/u);
  assert.doesNotMatch(body, /protectTcb|\.protect\s*\(/u);
});
