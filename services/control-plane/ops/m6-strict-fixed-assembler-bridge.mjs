#!/usr/bin/env node

import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson, sha256 } from "../control-plane/lib/canonical.mjs";
import {
  buildM64FreshProductionAssemblerInput,
} from "../../../tools/m6/m6-4-production-assembler-input-builder.mjs";
import {
  CONTROL_PLANE_REQUIRED_PRIVATE_ENVIRONMENT,
} from "./control-plane-private-material.mjs";
import {
  M64_STRICT_FIXED_OPERATION_RECEIPT_SCHEMA_ID,
  M64_STRICT_FIXED_RUNTIME_ROOT,
  loadM64StrictFixedSecrets,
  resolveM64StrictFixedQualificationAuthority,
} from "./m6-strict-fixed-qualification-operator.mjs";

const HASH = /^(?!0{64}$)[0-9a-f]{64}$/u;
const RECEIPT_KEYS = Object.freeze([
  "actionCount", "authorityHash", "dependencyLayerHash", "environmentQualificationSha256",
  "modelProfileHash", "operationHash", "releaseId", "runtimeDependencyQualificationHash",
  "schemaId", "secretMaterialPresent", "sourceCommit", "status",
  "targetEnvironmentAttestationHash",
]);

function fail(code, message) {
  throw Object.assign(new Error(`${code}: ${message}`), { code });
}

function exactObject(value, keys) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort()));
}

function readReceipt(path) {
  let stat;
  try { stat = lstatSync(path); } catch { fail("M64_STRICT_FIXED_BRIDGE_RECEIPT_INVALID", "operation receipt is unavailable"); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 2 || stat.size > 64 * 1024) {
    fail("M64_STRICT_FIXED_BRIDGE_RECEIPT_INVALID", "operation receipt is not one bounded plain file");
  }
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { fail("M64_STRICT_FIXED_BRIDGE_RECEIPT_INVALID", "operation receipt is malformed"); }
}

export function parseM64StrictFixedAssemblerBridgeArgs(argv) {
  if (!Array.isArray(argv) || argv.length !== 0) {
    fail(
      "M64_STRICT_FIXED_BRIDGE_CLI_INVALID",
      "fixed assembler bridge accepts no paths, hashes, account bindings, options, or arguments",
    );
  }
  return Object.freeze({ execute: true });
}

export function loadM64StrictFixedOperationReceipt(authority) {
  const root = join(
    authority.runtimeRoot,
    "m6-audit",
    `m6-c1-strict-fixed-qualification-${authority.sourceShort}`,
    "receipts",
  );
  let names;
  try { names = readdirSync(root).filter((name) => /^[0-9a-f]{64}\.json$/u.test(name)); }
  catch { fail("M64_STRICT_FIXED_BRIDGE_RECEIPT_INVALID", "current release operation receipt store is unavailable"); }
  const matches = names.map((name) => ({ name, value: readReceipt(join(root, name)) }))
    .filter(({ value }) => value?.releaseId === authority.releaseId
      && value?.sourceCommit === authority.sourceCommit
      && value?.authorityHash === authority.identityHash);
  if (matches.length !== 1) {
    fail("M64_STRICT_FIXED_BRIDGE_RECEIPT_INVALID", "exactly one current-release qualification receipt is required");
  }
  const { name, value } = matches[0];
  const { operationHash: _ignored, ...body } = value;
  if (!exactObject(value, RECEIPT_KEYS)
    || value.schemaId !== M64_STRICT_FIXED_OPERATION_RECEIPT_SCHEMA_ID
    || value.status !== "QUALIFIED" || value.actionCount !== 0
    || value.secretMaterialPresent !== false
    || ![
      value.authorityHash,
      value.targetEnvironmentAttestationHash,
      value.environmentQualificationSha256,
      value.dependencyLayerHash,
      value.runtimeDependencyQualificationHash,
      value.modelProfileHash,
      value.operationHash,
    ].every((item) => HASH.test(item ?? ""))
    || value.operationHash !== sha256(`${value.schemaId}:${canonicalJson(body)}`)
    || basename(name) !== `${value.operationHash}.json`) {
    fail("M64_STRICT_FIXED_BRIDGE_RECEIPT_INVALID", "current release operation receipt hash or schema is invalid");
  }
  return Object.freeze(value);
}

