import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";

import { createXhsAdapter } from "../apps/xhs/adapter.mjs";
import { evaluateCapabilityPolicy } from "../control-plane/lib/policy.mjs";
import { FastOperator } from "../scripts/fast-operator.mjs";

const capabilities = JSON.parse(readFileSync(new URL("../apps/xhs/capabilities.json", import.meta.url), "utf8")).capabilities;
const collect = capabilities.find((capability) => capability.id === "xhs.collect.standing_grant");

function leaseAuthorization() {
  return { leaseId: "lease-collect", token: "secret-token", deviceId: "device-01" };
}

test("collect standing-grant manifest is R2, governed-only, and rejects ordinary jobs", () => {
  assert.ok(collect, "the only new Batch3 capability must be registered");
  assert.equal(collect.risk, "R2");
  assert.equal(collect.implementation.adapter, "xhs");
  assert.equal(collect.implementation.action, "collectOnOpenNote");
  assert.equal(collect.restoration.required, true);
  assert.throws(
    () => evaluateCapabilityPolicy(collect, { invocation: "job" }),
    { code: "STANDING_GRANT_MISSION_REQUIRED" },
  );
});

test("collect adapter offline E2E sends once, verifies state change, and restores only this collect before feed", async () => {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    requests.push({ input, headers: req.headers });
    const result = input.action === "collectOnOpenNote"
      ? { ok: true, collected: true, beforeState: "not_collected", afterState: "collected", countDelta: 1, accountFingerprint: "account-a", pageFingerprint: "page-a", targetFingerprint: "target-a", observedAt: new Date().toISOString() }
      : input.action === "undoCollectOnOpenNote"
        ? { ok: true, restored: true, beforeState: "collected", afterState: "not_collected" }
        : input.action === "backToFeed"
          ? { ok: true, home: true }
          : { ok: false, step: "unexpected-action" };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, result }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  after(() => server.close());
  const port = server.address().port;
  const adapter = createXhsAdapter();
  const capability = {
    ...collect,
    timeoutMs: 5000,
  };
  const device = { metadata: { xhsServePort: port } };
  const params = {
    observationReceiptId: "receipt-a", targetFingerprint: "target-a",
    observation: { accountFingerprint: "account-a", pageFingerprint: "page-a", targetFingerprint: "target-a", observedAt: new Date().toISOString() },
  };

  const execution = await adapter.execute({ capability, device, params, leaseAuthorization: leaseAuthorization() });
  const verification = await adapter.verify({ capability, params, execution });
  const restoration = await adapter.restore({ capability, device, params, execution, verification, leaseAuthorization: leaseAuthorization() });

  assert.equal(verification.ok, true);
  assert.equal(restoration.ok, true);
  assert.deepEqual(requests.map((request) => request.input.action), ["collectOnOpenNote", "undoCollectOnOpenNote", "backToFeed"]);
  assert.equal(requests[0].input.observationReceiptId, "receipt-a");
  assert.equal(requests[1].input.targetFingerprint, "target-a");
  assert.equal(requests[0].headers["x-control-lease-id"], "lease-collect");
});

test("collect fast operator taps once only from a fresh explicit note-detail surface", async () => {
  const operator = Object.create(FastOperator.prototype);
  const states = [
    { groups: [{}, { icon: { center: [500, 2200] }, label: "收藏", isNumeric: false, countValue: null }, {}], favorite: { icon: { center: [500, 2200] }, label: "收藏", isNumeric: false, countValue: null } },
    { groups: [{}, { icon: { center: [500, 2200] }, label: "1", isNumeric: true, countValue: 1 }, {}], favorite: { icon: { center: [500, 2200] }, label: "1", isNumeric: true, countValue: 1 } },
  ];
  let taps = 0;
  operator.currentFocus = async () => ({ package: "com.xingin.xhs", activity: "com.xingin.xhs.note.NoteDetailActivity" });
  operator.dump = async () => ({});
  operator.detailEngagementBar = () => states.shift();
  operator.favoriteDetail = async (bar) => { taps += 1; return { tapped: bar.favorite.icon.center }; };
  const result = await operator.collectOnOpenNote({ observation: { accountFingerprint: "account-a", pageFingerprint: "page-a", targetFingerprint: "target-a", observedAt: new Date().toISOString() } });
  assert.equal(result.collected, true);
  assert.equal(taps, 1);
});

test("collect refuses stale or mismatched receipt targets before any operator request", async () => {
  let fetchCalls = 0;
  const adapter = createXhsAdapter({ fetchImpl: async () => { fetchCalls += 1; throw new Error("must not fetch"); } });
  await assert.rejects(
    () => adapter.execute({
      capability: collect, device: { metadata: { xhsServePort: 17999 } }, leaseAuthorization: leaseAuthorization(),
      params: { observationReceiptId: "receipt-a", targetFingerprint: "target-a", observation: { accountFingerprint: "account-a", pageFingerprint: "page-a", targetFingerprint: "other-target", observedAt: new Date().toISOString() } },
    }),
    (error) => error.code === "COLLECT_RECEIPT_BINDING_INVALID" && error.notSent === true,
  );
  assert.equal(fetchCalls, 0);
});

test("collect adapter fails closed when the operator reports an already-collected or ambiguous surface", async () => {
  const adapter = createXhsAdapter({
    fetchImpl: async () => new Response(JSON.stringify({ ok: true, result: { ok: false, notSent: true, step: "alreadyCollected" } }), { status: 200 }),
  });
  await assert.rejects(
    () => adapter.execute({
      capability: collect, device: { metadata: { xhsServePort: 17999 } }, leaseAuthorization: leaseAuthorization(),
      params: { observationReceiptId: "receipt-a", targetFingerprint: "target-a", observation: { accountFingerprint: "account-a", pageFingerprint: "page-a", targetFingerprint: "target-a", observedAt: new Date().toISOString() } },
    }),
    (error) => error.code === "ADAPTER_ACTION_REJECTED" && error.notSent === true,
  );
});
