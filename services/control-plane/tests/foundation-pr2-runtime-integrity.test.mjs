import assert from "node:assert/strict";
import test from "node:test";

import { attachNormalizedEffect } from "../control-plane/lib/capability-effect.mjs";
import { decideCapabilityPolicy } from "../control-plane/lib/authorization-decision.mjs";
import { recheckImplementationIntegrity } from "../control-plane/lib/runtime-integrity.mjs";

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

test("RI-02: closure fields change capabilityContractHash", () => {
  const without = attachNormalizedEffect(baseCap());
  const withClosure = attachNormalizedEffect(baseCap({
    implementation: {
      adapter: "test",
      action: "noop",
      implementationClosureHash: "a".repeat(64),
      tcbManifestRef: "tcb.test.v1",
    },
  }));
  assert.notEqual(without.capabilityContractHash, withClosure.capabilityContractHash);
  assert.equal(withClosure.implementation.implementationClosureHash, "a".repeat(64));
});

test("RI-02: authorization snapshot carries closure refs", () => {
  const cap = attachNormalizedEffect(baseCap({
    implementation: {
      adapter: "test",
      action: "noop",
      implementationClosureHash: "b".repeat(64),
      tcbManifestRef: "tcb.auth",
    },
  }));
  const auth = decideCapabilityPolicy(cap, { invocation: "job" });
  assert.equal(auth.decision, "allow");
  assert.equal(auth.capabilityContractHash, cap.capabilityContractHash);
  assert.equal(auth.implementationClosureHash, "b".repeat(64));
  assert.equal(auth.tcbManifestRef, "tcb.auth");
});

test("RI-04: dispatch recheck fails closed on closure drift without adapter I/O signal", () => {
  const bound = attachNormalizedEffect(baseCap({
    implementation: {
      adapter: "test",
      action: "noop",
      implementationClosureHash: "c".repeat(64),
    },
  }));
  const live = attachNormalizedEffect(baseCap({
    implementation: {
      adapter: "test",
      action: "noop",
      implementationClosureHash: "d".repeat(64),
    },
  }));
  const result = recheckImplementationIntegrity({
    boundCapability: bound,
    liveCapability: live,
    phase: "dispatch",
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "IMPLEMENTATION_CONTRACT_CHANGED");
  assert.equal(result.details.notSent, true);
});

test("RI-04: legacy jobs without closure still match when contract hashes agree", () => {
  const bound = attachNormalizedEffect(baseCap());
  const live = attachNormalizedEffect(baseCap());
  const result = recheckImplementationIntegrity({
    boundCapability: bound,
    liveCapability: live,
    phase: "dispatch",
  });
  assert.equal(result.ok, true);
  assert.equal(result.legacy, true);
});

test("RI-04: asymmetric null→present closure fails closed (catalog gained TCB after bind)", () => {
  const bound = attachNormalizedEffect(baseCap());
  const live = attachNormalizedEffect(baseCap({
    implementation: {
      adapter: "test",
      action: "noop",
      implementationClosureHash: "e".repeat(64),
    },
  }));
  const result = recheckImplementationIntegrity({
    boundCapability: bound,
    liveCapability: live,
    phase: "dispatch",
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "IMPLEMENTATION_CONTRACT_CHANGED");
  assert.equal(result.details.notSent, true);
});
