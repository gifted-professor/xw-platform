// scout/scout.mjs — Phase 4 exploration agent (scout) runner
// Design doc: docs/plans/2026-07-24-phase4-探索agent设计.md
// Constraints (§7):
//   - NEVER call /approve (R2+ jobs submitted and left pending)
//   - fail-closed: stop and restore on any unexpected state
//   - session lease: acquire before device ops, always release
//   - scene restore: backToFeed + restoreIme after every round
//   - collision: if lease unavailable → switch device or end round
//   - one primary capability target per round; same-page probes allowed

import { argv, exit, env } from "node:process";

// ─── Configuration ──────────────────────────────────────────────────────────

const CONTROL  = env.SCONTROL_URL  || "http://127.0.0.1:17920";
const REGISTRY = env.SREGISTRY_URL || "http://127.0.0.1:17930";
const ACTOR    = env.SACTOR        || "scout-hermes-v1";

// ─── HTTP helpers ────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function httpPost(url, body, timeoutMs = 60_000) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function httpGet(url, timeoutMs = 15_000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  return res.json();
}

// ─── Control-plane / registry clients ────────────────────────────────────────

async function getDevices() {
  const data = await httpGet(`${REGISTRY}/api/devices`);
  return data.devices || [];
}

async function getKnowledge(app, category) {
  const url = category
    ? `${REGISTRY}/api/knowledge?app=${app}&category=${category}`
    : `${REGISTRY}/api/knowledge?app=${app}`;
  const data = await httpGet(url);
  return data.knowledge || data.items || [];
}

async function postKnowledge(entry) {
  return httpPost(`${REGISTRY}/api/knowledge`, entry);
}

async function verifyKnowledge(id) {
  return httpPost(`${REGISTRY}/api/knowledge/${id}/verify`, { actor: ACTOR });
}

async function flagEngineerKnowledge(id) {
  return httpPost(`${REGISTRY}/api/knowledge/${id}/flag-engineer`, {
    actor: ACTOR,
    reason: "scout: two consecutive failures on same step",
  });
}

async function getCapabilities() {
  const data = await httpGet(`${CONTROL}/control/v1/capabilities`);
  return data.capabilities || [];
}

async function acquireSession(deviceId, capability) {
  return httpPost(`${CONTROL}/control/v1/sessions`, {
    actorId: ACTOR,
    capabilityId: capability,
    deviceId,
    canary: true,
  });
}

async function releaseSession(sessionId, token) {
  return httpPost(`${CONTROL}/control/v1/sessions/${sessionId}/release`, {
    actorId: ACTOR,
    token,
  });
}

// ─── Serve helpers (fast-operator on device) ─────────────────────────────────

function servePort(device) {
  // 01→17895  04→17896  02→17897
  const map = { "01": 17895, "04": 17896, "02": 17897 };
  return map[device.alias] || 17896;
}

function serveUrl(device) {
  return `http://127.0.0.1:${servePort(device)}/x`;
}

async function serve(device, action, params = {}, timeoutMs = 60_000) {
  return httpPost(serveUrl(device), { action, ...params }, timeoutMs);
}

async function restoreScene(device) {
  log("restoring scene: backToFeed + restoreIme");
  await serve(device, "backToFeed", { maxBack: 5 }).catch(() => {});
  await sleep(1200);
  await serve(device, "restoreIme").catch(() => {});
}

// ─── Device selection (§4-1) ────────────────────────────────────────────────

async function selectDevice(pitfalls) {
  const devices = await getDevices();
  const available = devices.filter(
    (d) =>
      d.control?.online &&
      !d.control?.quarantined &&
      !d.control?.lease &&
      !d.control?.identityStale
  );
  if (!available.length) return null;

  // Prefer devices without known pitfall issues; prefer 01 (most reliable)
  const pitfallDevices = new Set(
    pitfalls
      .filter((p) => p.scope?.startsWith("device:"))
      .map((p) => p.scope.split(":")[1])
  );

  available.sort((a, b) => {
    const pa = pitfallDevices.has(a.serial) ? 1 : 0;
    const pb = pitfallDevices.has(b.serial) ? 1 : 0;
    return pa - pb || a.alias.localeCompare(b.alias);
  });

  return available[0];
}

// ─── Target selection (§4-2, v2.1 P0/P1/P2) ─────────────────────────────────

