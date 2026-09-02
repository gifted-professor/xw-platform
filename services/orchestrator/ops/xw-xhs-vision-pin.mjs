#!/usr/bin/env node
// xw-xhs-vision-pin.mjs — fixed-release stage/pin/verify for the V3
// exploration vision provider (execution addendum V2 §3 P4A/P5).
//
// Production CLI contract (no options):
//   node ops/xw-xhs-vision-pin.mjs stage
//   node ops/xw-xhs-vision-pin.mjs pin       (provision is an alias)
//   node ops/xw-xhs-vision-pin.mjs verify
//
// The CLI never accepts caller-selected paths, rollout mode, data, output, or
// runtime root. `stage` verifies the canonical manifest already carried by
// this release; `pin` creates the one fixed runtime config; `verify` re-hashes
// that fixed config. Pure exported builders retain path injection for offline
// tests, but they cannot put rollout authority into provider configuration.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  EXPLORATION_VISION_ROLES,
  EXPLORATION_VISION_CONFIG_SCHEMA_ID,
  EXPLORATION_VISION_PROVIDER_ALLOWED_MODES,
  resolvePinnedVisionConfig,
  hashFilePinned,
  visionError,
} from "../scripts/lib/xhs-exploration-vision.mjs";
import {
  EXPLORATION_VISION_BUNDLE_LABELS,
  EXPLORATION_VISION_PROCESS_PROTOCOL,
  EXPLORATION_VISION_PYTHON_RUNTIME_PREFIX,
  readExplorationVisionProviderBundle,
  verifyPythonRuntimeClosure,
  verifyExplorationVisionProviderBundle,
} from "../scripts/lib/xhs-exploration-provider-bundle.mjs";
import {
  EXPLORATION_VISION_PRIVATE_PROVIDER_ROOT,
  privateProviderInputs,
  privateProviderRootForDigest,
  provisionPrivateProviderClosure,
  verifyPrivateProviderClosure,
} from "../scripts/lib/xhs-exploration-private-runtime.mjs";

const RUNTIME_ROOT = join("C:\\", "Users", "Public", "xw-runtime");
export const EXPLORATION_VISION_CONFIG_PATH = join(
  RUNTIME_ROOT,
  "state",
  "orchestrator",
  "xhs-exploration-vision-provider.v1.json",
);

export const EXPLORATION_VISION_RELEASE_PROVIDER_ROOT = resolve(fileURLToPath(new URL(
  "../providers/xhs-exploration-local-pause/",
  import.meta.url,
)));
export const EXPLORATION_VISION_RELEASE_MANIFEST_PATH = join(
  EXPLORATION_VISION_RELEASE_PROVIDER_ROOT,
  "provider-bundle.v1.json",
);
export const EXPLORATION_VISION_RELEASE_SCRIPT_PATH = join(
  EXPLORATION_VISION_RELEASE_PROVIDER_ROOT,
  "analyze.py",
);
export const EXPLORATION_VISION_RELEASE_MODEL_PATH = join(
  EXPLORATION_VISION_RELEASE_PROVIDER_ROOT,
  "pause-zone-model.v1.json",
);
export const EXPLORATION_VISION_FIXED_PROVIDER_BUNDLE_DIGEST =
  "d89214b50c500809cae5818c1338d43592e2f5396b81ea6655eeb097effc58af";

function emit(result, command) {
  console.log(JSON.stringify({ ok: true, command, ...result }, null, 2));
}

function emitError(code, message, { command, details } = {}) {
  console.log(JSON.stringify({ ok: false, command: command ?? null, error: { code, message, details: details ?? {} } }, null, 2));
  process.exitCode = 2;
}

function pinnedFile(raw, label) {
  const input = String(raw ?? "");
  if (!input || !isAbsolute(input)) {
    throw visionError("VISION_PIN_ARGS_INVALID", `${label} must be an absolute path`, { status: 2 });
  }
  if (!existsSync(input)) {
    throw visionError("VISION_PIN_ARGS_INVALID", `${label} file is absent: ${input}`, { status: 2 });
  }
  const path = resolve(input);
  return { path, sha256: hashFilePinned(path) };
}

/**
 * Pure deterministic selector used by the fixed discovery path and tests.
 * A path is never selected by name/PATH alone: exact manifest size and hash
 * must match, and the complete bundle verifier re-hashes it once more.
 */
