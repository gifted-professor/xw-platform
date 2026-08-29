import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import {
  inspectControlPlanePrivateMaterial,
  validateControlPlaneSecretEnvironmentBytes,
  validateDigestKeyringBytes,
} from "../ops/control-plane-private-material.mjs";
import {
  createSystemAdministratorsPrivateAclChecker,
  createSystemAdministratorsPrivateAclHardener,
  WINDOWS_PRIVATE_ACL_PROBE,
} from "../control-plane/lib/windows-private-acl.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const PRIVATE = Object.freeze({
  provider: "private-provider-key-fixture-never-print",
  gate: "private-gate-token-fixture-1234567890-abcd",
  live: "private-live-token-fixture-1234567890-abcd",
  account: "7".repeat(64),
  key: Buffer.alloc(32, 23).toString("base64"),
});
const hardenPrivateAcl = createSystemAdministratorsPrivateAclHardener();

function canonical(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function secretDocument(extraVariables = {}) {
  return {
    schemaId: "xw.runtime.control-plane-secret-environment.v1",
    variables: {
      DEEPSEEK_API_KEY: PRIVATE.provider,
      XW_M6_ACCOUNT_ISOLATION_BINDING_HASH: PRIVATE.account,
      XW_M6_GATE_F_OPERATIONS_TOKEN: PRIVATE.gate,
      XW_M6_LIVE_ENTRY_TOKEN: PRIVATE.live,
      ...extraVariables,
    },
  };
}

function keyringDocument(extra = {}) {
  return {
    schemaId: "xw.digest-keyring.v1",
    activeKeyId: "ka-fixture",
    createdAt: "2026-08-30T00:00:00.000Z",
    keys: [{
      keyId: "ka-fixture",
      keyBase64: PRIVATE.key,
      algorithm: "HMAC-SHA-256",
      status: "active",
      createdAt: "2026-08-30T00:00:00.000Z",
    }],
    ...extra,
  };
}

function materialize(t) {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "xw-private-material-"));
  t.after(() => rmSync(runtimeRoot, { recursive: true, force: true }));
  const secrets = join(runtimeRoot, "secrets");
  mkdirSync(secrets);
  const secretPath = join(secrets, "control-plane-secret-environment.v1.json");
  const keyringPath = join(secrets, "xhs-evidence-digest-keyring.v1.json");
  writeFileSync(secretPath, canonical(secretDocument()));
  writeFileSync(keyringPath, canonical(keyringDocument()));
  if (process.platform === "win32") {
    hardenPrivateAcl(secretPath);
    hardenPrivateAcl(keyringPath);
  }
  return { runtimeRoot, secretPath, keyringPath };
}

test("private material exact schemas return presence and hashes without values", (t) => {
  const fixture = materialize(t);
  const view = inspectControlPlanePrivateMaterial({ runtimeRoot: fixture.runtimeRoot });
  assert.match(view.secretEnvironment.sha256, /^[0-9a-f]{64}$/u);
  assert.match(view.digestKeyring.sha256, /^[0-9a-f]{64}$/u);
  assert.deepEqual(new Set(Object.values(view.secretEnvironment.requiredEnvironment)), new Set(["present"]));
  assert.equal(view.digestKeyring.activeKeyId, "present");
  assert.equal(view.digestKeyring.keyMaterial, "present");
  const output = JSON.stringify(view);
  for (const marker of Object.values(PRIVATE)) assert.equal(output.includes(marker), false);
});

test("secret absence, extra key, malformed hash, token aliasing, and keyring extra fields fail closed", (t) => {
  assert.throws(
    () => inspectControlPlanePrivateMaterial({ runtimeRoot: join(tmpdir(), "definitely-absent-private-material") }),
    /GATE_F_/u,
  );
  assert.throws(
    () => validateControlPlaneSecretEnvironmentBytes(canonical(secretDocument({ EXTRA_PRIVATE_VALUE: "no" }))),
    /GATE_F_SECRET_ENVIRONMENT_INVALID/u,
  );
  const badHash = secretDocument();
  badHash.variables.XW_M6_ACCOUNT_ISOLATION_BINDING_HASH = "x".repeat(64);
  assert.throws(
    () => validateControlPlaneSecretEnvironmentBytes(canonical(badHash)),
    /GATE_F_SECRET_ENVIRONMENT_INVALID/u,
  );
  const aliased = secretDocument();
  aliased.variables.XW_M6_LIVE_ENTRY_TOKEN = aliased.variables.XW_M6_GATE_F_OPERATIONS_TOKEN;
  assert.throws(
    () => validateControlPlaneSecretEnvironmentBytes(canonical(aliased)),
    /GATE_F_SECRET_ENVIRONMENT_INVALID/u,
  );
  assert.throws(
    () => validateDigestKeyringBytes(canonical(keyringDocument({ extra: true }))),
    /GATE_F_DIGEST_KEYRING_INVALID/u,
  );
  const duplicate = keyringDocument();
  duplicate.keys.push({ ...duplicate.keys[0] });
  assert.throws(
    () => validateDigestKeyringBytes(canonical(duplicate)),
    /GATE_F_DIGEST_KEYRING_INVALID/u,
  );
});

