import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { evaluateHardRedline } from "../scripts/lib/m6/m6-hard-redline.mjs";
import { checkDshInventory } from "../../../tools/m6/dsh-inventory-check.mjs";
import { collectMatches, evaluateMatches, runGuard } from "../../../tools/m6/external-path-guard.mjs";
import { buildBenchmark } from "../../../tools/m6/generate-autonomy-benchmark.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const M6_DIR = path.join(REPO_ROOT, "services/orchestrator/contracts/m6");

const readJson = (rel) => JSON.parse(readFileSync(path.join(REPO_ROOT, rel), "utf8"));
const sha256File = (rel) => createHash("sha256").update(readFileSync(path.join(REPO_ROOT, rel))).digest("hex");

const inventory = readJson("services/orchestrator/contracts/m6/vision-inventory.v1.json");
const assetLock = readJson("services/orchestrator/contracts/m6/visual-assets.lock.v1.json");
const benchmark = readJson("services/orchestrator/contracts/m6/autonomy-benchmark.v1.json");
const slo = readJson("services/orchestrator/contracts/m6/smoothness-slo.v1.json");
const POLICY = readJson("services/orchestrator/tests/fixtures/m6/hard-redline-policy.valid.json");

test("vision-inventory: every registered file exists and its sha256 matches", () => {
  assert.ok(inventory.files.length >= 10, "inventory must cover the vision surface");
  for (const entry of inventory.files) {
    assert.equal(sha256File(entry.path), entry.sha256, `${entry.path} hash drift`);
    assert.ok(Array.isArray(entry.callers) && entry.callers.length > 0, `${entry.path} callers missing`);
  }
});

test("vision-inventory: core external-path claims are verifiable in the referenced source", () => {
  const locator = readFileSync(path.join(REPO_ROOT, "services/orchestrator/ops/xw-locator.mjs"), "utf8");
  assert.ok(locator.includes("C:\\\\Users\\\\Public\\\\xhs-registry-visual-tap\\\\experiments\\\\visual-tap-resolver"));
  assert.ok(locator.includes(".venv-ocr"));
  const xwStart = readFileSync(path.join(REPO_ROOT, "services/orchestrator/ops/xw-start.mjs"), "utf8");
  assert.ok(xwStart.includes("VISUAL_RESOLVER_ROOT"));
  assert.ok(xwStart.includes(".venv-ocr"));
  const wechat = readFileSync(path.join(REPO_ROOT, "services/orchestrator/scripts/lib/wechat-balance-extract.mjs"), "utf8");
  assert.ok(wechat.includes("C:\\\\Users\\\\Public\\\\xhs-registry-visual-tap\\\\experiments\\\\visual-tap-resolver\\\\.venv-ocr\\\\Scripts\\\\python.exe"));
});

test("vision-inventory: exactly the three compat exceptions are marked", () => {
  const exceptionIds = inventory.compatExceptions.map((entry) => entry.id).sort();
  assert.deepEqual(exceptionIds, ["wechat-ocr", "xw-locator", "xw-start"]);
  const flagged = inventory.files.filter((entry) => entry.compatException).map((entry) => entry.exceptionId);
  for (const id of ["xw-locator", "xw-start", "wechat-ocr"]) assert.ok(flagged.includes(id), `missing ${id}`);
});

test("external-path-guard: repo baseline has zero violations", () => {
  const result = runGuard({ rootDir: REPO_ROOT });
  assert.deepEqual(result.violations, []);
  assert.ok(result.ok);
  assert.ok(result.scanned > 0);
});

