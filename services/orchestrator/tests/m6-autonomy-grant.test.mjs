import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { sha256Hex } from "../scripts/lib/m6/m6-contracts.mjs";
import { computeEffectiveScope, validateAutonomyGrant } from "../scripts/lib/m6/m6-autonomy-grant.mjs";

const FIXTURES = path.resolve(import.meta.dirname, "fixtures/m6");
const readFixture = (name) => JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8"));

const REGISTERED_FAMILIES = ["observe", "open_app", "tap", "scroll", "input", "search", "back", "wait"];
const SPEC_LIMITS = { maxSteps: 50, maxActions: 100, maxTokens: 500000, wallClockSeconds: 1800 };
const NOW = "2026-08-20T10:00:00.000Z";

test("a well-formed grant from a trusted actor passes within scope, budget and validity window", () => {
  const grant = readFixture("autonomy-grant.valid.json");
  const result = validateAutonomyGrant(grant, {
    registeredActionFamilies: REGISTERED_FAMILIES,
    skillSpecLimits: SPEC_LIMITS,
    now: NOW,
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test("model-issued grants are invalid", () => {
  const grant = readFixture("autonomy-grant.model-issued.invalid.json");
  const result = validateAutonomyGrant(grant, { registeredActionFamilies: REGISTERED_FAMILIES, now: NOW });
  assert.equal(result.ok, false);
});

test("grants can never authorize payment or delete intents, even when explicitly listed", () => {
  const paymentGrant = readFixture("autonomy-grant.payment-intent.invalid.json");
  const result = validateAutonomyGrant(paymentGrant, { registeredActionFamilies: [...REGISTERED_FAMILIES, "payment"], now: NOW });
  assert.equal(result.ok, false);
  assert.match(result.errors.map((e) => e.message).join(";"), /hard-redline intent/);

  for (const redline of ["delete", "purchase", "transfer", "uninstall", "clear-data"]) {
    const grant = readFixture("autonomy-grant.valid.json");
    grant.scope.intents = [...grant.scope.intents, redline];
    assert.equal(validateAutonomyGrant(grant, { now: NOW }).ok, false, `${redline} must be rejected`);
  }
});

test("unregistered intents, forged goal bindings and unknown fields are rejected", () => {
  const grant = readFixture("autonomy-grant.valid.json");
  const unknown = structuredClone(grant);
  unknown.scope.intents = ["shell_exec"];
  assert.equal(validateAutonomyGrant(unknown, { registeredActionFamilies: REGISTERED_FAMILIES, now: NOW }).ok, false);

  const forgedGoal = structuredClone(grant);
  forgedGoal.goal.raw = "给主播打赏";
  assert.equal(validateAutonomyGrant(forgedGoal, { now: NOW }).ok, false);

  const extra = structuredClone(grant);
  extra.approvalOverride = "model-says-ok";
  assert.equal(validateAutonomyGrant(extra, { now: NOW }).ok, false);
});

test("budgets must be positive and within the AgenticSkillSpec maximums", () => {
  const grant = readFixture("autonomy-grant.valid.json");
  const over = structuredClone(grant);
  over.budgets.maxActions = SPEC_LIMITS.maxActions + 1;
  assert.equal(validateAutonomyGrant(over, { skillSpecLimits: SPEC_LIMITS, now: NOW }).ok, false);

  const zero = structuredClone(grant);
  zero.budgets.maxSteps = 0;
  assert.equal(validateAutonomyGrant(zero, { now: NOW }).ok, false);
});

test("expired, not-yet-valid and inverted grants are rejected", () => {
  const grant = readFixture("autonomy-grant.valid.json");
  assert.equal(validateAutonomyGrant(grant, { now: "2028-01-01T00:00:00.000Z" }).ok, false);
  assert.equal(validateAutonomyGrant(grant, { now: "2020-01-01T00:00:00.000Z" }).ok, false);

  const inverted = structuredClone(grant);
  inverted.notAfter = inverted.notBefore;
  assert.equal(validateAutonomyGrant(inverted, { now: NOW }).ok, false);
});

test("the hard-redline policy reference is pinned and cannot be swapped by the grant", () => {
  const grant = readFixture("autonomy-grant.valid.json");
  assert.equal(validateAutonomyGrant(grant, { knownRedlinePolicySha256: grant.hardRedlinePolicyRef.policySha256, now: NOW }).ok, true);

  const swapped = structuredClone(grant);
  swapped.hardRedlinePolicyRef = { policyVersion: "0.0.0", policySha256: sha256Hex("weakened-policy") };
  assert.equal(validateAutonomyGrant(swapped, { knownRedlinePolicySha256: grant.hardRedlinePolicyRef.policySha256, now: NOW }).ok, false);
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