/**
 * Classify a recipe as step-type (replayable) or rule-type (operational constraint).
 * Step-type: has a `steps` array with action/params entries.
 * Rule-type: operational guidance without replayable steps — verify by checking
 * if the constraint still holds in code/config, or leave unverified.
 */
function classifyRecipe(recipe) {
  if (recipe.steps && Array.isArray(recipe.steps) && recipe.steps.length > 0) {
    return "step";
  }
  // Heuristic: content mentions concrete serve actions → step; otherwise → rule
  const content = (recipe.content || "").toLowerCase();
  const serveActions = ["focus", "dump", "backtofeed", "opencard", "tap", "scroll", "inputtext"];
  if (serveActions.some((a) => content.includes(a))) return "step";
  return "rule";
}

function selectTarget(capabilities, allKnowledge, filter) {
  const recipes = allKnowledge.filter((k) => k.category === "recipe");
  const verifiedIds = new Set(
    recipes.filter((r) => r.verifiedBy && r.verifiedBy.length > 0).map((r) => r.id)
  );
  const unverifiedRecipes = recipes.filter(
    (r) => !r.verifiedBy || r.verifiedBy.length === 0
  );

  // Build lookup: capabilityId → recipe (for P0/P1 matching)
  const recipeByCapId = new Map();
  for (const r of recipes) {
    recipeByCapId.set(r.id, r);
  }

  // P0: E0/E1 + has recipe (any verification status)
  // P1: any maturity + recipe + verifiedBy=[] (verification backlog)
  // P2: E0/E1 + no recipe (pure exploration)
  const candidates = [];

  for (const cap of capabilities) {
    if (cap.automationPolicy?.mode === "disabled") continue;
    const isLowMaturity = cap.maturity === "E0" || cap.maturity === "E1";
    const recipe = recipeByCapId.get(cap.id);
    const isUnverified = recipe && (!recipe.verifiedBy || recipe.verifiedBy.length === 0);

    let priority;
    if (isLowMaturity && recipe) priority = 0;       // P0
    else if (isUnverified) priority = 1;             // P1
    else if (isLowMaturity && !recipe) priority = 2;  // P2
    else continue; // E2+ with verified recipe, or no recipe — scout skips

    const recipeType = recipe ? classifyRecipe(recipe) : null;
    const risk = { R0: 0, R1: 1, R2: 2, R3: 3 };

    candidates.push({
      capability: cap,
      recipe,
      priority,
      recipeType,
      riskRank: risk[cap.risk] ?? 9,
    });
  }

  if (filter) {
    const re = new RegExp(filter, "i");
    candidates.splice(
      0,
      candidates.length,
      ...candidates.filter(
        (c) =>
          re.test(c.capability.id) ||
          re.test(c.capability.appId) ||
          re.test(c.capability.description || "")
      )
    );
  }

  // Sort: priority → R0 first → has recipe first → alphabetical
  candidates.sort(
    (a, b) =>
      a.priority - b.priority ||
      a.riskRank - b.riskRank ||
      (a.recipe ? 0 : 1) - (b.recipe ? 0 : 1) ||
      a.capability.id.localeCompare(b.capability.id)
  );

  if (!candidates.length) return null;
  const chosen = candidates[0];
  return {
    ...chosen.capability,
    _recipe: chosen.recipe || null,
    _recipeType: chosen.recipeType,
    _priority: chosen.priority,
  };
}

// ─── Recipe engine (§5) ──────────────────────────────────────────────────────

