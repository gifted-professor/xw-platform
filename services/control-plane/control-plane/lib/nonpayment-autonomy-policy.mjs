// nonpayment-autonomy-policy.mjs — REX Phase 4 §6：非支付自治策略
//
// 核心论点（REX-FREEDOM）：非支付一律自由，没有任何 policy 死锁；唯一硬闸是真实
// 资金 final commit。本策略把每个非支付输入映到一个 verdict，verdict 集合（§6.2）：
//   dispatch_known / dispatch_explorer / queue_resource / retry_technical /
//   defer_branch_technical / reconcile_effect / wait_financial_commit
// 非支付绝不得得到 approval_required/unsupported/blocked。只有 financial_commit →
// wait_financial_commit（humanApprovalRequired + paymentHold）。
//
// 默认 effectiveDecisionSource="shadow"：Phase 4 新策略只在 shadow 计算，legacy 仍
// 负责实际执行，不改 adapter 次数、不碰手机（§6.1）。调用方可在切流时传 "deployed-runtime"。
//
// 输出符合 control-plane/schema/nonpayment-autonomy.schema.json（schema 是真理之源）。

const SCHEMA_ID = "xhs.nonpayment-autonomy.v1";
// REX Phase 6 B: 暴露给 health/manifest 的运行时策略版本（schema const 单一来源）。
export const RUNTIME_POLICY_VERSION = "xhs.nonpayment-autonomy.v1";

export function evaluateNonpaymentAutonomy(input = {}, options = {}) {
  const actionClass = input.actionClass ?? "unknown";
  const effectState = input.effectState ?? null;
  const knownCapability = input.knownCapability === true;
  const resourceAvailable = input.resourceAvailable !== false; // 缺省视为可用
  const effectiveDecisionSource = options.effectiveDecisionSource === "deployed-runtime" ? "deployed-runtime" : "shadow";

  // 1. 唯一硬闸：资金 final commit → 等人类确认
  if (actionClass === "financial_commit") {
    return verdict(actionClass, "wait_financial_commit", true, true, "FINAL_PAYMENT_HUMAN_GATE", effectiveDecisionSource);
  }

  // 2. ambiguous 非支付 effect：只冻结该 effect 做 reconciliation，不冻结整个任务、不升级审批
  if (effectState === "ambiguous") {
    return verdict(actionClass, "reconcile_effect", false, false, "AMBIGUOUS_EFFECT_RECONCILE", effectiveDecisionSource);
  }

  // 3. 资源忙（lease busy）：入队/重路由，不让派发者反复申请
  if (!resourceAvailable) {
    return verdict(actionClass, "queue_resource", false, false, "RESOURCE_BUSY_QUEUE", effectiveDecisionSource);
  }

  // 4. 已知 capability：直接派发
  if (knownCapability) {
    return verdict(actionClass, "dispatch_known", false, false, "KNOWN_CAPABILITY_DISPATCH", effectiveDecisionSource);
  }

  // 5. unknown / no skill / no route：自动转 Explorer，不拒绝
  return verdict(actionClass, "dispatch_explorer", false, false, "UNKNOWN_ROUTE_TO_EXPLORER", effectiveDecisionSource);
}

function verdict(actionClass, decision, humanApprovalRequired, paymentHold, reasonCode, effectiveDecisionSource) {
  return {
    schemaId: SCHEMA_ID,
    schemaVersion: 1,
    actionClass,
    decision,
    humanApprovalRequired,
    paymentHold,
    reasonCode,
    runtimePolicyVersion: RUNTIME_POLICY_VERSION,
    effectiveDecisionSource,
  };
}

// shadow 对比入口：对同一输入同时算 legacy verdict 与新 verdict，返回两者供调用方
// 记录差异、不改实际执行。Phase 4 只 shadow，不切流（§6.1）。
export function shadowCompare(input, legacyVerdict) {
  const next = evaluateNonpaymentAutonomy(input);
  return {
    legacy: legacyVerdict ?? null,
    next,
    divergent: !legacyVerdict || legacyVerdict.decision !== next.decision,
  };
}

// ─── Phase 5 §8.1 item 1：AUTONOMY_POLICY_MODE 解析 ───
//
// 三态：legacy（不查新策略，旧行为）/ shadow（算但不应用，effectiveDecisionSource=shadow）/
// nonpayment_v1（active，deployed-runtime）。真实 adapter 只有在 launch config 明确给出
// pilotActors + pilotAliases 时才可以 active；空 selector 永远继续 shadow。这样 Phase 7
// 能切一台指定设备，而不会把全舰队或任意 actor 一起切流。request-scoped helper 再把
// active 结果收窄到 exact actor + alias。
const POLICY_MODES = new Set(["legacy", "shadow", "nonpayment_v1"]);

