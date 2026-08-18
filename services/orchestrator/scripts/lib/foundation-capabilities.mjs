import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_FOUNDATION_CATALOG = resolve(
  HERE,
  "../../contracts/foundation-capabilities.v1.json",
);

const STATUS = new Set(["implemented", "canary_only", "candidate", "disabled"]);
const ROLE = new Set(["locator", "transport", "checkpoint", "reducer", "safety"]);
const SCOPE = new Set(["cross_app", "app"]);
const ID_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)+$/;

function object(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function strings(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim());
}

export function validateFoundationCatalog(catalog) {
  const errors = [];
  const add = (path, message) => errors.push({ path, message });
  if (!object(catalog)) return [{ path: "$", message: "catalog must be an object" }];
  if (catalog.schemaId !== "xhs.foundation-capability-catalog.v1" || catalog.schemaVersion !== 1) {
    add("schema", "must be xhs.foundation-capability-catalog.v1 version 1");
  }
  if (!Array.isArray(catalog.capabilities)) {
    add("capabilities", "must be an array");
    return errors;
  }
  const ids = new Set();
  for (const [index, capability] of catalog.capabilities.entries()) {
    const path = `capabilities[${index}]`;
    if (!object(capability)) {
      add(path, "must be an object");
      continue;
    }
    if (!ID_RE.test(capability.id || "")) add(`${path}.id`, "has invalid format");
    if (ids.has(capability.id)) add(`${path}.id`, "must be unique");
    ids.add(capability.id);
    if (typeof capability.title !== "string" || !capability.title.trim()) add(`${path}.title`, "is required");
    if (typeof capability.description !== "string" || !capability.description.trim()) add(`${path}.description`, "is required");
    if (!ROLE.has(capability.role)) add(`${path}.role`, "is invalid");
    if (!SCOPE.has(capability.scope)) add(`${path}.scope`, "is invalid");
    if (!STATUS.has(capability.status)) add(`${path}.status`, "is invalid");
    if (!STATUS.has(capability.executionStatus)) add(`${path}.executionStatus`, "is invalid");
    for (const key of ["compatibleApps", "intentAliases", "provides", "requires", "trustOrder", "evidence", "limitations"]) {
      if (!strings(capability[key])) add(`${path}.${key}`, "must be a non-empty string array");
    }
    if (capability.effect !== "none") add(`${path}.effect`, "foundation capabilities must be effect=none");
    if (typeof capability.directRun !== "boolean") add(`${path}.directRun`, "must be boolean");
    if (typeof capability.entry !== "string" || !capability.entry.trim()) add(`${path}.entry`, "is required");
  }
  return errors;
}

export function loadFoundationCapabilities({ path = DEFAULT_FOUNDATION_CATALOG } = {}) {
  if (!existsSync(path)) throw new Error(`foundation capability catalog missing: ${path}`);
  const catalog = JSON.parse(readFileSync(path, "utf8"));
  const errors = validateFoundationCatalog(catalog);
  if (errors.length) throw new Error(`foundation capability catalog invalid: ${JSON.stringify(errors)}`);
  return catalog.capabilities.map((item) => structuredClone(item));
}

export function foundationMatchesApp(capability, appId) {
  if (!appId) return true;
  if (capability.scope !== "cross_app") return capability.compatibleApps.includes(appId);
  return capability.compatibleApps.includes("*") || capability.compatibleApps.includes(appId);
}

export function locatorPolicyFor({ appId = null, steps = [], capabilities = loadFoundationCapabilities() } = {}) {
  const needsLocator = steps.some((step) =>
    ["explore", "workflow", "recipe", "primitive_steps"].includes(String(step?.kind || "")),
  );
  if (!needsLocator) return null;
  const locator = capabilities.find((item) =>
    item.role === "locator" &&
    item.status === "implemented" &&
    foundationMatchesApp(item, appId),
  );
  if (!locator) {
    return {
      mode: "fail_closed",
      resolved: false,
      reason: appId ? `no implemented locator compatible with ${appId}` : "no implemented locator",
    };
  }
  return {
    mode: "semantic_then_visual",
    resolved: true,
    foundationCapabilityId: locator.id,
    executionStatus: locator.executionStatus,
    trustOrder: [...locator.trustOrder],
    coordinateRule: "vision_selects_block_id_only",
    rawCoordinateFallback: "forbidden_for_unknown_targets",
    activation: "when_semantic_bounds_missing_or_ambiguous",
    bundledDependency: true,
  };
}
