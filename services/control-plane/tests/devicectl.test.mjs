import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_REMOTE_REPO,
  decodeForwardedArgv,
  encodeForwardedArgv,
  main,
  remotePowerShell,
} from "../control-plane/devicectl.mjs";

test("remote devicectl defaults to the deployed Windows checkout", () => {
  assert.equal(DEFAULT_REMOTE_REPO, "C:\\Users\\Public\\xhs-routing-v1-1");
});

test("base64 forwarding preserves JSON params as one exact argument", () => {
  const argv = [
    "route",
    "plan",
    "--actor",
    "agent-a",
    "--capability",
    "xianyu.publish.full_dry_run",
    "--params",
    JSON.stringify({ description: "中文", nested: { saveDraft: false }, values: [1, 2] }),
  ];
  assert.deepEqual(decodeForwardedArgv(encodeForwardedArgv(argv)), argv);
});

test("PowerShell forwards opaque base64 instead of reparsing JSON", () => {
  const secretLikeValue = JSON.stringify({ token: "quote-sensitive-value" });
  const encoded = encodeForwardedArgv(["route", "plan", "--params", secretLikeValue]);
  const script = remotePowerShell(DEFAULT_REMOTE_REPO, encoded, "DESKTOP-3I1EVHE");
  assert.match(script, /--forwarded-argv-base64/);
  assert.match(script, new RegExp(encoded));
  assert.doesNotMatch(script, /ConvertFrom-Json|quote-sensitive-value/);
});

test("invalid forwarded argv fails closed", () => {
  assert.throws(() => decodeForwardedArgv("not-base64"), { code: "CLI_FORWARDED_ARGS_INVALID" });
  assert.throws(
    () => decodeForwardedArgv(Buffer.from(JSON.stringify({ nope: true })).toString("base64")),
    { code: "CLI_FORWARDED_ARGS_INVALID" },
  );
});

test("job recover forwards actor and idempotency key to the audited endpoint", async () => {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const requests = [];
  console.log = () => {};
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    return new Response(JSON.stringify({ recovery: { ok: true } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    await main([
      "--local",
      "job",
      "recover",
      "--job",
      "job_recovery",
      "--actor",
      "agent-a",
      "--idempotency-key",
      "recover-1",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
  assert.equal(new URL(requests[0].url).pathname, "/control/v1/jobs/job_recovery/recover");
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    actorId: "agent-a",
    idempotencyKey: "recover-1",
  });
});

test("job recover-inspect forwards to the read-only audited endpoint", async () => {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const requests = [];
  console.log = () => {};
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    return new Response(JSON.stringify({ inspection: { ok: true, stoppedBeforeAction: true } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    await main([
      "--local",
      "job",
      "recover-inspect",
      "--job",
      "job_recovery",
      "--actor",
      "agent-a",
      "--idempotency-key",
      "inspect-1",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
  assert.equal(new URL(requests[0].url).pathname, "/control/v1/jobs/job_recovery/recover/inspect");
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    actorId: "agent-a",
    idempotencyKey: "inspect-1",
  });
});

test("job recover-inspect-record forwards the normalized analysis envelope", async () => {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const requests = [];
  console.log = () => {};
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    return new Response(JSON.stringify({ analysis: { ok: true } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const analysis = { schemaVersion: "xhs.visual-elements.v1", elements: [] };
  try {
    await main([
      "--local",
      "job",
      "recover-inspect-record",
      "--job",
      "job_recovery",
      "--inspection",
      "inspection_1",
      "--actor",
      "agent-a",
      "--idempotency-key",
      "analysis-1",
      "--analysis",
      JSON.stringify(analysis),
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
  assert.equal(
    new URL(requests[0].url).pathname,
    "/control/v1/jobs/job_recovery/recover/inspect/inspection_1/analysis",
  );
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    actorId: "agent-a",
    idempotencyKey: "analysis-1",
    analysis,
  });
});
