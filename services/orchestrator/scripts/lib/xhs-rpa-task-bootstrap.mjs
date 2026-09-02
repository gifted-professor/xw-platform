/**
 * Fixed, task-owned XHS RPA bootstrap.
 *
 * This module is intentionally not an HTTP/CLI surface.  The production
 * constructor derives every path below the fixed public runtime root, reads
 * the task-owned V3 P6 PASS, snapshots current routine/recipe evidence, and
 * exposes only opaque program/generation/idempotency operations.  It never
 * installs or enables a recurring task.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { TraceStore } from "../../../../packages/harness-protocol/lib/trace-store.mjs";

import {
  buildSystemTcbAclPlan,
  createSystemTcbAclController,
} from "../../../control-plane/control-plane/lib/windows-system-tcb-acl.mjs";
import { createXhsRpaLedger } from "../../../control-plane/control-plane/lib/xhs-rpa-ledger.mjs";
import {
  buildXhsV3RpaCloseout,
  createXhsRpaRuntime,
} from "./xhs-rpa-runtime.mjs";
import {
  canonicalXhsRpaJson,
  compileXhsRpaProgram,
  hashXhsRpa,
  projectXhsRpaCatalog,
} from "./xhs-rpa-program.mjs";
import { OrchestrationStore } from "./orchestration-store.mjs";
import { OrchestrationTraceBridge } from "./orchestration-trace-bridge.mjs";
import { ROUTINE_TEMPLATE_CATALOG } from "./xhs-routine-plan.mjs";
import { bindTaskPlanToLiveCapabilities } from "./task-plan-capability-binding.mjs";
import { runTaskOrchestrator } from "./task-orchestrator.mjs";
import { createTerminalWorkReceipt } from "./work-receipt.mjs";
import { XHS_EXPLORATION_VISION_CORPUS_ROUTES } from "./xhs-exploration-vision-corpus.mjs";
import {
  XHS_V3_FREE_EXPLORATION_PASS_SCHEMA_ID,
  XHS_V3_GATE_F_IDENTITY_SCHEMA_ID,
  XHS_V3_P6_CURRENT_SCHEMA_ID,
  XHS_V3_RUNTIME_ROOT,
  XHS_V3_TASK_NAME,
  XHS_V3_TASK_PRIVATE_ROOT,
  assertXhsV3GateFReadySnapshot,
  loadXhsV3GateFIdentityFromEnv,
} from "./xhs-v3-task-bootstrap.mjs";

export const XHS_RPA_TASK_BOOTSTRAP_SCHEMA_ID = "xw.xhs.rpa-task-bootstrap.v1";
export const XHS_RPA_P6_SCHEMA_ID = XHS_V3_FREE_EXPLORATION_PASS_SCHEMA_ID;
export const XHS_RPA_P6_REF_SCHEMA_ID = XHS_V3_P6_CURRENT_SCHEMA_ID;
export const XHS_RPA_M5_BINDING_SCHEMA_ID = "xw.xhs.rpa-approved-m5-binding.v1";
export const XHS_RPA_M5_RUNTIME_SCHEMA_ID = "xw.m5.task-plan-v2-runtime.v1";

const HERE = dirname(fileURLToPath(import.meta.url));
const HASH = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const PROGRAM_ID = /^xrp_[a-z0-9][a-z0-9._-]{2,63}$/;
const IDEMPOTENCY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,191}$/;
const RELEASE_ID = /^[A-Za-z0-9._-]{3,128}$/;
const PROGRAM_IDS = Object.freeze({
  feed: "xrp_feed_foundation",
  scout: "xrp_scout_foundation",
  explore: "xrp_explore_foundation",
});
const ENTRY_IDS = Object.freeze({
  feed: "xhs.feed.read",
  scout: "xhs.scout.read",
  explore: "xhs.explore.read",
});
const EXAMPLE_KINDS = Object.freeze(["feed", "scout", "explore"]);
const FIXED_OWNER_REF = "own_xhs_v3_rpa_foundation";
const ZERO_SAFETY_KEYS = Object.freeze([
  "likes", "comments", "follows", "shares", "saves", "publishes", "messages",
  "socialAuthorityDelta", "socialReservationDelta", "socialTransportDelta",
]);
const P6_KEYS = Object.freeze([
  "schemaId", "schemaVersion", "status", "verificationMarker",
  "XHS_V3_FREE_EXPLORATION_VERIFIED", "runSetId", "taskBinding", "runtime",
  "placement", "phases", "coverage", "safety", "cleanup",
]);
const P6_OWNER_KEYS = Object.freeze([
  "taskName", "taskBindingHash", "launcherHash", "callerPathHash",
]);
const P6_SAFETY_KEYS = Object.freeze([
  "socialTransport", "effectTransport", "r3VisualIssued", "r3VisualConsumed",
  "r3VisualPhysical", "allOtherVisualHardZero",
]);
const P6_CLEANUP_KEYS = Object.freeze([
  "semanticRestoreAllLanes", "authorityClosedAllWaves", "sessionReleaseAllSettled",
  "zeroOwnedLeases",
]);
const M5_REQUEST_KEYS = Object.freeze([
  "tickId", "idempotencyKey", "dag", "taskPlan", "localCalendarSlot", "nodeSeeds",
]);
const CORE_DEP_KEYS = Object.freeze([
  "paths", "identity", "fsImpl", "aclController", "openLedgerDatabase",
  "openEvidenceDatabase", "approvedM5Binding", "clock", "randomUUIDFn",
]);

const DEFAULT_FS = Object.freeze({
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
});

function fail(code, message, details = {}) {
  throw Object.assign(new Error(`${code}: ${message}`), { code, details });
}

function exact(value, keys) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && Object.keys(value).every((key) => keys.includes(key)));
}

function canonical(value) {
  return canonicalXhsRpaJson(value);
}

function shaBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function within(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function assertOpaqueProgramId(value) {
  if (!PROGRAM_ID.test(String(value ?? "")) || !Object.values(PROGRAM_IDS).includes(value)) {
    fail("XHS_RPA_PROGRAM_ID_INVALID", "program id is not one of the sealed foundation programs");
  }
}

function assertIdentity(identity) {
  const keys = [
    "schemaId", "taskName", "taskBindingHash", "launcherHash", "callerPathHash",
    "releaseId", "sourceCommit", "providerBundleDigest", "providerConfigSha256",
    "digestKeyringSha256", "accountFingerprint",
  ];
  if (!exact(identity, keys)
    || identity.schemaId !== XHS_V3_GATE_F_IDENTITY_SCHEMA_ID
    || identity.taskName !== XHS_V3_TASK_NAME
    || !RELEASE_ID.test(String(identity.releaseId ?? ""))
    || !COMMIT.test(String(identity.sourceCommit ?? ""))
    || ["taskBindingHash", "launcherHash", "callerPathHash", "providerBundleDigest",
      "providerConfigSha256", "digestKeyringSha256", "accountFingerprint"]
      .some((key) => !HASH.test(String(identity[key] ?? "")))) {
    fail("XHS_RPA_TASK_IDENTITY_INVALID", "formal Gate-F task identity is malformed");
  }
  return Object.freeze({ ...identity });
}

/** All production paths are derived here; the production factory has no path parameter. */
export function deriveFixedXhsRpaPaths() {
  const privateRoot = join(XHS_V3_RUNTIME_ROOT, "private", "xhs-rpa");
  const releaseRoot = join(privateRoot, "releases");
  return Object.freeze({
    runtimeRoot: XHS_V3_RUNTIME_ROOT,
    privateRoot,
    releaseRoot,
    ledgerRoot: join(privateRoot, "ledger"),
    ledgerPath: join(privateRoot, "ledger", "xhs-rpa.sqlite"),
    schedulerRoot: join(privateRoot, "m5-work"),
    traceRoot: join(privateRoot, "m5-trace"),
    receiptRoot: join(privateRoot, "manual-receipts"),
    closeoutRoot: join(privateRoot, "closeouts"),
    p6CurrentPath: join(XHS_V3_TASK_PRIVATE_ROOT, "acceptance", "p6-current.v1.json"),
    p6ArtifactRoot: join(XHS_V3_TASK_PRIVATE_ROOT, "acceptance", "p6-artifacts"),
    routineAcceptanceRoot: join(XHS_V3_RUNTIME_ROOT, "state", "orchestrator", "xhs-routine-acceptance"),
    recipeDatabasePath: join(XHS_V3_RUNTIME_ROOT, "state", "orchestrator", "registry.db"),
  });
}

