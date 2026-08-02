import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

const planUrl = new URL("../docs/plans/2026-08-01-review-explorer-payment-only-gate-plan.md", import.meta.url);
const scopeUrl = new URL("../docs/plans/2026-08-01-review-explorer-payment-only-gate-plan.files.json", import.meta.url);
const repairScopeUrl = new URL("../docs/plans/2026-08-02-mac-repair-command.files.json", import.meta.url);
const repoRoot = new URL("../", import.meta.url);
const scope = JSON.parse(readFileSync(scopeUrl, "utf8"));
const repairScope = JSON.parse(readFileSync(repairScopeUrl, "utf8"));

function git(...args) {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

function allowed(path, repoScope) {
  return repoScope.allowedFiles.includes(path)
    || repoScope.allowedPrefixes.some((prefix) => path.startsWith(prefix));
}

test("approved plan hash and authorization boundaries are frozen", () => {
  const planHash = createHash("sha256").update(readFileSync(planUrl)).digest("hex");
  assert.equal(planHash, scope.planSha256);
  assert.equal(scope.authorization.sourceImplementation, true);
  assert.equal(scope.authorization.windowsDarkDeploy, false);
  assert.equal(scope.authorization.realDevicePilot, false);
  assert.equal(scope.authorization.contentDeletionAutonomy, false);
  assert.equal(scope.authorization.permanentAccountClosureAutonomy, false);
  assert.equal(scope.authorization.privacyRetentionPolicy, "unapproved-no-automatic-deletion");
});

test("the earlier approved implementation remains frozen inside its own scope", () => {
  const repoScope = scope.repositories.A;
  const changed = git("diff", "--name-only", repoScope.baseline, repairScope.baseline).split("\n").filter(Boolean);
  const outside = changed.filter((path) => !allowed(path, repoScope));
  assert.deepEqual(outside, [], `earlier plan-external files: ${outside.join(", ")}`);
});

test("repository A current changes stay exclusively inside the repair command scope", () => {
  const taskScope = repairScope.repositories.A;
  const changed = git("diff", "--name-only", repairScope.baseline).split("\n").filter(Boolean);
  const untracked = git("ls-files", "--others", "--exclude-standard").split("\n").filter(Boolean);
  const paths = [...new Set([...changed, ...untracked])].sort();
  const outside = paths.filter((path) => !allowed(path, taskScope));
  assert.deepEqual(outside, [], `repair-scope-external files: ${outside.join(", ")}`);
});

test("Mac repair command scope preserves source-only authority and forbidden paths", () => {
  assert.equal(repairScope.baseline, "755fa6573e9d12ddd5d5834cda99c0838e6aa303");
  assert.equal(repairScope.authorization.macSourceImplementation, true);
  assert.equal(repairScope.authorization.commitAndPush, true);
  assert.equal(repairScope.authorization.windowsDeploy, false);
  assert.equal(repairScope.authorization.deviceActions, false);
  assert.equal(repairScope.authorization.jobOrSessionSubmit, false);
  assert.equal(repairScope.authorization.reviewVerdictByWindows, false);
  const repoScope = repairScope.repositories.A;
  for (const forbidden of repoScope.forbiddenFiles) assert.equal(allowed(forbidden, repoScope), false, `${forbidden} must stay forbidden`);
  for (const prefix of repoScope.forbiddenPrefixes) assert.equal(repoScope.allowedPrefixes.includes(prefix), false, `${prefix} must stay forbidden`);
});

test("scope entries are unique and do not authorize Windows runtime state", () => {
  for (const repoScope of [...Object.values(scope.repositories), ...Object.values(repairScope.repositories)]) {
    assert.equal(new Set(repoScope.allowedFiles).size, repoScope.allowedFiles.length);
    assert.equal(new Set(repoScope.allowedPrefixes).size, repoScope.allowedPrefixes.length);
  }
  const serialized = JSON.stringify(
    [...Object.values(scope.repositories), ...Object.values(repairScope.repositories)]
      .flatMap((repoScope) => [...repoScope.allowedFiles, ...repoScope.allowedPrefixes]),
  );
  for (const forbidden of ["task-launch.json", "control.db", "xhs-agent-runs"]) {
    assert.doesNotMatch(serialized, new RegExp(forbidden.replaceAll(".", "\\.")));
  }
});
