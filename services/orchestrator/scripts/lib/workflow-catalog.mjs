import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_WORKFLOW_CATALOG = resolve(HERE, "../../contracts/workflows.v1.json");

export const WORKFLOW_CATALOG_SCHEMA_ID = "xhs.workflow-catalog.v1";
export const WORKFLOW_CATALOG_SCHEMA_VERSION = 1;

const STATUS = new Set(["implemented", "canary_only", "candidate", "disabled", "retired"]);
const MATURITY = new Set(["canary_only", "candidate", "implemented", "disabled"]);
const ENTRY = new Set(["session"]);
const REPLAY = new Set(["read_only", "replay_safe", "ambiguous_on_timeout"]);
const EFFECT = new Set(["none"]);
const PRIMITIVES = new Set([
  "screen",
  "dump_ui",
  "focus",
  "tap",
  "swipe",
  "back",
  "launch_app",
  "input_text",
]);
const ALIAS_RE = /^(0[1-4])$/;
const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const WORKFLOW_ID_RE = /^workflow\.[a-z0-9]+(?:[._-][a-z0-9]+)+$/;

function object(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function strings(value) {
  return Array.isArray(value) && value.length > 0 && value.every((item) => text(item));
}

function issue(errors, path, message) {
  errors.push({ path, message });
}

export function validateWorkflowCatalog(catalog) {
  const errors = [];
  if (!object(catalog)) return [{ path: "$", message: "catalog must be an object" }];
  if (catalog.schemaId !== WORKFLOW_CATALOG_SCHEMA_ID || catalog.schemaVersion !== WORKFLOW_CATALOG_SCHEMA_VERSION) {
    issue(errors, "schema", "must be xhs.workflow-catalog.v1 version 1");
  }
  if (!Array.isArray(catalog.workflows)) {
    issue(errors, "workflows", "must be an array");
    return errors;
  }
  const ids = new Set();
  for (const [index, workflow] of catalog.workflows.entries()) {
    const path = `workflows[${index}]`;
    if (!object(workflow)) {
      issue(errors, path, "must be an object");
      continue;
    }
    if (!WORKFLOW_ID_RE.test(workflow.workflowId || "")) issue(errors, `${path}.workflowId`, "has invalid format");
    if (ids.has(workflow.workflowId)) issue(errors, `${path}.workflowId`, "must be unique");
    ids.add(workflow.workflowId);
    if (!Number.isInteger(workflow.version) || workflow.version < 1) issue(errors, `${path}.version`, "must be integer >= 1");
    if (!text(workflow.title)) issue(errors, `${path}.title`, "is required");
    if (!text(workflow.description)) issue(errors, `${path}.description`, "is required");
    if (!text(workflow.appId)) issue(errors, `${path}.appId`, "is required");
    if (!STATUS.has(workflow.status)) issue(errors, `${path}.status`, "is invalid");
    if (!MATURITY.has(workflow.maturity)) issue(errors, `${path}.maturity`, "is invalid");
    if (!ENTRY.has(workflow.entry)) issue(errors, `${path}.entry`, "must be session for P1");
    if (workflow.capabilityId !== "xiaowei.explorer.primitive") {
      issue(errors, `${path}.capabilityId`, "P1 session workflows must use xiaowei.explorer.primitive");
    }
    if (!REPLAY.has(workflow.replaySafety)) issue(errors, `${path}.replaySafety`, "is invalid");
    if (!EFFECT.has(workflow.effectClass)) issue(errors, `${path}.effectClass`, "must be none for P1 catalog");
    if (!Array.isArray(workflow.resources) || workflow.resources.some((item) => !text(item))) {
      issue(errors, `${path}.resources`, "must be string[]");
    }
    if (!strings(workflow.intentAliases)) issue(errors, `${path}.intentAliases`, "must be non-empty string[]");
    if (!object(workflow.expectedApp) || !text(workflow.expectedApp.package)) {
      issue(errors, `${path}.expectedApp.package`, "is required");
    }
    if (!Array.isArray(workflow.expectedApp?.activityIncludes) || workflow.expectedApp.activityIncludes.some((item) => !text(item))) {
      issue(errors, `${path}.expectedApp.activityIncludes`, "must be string[]");
    }
    if (!Array.isArray(workflow.actions) || workflow.actions.length === 0) {
      issue(errors, `${path}.actions`, "must be a non-empty array");
    } else {
      const actionIds = new Set();
      for (const [actionIndex, action] of workflow.actions.entries()) {
        const actionPath = `${path}.actions[${actionIndex}]`;
        if (!object(action)) {
          issue(errors, actionPath, "must be an object");
          continue;
        }
        if (!ID_RE.test(action.actionId || "")) issue(errors, `${actionPath}.actionId`, "has invalid format");
        if (actionIds.has(action.actionId)) issue(errors, `${actionPath}.actionId`, "must be unique");
        actionIds.add(action.actionId);
        if (!PRIMITIVES.has(action.primitive)) issue(errors, `${actionPath}.primitive`, "is not a bounded Explorer primitive");
        if (action.params != null && !object(action.params)) issue(errors, `${actionPath}.params`, "must be an object when present");
      }
    }
    if (!object(workflow.acceptance)) {
      issue(errors, `${path}.acceptance`, "is required");
    } else {
      if (!strings(workflow.acceptance.requiredFields)) {
        issue(errors, `${path}.acceptance.requiredFields`, "must be non-empty string[]");
      }
      if (workflow.acceptance.paymentTransport !== 0) {
        issue(errors, `${path}.acceptance.paymentTransport`, "must be 0");
      }
      if (workflow.acceptance.finalCommit !== false) {
        issue(errors, `${path}.acceptance.finalCommit`, "must be false");
      }
      if (workflow.acceptance.privacy?.publicKnowledge !== false) {
        issue(errors, `${path}.acceptance.privacy.publicKnowledge`, "must be false for P1 workflows with private evidence");
      }
    }
    if (!object(workflow.placement)) {
      issue(errors, `${path}.placement`, "is required");
    } else {
      if (workflow.placement.compileMode !== "one_shard_per_alias") {
        issue(errors, `${path}.placement.compileMode`, "must be one_shard_per_alias");
      }
      if (workflow.placement.allowReassign !== false) {
        issue(errors, `${path}.placement.allowReassign`, "must be false");
      }
      if (
        !Array.isArray(workflow.placement.fixedAliases) ||
        workflow.placement.fixedAliases.length === 0 ||
        workflow.placement.fixedAliases.some((alias) => !ALIAS_RE.test(alias))
      ) {
        issue(errors, `${path}.placement.fixedAliases`, "must be non-empty aliases 01-04");
      }
    }
    if (typeof workflow.tapAuthorized !== "boolean") issue(errors, `${path}.tapAuthorized`, "must be boolean");
    if (typeof workflow.directRun !== "boolean") issue(errors, `${path}.directRun`, "must be boolean");
    if (workflow.directRun === true && workflow.maturity !== "implemented") {
      issue(errors, `${path}.directRun`, "cannot be true unless maturity=implemented");
    }
    if (workflow.tapAuthorized === true && workflow.maturity === "canary_only") {
      // Allowed only as explicit canary flag; still not production. No hard fail.
    }
    if (!Array.isArray(workflow.limitations) || workflow.limitations.some((item) => !text(item))) {
      issue(errors, `${path}.limitations`, "must be string[]");
    }
  }
  return errors;
}

export function loadWorkflowCatalog({ path = DEFAULT_WORKFLOW_CATALOG } = {}) {
  if (!existsSync(path)) throw new Error(`workflow catalog missing: ${path}`);
  const catalog = JSON.parse(readFileSync(path, "utf8"));
  const errors = validateWorkflowCatalog(catalog);
  if (errors.length) throw new Error(`workflow catalog invalid: ${JSON.stringify(errors)}`);
  return {
    schemaId: catalog.schemaId,
    schemaVersion: catalog.schemaVersion,
    workflows: catalog.workflows.map((item) => structuredClone(item)),
  };
}

export function loadWorkflows(options = {}) {
  return loadWorkflowCatalog(options).workflows;
}

export function getWorkflow(workflowId, options = {}) {
  return loadWorkflows(options).find((item) => item.workflowId === workflowId) || null;
}

/**
 * Build TaskPlan v2 node authoring for a session workflow.
 * Fixed one shard per alias; allowReassign always false at placement.
 */
export function compileWorkflowNodeAuthoring(workflow, {
  nodeId = null,
  aliases = null,
  params = {},
  paramsByAlias = null,
} = {}) {
  if (!object(workflow) || !text(workflow.workflowId)) {
    throw new Error("workflow descriptor is required");
  }
  const fixed = Array.isArray(aliases) && aliases.length
    ? aliases.map(String)
    : [...(workflow.placement?.fixedAliases || ["01", "02", "03", "04"])];
  for (const alias of fixed) {
    if (!ALIAS_RE.test(alias)) throw new Error(`invalid alias ${alias}`);
  }
  const shards = fixed.map((alias) => {
    const shardParams = paramsByAlias && object(paramsByAlias[alias])
      ? paramsByAlias[alias]
      : params;
    return {
      placement: { alias },
      params: structuredClone(shardParams || {}),
    };
  });
  return {
    nodeId: nodeId || workflow.workflowId.replace(/[^a-zA-Z0-9._-]/g, "_"),
    executor: {
      kind: "session_workflow",
      workflowId: workflow.workflowId,
      capabilityId: workflow.capabilityId,
      appId: workflow.appId,
      replaySafety: workflow.replaySafety || "read_only",
      effectClass: workflow.effectClass || "none",
      resources: [...(workflow.resources || [])],
      ...(workflow.expectedApp ? { expectedApp: structuredClone(workflow.expectedApp) } : {}),
    },
    shards,
    ...(workflow.acceptance ? { acceptance: structuredClone(workflow.acceptance) } : {}),
  };
}

export function workflowIsDirectlyRunnable(workflow) {
  return Boolean(
    workflow &&
    workflow.directRun === true &&
    workflow.status === "implemented" &&
    workflow.maturity === "implemented" &&
    workflow.effectClass === "none",
  );
}

export function summarizeWorkflow(workflow) {
  return {
    workflowId: workflow.workflowId,
    version: workflow.version,
    title: workflow.title,
    description: workflow.description,
    appId: workflow.appId,
    status: workflow.status,
    maturity: workflow.maturity,
    entry: workflow.entry,
    capabilityId: workflow.capabilityId,
    replaySafety: workflow.replaySafety,
    effectClass: workflow.effectClass,
    resources: [...(workflow.resources || [])],
    intentAliases: [...(workflow.intentAliases || [])],
    tapAuthorized: workflow.tapAuthorized,
    directRun: workflow.directRun,
    placement: structuredClone(workflow.placement),
    acceptance: {
      paymentTransport: workflow.acceptance?.paymentTransport,
      finalCommit: workflow.acceptance?.finalCommit,
      requiredFields: [...(workflow.acceptance?.requiredFields || [])],
      amountMustBeUniqueOnScreen: workflow.acceptance?.amountMustBeUniqueOnScreen === true,
      privacy: structuredClone(workflow.acceptance?.privacy || {}),
    },
    actionCount: Array.isArray(workflow.actions) ? workflow.actions.length : 0,
    limitations: [...(workflow.limitations || [])],
  };
}
