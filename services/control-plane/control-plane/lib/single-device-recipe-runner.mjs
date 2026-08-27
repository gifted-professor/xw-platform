/**
 * single-device-recipe-runner.mjs — PR1 Single-Device RPA Recipe Runner.
 *
 * Profile:
 *   alias fixed (default 04; override with XHS_RPA_ALIAS)
 *   maxConcurrentRuns = 1
 *   one Session + interactive Lease for the whole recipe
 *   sequential primitive_steps with sparse assertions
 *   fail → STOP_AND_CAPTURE → REPAIR_REQUIRED
 *
 * Does NOT open ADB/22222. Device I/O goes through injected Control Plane session APIs.
 * DeviceRun/Mission binding is deferred to PR2.
 */
import { randomUUID } from "node:crypto";

import {
  bindRecipeInput,
  computeDescriptorHash,
  isCanonicalV2Recipe,
  evaluateRecipeAssertions,
  executeRecipeInSession,
  planRecipeFromExecutor,
  resolveRecipeExecutor,
  validateRecipeInputParams,
  validateRecipeSteps,
} from "./recipe-interpreter.mjs";
import {
  EXPLORER_CAPABILITY_ID,
  createRecipePrimitiveHandlers,
} from "./recipe-primitive-handlers.mjs";

/** Default dedicated RPA device. Historical canary lore was 01; Single-Device Profile uses 04. */
export const DEFAULT_RPA_ALIAS = "04";

/**
 * Resolve the single-device RPA alias.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string|null} [override]
 */
export function resolveFixedRpaAlias(env = process.env, override = null) {
  const raw = override != null && String(override).trim() !== ""
    ? String(override).trim()
    : String(env.XHS_RPA_ALIAS || DEFAULT_RPA_ALIAS).trim();
  if (!/^(0[1-4])$/.test(raw)) {
    throw new TypeError(`XHS_RPA_ALIAS must be one of 01..04, got ${JSON.stringify(raw)}`);
  }
  return raw;
}

/** Runtime default from env (XHS_RPA_ALIAS) or DEFAULT_RPA_ALIAS. */
export const FIXED_ALIAS = resolveFixedRpaAlias();

export const LIVE_RECIPE_STATUSES = Object.freeze(["canary_only", "implemented"]);
/** canary mode additionally permits server-extras `candidate` recipes (04-only, R0). */
export const CANARY_RECIPE_STATUSES = Object.freeze(["candidate", ...LIVE_RECIPE_STATUSES]);

export const RECIPE_RUN_STATUSES = Object.freeze([
  "PENDING",
  "ACQUIRING",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "REPAIR_REQUIRED",
  "CANCELLED",
]);

function err(code, message, status = 400, details = {}) {
  const e = new Error(message);
  e.code = code;
  e.status = status;
  e.details = details;
  return e;
}

