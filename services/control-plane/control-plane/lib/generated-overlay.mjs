/**
 * generated-overlay.mjs — runtime recipe catalog overlay (Phase 4)
 *
 * Loads a sealed JSON overlay written by xhs-registry evolve evaluate.
 * Feature flag XHS_RECIPE_OVERLAY_MODE = off|shadow|canary|active (default off).
 * On SHA mismatch / invalid schema: return { ok:false, recipes:[], reason };
 * caller keeps previous / static capability catalog. Never mutates Git manifests.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import { canonicalize, canonicalJson } from "./canonical.mjs";
import { resolveRecipeExecutor } from "./recipe-interpreter.mjs";

export const DEFAULT_OVERLAY_PATH =
  "C:\\Users\\Public\\xhs-agent-control\\generated-overlay\\recipe-catalog.json";

export const OVERLAY_SCHEMA_ID = "xhs.recipe-overlay.v1";
export const OVERLAY_SCHEMA_VERSION = 1;
export const OVERLAY_MODES = Object.freeze(["off", "shadow", "canary", "active"]);
export const DEFAULT_CANARY_ALIAS = "01";

export function resolveOverlayMode(env = process.env) {
  const raw = String(env.XHS_RECIPE_OVERLAY_MODE || "off").trim().toLowerCase();
  if (OVERLAY_MODES.includes(raw)) return raw;
  return "off";
}

function sha256Hex(value) {
  const input = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  return createHash("sha256").update(input).digest("hex");
}

export function hashOverlayBody(doc) {
  if (!doc || typeof doc !== "object") return null;
  const { sha256: _omit, ...rest } = doc;
  return sha256Hex(canonicalJson(rest));
}

function fail(reason, extra = {}) {
  return { ok: false, recipes: [], reason, ...extra };
}

/**
 * Light schema check for xhs.recipe-overlay.v1.
 * @returns {{ ok: true, doc } | { ok: false, reason }}
 */
export function validateOverlayDocument(doc) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return { ok: false, reason: "overlay_not_object" };
  }
  if (doc.schemaId !== OVERLAY_SCHEMA_ID) {
    return { ok: false, reason: `schemaId_mismatch:${doc.schemaId}` };
  }
  if (doc.schemaVersion !== OVERLAY_SCHEMA_VERSION) {
    return { ok: false, reason: `schemaVersion_mismatch:${doc.schemaVersion}` };
  }
  if (typeof doc.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(doc.sha256)) {
    return { ok: false, reason: "sha256_missing_or_invalid" };
  }
  if (!Array.isArray(doc.recipes)) {
    return { ok: false, reason: "recipes_not_array" };
  }
  for (let i = 0; i < doc.recipes.length; i++) {
    const r = doc.recipes[i];
    if (!r || typeof r !== "object") {
      return { ok: false, reason: `recipe_${i}_not_object` };
    }
    if (typeof r.recipeId !== "string" || !r.recipeId.trim()) {
      return { ok: false, reason: `recipe_${i}_recipeId` };
    }
    if (!Number.isInteger(r.revision) || r.revision < 1) {
      return { ok: false, reason: `recipe_${i}_revision` };
    }
    if (typeof r.status !== "string" || !r.status.trim()) {
      return { ok: false, reason: `recipe_${i}_status` };
    }
    if (r.executor == null || typeof r.executor !== "object") {
      return { ok: false, reason: `recipe_${i}_executor` };
    }
    // Phase 5: accept capability wrapper (default) or primitive_steps whitelist.
    try {
      resolveRecipeExecutor(r.executor);
    } catch (e) {
      return { ok: false, reason: `recipe_${i}_executor_invalid:${e?.message || e}` };
    }
    if (typeof r.riskCeiling !== "string" || !r.riskCeiling.trim()) {
      return { ok: false, reason: `recipe_${i}_riskCeiling` };
    }
    if (typeof r.descriptorHash !== "string" || !/^[0-9a-f]{64}$/i.test(r.descriptorHash)) {
      return { ok: false, reason: `recipe_${i}_descriptorHash` };
    }
    if (r.eligibleAliases != null && !Array.isArray(r.eligibleAliases)) {
      return { ok: false, reason: `recipe_${i}_eligibleAliases` };
    }
  }
  return { ok: true, doc };
}

