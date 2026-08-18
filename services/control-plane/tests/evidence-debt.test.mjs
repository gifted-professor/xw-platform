import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const failures = JSON.parse(readFileSync(new URL("./fixtures/evidence-v1/writer-failures.json", import.meta.url), "utf8"));

test("evidence writer failures become debt without changing nonpayment dispatch count", async () => {
  const module = await import("../control-plane/lib/evidence-spool.mjs").catch(() => null);
  assert.ok(module?.createEvidenceSidecar, "RED: evidence sidecar fallback is not implemented");
  for (const fixture of failures) {
    let adapterCalls = 0;
    const sidecar = module.createEvidenceSidecar({
      writePrimary: async () => { const error = new Error(fixture.code); error.code = fixture.code; throw error; },
      writeSpool: async () => { throw Object.assign(new Error("spool unavailable"), { code: fixture.code }); }
    });
    const result = await sidecar.runNonpayment({ eventId: `fixture-${fixture.code}` }, async () => {
      adapterCalls += 1;
      return { ok: true };
    });
    assert.equal(adapterCalls, fixture.adapterCalls);
    assert.equal(result.evidenceDebt.length > 0, true);
  }
});
