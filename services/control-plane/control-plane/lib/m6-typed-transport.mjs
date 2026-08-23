import {
  deriveM6TrustedApplicationRef,
  deriveM6TrustedParameterHash,
  deriveM6TrustedTextRef,
} from "../../../../packages/kernel/lib/m6-action-slot.mjs";
import { deriveM6PrivateBoundsRef } from "../../../../packages/kernel/lib/m6-live-grounding.mjs";
import { canonicalJson, sha256 } from "./canonical.mjs";
import { ControlPlaneError } from "./errors.mjs";

export const M6_SERVER_PRIMITIVES = Object.freeze([
  "observe", "open_app", "back", "wait", "tap", "scroll", "type_search_text",
]);

const HASH = /^[0-9a-f]{64}$/u;
const WRITE_PRIMITIVES = new Set(["open_app", "back", "tap", "scroll", "type_search_text"]);

function fail(message) {
  throw new ControlPlaneError("M6_TYPED_TRANSPORT_INVALID", message, { status: 409 });
}

function privateInvalid(message) {
  throw new ControlPlaneError("M6_TCB_PRIVATE_MATERIAL_INVALID", message, { status: 409 });
}

function privateMismatch(message) {
  throw new ControlPlaneError("M6_TCB_PRIVATE_MATERIAL_BINDING_MISMATCH", message, { status: 409 });
}

function exactKeys(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value)
    && canonicalJson(Object.keys(value).sort()) === canonicalJson([...expected].sort());
}

function closedTarget(target) {
  if (target?.kind === "none" && exactKeys(target, ["kind"])) return true;
  if (target?.kind === "block" && exactKeys(target, ["kind", "frameId", "blockId"])
    && HASH.test(target.frameId || "") && HASH.test(target.blockId || "")) return true;
  return target?.kind === "screen" && exactKeys(target, ["kind", "frameId", "pageFingerprint", "focusHash"])
    && [target.frameId, target.pageFingerprint, target.focusHash].every((value) => HASH.test(value || ""));
}

function exactTrustedParams(primitive, params) {
  if (primitive === "open_app") return exactKeys(params, ["appRef"]) && HASH.test(params.appRef || "");
  if (primitive === "type_search_text") return exactKeys(params, ["textRef"]) && HASH.test(params.textRef || "");
  if (primitive === "scroll") return exactKeys(params, ["direction", "distanceTier"])
    && ["up", "down"].includes(params.direction) && ["short", "medium"].includes(params.distanceTier);
  if (primitive === "wait") return exactKeys(params, ["durationMs"])
    && Number.isInteger(params.durationMs) && params.durationMs >= 0 && params.durationMs <= 2_000;
  return ["observe", "tap", "back"].includes(primitive) && exactKeys(params, []);
}

export function validateM6TypedInvocation(invocation) {
  if (!invocation || !M6_SERVER_PRIMITIVES.includes(invocation.primitive)) fail("unknown M6 server primitive");
  const params = invocation.trustedParams || {};
  const target = invocation.target;
  if (!closedTarget(target)) fail("M6 target is not a closed server-issued target");
  if (["tap", "type_search_text"].includes(invocation.primitive) && target.kind !== "block") fail("targeted primitive requires a block target");
  if (invocation.primitive === "scroll" && target.kind !== "screen") fail("scroll requires a screen target");
  if (["open_app", "back", "wait", "observe"].includes(invocation.primitive) && target.kind !== "none") fail("non-target primitive requires target kind none");
  if (!exactTrustedParams(invocation.primitive, params)) fail("trusted parameters are not the primitive's closed server policy");
  if (WRITE_PRIMITIVES.has(invocation.primitive) && !HASH.test(invocation.operationKey || "")) fail("write primitive requires a derived operation key");
  if (Object.keys(params).some((key) => /^(?:x|y|x1|y1|x2|y2|bounds|command|shell|package|text)$/iu.test(key))) fail("raw coordinate/shell/package/text parameters are forbidden");
  return Object.freeze({ ...invocation, target: Object.freeze({ ...target }), trustedParams: Object.freeze({ ...params }), writePrimitive: WRITE_PRIMITIVES.has(invocation.primitive) });
}

