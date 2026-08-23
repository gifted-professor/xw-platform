import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

import {
  computeInstalledLiveAdapterIntegrity,
  loadContentAddressedLiveModelQualificationBundle,
  validateQualifiedLiveModelProfile,
} from "./live-model-profile.mjs";
import { M6LiveParentBroker } from "./live-parent-broker.mjs";
import { validateM6LivePipeBinding } from "./live-pipe-client.mjs";
import { verifyM6LiveRuntimeDependencyLayer } from "./live-runtime-dependency-layer.mjs";
import { spawnOwnedProcess, terminateOwnedProcessTree } from "./stdio-supervisor.mjs";

export const M6_LIVE_BROKER_FD = 3;
const HASH = /^[0-9a-f]{64}$/u;
const EXECUTION_CLASSES = Object.freeze(new Set(["PRODUCTION", "TEST_FIXTURE"]));
const SAFE_ENV_KEYS = Object.freeze([
  "PATH", "Path", "SystemRoot", "WINDIR", "PATHEXT", "ComSpec",
  "LANG", "LC_ALL", "TZ",
]);
const RUNTIME_ENV_KEYS = Object.freeze([
  "XW_M6_LIVE_PROVIDER_BASE_URL",
  "XW_M6_LIVE_MODEL_PROFILE_HASH",
  "XW_M6_LIVE_MODEL_PROFILE_ROOT",
  "XW_DSH_PERSISTENCE_ROOT",
]);
const DEPENDENCY_ENV_KEYS = Object.freeze([
  "XW_M6_LIVE_DEPENDENCY_ROOT",
  "XW_M6_LIVE_DEPENDENCY_LAYER_HASH",
]);
const CREDENTIAL_ENV_KEYS = Object.freeze(["DEEPSEEK_API_KEY"]);
const FORBIDDEN_ARG = /(?:^|[\s/\\-])(?:token|secret|password|credential|lease|adb|serial|raw-device)(?:$|[\s=:])/iu;
const activeRuns = new Map();
const integrationRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceReleaseRoot = resolve(integrationRoot, "../..");

