#!/usr/bin/env node

// Bounded expired-generation rotation.  Read-only preflight is the default;
// --execute is the sole mutation switch.  Package creation/signing remains a
// separate command and no private material is accepted here.
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { operateM64QualificationBootstrapRotation } from
  "./m6-4-qualification-bootstrap-operator.mjs";
import {
  deriveM64QualificationFixedAuditPaths,
  M64_QUALIFICATION_AUDIT_PREFIX,
  M64_QUALIFICATION_FORMAL_RUNTIME_ROOT,
} from "./m6-4-qualification-bootstrap-signing.mjs";

const RELEASE_ID = /^[a-z0-9][a-z0-9._-]{2,127}$/u;
const SOURCE_COMMIT = /^[0-9a-f]{40}$/u;
const PACKAGE_HASH = /^(?!0{64}$)[0-9a-f]{64}$/u;

export const M64_QUALIFICATION_FORMAL_SNAPSHOT_ROOT =
  "C:\\Users\\Public\\xw-runtime-snapshots";

function fail(message) {
  const error = new Error(message);
  error.code = "M64_QUALIFICATION_ROTATION_ARGUMENT_INVALID";
  throw error;
}

export function parseM64QualificationRotationArgs(argv) {
  const out = { execute: false };
  const names = new Map([
    ["--bootstrap-package", "bootstrapPackagePath"],
    ["--issuer-allowlist", "issuerAllowlistPath"],
    ["--release-root", "releaseRoot"],
    ["--runtime-root", "runtimeRoot"],
    ["--snapshot-root", "snapshotRoot"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--execute") {
      if (out.execute) fail("--execute may appear only once");
      out.execute = true;
      continue;
    }
    const key = names.get(arg);
    if (!key || out[key] !== undefined || index + 1 >= argv.length) {
      fail(`unknown, duplicate, or incomplete argument: ${arg}`);
    }
    out[key] = argv[++index];
  }
  if ([...names.values()].some((key) => out[key] === undefined)) {
    fail("all five fixed path arguments are required");
  }
  return Object.freeze(out);
}

export function parseM64QualificationRotationFixedArgs(argv) {
  if (!Array.isArray(argv) || argv.length !== 4
    || !["preflight-fixed", "execute-fixed"].includes(argv[0])
    || !RELEASE_ID.test(argv[1] ?? "") || !SOURCE_COMMIT.test(argv[2] ?? "")
    || !PACKAGE_HASH.test(argv[3] ?? "")
    || argv.some((value) => typeof value !== "string" || value.startsWith("--"))) {
    fail(
      "usage: preflight-fixed|execute-fixed <releaseId> <sourceCommit> <packageHash>; "
      + "paths, roots, inputs, tokens, and PIDs are forbidden",
    );
  }
  return Object.freeze({
    command: argv[0],
    releaseId: argv[1],
    sourceCommit: argv[2],
    packageHash: argv[3],
  });
}

export function deriveM64QualificationRotationFixedInput({
  releaseId,
  sourceCommit,
  packageHash,
} = {}, {
  runtimeRoot = M64_QUALIFICATION_FORMAL_RUNTIME_ROOT,
  snapshotBaseRoot = M64_QUALIFICATION_FORMAL_SNAPSHOT_ROOT,
} = {}) {
  const fixed = deriveM64QualificationFixedAuditPaths({
    releaseId,
    sourceCommit,
    packageHash,
    runtimeRoot,
  });
  return Object.freeze({
    bootstrapPackagePath: fixed.packagePath,
    issuerAllowlistPath: fixed.issuerAllowlistPath,
    releaseRoot: fixed.releaseRoot,
    runtimeRoot: fixed.runtimeRoot,
    snapshotRoot: join(
      resolve(snapshotBaseRoot),
      `${M64_QUALIFICATION_AUDIT_PREFIX}-${fixed.sourceShort}-${packageHash.slice(0, 16)}`,
    ),
  });
}

export async function operateM64QualificationBootstrapRotationFixed({
  releaseId,
  sourceCommit,
  packageHash,
} = {}, {
  execute = false,
  runtimeRoot = M64_QUALIFICATION_FORMAL_RUNTIME_ROOT,
  snapshotBaseRoot = M64_QUALIFICATION_FORMAL_SNAPSHOT_ROOT,
  now = Date.now,
  operator = operateM64QualificationBootstrapRotation,
  operatorDependencies = {},
} = {}) {
  if (typeof execute !== "boolean" || typeof now !== "function" || typeof operator !== "function") {
    fail("fixed rotation dependencies are invalid");
  }
  const input = deriveM64QualificationRotationFixedInput({
    releaseId,
    sourceCommit,
    packageHash,
  }, { runtimeRoot, snapshotBaseRoot });
  return operator(input, {
    execute,
    dependencies: Object.freeze({ ...operatorDependencies, now }),
  });
}

export async function main(argv = process.argv.slice(2), {
  stdout = process.stdout,
  stderr = process.stderr,
  fixedDependencies = {},
} = {}) {
  try {
    const parsed = parseM64QualificationRotationFixedArgs(argv);
    const result = await operateM64QualificationBootstrapRotationFixed(parsed, {
      ...fixedDependencies,
      execute: parsed.command === "execute-fixed",
    });
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    stderr.write(`${JSON.stringify({
      ok: false,
      code: error?.code ?? "M64_QUALIFICATION_ROTATION_FAILED",
      message: error?.message ?? String(error),
    })}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
