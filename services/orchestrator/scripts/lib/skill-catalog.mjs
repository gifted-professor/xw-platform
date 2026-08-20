// M5 versioned Skill registry loader. This is the only production path from
// repository registrations to the pure Task Router / DAG Compiler catalog.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildSkillVersionRef,
  stableStringify,
  validateSkillSpec,
  validateSkillVersionRef,
} from "../../../../packages/kernel/lib/skill-runtime.mjs";

const EFFECT_CLASSES = new Set(["none", "reversible", "social", "publish", "payment", "delete"]);
const ROLES = new Set(["collect", "search", "validate"]);
const DEFAULT_MANIFEST = "services/orchestrator/contracts/m5-skill-catalog.v1.json";
const DEFAULT_CAPABILITIES = "services/control-plane/apps/xhs/capabilities.json";

function fail(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  throw error;
}

function assertExactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("SKILL_CATALOG_INVALID", `${label} must be an object`);
  const allowed = new Set(keys);
  const extras = Object.keys(value).filter((key) => !allowed.has(key));
  if (extras.length) fail("SKILL_CATALOG_INVALID", `${label} has unknown fields: ${extras.join(", ")}`);
}

function resolveInside(repoRoot, relativePath, label) {
  if (typeof relativePath !== "string" || !relativePath || path.isAbsolute(relativePath)) {
    fail("SKILL_CATALOG_PATH", `${label} must be a repository-relative path`);
  }
  const root = path.resolve(repoRoot);
  const resolved = path.resolve(root, relativePath);
  const rel = path.relative(root, resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) fail("SKILL_CATALOG_PATH", `${label} escapes the repository root`);
  return resolved;
}

