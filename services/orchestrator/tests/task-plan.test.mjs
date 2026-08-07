import assert from "node:assert/strict";
import test from "node:test";
import { compileTaskPlan } from "../scripts/lib/task-plan.mjs";

const CAPS = [
  {
    id: "douyin.observe.snapshot",
    appId: "douyin",
    availability: "implemented",
    inputSchema: { type: "object", properties: {}, required: [] },
    policy: { runnableAsJob: true, availability: "implemented" },
  },
  {
    id: "douyin.observe.search",
    appId: "douyin",
    availability: "implemented",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    policy: { runnableAsJob: true, availability: "implemented" },
  },
  {
    id: "xhs.observe.search",
    appId: "xhs",
    availability: "implemented",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    policy: { runnableAsJob: true, availability: "implemented" },
  },
  {
    id: "xianyu.publish.open_dry_run",
    appId: "xianyu",
    availability: "implemented",
    inputSchema: { type: "object", properties: {}, required: [] },
    policy: { runnableAsJob: true, availability: "implemented" },
  },
];

const RECIPES = [
  {
    recipeId: "recipe.douyin.observe.snapshot",
    status: "implemented",
    spec: {
      recipeId: "recipe.douyin.observe.snapshot",
      intentAliases: ["抖音首页快照"],
      inputSchema: { type: "object", properties: {}, required: [] },
      executor: { capabilityId: "douyin.observe.snapshot", paramsTemplate: {} },
    },
  },
  {
    recipeId: "recipe.douyin.search",
    status: "implemented",
    spec: {
      recipeId: "recipe.douyin.search",
      intentAliases: ["抖音搜索词"],
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      executor: {
        capabilityId: "douyin.observe.search",
        paramsTemplate: {},
      },
    },
  },
];

test("L0: exact implemented capability with no required params", () => {
  const plan = compileTaskPlan({
    goal: "请跑 douyin.observe.snapshot",
    catalogCapabilities: CAPS,
    recipes: RECIPES,
  });
  assert.equal(plan.schemaId, "xhs.task-plan.v1");
  assert.equal(plan.modelTier, "L0");
  assert.equal(plan.resolverPath, "exact_capability");
  assert.equal(plan.matched.capabilityId, "douyin.observe.snapshot");
});

test("L0: implemented recipe alias with no required params", () => {
  const plan = compileTaskPlan({
    goal: "抖音首页快照",
    catalogCapabilities: CAPS,
    recipes: RECIPES,
  });
  assert.equal(plan.modelTier, "L0");
  assert.equal(plan.resolverPath, "recipe_alias");
  assert.equal(plan.matched.recipeId, "recipe.douyin.observe.snapshot");
  assert.equal(plan.locatorPolicy.resolved, true);
  assert.equal(plan.locatorPolicy.foundationCapabilityId, "locator.visual-block.v1");
  assert.deepEqual(plan.foundationDependencies[0].appliesToStepIds, ["step_recipe"]);
  assert.equal(plan.foundationDependencies[0].activation, "when_semantic_bounds_missing_or_ambiguous");
});

test("L1: matched capability but params need NL extraction", () => {
  const plan = compileTaskPlan({
    goal: "douyin.observe.search 帮我搜一下",
    catalogCapabilities: CAPS,
    recipes: RECIPES,
  });
  assert.equal(plan.modelTier, "L1");
  assert.equal(plan.resolverPath, "exact_capability");
  assert.equal(plan.matched.capabilityId, "douyin.observe.search");
});

test("L1: recipe alias with missing required params", () => {
  const plan = compileTaskPlan({
    goal: "抖音搜索词",
    catalogCapabilities: CAPS,
    recipes: RECIPES,
  });
  assert.equal(plan.modelTier, "L1");
  assert.equal(plan.resolverPath, "recipe_alias");
  assert.equal(plan.matched.recipeId, "recipe.douyin.search");
});

test("L2: unknown / explore goal", () => {
  const plan = compileTaskPlan({
    goal: "探索一下这个从没见过的页面",
    catalogCapabilities: CAPS,
    recipes: RECIPES,
  });
  assert.equal(plan.modelTier, "L2");
  assert.ok(plan.resolverPath === "explore");
  assert.equal(plan.locatorPolicy.resolved, true);
  assert.equal(plan.locatorPolicy.foundationCapabilityId, "locator.visual-block.v1");
  assert.deepEqual(plan.foundationDependencies[0].appliesToStepIds, ["step_explore"]);
});

