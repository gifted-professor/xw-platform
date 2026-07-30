import { ControlPlaneError } from "./errors.mjs";

const TUPLE_FIELDS = ["missionId", "deviceRunId", "sessionId", "controllerAgent", "controllerEpoch"];

// DeviceRunRuntime owns the Mission-bound control layer: it authorizes the controller
// against the immutable Mission, opens one atomic DeviceRun (placement + lease + Session
// + fencing), validates the complete control tuple on every command, server-side
// heartbeats the run, and records control loss as a non-resumable pause. It reuses the
// shared StateStore for all durable state — it introduces no parallel lease, session,
// readiness, or evidence system.
export class DeviceRunRuntime {
  constructor({
    state,
    missions,
    authorityNodeId = "DESKTOP-3I1EVHE",
    leaseTtlMs = 60000,
    leaseHeartbeatMs = 10000,
    now = Date.now,
  }) {
    if (!state) throw new TypeError("DeviceRunRuntime requires a StateStore");
    if (!missions) throw new TypeError("DeviceRunRuntime requires a MissionRuntime");
    if (!Number.isFinite(leaseTtlMs) || !Number.isFinite(leaseHeartbeatMs)
      || leaseHeartbeatMs <= 0 || leaseHeartbeatMs >= leaseTtlMs) {
      throw new TypeError("leaseHeartbeatMs must be positive and less than leaseTtlMs");
    }
    this.state = state;
    this.missions = missions;
    this.authorityNodeId = authorityNodeId;
    this.leaseTtlMs = leaseTtlMs;
    this.leaseHeartbeatMs = leaseHeartbeatMs;
    this.now = now;
    this.heartbeats = new Map();
  }

  openDeviceRun({ missionId, controllerAgent, placement = {}, registrySnapshot = null }) {
    if (typeof missionId !== "string" || missionId.trim() === "") {
      throw new ControlPlaneError("MISSION_REQUIRED", "missionId is required", { status: 400 });
    }
    if (typeof controllerAgent !== "string" || controllerAgent.trim() === "") {
      throw new ControlPlaneError("CONTROLLER_REQUIRED", "controllerAgent is required", { status: 400 });
    }
    const mission = this.missions.requireActiveMission(missionId);
    if (!mission.controllers.includes(controllerAgent)) {
      throw new ControlPlaneError(
        "CONTROLLER_NOT_AUTHORIZED",
        "controller is not on the Mission allow-list",
        { status: 403, details: { controllerAgent, missionId } },
      );
    }
    return this.state.openDeviceRunStorage({
      missionId,
      missionHash: mission.missionHash,
      missionVersion: mission.version,
      controllerAgent,
      authorityNodeId: this.authorityNodeId,
      placement,
      registrySnapshot,
      ttlMs: this.leaseTtlMs,
    });
  }