function assertImmutableSource(repoRoot, ref) {
  let actual;
  try {
    actual = execFileSync("git", ["rev-parse", `${ref.sourceCommit}:${ref.sourcePath}`], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    fail("SKILL_CATALOG_SOURCE", `cannot resolve registered source ${ref.sourceCommit}:${ref.sourcePath}`, error?.stderr?.toString()?.trim());
  }
  if (actual !== ref.sourceBlobSha) {
    fail("SKILL_CATALOG_SOURCE", `source blob mismatch for ${ref.skillId}: expected ${ref.sourceBlobSha}, got ${actual}`);
  }
}

function assertVersionRef(spec, ref) {
  const result = validateSkillVersionRef(ref, { code: "SKILL_CATALOG_REF" });
  if (!result.ok) fail("SKILL_CATALOG_REF", `invalid SkillVersionRef for ${spec.skillId}`, result.errors);
  const expected = buildSkillVersionRef(spec);
  if (stableStringify(expected) !== stableStringify(ref)) {
    fail("SKILL_CATALOG_REF", `SkillVersionRef does not bind the registered SkillSpec for ${spec.skillId}`);
  }
}

function loadCapabilityMap(repoRoot, relativePath, suppliedDocument) {
  const document = suppliedDocument === undefined
    ? JSON.parse(readFileSync(resolveInside(repoRoot, relativePath, "capability contract"), "utf8"))
    : structuredClone(suppliedDocument);
  const list = Array.isArray(document) ? document : document.capabilities;
  if (!Array.isArray(list)) fail("SKILL_CATALOG_CAPABILITY", "capability contract must contain capabilities[]");
  return new Map(list.map((capability) => [capability.id, capability]));
}

function assertCapabilityRegistration(registration, capabilityMap) {
  const { skillSpec, executor, effectContract } = registration;
  const capability = capabilityMap.get(executor.capabilityId);
  if (!capability) fail("SKILL_CATALOG_CAPABILITY", `unknown capability ${executor.capabilityId}`);
  if (!skillSpec.requiredCapabilities?.includes(executor.capabilityId)) {
    fail("SKILL_CATALOG_CAPABILITY", `${skillSpec.skillId} does not require executor capability ${executor.capabilityId}`);
  }
  if (capability.availability !== "implemented" || capability.automationPolicy?.mode !== "automatic") {
    fail("SKILL_CATALOG_CAPABILITY", `${executor.capabilityId} is not implemented automatic capability`);
  }
  if (capability.effect?.class !== effectContract.class || effectContract.source !== "capability-contract") {
    fail("SKILL_CATALOG_EFFECT", `${skillSpec.skillId} effect does not match live capability contract`);
  }
}

async function assertLocalRegistration(repoRoot, registration) {
  const { skillSpec, executor, effectContract, localValidator, roles } = registration;
  if (!localValidator || !roles.includes("validate") || effectContract.class !== "none" || effectContract.source !== "local-validator") {
    fail("SKILL_CATALOG_LOCAL", `${skillSpec.skillId} local executor must be a read-only local validator`);
  }
  if (skillSpec.requiredCapabilities?.length) fail("SKILL_CATALOG_LOCAL", `${skillSpec.skillId} local validator cannot require a device capability`);
  if (executor.module !== skillSpec.sourcePath) fail("SKILL_CATALOG_LOCAL", `${skillSpec.skillId} executor module must equal SkillSpec sourcePath`);
  const modulePath = resolveInside(repoRoot, executor.module, "local executor module");
  const imported = await import(`${pathToFileURL(modulePath).href}?catalog=${skillSpec.skillId}`);
  if (typeof imported[executor.exportName] !== "function") {
    fail("SKILL_CATALOG_LOCAL", `${skillSpec.skillId} export ${executor.exportName} is not callable`);
  }
}

function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export async function loadM5SkillCatalog({
  repoRoot = path.resolve(import.meta.dirname, "../../../.."),
  manifestPath = DEFAULT_MANIFEST,
  capabilitiesPath = DEFAULT_CAPABILITIES,
  manifestDocument,
  capabilitiesDocument,
} = {}) {
  const manifest = manifestDocument === undefined
    ? JSON.parse(readFileSync(resolveInside(repoRoot, manifestPath, "skill catalog manifest"), "utf8"))
    : structuredClone(manifestDocument);
  assertExactKeys(manifest, ["schemaId", "schemaVersion", "catalogId", "registrations"], "catalog");
  if (manifest.schemaId !== "xw.orchestration.skill-catalog.v1" || manifest.schemaVersion !== 1) {
    fail("SKILL_CATALOG_INVALID", "catalog contract identity is invalid");
  }
  if (!Array.isArray(manifest.registrations) || manifest.registrations.length === 0) {
    fail("SKILL_CATALOG_INVALID", "catalog registrations must be a non-empty array");
  }

  const capabilityMap = loadCapabilityMap(repoRoot, capabilitiesPath, capabilitiesDocument);
  const seen = new Set();
  const catalog = [];
  for (const [index, registration] of manifest.registrations.entries()) {
    assertExactKeys(registration, ["skillSpec", "skillVersionRef", "roles", "localValidator", "executor", "effectContract"], `registration[${index}]`);
    const { skillSpec, skillVersionRef, roles, localValidator, executor, effectContract } = registration;
    const specResult = validateSkillSpec(skillSpec);
    if (!specResult.ok) fail("SKILL_CATALOG_SPEC", `invalid SkillSpec at registration[${index}]`, specResult.errors);
    if (seen.has(skillSpec.skillId)) fail("SKILL_CATALOG_DUPLICATE", `duplicate registered skillId ${skillSpec.skillId}`);
    seen.add(skillSpec.skillId);
    if (!Array.isArray(roles) || roles.length === 0 || new Set(roles).size !== roles.length || roles.some((role) => !ROLES.has(role))) {
      fail("SKILL_CATALOG_ROLE", `${skillSpec.skillId} has invalid roles`);
    }
    if (!effectContract || !EFFECT_CLASSES.has(effectContract.class)) fail("SKILL_CATALOG_EFFECT", `${skillSpec.skillId} has invalid effect contract`);
    assertVersionRef(skillSpec, skillVersionRef);
    assertImmutableSource(repoRoot, skillVersionRef);

    if (executor?.kind === "capability") assertCapabilityRegistration(registration, capabilityMap);
    else if (executor?.kind === "local") await assertLocalRegistration(repoRoot, registration);
    else fail("SKILL_CATALOG_EXECUTOR", `${skillSpec.skillId} has invalid executor`);

    catalog.push({
      skillId: skillSpec.skillId,
      roles: [...roles],
      effectClass: effectContract.class,
      localValidator: localValidator === true,
      executor: structuredClone(executor),
      skillVersionRef: structuredClone(skillVersionRef),
    });
  }
  return freeze(catalog);
}

export const M5_SKILL_CATALOG_MANIFEST = DEFAULT_MANIFEST;
