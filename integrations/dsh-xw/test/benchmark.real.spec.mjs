import assert from "node:assert/strict";
import test from "node:test";

import { runBenchmark } from "../tools/run-benchmark.mjs";

test("40 warm ack samples and 20/5/5 real routes satisfy Gate E", { timeout: 240_000 }, async () => {
  const evidence = await runBenchmark();
  assert.equal(evidence.ack.samples.length, 40);
  assert.ok(evidence.ack.p95Ms <= 100, `warm ack p95 ${evidence.ack.p95Ms}ms exceeds 100ms`);
  assert.equal(evidence.routes.filter((run) => run.route === "happy").length, 20);
  assert.equal(evidence.routes.filter((run) => run.route === "replan").length, 5);
  assert.equal(evidence.routes.filter((run) => run.route === "hardstop").length, 5);
  assert.equal(evidence.pass, true);
});
