#!/usr/bin/env node
/**
 * xw-skills.mjs — read-only /xw skills catalog
 * (capabilities + recipes + workflows + foundation)
 *
 *   node ops/xw-skills.mjs [filter] [--all] [--json]
 *   node ops/xw-skills.mjs --self-test
 *
 * Default: formal capabilities + implemented recipes + discoverable foundations.
 * Workflows with directRun=false (e.g. canary_only) appear only with --all.
 * --all: also candidate / canary_only / degraded / other non-retired recipes,
 *        non-runnable capabilities, and non-direct workflows.
 *
 * Never touches devices, jobs, sessions, or control.db.
 * Console: use console.log only (Windows bridge constraint).
 */

import { loadFoundationCapabilities } from "../scripts/lib/foundation-capabilities.mjs";
import { loadWorkflows, workflowIsDirectlyRunnable } from "../scripts/lib/workflow-catalog.mjs";

const REGISTRY = (process.env.XHS_REGISTRY_URL || "http://127.0.0.1:17930").replace(/\/$/, "");

const APP_LABELS = Object.freeze({
  xhs: "小红书",
  xianyu: "闲鱼",
  douyin: "抖音",
  wechat: "微信",
  weigou: "微购",
  xiaowei: "小薇",
  vision: "视觉",
  foundation: "跨 App 基础能力",
  unknown: "未分类",
});

const RECIPE_ALL_EXCLUDE = Object.freeze(new Set(["retired"]));

function parseArgs(argv) {
  const out = { _: [], all: false, json: false, selfTest: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all") out.all = true;
    else if (a === "--json") out.json = true;
    else if (a === "--self-test") out.selfTest = true;
    else if (a.startsWith("--")) {
      console.log(`Usage: node ops/xw-skills.mjs [filter] [--all] [--json]\n       node ops/xw-skills.mjs --self-test`);
      process.exit(2);
    } else out._.push(a);
  }
  return out;
}

async function fetchJson(path) {
  const url = `${REGISTRY}${path}`;
  const res = await globalThis.fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`GET ${path} → HTTP ${res.status}`);
  }
  return res.json();
}

async function loadFoundationCatalog() {
  try {
    const payload = await fetchJson("/api/foundation-capabilities");
    if (!Array.isArray(payload?.capabilities)) throw new Error("foundation API shape invalid");
    return { capabilities: payload.capabilities, source: "live_registry" };
  } catch {
    // Compatibility during a registry reload window: the same versioned catalog
    // remains readable locally, so /xw skills never hides an already registered
    // foundation merely because the old process has not reloaded yet.
    return { capabilities: loadFoundationCapabilities(), source: "local_versioned_catalog" };
  }
}

async function loadWorkflowCatalog() {
  try {
    const payload = await fetchJson("/api/workflows?includeAll=1");
    if (!Array.isArray(payload?.workflows)) throw new Error("workflow API shape invalid");
    return { workflows: payload.workflows, source: "live_registry" };
  } catch {
    return { workflows: loadWorkflows(), source: "local_versioned_catalog" };
  }
}

function classifyWorkflow(workflow) {
  if (workflowIsDirectlyRunnable(workflow)) {
    return { bucket: "runnable", reason: "workflow · implemented" };
  }
  const status = String(workflow.status || workflow.maturity || "unknown");
  if (status === "canary_only" || workflow.maturity === "canary_only") {
    return { bucket: "unavailable", reason: "workflow · canary_only（非 production）" };
  }
  if (status === "candidate") {
    return { bucket: "unavailable", reason: "workflow · candidate" };
  }
  if (status === "disabled" || status === "retired") {
    return { bucket: "unavailable", reason: `workflow · ${status}` };
  }
  return {
    bucket: "unavailable",
    reason: workflow.directRun === false
      ? `workflow · ${status || "not_direct_run"}`
      : `workflow · ${status || "unknown"}`,
  };
}

function appLabel(appId) {
  const key = String(appId || "unknown").toLowerCase();
  return APP_LABELS[key] || key;
}

function readyFreeAliases(entry) {
  const devices = Array.isArray(entry?.devices) ? entry.devices : [];
  return devices
    .filter((d) => d?.state?.ready === true && d?.state?.leaseFree === true)
    .map((d) => String(d.alias));
}

