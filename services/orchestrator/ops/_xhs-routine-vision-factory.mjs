// _xhs-routine-vision-factory.mjs — production vision navigator factory for
// xw-xhs-routine (plan V2 §8.2). The provider is pinned by RUNTIME CONFIG
// (never CLI flags): <XW_RUNTIME_ROOT>/state/orchestrator/xhs-routine-vision-provider.v1.json
//   { "modelSha256": "<64-hex analyze.py model pin>",
//     "analyze": { "python": "<abs python>", "script": "<abs analyze.py>",
//                  "cwd": "<abs vgp dir>", "timeoutMs": 120000 } }
// Absent/invalid config fails closed — vision mode is unusable, not degraded.
//
// The analyze.py annotation loader is the same live path screenshot-and-analyze
// uses (--analyze): run analyze.py on the frame PNG, read the sibling
// .elements.json. The real provider wrapper normalizes annotations into m6
// blocks; this factory adapts them into the selectBlock shape the routine
// machine's r0NavigationTap ladder consumes.
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { isAbsolute, join, resolve } from "node:path";

import { createRealVisionProvider } from "../scripts/lib/m6/real-vision-provider.mjs";
import {
  EXPLORATION_VISION_DEADLINE_MS,
  createExplorationVisionNavigator,
  createLaneVisionQueue,
  resolvePinnedVisionConfig,
  visionError,
} from "../scripts/lib/xhs-exploration-vision.mjs";
import { createPinnedExplorationVisionAnalyzer } from "../scripts/lib/xhs-exploration-vision-process.mjs";
import { createRoutineVisionNavigator } from "../scripts/lib/xhs-routine-vision-navigator.mjs";

const RUNTIME_ROOT = process.env.XW_RUNTIME_ROOT || "C:\\Users\\Public\\xw-runtime";
export const VISION_PROVIDER_CONFIG_PATH = join(
  RUNTIME_ROOT,
  "state",
  "orchestrator",
  "xhs-routine-vision-provider.v1.json",
);

/** V3 production pin. Unlike the legacy V2 config above, this hashes the real
 * Python executable, analysis script, model bytes and normalized config. */
export const EXPLORATION_VISION_PROVIDER_CONFIG_PATH = join(
  RUNTIME_ROOT,
  "state",
  "orchestrator",
  "xhs-exploration-vision-provider.v1.json",
);

const EXPLORATION_VISION_STAGING_ROOT = join(
  RUNTIME_ROOT,
  "private",
  "orchestrator",
  "xhs-exploration-vision",
);

function providerConfigError(code, message) {
  return Object.assign(new Error(message), { code, status: 409 });
}

function readProviderConfig(configPath = VISION_PROVIDER_CONFIG_PATH) {
  if (!existsSync(configPath)) {
    throw providerConfigError(
      "ROUTINE_VISION_PROVIDER_CONFIG_MISSING",
      `vision provider pin config is absent: ${configPath}`,
    );
  }
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    throw providerConfigError("ROUTINE_VISION_PROVIDER_CONFIG_INVALID", `vision provider pin config is not valid JSON: ${error?.message || error}`);
  }
  if (!/^[0-9a-f]{64}$/.test(String(config?.modelSha256 || ""))) {
    throw providerConfigError("ROUTINE_VISION_PROVIDER_CONFIG_INVALID", "vision provider pin config needs a 64-hex modelSha256");
  }
  const analyze = config?.analyze;
  if (!analyze || !isAbsolute(String(analyze.python || "")) || !isAbsolute(String(analyze.script || ""))) {
    throw providerConfigError("ROUTINE_VISION_PROVIDER_CONFIG_INVALID", "vision provider pin config needs absolute analyze.python/script paths");
  }
  return config;
}

/**
 * analyze.py loader: runs the pinned model on the frame PNG and returns the
 * element annotations (label/bounds/conf). Any failure is "no annotation" —
 * the real provider then returns zero blocks and the ladder stops (no tap).
 */
