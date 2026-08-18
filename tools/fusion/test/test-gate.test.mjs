import assert from "node:assert/strict";
import test from "node:test";
import { allowedNamesFor, evaluateSuite, parseFailingNames, parseSummary, runTestGate } from "../test-gate.mjs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sample = `
✔ ok test (1ms)
✖ allowed flake (2ms)
ℹ tests 3
ℹ pass 1
ℹ fail 2
ℹ skipped 0

✖ failing tests:

test at tests\\a.test.mjs:1:1
✖ allowed flake (2ms)
  AssertionError [ERR_ASSERTION]: boom

test at tests\\b.test.mjs:1:1
✖ brand new failure (3ms)
  Error: nope
`;

test("parseFailingNames reads the summary block only", () => {
  assert.deepEqual(parseFailingNames(sample), [
    "allowed flake",
    "brand new failure",
  ]);
});

test("parseSummary reads node --test footer", () => {
  assert.deepEqual(parseSummary(sample), {
    tests: 3,
    pass: 1,
    fail: 2,
    skipped: 0,
  });
});

test("evaluateSuite treats allowlisted names as known failures", () => {
  const known = evaluateSuite(["allowed flake"], ["allowed flake"]);
  assert.equal(known.status, "KNOWN_FAILURE_MATCH");
  assert.deepEqual(known.unexpectedFailures, []);
});

test("evaluateSuite blocks names outside the allowlist", () => {
  const blocked = evaluateSuite(["allowed flake"], ["allowed flake", "brand new failure"]);
  assert.equal(blocked.status, "BLOCK");
  assert.deepEqual(blocked.unexpectedFailures, ["brand new failure"]);
});

test("evaluateSuite passes when nothing failed", () => {
  assert.equal(evaluateSuite(["allowed flake"], []).status, "PASS");
});

test("runTestGate blocks unknown suite names", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const report = runTestGate(root, { only: "does-not-exist" });
  assert.equal(report.status, "BLOCK");
  assert.deepEqual(report.unexpectedFailures, ["unknown suite: does-not-exist"]);
});

test("allowedNamesFor unions posix extras only on posix", () => {
  const suite = {
    allowedFailures: ["shared"],
    allowedFailuresPosix: ["linux only"],
    allowedFailuresWin32: ["windows only"],
  };
  assert.deepEqual(allowedNamesFor(suite, "posix"), ["shared", "linux only"]);
  assert.deepEqual(allowedNamesFor(suite, "win32"), ["shared", "windows only"]);
});
