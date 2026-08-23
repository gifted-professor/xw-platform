#!/usr/bin/env node

import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runM64TargetEnvironmentQualification } from "../../services/control-plane/apps/xiaowei/m6-target-environment-qualification-runtime.mjs";

const USAGE = [
  "M6-4 alias-01 target-environment qualification",
  "",
  "Preflight (default; never contacts the Control Plane or device):",
  "  node tools/m6/m6-4-target-environment-qualification.mjs --account-isolation-binding-hash SHA256",
  "",
  "Execute (CLOSED Gate-F proof + fixed read-only double sample):",
  "  node tools/m6/m6-4-target-environment-qualification.mjs --execute --account-isolation-binding-hash SHA256 --artifact-root ABS",
  "",
  "XW_M6_GATE_F_OPERATIONS_TOKEN is accepted only through the inherited environment.",
].join("\n");

function cliError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function parseM64TargetEnvironmentQualificationArgs(argv, { env = process.env } = {}) {
  const parsed = {
    execute: false,
    artifactRoot: env.XW_M6_ENVIRONMENT_ARTIFACT_ROOT ?? null,
    accountIsolationBindingHash: env.XW_M6_ACCOUNT_ISOLATION_BINDING_HASH ?? null,
    controlPlaneUrl: env.CONTROL_PLANE_URL ?? "http://127.0.0.1:17920/",
    controlTokenEnv: "XW_M6_GATE_F_OPERATIONS_TOKEN",
  };
  const seen = new Set();
  const valued = new Map([
    ["--artifact-root", "artifactRoot"],
    ["--account-isolation-binding-hash", "accountIsolationBindingHash"],
    ["--control-plane-url", "controlPlaneUrl"],
    ["--control-token-env", "controlTokenEnv"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help") return Object.freeze({ help: true });
    if (token === "--execute") {
      if (parsed.execute) throw cliError("M6_ENV_CLI_INVALID", "--execute was repeated");
      parsed.execute = true;
      continue;
    }
    const key = valued.get(token);
    const value = argv[index + 1];
    if (!key || seen.has(key) || typeof value !== "string" || value.startsWith("--")) {
      throw cliError("M6_ENV_CLI_INVALID", "an argument was unknown, repeated, or missing its value");
    }
    seen.add(key);
    parsed[key] = value;
    index += 1;
  }
  if (parsed.artifactRoot !== null && (typeof parsed.artifactRoot !== "string" || !isAbsolute(parsed.artifactRoot))) {
    throw cliError("M6_ENV_CLI_INVALID", "runtime artifact root must be absolute");
  }
  if (parsed.execute && !parsed.artifactRoot) {
    throw cliError("M6_ENV_CLI_INVALID", "--execute requires an explicit absolute runtime artifact root");
  }
  if (!/^[0-9a-f]{64}$/u.test(parsed.accountIsolationBindingHash ?? "")) {
    throw cliError("M6_ENV_CLI_INVALID", "account-isolation binding must be an opaque SHA-256 hash");
  }
  if (!/^[A-Z][A-Z0-9_]{2,95}$/u.test(parsed.controlTokenEnv ?? "")) {
    throw cliError("M6_ENV_CLI_INVALID", "control-token environment variable name is invalid");
  }
  return Object.freeze(parsed);
}

export async function main(argv = process.argv.slice(2), {
  env = process.env,
  fetchImpl = globalThis.fetch,
  jobClient,
  artifactWriter,
  now,
  stdout = process.stdout,
} = {}) {
  const parsed = parseM64TargetEnvironmentQualificationArgs(argv, { env });
  if (parsed.help) {
    stdout.write(`${USAGE}\n`);
    return null;
  }
  const output = await runM64TargetEnvironmentQualification({
    execute: parsed.execute,
    artifactRoot: parsed.artifactRoot,
    accountIsolationBindingHash: parsed.accountIsolationBindingHash,
    controlPlaneUrl: parsed.controlPlaneUrl,
    controlToken: env[parsed.controlTokenEnv],
    fetchImpl,
    ...(jobClient ? { jobClient } : {}),
    ...(artifactWriter ? { artifactWriter } : {}),
    ...(now ? { now } : {}),
  });
  stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  return output;
}

const entry = process.argv[1] ? resolve(process.argv[1]) : null;
if (entry === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error?.code ?? "M6_ENV_QUALIFICATION_FAILED"}: target environment qualification failed\n`);
    process.exitCode = 1;
  });
}
