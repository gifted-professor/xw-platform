import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  buildFormalRelease,
  FORMAL_RELEASE_MANIFEST_SCHEMA_ID,
  materializeReleaseManifest,
  parseGitTree,
} from "../ops/formal-release-builder.mjs";

function git(root, ...args) {
  return execFileSync("git.exe", ["-C", root, ...args], {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function sha1Blob(bytes) {
  return createHash("sha1")
    .update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`, "utf8"), bytes]))
    .digest("hex");
}

function write(root, path, value) {
  const target = join(root, ...path.split("/"));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, value);
  return target;
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "xw-formal-release-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  const runtime = join(root, "runtime");
  mkdirSync(repo, { recursive: true });
  mkdirSync(runtime, { recursive: true });
  git(repo, "init", "--initial-branch=main");
  git(repo, "config", "user.name", "release-test");
  git(repo, "config", "user.email", "release-test@example.invalid");
  write(repo, "package.json", "{\"name\":\"fixture\"}\n");
  write(repo, "config/runtime/xw-runtime.v1.json", "{}\n");
  write(repo, "services/control-plane/control-plane/lib/xhs-v3-fixed-operator-auth.mjs", "export default true;\n");
  write(repo, "services/control-plane/control-plane/lib/m6-qualification-tcb.mjs", "export default true;\n");
  write(repo, "services/control-plane/control-plane/lib/windows-xhs-blind-review-acl.mjs", "export default true;\n");
  write(repo, "services/control-plane/ops/gate-f-cutover-operator.mjs", "export default true;\n");
  write(repo, "services/control-plane/ops/m6-qualification-legacy-current-tcb-provision-fixed.mjs", "export default true;\n");
  write(repo, "services/control-plane/ops/m6-qualification-legacy-database-tcb-provision-fixed.mjs", "export default true;\n");
  write(repo, "services/control-plane/ops/m6-qualification-legacy-launcher-tcb-provision-fixed.mjs", "export default true;\n");
  write(repo, "services/control-plane/ops/m6-qualification-legacy-window-operator.mjs", "export default true;\n");
  write(repo, "services/control-plane/ops/m6-qualification-launcher-operator.mjs", "export default true;\n");
  write(repo, "services/control-plane/ops/m6-qualification-tcb-provision-fixed.mjs", "export default true;\n");
  write(repo, "services/control-plane/ops/m6-strict-fixed-qualification-operator.mjs", "export default true;\n");
  write(repo, "services/control-plane/ops/m6-strict-fixed-assembler-bridge.mjs", "export default true;\n");
  write(repo, "services/control-plane/ops/provision-control-plane-secrets-fixed.mjs", "export default true;\n");
  write(repo, "services/control-plane/ops/provision-control-plane-secrets.ps1", "param()\n");
  write(repo, "services/control-plane/ops/xhs-v3-production-operator.mjs", "export default true;\n");
  write(repo, "services/control-plane/ops/xhs-v3-blind-review-submit.mjs", "export default true;\n");
  write(repo, "services/control-plane/ops/launch-control-plane.ps1", "param()\n");
  write(repo, "services/control-plane/scripts/xw-control-plane-runtime.ps1", "param()\n");
  write(repo, "services/control-plane/control-plane/server.mjs", "export default true;\n");
  write(repo, "services/orchestrator/index.mjs", "export default true;\n");
  git(repo, "add", "--all");
  git(repo, "commit", "-m", "fixture");
  const commit = git(repo, "rev-parse", "HEAD");
  return { root, repo, runtime, commit };
}

function recordingTcbController({ reject = null } = {}) {
  const calls = [];
  const invoke = (operation, plan) => {
    calls.push({ operation, ...plan });
    if (reject) throw Object.assign(new Error(reject), { code: reject });
    return { ok: true, operation, entryCount: 1, protectedDacl: "fixture-verified" };
  };
  return {
    calls,
    protect: (plan) => invoke("protect", plan),
    verify: (plan) => invoke("verify", plan),
  };
}

test("parseGitTree accepts only regular, unique, safe Git blobs", () => {
  const oid = "a".repeat(40);
  assert.deepEqual(parseGitTree(Buffer.from(`100644 blob ${oid}\ta.txt\0`, "utf8")), [{
    path: "a.txt",
    gitMode: "100644",
    gitBlobOid: oid,
  }]);
  for (const record of [
    `120000 blob ${oid}\tlink\0`,
    `100644 blob ${oid}\t../escape\0`,
    `100644 blob ${oid}\tA.txt\u0000100644 blob ${oid}\ta.txt\u0000`,
    `100644 blob ${oid}\trelease-manifest.v1.json\0`,
  ]) assert.throws(() => parseGitTree(Buffer.from(record, "utf8")), /FORMAL_RELEASE_TREE_INVALID/u);
});

test("materializeReleaseManifest verifies exact Git blobs and emits canonical complete identity", (t) => {
  const root = mkdtempSync(join(tmpdir(), "xw-release-manifest-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const releaseId = "xw-xhs-v3-test";
  const releaseRoot = join(root, releaseId);
  mkdirSync(releaseRoot);
  const paths = [
    "config/runtime/xw-runtime.v1.json",
    "package.json",
    "services/control-plane/control-plane/lib/xhs-v3-fixed-operator-auth.mjs",
    "services/control-plane/control-plane/lib/m6-qualification-tcb.mjs",
    "services/control-plane/control-plane/lib/windows-xhs-blind-review-acl.mjs",
    "services/control-plane/ops/gate-f-cutover-operator.mjs",
    "services/control-plane/ops/m6-qualification-legacy-current-tcb-provision-fixed.mjs",
    "services/control-plane/ops/m6-qualification-legacy-database-tcb-provision-fixed.mjs",
    "services/control-plane/ops/m6-qualification-legacy-launcher-tcb-provision-fixed.mjs",
    "services/control-plane/ops/m6-qualification-legacy-window-operator.mjs",
    "services/control-plane/ops/m6-qualification-launcher-operator.mjs",
    "services/control-plane/ops/m6-qualification-tcb-provision-fixed.mjs",
    "services/control-plane/ops/m6-strict-fixed-qualification-operator.mjs",
    "services/control-plane/ops/m6-strict-fixed-assembler-bridge.mjs",
    "services/control-plane/ops/provision-control-plane-secrets-fixed.mjs",
    "services/control-plane/ops/provision-control-plane-secrets.ps1",
    "services/control-plane/ops/xhs-v3-production-operator.mjs",
    "services/control-plane/ops/xhs-v3-blind-review-submit.mjs",
    "services/control-plane/ops/launch-control-plane.ps1",
    "services/control-plane/scripts/xw-control-plane-runtime.ps1",
  ];
  const entries = paths.map((path, index) => {
    const bytes = Buffer.from(`file-${index}\n`, "utf8");
    write(releaseRoot, path, bytes);
    return { path, gitMode: "100644", gitBlobOid: sha1Blob(bytes) };
  });
  const result = materializeReleaseManifest({
    payloadRoot: releaseRoot,
    releaseId,
    sourceCommit: "1".repeat(40),
    sourceTreeSha: "2".repeat(40),
    treeEntries: entries,
    nodeVersion: "24.11.1",
  });
  assert.equal(result.manifest.schemaId, FORMAL_RELEASE_MANIFEST_SCHEMA_ID);
  assert.equal(result.manifest.files.length, paths.length);
  assert.equal(result.manifest.runtimeCutoverAllowed, false);
  const raw = readFileSync(result.manifestPath, "utf8");
  assert.equal(raw, `${JSON.stringify(JSON.parse(raw), null, 2)}\n`);
  assert.match(result.manifestSha256, /^[0-9a-f]{64}$/u);

  const driftRoot = join(root, "xw-xhs-v3-drift");
  mkdirSync(driftRoot);
  for (const [index, path] of paths.entries()) write(driftRoot, path, `file-${index}\n`);
  write(driftRoot, paths[0], "drift\n");
  assert.throws(() => materializeReleaseManifest({
    payloadRoot: driftRoot,
    releaseId: "xw-xhs-v3-drift",
    sourceCommit: "1".repeat(40),
    sourceTreeSha: "2".repeat(40),
    treeEntries: entries,
  }), /FORMAL_RELEASE_BLOB_DRIFT/u);
});

test("formal builder materializes one clean exact HEAD without switching current", (t) => {
  const f = fixture(t);
  const tcb = recordingTcbController();
  const receipt = buildFormalRelease({
    repoRoot: f.repo,
    runtimeRoot: f.runtime,
    requiredAncestor: f.commit,
    releaseIdPrefix: "xw-xhs-v3-test",
    tcbAclController: tcb,
  });
  assert.equal(receipt.ok, true);
  assert.equal(receipt.sourceCommit, f.commit);
  assert.equal(receipt.releaseId, `xw-xhs-v3-test-${f.commit.slice(0, 12)}`);
  assert.equal(existsSync(join(f.runtime, "current")), false, "builder must not perform cutover");
  assert.equal(existsSync(join(receipt.releaseRoot, "release-manifest.v1.json")), true);
  assert.equal(existsSync(join(
    receipt.releaseRoot,
    "services/control-plane/ops/m6-qualification-legacy-current-tcb-provision-fixed.mjs",
  )), true);
  assert.equal(existsSync(join(
    receipt.releaseRoot,
    "services/control-plane/ops/m6-qualification-legacy-database-tcb-provision-fixed.mjs",
  )), true);
  assert.equal(existsSync(join(
    receipt.releaseRoot,
    "services/control-plane/ops/m6-qualification-legacy-launcher-tcb-provision-fixed.mjs",
  )), true);
  assert.deepEqual(
    readFileSync(join(receipt.releaseRoot, "package.json")),
    execFileSync("git.exe", ["-C", f.repo, "show", `${f.commit}:package.json`]),
  );
  assert.deepEqual(readdirSync(join(f.runtime, "release-staging")), []);
  assert.deepEqual(
    tcb.calls.slice(0, 8).map((row) => [row.operation, row.recursive, row.targetPath]),
    [
      ["protect", false, f.runtime],
      ["protect", false, join(f.runtime, "releases")],
      ["protect", false, join(f.runtime, "release-staging")],
      ["protect", false, tcb.calls[3].targetPath],
      ["protect", false, tcb.calls[4].targetPath],
      ["protect", true, tcb.calls[4].targetPath],
      ["verify", true, tcb.calls[4].targetPath],
      ["verify", true, receipt.releaseRoot],
    ],
  );
  assert.match(tcb.calls[3].targetPath, /release-staging[\\/]build-/u);
  assert.equal(tcb.calls[4].targetPath, join(tcb.calls[3].targetPath, receipt.releaseId));
  assert.equal(receipt.tcbAcl.status, "verified");
  assert.throws(() => buildFormalRelease({
    repoRoot: f.repo,
    runtimeRoot: f.runtime,
    requiredAncestor: f.commit,
    releaseIdPrefix: "xw-xhs-v3-test",
    tcbAclController: tcb,
  }), /FORMAL_RELEASE_EXISTS/u);
});

test("formal builder fails before staging when the SYSTEM TCB boundary has a writable ancestor", (t) => {
  const f = fixture(t);
  const tcb = recordingTcbController({ reject: "SYSTEM_TCB_ACL_ANCESTOR_WRITABLE" });
  assert.throws(() => buildFormalRelease({
    repoRoot: f.repo,
    runtimeRoot: f.runtime,
    requiredAncestor: f.commit,
    releaseIdPrefix: "xw-xhs-v3-acl",
    tcbAclController: tcb,
  }), /SYSTEM_TCB_ACL_ANCESTOR_WRITABLE/u);
  assert.equal(existsSync(join(f.runtime, "releases")), false);
  assert.equal(existsSync(join(f.runtime, "release-staging")), false);
  assert.deepEqual(tcb.calls.map((row) => [row.operation, row.targetPath]), [["protect", f.runtime]]);
});

test("dirty worktree and missing ancestor reject before a release is created", (t) => {
  const dirty = fixture(t);
  write(dirty.repo, "untracked.txt", "dirty\n");
  assert.throws(() => buildFormalRelease({
    repoRoot: dirty.repo,
    runtimeRoot: dirty.runtime,
    requiredAncestor: dirty.commit,
    releaseIdPrefix: "xw-xhs-v3-dirty",
  }), /FORMAL_RELEASE_WORKTREE_DIRTY/u);
  assert.equal(existsSync(join(dirty.runtime, "releases")), false);

  rmSync(join(dirty.repo, "untracked.txt"));
  assert.throws(() => buildFormalRelease({
    repoRoot: dirty.repo,
    runtimeRoot: dirty.runtime,
    requiredAncestor: "f".repeat(40),
    releaseIdPrefix: "xw-xhs-v3-wrong",
  }), /FORMAL_RELEASE_GIT_FAILED/u);
});

test("production CLI fixes repository/runtime identity and exposes no path selector", () => {
  const source = readFileSync(new URL("../ops/formal-release-builder.mjs", import.meta.url), "utf8");
  assert.match(source, /FORMAL_RUNTIME_ROOT = "C:\\\\Users\\\\Public\\\\xw-runtime"/u);
  assert.doesNotMatch(source, /--runtime-root|--repo-root|--release-id/u);
  assert.match(source, /const \{ releaseRoot: _privatePath, \.\.\.publicReceipt \} = receipt/u);
  assert.match(source, /createSystemTcbAclController/u);
  assert.match(source, /services\/control-plane\/ops\/m6-qualification-legacy-current-tcb-provision-fixed\.mjs/u);
  assert.match(source, /services\/control-plane\/ops\/m6-qualification-legacy-database-tcb-provision-fixed\.mjs/u);
  assert.match(source, /services\/control-plane\/ops\/m6-qualification-legacy-launcher-tcb-provision-fixed\.mjs/u);
  assert.match(source, /protect\(releasesRoot, false\)/u);
  assert.doesNotMatch(source, /protect\(releasesRoot, true\)/u);
  assert.match(source, /protect\(payloadRoot, true\)/u);
  assert.match(source, /verify\(finalRoot, true\)/u);
});
