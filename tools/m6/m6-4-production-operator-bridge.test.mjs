import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  M64_STAGED_CANARY_ORDER,
  deriveM64ActionCanaryReceiptHash,
  deriveM64ResourceCloseoutHash,
  validateM64ResourceProbe,
  loadM64SealedJsonArtifact,
} from "./m6-4-canary-orchestrator.mjs";
import {
  M64_EXPECTATION_INDEX_SCHEMA_ID,
  M64_FORBIDDEN_ORACLE_SOURCE_KINDS,
  M64_INDEPENDENT_ORACLE_POLICY_SCHEMA_ID,
  deriveM64ExpectationIndexHash,
  deriveM64IndependentActorHash,
  deriveM64IndependentOraclePolicyHash,
} from "../../services/control-plane/control-plane/lib/m6-live-production-dependencies.mjs";
import { deriveM6LiveEntryRunId } from "../../services/control-plane/control-plane/lib/m6-live-entry.mjs";
import {
  atomicWriteCompletionReceipt,
  buildM64LiveResourceCloseoutArtifact,
  buildM64LazyDryPreflightResult,
  canonicalM64ProcessInventorySigningBytes,
  createM64AuditedLoopbackCanaryClient,
  createM64NormalCloseInboxResolver,
  createM64ProcessInventoryInboxLoader,
  createM64ProductionResourceProbeProvider,
  deriveM64ProcessInventoryHash,
  deriveM64ExecutionIntentHash,
  deriveM64NormalCloseSigningRequestHash,
  deriveM64ProductionResourceProbe,
  deriveM64PublicRunReceiptHash,
  deriveM64ResourceObservationRequestHash,
  loadM64ExternalNormalCloseBundle,
  loadM64ResourceObserverPolicy,
  publicM64OperatorFailure,
  publishM64ContractArtifacts,
  recoverM64ContractPublication,
  runM64ProductionOperator,
  validateM64ProductionPreMutation,
  validateM64ExternalNormalCloseBundle,
  validateM64IndependentProcessInventory,
} from "./m6-4-production-operator-bridge.mjs";

const H = (value) => createHash("sha256").update(value).digest("hex");
const SIGNATURE = Buffer.alloc(64, 7).toString("base64");
const NOW = Date.parse("2030-01-01T00:10:00.000Z");
const OBSERVER_KEYS = generateKeyPairSync("ed25519");
const OBSERVER_PUBLIC_KEY = OBSERVER_KEYS.publicKey.export({ type: "spki", format: "pem" }).toString();
const OBSERVER_POLICY = Object.freeze({
  artifactSha256: H("independent-oracle-policy-artifact"),
  keyId: "independent-resource-observer-1",
  observerHash: deriveM64IndependentActorHash(OBSERVER_PUBLIC_KEY),
  maxObservationAgeMs: 5_000,
  publicKey: OBSERVER_KEYS.publicKey,
});
const EXECUTION_INTENT_HASH = H("publication-fixture-execution-intent");

function readOnlyHandoffLocator(root, purpose, kind) {
  const suffix = `.${kind}.locator.json`;
  const matches = readdirSync(root).filter((name) => name.startsWith(`${purpose}.`) && name.endsWith(suffix));
  assert.equal(matches.length, 1, `expected one ${purpose} ${kind} locator`);
  return JSON.parse(readFileSync(join(root, matches[0]), "utf8"));
}

