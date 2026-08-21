import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createDouyinAdapter } from "../apps/douyin/adapter.mjs";
import { createWechatAdapter } from "../apps/wechat/adapter.mjs";
import { createXhsAdapter } from "../apps/xhs/adapter.mjs";
import { createXianyuAdapter } from "../apps/xianyu/adapter.mjs";
import { createXiaoweiAdapter } from "../apps/xiaowei/adapter.mjs";
import { createVisionAdapter } from "../apps/vision/adapter.mjs";
import { XiaoweiTransport } from "./lib/xiaowei-transport.mjs";
import { CapabilityRegistry } from "./lib/capability-registry.mjs";
import { AdapterRegistry, ControlPlane } from "./lib/control-plane.mjs";
import { EvidenceStore } from "./lib/evidence-store.mjs";
import { M6FrameEvidenceStore } from "./lib/m6-frame-evidence-store.mjs";
import { createM6FrameCapture } from "./lib/m6-frame-capture.mjs";
import { loadReleaseIdentity } from "../../../packages/release/lib/release-identity.mjs";
import { ControlPlaneError } from "./lib/errors.mjs";
import { DelegationGrantRuntime } from "./lib/delegation-grant-runtime.mjs";
import {
  loadGeneratedOverlay,
  resolveOverlayMode,
} from "./lib/generated-overlay.mjs";
import { resolvePolicyMode } from "./lib/nonpayment-autonomy-policy.mjs";
import { StateStore } from "./lib/state-store.mjs";
import { TrustedHumanIssuer } from "./lib/trusted-human-issuer.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function defaultRuntimePaths() {
  if (process.platform === "win32") {
    return {
      dbPath: "C:\\Users\\Public\\xhs-agent-control\\control.db",
      runsRoot: "C:\\Users\\Public\\xhs-agent-runs",
    };
  }
  return {
    dbPath: join(root, "control-plane", "runtime", "control.db"),
    runsRoot: join(root, "control-plane", "runtime", "runs"),
  };
}

export function assertAuthorityHost({
  expectedHost = process.env.CONTROL_PLANE_EXPECTED_HOST || "DESKTOP-3I1EVHE",
  actualHost = hostname(),
  allowOtherHost = process.env.CONTROL_PLANE_ALLOW_OTHER_HOST === "1",
} = {}) {
  if (!allowOtherHost && actualHost.toUpperCase() !== expectedHost.toUpperCase()) {
    throw new ControlPlaneError(
      "AUTHORITY_HOST_MISMATCH",
      `control plane authority must be ${expectedHost}; found ${actualHost}`,
      { status: 503 },
    );
  }
  return actualHost;
}

export function assertPinnedNodeVersion({
  expected = process.env.CONTROL_PLANE_NODE_VERSION || "24.11.1",
  actual = process.versions.node,
  allowOtherVersion = process.env.CONTROL_PLANE_ALLOW_OTHER_NODE === "1",
} = {}) {
  if (!allowOtherVersion && actual !== expected) {
    throw new ControlPlaneError(
      "NODE_VERSION_MISMATCH",
      `control plane requires Node ${expected}; found ${actual}`,
      { status: 503 },
    );
  }
  return actual;
}

function loadDeviceConfig(path) {
  if (!existsSync(path)) return null;
  const config = JSON.parse(readFileSync(path, "utf8"));
  if (config.schemaVersion !== 1 || !Array.isArray(config.devices)) {
    throw new TypeError("control-plane device config must use schemaVersion 1 and a devices array");
  }
  return config;
}

export function loadStandingGrantIssuer({ standingGrantEnabled, issuerKeysPath } = {}) {
  // A disabled feature must not make ordinary flag-off startup depend on an example or
  // future deployment path. Enabling it is the explicit fail-closed boundary.
  if (!standingGrantEnabled) return null;
  if (typeof issuerKeysPath !== "string" || issuerKeysPath.trim() === "") {
    throw new ControlPlaneError("STANDING_GRANT_ISSUER_UNAVAILABLE", "standing grant issuer configuration is required when enabled", { status: 503 });
  }
  return TrustedHumanIssuer.fromFile(issuerKeysPath);
}

