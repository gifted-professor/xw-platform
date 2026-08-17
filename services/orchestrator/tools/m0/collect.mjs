// M0 collector. Read-only identity + WIP forensics. Every external command used is
// a read-only git command, a read-only schtasks query, or a read-only process/net
// query — NEVER a mutating command. All token-like values are redacted before return.
//
// Git identity is fully testable against a temp repo. The Windows-runtime parts
// (schtasks XML, Get-Process, Get-NetTCPConnection) are no-ops returning honest
// null + confidence on non-Windows or when the target is unreachable.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

/** Run a git command in `cwd`, return trimmed stdout. Throws on non-zero exit. */
export function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }).replace(/\n$/, "");
}

/** Read-only: current HEAD commit sha of a repo. */
export function headSha(cwd) {
  return git(cwd, "rev-parse", "HEAD");
}

/** Read-only: porcelain v2 status counts {staged, unstaged, untracked}. */
export function statusCounts(cwd) {
  const out = git(cwd, "status", "--porcelain=v2", "--untracked-files=all");
  let staged = 0, unstaged = 0, untracked = 0;
  for (const line of out.split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith("u ")) { staged++; unstaged++; continue; } // unmerged
    if (line.startsWith("1 ") || line.startsWith("2 ")) {
      // XY field at positions 2-3: X=index, Y=worktree
      const x = line[2], y = line[3];
      if (x !== ".") staged++;
      if (y !== ".") unstaged++;
    } else if (line.startsWith("? ")) {
      untracked++;
    } else if (line.startsWith("! ")) {
      // ignored — counted separately if needed
    }
  }
  return { staged, unstaged, untracked };
}

/** Read-only: full porcelain v2 (-z) raw bytes for forensic archive. */
export function statusPorcelainV2Raw(cwd) {
  return execFileSync("git", ["-C", cwd, "status", "--porcelain=v2", "-z", "--untracked-files=all"]);
}

/** Read-only: `git ls-files --stage -z` raw bytes for forensic archive. */
export function lsFilesStageRaw(cwd) {
  return execFileSync("git", ["-C", cwd, "ls-files", "--stage", "-z"]);
}

/** Read-only: index→worktree patch (`git diff --binary --full-index`). */
export function unstagedPatch(cwd) {
  return execFileSync("git", ["-C", cwd, "diff", "--binary", "--full-index"], { maxBuffer: 128 * 1024 * 1024 });
}

/** Read-only: HEAD→index patch (`git diff --cached --binary --full-index HEAD`). */
export function stagedPatch(cwd) {
  return execFileSync("git", ["-C", cwd, "diff", "--cached", "--binary", "--full-index", "HEAD"], { maxBuffer: 128 * 1024 * 1024 });
}

/** Read-only: map of posix path → git stage mode for all tracked files. */
export function gitModeMap(cwd) {
  const raw = execFileSync("git", ["-C", cwd, "ls-files", "--stage", "-z"], { encoding: "utf8" });
  const map = new Map();
  for (const rec of raw.split("\0")) {
    if (!rec) continue;
    // "<mode> <sha> <stage>\t<path>"
    const sp = rec.indexOf(" ");
    const shaSp = rec.indexOf(" ", sp + 1);
    const tab = rec.indexOf("\t");
    if (sp < 0 || shaSp < 0 || tab < 0) continue;
    const mode = rec.slice(0, sp);
    const path = rec.slice(tab + 1);
    map.set(path.replace(/\\/g, "/"), mode);
  }
  return map;
}

/**
 * Collect source + worktree identity for one repo (read-only).
 * @param {string} cwd
 * @param {{name:string, inputCommitSha:string}} meta
 * @param {string} inputSha the fixed input-pair commit sha for this repo
 */
export function collectRepoIdentity(cwd, meta, inputSha) {
  const commitSha = headSha(cwd);
  const counts = statusCounts(cwd);
  let ref = null, repoOrigin = null;
  try { ref = git(cwd, "rev-parse", "--abbrev-ref", "HEAD"); } catch { ref = null; }
  if (ref === "HEAD") ref = "(detached)";
  try { repoOrigin = git(cwd, "config", "--get", "remote.origin.url"); } catch { repoOrigin = null; }
  return {
    name: meta.name,
    path: cwd,
    source: {
      commitSha,
      ref,
      repoOrigin,
      verifiedAgainstInputPair: commitSha.toLowerCase() === String(inputSha).toLowerCase(),
    },
    worktree: {
      commitSha,
      dirty: counts.staged + counts.unstaged + counts.untracked > 0,
      stagedCount: counts.staged,
      unstagedCount: counts.unstaged,
      untrackedCount: counts.untracked,
    },
  };
}

/** Redact a command line: keep the program + flags, mask anything after --token/--agent-token/etc. */
export function redactCommandLine(line) {
  if (!line) return null;
  return String(line).replace(
    /(--?(?:token|agent-token|human-token|observer-token|operator-token|human-actor))\s+(\S+)/gi,
    (_, flag) => `${flag} <redacted>`,
  );
}

/**
 * Windows-runtime attestation (read-only). Returns confidence=unreachable with nulls
 * on non-Windows or when the process can't be found. Never asserts processLoadedBytes.
 * @param {{taskName?:string, entryPath?:string, port?:number}} cfg
 */
export function collectRuntimeAttestation(cfg) {
  const isWin = process.platform === "win32";
  if (!isWin) {
    return {
      processLaunchPath: null,
      processStartTime: null,
      processCommandLineRedacted: null,
      diskBytesAtObservation: null,
      confidence: "unreachable",
    };
  }
  let launchPath = null, startTime = null, cmdLine = null;
  try {
    if (cfg.entryPath) {
      // find a node process whose command line references the entry path
      const out = execFileSync("powershell", [
        "-NoProfile", "-Command",
        `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Select-Object -Property CommandLine,CreationDate | Format-List`,
      ], { encoding: "utf8" });
      for (const block of out.split(/\r?\n\r?\n/)) {
        if (block.toLowerCase().includes(String(cfg.entryPath).toLowerCase())) {
          const cl = /CommandLine\s*:\s*(.+)/i.exec(block);
          const cd = /CreationDate\s*:\s*(.+)/i.exec(block);
          if (cl) cmdLine = cl[1].trim();
          if (cd) startTime = cd[1].trim();
          launchPath = "node";
          break;
        }
      }
    }
  } catch { /* not reachable — degrade */ }

  let diskBytes = null;
  try {
    if (cfg.entryPath && existsSync(cfg.entryPath)) {
      const st = statSync(cfg.entryPath);
      const bytes = readFileSync(cfg.entryPath);
      diskBytes = {
        entryPath: cfg.entryPath,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.length,
        mtimeIso: st.mtime.toISOString(),
      };
    }
  } catch { /* leave null */ }

  const reachable = !!(launchPath || diskBytes);
  return {
    processLaunchPath: launchPath,
    processStartTime: startTime,
    processCommandLineRedacted: redactCommandLine(cmdLine),
    diskBytesAtObservation: diskBytes,
    confidence: reachable ? "directlyObserved" : "unreachable",
  };
}