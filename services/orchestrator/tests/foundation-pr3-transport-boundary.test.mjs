import assert from "node:assert/strict";
import test from "node:test";

import {
  assertProductionBypassClosed,
  isWritePurpose,
} from "../scripts/lib/transport-action-authorization.mjs";
import { createFakeTypedTransport } from "../scripts/lib/typed-transport.mjs";

test("write purposes stay closed under XHS_ALLOW_BYPASS", () => {
  for (const purpose of ["execute", "restore", "return_home"]) {
    assert.equal(isWritePurpose(purpose), true);
    assert.throws(
      () => assertProductionBypassClosed({ env: { XHS_ALLOW_BYPASS: "1" }, purpose }),
      (e) => e.code === "TRANSPORT_BYPASS_DISABLED_P0",
    );
  }
});

test("registry TypedTransport fake remains offline-only", async () => {
  const fake = createFakeTypedTransport();
  const out = await fake.invoke({ purpose: "observe", action: "screen" });
  assert.equal(out.ok, true);
  assert.equal(fake.calls.length, 1);
});
