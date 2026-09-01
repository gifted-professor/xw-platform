// Offline contract probes for the XHS lab-only read-only FastOperator entry
// (contract xhs-lab-readonly-fast-entry-v1: XHS-LAB-AUTH-01 / BIND-01 /
// LEASE-01 / DUMP-01). All traffic lands on in-process fake FastOperators;
// no real device, no real 17895/17897, zero elevation.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  LabReadonlyGateway,
  LabError,
  SLOT_MAP,
  DEFAULT_CONTROL_PORT,
  DEFAULT_ENTRY_PORT,
  buildFoBody,
} from "../lab/lab-readonly-gateway.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const LAB_DIR = join(HERE, "..", "lab");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readAll(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw;
}

async function listenFree(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server.address().port;
}

// Fake FastOperator: mimics the real serve() flow — validate lease headers,
// call the gateway authorize callback BEFORE any device work, then answer.
async function startFakeFastOperator({ gatewayControlPort, runtimeId, result, holdMs = 0, sendToken = true, tokenOverride = null } = {}) {
  const state = { runtimeId, result, holdMs };
  const calls = [];
  const authorizeAttempts = [];
  const server = createServer(async (req, res) => {
    const raw = await readAll(req);
    const inbound = raw ? JSON.parse(raw) : {};
    calls.push({
      action: inbound?.action ?? null,
      body: inbound,
      headers: { ...req.headers },
    });
    const token = req.headers["x-control-token"] ?? "";
    const callbackBody = {
      leaseId: req.headers["x-control-lease-id"] ?? null,
      deviceId: req.headers["x-control-device-id"] ?? null,
      runtimeId: state.runtimeId,
    };
    let cbResponse;
    try {
      cbResponse = await fetch(`http://127.0.0.1:${gatewayControlPort}/control/v1/leases/authorize`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-control-token": tokenOverride ?? (sendToken ? token : "forged-operator-token") },
        body: JSON.stringify(callbackBody),
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: { code: "AUTH_UNAVAILABLE" }, metrics: {} }));
      return;
    }
    const cbBody = await cbResponse.json().catch(() => null);
    authorizeAttempts.push({ status: cbResponse.status, body: cbBody });
    if (!(cbResponse.status === 200 && cbBody?.authorized === true)) {
      res.writeHead(423, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: { code: cbBody?.code ?? "LEASE_REJECTED", message: "authorize rejected" }, metrics: {} }));
      return;
    }
    if (state.holdMs > 0) await sleep(state.holdMs);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, result: state.result ?? { note: "ok" }, metrics: { actions: 0, dumps: 0 } }));
  });
  const port = await listenFree(server);
  return {
    server, port, calls, authorizeAttempts, state,
    async close() { await new Promise((r) => server.close(r)); },
  };
}

async function startTestGateway({ receiptPath } = {}) {
  const token = randomBytes(32).toString("hex");
  const gateway = new LabReadonlyGateway({ clientToken: token, controlPort: 0, entryPort: 0, receiptPath: receiptPath ?? null });
  await gateway.listen();
  const controlPort = gateway.controlServer.address().port;
  const entryPort = gateway.entryServer.address().port;

  const fo01 = await startFakeFastOperator({
    gatewayControlPort: controlPort,
    runtimeId: "fake-serial-01",
    result: { focus: "com.xingin.xhs/.index.v2.IndexActivity" },
  });
  const fo02 = await startFakeFastOperator({
    gatewayControlPort: controlPort,
    runtimeId: "fake-serial-02",
    result: { note: "dump-ok" },
  });

  // Point the slot map at the fake operators (real 17895/17897 never touched).
  gateway.slotMap = {
    "01": { port: fo01.port, deviceId: SLOT_MAP["01"].deviceId },
    "02": { port: fo02.port, deviceId: SLOT_MAP["02"].deviceId },
  };

  async function closeAll() {
    await gateway.close().catch(() => {});
    await fo01.close();
    await fo02.close();
  }
  return { gateway, token, controlPort, entryPort, fo01, fo02, closeAll };
}