export function selectPinnedInterpreterFromCandidates({
  expectedSha256,
  expectedSize,
  candidates,
  hashFile = hashFilePinned,
} = {}) {
  if (!/^[0-9a-f]{64}$/.test(String(expectedSha256 ?? ""))
    || !Number.isInteger(expectedSize) || expectedSize <= 0
    || !Array.isArray(candidates)) {
    throw visionError("VISION_PIN_INTERPRETER_DISCOVERY_INVALID", "interpreter discovery needs a manifest hash, size, and controlled candidates", { status: 2 });
  }
  const paths = [...new Set(candidates
    .filter((candidate) => typeof candidate === "string" && isAbsolute(candidate))
    .map((candidate) => resolve(candidate)))]
    .sort((left, right) => left.localeCompare(right));
  for (const path of paths) {
    try {
      const stat = statSync(path);
      if (!stat.isFile() || stat.size !== expectedSize) continue;
      if (hashFile(path) === expectedSha256) return path;
    } catch {
      // An unreadable/racing candidate is not a fallback; continue through the
      // same closed roots and fail if no exact manifest-bound interpreter exists.
    }
  }
  throw visionError(
    "VISION_PIN_INTERPRETER_NOT_FOUND",
    "no interpreter in the controlled discovery roots matches the provider manifest",
    { status: 2, details: { expectedSha256 } },
  );
}

function versionedPythonCandidates(root, executable) {
  if (!root || !isAbsolute(root) || !existsSync(root)) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^Python\d+$/.test(entry.name))
      .map((entry) => join(root, entry.name, executable));
  } catch {
    return [];
  }
}

