import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  XHS_V3_FIXED_OPERATOR_AUTH_HEADER,
  XHS_V3_FIXED_OPERATOR_NONCE_HEADER,
  XHS_V3_FIXED_OPERATOR_TIMESTAMP_HEADER,
  canonicalXhsV3FixedOperatorJson,
  createDurableXhsV3FixedOperatorNonceStore,
  createInMemoryXhsV3FixedOperatorNonceStoreForTest,
  createXhsV3FixedOperatorAuthorizer,
  createXhsV3FixedOperatorRequestSigner,
  hashXhsV3FixedOperatorBody,
} from "../control-plane/lib/xhs-v3-fixed-operator-auth.mjs";
import { ControlRouter } from "../control-plane/router.mjs";

const LIVE_TOKEN = "live-entry-token-never-printed-0123456789abcdef";
const GATE_TOKEN = "gate-token-never-printed-0123456789abcdef";
const BINDING = Object.freeze({
  releaseId: "xw-xhs-v3-test",
  sourceCommit: "a".repeat(40),
  operatorSha256: "b".repeat(64),
});
const PATH = "/control/v1/internal/xhs/exploration/prepare-invocation";
const BODY = Object.freeze({ phase: "R0", invocationId: "run-r0" });

test("canonical request binding is key-order independent and includes no secret", () => {
  assert.equal(
    canonicalXhsV3FixedOperatorJson({ z: [2, { b: true, a: null }], a: 1 }),
    '{"a":1,"z":[2,{"a":null,"b":true}]}',
  );
  assert.equal(hashXhsV3FixedOperatorBody({ b: 2, a: 1 }), hashXhsV3FixedOperatorBody({ a: 1, b: 2 }));
  assert.equal(hashXhsV3FixedOperatorBody({ a: 1 }).includes(LIVE_TOKEN), false);
  assert.throws(() => hashXhsV3FixedOperatorBody({ bad: undefined }), {
    code: "XHS_V3_FIXED_OPERATOR_BODY_INVALID",
  });
});

test("request HMAC binds release/operator/method/path/body and consumes a short-lived nonce once", () => {
  let nowMs = 1_800_000_000_000;
  let nonceIndex = 0;
  const nonceFactory = () => (++nonceIndex).toString(16).padStart(32, "0");
  const signer = createXhsV3FixedOperatorRequestSigner({
    liveEntryToken: LIVE_TOKEN,
    binding: BINDING,
    now: () => nowMs,
    nonceFactory,
  });
  const authorizer = createXhsV3FixedOperatorAuthorizer({
    liveEntryToken: LIVE_TOKEN,
    binding: BINDING,
    now: () => nowMs,
    nonceStore: createInMemoryXhsV3FixedOperatorNonceStoreForTest(),
  });
  const headers = signer.sign({ method: "POST", path: PATH, body: BODY });
  assert.match(headers[XHS_V3_FIXED_OPERATOR_AUTH_HEADER], /^[0-9a-f]{64}$/u);
  assert.match(headers[XHS_V3_FIXED_OPERATOR_NONCE_HEADER], /^[0-9a-f]{32}$/u);
  assert.equal(headers[XHS_V3_FIXED_OPERATOR_TIMESTAMP_HEADER], String(nowMs));
  assert.deepEqual(authorizer.assertAuthorized({ method: "POST", path: PATH, body: BODY, headers }), {
    ok: true,
    releaseId: BINDING.releaseId,
    sourceCommit: BINDING.sourceCommit,
  });
  assert.throws(
    () => authorizer.assertAuthorized({ method: "POST", path: PATH, body: BODY, headers }),
    { code: "XHS_V3_FIXED_OPERATOR_REPLAY_REJECTED", status: 409 },
  );

  const tamperedHeaders = signer.sign({ method: "POST", path: PATH, body: BODY });
  assert.throws(
    () => authorizer.assertAuthorized({
      method: "POST", path: PATH, body: { ...BODY, phase: "R1" }, headers: tamperedHeaders,
    }),
    { code: "XHS_V3_FIXED_OPERATOR_UNAUTHORIZED", status: 403 },
  );
  nowMs += 31_000;
  const expiredHeaders = {
    ...signer.sign({ method: "POST", path: PATH, body: BODY }),
    [XHS_V3_FIXED_OPERATOR_TIMESTAMP_HEADER]: String(nowMs - 31_001),
  };
  assert.throws(
    () => authorizer.assertAuthorized({ method: "POST", path: PATH, body: BODY, headers: expiredHeaders }),
    { code: "XHS_V3_FIXED_OPERATOR_AUTH_EXPIRED", status: 403 },
  );
});

