import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { fingerprint } from "../../control-plane/lib/canonical.mjs";
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

function evidenceFiles(output) {
  const seen = new Set();
  return (Array.isArray(output?.evidenceFiles) ? output.evidenceFiles : [])
    .filter((file) => file && typeof file.path === "string" && !seen.has(file.path) && seen.add(file.path))
    .map((file) => ({
      path: file.path,
      kind: file.kind || "screenshot",
      label: file.label || "douyin",
    }));
}

function commandArgs({ script, action, device, params = {}, evidenceDirectory = null, job = null }) {
  if (!device.runtimeId) {
    throw new ControlPlaneError("DEVICE_RUNTIME_ID_MISSING", "Douyin adapter needs a private runtime ID", { status: 503 });
  }
  const args = [script, "--serial", device.runtimeId, "--transport", "gateway", action];
  if (action === "search" || action === "share-link") {
    const keyword = params.keyword ?? params.text;
    if (typeof keyword !== "string" || !keyword.trim()) {
      throw new ControlPlaneError("DOUYIN_KEYWORD_REQUIRED", `${action} requires params.keyword`, {
        status: 400,
      });
    }
    args.push("--keyword", String(keyword).trim());
  }
  if (action === "share-link-restore" && typeof params.keyword === "string" && params.keyword.trim()) {
    args.push("--keyword", params.keyword.trim());
  }
  if (["share-link", "share-link-restore", "share-link-recover", "inspect-recovery"].includes(action)) {
    if (!evidenceDirectory) {
      throw new ControlPlaneError("EVIDENCE_DIR_REQUIRED", "Douyin share-link needs an evidence directory", {
        status: 500,
      });
    }
    args.push("--evidence-dir", evidenceDirectory);
    if (job?.runId) args.push("--run-id", job.runId);
    if (job?.jobId) args.push("--job-id", job.jobId);
  }
  return args;
}

function isDouyinShareUrl(value) {
  return /^https:\/\/v\.douyin\.com\/[A-Za-z0-9_-]+\/$/.test(String(value || ""));
}

function writeShareLinkEvidence(evidenceDirectory, output) {
  mkdirSync(evidenceDirectory, { recursive: true });
  const path = join(evidenceDirectory, "douyin-share-link-observation.json");
  const url = isDouyinShareUrl(output?.url) ? output.url : null;
  const evidence = {
    schemaId: "xhs.douyin-share-link-observation.v1",
    schemaVersion: 1,
    observedAt: Number.isFinite(Date.parse(output?.observedAt)) ? output.observedAt : new Date().toISOString(),
    url,
    keywordFingerprint: typeof output?.keyword === "string" ? fingerprint(output.keyword) : null,
    keywordLength: typeof output?.keyword === "string" ? output.keyword.length : null,
    copied: output?.copied === true,
    openedDetail: output?.openedDetail === true,
    searchRestored: output?.searchRestored === true,
    backHome: output?.backHome === true,
    stoppedBeforeExternalShare: output?.stoppedBeforeExternalShare === true,
    externalShareTriggered: output?.externalShareTriggered === true,
    locatorFingerprint: fingerprint({
      imageFilter: output?.imageFilter?.bounds || null,
      selectedCard: output?.selectedCard?.bounds || null,
      shareButton: output?.shareButton?.bounds || null,
      shareLinkAction: output?.shareLinkAction?.bounds || null,
    }),
  };
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  const files = [{ path, kind: "observation", label: "douyin-share-link" }];
  const progressPath = join(evidenceDirectory, "progress.jsonl");
  if (existsSync(progressPath)) {
    files.push({ path: progressPath, kind: "progress", label: "douyin-share-link-progress" });
  }
  return files;
}

export function createDouyinAdapter({ run = runJsonCommand, operatorPath = defaultScript } = {}) {
  return {
    id: "douyin",
    async execute({ capability, device, params, evidenceDirectory, leaseAuthorization, job }) {
      requireFile(operatorPath, capability.id);
      const output = await run(process.execPath, commandArgs({
        script: operatorPath,
        action: capability.implementation.action,
        device,
        params,
        evidenceDirectory,
        job,
      }), { cwd: root, timeoutMs: capability.timeoutMs, env: operatorEnv(leaseAuthorization) });
      return {
        vendorCode: 0,
        output,
        evidenceFiles: capability.implementation.action === "share-link"
          ? writeShareLinkEvidence(evidenceDirectory, output)
          : [],
      };
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
      if (action === "share-link") {
        const ok = Boolean(
          output?.ok
          && isDouyinShareUrl(output?.url)
          && output?.text === output.url
          && output?.copied === true
          && output?.openedDetail === true
          && output?.searchRestored === true
          && output?.backHome === true
          && output?.stoppedBeforeExternalShare === true
          && output?.externalShareTriggered === false
          && output?.focus?.package === DOUYIN_PACKAGE
          && /SplashActivity/i.test(output?.focus?.activity || output?.focus?.raw || "")
        );
        return {
          ok,
          mode: "hash",
          hash: ok ? fingerprint({
            capabilityId: capability.id,
            url: output.url,
            copied: true,
            openedDetail: true,
            searchRestored: true,
            backHome: true,
            stoppedBeforeExternalShare: true,
            externalShareTriggered: false,
          }) : null,
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
    async restore({ capability, device, params, evidenceDirectory, leaseAuthorization, job, recoveryAttempt = false }) {
      if (!capability.restoration?.required) return { ok: true };
      if (capability.implementation.action === "share-link") {
        requireFile(operatorPath, capability.id);
        const action = recoveryAttempt ? "share-link-recover" : "share-link-restore";
        const output = await run(process.execPath, commandArgs({
          script: operatorPath,
          action,
          device,
          params,
          evidenceDirectory,
          job,
        }), { cwd: root, timeoutMs: 90000, env: operatorEnv(leaseAuthorization) });
        if (recoveryAttempt) {
          return {
            ok: output?.ok === true
              && output?.safeStateVerified === true
              && output?.zeroActionVerified === true,
            step: output?.step || null,
            focus: output?.focus || null,
            safeStateVerified: output?.safeStateVerified === true,
            zeroActionVerified: output?.zeroActionVerified === true,
            evidenceRequired: true,
            visualConfirmationRequired: true,
            evidenceFiles: evidenceFiles(output),
          };
        }
        return {
          ok: output?.ok === true && output?.safeStateVerified === true,
          step: output?.step || null,
          focus: output?.focus || null,
          keywordRestored: output?.keywordRestored ?? null,
        };
      }
      // search already backs to Splash inside the operator; restore is a soft ack.
      return { ok: true };
    },
    async inspectRecovery({ capability, device, evidenceDirectory, leaseAuthorization, job }) {
      requireFile(operatorPath, capability.id);
      const output = await run(process.execPath, commandArgs({
        script: operatorPath,
        action: "inspect-recovery",
        device,
        params: {},
        evidenceDirectory,
        job,
      }), { cwd: root, timeoutMs: 60000, env: operatorEnv(leaseAuthorization) });
      return {
        ok: output?.ok === true && output?.stoppedBeforeAction === true,
        step: output?.step || null,
        stoppedBeforeAction: output?.stoppedBeforeAction === true,
        observation: output?.observation || {},
        evidenceFiles: evidenceFiles(output),
      };
    },
  };
}
