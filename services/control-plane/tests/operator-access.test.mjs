import assert from "node:assert/strict";
import test from "node:test";

import { requireRecordedLabBypass } from "../control-plane/lib/operator-access.mjs";

test("direct legacy operators require a recorded lab bypass", () => {
  assert.throws(
    () => requireRecordedLabBypass("legacy", { env: {}, logger: () => {} }),
    { code: "CONTROL_LEASE_REQUIRED", status: 423 },
  );
  assert.throws(
    () => requireRecordedLabBypass("legacy", {
      env: { XHS_ALLOW_BYPASS: "1" },
      logger: () => {},
    }),
    { code: "CONTROL_LEASE_REQUIRED", status: 423 },
  );
});

test("recorded bypass emits a bounded structured audit event", () => {
  const events = [];
  const result = requireRecordedLabBypass("legacy", {
    env: { XHS_ALLOW_BYPASS: "1", XHS_BYPASS_REASON: "x".repeat(250) },
    logger: (event) => events.push(event),
  });
  assert.deepEqual(result, { authorized: true, bypass: true });
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "operator.lease-bypass");
  assert.equal(events[0].source, "legacy");
  assert.equal(events[0].reason.length, 200);
});
