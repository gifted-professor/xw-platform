import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CapabilityRegistry } from "../control-plane/lib/capability-registry.mjs";
import { AdapterRegistry, ControlPlane } from "../control-plane/lib/control-plane.mjs";
import { EvidenceStore } from "../control-plane/lib/evidence-store.mjs";
import { createFakeObserveProvider } from "../control-plane/lib/open-action-session.mjs";
import { classifyPaymentFirewall } from "../control-plane/lib/payment-firewall.mjs";
import { StateStore } from "../control-plane/lib/state-store.mjs";
import {
  EFFECT_POLICY,
  validateEffectAssessment,
} from "../../../packages/kernel/lib/open-action.mjs";

const fixtures = JSON.parse(readFileSync(new URL("./fixtures/payment-firewall/cases.json", import.meta.url), "utf8"));
const tempBase = fileURLToPath(new URL("../control-plane/runtime", import.meta.url));
mkdirSync(tempBase, { recursive: true });
const AUTHORITY = "DESKTOP-3I1EVHE";

function classifyCase(item) {
  return classifyPaymentFirewall(item.surface, {
    agentClaimedCategory: item.agentClaimedCategory,
  });
}

function representative(category) {
  return fixtures.cases.find((item) => item.expectedCategory === category);
}

function runtimeFixture({ observeProvider } = {}) {
  const root = mkdtempSync(join(tempBase, "oa-firewall-"));
  const state = new StateStore({ dbPath: join(root, "control.db") });
  const caps = new CapabilityRegistry([]);
  state.upsertNode({ nodeId: AUTHORITY, authority: true });
  const device = state.upsertDevice({
    alias: "01",
    physicalLabel: "rack-01",
    nodeId: AUTHORITY,
    runtimeId: "private-01",
    routingProfile: { enabled: true, tags: ["slot:01"], capabilityIds: [] },
  });
  const evidence = new EvidenceStore({
    runsRoot: join(root, "runs"),
    state,
    minFreeBytes: 0,
    minExternalEffectFreeBytes: 0,
  });
  const control = new ControlPlane({
    state,
    evidence,
    capabilities: caps,
    adapters: new AdapterRegistry([]),
    authorityNodeId: AUTHORITY,
    observeProvider,
  });
  return { root, state, device, control };
}

test("payment firewall matrix covers every fixture category and frozen decision", () => {
  assert.ok(fixtures.cases.length >= 22, fixtures.cases.length);
  for (const item of fixtures.cases) {
    const assessment = classifyCase(item);
    assert.equal(assessment.category, item.expectedCategory, item.name);
    assert.equal(assessment.decision, EFFECT_POLICY[item.expectedCategory], item.name);
    assert.equal(assessment.authority, "control_plane", item.name);
    assert.equal(validateEffectAssessment(assessment).ok, true, item.name);
  }
});

test("decision is taken from EFFECT_POLICY and never ALLOW_WITH_TRACE for payment classes", () => {
  for (const category of ["payment_credential", "payment_final_commit", "payment_context_uncertain", "nonpayment"]) {
    const item = representative(category);
    assert.ok(item, category);
    const assessment = classifyCase(item);
    assert.equal(assessment.decision, EFFECT_POLICY[category], category);
    if (category !== "nonpayment") {
      assert.notEqual(assessment.decision, "ALLOW_WITH_TRACE", category);
    }
  }
});

test("agent claimed category is echoed and never overrides control_plane", () => {
  const claimedNonpayment = fixtures.cases.find((item) => item.name === "agent_claims_nonpayment_on_final");
  const claimedCredential = fixtures.cases.find((item) => item.name === "agent_claims_credential_on_empty");
  const hold = classifyCase(claimedNonpayment);
  assert.equal(hold.category, "payment_final_commit");
  assert.equal(hold.agentClaimedCategory, "nonpayment");
  const empty = classifyCase(claimedCredential);
  assert.equal(empty.category, "nonpayment");
  assert.equal(empty.agentClaimedCategory, "payment_credential");
});

test("mixed signals follow final_commit > credential > uncertain", () => {
  const finalOverCred = classifyCase(fixtures.cases.find((item) => item.name === "precedence_final_over_credential"));
  assert.equal(finalOverCred.category, "payment_final_commit");
  assert.ok(finalOverCred.reasons.includes("final_confirm_pay"));
  const credOverUncertain = classifyCase(fixtures.cases.find((item) => item.name === "precedence_credential_over_uncertain"));
  assert.equal(credOverUncertain.category, "payment_credential");
  assert.ok(credOverUncertain.reasons.includes("credential_otp"));
});

test("unknown signals classify as payment_context_uncertain and never ALLOW_WITH_TRACE", () => {
  const assessment = classifyCase(fixtures.cases.find((item) => item.name === "unknown_signal_ignored"));
  assert.equal(assessment.category, "payment_context_uncertain");
  assert.equal(assessment.decision, "REOBSERVE_REQUIRED");
  assert.ok(assessment.reasons.includes("unknown_payment_signal:not_a_signal"));
  assert.ok(assessment.reasons.includes("unknown_payment_signal:garbage_pay_word"));
});

test("incomplete classification cannot return nonpayment", () => {
  const assessment = classifyPaymentFirewall({
    paymentSignals: [],
    paymentClassificationComplete: false,
  });
  assert.equal(assessment.category, "payment_context_uncertain");
  assert.equal(assessment.decision, "REOBSERVE_REQUIRED");
  assert.deepEqual(assessment.reasons, ["payment_classification_incomplete"]);
});

test("observe lane replay classifies a final-commit fixture without opening actions", async () => {
  const signals = ["final_confirm_pay"];
  const f = runtimeFixture({
    observeProvider: createFakeObserveProvider({
      fixture: { paymentSignals: signals, pageKey: "pay.final" },
    }),
  });
  try {
    const created = f.control.createDeviceSession({
      actorId: "agent-firewall",
      deviceId: f.device.deviceId,
    });
    const observed = await f.control.observeDeviceSession(created.session.sessionId, created.token, {});
    assert.equal(observed.mutatingCalls, 0);
    assert.equal(observed.observation.schemaId, "xw.open-action.observation.v1");
    assert.deepEqual(observed.observation.paymentSignals, signals);
    const assessment = classifyPaymentFirewall(observed.observation);
    assert.equal(assessment.category, "payment_final_commit");
    assert.equal(assessment.decision, "HUMAN_REQUIRED");
    assert.equal(validateEffectAssessment(assessment).ok, true);
    const types = f.state.listDeviceSessionEvents(created.session.sessionId).map((event) => event.type);
    assert.deepEqual(types, ["device_session.created", "observation.captured"]);
    assert.ok(!types.includes("effect.assessed"));
    assert.ok(!types.includes("payment.hold_created"));
  } finally {
    f.state.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
