import { ControlPlaneError } from "../../control-plane/lib/errors.mjs";
import { XiaoweiTransport } from "../../control-plane/lib/xiaowei-transport.mjs";

const RAW_ALLOWLIST = new Set(["list", "Screen", "imeList"]);

export function createXiaoweiAdapter({ transport = new XiaoweiTransport() } = {}) {
  return {
    id: "xiaowei",
    async execute({ capability, device, params, job }) {
      const action = capability.implementation.action === "raw" ? params.action : capability.implementation.action;
      if (capability.implementation.action === "raw") {
        if (!job.canary) throw new ControlPlaneError("CANARY_REQUIRED", "raw Xiaowei action requires canary session", { status: 403 });
        if (!RAW_ALLOWLIST.has(action)) {
          throw new ControlPlaneError("RAW_ACTION_NOT_ALLOWED", `raw action ${action} is not allowlisted`, { status: 403 });
        }
      }
      const output = await transport.invoke({
        action,
        devices: device.runtimeId,
        data: params.data,
      }, { timeoutMs: capability.timeoutMs });
      return { vendorCode: output?.code ?? null, output };
    },
    async verify({ capability, execution }) {
      if (capability.implementation.action === "list") {
        return { ok: execution.output?.code === 10000 && Array.isArray(execution.output?.data), mode: "state" };
      }
      return { ok: execution.output?.code === 10000, mode: capability.verification.mode };
    },
    async restore({ capability }) {
      return { ok: !capability.restoration.required };
    },
  };
}
