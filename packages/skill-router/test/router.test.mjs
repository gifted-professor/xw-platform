import assert from "node:assert/strict";
import test from "node:test";

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ExperienceLedger } from "../../experience-ledger/lib/ledger.mjs";
import { ExperienceCompiler } from "../lib/compiler.mjs";
import { SkillRouter } from "../lib/router.mjs";
import { loadSkillFixtureSpec } from "../../kernel/lib/skill-runtime.mjs";

test("facts append, snapshots freeze, questions clear", () => {
  const ledger = new ExperienceLedger({ now: () => 1 });
  ledger.appendFact({ id: "f1", kind: "app-version", value: "8.72" });
  assert.throws(
    () => ledger.appendFact({ id: "f1", kind: "app-version", value: "8.73" }),
    { code: "FACT_IMMUTABLE" },
  );
  ledger.writeSnapshot({ id: "snap-1", kind: "canary", result: "pass" });
  assert.throws(
    () => ledger.writeSnapshot({ id: "snap-1", kind: "canary", result: "fail" }),
    { code: "SNAPSHOT_IMMUTABLE" },
  );
  ledger.openQuestion({ id: "q1", text: "is the collect verifier stable on 03?" });
  const resolved = ledger.resolveQuestion("q1", "yes-on-01-only");
  assert.equal(resolved.status, "resolved");
  assert.equal(ledger.dump().openQuestions.length, 0);
});

test("patterns accumulate support instead of silent overwrite", () => {
  const ledger = new ExperienceLedger({ now: () => 2 });
  ledger.upsertPattern({ id: "p-collect", statement: "count +1", supportEpisodes: 3 });
  const again = ledger.upsertPattern({ id: "p-collect", statement: "count +1 after 1200ms", supportEpisodes: 1 });
  assert.equal(again.supportEpisodes, 4);
  assert.throws(
    () => ledger.upsertPattern({ id: "p-collect", overwrite: true, statement: "tap blindly" }),
    { code: "PATTERN_NO_OVERWRITE" },
  );
});

test("router maps intents to skills and rejects raw skill ids", () => {
  const router = new SkillRouter();
  const reroute = router.route({
    goal: "collect a note",
    currentSkillId: "xhs.collect",
    exit: {
      exit: "REROUTE",
      reason: "target-page-not-found",
      candidateIntents: ["intent:repair-navigation"],
    },
  });
  assert.equal(reroute.nextSkillId, "device.repair-navigation");
  assert.throws(
    () => router.route({
      currentSkillId: "xhs.collect",
      exit: { exit: "REROUTE", candidateIntents: ["xhs.publish"] },
    }),
    { code: "INVALID_CANDIDATE_INTENT" },
  );
});

test("COMPLETED and WAIT_HUMAN do not pick a next skill", () => {
  const router = new SkillRouter();
  const done = router.route({
    currentSkillId: "xhs.collect",
    exit: { exit: "COMPLETED", reason: "count-plus-one" },
  });
  assert.equal(done.decision, "DONE");
  assert.equal(done.nextSkillId, null);
  const wait = router.route({
    currentSkillId: "xhs.collect",
    exit: { exit: "WAIT_HUMAN", reason: "captcha" },
  });
  assert.equal(wait.decision, "WAIT_HUMAN");
});

test("hybrid pack wraps existing xhs.collect and compiler cannot auto-promote", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const pack = JSON.parse(readFileSync(join(here, "../fixtures/xhs-collect.hybrid.v1.json"), "utf8"));
  assert.equal(pack.skillId, "xhs.collect");
  assert.equal(pack.live, false);
  const compiler = new ExperienceCompiler();
  const candidate = compiler.compileCandidate({
    episodes: [{ id: "ep-1", ok: true }],
    spec: loadSkillFixtureSpec(),
  });
  assert.equal(candidate.lifecycle, "CANDIDATE");
  assert.equal(candidate.autoPromote, false);
  assert.throws(
    () => compiler.promote(candidate, { humanApproved: false, replayPassed: true, canaryPassed: true }),
    { code: "SKILL_PROMOTION_BLOCKED" },
  );
});
