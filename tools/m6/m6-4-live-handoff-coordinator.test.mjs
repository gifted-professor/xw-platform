import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  M64_LIVE_HANDOFF_ORDER,
  atomicPublishM64Descriptor,
  createM64LocatorEventSource,
  deriveM64LiveHandoffConfigHash,
  runM64LiveHandoffCoordinator,
  validateM64LiveHandoffCoordinatorConfig,
  validateM64CoordinatorEvent,
} from "./m6-4-live-handoff-coordinator.mjs";

const H = (char) => char.repeat(64);
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
    : JSON.stringify(value);
const domainHash = (domain, value) => createHash("sha256").update(`${domain}:${canonical(value)}`).digest("hex");

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "m64-live-coordinator-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const trace = [];
  const events = [];
  for (let index = 0; index < M64_LIVE_HANDOFF_ORDER.length; index += 1) {
    const purpose = M64_LIVE_HANDOFF_ORDER[index];
    events.push({ kind: "OBSERVATION", descriptors: {
      ticket: { path: join(root, `${index}.work-ticket.json`), sha256: H("a") },
    }, purpose, requestHash: (index * 3 + 1).toString(16).padStart(64, "0") });
    events.push({ kind: "NORMAL_CLOSE_SIGNING", descriptors: {
      locator: { path: join(root, `${index}.normal.json`), sha256: H("b") },
    }, purpose, requestHash: (index * 3 + 2).toString(16).padStart(64, "0") });
    events.push({ kind: "RESOURCE_OBSERVATION", descriptors: {
      locator: { path: join(root, `${index}.resource.json`), sha256: H("c") },
    }, purpose, requestHash: (index * 3 + 3).toString(16).padStart(64, "0") });
  }
  let cursor = 0;
  let clock = Date.parse("2030-01-01T00:00:00Z");
  const initial = { purpose: M64_LIVE_HANDOFF_ORDER[0], epochHash: H("d"), generation: 1,
    inventoryPath: join(root, "M6_4_SHADOW.inventory.json"), inventorySha256: H("f") };
  let activeEpochHash = initial.epochHash;
  let generation = initial.generation;
  const deps = {
    now: () => clock++,
    nextEvent: async ({ purpose, phase }) => { const event = events[cursor++]; trace.push(`event:${purpose}:${phase}:${event.kind}`); return event; },
    invokeHost: async (request) => {
      trace.push(`host:${request.operation}:${request.purpose}:${request.kind || "gate-signer"}`);
      return { ok: true, actionCount: 0, requestHash: events[cursor - 1].requestHash };
    },
    buildWindow: async (request) => {
      trace.push(`signer:${request.operation}:${request.purpose}`);
      activeEpochHash = H(String((generation + 4) % 10));
      generation = request.generation;
      return { ok: true, actionCount: 0, purpose: request.purpose, parentEpochHash: request.parentEpochHash,
        generation: request.generation, epochHash: activeEpochHash, authorizationPath: join(root, `${request.purpose}.authorization.json`),
        candidateActivationPackagePath: join(root, `${request.purpose}.activation.json`) };
    },
    readGateStatus: async ({ purpose, expectedParentEpochHash }) => {
      trace.push(`closed:${purpose}:${expectedParentEpochHash}`);
      const closedEpoch = H(String((generation + 5) % 10));
      const status = { mode: "CLOSED", purpose, tripleConsistent: true, epochHash: closedEpoch,
        generation: generation + 1, actionCount: 0, resourceCounts: { jobs: 0, sessions: 0, leases: 0, actions: 0 } };
      activeEpochHash = closedEpoch; generation = status.generation;
      return status;
    },
    buildInventory: async ({ purpose, parentEpochHash, generation: nextGeneration, dryRun }) => {
      trace.push(`inventory:${purpose}:${parentEpochHash}:${nextGeneration}:${dryRun}`);
      return { ok: true, actionCount: 0, descriptorPath: join(root, `${purpose}.inventory.json`), sha256: H("e") };
    },
    stageWindow: async ({ purpose, built, execute }) => {
      trace.push(`stage:${purpose}:${execute}`);
      return { ok: true, actionCount: 0, purpose, parentEpochHash: built.parentEpochHash,
        generation: built.generation, gateMutationPerformed: false, deviceAccessed: false };
    },
    publishDescriptor: (path, value) => {
      trace.push(`publish:${path.endsWith("window.descriptor.json") ? "window" : "state"}:${value.currentPurpose || value.path || ""}`);
      return { path, sha256: H("f") };
    },
  };
  return { deps, initial, root, trace };
}