function postJson(port, path, body, { token, headers = {}, deadlineMs = 15000 } = {}) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token !== undefined ? { "x-lab-client-token": token } : {}),
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(deadlineMs),
  }).then(async (response) => {
    const text = await response.text();
    let body2 = null;
    try { body2 = JSON.parse(text); } catch { body2 = null; }
    return { status: response.status, body: body2, text };
  });
}

async function getJson(port, path, { token } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "GET",
    headers: token !== undefined ? { "x-lab-client-token": token } : {},
  });
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }
  return { status: response.status, body, text };
}

// ---------------------------------------------------------------- XHS-LAB-AUTH-01

test("auth-adversarial: malformed, polluted and forged requests never forward", async (t) => {
  const env = await startTestGateway();
  t.after(() => env.closeAll());
  const { controlPort, token, fo01, fo02 } = env;
  const slot = "01";
  const req = (body, opts = {}) => postJson(controlPort, "/lab/v1/requests", body, { token, ...opts });

  const adversarial = [
    [{ action: "tap", slot, requestId: randomUUID() }, 403, "LAB_ACTION_FORBIDDEN"],
    [{ action: "scrollDown", slot, requestId: randomUUID() }, 403, "LAB_ACTION_FORBIDDEN"],
    [{ action: "feedCards", slot, requestId: randomUUID() }, 403, "LAB_ACTION_FORBIDDEN"],
    [{ action: "focus", slot, requestId: randomUUID(), extra: "x" }, 400, "FORBIDDEN_KEYS"],
    [{ action: "focus", slot, requestId: randomUUID(), port: 17897 }, 400, "FORBIDDEN_KEYS"],
    [{ action: "focus", slot, requestId: randomUUID(), url: "http://evil/" }, 400, "FORBIDDEN_KEYS"],
    [{ action: "focus", requestId: `${"a".repeat(100)}${randomUUID()}`, deviceId: "lab-slot-01", runtimeId: "x" }, 400, "FORBIDDEN_KEYS"],
    [{ action: "focus", slot: "03", requestId: randomUUID() }, 400, "UNKNOWN_SLOT"],
    [{ action: "focus", slot: "2", requestId: randomUUID() }, 400, "UNKNOWN_SLOT"],
    [{ action: "focus", slot: 1, requestId: randomUUID() }, 400, "UNKNOWN_SLOT"],
    [{ action: "focus", slot }, 400, "FORBIDDEN_KEYS"],
    [{ action: "focus", slot, requestId: "short" }, 400, "MALFORMED_BODY"],
    [{ action: "focus", slot, requestId: randomUUID(), label: "x" }, 400, "FORBIDDEN_KEYS"],
    [{ action: "dump", slot, requestId: randomUUID(), label: "bad label!" }, 400, "LABEL_INVALID"],
    [{ action: "dump", slot, requestId: randomUUID(), label: "" }, 400, "LABEL_INVALID"],
    [{ action: "focus", slot: "01", requestId: "a".repeat(300) }, 400, "MALFORMED_BODY"],
  ];
  for (const [body, status, code] of adversarial) {
    const response = await req(body);
    assert.equal(response.status, status, JSON.stringify(body));
    assert.equal(response.body?.code, code, JSON.stringify(body));
  }

  const noToken = await postJson(controlPort, "/lab/v1/requests", { action: "focus", slot, requestId: randomUUID() }, {});
  assert.equal(noToken.status, 401);
  assert.equal(noToken.body?.code, "CLIENT_TOKEN_REQUIRED");
  // deterministically different from the real token (first-char flip can collide)
  const wrongTokenValue = token === `${token.slice(0, -1)}0` ? `${token.slice(0, -1)}1` : `${token.slice(0, -1)}0`;
  const wrongToken = await req({ action: "focus", slot, requestId: randomUUID() }, { token: wrongTokenValue });
  assert.equal(wrongToken.status, 401);
  const originHeader = await req({ action: "focus", slot, requestId: randomUUID() }, { headers: { origin: "http://localhost:3000" } });
  assert.equal(originHeader.status, 403);
  const refererHeader = await req({ action: "focus", slot, requestId: randomUUID() }, { headers: { referer: "http://localhost/x" } });
  assert.equal(refererHeader.status, 403);
  const malformed = await postJson(controlPort, "/lab/v1/requests", "{not json", { token });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body?.code, "MALFORMED_BODY");
  const oversized = await postJson(controlPort, "/lab/v1/requests", JSON.stringify({ action: "focus", slot, requestId: randomUUID(), junk: "x".repeat(5000) }), { token });
  assert.equal(oversized.status, 413);
  assert.equal(oversized.body?.code, "BODY_TOO_LARGE");

  assert.equal(fo01.calls.length, 0, "forwarding spy must stay at zero");
  assert.equal(fo02.calls.length, 0, "forwarding spy must stay at zero");
});

