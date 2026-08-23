import { ControlPlaneError } from "../../control-plane/lib/errors.mjs";
import { executeExplorerPrimitive } from "./explorer-primitive.mjs";
import { collectM64TargetEnvironmentQualification } from "./m6-target-environment-qualification.mjs";
import { readObservation } from "./read-observation.mjs";

const RAW_ALLOWLIST = new Set(["list", "Screen", "imeList"]);

export function createXiaoweiAdapter({ transport = null } = {}) {
  return {
    id: "xiaowei",
    async execute({
      capability,
      device,
      params,
      job,
      evidenceDirectory,
      leaseAuthorization,
      typedTransport = null,
      transportToken = null,
    }) {
      if (capability.id === "xiaowei.m6.grounded_run" || capability.implementation.action === "m6_grounded_run") {
        throw new ControlPlaneError(
          "M6_PRODUCTION_ENTRY_ONLY",
          "M6 grounded runs may execute only through the sealed Gate-F production entry",
          { status: 403 },
        );
      }
      // Foundation PR3 / INV-08: device I/O stays on constructor-injected transport.
      // TypedTransport (when present) only consumes one-time auth before that I/O.
      if (!transport || typeof transport.invoke !== "function") {
        if (capability.implementation.action === "m6_qualify_environment"
          && transport && typeof transport.runExclusive === "function") {
          // The fixed double-sample path uses the narrower exclusive channel;
          // it deliberately exposes no generic invoke method to its caller.
        } else {
        throw new ControlPlaneError(
          "TYPED_TRANSPORT_REQUIRED",
          "xiaowei adapter requires injected transport (TypedTransport Phase 1)",
          { status: 403 },
        );
        }
      }
      if (capability.implementation.action === "m6_qualify_environment"
        && (!job?.canary || device.alias !== "01")) {
        throw new ControlPlaneError(
          "M6_ENV_QUALIFICATION_JOB_INVALID",
          "target-environment qualification requires one alias-01 canary job",
          { status: 403 },
        );
      }
      if (typedTransport && transportToken) {
        await typedTransport.invoke({
          purpose: "execute",
          action: capability.implementation.action,
          transportToken,
          deviceId: leaseAuthorization?.deviceId || device.deviceId,
          leaseId: leaseAuthorization?.leaseId,
        });
      }
      if (capability.implementation.action === "explorer_primitive") {
        return executeExplorerPrimitive({
          transport,
          device,
          params,
          evidenceDirectory,
          leaseAuthorization,
          job,
        });
      }
      if (capability.implementation.action === "observe_frame") {
        // M6-2 W4 closed read-only observation. The capability input schema is
        // closed (no params), so nothing a caller sends can name an action,
        // coordinate, shell text, or URL. Mutating primitives live only in
        // explorer-primitive.mjs and are unreachable from here.
        if (!job?.canary) {
          throw new ControlPlaneError("CANARY_REQUIRED", "observe_frame requires canary session", { status: 403 });
        }
        const result = await readObservation({ transport, serial: device.runtimeId });
        return { vendorCode: result.vendorCode ?? 10000, output: result };
      }
      if (capability.implementation.action === "m6_qualify_environment") {
        // This is intentionally a formal canary Job path. The caller supplies
        // only one opaque account-isolation hash; the command registry and the
        // private runtime binding remain server-owned. Gate-F activation is
        // resource-zero gated, so this queued/running Job also fences an epoch
        // activation for the complete double sample.
        const result = await collectM64TargetEnvironmentQualification({
          transport,
          serial: device.runtimeId,
          alias: device.alias,
          gateMode: "CLOSED",
          accountIsolationBindingHash: params.accountIsolationBindingHash,
        });
        return { vendorCode: 10000, output: { m6EnvironmentQualification: result } };
      }
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
      if (capability.implementation.action === "explorer_primitive") {
        return { ok: execution.output?.ok === true, mode: capability.verification.mode };
      }
      if (capability.implementation.action === "observe_frame") {
        const out = execution.output || {};
        return {
          ok: out.ok === true && Boolean(out.capturedAt) && Boolean(out.observation) && Boolean(out.evidence),
          mode: capability.verification.mode,
        };
      }
      if (capability.implementation.action === "m6_qualify_environment") {
        const out = execution.output?.m6EnvironmentQualification || {};
        return {
          ok: out.attestation?.schemaId === "xw.m6-target-environment-attestation.v1"
            && /^[0-9a-f]{64}$/u.test(out.attestation?.attestationHash || "")
            && out.qualification?.schemaId === "xw.m6-environment-qualification.v1"
            && out.qualification?.status === "QUALIFIED"
            && out.qualification?.actionCount === 0,
          mode: capability.verification.mode,
        };
      }
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
