import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CapabilityRegistry, validateAgainstSchema } from "../control-plane/lib/capability-registry.mjs";

test("repository capabilities use the unified E0-E4 manifest", () => {
  const registry = CapabilityRegistry.load(fileURLToPath(new URL("../apps", import.meta.url)));
  assert.equal(registry.capabilities.length, 17);
  assert.equal(new Set(registry.capabilities.map((item) => item.id)).size, 17);
  assert.equal(registry.capabilities.some((item) => /^D/.test(item.maturity)), false);
  assert.equal(registry.capabilities.every((item) => /^E[0-4]$/.test(item.maturity)), true);
  assert.equal(registry.listPublic().some((item) => Object.hasOwn(item, "implementation")), false);
});

test("pure and draft-producing Xianyu full dry-runs have separate contracts", () => {
  const registry = CapabilityRegistry.load(fileURLToPath(new URL("../apps", import.meta.url)));
  const pure = registry.require("xianyu.publish.full_dry_run");
  const draft = registry.require("xianyu.publish.full_draft_dry_run");

  assert.equal(pure.idempotency, "replay_safe");
  assert.equal(pure.automationPolicy.mode, "automatic");
  assert.throws(
    () => registry.validateParams(pure.id, { saveDraft: true }),
    { code: "PARAMS_SCHEMA_INVALID" },
  );
  assert.doesNotThrow(() => registry.validateParams(pure.id, { saveDraft: false }));

  assert.equal(draft.idempotency, "external_effect");
  assert.equal(draft.automationPolicy.mode, "approval_required");
  assert.throws(
    () => registry.validateParams(draft.id, { saveDraft: false }),
    { code: "PARAMS_SCHEMA_INVALID" },
  );
  assert.doesNotThrow(() => registry.validateParams(draft.id, { saveDraft: true }));
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
