import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  checkReceiptLinkage,
  computeBlockSetIntegritySha256,
  computeRedlinePolicySha256,
  deriveBlockId,
  deriveFrameId,
  deriveGroundingDecisionId,
  sha256Hex,
  validateAgenticExecutor,
  validateGroundedActionReceipt,
  validateGroundingDecision,
  validateHardRedlinePolicy,
  validateScreenFrame,
  validateVisualBlock,
  validateVisualBlockSet,
} from "../scripts/lib/m6/m6-contracts.mjs";
import { M6_TOOL_CLASSES } from "../scripts/lib/m6/m6-tool-surface.mjs";

const FIXTURES = path.resolve(import.meta.dirname, "fixtures/m6");
const readFixture = (name) => JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8"));

test("valid screen frame passes; tampered, unstable, partial and expired frames fail closed", () => {
  const frame = readFixture("screen-frame.valid.json");
  assert.equal(validateScreenFrame(frame).ok, true);

  const tampered = structuredClone(frame);
  tampered.frameId = sha256Hex("forged");
  assert.equal(validateScreenFrame(tampered).ok, false);

  const unstable = structuredClone(frame);
  unstable.stability.verdict = "unstable";
  assert.equal(validateScreenFrame(unstable).ok, false);

  const partial = structuredClone(frame);
  partial.flags.partial = true;
  assert.equal(validateScreenFrame(partial).ok, false);

  const expired = structuredClone(frame);
  expired.expiresAt = frame.capturedAt;
  assert.equal(validateScreenFrame(expired).ok, false);

  const extra = structuredClone(frame);
  extra.deviceSerial = "emulator-5554";
  assert.equal(validateScreenFrame(extra).ok, false);

  const missing = structuredClone(frame);
  delete missing.screenshotBRef;
  assert.equal(validateScreenFrame(missing).ok, false);
});

test("valid visual block passes; cross-frame reuse, relabeling and raw coordinates are rejected", () => {
  const block = readFixture("visual-block.valid.json");
  assert.equal(validateVisualBlock(block).ok, true);

  const crossFrame = readFixture("visual-block.cross-frame.invalid.json");
  const result = validateVisualBlock(crossFrame);
  assert.equal(result.ok, false);
  assert.match(result.errors.map((e) => e.message).join(";"), /derived|frame/i);

  // Metadata tampering invalidates the derived block id.
  const relabeled = structuredClone(block);
  relabeled.category = "payment";
  assert.equal(validateVisualBlock(relabeled).ok, false);
  const renamed = structuredClone(block);
  renamed.label = "确认支付";
  assert.equal(validateVisualBlock(renamed).ok, false);

  for (const key of ["x", "y", "bounds", "normalizedX"]) {
    const leaked = structuredClone(block);
    leaked[key] = 0.5;
    assert.equal(validateVisualBlock(leaked).ok, false, `${key} must be rejected`);
  }
});

test("block set integrity covers full block metadata and segmentation provenance", () => {
  const blockSet = readFixture("visual-block-set.valid.json");
  assert.equal(validateVisualBlockSet(blockSet).ok, true);
  assert.equal(blockSet.integritySha256, computeBlockSetIntegritySha256(blockSet));

  // A payment block relabeled as content breaks the derived id and set integrity.
  const relabeled = readFixture("visual-block-set.relabeled.invalid.json");
  assert.equal(validateVisualBlockSet(relabeled).ok, false);

  // Confidence/source edits without re-derivation are caught by the integrity hash.
  const retouched = structuredClone(blockSet);
  retouched.blocks[0] = { ...retouched.blocks[0], confidence: 0.1 };
  assert.equal(validateVisualBlockSet(retouched).ok, false);

  // Provider/version/model provenance is bound too.
  const reprovidered = structuredClone(blockSet);
  reprovidered.segmentation = { ...reprovidered.segmentation, provider: "other-provider" };
  assert.equal(validateVisualBlockSet(reprovidered).ok, false);

  const forged = structuredClone(blockSet);
  forged.integritySha256 = sha256Hex("forged");
  assert.equal(validateVisualBlockSet(forged).ok, false);

  const mixed = structuredClone(blockSet);
  mixed.blocks[1] = { ...mixed.blocks[1], frameId: deriveFrameId(sha256Hex("other")) };
  assert.equal(validateVisualBlockSet(mixed).ok, false);

  const dup = structuredClone(blockSet);
  dup.blocks.push(structuredClone(dup.blocks[0]));
  assert.equal(validateVisualBlockSet(dup).ok, false);

  const wrongOrder = structuredClone(blockSet);
  wrongOrder.blocks = [blockSet.blocks[1], blockSet.blocks[0]];
  assert.equal(validateVisualBlockSet(wrongOrder).ok, false);
});

