import { ControlPlaneError } from "./errors.mjs";

const ROUTABLE_AVAILABILITY = new Set(["implemented", "approval_gated"]);
const PLACEMENT_KEYS = new Set(["nodeId", "physicalLabel", "requiredTags"]);

function requireString(value, path) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ControlPlaneError("PLACEMENT_CONFLICT", `${path} must be a non-empty string`, { status: 409 });
  }
  return value.trim();
}

export function normalizeRoutingProfile(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("routingProfile must be an object");
  }
  const tags = value.tags ?? [];
  const capabilityIds = value.capabilityIds ?? [];
  if (!Array.isArray(tags) || tags.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new TypeError("routingProfile.tags must contain non-empty strings");
  }
  if (!Array.isArray(capabilityIds) || capabilityIds.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new TypeError("routingProfile.capabilityIds must contain non-empty strings");
  }
  return {
    enabled: value.enabled === true,
    tags: [...new Set(tags.map((item) => item.trim()))].sort(),
    capabilityIds: [...new Set(capabilityIds.map((item) => item.trim()))].sort(),
  };
}

export function normalizePlacementRequest({ deviceId = null, placement = {} } = {}) {
  if (deviceId !== null && (typeof deviceId !== "string" || deviceId.trim() === "")) {
    throw new ControlPlaneError("PLACEMENT_CONFLICT", "deviceId must be a non-empty string", { status: 409 });
  }
  if (!placement || typeof placement !== "object" || Array.isArray(placement)) {
    throw new ControlPlaneError("PLACEMENT_CONFLICT", "placement must be an object", { status: 409 });
  }
  for (const key of Object.keys(placement)) {
    if (!PLACEMENT_KEYS.has(key)) {
      throw new ControlPlaneError("PLACEMENT_CONFLICT", `unknown placement field ${key}`, { status: 409 });
    }
  }
  const normalized = {};
  if (placement.nodeId !== undefined) normalized.nodeId = requireString(placement.nodeId, "placement.nodeId");
  if (placement.physicalLabel !== undefined) {
    normalized.physicalLabel = requireString(placement.physicalLabel, "placement.physicalLabel");
  }
  if (placement.requiredTags !== undefined) {
    if (!Array.isArray(placement.requiredTags)
      || placement.requiredTags.some((item) => typeof item !== "string" || item.trim() === "")) {
      throw new ControlPlaneError(
        "PLACEMENT_CONFLICT",
        "placement.requiredTags must contain non-empty strings",
        { status: 409 },
      );
    }
    normalized.requiredTags = [...new Set(placement.requiredTags.map((item) => item.trim()))].sort();
  }
  if (deviceId && Object.keys(normalized).length > 0) {
    throw new ControlPlaneError(
      "PLACEMENT_CONFLICT",
      "deviceId cannot be combined with placement selectors",
      { status: 409 },
    );
  }
  return {
    mode: deviceId ? "pinned" : "automatic",
    deviceId: deviceId ? deviceId.trim() : null,
    placement: normalized,
  };
}

export function assertCapabilityRoutable(capability, { invocation = "job", canary = false } = {}) {
  const availability = capability.availability ?? "implemented";
  const canaryRoutable = availability === "canary_only"
    && ["session", "session_action"].includes(invocation)
    && canary;
  if (!ROUTABLE_AVAILABILITY.has(availability) && !canaryRoutable) {
    throw new ControlPlaneError(
      "NO_ELIGIBLE_DEVICE",
      `${capability.id} is not available for routing`,
      { status: 409, details: { capabilityId: capability.id, availability } },
    );
  }
}

export function selectPlacement({
  authorityNodeId,
  capability,
  placementRequest,
  candidates,
  invocation = "job",
  canary = false,
  now = Date.now(),
  advisory = false,
}) {
  assertCapabilityRoutable(capability, { invocation, canary });
  const requestedNodeId = placementRequest.placement.nodeId || authorityNodeId;
  if (requestedNodeId !== authorityNodeId) {
    throw new ControlPlaneError(
      "NODE_UNAVAILABLE",
      `node ${requestedNodeId} is not a local dispatch target`,
      { status: 409, details: { nodeId: requestedNodeId } },
    );
  }

  const requiredTags = placementRequest.placement.requiredTags || [];
  const matching = candidates.filter((candidate) => {
    const profile = candidate.routingProfile;
    if (candidate.nodeId !== requestedNodeId || !candidate.online || candidate.quarantined) return false;
    if (!profile.enabled || !profile.capabilityIds.includes(capability.id)) return false;
    if (placementRequest.deviceId && candidate.deviceId !== placementRequest.deviceId) return false;
    if (placementRequest.placement.physicalLabel
      && candidate.physicalLabel !== placementRequest.placement.physicalLabel) return false;
    if (!requiredTags.every((tag) => profile.tags.includes(tag))) return false;
    return true;
  });
  const acquiringSession = invocation === "session";
  const eligible = acquiringSession
    ? matching.filter((candidate) => candidate.effectiveLoad === 0)
    : matching;

  eligible.sort((left, right) => (
    left.effectiveLoad - right.effectiveLoad
    || left.physicalLabel.localeCompare(right.physicalLabel)
    || left.deviceId.localeCompare(right.deviceId)
  ));
  const selected = eligible[0];
  if (!selected) {
    const code = acquiringSession && matching.length > 0 ? "DEVICE_BUSY" : "NO_ELIGIBLE_DEVICE";
    throw new ControlPlaneError(
      code,
      code === "DEVICE_BUSY" ? "all eligible devices are busy" : "no device satisfies the placement request",
      {
        status: code === "DEVICE_BUSY" ? 423 : 409,
        details: { capabilityId: capability.id, nodeId: requestedNodeId },
      },
    );
  }

  return {
    mode: placementRequest.mode,
    decision: selected.effectiveLoad > 0 && invocation !== "session_action" ? "queue" : "dispatchable",
    selectedNodeId: selected.nodeId,
    selectedDeviceId: selected.deviceId,
    selectedDevice: {
      deviceId: selected.deviceId,
      alias: selected.alias,
      physicalLabel: selected.physicalLabel,
      nodeId: selected.nodeId,
    },
    queueDepth: selected.pendingJobs,
    waitingApproval: selected.waitingApproval,
    activeLease: selected.activeLease,
    requiredResources: [...capability.resources],
    selector: placementRequest.placement,
    assignedAt: new Date(now).toISOString(),
    advisory,
    ...(invocation === "session_action" ? { reusesSessionLease: true } : {}),
  };
}
