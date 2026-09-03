/**
 * xhs-collect-loop.mjs — continuous read-only collection loop coordinator.
 *
 * Fans out N batches × K devices; every device is its own Control Plane
 * endpoint (one CP process per alias), so true concurrency comes from the
 * fleet layout, not from a parallel executor. Each device-batch unit is one
 * server-side recipe run (POST /control/v1/recipe-runs) — the same transport
 * that produced the 2026-09-02 4/4 note.read baseline — so step assertions,
 * verification and lease release stay inside the CP TCB.
 *
 * Failure policy:
 *   - transient (FAILED / thrown / not SUCCEEDED) → retry same batch, ≤ maxRetries
 *   - REPAIR_REQUIRED → no retry; device isolated for the rest of the run
 *   - lease dirty after a batch (listLeases non-empty) → device fenced
 *   - risk-control signal (captcha / rate-limit keywords in receipt) → full stop
 *
 * Pure orchestration: every dependency (cp objects, clock, sleep, trace
 * writer) is injected. Console is not used here.
 */
import { createHash, randomUUID } from "node:crypto";

import { defaultRoutineRunStoreRoot, writeRoutineTrace } from "./xhs-routine-run-store.mjs";

export const COLLECT_LOOP_PLAN_TEMPLATE = "xhs.collect-loop.v1";

/** Full-stop signals: captcha / slider / rate-limit / abnormal-traffic prompts. */
export const COLLECT_RISK_PATTERNS = [
  "验证码",
  "captcha",
  "滑块",
  "安全验证",
  "操作太频繁",
  "操作过于频繁",
  "异常流量",
];

function loopError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, details });
}

function sha256Hex(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function newExecutionRunId() {
  return `xe_${randomUUID().replace(/-/g, "")}`;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Classify one public recipe run (xw.single-device.recipe-run.v1) into a
 * collect-loop outcome. Risk-control scan runs first: a risk prompt in the
 * receipt must stop the whole fleet even if the step somehow SUCCEEDED.
 */
export function classifyRecipeRun(run, { riskPatterns = COLLECT_RISK_PATTERNS } = {}) {
  if (!run || typeof run !== "object") {
    return { outcome: "transient", reason: "RECIPE_RUN_MISSING" };
  }
  const haystack = JSON.stringify(run.receipt ?? run);
  const matched = riskPatterns.find((pattern) => haystack.includes(pattern));
  if (matched) {
    return { outcome: "risk-control", reason: "RISK_SIGNAL_MATCHED", signal: matched };
  }
  const status = String(run.status || "").toUpperCase();
  if (status === "SUCCEEDED" && run.receipt?.ok === true && run.receipt?.serverVerified === true) {
    return { outcome: "ok", reason: null };
  }
  if (status === "REPAIR_REQUIRED") {
    return { outcome: "repair", reason: run.receipt?.failedStepId || "REPAIR_REQUIRED" };
  }
  return { outcome: "transient", reason: run.receipt?.error?.code || run.error?.code || `STATUS_${status || "UNKNOWN"}` };
}

function normalizeLoopbackBase(value, label = "controlBase") {
  const base = String(value || "").trim().replace(/\/$/, "");
  let parsed;
  try {
    parsed = new URL(base);
  } catch {
    throw loopError("COLLECT_ENDPOINT_INVALID", `${label} must be an absolute http URL`, { value });
  }
  if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)) {
    throw loopError("COLLECT_ENDPOINT_INVALID", `${label} must be a loopback HTTP origin`, { value: base });
  }
  return base;
}

/**
 * Minimal HTTP adapter onto the per-alias Control Plane recipe-run surface.
 * POST /control/v1/recipe-runs is synchronous server-side (long timeout);
 * GET /control/v1/leases is the authoritative post-batch cleanliness probe.
 */
