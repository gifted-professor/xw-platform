fetch("http://127.0.0.1:17930/api/knowledge", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    id: "scout-finding-recipe-classification-missing",
    app: "xhs",
    category: "pitfall",
    title: "[scout-finding] recipe 可执行性分类缺失，P1 路径无数据",
    content: `§10-3 实测发现：知识库 3 条 recipe（comment-cap-one-per-loop, watcher-fail-closed-runid, primitive-timeout-90s）全部为规则型（运维约束/配置建议），没有步骤型可回放 recipe。同时这些 recipe 的 ID 不匹配任何 capability ID，导致 P1 目标选择返回空集。P2（xiaowei.lab.raw, E1/R1, 无 recipe）是唯一活跃路径。

根因：
1. 现有 recipe 是全局运维笔记，不是能力级 procedure（如 "comment-cap 必须为 1"）
2. selectTarget 的 P1 逻辑假设 recipe.id == capability.id，但运维 recipe 不满足这个映射
3. 全部 3 条 recipe 被 classifyRecipe 判定为 rule-type（无 steps 数组，内容不包含 serve action 关键词）

建议：
- P1 应扩展为：recipe 的 content/app 字段关联到某 capability（不仅是 ID 精确匹配）
- 或新建一个 recipe→capability 映射表（recipe 的 appliesTo 字段）
- 步骤型 recipe 需要显式 steps 数组格式（[{action, params, expect}]）
- scout 当前行为正确：rule-type 记录观测、不 flag-engineer、不编造验证结果`,
    scope: "global",
    verifiedBy: [],
    needsEngineer: false,
  }),
  signal: AbortSignal.timeout(10000),
})
  .then((r) => r.json())
  .then((d) => console.log("OK:", d.ok, d.knowledge?.id || ""))
  .catch((e) => console.error("ERR:", e.message));
