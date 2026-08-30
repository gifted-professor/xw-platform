import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
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
  M64_QUALIFICATION_LEGACY_LAUNCHER_TCB_SELF_RELEASE_PATH,
  parseM64QualificationLegacyLauncherTcbProvisionFixedArgs,
  provisionM64QualificationLegacyLauncherTcbFixed,
} from "../ops/m6-qualification-legacy-launcher-tcb-provision-fixed.mjs";

const EXECUTING_RELEASE_ID = "xw-successor-launcher-fixture";
const LEGACY_RELEASE_ID = "xw-legacy-launcher-fixture";

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
    operatorPath = join(root, ...M64_QUALIFICATION_LEGACY_LAUNCHER_TCB_SELF_RELEASE_PATH.split("/"));
    mkdirSync(dirname(operatorPath), { recursive: true });
    const bytes = Buffer.from("export const formalLauncherFixture = true;\n", "utf8");
    writeFileSync(operatorPath, bytes);
    files.push({
      path: M64_QUALIFICATION_LEGACY_LAUNCHER_TCB_SELF_RELEASE_PATH,
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
  const root = mkdtempSync(join(tmpdir(), "xw-m64-legacy-launcher-tcb-"));
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
    releaseId: "xw-other-launcher-fixture",
    sourceCommit: "e".repeat(40),
    sourceTreeSha: "f".repeat(40),
  });
  linkCurrent(runtimeRoot, legacy.root);
  const launchers = {
    controlPlaneLauncher: join(runtimeRoot, "launch-control-plane.simple.ps1"),
    orchestratorLauncher: join(runtimeRoot, "launch-orchestrator.current-user.ps1"),
  };
  writeFileSync(launchers.controlPlaneLauncher, "param()\nWrite-Output 'control-plane'\n");
  writeFileSync(launchers.orchestratorLauncher, "param()\nWrite-Output 'orchestrator'\n");
  return { runtimeRoot, executing, legacy, other, launchers };
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
  if (samePath(path, f.runtimeRoot)) return "runtimeBoundary";
  if (samePath(path, f.launchers.controlPlaneLauncher)) return "controlPlaneLauncher";
  if (samePath(path, f.launchers.orchestratorLauncher)) return "orchestratorLauncher";
  return "unknown";
}

