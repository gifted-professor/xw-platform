import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { sha256Hex } from "../scripts/lib/m6/m6-contracts.mjs";
import {
  computeEffectiveScope,
  validateAutonomyGrantShape,
  validateAutonomyGrantTrusted,
} from "../scripts/lib/m6/m6-autonomy-grant.mjs";

const FIXTURES = path.resolve(import.meta.dirname, "fixtures/m6");
const readFixture = (name) => JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8"));

const REGISTERED_FAMILIES = ["observe", "open_app", "tap", "scroll", "input", "search", "back", "wait"];
const SPEC_LIMITS = { maxSteps: 50, maxActions: 100, maxTokens: 500000, wallClockSeconds: 1800 };
const NOW = "2026-08-20T10:00:00.000Z";
const TRUSTED_ISSUER_REF = "authz-local-user-0001";

function trustedContext(overrides = {}) {
  const grant = readFixture("autonomy-grant.valid.json");
  return {
    registeredActionFamilies: REGISTERED_FAMILIES,
    knownRedlinePolicySha256: grant.hardRedlinePolicyRef.policySha256,
    trustedIssuerRef: TRUSTED_ISSUER_REF,
    now: NOW,
    skillSpecLimits: SPEC_LIMITS,
    ...overrides,
  };
}

test("shape validation checks the schema only and never implies trust", () => {
  const grant = readFixture("autonomy-grant.valid.json");
  assert.equal(validateAutonomyGrantShape(grant).ok, true);
  const extra = structuredClone(grant);
  extra.approvalOverride = "model-says-ok";
  assert.equal(validateAutonomyGrantShape(extra).ok, false);
});