function boundedPoint(value, label) {
  if (!value || !Number.isInteger(value.x) || !Number.isInteger(value.y)
    || value.x < 0 || value.y < 0 || value.x > 4096 || value.y > 4096) privateInvalid(`${label} is not a bounded point`);
  return value;
}

function closedBounds(value) {
  if (!exactKeys(value, ["x1", "y1", "x2", "y2"])
    || ![value.x1, value.y1, value.x2, value.y2].every(Number.isInteger)
    || value.x1 < 0 || value.y1 < 0 || value.x2 <= value.x1 || value.y2 <= value.y1
    || value.x2 > 4096 || value.y2 > 4096) privateInvalid("server-private bounds are invalid");
  return value;
}

function assertBlockMaterial({ checked, material, authority, requirePoint }) {
  const materialKeys = requirePoint ? ["point", "bounds", "boundsRef"] : ["text", "textRef", "bounds", "boundsRef"];
  if (!exactKeys(material, materialKeys)) privateInvalid("targeted private material is not closed");
  const region = closedBounds(material.bounds);
  const expectedBoundsRef = deriveM6PrivateBoundsRef({ blockId: checked.target.blockId, bounds: region });
  if (material.boundsRef !== expectedBoundsRef || authority.boundsRef !== expectedBoundsRef) privateMismatch("block bounds/ref were swapped");
  if (requirePoint) {
    const selected = boundedPoint(material.point, "tap point");
    const center = { x: Math.round((region.x1 + region.x2) / 2), y: Math.round((region.y1 + region.y2) / 2) };
    if (selected.x !== center.x || selected.y !== center.y) privateMismatch("tap point is not the deterministic center of the consumed block bounds");
  }
}

function validatePrimitiveMaterial(checked, material, authority) {
  switch (checked.primitive) {
    case "tap":
      assertBlockMaterial({ checked, material, authority, requirePoint: true });
      break;
    case "type_search_text":
      assertBlockMaterial({ checked, material, authority, requirePoint: false });
      if (typeof material.text !== "string" || material.text.trim() === "" || material.text.length > 200) privateInvalid("trusted text is invalid");
      if (material.textRef !== checked.trustedParams.textRef || authority.textRef !== checked.trustedParams.textRef
        || material.textRef !== deriveM6TrustedTextRef(material.text)) privateMismatch("trusted text/ref were swapped");
      break;
    case "open_app": {
      if (!exactKeys(material, ["app", "appRef"]) || !exactKeys(material.app, material.app.activity === undefined ? ["package"] : ["package", "activity"])) {
        privateInvalid("trusted application material is not closed");
      }
      if (!/^[a-zA-Z0-9._]+$/u.test(material.app.package || "")
        || (material.app.activity !== undefined && !/^[A-Za-z0-9_$./]+$/u.test(material.app.activity))) privateInvalid("trusted application identity is invalid");
      if (material.appRef !== checked.trustedParams.appRef || authority.appRef !== checked.trustedParams.appRef
        || material.appRef !== deriveM6TrustedApplicationRef(material.app)) privateMismatch("trusted application/ref were swapped");
      break;
    }
    case "scroll": {
      if (!exactKeys(material, ["swipe", "screen"]) || !exactKeys(material.screen, ["width", "height"])
        || !exactKeys(material.swipe, ["from", "to", "durationMs"])) privateInvalid("scroll private material is not closed");
      const from = boundedPoint(material.swipe.from, "scroll start");
      const to = boundedPoint(material.swipe.to, "scroll end");
      if (![material.screen.width, material.screen.height].every(Number.isInteger)
        || material.screen.width < 1 || material.screen.height < 1 || material.screen.width > 4096 || material.screen.height > 4096
        || !Number.isInteger(material.swipe.durationMs) || material.swipe.durationMs < 50 || material.swipe.durationMs > 1_000
        || from.x >= material.screen.width || to.x >= material.screen.width || from.y >= material.screen.height || to.y >= material.screen.height) {
        privateInvalid("scroll geometry is outside the qualified screen");
      }
      const directionMatches = checked.trustedParams.direction === "down" ? to.y < from.y : to.y > from.y;
      if (!directionMatches) privateMismatch("scroll geometry was swapped against the trusted direction");
      break;
    }
    case "back":
      if (!exactKeys(material, [])) privateInvalid("back has no private parameters");
      break;
    default:
      privateInvalid(`primitive ${checked.primitive} is not a write primitive`);
  }
}