function assertPaths(paths) {
  const keys = [
    "runtimeRoot", "privateRoot", "releaseRoot", "ledgerRoot", "ledgerPath",
    "schedulerRoot", "traceRoot", "receiptRoot", "closeoutRoot", "p6CurrentPath", "p6ArtifactRoot",
    "routineAcceptanceRoot", "recipeDatabasePath",
  ];
  if (!exact(paths, keys) || keys.some((key) => typeof paths[key] !== "string" || !isAbsolute(paths[key]))) {
    fail("XHS_RPA_FIXED_PATHS_INVALID", "bootstrap paths must be one exact absolute set");
  }
  for (const key of [
    "privateRoot", "releaseRoot", "ledgerRoot", "ledgerPath", "schedulerRoot", "traceRoot",
    "receiptRoot", "closeoutRoot",
  ]) {
    if (!within(paths.runtimeRoot, paths[key])) fail("XHS_RPA_PATH_ESCAPE", `${key} escapes formal runtime`);
  }
  return Object.freeze({ ...paths });
}

function plainFileBytes(path, fsImpl, maximumBytes, code) {
  let stat;
  try { stat = fsImpl.lstatSync(path); } catch { fail(code, "file is absent or unreadable"); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || !Number.isSafeInteger(stat.size) || stat.size < 2 || stat.size > maximumBytes
    || resolve(fsImpl.realpathSync(path)) !== resolve(path)) {
    fail(code, "file is linked, reparsed, or outside its size bound");
  }
  return Buffer.from(fsImpl.readFileSync(path));
}

function canonicalFile(path, fsImpl, maximumBytes, code) {
  const bytes = plainFileBytes(path, fsImpl, maximumBytes, code);
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { fail(code, "file is not valid JSON"); }
  if (bytes.toString("utf8") !== canonical(value)) fail(code, "file is not canonical JSON");
  return value;
}

function protect(aclController, boundaryPath, targetPath, recursive) {
  const plan = buildSystemTcbAclPlan({ boundaryPath, targetPath, recursive });
  aclController.protect(plan);
  aclController.verify(plan);
}

function createDirectory(path, { fsImpl, aclController, boundaryPath }) {
  if (!fsImpl.existsSync(path)) fsImpl.mkdirSync(path, { recursive: false, mode: 0o700 });
  const stat = fsImpl.lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || resolve(fsImpl.realpathSync(path)) !== resolve(path)) {
    fail("XHS_RPA_PRIVATE_STORE_INVALID", "private store contains a linked/non-directory path");
  }
  protect(aclController, boundaryPath, path, true);
}

function writeContentAddressed(path, value, context) {
  const { fsImpl, aclController, boundaryPath, randomUUIDFn } = context;
  const bytes = Buffer.from(canonical(value), "utf8");
  if (fsImpl.existsSync(path)) {
    const prior = plainFileBytes(path, fsImpl, Math.max(bytes.length, 2) + 1, "XHS_RPA_CREATE_ONLY_CONFLICT");
    if (!prior.equals(bytes)) fail("XHS_RPA_CREATE_ONLY_CONFLICT", "existing content-addressed artifact differs");
    protect(aclController, boundaryPath, path, false);
    return path;
  }
  const parent = dirname(path);
  const temp = join(parent, `.tmp-${randomUUIDFn()}`);
  if (!within(parent, temp)) fail("XHS_RPA_PATH_ESCAPE", "temporary publication escaped its parent");
  try {
    fsImpl.writeFileSync(temp, bytes, { flag: "wx", mode: 0o600 });
    protect(aclController, boundaryPath, temp, false);
    fsImpl.linkSync(temp, path); // atomic, create-only publication
  } catch (error) {
    if (fsImpl.existsSync(path)) {
      const prior = plainFileBytes(path, fsImpl, Math.max(bytes.length, 2) + 1, "XHS_RPA_CREATE_ONLY_CONFLICT");
      if (!prior.equals(bytes)) fail("XHS_RPA_CREATE_ONLY_CONFLICT", "publication raced a different artifact");
    } else {
      throw error;
    }
  } finally {
    try { if (fsImpl.existsSync(temp)) fsImpl.unlinkSync(temp); } catch {}
  }
  protect(aclController, boundaryPath, path, false);
  return path;
}

/** Verify the fixed task-owned, content-addressed V3 aggregate without caller booleans. */
export function verifyTaskOwnedXhsV3FreeExplorationPass(artifact, identity) {
  const formal = assertIdentity(identity);
  const owner = artifact?.taskBinding;
  const runtime = artifact?.runtime;
  const placement = artifact?.placement;
  const phases = artifact?.phases;
  const coverage = artifact?.coverage;
  const safety = artifact?.safety;
  const cleanup = artifact?.cleanup;
  const verified = exact(artifact, P6_KEYS)
    && artifact.schemaId === XHS_RPA_P6_SCHEMA_ID
    && artifact.schemaVersion === 1
    && artifact.status === "PASS"
    && artifact.verificationMarker === "XHS_V3_FREE_EXPLORATION_VERIFIED=true"
    && artifact.XHS_V3_FREE_EXPLORATION_VERIFIED === true
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(String(artifact.runSetId ?? ""))
    && exact(owner, P6_OWNER_KEYS)
    && P6_OWNER_KEYS.every((key) => owner[key] === formal[key])
    && exact(runtime, [
      "releaseId", "sourceCommit", "providerBundleDigest", "digestKeyId", "accountFingerprint",
    ])
    && runtime.releaseId === formal.releaseId
    && runtime.sourceCommit === formal.sourceCommit
    && runtime.providerBundleDigest === formal.providerBundleDigest
    && /^[A-Za-z0-9._-]{1,128}$/.test(String(runtime.digestKeyId ?? ""))
    && runtime.accountFingerprint === formal.accountFingerprint
    && exact(placement, ["aliases", "laneRoles"])
    && JSON.stringify(placement.aliases) === JSON.stringify(["03", "04"])
    && JSON.stringify(placement.laneRoles) === JSON.stringify(["feed_lane", "search_lane"])
    && exact(phases, ["R0", "R1", "R2", "R3", "R4"])
    && Object.entries(phases).every(([phase, row]) => exact(row, [
      "invocationId", "runRecordHash", "resultReceiptHash",
    ])
      && row.invocationId === `${artifact.runSetId}-${phase.toLowerCase()}`
      && HASH.test(String(row.runRecordHash ?? ""))
      && HASH.test(String(row.resultReceiptHash ?? "")))
    && exact(coverage, ["requiredRoutes", "minimumDistinctFramesPerRoute", "distinctFramesByRoute"])
    && JSON.stringify(coverage.requiredRoutes) === JSON.stringify(XHS_EXPLORATION_VISION_CORPUS_ROUTES)
    && coverage.minimumDistinctFramesPerRoute === 3
    && exact(coverage.distinctFramesByRoute, XHS_EXPLORATION_VISION_CORPUS_ROUTES)
    && XHS_EXPLORATION_VISION_CORPUS_ROUTES.every((route) => (
      Number.isInteger(coverage.distinctFramesByRoute[route])
      && coverage.distinctFramesByRoute[route] >= 3
    ))
    && exact(safety, P6_SAFETY_KEYS)
    && safety.socialTransport === 0 && safety.effectTransport === 0
    && Number.isInteger(safety.r3VisualIssued) && safety.r3VisualIssued >= 0 && safety.r3VisualIssued <= 1
    && Number.isInteger(safety.r3VisualConsumed) && safety.r3VisualConsumed >= 0
    && safety.r3VisualConsumed <= safety.r3VisualIssued
    && Number.isInteger(safety.r3VisualPhysical) && safety.r3VisualPhysical >= 0
    && safety.r3VisualPhysical <= safety.r3VisualConsumed
    && safety.allOtherVisualHardZero === true
    && exact(cleanup, P6_CLEANUP_KEYS)
    && P6_CLEANUP_KEYS.every((key) => cleanup[key] === true);
  const artifactHash = verified ? hashXhsRpa(artifact) : null;
  return Object.freeze({
    verified,
    artifactHash,
    releaseId: verified ? runtime.releaseId : null,
    sourceCommit: verified ? runtime.sourceCommit : null,
    providerBundleDigest: verified ? runtime.providerBundleDigest : null,
    accountFingerprint: verified ? runtime.accountFingerprint : null,
  });
}

