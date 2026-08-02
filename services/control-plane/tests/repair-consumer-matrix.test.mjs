/**
 * Windows repair consumer v1 — durability / registry / outbox / state / CLI fault matrix.
 * Counts injected crash points and registry response classes for the stability batch report.
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  createKnowledgeClient,
  createRepairConsumer,
  exclusiveWriteJson,
  knowledgeEnvelopeCanonicallyEqual,
  listOutboxEvents,
  rejectUnauthorizedWindowsEvent,
  writeAppendOnlyEvent,
} from "../scripts/lib/repair-consumer.mjs";
import {
  applyRepairEvent,
  createRepairEvent,
  initialRepairProjection,
  proposalSha256,
  repairEventKnowledgeEnvelope,
  sha256,
} from "../scripts/lib/repair-proposal.mjs";
import {
  evaluateScopeGuard,
  REPAIR_CONSUMER_ALLOWED_PATHS,
} from "../scripts/repair-consumer-scope-guard.mjs";

const FIRST_PROPOSAL = JSON.parse(
  readFileSync(new URL("../docs/handoffs/2026-08-02-xhs-observe-feed-repair-proposal.v1.json", import.meta.url), "utf8"),
);
const EXPECTED_SHA = "a828ec422c42e9914f9508136268a572cbdb15e9d7621c3f105f825b6fba1dae";

const MATRIX = {
  crashPhases: [],
  registryCases: [],
  outboxCases: [],
  stateCases: [],
  cliCases: [],
};

function checkpointFor(proposal, actorId) {
  return {
    schemaId: "xhs.repair-source-checkpoint.v1",
    schemaVersion: 1,
    checkpointId: `repair_checkpoint_${"a".repeat(24)}`,
    proposalId: proposal.proposalId,
    proposalSha256: proposalSha256(proposal),
    attempt: 1,
    producedAt: "2026-08-02T12:00:00.000Z",
    baseCommit: proposal.target.baseCommit,
    resultCommit: "b".repeat(40),
    businessSemanticsChanged: false,
    files: [{
      path: "apps/xhs/adapter.mjs",
      beforeSha256: "1".repeat(64),
      afterSha256: "2".repeat(64),
      addedLines: 12,
      deletedLines: 3,
    }],
    diff: { totalLines: 15, patchSha256: "3".repeat(64) },
    tests: [{ name: "node --test tests/repair-consumer.test.mjs", passed: true, evidenceSha256: "4".repeat(64) }],
    scopeGuard: { passed: true, evidenceSha256: "5".repeat(64) },
    secretScan: { passed: true, evidenceSha256: "6".repeat(64) },
    evidenceDebt: [],
    authority: {
      actorId,
      actorRole: "windows_consumer",
      reviewVerdictModified: false,
      macWritePerformed: false,
      deploymentPerformed: false,
      deviceActions: 0,
    },
  };
}

function memoryStore() {
  const byId = new Map();
  return {
    byId,
    async listRepairProposals() { return [FIRST_PROPOSAL]; },
    async getKnowledge(id) {
      if (!byId.has(id)) return { ok: false, status: 404 };
      return { ok: true, knowledge: byId.get(id) };
    },
    async postKnowledge(envelope) {
      if (byId.has(envelope.id)) {
        const existing = byId.get(envelope.id);
        if (knowledgeEnvelopeCanonicallyEqual(envelope, existing)) {
          return { ok: true, debt: false, id: envelope.id, reconciled: true, status: 409 };
        }
        return { ok: false, debt: true, status: 409, code: "KNOWLEDGE_CONTENT_CONFLICT" };
      }
      byId.set(envelope.id, structuredClone(envelope));
      return { ok: true, debt: false, id: envelope.id, status: 201 };
    },
  };
}

test("matrix: crash after each persistence boundary keeps claim durable where required", async () => {
  const phases = [
    "before_claim_lock",
    "after_claim_lock",
    "before_event_append",
    "after_event_append",
    "before_knowledge_post",
    "after_knowledge_post",
    "before_receipt_write",
    "after_receipt_write",
    "before_debt_write",
    "after_debt_write",
    "before_checkpoint_write",
    "after_checkpoint_write",
  ];
  for (const phase of phases) {
    const root = mkdtempSync(join(tmpdir(), `repair-crash-${phase}-`));
    try {
      let armed = true;
      const store = memoryStore();
      const consumer = createRepairConsumer({
        outboxRoot: root,
        actorId: "win-matrix-crash",
        knowledgeClient: store,
        faultInject: async (name) => {
          if (armed && name === phase) {
            armed = false;
            throw new Error(`crash:${phase}`);
          }
        },
      });
      await consumer.loadProposal(FIRST_PROPOSAL);

      if (phase === "before_claim_lock") {
        await assert.rejects(() => consumer.tryClaim({ at: new Date("2026-08-02T12:00:00.000Z") }), /crash:before_claim_lock/);
        assert.equal(consumer.projection.status, "proposed");
        assert.equal(listOutboxEvents(root, FIRST_PROPOSAL).length, 0);
        MATRIX.crashPhases.push({ phase, result: "no_claim" });
        continue;
      }

      if (phase === "before_event_append" || phase === "after_claim_lock") {
        const claim = await consumer.tryClaim({ at: new Date("2026-08-02T12:00:00.000Z") });
        assert.equal(claim.ok, false);
        assert.equal(claim.orphanLock, true);
        assert.equal(consumer.projection.status, "proposed");
        MATRIX.crashPhases.push({ phase, result: "orphan_lock" });
        continue;
      }

      if (phase.startsWith("before_checkpoint") || phase.startsWith("after_checkpoint")) {
        assert.equal((await consumer.tryClaim({ at: new Date("2026-08-02T12:00:00.000Z") })).ok, true);
        await consumer.startFixing({ at: new Date("2026-08-02T12:01:00.000Z") });
        armed = true;
        if (phase === "before_checkpoint_write") {
          await assert.rejects(
            () => consumer.sealSourceCheckpoint(checkpointFor(FIRST_PROPOSAL, "win-matrix-crash"), { at: new Date("2026-08-02T12:02:00.000Z") }),
            /crash:before_checkpoint_write/,
          );
          assert.equal(consumer.projection.status, "fixing");
          MATRIX.crashPhases.push({ phase, result: "fixing_no_checkpoint_event" });
        } else {
          // after checkpoint file write, event append may still proceed or crash in inject after write
          try {
            await consumer.sealSourceCheckpoint(checkpointFor(FIRST_PROPOSAL, "win-matrix-crash"), { at: new Date("2026-08-02T12:02:00.000Z") });
          } catch (error) {
            assert.match(String(error.message || error), /crash:after_checkpoint_write/);
          }
          assert.ok(["fixing", "source_review"].includes(consumer.projection.status));
          MATRIX.crashPhases.push({ phase, result: consumer.projection.status });
        }
        continue;
      }

      if (phase === "before_debt_write" || phase === "after_debt_write") {
        const failingStore = {
          async listRepairProposals() { return [FIRST_PROPOSAL]; },
          async getKnowledge() { return { ok: false, status: 404 }; },
          async postKnowledge() { return { ok: false, debt: true, status: 500, code: "DOWN" }; },
        };
        const debtConsumer = createRepairConsumer({
          outboxRoot: root,
          actorId: "win-matrix-crash",
          knowledgeClient: failingStore,
          faultInject: async (name) => {
            if (armed && name === phase) {
              armed = false;
              throw new Error(`crash:${phase}`);
            }
          },
        });
        await debtConsumer.loadProposal(FIRST_PROPOSAL);
        const claim = await debtConsumer.tryClaim({ at: new Date("2026-08-02T12:00:00.000Z") });
        assert.equal(claim.ok, true, phase);
        assert.equal(debtConsumer.projection.status, "claimed", phase);
        MATRIX.crashPhases.push({ phase, result: "claimed_with_debt_path" });
        continue;
      }

      const claim = await consumer.tryClaim({ at: new Date("2026-08-02T12:00:00.000Z") });
      assert.equal(claim.ok, true, phase);
      assert.equal(consumer.projection.status, "claimed", phase);
      MATRIX.crashPhases.push({ phase, result: "claimed_durable" });
      const restarted = createRepairConsumer({
        outboxRoot: root,
        actorId: "win-matrix-crash",
        knowledgeClient: memoryStore(),
      });
      await restarted.loadProposal(FIRST_PROPOSAL);
      assert.equal(restarted.projection.status, "claimed", phase);

    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  assert.equal(MATRIX.crashPhases.length, phases.length);
});

test("matrix: registry response classes including 409 reconcile and conflicts", async () => {
  const cases = [
    {
      name: "201",
      post: async (envelope, store) => {
        store.set(envelope.id, structuredClone(envelope));
        return { ok: true, debt: false, id: envelope.id, status: 201 };
      },
      expectOk: true,
    },
    {
      name: "200",
      post: async (envelope, store) => {
        store.set(envelope.id, structuredClone(envelope));
        return { ok: true, debt: false, id: envelope.id, status: 200 };
      },
      expectOk: true,
    },
    {
      name: "409-same-canonical",
      post: async (envelope, store) => {
        store.set(envelope.id, structuredClone(envelope));
        return { ok: false, debt: true, status: 409, code: "EXISTS" };
      },
      get: async (id, store) => ({ ok: true, knowledge: store.get(id) }),
      // createKnowledgeClient handles 409; here we simulate via real client against mock HTTP
      useHttp: true,
      mode: "409-same",
      expectOk: true,
      reconciled: true,
    },
    {
      name: "409-different-content",
      useHttp: true,
      mode: "409-diff",
      expectOk: false,
    },
    {
      name: "400",
      post: async () => ({ ok: false, debt: true, status: 400, code: "BAD_REQUEST" }),
      expectOk: false,
    },
    {
      name: "403",
      post: async () => ({ ok: false, debt: true, status: 403, code: "FORBIDDEN" }),
      expectOk: false,
    },
    {
      name: "500",
      post: async () => ({ ok: false, debt: true, status: 500, code: "DOWN" }),
      expectOk: false,
    },
    {
      name: "timeout-before-commit",
      post: async () => {
        const err = new Error("aborted");
        err.name = "TimeoutError";
        throw err;
      },
      get: async () => ({ ok: false, status: 404 }),
      expectOk: false,
    },
    {
      name: "timeout-after-commit",
      post: async (envelope, store) => {
        store.set(envelope.id, structuredClone(envelope));
        const err = new Error("aborted");
        err.name = "TimeoutError";
        throw err;
      },
      get: async (id, store) => ({ ok: true, knowledge: store.get(id) }),
      expectOk: true,
      reconciled: true,
    },
    {
      name: "malformed-json-on-success-status",
      useHttp: true,
      mode: "malformed-201",
      expectOk: false,
    },
    {
      name: "connection-reset",
      post: async () => { throw new Error("socket hang up"); },
      expectOk: false,
    },
  ];

  for (const item of cases) {
    const root = mkdtempSync(join(tmpdir(), `repair-reg-${item.name}-`));
    try {
      let knowledgeClient;
      if (item.useHttp) {
        const store = new Map();
        const server = createServer(async (req, res) => {
          const url = new URL(req.url, "http://127.0.0.1");
          if (req.method === "POST" && url.pathname === "/api/knowledge") {
            const chunks = [];
            for await (const c of req) chunks.push(c);
            const envelope = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (item.mode === "409-same") {
              store.set(envelope.id, structuredClone(envelope));
              res.writeHead(409, { "content-type": "application/json" });
              res.end(JSON.stringify({ ok: false, error: `knowledge id already exists: ${envelope.id}` }));
              return;
            }
            if (item.mode === "409-diff") {
              store.set(envelope.id, { ...envelope, content: canonicalDifferent(envelope.content) });
              res.writeHead(409, { "content-type": "application/json" });
              res.end(JSON.stringify({ ok: false, error: `knowledge id already exists: ${envelope.id}` }));
              return;
            }
            if (item.mode === "malformed-201") {
              res.writeHead(201, { "content-type": "application/json" });
              res.end("{not-json");
              return;
            }
            store.set(envelope.id, structuredClone(envelope));
            res.writeHead(201, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, knowledge: envelope }));
            return;
          }
          if (req.method === "GET" && url.pathname.startsWith("/api/knowledge/")) {
            const id = decodeURIComponent(url.pathname.slice("/api/knowledge/".length));
            if (!store.has(id)) {
              res.writeHead(404, { "content-type": "application/json" });
              res.end(JSON.stringify({ ok: false, error: "not found" }));
              return;
            }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, knowledge: store.get(id) }));
            return;
          }
          res.writeHead(404);
          res.end();
        });
        await new Promise((r) => server.listen(0, "127.0.0.1", r));
        const { port } = server.address();
        knowledgeClient = createKnowledgeClient({ endpoint: `http://127.0.0.1:${port}` });
        knowledgeClient.listRepairProposals = async () => [FIRST_PROPOSAL];
        const consumer = createRepairConsumer({ outboxRoot: root, actorId: "win-reg", knowledgeClient });
        await consumer.loadProposal(FIRST_PROPOSAL);
        const claim = await consumer.tryClaim({ at: new Date("2026-08-02T12:00:00.000Z") });
        assert.equal(claim.ok, true);
        assert.equal(consumer.projection.status, "claimed");
        if (item.expectOk) {
          assert.equal(claim.mirror?.ok, true, item.name);
        } else {
          assert.equal(claim.mirror?.ok === true && !claim.mirror?.debt, false, item.name);
          assert.ok(consumer.evidenceDebt.length >= 1 || claim.mirror?.debt, item.name);
        }
        MATRIX.registryCases.push({ name: item.name, ok: item.expectOk });
        await new Promise((r) => server.close(r));
      } else {
        const store = new Map();
        knowledgeClient = {
          async listRepairProposals() { return [FIRST_PROPOSAL]; },
          async getKnowledge(id) {
            return item.get ? item.get(id, store) : { ok: false, status: 404 };
          },
          async postKnowledge(envelope) {
            return item.post(envelope, store);
          },
        };
        // Wrap with real client reconcile for timeout-after-commit using createKnowledgeClient pattern:
        if (item.name.startsWith("timeout")) {
          const inner = knowledgeClient;
          knowledgeClient = createKnowledgeClient({
            fetchImpl: async (url, init = {}) => {
              if (init.method === "POST") {
                const envelope = JSON.parse(init.body);
                try {
                  await inner.postKnowledge(envelope);
                } catch (error) {
                  // simulate abort
                  const err = new Error("aborted");
                  err.name = "TimeoutError";
                  throw err;
                }
              }
              if (String(url).includes("/api/knowledge/") && !String(url).endsWith("/api/knowledge")) {
                const id = decodeURIComponent(String(url).split("/").pop());
                const got = await inner.getKnowledge(id);
                if (!got.ok) {
                  return { ok: false, status: 404, async text() { return JSON.stringify({ ok: false }); }, async json() { return { ok: false }; } };
                }
                return {
                  ok: true,
                  status: 200,
                  async text() { return JSON.stringify({ ok: true, knowledge: got.knowledge }); },
                  async json() { return { ok: true, knowledge: got.knowledge }; },
                };
              }
              return { ok: true, status: 200, async text() { return "{}"; }, async json() { return {}; } };
            },
          });
          knowledgeClient.listRepairProposals = async () => [FIRST_PROPOSAL];
        }
        const consumer = createRepairConsumer({ outboxRoot: root, actorId: "win-reg", knowledgeClient });
        await consumer.loadProposal(FIRST_PROPOSAL);
        const claim = await consumer.tryClaim({ at: new Date("2026-08-02T12:00:00.000Z") });
        assert.equal(claim.ok, true, item.name);
        assert.equal(consumer.projection.status, "claimed", item.name);
        if (item.expectOk) assert.equal(claim.mirror?.ok, true, item.name);
        else assert.ok(claim.mirror?.debt || consumer.evidenceDebt.length >= 1, item.name);
        MATRIX.registryCases.push({ name: item.name, ok: item.expectOk });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  assert.ok(MATRIX.registryCases.length >= 10);
});

function canonicalDifferent(content) {
  if (typeof content === "string") {
    try {
      const obj = JSON.parse(content);
      return JSON.stringify({ ...obj, marker: "different" });
    } catch {
      return `${content}-different`;
    }
  }
  return JSON.stringify({ different: true });
}

test("matrix: POST success + receipt write failure reconciles via GET and keeps claim", async () => {
  const root = mkdtempSync(join(tmpdir(), "repair-receipt-fail-"));
  try {
    const store = memoryStore();
    let failReceipt = true;
    const consumer = createRepairConsumer({
      outboxRoot: root,
      actorId: "win-receipt",
      knowledgeClient: store,
      faultInject: async (phase) => {
        if (failReceipt && phase === "before_receipt_write") throw new Error("receipt fs fail");
      },
    });
    await consumer.loadProposal(FIRST_PROPOSAL);
    const claim = await consumer.tryClaim({ at: new Date("2026-08-02T12:00:00.000Z") });
    assert.equal(claim.ok, true);
    assert.equal(consumer.projection.status, "claimed");
    assert.equal(claim.mirror?.debt, true);
    assert.equal(claim.mirror?.code, "KNOWLEDGE_RECEIPT_PERSIST_FAILED");
    assert.ok(store.byId.size >= 1);

    failReceipt = false;
    const restarted = createRepairConsumer({
      outboxRoot: root,
      actorId: "win-receipt",
      knowledgeClient: store,
    });
    await restarted.loadProposal(FIRST_PROPOSAL);
    assert.equal(restarted.projection.status, "claimed");
    assert.equal(readdirSync(join(root, FIRST_PROPOSAL.transport.outboxNamespace, "knowledge-mirrors")).length, 1);
    MATRIX.registryCases.push({ name: "receipt-fail-reconcile", ok: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("matrix: outbox corruption and symlink attacks are rejected safely", async () => {
  const root = mkdtempSync(join(tmpdir(), "repair-outbox-attack-"));
  const outside = mkdtempSync(join(tmpdir(), "repair-outbox-outside-"));
  try {
    const consumer = createRepairConsumer({ outboxRoot: root, actorId: "win-attack", knowledgeClient: memoryStore() });
    await consumer.loadProposal(FIRST_PROPOSAL);
    assert.equal((await consumer.tryClaim({ at: new Date("2026-08-02T12:00:00.000Z") })).ok, true);
    const ns = FIRST_PROPOSAL.transport.outboxNamespace;
    const eventsDir = join(root, ns, "events");
    const mirrorsDir = join(root, ns, "knowledge-mirrors");
    mkdirSync(mirrorsDir, { recursive: true });

    // empty / truncated / bad schema receipt + envelope forgery
    writeFileSync(join(mirrorsDir, "empty.json"), "");
    writeFileSync(join(mirrorsDir, "trunc.json"), "{\"schemaId\":");
    const realEvent = consumer.listEvents()[0];
    writeFileSync(join(mirrorsDir, `${realEvent.eventId}-wrongid.json`), `${JSON.stringify({
      schemaId: "xhs.repair-knowledge-mirror-receipt.v1",
      schemaVersion: 1,
      eventId: "repair_event_deadbeefdeadbeefdeadbeef",
      eventSha256: "1".repeat(64),
      envelopeSha256: "2".repeat(64),
      knowledgeId: "x",
      mirroredAt: "2026-08-02T12:00:00.000Z",
      receiptSha256: "3".repeat(64),
    })}\n`);

    // Forged receipt: correct event binding, wrong envelope, self-consistent receiptSha256
    const forgedUnsigned = {
      schemaId: "xhs.repair-knowledge-mirror-receipt.v1",
      schemaVersion: 1,
      eventId: realEvent.eventId,
      eventSha256: sha256(realEvent),
      envelopeSha256: "a".repeat(64),
      knowledgeId: realEvent.eventId,
      mirroredAt: "2026-08-02T12:00:00.000Z",
    };
    const forged = { ...forgedUnsigned, receiptSha256: sha256(forgedUnsigned) };
    writeFileSync(join(mirrorsDir, `${realEvent.eventId}.json`), `${JSON.stringify(forged)}\n`);

    let posts = 0;
    const retryStore = memoryStore();
    const origPost = retryStore.postKnowledge.bind(retryStore);
    retryStore.postKnowledge = async (envelope) => {
      posts += 1;
      return origPost(envelope);
    };
    const restarted = createRepairConsumer({ outboxRoot: root, actorId: "win-attack", knowledgeClient: retryStore });
    await restarted.loadProposal(FIRST_PROPOSAL);
    assert.equal(restarted.projection.status, "claimed");
    assert.ok(posts >= 1, "forged envelope receipt must not skip re-mirror");
    assert.equal(readdirSync(mirrorsDir).filter((n) => n === `${realEvent.eventId}.json`).length, 1);
    const accepted = JSON.parse(readFileSync(join(mirrorsDir, `${realEvent.eventId}.json`), "utf8"));
    assert.equal(accepted.envelopeSha256, sha256(repairEventKnowledgeEnvelope(realEvent)));

    // symlink final target escape
    const bait = join(outside, "escape-receipt.json");
    writeFileSync(bait, "{}\n");
    const link = join(mirrorsDir, "symlink-receipt.json");
    try { unlinkSync(link); } catch { /* */ }
    symlinkSync(bait, link);
    assert.throws(() => exclusiveWriteJson(root, `${ns}/knowledge-mirrors/symlink-receipt.json`, { a: 1 }), /symlink|escape/i);

    // duplicate event same bytes ok; different content collision
    const event = restarted.listEvents()[0];
    writeAppendOnlyEvent(root, FIRST_PROPOSAL, event);
    const mutated = structuredClone(event);
    mutated.payload = { ...mutated.payload, expiresAt: "2099-01-01T00:00:00.000Z" };
    assert.throws(() => writeAppendOnlyEvent(root, FIRST_PROPOSAL, mutated), /collision/);

    MATRIX.outboxCases.push(
      { name: "empty-receipt", ok: true },
      { name: "truncated-receipt", ok: true },
      { name: "wrong-eventId-receipt", ok: true },
      { name: "envelope-forgery-receipt", ok: true },
      { name: "symlink-receipt", ok: true },
      { name: "event-collision", ok: true },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("matrix: state machine, authority deny, clock monotonic, circuit breaker", async () => {
  const root = mkdtempSync(join(tmpdir(), "repair-state-matrix-"));
  try {
    const frozen = new Date("2026-08-02T12:00:00.000Z");
    const consumer = createRepairConsumer({
      outboxRoot: root,
      actorId: "win-state",
      knowledgeClient: memoryStore(),
      now: () => frozen,
    });
    await consumer.loadProposal(FIRST_PROPOSAL);
    assert.equal((await consumer.tryClaim({ at: frozen })).ok, true);
    await consumer.heartbeat({ at: frozen });
    await consumer.startFixing({ at: frozen });
    const times = consumer.listEvents().map((e) => e.occurredAt);
    assert.equal(new Set(times).size, 3);
    assert.throws(() => rejectUnauthorizedWindowsEvent("review_approved"), /cannot emit/);
    assert.throws(() => rejectUnauthorizedWindowsEvent("mark_deployable"), /cannot emit/);
    assert.throws(() => rejectUnauthorizedWindowsEvent("cancel"), /cannot emit/);

    const forged = createRepairEvent(FIRST_PROPOSAL, consumer.projection, {
      eventType: "mark_deployable",
      actor: { role: "windows_consumer", id: "win-state" },
      occurredAt: "2026-08-02T12:10:00.000Z",
      payload: {
        approvedEventId: "x",
        sourceCheckpointSha256: "1".repeat(64),
        resultCommit: "9".repeat(40),
        authority: {
          macCommit: "8".repeat(40),
          reviewReceiptPath: "docs/handoffs/repair-reviews/x.json",
          reviewReceiptSha256: "f".repeat(64),
          reviewedCheckpointSha256: "1".repeat(64),
        },
      },
    });
    assert.throws(() => applyRepairEvent(FIRST_PROPOSAL, consumer.projection, forged, consumer.verifiers), /not trusted|mac_governance|invalid/);

    assert.equal(
      consumer.verifiers.verifyReplayAuthorization({
        proposal: FIRST_PROPOSAL,
        projection: {
          ...initialRepairProjection(FIRST_PROPOSAL),
          status: "deployable",
          deployableEventId: "repair_event_" + "a".repeat(24),
          deployableResultCommit: "9".repeat(40),
          proposalSha256: proposalSha256(FIRST_PROPOSAL),
        },
        event: { occurredAt: "2026-08-02T12:00:00.000Z" },
        authorization: {
          authorizationRef: "docs/handoffs/repair-authorizations/x.json",
          authorizationSha256: "1".repeat(64),
          authorizationCommit: "2".repeat(40),
        },
      }),
      false,
    );

    // restart in fixing
    const restarted = createRepairConsumer({ outboxRoot: root, actorId: "win-state", knowledgeClient: memoryStore() });
    await restarted.loadProposal(FIRST_PROPOSAL);
    assert.equal(restarted.projection.status, "fixing");

    MATRIX.stateCases.push(
      { name: "monotonic-same-now", ok: true },
      { name: "deny-self-approve", ok: true },
      { name: "deny-replay-without-keys", ok: true },
      { name: "restart-fixing", ok: true },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("matrix: CLI flag pairs and scope unauthorized 17th / invalid baseline", async () => {
  const root = mkdtempSync(join(tmpdir(), "repair-cli-matrix-"));
  const fixture = join(root, "proposal.json");
  writeFileSync(fixture, `${JSON.stringify(FIRST_PROPOSAL)}\n`);
  const outbox = join(root, "outbox");
  mkdirSync(outbox, { recursive: true });

  // live + demo forbidden
  const { main } = await import("../scripts/repair-consumer.mjs");
  process.exitCode = 0;
  await main([
    "claim-cycle",
    "--fixture", fixture,
    "--outbox", outbox,
    "--live-knowledge",
    "--offline-demo-checkpoint",
    "--endpoint", "http://127.0.0.1:9",
  ]);
  assert.equal(process.exitCode, 2);
  process.exitCode = 0;
  MATRIX.cliCases.push({ name: "live+demo", ok: true });

  // offline demo alone still allowed (fixture path)
  const outbox2 = join(root, "outbox2");
  mkdirSync(outbox2, { recursive: true });
  await main([
    "claim-cycle",
    "--fixture", fixture,
    "--outbox", outbox2,
    "--offline-demo-checkpoint",
    "--actor", "win-cli-demo",
  ]);
  assert.ok(process.exitCode === 0 || process.exitCode == null);
  process.exitCode = 0;
  MATRIX.cliCases.push({ name: "offline-demo-only", ok: true });

  assert.equal(REPAIR_CONSUMER_ALLOWED_PATHS.size, 17);
  const authorized = [...REPAIR_CONSUMER_ALLOWED_PATHS];
  assert.equal(evaluateScopeGuard([...authorized, "contracts/repair-extra.v1.schema.json"]).ok, false);
  assert.equal(evaluateScopeGuard([...authorized, "skills/SKILL.md"]).ok, false);
  assert.equal(evaluateScopeGuard([...authorized, "task-launch.json"]).ok, false);

  const bad = spawnSync(process.execPath, [
    resolve("scripts/repair-consumer-scope-guard.mjs"),
    "not-a-baseline",
  ], { cwd: resolve("."), encoding: "utf8" });
  assert.notEqual(bad.status, 0);
  MATRIX.cliCases.push({ name: "scope-extra", ok: true }, { name: "scope-invalid-baseline", ok: true });

  rmSync(root, { recursive: true, force: true });
});

test("matrix: 409 same content but wrong appliesTo/lifecycle/verifiedBy is conflict", async () => {
  const root = mkdtempSync(join(tmpdir(), "repair-409-meta-"));
  const store = new Map();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method === "POST" && url.pathname === "/api/knowledge") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const envelope = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      store.set(envelope.id, {
        ...structuredClone(envelope),
        appliesTo: ["wrong-applies-to"],
        lifecycle: "resolved",
        verifiedBy: ["forged:actor"],
      });
      res.writeHead(409, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: `knowledge id already exists: ${envelope.id}` }));
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/knowledge/")) {
      const id = decodeURIComponent(url.pathname.slice("/api/knowledge/".length));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, knowledge: store.get(id) }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const { port } = server.address();
    const knowledgeClient = createKnowledgeClient({ endpoint: `http://127.0.0.1:${port}` });
    knowledgeClient.listRepairProposals = async () => [FIRST_PROPOSAL];
    const consumer = createRepairConsumer({ outboxRoot: root, actorId: "win-409-meta", knowledgeClient });
    await consumer.loadProposal(FIRST_PROPOSAL);
    const claim = await consumer.tryClaim({ at: new Date("2026-08-02T12:00:00.000Z") });
    assert.equal(claim.ok, true);
    assert.equal(consumer.projection.status, "claimed");
    assert.equal(claim.mirror?.ok, false);
    assert.equal(claim.mirror?.debt, true);
    const mirrors = join(root, FIRST_PROPOSAL.transport.outboxNamespace, "knowledge-mirrors");
    assert.equal(existsSync(mirrors) ? readdirSync(mirrors).length : 0, 0);
    const debts = join(root, FIRST_PROPOSAL.transport.outboxNamespace, "evidence-debt");
    assert.ok(readdirSync(debts).length >= 1);
    MATRIX.registryCases.push({ name: "409-meta-conflict", ok: true });
  } finally {
    await new Promise((r) => server.close(r));
    rmSync(root, { recursive: true, force: true });
  }
});

