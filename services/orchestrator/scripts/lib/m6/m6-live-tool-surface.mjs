export const M6_LIVE_TOOL_NAMES = Object.freeze([
  "phone_observe", "phone_ground", "phone_act", "phone_verify", "checkpoint_save",
  "trace_query", "wait_human", "worker_start", "worker_continue", "worker_complete",
]);

const H64 = /^[0-9a-f]{64}$/;
const REF = /^[a-z0-9][a-z0-9:_-]{7,127}$/;
const FORBIDDEN_KEY = /(?:coordinate|bounds|rect|adb|serial|shell|command|url|token|secret|password|credential|lease|database|payment|amount|delete|base64|screenshot)|^(?:x|y|x1|y1|x2|y2)$/iu;

const ARG_SPECS = Object.freeze({
  phone_observe: { required: ["runRef", "stepRef"], optional: [] },
  phone_ground: { required: ["frameRef", "intentRef"], optional: ["candidateBlockId"] },
  phone_act: { required: ["decisionRef", "operationKey"], optional: [] },
  phone_verify: { required: ["actionReceiptRef", "expectationRef"], optional: [] },
  checkpoint_save: { required: ["stateRefs"], optional: [] },
  trace_query: { required: ["traceRef"], optional: [] },
  wait_human: { required: ["reasonRef", "evidenceRefs"], optional: [] },
  worker_start: { required: ["workerRunRef"], optional: [] },
  worker_continue: { required: ["workerRunRef", "checkpointRef"], optional: [] },
  worker_complete: { required: ["workerRunRef", "outcome"], optional: [] },
});

const RESULT_SPECS = Object.freeze({
  phone_observe: { required: ["externalEffect", "actionCount", "frameRef"], optional: [] },
  phone_ground: { required: ["externalEffect", "actionCount", "disposition"], optional: ["decisionRef", "operationKey", "reasonRef"] },
  phone_act: { required: ["externalEffect", "actionCount", "effectStatus"], optional: ["actionReceiptRef", "verificationRef", "errorRef"] },
  phone_verify: { required: ["externalEffect", "actionCount", "verified", "verificationRef"], optional: [] },
  checkpoint_save: { required: ["externalEffect", "actionCount", "checkpointRef"], optional: [] },
  trace_query: { required: ["externalEffect", "actionCount", "traceRefs"], optional: [] },
  wait_human: { required: ["externalEffect", "actionCount", "status"], optional: [] },
  worker_start: { required: ["externalEffect", "actionCount", "workerRunRef", "status"], optional: [] },
  worker_continue: { required: ["externalEffect", "actionCount", "workerRunRef", "status"], optional: [] },
  worker_complete: { required: ["externalEffect", "actionCount", "workerRunRef", "status"], optional: [] },
});

function scan(value) {
  if (Array.isArray(value)) return value.some(scan);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) => FORBIDDEN_KEY.test(key.normalize("NFKC")) || scan(child));
}

function validRef(value) {
  return typeof value === "string" && (REF.test(value) || H64.test(value));
}

function resultPropertySchema(key) {
  if (key === "externalEffect" || key === "verified") return { type: "boolean" };
  if (key === "actionCount") return { type: "integer", enum: [0, 1] };
  if (key.endsWith("Refs")) return { type: "array", items: { type: "string" } };
  if (key === "disposition") return { type: "string", enum: ["ALLOW_ONCE", "REPLAN", "HARD_STOP"] };
  if (key === "effectStatus") return { type: "string", enum: ["NOT_SENT", "SENT_UNVERIFIED", "VERIFIED"] };
  if (key === "status") return { type: "string" };
  return { type: "string" };
}

