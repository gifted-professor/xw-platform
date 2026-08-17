import test from "node:test";
import assert from "node:assert/strict";
import { validateInstance, loadSchema, loadAllSchemas } from "../validate.mjs";

// Every M0 schema must declare schemaId const + schemaVersion const 1 + be loadable.
test("loadAllSchemas loads all 11 M0 schemas keyed by schemaId", () => {
  const all = loadAllSchemas();
  const ids = [...all.keys()].sort();
  assert.equal(all.size, 11, `expected 11 schemas, got ${all.size}: ${ids.join(", ")}`);
  for (const [, { schema }] of all) {
    assert.equal(schema.properties.schemaId.const.startsWith("xhs.m0."), true);
    assert.equal(schema.properties.schemaVersion.const, 1);
    assert.equal(schema.additionalProperties, false);
    assert.ok(Array.isArray(schema.required), "schema has required array");
  }
});

// Helper: build a minimal valid instance per schema by known-answer construction.
const BASE = "xw-m0-20260817-r0";
const NOW = "2026-08-17T00:00:00Z";
const SHA = "0".repeat(40);
const SHA64 = "0".repeat(64);

function validInstance(schemaId) {
  switch (schemaId) {
    case "xhs.m0.file-manifest.v1":
      return {
        schemaId, schemaVersion: 1,
        files: [{ path: "a.txt", gitMode: "100644", size: 1, sha256: SHA64 }],
      };
    case "xhs.m0.baseline-identity.v1":
      return {
        schemaId, schemaVersion: 1, baselineId: BASE, capturedAt: NOW,
        inputPair: {
          registry: { commitSha: SHA, ref: "refs/heads/main", repoOrigin: null },
          deviceAgent: { commitSha: SHA, ref: "refs/heads/main", repoOrigin: null },
        },
        repos: [
          {
            name: "registry", path: "/r",
            source: { commitSha: SHA, ref: "refs/heads/main", repoOrigin: null, verifiedAgainstInputPair: true },
            worktree: { commitSha: SHA, dirty: true, stagedCount: 1, unstagedCount: 2, untrackedCount: 3 },
            deployment: { kind: "windowsScheduledTask", taskName: "XhsDeviceRegistry", argLineRedacted: null, portClaimed: 17930, releaseClaim: "8c5682a", runtimeReachable: true },
          },
          {
            name: "deviceAgent", path: "/d",
            source: { commitSha: SHA, ref: "refs/heads/main", repoOrigin: null, verifiedAgainstInputPair: true },
            worktree: { commitSha: SHA, dirty: false, stagedCount: 0, unstagedCount: 0, untrackedCount: 0 },
            deployment: { kind: "deviceFleet", releaseClaim: "43b09ac", runtimeReachable: false },
          },
        ],
      };
    case "xhs.m0.runtime-attestation.v1":
      return {
        schemaId, schemaVersion: 1, baselineId: BASE, capturedAt: NOW, repo: "registry",
        processLaunchPath: "node", processStartTime: NOW, processCommandLineRedacted: "node registry.mjs --port 17930",
        diskBytesAtObservation: { entryPath: "registry.mjs", sha256: SHA64, size: 1, mtimeIso: NOW },
        launchConfigClaim: "scheduled task", releaseClaim: "8c5682a",
        processLoadedBytes: "UNVERIFIABLE", confidence: "directlyObserved",
      };
    case "xhs.m0.state-ownership.v1":
      return {
        schemaId, schemaVersion: 1, baselineId: BASE, capturedAt: NOW,
        states: [{
          canonicalState: "identities", authoritativeOwner: "feishu", authoritativeStore: "feishu bitable",
          mutationEntrypoint: "PUT /api/identities", derivedCopies: ["registry.db identities table"],
          projectionWriters: [{ writer: "sync-feishu.mjs", constraint: "60s push from feishu" }],
          reconciliationDirection: "ownerToDerived", consistencyModel: "eventual",
        }],
      };
    case "xhs.m0.known-debt.v1":
      return {
        schemaId, schemaVersion: 1, baselineId: BASE, capturedAt: NOW,
        entries: [{
          failureId: "debt_ctrl_unreachable", critical: false, owner: "ops",
          issue: "#14", expiresAt: "2027-01-01T00:00:00Z",
          blocksGates: [], allowsGates: ["m0"], waiverReason: "out of M0 scope",
        }],
      };
    case "xhs.m0.inventory-coverage.v1":
      return {
        schemaId, schemaVersion: 1, baselineId: BASE, capturedAt: NOW, collectorVersion: "m0-inv-1",
        discoveryScope: [{ dimension: "ports", method: "grep + read", notes: "" }],
        inputs: ["registry.mjs", ".env.example"], exclusions: [{ path: "node_modules", reason: "deps" }],
      };
    case "xhs.m0.inventory.v1":
      return {
        schemaId, schemaVersion: 1, baselineId: BASE, capturedAt: NOW, coverageRef: "inventory-coverage.v1.json",
        repos: [{
          name: "registry",
          dimensions: [{ dimension: "ports", items: [{ locator: "registry.mjs:17930", classification: "listen", note: "" }] }],
        }],
        unclassifiedCount: 0,
      };
    case "xhs.m0.pr-assets.v1":
      return {
        schemaId, schemaVersion: 1, baselineId: BASE, capturedAt: NOW, prArchiveRefsVerified: 10,
        prs: [{
          repo: "registry", number: 7, base: SHA, mergeBase: SHA, head: SHA, tree: SHA,
          commits: [SHA], paths: ["tools/m0/jcs.mjs"],
          diffstat: { filesChanged: 1, insertions: 10, deletions: 0 },
          stablePatchId: "abc123", refRestoreVerified: true, portIssue: null,
        }],
      };
    case "xhs.m0.test-baseline.v1":
      return {
        schemaId, schemaVersion: 1, baselineId: BASE, capturedAt: NOW,
        scope: [{ repo: "registry", command: "npm test", purpose: "integration" }],
        gatedOn: ["B2"], rounds: [
          { round: 1, status: "pending", vmImage: null, resultSummary: null },
        ],
        conclusion: "PASS_PENDING",
      };
    case "xhs.m0.private-evidence.v1":
      return {
        schemaId, schemaVersion: 1, baselineId: BASE, capturedAt: NOW, status: "pending_age",
        ciphertextSha256: null, ageRecipientFingerprint: null, fileCount: null,
        restoreReceipt: null, privatePackagePath: null,
      };
    case "xhs.m0.dossier-manifest.v1":
      return {
        schemaId, schemaVersion: 1, baselineId: BASE, capturedAt: NOW,
        files: [{ path: "baseline-identity.v1.json", sha256: SHA64, schemaId: "xhs.m0.baseline-identity.v1", status: "final" }],
      };
    default:
      throw new Error(`no fixture for ${schemaId}`);
  }
}

