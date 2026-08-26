/**
 * recipe-interpreter.mjs — Phase 5 controlled Recipe Interpreter (scaffolding)
 *
 * Whitelist primitives only. Default path is plan-only: validate + return a
 * structured call plan. Live device I/O requires ALL of:
 *   1. opts.live === true
 *   2. a leased control-plane session handle (session.leaseId / sessionId)
 *   3. per-kind handlers (injected; never auto-opens ADB / GatewayOperator)
 *
 * Without those, this module NEVER touches a device.
 *
 * Semantic selectors preferred; x/y coords are device+version-bound fallbacks.
 */
import { createHash } from "node:crypto";

export const RECIPE_PRIMITIVE_KINDS = Object.freeze([
  "callCapability",
  "dump",
  "focus",
  "screenshot",
  "tapSelector",
  "swipe",
  "input",
  "back",
  "launch",
  "wait",
]);

/** Max settle wait for fixed-script `wait` steps (ms). */
export const RECIPE_WAIT_MS_MAX = 10_000;

/** Assertion types evaluated by evaluateRecipeAssertion (PR1 sparse set). */
export const RECIPE_ASSERTION_TYPES = Object.freeze([
  "packageEquals",
  "activityContains",
  "activityMatches",
  "textExists",
  "resourceIdExists",
]);

const PRIMITIVE_SET = new Set(RECIPE_PRIMITIVE_KINDS);

const EXECUTOR_KINDS = Object.freeze(["capability", "capability_wrapper", "primitive_steps"]);

function err(message, code = "RECIPE_INTERPRETER_INVALID") {
  const e = new Error(message);
  e.code = code;
  return e;
}

function isObject(v) {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

/** Semantic selector: string resource/text OR object with semantic fields. */
function isSemanticSelector(v) {
  if (isNonEmptyString(v)) return true;
  if (!isObject(v)) return false;
  return (
    isNonEmptyString(v.text) ||
    isNonEmptyString(v.contentDesc) ||
    isNonEmptyString(v.resourceId) ||
    isNonEmptyString(v.className) ||
    isNonEmptyString(v.id) ||
    isNonEmptyString(v.match) ||
    isNonEmptyString(v.xpath) ||
    isNonEmptyString(v.css)
  );
}

/**
 * Coord fallback must be explicitly device+version bound when present.
 * Allowed shapes: { x, y, deviceBound?: { alias|serial, appVersion? } }
 */
function assertCoordFallback(params, stepId, field = "coords") {
  const x = params.x;
  const y = params.y;
  const hasX = x != null;
  const hasY = y != null;
  if (!hasX && !hasY) return null;
  if (!isFiniteNumber(x) || !isFiniteNumber(y)) {
    throw err(`step ${stepId}: ${field} fallback requires numeric x and y`);
  }
  const bound = params.deviceBound || params.coordBound || params.fallbackBound;
  if (!isObject(bound)) {
    throw err(
      `step ${stepId}: coord fallback (x/y) requires deviceBound { alias|serial, appVersion? }`,
    );
  }
  if (!isNonEmptyString(bound.alias) && !isNonEmptyString(bound.serial)) {
    throw err(`step ${stepId}: deviceBound must include alias or serial`);
  }
  return { x, y, deviceBound: { ...bound } };
}

function assertAssertions(value, label, stepId) {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw err(`step ${stepId}: ${label} must be an array`);
  }
  return value.map((a, i) => {
    if (isNonEmptyString(a)) return { type: "text", value: a };
    if (!isObject(a)) throw err(`step ${stepId}: ${label}[${i}] must be string or object`);
    return { ...a };
  });
}

