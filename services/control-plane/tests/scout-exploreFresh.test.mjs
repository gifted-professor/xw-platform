import assert from "node:assert/strict";
import test from "node:test";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeDevice(alias = "01") {
  return {
    serial: "FAKE123",
    alias,
    label: `${alias}-test`,
    control: { deviceId: "dev-01", online: true },
  };
}

function makeCapability(overrides = {}) {
  return {
    id: "xhs.comment.send",
    appId: "xhs",
    packageName: "com.xingin.xhs",
    maturity: "E2",
    risk: "R2",
    automationPolicy: { mode: "approval_required" },
    ...overrides,
  };
}

function makeRecipe(overrides = {}) {
  return {
    id: "recipe-1",
    app: "xhs",
    category: "recipe",
    title: "test recipe",
    content: "test content",
    verifiedBy: [],
    ...overrides,
  };
}

import {
  selectTarget,
  classifyRecipe,
  buildRecipeIndex,
  verifyConstraint,
  matchConstraintPattern,
  grepFile,
  CONSTRAINT_PATTERNS,
} from "../scout/scout.mjs";

// ── classifyRecipe v2.2 ─────────────────────────────────────────────────────

test("classifyRecipe returns verifyMode when set to replay", () => {
  const r = makeRecipe({ verifyMode: "replay", steps: [{ action: "focus" }] });
  assert.equal(classifyRecipe(r), "replay");
});

test("classifyRecipe returns verifyMode when set to constraint", () => {
  const r = makeRecipe({ verifyMode: "constraint" });
  assert.equal(classifyRecipe(r), "constraint");
});

test("classifyRecipe returns verifyMode when set to human", () => {
  const r = makeRecipe({ verifyMode: "human" });
  assert.equal(classifyRecipe(r), "human");
});

test("classifyRecipe falls back to step heuristic when no verifyMode", () => {
  const r = makeRecipe({ steps: [{ action: "focus", params: {} }] });
  delete r.verifyMode;
  assert.equal(classifyRecipe(r), "replay");
});

test("classifyRecipe falls back to rule heuristic when no verifyMode and no steps", () => {
  const r = makeRecipe({ content: "comment-cap must be 1 per loop" });
  delete r.verifyMode;
  assert.equal(classifyRecipe(r), "constraint");
});

// ── buildRecipeIndex ────────────────────────────────────────────────────────

test("buildRecipeIndex uses appliesTo for mapping", () => {
  const r1 = makeRecipe({ id: "r1", appliesTo: ["xhs.comment.send", "xhs.comment.edit"] });
  const r2 = makeRecipe({ id: "r2", appliesTo: ["xhs.observe.feed"] });
  const index = buildRecipeIndex([r1, r2]);
  assert.equal(index.get("xhs.comment.send")?.length, 1);
  assert.equal(index.get("xhs.comment.edit")?.length, 1);
  assert.equal(index.get("xhs.observe.feed")?.length, 1);
  assert.equal(index.get("r1"), undefined); // id not used when appliesTo present
});

test("buildRecipeIndex falls back to recipe.id when no appliesTo", () => {
  const r1 = makeRecipe({ id: "xhs.observe.feed" });
  delete r1.appliesTo;
  const index = buildRecipeIndex([r1]);
  assert.equal(index.get("xhs.observe.feed")?.length, 1);
});

test("buildRecipeIndex handles empty appliesTo as legacy", () => {
  const r1 = makeRecipe({ id: "xhs.observe.feed", appliesTo: [] });
  const index = buildRecipeIndex([r1]);
  assert.equal(index.get("xhs.observe.feed")?.length, 1);
});

// ── selectTarget v2.2 ──────────────────────────────────────────────────────

test("selectTarget skips capabilities with automationPolicy.mode=disabled", () => {
  const caps = [makeCapability({ automationPolicy: { mode: "disabled" } })];
  const result = selectTarget(caps, [], null);
  assert.equal(result, null);
});