function loadP6(paths, identity, fsImpl) {
  if (!fsImpl.existsSync(paths.p6CurrentPath)) return Object.freeze({ artifact: null, verification: { verified: false }, blocker: "P6_PASS_MISSING" });
  const ref = canonicalFile(paths.p6CurrentPath, fsImpl, 64 * 1024, "XHS_RPA_P6_REF_INVALID");
  if (!exact(ref, ["schemaId", "schemaVersion", "artifactHash", "artifactSchemaId", "relativePath"])
    || ref.schemaId !== XHS_RPA_P6_REF_SCHEMA_ID || ref.schemaVersion !== 1
    || !HASH.test(String(ref.artifactHash ?? ""))
    || ref.artifactSchemaId !== XHS_RPA_P6_SCHEMA_ID
    || ref.relativePath !== `p6-artifacts/${ref.artifactHash}/xhs-v3-p6-pass.v1.json`) {
    fail("XHS_RPA_P6_REF_INVALID", "P6 locator is not the fixed hash-only schema");
  }
  const artifactPath = join(paths.p6ArtifactRoot, ref.artifactHash, "xhs-v3-p6-pass.v1.json");
  if (!within(paths.p6ArtifactRoot, artifactPath)) fail("XHS_RPA_PATH_ESCAPE", "P6 hash escaped artifact root");
  const artifact = canonicalFile(artifactPath, fsImpl, 8 * 1024 * 1024, "XHS_RPA_P6_ARTIFACT_INVALID");
  const verification = verifyTaskOwnedXhsV3FreeExplorationPass(artifact, identity);
  if (!verification.verified || verification.artifactHash !== ref.artifactHash) {
    fail("XHS_RPA_P6_ARTIFACT_INVALID", "task-owned V3 P6 PASS did not reproduce from its locator");
  }
  return Object.freeze({ artifact, verification, blocker: null });
}

function readRecipeConfig(name) {
  const path = resolve(HERE, `../../../control-plane/config/recipes/${name}`);
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return Object.freeze(raw);
}

const FIXED_RECIPE_SPECS = Object.freeze({
  search: readRecipeConfig("xhs.search.fixed@2.json"),
  browse: readRecipeConfig("xhs.browse.fixed@1.json"),
});

function loadRecipeRows(paths, openEvidenceDatabase) {
  if (!existsSync(paths.recipeDatabasePath)) return Object.freeze([]);
  let database;
  try { database = openEvidenceDatabase(paths.recipeDatabasePath); } catch { return Object.freeze([]); }
  try {
    database.exec("BEGIN");
    const table = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='recipe_versions'").get();
    const rows = table
      ? database.prepare("SELECT recipe_id, revision, spec_json, descriptor_hash, status, created_at FROM recipe_versions ORDER BY recipe_id, revision").all()
      : [];
    database.exec("COMMIT");
    return Object.freeze(rows.map((row) => Object.freeze({ ...row })));
  } catch {
    try { database.exec("ROLLBACK"); } catch {}
    return Object.freeze([]);
  } finally {
    try { database.close(); } catch {}
  }
}

function loadRoutineReceipts(paths, fsImpl) {
  if (!fsImpl.existsSync(paths.routineAcceptanceRoot)) return Object.freeze([]);
  let names;
  try { names = fsImpl.readdirSync(paths.routineAcceptanceRoot); } catch { return Object.freeze([]); }
  const out = [];
  for (const name of names.sort()) {
    if (!/^[A-Za-z0-9._-]+\.json$/.test(name)) continue;
    const path = join(paths.routineAcceptanceRoot, name);
    if (!within(paths.routineAcceptanceRoot, path)) continue;
    try {
      const value = JSON.parse(plainFileBytes(path, fsImpl, 8 * 1024 * 1024, "XHS_RPA_ROUTINE_EVIDENCE_INVALID").toString("utf8"));
      out.push(Object.freeze({ name, value, evidenceHash: shaBytes(Buffer.from(JSON.stringify(value), "utf8")) }));
    } catch {
      // Malformed historical material is inventory evidence, never authority.
    }
  }
  return Object.freeze(out);
}

function runner(kind, identity, approvedM5Binding) {
  const isExplore = kind === "explore";
  const contract = isExplore
    ? {
        schemaId: "xw.xhs.rpa-task-owned-explore-runner.v1",
        taskName: identity.taskName,
        taskBindingHash: identity.taskBindingHash,
        releaseId: identity.releaseId,
        sourceCommit: identity.sourceCommit,
        method: "fixed_in_process_manual_once",
        phase: "R4",
        aliases: ["03", "04"],
      }
    : {
        schemaId: "xw.xhs.rpa-routine-read-runner.v1",
        releaseId: identity.releaseId,
        sourceCommit: identity.sourceCommit,
        kind,
      };
  return Object.freeze({
    kind: "typed_job",
    capabilityId: isExplore ? "xhs.v3.task.explore.manual_once" : `xhs.${kind}.read_only`,
    appId: "xhs",
    workflowId: null,
    contractHash: isExplore && approvedM5Binding?.taskRunnerContractHash
      ? approvedM5Binding.taskRunnerContractHash
      : hashXhsRpa(contract),
  });
}

function acceptedRoutineReceipts(kind, receipts, identity, templateHash) {
  // Old wave receipts do not bind a template descriptor/hash.  They remain
  // evidence, but cannot promote a routine into this catalog.  A future
  // task-owned import must use this exact schema and match every binding.
  return receipts.filter(({ value }) => exact(value, [
    "schemaId", "ownership", "entryId", "templateHash", "releaseId", "sourceCommit",
    "effectClass", "aliases", "verdict", "sourceReceiptHashes", "artifactHash",
  ])
    && value.schemaId === "xw.xhs.rpa-catalog-acceptance.v1"
    && value.ownership === "task_owned"
    && value.entryId === ENTRY_IDS[kind]
    && value.templateHash === templateHash
    && value.releaseId === identity.releaseId
    && value.sourceCommit === identity.sourceCommit
    && value.effectClass === "none"
    && JSON.stringify(value.aliases) === JSON.stringify(kind === "explore" ? ["03", "04"] : ["03"])
    && value.verdict === "PASS"
    && Array.isArray(value.sourceReceiptHashes) && value.sourceReceiptHashes.length > 0
    && value.sourceReceiptHashes.every((hash) => HASH.test(String(hash)))
    && value.artifactHash === hashXhsRpa(Object.fromEntries(
      Object.entries(value).filter(([key]) => key !== "artifactHash"),
    )))
    .map(({ value }) => value.artifactHash)
    .sort();
}

function routineEntry(kind, { identity, p6, routineReceipts, approvedM5Binding }) {
  const templateId = kind === "feed" ? "xhs.feed-play.v1"
    : kind === "scout" ? "xhs.scout.home.v1" : "xhs.explore.goal.v1";
  const template = ROUTINE_TEMPLATE_CATALOG[templateId];
  const templateHash = hashXhsRpa(template);
  const imported = acceptedRoutineReceipts(kind, routineReceipts, identity, templateHash);
  const exploreReady = kind === "explore" && p6.verification?.verified === true
    && approvedM5Binding?.taskRunnerReady === true;
  const acceptances = exploreReady ? [p6.verification.artifactHash] : imported;
  const accepted = acceptances.length > 0 && (kind !== "explore" || exploreReady);
  return Object.freeze({
    entryId: ENTRY_IDS[kind],
    kind: "routine_template",
    revision: 1,
    descriptorHash: hashXhsRpa({ templateId, templateHash, runner: runner(kind, identity, approvedM5Binding) }),
    templateHash,
    effectClass: template.effectClass,
    placement: kind === "explore"
      ? { mode: "exact_pair", aliases: ["03", "04"] }
      : { mode: "fixed", aliases: ["03"] },
    maturity: accepted ? "accepted" : (kind === "explore" && p6.verification?.verified ? "draft" : "candidate"),
    status: accepted ? "active" : "inactive",
    releaseId: identity.releaseId,
    sourceCommit: identity.sourceCommit,
    acceptanceReceiptHashes: acceptances,
    runner: runner(kind, identity, approvedM5Binding),
    cleanupContractHash: hashXhsRpa({
      schemaId: "xw.xhs.rpa-cleanup-contract.v1",
      restored: true,
      authorityClosed: kind === "explore",
      zeroOwnedLeases: true,
      aliases: kind === "explore" ? ["03", "04"] : ["03"],
    }),
    expectedReceiptSchema: kind === "explore"
      ? "xw.xhs.exploration-aggregate-receipt.v1"
      : "xhs.work-receipt.v2",
  });
}

function recipeEntry(kind, identity, recipeRows) {
  const spec = FIXED_RECIPE_SPECS[kind];
  const current = recipeRows
    .filter((row) => row.recipe_id === spec.recipeId && row.revision === spec.revision)
    .at(-1);
  const observedStatus = current?.status ?? spec.status ?? "candidate";
  const descriptorHash = current?.descriptor_hash === spec.descriptorHash
    ? current.descriptor_hash : spec.descriptorHash;
  return Object.freeze({
    entryId: `xhs.${kind}.candidate`,
    kind: "recipe_revision",
    revision: spec.revision,
    descriptorHash,
    templateHash: hashXhsRpa(spec),
    effectClass: "none",
    placement: { mode: "fixed", aliases: [...spec.eligibleAliases] },
    // Presence in a spec/overlay/DB is deliberately not acceptance.
    maturity: observedStatus === "implemented" ? "candidate" : "candidate",
    status: ["degraded", "retired"].includes(observedStatus) ? "inactive" : "active",
    releaseId: identity.releaseId,
    sourceCommit: identity.sourceCommit,
    acceptanceReceiptHashes: [],
    runner: {
      kind: "typed_job",
      capabilityId: `xhs.${kind}.fixed`,
      appId: "xhs",
      workflowId: null,
      contractHash: hashXhsRpa({ recipeId: spec.recipeId, revision: spec.revision, descriptorHash }),
    },
    cleanupContractHash: hashXhsRpa({ recipeId: spec.recipeId, restoration: spec.restoration }),
    expectedReceiptSchema: "xhs.work-receipt.v2",
  });
}

