// M5-1 Task Router —— 确定性规则分类，无 LLM、无 IO、fail-closed。
// 输入：自然语言 goal（或结构化 goal）+ 已注册 skill catalog + 设备可用数。
// 输出：xw.orchestration.task-classification.v1。
import { createHash } from "node:crypto";

export const MAX_WORKERS = 4;

const FORBIDDEN_KEY = /lease|transport|payment|capabilityId|executor|rawCommand/i;
const SKILL_ID_PATTERN = /^[a-z0-9]+(\.[a-z0-9-]+)+$/;
const TASK_TYPES = Object.freeze(["search", "collection", "validation"]);
const ROLE_BY_TASK_TYPE = Object.freeze({ search: "search", collection: "collect", validation: "validate" });

const EXTERNAL_ACTION_RE = /发布|点赞|关注|私信|评论|收藏|转发|上传|下单|购买|删除|取消订单|退换|编辑资料|改昵称|发帖|提交(订单|表单)/i;
const SEARCH_RE = /(搜索|查找|查询|查一下|检索|对比|多源|信息源|全网|各平台)/i;
const COLLECT_RE = /(采集|收集|刷|浏览|首页|设备状态|状态采集|读取|快照|截图|每台|四台|各机)/i;
const VALIDATE_RE = /(验收|校验|核对|检查|确认|结果汇总|结果核对|是否.*成功|是否.*一致)/i;

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
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

function rejectForbiddenFields(value, path) {
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key)) codedError("TASK_FORBIDDEN_FIELD", `goal must not carry ${path}.${key}`);
    rejectForbiddenFields(nested, `${path}.${key}`);
  }
}

function normalizeCatalog(catalog) {
  if (!Array.isArray(catalog)) codedError("TASK_CATALOG_INVALID", "catalog must be an array");
  const seen = new Set();
  return catalog.map((entry) => {
    const skillId = String(entry?.skillId || "").trim();
    if (!SKILL_ID_PATTERN.test(skillId)) codedError("TASK_CATALOG_INVALID", `invalid catalog skillId: ${skillId || "<empty>"}`);
    if (seen.has(skillId)) codedError("TASK_CATALOG_INVALID", `duplicate catalog skillId: ${skillId}`);
    seen.add(skillId);
    const roles = Array.isArray(entry.roles) ? [...new Set(entry.roles)] : [];
    if (roles.some((role) => !["collect", "search", "validate"].includes(role))) {
      codedError("TASK_CATALOG_INVALID", `invalid role on ${skillId}`);
    }
    return { skillId, roles };
  });
}

function normalizedText(goal) {
  if (goal && typeof goal === "object") return String(goal.text ?? goal.goal ?? "").trim().toLowerCase();
  return String(goal || "").trim().toLowerCase();
}

function structuredType(goal) {
  if (!goal || typeof goal !== "object") return null;
  const value = goal.type ?? goal.taskType;
  return value == null ? null : String(value).trim().toLowerCase();
}

function parseAliases(text) {
  return [...new Set([...String(text).matchAll(/0[1-4](?![0-9])/g)].map((match) => match[0]))].sort();
}

function boundWorkers(devices) {
  const count = typeof devices === "number" ? devices : Array.isArray(devices) ? devices.length : 0;
  return Math.max(1, Math.min(MAX_WORKERS, Number.isFinite(count) ? Math.trunc(count) || 1 : 1));
}

function classification(fields) {
  return deepFreeze({ schemaId: "xw.orchestration.task-classification.v1", schemaVersion: 1, ...fields });
}

function needsHuman(reason) {
  return classification({
    taskType: "needs_human",
    parallel: false,
    workers: 1,
    strategy: "none",
    validatorRequired: false,
    sourceSkills: [],
    needsHumanReason: reason,
  });
}

function matchedTypes(text) {
  const matches = [];
  if (SEARCH_RE.test(text)) matches.push("search");
  if (COLLECT_RE.test(text)) matches.push("collection");
  if (VALIDATE_RE.test(text)) matches.push("validation");
  return matches;
}

/** Deterministic natural-language/structured goal classification. */
export function classifyTask({ goal, catalog = [], devices = 4 } = {}) {
  rejectForbiddenFields(goal && typeof goal === "object" ? goal : { goal }, "goal");
  const registered = normalizeCatalog(catalog);
  const text = normalizedText(goal);
  const explicitType = structuredType(goal);

  if (explicitType && !TASK_TYPES.includes(explicitType)) return needsHuman("unknown_structured_type");
  if (!text && !explicitType) return needsHuman("missing_goal");
  if (EXTERNAL_ACTION_RE.test(text)) return needsHuman("external_effect_not_allowed");

  const matches = text ? matchedTypes(text) : [];
  if (explicitType && matches.some((match) => match !== explicitType)) return needsHuman("ambiguous_goal");
  if (!explicitType && matches.length > 1) return needsHuman("ambiguous_goal");
  const taskType = explicitType || matches[0];
  if (!taskType) return needsHuman("unclassified_goal");

  const role = ROLE_BY_TASK_TYPE[taskType];
  const sourceSkills = registered.filter((entry) => entry.roles.includes(role)).map((entry) => entry.skillId).sort();
  if (sourceSkills.length === 0) return needsHuman(`no_registered_${role}_skill`);

  if (taskType === "validation") {
    return classification({
      taskType,
      parallel: false,
      workers: 1,
      strategy: "sequential_validate",
      validatorRequired: true,
      sourceSkills,
      needsHumanReason: null,
    });
  }

  const aliases = taskType === "collection" ? parseAliases(text) : [];
  return classification({
    taskType,
    parallel: true,
    workers: boundWorkers(devices),
    strategy: taskType === "search" ? "fan_out_reduce" : aliases.length ? "alias_fan_out_reduce" : "fan_out_collect",
    validatorRequired: true,
    sourceSkills,
    needsHumanReason: null,
  });
}

export function classificationHash(value) {
  return digest(value);
}
