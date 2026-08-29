#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyReleaseManifest } from "../../../packages/release/lib/release-manifest.mjs";
import {
  M64_STRICT_FIXED_RUNTIME_ROOT,
} from "./m6-strict-fixed-qualification-operator.mjs";

const SELF_RELEASE_PATH = "services/control-plane/ops/provision-control-plane-secrets-fixed.mjs";
const SCRIPT_RELEASE_PATH = "services/control-plane/ops/provision-control-plane-secrets.ps1";
const HASH = /^(?!0{64}$)[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const RELEASE_ID = /^[a-z0-9][a-z0-9._-]{2,127}$/u;
const MINIMUM_ENVIRONMENT = Object.freeze([
  "SystemRoot", "WINDIR", "ComSpec", "PSModulePath", "PATH", "Path", "PATHEXT",
  "TEMP", "TMP", "LOCALAPPDATA", "ProgramData", "ProgramFiles",
]);

function fail(code, message) {
  throw Object.assign(new Error(`${code}: ${message}`), { code });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function parseM64FixedSecretProvisionArgs(argv) {
  if (!Array.isArray(argv) || argv.length !== 0) {
    fail("M64_FIXED_SECRET_CLI_INVALID", "fixed secret provision accepts no arguments");
  }
  return Object.freeze({ provision: true });
}

function manifestEntry(manifest) {
  const matches = manifest?.files?.filter?.((entry) => entry?.path === SCRIPT_RELEASE_PATH) ?? [];
  if (matches.length !== 1 || !HASH.test(matches[0].sha256 ?? "")) {
    fail("M64_FIXED_SECRET_RELEASE_INVALID", "tracked provisioner is absent from the current formal release");
  }
  return matches[0];
}

function samePath(left, right) {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function within(root, target) {
  const value = relative(resolve(root), resolve(target));
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

function plainFile(path, label) {
  let stat;
  try { stat = lstatSync(path); } catch { fail("M64_FIXED_SECRET_RELEASE_INVALID", `${label} is unavailable`); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 1 || stat.size > 64 * 1024 * 1024) {
    fail("M64_FIXED_SECRET_RELEASE_INVALID", `${label} is not one bounded plain file`);
  }
  return readFileSync(path);
}

export function resolveM64ExecutingSecretProvisionRelease({
  runtimeRoot = M64_STRICT_FIXED_RUNTIME_ROOT,
  operatorPath = fileURLToPath(import.meta.url),
  verifyManifest = verifyReleaseManifest,
} = {}) {
  const runtime = resolve(runtimeRoot);
  const releasesRoot = join(runtime, "releases");
  const executingPath = resolve(operatorPath);
  if (!within(releasesRoot, executingPath)) {
    fail("M64_FIXED_SECRET_RELEASE_INVALID", "executing provisioner escaped the fixed release store");
  }
  const rel = relative(releasesRoot, executingPath).split(/[\\/]/u);
  const releaseId = rel.shift();
  if (!RELEASE_ID.test(releaseId ?? "") || rel.join("/") !== SELF_RELEASE_PATH) {
    fail("M64_FIXED_SECRET_RELEASE_INVALID", "executing provisioner is not in one exact formal release slot");
  }
  const releaseRoot = join(releasesRoot, releaseId);
  const manifestPath = join(releaseRoot, "release-manifest.v1.json");
  let manifest;
  try { manifest = JSON.parse(plainFile(manifestPath, "formal release manifest").toString("utf8")); }
  catch (error) {
    if (error?.code) throw error;
    fail("M64_FIXED_SECRET_RELEASE_INVALID", "formal release manifest is malformed");
  }
  if (manifest.releaseId !== releaseId || !COMMIT.test(manifest.sourceCommit ?? "")
    || verifyManifest({ root: releaseRoot, manifestPath })?.ok !== true) {
    fail("M64_FIXED_SECRET_RELEASE_INVALID", "executing formal release identity failed verification");
  }
  for (const releasePath of [SELF_RELEASE_PATH, SCRIPT_RELEASE_PATH]) {
    const matches = manifest.files?.filter?.((entry) => entry?.path === releasePath) ?? [];
    const target = join(releaseRoot, ...releasePath.split("/"));
    if (matches.length !== 1 || !HASH.test(matches[0].sha256 ?? "")
      || sha256(plainFile(target, releasePath)) !== matches[0].sha256
      || (releasePath === SELF_RELEASE_PATH && !samePath(target, executingPath))) {
      fail("M64_FIXED_SECRET_RELEASE_DRIFT", "executing provision closure differs from its formal manifest");
    }
  }
  return Object.freeze({ runtimeRoot: runtime, releaseRoot, releaseId, sourceCommit: manifest.sourceCommit, manifest });
}

function inspectExistingPrivateMaterial(runtimeRoot) {
  const secretsRoot = join(runtimeRoot, "secrets");
  const secretPath = join(secretsRoot, "control-plane-secret-environment.v1.json");
  const keyringPath = join(secretsRoot, "xhs-evidence-digest-keyring.v1.json");
  const secret = existsSync(secretPath);
  const keyring = existsSync(keyringPath);
  if (secret !== keyring) {
    fail("M64_FIXED_SECRET_PARTIAL_STATE", "one-file private material residue requires operator recovery");
  }
  return Object.freeze({ mode: secret ? "Verify" : "Provision", secretPath, keyringPath });
}

function powershellPath(env) {
  const windowsRoot = env.SystemRoot || env.WINDIR || "C:\\Windows";
  return join(windowsRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

export function provisionM64ControlPlaneSecretsFixed({ env = process.env } = {}, dependencies = {}) {
  const deps = {
    resolveRelease: resolveM64ExecutingSecretProvisionRelease,
    inspectExisting: inspectExistingPrivateMaterial,
    randomBytes,
    spawn: spawnSync,
    ...dependencies,
  };
  let providerValue = null;
  let providerBytes = null;
  let accountBytes = null;
  let childEnv;
  try {
    const release = deps.resolveRelease({ runtimeRoot: M64_STRICT_FIXED_RUNTIME_ROOT });
    const existing = deps.inspectExisting(M64_STRICT_FIXED_RUNTIME_ROOT);
    const provisionerPath = join(release.releaseRoot, ...SCRIPT_RELEASE_PATH.split("/"));
    const expected = manifestEntry(release.manifest).sha256;
    if (sha256(readFileSync(provisionerPath)) !== expected) {
      fail("M64_FIXED_SECRET_RELEASE_DRIFT", "tracked provisioner differs from the current release manifest");
    }
    childEnv = Object.fromEntries(MINIMUM_ENVIRONMENT
      .filter((name) => typeof env[name] === "string")
      .map((name) => [name, env[name]]));
    if (existing.mode === "Provision") {
      providerValue = env.DEEPSEEK_API_KEY;
      if (typeof providerValue !== "string" || providerValue.length < 8 || providerValue.length > 4096
        || /[\0\r\n]/u.test(providerValue)) {
        fail("M64_FIXED_SECRET_INPUT_UNAVAILABLE", "process DEEPSEEK credential is unavailable");
      }
      providerBytes = Buffer.from(providerValue, "utf8");
      accountBytes = deps.randomBytes(32);
      if (!Buffer.isBuffer(accountBytes) || accountBytes.length !== 32) {
        fail("M64_FIXED_SECRET_RANDOM_UNAVAILABLE", "CSPRNG did not return exactly 256 bits");
      }
      childEnv.DEEPSEEK_API_KEY = providerBytes.toString("utf8");
      childEnv.XW_M6_ACCOUNT_ISOLATION_BINDING_HASH = accountBytes.toString("hex");
    }
    const child = deps.spawn(powershellPath(env), [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", provisionerPath, "-Mode", existing.mode,
    ], {
      cwd: release.releaseRoot,
      env: childEnv,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (child?.status !== 0) {
      fail("M64_FIXED_SECRET_PROVISION_FAILED", "tracked fixed provisioner failed closed");
    }
    let receipt;
    try { receipt = JSON.parse(child.stdout); } catch {
      fail("M64_FIXED_SECRET_PROVISION_FAILED", "tracked fixed provisioner returned an invalid receipt");
    }
    const secretHash = receipt?.secretEnvironment?.sha256;
    const keyringHash = receipt?.digestKeyring?.sha256;
    if (receipt?.ok !== true || !HASH.test(secretHash ?? "") || !HASH.test(keyringHash ?? "")) {
      fail("M64_FIXED_SECRET_PROVISION_FAILED", "tracked fixed provisioner receipt is incomplete");
    }
    return Object.freeze({
      schemaId: "xw.runtime.control-plane-private-material-fixed-provision.v1",
      status: existing.mode === "Provision" ? "PROVISIONED" : "ADOPTED",
      receiptHash: sha256(Buffer.from(`${secretHash}:${keyringHash}`, "utf8")),
    });
  } finally {
    providerBytes?.fill(0);
    accountBytes?.fill(0);
    if (childEnv) {
      childEnv.DEEPSEEK_API_KEY = "";
      childEnv.XW_M6_ACCOUNT_ISOLATION_BINDING_HASH = "";
    }
    env.DEEPSEEK_API_KEY = "";
    providerValue = null;
  }
}

export function main(argv = process.argv.slice(2), { env = process.env, stdout = process.stdout, dependencies = {} } = {}) {
  parseM64FixedSecretProvisionArgs(argv);
  const result = provisionM64ControlPlaneSecretsFixed({ env }, dependencies);
  stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

const entry = process.argv[1] ? resolve(process.argv[1]) : null;
if (entry === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    process.stderr.write(`${error?.code ?? "M64_FIXED_SECRET_FAILED"}: fixed secret provision failed\n`);
    process.exitCode = 1;
  }
}