function validateParamsForKind(kind, params, stepId) {
  const p = params == null ? {} : params;
  if (!isObject(p)) throw err(`step ${stepId}: params must be an object`);

  switch (kind) {
    case "callCapability": {
      const capabilityId = p.capabilityId || p.capability;
      if (!isNonEmptyString(capabilityId)) {
        throw err(`step ${stepId}: callCapability requires params.capabilityId`);
      }
      if (p.params != null && !isObject(p.params)) {
        throw err(`step ${stepId}: callCapability params.params must be an object`);
      }
      return {
        capabilityId: String(capabilityId).trim(),
        params: isObject(p.params) ? { ...p.params } : {},
      };
    }
    case "dump": {
      const out = {};
      if (p.format != null) {
        if (!isNonEmptyString(p.format)) throw err(`step ${stepId}: dump.format must be string`);
        out.format = String(p.format).trim();
      }
      return out;
    }
    case "focus": {
      if (!isSemanticSelector(p.selector) && !isSemanticSelector(p)) {
        // allow resourceId / text at top level
        if (!isNonEmptyString(p.resourceId) && !isNonEmptyString(p.text)) {
          throw err(`step ${stepId}: focus requires semantic selector (selector|resourceId|text)`);
        }
      }
      const out = { ...p };
      if (out.selector != null && !isSemanticSelector(out.selector)) {
        throw err(`step ${stepId}: focus.selector must be semantic`);
      }
      return out;
    }
    case "screenshot": {
      const out = {};
      if (p.label != null) {
        if (!isNonEmptyString(p.label)) throw err(`step ${stepId}: screenshot.label must be string`);
        out.label = String(p.label).trim();
      }
      return out;
    }
    case "tapSelector": {
      const hasSelector = isSemanticSelector(p.selector);
      const coord = assertCoordFallback(p, stepId);
      if (!hasSelector && !coord) {
        throw err(
          `step ${stepId}: tapSelector requires semantic selector (preferred) or device-bound x/y fallback`,
        );
      }
      const out = {};
      if (hasSelector) out.selector = typeof p.selector === "string" ? p.selector.trim() : { ...p.selector };
      if (coord) {
        out.x = coord.x;
        out.y = coord.y;
        out.deviceBound = coord.deviceBound;
      }
      return out;
    }
    case "swipe": {
      const out = {};
      if (p.direction != null) {
        if (!isNonEmptyString(p.direction)) throw err(`step ${stepId}: swipe.direction must be string`);
        out.direction = String(p.direction).trim().toLowerCase();
      }
      if (p.selector != null) {
        if (!isSemanticSelector(p.selector)) throw err(`step ${stepId}: swipe.selector must be semantic`);
        out.selector = typeof p.selector === "string" ? p.selector.trim() : { ...p.selector };
      }
      if (p.from != null || p.to != null) {
        if (!isObject(p.from) || !isObject(p.to)) {
          throw err(`step ${stepId}: swipe from/to must both be {x,y} objects`);
        }
        if (!isFiniteNumber(p.from.x) || !isFiniteNumber(p.from.y) || !isFiniteNumber(p.to.x) || !isFiniteNumber(p.to.y)) {
          throw err(`step ${stepId}: swipe from/to require numeric x,y`);
        }
        const bound = p.deviceBound || p.coordBound || p.fallbackBound;
        if (!isObject(bound) || (!isNonEmptyString(bound.alias) && !isNonEmptyString(bound.serial))) {
          throw err(`step ${stepId}: swipe coord path requires deviceBound { alias|serial }`);
        }
        out.from = { x: p.from.x, y: p.from.y };
        out.to = { x: p.to.x, y: p.to.y };
        out.deviceBound = { ...bound };
      }
      if (!out.direction && !out.from && !out.selector) {
        throw err(`step ${stepId}: swipe requires direction, selector, or device-bound from/to`);
      }
      return out;
    }
    case "input": {
      if (!isNonEmptyString(p.text) && p.text !== "") {
        throw err(`step ${stepId}: input requires params.text (string)`);
      }
      if (typeof p.text !== "string") throw err(`step ${stepId}: input.text must be string`);
      const out = { text: p.text };
      if (p.selector != null) {
        if (!isSemanticSelector(p.selector)) throw err(`step ${stepId}: input.selector must be semantic`);
        out.selector = typeof p.selector === "string" ? p.selector.trim() : { ...p.selector };
      }
      if (p.clear != null) out.clear = Boolean(p.clear);
      if (p.enter != null) out.enter = Boolean(p.enter);
      if (p.clearFirst != null) out.clearFirst = Boolean(p.clearFirst);
      return out;
    }
    case "back": {
      // no required params
      return {};
    }
    case "launch": {
      const appId = p.appId || p.packageName || p.package || p.app;
      if (!isNonEmptyString(appId)) {
        throw err(`step ${stepId}: launch requires params.appId or packageName`);
      }
      return {
        appId: String(appId).trim(),
        ...(isNonEmptyString(p.activity) ? { activity: String(p.activity).trim() } : {}),
      };
    }
    case "wait": {
      const ms = p.ms ?? p.durationMs ?? p.timeoutMs;
      if (!Number.isInteger(ms) || ms < 0) {
        throw err(`step ${stepId}: wait requires params.ms as a non-negative integer`);
      }
      if (ms > RECIPE_WAIT_MS_MAX) {
        throw err(`step ${stepId}: wait.ms exceeds max ${RECIPE_WAIT_MS_MAX}`);
      }
      return { ms };
    }
    default:
      throw err(`step ${stepId}: unknown kind ${kind}`);
  }
}