test("mutation probe: only constant focus/dump bodies are constructible; polluted intents fail closed with spy at zero", async (t) => {
  const env = await startTestGateway();
  t.after(() => env.closeAll());
  const { controlPort, token, fo01, fo02 } = env;

  assert.throws(() => buildFoBody("tap"), (error) => error instanceof LabError && error.code === "LAB_ACTION_FORBIDDEN");
  assert.throws(() => buildFoBody("scrollDown"), (error) => error.code === "LAB_ACTION_FORBIDDEN");
  assert.throws(() => buildFoBody("like"), (error) => error.code === "LAB_ACTION_FORBIDDEN");
  assert.throws(() => buildFoBody("dump", "bad label!"), (error) => error.code === "LABEL_INVALID");
  assert.deepEqual(buildFoBody("focus"), { action: "focus" });
  assert.deepEqual(buildFoBody("dump", "my-label"), { action: "dump", label: "my-label" });
  assert.deepEqual(buildFoBody("dump", undefined), { action: "dump", label: "lab-dump" });

  const rejected = await postJson(controlPort, "/lab/v1/requests", { action: "tap", slot: "01", requestId: randomUUID() }, { token });
  assert.equal(rejected.status, 403);

  const okFocus = await postJson(controlPort, "/lab/v1/requests", { action: "focus", slot: "01", requestId: randomUUID() }, { token });
  assert.equal(okFocus.status, 200);
  assert.equal(okFocus.body?.ok, true);
  await sleep(30);
  const dumpOk = await postJson(controlPort, "/lab/v1/requests", { action: "dump", slot: "02", requestId: randomUUID(), label: "my-label" }, { token });
  assert.equal(dumpOk.body?.ok, true);
  await sleep(30);

  assert.equal(fo01.calls.length, 1);
  assert.equal(fo02.calls.length, 1);
  assert.deepEqual(fo01.calls[0]?.body, { action: "focus" });
  assert.deepEqual(fo02.calls[0]?.body, { action: "dump", label: "my-label" });
  assert.match(fo01.calls[0]?.headers["x-control-device-id"], /^lab-slot-0[12]$/);
  assert.match(fo01.calls[0]?.headers["x-control-token"], /^[0-9a-f]{64}$/);
  assert.match(fo01.calls[0]?.headers["x-control-lease-id"], /^lab-[0-9a-f]{24}$/);
});

test("dual tokens: the operator token is never readable from any API, receipt, log or error", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "lab-dual-token-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const receiptPath = join(tmp, "receipts.jsonl");
  const env = await startTestGateway({ receiptPath });
  t.after(() => env.closeAll());
  const { controlPort, entryPort, token, fo01 } = env;

  const dump = await postJson(controlPort, "/lab/v1/requests", { action: "dump", slot: "01", requestId: randomUUID() }, { token });
  assert.equal(dump.body?.ok, true);
  const leakedToken = fo01.calls[0]?.headers["x-control-token"] ?? "";
  assert.match(leakedToken, /^[0-9a-f]{64}$/, "fake FO must have received an operator token header");

  const leases = await getJson(controlPort, "/control/v1/leases", { token });
  const entryJson = await getJson(entryPort, "/agent-entry.json");
  const entryMd = await fetch(`http://127.0.0.1:${entryPort}/agent-entry.md`).then((r) => r.text());
  const error = await postJson(controlPort, "/lab/v1/requests", { action: "tap", slot: "01", requestId: randomUUID() }, { token });
  const receiptsText = readFileSync(receiptPath, "utf8");

  for (const [name, text] of [
    ["leases", JSON.stringify(leases)],
    ["entryJson", JSON.stringify(entryJson)],
    ["entryMd", entryMd],
    ["error", JSON.stringify(error)],
    ["receipts", receiptsText],
  ]) {
    assert.ok(!text.includes(leakedToken), `operator token leaked via ${name}`);
  }
  // Per-op token is cleared once the lease settles.
  for (const lease of env.gateway.leasesByLeaseId.values()) {
    assert.equal(lease.operatorToken, null);
  }
});

