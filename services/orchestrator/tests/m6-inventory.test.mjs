import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { evaluateHardRedline } from "../scripts/lib/m6/m6-hard-redline.mjs";
import {
  computeRedlinePolicySha256,
  validateReplayCorpusManifest,
  validateVisualAssetsLock,
} from "../scripts/lib/m6/m6-contracts.mjs";
import { checkDshInventory } from "../../../tools/m6/dsh-inventory-check.mjs";
import { collectMatches, evaluateMatches, runGuard } from "../../../tools/m6/external-path-guard.mjs";
import { buildBenchmark } from "../../../tools/m6/generate-autonomy-benchmark.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const M6_DIR = path.join(REPO_ROOT, "services/orchestrator/contracts/m6");

const readJson = (rel) => JSON.parse(readFileSync(path.join(REPO_ROOT, rel), "utf8"));
// Hash LF-normalized bytes so the same file hashes identically on Windows (CRLF
// worktree) and Linux/macOS (LF checkout), mirroring tools/fusion sha256Normalized.
const sha256File = (rel) => createHash("sha256").update(readFileSync(path.join(REPO_ROOT, rel)).toString("utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n"), "utf8").digest("hex");

const inventory = readJson("services/orchestrator/contracts/m6/vision-inventory.v1.json");
const assetLock = readJson("services/orchestrator/contracts/m6/visual-assets.lock.v1.json");
const benchmark = readJson("services/orchestrator/contracts/m6/autonomy-benchmark.v1.json");
const slo = readJson("services/orchestrator/contracts/m6/smoothness-slo.v1.json");
const POLICY = readJson("services/orchestrator/tests/fixtures/m6/hard-redline-policy.valid.json");
const POLICY_SHA = computeRedlinePolicySha256(POLICY);

test("vision-inventory: every registered file exists and its sha256 matches", () => {
  assert.ok(inventory.files.length >= 10, "inventory must cover the vision surface");
  for (const entry of inventory.files) {
    assert.equal(sha256File(entry.path), entry.sha256, `${entry.path} hash drift`);
    assert.ok(Array.isArray(entry.callers) && entry.callers.length > 0, `${entry.path} callers missing`);
  }
});

test("vision-inventory: the three M6-1 compat exceptions are zeroed out of source", () => {
  // M6-1 converges xw-locator to the GroundingRuntime and clears the machine-
  // external defaults from xw-start and wechat-balance-extract. None of these
  // source files may still reference the external resolver root, its python venv
  // or the visual_tap_demo.py script.
  const locator = readFileSync(path.join(REPO_ROOT, "services/orchestrator/ops/xw-locator.mjs"), "utf8");
  const xwStart = readFileSync(path.join(REPO_ROOT, "services/orchestrator/ops/xw-start.mjs"), "utf8");
  const wechat = readFileSync(path.join(REPO_ROOT, "services/orchestrator/scripts/lib/wechat-balance-extract.mjs"), "utf8");
  const shared = readFileSync(path.join(REPO_ROOT, "services/orchestrator/scripts/lib/xw-balance-shared.mjs"), "utf8");
  for (const [label, src] of [["xw-locator", locator], ["xw-start", xwStart], ["wechat-ocr", wechat], ["xw-balance-shared", shared]]) {
    assert.ok(!src.includes("xhs-registry-visual-tap"), `${label} must not reference the machine-external resolver root`);
    assert.ok(!src.includes("visual_tap_demo.py"), `${label} must not reference the machine-external resolver script`);
    assert.ok(!src.includes(".venv-ocr"), `${label} must not reference the machine-external OCR venv`);
  }
  // xw-locator must now delegate to the single GroundingRuntime.
  assert.ok(locator.includes("m6-grounding-runtime"), "xw-locator must delegate to the GroundingRuntime");
  // xw-start recovery analysis must require explicit env config (no default).
  assert.ok(xwStart.includes("XW_VISUAL_RECOVERY_ROOT"), "xw-start live recovery must require explicit env config");
  // wechat OCR must fail closed without an explicit python interpreter.
  assert.ok(wechat.includes("OCR_PYTHON_NOT_CONFIGURED"), "wechat OCR must fail closed without an explicit interpreter");
});