function launchError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function pathWithin(root, target) {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function sealedM6LiveChildSpec(dependencyLayer, runtimeEnv) {
  if (dependencyLayer?.ok !== true || !isAbsolute(dependencyLayer.dshCli ?? "")
    || !isAbsolute(dependencyLayer.integrationRoot ?? "") || !isAbsolute(dependencyLayer.liveNetworkGuard ?? "")) {
    throw launchError("M6_LIVE_DEPENDENCY_LAYER_UNVERIFIED", "production child spec requires a verified runtime dependency layer");
  }
  const exactRuntimeEnv = validateM6LiveRuntimeEnvironment(runtimeEnv, { required: true });
  const readRoots = [
    dependencyLayer.layerRoot,
    exactRuntimeEnv.XW_M6_LIVE_MODEL_PROFILE_ROOT,
    exactRuntimeEnv.XW_DSH_PERSISTENCE_ROOT,
  ].map((value) => resolve(value));
  return Object.freeze({
    command: process.execPath,
    args: Object.freeze([
      "--permission",
      ...readRoots.map((value) => `--allow-fs-read=${value}`),
      `--allow-fs-write=${resolve(exactRuntimeEnv.XW_DSH_PERSISTENCE_ROOT)}`,
      "--import",
      pathToFileURL(dependencyLayer.liveNetworkGuard).href,
      dependencyLayer.dshCli,
      "--profile",
      "live",
    ]),
    cwd: dependencyLayer.integrationRoot,
  });
}

export function validateM6LiveLaunchQualification(executionClass, qualification, {
  runtimeEndpoint = null,
  installed,
  requiredRuntimeAttestationHash = null,
} = {}) {
  if (!EXECUTION_CLASSES.has(executionClass)) {
    throw launchError("M6_LIVE_EXECUTION_CLASS_INVALID", "live execution class must be PRODUCTION or TEST_FIXTURE");
  }
  if (executionClass === "TEST_FIXTURE") {
    if (qualification !== undefined) {
      throw launchError("M6_LIVE_TEST_QUALIFICATION_FORBIDDEN", "a test fixture must not claim production profile qualification");
    }
    return Object.freeze({ executionClass, qualificationStatus: "NOT_EVALUATED_TEST_FIXTURE", modelProfileHash: null });
  }
  const validation = validateQualifiedLiveModelProfile(qualification, {
    installed: installed ?? computeInstalledLiveAdapterIntegrity(),
    runtimeEndpoint,
    expectedContentHash: qualification?.contentHash ?? null,
    requiredRuntimeAttestationHash,
  });
  if (!validation.ok) {
    throw launchError("M6_LIVE_PROFILE_UNQUALIFIED", "production inherited-pipe launch requires qualified Gate-F-eligible profile evidence");
  }
  return Object.freeze({ executionClass, qualificationStatus: "QUALIFIED", modelProfileHash: qualification.contentHash });
}

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

export function validateM6LiveRuntimeEnvironment(runtimeEnv, { required = false } = {}) {
  if (runtimeEnv === undefined && !required) return Object.freeze({});
  if (!required && exactKeys(runtimeEnv, [])) return Object.freeze({});
  if (!exactKeys(runtimeEnv, RUNTIME_ENV_KEYS)) {
    throw launchError("M6_LIVE_RUNTIME_ENV_INVALID", "live runtime environment must contain exactly the four sealed runtime fields");
  }
  let providerUrl;
  try { providerUrl = new URL(runtimeEnv.XW_M6_LIVE_PROVIDER_BASE_URL); } catch {
    throw launchError("M6_LIVE_PROVIDER_URL_INVALID", "live provider base URL is invalid");
  }
  if (providerUrl.protocol !== "https:" || providerUrl.username || providerUrl.password || providerUrl.search || providerUrl.hash
    || runtimeEnv.XW_M6_LIVE_PROVIDER_BASE_URL.length > 2_048) {
    throw launchError("M6_LIVE_PROVIDER_URL_INVALID", "live provider base URL must be credential-free HTTPS without query or fragment");
  }
  if (!HASH.test(runtimeEnv.XW_M6_LIVE_MODEL_PROFILE_HASH)) {
    throw launchError("M6_LIVE_MODEL_PROFILE_HASH_INVALID", "live model profile hash must be SHA-256");
  }
  if (typeof runtimeEnv.XW_M6_LIVE_MODEL_PROFILE_ROOT !== "string" || !isAbsolute(runtimeEnv.XW_M6_LIVE_MODEL_PROFILE_ROOT)) {
    throw launchError("M6_LIVE_MODEL_PROFILE_ROOT_INVALID", "live model qualification root must be absolute");
  }
  if (typeof runtimeEnv.XW_DSH_PERSISTENCE_ROOT !== "string" || !isAbsolute(runtimeEnv.XW_DSH_PERSISTENCE_ROOT)) {
    throw launchError("M6_LIVE_PERSISTENCE_ROOT_INVALID", "live DSH persistence root must be absolute");
  }
  return Object.freeze({ ...runtimeEnv });
}

export function validateM6LiveDependencyEnvironment(dependencyEnv, { required = false } = {}) {
  if (dependencyEnv === undefined && !required) return Object.freeze({});
  if (!required && exactKeys(dependencyEnv, [])) return Object.freeze({});
  if (!exactKeys(dependencyEnv, DEPENDENCY_ENV_KEYS)
    || typeof dependencyEnv.XW_M6_LIVE_DEPENDENCY_ROOT !== "string"
    || !isAbsolute(dependencyEnv.XW_M6_LIVE_DEPENDENCY_ROOT)
    || !HASH.test(dependencyEnv.XW_M6_LIVE_DEPENDENCY_LAYER_HASH ?? "")) {
    throw launchError("M6_LIVE_DEPENDENCY_ENV_INVALID", "live dependency environment must contain one absolute root and its exact layer hash");
  }
  return Object.freeze({ ...dependencyEnv });
}

export function validateM6LiveCredentialEnvironment(credentialEnv, { required = false } = {}) {
  if (credentialEnv === undefined && !required) return Object.freeze({});
  if (!required && exactKeys(credentialEnv, [])) return Object.freeze({});
  if (!exactKeys(credentialEnv, CREDENTIAL_ENV_KEYS)
    || typeof credentialEnv.DEEPSEEK_API_KEY !== "string"
    || credentialEnv.DEEPSEEK_API_KEY.length < 8
    || credentialEnv.DEEPSEEK_API_KEY.length > 4_096
    || /[\0\r\n]/u.test(credentialEnv.DEEPSEEK_API_KEY)) {
    throw launchError("M6_LIVE_CREDENTIAL_ENV_INVALID", "live credential environment must contain only a non-empty DEEPSEEK_API_KEY");
  }
  return Object.freeze({ DEEPSEEK_API_KEY: credentialEnv.DEEPSEEK_API_KEY });
}

export function createM6LiveChildEnvironment({ sourceEnv = process.env, binding, runtimeEnv, credentialEnv, dependencyEnv } = {}) {
  const exactBinding = validateM6LivePipeBinding(binding);
  const exactRuntimeEnv = validateM6LiveRuntimeEnvironment(runtimeEnv);
  const exactCredentialEnv = validateM6LiveCredentialEnvironment(credentialEnv);
  const exactDependencyEnv = validateM6LiveDependencyEnvironment(dependencyEnv);
  const safe = Object.fromEntries(SAFE_ENV_KEYS
    .filter((key) => typeof sourceEnv[key] === "string")
    .map((key) => [key, sourceEnv[key]]));
  const persistenceRoot = exactRuntimeEnv.XW_DSH_PERSISTENCE_ROOT;
  const sandboxHome = persistenceRoot ? join(persistenceRoot, ".sandbox", "home") : null;
  const sandboxTemp = persistenceRoot ? join(persistenceRoot, ".sandbox", "temp") : null;
  return Object.freeze({
    ...safe,
    ...(sandboxHome ? {
      HOME: sandboxHome,
      USERPROFILE: sandboxHome,
      APPDATA: join(sandboxHome, "AppData", "Roaming"),
      LOCALAPPDATA: join(sandboxHome, "AppData", "Local"),
      TEMP: sandboxTemp,
      TMP: sandboxTemp,
    } : {}),
    ...exactRuntimeEnv,
    ...exactCredentialEnv,
    ...exactDependencyEnv,
    ...(exactDependencyEnv.XW_M6_LIVE_DEPENDENCY_ROOT ? {
      DSH_HOME: join(exactDependencyEnv.XW_M6_LIVE_DEPENDENCY_ROOT, "integrations", "dsh-xw"),
      DSH_TELEMETRY_DISABLED: "1",
    } : {}),
    XW_M6_BROKER_FD: String(M6_LIVE_BROKER_FD),
    XW_M6_BROKER_BINDING: JSON.stringify(exactBinding),
  });
}

export class M6LiveProcessAdapter {
  #childEnv;

  constructor({
    command,
    args = [],
    cwd = process.cwd(),
    sourceEnv = process.env,
    binding,
    handleToolCall,
    executionClass = "PRODUCTION",
    qualification,
    runtimeEnv,
    credentialEnv,
    dependencyEnv,
    requiredTargetEnvironmentAttestationHash = null,
    requiredLiveWindowExpiresAt = null,
    now = Date.now,
    brokerOptions = {},
    terminationOptions = {},
    onFatal = () => {},
  } = {}) {
    if (typeof command !== "string" || command.length === 0) throw launchError("M6_LIVE_CHILD_COMMAND_REQUIRED", "live child command is required");
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) throw launchError("M6_LIVE_CHILD_ARGS_INVALID", "live child args must be a string array");
    if (args.some((arg) => FORBIDDEN_ARG.test(arg))) throw launchError("M6_LIVE_CHILD_AUTHORITY_ARG_FORBIDDEN", "live child args contain token or raw-device authority material");
    if (typeof handleToolCall !== "function") throw launchError("M6_LIVE_BROKER_HANDLER_REQUIRED", "live child requires a parent tool handler");
    const exactRuntimeEnv = validateM6LiveRuntimeEnvironment(runtimeEnv, { required: executionClass === "PRODUCTION" });
    const exactCredentialEnv = validateM6LiveCredentialEnvironment(credentialEnv, { required: executionClass === "PRODUCTION" });
    const exactDependencyEnv = validateM6LiveDependencyEnvironment(dependencyEnv, { required: executionClass === "PRODUCTION" });
    let dependencyLayer = null;
    let qualificationBundle = null;
    let effectiveQualification = qualification;
    if (executionClass === "PRODUCTION") {
      dependencyLayer = verifyM6LiveRuntimeDependencyLayer({
        layerRoot: exactDependencyEnv.XW_M6_LIVE_DEPENDENCY_ROOT,
        expectedLayerHash: exactDependencyEnv.XW_M6_LIVE_DEPENDENCY_LAYER_HASH,
        sourceRoot: sourceReleaseRoot,
      });
      if (pathWithin(dependencyLayer.layerRoot, exactRuntimeEnv.XW_M6_LIVE_MODEL_PROFILE_ROOT)
        || pathWithin(sourceReleaseRoot, exactRuntimeEnv.XW_M6_LIVE_MODEL_PROFILE_ROOT)
        || pathWithin(dependencyLayer.layerRoot, exactRuntimeEnv.XW_DSH_PERSISTENCE_ROOT)
        || pathWithin(sourceReleaseRoot, exactRuntimeEnv.XW_DSH_PERSISTENCE_ROOT)) {
        throw launchError("M6_LIVE_RUNTIME_MUTABLE_ROOT_INVALID", "qualification and persistence roots must remain outside immutable source and dependency layers");
      }
      const sealed = sealedM6LiveChildSpec(dependencyLayer, exactRuntimeEnv);
      if (resolve(command) !== resolve(sealed.command) || resolve(cwd) !== sealed.cwd
        || args.length !== sealed.args.length || args.some((arg, index) => resolveArgument(arg) !== resolveArgument(sealed.args[index]))) {
        throw launchError("M6_LIVE_CHILD_SPEC_UNSEALED", "production live child command, args, cwd, or profile differs from the sealed DSH live spec");
      }
      qualificationBundle = loadContentAddressedLiveModelQualificationBundle({
        qualificationRoot: exactRuntimeEnv.XW_M6_LIVE_MODEL_PROFILE_ROOT,
        expectedProfileHash: exactRuntimeEnv.XW_M6_LIVE_MODEL_PROFILE_HASH,
        installed: dependencyLayer.installedAdapter,
        runtimeEndpoint: exactRuntimeEnv.XW_M6_LIVE_PROVIDER_BASE_URL,
        requiredRuntimeDependencyQualificationHash: dependencyLayer.qualification.qualificationHash,
        requiredTargetEnvironmentAttestationHash,
        requiredLiveWindowExpiresAt,
        now,
      });
      effectiveQualification = qualificationBundle.profile;
    }
    this.command = command;
    this.args = Object.freeze([...args]);
    this.cwd = resolve(cwd);
    this.binding = validateM6LivePipeBinding(binding);
    this.handleToolCall = handleToolCall;
    this.dependencyLayer = dependencyLayer;
    this.qualificationBundle = qualificationBundle;
    this.launchAuthority = validateM6LiveLaunchQualification(executionClass, effectiveQualification, {
      runtimeEndpoint: exactRuntimeEnv.XW_M6_LIVE_PROVIDER_BASE_URL ?? null,
      installed: dependencyLayer?.installedAdapter,
      requiredRuntimeAttestationHash: dependencyLayer?.qualification?.qualificationHash ?? null,
    });
    if (executionClass === "PRODUCTION" && exactRuntimeEnv.XW_M6_LIVE_MODEL_PROFILE_HASH !== this.launchAuthority.modelProfileHash) {
      throw launchError("M6_LIVE_MODEL_PROFILE_HASH_MISMATCH", "runtime model profile hash does not match qualification evidence");
    }
    this.#childEnv = createM6LiveChildEnvironment({
      sourceEnv,
      binding: this.binding,
      runtimeEnv: exactRuntimeEnv,
      credentialEnv: exactCredentialEnv,
      dependencyEnv: exactDependencyEnv,
    });
    this.brokerOptions = Object.freeze({ ...brokerOptions });
    this.terminationOptions = Object.freeze({ ...terminationOptions });
    this.onFatal = onFatal;
    this.persistenceRoot = exactRuntimeEnv.XW_DSH_PERSISTENCE_ROOT ?? null;
    this.launched = false;
    this.closing = false;
    this.cleanupPromise = undefined;
    this.childRef = undefined;
    this.broker = undefined;
  }

  launch() {
    if (this.launched) throw launchError("M6_LIVE_PROCESS_ALREADY_STARTED", "this live process adapter already owns a child");
    if (activeRuns.has(this.binding.runId)) throw launchError("M6_LIVE_RUN_PROCESS_EXISTS", `run ${this.binding.runId} already owns a live child`);
    this.launched = true;
    activeRuns.set(this.binding.runId, this);
    try {
      if (this.launchAuthority.executionClass === "PRODUCTION") this.#prepareSandboxRoots();
      this.childRef = spawnOwnedProcess(this.command, this.args, {
        cwd: this.cwd,
        env: this.#childEnv,
        extraPipeFd: M6_LIVE_BROKER_FD,
      });
      this.#childEnv = undefined;
      const brokerStream = this.childRef.child.stdio[M6_LIVE_BROKER_FD];
      this.broker = new M6LiveParentBroker({
        ...this.brokerOptions,
        stream: brokerStream,
        binding: this.binding,
        brokerFd: M6_LIVE_BROKER_FD,
        handleToolCall: this.handleToolCall,
        onFatal: (error) => {
          this.closing = true;
          let fatalBarrier;
          try { fatalBarrier = this.onFatal(error); } catch (cause) { fatalBarrier = Promise.reject(cause); }
          // The owner may return a generation-fence/handler-drain barrier. Do
          // not terminate the child ahead of that barrier: otherwise a timed
          // out server-side handler could settle after process/run cleanup and
          // create an unaccounted late effect.
          this.cleanupPromise ??= Promise.resolve(fatalBarrier).then(
            () => this.broker.closed.then(() => this.#terminate()),
            async (cause) => {
              await this.broker.closed;
              const receipt = await this.#terminate();
              return Object.freeze({
                ...receipt,
                cleanupBarrierErrorCode: typeof cause?.code === "string"
                  ? cause.code : "M6_LIVE_CLEANUP_BARRIER_FAILED",
              });
            },
          );
        },
      }).start();
      this.broker.ready.catch(() => {});
      this.childRef.child.once("error", (cause) => {
        this.broker.abort(launchError("M6_LIVE_CHILD_PROCESS_ERROR", cause.message, cause));
      });
      this.childRef.child.once("exit", (code, signal) => {
        if (!this.closing) {
          this.closing = true;
          this.broker.abort(launchError("M6_LIVE_CHILD_EARLY_EXIT", `live child exited before parent close (code=${code}, signal=${signal})`));
          this.cleanupPromise ??= this.broker.closed.then(() => this.#terminate());
        }
      });
    } catch (error) {
      this.#childEnv = undefined;
      if (activeRuns.get(this.binding.runId) === this) activeRuns.delete(this.binding.runId);
      throw error;
    }
    return Object.freeze({
      schemaId: "xw.m6-live-process.v1",
      executionClass: this.launchAuthority.executionClass,
      qualificationStatus: this.launchAuthority.qualificationStatus,
      modelProfileHash: this.launchAuthority.modelProfileHash,
      bindingHash: this.binding.bindingHash,
      processRef: this.childRef,
      broker: this.broker,
      ready: this.broker.ready,
      close: () => this.close(),
    });
  }

  #prepareSandboxRoots() {
    const configured = resolve(this.persistenceRoot);
    mkdirSync(configured, { recursive: true });
    if (lstatSync(configured).isSymbolicLink()) {
      throw launchError("M6_LIVE_PERSISTENCE_ROOT_SYMLINK", "live persistence root must not be a symbolic link");
    }
    const root = realpathSync(configured);
    for (const path of [
      join(root, ".sandbox", "home"),
      join(root, ".sandbox", "home", "AppData", "Roaming"),
      join(root, ".sandbox", "home", "AppData", "Local"),
      join(root, ".sandbox", "temp"),
    ]) {
      mkdirSync(path, { recursive: true });
      if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !pathWithin(root, realpathSync(path))) {
        throw launchError("M6_LIVE_SANDBOX_ROOT_INVALID", "live child sandbox path escaped the persistence root");
      }
    }
  }

  close() {
    if (!this.launched || !this.childRef || !this.broker) {
      return Promise.reject(launchError("M6_LIVE_PROCESS_NOT_STARTED", "live process adapter has no owned child"));
    }
    this.closing = true;
    this.cleanupPromise ??= this.broker.close().then(() => this.#terminate());
    return this.cleanupPromise;
  }

  async #terminate() {
    try {
      const [brokerReceipt, processReceipt] = await Promise.all([
        this.broker.closed,
        terminateOwnedProcessTree(this.childRef, this.terminationOptions),
      ]);
      return Object.freeze({
        schemaId: "xw.m6-live-process-close.v1",
        executionClass: this.launchAuthority.executionClass,
        qualificationStatus: this.launchAuthority.qualificationStatus,
        modelProfileHash: this.launchAuthority.modelProfileHash,
        bindingHash: this.binding.bindingHash,
        broker: brokerReceipt,
        process: processReceipt,
        verifiedClosed: brokerReceipt.pipeClosed === true && processReceipt.verifiedClosed === true,
      });
    } finally {
      if (activeRuns.get(this.binding.runId) === this) activeRuns.delete(this.binding.runId);
    }
  }
}

function resolveArgument(value) {
  return isAbsolute(value) ? resolve(value) : value;
}
