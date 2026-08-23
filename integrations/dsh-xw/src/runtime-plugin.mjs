import { join, resolve } from "node:path";

import agentPlugin from "@deepseek-ai/dsh-agent";
import agentLoopPlugin from "@deepseek-ai/dsh-agent-loop";
import llmPlugin from "@deepseek-ai/dsh-llm";
import sessionPlugin from "@deepseek-ai/dsh-session";
import * as checkpointPolicyPlugin from "@deepseek-ai/dsh-session-checkpoint-policy";
import jsonlPlugin from "@deepseek-ai/dsh-session-persistence-jsonl";
import systemPromptPlugin from "@deepseek-ai/dsh-system-prompt";
import toolsPlugin from "@deepseek-ai/dsh-tools";
import typertPlugin from "@deepseek-ai/dsh-typert-registry";

import { DeterministicReplayAdapter } from "./deterministic-llm.mjs";
import { ReplayToolRuntime } from "./replay-tools.mjs";
import { serveXwProtocol } from "./xw-protocol-server.mjs";

export const name = "xw-dsh-replay-runtime";

export async function apply(ctx) {
  const root = ctx.root;
  const persistenceRoot = resolve(process.env.XW_DSH_PERSISTENCE_ROOT ?? join(process.cwd(), ".xw-dsh-sessions"));
  const replayRoot = resolve(process.env.XW_DSH_REPLAY_ROOT ?? join(process.cwd(), ".xw-dsh-replay"));

  await root.plugin(llmPlugin);
  await root.plugin(typertPlugin);
  await root.plugin(toolsPlugin);
  await root.plugin(systemPromptPlugin);
  await root.plugin(sessionPlugin);
  await root.plugin(jsonlPlugin, { root: persistenceRoot, compression: "zstd" });
  await root.plugin(agentPlugin);
  await root.plugin(agentLoopPlugin);
  await root.plugin(checkpointPolicyPlugin);

  root.llm.registerAdapter(["xw-replay"], new DeterministicReplayAdapter());
  const tools = new ReplayToolRuntime(root, replayRoot, { profileHash: process.env.XW_DSH_PROFILE_HASH });
  tools.register();
  root.systemPrompt.section({
    name: "xw:replay",
    order: -50,
    text: "You are running the closed XW M6-3 deterministic replay. Use only the ten registered replay tools in scripted order.",
  });
  serveXwProtocol(root, { sessionMode: process.env.XW_DSH_SESSION_MODE === "resume" ? "resume" : "create" });
}

export default { name, apply };