/** Fixed/controlled roots only; PATH, command lookup, and caller args are absent. */
export function sourceInterpreterCandidates({
  platform = process.platform,
} = {}) {
  if (platform !== "win32") {
    return [
      join(EXPLORATION_VISION_RELEASE_PROVIDER_ROOT, "runtime", "python3"),
      "/usr/bin/python3",
      "/usr/local/bin/python3",
    ];
  }
  let userProfileCandidates = [];
  try {
    userProfileCandidates = readdirSync(join("C:\\", "Users"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => versionedPythonCandidates(
        join("C:\\", "Users", entry.name, "AppData", "Local", "Programs", "Python"),
        "python.exe",
      ));
  } catch {
    userProfileCandidates = [];
  }
  return [
    join(EXPLORATION_VISION_RELEASE_PROVIDER_ROOT, "runtime", "python.exe"),
    ...versionedPythonCandidates(join("C:\\", "Program Files"), "python.exe"),
    ...versionedPythonCandidates(join("C:\\", "Program Files (x86)"), "python.exe"),
    ...versionedPythonCandidates("C:\\", "python.exe"),
    ...userProfileCandidates,
  ];
}

export function discoverSourcePinnedInterpreter(manifest) {
  const descriptor = manifest?.files?.find((row) => row.role === "interpreter");
  if (!descriptor) {
    throw visionError("VISION_PIN_RELEASE_INVALID", "fixed provider manifest has no interpreter descriptor", { status: 2 });
  }
  return selectPinnedInterpreterFromCandidates({
    expectedSha256: descriptor.sha256,
    expectedSize: descriptor.size,
    candidates: sourceInterpreterCandidates(),
  });
}

function fixedDataFiles(manifest, python) {
  const runtimeRoot = dirname(python);
  return manifest.files
    .filter((row) => row.role === "data")
    .map((row) => {
      const runtimeRelative = row.logicalPath.startsWith(EXPLORATION_VISION_PYTHON_RUNTIME_PREFIX)
        ? row.logicalPath.slice(EXPLORATION_VISION_PYTHON_RUNTIME_PREFIX.length).split("/")
        : null;
      if (runtimeRelative?.[0] === "root") runtimeRelative.shift();
      return {
        logicalPath: row.logicalPath,
        path: runtimeRelative
          ? join(runtimeRoot, ...runtimeRelative)
          : join(EXPLORATION_VISION_RELEASE_PROVIDER_ROOT, ...row.logicalPath.split("/")),
      };
    });
}

/** Resolve and reproduce the exact provider closure carried by this release. */
export function resolveFixedReleaseProviderInputs() {
  const sealed = readExplorationVisionProviderBundle(EXPLORATION_VISION_RELEASE_MANIFEST_PATH);
  if (sealed.providerBundleDigest !== EXPLORATION_VISION_FIXED_PROVIDER_BUNDLE_DIGEST) {
    throw visionError(
      "VISION_PIN_RELEASE_DIGEST_DRIFT",
      "release provider manifest differs from the P4A bundle digest",
      { status: 2 },
    );
  }
  const python = discoverSourcePinnedInterpreter(sealed.manifest);
  const input = {
    manifestPath: EXPLORATION_VISION_RELEASE_MANIFEST_PATH,
    python,
    script: EXPLORATION_VISION_RELEASE_SCRIPT_PATH,
    model: EXPLORATION_VISION_RELEASE_MODEL_PATH,
    dataFiles: fixedDataFiles(sealed.manifest, python),
  };
  const closure = verifyExplorationVisionProviderBundle({
    manifestPath: input.manifestPath,
    python: input.python,
    script: input.script,
    model: input.model,
    dataFiles: input.dataFiles,
  });
  if (closure.providerBundleDigest !== EXPLORATION_VISION_FIXED_PROVIDER_BUNDLE_DIGEST) {
    throw visionError("VISION_PIN_RELEASE_DIGEST_DRIFT", "fixed release provider closure did not reproduce", { status: 2 });
  }
  verifyPythonRuntimeClosure({ python: input.python, dataFiles: input.dataFiles });
  return Object.freeze({ ...input, closure });
}

export function resolvePrivateReleaseProviderInputs({
  providerRoot = EXPLORATION_VISION_PRIVATE_PROVIDER_ROOT,
  verifyAcl = undefined,
} = {}) {
  const targetRoot = privateProviderRootForDigest(
    EXPLORATION_VISION_FIXED_PROVIDER_BUNDLE_DIGEST,
    { providerRoot },
  );
  const manifestPath = join(targetRoot, "provider-bundle.v1.json");
  const sealed = readExplorationVisionProviderBundle(manifestPath);
  if (sealed.providerBundleDigest !== EXPLORATION_VISION_FIXED_PROVIDER_BUNDLE_DIGEST) {
    throw visionError("VISION_PIN_PRIVATE_DIGEST_DRIFT", "private provider manifest differs from the P4A digest", { status: 2 });
  }
  const input = privateProviderInputs({ targetRoot, manifest: sealed.manifest });
  return verifyPrivateProviderClosure({
    inputs: input,
    providerBundleDigest: EXPLORATION_VISION_FIXED_PROVIDER_BUNDLE_DIGEST,
    targetRoot,
    ...(verifyAcl ? { verifyAcl } : {}),
  });
}

export function buildPinnedVisionConfig({
  mode = undefined,
  python,
  script,
  model,
  dataFiles = [],
  bundleManifest,
  maxBufferBytes = undefined,
  timeoutMs = undefined,
} = {}) {
  if (mode !== undefined) {
    throw visionError(
      "VISION_PIN_MODE_OVERRIDE_FORBIDDEN",
      "provider config is rollout-neutral; mode authority belongs to mission and E-Corpus/Control Plane",
      { status: 2 },
    );
  }
  const closure = verifyExplorationVisionProviderBundle({
    manifestPath: bundleManifest,
    python,
    script,
    model,
    dataFiles,
  });
  const bundleAnalysis = closure.manifest.configuration;
  if (maxBufferBytes !== undefined && maxBufferBytes !== bundleAnalysis.maxBufferBytes) {
    throw visionError("VISION_PIN_ARGS_INVALID", "maxBufferBytes differs from the staged provider bundle", { status: 2 });
  }
  if (timeoutMs !== undefined && timeoutMs !== bundleAnalysis.timeoutMs) {
    throw visionError("VISION_PIN_ARGS_INVALID", "timeoutMs differs from the staged provider bundle", { status: 2 });
  }
  return {
    schemaId: EXPLORATION_VISION_CONFIG_SCHEMA_ID,
    schemaVersion: 1,
    bundle: {
      manifest: {
        path: closure.path,
        sha256: closure.providerBundleDigest,
      },
      providerBundleDigest: closure.providerBundleDigest,
    },
    pin: {
      python: pinnedFile(python, "python"),
      script: pinnedFile(script, "script"),
      model: pinnedFile(model, "model"),
      data: closure.inputs.dataFiles.map((row) => ({
        logicalPath: row.logicalPath,
        ...pinnedFile(row.path, `data:${row.logicalPath}`),
      })),
    },
    rules: {
      allowedModes: [...EXPLORATION_VISION_PROVIDER_ALLOWED_MODES],
      roles: [...EXPLORATION_VISION_ROLES],
      // Offline provider capability does not expand the live navigator/CP role.
      targets: [...EXPLORATION_VISION_BUNDLE_LABELS],
      allowEffectLabels: false,
      maxAnalysisAttemptsGlobal: 6,
    },
    analysis: {
      protocol: EXPLORATION_VISION_PROCESS_PROTOCOL,
      maxBufferBytes: bundleAnalysis.maxBufferBytes,
      timeoutMs: bundleAnalysis.timeoutMs,
    },
  };
}

export function writePinnedVisionConfig(config, configPath, { createOnly = true } = {}) {
  if (typeof configPath !== "string" || !isAbsolute(configPath)) {
    throw visionError("VISION_PIN_ARGS_INVALID", "configPath must be absolute", { status: 2 });
  }
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    flag: createOnly ? "wx" : "w",
    mode: 0o600,
  });
  return configPath;
}