test("serial coordinator freezes five windows and builds only the exact successor after CLOSED", async (t) => {
  const f = fixture(t);
  const result = await runM64LiveHandoffCoordinator({ initialWindow: f.initial,
    statePath: join(f.root, "coordinator.state.json"), windowInboxRoot: f.root, timeoutMs: 60_000, dryRun: true }, f.deps);
  assert.equal(result.ok, true);
  assert.equal(result.actionCount, 0);
  assert.equal(result.deviceAccessed, false);
  assert.equal(result.gateMutationPerformed, false);
  assert.equal(result.supplementalRunCount, 0);
  assert.deepEqual(result.completedPurposes, M64_LIVE_HANDOFF_ORDER);
  assert.equal(f.trace.filter((entry) => entry.startsWith("signer:BUILD:")).length, 4);
  assert.equal(f.trace.filter((entry) => entry.startsWith("stage:")).length, 4);
  assert.ok(f.trace.filter((entry) => entry.startsWith("stage:")).every((entry) => entry.endsWith(":false")));
  for (let index = 0; index < 4; index += 1) {
    const closedAt = f.trace.findIndex((entry) => entry.startsWith(`closed:${M64_LIVE_HANDOFF_ORDER[index]}:`));
    const buildAt = f.trace.findIndex((entry) => entry.startsWith(`signer:BUILD:${M64_LIVE_HANDOFF_ORDER[index + 1]}`));
    const inventoryAt = f.trace.findIndex((entry) => entry.startsWith(`inventory:${M64_LIVE_HANDOFF_ORDER[index + 1]}:`));
    const stageAt = f.trace.findIndex((entry) => entry.startsWith(`stage:${M64_LIVE_HANDOFF_ORDER[index + 1]}:`));
    assert.ok(closedAt < buildAt && buildAt < inventoryAt && inventoryAt < stageAt);
  }
});

test("fails closed on reordered, duplicate, or supplemental handoff requests", () => {
  const seen = new Set([H("1")]);
  // Platform-neutral absolute fixture path: the descriptor shape gate uses
  // path.isAbsolute, and a "C:\\..." literal is not absolute on POSIX, which
  // would throw EVENT_INVALID before the ORDER check under test.
  const requestPath = "/audit/request.json";
  assert.throws(() => validateM64CoordinatorEvent({ kind: "RESOURCE_OBSERVATION", descriptors: { locator: { path: requestPath, sha256: H("3") } },
    purpose: "M6_4_SHADOW", requestHash: H("2") }, { purpose: "M6_4_SHADOW", phase: "OBSERVING", seenRequestHashes: seen }),
  { code: "M64_COORDINATOR_ORDER_INVALID" });
  assert.throws(() => validateM64CoordinatorEvent({ kind: "OBSERVATION", descriptors: { ticket: { path: requestPath, sha256: H("3") } },
    purpose: "M6_4_SHADOW", requestHash: H("1") }, { purpose: "M6_4_SHADOW", phase: "OBSERVING", seenRequestHashes: seen }),
  { code: "M64_COORDINATOR_REPLAY_FORBIDDEN" });
  assert.throws(() => validateM64CoordinatorEvent({ kind: "OBSERVATION", descriptors: { ticket: { path: requestPath, sha256: H("3") } },
    purpose: "M6_4_HOT_CLOSE", requestHash: H("4") }, { purpose: "M6_4_SHADOW", phase: "OBSERVING", seenRequestHashes: seen }),
  { code: "M64_COORDINATOR_EVENT_INVALID" });
});

test("wrong CLOSED parent generation prevents BUILD and staging", async (t) => {
  const f = fixture(t);
  f.deps.readGateStatus = async ({ purpose }) => ({ mode: "CLOSED", purpose, tripleConsistent: true,
    epochHash: H("9"), generation: 99, actionCount: 0, resourceCounts: { jobs: 0 } });
  await assert.rejects(runM64LiveHandoffCoordinator({ initialWindow: f.initial,
    statePath: join(f.root, "state.json"), windowInboxRoot: f.root, timeoutMs: 60_000 }, f.deps),
  { code: "M64_COORDINATOR_CLOSED_PROOF_INVALID" });
  assert.equal(f.trace.some((entry) => entry.startsWith("signer:BUILD:")), false);
  assert.equal(f.trace.some((entry) => entry.startsWith("stage:")), false);
});

test("host response must bind requestHash and actionCount zero", async (t) => {
  const f = fixture(t);
  f.deps.invokeHost = async () => ({ ok: true, actionCount: 1, requestHash: H("0") });
  await assert.rejects(runM64LiveHandoffCoordinator({ initialWindow: f.initial,
    statePath: join(f.root, "state.json"), windowInboxRoot: f.root, timeoutMs: 60_000 }, f.deps),
  { code: "M64_COORDINATOR_HOST_REJECTED" });
});

