import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { requireFile, runJsonCommand } from "../../control-plane/lib/command-runner.mjs";
import { ControlPlaneError } from "../../control-plane/lib/errors.mjs";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const defaultScript = join(root, "scripts", "xianyu-operator.mjs");

function evidenceFiles(output) {
  const files = [];
  const seen = new Set();
  function visit(value) {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") return;
    if (typeof value.path === "string" && !seen.has(value.path)) {
      seen.add(value.path);
      files.push({ path: value.path, kind: "screenshot", label: "xianyu" });
    }
    Object.values(value).forEach(visit);
  }
  visit(output);
  return files;
}

function commandArgs({ script, action, device, params }) {
  if (!device.runtimeId) {
    throw new ControlPlaneError("DEVICE_RUNTIME_ID_MISSING", "Xianyu adapter needs a private runtime ID", { status: 503 });
  }
  const args = [script, "--serial", device.runtimeId, action];
  if (params.text !== undefined) args.push("--text", String(params.text));
  if (device.metadata?.adbPath) args.push("--adb", device.metadata.adbPath);
  return args;
}

export function createXianyuAdapter({ run = runJsonCommand, operatorPath = defaultScript } = {}) {
  return {
    id: "xianyu",
    async execute({ capability, device, params }) {
      requireFile(operatorPath, capability.id);
      const output = await run(process.execPath, commandArgs({
        script: operatorPath,
        action: capability.implementation.action,
        device,
        params,
      }), { cwd: root, timeoutMs: capability.timeoutMs });
      return { vendorCode: 0, output, evidenceFiles: evidenceFiles(output) };
    },
    async verify({ capability, execution }) {
      const output = execution.output;
      if (capability.implementation.action === "snapshot") {
        return { ok: Boolean(output?.focus), mode: "state" };
      }
      if (capability.implementation.action === "open-publish") {
        return {
          ok: output?.stoppedBeforePublish === true && output?.stage === "publish-compose",
          mode: "state",
        };
      }
      if (capability.implementation.action === "input-dry-run") {
        return {
          ok: output?.ok === true
            && output?.stoppedBeforePublish === true
            && output?.audit?.imeRestored === true
            && output?.audit?.textVerified === true
            && output?.audit?.clearedVerified === true,
          mode: "text_scan",
        };
      }
      return { ok: false, ambiguous: true, mode: "custom" };
    },
    async restore({ capability, device }) {
      if (!capability.restoration.required) return { ok: true };
      requireFile(operatorPath, capability.id);
      const output = await run(process.execPath, commandArgs({
        script: operatorPath,
        action: "discard-dry-run",
        device,
        params: {},
      }), { cwd: root, timeoutMs: 60000 });
      return { ok: output?.ok === true && output?.savedDraft === false };
    },
  };
}
