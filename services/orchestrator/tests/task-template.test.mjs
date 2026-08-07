import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadTaskTemplates,
  matchTaskTemplate,
  resolveTaskTemplate,
  saveTaskTemplate,
  validateTaskTemplate,
} from "../scripts/lib/task-template.mjs";

function sample(overrides = {}) {
  return {
    schemaId: "xhs.task-template.v1",
    schemaVersion: 1,
    templateId: "task.douyin.keyword-material-collection",
    revision: 1,
    name: "抖音关键词素材采集",
    aliases: ["抖音关键词图文采集并转发"],
    status: "implemented",
    description: "按关键词采集抖音图文并按参数处理结果",
    parameterSchema: {
      type: "object",
      required: ["keywords", "perKeyword"],
      properties: {
        keywords: { type: "array", items: { type: "string" }, minItems: 1, prompt: "关键词是什么？" },
        perKeyword: { type: "integer", minimum: 1, maximum: 100, prompt: "每个词需要多少条？" },
        recipient: { type: "string", default: "天才较瘦", prompt: "接收人是谁？" },
        resume: { type: "boolean", default: true, prompt: "是否续跑？" },
        resultMode: { type: "string", enum: ["share_to_friend", "save_only"], default: "share_to_friend", prompt: "结果如何处理？" },
      },
    },
    steps: [
      {
        id: "campaign",
        kind: "workflow",
        intent: "逐个关键词采集图文并按结果模式处理",
        params: { keywords: "{{keywords}}", perKeyword: "{{perKeyword}}", recipient: "{{recipient}}" },
      },
      {
        id: "explore_fallback",
        kind: "explore",
        intent: "仅在安全步骤页面漂移时探索到外部提交前",
        dependsOn: ["campaign"],
      },
    ],
    effectPolicy: {
      kind: "external_send",
      confirmation: "once_per_run",
      recipientParam: "recipient",
      enabledWhen: { param: "resultMode", equals: "share_to_friend" },
      quantity: { operation: "multiply_length", arrayParam: "keywords", numberParam: "perKeyword" },
    },
    checkpointPolicy: { enabled: true, dedupe: true, resumeParam: "resume" },
    originRunId: "run_fixture",
    ...overrides,
  };
}

test("valid template passes", () => {
  assert.deepEqual(validateTaskTemplate(sample()), []);
});

test("prepare asks all missing required parameters in one response", () => {
  const prepared = resolveTaskTemplate(sample(), {});
  assert.equal(prepared.ready, false);
  assert.equal(prepared.executionReady, false);
  assert.equal(prepared.nextAction, "collect_parameters");
  assert.deepEqual(prepared.missing, ["keywords", "perKeyword"]);
  assert.equal(prepared.questions.length, 2);
  assert.equal(prepared.defaults.recipient, "天才较瘦");
});

test("prepare coerces chat-friendly values and previews batch effect", () => {
  const prepared = resolveTaskTemplate(sample(), {
    keywords: "新疆秋天live，新疆雪景live,新疆公路live",
    perKeyword: "30",
  });
  assert.equal(prepared.ready, true);
  assert.equal(prepared.executionReady, false);
  assert.equal(prepared.nextAction, "resolve_live_plan");
  assert.deepEqual(prepared.params.keywords, ["新疆秋天live", "新疆雪景live", "新疆公路live"]);
  assert.equal(prepared.params.perKeyword, 30);
  assert.equal(prepared.effectPreview.maxQuantity, 90);
  assert.equal(prepared.effectPreview.recipient, "天才较瘦");
  assert.deepEqual(prepared.steps[0].params.keywords, prepared.params.keywords);
  assert.equal(prepared.stageRouteHints[0].route, "orchestrate");
  assert.equal(prepared.stageRouteHints[1].route, "conditional_explore");
  assert.equal(prepared.locatorPolicy.resolved, true);
  assert.equal(prepared.locatorPolicy.foundationCapabilityId, "locator.visual-block.v1");
  assert.equal(prepared.foundationDependencies.length, 1);
  const [locatorDependency] = prepared.foundationDependencies;
  assert.equal(locatorDependency.capabilityId, "locator.visual-block.v1");
  assert.equal(locatorDependency.role, "locator");
  assert.equal(locatorDependency.bundled, true);
  assert.equal(locatorDependency.activation, "when_semantic_bounds_missing_or_ambiguous");
  assert.equal(locatorDependency.executionStatus, "canary_only");
  assert.deepEqual(locatorDependency.appliesToStepIds, ["campaign", "explore_fallback"]);
});