/**
 * Bind `$input.path` placeholders in recipe params (and assertion values).
 * Only own properties of `input` are readable; missing paths throw.
 * Literal dollar: use `$$` → `$`.
 *
 * @param {unknown} value
 * @param {object} input
 * @returns {unknown}
 */
export function bindRecipeInput(value, input = {}) {
  if (!isObject(input)) throw err("bindRecipeInput: input must be an object", "RECIPE_INPUT_INVALID");
  return bindValue(value, input);
}

function bindValue(value, input) {
  if (typeof value === "string") return bindString(value, input);
  if (Array.isArray(value)) return value.map((v) => bindValue(v, input));
  if (isObject(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = bindValue(v, input);
    return out;
  }
  return value;
}

function bindString(str, input) {
  // Exact `$input.foo.bar` → typed value (number/bool preserved).
  const exact = /^\$input(?:\.([A-Za-z_][A-Za-z0-9_]*))+$/.exec(str);
  if (exact) {
    return readInputPath(str.slice("$input.".length), input);
  }
  // Embedded: replace `$input.foo` segments; `$$` → `$`.
  return str.replace(/\$\$|\$input(?:\.[A-Za-z_][A-Za-z0-9_]*)+/g, (match) => {
    if (match === "$$") return "$";
    const path = match.slice("$input.".length);
    const v = readInputPath(path, input);
    return v == null ? "" : String(v);
  });
}

function readInputPath(path, input) {
  const parts = String(path).split(".").filter(Boolean);
  if (parts.length === 0) {
    throw err("bindRecipeInput: empty $input path", "RECIPE_INPUT_PATH");
  }
  let cur = input;
  for (const part of parts) {
    if (!isObject(cur) || !Object.prototype.hasOwnProperty.call(cur, part)) {
      throw err(`bindRecipeInput: missing input path ${parts.join(".")}`, "RECIPE_INPUT_PATH");
    }
    cur = cur[part];
  }
  return cur;
}

/**
 * Validate params against a minimal JSON-schema-like inputSchema (PR1 subset).
 * Supports: type object, required[], properties{type,minLength,maxLength,minimum,maximum}, additionalProperties:false.
 *
 * @param {object|null|undefined} schema
 * @param {object} params
 */
export function validateRecipeInputParams(schema, params) {
  if (schema == null) {
    if (params != null && (!isObject(params) || Object.keys(params).length > 0)) {
      throw err("recipe has no inputSchema but params were provided", "RECIPE_INPUT_UNEXPECTED");
    }
    return {};
  }
  if (!isObject(schema)) throw err("inputSchema must be an object", "RECIPE_INPUT_SCHEMA");
  if (!isObject(params)) throw err("params must be an object", "RECIPE_INPUT_INVALID");
  if (schema.type != null && schema.type !== "object") {
    throw err("inputSchema.type must be object", "RECIPE_INPUT_SCHEMA");
  }
  const props = isObject(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(params)) {
      if (!Object.prototype.hasOwnProperty.call(props, key)) {
        throw err(`params.${key} is not allowed`, "RECIPE_INPUT_ADDITIONAL");
      }
    }
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(params, key)) {
      throw err(`params.${key} is required`, "RECIPE_INPUT_REQUIRED");
    }
  }
  for (const [key, propSchema] of Object.entries(props)) {
    if (!Object.prototype.hasOwnProperty.call(params, key)) continue;
    assertParamProperty(key, params[key], propSchema);
  }
  return { ...params };
}