test("a fully bound grant from the trusted issuer passes", () => {
  const grant = readFixture("autonomy-grant.valid.json");
  const result = validateAutonomyGrantTrusted(grant, trustedContext());
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test("trusted validation fails closed when any authoritative context field is missing", () => {
  const grant = readFixture("autonomy-grant.valid.json");
  for (const key of ["registeredActionFamilies", "knownRedlinePolicySha256", "trustedIssuerRef", "now"]) {
    const context = trustedContext();
    delete context[key];
    const result = validateAutonomyGrantTrusted(grant, context);
    assert.equal(result.ok, false, `missing ${key} must fail closed`);
    assert.ok(result.errors.some((e) => e.code === "M6_AUTONOMY_GRANT_CONTEXT_MISSING"), key);
  }
  assert.equal(validateAutonomyGrantTrusted(grant, undefined).ok, false);
  // An empty registry authorizes nothing.
  assert.equal(
    validateAutonomyGrantTrusted(grant, trustedContext({ registeredActionFamilies: [] })).ok,
    false,
  );
});

test("self-declared issuer kind without the trusted authorizationRef is rejected", () => {
  const grant = readFixture("autonomy-grant.valid.json");
  // Forged kind=user with no authorizationRef at all.
  const noRef = structuredClone(grant);
  delete noRef.issuer.authorizationRef;
  assert.equal(validateAutonomyGrantTrusted(noRef, trustedContext()).ok, false);
  // Wrong authorizationRef.
  const wrongRef = structuredClone(grant);
  wrongRef.issuer.authorizationRef = "authz-forged-9999";
  assert.equal(validateAutonomyGrantTrusted(wrongRef, trustedContext()).ok, false);
  // Model-issued documents are not representable at all.
  const modelIssued = readFixture("autonomy-grant.model-issued.invalid.json");
  assert.equal(validateAutonomyGrantShape(modelIssued).ok, false);
  assert.equal(validateAutonomyGrantTrusted(modelIssued, trustedContext()).ok, false);
});

test("grants can never authorize payment or delete intents, even when explicitly listed", () => {
  const paymentGrant = readFixture("autonomy-grant.payment-intent.invalid.json");
  const result = validateAutonomyGrantTrusted(
    paymentGrant,
    trustedContext({ registeredActionFamilies: [...REGISTERED_FAMILIES, "payment"] }),
  );
  assert.equal(result.ok, false);
  assert.match(result.errors.map((e) => e.message).join(";"), /hard-redline intent/);

  for (const redline of ["delete", "purchase", "transfer", "uninstall", "clear-data"]) {
    const grant = readFixture("autonomy-grant.valid.json");
    grant.scope.intents = [...grant.scope.intents, redline];
    assert.equal(validateAutonomyGrantTrusted(grant, trustedContext()).ok, false, `${redline} must be rejected`);
  }
});

test("a grant whose intents collapse to nothing after redline removal fails closed", () => {
  const grant = readFixture("autonomy-grant.valid.json");
  grant.scope.intents = ["payment", "delete"];
  assert.equal(validateAutonomyGrantTrusted(grant, trustedContext()).ok, false);
  const unknownOnly = readFixture("autonomy-grant.valid.json");
  unknownOnly.scope.intents = ["shell_exec"];
  assert.equal(validateAutonomyGrantTrusted(unknownOnly, trustedContext()).ok, false);
});

test("unregistered intents, forged goal bindings and swapped redline refs are rejected", () => {
  const grant = readFixture("autonomy-grant.valid.json");
  const unknown = structuredClone(grant);
  unknown.scope.intents = ["observe", "shell_exec"];
  assert.equal(validateAutonomyGrantTrusted(unknown, trustedContext()).ok, false);

  const forgedGoal = structuredClone(grant);
  forgedGoal.goal.raw = "给主播打赏";
  assert.equal(validateAutonomyGrantTrusted(forgedGoal, trustedContext()).ok, false);

  const swapped = structuredClone(grant);
  swapped.hardRedlinePolicyRef = { policyVersion: "0.0.0", policySha256: sha256Hex("weakened-policy") };
  assert.equal(validateAutonomyGrantTrusted(swapped, trustedContext()).ok, false);
});

test("budgets must be positive and within the AgenticSkillSpec maximums", () => {
  const grant = readFixture("autonomy-grant.valid.json");
  const over = structuredClone(grant);
  over.budgets.maxActions = SPEC_LIMITS.maxActions + 1;
  assert.equal(validateAutonomyGrantTrusted(over, trustedContext()).ok, false);

  const zero = structuredClone(grant);
  zero.budgets.maxSteps = 0;
  assert.equal(validateAutonomyGrantTrusted(zero, trustedContext()).ok, false);
});

test("expired, not-yet-valid and inverted grants are rejected", () => {
  const grant = readFixture("autonomy-grant.valid.json");
  assert.equal(validateAutonomyGrantTrusted(grant, trustedContext({ now: "2028-01-01T00:00:00.000Z" })).ok, false);
  assert.equal(validateAutonomyGrantTrusted(grant, trustedContext({ now: "2020-01-01T00:00:00.000Z" })).ok, false);

  const inverted = structuredClone(grant);
  inverted.notAfter = inverted.notBefore;
  assert.equal(validateAutonomyGrantTrusted(inverted, trustedContext()).ok, false);
});

test("computeEffectiveScope intersects spec, intents and limits, then subtracts the hard redline", () => {
  const skillSpec = {
    actionFamilies: ["observe", "tap", "scroll", "input"],
    apps: ["com.xingin.xhs"],
    maxBudgets: { maxSteps: 50, maxActions: 100, maxTokens: 500000, wallClockSeconds: 1800 },
  };
  const result = computeEffectiveScope({
    skillSpec,
    taskIntentSet: ["observe", "tap", "payment"],
    limits: { apps: ["com.xingin.xhs"], aliases: ["01"], budgets: { maxActions: 30 } },
    hardRedlineSet: ["delete"],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.scope.intents, ["observe", "tap"]);
  assert.deepEqual(result.scope.droppedIntents, ["payment"]);
  assert.equal(result.scope.budgets.maxActions, 30);
  assert.equal(result.scope.budgets.maxSteps, 50);
  assert.ok(result.scope.hardRedlineSet.includes("delete"));
  assert.ok(result.scope.hardRedlineSet.includes("payment"));
});

test("computeEffectiveScope fails closed when the intersection is empty or unbudgeted", () => {
  const emptyApps = computeEffectiveScope({
    skillSpec: { actionFamilies: ["observe"], apps: ["com.xingin.xhs"], maxBudgets: { maxSteps: 10 } },
    taskIntentSet: ["observe"],
    limits: { apps: ["com.other.app"] },
    hardRedlineSet: [],
  });
  assert.equal(emptyApps.ok, false);

  const redlineOnly = computeEffectiveScope({
    skillSpec: {
      actionFamilies: ["payment"],
      apps: ["com.xingin.xhs"],
      maxBudgets: { maxSteps: 10, maxActions: 10, maxTokens: 1000, wallClockSeconds: 60 },
    },
    taskIntentSet: ["payment"],
    limits: {},
    hardRedlineSet: [],
  });
  assert.equal(redlineOnly.ok, true);
  assert.deepEqual(redlineOnly.scope.intents, []);
});
