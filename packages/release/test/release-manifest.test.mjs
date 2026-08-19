import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("未跟踪文件与 .git 不进 manifest，也不进 release 目录", (t) => {
  const root = makeRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const outDir = mkdtempSync(join(tmpdir(), "xw-release-out-"));
  t.after(() => rmSync(outDir, { recursive: true, force: true }));
  writeFileSync(join(root, "untracked.txt"), "dirty\n");

  const files = listTrackedFiles(root);
  assert.ok(!files.includes("untracked.txt"));
  assert.ok(files.every((p) => !p.startsWith(".git")));

  const manifest = writeRelease({ root, outDir, releaseId: "xw-tracked-test" });
  assert.ok(!manifest.files.some((f) => f.path === "untracked.txt"));
  const releaseDir = join(outDir, "releases", manifest.releaseId);
  assert.equal(existsSync(join(releaseDir, "untracked.txt")), false);
  assert.equal(existsSync(join(releaseDir, ".git")), false);
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
