/**
 * return-home.mjs — default post-job return to system launcher (desktop).
 *
 * After adapter.restore, control-plane presses HOME and checks focus is a known
 * launcher. Soft by default: failure is recorded on restoration.returnHome and
 * does not quarantine. Skip on recoveryAttempt (visual main-safe needs App UI).
 */
import { GatewayOperator } from "../../scripts/gateway-operator.mjs";

export const LAUNCHER_PACKAGE_RE =
  /^(com\.miui\.home|com\.android\.launcher3?|com\.google\.android\.apps\.nexuslauncher|com\.huawei\.android\.launcher|com\.sec\.android\.app\.launcher|com\.oppo\.launcher|com\.vivo\.launcher)$/i;

export function isLauncherPackage(pkg) {
  return LAUNCHER_PACKAGE_RE.test(String(pkg || "").trim());
}

/**
 * Default ON. Opt out with XHS_RETURN_HOME_AFTER_JOB=0 or XHS_SKIP_RETURN_HOME=1.
 * recoveryAttempt jobs never return home (recover-main-safe needs App foreground).
 * lab_only / Explorer session primitives also skip — each action must leave App UI intact.
 */
export function shouldReturnHomeAfterJob({
  env = process.env,
  recoveryAttempt = false,
  capability = null,
  execution = null,
} = {}) {
  if (recoveryAttempt) return false;
  if (execution?.output?.awaitingAccept === true) return false;
  if (execution?.output?.leaveOnCompose === true) return false;
  if (env.XHS_SKIP_RETURN_HOME === "1") return false;
  if (env.XHS_RETURN_HOME_AFTER_JOB === "0") return false;
  if (capability?.automationPolicy?.mode === "lab_only") return false;
  if (capability?.id === "xiaowei.explorer.primitive" || capability?.id === "xiaowei.lab.raw") return false;
  return true;
}

function settle(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Press HOME via GatewayOperator (lease-gated). Returns a small receipt object.
 * Entire path is soft-fail — including GatewayOperator.start() — so a bad
 * lease/gateway probe never escalates to RESTORATION_FAILED / recovery_required.
 */
export async function returnDeviceHome({
  device,
  leaseAuthorization,
  GatewayOperatorImpl = GatewayOperator,
  settleMs = 800,
  transportToken = null,
  typedTransport = null,
} = {}) {
  const serial = device?.runtimeId;
  if (!serial) {
    return { ok: false, skipped: true, reason: "device_runtime_id_missing" };
  }
  if (!leaseAuthorization?.leaseId || !leaseAuthorization?.token || !leaseAuthorization?.deviceId) {
    return { ok: false, skipped: true, reason: "lease_context_missing" };
  }

  // Foundation PR3: when CP mints return_home authority, consume it before Gateway I/O.
  if (typedTransport && transportToken) {
    try {
      await typedTransport.invoke({
        purpose: "return_home",
        action: "pressHome",
        transportToken,
        deviceId: leaseAuthorization.deviceId,
        leaseId: leaseAuthorization.leaseId,
      });
    } catch (error) {
      return {
        ok: false,
        reason: "return_home_transport_auth",
        error: String(error?.message || error).slice(0, 240),
        code: error?.code || null,
      };
    }
  }

  let op = null;
  try {
    op = await new GatewayOperatorImpl({
      serial,
      leaseAuthorization,
    }).start();
    await op.home();
    await settle(settleMs);
    // One bounce if still inside an app (some OEM home needs double-press).
    let focus = await op.currentFocus();
    if (!isLauncherPackage(focus.package)) {
      await op.home();
      await settle(settleMs);
      focus = await op.currentFocus();
    }
    const ok = isLauncherPackage(focus.package);
    return {
      ok,
      packageName: focus.package || null,
      activity: focus.activity || null,
      reason: ok ? "launcher_focus" : "not_launcher_after_home",
    };
  } catch (error) {
    return {
      ok: false,
      reason: "return_home_error",
      error: String(error?.message || error).slice(0, 240),
    };
  } finally {
    try { await op?.close?.(); } catch { /* ignore */ }
  }
}
