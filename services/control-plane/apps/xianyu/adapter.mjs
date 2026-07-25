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
  // Map capability action name to operator CLI command.
  const command = action === "full-dry-run" ? "publish-dry-run" : action;
  const args = [script, "--serial", device.runtimeId, command];
  if (params.text !== undefined) args.push("--text", String(params.text));
  // publish-dry-run params
  if (params.description !== undefined) args.push("--description", String(params.description));
  if (params.price !== undefined) args.push("--price", String(params.price));
  if (params.title !== undefined) args.push("--title", String(params.title));
  if (params.freightTemplate !== undefined) args.push("--freight-template", String(params.freightTemplate));
  if (params.freightPrice !== undefined) args.push("--freight-price", String(params.freightPrice));
  if (params.category !== undefined) args.push("--category", String(params.category));
  if (params.condition !== undefined) args.push("--condition", String(params.condition));
  if (params.returnAddress !== undefined) args.push("--return-address", String(params.returnAddress));
  if (params.location !== undefined) args.push("--return-address", String(params.location));
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
      if (capability.implementation.action === "full-dry-run") {
        return {
          ok: output?.ok === true && output?.stoppedBeforePublish === true && output?.savedDraft !== true,
          mode: "state",
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