function assertParamProperty(key, value, propSchema) {
  if (!isObject(propSchema)) return;
  const t = propSchema.type;
  if (t === "string") {
    if (typeof value !== "string") throw err(`params.${key} must be string`, "RECIPE_INPUT_TYPE");
    if (propSchema.minLength != null && value.length < propSchema.minLength) {
      throw err(`params.${key} shorter than minLength`, "RECIPE_INPUT_RANGE");
    }
    if (propSchema.maxLength != null && value.length > propSchema.maxLength) {
      throw err(`params.${key} exceeds maxLength`, "RECIPE_INPUT_RANGE");
    }
  } else if (t === "integer") {
    if (!Number.isInteger(value)) throw err(`params.${key} must be integer`, "RECIPE_INPUT_TYPE");
    if (propSchema.minimum != null && value < propSchema.minimum) {
      throw err(`params.${key} below minimum`, "RECIPE_INPUT_RANGE");
    }
    if (propSchema.maximum != null && value > propSchema.maximum) {
      throw err(`params.${key} above maximum`, "RECIPE_INPUT_RANGE");
    }
  } else if (t === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw err(`params.${key} must be number`, "RECIPE_INPUT_TYPE");
    }
    if (propSchema.minimum != null && value < propSchema.minimum) {
      throw err(`params.${key} below minimum`, "RECIPE_INPUT_RANGE");
    }
    if (propSchema.maximum != null && value > propSchema.maximum) {
      throw err(`params.${key} above maximum`, "RECIPE_INPUT_RANGE");
    }
  } else if (t === "boolean") {
    if (typeof value !== "boolean") throw err(`params.${key} must be boolean`, "RECIPE_INPUT_TYPE");
  }
}

/**
 * Evaluate one PR1 assertion against an observation bundle.
 * Observation shape (any subset):
 *   { package?, activity?, focus?: { package?, activity? }, dumpXml?, text?, resourceIds? }
 *
 * @param {object|string} assertion
 * @param {object} observation
 * @returns {{ ok: boolean, type: string, message?: string }}
 */
export function evaluateRecipeAssertion(assertion, observation = {}) {
  const a = typeof assertion === "string"
    ? { type: "textExists", value: assertion }
    : assertion;
  if (!isObject(a) || !isNonEmptyString(a.type)) {
    return { ok: false, type: "unknown", message: "assertion must be string or {type,...}" };
  }
  const type = String(a.type).trim();
  const obs = isObject(observation) ? observation : {};
  const pkg = obs.package ?? obs.focus?.package ?? null;
  const activity = obs.activity ?? obs.focus?.activity ?? null;
  const dumpXml = typeof obs.dumpXml === "string" ? obs.dumpXml : "";
  const blob = `${dumpXml}\n${obs.text ?? ""}`;

  switch (type) {
    case "packageEquals": {
      const expected = String(a.value ?? a.package ?? "").trim();
      if (!expected) return { ok: false, type, message: "packageEquals requires value" };
      if (pkg == null) return { ok: false, type, message: "observation missing package" };
      return pkg === expected
        ? { ok: true, type }
        : { ok: false, type, message: `package ${pkg} !== ${expected}` };
    }
    case "activityContains": {
      const needle = String(a.value ?? a.activity ?? "").trim();
      if (!needle) return { ok: false, type, message: "activityContains requires value" };
      if (activity == null) return { ok: false, type, message: "observation missing activity" };
      return String(activity).includes(needle)
        ? { ok: true, type }
        : { ok: false, type, message: `activity ${activity} missing ${needle}` };
    }
    case "activityMatches": {
      const pattern = String(a.value ?? a.pattern ?? "").trim();
      if (!pattern) return { ok: false, type, message: "activityMatches requires value" };
      if (activity == null) return { ok: false, type, message: "observation missing activity" };
      let re;
      try {
        re = new RegExp(pattern);
      } catch (e) {
        return { ok: false, type, message: `invalid regex: ${e.message}` };
      }
      return re.test(String(activity))
        ? { ok: true, type }
        : { ok: false, type, message: `activity ${activity} !~ /${pattern}/` };
    }
    case "textExists": {
      const needle = String(a.value ?? a.text ?? "").trim();
      if (!needle) return { ok: false, type, message: "textExists requires value" };
      return blob.includes(needle)
        ? { ok: true, type }
        : { ok: false, type, message: `text not found: ${needle}` };
    }
    case "resourceIdExists": {
      const rid = String(a.value ?? a.resourceId ?? "").trim();
      if (!rid) return { ok: false, type, message: "resourceIdExists requires value" };
      const hit = dumpXml.includes(`resource-id="${rid}"`)
        || dumpXml.includes(`resource-id='${rid}'`)
        || (Array.isArray(obs.resourceIds) && obs.resourceIds.includes(rid));
      return hit
        ? { ok: true, type }
        : { ok: false, type, message: `resource-id not found: ${rid}` };
    }
    default:
      return { ok: false, type, message: `unsupported assertion type: ${type}` };
  }
}

