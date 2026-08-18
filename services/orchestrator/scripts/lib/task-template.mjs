import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { locatorPolicyFor } from "./foundation-capabilities.mjs";
import { inferTaskApp } from "./task-plan.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_TASK_TEMPLATE_DIR = resolve(HERE, "../../task-templates");
export const TASK_TEMPLATE_SCHEMA_ID = "xhs.task-template.v1";

const STATUSES = new Set(["draft", "implemented", "archived"]);
const PARAM_TYPES = new Set(["string", "integer", "boolean", "array"]);
const STEP_KINDS = new Set(["capability", "recipe", "workflow", "llm", "explore"]);
const EFFECT_KINDS = new Set(["none", "external_send", "external_write", "destructive", "payment"]);
const CONFIRMATIONS = new Set(["none", "once_per_run", "per_effect", "human_only"]);
const PROMPT_POLICIES = new Set(["always", "if_missing", "effect_summary"]);
const TEMPLATE_ID_RE = /^task\.[a-z0-9][a-z0-9._-]*$/;
const WORKFLOW_ID_RE = /^workflow\.[a-z0-9][a-z0-9._-]*$/;

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function taskTemplateHash(template) {
  const { descriptorHash: _omit, ...body } = template || {};
  return createHash("sha256").update(canonicalJson(body)).digest("hex");
}

