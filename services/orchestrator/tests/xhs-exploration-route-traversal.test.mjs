import assert from "node:assert/strict";
import test from "node:test";

import {
  XHS_CORPUS_EXACT_PAIR_BINDINGS,
  XHS_CORPUS_REQUIRED_ROUTES,
  XHS_CORPUS_ROUTE_VALIDATOR_ID,
  XHS_CORPUS_TRANSITION_RECEIPT_SCHEMA_ID,
  XHS_CORPUS_TYPED_DUMP_ROLES,
  XHS_CORPUS_ZERO_RESOURCES,
  createFixtureCorpusAdapter,
  createOfflineCorpusOperator,
  verifyExactPairTransitionReceipt,
} from "../scripts/lib/xhs-exploration-corpus-operator.mjs";
import { runCli } from "../ops/xw-xhs-exploration-corpus.mjs";

const KEY = Buffer.alloc(32, 0x61);
const KEY_ID = "p4a-route-fixture-key-v1";

function createOperator(adapter) {
  return createOfflineCorpusOperator({
    adapter,
    signingKey: KEY,
    digestKeyId: KEY_ID,
  });
}

function wrapAdapter(base, {
  mutateScenario = null,
  failCommitAlias = null,
  failReleaseAlias = null,
} = {}) {
  return Object.freeze({
    kind: base.kind,
    capability: base.capability,
    snapshotResources: () => base.snapshotResources(),
    readFixtureCaptures: () => base.readFixtureCaptures(),
    async readExactPairTraversal() {
      const scenario = await base.readExactPairTraversal();
      mutateScenario?.(scenario);
      return scenario;
    },
    openExactPairBarrier: (input) => base.openExactPairBarrier(input),
    reserveTypedTransition: (input) => base.reserveTypedTransition(input),
    async commitTypedTransition(token) {
      if (token?.proposal?.alias === failCommitAlias) {
        throw new Error("XHS_CORPUS_FAKE_COMMIT_INJECTED_FAILURE");
      }
      return base.commitTypedTransition(token);
    },
    async releaseExactPairLane(input) {
      const result = await base.releaseExactPairLane(input);
      if (input?.alias === failReleaseAlias) {
        throw new Error("XHS_CORPUS_FAKE_RELEASE_INJECTED_FAILURE");
      }
      return result;
    },
    snapshotTraversalAudit: () => base.snapshotTraversalAudit(),
  });
}

function createAttackAdapter(fault) {
  const base = createFixtureCorpusAdapter();
  return {
    base,
    adapter: wrapAdapter(base, {
      mutateScenario(scenario) {
        const first = scenario.lanesByPhase[0].lanes[0].steps[0];
        if (fault === "CALLER_ALIAS") scenario.callerAlias = "03";
        else if (fault === "CALLER_ENDPOINT") scenario.endpoint = "http://127.0.0.1:17920";
        else if (fault === "CALLER_PATH") scenario.providerPath = "C:\\mutable\\provider.py";
        else if (fault === "CALLER_MODULE") scenario.module = "caller-selected-module";
        else if (fault === "CALLER_ROLE") scenario.requestedRole = "OPEN_CONTENT_CARD";
        else if (fault === "FIXTURE_LABEL_COVERAGE") scenario.fixtureCoverageLabels = [...XHS_CORPUS_REQUIRED_ROUTES];
        else if (fault === "RAW_ADB") first.navigation.helper = "adb shell input tap";
        else if (fault === "RAW_22222") first.navigation.helper = "tcp://127.0.0.1:22222";
        else if (fault === "RAW_COORDINATE") first.navigation.coordinate = [360, 640];
        else if (fault === "RAW_INPUT") first.navigation.helper = "input text query";
        else if (fault === "RAW_SWIPE") first.navigation.helper = "swipe 1 2 3 4";
        else if (fault === "RAW_BACK_HELPER") first.navigation.helper = "input keyevent KEYCODE_BACK";
        else if (fault === "PROVIDER_DIRECTED") first.navigation.source = "PROVIDER";
        else if (fault === "ROLE_DRIFT") first.navigation.role = "PAUSE_VIDEO_SAFE_ZONE";
        else if (fault === "LANE_SWAP") scenario.lanesByPhase[0].lanes.reverse();
        else if (fault === "AMBIGUOUS_DUMP") first.pre.verdict = "AMBIGUOUS_SAFE";
        else if (fault === "RISKY_DUMP") first.pre.verdict = "FORBIDDEN_OR_RISKY";
        else if (fault === "ROUTE_DRIFT") first.post.page = "SEARCH_RESULTS";
        else if (fault === "DUMP_REPLAY") first.post.freshNonce = first.pre.freshNonce;
        else throw new Error(`unknown test fault ${fault}`);
      },
    }),
  };
}