/**
 * @param {Array<object|string>} assertions
 * @param {object} observation
 * @returns {{ ok: boolean, results: object[] }}
 */
export function evaluateRecipeAssertions(assertions, observation = {}) {
  const list = Array.isArray(assertions) ? assertions : [];
  const results = list.map((a) => evaluateRecipeAssertion(a, observation));
  return { ok: results.every((r) => r.ok), results };
}

/**
 * Validate recipe primitive steps.
 * @param {unknown} steps
 * @returns {{ ok: true, steps: object[] }}
 * @throws on unknown kind / bad shape / bad params
 */
export function validateRecipeSteps(steps) {
  if (!Array.isArray(steps)) {
    throw err("steps must be an array");
  }
  if (steps.length === 0) {
    throw err("steps must be a non-empty array");
  }

  const normalized = [];
  const seenIds = new Set();

  for (let i = 0; i < steps.length; i++) {
    const raw = steps[i];
    if (!isObject(raw)) throw err(`steps[${i}] must be an object`);

    const id = isNonEmptyString(raw.id) ? String(raw.id).trim() : `step_${i + 1}`;
    if (seenIds.has(id)) throw err(`duplicate step id: ${id}`);
    seenIds.add(id);

    const kind = raw.kind;
    if (!isNonEmptyString(kind)) throw err(`step ${id}: kind is required`);
    if (!PRIMITIVE_SET.has(kind)) {
      throw err(`step ${id}: kind "${kind}" is not in whitelist (${RECIPE_PRIMITIVE_KINDS.join(", ")})`);
    }

    const params = validateParamsForKind(kind, raw.params, id);

    let timeoutMs = null;
    if (raw.timeoutMs != null) {
      if (!Number.isInteger(raw.timeoutMs) || raw.timeoutMs < 0) {
        throw err(`step ${id}: timeoutMs must be a non-negative integer`);
      }
      timeoutMs = raw.timeoutMs;
    }

    const preAssertions = assertAssertions(raw.preAssertions, "preAssertions", id);
    const postAssertions = assertAssertions(raw.postAssertions, "postAssertions", id);

    let restore = null;
    if (raw.restore != null) {
      if (typeof raw.restore === "boolean") {
        restore = { required: raw.restore };
      } else if (isObject(raw.restore)) {
        restore = { ...raw.restore };
      } else {
        throw err(`step ${id}: restore must be boolean or object`);
      }
    }

    // Reject unknown top-level keys beyond the documented step shape (keep extensibility low).
    const allowed = new Set([
      "id",
      "kind",
      "params",
      "timeoutMs",
      "preAssertions",
      "postAssertions",
      "restore",
    ]);
    for (const key of Object.keys(raw)) {
      if (!allowed.has(key)) {
        throw err(`step ${id}: unknown field "${key}"`);
      }
    }

    normalized.push({
      id,
      kind,
      params,
      ...(timeoutMs != null ? { timeoutMs } : {}),
      ...(preAssertions.length ? { preAssertions } : {}),
      ...(postAssertions.length ? { postAssertions } : {}),
      ...(restore ? { restore } : {}),
    });
  }

  return { ok: true, steps: normalized };
}

/**
 * Resolve recipe executor into a typed plan descriptor (no I/O).
 * Phase 1 default: capabilityId wrapper. Phase 5: primitive_steps.
 *
 * @param {object} executor
 * @returns {{ kind: "capability_wrapper"|"primitive_steps", ... }}
 */
export function resolveRecipeExecutor(executor) {
  if (!isObject(executor)) {
    throw err("executor must be an object");
  }
  const rawKind = executor.kind == null ? null : String(executor.kind).trim();
  if (rawKind && !EXECUTOR_KINDS.includes(rawKind)) {
    throw err(`executor.kind "${rawKind}" is not supported`);
  }

  if (rawKind === "primitive_steps") {
    const validated = validateRecipeSteps(executor.steps);
    return {
      kind: "primitive_steps",
      steps: validated.steps,
    };
  }

  // Phase 1 default — capability wrapper (kind omitted, "capability", or "capability_wrapper")
  const capabilityId = executor.capabilityId || executor.capability;
  if (!isNonEmptyString(capabilityId)) {
    throw err("executor.capabilityId is required for capability wrapper recipes");
  }
  const paramsTemplate =
    executor.paramsTemplate && isObject(executor.paramsTemplate)
      ? { ...executor.paramsTemplate }
      : {};
  return {
    kind: "capability_wrapper",
    capabilityId: String(capabilityId).trim(),
    paramsTemplate,
  };
}