test("auth-forgery: forged operator tokens, lease ids and device ids authorize nothing", async (t) => {
  const env = await startTestGateway();
  t.after(() => env.closeAll());
  const { gateway, controlPort } = env;

  // Forged callback referencing a nonexistent lease.
  const forgedUnknownLease = await postJson(controlPort, "/control/v1/leases/authorize", {
    leaseId: "lab-000000000000000000000000",
    deviceId: "lab-slot-01",
    runtimeId: "fake-serial-01",
  }, { headers: { "x-control-token": "forged" } });
  assert.equal(forgedUnknownLease.status, 403);
  assert.equal(forgedUnknownLease.body?.code, "AUTH_REJECTED");

  // Deterministic PENDING lease: outbound fetch that never settles.
  gateway.fetchImpl = () => new Promise(() => {});
  void postJson(controlPort, "/lab/v1/requests", { action: "focus", slot: "01", requestId: randomUUID() }, { token: env.token, deadlineMs: 800 }).catch(() => {});
  await sleep(150);
  const lease = [...gateway.leasesByLeaseId.values()].find((l) => l.state === "PENDING");
  assert.ok(lease, "a PENDING lease exists");

  // Correct operator token but forged deviceId (cross-slot).
  const forgedDevice = await postJson(controlPort, "/control/v1/leases/authorize", {
    leaseId: lease.leaseId,
    deviceId: "lab-slot-02",
    runtimeId: "fake-serial-01",
  }, { headers: { "x-control-token": lease.operatorToken } });
  assert.equal(forgedDevice.status, 403);
  assert.equal(lease.state, "PENDING", "forged attempts must not mutate the lease");

  // Correct lease + forged token → rejected, lease untouched, nothing released.
  const forgedToken = await postJson(controlPort, "/control/v1/leases/authorize", {
    leaseId: lease.leaseId,
    deviceId: lease.deviceId,
    runtimeId: "fake-serial-01",
  }, { headers: { "x-control-token": `${lease.operatorToken.slice(0, -1)}0` } });
  assert.equal(forgedToken.status, 403);
  assert.equal(lease.state, "PENDING");
});

test("auth-replay: operator authorization is single-use and replayed client requests never forward again", async (t) => {
  const env = await startTestGateway();
  t.after(() => env.closeAll());
  const { controlPort, token, fo01 } = env;

  const requestId = randomUUID();
  const first = await postJson(controlPort, "/lab/v1/requests", { action: "focus", slot: "01", requestId }, { token });
  assert.equal(first.body?.ok, true);
  assert.equal(fo01.calls.length, 1);
  const operatorToken = fo01.calls[0].headers["x-control-token"];
  const leaseId = fo01.calls[0].headers["x-control-lease-id"];
  const deviceId = fo01.calls[0].headers["x-control-device-id"];

  // Replay the previously successful authorization.
  const replayAuth = await postJson(controlPort, "/control/v1/leases/authorize", {
    leaseId, deviceId, runtimeId: "fake-serial-01",
  }, { headers: { "x-control-token": operatorToken } });
  assert.equal(replayAuth.status, 403);
  assert.equal(fo01.calls.length, 1);

  // Replay the same client request.
  const replayClient = await postJson(controlPort, "/lab/v1/requests", { action: "focus", slot: "01", requestId }, { token });
  assert.equal(replayClient.status, 409);
  assert.equal(replayClient.body?.code, "REPLAY_REJECTED");
  assert.equal(fo01.calls.length, 1, "no second FastOperator call");
});

// ---------------------------------------------------------------- XHS-LAB-BIND-01

