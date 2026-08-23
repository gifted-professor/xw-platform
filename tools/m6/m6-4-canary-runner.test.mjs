import assert from "node:assert/strict";
import test from "node:test";

import { validateM64LiveWindowAuthorization } from "./m6-4-canary-runner.mjs";

const H = "a".repeat(64);
test("canary authorization requires exact manifest binding and a qualified model", () => {
  const manifest = { manifestHash: H };
  const auth = { schemaId: "xw.m6-4-live-window-authorization.v1", alias: "01", releaseHash: H, sourceCommit: H, gateEpochHash: H, scenarioManifestHash: H, modelProfileHash: H, providerHash: H, toolProfileHash: H, operatorHash: H, emergencyCloseAuthorizationHash: H, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() };
  assert.ok(validateM64LiveWindowAuthorization(auth, { manifest, modelManifest: { status: "UNQUALIFIED", gateFEligible: false, contentHash: null } }).errors.includes("M64_LIVE_MODEL_UNQUALIFIED"));
  assert.equal(validateM64LiveWindowAuthorization(auth, { manifest, modelManifest: { status: "QUALIFIED", gateFEligible: true, contentHash: H } }).ok, true);
  assert.ok(validateM64LiveWindowAuthorization({ ...auth, scenarioManifestHash: "b".repeat(64) }, { manifest, modelManifest: { status: "QUALIFIED", gateFEligible: true, contentHash: H } }).errors.includes("M64_LIVE_AUTH_MANIFEST_MISMATCH"));
});
