import test from "node:test";
import assert from "node:assert/strict";
import { renderToMarkdown } from "../render.mjs";

test("renderToMarkdown is deterministic: same objects → identical bytes", () => {
  const objs = [
    { schemaId: "xhs.m0.baseline-identity.v1", schemaVersion: 1, baselineId: "xw-m0-20260817-r0", capturedAt: "2026-08-17T00:00:00Z" },
    { schemaId: "xhs.m0.known-debt.v1", schemaVersion: 1, baselineId: "xw-m0-20260817-r0", entries: [{ failureId: "debt_x", critical: false }] },
  ];
  const a = renderToMarkdown(objs);
  const b = renderToMarkdown(objs.slice().reverse()); // input order must not matter
  assert.equal(a, b);
});

test("renderToMarkdown output starts with the baseline title header", () => {
  const out = renderToMarkdown([{ schemaId: "xhs.m0.baseline-identity.v1", baselineId: "xw-m0-20260817-r0" }]);
  assert.ok(out.startsWith("# M0 Acceptance Report — xw-m0-20260817-r0"));
  assert.ok(out.includes("## Baseline Identity"));
});

test("renderToMarkdown sorts sections by schema title, not input order", () => {
  const out = renderToMarkdown([
    { schemaId: "xhs.m0.known-debt.v1", baselineId: "xw-m0-20260817-r0" },
    { schemaId: "xhs.m0.baseline-identity.v1", baselineId: "xw-m0-20260817-r0" },
  ]);
  const idxKnown = out.indexOf("## Known Debt Register");
  const idxBase = out.indexOf("## Baseline Identity");
  assert.ok(idxBase < idxKnown, "Baseline Identity precedes Known Debt Register");
});

test("renderToMarkdown scalar values are backtick-quoted, nulls rendered", () => {
  const out = renderToMarkdown([{ schemaId: "xhs.m0.private-evidence.v1", status: "pending_age", ciphertextSha256: null, fileCount: 0 }]);
  assert.ok(out.includes("**status**: `pending_age`"));
  assert.ok(out.includes("**ciphertextSha256**: _(null)_"));
  assert.ok(out.includes("**fileCount**: 0"));
});

test("renderToMarkdown array-of-objects renders one ### [n] heading per entry", () => {
  const out = renderToMarkdown([
    { schemaId: "xhs.m0.known-debt.v1", entries: [{ failureId: "debt_a", critical: true }, { failureId: "debt_b", critical: false }] },
  ]);
  assert.ok(out.includes("### [1]"), "first entry heading");
  assert.ok(out.includes("### [2]"), "second entry heading");
  assert.ok(out.includes("**failureId**: `debt_a`"));
});

test("renderToMarkdown ends with a single trailing newline (byte-stable)", () => {
  const out = renderToMarkdown([{ schemaId: "xhs.m0.baseline-identity.v1", baselineId: "xw-m0-20260817-r0" }]);
  assert.ok(out.endsWith("\n"));
  assert.ok(!out.endsWith("\n\n"), "no double trailing newline");
});