import { LlmAdapter } from "@deepseek-ai/dsh-llm";

const ROUTES = Object.freeze({
  happy: Object.freeze(["worker_start", "phone_observe", "phone_ground", "phone_act", "phone_verify", "checkpoint_save", "trace_query", "worker_complete"]),
  continue: Object.freeze(["worker_continue", "trace_query", "worker_complete"]),
  wait: Object.freeze(["worker_start", "wait_human", "worker_complete"]),
  replan: Object.freeze(["worker_start", "phone_observe", "phone_ground", "trace_query", "worker_complete"]),
  hardstop: Object.freeze(["worker_start", "phone_observe", "phone_ground", "trace_query", "worker_complete"]),
  ack: Object.freeze([]),
});

function lastUserText(messages) {
  const user = [...messages].reverse().find((message) => message.role === "user" && message.source?.kind !== "tool");
  return user?.content?.filter((block) => block.type === "text").map((block) => block.text).join("\n") ?? "";
}

function currentTurn(messages) {
  let lastUser = -1;
  messages.forEach((message, index) => {
    if (message.role === "user" && message.source?.kind !== "tool") lastUser = index;
  });
  return messages.slice(lastUser + 1);
}

function calledTools(messages) {
  return currentTurn(messages).flatMap((message) => message.content ?? []).filter((block) => block.type === "tool-call").map((block) => block.name);
}

function resultValues(messages) {
  const values = [];
  for (const message of messages) for (const block of message.content ?? []) {
    const blocks = block.type === "tool-result" ? block.content : [block];
    for (const nested of blocks ?? []) {
      if (nested.type !== "text") continue;
      try {
        const value = JSON.parse(nested.text);
        if (value && typeof value === "object") values.push(value);
      } catch {}
    }
  }
  return values;
}

function latest(values, key) {
  return [...values].reverse().find((value) => value[key] !== undefined)?.[key];
}

function argsFor(name, values, routeKind) {
  const workerRunRef = "worker-run-0001";
  switch (name) {
    case "worker_start": return { workerRunRef };
    case "worker_continue": return { workerRunRef, checkpointRef: "checkpoint-resume-0001" };
    case "phone_observe": return { sessionRef: "session-replay-0001" };
    case "phone_ground": return { frameRef: latest(values, "frameRef"), blockId: latest(values, "blockRefs")?.[0], intent: routeKind === "hardstop" ? "delete" : routeKind === "replan" ? "replan" : "tap" };
    case "phone_act": return { groundingDecisionRef: latest(values, "groundingDecisionRef"), operationKey: "operation-replay-0001" };
    case "phone_verify": return { actionReceiptRef: latest(values, "actionReceiptRef"), expectation: "synthetic replay transition succeeded" };
    case "checkpoint_save": return { stateRefs: [latest(values, "verificationRef") ?? latest(values, "actionReceiptRef") ?? workerRunRef] };
    case "trace_query": return { traceId: "trace-replay-0001" };
    case "wait_human": return { reason: "synthetic approval required", evidenceRefs: [workerRunRef] };
    case "worker_complete": return { workerRunRef, outcome: "SUCCEEDED" };
    default: throw new Error(`unknown scripted tool: ${name}`);
  }
}

export class DeterministicReplayAdapter extends LlmAdapter {
  async *stream(options) {
    const prompt = lastUserText(options.messages).toLowerCase();
    if ((prompt.includes("continue") || prompt.includes("resume")) && !options.messages.slice(0, -1).some((message) =>
      (message.content ?? []).some((block) => block.type === "tool-call" && block.name === "worker_complete"))) {
      throw new Error("resume route requires durable prior worker_complete history");
    }
    const routeKind = prompt.includes("ack-only") ? "ack"
      : prompt.includes("continue") || prompt.includes("resume") ? "continue"
      : prompt.includes("hardstop") ? "hardstop"
        : prompt.includes("replan") ? "replan"
          : prompt.includes("wait") ? "wait" : "happy";
    const route = ROUTES[routeKind];
    const completed = calledTools(options.messages);
    const next = route[completed.length];
    if (next) {
      if (!options.tools?.some((tool) => tool.name === next)) throw new Error(`scripted tool is absent from runtime inventory: ${next}`);
      const args = JSON.stringify(argsFor(next, resultValues(options.messages), routeKind));
      const id = `call-${completed.length + 1}-${next}`;
      const block = { type: "tool-call", id, name: next, arguments: args };
      yield { type: "block-start", index: 0, blockType: "tool-call" };
      yield { type: "tool-call-delta", index: 0, id, name: next, argumentsDelta: args };
      yield { type: "block-end", index: 0, block };
      yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
      yield { type: "finish", reason: { kind: "tool-calls" } };
      return;
    }
    const text = `M6-3 ${routeKind} replay complete`;
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text };
    yield { type: "block-end", index: 0, block: { type: "text", text } };
    yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}
