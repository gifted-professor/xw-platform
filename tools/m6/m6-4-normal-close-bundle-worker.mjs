#!/usr/bin/env node

// Independent normal-close authority for M6-4. This process receives a
// content-addressed post-aggregate request, reuses the already owner-signed
// live authorization, and signs only the exact CLOSED epoch. It never calls
// the Control Plane, Gate-F, a provider, or a device.

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";
import {
  lstatSync,
  readFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  deriveM64CohortAggregateHash,
  validateM64CohortAggregate,
} from "../../packages/kernel/lib/m6-4-cohort.mjs";
import { deriveM6AggregateSealHash } from "../../packages/kernel/lib/m6-aggregate-closeout.mjs";
import { deriveM6CloseoutHash } from "../../services/control-plane/control-plane/lib/m6-live-gate.mjs";
import { deriveM6V2EpochHash } from "../../services/control-plane/control-plane/lib/m6-live-gate-v2.mjs";
import {
  deriveM64NormalCloseSigningRequestHash,
  loadM64ExternalNormalCloseBundle,
  parseM64SealedDescriptorSpec,
  validateM64ExternalNormalCloseBundle,
} from "./m6-4-production-operator-bridge.mjs";
import {
  loadM64CanaryWindowInventory,
  loadM64SealedJsonArtifact,
} from "./m6-4-canary-orchestrator.mjs";
import { validateM64LiveWindowAuthorization } from "./m6-4-canary-runner.mjs";
import { publishRecoverableCreateOnly } from "./lib/recoverable-create-only-publication.mjs";

const HASH = /^[0-9a-f]{64}$/u;
const ID = /^[A-Za-z0-9._-]{1,128}$/u;
const SUBJECT = /^[A-Za-z0-9._:-]{1,128}$/u;
const SIGNATURE = /^[A-Za-z0-9+/]{86}==$/u;
const REQUEST_KEYS = Object.freeze([
  "activationParentEpochHash", "aggregate", "aggregateHash", "attemptEvidence", "attemptEvidenceHashes",
  "currentGateEpochHash", "deadline", "purpose", "requestHash", "requestNonce", "requestedAt",
]);
const LOCATOR_KEYS = Object.freeze([
  "artifactFileName", "kind", "locatorHash", "purpose", "requestHash", "requestSha256",
  "responseDescriptorFileName", "schemaId",
]);

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha(domain, value) {
  return createHash("sha256").update(`${domain}:${canonical(value)}`).digest("hex");
}

function rawSha(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactObject(value, keys) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && canonical(Object.keys(value).sort()) === canonical([...keys].sort()));
}

function fail(code, message, details = {}) {
  throw Object.assign(new Error(message), { code, details });
}

function exactJsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function totalActionCount(aggregate) {
  const values = aggregate?.attempts?.map((attempt) => attempt?.actionCount) ?? [];
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    fail("M64_NORMAL_CLOSE_ACTION_COUNT_INVALID", "aggregate action counts are invalid");
  }
  return values.reduce((sum, value) => sum + value, 0);
}

