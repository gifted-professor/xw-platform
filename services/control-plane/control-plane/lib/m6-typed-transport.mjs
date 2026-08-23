import { ControlPlaneError } from "./errors.mjs";

export const M6_SERVER_PRIMITIVES = Object.freeze([
  "observe", "open_app", "back", "wait", "tap", "scroll", "type_search_text",
]);

const WRITE_PRIMITIVES = new Set(["open_app", "back", "tap", "scroll", "type_search_text"]);

function fail(message) {
  throw new ControlPlaneError("M6_TYPED_TRANSPORT_INVALID", message, { status: 409 });
}

export function validateM6TypedInvocation(invocation) {
  if (!invocation || !M6_SERVER_PRIMITIVES.includes(invocation.primitive)) fail("unknown M6 server primitive");
  const params = invocation.trustedParams || {};
  const target = invocation.target;
  if (["tap", "type_search_text"].includes(invocation.primitive) && target?.kind !== "block") fail("targeted primitive requires a block target");
  if (invocation.primitive === "scroll" && target?.kind !== "screen") fail("scroll requires a screen target");
  if (["open_app", "back", "wait", "observe"].includes(invocation.primitive) && target?.kind !== "none") fail("non-target primitive requires target kind none");
  if (invocation.primitive === "open_app" && !/^[0-9a-f]{64}$/.test(params.appRef || "")) fail("open_app requires a trusted appRef");
  if (invocation.primitive === "type_search_text" && !/^[0-9a-f]{64}$/.test(params.textRef || "")) fail("type_search_text requires a trusted textRef");
  if (invocation.primitive === "scroll" && (!['up', 'down'].includes(params.direction) || !['short', 'medium'].includes(params.distanceTier))) fail("scroll parameters are outside the bounded policy");
  if (invocation.primitive === "wait" && (!Number.isInteger(params.durationMs) || params.durationMs < 0 || params.durationMs > 2_000)) fail("wait duration is outside 0..2000ms");
  if (Object.keys(params).some((key) => /^(?:x|y|x1|y1|x2|y2|bounds|command|shell|package|text)$/iu.test(key))) fail("raw coordinate/shell/package/text parameters are forbidden");
  return { ...invocation, writePrimitive: WRITE_PRIMITIVES.has(invocation.primitive) };
}

export function createM6TypedTransport({ invokeWrite, invokeRead = null } = {}) {
  if (typeof invokeWrite !== "function") throw new TypeError("invokeWrite is required");
  return Object.freeze({
    async dispatch(invocation, privateMaterial) {
      const checked = validateM6TypedInvocation(invocation);
      if (!checked.writePrimitive) {
        if (checked.primitive === "wait") return { ok: true, waitedMs: checked.trustedParams.durationMs, transportCalled: false };
        if (typeof invokeRead !== "function") return { ok: true, transportCalled: false };
        return { ...(await invokeRead(checked, privateMaterial)), transportCalled: false };
      }
      if (["tap", "type_search_text"].includes(checked.primitive) && !privateMaterial?.point) fail("server-private point is required");
      if (checked.primitive === "type_search_text" && typeof privateMaterial?.text !== "string") fail("server-private trusted text is required");
      const result = await invokeWrite(checked, privateMaterial);
      return { ...result, transportCalled: true };
    },
  });
}
