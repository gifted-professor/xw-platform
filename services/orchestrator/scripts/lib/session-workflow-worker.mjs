import { getWorkflow } from "./workflow-catalog.mjs";
import { createWorkReceipt } from "./work-receipt.mjs";
import { validateExpectedApp } from "./typed-job-worker.mjs";
import { extractWechatBalanceFromScreen } from "./wechat-balance-extract.mjs";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Stable action operation key. Foundation INV-03/07: no attemptIndex in the key
 * (attemptId remains log/receipt-only).
 */
export function actionIdempotencyKey({ taskRunId, shardKey, actionIndex, actionId }) {
  return `m2:${taskRunId}:${String(shardKey).slice(0, 20)}:act${actionIndex}:${actionId}`;
}

/**
 * INV-07: only catalog/ExecutionPlan workflow actions may run.
 * Reject shard.params.actions / actionOverrides / primitive_steps injection.
 */
export function resolveWorkflowActions(workflow, shardParams = {}) {
  if (shardParams && typeof shardParams === "object") {
    if (Array.isArray(shardParams.actions) || shardParams.actionOverrides || shardParams.primitive_steps) {
      throw Object.assign(
        new Error("workflow runtime must not inject actions/actionOverrides/primitive_steps"),
        { code: "WORKFLOW_CONTRACT_UNBOUND" },
      );
    }
  }
  const actions = workflow?.actions;
  if (!Array.isArray(actions) || actions.length === 0) {
    throw Object.assign(new Error("workflow has no actions"), { code: "WORKFLOW_ACTIONS_EMPTY" });
  }
  return actions;
}

/**
 * Flat-output business gate for session workflows (not item-array recipes).
 */
function resolvePackageName(output) {
  return output?.packageName
    || output?.pkg
    || output?.package
    || output?.focus?.packageName
    || output?.focus?.package
    || output?.currentApp?.packageName
    || null;
}

function resolveActivity(output) {
  return output?.activity
    || output?.focus?.activity
    || output?.currentApp?.activity
    || "";
}

export function validateWorkflowBusinessOutput({ acceptance, output, expectedApp }) {
  if (expectedApp) {
    const packageName = resolvePackageName(output);
    const activity = resolveActivity(output);
    const expectedPackage = expectedApp.package || expectedApp.packageName;
    if (expectedPackage) {
      if (!packageName) {
        return {
          ok: false,
          code: "EXPECTED_APP_MISMATCH",
          message: `expected package ${expectedPackage}, got unknown`,
        };
      }
      if (packageName !== expectedPackage) {
        return {
          ok: false,
          code: "EXPECTED_APP_MISMATCH",
          message: `expected package ${expectedPackage}, got ${packageName}`,
        };
      }
    }
    const includes = expectedApp.activityIncludes;
    if (Array.isArray(includes) && includes.length && activity) {
      const hit = includes.some((frag) => String(activity).toLowerCase().includes(String(frag).toLowerCase()));
      if (!hit) {
        return {
          ok: false,
          code: "EXPECTED_ACTIVITY_MISMATCH",
          message: `activity ${activity} does not include any of ${includes.join(",")}`,
        };
      }
    }
  }

  if (!acceptance || typeof acceptance !== "object" || Object.keys(acceptance).length === 0) {
    return { ok: true };
  }

  if (acceptance.paymentTransport != null && Number(output?.paymentTransport ?? 0) !== 0) {
    return {
      ok: false,
      code: "PAYMENT_TRANSPORT_NOT_ZERO",
      message: `paymentTransport must be 0, got ${output?.paymentTransport}`,
    };
  }
  if (acceptance.finalCommit === false && output?.finalCommit === true) {
    return {
      ok: false,
      code: "FINAL_COMMIT_FORBIDDEN",
      message: "finalCommit must remain false for this workflow",
    };
  }
  if (Array.isArray(acceptance.requiredFields)) {
    for (const field of acceptance.requiredFields) {
      const value = output?.[field];
      if (value == null || value === "") {
        return { ok: false, code: "REQUIRED_FIELD_MISSING", message: `missing ${field}` };
      }
    }
  }
  if (acceptance.amountMustBeUniqueOnScreen === true) {
    const candidates = output?.amountCandidates;
    if (Array.isArray(candidates) && candidates.length > 1) {
      return {
        ok: false,
        code: "AMOUNT_NOT_UNIQUE",
        message: `expected a unique amount, got ${candidates.length} candidates`,
      };
    }
  }
  return { ok: true };
}

