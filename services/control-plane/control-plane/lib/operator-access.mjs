import { ControlPlaneError } from "./errors.mjs";

export function requireRecordedLabBypass(source, {
  env = process.env,
  logger = (event) => console.error(JSON.stringify(event)),
} = {}) {
  const reason = String(env.XHS_BYPASS_REASON || "").trim();
  if (env.XHS_ALLOW_BYPASS !== "1" || !reason) {
    throw new ControlPlaneError(
      "CONTROL_LEASE_REQUIRED",
      `${source} is a direct lab-only route; use a control-plane job/session or set XHS_ALLOW_BYPASS=1 with XHS_BYPASS_REASON`,
      { status: 423 },
    );
  }
  const event = {
    event: "operator.lease-bypass",
    source,
    reason: reason.slice(0, 200),
    at: new Date().toISOString(),
  };
  logger(event);
  return { authorized: true, bypass: true };
}