function descriptor(root, name, value) {
  const path = join(root, `${name}.json`);
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(path, bytes, "utf8");
  return { path, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function closeFixture() {
  const purpose = "M6_4_ACTION_SMOKE";
  const authorization = {
    purpose,
    gateEpochHash: H("active-gate"),
    envelopeHash: H("authorization"),
    signature: SIGNATURE,
  };
  const window = {
    manifest: { purpose },
    authorization,
    activationPackage: { epoch: { parentEpochHash: H("activation-parent") } },
  };
  const aggregate = {
    schemaId: "xw.m6-4-cohort-aggregate.v1",
    purpose,
    aggregateHash: H("aggregate"),
    attempts: [{ scenarioKey: "m6_4_action_smoke-01", actionCount: 1 }],
  };
  const epoch = {
    mode: "CLOSED",
    purpose,
    parentEpochHash: authorization.gateEpochHash,
    issuedAt: "2030-01-01T00:06:00.000Z",
    expiresAt: "2030-01-01T01:00:00.000Z",
  };
  const bundle = {
    schemaId: "xw.m6-4-gate-close-bundle.v1",
    package: {
      operation: "NORMAL_CLOSE",
      phase: null,
      reasonCode: "NORMAL_COMPLETE",
      epoch,
      authorization,
      proof: {
        algorithm: "ed25519",
        allowlistVersion: 1,
        keyId: "external-gate-key",
        signature: SIGNATURE,
        subject: "operator:external",
      },
    },
    aggregateSeal: { sealPayload: { cohortAggregate: aggregate } },
    closeout: { committedAt: "2030-01-01T00:06:01.000Z" },
    cohortAggregate: aggregate,
  };
  const attemptEvidence = [{
    scenarioKey: "m6_4_action_smoke-01",
    attemptHash: H("close-attempt"),
    oracleEvidence: { observedAt: "2030-01-01T00:05:00.000Z" },
  }];
  return { aggregate, attemptEvidence, bundle, window };
}

function gateStatus(overrides = {}) {
  return {
    schemaId: "xw.m6-gate-f-operations-status.v1",
    mode: "CLOSED",
    phase: "CLOSED",
    purpose: "M6_4_ACTION_SMOKE",
    epochHash: H("closed-gate"),
    generation: 9,
    locksHash: H("locks"),
    tripleConsistent: true,
    errors: [],
    activeAuthorizationCount: 0,
    actionCount: 0,
    resourceCounts: { jobs: 0, leases: 0, runs: 0, sessions: 0 },
    ...overrides,
  };
}

function closeReceipt() {
  const attemptEvidence = { attemptHash: H("attempt"), actionEvidence: { actionCount: 1 } };
  return {
    schemaId: "xw.m6-live-entry-run.v1",
    runId: "run:" + H("run"),
    workerRunRef: "workerrun:" + H("worker"),
    manifestRef: "m6_4_action_smoke",
    manifestHash: H("manifest"),
    scenarioKey: "m6_4_action_smoke-01",
    scenarioClaimHash: H("claim"),
    authorizationId: "auth-1",
    authorizationHash: H("authorization"),
    bindingHash: H("binding"),
    status: "CLOSED",
    actionCount: 1,
    closed: true,
    close: {
      schemaId: "xw.m6-live-entry-close.v1",
      reasonCode: "CANARY_COMPLETE",
      brokerClosed: true,
      workerProtocolClosed: true,
      processClosed: true,
      controlResourcesClosed: true,
      callFenceDrained: true,
      attemptEvidence,
      attemptEvidenceHash: attemptEvidence.attemptHash,
      verifiedClosed: true,
    },
  };
}

function auditedLiveRunFixture() {
  const body = {
    manifestRef: "m6_4_action_smoke",
    manifestHash: H("manifest"),
    scenarioKey: "m6_4_action_smoke-01",
    authorizationId: "auth-1",
    authorizationHash: H("authorization"),
    authorization: { purpose: "M6_4_ACTION_SMOKE" },
  };
  const runId = deriveM6LiveEntryRunId({
    authorizationHash: body.authorizationHash,
    scenarioKey: body.scenarioKey,
  });
  const closed = { ...closeReceipt(), runId };
  const { close: _close, ...runningRaw } = closed;
  const running = { ...runningRaw, status: "RUNNING", actionCount: 0, closed: false };
  return { body, closed, purpose: body.authorization.purpose, runId, running };
}

function mockJsonResponse(payload, { ok = true, status = ok ? 200 : 500 } = {}) {
  return { ok, status, async json() { return payload; } };
}

function processInventory({ receiptHashes, notBeforeMs = NOW, overrides = {} } = {}) {
  const raw = {
    schemaId: "xw.m6-4-independent-process-inventory.v1",
    observerClass: "INDEPENDENT_OS_AND_CONTROL_DB_OBSERVER",
    observerHash: OBSERVER_POLICY.observerHash,
    observerKeyId: OBSERVER_POLICY.keyId,
    signatureAlgorithm: "ed25519",
    purpose: "M6_4_ACTION_SMOKE",
    gateClosedEpochHash: H("closed-gate"),
    requestHash: deriveM64ResourceObservationRequestHash({
      purpose: "M6_4_ACTION_SMOKE",
      gateClosedEpochHash: H("closed-gate"),
      closeReceiptHashes: receiptHashes,
      notBefore: new Date(notBeforeMs).toISOString(),
    }),
    capturedAt: "2030-01-01T00:10:00.000Z",
    closeReceiptHashes: receiptHashes,
    activeBrokerRefs: [],
    activeProcessRefs: [],
    activePipeRefs: [],
    activeScenarioClaimRefs: [],
    orphanProcessRefs: [],
    rawDeviceIdentityFindings: [],
    secretMaterialFindings: [],
    ...overrides,
  };
  const withHash = { ...raw, inventoryHash: deriveM64ProcessInventoryHash(raw) };
  return {
    ...withHash,
    signature: sign(null, canonicalM64ProcessInventorySigningBytes(withHash), OBSERVER_KEYS.privateKey).toString("base64"),
  };
}

test("external normal-close loader rejects stale, wrong aggregate/purpose, and missing signatures", () => {
  const { aggregate, attemptEvidence, bundle, window } = closeFixture();
  assert.equal(validateM64ExternalNormalCloseBundle(bundle, { window, aggregate, attemptEvidence, nowMs: NOW }).ok, true);

  const wrongAggregate = { ...aggregate, aggregateHash: H("wrong") };
  assert.ok(validateM64ExternalNormalCloseBundle(bundle, {
    window, aggregate: wrongAggregate, attemptEvidence, nowMs: NOW,
  }).errors.includes("M64_EXTERNAL_CLOSE_AGGREGATE_MISMATCH"));

  const wrongPurpose = {
    ...bundle,
    package: { ...bundle.package, epoch: { ...bundle.package.epoch, purpose: "M6_4_SMOOTH" } },
  };
  assert.ok(validateM64ExternalNormalCloseBundle(wrongPurpose, {
    window, aggregate, attemptEvidence, nowMs: NOW,
  }).errors.includes("M64_EXTERNAL_CLOSE_PURPOSE_MISMATCH"));

  const missingSignature = { ...bundle, package: { ...bundle.package, proof: { ...bundle.package.proof, signature: null } } };
  assert.ok(validateM64ExternalNormalCloseBundle(missingSignature, {
    window, aggregate, attemptEvidence, nowMs: NOW,
  }).errors.includes("M64_EXTERNAL_CLOSE_SIGNATURE_MISSING"));

  const stale = {
    ...bundle,
    package: { ...bundle.package, epoch: { ...bundle.package.epoch, issuedAt: "2030-01-01T00:04:00.000Z" } },
  };
  assert.ok(validateM64ExternalNormalCloseBundle(stale, {
    window, aggregate, attemptEvidence, nowMs: NOW,
  }).errors.includes("M64_EXTERNAL_CLOSE_STALE"));
});

test("content-addressed close bundle fails on byte tamper and unsigned input returns WAIT_EXTERNAL_AUTHORITY", () => {
  const root = mkdtempSync(join(tmpdir(), "m64-operator-close-"));
  try {
    const { aggregate, attemptEvidence, bundle, window } = closeFixture();
    const sealed = descriptor(root, "close", bundle);
    assert.equal(loadM64ExternalNormalCloseBundle(sealed, {
      window, aggregate, attemptEvidence, nowMs: NOW,
    }).cohortAggregate.aggregateHash, aggregate.aggregateHash);

    writeFileSync(sealed.path, `${JSON.stringify({ ...bundle, injected: true })}\n`, "utf8");
    assert.throws(() => loadM64ExternalNormalCloseBundle(sealed, {
      window, aggregate, attemptEvidence, nowMs: NOW,
    }), { code: "M64_SEALED_ARTIFACT_HASH_MISMATCH" });

    const unsigned = { ...bundle, package: { ...bundle.package, proof: { ...bundle.package.proof, signature: "" } } };
    const unsignedDescriptor = descriptor(root, "unsigned", unsigned);
    assert.throws(() => loadM64ExternalNormalCloseBundle(unsignedDescriptor, {
      window, aggregate, attemptEvidence, nowMs: NOW,
    }), (error) => error.code === "WAIT_EXTERNAL_AUTHORITY"
      && error.details.reasons.includes("M64_EXTERNAL_CLOSE_SIGNATURE_MISSING")
      && error.details.actionCount === 1
      && error.details.liveCompletionClaim === null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("normal-close resolver publishes a bounded two-party request and accepts only its request-bound response slot", async () => {
  const root = mkdtempSync(join(tmpdir(), "m64-close-handoff-"));
  try {
    const { aggregate, attemptEvidence, bundle, window } = closeFixture();
    const responseBundle = {
      ...bundle,
      package: {
        ...bundle.package,
        epoch: {
          ...bundle.package.epoch,
          issuedAt: new Date(NOW).toISOString(),
        },
      },
      closeout: { ...bundle.closeout, committedAt: new Date(NOW).toISOString() },
    };
    const responseArtifact = descriptor(root, "signed-close-response", responseBundle);
    // A legacy purpose-only slot must never bypass the request handshake.
    writeFileSync(join(root, `${window.manifest.purpose}.normal-close.descriptor.json`), `${JSON.stringify(responseArtifact)}\n`, "utf8");
    const acceptedRequests = [];
    let externalTurnCount = 0;
    const resolver = createM64NormalCloseInboxResolver({
      inboxRoot: root,
      now: () => NOW,
      waitMs: 100,
      pollMs: 1,
      forbiddenTokens: ["close-gate-token-that-must-not-cross-the-handoff"],
      recordAcceptedRequest: (entry) => acceptedRequests.push(entry),
      waitForPoll: async () => {
        externalTurnCount += 1;
        const locator = readOnlyHandoffLocator(root, window.manifest.purpose, "normal-close-signing");
        const request = JSON.parse(readFileSync(join(root, locator.artifactFileName), "utf8"));
        assert.deepEqual(Object.keys(request).sort(), [
          "activationParentEpochHash", "aggregate", "aggregateHash", "attemptEvidence", "attemptEvidenceHashes",
          "currentGateEpochHash", "deadline", "purpose", "requestHash", "requestNonce", "requestedAt",
        ].sort());
        assert.equal(request.aggregateHash, aggregate.aggregateHash);
        assert.deepEqual(request.attemptEvidenceHashes, attemptEvidence.map((entry) => entry.attemptHash));
        assert.equal(request.currentGateEpochHash, window.authorization.gateEpochHash);
        assert.equal(request.activationParentEpochHash, window.activationPackage.epoch.parentEpochHash);
        writeFileSync(join(root, locator.responseDescriptorFileName), `${JSON.stringify({
          ...responseArtifact,
          requestHash: request.requestHash,
        }, null, 2)}\n`, "utf8");
      },
    });
    const resolved = await resolver({ window, aggregate, attemptEvidence });
    assert.equal(resolved.cohortAggregate.aggregateHash, aggregate.aggregateHash);
    assert.equal(externalTurnCount, 1);
    assert.equal(acceptedRequests.length, 1);
    assert.equal(acceptedRequests[0].request.aggregateHash, aggregate.aggregateHash);
    assert.equal(Buffer.from(acceptedRequests[0].requestRawBase64, "base64").toString("utf8").includes(
      "close-gate-token-that-must-not-cross-the-handoff",
    ), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fresh same-purpose handoff requests retain distinct immutable locators", async () => {
  const root = mkdtempSync(join(tmpdir(), "m64-fresh-close-handoff-"));
  try {
    const { aggregate, attemptEvidence, bundle, window } = closeFixture();
    let currentNow = NOW;
    const resolver = createM64NormalCloseInboxResolver({
      inboxRoot: root,
      now: () => currentNow,
      waitMs: 100,
      pollMs: 1,
      waitForPoll: async () => {
        const locatorNames = readdirSync(root)
          .filter((name) => name.startsWith(`${window.manifest.purpose}.`)
            && name.endsWith(".normal-close-signing.locator.json"));
        const pending = locatorNames
          .map((name) => JSON.parse(readFileSync(join(root, name), "utf8")))
          .find((locator) => !existsSync(join(root, locator.responseDescriptorFileName)));
        assert.ok(pending, "one fresh request-bound response slot must be pending");
        const response = {
          ...bundle,
          package: {
            ...bundle.package,
            epoch: { ...bundle.package.epoch, issuedAt: new Date(currentNow).toISOString() },
          },
          closeout: { ...bundle.closeout, committedAt: new Date(currentNow).toISOString() },
        };
        const responseArtifact = descriptor(root, `signed-close-${currentNow}`, response);
        writeFileSync(join(root, pending.responseDescriptorFileName), `${JSON.stringify({
          ...responseArtifact,
          requestHash: pending.requestHash,
        }, null, 2)}\n`, "utf8");
      },
    });
    await resolver({ window, aggregate, attemptEvidence });
    await resolver({ window, aggregate, attemptEvidence });
    const locatorNames = readdirSync(root)
      .filter((name) => name.startsWith(`${window.manifest.purpose}.`)
        && name.endsWith(".normal-close-signing.locator.json"));
    assert.equal(locatorNames.length, 2);
    const locators = locatorNames.map((name) => JSON.parse(readFileSync(join(root, name), "utf8")));
    assert.equal(new Set(locators.map((entry) => entry.requestHash)).size, 2);
    assert.equal(locators.every((entry) => existsSync(join(root, entry.artifactFileName))), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resource probe is derived from exact Gate plus close/status/process sources and stays zero", () => {
  const run = closeReceipt();
  const receiptHashes = [deriveM64PublicRunReceiptHash(run)];
  const inventory = processInventory({ receiptHashes });
  const probe = deriveM64ProductionResourceProbe({
    purpose: "M6_4_ACTION_SMOKE",
    gateStatus: gateStatus(),
    closeReceipts: [run],
    statusReceipts: [structuredClone(run)],
    processInventory: inventory,
    processInventorySha256: H("signed-inventory-bytes"),
    observerPolicy: OBSERVER_POLICY,
    processInventoryNotBeforeMs: NOW,
    capturedAt: new Date(NOW).toISOString(),
    tokens: ["gate-token-that-must-never-be-echoed-0001", "live-token-that-must-never-be-echoed-0002"],
  });
  assert.equal(validateM64ResourceProbe(probe, {
    purpose: "M6_4_ACTION_SMOKE", gateClosedEpochHash: H("closed-gate"),
  }).ok, true);
  assert.equal(probe.activeDshProcesses, 0);
  assert.equal(probe.activePipes, 0);
  assert.equal(probe.secretMaterialPresent, false);
  assert.equal(probe.processInventoryHash, inventory.inventoryHash);
  assert.equal(probe.processInventorySha256, H("signed-inventory-bytes"));
  assert.equal(probe.resourceObservationRequestHash, inventory.requestHash);
  assert.equal(probe.resourceObserverHash, OBSERVER_POLICY.observerHash);
  assert.equal(probe.resourceObserverKeyId, OBSERVER_POLICY.keyId);
  assert.equal(probe.independentOracleArtifactSha256, OBSERVER_POLICY.artifactSha256);
});

test("resource observer receives an exact filesystem request and returns a signed request-bound inventory", async () => {
  const root = mkdtempSync(join(tmpdir(), "m64-resource-handoff-"));
  try {
    const requestsRoot = join(root, "requests");
    const processInboxRoot = join(root, "responses");
    mkdirSync(requestsRoot);
    mkdirSync(processInboxRoot);
    const run = closeReceipt();
    const receiptHashes = [deriveM64PublicRunReceiptHash(run)];
    const notBeforeMs = NOW - 1_000;
    const purpose = "M6_4_ACTION_SMOKE";
    // The legacy unbound slot must be ignored even though it is syntactically present.
    writeFileSync(join(processInboxRoot, `${purpose}.resource.descriptor.json`), "{}\n", "utf8");
    let observerTurnCount = 0;
    const loader = createM64ProcessInventoryInboxLoader({
      inboxRoot: processInboxRoot,
      now: () => NOW,
      waitMs: 100,
      pollMs: 1,
      waitForPoll: async () => {
        observerTurnCount += 1;
        const locator = readOnlyHandoffLocator(requestsRoot, purpose, "resource-observation");
        const request = JSON.parse(readFileSync(join(requestsRoot, locator.artifactFileName), "utf8"));
        assert.deepEqual(Object.keys(request).sort(), [
          "closeReceiptHashes", "gateClosedEpochHash", "notBefore", "purpose", "requestHash",
        ].sort());
        assert.deepEqual(request.closeReceiptHashes, receiptHashes);
        assert.equal(request.notBefore, new Date(notBeforeMs).toISOString());
        const inventory = processInventory({ receiptHashes, notBeforeMs });
        assert.equal(inventory.requestHash, request.requestHash);
        const inventoryDescriptor = descriptor(processInboxRoot, "signed-process-inventory", inventory);
        writeFileSync(join(processInboxRoot, locator.responseDescriptorFileName), `${JSON.stringify({
          ...inventoryDescriptor,
          requestHash: request.requestHash,
        }, null, 2)}\n`, "utf8");
      },
    });
    const accepted = [];
    let sealedPurpose = null;
    const provider = createM64ProductionResourceProbeProvider({
      audit: {
        snapshot: () => ({
          closeReceipts: [run],
          statusReceipts: [structuredClone(run)],
          notBeforeMs,
        }),
        seal: (value) => { sealedPurpose = value; },
      },
      loadProcessInventoryDescriptor: loader,
      observerPolicy: { ...OBSERVER_POLICY, requestsRoot },
      recordAcceptedEvidence: (entry) => accepted.push(entry),
      tokens: ["observer-gate-token-that-must-never-cross-handoff"],
      now: () => NOW,
    });
    const probe = await provider({ purpose, gateClosedStatus: gateStatus() });
    assert.equal(probe.resourceObservationRequestHash, accepted[0].resourceObservationRequestHash);
    assert.equal(observerTurnCount, 1);
    assert.equal(sealedPurpose, purpose);
    assert.equal(accepted.length, 1);
    assert.equal(Buffer.from(accepted[0].resourceObservationRequestRawBase64, "base64").toString("utf8").includes(
      "observer-gate-token-that-must-never-cross-handoff",
    ), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("nonzero Gate resources and observer secret findings cannot be represented as a green probe", () => {
  const run = closeReceipt();
  const receiptHashes = [deriveM64PublicRunReceiptHash(run)];
  const inventory = processInventory({
    receiptHashes,
    overrides: { secretMaterialFindings: [H("secret-finding")] },
  });
  const probe = deriveM64ProductionResourceProbe({
    purpose: "M6_4_ACTION_SMOKE",
    gateStatus: gateStatus({ resourceCounts: { jobs: 1, leases: 0, runs: 0, sessions: 0 } }),
    closeReceipts: [run],
    statusReceipts: [structuredClone(run)],
    processInventory: inventory,
    processInventorySha256: H("signed-inventory-bytes-with-secret-finding"),
    observerPolicy: OBSERVER_POLICY,
    processInventoryNotBeforeMs: NOW,
    capturedAt: new Date(NOW).toISOString(),
  });
  const validation = validateM64ResourceProbe(probe, {
    purpose: "M6_4_ACTION_SMOKE", gateClosedEpochHash: H("closed-gate"),
  });
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.includes("M64_RESOURCE_NOT_ZERO"));
  assert.equal(probe.activeJobs, 1);
  assert.equal(probe.pendingApprovals, 1);
  assert.equal(probe.secretMaterialPresent, true);
});

test("independent process inventory rejects stale observation and close-receipt substitution", () => {
  const run = closeReceipt();
  const expected = [deriveM64PublicRunReceiptHash(run)];
  const stale = processInventory({
    receiptHashes: [H("substituted-close")],
    notBeforeMs: NOW - 1_000,
    overrides: { capturedAt: "2030-01-01T00:08:00.000Z" },
  });
  const validation = validateM64IndependentProcessInventory(stale, {
    purpose: "M6_4_ACTION_SMOKE",
    gateClosedEpochHash: H("closed-gate"),
    closeReceiptHashes: expected,
    observerPolicy: OBSERVER_POLICY,
    notBeforeMs: NOW - 1_000,
    nowMs: NOW,
    maxAgeMs: 30_000,
  });
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.includes("M64_PROCESS_INVENTORY_STALE"));
  assert.ok(validation.errors.includes("M64_PROCESS_INVENTORY_CLOSE_BINDING_MISMATCH"));
});

test("independent process inventory rejects a self-hashed payload without the trusted observer signature", () => {
  const run = closeReceipt();
  const expected = [deriveM64PublicRunReceiptHash(run)];
  const inventory = processInventory({ receiptHashes: expected, notBeforeMs: NOW - 1_000 });
  const tampered = {
    ...inventory,
    signature: Buffer.alloc(64, 9).toString("base64"),
  };
  const validation = validateM64IndependentProcessInventory(tampered, {
    purpose: "M6_4_ACTION_SMOKE",
    gateClosedEpochHash: H("closed-gate"),
    closeReceiptHashes: expected,
    observerPolicy: OBSERVER_POLICY,
    notBeforeMs: NOW - 1_000,
    nowMs: NOW,
    maxAgeMs: 30_000,
  });
  assert.equal(validation.ok, false);
  assert.deepEqual(validation.errors, ["M64_PROCESS_INVENTORY_SIGNATURE_INVALID"]);
});

test("public operator failure schema cannot echo a secret-bearing message or details", () => {
  const token = "top-secret-operator-token-0000000000000001";
  const error = Object.assign(new Error(`provider failed with ${token}`), {
    code: "WAIT_EXTERNAL_AUTHORITY",
    details: { token },
  });
  const output = publicM64OperatorFailure(error);
  const rendered = JSON.stringify(output);
  assert.equal(output.terminalStatus, "WAIT_EXTERNAL_AUTHORITY");
  assert.equal(output.liveCompletionClaim, null);
  assert.equal(output.actionCount, null);
  assert.equal(rendered.includes(token), false);
  assert.deepEqual(Object.keys(output).sort(), ["actionCount", "code", "liveCompletionClaim", "ok", "terminalStatus"]);

  const unsafe = publicM64OperatorFailure(Object.assign(new Error("must not be echoed"), {
    code: "M64_GATE_SAFETY_CLOSE_UNVERIFIED",
    details: { unsafeGateState: true },
  }));
  assert.equal(unsafe.terminalStatus, "UNSAFE_GATE_ACTIVE_OR_UNKNOWN");
  assert.equal(unsafe.liveCompletionClaim, null);
});

test("audited production client requires separate Gate/live credentials and routes each only to its authority", async () => {
  const gateToken = "bridge-gate-token-that-is-at-least-32-bytes";
  const liveToken = "bridge-live-token-that-is-at-least-32-bytes";
  assert.throws(() => createM64AuditedLoopbackCanaryClient({
    gateToken,
    liveToken: gateToken,
    fetchImpl: async () => { throw new Error("must not fetch"); },
  }), { code: "M64_OPERATOR_TOKEN_SEPARATION_REQUIRED" });

  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ path: new URL(url).pathname, token: options.headers["x-control-token"] });
    const payload = String(url).includes("/gate-f/status")
      ? { gate: { schemaId: "test-gate-status" } }
      : { preflight: { status: "SEALED_PREFLIGHT", resourceCount: 0 } };
    return { ok: true, async json() { return payload; } };
  };
  const { client } = createM64AuditedLoopbackCanaryClient({ gateToken, liveToken, fetchImpl });
  await client.gateStatus();
  await client.livePreflight({ manifestRef: "sealed" });
  assert.deepEqual(calls, [
    { path: "/control/v1/internal/m6/gate-f/status", token: gateToken },
    { path: "/control/v1/internal/m6/live/preflight", token: liveToken },
  ]);
});

test("audited production client preserves a run whose start committed before its response timed out", async () => {
  const gateToken = "bridge-start-timeout-gate-token-at-least-32-bytes";
  const liveToken = "bridge-start-timeout-live-token-at-least-32-bytes";
  const { body, closed, purpose, runId, running } = auditedLiveRunFixture();
  const operations = [];
  let serverRun = null;
  const fetchImpl = async (url, options) => {
    const endpoint = new URL(url);
    const operation = endpoint.pathname.split("/").at(-1);
    operations.push(operation);
    if (operation === "start") {
      assert.deepEqual(JSON.parse(options.body), body);
      serverRun = running;
      throw Object.assign(new Error("start response was lost after commit"), { code: "M64_LOOPBACK_REQUEST_TIMEOUT" });
    }
    if (operation === "status") {
      assert.equal(endpoint.searchParams.get("runId"), runId);
      return mockJsonResponse({ run: serverRun });
    }
    if (operation === "close") {
      assert.deepEqual(JSON.parse(options.body), { reasonCode: "CANARY_COMPLETE", runId });
      serverRun = closed;
      return mockJsonResponse({ run: serverRun });
    }
    throw new Error(`unexpected operation: ${operation}`);
  };
  const { client, audit } = createM64AuditedLoopbackCanaryClient({
    gateToken, liveToken, fetchImpl, now: () => NOW,
  });

  await assert.rejects(client.liveStart(body), { code: "M64_LOOPBACK_REQUEST_TIMEOUT" });
  assert.equal((await client.liveStatus(runId)).status, "RUNNING");
  assert.deepEqual(await client.liveClose(runId, "CANARY_COMPLETE"), closed);
  assert.deepEqual(await client.liveStatus(runId), closed);

  const snapshot = audit.snapshot(purpose);
  assert.deepEqual(snapshot.closeReceipts, [closed]);
  assert.deepEqual(snapshot.statusReceipts, [closed]);
  assert.equal(audit.actionCount(), closed.actionCount);
  assert.deepEqual(operations, ["start", "status", "close", "status"]);
});

test("audited production client recovers the complete canonical receipt after close commits then times out", async () => {
  const gateToken = "bridge-close-timeout-gate-token-at-least-32-bytes";
  const liveToken = "bridge-close-timeout-live-token-at-least-32-bytes";
  const { body, closed, purpose, runId, running } = auditedLiveRunFixture();
  const operations = [];
  let serverRun = null;
  const fetchImpl = async (url, options) => {
    const endpoint = new URL(url);
    const operation = endpoint.pathname.split("/").at(-1);
    operations.push(operation);
    if (operation === "start") {
      serverRun = running;
      return mockJsonResponse({ run: serverRun });
    }
    if (operation === "close") {
      assert.deepEqual(JSON.parse(options.body), { reasonCode: "CANARY_COMPLETE", runId });
      serverRun = closed;
      throw Object.assign(new Error("close response was lost after commit"), { code: "M64_LOOPBACK_REQUEST_TIMEOUT" });
    }
    if (operation === "status") {
      assert.equal(endpoint.searchParams.get("runId"), runId);
      return mockJsonResponse({ run: serverRun });
    }
    throw new Error(`unexpected operation: ${operation}`);
  };
  const { client, audit } = createM64AuditedLoopbackCanaryClient({
    gateToken, liveToken, fetchImpl, now: () => NOW,
  });

  assert.deepEqual(await client.liveStart(body), running);
  await assert.rejects(client.liveClose(runId, "CANARY_COMPLETE"), { code: "M64_LOOPBACK_REQUEST_TIMEOUT" });
  assert.deepEqual(await client.liveStatus(runId), closed);

  const snapshot = audit.snapshot(purpose);
  assert.deepEqual(snapshot.closeReceipts, [closed]);
  assert.deepEqual(snapshot.statusReceipts, [closed]);
  assert.equal(audit.actionCount(), closed.actionCount);
  assert.deepEqual(operations, ["start", "close", "status"]);
});

test("audited production client rejects terminal run-authority rebound and per-run action-count drift", async () => {
  const gateToken = "bridge-rebound-gate-token-that-is-at-least-32-bytes";
  const liveToken = "bridge-rebound-live-token-that-is-at-least-32-bytes";
  for (const terminal of [
    (closed) => ({ ...closed, bindingHash: H("rebound-binding") }),
    (closed) => ({ ...closed, actionCount: closed.actionCount + 1 }),
  ]) {
    const { body, closed, runId, running } = auditedLiveRunFixture();
    let serverRun = running;
    const fetchImpl = async (url) => {
      const endpoint = new URL(url);
      const operation = endpoint.pathname.split("/").at(-1);
      if (operation === "start") return mockJsonResponse({ run: running });
      if (operation === "status") return mockJsonResponse({ run: serverRun });
      if (operation === "close") {
        serverRun = terminal(closed);
        return mockJsonResponse({ run: serverRun });
      }
      throw new Error(`unexpected operation: ${operation}`);
    };
    const { client } = createM64AuditedLoopbackCanaryClient({ gateToken, liveToken, fetchImpl });
    await client.liveStart(body);
    await assert.rejects(client.liveClose(runId, "CANARY_COMPLETE"), (error) => [
      "M64_RESOURCE_LIVE_CLOSE_SOURCE_INVALID",
      "M64_RESOURCE_LIVE_STATUS_MISMATCH",
    ].includes(error.code));
  }
});

test("audited production client excludes only a failed provisional start proven absent by fresh 404 and CLOSED-zero", async () => {
  const gateToken = "bridge-absent-start-gate-token-at-least-32-bytes";
  const liveToken = "bridge-absent-start-live-token-at-least-32-bytes";
  const { body, purpose, runId } = auditedLiveRunFixture();
  const fetchImpl = async (url) => {
    const endpoint = new URL(url);
    const operation = endpoint.pathname.split("/").at(-1);
    if (endpoint.pathname.endsWith("/gate-f/status")) return mockJsonResponse({ gate: gateStatus() });
    if (operation === "start") {
      return mockJsonResponse({ error: { code: "M6_LIVE_SCENARIO_CLAIM_REJECTED", message: "rejected before commit" } }, {
        ok: false, status: 409,
      });
    }
    if (operation === "status") {
      return mockJsonResponse({ error: { code: "M6_LIVE_RUN_NOT_FOUND", message: "run not found" } }, {
        ok: false, status: 404,
      });
    }
    throw new Error(`unexpected operation: ${operation}`);
  };
  const { client, audit } = createM64AuditedLoopbackCanaryClient({
    gateToken, liveToken, fetchImpl, now: () => NOW,
  });

  await assert.rejects(client.liveStart(body), { code: "M6_LIVE_SCENARIO_CLAIM_REJECTED" });
  await client.gateStatus();
  await assert.rejects(client.liveStatus(runId), { code: "M6_LIVE_RUN_NOT_FOUND" });
  assert.deepEqual(audit.snapshot(purpose), {
    closeReceipts: [],
    statusReceipts: [],
    notBeforeMs: NOW,
  });
});

function independentOraclePolicyDescriptor(root, boundary) {
  const authorKeys = generateKeyPairSync("ed25519");
  const authorPublicKey = authorKeys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const observationRoot = resolve(root, "independent-observations");
  mkdirSync(resolve(observationRoot, "requests"), { recursive: true });
  mkdirSync(resolve(observationRoot, "observations"), { recursive: true });
  const expectationIndexRaw = {
    schemaId: M64_EXPECTATION_INDEX_SCHEMA_ID,
    entries: [{
      lookupHash: H("fixture-expectation-lookup"),
      expectationEnvelope: {
        path: resolve(root, "fixture-expectation-envelope.json"),
        sha256: H("fixture-expectation-envelope"),
      },
    }],
  };
  const expectationIndex = {
    ...expectationIndexRaw,
    indexHash: deriveM64ExpectationIndexHash(expectationIndexRaw),
  };
  const expectationIndexDescriptor = descriptor(root, "expectation-index", expectationIndex);
  const raw = {
    schemaId: M64_INDEPENDENT_ORACLE_POLICY_SCHEMA_ID,
    effectBoundaryHash: boundary.boundaryHash,
    expectationIndex: expectationIndexDescriptor,
    expectationAuthorKeyId: "independent-expectation-author-1",
    expectationAuthorPublicKey: authorPublicKey,
    independentAuthorHash: deriveM64IndependentActorHash(authorPublicKey),
    observationRoot,
    observationObserverKeyId: OBSERVER_POLICY.keyId,
    observationObserverPublicKey: OBSERVER_PUBLIC_KEY,
    independentObserverHash: OBSERVER_POLICY.observerHash,
    allowedSourceKinds: ["ACCOUNT_READ_SNAPSHOT", "DEVICE_READ_SNAPSHOT", "BACKEND_READ_SNAPSHOT"],
    requiredSourceKinds: ["ACCOUNT_READ_SNAPSHOT", "DEVICE_READ_SNAPSHOT", "BACKEND_READ_SNAPSHOT"],
    forbiddenSourceKinds: [...M64_FORBIDDEN_ORACLE_SOURCE_KINDS],
    maxObservationAgeMs: 5_000,
  };
  const policy = { ...raw, policyHash: deriveM64IndependentOraclePolicyHash(raw) };
  return descriptor(root, "independent-oracle-policy", policy);
}

function productionRecoveryFixture(root) {
  const boundary = JSON.parse(readFileSync(resolve(
    "artifacts/m6-4/cohort-manifests/xw.m6-effect-boundary.v1.json",
  ), "utf8"));
  const effectBoundaryDescriptor = descriptor(root, "effect-boundary", boundary);
  const independentOraclePolicyDescriptorValue = independentOraclePolicyDescriptor(root, boundary);
  const windowInventoryInboxRoot = join(root, "window-inbox");
  const closeInboxRoot = join(root, "close-inbox");
  const processInventoryInboxRoot = join(root, "process-inbox");
  const auditRoot = join(root, "audit");
  const repositoryRoot = join(root, "repository");
  const releaseRoot = join(root, "release");
  for (const path of [
    windowInventoryInboxRoot, closeInboxRoot, processInventoryInboxRoot, auditRoot, releaseRoot,
  ]) mkdirSync(path);
  mkdirSync(join(repositoryRoot, "artifacts", "m6-4"), { recursive: true });
  return Object.freeze({
    effectBoundaryDescriptor,
    independentOraclePolicyDescriptor: independentOraclePolicyDescriptorValue,
    windowInventoryInboxRoot,
    closeInboxRoot,
    processInventoryInboxRoot,
    auditRoot,
    repositoryRoot,
    releaseRoot,
    contractAuditRoot: auditRoot,
    gateToken: "execution-recovery-gate-token-that-is-at-least-32-bytes",
    liveToken: "execution-recovery-live-token-that-is-at-least-32-bytes",
    dryPreflight: false,
    now: () => NOW,
  });
}

async function persistProductionExecutionIntent(common) {
  let fetchCount = 0;
  await assert.rejects(() => runM64ProductionOperator({
    ...common,
    fetchImpl: async () => { fetchCount += 1; throw new Error("intent cutpoint must precede fetch"); },
    faultAfterExecutionStep(step) {
      if (step === "EXECUTION_INTENT_DURABLE") {
        throw Object.assign(new Error("simulated process loss after durable intent"), { code: "TEST_EXECUTION_CUTPOINT" });
      }
    },
  }), { code: "TEST_EXECUTION_CUTPOINT" });
  assert.equal(fetchCount, 0);
  assert.equal(existsSync(join(
    common.auditRoot, "m6-4-execution-intent", "m6-4-live-execution-intent.json",
  )), true);
}

function recoveryGatePayload({ priorEpochHash, terminalEpochHash, purpose, recovered }) {
  return {
    recovery: {
      schemaId: "xw.m6-gate-f-armed-active-recovery.v1",
      recovered,
      priorEpochHash,
      terminalEpochHash,
      tripleConsistent: true,
      status: recovered ? "EMERGENCY_CLOSED" : "ALREADY_CLOSED",
    },
    gate: gateStatus({
      purpose,
      epochHash: terminalEpochHash,
      resourceCounts: recovered
        ? { jobs: 0, leases: 0, runs: 1, sessions: 0 }
        : { jobs: 0, leases: 0, runs: 0, sessions: 0 },
    }),
  };
}

function liveEpochRecoveryPayload({ gateEpochHash, purpose, closeReceiptHashes = [] }) {
  const closeReceipts = closeReceiptHashes.map((closeReceiptHash, index) => ({
    runId: `run:${H(`recovery-run:${index}`)}`,
    closeReceiptHash,
    attemptEvidenceHash: H(`recovery-attempt:${index}`),
  }));
  return {
    schemaId: "xw.m6-live-entry-epoch-recovery.v1",
    status: "RECOVERED",
    gateEpochHash,
    purpose,
    stopNewStarts: true,
    inFlightStartsSettled: 0,
    attempted: closeReceipts.length,
    verifiedClosed: closeReceipts.length,
    activeMatchingRuns: 0,
    controlPlaneOwnedActiveRuns: 0,
    externalResourceState: "NOT_ASSERTED",
    closeReceipts,
  };
}

function recoveryObserverResponder(common) {
  const requestsRoot = join(resolve(common.effectBoundaryDescriptor.path, ".."), "independent-observations", "requests");
  let responseCount = 0;
  return Object.freeze({
    get responseCount() { return responseCount; },
    async respond() {
      const locatorNames = readdirSync(requestsRoot)
        .filter((name) => name.endsWith(".resource-observation.locator.json"));
      assert.ok(locatorNames.length >= 1, "recovery must publish a request-bound observer locator");
      const locator = JSON.parse(readFileSync(join(requestsRoot, locatorNames.at(-1)), "utf8"));
      const request = JSON.parse(readFileSync(join(requestsRoot, locator.artifactFileName), "utf8"));
      const inventory = processInventory({
        receiptHashes: request.closeReceiptHashes,
        notBeforeMs: Date.parse(request.notBefore),
        overrides: {
          purpose: request.purpose,
          gateClosedEpochHash: request.gateClosedEpochHash,
          requestHash: request.requestHash,
          capturedAt: new Date(NOW).toISOString(),
        },
      });
      const inventoryDescriptor = descriptor(
        common.processInventoryInboxRoot, `recovery-inventory-${responseCount}`, inventory,
      );
      writeFileSync(join(common.processInventoryInboxRoot, locator.responseDescriptorFileName), `${JSON.stringify({
        ...inventoryDescriptor,
        requestHash: request.requestHash,
      }, null, 2)}\n`, "utf8");
      responseCount += 1;
    },
  });
}

function createLinkOrSkipExactWindowsEperm(t, target, path, type) {
  try {
    symlinkSync(target, path, type);
    return true;
  } catch (error) {
    if (process.platform === "win32" && error?.code === "EPERM") {
      t.skip("Windows symlink privilege is unavailable (EPERM)");
      return false;
    }
    throw error;
  }
}

test("resource observer policy loader rejects a content-addressed policy that permits circular SUT evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "m64-observer-policy-"));
  try {
    const boundary = JSON.parse(readFileSync(resolve(
      "artifacts/m6-4/cohort-manifests/xw.m6-effect-boundary.v1.json",
    ), "utf8"));
    const sealed = independentOraclePolicyDescriptor(root, boundary);
    assert.equal(loadM64ResourceObserverPolicy(sealed).observerHash, OBSERVER_POLICY.observerHash);
    const policy = JSON.parse(readFileSync(sealed.path, "utf8"));
    policy.forbiddenSourceKinds = policy.forbiddenSourceKinds.filter((kind) => kind !== "MODEL_OUTPUT");
    policy.policyHash = deriveM64IndependentOraclePolicyHash(policy);
    const bytes = `${JSON.stringify(policy, null, 2)}\n`;
    writeFileSync(sealed.path, bytes, "utf8");
    assert.throws(() => loadM64ResourceObserverPolicy({ path: sealed.path, sha256: H(bytes) }), {
      code: "M64_RESOURCE_OBSERVER_POLICY_INVALID",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resource observer policy preflight binds the effect boundary and independent outside-release filesystem", () => {
  const root = mkdtempSync(join(tmpdir(), "m64-observer-policy-boundary-"));
  try {
    const boundary = JSON.parse(readFileSync(resolve(
      "artifacts/m6-4/cohort-manifests/xw.m6-effect-boundary.v1.json",
    ), "utf8"));
    const sealed = independentOraclePolicyDescriptor(root, boundary);
    assert.throws(() => loadM64ResourceObserverPolicy(sealed, {
      effectBoundaryHash: H("wrong-effect-boundary"),
    }), { code: "M64_RESOURCE_OBSERVER_POLICY_REBOUND" });
    assert.throws(() => loadM64ResourceObserverPolicy(sealed, {
      effectBoundaryHash: boundary.boundaryHash,
      releaseRoot: root,
    }), { code: "M64_LIVE_ARTIFACT_INSIDE_RELEASE" });
    rmSync(join(root, "independent-observations", "requests"), { recursive: true, force: true });
    assert.throws(() => loadM64ResourceObserverPolicy(sealed, {
      effectBoundaryHash: boundary.boundaryHash,
    }), { code: "M64_RESOURCE_OBSERVER_POLICY_INVALID" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sealed operator artifacts reject an external hard-link alias to release-owned bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "m64-sealed-hardlink-"));
  try {
    const releaseRoot = join(root, "release");
    const externalRoot = join(root, "external");
    mkdirSync(releaseRoot);
    mkdirSync(externalRoot);
    const releasePath = join(releaseRoot, "policy.json");
    const externalPath = join(externalRoot, "policy.json");
    const bytes = Buffer.from('{"schemaId":"fixture"}\n', "utf8");
    writeFileSync(releasePath, bytes);
    linkSync(releasePath, externalPath);
    assert.throws(() => loadM64SealedJsonArtifact({ path: externalPath, sha256: H(bytes) }), {
      code: "M64_SEALED_ARTIFACT_PATH_INVALID",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("completion receipt publication atomically reads back exact bytes and is idempotent", () => {
  const root = mkdtempSync(join(tmpdir(), "m64-audit-atomic-"));
  try {
    const receipt = { schemaId: "xw.m6-4-action-canary-completion.test.v1", receiptHash: H("atomic-receipt") };
    const expectedBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    const first = atomicWriteCompletionReceipt(root, receipt);
    assert.equal(first.sha256, H(expectedBytes));
    assert.deepEqual(readFileSync(first.path), expectedBytes);
    assert.deepEqual(atomicWriteCompletionReceipt(root, receipt), first);
    assert.deepEqual(readdirSync(join(root, "m6-4-action-canary-completion")), [`${receipt.receiptHash}.json`]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("audit guard accepts the POSIX parent link-count change from its own child directory", (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX directory link-count semantics are not available on Windows");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "m64-audit-posix-nlink-"));
  try {
    const before = lstatSync(root, { bigint: true });
    const receipt = { schemaId: "xw.m6-4-action-canary-completion.test.v1", receiptHash: H("posix-nlink-receipt") };
    const published = atomicWriteCompletionReceipt(root, receipt);
    const after = lstatSync(root, { bigint: true });
    assert.equal(after.dev, before.dev);
    assert.equal(after.ino, before.ino);
    assert.ok(after.nlink > before.nlink, "creating the receipt child directory must change the POSIX parent link count");
    assert.equal(readFileSync(published.path, "utf8"), `${JSON.stringify(receipt, null, 2)}\n`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("contract publication journals before every output and recovers every cutpoint without live replay", async () => {
  const root = mkdtempSync(join(tmpdir(), "m64-contract-publication-"));
  try {
    const repositoryRoot = join(root, "repository");
    const auditRoot = join(root, "audit");
    mkdirSync(join(repositoryRoot, "artifacts", "m6-4"), { recursive: true });
    mkdirSync(auditRoot);
    const purposes = [...M64_STAGED_CANARY_ORDER, "M6_4_FINAL"];
    const acceptedResourceEvidence = purposes.map((purpose, index) => {
      const gateClosedEpochHash = H(`closed-epoch:${purpose}`);
      const requestRaw = {
        purpose,
        gateClosedEpochHash,
        closeReceiptHashes: [],
        notBefore: new Date(NOW - 1_000).toISOString(),
      };
      const resourceObservationRequestHash = deriveM64ResourceObservationRequestHash(requestRaw);
      const resourceObservationRequest = { ...requestRaw, requestHash: resourceObservationRequestHash };
      const resourceObservationRequestBytes = Buffer.from(
        `${JSON.stringify(resourceObservationRequest, null, 2)}\n`, "utf8",
      );
      const inventoryRaw = {
        schemaId: "xw.m6-4-independent-process-inventory.v1",
        purpose,
        ordinal: index,
      };
      const processInventory = {
        ...inventoryRaw,
        inventoryHash: deriveM64ProcessInventoryHash(inventoryRaw),
      };
      const processInventoryBytes = Buffer.from(`${JSON.stringify(processInventory, null, 2)}\n`, "utf8");
      const processInventorySha256 = H(processInventoryBytes);
      return {
        purpose,
        gateClosedEpochHash,
        processInventorySha256,
        processInventoryRawBase64: processInventoryBytes.toString("base64"),
        processInventory,
        resourceObservationRequest,
        resourceObservationRequestHash,
        resourceObservationRequestSha256: H(resourceObservationRequestBytes),
        resourceObservationRequestRawBase64: resourceObservationRequestBytes.toString("base64"),
        resourceProbe: {
          purpose,
          gateClosedEpochHash,
          processInventorySha256,
          processInventoryHash: processInventory.inventoryHash,
          resourceObservationRequestHash,
          probeHash: H(`probe:${purpose}`),
        },
      };
    });
    const resourceCloseoutRaw = {
      schemaId: "xw.m6-4-live-resource-closeout.v1",
      windowProbeHashes: acceptedResourceEvidence.slice(0, -1).map((entry) => entry.resourceProbe.probeHash),
      finalProbeHash: acceptedResourceEvidence.at(-1).resourceProbe.probeHash,
    };
    const resourceCloseout = {
      ...resourceCloseoutRaw,
      resourceCloseoutHash: deriveM64ResourceCloseoutHash(resourceCloseoutRaw),
    };
    const receiptRaw = {
      schemaId: "xw.m6-4-action-canary-completion.v1",
      terminalStatus: "M6_4_ACTION_CANARY_CLOSED",
      resourceCloseoutHash: resourceCloseout.resourceCloseoutHash,
    };
    const receipt = { ...receiptRaw, receiptHash: deriveM64ActionCanaryReceiptHash(receiptRaw) };
    const windowResults = acceptedResourceEvidence.slice(0, -1).map((entry, index) => {
      const purpose = M64_STAGED_CANARY_ORDER[index];
      const attemptEvidence = [{ scenarioKey: `${purpose.toLowerCase()}-01`, attemptHash: H(`attempt:${purpose}`) }];
      const aggregate = {
        schemaId: "xw.m6-4-cohort-aggregate.v1",
        purpose,
        aggregateHash: H(`aggregate:${purpose}`),
        attempts: attemptEvidence.map((attempt) => ({
          scenarioKey: attempt.scenarioKey,
          actionCount: index + 1,
        })),
      };
      return {
        resourceProbe: entry.resourceProbe,
        attemptEvidence,
        aggregate,
        window: {
          manifest: { purpose },
          authorization: { gateEpochHash: H(`active-epoch:${purpose}`) },
          activationPackage: { epoch: { parentEpochHash: H(`activation-parent:${purpose}`) } },
        },
      };
    });
    const result = {
      receipt,
      resourceCloseout,
      finalGateStatus: { phase: "CLOSED", epochHash: acceptedResourceEvidence.at(-1).gateClosedEpochHash },
      finalResourceProbe: acceptedResourceEvidence.at(-1).resourceProbe,
      windowResults,
    };
    const acceptedCloseRequests = windowResults
      .filter((entry) => entry.window.manifest.purpose !== "M6_4_HOT_CLOSE")
      .map((entry, index) => {
        const requestRaw = {
          purpose: entry.window.manifest.purpose,
          currentGateEpochHash: entry.window.authorization.gateEpochHash,
          activationParentEpochHash: entry.window.activationPackage.epoch.parentEpochHash,
          aggregate: entry.aggregate,
          aggregateHash: entry.aggregate.aggregateHash,
          attemptEvidence: entry.attemptEvidence,
          attemptEvidenceHashes: entry.attemptEvidence.map((attempt) => attempt.attemptHash),
          requestNonce: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
          requestedAt: new Date(NOW - 500).toISOString(),
          deadline: new Date(NOW + 5_000).toISOString(),
        };
        const requestHash = deriveM64NormalCloseSigningRequestHash(requestRaw);
        const request = { ...requestRaw, requestHash };
        const requestBytes = Buffer.from(`${JSON.stringify(request, null, 2)}\n`, "utf8");
        return {
          request,
          requestHash,
          requestSha256: H(requestBytes),
          requestRawBase64: requestBytes.toString("base64"),
        };
      });
    const observerPolicy = {
      artifactSha256: H("observer-policy-artifact"),
      keyId: "observer-key-1",
      observerHash: H("observer-identity"),
      policyHash: H("observer-policy"),
      policy: { observationObserverPublicKey: OBSERVER_PUBLIC_KEY },
    };
    const resourceArtifact = buildM64LiveResourceCloseoutArtifact({
      result, acceptedResourceEvidence, acceptedCloseRequests, observerPolicy,
    });
    assert.equal(resourceArtifact.independentProcessInventories.length, 6);
    assert.equal(resourceArtifact.resourceObservationRequests.length, 6);
    assert.equal(resourceArtifact.normalCloseSigningRequests.length, 4);
    assert.equal(resourceArtifact.totalActionCount, 15);
    const reboundEvidence = acceptedResourceEvidence.map((entry) => ({ ...entry }));
    reboundEvidence[0].processInventoryRawBase64 = Buffer.from(JSON.stringify(
      reboundEvidence[0].processInventory,
    ), "utf8").toString("base64");
    assert.throws(() => buildM64LiveResourceCloseoutArtifact({
      result,
      acceptedResourceEvidence: reboundEvidence,
      acceptedCloseRequests,
      observerPolicy,
    }), { code: "M64_LIVE_ARTIFACT_PUBLICATION_INVALID" });
    assert.throws(() => publishM64ContractArtifacts({
      auditRoot,
      repositoryRoot,
      releaseRoot: repositoryRoot,
      contractAuditRoot: auditRoot,
      result,
      acceptedResourceEvidence,
      acceptedCloseRequests,
      observerPolicy,
      executionIntentHash: EXECUTION_INTENT_HASH,
    }), { code: "M64_LIVE_ARTIFACT_INSIDE_RELEASE" });

    const cutpoints = [
      "JOURNAL_DURABLE",
      "IMMUTABLE_AUDIT_COMPLETION",
      "AUDIT_RESOURCE_CLOSEOUT",
      "REPOSITORY_RESOURCE_CLOSEOUT",
      "REPOSITORY_COMPLETION",
      "AUDIT_COMPLETION_SENTINEL",
    ];
    for (const cutpoint of cutpoints) {
      const cutpointRoot = join(root, `cutpoint-${cutpoint.toLowerCase()}`);
      const cutpointAuditRoot = join(cutpointRoot, "audit");
      const cutpointRepositoryRoot = join(cutpointRoot, "repository");
      mkdirSync(cutpointAuditRoot, { recursive: true });
      mkdirSync(join(cutpointRepositoryRoot, "artifacts", "m6-4"), { recursive: true });
      assert.throws(() => publishM64ContractArtifacts({
        auditRoot: cutpointAuditRoot,
        repositoryRoot: cutpointRepositoryRoot,
        contractAuditRoot: cutpointAuditRoot,
        result,
        acceptedResourceEvidence,
        acceptedCloseRequests,
        observerPolicy,
        executionIntentHash: EXECUTION_INTENT_HASH,
        faultAfterPublicationStep(step) {
          if (step === cutpoint) throw Object.assign(new Error(`fault:${step}`), { code: "TEST_PUBLICATION_CUTPOINT" });
        },
      }), { code: "TEST_PUBLICATION_CUTPOINT" });
      if (cutpoint === "JOURNAL_DURABLE") {
        assert.throws(() => recoverM64ContractPublication({
          auditRoot: cutpointAuditRoot,
          repositoryRoot: cutpointRepositoryRoot,
          contractAuditRoot: cutpointAuditRoot,
          expectedExecutionIntentHash: H("wrong-publication-intent"),
        }), { code: "M64_EXECUTION_INTENT_PUBLICATION_MISMATCH" });
        assert.equal(existsSync(join(cutpointAuditRoot, "m6-4-action-canary-completion.json")), false);
        assert.equal(existsSync(join(cutpointRepositoryRoot, "artifacts", "m6-4", "m6-4-action-canary-completion.json")), false);
      }
      const recovered = recoverM64ContractPublication({
        auditRoot: cutpointAuditRoot,
        repositoryRoot: cutpointRepositoryRoot,
        contractAuditRoot: cutpointAuditRoot,
        expectedExecutionIntentHash: EXECUTION_INTENT_HASH,
      });
      assert.equal(recovered.receiptHash, receipt.receiptHash);
      assert.equal(recovered.totalActionCount, 15);
      assert.equal(recovered.recovered, cutpoint !== "AUDIT_COMPLETION_SENTINEL");
      assert.equal(existsSync(join(cutpointAuditRoot, "m6-4-action-canary-completion.json")), true);
      assert.equal(recoverM64ContractPublication({
        auditRoot: cutpointAuditRoot,
        repositoryRoot: cutpointRepositoryRoot,
        contractAuditRoot: cutpointAuditRoot,
        expectedExecutionIntentHash: EXECUTION_INTENT_HASH,
      }).recovered, false);
    }

    const replayRoot = join(root, "startup-recovery");
    const replayAuditRoot = join(replayRoot, "audit");
    const replayRepositoryRoot = join(replayRoot, "repository");
    const replayWindowRoot = join(replayRoot, "windows");
    const replayCloseRoot = join(replayRoot, "close");
    const replayProcessRoot = join(replayRoot, "process");
    const replayReleaseRoot = join(replayRoot, "release");
    for (const path of [replayAuditRoot, replayWindowRoot, replayCloseRoot, replayProcessRoot, replayReleaseRoot]) mkdirSync(path, { recursive: true });
    mkdirSync(join(replayRepositoryRoot, "artifacts", "m6-4"), { recursive: true });
    const replayIntentRaw = {
      schemaId: "xw.m6-4-live-execution-intent.v1",
      auditRoot: resolve(replayAuditRoot),
      repositoryRoot: resolve(replayRepositoryRoot),
      releaseRoot: resolve(replayReleaseRoot),
      controlPlaneOrigin: "http://127.0.0.1:17920/",
      cohortOrder: [...M64_STAGED_CANARY_ORDER],
      authorizationMode: "LAZY_PARENT_CHAIN",
      windowInventoryRoot: resolve(replayWindowRoot),
      windowInventoryHashes: [],
      effectBoundaryHash: H("replay-effect-boundary"),
      independentOracleArtifactSha256: H("replay-observer-artifact"),
      resourceObserverHash: H("replay-resource-observer"),
      createdAt: new Date(NOW).toISOString(),
      invocationId: "00000000-0000-4000-8000-000000000001",
    };
    const replayIntent = { ...replayIntentRaw, intentHash: deriveM64ExecutionIntentHash(replayIntentRaw) };
    const replayIntentRoot = join(replayAuditRoot, "m6-4-execution-intent");
    mkdirSync(replayIntentRoot);
    writeFileSync(
      join(replayIntentRoot, "m6-4-live-execution-intent.json"),
      `${JSON.stringify(replayIntent, null, 2)}\n`,
      "utf8",
    );
    assert.throws(() => publishM64ContractArtifacts({
      auditRoot: replayAuditRoot,
      repositoryRoot: replayRepositoryRoot,
      contractAuditRoot: replayAuditRoot,
      result,
      acceptedResourceEvidence,
      acceptedCloseRequests,
      observerPolicy,
      executionIntentHash: replayIntent.intentHash,
      faultAfterPublicationStep(step) {
        if (step === "JOURNAL_DURABLE") throw Object.assign(new Error("simulated crash"), { code: "TEST_PUBLICATION_CUTPOINT" });
      },
    }), { code: "TEST_PUBLICATION_CUTPOINT" });
    let replayFetchCount = 0;
    const recoveredRun = await runM64ProductionOperator({
      windowInventoryInboxRoot: replayWindowRoot,
      closeInboxRoot: replayCloseRoot,
      processInventoryInboxRoot: replayProcessRoot,
      auditRoot: replayAuditRoot,
      repositoryRoot: replayRepositoryRoot,
      releaseRoot: replayReleaseRoot,
      contractAuditRoot: replayAuditRoot,
      gateToken: "publication-recovery-gate-token-at-least-32-bytes",
      liveToken: "publication-recovery-live-token-at-least-32-bytes",
      dryPreflight: false,
      fetchImpl: async () => { replayFetchCount += 1; throw new Error("recovery must not fetch"); },
    });
    assert.equal(recoveredRun.mode, "PUBLICATION_RECOVERY");
    assert.equal(recoveredRun.terminalStatus, "M6_4_PUBLICATION_RECOVERED_NO_LIVE_REPLAY");
    assert.equal(recoveredRun.liveReplayPrevented, true);
    assert.equal(recoveredRun.liveCompletionClaim, receipt.receiptHash);
    assert.equal(recoveredRun.actionCount, 15);
    assert.equal(replayFetchCount, 0);

    const collisionRoot = join(root, "recovery-collision");
    const collisionAuditRoot = join(collisionRoot, "audit");
    const collisionRepositoryRoot = join(collisionRoot, "repository");
    mkdirSync(collisionAuditRoot, { recursive: true });
    mkdirSync(join(collisionRepositoryRoot, "artifacts", "m6-4"), { recursive: true });
    assert.throws(() => publishM64ContractArtifacts({
      auditRoot: collisionAuditRoot,
      repositoryRoot: collisionRepositoryRoot,
      contractAuditRoot: collisionAuditRoot,
      result,
      acceptedResourceEvidence,
      acceptedCloseRequests,
      observerPolicy,
      executionIntentHash: EXECUTION_INTENT_HASH,
      faultAfterPublicationStep(step) {
        if (step === "JOURNAL_DURABLE") throw Object.assign(new Error("simulated crash"), { code: "TEST_PUBLICATION_CUTPOINT" });
      },
    }), { code: "TEST_PUBLICATION_CUTPOINT" });
    writeFileSync(join(collisionAuditRoot, "m6-4-live-resource-closeout.json"), "{}\n", "utf8");
    assert.throws(() => recoverM64ContractPublication({
      auditRoot: collisionAuditRoot,
      repositoryRoot: collisionRepositoryRoot,
      contractAuditRoot: collisionAuditRoot,
      expectedExecutionIntentHash: EXECUTION_INTENT_HASH,
    }), { code: "M64_AUDIT_HASH_COLLISION" });

    const ambiguousRoot = join(root, "ambiguous-journals");
    const ambiguousAuditRoot = join(ambiguousRoot, "audit");
    const ambiguousRepositoryRoot = join(ambiguousRoot, "repository");
    mkdirSync(ambiguousAuditRoot, { recursive: true });
    mkdirSync(join(ambiguousRepositoryRoot, "artifacts", "m6-4"), { recursive: true });
    assert.throws(() => publishM64ContractArtifacts({
      auditRoot: ambiguousAuditRoot,
      repositoryRoot: ambiguousRepositoryRoot,
      contractAuditRoot: ambiguousAuditRoot,
      result,
      acceptedResourceEvidence,
      acceptedCloseRequests,
      observerPolicy,
      executionIntentHash: EXECUTION_INTENT_HASH,
      faultAfterPublicationStep(step) {
        if (step === "JOURNAL_DURABLE") throw Object.assign(new Error("simulated crash"), { code: "TEST_PUBLICATION_CUTPOINT" });
      },
    }), { code: "TEST_PUBLICATION_CUTPOINT" });
    const ambiguousJournalRoot = join(ambiguousAuditRoot, "m6-4-publication-journal");
    const [firstJournal] = readdirSync(ambiguousJournalRoot);
    writeFileSync(
      join(ambiguousJournalRoot, `${H("second-pending-journal")}.json`),
      readFileSync(join(ambiguousJournalRoot, firstJournal)),
    );
    assert.throws(() => recoverM64ContractPublication({
      auditRoot: ambiguousAuditRoot,
      repositoryRoot: ambiguousRepositoryRoot,
      contractAuditRoot: ambiguousAuditRoot,
      expectedExecutionIntentHash: EXECUTION_INTENT_HASH,
    }), { code: "M64_PUBLICATION_JOURNAL_AMBIGUOUS" });

    const published = publishM64ContractArtifacts({
      auditRoot, repositoryRoot, contractAuditRoot: auditRoot, result, acceptedResourceEvidence, acceptedCloseRequests, observerPolicy,
      executionIntentHash: EXECUTION_INTENT_HASH,
    });
    assert.equal(published.resourceArtifactHash, resourceArtifact.artifactHash);
    for (const path of [
      join(repositoryRoot, "artifacts", "m6-4", "m6-4-action-canary-completion.json"),
      join(repositoryRoot, "artifacts", "m6-4", "m6-4-live-resource-closeout.json"),
      join(auditRoot, "m6-4-action-canary-completion.json"),
      join(auditRoot, "m6-4-live-resource-closeout.json"),
    ]) assert.equal(existsSync(path), true, path);
    assert.deepEqual(
      publishM64ContractArtifacts({
        auditRoot, repositoryRoot, contractAuditRoot: auditRoot, result, acceptedResourceEvidence, acceptedCloseRequests, observerPolicy,
        executionIntentHash: EXECUTION_INTENT_HASH,
      }),
      published,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("completion receipt publication rejects every non-directory audit path component", () => {
  const root = mkdtempSync(join(tmpdir(), "m64-audit-nondir-"));
  try {
    const nonDirectory = join(root, "not-a-directory");
    writeFileSync(nonDirectory, "plain file", "utf8");
    assert.throws(() => atomicWriteCompletionReceipt(join(nonDirectory, "audit"), {
      receiptHash: H("non-directory-audit-root"),
    }), { code: "M64_AUDIT_ROOT_INVALID" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("completion receipt publication rejects a junction at the fixed audit child", (t) => {
  const root = mkdtempSync(join(tmpdir(), "m64-audit-junction-root-"));
  const outside = mkdtempSync(join(tmpdir(), "m64-audit-junction-outside-"));
  try {
    const child = join(root, "m6-4-action-canary-completion");
    if (!createLinkOrSkipExactWindowsEperm(t, outside, child, "junction")) return;
    assert.throws(() => atomicWriteCompletionReceipt(root, {
      receiptHash: H("junction-escape"),
    }), { code: "M64_AUDIT_ROOT_INVALID" });
    assert.deepEqual(readdirSync(outside), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("completion receipt publication rejects a symlink at the immutable target", (t) => {
  const root = mkdtempSync(join(tmpdir(), "m64-audit-symlink-root-"));
  const outside = mkdtempSync(join(tmpdir(), "m64-audit-symlink-outside-"));
  try {
    const receipt = { receiptHash: H("symlink-target") };
    const child = join(root, "m6-4-action-canary-completion");
    const outsideFile = join(outside, "outside.json");
    const target = join(child, `${receipt.receiptHash}.json`);
    mkdirSync(child);
    writeFileSync(outsideFile, "outside sentinel", "utf8");
    if (!createLinkOrSkipExactWindowsEperm(t, outsideFile, target, "file")) return;
    assert.throws(() => atomicWriteCompletionReceipt(root, receipt), { code: "M64_AUDIT_ROOT_INVALID" });
    assert.equal(readFileSync(outsideFile, "utf8"), "outside sentinel");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("lazy production dry preflight waits for the first SHADOW window without mutation or future-window claims", async () => {
  const root = mkdtempSync(join(tmpdir(), "m64-lazy-dry-"));
  try {
    const boundary = JSON.parse(readFileSync(resolve(
      "artifacts/m6-4/cohort-manifests/xw.m6-effect-boundary.v1.json",
    ), "utf8"));
    const effectBoundaryDescriptor = descriptor(root, "effect-boundary", boundary);
    const independentOraclePolicy = independentOraclePolicyDescriptor(root, boundary);
    const windowInventoryInboxRoot = join(root, "window-inbox");
    const closeInboxRoot = join(root, "close-inbox");
    const processInventoryInboxRoot = join(root, "process-inbox");
    const auditRoot = join(root, "audit");
    const repositoryRoot = join(root, "repository");
    const releaseRoot = join(root, "release");
    for (const path of [windowInventoryInboxRoot, closeInboxRoot, processInventoryInboxRoot, auditRoot, releaseRoot]) mkdirSync(path);
    mkdirSync(join(repositoryRoot, "artifacts", "m6-4"), { recursive: true });
    let fetchCount = 0;
    const result = await runM64ProductionOperator({
      effectBoundaryDescriptor,
      independentOraclePolicyDescriptor: independentOraclePolicy,
      windowInventoryInboxRoot,
      closeInboxRoot,
      processInventoryInboxRoot,
      auditRoot,
      repositoryRoot,
      releaseRoot,
      contractAuditRoot: auditRoot,
      gateToken: "lazy-dry-gate-token-that-is-at-least-32-bytes",
      liveToken: "lazy-dry-live-token-that-is-at-least-32-bytes",
      dryPreflight: true,
      now: () => NOW,
      fetchImpl: async () => { fetchCount += 1; throw new Error("dry preflight must not fetch"); },
    });
    assert.equal(result.terminalStatus, "PREFLIGHT_LAZY_WAIT_FIRST_WINDOW");
    assert.equal(result.readinessScope, "LAZY_FIRST_WINDOW_ONLY");
    assert.equal(result.fullFiveWindowReady, false);
    assert.equal(result.validatedWindowCount, 0);
    assert.equal(result.pendingWindowCount, 5);
    assert.deepEqual(result.windowInventoryHashes, []);
    assert.equal(result.liveCompletionClaim, null);
    assert.equal(result.actionCount, 0);
    assert.equal(fetchCount, 0);
    assert.deepEqual(readdirSync(windowInventoryInboxRoot), []);
    assert.deepEqual(readdirSync(closeInboxRoot), []);
    assert.deepEqual(readdirSync(processInventoryInboxRoot), []);
    assert.deepEqual(readdirSync(auditRoot), []);
    assert.equal(existsSync(join(auditRoot, "m6-4-action-canary-completion")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pending ACTIVE execution recovers Gate and exact live epoch, observes external zero, then never fetches again", async () => {
  const root = mkdtempSync(join(tmpdir(), "m64-active-execution-recovery-"));
  try {
    const common = productionRecoveryFixture(root);
    await persistProductionExecutionIntent(common);
    const priorEpochHash = H("recovery-active-epoch");
    const terminalEpochHash = H("recovery-terminal-epoch");
    const purpose = "M6_4_ACTION_SMOKE";
    const closeReceiptHashes = [H("recovery-close-receipt")];
    const gateRecovery = recoveryGatePayload({
      priorEpochHash, terminalEpochHash, purpose, recovered: true,
    });
    const liveRecovery = liveEpochRecoveryPayload({ gateEpochHash: priorEpochHash, purpose, closeReceiptHashes });
    const observer = recoveryObserverResponder(common);
    const operations = [];
    const fetchImpl = async (url, options) => {
      const endpoint = new URL(url);
      operations.push(endpoint.pathname);
      if (endpoint.pathname.endsWith("/gate-f/recover-armed-active")) {
        assert.deepEqual(JSON.parse(options.body), {});
        return mockJsonResponse(gateRecovery);
      }
      if (endpoint.pathname.endsWith("/live/recover-epoch")) {
        assert.deepEqual(JSON.parse(options.body), { gateEpochHash: priorEpochHash, purpose });
        return mockJsonResponse({ recovery: liveRecovery });
      }
      if (endpoint.pathname.endsWith("/gate-f/status")) {
        return mockJsonResponse({ gate: gateStatus({ purpose, epochHash: terminalEpochHash }) });
      }
      throw new Error(`live cohort replay is forbidden during recovery: ${endpoint.pathname}`);
    };
    const recovered = await runM64ProductionOperator({
      ...common,
      fetchImpl,
      waitForPoll: () => observer.respond(),
      waitMs: 100,
      pollMs: 1,
    });
    assert.equal(recovered.mode, "RECOVERY_REQUIRED_NO_LIVE_REPLAY");
    assert.equal(recovered.terminalStatus, "M6_4_RECOVERY_REQUIRED_NO_LIVE_REPLAY");
    assert.equal(recovered.liveReplayPrevented, true);
    assert.equal(recovered.liveCompletionClaim, null);
    assert.equal(recovered.actionCount, null);
    assert.match(recovered.executionIntentHash, /^[0-9a-f]{64}$/u);
    assert.match(recovered.recoveryArtifactHash, /^[0-9a-f]{64}$/u);
    assert.equal(observer.responseCount, 1);
    assert.deepEqual(operations, [
      "/control/v1/internal/m6/gate-f/recover-armed-active",
      "/control/v1/internal/m6/live/recover-epoch",
      "/control/v1/internal/m6/gate-f/status",
    ]);
    const recoveryFiles = readdirSync(join(common.auditRoot, "m6-4-execution-recovery"));
    assert.deepEqual(recoveryFiles, [`${recovered.recoveryArtifactHash}.json`]);
    const artifact = JSON.parse(readFileSync(join(
      common.auditRoot, "m6-4-execution-recovery", recoveryFiles[0],
    ), "utf8"));
    assert.equal(artifact.executionIntentHash, recovered.executionIntentHash);
    assert.deepEqual(artifact.closeReceiptHashes, closeReceiptHashes);
    assert.equal(artifact.externalResourceState, "ZERO_ASSERTED_BY_SIGNED_OBSERVER");
    assert.equal(artifact.actionCount, null);

    let laterFetchCount = 0;
    const idempotent = await runM64ProductionOperator({
      ...common,
      fetchImpl: async () => { laterFetchCount += 1; throw new Error("durable recovery must not fetch"); },
      waitForPoll: async () => { throw new Error("durable recovery must not request another observation"); },
    });
    assert.equal(idempotent.recoveryArtifactHash, recovered.recoveryArtifactHash);
    assert.equal(idempotent.mode, "RECOVERY_REQUIRED_NO_LIVE_REPLAY");
    assert.equal(laterFetchCount, 0);
    assert.equal(observer.responseCount, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pending execution on an already-CLOSED Gate with no predecessor skips live recovery only after fresh Gate zero", async () => {
  const root = mkdtempSync(join(tmpdir(), "m64-closed-execution-recovery-"));
  try {
    const common = productionRecoveryFixture(root);
    await persistProductionExecutionIntent(common);
    const terminalEpochHash = H("already-closed-terminal-epoch");
    const gateRecovery = recoveryGatePayload({
      priorEpochHash: terminalEpochHash,
      terminalEpochHash,
      purpose: null,
      recovered: false,
    });
    const observer = recoveryObserverResponder(common);
    const operations = [];
    const recovered = await runM64ProductionOperator({
      ...common,
      fetchImpl: async (url) => {
        const endpoint = new URL(url);
        operations.push(endpoint.pathname);
        if (endpoint.pathname.endsWith("/gate-f/recover-armed-active")) return mockJsonResponse(gateRecovery);
        if (endpoint.pathname.endsWith("/gate-f/status")) {
          return mockJsonResponse({ gate: gateStatus({ purpose: null, epochHash: terminalEpochHash }) });
        }
        throw new Error(`no-predecessor recovery must not invoke live/cohort routes: ${endpoint.pathname}`);
      },
      waitForPoll: () => observer.respond(),
      waitMs: 100,
      pollMs: 1,
    });
    assert.equal(recovered.mode, "RECOVERY_REQUIRED_NO_LIVE_REPLAY");
    assert.equal(recovered.actionCount, null);
    assert.deepEqual(operations, [
      "/control/v1/internal/m6/gate-f/recover-armed-active",
      "/control/v1/internal/m6/gate-f/status",
    ]);
    const artifact = JSON.parse(readFileSync(join(
      common.auditRoot, "m6-4-execution-recovery", `${recovered.recoveryArtifactHash}.json`,
    ), "utf8"));
    assert.equal(artifact.purpose, "M6_4_FINAL");
    assert.equal(artifact.liveRecovery, null);
    assert.deepEqual(artifact.closeReceiptHashes, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pending execution waits for a request-bound signed observer and never replays a cohort when it is missing", async () => {
  const root = mkdtempSync(join(tmpdir(), "m64-missing-recovery-observer-"));
  try {
    const common = productionRecoveryFixture(root);
    await persistProductionExecutionIntent(common);
    const priorEpochHash = H("missing-observer-active-epoch");
    const terminalEpochHash = H("missing-observer-terminal-epoch");
    const purpose = "M6_4_SHADOW";
    const gateRecovery = recoveryGatePayload({
      priorEpochHash, terminalEpochHash, purpose, recovered: true,
    });
    const liveRecovery = liveEpochRecoveryPayload({ gateEpochHash: priorEpochHash, purpose });
    const operations = [];
    let clock = NOW;
    await assert.rejects(() => runM64ProductionOperator({
      ...common,
      now: () => clock,
      fetchImpl: async (url) => {
        const endpoint = new URL(url);
        operations.push(endpoint.pathname);
        if (endpoint.pathname.endsWith("/gate-f/recover-armed-active")) return mockJsonResponse(gateRecovery);
        if (endpoint.pathname.endsWith("/live/recover-epoch")) return mockJsonResponse({ recovery: liveRecovery });
        if (endpoint.pathname.endsWith("/gate-f/status")) {
          return mockJsonResponse({ gate: gateStatus({ purpose, epochHash: terminalEpochHash }) });
        }
        throw new Error(`cohort replay is forbidden while observer is missing: ${endpoint.pathname}`);
      },
      waitForPoll: async (delayMs) => { clock += delayMs; },
      waitMs: 5,
      pollMs: 1,
    }), { code: "WAIT_EXTERNAL_RESOURCE_OBSERVER" });
    assert.deepEqual(operations, [
      "/control/v1/internal/m6/gate-f/recover-armed-active",
      "/control/v1/internal/m6/live/recover-epoch",
      "/control/v1/internal/m6/gate-f/status",
    ]);
    assert.equal(existsSync(join(common.auditRoot, "m6-4-execution-recovery")), false);
    assert.equal(existsSync(join(common.auditRoot, "m6-4-action-canary-completion.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a temp-only publication journal without an intent is a no-live-replay recovery sentinel", async () => {
  const root = mkdtempSync(join(tmpdir(), "m64-temp-only-publication-"));
  try {
    const common = productionRecoveryFixture(root);
    const journalRoot = join(common.auditRoot, "m6-4-publication-journal");
    mkdirSync(journalRoot);
    writeFileSync(join(
      journalRoot,
      `.${H("interrupted-journal")}.json.00000000-0000-4000-8000-000000000002.tmp`,
    ), "{\n", "utf8");
    let fetchCount = 0;
    const result = await runM64ProductionOperator({
      ...common,
      fetchImpl: async () => { fetchCount += 1; throw new Error("temp-only journal must block live"); },
    });
    assert.equal(result.mode, "EXECUTION_RECOVERY_REQUIRED");
    assert.equal(result.terminalStatus, "M6_4_RECOVERY_REQUIRED_NO_LIVE_REPLAY");
    assert.equal(result.executionIntentHash, null);
    assert.equal(result.actionCount, null);
    assert.equal(result.liveReplayPrevented, true);
    assert.equal(fetchCount, 0);
    assert.deepEqual(readdirSync(journalRoot), [
      `.${H("interrupted-journal")}.json.00000000-0000-4000-8000-000000000002.tmp`,
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("all operator modes reject invalid publication roots before fetch or early preflight return", async () => {
  const root = mkdtempSync(join(tmpdir(), "m64-pre-mutation-roots-"));
  try {
    const releaseRoot = join(root, "release");
    const repositoryRoot = join(root, "repository");
    const auditRoot = join(root, "audit");
    const otherAuditRoot = join(root, "other-audit");
    const windowInventoryInboxRoot = join(root, "windows");
    const closeInboxRoot = join(root, "close");
    const processInventoryInboxRoot = join(root, "process");
    for (const path of [releaseRoot, auditRoot, otherAuditRoot, windowInventoryInboxRoot, closeInboxRoot, processInventoryInboxRoot]) {
      mkdirSync(path);
    }
    mkdirSync(join(repositoryRoot, "artifacts", "m6-4"), { recursive: true });
    const shared = {
      windowInventoryInboxRoot,
      closeInboxRoot,
      processInventoryInboxRoot,
      auditRoot,
      repositoryRoot,
      releaseRoot,
      contractAuditRoot: auditRoot,
      gateToken: "pre-mutation-gate-token-that-is-at-least-32-bytes",
      liveToken: "pre-mutation-live-token-that-is-at-least-32-bytes",
      dryPreflight: true,
    };
    let fetchCount = 0;
    const fetchImpl = async () => { fetchCount += 1; throw new Error("invalid preflight must not fetch"); };

    await assert.rejects(runM64ProductionOperator({
      ...shared,
      repositoryRoot: null,
      fetchImpl,
    }), { code: "M64_OPERATOR_PRODUCTION_INPUT_MISSING" });

    mkdirSync(join(releaseRoot, "artifacts", "m6-4"), { recursive: true });
    await assert.rejects(runM64ProductionOperator({
      ...shared,
      repositoryRoot: releaseRoot,
      fetchImpl,
    }), { code: "M64_LIVE_ARTIFACT_INSIDE_RELEASE" });

    await assert.rejects(runM64ProductionOperator({
      ...shared,
      windowInventoryDescriptors: Array.from({ length: 5 }, (_, index) => ({
        path: join(root, `not-read-${index}.json`), sha256: H(`not-read-${index}`),
      })),
      windowInventoryInboxRoot: null,
      contractAuditRoot: otherAuditRoot,
      fetchImpl,
    }), { code: "M64_OPERATOR_AUDIT_ROOT_MISMATCH" });
    assert.equal(fetchCount, 0);

    assert.throws(() => validateM64ProductionPreMutation({
      ...shared,
      controlPlaneUrl: "http://127.0.0.1:17921/",
    }), { code: "M64_CONTROL_PLANE_NOT_LOOPBACK" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a validated first-window lazy dry state still cannot masquerade as five-window readiness", () => {
  const firstWindowHash = H("validated-shadow-inventory");
  const result = buildM64LazyDryPreflightResult({
    firstWindow: { inventoryHash: firstWindowHash },
    effectBoundary: { boundaryHash: H("effect-boundary") },
    observerPolicy: { artifactSha256: H("observer-artifact"), observerHash: H("observer") },
  });
  assert.equal(result.terminalStatus, "PREFLIGHT_LAZY_FIRST_WINDOW_VALIDATED_WAIT_FUTURE_WINDOWS");
  assert.equal(result.readinessScope, "LAZY_FIRST_WINDOW_ONLY");
  assert.equal(result.fullFiveWindowReady, false);
  assert.equal(result.validatedWindowCount, 1);
  assert.equal(result.pendingWindowCount, 4);
  assert.equal(result.firstWindowPurpose, "M6_4_SHADOW");
  assert.deepEqual(result.windowInventoryHashes, [firstWindowHash]);
  assert.equal(result.liveCompletionClaim, null);
  assert.equal(Object.hasOwn(result, "completionReceiptHash"), false);
});