function normalizeSelectorList(value, name) {
  if (value === undefined || value === null || value === "") return [];
  const list = Array.isArray(value) ? value : [value];
  if (list.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new TypeError(`${name} must contain non-empty strings`);
  }
  return [...new Set(list.map((item) => item.trim()))].sort();
}

function readSelectorEnv(env, name) {
  const raw = env?.[name];
  if (raw === undefined || raw === null || raw === "") return [];
  try {
    return normalizeSelectorList(JSON.parse(raw), name);
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError(`${name} must be a JSON array of non-empty strings`);
  }
}

export function normalizePilotSelectors({ pilotActors = [], pilotAliases = [] } = {}) {
  return {
    pilotActors: normalizeSelectorList(pilotActors, "pilotActors"),
    pilotAliases: normalizeSelectorList(pilotAliases, "pilotAliases"),
  };
}

export function resolvePolicyMode({ env = process.env, adapterKind = "real", pilotActors, pilotAliases } = {}) {
  const mode = env.AUTONOMY_POLICY_MODE || "legacy";
  if (!POLICY_MODES.has(mode)) {
    throw new Error(`resolvePolicyMode: AUTONOMY_POLICY_MODE "${mode}" not in ${[...POLICY_MODES].join("/")}`);
  }
  const selectors = normalizePilotSelectors({
    pilotActors: pilotActors ?? readSelectorEnv(env, "CONTROL_PLANE_PILOT_ACTORS"),
    pilotAliases: pilotAliases ?? readSelectorEnv(env, "CONTROL_PLANE_PILOT_ALIASES"),
  });
  const pilotConfigured = selectors.pilotActors.length > 0 && selectors.pilotAliases.length > 0;
  // fake adapter remains available for the offline Phase 5 tests. Real adapter activation is
  // explicitly pilot-scoped; a missing half of the selector is a shadow configuration, never a
  // fleet-wide fallback.
  const active = mode === "nonpayment_v1"
    && (adapterKind === "fake" || (adapterKind === "real" && pilotConfigured));
  const consulted = mode !== "legacy"; // legacy 不查新策略
  return {
    mode,
    active,
    consulted,
    effectiveDecisionSource: active ? "deployed-runtime" : "shadow",
    adapterKind,
    pilotOnly: mode === "nonpayment_v1" && adapterKind === "real",
    pilotConfigured,
    ...selectors,
  };
}

export function isPilotScope(policyMode, { actorId = null, deviceAlias = null, physicalLabel = null } = {}) {
  if (!policyMode || policyMode.pilotOnly !== true) return policyMode?.active === true;
  if (policyMode.active !== true || policyMode.pilotConfigured !== true) return false;
  const actor = typeof actorId === "string" ? actorId.trim() : "";
  const alias = typeof deviceAlias === "string" ? deviceAlias.trim() : "";
  const label = typeof physicalLabel === "string" ? physicalLabel.trim() : "";
  return policyMode.pilotActors.includes(actor)
    && (policyMode.pilotAliases.includes(alias) || policyMode.pilotAliases.includes(label));
}

// Derive the request-scoped mode without mutating the launch-level policy. Out-of-scope actors
// and devices stay on shadow semantics; payment remains hard-gated in either result.
export function policyModeForRequest(policyMode, context = {}) {
  if (!policyMode) return null;
  if (policyMode.pilotOnly !== true) return policyMode;
  const inScope = isPilotScope(policyMode, context);
  return {
    ...policyMode,
    active: inScope,
    effectiveDecisionSource: inScope ? "deployed-runtime" : "shadow",
    pilotScope: inScope ? "in_scope" : "out_of_scope",
  };
}

// ─── Phase 5 §8.1 item 5：逐文件 policyDocDebt 生成 ───
//
// 接收一份反转清单 manifest（{ file, reversed, livenessAdded }），产出仍未反转或缺
// liveness 的文件 debt 列表。运行代码为准：旧 Skill 文案不能让 Explorer 自我停止——
// debt 让接手 agent 知道哪些旧 approval/blocked 断言（§8.2 B9）尚未反转。纯函数、
// 不改源、不触派发。
export function generatePolicyDocDebt(manifest = []) {
  const debt = [];
  for (const entry of manifest) {
    if (!entry?.file) continue;
    if (entry.reversed !== true) {
      debt.push({ file: entry.file, reason: "OLD_APPROVAL_BLOCKED_ASSERTION_NOT_REVERSED", livenessAdded: entry.livenessAdded === true });
    } else if (entry.livenessAdded !== true) {
      debt.push({ file: entry.file, reason: "REVERSED_WITHOUT_LIVENESS", livenessAdded: false });
    }
  }
  return {
    schemaId: "xhs.policy-doc-debt.v1",
    schemaVersion: 1,
    debt,
    count: debt.length,
    clean: debt.length === 0,
  };
}
