import assert from "node:assert/strict";
import test from "node:test";

import { attachNormalizedEffect } from "../control-plane/lib/capability-effect.mjs";
import {
  assertExpectedImplementationAtSubmit,
  CAPABILITY_CONTRACT_HASH_ALGORITHM_V2,
  recheckImplementationIntegrity,
} from "../control-plane/lib/runtime-integrity.mjs";

function baseCap(over = {}) {
  return {
    schemaVersion: 1,
    id: "test.cap.sample",
    appId: "test",
    packageName: "com.test",
    versionRange: "*",
    maturity: "E2",
    risk: "R0",
    resources: ["device"],
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    preconditions: [],
    verification: { mode: "none", description: "n" },
    restoration: { required: false, description: "n" },
    timeoutMs: 1000,
    idempotency: "read_only",
    automationPolicy: { mode: "automatic" },
    implementation: { adapter: "test", action: "noop" },
    evidence: [],
    availability: "implemented",
    effect: { class: "none", phase: "na", commitBoundary: "automatic" },
    ...over,
  };
}

test("submit expected lock: matching hashes pass; drift fails closed notSent", () => {
  const live = attachNormalizedEffect(baseCap({
    implementation: {
      adapter: "test",
      action: "noop",
      implementationClosureHash: "a".repeat(64),
    },
  }));
  assert.equal(live.capabilityContractHashAlgorithm, CAPABILITY_CONTRACT_HASH_ALGORITHM_V2);
  const ok = assertExpectedImplementationAtSubmit({
    liveCapability: live,
    expectedCapabilityContractHash: live.capabilityContractHash,
    expectedCapabilityContractHashAlgorithm: live.capabilityContractHashAlgorithm,
    expectedImplementationClosureHash: "a".repeat(64),
  });
  assert.equal(ok.ok, true);

  assert.throws(
    () => assertExpectedImplementationAtSubmit({
      liveCapability: live,
      expectedCapabilityContractHash: live.capabilityContractHash,
      expectedCapabilityContractHashAlgorithm: live.capabilityContractHashAlgorithm,
      expectedImplementationClosureHash: "b".repeat(64),
    }),
    (e) => e.code === "IMPLEMENTATION_CONTRACT_CHANGED" && e.details?.notSent === true && e.details?.phase === "submit",
  );
});

test("submit expected lock: omitted expected fields remain legacy-compatible", () => {
  const live = attachNormalizedEffect(baseCap());
  const result = assertExpectedImplementationAtSubmit({ liveCapability: live });
  assert.equal(result.legacy, true);
});

test("contract presence matrix fail-closed (routing twin)", () => {
  const both = recheckImplementationIntegrity({
    boundCapability: { capabilityContractHash: "c".repeat(64), implementationClosureHash: null },
    liveCapability: { capabilityContractHash: "c".repeat(64), implementationClosureHash: null },
  });
  assert.equal(both.ok, true);

  const liveOnly = recheckImplementationIntegrity({
    boundCapability: { capabilityContractHash: null, implementationClosureHash: null },
    liveCapability: { capabilityContractHash: "c".repeat(64), implementationClosureHash: null },
  });
  assert.equal(liveOnly.ok, false);
  assert.equal(liveOnly.details.notSent, true);
});
