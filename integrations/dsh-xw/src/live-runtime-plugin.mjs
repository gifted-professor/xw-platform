import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadContentAddressedLiveModelQualificationBundle,
} from "./live-model-profile.mjs";
import { verifyM6LiveRuntimeDependencyLayer } from "./live-runtime-dependency-layer.mjs";

export const name = "xw-dsh-live-runtime";

function requiredRuntimeValue(name, code) {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim() === "") throw Object.assign(new Error(`${name} is required by the sealed live runtime`), { code });
  return value;
}

export async function apply(ctx) {
  const runtimeEntry = fileURLToPath(import.meta.url);
  const template = JSON.parse(readFileSync(join(dirname(runtimeEntry), "../profiles/live/model-manifest.json"), "utf8"));
  if (template.status !== "UNQUALIFIED" || template.gateFEligible !== false || template.secretMaterialPresent !== false) {
    throw Object.assign(new Error("the main-built live model manifest must remain a fail-closed template"), { code: "M6_LIVE_PROFILE_TEMPLATE_INVALID" });
  }
  const qualificationRoot = process.env.XW_M6_LIVE_MODEL_PROFILE_ROOT;
  if (typeof qualificationRoot !== "string" || qualificationRoot.trim() === "") {
    throw Object.assign(new Error("an external content-addressed model qualification artifact is required"), { code: "M6_LIVE_PROFILE_UNQUALIFIED" });
  }
  const endpoint = requiredRuntimeValue("XW_M6_LIVE_PROVIDER_BASE_URL", "M6_LIVE_PROVIDER_ENDPOINT_REQUIRED");
  const expectedContentHash = requiredRuntimeValue("XW_M6_LIVE_MODEL_PROFILE_HASH", "M6_LIVE_PROFILE_LOCK_REQUIRED");
  const dependencyRoot = requiredRuntimeValue("XW_M6_LIVE_DEPENDENCY_ROOT", "M6_LIVE_DEPENDENCY_ROOT_REQUIRED");
  const dependencyLayerHash = requiredRuntimeValue("XW_M6_LIVE_DEPENDENCY_LAYER_HASH", "M6_LIVE_DEPENDENCY_HASH_REQUIRED");
  const dependencyLayer = verifyM6LiveRuntimeDependencyLayer({
    layerRoot: dependencyRoot,
    expectedLayerHash: dependencyLayerHash,
  });
  if (resolve(dependencyLayer.liveRuntimePlugin) !== resolve(runtimeEntry)
    || resolve(process.env.DSH_HOME ?? "") !== resolve(dependencyLayer.integrationRoot)) {
    throw Object.assign(new Error("live runtime did not boot from the exact verified dependency layer"), { code: "M6_LIVE_DEPENDENCY_ENTRY_MISMATCH" });
  }
  const qualificationRel = relative(dependencyLayer.layerRoot, resolve(qualificationRoot));
  if (qualificationRel === "" || (qualificationRel !== ".." && !qualificationRel.startsWith(`..${sep}`) && !isAbsolute(qualificationRel))) {
    throw Object.assign(new Error("model qualification artifacts must remain outside the immutable dependency layer"), { code: "M6_LIVE_PROFILE_ARTIFACT_ROOT_INVALID" });
  }
  const bundle = loadContentAddressedLiveModelQualificationBundle({
    qualificationRoot,
    expectedProfileHash: expectedContentHash,
    installed: dependencyLayer.installedAdapter,
    runtimeEndpoint: endpoint,
    requiredRuntimeDependencyQualificationHash: dependencyLayer.qualification.qualificationHash,
  });
  const manifest = bundle.profile;
  let binding;
  try { binding = JSON.parse(requiredRuntimeValue("XW_M6_BROKER_BINDING", "M6_LIVE_PIPE_BINDING_REQUIRED")); } catch (cause) {
    throw Object.assign(new Error("XW_M6_BROKER_BINDING must be canonical JSON", { cause }), { code: "M6_LIVE_PIPE_BINDING_INVALID" });
  }
  const [
    { default: agentPlugin },
    { default: agentLoopPlugin },
    deepseekPlugin,
    { default: llmPlugin },
    { default: sessionPlugin },
    { default: jsonlPlugin },
    { default: systemPromptPlugin },
    { default: toolsPlugin },
    { default: typertPlugin },
    { LiveToolRuntime },
    { serveXwProtocol },
  ] = await Promise.all([
    import("@deepseek-ai/dsh-agent"),
    import("@deepseek-ai/dsh-agent-loop"),
    import("@deepseek-ai/dsh-llm-deepseek"),
    import("@deepseek-ai/dsh-llm"),
    import("@deepseek-ai/dsh-session"),
    import("@deepseek-ai/dsh-session-persistence-jsonl"),
    import("@deepseek-ai/dsh-system-prompt"),
    import("@deepseek-ai/dsh-tools"),
    import("@deepseek-ai/dsh-typert-registry"),
    import("./live-tools.mjs"),
    import("./xw-protocol-server.mjs"),
  ]);

  const root = ctx.root;
  const persistenceRoot = requiredRuntimeValue("XW_DSH_PERSISTENCE_ROOT", "M6_LIVE_PERSISTENCE_ROOT_REQUIRED");
  await root.plugin(llmPlugin);
  await root.plugin(typertPlugin);
  await root.plugin(toolsPlugin);
  await root.plugin(systemPromptPlugin);
  await root.plugin(sessionPlugin);
  await root.plugin(jsonlPlugin, { root: persistenceRoot, compression: "zstd" });
  await root.plugin(agentPlugin);
  await root.plugin(agentLoopPlugin);
  await root.plugin(deepseekPlugin, {
    apiKeyEnv: manifest.credentialRef,
    baseURL: endpoint,
    thinking: manifest.thinking === "enabled" ? "enabled" : "disabled",
    reasoningEffort: manifest.thinking === "enabled" ? manifest.reasoningEffort : "off",
    models: [{ id: manifest.model, name: manifest.model, contextWindow: manifest.contextWindow, maxTokens: manifest.maxTokens, inputModalities: ["text"] }],
    maxTokens: manifest.maxTokens,
    defaultContextWindow: manifest.contextWindow,
    streamIdleTimeoutMs: manifest.streamIdleTimeoutMs,
  });
  const tools = new LiveToolRuntime(root, { binding, fd: Number(process.env.XW_M6_BROKER_FD) });
  const disposeTools = tools.register();
  root.effect(() => disposeTools, "xw-live-tools.dispose");
  root.systemPrompt.section({
    name: "xw:m6-4-live",
    order: -50,
    text: "You are inside the bounded XW M6-4 alias-01 canary. Use only the exact ten opaque-reference tools. Never request raw device authority, coordinates, credentials, payments, deletion, settings, public or social effects.",
  });
  serveXwProtocol(root, {
    sessionMode: "create",
    serverName: "xw-dsh-live-runtime",
    providerErrorPrefix: "sealed live provider is not registered",
  });
}

export default { name, apply };
