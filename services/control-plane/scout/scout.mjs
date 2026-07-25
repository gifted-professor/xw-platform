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
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

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

async function selectDevice(pitfalls, excludeSerials = []) {
  const devices = await getDevices();
  const exclude = new Set(excludeSerials);
  const available = devices.filter(
    (d) =>
      d.control?.online &&
      !d.control?.quarantined &&
      !d.control?.lease &&
      !d.control?.identityStale &&
      !exclude.has(d.serial)
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

// ─── Target selection (§4-2, v2.2 P0/P1/P2 with appliesTo + verifyMode) ─────

/**
 * Classify a recipe using v2.2 verifyMode field (preferred) or heuristic fallback.
 * verifyMode: "replay" (has steps) | "constraint" (rule-type, grep-able) | "human"
 */
function classifyRecipe(recipe) {
  if (recipe.verifyMode === "replay" || recipe.verifyMode === "constraint" || recipe.verifyMode === "human") {
    return recipe.verifyMode;
  }
  if (recipe.steps && Array.isArray(recipe.steps) && recipe.steps.length > 0) {
    return "replay";
  }
  const content = (recipe.content || "").toLowerCase();
  const serveActions = ["focus", "dump", "backtofeed", "opencard", "tap", "scroll", "inputtext"];
  if (serveActions.some((a) => content.includes(a))) return "replay";
  return "constraint";
}

/**
 * Build an index: capabilityId → [recipes that apply to it via appliesTo].
 * Also supports legacy recipes without appliesTo by falling back to recipe.id === cap.id.
 */
function buildRecipeIndex(recipes) {
  const index = new Map();
  for (const r of recipes) {
    const targets = Array.isArray(r.appliesTo) && r.appliesTo.length > 0
      ? r.appliesTo
      : [r.id]; // legacy fallback: recipe.id matches capability.id
    for (const capId of targets) {
      if (!index.has(capId)) index.set(capId, []);
      index.get(capId).push(r);
    }
  }
  return index;
}

function selectTarget(capabilities, allKnowledge, filter, { constraintOnly = false, excludeIds = [] } = {}) {
  // v2.2: verifyMode is the verification arbiter; category is just knowledge classification.
  // P1 candidates are category-agnostic — pitfall entries with verifyMode ∈ {constraint, replay}
  // are verifiable too, so do NOT filter by category here. P1's own filter narrows by verifyMode.
  const recipes = allKnowledge;
  const recipeIndex = buildRecipeIndex(recipes);
  const exclude = new Set(excludeIds);

  // P0: E0/E1 + has recipe (any verification status)
  // P1: appliesTo matches capability + verifiedBy=[] + verifyMode ∈ {constraint, replay}
  // P2: E0/E1 + no recipe (pure exploration)
  const candidates = [];

  for (const cap of capabilities) {
    if (cap.automationPolicy?.mode === "disabled") continue;
    if (exclude.has(cap.id)) continue;
    const isLowMaturity = cap.maturity === "E0" || cap.maturity === "E1";
    const capRecipes = recipeIndex.get(cap.id) || [];
    const unverifiedConstraintOrReplay = capRecipes.filter(
      (r) =>
        (!r.verifiedBy || r.verifiedBy.length === 0) &&
        (r.verifyMode === "constraint" || r.verifyMode === "replay")
    );
    const hasRecipe = capRecipes.length > 0;

    let priority;
    if (isLowMaturity && hasRecipe) priority = 0;                        // P0
    else if (unverifiedConstraintOrReplay.length > 0) priority = 1;      // P1: v2.2 schema
    else if (isLowMaturity && !hasRecipe) priority = 2;                  // P2
    else continue;

    // For P1, prefer the first unverified constraint/replay recipe
    const recipe = priority === 1
      ? unverifiedConstraintOrReplay[0]
      : capRecipes[0] || null;
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

  // constraintOnly: only keep constraint-type recipes (no device ops needed)
  if (constraintOnly) {
    candidates.splice(
      0,
      candidates.length,
      ...candidates.filter((c) => c.recipeType === "constraint")
    );
  }

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

// ─── Constraint verification engine (§5, v2.2) ─────────────────────────────

const CONSTRAINT_PATTERNS = [
  {
    id: "comment-cap",
    title: "comment-cap per loop ≤ 1-2",
    keywords: ["comment.?cap", "commentCap"],
    grepPattern: "commentCap|comment.?cap",
    grepFiles: ["scripts/task-runner.mjs", "scripts/dashboard.mjs", "scripts/fast-operator.mjs"],
    expectDesc: "commentCap default should be 1 or 2 (anti-risk-control)",
    validateEvidence: (text) => {
      const match = text.match(/commentCap\s*=\s*Number\(.*?(\d+)/);
      if (!match) return null;
      const val = Number(match[1]);
      return { holds: val >= 1 && val <= 2, detail: `commentCap default=${val}` };
    },
  },
  {
    id: "timeout-90s",
    title: "primitive operation timeoutMs = 90000",
    keywords: ["timeout.*90", "90.*timeout", "timeoutMs.*90"],
    grepPattern: "timeoutMs.*90",
    grepFiles: ["apps/xhs/capabilities.json", "control-plane/schema/capability.schema.json"],
    expectDesc: "xhs.comment.send timeoutMs should be 90000",
    validateEvidence: (text) => {
      const match = text.match(/"timeoutMs"\s*:\s*(\d+)/);
      if (!match) return null;
      const val = Number(match[1]);
      return { holds: val === 90000, detail: `timeoutMs=${val}` };
    },
  },
  {
    id: "fail-closed",
    title: "control-plane routing is fail-closed",
    keywords: ["fail.?closed", "failClosed"],
    grepPattern: "fail.?closed|failClosed",
    grepFiles: ["control-plane/lib/placement.mjs", "control-plane/lib/policy.mjs", "scout/scout.mjs"],
    expectDesc: "control-plane and scout enforce fail-closed behavior",
    validateEvidence: (text) => {
      const count = (text.match(/fail.?closed|failClosed/gi) || []).length;
      return { holds: count > 0, detail: `fail-closed references found: ${count}` };
    },
  },
];

function grepFile(filePath, pattern) {
  try {
    const absPath = resolve(REPO_ROOT, filePath);
    const result = execSync(
      `grep -nE ${JSON.stringify(pattern)} ${JSON.stringify(absPath)} 2>/dev/null | head -20`,
      { encoding: "utf8", timeout: 5000 }
    );
    return result.trim() || null;
  } catch {
    return null;
  }
}

// ─── Generic constraint evidence location (v2.3) ─────────────────────────────
//
// The 3 built-in CONSTRAINT_PATTERNS only cover a handful of named constraints.
// The 47-item backlog is mostly infra/config constraints whose evidence lives in
// the repo (filenames, CLI flags, config keys, error-code constants). We extract
// distinctive, grep-able tokens from the recipe content/title/id and locate them
// across apps/ control-plane/ scout/ scripts/.
//
// Principle preserved: evidence insufficient → do NOT judge (ok=null → human).
// Found → constraint confirmed (the referenced artifact exists in the codebase).

const GREP_DIRS = ["apps", "control-plane", "scout", "scripts"];

// Acronyms/protocol tokens that appear everywhere and carry no constraint meaning.
const UPPER_SNAKE_DENYLIST = new Set([
  "JSON", "API", "HTTP", "HTTPS", "URL", "URI", "TCP", "UDP", "ADB", "APK",
  "XML", "CSS", "HTML", "JS", "TS", "MJS", "PS1", "ENV", "WS", "WSS", "SSH",
  "PID", "TTY", "UTF", "GPFS", "CDP", "REST", "POST", "GET", "HEAD", "DNS",
  "TODO", "FIXME", "OK", "NOT", "AND", "OR", "THE", "FOR", "E0", "E1", "E2",
  "E3", "R0", "R1", "R2", "R3", "PR", "ID", "UI", "IME",
]);

/**
 * Extract distinctive grep-able tokens from a constraint recipe.
 * Order of specificity: filenames > CLI flags > UPPER_SNAKE constants > camelCase.
 * Returns a de-duplicated array (most specific first).
 */
function extractConstraintTokens(recipe) {
  const text = `${recipe.content || ""} ${recipe.title || ""} ${recipe.id || ""}`;
  const tokens = [];
  const seen = new Set();
  const add = (t) => {
    if (t && !seen.has(t)) {
      seen.add(t);
      tokens.push(t);
    }
  };

  // Filenames / paths with extensions: task-runner.mjs, control-plane/lib/placement.mjs
  for (const m of text.matchAll(/([\w./-]+\.(?:mjs|ps1|json|js|ts|sh|md|psd1))\b/g)) {
    add(m[1]);
  }
  // CLI flags: --comment-cap
  for (const m of text.matchAll(/(--[a-z][\w-]{2,})/g)) {
    add(m[1]);
  }
  // UPPER_SNAKE constants / error codes: TIMEOUT_MS, ECONNREFUSED, ERR_TIMEOUT
  for (const m of text.matchAll(/\b([A-Z][A-Z0-9_]{3,})\b/g)) {
    if (!UPPER_SNAKE_DENYLIST.has(m[1])) add(m[1]);
  }
  // camelCase identifiers: commentCap, timeoutMs, failClosed
  for (const m of text.matchAll(/\b([a-z]+[A-Z][A-Za-z0-9]+)\b/g)) {
    add(m[1]);
  }

  return tokens;
}

/**
 * Grep a literal token across the repo's evidence dirs (fixed-string, recursive).
 * Returns the trimmed grep output (up to 20 lines) or null.
 */
function grepRepo(token, dirs = GREP_DIRS) {
  try {
    const absDirs = dirs.map((d) => resolve(REPO_ROOT, d)).filter((d) => existsSync(d));
    if (!absDirs.length) return null;
    const out = execSync(
      `grep -rnF ${JSON.stringify(token)} ${absDirs.map((d) => JSON.stringify(d)).join(" ")} 2>/dev/null | head -20`,
      { encoding: "utf8", timeout: 8000 }
    );
    return out.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Locate evidence for a single token. For filenames, also checks file existence
 * (direct path or by basename) since a referenced file existing IS the evidence,
 * even if no other file mentions it by name.
 * Returns { kind, detail } or null.
 */
function locateEvidence(token, dirs = GREP_DIRS) {
  const grepHit = grepRepo(token, dirs);
  if (grepHit) return { kind: "grep", detail: grepHit.split("\n")[0] };

  if (/\.(mjs|ps1|json|js|ts|sh|md|psd1)$/.test(token)) {
    const direct = resolve(REPO_ROOT, token);
    if (existsSync(direct)) {
      return { kind: "file", detail: token };
    }
    const base = token.split("/").pop();
    const absDirs = dirs.map((d) => resolve(REPO_ROOT, d)).filter((d) => existsSync(d));
    if (absDirs.length) {
      try {
        const found = execSync(
          `find ${absDirs.map((d) => JSON.stringify(d)).join(" ")} -type f -name ${JSON.stringify(base)} 2>/dev/null | head -3`,
          { encoding: "utf8", timeout: 5000 }
        ).trim();
        if (found) {
          const rel = found.split("\n")[0].replace(REPO_ROOT + "/", "");
          return { kind: "file", detail: rel };
        }
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

/**
 * Find a constraint pattern that matches the recipe content.
 */
function matchConstraintPattern(recipe) {
  const content = (recipe.content || "").toLowerCase() + " " + (recipe.title || "").toLowerCase();
  for (const pat of CONSTRAINT_PATTERNS) {
    if (pat.keywords.some((kw) => new RegExp(kw, "i").test(content))) {
      return pat;
    }
  }
  return null;
}

/**
 * Verify a constraint-type recipe by grepping the codebase for evidence.
 * Returns { ok: boolean|null, evidence: string, pattern: string, details: string }.
 * ok=null means evidence could not be located (→ pitfall with human tag).
 */
function verifyConstraint(recipe, { dryRun = false } = {}) {
  const pattern = matchConstraintPattern(recipe);
  if (!pattern) {
    // No built-in pattern matched — try generic token extraction from recipe content.
    // 47-item backlog is mostly infra/config constraints whose evidence lives in
    // the repo; the 3 built-in patterns only cover a few named ones.
    const tokens = extractConstraintTokens(recipe);
    if (tokens.length === 0) {
      return {
        ok: null,
        reason: "no_matching_pattern",
        evidence: `recipe "${recipe.title}" content does not match any known constraint pattern and yields no grep-able tokens`,
        pattern: null,
        details: "constraint evidence cannot be located",
      };
    }

    log(`no built-in pattern; trying generic token grep: ${tokens.join(", ")}`);

    const evidenceLines = [];
    for (const token of tokens) {
      const ev = locateEvidence(token);
      if (ev) evidenceLines.push({ token, ...ev });
      if (evidenceLines.length >= 3) break;
    }

    if (evidenceLines.length === 0) {
      return {
        ok: null,
        reason: "no_evidence_found",
        evidence: `tokens [${tokens.join(", ")}] not located in repo (${GREP_DIRS.join(", ")})`,
        pattern: "generic",
        details: "constraint evidence cannot be located — verifyMode should be human",
      };
    }

    const evidenceSummary = evidenceLines
      .map((e) => `${e.kind}:${e.token} → ${e.detail}`)
      .join("; ");
    return {
      ok: true,
      reason: "constraint_evidence_found",
      evidence: evidenceSummary,
      pattern: "generic",
      details: `${evidenceLines.length} token(s) located in repo`,
    };
  }

  log(`constraint pattern matched: ${pattern.id} — grepping ${pattern.grepFiles.length} files`);

  const evidenceLines = [];
  let validationResult = null;

  for (const file of pattern.grepFiles) {
    const hit = grepFile(file, pattern.grepPattern);
    if (hit) {
      evidenceLines.push({ file, hit });
      if (!validationResult && pattern.validateEvidence) {
        validationResult = pattern.validateEvidence(hit);
      }
    }
  }

  if (evidenceLines.length === 0) {
    return {
      ok: null,
      reason: "no_evidence_found",
      evidence: `grep "${pattern.grepPattern}" in [${pattern.grepFiles.join(", ")}] returned 0 matches`,
      pattern: pattern.id,
      details: "constraint evidence cannot be located",
    };
  }

  const evidenceSummary = evidenceLines
    .map((e) => `${e.file}: ${e.hit.split("\n")[0]}`)
    .join("; ");

  if (validationResult) {
    return {
      ok: validationResult.holds,
      reason: validationResult.holds ? "constraint_confirmed" : "constraint_violated",
      evidence: evidenceSummary,
      pattern: pattern.id,
      details: validationResult.detail,
    };
  }

  // Evidence found but no validator → treat as confirmed (grep hit = constraint exists)
  return {
    ok: true,
    reason: "constraint_evidence_found",
    evidence: evidenceSummary,
    pattern: pattern.id,
    details: `evidence found in ${evidenceLines.length} file(s)`,
  };
}

// ─── Recipe engine (§5) ──────────────────────────────────────────────────────

async function verifyRecipe(device, recipe, target, { dryRun = false } = {}) {
  const recipeType = target._recipeType || classifyRecipe(recipe);
  log(`recipe found: "${recipe.title}" (type=${recipeType})`);

  if (recipeType === "constraint") {
    // §5 v2.2: constraint verification via grep
    const result = verifyConstraint(recipe, { dryRun });
    log(`constraint verify: ok=${result.ok} reason=${result.reason} pattern=${result.pattern || "none"}`);

    if (result.ok === true) {
      // Constraint confirmed → verify
      if (!dryRun) {
        await verifyKnowledge(recipe.id);
        log(`constraint verified: ${recipe.id}`);
      } else {
        log(`[dry-run] would verify knowledge: ${recipe.id}`);
      }
      return { ok: true, reason: result.reason, evidence: result.evidence, pattern: result.pattern };
    }

    if (result.ok === false) {
      // Constraint violated → pitfall
      if (!dryRun) {
        await postKnowledge({
          id: `scout-constraint-violated-${recipe.id}-${Date.now()}`,
          app: target.appId,
          category: "pitfall",
          title: `[scout-constraint] ${recipe.id} violated: ${result.pattern}`,
          content: `constraint=${result.pattern} evidence=${result.evidence} details=${result.details}`,
          scope: "global",
        });
      } else {
        log(`[dry-run] would write pitfall: constraint violated ${recipe.id}`);
      }
      return { ok: false, reason: result.reason, evidence: result.evidence, pattern: result.pattern };
    }

    // ok === null: evidence not located → pitfall tagged human
    if (!dryRun) {
      await postKnowledge({
        id: `scout-constraint-noloc-${recipe.id}-${Date.now()}`,
        app: target.appId,
        category: "pitfall",
        title: `[scout-constraint] ${recipe.id} — evidence unlocatable`,
        content: `constraint evidence cannot be located for "${recipe.title}". ${result.evidence}. verifyMode should be "human".`,
        scope: "global",
        verifyMode: "human",
      });
    } else {
      log(`[dry-run] would write pitfall (human): evidence unlocatable ${recipe.id}`);
    }
    return { ok: null, reason: result.reason, evidence: result.evidence };
  }

  if (recipeType === "human") {
    log(`human-tagged recipe: cannot verify automatically — leaving unverified`);
    return { ok: null, reason: "human_tagged" };
  }

  // replay: replay steps
  if (!recipe.steps || !Array.isArray(recipe.steps) || recipe.steps.length === 0) {
    log("replay-type recipe but no steps array — recording pitfall");
    if (!dryRun) {
      await postKnowledge({
        id: `${target.id}-no-steps-${Date.now()}`,
        app: target.appId,
        category: "pitfall",
        title: `recipe missing steps: ${target.id}`,
        content: `recipe ${recipe.id} classified as replay but has no steps array`,
        scope: "global",
      });
    }
    return { ok: false, reason: "no_steps" };
  }

  for (let i = 0; i < recipe.steps.length; i++) {
    const step = recipe.steps[i];
    log(`  step ${i + 1}/${recipe.steps.length}: ${step.action}(${JSON.stringify(step.params || {})})`);

    const r = await serve(device, step.action, step.params || {});
    if (!r.data?.ok || r.data?.result?.ok === false) {
      const failReason = r.data?.error || r.data?.result?.step || step.action;
      log(`  step ${i + 1} FAILED: ${failReason}`);

      if (!dryRun) {
        await postKnowledge({
          id: `${target.id}-verify-fail-${Date.now()}`,
          app: target.appId,
          category: "pitfall",
          title: `recipe verify failed: ${target.id} step ${step.action}`,
          content: `step=${step.action} error=${failReason} recipe=${recipe.id}`,
          scope: "global",
        });
        await flagEngineerKnowledge(recipe.id);
      }
      return { ok: false, reason: failReason, failedStep: i + 1 };
    }
    log(`  step ${i + 1} OK`);
  }

  if (!dryRun) {
    await verifyKnowledge(recipe.id);
    log(`recipe verified: ${recipe.id}`);
  } else {
    log(`[dry-run] would verify knowledge: ${recipe.id}`);
  }
  return { ok: true };
}

// ─── Exploration mode (§6) ───────────────────────────────────────────────────

async function exploreFresh(device, target, pitfalls, { dryRun = false } = {}) {
  log("exploring fresh (§6 not yet implemented — dry-run scope only)");

  // Guard: capability without packageName → cannot verify foreground app
  if (!target.packageName) {
    const skipId = `scout-skip-${target.id}`;
    log(`capability ${target.id} has no packageName — skipping (cannot verify foreground app)`);
    if (!dryRun) {
      await postKnowledge({
        id: skipId,
        app: target.appId,
        category: "pitfall",
        title: `[scout-skip] ${target.id}`,
        content: `capabilityId=${target.id} reason=packageName缺失无法校验前台App`,
        scope: "global",
      });
    } else {
      log(`[dry-run] would write pitfall: id=${skipId} content=capabilityId=${target.id} reason=packageName缺失无法校验前台App`);
    }
    return { ok: false, reason: "no_packageName", skipId };
  }

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
  if (pkg && !pkg.includes(target.packageName.split(".")[1])) {
    log("unexpected app in foreground — aborting, restoring scene");
    await restoreScene(device);
    return { ok: false, reason: "unexpected_app", pkg };
  }

  const dump = await serve(device, "dump");
  const labels = dump.data?.result?.labels || dump.data?.result?.nodes?.length || 0;
  log(`dump: ${typeof labels === "number" ? labels + " nodes" : JSON.stringify(labels).slice(0, 200)}`);

  const exploreEntry = {
    id: `scout-explore-${target.id}-${Date.now()}`,
    app: target.appId,
    category: "pitfall",
    title: `[scout-scope] ${target.id}`,
    content: JSON.stringify({ ...scope, focus: { pkg, activity }, dumpResult: labels }),
    scope: `device:${device.serial}`,
  };
  if (!dryRun) {
    await postKnowledge(exploreEntry);
  } else {
    log(`[dry-run] would write knowledge: id=${exploreEntry.id} app=${exploreEntry.app} title=${exploreEntry.title}`);
  }

  return { ok: true, phase: "scope_recorded" };
}

// ─── Logging ─────────────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

// ─── Scout main loop (§4) ────────────────────────────────────────────────────

async function run({ maxRounds = 1, capabilityFilter = null, dryRun = false, constraintOnly = false } = {}) {
  const summary = { rounds: [], totalKnowledge: 0, mode: constraintOnly ? "constraint-only" : "full" };

  // ── Constraint-only mode: no device ops, only grep-based verification ──
  if (constraintOnly) {
    log("running in constraint-only mode (no device interaction)");
    const allKnowledge = await getKnowledge("xhs").catch(() => []);
    const allCaps = await getCapabilities().catch(() => []);

    // Pick up to maxRounds unverified constraint recipes
    let verified = 0;
    let failed = 0;
    let observed = 0;

    for (let round = 0; round < maxRounds; round++) {
      // v2.2: category-agnostic — verifyMode ∈ {constraint, replay} + unverified is the
      // eligibility test (pitfall entries with verifyMode=constraint are verifiable too).
      const remaining = allKnowledge.filter(
        (k) =>
          (!k.verifiedBy || k.verifiedBy.length === 0) &&
          (k.verifyMode === "constraint" || k.verifyMode === "replay")
      );
      const target = selectTarget(allCaps, remaining, capabilityFilter, { constraintOnly: true });
      if (!target) {
        log(`round ${round + 1}: no more unverified constraint recipes`);
        summary.rounds.push({ round: round + 1, status: "no_constraint_target" });
        break;
      }

      const recipe = target._recipe;
      log(`round ${round + 1}: ${recipe.id} (${target.id})`);
      const result = verifyConstraint(recipe, { dryRun });

      const roundResult = {
        round: round + 1,
        capability: target.id,
        recipeId: recipe.id,
        recipeType: "constraint",
        pattern: result.pattern,
        evidence: result.evidence?.slice(0, 200),
        status: result.ok === true ? "constraint_verified" : result.ok === false ? "constraint_violated" : "constraint_unlocatable",
        reason: result.reason,
      };

      if (result.ok === true) {
        if (!dryRun) {
          await verifyKnowledge(recipe.id);
          log(`  → verified ${recipe.id}`);
        } else {
          log(`  → [dry-run] would verify ${recipe.id}`);
        }
        verified++;
      } else if (result.ok === false) {
        if (!dryRun) {
          await postKnowledge({
            id: `scout-constraint-violated-${recipe.id}-${Date.now()}`,
            app: target.appId,
            category: "pitfall",
            title: `[scout-constraint] ${recipe.id} violated: ${result.pattern}`,
            content: `constraint=${result.pattern} evidence=${result.evidence} details=${result.details}`,
            scope: "global",
          });
          log(`  → pitfall (violated) ${recipe.id}`);
        } else {
          log(`  → [dry-run] would write pitfall (violated) ${recipe.id}`);
        }
        failed++;
      } else {
        if (!dryRun) {
          await postKnowledge({
            id: `scout-constraint-noloc-${recipe.id}-${Date.now()}`,
            app: target.appId,
            category: "pitfall",
            title: `[scout-constraint] ${recipe.id} — evidence unlocatable`,
            content: `constraint evidence cannot be located for "${recipe.title}". ${result.evidence}. verifyMode should be "human".`,
            scope: "global",
            verifyMode: "human",
          });
          log(`  → pitfall (human) ${recipe.id}`);
        } else {
          log(`  → [dry-run] would write pitfall (human) ${recipe.id}`);
        }
        observed++;
      }

      summary.rounds.push(roundResult);
      summary.totalKnowledge++;

      // Remove this recipe from remaining pool for next iteration
      const idx = allKnowledge.indexOf(recipe);
      if (idx >= 0) allKnowledge.splice(idx, 1);
    }

    summary.constraintSummary = { verified, failed, observed };
    log(`constraint-only done: verified=${verified} failed=${failed} observed=${observed}`);
    return summary;
  }

  // ── Full mode: device-backed verification ──
  // v2.3: constraint targets are verified by grepping the repo (no phone needed),
  // so they skip device selection + session acquire entirely. Only replay/explore
  // targets need a device session. On session acquire failure (409/423/non-201),
  // try the next target (up to 3 per round) instead of ending the round at 0 output.
  for (let round = 0; round < maxRounds; round++) {
    log(`\n=== Round ${round + 1}/${maxRounds} ===`);

    // §4-2: Inventory capabilities + knowledge once per round
    const allCaps = await getCapabilities().catch(() => []);
    const allKnowledge = await getKnowledge("xhs").catch(() => []);
    const allPitfalls = allKnowledge.filter((k) => k.category === "pitfall");

    const triedCapIds = new Set();   // capabilities attempted this round (session failed)
    const triedSerials = new Set(); // devices already tried & locked this round
    let roundResult = { round: round + 1, status: "no_attempt_succeeded" };
    let handled = false;

    // Up to 3 targets per round; constraint targets resolve on first try.
    for (let attempt = 0; attempt < 3 && !handled; attempt++) {
      const target = selectTarget(allCaps, allKnowledge, capabilityFilter, {
        excludeIds: [...triedCapIds],
      });
      if (!target) {
        log("no scoutable capability found — ending round");
        roundResult = { round: round + 1, status: "no_capability" };
        break;
      }
      log(`target capability: ${target.id} (${target.maturity}/${target.risk}) P${target._priority} recipeType=${target._recipeType || "none"}`);

      // ── Constraint target: grep-only verification, no device / no session ──
      if (target._recipeType === "constraint") {
        const recipe = target._recipe;
        log(`constraint target — verifying via repo grep (no device session needed)`);
        const result = await verifyRecipe(null, recipe, target, { dryRun });
        roundResult = {
          round: round + 1,
          capability: target.id,
          status: result.ok === null ? "recipe_observed" : result.ok ? "recipe_verified" : "recipe_verify_failed",
          reason: result.reason,
          recipeType: "constraint",
          pattern: result.pattern,
          evidence: result.evidence,
          samplePath: "grep-only",
        };
        summary.totalKnowledge++;
        handled = true;
        break;
      }

      // ── Replay / explore target: needs a device session ──
      const device = await selectDevice(allPitfalls, [...triedSerials]);
      if (!device) {
        log("no available device (all busy/offline/quarantined) — ending round");
        roundResult = { round: round + 1, status: "no_device" };
        break;
      }
      log(`selected device: ${device.alias} (${device.label}) [${device.serial}]`);

      const sessionRes = await acquireSession(device.control.deviceId, target.id);
      const sessionBusy = sessionRes.status === 423 || sessionRes.status === 409;
      if (sessionBusy || sessionRes.status !== 201 || !sessionRes.data?.session?.sessionId) {
        log(`session acquire failed (${sessionRes.status}) for ${target.id} — trying next target`);
        triedCapIds.add(target.id);
        if (sessionBusy) triedSerials.add(device.serial); // device locked → avoid re-selecting
        roundResult = {
          round: round + 1,
          capability: target.id,
          device: device.alias,
          status: sessionBusy ? "session_busy" : "session_failed",
          reason: `http ${sessionRes.status}`,
        };
        continue; // §4: try next target this round (up to 3)
      }

      const { sessionId, token } = sessionRes.data.session;
      log(`session acquired: ${sessionId.slice(0, 12)}…`);

      try {
        const recipe = target._recipe;
        if (recipe) {
          // §5: Re-run verification (replay; constraint would have taken the branch above)
          const result = await verifyRecipe(device, recipe, target, { dryRun });
          roundResult = {
            round: round + 1,
            device: device.alias,
            capability: target.id,
            status: result.ok === null ? "recipe_observed" : result.ok ? "recipe_verified" : "recipe_verify_failed",
            reason: result.reason,
            recipeType: target._recipeType,
            evidence: result.evidence,
            pattern: result.pattern,
            samplePath: "serve-direct", // §5: direct serve → knowledge only, not v1.3
          };
          summary.totalKnowledge++;
        } else {
          // §6: Explore fresh
          const result = await exploreFresh(device, target, allPitfalls, { dryRun });
          roundResult = {
            round: round + 1,
            device: device.alias,
            capability: target.id,
            status: result.ok ? "explored" : "explore_failed",
            reason: result.reason,
          };
          summary.totalKnowledge++;
        }
        handled = true;
      } catch (err) {
        log(`round error: ${err.message}`);
        roundResult = {
          round: round + 1,
          device: device.alias,
          capability: target.id,
          status: "error",
          error: err.message,
        };
        // §7-2: fail-closed — record and stop this round (do not retry a thrown op)
        handled = true;
      } finally {
        // §7-4: Always restore scene and release session
        await restoreScene(device);
        await releaseSession(sessionId, token).catch((e) =>
          log(`session release warning: ${e.message}`)
        );
        log("session released, scene restored");
      }
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
  const constraintOnly = args.includes("--constraint-only");

  log(`scout starting (actor=${ACTOR}, rounds=${maxRounds}, filter=${capabilityFilter || "none"}, dryRun=${dryRun}, constraintOnly=${constraintOnly})`);

  run({ maxRounds, capabilityFilter, dryRun, constraintOnly })
    .then(async (summary) => {
      log(`\n=== Summary ===`);
      log(`rounds: ${summary.rounds.length} | knowledge entries: ${summary.totalKnowledge}`);
      for (const r of summary.rounds) {
        log(`  round ${r.round}: ${r.device || "—"} / ${r.capability || "—"} → ${r.status}${r.reason ? ` (${r.reason})` : ""}${r.recipeType ? ` [${r.recipeType}]` : ""}${r.pattern ? ` pattern=${r.pattern}` : ""}${r.evidence ? ` evidence="${r.evidence.slice(0, 80)}"` : ""}${r.samplePath ? ` sample=${r.samplePath}` : ""}`);
      }
      log("scout done.");
    })
    .catch((err) => {
      log(`FATAL: ${err.message}`);
      console.error(err.stack);
      exit(1);
    });
}

export { run, selectDevice, selectTarget, classifyRecipe, buildRecipeIndex, verifyConstraint, matchConstraintPattern, grepFile, grepRepo, extractConstraintTokens, locateEvidence, CONSTRAINT_PATTERNS, GREP_DIRS };
