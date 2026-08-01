// _run-context.mjs — REX Phase 3 §5.2 item 1 / A4：统一运行上下文层
//
// 贯穿 A/B 两仓的 run/effect/release/schema/policy 维度，是 evidence 双写、
// Review receipt、adopt batch 的公共锚点。一个 run context 是不可变快照，
// 派生新 effect 用 withEffect（bump sequence、换 effectId），原上下文不变。
//
// policyMode 约束到已知集合：legacy（默认，未铺开前不假设 shadow）/ shadow /
// v1 / staging。runId + actor 必填；其余可空（null）。指纹用 canonical key-sort，
// 跨仓与 evidence-store/canonical.mjs 同一套编码（A 仓此处内联实现，避免跨仓 import）。

import { createHash } from "node:crypto";

const SCHEMA_VERSION = "xhs.run-context.v1";
const POLICY_MODES = new Set(["legacy", "shadow", "v1", "staging"]);

export function createRunContext(input = {}) {
  if (!input || typeof input !== "object") throw new Error("createRunContext: input object required");
  const runId = requireString(input.runId, "runId");
  const actor = requireString(input.actor, "actor");
  const policyMode = input.policyMode ?? "legacy";
  if (!POLICY_MODES.has(policyMode)) {
    throw new Error(`createRunContext: policyMode "${policyMode}" not in ${[...POLICY_MODES].join("/")}`);
  }
  const sequence = Number.isInteger(input.sequence) ? input.sequence : 0;

  const base = {
    schemaVersion: SCHEMA_VERSION,
    runId,
    flow: input.flow ?? null,
    branch: input.branch ?? null,
    effectId: input.effectId ?? null,
    actor,
    app: input.app ?? null,
    device: input.device ?? null,
    job: input.job ?? null,
    session: input.session ?? null,
    lease: input.lease ?? null,
    sequence,
    releaseId: input.releaseId ?? null,
    policyMode,
  };

  // 把 withEffect 作为不可变对象上的方法；freeze 后仍可调用，只是不能改字段。
  return Object.freeze(Object.assign(Object.create(RunContextProto), base, {
    withEffect(effectId) {
      if (!effectId || typeof effectId !== "string") throw new Error("withEffect: effectId string required");
      return createRunContext({ ...base, effectId, sequence: base.sequence + 1 });
    },
  }));
}

const RunContextProto = {};

function requireString(value, name) {
  if (typeof value !== "string" || !value) throw new Error(`createRunContext: ${name} required`);
  return value;
}

export function canonicalizeRunContext(ctx) {
  // 与 B 仓 control-plane/lib/canonical.mjs 同编码：递归按 key 排序。
  const obj = { ...ctx };
  delete obj.withEffect; // 方法不入指纹
  return Object.fromEntries(Object.keys(obj).sort().map((k) => [k, obj[k]]));
}

export function runContextFingerprint(ctx) {
  const json = JSON.stringify(canonicalizeRunContext(ctx));
  // sha256（内联，零依赖；与 B 仓 canonical.sha256 同算法）
  return createHash("sha256").update(json).digest("hex");
}