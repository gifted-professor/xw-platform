#!/usr/bin/env node

// Independent, request-bound M6-4 process inventory publisher.
//
// The worker performs read-only OS and Control DB observations. It never calls
// the Gate, Control Plane, device transport, ADB, or provider. Findings are
// content-hashed before publication so process ids, command lines, raw device
// identities, and credential material never cross the handoff boundary.

import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import {
  existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import {
  M64_INDEPENDENT_ORACLE_POLICY_SCHEMA_ID,
  deriveM64IndependentActorHash,
  deriveM64IndependentOraclePolicyHash,
} from "../../services/control-plane/control-plane/lib/m6-live-production-dependencies.mjs";
import {
  canonicalM64ProcessInventorySigningBytes,
  deriveM64ProcessInventoryHash,
  deriveM64ResourceObservationRequestHash,
  validateM64IndependentProcessInventory,
} from "./m6-4-production-operator-bridge.mjs";

const HASH = /^[0-9a-f]{64}$/u;
const PURPOSE = /^(?:M6_4_(?:SHADOW|HOT_CLOSE|ACTION_SMOKE|RELIABILITY|SMOOTH|FINAL))$/u;
const REQUEST_KEYS = Object.freeze(["closeReceiptHashes", "gateClosedEpochHash", "notBefore", "purpose", "requestHash"]);
const LOCATOR_KEYS = Object.freeze([
  "artifactFileName", "kind", "locatorHash", "purpose", "requestHash", "requestSha256", "responseDescriptorFileName", "schemaId",
]);
const PRIVATE_KEY_PATTERN = /-----BEGIN (?:OPENSSH |EC |RSA )?PRIVATE KEY-----/iu;
const SECRET_ARG_PATTERN = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|credential|secret)\s*(?:=|:)/iu;
const RAW_IDENTITY_PATTERN = /(?:\badb\b[^\r\n]*\s-s\s+|(?:serial|device[_-]?id|raw-device)\s*(?:=|:)\s*)[^\s"']+/iu;
const LIVE_CHILD_PATTERN = /(?:integrations[\\/]dsh-xw|[\\/]dsh(?:\.mjs|\.js)?\b).*--profile\s+live\b/iu;

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function exactObject(value, keys) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && canonical(Object.keys(value).sort()) === canonical([...keys].sort()));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function finding(kind, value) {
  return sha256(`xw.m6-4-process-inventory-finding.v1:${kind}:${value}`);
}

function readJson(path, label) {
  let bytes;
  try { bytes = readFileSync(path); } catch (cause) {
    throw Object.assign(new Error(`${label} is unavailable`), { code: "M64_PROCESS_WORKER_INPUT_UNAVAILABLE", cause });
  }
  try { return { bytes, value: JSON.parse(bytes.toString("utf8")) }; } catch (cause) {
    throw Object.assign(new Error(`${label} is not JSON`), { code: "M64_PROCESS_WORKER_INPUT_INVALID", cause });
  }
}

