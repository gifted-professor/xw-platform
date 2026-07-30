import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CapabilityRegistry, validateAgainstSchema } from "../control-plane/lib/capability-registry.mjs";
import { evaluateCapabilityPolicy } from "../control-plane/lib/policy.mjs";

test("repository capabilities use the unified E0-E4 manifest", () => {
  const registry = CapabilityRegistry.load(fileURLToPath(new URL("../apps", import.meta.url)));
  assert.equal(registry.capabilities.length, 22);
  assert.equal(new Set(registry.capabilities.map((item) => item.id)).size, 22);
  assert.equal(registry.capabilities.some((item) => /^D/.test(item.maturity)), false);
  assert.equal(registry.capabilities.every((item) => /^E[0-4]$/.test(item.maturity)), true);
  assert.equal(registry.listPublic().some((item) => Object.hasOwn(item, "implementation")), false);
});

test("standing-grant collect is schema-bound and cannot enter the ordinary job lane", () => {
  const registry = CapabilityRegistry.load(fileURLToPath(new URL("../apps", import.meta.url)));
  const collect = registry.require("xhs.collect.standing_grant");
  assert.throws(() => evaluateCapabilityPolicy(collect), { code: "STANDING_GRANT_MISSION_REQUIRED" });
  assert.deepEqual(evaluateCapabilityPolicy(collect, { invocation: "mission_effect" }), { approvalRequired: false, externalEffect: true });
  assert.throws(() => registry.validateParams(collect.id, { observationReceiptId: "receipt" }), { code: "PARAMS_SCHEMA_INVALID" });
  assert.doesNotThrow(() => registry.validateParams(collect.id, {
    observationReceiptId: "receipt", targetFingerprint: "target",
  }));
});

test("Flutter pointer tap probe is bounded, no-save, and restoration-required", () => {
  const registry = CapabilityRegistry.load(fileURLToPath(new URL("../apps", import.meta.url)));
  const probe = registry.require("xianyu.probe.flutter_pointer_tap");

  assert.equal(probe.automationPolicy.mode, "automatic");
  assert.equal(probe.risk, "R1");
  assert.equal(probe.restoration.required, true);
  assert.throws(() => evaluateCapabilityPolicy(probe), { code: "CANARY_SESSION_REQUIRED" });
  assert.deepEqual(evaluateCapabilityPolicy(probe, { canary: true, invocation: "session" }), {
    approvalRequired: false,
    externalEffect: false,
  });
  assert.throws(
    () => registry.validateParams(probe.id, {
      saveDraft: true,
    }),
    { code: "PARAMS_SCHEMA_INVALID" },
  );
  assert.doesNotThrow(() => registry.validateParams(probe.id, {
    saveDraft: false,
  }));
  assert.throws(() => registry.validateParams(probe.id, {
    saveDraft: false,
    skuSpecs: { "颜色": ["白色"] },
  }), { code: "PARAMS_SCHEMA_INVALID" });
});

test("pure and draft-producing Xianyu full dry-runs have separate contracts", () => {
  const registry = CapabilityRegistry.load(fileURLToPath(new URL("../apps", import.meta.url)));
  const pure = registry.require("xianyu.publish.full_dry_run");
  const draft = registry.require("xianyu.publish.full_draft_dry_run");

  assert.equal(pure.idempotency, "replay_safe");
  assert.equal(pure.automationPolicy.mode, "automatic");
  assert.equal(pure.timeoutMs, 720000);
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
  assert.doesNotThrow(() => validateAgainstSchema({ color: ["white"] }, {
    type: "object",
    minProperties: 1,
    maxProperties: 1,
    propertyNames: { type: "string", maxLength: 10 },
    additionalProperties: {
      type: "array",
      minItems: 1,
      maxItems: 2,
      items: { type: "string", minLength: 1, maxLength: 10 },
    },
  }));
});
