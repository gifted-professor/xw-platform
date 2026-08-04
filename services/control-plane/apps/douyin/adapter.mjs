import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { requireFile, runJsonCommand } from "../../control-plane/lib/command-runner.mjs";
import { ControlPlaneError } from "../../control-plane/lib/errors.mjs";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const defaultScript = join(root, "scripts", "douyin-operator.mjs");
const DOUYIN_PACKAGE = "com.ss.android.ugc.aweme";

function operatorEnv(leaseAuthorization) {
  if (!leaseAuthorization?.leaseId || !leaseAuthorization?.token || !leaseAuthorization?.deviceId) {
    throw new ControlPlaneError("LEASE_CONTEXT_REQUIRED", "Douyin adapter requires an active control-plane lease", {
      status: 500,
    });
  }
  return {
    ...process.env,
    XHS_OPERATOR_LEASE_ID: leaseAuthorization.leaseId,
    XHS_OPERATOR_LEASE_TOKEN: leaseAuthorization.token,
    XHS_OPERATOR_DEVICE_ID: leaseAuthorization.deviceId,
    XHS_OPERATOR_CONTROL_URL: leaseAuthorization.controlUrl || "http://127.0.0.1:17920",
  };
}

function commandArgs({ script, action, device, params = {} }) {
  if (!device.runtimeId) {
    throw new ControlPlaneError("DEVICE_RUNTIME_ID_MISSING", "Douyin adapter needs a private runtime ID", { status: 503 });
  }
  const args = [script, "--serial", device.runtimeId, "--transport", "gateway", action];
  if (action === "search") {
    const keyword = params.keyword ?? params.text;
    if (typeof keyword !== "string" || !keyword.trim()) {
      throw new ControlPlaneError("DOUYIN_KEYWORD_REQUIRED", "douyin.observe.search requires params.keyword", {
        status: 400,
      });
    }
    args.push("--keyword", String(keyword).trim());
  }
  return args;
}

export function createDouyinAdapter({ run = runJsonCommand, operatorPath = defaultScript } = {}) {
  return {
    id: "douyin",
    async execute({ capability, device, params, leaseAuthorization }) {
      requireFile(operatorPath, capability.id);
      const output = await run(process.execPath, commandArgs({
        script: operatorPath,
        action: capability.implementation.action,
        device,
        params,
      }), { cwd: root, timeoutMs: capability.timeoutMs, env: operatorEnv(leaseAuthorization) });
      return { vendorCode: 0, output, evidenceFiles: [] };
    },
    async verify({ capability, execution }) {
      const output = execution.output;
      const action = capability.implementation.action;
      if (action === "snapshot") {
        return {
          ok: Boolean(output?.focus?.package === DOUYIN_PACKAGE) && Array.isArray(output?.nodes),
          mode: "state",
        };
      }
      if (action === "search") {
        return {
          ok: Boolean(
            output?.ok
            && /SearchResultActivity|SplashActivity/i.test(output?.focus?.activity || output?.focus?.raw || "")
            && Array.isArray(output?.tabs)
            && output.tabs.includes("综合")
            && output.backHome === true
            && output.stoppedBeforeOpen === true
          ),
          mode: "state",
        };
      }
      if (action === "like-dry-run") {
        return {
          ok: Boolean(
            output?.ok
            && output?.locatedNotTapped === true
            && output?.dryRun === true
            && output?.likeXy
            && output?.likeState
            && output.likeState !== "missing"
          ),
          mode: "state",
        };
      }
      if (action === "collect-dry-run") {
        return {
          ok: Boolean(
            output?.ok
            && output?.locatedNotTapped === true
            && output?.dryRun === true
            && output?.collectXy
            && output?.collectState
            && output.collectState !== "missing"
          ),
          mode: "state",
        };
      }
      if (action === "follow-dry-run") {
        return {
          ok: Boolean(
            output?.ok
            && output?.locatedNotTapped === true
            && output?.dryRun === true
            && output?.followXy
            && output?.followState
            && output.followState !== "missing"
          ),
          mode: "state",
        };
      }
      return { ok: false, mode: "state" };
    },
    async restore({ capability }) {
      if (!capability.restoration?.required) return { ok: true };
      // search already backs to Splash inside the operator; restore is a soft ack.
      return { ok: true };
    },
  };
}
