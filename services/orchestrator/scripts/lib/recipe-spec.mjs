/**
 * recipe-spec.mjs — seal a recipe spec as a hashed closeout artifact
 *
 * Used by evolve ingest. Closeout can attach the returned artifact later
 * as a hashed evidence item (kind: recipe_spec) without rewriting history.
 *
 * Zero deps beyond node:crypto + recipe-catalog canonicalize helpers.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { canonicalize, canonicalJson, descriptorHashOf } from "./recipe-catalog.mjs";

/**
 * Seal a recipe spec: attach descriptorHash, compute payload bytes + sha256.
 *
 * @param {object} spec
 * @param {{ path?: string }} [opts] optional artifact relative path override
 * @returns {{
 *   spec: object,
 *   descriptorHash: string,
 *   bytes: Buffer,
 *   artifact: { kind: "recipe_spec", path: string, sha256: string, bytes: number }
 * }}
 */
export function sealRecipeSpec(spec, { path } = {}) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    throw new Error("sealRecipeSpec: spec must be an object");
  }
  const descriptorHash = descriptorHashOf(spec);
  const sealed = { ...canonicalize(spec), descriptorHash };
  // Prefer stable recipeId/revision for default path.
  const recipeId = String(sealed.recipeId || "unknown").replace(/[^A-Za-z0-9._-]/g, "_");
  const revision = Number.isInteger(sealed.revision) ? sealed.revision : 1;
  const artifactPath =
    typeof path === "string" && path.trim()
      ? path.trim()
      : join("recipe-specs", `${recipeId}@${revision}.json`);

  const payload = Buffer.from(`${canonicalJson(sealed)}\n`, "utf8");
  const sha256 = createHash("sha256").update(payload).digest("hex");

  return {
    spec: sealed,
    descriptorHash,
    bytes: payload,
    artifact: {
      kind: "recipe_spec",
      path: artifactPath.replace(/\\/g, "/"),
      sha256,
      bytes: payload.length,
    },
  };
}