export function validateLiveToolCall({ tool, args }) {
  const errors = [];
  const spec = ARG_SPECS[tool];
  if (!spec) return { ok: false, errors: ["M6_LIVE_TOOL_FORBIDDEN"] };
  if (!args || typeof args !== "object" || Array.isArray(args)) return { ok: false, errors: ["M6_LIVE_TOOL_ARGS_INVALID"] };
  const allowed = new Set([...spec.required, ...spec.optional]);
  if (spec.required.some((key) => !Object.hasOwn(args, key)) || Object.keys(args).some((key) => !allowed.has(key))) errors.push("M6_LIVE_TOOL_SCHEMA_INVALID");
  if (scan(args)) errors.push("M6_LIVE_TOOL_AUTHORITY_LEAK");
  for (const [key, value] of Object.entries(args)) {
    if (key.endsWith("Refs")) {
      if (!Array.isArray(value) || value.length < 1 || value.length > 100 || value.some((entry) => !validRef(entry))) errors.push("M6_LIVE_TOOL_REF_INVALID");
    } else if (key === "outcome") {
      if (!["SUCCEEDED", "FAILED", "AMBIGUOUS"].includes(value)) errors.push("M6_LIVE_TOOL_OUTCOME_INVALID");
    } else if (!validRef(value)) errors.push("M6_LIVE_TOOL_REF_INVALID");
  }
  if (tool === "phone_ground" && args.candidateBlockId !== undefined && !H64.test(args.candidateBlockId)) errors.push("M6_LIVE_TOOL_BLOCK_INVALID");
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

export function validateLiveToolResult({ tool, result }) {
  const spec = RESULT_SPECS[tool];
  if (!spec || !result || typeof result !== "object" || Array.isArray(result) || scan(result)) {
    return { ok: false, errors: ["M6_LIVE_TOOL_RESULT_INVALID"] };
  }
  const allowed = new Set([...spec.required, ...spec.optional]);
  if (spec.required.some((key) => !Object.hasOwn(result, key)) || Object.keys(result).some((key) => !allowed.has(key))) {
    return { ok: false, errors: ["M6_LIVE_TOOL_RESULT_SCHEMA_INVALID"] };
  }
  const effects = result.externalEffect;
  const count = result.actionCount;
  if (tool === "phone_act") {
    if (typeof effects !== "boolean" || ![0, 1].includes(count)
      || effects !== (count === 1) || !["NOT_SENT", "SENT_UNVERIFIED", "VERIFIED"].includes(result.effectStatus)) {
      return { ok: false, errors: ["M6_LIVE_TOOL_EFFECT_ACCOUNTING_INVALID"] };
    }
  } else if (effects !== false || count !== 0) {
    return { ok: false, errors: ["M6_LIVE_TOOL_ZERO_EFFECT_REQUIRED"] };
  }
  for (const [key, value] of Object.entries(result)) {
    if (["externalEffect", "actionCount", "effectStatus", "disposition", "verified", "status"].includes(key)) continue;
    if (key.endsWith("Refs")) {
      if (!Array.isArray(value) || value.some((entry) => !validRef(entry))) return { ok: false, errors: ["M6_LIVE_TOOL_RESULT_REF_INVALID"] };
    } else if (!validRef(value)) return { ok: false, errors: ["M6_LIVE_TOOL_RESULT_REF_INVALID"] };
  }
  if (tool === "phone_ground") {
    if (!["ALLOW_ONCE", "REPLAN", "HARD_STOP"].includes(result.disposition)) return { ok: false, errors: ["M6_LIVE_TOOL_GROUND_RESULT_INVALID"] };
    const allowRefs = validRef(result.decisionRef) && validRef(result.operationKey);
    if ((result.disposition === "ALLOW_ONCE") !== allowRefs || (result.disposition !== "ALLOW_ONCE" && (result.decisionRef !== undefined || result.operationKey !== undefined))) {
      return { ok: false, errors: ["M6_LIVE_TOOL_GROUND_RESULT_INVALID"] };
    }
  }
  if (tool === "phone_act" && result.effectStatus === "VERIFIED" && (!validRef(result.actionReceiptRef) || !validRef(result.verificationRef))) {
    return { ok: false, errors: ["M6_LIVE_TOOL_EFFECT_ACCOUNTING_INVALID"] };
  }
  if (tool === "phone_verify" && typeof result.verified !== "boolean") return { ok: false, errors: ["M6_LIVE_TOOL_RESULT_SCHEMA_INVALID"] };
  if (tool === "wait_human" && !["WAITING", "RESUMED", "ABORTED"].includes(result.status)) return { ok: false, errors: ["M6_LIVE_TOOL_RESULT_SCHEMA_INVALID"] };
  if (tool.startsWith("worker_") && !["RUNNING", "IDLE", "COMPLETED", "FAILED"].includes(result.status)) return { ok: false, errors: ["M6_LIVE_TOOL_RESULT_SCHEMA_INVALID"] };
  return { ok: true, errors: [] };
}

export const M6_LIVE_TOOL_SPEC = Object.freeze(Object.fromEntries(M6_LIVE_TOOL_NAMES.map((name) => [name, Object.freeze({
  name,
  description: `XW M6-4 live ${name}; opaque references only`,
  inputSchema: Object.freeze({
    type: "object",
    additionalProperties: false,
    required: Object.freeze([...ARG_SPECS[name].required]),
    properties: Object.freeze(Object.fromEntries([...ARG_SPECS[name].required, ...ARG_SPECS[name].optional].map((key) => [key, key.endsWith("Refs") ? { type: "array", items: { type: "string" } } : { type: "string" }]))),
  }),
  outputSchema: Object.freeze({
    type: "object",
    additionalProperties: false,
    required: Object.freeze([...RESULT_SPECS[name].required]),
    properties: Object.freeze(Object.fromEntries([...RESULT_SPECS[name].required, ...RESULT_SPECS[name].optional].map((key) => [key, resultPropertySchema(key)]))),
  }),
})])));