function assertNoCliOverrides(command, rest) {
  if (rest.length !== 0) {
    throw visionError(
      "VISION_PIN_OVERRIDES_FORBIDDEN",
      `${command} accepts no arguments; provider paths, rollout mode, output, and runtime root are fixed by the release`,
      { status: 2, details: { argumentCount: rest.length } },
    );
  }
}

function assertFixedResolvedConfig(view, fixed) {
  const expectedData = fixed.dataFiles.map((row) => ({ logicalPath: row.logicalPath, path: resolve(row.path) }));
  const actualData = view.pin.data.map((row) => ({ logicalPath: row.logicalPath, path: resolve(row.path) }));
  if (view.provider.providerBundleDigest !== EXPLORATION_VISION_FIXED_PROVIDER_BUNDLE_DIGEST
    || resolve(view.bundle.manifest.path) !== resolve(fixed.manifestPath)
    || resolve(view.pin.python.path) !== resolve(fixed.python)
    || resolve(view.pin.script.path) !== resolve(fixed.script)
    || resolve(view.pin.model.path) !== resolve(fixed.model)
    || JSON.stringify(actualData) !== JSON.stringify(expectedData)) {
    throw visionError("VISION_PIN_FIXED_PATH_DRIFT", "runtime provider config is not bound to this release's fixed closure", { status: 2 });
  }
}

function runStage() {
  const fixed = resolveFixedReleaseProviderInputs();
  emit({
    manifestPath: fixed.manifestPath,
    providerBundleDigest: fixed.closure.providerBundleDigest,
    pin: {
      python: pinnedFile(fixed.python, "python"),
      script: pinnedFile(fixed.script, "script"),
      model: pinnedFile(fixed.model, "model"),
      dataFileCount: fixed.dataFiles.length,
    },
  }, "stage");
}

function runPin() {
  const source = resolveFixedReleaseProviderInputs();
  const targetRoot = privateProviderRootForDigest(EXPLORATION_VISION_FIXED_PROVIDER_BUNDLE_DIGEST);
  const fixed = provisionPrivateProviderClosure({
    source,
    providerBundleDigest: EXPLORATION_VISION_FIXED_PROVIDER_BUNDLE_DIGEST,
    targetRoot,
  });
  const config = buildPinnedVisionConfig({
    python: fixed.python,
    script: fixed.script,
    model: fixed.model,
    dataFiles: fixed.dataFiles,
    bundleManifest: fixed.manifestPath,
  });
  const written = writePinnedVisionConfig(config, EXPLORATION_VISION_CONFIG_PATH, { createOnly: true });
  emit({
    configPath: written,
    allowedModes: config.rules.allowedModes,
    providerBundleDigest: config.bundle.providerBundleDigest,
    pin: {
      python: config.pin.python,
      script: config.pin.script,
      model: config.pin.model,
      dataFileCount: config.pin.data.length,
    },
  }, "pin");
}

function runVerify() {
  const fixed = resolvePrivateReleaseProviderInputs();
  const view = resolvePinnedVisionConfig(EXPLORATION_VISION_CONFIG_PATH);
  assertFixedResolvedConfig(view, fixed);
  emit({ configPath: EXPLORATION_VISION_CONFIG_PATH, identity: view }, "verify");
}

export function cliMain(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  try {
    if (!["stage", "pin", "provision", "verify"].includes(command)) {
      throw visionError(
        "VISION_PIN_COMMAND_UNKNOWN",
        `unknown command ${String(command ?? "<empty>")}; use stage|pin|verify`,
        { status: 2 },
      );
    }
    assertNoCliOverrides(command, rest);
    if (command === "stage") runStage();
    else if (command === "pin" || command === "provision") runPin();
    else runVerify();
  } catch (error) {
    emitError(error?.code || "VISION_PIN_FAILED", error?.message || String(error), { command: command ?? null, details: error?.details ?? {} });
  }
  return process.exitCode === undefined ? 0 : process.exitCode;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  cliMain(process.argv.slice(2));
}