async function verifyRecipe(device, recipe, target) {
  const recipeType = target._recipeType || classifyRecipe(recipe);
  log(`recipe found: "${recipe.title}" (type=${recipeType}) — ${recipeType === "step" ? "replaying steps" : "rule-type, checking constraint"}`);

  if (recipeType === "rule") {
    // Rule-type: cannot replay. Record as observation, do NOT flag-engineer.
    // §4 v2.1: "查约束在代码/配置中是否仍成立，查不了就保持未验证，不得编造验证结果"
    log(`rule-type recipe: cannot replay — recording observation, leaving unverified`);
    await postKnowledge({
      id: `scout-observe-${recipe.id}-${Date.now()}`,
      app: target.appId,
      category: "pitfall",
      title: `[scout-observe] ${recipe.id} (rule-type, not replayable)`,
      content: `scout inspected recipe "${recipe.title}" but it is rule-type (no replayable steps). Constraint: ${recipe.content.slice(0, 200)}. Scout cannot verify this automatically — left unverified.`,
      scope: "global",
    });
    return { ok: null, reason: "rule_type_not_replayable" };
  }

  // Step-type: replay steps
  if (!recipe.steps || !Array.isArray(recipe.steps) || recipe.steps.length === 0) {
    log("step-type recipe but no steps array — recording pitfall");
    await postKnowledge({
      id: `${target.id}-no-steps-${Date.now()}`,
      app: target.appId,
      category: "pitfall",
      title: `recipe missing steps: ${target.id}`,
      content: `recipe ${recipe.id} classified as step-type but has no steps array`,
      scope: "global",
    });
    return { ok: false, reason: "no_steps" };
  }

  for (let i = 0; i < recipe.steps.length; i++) {
    const step = recipe.steps[i];
    log(`  step ${i + 1}/${recipe.steps.length}: ${step.action}(${JSON.stringify(step.params || {})})`);

    const r = await serve(device, step.action, step.params || {});
    if (!r.data?.ok || r.data?.result?.ok === false) {
      const failReason = r.data?.error || r.data?.result?.step || step.action;
      log(`  step ${i + 1} FAILED: ${failReason}`);

      await postKnowledge({
        id: `${target.id}-verify-fail-${Date.now()}`,
        app: target.appId,
        category: "pitfall",
        title: `recipe verify failed: ${target.id} step ${step.action}`,
        content: `step=${step.action} error=${failReason} recipe=${recipe.id}`,
        scope: "global",
      });
      await flagEngineerKnowledge(recipe.id);
      return { ok: false, reason: failReason, failedStep: i + 1 };
    }
    log(`  step ${i + 1} OK`);
  }

  await verifyKnowledge(recipe.id);
  log(`recipe verified: ${recipe.id}`);
  return { ok: true };
}

// ─── Exploration mode (§6) ───────────────────────────────────────────────────

async function exploreFresh(device, target, pitfalls) {
  log("exploring fresh (§6 not yet implemented — dry-run scope only)");

  // §6-1: build scope
  const scope = {
    app: target.appId,
    capability: target.id,
    serial: device.serial,
    alias: device.alias,
    label: device.label,
    startedAt: new Date().toISOString(),
    safety: "read-only + reversible navigation only",
    forbidden: "publish, follow, send, delete, pay, account change",
    stopConditions: [
      "verification step fails",
      "two consecutive blockers on same step (different approaches)",
      "login wall / CAPTCHA / risk control popup",
    ],
  };

  log(`scope: ${JSON.stringify(scope, null, 2)}`);

  // §6-3: single-step probe — focus + dump as starting point
  const focus = await serve(device, "focus");
  const pkg = focus.data?.result?.package;
  const activity = focus.data?.result?.activity || "";

  log(`focus: package=${pkg} activity=${activity}`);

  // Check for unexpected state (login wall, CAPTCHA, etc.) → §6-6
  if (pkg && !pkg.includes(target.packageName?.split(".")?.[1] || "xhs")) {
    log("unexpected app in foreground — aborting, restoring scene");
    await restoreScene(device);
    return { ok: false, reason: "unexpected_app", pkg };
  }

  const dump = await serve(device, "dump");
  const labels = dump.data?.result?.labels || dump.data?.result?.nodes?.length || 0;
  log(`dump: ${typeof labels === "number" ? labels + " nodes" : JSON.stringify(labels).slice(0, 200)}`);

  await postKnowledge({
    id: `scout-explore-${target.id}-${Date.now()}`,
    app: target.appId,
    category: "pitfall",
    title: `[scout-scope] ${target.id}`,
    content: JSON.stringify({ ...scope, focus: { pkg, activity }, dumpResult: labels }),
    scope: `device:${device.serial}`,
  });

  return { ok: true, phase: "scope_recorded" };
}

// ─── Logging ─────────────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

// ─── Scout main loop (§4) ────────────────────────────────────────────────────

