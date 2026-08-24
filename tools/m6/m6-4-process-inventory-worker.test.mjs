import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import { deriveM64IndependentActorHash } from "../../services/control-plane/control-plane/lib/m6-live-production-dependencies.mjs";
import { deriveM64ResourceObservationRequestHash, validateM64IndependentProcessInventory } from "./m6-4-production-operator-bridge.mjs";
import { buildM64SignedProcessInventory, inspectM64ProcessSnapshot } from "./m6-4-process-inventory-worker.mjs";

function fixture() {
  const keys = generateKeyPairSync("ed25519");
  const observerHash = deriveM64IndependentActorHash(keys.publicKey);
  const notBefore = "2030-01-01T00:00:00.000Z";
  const rawRequest = { purpose: "M6_4_SHADOW", gateClosedEpochHash: "1".repeat(64), closeReceiptHashes: [], notBefore };
  const request = { ...rawRequest, requestHash: deriveM64ResourceObservationRequestHash(rawRequest) };
  return { keys, observerHash, notBefore, request };
}

test("zero snapshot produces an exact independently verifiable signed inventory", () => {
  const { keys, observerHash, notBefore, request } = fixture();
  const inventory = buildM64SignedProcessInventory({
    request, observerKeyId: "observation-observer-01", observerHash, privateKey: keys.privateKey,
    processRows: [{ pid: 7, createdAt: "x", executable: "node.exe", commandLine: "node harmless.mjs" }],
    activeScenarioClaimRefs: [], capturedAt: "2030-01-01T00:00:01.000Z",
  });
  const validation = validateM64IndependentProcessInventory(inventory, {
    purpose: request.purpose, gateClosedEpochHash: request.gateClosedEpochHash, closeReceiptHashes: [],
    observerPolicy: { keyId: "observation-observer-01", observerHash, publicKey: keys.publicKey },
    notBeforeMs: Date.parse(notBefore), nowMs: Date.parse("2030-01-01T00:00:02.000Z"), maxAgeMs: 30_000,
  });
  assert.deepEqual(validation, { ok: true, errors: [] });
  assert.equal(inventory.activeProcessRefs.length, 0);
  assert.equal(inventory.signature.length, 88);
});

test("live DSH child, raw identity, and credential-like args become hashes only", () => {
  const commandLine = "node C:\\sealed\\integrations\\dsh-xw\\cli.mjs --profile live --serial=device-raw api_key=do-not-emit";
  const findings = inspectM64ProcessSnapshot([{ pid: 44, createdAt: "x", executable: "node.exe", commandLine }]);
  for (const key of ["activeProcessRefs", "activeBrokerRefs", "activePipeRefs", "orphanProcessRefs", "rawDeviceIdentityFindings", "secretMaterialFindings"]) {
    assert.equal(findings[key].length, 1);
    assert.match(findings[key][0], /^[0-9a-f]{64}$/u);
  }
  assert.equal(JSON.stringify(findings).includes("device-raw"), false);
  assert.equal(JSON.stringify(findings).includes("do-not-emit"), false);
});

test("signature cannot be rebound after a finding changes", () => {
  const { keys, observerHash, notBefore, request } = fixture();
  const inventory = buildM64SignedProcessInventory({
    request, observerKeyId: "observation-observer-01", observerHash, privateKey: keys.privateKey,
    processRows: [], activeScenarioClaimRefs: [], capturedAt: "2030-01-01T00:00:01.000Z",
  });
  const tampered = { ...inventory, activeScenarioClaimRefs: ["2".repeat(64)] };
  const validation = validateM64IndependentProcessInventory(tampered, {
    purpose: request.purpose, gateClosedEpochHash: request.gateClosedEpochHash, closeReceiptHashes: [],
    observerPolicy: { keyId: "observation-observer-01", observerHash, publicKey: keys.publicKey },
    notBeforeMs: Date.parse(notBefore), nowMs: Date.parse("2030-01-01T00:00:02.000Z"), maxAgeMs: 30_000,
  });
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.includes("M64_PROCESS_INVENTORY_HASH_INVALID"));
  assert.ok(validation.errors.includes("M64_PROCESS_INVENTORY_SIGNATURE_INVALID"));
});