test("Gate-F credential alone is not a generic HTTP equivalent for the XHS task namespace", async () => {
  const nowMs = 1_800_000_000_000;
  const signer = createXhsV3FixedOperatorRequestSigner({
    liveEntryToken: LIVE_TOKEN,
    binding: BINDING,
    now: () => nowMs,
    nonceFactory: () => "1".repeat(32),
  });
  const authorizer = createXhsV3FixedOperatorAuthorizer({
    liveEntryToken: LIVE_TOKEN,
    binding: BINDING,
    now: () => nowMs,
    nonceStore: createInMemoryXhsV3FixedOperatorNonceStoreForTest(),
  });
  let prepares = 0;
  const router = new ControlRouter({
    control: {}, state: {}, capabilities: {}, evidence: {},
    m6GateFOperations: {
      assertAuthorized(headers) {
        if (headers["x-control-token"] !== GATE_TOKEN) throw Object.assign(new Error("denied"), { code: "M6_GATE_F_ACCESS_DENIED" });
      },
    },
    xhsV3FixedOperatorAuthorization: authorizer,
    xhsV3TaskBootstrap: {
      async prepareInvocation(input) {
        prepares += 1;
        return { ok: true, ...input, invocationHash: "c".repeat(64) };
      },
    },
  });
  await assert.rejects(
    () => router.handle({ method: "POST", path: PATH, body: BODY, headers: { "x-control-token": GATE_TOKEN } }),
    { code: "XHS_V3_FIXED_OPERATOR_UNAUTHORIZED", status: 403 },
  );
  assert.equal(prepares, 0);
  const headers = {
    "x-control-token": GATE_TOKEN,
    ...signer.sign({ method: "POST", path: PATH, body: BODY }),
  };
  const result = await router.handle({ method: "POST", path: PATH, body: BODY, headers });
  assert.equal(result.body.invocation.invocationHash, "c".repeat(64));
  assert.equal(prepares, 1);
  await assert.rejects(
    () => router.handle({ method: "POST", path: PATH, body: BODY, headers }),
    { code: "XHS_V3_FIXED_OPERATOR_REPLAY_REJECTED", status: 409 },
  );
  assert.equal(prepares, 1);
});

test("authorization failures redact both private tokens from errors", () => {
  const authorizer = createXhsV3FixedOperatorAuthorizer({
    liveEntryToken: LIVE_TOKEN,
    binding: BINDING,
    now: () => 1_800_000_000_000,
    nonceStore: createInMemoryXhsV3FixedOperatorNonceStoreForTest(),
  });
  let observed;
  try {
    authorizer.assertAuthorized({
      method: "POST",
      path: PATH,
      body: BODY,
      headers: {
        [XHS_V3_FIXED_OPERATOR_AUTH_HEADER]: "f".repeat(64),
        [XHS_V3_FIXED_OPERATOR_TIMESTAMP_HEADER]: "1800000000000",
        [XHS_V3_FIXED_OPERATOR_NONCE_HEADER]: "2".repeat(32),
      },
    });
  } catch (error) { observed = error; }
  const rendered = JSON.stringify({
    code: observed?.code,
    message: observed?.message,
    details: observed?.details,
  });
  assert.equal(rendered.includes(LIVE_TOKEN), false);
  assert.equal(rendered.includes(GATE_TOKEN), false);
});

test("durable nonce consumption survives an authorizer/listener restart", (t) => {
  const root = mkdtempSync(join(tmpdir(), "xhs-operator-nonce-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "private", "xhs-v3"), { recursive: true });
  const acl = {
    protect() { return { ok: true }; },
    verify() { return { ok: true }; },
  };
  const nowMs = 1_800_000_000_000;
  const signer = createXhsV3FixedOperatorRequestSigner({
    liveEntryToken: LIVE_TOKEN,
    binding: BINDING,
    now: () => nowMs,
    nonceFactory: () => "a".repeat(32),
  });
  const headers = signer.sign({ method: "POST", path: PATH, body: BODY });
  const first = createXhsV3FixedOperatorAuthorizer({
    liveEntryToken: LIVE_TOKEN,
    binding: BINDING,
    now: () => nowMs,
    nonceStore: createDurableXhsV3FixedOperatorNonceStore({
      runtimeRoot: root, binding: BINDING, aclController: acl,
    }),
  });
  assert.equal(first.assertAuthorized({ method: "POST", path: PATH, body: BODY, headers }).ok, true);
  const afterRestart = createXhsV3FixedOperatorAuthorizer({
    liveEntryToken: LIVE_TOKEN,
    binding: BINDING,
    now: () => nowMs,
    nonceStore: createDurableXhsV3FixedOperatorNonceStore({
      runtimeRoot: root, binding: BINDING, aclController: acl,
    }),
  });
  assert.throws(
    () => afterRestart.assertAuthorized({ method: "POST", path: PATH, body: BODY, headers }),
    { code: "XHS_V3_FIXED_OPERATOR_REPLAY_REJECTED", status: 409 },
  );
});