function loadRequest(locatorPath) {
  const absoluteLocator = resolve(locatorPath);
  const { value: locator } = readJson(absoluteLocator, "resource-observation locator");
  const { locatorHash: _ignoredLocatorHash, ...locatorRaw } = locator || {};
  if (!exactObject(locator, LOCATOR_KEYS)
    || locator.schemaId !== "xw.m6-4-external-handoff-request-locator.v1"
    || locator.kind !== "RESOURCE_OBSERVATION" || !PURPOSE.test(locator.purpose || "")
    || !HASH.test(locator.requestHash || "") || !HASH.test(locator.requestSha256 || "")
    || locator.locatorHash !== sha256(`xw.m6-4-external-handoff-request-locator.v1:${canonical(locatorRaw)}`)
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,220}\.json$/u.test(locator.artifactFileName || "")
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,220}\.json$/u.test(locator.responseDescriptorFileName || "")) {
    throw Object.assign(new Error("resource-observation locator is malformed"), { code: "M64_PROCESS_WORKER_LOCATOR_INVALID" });
  }
  const requestPath = resolve(dirname(absoluteLocator), locator.artifactFileName);
  if (dirname(requestPath) !== dirname(absoluteLocator)) {
    throw Object.assign(new Error("request artifact escaped its locator directory"), { code: "M64_PROCESS_WORKER_LOCATOR_INVALID" });
  }
  const { bytes, value: request } = readJson(requestPath, "resource-observation request");
  if (sha256(bytes) !== locator.requestSha256 || !exactObject(request, REQUEST_KEYS)
    || request.purpose !== locator.purpose || request.requestHash !== locator.requestHash
    || !HASH.test(request.gateClosedEpochHash || "")
    || !Array.isArray(request.closeReceiptHashes)
    || request.closeReceiptHashes.some((item) => !HASH.test(item || ""))
    || new Set(request.closeReceiptHashes).size !== request.closeReceiptHashes.length
    || !Number.isFinite(Date.parse(request.notBefore))
    || deriveM64ResourceObservationRequestHash(request) !== request.requestHash) {
    throw Object.assign(new Error("resource-observation request is not exact or content-bound"), { code: "M64_PROCESS_WORKER_REQUEST_INVALID" });
  }
  return { locator, request };
}

export function inspectM64ProcessSnapshot(rows = []) {
  if (!Array.isArray(rows)) throw Object.assign(new Error("OS process snapshot is unavailable"), { code: "M64_PROCESS_WORKER_OS_OBSERVATION_FAILED" });
  const refs = { activeBrokerRefs: [], activePipeRefs: [], activeProcessRefs: [], orphanProcessRefs: [], rawDeviceIdentityFindings: [], secretMaterialFindings: [] };
  for (const row of rows) {
    const commandLine = typeof row?.commandLine === "string" ? row.commandLine : "";
    const executable = typeof row?.executable === "string" ? row.executable : "";
    const identity = canonical({ commandHash: sha256(commandLine), createdAt: row?.createdAt ?? null, executableHash: sha256(executable), pid: row?.pid ?? null });
    const processRef = finding("live-process", identity);
    const isLiveChild = LIVE_CHILD_PATTERN.test(commandLine);
    if (isLiveChild) {
      refs.activeProcessRefs.push(processRef);
      refs.activeBrokerRefs.push(finding("live-broker", identity));
      refs.activePipeRefs.push(finding("live-pipe", identity));
      refs.orphanProcessRefs.push(finding("orphan-live-process", identity));
    }
    if (isLiveChild && RAW_IDENTITY_PATTERN.test(commandLine)) refs.rawDeviceIdentityFindings.push(finding("raw-device-identity", identity));
    if ((isLiveChild && SECRET_ARG_PATTERN.test(commandLine)) || PRIVATE_KEY_PATTERN.test(commandLine)) refs.secretMaterialFindings.push(finding("command-line-secret", identity));
  }
  for (const values of Object.values(refs)) values.sort();
  return Object.freeze(refs);
}

export function inspectM64ScenarioClaims(dbPath) {
  if (typeof dbPath !== "string" || !isAbsolute(dbPath) || !existsSync(dbPath)) {
    throw Object.assign(new Error("canonical Control DB is unavailable"), { code: "M64_PROCESS_WORKER_DB_OBSERVATION_FAILED" });
  }
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec("PRAGMA busy_timeout=5000;");
    const rows = db.prepare("SELECT claim_hash FROM m6_live_scenario_claims WHERE status='STARTED' ORDER BY claim_hash").all();
    if (rows.some((row) => !HASH.test(row.claim_hash || ""))) throw new Error("invalid durable claim hash");
    return Object.freeze(rows.map((row) => row.claim_hash));
  } catch (cause) {
    throw Object.assign(new Error("canonical Control DB scenario claims could not be read"), { code: "M64_PROCESS_WORKER_DB_OBSERVATION_FAILED", cause });
  } finally { try { db?.close(); } catch {} }
}