/**
 * Worker for executor.kind === "session_workflow".
 * JIT acquire → deterministic actions → finally release.
 * Client must expose: acquireSession, sessionAction, releaseSession.
 * Optional: assertLeaseVisible(leaseId).
 */
export class SessionWorkflowWorker {
  constructor({
    client,
    actorId,
    workflowResolver = getWorkflow,
    pollMs = 0,
  } = {}) {
    if (!client) throw new Error("client is required");
    if (!actorId) throw new Error("actorId is required");
    this.client = client;
    this.actorId = actorId;
    this.workflowResolver = workflowResolver;
    this.pollMs = pollMs;
  }

  resolveWorkflow(executor) {
    if (executor.kind !== "session_workflow") {
      throw Object.assign(new Error("SessionWorkflowWorker only accepts session_workflow"), { code: "EXECUTOR_KIND_MISMATCH" });
    }
    if (!executor.workflowId) {
      throw Object.assign(new Error("workflowId is required"), { code: "WORKFLOW_ID_MISSING" });
    }
    if (executor.capabilityId !== "xiaowei.explorer.primitive") {
      throw Object.assign(new Error("session_workflow must use xiaowei.explorer.primitive"), { code: "CAPABILITY_MISMATCH" });
    }
    const workflow = this.workflowResolver(executor.workflowId);
    if (!workflow) {
      throw Object.assign(new Error(`workflow not found: ${executor.workflowId}`), { code: "WORKFLOW_NOT_FOUND" });
    }
    if (workflow.entry !== "session") {
      throw Object.assign(new Error(`workflow entry must be session, got ${workflow.entry}`), { code: "WORKFLOW_ENTRY_INVALID" });
    }
    return workflow;
  }

