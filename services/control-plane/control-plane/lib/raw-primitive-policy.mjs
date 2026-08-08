/**
 * Raw primitive policy (Foundation INV-05).
 * P0 Raw Public allowlist: screen / dump_ui / window-focus observation only.
 * home / launch / back / tap / swipe / input are NOT raw-public.
 */

import { ControlPlaneError } from "./errors.mjs";

/** @typedef {"readonly_observation"|"write_or_interactive"|"unknown"} RawClass */

const BOUNDARY_ALIASES = {
  // interactive
  tap: "interactive_tap",
  tapSelector: "interactive_tap",
  swipe: "interactive_swipe",
  input: "interactive_input",
  input_text: "interactive_input",
  focus: "interactive_focus", // recipe focus — not window observation
  // readonly
  screen: "screen",
  screenshot: "screen",
  dump: "dump_ui",
  dump_ui: "dump_ui",
  // window focus observation (xiaowei read path) — distinct from recipe focus
  window_focus: "window_focus_observation",
  getCurrentFocus: "window_focus_observation",
  // writes / navigation (not raw public)
  home: "home",
  pressHome: "home",
  back: "back",
  pressBack: "back",
  launch: "launch",
  launch_app: "launch",
  launchPackage: "launch",
};

const READONLY = new Set(["screen", "dump_ui", "window_focus_observation"]);
const BLOCKED_WRITE = new Set([
  "interactive_tap",
  "interactive_swipe",
  "interactive_input",
  "interactive_focus",
  "home",
  "back",
  "launch",
]);

export function normalizeRawPrimitive(boundary, rawKind) {
  const kind = typeof rawKind === "string" ? rawKind.trim() : "";
  if (!kind) {
    return { boundary: boundary || null, rawKind: kind, canonicalKind: null, class: "unknown" };
  }
  // Boundary-specific: xiaowei focus observation vs recipe focus
  if ((kind === "focus" || kind === "getCurrentFocus") && /xiaowei|observe|session/i.test(String(boundary || ""))) {
    if (kind === "getCurrentFocus" || boundary === "xiaowei.window_focus") {
      return {
        boundary: boundary || null,
        rawKind: kind,
        canonicalKind: "window_focus_observation",
        class: "readonly_observation",
      };
    }
  }
  const canonicalKind = BOUNDARY_ALIASES[kind] || kind;
  if (READONLY.has(canonicalKind)) {
    return { boundary: boundary || null, rawKind: kind, canonicalKind, class: "readonly_observation" };
  }
  if (BLOCKED_WRITE.has(canonicalKind)) {
    return { boundary: boundary || null, rawKind: kind, canonicalKind, class: "write_or_interactive" };
  }
  return { boundary: boundary || null, rawKind: kind, canonicalKind, class: "unknown" };
}

/**
 * @returns {{ allowed: boolean, reasonCode?: string, canonicalKind?: string }}
 */
export function decideRawPrimitivePolicy(boundary, rawKind) {
  const normalized = normalizeRawPrimitive(boundary, rawKind);
  if (normalized.class === "readonly_observation") {
    return { allowed: true, canonicalKind: normalized.canonicalKind };
  }
  if (normalized.class === "write_or_interactive") {
    return {
      allowed: false,
      reasonCode: "RAW_INTERACTIVE_PRIMITIVE_DISABLED_P0",
      canonicalKind: normalized.canonicalKind,
    };
  }
  return {
    allowed: false,
    reasonCode: "RAW_PRIMITIVE_UNKNOWN_P0",
    canonicalKind: normalized.canonicalKind,
  };
}

export function assertRawPrimitiveAllowed(boundary, rawKind) {
  const decision = decideRawPrimitivePolicy(boundary, rawKind);
  if (decision.allowed) return decision;
  throw new ControlPlaneError(
    decision.reasonCode,
    `raw primitive blocked: ${rawKind} (${decision.canonicalKind || "unknown"})`,
    { status: 403, details: { boundary, rawKind, ...decision } },
  );
}