  // Validates the complete fencing tuple against the current DeviceRun binding. A token
  // never replaces any element; a command missing any member, or carrying a stale epoch or
  // wrong controller, is rejected. Returns the current device run on success.
  assertControlTuple(tuple) {
    if (!tuple || typeof tuple !== "object") {
      throw new ControlPlaneError("CONTROL_TUPLE_INCOMPLETE", "control tuple is required", { status: 400 });
    }
    for (const field of TUPLE_FIELDS) {
      if (tuple[field] === undefined || tuple[field] === null || tuple[field] === "") {
        throw new ControlPlaneError("CONTROL_TUPLE_INCOMPLETE", `control tuple missing ${field}`, {
          status: 400, details: { field },
        });
      }
    }
    if (tuple.jobId !== undefined && (typeof tuple.jobId !== "string" || tuple.jobId.trim() === "")) {
      throw new ControlPlaneError("CONTROL_TUPLE_INCOMPLETE", "jobId must be a non-empty string when present", {
        status: 400,
      });
    }
    const run = this.state.getDeviceRun(tuple.deviceRunId);
    if (!run) {
      throw new ControlPlaneError("DEVICE_RUN_NOT_FOUND", `unknown device run ${tuple.deviceRunId}`, {
        status: 404,
      });
    }
    if (run.missionId !== tuple.missionId) {
      throw new ControlPlaneError("MISSION_MISMATCH", "tuple missionId does not match the device run", {
        status: 409, details: { expected: run.missionId, got: tuple.missionId },
      });
    }
    if (run.sessionId !== tuple.sessionId) {
      throw new ControlPlaneError("SESSION_MISMATCH", "tuple sessionId does not match the device run", {
        status: 409, details: { expected: run.sessionId, got: tuple.sessionId },
      });
    }
    if (run.controllerAgent !== tuple.controllerAgent) {
      throw new ControlPlaneError("CONTROLLER_NOT_AUTHORIZED", "tuple controllerAgent does not match the device run", {
        status: 403,
      });
    }
    if (run.controllerEpoch !== tuple.controllerEpoch) {
      throw new ControlPlaneError("EPOCH_MISMATCH", "stale or future controller epoch", {
        status: 409, details: { expected: run.controllerEpoch, got: tuple.controllerEpoch },
      });
    }
    // The mission and parent Grant may have expired or been revoked between open and this
    // command.  Reuse MissionRuntime's durable live-authority check rather than the stale
    // public row, so every tuple boundary carries the same validity semantics as ECP.
    const mission = this.missions.requireActiveMission(tuple.missionId);
    if (!mission.controllers.includes(tuple.controllerAgent)) {
      throw new ControlPlaneError("CONTROLLER_NOT_AUTHORIZED", "controller is no longer authorized", { status: 403 });
    }
    return run;
  }

  heartbeatDeviceRun(deviceRunId, token) {
    const run = this.state.getDeviceRun(deviceRunId);
    if (!run) throw new ControlPlaneError("DEVICE_RUN_NOT_FOUND", `unknown device run ${deviceRunId}`, { status: 404 });
    // validate the lease token before touching it
    const lease = this.state.validateLease(run.leaseId, token);
    if (lease.deviceId !== run.deviceId) {
      throw new ControlPlaneError("LEASE_DEVICE_MISMATCH", "lease does not own the run device", { status: 409 });
    }
    return this.state.heartbeatDeviceRunStorage(deviceRunId, this.leaseTtlMs);
  }

  markControlLost(deviceRunId, { reason = null } = {}) {
    const run = this.state.getDeviceRun(deviceRunId);
    if (!run) throw new ControlPlaneError("DEVICE_RUN_NOT_FOUND", `unknown device run ${deviceRunId}`, { status: 404 });
    // control loss is recorded before any later recheck; the effect is never auto-resumed.
    return this.state.updateDeviceRunPhase(deviceRunId, "paused_control_lost", {
      outcome: reason ? `CONTROL_LOST:${reason}` : "CONTROL_LOST",
    });
  }

  // Server-side runner heartbeat: the runner does not depend on a caller remembering to
  // heartbeat. Used by ControlPlane once the control loop is started.
  startRunnerHeartbeat(deviceRunId, token) {
    if (this.heartbeats.has(deviceRunId)) return this.heartbeats.get(deviceRunId);
    const interval = setInterval(() => {
      try {
        this.heartbeatDeviceRun(deviceRunId, token);
      } catch {
        this.stopRunnerHeartbeat(deviceRunId);
      }
    }, this.leaseHeartbeatMs);
    interval.unref?.();
    this.heartbeats.set(deviceRunId, interval);
    return interval;
  }

  stopRunnerHeartbeat(deviceRunId) {
    const interval = this.heartbeats.get(deviceRunId);
    if (interval) {
      clearInterval(interval);
      this.heartbeats.delete(deviceRunId);
    }
  }

  listDeviceRuns({ missionId, phase } = {}) {
    return this.state.listDeviceRuns({ missionId, phase });
  }

  getDeviceRun(deviceRunId) {
    return this.state.getDeviceRun(deviceRunId);
  }
}
