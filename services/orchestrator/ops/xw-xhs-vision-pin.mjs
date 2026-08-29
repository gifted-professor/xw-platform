#!/usr/bin/env node
// xw-xhs-vision-pin.mjs — provision/verify the V3 exploration vision provider
// pin config (plan V3 §6 P4 item 1). The runtime config is content-addressed:
// provisioning hashes the ACTUAL python/script/model bytes into
// pin.{python,script,model}.sha256; every startup re-resolves the config and
// re-hashes those bytes (EXPLORATION_VISION_PIN_DRIFT fails closed).
//
//   provision: node ops/xw-xhs-vision-pin.mjs provision \
//                --mode canary1 --python <abs> --script <abs> --model <abs> [--config <abs>]
//   verify:    node ops/xw-xhs-vision-pin.mjs verify [--config <abs>]
//
// Provision never launches the provider and never touches a device; verify
// only re-hashes the pinned bytes against the sealed config.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  EXPLORATION_VISION_ROLES,
  EXPLORATION_VISION_CONFIG_SCHEMA_ID,
  resolvePinnedVisionConfig,
  hashFilePinned,
  visionError,
} from "../scripts/lib/xhs-exploration-vision.mjs";

const RUNTIME_ROOT = process.env.XW_RUNTIME_ROOT || "C:\\Users\\Public\\xw-runtime";
export const EXPLORATION_VISION_CONFIG_PATH = join(
  RUNTIME_ROOT,
  "state",
  "orchestrator",
  "xhs-exploration-vision-provider.v1.json",
);

const VISION_MODES = new Set(["shadow", "canary1"]);

function emit(result, command) {
  console.log(JSON.stringify({ ok: true, command, ...result }, null, 2));
}

function emitError(code, message, { command, details } = {}) {
  console.log(JSON.stringify({ ok: false, command: command ?? null, error: { code, message, details: details ?? {} } }, null, 2));
  process.exitCode = 2;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("-")) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function pinnedFile(raw, label) {
  const input = String(raw ?? "");
  if (!input || !isAbsolute(input)) {
    throw visionError("VISION_PIN_ARGS_INVALID", `--${label} must be an absolute path`, { status: 2 });
  }
  if (!existsSync(input)) {
    throw visionError("VISION_PIN_ARGS_INVALID", `--${label} file is absent: ${input}`, { status: 2 });
  }
  const p = resolve(input);
  return { path: p, sha256: hashFilePinned(p) };
}

export function buildPinnedVisionConfig({
  mode,
  python,
  script,
  model,
  maxBufferBytes = 8 * 1024 * 1024,
  timeoutMs = 8000,
}) {
  if (!VISION_MODES.has(mode)) {
    throw visionError("VISION_PIN_ARGS_INVALID", "--mode must be shadow or canary1 (off never runs a provider)", { status: 2 });
  }
  if (!Number.isInteger(maxBufferBytes) || maxBufferBytes <= 0 || maxBufferBytes > 16 * 1024 * 1024) {
    throw visionError("VISION_PIN_ARGS_INVALID", "maxBufferBytes must be within 1..16777216", { status: 2 });
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 8000) {
    throw visionError("VISION_PIN_ARGS_INVALID", "timeoutMs must be within 1..8000", { status: 2 });
  }
  const config = {
    schemaId: EXPLORATION_VISION_CONFIG_SCHEMA_ID,
    schemaVersion: 1,
    pin: {
      python: pinnedFile(python, "python"),
      script: pinnedFile(script, "script"),
      model: pinnedFile(model, "model"),
    },
    rules: {
      mode,
      roles: [...EXPLORATION_VISION_ROLES],
      targets: ["暂停"],
      allowEffectLabels: false,
      maxAnalysisAttemptsGlobal: 6,
    },
    analysis: {
      protocol: "xw.xhs.exploration-vision-process.v1",
      maxBufferBytes,
      timeoutMs,
    },
  };
  return config;
}

export function writePinnedVisionConfig(config, configPath) {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return configPath;
}

function runProvision(args) {
  const configPath = args.config ? resolve(args.config) : EXPLORATION_VISION_CONFIG_PATH;
  const config = buildPinnedVisionConfig({
    mode: String(args.mode ?? ""),
    python: args.python,
    script: args.script,
    model: args.model,
    ...(args["max-buffer-bytes"] ? { maxBufferBytes: Number(args["max-buffer-bytes"]) } : {}),
    ...(args["timeout-ms"] ? { timeoutMs: Number(args["timeout-ms"]) } : {}),
  });
  const written = writePinnedVisionConfig(config, configPath);
  emit({ configPath: written, mode: config.rules.mode, pin: config.pin }, "provision");
}

function runVerify(args) {
  const configPath = args.config ? resolve(args.config) : EXPLORATION_VISION_CONFIG_PATH;
  try {
    const view = resolvePinnedVisionConfig(configPath);
    emit({ configPath, identity: view }, "verify");
  } catch (error) {
    emitError(error?.code || "VISION_PIN_VERIFY_FAILED", error?.message || String(error), { command: "verify", details: error?.details ?? {} });
  }
}

export function cliMain(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  try {
    if (command === "provision") {
      runProvision(parseArgs(rest));
    } else if (command === "verify") {
      runVerify(parseArgs(rest));
    } else {
      emitError("VISION_PIN_COMMAND_UNKNOWN", `unknown command ${String(command ?? "<empty>")}; use provision|verify`, { command: String(command ?? "") });
    }
  } catch (error) {
    emitError(error?.code || "VISION_PIN_FAILED", error?.message || String(error), { command: command ?? null, details: error?.details ?? {} });
  }
  return process.exitCode === undefined ? 0 : process.exitCode;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  cliMain(process.argv.slice(2));
}
