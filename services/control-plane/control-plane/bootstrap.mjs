import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createWechatAdapter } from "../apps/wechat/adapter.mjs";
import { createXhsAdapter } from "../apps/xhs/adapter.mjs";
import { createXianyuAdapter } from "../apps/xianyu/adapter.mjs";
import { createXiaoweiAdapter } from "../apps/xiaowei/adapter.mjs";
import { CapabilityRegistry } from "./lib/capability-registry.mjs";
import { AdapterRegistry, ControlPlane } from "./lib/control-plane.mjs";
import { EvidenceStore } from "./lib/evidence-store.mjs";
import { ControlPlaneError } from "./lib/errors.mjs";
import { StateStore } from "./lib/state-store.mjs";

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
} = {}) {
  const defaults = defaultRuntimePaths();
  const resolvedDbPath = dbPath || process.env.CONTROL_PLANE_DB || defaults.dbPath;
  const resolvedRunsRoot = runsRoot || process.env.CONTROL_PLANE_RUNS_ROOT || defaults.runsRoot;
  const runtimeState = state || new StateStore({ dbPath: resolvedDbPath });
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
  const adapterRegistry = adapters instanceof AdapterRegistry
    ? adapters
    : new AdapterRegistry(adapters || [
      createXhsAdapter(),
      createXianyuAdapter(),
      createWechatAdapter(),
      createXiaoweiAdapter(),
    ]);
  const control = new ControlPlane({
    state: runtimeState,
    capabilities: registry,
    adapters: adapterRegistry,
    evidence: runtimeEvidence,
    authorityNodeId: nodeId,
    schedulerIntervalMs,
    leaseTtlMs,
    leaseHeartbeatMs,
  });
  return {
    root,
    state: runtimeState,
    capabilities: registry,
    adapters: adapterRegistry,
    evidence: runtimeEvidence,
    control,
    dbPath: resolvedDbPath,
    runsRoot: resolvedRunsRoot,
    deviceConfigPath,
    nodeId,
  };
}