export function validateM64NormalCloseSigningRequest(request, { window, nowMs = Date.now() } = {}) {
  const errors = [];
  const { requestHash, ...requestRaw } = request || {};
  const requestedAtMs = Date.parse(request?.requestedAt);
  const deadlineMs = Date.parse(request?.deadline);
  const aggregateValidation = validateM64CohortAggregate(request?.aggregate);
  if (!exactObject(request, REQUEST_KEYS) || !HASH.test(requestHash || "")
    || requestHash !== deriveM64NormalCloseSigningRequestHash(requestRaw)) errors.push("M64_NORMAL_CLOSE_REQUEST_HASH_INVALID");
  if (!Number.isFinite(requestedAtMs) || !Number.isFinite(deadlineMs)
    || nowMs < requestedAtMs || nowMs > deadlineMs || deadlineMs <= requestedAtMs) errors.push("M64_NORMAL_CLOSE_REQUEST_STALE");
  if (!aggregateValidation.ok || request?.aggregateHash !== request?.aggregate?.aggregateHash
    || request?.aggregateHash !== deriveM64CohortAggregateHash(request?.aggregate)) errors.push("M64_NORMAL_CLOSE_AGGREGATE_INVALID");
  if (!Array.isArray(request?.attemptEvidence) || request.attemptEvidence.length === 0
    || !Array.isArray(request?.attemptEvidenceHashes)
    || canonical(request.attemptEvidence.map((entry) => entry?.attemptHash)) !== canonical(request.attemptEvidenceHashes)
    || request.attemptEvidenceHashes.some((hash) => !HASH.test(hash || ""))) errors.push("M64_NORMAL_CLOSE_EVIDENCE_INVALID");
  const authorization = window?.authorization;
  if (request?.purpose !== window?.manifest?.purpose || request?.purpose !== request?.aggregate?.purpose
    || request?.currentGateEpochHash !== authorization?.gateEpochHash
    || request?.activationParentEpochHash !== window?.activationPackage?.epoch?.parentEpochHash
    || request?.aggregate?.gateEpochHash !== authorization?.gateEpochHash
    || request?.aggregate?.liveAuthorizationHash !== authorization?.envelopeHash
    || request?.aggregate?.manifestHash !== window?.manifest?.manifestHash) errors.push("M64_NORMAL_CLOSE_WINDOW_BINDING_INVALID");
  if (!SIGNATURE.test(authorization?.signature || "")
    || window?.activationPackage?.authorization?.envelopeHash !== authorization?.envelopeHash
    || window?.activationPackage?.epoch?.epochHash !== authorization?.gateEpochHash) errors.push("M64_NORMAL_CLOSE_OWNER_AUTHORIZATION_INVALID");
  return Object.freeze({ ok: errors.length === 0, errors: [...new Set([...errors, ...aggregateValidation.errors])] });
}

