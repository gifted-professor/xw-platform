function fail(code, message, details = null) {
  return { ok: false, code, message, details };
}

function cardCount(output) {
  if (Number.isInteger(output?.cardCount) && output.cardCount >= 0) return output.cardCount;
  for (const key of ["cards", "items", "posts", "results"]) {
    if (Array.isArray(output?.[key])) return output[key].length;
  }
  return null;
}

export function validateM5CardCount({ results, expectedAliases = [] } = {}) {
  if (!Array.isArray(results) || results.length === 0) return fail("M5_VALIDATION_EMPTY", "results must be a non-empty array");
  const aliases = expectedAliases.length ? [...new Set(expectedAliases.map(String))].sort() : [];
  if (aliases.some((alias) => !/^0[1-4]$/.test(alias))) return fail("M5_VALIDATION_ALIAS", "expectedAliases must contain only 01..04");

  const byAlias = {};
  for (const result of results) {
    const alias = String(result?.alias || "");
    if (!/^0[1-4]$/.test(alias)) return fail("M5_VALIDATION_ALIAS", "every result requires alias 01..04");
    if (Object.hasOwn(byAlias, alias)) return fail("M5_VALIDATION_DUPLICATE_ALIAS", `duplicate result for alias ${alias}`);
    const count = cardCount(result.output);
    if (count === null) return fail("M5_VALIDATION_CARD_COUNT", `alias ${alias} has no non-negative cardCount or card array`);
    byAlias[alias] = count;
  }
  if (aliases.length && (aliases.length !== Object.keys(byAlias).length || aliases.some((alias) => !Object.hasOwn(byAlias, alias)))) {
    return fail("M5_VALIDATION_MISSING_ALIAS", "result aliases do not match the expected device set", { expected: aliases, actual: Object.keys(byAlias).sort() });
  }
  const ordered = Object.fromEntries(Object.entries(byAlias).sort(([left], [right]) => left.localeCompare(right)));
  return {
    ok: true,
    code: "M5_VALIDATION_PASSED",
    byAlias: ordered,
    totalCardCount: Object.values(ordered).reduce((sum, count) => sum + count, 0),
  };
}
