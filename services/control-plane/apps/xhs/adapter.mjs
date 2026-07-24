import { postJson } from "../../control-plane/lib/command-runner.mjs";
import { ControlPlaneError } from "../../control-plane/lib/errors.mjs";

function endpoint(device) {
  const port = Number(device.metadata?.xhsServePort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ControlPlaneError("XHS_SERVE_UNCONFIGURED", "device has no valid xhsServePort", { status: 503 });
  }
  return `http://127.0.0.1:${port}/`;
}

export function createXhsAdapter({ fetchImpl = globalThis.fetch } = {}) {
  return {
    id: "xhs",
    async execute({ capability, device, params }) {
      const response = await postJson(
        endpoint(device),
        { action: capability.implementation.action, ...params },
        { timeoutMs: capability.timeoutMs, fetchImpl },
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
        error.notSent = true; // 守卫都在点发送之前触发，确定未发出，不应标 ambiguous
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
      return { ok: false, ambiguous: true, mode: "custom" };
    },
    async restore({ capability, device }) {
      if (!capability.restoration.required) return { ok: true };
      const restoreIme = await postJson(endpoint(device), { action: "restoreIme" }, {
        timeoutMs: 30000,
        fetchImpl,
      });
      const home = await postJson(endpoint(device), { action: "backToFeed", maxBack: 5 }, {
        timeoutMs: 30000,
        fetchImpl,
      });
      return { ok: restoreIme.ok !== false && home.ok !== false };
    },
  };
}