function socialEntry(templateId, identity) {
  const template = ROUTINE_TEMPLATE_CATALOG[templateId];
  const templateHash = hashXhsRpa(template);
  return Object.freeze({
    entryId: templateId.replace(/\.v1$/, ".blocked"),
    kind: "routine_template",
    revision: 1,
    descriptorHash: hashXhsRpa({ templateId, templateHash }),
    templateHash,
    effectClass: "social",
    placement: { mode: "fixed", aliases: ["03"] },
    maturity: "candidate",
    status: "active",
    releaseId: identity.releaseId,
    sourceCommit: identity.sourceCommit,
    acceptanceReceiptHashes: [],
    runner: {
      kind: "typed_job", capabilityId: "xhs.social.forbidden", appId: "xhs", workflowId: null,
      contractHash: hashXhsRpa({ templateId, forbidden: true }),
    },
    cleanupContractHash: hashXhsRpa({ templateId, cleanup: "irrelevant_ineligible" }),
    expectedReceiptSchema: "xhs.work-receipt.v2",
  });
}

/** Pure, deterministic inventory projection used by production and mutation tests. */
export function buildXhsRpaCatalogInventory({
  identity,
  p6,
  routineReceipts = [],
  recipeRows = [],
  approvedM5Binding = null,
} = {}) {
  const formal = assertIdentity(identity);
  if (!p6 || !Array.isArray(routineReceipts) || !Array.isArray(recipeRows)) {
    fail("XHS_RPA_CATALOG_EVIDENCE_INVALID", "catalog inventory evidence is malformed");
  }
  return projectXhsRpaCatalog({
    runtime: { releaseId: formal.releaseId, sourceCommit: formal.sourceCommit },
    entries: [
      ...EXAMPLE_KINDS.map((kind) => routineEntry(kind, {
        identity: formal, p6, routineReceipts, approvedM5Binding,
      })),
      recipeEntry("search", formal, recipeRows),
      recipeEntry("browse", formal, recipeRows),
      socialEntry("xhs.nurture-lite.v1", formal),
      socialEntry("xhs.nurture-grounded.v1", formal),
    ],
  });
}

function reportForCatalog(catalogSnapshot, extraBlockers = {}) {
  const body = {
    schemaId: "xw.xhs.rpa-catalog-eligibility-report.v1",
    catalogSnapshotHash: catalogSnapshot.catalogSnapshotHash,
    entries: catalogSnapshot.entries.map((entry) => ({
      entryId: entry.entryId,
      eligible: entry.eligible,
      reasons: Object.freeze([...new Set([
        ...entry.reasons,
        ...(extraBlockers[entry.entryId] || []),
      ])].sort()),
      descriptorHash: entry.descriptorHash,
      acceptanceReceiptHashes: entry.acceptanceReceiptHashes,
    })),
  };
  return Object.freeze({ ...body, reportHash: hashXhsRpa(body) });
}

function refFor(entry) {
  return Object.fromEntries([
    "entryId", "kind", "revision", "templateHash", "descriptorHash", "effectClass",
    "placement", "maturity", "status", "acceptanceReceiptHashes", "runner",
    "cleanupContractHash", "expectedReceiptSchema",
  ].map((key) => [key, entry[key]]));
}

function buildExample(kind, catalogSnapshot, identity) {
  const entry = catalogSnapshot.entries.find((item) => item.entryId === ENTRY_IDS[kind]);
  if (!entry?.eligible) {
    const body = {
      schemaId: "xw.xhs.rpa-plan-example.v1",
      exampleKind: kind,
      programId: PROGRAM_IDS[kind],
      status: "BLOCKED_CATALOG",
      catalogSnapshotHash: catalogSnapshot.catalogSnapshotHash,
      entryId: ENTRY_IDS[kind],
      blockers: entry?.reasons ?? ["CATALOG_ENTRY_MISSING"],
      stateMutations: 0,
      ioOperations: 0,
      recurringEnabled: false,
    };
    return Object.freeze({ ...body, exampleHash: hashXhsRpa(body) });
  }
  const fixedParams = kind === "explore"
    ? { operation: "task_owned_small_read_only_exploration", itemLimit: 1 }
    : { operation: `${kind}_read_only`, itemLimit: 3 };
  const program = compileXhsRpaProgram({
    programId: PROGRAM_IDS[kind],
    programVersion: 1,
    ownerRef: FIXED_OWNER_REF,
    accountRef: identity.accountFingerprint,
    generation: 1,
    rollbackGeneration: 0,
    catalogSnapshot,
    nodes: [{
      nodeId: `${kind}_read`,
      catalogRef: refFor(entry),
      fixedParams,
      inputPrivateRefs: [],
      dependsOn: [],
    }],
  });
  const body = {
    schemaId: "xw.xhs.rpa-plan-example.v1",
    exampleKind: kind,
    programId: PROGRAM_IDS[kind],
    status: "SEALED",
    catalogSnapshotHash: catalogSnapshot.catalogSnapshotHash,
    program,
    stateMutations: 0,
    ioOperations: 0,
    recurringEnabled: false,
  };
  return Object.freeze({ ...body, exampleHash: hashXhsRpa(body) });
}

const APPROVED_BINDINGS = new WeakSet();

function projectR4Aggregate(result, invocationHash) {
  const children = result?.children;
  const cleanup = result?.cleanup;
  const safety = result?.safety;
  if (result?.ok !== true || result.status !== "SUCCEEDED" || result.phase !== "R4"
    || !HASH.test(String(invocationHash ?? "")) || !HASH.test(String(result.receiptHash ?? ""))
    || !Array.isArray(children) || children.length !== 2
    || JSON.stringify(children.map((child) => child.alias)) !== JSON.stringify(["03", "04"])
    || JSON.stringify(children.map((child) => child.laneRole)) !== JSON.stringify(["feed_lane", "search_lane"])
    || children.some((child) => child.status !== "COMPLETED" || child.committed !== true
      || !HASH.test(String(child.receiptHash ?? ""))
      || child.receipt?.restored?.restored !== true
      || child.receipt?.safety?.socialTransport !== 0
      || child.receipt?.safety?.effectTransport !== 0)
    || cleanup?.authorityClosed?.ok !== true
    || !Array.isArray(cleanup?.releases) || cleanup.releases.length !== 2
    || cleanup.releases.some((row) => row?.ok !== true)
    || cleanup?.leaseOracle?.checked !== true || cleanup.leaseOracle?.ok !== true
    || cleanup.leaseOracle?.activeLeaseCount !== 0
    || safety?.socialTransport !== 0 || safety?.effectTransport !== 0
    || safety?.visualIssued !== 0 || safety?.visualConsumed !== 0
    || safety?.visualPhysical !== 0) {
    fail("XHS_RPA_TASK_AGGREGATE_INVALID", "real R4 aggregate did not prove exact-pair hard-zero cleanup");
  }
  return Object.freeze({
    schemaId: "xw.xhs.rpa-r4-scheduler-output.v1",
    invocationHash,
    aggregateReceiptHash: result.receiptHash,
    aliases: Object.freeze(["03", "04"]),
    laneRoles: Object.freeze(["feed_lane", "search_lane"]),
    laneReceiptHashes: Object.freeze(children.map((child) => child.receiptHash)),
    cleanupHash: hashXhsRpa(cleanup),
    hardZero: true,
  });
}

function validSchedulerOutput(value) {
  return exact(value, [
    "schemaId", "invocationHash", "aggregateReceiptHash", "aliases", "laneRoles",
    "laneReceiptHashes", "cleanupHash", "hardZero",
  ])
    && value.schemaId === "xw.xhs.rpa-r4-scheduler-output.v1"
    && HASH.test(String(value.invocationHash ?? ""))
    && HASH.test(String(value.aggregateReceiptHash ?? ""))
    && HASH.test(String(value.cleanupHash ?? ""))
    && JSON.stringify(value.aliases) === JSON.stringify(["03", "04"])
    && JSON.stringify(value.laneRoles) === JSON.stringify(["feed_lane", "search_lane"])
    && Array.isArray(value.laneReceiptHashes) && value.laneReceiptHashes.length === 2
    && value.laneReceiptHashes.every((hash) => HASH.test(String(hash)))
    && value.hardZero === true;
}

