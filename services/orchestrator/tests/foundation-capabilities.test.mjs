import assert from "node:assert/strict";
import test from "node:test";

import {
  foundationMatchesApp,
  loadFoundationCapabilities,
  locatorPolicyFor,
  validateFoundationCatalog,
} from "../scripts/lib/foundation-capabilities.mjs";

test("foundation catalog exposes the visual block locator", () => {
  const capabilities = loadFoundationCapabilities();
  const locator = capabilities.find((item) => item.id === "locator.visual-block.v1");
  assert.ok(locator);
  assert.equal(locator.status, "implemented");
  assert.equal(locator.executionStatus, "canary_only");
  assert.equal(locator.directRun, false);
  assert.equal(foundationMatchesApp(locator, "xhs"), true);
  assert.equal(foundationMatchesApp(locator, "unknown-app"), false);
});

test("locator policy is automatically attached to Explore, workflow, and recipe UI work", () => {
  for (const kind of ["explore", "workflow", "recipe"]) {
    const policy = locatorPolicyFor({ appId: "xhs", steps: [{ kind }] });
    assert.equal(policy.resolved, true, kind);
    assert.equal(policy.foundationCapabilityId, "locator.visual-block.v1", kind);
    assert.equal(policy.executionStatus, "canary_only", kind);
    assert.deepEqual(policy.trustOrder, [
      "semantic_bounds",
      "visual_block_verified_point",
      "fail_closed",
    ], kind);
    assert.equal(policy.rawCoordinateFallback, "forbidden_for_unknown_targets", kind);
    assert.equal(policy.bundledDependency, true, kind);
  }
});

test("foundation catalog rejects duplicate or effectful entries", () => {
  const capabilities = loadFoundationCapabilities();
  const bad = {
    schemaId: "xhs.foundation-capability-catalog.v1",
    schemaVersion: 1,
    capabilities: [capabilities[0], { ...capabilities[0], effect: "external_send" }],
  };
  const errors = validateFoundationCatalog(bad);
  assert.match(JSON.stringify(errors), /unique/);
  assert.match(JSON.stringify(errors), /effect=none/);
});
