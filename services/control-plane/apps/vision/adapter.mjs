import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

import { ControlPlaneError } from "../../control-plane/lib/errors.mjs";
import {
  fingerprintLabels,
  gateTap,
  hasXianyuMainTabbarFingerprint,
  isForbiddenLabel,
  resolveTarget,
} from "../../scripts/vision-safety.mjs";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/**
 * vision adapter — 语义/视觉 resolve 安全闸 dry-run
 * 默认只 resolve 不 tap；executeTap 时仍经黑名单 + region + 指纹。
 */
export function createVisionAdapter({
  GatewayOperatorClass = null,
} = {}) {
  return {
    id: "vision",
    async execute({ capability, device, params }) {
      if (capability.implementation.action !== "resolve-tap-dry-run") {
        throw new ControlPlaneError("VISION_ACTION_UNKNOWN", `unknown action ${capability.implementation.action}`, { status: 400 });
      }

      const label = String(params.label || "").trim();
      const region = params.region || null;
      const requireSafeNav = params.requireSafeNav === true || region === "tabbar";
      const executeTap = params.executeTap === true;

      if (!label) {
        throw new ControlPlaneError("PARAMS_SCHEMA_INVALID", "label required", { status: 400 });
      }
      if (isForbiddenLabel(label)) {
        return {
          vendorCode: 0,
          output: {
            ok: false,
            step: "blocked",
            reason: "forbidden_needle",
            label,
            executeTap: false,
            stoppedBeforeOutbound: true,
          },
        };
      }

      let elements = Array.isArray(params.elements) ? params.elements : null;
      let focus = null;
      let resolution = Array.isArray(params.resolution) ? params.resolution : [1080, 2400];
      let op = null;

      if (!elements) {
        if (!device?.runtimeId) {
          throw new ControlPlaneError("DEVICE_RUNTIME_ID_MISSING", "vision resolve needs device when elements omitted", { status: 503 });
        }
        const { GatewayOperator } = await import(pathToFileURL(join(root, "scripts/gateway-operator.mjs")).href);
        const GO = GatewayOperatorClass || GatewayOperator;
        op = await new GO({ serial: device.runtimeId }).start();
        try {
          const { snapshot, center } = await import(pathToFileURL(join(root, "scripts/xianyu-operator.mjs")).href);
          const snap = await snapshot(op, "vision-resolve");
          focus = snap.focus || null;
          elements = (snap.nodes || []).filter((n) => n.bounds).map((n) => ({
            label: n.label || "",
            bounds: n.bounds,
            center: n.bounds ? center(n.bounds) : null,
            conf: 1,
            source: "semantic",
          }));
          let maxX = 1080, maxY = 2400;
          for (const e of elements) {
            if (e.bounds) {
              maxX = Math.max(maxX, e.bounds[2]);
              maxY = Math.max(maxY, e.bounds[3]);
            }
          }
          resolution = [maxX, maxY];
        } finally {
          await op.close?.().catch(() => null);
          op = null;
        }
      }

      const fp = fingerprintLabels(elements);
      const gate = gateTap({ label, region, fingerprintLabels: fp, app: "xianyu" });
      if (region === "tabbar" && !hasXianyuMainTabbarFingerprint(fp) && !params.elements) {
        // only enforce xianyu tabbar fingerprint when we dumped live device
        // (offline elements may be any app)
      }

      const resolved = resolveTarget(elements, {
        label,
        region,
        resolution,
        requireSafeNav,
      });

      if (!resolved.ok) {
        return {
          vendorCode: 0,
          output: {
            ok: false,
            step: "resolve",
            reason: resolved.reason,
            label,
            region,
            fingerprint: [...fp].slice(0, 40),
            focus,
            executeTap: false,
            stoppedBeforeOutbound: true,
          },
        };
      }

      // tabbar 指纹：live dump 时强制
      if (region === "tabbar" && !params.elements && !hasXianyuMainTabbarFingerprint(fp)) {
        return {
          vendorCode: 0,
          output: {
            ok: false,
            step: "fingerprint",
            reason: "xianyu_tabbar_fingerprint_missing",
            label,
            region,
            target: resolved.target,
            fingerprint: [...fp].slice(0, 40),
            executeTap: false,
            stoppedBeforeOutbound: true,
          },
        };
      }

      if (isForbiddenLabel(resolved.target?.label)) {
        return {
          vendorCode: 0,
          output: {
            ok: false,
            step: "blocked",
            reason: "forbidden_target",
            target: resolved.target,
            executeTap: false,
            stoppedBeforeOutbound: true,
          },
        };
      }

      let tapped = false;
      if (executeTap && resolved.target?.center) {
        const g2 = gateTap({
          label: resolved.target.label,
          region,
          fingerprintLabels: fp,
          app: "xianyu",
        });
        if (!g2.allow) {
          return {
            vendorCode: 0,
            output: {
              ok: false,
              step: "gate",
              reason: g2.reason,
              target: resolved.target,
              executeTap: false,
              stoppedBeforeOutbound: true,
            },
          };
        }
        const { GatewayOperator } = await import(pathToFileURL(join(root, "scripts/gateway-operator.mjs")).href);
        const GO = GatewayOperatorClass || GatewayOperator;
        op = await new GO({ serial: device.runtimeId }).start();
        try {
          const [x, y] = resolved.target.center;
          await op.tap(x, y);
          tapped = true;
        } finally {
          await op.close?.().catch(() => null);
        }
      }

      return {
        vendorCode: 0,
        output: {
          ok: true,
          step: tapped ? "tapped" : "resolved",
          reason: "ok",
          label,
          region,
          target: resolved.target,
          candidates: resolved.candidates,
          fingerprint: [...fp].slice(0, 40),
          focus,
          executeTap: tapped,
          stoppedBeforeOutbound: true,
          gate,
        },
      };
    },

    async verify({ capability, execution }) {
      const out = execution.output;
      if (!out) return { ok: false, mode: "state" };
      // blocked / no_match 是明确结果，不算执行器崩溃
      if (out.step === "blocked" || out.step === "resolve" || out.step === "fingerprint" || out.step === "gate") {
        return { ok: true, mode: "state", note: out.reason };
      }
      return {
        ok: out.ok === true && out.stoppedBeforeOutbound === true,
        mode: "state",
      };
    },

    async restore() {
      return { ok: true };
    },
  };
}
