import {
  appendFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";

import { canonicalJson } from "./canonical.mjs";
import { ControlPlaneError } from "./errors.mjs";

const SENSITIVE_KEYS = /(?:serial|runtime.?id|token|secret|password|authorization|cookie|api.?key)/i;

export function redactRuntimeData(value) {
  if (Array.isArray(value)) return value.map(redactRuntimeData);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !SENSITIVE_KEYS.test(key))
        .map(([key, child]) => [key, redactRuntimeData(child)]),
    );
  }
  return value;
}

function atomicWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

async function fileHash(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export class EvidenceStore {
  constructor({
    runsRoot,
    state,
    minFreeBytes = 128 * 1024 * 1024,
    minExternalEffectFreeBytes = 1024 * 1024 * 1024,
  }) {
    this.runsRoot = resolve(runsRoot);
    this.state = state;
    this.minFreeBytes = minFreeBytes;
    this.minExternalEffectFreeBytes = minExternalEffectFreeBytes;
    mkdirSync(this.runsRoot, { recursive: true });
  }

  freeBytes() {
    const info = statfsSync(this.runsRoot);
    return Number(info.bavail) * Number(info.bsize);
  }

  assertCapacity({ externalEffect = false } = {}) {
    const freeBytes = this.freeBytes();
    const required = externalEffect ? this.minExternalEffectFreeBytes : this.minFreeBytes;
    if (freeBytes < required) {
      throw new ControlPlaneError("EVIDENCE_DISK_LOW", "not enough free space for a new run", {
        status: 507,
        details: { freeBytes, requiredBytes: required, externalEffect },
      });
    }
    return freeBytes;
  }

  runDirectory(runId) {
    return join(this.runsRoot, runId);
  }

  storageForRun(runId) {
    const runDirectory = this.runDirectory(runId);
    return {
      runDirectory,
      manifestPath: join(runDirectory, "manifest.json"),
      eventsPath: join(runDirectory, "events.jsonl"),
      evidenceDirectory: join(runDirectory, "evidence"),
    };
  }

  getManifest(runId) {
    const path = join(this.runDirectory(runId), "manifest.json");
    if (!existsSync(path)) {
      throw new ControlPlaneError("RUN_NOT_FOUND", `unknown run ${runId}`, { status: 404 });
    }
    return JSON.parse(readFileSync(path, "utf8"));
  }

  findByIdAndHash(evidenceId, sha256) {
    const record = this.state.getEvidenceRecordInternal?.(evidenceId) || this.state.getEvidenceRecord(evidenceId);
    if (!record) throw new ControlPlaneError("EVIDENCE_NOT_FOUND", "evidence record is absent", { status: 404 });
    if (record.sha256 !== sha256) throw new ControlPlaneError("EVIDENCE_HASH_MISMATCH", "evidence hash does not match", { status: 409 });
    if (typeof record.path !== "string" || record.path === "" || record.path.includes("\\")) {
      throw new ControlPlaneError("EVIDENCE_PATH_INVALID", "evidence path is not a permitted relative path", { status: 409 });
    }
    const absolutePath = resolve(this.runDirectory(record.runId), record.path);
    const allowedRoot = `${this.runDirectory(record.runId)}${process.platform === "win32" ? "\\" : "/"}`;
    if (!absolutePath.startsWith(allowedRoot)) {
      throw new ControlPlaneError("EVIDENCE_PATH_INVALID", "evidence path escapes its run directory", { status: 409 });
    }
    if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
      throw new ControlPlaneError("EVIDENCE_FILE_MISSING", "evidence file is absent", { status: 409 });
    }
    const actualHash = createHash("sha256").update(readFileSync(absolutePath)).digest("hex");
    if (actualHash !== record.sha256) {
      throw new ControlPlaneError("EVIDENCE_HASH_MISMATCH", "evidence file no longer matches its durable hash", { status: 409 });
    }
    // Path is private storage metadata; callers receive an allowlisted evidence descriptor.
    return { evidenceId: record.evidenceId, jobId: record.jobId, runId: record.runId, kind: record.kind, sha256: record.sha256, bytes: record.bytes };
  }

  initializeRun({ job, device, gitCommit = process.env.CONTROL_PLANE_GIT_COMMIT || "unknown" }) {
    this.assertCapacity({ externalEffect: job.externalEffect });
    const directory = this.runDirectory(job.runId);
    mkdirSync(join(directory, "evidence"), { recursive: true });
    const storage = this.storageForRun(job.runId);
    const manifest = {
      schemaVersion: 2,
      runId: job.runId,
      jobId: job.jobId,
      actorId: job.actorId,
      nodeId: device.nodeId,
      deviceId: device.deviceId,
      deviceAlias: device.alias,
      capabilityId: job.capabilityId,
      capabilityMaturity: job.capability.maturity,
      capabilityRisk: job.capability.risk,
      gitCommit,
      createdAt: job.createdAt,
      routeDecision: job.routeDecision,
      storage,
      evidence: [],
    };
    atomicWriteJson(join(directory, "manifest.json"), redactRuntimeData(manifest));
    this.appendEvent(job.runId, {
      type: "route.assigned",
      jobId: job.jobId,
      routeDecision: job.routeDecision,
      createdAt: new Date().toISOString(),
    });
    this.appendEvent(job.runId, {
      type: "run.initialized",
      jobId: job.jobId,
      deviceId: device.deviceId,
      capabilityId: job.capabilityId,
      createdAt: new Date().toISOString(),
    });
    return { directory, manifest };
  }

  appendEvent(runId, event) {
    const directory = this.runDirectory(runId);
    mkdirSync(directory, { recursive: true });
    appendFileSync(
      join(directory, "events.jsonl"),
      `${canonicalJson(redactRuntimeData(event))}\n`,
      { mode: 0o600 },
    );
  }

  async attachFile({ job, sourcePath, kind, label }) {
    if (!existsSync(sourcePath)) {
      throw new ControlPlaneError("EVIDENCE_FILE_MISSING", "adapter evidence file is missing", {
        status: 500,
        details: { kind, label },
      });
    }
    const stats = statSync(sourcePath);
    if (!stats.isFile() || stats.size === 0) {
      throw new ControlPlaneError("EVIDENCE_FILE_INVALID", "adapter evidence file is empty or not a file", {
        status: 500,
        details: { kind, label },
      });
    }
    const hash = await fileHash(sourcePath);
    const safeLabel = String(label || basename(sourcePath)).replace(/[^A-Za-z0-9._-]+/g, "_");
    const relativePath = join("evidence", `${safeLabel}-${hash.slice(0, 12)}${basename(sourcePath).includes(".") ? `.${basename(sourcePath).split(".").pop()}` : ""}`);
    const targetPath = join(this.runDirectory(job.runId), relativePath);
    writeFileSync(targetPath, readFileSync(sourcePath), { mode: 0o600 });
    const record = this.state.recordEvidence({
      jobId: job.jobId,
      runId: job.runId,
      kind,
      path: relativePath,
      sha256: hash,
      bytes: stats.size,
    });
    this.#refreshManifest(job.runId);
    return record;
  }

  writeJson({ job, kind, label, value }) {
    const safeLabel = String(label).replace(/[^A-Za-z0-9._-]+/g, "_");
    const sanitized = redactRuntimeData(value);
    const content = `${canonicalJson(sanitized)}\n`;
    const hash = createHash("sha256").update(content).digest("hex");
    const relativePath = join("evidence", `${safeLabel}-${hash.slice(0, 12)}.json`);
    const targetPath = join(this.runDirectory(job.runId), relativePath);
    writeFileSync(targetPath, content, { mode: 0o600 });
    const record = this.state.recordEvidence({
      jobId: job.jobId,
      runId: job.runId,
      kind,
      path: relativePath,
      sha256: hash,
      bytes: Buffer.byteLength(content),
    });
    this.#refreshManifest(job.runId);
    return record;
  }

  // Discovery has no generic Capability job: its immutable reservation is the only
  // source-job authority. Keep its evidence in the private run tree and never return a path.
  writeDiscoveryJson({ discoveryRunId, sourceJobId, kind, label, value }) {
    if (typeof discoveryRunId !== "string" || typeof sourceJobId !== "string") {
      throw new ControlPlaneError("DISCOVERY_EVIDENCE_INPUT_INVALID", "Discovery evidence requires its run and reservation", { status: 400 });
    }
    const safeLabel = String(label).replace(/[^A-Za-z0-9._-]+/g, "_");
    const content = `${canonicalJson(redactRuntimeData(value))}\n`;
    const hash = createHash("sha256").update(content).digest("hex");
    const relativePath = join("evidence", `${safeLabel}-${hash.slice(0, 12)}.json`);
    const directory = this.runDirectory(discoveryRunId);
    mkdirSync(join(directory, "evidence"), { recursive: true });
    writeFileSync(join(directory, relativePath), content, { mode: 0o600 });
    const record = this.state.recordEvidence({
      jobId: null,
      runId: discoveryRunId,
      kind,
      path: relativePath,
      sha256: hash,
      bytes: Buffer.byteLength(content),
    });
    return this.findByIdAndHash(record.evidenceId, record.sha256);
  }

  #refreshManifest(runId) {
    const path = join(this.runDirectory(runId), "manifest.json");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    manifest.evidence = this.state.listEvidence(runId);
    atomicWriteJson(path, manifest);
  }
}
