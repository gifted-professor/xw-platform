import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  RELEASE_MANIFEST_FILENAME,
  RELEASE_MANIFEST_SCHEMA_ID,
  SOURCE_REPO,
  buildReleaseManifest,
  defaultReleaseId,
  listTrackedFiles,
  verifyReleaseManifest,
  writeRelease,
} from "../lib/release-manifest.mjs";

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), "xw-release-repo-"));
  const git = (args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git(["init", "-q"]);
  git(["config", "user.email", "cutover@test.invalid"]);
  git(["config", "user.name", "cutover-test"]);
  mkdirSync(join(root, "services/orchestrator"), { recursive: true });
  mkdirSync(join(root, "services/control-plane"), { recursive: true });
  mkdirSync(join(root, "packages/kernel"), { recursive: true });
  writeFileSync(join(root, "services/orchestrator/registry.mjs"), "// orchestrator entry\n");
  writeFileSync(join(root, "services/control-plane/router.mjs"), "// control-plane entry\n");
  writeFileSync(join(root, "packages/kernel/keep.mjs"), "// kernel\n");
  writeFileSync(join(root, "package.json"), '{"name":"tmp"}\n');
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);
  return root;
}

test("build → writeRelease → verify 往返一致", (t) => {
  const root = makeRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const outDir = mkdtempSync(join(tmpdir(), "xw-release-out-"));
  t.after(() => rmSync(outDir, { recursive: true, force: true }));

  const manifest = writeRelease({ root, outDir });
  assert.equal(manifest.schemaId, RELEASE_MANIFEST_SCHEMA_ID);
  assert.equal(manifest.sourceRepo, SOURCE_REPO);
  assert.match(manifest.sourceCommit, /^[0-9a-f]{40}$/);
  assert.match(manifest.sourceTreeSha, /^[0-9a-f]{40}$/);
  assert.equal(manifest.runtimeProfile, "legacy_compat");
  assert.equal(manifest.runtimeCutoverAllowed, false);
  assert.ok(manifest.services.orchestrator.treeSha256);
  assert.ok(manifest.services.controlPlane.treeSha256);
  assert.match(manifest.releaseId, /^xw-\d{8}-[0-9a-f]{7}$/);

  const releaseDir = join(outDir, "releases", manifest.releaseId);
  assert.ok(existsSync(join(releaseDir, RELEASE_MANIFEST_FILENAME)));
  assert.ok(existsSync(join(releaseDir, "services/orchestrator/registry.mjs")));

  const written = JSON.parse(readFileSync(join(releaseDir, RELEASE_MANIFEST_FILENAME), "utf8"));
  const verified = verifyReleaseManifest({ manifestPath: join(releaseDir, RELEASE_MANIFEST_FILENAME), root: releaseDir });
  assert.deepEqual(verified, { ok: true, mismatches: [] });
  assert.deepEqual(written.files, manifest.files);
});

test("篡改 release 内文件会被 verify 检出", (t) => {
  const root = makeRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const outDir = mkdtempSync(join(tmpdir(), "xw-release-out-"));
  t.after(() => rmSync(outDir, { recursive: true, force: true }));

  const manifest = writeRelease({ root, outDir, releaseId: "xw-tamper-test" });
  const releaseDir = join(outDir, "releases", manifest.releaseId);
  writeFileSync(join(releaseDir, "services/orchestrator/registry.mjs"), "// tampered\n");

  const verified = verifyReleaseManifest({ manifestPath: join(releaseDir, RELEASE_MANIFEST_FILENAME), root: releaseDir });
  assert.equal(verified.ok, false);
  assert.ok(verified.mismatches.some((m) => m.path === "services/orchestrator/registry.mjs" && m.kind === "blob"));
});

test("writeRelease 拒绝覆盖已有 release（不可变）", (t) => {
  const root = makeRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const outDir = mkdtempSync(join(tmpdir(), "xw-release-out-"));
  t.after(() => rmSync(outDir, { recursive: true, force: true }));

  writeRelease({ root, outDir, releaseId: "xw-immutable-test" });
  assert.throws(() => writeRelease({ root, outDir, releaseId: "xw-immutable-test" }), /RELEASE_IMMUTABLE/);
});

test("未跟踪文件令 package fail closed", (t) => {
  const root = makeRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const outDir = mkdtempSync(join(tmpdir(), "xw-release-out-"));
  t.after(() => rmSync(outDir, { recursive: true, force: true }));
  writeFileSync(join(root, "untracked.txt"), "dirty\n");

  const files = listTrackedFiles(root);
  assert.ok(!files.includes("untracked.txt"));
  assert.ok(files.every((p) => !p.startsWith(".git")));

  assert.throws(
    () => writeRelease({ root, outDir, releaseId: "xw-tracked-test" }),
    /RELEASE_SOURCE_DIRTY/,
  );
  assert.equal(existsSync(join(outDir, "releases", "xw-tracked-test")), false);
});