function createApprovedM5BindingCore({
  xhsV3TaskBootstrap,
  m5Runtime,
  formalIdentity,
  schedulerRoot,
  traceRoot,
}) {
  const identity = assertIdentity(formalIdentity);
  if (!isAbsolute(schedulerRoot) || !isAbsolute(traceRoot)
    || !xhsV3TaskBootstrap || typeof xhsV3TaskBootstrap.health !== "function"
    || typeof xhsV3TaskBootstrap.prepareInvocation !== "function"
    || typeof xhsV3TaskBootstrap.runTask !== "function"
    || !m5Runtime || !exact(m5Runtime, [
      "schemaId", "beginLeaseAudit", "completeLeaseAudit", "restoreOwnedResources",
      "listOwnedLeases", "listRecurringTasks",
    ])
    || m5Runtime.schemaId !== XHS_RPA_M5_RUNTIME_SCHEMA_ID
    || [m5Runtime.beginLeaseAudit, m5Runtime.completeLeaseAudit,
      m5Runtime.restoreOwnedResources, m5Runtime.listOwnedLeases,
      m5Runtime.listRecurringTasks].some((fn) => typeof fn !== "function")) {
    fail("XHS_RPA_M5_TASK_RUNNER_BINDING_MISSING", "existing M5 runtime and formal V3 task bootstrap are required");
  }
  const health = xhsV3TaskBootstrap.health();
  const ready = exact(health, [
    "schemaId", "status", "releaseId", "providerBundleDigest", "taskOwned",
  ])
    && health.taskOwned === true && health.status === "READY_R0_R4"
    && health.releaseId === identity.releaseId
    && health.providerBundleDigest === identity.providerBundleDigest;
  const taskRunnerContractHash = hashXhsRpa({
    schemaId: "xw.xhs.rpa-task-owned-explore-runner.v1",
    bootstrapSchemaId: health?.schemaId ?? null,
    taskBinding: {
      taskName: identity.taskName,
      taskBindingHash: identity.taskBindingHash,
      launcherHash: identity.launcherHash,
      callerPathHash: identity.callerPathHash,
    },
    runtime: {
      releaseId: identity.releaseId,
      sourceCommit: identity.sourceCommit,
      providerBundleDigest: identity.providerBundleDigest,
      accountFingerprint: identity.accountFingerprint,
    },
    phase: "R4",
    aliases: ["03", "04"],
    externalEffects: 0,
    recurringEnabled: false,
  });

  const binding = Object.freeze({
    schemaId: XHS_RPA_M5_BINDING_SCHEMA_ID,
    taskRunnerReady: ready,
    taskRunnerContractHash,
    async submit(request) {
      if (!ready) fail("XHS_RPA_M5_TASK_RUNNER_BINDING_MISSING", "formal task runner identity is not ready");
      if (!exact(request, M5_REQUEST_KEYS)) {
        fail("XHS_RPA_M5_REQUEST_INVALID", "approved submit accepts only a lowered M5 request");
      }
      const dagNode = request.dag?.nodes?.[0];
      const taskNode = request.taskPlan?.nodes?.[0];
      const shard = taskNode?.shards?.[0];
      if (request.dag?.schemaId !== "xw.orchestration.dag.v1"
        || request.dag.executionReady !== true || request.dag.nodes?.length !== 1
        || dagNode?.skillId !== ENTRY_IDS.explore
        || dagNode?.expectedEffectClass !== "none" || dagNode?.requiresHuman !== false
        || !Array.isArray(dagNode?.targetAliases) || dagNode.targetAliases.length !== 0
        || request.taskPlan?.schemaId !== "xhs.task-plan.v2"
        || request.taskPlan.nodes?.length !== 1
        || taskNode?.nodeId !== "explore_read"
        || taskNode?.executor?.kind !== "typed_job"
        || taskNode.executor.capabilityId !== "xhs.v3.task.explore.manual_once"
        || taskNode.executor.effectClass !== "none"
        || taskNode.executor.replaySafety !== "read_only"
        || taskNode.shards?.length !== 1
        || !exact(shard?.placement, [])
        || shard?.params?.runnerContractHash !== taskRunnerContractHash
        || dagNode?.inputs?.runnerContractHash !== taskRunnerContractHash
        || shard?.params?.fixedParams?.operation !== "task_owned_small_read_only_exploration"
        || shard?.params?.fixedParams?.itemLimit !== 1
        || !Array.isArray(shard?.params?.inputPrivateRefs)
        || shard.params.inputPrivateRefs.length !== 0
        || !/^tick_[0-9a-f]{32}$/.test(String(request.tickId ?? ""))
        || request.idempotencyKey !== `xhs-rpa:${request.tickId}`
        || !/^\d{4}-\d{2}-\d{2}$/.test(String(request.localCalendarSlot ?? ""))
        || !exact(request.nodeSeeds, ["explore_read"])
        || !HASH.test(String(request.nodeSeeds.explore_read ?? ""))) {
        fail("XHS_RPA_M5_REQUEST_INVALID", "lowered request is not the single task-owned explore aggregate");
      }

      const baseline = await m5Runtime.beginLeaseAudit({ tickId: request.tickId });
      if (!exact(baseline, ["ok", "tickId", "baselineLeaseHash"])
        || baseline.ok !== true || baseline.tickId !== request.tickId
        || !HASH.test(String(baseline.baselineLeaseHash ?? ""))) {
        fail("XHS_RPA_M5_LEASE_AUDIT_INVALID", "listener lease baseline is malformed");
      }

      let schedulerResult = null;
      let schedulerError = null;
      try {
        const bound = bindTaskPlanToLiveCapabilities(request.taskPlan, [{
          id: "xhs.v3.task.explore.manual_once",
          appId: "xhs",
          availability: "implemented",
          lifecycle: "accepted",
          runnable: true,
          idempotency: "read_only",
          normalizedEffect: { class: "observe", phase: "read", commitBoundary: "automatic" },
          capabilityContractHash: taskRunnerContractHash,
          capabilityContractHashAlgorithm: "xw.xhs.rpa-task-owned-runner.v1",
          implementationClosureHash: taskRunnerContractHash,
        }]);
        const executionNode = bound.executionPlan?.nodes?.[0];
        if (bound.executionPlan?.nodes?.length !== 1
          || executionNode?.capabilityId !== "xhs.v3.task.explore.manual_once"
          || executionNode?.placementConstraint?.alias !== null
          || bound.executionPlan.constraints?.maxWorkers !== 1
          || bound.executionPlan.constraints?.allowReassign !== false) {
          fail("XHS_RPA_M5_EXECUTION_PLAN_INVALID", "bound M5 plan is not one unplaced aggregate shard");
        }
        const taskRunId = `run_${request.tickId}`;
        const traceId = `rpa_${request.tickId}`;
        const store = new OrchestrationStore({ taskRunId, workRoot: schedulerRoot });
        const traceStore = new TraceStore({ traceRoot });
        const traceBridge = new OrchestrationTraceBridge({
          traceId,
          taskRunId,
          traceStore,
          skillByNode: { [taskNode.nodeId]: ENTRY_IDS.explore },
          validationNode: { nodeId: "rpa_validate", skillId: "xhs.explore.validator" },
        });
        if (traceStore.read(traceId, { allowMissing: true }).length === 0) {
          traceBridge.begin({
            taskType: request.dag.taskType,
            dagId: request.dag.dagId,
            planHash: request.taskPlan.planHash,
          });
        }
        const invocationId = `rpa-${request.tickId}`;
        let rawSchedulerResult;
        if (existsSync(store.resultPath)) {
          const state = store.loadState();
          const receipts = store.loadReceipts(state);
          try { rawSchedulerResult = JSON.parse(readFileSync(store.resultPath, "utf8")); }
          catch { fail("XHS_RPA_M5_SCHEDULER_RESULT_INVALID", "persisted scheduler result is unreadable"); }
          if (state.status !== "completed" || receipts.length !== 1
            || receipts[0].technicalStatus !== "succeeded"
            || receipts[0].businessStatus !== "accepted"
            || canonical(receipts[0].output) !== canonical(rawSchedulerResult?.results?.[0]?.output)) {
            fail("XHS_RPA_M5_SCHEDULER_RESULT_INVALID", "persisted scheduler receipt/result did not match");
          }
        } else {
          rawSchedulerResult = await runTaskOrchestrator({
            taskRunId,
            plan: request.taskPlan,
            executionPlan: bound.executionPlan,
            executionPlanHash: bound.executionPlanHash,
            fleetProvider: async () => [{
              alias: "03",
              coordinatorRole: "exact_pair_aggregate_coordinator",
              online: true,
              ready: true,
              lease: "free",
              quarantined: false,
              unresolvedFailure: null,
              capabilityIds: ["xhs.v3.task.explore.manual_once"],
            }],
            worker: {
              async execute(assignment) {
                const startedAt = new Date().toISOString();
                let prepared = null;
                try {
                  prepared = await xhsV3TaskBootstrap.prepareInvocation({ phase: "R4", invocationId });
                  if (prepared?.ok !== true || prepared.phase !== "R4" || prepared.invocationId !== invocationId
                    || !HASH.test(String(prepared.invocationHash ?? ""))) {
                    fail("XHS_RPA_TASK_INVOCATION_INVALID", "formal task bootstrap did not seal the R4 invocation");
                  }
                  const result = await xhsV3TaskBootstrap.runTask({ phase: "R4", invocationId });
                  const output = projectR4Aggregate(result, prepared.invocationHash);
                  return createTerminalWorkReceipt({
                    assignment,
                    technicalStatus: "succeeded",
                    businessStatus: "accepted",
                    retryable: false,
                    output,
                    startedAt,
                    finishedAt: new Date().toISOString(),
                    integrity: { runtimeReleaseId: identity.releaseId },
                    terminalStatus: "succeeded",
                    reconcileRequired: false,
                  });
                } catch (error) {
                  const afterPrepare = prepared !== null;
                  return createTerminalWorkReceipt({
                    assignment,
                    technicalStatus: afterPrepare ? "ambiguous" : "blocked",
                    businessStatus: afterPrepare ? "ambiguous" : "not_evaluated",
                    retryable: false,
                    output: null,
                    error: {
                      code: /^[A-Z0-9_]+$/.test(String(error?.code ?? ""))
                        ? error.code : "XHS_RPA_TASK_WORKER_FAILED",
                      message: afterPrepare
                        ? "formal R4 aggregate failed after sealed prepare"
                        : "formal R4 aggregate failed before sealed prepare",
                    },
                    startedAt,
                    finishedAt: new Date().toISOString(),
                    integrity: { runtimeReleaseId: identity.releaseId },
                    terminalStatus: afterPrepare ? "ambiguous" : "blocked",
                    reconcileRequired: afterPrepare,
                  });
                }
              },
            },
            store,
            traceBridge,
            resultValidator(result) {
              const output = result?.results?.[0]?.output;
              return validSchedulerOutput(output)
                ? { ok: true, code: "XHS_RPA_R4_AGGREGATE_ACCEPTED" }
                : { ok: false, code: "XHS_RPA_R4_AGGREGATE_REJECTED" };
            },
          });
        }
        const output = rawSchedulerResult?.results?.[0]?.output;
        const trace = traceStore.query(traceId);
        if (rawSchedulerResult?.status !== "completed" || rawSchedulerResult?.validation?.ok !== true
          || rawSchedulerResult.summary?.total !== 1 || rawSchedulerResult.summary?.accepted !== 1
          || !validSchedulerOutput(output)
          || trace.integrity?.ok !== true || !HASH.test(String(trace.integrity.sha256 ?? ""))
          || trace.events.filter((event) => event.type === "WorkerAssigned").length !== 1
          || trace.events.filter((event) => event.type === "SkillFinished"
            && event.skillId === ENTRY_IDS.explore && event.status === "succeeded").length !== 1
          || trace.events.at(-1)?.type !== "ValidationPassed") {
          fail("XHS_RPA_M5_SCHEDULER_RESULT_INVALID", "formal M5 scheduler did not commit one aggregate receipt and trace");
        }
        schedulerResult = Object.freeze({ result: rawSchedulerResult, output, trace });
      } catch (error) {
        schedulerError = error;
      }

      let completedAudit = null;
      let auditError = null;
      try {
        completedAudit = await m5Runtime.completeLeaseAudit({
          tickId: request.tickId,
          baselineLeaseHash: baseline.baselineLeaseHash,
        });
      } catch (error) {
        auditError = error;
      }
      if (auditError || !exact(completedAudit, [
        "ok", "tickId", "baselineLeaseHash", "freshLeaseCount", "freshLeaseHash",
      ])
        || completedAudit.ok !== true || completedAudit.tickId !== request.tickId
        || completedAudit.baselineLeaseHash !== baseline.baselineLeaseHash
        || completedAudit.freshLeaseCount !== 0
        || !HASH.test(String(completedAudit.freshLeaseHash ?? ""))) {
        fail("XHS_RPA_M5_LEASE_AUDIT_INCOMPLETE", "listener lease diff did not close at zero", {
          schedulerErrorCode: schedulerError?.code ?? null,
          auditErrorCode: auditError?.code ?? null,
        });
      }
      if (schedulerError) throw schedulerError;

      const output = schedulerResult.output;
      const cleanupReceipt = Object.freeze({ restored: true, zeroOwnedLeases: true, ownedLeaseCount: 0 });
      const childSafety = Object.freeze(Object.fromEntries(ZERO_SAFETY_KEYS.map((key) => [key, 0])));
      return Object.freeze({
        schedulerTraceHash: schedulerResult.trace.integrity.sha256,
        childReceipts: Object.freeze([Object.freeze({
          nodeId: taskNode.nodeId,
          schemaId: taskNode.acceptance.expectedReceiptSchema,
          receiptHash: output.aggregateReceiptHash,
          cleanupContractHash: taskNode.acceptance.cleanupContractHash,
          committed: true,
          safety: childSafety,
          cleanup: cleanupReceipt,
        })]),
        validator: Object.freeze({
          passed: true,
          reportHash: hashXhsRpa({
            schemaId: "xw.xhs.rpa-task-owned-r4-validator.v1",
            schedulerTraceHash: schedulerResult.trace.integrity.sha256,
            aggregateReceiptHash: output.aggregateReceiptHash,
            laneReceiptHashes: output.laneReceiptHashes,
            aliases: output.aliases,
            hardZero: output.hardZero,
            cleanup: cleanupReceipt,
          }),
        }),
        aggregateSafety: childSafety,
      });
    },
    restoreOwnedResources: (input) => m5Runtime.restoreOwnedResources(input),
    listOwnedLeases: (input) => m5Runtime.listOwnedLeases(input),
    listRecurringTasks: () => m5Runtime.listRecurringTasks(),
  });
  APPROVED_BINDINGS.add(binding);
  return binding;
}