test("external-path-guard: registered exception passes, unregistered path fails", () => {
  const root = mkdtempSync(path.join(tmpdir(), "m6-guard-"));
  try {
    const dir = path.join(root, "services/orchestrator/ops");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "ok.mjs"), 'const p = "C:\\\\Users\\\\Public\\\\visual-tap";\n');
    writeFileSync(path.join(dir, "bad.mjs"), 'const q = "E:\\\\evil\\\\new-machine-path";\n');
    const miniInventory = {
      schemaId: "xw.vision-inventory.v1",
      externalPathBaseline: [
        { literal: "C:\\Users\\Public\\visual-tap", files: ["services/orchestrator/ops/ok.mjs"], compatException: true },
      ],
    };
    const inventoryPath = path.join(root, "inventory.json");
    writeFileSync(inventoryPath, JSON.stringify(miniInventory));
    const matches = collectMatches(root, ["services/orchestrator"]);
    const violations = evaluateMatches(matches, miniInventory);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].file, "services/orchestrator/ops/bad.mjs");
    assert.ok(violations[0].literal.startsWith("E:"));
    const result = runGuard({ rootDir: root, inventoryPath, scanRoots: ["services/orchestrator"] });
    assert.equal(result.ok, false);
    // Removing the unregistered file must make the same guard pass.
    rmSync(path.join(dir, "bad.mjs"));
    assert.equal(runGuard({ rootDir: root, inventoryPath, scanRoots: ["services/orchestrator"] }).ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("visual-assets.lock: hashes and license/install shape are valid", () => {
  assert.equal(assetLock.schemaId, "xw.visual-assets.lock.v1");
  for (const asset of assetLock.assets) {
    if (asset.sha256 !== null) assert.match(asset.sha256, /^[0-9a-f]{64}$/, asset.assetId);
    if (asset.install.mode === "in-repo") {
      assert.equal(asset.committedToRepo, true, asset.assetId);
      assert.equal(sha256File(asset.install.path), asset.sha256, `${asset.assetId} hash drift`);
    }
    if (asset.license.status === "unverified") {
      assert.equal(asset.committedToRepo, false, `${asset.assetId}: unknown-license asset must not be committed`);
    }
    if (asset.install.mode === "external-machine-local") {
      assert.equal(asset.committedToRepo, false, asset.assetId);
    }
  }
  // Machine-external vision assets must be registered as external, not committed.
  for (const id of ["visual-tap-resolver", "paddleocr-venv-ocr", "visual-grounding-poc"]) {
    const asset = assetLock.assets.find((entry) => entry.assetId === id);
    assert.ok(asset, `${id} missing from lock`);
    assert.equal(asset.install.mode, "external-machine-local");
    assert.equal(asset.committedToRepo, false);
  }
});

test("autonomy-benchmark: >=100 unique non-redline tasks, all expecting autonomy", () => {
  assert.ok(benchmark.tasks.length >= 100, `tasks=${benchmark.tasks.length}`);
  const ids = new Set(benchmark.tasks.map((task) => task.id));
  assert.equal(ids.size, benchmark.tasks.length, "duplicate task ids");
  assert.ok(benchmark.countingRules.midRunHumanIntervention.definition.length > 0);
  assert.ok(benchmark.countingRules.perActionApproval.definition.length > 0);
  const families = new Set();
  for (const task of benchmark.tasks) {
    families.add(task.actionFamily);
    assert.equal(task.expectedAutonomous, true, task.id);
    assert.ok(["replay", "authorized_test_account"].includes(task.scenario), task.id);
    // Family name must not be a hard-deny category.
    assert.notEqual(evaluateHardRedline({ intent: task.actionFamily, policy: POLICY }), "HARD_STOP", task.id);
    // Intent text scanned as a block signal must not trip the redline either.
    assert.notEqual(
      evaluateHardRedline({ intent: "tap", blockSignals: { ocrText: task.intent }, policy: POLICY }),
      "HARD_STOP",
      task.id,
    );
  }
  for (const required of ["app-launch", "app-switch", "search", "text-input", "scroll", "tab-back", "form-edit", "settings-nav", "social-publish-account"]) {
    assert.ok(families.has(required), `family ${required} missing`);
  }
  // On-disk file must match the deterministic generator.
  assert.deepEqual(benchmark.tasks, buildBenchmark().tasks);
});

test("smoothness-slo: thresholds match the task brief", () => {
  const byId = Object.fromEntries(slo.metrics.map((metric) => [metric.id, metric.p95Ms]));
  assert.equal(byId["json-rpc-bridge"], 100);
  assert.equal(byId["grounding-decision"], 1000);
  assert.equal(byId["observe-to-dispatch-overhead"], 4000);
  assert.ok(slo.freezeNote.includes("显式计划变更"));
  assert.ok(slo.temperature.warm && slo.temperature.cold);
  assert.ok(slo.hardwareProfile && slo.modelProfile);
});

test("dsh-inventory-check: fixture adapter conforms", () => {
  const result = checkDshInventory(REPO_ROOT);
  assert.deepEqual(result.failures, []);
  assert.ok(result.ok);
});

test("kernel schemas for asset lock and replay corpus exist with the hard requirements", () => {
  const assetsSchema = readJson("packages/kernel/contracts/orchestration/m6/xw.visual-assets.lock.v1.schema.json");
  assert.equal(assetsSchema.title, "xw.visual-assets.lock.v1");
  const corpusSchema = readJson("packages/kernel/contracts/orchestration/m6/xw.replay-corpus-manifest.v1.schema.json");
  assert.equal(corpusSchema.title, "xw.replay-corpus-manifest.v1");
  const entry = corpusSchema.$defs.entry;
  assert.equal(entry.properties.deidentified.const, true);
  assert.deepEqual(entry.properties.origin.enum, ["synthetic", "authorized-capture"]);
  assert.ok(entry.propertyNames.not.pattern.includes("token"));
  assert.ok(entry.propertyNames.not.pattern.includes("balance"));
  assert.ok(entry.propertyNames.not.pattern.includes("account"));
  assert.ok(entry.propertyNames.not.pattern.includes("device"));
});
