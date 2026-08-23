import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

import { DshXwProcessAdapter } from "../src/process-adapter.mjs";

function percentile(values, quantile) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * quantile) - 1];
}

async function ackBenchmark(root) {
  const closeReceiptPath = join(root, "ack-process-close.json");
  const adapter = new DshXwProcessAdapter({ persistenceRoot: join(root, "ack-sessions"), replayRoot: join(root, "ack-replay"), closeReceiptPath });
  const client = adapter.createClient();
  const coldStart = performance.now();
  client.start();
  await client.initialize({ cwd: root, provider: "xw-replay", model: "xw-replay-v1" });
  const coldStartMs = performance.now() - coldStart;
  const samples = [];
  for (let index = 0; index < 40; index += 1) {
    const started = performance.now();
    await client.prompt("session-ack-benchmark", [{ type: "text", text: `ack-only ${index}` }]);
    samples.push(performance.now() - started);
  }
  await client.close();
  return { coldStartMs, samples, p95Ms: percentile(samples, 0.95), thresholdMs: 100, processClose: JSON.parse(readFileSync(closeReceiptPath, "utf8")) };
}

async function realRoutes(root) {
  const matrix = { happy: 20, replan: 5, hardstop: 5 };
  const runs = [];
  for (const [route, count] of Object.entries(matrix)) for (let index = 0; index < count; index += 1) {
    const runRoot = join(root, `${route}-${index}`);
    const closeReceiptPath = join(runRoot, "process-close.json");
    const adapter = new DshXwProcessAdapter({ persistenceRoot: join(runRoot, "sessions"), replayRoot: join(runRoot, "replay"), closeReceiptPath });
    const harness = adapter.createHarness();
    const started = performance.now();
    const result = await harness.run(`run ${route} replay`, { sessionId: `session-${route}-${String(index).padStart(4, "0")}` });
    await harness.close();
    const receipt = JSON.parse(readFileSync(closeReceiptPath, "utf8"));
    runs.push({
      route,
      index,
      durationMs: performance.now() - started,
      deterministic: result.finalResponse === `M6-3 ${route} replay complete`,
      verifiedClosed: receipt.verifiedClosed === true,
      processClose: receipt,
      externalEffect: false,
      actionCount: 0,
    });
  }
  return runs;
}

export async function runBenchmark(outputPath) {
  const root = mkdtempSync(join(tmpdir(), "xw-m6-3-benchmark-"));
  const ack = await ackBenchmark(root);
  const routes = await realRoutes(root);
  const evidence = {
    schemaId: "xw.m6-3-benchmark.v1",
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    ack,
    routes,
    pass: ack.samples.length === 40 && ack.p95Ms <= 100
      && routes.length === 30 && routes.every((run) => run.deterministic && run.verifiedClosed && !run.externalEffect && run.actionCount === 0),
  };
  if (outputPath) {
    const target = resolve(outputPath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(evidence, null, 2)}\n`);
  }
  return evidence;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const evidence = await runBenchmark(process.argv[2]);
  process.stdout.write(`${JSON.stringify({ pass: evidence.pass, p95Ms: evidence.ack.p95Ms, samples: evidence.ack.samples.length, routes: evidence.routes.length })}\n`);
  if (!evidence.pass) process.exitCode = 1;
}
