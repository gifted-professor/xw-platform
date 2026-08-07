#!/usr/bin/env node
/**
 * Multi-device no-action Explorer session canary (non-payment).
 *
 *   node ops/xw-session-canary-noop.mjs --aliases 01,02 --actor <actor> [--run-tag <tag>]
 *
 * Per alias: acquire → assert lease visible on control plane → status → finally release.
 * Concurrent across aliases; never launches apps / taps / payments.
 * Console: console.log only.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";

const ROOT = "C:\\Users\\Public\\xhs-registry";
const CONTROL = (process.env.XHS_CONTROL_URL || "http://127.0.0.1:17920").replace(/\/$/, "");
const REGISTRY = (process.env.XHS_REGISTRY_URL || "http://127.0.0.1:17930").replace(/\/$/, "");

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--") && argv[i + 1] && !argv[i + 1].startsWith("--")) out[a.slice(2)] = argv[++i];
    else if (a.startsWith("--")) out[a.slice(2)] = true;
    else out._.push(a);
  }
  return out;
}

function runNode(args, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timeout ${args.join(" ")}`));
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const text = await res.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text.slice(0, 200) }; }
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return body;
}

async function canaryOne({ alias, actor, sessionFile }) {
  const result = { alias, ok: false, sessionId: null, leaseId: null };
  try {
    const acq = await runNode([
      join(ROOT, "ops", "xw-explore-session.mjs"),
      "acquire",
      "--alias", alias,
      "--actor", actor,
      "--session-file", sessionFile,
    ]);
    if (acq.code !== 0) throw new Error(`acquire exit ${acq.code}: ${acq.stdout || acq.stderr}`);
    const acqJson = JSON.parse(acq.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1));
    if (!acqJson.ok) throw new Error(`acquire not ok: ${acq.stdout}`);
    result.sessionId = acqJson.sessionId;
    result.leaseId = acqJson.leaseId;

    const leases = await fetchJson(`${CONTROL}/control/v1/leases`);
    const hit = (leases.leases || []).find((l) => l.leaseId === result.leaseId);
    if (!hit) throw new Error(`lease not visible: ${result.leaseId}`);
    result.leaseVisible = true;
    result.holderId = hit.holderId;

    const st = await runNode([
      join(ROOT, "ops", "xw-explore-session.mjs"),
      "status",
      "--session-file", sessionFile,
    ]);
    if (st.code !== 0) throw new Error(`status exit ${st.code}: ${st.stdout || st.stderr}`);
    const stJson = JSON.parse(st.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1));
    if (!stJson.ok) throw new Error(`status not ok: ${st.stdout}`);
    result.statusOk = true;
    result.ok = true;
  } finally {
    try {
      const rel = await runNode([
        join(ROOT, "ops", "xw-explore-session.mjs"),
        "release",
        "--session-file", sessionFile,
      ]);
      result.releaseCode = rel.code;
      try {
        result.release = JSON.parse(rel.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) || "{}");
      } catch {
        result.releaseRaw = rel.stdout.slice(0, 300);
      }
    } catch (err) {
      result.releaseError = String(err?.message || err);
      result.ok = false;
    }
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const actorBase = args.actor || "grok-p1-session-canary";
  const aliases = String(args.aliases || "01")
    .split(/[,:\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!aliases.length || aliases.some((a) => !/^0[1-4]$/.test(a))) {
    console.log(JSON.stringify({ ok: false, error: "aliases must be subset of 01-04" }));
    process.exit(2);
  }
  const tag = args["run-tag"] || `noop-${Date.now()}`;
  // Context path must be a direct child of ~/.xhs-explorer-sessions (no subdirs).
  const sessionRoot = join(homedir(), ".xhs-explorer-sessions");
  mkdirSync(sessionRoot, { recursive: true });

  const preEntry = await fetchJson(`${REGISTRY}/api/agent-entry`);
  const preLeases = await fetchJson(`${CONTROL}/control/v1/leases`);
  if ((preLeases.leases || []).length > 0 || (preEntry.controlPlane?.activeLeases || 0) > 0) {
    console.log(JSON.stringify({
      ok: false,
      error: "fleet not idle before canary",
      activeLeases: preEntry.controlPlane?.activeLeases,
      leaseCount: (preLeases.leases || []).length,
    }, null, 2));
    process.exit(2);
  }

  const jobs = aliases.map((alias) => {
    const actor = aliases.length === 1 ? actorBase : `${actorBase}-${alias}`;
    const sessionFile = join(sessionRoot, `${tag}-${alias}.json`);
    return canaryOne({ alias, actor, sessionFile });
  });
  const perAlias = await Promise.all(jobs);

  const postLeases = await fetchJson(`${CONTROL}/control/v1/leases`);
  const postEntry = await fetchJson(`${REGISTRY}/api/agent-entry`);
  const zeroOk = (postLeases.leases || []).length === 0
    && (postEntry.controlPlane?.activeLeases || 0) === 0
    && (postEntry.jobs?.active || []).length === 0;
  const allOk = perAlias.every((r) => r.ok && r.leaseVisible && r.release?.ok !== false) && zeroOk;

  const report = {
    ok: allOk,
    tag,
    aliases,
    accepted: perAlias.filter((r) => r.ok).length,
    failed: perAlias.filter((r) => !r.ok).length,
    perAlias,
    zero: {
      leaseCount: (postLeases.leases || []).length,
      activeLeases: postEntry.controlPlane?.activeLeases ?? null,
      activeJobs: (postEntry.jobs?.active || []).length,
      pending: postEntry.approvals?.pendingCount ?? null,
      devices: (postEntry.devices || []).map((d) => ({
        alias: d.alias,
        ready: d.state?.ready,
        leaseFree: d.state?.leaseFree,
      })),
    },
    paymentTransport: 0,
    finalCommit: false,
    note: "no-action session canary; no app launch/tap/payment",
  };

  const outPath = join(ROOT, "runtime", `session-canary-${tag}.json`);
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ...report, reportPath: outPath }, null, 2));
  process.exit(allOk ? 0 : 2);
}

main().catch((err) => {
  console.log(JSON.stringify({ ok: false, error: String(err?.message || err) }));
  process.exit(1);
});
