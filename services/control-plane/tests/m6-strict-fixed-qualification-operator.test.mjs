import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { canonicalJson, sha256 } from "../control-plane/lib/canonical.mjs";
import {
  loadM64StrictFixedOperationReceipt,
  operateM64StrictFixedAssemblerBridge,
  parseM64StrictFixedAssemblerBridgeArgs,
} from "../ops/m6-strict-fixed-assembler-bridge.mjs";
import {
  M64_STRICT_FIXED_RUNTIME_ROOT,
  operateM64StrictFixedQualification,
  parseM64StrictFixedQualificationArgs,
  resolveM64StrictFixedQualificationAuthority,
} from "../ops/m6-strict-fixed-qualification-operator.mjs";
import {
  main as secretMain,
  parseM64FixedSecretProvisionArgs,
  resolveM64ExecutingSecretProvisionRelease,
} from "../ops/provision-control-plane-secrets-fixed.mjs";

const RELEASE_ID = "xw-xhs-v3-r03-test";
const SOURCE_COMMIT = "a".repeat(40);
const PACKAGE_HASH = "b".repeat(64);
const GATE_ID = "m6-fixed-test";
const SENTINEL_HASH = sha256("xw.m6-c1-qualification-bootstrap.inventory-unavailable.v1");

function fileHash(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeJson(path, value) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return path;
}

