import { ControlPlaneError } from "./errors.mjs";

const LOW_MATURITY = new Set(["E0", "E1"]);
const EXTERNAL_RISK = new Set(["R2", "R3"]);
const STANDING_GRANT_MISSION_ONLY = new Set(["xhs.collect.standing_grant"]);

export function evaluateCapabilityPolicy(capability, { canary = false, invocation = "job" } = {}) {
  // REX Phase 2 收尾 §4.2.A：资金最终提交 capability 不得自动派发（job/session/
  // mission_effect 全拦）。唯一 sanctioned 路径是控制面 PHC 流（beginPaymentCommit→
  // waiting_authorization→人类签名决定→ECP executePrepared→#runJob），该路径不经
  // evaluateCapabilityPolicy，故此闸只挡自动派发入口。当前无 capability 标此位，
  // 闸为 dormant 防线；未来加支付 capability 必须标 financialCommit 并走 PHC。
  if (capability.financialCommit === true || capability.automationPolicy?.mode === "financial_commit") {
    throw new ControlPlaneError(
      "FINANCIAL_COMMIT_REQUIRES_HUMAN_GATE",
      `${capability.id} is a financial final-commit capability and cannot be auto-dispatched; it must route through the protected human-commit flow`,
      { status: 403 },
    );
  }
  if (STANDING_GRANT_MISSION_ONLY.has(capability.id) && invocation !== "mission_effect") {
    throw new ControlPlaneError(
      "STANDING_GRANT_MISSION_REQUIRED",
      `${capability.id} may run only through a governed Standing Grant Mission ECP`,
      { status: 403 },
    );
  }
  const mode = capability.automationPolicy.mode;
  if (mode === "disabled") {
    throw new ControlPlaneError("CAPABILITY_DISABLED", `${capability.id} is disabled`, { status: 403 });
  }
  if ((LOW_MATURITY.has(capability.maturity) || mode === "lab_only") && (!canary || invocation !== "session")) {
    throw new ControlPlaneError(
      "CANARY_SESSION_REQUIRED",
      `${capability.id} requires an exclusive canary session`,
      { status: 403 },
    );
  }
  if (capability.automationPolicy.canaryOnly && !canary) {
    throw new ControlPlaneError("CANARY_REQUIRED", `${capability.id} is canary-only`, { status: 403 });
  }
  const externalEffect = EXTERNAL_RISK.has(capability.risk)
    || ["external_effect", "ambiguous_on_timeout"].includes(capability.idempotency);
  if (STANDING_GRANT_MISSION_ONLY.has(capability.id) && invocation === "mission_effect") {
    return { approvalRequired: false, externalEffect: true };
  }
  const approvalRequired = externalEffect || mode === "approval_required";
  return { approvalRequired, externalEffect };
}
