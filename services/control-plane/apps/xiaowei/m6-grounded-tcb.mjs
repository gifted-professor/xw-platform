import { ControlPlaneError } from "../../control-plane/lib/errors.mjs";
import {
  assertM6PrivateMaterialBinding,
  validateM6TypedInvocation,
} from "../../control-plane/lib/m6-typed-transport.mjs";

function invalid(message) {
  throw new ControlPlaneError("M6_TCB_PRIVATE_MATERIAL_INVALID", message, { status: 409 });
}

function rawRequest(checked, material) {
  switch (checked.primitive) {
    case "tap":
      return {
        action: "adb_shell",
        data: { command: `input tap ${material.point.x} ${material.point.y}` },
      };
    case "scroll":
      return {
        action: "adb_shell",
        data: {
          command: `input swipe ${material.swipe.from.x} ${material.swipe.from.y} ${material.swipe.to.x} ${material.swipe.to.y} ${material.swipe.durationMs}`,
        },
      };
    case "back":
      return { action: "adb_shell", data: { command: "input keyevent 4" } };
    case "open_app": {
      const component = material.app.activity
        ? (material.app.activity.includes("/") ? material.app.activity : `${material.app.package}/${material.app.activity}`)
        : null;
      return {
        action: "adb_shell",
        data: {
          command: component
            ? `am start -W -n ${component}`
            : `monkey -p ${material.app.package} -c android.intent.category.LAUNCHER 1`,
        },
      };
    }
    case "type_search_text":
      // IME selection, refocus, clear and enter are deliberately not hidden in
      // this slot. The frozen plan owns focus/reset as separate physical slots.
      return { action: "inputText", data: { content: material.text } };
    default:
      invalid(`primitive ${checked.primitive} is not a write primitive owned by the M6 TCB`);
  }
}

export function createM6GroundedTcb({ transport, device, leaseAuthorization, job, evidenceDirectory } = {}) {
  if (!transport || typeof transport.invoke !== "function" || !device || !leaseAuthorization || !job || typeof evidenceDirectory !== "string") {
    throw new TypeError("M6 grounded TCB requires transport, device, lease authorization, job, and evidence directory");
  }
  if (device.alias !== "01" || leaseAuthorization.deviceId !== device.deviceId
    || typeof leaseAuthorization.leaseId !== "string" || leaseAuthorization.leaseId === ""
    || job.capabilityId !== "xiaowei.m6.grounded_run" || job.canary !== true) {
    throw new ControlPlaneError("M6_TCB_AUTHORITY_INVALID", "M6 TCB requires exact alias-01 grounded-run canary authority", { status: 403 });
  }
  return Object.freeze({
    async invokeWrite(binding, invocation, privateMaterial, { signal = null } = {}) {
      const checked = validateM6TypedInvocation(invocation);
      if (!checked.writePrimitive) invalid("read/wait primitives cannot cross the write TCB");
      assertM6PrivateMaterialBinding({ binding, invocation: checked, privateMaterial });
      if (signal?.aborted) {
        throw new ControlPlaneError("M6_TCB_DISPATCH_ABORTED", "M6 TCB dispatch authority was aborted before transport", { status: 409 });
      }
      const request = { ...rawRequest(checked, privateMaterial), devices: device.runtimeId };
      // Exactly one raw provider invocation is owned by one consumed slot.
      const result = await transport.invoke(request);
      if (result?.code !== 10000) {
        throw new ControlPlaneError("M6_TCB_VENDOR_FAILURE", "bounded Xiaowei write did not succeed", { status: 502 });
      }
      return Object.freeze({ ok: true, primitive: checked.primitive, vendorCode: result.code });
    },
  });
}
