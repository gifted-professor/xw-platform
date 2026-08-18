import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { descriptorHashOf, canonicalJson } from "../scripts/lib/recipe-catalog.mjs";
import { sealRecipeSpec } from "../scripts/lib/recipe-spec.mjs";

test("sealRecipeSpec returns hashed recipe_spec artifact", () => {
  const spec = {
    schemaId: "xhs.recipe-candidate.v1",
    recipeId: "recipe.douyin.observe.snapshot",
    revision: 1,
    executor: { capabilityId: "douyin.observe.snapshot", paramsTemplate: {} },
    riskCeiling: "R0",
  };
  const sealed = sealRecipeSpec(spec);
  assert.equal(sealed.descriptorHash, descriptorHashOf(spec));
  assert.equal(sealed.spec.descriptorHash, sealed.descriptorHash);
  assert.ok(Buffer.isBuffer(sealed.bytes));
  assert.equal(sealed.artifact.kind, "recipe_spec");
  assert.match(sealed.artifact.path, /recipe-specs\/recipe\.douyin\.observe\.snapshot@1\.json/);
  assert.equal(sealed.artifact.bytes, sealed.bytes.length);
  assert.equal(
    sealed.artifact.sha256,
    createHash("sha256").update(sealed.bytes).digest("hex"),
  );
  // Payload is canonical JSON + newline
  assert.equal(sealed.bytes.toString("utf8"), `${canonicalJson(sealed.spec)}\n`);
});
