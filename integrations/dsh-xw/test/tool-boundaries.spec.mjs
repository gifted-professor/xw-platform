import assert from "node:assert/strict";
import test from "node:test";

import { assertSupportedJsonSchema, validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";

import { M6_TOOL_NAMES, M6_TOOL_SPEC, validateToolCall, validateToolResult } from "../../../services/orchestrator/scripts/lib/m6/m6-tool-surface.mjs";

const HASH = "a".repeat(64);

test("all generated Cordis input/output schemas are closed and supported", () => {
  assert.equal(M6_TOOL_NAMES.length, 10);
  for (const name of M6_TOOL_NAMES) {
    const spec = M6_TOOL_SPEC[name];
    assert.equal(spec.inputSchema.additionalProperties, false);
    assert.equal(spec.outputSchema.additionalProperties, false);
    assert.doesNotThrow(() => assertSupportedJsonSchema(spec.inputSchema));
    assert.doesNotThrow(() => assertSupportedJsonSchema(spec.outputSchema));
  }
});

test("Cordis schema mutation, handler input mutation and output mutation fail at distinct boundaries", () => {
  assert.notEqual(validateJsonSchemaValue(M6_TOOL_SPEC.phone_act.inputSchema, {
    groundingDecisionRef: HASH,
    operationKey: "operation-0001",
    extra: true,
  }).length, 0, "Cordis schema must reject an extra key");

  assert.equal(validateToolCall({ tool: "phone_act", args: {
    groundingDecisionRef: HASH,
    operationKey: "x",
  } }).ok, false, "handler validator must enforce opaque-ref bounds beyond Cordis type schema");

  assert.equal(validateToolResult({ tool: "phone_act", result: {
    actionReceiptRef: "action-receipt-0001",
    outcome: "SUCCEEDED",
    externalEffect: false,
    actionCount: 0,
    coordinates: [1, 2],
  } }).ok, false, "output validator must reject forbidden/extra fields");
});

test("result validator enforces replay-only constants for every tool", () => {
  const valid = {
    worker_start: { workerRunRef: "worker-run-0001", status: "STARTED", externalEffect: false, actionCount: 0 },
    worker_continue: { workerRunRef: "worker-run-0001", status: "CONTINUED", externalEffect: false, actionCount: 0 },
    worker_complete: { workerRunRef: "worker-run-0001", status: "COMPLETED", externalEffect: false, actionCount: 0 },
  };
  for (const [tool, result] of Object.entries(valid)) {
    assert.equal(validateToolResult({ tool, result }).ok, true);
    assert.equal(validateToolResult({ tool, result: { ...result, externalEffect: true } }).ok, false);
    assert.equal(validateToolResult({ tool, result: { ...result, actionCount: 1 } }).ok, false);
  }
});

test("inventory mutations catch extra, missing, duplicate and schema drift", () => {
  const canonical = M6_TOOL_NAMES.map((name) => ({ name, parameters: M6_TOOL_SPEC[name].inputSchema }));
  const validate = (inventory) => {
    const names = inventory.map((tool) => tool.name);
    return names.length === 10
      && new Set(names).size === 10
      && [...names].sort().join("|") === [...M6_TOOL_NAMES].sort().join("|")
      && inventory.every((tool) => JSON.stringify(tool.parameters) === JSON.stringify(M6_TOOL_SPEC[tool.name].inputSchema));
  };
  assert.equal(validate(canonical), true);
  assert.equal(validate([...canonical, { name: "extra", parameters: {} }]), false);
  assert.equal(validate(canonical.slice(1)), false);
  assert.equal(validate([...canonical.slice(0, -1), canonical[0]]), false);
  assert.equal(validate(canonical.map((tool, index) => index ? tool : { ...tool, parameters: { type: "object" } })), false);
});
