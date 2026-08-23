#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  M6_GROUNDED_RUN_CAPABILITY_ID,
  M6_GROUNDED_RUN_TCB_MANIFEST_ID,
  M6_GROUNDED_RUN_TCB_MANIFEST_PATH,
  computeM6GroundedRunImplementationClosurePaths,
  verifyM6GroundedRunCapabilitySeal,
} from "../../services/control-plane/control-plane/lib/m6-grounded-run-capability-seal.mjs";
import {
  M6_GROUNDED_RUN_CAPABILITY_SELF_BINDING_CONTENT_HASH_PROFILE,
} from "../../services/control-plane/control-plane/lib/implementation-closure.mjs";
import { canonicalJson } from "../../services/control-plane/control-plane/lib/canonical.mjs";
import { createTcbManifest } from "../../services/control-plane/control-plane/lib/tcb-manifest.mjs";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CAPABILITIES_PATH = "services/control-plane/apps/xiaowei/capabilities.json";

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function parse(argv) {
  if (argv.length === 0) return Object.freeze({ mode: "preview" });
  if (argv.length === 1 && argv[0] === "--check") return Object.freeze({ mode: "check" });
  if (argv.length === 1 && argv[0] === "--write") return Object.freeze({ mode: "write" });
  fail("M6_TCB_FREEZE_CLI_INVALID", "usage: m6-4-freeze-grounded-tcb.mjs [--check|--write]");
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail("M6_TCB_FREEZE_INPUT_INVALID", `${label} is unavailable or malformed`);
  }
}

function capabilityFromDocument(document) {
  const capabilities = document?.capabilities;
  if (!Array.isArray(capabilities)) {
    fail("M6_TCB_FREEZE_CAPABILITY_INVALID", "Xiaowei capability document has no capabilities array");
  }
  const matches = capabilities.filter((entry) => entry?.id === M6_GROUNDED_RUN_CAPABILITY_ID);
  if (matches.length !== 1) {
    fail("M6_TCB_FREEZE_CAPABILITY_INVALID", "grounded-run capability must occur exactly once");
  }
  return matches[0];
}

function sameJson(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

export function computeM64GroundedTcbFreeze({ rootDir = REPOSITORY_ROOT } = {}) {
  const capabilitiesPath = resolve(rootDir, ...CAPABILITIES_PATH.split("/"));
  const manifestPath = resolve(rootDir, ...M6_GROUNDED_RUN_TCB_MANIFEST_PATH.split("/"));
  const capabilitiesText = readFileSync(capabilitiesPath, "utf8");
  const capabilities = readJson(capabilitiesPath, "Xiaowei capability document");
  const currentCapability = capabilityFromDocument(capabilities);
  const paths = computeM6GroundedRunImplementationClosurePaths({ rootDir });
  const manifest = createTcbManifest({
    manifestId: M6_GROUNDED_RUN_TCB_MANIFEST_ID,
    rootDir,
    paths,
    capabilityIds: [M6_GROUNDED_RUN_CAPABILITY_ID],
    contentHashProfile: M6_GROUNDED_RUN_CAPABILITY_SELF_BINDING_CONTENT_HASH_PROFILE,
  });
  const nextCapabilities = structuredClone(capabilities);
  const nextCapability = capabilityFromDocument(nextCapabilities);
  nextCapability.implementation.implementationClosureHash = manifest.implementationClosureHash;
  const priorHashToken = `"implementationClosureHash": "${currentCapability.implementation.implementationClosureHash}"`;
  const nextHashToken = `"implementationClosureHash": "${manifest.implementationClosureHash}"`;
  const occurrences = capabilitiesText.split(priorHashToken).length - 1;
  if (occurrences !== 1) {
    fail("M6_TCB_FREEZE_CAPABILITY_INVALID", "grounded-run capability closure hash token must occur exactly once");
  }
  const nextCapabilitiesText = capabilitiesText.replace(priorHashToken, nextHashToken);
  const currentManifest = readJson(manifestPath, "grounded-run TCB manifest");
  return Object.freeze({
    capabilitiesPath,
    manifestPath,
    manifest,
    capabilities: nextCapabilities,
    capabilitiesText: nextCapabilitiesText,
    capabilityChanged: !sameJson(capabilities, nextCapabilities),
    manifestChanged: !sameJson(currentManifest, manifest),
    priorImplementationClosureHash: currentCapability?.implementation?.implementationClosureHash ?? null,
    implementationClosureHash: manifest.implementationClosureHash,
    pathCount: paths.length,
  });
}

export function main(argv = process.argv.slice(2), { stdout = process.stdout } = {}) {
  const { mode } = parse(argv);
  const freeze = computeM64GroundedTcbFreeze();
  const changed = freeze.capabilityChanged || freeze.manifestChanged;
  if (mode === "write") {
    writeFileSync(freeze.manifestPath, `${JSON.stringify(freeze.manifest, null, 2)}\n`, "utf8");
    writeFileSync(freeze.capabilitiesPath, freeze.capabilitiesText, "utf8");
    const verified = verifyM6GroundedRunCapabilitySeal({
      capability: capabilityFromDocument(freeze.capabilities),
      rootDir: REPOSITORY_ROOT,
      manifestPath: freeze.manifestPath,
    });
    stdout.write(`${JSON.stringify({
      schemaId: "xw.m6-grounded-run-tcb-freeze.v1",
      mode,
      changed,
      verified: true,
      implementationClosureHash: verified.implementationClosureHash,
      pathCount: verified.pathCount,
    }, null, 2)}\n`);
    return verified;
  }
  const result = Object.freeze({
    schemaId: "xw.m6-grounded-run-tcb-freeze.v1",
    mode,
    changed,
    verified: !changed,
    priorImplementationClosureHash: freeze.priorImplementationClosureHash,
    implementationClosureHash: freeze.implementationClosureHash,
    pathCount: freeze.pathCount,
  });
  stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (mode === "check" && changed) {
    fail("M6_TCB_FREEZE_STALE", "grounded-run TCB manifest or capability seal is stale");
  }
  return result;
}

const entry = process.argv[1] ? resolve(process.argv[1]) : null;
if (entry === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error?.code ?? "M6_TCB_FREEZE_FAILED"}: ${error?.message ?? "TCB freeze failed"}\n`);
    process.exitCode = 1;
  }
}
