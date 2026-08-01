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
const RUNTIME_POLICY_VERSION = "xhs.nonpayment-autonomy.v1";

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