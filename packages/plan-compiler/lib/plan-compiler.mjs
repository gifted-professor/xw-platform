import { createHash } from "node:crypto";

export const PARALLELISM_MODES = Object.freeze([
  "single",
  "shardable",
  "replicated",
  "device_affine",
  "quorum_verify",
]);

const COMPLETION_TO_WAIT = Object.freeze({
  all_success: "all",
  minimum_success: "minimum",
  quorum: "quorum",
  first_success: "first",
  best_effort: "best_effort",
});

const FORBIDDEN_KEY = /lease|transport|payment/i;

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

function rejectForbiddenFields(value, path) {
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key)) {
      codedError("PLAN_FORBIDDEN_FIELD", `plan inputs must not carry ${path}.${key}`);
    }
    rejectForbiddenFields(nested, `${path}.${key}`);
  }
}

function compliantDevices(spec, devices) {
  const requirements = spec.deviceRequirements || {};
  return devices.filter(
    (device) =>
      device &&
      typeof device.deviceId === "string" &&
      device.status !== "offline" &&
      device.online !== false &&
      (!requirements.profiles || requirements.profiles.includes(device.profile)),
  );
}

function buildShardInputs(mode, spec, goal) {
  switch (mode) {
    case "single":
      return [{ input: goal.input ?? {} }];
    case "shardable": {
      const variants = goal.variants;
      if (!Array.isArray(variants) || variants.length === 0) {
        codedError("INVALID_PLAN_INPUT", "shardable mode requires a non-empty goal.variants list");
      }
      return variants.map((variant) => ({ input: variant.input ?? variant }));
    }
    case "replicated": {
      const replicas = goal.replicas ?? spec.maxWorkers ?? 1;
      if (!Number.isInteger(replicas) || replicas < 1) {
        codedError("INVALID_PLAN_INPUT", "replicated mode requires a positive integer goal.replicas");
      }
      return Array.from({ length: replicas }, () => ({ input: goal.input ?? {} }));
    }
    case "device_affine": {
      const variants = goal.variants;
      if (!Array.isArray(variants) || variants.length === 0) {
        codedError("INVALID_PLAN_INPUT", "device_affine mode requires goal.variants with deviceId bindings");
      }
      return variants.map((variant) => {
        if (!variant.deviceId) {
          codedError("INVALID_PLAN_INPUT", "device_affine variant is missing deviceId");
        }
        return { input: variant.input ?? {}, boundDeviceId: variant.deviceId };
      });
    }
    case "quorum_verify": {
      const total = spec.quorumTotal;
      if (!Number.isInteger(total) || total < 1) {
        codedError("INVALID_PARALLELISM_SPEC", "quorum_verify requires spec.quorumTotal >= 1");
      }
      return Array.from({ length: total }, () => ({ input: goal.input ?? {} }));
    }
    default:
      codedError("INVALID_PARALLELISM_SPEC", `unknown parallelism mode: ${mode}`);
  }
}

