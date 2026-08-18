import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_XHS_COMPOSE_CATALOG = resolve(HERE, "../../contracts/xhs-compose-actions.v1.json");
export const CATALOG_SCHEMA_ID = "xhs.compose-action-catalog.v1";
export const PLAN_SCHEMA_ID = "xhs.compose-plan.v1";

const ACTION_ID_RE = /^[a-z][a-z0-9_]*$/;
const ALIAS_RE = /^0[1-4]$/;
const ENTRIES = new Set(["formal_job", "explorer_session", "implemented_task", "human_gate"]);
const MATURITY = new Set(["implemented", "candidate", "gated"]);
const NEGATION_RE = /(?:不要|不用|无需|禁止|别|不)$/;

function object(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex");
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function positiveIndex(text, aliases) {
  const lower = text.toLowerCase();
  let best = -1;
  for (const raw of aliases || []) {
    const alias = String(raw).toLowerCase();
    let from = 0;
    while (alias && from < lower.length) {
      const index = lower.indexOf(alias, from);
      if (index < 0) break;
      const prefix = lower.slice(Math.max(0, index - 4), index);
      if (!NEGATION_RE.test(prefix) && (best < 0 || index < best)) best = index;
      from = index + alias.length;
    }
  }
  return best;
}

function countAfter(text, index, aliases, fallback = 1) {
  if (index < 0) return fallback;
  const alias = (aliases || [])
    .map(String)
    .filter((value) => text.toLowerCase().startsWith(value.toLowerCase(), index))
    .sort((a, b) => b.length - a.length)[0] || "";
  const tail = text.slice(index + alias.length, index + alias.length + 16);
  const match = tail.match(/^\s*(?:最多|至多|大约|约)?\s*(\d+)\s*(?:条|次|个|篇)?/);
  return match ? Math.max(1, Number(match[1])) : fallback;
}

export function parseAliases(goal, override = null) {
  if (override != null) {
    const values = Array.isArray(override) ? override : String(override).split(/[,，、\s]+/);
    const aliases = [...new Set(values.map((value) => String(value).padStart(2, "0")))];
    if (!aliases.length || aliases.some((alias) => !ALIAS_RE.test(alias))) throw new Error("aliases must be a subset of 01,02,03,04");
    return aliases;
  }
  const text = String(goal || "");
  const found = [];
  for (const match of text.matchAll(/0([1-4])/g)) found.push(`0${match[1]}`);
  for (const match of text.matchAll(/(?:设备|机器|别名|alias)\s*([1-4])\b|\b([1-4])\s*号机/g)) {
    found.push(`0${match[1] || match[2]}`);
  }
  return [...new Set(found)];
}

function extractDurationMinutes(text, override) {
  if (override != null) return Math.max(1, Number(override));
  for (const match of text.matchAll(/(\d+)\s*分钟/g)) {
    const prefix = text.slice(Math.max(0, match.index - 2), match.index);
    if (!/每\s*$/.test(prefix)) return Math.max(1, Number(match[1]));
  }
  return null;
}

function extractIntervalSec(text, override) {
  if (override != null) return Math.max(60, Number(override));
  const minutes = text.match(/每\s*(\d+)\s*分钟/);
  if (minutes) return Math.max(60, Number(minutes[1]) * 60);
  const seconds = text.match(/每\s*(\d+)\s*秒/);
  if (seconds) return Math.max(60, Number(seconds[1]));
  return 60;
}

function extractSearchKeyword(text, override) {
  if (override) return normalizeText(override);
  const quoted = text.match(/(?:搜索|搜一下|搜小红书)\s*[“"'‘「『]([^”"'’」』]+)[”"'’」』]/);
  if (quoted) return normalizeText(quoted[1]);
  const plain = text.match(/(?:搜索|搜一下|搜小红书)\s*([^，,。；;]+?)(?=\s*(?:然后|并且|并|再|后|，|,|。|；|;|$))/);
  return plain ? normalizeText(plain[1]).replace(/[”"'」』]+$/, "") : null;
}

function extractInteger(text, pattern, fallback = null) {
  const match = text.match(pattern);
  return match ? Math.max(1, Number(match[1])) : fallback;
}

function commandTemplate(action, params) {
  const session = "--alias <alias> --session-file <same-session-file>";
  const dry = params.locateOnly ? " --dry-run" : "";
  switch (action.actionId) {
    case "observe_feed":
      return "formal job: xhs.observe.feed";
    case "browse_feed":
      return `node ops/swipe.mjs ${session} --up  # repeat ${params.swipeCount || "bounded"}`;
    case "search_notes":
      return `node ops/xhs-search.mjs ${session} --keyword ${JSON.stringify(params.keyword || "<required>")} --pages ${params.pages || 1}`;
    case "like_note":
      return `node ops/xhs-like-one.mjs ${session}${dry}`;
    case "collect_note":
      return `node ops/xhs-collect-one.mjs ${session}${dry}`;
    case "follow_author":
      return `node ops/xhs-follow-one.mjs ${session}${dry}`;
    case "engage_note":
      return `node ops/xhs-engage-one.mjs ${session} --like --collect${dry}`;
    case "publish_edit_dry_run":
      return "node ops/xw-task.mjs run --task \"小红书发布编辑页 dry-run\"";
    case "return_xhs_home":
      return `node ops/launch-app.mjs ${session} --package com.xingin.xhs`;
    default:
      return null;
  }
}

export function validateXhsComposeCatalog(catalog) {
  const errors = [];
  if (!object(catalog)) return [{ path: "$", message: "catalog must be an object" }];
  if (catalog.schemaId !== CATALOG_SCHEMA_ID || catalog.schemaVersion !== 1) errors.push({ path: "schema", message: "must be xhs.compose-action-catalog.v1 version 1" });
  if (!Array.isArray(catalog.actions)) return [...errors, { path: "actions", message: "must be an array" }];
  const ids = new Set();
  for (const [index, action] of catalog.actions.entries()) {
    const path = `actions[${index}]`;
    if (!object(action)) { errors.push({ path, message: "must be an object" }); continue; }
    if (!ACTION_ID_RE.test(action.actionId || "")) errors.push({ path: `${path}.actionId`, message: "invalid" });
    if (ids.has(action.actionId)) errors.push({ path: `${path}.actionId`, message: "must be unique" });
    ids.add(action.actionId);
    if (!ENTRIES.has(action.entry)) errors.push({ path: `${path}.entry`, message: "invalid" });
    if (!MATURITY.has(action.maturity)) errors.push({ path: `${path}.maturity`, message: "invalid" });
    if (!Array.isArray(action.intentAliases) || !action.intentAliases.length) errors.push({ path: `${path}.intentAliases`, message: "required" });
    if (!Array.isArray(action.effects)) errors.push({ path: `${path}.effects`, message: "must be an array" });
    if (action.entry === "explorer_session") {
      if (action.capabilityId !== "xiaowei.explorer.primitive") errors.push({ path: `${path}.capabilityId`, message: "must use Explorer primitive" });
      if (!action.runner?.requiresSessionFile) errors.push({ path: `${path}.runner.requiresSessionFile`, message: "must be true" });
      for (const script of action.runner?.scripts || []) {
        if (!/^ops\/[a-zA-Z0-9._-]+\.mjs$/.test(script)) errors.push({ path: `${path}.runner.scripts`, message: `unsafe script ${script}` });
      }
    }
    if (action.directRun === true && action.maturity !== "implemented") errors.push({ path: `${path}.directRun`, message: "requires implemented maturity" });
  }
  return errors;
}

export function loadXhsComposeCatalog({ path = DEFAULT_XHS_COMPOSE_CATALOG } = {}) {
  if (!existsSync(path)) throw new Error(`XHS compose catalog missing: ${path}`);
  const catalog = JSON.parse(readFileSync(path, "utf8"));
  const errors = validateXhsComposeCatalog(catalog);
  if (errors.length) throw new Error(`XHS compose catalog invalid: ${JSON.stringify(errors)}`);
  return structuredClone(catalog);
}

function actionParams(actionId, context) {
  const { text, action, index, overrides, locateOnly, durationMinutes, intervalSec } = context;
  const count = countAfter(text, index, action.intentAliases, 1);
  if (actionId === "browse_feed") {
    return {
      durationMinutes: durationMinutes || 10,
      swipeCount: extractInteger(text, /下滑\s*(\d+)\s*次/, null),
      itemLimit: extractInteger(text, /浏览\s*(?:前)?\s*(\d+)\s*条/, null),
      intervalSec,
      locateOnly: true,
    };
  }
  if (actionId === "search_notes") {
    return {
      keyword: extractSearchKeyword(text, overrides.keyword),
      pages: extractInteger(text, /(?:搜索|搜一下|搜小红书)[^，,。；;]*?(\d+)\s*页/, 1),
      itemLimit: extractInteger(text, /(?:搜索|搜一下|搜小红书)[^，,。；;]*?(?:前)?\s*(\d+)\s*条/, null),
      locateOnly: true,
    };
  }
  if (["like_note", "collect_note", "follow_author", "engage_note", "comment_send", "dm_send", "publish_live"].includes(actionId)) {
    return { count, intervalSec, locateOnly };
  }
  if (actionId === "publish_edit_dry_run") {
    return {
      title: overrides.title || null,
      body: overrides.body || null,
      tags: Array.isArray(overrides.tags) ? overrides.tags : [],
      stayForAccept: true,
      exitNoSave: true,
    };
  }
  return {};
}

function addUnresolved(unresolved, code, actionId, message) {
  if (!unresolved.some((item) => item.code === code && item.actionId === actionId)) unresolved.push({ code, actionId, message });
}

export function compileXhsComposePlan({
  goal,
  catalog = loadXhsComposeCatalog(),
  aliases = null,
  keyword = null,
  durationMinutes = null,
  intervalSec = null,
  locateOnly = null,
  title = null,
  body = null,
  tags = [],
} = {}) {
  const text = normalizeText(goal);
  if (!text) throw new Error("goal is required");
  if (!/小红书|\bxhs\b/i.test(text) && /抖音|douyin|闲鱼|xianyu|微信|wechat|支付宝|alipay|微购|weigou/i.test(text)) {
    throw new Error("xhs-compose rejects goals that explicitly target another app");
  }
  const catalogErrors = validateXhsComposeCatalog(catalog);
  if (catalogErrors.length) throw new Error(`XHS compose catalog invalid: ${JSON.stringify(catalogErrors)}`);

  const requestedAliases = parseAliases(text, aliases);
  const locate = locateOnly == null
    ? /只(?:做)?(?:定位|检查)|不点击|不互动|dry[\s-]?run/i.test(text)
    : Boolean(locateOnly);
  const duration = extractDurationMinutes(text, durationMinutes);
  const interval = extractIntervalSec(text, intervalSec);
  const overrides = {
    keyword,
    title: title ? normalizeText(title) : null,
    body: body ? normalizeText(body) : null,
    tags: Array.isArray(tags) ? tags.map((value) => normalizeText(value).replace(/^#+/, "")).filter(Boolean) : [],
  };
  const safePublish = /停(?:在|到).*发布页|编辑页|不保存|退出不存|dry[\s-]?run|填(?:一篇|写)?[^，,。；;]*(?:标题|正文|话题)|添加话题/i.test(text);
  const livePublish = /真实发布|真发布|点击发布|直接发布|发布一篇|发笔记/i.test(text);
  const mentions = [];

  for (const action of catalog.actions) {
    let index = positiveIndex(text, action.intentAliases);
    if (action.actionId === "publish_edit_dry_run" && safePublish && index < 0) index = Math.max(0, text.search(/填|标题|正文|话题|发布页|编辑页/i));
    if (action.actionId === "publish_edit_dry_run" && !safePublish) index = -1;
    if (action.actionId === "publish_live" && !livePublish) index = -1;
    if (action.actionId === "comment_send" && /评论(?:框|入口|dry[\s-]?run)|只定位[^，,。；;]*评论/i.test(text)) index = -1;
    if (index >= 0) mentions.push({ action, index });
  }

  const unresolved = [];
  if (!mentions.length) addUnresolved(unresolved, "NO_SUPPORTED_ACTION", null, "没有识别到受支持的小红书动作");
  mentions.sort((a, b) => a.index - b.index || a.action.actionId.localeCompare(b.action.actionId));
  const home = mentions.find((item) => item.action.actionId === "return_xhs_home");
  const ordered = mentions.filter((item) => item !== home);
  if (home) ordered.push(home);

  const actions = ordered.map(({ action, index }, sequence) => {
    const params = actionParams(action.actionId, {
      text,
      action,
      index,
      overrides,
      locateOnly: locate,
      durationMinutes: duration,
      intervalSec: interval,
    });
    if (action.actionId === "search_notes" && !params.keyword) addUnresolved(unresolved, "SEARCH_KEYWORD_REQUIRED", action.actionId, "搜索动作缺少关键词");
    if (action.actionId === "publish_edit_dry_run" && !params.title && !params.body) addUnresolved(unresolved, "PUBLISH_CONTENT_REQUIRED", action.actionId, "发布编辑页 dry-run 至少需要 title 或 body");
    return {
      sequence,
      actionId: action.actionId,
      title: action.title,
      route: action.entry,
      maturity: action.maturity,
      params,
      capabilityId: action.capabilityId || null,
      taskTemplateId: action.taskTemplateId || null,
      skillRef: action.skillRef,
      scripts: [...(action.runner?.scripts || [])],
      commandTemplate: commandTemplate(action, params),
      effects: (action.effects || []).map((effect) => ({ ...effect })),
      limitations: [...(action.limitations || [])],
    };
  });

  const perAliasQuantities = {};
  for (const action of actions) {
    const units = action.params.locateOnly ? 0 : Math.max(1, Number(action.params.count || 1));
    for (const effect of action.effects) {
      perAliasQuantities[effect.effectId] = (perAliasQuantities[effect.effectId] || 0) + units * Number(effect.quantityPerUnit || 1);
    }
  }
  const aliasMultiplier = requestedAliases.length || 1;
  const quantities = Object.fromEntries(
    Object.entries(perAliasQuantities).map(([effectId, quantity]) => [effectId, quantity * aliasMultiplier]),
  );
  const hasHumanGate = actions.some((action) => action.route === "human_gate");
  const hasCandidate = actions.some((action) => action.route === "explorer_session" && action.maturity !== "implemented");
  const hasEffects = Object.values(quantities).some((quantity) => quantity > 0);
  const executionReady = unresolved.length === 0 && !hasHumanGate && !hasCandidate;
  const reason = unresolved.length
    ? "parameters_unresolved"
    : hasHumanGate
      ? "human_gate_required"
      : hasCandidate
        ? "xhs_compose_workflow_canary_required"
        : "delegatable_to_existing_formal_entry";
  const base = {
    schemaId: PLAN_SCHEMA_ID,
    schemaVersion: 1,
    goal: text,
    normalizedIntent: {
      appId: "xhs",
      functionId: actions.some((action) => action.actionId.includes("publish")) ? "publish" : "nurture",
      durationMinutes: duration,
      intervalSec: interval,
      locateOnly: locate,
    },
    placement: {
      aliases: requestedAliases,
      strategy: requestedAliases.length ? "fixed_aliases" : "resolve_ready_free_at_execution",
      maxAliases: aliasMultiplier,
      perDeviceConcurrency: 1,
    },
    execution: {
      planReady: unresolved.length === 0,
      executionReady,
      reason,
      sourceOnly: true,
      sessionStrategy: actions.some((action) => action.route === "explorer_session") ? "one_visible_session_per_alias" : "none",
      sharedTransport: "serialized_when_transportLock_trueSplit_false",
      closeoutRuns: 1,
    },
    actions,
    effectBudget: {
      perAliasQuantities,
      aliasMultiplier,
      quantities,
      maximumTotal: Object.values(quantities).reduce((sum, value) => sum + value, 0),
      requiresConfirmation: hasEffects || hasHumanGate,
      contentPublished: quantities.xhs_content_publish || 0,
      draftSaved: 0,
      paymentTransport: 0,
      finalCommit: false,
    },
    unresolved,
  };
  const planHash = sha256(base);
  return {
    ...base,
    planId: `xcp_${planHash.slice(0, 16)}`,
    planHash,
    createdAt: new Date().toISOString(),
  };
}

export function validateXhsComposePlan(plan) {
  const errors = [];
  if (!object(plan)) return [{ path: "$", message: "plan must be an object" }];
  if (plan.schemaId !== PLAN_SCHEMA_ID || plan.schemaVersion !== 1) errors.push({ path: "schema", message: "must be xhs.compose-plan.v1 version 1" });
  if (!/^xcp_[a-f0-9]{16}$/.test(plan.planId || "")) errors.push({ path: "planId", message: "invalid" });
  if (!/^[a-f0-9]{64}$/.test(plan.planHash || "")) errors.push({ path: "planHash", message: "invalid" });
  if (!normalizeText(plan.goal)) errors.push({ path: "goal", message: "required" });
  if (!Array.isArray(plan.actions)) errors.push({ path: "actions", message: "must be an array" });
  if (!Array.isArray(plan.unresolved)) errors.push({ path: "unresolved", message: "must be an array" });
  if (!object(plan.execution)) errors.push({ path: "execution", message: "required" });
  if (!object(plan.effectBudget)) errors.push({ path: "effectBudget", message: "required" });
  if (!errors.length) {
    const { planId: _planId, planHash: _planHash, createdAt: _createdAt, ...base } = plan;
    const expected = sha256(base);
    if (expected !== plan.planHash) errors.push({ path: "planHash", message: "does not match canonical plan content" });
    if (`xcp_${expected.slice(0, 16)}` !== plan.planId) errors.push({ path: "planId", message: "does not match planHash" });
  }
  return errors;
}

export function resolveSafePlanInput(raw, root) {
  const path = isAbsolute(String(raw || "")) ? resolve(String(raw)) : resolve(root, String(raw || ""));
  const rel = relative(resolve(root), path);
  if (!raw || !rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("plan input must remain inside the repository");
  return path;
}
