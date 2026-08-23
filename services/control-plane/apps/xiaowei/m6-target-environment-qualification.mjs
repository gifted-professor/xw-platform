import { createHash } from "node:crypto";

import { deriveTargetEnvironmentAttestation } from "../../../../packages/kernel/lib/m6-live-grounding.mjs";
import { ControlPlaneError } from "../../control-plane/lib/errors.mjs";

const HASH = /^[0-9a-f]{64}$/u;
const PACKAGE_NAME = "com.xingin.xhs";
// One qualification must cover the exact provider qualification plus all five
// fixed 5/1/3/20/30 canary windows. Ten minutes made the evidence expire in
// the middle of the sealed sequence and encouraged unsafe expiry workarounds.
// Six hours remains bounded, and every window is still tied to the exact same
// double-sampled environment hash and performs fresh frame/state guards.
export const M6_TARGET_ENVIRONMENT_QUALIFICATION_TTL_MS = 6 * 60 * 60 * 1000;
const MIN_TTL_MS = 60 * 60 * 1000;
const MAX_TTL_MS = 8 * 60 * 60 * 1000;

// Qualification is deliberately narrower than the ordinary read observer. A
// caller selects no command and supplies no shell text: every query is frozen
// here and is read-only on Android. Two complete samples must match before an
// attestation is issued.
export const M6_TARGET_ENVIRONMENT_READS = Object.freeze({
  appBuild:
    "dumpsys package com.xingin.xhs 2>/dev/null | "
    + "grep -E 'versionCode=|versionName=|longVersionCode=' | sort -u",
  appSigning:
    "dumpsys package com.xingin.xhs 2>/dev/null | "
    + "grep -E 'SigningDetails|signatures=|apkSigningVersion=' | sort -u",
  osBuild:
    "getprop ro.build.fingerprint; getprop ro.build.version.security_patch; "
    + "getprop ro.build.version.release; getprop ro.build.version.sdk",
  display:
    "wm size; wm density; dumpsys window 2>/dev/null | "
    + "grep -E 'mCurrentRotation=' | head -1",
  localeTheme:
    "getprop persist.sys.locale; getprop ro.product.locale; "
    + "settings get system font_scale; cmd uimode night",
  ime:
    "settings get secure default_input_method; "
    + "settings get secure enabled_input_methods",
  accessibility:
    "settings get secure accessibility_enabled; "
    + "settings get secure enabled_accessibility_services; "
    + "settings get secure touch_exploration_enabled",
  accountIsolation:
    "am get-current-user; dumpsys package com.xingin.xhs 2>/dev/null | "
    + "grep -E 'userId=|dataDir=' | head -4",
});

