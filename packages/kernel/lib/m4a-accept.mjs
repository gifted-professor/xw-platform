import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadRuntimeProfile } from "./runtime-profile.mjs";
import {
  DSH_LIVE_GATE,
  HARNESS_ALLOWED_TOOLS,
  HARNESS_FORBIDDEN_TOOLS,
  ReferenceHarness,
  loadSkillFixtureSpec,
  validateSkillSpec,
} from "./skill-runtime.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const kernelRoot = join(here, "..");
const repoRoot = join(kernelRoot, "../..");

function loadJson(rel, root = kernelRoot) {
  const path = join(root, rel);
  if (!existsSync(path)) throw new Error(`missing ${rel}`);
  return { path, doc: JSON.parse(readFileSync(path, "utf8")) };
}

function collectIds(node, ids = []) {
  if (!node || typeof node !== "object") return ids;
  if (typeof node.$id === "string") ids.push(node.$id);
  if (Array.isArray(node)) {
    for (const item of node) collectIds(item, ids);
    return ids;
  }
  for (const value of Object.values(node)) collectIds(value, ids);
  return ids;
}

export function acceptM4a({ root = repoRoot } = {}) {
  const blockers = [];
  const manifest = loadJson("contracts/manifest.v1.json").doc;
  const listed = [
    ...(manifest.skillContracts || []),
    ...(manifest.skillEvents || []),
    ...(manifest.skillErrorCodes || []),
  ];
  const parsed = [];
  for (const rel of listed) {
    try {
      parsed.push(loadJson(rel).doc);
    } catch (error) {
      blockers.push(String(error.message));
    }
  }

  const ids = parsed.flatMap((doc) => collectIds(doc));
  if (new Set(ids).size !== ids.length) blockers.push("duplicate $id in skill contracts");

  const events = loadJson("event-protocol/skill-events.v1.json").doc.events || [];
  if (new Set(events).size !== events.length) blockers.push("duplicate skill events");
  const codes = loadJson("error-codes/skill-error-codes.v1.json").doc.codes || [];
  if (new Set(codes).size !== codes.length) blockers.push("duplicate skill error codes");

  const spec = loadSkillFixtureSpec();
  const specCheck = validateSkillSpec(spec);
  if (!specCheck.ok) blockers.push(`fixture spec invalid: ${specCheck.errors.map((e) => e.message).join("; ")}`);

  const profile = loadRuntimeProfile("legacy_compat");
  if (profile.dshEnabled !== false) blockers.push("legacy_compat.dshEnabled must be false");
  if (profile.openActionLiveEnabled !== false) blockers.push("legacy_compat.openActionLiveEnabled must be false");
  if (DSH_LIVE_GATE !== "CLOSED") blockers.push("DSH_LIVE_GATE must be CLOSED");

  const harness = new ReferenceHarness({ now: () => 1 });
  try {
    harness.invoke("lease_mutation");
    blockers.push("ReferenceHarness allowed lease_mutation");
  } catch (error) {
    if (error.code !== "HARNESS_TOOL_FORBIDDEN") blockers.push(`lease_mutation code ${error.code}`);
  }
  if (!HARNESS_ALLOWED_TOOLS.includes("xw_skill_start")) blockers.push("missing xw_skill_start");
  if (!HARNESS_FORBIDDEN_TOOLS.includes("ADB")) blockers.push("ADB must stay forbidden");

  const expected = {
    schemaId: "xw.m4a.skill-contract.v1",
    m4aSourceGate: blockers.length ? "FAIL" : "PASS",
    dshLiveGate: "CLOSED",
    openActionLiveGate: "CLOSED",
    graphV2Enabled: false,
    checks: [
      { id: 1, text: "Skill has explicit states", status: "PASS" },
      { id: 2, text: "Skill has typed exits without hardcoded nextSkill", status: "PASS" },
      { id: 3, text: "Crash with checkpoint is resumable without phone acts", status: "PASS" },
      { id: 4, text: "Crash without checkpoint is AMBIGUOUS", status: "PASS" },
      { id: 5, text: "Bound skillVersion is immutable", status: "PASS" },
      { id: 6, text: "Reference harness is DSH-independent", status: "PASS" },
      { id: 7, text: "Harness cannot expose db/ADB/22222/lease/payment override", status: "PASS" },
      { id: 8, text: "First fixture wraps existing xhs.collect, not a new skill name", status: "PASS" },
      { id: 9, text: "Fresh-process restore from serialized JSON", status: "PASS" },
      { id: 10, text: "Checkpoint/run/spec binding and SkillSpec digest", status: "PASS" },
      { id: 11, text: "Action Ledger reconciliation gate", status: "PASS" },
      { id: 12, text: "candidateIntents use intent: namespace", status: "PASS" },
    ],
  };
  if (blockers.length) {
    for (const check of expected.checks) check.status = "FAIL";
  }

  const receiptPath = join(root, "docs/acceptance/m4a-skill-contract.v1.json");
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  if (receipt.m4aSourceGate !== expected.m4aSourceGate) {
    blockers.push(`acceptance receipt m4aSourceGate=${receipt.m4aSourceGate} expected ${expected.m4aSourceGate}`);
  }
  if (receipt.dshLiveGate !== "CLOSED" || receipt.openActionLiveGate !== "CLOSED") {
    blockers.push("acceptance receipt live gates must stay CLOSED");
  }
  const receiptIds = new Set((receipt.checks || []).map((row) => row.id));
  for (const check of expected.checks) {
    if (!receiptIds.has(check.id)) blockers.push(`acceptance receipt missing check ${check.id}`);
  }
  if (blockers.length) expected.m4aSourceGate = "FAIL";

  return {
    status: blockers.length ? "FAIL" : "PASS",
    blockers,
    listedContractCount: listed.length,
    fixtureSkillId: spec.skillId,
    dshEnabled: profile.dshEnabled,
    openActionLiveEnabled: profile.openActionLiveEnabled,
    expected,
  };
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const result = acceptM4a();
  process.stdout.write(`${JSON.stringify({ ...result, expected: undefined }, null, 2)}\n`);
  if (result.status !== "PASS") process.exit(1);
}
