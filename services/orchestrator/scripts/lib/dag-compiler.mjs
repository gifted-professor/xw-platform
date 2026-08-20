// M5-2 DAG Compiler —— Task Router 分类结果 → xw.orchestration.dag.v1。
// 纯函数：无 IO、无随机、无副作用。输出 deep-frozen。
import { createHash } from "node:crypto";
import { validateSkillVersionRef } from "../../../../packages/kernel/lib/skill-runtime.mjs";

const FORBIDDEN_KEY = /lease|transport|payment|capabilityId|executor|rawCommand/i;
const SKILL_ID_PATTERN = /^[a-z0-9]+(\.[a-z0-9-]+)+$/;
const TASK_TYPES = new Set(["search", "collection", "validation"]);
const ROLES = new Set(["collect", "search", "validate"]);
const EFFECT_CLASSES = new Set(["none", "reversible", "social", "publish", "payment", "delete"]);
const BUSINESS_EFFECT_CLASSES = new Set(["social", "publish", "payment", "delete"]);

function codedError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  throw error;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

function cloneJson(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function rejectForbiddenFields(value, path) {
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key)) codedError("DAG_FORBIDDEN_FIELD", `DAG must not carry ${path}.${key}`);
    rejectForbiddenFields(nested, `${path}.${key}`);
  }
}

export function normalizeCatalog(catalog = []) {
  if (!Array.isArray(catalog)) codedError("DAG_CATALOG_INVALID", "catalog must be an array");
  const seen = new Set();
  return catalog.map((entry) => {
    const skillId = String(entry?.skillId || "").trim();
    if (!SKILL_ID_PATTERN.test(skillId)) codedError("DAG_CATALOG_ENTRY", `invalid catalog skillId: ${skillId || "<empty>"}`);
    if (seen.has(skillId)) codedError("DAG_CATALOG_ENTRY", `duplicate catalog skillId: ${skillId}`);
    seen.add(skillId);

    const roles = Array.isArray(entry.roles) ? [...new Set(entry.roles)] : [];
    if (roles.length === 0 || roles.some((role) => !ROLES.has(role))) {
      codedError("DAG_CATALOG_ENTRY", `catalog entry ${skillId} has invalid roles`);
    }
    if (Object.hasOwn(entry, "externalEffect")) {
      codedError("DAG_CATALOG_UNTRUSTED_EFFECT", `catalog entry ${skillId} must use trusted effectClass, not externalEffect`);
    }
    const effectClass = entry.effectClass;
    if (!EFFECT_CLASSES.has(effectClass)) {
      codedError("DAG_CATALOG_ENTRY", `catalog entry ${skillId} requires a known effectClass`);
    }

    const ref = entry.skillVersionRef;
    const refValidation = validateSkillVersionRef(ref, { code: "DAG_CATALOG_ENTRY" });
    if (!refValidation.ok) {
      codedError("DAG_CATALOG_ENTRY", `catalog entry ${skillId} has invalid skillVersionRef`, refValidation.errors);
    }
    if (ref.skillId !== skillId) {
      codedError("DAG_CATALOG_ENTRY", `catalog entry ${skillId} mismatches skillVersionRef.skillId ${ref.skillId}`);
    }
    if (entry.localValidator === true && (!roles.includes("validate") || effectClass !== "none")) {
      codedError("DAG_CATALOG_ENTRY", `local validator ${skillId} must have validate role and effectClass=none`);
    }
    const executor = entry.executor;
    if (executor?.kind === "capability") {
      if (!SKILL_ID_PATTERN.test(executor.capabilityId || "") || entry.localValidator === true) {
        codedError("DAG_CATALOG_ENTRY", `catalog entry ${skillId} has invalid capability executor`);
      }
    } else if (executor?.kind === "local") {
      if (!entry.localValidator || typeof executor.module !== "string" || !executor.module
        || typeof executor.exportName !== "string" || !executor.exportName) {
        codedError("DAG_CATALOG_ENTRY", `catalog entry ${skillId} has invalid local executor`);
      }
    } else {
      codedError("DAG_CATALOG_ENTRY", `catalog entry ${skillId} requires a registered executor`);
    }

    return {
      skillId,
      roles,
      effectClass,
      localValidator: entry.localValidator === true,
      executor: cloneJson(executor),
      skillVersionRef: { ...ref },
    };
  });
}

