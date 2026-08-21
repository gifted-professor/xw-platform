import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { computeRedlinePolicySha256 } from "../scripts/lib/m6/m6-contracts.mjs";
import { evaluateHardRedline, MINIMUM_REDLINE } from "../scripts/lib/m6/m6-hard-redline.mjs";

const FIXTURES = path.resolve(import.meta.dirname, "fixtures/m6");
const POLICY = JSON.parse(readFileSync(path.join(FIXTURES, "hard-redline-policy.valid.json"), "utf8"));
const POLICY_SHA = computeRedlinePolicySha256(POLICY);

const evaluate = (input) => evaluateHardRedline({ policy: POLICY, expectedPolicySha256: POLICY_SHA, ...input });

test("the pinned valid policy evaluates normally", () => {
  assert.equal(POLICY.policySha256, POLICY_SHA);
  const result = evaluate({ intent: "scroll" });
  assert.equal(result.verdict, "PASS");
  assert.equal(result.ok, true);
});

test("missing, invalid or unpinned policies fail closed as HARD_STOP with an error code", () => {
  const missing = evaluateHardRedline({ intent: "scroll" });
  assert.equal(missing.verdict, "HARD_STOP");
  assert.equal(missing.ok, false);
  assert.equal(missing.errors[0].code, "M6_REDLINE_POLICY_MISSING");

  const noHash = evaluateHardRedline({ intent: "scroll", policy: POLICY });
  assert.equal(noHash.verdict, "HARD_STOP");
  assert.equal(noHash.errors[0].code, "M6_REDLINE_POLICY_UNPINNED");

  const invalid = evaluateHardRedline({ intent: "scroll", policy: { schemaId: "xw.hard-redline-policy.v1" }, expectedPolicySha256: POLICY_SHA });
  assert.equal(invalid.verdict, "HARD_STOP");
  assert.equal(invalid.errors[0].code, "M6_REDLINE_POLICY_INVALID");
});

test("a weakened policy is rejected even when it keeps the old hash", () => {
  // Weakened content with the ORIGINAL pinned hash: hash mismatch → HARD_STOP.
  const weakenedStaleHash = structuredClone(POLICY);
  weakenedStaleHash.categories = weakenedStaleHash.categories.filter((category) => category.name !== "delete");
  const stale = evaluateHardRedline({ intent: "tap", policy: weakenedStaleHash, expectedPolicySha256: POLICY_SHA });
  assert.equal(stale.verdict, "HARD_STOP");
  assert.equal(stale.ok, false);

  // Weakened content with a self-consistent recomputed hash: the schema itself
  // requires all nine hard-deny categories, and the minimum-category check is
  // defense-in-depth on top — either way it can never evaluate.
  const weakenedRehashed = structuredClone(weakenedStaleHash);
  const repinned = computeRedlinePolicySha256(weakenedRehashed);
  const result = evaluateHardRedline({ intent: "delete", policy: weakenedRehashed, expectedPolicySha256: repinned });
  assert.equal(result.verdict, "HARD_STOP");
  assert.equal(result.ok, false);
  assert.ok(["M6_REDLINE_POLICY_INVALID", "M6_REDLINE_POLICY_WEAKENED"].includes(result.errors[0].code));
});

test("payment/delete intents hard stop regardless of any grant or config", () => {
  for (const intent of ["payment", "purchase", "transfer", "tip", "subscription", "credential-submit", "delete", "uninstall", "clear-data"]) {
    assert.equal(evaluate({ intent }).verdict, "HARD_STOP", `${intent} must HARD_STOP`);
  }
});

test("built-in minimum synonyms hold even if the policy omits them", () => {
  const sparsePolicy = structuredClone(POLICY);
  sparsePolicy.categories = sparsePolicy.categories.map((category) => ({ name: category.name, synonyms: [category.name] }));
  const sparseSha = computeRedlinePolicySha256(sparsePolicy);
  const result = evaluateHardRedline({
    intent: "tap",
    blockSignals: { ocrText: "确认支付" },
    policy: sparsePolicy,
    expectedPolicySha256: sparseSha,
  });
  assert.equal(result.verdict, "HARD_STOP");
  assert.ok(Object.keys(MINIMUM_REDLINE).length >= 9);
});