function object(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function add(errors, path, message) {
  errors.push({ path, message });
}

function validateParamValue(value, spec) {
  if (spec.enum && !spec.enum.some((candidate) => canonicalJson(candidate) === canonicalJson(value))) {
    return `must be one of ${spec.enum.join(", ")}`;
  }
  if (spec.type === "string" && typeof value !== "string") return "must be a string";
  if (spec.type === "integer") {
    if (!Number.isInteger(value)) return "must be an integer";
    if (Number.isFinite(spec.minimum) && value < spec.minimum) return `must be >= ${spec.minimum}`;
    if (Number.isFinite(spec.maximum) && value > spec.maximum) return `must be <= ${spec.maximum}`;
  }
  if (spec.type === "boolean" && typeof value !== "boolean") return "must be a boolean";
  if (spec.type === "array") {
    if (!Array.isArray(value)) return "must be an array";
    if (Number.isInteger(spec.minItems) && value.length < spec.minItems) return `must contain at least ${spec.minItems} item(s)`;
    if (spec.items?.type === "string" && value.some((item) => !text(item))) return "must contain non-empty strings";
  }
  return null;
}

export function validateTaskTemplate(template) {
  const errors = [];
  if (!object(template)) return [{ path: "$", message: "template must be an object" }];
  if (template.schemaId !== TASK_TEMPLATE_SCHEMA_ID || template.schemaVersion !== 1) {
    add(errors, "schema", "must be xhs.task-template.v1 version 1");
  }
  if (!TEMPLATE_ID_RE.test(template.templateId || "")) add(errors, "templateId", "must match task.<lowercase-id>");
  if (!Number.isInteger(template.revision) || template.revision < 1) add(errors, "revision", "must be a positive integer");
  if (!text(template.name)) add(errors, "name", "is required");
  if (!STATUSES.has(template.status)) add(errors, "status", "must be draft, implemented, or archived");
  if (!text(template.description)) add(errors, "description", "is required");
  if (!Array.isArray(template.aliases) || template.aliases.some((alias) => !text(alias))) add(errors, "aliases", "must be a string array");
  if (template.fixedConstraints != null && !object(template.fixedConstraints)) {
    add(errors, "fixedConstraints", "must be an object when present");
  }

  const schema = template.parameterSchema;
  if (!object(schema) || schema.type !== "object" || !object(schema.properties) || !Array.isArray(schema.required)) {
    add(errors, "parameterSchema", "must contain object properties and required[]");
  } else {
    const keys = new Set(Object.keys(schema.properties));
    const requiredSeen = new Set();
    for (const key of schema.required) {
      if (!text(key) || !keys.has(key)) add(errors, `parameterSchema.required.${key}`, "must name a property");
      if (requiredSeen.has(key)) add(errors, `parameterSchema.required.${key}`, "must be unique");
      requiredSeen.add(key);
    }
    for (const [key, spec] of Object.entries(schema.properties)) {
      if (!object(spec) || !PARAM_TYPES.has(spec.type)) {
        add(errors, `parameterSchema.properties.${key}`, "has unsupported type");
        continue;
      }
      if (!text(spec.prompt)) add(errors, `parameterSchema.properties.${key}.prompt`, "is required");
      if (spec.promptPolicy != null && !PROMPT_POLICIES.has(spec.promptPolicy)) {
        add(errors, `parameterSchema.properties.${key}.promptPolicy`, "must be always, if_missing, or effect_summary");
      }
      if (spec.enum && (!Array.isArray(spec.enum) || spec.enum.length === 0)) add(errors, `parameterSchema.properties.${key}.enum`, "must be a non-empty array");
      if (Object.prototype.hasOwnProperty.call(spec, "default")) {
        const issue = validateParamValue(spec.default, spec);
        if (issue) add(errors, `parameterSchema.properties.${key}.default`, issue);
      }
    }
  }

  if (!Array.isArray(template.steps) || template.steps.length === 0) {
    add(errors, "steps", "must contain at least one step");
  } else {
    const ids = new Set();
    for (const [index, step] of template.steps.entries()) {
      if (!object(step) || !text(step.id)) add(errors, `steps[${index}].id`, "is required");
      else if (ids.has(step.id)) add(errors, `steps[${index}].id`, "must be unique");
      else ids.add(step.id);
      if (!STEP_KINDS.has(step?.kind)) add(errors, `steps[${index}].kind`, "is unsupported");
      if (!text(step?.intent)) add(errors, `steps[${index}].intent`, "is required");
      if (step?.workflowId != null && !WORKFLOW_ID_RE.test(step.workflowId)) {
        add(errors, `steps[${index}].workflowId`, "must match workflow.<lowercase-id>");
      }
      if (step?.dependsOn != null && (!Array.isArray(step.dependsOn) || step.dependsOn.some((id) => !text(id)))) {
        add(errors, `steps[${index}].dependsOn`, "must be a string array");
      }
    }
    for (const [index, step] of template.steps.entries()) {
      for (const dependency of step?.dependsOn || []) {
        if (!ids.has(dependency) || dependency === step.id) add(errors, `steps[${index}].dependsOn`, `invalid dependency ${dependency}`);
      }
    }
    const byId = new Map(template.steps.map((step) => [step.id, step]));
    const visiting = new Set();
    const visited = new Set();
    function visit(id) {
      if (visiting.has(id)) return true;
      if (visited.has(id)) return false;
      visiting.add(id);
      for (const dependency of byId.get(id)?.dependsOn || []) {
        if (byId.has(dependency) && visit(dependency)) return true;
      }
      visiting.delete(id);
      visited.add(id);
      return false;
    }
    if ([...byId.keys()].some(visit)) add(errors, "steps", "dependency graph must not contain a cycle");
  }

  const effect = template.effectPolicy;
  if (!object(effect) || !EFFECT_KINDS.has(effect.kind) || !CONFIRMATIONS.has(effect.confirmation)) {
    add(errors, "effectPolicy", "has invalid kind or confirmation");
  }
  const checkpoint = template.checkpointPolicy;
  if (!object(checkpoint) || typeof checkpoint.enabled !== "boolean" || typeof checkpoint.dedupe !== "boolean") {
    add(errors, "checkpointPolicy", "must include boolean enabled and dedupe");
  }
  if (!text(template.originRunId)) add(errors, "originRunId", "is required");
  if (template.descriptorHash != null && template.descriptorHash !== taskTemplateHash(template)) {
    add(errors, "descriptorHash", "does not match canonical template bytes");
  }
  return errors;
}

function coerce(value, spec) {
  if (value == null) return value;
  if (spec.type === "integer" && typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  if (spec.type === "boolean" && typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "yes", "y", "1", "是", "续跑"].includes(normalized)) return true;
    if (["false", "no", "n", "0", "否", "不续跑"].includes(normalized)) return false;
  }
  if (spec.type === "array" && typeof value === "string") {
    return [...new Set(value.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean))];
  }
  if (spec.type === "array" && Array.isArray(value) && spec.items?.type === "string") {
    return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))];
  }
  return value;
}

