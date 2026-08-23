import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createDouyinAdapter } from "../apps/douyin/adapter.mjs";
import { createWechatAdapter } from "../apps/wechat/adapter.mjs";
import { createXhsAdapter } from "../apps/xhs/adapter.mjs";
import { createXianyuAdapter } from "../apps/xianyu/adapter.mjs";
import { createXiaoweiAdapter } from "../apps/xiaowei/adapter.mjs";
import { createVisionAdapter } from "../apps/vision/adapter.mjs";
import { createM6LiveWorkerDriver } from "../../../integrations/dsh-xw/src/live-worker-driver.mjs";
import { XiaoweiTransport } from "./lib/xiaowei-transport.mjs";
import { CapabilityRegistry } from "./lib/capability-registry.mjs";
import { AdapterRegistry, ControlPlane } from "./lib/control-plane.mjs";
import { EvidenceStore } from "./lib/evidence-store.mjs";
import { M6FrameEvidenceStore } from "./lib/m6-frame-evidence-store.mjs";
import { createM6FrameCapture } from "./lib/m6-frame-capture.mjs";
import { loadM6Gate } from "./lib/m6-gate-loader.mjs";
import { createM6GateFOperations, loadM6GateFOperationsConfigFromEnv } from "./lib/m6-gate-f-operations.mjs";
import { assertM6GateFSafetyCloseArmMatchesPackage } from "./lib/m6-gate-safety-close-arm.mjs";
import { createM6LiveEntry, loadM6LiveEntryConfigFromEnv } from "./lib/m6-live-entry.mjs";
import { createM6LiveProductionCallbacks } from "./lib/m6-live-production-callbacks.mjs";
import { loadM64ProductionDependencies } from "./lib/m6-live-production-dependencies.mjs";
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

export function assertM6AuthorityTokenSeparation({
  runtimeMode,
  liveEntryEnabled,
  gateFOperationsEnabled,
  liveEntryConfig,
  gateFConfig,
} = {}) {
  if (runtimeMode !== "FINAL" || !liveEntryEnabled || !gateFOperationsEnabled) return true;
  const liveToken = liveEntryConfig?.internalToken;
  const gateToken = gateFConfig?.internalToken;
  if (typeof liveToken === "string" && liveToken.length >= 32
    && typeof gateToken === "string" && gateToken.length >= 32
    && liveToken === gateToken) {
    throw new ControlPlaneError(
      "M6_AUTHORITY_TOKEN_SEPARATION_REQUIRED",
      "M6 live-entry and Gate-F operations must use distinct authority credentials",
      { status: 503, details: { resourceCount: 0 } },
    );
  }
  return true;
}

export function assertM6QualificationBootstrapClosed({ gateOperations, state } = {}) {
  const gate = gateOperations?.status?.();
  const resources = state?.getM6GateFResourceCounts?.();
  if (gate?.schemaId !== "xw.m6-gate-f-operations-status.v1"
    || gate.mode !== "CLOSED" || gate.phase !== "CLOSED" || gate.purpose !== null
    || gate.tripleConsistent !== true || !Array.isArray(gate.errors) || gate.errors.length !== 0
    || gate.activeAuthorizationCount !== 0 || gate.actionCount !== 0
    || !Number.isInteger(gate.generation) || gate.generation < 0
    || !/^[0-9a-f]{64}$/u.test(gate.epochHash ?? "") || !/^[0-9a-f]{64}$/u.test(gate.locksHash ?? "")
    || !resources || Object.values(resources).some((count) => !Number.isSafeInteger(count) || count !== 0)) {
    throw new ControlPlaneError(
      "M6_QUALIFICATION_BOOTSTRAP_NOT_CLOSED",
      "qualification-only scheduler startup requires one triple-consistent CLOSED zero-resource Gate generation",
      { status: 409 },
    );
  }
  return Object.freeze({ epochHash: gate.epochHash, generation: gate.generation, locksHash: gate.locksHash });
}

const M6_ACTIVE_GATE_MODES = Object.freeze(new Set(["OBSERVE_ONLY", "GROUNDED_ACTION"]));

