import { ControlPlaneError } from "./errors.mjs";
import { assertProductionBypassClosed, isWritePurpose } from "./transport-action-authorization.mjs";

export function requireRecordedLabBypass(source, {
  env = process.env,
  logger = (event) => console.log(JSON.stringify(event)),
  purpose = "execute",
} = {}) {
  // Foundation PR3 / INV-02: production write bypass is closed.
  if (isWritePurpose(purpose)) {
    assertProductionBypassClosed({ env, purpose });
  }
  const reason = String(env.XHS_BYPASS_REASON || "").trim();
  if (env.XHS_ALLOW_BYPASS !== "1" || !reason) {
    throw new ControlPlaneError(
      "CONTROL_LEASE_REQUIRED",
      `${source} is a direct lab-only route; use a control-plane job/session or set XHS_ALLOW_BYPASS=1 with XHS_BYPASS_REASON`,
      { status: 423 },
    );
  }
  // Observe-only lab probe may log; write purposes never reach here (assert above).
  const event = {
    event: "operator.lease-bypass",
    source,
    reason: reason.slice(0, 200),
    purpose,
    at: new Date().toISOString(),
  };
  logger(event);
  return { authorized: true, bypass: purpose === "observe", write: false };
}
