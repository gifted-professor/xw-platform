#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  qualifyDeepSeekLiveModel,
  writeLiveModelQualificationArtifacts,
} from "../../integrations/dsh-xw/src/live-model-qualification.mjs";

const USAGE = [
  "M6-4 sealed DeepSeek live-model qualification",
  "",
  "Preflight (default; never connects to the provider):",
  "  node tools/m6/m6-4-live-model-qualification.mjs --dependency-root ABS --runtime-dependency-qualification FILE --target-environment-attestation FILE",
  "",
  "Execute (the only network-enabled mode):",
  "  node tools/m6/m6-4-live-model-qualification.mjs --execute --dependency-root ABS --runtime-dependency-qualification FILE --target-environment-attestation FILE --out-root ABS",
  "",
  "Credential: only the inherited DEEPSEEK_API_KEY environment variable is accepted.",
].join("\n");

function cliError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function parse(argv) {
  const result = { execute: false };
  const valued = new Map([
    ["--dependency-root", "dependencyRoot"],
    ["--runtime-dependency-qualification", "runtimeQualificationPath"],
    ["--target-environment-attestation", "targetAttestationPath"],
    ["--out-root", "outputRoot"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--execute") {
      if (result.execute) throw cliError("M6_LIVE_MODEL_CLI_INVALID", "--execute was repeated");
      result.execute = true;
      continue;
    }
    if (token === "--help") return { help: true };
    const key = valued.get(token);
    if (!key || result[key] !== undefined || index + 1 >= argv.length || argv[index + 1].startsWith("--")) {
      throw cliError("M6_LIVE_MODEL_CLI_INVALID", "an argument was unknown, repeated, or missing its value");
    }
    result[key] = argv[index += 1];
  }
  for (const key of ["dependencyRoot", "runtimeQualificationPath", "targetAttestationPath"]) {
    if (!result[key] || !isAbsolute(result[key])) throw cliError("M6_LIVE_MODEL_CLI_INVALID", `${key} must be an absolute path`);
  }
  if (result.execute && (!result.outputRoot || !isAbsolute(result.outputRoot))) {
    throw cliError("M6_LIVE_MODEL_CLI_INVALID", "--execute requires an absolute --out-root");
  }
  if (!result.execute && result.outputRoot !== undefined) {
    throw cliError("M6_LIVE_MODEL_CLI_INVALID", "preflight does not write artifacts; --out-root requires --execute");
  }
  return result;
}

function readJson(path, label) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch {
    throw cliError("M6_LIVE_MODEL_CLI_INPUT_INVALID", `${label} is unavailable or malformed`);
  }
}

function exactCredentialEnvironment() {
  return process.env.DEEPSEEK_API_KEY === undefined ? {} : { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY };
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = parse(argv);
  if (parsed.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const runtimeDependencyQualification = readJson(parsed.runtimeQualificationPath, "runtime dependency qualification");
  const targetEnvironmentAttestation = readJson(parsed.targetAttestationPath, "target environment attestation");
  const result = await qualifyDeepSeekLiveModel({
    execute: parsed.execute,
    dependencyRoot: parsed.dependencyRoot,
    runtimeDependencyQualification,
    targetEnvironmentAttestation,
    environment: parsed.execute ? exactCredentialEnvironment() : {},
  });
  if (!parsed.execute) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const artifacts = writeLiveModelQualificationArtifacts({
    outputRoot: parsed.outputRoot,
    dependencyRoot: parsed.dependencyRoot,
    result,
  });
  process.stdout.write(`${JSON.stringify({
    status: result.status,
    networkAccessed: result.networkAccessed,
    profileHash: artifacts.profileHash,
    artifactRoot: artifacts.root,
    secretMaterialPresent: false,
  }, null, 2)}\n`);
}

const entry = process.argv[1] ? resolve(process.argv[1]) : null;
if (entry === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error?.code ?? "M6_LIVE_MODEL_QUALIFICATION_FAILED"}: ${error?.message ?? "qualification failed"}\n`);
    process.exitCode = 1;
  });
}