test("bind-adversarial: runtime HMAC binds once per process, drift fails closed, restart resets, raw runtime never disclosed", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "lab-bind-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const receiptPath = join(tmp, "receipts.jsonl");
  const env = await startTestGateway({ receiptPath });
  t.after(() => env.closeAll());
  const { controlPort, token, fo01 } = env;

  const first = await postJson(controlPort, "/lab/v1/requests", { action: "focus", slot: "01", requestId: randomUUID() }, { token });
  assert.equal(first.body?.ok, true);

  // Same gateway lifetime: the fake FO now reports a different runtime.
  fo01.state.runtimeId = "fake-serial-CHANGED";
  const drifted = await postJson(controlPort, "/lab/v1/requests", { action: "focus", slot: "01", requestId: randomUUID() }, { token });
  assert.equal(drifted.body?.ok, false);
  assert.equal(drifted.body?.code, "RUNTIME_DRIFT");
  assert.equal(fo01.authorizeAttempts.at(-1)?.status, 409);
  assert.equal(fo01.authorizeAttempts.at(-1)?.body?.code, "RUNTIME_DRIFT");

  // Restart simulation: a fresh gateway binds whatever runtime shows up first
  // (ephemeral TOFU consistency only), and nothing persists across restarts.
  await env.closeAll();
  const env2 = await startTestGateway({ receiptPath });
  t.after(() => env2.closeAll());
  const second = await postJson(env2.controlPort, "/lab/v1/requests", { action: "focus", slot: "01", requestId: randomUUID() }, { token: env2.token });
  assert.equal(second.body?.ok, true);

  // No public surface carries the raw runtime ids.
  const leases = await getJson(env2.controlPort, "/control/v1/leases", { token: env2.token });
  const entryJson = await getJson(env2.entryPort, "/agent-entry.json");
  const receiptsText = readFileSync(receiptPath, "utf8");
  for (const text of [JSON.stringify(leases.body), entryJson.text, receiptsText]) {
    assert.ok(!text.includes("fake-serial-CHANGED"), "raw drifted runtime id leaked");
    assert.ok(!text.includes("fake-serial-01"), "raw original runtime id leaked");
  }
});

// ---------------------------------------------------------------- XHS-LAB-LEASE-01

test("lease-adversarial: client deadline does not release; same-slot concurrency is 423; other slot is independent", async (t) => {
  const env = await startTestGateway();
  t.after(() => env.closeAll());
  const { controlPort, token, fo01 } = env;

  const slowFo = await startFakeFastOperator({
    gatewayControlPort: env.controlPort, runtimeId: "fake-serial-01", result: { note: "slow" }, holdMs: 1500,
  });
  t.after(() => slowFo.close());
  env.gateway.slotMap["01"] = { port: slowFo.port, deviceId: SLOT_MAP["01"].deviceId };

  // Client gives up after 250ms; the outbound FastOperator request continues.
  await assert.rejects(
    fetch(`http://127.0.0.1:${controlPort}/lab/v1/requests`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-lab-client-token": token },
      body: JSON.stringify({ action: "focus", slot: "01", requestId: randomUUID() }),
      signal: AbortSignal.timeout(250),
    }),
    /aborted|timeout/i,
  );

  const leases1 = await getJson(controlPort, "/control/v1/leases", { token });
  const slot01Lease = leases1.body.leases.find((l) => l.slot === "01");
  assert.ok(slot01Lease, "lease must still be active after the client deadline");
  assert.ok(["PENDING", "AUTHORIZED", "IN_FLIGHT"].includes(slot01Lease.state), "lease is not released");
  assert.ok(slot01Lease.runtimeHmac === null || /^[0-9a-f]{64}$/.test(slot01Lease.runtimeHmac), "lease view carries only an ephemeral HMAC");

  const secondSameSlot = await postJson(controlPort, "/lab/v1/requests", { action: "focus", slot: "01", requestId: randomUUID() }, { token });
  assert.equal(secondSameSlot.status, 423);
  assert.equal(secondSameSlot.body?.code, "SLOT_BUSY");

  const otherSlot = await postJson(controlPort, "/lab/v1/requests", { action: "focus", slot: "02", requestId: randomUUID() }, { token });
  assert.equal(otherSlot.body?.ok, true, "slots are independent");

  await sleep(1600);
  const leases2 = await getJson(controlPort, "/control/v1/leases", { token });
  assert.equal(leases2.body.leases.find((l) => l.slot === "01"), undefined, "settled lease is no longer active");
  assert.equal(slowFo.calls.length, 1, "exactly one forwarded request per operation");
  assert.equal(fo01.calls.length, 0, "real slot 1 fake untouched: the slot map pointed at the slow fake");
});

