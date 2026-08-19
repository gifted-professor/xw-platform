import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadReleaseIdentity } from "../lib/release-identity.mjs";
import { DEFAULT_RUNTIME_PROFILE, loadRuntimeProfile } from "../../kernel/lib/runtime-profile.mjs";

const MANIFEST = {
  schemaId: "xw.runtime.release-manifest.v1",
  releaseId: "xw-20260819-deadbee",
  sourceRepo: "gifted-professor/xw-platform",
  sourceCommit: "a".repeat(40),
  sourceTreeSha: "b".repeat(40),
  runtimeProfile: "legacy_compat",
  runtimeCutoverAllowed: false,
};

test("XW_RELEASE_MANIFEST 环境变量优先", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "xw-identity-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "release-manifest.v1.json");
  writeFileSync(file, JSON.stringify(MANIFEST));

  const identity = loadReleaseIdentity({ startDir: join(dir, "nowhere"), env: { XW_RELEASE_MANIFEST: file } });
  assert.deepEqual(identity, {
    sourceRepo: MANIFEST.sourceRepo,
    sourceCommit: MANIFEST.sourceCommit,
    releaseId: MANIFEST.releaseId,
    runtimeProfile: "legacy_compat",
  });
});

test("从 startDir 向上查找 release-manifest.v1.json", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "xw-identity-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "release-manifest.v1.json"), JSON.stringify(MANIFEST));
  const nested = join(dir, "services/control-plane/control-plane");
  mkdirSync(nested, { recursive: true });

  const identity = loadReleaseIdentity({ startDir: nested, env: {} });
  assert.equal(identity.releaseId, MANIFEST.releaseId);
  assert.equal(identity.sourceCommit, MANIFEST.sourceCommit);
});

test("找不到 manifest 时兜底 CONTROL_PLANE_RELEASE_ID", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "xw-identity-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const identity = loadReleaseIdentity({ startDir: dir, env: { CONTROL_PLANE_RELEASE_ID: "rel-legacy-1" } });
  assert.deepEqual(identity, {
    sourceRepo: null,
    sourceCommit: null,
    releaseId: "rel-legacy-1",
    runtimeProfile: null,
  });
});

test("什么都没有时全部 null", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "xw-identity-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const identity = loadReleaseIdentity({ startDir: dir, env: {} });
  assert.deepEqual(identity, { sourceRepo: null, sourceCommit: null, releaseId: null, runtimeProfile: null });
});

test("env 指向坏文件时回落到向上查找", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "xw-identity-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "release-manifest.v1.json"), JSON.stringify(MANIFEST));
  const identity = loadReleaseIdentity({ startDir: dir, env: { XW_RELEASE_MANIFEST: join(dir, "missing.json") } });
  assert.equal(identity.releaseId, MANIFEST.releaseId);
});

test("runtime profile：legacy_compat 可加载且冻结，未知名抛错", () => {
  const profile = loadRuntimeProfile();
  assert.equal(profile.orchestratorEnabled, true);
  assert.equal(profile.controlPlaneEnabled, true);
  assert.equal(profile.openActionLiveEnabled, false);
  assert.equal(profile.dshEnabled, false);
  assert.equal(profile.paymentCredentialRequiresHuman, true);
  assert.equal(profile.paymentFinalCommitRequiresHuman, true);
  assert.ok(Object.isFrozen(profile));
  assert.equal(DEFAULT_RUNTIME_PROFILE, "legacy_compat");
  assert.throws(() => loadRuntimeProfile("nope"), /UNKNOWN_RUNTIME_PROFILE/);
  assert.throws(() => { profile.dshEnabled = true; }, TypeError);
});