function activeBlockerText(entry, capabilityId) {
  const blockers = Array.isArray(entry?.blockers) ? entry.blockers : [];
  const hits = [];
  for (const b of blockers) {
    const text = String(b?.summary || b?.title || b?.id || "").trim();
    const ids = [
      ...(Array.isArray(b?.capabilityIds) ? b.capabilityIds : []),
      ...(Array.isArray(b?.capabilities) ? b.capabilities : []),
      b?.capabilityId,
    ]
      .filter(Boolean)
      .map(String);
    if (!ids.length || ids.includes(capabilityId)) {
      if (text) hits.push(text);
    }
  }
  return hits[0] || null;
}

function classifyCapability(cap, readyAliases, entry) {
  const eligible = Array.isArray(cap.eligibleAliases) ? cap.eligibleAliases.map(String) : [];
  const readyEligible = eligible.filter((a) => readyAliases.includes(a));
  const policy = cap.policy || {};
  const blocker = activeBlockerText(entry, cap.id);

  if (policy.disabled || policy.labOnly) {
    return { bucket: "unavailable", reason: policy.labOnly ? "仅 lab" : "已禁用", devices: eligible };
  }
  if (blocker) {
    return { bucket: "unavailable", reason: blocker, devices: eligible };
  }
  if (policy.approvalRequired || policy.externalEffect) {
    return {
      bucket: "confirm",
      reason: policy.externalEffect ? "外部效果/需审批" : "需确认",
      devices: readyEligible.length ? readyEligible : eligible,
    };
  }
  if (policy.canaryRequired || policy.runnableAsCanarySession) {
    return { bucket: "unavailable", reason: "仅 canary", devices: eligible };
  }
  if (!policy.runnableAsJob) {
    return {
      bucket: "unavailable",
      reason: `availability=${policy.availability || "unknown"}`,
      devices: eligible,
    };
  }
  if (!readyEligible.length) {
    return {
      bucket: "unavailable",
      reason: eligible.length ? "无 ready/free 合格设备" : "无 eligible 设备",
      devices: eligible,
    };
  }
  return { bucket: "runnable", reason: "可直接运行", devices: readyEligible };
}

function classifyRecipe(recipe, includeAll) {
  const status = String(recipe.status || "");
  if (status === "implemented") {
    return { bucket: "runnable", reason: "recipe · implemented", status };
  }
  if (!includeAll) return null;
  if (RECIPE_ALL_EXCLUDE.has(status)) return null;
  if (status === "canary_only") {
    return { bucket: "unavailable", reason: "recipe · canary_only", status };
  }
  if (status === "degraded") {
    return { bucket: "unavailable", reason: "recipe · degraded", status };
  }
  if (status === "candidate" || status === "observed" || status === "replay_verified" || status === "promotable") {
    return { bucket: "unavailable", reason: `recipe · ${status}`, status };
  }
  return { bucket: "unavailable", reason: `recipe · ${status || "unknown"}`, status };
}

function recipeTitle(recipe) {
  const spec = recipe.spec || {};
  const aliases = Array.isArray(spec.intentAliases) ? spec.intentAliases.filter(Boolean) : [];
  if (aliases.length) return String(aliases[0]);
  return String(recipe.recipeId || "recipe");
}

function recipeAppId(recipe) {
  return recipe.spec?.appId || recipe.appId || "unknown";
}

function capabilityTitle(cap) {
  if (typeof cap.description === "string" && cap.description.trim()) return cap.description.trim();
  return String(cap.id || "capability");
}

function matchesFilter(filter, { appId, id, title, aliases }) {
  if (!filter) return true;
  const q = filter.toLowerCase();
  const hay = [
    appId,
    id,
    title,
    APP_LABELS[String(appId || "").toLowerCase()],
    ...(Array.isArray(aliases) ? aliases : []),
  ]
    .filter(Boolean)
    .map((s) => String(s).toLowerCase());
  if (/^\d{2}$/.test(filter)) {
    // alias filter applied later via devices list on the row
    return true;
  }
  return hay.some((h) => h.includes(q));
}

