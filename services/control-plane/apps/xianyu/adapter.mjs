import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { requireFile, runJsonCommand } from "../../control-plane/lib/command-runner.mjs";
import { ControlPlaneError } from "../../control-plane/lib/errors.mjs";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const defaultScript = join(root, "scripts", "xianyu-operator.mjs");

function operatorEnv(leaseAuthorization) {
  if (!leaseAuthorization?.leaseId || !leaseAuthorization?.token || !leaseAuthorization?.deviceId) {
    throw new ControlPlaneError("LEASE_CONTEXT_REQUIRED", "Xianyu adapter requires an active control-plane lease", {
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
  const command = ["full-dry-run", "full-draft-dry-run"].includes(action) ? "publish-dry-run"
    : action === "image-dry-run" ? "image-dry-run"
      : action === "save-draft-dry-run" ? "save-draft-dry-run"
        : action;
  const args = [script, "--serial", device.runtimeId, "--transport", "gateway", command];
  if (params.text !== undefined) args.push("--text", String(params.text));
  // publish-dry-run / image-dry-run params
  if (params.description !== undefined) args.push("--description", String(params.description));
  if (params.price !== undefined) args.push("--price", String(params.price));
  if (params.skuPrice !== undefined) args.push("--sku-price", String(params.skuPrice));
  if (params.skuStock !== undefined) args.push("--sku-stock", String(params.skuStock));
  if (params.skuSpecs !== undefined) args.push("--sku-specs", JSON.stringify(params.skuSpecs));
  if (params.skuReplaceExisting === true) args.push("--sku-replace");
  if (params.title !== undefined) args.push("--title", String(params.title));
  if (params.freightTemplate !== undefined) args.push("--freight-template", String(params.freightTemplate));
  if (params.freightPrice !== undefined) args.push("--freight-price", String(params.freightPrice));
  if (params.category !== undefined) args.push("--category", String(params.category));
  if (params.condition !== undefined) args.push("--condition", String(params.condition));
  if (params.returnAddress !== undefined) args.push("--return-address", String(params.returnAddress));
  if (params.location !== undefined) args.push("--return-address", String(params.location));
  if (params.images !== undefined) args.push("--images", JSON.stringify(params.images));
  if (params.imageAlbum !== undefined) args.push("--image-album", String(params.imageAlbum));
  if (params.maxImages !== undefined) args.push("--max-images", String(params.maxImages));
  if (params.attributes !== undefined) args.push("--attributes", JSON.stringify(params.attributes));
  if (action === "full-draft-dry-run" || params.saveDraft === true) args.push("--save-draft");
  // calibrated: true | "all" | "image" | "sku,freight,image" | { sku:true, freight:true, ... }
  if (params.calibrated === true || params.calibrated === "all") {
    if (command === "publish-dry-run") args.push("--calibrated", "all");
  } else if (typeof params.calibrated === "string" && params.calibrated.length) {
    if (command === "publish-dry-run") args.push("--calibrated", params.calibrated);
    else if (command === "image-dry-run" && /image|all/.test(params.calibrated)) {
      /* image-dry-run defaults calibrated on */
    }
  } else if (params.calibrated && typeof params.calibrated === "object") {
    const flags = Object.entries(params.calibrated)
      .filter(([, v]) => v)
      .map(([k]) => k);
    if (flags.length && command === "publish-dry-run") args.push("--calibrated", flags.join(","));
  } else if (params.calibrated === "image" && command === "publish-dry-run") {
    args.push("--calibrated", "image");
  }
  if (params.skipUpload) args.push("--skip-upload");
  if (params.skipCategory) args.push("--skip-category");
  if (params.skipSku) args.push("--skip-sku");
  if (params.skipFreight) args.push("--skip-freight");
  if (params.skipAddress) args.push("--skip-address");
  if (device.metadata?.adbPath) args.push("--adb", device.metadata.adbPath);
  return args;
}

export function createXianyuAdapter({ run = runJsonCommand, operatorPath = defaultScript } = {}) {
  return {
    id: "xianyu",
    async execute({ capability, device, params, leaseAuthorization }) {
      requireFile(operatorPath, capability.id);
      const output = await run(process.execPath, commandArgs({
        script: operatorPath,
        action: capability.implementation.action,
        device,
        params,
      }), { cwd: root, timeoutMs: capability.timeoutMs, env: operatorEnv(leaseAuthorization) });
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
        // 效卫 XwIME 写中文；不再要求切回 SogouIME（imeRestored）。
        // dry-run 默认仍要求 textVerified + clearedVerified（写进再擦掉）。
        return {
          ok: output?.ok === true
            && output?.stoppedBeforePublish === true
            && output?.audit?.textVerified === true
            && output?.audit?.clearedVerified === true
            && output?.audit?.inputAccepted === true,
          mode: "text_scan",
        };
      }
      if (capability.implementation.action === "image-dry-run") {
        return {
          ok: output?.ok === true
            && output?.stoppedBeforePublish === true
            && (output?.upload?.ok === true || output?.step === "images-uploaded"),
          mode: "state",
        };
      }
      if (capability.implementation.action === "full-dry-run") {
        return {
          ok: output?.ok === true
            && output?.stoppedBeforePublish === true
            && output?.savedDraft !== true
            && !output?.steps?.saveDraft,
          mode: "state",
        };
      }
      if (capability.implementation.action === "full-draft-dry-run") {
        return {
          ok: output?.ok === true
            && output?.stoppedBeforePublish === true
            && output?.savedDraft === true
            && output?.steps?.saveDraft?.ok === true
            && output?.publishTapped !== true,
          mode: "state",
        };
      }
      if (capability.implementation.action === "save-draft-dry-run") {
        return {
          ok: output?.ok === true
            && output?.stoppedBeforePublish === true
            && output?.savedDraft === true
            && output?.publishTapped !== true,
          mode: "state",
        };
      }
      return { ok: false, ambiguous: true, mode: "custom" };
    },
    async restore({ capability, device, execution, leaseAuthorization }) {
      if (!capability.restoration.required) return { ok: true };
      // 已存草稿则不要 discard（草稿即期望副作用）
      if (execution?.output?.savedDraft === true) return { ok: true, skipped: "already-saved-draft" };
      requireFile(operatorPath, capability.id);
      const output = await run(process.execPath, commandArgs({
        script: operatorPath,
        action: "discard-dry-run",
        device,
        params: {},
      }), { cwd: root, timeoutMs: 60000, env: operatorEnv(leaseAuthorization) });
      return { ok: output?.ok === true && output?.savedDraft === false };
    },
  };
}
