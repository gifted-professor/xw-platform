import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { deriveTargetEnvironmentAttestation } from "../../packages/kernel/lib/m6-live-grounding.mjs";
import { deriveRuntimeDependencyQualificationHash } from "../../integrations/dsh-xw/src/live-model-qualification.mjs";
import { computeInstalledLiveAdapterIntegrity } from "../../integrations/dsh-xw/src/live-model-profile.mjs";

const repositoryRoot = resolve(new URL("../../", import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/u, ""));
const cli = join(repositoryRoot, "tools/m6/m6-4-live-model-qualification.mjs");
const SECRET = "sk-cli-secret-must-not-escape";
const H = "b".repeat(64);

function writeFixtures(root) {
  const installed = computeInstalledLiveAdapterIntegrity({ dependencyRoot: repositoryRoot });
  const dependencyBody = {
    schemaId: "xw.m6-live-runtime-dependency-qualification.v1",
    status: "DEPENDENCY_LAYER_QUALIFIED",
    scope: "M6_C1_RUNTIME_DEPENDENCIES_ONLY",
    layerHash: H,
    adapterPackage: installed.packageName,
    adapterVersion: installed.packageVersion,
    adapterIntegrityHash: installed.integrityHash,
    providerHealthEvaluated: false,
    secretMaterialPresent: false,
    gateFEligible: false,
  };
  const dependency = { ...dependencyBody, qualificationHash: deriveRuntimeDependencyQualificationHash(dependencyBody) };
  const now = Date.now();
  const target = deriveTargetEnvironmentAttestation({
    appPackageHash: H,
    appBuildHash: H,
    signingHash: H,
    osBuildHash: H,
    displayHash: H,
    localeThemeHash: H,
    imeHash: H,
    accessibilityHash: H,
    accountIsolationHash: H,
    capturedAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
  });
  const dependencyPath = join(root, "dependency.json");
  const targetPath = join(root, "target.json");
  writeFileSync(dependencyPath, JSON.stringify(dependency));
  writeFileSync(targetPath, JSON.stringify(target));
  return { dependencyPath, targetPath };
}

test("CLI defaults to a non-networking, non-writing preflight and redacts inherited credentials", (t) => {
  const root = mkdtempSync(join(tmpdir(), "xw-m6-model-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = writeFixtures(root);
  const child = spawnSync(process.execPath, [
    cli,
    "--dependency-root", repositoryRoot,
    "--runtime-dependency-qualification", fixture.dependencyPath,
    "--target-environment-attestation", fixture.targetPath,
  ], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, DEEPSEEK_API_KEY: SECRET },
  });
  assert.equal(child.status, 0, child.stderr);
  const output = JSON.parse(child.stdout);
  assert.equal(output.status, "PREFLIGHT_PASS");
  assert.equal(output.networkAccessed, false);
  assert.doesNotMatch(`${child.stdout}\n${child.stderr}`, new RegExp(SECRET, "u"));
});

test("CLI rejects literal credential arguments and requires explicit execute output binding", () => {
  const literal = spawnSync(process.execPath, [cli, "--api-key", SECRET], { encoding: "utf8", cwd: repositoryRoot });
  assert.notEqual(literal.status, 0);
  assert.doesNotMatch(`${literal.stdout}\n${literal.stderr}`, new RegExp(SECRET, "u"));
  assert.match(literal.stderr, /M6_LIVE_MODEL_CLI_INVALID/u);
});