function allTransitions(result) {
  return result.waves.flatMap((wave) => wave.lanes.flatMap((lane) => lane.transitions));
}

function allJournals(result) {
  return result.waves.flatMap((wave) => wave.lanes.map((lane) => lane.journal));
}

test("exact-[03,04] R1/R2 fake traversal reaches five routes only through committed typed DUMP receipts", async () => {
  const adapter = createFixtureCorpusAdapter();
  const result = await createOperator(adapter).traverse();

  assert.equal(result.passed, true);
  assert.equal(result.validatorId, XHS_CORPUS_ROUTE_VALIDATOR_ID);
  assert.deepEqual(result.phases, ["R1", "R2"]);
  assert.deepEqual(result.exactPairBindings, XHS_CORPUS_EXACT_PAIR_BINDINGS);
  assert.deepEqual(result.resources, XHS_CORPUS_ZERO_RESOURCES);
  assert.deepEqual(result.safety, {
    socialTransport: 0,
    effectTransport: 0,
    visualIssued: 0,
    visualConsumed: 0,
    visualPhysical: 0,
  });
  assert.deepEqual(result.coverage.reachedRoutes, XHS_CORPUS_REQUIRED_ROUTES);
  assert.equal(result.coverage.complete, true);
  assert.equal(result.coverage.evidenceSource, "COMMITTED_TRANSITION_RECEIPTS_ONLY");
  assert.equal(result.coverage.fixtureLabelsAccepted, false);

  assert.equal(result.waves.length, 2);
  for (const wave of result.waves) {
    assert.deepEqual(wave.lanes.map(({ alias, laneRole }) => ({ alias, laneRole })), XHS_CORPUS_EXACT_PAIR_BINDINGS);
    assert.deepEqual(wave.lanes.map((lane) => lane.status), ["COMMITTED", "COMMITTED"]);
    assert.equal(wave.cleanup.mode, "PROMISE_ALL_SETTLED");
    assert.equal(wave.cleanup.allSettled, true);
    assert.deepEqual(wave.cleanup.lanes, [
      { alias: "03", status: "RELEASED" },
      { alias: "04", status: "RELEASED" },
    ]);
    assert.ok(wave.lanes.every((lane) => lane.journal.authorityDigest === wave.authorityDigest));
    assert.ok(wave.lanes.every((lane) => lane.journal.barrierDigest === wave.barrierDigest));
    assert.deepEqual(wave.safety, result.safety);
  }

  const transitions = allTransitions(result);
  assert.equal(transitions.length, 28);
  const dumpHashes = new Set();
  const dumpNonces = new Set();
  const committedReceiptHashes = new Set();
  for (const transition of transitions) {
    assert.equal(transition.receipt.schemaId, XHS_CORPUS_TRANSITION_RECEIPT_SCHEMA_ID);
    assert.equal(transition.receipt.navigation.permitKind, "CP_TYPED_SINGLE_USE");
    assert.equal(transition.receipt.navigation.source, "DUMP");
    assert.ok(XHS_CORPUS_TYPED_DUMP_ROLES.includes(transition.receipt.navigation.role));
    assert.deepEqual(transition.receipt.safety, result.safety);
    assert.notEqual(transition.receipt.preconditionReceiptHash, transition.receipt.postconditionReceiptHash);
    assert.equal(transition.precondition.position, "PRE");
    assert.equal(transition.postcondition.position, "POST");
    assert.equal(transition.precondition.verdict, "COMPLETE_SAFE_UNIQUE");
    assert.equal(transition.postcondition.verdict, "COMPLETE_SAFE_UNIQUE");
    assert.notEqual(transition.precondition.freshNonce, transition.postcondition.freshNonce);
    assert.equal(dumpHashes.has(transition.receipt.preconditionReceiptHash), false);
    assert.equal(dumpHashes.has(transition.receipt.postconditionReceiptHash), false);
    dumpHashes.add(transition.receipt.preconditionReceiptHash);
    dumpHashes.add(transition.receipt.postconditionReceiptHash);
    assert.equal(dumpNonces.has(transition.precondition.freshNonce), false);
    assert.equal(dumpNonces.has(transition.postcondition.freshNonce), false);
    dumpNonces.add(transition.precondition.freshNonce);
    dumpNonces.add(transition.postcondition.freshNonce);
    const verified = verifyExactPairTransitionReceipt(transition.receipt, {
      signingKey: KEY,
      digestKeyId: KEY_ID,
    });
    assert.equal(verified.valid, true, verified.errors.map((error) => error.code).join(","));
    committedReceiptHashes.add(verified.receiptHash);
  }
  for (const hashes of Object.values(result.coverage.routeReceiptHashes)) {
    assert.ok(hashes.length > 0);
    assert.ok(hashes.every((hash) => committedReceiptHashes.has(hash)));
  }
  assert.equal(allJournals(result).length, 4);
  assert.ok(allJournals(result).every((journal) => journal.status === "COMMITTED"));
  assert.deepEqual(result.audit, {
    scenarioReads: 1,
    acquireBarriers: 2,
    reservations: 28,
    commits: 28,
    releases: 4,
    releaseAttempts: [
      { phase: "R1", alias: "03" },
      { phase: "R1", alias: "04" },
      { phase: "R2", alias: "03" },
      { phase: "R2", alias: "04" },
    ],
  });
});

