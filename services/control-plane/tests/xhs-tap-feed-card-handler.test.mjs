/**
 * xhs-tap-feed-card-handler.test.mjs — offline tests for the composite
 * `tapFeedCard` recipe handler + receipt passthrough. No device I/O: the
 * explorer primitives and the dump artifact reader are injected fakes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { createRecipePrimitiveHandlers } from "../control-plane/lib/recipe-primitive-handlers.mjs";
import { SingleDeviceRecipeRunner } from "../control-plane/lib/single-device-recipe-runner.mjs";
import { validateRecipeSteps } from "../control-plane/lib/recipe-interpreter.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const NOTE_READ = JSON.parse(
  readFileSync(join(HERE, "..", "config", "recipes", "xhs.note.read.fixed@1.json"), "utf8"),
);

const FEED_XML =
  '<hierarchy><node bounds="[0,0][1080,2400]"/>' +
  '<node content-desc="笔记 标题A 来自作者A 123赞" bounds="[10,300][530,900]"/></hierarchy>';

/** Handler-level test with injected primitives + artifact reader. */
function makeHandlers({ feedXml = FEED_XML, primitiveCalls = [] } = {}) {
  return createRecipePrimitiveHandlers({
    executePrimitive: async ({ params, stepId }) => {
      primitiveCalls.push({ stepId, primitive: params.primitive, params });
      if (params.primitive === "dump_ui") {
        return {
          jobId: "jd1",
          status: "succeeded",
          runId: "run_dump1",
          storage: { runDirectory: "C:\\fake\\runs\\run_dump1" },
          result: { output: { ok: true, bytes: 100, path: "C:\\fake\\runs\\run_dump1\\dump-ui.xml" } },
        };
      }
      return { jobId: "jt1", status: "succeeded", result: { output: { ok: true } } };
    },
    readDumpXml: () => feedXml,
    sleepFn: async () => {},
  });
}

test("tapFeedCard handler: dump → select → tap, selection + dumpJobId returned", async () => {
  const calls = [];
  const handlers = makeHandlers({ primitiveCalls: calls });
  const out = await handlers.tapFeedCard({
    session: { sessionId: "s", leaseId: "l", leased: true },
    step: { id: "tap_feed_card", kind: "tapFeedCard", params: { pickIndex: 0, preferKind: "image", fallbackToAny: true } },
    call: { op: "tapFeedCard", args: { pickIndex: 0, preferKind: "image", fallbackToAny: true } },
  });
  assert.equal(out.ok, true);
  assert.deepEqual(
    calls.map((c) => c.primitive),
    ["dump_ui", "tap"],
    "exactly one sense dump then one tap",
  );
  assert.equal(calls[1].params.x, 270);
  assert.equal(calls[1].params.y, 600);
  assert.equal(out.dumpJobId, "jd1");
  assert.equal(out.selection.title, "标题A");
  assert.equal(out.selection.kind, "note");
  assert.equal(out.kind, "tapFeedCard");
});

test("tapFeedCard: unreadable dump fails with TAP_FEED_CARD_DUMP_EMPTY", async () => {
  const handlers = makeHandlers({ feedXml: "" });
  await assert.rejects(
    () =>
      handlers.tapFeedCard({
        session: { sessionId: "s", leaseId: "l", leased: true },
        step: { id: "t", kind: "tapFeedCard", params: {} },
        call: { op: "tapFeedCard", args: {} },
      }),
    (e) => e.code === "TAP_FEED_CARD_DUMP_EMPTY" && e.details.dumpJobId === "jd1",
  );
});

test("tapFeedCard: selection failure carries dumpJobId in details", async () => {
  const handlers = makeHandlers({ feedXml: "<hierarchy><node bounds=\"[0,0][1080,2400]\"/></hierarchy>" });
  await assert.rejects(
    () =>
      handlers.tapFeedCard({
        session: { sessionId: "s", leaseId: "l", leased: true },
        step: { id: "t", kind: "tapFeedCard", params: {} },
        call: { op: "tapFeedCard", args: {} },
      }),
    (e) => e.code === "TAP_FEED_CARD_NO_CARDS" && e.details.dumpJobId === "jd1",
  );
});

test("tapFeedCard step is whitelisted and validates params", () => {
  const step = NOTE_READ.executor.steps.find((s) => s.kind === "tapFeedCard");
  const { ok, steps } = validateRecipeSteps([step]);
  assert.equal(ok, true);
  assert.deepEqual(steps[0].params, { fallbackToAny: true, pickIndex: 0, preferKind: "image" });
  assert.throws(
    () => validateRecipeSteps([{ id: "x", kind: "tapFeedCard", params: { pickIndex: 99 } }]),
    /pickIndex/,
  );
  assert.throws(
    () => validateRecipeSteps([{ id: "x", kind: "tapFeedCard", params: { preferKind: "audio" } }]),
    /preferKind/,
  );
});

