#!/usr/bin/env node
/**
 * xw-xhs-capabilities.mjs — idempotent 04-only capability + routing-profile
 * registration for the XHS multi-entry script pack (plan V2 §2.1; W2 sedimented
 * fixed task). Writes the XHS social/interaction capabilities into control.db
 * and adds their IDs ONLY to device alias 04's routing profile — 01-03 are
 * never given these capability IDs, which is the placement boundary the W2
 * test (xhs-04-placement-boundary.test.mjs) and placement.mjs:127 enforce.
 *
 *   node ops/xw-xhs-capabilities.mjs apply  [--runtime] [--db <path>]
 *   node ops/xw-xhs-capabilities.mjs diff   [--runtime] [--db <path>]
 *
 * `apply` is idempotent: re-running is a no-op (merges, never removes existing
 * capabilityIds from 04; never touches 01-03). `diff` prints what would change
 * without writing. Console: console.log only (Windows bridge treats stderr as
 * fatal).
 *
 * NOTE: this script operates on control.db directly (the control-plane's device
 * + capabilities tables). The live runtime control.db is at
 * C:\Users\Public\xw-runtime\state\control-plane\control.db; --runtime targets
 * it. Without --runtime it targets a repo-local control.db (for offline dry
 * runs / test fixtures).
 */
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { StateStore } from "../../control-plane/control-plane/lib/state-store.mjs";
import { CapabilityRegistry } from "../../control-plane/control-plane/lib/capability-registry.mjs";
import { normalizeRoutingProfile } from "../../control-plane/control-plane/lib/placement.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_DEFAULT_DB = resolve(HERE, "..", "..", "control-plane", "control-plane", "runtime", "control.db");
const RUNTIME_DB = "C:\\Users\\Public\\xw-runtime\\state\\control-plane\\control.db";
const AUTHORITY_NODE = process.env.XHS_AUTHORITY_NODE || "DESKTOP-3I1EVHE";
const TARGET_ALIAS = "04";

/** The XHS capabilities this pack registers. W4 binds the adapters; W2 only
 * proves the 04-only placement boundary. Keep this in sync with the W4/W5
 * dispatcher catalog (xw-xhs-dispatcher.mjs capabilityId fields).
 *
 * invocationPolicy: { allowedModes: ["mission_effect"] } is the canonical
 * mission-only gate (authorization-decision.mjs:55, placement.mjs:78) — every
 * XHS social effect is a strict-Mission external_effect, never a free job. The
 * plan's "invocationPolicy=mission_only" maps to this existing object form, not
 * a new string. exposure=public so the dispatcher can route to them, but the
 * allowedModes gate is what keeps them mission-bound. */
const XHS_CAPABILITIES = [
  xhsSocialCapability("xhs.like.ensure", "like"),
  xhsSocialCapability("xhs.collect.ensure", "collect"),
  xhsSocialCapability("xhs.follow.ensure", "follow"),
  xhsSocialCapability("xhs.comment.bound_send", "comment"),
  xhsSocialCapability("xhs.dm.bound_reply", "reply"),
];

function xhsSocialCapability(id, action) {
  return {
    schemaVersion: 1,
    id,
    appId: "xhs",
    packageName: "com.xingin.xhs",
    versionRange: "9.10.113",
    maturity: "E3",
    risk: "R1",
    resources: ["device"],
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: { type: "object" },
    preconditions: [],
    verification: { mode: "state", description: `verifier for ${id}` },
    restoration: { required: true, description: "return home" },
    timeoutMs: 30000,
    idempotency: "external_effect",
    automationPolicy: { mode: "approval_required" },
    implementation: { adapter: "xhs", action },
    evidence: [],
    availability: "implemented",
    exposure: "public",
    invocationPolicy: { allowedModes: ["mission_effect"] },
  };
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--") && i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      out[a.slice(2)] = argv[++i];
    } else if (a.startsWith("--")) {
      out[a.slice(2)] = true;
    } else {
      out._.push(a);
    }
  }
  return out;
}

function fail(msg, code = 2) {
  console.log(`CAPABILITIES_FAILED ${msg}`);
  process.exit(code);
}

function openState(dbPath) {
  const store = new StateStore({ dbPath });
  store.upsertNode({ nodeId: AUTHORITY_NODE, authority: true });
  return store;
}

/**
 * Read 04's current routing profile (normalized), or null if the device isn't
 * seeded yet. The apply step seeds it if missing.
 */
function getDevice04(state) {
  const row = state.db
    .prepare("SELECT * FROM devices WHERE node_id=? AND alias=?")
    .get(AUTHORITY_NODE, TARGET_ALIAS);
  if (!row) return null;
  return {
    deviceId: row.device_id,
    alias: row.alias,
    physicalLabel: row.physical_label,
    runtimeId: row.runtime_id || null,
    routingProfile: normalizeRoutingProfile(JSON.parse(row.routing_json || "{}")),
  };
}

