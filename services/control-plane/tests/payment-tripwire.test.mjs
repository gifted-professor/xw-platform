import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const fixtures = JSON.parse(readFileSync(new URL("./fixtures/payment-tripwire/cases.json", import.meta.url), "utf8"));

test("target-bound classifier holds verified final controls without keyword blanket blocking", async () => {
  const module = await import("../control-plane/lib/financial-commit-classifier.mjs").catch(() => null);
  assert.ok(module?.classifyFinancialCommit, "RED: financial commit classifier is not implemented");
  for (const fixture of fixtures.positive) {
    assert.equal(module.classifyFinancialCommit(fixture).actionClass, "financial_commit", fixture.name);
  }
  for (const fixture of fixtures.negative) {
    assert.notEqual(module.classifyFinancialCommit(fixture).actionClass, "financial_commit", fixture.name);
  }
});