  async execute(assignment) {
    const startedAt = new Date().toISOString();
    const executor = assignment.node.executor;
    let session = null;
    let released = false;
    let releaseError = null;
    const release = async () => {
      if (!session || released) return;
      released = true;
      try {
        await this.client.releaseSession({
          sessionId: session.sessionId,
          token: session.token,
          alias: assignment.alias,
        });
        if (typeof this.client.assertLeaseAbsent === "function") {
          await this.client.assertLeaseAbsent(session.leaseId);
        } else if (typeof this.client.getLeases === "function") {
          const payload = await this.client.getLeases();
          const still = (payload?.leases || []).some((item) => item.leaseId === session.leaseId);
          if (still) throw Object.assign(new Error(`lease ${session.leaseId} still visible after release`), { code: "LEASE_STILL_VISIBLE" });
        }
      } catch (error) {
        // finally path must not mask the primary business/technical outcome, but must not claim success.
        releaseError = { code: error?.code || "SESSION_RELEASE_FAILED", message: error?.message || String(error) };
      }
    };

    try {
      const workflow = this.resolveWorkflow(executor);
      const expectedApp = executor.expectedApp || workflow.expectedApp || null;
      const acceptance = assignment.shard.acceptance || assignment.node.acceptance || workflow.acceptance || null;

      if (workflow.tapAuthorized === true && assignment.shard.params?.allowAutoTap !== true) {
        // Catalog may declare future canary taps; production path still fail-closed without explicit permit.
      }

      session = await this.client.acquireSession({
        actorId: this.actorId,
        capabilityId: executor.capabilityId,
        alias: assignment.alias,
        canary: workflow.maturity === "canary_only" || workflow.status === "canary_only",
        workflowId: workflow.workflowId,
      });
      if (!session?.sessionId || !session?.leaseId || !session?.token) {
        throw Object.assign(new Error("session acquire did not return sessionId/leaseId/token"), { code: "SESSION_BINDING_INVALID" });
      }
      if (session.alias && session.alias !== assignment.alias) {
        throw Object.assign(new Error(`session bound to ${session.alias}, expected ${assignment.alias}`), { code: "PLACEMENT_MISMATCH" });
      }
      if (typeof this.client.assertLeaseVisible === "function") {
        await this.client.assertLeaseVisible(session.leaseId, {
          alias: assignment.alias,
          actorId: this.actorId,
        });
      }

      await assignment.onProgress?.({
        type: "session_bound",
        sessionId: session.sessionId,
        leaseId: session.leaseId,
        alias: assignment.alias,
      });

      const actions = resolveWorkflowActions(workflow, assignment.shard.params);

      const actionRefs = [];
      let lastOutput = {};
      for (const [actionIndex, action] of actions.entries()) {
        if (this.pollMs) await sleep(this.pollMs);
        const actionId = action.actionId || `action_${actionIndex}`;
        const primitive = action.primitive;
        if (!primitive) {
          throw Object.assign(new Error(`action ${actionId} missing primitive`), { code: "ACTION_PRIMITIVE_MISSING" });
        }
        if (primitive === "tap" && workflow.tapAuthorized !== true && assignment.shard.params?.tapPermit !== true) {
          throw Object.assign(
            new Error("tap action blocked: tapAuthorized=false and no one-shot tapPermit on shard params"),
            { code: "TAP_NOT_AUTHORIZED" },
          );
        }
        const idempotencyKey = actionIdempotencyKey({
          taskRunId: assignment.taskRunId,
          shardKey: assignment.shard.shardKey,
          actionIndex,
          actionId,
        });
        const result = await this.client.sessionAction({
          sessionId: session.sessionId,
          token: session.token,
          alias: assignment.alias,
          capabilityId: executor.capabilityId,
          idempotencyKey,
          params: {
            primitive,
            ...(action.params && typeof action.params === "object" ? action.params : {}),
            // INV-07: no actionOverrides merge
          },
        });
        const jobId = result?.jobId || result?.job?.jobId || null;
        const runId = result?.runId || result?.job?.runId || null;
        const output = result?.output || result?.job?.result?.output || {};
        const storage = result?.storage || result?.job?.storage || output?.storage || null;
        lastOutput = {
          ...lastOutput,
          ...output,
          ...(storage ? { storage } : {}),
        };
        // Prefer latest screen evidence path for post-action OCR extractors.
        if (primitive === "screen") {
          const screenPath = output.path
            || output.screenshotPath
            || (storage?.runDirectory ? `${storage.runDirectory}\\screen.png` : null)
            || (storage?.evidenceDirectory ? `${storage.evidenceDirectory}\\screen.png` : null);
          if (screenPath) lastOutput.path = screenPath;
        }
        actionRefs.push({
          actionId,
          actionIndex,
          primitive,
          idempotencyKey,
          jobId,
          runId,
          frame: result?.frame || output?.frame || null,
          path: output.path || null,
          storage,
        });
        await assignment.onProgress?.({
          type: "action_completed",
          actionId,
          jobId,
          runId,
        });
      }

      // Release session ASAP after device I/O. OCR/post-processing is offline and must not
      // hold a 60s canary lease (long extract previously left residual leases).
      await release();

      const merged = { ...lastOutput };
      // WeChat Services page: dump is often empty; balance is under 钱包 on screenshot.
      if (
        workflow.workflowId === "workflow.wechat.balance-read.v1" &&
        (merged.amountCny == null || merged.amountCny === "")
      ) {
        const candidatePaths = [
          merged.path,
          merged.screenshotPath,
          merged.localPath,
          ...actionRefs.map((item) => item.path).filter(Boolean),
          merged.storage?.runDirectory ? `${merged.storage.runDirectory}\\screen.png` : null,
          merged.storage?.evidenceDirectory ? `${merged.storage.evidenceDirectory}\\screen.png` : null,
        ].filter(Boolean);
        let extracted = null;
        for (const candidate of candidatePaths) {
          extracted = extractWechatBalanceFromScreen(candidate);
          if (extracted.ok) break;
        }
        if (extracted?.ok) {
          merged.amountCny = extracted.amountCny;
          merged.currency = extracted.currency;
          merged.amountCandidates = extracted.amountCandidates;
          merged.balanceDisplay = extracted.display;
          merged.balanceExtract = {
            ok: true,
            imagePath: extracted.imagePath,
            texts: extracted.texts,
            crop: extracted.crop,
            privacy: extracted.privacy,
          };
        } else if (extracted) {
          merged.balanceExtract = {
            ok: false,
            code: extracted.code,
            message: extracted.message,
            amountCandidates: extracted.amountCandidates || [],
            texts: extracted.texts || [],
          };
          if (Array.isArray(extracted.amountCandidates) && extracted.amountCandidates.length) {
            merged.amountCandidates = extracted.amountCandidates;
          }
        }
      }

      const packageName = resolvePackageName(merged);
      const activity = resolveActivity(merged);
      const output = {
        ...merged,
        workflowId: workflow.workflowId,
        sessionId: session.sessionId,
        leaseId: session.leaseId,
        actions: actionRefs,
        paymentTransport: Number(merged.paymentTransport ?? 0),
        finalCommit: merged.finalCommit === true,
        packageName,
        pkg: packageName,
        package: packageName || merged.package || null,
        activity: activity || null,
        amountCny: merged.amountCny ?? null,
        currency: merged.currency ?? (merged.amountCny != null ? "CNY" : null),
        capturedAt: merged.capturedAt || new Date().toISOString(),
        amountCandidates: merged.amountCandidates,
        sessionReleased: !releaseError,
        releaseError,
      };

      // Prefer expectedApp.package from workflow catalog over packageName-only validator.
      const expectedForValidate = expectedApp
        ? {
            packageName: expectedApp.package || expectedApp.packageName,
            appId: expectedApp.appId,
            activity: expectedApp.activity,
          }
        : null;
      const expectedCheck = validateExpectedApp(expectedForValidate, output);
      if (releaseError) {
        return createWorkReceipt({
          assignment,
          technicalStatus: "failed",
          businessStatus: "not_evaluated",
          retryable: true,
          job: { jobId: actionRefs.at(-1)?.jobId, runId: actionRefs.at(-1)?.runId },
          output: { ...output, paymentTransport: 0, finalCommit: false },
          error: releaseError,
          startedAt,
          finishedAt: new Date().toISOString(),
        });
      }
      if (!expectedCheck.ok) {
        return createWorkReceipt({
          assignment,
          technicalStatus: "succeeded",
          businessStatus: "rejected",
          retryable: false,
          job: { jobId: actionRefs.at(-1)?.jobId, runId: actionRefs.at(-1)?.runId },
          output: { ...output, paymentTransport: 0, finalCommit: false },
          error: expectedCheck,
          startedAt,
          finishedAt: new Date().toISOString(),
        });
      }
      const business = validateWorkflowBusinessOutput({ acceptance, output, expectedApp });
      return createWorkReceipt({
        assignment,
        technicalStatus: "succeeded",
        businessStatus: business.ok ? "accepted" : "rejected",
        retryable: false,
        job: { jobId: actionRefs.at(-1)?.jobId, runId: actionRefs.at(-1)?.runId },
        output: {
          ...output,
          paymentTransport: 0,
          finalCommit: false,
        },
        error: business.ok ? null : business,
        startedAt,
        finishedAt: new Date().toISOString(),
      });
    } catch (error) {
      await release();
      const code = error?.code || "SESSION_WORKFLOW_FAILED";
      const replaySafe = ["read_only", "replay_safe"].includes(executor?.replaySafety);
      const stop = /CAPTCHA|RISK|LOGIN|TAP_NOT_AUTHORIZED|PAYMENT|FINAL_COMMIT|PLACEMENT|CAPABILITY|WORKFLOW/i.test(code);
      return createWorkReceipt({
        assignment,
        technicalStatus: code === "WAITING_APPROVAL" ? "blocked" : "failed",
        businessStatus: "not_evaluated",
        retryable: replaySafe && !stop,
        job: session ? { jobId: session.sessionId, runId: session.leaseId } : {},
        output: session
          ? {
              sessionId: session.sessionId,
              leaseId: session.leaseId,
              sessionReleased: !releaseError,
              releaseError,
              paymentTransport: 0,
              finalCommit: false,
            }
          : { paymentTransport: 0, finalCommit: false },
        error: releaseError || { code, message: error?.message || String(error) },
        startedAt,
        finishedAt: new Date().toISOString(),
      });
    }
  }
}

/**
 * Dispatch by executor.kind so one Lead can mix typed_job and session_workflow nodes.
 */
export class MissionWorkerRouter {
  constructor({ typedJobWorker, sessionWorkflowWorker }) {
    if (!typedJobWorker?.execute) throw new Error("typedJobWorker.execute is required");
    if (!sessionWorkflowWorker?.execute) throw new Error("sessionWorkflowWorker.execute is required");
    this.typedJobWorker = typedJobWorker;
    this.sessionWorkflowWorker = sessionWorkflowWorker;
  }

  execute(assignment) {
    const kind = assignment?.node?.executor?.kind || "typed_job";
    if (kind === "session_workflow") return this.sessionWorkflowWorker.execute(assignment);
    if (kind === "typed_job") return this.typedJobWorker.execute(assignment);
    return Promise.reject(Object.assign(new Error(`unsupported executor.kind ${kind}`), { code: "EXECUTOR_KIND_UNSUPPORTED" }));
  }
}