function desiredCapIds() {
  return XHS_CAPABILITIES.map((c) => c.id);
}

/**
 * Compute the diff: which capIds are new for 04, and which capabilities would
 * be newly synced. Returns { capIdsToAdd, existing04, missingDevice }.
 */
function computeDiff(state) {
  const dev = getDevice04(state);
  if (!dev) {
    return { capIdsToAdd: desiredCapIds(), existing04: null, missingDevice: true };
  }
  const have = new Set(dev.routingProfile.capabilityIds);
  const add = desiredCapIds().filter((id) => !have.has(id));
  return { capIdsToAdd: add, existing04: dev, missingDevice: false };
}

function cmdDiff(state) {
  const { capIdsToAdd, existing04, missingDevice } = computeDiff(state);
  if (missingDevice) {
    console.log(`DIFF: device ${TARGET_ALIAS} not seeded on ${AUTHORITY_NODE}; apply will create it with capabilityIds=[${desiredCapIds().join(",")}]`);
    return;
  }
  if (!capIdsToAdd.length) {
    console.log(`DIFF: device ${TARGET_ALIAS} already carries all XHS caps (${existing04.routingProfile.capabilityIds.length} ids); no change`);
    return;
  }
  console.log(`DIFF: device ${TARGET_ALIAS} +${capIdsToAdd.length} capIds [${capIdsToAdd.join(",")}]`);
  console.log(`  current (${existing04.routingProfile.capabilityIds.length}): ${existing04.routingProfile.capabilityIds.join(",") || "(none)"}`);
}

function cmdApply(state) {
  const { capIdsToAdd, existing04, missingDevice } = computeDiff(state);

  // 1. Sync capabilities into the capabilities table. syncCapabilities disables
  //    any cap not in the registry, so we pass the FULL XHS set each run — but
  //    to avoid clobbering OTHER apps' capabilities, we merge with what's
  //    already enabled. Read existing enabled caps and union with ours.
  const existingRows = state.db
    .prepare("SELECT capability_id FROM capabilities WHERE enabled=1")
    .all().map((r) => r.capability_id);
  const xhsIds = new Set(XHS_CAPABILITIES.map((c) => c.id));
  // Keep existing non-xhs caps; for xhs caps, the registry manifest wins.
  const keptManifests = state.db
    .prepare("SELECT capability_id, manifest_json FROM capabilities WHERE enabled=1")
    .all()
    .filter((r) => !xhsIds.has(r.capability_id))
    .map((r) => JSON.parse(r.manifest_json));
  const fullSet = [...keptManifests, ...XHS_CAPABILITIES];
  const registry = new CapabilityRegistry(fullSet);
  state.syncCapabilities(registry);
  console.log(`SYNC capabilities: ${XHS_CAPABILITIES.length} xhs (+${keptManifests.length} existing kept) enabled`);

  // 2. Add capIds ONLY to 04's routing profile (merge, never remove).
  if (missingDevice) {
    state.upsertDevice({
      alias: TARGET_ALIAS,
      physicalLabel: `rack-${TARGET_ALIAS}`,
      nodeId: AUTHORITY_NODE,
      routingProfile: { enabled: true, tags: [`slot:${TARGET_ALIAS}`], capabilityIds: desiredCapIds() },
    });
    console.log(`SEEDED device ${TARGET_ALIAS} with ${desiredCapIds().length} capIds`);
    return;
  }

  if (!capIdsToAdd.length) {
    console.log(`IDEMPOTENT device ${TARGET_ALIAS} already carries all XHS caps; no routing change`);
    return;
  }

  const merged = [...new Set([...existing04.routingProfile.capabilityIds, ...capIdsToAdd])].sort();
  state.upsertDevice({
    deviceId: existing04.deviceId,
    alias: existing04.alias,
    physicalLabel: existing04.physicalLabel,
    nodeId: AUTHORITY_NODE,
    runtimeId: existing04.runtimeId || undefined,
    routingProfile: {
      enabled: true,
      tags: existing04.routingProfile.tags.length ? existing04.routingProfile.tags : [`slot:${TARGET_ALIAS}`],
      capabilityIds: merged,
    },
  });
  console.log(`APPLIED device ${TARGET_ALIAS} +${capIdsToAdd.length} capIds [${capIdsToAdd.join(",")}] -> ${merged.length} total`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    console.log("usage: xw-xhs-capabilities.mjs <apply|diff> [--runtime] [--db <path>]");
    process.exit(0);
  }
  const cmd = args._[0];
  if (!cmd) fail("no command; one of apply|diff");
  const dbPath = args.db || (args.runtime ? RUNTIME_DB : REPO_DEFAULT_DB);
  const state = openState(dbPath);
  try {
    switch (cmd) {
      case "apply": return cmdApply(state);
      case "diff": return cmdDiff(state);
      default: fail(`unknown command ${cmd}`);
    }
  } finally {
    state.close();
  }
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  main().catch((e) => fail(e.message || String(e)));
}