/** Production bridge: scheduler/trace roots are fixed under the formal runtime. */
export function createXhsRpaApprovedM5Binding({
  xhsV3TaskBootstrap,
  m5Runtime,
  formalIdentity,
} = {}) {
  const privateRoot = join(XHS_V3_RUNTIME_ROOT, "private", "xhs-rpa");
  return createApprovedM5BindingCore({
    xhsV3TaskBootstrap,
    m5Runtime,
    formalIdentity,
    schedulerRoot: join(privateRoot, "m5-work"),
    traceRoot: join(privateRoot, "m5-trace"),
  });
}

/** Test-only path seam; production never calls this export. */
export function createXhsRpaApprovedM5BindingForTest({
  xhsV3TaskBootstrap,
  m5Runtime,
  formalIdentity,
  schedulerRoot,
  traceRoot,
} = {}) {
  return createApprovedM5BindingCore({
    xhsV3TaskBootstrap, m5Runtime, formalIdentity, schedulerRoot, traceRoot,
  });
}

function assertBinding(binding) {
  if (!binding || !APPROVED_BINDINGS.has(binding) || binding.schemaId !== XHS_RPA_M5_BINDING_SCHEMA_ID) {
    fail("XHS_RPA_M5_TASK_RUNNER_BINDING_MISSING", "RPA submit is not the listener-owned approved M5 binding");
  }
  return binding;
}

function ledgerArtifact(program, p6Artifact) {
  const body = {
    schemaId: "xw.xhs.v3-p6-artifact.v1",
    schemaVersion: 1,
    ownership: "task_owned",
    contentAddressed: true,
    verdict: "PASS",
    programId: program.programId,
    programVersion: program.programVersion,
    generation: program.generation,
    programHash: program.programHash,
    taskPlanHash: program.taskPlanHash,
    releaseId: program.runtime.releaseId,
    sourceCommit: program.runtime.sourceCommit,
  };
  // The public ledger envelope stays program-specific.  Its loader is trusted
  // only because this function is reached after the full P6 artifact above was
  // loaded from the task-owned content-addressed store.
  void p6Artifact;
  return Object.freeze({ ...body, artifactHash: hashXhsRpa(body) });
}

