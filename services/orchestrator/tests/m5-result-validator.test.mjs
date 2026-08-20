import assert from "node:assert/strict";
import test from "node:test";
import { validateM5CardCount } from "../scripts/lib/m5-result-validator.mjs";

test("M5 card-count validator aggregates in alias order", () => {
  const result = validateM5CardCount({
    expectedAliases: ["04", "02", "01", "03"],
    results: [
      { alias: "03", output: { cards: [1, 2, 3] } },
      { alias: "01", output: { cardCount: 5 } },
      { alias: "04", output: { items: [1] } },
      { alias: "02", output: { cardCount: 0 } },
    ],
  });
  assert.deepEqual(result, {
    ok: true,
    code: "M5_VALIDATION_PASSED",
    byAlias: { "01": 5, "02": 0, "03": 3, "04": 1 },
    totalCardCount: 9,
  });
});

test("M5 card-count validator fails closed on missing, duplicate, or invalid output", () => {
  assert.equal(validateM5CardCount({ results: [] }).code, "M5_VALIDATION_EMPTY");
  assert.equal(validateM5CardCount({ results: [{ alias: "01", output: {} }] }).code, "M5_VALIDATION_CARD_COUNT");
  assert.equal(validateM5CardCount({ results: [{ alias: "01", output: { cardCount: 1 } }, { alias: "01", output: { cardCount: 2 } }] }).code, "M5_VALIDATION_DUPLICATE_ALIAS");
  assert.equal(validateM5CardCount({ expectedAliases: ["01", "02"], results: [{ alias: "01", output: { cardCount: 1 } }] }).code, "M5_VALIDATION_MISSING_ALIAS");
});