function makeAnalyzeLoader(analyze) {
  const timeoutMs = Number(analyze.timeoutMs) > 0 ? Number(analyze.timeoutMs) : 120_000;
  return (frame) => {
    const outJson = String(frame.pngPath).replace(/\.png$/i, ".elements.json");
    execFileSync(String(analyze.python), [String(analyze.script), frame.pngPath, "-o", outJson], {
      cwd: analyze.cwd ? String(analyze.cwd) : undefined,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
    });
    if (!existsSync(outJson)) return [];
    const parsed = JSON.parse(readFileSync(outJson, "utf8"));
    return Array.isArray(parsed) ? parsed : Array.isArray(parsed?.elements) ? parsed.elements : [];
  };
}

/**
 * Adapt the m6 real provider (bounds inside an opaque evidence ref) into the
 * selectBlock block shape {label, bounds:{x,y,w,h}, confidence, capturedAt}.
 * A shim evidence store captures the geometry the provider deposits.
 */
export function adaptRealProviderToSelectBlocks(realProvider) {
  return {
    id: realProvider.id,
    version: realProvider.version,
    modelSha256: realProvider.modelSha256,
    segment(frame) {
      const geometry = new Map();
      // the provider derives blockId internally and calls evidence.bounds(
      // blockId, regionHash, geometry, signals); its return value becomes the
      // row's opaque boundsRef — so keying geometry by blockId and resolving
      // via boundsRef recovers the geometry without touching m6 internals.
      const evidence = {
        bounds: (blockId, _regionHash, geom) => {
          geometry.set(blockId, geom);
          return `${blockId}`;
        },
      };
      const raw = realProvider.segment(frame, evidence);
      const blocks = [];
      for (const row of raw) {
        const bounds = geometry.get(row.boundsRef) || null;
        if (!bounds || !Number.isFinite(bounds.x) || !Number.isFinite(bounds.y)
          || !Number.isFinite(bounds.w) || !Number.isFinite(bounds.h)) continue;
        blocks.push({
          label: row.label,
          bounds,
          confidence: Number(row.confidence) || 0,
          capturedAt: frame.capturedAt,
        });
      }
      return blocks;
    },
  };
}

/**
 * Build the production routine vision navigator for ONE run.
 * @param {object} input
 * @param {"shadow"|"canary"} input.mode - sealed by the runner (never fallback)
 * @param {object} input.driver - the CP routine driver (screenshot() capture)
 * @param {string} [input.configPath] - override for offline tests only
 */
export function createProductionRoutineVisionNavigator({
  mode,
  driver,
  configPath = VISION_PROVIDER_CONFIG_PATH,
} = {}) {
  if (!driver || typeof driver.screenshot !== "function") {
    throw providerConfigError("ROUTINE_VISION_CAPTURE_INVALID", "vision factory requires the owning run driver's screenshot()");
  }
  const config = readProviderConfig(configPath);
  const loader = makeAnalyzeLoader(config.analyze);
  const realProvider = createRealVisionProvider({
    loader,
    modelSha256: config.modelSha256,
    version: config.version || undefined,
  });
  const provider = adaptRealProviderToSelectBlocks(realProvider);
  return createRoutineVisionNavigator({
    mode,
    provider,
    captureFrame: () => driver.screenshot(),
    ledgerPath: config.ledgerPath
      || join(configPath, "..", "xhs-routine-vision-r0-ledger.jsonl"),
    live: true,
  });
}

function sameProviderIdentity(expected, actual) {
  if (!expected || !actual) return false;
  return ["pythonHash", "modelHash", "scriptHash", "configHash"]
    .every((key) => /^[0-9a-f]{64}$/.test(String(expected[key] || ""))
      && expected[key] === actual[key]);
}

/**
 * Build the V3 production exploration navigator for one bound lane.
 *
 * The config path is selected by `createExplorerRoutineRuntime`; production
 * callers never supply it per request. Tests may inject a temporary config at
 * runtime construction. Provider work is a private-byte-staged async child,
 * then serialized through the lane-bounded queue from the vision module.
 */