test("direct fixture page labels cannot create or alter route coverage", async () => {
  const directLabels = XHS_CORPUS_REQUIRED_ROUTES.map((pageClass) => ({
    pageClass,
    alias: pageClass === "SEARCH_RESULTS" ? "04" : "03",
    fixtureClaimsRouteReached: true,
  }));
  const baseline = await createOperator(createFixtureCorpusAdapter()).traverse();
  const labelledAdapter = createFixtureCorpusAdapter({ captures: directLabels });
  const labelled = await createOperator(labelledAdapter).traverse();
  assert.equal(labelled.coverage.fixtureLabelsAccepted, false);
  assert.equal(labelled.coverage.evidenceSource, "COMMITTED_TRANSITION_RECEIPTS_ONLY");
  assert.deepEqual(labelled.coverage, baseline.coverage);
  assert.equal(labelled.scenarioHash, baseline.scenarioHash);
  assert.equal(labelled.audit.scenarioReads, 1);
  assert.deepEqual(labelled.resources, XHS_CORPUS_ZERO_RESOURCES);
});

test("every caller/raw/provider/DUMP attack reaches the real route validator before barrier or reservation", async (t) => {
  const cases = [
    ["CALLER_ALIAS", "XHS_CORPUS_TRAVERSAL_CALLER_FIELD_FORBIDDEN"],
    ["CALLER_ENDPOINT", "XHS_CORPUS_TRAVERSAL_CALLER_FIELD_FORBIDDEN"],
    ["CALLER_PATH", "XHS_CORPUS_TRAVERSAL_CALLER_FIELD_FORBIDDEN"],
    ["CALLER_MODULE", "XHS_CORPUS_TRAVERSAL_CALLER_FIELD_FORBIDDEN"],
    ["CALLER_ROLE", "XHS_CORPUS_TRAVERSAL_CALLER_FIELD_FORBIDDEN"],
    ["FIXTURE_LABEL_COVERAGE", "XHS_CORPUS_TRAVERSAL_FIXTURE_LABEL_AUTHORITY_FORBIDDEN"],
    ["RAW_ADB", "XHS_CORPUS_TRAVERSAL_RAW_HELPER_FORBIDDEN"],
    ["RAW_22222", "XHS_CORPUS_TRAVERSAL_RAW_HELPER_FORBIDDEN"],
    ["RAW_COORDINATE", "XHS_CORPUS_TRAVERSAL_CALLER_GEOMETRY_FORBIDDEN"],
    ["RAW_INPUT", "XHS_CORPUS_TRAVERSAL_RAW_HELPER_FORBIDDEN"],
    ["RAW_SWIPE", "XHS_CORPUS_TRAVERSAL_RAW_HELPER_FORBIDDEN"],
    ["RAW_BACK_HELPER", "XHS_CORPUS_TRAVERSAL_RAW_HELPER_FORBIDDEN"],
    ["PROVIDER_DIRECTED", "XHS_CORPUS_TRAVERSAL_PROVIDER_AUTHORITY_FORBIDDEN"],
    ["ROLE_DRIFT", "XHS_CORPUS_TRAVERSAL_ROLE_DRIFT"],
    ["LANE_SWAP", "XHS_CORPUS_TRAVERSAL_LANE_DRIFT"],
    ["AMBIGUOUS_DUMP", "XHS_CORPUS_TRAVERSAL_DUMP_NOT_UNIQUE"],
    ["RISKY_DUMP", "XHS_CORPUS_TRAVERSAL_DUMP_RISK_STOP"],
    ["ROUTE_DRIFT", "XHS_CORPUS_TRAVERSAL_ROUTE_DRIFT"],
    ["DUMP_REPLAY", "XHS_CORPUS_TRAVERSAL_DUMP_NOT_FRESH"],
  ];
  for (const [fault, code] of cases) {
    await t.test(fault, async () => {
      const { adapter, base } = createAttackAdapter(fault);
      await assert.rejects(createOperator(adapter).traverse(), (error) => {
        assert.equal(error.code, code);
        assert.equal(error.validator, XHS_CORPUS_ROUTE_VALIDATOR_ID);
        assert.equal(error.stage, "SCENARIO_VALIDATION");
        return true;
      });
      assert.deepEqual(base.snapshotTraversalAudit(), {
        scenarioReads: 1,
        acquireBarriers: 0,
        reservations: 0,
        commits: 0,
        releases: 0,
        releaseAttempts: [],
      });
      assert.deepEqual(base.snapshotResources(), XHS_CORPUS_ZERO_RESOURCES);
    });
  }
});