function pickSkill(catalog, role, allowedIds = null) {
  const candidates = catalog.filter((entry) => entry.roles.includes(role) && (!allowedIds || allowedIds.has(entry.skillId)));
  return candidates.find((entry) => entry.effectClass === "none") || candidates[0] || null;
}

function pickLocalValidator(catalog, allowedIds = null) {
  return catalog.find((entry) => entry.roles.includes("validate")
    && entry.localValidator
    && entry.effectClass === "none"
    && (!allowedIds || allowedIds.has(entry.skillId))) || null;
}

function assertClassification(classification, registeredIds) {
  if (!classification || typeof classification !== "object") {
    codedError("DAG_COMPILE_CLASSIFICATION", "classification is required");
  }
  if (classification.taskType === "needs_human") {
    codedError("DAG_COMPILE_NEEDS_HUMAN", "classification must resolve to a concrete taskType, not needs_human");
  }
  if (classification.schemaId !== "xw.orchestration.task-classification.v1" || classification.schemaVersion !== 1) {
    codedError("DAG_COMPILE_CLASSIFICATION", "classification contract identity is invalid");
  }
  if (!TASK_TYPES.has(classification.taskType)) {
    codedError("DAG_COMPILE_UNKNOWN_TYPE", `unknown taskType ${classification.taskType}`);
  }
  if (!Number.isInteger(classification.workers) || classification.workers < 1 || classification.workers > 4) {
    codedError("DAG_COMPILE_CLASSIFICATION", "classification.workers must be within 1..4");
  }
  if (!Array.isArray(classification.sourceSkills) || classification.sourceSkills.some((id) => !registeredIds.has(id))) {
    codedError("DAG_COMPILE_UNREGISTERED_SKILL", "classification.sourceSkills must all resolve in the registered catalog");
  }
  if (new Set(classification.sourceSkills).size !== classification.sourceSkills.length) {
    codedError("DAG_COMPILE_CLASSIFICATION", "classification.sourceSkills must be unique");
  }
}

export function validateDagNodes(nodes) {
  if (!Array.isArray(nodes) || nodes.length === 0) codedError("DAG_COMPILE_EMPTY", "DAG nodes are required");
  const byId = new Map();
  for (const node of nodes) {
    if (!node?.nodeId || byId.has(node.nodeId)) codedError("DAG_COMPILE_DUPLICATE_NODE", `duplicate or missing nodeId: ${node?.nodeId || "<empty>"}`);
    byId.set(node.nodeId, node);
    if (!Array.isArray(node.dependsOn)) codedError("DAG_COMPILE_DEPENDENCY", `node ${node.nodeId} dependsOn must be an array`);
    if (!Array.isArray(node.targetAliases)) codedError("DAG_COMPILE_ALIAS", `node ${node.nodeId} targetAliases must be an array`);
    if (node.targetAliases.some((alias) => !/^0[1-4]$/.test(alias))) codedError("DAG_COMPILE_ALIAS", `node ${node.nodeId} has invalid alias`);
    if (new Set(node.targetAliases).size !== node.targetAliases.length) codedError("DAG_COMPILE_ALIAS", `node ${node.nodeId} has duplicate aliases`);
  }

  const state = new Map([...byId.keys()].map((id) => [id, 0]));
  function visit(nodeId) {
    const mark = state.get(nodeId);
    if (mark === 2) return;
    if (mark === 1) codedError("DAG_COMPILE_CYCLE", `circular dependency involving ${nodeId}`);
    state.set(nodeId, 1);
    for (const dep of byId.get(nodeId).dependsOn) {
      if (dep === nodeId) codedError("DAG_COMPILE_CYCLE", `node ${nodeId} depends on itself`);
      if (!byId.has(dep)) codedError("DAG_COMPILE_UNKNOWN_DEP", `node ${nodeId} depends on unknown node ${dep}`);
      visit(dep);
    }
    state.set(nodeId, 2);
  }
  for (const nodeId of byId.keys()) visit(nodeId);

  const dependedOn = new Set(nodes.flatMap((node) => node.dependsOn));
  for (const node of nodes) {
    if (node.localValidator && dependedOn.has(node.nodeId)) {
      codedError("DAG_COMPILE_VALIDATOR_NON_TERMINAL", `local validator ${node.nodeId} must be terminal`);
    }
  }
  return true;
}