export function createProductionExplorationVisionNavigator({
  mode,
  alias,
  providerBinding,
  captureFrame,
  reserveAnalysisAttempt = null,
  settleAnalysisAttempt = null,
  journalAppend = null,
  signal = null,
  clock = { nowMs: () => Date.now() },
  configPath = EXPLORATION_VISION_PROVIDER_CONFIG_PATH,
  allowTestConfigOverride = false,
  analyzerFactory = createPinnedExplorationVisionAnalyzer,
  analyzerDeps = {},
  stagingRoot = EXPLORATION_VISION_STAGING_ROOT,
} = {}) {
  if (!["shadow", "canary1"].includes(mode)) {
    throw visionError("EXPLORATION_VISION_MODE_INVALID", "production exploration vision mode must be shadow or canary1");
  }
  if (!["03", "04"].includes(alias)) {
    throw visionError("EXPLORATION_VISION_ALIAS_INVALID", "exploration vision requires a bound alias 03 or 04");
  }
  if (mode === "canary1" && alias !== "03") {
    throw visionError("EXPLORATION_VISION_CANARY_ALIAS_FORBIDDEN", "the first visual canary is eligible only on alias 03");
  }
  if (typeof configPath !== "string" || !configPath) {
    throw visionError("EXPLORATION_VISION_CONFIG_MISSING", "exploration vision config path is required", { status: 400 });
  }
  if (!allowTestConfigOverride
    && resolve(configPath) !== resolve(EXPLORATION_VISION_PROVIDER_CONFIG_PATH)) {
    throw visionError(
      "EXPLORATION_VISION_CONFIG_OVERRIDE_FORBIDDEN",
      `production exploration vision config is fixed at ${EXPLORATION_VISION_PROVIDER_CONFIG_PATH}`,
      { status: 400 },
    );
  }
  if (typeof captureFrame !== "function") {
    throw visionError("EXPLORATION_VISION_CAPTURE_INVALID", "production exploration vision requires a session-bound capture function");
  }
  if (typeof reserveAnalysisAttempt !== "function" || typeof settleAnalysisAttempt !== "function") {
    throw visionError(
      "EXPLORATION_VISION_BUDGET_INVALID",
      "production exploration vision requires CP-owned analysis reserve/settle functions",
    );
  }
  const config = resolvePinnedVisionConfig(configPath);
  if (config.mode !== mode) {
    throw visionError(
      "EXPLORATION_VISION_MODE_DRIFT",
      `sealed mission mode ${mode} differs from pinned provider mode ${config.mode}`,
    );
  }
  if (!sameProviderIdentity(providerBinding, config.provider)) {
    throw visionError(
      "EXPLORATION_VISION_PROVIDER_DRIFT",
      "sealed mission provider identity differs from the re-hashed runtime provider",
    );
  }

  const analyzer = analyzerFactory(config, { stagingRoot, ...analyzerDeps });
  if (!analyzer || typeof analyzer.analyze !== "function") {
    throw visionError("EXPLORATION_VISION_WORK_INVALID", "pinned analyzer factory returned no analyze function");
  }
  const laneQueue = createLaneVisionQueue({ analyze: analyzer.analyze });
  const work = Object.freeze({
    run(request = {}) {
      const requestedDeadline = request.deadlineMs ?? config.analysis.timeoutMs;
      if (!Number.isInteger(requestedDeadline) || requestedDeadline <= 0
        || requestedDeadline > EXPLORATION_VISION_DEADLINE_MS) {
        throw visionError(
          "EXPLORATION_VISION_DEADLINE_INVALID",
          `provider deadline must be within 1..${EXPLORATION_VISION_DEADLINE_MS}ms`,
          { status: 400 },
        );
      }
      const requestSignal = request.signal && signal && request.signal !== signal
        ? AbortSignal.any([request.signal, signal])
        : (request.signal ?? signal);
      return laneQueue.run({
        ...request,
        deadlineMs: Math.min(requestedDeadline, config.analysis.timeoutMs),
        signal: requestSignal,
      });
    },
    stats: () => laneQueue.stats(),
  });
  const navigator = createExplorationVisionNavigator({
    mode,
    captureFrame,
    work,
    reserveAnalysisAttempt,
    settleAnalysisAttempt,
    journalAppend,
    providerIdentity: config.provider,
    clock,
  });
  return Object.freeze({
    ...navigator,
    providerIdentity: config.provider,
    queueStats: () => laneQueue.stats(),
    close: () => typeof analyzer.close === "function" ? analyzer.close() : undefined,
  });
}