test("parameter-complete draft remains non-executable", () => {
  const prepared = resolveTaskTemplate(sample({ status: "draft", revision: 3 }), {
    keywords: ["新疆夏天live"],
    perKeyword: 3,
  });
  assert.equal(prepared.ready, true);
  assert.equal(prepared.status, "draft");
  assert.equal(prepared.executionReady, false);
  assert.equal(prepared.nextAction, "review_template");
});

test("prepare trims and deduplicates keyword arrays", () => {
  const prepared = resolveTaskTemplate(sample(), {
    keywords: [" 新疆秋天live ", "新疆秋天live", "新疆雪景live"],
    perKeyword: 20,
  });
  assert.deepEqual(prepared.params.keywords, ["新疆秋天live", "新疆雪景live"]);
  assert.equal(prepared.effectPreview.maxQuantity, 40);
});

test("template rejects invalid prompt policy and dependency cycles", () => {
  const badPrompt = sample();
  badPrompt.parameterSchema.properties.keywords.promptPolicy = "sometimes";
  assert.match(JSON.stringify(validateTaskTemplate(badPrompt)), /promptPolicy/);

  const cyclic = sample();
  cyclic.steps[0].dependsOn = ["explore_fallback"];
  assert.match(JSON.stringify(validateTaskTemplate(cyclic)), /cycle/);
});

test("save is immutable and idempotent; catalog matches name and alias", () => {
  const dir = mkdtempSync(join(tmpdir(), "xw-task-template-"));
  try {
    const first = saveTaskTemplate(sample(), { dir });
    assert.equal(first.result, "saved");
    const second = saveTaskTemplate(sample(), { dir });
    assert.equal(second.result, "already_saved");
    const loaded = loadTaskTemplates({ dir });
    assert.equal(loaded.errors.length, 0);
    assert.equal(loaded.templates.length, 1);
    assert.equal(matchTaskTemplate(loaded.templates, "抖音关键词素材采集").match.templateId, sample().templateId);
    assert.equal(matchTaskTemplate(loaded.templates, "抖音关键词图文采集并转发").match.templateId, sample().templateId);

    const path = first.path;
    const changed = { ...JSON.parse(readFileSync(path, "utf8")), description: "changed" };
    delete changed.descriptorHash;
    assert.throws(() => saveTaskTemplate(changed, { dir }), /immutable task template conflict/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("catalog rejects tampered descriptor hash", () => {
  const dir = mkdtempSync(join(tmpdir(), "xw-task-template-bad-"));
  try {
    writeFileSync(join(dir, "bad.json"), JSON.stringify({ ...sample(), descriptorHash: "0".repeat(64) }));
    const loaded = loadTaskTemplates({ dir });
    assert.equal(loaded.templates.length, 0);
    assert.equal(loaded.errors.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("latest draft revision prevents fallback to an older implemented revision", () => {
  const dir = mkdtempSync(join(tmpdir(), "xw-task-template-latest-draft-"));
  try {
    saveTaskTemplate(sample({ revision: 1, status: "implemented" }), { dir });
    saveTaskTemplate(sample({ revision: 2, status: "draft" }), { dir });

    const loaded = loadTaskTemplates({ dir });
    assert.equal(loaded.errors.length, 0);
    assert.equal(loaded.templates.length, 1);
    const matched = matchTaskTemplate(loaded.templates, "抖音关键词素材采集").match;
    assert.equal(matched.revision, 2);
    assert.equal(matched.status, "draft");

    const prepared = resolveTaskTemplate(matched, {
      keywords: ["新疆夏天live"],
      perKeyword: 3,
    });
    assert.equal(prepared.ready, true);
    assert.equal(prepared.executionReady, false);
    assert.equal(prepared.nextAction, "review_template");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