export function deriveM64NormalCloseBundle({
  request,
  window,
  gatePrivateKey,
  gateKeyId,
  gateSubject,
  gateAllowlistVersion = 1,
  nowMs = Date.now(),
  closeLifetimeMs = 4 * 60 * 60 * 1000,
} = {}) {
  const requestValidation = validateM64NormalCloseSigningRequest(request, { window, nowMs });
  if (!requestValidation.ok) fail("M64_NORMAL_CLOSE_REQUEST_INVALID", requestValidation.errors.join(","), { errors: requestValidation.errors });
  if (!ID.test(gateKeyId || "") || !SUBJECT.test(gateSubject || "")
    || !Number.isSafeInteger(gateAllowlistVersion) || gateAllowlistVersion < 1
    || !Number.isSafeInteger(closeLifetimeMs) || closeLifetimeMs < 60_000) {
    fail("M64_NORMAL_CLOSE_SIGNER_IDENTITY_INVALID", "gate signer identity or close lifetime is invalid");
  }
  let privateKey;
  try {
    privateKey = gatePrivateKey?.type === "private" ? gatePrivateKey : createPrivateKey(gatePrivateKey);
  } catch {
    fail("M64_NORMAL_CLOSE_PRIVATE_KEY_INVALID", "gate private key is unavailable or invalid");
  }
  if (privateKey.asymmetricKeyType !== "ed25519") fail("M64_NORMAL_CLOSE_PRIVATE_KEY_INVALID", "gate key must be Ed25519");
  const committedAt = new Date(nowMs).toISOString();
  const activeEpoch = window.activationPackage.epoch;
  const closeoutRaw = {
    closeoutId: `normal-close-${request.requestHash.slice(0, 48)}`,
    epochHash: request.currentGateEpochHash,
    actor: gateSubject,
    reason: "NORMAL_COMPLETE",
    committedAt,
  };
  const closeout = Object.freeze({ ...closeoutRaw, closeoutHash: deriveM6CloseoutHash(closeoutRaw) });
  const sealPayload = {
    epochHash: request.currentGateEpochHash,
    attempts: request.aggregate.attempts,
    allowlist: ["01"],
    cohortAggregate: request.aggregate,
    // This field is inside the signed aggregate seal, so a valid bundle cannot
    // be replayed into another fresh request slot even for the same aggregate.
    normalCloseRequestHash: request.requestHash,
  };
  const sealHash = deriveM6AggregateSealHash(sealPayload);
  const aggregateSeal = Object.freeze({
    schemaId: "xw.m6-aggregate-closeout.v1",
    epochHash: request.currentGateEpochHash,
    sealPayload,
    sealHash,
    attemptCount: request.aggregate.attempts.length,
    aliases: ["01"],
  });
  const epochRaw = {
    schemaId: "xw.m6-live-gate.v2",
    gateId: activeEpoch.gateId,
    mode: "CLOSED",
    purpose: request.purpose,
    status: "closed",
    releaseId: activeEpoch.releaseId,
    sourceCommit: activeEpoch.sourceCommit,
    actor: gateSubject,
    lockSetRef: activeEpoch.lockSetRef,
    allowlist: activeEpoch.allowlist,
    issuedAt: committedAt,
    expiresAt: new Date(nowMs + closeLifetimeMs).toISOString(),
    parentEpochHash: request.currentGateEpochHash,
    closeoutRef: { id: closeout.closeoutId, sha256: closeout.closeoutHash },
    aggregateSealRef: { id: sealHash, sha256: sealHash },
    rollbackTargetEpochHash: null,
    emergencyCloseAuthorizationRef: null,
  };
  const epoch = Object.freeze({ ...epochRaw, epochHash: deriveM6V2EpochHash(epochRaw) });
  const signature = sign(null, Buffer.from(epoch.epochHash, "hex"), privateKey).toString("base64");
  const proof = Object.freeze({
    algorithm: "ed25519",
    allowlistVersion: gateAllowlistVersion,
    keyId: gateKeyId,
    signature,
    subject: gateSubject,
  });
  if (!verify(null, Buffer.from(epoch.epochHash, "hex"), createPublicKey(privateKey), Buffer.from(signature, "base64"))) {
    fail("M64_NORMAL_CLOSE_SIGNATURE_INVALID", "gate signature failed immediate self-verification");
  }
  const bundle = Object.freeze({
    schemaId: "xw.m6-4-gate-close-bundle.v1",
    normalCloseRequestHash: request.requestHash,
    package: Object.freeze({
      authorization: window.authorization,
      epoch,
      operation: "NORMAL_CLOSE",
      phase: null,
      proof,
      reasonCode: "NORMAL_COMPLETE",
    }),
    aggregateSeal,
    closeout,
    cohortAggregate: request.aggregate,
  });
  const validation = validateM64ExternalNormalCloseBundle(bundle, {
    window,
    aggregate: request.aggregate,
    attemptEvidence: request.attemptEvidence,
    nowMs,
    requestHash: request.requestHash,
  });
  if (!validation.ok) fail("M64_NORMAL_CLOSE_BUNDLE_INVALID", validation.errors.join(","), { errors: validation.errors });
  return bundle;
}

function loadPlainPrivateKey(path) {
  if (typeof path !== "string" || !isAbsolute(path)) fail("M64_NORMAL_CLOSE_PRIVATE_KEY_INVALID", "private key path must be absolute");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) fail("M64_NORMAL_CLOSE_PRIVATE_KEY_INVALID", "private key must be a plain file");
  return readFileSync(path);
}

function publishExact(root, locator, bundle) {
  if (!isAbsolute(root)) fail("M64_NORMAL_CLOSE_OUTPUT_INVALID", "output root must be absolute");
  const bytes = exactJsonBytes(bundle);
  const sha256 = rawSha(bytes);
  const artifactPath = join(root, `${locator.requestHash}.normal-close.bundle.json`);
  publishRecoverableCreateOnly({ targetPath: artifactPath, bytes });
  const descriptor = { path: resolve(artifactPath), sha256, requestHash: locator.requestHash };
  const descriptorPath = join(root, locator.responseDescriptorFileName);
  publishRecoverableCreateOnly({ targetPath: descriptorPath, bytes: exactJsonBytes(descriptor) });
  return Object.freeze({ artifactPath: resolve(artifactPath), descriptorPath: resolve(descriptorPath), sha256 });
}