// The immutable release profile bit for M6: only legacy_compat with
// agenticGroundingEnabled=true is admissible. Missing contract → null (fail
// closed: the facade then rejects every capture with M6_PROFILE_DISABLED).
export function loadLegacyCompatProfile({ startDir = dirname(fileURLToPath(import.meta.url)) } = {}) {
  try {
    const path = join(dirname(dirname(dirname(startDir))), "packages", "kernel", "contracts", "runtime-profile.v1.json");
    const contract = JSON.parse(readFileSync(path, "utf8"));
    const profile = contract.profiles?.["legacy_compat"];
    if (!profile) return null;
    return { runtimeProfile: "legacy_compat", agenticGroundingEnabled: profile.agenticGroundingEnabled === true };
  } catch {
    return null;
  }
}

export function createControlPlaneRuntime({
  nodeId = process.env.CONTROL_PLANE_NODE_ID || "DESKTOP-3I1EVHE",
  dbPath,
  runsRoot,
  deviceConfigPath = process.env.CONTROL_PLANE_DEVICES_FILE || join(root, "config", "control-plane.devices.json"),
  appsRoot = join(root, "apps"),
  state,
  capabilities,
  adapters,
  evidence,
  schedulerIntervalMs,
  leaseTtlMs,
  leaseHeartbeatMs,
  issuerKeysPath = process.env.STANDING_GRANT_ISSUER_KEYS_PATH,
  missionAutoApprovalEnabled = process.env.MISSION_AUTO_APPROVAL_ENABLED === "1",
  standingGrantEnabled = process.env.STANDING_GRANT_ENABLED === "1",
  adrAccepted = null,
  adrPath,
  standingGrantAdrAccepted = null,
  standingGrantAdrPath,
  discoveryCapabilityForPrimitive = {},
  policyMode = null,
  // M6-2 W5: opt-in only. Default off keeps every existing runtime byte-identical;
  // zero-live is preserved because an empty gate epoch chain fails closed.
  m6Enabled = false,
  m6Root = null,
  m6Gate = { chain: [], closeouts: {} },
  m6Release = null,
  m6Profile = null,
  m6LockHashes = null,
} = {}) {
  const defaults = defaultRuntimePaths();
  const resolvedDbPath = dbPath || process.env.CONTROL_PLANE_DB || defaults.dbPath;
  const resolvedRunsRoot = runsRoot || process.env.CONTROL_PLANE_RUNS_ROOT || defaults.runsRoot;
  const runtimeState = state || new StateStore({ dbPath: resolvedDbPath });
  // An allowlist is optional while both standing-grant gates remain off. If an operator
  // explicitly supplies one, load and reconcile it before any scheduler can be started.
  const trustedIssuer = loadStandingGrantIssuer({ standingGrantEnabled, issuerKeysPath });
  const delegationGrants = trustedIssuer ? new DelegationGrantRuntime({ state: runtimeState, issuer: trustedIssuer }) : null;
  delegationGrants?.reconcileIssuerKeys();
  const registry = capabilities || CapabilityRegistry.load(resolve(appsRoot));
  const config = loadDeviceConfig(deviceConfigPath);
  if (config) {
    for (const device of config.devices) {
      runtimeState.upsertDevice({
        ...device,
        nodeId: device.nodeId || config.nodeId || nodeId,
      });
    }
  }
  const runtimeEvidence = evidence || new EvidenceStore({
    runsRoot: resolvedRunsRoot,
    state: runtimeState,
    minFreeBytes: Number(process.env.CONTROL_PLANE_MIN_FREE_BYTES || 128 * 1024 * 1024),
    minExternalEffectFreeBytes: Number(process.env.CONTROL_PLANE_MIN_EFFECT_FREE_BYTES || 1024 * 1024 * 1024),
  });
  const sharedXiaoweiTransport = new XiaoweiTransport();
  const adapterRegistry = adapters instanceof AdapterRegistry
    ? adapters
    : new AdapterRegistry(adapters || [
      createXhsAdapter({ transport: sharedXiaoweiTransport }),
      createXianyuAdapter(),
      createDouyinAdapter(),
      createWechatAdapter(),
      createXiaoweiAdapter({ transport: sharedXiaoweiTransport }),
      createVisionAdapter(),
    ]);
  // REX Phase 5 B7 / Phase 7: production policy mode from the pinned launch config. shadow
  // computes but does not apply; nonpayment_v1 on the real adapter is active only when the
  // launch config supplies both pilot actor and pilot alias selectors. legacy (unset env) stays
  // null, preserving the old behavior byte-for-byte.
  const autonomyMode = process.env.AUTONOMY_POLICY_MODE || "legacy";
  const resolvedPolicyMode = policyMode ?? (
    autonomyMode === "legacy" ? null : resolvePolicyMode({ env: process.env, adapterKind: "real" })
  );
  const control = new ControlPlane({
    state: runtimeState,
    capabilities: registry,
    adapters: adapterRegistry,
    evidence: runtimeEvidence,
    authorityNodeId: nodeId,
    schedulerIntervalMs,
    leaseTtlMs,
    leaseHeartbeatMs,
    missionAutoApprovalEnabled,
    standingGrantEnabled,
    adrAccepted,
    adrPath,
    standingGrantAdrAccepted,
    standingGrantAdrPath,
    policyMode: resolvedPolicyMode,
    receiptAuthorityAllowlist: [
      { capabilityId: "xhs.observe.note_detail", adapterId: "xhs" },
      { capabilityId: "xhs.explore.open_feed_note", adapterId: "xhs" },
    ],
  });
  control.installDiscoveryProducer({ capabilityForPrimitive: discoveryCapabilityForPrimitive });

  // M6-2 W5 closed facade. Opt-in; with no operator epochs the gate is CLOSED and
  // every capture/preflight fails closed before touching a device. The M6 frame
  // evidence + audit roots live under the canonical xw-runtime directory.
  let m6 = null;
  if (m6Enabled) {
    const m6RootPath = m6Root || join(root, "xw-runtime");
    const m6Evidence = new M6FrameEvidenceStore({ root: join(m6RootPath, "m6-frames") });
    const releaseIdentity = m6Release || loadReleaseIdentity({ startDir: root });
    const profile = m6Profile ?? loadLegacyCompatProfile();
    m6 = createM6FrameCapture({
      control,
      state: runtimeState,
      capabilities: registry,
      evidence: m6Evidence,
      auditRoot: join(m6RootPath, "m6-audit"),
      gate: m6Gate,
      release: { releaseId: releaseIdentity.releaseId, sourceCommit: releaseIdentity.sourceCommit },
      profile,
      devices: { findByAlias: (alias) => runtimeState.listDevices().find((d) => d.alias === alias) || null },
      lockHashes: m6LockHashes,
    });
  }

  // Phase 4: optional generated recipe overlay. Never removes static capabilities;
  // never auto-executes recipes. Flag off → skip attach entirely.
  const overlayMode = resolveOverlayMode();
  let recipeOverlay = null;
  if (overlayMode !== "off") {
    const overlayPath = process.env.XHS_RECIPE_OVERLAY_PATH || undefined;
    const expectedSha256 = process.env.XHS_RECIPE_OVERLAY_SHA256 || undefined;
    recipeOverlay = loadGeneratedOverlay({
      featureFlag: overlayMode,
      ...(overlayPath ? { path: overlayPath } : {}),
      ...(expectedSha256 ? { expectedSha256 } : {}),
    });
    control.recipeOverlay = recipeOverlay;
  }

  return {
    root,
    state: runtimeState,
    capabilities: registry,
    adapters: adapterRegistry,
    evidence: runtimeEvidence,
    control,
    recipeOverlay,
    delegationGrants,
    dbPath: resolvedDbPath,
    runsRoot: resolvedRunsRoot,
    deviceConfigPath,
    nodeId,
    policyMode: resolvedPolicyMode,
    m6,
  };
}