test("atomic state descriptor contains a self-bound hash and no secret material", async (t) => {
  const f = fixture(t);
  f.deps.publishDescriptor = atomicPublishM64Descriptor;
  // Use the real publication for this test, but stop immediately at the first event.
  f.deps.nextEvent = async () => { throw Object.assign(new Error("stop"), { code: "TEST_STOP" }); };
  await assert.rejects(runM64LiveHandoffCoordinator({ initialWindow: f.initial,
    statePath: join(f.root, "state.json"), windowInboxRoot: f.root, timeoutMs: 60_000 }, f.deps), { code: "TEST_STOP" });
  const journal = join(f.root, "state.json.journal");
  const text = readFileSync(join(journal, readdirSync(journal)[0]), "utf8");
  const state = JSON.parse(text);
  assert.match(state.stateHash, /^[0-9a-f]{64}$/u);
  assert.equal(state.actionCount, 0);
  assert.doesNotMatch(text, /PRIVATE KEY|token|password|secret/iu);
});

test("locator event source consumes work-request ticket then exact close locator without catch-up", async (t) => {
  const f = fixture(t);
  const tickets = join(f.root, "tickets");
  const requests = join(f.root, "requests");
  mkdirSync(tickets); mkdirSync(requests);
  const requestHash = H("1");
  writeFileSync(join(tickets, `${requestHash}.work-request.json`), JSON.stringify({
    schemaId: "xw.m6-4-device-read-work-ticket.v1", request: { purpose: "M6_4_SHADOW", requestHash },
  }));
  let clock = 1000;
  const next = createM64LocatorEventSource({ observationTicketRoot: tickets, handoffRequestRoot: requests,
    waitMs: 100, pollMs: 10, now: () => clock++, waitForPoll: async () => {} });
  const observation = await next({ purpose: "M6_4_SHADOW", phase: "OBSERVING" });
  assert.equal(observation.kind, "OBSERVATION");
  assert.equal(observation.requestHash, requestHash);
  const closeHash = H("2");
  const locatorRaw = { schemaId: "xw.m6-4-external-handoff-request-locator.v1", kind: "NORMAL_CLOSE_SIGNING",
    purpose: "M6_4_SHADOW", requestHash: closeHash, requestSha256: H("3"), artifactFileName: "request.json",
    responseDescriptorFileName: "response.json" };
  const locator = { ...locatorRaw, locatorHash: domainHash(locatorRaw.schemaId, locatorRaw) };
  writeFileSync(join(requests, `M6_4_SHADOW.${closeHash}.normal-close-signing.locator.json`), JSON.stringify(locator));
  const close = await next({ purpose: "M6_4_SHADOW", phase: "OBSERVING" });
  assert.equal(close.kind, "NORMAL_CLOSE_SIGNING");
  assert.equal(close.requestHash, closeHash);
});

test("automatic resume is forbidden once an append-only state journal exists", async (t) => {
  const f = fixture(t);
  const statePath = join(f.root, "coordinator.json");
  mkdirSync(`${statePath}.journal`);
  writeFileSync(join(`${statePath}.journal`, "prior.json"), "{}\n");
  await assert.rejects(runM64LiveHandoffCoordinator({ initialWindow: f.initial, statePath,
    windowInboxRoot: f.root, timeoutMs: 60_000 }, f.deps), { code: "M64_COORDINATOR_RESUME_FORBIDDEN" });
  assert.equal(f.trace.length, 0);
});

test("production config binds every injected helper/root and rejects path drift", (t) => {
  const f = fixture(t);
  const raw = {
    schemaId: "xw.m6-4-live-handoff-coordinator-config.v1",
    handoffPipeName: "xw-m6-4-handoff-12345678",
    handoffRequestRoot: join(f.root, "requests"),
    initialWindow: f.initial,
    observationTicketRoot: join(f.root, "tickets"),
    pipeline: { buildResponseRoot: join(f.root, "builds"), inventoryBuilderPath: join(f.root, "builder.mjs"),
      nodePath: join(f.root, "node.exe"), stageToolPath: join(f.root, "stage.mjs"),
      stagePaths: { finalBindingPath: join(f.root, "binding.json"), gateIssuerAllowlistPath: join(f.root, "gate.json"),
        liveIssuerAllowlistPath: join(f.root, "live.json"), runtimeSnapshotPath: join(f.root, "snapshot.json") } },
    pollMs: 50,
    signer: { invokePath: join(f.root, "invoke.ps1"), pipeName: "xw-m6-gate-f-signer-release-12345678",
      powershellPath: join(f.root, "powershell.exe") },
    statePath: join(f.root, "state.json"),
    statusHelper: { executable: join(f.root, "node.exe"), args: [join(f.root, "status.mjs")] },
    timeoutMs: 60_000,
    windowInboxRoot: join(f.root, "windows"),
  };
  const config = { ...raw, configHash: deriveM64LiveHandoffConfigHash(raw) };
  assert.equal(validateM64LiveHandoffCoordinatorConfig(config).configHash, config.configHash);
  assert.throws(() => validateM64LiveHandoffCoordinatorConfig({ ...config, pollMs: 51 }), { code: "M64_COORDINATOR_CONFIG_INVALID" });
});
