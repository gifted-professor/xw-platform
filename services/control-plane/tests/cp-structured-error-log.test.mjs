/**
 * W3 tests — P2-OBSERVABILITY structured CP error logs + P1-DURABLE-CUTOVER-
 * ROLLBACK tuple validator. Console.red-line: cp.* events must go through
 * console.log (stdout, never stderr), carry code/status, never a body, and
 * the router swallow points throttle to one line per (event, runId).
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ControlPlaneError, structuredErrorLog } from "../control-plane/lib/errors.mjs";
import { ControlRouter } from "../control-plane/router.mjs";
import { createControlServer } from "../control-plane/server.mjs";
import { verifyTuple } from "../../../tools/xhs-routine/verify-rollback-tuple.mjs";
import { createHash } from "node:crypto";

function withCapturedConsoleLog(fn) {
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines;
}

async function withCapturedConsoleLogAsync(fn) {
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines;
}

test("structuredErrorLog: console.log only, code/status present, token-ish keys redacted", () => {
  const lines = withCapturedConsoleLog(() => {
    structuredErrorLog({
      event: "cp.test.error",
      error: new ControlPlaneError("TEST_CODE", "boom", { status: 409 }),
      extra: { runId: "r1", authorization: "Bearer secret", controlToken: "t0k" },
    });
  });
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.event, "cp.test.error");
  assert.equal(parsed.code, "TEST_CODE");
  assert.equal(parsed.status, 409);
  assert.ok(parsed.at);
  assert.equal(parsed.runId, "r1");
  assert.equal("authorization" in parsed, false);
  assert.equal("controlToken" in parsed, false);
  assert.equal(lines[0].includes("secret"), false);
});

function tempTuple({ mutate = () => {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "rb-tuple-"));
  const releases = join(root, "releases", "xw-test-rel");
  mkdirSync(releases, { recursive: true });
  const manifest = join(releases, "release-manifest.v1.json");
  writeFileSync(manifest, '{"releaseId":"xw-test-rel"}\n');
  const taskXml = join(root, "task.xml");
  writeFileSync(taskXml, "<Task/>");
  const policy = join(root, "policy.json");
  writeFileSync(policy, '{"a":1}');
  const policyRedacted = join(root, "policy.redacted.json");
  writeFileSync(policyRedacted, '{"a":1}');
  const serve = join(root, "serve-launch-03.json");
  writeFileSync(serve, "{}");
  const dbReceipt = join(root, "db-snapshot-receipt.v1.json");
  writeFileSync(dbReceipt, '{"snapshot":"ok"}');
  const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

  const tuple = {
    schema: "xw.xhs.routine-rollback-tuple.v1",
    stamp: "test",
    capturedAtUtc: "2026-08-29T00:00:00Z",
    junction: { previousTarget: releases, currentJsonRaw: '{"releaseId":"old"}' },
    scheduledTasks: [{ name: "T", xml: taskXml, xmlSha256: sha(taskXml) }],
    releaseManifest: { path: manifest, sha256: sha(manifest), releaseId: "xw-test-rel" },
    health: { controlPlane: '{"ok":true}', registry: '{"ok":true}' },
    policy: { path: policy, redactedCopyPath: policyRedacted, sha256: sha(policy) },
    serveLaunch: [{ path: serve, copy: serve, sha256: sha(serve) }],
    dbSnapshot: { path: dbReceipt, sha256: sha(dbReceipt) },
    activeWork: { controlPlaneJobs: "[]", controlPlaneLeases: "[]" },
    startOrderPlan: {
      startOrder: ["a", "b", "c"],
      healthExpectations: { controlPlaneHealthContains: '"ok":true', registryPorts: [17930] },
    },
  };
  mutate(tuple, { root, releases });
  const tuplePath = join(root, "tuple.json");
  writeFileSync(tuplePath, JSON.stringify(tuple));
  return { root, tuplePath };
}

test("verify-rollback-tuple: complete tuple PASSes; hash mismatch, escapes and gaps FAIL", () => {
  const good = tempTuple();
  const ok = verifyTuple({ tuplePath: good.tuplePath, runtimeRoot: good.root });
  assert.equal(ok.ok, true, JSON.stringify(ok.problems));
  rmSync(good.root, { recursive: true, force: true });

  // hash mismatch fails closed
  const flipped = tempTuple({
    mutate: (t, { root }) => { writeFileSync(join(root, "policy.json"), '{"a":2}'); },
  });
  const bad = verifyTuple({ tuplePath: flipped.tuplePath, runtimeRoot: join(flipped.root) });
  assert.equal(bad.ok, false);
  assert.ok(bad.problems.some((p) => p.includes("policy hash mismatch")));
  rmSync(flipped.root, { recursive: true, force: true });

  // junction escape outside releases is rejected
  const fired = tempTuple({
    mutate: (t) => { t.junction.previousTarget = "D:/elsewhere/releases/evil"; },
  });
  const escape = verifyTuple({ tuplePath: fired.tuplePath, runtimeRoot: join(fired.root, "releases", "..") });
  assert.equal(escape.ok, false);
  assert.ok(escape.problems.some((p) => p.includes("outside releases")));
  rmSync(fired.root, { recursive: true, force: true });

  // missing categories are problems, not crashes
  const hole = tempTuple({
    mutate: (t) => { t.activeWork = {}; t.serveLaunch = []; },
  });
  const missing = verifyTuple({ tuplePath: hole.tuplePath, runtimeRoot: join(hole.root) });
  assert.equal(missing.ok, false);
  assert.ok(missing.problems.length >= 3);
  rmSync(hole.root, { recursive: true, force: true });
});

test("server route errors emit exactly one cp.route.error line with code/status, no body", async () => {
  const failingRouter = {
    handle: async () => {
      throw new ControlPlaneError("SIM_ROUTE_EXPLOSION", "simulated route failure", { status: 418 });
    },
  };
  const server = createControlServer({ router: failingRouter });
  await new Promise((resolvePort) => server.listen(0, "127.0.0.1", resolvePort));
  const { port } = server.address();

  const lines = await withCapturedConsoleLogAsync(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/control/v1/anything`);
    const body = await response.json();
    assert.equal(response.status, 418);
    assert.equal(body.error.code, "SIM_ROUTE_EXPLOSION");
  });
  await new Promise((closeDone) => server.close(closeDone));

  const routeLines = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((p) => p?.event === "cp.route.error");
  assert.equal(routeLines.length, 1, "one structured line per failed route");
  assert.equal(routeLines[0].code, "SIM_ROUTE_EXPLOSION");
  assert.equal(routeLines[0].status, 418);
  assert.equal(routeLines[0].path, "/control/v1/anything");
  // body is never logged
  assert.equal(lines.some((l) => l.includes("request body")), false);
});

test("router swallow points: first failure logs, repeated failures throttled to one line", () => {
  const router = new ControlRouter({
    evidence: { runDirectory: () => { throw new Error("evidence io down"); } },
    control: { transportStatus: () => { throw new Error("transport status down"); } },
  });
  const job = { runId: "job_r1" };

  const lines = withCapturedConsoleLog(() => {
    router.attachLiveProgress(job);
    router.attachLiveProgress(job);
    router.attachLiveProgress(job);
    router.attachTransportLock(job);
  });

  const progressLines = lines.filter((l) => l.includes("cp.live.progress.unavailable"));
  assert.equal(progressLines.length, 1, "throttled: 3 failures -> 1 line");
  assert.equal(lines.filter((l) => l.includes("cp.transport.status.unavailable")).length, 1);
  const parsed = JSON.parse(progressLines[0]);
  assert.equal(parsed.runId, "job_r1");
  assert.ok(parsed.at);
});