function isObject(v) {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function nowIso(clock = () => Date.now()) {
  return new Date(clock()).toISOString();
}

function publicRun(run) {
  if (!run) return null;
  const {
    sessionToken: _t,
    cancelRequested: _c,
    ...safe
  } = run;
  return { ...safe };
}

/**
 * Resolve + gate a sealed recipe for single-device live/plan execution.
 * `fixedAlias` is the runner pin; requested `alias` must match it.
 */
export function resolveLiveRecipe(recipe, {
  alias = null,
  revision = null,
  requireLiveStatus = true,
  fixedAlias = resolveFixedRpaAlias(),
  allowCandidate = false,
} = {}) {
  const pinned = resolveFixedRpaAlias(process.env, fixedAlias);
  const effectiveAlias = alias != null && String(alias).trim() !== "" ? String(alias).trim() : pinned;
  if (!isObject(recipe)) throw err("RECIPE_REQUIRED", "recipe object is required");
  if (typeof recipe.recipeId !== "string" || !recipe.recipeId.trim()) {
    throw err("RECIPE_ID_REQUIRED", "recipe.recipeId is required");
  }
  if (revision != null && recipe.revision !== revision) {
    throw err("RECIPE_REVISION_MISMATCH", `expected revision ${revision}, got ${recipe.revision}`, 409, {
      expected: revision,
      actual: recipe.revision,
    });
  }
  if (requireLiveStatus) {
    const status = String(recipe.status || "").trim();
    const allowed = allowCandidate ? CANARY_RECIPE_STATUSES : LIVE_RECIPE_STATUSES;
    if (!allowed.includes(status)) {
      throw err(
        "RECIPE_STATUS_NOT_LIVE",
        `status ${status || "<empty>"} is not executable (need ${allowed.join("|")})`,
        409,
        { status, canaryMode: allowCandidate },
      );
    }
  }
  if (effectiveAlias !== pinned) {
    throw err("SINGLE_DEVICE_ALIAS_REQUIRED", `PR1 runner fixed alias is ${pinned}`, 403, {
      fixedAlias: pinned,
      alias: effectiveAlias,
    });
  }
  const eligible = Array.isArray(recipe.eligibleAliases)
    ? recipe.eligibleAliases.map(String)
    : [pinned];
  if (!eligible.includes(effectiveAlias)) {
    throw err("RECIPE_ALIAS_NOT_ELIGIBLE", `alias ${effectiveAlias} not in eligibleAliases`, 403, { eligible });
  }

  const profile = isObject(recipe.deviceProfile) ? recipe.deviceProfile : {};
  if (profile.alias != null && String(profile.alias) !== pinned) {
    throw err("DEVICE_PROFILE_ALIAS_MISMATCH", `deviceProfile.alias must be ${pinned}`, 409, {
      fixedAlias: pinned,
      profileAlias: profile.alias,
    });
  }

  const executor = resolveRecipeExecutor(recipe.executor);
  if (executor.kind !== "primitive_steps") {
    throw err(
      "RECIPE_EXECUTOR_UNSUPPORTED",
      "PR1 SingleDeviceRecipeRunner requires executor.kind=primitive_steps",
      400,
    );
  }
  return { recipe, executor, eligible, fixedAlias: pinned };
}

/**
 * Bind input + validate steps (plan-only helper; no device).
 */
export function prepareRecipeSteps(recipe, params = {}) {
  const input = validateRecipeInputParams(recipe.inputSchema, params ?? {});
  const resolved = resolveRecipeExecutor(recipe.executor);
  if (resolved.kind !== "primitive_steps") {
    throw err("RECIPE_EXECUTOR_UNSUPPORTED", "expected primitive_steps");
  }
  const boundSteps = bindRecipeInput(resolved.steps, input);
  const validated = validateRecipeSteps(boundSteps);
  return { input, steps: validated.steps, executor: { kind: "primitive_steps", steps: validated.steps } };
}

export class SingleDeviceRecipeRunner {
  /**
   * @param {{
   *   createSession: Function,
   *   executeSessionAction: Function,
   *   heartbeatSession?: Function,
   *   releaseSession: Function,
   *   resolveRecipe?: (recipeId: string, revision?: number|null) => object|null,
   *   callCapability?: Function|null,
   *   observeForAssert?: Function|null,
   *   fixedAlias?: string,
   *   clock?: () => number,
   *   sleepFn?: (ms: number) => Promise<void>,
   * }} deps
   */
  constructor(deps = {}) {
    if (typeof deps.createSession !== "function") {
      throw new TypeError("SingleDeviceRecipeRunner requires createSession");
    }
    if (typeof deps.executeSessionAction !== "function") {
      throw new TypeError("SingleDeviceRecipeRunner requires executeSessionAction");
    }
    if (typeof deps.releaseSession !== "function") {
      throw new TypeError("SingleDeviceRecipeRunner requires releaseSession");
    }
    this.createSession = deps.createSession;
    this.executeSessionAction = deps.executeSessionAction;
    this.heartbeatSession = typeof deps.heartbeatSession === "function" ? deps.heartbeatSession : null;
    this.releaseSession = deps.releaseSession;
    this.resolveRecipe = typeof deps.resolveRecipe === "function" ? deps.resolveRecipe : null;
    this.callCapability = typeof deps.callCapability === "function" ? deps.callCapability : null;
    this.observeForAssert = typeof deps.observeForAssert === "function" ? deps.observeForAssert : null;
    this.fixedAlias = resolveFixedRpaAlias(process.env, deps.fixedAlias ?? null);
    this.clock = typeof deps.clock === "function" ? deps.clock : () => Date.now();
    this.sleepFn = typeof deps.sleepFn === "function" ? deps.sleepFn : (ms) => new Promise((r) => setTimeout(r, ms));
    /** @type {Map<string, object>} */
    this.runs = new Map();
    this.activeRunId = null;
  }

  listRuns() {
    return [...this.runs.values()].map(publicRun);
  }

  getRun(runId) {
    return publicRun(this.runs.get(runId) || null);
  }

  /**
   * Plan-only: validate + bind + interpreter plan. Never touches device.
   */
  plan({ recipe = null, recipeId = null, revision = null, params = {} } = {}) {
    const sealed = this.#loadRecipe({ recipe, recipeId, revision, requireLiveStatus: false });
    resolveLiveRecipe(sealed, {
      alias: this.fixedAlias,
      fixedAlias: this.fixedAlias,
      revision,
      requireLiveStatus: false,
    });
    const prepared = prepareRecipeSteps(sealed, params);
    const planned = planRecipeFromExecutor(prepared.executor, { live: false });
    return {
      ok: true,
      mode: "plan",
      recipeId: sealed.recipeId,
      revision: sealed.revision,
      alias: this.fixedAlias,
      input: prepared.input,
      steps: prepared.steps,
      plannedCalls: planned.plannedCalls,
      message: planned.message,
    };
  }

  /**
   * Start a live (or dry) recipe run. Live path acquires session and executes steps.
   *
   * @param {{
   *   recipe?: object|null,
   *   recipeId?: string|null,
   *   revision?: number|null,
   *   params?: object,
   *   actorId: string,
   *   dryRun?: boolean,
   *   live?: boolean,
   * }} opts
   */
  async start(opts = {}) {
    const {
      recipe = null,
      recipeId = null,
      revision = null,
      params = {},
      actorId,
      dryRun = false,
      live = !dryRun,
      canaryMode = false,
    } = opts;

    if (typeof actorId !== "string" || !actorId.trim()) {
      throw err("ACTOR_REQUIRED", "actorId is required");
    }
    if (this.activeRunId) {
      const active = this.runs.get(this.activeRunId);
      throw err("RECIPE_RUN_BUSY", "another recipe run is active on this runner", 423, {
        activeRunId: this.activeRunId,
        status: active?.status ?? null,
      });
    }

    const isLive = live && !dryRun;
    // plan §6.2.1: 客户端 inline Recipe 禁 live。配置了服务端 resolveRecipe 时，live run
    // 必须走 recipeId 服务端解析（正式 catalog / 04-only extras），不得接受客户端 inline spec。
    // 无 resolveRecipe 的纯库/测试上下文仍允许 inline（用于离线 live-path 测试）。
    if (isLive && isObject(recipe) && typeof this.resolveRecipe === "function") {
      throw err(
        "INLINE_RECIPE_LIVE_FORBIDDEN",
        "live recipe runs must resolve via server recipeId (inline client recipe rejected)",
        403,
      );
    }

    const loaded = this.#loadRecipe({ recipe, recipeId, revision, requireLiveStatus: isLive, allowCandidate: isLive && canaryMode });
    // descriptor hash：绑定 exact server-sealed spec；客户端不得静默改坐标/步骤。
    // - legacy rh_ spec：仅对服务端封存的 rh_ 哈希做 tamper 校验；占位值只重算覆盖。
    // - canonical-v2 spec (descriptorHashScheme=canonical-v2)：对 64-hex 哈希做
    //   tamper 校验（占位零哈希除外），sealed 用 64-hex，与 Catalog/overlay 字节一致。
    // 不原地改 frozen 入参，用浅拷贝携带 computedHash。
    const computedHash = computeDescriptorHash(loaded);
    const providedHash = typeof loaded.descriptorHash === "string" ? loaded.descriptorHash : null;
    const isV2 = isCanonicalV2Recipe(loaded);
    const PLACEHOLDER_HASH = "0".repeat(64);
    if (providedHash && providedHash !== computedHash && providedHash !== PLACEHOLDER_HASH
        && (providedHash.startsWith("rh_") || isV2)) {
      throw err(
        "RECIPE_DESCRIPTOR_HASH_MISMATCH",
        `descriptorHash tamper: expected ${computedHash}, got ${providedHash}`,
        409,
        { expected: computedHash, actual: providedHash, scheme: isV2 ? "canonical-v2" : "legacy" },
      );
    }
    const sealed = { ...loaded, descriptorHash: computedHash };
    resolveLiveRecipe(sealed, {
      alias: this.fixedAlias,
      fixedAlias: this.fixedAlias,
      revision,
      requireLiveStatus: isLive,
      allowCandidate: isLive && canaryMode,
    });
    const prepared = prepareRecipeSteps(sealed, params);

    const runId = `rr_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const run = {
      schemaId: "xw.single-device.recipe-run.v1",
      recipeRunId: runId,
      recipeId: sealed.recipeId,
      revision: sealed.revision,
      descriptorHash: sealed.descriptorHash ?? null,
      status: "PENDING",
      alias: this.fixedAlias,
      actorId: String(actorId).trim(),
      input: prepared.input,
      steps: prepared.steps.map((s) => ({ id: s.id, kind: s.kind, status: "PENDING" })),
      stepResults: [],
      sessionId: null,
      leaseId: null,
      sessionToken: null,
      deviceId: null,
      createdAt: nowIso(this.clock),
      updatedAt: nowIso(this.clock),
      finishedAt: null,
      receipt: null,
      error: null,
      cancelRequested: false,
    };
    this.runs.set(runId, run);
    this.activeRunId = runId;

    if (dryRun || !live) {
      const planned = executeRecipeInSession({ steps: prepared.steps, live: false });
      run.status = "SUCCEEDED";
      run.finishedAt = nowIso(this.clock);
      run.updatedAt = run.finishedAt;
      run.receipt = this.#buildReceipt(run, {
        mode: "plan",
        ok: true,
        plannedCalls: planned.plannedCalls,
      });
      this.activeRunId = null;
      return publicRun(run);
    }

    try {
      await this.#executeLive(run, sealed, prepared);
    } catch (e) {
      if (run.status === "RUNNING" || run.status === "ACQUIRING" || run.status === "PENDING") {
        run.status = "FAILED";
        run.error = { code: e.code || "RECIPE_RUN_FAILED", message: e.message };
        run.finishedAt = nowIso(this.clock);
        run.updatedAt = run.finishedAt;
        run.receipt = this.#buildReceipt(run, { mode: "live", ok: false });
      }
      this.activeRunId = null;
      await this.#safeRelease(run);
      throw e;
    }

    this.activeRunId = null;
    return publicRun(run);
  }

  async cancel(runId) {
    const run = this.runs.get(runId);
    if (!run) throw err("RECIPE_RUN_NOT_FOUND", `recipe run ${runId} not found`, 404);
    if (["SUCCEEDED", "FAILED", "REPAIR_REQUIRED", "CANCELLED"].includes(run.status)) {
      return publicRun(run);
    }
    run.cancelRequested = true;
    run.status = "CANCELLED";
    run.finishedAt = nowIso(this.clock);
    run.updatedAt = run.finishedAt;
    run.receipt = this.#buildReceipt(run, { mode: "live", ok: false });
    await this.#safeRelease(run);
    if (this.activeRunId === runId) this.activeRunId = null;
    return publicRun(run);
  }

  #loadRecipe({ recipe, recipeId, revision, requireLiveStatus, allowCandidate = false }) {
    if (isObject(recipe)) return recipe;
    if (!recipeId) throw err("RECIPE_ID_REQUIRED", "recipeId or recipe is required");
    if (!this.resolveRecipe) {
      throw err("RECIPE_RESOLVER_MISSING", "no recipe resolver configured", 500);
    }
    const found = this.resolveRecipe(recipeId, revision);
    if (!found) throw err("RECIPE_NOT_FOUND", `recipe ${recipeId} not found`, 404);
    resolveLiveRecipe(found, {
      alias: this.fixedAlias,
      fixedAlias: this.fixedAlias,
      revision,
      requireLiveStatus,
      allowCandidate,
    });
    return found;
  }

  async #executeLive(run, sealed, prepared) {
    run.status = "ACQUIRING";
    run.updatedAt = nowIso(this.clock);

    const session = await this.createSession({
      actorId: run.actorId,
      capabilityId: EXPLORER_CAPABILITY_ID,
      canary: true,
      placement: { alias: this.fixedAlias },
    });

    run.sessionId = session.sessionId;
    run.leaseId = session.leaseId;
    run.sessionToken = session.token;
    run.deviceId = session.deviceId ?? null;
    run.status = "RUNNING";
    run.updatedAt = nowIso(this.clock);

    const handlers = createRecipePrimitiveHandlers({
      executePrimitive: async ({ params, idempotencyKey }) => {
        if (this.heartbeatSession) {
          await this.heartbeatSession(run.sessionId, run.sessionToken);
        }
        return this.executeSessionAction(run.sessionId, run.sessionToken, {
          idempotencyKey,
          capabilityId: EXPLORER_CAPABILITY_ID,
          params,
        });
      },
      callCapability: this.callCapability
        ? async (opts) => this.callCapability({ ...opts, run })
        : null,
      sleepFn: this.sleepFn,
    });

    const sessionHandle = {
      sessionId: run.sessionId,
      leaseId: run.leaseId,
      leased: true,
      token: run.sessionToken,
      deviceId: run.deviceId,
      alias: this.fixedAlias,
    };

    for (let i = 0; i < prepared.steps.length; i++) {
      if (run.cancelRequested) {
        run.status = "CANCELLED";
        break;
      }
      const step = prepared.steps[i];
      const stepRec = {
        recipeRunId: run.recipeRunId,
        recipeId: sealed.recipeId,
        revision: sealed.revision,
        stepId: step.id,
        kind: step.kind,
        index: i,
        status: "RUNNING",
        beforeObservation: null,
        afterObservation: null,
        preAssertions: null,
        postAssertions: null,
        result: null,
        error: null,
        nextStepId: prepared.steps[i + 1]?.id ?? null,
      };
      run.steps[i].status = "RUNNING";
      run.updatedAt = nowIso(this.clock);

      try {
        const needsPre = Array.isArray(step.preAssertions) && step.preAssertions.length > 0;
        const needsPost = Array.isArray(step.postAssertions) && step.postAssertions.length > 0;

        if (needsPre) {
          stepRec.beforeObservation = await this.#observe(sessionHandle, handlers, step.id, "pre");
          const pre = evaluateRecipeAssertions(step.preAssertions, stepRec.beforeObservation);
          stepRec.preAssertions = pre;
          if (!pre.ok) {
            throw err("PRE_ASSERTION_FAILED", `preAssertion failed at ${step.id}`, 409, { results: pre.results });
          }
        }

        const fn = handlers[step.kind];
        if (typeof fn !== "function") {
          throw err("HANDLER_MISSING", `no handler for kind ${step.kind}`, 500);
        }
        const actResult = await fn({
          session: sessionHandle,
          step,
          call: { op: step.kind, args: step.params },
        });
        stepRec.result = summarizeActResult(actResult);

        if (needsPost) {
          stepRec.afterObservation = await this.#observe(sessionHandle, handlers, step.id, "post");
          const post = evaluateRecipeAssertions(step.postAssertions, stepRec.afterObservation);
          stepRec.postAssertions = post;
          if (!post.ok) {
            throw err("POST_ASSERTION_FAILED", `postAssertion failed at ${step.id}`, 409, { results: post.results });
          }
        }

        stepRec.status = "VERIFIED";
        run.steps[i].status = "VERIFIED";
        run.stepResults.push(stepRec);
      } catch (e) {
        stepRec.status = "FAILED";
        stepRec.error = { code: e.code || "STEP_FAILED", message: e.message, details: e.details || {} };
        run.steps[i].status = "FAILED";

        // Failure capture: best-effort screenshot + dump + focus
        try {
          stepRec.afterObservation = await this.#captureFailure(sessionHandle, handlers, step.id);
        } catch {
          /* ignore capture errors */
        }

        run.stepResults.push(stepRec);
        run.status = "REPAIR_REQUIRED";
        run.error = stepRec.error;
        run.finishedAt = nowIso(this.clock);
        run.updatedAt = run.finishedAt;
        run.receipt = this.#buildReceipt(run, { mode: "live", ok: false, failedStepId: step.id });
        await this.#safeRelease(run);
        return;
      }
    }

    if (run.status === "CANCELLED") {
      run.finishedAt = nowIso(this.clock);
      run.updatedAt = run.finishedAt;
      run.receipt = this.#buildReceipt(run, { mode: "live", ok: false });
      await this.#safeRelease(run);
      return;
    }

    run.status = "SUCCEEDED";
    run.finishedAt = nowIso(this.clock);
    run.updatedAt = run.finishedAt;
    run.receipt = this.#buildReceipt(run, { mode: "live", ok: true });
    await this.#safeRelease(run);
  }

  async #observe(sessionHandle, handlers, stepId, phase) {
    if (this.observeForAssert) {
      return this.observeForAssert({ session: sessionHandle, stepId, phase });
    }
    const focusOut = await handlers.focus({
      session: sessionHandle,
      step: { id: `${stepId}_${phase}_focus`, kind: "focus", params: {} },
      call: { op: "focus", args: {} },
    });
    const dumpOut = await handlers.dump({
      session: sessionHandle,
      step: { id: `${stepId}_${phase}_dump`, kind: "dump", params: {} },
      call: { op: "dump", args: {} },
    });
    return observationFromPrimitiveResults(focusOut, dumpOut);
  }

  async #captureFailure(sessionHandle, handlers, stepId) {
    const parts = {};
    try {
      parts.screen = await handlers.screenshot({
        session: sessionHandle,
        step: { id: `${stepId}_fail_screen`, kind: "screenshot", params: { label: "failure" } },
        call: { op: "screenshot", args: { label: "failure" } },
      });
    } catch { /* ignore */ }
    try {
      const focusOut = await handlers.focus({
        session: sessionHandle,
        step: { id: `${stepId}_fail_focus`, kind: "focus", params: {} },
        call: { op: "focus", args: {} },
      });
      const dumpOut = await handlers.dump({
        session: sessionHandle,
        step: { id: `${stepId}_fail_dump`, kind: "dump", params: {} },
        call: { op: "dump", args: {} },
      });
      Object.assign(parts, observationFromPrimitiveResults(focusOut, dumpOut));
    } catch { /* ignore */ }
    return parts;
  }

  async #safeRelease(run) {
    if (!run.sessionId || !run.sessionToken) return;
    try {
      await this.releaseSession(run.sessionId, run.sessionToken);
    } catch {
      /* lease may already be gone */
    }
    run.sessionToken = null;
  }

  #buildReceipt(run, { mode, ok, failedStepId = null, plannedCalls = null }) {
    return {
      schemaId: "xw.single-device.recipe-receipt.v1",
      recipeRunId: run.recipeRunId,
      recipeId: run.recipeId,
      revision: run.revision,
      descriptorHash: run.descriptorHash,
      alias: run.alias,
      status: run.status,
      ok: Boolean(ok) && run.status === "SUCCEEDED",
      mode,
      serverVerified: true,
      failedStepId,
      stepCount: run.steps.length,
      verifiedSteps: run.stepResults.filter((s) => s.status === "VERIFIED").length,
      stepResults: run.stepResults,
      sessionId: run.sessionId,
      leaseId: run.leaseId,
      deviceId: run.deviceId,
      error: run.error,
      plannedCalls,
      createdAt: run.createdAt,
      finishedAt: run.finishedAt,
    };
  }
}

function summarizeActResult(actResult) {
  if (!actResult || typeof actResult !== "object") return { ok: Boolean(actResult) };
  const job = actResult.result?.jobId ? actResult.result : actResult.result?.result ? actResult.result : actResult;
  return {
    ok: actResult.ok !== false,
    kind: actResult.kind ?? null,
    jobId: job?.jobId ?? actResult.result?.jobId ?? null,
    status: job?.status ?? actResult.result?.status ?? null,
    primitive: actResult.params?.primitive ?? null,
  };
}

function observationFromPrimitiveResults(focusOut, dumpOut) {
  const focusPayload = unwrapOutput(focusOut);
  const dumpPayload = unwrapOutput(dumpOut);
  const dumpXml = extractDumpXml(dumpPayload);
  return {
    package: focusPayload?.package ?? focusPayload?.focus?.package ?? null,
    activity: focusPayload?.activity ?? focusPayload?.focus?.activity ?? null,
    focus: focusPayload?.focus ?? focusPayload ?? null,
    dumpXml,
    text: dumpXml,
    rawFocus: focusPayload,
    rawDump: dumpPayload,
  };
}

function unwrapOutput(handlerResult) {
  const r = handlerResult?.result ?? handlerResult;
  if (!r || typeof r !== "object") return {};
  if (r.result?.output) return r.result.output;
  if (r.output) return r.output;
  if (r.result && typeof r.result === "object") return r.result;
  return r;
}

function extractDumpXml(payload) {
  if (!payload || typeof payload !== "object") return "";
  if (typeof payload.xml === "string") return payload.xml;
  if (typeof payload.dumpXml === "string") return payload.dumpXml;
  if (typeof payload.hierarchy === "string") return payload.hierarchy;
  if (typeof payload.uiXml === "string") return payload.uiXml;
  if (typeof payload.text === "string" && payload.text.includes("<hierarchy")) return payload.text;
  return "";
}
