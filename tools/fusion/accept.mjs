import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { verifyRepo } from "./verify.mjs";
import { git } from "./git.mjs";

function runNpm(root, args) {
  const result = spawnSync("npm", args, {
    cwd: root,
    encoding: "utf8",
    shell: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    args,
    exitCode: result.status ?? 1,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function lastJsonLine(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith("{")) return JSON.parse(lines[i]);
  }
  return null;
}

export function buildAcceptance(root) {
  const verify = verifyRepo(root);
  const check = runNpm(root, ["run", "check"]);
  const fusionTests = runNpm(root, ["run", "test:fusion"]);
  const m0 = runNpm(root, ["run", "test:m0"]);
  const gate = runNpm(root, ["run", "test:gate"]);
  const fusionJson = lastJsonLine(fusionTests.stdout);
  const m0Json = lastJsonLine(m0.stdout);
  const gateJson = lastJsonLine(gate.stdout);
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const blockers = [...(verify.blockers || [])];
  if (pkg.workspaces) blockers.push("workspaces enabled");
  if (check.exitCode !== 0) blockers.push("npm run check failed");
  if (fusionTests.exitCode !== 0) blockers.push("test:fusion failed");
  if (m0.exitCode !== 0) blockers.push("test:m0 failed");
  if (gate.exitCode !== 0) blockers.push("test:gate failed");
  if (existsSync(join(root, ".github/workflows/source-fusion.yml"))) {
    blockers.push(".github workflow present without workflow-scope confirmation");
  }
  const status = blockers.length ? "BLOCK" : "PASS";
  return {
    schemaId: "xhs.platform.fusion.physical-fusion-acceptance.v1",
    schemaVersion: 1,
    title: "Physical Fusion / M1 acceptance",
    targetRepo: "gifted-professor/xw-platform",
    acceptedAt: new Date().toISOString(),
    baseCommit: git(root, ["rev-parse", "HEAD"]).stdout.trim(),
    status,
    runtimeCutoverAllowed: false,
    sourceFusionGate: "OPEN",
    runtimeCutoverGate: "CLOSED",
    m0Status: "M0_CANDIDATE",
    m0Certification: "UNCERTIFIED",
    phases: {
      "F1-B": "MERGED",
      "F1-C": "MERGED",
      "F1-D": "MERGED",
      "F1-E": "MERGED",
      "F1-F": "MERGED",
      "F1-G": status === "PASS" ? "READY" : "BLOCK",
    },
    layout: {
      orchestrator: "services/orchestrator",
      controlPlane: "services/control-plane",
      fusionTools: "tools/fusion",
      rootPackageJson: true,
      workspacesEnabled: Boolean(pkg.workspaces),
      githubActionsLive: false,
      githubActionsSource: "docs/fusion/source-fusion.workflow.yml",
    },
    verify,
    commands: {
      check: { exitCode: check.exitCode },
      "test:fusion": { exitCode: fusionTests.exitCode, report: fusionJson },
      "test:m0": { exitCode: m0.exitCode, report: m0Json },
      "test:gate": { exitCode: gate.exitCode, report: gateJson },
    },
    blockers,
    notes: [
      "Imported service files were not modified.",
      "Root package.json forwards commands and does not enable npm workspaces.",
      "GitHub Actions YAML is stored at docs/fusion/source-fusion.workflow.yml because the current GitHub token lacks workflow scope.",
      "Runtime ports, databases, scheduled tasks, and devices are unchanged.",
    ],
  };
}
