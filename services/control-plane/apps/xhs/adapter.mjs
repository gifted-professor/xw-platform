import { postJson, safeAdapterError } from "../../control-plane/lib/command-runner.mjs";
import { ControlPlaneError } from "../../control-plane/lib/errors.mjs";
import {
  restoreXhsPublishNoSave,
  runXhsPublishEditDryRun,
} from "./publish-edit-dry-run.mjs";

function endpoint(device) {
  const port = Number(device.metadata?.xhsServePort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ControlPlaneError("XHS_SERVE_UNCONFIGURED", "device has no valid xhsServePort", { status: 503 });
  }
  return `http://127.0.0.1:${port}/`;
}

function leaseHeaders(leaseAuthorization) {
  if (!leaseAuthorization?.leaseId || !leaseAuthorization?.token || !leaseAuthorization?.deviceId) {
    throw new ControlPlaneError("LEASE_CONTEXT_REQUIRED", "XHS adapter requires an active control-plane lease", {
      status: 500,
    });
  }
  return {
    "x-control-lease-id": leaseAuthorization.leaseId,
    "x-control-token": leaseAuthorization.token,
    "x-control-device-id": leaseAuthorization.deviceId,
  };
}

function assertCollectReceiptParams(params) {
  const receiptId = params?.observationReceiptId;
  const target = params?.targetFingerprint;
  if (typeof receiptId !== "string" || receiptId === "" || typeof target !== "string" || target === "") {
    const error = new ControlPlaneError("COLLECT_RECEIPT_BINDING_INVALID", "collect requires an exact receipt-to-target binding", { status: 409 });
    error.notSent = true;
    throw error;
  }
}

function feedEvidenceFiles(result) {
  const files = [];
  for (const file of Array.isArray(result?.evidenceFiles) ? result.evidenceFiles : []) {
    if (typeof file?.path !== "string" || file.path === "") continue;
    files.push({
      path: file.path,
      kind: typeof file.kind === "string" && file.kind ? file.kind : "adapter",
      label: typeof file.label === "string" && file.label ? file.label : "xhs-feed",
      exportAllowed: file.exportAllowed === true,
    });
  }
  return files;
}

/** Keep cards for verify; project redacted observe.feed fields for result summary. */
function projectFeedCardsOutput(result) {
  const cards = Array.isArray(result?.cards) ? result.cards : [];
  const pageClass = typeof result?.pageClass === "string" && result.pageClass
    ? result.pageClass
    : "xhs.unknown";
  const cardCount = Number.isInteger(result?.cardCount) ? result.cardCount : cards.length;
  const evidenceFiles = Array.isArray(result?.evidenceFiles) ? result.evidenceFiles : [];
  const artifactRefs = evidenceFiles
    .filter((f) => typeof f?.path === "string" && f.path)
    .map((f) => ({
      kind: typeof f.kind === "string" && f.kind ? f.kind : "adapter",
      label: typeof f.label === "string" && f.label ? f.label : "xhs-feed",
      // path redacted to basename only in output projection
      name: String(f.path).split(/[\\/]/).pop() || "artifact",
      exportAllowed: f.exportAllowed === true,
    }));
  return {
    cards,
    dumpMs: result?.dumpMs,
    pageClass,
    cardCount,
    artifactRefs,
    evidenceDebt: Array.isArray(result?.evidenceDebt) ? result.evidenceDebt : [],
  };
}

