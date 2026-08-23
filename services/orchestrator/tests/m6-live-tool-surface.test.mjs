import assert from "node:assert/strict";
import test from "node:test";

import {
  M6_LIVE_TOOL_NAMES,
  M6_LIVE_TOOL_SPEC,
  validateLiveToolCall,
  validateLiveToolResult,
} from "../scripts/lib/m6/m6-live-tool-surface.mjs";

const H = "a".repeat(64);

test("live profile exposes the same exact ten names through separately versioned closed schemas", () => {
  assert.equal(M6_LIVE_TOOL_NAMES.length, 10);
  assert.equal(new Set(M6_LIVE_TOOL_NAMES).size, 10);
  assert.deepEqual(Object.keys(M6_LIVE_TOOL_SPEC), M6_LIVE_TOOL_NAMES);
  assert.equal(M6_LIVE_TOOL_SPEC.phone_ground.inputSchema.additionalProperties, false);
  assert.equal(M6_LIVE_TOOL_SPEC.phone_ground.outputSchema.additionalProperties, false);
  assert.deepEqual(M6_LIVE_TOOL_SPEC.phone_ground.inputSchema.required, ["frameRef", "intentRef"]);
});

test("live phone_ground permits only an opaque candidate block and no targetKind/coordinates/authority", () => {
  assert.equal(validateLiveToolCall({ tool: "phone_ground", args: { frameRef: H, intentRef: H, candidateBlockId: H } }).ok, true);
  for (const args of [
    { frameRef: H, intentRef: H, targetKind: "block" },
    { frameRef: H, intentRef: H, x: 1, y: 2 },
    { frameRef: H, intentRef: H, leaseToken: "secret" },
  ]) assert.equal(validateLiveToolCall({ tool: "phone_ground", args }).ok, false);
});

test("only phone_act may report one transport effect and accounting must agree", () => {
  assert.equal(validateLiveToolResult({ tool: "phone_observe", result: { externalEffect: false, actionCount: 0, frameRef: H } }).ok, true);
  assert.equal(validateLiveToolResult({ tool: "phone_observe", result: { externalEffect: true, actionCount: 1, frameRef: H } }).ok, false);
  assert.equal(validateLiveToolResult({ tool: "phone_act", result: { externalEffect: true, actionCount: 1, effectStatus: "VERIFIED", actionReceiptRef: H, verificationRef: H } }).ok, true);
  assert.equal(validateLiveToolResult({ tool: "phone_act", result: { externalEffect: false, actionCount: 1, effectStatus: "NOT_SENT" } }).ok, false);
  assert.equal(validateLiveToolResult({ tool: "phone_observe", result: { externalEffect: false, actionCount: 0, frameRef: H, harmlessExtra: H } }).ok, false);
  assert.equal(validateLiveToolResult({ tool: "phone_ground", result: { externalEffect: false, actionCount: 0, disposition: "ALLOW_ONCE", decisionRef: H, operationKey: H } }).ok, true);
  assert.equal(validateLiveToolResult({ tool: "phone_ground", result: { externalEffect: false, actionCount: 0, disposition: "REPLAN", decisionRef: H, operationKey: H } }).ok, false);
});