/**
 * Content-addressed descriptor hash for a sealed recipe spec.
 * Hashes the canonical (sorted-key) JSON of recipeId + revision + status +
 * eligibleAliases + executor (kind + primitive steps' id/kind/params/assertions)
 * + inputSchema. Used to bind a Runner receipt to an exact, server-sealed spec
 * so a client cannot silently mutate a live recipe's coordinates or steps.
 * @param {object} recipe
 * @returns {string} "rh_" + 24 hex chars
 */
export function computeDescriptorHash(recipe) {
  if (!isObject(recipe)) throw err("computeDescriptorHash: recipe must be an object");
  const exec = isObject(recipe.executor) ? recipe.executor : {};
  const stepsCanonical = Array.isArray(exec.steps)
    ? exec.steps.map((s) => ({
        id: s?.id ?? null,
        kind: s?.kind ?? null,
        params: s?.params ?? null,
        preAssertions: s?.preAssertions ?? null,
        postAssertions: s?.postAssertions ?? null,
      }))
    : null;
  const canonical = {
    recipeId: recipe.recipeId ?? null,
    revision: recipe.revision ?? null,
    status: recipe.status ?? null,
    eligibleAliases: Array.isArray(recipe.eligibleAliases) ? recipe.eligibleAliases : null,
    executor: { kind: exec.kind ?? null, steps: stepsCanonical, capabilityId: exec.capabilityId ?? null },
    inputSchema: recipe.inputSchema ?? null,
  };
  const json = JSON.stringify(canonical, (_, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = v[k];
      return out;
    }
    return v;
  });
  return "rh_" + createHash("sha256").update(json).digest("hex").slice(0, 24);
}

function sessionLooksLeased(session) {
  if (!isObject(session)) return false;
  if (session.leased === true) return true;
  if (isNonEmptyString(session.leaseId)) return true;
  if (isNonEmptyString(session.lease?.id)) return true;
  if (session.handle && isObject(session.handle) && isNonEmptyString(session.handle.leaseId)) {
    return true;
  }
  // Explicit control-plane session id alone is not enough without lease evidence,
  // but accept sessionId + leaseState/status free|held markers used in tests/stubs.
  if (isNonEmptyString(session.sessionId) && (session.leaseState || session.leaseStatus)) {
    const st = String(session.leaseState || session.leaseStatus).toLowerCase();
    return st === "held" || st === "acquired" || st === "leased" || st === "active";
  }
  return false;
}

/**
 * Execute (or plan) a primitive_steps recipe inside a control-plane session.
 *
 * LIVE EXECUTION CONTRACT:
 *   Live device touches require a leased session obtained via the control plane
 *   (`job submit` / `session acquire` with a visible lease). This stub never
 *   opens GatewayOperator / ADB / lab 22222 by itself.
 *
 * @param {{
 *   session?: object|null,
 *   steps: object[],
 *   evidenceCollector?: object|null,
 *   live?: boolean,
 *   handlers?: Record<string, Function>|null,
 * }} opts
 */