test("valid ALLOW_ONCE decision passes; forged results, ids and block bindings are invalid", () => {
  const decision = readFixture("grounding-decision.valid.json");
  const block = readFixture("visual-block.valid.json");
  assert.equal(validateGroundingDecision(decision, { block }).ok, true);
  assert.equal(decision.groundingDecisionId, deriveGroundingDecisionId(decision));

  // Model upgrades a degraded decision to ALLOW_ONCE.
  const forgedAllow = readFixture("grounding-decision.forged-allow.invalid.json");
  assert.equal(validateGroundingDecision(forgedAllow).ok, false);

  // Model upgrades a redline effect to REPLAN/ALLOW_ONCE.
  for (const result of ["REPLAN", "ALLOW_ONCE"]) {
    const redlineForgery = structuredClone(decision);
    redlineForgery.effectClass = "payment";
    redlineForgery.result = result;
    if (result === "ALLOW_ONCE") redlineForgery.groundingDecisionId = deriveGroundingDecisionId(redlineForgery);
    assert.equal(validateGroundingDecision(redlineForgery).ok, false, `${result} on payment must fail`);
  }

  // Stolen/reused decision id on a different intent.
  const stolen = structuredClone(decision);
  stolen.intent = "scroll";
  assert.equal(validateGroundingDecision(stolen).ok, false);

  // Policy or check edits invalidate the one-time id.
  const swappedPolicy = structuredClone(decision);
  swappedPolicy.policySha256 = sha256Hex("weakened-policy");
  assert.equal(validateGroundingDecision(swappedPolicy).ok, false);
  const editedChecks = structuredClone(decision);
  editedChecks.checks = editedChecks.checks.map((c) => (c.name === "confidence" ? { ...c, result: "UNKNOWN" } : c));
  editedChecks.result = "REPLAN";
  delete editedChecks.groundingDecisionId;
  assert.equal(validateGroundingDecision(editedChecks).ok, true);
  const editedChecksAllow = structuredClone(editedChecks);
  editedChecksAllow.result = "ALLOW_ONCE";
  editedChecksAllow.groundingDecisionId = deriveGroundingDecisionId(editedChecksAllow);
  assert.equal(validateGroundingDecision(editedChecksAllow).ok, false);

  // Forged block binding.
  const wrongBlock = structuredClone(block);
  wrongBlock.blockId = deriveBlockId({ ...block, stableIndex: 99 });
  assert.equal(validateGroundingDecision(decision, { block: wrongBlock }).ok, false);

  // HARD_STOP decisions must not carry a reusable id.
  const stopWithId = structuredClone(decision);
  stopWithId.result = "HARD_STOP";
  stopWithId.effectClass = "payment";
  assert.equal(validateGroundingDecision(stopWithId).ok, false);
});

test("valid hard-redline policy passes and is self-pinned by its canonical hash", () => {
  const policy = readFixture("hard-redline-policy.valid.json");
  assert.equal(validateHardRedlinePolicy(policy).ok, true);
  assert.equal(policy.policySha256, computeRedlinePolicySha256(policy));

  const weakened = structuredClone(policy);
  weakened.categories = weakened.categories.filter((category) => category.name !== "delete");
  assert.equal(validateHardRedlinePolicy(weakened).ok, false);

  const extra = structuredClone(policy);
  extra.allowlistOverride = true;
  assert.equal(validateHardRedlinePolicy(extra).ok, false);
});

test("valid receipt passes; broken correlation and missing verification refs fail", () => {
  const receipt = readFixture("grounded-action.receipt.valid.json");
  const decision = readFixture("grounding-decision.valid.json");
  const grant = readFixture("autonomy-grant.valid.json");
  assert.equal(validateGroundedActionReceipt(receipt).ok, true);
  assert.equal(checkReceiptLinkage(receipt, { decision, grantRef: grant.grantId, beforeFrameId: decision.frameId }).ok, true);

  const brokenDecision = structuredClone(receipt);
  brokenDecision.groundingDecisionRef = sha256Hex("other-decision");
  assert.equal(checkReceiptLinkage(brokenDecision, { decision }).ok, false);

  const brokenFrame = structuredClone(receipt);
  brokenFrame.beforeFrameRef = sha256Hex("other-frame");
  assert.equal(checkReceiptLinkage(brokenFrame, { decision }).ok, false);

  const brokenGrant = structuredClone(receipt);
  brokenGrant.grantRef = "grant_deadbeefdeadbeef";
  assert.equal(checkReceiptLinkage(brokenGrant, { decision }).ok, false);

  const verifiedNoAfter = structuredClone(receipt);
  delete verifiedNoAfter.afterFrameRef;
  assert.equal(validateGroundedActionReceipt(verifiedNoAfter).ok, false);

  const failedNoError = structuredClone(receipt);
  failedNoError.status = "FAILED";
  assert.equal(validateGroundedActionReceipt(failedNoError).ok, false);

  const receiptForReplan = structuredClone(receipt);
  const replanDecision = structuredClone(decision);
  replanDecision.result = "REPLAN";
  delete replanDecision.groundingDecisionId;
  assert.equal(checkReceiptLinkage(receiptForReplan, { decision: replanDecision }).ok, false);
});

test("valid agentic executor passes; tools outside the M6 surface are rejected", () => {
  const executor = readFixture("agentic-executor.valid.json");
  assert.equal(validateAgenticExecutor(executor, { allowedToolClasses: M6_TOOL_CLASSES }).ok, true);

  const widened = structuredClone(executor);
  widened.toolAllowlist = [...executor.toolAllowlist, "shell_exec"];
  assert.equal(validateAgenticExecutor(widened, { allowedToolClasses: M6_TOOL_CLASSES }).ok, false);

  const wrongMode = structuredClone(executor);
  wrongMode.autonomyPolicy.authorizationMode = "per_action";
  assert.equal(validateAgenticExecutor(wrongMode, { allowedToolClasses: M6_TOOL_CLASSES }).ok, false);
});
