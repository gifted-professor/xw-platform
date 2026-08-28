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
import { isAbsolute, join } from "node:path";

import { createRealVisionProvider } from "../scripts/lib/m6/real-vision-provider.mjs";
import { createRoutineVisionNavigator } from "../scripts/lib/xhs-routine-vision-navigator.mjs";

const RUNTIME_ROOT = process.env.XW_RUNTIME_ROOT || "C:\\Users\\Public\\xw-runtime";
export const VISION_PROVIDER_CONFIG_PATH = join(
  RUNTIME_ROOT,
  "state",
  "orchestrator",
  "xhs-routine-vision-provider.v1.json",
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