test("XHS search never crosses the app boundary into Douyin", () => {
  const douyinOnly = compileTaskPlan({
    goal: "小红书搜索 query=新疆夏天",
    catalogCapabilities: CAPS.filter((capability) => capability.appId === "douyin"),
    recipes: [
      {
        recipeId: "recipe.douyin.generic-search",
        status: "implemented",
        spec: {
          appId: "douyin",
          intentAliases: ["搜索"],
          inputSchema: { type: "object", properties: {}, required: [] },
          executor: { capabilityId: "douyin.observe.search", paramsTemplate: {} },
        },
      },
    ],
  });
  assert.equal(douyinOnly.targetApp, "xhs");
  assert.equal(douyinOnly.resolverPath, "explore");
  assert.equal(douyinOnly.matched.capabilityId, null);
  assert.equal(douyinOnly.matched.recipeId, null);

  const plan = compileTaskPlan({
    goal: "小红书搜索 query=新疆夏天",
    catalogCapabilities: CAPS,
    recipes: RECIPES,
  });
  assert.equal(plan.targetApp, "xhs");
  assert.equal(plan.resolverPath, "capability_keyword");
  assert.equal(plan.matched.capabilityId, "xhs.observe.search");
  assert.notEqual(plan.matched.capabilityId, "douyin.observe.search");
  assert.equal(plan.matched.recipeId, null);
});

test("an App-only match cannot manufacture an unrelated same-App capability", () => {
  const plan = compileTaskPlan({
    goal: "小红书搜索 ai额度 最近一天 前4条链接",
    catalogCapabilities: [{
      id: "xhs.collect.standing_grant",
      appId: "xhs",
      availability: "implemented",
      policy: { runnableAsJob: true, availability: "implemented" },
    }],
    recipes: [],
  });
  assert.equal(plan.targetApp, "xhs");
  assert.equal(plan.resolverPath, "explore");
  assert.equal(plan.matched.capabilityId, null);
  assert.equal(plan.foundationDependencies[0].capabilityId, "locator.visual-block.v1");
});

test("canary_only recipe is not compiled as an implemented Run", () => {
  const plan = compileTaskPlan({
    goal: "抖音灰度搜索流程",
    catalogCapabilities: [],
    recipes: [
      {
        recipeId: "recipe.douyin.search.canary",
        status: "canary_only",
        spec: {
          appId: "douyin",
          intentAliases: ["抖音灰度搜索流程"],
          inputSchema: { type: "object", properties: {}, required: [] },
          executor: { capabilityId: "douyin.observe.search", paramsTemplate: {} },
        },
      },
    ],
  });
  assert.equal(plan.modelTier, "L2");
  assert.equal(plan.resolverPath, "explore");
  assert.equal(plan.matched.recipeId, null);
  assert.equal(plan.steps[0].kind, "explore");
});

test("L2: repair path", () => {
  const plan = compileTaskPlan({
    goal: "repair 01 quarantine",
    catalogCapabilities: CAPS,
    recipes: RECIPES,
  });
  assert.equal(plan.modelTier, "L2");
  assert.equal(plan.resolverPath, "repair");
});

test("L3: payment / approve / policy gate", () => {
  for (const goal of ["发起支付确认", "approve this policy change", "给账户充值"]) {
    const plan = compileTaskPlan({
      goal,
      catalogCapabilities: CAPS,
      recipes: RECIPES,
    });
    assert.equal(plan.modelTier, "L3", goal);
    assert.equal(plan.resolverPath, "human_gate");
  }
});

test("keyword capability match falls through after exact/recipe miss", () => {
  const plan = compileTaskPlan({
    goal: "闲鱼打开草稿 dry run 观察一下",
    catalogCapabilities: CAPS,
    recipes: [],
  });
  // May be L0/L1 via keyword or L2 explore depending on score; must not crash.
  assert.equal(plan.schemaId, "xhs.task-plan.v1");
  assert.ok(["L0", "L1", "L2"].includes(plan.modelTier));
});
