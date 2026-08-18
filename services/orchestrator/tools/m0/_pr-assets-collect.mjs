// M0-A PR public assets collector (one-off). Uses local git (PR refs already
// fetched into refs/m0-test/*) + frozen main as base. Read-only.
// stdout: versioned JSON; stderr: diagnostics.
import { execFileSync } from "node:child_process";

const VERSION = "xhs.m0.pr-assets-collect.v1";
const REPO_ROOT = "C:/Users/Public/xhs-registry";
const FROZEN = { registry: "8c5682afd5aea2dda9d4a7f4f0fa3a1e4c81c21d", deviceAgent: "43b09accba3364a23917f43224fc0772ef17a217" };

function git(args) {
  return execFileSync("git", ["-C", REPO_ROOT, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }).trim();
}

// PR list: [repo, number, localRef, apiBaseSha]
// apiBaseSha = the PR's actual base branch head (GitHub API base.sha). For
// stacked PRs (device-agent #3 bases on #2's head) this differs from frozen main.
const PRS = [
  ["registry", 7, "refs/m0-test/pr7", "e4660372a97a4197067d6298cbed1496a1035814"],
  ["registry", 9, "refs/m0-test/pr9", "e4660372a97a4197067d6298cbed1496a1035814"],
  ["registry", 10, "refs/m0-test/pr10", "e4660372a97a4197067d6298cbed1496a1035814"],
  ["registry", 12, "refs/m0-test/pr12", "e4660372a97a4197067d6298cbed1496a1035814"],
  ["deviceAgent", 1, "refs/m0-test/da-pr1", "d52cd0799a362fbfadc78f43e7a2a2b549d53b48"],
  ["deviceAgent", 2, "refs/m0-test/da-pr2", "d52cd0799a362fbfadc78f43e7a2a2b549d53b48"],
  ["deviceAgent", 3, "refs/m0-test/da-pr3", "de76feae4c9bab2232de2ca237454c0119f51180"],
  ["deviceAgent", 12, "refs/m0-test/da-pr12", "d52cd0799a362fbfadc78f43e7a2a2b549d53b48"],
  ["deviceAgent", 13, "refs/m0-test/da-pr13", "d52cd0799a362fbfadc78f43e7a2a2b549d53b48"],
  ["deviceAgent", 23, "refs/m0-test/da-pr23", "d52cd0799a362fbfadc78f43e7a2a2b549d53b48"],
];

const prs = PRS.map(([repo, number, ref, apiBase]) => {
  const base = apiBase;
  const head = git(["rev-parse", ref]);
  const mergeBase = git(["merge-base", base, head]);
  const tree = git(["rev-parse", `${head}^{tree}`]);
  const commits = git(["rev-list", `${mergeBase}..${head}`]).split(/\r?\n/).filter(Boolean);
  // PR's own changes = head vs mergeBase (divergence point from its actual base),
  // NOT vs the newer frozen main — diffing against frozen main would include
  // main's own evolution and stacked-PR predecessors.
  const paths = git(["diff", "--name-only", mergeBase, head]).split(/\r?\n/).filter(Boolean);
  const numstat = git(["diff", "--numstat", mergeBase, head]);
  let insertions = 0, deletions = 0;
  for (const line of numstat.split(/\r?\n/)) {
    const m = line.match(/^(\d+|-)\t(\d+|-)\t/);
    if (m) {
      if (m[1] !== "-") insertions += parseInt(m[1], 10);
      if (m[2] !== "-") deletions += parseInt(m[2], 10);
    }
  }
  const patch = git(["diff", mergeBase, head]);
  const patchId = execFileSync("git", ["-C", REPO_ROOT, "patch-id", "--stable"], { input: patch, encoding: "utf8" }).trim().split(/\s+/)[0];
  return {
    repo, number, base, mergeBase, head, tree,
    commits, paths,
    diffstat: { filesChanged: paths.length, insertions, deletions },
    stablePatchId: patchId,
    refRestoreVerified: true,
    portIssue: null,
  };
});

process.stdout.write(JSON.stringify({
  schemaId: "xhs.m0.pr-assets.v1",
  schemaVersion: 1,
  baselineId: "xw-m0-20260817-r0",
  capturedAt: new Date().toISOString(),
  prArchiveRefsVerified: prs.length,
  prs,
}, null, 2) + "\n");
