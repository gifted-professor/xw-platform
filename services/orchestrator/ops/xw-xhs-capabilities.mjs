#!/usr/bin/env node
/**
 * xw-xhs-capabilities.mjs — idempotent capability + routing-profile
 * registration for the XHS multi-entry script pack (plan V2 §2.1; W2 sedimented
 * fixed task). Writes the XHS social/interaction capabilities into control.db
 * and adds their IDs to the target device's routing profile. The pack launched
 * 04-only (the W2 test xhs-04-placement-boundary.test.mjs uses self-contained
 * fixtures and still proves that boundary); on 2026-08-27 the user amended the
 * plan to also allow alias 03 (账号自由度更高), so the script takes --alias
 * (default 04) and merges capIds into that device only — other devices are
 * never touched.
 *
 *   node ops/xw-xhs-capabilities.mjs apply  [--runtime] [--db <path>] [--alias 03]
 *   node ops/xw-xhs-capabilities.mjs diff   [--runtime] [--db <path>] [--alias 03]
 *
 * `apply` is idempotent: re-running is a no-op (merges, never removes existing
 * capabilityIds from the target; never touches other devices). `diff` prints
 * what would change without writing. Console: console.log only (Windows bridge
 * treats stderr as fatal).
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
import { canonicalJson } from "../../control-plane/control-plane/lib/canonical.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_DEFAULT_DB = resolve(HERE, "..", "..", "control-plane", "control-plane", "runtime", "control.db");
const RUNTIME_DB = "C:\\Users\\Public\\xw-runtime\\state\\control-plane\\control.db";
const AUTHORITY_NODE = process.env.XHS_AUTHORITY_NODE || "DESKTOP-3I1EVHE";
const DEFAULT_ALIAS = "04";

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
  // QUALIFICATION_ONLY is load-bearing (W4 lesson): a STANDARD-mode constructor
  // runs recoverInterruptedWork(), which wipes ALL sessions+leases from the
  // live db at construction time even on a clean job queue.
  const store = new StateStore({ dbPath, m6RuntimeMode: "QUALIFICATION_ONLY" });
  store.upsertNode({ nodeId: AUTHORITY_NODE, authority: true });
  return store;
}

/**
 * Read the target device's current routing profile (normalized), or null if
 * the device isn't seeded yet. The apply step seeds it if missing.
 */