function option(argv, name, required = true) {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : null;
  if (required && (!value || value.startsWith("--"))) fail("M64_NORMAL_CLOSE_CLI_INVALID", `${name} is required`);
  return value;
}

export async function main(argv = process.argv.slice(2), { stdout = process.stdout } = {}) {
  const locatorDescriptor = parseM64SealedDescriptorSpec(option(argv, "--request-locator"), "normal-close request locator");
  const windowDescriptor = parseM64SealedDescriptorSpec(option(argv, "--window"), "M6-4 window inventory");
  const locator = loadM64SealedJsonArtifact(locatorDescriptor, "normal-close request locator");
  const { locatorHash, ...locatorRaw } = locator || {};
  if (!exactObject(locator, LOCATOR_KEYS) || locator.schemaId !== "xw.m6-4-external-handoff-request-locator.v1"
    || locator.kind !== "NORMAL_CLOSE_SIGNING" || !HASH.test(locator.requestHash || "")
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,220}\.json$/u.test(locator.artifactFileName || "")
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,220}\.json$/u.test(locator.responseDescriptorFileName || "")
    || locatorHash !== sha("xw.m6-4-external-handoff-request-locator.v1", locatorRaw)) {
    fail("M64_NORMAL_CLOSE_LOCATOR_INVALID", "request locator is invalid or forged");
  }
  const requestPath = resolve(dirname(locatorDescriptor.path), locator.artifactFileName);
  const request = loadM64SealedJsonArtifact({ path: requestPath, sha256: locator.requestSha256 }, "normal-close signing request");
  if (request.requestHash !== locator.requestHash) fail("M64_NORMAL_CLOSE_LOCATOR_INVALID", "locator is cross-bound to another request");
  const window = loadM64CanaryWindowInventory(windowDescriptor);
  const nowMs = Date.now();
  const ownerValidation = validateM64LiveWindowAuthorization(window.authorization, {
    manifest: window.manifest,
    modelManifest: window.modelManifest,
    issuerAllowlist: window.issuerAllowlist,
    runtime: window.runtime,
    nowMs,
  });
  if (!ownerValidation.ok) {
    fail("M64_NORMAL_CLOSE_OWNER_AUTHORIZATION_INVALID", ownerValidation.errors.join(","), {
      errors: ownerValidation.errors,
    });
  }
  const bundle = deriveM64NormalCloseBundle({
    request,
    window,
    gatePrivateKey: loadPlainPrivateKey(option(argv, "--gate-private-key")),
    gateKeyId: option(argv, "--gate-key-id"),
    gateSubject: option(argv, "--gate-subject"),
    gateAllowlistVersion: Number(option(argv, "--gate-allowlist-version", false) ?? "1"),
    nowMs,
  });
  const actionCount = totalActionCount(request.aggregate);
  const requiredActionCount = option(argv, "--require-action-count", false);
  if (requiredActionCount !== null && actionCount !== Number(requiredActionCount)) {
    fail("M64_NORMAL_CLOSE_ACTION_COUNT_MISMATCH", "aggregate action count differs from the operator bound");
  }
  const published = argv.includes("--publish") ? publishExact(option(argv, "--output-root"), locator, bundle) : null;
  const result = {
    status: published ? "PUBLISHED" : "DRY_RUN_VALIDATED",
    purpose: request.purpose,
    requestHash: request.requestHash,
    closeEpochHash: bundle.package.epoch.epochHash,
    bundleSha256: rawSha(exactJsonBytes(bundle)),
    actionCount,
    gateMutationPerformed: false,
    deviceAccessed: false,
    networkAccessed: false,
    ...(published ? published : {}),
  };
  stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ error: { code: error?.code || "M64_NORMAL_CLOSE_WORKER_FAILED", message: error?.message } })}\n`);
    process.exitCode = 1;
  });
}