function classifyFoundation(item, caps, readyAliases) {
  const requiredCapabilityId = (item.requires || []).find((id) =>
    caps.capabilities.some((capability) => capability.id === id),
  );
  const dependency = requiredCapabilityId
    ? caps.capabilities.find((capability) => capability.id === requiredCapabilityId)
    : null;
  const eligible = Array.isArray(dependency?.eligibleAliases) ? dependency.eligibleAliases.map(String) : [];
  const devices = eligible.filter((alias) => readyAliases.includes(alias));
  if (item.status !== "implemented") {
    return { bucket: "unavailable", reason: `foundation · ${item.status}`, devices: eligible };
  }
  if (!item.directRun) {
    return {
      bucket: "runnable",
      reason: item.executionStatus === "canary_only"
        ? "编排可用；定位已实现，实点仅 canary"
        : "编排可用",
      devices: devices.length ? devices : eligible,
    };
  }
  return devices.length
    ? { bucket: "runnable", reason: "可直接运行", devices }
    : { bucket: "unavailable", reason: "无 ready/free 合格设备", devices: eligible };
}

function statusLabel(bucket, reason) {
  if (bucket === "runnable") return "可直接运行";
  if (bucket === "confirm") return "需确认";
  return reason ? `暂不可用 — ${reason}` : "暂不可用";
}

function formatDevices(devices) {
  if (!devices?.length) return "无设备";
  return `设备 ${devices.join("/")}`;
}

async function loadCatalog({ all }) {
  const recipesPath = all
    ? "/api/recipes?includeAll=1"
    : "/api/recipes?status=implemented";
  const [caps, recipes, entry, foundationCatalog, workflowCatalog] = await Promise.all([
    fetchJson("/api/capabilities"),
    fetchJson(recipesPath),
    fetchJson("/api/agent-entry"),
    loadFoundationCatalog(),
    loadWorkflowCatalog(),
  ]);
  if (!caps?.ok && caps?.ok !== undefined) {
    // older shape may omit ok; only fail if capabilities missing
  }
  if (!Array.isArray(caps?.capabilities)) {
    throw new Error("capabilities catalog unreadable");
  }
  if (!Array.isArray(recipes?.recipes)) {
    throw new Error("recipes catalog unreadable");
  }
  if (!entry?.ok && !Array.isArray(entry?.devices)) {
    throw new Error("agent-entry unreadable");
  }
  return {
    caps,
    recipes,
    entry,
    foundations: foundationCatalog.capabilities,
    foundationSource: foundationCatalog.source,
    workflows: workflowCatalog.workflows,
    workflowSource: workflowCatalog.source,
  };
}

