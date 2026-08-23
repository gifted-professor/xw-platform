import assert from "node:assert/strict";
import test from "node:test";

import {
  M6_TARGET_ENVIRONMENT_READS,
  M6_TARGET_ENVIRONMENT_QUALIFICATION_TTL_MS,
  collectM64TargetEnvironmentQualification,
  deriveM64TargetEnvironmentCommandRegistryHash,
} from "../apps/xiaowei/m6-target-environment-qualification.mjs";

const H = "a".repeat(64);

function fixtureTransport({ mutateSecond = null } = {}) {
  const names = Object.keys(M6_TARGET_ENVIRONMENT_READS);
  const commands = new Map(Object.entries(M6_TARGET_ENVIRONMENT_READS).map(([name, command]) => [command, name]));
  const calls = [];
  let index = 0;
  return {
    calls,
    async runExclusive(callback) {
      return callback({
        async invoke(request) {
          calls.push(structuredClone(request));
          assert.equal(request.action, "adb_shell");
          assert.equal(request.devices, "private-runtime-01");
          assert.deepEqual(Object.keys(request.data), ["command"]);
          const name = commands.get(request.data.command);
          assert.ok(name, "only a frozen command may reach the transport");
          const sample = Math.floor(index / names.length);
          index += 1;
          const value = mutateSecond && sample === 1 && name === mutateSecond
            ? `${name}-changed`
            : `${name}-stable`;
          return { data: { "private-runtime-01": value } };
        },
      });
    },
  };
}

test("target environment qualification is double-sampled, hashed, and read-only", async () => {
  const transport = fixtureTransport();
  const result = await collectM64TargetEnvironmentQualification({
    transport,
    serial: "private-runtime-01",
    gateMode: "CLOSED",
    accountIsolationBindingHash: H,
    now: () => Date.parse("2026-08-23T16:00:00.000Z"),
  });

  assert.equal(transport.calls.length, Object.keys(M6_TARGET_ENVIRONMENT_READS).length * 2);
  assert.equal(result.attestation.schemaId, "xw.m6-target-environment-attestation.v1");
  assert.match(result.attestation.attestationHash, /^[0-9a-f]{64}$/u);
  assert.deepEqual(result.qualification.qualifiedAttestationHashes, [result.attestation.attestationHash]);
  assert.equal(result.qualification.commandRegistryHash, deriveM64TargetEnvironmentCommandRegistryHash());
  assert.equal(result.qualification.actionCount, 0);
  assert.equal(result.qualification.secretMaterialPresent, false);
  assert.equal(
    Date.parse(result.attestation.expiresAt) - Date.parse(result.attestation.capturedAt),
    M6_TARGET_ENVIRONMENT_QUALIFICATION_TTL_MS,
  );
  assert.doesNotMatch(JSON.stringify(result), /private-runtime|com\.xingin|SigningDetails|userId=/u);
  for (const call of transport.calls) {
    assert.doesNotMatch(call.data.command, /\b(?:input|tap|swipe|am start|monkey|force-stop|pm clear)\b/iu);
  }
});

test("qualification rejects an open gate, wrong alias, missing isolation binding, and drift before actions", async () => {
  await assert.rejects(() => collectM64TargetEnvironmentQualification({
    transport: fixtureTransport(), serial: "private-runtime-01", gateMode: "GROUNDED_ACTION", accountIsolationBindingHash: H,
  }), { code: "M6_ENV_QUALIFICATION_GATE_OPEN" });
  await assert.rejects(() => collectM64TargetEnvironmentQualification({
    transport: fixtureTransport(), serial: "private-runtime-01", alias: "02", gateMode: "CLOSED", accountIsolationBindingHash: H,
  }), { code: "M6_ENV_QUALIFICATION_ALIAS_INVALID" });
  await assert.rejects(() => collectM64TargetEnvironmentQualification({
    transport: fixtureTransport(), serial: "private-runtime-01", gateMode: "CLOSED",
  }), { code: "M6_ENV_ACCOUNT_ISOLATION_BINDING_REQUIRED" });
  await assert.rejects(() => collectM64TargetEnvironmentQualification({
    transport: fixtureTransport({ mutateSecond: "display" }), serial: "private-runtime-01", gateMode: "CLOSED", accountIsolationBindingHash: H,
  }), { code: "M6_ENV_QUALIFICATION_DRIFT" });
  await assert.rejects(() => collectM64TargetEnvironmentQualification({
    transport: fixtureTransport(), serial: "private-runtime-01", gateMode: "CLOSED", accountIsolationBindingHash: H,
    ttlMs: 59 * 60 * 1000,
  }), { code: "M6_ENV_QUALIFICATION_TTL_INVALID" });
  await assert.rejects(() => collectM64TargetEnvironmentQualification({
    transport: fixtureTransport(), serial: "private-runtime-01", gateMode: "CLOSED", accountIsolationBindingHash: H,
    ttlMs: 8 * 60 * 60 * 1000 + 1,
  }), { code: "M6_ENV_QUALIFICATION_TTL_INVALID" });
});
