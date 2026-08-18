import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { canonicalize, canonicalSha256 } from "../jcs.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fx = join(here, "fixtures", "rfc8785");

// Official RFC 8785 conformance vectors from cyberphone/json-canonicalization/testdata.
// Byte-exact comparison of canonicalize(JSON.parse(input)) against the official output.
// These vectors cover number serialization, string escaping (incl. controls, U+007F,
// non-ASCII), and key sorting (incl. surrogate pairs vs U+FB33, empty key, locale).
const vectors = readdirSync(join(fx, "input"))
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.replace(/\.json$/, ""));

for (const name of vectors) {
  test(`rfc8785 vector: ${name}`, () => {
    const input = readFileSync(join(fx, "input", `${name}.json`), "utf8");
    const expected = readFileSync(join(fx, "output", `${name}.json`), "utf8").trimEnd();
    assert.equal(canonicalize(JSON.parse(input)), expected, `vector ${name} mismatch`);
  });
}

// Targeted regression tests for structural rules (no embedded control chars).

test("object keys sorted by UTF-16 code units (surrogate pair before U+FB33)", () => {
  const out = canonicalize({ "דּ": 1, "\u{1F602}": 2 });
  assert.equal(out, '{"😂":2,"דּ":1}', "surrogate-pair sort order wrong");
});

test("empty string key sorts first", () => {
  assert.equal(canonicalize({ a: 1, "": 0, A: 2 }), '{"":0,"A":2,"a":1}');
});

test("string order is lexicographic, not numeric (10 < 111 < 2)", () => {
  assert.equal(canonicalize({ "2": "a", "10": "b", "111": "c" }), '{"10":"b","111":"c","2":"a"}');
});

test("numbers serialize via JSON.stringify shortest round-trip", () => {
  assert.equal(canonicalize([1.0, 4.50, 2e-3, 1e30, 1e-27]), "[1,4.5,0.002,1e+30,1e-27]");
});

test("no whitespace anywhere", () => {
  assert.equal(canonicalize({ a: [1, 2], b: { c: 3 } }), '{"a":[1,2],"b":{"c":3}}');
});

test("nested objects sort recursively", () => {
  assert.equal(canonicalize({ z: { b: 1, a: 0 }, a: 2 }), '{"a":2,"z":{"a":0,"b":1}}');
});

test("unicode is NOT normalized (input value preserved verbatim)", () => {
  const val = "Å"; // A + combining ring (decomposed)
  assert.equal(canonicalize({ x: val }), '{"x":"Å"}');
});

test("canonicalSha256 is lowercase hex 64 chars over UTF-8 bytes, order-invariant", () => {
  const h = canonicalSha256({ b: 1, a: 0 });
  assert.match(h, /^[a-f0-9]{64}$/);
  assert.equal(canonicalSha256({ a: 0, b: 1 }), h);
});

test("integer precision within safe range round-trips", () => {
  assert.equal(canonicalize({ n: 9007199254740991 }), '{"n":9007199254740991}');
});