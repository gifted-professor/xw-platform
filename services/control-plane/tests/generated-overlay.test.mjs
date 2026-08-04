import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { canonicalJson } from "../control-plane/lib/canonical.mjs";
import {
  loadGeneratedOverlay,
  filterOverlayRecipes,
  hashOverlayBody,
  validateOverlayDocument,
  OVERLAY_SCHEMA_ID,
} from "../control-plane/lib/generated-overlay.mjs";

function sampleRecipes() {
  return [
    {
      recipeId: "recipe.douyin.observe.snapshot",
      revision: 1,
      status: "canary_only",
      executor: { capabilityId: "douyin.observe.snapshot", paramsTemplate: {} },
      riskCeiling: "R0",
      eligibleAliases: ["01"],
      descriptorHash: "a".repeat(64),
    },
    {
      recipeId: "recipe.douyin.observe.search",
      revision: 2,
      status: "implemented",
      executor: { capabilityId: "douyin.observe.search", paramsTemplate: { q: "{{q}}" } },
      riskCeiling: "R0",
      descriptorHash: "b".repeat(64),
    },
  ];
}

function buildDoc(overrides = {}) {
  const body = {
    schemaId: OVERLAY_SCHEMA_ID,
    schemaVersion: 1,
    generatedAt: "2026-08-04T16:00:00.000Z",
    recipes: sampleRecipes(),
    ...overrides,
  };
  const { sha256: _omit, ...rest } = body;
  const sha256 = createHash("sha256").update(canonicalJson(rest)).digest("hex");
  return { ...rest, sha256 };
}

function writeTempOverlay(doc) {
  const dir = mkdtempSync(join(tmpdir(), "generated-overlay-"));
  const path = join(dir, "recipe-catalog.json");
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  return { dir, path };
}

test("validateOverlayDocument accepts well-formed overlay", () => {
  const doc = buildDoc();
  const v = validateOverlayDocument(doc);
  assert.equal(v.ok, true);
  assert.equal(hashOverlayBody(doc), doc.sha256);
});

test("off mode returns empty without reading file", () => {
  const result = loadGeneratedOverlay({
    path: "C:\\definitely\\missing\\overlay.json",
    featureFlag: "off",
  });
  assert.equal(result.ok, true);
  assert.equal(result.mode, "off");
  assert.deepEqual(result.recipes, []);
  assert.equal(result.reason, "overlay_off");
});

test("SHA mismatch / tamper returns ok:false and empty recipes", () => {
  const doc = buildDoc();
  doc.recipes[0].riskCeiling = "R2"; // tamper without recomputing sha
  const { dir, path } = writeTempOverlay(doc);
  try {
    const result = loadGeneratedOverlay({ path, featureFlag: "shadow" });
    assert.equal(result.ok, false);
    assert.deepEqual(result.recipes, []);
    assert.equal(result.reason, "sha256_mismatch");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("expectedSha256 mismatch fails closed", () => {
  const doc = buildDoc();
  const { dir, path } = writeTempOverlay(doc);
  try {
    const result = loadGeneratedOverlay({
      path,
      featureFlag: "canary",
      expectedSha256: "0".repeat(64),
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "expected_sha256_mismatch");
    assert.deepEqual(result.recipes, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid schema returns ok:false", () => {
  const dir = mkdtempSync(join(tmpdir(), "generated-overlay-bad-"));
  const path = join(dir, "bad.json");
  writeFileSync(path, JSON.stringify({ schemaId: "nope", recipes: [] }), "utf8");
  try {
    const result = loadGeneratedOverlay({ path, featureFlag: "active" });
    assert.equal(result.ok, false);
    assert.match(result.reason, /schemaId_mismatch/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("valid overlay loads under shadow/canary/active", () => {
  const doc = buildDoc();
  const { dir, path } = writeTempOverlay(doc);
  try {
    const result = loadGeneratedOverlay({ path, featureFlag: "shadow" });
    assert.equal(result.ok, true);
    assert.equal(result.recipes.length, 2);
    assert.equal(result.sha256, doc.sha256);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("canary filter: only canary_only+implemented for alias 01", () => {
  const recipes = sampleRecipes();
  const on01 = filterOverlayRecipes(recipes, { mode: "canary", alias: "01" });
  assert.equal(on01.length, 2);

  const on02 = filterOverlayRecipes(recipes, { mode: "canary", alias: "02" });
  assert.equal(on02.length, 0);

  const defaultAlias = filterOverlayRecipes(recipes, { mode: "canary" });
  assert.equal(defaultAlias.length, 2);
});

test("active filter: implemented always; canary only if alias eligible", () => {
  const recipes = sampleRecipes();
  const a01 = filterOverlayRecipes(recipes, { mode: "active", alias: "01" });
  assert.equal(a01.length, 2);
  assert.ok(a01.some((r) => r.status === "canary_only"));

  const a02 = filterOverlayRecipes(recipes, { mode: "active", alias: "02" });
  assert.equal(a02.length, 1);
  assert.equal(a02[0].status, "implemented");
});

test("shadow filter marks shadowOnly", () => {
  const recipes = sampleRecipes();
  const shadowed = filterOverlayRecipes(recipes, { mode: "shadow", alias: "01" });
  assert.equal(shadowed.length, 2);
  assert.ok(shadowed.every((r) => r.shadowOnly === true));
});

test("Phase 5: overlay accepts primitive_steps executor; rejects unknown kind", () => {
  const okDoc = buildDoc({
    recipes: [
      {
        recipeId: "recipe.primitive.demo",
        revision: 1,
        status: "canary_only",
        executor: {
          kind: "primitive_steps",
          steps: [
            { id: "s1", kind: "screenshot", params: { label: "home" } },
            { id: "s2", kind: "back", params: {} },
          ],
        },
        riskCeiling: "R0",
        eligibleAliases: ["01"],
        descriptorHash: "c".repeat(64),
      },
    ],
  });
  assert.equal(validateOverlayDocument(okDoc).ok, true);

  const badDoc = buildDoc({
    recipes: [
      {
        recipeId: "recipe.bad",
        revision: 1,
        status: "canary_only",
        executor: {
          kind: "primitive_steps",
          steps: [{ id: "x", kind: "adbShell", params: {} }],
        },
        riskCeiling: "R0",
        descriptorHash: "d".repeat(64),
      },
    ],
  });
  const bad = validateOverlayDocument(badDoc);
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /executor_invalid/);
});
