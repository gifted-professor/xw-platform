import { ControlPlaneError } from "./errors.mjs";

const MODES = new Set(["off", "audit", "enforce"]);

export async function guardLegacyUiRoute({
  source,
  action,
  actorPresent = false,
  mode = process.env.CONTROL_PLANE_LEGACY_MODE || "audit",
  controlUrl = process.env.CONTROL_PLANE_URL || "http://127.0.0.1:17920/",
  fetchImpl = globalThis.fetch,
  logger = () => {},
} = {}) {
  if (!MODES.has(mode)) throw new TypeError(`invalid CONTROL_PLANE_LEGACY_MODE ${mode}`);
  const event = {
    source: String(source || "unknown").slice(0, 80),
    action: String(action || "unknown").slice(0, 80),
    actorPresent: Boolean(actorPresent),
    mode,
  };
  if (mode !== "off") {
    try {
      await fetchImpl(new URL("/control/v1/legacy-events", controlUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(1500),
      });
    } catch {
      logger({ type: "legacy.audit.unavailable", ...event });
    }
  }
  if (mode === "enforce") {
    throw new ControlPlaneError(
      "LEGACY_ROUTE_BLOCKED",
      "direct UI route is blocked; submit a leased control-plane job",
      { status: 423, details: { source: event.source, action: event.action } },
    );
  }
  return { allowed: true, mode };
}
