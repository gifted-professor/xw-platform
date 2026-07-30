import assert from "node:assert/strict";
import test from "node:test";

import { main as devicectl } from "../control-plane/devicectl.mjs";
import { ControlRouter } from "../control-plane/router.mjs";

test("router exposes only signed Standing Grant install/list/show/revoke operations", async () => {
  const calls = [];
  const grant = {
    grantId: "grant_public",
    grantHash: "a".repeat(64),
    status: "active",
    issuer: { subject: "user:a1234", keyId: "private-key-id" },
    accountFingerprint: "private-account",
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
    expiresAt: null,
  };
  const delegationGrants = {
    issue(input) { calls.push(["install", input]); return { grant, reused: false }; },
    list() { calls.push(["list"]); return [grant]; },
    show(id) { calls.push(["show", id]); return grant; },
    revoke(id, input) { calls.push(["revoke", id, input]); return grant; },
  };
  const control = { async runStandingGrantCollectCanary(input) { calls.push(["canary", input]); return { status: "completed", jobId: "job_collect", runId: "run_collect" }; } };
  const router = new ControlRouter({ control, state: {}, capabilities: {}, evidence: {}, delegationGrants });
  const envelope = { grant: { grantId: "grant_public" }, proof: { signature: "offline-signature" } };
  const installed = await router.handle({ method: "POST", path: "/control/v1/grants", body: envelope });
  const canary = await router.handle({ method: "POST", path: "/control/v1/missions/collect-canary", body: { parentGrantId: "grant_public" } });
  const listed = await router.handle({ method: "GET", path: "/control/v1/grants" });
  const shown = await router.handle({ method: "GET", path: "/control/v1/grants/grant_public" });
  const revoked = await router.handle({ method: "POST", path: "/control/v1/grants/grant_public/revoke", body: { actor: "reviewer:test", reason: "canary_complete" } });

  assert.equal(installed.status, 201);
  assert.equal(listed.body.grants.length, 1);
  assert.equal(shown.body.grant.grantId, "grant_public");
  assert.equal(revoked.body.grant.grantId, "grant_public");
  assert.equal(canary.body.status, "completed");
  assert.deepEqual(calls.map(([name]) => name), ["install", "canary", "list", "show", "revoke"]);
  for (const result of [installed, listed, shown, revoked]) {
    assert.doesNotMatch(JSON.stringify(result.body), /private-key-id|private-account|offline-signature/);
  }
});

test("devicectl grant commands use the audited control-plane endpoints", async () => {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ path: new URL(url).pathname, method: options.method || "GET", body: options.body && JSON.parse(options.body) });
    return new Response(JSON.stringify({ grant: { grantId: "grant_public" }, grants: [] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  console.log = () => {};
  try {
    await devicectl(["--local", "grant", "install", "--envelope", JSON.stringify({ grant: {}, proof: {} })]);
    await devicectl(["--local", "mission", "collect-canary", "--actor", "user:a1234", "--idempotency-key", "canary-1", "--grant", "grant_public", "--job", "job_observe", "--receipt", "receipt_observe"]);
    await devicectl(["--local", "grant", "list"]);
    await devicectl(["--local", "grant", "show", "--grant", "grant_public"]);
    await devicectl(["--local", "grant", "revoke", "--grant", "grant_public", "--actor", "reviewer:test", "--reason", "canary_complete"]);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
  assert.deepEqual(requests.map(({ path, method }) => [method, path]), [
    ["POST", "/control/v1/grants"],
    ["POST", "/control/v1/missions/collect-canary"],
    ["GET", "/control/v1/grants"],
    ["GET", "/control/v1/grants/grant_public"],
    ["POST", "/control/v1/grants/grant_public/revoke"],
  ]);
});

test("canary evidence is denied by default and allowed only by a server-owned authorizer", async () => {
  const marker = { collect_job_id: "job_collect" };
  const state = { getStandingGrantCanary: () => marker, getJob: () => ({ runId: "run_collect" }), listEvidence: () => [{ evidenceId: "evidence_1" }] };
  const evidence = { getManifest: () => ({ runId: "run_collect" }) };
  const denied = new ControlRouter({ control: {}, state, capabilities: {}, evidence });
  await assert.rejects(() => denied.handle({ method: "GET", path: "/control/v1/runs/run_collect/evidence", headers: { role: "reviewer" } }), { code: "EVIDENCE_ACCESS_DENIED", status: 403 });
  const allowed = new ControlRouter({ control: {}, state, capabilities: {}, evidence, canaryEvidenceAuthorizer: ({ runId }) => runId === "run_collect" });
  assert.equal((await allowed.handle({ method: "GET", path: "/control/v1/runs/run_collect/evidence" })).status, 200);
});