function buildRows({ caps, recipes, entry, foundations = [], workflows = [], all, filter }) {
  const readyAliases = readyFreeAliases(entry);
  const aliasFilter = filter && /^\d{2}$/.test(filter) ? filter : null;
  const rows = [];

  for (const item of foundations) {
    const cls = classifyFoundation(item, caps, readyAliases);
    if (!all && cls.bucket !== "runnable") continue;
    if (!matchesFilter(filter, {
      appId: "foundation",
      id: item.id,
      title: item.title,
      aliases: [
        ...(item.intentAliases || []),
        ...(item.compatibleApps || []).flatMap((appId) => [appId, appLabel(appId)]),
        ...(item.provides || []),
      ],
    })) continue;
    if (aliasFilter && !cls.devices.includes(aliasFilter)) continue;
    rows.push({
      kind: "foundation",
      appId: "foundation",
      id: item.id,
      title: item.title,
      bucket: cls.bucket,
      reason: cls.reason,
      devices: cls.devices,
      statusLabel: cls.reason,
      compatibleApps: item.compatibleApps,
      provides: item.provides,
      requires: item.requires,
      directRun: item.directRun,
      entry: item.entry,
    });
  }

  for (const cap of caps.capabilities) {
    const cls = classifyCapability(cap, readyAliases, entry);
    if (!all && cls.bucket !== "runnable") continue;
    const title = capabilityTitle(cap);
    if (
      !matchesFilter(filter, {
        appId: cap.appId,
        id: cap.id,
        title,
        aliases: [],
      })
    ) {
      continue;
    }
    if (aliasFilter && !(cls.devices || []).includes(aliasFilter) && !(cap.eligibleAliases || []).includes(aliasFilter)) {
      continue;
    }
    rows.push({
      kind: "capability",
      appId: cap.appId || "unknown",
      id: cap.id,
      title,
      bucket: cls.bucket,
      reason: cls.reason,
      devices: cls.devices,
      statusLabel: statusLabel(cls.bucket, cls.reason),
    });
  }

  for (const recipe of recipes.recipes) {
    const cls = classifyRecipe(recipe, all);
    if (!cls) continue;
    if (!all && cls.bucket !== "runnable") continue;
    const title = recipeTitle(recipe);
    const appId = recipeAppId(recipe);
    const aliases = Array.isArray(recipe.spec?.intentAliases) ? recipe.spec.intentAliases : [];
    if (!matchesFilter(filter, { appId, id: recipe.recipeId, title, aliases })) continue;
    const capId = recipe.spec?.executor?.capabilityId || null;
    const cap = caps.capabilities.find((c) => c.id === capId);
    let devices = cap?.eligibleAliases || [];
    if (cls.bucket === "runnable" && cap) {
      const capCls = classifyCapability(cap, readyAliases, entry);
      devices = capCls.devices;
      if (capCls.bucket !== "runnable") {
        cls.bucket = capCls.bucket === "confirm" ? "confirm" : "unavailable";
        cls.reason = `底层 ${capCls.reason}`;
      }
    }
    if (aliasFilter && !devices.includes(aliasFilter) && !(cap?.eligibleAliases || []).includes(aliasFilter)) {
      continue;
    }
    if (!all && cls.bucket !== "runnable") continue;
    rows.push({
      kind: "recipe",
      appId,
      id: `${recipe.recipeId}@${recipe.revision ?? 1}`,
      recipeId: recipe.recipeId,
      revision: recipe.revision,
      recipeStatus: recipe.status,
      title,
      bucket: cls.bucket,
      reason: cls.reason,
      devices,
      statusLabel: statusLabel(cls.bucket, cls.reason),
      capabilityId: capId,
    });
  }

  for (const workflow of workflows) {
    const cls = classifyWorkflow(workflow);
    if (!all && cls.bucket !== "runnable") continue;
    const title = workflow.title || workflow.workflowId;
    const aliases = Array.isArray(workflow.intentAliases) ? workflow.intentAliases : [];
    if (!matchesFilter(filter, {
      appId: workflow.appId,
      id: workflow.workflowId,
      title,
      aliases,
    })) continue;
    const devices = Array.isArray(workflow.placement?.fixedAliases)
      ? workflow.placement.fixedAliases.filter((alias) => readyAliases.includes(alias))
      : readyAliases;
    if (aliasFilter && !(workflow.placement?.fixedAliases || []).includes(aliasFilter) && !devices.includes(aliasFilter)) {
      continue;
    }
    rows.push({
      kind: "workflow",
      appId: workflow.appId || "unknown",
      id: workflow.workflowId,
      workflowId: workflow.workflowId,
      title,
      bucket: cls.bucket,
      reason: cls.reason,
      devices: devices.length ? devices : (workflow.placement?.fixedAliases || []),
      statusLabel: statusLabel(cls.bucket, cls.reason),
      capabilityId: workflow.capabilityId,
      entry: workflow.entry,
      maturity: workflow.maturity,
      tapAuthorized: workflow.tapAuthorized === true,
      directRun: workflow.directRun === true,
    });
  }

  const kindOrder = { capability: 0, recipe: 1, workflow: 2, foundation: 3 };
  rows.sort((a, b) => {
    const appCmp = String(a.appId).localeCompare(String(b.appId));
    if (appCmp) return appCmp;
    const kindCmp = (kindOrder[a.kind] ?? 9) - (kindOrder[b.kind] ?? 9);
    if (kindCmp) return kindCmp;
    return String(a.id).localeCompare(String(b.id));
  });
  return { rows, readyAliases };
}

function renderText(rows, { all, filter, readyAliases }) {
  const lines = [];
  if (!rows.length) {
    lines.push(filter ? `无匹配项（filter=${filter}${all ? ", --all" : ""}）` : "当前没有可直接运行的能力或 implemented recipe");
    lines.push("提示：/xw skills --all 查看候选/canary/degraded；/xw explore 探索未知面");
    return lines.join("\n");
  }

  let currentApp = null;
  for (const row of rows) {
    if (row.appId !== currentApp) {
      currentApp = row.appId;
      lines.push(appLabel(currentApp));
    }
    const kindTag = row.kind === "recipe"
      ? "recipe"
      : row.kind === "foundation"
        ? "foundation"
        : row.kind === "workflow"
          ? "workflow"
          : "capability";
    const idPart = row.kind === "recipe"
      ? `${row.recipeId} (${kindTag})`
      : row.kind === "foundation" || row.kind === "workflow"
        ? `${row.id} (${kindTag})`
        : row.id;
    lines.push(
      `- ${row.title} — ${row.statusLabel} — ${formatDevices(row.devices)} — ${idPart}`,
    );
  }

  const sample = rows.find((r) => r.bucket === "runnable" && r.kind !== "foundation") || rows[0];
  lines.push("");
  if (sample?.kind === "foundation") {
    lines.push(`提示：该项由 /xw task 与 /xw explore 自动依赖；诊断入口：${sample.entry}`);
  } else {
    lines.push(
      `提示：/xw run ${sample?.title || sample?.id || "看一下小红书首页"}` +
        (readyAliases.length ? `（ready/free: ${readyAliases.join("/")}` + (all ? "; --all" : "") + "）" : ""),
    );
  }
  return lines.join("\n");
}