function fail(code, message, details) {
  throw new ControlPlaneError(code, message, { status: 503, ...(details ? { details } : {}) });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeRead(value) {
  return String(value ?? "")
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function unwrapResponse(response, serial) {
  const data = response?.data;
  if (typeof data === "string") return data;
  if (data && typeof data === "object") {
    if (data[serial] !== undefined) return String(data[serial] ?? "");
    const values = Object.values(data);
    if (values.length === 1) return String(values[0] ?? "");
  }
  return data == null ? "" : String(data);
}

async function fixedRead(channel, serial, name, timeoutMs) {
  const command = M6_TARGET_ENVIRONMENT_READS[name];
  if (!command) fail("M6_ENV_READ_NOT_ALLOWED", "target environment query is outside the fixed read-only registry");
  const response = await channel.invoke(
    { action: "adb_shell", devices: serial, data: { command } },
    { timeoutMs },
  );
  const normalized = normalizeRead(unwrapResponse(response, serial));
  if (!normalized) {
    fail("M6_ENV_READ_EMPTY", `target environment read '${name}' returned no qualifying data`);
  }
  return normalized;
}

async function collectSample(channel, serial, timeoutMs) {
  const result = {};
  // Preserve a deterministic, serial query order. This is qualification, not a
  // general-purpose shell surface, and bounded sequential reads make auditing
  // the actual gateway trace straightforward.
  for (const name of Object.keys(M6_TARGET_ENVIRONMENT_READS)) {
    result[name] = await fixedRead(channel, serial, name, timeoutMs);
  }
  return Object.freeze(result);
}

function hashSample(sample, accountIsolationBindingHash) {
  const domain = (name, value) => sha256(`xw.m6-target-environment.${name}.v1:${value}`);
  return Object.freeze({
    appPackageHash: domain("app-package", PACKAGE_NAME),
    appBuildHash: domain("app-build", sample.appBuild),
    signingHash: domain("app-signing", sample.appSigning),
    osBuildHash: domain("os-build", sample.osBuild),
    displayHash: domain("display", sample.display),
    localeThemeHash: domain("locale-theme", sample.localeTheme),
    imeHash: domain("ime", sample.ime),
    accessibilityHash: domain("accessibility", sample.accessibility),
    accountIsolationHash: domain(
      "account-isolation",
      canonical({ configuredBindingHash: accountIsolationBindingHash, deviceUserAndPackageScope: sample.accountIsolation }),
    ),
  });
}

export function deriveM64TargetEnvironmentCommandRegistryHash() {
  return sha256(`xw.m6-target-environment-read-registry.v1:${canonical(M6_TARGET_ENVIRONMENT_READS)}`);
}

export async function collectM64TargetEnvironmentQualification({
  transport,
  serial,
  alias = "01",
  gateMode,
  accountIsolationBindingHash,
  now = Date.now,
  ttlMs = M6_TARGET_ENVIRONMENT_QUALIFICATION_TTL_MS,
  timeoutMs = 12_000,
} = {}) {
  if (gateMode !== "CLOSED") {
    fail("M6_ENV_QUALIFICATION_GATE_OPEN", "target environment qualification requires a CLOSED Gate F");
  }
  if (alias !== "01") fail("M6_ENV_QUALIFICATION_ALIAS_INVALID", "target environment qualification is pinned to alias 01");
  if (!transport || typeof transport.runExclusive !== "function") {
    fail("M6_ENV_QUALIFICATION_TRANSPORT_INVALID", "target environment qualification requires an exclusive production transport");
  }
  if (typeof serial !== "string" || serial.trim() === "") {
    fail("M6_ENV_QUALIFICATION_RUNTIME_INVALID", "alias 01 has no private runtime binding");
  }
  if (!HASH.test(accountIsolationBindingHash ?? "")) {
    fail("M6_ENV_ACCOUNT_ISOLATION_BINDING_REQUIRED", "a preconfigured opaque account-isolation binding is required");
  }
  if (!Number.isInteger(ttlMs) || ttlMs < MIN_TTL_MS || ttlMs > MAX_TTL_MS) {
    fail("M6_ENV_QUALIFICATION_TTL_INVALID", "target environment qualification TTL must be between one and eight hours");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30_000) {
    fail("M6_ENV_QUALIFICATION_TIMEOUT_INVALID", "target environment read timeout is outside the fixed safety envelope");
  }

  const { firstHashes, secondHashes } = await transport.runExclusive(async (channel) => {
    const first = await collectSample(channel, serial, timeoutMs);
    const second = await collectSample(channel, serial, timeoutMs);
    return {
      firstHashes: hashSample(first, accountIsolationBindingHash),
      secondHashes: hashSample(second, accountIsolationBindingHash),
    };
  }, { lockTimeoutMs: Math.min(60_000, timeoutMs * Object.keys(M6_TARGET_ENVIRONMENT_READS).length * 2) });

  if (canonical(firstHashes) !== canonical(secondHashes)) {
    fail("M6_ENV_QUALIFICATION_DRIFT", "target environment changed between the two qualification samples");
  }

  const capturedAtMs = Number(now());
  if (!Number.isFinite(capturedAtMs)) fail("M6_ENV_QUALIFICATION_CLOCK_INVALID", "qualification clock is invalid");
  const capturedAt = new Date(capturedAtMs).toISOString();
  const expiresAt = new Date(capturedAtMs + ttlMs).toISOString();
  const attestation = deriveTargetEnvironmentAttestation({ ...secondHashes, capturedAt, expiresAt });
  const commandRegistryHash = deriveM64TargetEnvironmentCommandRegistryHash();
  const qualification = Object.freeze({
    schemaId: "xw.m6-environment-qualification.v1",
    status: "QUALIFIED",
    gateFEligible: true,
    alias: "01",
    effectBoundary: "READ_ONLY",
    commandRegistryHash,
    qualifiedAttestationHashes: [attestation.attestationHash],
    sampleCount: 2,
    capturedAt,
    expiresAt,
    secretMaterialPresent: false,
    rawDeviceIdentityPresent: false,
    actionCount: 0,
  });
  return Object.freeze({ attestation, qualification });
}
