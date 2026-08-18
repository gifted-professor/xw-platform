/**
 * recipe-attempt-receipt.mjs — server-side attempt receipt v2 (G2/C3)
 * Client may only supply recipeId/revision/runId/jobId (+ optional workerWindowId).
 * Facts come from control-plane job + optional run manifest, never client booleans.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const RECEIPT_SCHEMA = "xhs.recipe-attempt-receipt.v2";

export function canonicalJson(value) {
  return JSON.stringify(value);
}

export function hashCanonical(value) {
  return createHash("sha256").update(`${canonicalJson(value)}\n`).digest("hex");
}

/**
 * @param {object} job — control-plane job record (job or {job})
 * @param {object} opts
 */
export function buildAttemptReceiptFromJob(jobInput, {
  recipeId,
  revision,
  descriptorHash = null,
  expectedCapabilityId = null,
  expectedRunId = null,
  workerWindowId = null,
  releaseId = null,
  gitCommit = null,
  policyVersion = null,
  overlayHash = null,
  runsRoot = process.env.XHS_RUNS_ROOT || "C:\\Users\\Public\\xhs-agent-runs",
} = {}) {
  const job = jobInput?.job || jobInput;
  if (!job || typeof job !== "object") {
    return reject("JOB_MISSING", "control-plane job is required");
  }
  const jobId = job.jobId;
  const runId = job.runId;
  if (!jobId || !runId) return reject("JOB_IDS_MISSING", "jobId/runId required");
  if (expectedRunId && expectedRunId !== runId) {
    return reject("RUN_MISMATCH", `client runId ${expectedRunId} != job.runId ${runId}`);
  }
  if (job.status !== "succeeded") {
    return reject("NOT_SUCCEEDED", `job status is ${job.status}`, { status: job.status });
  }
  const capabilityId = job.capabilityId || job.capability?.id || null;
  if (expectedCapabilityId && capabilityId !== expectedCapabilityId) {
    return reject("CAPABILITY_MISMATCH", `expected ${expectedCapabilityId}, got ${capabilityId}`);
  }

  const verification = job.result?.verification || {};
  const restoration = job.result?.restoration || {};
  const verificationOk = verification.ok === true;
  const restorationOk = restoration.ok === true;
  if (!verificationOk) return reject("VERIFICATION_FAILED", "verification.ok is not true");
  // restoration.required false may omit ok; treat missing as ok only when capability says not required
  const restorationRequired = job.capability?.restoration?.required === true;
  if (restorationRequired && !restorationOk) {
    return reject("RESTORATION_FAILED", "restoration.ok is not true");
  }

  const evidence = collectEvidence(runId, runsRoot);
  if (evidence.debt) {
    return reject("EVIDENCE_DEBT", evidence.reason || "evidence debt present", { evidence });
  }

  const alias = job.routeDecision?.selectedDevice?.alias || null;
  const body = {
    schemaId: RECEIPT_SCHEMA,
    schemaVersion: 1,
    recipeId,
    revision: Number(revision),
    descriptorHash,
    jobId,
    runId,
    capabilityId,
    status: job.status,
    verificationOk: true,
    verificationHash: verification.hash || null,
    restorationOk: restorationRequired ? true : restorationOk !== false,
    restorationHash: restoration.hash || null,
    evidenceIds: evidence.ids,
    evidenceHashes: evidence.hashes,
    ambiguity: false,
    highDebt: false,
    alias,
    deviceId: job.deviceId || null,
    workerWindowId: workerWindowId || null,
    releaseId: releaseId || null,
    gitCommit: gitCommit || null,
    policyVersion: policyVersion || null,
    overlayHash: overlayHash || null,
    finishedAt: job.finishedAt || null,
  };
  const receiptHash = hashCanonical(body);
  return {
    ok: true,
    receipt: { ...body, receiptHash },
    verificationOk: true,
    restorationOk: body.restorationOk,
    result: "succeeded",
  };
}

function reject(code, message, extra = {}) {
  return { ok: false, code, message, ...extra };
}

function collectEvidence(runId, runsRoot) {
  const ids = [];
  const hashes = [];
  const manifestPath = join(runsRoot, runId, "manifest.json");
  if (!existsSync(manifestPath)) {
    // Job succeeded but no local manifest — allow empty with explicit note; caller may tighten.
    return { ids, hashes, debt: false, reason: "manifest_missing" };
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return { ids, hashes, debt: true, reason: "manifest_unreadable" };
  }
  const files = Array.isArray(manifest.evidence) ? manifest.evidence
    : Array.isArray(manifest.files) ? manifest.files
      : [];
  for (const item of files) {
    if (item?.debt === true) return { ids, hashes, debt: true, reason: "evidence_debt_flag" };
    if (item?.evidenceId) ids.push(item.evidenceId);
    if (item?.sha256) hashes.push(item.sha256);
  }
  return { ids, hashes, debt: false, reason: null };
}

/**
 * Fetch job from control-plane loopback. Injectible for tests.
 */
export async function fetchControlJob(jobId, {
  controlBase = process.env.XHS_CONTROL_BASE || "http://127.0.0.1:17920",
  fetchImpl = globalThis.fetch,
} = {}) {
  const url = `${controlBase.replace(/\/$/, "")}/control/v1/jobs/${encodeURIComponent(jobId)}`;
  const res = await fetchImpl(url, { method: "GET" });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw Object.assign(new Error(`control job fetch failed: ${res.status} ${text.slice(0, 200)}`), {
      status: res.status === 404 ? 404 : 502,
      code: "CONTROL_JOB_FETCH_FAILED",
    });
  }
  return res.json();
}
