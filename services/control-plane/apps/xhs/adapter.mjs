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
      return {
        vendorCode: 200,
        output: response.result,
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