function authorityFixture() {
  const root = mkdtempSync(join(tmpdir(), "xw-m6-fixed-qualification-"));
  const releaseRoot = join(root, "releases", RELEASE_ID);
  mkdirSync(releaseRoot, { recursive: true });
  const manifestPath = writeJson(join(releaseRoot, "release-manifest.v1.json"), {
    schemaId: "xw.runtime.release-manifest.v1",
    releaseId: RELEASE_ID,
    sourceCommit: SOURCE_COMMIT,
    files: [],
  });
  symlinkSync(releaseRoot, join(root, "current"), "junction");
  const bindingPath = join(root, "config", "m6-c1-qualification-bootstrap.v1.json");
  const binding = {
    schemaId: "xw.runtime.m6-c1-qualification-bootstrap.v1",
    releaseId: RELEASE_ID,
    sourceCommit: SOURCE_COMMIT,
    sourceReleaseRoot: releaseRoot,
    releaseManifestSha256: fileHash(manifestPath),
    gateId: GATE_ID,
    gateIssuerAllowlistPath: join(root, "m6-gate", "issuer-keys.json"),
    gateFArtifactInventoryPath: join(root, "qualification-bootstrap", "final-inventory-unavailable.json"),
    gateFArtifactInventoryHash: SENTINEL_HASH,
  };
  writeJson(bindingPath, binding);
  writeJson(binding.gateIssuerAllowlistPath, { schemaId: "test" });
  const packageRecord = {
    packageHash: PACKAGE_HASH,
    releaseId: RELEASE_ID,
    sourceCommit: SOURCE_COMMIT,
    gateId: GATE_ID,
    scenarioManifest: { attemptCount: 0 },
    aggregate: { attemptCount: 0 },
    resourceSnapshot: {
      actionCount: 0,
      before: { activeActions: 0, activeJobs: 0, activeLeases: 0, activeRuns: 0, activeSessions: 0 },
      after: { activeActions: 0, activeJobs: 0, activeLeases: 0, activeRuns: 0, activeSessions: 0 },
    },
  };
  writeJson(
    join(root, "m6-gate", GATE_ID, "qualification-bootstrap", `${PACKAGE_HASH}.package.json`),
    packageRecord,
  );
  const receiptBody = {
    schemaId: "xw.m6-c1-qualification-bootstrap-operator-receipt.v1",
    releaseId: RELEASE_ID,
    sourceCommit: SOURCE_COMMIT,
    gateId: GATE_ID,
    packageHash: PACKAGE_HASH,
    generation: 0,
    mode: "CLOSED",
    bindingPath,
    bindingSha256: fileHash(bindingPath),
    releaseManifestSha256: fileHash(manifestPath),
    gateFArtifactInventoryPath: binding.gateFArtifactInventoryPath,
    gateFArtifactInventoryHash: SENTINEL_HASH,
    actionCount: 0,
    resourceCounts: { jobs: 0, sessions: 0, leases: 0, actionCount: 0, pendingApprovals: 0 },
    privateKeyAccessed: false,
    secretMaterialPresent: false,
    providerAccessed: false,
    deviceAccessed: false,
    networkAccessed: false,
  };
  const receipt = {
    ...receiptBody,
    receiptHash: sha256(`${receiptBody.schemaId}:${canonicalJson(receiptBody)}`),
  };
  const receiptPath = writeJson(
    join(root, "qualification-bootstrap", "receipts", `${receipt.receiptHash}.json`),
    receipt,
  );
  return {
    root,
    releaseRoot,
    manifestPath,
    bindingPath,
    binding,
    packageRecord,
    receipt,
    receiptPath,
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
}

test("strict-fixed grammars reject forged paths and every extra argument", () => {
  assert.deepEqual(parseM64StrictFixedQualificationArgs(["execute-fixed"]), { execute: true });
  assert.throws(
    () => parseM64StrictFixedQualificationArgs([
      "execute-fixed", "--artifact-root", "C:\\forged", "--model", "caller-model",
    ]),
    { code: "M64_STRICT_FIXED_CLI_INVALID" },
  );
  assert.deepEqual(parseM64FixedSecretProvisionArgs([]), { provision: true });
  assert.throws(
    () => parseM64FixedSecretProvisionArgs(["--runtime-root", "C:\\forged"]),
    { code: "M64_FIXED_SECRET_CLI_INVALID" },
  );
  assert.deepEqual(parseM64StrictFixedAssemblerBridgeArgs([]), { execute: true });
  assert.throws(
    () => parseM64StrictFixedAssemblerBridgeArgs(["--account-binding", "secret"]),
    { code: "M64_STRICT_FIXED_BRIDGE_CLI_INVALID" },
  );
});

test("authority resolves the current release/package/receipt store and rejects forged paths or nonzero resources", () => {
  const fixture = authorityFixture();
  const dependencies = {
    runtimeRoot: fixture.root,
    verifyManifest: () => ({ ok: true }),
    validatePackage: ({ package: record }) => ({ package: record }),
  };
  try {
    const authority = resolveM64StrictFixedQualificationAuthority(dependencies);
    assert.equal(authority.releaseId, RELEASE_ID);
    assert.equal(authority.identity.packageHash, PACKAGE_HASH);
    assert.equal(authority.identity.receiptHash, fixture.receipt.receiptHash);

    writeJson(fixture.bindingPath, { ...fixture.binding, sourceReleaseRoot: join(fixture.root, "forged") });
    assert.throws(
      () => resolveM64StrictFixedQualificationAuthority(dependencies),
      { code: "M64_STRICT_FIXED_RELEASE_DRIFT" },
    );

    writeJson(fixture.bindingPath, fixture.binding);
    const reboundReceiptBody = { ...fixture.receipt, resourceCounts: { ...fixture.receipt.resourceCounts, jobs: 1 } };
    delete reboundReceiptBody.receiptHash;
    const reboundReceipt = {
      ...reboundReceiptBody,
      receiptHash: sha256(`${reboundReceiptBody.schemaId}:${canonicalJson(reboundReceiptBody)}`),
    };
    rmSync(fixture.receiptPath);
    writeJson(
      join(fixture.root, "qualification-bootstrap", "receipts", `${reboundReceipt.receiptHash}.json`),
      reboundReceipt,
    );
    assert.throws(
      () => resolveM64StrictFixedQualificationAuthority(dependencies),
      { code: "M64_STRICT_FIXED_RECEIPT_INVALID" },
    );
  } finally {
    fixture.cleanup();
  }
});

function fakeAuthority(identityHash = "1".repeat(64)) {
  return Object.freeze({
    runtimeRoot: M64_STRICT_FIXED_RUNTIME_ROOT,
    releaseRoot: join(M64_STRICT_FIXED_RUNTIME_ROOT, "releases", RELEASE_ID),
    releaseId: RELEASE_ID,
    sourceCommit: SOURCE_COMMIT,
    sourceShort: SOURCE_COMMIT.slice(0, 7),
    manifestSha256: "9".repeat(64),
    packagePath: join(M64_STRICT_FIXED_RUNTIME_ROOT, "m6-gate", GATE_ID, "qualification-bootstrap", `${PACKAGE_HASH}.package.json`),
    receiptPath: join(M64_STRICT_FIXED_RUNTIME_ROOT, "qualification-bootstrap", "receipts", `${"c".repeat(64)}.json`),
    targetRoot: join(M64_STRICT_FIXED_RUNTIME_ROOT, "m6-audit", `m6-c1-target-environment-${SOURCE_COMMIT.slice(0, 7)}`),
    dependencyLayersRoot: join(M64_STRICT_FIXED_RUNTIME_ROOT, "m6-runtime-layers"),
    modelRoot: join(M64_STRICT_FIXED_RUNTIME_ROOT, "m6-audit", `m6-c1-live-model-qualification-${SOURCE_COMMIT.slice(0, 7)}`),
    identityHash,
  });
}

function fixedSecret() {
  return {
    bytes: Buffer.from("private-buffer"),
    variables: {
      DEEPSEEK_API_KEY: "sk-private-test",
      XW_M6_ACCOUNT_ISOLATION_BINDING_HASH: "d".repeat(64),
      XW_M6_GATE_F_OPERATIONS_TOKEN: "gate-token-private-value-000000000000",
      XW_M6_LIVE_ENTRY_TOKEN: "live-token-private-value-000000000000",
    },
  };
}

test("strict-fixed operator runs target, dependency, and model in order under one identity and clears secrets", async () => {
  const calls = [];
  const authority = fakeAuthority();
  const secret = fixedSecret();
  const H = (char) => char.repeat(64);
  const result = await operateM64StrictFixedQualification({}, {
    resolveAuthority: () => authority,
    loadExistingReceipt: () => null,
    loadSecrets: () => secret,
    runTarget: async (input) => {
      calls.push("target");
      assert.equal(input.controlPlaneUrl, "http://127.0.0.1:17920/");
      assert.equal(input.artifactRoot, authority.targetRoot);
      assert.equal(Object.hasOwn(input, "model"), false);
      return { attestationHash: H("2"), qualificationHash: H("3"), actionCount: 0 };
    },
    materializeDependency: (input) => {
      calls.push("dependency");
      assert.equal(input.releaseRoot, authority.releaseRoot);
      assert.equal(input.layersRoot, authority.dependencyLayersRoot);
      return {
        layerRoot: join(authority.dependencyLayersRoot, H("4")),
        layerHash: H("4"),
        qualification: {
          qualificationHash: H("5"),
          releaseId: RELEASE_ID,
          sourceCommit: SOURCE_COMMIT,
          sourceReleaseManifestSha256: authority.manifestSha256,
        },
      };
    },
    inspectTargetArtifacts: () => ({ attestation: { attestationHash: H("2") }, qualification: {} }),
    qualifyModel: async (input) => {
      calls.push("model");
      assert.deepEqual(Object.keys(input.environment), ["DEEPSEEK_API_KEY"]);
      return { status: "QUALIFIED" };
    },
    writeModel: (input) => {
      assert.equal(input.outputRoot, authority.modelRoot);
      return { root: authority.modelRoot, profileHash: H("6") };
    },
    publishReceipt: (_authority, receipt) => {
      assert.equal(receipt.releaseId, RELEASE_ID);
      assert.equal(receipt.sourceCommit, SOURCE_COMMIT);
      return { replay: false };
    },
  });
  assert.deepEqual(calls, ["target", "dependency", "model"]);
  assert.equal(result.status, "QUALIFIED");
  assert.equal(result.releaseId, RELEASE_ID);
  assert.equal(result.sourceCommit, SOURCE_COMMIT);
  assert.equal(result.actionCount, 0);
  assert.equal(result.modelProfileHash, H("6"));
  assert.doesNotMatch(
    JSON.stringify(result),
    /sk-private-test|gate-token-private-value|live-token-private-value|d{64}/u,
  );
  assert.equal(secret.bytes.every((byte) => byte === 0), true);
  assert.equal(Object.values(secret.variables).every((value) => value === null), true);
});

test("strict-fixed operator fails before dependency/model when current release identity drifts", async () => {
  const first = fakeAuthority("1".repeat(64));
  const second = fakeAuthority("2".repeat(64));
  const secret = fixedSecret();
  let resolves = 0;
  let dependencyCalls = 0;
  await assert.rejects(
    operateM64StrictFixedQualification({}, {
      resolveAuthority: () => (resolves++ === 0 ? first : second),
      loadExistingReceipt: () => null,
      loadSecrets: () => secret,
      runTarget: async () => ({ attestationHash: "2".repeat(64), qualificationHash: "3".repeat(64), actionCount: 0 }),
      publishReceipt: () => assert.fail("drift must fail before receipt publication"),
      materializeDependency: () => { dependencyCalls += 1; },
    }),
    { code: "M64_STRICT_FIXED_RELEASE_DRIFT" },
  );
  assert.equal(dependencyCalls, 0);
  assert.equal(secret.bytes.every((byte) => byte === 0), true);
});

test("crash retry returns the existing content-addressed qualification receipt without rerunning any stage", async () => {
  const authority = fakeAuthority();
  const existing = operationReceipt(authority);
  let stageCalls = 0;
  const result = await operateM64StrictFixedQualification({}, {
    resolveAuthority: () => authority,
    loadExistingReceipt: () => existing,
    loadSecrets: () => { stageCalls += 1; },
    runTarget: () => { stageCalls += 1; },
    materializeDependency: () => { stageCalls += 1; },
    qualifyModel: () => { stageCalls += 1; },
  });
  assert.equal(result.operationHash, existing.operationHash);
  assert.equal(stageCalls, 0);
});

function operationReceipt(authority, overrides = {}) {
  const body = {
    schemaId: "xw.m6-strict-fixed-qualification-operation.v1",
    status: "QUALIFIED",
    releaseId: authority.releaseId,
    sourceCommit: authority.sourceCommit,
    authorityHash: authority.identityHash,
    targetEnvironmentAttestationHash: "2".repeat(64),
    environmentQualificationSha256: "3".repeat(64),
    dependencyLayerHash: "4".repeat(64),
    runtimeDependencyQualificationHash: "5".repeat(64),
    modelProfileHash: "6".repeat(64),
    actionCount: 0,
    secretMaterialPresent: false,
    ...overrides,
  };
  return Object.freeze({
    ...body,
    operationHash: sha256(`${body.schemaId}:${canonicalJson(body)}`),
  });
}

test("A/B distinct-source receipt loader selects only B and never reuses A qualification evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "xw-fixed-a-b-receipts-"));
  try {
    const authorityA = { ...fakeAuthority("a".repeat(64)), runtimeRoot: root, sourceCommit: "a".repeat(40), sourceShort: "aaaaaaa" };
    const authorityB = { ...fakeAuthority("b".repeat(64)), runtimeRoot: root, sourceCommit: "b".repeat(40), sourceShort: "bbbbbbb" };
    const receiptA = operationReceipt(authorityA);
    const receiptB = operationReceipt(authorityB);
    writeJson(join(root, "m6-audit", "m6-c1-strict-fixed-qualification-aaaaaaa", "receipts", `${receiptA.operationHash}.json`), receiptA);
    writeJson(join(root, "m6-audit", "m6-c1-strict-fixed-qualification-bbbbbbb", "receipts", `${receiptB.operationHash}.json`), receiptB);
    const selected = loadM64StrictFixedOperationReceipt(authorityB);
    assert.equal(selected.sourceCommit, authorityB.sourceCommit);
    assert.equal(selected.operationHash, receiptB.operationHash);
    assert.notEqual(selected.operationHash, receiptA.operationHash);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("zero-arg assembler bridge reads B receipt/account internally and rejects an A receipt", () => {
  const authorityB = { ...fakeAuthority("b".repeat(64)), sourceCommit: "b".repeat(40), sourceShort: "bbbbbbb" };
  const receiptB = operationReceipt(authorityB);
  const secret = fixedSecret();
  let assembledInput;
  const result = operateM64StrictFixedAssemblerBridge({
    resolveAuthority: () => authorityB,
    loadReceipt: () => receiptB,
    loadSecrets: () => secret,
    buildAssembler: (input) => {
      assembledInput = input;
      return {
        mode: "EXECUTE",
        releaseId: authorityB.releaseId,
        sourceCommit: authorityB.sourceCommit,
        authorityHash: "7".repeat(64),
        assemblerInputSha256: "8".repeat(64),
        assemblerReceiptHash: "9".repeat(64),
      };
    },
  });
  assert.equal(result.status, "ASSEMBLED");
  assert.equal(assembledInput.accountIsolationBindingHash, "d".repeat(64));
  assert.equal(assembledInput.releaseId, authorityB.releaseId);
  assert.equal(assembledInput.sourceCommit, authorityB.sourceCommit);
  assert.doesNotMatch(
    JSON.stringify(result),
    /sk-private-test|gate-token-private-value|live-token-private-value|d{64}/u,
  );
  assert.equal(secret.bytes.every((byte) => byte === 0), true);
  assert.throws(
    () => operateM64StrictFixedAssemblerBridge({
      resolveAuthority: () => authorityB,
      loadReceipt: () => operationReceipt({ ...authorityB, sourceCommit: "a".repeat(40) }),
    }),
    { code: "M64_STRICT_FIXED_BRIDGE_RELEASE_DRIFT" },
  );
});

test("sequential A then B full qualification/assembler cycles preserve distinct receipts across restore", async () => {
  const root = mkdtempSync(join(tmpdir(), "xw-fixed-sequential-a-b-"));
  const H = (char) => char.repeat(64);
  const makeAuthority = (label, identityChar) => {
    const sourceCommit = identityChar.repeat(40);
    const releaseId = `xw-xhs-v3-r03-${label}`;
    return Object.freeze({
      ...fakeAuthority(identityChar.repeat(64)),
      runtimeRoot: root,
      releaseRoot: join(root, "releases", releaseId),
      releaseId,
      sourceCommit,
      sourceShort: sourceCommit.slice(0, 7),
      manifestSha256: H(identityChar),
      targetRoot: join(root, "m6-audit", `m6-c1-target-environment-${sourceCommit.slice(0, 7)}`),
      dependencyLayersRoot: join(root, "m6-runtime-layers"),
      modelRoot: join(root, "m6-audit", `m6-c1-live-model-qualification-${sourceCommit.slice(0, 7)}`),
    });
  };
  const authorityA = makeAuthority("a", "a");
  const authorityB = makeAuthority("b", "b");
  let active = authorityA;

  async function qualify(authority, seed) {
    active = authority;
    return operateM64StrictFixedQualification({}, {
      resolveAuthority: () => active,
      loadExistingReceipt: () => null,
      loadSecrets: () => fixedSecret(),
      runTarget: async () => ({
        attestationHash: H(seed),
        qualificationHash: H(String(Number(seed) + 1)),
        actionCount: 0,
      }),
      inspectTargetArtifacts: (_authority, target) => ({
        attestation: { attestationHash: target.attestationHash },
        qualification: {},
      }),
      materializeDependency: () => ({
        layerRoot: join(authority.dependencyLayersRoot, H(String(Number(seed) + 2))),
        layerHash: H(String(Number(seed) + 2)),
        qualification: {
          qualificationHash: H(String(Number(seed) + 3)),
          releaseId: authority.releaseId,
          sourceCommit: authority.sourceCommit,
          sourceReleaseManifestSha256: authority.manifestSha256,
        },
      }),
      qualifyModel: async () => ({ status: "QUALIFIED" }),
      writeModel: () => ({ root: authority.modelRoot, profileHash: H(String(Number(seed) + 4)) }),
    });
  }

  function assemble(authority, receipt) {
    const secret = fixedSecret();
    return operateM64StrictFixedAssemblerBridge({
      resolveAuthority: () => authority,
      loadReceipt: () => receipt,
      loadSecrets: () => secret,
      buildAssembler: () => ({
        mode: "EXECUTE",
        releaseId: authority.releaseId,
        sourceCommit: authority.sourceCommit,
        authorityHash: H("7"),
        assemblerInputSha256: H("8"),
        assemblerReceiptHash: H("9"),
      }),
    });
  }

  try {
    const receiptA = await qualify(authorityA, "1");
    const assembledA = assemble(authorityA, receiptA);
    const aPath = join(
      root, "m6-audit", `m6-c1-strict-fixed-qualification-${authorityA.sourceShort}`,
      "receipts", `${receiptA.operationHash}.json`,
    );
    const aBytesBeforeRestore = readFileSync(aPath);

    // Exact legacy restore changes runtime activation state, never immutable A evidence.
    active = null;
    assert.deepEqual(readFileSync(aPath), aBytesBeforeRestore);

    const receiptB = await qualify(authorityB, "2");
    const assembledB = assemble(authorityB, receiptB);
    assert.deepEqual(readFileSync(aPath), aBytesBeforeRestore);
    assert.notEqual(receiptA.operationHash, receiptB.operationHash);
    assert.equal(assembledA.releaseId, authorityA.releaseId);
    assert.equal(assembledB.releaseId, authorityB.releaseId);
    assert.notEqual(assembledA.qualificationOperationHash, assembledB.qualificationOperationHash);
    assert.equal(loadM64StrictFixedOperationReceipt(authorityA).operationHash, receiptA.operationHash);
    assert.equal(loadM64StrictFixedOperationReceipt(authorityB).operationHash, receiptB.operationHash);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function provisionFixture() {
  const root = mkdtempSync(join(tmpdir(), "xw-fixed-secret-"));
  const scriptPath = join(root, "services", "control-plane", "ops", "provision-control-plane-secrets.ps1");
  mkdirSync(join(scriptPath, ".."), { recursive: true });
  writeFileSync(scriptPath, "# tracked provisioner\n", "utf8");
  return {
    root,
    scriptPath,
    release: {
      releaseRoot: root,
      manifest: { files: [{ path: "services/control-plane/ops/provision-control-plane-secrets.ps1", sha256: fileHash(scriptPath) }] },
    },
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
}

test("fixed secret provision emits status/hash only, uses internal CSPRNG binding, and clears process secret", () => {
  const fixture = provisionFixture();
  const env = {
    SystemRoot: "C:\\Windows",
    DEEPSEEK_API_KEY: "sk-do-not-output-this",
    SENTINEL_SECRET: "must-not-reach-child-or-output",
  };
  let childSnapshot;
  let stdout = "";
  try {
    const result = secretMain([], {
      env,
      stdout: { write(value) { stdout += value; } },
      dependencies: {
        resolveRelease: () => fixture.release,
        inspectExisting: () => ({ mode: "Provision" }),
        randomBytes: () => Buffer.alloc(32, 0x5a),
        spawn: (_command, args, options) => {
          childSnapshot = { args: [...args], env: { ...options.env } };
          return {
            status: 0,
            stdout: JSON.stringify({
              ok: true,
              secretEnvironment: { sha256: "7".repeat(64) },
              digestKeyring: { sha256: "8".repeat(64) },
            }),
            stderr: "",
          };
        },
      },
    });
    assert.equal(result.status, "PROVISIONED");
    assert.match(result.receiptHash, /^[0-9a-f]{64}$/u);
    assert.equal(childSnapshot.env.XW_M6_ACCOUNT_ISOLATION_BINDING_HASH, "5a".repeat(32));
    assert.equal(Object.hasOwn(childSnapshot.env, "SENTINEL_SECRET"), false);
    assert.deepEqual(childSnapshot.args.slice(-4), ["-File", fixture.scriptPath, "-Mode", "Provision"]);
    assert.doesNotMatch(stdout, /sk-do-not-output-this|5a5a5a5a|must-not-reach-child-or-output/u);
    assert.equal(env.DEEPSEEK_API_KEY, "");
  } finally {
    fixture.cleanup();
  }
});

test("fixed secret provision crashes closed on existing material without reflecting child output", () => {
  const fixture = provisionFixture();
  const marker = "sk-existing-private-marker";
  const env = { DEEPSEEK_API_KEY: marker };
  let stdout = "";
  try {
    assert.throws(
      () => secretMain([], {
        env,
        stdout: { write(value) { stdout += value; } },
        dependencies: {
          resolveRelease: () => fixture.release,
          inspectExisting: () => ({ mode: "Provision" }),
          randomBytes: () => Buffer.alloc(32, 0x44),
          spawn: () => ({ status: 1, stdout: "", stderr: `GATE_F_PRIVATE_MATERIAL_EXISTS ${marker}` }),
        },
      }),
      (error) => error.code === "M64_FIXED_SECRET_PROVISION_FAILED"
        && !error.message.includes(marker),
    );
    assert.equal(stdout, "");
    assert.equal(env.DEEPSEEK_API_KEY, "");
  } finally {
    fixture.cleanup();
  }
});

test("fixed secret provision adopts two existing files but blocks one-file partial residue", () => {
  const fixture = provisionFixture();
  try {
    let mode;
    const adopted = secretMain([], {
      env: {},
      stdout: { write() {} },
      dependencies: {
        resolveRelease: () => fixture.release,
        inspectExisting: () => ({ mode: "Verify" }),
        spawn: (_command, args) => {
          mode = args.at(-1);
          return {
            status: 0,
            stdout: JSON.stringify({
              ok: true,
              secretEnvironment: { sha256: "7".repeat(64) },
              digestKeyring: { sha256: "8".repeat(64) },
            }),
          };
        },
      },
    });
    assert.equal(mode, "Verify");
    assert.equal(adopted.status, "ADOPTED");
    assert.throws(
      () => secretMain([], {
        env: { DEEPSEEK_API_KEY: "sk-not-consumed" },
        stdout: { write() {} },
        dependencies: {
          resolveRelease: () => fixture.release,
          inspectExisting: () => {
            const error = new Error("partial");
            error.code = "M64_FIXED_SECRET_PARTIAL_STATE";
            throw error;
          },
        },
      }),
      { code: "M64_FIXED_SECRET_PARTIAL_STATE" },
    );
  } finally {
    fixture.cleanup();
  }
});

test("secret provision self-identity selects its A release even while current points at a distinct legacy release", () => {
  const root = mkdtempSync(join(tmpdir(), "xw-fixed-secret-self-"));
  try {
    const releaseA = join(root, "releases", "xw-xhs-v3-r03-a");
    const releaseLegacy = join(root, "releases", "xw-xhs-v3-r03-legacy");
    const selfPath = join(releaseA, "services", "control-plane", "ops", "provision-control-plane-secrets-fixed.mjs");
    const scriptPath = join(releaseA, "services", "control-plane", "ops", "provision-control-plane-secrets.ps1");
    mkdirSync(join(selfPath, ".."), { recursive: true });
    mkdirSync(releaseLegacy, { recursive: true });
    writeFileSync(selfPath, "export default true;\n", "utf8");
    writeFileSync(scriptPath, "param()\n", "utf8");
    writeJson(join(releaseA, "release-manifest.v1.json"), {
      releaseId: "xw-xhs-v3-r03-a",
      sourceCommit: "a".repeat(40),
      files: [
        { path: "services/control-plane/ops/provision-control-plane-secrets-fixed.mjs", sha256: fileHash(selfPath) },
        { path: "services/control-plane/ops/provision-control-plane-secrets.ps1", sha256: fileHash(scriptPath) },
      ],
    });
    symlinkSync(releaseLegacy, join(root, "current"), "junction");
    const selected = resolveM64ExecutingSecretProvisionRelease({
      runtimeRoot: root,
      operatorPath: selfPath,
      verifyManifest: () => ({ ok: true }),
    });
    assert.equal(selected.releaseRoot, releaseA);
    assert.notEqual(selected.releaseRoot, releaseLegacy);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