const all = loadAllSchemas();
for (const [schemaId, { filename }] of all) {
  test(`schema ${schemaId} accepts a minimal valid instance (${filename})`, () => {
    const schema = loadSchema(filename);
    const errs = validateInstance(validInstance(schemaId), schema);
    assert.deepEqual(errs, [], errs.join("\n"));
  });
}

// Negative cases: confirm the validator catches real violations.
test("baseline-identity rejects bad baselineId + missing required + extra prop", () => {
  const schema = loadSchema("baseline-identity.v1.schema.json");
  const bad = validInstance("xhs.m0.baseline-identity.v1");
  bad.baselineId = "not-a-baseline";
  bad.extraField = 1;
  delete bad.capturedAt;
  const errs = validateInstance(bad, schema);
  assert.ok(errs.some((e) => e.includes("baselineId")), "catch bad baselineId");
  assert.ok(errs.some((e) => e.includes("missing required")), "catch missing capturedAt");
  assert.ok(errs.some((e) => e.includes("additional property")), "catch extra prop");
});

test("file-manifest rejects bad sha256 pattern and bad gitMode enum", () => {
  const schema = loadSchema("file-manifest.v1.schema.json");
  const bad = validInstance("xhs.m0.file-manifest.v1");
  bad.files[0].sha256 = "XYZ";
  bad.files[0].gitMode = "040000";
  const errs = validateInstance(bad, schema);
  assert.ok(errs.some((e) => e.includes("does not match")), "catch bad sha256");
  assert.ok(errs.some((e) => e.includes("expected one of")), "catch bad gitMode");
});

test("runtime-attestation forces processLoadedBytes = UNVERIFIABLE", () => {
  const schema = loadSchema("runtime-attestation.v1.schema.json");
  const bad = validInstance("xhs.m0.runtime-attestation.v1");
  bad.processLoadedBytes = "loaded";
  const errs = validateInstance(bad, schema);
  assert.ok(errs.some((e) => e.includes("UNVERIFIABLE")), "catch non-UNVERIFIABLE processLoadedBytes");
});

test("state-ownership rejects bad enum and missing required", () => {
  const schema = loadSchema("state-ownership.v1.schema.json");
  const bad = validInstance("xhs.m0.state-ownership.v1");
  bad.states[0].consistencyModel = "weak";
  delete bad.states[0].canonicalState;
  const errs = validateInstance(bad, schema);
  assert.ok(errs.some((e) => e.includes("expected one of")), "catch bad consistencyModel");
  assert.ok(errs.some((e) => e.includes("missing required")), "catch missing canonicalState");
});

test("known-debt rejects bad failureId pattern and duplicate uniqueItems", () => {
  const schema = loadSchema("known-debt.v1.schema.json");
  const bad = validInstance("xhs.m0.known-debt.v1");
  bad.entries[0].failureId = "Bad Id";
  bad.entries[0].blocksGates = ["m0", "m0"];
  const errs = validateInstance(bad, schema);
  assert.ok(errs.some((e) => e.includes("failureId")), "catch bad failureId");
  assert.ok(errs.some((e) => e.includes("duplicate")), "catch duplicate gates");
});

test("pr-assets rejects non-40-hex sha and bad repo enum", () => {
  const schema = loadSchema("pr-assets.v1.schema.json");
  const bad = validInstance("xhs.m0.pr-assets.v1");
  bad.prs[0].head = "tooshort";
  bad.prs[0].repo = "other";
  const errs = validateInstance(bad, schema);
  assert.ok(errs.some((e) => e.includes("head")), "catch short head sha");
  assert.ok(errs.some((e) => e.includes("expected one of")), "catch bad repo");
});