export function captureM64WindowsProcessSnapshot() {
  if (process.platform !== "win32") throw Object.assign(new Error("production process inventory requires Windows"), { code: "M64_PROCESS_WORKER_PLATFORM_UNSUPPORTED" });
  const script = "$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process | Select-Object @{n='pid';e={$_.ProcessId}},@{n='createdAt';e={$_.CreationDate}},@{n='executable';e={$_.ExecutablePath}},@{n='commandLine';e={$_.CommandLine}}) | ConvertTo-Json -Compress -Depth 3";
  let value;
  try {
    const raw = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    value = JSON.parse(raw || "[]");
  } catch (cause) {
    throw Object.assign(new Error("Windows process snapshot failed"), { code: "M64_PROCESS_WORKER_OS_OBSERVATION_FAILED", cause });
  }
  return Array.isArray(value) ? value : [value];
}

export function buildM64SignedProcessInventory({ request, observerKeyId, observerHash, privateKey, processRows, activeScenarioClaimRefs, capturedAt = new Date().toISOString() } = {}) {
  if (!PURPOSE.test(request?.purpose || "") || !HASH.test(observerHash || "") || typeof observerKeyId !== "string"
    || !Array.isArray(activeScenarioClaimRefs) || activeScenarioClaimRefs.some((item) => !HASH.test(item || ""))) {
    throw Object.assign(new Error("process inventory inputs are invalid"), { code: "M64_PROCESS_WORKER_INPUT_INVALID" });
  }
  const processFindings = inspectM64ProcessSnapshot(processRows);
  const raw = {
    schemaId: "xw.m6-4-independent-process-inventory.v1",
    observerClass: "INDEPENDENT_OS_AND_CONTROL_DB_OBSERVER",
    observerHash,
    observerKeyId,
    signatureAlgorithm: "ed25519",
    purpose: request.purpose,
    gateClosedEpochHash: request.gateClosedEpochHash,
    requestHash: request.requestHash,
    capturedAt,
    closeReceiptHashes: [...request.closeReceiptHashes],
    ...processFindings,
    activeScenarioClaimRefs: [...new Set(activeScenarioClaimRefs)].sort(),
  };
  const withHash = { ...raw, inventoryHash: deriveM64ProcessInventoryHash(raw) };
  return Object.freeze({ ...withHash, signature: sign(null, canonicalM64ProcessInventorySigningBytes(withHash), privateKey).toString("base64") });
}

function writeAtomic(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, bytes, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try { renameSync(temporary, path); } catch (cause) { rmSync(temporary, { force: true }); throw cause; }
}

function option(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  return index >= 0 && index < argv.length - 1 ? argv[index + 1] : fallback;
}