// FINAL startup may open ordinary scheduling only from the never-used base
// CLOSED generation.  Any ACTIVE generation, terminal canary arm, non-zero
// resource, or inconsistent CLOSED triple is a failed canary and remains
// recovery-only across every restart; recovery can reduce authority but can
// never resume that canary.
export function deriveM6StartupRecoveryLatch({
  runtimeMode,
  state,
  gateOperations,
} = {}) {
  if (runtimeMode !== "FINAL") return null;
  const fence = state?.getM6GateFence?.() ?? null;
  if (fence?.mode === "CLOSED") {
    let exactClosed = false;
    let terminalArm = undefined;
    try {
      const gate = gateOperations?.status?.();
      if (typeof state?.getM6GateSafetyCloseArmByTerminalEpoch !== "function") {
        throw new TypeError("terminal-arm lookup is unavailable");
      }
      terminalArm = state.getM6GateSafetyCloseArmByTerminalEpoch(fence.epochHash);
      const resourceCounts = gate?.resourceCounts;
      const exactZeroResources = Boolean(resourceCounts && !Array.isArray(resourceCounts)
        && Object.keys(resourceCounts).sort().join(",") === "jobs,leases,runs,sessions"
        && resourceCounts.jobs === 0 && resourceCounts.leases === 0
        && resourceCounts.runs === 0 && resourceCounts.sessions === 0);
      exactClosed = gate?.schemaId === "xw.m6-gate-f-operations-status.v1"
        && gate.mode === "CLOSED" && gate.phase === "CLOSED"
        && gate.purpose === null && fence.purpose === null
        && gate.generation === 0 && fence.generation === 0
        && gate.epochHash === fence.epochHash && gate.generation === fence.generation
        && gate.locksHash === fence.locksHash
        && gate.tripleConsistent === true
        && Array.isArray(gate.errors) && gate.errors.length === 0
        && gate.activeAuthorizationCount === 0 && gate.actionCount === 0
        && exactZeroResources && terminalArm === null;
    } catch {
      exactClosed = false;
    }
    if (!exactClosed) {
      return Object.freeze({
        schemaId: "xw.m6-startup-recovery-latch.v1",
        required: true,
        status: "UNSAFE_RECOVERY_ONLY",
        reason: terminalArm ? "DURABLE_GATE_TERMINAL_CANARY" : "DURABLE_GATE_CLOSED_UNSAFE",
        gateEpochHash: /^[0-9a-f]{64}$/u.test(fence.epochHash ?? "") ? fence.epochHash : null,
        purpose: null,
        schedulerAllowed: false,
        externalResourceState: "NOT_ASSERTED",
      });
    }
    return Object.freeze({
      schemaId: "xw.m6-startup-recovery-latch.v1",
      required: false,
      status: "NORMAL",
      reason: null,
      gateEpochHash: null,
      purpose: null,
      schedulerAllowed: true,
      externalResourceState: "NOT_ASSERTED",
    });
  }

  if (!M6_ACTIVE_GATE_MODES.has(fence?.mode)) {
    return Object.freeze({
      schemaId: "xw.m6-startup-recovery-latch.v1",
      required: true,
      status: "UNSAFE_RECOVERY_ONLY",
      reason: "DURABLE_GATE_STATE_UNSAFE",
      gateEpochHash: /^[0-9a-f]{64}$/u.test(fence?.epochHash ?? "") ? fence.epochHash : null,
      purpose: typeof fence?.purpose === "string" ? fence.purpose : null,
      schedulerAllowed: false,
      externalResourceState: "NOT_ASSERTED",
    });
  }

  let exactActiveArm = false;
  try {
    const gate = gateOperations?.status?.();
    const arm = state?.getM6GateSafetyCloseArm?.(fence.epochHash) ?? null;
    assertM6GateFSafetyCloseArmMatchesPackage(arm, arm?.package, { allowStatuses: ["ARMED"] });
    exactActiveArm = gate?.schemaId === "xw.m6-gate-f-operations-status.v1"
      && gate.mode === fence.mode
      && gate.phase === (fence.mode === "OBSERVE_ONLY" ? "GROUNDING_ONLY" : "GROUNDED_ACTION")
      && gate.epochHash === fence.epochHash
      && gate.generation === fence.generation
      && gate.locksHash === fence.locksHash
      && gate.purpose === fence.purpose
      && gate.tripleConsistent === true
      && Array.isArray(gate.errors) && gate.errors.length === 0
      && gate.activeAuthorizationCount === 1
      && arm.gateId === fence.gateId
      && arm.purpose === fence.purpose
      && arm.activeEpochHash === fence.epochHash
      && arm.armedGeneration === fence.generation
      && arm.package?.epoch?.parentEpochHash === fence.epochHash
      && arm.package?.epoch?.gateId === fence.gateId
      && arm.package?.epoch?.purpose === fence.purpose;
  } catch {
    // An ACTIVE fence with an unavailable or drifting arm is even less safe;
    // keep serving only the explicit recovery surface so it fails visibly.
    exactActiveArm = false;
  }
  return Object.freeze({
    schemaId: "xw.m6-startup-recovery-latch.v1",
    required: true,
    status: exactActiveArm ? "RECOVERY_ONLY" : "UNSAFE_RECOVERY_ONLY",
    reason: exactActiveArm ? "DURABLE_GATE_ACTIVE_ARMED" : "DURABLE_GATE_ACTIVE_ARM_UNSAFE",
    gateEpochHash: /^[0-9a-f]{64}$/u.test(fence.epochHash ?? "") ? fence.epochHash : null,
    purpose: typeof fence.purpose === "string" ? fence.purpose : null,
    schedulerAllowed: false,
    externalResourceState: "NOT_ASSERTED",
  });
}

