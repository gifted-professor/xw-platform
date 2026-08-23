import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  deriveM6TrustedApplicationRef,
  deriveM6TrustedParameterHash,
  deriveM6TrustedTextRef,
} from "../../../packages/kernel/lib/m6-action-slot.mjs";
import { deriveM6PrivateBoundsRef } from "../../../packages/kernel/lib/m6-live-grounding.mjs";
import { createM6GroundedTcb } from "../apps/xiaowei/m6-grounded-tcb.mjs";
import { deriveM6PrivateMaterialBinding } from "../control-plane/lib/m6-typed-transport.mjs";

const H = (value) => createHash("sha256").update(value).digest("hex");

function runtime() {
  const calls = [];
  const tcb = createM6GroundedTcb({
    transport: { async invoke(request) { calls.push(request); return { code: 10000, data: "ok" }; } },
    device: { deviceId: "device-1", alias: "01", runtimeId: "runtime-opaque" },
    leaseAuthorization: { deviceId: "device-1", leaseId: "lease-opaque", token: "server-only" },
    job: { capabilityId: "xiaowei.m6.grounded_run", canary: true },
    evidenceDirectory: "unused-for-write-test",
  });
  return { tcb, calls };
}

function fixture({ primitive = "tap", target, trustedParams, privateMaterial } = {}) {
  const blockId = H("block");
  const frameId = H("frame");
  const region = { x1: 10, y1: 20, x2: 110, y2: 120 };
  const defaultTarget = { kind: "block", frameId, blockId };
  const defaultMaterial = {
    point: { x: 60, y: 70 },
    bounds: region,
    boundsRef: deriveM6PrivateBoundsRef({ blockId, bounds: region }),
  };
  const invocation = {
    primitive,
    target: target ?? defaultTarget,
    trustedParams: trustedParams ?? {},
    operationKey: H(`operation:${primitive}`),
  };
  const material = privateMaterial ?? defaultMaterial;
  const binding = deriveM6PrivateMaterialBinding({
    invocation,
    privateMaterial: material,
    authority: {
      schemaId: "xw.m6-private-dispatch-authority.v1",
      operationKey: invocation.operationKey,
      decisionRef: H(`decision:${primitive}`),
      slotSpecHash: H(`slot:${primitive}`),
      primitive,
      target: invocation.target,
      trustedParameterHash: deriveM6TrustedParameterHash(invocation.trustedParams),
      currentStateHash: H(`state:${primitive}`),
      boundsRef: material.boundsRef ?? null,
      appRef: invocation.trustedParams.appRef ?? null,
      textRef: invocation.trustedParams.textRef ?? null,
    },
  });
  return { invocation, material, binding };
}

test("dedicated M6 TCB materializes a private tap only at the final transport boundary", async () => {
  const { tcb, calls } = runtime();
  const prepared = fixture();
  const result = await tcb.invokeWrite(prepared.binding, prepared.invocation, prepared.material);
  assert.deepEqual(result, { ok: true, primitive: "tap", vendorCode: 10000 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, "adb_shell");
  assert.equal(calls[0].devices, "runtime-opaque");
  assert.equal(calls[0].data.command, "input tap 60 70");
  assert.equal(JSON.stringify(result).includes("60"), false);
  assert.equal(JSON.stringify(result).includes("server-only"), false);
});

test("every consumed M6 primitive owns exactly one raw provider invocation", async () => {
  const { tcb, calls } = runtime();
  const blockId = H("block");
  const bounds = { x1: 10, y1: 20, x2: 110, y2: 120 };
  const boundsRef = deriveM6PrivateBoundsRef({ blockId, bounds });
  const textRef = deriveM6TrustedTextRef("trusted query");
  const appRef = deriveM6TrustedApplicationRef({ package: "com.xhs" });
  const cases = [
    fixture(),
    fixture({
      primitive: "type_search_text",
      trustedParams: { textRef },
      privateMaterial: { text: "trusted query", textRef, bounds, boundsRef },
    }),
    fixture({
      primitive: "open_app",
      target: { kind: "none" },
      trustedParams: { appRef },
      privateMaterial: { app: { package: "com.xhs" }, appRef },
    }),
    fixture({ primitive: "back", target: { kind: "none" }, trustedParams: {}, privateMaterial: {} }),
    fixture({
      primitive: "scroll",
      target: { kind: "screen", frameId: H("frame"), pageFingerprint: H("page"), focusHash: H("focus") },
      trustedParams: { direction: "down", distanceTier: "short" },
      privateMaterial: { screen: { width: 1080, height: 2400 }, swipe: { from: { x: 540, y: 1600 }, to: { x: 540, y: 800 }, durationMs: 350 } },
    }),
  ];
  for (const prepared of cases) await tcb.invokeWrite(prepared.binding, prepared.invocation, prepared.material);
  assert.equal(calls.length, cases.length);
  assert.deepEqual(calls.map((call) => call.action), ["adb_shell", "inputText", "adb_shell", "adb_shell", "adb_shell"]);
});

test("dedicated M6 TCB rejects raw fields and swapped point/package/text bindings before provider I/O", async () => {
  const { tcb, calls } = runtime();
  const tap = fixture();
  const appRef = deriveM6TrustedApplicationRef({ package: "com.xhs" });
  await assert.rejects(
    () => tcb.invokeWrite(tap.binding, { ...tap.invocation, trustedParams: { x: 12 } }, tap.material),
    { code: "M6_TYPED_TRANSPORT_INVALID" },
  );
  await assert.rejects(
    () => tcb.invokeWrite(tap.binding, tap.invocation, { ...tap.material, point: { x: 61, y: 70 } }),
    { code: "M6_TCB_PRIVATE_MATERIAL_BINDING_MISMATCH" },
  );

  const app = fixture({
    primitive: "open_app", target: { kind: "none" }, trustedParams: { appRef },
    privateMaterial: { app: { package: "com.xhs" }, appRef },
  });
  await assert.rejects(
    () => tcb.invokeWrite(app.binding, app.invocation, { ...app.material, app: { package: "com.other.safe" } }),
    { code: "M6_TCB_PRIVATE_MATERIAL_BINDING_MISMATCH" },
  );

  const trustedTextRef = deriveM6TrustedTextRef("trusted");
  const text = fixture({
    primitive: "type_search_text", trustedParams: { textRef: trustedTextRef },
    privateMaterial: {
      text: "trusted", textRef: trustedTextRef, bounds: tap.material.bounds, boundsRef: tap.material.boundsRef,
    },
  });
  await assert.rejects(
    () => tcb.invokeWrite(text.binding, text.invocation, { ...text.material, text: "swapped" }),
    { code: "M6_TCB_PRIVATE_MATERIAL_BINDING_MISMATCH" },
  );
  assert.equal(calls.length, 0);
});
