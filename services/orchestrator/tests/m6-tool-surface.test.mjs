import assert from "node:assert/strict";
import test from "node:test";

import { M6_TOOL_CLASSES, M6_TOOL_NAMES, M6_TOOL_SURFACE, validateToolCall } from "../scripts/lib/m6/m6-tool-surface.mjs";

test("the tool surface is exactly the eight M6 tool classes from the contract", () => {
  assert.equal(M6_TOOL_CLASSES.length, 8);
  for (const tool of M6_TOOL_NAMES) {
    assert.ok(Array.isArray(M6_TOOL_SURFACE[tool]));
  }
});

test("well-formed calls for every allowlisted tool pass", () => {
  const good = [
    { tool: "phone_observe", args: { sessionRef: "sess-01" } },
    { tool: "phone_ground", args: { frameRef: "f".repeat(64), blockId: "b".repeat(64), intent: "tap" } },
    { tool: "phone_act", args: { groundingDecisionRef: "d".repeat(64), operationKey: "op-1" } },
    { tool: "phone_verify", args: { actionReceiptRef: "r-1", expectation: "搜索结果页出现" } },
    { tool: "checkpoint_save", args: { stateRefs: ["s1", "s2"] } },
    { tool: "trace_query", args: { traceId: "t-1" } },
    { tool: "wait_human", args: { reason: "hard stop", evidenceRefs: ["e-1"] } },
    { tool: "worker_start", args: { workerRunRef: "w-1" } },
    { tool: "worker_continue", args: { workerRunRef: "w-1", checkpointRef: "c-1" } },
    { tool: "worker_complete", args: { workerRunRef: "w-1", outcome: "SUCCEEDED" } },
  ];
  for (const call of good) {
    assert.deepEqual(validateToolCall(call).errors, [], `${call.tool} should pass`);
  }
});

test("tools outside the allowlist are rejected", () => {
  for (const tool of ["adb_tap", "shell", "http_request", "db_query", "lease_revoke", "phone_pay"]) {
    assert.equal(validateToolCall({ tool, args: {} }).ok, false, `${tool} must be rejected`);
  }
});

test("raw coordinates and bounds are rejected, including unknown nested fields", () => {
  const base = { frameRef: "f".repeat(64), blockId: "b".repeat(64), intent: "tap" };
  for (const key of ["x", "y", "normalizedX", "bounds", "coordinates"]) {
    assert.equal(validateToolCall({ tool: "phone_ground", args: { ...base, [key]: 100 } }).ok, false, key);
  }
  const nested = validateToolCall({ tool: "phone_verify", args: { actionReceiptRef: "r-1", expectation: { region: { x: 1, y: 2 } } } });
  assert.equal(nested.ok, false);
});

test("ADB transport, shell, URLs, tokens, lease mutation and DB access are rejected", () => {
  const attempts = [
    { tool: "phone_observe", args: { sessionRef: "s", adbSerial: "127.0.0.1:5555" } },
    { tool: "phone_observe", args: { sessionRef: "127.0.0.1:5555" } },
    { tool: "phone_observe", args: { sessionRef: "s", port: 22222 } },
    { tool: "phone_observe", args: { sessionRef: "s", shell: "input tap 1 2" } },
    { tool: "trace_query", args: { traceId: "http://127.0.0.1:17930/trace" } },
    { tool: "phone_observe", args: { sessionRef: "s", token: "abc" } },
    { tool: "phone_act", args: { groundingDecisionRef: "d".repeat(64), operationKey: "k", revokeLease: true } },
    { tool: "trace_query", args: { traceId: "t", query: "SELECT * FROM actions" } },
    { tool: "phone_observe", args: { sessionRef: "s", dbPath: "C:/control.db" } },
  ];
  for (const attempt of attempts) {
    assert.equal(validateToolCall(attempt).ok, false, JSON.stringify(attempt.args));
  }
});

test("payment values, credentials and raw screenshot base64 are rejected", () => {
  const base64Blob = "A".repeat(1024);
  const attempts = [
    { tool: "phone_act", args: { groundingDecisionRef: "d".repeat(64), operationKey: "k", amount: 39.0 } },
    { tool: "phone_ground", args: { frameRef: "f".repeat(64), blockId: "b".repeat(64), intent: "tap", password: "123456" } },
    { tool: "checkpoint_save", args: { stateRefs: ["s"], screenshotBase64: base64Blob } },
    { tool: "phone_verify", args: { actionReceiptRef: base64Blob, expectation: "x" } },
  ];
  for (const attempt of attempts) {
    assert.equal(validateToolCall(attempt).ok, false, JSON.stringify(Object.keys(attempt.args)));
  }
});

test("unknown extra arguments fail closed even when the values look harmless", () => {
  assert.equal(validateToolCall({ tool: "phone_observe", args: { sessionRef: "s", debug: true } }).ok, false);
  assert.equal(validateToolCall({ tool: "phone_observe", args: { sessionRef: "s" } }).ok, true);
});