export function resolveM6LiveProductionDependencies({
  runtimeMode,
  callbackOptions = {},
  productionConfig,
  loader = loadM64ProductionDependencies,
} = {}) {
  const explicitCallbackDependencies = Boolean(
    callbackOptions.environmentAttestation
    && callbackOptions.environmentQualification
    && callbackOptions.effectBoundary
    && callbackOptions.independentOracle
    && typeof callbackOptions.targetSelector === "function"
    && (typeof callbackOptions.currentStateGuard === "function"
      || typeof callbackOptions.createCurrentStateGuard === "function"),
  );
  if (callbackOptions.productionDependencies) return callbackOptions.productionDependencies;
  if (runtimeMode !== "FINAL" || explicitCallbackDependencies) return Object.freeze({});
  if (typeof loader !== "function") {
    throw new TypeError("M6 FINAL production dependency loader is required");
  }
  return loader({
    runtimeBinding: productionConfig?.productionDependencyRuntimeBinding,
    now: callbackOptions.now ?? Date.now,
  });
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
  // M6-2 W5: opt-in only. Default off (M6_ENABLED unset) keeps every existing
  // runtime byte-identical; zero-live is preserved because an empty gate epoch
  // chain fails closed. An operator flips the env flag to install the facade.
  m6Enabled = process.env.M6_ENABLED === "1",
  m6Root = null,
  m6Gate = { chain: [], closeouts: {} },
  m6Release = null,
  m6Profile = null,
  m6LockHashes = null,
  // Production gate identity. When set, the gate + pinned lock hashes are
  // materialized from immutable on-disk epoch files (m6-gate-loader.mjs); the
  // inline m6Gate/m6LockHashes args become a test-only override path. The env
  // defaults keep zero-live: tests that pass an inline m6Gate do not set
  // XW_GATE_ID, so they are unaffected by the loader.
  m6GateId = process.env.XW_GATE_ID || null,
  m6IssuerAllowlistPath = process.env.XW_GATE_ISSUER_KEYS_PATH || null,
  // M6-C1 production entry is independently opt-in. The environment supplies
  // only sealed paths, content-addressed artifacts, and credential injection; there
  // is deliberately no replay or fixture fallback. The production callback
  // factory is mandatory unless a caller explicitly replaces the whole callback
  // set (tests/embedding only).
  m6LiveEntryEnabled = process.env.M6_LIVE_ENTRY_ENABLED === "1",
  m6LiveEntryConfig = null,
  m6LiveCallbacks = null,
  m6LiveProductionCallbacksOptions = null,
  m6LiveWorkerDriver = null,
  m6LiveEntryFactories = null,
  // Gate-F state changes are a separate, loopback-only operator surface. The
  // CLI is a thin client and never opens the StateStore or edits current.json.
  m6GateFOperationsEnabled = process.env.M6_GATE_F_OPERATIONS_ENABLED === "1",
  m6GateFOperationsConfig = null,
  m6GateFFaultAfterForOperation = () => null,
  m6RuntimeMode = process.env.XW_M6_RUNTIME_MODE || "STANDARD",
} = {}) {
  if (!new Set(["STANDARD", "QUALIFICATION_ONLY", "FINAL"]).has(m6RuntimeMode)) {
    throw new ControlPlaneError("M6_RUNTIME_MODE_INVALID", "M6 runtime mode is not recognized", { status: 503 });
  }
  if (m6RuntimeMode === "QUALIFICATION_ONLY"
    && (m6Enabled || m6LiveEntryEnabled || !m6GateFOperationsEnabled)) {
    throw new ControlPlaneError(
      "M6_QUALIFICATION_BOOTSTRAP_UNSAFE",
      "qualification-only mode requires the live facade and entry disabled with read-only Gate status installed",
      { status: 503 },
    );
  }
  if (m6RuntimeMode === "FINAL"
    && (!m6Enabled || !m6LiveEntryEnabled || !m6GateFOperationsEnabled)) {
    throw new ControlPlaneError(
      "M6_FINAL_BOOTSTRAP_INCOMPLETE",
      "final mode requires the M6 facade, live entry, and Gate-F operations",
      { status: 503 },
    );
  }
  const defaults = defaultRuntimePaths();
  const resolvedDbPath = dbPath || process.env.CONTROL_PLANE_DB || defaults.dbPath;
  const resolvedRunsRoot = runsRoot || process.env.CONTROL_PLANE_RUNS_ROOT || defaults.runsRoot;
  const runtimeState = state || new StateStore({ dbPath: resolvedDbPath, m6RuntimeMode });
  if (runtimeState.m6RuntimeMode !== m6RuntimeMode) {
    throw new ControlPlaneError(
      "M6_RUNTIME_MODE_STATE_MISMATCH",
      "the injected StateStore M6 runtime mode does not match the runtime being bootstrapped",
      { status: 503 },
    );
  }
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
    // The M6 evidence + audit roots live under the canonical xw-runtime directory
    // (the deployed runtime root), not a repo-local path. Resolution order: an
    // explicit m6Root arg, then XW_RUNTIME_ROOT, then the platform canonical
    // default (C:\Users\Public\xw-runtime on Windows; repo-local elsewhere for
    // non-production dev).
    const m6RootPath = m6Root || process.env.XW_RUNTIME_ROOT
      || (process.platform === "win32" ? "C:\\Users\\Public\\xw-runtime" : join(root, "xw-runtime"));
    const m6Evidence = new M6FrameEvidenceStore({ root: join(m6RootPath, "m6-frames") });
    const releaseIdentity = m6Release || loadReleaseIdentity({ startDir: root });
    const profile = m6Profile ?? loadLegacyCompatProfile();
    // Production: materialize the gate (chain + closeouts) and pinned lock hashes
    // from immutable on-disk epoch files. When m6GateId is set the loader is the
    // source of truth; the inline m6Gate/m6LockHashes args are ignored. With no
    // gateId (test/inline path) the caller-supplied gate + lockHashes are used
    // as-is. Either way the facade requires non-null lockHashes (fail closed).
    let gate = m6Gate;
    let gateProvider = null;
    let resolvedLockHashes = m6LockHashes;
    if (m6GateId) {
      const issuerAllowlist = m6IssuerAllowlistPath || join(m6RootPath, "m6-gate", "issuer-keys.json");
      gateProvider = () => loadM6Gate({ m6Root: m6RootPath, gateId: m6GateId, issuerAllowlistPath: issuerAllowlist });
      const loaded = gateProvider();
      gate = { chain: loaded.chain, closeouts: loaded.closeouts, aggregates: loaded.aggregates };
      resolvedLockHashes = loaded.lockHashes;
    }
    m6 = createM6FrameCapture({
      control,
      state: runtimeState,
      capabilities: registry,
      evidence: m6Evidence,
      auditRoot: join(m6RootPath, "m6-audit"),
      gate,
      gateProvider,
      release: { releaseId: releaseIdentity.releaseId, sourceCommit: releaseIdentity.sourceCommit },
      profile,
      devices: { findByAlias: (alias) => runtimeState.listDevices().find((d) => d.alias === alias) || null },
      lockHashes: resolvedLockHashes,
    });
  }

  const resolvedM6LiveEntryConfig = m6LiveEntryEnabled
    ? (m6LiveEntryConfig ?? loadM6LiveEntryConfigFromEnv({ env: process.env }))
    : null;
  const resolvedM6GateFConfig = m6GateFOperationsEnabled
    ? (m6GateFOperationsConfig ?? loadM6GateFOperationsConfigFromEnv({ env: process.env }))
    : null;
  assertM6AuthorityTokenSeparation({
    runtimeMode: m6RuntimeMode,
    liveEntryEnabled: m6LiveEntryEnabled,
    gateFOperationsEnabled: m6GateFOperationsEnabled,
    liveEntryConfig: resolvedM6LiveEntryConfig,
    gateFConfig: resolvedM6GateFConfig,
  });

  let m6LiveEntry = null;
  if (m6LiveEntryEnabled) {
    const productionConfig = resolvedM6LiveEntryConfig;
    const callbackOptions = m6LiveProductionCallbacksOptions ?? {};
    const callbackRuntimeRoot = productionConfig.m6Root;
    const productionFrameEvidence = callbackOptions.evidence
      ?? (typeof callbackRuntimeRoot === "string" && isAbsolute(callbackRuntimeRoot)
        ? new M6FrameEvidenceStore({ root: join(callbackRuntimeRoot, "m6-frames") })
        : null);
    const sealedProductionDependencies = resolveM6LiveProductionDependencies({
      runtimeMode: m6RuntimeMode,
      callbackOptions,
      productionConfig,
    });
    const productionCallbacks = m6LiveCallbacks ?? createM6LiveProductionCallbacks({
      ...sealedProductionDependencies,
      ...callbackOptions,
      state: runtimeState,
      capabilities: registry,
      transport: sharedXiaoweiTransport,
      evidence: productionFrameEvidence,
      evidenceDirectoryRoot: callbackOptions.evidenceDirectoryRoot
        ?? (typeof callbackRuntimeRoot === "string" && isAbsolute(callbackRuntimeRoot)
          ? join(callbackRuntimeRoot, "m6-action-evidence") : null),
      auditRoot: callbackOptions.auditRoot
        ?? (typeof callbackRuntimeRoot === "string" && isAbsolute(callbackRuntimeRoot)
          ? join(callbackRuntimeRoot, "m6-audit") : null),
      authorityNodeId: nodeId,
    });
    const persistenceRoot = productionConfig.runtimeEnv?.XW_DSH_PERSISTENCE_ROOT;
    const productionWorkerDriver = m6LiveWorkerDriver
      ?? (typeof persistenceRoot === "string" && isAbsolute(persistenceRoot)
        ? createM6LiveWorkerDriver({ workingDirectory: persistenceRoot })
        : null);
    m6LiveEntry = createM6LiveEntry({
      ...(m6LiveEntryFactories ?? {}),
      state: runtimeState,
      config: productionConfig,
      callbacks: productionCallbacks,
      workerDriver: productionWorkerDriver,
    });
  }

  let m6GateFOperations = null;
  if (m6GateFOperationsEnabled) {
    m6GateFOperations = createM6GateFOperations({
      state: runtimeState,
      config: resolvedM6GateFConfig,
      activeRunCount: () => m6LiveEntry?.health().activeRuns ?? 0,
      faultAfterForOperation: m6GateFFaultAfterForOperation,
    });
  }
  if (m6RuntimeMode === "QUALIFICATION_ONLY") {
    assertM6QualificationBootstrapClosed({ gateOperations: m6GateFOperations, state: runtimeState });
  }
  const m6StartupRecovery = deriveM6StartupRecoveryLatch({
    runtimeMode: m6RuntimeMode,
    state: runtimeState,
    gateOperations: m6GateFOperations,
  });

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
    m6GateFOperations,
    m6LiveEntry,
    m6RuntimeMode,
    m6StartupRecovery,
  };
}
