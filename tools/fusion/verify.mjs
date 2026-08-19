import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { compareListings, git, parseLsTree } from "./git.mjs";

const ZERO_FIELDS = [
  "blobMismatchCount",
  "modeMismatchCount",
  "missingFileCount",
  "extraFileCount",
  "advanceCommitCount",
  "commitCountMismatch",
];

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function loadPostImportAllowlist(root) {
  const path = join(root, "docs/fusion/post-import-allowlist.v1.json");
  if (!existsSync(path)) return { services: {} };
  const allowlist = loadJson(path);
  if (allowlist.runtimeCutoverAllowed !== false) {
    throw new Error("post-import-allowlist.runtimeCutoverAllowed must be false");
  }
  return allowlist;
}

export function applyPostImportAllowlist(cmp, serviceAllowlist = {}) {
  const allowedModified = new Set(serviceAllowlist.allowedModified || []);
  const allowedExtra = new Set(serviceAllowlist.allowedExtra || []);
  const allowlisted = [];
  const remaining = [];
  for (const detail of cmp.details || []) {
    if ((detail.kind === "blob" || detail.kind === "mode") && allowedModified.has(detail.path)) {
      allowlisted.push(detail);
    } else if (detail.kind === "extra" && allowedExtra.has(detail.path)) {
      allowlisted.push(detail);
    } else {
      remaining.push(detail);
    }
  }
  const count = (kind) => remaining.filter((detail) => detail.kind === kind).length;
  return {
    blobMismatchCount: count("blob"),
    modeMismatchCount: count("mode"),
    missingFileCount: count("missing"),
    extraFileCount: count("extra"),
    expectedCount: cmp.expectedCount,
    actualCount: cmp.actualCount,
    details: remaining,
    allowlisted,
    rawBlobMismatchCount: cmp.blobMismatchCount,
    rawModeMismatchCount: cmp.modeMismatchCount,
    rawMissingFileCount: cmp.missingFileCount,
    rawExtraFileCount: cmp.extraFileCount,
  };
}

function isAncestor(root, ancestor, descendant) {
  const r = git(root, ["merge-base", "--is-ancestor", ancestor, descendant], { allowFail: true });
  return r.status === 0;
}

function objectExists(root, spec) {
  const r = git(root, ["cat-file", "-e", spec], { allowFail: true });
  return r.status === 0;
}

function historyReachable(root, path) {
  const r = git(root, ["log", "--follow", "--format=%H", "--", path], { allowFail: true });
  if (r.status !== 0) return false;
  return r.stdout.split(/\r?\n/).some((line) => line.trim().length > 0);
}