function stableAuthority(before, after) {
  if (before.identityHash !== after.identityHash
    || before.releaseId !== after.releaseId || before.sourceCommit !== after.sourceCommit) {
    fail("M64_STRICT_FIXED_BRIDGE_RELEASE_DRIFT", "current release identity changed during assembler bridge execution");
  }
}

export function operateM64StrictFixedAssemblerBridge(dependencies = {}) {
  const deps = {
    resolveAuthority: resolveM64StrictFixedQualificationAuthority,
    loadReceipt: loadM64StrictFixedOperationReceipt,
    loadSecrets: loadM64StrictFixedSecrets,
    buildAssembler: buildM64FreshProductionAssemblerInput,
    ...dependencies,
  };
  const authority = deps.resolveAuthority({ runtimeRoot: M64_STRICT_FIXED_RUNTIME_ROOT });
  const receipt = deps.loadReceipt(authority);
  if (receipt.releaseId !== authority.releaseId || receipt.sourceCommit !== authority.sourceCommit
    || receipt.authorityHash !== authority.identityHash) {
    fail("M64_STRICT_FIXED_BRIDGE_RELEASE_DRIFT", "qualification receipt belongs to a different release");
  }
  const secret = deps.loadSecrets(authority);
  try {
    stableAuthority(authority, deps.resolveAuthority({ runtimeRoot: M64_STRICT_FIXED_RUNTIME_ROOT }));
    const output = deps.buildAssembler({
      execute: true,
      releaseId: authority.releaseId,
      sourceCommit: authority.sourceCommit,
      runtimeRoot: M64_STRICT_FIXED_RUNTIME_ROOT,
      targetEnvironmentAttestationHash: receipt.targetEnvironmentAttestationHash,
      environmentQualificationSha256: receipt.environmentQualificationSha256,
      dependencyLayerHash: receipt.dependencyLayerHash,
      modelProfileHash: receipt.modelProfileHash,
      accountIsolationBindingHash: secret.variables.XW_M6_ACCOUNT_ISOLATION_BINDING_HASH,
    });
    stableAuthority(authority, deps.resolveAuthority({ runtimeRoot: M64_STRICT_FIXED_RUNTIME_ROOT }));
    if (output?.mode !== "EXECUTE" || output.releaseId !== authority.releaseId
      || output.sourceCommit !== authority.sourceCommit
      || ![output.authorityHash, output.assemblerInputSha256, output.assemblerReceiptHash]
        .every((item) => HASH.test(item ?? ""))) {
      fail("M64_STRICT_FIXED_BRIDGE_ASSEMBLER_INVALID", "assembler result escaped the current release identity");
    }
    return Object.freeze({
      schemaId: "xw.m6-strict-fixed-assembler-bridge.v1",
      status: "ASSEMBLED",
      releaseId: authority.releaseId,
      sourceCommit: authority.sourceCommit,
      qualificationOperationHash: receipt.operationHash,
      assemblerAuthorityHash: output.authorityHash,
      assemblerInputSha256: output.assemblerInputSha256,
      assemblerReceiptHash: output.assemblerReceiptHash,
    });
  } finally {
    for (const name of CONTROL_PLANE_REQUIRED_PRIVATE_ENVIRONMENT) secret.variables[name] = null;
    secret.bytes.fill(0);
  }
}

export function main(argv = process.argv.slice(2), { stdout = process.stdout, dependencies = {} } = {}) {
  parseM64StrictFixedAssemblerBridgeArgs(argv);
  const result = operateM64StrictFixedAssemblerBridge(dependencies);
  stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

const entry = process.argv[1] ? resolve(process.argv[1]) : null;
if (entry === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    process.stderr.write(`${error?.code ?? "M64_STRICT_FIXED_BRIDGE_FAILED"}: strict-fixed assembler bridge failed\n`);
    process.exitCode = 1;
  }
}