test("synonyms and localized labels in any block signal hard stop", () => {
  assert.equal(evaluate({ intent: "tap", blockSignals: { ocrText: "确认支付 ¥39.00" } }).verdict, "HARD_STOP");
  assert.equal(evaluate({ intent: "tap", blockSignals: { semanticLabel: "立即购买" } }).verdict, "HARD_STOP");
  assert.equal(evaluate({ intent: "tap", blockSignals: { resourceId: "com.xingin.xhs:id/btn_transfer" } }).verdict, "HARD_STOP");
  assert.equal(evaluate({ intent: "tap", blockSignals: { a11yLabel: "删除此笔记" } }).verdict, "HARD_STOP");
  assert.equal(evaluate({ intent: "input", blockSignals: { ocrText: "请输入支付密码" } }).verdict, "HARD_STOP");
  assert.equal(evaluate({ intent: "tap", blockSignals: { semanticLabel: "uninstall this app" } }).verdict, "HARD_STOP");
});

test("icon-button labels without text still hard stop", () => {
  assert.equal(evaluate({ intent: "tap", blockSignals: { iconLabel: "pay-icon" } }).verdict, "HARD_STOP");
  assert.equal(evaluate({ intent: "tap", blockSignals: { iconLabel: "trash-icon" } }).verdict, "HARD_STOP");
});

test("block category payment/delete hard stops even with a forged benign intent", () => {
  assert.equal(evaluate({ intent: "tap", blockSignals: { category: "payment", semanticLabel: "福利" } }).verdict, "HARD_STOP");
  assert.equal(evaluate({ intent: "observe", blockSignals: { category: "delete" } }).verdict, "HARD_STOP");
});

test("risky pages with uncertain semantics replan instead of tapping through", () => {
  for (const riskClass of ["confirm-dialog", "payment-page", "order-page", "assets-page", "destructive-settings"]) {
    assert.equal(
      evaluate({ intent: "tap", blockSignals: { uncertain: true, semanticLabel: "确认" }, pageFingerprint: { riskClass } }).verdict,
      "REPLAN",
      `${riskClass} with uncertain semantics must REPLAN`,
    );
  }
});

test("empty dumps are conservative on risky pages but do not block normal pages", () => {
  assert.equal(
    evaluate({ intent: "tap", blockSignals: { emptyDump: true }, pageFingerprint: { riskClass: "payment-page" } }).verdict,
    "REPLAN",
  );
  assert.equal(
    evaluate({ intent: "tap", blockSignals: { emptyDump: true }, pageFingerprint: { riskClass: "normal" } }).verdict,
    "PASS",
  );
});

test("visual misclassification cannot pass a redline hit found by another signal", () => {
  // Vision says "content", OCR still sees the payment label: any single hit wins.
  assert.equal(
    evaluate({ intent: "tap", blockSignals: { category: "content", ocrText: "打赏作者" } }).verdict,
    "HARD_STOP",
  );
});

test("non-redline actions on normal pages pass with zero approval fields", () => {
  assert.equal(
    evaluate({ intent: "tap", blockSignals: { semanticLabel: "搜索" }, pageFingerprint: { riskClass: "normal" } }).verdict,
    "PASS",
  );
  assert.equal(evaluate({ intent: "scroll", blockSignals: { ocrText: "攀岩笔记" } }).verdict, "PASS");
});

test("a benign-looking confirm dialog on a normal page passes only when semantics are certain", () => {
  assert.equal(
    evaluate({ intent: "tap", blockSignals: { semanticLabel: "知道了" }, pageFingerprint: { riskClass: "confirm-dialog" } }).verdict,
    "PASS",
  );
});