test("lease-forgery: forged signals cannot force a nonterminal lease to RELEASED", async (t) => {
  const env = await startTestGateway();
  t.after(() => env.closeAll());
  const { gateway, controlPort, token } = env;

  gateway.fetchImpl = () => new Promise(() => {}); // outbound settles only via real FO
  void postJson(controlPort, "/lab/v1/requests", { action: "focus", slot: "01", requestId: randomUUID() }, { token, deadlineMs: 800 }).catch(() => {});
  await sleep(150);
  const lease = [...gateway.leasesByLeaseId.values()].find((l) => l.state === "PENDING");
  assert.ok(lease);

  const forgedBody = await postJson(controlPort, "/lab/v1/requests", {
    action: "focus", slot: "01", requestId: randomUUID(), force: "RELEASED",
  }, { token });
  assert.equal(forgedBody.status, 400, "forged completion keys are rejected");
  assert.equal(lease.state, "PENDING");

  const forged = await postJson(controlPort, "/control/v1/leases/authorize", {
    leaseId: lease.leaseId, deviceId: lease.deviceId, runtimeId: "fake-serial-01",
  }, { headers: { "x-control-token": "forged" } });
  assert.equal(forged.status, 403);
  assert.equal(lease.state, "PENDING", "forged authorize must not advance or release the lease");
});

test("lease-replay: terminal leases cannot be authorized or completed twice", async (t) => {
  const env = await startTestGateway();
  t.after(() => env.closeAll());
  const { controlPort, token, fo01 } = env;

  const requestId = randomUUID();
  const first = await postJson(controlPort, "/lab/v1/requests", { action: "focus", slot: "01", requestId }, { token });
  assert.equal(first.body?.ok, true);

  const replayAuth = await postJson(controlPort, "/control/v1/leases/authorize", {
    leaseId: fo01.calls[0].headers["x-control-lease-id"],
    deviceId: fo01.calls[0].headers["x-control-device-id"],
    runtimeId: "fake-serial-01",
  }, { headers: { "x-control-token": "whatever" } });
  assert.equal(replayAuth.status, 403);

  const replayRequest = await postJson(controlPort, "/lab/v1/requests", { action: "focus", slot: "01", requestId }, { token });
  assert.equal(replayRequest.status, 409);
  assert.equal(fo01.calls.length, 1);
});

// ---------------------------------------------------------------- XHS-LAB-DUMP-01

test("dump-regression: sentinel dump XML is returned to the client but never lands in gateway-owned files", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "lab-dump-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const receiptPath = join(tmp, "receipts.jsonl");
  const env = await startTestGateway({ receiptPath });
  t.after(() => env.closeAll());
  const { controlPort, token } = env;

  const xmlFo = await startFakeFastOperator({
    gatewayControlPort: env.controlPort,
    runtimeId: "fake-serial-01",
    result: { _hierarchyXml: "<hierarchy><node text='SENTINEL_LAB_DUMP_XYZ'/></hierarchy>" },
  });
  t.after(() => xmlFo.close());
  env.gateway.slotMap["01"] = { port: xmlFo.port, deviceId: SLOT_MAP["01"].deviceId };

  const dump = await postJson(controlPort, "/lab/v1/requests", { action: "dump", slot: "01", requestId: randomUUID() }, { token });
  assert.equal(dump.body?.ok, true);
  assert.ok(dump.text.includes("SENTINEL_LAB_DUMP_XYZ"), "the dump result is returned on the wire (display-only policy)");

  const receiptsText = readFileSync(receiptPath, "utf8");
  assert.ok(!receiptsText.includes("SENTINEL_LAB_DUMP_XYZ"), "sentinel XML leaked into receipts");
  assert.ok(!receiptsText.includes("<hierarchy"), "UI XML leaked into receipts");
  for (const line of receiptsText.trim().split("\n")) {
    const record = JSON.parse(line);
    for (const key of Object.keys(record)) {
      assert.ok(
        ["ts", "event", "requestId", "slot", "action", "leaseId", "state", "code", "httpStatus"].includes(key),
        `unexpected receipt key ${key}`,
      );
    }
  }
});