function substitute(value, params) {
  if (Array.isArray(value)) return value.map((item) => substitute(item, params));
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, params)]));
  if (typeof value !== "string") return value;
  const exact = value.match(/^\{\{([A-Za-z0-9_-]+)\}\}$/);
  if (exact && Object.prototype.hasOwnProperty.call(params, exact[1])) return params[exact[1]];
  return value.replace(/\{\{([A-Za-z0-9_-]+)\}\}/g, (_, key) => {
    const resolved = params[key];
    return Array.isArray(resolved) ? resolved.join(",") : resolved == null ? "" : String(resolved);
  });
}

function effectPreview(effectPolicy, params) {
  const enabledWhen = effectPolicy.enabledWhen;
  const enabled = !enabledWhen || params[enabledWhen.param] === enabledWhen.equals;
  let maxQuantity = 0;
  const quantity = effectPolicy.quantity;
  if (enabled && quantity?.operation === "multiply_length") {
    const array = params[quantity.arrayParam];
    const number = params[quantity.numberParam];
    if (Array.isArray(array) && Number.isInteger(number)) maxQuantity = array.length * number;
  } else if (enabled && quantity?.operation === "fixed") {
    maxQuantity = Number.isInteger(quantity.value) ? quantity.value : 0;
  }
  return {
    enabled,
    kind: enabled ? effectPolicy.kind : "none",
    confirmation: enabled ? effectPolicy.confirmation : "none",
    maxQuantity,
    recipient: effectPolicy.recipientParam ? params[effectPolicy.recipientParam] ?? null : null,
  };
}

export function resolveTaskTemplate(template, provided = {}) {
  const templateErrors = validateTaskTemplate(template);
  if (templateErrors.length) return { ok: false, templateErrors, missing: [], invalid: [], params: {} };
  const properties = template.parameterSchema.properties;
  const required = new Set(template.parameterSchema.required);
  const params = {};
  const missing = [];
  const invalid = [];
  const questions = [];

  for (const [key, spec] of Object.entries(properties)) {
    let value;
    if (Object.prototype.hasOwnProperty.call(provided, key)) value = coerce(provided[key], spec);
    else if (Object.prototype.hasOwnProperty.call(spec, "default")) value = spec.default;
    if (value === undefined) {
      if (required.has(key)) {
        missing.push(key);
        questions.push({ key, question: spec.prompt, type: spec.type, choices: spec.enum || null });
      }
      continue;
    }
    const issue = validateParamValue(value, spec);
    if (issue) invalid.push({ key, message: issue, question: spec.prompt });
    else params[key] = value;
  }

  const unknown = Object.keys(provided).filter((key) => !Object.prototype.hasOwnProperty.call(properties, key));
  for (const key of unknown) invalid.push({ key, message: "unknown parameter" });
  const ready = missing.length === 0 && invalid.length === 0;
  const resolvedSteps = ready ? substitute(template.steps, params) : [];
  const targetApp = inferTaskApp([
    template.templateId,
    template.name,
    template.description,
    ...(template.aliases || []),
    ...resolvedSteps.map((step) => `${step.intent || ""} ${step.workflowId || ""}`),
  ].join(" "));
  const locatorPolicy = ready
    ? locatorPolicyFor({ appId: targetApp, steps: resolvedSteps })
    : null;
  const locatorStepIds = resolvedSteps
    .filter((step) => ["explore", "workflow", "recipe", "primitive_steps"].includes(String(step.kind || "")))
    .map((step) => step.id);
  const foundationDependencies = locatorPolicy?.resolved
    ? [{
        capabilityId: locatorPolicy.foundationCapabilityId,
        role: "locator",
        bundled: true,
        activation: locatorPolicy.activation,
        executionStatus: locatorPolicy.executionStatus,
        appliesToStepIds: locatorStepIds,
      }]
    : [];
  const unresolvedDependencies = locatorPolicy && !locatorPolicy.resolved
    ? [{ role: "locator", reason: locatorPolicy.reason }]
    : [];
  return {
    ok: true,
    ready,
    parametersReady: ready,
    executionReady: false,
    nextAction: !ready ? "collect_parameters" : template.status === "implemented" ? "resolve_live_plan" : "review_template",
    templateId: template.templateId,
    revision: template.revision,
    name: template.name,
    status: template.status,
    targetApp,
    params,
    missing,
    invalid,
    questions,
    defaults: Object.fromEntries(
      Object.entries(properties)
        .filter(([, spec]) => Object.prototype.hasOwnProperty.call(spec, "default"))
        .map(([key, spec]) => [key, spec.default]),
    ),
    steps: resolvedSteps,
    locatorPolicy,
    foundationDependencies,
    unresolvedDependencies,
    effectPreview: effectPreview(template.effectPolicy, params),
    checkpointPolicy: template.checkpointPolicy,
    fixedConstraints: template.fixedConstraints || {},
    stageRouteHints: template.steps.map((step) => ({
      stepId: step.id,
      route:
        step.kind === "explore"
          ? "conditional_explore"
          : step.kind === "capability" || step.kind === "recipe"
            ? "resolve_live"
            : step.kind === "workflow"
              ? step.workflowId
                ? "resolve_known_workflow"
                : "orchestrate"
              : step.kind,
    })),
  };
}