test("修改后的 tracked content 不能冒用 clean HEAD identity", (t) => {
  const root = makeRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const outDir = mkdtempSync(join(tmpdir(), "xw-release-out-"));
  t.after(() => rmSync(outDir, { recursive: true, force: true }));
  writeFileSync(join(root, "package.json"), '{"name":"dirty-not-head"}\n');

  assert.throws(
    () => writeRelease({ root, outDir, releaseId: "xw-head-blobs-only" }),
    /RELEASE_SOURCE_DIRTY/,
  );
  assert.equal(existsSync(join(outDir, "releases", "xw-head-blobs-only")), false);
});

test("verification rejects extra files/directories, node_modules, and releaseId path escape", (t) => {
  const root = makeRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const outDir = mkdtempSync(join(tmpdir(), "xw-release-out-"));
  t.after(() => rmSync(outDir, { recursive: true, force: true }));
  assert.throws(() => writeRelease({ root, outDir, releaseId: "../escape" }), /RELEASE_ID_INVALID/);
  const manifest = writeRelease({ root, outDir, releaseId: "xw-closed-inventory" });
  const releaseDir = join(outDir, "releases", manifest.releaseId);
  writeFileSync(join(releaseDir, "unexpected.txt"), "not in committed inventory\n");
  const verified = verifyReleaseManifest({ manifestPath: join(releaseDir, RELEASE_MANIFEST_FILENAME), root: releaseDir });
  assert.equal(verified.ok, false);
  assert.ok(verified.mismatches.some((entry) => entry.kind === "extra" && entry.path === "unexpected.txt"));

  mkdirSync(join(releaseDir, "empty-extra"));
  mkdirSync(join(releaseDir, "node_modules/pkg"), { recursive: true });
  writeFileSync(join(releaseDir, "node_modules/pkg/index.js"), "// must never be installed into a release\n");
  const withNodeModules = verifyReleaseManifest({ manifestPath: join(releaseDir, RELEASE_MANIFEST_FILENAME), root: releaseDir });
  assert.equal(withNodeModules.ok, false);
  assert.ok(withNodeModules.mismatches.some((entry) => entry.kind === "extraDirectory" && entry.path === "empty-extra"));
  assert.ok(withNodeModules.mismatches.some((entry) => entry.kind === "nodeModules" && entry.path === "node_modules"));
});

test("coordinated manifest entry + release file deletion cannot preserve sourceTreeSha", (t) => {
  const root = makeRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const outDir = mkdtempSync(join(tmpdir(), "xw-release-out-"));
  t.after(() => rmSync(outDir, { recursive: true, force: true }));

  const manifest = writeRelease({ root, outDir, releaseId: "xw-delete-pair" });
  const releaseDir = join(outDir, "releases", manifest.releaseId);
  const manifestPath = join(releaseDir, RELEASE_MANIFEST_FILENAME);
  const doc = JSON.parse(readFileSync(manifestPath, "utf8"));
  const victim = "packages/kernel/keep.mjs";
  doc.files = doc.files.filter((entry) => entry.path !== victim);
  rmSync(join(releaseDir, ...victim.split("/")));
  writeFileSync(manifestPath, `${JSON.stringify(doc, null, 2)}\n`);

  const verified = verifyReleaseManifest({ manifestPath, root: releaseDir });
  assert.equal(verified.ok, false);
  assert.ok(verified.mismatches.some((entry) => entry.kind === "sourceTree"));
});

test("manifest file order and declared Git mode are sealed", (t) => {
  const root = makeRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const outDir = mkdtempSync(join(tmpdir(), "xw-release-out-"));
  t.after(() => rmSync(outDir, { recursive: true, force: true }));

  const manifest = writeRelease({ root, outDir, releaseId: "xw-order-mode" });
  const releaseDir = join(outDir, "releases", manifest.releaseId);
  const manifestPath = join(releaseDir, RELEASE_MANIFEST_FILENAME);
  const doc = JSON.parse(readFileSync(manifestPath, "utf8"));
  doc.files.reverse();
  doc.files[0].gitMode = doc.files[0].gitMode === "100644" ? "100755" : "100644";
  writeFileSync(manifestPath, `${JSON.stringify(doc, null, 2)}\n`);

  const verified = verifyReleaseManifest({ manifestPath, root: releaseDir });
  assert.equal(verified.ok, false);
  assert.ok(verified.mismatches.some((entry) => entry.kind === "inventoryOrder"));
  assert.ok(verified.mismatches.some((entry) => entry.kind === "sourceTree"));
});

