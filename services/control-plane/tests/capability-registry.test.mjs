import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CapabilityRegistry, validateAgainstSchema } from "../control-plane/lib/capability-registry.mjs";

test("repository capabilities use the unified E0-E4 manifest", () => {
  const registry = CapabilityRegistry.load(fileURLToPath(new URL("../apps", import.meta.url)));
  assert.equal(registry.capabilities.length, 13);
  assert.equal(new Set(registry.capabilities.map((item) => item.id)).size, 13);
  assert.equal(registry.capabilities.some((item) => /^D/.test(item.maturity)), false);
  assert.equal(registry.capabilities.every((item) => /^E[0-4]$/.test(item.maturity)), true);
  assert.equal(registry.listPublic().some((item) => Object.hasOwn(item, "implementation")), false);
});

test("input schema rejects missing and unknown parameters", () => {
  const registry = CapabilityRegistry.load(fileURLToPath(new URL("../apps", import.meta.url)));
  assert.throws(
    () => registry.validateParams("xhs.input.comment_dry_run", {}),
    { code: "PARAMS_SCHEMA_INVALID" },
  );
  assert.throws(
    () => registry.validateParams("xhs.input.comment_dry_run", { text: "ok", secret: true }),
    { code: "PARAMS_SCHEMA_INVALID" },
  );
  assert.doesNotThrow(
    () => registry.validateParams("xhs.input.comment_dry_run", { text: "bounded probe" }),
  );
});

test("small schema validator supports arrays and bounds", () => {
  assert.doesNotThrow(() => validateAgainstSchema([1, 2], {
    type: "array",
    items: { type: "integer", minimum: 1, maximum: 2 },
  }));
  assert.throws(() => validateAgainstSchema([0], {
    type: "array",
    items: { type: "integer", minimum: 1 },
  }), { code: "PARAMS_SCHEMA_INVALID" });
});