function recordingController(f, {
  initialErrors = {},
  onProtect = null,
  onVerify = null,
  entryCounts = {},
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
    return { ok: true, entryCount: entryCounts[key] ?? (plan.recursive ? 9 : 1) };
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
  const result = provisionM64QualificationLegacyLauncherTcbFixed({
    runtimeRoot: f.runtimeRoot,
    operatorPath: f.executing.operatorPath,
    verifyManifest: manifest.verify,
    tcbAclController: controller,
  });
  return { result, manifest, controller };
}

test("fixed legacy-launcher TCB CLI exposes no caller-selected path or identity", () => {
  assert.deepEqual(parseM64QualificationLegacyLauncherTcbProvisionFixedArgs([]), { provision: true });
  for (const argv of [
    ["--runtime-root", "C:\\attacker"],
    ["--launcher", "launch-control-plane.simple.ps1"],
    ["C:\\attacker\\launcher.ps1"],
    [LEGACY_RELEASE_ID, "c".repeat(40)],
  ]) {
    assert.throws(() => parseM64QualificationLegacyLauncherTcbProvisionFixedArgs(argv), {
      code: "M64_QUALIFICATION_LEGACY_LAUNCHER_TCB_CLI_INVALID",
    });
  }
});

test("closure and both fixed launchers preflight before exact target-only migrations", (t) => {
  const f = fixture(t);
  const manifest = manifestVerifier();
  const controller = recordingController(f, {
    initialErrors: {
      runtimeBoundary: "SYSTEM_TCB_ACL_TARGET_DACL_INVALID",
      controlPlaneLauncher: "SYSTEM_TCB_ACL_TARGET_DACL_INVALID",
      orchestratorLauncher: "SYSTEM_TCB_ACL_TARGET_DACL_INVALID",
    },
  });
  const { result } = run(f, { manifest, controller });
  assert.equal(result.status, "VERIFIED");
  assert.equal(result.ancestorClosureCount, 1);
  assert.equal(result.normalizedAncestorClosureCount, 1);
  assert.equal(result.launcherCount, 2);
  assert.equal(result.normalizedCount, 2);
  assert.deepEqual(result.ancestorClosures, [{
    key: "runtimeBoundary",
    normalized: true,
    entryCount: 1,
  }]);
  assert.deepEqual(result.launchers, [
    {
      key: "controlPlaneLauncher",
      sha256: sha256(readFileSync(f.launchers.controlPlaneLauncher)),
      normalized: true,
      entryCount: 1,
    },
    {
      key: "orchestratorLauncher",
      sha256: sha256(readFileSync(f.launchers.orchestratorLauncher)),
      normalized: true,
      entryCount: 1,
    },
  ]);
  assert.match(result.receiptHash, /^[0-9a-f]{64}$/u);
  assert.deepEqual(controller.calls.map((row) => [row.operation, row.key, row.recursive]), [
    ["verify", "executing", true],
    ["verify", "legacy", true],
    ["verify", "runtimeBoundary", false],
    ["verify-target", "controlPlaneLauncher", false],
    ["verify-target", "orchestratorLauncher", false],
    ["protect", "runtimeBoundary", false],
    ["verify", "runtimeBoundary", false],
    ["verify", "runtimeBoundary", false],
    ["protect-target", "controlPlaneLauncher", false],
    ["verify", "runtimeBoundary", false],
    ["protect-target", "orchestratorLauncher", false],
    ["verify-target", "controlPlaneLauncher", false],
    ["verify-target", "orchestratorLauncher", false],
  ]);
  assert.equal(controller.calls.some((row) => row.key === "unknown"), false);
  assert.deepEqual(manifest.calls.map((row) => resolve(row.root)), [
    resolve(f.executing.root),
    resolve(f.legacy.root),
    resolve(f.legacy.root),
    resolve(f.executing.root),
  ]);
  assert.doesNotMatch(
    JSON.stringify(result),
    /[\\/]|path|root|secret|private|command|token|script|contents?/iu,
  );

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
  assert.doesNotMatch(stdout, /[\\/]|path|root|secret|private|command|token|script|contents?/iu);
});

test("a non-exact closure or launcher error prevents every protect", (t) => {
  for (const [key, errorCode] of [
    ["runtimeBoundary", "SYSTEM_TCB_ACL_STRUCTURE_INVALID"],
    ["orchestratorLauncher", "SYSTEM_TCB_ACL_TARGET_DACL_INVALID_SUFFIX"],
    ["orchestratorLauncher", "system_tcb_acl_target_dacl_invalid"],
    ["orchestratorLauncher", undefined],
  ]) {
    const f = fixture(t);
    const controller = recordingController(f, {
      initialErrors: {
        runtimeBoundary: key === "runtimeBoundary"
          ? errorCode : "SYSTEM_TCB_ACL_TARGET_DACL_INVALID",
        controlPlaneLauncher: "SYSTEM_TCB_ACL_TARGET_DACL_INVALID",
        ...(key === "orchestratorLauncher" ? { orchestratorLauncher: errorCode } : {}),
      },
    });
    assert.throws(() => run(f, { controller }), {
      code: "M64_QUALIFICATION_LEGACY_LAUNCHER_TCB_VERIFICATION_FAILED",
    });
    assert.equal(controller.calls.filter((row) => row.operation.startsWith("protect")).length, 0);
  }
});

test("current drift after all launcher preflights prevents every protect", (t) => {
  const f = fixture(t);
  const controller = recordingController(f, {
    initialErrors: {
      runtimeBoundary: "SYSTEM_TCB_ACL_TARGET_DACL_INVALID",
      controlPlaneLauncher: "SYSTEM_TCB_ACL_TARGET_DACL_INVALID",
      orchestratorLauncher: "SYSTEM_TCB_ACL_TARGET_DACL_INVALID",
    },
    onVerify({ key, count }) {
      if (key === "orchestratorLauncher" && count === 1) linkCurrent(f.runtimeRoot, f.other.root);
    },
  });
  assert.throws(() => run(f, { controller }), {
    code: "M64_QUALIFICATION_LEGACY_LAUNCHER_TCB_CURRENT_DRIFT",
  });
  assert.equal(controller.calls.filter((row) => row.operation.startsWith("protect")).length, 0);
});

test("a malicious closure controller that changes launcher bytes fails before target protect", (t) => {
  const f = fixture(t);
  const controller = recordingController(f, {
    initialErrors: { runtimeBoundary: "SYSTEM_TCB_ACL_TARGET_DACL_INVALID" },
    onProtect({ key }) {
      if (key === "runtimeBoundary") {
        writeFileSync(f.launchers.controlPlaneLauncher, "param()\nWrite-Output 'drifted'\n");
      }
    },
  });
  assert.throws(() => run(f, { controller }), {
    code: "M64_QUALIFICATION_LEGACY_LAUNCHER_TCB_CONTENT_DRIFT",
  });
  assert.equal(controller.calls.filter((row) => row.operation === "protect-target").length, 0);
});

test("a malicious target controller that replaces a launcher is detected immediately", (t) => {
  const f = fixture(t);
  const controller = recordingController(f, {
    initialErrors: { controlPlaneLauncher: "SYSTEM_TCB_ACL_TARGET_DACL_INVALID" },
    onProtect({ key }) {
      if (key === "controlPlaneLauncher") {
        renameSync(
          f.launchers.controlPlaneLauncher,
          `${f.launchers.controlPlaneLauncher}.replaced`,
        );
        writeFileSync(f.launchers.controlPlaneLauncher, "param()\nWrite-Output 'replacement'\n");
      }
    },
  });
  assert.throws(() => run(f, { controller }), {
    code: "M64_QUALIFICATION_LEGACY_LAUNCHER_TCB_TARGET_DRIFT",
  });
  assert.deepEqual(
    controller.calls.filter((row) => row.operation === "protect-target").map((row) => row.key),
    ["controlPlaneLauncher"],
  );
});

test("already-protected launchers verify without any protect", (t) => {
  const f = fixture(t);
  const { result, controller } = run(f);
  assert.equal(result.normalizedAncestorClosureCount, 0);
  assert.equal(result.normalizedCount, 0);
  assert.equal(controller.calls.filter((row) => row.operation.startsWith("protect")).length, 0);
  assert.equal(controller.calls.filter((row) => row.key === "controlPlaneLauncher").length, 2);
  assert.equal(controller.calls.filter((row) => row.key === "orchestratorLauncher").length, 2);
});

test("invalid native closure or target receipts fail closed", (t) => {
  for (const key of ["runtimeBoundary", "orchestratorLauncher"]) {
    const f = fixture(t);
    const controller = recordingController(f, { entryCounts: { [key]: 2 } });
    assert.throws(() => run(f, { controller }), {
      code: "M64_QUALIFICATION_LEGACY_LAUNCHER_TCB_RECEIPT_INVALID",
    });
    assert.equal(controller.calls.filter((row) => row.operation.startsWith("protect")).length, 0);
  }
});

test("both legacy and executing manifests are full-verified after ACL checks", (t) => {
  const f = fixture(t);
  const manifest = manifestVerifier();
  const baseVerify = manifest.verify.bind(manifest);
  manifest.verify = (input) => {
    const receipt = baseVerify(input);
    return manifest.calls.length === 4 ? { ok: false, mismatches: ["post-drift"] } : receipt;
  };
  assert.throws(() => run(f, { manifest }), {
    code: "M64_QUALIFICATION_LEGACY_LAUNCHER_TCB_POSTVERIFY_FAILED",
  });
  assert.deepEqual(manifest.calls.map((row) => resolve(row.root)), [
    resolve(f.executing.root),
    resolve(f.legacy.root),
    resolve(f.legacy.root),
    resolve(f.executing.root),
  ]);
});

test("executing provisioner must match its full formal manifest", (t) => {
  const f = fixture(t);
  writeFileSync(f.executing.operatorPath, "export const drifted = true;\n");
  const controller = recordingController(f);
  assert.throws(() => run(f, { controller }), {
    code: "M64_QUALIFICATION_LEGACY_LAUNCHER_TCB_EXECUTING_RELEASE_INVALID",
  });
  assert.equal(controller.calls.length, 0);
});
