#!/usr/bin/env node
/**
 * xw-xhs-reseal-alias-overlay.mjs — rebind sealed XHS recipes to one alias and
 * merge them into that alias's per-CP overlay.
 *
 * The repo config/recipes specs are authored against the base device
 * (1080x2400, alias 04). Per-alias CPs each load their own overlay
 * (XHS_RECIPE_OVERLAY_PATH), whose recipes must be re-bound:
 *   - eligibleAliases = [alias]
 *   - deviceProfile.{alias,width,height}
 *   - every step's params.deviceBound.alias
 *   - coordinates scaled from the base screen to the target screen
 *   - status → canary_only (overlay execution gate)
 *   - descriptorHash recomputed (canonical-v2 over the full sealed spec)
 * then merged into the existing per-alias overlay (recipes not re-sealed here
 * are preserved) and the overlay sha256 recomputed.
 *
 * IMPORTANT: the CP loads the overlay once at bootstrap — restart the
 * per-alias control plane after resealing.
 *
 *   node ops/xw-xhs-reseal-alias-overlay.mjs --alias 05 [--root <dir>] [--screen 1220x2712]
 *
 * Console: console.log only (Windows bridge — no console.error).
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalDescriptorHash } from "../control-plane/lib/recipe-descriptor.mjs";
import { hashOverlayBody, validateOverlayDocument } from "../control-plane/lib/generated-overlay.mjs";

const REPO_RECIPES_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "config", "recipes");
const DEFAULT_ROOT = "C:\\Users\\Public\\xw-lab-cp\\per-alias";

/** Known lab fleet screens (alias → WxH). 04/07 = K50/K60E, 05/06 = K70E. */
const DEVICE_SCREENS = Object.freeze({
  "04": { width: 1080, height: 2400 },
  "05": { width: 1220, height: 2712 },
  "06": { width: 1220, height: 2712 },
  "07": { width: 1080, height: 2400 },
});

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--") && argv[i + 1] != null && !String(argv[i + 1]).startsWith("-")) {
      out[a.slice(2)] = argv[++i];
    } else if (a.startsWith("--")) {
      out[a.slice(2)] = true;
    } else {
      out._.push(a);
    }
  }
  return out;
}

function fail(message) {
  console.log(`✗ ${message}`);
  process.exit(4);
}

function scaleCoord(v, ratio) {
  return Math.round(Number(v) * ratio);
}