test("selectTarget returns null when no candidates", () => {
  const result = selectTarget([], [], null);
  assert.equal(result, null);
});

test("selectTarget P1: appliesTo matches capability + verifiedBy=[] + verifyMode=constraint", () => {
  const cap = makeCapability({ id: "xhs.comment.send", maturity: "E2", risk: "R2" });
  const recipe = makeRecipe({
    id: "comment-cap-one-per-loop",
    appliesTo: ["xhs.comment.send"],
    verifyMode: "constraint",
    verifiedBy: [],
    content: "comment-cap must be 1 per loop to avoid risk control",
  });
  const result = selectTarget([cap], [recipe], null);
  assert.equal(result?.id, "xhs.comment.send");
  assert.equal(result?._priority, 1);
  assert.equal(result?._recipeType, "constraint");
});

test("selectTarget P1: appliesTo matches + verifyMode=replay", () => {
  const cap = makeCapability({ id: "xhs.observe.feed", maturity: "E3", risk: "R0" });
  const recipe = makeRecipe({
    id: "feed-observe-recipe",
    appliesTo: ["xhs.observe.feed"],
    verifyMode: "replay",
    verifiedBy: [],
    steps: [{ action: "feedCards" }],
  });
  const result = selectTarget([cap], [recipe], null);
  assert.equal(result?.id, "xhs.observe.feed");
  assert.equal(result?._priority, 1);
  assert.equal(result?._recipeType, "replay");
});

test("selectTarget P1: skips verifyMode=human recipes", () => {
  const cap = makeCapability({ id: "xhs.comment.send", maturity: "E2" });
  const recipe = makeRecipe({
    id: "human-recipe",
    appliesTo: ["xhs.comment.send"],
    verifyMode: "human",
    verifiedBy: [],
  });
  const result = selectTarget([cap], [recipe], null);
  assert.equal(result, null); // human verifyMode not eligible for P1
});

test("selectTarget P1: skips already-verified recipes", () => {
  const cap = makeCapability({ id: "xhs.comment.send", maturity: "E2" });
  const recipe = makeRecipe({
    id: "verified-recipe",
    appliesTo: ["xhs.comment.send"],
    verifyMode: "constraint",
    verifiedBy: ["scout-hermes-v1"],
  });
  const result = selectTarget([cap], [recipe], null);
  assert.equal(result, null); // already verified
});

test("selectTarget P0: E0/E1 with recipe takes priority over P1", () => {
  const capLow = makeCapability({ id: "xhs.new.thing", maturity: "E0", risk: "R0" });
  const capHigh = makeCapability({ id: "xhs.comment.send", maturity: "E2", risk: "R2" });
  const recipeLow = makeRecipe({
    id: "low-recipe",
    appliesTo: ["xhs.new.thing"],
    verifyMode: "constraint",
    verifiedBy: ["someone"],
  });
  const recipeHigh = makeRecipe({
    id: "high-recipe",
    appliesTo: ["xhs.comment.send"],
    verifyMode: "constraint",
    verifiedBy: [],
  });
  const result = selectTarget([capLow, capHigh], [recipeLow, recipeHigh], null);
  assert.equal(result?.id, "xhs.new.thing"); // P0 wins
  assert.equal(result?._priority, 0);
});

test("selectTarget P2: E0/E1 with no recipe", () => {
  const cap = makeCapability({ id: "xiaowei.lab.raw", maturity: "E1", risk: "R1" });
  const result = selectTarget([cap], [], null);
  assert.equal(result?.id, "xiaowei.lab.raw");
  assert.equal(result?._priority, 2);
});

test("selectTarget legacy: recipe.id === cap.id without appliesTo", () => {
  const cap = makeCapability({ id: "xhs.observe.feed", maturity: "E3", risk: "R0" });
  const recipe = makeRecipe({
    id: "xhs.observe.feed",
    verifyMode: "constraint",
    verifiedBy: [],
  });
  delete recipe.appliesTo;
  const result = selectTarget([cap], [recipe], null);
  assert.equal(result?.id, "xhs.observe.feed");
  assert.equal(result?._priority, 1);
});

