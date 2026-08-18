import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const KERNEL_CONTRACTS = [
  "repair-completion.v1.schema.json",
  "repair-event.v1.schema.json",
  "repair-proposal.v1.schema.json",
  "repair-replay-authorization.v1.schema.json",
  "repair-review-authority.v1.schema.json",
  "repair-source-checkpoint.v1.schema.json",
];

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function checkKernel(root) {
  const blockers = [];
  const files = [];
  const pkgPath = join(root, "package.json");
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    if (pkg.workspaces) blockers.push("root package.json must not enable npm workspaces");
  }

  for (const name of KERNEL_CONTRACTS) {
    const kernel = join(root, "packages/kernel/contracts", name);
    const orch = join(root, "services/orchestrator/contracts", name);
    const cp = join(root, "services/control-plane/contracts", name);
    const row = { name, kernel: existsSync(kernel), orchestrator: existsSync(orch), controlPlane: existsSync(cp) };
    if (!row.kernel || !row.orchestrator || !row.controlPlane) {
      blockers.push(`missing copy of ${name}`);
      files.push({ ...row, match: false });
      continue;
    }
    const hk = sha256File(kernel);
    const ho = sha256File(orch);
    const hc = sha256File(cp);
    const match = hk === ho && ho === hc;
    if (!match) blockers.push(`hash mismatch for ${name}`);
    files.push({ name, sha256: hk, match });
  }

  return {
    status: blockers.length ? "BLOCK" : "PASS",
    runtimeCutoverAllowed: false,
    workspacesEnabled: false,
    copiedNotDeleted: true,
    fileCount: KERNEL_CONTRACTS.length,
    files,
    blockers,
  };
}
