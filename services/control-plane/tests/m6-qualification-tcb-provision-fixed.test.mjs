import assert from "node:assert/strict";
import {
  generateKeyPairSync,
} from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  inspectM64QualificationTcbClosure,
  M64_QUALIFICATION_TCB_INVENTORY_SENTINEL_HASH,
  publishM64QualificationTcbReceipt,
  verifyM64QualificationTcbProvisionReceipt,
} from "../control-plane/lib/m6-qualification-tcb.mjs";
import { sha256 } from "../control-plane/lib/canonical.mjs";
import {
  buildSystemTcbAclPlan,
  createSystemTcbAclController,
} from "../control-plane/lib/windows-system-tcb-acl.mjs";
import {
  main,
  parseM64QualificationTcbProvisionFixedArgs,
  provisionM64QualificationTcbFixed,
} from "../ops/m6-qualification-tcb-provision-fixed.mjs";

const RELEASE_ID = "xw-xhs-v3-r03-tcb-fixture";
const SOURCE_COMMIT = "a".repeat(40);

function writeJson(path, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  writeFileSync(path, bytes);
  return bytes;
}

function powershell() {
  return join(
    process.env.SystemRoot || process.env.WINDIR || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

function sddl(path) {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  return execFileSync(powershell(), [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    "(Get-Acl -LiteralPath $env:XW_TEST_ACL_PATH).Sddl",
  ], {
    encoding: "utf8",
    env: {
      SystemRoot: systemRoot,
      WINDIR: systemRoot,
      XW_TEST_ACL_PATH: path,
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function windowsFixture(t, { multipleActive = false, hardlinkKey = false } = {}) {
  // C:\Users\Public is the production runtime's externally verified parent
  // chain.  Program Files permits an untrusted self-applicable create right at
  // one ancestor on this host, which the TCB policy correctly rejects before
  // it can protect the disposable fixture root.
  const runtimeRoot = mkdtempSync(join("C:\\Users\\Public", "XW-M64-Tcb-Test-"));
  t.after(() => rmSync(runtimeRoot, { recursive: true, force: true }));
  const native = createSystemTcbAclController();
  native.protect(buildSystemTcbAclPlan({
    boundaryPath: runtimeRoot,
    targetPath: runtimeRoot,
    recursive: false,
  }));
  const gateRoot = join(runtimeRoot, "m6-gate");
  const secretsRoot = join(runtimeRoot, "secrets");
  const operatorKeysRoot = join(secretsRoot, "operator-keys");
  const configRoot = join(runtimeRoot, "config");
  mkdirSync(gateRoot);
  mkdirSync(secretsRoot);
  mkdirSync(operatorKeysRoot);
  mkdirSync(configRoot);

  const first = generateKeyPairSync("ed25519");
  const second = generateKeyPairSync("ed25519");
  const publicPem = (key) => key.export({ format: "pem", type: "spki" }).toString("utf8");
  const privatePem = first.privateKey.export({ format: "pem", type: "pkcs8" });
  const issuerAllowlistPath = join(gateRoot, "issuer-keys.json");
  writeJson(issuerAllowlistPath, {
    schemaId: "xw.m6-gate-issuer-allowlist.v1",
    version: 1,
    keys: [
      {
        keyId: "operator-01",
        subject: "human:operator-01",
        publicKey: publicPem(first.publicKey),
        status: "active",
      },
      ...(multipleActive ? [{
        keyId: "operator-02",
        subject: "human:operator-02",
        publicKey: publicPem(second.publicKey),
        status: "active",
      }] : []),
    ],
  });
  const keyPath = join(operatorKeysRoot, "operator-01.pkcs8.pem");
  writeFileSync(keyPath, privatePem, { flag: "wx", mode: 0o600 });
  if (hardlinkKey) linkSync(keyPath, join(runtimeRoot, "linked-operator-key.pem"));
  const bootstrapBindingPath = join(configRoot, "m6-c1-qualification-bootstrap.v1.json");
  const writeBinding = (releaseId, sourceCommit, extraFields = {}) => {
    const releaseRoot = join(runtimeRoot, "releases", releaseId);
    mkdirSync(releaseRoot, { recursive: true });
    const manifestBytes = writeJson(join(releaseRoot, "release-manifest.v1.json"), {
      schemaId: "xw.runtime.release-manifest.v1",
      releaseId,
      sourceCommit,
      files: [],
      nodeVersion: "24.11.1",
    });
    const binding = {
      schemaId: "xw.runtime.m6-c1-qualification-bootstrap.v1",
      releaseId,
      sourceCommit,
      sourceReleaseRoot: releaseRoot,
      releaseManifestSha256: sha256(manifestBytes),
      gateId: `m6-${releaseId}`,
      gateIssuerAllowlistPath: issuerAllowlistPath,
      gateFArtifactInventoryPath: join(runtimeRoot, "qualification-bootstrap", "final-inventory-unavailable.json"),
      gateFArtifactInventoryHash: M64_QUALIFICATION_TCB_INVENTORY_SENTINEL_HASH,
      ...extraFields,
    };
    writeJson(bootstrapBindingPath, binding);
    return binding;
  };
  const binding = writeBinding("xw-legacy-fixture", "b".repeat(40));
  return {
    runtimeRoot,
    native,
    issuerAllowlistPath,
    keyPath,
    bootstrapBindingPath,
    binding,
    writeBinding,
  };
}

test("fixed TCB CLI has no caller-selected path, key, root, or identity surface", () => {
  assert.deepEqual(parseM64QualificationTcbProvisionFixedArgs([]), { provision: true });
  for (const argv of [
    ["--runtime-root", "C:\\attacker"],
    ["--key", "operator-02"],
    ["C:\\attacker\\key.pem"],
    [RELEASE_ID, SOURCE_COMMIT],
  ]) {
    assert.throws(() => parseM64QualificationTcbProvisionFixedArgs(argv), {
      code: "M64_QUALIFICATION_TCB_CLI_INVALID",
    });
  }
});

test("fixed provision output is release-bound and contains no secret value or private path", () => {
  const closure = Object.freeze({
    closureHash: "1".repeat(64),
    normalized: Object.freeze(["operatorPrivateKey"]),
  });
  const dependencies = {
    resolveRelease: () => ({ releaseId: RELEASE_ID, sourceCommit: SOURCE_COMMIT }),
    inspectClosure: () => closure,
    publishReceipt: () => ({
      replay: false,
      receipt: {
        releaseId: RELEASE_ID,
        sourceCommit: SOURCE_COMMIT,
        closureHash: closure.closureHash,
        receiptHash: "2".repeat(64),
      },
    }),
  };
  const result = provisionM64QualificationTcbFixed(dependencies);
  assert.equal(result.status, "VERIFIED");
  assert.equal(result.releaseId, RELEASE_ID);
  assert.equal(result.sourceCommit, SOURCE_COMMIT);
  assert.equal(result.normalizedTargetCount, 1);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE KEY|secret|keyBase64|operator-keys|[\\/]/u);
  let stdout = "";
  main([], { stdout: { write(value) { stdout += value; } }, dependencies });
  assert.deepEqual(JSON.parse(stdout), result);
});

test("real Windows ACL normalization seals only fixed child boundaries and preserves runtime-root SDDL", {
  skip: process.platform !== "win32",
}, (t) => {
  const f = windowsFixture(t);
  const rootSddlBefore = sddl(f.runtimeRoot);
  const protectPlans = [];
  const controller = {
    verify: (plan) => f.native.verify(plan),
    protect(plan) {
      protectPlans.push(structuredClone(plan));
      return f.native.protect(plan);
    },
  };
  const closure = inspectM64QualificationTcbClosure({
    runtimeRoot: f.runtimeRoot,
    allowNormalize: true,
  }, { tcbAclController: controller });
  assert.equal(closure.activeIssuerKeyId, "operator-01");
  assert.equal(closure.normalized.length, 3);
  assert.equal(sddl(f.runtimeRoot), rootSddlBefore);
  assert.equal(protectPlans.some((plan) => resolve(plan.boundaryPath) === resolve(f.runtimeRoot)), false);
  assert.deepEqual(new Set(protectPlans.map((plan) => resolve(plan.boundaryPath))), new Set([
    resolve(join(f.runtimeRoot, "m6-gate")),
    resolve(join(f.runtimeRoot, "secrets")),
    resolve(join(f.runtimeRoot, "config")),
  ]));

  const published = publishM64QualificationTcbReceipt({
    runtimeRoot: f.runtimeRoot,
    releaseId: RELEASE_ID,
    sourceCommit: SOURCE_COMMIT,
    closure,
  }, { tcbAclController: controller });
  assert.equal(published.replay, false);
  const verified = verifyM64QualificationTcbProvisionReceipt({
    runtimeRoot: f.runtimeRoot,
    releaseId: RELEASE_ID,
    sourceCommit: SOURCE_COMMIT,
  }, { tcbAclController: controller });
  assert.equal(verified.receiptHash, published.receipt.receiptHash);
  assert.equal(verified.closureHash, closure.closureHash);
  assert.equal(sddl(f.runtimeRoot), rootSddlBefore);

  f.writeBinding("xw-rotated-fixture", "e".repeat(40));
  assert.throws(() => verifyM64QualificationTcbProvisionReceipt({
    runtimeRoot: f.runtimeRoot,
    releaseId: RELEASE_ID,
    sourceCommit: SOURCE_COMMIT,
  }, { tcbAclController: controller }), {
    code: "M64_QUALIFICATION_TCB_RECEIPT_MISSING",
  });
  const rotatedClosure = inspectM64QualificationTcbClosure({
    runtimeRoot: f.runtimeRoot,
    allowNormalize: false,
  }, { tcbAclController: controller });
  assert.notEqual(rotatedClosure.bootstrapBindingSha256, closure.bootstrapBindingSha256);
  const rotatedReceipt = publishM64QualificationTcbReceipt({
    runtimeRoot: f.runtimeRoot,
    releaseId: RELEASE_ID,
    sourceCommit: SOURCE_COMMIT,
    closure: rotatedClosure,
  }, { tcbAclController: controller });
  assert.equal(verifyM64QualificationTcbProvisionReceipt({
    runtimeRoot: f.runtimeRoot,
    releaseId: RELEASE_ID,
    sourceCommit: SOURCE_COMMIT,
  }, { tcbAclController: controller }).receiptHash, rotatedReceipt.receipt.receiptHash);
});

test("real Windows closure rejects multiple active issuers and a hard-linked private key", {
  skip: process.platform !== "win32",
}, (t) => {
  const multiple = windowsFixture(t, { multipleActive: true });
  assert.throws(() => inspectM64QualificationTcbClosure({
    runtimeRoot: multiple.runtimeRoot,
    allowNormalize: true,
  }), { code: "M64_QUALIFICATION_TCB_ISSUER_INVALID" });

  const linked = windowsFixture(t, { hardlinkKey: true });
  assert.throws(() => inspectM64QualificationTcbClosure({
    runtimeRoot: linked.runtimeRoot,
    allowNormalize: true,
  }), { code: "SYSTEM_TCB_ACL_STRUCTURE_INVALID" });
});

test("real Windows closure rejects non-exact bindings and manifest-hash rebound", {
  skip: process.platform !== "win32",
}, (t) => {
  const f = windowsFixture(t);
  f.writeBinding("xw-extra-field-fixture", "f".repeat(40), { extraAuthority: true });
  assert.throws(() => inspectM64QualificationTcbClosure({
    runtimeRoot: f.runtimeRoot,
    allowNormalize: true,
  }), { code: "M64_QUALIFICATION_TCB_BOOTSTRAP_INVALID" });

  const rebound = f.writeBinding("xw-manifest-rebound-fixture", "1".repeat(40));
  writeJson(join(rebound.sourceReleaseRoot, "release-manifest.v1.json"), {
    schemaId: "xw.runtime.release-manifest.v1",
    releaseId: rebound.releaseId,
    sourceCommit: rebound.sourceCommit,
    files: [{ path: "unexpected-after-binding.json" }],
    nodeVersion: "24.11.1",
  });
  assert.throws(() => inspectM64QualificationTcbClosure({
    runtimeRoot: f.runtimeRoot,
    allowNormalize: false,
  }), { code: "M64_QUALIFICATION_TCB_BOOTSTRAP_INVALID" });
});
