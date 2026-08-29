#!/usr/bin/env node

// Production operator for the release-specific M6-C1 qualification bootstrap.
//
// The default command is a read-only preflight.  --execute is the only path
// that may snapshot/migrate the control DB or publish immutable runtime
// artifacts.  This module never loads or creates a private key, never contacts
// a provider, and never touches a device.
import { backup as sqliteBackup, DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import {
  closeSync,
  copyFileSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";
import { pathToFileURL } from "node:url";

import {
  deriveM6AggregateSealHash,
  deriveM6ResourceSnapshotSha256,
} from "../../packages/kernel/lib/m6-aggregate-closeout.mjs";
import { snapshotDatabase } from "../../packages/cutover/lib/db.mjs";
import {
  RELEASE_MANIFEST_FILENAME,
  verifyReleaseManifest,
} from "../../packages/release/lib/release-manifest.mjs";
import { canonicalJson, sha256 } from "../../services/control-plane/control-plane/lib/canonical.mjs";
import {
  acquireM6C1StoppedRuntimeGuard,
} from "../../services/control-plane/control-plane/lib/m6-c1-runtime-owner-lock.mjs";
import {
  M6_GROUNDED_RUN_CAPABILITY_ID,
  verifyM6GroundedRunCapabilitySeal,
} from "../../services/control-plane/control-plane/lib/m6-grounded-run-capability-seal.mjs";
import {
  bootstrapM6Qualification,
  buildM6QualificationBootstrapBinding,
  deriveM6QualificationBootstrapPackageHash,
  deriveM6QualificationBootstrapScenarioManifestHash,
  isM6QualificationCleanupVerifiedError,
  M6_QUALIFICATION_BOOTSTRAP_PACKAGE_SCHEMA_ID,
  M6_QUALIFICATION_BOOTSTRAP_SCENARIO_SCHEMA_ID,
  validateM6QualificationBootstrapPackage,
  stageM6QualificationBootstrapRotationArtifacts,
} from "../../services/control-plane/control-plane/lib/m6-qualification-bootstrap.mjs";
import {
  deriveM6CloseoutHash,
  deriveM6EpochHash,
} from "../../services/control-plane/control-plane/lib/m6-live-gate.mjs";
import {
  CURRENT_CONTROL_SCHEMA_VERSION,
  StateStore,
} from "../../services/control-plane/control-plane/lib/state-store.mjs";
import {
  normalizeM64QualificationBootstrapBindingTcb,
} from "../../services/control-plane/control-plane/lib/m6-qualification-tcb.mjs";
import {
  inspectRecoverableCreateOnlyPublication,
  publishRecoverableCreateOnly,
  recoverablePublicationPendingPath,
  RecoverablePublicationError,
} from "./lib/recoverable-create-only-publication.mjs";

export const M64_QUALIFICATION_OPERATOR_RECEIPT_SCHEMA_ID =
  "xw.m6-c1-qualification-bootstrap-operator-receipt.v1";
export const M64_QUALIFICATION_SIGNING_DRAFT_SCHEMA_ID =
  "xw.m6-c1-qualification-bootstrap-signing-draft.v1";
export const M64_QUALIFICATION_ROTATION_RECEIPT_SCHEMA_ID =
  "xw.m6-c1-qualification-bootstrap-rotation-receipt.v1";
export const M64_QUALIFICATION_INVENTORY_SENTINEL_HASH = sha256(
  "xw.m6-c1-qualification-bootstrap.inventory-unavailable.v1",
);

const HASH = /^(?!0{64}$)[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const OPAQUE_ID = /^[A-Za-z0-9._-]{1,128}$/u;
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const BINDING_RELATIVE_PATH = join("config", "m6-c1-qualification-bootstrap.v1.json");
const SENTINEL_RELATIVE_PATH = join("qualification-bootstrap", "final-inventory-unavailable.json");
const LIVE_ISSUER_SENTINEL_RELATIVE_PATH = join(
  "qualification-bootstrap",
  "live-window-owner-keys-unavailable.json",
);
const RECEIPT_DIRECTORY = join("qualification-bootstrap", "receipts");
const DRAFT_INPUT_KEYS = Object.freeze([
  "actor", "closedIssuedAt", "closeoutCommittedAt", "expiresAt", "gateId",
  "issuerAllowlistSha256", "locksRecord", "promotedAt", "releaseId",
  "rootIssuedAt", "sourceCommit",
]);
const LOCK_KEYS = Object.freeze(["groundingRuntime", "hardRedlinePolicy", "runtimeProfile"]);
const PROOF_KEYS = Object.freeze(["algorithm", "allowlistVersion", "keyId", "signature", "subject"]);
const DRAFT_KEYS = Object.freeze([
  "aggregate", "closedEpoch", "closeout", "draftHash", "gateId", "issuerAllowlistSha256",
  "locksRecord", "promotedAt", "releaseId", "resourceSnapshot", "rootEpoch",
  "scenarioManifest", "schemaId", "signingRequests", "sourceCommit",
]);
const SECRET_KEY = /^(?:api[_-]?key|access[_-]?token|bearer[_-]?token|password|private[_-]?key|secret|credential(?:value)?)$/iu;
const PRIVATE_KEY_VALUE = /-----BEGIN [A-Z ]*PRIVATE KEY-----/u;

const DEFAULT_DEPENDENCIES = Object.freeze({
  acquireStoppedRuntimeGuard: acquireM6C1StoppedRuntimeGuard,
  bootstrapQualification: bootstrapM6Qualification,
  snapshotDatabase,
  validatePackage: validateM6QualificationBootstrapPackage,
  verifyCapabilitySeal: verifyM6GroundedRunCapabilitySeal,
  verifyReleaseManifest,
});

const QUALIFICATION_ROTATION_TASKS = Object.freeze([
  "XW Platform Control Plane",
  "XW Platform Orchestrator",
  "XW Platform FastOperator 03",
  "XW Platform FastOperator 04",
]);
const QUALIFICATION_ROTATION_PORTS = Object.freeze([17920, 17930]);

function inspectNativeQualificationRuntimeStopped({ includePorts = true } = {}) {
  if (process.platform !== "win32") {
    operatorError(
      "M64_QUALIFICATION_ROTATION_STOP_UNPROVEN",
      "native qualification rotation stop proof is available only on Windows",
    );
  }
  const powershell = join(
    process.env.SystemRoot || process.env.WINDIR || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const script = [
    "$ErrorActionPreference='Stop'",
    "$names=@(ConvertFrom-Json $args[0])",
    "$ports=@(ConvertFrom-Json $args[1])",
    "$tasks=@()",
    "foreach($name in $names){",
    "  $rows=@(Get-ScheduledTask -TaskName ([string]$name) -ErrorAction SilentlyContinue)",
    "  if($rows.Count -gt 1){ throw ('TASK_IDENTITY_AMBIGUOUS:' + $name) }",
    "  if($rows.Count -eq 0){ $tasks += [ordered]@{name=[string]$name;state='ABSENT'}; continue }",
    "  $state=[string]$rows[0].State",
    "  if($state -ne 'Ready' -and $state -ne 'Disabled'){ throw ('TASK_NOT_STOPPED:' + $name + ':' + $state) }",
    "  $tasks += [ordered]@{name=[string]$name;state=$state}",
    "}",
    "$free=@()",
    "foreach($port in $ports){",
    "  $listener=[System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback,[int]$port)",
    "  try { $listener.Server.ExclusiveAddressUse=$true; $listener.Start(); $free += [int]$port }",
    "  catch { throw ('LISTENER_NOT_STOPPED:' + [string]$port) }",
    "  finally { try { $listener.Stop() } catch {} }",
    "}",
    "[ordered]@{tasks=$tasks;exclusivePorts=$free} | ConvertTo-Json -Compress -Depth 4",
  ].join("; ");
  try {
    const raw = execFileSync(
      powershell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        script,
        JSON.stringify(QUALIFICATION_ROTATION_TASKS),
        JSON.stringify(includePorts ? QUALIFICATION_ROTATION_PORTS : []),
      ],
      {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
      },
    );
    const proof = JSON.parse(raw.trim());
    if (!Array.isArray(proof.tasks) || proof.tasks.length !== QUALIFICATION_ROTATION_TASKS.length
      || proof.tasks.some((row, index) => row?.name !== QUALIFICATION_ROTATION_TASKS[index]
        || !["ABSENT", "Disabled", "Ready"].includes(row?.state))
      || !Array.isArray(proof.exclusivePorts)
      || canonicalJson(proof.exclusivePorts) !== canonicalJson(
        includePorts ? QUALIFICATION_ROTATION_PORTS : [],
      )) {
      operatorError(
        "M64_QUALIFICATION_ROTATION_STOP_UNPROVEN",
        "scheduled-task/listener stop proof was incomplete",
      );
    }
    return Object.freeze({
      tasks: Object.freeze(proof.tasks.map((row) => Object.freeze({ ...row }))),
      exclusivePorts: Object.freeze([...proof.exclusivePorts]),
    });
  } catch (error) {
    if (error?.code?.startsWith?.("M64_QUALIFICATION_")) throw error;
    operatorError(
      "M64_QUALIFICATION_ROTATION_STOP_UNPROVEN",
      "control-plane tasks or listeners could not be proven stopped",
      { cause: error?.code ?? error?.message ?? null },
    );
  }
}

const DEFAULT_ROTATION_DEPENDENCIES = Object.freeze({
  ...DEFAULT_DEPENDENCIES,
  inspectRuntimeStopped: inspectNativeQualificationRuntimeStopped,
  now: Date.now,
  async acquireAuxiliaryPortGuard({ host = "127.0.0.1", port = 17930 } = {}) {
    const server = createServer();
    await new Promise((resolveListen, reject) => {
      server.once("error", reject);
      server.listen({ host, port, exclusive: true }, resolveListen);
    }).catch((cause) => {
      try { server.close(); } catch {}
      operatorError(
        "M64_QUALIFICATION_ROTATION_STOP_UNPROVEN",
        "qualification rotation could not retain exclusive ownership of the registry listener",
        { cause: cause?.code ?? null },
      );
    });
    return Object.freeze({
      async release() {
        await new Promise((resolveClose, rejectClose) => server.close((error) => (
          error ? rejectClose(error) : resolveClose()
        )));
      },
    });
  },
  async snapshotRotationDatabase({ sourcePath, destinationPath }) {
    const source = new DatabaseSync(
      `${pathToFileURL(sourcePath).href}?mode=ro&immutable=1`,
      { readOnly: true },
    );
    try {
      await sqliteBackup(source, destinationPath);
    } finally {
      source.close();
    }
    return Object.freeze({
      sourcePath: resolve(sourcePath),
      destinationPath: resolve(destinationPath),
    });
  },
  stageArtifacts: stageM6QualificationBootstrapRotationArtifacts,
  sealQualificationBinding: normalizeM64QualificationBootstrapBindingTcb,
  stateFactory: (options) => new StateStore(options),
});

function operatorError(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  throw error;
}

function exactObject(value, keys, code, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || canonicalJson(Object.keys(value).sort()) !== canonicalJson([...keys].sort())) {
    operatorError(code, `${label} must contain only its exact frozen fields`);
  }
  return value;
}

function without(value, key) {
  const { [key]: _ignored, ...rest } = value || {};
  return rest;
}

function normalizedPath(value) {
  const path = resolve(value);
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function samePath(left, right) {
  return normalizedPath(left) === normalizedPath(right);
}

function within(root, target) {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function sameIdentity(left, right) {
  return String(left.dev) === String(right.dev)
    && String(left.ino) === String(right.ino)
    && String(left.mode) === String(right.mode)
    && String(left.nlink) === String(right.nlink)
    && String(left.size) === String(right.size)
    && String(left.mtimeNs ?? left.mtimeMs) === String(right.mtimeNs ?? right.mtimeMs);
}

function absolutePath(value, label) {
  if (typeof value !== "string" || value.length < 3 || value.length > 32_767
    || value.includes("\0") || !isAbsolute(value)) {
    operatorError("M64_QUALIFICATION_OPERATOR_PATH_INVALID", `${label} must be one bounded absolute path`);
  }
  return resolve(value);
}

function assertPlainAncestors(path, label, { allowMissing = false, includeTarget = false } = {}) {
  const target = resolve(path);
  const volumeRoot = parse(target).root;
  let cursor = includeTarget ? target : dirname(target);
  while (cursor && normalizedPath(cursor) !== normalizedPath(volumeRoot)) {
    if (!existsSync(cursor)) {
      if (!allowMissing) {
        operatorError("M64_QUALIFICATION_OPERATOR_PATH_UNAVAILABLE", `${label} is unavailable`);
      }
      const next = dirname(cursor);
      if (next === cursor) break;
      cursor = next;
      continue;
    }
    let stat;
    let real;
    try {
      stat = lstatSync(cursor, { bigint: true });
      real = realpathSync.native(cursor);
    } catch (cause) {
      operatorError("M64_QUALIFICATION_OPERATOR_PATH_UNAVAILABLE", `${label} is unavailable`, {
        cause: cause?.code ?? null,
      });
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(real, cursor)) {
      operatorError(
        "M64_QUALIFICATION_OPERATOR_PATH_REPARSE",
        `${label} must not traverse a symlink, junction, reparse point, or non-directory ancestor`,
      );
    }
    const next = dirname(cursor);
    if (next === cursor) break;
    cursor = next;
  }
  return target;
}

function assertPlainDirectory(path, label) {
  const target = absolutePath(path, label);
  assertPlainAncestors(target, label, { includeTarget: true });
  return target;
}

function readPlainBytes(path, label, { controlledRoot = null, maxBytes = MAX_JSON_BYTES } = {}) {
  const target = absolutePath(path, label);
  assertPlainAncestors(target, label);
  if (controlledRoot !== null && !within(controlledRoot, target)) {
    operatorError("M64_QUALIFICATION_OPERATOR_PATH_ESCAPE", `${label} escapes its controlled root`);
  }
  let fd;
  try {
    const before = lstatSync(target, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
      || before.size < 1n || before.size > BigInt(maxBytes)) {
      operatorError(
        "M64_QUALIFICATION_OPERATOR_FILE_INVALID",
        `${label} must be one bounded single-link regular file`,
      );
    }
    fd = openSync(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const opened = fstatSync(fd, { bigint: true });
    const afterOpen = lstatSync(target, { bigint: true });
    if (!sameIdentity(before, opened) || !sameIdentity(opened, afterOpen)) {
      operatorError("M64_QUALIFICATION_OPERATOR_FILE_RACE", `${label} changed while it was opened`);
    }
    const bytes = readFileSync(fd);
    const afterRead = fstatSync(fd, { bigint: true });
    const pathAfterRead = lstatSync(target, { bigint: true });
    if (!sameIdentity(opened, afterRead) || !sameIdentity(afterRead, pathAfterRead)
      || pathAfterRead.isSymbolicLink() || pathAfterRead.nlink !== 1n
      || pathAfterRead.size !== BigInt(bytes.byteLength)) {
      operatorError("M64_QUALIFICATION_OPERATOR_FILE_RACE", `${label} changed while it was read`);
    }
    return Object.freeze({ bytes, path: target, sha256: sha256(bytes) });
  } catch (error) {
    if (error?.code?.startsWith?.("M64_QUALIFICATION_")) throw error;
    operatorError("M64_QUALIFICATION_OPERATOR_FILE_UNAVAILABLE", `${label} is unavailable`, {
      cause: error?.code ?? error?.message ?? null,
    });
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function readPlainJson(path, label, options = {}) {
  const file = readPlainBytes(path, label, options);
  try {
    return Object.freeze({ ...file, value: JSON.parse(file.bytes.toString("utf8")) });
  } catch {
    operatorError("M64_QUALIFICATION_OPERATOR_JSON_INVALID", `${label} is not valid JSON`);
  }
}

function assertNoSecretMaterial(value, label) {
  const visit = (item) => {
    if (typeof item === "string") {
      if (PRIVATE_KEY_VALUE.test(item)) {
        operatorError("M64_QUALIFICATION_OPERATOR_SECRET_FORBIDDEN", `${label} contains private-key material`);
      }
      return;
    }
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (!item || typeof item !== "object") return;
    for (const [key, child] of Object.entries(item)) {
      if (SECRET_KEY.test(key)) {
        operatorError("M64_QUALIFICATION_OPERATOR_SECRET_FORBIDDEN", `${label} contains forbidden secret field ${key}`);
      }
      visit(child);
    }
  };
  visit(value);
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function ensureControlledDirectory(root, relativePath) {
  const target = resolve(root, relativePath);
  if (!within(root, target)) {
    operatorError("M64_QUALIFICATION_OPERATOR_PATH_ESCAPE", "runtime publication directory escapes runtime root");
  }
  assertPlainAncestors(target, "runtime publication directory", { allowMissing: true, includeTarget: true });
  mkdirSync(target, { recursive: true });
  assertPlainAncestors(target, "runtime publication directory", { includeTarget: true });
  return target;
}

function mapPublicationError(error, driftCode, label) {
  if (!(error instanceof RecoverablePublicationError)) throw error;
  if (error.reason === "TARGET_DIFFERENT") {
    operatorError(driftCode, `existing ${label} differs from the exact planned bytes`);
  }
  if (/^(?:PARENT|TARGET|PENDING)_(?:UNSAFE|EXTERNAL_HARDLINK|RACE)$/u.test(error.reason)) {
    operatorError("M64_QUALIFICATION_OPERATOR_FILE_INVALID", `${label} publication topology is unsafe`, {
      reason: error.reason,
    });
  }
  operatorError("M64_QUALIFICATION_OPERATOR_WRITE_FAILED", `recoverable ${label} publication failed`, {
    reason: error.reason,
    cause: error.causeCode,
  });
}

function writeExactCreateOnly(path, bytes, { controlledRoot, faultAfter = () => {}, driftCode }) {
  const target = resolve(path);
  if (!within(controlledRoot, target)) {
    operatorError("M64_QUALIFICATION_OPERATOR_PATH_ESCAPE", "immutable runtime artifact escapes runtime root");
  }
  assertPlainAncestors(target, "immutable runtime artifact");
  try {
    const publication = publishRecoverableCreateOnly({ targetPath: target, bytes, faultAfter });
    return Object.freeze({
      path: target,
      replay: publication.replay,
      sha256: publication.sha256,
    });
  } catch (error) {
    mapPublicationError(error, driftCode ?? "M64_QUALIFICATION_OPERATOR_ARTIFACT_DRIFT", "immutable runtime artifact");
  }
}

function verifyReleaseAndTcb({ releaseRoot, package: input }, dependencies) {
  const root = assertPlainDirectory(releaseRoot, "immutable release root");
  const manifestPath = join(root, RELEASE_MANIFEST_FILENAME);
  const manifestFile = readPlainJson(manifestPath, "immutable release manifest", { controlledRoot: root });
  const verified = dependencies.verifyReleaseManifest({ root, manifestPath });
  if (!verified?.ok) {
    operatorError("M64_QUALIFICATION_OPERATOR_RELEASE_INVALID", "immutable release manifest verification failed", {
      mismatches: verified?.mismatches ?? [],
    });
  }
  if (manifestFile.value?.releaseId !== input.releaseId
    || manifestFile.value?.sourceCommit !== input.sourceCommit) {
    operatorError(
      "M64_QUALIFICATION_OPERATOR_RELEASE_REBOUND",
      "bootstrap package release/source differs from the immutable release",
    );
  }
  const capabilityFile = readPlainJson(
    join(root, "services", "control-plane", "apps", "xiaowei", "capabilities.json"),
    "grounded-run capability catalog",
    { controlledRoot: root },
  );
  const matches = capabilityFile.value?.capabilities?.filter?.(
    (item) => item?.id === M6_GROUNDED_RUN_CAPABILITY_ID,
  ) ?? [];
  if (matches.length !== 1) {
    operatorError(
      "M64_QUALIFICATION_OPERATOR_TCB_INVALID",
      "immutable release must contain exactly one grounded-run capability",
    );
  }
  const seal = dependencies.verifyCapabilitySeal({ capability: matches[0], rootDir: root });
  if (seal?.capabilityId !== M6_GROUNDED_RUN_CAPABILITY_ID
    || !HASH.test(seal?.implementationClosureHash ?? "")
    || typeof seal?.tcbManifestRef !== "string" || seal.tcbManifestRef === "") {
    operatorError("M64_QUALIFICATION_OPERATOR_TCB_INVALID", "grounded-run TCB seal did not reproduce exactly");
  }
  const finalVerification = dependencies.verifyReleaseManifest({ root, manifestPath });
  if (!finalVerification?.ok) {
    operatorError("M64_QUALIFICATION_OPERATOR_RELEASE_RACE", "immutable release changed during verification");
  }
  return Object.freeze({
    root,
    manifestPath,
    manifestSha256: manifestFile.sha256,
    manifest: manifestFile.value,
    seal,
  });
}

function tableCount(db, tables, table, where = "") {
  if (!tables.has(table)) return 0;
  return Number(db.prepare(`SELECT COUNT(*) AS count FROM "${table}"${where}`).get().count);
}

function inspectControlDatabase(dbPath, nowMs) {
  const file = readPlainBytes(dbPath, "control database", { maxBytes: 4 * 1024 * 1024 * 1024 });
  // A plain sqlite read-only open may still create -shm/-wal sidecars.  The
  // default operator must be byte-for-byte read-only, so reject a live or
  // uncheckpointed WAL boundary and inspect a proven standalone DB through an
  // immutable mode=ro URI.
  if (existsSync(`${file.path}-wal`) || existsSync(`${file.path}-shm`)) {
    operatorError(
      "M64_QUALIFICATION_OPERATOR_DB_WAL_PRESENT",
      "read-only preflight requires a stopped, fully checkpointed control database without WAL/SHM sidecars",
    );
  }
  const immutableUri = `${pathToFileURL(file.path).href}?mode=ro&immutable=1`;
  const db = new DatabaseSync(immutableUri, { readOnly: true });
  try {
    const quickCheck = db.prepare("PRAGMA quick_check").get().quick_check;
    const integrity = db.prepare("PRAGMA integrity_check").get().integrity_check;
    const userVersion = Number(db.prepare("PRAGMA user_version").get().user_version);
    const supportedVersion = userVersion === 18
      || (userVersion >= 20 && userVersion <= CURRENT_CONTROL_SCHEMA_VERSION);
    if (quickCheck !== "ok" || integrity !== "ok" || !supportedVersion) {
      operatorError(
        "M64_QUALIFICATION_OPERATOR_DB_INVALID",
        `qualification bootstrap requires one intact v18 source or supported v20-v${CURRENT_CONTROL_SCHEMA_VERSION} replay database`,
        { quickCheck, integrity, userVersion },
      );
    }
    const tables = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name),
    );
    const resources = Object.freeze({
      jobs: tableCount(db, tables, "jobs", " WHERE status IN ('queued','waiting_approval','running','verifying','restoring')"),
      sessions: tableCount(db, tables, "sessions", ` WHERE expires_at>${Number(nowMs)}`),
      leases: tableCount(db, tables, "leases", ` WHERE expires_at>${Number(nowMs)}`),
      actionCount: tableCount(db, tables, "device_session_actions", " WHERE execution_mode='m6-grounded-live-v2'"),
      pendingApprovals:
        tableCount(db, tables, "protected_commits", " WHERE status='waiting_authorization'")
        + tableCount(db, tables, "device_runs", " WHERE phase='waiting_authorization'")
        + tableCount(db, tables, "mission_effects", " WHERE status IN ('pending_authorization','waiting_authorization')"),
    });
    const durableM6Tables = [
      "m6_emergency_close_consumptions", "m6_grounding_permits", "m6_action_claims",
      "m6_grounded_action_details", "m6_live_window_authorization_consumptions",
      "m6_live_scenario_claims", "m6_gate_safety_close_arms",
    ];
    const durableResidue = Object.freeze(Object.fromEntries(
      durableM6Tables.map((table) => [table, tableCount(db, tables, table)]),
    ));
    if (Object.values(resources).some((count) => !Number.isSafeInteger(count) || count !== 0)
      || Object.values(durableResidue).some((count) => !Number.isSafeInteger(count) || count !== 0)) {
      operatorError(
        "M64_QUALIFICATION_OPERATOR_RESOURCES_NOT_ZERO",
        "qualification bootstrap requires zero active resources and zero M6 residue",
        { resources, durableResidue },
      );
    }
    const after = readPlainBytes(file.path, "control database", { maxBytes: 4 * 1024 * 1024 * 1024 });
    if (after.sha256 !== file.sha256 || existsSync(`${file.path}-wal`) || existsSync(`${file.path}-shm`)) {
      operatorError(
        "M64_QUALIFICATION_OPERATOR_DB_RACE",
        "control database changed or acquired a WAL boundary during read-only preflight",
      );
    }
    const fenceRow = tables.has("m6_gate_fence")
      ? db.prepare("SELECT * FROM m6_gate_fence WHERE marker='M6'").get()
      : null;
    const fence = fenceRow
      ? Object.freeze({
        gateId: fenceRow.gate_id,
        epochHash: fenceRow.epoch_hash,
        generation: Number(fenceRow.generation),
        mode: fenceRow.mode,
        purpose: fenceRow.purpose,
        allowlist: JSON.parse(fenceRow.allowlist_json),
        expiresAt: fenceRow.expires_at,
        releaseId: fenceRow.release_id,
        sourceCommit: fenceRow.source_commit,
        locksHash: fenceRow.locks_hash,
      })
      : null;
    return Object.freeze({
      path: file.path,
      sha256: file.sha256,
      quickCheck,
      integrityCheck: integrity,
      userVersion,
      resources,
      durableResidue,
      fence,
    });
  } finally {
    db.close();
  }
}

function validateSnapshotRoot({ snapshotRoot, runtimeRoot, dbPath }) {
  const root = absolutePath(snapshotRoot, "snapshot backup root");
  const dbRoot = dirname(dbPath);
  if (within(runtimeRoot, root) || within(root, runtimeRoot)
    || within(dbRoot, root) || within(root, dbRoot)) {
    operatorError(
      "M64_QUALIFICATION_OPERATOR_SNAPSHOT_ROOT_INVALID",
      "snapshot backup root must be disjoint from the mutable runtime and control DB directory",
    );
  }
  assertPlainAncestors(join(root, "prospective.snapshot.db"), "snapshot backup root", { allowMissing: true });
  return root;
}

function expectedRuntimePaths(runtimeRoot) {
  return Object.freeze({
    bindingPath: join(runtimeRoot, BINDING_RELATIVE_PATH),
    controlDbPath: join(runtimeRoot, "state", "control-plane", "control.db"),
    liveIssuerSentinelPath: join(runtimeRoot, LIVE_ISSUER_SENTINEL_RELATIVE_PATH),
    receiptRoot: join(runtimeRoot, RECEIPT_DIRECTORY),
    sentinelPath: join(runtimeRoot, SENTINEL_RELATIVE_PATH),
  });
}

function assertSentinelsUnavailable(paths) {
  for (const [label, path] of [
    ["Gate-F inventory sentinel", paths.sentinelPath],
    ["live-window issuer sentinel", paths.liveIssuerSentinelPath],
  ]) {
    assertPlainAncestors(path, label, { allowMissing: true });
    if (existsSync(path)) {
      operatorError(
        "M64_QUALIFICATION_OPERATOR_SENTINEL_PRESENT",
        `${label} must remain absent in QUALIFICATION_ONLY mode`,
      );
    }
  }
}

export function planM64QualificationBootstrap({
  bootstrapPackagePath,
  issuerAllowlistPath,
  releaseRoot,
  runtimeRoot,
  snapshotRoot,
  nowMs = Date.now(),
} = {}, dependencies = {}) {
  if (!Number.isFinite(nowMs)) {
    operatorError("M64_QUALIFICATION_OPERATOR_CLOCK_INVALID", "preflight requires one finite clock");
  }
  const deps = Object.freeze({ ...DEFAULT_DEPENDENCIES, ...dependencies });
  const runtime = assertPlainDirectory(runtimeRoot, "runtime root");
  const paths = expectedRuntimePaths(runtime);
  const packageFile = readPlainJson(bootstrapPackagePath, "externally signed bootstrap package");
  assertNoSecretMaterial(packageFile.value, "externally signed bootstrap package");
  const issuerPath = absolutePath(issuerAllowlistPath, "gate issuer allowlist");
  if (!within(runtime, issuerPath)) {
    operatorError(
      "M64_QUALIFICATION_OPERATOR_ISSUER_REBOUND",
      "gate issuer allowlist must be rooted in the exact runtime",
    );
  }
  const issuerFile = readPlainJson(issuerPath, "gate issuer allowlist", { controlledRoot: runtime });
  assertNoSecretMaterial(issuerFile.value, "gate issuer allowlist");
  const verifiedPackage = deps.validatePackage({
    package: packageFile.value,
    issuerAllowlistPath: issuerPath,
    m6Root: runtime,
    nowMs,
  });
  const issuerAfterValidation = readPlainBytes(issuerPath, "gate issuer allowlist", {
    controlledRoot: runtime,
  });
  if (!issuerAfterValidation.bytes.equals(issuerFile.bytes)) {
    operatorError(
      "M64_QUALIFICATION_OPERATOR_ISSUER_RACE",
      "gate issuer allowlist changed while the externally signed package was verified",
    );
  }
  const release = verifyReleaseAndTcb({ releaseRoot, package: verifiedPackage.package }, deps);
  const database = inspectControlDatabase(paths.controlDbPath, nowMs);
  const backupRoot = validateSnapshotRoot({
    snapshotRoot,
    runtimeRoot: runtime,
    dbPath: paths.controlDbPath,
  });
  assertSentinelsUnavailable(paths);
  const binding = buildM6QualificationBootstrapBinding({
    package: verifiedPackage.package,
    sourceReleaseRoot: release.root,
    releaseManifestSha256: release.manifestSha256,
    gateIssuerAllowlistPath: issuerPath,
    gateFArtifactInventoryPath: paths.sentinelPath,
    gateFArtifactInventoryHash: M64_QUALIFICATION_INVENTORY_SENTINEL_HASH,
  });
  const bindingBytes = jsonBytes(binding);
  const bindingSha256 = sha256(bindingBytes);
  let bindingPresent = false;
  let bindingNeedsRecovery = false;
  const pendingBindingPath = recoverablePublicationPendingPath(paths.bindingPath, bindingBytes);
  if (existsSync(paths.bindingPath) || existsSync(pendingBindingPath)) {
    try {
      const publication = inspectRecoverableCreateOnlyPublication({
        targetPath: paths.bindingPath,
        bytes: bindingBytes,
      });
      bindingPresent = publication.exactFinal;
      bindingNeedsRecovery = publication.needsRecovery;
    } catch (error) {
      mapPublicationError(error, "M64_QUALIFICATION_OPERATOR_BINDING_DRIFT", "qualification runtime binding");
    }
  } else {
    assertPlainAncestors(paths.bindingPath, "qualification runtime binding", { allowMissing: true });
  }
  if (bindingPresent && database.userVersion === 18) {
    operatorError(
      "M64_QUALIFICATION_OPERATOR_BINDING_AHEAD",
      "qualification binding may not be published before the v18 bootstrap fence",
    );
  }
  const snapshotLabel = `m6-c1-${verifiedPackage.package.packageHash.slice(0, 16)}`;
  const planBody = {
    ok: true,
    schemaId: "xw.m6-c1-qualification-bootstrap-operator-preflight.v1",
    executed: false,
    releaseId: verifiedPackage.package.releaseId,
    sourceCommit: verifiedPackage.package.sourceCommit,
    gateId: verifiedPackage.package.gateId,
    packageHash: verifiedPackage.package.packageHash,
    releaseManifestSha256: release.manifestSha256,
    implementationClosureHash: release.seal.implementationClosureHash,
    tcbManifestRef: release.seal.tcbManifestRef,
    databaseVersion: database.userVersion,
    resourceCounts: database.resources,
    bindingPath: paths.bindingPath,
    bindingSha256,
    bindingPresent,
    bindingNeedsRecovery,
    gateFArtifactInventoryPath: paths.sentinelPath,
    gateFArtifactInventoryHash: M64_QUALIFICATION_INVENTORY_SENTINEL_HASH,
    snapshotRoot: backupRoot,
    snapshotLabel,
    writesPerformed: 0,
    privateKeyAccessed: false,
    providerAccessed: false,
    deviceAccessed: false,
    networkAccessed: false,
  };
  return Object.freeze({
    ...planBody,
    preflightHash: sha256(`${planBody.schemaId}:${canonicalJson(planBody)}`),
    binding,
    package: verifiedPackage.package,
    paths,
  });
}

function qualificationFenceIdentity(value) {
  if (!value) return null;
  return Object.freeze({
    gateId: value.gateId,
    epochHash: value.epochHash,
    generation: value.generation,
    mode: value.mode,
    purpose: value.purpose,
    allowlist: value.allowlist,
    expiresAt: value.expiresAt,
    releaseId: value.releaseId,
    sourceCommit: value.sourceCommit,
    locksHash: value.locksHash,
  });
}

function qualificationFenceHash(value) {
  return sha256(`xw.m6-c1-qualification-fence.v1:${canonicalJson(qualificationFenceIdentity(value))}`);
}

function loadExpiredQualificationIdentity({
  runtimeRoot,
  issuerAllowlistPath,
  database,
  nextPackage,
  nowMs,
  dependencies,
}) {
  const fence = qualificationFenceIdentity(database.fence);
  if (database.userVersion < 20 || database.userVersion > CURRENT_CONTROL_SCHEMA_VERSION || !fence
    || fence.generation !== 0 || fence.mode !== "CLOSED" || fence.purpose !== null
    || canonicalJson(fence.allowlist) !== canonicalJson(["01"])
    || !HASH.test(fence.epochHash ?? "") || !HASH.test(fence.locksHash ?? "")
    || !Number.isFinite(Date.parse(fence.expiresAt ?? ""))
    || Date.parse(fence.expiresAt) > nowMs
    || fence.gateId === nextPackage.gateId) {
    operatorError(
      "M64_QUALIFICATION_ROTATION_FENCE_INELIGIBLE",
      `rotation requires one expired supported generation-0 alias-01 CLOSED fence and a distinct successor gate`,
    );
  }
  const paths = Object.freeze({
    bindingPath: join(runtimeRoot, BINDING_RELATIVE_PATH),
    gateRoot: join(runtimeRoot, "m6-gate", fence.gateId),
    pointerPath: join(runtimeRoot, "m6-gate", fence.gateId, "current.json"),
    receiptRoot: join(runtimeRoot, RECEIPT_DIRECTORY),
  });
  const bindingFile = readPlainJson(paths.bindingPath, "expired qualification binding", {
    controlledRoot: runtimeRoot,
  });
  exactObject(
    bindingFile.value,
    [
      "gateFArtifactInventoryHash", "gateFArtifactInventoryPath", "gateId",
      "gateIssuerAllowlistPath", "releaseId", "releaseManifestSha256", "schemaId",
      "sourceCommit", "sourceReleaseRoot",
    ],
    "M64_QUALIFICATION_ROTATION_OLD_IDENTITY_INVALID",
    "expired qualification binding",
  );
  if (bindingFile.value.schemaId !== "xw.runtime.m6-c1-qualification-bootstrap.v1"
    || bindingFile.value.gateId !== fence.gateId
    || bindingFile.value.releaseId !== fence.releaseId
    || bindingFile.value.sourceCommit !== fence.sourceCommit
    || !samePath(bindingFile.value.gateIssuerAllowlistPath, issuerAllowlistPath)
    || bindingFile.value.gateFArtifactInventoryHash !== M64_QUALIFICATION_INVENTORY_SENTINEL_HASH) {
    operatorError(
      "M64_QUALIFICATION_ROTATION_OLD_IDENTITY_INVALID",
      "expired binding does not reproduce the database fence identity",
    );
  }
  const pointerFile = readPlainJson(paths.pointerPath, "expired qualification pointer", {
    controlledRoot: runtimeRoot,
  });
  exactObject(
    pointerFile.value,
    ["chain", "generation", "promotedAt", "tailEpochHash"],
    "M64_QUALIFICATION_ROTATION_OLD_IDENTITY_INVALID",
    "expired qualification pointer",
  );
  if (pointerFile.value.generation !== 0 || pointerFile.value.tailEpochHash !== fence.epochHash
    || !Array.isArray(pointerFile.value.chain) || pointerFile.value.chain.length !== 2
    || pointerFile.value.chain[1] !== fence.epochHash) {
    operatorError(
      "M64_QUALIFICATION_ROTATION_OLD_IDENTITY_INVALID",
      "expired pointer does not reproduce the generation-0 fence",
    );
  }
  const packageRoot = join(paths.gateRoot, "qualification-bootstrap");
  assertPlainDirectory(packageRoot, "expired qualification package root");
  const packageNames = readdirSync(packageRoot)
    .filter((name) => /^[0-9a-f]{64}\.package\.json$/u.test(name));
  if (packageNames.length !== 1) {
    operatorError(
      "M64_QUALIFICATION_ROTATION_OLD_IDENTITY_INVALID",
      "expired gate must retain exactly one immutable bootstrap package",
    );
  }
  const packageFile = readPlainJson(
    join(packageRoot, packageNames[0]),
    "expired qualification package",
    { controlledRoot: runtimeRoot },
  );
  assertNoSecretMaterial(packageFile.value, "expired qualification package");
  const historicalNow = Date.parse(packageFile.value?.promotedAt ?? "");
  if (!Number.isFinite(historicalNow) || historicalNow > nowMs) {
    operatorError(
      "M64_QUALIFICATION_ROTATION_OLD_IDENTITY_INVALID",
      "expired package has no bounded historical verification instant",
    );
  }
  const verifiedOld = dependencies.validatePackage({
    package: packageFile.value,
    issuerAllowlistPath,
    m6Root: runtimeRoot,
    nowMs: historicalNow,
  });
  const oldLocksHash = sha256(
    `xw.m6-locks.v1:${canonicalJson(verifiedOld.closedEpoch.lockHashes)}`,
  );
  if (verifiedOld.package.gateId !== fence.gateId
    || verifiedOld.package.releaseId !== fence.releaseId
    || verifiedOld.package.sourceCommit !== fence.sourceCommit
    || verifiedOld.closedEpoch.epochHash !== fence.epochHash
    || basename(packageFile.path) !== `${verifiedOld.package.packageHash}.package.json`
    || canonicalJson(pointerFile.value.chain) !== canonicalJson([
      verifiedOld.rootEpoch.epochHash,
      verifiedOld.closedEpoch.epochHash,
    ])
    || pointerFile.value.promotedAt !== verifiedOld.package.promotedAt
    || oldLocksHash !== fence.locksHash
    || verifiedOld.package.resourceSnapshot.actionCount !== 0) {
    operatorError(
      "M64_QUALIFICATION_ROTATION_OLD_IDENTITY_INVALID",
      "expired signed package does not reproduce the zero-action database fence",
    );
  }
  assertPlainDirectory(paths.receiptRoot, "qualification receipt root");
  const receipts = readdirSync(paths.receiptRoot)
    .filter((name) => /^[0-9a-f]{64}\.json$/u.test(name))
    .map((name) => readPlainJson(join(paths.receiptRoot, name), "qualification operator receipt", {
      controlledRoot: runtimeRoot,
    }))
    .filter((entry) => entry.value?.gateId === fence.gateId
      && entry.value?.packageHash === verifiedOld.package.packageHash);
  if (receipts.length !== 1) {
    operatorError(
      "M64_QUALIFICATION_ROTATION_OLD_IDENTITY_INVALID",
      "expired gate must retain exactly one matching operator receipt",
    );
  }
  const receipt = receipts[0];
  const receiptBody = without(receipt.value, "receiptHash");
  const supportedReceiptSchema = receipt.value.schemaId === M64_QUALIFICATION_OPERATOR_RECEIPT_SCHEMA_ID
    || receipt.value.schemaId === M64_QUALIFICATION_ROTATION_RECEIPT_SCHEMA_ID;
  if (!supportedReceiptSchema
    || receipt.value.receiptHash !== sha256(
      `${receipt.value.schemaId}:${canonicalJson(receiptBody)}`,
    )
    || basename(receipt.path) !== `${receipt.value.receiptHash}.json`
    || receipt.value.closedEpochHash !== fence.epochHash
    || receipt.value.generation !== 0 || receipt.value.mode !== "CLOSED"
    || receipt.value.actionCount !== 0
    || receipt.value.bindingSha256 !== bindingFile.sha256
    || receipt.value.releaseManifestSha256 !== bindingFile.value.releaseManifestSha256
    || !samePath(receipt.value.bindingPath, bindingFile.path)
    || !samePath(
      receipt.value.gateFArtifactInventoryPath,
      bindingFile.value.gateFArtifactInventoryPath,
    )) {
    operatorError(
      "M64_QUALIFICATION_ROTATION_OLD_IDENTITY_INVALID",
      "expired operator receipt hash/fence identity is invalid",
    );
  }
  return Object.freeze({
    fence,
    fenceHash: qualificationFenceHash(fence),
    binding: bindingFile.value,
    bindingBytes: bindingFile.bytes,
    bindingSha256: bindingFile.sha256,
    package: verifiedOld.package,
    packagePath: packageFile.path,
    packageSha256: packageFile.sha256,
    pointer: pointerFile.value,
    pointerSha256: pointerFile.sha256,
    receipt: receipt.value,
    receiptPath: receipt.path,
    receiptSha256: receipt.sha256,
    paths,
  });
}

export function planM64QualificationBootstrapRotation({
  bootstrapPackagePath,
  issuerAllowlistPath,
  releaseRoot,
  runtimeRoot,
  snapshotRoot,
} = {}, dependencies = {}) {
  const deps = Object.freeze({ ...DEFAULT_ROTATION_DEPENDENCIES, ...dependencies });
  const nowMs = Number(deps.now());
  if (!Number.isFinite(nowMs)) {
    operatorError(
      "M64_QUALIFICATION_ROTATION_CLOCK_INVALID",
      "rotation requires the bounded operator clock",
    );
  }
  const stopped = deps.inspectRuntimeStopped({ includePorts: true });
  const runtime = assertPlainDirectory(runtimeRoot, "runtime root");
  const paths = expectedRuntimePaths(runtime);
  assertSentinelsUnavailable(paths);
  const packageFile = readPlainJson(
    bootstrapPackagePath,
    "externally signed rotation package",
  );
  assertNoSecretMaterial(packageFile.value, "externally signed rotation package");
  const issuerPath = absolutePath(issuerAllowlistPath, "gate issuer allowlist");
  if (!within(runtime, issuerPath)) {
    operatorError(
      "M64_QUALIFICATION_OPERATOR_ISSUER_REBOUND",
      "gate issuer allowlist must be rooted in the exact runtime",
    );
  }
  const issuerFile = readPlainJson(issuerPath, "gate issuer allowlist", {
    controlledRoot: runtime,
  });
  assertNoSecretMaterial(issuerFile.value, "gate issuer allowlist");
  const verifiedPackage = deps.validatePackage({
    package: packageFile.value,
    issuerAllowlistPath: issuerPath,
    m6Root: runtime,
    nowMs,
  });
  const issuerAfterValidation = readPlainBytes(issuerPath, "gate issuer allowlist", {
    controlledRoot: runtime,
  });
  if (!issuerAfterValidation.bytes.equals(issuerFile.bytes)) {
    operatorError(
      "M64_QUALIFICATION_OPERATOR_ISSUER_RACE",
      "gate issuer allowlist changed while the rotation package was verified",
    );
  }
  const release = verifyReleaseAndTcb({ releaseRoot, package: verifiedPackage.package }, deps);
  const database = inspectControlDatabase(paths.controlDbPath, nowMs);
  if (database.userVersion < 20 || database.userVersion > CURRENT_CONTROL_SCHEMA_VERSION) {
    operatorError(
      "M64_QUALIFICATION_ROTATION_DB_VERSION_INVALID",
      `rotation requires a supported v20-v${CURRENT_CONTROL_SCHEMA_VERSION} qualification database, not a v18 migration source`,
    );
  }
  const backupRoot = validateSnapshotRoot({
    snapshotRoot,
    runtimeRoot: runtime,
    dbPath: paths.controlDbPath,
  });
  const previous = loadExpiredQualificationIdentity({
    runtimeRoot: runtime,
    issuerAllowlistPath: issuerPath,
    database,
    nextPackage: verifiedPackage.package,
    nowMs,
    dependencies: deps,
  });
  const binding = buildM6QualificationBootstrapBinding({
    package: verifiedPackage.package,
    sourceReleaseRoot: release.root,
    releaseManifestSha256: release.manifestSha256,
    gateIssuerAllowlistPath: issuerPath,
    gateFArtifactInventoryPath: paths.sentinelPath,
    gateFArtifactInventoryHash: M64_QUALIFICATION_INVENTORY_SENTINEL_HASH,
  });
  const bindingBytes = jsonBytes(binding);
  const bindingSha256 = sha256(bindingBytes);
  if (bindingSha256 === previous.bindingSha256) {
    operatorError(
      "M64_QUALIFICATION_ROTATION_TARGET_INVALID",
      "rotation successor binding must differ from the expired binding",
    );
  }
  const nextFence = qualificationFenceIdentity({
    gateId: verifiedPackage.package.gateId,
    epochHash: verifiedPackage.closedEpoch.epochHash,
    generation: 0,
    mode: "CLOSED",
    purpose: null,
    allowlist: verifiedPackage.closedEpoch.allowlist,
    expiresAt: verifiedPackage.closedEpoch.expiresAt,
    releaseId: verifiedPackage.package.releaseId,
    sourceCommit: verifiedPackage.package.sourceCommit,
    locksHash: sha256(
      `xw.m6-locks.v1:${canonicalJson(verifiedPackage.closedEpoch.lockHashes)}`,
    ),
  });
  const rotationId = sha256(`xw.m6-c1-qualification-bootstrap-rotation.v1:${canonicalJson({
    previousFenceHash: previous.fenceHash,
    nextFenceHash: qualificationFenceHash(nextFence),
    packageHash: verifiedPackage.package.packageHash,
    bindingSha256,
  })}`);
  const archiveRoot = join(runtime, "qualification-bootstrap", "rotations", rotationId);
  assertPlainAncestors(archiveRoot, "qualification rotation archive", {
    allowMissing: true,
    includeTarget: true,
  });
  const snapshotLabel = `m6-c1-rotation-${rotationId.slice(0, 16)}`;
  const body = {
    ok: true,
    schemaId: "xw.m6-c1-qualification-bootstrap-rotation-preflight.v1",
    executed: false,
    rotationId,
    plannedAt: new Date(nowMs).toISOString(),
    previousFence: previous.fence,
    previousFenceHash: previous.fenceHash,
    nextFence,
    nextFenceHash: qualificationFenceHash(nextFence),
    packageHash: verifiedPackage.package.packageHash,
    packageSha256: packageFile.sha256,
    issuerAllowlistSha256: issuerFile.sha256,
    releaseManifestSha256: release.manifestSha256,
    implementationClosureHash: release.seal.implementationClosureHash,
    tcbManifestRef: release.seal.tcbManifestRef,
    databaseSha256: database.sha256,
    databaseVersion: database.userVersion,
    databaseQuickCheck: database.quickCheck,
    resourceCounts: database.resources,
    durableM6Residue: database.durableResidue,
    stoppedRuntime: stopped,
    previousBindingSha256: previous.bindingSha256,
    nextBindingSha256: bindingSha256,
    previousPackageHash: previous.package.packageHash,
    previousPointerSha256: previous.pointerSha256,
    previousReceiptHash: previous.receipt.receiptHash,
    archiveRoot,
    snapshotRoot: backupRoot,
    snapshotLabel,
    writesPerformed: 0,
    privateKeyAccessed: false,
    providerAccessed: false,
    deviceAccessed: false,
    networkAccessed: false,
  };
  return Object.freeze({
    ...body,
    preflightHash: sha256(`${body.schemaId}:${canonicalJson(body)}`),
    binding,
    bindingBytes,
    package: verifiedPackage.package,
    previous,
    paths,
  });
}

function inspectRotationSnapshot(path, expectedFence, expectedVersion) {
  const file = readPlainBytes(path, "qualification rotation database snapshot", {
    maxBytes: 4 * 1024 * 1024 * 1024,
  });
  if (existsSync(`${file.path}-wal`) || existsSync(`${file.path}-shm`)) {
    operatorError(
      "M64_QUALIFICATION_ROTATION_SNAPSHOT_INVALID",
      "rotation snapshot must be one standalone SQLite database",
    );
  }
  const db = new DatabaseSync(`${pathToFileURL(file.path).href}?mode=ro&immutable=1`, {
    readOnly: true,
  });
  try {
    const quickCheck = db.prepare("PRAGMA quick_check").get().quick_check;
    const integrityCheck = db.prepare("PRAGMA integrity_check").get().integrity_check;
    const userVersion = Number(db.prepare("PRAGMA user_version").get().user_version);
    const row = db.prepare("SELECT * FROM m6_gate_fence WHERE marker='M6'").get();
    const fence = row ? qualificationFenceIdentity({
      gateId: row.gate_id,
      epochHash: row.epoch_hash,
      generation: Number(row.generation),
      mode: row.mode,
      purpose: row.purpose,
      allowlist: JSON.parse(row.allowlist_json),
      expiresAt: row.expires_at,
      releaseId: row.release_id,
      sourceCommit: row.source_commit,
      locksHash: row.locks_hash,
    }) : null;
    if (quickCheck !== "ok" || integrityCheck !== "ok" || userVersion !== expectedVersion
      || canonicalJson(fence) !== canonicalJson(expectedFence)) {
      operatorError(
        "M64_QUALIFICATION_ROTATION_SNAPSHOT_INVALID",
        "rotation snapshot did not reproduce the exact old fence and database version",
      );
    }
    return Object.freeze({
      path: file.path,
      sha256: file.sha256,
      sizeBytes: file.bytes.byteLength,
      quickCheck,
      integrityCheck,
      userVersion,
      fence,
    });
  } finally {
    db.close();
  }
}

async function createQualificationRotationSnapshots(plan, dependencies) {
  assertPlainAncestors(plan.snapshotRoot, "qualification rotation snapshot root", {
    allowMissing: true,
    includeTarget: true,
  });
  mkdirSync(plan.snapshotRoot, { recursive: true });
  assertPlainDirectory(plan.snapshotRoot, "qualification rotation snapshot root");
  const onlinePath = join(plan.snapshotRoot, `${plan.snapshotLabel}.snapshot.db`);
  const offlinePath = join(plan.snapshotRoot, `${plan.snapshotLabel}.offline.db`);
  if (existsSync(onlinePath) || existsSync(offlinePath)) {
    operatorError(
      "M64_QUALIFICATION_ROTATION_SNAPSHOT_EXISTS",
      "rotation snapshot destinations are create-only; use a fresh snapshot root after an abandoned attempt",
    );
  }
  try {
    copyFileSync(plan.paths.controlDbPath, offlinePath, fsConstants.COPYFILE_EXCL);
    const fd = openSync(offlinePath, fsConstants.O_RDWR);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch (cause) {
    operatorError(
      "M64_QUALIFICATION_ROTATION_SNAPSHOT_INVALID",
      "exact offline database snapshot could not be created",
      { cause: cause?.code ?? cause?.message ?? null },
    );
  }
  const offline = inspectRotationSnapshot(
    offlinePath,
    plan.previousFence,
    plan.databaseVersion,
  );
  if (offline.sha256 !== plan.databaseSha256) {
    operatorError(
      "M64_QUALIFICATION_ROTATION_SNAPSHOT_INVALID",
      "offline database snapshot is not the exact pre-rotation bytes",
    );
  }
  const onlineRaw = await dependencies.snapshotRotationDatabase({
    sourcePath: plan.paths.controlDbPath,
    destinationPath: onlinePath,
  });
  if (!onlineRaw
    || resolve(onlineRaw.sourcePath ?? "") !== resolve(plan.paths.controlDbPath)
    || resolve(onlineRaw.destinationPath ?? "") !== onlinePath) {
    operatorError(
      "M64_QUALIFICATION_ROTATION_SNAPSHOT_INVALID",
      "online SQLite backup callback escaped the exact source/destination",
    );
  }
  const online = inspectRotationSnapshot(
    onlinePath,
    plan.previousFence,
    plan.databaseVersion,
  );
  const sourceAfter = inspectControlDatabase(
    plan.paths.controlDbPath,
    Number(dependencies.now()),
  );
  if (sourceAfter.sha256 !== plan.databaseSha256
    || canonicalJson(sourceAfter.fence) !== canonicalJson(plan.previousFence)) {
    operatorError(
      "M64_QUALIFICATION_ROTATION_DB_RACE",
      "control database changed while rotation snapshots were created",
    );
  }
  return Object.freeze({ online, offline, onlineRaw });
}

function replaceQualificationBindingCas({
  targetPath,
  expectedSha256,
  replacementBytes,
  controlledRoot,
  rotationId,
}) {
  const before = readPlainBytes(targetPath, "qualification binding CAS source", {
    controlledRoot,
  });
  if (before.sha256 !== expectedSha256) {
    operatorError(
      "M64_QUALIFICATION_ROTATION_BINDING_CAS_MISMATCH",
      "well-known qualification binding changed before CAS replacement",
    );
  }
  const temp = join(dirname(targetPath), `.${basename(targetPath)}.${rotationId}.tmp`);
  if (existsSync(temp)) {
    operatorError(
      "M64_QUALIFICATION_ROTATION_BINDING_CAS_MISMATCH",
      "well-known binding CAS staging path is not empty",
    );
  }
  let installed = false;
  try {
    const fd = openSync(temp, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    try {
      writeFileSync(fd, replacementBytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const staged = readPlainBytes(temp, "qualification binding CAS staging", {
      controlledRoot,
    });
    const expectedReplacementHash = sha256(replacementBytes);
    if (staged.sha256 !== expectedReplacementHash) {
      operatorError(
        "M64_QUALIFICATION_ROTATION_BINDING_CAS_MISMATCH",
        "well-known binding CAS staging bytes drifted",
      );
    }
    const immediatelyBefore = readPlainBytes(targetPath, "qualification binding CAS source", {
      controlledRoot,
    });
    if (immediatelyBefore.sha256 !== expectedSha256) {
      operatorError(
        "M64_QUALIFICATION_ROTATION_BINDING_CAS_MISMATCH",
        "well-known qualification binding changed during CAS replacement",
      );
    }
    renameSync(temp, targetPath);
    installed = true;
    const after = readPlainBytes(targetPath, "qualification binding CAS result", {
      controlledRoot,
    });
    if (after.sha256 !== expectedReplacementHash) {
      operatorError(
        "M64_QUALIFICATION_ROTATION_BINDING_CAS_MISMATCH",
        "well-known qualification binding failed CAS readback",
      );
    }
    return Object.freeze({
      path: targetPath,
      previousSha256: expectedSha256,
      sha256: after.sha256,
    });
  } catch (error) {
    if (installed && error && typeof error === "object") error.bindingInstalled = true;
    if (!installed && existsSync(temp)) {
      try { rmSync(temp, { force: true }); } catch {}
    }
    throw error;
  }
}

function restoreQualificationRotationDatabase(plan, snapshots) {
  if (existsSync(`${plan.paths.controlDbPath}-wal`) || existsSync(`${plan.paths.controlDbPath}-shm`)) {
    operatorError(
      "M64_QUALIFICATION_ROTATION_ROLLBACK_UNPROVEN",
      "database WAL/SHM remained at rollback boundary",
    );
  }
  const temp = `${plan.paths.controlDbPath}.${plan.rotationId}.rollback.tmp`;
  if (existsSync(temp)) rmSync(temp, { force: true });
  copyFileSync(snapshots.offline.path, temp, fsConstants.COPYFILE_EXCL);
  const fd = openSync(temp, fsConstants.O_RDWR);
  try { fsyncSync(fd); } finally { closeSync(fd); }
  const staged = readPlainBytes(temp, "qualification database rollback staging", {
    maxBytes: 4 * 1024 * 1024 * 1024,
  });
  if (staged.sha256 !== plan.databaseSha256) {
    operatorError(
      "M64_QUALIFICATION_ROTATION_ROLLBACK_UNPROVEN",
      "database rollback staging bytes differ from the exact offline snapshot",
    );
  }
  renameSync(temp, plan.paths.controlDbPath);
  const restored = inspectControlDatabase(
    plan.paths.controlDbPath,
    Date.parse(plan.plannedAt),
  );
  if (restored.sha256 !== plan.databaseSha256
    || canonicalJson(restored.fence) !== canonicalJson(plan.previousFence)) {
    operatorError(
      "M64_QUALIFICATION_ROTATION_ROLLBACK_UNPROVEN",
      "database rollback did not reproduce the old qualification identity",
    );
  }
  return restored;
}

function verifyQualificationRotationOldIdentity(plan) {
  const binding = readPlainBytes(plan.paths.bindingPath, "restored qualification binding", {
    controlledRoot: dirname(dirname(plan.paths.bindingPath)),
  });
  const database = inspectControlDatabase(plan.paths.controlDbPath, Date.parse(plan.plannedAt));
  if (binding.sha256 !== plan.previousBindingSha256
    || database.sha256 !== plan.databaseSha256
    || canonicalJson(database.fence) !== canonicalJson(plan.previousFence)) {
    operatorError(
      "M64_QUALIFICATION_ROTATION_ROLLBACK_UNPROVEN",
      "old qualification database/binding identity was not completely restored",
    );
  }
  return Object.freeze({
    bindingSha256: binding.sha256,
    databaseSha256: database.sha256,
    fenceHash: qualificationFenceHash(database.fence),
  });
}

export async function operateM64QualificationBootstrapRotation(input = {}, {
  execute = false,
  dependencies = {},
  faultAfter = () => {},
} = {}) {
  const deps = Object.freeze({ ...DEFAULT_ROTATION_DEPENDENCIES, ...dependencies });
  const firstPlan = planM64QualificationBootstrapRotation(input, deps);
  if (!execute) return firstPlan;
  let guard = null;
  let auxiliaryPortGuard = null;
  let plan = firstPlan;
  let snapshots = null;
  let state = null;
  let databaseMutated = false;
  let bindingMutated = false;
  let cleanupProven = true;
  let primaryError = null;
  try {
    guard = await deps.acquireStoppedRuntimeGuard({
      runtimeRoot: resolve(input.runtimeRoot),
      ownerKind: "QUALIFICATION_ROTATION",
      host: "127.0.0.1",
      port: 17920,
    });
    if (!guard || typeof guard.assertOwned !== "function" || typeof guard.release !== "function"
      || typeof guard.retainStaleLock !== "function") {
      operatorError(
        "M64_QUALIFICATION_ROTATION_OWNER_GUARD_INVALID",
        "qualification rotation stopped-runtime guard is unavailable",
      );
    }
    guard.assertOwned();
    auxiliaryPortGuard = await deps.acquireAuxiliaryPortGuard({
      host: "127.0.0.1",
      port: 17930,
    });
    if (!auxiliaryPortGuard || typeof auxiliaryPortGuard.release !== "function") {
      operatorError(
        "M64_QUALIFICATION_ROTATION_OWNER_GUARD_INVALID",
        "qualification rotation registry-listener guard is unavailable",
      );
    }
    const taskProof = deps.inspectRuntimeStopped({ includePorts: false });
    plan = planM64QualificationBootstrapRotation(input, {
      ...deps,
      inspectRuntimeStopped: () => Object.freeze({
        ...taskProof,
        exclusivePorts: Object.freeze([...QUALIFICATION_ROTATION_PORTS]),
        ownerGuardHeld: true,
      }),
    });
    if (plan.rotationId !== firstPlan.rotationId
      || plan.databaseSha256 !== firstPlan.databaseSha256
      || plan.previousBindingSha256 !== firstPlan.previousBindingSha256
      || plan.packageHash !== firstPlan.packageHash
      || plan.nextBindingSha256 !== firstPlan.nextBindingSha256) {
      operatorError(
        "M64_QUALIFICATION_ROTATION_CONCURRENT_CHANGE",
        "qualification rotation identity changed between preflight and stopped execution",
      );
    }
    guard.assertOwned();
    snapshots = await createQualificationRotationSnapshots(plan, deps);
    faultAfter("snapshots", { plan, snapshots });
    guard.assertOwned();

    ensureControlledDirectory(resolve(input.runtimeRoot), relative(resolve(input.runtimeRoot), plan.archiveRoot));
    const archivedBinding = writeExactCreateOnly(
      join(plan.archiveRoot, "previous-binding.v1.json"),
      plan.previous.bindingBytes,
      {
        controlledRoot: resolve(input.runtimeRoot),
        driftCode: "M64_QUALIFICATION_ROTATION_ARCHIVE_DRIFT",
      },
    );
    const archiveIndexBody = {
      schemaId: "xw.m6-c1-qualification-bootstrap-rotation-archive.v1",
      rotationId: plan.rotationId,
      previousFence: plan.previousFence,
      previousFenceHash: plan.previousFenceHash,
      nextFence: plan.nextFence,
      nextFenceHash: plan.nextFenceHash,
      previousBinding: { path: archivedBinding.path, sha256: archivedBinding.sha256 },
      previousGate: {
        packagePath: plan.previous.packagePath,
        packageHash: plan.previous.package.packageHash,
        pointerPath: plan.previous.paths.pointerPath,
        pointerSha256: plan.previous.pointerSha256,
      },
      previousReceipt: {
        path: plan.previous.receiptPath,
        receiptHash: plan.previous.receipt.receiptHash,
        sha256: plan.previous.receiptSha256,
      },
      snapshots: {
        online: { path: snapshots.online.path, sha256: snapshots.online.sha256 },
        offline: { path: snapshots.offline.path, sha256: snapshots.offline.sha256 },
      },
    };
    const archiveIndex = Object.freeze({
      ...archiveIndexBody,
      archiveHash: sha256(
        `xw.m6-c1-qualification-bootstrap-rotation-archive.v1:${canonicalJson(archiveIndexBody)}`,
      ),
    });
    writeExactCreateOnly(
      join(plan.archiveRoot, "archive.v1.json"),
      jsonBytes(archiveIndex),
      {
        controlledRoot: resolve(input.runtimeRoot),
        driftCode: "M64_QUALIFICATION_ROTATION_ARCHIVE_DRIFT",
      },
    );
    faultAfter("archive", { plan, archiveIndex });
    guard.assertOwned();
    assertSentinelsUnavailable(plan.paths);

    const staged = deps.stageArtifacts({
      package: plan.package,
      m6Root: resolve(input.runtimeRoot),
      issuerAllowlistPath: resolve(input.issuerAllowlistPath),
      nowMs: Number(deps.now()),
    });
    faultAfter("artifacts", { plan, staged });
    guard.assertOwned();
    assertSentinelsUnavailable(plan.paths);

    cleanupProven = false;
    state = deps.stateFactory({
      dbPath: plan.paths.controlDbPath,
      now: deps.now,
      m6RuntimeMode: "QUALIFICATION_ONLY",
    });
    const rotated = state.rotateM6QualificationBootstrapFence({
      expectedFence: plan.previousFence,
      nextEpoch: staged.closedEpoch,
      locksHash: plan.nextFence.locksHash,
      packageHash: plan.packageHash,
    });
    databaseMutated = true;
    if (state.db?.exec) state.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    state.close();
    state = null;
    if (existsSync(`${plan.paths.controlDbPath}-wal`) || existsSync(`${plan.paths.controlDbPath}-shm`)) {
      operatorError(
        "M64_QUALIFICATION_ROTATION_DB_WAL_PRESENT",
        "rotation database did not return to a standalone checkpointed boundary",
      );
    }
    faultAfter("database", { plan, rotated });
    guard.assertOwned();
    writeExactCreateOnly(
      staged.paths.current,
      jsonBytes(staged.pointer),
      {
        controlledRoot: resolve(input.runtimeRoot),
        driftCode: "M64_QUALIFICATION_ROTATION_POINTER_DRIFT",
      },
    );
    faultAfter("pointer", { plan, staged });
    guard.assertOwned();

    let bindingCas;
    try {
      bindingCas = replaceQualificationBindingCas({
        targetPath: plan.paths.bindingPath,
        expectedSha256: plan.previousBindingSha256,
        replacementBytes: plan.bindingBytes,
        controlledRoot: resolve(input.runtimeRoot),
        rotationId: plan.rotationId,
      });
      bindingMutated = true;
    } catch (error) {
      bindingMutated = error?.bindingInstalled === true;
      throw error;
    }
    const sealedBinding = deps.sealQualificationBinding({
      runtimeRoot: resolve(input.runtimeRoot),
    });
    if (!samePath(sealedBinding?.path ?? "", plan.paths.bindingPath)
      || sealedBinding?.sha256 !== plan.nextBindingSha256
      || sealedBinding?.protectedDacl !== true) {
      operatorError(
        "M64_QUALIFICATION_ROTATION_BINDING_TCB_INVALID",
        "rotated qualification binding did not enter the fixed protected TCB",
      );
    }
    faultAfter("bindingTcb", { plan, bindingCas, sealedBinding });
    faultAfter("binding", { plan, bindingCas });
    guard.assertOwned();
    assertSentinelsUnavailable(plan.paths);

    const postDatabase = inspectControlDatabase(plan.paths.controlDbPath, Number(deps.now()));
    const postIssuer = readPlainBytes(
      resolve(input.issuerAllowlistPath),
      "post-rotation gate issuer allowlist",
      { controlledRoot: resolve(input.runtimeRoot) },
    );
    deps.validatePackage({
      package: plan.package,
      issuerAllowlistPath: resolve(input.issuerAllowlistPath),
      m6Root: resolve(input.runtimeRoot),
      nowMs: Number(deps.now()),
    });
    const postBinding = readPlainBytes(plan.paths.bindingPath, "post-rotation qualification binding", {
      controlledRoot: resolve(input.runtimeRoot),
    });
    if (canonicalJson(postDatabase.fence) !== canonicalJson(plan.nextFence)
      || postDatabase.quickCheck !== "ok"
      || postBinding.sha256 !== plan.nextBindingSha256
      || postIssuer.sha256 !== plan.issuerAllowlistSha256) {
      operatorError(
        "M64_QUALIFICATION_ROTATION_POSTCONDITION_FAILED",
        "rotation did not reproduce the signed package, allowlist, fence, and binding identity",
      );
    }
    const receiptBody = {
      schemaId: M64_QUALIFICATION_ROTATION_RECEIPT_SCHEMA_ID,
      rotationId: plan.rotationId,
      gateId: plan.nextFence.gateId,
      closedEpochHash: plan.nextFence.epochHash,
      generation: 0,
      mode: "CLOSED",
      previousFenceHash: plan.previousFenceHash,
      nextFenceHash: plan.nextFenceHash,
      packageHash: plan.packageHash,
      bindingPath: plan.paths.bindingPath,
      previousBindingSha256: plan.previousBindingSha256,
      bindingSha256: plan.nextBindingSha256,
      gateFArtifactInventoryPath: plan.paths.sentinelPath,
      gateFArtifactInventoryHash: M64_QUALIFICATION_INVENTORY_SENTINEL_HASH,
      issuerAllowlistSha256: plan.issuerAllowlistSha256,
      releaseManifestSha256: plan.releaseManifestSha256,
      onlineSnapshotSha256: snapshots.online.sha256,
      offlineSnapshotSha256: snapshots.offline.sha256,
      databaseAuditEventId: rotated.eventId,
      databaseAuditRotationHash: rotated.audit.rotationHash,
      previousGatePath: plan.previous.paths.gateRoot,
      previousReceiptPath: plan.previous.receiptPath,
      archiveRoot: plan.archiveRoot,
      actionCount: postDatabase.resources.actionCount,
      resourceCounts: postDatabase.resources,
      privateKeyAccessed: false,
      providerAccessed: false,
      deviceAccessed: false,
      networkAccessed: false,
    };
    const receipt = Object.freeze({
      ...receiptBody,
      receiptHash: sha256(
        `${M64_QUALIFICATION_ROTATION_RECEIPT_SCHEMA_ID}:${canonicalJson(receiptBody)}`,
      ),
    });
    faultAfter("beforeReceipt", { plan, receipt });
    const receiptPublication = writeExactCreateOnly(
      join(plan.paths.receiptRoot, `${receipt.receiptHash}.json`),
      jsonBytes(receipt),
      {
        controlledRoot: resolve(input.runtimeRoot),
        driftCode: "M64_QUALIFICATION_ROTATION_RECEIPT_DRIFT",
      },
    );
    cleanupProven = true;
    return Object.freeze({
      ok: true,
      schemaId: "xw.m6-c1-qualification-bootstrap-rotation-result.v1",
      executed: true,
      status: "ROTATED",
      rotationId: plan.rotationId,
      receiptPath: receiptPublication.path,
      receipt,
      archiveRoot: plan.archiveRoot,
      previousGatePath: plan.previous.paths.gateRoot,
      previousReceiptPath: plan.previous.receiptPath,
      bindingPath: plan.paths.bindingPath,
      snapshotPaths: Object.freeze([snapshots.online.path, snapshots.offline.path]),
      privateKeyAccessed: false,
      providerAccessed: false,
      deviceAccessed: false,
      networkAccessed: false,
    });
  } catch (error) {
    primaryError = error;
    if (state) {
      try {
        if (state.db?.exec) state.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        state.close();
        state = null;
      } catch {
        cleanupProven = false;
      }
    }
    if (snapshots && (databaseMutated || bindingMutated)) {
      try {
        if (bindingMutated) {
          replaceQualificationBindingCas({
            targetPath: plan.paths.bindingPath,
            expectedSha256: plan.nextBindingSha256,
            replacementBytes: plan.previous.bindingBytes,
            controlledRoot: resolve(input.runtimeRoot),
            rotationId: `${plan.rotationId}.restore`,
          });
          const restoredBindingTcb = deps.sealQualificationBinding({
            runtimeRoot: resolve(input.runtimeRoot),
          });
          if (!samePath(restoredBindingTcb?.path ?? "", plan.paths.bindingPath)
            || restoredBindingTcb?.sha256 !== plan.previousBindingSha256
            || restoredBindingTcb?.protectedDacl !== true) {
            operatorError(
              "M64_QUALIFICATION_ROTATION_ROLLBACK_TCB_INVALID",
              "restored qualification binding did not re-enter the fixed protected TCB",
            );
          }
          bindingMutated = false;
        }
        if (databaseMutated) {
          restoreQualificationRotationDatabase(plan, snapshots);
          databaseMutated = false;
        }
        const restored = verifyQualificationRotationOldIdentity(plan);
        const rollbackBody = {
          schemaId: "xw.m6-c1-qualification-bootstrap-rotation-rollback.v1",
          rotationId: plan.rotationId,
          causeCode: error?.code ?? "M64_QUALIFICATION_ROTATION_FAILED",
          restored,
        };
        const rollback = Object.freeze({
          ...rollbackBody,
          rollbackHash: sha256(
            `xw.m6-c1-qualification-bootstrap-rotation-rollback.v1:${canonicalJson(rollbackBody)}`,
          ),
        });
        writeExactCreateOnly(
          join(plan.archiveRoot, `${rollback.rollbackHash}.rollback.json`),
          jsonBytes(rollback),
          {
            controlledRoot: resolve(input.runtimeRoot),
            driftCode: "M64_QUALIFICATION_ROTATION_ROLLBACK_DRIFT",
          },
        );
        cleanupProven = true;
        error.rotationRollback = restored;
      } catch (rollbackError) {
        cleanupProven = false;
        error.rotationRollbackError = rollbackError?.code ?? rollbackError?.message ?? "UNKNOWN";
      }
    }
    throw error;
  } finally {
    let finalizationError = null;
    if (auxiliaryPortGuard) {
      try {
        await auxiliaryPortGuard.release();
      } catch (releaseError) {
        cleanupProven = false;
        finalizationError = releaseError;
      }
    }
    if (guard) {
      try {
        if (cleanupProven) await guard.release();
        else await guard.retainStaleLock();
      } catch (releaseError) {
        if (!finalizationError) finalizationError = releaseError;
      }
    }
    if (!primaryError && finalizationError) throw finalizationError;
  }
}

function deriveOperatorReceipt({ plan, result, bindingSha256 }) {
  const body = {
    schemaId: M64_QUALIFICATION_OPERATOR_RECEIPT_SCHEMA_ID,
    releaseId: plan.releaseId,
    sourceCommit: plan.sourceCommit,
    gateId: plan.gateId,
    packageHash: plan.packageHash,
    rootEpochHash: plan.package.rootEpochRecord.epochHash,
    closedEpochHash: result.epochHash,
    generation: result.generation,
    mode: result.mode,
    locksHash: result.locksHash,
    releaseManifestSha256: plan.releaseManifestSha256,
    implementationClosureHash: plan.implementationClosureHash,
    tcbManifestRef: plan.tcbManifestRef,
    bootstrapResultHash: result.resultHash,
    dbSnapshotReceiptHash: result.dbSnapshotReceipt.receiptHash,
    snapshotSha256: result.dbSnapshotReceipt.snapshotSha256,
    bindingPath: plan.paths.bindingPath,
    bindingSha256,
    gateFArtifactInventoryPath: plan.paths.sentinelPath,
    gateFArtifactInventoryHash: M64_QUALIFICATION_INVENTORY_SENTINEL_HASH,
    actionCount: result.actionCount,
    resourceCounts: result.resourceCounts,
    privateKeyAccessed: false,
    secretMaterialPresent: false,
    providerAccessed: false,
    deviceAccessed: false,
    networkAccessed: false,
  };
  return Object.freeze({
    ...body,
    receiptHash: sha256(`${M64_QUALIFICATION_OPERATOR_RECEIPT_SCHEMA_ID}:${canonicalJson(body)}`),
  });
}

export async function operateM64QualificationBootstrap(input = {}, {
  execute = false,
  dependencies = {},
  publicationFaultAfter = () => {},
} = {}) {
  const deps = Object.freeze({ ...DEFAULT_DEPENDENCIES, ...dependencies });
  if (!execute) return planM64QualificationBootstrap(input, deps);
  const runtimeRoot = absolutePath(input.runtimeRoot, "runtime root");
  let guard = null;
  let primaryError = null;
  let bootstrapCleanupProven = true;
  try {
    guard = await deps.acquireStoppedRuntimeGuard({
      runtimeRoot,
      ownerKind: "QUALIFICATION_BOOTSTRAP",
      host: "127.0.0.1",
      port: 17920,
    });
    if (!guard || typeof guard.assertOwned !== "function" || typeof guard.release !== "function"
      || typeof guard.retainStaleLock !== "function") {
      operatorError(
        "M64_QUALIFICATION_OPERATOR_OWNER_GUARD_INVALID",
        "shared M6-C1 stopped-runtime guard is unavailable",
      );
    }
    guard.assertOwned();
    const plan = planM64QualificationBootstrap(input, deps);
    guard.assertOwned();
    bootstrapCleanupProven = false;
    let result;
    try {
      result = await deps.bootstrapQualification({
        package: plan.package,
        m6Root: runtimeRoot,
        dbPath: plan.paths.controlDbPath,
        issuerAllowlistPath: absolutePath(input.issuerAllowlistPath, "gate issuer allowlist"),
        snapshotDatabase: deps.snapshotDatabase,
        snapshotDirectory: plan.snapshotRoot,
        snapshotLabel: plan.snapshotLabel,
        activeRunCount: () => 0,
        now: () => Number(input.nowMs ?? Date.now()),
      });
      bootstrapCleanupProven = true;
    } catch (error) {
      bootstrapCleanupProven = isM6QualificationCleanupVerifiedError(error);
      throw error;
    }
    publicationFaultAfter("bootstrap");
    guard.assertOwned();
    assertSentinelsUnavailable(plan.paths);
    const postPlan = planM64QualificationBootstrap(input, deps);
    if (postPlan.packageHash !== plan.packageHash
      || postPlan.releaseManifestSha256 !== plan.releaseManifestSha256
      || postPlan.implementationClosureHash !== plan.implementationClosureHash
      || postPlan.bindingSha256 !== plan.bindingSha256) {
      operatorError(
        "M64_QUALIFICATION_OPERATOR_CONCURRENT_CHANGE",
        "release/package/runtime binding changed during qualification bootstrap",
      );
    }
    ensureControlledDirectory(runtimeRoot, dirname(BINDING_RELATIVE_PATH));
    const bindingPublication = writeExactCreateOnly(
      plan.paths.bindingPath,
      jsonBytes(plan.binding),
      {
        controlledRoot: runtimeRoot,
        driftCode: "M64_QUALIFICATION_OPERATOR_BINDING_DRIFT",
        faultAfter: (point, context) => publicationFaultAfter(`binding:${point}`, context),
      },
    );
    publicationFaultAfter("binding");
    guard.assertOwned();
    assertSentinelsUnavailable(plan.paths);
    const receipt = deriveOperatorReceipt({
      plan,
      result,
      bindingSha256: bindingPublication.sha256,
    });
    const receiptRoot = ensureControlledDirectory(runtimeRoot, RECEIPT_DIRECTORY);
    const receiptPath = join(receiptRoot, `${receipt.receiptHash}.json`);
    const receiptPublication = writeExactCreateOnly(
      receiptPath,
      jsonBytes(receipt),
      {
        controlledRoot: runtimeRoot,
        driftCode: "M64_QUALIFICATION_OPERATOR_ARTIFACT_DRIFT",
        faultAfter: (point, context) => publicationFaultAfter(`receipt:${point}`, context),
      },
    );
    publicationFaultAfter("receipt");
    guard.assertOwned();
    assertSentinelsUnavailable(plan.paths);
    const status = receiptPublication.replay
      ? "EXACT_REPLAY"
      : bindingPublication.replay
        ? "RECOVERED_RECEIPT"
        : plan.databaseVersion === CURRENT_CONTROL_SCHEMA_VERSION
          ? "RECOVERED_AFTER_BOOTSTRAP"
          : "BOOTSTRAPPED";
    return Object.freeze({
      ok: true,
      schemaId: "xw.m6-c1-qualification-bootstrap-operator-result.v1",
      executed: true,
      status,
      releaseId: plan.releaseId,
      sourceCommit: plan.sourceCommit,
      gateId: plan.gateId,
      receiptPath,
      receipt,
      bindingPath: plan.paths.bindingPath,
      snapshotPath: result.dbSnapshotReceipt.snapshotPath,
      privateKeyAccessed: false,
      providerAccessed: false,
      deviceAccessed: false,
      networkAccessed: false,
    });
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (guard) {
      try {
        if (bootstrapCleanupProven) await guard.release();
        else await guard.retainStaleLock();
      } catch (releaseError) {
        if (!primaryError) throw releaseError;
      }
    }
  }
}

// Pure, secret-free preparation for an external signing service.  The signing
// payload is the exact 32-byte epoch hash (hex-decoded), matching verifyEpochProof.
export function buildM64QualificationBootstrapSigningDraft(input = {}) {
  exactObject(
    input,
    DRAFT_INPUT_KEYS,
    "M64_QUALIFICATION_DRAFT_INVALID",
    "qualification signing draft input",
  );
  assertNoSecretMaterial(input, "qualification signing draft input");
  exactObject(input.locksRecord, ["lockHashes", "releaseId", "schemaId", "sourceCommit"],
    "M64_QUALIFICATION_DRAFT_INVALID", "locksRecord");
  exactObject(input.locksRecord.lockHashes, LOCK_KEYS,
    "M64_QUALIFICATION_DRAFT_INVALID", "locksRecord.lockHashes");
  if (!OPAQUE_ID.test(input.releaseId ?? "") || !COMMIT.test(input.sourceCommit ?? "")
    || !OPAQUE_ID.test(input.gateId ?? "") || !HASH.test(input.issuerAllowlistSha256 ?? "")
    || input.locksRecord.schemaId !== "xw.m6-locks.v1"
    || input.locksRecord.releaseId !== input.releaseId
    || input.locksRecord.sourceCommit !== input.sourceCommit
    || LOCK_KEYS.some((key) => !HASH.test(input.locksRecord.lockHashes[key] ?? ""))
    || typeof input.actor !== "string" || input.actor.length < 1 || input.actor.length > 200) {
    operatorError("M64_QUALIFICATION_DRAFT_INVALID", "draft authority identity/locks are invalid");
  }
  const times = [
    input.rootIssuedAt,
    input.closeoutCommittedAt,
    input.closedIssuedAt,
    input.promotedAt,
    input.expiresAt,
  ].map((value) => Date.parse(value));
  if (!times.every(Number.isFinite)
    || times[0] > times[1] || times[1] > times[2] || times[2] > times[3]
    || times[4] <= times[3]) {
    operatorError("M64_QUALIFICATION_DRAFT_INVALID", "draft chronology or expiry is invalid");
  }
  const rootRaw = {
    schemaId: "xw.m6-live-gate.v1",
    gateId: input.gateId,
    mode: "OBSERVE_ONLY",
    status: "active",
    releaseId: input.releaseId,
    sourceCommit: input.sourceCommit,
    actor: input.actor,
    lockHashes: { ...input.locksRecord.lockHashes },
    allowlist: ["01"],
    issuedAt: input.rootIssuedAt,
    expiresAt: input.expiresAt,
    parentEpochHash: null,
    closeoutRef: null,
    aggregateSealRef: null,
    rollbackTargetEpochHash: null,
  };
  const rootEpoch = Object.freeze({ ...rootRaw, epochHash: deriveM6EpochHash(rootRaw) });
  const scenarioRaw = {
    schemaId: M6_QUALIFICATION_BOOTSTRAP_SCENARIO_SCHEMA_ID,
    epochHash: rootEpoch.epochHash,
    allowlist: ["01"],
    attemptCount: 0,
    scenarios: [],
  };
  const scenarioManifest = Object.freeze({
    ...scenarioRaw,
    manifestSha256: deriveM6QualificationBootstrapScenarioManifestHash(scenarioRaw),
  });
  const zeroPoint = Object.freeze({
    activeActions: 0,
    activeJobs: 0,
    activeLeases: 0,
    activeRuns: 0,
    activeSessions: 0,
  });
  const resourceRaw = {
    schemaId: "xw.m6-resource-snapshot.v1",
    epochHash: rootEpoch.epochHash,
    before: { ...zeroPoint },
    after: { ...zeroPoint },
    actionCount: 0,
  };
  const resourceSnapshot = Object.freeze({
    ...resourceRaw,
    snapshotSha256: deriveM6ResourceSnapshotSha256(resourceRaw),
  });
  const sealPayload = Object.freeze({
    epochHash: rootEpoch.epochHash,
    allowlist: ["01"],
    scenarioManifestSha256: scenarioManifest.manifestSha256,
    resourceSnapshotSha256: resourceSnapshot.snapshotSha256,
    attempts: [],
  });
  const sealHash = deriveM6AggregateSealHash(sealPayload);
  const aggregate = Object.freeze({
    schemaId: "xw.m6-aggregate-closeout.v1",
    epochHash: rootEpoch.epochHash,
    sealPayload,
    sealHash,
    attemptCount: 0,
    aliases: ["01"],
  });
  const closeoutRaw = {
    closeoutId: `qualification-bootstrap-${rootEpoch.epochHash.slice(0, 20)}`,
    epochHash: rootEpoch.epochHash,
    actor: input.actor,
    reason: "seal never-activated qualification bootstrap root",
    committedAt: input.closeoutCommittedAt,
  };
  const closeout = Object.freeze({ ...closeoutRaw, closeoutHash: deriveM6CloseoutHash(closeoutRaw) });
  const closedRaw = {
    ...rootRaw,
    mode: "CLOSED",
    status: "closed",
    issuedAt: input.closedIssuedAt,
    parentEpochHash: rootEpoch.epochHash,
    closeoutRef: { id: closeout.closeoutId, sha256: closeout.closeoutHash },
    aggregateSealRef: { id: sealHash, sha256: sealHash },
  };
  const closedEpoch = Object.freeze({ ...closedRaw, epochHash: deriveM6EpochHash(closedRaw) });
  const signingRequests = Object.freeze([
    Object.freeze({
      role: "ROOT",
      algorithm: "ed25519",
      subject: input.actor,
      epochHash: rootEpoch.epochHash,
      payloadEncoding: "raw-32-byte-epoch-hash",
      payloadHex: rootEpoch.epochHash,
    }),
    Object.freeze({
      role: "CLOSED",
      algorithm: "ed25519",
      subject: input.actor,
      epochHash: closedEpoch.epochHash,
      payloadEncoding: "raw-32-byte-epoch-hash",
      payloadHex: closedEpoch.epochHash,
    }),
  ]);
  const body = {
    schemaId: M64_QUALIFICATION_SIGNING_DRAFT_SCHEMA_ID,
    gateId: input.gateId,
    releaseId: input.releaseId,
    sourceCommit: input.sourceCommit,
    issuerAllowlistSha256: input.issuerAllowlistSha256,
    locksRecord: input.locksRecord,
    rootEpoch,
    closedEpoch,
    closeout,
    aggregate,
    scenarioManifest,
    resourceSnapshot,
    promotedAt: input.promotedAt,
    signingRequests,
  };
  return Object.freeze({
    ...body,
    draftHash: sha256(`${M64_QUALIFICATION_SIGNING_DRAFT_SCHEMA_ID}:${canonicalJson(body)}`),
  });
}

export function validateM64QualificationBootstrapSigningDraft(draft) {
  exactObject(draft, DRAFT_KEYS, "M64_QUALIFICATION_DRAFT_INVALID", "qualification signing draft");
  assertNoSecretMaterial(draft, "qualification signing draft");
  const expectedDraftHash = sha256(
    `${M64_QUALIFICATION_SIGNING_DRAFT_SCHEMA_ID}:${canonicalJson(without(draft, "draftHash"))}`,
  );
  const requests = draft?.signingRequests;
  const expected = [
    { role: "ROOT", epoch: draft?.rootEpoch },
    { role: "CLOSED", epoch: draft?.closedEpoch },
  ];
  if (draft.schemaId !== M64_QUALIFICATION_SIGNING_DRAFT_SCHEMA_ID
    || draft.draftHash !== expectedDraftHash
    || !Array.isArray(requests) || requests.length !== 2
    || expected.some(({ role, epoch }, index) => {
      const request = requests[index];
      return !request || canonicalJson(Object.keys(request).sort()) !== canonicalJson([
        "algorithm", "epochHash", "payloadEncoding", "payloadHex", "role", "subject",
      ].sort())
        || request.role !== role || request.algorithm !== "ed25519"
        || request.subject !== epoch?.actor || request.epochHash !== epoch?.epochHash
        || request.payloadEncoding !== "raw-32-byte-epoch-hash"
        || request.payloadHex !== epoch?.epochHash || !HASH.test(request.payloadHex ?? "");
    })) {
    operatorError(
      "M64_QUALIFICATION_DRAFT_INVALID",
      "qualification signing draft hash or canonical signing requests are invalid",
    );
  }
  return draft;
}

export function assembleM64QualificationBootstrapPackage({
  draft,
  rootProof,
  closedProof,
  issuerAllowlistPath,
  runtimeRoot,
  nowMs = Date.now(),
} = {}, dependencies = {}) {
  const deps = Object.freeze({ ...DEFAULT_DEPENDENCIES, ...dependencies });
  validateM64QualificationBootstrapSigningDraft(draft);
  exactObject(rootProof, PROOF_KEYS, "M64_QUALIFICATION_PROOF_INVALID", "root proof");
  exactObject(closedProof, PROOF_KEYS, "M64_QUALIFICATION_PROOF_INVALID", "CLOSED proof");
  assertNoSecretMaterial({ rootProof, closedProof }, "external epoch proofs");
  const raw = {
    schemaId: M6_QUALIFICATION_BOOTSTRAP_PACKAGE_SCHEMA_ID,
    gateId: draft.gateId,
    releaseId: draft.releaseId,
    sourceCommit: draft.sourceCommit,
    locksRecord: draft.locksRecord,
    issuerAllowlistSha256: draft.issuerAllowlistSha256,
    rootEpochRecord: { ...draft.rootEpoch, proof: rootProof },
    closedEpochRecord: { ...draft.closedEpoch, proof: closedProof },
    closeout: draft.closeout,
    aggregate: draft.aggregate,
    scenarioManifest: draft.scenarioManifest,
    resourceSnapshot: draft.resourceSnapshot,
    promotedAt: draft.promotedAt,
  };
  const packageRecord = Object.freeze({
    ...raw,
    packageHash: deriveM6QualificationBootstrapPackageHash(raw),
  });
  const resolvedRuntimeRoot = absolutePath(runtimeRoot, "runtime root");
  const resolvedIssuerPath = absolutePath(issuerAllowlistPath, "gate issuer allowlist");
  if (!within(resolvedRuntimeRoot, resolvedIssuerPath)) {
    operatorError(
      "M64_QUALIFICATION_OPERATOR_ISSUER_REBOUND",
      "gate issuer allowlist must be rooted in the exact runtime",
    );
  }
  const issuerFile = readPlainJson(resolvedIssuerPath, "gate issuer allowlist", {
    controlledRoot: resolvedRuntimeRoot,
  });
  assertNoSecretMaterial(issuerFile.value, "gate issuer allowlist");
  deps.validatePackage({
    package: packageRecord,
    issuerAllowlistPath: resolvedIssuerPath,
    m6Root: resolvedRuntimeRoot,
    nowMs,
  });
  return packageRecord;
}

export function parseM64QualificationOperatorArgs(argv) {
  const out = { execute: false };
  const names = new Map([
    ["--bootstrap-package", "bootstrapPackagePath"],
    ["--issuer-allowlist", "issuerAllowlistPath"],
    ["--release-root", "releaseRoot"],
    ["--runtime-root", "runtimeRoot"],
    ["--snapshot-root", "snapshotRoot"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--execute") {
      if (out.execute) {
        operatorError("M64_QUALIFICATION_OPERATOR_ARGUMENT_INVALID", "--execute may appear only once");
      }
      out.execute = true;
      continue;
    }
    const key = names.get(arg);
    if (!key || out[key] !== undefined || index + 1 >= argv.length) {
      operatorError(
        "M64_QUALIFICATION_OPERATOR_ARGUMENT_INVALID",
        `unknown, duplicate, or incomplete argument: ${arg}`,
      );
    }
    out[key] = argv[++index];
  }
  if ([...names.values()].some((key) => out[key] === undefined)) {
    operatorError(
      "M64_QUALIFICATION_OPERATOR_ARGUMENT_INVALID",
      "all five explicit path arguments are required",
    );
  }
  return Object.freeze(out);
}

export async function main(argv = process.argv.slice(2), {
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  try {
    const parsed = parseM64QualificationOperatorArgs(argv);
    const { execute, ...input } = parsed;
    const result = await operateM64QualificationBootstrap(input, { execute });
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    stderr.write(`${JSON.stringify({
      ok: false,
      code: error?.code ?? "M64_QUALIFICATION_OPERATOR_FAILED",
      message: error?.message ?? String(error),
    })}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
