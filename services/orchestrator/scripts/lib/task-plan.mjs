/**
 * task-plan.mjs — compile natural-language goals into xhs.task-plan.v1
 *
 * Deterministic resolver. Foundation capabilities are passed in by callers or
 * loaded from the local, versioned catalog. No network/device I/O.
 */

import {
  loadFoundationCapabilities,
  locatorPolicyFor,
} from "./foundation-capabilities.mjs";

const L3_RE = /支付|转账|充值|approve|policy|付款|资金/i;
const REPAIR_RE = /\brepair\b|修复|查修|repair-inbox|清隔离|recover/i;
const EXPLORE_RE = /\bexplore\b|探索|未知|探路|scout/i;

function nowIso() {
  return new Date().toISOString();
}

function requiredParamsOf(inputSchema) {
  if (!inputSchema || typeof inputSchema !== "object") return [];
  if (Array.isArray(inputSchema.required)) return inputSchema.required.map(String);
  if (inputSchema.properties && typeof inputSchema.properties === "object") {
    return Object.entries(inputSchema.properties)
      .filter(([, v]) => v && v.required === true)
      .map(([k]) => k);
  }
  return [];
}

function extractParamHints(goal, keys) {
  const text = String(goal || "");
  const params = {};
  let missing = 0;
  for (const key of keys) {
    // crude NL extraction: --key value | key=value | "key": "value"
    const re = new RegExp(
      `(?:--${escapeRegExp(key)}\\s+(\\S+)|${escapeRegExp(key)}\\s*[=:]\\s*["']?([^\\s"',}]+))`,
      "i",
    );
    const m = text.match(re);
    if (m) {
      params[key] = m[1] || m[2];
    } else {
      missing += 1;
    }
  }
  return { params, missing };
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function capabilityTokens(id) {
  return String(id || "")
    .toLowerCase()
    .split(/[.\-_/:\s]+/)
    .filter((t) => t.length >= 3);
}

function keywordScore(goal, capabilityId) {
  const g = String(goal || "").toLowerCase();
  let score = 0;
  const appTokens = new Set(["xhs", "douyin", "xianyu", "wechat", "weigou", "xiaowei"]);
  for (const tok of capabilityTokens(capabilityId)) {
    if (appTokens.has(tok)) continue;
    if (g.includes(tok)) score += 1;
  }
  // App identity is enforced separately. These are action-semantic hints only;
  // an App name by itself must never manufacture a capability match.
  if (/观察|快照|observe|snapshot/i.test(g) && /observe/i.test(capabilityId)) score += 2;
  if (/搜索|search/i.test(g) && /search/i.test(capabilityId)) score += 2;
  if (/余额|balance/i.test(g) && /balance/i.test(capabilityId)) score += 2;
  if (/指标|metrics/i.test(g) && /metrics/i.test(capabilityId)) score += 2;
  if (/评论|comment/i.test(g) && /comment/i.test(capabilityId)) score += 2;
  if (/关注|follow/i.test(g) && /follow/i.test(capabilityId)) score += 2;
  if (/详情|detail/i.test(g) && /detail/i.test(capabilityId)) score += 2;
  if (/首页|信息流|feed/i.test(g) && /feed/i.test(capabilityId)) score += 2;
  if (/打开|进入|open/i.test(g) && /open/i.test(capabilityId)) score += 2;
  if (/采集|收集|collect/i.test(g) && /collect/i.test(capabilityId)) score += 2;
  return score;
}

export function inferTaskApp(goal) {
  const text = String(goal || "");
  if (/小红书|\bxhs\b/i.test(text)) return "xhs";
  if (/抖音|douyin/i.test(text)) return "douyin";
  if (/闲鱼|xianyu/i.test(text)) return "xianyu";
  if (/微信|wechat/i.test(text)) return "wechat";
  if (/微购|weigou/i.test(text)) return "weigou";
  if (/小薇|xiaowei|设备|网关/i.test(text)) return "xiaowei";
  return null;
}

function isImplementedRecipe(recipe) {
  const status = recipe?.status || recipe?.latest?.status;
  return status === "implemented";
}

function recipeAliases(recipe) {
  const spec = recipe?.spec || recipe?.latest?.spec || recipe;
  const aliases = spec?.intentAliases;
  return Array.isArray(aliases) ? aliases.map(String) : [];
}

function recipeAppId(recipe) {
  const spec = recipe?.spec || recipe?.latest?.spec || recipe || {};
  if (spec.appId) return String(spec.appId);
  const capabilityId = spec.executor?.capabilityId;
  return capabilityId ? String(capabilityId).split(".")[0] : null;
}

function matchRecipeByAlias(goal, recipes, targetApp = null) {
  const g = String(goal || "").toLowerCase();
  const published = (recipes || []).filter((recipe) =>
    isImplementedRecipe(recipe) && (!targetApp || recipeAppId(recipe) === targetApp),
  );
  let best = null;
  let bestScore = 0;
  for (const recipe of published) {
    for (const alias of recipeAliases(recipe)) {
      const a = alias.toLowerCase();
      if (!a) continue;
      if (g === a || g.includes(a) || a.includes(g.trim())) {
        const score = a.length;
        if (score > bestScore) {
          bestScore = score;
          best = recipe;
        }
      }
    }
  }
  return best;
}

function exactCapabilityMatch(goal, catalogCapabilities) {
  const g = String(goal || "").trim();
  if (!g) return null;
  // Prefer full-id token match
  for (const cap of catalogCapabilities || []) {
    const id = cap.id || cap.capabilityId;
    if (!id) continue;
    if (g === id || g.includes(id)) return cap;
  }
  return null;
}

function capabilityAppId(capability) {
  if (capability?.appId) return String(capability.appId);
  const id = capability?.id || capability?.capabilityId;
  return id ? String(id).split(".")[0] : null;
}

function keywordCapabilityMatch(goal, catalogCapabilities, targetApp = null) {
  let best = null;
  let bestScore = 0;
  for (const cap of catalogCapabilities || []) {
    const id = cap.id || cap.capabilityId;
    if (!id) continue;
    if (targetApp && capabilityAppId(cap) !== targetApp) continue;
    const score = keywordScore(goal, id);
    if (score > bestScore) {
      bestScore = score;
      best = cap;
    }
  }
  return bestScore >= 2 ? best : null;
}

/**
 * Compile a task plan from a natural-language goal.
 * @returns {object} xhs.task-plan.v1
 */
export function compileTaskPlan({
  goal,
  catalogCapabilities = [],
  recipes = [],
  foundationCapabilities = loadFoundationCapabilities(),
  mode,
} = {}) {
  const text = String(goal || "").trim();
  const createdAt = nowIso();
  const targetApp = inferTaskApp(text);
  const forceRepair = mode === "repair" || REPAIR_RE.test(text);
  const forceExplore = mode === "explore" || EXPLORE_RE.test(text);

  let modelTier = "L2";
  let resolverPath = "explore";
  let matched = { capabilityId: null, recipeId: null };
  let intent = "explore";
  let params = {};
  let steps = [];
  let evidenceRequirements = [
    "job terminal succeeded",
    "verification.ok !== false when required",
    "restoration.ok !== false when required",
  ];

  if (L3_RE.test(text)) {
    modelTier = "L3";
    resolverPath = "human_gate";
    intent = "policy_or_payment";
    steps = [
      {
        id: "step_human_gate",
        kind: "human",
        title: "L3 human confirmation required",
      },
    ];
    return {
      schemaId: "xhs.task-plan.v1",
      schemaVersion: 1,
      goal: text,
      intent,
      params,
      steps,
      modelTier,
      resolverPath,
      matched,
      targetApp,
      locatorPolicy: null,
      foundationDependencies: [],
      unresolvedDependencies: [],
      evidenceRequirements: [...evidenceRequirements, "human approval receipt"],
      createdAt,
    };
  }

  if (forceRepair) {
    modelTier = "L2";
    resolverPath = "repair";
    intent = "repair";
    steps = [{ id: "step_repair", kind: "repair", title: "Repair Inbox / recover path" }];
    return {
      schemaId: "xhs.task-plan.v1",
      schemaVersion: 1,
      goal: text,
      intent,
      params,
      steps,
      modelTier,
      resolverPath,
      matched,
      targetApp,
      locatorPolicy: null,
      foundationDependencies: [],
      unresolvedDependencies: [],
      evidenceRequirements,
      createdAt,
    };
  }

  // 1) exact capability id
  const exact = exactCapabilityMatch(text, catalogCapabilities);
  if (exact) {
    const capabilityId = exact.id || exact.capabilityId;
    matched = { capabilityId, recipeId: null };
    resolverPath = "exact_capability";
    intent = capabilityId;
    const required = requiredParamsOf(exact.inputSchema || exact.paramsSchema);
    const { params: extracted, missing } = extractParamHints(text, required);
    params = extracted;
    const implemented =
      exact.availability === "implemented" ||
      exact.status === "implemented" ||
      exact.policy?.availability === "implemented" ||
      exact.policy?.runnableAsJob === true ||
      exact.implemented === true ||
      // treat catalog entries without availability as implemented for L0/L1 scaffolding
      (exact.availability == null && exact.status == null && exact.policy?.availability == null);

    if (implemented && (required.length === 0 || missing === 0)) {
      modelTier = "L0";
    } else {
      modelTier = "L1";
    }
    steps = [
      {
        id: "step_capability",
        kind: "capability",
        capabilityId,
        params,
        title: `Run ${capabilityId}`,
      },
    ];
    return pack();
  }

  // 2) published / implemented recipe intentAliases
  const recipeHit = matchRecipeByAlias(text, recipes, targetApp);
  if (recipeHit) {
    const recipeId = recipeHit.recipeId || recipeHit.id || recipeHit.latest?.recipeId;
    const spec = recipeHit.spec || recipeHit.latest?.spec || {};
    const status = recipeHit.status || recipeHit.latest?.status;
    const executor = spec.executor && typeof spec.executor === "object" ? spec.executor : {};
    const isPrimitive = String(executor.kind || "") === "primitive_steps";
    matched = {
      capabilityId: isPrimitive ? null : executor.capabilityId || null,
      recipeId,
      executorKind: isPrimitive ? "primitive_steps" : "capability_wrapper",
    };
    resolverPath = "recipe_alias";
    intent = recipeAliases(recipeHit)[0] || recipeId;
    const required = requiredParamsOf(spec.inputSchema);
    const { params: extracted, missing } = extractParamHints(text, required);
    params = { ...extracted };
    if (!isPrimitive && executor.paramsTemplate && typeof executor.paramsTemplate === "object") {
      params = { ...executor.paramsTemplate, ...params };
    }
    if (status === "implemented" && (required.length === 0 || missing === 0)) {
      modelTier = "L0";
    } else if (status === "implemented" || status === "canary_only") {
      modelTier = missing > 0 ? "L1" : "L0";
    } else {
      modelTier = "L1";
    }
    if (isPrimitive) {
      steps = [
        {
          id: "step_recipe_primitives",
          kind: "primitive_steps",
          recipeId,
          steps: Array.isArray(executor.steps) ? executor.steps : [],
          params,
          title: `Run primitive recipe ${recipeId}`,
        },
      ];
    } else {
      steps = [
        {
          id: "step_recipe",
          kind: "recipe",
          recipeId,
          capabilityId: executor.capabilityId || null,
          params,
          title: `Run recipe ${recipeId}`,
        },
      ];
    }
    return pack();
  }

  // 3) capability keyword match
  const kw = keywordCapabilityMatch(text, catalogCapabilities, targetApp);
  if (kw) {
    const capabilityId = kw.id || kw.capabilityId;
    matched = { capabilityId, recipeId: null };
    resolverPath = "capability_keyword";
    intent = capabilityId;
    const required = requiredParamsOf(kw.inputSchema || kw.paramsSchema);
    const { params: extracted, missing } = extractParamHints(text, required);
    params = extracted;
    modelTier = required.length === 0 || missing === 0 ? "L0" : "L1";
    // keyword match without full param certainty → at least L1 when any required exist
    if (required.length > 0 && missing > 0) modelTier = "L1";
    steps = [
      {
        id: "step_capability",
        kind: "capability",
        capabilityId,
        params,
        title: `Run ${capabilityId}`,
      },
    ];
    return pack();
  }

  // 4) explore (L2) — default unknown / explicit explore
  modelTier = "L2";
  resolverPath = forceExplore ? "explore" : "explore";
  intent = forceExplore ? "explore" : "unknown";
  steps = [
    {
      id: "step_explore",
      kind: "explore",
      title: "Explorer preflight + screenshot/analyze",
    },
  ];
  return pack();

  function pack() {
    const locatorPolicy = locatorPolicyFor({
      appId: targetApp,
      steps,
      capabilities: foundationCapabilities,
    });
    const locatorStepIds = steps
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
      schemaId: "xhs.task-plan.v1",
      schemaVersion: 1,
      goal: text,
      intent,
      params,
      steps,
      modelTier,
      resolverPath,
      matched,
      targetApp,
      locatorPolicy,
      foundationDependencies,
      unresolvedDependencies,
      evidenceRequirements,
      createdAt,
    };
  }
}