export function runM64ProcessInventoryWorker({ locatorPath, responseRoot, dbPath, privateKeyPath, policyPath, processSnapshot = captureM64WindowsProcessSnapshot, now = Date.now } = {}) {
  const { locator, request } = loadRequest(locatorPath);
  const policy = readJson(resolve(policyPath), "independent observer policy").value;
  if (policy?.schemaId !== M64_INDEPENDENT_ORACLE_POLICY_SCHEMA_ID
    || policy?.policyHash !== deriveM64IndependentOraclePolicyHash(policy)
    || typeof policy?.observationObserverKeyId !== "string"
    || typeof policy?.observationObserverPublicKey !== "string"
    || !HASH.test(policy?.independentObserverHash || "")
    || !Number.isSafeInteger(policy?.maxObservationAgeMs)
    || policy.maxObservationAgeMs < 1 || policy.maxObservationAgeMs > 60_000) {
    throw Object.assign(new Error("independent observer policy is malformed or not sealed"), { code: "M64_PROCESS_WORKER_POLICY_INVALID" });
  }
  const privateKeyBytes = readFileSync(resolve(privateKeyPath));
  if (PRIVATE_KEY_PATTERN.test(canonical({ locator, request, policy }))) throw Object.assign(new Error("public handoff inputs contain private key material"), { code: "M64_PROCESS_WORKER_SECRET_BOUNDARY_INVALID" });
  let privateKey;
  try { privateKey = createPrivateKey(privateKeyBytes); } catch (cause) { throw Object.assign(new Error("observer signing key is invalid"), { code: "M64_PROCESS_WORKER_SIGNER_INVALID", cause }); }
  finally { privateKeyBytes.fill(0); }
  if (privateKey.asymmetricKeyType !== "ed25519"
    || createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString() !== createPublicKey(policy.observationObserverPublicKey).export({ type: "spki", format: "pem" }).toString()
    || deriveM64IndependentActorHash(createPublicKey(privateKey)) !== policy.independentObserverHash) {
    throw Object.assign(new Error("observer signing key does not match the sealed policy"), { code: "M64_PROCESS_WORKER_SIGNER_INVALID" });
  }
  const capturedAtMs = now();
  const inventory = buildM64SignedProcessInventory({
    request,
    observerKeyId: policy.observationObserverKeyId,
    observerHash: policy.independentObserverHash,
    privateKey,
    processRows: processSnapshot(),
    activeScenarioClaimRefs: inspectM64ScenarioClaims(resolve(dbPath)),
    capturedAt: new Date(capturedAtMs).toISOString(),
  });
  const validation = validateM64IndependentProcessInventory(inventory, {
    purpose: request.purpose,
    gateClosedEpochHash: request.gateClosedEpochHash,
    closeReceiptHashes: request.closeReceiptHashes,
    observerPolicy: { keyId: policy.observationObserverKeyId, observerHash: policy.independentObserverHash, publicKey: createPublicKey(policy.observationObserverPublicKey) },
    notBeforeMs: Date.parse(request.notBefore), nowMs: capturedAtMs, maxAgeMs: policy.maxObservationAgeMs,
  });
  if (!validation.ok) throw Object.assign(new Error(`signed inventory failed verification: ${validation.errors.join(",")}`), { code: "M64_PROCESS_WORKER_OUTPUT_INVALID" });
  const root = resolve(responseRoot);
  const artifactName = `${inventory.inventoryHash}.signed-process-inventory.json`;
  const artifactPath = join(root, artifactName);
  const bytes = `${JSON.stringify(inventory, null, 2)}\n`;
  writeAtomic(artifactPath, bytes);
  const descriptor = { path: artifactPath, requestHash: request.requestHash, sha256: sha256(bytes) };
  writeAtomic(join(root, locator.responseDescriptorFileName), `${JSON.stringify(descriptor, null, 2)}\n`);
  return Object.freeze({ inventoryHash: inventory.inventoryHash, inventorySha256: descriptor.sha256, requestHash: request.requestHash, allZero: [
    inventory.activeBrokerRefs, inventory.activePipeRefs, inventory.activeProcessRefs, inventory.activeScenarioClaimRefs,
    inventory.orphanProcessRefs, inventory.rawDeviceIdentityFindings, inventory.secretMaterialFindings,
  ].every((items) => items.length === 0), actionCount: 0 });
}

function main() {
  const argv = process.argv.slice(2);
  const result = runM64ProcessInventoryWorker({
    locatorPath: option(argv, "--locator"), responseRoot: option(argv, "--response-root"),
    dbPath: option(argv, "--db-path"), privateKeyPath: option(argv, "--private-key"), policyPath: option(argv, "--policy"),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result.allZero ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(); } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, code: error.code || "M64_PROCESS_WORKER_FAILED", actionCount: 0 })}\n`);
    process.exitCode = 2;
  }
}