const AUTHORITY_KEYS = Object.freeze([
  "schemaId", "operationKey", "decisionRef", "slotSpecHash", "primitive", "target",
  "trustedParameterHash", "currentStateHash", "boundsRef", "appRef", "textRef",
]);

export function deriveM6PrivateMaterialBinding({ invocation, privateMaterial, authority } = {}) {
  const checked = validateM6TypedInvocation(invocation);
  if (!checked.writePrimitive || !exactKeys(authority, AUTHORITY_KEYS)
    || authority.schemaId !== "xw.m6-private-dispatch-authority.v1"
    || ![authority.operationKey, authority.decisionRef, authority.slotSpecHash, authority.trustedParameterHash, authority.currentStateHash]
      .every((value) => HASH.test(value || ""))) privateInvalid("private dispatch authority is invalid or open");
  if (authority.operationKey !== checked.operationKey || authority.primitive !== checked.primitive
    || canonicalJson(authority.target) !== canonicalJson(checked.target)
    || authority.trustedParameterHash !== deriveM6TrustedParameterHash(checked.trustedParams)) {
    privateMismatch("private material authority drifted from the typed invocation");
  }
  validatePrimitiveMaterial(checked, privateMaterial, authority);
  const privateMaterialHash = sha256(`xw.m6-private-material.v1:${canonicalJson(privateMaterial)}`);
  const raw = { ...authority, schemaId: "xw.m6-private-material-binding.v1", privateMaterialHash };
  return Object.freeze({ ...raw, bindingHash: sha256(`xw.m6-private-material-binding.v1:${canonicalJson(raw)}`) });
}

function authorityFromBinding(binding) {
  return Object.fromEntries(AUTHORITY_KEYS.map((key) => [
    key,
    key === "schemaId" ? "xw.m6-private-dispatch-authority.v1" : binding?.[key],
  ]));
}

export function assertM6PrivateMaterialBinding({ binding, invocation, privateMaterial } = {}) {
  const rebound = deriveM6PrivateMaterialBinding({
    invocation,
    privateMaterial,
    authority: authorityFromBinding(binding),
  });
  if (rebound.bindingHash !== binding?.bindingHash) privateMismatch("private material changed after its authority was sealed");
  return rebound;
}

export function createM6TypedTransport({ invokeWrite, invokeRead = null } = {}) {
  if (typeof invokeWrite !== "function") throw new TypeError("invokeWrite is required");
  const api = {
    prepareWrite(invocation, privateMaterial, authority) {
      const binding = deriveM6PrivateMaterialBinding({ invocation, privateMaterial, authority });
      return Object.freeze({
        schemaId: "xw.m6-prepared-private-write.v1",
        invocation: structuredClone(invocation),
        privateMaterial: structuredClone(privateMaterial),
        binding,
      });
    },
    async dispatchPrepared(prepared) {
      if (prepared?.schemaId !== "xw.m6-prepared-private-write.v1") privateInvalid("prepared private write is invalid");
      const rebound = assertM6PrivateMaterialBinding({
        binding: prepared.binding,
        invocation: prepared.invocation,
        privateMaterial: prepared.privateMaterial,
      });
      const result = await invokeWrite(rebound, prepared.invocation, prepared.privateMaterial);
      return { ...result, transportCalled: true };
    },
    async dispatch(invocation, privateMaterial, authority = null) {
      const checked = validateM6TypedInvocation(invocation);
      if (!checked.writePrimitive) {
        if (checked.primitive === "wait") return { ok: true, waitedMs: checked.trustedParams.durationMs, transportCalled: false };
        if (typeof invokeRead !== "function") return { ok: true, transportCalled: false };
        return { ...(await invokeRead(checked, privateMaterial)), transportCalled: false };
      }
      return api.dispatchPrepared(api.prepareWrite(invocation, privateMaterial, authority));
    },
  };
  return Object.freeze(api);
}