function verifyReceipt(root, receipt, lock, lockRepo, allowlist = { services: {} }) {
  const blockers = [];
  const importDir = receipt.importDirectory;
  if (receipt.originalCommit !== lock[lockRepo].importCommit) {
    blockers.push(`${lockRepo}.originalCommit does not match source-lock`);
  }
  if (receipt.originalTreeSha !== lock[lockRepo].importTreeSha) {
    blockers.push(`${lockRepo}.originalTreeSha does not match source-lock`);
  }
  for (const field of ZERO_FIELDS) {
    if ((receipt[field] ?? 0) !== 0) blockers.push(`${lockRepo}.${field} must be 0`);
  }
  if (receipt.runtimeCutoverAllowed !== false) {
    blockers.push(`${lockRepo}.runtimeCutoverAllowed must be false`);
  }
  if (receipt.sourceFusionGate !== "OPEN") blockers.push(`${lockRepo}.sourceFusionGate must be OPEN`);
  if (receipt.runtimeCutoverGate !== "CLOSED") blockers.push(`${lockRepo}.runtimeCutoverGate must be CLOSED`);
  if (!receipt.sourceTreeMatchesLock) blockers.push(`${lockRepo}.sourceTreeMatchesLock must be true`);
  if (!receipt.rewrittenTipMapsFromImportCommit) {
    blockers.push(`${lockRepo}.rewrittenTipMapsFromImportCommit must be true`);
  }
  if (!Array.isArray(receipt.originalTreeListing) || receipt.originalTreeListing.length === 0) {
    blockers.push(`${lockRepo}.originalTreeListing missing`);
  }
  if (receipt.originalTrackedFileCount !== receipt.originalTreeListing.length) {
    blockers.push(`${lockRepo}.originalTrackedFileCount != listing length`);
  }

  const rewritten = receipt.rewrittenTipCommit;
  const fusion = receipt.fusionMergeCommit;
  if (!objectExists(root, `${rewritten}^{commit}`)) blockers.push(`${lockRepo}.rewrittenTipCommit missing`);
  if (!objectExists(root, `${fusion}^{commit}`)) blockers.push(`${lockRepo}.fusionMergeCommit missing`);
  if (objectExists(root, `${fusion}^{commit}`)) {
    const parents = git(root, ["rev-list", "--parents", "-n", "1", fusion]).stdout.trim().split(" ");
    const parentCount = parents.length - 1;
    if (parentCount !== 2) blockers.push(`${lockRepo}.fusionMergeCommit parentCount=${parentCount}`);
    if (parents[2] !== rewritten) blockers.push(`${lockRepo}.fusionMerge second parent != rewritten tip`);
  }
  if (!isAncestor(root, rewritten, "HEAD")) blockers.push(`${lockRepo}.rewrittenTipCommit is not an ancestor of HEAD`);
  if (!isAncestor(root, fusion, "HEAD")) blockers.push(`${lockRepo}.fusionMergeCommit is not an ancestor of HEAD`);

  const treeSpec = `HEAD:${importDir}`;
  if (!objectExists(root, treeSpec)) {
    blockers.push(`missing tree ${treeSpec}`);
    return { service: lockRepo, importDir, blockers, listing: null, probes: [] };
  }
  const listing = parseLsTree(git(root, ["ls-tree", "-r", "--full-tree", treeSpec]).stdout);
  const raw = compareListings(receipt.originalTreeListing, listing);
  const serviceKey = String(importDir || "").split("/").pop();
  const cmp = applyPostImportAllowlist(raw, allowlist.services?.[serviceKey]);
  if (cmp.blobMismatchCount) blockers.push(`${lockRepo} blobMismatchCount=${cmp.blobMismatchCount}`);
  if (cmp.modeMismatchCount) blockers.push(`${lockRepo} modeMismatchCount=${cmp.modeMismatchCount}`);
  if (cmp.missingFileCount) blockers.push(`${lockRepo} missingFileCount=${cmp.missingFileCount}`);
  if (cmp.extraFileCount) blockers.push(`${lockRepo} extraFileCount=${cmp.extraFileCount}`);

  const probes = (receipt.historyProbes || []).map((probe) => {
    const reachable = historyReachable(root, probe.path);
    if (probe.historyReachable && !reachable) blockers.push(`history not reachable: ${probe.path}`);
    return { path: probe.path, expected: probe.historyReachable !== false, reachable };
  });

  return {
    service: lockRepo,
    importDir,
    originalCommit: receipt.originalCommit,
    originalTreeSha: receipt.originalTreeSha,
    rewrittenTipCommit: rewritten,
    fusionMergeCommit: fusion,
    trackedFileCount: cmp.actualCount,
    expectedCount: cmp.expectedCount,
    allowlistedCount: cmp.allowlisted.length,
    ...cmp,
    probes,
    blockers,
  };
}

export function verifyRepo(root) {
  const lockPath = join(root, "docs/fusion/source-lock.v1.json");
  const registryPath = join(root, "docs/fusion/import-registry.v1.json");
  const devicePath = join(root, "docs/fusion/import-device-agent.v1.json");
  const blockers = [];
  for (const p of [lockPath, registryPath, devicePath]) {
    if (!existsSync(p)) blockers.push(`missing ${p}`);
  }
  if (blockers.length) {
    return { status: "BLOCK", runtimeCutoverAllowed: false, blockers, services: [] };
  }

  const lock = loadJson(lockPath);
  const registry = loadJson(registryPath);
  const deviceAgent = loadJson(devicePath);
  if (lock.runtimeCutoverAllowed !== false) blockers.push("source-lock.runtimeCutoverAllowed must be false");
  let allowlist = { services: {} };
  try {
    allowlist = loadPostImportAllowlist(root);
  } catch (error) {
    blockers.push(error instanceof Error ? error.message : String(error));
  }

  const services = [
    verifyReceipt(root, registry, lock, "registry", allowlist),
    verifyReceipt(root, deviceAgent, lock, "deviceAgent", allowlist),
  ];
  for (const service of services) blockers.push(...service.blockers);

  const extraServices = git(root, ["ls-tree", "--name-only", "HEAD:services"], { allowFail: true })
    .stdout.split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((name) => name !== "orchestrator" && name !== "control-plane");
  if (extraServices.length) blockers.push(`unexpected services/: ${extraServices.join(", ")}`);

  const pkgPath = join(root, "package.json");
  if (existsSync(pkgPath)) {
    const pkg = loadJson(pkgPath);
    if (pkg.workspaces) blockers.push("root package.json must not enable npm workspaces");
    for (const script of ["check", "fusion:verify", "test:m0", "test:gate", "test:control-critical"]) {
      if (!pkg.scripts?.[script]) blockers.push(`root package.json missing script ${script}`);
    }
  }

  return {
    status: blockers.length ? "BLOCK" : "PASS",
    runtimeCutoverAllowed: false,
    sourceFusionGate: "OPEN",
    runtimeCutoverGate: "CLOSED",
    blockers,
    services: services.map(({ blockers: _ignored, details, ...rest }) => ({
      ...rest,
      detailCount: details.length,
    })),
  };
}
