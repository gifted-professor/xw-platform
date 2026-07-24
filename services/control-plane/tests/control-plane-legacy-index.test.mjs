import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { indexLegacyEvidence } from "../control-plane/index-legacy-evidence.mjs";

const tempBase = join(process.cwd(), "control-plane", "runtime");
mkdirSync(tempBase, { recursive: true });

test("legacy index hashes files without copying source artifacts", async () => {
  const root = mkdtempSync(join(tempBase, "legacy-index-"));
  const source = join(root, "source");
  const output = join(root, "index", "legacy.jsonl");
  mkdirSync(join(source, "nested"), { recursive: true });
  writeFileSync(join(source, "one.json"), "{}");
  writeFileSync(join(source, "nested", "two.png"), "fake-image");
  try {
    const result = await indexLegacyEvidence({ source, output });
    assert.equal(result.files, 2);
    assert.equal(result.copiedFiles, 0);
    const records = readFileSync(output, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(records[0].type, "summary");
    assert.equal(records.filter((record) => record.type === "file").length, 2);
    assert.equal(records.slice(1).every((record) => /^[a-f0-9]{64}$/.test(record.sha256)), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy index refuses to write its output inside the source", async () => {
  const root = mkdtempSync(join(tempBase, "legacy-index-unsafe-"));
  const source = join(root, "source");
  mkdirSync(source, { recursive: true });
  try {
    await assert.rejects(
      indexLegacyEvidence({ source, output: join(source, "index.jsonl") }),
      { code: "INDEX_OUTPUT_INSIDE_SOURCE" },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