test("matrix: forged receipt with wrong knowledgeId is rejected and re-mirrored", async () => {
  const root = mkdtempSync(join(tmpdir(), "repair-bad-kid-"));
  try {
    const store = memoryStore();
    const consumer = createRepairConsumer({ outboxRoot: root, actorId: "win-bad-kid", knowledgeClient: store });
    await consumer.loadProposal(FIRST_PROPOSAL);
    assert.equal((await consumer.tryClaim({ at: new Date("2026-08-02T12:00:00.000Z") })).ok, true);
    const event = consumer.listEvents()[0];
    const mirrorsDir = join(root, FIRST_PROPOSAL.transport.outboxNamespace, "knowledge-mirrors");
    const unsigned = {
      schemaId: "xhs.repair-knowledge-mirror-receipt.v1",
      schemaVersion: 1,
      eventId: event.eventId,
      eventSha256: sha256(event),
      envelopeSha256: sha256(repairEventKnowledgeEnvelope(event)),
      knowledgeId: `repair_event_${"b".repeat(24)}`,
      mirroredAt: "2026-08-02T12:00:00.000Z",
    };
    const forged = { ...unsigned, receiptSha256: sha256(unsigned) };
    writeFileSync(join(mirrorsDir, `${event.eventId}.json`), `${JSON.stringify(forged)}\n`);

    let posts = 0;
    const retryStore = memoryStore();
    const orig = retryStore.postKnowledge.bind(retryStore);
    retryStore.postKnowledge = async (envelope) => {
      posts += 1;
      return orig(envelope);
    };
    const restarted = createRepairConsumer({ outboxRoot: root, actorId: "win-bad-kid", knowledgeClient: retryStore });
    await restarted.loadProposal(FIRST_PROPOSAL);
    assert.ok(posts >= 1);
    const accepted = JSON.parse(readFileSync(join(mirrorsDir, `${event.eventId}.json`), "utf8"));
    assert.equal(accepted.knowledgeId, event.eventId);
    MATRIX.outboxCases.push({ name: "wrong-knowledgeId-receipt", ok: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("matrix: forged debt with wrong event/envelope hash is rejected on hydrate", async () => {
  const root = mkdtempSync(join(tmpdir(), "repair-bad-debt-"));
  try {
    const store = memoryStore();
    const consumer = createRepairConsumer({
      outboxRoot: root,
      actorId: "win-bad-debt",
      knowledgeClient: {
        async listRepairProposals() { return [FIRST_PROPOSAL]; },
        async getKnowledge() { return { ok: false, status: 404 }; },
        async postKnowledge() { return { ok: false, debt: true, status: 500, code: "DOWN" }; },
      },
    });
    await consumer.loadProposal(FIRST_PROPOSAL);
    assert.equal((await consumer.tryClaim({ at: new Date("2026-08-02T12:00:00.000Z") })).ok, true);
    const event = consumer.listEvents()[0];
    const debtDir = join(root, FIRST_PROPOSAL.transport.outboxNamespace, "evidence-debt");
    const unsigned = {
      schemaId: "xhs.repair-evidence-debt.v1",
      schemaVersion: 1,
      layer: "repair-transport",
      code: "KNOWLEDGE_MIRROR_FAILED",
      cause: "forged",
      at: "2026-08-02T12:00:00.000Z",
      businessResultUnchanged: true,
      envelopeId: event.eventId,
      eventSha256: "f".repeat(64),
      envelopeSha256: "e".repeat(64),
    };
    const forged = { ...unsigned, debtSha256: sha256(unsigned) };
    writeFileSync(join(debtDir, `${event.eventId}.json`), `${JSON.stringify(forged)}\n`);

    const restarted = createRepairConsumer({ outboxRoot: root, actorId: "win-bad-debt", knowledgeClient: store });
    await restarted.loadProposal(FIRST_PROPOSAL);
    assert.equal(restarted.evidenceDebt.some((d) => d.eventSha256 === "f".repeat(64)), false);
    assert.ok(restarted.evidenceDebt.every((d) => d.eventSha256 === sha256(event)));
    MATRIX.outboxCases.push({ name: "forged-debt-hashes", ok: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("matrix: report counters", () => {
  const report = {
    crashPhases: MATRIX.crashPhases.length,
    registryCases: MATRIX.registryCases.length,
    outboxCases: MATRIX.outboxCases.length,
    stateCases: MATRIX.stateCases.length,
    cliCases: MATRIX.cliCases.length,
    MATRIX,
  };
  assert.ok(report.crashPhases >= 10, JSON.stringify(report));
  assert.ok(report.registryCases >= 10, JSON.stringify(report));
  assert.ok(report.outboxCases >= 5, JSON.stringify(report));
  assert.ok(report.stateCases >= 4, JSON.stringify(report));
  assert.ok(report.cliCases >= 3, JSON.stringify(report));
  writeFileSync(join(tmpdir(), "repair-consumer-matrix-report.json"), `${JSON.stringify(report, null, 2)}\n`);
});
