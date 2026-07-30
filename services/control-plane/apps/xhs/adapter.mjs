import { postJson } from "../../control-plane/lib/command-runner.mjs";
import { ControlPlaneError } from "../../control-plane/lib/errors.mjs";

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

export function createXhsAdapter({ fetchImpl = globalThis.fetch } = {}) {
  return {
    id: "xhs",
    async execute({ capability, device, params, leaseAuthorization }) {
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
        const error = new ControlPlaneError("ADAPTER_ACTION_REJECTED", `xhs action rejected: ${result.step || "unknown"}`, {
          status: 502,
          details: {
            step: result.step ?? null,
            activity: result.activity ?? result.focus ?? null,
            log: Array.isArray(result.log) ? result.log.slice(-8) : undefined,
          },
        });
        error.notSent = result.notSent === true;
        error.ambiguous = result.ambiguous === true || !error.notSent;
        throw error;
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
      if (action === "feedCards") return { ok: Array.isArray(output?.cards), mode: "state" };
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