export function executeRecipeInSession({
  session = null,
  steps,
  evidenceCollector = null,
  live = false,
  handlers = null,
} = {}) {
  const validated = validateRecipeSteps(steps);
  const plannedCalls = validated.steps.map((step, index) => ({
    index,
    id: step.id,
    kind: step.kind,
    params: step.params,
    timeoutMs: step.timeoutMs ?? null,
    preAssertions: step.preAssertions ?? [],
    postAssertions: step.postAssertions ?? [],
    restore: step.restore ?? null,
    // Stable call descriptor for future live runners / evidence spool.
    call: {
      op: step.kind,
      args: step.params,
    },
  }));

  const evidenceNotes = [];
  if (evidenceCollector && typeof evidenceCollector.note === "function") {
    evidenceCollector.note({
      event: "recipe_plan",
      stepCount: plannedCalls.length,
      live: Boolean(live),
    });
    evidenceNotes.push("note");
  } else if (evidenceCollector && typeof evidenceCollector.push === "function") {
    evidenceCollector.push({
      event: "recipe_plan",
      stepCount: plannedCalls.length,
      live: Boolean(live),
    });
    evidenceNotes.push("push");
  }

  if (!live) {
    return {
      ok: true,
      mode: "plan",
      live: false,
      steps: validated.steps,
      plannedCalls,
      evidenceNotes,
      message:
        "plan-only: set live:true with a leased control-plane session to execute; device is not touched",
    };
  }

  if (!sessionLooksLeased(session)) {
    return {
      ok: false,
      mode: "rejected",
      live: false,
      code: "LEASED_SESSION_REQUIRED",
      steps: validated.steps,
      plannedCalls,
      evidenceNotes,
      message:
        "live execution requires a leased session via control plane (session.leaseId / leased handle); refusing device I/O",
    };
  }

  const handlerMap = handlers && isObject(handlers) ? handlers : null;
  if (!handlerMap) {
    // Scaffolding: validated + authorized, but no handlers → still no device I/O.
    return {
      ok: true,
      mode: "live_stub",
      live: false,
      code: "LIVE_HANDLERS_NOT_WIRED",
      steps: validated.steps,
      plannedCalls,
      session: {
        sessionId: session.sessionId ?? session.id ?? null,
        leaseId: session.leaseId ?? session.lease?.id ?? session.handle?.leaseId ?? null,
      },
      evidenceNotes,
      message:
        "live flag + leased session accepted, but primitive handlers are not wired yet (scaffolding; no device I/O)",
    };
  }

  const results = [];
  for (const call of plannedCalls) {
    const fn = handlerMap[call.kind];
    if (typeof fn !== "function") {
      return {
        ok: false,
        mode: "live_partial",
        live: false,
        code: "HANDLER_MISSING",
        failedStepId: call.id,
        steps: validated.steps,
        plannedCalls,
        results,
        message: `no handler for primitive kind ${call.kind}`,
      };
    }
    // Handlers are caller-provided; interpreter does not invent device clients.
    const result = fn({
      session,
      step: validated.steps[call.index],
      call: call.call,
      evidenceCollector,
    });
    results.push({ id: call.id, kind: call.kind, result });
  }

  return {
    ok: true,
    mode: "live",
    live: true,
    steps: validated.steps,
    plannedCalls,
    results,
    evidenceNotes,
    message: "executed via injected handlers under leased session",
  };
}

/**
 * Wire recipe executor → plan/execute path.
 * - `primitive_steps` → validateRecipeSteps + executeRecipeInSession (plan-only by default)
 * - capability wrapper (Phase 1 default) → structured callCapability plan; no device I/O
 *
 * Live device work still requires leased control-plane session + live:true + handlers
 * (see executeRecipeInSession contract).
 *
 * @param {object} executor
 * @param {{ session?: object|null, evidenceCollector?: object|null, live?: boolean, handlers?: object|null }} [opts]
 */
export function planRecipeFromExecutor(executor, opts = {}) {
  const resolved = resolveRecipeExecutor(executor);
  if (resolved.kind === "primitive_steps") {
    return {
      ...executeRecipeInSession({
        session: opts.session ?? null,
        steps: resolved.steps,
        evidenceCollector: opts.evidenceCollector ?? null,
        live: Boolean(opts.live),
        handlers: opts.handlers ?? null,
      }),
      executorKind: "primitive_steps",
    };
  }

  const plannedCalls = [
    {
      index: 0,
      id: "call_capability",
      kind: "callCapability",
      params: {
        capabilityId: resolved.capabilityId,
        params: resolved.paramsTemplate,
      },
      timeoutMs: null,
      preAssertions: [],
      postAssertions: [],
      restore: null,
      call: {
        op: "callCapability",
        args: {
          capabilityId: resolved.capabilityId,
          params: resolved.paramsTemplate,
        },
      },
    },
  ];

  return {
    ok: true,
    mode: "plan",
    live: false,
    executorKind: "capability_wrapper",
    capabilityId: resolved.capabilityId,
    paramsTemplate: resolved.paramsTemplate,
    plannedCalls,
    message:
      "capability_wrapper plan (Phase 1 default): submit via control-plane job/session; interpreter does not touch device",
  };
}
