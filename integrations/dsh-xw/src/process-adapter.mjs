import { mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DeepSeekHarness, HarnessClient } from "@deepseek-ai/dsh-sdk-client";

import { ADAPTER_KIND } from "./constants.mjs";
import { ReplayJournal } from "./replay-journal.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const integrationRoot = resolve(here, "..");

export function computeProfileHash() {
  const hash = createHash("sha256");
  for (const file of ["profiles/replay/package.json", "profiles/replay/cordis.patch.yml", "src/runtime-plugin.mjs"]) {
    hash.update(file).update("\0").update(readFileSync(join(integrationRoot, file)));
  }
  return hash.digest("hex");
}

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function safeBaseEnv(source = process.env) {
  const allowed = ["PATH", "Path", "SystemRoot", "WINDIR", "PATHEXT", "ComSpec", "TEMP", "TMP", "LANG", "LC_ALL", "TZ", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"];
  return Object.fromEntries(allowed.filter((key) => typeof source[key] === "string").map((key) => [key, source[key]]));
}

export function computeLaunchHashLedger() {
  const files = {
    lockfile: "package-lock.json",
    cordisConfig: "replay.cordis.yml",
    childProtocolPlugin: "src/xw-protocol-server.mjs",
    modelProfile: "src/deterministic-llm.mjs",
    toolSurface: "../../services/orchestrator/scripts/lib/m6/m6-tool-surface.mjs",
    scenarioOracle: "config/scenario-oracle.v1.json",
    policy: "config/hard-redline-policy.v1.json",
    dshPackage: "node_modules/@deepseek-ai/dsh/package.json",
    dshSource: "node_modules/@deepseek-ai/dsh/lib/bin.js",
  };
  return Object.freeze(Object.fromEntries(Object.entries(files).map(([name, file]) => [name, sha256File(resolve(integrationRoot, file))])));
}

export function replayLaunchSpec(options = {}) {
  const persistenceRoot = resolve(options.persistenceRoot ?? join(integrationRoot, ".runtime", "sessions"));
  const replayRoot = resolve(options.replayRoot ?? join(integrationRoot, ".runtime", "replay"));
  const profileHash = computeProfileHash();
  mkdirSync(persistenceRoot, { recursive: true });
  mkdirSync(replayRoot, { recursive: true });
  if (options.closeReceiptPath) mkdirSync(dirname(resolve(options.closeReceiptPath)), { recursive: true });
  if (options.sessionMode === "resume") {
    if (!options.priorCloseReceiptPath) {
      const error = new Error("resume requires priorCloseReceiptPath");
      error.code = "M6_DSH_PROCESS_CLOSE_UNPROVEN";
      throw error;
    }
    if (!/^[0-9a-f]{64}$/u.test(options.priorCloseReceiptSha256 ?? "")) {
      const error = new Error("resume requires a recorded priorCloseReceiptSha256");
      error.code = "M6_DSH_PROCESS_CLOSE_UNPROVEN";
      throw error;
    }
    let prior;
    try {
      if (sha256File(resolve(options.priorCloseReceiptPath)) !== options.priorCloseReceiptSha256) {
        const error = new Error("resume prior process-close receipt hash mismatch");
        error.code = "M6_DSH_PROCESS_CLOSE_UNPROVEN";
        throw error;
      }
      prior = JSON.parse(readFileSync(resolve(options.priorCloseReceiptPath), "utf8"));
    } catch (cause) {
      if (cause?.code === "M6_DSH_PROCESS_CLOSE_UNPROVEN") throw cause;
      const error = new Error("resume prior process-close receipt is missing or malformed", { cause });
      error.code = "M6_DSH_PROCESS_CLOSE_UNPROVEN";
      throw error;
    }
    if (prior.schemaId !== "xw.dsh.process-close-receipt.v1" || prior.verifiedClosed !== true || typeof prior.spawnNonce !== "string" || !Number.isSafeInteger(prior.pid) || prior.pid <= 0) {
      const error = new Error("resume prior process-close receipt is invalid");
      error.code = "M6_DSH_PROCESS_CLOSE_UNPROVEN";
      throw error;
    }
    try {
      process.kill(prior.pid, 0);
      const error = new Error("resume refused because the prior process is still alive");
      error.code = "M6_DSH_PROCESS_CLOSE_UNPROVEN";
      throw error;
    } catch (cause) {
      if (cause?.code === "M6_DSH_PROCESS_CLOSE_UNPROVEN") throw cause;
      if (cause?.code !== "ESRCH") {
        const error = new Error("resume could not prove the prior process is closed", { cause });
        error.code = "M6_DSH_PROCESS_CLOSE_UNPROVEN";
        throw error;
      }
    }
    const checkpoint = new ReplayJournal(replayRoot, options.workerRunRef ?? "worker-run-0001").loadCheckpoint();
    if (checkpoint.state?.profileHash !== profileHash) {
      const error = new Error("resume profile hash drifted from checkpoint");
      error.code = "M6_DSH_PROFILE_DRIFT";
      throw error;
    }
  }
  const childArgs = [join(integrationRoot, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"), "--profile", "replay"];
  return Object.freeze({
    command: process.execPath,
    args: [join(here, "supervisor-cli.mjs")],
    cwd: integrationRoot,
    env: {
      ...safeBaseEnv(),
      DSH_HOME: integrationRoot,
      DSH_TELEMETRY_DISABLED: "1",
      XW_DSH_CHILD_COMMAND: process.execPath,
      XW_DSH_CHILD_ARGS_JSON: JSON.stringify(childArgs),
      XW_DSH_CHILD_CWD: integrationRoot,
      XW_DSH_PERSISTENCE_ROOT: persistenceRoot,
      XW_DSH_REPLAY_ROOT: replayRoot,
      XW_DSH_SESSION_MODE: options.sessionMode === "resume" ? "resume" : "create",
      XW_DSH_PROFILE_HASH: profileHash,
      XW_DSH_ADAPTER_KIND: ADAPTER_KIND,
      XW_DSH_EXECUTION_MODE: "replay",
      XW_DSH_HASH_LEDGER_JSON: JSON.stringify(computeLaunchHashLedger()),
      ...(options.failpoint ? { XW_DSH_FAILPOINT: options.failpoint } : {}),
      ...(options.closeReceiptPath ? { XW_DSH_CLOSE_RECEIPT_PATH: resolve(options.closeReceiptPath) } : {}),
    },
    requestTimeoutMs: options.requestTimeoutMs ?? 70_000,
    shutdownTimeoutMs: options.shutdownTimeoutMs ?? 10_000,
    disposeEofGraceMs: 7_000,
    disposeGraceMs: 5_000,
  });
}

export class DshXwProcessAdapter {
  constructor(options = {}) {
    this.adapterKind = ADAPTER_KIND;
    this.traceMarker = "xw.dsh.real-out-of-process.v1";
    this.launch = replayLaunchSpec(options);
  }

  createClient() {
    return new HarnessClient(this.launch);
  }

  createHarness(options = {}) {
    return new DeepSeekHarness({
      launch: this.launch,
      cwd: options.cwd ?? integrationRoot,
      provider: "xw-replay",
      model: "xw-replay-v1",
      maxTokens: options.maxTokens ?? 4096,
    });
  }
}
