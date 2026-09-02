import assert from "node:assert/strict";
import test from "node:test";

import {
  decideLiveGrounding,
  deriveLiveVisualBlockSet,
  deriveTargetEnvironmentAttestation,
  m6LiveSha256,
} from "../../../packages/kernel/lib/m6-live-grounding.mjs";

const H = (value) => m6LiveSha256(value);

function environment() {
  return deriveTargetEnvironmentAttestation({
    appPackageHash: H("package"), appBuildHash: H("build"), signingHash: H("signing"),
    osBuildHash: H("os"), displayHash: H("display"), localeThemeHash: H("locale-theme"),
    accountBindingHash: H("account"),
    imeHash: H("ime"), accessibilityHash: H("accessibility"), accountIsolationHash: H("account"),
    capturedAt: "2030-01-01T00:00:00Z", expiresAt: "2030-01-01T01:00:00Z",
  });
}

function bindings(env) {
  return {
    runId: "run-1", sessionId: "session-1", leaseId: "lease-1",
    gateEpochHash: H("epoch"), gateGeneration: 1, grantHash: H("grant"), stepId: "step-1",
    environmentAttestationHash: env.attestationHash,
  };
}

test("semantic live provider derives stable public blocks while keeping raw text and geometry private", () => {
  const env = environment();
  const frame = { frameId: H("frame"), environmentAttestationHash: env.attestationHash, focusHash: H("focus") };
  const xml = `<hierarchy><node text="公开笔记" resource-id="com.xhs:id/card" class="android.view.View" package="com.xhs" clickable="true" bounds="[10,100][900,500]"/><node text="确认支付" resource-id="com.xhs:id/pay" class="android.widget.Button" package="com.xhs" clickable="true" bounds="[10,600][900,800]"/><node text="" resource-id="" class="android.view.View" package="com.xhs" clickable="false" bounds="[0,0][1080,2400]"/></hierarchy>`;
  const first = deriveLiveVisualBlockSet({ frame, dumpXml: xml, environmentAttestation: env });
  const second = deriveLiveVisualBlockSet({ frame, dumpXml: xml, environmentAttestation: env });
  assert.equal(first.disposition, "ALLOW_ONCE");
  assert.equal(first.blockSet.blocks.length, 1);
  assert.equal(first.blockSet.integritySha256, second.blockSet.integritySha256);
  assert.equal(first.privateGeometry.size, 1);
  const publicJson = JSON.stringify(first.blockSet);
  assert.equal(publicJson.includes("公开笔记"), false);
  assert.equal(publicJson.includes("确认支付"), false);
  assert.equal(publicJson.includes("\"x1\""), false);
});

test("decision v2 target kind comes from trusted intent and forbidden operations hard-stop without coordinates", () => {
  const env = environment();
  const frame = { frameId: H("frame"), environmentAttestationHash: env.attestationHash, focusHash: H("focus") };
  const xml = `<hierarchy><node text="搜索" resource-id="com.xhs:id/search" class="android.widget.EditText" package="com.xhs" clickable="true" bounds="[10,100][900,300]"/><node text="" resource-id="" class="android.view.View" package="com.xhs" clickable="false" bounds="[0,0][1080,2400]"/></hierarchy>`;
  const derived = deriveLiveVisualBlockSet({ frame, dumpXml: xml, environmentAttestation: env });
  const blockId = derived.blockSet.blocks[0].blockId;
  const allow = decideLiveGrounding({
    frame, blockSet: derived.blockSet,
    intent: { operationKey: "search-open", operation: "tap", targetKind: "block" },
    candidateBlockId: blockId,
    bindings: bindings(env),
  });
  assert.equal(allow.disposition, "ALLOW_ONCE");
  assert.deepEqual(allow.target, { kind: "block", frameId: frame.frameId, blockId });
  assert.equal(/\b(?:x|y|bounds)\b/u.test(JSON.stringify(allow)), false);
  const stop = decideLiveGrounding({
    frame, blockSet: derived.blockSet,
    intent: { operationKey: "bad", operation: "payment", targetKind: "block" },
    candidateBlockId: blockId,
    bindings: bindings(env),
  });
  assert.equal(stop.disposition, "HARD_STOP");
});

test("empty or mismatched evidence replans instead of synthesizing a block", () => {
  const env = environment();
  const frame = { frameId: H("frame"), environmentAttestationHash: H("wrong"), focusHash: H("focus") };
  const result = deriveLiveVisualBlockSet({ frame, dumpXml: "<hierarchy/>", environmentAttestation: env });
  assert.equal(result.disposition, "REPLAN");
  assert.equal(result.blockSet, null);
  assert.equal(result.privateGeometry.size, 0);
});

test("nested and neighboring redline semantics hard-stop blank clickable containers independent of intent", () => {
  const env = environment();
  const frame = { frameId: H("redline-frame"), environmentAttestationHash: env.attestationHash, focusHash: H("focus") };
  for (const xml of [
    `<hierarchy><node text="" resource-id="" class="android.widget.Button" package="com.xhs" clickable="true" bounds="[10,100][900,400]"><node text="删除账号" resource-id="com.xhs:id/label" class="android.widget.TextView" package="com.xhs" clickable="false" bounds="[30,140][600,260]"/></node><node text="" class="android.view.View" clickable="false" bounds="[0,0][1080,2400]"/></hierarchy>`,
    `<hierarchy><node text="" resource-id="com.xhs:id/button" class="android.widget.Button" package="com.xhs" clickable="true" bounds="[10,100][900,400]"/><node text="Delete account" resource-id="com.xhs:id/neighbor" class="android.widget.TextView" package="com.xhs" clickable="false" bounds="[30,140][600,260]"/><node text="" class="android.view.View" clickable="false" bounds="[0,0][1080,2400]"/></hierarchy>`,
  ]) {
    const result = deriveLiveVisualBlockSet({ frame, dumpXml: xml, environmentAttestation: env });
    assert.equal(result.disposition, "HARD_STOP");
    assert.equal(result.reason, "M6_LIVE_HARD_REDLINE_NO_SAFE_CANDIDATE");
    assert.equal(result.blockSet, null);
    assert.equal(result.privateGeometry.size, 0);
  }
});

test("malformed node nesting hard-stops before a detached redline can become a candidate", () => {
  const env = environment();
  const frame = { frameId: H("malformed-frame"), environmentAttestationHash: env.attestationHash, focusHash: H("focus") };
  const result = deriveLiveVisualBlockSet({
    frame,
    dumpXml: `<hierarchy><node text="" class="android.widget.Button" package="com.xhs" clickable="true" bounds="[10,100][300,300]"></node></node><node text="删除账号" class="android.widget.TextView" package="com.xhs" clickable="false" bounds="[800,1000][1000,1150]"/></hierarchy>`,
    environmentAttestation: env,
  });
  assert.equal(result.disposition, "HARD_STOP");
  assert.equal(result.reason, "M6_LIVE_DUMP_STRUCTURE_INVALID");
  assert.equal(result.blockSet, null);
  assert.equal(result.privateGeometry.size, 0);
});
