// A2 (M0-0B) WIP in-place read-only forensics collector.
// Runs the four read-only git commands TWICE consecutively, compares the two
// samples (must be byte-identical; if different, the run is discarded and must be
// re-sampled), then writes the private package artifacts to the ACL private dir.
//
// Artifacts (all private, encrypted at B1, never published):
//   git-status-porcelain-v2.bin   git status --porcelain=v2 -z --untracked-files=all
//   git-ls-files-stage.bin        git ls-files --stage -z
//   staged-index.patch            git diff --cached --binary --full-index HEAD
//   unstaged-worktree.patch       git diff --binary --full-index
//   untracked-private-files.tar   tar of untracked + ignored-private files
//   private-wip-manifest.json     file list + sizes + sha256 + classification
//   worktree-metadata.json        HEAD/index/mtime metadata
//   collector-transcript.jsonl    what was run, when, results
//
// Usage: node a2-collect.mjs <repoRoot> <privateDir> <baselineId>
// stdout: versioned JSON; stderr: diagnostics; non-zero exit on BLOCK.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, statSync, readdirSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import { statusPorcelainV2Raw, lsFilesStageRaw, stagedPatch, unstagedPatch, git } from "./collect.mjs";

const VERSION = "xhs.m0.a2-collector.v1";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function runTwice(fn) {
  const a = fn();
  const b = fn();
  if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b) || !a.equals(b)) {
    throw new Error("BLOCK: consecutive samples differ — discard and re-sample");
  }
  return a;
}

function classifyIgnored(rel) {
  const base = rel.split("/")[0];
  // reproducible-cache: deps, caches, runtime artifacts, temp build products
  // (tmp-imgs/tmp-know are temp screenshots + temp JSON — NOT archived per plan)
  if (["node_modules", ".cache", "runtime", "backups", "outbox", "tmp-imgs", "tmp-know"].includes(base) || base.startsWith("tmp-")) {
    return "reproducible-cache";
  }
  if (rel === ".env" || rel.endsWith(".env") || rel.includes("identities.seed") || rel === "registry.db" || rel === "run_begin.ps1") {
    return "ignored-private";
  }
  if (rel.startsWith("ops/_probe") || rel.startsWith("ops/_tmp") || rel.startsWith(".claude/")) {
    return "ignored-private";
  }
  return "ignored-private"; // default: private (conservative — human re-classifies)
}

