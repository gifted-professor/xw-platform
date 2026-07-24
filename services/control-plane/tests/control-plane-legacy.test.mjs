import assert from "node:assert/strict";
import test from "node:test";

import { guardLegacyUiRoute } from "../control-plane/lib/legacy-guard.mjs";

test("legacy guard audits by default without sending device identifiers", async () => {
  const calls = [];
  const result = await guardLegacyUiRoute({
    source: "dashboard",
    action: "primitive.feedCards",
    actorPresent: true,
    mode: "audit",
    fetchImpl: async (_url, options) => {
      calls.push(JSON.parse(options.body));
      return new Response("{}", { status: 202 });
    },
  });
  assert.deepEqual(result, { allowed: true, mode: "audit" });
  assert.deepEqual(calls[0], {
    source: "dashboard",
    action: "primitive.feedCards",
    actorPresent: true,
    mode: "audit",
  });
  assert.doesNotMatch(JSON.stringify(calls[0]), /serial|runtimeId/);
});

test("legacy enforce mode returns the lease-style 423 blocker", async () => {
  await assert.rejects(
    guardLegacyUiRoute({
      source: "dashboard",
      action: "home",
      mode: "enforce",
      fetchImpl: async () => new Response("{}", { status: 202 }),
    }),
    { code: "LEGACY_ROUTE_BLOCKED", status: 423 },
  );
});
