import { M6_LIVE_TOOL_NAMES, M6_LIVE_TOOL_SPEC, validateLiveToolResult } from "../../../services/orchestrator/scripts/lib/m6/m6-live-tool-surface.mjs";

import { LivePipeToolClient } from "./live-pipe-client.mjs";

export class LiveToolRuntime {
  constructor(ctx, { client = null, binding, fd } = {}) {
    this.ctx = ctx;
    this.client = client || new LivePipeToolClient({ binding, fd });
  }

  definitions() {
    return M6_LIVE_TOOL_NAMES.map((tool) => ({
      name: tool,
      description: M6_LIVE_TOOL_SPEC[tool].description,
      parameters: M6_LIVE_TOOL_SPEC[tool].inputSchema,
      output: {
        schema: M6_LIVE_TOOL_SPEC[tool].outputSchema,
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
      },
      execute: async (args) => {
        const result = await this.client.call(tool, args);
        const validation = validateLiveToolResult({ tool, result });
        if (!validation.ok) throw Object.assign(new Error(`live broker result rejected: ${validation.errors.join(",")}`), { code: validation.errors[0] });
        return result;
      },
    }));
  }

  register() {
    const disposers = this.definitions().map((definition) => this.ctx.tools.register(definition));
    return () => {
      disposers.reverse().forEach((dispose) => dispose());
      this.client.close();
    };
  }
}