function closeoutGate(examples, catalogReport, receipt, planResults, ledgerStatuses) {
  const executable = examples.filter((entry) => entry?.program);
  const compilerRows = planResults.map((result) => result.status === "BLOCKED_CATALOG"
    ? {
        exampleHash: result.exampleHash,
        exampleKind: result.exampleKind,
        status: result.status,
        entryId: result.entryId,
        catalogSnapshotHash: result.catalogSnapshotHash,
        blockers: result.blockers,
        stateMutations: result.stateMutations,
        ioOperations: result.ioOperations,
        recurringEnabled: result.recurringEnabled,
      }
    : {
        programHash: result.program.programHash,
        dagHash: result.lowering.dagHash,
        taskPlanHash: result.lowering.taskPlanHash,
        thirdSchedulerIntroduced: result.lowering.thirdSchedulerIntroduced,
        stateMutations: result.stateMutations,
        ioOperations: result.ioOperations,
      }).sort((left, right) => String(left.programHash ?? left.exampleHash)
        .localeCompare(String(right.programHash ?? right.exampleHash)));
  const body = {
    schemaId: "xw.xhs.rpa-gate-report.v1",
    formalReleaseBinding: `${executable[0].program.runtime.releaseId}:${executable[0].program.runtime.sourceCommit}`,
    compilerReportHash: hashXhsRpa(compilerRows),
    ledgerReportHash: hashXhsRpa(ledgerStatuses.filter(Boolean)
      .sort((left, right) => left.programId.localeCompare(right.programId))),
    journalReportHash: hashXhsRpa({
      tickId: receipt.tickId,
      journalHeadHash: receipt.journalHeadHash,
      journalLength: receipt.journalLength,
    }),
    killReportHash: hashXhsRpa({
      killGeneration: receipt.killGeneration,
      activeTicks: ledgerStatuses.find((status) => status?.programId === receipt.programId).activeTicks,
      recurringEnabled: false,
    }),
    catalogReportHash: catalogReport.reportHash,
    manualReceiptHash: receipt.receiptHash,
    programHashes: examples.map((entry) => entry?.program?.programHash ?? entry.exampleHash).sort(),
  };
  return Object.freeze({ ...body, reportHash: hashXhsRpa(body) });
}

function releaseKey(identity) {
  return hashXhsRpa({ releaseId: identity.releaseId, sourceCommit: identity.sourceCommit });
}

/** Test seam: production calls this only with fixed paths and native adapters. */
export function createXhsRpaTaskBootstrapForTest(deps = {}) {
  if (!exact(deps, CORE_DEP_KEYS)) fail("XHS_RPA_BOOTSTRAP_DEPENDENCY_INVALID", "bootstrap dependency set must be exact");
  const paths = assertPaths(deps.paths);
  const identity = assertIdentity(deps.identity);
  const fsImpl = deps.fsImpl;
  const aclController = deps.aclController;
  const approvedM5Binding = assertBinding(deps.approvedM5Binding);
  if (!fsImpl || !aclController || typeof aclController.protect !== "function" || typeof aclController.verify !== "function"
    || typeof deps.openLedgerDatabase !== "function" || typeof deps.openEvidenceDatabase !== "function"
    || typeof deps.clock !== "function" || typeof deps.randomUUIDFn !== "function") {
    fail("XHS_RPA_BOOTSTRAP_DEPENDENCY_INVALID", "bootstrap native dependencies are missing");
  }
  const context = {
    fsImpl,
    aclController,
    boundaryPath: paths.runtimeRoot,
    randomUUIDFn: deps.randomUUIDFn,
  };
  let initialized = null;
  let database = null;
  let ledger = null;
  let runtime = null;
  let p6State = null;
  let catalogSnapshot = null;
  let catalogReport = null;
  let examples = null;
  let snapshotFrozen = false;
  let sealedById = new Map();
  let recoveryComplete = false;
  let recoveryPromise = null;

  function evidenceSnapshot() {
    const p6 = loadP6(paths, identity, fsImpl);
    const routineReceipts = loadRoutineReceipts(paths, fsImpl);
    const recipeRows = loadRecipeRows(paths, deps.openEvidenceDatabase);
    const catalog = buildXhsRpaCatalogInventory({
      identity,
      p6,
      routineReceipts,
      recipeRows,
      approvedM5Binding,
    });
    const extra = {};
    if (!p6.verification?.verified) extra[ENTRY_IDS.explore] = [p6.blocker || "P6_PASS_UNVERIFIED"];
    if (!approvedM5Binding.taskRunnerReady) {
      extra[ENTRY_IDS.explore] = [...(extra[ENTRY_IDS.explore] || []), "M5_TASK_RUNNER_BINDING_MISSING"];
    }
    for (const kind of ["feed", "scout"]) {
      const entry = catalog.entries.find((item) => item.entryId === ENTRY_IDS[kind]);
      if (!entry?.eligible) extra[ENTRY_IDS[kind]] = ["TASK_OWNED_ACCEPTANCE_IMPORT_MISSING"];
    }
    return Object.freeze({
      p6,
      catalog,
      report: reportForCatalog(catalog, extra),
      examples: Object.freeze(EXAMPLE_KINDS.map((kind) => buildExample(kind, catalog, identity))),
    });
  }

  function publishSnapshot(snapshot, { freeze = false } = {}) {
    p6State = snapshot.p6;
    catalogSnapshot = snapshot.catalog;
    catalogReport = snapshot.report;
    examples = snapshot.examples;
    sealedById = new Map(examples.filter((entry) => entry.status === "SEALED")
      .map((entry) => [entry.programId, entry]));
    const root = join(paths.releaseRoot, releaseKey(identity));
    createDirectory(root, context);
    const catalogRoot = join(root, "catalog");
    const exampleRoot = join(root, "examples");
    createDirectory(catalogRoot, context);
    createDirectory(exampleRoot, context);
    writeContentAddressed(join(catalogRoot, `${catalogSnapshot.catalogSnapshotHash}.v1.json`), catalogSnapshot, context);
    writeContentAddressed(join(catalogRoot, `${catalogReport.reportHash}.report.v1.json`), catalogReport, context);
    for (const example of examples) {
      writeContentAddressed(join(exampleRoot, `${example.exampleKind}-${example.exampleHash}.v1.json`), example, context);
    }
    initialized = Object.freeze({
      schemaId: XHS_RPA_TASK_BOOTSTRAP_SCHEMA_ID,
      status: "READY_DISABLED",
      releaseId: identity.releaseId,
      sourceCommit: identity.sourceCommit,
      catalogSnapshotHash: catalogSnapshot.catalogSnapshotHash,
      catalogReportHash: catalogReport.reportHash,
      examples: examples.map((entry) => Object.freeze({
        exampleKind: entry.exampleKind,
        programId: entry.programId,
        status: entry.status,
        blockers: entry.blockers ?? [],
        exampleHash: entry.exampleHash,
      })),
      RPA_RECURRING_ENABLED: false,
    });
    if (freeze) snapshotFrozen = true;
    return initialized;
  }

  function initializeInfrastructure() {
    if (database) return;
    if (!fsImpl.existsSync(paths.runtimeRoot)) fail("XHS_RPA_RUNTIME_ROOT_MISSING", "formal runtime root does not exist");
    createDirectory(paths.privateRoot, context);
    for (const path of [
      paths.releaseRoot, paths.ledgerRoot, paths.schedulerRoot, paths.traceRoot,
      paths.receiptRoot, paths.closeoutRoot,
    ]) {
      createDirectory(path, context);
    }
    database = deps.openLedgerDatabase(paths.ledgerPath);
    ledger = createXhsRpaLedger({ database, now: deps.clock });
    protect(aclController, paths.runtimeRoot, paths.ledgerPath, false);
    runtime = createXhsRpaRuntime({
      ledger,
      async loadProgram(programId) { return sealedById.get(programId)?.program ?? null; },
      async loadCatalogSnapshot(programId) {
        return sealedById.has(programId) ? catalogSnapshot : null;
      },
      async loadP6Artifact(programId) {
        const example = sealedById.get(programId);
        if (!example || !p6State?.verification?.verified) return null;
        return ledgerArtifact(example.program, p6State.artifact);
      },
      submitM5TaskPlan: (request) => approvedM5Binding.submit(request),
      restoreOwnedResources: (input) => approvedM5Binding.restoreOwnedResources(input),
      listOwnedLeases: (input) => approvedM5Binding.listOwnedLeases(input),
      clock: deps.clock,
    });
  }

  function initialize() {
    initializeInfrastructure();
    if (!snapshotFrozen) {
      const snapshot = evidenceSnapshot();
      // Before P6 this is a read-only provisional projection.  It may be
      // rebuilt in the same listener when task-owned P6 appears.  A verified
      // P6 or a durable active tick freezes the exact catalog/runtime binding.
      const freeze = snapshot.p6.verification?.verified === true
        || ledger.listActiveTicks().length > 0;
      publishSnapshot(snapshot, { freeze });
    }
    return initialized;
  }

  function recoveryView() {
    const activeTickCount = ledger.listActiveTicks().length;
    return Object.freeze({
      recoveryRequired: !recoveryComplete && activeTickCount > 0,
      activeTickCount,
      recoveryComplete,
    });
  }

  async function ensureStartupRecovery() {
    initialize();
    // Once this process has reconciled its inherited journal, later active
    // ticks belong to this live runtime and must never be mistaken for crash
    // leftovers by a concurrent manual-once request.
    if (recoveryComplete) {
      return Object.freeze({
        status: "RECOVERED",
        discoveredActiveTicks: 0,
        settledTicks: 0,
        failedTicks: 0,
        remainingActiveTicks: 0,
        schedulerDispatches: 0,
        recurringEnabled: false,
      });
    }
    if (!recoveryPromise) {
      recoveryPromise = runtime.reconcileActiveTicks()
        .then((result) => {
          recoveryComplete = true;
          return result;
        })
        .finally(() => { recoveryPromise = null; });
    }
    return recoveryPromise;
  }

  function reverifyCatalog(programId) {
    const fresh = evidenceSnapshot();
    if (fresh.catalog.catalogSnapshotHash !== catalogSnapshot.catalogSnapshotHash) {
      fail("XHS_RPA_CATALOG_SNAPSHOT_DRIFT", "current routine/recipe evidence changed after program seal");
    }
    const example = examples.find((entry) => entry.programId === programId);
    if (!example || example.status !== "SEALED") {
      fail("XHS_RPA_CATALOG_INELIGIBLE", `program is blocked: ${(example?.blockers || ["CATALOG_ENTRY_MISSING"]).join(",")}`);
    }
    if (!fresh.p6.verification?.verified) fail("XHS_RPA_P6_UNVERIFIED", "task-owned P6 PASS is no longer valid");
    return example;
  }

  async function persistCloseout(receipt) {
    const sealed = examples.filter((entry) => entry.status === "SEALED");
    const installedTasks = await approvedM5Binding.listRecurringTasks();
    if (!Array.isArray(installedTasks) || installedTasks.length !== 0) {
      fail("XHS_RPA_RECURRING_TASK_PRESENT", "RPA closeout requires zero recurring tasks");
    }
    const programs = examples.map((entry) => entry.status === "SEALED"
      ? { exampleKind: entry.exampleKind, program: entry.program }
      : entry);
    const planResults = await Promise.all(examples.map((entry) => entry.status === "SEALED"
      ? runtime.plan({ programId: entry.programId })
      : entry));
    const ledgerStatuses = sealed.map((entry) => ledger.status(entry.programId));
    const gateReport = closeoutGate(programs, catalogReport, receipt, planResults, ledgerStatuses);
    const closeout = buildXhsV3RpaCloseout({
      programs,
      planResults,
      ledgerStatuses,
      installedTasks,
      manualOnceReceipts: [receipt],
      gateReport,
      catalogEligibilityReport: catalogReport,
    });
    const root = join(paths.closeoutRoot, closeout.closeoutHash);
    createDirectory(root, context);
    writeContentAddressed(join(root, "xhs-v3-rpa-pass.v1.json"), closeout, context);
    writeContentAddressed(join(paths.closeoutRoot, "rpa-current.v1.json"), {
      schemaId: "xw.xhs.v3-rpa-pass-ref.v1",
      closeoutHash: closeout.closeoutHash,
    }, context);
    return closeout;
  }

  return Object.freeze({
    initialize,
    async plan(input = {}) {
      if (!exact(input, ["programId"])) fail("XHS_RPA_PLAN_INPUT_INVALID", "plan accepts only programId");
      initialize();
      assertOpaqueProgramId(input.programId);
      const example = examples.find((entry) => entry.programId === input.programId);
      if (example?.status !== "SEALED") return example;
      reverifyCatalog(input.programId);
      return runtime.plan(input);
    },
    status(input = {}) {
      if (!exact(input, ["programId"])) fail("XHS_RPA_STATUS_INPUT_INVALID", "status accepts only programId");
      initialize();
      assertOpaqueProgramId(input.programId);
      const example = examples.find((entry) => entry.programId === input.programId);
      const sealedProgram = example?.status === "SEALED" ? example.program : null;
      const current = ledger.status(input.programId);
      return Object.freeze({
        programId: input.programId,
        sealStatus: example?.status ?? "MISSING",
        blockers: example?.blockers ?? [],
        sealedProgramId: sealedProgram?.programId ?? null,
        sealedGeneration: sealedProgram?.generation ?? null,
        generation: current?.generation ?? sealedProgram?.generation ?? null,
        programHash: sealedProgram?.programHash ?? null,
        taskPlanHash: sealedProgram?.taskPlanHash ?? null,
        releaseId: sealedProgram?.runtime?.releaseId ?? null,
        sourceCommit: sealedProgram?.runtime?.sourceCommit ?? null,
        registered: current !== null,
        disabled: current?.disabledAtMs !== null && current?.disabledAtMs !== undefined,
        disabledAtMs: current?.disabledAtMs ?? null,
        ledger: current,
        ...recoveryView(),
        recurringEnabled: false,
      });
    },
    async disable(input = {}) {
      if (!exact(input, ["programId", "generation"]) || !Number.isInteger(input.generation) || input.generation < 1) {
        fail("XHS_RPA_DISABLE_INPUT_INVALID", "disable accepts only programId/generation");
      }
      initialize();
      assertOpaqueProgramId(input.programId);
      await ensureStartupRecovery();
      const current = ledger.status(input.programId);
      if (!current) {
        fail("XHS_RPA_PROGRAM_NOT_REGISTERED", "program cannot be reported disabled before its sealed generation is registered");
      }
      if (current.disabledAtMs !== null) {
        if (input.generation !== current.generation
          && input.generation !== current.generation - 1) {
          fail("XHS_RPA_GENERATION_STALE", "disable generation differs from the durable disabled generation");
        }
        return current;
      }
      return runtime.disable({ ...input, reason: "operator_disable" });
    },
    async manualOnce(input = {}) {
      if (!exact(input, ["programId", "generation", "idempotencyKey"])
        || !Number.isInteger(input.generation) || input.generation < 1
        || !IDEMPOTENCY.test(String(input.idempotencyKey ?? ""))) {
        fail("XHS_RPA_MANUAL_INPUT_INVALID", "manual-once accepts only opaque program/generation/idempotency");
      }
      initialize();
      assertOpaqueProgramId(input.programId);
      await ensureStartupRecovery();
      reverifyCatalog(input.programId);
      if (input.programId !== PROGRAM_IDS.explore) {
        fail("XHS_RPA_MANUAL_PROGRAM_FORBIDDEN", "this delivery admits only the task-owned P6 explore example");
      }
      if (!approvedM5Binding.taskRunnerReady) {
        fail("XHS_RPA_M5_TASK_RUNNER_BINDING_MISSING", "formal task-owned runner is not installed in M5");
      }
      const result = await runtime.tick({ ...input, trigger: "manual_once" });
      if (result.status !== "SUCCEEDED" || result.receipt?.committed !== true) {
        return Object.freeze({ result, closeout: null, recurringEnabled: false });
      }
      writeContentAddressed(join(paths.receiptRoot, `${result.receipt.receiptHash}.v1.json`), result.receipt, context);
      const closeout = await persistCloseout(result.receipt);
      return Object.freeze({ result, closeout, recurringEnabled: false });
    },
    health() {
      const base = initialize();
      return Object.freeze({
        ...base,
        ...recoveryView(),
        ledgerOpen: true,
        taskRunnerReady: approvedM5Binding.taskRunnerReady,
      });
    },
    close() {
      try { database?.close(); } finally { database = null; }
    },
  });
}

