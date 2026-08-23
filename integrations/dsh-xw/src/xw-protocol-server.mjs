import { resolve } from "node:path";

import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { JsonRpcLineTransport } from "@deepseek-ai/dsh-sdk-protocol";
import { SessionId } from "@deepseek-ai/dsh-session";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export class XwHarnessProtocolServer {
  constructor(ctx, transport, options = {}) {
    this.ctx = ctx;
    this.transport = transport;
    this.sessionMode = options.sessionMode ?? "create";
    this.serverName = options.serverName ?? "xw-dsh-replay-runtime";
    this.providerErrorPrefix = options.providerErrorPrefix ?? "closed replay provider is not registered";
    this.sessions = new Map();
    this.creations = new Map();
    this.disposers = [
      ctx.on("session/event", (session, event) => transport.notify("session.event", { sessionId: String(session.id), event })),
      ctx.on("agent/status", ({ agent, status }) => transport.notify("session.status", { sessionId: String(agent.session.id), status })),
      ctx.on("session/created", (session) => {
        if (session.header.parentSession !== undefined) transport.notify("subagent.started", {
          parentSessionId: String(session.header.parentSession),
          childSessionId: String(session.id),
        });
      }),
    ];
  }

  async initialize(params) {
    if (!isRecord(params) || typeof params.cwd !== "string" || typeof params.provider !== "string" || typeof params.model !== "string") {
      throw new TypeError("initialize requires cwd, provider and model strings");
    }
    this.cwd = resolve(params.cwd);
    this.provider = params.provider;
    this.model = params.model;
    this.maxTokens = params.maxTokens;
    if (!this.ctx.llm.listProviders().some((provider) => provider.id === this.provider)) throw new Error(`${this.providerErrorPrefix}: ${this.provider}`);
    return { serverInfo: { name: this.serverName, version: "1.0.0" } };
  }

  async prompt(params) {
    if (!isRecord(params) || typeof params.sessionId !== "string" || !Array.isArray(params.contentBlocks)) throw new TypeError("session/prompt requires sessionId and contentBlocks");
    const record = await this.getOrCreate(params.sessionId);
    const message = createUserMessage({ content: params.contentBlocks, source: { kind: "user" } });
    if (process.env.XW_DSH_FAILPOINT === "kill-before-call") setImmediate(() => process.exit(86));
    record.handle.agent.followup(message);
    if (process.env.XW_DSH_FAILPOINT === "kill-after-prompt-ack") setImmediate(() => process.exit(86));
    return { messageId: message.id };
  }

  async getOrCreate(sessionId) {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const pending = this.creations.get(sessionId);
    if (pending) return pending;
    const creation = this.openSession(sessionId);
    this.creations.set(sessionId, creation);
    try { return await creation; } finally { this.creations.delete(sessionId); }
  }

  async openSession(sessionId) {
    const agentOptions = {
      provider: this.provider,
      model: this.model,
      ...(this.maxTokens === undefined ? {} : { maxTokens: this.maxTokens }),
    };
    let handle;
    if (this.sessionMode === "resume") {
      handle = await this.ctx.agents.resume({ resumeSessionId: SessionId(sessionId), agentOptions });
    } else {
      const persisted = await this.ctx.sessionPersistence.list();
      if (persisted.some((header) => String(header.id) === sessionId)) {
        const error = new Error(`persisted session already exists; create is forbidden: ${sessionId}`);
        error.code = "M6_DSH_RESUME_IDENTITY_MISMATCH";
        throw error;
      }
      handle = await this.ctx.agents.create({ sessionId: SessionId(sessionId), meta: { cwd: this.cwd }, agentOptions });
    }
    const record = { handle, sessionMode: this.sessionMode };
    this.sessions.set(sessionId, record);
    return record;
  }

  async shutdown() {
    if (this.shutdownTask) return this.shutdownTask;
    this.shutdownTask = (async () => {
      await Promise.allSettled(this.ctx.sessions.list().map((session) => this.ctx.sessions.flush(session)));
      const records = [...this.sessions.values()];
      this.sessions.clear();
      while (this.disposers.length) this.disposers.pop()?.();
      await Promise.allSettled(records.map((record) => record.handle.dispose()));
      return {};
    })();
    return this.shutdownTask;
  }

  handle(method, params) {
    if (method === "initialize") return this.initialize(params);
    if (method === "session/prompt") return this.prompt(params);
    if (method === "shutdown") return this.shutdown();
    throw new Error(`unknown XW SDK runtime method: ${method}`);
  }
}

export function serveXwProtocol(ctx, options = {}) {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const exit = options.exit ?? ((code) => process.exit(code));
  const transport = new JsonRpcLineTransport(input, output);
  const server = new XwHarnessProtocolServer(ctx, transport, options);
  transport.onRequest(async (method, params) => {
    const result = await server.handle(method, params);
    if (method === "shutdown") setImmediate(async () => {
      await Promise.allSettled([transport.flush()]);
      await Promise.allSettled([ctx.root.fiber.dispose()]);
      exit(0);
    });
    return result;
  });
  ctx.effect(() => {
    transport.start();
    return async () => {
      await server.shutdown();
      transport.close();
    };
  }, "xw-jsonrpc.serve");
  return server;
}
