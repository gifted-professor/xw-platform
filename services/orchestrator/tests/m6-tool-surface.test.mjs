import assert from "node:assert/strict";
import test from "node:test";

import { M6_TOOL_CLASSES, M6_TOOL_NAMES, M6_TOOL_SURFACE, validateToolCall } from "../scripts/lib/m6/m6-tool-surface.mjs";

const HASH = "ab".repeat(32);
const REF = "sess-01-0001";

test("the tool surface is exactly the eight M6 tool classes from the contract", () => {
  assert.equal(M6_TOOL_CLASSES.length, 8);
  for (const tool of M6_TOOL_NAMES) {
    assert.ok(Array.isArray(M6_TOOL_SURFACE[tool]));
  }
});

test("well-formed calls for every allowlisted tool pass", () => {
  const good = [
    { tool: "phone_observe", args: { sessionRef: REF } },
    { tool: "phone_ground", args: { frameRef: HASH, blockId: HASH, intent: "tap" } },
    { tool: "phone_act", args: { groundingDecisionRef: HASH, operationKey: "opkey-0001" } },
    { tool: "phone_verify", args: { actionReceiptRef: "receipt-0001", expectation: "搜索结果页出现" } },
    { tool: "checkpoint_save", args: { stateRefs: ["state-0001", "state-0002"] } },
    { tool: "trace_query", args: { traceId: "trace-0001" } },
    { tool: "wait_human", args: { reason: "hard stop", evidenceRefs: ["evidence-0001"] } },
    { tool: "worker_start", args: { workerRunRef: "worker-0001" } },
    { tool: "worker_continue", args: { workerRunRef: "worker-0001", checkpointRef: "checkpoint-0001" } },
    { tool: "worker_complete", args: { workerRunRef: "worker-0001", outcome: "SUCCEEDED" } },
  ];
  for (const call of good) {
    assert.deepEqual(validateToolCall(call).errors, [], `${call.tool} should pass`);
  }
});

test("closed arg specs: missing required keys and mistyped values are rejected", () => {
  assert.equal(validateToolCall({ tool: "phone_ground", args: {} }).ok, false);
  assert.equal(validateToolCall({ tool: "phone_ground" }).ok, false);
  assert.equal(validateToolCall({ tool: "phone_ground", args: { frameRef: HASH, blockId: HASH } }).ok, false);
  // frameRef must be a 64-hex id, not an arbitrary string.
  assert.equal(validateToolCall({ tool: "phone_ground", args: { frameRef: "frame-1", blockId: HASH, intent: "tap" } }).ok, false);
  // operationKey must match the opaque ref pattern.
  assert.equal(validateToolCall({ tool: "phone_act", args: { groundingDecisionRef: HASH, operationKey: "x" } }).ok, false);
  // expectation must be bounded text, not an object smuggling structure.
  assert.equal(validateToolCall({ tool: "phone_verify", args: { actionReceiptRef: "receipt-0001", expectation: { text: "x" } } }).ok, false);
  // stateRefs must be a non-empty array of opaque refs.
  assert.equal(validateToolCall({ tool: "checkpoint_save", args: { stateRefs: [] } }).ok, false);
  assert.equal(validateToolCall({ tool: "worker_complete", args: { workerRunRef: "worker-0001", outcome: "DONE" } }).ok, false);
});

test("tools outside the allowlist are rejected", () => {
  for (const tool of ["adb_tap", "shell", "http_request", "db_query", "lease_revoke", "phone_pay"]) {
    assert.equal(validateToolCall({ tool, args: {} }).ok, false, `${tool} must be rejected`);
  }
});

test("raw coordinates and bounds are rejected, including unknown nested fields", () => {
  const base = { frameRef: HASH, blockId: HASH, intent: "tap" };
  for (const key of ["x", "y", "normalizedX", "bounds", "coordinates", "x1y"]) {
    assert.equal(validateToolCall({ tool: "phone_ground", args: { ...base, [key]: 100 } }).ok, false, key);
  }
  const nested = validateToolCall({ tool: "phone_ground", args: { ...base, region: { x: 1, y: 2 } } });
  assert.equal(nested.ok, false);
});

test("forbidden-key variants in any casing/separator style are caught after normalization", () => {
  const base = { frameRef: HASH, blockId: HASH, intent: "tap" };
  const variants = ["payment_value", "paymentValue", "payment-value", "adb_port", "adbPort", "adb-port", "adbSerial", "db_path", "http_url", "access_token", "lease_mutation", "card_number", "screenshot_base64"];
  for (const key of variants) {
    assert.equal(validateToolCall({ tool: "phone_ground", args: { ...base, [key]: "1" } }).ok, false, key);
  }
});

test("ADB transport, shell, URLs, tokens, lease mutation and DB access are rejected", () => {
  const attempts = [
    { tool: "phone_observe", args: { sessionRef: "127.0.0.1:5555" } },
    { tool: "trace_query", args: { traceId: "http://127.0.0.1:17930/trace" } },
    { tool: "phone_observe", args: { sessionRef: REF, port: 22222 } },
    { tool: "phone_observe", args: { sessionRef: REF, shell: "input tap 1 2" } },
    { tool: "phone_observe", args: { sessionRef: REF, token: "abc" } },
    { tool: "phone_act", args: { groundingDecisionRef: HASH, operationKey: "opkey-0001", revokeLease: true } },
    { tool: "trace_query", args: { traceId: "trace-0001", query: "SELECT * FROM actions" } },
    { tool: "phone_observe", args: { sessionRef: REF, dbPath: "C:/control.db" } },
  ];
  for (const attempt of attempts) {
    assert.equal(validateToolCall(attempt).ok, false, JSON.stringify(attempt.args));
  }
});

test("payment values, credentials and raw screenshot base64 are rejected", () => {
  const base64Blob = "A".repeat(1024);
  const attempts = [
    { tool: "phone_act", args: { groundingDecisionRef: HASH, operationKey: "opkey-0001", amount: 39.0 } },
    { tool: "phone_ground", args: { frameRef: HASH, blockId: HASH, intent: "tap", password: "123456" } },
    { tool: "checkpoint_save", args: { stateRefs: ["state-0001"], screenshotBase64: base64Blob } },
    { tool: "phone_verify", args: { actionReceiptRef: base64Blob, expectation: "x" } },
  ];
  for (const attempt of attempts) {
    assert.equal(validateToolCall(attempt).ok, false, JSON.stringify(Object.keys(attempt.args)));
  }
});

test("unknown extra arguments fail closed even when the values look harmless", () => {
  assert.equal(validateToolCall({ tool: "phone_observe", args: { sessionRef: REF, debug: true } }).ok, false);
  assert.equal(validateToolCall({ tool: "phone_observe", args: { sessionRef: REF } }).ok, true);
});