function getTargetDevice(state, targetAlias) {
  const row = state.db
    .prepare("SELECT * FROM devices WHERE node_id=? AND alias=?")
    .get(AUTHORITY_NODE, targetAlias);
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
 * Compute the diff: which capIds are new for the target device, and which
 * capabilities would be newly synced. Returns { capIdsToAdd, existingDevice, missingDevice }.
 */
function computeDiff(state, targetAlias) {
  const dev = getTargetDevice(state, targetAlias);
  if (!dev) {
    return { capIdsToAdd: desiredCapIds(), existingDevice: null, missingDevice: true };
  }
  const have = new Set(dev.routingProfile.capabilityIds);
  const add = desiredCapIds().filter((id) => !have.has(id));
  return { capIdsToAdd: add, existingDevice: dev, missingDevice: false };
}

function cmdDiff(state, targetAlias) {
  const { capIdsToAdd, existingDevice, missingDevice } = computeDiff(state, targetAlias);
  if (missingDevice) {
    console.log(`DIFF: device ${targetAlias} not seeded on ${AUTHORITY_NODE}; apply will create it with capabilityIds=[${desiredCapIds().join(",")}]`);
    return;
  }
  if (!capIdsToAdd.length) {
    console.log(`DIFF: device ${targetAlias} already carries all XHS caps (${existingDevice.routingProfile.capabilityIds.length} ids); no change`);
    return;
  }
  console.log(`DIFF: device ${targetAlias} +${capIdsToAdd.length} capIds [${capIdsToAdd.join(",")}]`);
  console.log(`  current (${existingDevice.routingProfile.capabilityIds.length}): ${existingDevice.routingProfile.capabilityIds.join(",") || "(none)"}`);
}

function cmdApply(state, targetAlias) {
  const { capIdsToAdd, existingDevice, missingDevice } = computeDiff(state, targetAlias);

  // 1. Sync ONLY the XHS pack capabilities into the capabilities table —
  //    targeted additive upserts. The old path (syncCapabilities with a merged
  //    full-set registry) disables and rewrites every cap row, which both
  //    clobbers other apps' manifests and trips registry validation on live
  //    manifests carrying fields this repo's schema doesn't know (e.g.
  //    wechat.observe.main's capabilityContractHash). Other caps stay
  //    byte-identical. CapabilityRegistry(XHS_CAPABILITIES) still validates
  //    OUR five manifests before anything is written.
  new CapabilityRegistry(XHS_CAPABILITIES);
  const upsert = state.db.prepare(`
    INSERT INTO capabilities (
      capability_id, app_id, maturity, risk, enabled, manifest_json, updated_at
    ) VALUES (?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(capability_id) DO UPDATE SET
      app_id=excluded.app_id,
      maturity=excluded.maturity,
      risk=excluded.risk,
      enabled=1,
      manifest_json=excluded.manifest_json,
      updated_at=excluded.updated_at
  `);
  const now = new Date().toISOString();
  for (const capability of XHS_CAPABILITIES) {
    upsert.run(
      capability.id,
      capability.appId,
      capability.maturity,
      capability.risk,
      canonicalJson(capability),
      now,
    );
  }
  console.log(`SYNC capabilities: ${XHS_CAPABILITIES.length} xhs upserted (other caps untouched)`);

  // 2. Add capIds ONLY to the target device's routing profile (merge, never remove).
  if (missingDevice) {
    state.upsertDevice({
      alias: targetAlias,
      physicalLabel: `rack-${targetAlias}`,
      nodeId: AUTHORITY_NODE,
      routingProfile: { enabled: true, tags: [`slot:${targetAlias}`], capabilityIds: desiredCapIds() },
    });
    console.log(`SEEDED device ${targetAlias} with ${desiredCapIds().length} capIds`);
    return;
  }

  if (!capIdsToAdd.length) {
    console.log(`IDEMPOTENT device ${targetAlias} already carries all XHS caps; no routing change`);
    return;
  }

  const merged = [...new Set([...existingDevice.routingProfile.capabilityIds, ...capIdsToAdd])].sort();
  state.upsertDevice({
    deviceId: existingDevice.deviceId,
    alias: existingDevice.alias,
    physicalLabel: existingDevice.physicalLabel,
    nodeId: AUTHORITY_NODE,
    runtimeId: existingDevice.runtimeId || undefined,
    routingProfile: {
      enabled: true,
      tags: existingDevice.routingProfile.tags.length ? existingDevice.routingProfile.tags : [`slot:${targetAlias}`],
      capabilityIds: merged,
    },
  });
  console.log(`APPLIED device ${targetAlias} +${capIdsToAdd.length} capIds [${capIdsToAdd.join(",")}] -> ${merged.length} total`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    console.log("usage: xw-xhs-capabilities.mjs <apply|diff> [--runtime] [--db <path>] [--alias 03|04]");
    process.exit(0);
  }
  const cmd = args._[0];
  if (!cmd) fail("no command; one of apply|diff");
  const targetAlias = String(args.alias || DEFAULT_ALIAS);
  if (!/^\d{2}$/.test(targetAlias)) fail(`bad --alias ${targetAlias}`);
  const dbPath = args.db || (args.runtime ? RUNTIME_DB : REPO_DEFAULT_DB);
  const state = openState(dbPath);
  try {
    switch (cmd) {
      case "apply": return cmdApply(state, targetAlias);
      case "diff": return cmdDiff(state, targetAlias);
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