export function loadTaskTemplates({ dir = DEFAULT_TASK_TEMPLATE_DIR, includeAll = false } = {}) {
  if (!existsSync(dir)) return { templates: [], errors: [] };
  const templates = [];
  const errors = [];
  for (const name of readdirSync(dir).filter((entry) => entry.endsWith(".json")).sort()) {
    const path = join(dir, name);
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("must be a regular file");
      const template = JSON.parse(readFileSync(path, "utf8"));
      const validation = validateTaskTemplate(template);
      if (validation.length) throw new Error(validation.map((item) => `${item.path}:${item.message}`).join("; "));
      if (includeAll || template.status !== "archived") templates.push(template);
    } catch (error) {
      errors.push({ file: name, message: String(error.message || error) });
    }
  }
  const latest = new Map();
  for (const template of templates) {
    const previous = latest.get(template.templateId);
    if (!previous || template.revision > previous.revision) latest.set(template.templateId, template);
  }
  return { templates: [...latest.values()].sort((a, b) => a.name.localeCompare(b.name, "zh-CN")), errors };
}

export function matchTaskTemplate(templates, query) {
  const normalized = String(query || "").trim().toLowerCase();
  if (!normalized) return { match: null, ambiguous: [] };
  const exact = templates.filter((template) =>
    [template.templateId, template.name, ...(template.aliases || [])].some((value) => String(value).toLowerCase() === normalized),
  );
  if (exact.length === 1) return { match: exact[0], ambiguous: [] };
  if (exact.length > 1) return { match: null, ambiguous: exact };
  const fuzzy = templates.filter((template) =>
    [template.name, ...(template.aliases || [])].some((value) => {
      const candidate = String(value).toLowerCase();
      return candidate.includes(normalized) || normalized.includes(candidate);
    }),
  );
  return fuzzy.length === 1 ? { match: fuzzy[0], ambiguous: [] } : { match: null, ambiguous: fuzzy };
}

export function saveTaskTemplate(template, { dir = DEFAULT_TASK_TEMPLATE_DIR } = {}) {
  const errors = validateTaskTemplate(template);
  if (errors.length) throw new Error(errors.map((item) => `${item.path}:${item.message}`).join("; "));
  mkdirSync(dir, { recursive: true });
  const sealed = { ...canonicalize(template), descriptorHash: taskTemplateHash(template) };
  const file = `${template.templateId}@${template.revision}.json`;
  const path = join(dir, file);
  const payload = `${JSON.stringify(sealed, null, 2)}\n`;
  if (existsSync(path)) {
    const existing = JSON.parse(readFileSync(path, "utf8"));
    if (taskTemplateHash(existing) === sealed.descriptorHash) return { result: "already_saved", path, template: existing };
    throw new Error(`immutable task template conflict: ${template.templateId}@${template.revision}`);
  }
  const temp = `${path}.tmp.${process.pid}`;
  writeFileSync(temp, payload, "utf8");
  renameSync(temp, path);
  return { result: "saved", path, template: sealed };
}