export function createXhsAdapter({
  fetchImpl = globalThis.fetch,
  transport = null,
  publishWorkflow = runXhsPublishEditDryRun,
  restorePublishWorkflow = restoreXhsPublishNoSave,
} = {}) {
  return {
    id: "xhs",
    async execute({ capability, device, params, leaseAuthorization }) {
      if (capability.implementation.action === "publishEditDryRun") {
        const result = await publishWorkflow({ transport, device, caption: params.caption });
        if (result?.ok !== true) {
          const error = new ControlPlaneError("ADAPTER_ACTION_REJECTED", `xhs action rejected: ${result?.step || "unknown"}`, {
            status: 502,
            details: {
              step: result?.step ?? null,
              workflowError: typeof result?.error === "string" ? result.error.slice(0, 240) : undefined,
              cleanupReason: typeof result?.cleanup?.reason === "string" ? result.cleanup.reason : undefined,
              cleanupActivity: typeof result?.cleanup?.activity === "string" ? result.cleanup.activity : undefined,
              trace: Array.isArray(result?.trace) ? result.trace.slice(-12) : undefined,
            },
          });
          error.notSent = result?.notSent === true;
          error.ambiguous = result?.ambiguous === true || !error.notSent;
          throw error;
        }
        return { vendorCode: 10000, output: result };
      }
      if (capability.implementation.action === "collectOnOpenNote") assertCollectReceiptParams(params);
      const response = await postJson(
        endpoint(device),
        { action: capability.implementation.action, ...params },
        { timeoutMs: capability.timeoutMs, fetchImpl, headers: leaseHeaders(leaseAuthorization) },
      );
      const result = response.result;
      // serve 外层恒为 HTTP 200 ok:true，内层 result.ok===false 才是动作被拒绝
      // （notOnNote / editorLostAfterInput / commentBox / countUnavailable 等守卫，
      //  全部发生在点发送之前，未发出、非 ambiguous）。不透传会被误判成 VERIFICATION_FAILED。
      if (result && typeof result === "object" && result.ok === false) {
        const adapterError = result.step === "stableNoteLocatorUnavailable"
          ? safeAdapterError({
            error: {
              code: "STABLE_NOTE_LOCATOR_UNAVAILABLE",
              step: result.step,
              message: "stable note locator unavailable",
              locatorShape: result.locatorShape,
            },
          })
          : null;
        const error = new ControlPlaneError("ADAPTER_ACTION_REJECTED", `xhs action rejected: ${result.step || "unknown"}`, {
          status: 502,
          details: {
            step: result.step ?? null,
            activity: result.activity ?? result.focus ?? null,
            log: Array.isArray(result.log) ? result.log.slice(-8) : undefined,
            workflowError: typeof result.error === "string" ? result.error.slice(0, 240) : undefined,
            cleanupReason: typeof result.cleanup?.reason === "string" ? result.cleanup.reason : undefined,
            cleanupActivity: typeof result.cleanup?.activity === "string" ? result.cleanup.activity : undefined,
            trace: Array.isArray(result.trace) ? result.trace.slice(-12) : undefined,
            ...(adapterError ? { adapterError } : {}),
          },
        });
        error.notSent = result.notSent === true;
        error.ambiguous = result.ambiguous === true || !error.notSent;
        throw error;
      }
      if (capability.implementation.action === "feedCards") {
        return {
          vendorCode: 200,
          output: projectFeedCardsOutput(result),
          evidenceFiles: feedEvidenceFiles(result),
          metrics: response.metrics,
        };
      }
      return {
        vendorCode: 200,
        output: result,
        metrics: response.metrics,
      };
    },
    async verify({ capability, params, execution }) {
      const action = capability.implementation.action;
      const output = execution.output;
      if (action === "metrics") return { ok: Boolean(output && typeof output === "object"), mode: "state" };
      if (action === "feedCards") {
        return {
          ok: Array.isArray(output?.cards)
            && typeof output?.pageClass === "string"
            && output.pageClass !== ""
            && Number.isInteger(output?.cardCount)
            && output.cardCount >= 0,
          mode: "state",
        };
      }
      if (action === "observeOpenNoteDetail" || action === "openFeedNote") {
        return {
          ok: output?.ok === true
            && typeof output?.pageFingerprint === "string"
            && typeof output?.targetFingerprint === "string"
            && Number.isFinite(Date.parse(output?.observedAt)),
          mode: "state",
        };
      }
      if (action === "backToFeed") return { ok: output?.home === true || output?.restored === true || output?.ok === true, mode: "state" };
      if (action === "inputTextDryRun") {
        const editorText = String(output?.editorText || "");
        return {
          ok: Boolean(output?.audit?.restored) && editorText.includes(String(params.text || "")),
          mode: "text_scan",
        };
      }
      if (action === "publishEditDryRun") {
        return {
          ok: output?.ok === true
            && output?.captionLanded === true
            && output?.postButtonObserved === true
            && output?.published === false
            && output?.savedDraft === false
            && output?.finalCommit === false
            && Number(output?.paymentTransport) === 0
            && output?.restored === true,
          mode: "custom",
        };
      }
      if (action === "commentOnOpenNote") {
        return {
          ok: output?.verified === true || output?.countDelta === 1 || output?.textScan === true,
          ambiguous: true,
          mode: "custom",
        };
      }
      if (action === "collectOnOpenNote") {
        return {
          ok: output?.collected === true
            && output?.beforeState === "not_collected"
            && (output?.afterState === "collected" || output?.countDelta === 1),
          ambiguous: true,
          mode: "custom",
        };
      }
      return { ok: false, ambiguous: true, mode: "custom" };
    },
    buildExplicitObservationReceipt({ capability, execution }) {
      if (!["observeOpenNoteDetail", "openFeedNote"].includes(capability?.implementation?.action)) return null;
      const output = execution?.output;
      const observedAt = Date.parse(output?.observedAt);
      if (output?.ok !== true || typeof output?.pageFingerprint !== "string" || output.pageFingerprint === ""
        || typeof output?.targetFingerprint !== "string" || output.targetFingerprint === ""
        || !Number.isFinite(observedAt)) return null;
      return {
        pageFingerprint: output.pageFingerprint,
        targetFingerprint: output.targetFingerprint,
        observedAt: new Date(observedAt).toISOString(),
      };
    },
    getExplicitObservationReceipt({ job, receiptId }) {
      const sealed = job?.status === "succeeded" ? job.result?.explicitObservationReceipt : null;
      if (!sealed || sealed.receiptId !== receiptId) return null;
      const required = ["pageFingerprint", "targetFingerprint", "observedAt", "evidenceId", "evidenceHash"];
      if (required.some((key) => typeof sealed[key] !== "string" || sealed[key] === "")) return null;
      return Object.fromEntries(required.map((key) => [key, sealed[key]]));
    },
    async restore({ capability, device, params, execution, leaseAuthorization }) {
      if (!capability.restoration.required) return { ok: true };
      const headers = leaseHeaders(leaseAuthorization);
      if (capability.implementation.action === "publishEditDryRun") {
        return restorePublishWorkflow({ transport, device, maxSteps: 10 });
      }
      if (capability.implementation.action === "collectOnOpenNote") {
        const undo = await postJson(endpoint(device), {
          action: "undoCollectOnOpenNote",
          targetFingerprint: params?.targetFingerprint,
          observationReceiptId: params?.observationReceiptId,
          collectProof: execution?.output?.collectProof,
        }, { timeoutMs: 30000, fetchImpl, headers });
        const home = await postJson(endpoint(device), { action: "backToFeed", maxBack: 5 }, {
          timeoutMs: 30000,
          fetchImpl,
          headers,
        });
        const undoOk = undo?.result?.ok === true && undo?.result?.restored === true;
        const homeOk = home?.result?.home === true || home?.result?.restored === true || home?.result?.ok === true;
        return { ok: undoOk && homeOk, undo: undo.result, home: home.result, restoreRequired: !undoOk };
      }
      const restoreIme = await postJson(endpoint(device), { action: "restoreIme" }, {
        timeoutMs: 30000,
        fetchImpl,
        headers,
      });
      const home = await postJson(endpoint(device), { action: "backToFeed", maxBack: 5 }, {
        timeoutMs: 30000,
        fetchImpl,
        headers,
      });
      return { ok: restoreIme.ok !== false && home.ok !== false };
    },
  };
}