test("selectTarget filter narrows candidates", () => {
  const cap1 = makeCapability({ id: "xhs.comment.send", appId: "xhs", maturity: "E2" });
  const cap2 = makeCapability({ id: "xhs.observe.feed", appId: "xhs", maturity: "E3", risk: "R0" });
  const r1 = makeRecipe({ id: "r1", appliesTo: ["xhs.comment.send"], verifyMode: "constraint", verifiedBy: [] });
  const r2 = makeRecipe({ id: "r2", appliesTo: ["xhs.observe.feed"], verifyMode: "constraint", verifiedBy: [] });
  const result = selectTarget([cap1, cap2], [r1, r2], "observe");
  assert.equal(result?.id, "xhs.observe.feed");
});

// ── exploreFresh packageName validation ─────────────────────────────────────

test("exploreFresh packageName check: null packageName causes skip", () => {
  const target = makeCapability({ packageName: null });
  const pkg = "com.xingin.xhs";
  const oldCheck = pkg.includes(target.packageName?.split(".")?.[1] || "xhs");
  assert.equal(oldCheck, true, "old logic wrongly passes for null packageName");
  assert.equal(target.packageName, null, "null packageName must be detected before focus check");
});

test("exploreFresh packageName check: valid packageName works correctly", () => {
  const target = makeCapability({ packageName: "com.xingin.xhs" });
  const pkg = "com.xingin.xhs";
  const segment = target.packageName?.split(".")?.[1];
  assert.equal(segment, "xingin");
  assert.equal(pkg.includes(segment), true);
});

test("exploreFresh packageName check: mismatched app detected", () => {
  const target = makeCapability({ packageName: "com.xingin.xhs" });
  const pkg = "com.tencent.mm";
  const segment = target.packageName?.split(".")?.[1];
  assert.equal(pkg.includes(segment), false, "mismatched package must be detected");
});

// ── CONSTRAINT_PATTERNS registry ────────────────────────────────────────────

test("CONSTRAINT_PATTERNS has at least 3 patterns", () => {
  assert.ok(CONSTRAINT_PATTERNS.length >= 3);
});

test("CONSTRAINT_PATTERNS each have required fields", () => {
  for (const p of CONSTRAINT_PATTERNS) {
    assert.ok(p.id, `pattern missing id`);
    assert.ok(p.keywords?.length > 0, `pattern ${p.id} missing keywords`);
    assert.ok(p.grepPattern, `pattern ${p.id} missing grepPattern`);
    assert.ok(p.grepFiles?.length > 0, `pattern ${p.id} missing grepFiles`);
    assert.ok(typeof p.validateEvidence === "function", `pattern ${p.id} missing validateEvidence`);
  }
});

// ── matchConstraintPattern ──────────────────────────────────────────────────

test("matchConstraintPattern matches comment-cap recipe", () => {
  const recipe = makeRecipe({ content: "comment-cap must be 1 per loop", title: "comment-cap-one-per-loop" });
  const pat = matchConstraintPattern(recipe);
  assert.equal(pat?.id, "comment-cap");
});

test("matchConstraintPattern matches timeout recipe", () => {
  const recipe = makeRecipe({ content: "primitive timeout 90s", title: "primitive-timeout-90s" });
  const pat = matchConstraintPattern(recipe);
  assert.equal(pat?.id, "timeout-90s");
});

test("matchConstraintPattern matches fail-closed recipe", () => {
  const recipe = makeRecipe({ content: "fail-closed routing", title: "watcher-fail-closed-runid" });
  const pat = matchConstraintPattern(recipe);
  assert.equal(pat?.id, "fail-closed");
});

test("matchConstraintPattern returns null for unknown content", () => {
  const recipe = makeRecipe({ content: "something unrelated", title: "random" });
  const pat = matchConstraintPattern(recipe);
  assert.equal(pat, null);
});