test("vision-inventory: the three M6-1 compat exceptions are resolved (zeroed external paths)", () => {
  const exceptionIds = inventory.compatExceptions.map((entry) => entry.id).sort();
  assert.deepEqual(exceptionIds, ["wechat-ocr", "xw-locator", "xw-start"]);
  for (const entry of inventory.compatExceptions) {
    assert.equal(entry.resolved, true, `${entry.id} must be marked resolved in M6-1`);
    assert.equal(entry.removeBy, "M6-1", `${entry.id} must target M6-1`);
  }
  // The three formerly-exception files must now carry no machine-external paths.
  for (const id of ["xw-locator", "xw-start", "wechat-ocr"]) {
    const file = inventory.files.find((entry) => entry.exceptionId === id);
    assert.ok(file, `${id} file entry missing`);
    assert.deepEqual(file.externalPaths, [], `${id} external paths must be zeroed`);
    assert.equal(file.compatException, false, `${id} must no longer be an active compat exception`);
  }
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
    assert.notEqual(evaluateHardRedline({ intent: task.actionFamily, policy: POLICY, expectedPolicySha256: POLICY_SHA }).verdict, "HARD_STOP", task.id);
    // Intent text scanned as a block signal must not trip the redline either.
    assert.notEqual(
      evaluateHardRedline({ intent: "tap", blockSignals: { ocrText: task.intent }, policy: POLICY, expectedPolicySha256: POLICY_SHA }).verdict,
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

test("visual-assets.lock: the real lock document passes its canonical schema", () => {
  const result = validateVisualAssetsLock(assetLock);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test("visual-assets.lock: tampered documents are invalid", () => {
  const extra = structuredClone(assetLock);
  extra.generatedBy = "unknown-process";
  assert.equal(validateVisualAssetsLock(extra).ok, false);

  // An unverified-license asset can never be marked as committed to the repo.
  const committed = structuredClone(assetLock);
  const external = committed.assets.find((asset) => asset.license.status === "unverified");
  external.committedToRepo = true;
  assert.equal(validateVisualAssetsLock(committed).ok, false);

  // An in-repo asset without a real content hash is invalid.
  const noHash = structuredClone(assetLock);
  const inRepo = noHash.assets.find((asset) => asset.install.mode === "in-repo");
  inRepo.sha256 = null;
  assert.equal(validateVisualAssetsLock(noHash).ok, false);
});

function corpusManifest(entries) {
  return {
    schemaId: "xw.replay-corpus-manifest.v1",
    schemaVersion: 1,
    corpusId: "corpus-fixture",
    createdAt: "2026-08-20T10:00:00.000Z",
    entries,
  };
}

function corpusEntry(overrides = {}) {
  return {
    entryId: "entry-0001",
    kind: "frame",
    sha256: "ab".repeat(32),
    bytes: 1024,
    source: "synthetic-generator",
    license: "repo-internal",
    deidentified: true,
    origin: "synthetic",
    ...overrides,
  };
}

test("replay corpus manifest: valid documents pass the canonical schema and privacy scan", () => {
  const result = validateReplayCorpusManifest(corpusManifest([corpusEntry()]));
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test("replay corpus manifest: deidentified/origin are hard requirements", () => {
  const notDeidentified = corpusManifest([corpusEntry({ deidentified: false })]);
  assert.equal(validateReplayCorpusManifest(notDeidentified).ok, false);

  const wrongOrigin = corpusManifest([corpusEntry({ origin: "production-capture" })]);
  assert.equal(validateReplayCorpusManifest(wrongOrigin).ok, false);
});

test("replay corpus manifest: sensitive fields are rejected wherever they appear", () => {
  for (const key of ["accountId", "deviceId", "deviceSerial", "token", "balance", "cookie", "credential", "account_id"]) {
    const doc = corpusManifest([corpusEntry({ [key]: "x" })]);
    assert.equal(validateReplayCorpusManifest(doc).ok, false, key);
  }
  // Forbidden keys nested inside an allowed field are caught by the recursive scan.
  const nested = corpusManifest([corpusEntry({ notes: "ok" })]);
  nested.entries[0].notes = "ok";
  nested.entries[0] = { ...nested.entries[0], detail: { device_serial: "emulator-5554" } };
  assert.equal(validateReplayCorpusManifest(nested).ok, false);
});
