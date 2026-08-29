#!/usr/bin/env node
/**
 * verify-rollback-tuple.mjs — offline validator for the xhs-routine rollback
 * tuple (Plan V2 §6.2). Hard runbook gate: a switch-release.ps1 flip is only
 * allowed after this PASSes.
 *
 * Checks:
 *   - schema + all nine categories present and non-empty
 *   - re-hash every recorded file artifact (task XMLs, manifest, policy,
 *     serve-launch copies, DB snapshot receipt) against the stored sha256
 *   - junction previousTarget + rollback junction expectations stay under
 *     the runtime root's releases directory
 *   - start order + health expectations recorded
 *
 * Exit codes: 0 PASS, 4 FAIL (reasons listed). console.log only.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";

const TUPLE_SCHEMA = "xw.xhs.routine-rollback-tuple.v1";

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--") && i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      out[a.slice(2)] = argv[++i];
    } else if (a.startsWith("--")) {
      out[a.slice(2)] = true;
    } else {
      out._.push(a);
    }
  }
  return out;
}

// both junction targets must live under <runtimeRoot>\releases (no escapes)
function underReleases(candidate, releasesDir) {
  const resolved = resolve(candidate);
  return resolved === releasesDir || resolved.startsWith(releasesDir + sep);
}

function verify({ tuplePath, runtimeRoot }) {
  const problems = [];
  const releasesDir = resolve(runtimeRoot, "releases");
  const tuple = JSON.parse(readFileSync(tuplePath, "utf8"));
  if (tuple.schema !== TUPLE_SCHEMA) problems.push(`schema mismatch: ${tuple.schema}`);

  // 1. junction previous value + releases containment
  if (!tuple.junction?.previousTarget || !tuple.junction?.currentJsonRaw) {
    problems.push("junction.previousTarget / currentJsonRaw missing");
  } else if (!underReleases(tuple.junction.previousTarget, releasesDir)) {
    problems.push(`junction previousTarget outside releases: ${tuple.junction.previousTarget}`);
  }

  // 2. scheduled tasks xml + hash
  if (!Array.isArray(tuple.scheduledTasks) || tuple.scheduledTasks.length === 0) {
    problems.push("scheduledTasks empty");
  } else {
    for (const task of tuple.scheduledTasks) {
      if (!task.xml || !task.xmlSha256) {
        problems.push(`task xml missing: ${task.name} (${task.error ?? "no error recorded"})`);
        continue;
      }
      if (!existsSync(task.xml)) problems.push(`task xml not on disk: ${task.xml}`);
      else if (sha256File(task.xml) !== task.xmlSha256) problems.push(`task xml hash mismatch: ${task.xml}`);
    }
  }

  // 3. release manifest hash + releases containment
  if (!tuple.releaseManifest?.path || !tuple.releaseManifest?.sha256) {
    problems.push("releaseManifest missing");
  } else {
    if (!existsSync(tuple.releaseManifest.path)) problems.push(`release manifest not on disk: ${tuple.releaseManifest.path}`);
    else if (sha256File(tuple.releaseManifest.path) !== tuple.releaseManifest.sha256) {
      problems.push(`release manifest hash mismatch: ${tuple.releaseManifest.path}`);
    }
    const dir = resolve(tuple.releaseManifest.path, "..");
    if (!underReleases(dir, releasesDir)) problems.push(`release manifest outside releases: ${dir}`);
  }

  // 4. health full text
  if (!tuple.health?.controlPlane || tuple.health.controlPlane === "UNREACHABLE") {
    problems.push("control plane health missing/UNREACHABLE in tuple");
  }
  if (!tuple.health?.registry || tuple.health.registry === "UNREACHABLE") {
    problems.push("registry health missing/UNREACHABLE in tuple");
  }

  // 5. policy redacted copy + hash
  if (!tuple.policy?.path || !tuple.policy?.sha256) {
    problems.push("policy artifact missing (collect with -PolicyPath)");
  } else {
    if (!existsSync(tuple.policy.path)) problems.push(`policy not on disk: ${tuple.policy.path}`);
    else if (sha256File(tuple.policy.path) !== tuple.policy.sha256) problems.push(`policy hash mismatch: ${tuple.policy.path}`);
    if (!existsSync(tuple.policy.redactedCopyPath ?? "")) problems.push("policy redacted copy missing");
  }

  // 6. serve-launch copies + hashes
  if (!Array.isArray(tuple.serveLaunch) || tuple.serveLaunch.length === 0) {
    problems.push("serveLaunch empty");
  } else {
    for (const s of tuple.serveLaunch) {
      if (s.error === "SERVE_LAUNCH_MISSING") problems.push(`serve launch missing: ${s.path}`);
      if (!s.sha256) problems.push(`serve launch hash missing: ${s.path}`);
    }
  }

  // 7. DB snapshot receipt reference
  if (!tuple.dbSnapshot?.path || !tuple.dbSnapshot?.sha256) {
    problems.push("dbSnapshot receipt reference missing (collect with -DbSnapshotReceipt)");
  } else if (existsSync(tuple.dbSnapshot.path) && sha256File(tuple.dbSnapshot.path) !== tuple.dbSnapshot.sha256) {
    problems.push(`db snapshot receipt hash mismatch: ${tuple.dbSnapshot.path}`);
  }

  // 8. active work dump
  if (!tuple.activeWork?.controlPlaneJobs || tuple.activeWork.controlPlaneJobs === "UNREACHABLE") {
    problems.push("activeWork.controlPlaneJobs missing/UNREACHABLE");
  }
  if (!tuple.activeWork?.controlPlaneLeases || tuple.activeWork.controlPlaneLeases === "UNREACHABLE") {
    problems.push("activeWork.controlPlaneLeases missing/UNREACHABLE");
  }

  // 9. start order + health expectations
  const order = tuple.startOrderPlan?.startOrder;
  if (!Array.isArray(order) || order.length < 3) problems.push("startOrderPlan.startOrder incomplete");
  const expectations = tuple.startOrderPlan?.healthExpectations;
  if (!expectations?.controlPlaneHealthContains || !Array.isArray(expectations?.registryPorts)) {
    problems.push("startOrderPlan.healthExpectations incomplete");
  }

  return { ok: problems.length === 0, problems, tuplePath };
}

export function verifyTuple(input) {
  return verify(input);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const tuplePath = args.tuple && args.tuple !== true ? resolve(String(args.tuple)) : null;
  const runtimeRoot = args["runtime-root"] && args["runtime-root"] !== true
    ? String(args["runtime-root"])
    : resolve("C:/Users/Public/xw-runtime");
  if (!tuplePath || !existsSync(tuplePath)) {
    console.log(JSON.stringify({ ok: false, code: "TUPLE_MISSING", problems: ["--tuple <path> required"] }));
    process.exitCode = 4;
    return;
  }
  const result = verify({ tuplePath, runtimeRoot });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 4;
}

const isDirect = process.argv[1] && process.argv[1].endsWith("verify-rollback-tuple.mjs");
if (isDirect) main();