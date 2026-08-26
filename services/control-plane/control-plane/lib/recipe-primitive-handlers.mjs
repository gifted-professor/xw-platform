/**
 * recipe-primitive-handlers.mjs — bridge Recipe steps → Control Plane I/O.
 *
 * Handlers NEVER open ADB / 22222. They call injected:
 *   - executePrimitive({ session, params, idempotencyKey }) → explorer session_action
 *   - callCapability({ session, capabilityId, params, idempotencyKey }) → optional
 *
 * Semantic tapSelector without x/y is refused in PR1 (coord path first).
 */
import { randomUUID } from "node:crypto";

const EXPLORER_CAPABILITY_ID = "xiaowei.explorer.primitive";

function handlerError(code, message, details = {}) {
  const e = new Error(message);
  e.code = code;
  e.details = details;
  return e;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Map Recipe kind + call.args → explorer primitive params.
 * @param {string} kind
 * @param {object} args
 */
export function mapRecipeKindToPrimitiveParams(kind, args = {}) {
  switch (kind) {
    case "screenshot":
      return { primitive: "screen", ...(args.label ? { label: args.label } : {}) };
    case "dump":
      return { primitive: "dump_ui", ...(args.format ? { format: args.format } : {}) };
    case "focus":
      return { primitive: "focus" };
    case "back":
      return { primitive: "back", ...(args.times != null ? { times: args.times } : {}) };
    case "launch":
      return {
        primitive: "launch_app",
        package: args.appId || args.package || args.packageName,
        ...(args.activity ? { activity: args.activity } : {}),
        ...(args.forceStop ? { forceStop: true } : {}),
      };
    case "swipe": {
      if (args.from && args.to) {
        return {
          primitive: "swipe",
          x1: Math.round(Number(args.from.x)),
          y1: Math.round(Number(args.from.y)),
          x2: Math.round(Number(args.to.x)),
          y2: Math.round(Number(args.to.y)),
          ...(args.durationMs != null ? { durationMs: Math.round(Number(args.durationMs)) } : {}),
        };
      }
      if (args.direction) {
        // Direction-only: explorer swipe requires coords; Runner should expand via deviceProfile.
        throw handlerError(
          "SWIPE_COORDS_REQUIRED",
          "swipe direction without from/to is not wired in PR1; provide device-bound from/to",
          { direction: args.direction },
        );
      }
      throw handlerError("SWIPE_PARAMS_INVALID", "swipe requires device-bound from/to");
    }
    case "input": {
      // XwIME bridge supports refocusX/refocusY/clearFirst/enter/deferRestore.
      // XHS Flutter 字段需 tap-first 聚焦后 --no-refocus + clear-first（见 memory
      // xhs-flutter-xhsime-input-tap-first）。recipe 可在 input step 显式带
      // refocusX/refocusY 触发 adapter 重聚焦，或带 noRefocus:true 保持当前光标。
      const params = {
        primitive: "input_text",
        text: String(args.text ?? ""),
        ...(args.clear || args.clearFirst ? { clearFirst: true } : {}),
        ...(args.enter ? { enter: true } : {}),
        ...(args.deferRestore ? { deferRestore: true } : {}),
      };
      if (args.noRefocus === true) {
        // 显式保持当前焦点：不传 refocusX/refocusY，让 XwIME 在现有光标处提交。
        return params;
      }
      if (args.refocusX != null && args.refocusY != null) {
        params.refocusX = Math.round(Number(args.refocusX));
        params.refocusY = Math.round(Number(args.refocusY));
      }
      return params;
    }
    case "tapSelector": {
      if (args.x != null && args.y != null) {
        return {
          primitive: "tap",
          x: Math.round(Number(args.x)),
          y: Math.round(Number(args.y)),
        };
      }
      throw handlerError(
        "TAP_SELECTOR_UNRESOLVED",
        "PR1 tapSelector requires device-bound x/y; semantic selector resolve is deferred",
        { selector: args.selector ?? null },
      );
    }
    default:
      throw handlerError("PRIMITIVE_KIND_UNKNOWN", `no primitive mapping for kind ${kind}`);
  }
}

/**
 * @param {{
 *   executePrimitive: (opts: object) => Promise<object>|object,
 *   callCapability?: (opts: object) => Promise<object>|object,
 *   sleepFn?: (ms: number) => Promise<void>,
 *   newIdempotencyKey?: () => string,
 * }} deps
 */
export function createRecipePrimitiveHandlers(deps = {}) {
  const {
    executePrimitive,
    callCapability = null,
    sleepFn = sleep,
    newIdempotencyKey = () => `recipe-${randomUUID()}`,
  } = deps;

  if (typeof executePrimitive !== "function") {
    throw new TypeError("createRecipePrimitiveHandlers requires executePrimitive");
  }

  async function runPrimitive(kind, { session, call, step }) {
    const params = mapRecipeKindToPrimitiveParams(kind, call?.args || step?.params || {});
    const result = await executePrimitive({
      session,
      capabilityId: EXPLORER_CAPABILITY_ID,
      params,
      idempotencyKey: newIdempotencyKey(),
      stepId: step?.id ?? null,
      kind,
    });
    return { ok: true, kind, params, result };
  }

  return {
    screenshot: (ctx) => runPrimitive("screenshot", ctx),
    dump: (ctx) => runPrimitive("dump", ctx),
    focus: (ctx) => runPrimitive("focus", ctx),
    back: (ctx) => runPrimitive("back", ctx),
    launch: (ctx) => runPrimitive("launch", ctx),
    swipe: (ctx) => runPrimitive("swipe", ctx),
    input: (ctx) => runPrimitive("input", ctx),
    tapSelector: (ctx) => runPrimitive("tapSelector", ctx),

    async wait({ call, step }) {
      const ms = Number(call?.args?.ms ?? step?.params?.ms ?? 0);
      await sleepFn(ms);
      return { ok: true, kind: "wait", ms };
    },

    async callCapability({ session, call, step }) {
      const args = call?.args || step?.params || {};
      const capabilityId = args.capabilityId || args.capability;
      if (!capabilityId) {
        throw handlerError("CALL_CAPABILITY_ID_REQUIRED", "callCapability requires capabilityId");
      }
      if (typeof callCapability !== "function") {
        throw handlerError(
          "CALL_CAPABILITY_NOT_WIRED",
          "callCapability handler requires injected callCapability (session is explorer-scoped in PR1)",
          { capabilityId },
        );
      }
      const result = await callCapability({
        session,
        capabilityId: String(capabilityId),
        params: args.params && typeof args.params === "object" ? args.params : {},
        idempotencyKey: newIdempotencyKey(),
        stepId: step?.id ?? null,
      });
      return { ok: true, kind: "callCapability", capabilityId, result };
    },
  };
}

export { EXPLORER_CAPABILITY_ID };