async function run({ maxRounds = 1, capabilityFilter = null } = {}) {
  const summary = { rounds: [], totalKnowledge: 0 };

  for (let round = 0; round < maxRounds; round++) {
    log(`\n=== Round ${round + 1}/${maxRounds} ===`);

    // §4-1: Select device
    const allPitfalls = await getKnowledge("xhs", "pitfall").catch(() => []);
    const device = await selectDevice(allPitfalls);
    if (!device) {
      log("no available device (all busy/offline/quarantined) — ending round");
      summary.rounds.push({ round: round + 1, status: "no_device" });
      break;
    }
    log(`selected device: ${device.alias} (${device.label}) [${device.serial}]`);

    // §4-2: Inventory capabilities + P0/P1/P2 target selection
    const allCaps = await getCapabilities();
    const allKnowledge = await getKnowledge("xhs").catch(() => []);
    const target = selectTarget(allCaps, allKnowledge, capabilityFilter);
    if (!target) {
      log("no scoutable capability found — ending round");
      summary.rounds.push({ round: round + 1, status: "no_capability", device: device.alias });
      break;
    }
    log(`target capability: ${target.id} (${target.maturity}/${target.risk}) P${target._priority} recipeType=${target._recipeType || "none"}`);

    let roundResult = { round: round + 1, device: device.alias, capability: target.id, status: "pending" };

    try {
      // §7-3: Acquire session lease
      const sessionRes = await acquireSession(device.control.deviceId, target.id);
      if (sessionRes.status === 423) {
        log("device busy (423) — collision, switching device next round");
        roundResult.status = "collision_423";
        summary.rounds.push(roundResult);
        continue;
      }
      if (sessionRes.status !== 201 || !sessionRes.data?.session?.sessionId) {
        log(`session acquire failed (${sessionRes.status}) — ending round`);
        roundResult.status = "session_failed";
        summary.rounds.push(roundResult);
        continue;
      }

      const { sessionId, token } = sessionRes.data.session;
      log(`session acquired: ${sessionId.slice(0, 12)}…`);

      try {
        // §4-3: Use recipe attached to target (from P0/P1/P2 selection)
        const recipe = target._recipe;

        if (recipe) {
          // §5: Re-run verification
          const result = await verifyRecipe(device, recipe, target);
          roundResult.status = result.ok === null ? "recipe_observed" : result.ok ? "recipe_verified" : "recipe_verify_failed";
          roundResult.reason = result.reason;
          roundResult.recipeType = target._recipeType;
          roundResult.samplePath = "serve-direct"; // §5: direct serve → knowledge only, not v1.3
          summary.totalKnowledge++;
        } else {
          // §6: Explore fresh
          const result = await exploreFresh(device, target, allPitfalls);
          roundResult.status = result.ok ? "explored" : "explore_failed";
          roundResult.reason = result.reason;
          summary.totalKnowledge++;
        }
      } finally {
        // §7-4: Always restore scene and release session
        await restoreScene(device);
        await releaseSession(sessionId, token).catch((e) =>
          log(`session release warning: ${e.message}`)
        );
        log("session released, scene restored");
      }
    } catch (err) {
      log(`round error: ${err.message}`);
      roundResult.status = "error";
      roundResult.error = err.message;
      // §7-2: fail-closed — try to restore even on error
      await restoreScene(device).catch(() => {});
    }

    summary.rounds.push(roundResult);
    log(`round ${round + 1} result: ${roundResult.status}`);
  }

  return summary;
}

// ─── CLI entry point ─────────────────────────────────────────────────────────

const isDirectRun =
  import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` ||
  import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, "/") || "__never__");

if (isDirectRun) {
  const args = argv.slice(2);
  const maxRounds = Number(args.find((a) => /^\d+$/.test(a)) || 1);
  const filterIdx = args.indexOf("--filter");
  const capabilityFilter = filterIdx >= 0 ? args[filterIdx + 1] : null;
  const dryRun = args.includes("--dry-run");

  log(`scout starting (actor=${ACTOR}, rounds=${maxRounds}, filter=${capabilityFilter || "none"}, dryRun=${dryRun})`);

  run({ maxRounds, capabilityFilter })
    .then(async (summary) => {
      log(`\n=== Summary ===`);
      log(`rounds: ${summary.rounds.length} | knowledge entries: ${summary.totalKnowledge}`);
      for (const r of summary.rounds) {
        log(`  round ${r.round}: ${r.device || "—"} / ${r.capability || "—"} → ${r.status}${r.reason ? ` (${r.reason})` : ""}${r.recipeType ? ` [${r.recipeType}]` : ""}${r.samplePath ? ` sample=${r.samplePath}` : ""}`);
      }
      log("scout done.");
    })
    .catch((err) => {
      log(`FATAL: ${err.message}`);
      console.error(err.stack);
      exit(1);
    });
}

export { run, selectDevice, selectTarget };