async function cmdList(args) {
  const filter = args._[0] || null;
  const {
    caps,
    recipes,
    entry,
    foundations,
    foundationSource,
    workflows,
    workflowSource,
  } = await loadCatalog({ all: args.all });
  const { rows, readyAliases } = buildRows({
    caps,
    recipes,
    entry,
    foundations,
    workflows,
    all: args.all,
    filter,
  });
  if (args.json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          filter,
          all: args.all,
          readyAliases,
          count: rows.length,
          capabilities: caps.count ?? caps.capabilities.length,
          recipes: recipes.count ?? recipes.recipes.length,
          foundations: foundations.length,
          foundationSource,
          workflows: workflows.length,
          workflowSource,
          items: rows,
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log(renderText(rows, { all: args.all, filter, readyAliases }));
}

async function cmdSelfTest() {
  const results = [];
  const note = (name, ok, detail = "") => {
    results.push({ name, ok, detail });
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  };
  try {
    const def = await loadCatalog({ all: false });
    note("fetch_default", Array.isArray(def.caps.capabilities) && Array.isArray(def.recipes.recipes));
    for (const r of def.recipes.recipes) {
      if (r.status !== "implemented") throw new Error(`default recipes must be implemented, got ${r.status}`);
    }
    note("default_recipes_implemented_only", true, `n=${def.recipes.recipes.length}`);

    const all = await loadCatalog({ all: true });
    note("fetch_includeAll", Array.isArray(all.recipes.recipes));
    const retired = all.recipes.recipes.filter((r) => r.status === "retired");
    const { rows: defaultRows } = buildRows({ ...def, all: false, filter: null });
    const { rows: allRows } = buildRows({ ...all, all: true, filter: null });
    note(
      "all_includes_non_runnable_or_equal",
      allRows.length >= defaultRows.length,
      `default=${defaultRows.length} all=${allRows.length} retiredInApi=${retired.length}`,
    );
    // buildRows already drops retired when --all
    note(
      "all_excludes_retired_rows",
      !allRows.some((r) => r.kind === "recipe" && r.recipeStatus === "retired"),
    );
    note(
      "foundation_locator_discoverable",
      defaultRows.some((r) => r.kind === "foundation" && r.id === "locator.visual-block.v1"),
    );
    const { rows: xhsRows } = buildRows({ ...def, all: false, filter: "小红书" });
    note(
      "foundation_locator_discoverable_by_chinese_app",
      xhsRows.some((r) => r.kind === "foundation" && r.id === "locator.visual-block.v1"),
    );
    note(
      "workflow_catalog_loaded",
      Array.isArray(def.workflows) && def.workflows.some((w) => w.workflowId === "workflow.wechat.balance-read.v1"),
      `source=${def.workflowSource || "?"} n=${def.workflows?.length ?? 0}`,
    );
    note(
      "workflow_canary_hidden_by_default",
      !defaultRows.some((r) => r.kind === "workflow" && r.id === "workflow.wechat.balance-read.v1"),
    );
    note(
      "workflow_canary_visible_with_all",
      allRows.some((r) => r.kind === "workflow" && r.id === "workflow.wechat.balance-read.v1"),
    );
    note("render_smoke", typeof renderText(defaultRows, { all: false, filter: null, readyAliases: [] }) === "string");
  } catch (err) {
    note("self-test_aborted", false, err.message || String(err));
  }
  const failed = results.filter((r) => !r.ok);
  console.log(
    `XW_SKILLS_SELF_TEST summary pass=${results.filter((r) => r.ok).length} fail=${failed.length}`,
  );
  if (failed.length) process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) return cmdSelfTest();
  return cmdList(args);
}

main().catch((err) => {
  console.log(`XW_SKILLS_FAILED ${err?.message || String(err)}`);
  process.exit(1);
});
