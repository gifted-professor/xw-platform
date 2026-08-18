import assert from "node:assert/strict";
import test from "node:test";

import { requireRecordedLabBypass } from "../control-plane/lib/operator-access.mjs";

test("direct legacy operators require a recorded lab bypass", () => {
  assert.throws(
    () => requireRecordedLabBypass("legacy", { env: {}, logger: () => {}, purpose: "observe" }),
    { code: "CONTROL_LEASE_REQUIRED", status: 423 },
  );
  assert.throws(
    () => requireRecordedLabBypass("legacy", {
      env: { XHS_ALLOW_BYPASS: "1" },
      logger: () => {},
      purpose: "observe",
    }),
    { code: "CONTROL_LEASE_REQUIRED", status: 423 },
  );
});

test("recorded observe bypass emits a bounded structured audit event", () => {
  const events = [];
  const result = requireRecordedLabBypass("legacy", {
    env: { XHS_ALLOW_BYPASS: "1", XHS_BYPASS_REASON: "x".repeat(250) },
    purpose: "observe",
    logger: (event) => events.push(event),
  });
  assert.deepEqual(result, { authorized: true, bypass: true, write: false });
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "operator.lease-bypass");
  assert.equal(events[0].source, "legacy");
  assert.equal(events[0].purpose, "observe");
  assert.equal(events[0].reason.length, 200);
});

test("write purpose bypass is closed even with recorded reason", () => {
  assert.throws(
    () => requireRecordedLabBypass("legacy", {
      env: { XHS_ALLOW_BYPASS: "1", XHS_BYPASS_REASON: "lab" },
      purpose: "execute",
      logger: () => {},
    }),
    (e) => e.code === "TRANSPORT_BYPASS_DISABLED_P0",
  );
});
