#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  materializeM6LiveRuntimeDependencyLayer,
  verifyM6LiveRuntimeDependencyLayer,
} from "../../integrations/dsh-xw/src/live-runtime-dependency-layer.mjs";

function usage(message) {
  if (message) process.stderr.write(`${message}\n`);
  process.stderr.write([
    "Usage:",
    "  node tools/m6/m6-4-runtime-dependency-layer.mjs materialize --release-root ABS --layers-root ABS [--qualification-out ABS]",
    "  node tools/m6/m6-4-runtime-dependency-layer.mjs verify --release-root ABS --layer-root ABS --layer-hash SHA256 [--qualification-out ABS]",
    "",
    "This command installs/verifies only the public, lockfile-pinned DSH runtime dependency layer.",
    "It does not read provider credentials, call provider health endpoints, qualify Gate F, deploy, or access a device.",
  ].join("\n"));
  process.exitCode = 2;
}

function parse(argv) {
  const [command, ...rest] = argv;
  const values = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) throw new Error(`invalid argument near ${key ?? "<end>"}`);
    if (Object.hasOwn(values, key)) throw new Error(`duplicate argument ${key}`);
    values[key] = value;
  }
  return { command, values };
}

function absolute(values, key, { required = true } = {}) {
  const value = values[key];
  if (value === undefined && !required) return null;
  if (typeof value !== "string" || !isAbsolute(value)) throw new Error(`${key} must be an absolute path`);
  return value;
}

function within(root, target) {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function emit(result, qualificationOut, immutableRoots) {
  if (qualificationOut) {
    if (immutableRoots.some((root) => within(root, qualificationOut))) {
      throw new Error("--qualification-out must remain outside immutable source and dependency layers");
    }
    writeFileSync(qualificationOut, `${JSON.stringify(result.qualification, null, 2)}\n`, { flag: "wx" });
  }
  process.stdout.write(`${JSON.stringify({
    schemaId: "xw.m6-live-runtime-dependency-command.v1",
    ok: true,
    layerRoot: result.layerRoot,
    layerHash: result.layerHash,
    reused: result.reused ?? null,
    sourceRelease: result.manifest.sourceRelease,
    packageLockSha256: result.manifest.lock.packageLockSha256,
    packageCount: result.manifest.lock.packageCount,
    packageProvenanceHash: result.manifest.lock.packageProvenanceHash,
    inventoryHash: result.manifest.inventoryHash,
    dependencyQualification: result.qualification,
    qualificationOut,
    providerHealthEvaluated: false,
    secretMaterialPresent: false,
    gateFEligible: false,
  }, null, 2)}\n`);
}

let parsed;
try {
  parsed = parse(process.argv.slice(2));
  const qualificationOut = absolute(parsed.values, "--qualification-out", { required: false });
  if (parsed.command === "materialize") {
    const allowed = new Set(["--release-root", "--layers-root", "--qualification-out"]);
    if (Object.keys(parsed.values).some((key) => !allowed.has(key))) throw new Error("materialize received an unknown argument");
    const releaseRoot = absolute(parsed.values, "--release-root");
    const result = materializeM6LiveRuntimeDependencyLayer({
      releaseRoot,
      layersRoot: absolute(parsed.values, "--layers-root"),
    });
    emit(result, qualificationOut, [releaseRoot, result.layerRoot]);
  } else if (parsed.command === "verify") {
    const allowed = new Set(["--release-root", "--layer-root", "--layer-hash", "--qualification-out"]);
    if (Object.keys(parsed.values).some((key) => !allowed.has(key))) throw new Error("verify received an unknown argument");
    const releaseRoot = absolute(parsed.values, "--release-root");
    const result = verifyM6LiveRuntimeDependencyLayer({
      sourceRoot: releaseRoot,
      layerRoot: absolute(parsed.values, "--layer-root"),
      expectedLayerHash: parsed.values["--layer-hash"],
    });
    emit(result, qualificationOut, [releaseRoot, result.layerRoot]);
  } else {
    usage("command must be materialize or verify");
  }
} catch (error) {
  if (process.exitCode !== 2) {
    process.stderr.write(`${error.code ?? "M6_LIVE_DEPENDENCY_COMMAND_FAILED"}: ${error.message}\n`);
    process.exitCode = 1;
  }
}
