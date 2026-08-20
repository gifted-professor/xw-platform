import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { validateJsonSchema } from "../../control-plane/control-plane/lib/json-schema-validator.mjs";
import { compileDag } from "../scripts/lib/dag-compiler.mjs";
import { loadM5SkillCatalog } from "../scripts/lib/skill-catalog.mjs";
import { classifyTask } from "../scripts/lib/task-router.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const MANIFEST_PATH = path.join(ROOT, "services/orchestrator/contracts/m5-skill-catalog.v1.json");

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(ROOT, relativePath), "utf8"));
}

function catalogManifest() {
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
}

test("versioned M5 Skill registrations satisfy the canonical catalog contract", () => {
  const schema = readJson("packages/kernel/contracts/orchestration/skill-catalog.v1.schema.json");
  schema.$defs.skillSpec = readJson("packages/kernel/contracts/skill/skill-spec.v1.schema.json");
  schema.$defs.skillVersionRef = readJson("packages/kernel/contracts/skill/skill-version-ref.v1.schema.json");
  schema.$defs.registration.properties.skillSpec = { $ref: "#/$defs/skillSpec" };
  schema.$defs.registration.properties.skillVersionRef = { $ref: "#/$defs/skillVersionRef" };
  assert.deepEqual(validateJsonSchema(catalogManifest(), schema), []);
});

test("production loader verifies immutable source, capability effect, and local validator export", async () => {
  const catalog = await loadM5SkillCatalog({ repoRoot: ROOT });
  assert.deepEqual(catalog.map(({ skillId }) => skillId), ["xhs.observe.feed", "xw.validate.card-count"]);
  assert.equal(catalog[0].executor.capabilityId, "xhs.observe.feed");
  assert.equal(catalog[0].effectClass, "none");
  assert.equal(catalog[1].localValidator, true);
  assert.ok(Object.isFrozen(catalog));
  assert.ok(Object.isFrozen(catalog[0].skillVersionRef));
  assert.equal(catalog.some(({ skillId }) => skillId === "wechat.observe.balance"), false);
});

test("the real catalog compiles the task-brief four-device goal without invented skills", async () => {
  const catalog = await loadM5SkillCatalog({ repoRoot: ROOT });
  const classification = classifyTask({ goal: "四台机器各刷一次首页并汇总卡片数", catalog, devices: 4 });
  const dag = compileDag({ classification, catalog, aliases: ["01", "02", "03", "04"], traceId: "trace-real-catalog" });
  assert.equal(dag.nodes.filter((node) => node.skillId === "xhs.observe.feed").length, 4);
  assert.equal(dag.nodes.at(-1).skillId, "xw.validate.card-count");
  assert.equal(dag.executionReady, true);
});

test("a registration cannot forge an effect class that disagrees with the capability contract", async () => {
  const manifest = catalogManifest();
  manifest.registrations[0].effectContract.class = "publish";
  await assert.rejects(() => loadM5SkillCatalog({ repoRoot: ROOT, manifestDocument: manifest }), { code: "SKILL_CATALOG_EFFECT" });
});

test("a registration cannot point its immutable ref at a different source blob", async () => {
  const manifest = catalogManifest();
  const forged = "a".repeat(40);
  manifest.registrations[0].skillSpec.sourceBlobSha = forged;
  manifest.registrations[0].skillVersionRef.sourceBlobSha = forged;
  const { buildSkillVersionRef } = await import("../../../packages/kernel/lib/skill-runtime.mjs");
  manifest.registrations[0].skillVersionRef.skillSpecSha256 = buildSkillVersionRef(manifest.registrations[0].skillSpec).skillSpecSha256;
  await assert.rejects(() => loadM5SkillCatalog({ repoRoot: ROOT, manifestDocument: manifest }), { code: "SKILL_CATALOG_SOURCE" });
});
