import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { evaluateHardRedline } from "../scripts/lib/m6/m6-hard-redline.mjs";

const FIXTURES = path.resolve(import.meta.dirname, "fixtures/m6");
const POLICY = JSON.parse(readFileSync(path.join(FIXTURES, "hard-redline-policy.valid.json"), "utf8"));

const evaluate = (input) => evaluateHardRedline({ policy: POLICY, ...input });

test("payment/delete intents hard stop regardless of any grant or config", () => {
  for (const intent of ["payment", "purchase", "transfer", "tip", "subscription", "credential-submit", "delete", "uninstall", "clear-data"]) {
    assert.equal(evaluate({ intent }), "HARD_STOP", `${intent} must HARD_STOP`);
  }
});

test("synonyms and localized labels in any block signal hard stop", () => {
  assert.equal(evaluate({ intent: "tap", blockSignals: { ocrText: "确认支付 ¥39.00" } }), "HARD_STOP");
  assert.equal(evaluate({ intent: "tap", blockSignals: { semanticLabel: "立即购买" } }), "HARD_STOP");
  assert.equal(evaluate({ intent: "tap", blockSignals: { resourceId: "com.xingin.xhs:id/btn_transfer" } }), "HARD_STOP");
  assert.equal(evaluate({ intent: "tap", blockSignals: { a11yLabel: "删除此笔记" } }), "HARD_STOP");
  assert.equal(evaluate({ intent: "input", blockSignals: { ocrText: "请输入支付密码" } }), "HARD_STOP");
  assert.equal(evaluate({ intent: "tap", blockSignals: { semanticLabel: "uninstall this app" } }), "HARD_STOP");
});

test("icon-button labels without text still hard stop", () => {
  assert.equal(evaluate({ intent: "tap", blockSignals: { iconLabel: "pay-icon" } }), "HARD_STOP");
  assert.equal(evaluate({ intent: "tap", blockSignals: { iconLabel: "trash-icon" } }), "HARD_STOP");
});

test("block category payment/delete hard stops even with a forged benign intent", () => {
  assert.equal(evaluate({ intent: "tap", blockSignals: { category: "payment", semanticLabel: "福利" } }), "HARD_STOP");
  assert.equal(evaluate({ intent: "observe", blockSignals: { category: "delete" } }), "HARD_STOP");
});

test("risky pages with uncertain semantics replan instead of tapping through", () => {
  for (const riskClass of ["confirm-dialog", "payment-page", "order-page", "assets-page", "destructive-settings"]) {
    assert.equal(
      evaluate({ intent: "tap", blockSignals: { uncertain: true, semanticLabel: "确认" }, pageFingerprint: { riskClass } }),
      "REPLAN",
      `${riskClass} with uncertain semantics must REPLAN`,
    );
  }
});

test("empty dumps are conservative on risky pages but do not block normal pages", () => {
  assert.equal(
    evaluate({ intent: "tap", blockSignals: { emptyDump: true }, pageFingerprint: { riskClass: "payment-page" } }),
    "REPLAN",
  );
  assert.equal(
    evaluate({ intent: "tap", blockSignals: { emptyDump: true }, pageFingerprint: { riskClass: "normal" } }),
    "PASS",
  );
});

test("visual misclassification cannot pass a redline hit found by another signal", () => {
  // Vision says "content", OCR still sees the payment label: any single hit wins.
  assert.equal(
    evaluate({ intent: "tap", blockSignals: { category: "content", ocrText: "打赏作者" } }),
    "HARD_STOP",
  );
});

test("non-redline actions on normal pages pass with zero approval fields", () => {
  assert.equal(
    evaluate({ intent: "tap", blockSignals: { semanticLabel: "搜索" }, pageFingerprint: { riskClass: "normal" } }),
    "PASS",
  );
  assert.equal(
    evaluate({ intent: "scroll", blockSignals: { ocrText: "攀岩笔记" } }),
    "PASS",
  );
});

test("a benign-looking confirm dialog on a normal page passes only when semantics are certain", () => {
  assert.equal(
    evaluate({ intent: "tap", blockSignals: { semanticLabel: "知道了" }, pageFingerprint: { riskClass: "confirm-dialog" } }),
    "PASS",
  );
});
