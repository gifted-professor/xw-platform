import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const registryRoot = process.env.XHS_REGISTRY_ROOT
  ? resolve(process.env.XHS_REGISTRY_ROOT)
  : null;

const pairs = [
  ["nonpayment-autonomy.v1.schema.json", "nonpayment-autonomy.schema.json"],
  ["explorer-run.v1.schema.json", "explorer-run.schema.json"],
  ["trace.v1.schema.json", "trace.schema.json"],
  ["payment-approval.v1.schema.json", "payment-approval.schema.json"],
  ["cross-repo-release.v1.schema.json", "cross-repo-release.schema.json"]
];

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function git(...args) {
  const result = spawnSync("git", args, { cwd: new URL("../", import.meta.url), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

test("shared named contracts are byte-identical to the Mac canonical copies", {
  skip: !registryRoot || !existsSync(resolve(registryRoot, "contracts"))
}, () => {
  for (const [canonicalName, localName] of pairs) {
    const canonical = resolve(registryRoot, "contracts", canonicalName);
    const local = new URL(`../control-plane/schema/${localName}`, import.meta.url);
    assert.equal(sha256(local), sha256(canonical), `${localName} drifted from ${canonicalName}`);
  }
});

test("repository B changes stay inside the approved exact scope", {
  skip: !registryRoot || !existsSync(resolve(registryRoot, "docs/plans/2026-08-01-review-explorer-payment-only-gate-plan.files.json"))
}, () => {
  const scope = JSON.parse(readFileSync(resolve(registryRoot, "docs/plans/2026-08-01-review-explorer-payment-only-gate-plan.files.json"), "utf8"));
  const repoScope = scope.repositories.B;
  const changed = git("diff", "--name-only", repoScope.baseline).split("\n").filter(Boolean);
  const untracked = git("ls-files", "--others", "--exclude-standard").split("\n").filter(Boolean);
  const paths = [...new Set([...changed, ...untracked])].sort();
  const outside = paths.filter((path) => !repoScope.allowedFiles.includes(path)
    && !repoScope.allowedPrefixes.some((prefix) => path.startsWith(prefix)));
  assert.deepEqual(outside, [], `plan-external files: ${outside.join(", ")}`);
});
