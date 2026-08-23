import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

const sha = (value) => createHash("sha256").update(value).digest("hex");

test("live v2 uses only shared kernel grounding and legacy replay v1 remains byte-pinned", () => {
  const facade = readFileSync(new URL("../control-plane/lib/m6-grounded-action-facade.mjs", import.meta.url), "utf8");
  const live = readFileSync(new URL("../../../packages/kernel/lib/m6-live-grounding.mjs", import.meta.url), "utf8");
  const legacy = readFileSync(new URL("../../orchestrator/scripts/lib/m6/m6-grounding-runtime.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  assert.match(facade, /packages\/kernel\/lib\/m6-live-grounding\.mjs/u);
  assert.doesNotMatch(facade, /m6-grounding-runtime\.mjs/u);
  assert.doesNotMatch(live, /resolveInternalPoint|createGroundingRuntime/u);
  assert.equal(sha(legacy), "9f6a02f76d64454ad8897662647bc9c2132aafdb9bc23a66842f719cbf6f09d7");
});
