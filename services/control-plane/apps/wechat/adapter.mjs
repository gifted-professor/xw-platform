import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { requireFile, runJsonCommand } from "../../control-plane/lib/command-runner.mjs";
import { ControlPlaneError } from "../../control-plane/lib/errors.mjs";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const defaultScript = join(root, "scripts", "wechat-operator.mjs");

function argsFor(script, action, device, params, evidenceDirectory) {
  if (!device.runtimeId) {
    throw new ControlPlaneError("DEVICE_RUNTIME_ID_MISSING", "WeChat adapter needs a private runtime ID", { status: 503 });
  }
  const args = [script, action, "--serial", device.runtimeId, "--evidence-dir", evidenceDirectory];
  if (params.title) args.push("--title", String(params.title));
  if (params.label) args.push("--label", String(params.label));
  return args;
}

function evidenceFiles(output) {
  const files = [];
  const seen = new Set();
  function visit(value) {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") return;
    if (typeof value.path === "string" && !seen.has(value.path)) {
      seen.add(value.path);
      files.push({ path: value.path, kind: "screenshot", label: "wechat" });
    }
    Object.values(value).forEach(visit);
  }
  visit(output);
  return files;
}

export function createWechatAdapter({ run = runJsonCommand, operatorPath = defaultScript } = {}) {
  return {
    id: "wechat",
    async execute({ capability, device, params, evidenceDirectory }) {
      requireFile(operatorPath, capability.id);
      const output = await run(
        process.execPath,
        argsFor(operatorPath, capability.implementation.action, device, params, evidenceDirectory),
        { cwd: root, timeoutMs: capability.timeoutMs },
      );
      return { vendorCode: 0, output, evidenceFiles: evidenceFiles(output) };
    },
    async verify({ capability, execution }) {
      const output = execution.output;
      if (capability.implementation.action === "inspect") {
        return { ok: output?.ok === true && output?.screenId === "wechat.main.messages", mode: "state" };
      }
      if (capability.implementation.action === "probe") {
        return { ok: Boolean(output?.focus && output?.screenId), hash: output?.evidence?.sha256, mode: "hash" };
      }
      if (capability.implementation.action === "open") {
        return {
          ok: output?.ok === true && output?.titleMatched === true && output?.evidence?.baselineHeld === true,
          mode: "custom",
        };
      }
      return { ok: false, ambiguous: true, mode: "custom" };
    },
    async restore({ capability, device, evidenceDirectory }) {
      if (!capability.restoration.required) return { ok: true };
      requireFile(operatorPath, capability.id);
      const output = await run(
        process.execPath,
        argsFor(operatorPath, "restore", device, {}, evidenceDirectory),
        { cwd: root, timeoutMs: 60000 },
      );
      return { ok: output?.ok === true, evidenceFiles: evidenceFiles(output) };
    },
  };
}