/** Re-seal one recipe spec for the target alias/screen. */
function rebindRecipe(spec, { alias, width, height, status }) {
  const base = spec.deviceProfile || {};
  const baseW = base.width || 1080;
  const baseH = base.height || 2400;
  const xr = width / baseW;
  const yr = height / baseH;

  const out = structuredClone(spec);
  out.eligibleAliases = [alias];
  out.deviceProfile = { ...base, alias, width, height };
  out.status = status;

  out.executor.steps = out.executor.steps.map((step) => {
    const s = structuredClone(step);
    const params = s.params || {};
    if (params.deviceBound && typeof params.deviceBound === "object") {
      params.deviceBound = { ...params.deviceBound, alias };
    }
    if (params.x != null) params.x = scaleCoord(params.x, xr);
    if (params.y != null) params.y = scaleCoord(params.y, yr);
    if (params.from && params.to) {
      params.from = {
        x: scaleCoord(params.from.x, xr),
        y: scaleCoord(params.from.y, yr),
      };
      params.to = {
        x: scaleCoord(params.to.x, xr),
        y: scaleCoord(params.to.y, yr),
      };
    }
    if (params.refocusX != null) params.refocusX = scaleCoord(params.refocusX, xr);
    if (params.refocusY != null) params.refocusY = scaleCoord(params.refocusY, yr);
    s.params = params;
    return s;
  });

  out.descriptorHash = canonicalDescriptorHash(out);
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const alias = String(args.alias || "").trim();
  if (!/^(0[1-7])$/.test(alias)) {
    fail("--alias must be one of 01..07");
  }
  const root = args.root ? String(args.root) : DEFAULT_ROOT;
  const status = args.status ? String(args.status) : "canary_only";

  let screen = DEVICE_SCREENS[alias] || null;
  if (typeof args.screen === "string" && /^\d+x\d+$/.test(args.screen)) {
    const [w, h] = args.screen.split("x").map(Number);
    screen = { width: w, height: h };
  }
  if (!screen) {
    fail(`no known screen for alias ${alias}; pass --screen <WxH>`);
  }

  const specs = [];
  if (args.recipe) {
    for (const raw of String(args.recipe).split(",")) {
      const name = raw.trim();
      if (!name) continue;
      const p = join(REPO_RECIPES_DIR, `${name}.json`);
      if (!existsSync(p)) fail(`recipe file not found: ${p}`);
      specs.push(JSON.parse(readFileSync(p, "utf8")));
    }
  } else {
    // Default: every sealed XHS fixed recipe in config/recipes (xhs.*.fixed@N.json).
    const files = readdirSync(REPO_RECIPES_DIR)
      .filter((f) => /^xhs\..*\.fixed@\d+\.json$/.test(f))
      .sort();
    if (files.length === 0) fail(`no xhs.*.fixed@N.json specs found in ${REPO_RECIPES_DIR}`);
    for (const f of files) specs.push(JSON.parse(readFileSync(join(REPO_RECIPES_DIR, f), "utf8")));
  }

  const resealed = specs.map((spec) => {
    const bound = rebindRecipe(spec, { alias, width: screen.width, height: screen.height, status });
    // Tamper check: the recomputed hash must round-trip.
    if (canonicalDescriptorHash(bound) !== bound.descriptorHash) {
      fail(`internal: descriptorHash round-trip failed for ${spec.recipeId}@${spec.revision}`);
    }
    return bound;
  });

  // Merge into the existing per-alias overlay (preserve recipes not re-sealed).
  const targetDir = join(String(root), alias);
  const targetPath = join(targetDir, "overlay.json");
  let existing = { schemaId: "xhs.recipe-overlay.v1", schemaVersion: 1, recipes: [] };
  if (existsSync(targetPath)) {
    try {
      const prev = JSON.parse(readFileSync(targetPath, "utf8"));
      if (prev && Array.isArray(prev.recipes)) existing = { ...prev, recipes: prev.recipes };
    } catch (e) {
      fail(`existing overlay unreadable (${targetPath}): ${e.message}`);
    }
  }
  const resealedKeys = new Set(resealed.map((r) => `${r.recipeId}@${r.revision}`));
  const carried = existing.recipes.filter(
    (r) => !resealedKeys.has(`${r.recipeId}@${r.revision}`),
  );

  const doc = {
    schemaId: "xhs.recipe-overlay.v1",
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    recipes: [...resealed, ...carried],
  };
  doc.sha256 = hashOverlayBody(doc);

  const check = validateOverlayDocument(doc);
  if (!check.ok) fail(`resealed overlay fails schema validation: ${check.reason}`);

  mkdirSync(targetDir, { recursive: true });
  if (existsSync(targetPath)) {
    copyFileSync(targetPath, `${targetPath}.bak`);
  }
  const tmpPath = `${targetPath}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(doc, null, 1)}\n`);
  renameSync(tmpPath, targetPath);

  console.log(
    JSON.stringify(
      {
        ok: true,
        alias,
        screen: `${screen.width}x${screen.height}`,
        overlayPath: targetPath,
        overlaySha256: doc.sha256,
        recipes: resealed.map((r) => ({
          recipeId: r.recipeId,
          revision: r.revision,
          status: r.status,
          descriptorHash: r.descriptorHash,
          eligibleAliases: r.eligibleAliases,
          deviceProfile: { alias: r.deviceProfile.alias, width: r.deviceProfile.width, height: r.deviceProfile.height },
        })),
        carriedFromPrevious: carried.map((r) => `${r.recipeId}@${r.revision}`),
        note: "restart the per-alias control plane to pick up the new overlay",
      },
      null,
      2,
    ),
  );
}

main();