/**
 * Load overlay from disk. Does not throw on missing/invalid — returns ok:false.
 *
 * @param {{ path?: string, expectedSha256?: string|null, featureFlag?: string }} [opts]
 */
export function loadGeneratedOverlay({
  path = DEFAULT_OVERLAY_PATH,
  expectedSha256 = null,
  featureFlag,
} = {}) {
  const mode = featureFlag != null ? String(featureFlag).trim().toLowerCase() : resolveOverlayMode();
  if (!OVERLAY_MODES.includes(mode)) {
    return fail(`unknown_mode:${mode}`, { mode: "off", path });
  }
  if (mode === "off") {
    return { ok: true, mode: "off", recipes: [], reason: "overlay_off", path };
  }

  if (!existsSync(path)) {
    return fail("overlay_missing", { mode, path });
  }

  let raw;
  let doc;
  try {
    raw = readFileSync(path);
    doc = JSON.parse(raw.toString("utf8"));
  } catch (e) {
    return fail(`overlay_read_fail:${e?.message || e}`, { mode, path });
  }

  const validated = validateOverlayDocument(doc);
  if (!validated.ok) {
    return fail(validated.reason, { mode, path });
  }

  const computed = hashOverlayBody(doc);
  if (!computed || computed.toLowerCase() !== String(doc.sha256).toLowerCase()) {
    return fail("sha256_mismatch", {
      mode,
      path,
      expected: doc.sha256,
      computed,
    });
  }

  if (expectedSha256 != null && String(expectedSha256).trim() !== "") {
    if (String(expectedSha256).toLowerCase() !== String(doc.sha256).toLowerCase()) {
      return fail("expected_sha256_mismatch", {
        mode,
        path,
        expected: expectedSha256,
        actual: doc.sha256,
      });
    }
  }

  return {
    ok: true,
    mode,
    path,
    sha256: doc.sha256,
    generatedAt: doc.generatedAt ?? null,
    recipes: doc.recipes.map((r) => canonicalize(r)),
    reason: null,
  };
}

/**
 * Filter overlay recipes for the active feature mode.
 *
 * - canary: only canary_only + implemented, and only for alias 01 by default
 * - active: implemented always; canary_only only if alias ∈ eligibleAliases
 * - shadow: return recipes marked shadowOnly (caller must not execute)
 * - off: empty
 *
 * @param {object[]} recipes
 * @param {{ mode?: string, alias?: string|null, canaryAlias?: string }} [opts]
 */
export function filterOverlayRecipes(recipes, { mode = "off", alias = null, canaryAlias = DEFAULT_CANARY_ALIAS } = {}) {
  const m = String(mode || "off").trim().toLowerCase();
  const list = Array.isArray(recipes) ? recipes : [];
  if (m === "off" || list.length === 0) return [];

  if (m === "shadow") {
    return list.map((r) => ({ ...r, shadowOnly: true }));
  }

  if (m === "canary") {
    const effectiveAlias = alias != null && String(alias).trim() !== "" ? String(alias) : canaryAlias;
    if (effectiveAlias !== canaryAlias) return [];
    return list.filter((r) => r.status === "canary_only" || r.status === "implemented");
  }

  if (m === "active") {
    const a = alias != null ? String(alias) : null;
    return list.filter((r) => {
      if (r.status === "implemented") return true;
      if (r.status === "canary_only") {
        const eligible = Array.isArray(r.eligibleAliases)
          ? r.eligibleAliases.map(String)
          : [canaryAlias];
        if (a == null) return false;
        return eligible.includes(a);
      }
      return false;
    });
  }

  return [];
}
