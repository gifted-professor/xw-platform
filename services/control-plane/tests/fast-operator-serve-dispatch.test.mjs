import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import { serve } from "../scripts/fast-operator.mjs";

async function post(server, body) {
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test("fast-operator serve dispatch honors the top-level governed collect contract", async (t) => {
  const collectCalls = [];
  const operator = {
    async collectOnOpenNote(input) {
      collectCalls.push(input);
      return { ok: true, collected: true };
    },
    metricsSummary() { return {}; },
  };
  const server = serve(0, {
    adb: "offline-test-adb",
    serial: "offline-test-runtime",
    authorize: async () => ({ authorized: true }),
    operatorFactory: async () => operator,
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, "listening");

  const accepted = await post(server, {
    action: "collectOnOpenNote",
    observationReceiptId: "receipt-a",
    targetFingerprint: "target-a",
  });
  assert.equal(accepted.status, 200);
  assert.deepEqual(accepted.body.result, { ok: true, collected: true });
  assert.deepEqual(collectCalls, [{ targetFingerprint: "target-a" }]);

  for (const invalid of [
    { action: "collectOnOpenNote", targetFingerprint: "target-a" },
    { action: "collectOnOpenNote", observationReceiptId: "", targetFingerprint: "target-a" },
    {
      action: "collectOnOpenNote",
      observationReceiptId: "receipt-a",
      observation: { targetFingerprint: "target-a" },
    },
  ]) {
    const rejected = await post(server, invalid);
    assert.equal(rejected.status, 200);
    assert.deepEqual(rejected.body.result, {
      ok: false,
      notSent: true,
      step: "receiptBindingInvalid",
    });
  }
  assert.equal(collectCalls.length, 1, "invalid requests must not reach the collect operator");

  const unknown = await post(server, { action: "notAnOperatorAction" });
  assert.equal(unknown.status, 400);
  assert.deepEqual(unknown.body, { error: "unknown action" });
});