export async function main(argv) {
  const [repoRoot, privateDir, baselineId] = argv.slice(2);
  if (!repoRoot || !privateDir || !baselineId) {
    throw new Error("usage: a2-collect.mjs <repoRoot> <privateDir> <baselineId>");
  }
  mkdirSync(privateDir, { recursive: true });
  const transcript = [];
  const t0 = new Date().toISOString();
  const log = (ev) => { transcript.push({ ...ev, at: new Date().toISOString() }); };

  // 1. two consecutive samples of the four read-only commands
  log({ ev: "sample_start", repoRoot, baselineId });
  const status = runTwice(() => statusPorcelainV2Raw(repoRoot));
  log({ ev: "status_porcelain_v2", bytes: status.length, sha256: sha256(status) });
  const stage = runTwice(() => lsFilesStageRaw(repoRoot));
  log({ ev: "ls_files_stage", bytes: stage.length, sha256: sha256(stage) });
  const staged = runTwice(() => stagedPatch(repoRoot));
  log({ ev: "staged_patch", bytes: staged.length, sha256: sha256(staged) });
  const unstaged = runTwice(() => unstagedPatch(repoRoot));
  log({ ev: "unstaged_patch", bytes: unstaged.length, sha256: sha256(unstaged) });

  // 2. untracked + ignored file lists
  const untracked = [];
  for (const rec of status.toString("utf8").split("\0")) {
    if (!rec) continue;
    if (rec.startsWith("? ")) untracked.push(rec.slice(2));
  }
  const ignored = [];
  const ignOut = execFileSync("git", ["-C", repoRoot, "status", "--ignored", "--porcelain=v1"], { encoding: "utf8" });
  for (const line of ignOut.split(/\r?\n/)) {
    if (line.startsWith("!! ")) ignored.push(line.slice(3));
  }
  log({ ev: "file_lists", untrackedCount: untracked.length, ignoredCount: ignored.length });

  // 3. classify ignored
  const classified = ignored.map((p) => ({ path: p, classification: classifyIgnored(p) }));
  const unknownIgnored = classified.filter((c) => c.classification === "unclassified");
  log({ ev: "ignored_classified", byClass: classified.reduce((m, c) => (m[c.classification] = (m[c.classification] || 0) + 1, m), {}) });

  // 4. write artifacts
  writeFileSync(join(privateDir, "git-status-porcelain-v2.bin"), status);
  writeFileSync(join(privateDir, "git-ls-files-stage.bin"), stage);
  writeFileSync(join(privateDir, "staged-index.patch"), staged);
  writeFileSync(join(privateDir, "unstaged-worktree.patch"), unstaged);

  // 5. untracked-private-files.tar — tar the untracked + ignored-private files
  const tarPaths = [...untracked, ...classified.filter((c) => c.classification === "ignored-private").map((c) => c.path)];
  const tarFile = join(privateDir, "untracked-private-files.tar");
  if (tarPaths.length) {
    // --force-local: Git Bash tar treats "C:/..." as host:path without it
    execFileSync("tar", ["--force-local", "-cf", tarFile, "-C", repoRoot, ...tarPaths], { stdio: ["ignore", "ignore", "pipe"] });
  } else {
    writeFileSync(tarFile, Buffer.alloc(0));
  }
  log({ ev: "tar_written", files: tarPaths.length, bytes: statSync(tarFile).size });

  // 6. private-wip-manifest.json
  const manifest = {
    schemaId: "xhs.m0.private-wip-manifest.v1",
    schemaVersion: 1,
    baselineId,
    capturedAt: t0,
    repoRoot,
    untracked: untracked.map((p) => {
      const abs = join(repoRoot, p);
      const st = statSync(abs);
      return { path: p, size: st.size, sha256: sha256(readFileSync(abs)) };
    }),
    ignored: classified.map((c) => {
      const abs = join(repoRoot, c.path);
      let size = null, h = null;
      try { const st = statSync(abs); size = st.isDirectory() ? null : st.size; } catch {}
      try { if (size !== null) h = sha256(readFileSync(abs)); } catch {}
      return { ...c, size, sha256: h };
    }),
    artifacts: {
      "git-status-porcelain-v2.bin": sha256(status),
      "git-ls-files-stage.bin": sha256(stage),
      "staged-index.patch": sha256(staged),
      "unstaged-worktree.patch": sha256(unstaged),
      "untracked-private-files.tar": sha256(readFileSync(tarFile)),
    },
    wipUnknownClassification: unknownIgnored.length,
  };
  writeFileSync(join(privateDir, "private-wip-manifest.json"), JSON.stringify(manifest, null, 2));

  // 7. worktree-metadata.json
  const meta = {
    schemaId: "xhs.m0.worktree-metadata.v1",
    schemaVersion: 1,
    baselineId,
    capturedAt: t0,
    repoRoot,
    head: git(repoRoot, "rev-parse", "HEAD"),
    branch: git(repoRoot, "rev-parse", "--abbrev-ref", "HEAD"),
    indexSha: sha256(stage),
    statusSha: sha256(status),
  };
  writeFileSync(join(privateDir, "worktree-metadata.json"), JSON.stringify(meta, null, 2));

  // 8. collector-transcript.jsonl
  writeFileSync(join(privateDir, "collector-transcript.jsonl"), transcript.map((l) => JSON.stringify(l)).join("\n") + "\n");

  process.stdout.write(JSON.stringify({
    cliVersion: VERSION,
    subcommand: "a2-collect",
    status: unknownIgnored.length ? "BLOCK" : "PASS",
    baselineId,
    untrackedCount: untracked.length,
    ignoredCount: ignored.length,
    ignoredByClass: classified.reduce((m, c) => (m[c.classification] = (m[c.classification] || 0) + 1, m), {}),
    wipUnknownClassification: unknownIgnored.length,
    artifacts: manifest.artifacts,
    privateDir,
  }) + "\n");
  if (unknownIgnored.length) process.exitCode = 1;
}

import { pathToFileURL } from "node:url";
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main(process.argv);
}