test("mid-transition and release failures still use all-settled cleanup and leave the real resource oracle at zero", async (t) => {
  await t.test("one lane commit fails", async () => {
    const base = createFixtureCorpusAdapter();
    const adapter = wrapAdapter(base, { failCommitAlias: "04" });
    await assert.rejects(createOperator(adapter).traverse(), (error) => {
      assert.match(error.message, /FAKE_COMMIT_INJECTED_FAILURE/);
      assert.equal(error.cleanup.mode, "PROMISE_ALL_SETTLED");
      assert.equal(error.cleanup.allSettled, true);
      assert.deepEqual(error.cleanup.lanes, [
        { alias: "03", status: "RELEASED" },
        { alias: "04", status: "RELEASED" },
      ]);
      assert.deepEqual(error.laneSettled, [
        { alias: "03", status: "fulfilled" },
        { alias: "04", status: "rejected" },
      ]);
      return true;
    });
    const audit = base.snapshotTraversalAudit();
    assert.equal(audit.acquireBarriers, 1);
    assert.equal(audit.releases, 2);
    assert.deepEqual(audit.releaseAttempts, [
      { phase: "R1", alias: "03" },
      { phase: "R1", alias: "04" },
    ]);
    assert.deepEqual(base.snapshotResources(), XHS_CORPUS_ZERO_RESOURCES);
  });

  await t.test("one lane release fails", async () => {
    const base = createFixtureCorpusAdapter();
    const adapter = wrapAdapter(base, { failReleaseAlias: "04" });
    await assert.rejects(createOperator(adapter).traverse(), (error) => {
      assert.equal(error.cleanup.mode, "PROMISE_ALL_SETTLED");
      assert.equal(error.cleanup.allSettled, true);
      assert.deepEqual(error.cleanup.lanes, [
        { alias: "03", status: "RELEASED" },
        { alias: "04", status: "RELEASE_FAILED" },
      ]);
      return true;
    });
    assert.equal(base.snapshotTraversalAudit().releases, 2);
    assert.deepEqual(base.snapshotResources(), XHS_CORPUS_ZERO_RESOURCES);
  });
});

test("transition receipts are recursively immutable and any role/hash mutation fails HMAC verification", async () => {
  const result = await createOperator(createFixtureCorpusAdapter()).traverse();
  const receipt = allTransitions(result)[0].receipt;
  assert.equal(Object.isFrozen(receipt), true);
  assert.equal(Object.isFrozen(receipt.navigation), true);
  assert.equal(Object.isFrozen(receipt.authentication), true);

  const roleDrift = structuredClone(receipt);
  roleDrift.navigation.role = "BACK";
  const roleResult = verifyExactPairTransitionReceipt(roleDrift, {
    signingKey: KEY,
    digestKeyId: KEY_ID,
  });
  assert.equal(roleResult.valid, false);
  assert.ok(roleResult.errors.some((error) => error.code === "XHS_CORPUS_TRANSITION_RECEIPT_AUTH_INVALID"));

  const preDrift = structuredClone(receipt);
  preDrift.preconditionReceiptHash = "f".repeat(64);
  const preResult = verifyExactPairTransitionReceipt(preDrift, {
    signingKey: KEY,
    digestKeyId: KEY_ID,
  });
  assert.equal(preResult.valid, false);
  assert.ok(preResult.errors.some((error) => error.code === "XHS_CORPUS_TRANSITION_RECEIPT_AUTH_INVALID"));
});

test("tracked CLI exposes the sealed traversal without caller alias/endpoint/path/module/role selectors", async () => {
  const result = await runCli(["traverse"]);
  assert.equal(result.passed, true);
  assert.deepEqual(result.coverage.reachedRoutes, XHS_CORPUS_REQUIRED_ROUTES);
  assert.deepEqual(result.resources, XHS_CORPUS_ZERO_RESOURCES);
  for (const args of [
    ["traverse", "--alias", "03"],
    ["traverse", "--endpoint", "http://127.0.0.1:17920"],
    ["traverse", "--path", "C:\\mutable"],
    ["traverse", "--module", "custom"],
    ["traverse", "--role", "OPEN_CONTENT_CARD"],
  ]) {
    await assert.rejects(runCli(args), /unsupported argument/);
  }
});
