import { ControlPlaneError } from "./errors.mjs";

const LOW_MATURITY = new Set(["E0", "E1"]);
const EXTERNAL_RISK = new Set(["R2", "R3"]);
const STANDING_GRANT_MISSION_ONLY = new Set(["xhs.collect.standing_grant"]);

export function evaluateCapabilityPolicy(capability, { canary = false, invocation = "job" } = {}) {
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