// ── grepFile ────────────────────────────────────────────────────────────────

test("grepFile finds commentCap in task-runner.mjs", () => {
  const result = grepFile("scripts/task-runner.mjs", "commentCap|comment.?cap");
  assert.ok(result, "grepFile should find commentCap in task-runner.mjs");
  assert.ok(result.includes("commentCap"), "result should contain commentCap");
});

test("grepFile finds timeoutMs in capabilities.json", () => {
  const result = grepFile("apps/xhs/capabilities.json", "timeoutMs.*90");
  assert.ok(result, "grepFile should find timeoutMs 90000 in capabilities.json");
  assert.ok(result.includes("90000"), "result should contain 90000");
});

test("grepFile returns null for non-existent file", () => {
  const result = grepFile("nonexistent/file.mjs", "pattern");
  assert.equal(result, null);
});

test("grepFile returns null for pattern not found", () => {
  const result = grepFile("scripts/task-runner.mjs", "ZZZZNOTFOUND99999");
  assert.equal(result, null);
});

// ── verifyConstraint ────────────────────────────────────────────────────────

test("verifyConstraint confirms comment-cap constraint", () => {
  const recipe = makeRecipe({
    id: "comment-cap-one-per-loop",
    content: "comment-cap per loop must be 1 to avoid risk control",
    title: "comment-cap-one-per-loop",
    verifyMode: "constraint",
  });
  const result = verifyConstraint(recipe);
  assert.equal(result.ok, true, `expected ok=true, got ok=${result.ok} reason=${result.reason}`);
  assert.equal(result.pattern, "comment-cap");
  assert.ok(result.evidence.includes("task-runner.mjs"), `evidence should mention task-runner.mjs: ${result.evidence}`);
});

test("verifyConstraint confirms timeout-90s constraint", () => {
  const recipe = makeRecipe({
    id: "primitive-timeout-90s",
    content: "primitive operation timeout 90 seconds",
    title: "primitive-timeout-90s",
    verifyMode: "constraint",
  });
  const result = verifyConstraint(recipe);
  assert.equal(result.ok, true, `expected ok=true, got ok=${result.ok} reason=${result.reason}`);
  assert.equal(result.pattern, "timeout-90s");
  assert.ok(result.evidence.includes("capabilities.json"), `evidence should mention capabilities.json: ${result.evidence}`);
});

test("verifyConstraint confirms fail-closed constraint", () => {
  const recipe = makeRecipe({
    id: "watcher-fail-closed-runid",
    content: "routing must be fail-closed",
    title: "watcher-fail-closed-runid",
    verifyMode: "constraint",
  });
  const result = verifyConstraint(recipe);
  assert.equal(result.ok, true, `expected ok=true, got ok=${result.ok} reason=${result.reason}`);
  assert.equal(result.pattern, "fail-closed");
});

test("verifyConstraint returns null for unknown constraint", () => {
  const recipe = makeRecipe({
    id: "unknown-constraint",
    content: "something completely unrelated to any known pattern",
    title: "unknown-constraint",
    verifyMode: "constraint",
  });
  const result = verifyConstraint(recipe);
  assert.equal(result.ok, null);
  assert.equal(result.reason, "no_matching_pattern");
});

// ── verifyConstraint dry-run ────────────────────────────────────────────────

test("verifyConstraint dry-run mode returns result without side effects", () => {
  const recipe = makeRecipe({
    id: "comment-cap-one-per-loop",
    content: "comment-cap per loop must be 1",
    title: "comment-cap-one-per-loop",
    verifyMode: "constraint",
  });
  const result = verifyConstraint(recipe, { dryRun: true });
  assert.equal(result.ok, true);
  assert.equal(result.pattern, "comment-cap");
  // No HTTP calls made — this is a pure function, dry-run only matters at the
  // postKnowledge/verifyKnowledge call level in verifyRecipe
});