export function createHttpCollectCp({
  controlBase,
  fetchImpl = globalThis.fetch,
  timeoutMs = 300_000,
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("createHttpCollectCp requires fetch");
  const base = normalizeLoopbackBase(controlBase);

  async function request(path, init) {
    let response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        ...init,
        headers: { "content-type": "application/json", ...(init?.headers || {}) },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw loopError("COLLECT_CP_UNREACHABLE", `control plane request failed: ${error?.message || error}`, {
        controlBase: base,
        path,
      });
    }
    const text = await response.text();
    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { raw: text.slice(0, 400) };
    }
    if (!response.ok) {
      const error = loopError(
        payload?.error?.code || "COLLECT_CP_REJECTED",
        payload?.error?.message || `control plane rejected ${path} (${response.status})`,
        { controlBase: base, path, status: response.status },
      );
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  return {
    controlBase: base,
    async runRecipe({ recipeId, revision, params, actorId }) {
      if (!recipeId) throw loopError("COLLECT_RECIPE_ID_REQUIRED", "runRecipe requires recipeId");
      const payload = await request("/control/v1/recipe-runs", {
        method: "POST",
        body: JSON.stringify({
          actorId: String(actorId || "agent:xhs-collect-loop"),
          dryRun: false,
          params: isPlainObject(params) ? params : {},
          recipeId,
          ...(revision == null ? {} : { revision: Number(revision) }),
        }),
      });
      return payload?.recipeRun ?? payload;
    },
    async listLeases() {
      const payload = await request("/control/v1/leases", { method: "GET" });
      return Array.isArray(payload?.leases) ? payload.leases : [];
    },
  };
}

export function createCollectLoop({
  devices,
  recipeId = "xhs.note.read.fixed",
  revision = null,
  params = {},
  actorId = "agent:xhs-collect-loop",
  batches,
  interBatchMs = 0,
  maxRetries = 1,
  riskPatterns = COLLECT_RISK_PATTERNS,
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
  traceRoot = defaultRoutineRunStoreRoot(),
  writeTrace = writeRoutineTrace,
  onBatch = null,
} = {}) {
  if (!Array.isArray(devices) || devices.length === 0) {
    throw loopError("COLLECT_DEVICES_INVALID", "collect loop requires at least one device");
  }
  for (const device of devices) {
    if (!device?.alias || typeof device.cp?.runRecipe !== "function" || typeof device.cp?.listLeases !== "function") {
      throw loopError("COLLECT_DEVICE_INVALID", "each device needs alias + cp{runRecipe,listLeases}");
    }
  }
  const batchCount = Number(batches);
  if (!Number.isInteger(batchCount) || batchCount < 1) {
    throw loopError("COLLECT_BATCHES_INVALID", "batches must be a positive integer");
  }
  if (!Number.isInteger(Number(maxRetries)) || Number(maxRetries) < 0) {
    throw loopError("COLLECT_RETRIES_INVALID", "maxRetries must be a non-negative integer");
  }

  const aliases = devices.map((device) => String(device.alias));
  const config = {
    recipeId: String(recipeId),
    revision: revision == null ? null : Number(revision),
    params: { ...params },
    actorId: String(actorId),
    batches: batchCount,
    interBatchMs: Number(interBatchMs) || 0,
    maxRetries: Number(maxRetries),
    aliases,
  };
  const planHash = sha256Hex(JSON.stringify(config));
  const plan = {
    planHash,
    template: COLLECT_LOOP_PLAN_TEMPLATE,
    recipeId: config.recipeId,
    revision: config.revision,
    batches: config.batches,
    interBatchMs: config.interBatchMs,
    maxRetries: config.maxRetries,
    aliases,
    actorId: config.actorId,
  };

  return {
    plan,
    async run() {
      const runStartedAt = now();
      const isolated = new Set();
      const fenced = new Set();
      const deviceStats = new Map(aliases.map((alias) => [alias, {
        succeeded: 0, failed: 0, isolated: 0, fenced: 0, attempts: 0,
      }]));
      const failureCounts = {
        transientRetried: 0, transientFailed: 0, repairIsolated: 0, leaseFenced: 0,
      };
      const batchExecutionRunIds = [];
      const persistenceErrors = [];
      let stoppedBy = null;
      let riskSignal = null;

      function persist(record) {
        if (!traceRoot) return;
        try {
          writeTrace({ plan, routineRun: record, recordedAt: new Date(now()).toISOString(), root: traceRoot });
        } catch (error) {
          persistenceErrors.push({ executionRunId: record.executionRunId, code: error?.code || "PERSIST_FAILED" });
        }
      }

      async function runDeviceInBatch(device, batchIndex, record) {
        const alias = String(device.alias);
        const entry = { alias, attempts: 0, ok: false, status: null, verifiedSteps: 0, error: null };
        record.devices.push(entry);
        if (isolated.has(alias) || fenced.has(alias)) {
          entry.skipped = true;
          entry.reason = isolated.has(alias) ? "REPAIR_ISOLATED" : "LEASE_FENCED";
          return;
        }
        for (let attempt = 1; attempt <= Number(maxRetries) + 1; attempt += 1) {
          if (stoppedBy) return;
          entry.attempts = attempt;
          deviceStats.get(alias).attempts += 1;
          let run = null;
          let thrown = null;
          try {
            run = await device.cp.runRecipe({ recipeId, revision, params, actorId, batchIndex, attempt });
          } catch (error) {
            thrown = error;
          }
          const verdict = thrown
            ? { outcome: "transient", reason: thrown.code || "RECIPE_RUN_ERROR" }
            : classifyRecipeRun(run, { riskPatterns });
          entry.status = run?.status ?? (thrown ? "THROWN" : "UNKNOWN");
          entry.verifiedSteps = Number(run?.receipt?.verifiedSteps ?? 0);
          entry.error = thrown ? String(thrown.code || thrown.message || thrown) : (run?.error?.code ?? verdict.reason);
          if (verdict.outcome === "risk-control") {
            entry.ok = false;
            stoppedBy = "risk-control";
            riskSignal = { alias, signal: verdict.signal, reason: verdict.reason, batchIndex };
            return;
          }
          if (verdict.outcome === "ok") {
            entry.ok = true;
            deviceStats.get(alias).succeeded += 1;
            return;
          }
          if (verdict.outcome === "repair") {
            entry.ok = false;
            isolated.add(alias);
            failureCounts.repairIsolated += 1;
            deviceStats.get(alias).isolated += 1;
            return;
          }
          // transient: retry within the same batch while attempts remain
          if (attempt <= Number(maxRetries)) {
            failureCounts.transientRetried += 1;
            continue;
          }
          entry.ok = false;
          deviceStats.get(alias).failed += 1;
          failureCounts.transientFailed += 1;
        }
      }

      const batchRecords = [];
      for (let batchIndex = 1; batchIndex <= batchCount && !stoppedBy; batchIndex += 1) {
        const batchStartedAt = now();
        const record = {
          executionRunId: newExecutionRunId(),
          routineRunId: `cl_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
          planHash,
          alias: aliases.join("+"),
          status: "RUNNING",
          serverVerified: false,
          devices: [],
          receipt: { batchIndex, leaseCheck: [] },
        };
        await Promise.all(devices.map((device) => runDeviceInBatch(device, batchIndex, record)));
        const leaseCheck = await Promise.allSettled(devices.map(async (device) => {
          const leases = await device.cp.listLeases();
          return { alias: String(device.alias), activeLeases: Array.isArray(leases) ? leases.length : null };
        }));
        for (const result of leaseCheck) {
          if (result.status !== "fulfilled") {
            record.receipt.leaseCheck.push({ alias: null, activeLeases: null, error: String(result.reason?.code || result.reason) });
            continue;
          }
          const { alias, activeLeases } = result.value;
          record.receipt.leaseCheck.push(result.value);
          if (activeLeases !== null && activeLeases > 0 && !isolated.has(alias) && !fenced.has(alias)) {
            fenced.add(alias);
            failureCounts.leaseFenced += 1;
            deviceStats.get(alias).fenced += 1;
            record.receipt.leaseDirty = true;
          }
        }
        const anyEligible = devices.some((device) => {
          const alias = String(device.alias);
          return !isolated.has(alias) && !fenced.has(alias);
        });
        record.receipt.wallMs = now() - batchStartedAt;
        record.serverVerified = record.devices.length > 0 && record.devices.every((entry) => entry.ok || entry.skipped);
        record.status = stoppedBy === "risk-control" ? "BLOCKED" : (record.serverVerified ? "SUCCEEDED" : "PARTIAL");
        record.finishedAt = new Date(now()).toISOString();
        batchExecutionRunIds.push(record.executionRunId);
        persist(record);
        batchRecords.push(record);
        if (typeof onBatch === "function") {
          try {
            onBatch({ batchIndex, wallMs: record.receipt.wallMs, status: record.status, devices: record.devices });
          } catch {
            /* progress reporting must never break the loop */
          }
        }
        if (stoppedBy) break;
        if (!anyEligible) {
          stoppedBy = "all-devices-isolated";
          break;
        }
        if (batchIndex < batchCount) {
          await sleepFn(Number(interBatchMs) || 0);
        }
      }

      const totalWallMs = now() - runStartedAt;
      const notesSucceeded = aliases.reduce((sum, alias) => sum + deviceStats.get(alias).succeeded, 0);
      const summary = {
        schemaId: "xw.xhs.collect-loop-summary.v1",
        config,
        batchesPlanned: batchCount,
        batchesExecuted: batchRecords.length,
        notesSucceeded,
        totalWallMs,
        notesPerMinute: totalWallMs > 0 ? Number((notesSucceeded / (totalWallMs / 60_000)).toFixed(3)) : null,
        notesPerHour: totalWallMs > 0 ? Math.round(notesSucceeded / (totalWallMs / 3_600_000)) : null,
        stoppedBy,
        riskSignal,
        failureCounts,
        devices: Object.fromEntries(deviceStats.entries()),
        batchExecutionRunIds,
        persistenceErrors,
      };
      if (traceRoot) {
        persist({
          executionRunId: newExecutionRunId(),
          routineRunId: `cl_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
          planHash,
          alias: aliases.join("+"),
          status: stoppedBy ? "BLOCKED" : "COMPLETED",
          serverVerified: !stoppedBy && failureCounts.transientFailed === 0 && failureCounts.repairIsolated === 0,
          receipt: { kind: "summary", summary },
        });
      }
      return summary;
    },
  };
}