/**
 * Narrow production factory for the P5 Gate-F listener.  No filesystem,
 * database, runtime-root, provider, endpoint, module, runner, or role is
 * caller-selectable at operation time.
 */
export function createFixedXhsRpaTaskBootstrap({
  gateFOperations,
  releaseIdentity,
  xhsV3TaskBootstrap,
  m5Runtime,
} = {}) {
  if (!gateFOperations || typeof gateFOperations.status !== "function") {
    fail("XHS_RPA_GATE_F_REQUIRED", "Gate-F owner is required in the formal listener");
  }
  assertXhsV3GateFReadySnapshot(gateFOperations.status());
  const identity = loadXhsV3GateFIdentityFromEnv({ releaseIdentity });
  const approvedM5Binding = createXhsRpaApprovedM5Binding({
    xhsV3TaskBootstrap,
    m5Runtime,
    formalIdentity: identity,
  });
  const paths = deriveFixedXhsRpaPaths();
  const aclController = createSystemTcbAclController();
  const bootstrap = createXhsRpaTaskBootstrapForTest({
    paths,
    identity,
    fsImpl: DEFAULT_FS,
    aclController,
    openLedgerDatabase(path) { return new DatabaseSync(path); },
    openEvidenceDatabase(path) { return new DatabaseSync(path, { readOnly: true }); },
    approvedM5Binding,
    clock: () => Date.now(),
    randomUUIDFn: randomUUID,
  });
  function gate() {
    assertXhsV3GateFReadySnapshot(gateFOperations.status());
  }
  return Object.freeze({
    initialize() { gate(); return bootstrap.initialize(); },
    plan(input) { gate(); return bootstrap.plan(input); },
    status(input) { gate(); return bootstrap.status(input); },
    disable(input) { gate(); return bootstrap.disable(input); },
    manualOnce(input) { gate(); return bootstrap.manualOnce(input); },
    health() { gate(); return bootstrap.health(); },
    close() { return bootstrap.close(); },
  });
}