test("symlink/junction/reparse entry is rejected without traversal", (t) => {
  const root = makeRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const outDir = mkdtempSync(join(tmpdir(), "xw-release-out-"));
  t.after(() => rmSync(outDir, { recursive: true, force: true }));
  const outside = mkdtempSync(join(tmpdir(), "xw-release-outside-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));

  const manifest = writeRelease({ root, outDir, releaseId: "xw-reparse" });
  const releaseDir = join(outDir, "releases", manifest.releaseId);
  const linkPath = join(releaseDir, "unexpected-link");
  try {
    symlinkSync(outside, linkPath, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EACCES", "EPERM", "UNKNOWN"].includes(error.code)) {
      t.skip(`symlink/junction creation unavailable on this host: ${error.code}`);
      return;
    }
    throw error;
  }

  const verified = verifyReleaseManifest({
    manifestPath: join(releaseDir, RELEASE_MANIFEST_FILENAME),
    root: releaseDir,
  });
  assert.equal(verified.ok, false);
  assert.ok(verified.mismatches.some((entry) => ["symlink", "reparse"].includes(entry.kind) && entry.path === "unexpected-link"));
});

test("buildReleaseManifest 支持显式 releaseId；defaultReleaseId 用提交短 SHA", (t) => {
  const root = makeRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifest = buildReleaseManifest({ root, releaseId: "xw-custom-1" });
  assert.equal(manifest.releaseId, "xw-custom-1");
  const derived = defaultReleaseId(manifest.sourceCommit, new Date("2026-08-19T00:00:00Z"));
  assert.equal(derived, `xw-20260819-${manifest.sourceCommit.slice(0, 7)}`);
});

test("runtimeCutoverAllowed 非 false 的 manifest 验不过", (t) => {
  const root = makeRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const outDir = mkdtempSync(join(tmpdir(), "xw-release-out-"));
  t.after(() => rmSync(outDir, { recursive: true, force: true }));

  const manifest = writeRelease({ root, outDir, releaseId: "xw-gate-test" });
  const releaseDir = join(outDir, "releases", manifest.releaseId);
  const manifestPath = join(releaseDir, RELEASE_MANIFEST_FILENAME);
  const doc = JSON.parse(readFileSync(manifestPath, "utf8"));
  doc.runtimeCutoverAllowed = true;
  writeFileSync(manifestPath, JSON.stringify(doc));
  const verified = verifyReleaseManifest({ manifestPath, root: releaseDir });
  assert.equal(verified.ok, false);
  assert.ok(verified.mismatches.some((m) => m.kind === "runtimeCutoverAllowed"));
});

test("manifest verifier enforces the same exact release schema as the external runtime verifier", async (t) => {
  const root = makeRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const outDir = mkdtempSync(join(tmpdir(), "xw-release-out-"));
  t.after(() => rmSync(outDir, { recursive: true, force: true }));
  const cases = [
    ["unexpected-top-level-authority", (doc) => { doc.unexpectedAuthority = true; }, "manifestSchema"],
    ["missing-runtime-profile", (doc) => { delete doc.runtimeProfile; }, "manifestSchema"],
    ["empty-services", (doc) => { doc.services = {}; }, "servicesSchema"],
    ["release-id-rebound", (doc) => { doc.releaseId = "xw-rebound-release"; }, "releaseId"],
    ["file-entry-extra-field", (doc) => { doc.files[0].authority = "unexpected"; }, "inventory"],
    ["service-entry-extra-field", (doc) => { doc.services.orchestrator.authority = "unexpected"; }, "serviceSchema"],
  ];
  for (const [name, mutate, expectedKind] of cases) {
    await t.test(name, () => {
      const manifest = writeRelease({ root, outDir, releaseId: `xw-${name}` });
      const releaseDir = join(outDir, "releases", manifest.releaseId);
      const manifestPath = join(releaseDir, RELEASE_MANIFEST_FILENAME);
      const doc = JSON.parse(readFileSync(manifestPath, "utf8"));
      mutate(doc);
      writeFileSync(manifestPath, `${JSON.stringify(doc, null, 2)}\n`);
      const verified = verifyReleaseManifest({ manifestPath, root: releaseDir });
      assert.equal(verified.ok, false);
      assert.ok(verified.mismatches.some((entry) => entry.kind === expectedKind), JSON.stringify(verified.mismatches));
    });
  }

  await t.test("minified-manifest-bytes", () => {
    const manifest = writeRelease({ root, outDir, releaseId: "xw-minified-manifest" });
    const releaseDir = join(outDir, "releases", manifest.releaseId);
    const manifestPath = join(releaseDir, RELEASE_MANIFEST_FILENAME);
    const doc = JSON.parse(readFileSync(manifestPath, "utf8"));
    writeFileSync(manifestPath, JSON.stringify(doc));
    const verified = verifyReleaseManifest({ manifestPath, root: releaseDir });
    assert.equal(verified.ok, false);
    assert.ok(verified.mismatches.some((entry) => entry.kind === "manifestEncoding"));
  });
});

test("manifest verifier rejects release files with an external hard-link alias", (t) => {
  const root = makeRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const outDir = mkdtempSync(join(tmpdir(), "xw-release-out-"));
  t.after(() => rmSync(outDir, { recursive: true, force: true }));
  const manifest = writeRelease({ root, outDir, releaseId: "xw-hardlink-release" });
  const releaseDir = join(outDir, "releases", manifest.releaseId);
  const victim = join(releaseDir, "services", "control-plane", "router.mjs");
  linkSync(victim, join(outDir, "external-hardlink-alias.mjs"));
  const verified = verifyReleaseManifest({
    manifestPath: join(releaseDir, RELEASE_MANIFEST_FILENAME),
    root: releaseDir,
  });
  assert.equal(verified.ok, false);
  assert.ok(verified.mismatches.some((entry) => entry.kind === "hardlink" && entry.path === "services/control-plane/router.mjs"));
});