// ------------------------------------------------- disclosure, ports, integration

test("agent entry discloses lab-only semantics, allowed actions, slot map and the dump byproduct", async (t) => {
  const env = await startTestGateway();
  t.after(() => env.closeAll());
  const { entryPort } = env;

  const entryJson = await getJson(entryPort, "/agent-entry.json");
  assert.equal(entryJson.body?.mode, "LAB_READ_ONLY");
  assert.equal(entryJson.body?.productionAcceptance, false);
  assert.equal(entryJson.body?.claimedStatus, "LAB_READ_ONLY_SLOT_REACHED");
  assert.deepEqual(entryJson.body?.allowedActions, ["focus", "dump"]);
  assert.equal(entryJson.body?.slots["01"].port, env.gateway.slotMap["01"].port);
  assert.equal(entryJson.body?.slots["02"].port, env.gateway.slotMap["02"].port);

  const entryMd = await fetch(`http://127.0.0.1:${entryPort}/agent-entry.md`).then((r) => r.text());
  assert.ok(entryMd.includes("LAB_READ_ONLY"));
  assert.ok(entryMd.includes("productionAcceptance=false"));
  assert.ok(entryMd.includes("/sdcard/fo-dump.xml"));
  assert.ok(entryMd.includes(`01 -> 127.0.0.1:${env.gateway.slotMap["01"].port}`));
  assert.ok(entryMd.includes(`02 -> 127.0.0.1:${env.gateway.slotMap["02"].port}`));
  assert.ok(entryMd.includes("focus, dump"));
  assert.ok(entryMd.includes("a trusted device identity"), "runtime binding disclosure present");
});

test("health and leases endpoints require the client token where due", async (t) => {
  const env = await startTestGateway();
  t.after(() => env.closeAll());
  const health = await getJson(env.controlPort, "/healthz");
  assert.equal(health.body?.ok, true);
  const noToken = await getJson(env.controlPort, "/control/v1/leases");
  assert.equal(noToken.status, 401);
  const withToken = await getJson(env.controlPort, "/control/v1/leases", { token: env.token });
  assert.equal(withToken.status, 200);
  assert.deepEqual(withToken.body.leases, []);
});

test("default ports fail closed when occupied and never touch the occupier", async (t) => {
  const token = randomBytes(32).toString("hex");
  const occupier = createServer(() => {});
  try {
    await new Promise((resolve, reject) => {
      occupier.once("error", reject);
      occupier.listen(DEFAULT_CONTROL_PORT, "127.0.0.1", () => resolve());
    });
  } catch {
    occupier.close();
    t.skip("default control port is busy outside this test — fail-closed occupancy cannot be proven here");
    return;
  }

  const blockedGateway = new LabReadonlyGateway({ clientToken: token });
  await assert.rejects(blockedGateway.listen(), (error) => error?.code === "EADDRINUSE");
  const probe = createServer(() => {});
  await assert.rejects(
    new Promise((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(DEFAULT_CONTROL_PORT, "127.0.0.1", () => resolve());
    }),
    { code: "EADDRINUSE" },
    "occupier still listening",
  );
  await new Promise((r) => probe.close(r));
  await new Promise((r) => occupier.close(r));

  // Occupying only the entry port also fails closed, and frees the control port.
  const occupierEntry = createServer(() => {});
  try {
    await new Promise((resolve, reject) => {
      occupierEntry.once("error", reject);
      occupierEntry.listen(DEFAULT_ENTRY_PORT, "127.0.0.1", () => resolve());
    });
  } catch {
    occupierEntry.close();
    await new Promise((r) => occupier.close(r));
    t.skip("default entry port is busy outside this test");
    return;
  }
  const blocked2 = new LabReadonlyGateway({ clientToken: token });
  await assert.rejects(blocked2.listen(), (error) => error?.code === "EADDRINUSE");
  assert.equal(blocked2.controlServer, null, "control server was released after entry-port failure");
  await new Promise((r) => occupierEntry.close(r));

  const clean = new LabReadonlyGateway({ clientToken: token });
  await clean.listen();
  await clean.close();
});