export function compilePlan({ goal, skillVersion, parallelismSpec, availableDevices = [], budget = {} } = {}) {
  if (!goal || typeof goal !== "object") {
    codedError("INVALID_PLAN_INPUT", "compilePlan requires a goal object");
  }
  if (!skillVersion?.skillId || !skillVersion?.skillVersionRef) {
    codedError("INVALID_PLAN_INPUT", "compilePlan requires skillVersion with skillId and skillVersionRef");
  }
  const spec = parallelismSpec ?? { mode: "single", completionPolicy: "all_success" };
  const mode = spec.mode ?? "single";
  if (!PARALLELISM_MODES.includes(mode)) {
    codedError("INVALID_PARALLELISM_SPEC", `unknown parallelism mode: ${mode}`);
  }
  rejectForbiddenFields(goal, "goal");
  rejectForbiddenFields(spec, "parallelismSpec");
  rejectForbiddenFields(budget, "budget");

  if (spec.maxWorkers != null && (!Number.isInteger(spec.maxWorkers) || spec.maxWorkers < 1)) {
    codedError("INVALID_PARALLELISM_SPEC", "maxWorkers must be a positive integer");
  }
  if (budget.maxWorkers != null && (!Number.isInteger(budget.maxWorkers) || budget.maxWorkers < 1)) {
    codedError("INVALID_PLAN_INPUT", "budget.maxWorkers must be a positive integer");
  }
  if (spec.completionPolicy === "minimum_success" && !Number.isInteger(spec.minimumSuccessfulShards)) {
    codedError("INVALID_PARALLELISM_SPEC", "minimum_success requires minimumSuccessfulShards");
  }
  if (spec.completionPolicy === "quorum" && (!Number.isInteger(spec.quorumOf) || !Number.isInteger(spec.quorumTotal))) {
    codedError("INVALID_PARALLELISM_SPEC", "quorum requires quorumOf and quorumTotal");
  }
  if (mode === "quorum_verify" && Number.isInteger(spec.quorumOf) && spec.quorumOf > spec.quorumTotal) {
    codedError("INVALID_PARALLELISM_SPEC", "quorumOf must not exceed quorumTotal");
  }

  const shardSeeds = buildShardInputs(mode, spec, goal);
  if (
    spec.completionPolicy === "minimum_success" &&
    spec.minimumSuccessfulShards > shardSeeds.length
  ) {
    codedError(
      "INVALID_PARALLELISM_SPEC",
      `minimumSuccessfulShards ${spec.minimumSuccessfulShards} exceeds shard count ${shardSeeds.length}`,
    );
  }

  if (mode === "device_affine" && spec.reassignable === true) {
    codedError("INVALID_PARALLELISM_SPEC", "device_affine forces reassignable=false");
  }
  const online = compliantDevices(spec, availableDevices);
  const minWorkers = spec.minWorkers ?? 1;
  if (online.length < minWorkers) {
    codedError(
      "INSUFFICIENT_DEVICES",
      `need ${minWorkers} compliant device(s), only ${online.length} available`,
    );
  }

  const onlineIds = new Set(online.map((device) => device.deviceId));
  const caps = [spec.maxWorkers ?? Infinity, online.length, shardSeeds.length, budget.maxWorkers ?? Infinity];
  const selectedWorkers = mode === "single" ? 1 : Math.min(...caps);
  const requestedWorkers =
    mode === "single" ? 1 : Math.min(spec.maxWorkers ?? shardSeeds.length, shardSeeds.length, budget.maxWorkers ?? Infinity);

  const planRunId = `plan_${digest({ goal, skillId: skillVersion.skillId, skillVersionRef: skillVersion.skillVersionRef, spec, mode }).slice(0, 16)}`;
  const workers = online.slice(0, selectedWorkers);
  const shards = shardSeeds.map((seed, index) => {
    const shard = {
      shardRunId: `${planRunId}_shard_${index + 1}`,
      input: seed.input,
    };
    if (mode === "device_affine") {
      // Bound at compile time; an offline bound device stays unplaced, never re-bound.
      shard.assignedDeviceId = onlineIds.has(seed.boundDeviceId) ? seed.boundDeviceId : null;
    } else if (workers.length > 0) {
      shard.assignedDeviceId = workers[index % workers.length].deviceId;
    }
    return shard;
  });

  const completionPolicy = spec.completionPolicy ?? "all_success";
  const join = { waitPolicy: COMPLETION_TO_WAIT[completionPolicy] ?? "all" };
  if (completionPolicy === "minimum_success") join.minimum = spec.minimumSuccessfulShards;
  if (completionPolicy === "quorum") join.minimum = spec.quorumOf;

  const plan = {
    schemaId: "xw.execution.plan.v1",
    schemaVersion: 1,
    planRunId,
    skillId: skillVersion.skillId,
    skillVersionRef: skillVersion.skillVersionRef,
    requestedWorkers,
    selectedWorkers,
    shards,
    join,
    reduce: spec.merge ?? { strategy: "identity" },
  };
  if (spec.verification) plan.verification = spec.verification;
  if (mode === "quorum_verify" && !plan.verification) {
    plan.verification = { mode: "quorum_compare" };
  }
  return deepFreeze(plan);
}