test("Runner live path: selection flows into stepResult (receipt passthrough)", async () => {
  const runner = new SingleDeviceRecipeRunner({
    createSession: async () => ({ sessionId: "s1", leaseId: "l1", token: "tok", deviceId: "d1" }),
    executeSessionAction: async (_sid, _tok, { params }) => {
      if (params.primitive === "dump_ui") {
        // Inline xml → the artifact reader is never exercised on this path.
        return { jobId: "jd", status: "succeeded", result: { output: { ok: true, xml: FEED_XML } } };
      }
      return { jobId: "jt", status: "succeeded", result: { output: { ok: true } } };
    },
    releaseSession: async () => {},
    sleepFn: async () => {},
    observeForAssert: async () => ({
      package: "com.xingin.xhs",
      activity: "com.xingin.xhs.index.v3.NoteDetailActivity",
      // tap_feed_card's sealed postAssertion is textExists 说点什么 — the
      // observation must carry the detail-screen dump for it to pass.
      dumpXml: '<node text="说点什么..." bounds="[0,2200][1080,2300]"/>',
    }),
  });

  const liveRecipe = {
    ...structuredClone(NOTE_READ),
    status: "canary_only",
    eligibleAliases: ["04"],
  };
  // Trim to the tap step only: single-step live recipe exercising tapFeedCard.
  liveRecipe.executor = { kind: "primitive_steps", steps: [NOTE_READ.executor.steps[2]] };
  liveRecipe.postAssertions = undefined;
  // Trimmed executor is a different spec — drop the sealed hash, the runner
  // re-seals its own (tamper check only applies to provided hashes).
  delete liveRecipe.descriptorHash;

  const run = await runner.start({
    recipe: liveRecipe,
    params: {},
    actorId: "agent:test",
    live: true,
  });
  assert.equal(run.status, "SUCCEEDED", JSON.stringify(run.error));
  const result = run.stepResults[0].result;
  assert.equal(result.dumpJobId, "jd");
  assert.equal(result.selection.title, "标题A");
  assert.equal(result.selection.x, 270);
});
test("Runner live path: post-assertion reads the on-disk dump artifact (fs fallback)", async () => {
  // Live dump jobs return {bytes, ok, path} with no inline xml. The runner's
  // assertion observation must read the bound artifact for textExists to work.
  const detailXml =
    '<hierarchy><node bounds="[0,0][1080,2400]"/>' +
    // Feed card for the selection phase + detail chrome for the assertion phase
    // (the mocked dump job serves both).
    '<node content-desc="笔记 标题C 来自作者C 3赞" bounds="[10,300][530,900]"/>' +
    '<node text="作者A" bounds="[140,120][300,180]"/>' +
    '<node text="说点什么..." bounds="[600,2210][1000,2290]"/></hierarchy>';
  // Materialize a properly bound run artifact: basename(runDirectory) === runId.
  const runId = "run_dump2_assert_fallback";
  const runDir = join(tmpdir(), runId);
  rmSync(runDir, { recursive: true, force: true });
  mkdirSync(runDir, { recursive: true });
  const dumpPath = join(runDir, "dump-ui.xml");
  writeFileSync(dumpPath, detailXml);
  const runner = new SingleDeviceRecipeRunner({
    createSession: async () => ({ sessionId: "s2", leaseId: "l2", token: "tok2", deviceId: "d2" }),
    executeSessionAction: async (_sid, _tok, { params }) => {
      if (params.primitive === "dump_ui") {
        return {
          jobId: "jd2",
          status: "succeeded",
          runId,
          storage: { runDirectory: runDir },
          result: { output: { ok: true, bytes: detailXml.length, path: dumpPath } },
        };
      }
      return { jobId: "jt2", status: "succeeded", result: { output: { ok: true } } };
    },
    releaseSession: async () => {},
    sleepFn: async () => {},
    // No observeForAssert: exercise the real #observe → fs fallback path.
  });

  const liveRecipe = {
    ...structuredClone(NOTE_READ),
    status: "canary_only",
    eligibleAliases: ["04"],
  };
  liveRecipe.executor = { kind: "primitive_steps", steps: [NOTE_READ.executor.steps[2]] };
  delete liveRecipe.descriptorHash;

  const run = await runner.start({
    recipe: liveRecipe,
    params: {},
    actorId: "agent:test",
    live: true,
  });
  assert.equal(run.status, "SUCCEEDED", JSON.stringify(run.error));
  assert.equal(run.stepResults[0].postAssertions.ok, true);
});