test("medium-shell integration: client start -> status -> stop with no elevation", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "lab-integration-"));
  let gatewayPid = null;
  t.after(async () => {
    if (gatewayPid === null) return;
    try { process.kill(gatewayPid, 0); process.kill(gatewayPid, "SIGTERM"); } catch { /* already gone */ }
  });
  const run = (args, deadlineMs = 20000) => new Promise((resolve) => {
    const child = spawn(process.execPath, [join(LAB_DIR, "lab-readonly-client.mjs"), ...args], {
      env: { ...process.env, XHS_LAB_DATA_DIR: tmp },
      windowsHide: true,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.on("close", (code) => resolve({ code, out, err }));
    child.on("error", (error) => resolve({ code: -1, out, err: `${err}${error.message}` }));
    setTimeout(() => child.kill(), deadlineMs).unref();
  });

  const start = await run(["start"]);
  const started = JSON.parse(start.out || "{}");
  if (started.code === "GATEWAY_EXITED") t.skip("gateway could not bind the default ports in this shell — see client stderr");
  assert.equal(started.ok, true, start.out || start.err);
  gatewayPid = started.pid;
  assert.ok(Number.isInteger(gatewayPid), start.out || start.err);

  const status = await run(["status"]);
  const statusBody = JSON.parse(status.out || "{}");
  assert.equal(statusBody.ok, true, status.out || status.err);
  assert.equal(statusBody.gateway?.productionAcceptance, false);
  assert.deepEqual(statusBody.leases, []);

  // token file exists and is the only secret material on disk
  const tokenFile = JSON.parse(readFileSync(join(tmp, "client-token.json"), "utf8"));
  assert.match(tokenFile.token, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(tokenFile).includes(String(gatewayPid)));

  const stop = await run(["stop"]);
  const stopped = JSON.parse(stop.out || "{}");
  assert.equal(stopped.ok, true, stop.out || stop.err);
  assert.equal(stopped.stopped, true);
  await sleep(300);
  let alive = true;
  try {
    process.kill(gatewayPid, 0);
  } catch {
    alive = false;
  }
  assert.equal(alive, false, "gateway process must be gone after stop");
});

test("lab module graph is free of production and elevation dependencies", () => {
  const sources = ["lab-readonly-gateway.mjs", "lab-readonly-client.mjs"]
    .map((name) => readFileSync(join(LAB_DIR, name), "utf8"));

  // 1. Every static import specifier must be Node stdlib or lab-internal.
  const specifierPattern = /(?:from|import)\s*["']([^"']+)["']/g;
  for (const [index, source] of sources.entries()) {
    const specifiers = [...source.matchAll(specifierPattern)].map((match) => match[1]);
    assert.ok(specifiers.length > 0, `lab module ${index} has imports`);
    for (const specifier of specifiers) {
      const allowed = specifier.startsWith("node:") || specifier.startsWith("./") || specifier.startsWith("../");
      assert.ok(allowed, `lab module ${index} imports a non-stdlib, non-lab module: ${specifier}`);
    }
    assert.ok(!source.includes("require("), `lab module ${index} uses require`);
  }

  // 2. No elevation or host-control tooling is referenced anywhere.
  const forbidden = [
    "schtasks", "taskkill", "icacls", "runas", "elevate",
    "openshell", "start-process", "gspawn", "subprocess",
  ];
  for (const needle of forbidden) {
    for (const [index, source] of sources.entries()) {
      assert.ok(!source.toLowerCase().includes(needle.toLowerCase()), `lab module ${index} references forbidden tooling: ${needle}`);
    }
  }
});