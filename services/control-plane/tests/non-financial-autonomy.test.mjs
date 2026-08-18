import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { validateJsonSchema } from "../control-plane/lib/json-schema-validator.mjs";

const cases = JSON.parse(readFileSync(new URL("./fixtures/nonpayment-autonomy/cases.json", import.meta.url), "utf8"));
const schema = JSON.parse(readFileSync(new URL("../control-plane/schema/nonpayment-autonomy.schema.json", import.meta.url), "utf8"));

test("schema executable validator enforces the payment-only conditional", () => {
  const invalidCommit = {
    schemaId: "xhs.nonpayment-autonomy.v1",
    schemaVersion: 1,
    actionClass: "financial_commit",
    decision: "dispatch_known",
    humanApprovalRequired: false,
    paymentHold: false
  };
  assert.notEqual(
    validateJsonSchema(invalidCommit, schema).length,
    0,
    "RED: the zero-dependency validator must support the contract conditional"
  );
});

test("nonpayment policy accepts every nonpayment case and holds only final payment", async () => {
  const module = await import("../control-plane/lib/nonpayment-autonomy-policy.mjs").catch(() => null);
  assert.ok(module?.evaluateNonpaymentAutonomy, "RED: nonpayment autonomy policy is not implemented");
  for (const fixture of cases) {
    const actual = module.evaluateNonpaymentAutonomy(fixture.input);
    assert.deepEqual(
      {
        decision: actual.decision,
        humanApprovalRequired: actual.humanApprovalRequired,
        paymentHold: actual.paymentHold
      },
      fixture.expected,
      fixture.name
    );
  }
});
