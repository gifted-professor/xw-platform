import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  buildM64LiveWorkerDirective,
  createM6LiveWorkerDriver,
  renderM64LiveWorkerPrompt,
} from "../src/live-worker-driver.mjs";
import { spawnOwnedProcess, terminateOwnedProcessTree } from "../src/stdio-supervisor.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const H = (char) => char.repeat(64);

function scenario({ purpose = "M6_4_SHADOW", slots = [] } = {}) {
  return {
    scenarioKey: `${purpose.toLowerCase()}-01`,
    alias: "01",
    oracleHash: H("a"),
    actionPlan: {
      schemaId: "xw.m6-scenario-action-plan.v1",
      maxActionCount: slots.length,
      slots,
      actionPlanHash: H("b"),
    },
  };
}

function slot() {
  return {
    schemaId: "xw.m6-action-slot-authority.v1",
    sequenceIndex: 0,
    logicalStepId: "m6_4_action_smoke-01:step-01",
    actionSlotOrdinal: 0,
    primitive: "tap",
    actionFamily: "tab-back:open-tab",
    intentRef: H("c"),
    targetKind: "block",
    oracleHash: H("d"),
    slotAuthorityHash: H("e"),
  };
}

function binding(purpose = "M6_4_SHADOW") {
  return {
    runId: `run:${H("1")}`,
    workerId: `worker:${H("2")}`,
    sessionId: `session:${H("3")}`,
    alias: "01",
    processRef: `process:${H("4")}`,
    gateEpochHash: H("5"),
    generation: 1,
    purpose,
    scenarioManifestHash: H("6"),
    liveWindowAuthorizationHash: H("7"),
    bindingHash: H("8"),
  };
}

function directiveFixture(purpose = "M6_4_SHADOW", slots = []) {
  const exactBinding = binding(purpose);
  const exactScenario = scenario({ purpose, slots });
  return {
    binding: exactBinding,
    workerRunRef: `workerrun:${H("9")}`,
    manifest: { manifestHash: exactBinding.scenarioManifestHash },
    scenario: exactScenario,
    scenarioKey: exactScenario.scenarioKey,
  };
}

test("worker directive exposes only frozen opaque refs and an exact purpose-specific sequence", () => {
  const shadow = buildM64LiveWorkerDirective(directiveFixture());
  assert.equal(shadow.mode, "SHADOW_OBSERVE");
  assert.equal(shadow.maxActionCount, 0);
  assert.match(shadow.directiveHash, /^[0-9a-f]{64}$/u);
  const shadowPrompt = renderM64LiveWorkerPrompt(shadow);
  assert.match(shadowPrompt, /phone_observe/u);
  assert.doesNotMatch(shadowPrompt, /\b(?:adb|serial|coordinate|shell|password|api.?key|payment|delete)\b/iu);

  const action = buildM64LiveWorkerDirective(directiveFixture("M6_4_ACTION_SMOKE", [slot()]));
  assert.equal(action.mode, "BOUNDED_ACTION");
  assert.deepEqual(action.steps.map(({ primitive, targetKind }) => ({ primitive, targetKind })), [{ primitive: "tap", targetKind: "block" }]);
  assert.match(renderM64LiveWorkerPrompt(action), /phone_verify/u);
});

test("production worker driver initializes and prompts the already-owned child, waits idle, and shuts it down", async () => {
  const processRef = spawnOwnedProcess(process.execPath, [join(HERE, "fixtures", "fake-jsonrpc-peer.mjs"), "normal"], {
    cwd: HERE,
    env: process.env,
  });
  const aborts = [];
  const live = {
    processRef,
    modelProfileHash: H("f"),
    broker: { abort(error) { aborts.push(error?.code); } },
  };
  const driver = createM6LiveWorkerDriver({ workingDirectory: tmpdir() });
  let handle;
  try {
    handle = await driver({
      live,
      ...directiveFixture(),
      qualification: {
        status: "QUALIFIED",
        gateFEligible: true,
        contentHash: H("f"),
        provider: "deepseek-official",
        model: "deepseek-v4-flash",
        maxTokens: 4096,
      },
    });
    assert.equal(handle.schemaId, "xw.m6-live-worker-protocol.v1");
    assert.equal(await handle.whenIdle(1_000), true);
    const receipt = await handle.close();
    assert.equal(receipt.verifiedClosed, true);
    assert.deepEqual(aborts, []);
  } finally {
    if (processRef.child.exitCode === null && processRef.child.signalCode === null) {
      await terminateOwnedProcessTree(processRef, { timeouts: { gracefulExitMs: 100, termExitMs: 100, treeKillMs: 1_000 } });
    }
  }
});

test("driver rejects duplicate ownership before a second protocol can reach the child", async () => {
  const processRef = spawnOwnedProcess(process.execPath, [join(HERE, "fixtures", "fake-jsonrpc-peer.mjs"), "normal"], {
    cwd: HERE,
    env: process.env,
  });
  const live = {
    processRef,
    modelProfileHash: H("f"),
    broker: { abort() {} },
  };
  const driver = createM6LiveWorkerDriver({ workingDirectory: tmpdir() });
  const input = {
    live,
    ...directiveFixture(),
    qualification: {
      status: "QUALIFIED",
      gateFEligible: true,
      contentHash: H("f"),
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
      maxTokens: 4096,
    },
  };
  const first = await driver(input);
  try {
    await assert.rejects(driver(input), { code: "M6_LIVE_WORKER_DUPLICATE" });
  } finally {
    await first.close();
    if (processRef.child.exitCode === null && processRef.child.signalCode === null) {
      await terminateOwnedProcessTree(processRef, { timeouts: { gracefulExitMs: 100, termExitMs: 100, treeKillMs: 1_000 } });
    }
  }
});