function nextIdFactory() {
  let value = 0;
  return () => {
    value += 1;
    return `n${value}`;
  };
}

export function compileDag({ classification, catalog = [], aliases = [], traceId, params = {} } = {}) {
  if (typeof traceId !== "string" || !traceId.trim()) {
    codedError("DAG_TRACE_ID_REQUIRED", "compileDag requires a non-empty traceId");
  }
  const normalizedCatalog = normalizeCatalog(catalog);
  const registeredIds = new Set(normalizedCatalog.map((entry) => entry.skillId));
  assertClassification(classification, registeredIds);
  rejectForbiddenFields(params, "params");

  if (!Array.isArray(aliases) || aliases.some((alias) => !/^0[1-4]$/.test(String(alias)))) {
    codedError("DAG_COMPILE_ALIAS", "aliases must contain only 01..04");
  }
  const targetAliases = [...new Set(aliases.map(String))].sort();
  const primaryIds = new Set(classification.sourceSkills);
  const nextId = nextIdFactory();
  const nodes = [];

  const makeNode = ({ entry, inputs, dependsOn = [], nodeAliases = [], localValidator = false }) => {
    if (!entry || !registeredIds.has(entry.skillId)) {
      codedError("DAG_COMPILE_UNREGISTERED_SKILL", `skillId ${entry?.skillId || "<missing>"} is not registered`);
    }
    const node = {
      nodeId: nextId(),
      skillId: entry.skillId,
      skillVersionRef: { ...entry.skillVersionRef },
      inputs: cloneJson(inputs ?? {}),
      dependsOn: [...new Set(dependsOn)],
      targetAliases: [...new Set(nodeAliases)].sort(),
      expectedEffectClass: entry.effectClass,
      requiresHuman: BUSINESS_EFFECT_CLASSES.has(entry.effectClass),
      localValidator,
    };
    nodes.push(node);
    return node;
  };

  const addValidator = (dependencies) => {
    const validator = pickLocalValidator(normalizedCatalog);
    if (!validator) codedError("DAG_COMPILE_NO_VALIDATOR", "validatorRequired requires a registered local validate skill");
    makeNode({
      entry: validator,
      inputs: { reduce: cloneJson(params.reduce ?? {}) },
      dependsOn: dependencies,
      localValidator: true,
    });
  };

  if (classification.taskType === "collection") {
    const collect = pickSkill(normalizedCatalog, "collect", primaryIds);
    if (!collect) codedError("DAG_COMPILE_NO_SKILL", "collection requires a registered collect skill");
    const count = targetAliases.length || classification.workers;
    const workNodes = Array.from({ length: count }, (_, index) => makeNode({
      entry: collect,
      inputs: params.collect ?? params ?? {},
      nodeAliases: targetAliases.length ? [targetAliases[index]] : [],
    }));
    if (classification.validatorRequired) addValidator(workNodes.map((node) => node.nodeId));
  } else if (classification.taskType === "search") {
    const sources = normalizedCatalog.filter((entry) => entry.roles.includes("search") && primaryIds.has(entry.skillId));
    if (sources.length === 0) codedError("DAG_COMPILE_NO_SKILL", "search requires a registered search skill");
    const sourceNodes = sources.map((entry) => makeNode({ entry, inputs: params ?? {} }));
    if (classification.validatorRequired) addValidator(sourceNodes.map((node) => node.nodeId));
  } else {
    const validator = pickLocalValidator(normalizedCatalog, primaryIds);
    if (!validator) codedError("DAG_COMPILE_NO_VALIDATOR", "validation requires a registered local validate skill");
    makeNode({ entry: validator, inputs: params ?? {}, localValidator: true });
  }

  validateDagNodes(nodes);
  const catalogHash = digest(normalizedCatalog);
  const structural = { taskType: classification.taskType, catalogHash, nodes };
  const planHash = digest(structural);
  const externalPresent = nodes.some((node) => node.requiresHuman);

  return deepFreeze({
    schemaId: "xw.orchestration.dag.v1",
    schemaVersion: 1,
    dagId: `dag_${planHash.slice(0, 16)}`,
    taskType: classification.taskType,
    traceId: traceId.trim(),
    catalogHash,
    nodes,
    executionReady: !externalPresent,
    humanGate: externalPresent ? "WAIT_HUMAN" : null,
    planHash,
  });
}

export function hashDag(dag) {
  return digest(dag);
}
