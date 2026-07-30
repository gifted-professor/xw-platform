import { ControlPlaneError } from "./errors.mjs";
import { fingerprint } from "./canonical.mjs";

// DiscoverySessionRuntime is deliberately lifecycle-only. It owns no primitive, job,
// observation, or Mission-compile path; those stay deferred to later Tasks.
export class DiscoverySessionRuntime {
  constructor({ state, authorityNodeId, gates, leaseTtlMs = 60000 } = {}) {
    if (!state || typeof state.openDiscoveryRunStorage !== "function") throw new TypeError("DiscoverySessionRuntime requires DiscoveryRun StateStore support");
    this.state = state;
    this.authorityNodeId = authorityNodeId;
    this.gates = typeof gates === "function" ? gates : () => ({});
    this.leaseTtlMs = leaseTtlMs;
  }

  openDiscoveryRun({ grantId, controllerAgent, placement = {}, registrySnapshot = null }) {
    const grant = this.state.getDelegationGrantRecord(grantId);
    if (!grant) throw new ControlPlaneError("GRANT_NOT_FOUND", "unknown Discovery Grant", { status: 404 });
    return this.state.openDiscoveryRunStorage({
      grantId,
      grantHash: grant.grantHash,
      controllerAgent,
      authorityNodeId: this.authorityNodeId,
      placement,
      registrySnapshot,
      gates: this.gates(),
      ttlMs: this.leaseTtlMs,
    });
  }

  heartbeatDiscoveryRun({ discoveryRunId, tuple }) {
    return this.state.heartbeatDiscoveryRunStorage({ discoveryRunId, tuple, gates: this.gates(), ttlMs: this.leaseTtlMs });
  }

  sealDiscoveryRun({ discoveryRunId, tuple }) {
    return this.state.sealDiscoveryRunStorage({ discoveryRunId, tuple, gates: this.gates() });
  }

  abortDiscoveryRun({ discoveryRunId, tuple, reason }) {
    return this.state.abortDiscoveryRunStorage({ discoveryRunId, tuple, reason, gates: this.gates() });
  }

  executeDiscoveryPrimitive({ discoveryRunId, tuple, token, primitive, idempotencyKey, envelope }) {
    const run = this.state.getDiscoveryRun(discoveryRunId);
    if (!run || run.status !== "running") throw new ControlPlaneError("DISCOVERY_RUN_NOT_ACTIVE", "DiscoveryRun is not running", { status: 409 });
    return this.state.reserveDiscoveryPrimitiveStorage({
      discoveryRunId,
      tuple,
      token,
      primitive,
      idempotencyKey,
      payloadHash: fingerprint({ primitive, envelope }),
      gates: this.gates(),
    });
  }

  ingestDiscoveryObservation(input) {
    return this.state.ingestDiscoveryObservation({ ...input, gates: this.gates() });
  }

  getDiscoveryRun(discoveryRunId) {
    return this.state.getDiscoveryRun(discoveryRunId);
  }
}