test("native Windows ACL checker uses a minimal environment and rejects ACL drift", () => {
  const calls = [];
  const plainFile = { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, nlink: 1 };
  const plainDirectory = { isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false, nlink: 1 };
  const checker = createSystemAdministratorsPrivateAclChecker({
    platform: "win32",
    systemRoot: "C:\\Windows",
    lstatSyncFn: (path) => path.endsWith(".json") ? plainFile : plainDirectory,
    execFileSyncFn: (...args) => {
      calls.push(args);
      return "PRIVATE_ACL_OK";
    },
  });
  checker("C:\\runtime\\secrets\\xhs-evidence-digest-keyring.v1.json");
  assert.equal(calls.length, 1);
  const [executable, args, options] = calls[0];
  assert.match(executable, /WindowsPowerShell\\v1\.0\\powershell\.exe$/iu);
  assert.ok(args.includes("-EncodedCommand"));
  assert.deepEqual(Object.keys(options.env).sort(), ["SystemRoot", "WINDIR", "XW_PRIVATE_ACL_TARGET"]);
  assert.equal(options.env.DEEPSEEK_API_KEY, undefined);
  for (const token of ["S-1-5-18", "S-1-5-32-544", "AreAccessRulesProtected", "rules.Count -ne 2"]) {
    assert.match(WINDOWS_PRIVATE_ACL_PROBE, new RegExp(token.replaceAll(".", "\\."), "u"));
  }

  const driftChecker = createSystemAdministratorsPrivateAclChecker({
    platform: "win32",
    systemRoot: "C:\\Windows",
    lstatSyncFn: (path) => path.endsWith(".json") ? plainFile : plainDirectory,
    execFileSyncFn: () => {
      throw Object.assign(new Error("rejected"), { status: 23, stderr: "PRIVATE_ACL_INVALID" });
    },
  });
  assert.throws(
    () => driftChecker("C:\\runtime\\secrets\\xhs-evidence-digest-keyring.v1.json"),
    (error) => error.code === "KEYRING_ACL_INVALID",
  );
});

test("private material inspector rejects inherited or otherwise loose Windows ACLs", {
  skip: process.platform !== "win32",
}, (t) => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "xw-private-material-loose-"));
  t.after(() => rmSync(runtimeRoot, { recursive: true, force: true }));
  const secrets = join(runtimeRoot, "secrets");
  mkdirSync(secrets);
  writeFileSync(join(secrets, "control-plane-secret-environment.v1.json"), canonical(secretDocument()));
  writeFileSync(join(secrets, "xhs-evidence-digest-keyring.v1.json"), canonical(keyringDocument()));
  assert.throws(
    () => inspectControlPlanePrivateMaterial({ runtimeRoot }),
    /GATE_F_PRIVATE_MATERIAL_UNAVAILABLE|KEYRING_ACL_INVALID/u,
  );
});

test("provisioner defaults to verification, takes no secret arguments, and uses native RNG plus protected ACLs", () => {
  const path = join(REPO_ROOT, "services", "control-plane", "ops", "provision-control-plane-secrets.ps1");
  const source = readFileSync(path, "utf8");
  assert.match(source, /\[string\]\$Mode = "Verify"/u);
  assert.match(source, /RandomNumberGenerator\]::Create\(\)/u);
  assert.match(source, /WindowsBuiltInRole\]::Administrator/u);
  assert.match(source, /GATE_F_PROVISION_ELEVATION_REQUIRED/u);
  assert.match(source, /SetAccessRuleProtection\(\$true, \$false\)/u);
  assert.match(source, /S-1-5-18/u);
  assert.match(source, /S-1-5-32-544/u);
  assert.match(source, /GetEnvironmentVariable\("DEEPSEEK_API_KEY", "Process"\)/u);
  assert.match(source, /GetEnvironmentVariable\("XW_M6_ACCOUNT_ISOLATION_BINDING_HASH", "Process"\)/u);
  const parameterBlock = /^param\([\s\S]*?^\)/mu.exec(source)?.[0] ?? "";
  assert.doesNotMatch(
    parameterBlock,
    /DEEPSEEK_API_KEY|XW_M6_GATE_F_OPERATIONS_TOKEN|XW_M6_LIVE_ENTRY_TOKEN|XW_M6_ACCOUNT_ISOLATION_BINDING_HASH/u,
  );
  assert.doesNotMatch(source, /Write-(?:Host|Output).*(?:providerKey|gateToken|liveToken|accountHash|keyBase64)/iu);
  assert.equal(dirname(path).endsWith(join("control-plane", "ops")), true);
});
