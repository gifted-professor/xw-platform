import { compileXhsComposePlan, validateXhsComposePlan } from "./xhs-compose.mjs";

export const XHS_COMPOSE_CANARY_ACTIONS = Object.freeze([
  "browse_feed",
  "search_notes",
  "like_note",
  "collect_note",
  "follow_author",
]);

// Minimum seven length-4 trails that cover every directed transition among
// the five candidate actions. The live canary restores XHS home before each
// atom, so this proves orchestration-order compatibility, not raw page-to-page
// transition compatibility.
export const XHS_COMPOSE_PAIR_COVER = Object.freeze([
  Object.freeze(["browse_feed", "search_notes", "like_note", "collect_note"]),
  Object.freeze(["browse_feed", "like_note", "search_notes", "collect_note"]),
  Object.freeze(["browse_feed", "collect_note", "search_notes", "follow_author"]),
  Object.freeze(["search_notes", "browse_feed", "follow_author", "collect_note"]),
  Object.freeze(["collect_note", "follow_author", "like_note", "browse_feed"]),
  Object.freeze(["collect_note", "like_note", "follow_author", "browse_feed"]),
  Object.freeze(["collect_note", "browse_feed", "follow_author", "search_notes"]),
]);

const PHRASES = Object.freeze({
  browse_feed: "浏览并下滑信息流",
  search_notes: "搜索“夏季穿搭”",
  like_note: "点赞1条",
  collect_note: "收藏1条",
  follow_author: "关注1个作者",
});

export function directedPairs(sequence) {
  const pairs = [];
  for (let index = 0; index < sequence.length - 1; index += 1) {
    pairs.push(`${sequence[index]}>${sequence[index + 1]}`);
  }
  return pairs;
}

export function pairCoverage(sequences = XHS_COMPOSE_PAIR_COVER) {
  const expected = new Set();
  for (const left of XHS_COMPOSE_CANARY_ACTIONS) {
    for (const right of XHS_COMPOSE_CANARY_ACTIONS) {
      if (left !== right) expected.add(`${left}>${right}`);
    }
  }
  const covered = new Set(sequences.flatMap((sequence) => directedPairs(sequence)));
  return {
    expected: [...expected].sort(),
    covered: [...covered].sort(),
    missing: [...expected].filter((pair) => !covered.has(pair)).sort(),
    extra: [...covered].filter((pair) => !expected.has(pair)).sort(),
  };
}

export function distributeSequences(aliases, sequences = XHS_COMPOSE_PAIR_COVER) {
  if (!Array.isArray(aliases) || aliases.length === 0) throw new Error("at least one alias is required");
  const assignments = Object.fromEntries(aliases.map((alias) => [alias, []]));
  sequences.forEach((sequence, index) => assignments[aliases[index % aliases.length]].push([...sequence]));
  return assignments;
}

export function sequenceGoal(sequence, { keyword = "夏季穿搭" } = {}) {
  const phrases = sequence.map((actionId) => {
    if (!XHS_COMPOSE_CANARY_ACTIONS.includes(actionId)) throw new Error(`unsupported canary action ${actionId}`);
    if (actionId === "search_notes") return `搜索“${keyword}”`;
    return PHRASES[actionId];
  });
  return `小红书${phrases.join("，")}，只定位、不互动，最后回首页`;
}

export function compileCanarySequence(sequence, options = {}) {
  const goal = sequenceGoal(sequence, options);
  const plan = compileXhsComposePlan({ goal, locateOnly: true });
  const errors = validateXhsComposePlan(plan);
  const expectedOrder = [...sequence, "return_xhs_home"];
  const actualOrder = plan.actions.map((action) => action.actionId);
  if (errors.length) throw new Error(`compiled canary plan invalid: ${errors.join("; ")}`);
  if (JSON.stringify(actualOrder) !== JSON.stringify(expectedOrder)) {
    throw new Error(`compiled canary order mismatch: ${actualOrder.join(">")}`);
  }
  if (plan.unresolved.length > 0) throw new Error(`compiled canary has unresolved input: ${JSON.stringify(plan.unresolved)}`);
  if (plan.effectBudget.maximumTotal !== 0) throw new Error(`compiled canary effect budget is ${plan.effectBudget.maximumTotal}`);
  if (plan.execution.reason !== "xhs_compose_workflow_canary_required") {
    throw new Error(`unexpected execution reason ${plan.execution.reason}`);
  }
  return plan;
}

export function actionCommand(actionId, { alias, sessionFile, keyword = "夏季穿搭" } = {}) {
  const common = ["--alias", alias, "--session-file", sessionFile];
  if (actionId === "search_notes") {
    return ["ops/xhs-search.mjs", ...common, "--keyword", keyword, "--pages", "1"];
  }
  if (actionId === "like_note") return ["ops/xhs-like-one.mjs", ...common, "--dry-run"];
  if (actionId === "collect_note") return ["ops/xhs-collect-one.mjs", ...common, "--dry-run"];
  if (actionId === "follow_author") return ["ops/xhs-follow-one.mjs", ...common, "--dry-run"];
  if (actionId === "browse_feed") return null;
  throw new Error(`unsupported canary action ${actionId}`);
}

export function classifyXhsSurface({ focus = "", xml = "" } = {}) {
  const focusText = String(focus || "");
  const body = String(xml || "");
  if (!/com\.xingin\.xhs/i.test(focusText)) {
    return { safe: false, code: "UNKNOWN_PAGE", detail: focusText || "focus_missing" };
  }
  if (/Login|LoginActivity/i.test(focusText) || /登录小红书|手机号登录|短信登录|注册小红书/.test(body)) {
    return { safe: false, code: "LOGIN_WALL", detail: focusText };
  }
  if (/滑块验证|请输入验证码|短信验证码|安全验证|完成验证/.test(body)) {
    return { safe: false, code: "CAPTCHA", detail: "verification surface detected" };
  }
  if (/账号异常|操作频繁|互动受限|限制互动|你已被限制|存在风险/.test(body)) {
    return { safe: false, code: "RISK_CONTROL", detail: "risk-control surface detected" };
  }
  if (/青少年模式/.test(body)) {
    return { safe: false, code: "YOUTH_MODE", detail: "youth-mode surface detected" };
  }
  return { safe: true, code: "XHS_SURFACE_OK", detail: focusText };
}
