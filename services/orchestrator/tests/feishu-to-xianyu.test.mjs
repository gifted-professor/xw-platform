import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  assembleFixture,
  classifyTarget,
  deviceFromEntry,
  isValidVerifyMode,
  planPhoneImages,
  redactSensitiveArgValues,
  summarizeJob,
} from "../ops/feishu-to-xianyu-lib.mjs";

const product = {
  descriptionPrefix: "【奥莱折扣】",
  productTitle: "DX1488-100",
  descriptionBody: "尺码 S-XXL",
  price: 299,
  colorArr: ["白色"],
  sizeArr: ["S", "M", "L", "XL", "XXL"],
};

test("single-color fixture removes color dimension and keeps sizes", () => {
  const pushed = planPhoneImages([{ name: "01.png", sha256: "abc" }], ["02"]);
  const fixture = assembleFixture("02", product, pushed);
  assert.deepEqual(fixture.skuSpecs, { 尺码: ["S", "M", "L", "XL", "XXL"] });
  assert.equal(fixture.saveDraft, false);
  assert.equal(fixture.images[0].phonePath, "/sdcard/Pictures/XianyuFull2/01.png");
});

test("multi-color fixture keeps color and size dimensions", () => {
  const pushed = planPhoneImages([], ["03"]);
  const fixture = assembleFixture("03", { ...product, colorArr: ["白色", "黑色"] }, pushed);
  assert.deepEqual(fixture.skuSpecs, {
    颜色: ["白色", "黑色"],
    尺码: ["S", "M", "L", "XL", "XXL"],
  });
});

test("ready tiering never lets force skip a target lease", () => {
  const gate = classifyTarget({
    deviceId: "dev-02",
    online: true,
    quarantined: false,
    leaseFree: false,
    ready: false,
    unresolvedFailure: null,
  }, { force: true });
  assert.match(gate.hardProblems.join(" "), /lease/);
  assert.match(gate.warnings.join(" "), /FORCE=ready-only/);
});

test("unknown online, quarantine, and lease states fail closed", () => {
  const gate = classifyTarget({
    deviceId: "dev-unknown",
    online: null,
    quarantined: null,
    leaseFree: null,
    ready: true,
    unresolvedFailure: null,
  }, { force: true });
  assert.match(gate.hardProblems.join(" "), /online 状态未知/);
  assert.match(gate.hardProblems.join(" "), /quarantine 状态未知/);
  assert.match(gate.hardProblems.join(" "), /lease 状态未知/);
});

test("missing control lease field stays unknown instead of becoming lease-free", () => {
  const row = deviceFromEntry({ devices: [{
    alias: "02",
    control: { deviceId: "dev-02", online: true, quarantined: false },
    state: { online: true, quarantined: false, ready: true },
  }] }, "02");
  assert.equal(row.leaseFree, null);
  assert.match(classifyTarget(row).hardProblems.join(" "), /lease 状态未知/);
});

test("unresolved failure requests recovery while clean ready=false remains warning-only", () => {
  const dirty = classifyTarget({
    deviceId: "dev-04", online: true, quarantined: false, leaseFree: true, ready: false,
    unresolvedFailure: { errorCode: "VERIFICATION_FAILED" },
  });
  const clean = classifyTarget({
    deviceId: "dev-01", online: true, quarantined: false, leaseFree: true, ready: false,
    unresolvedFailure: null,
  });
  assert.equal(dirty.recoveryRequired, true);
  assert.equal(clean.recoveryRequired, false);
  assert.equal(clean.hardProblems.length, 0);
});

test("knowledge verifyMode accepts only registry enum values", () => {
  for (const mode of ["replay", "constraint", "human", null]) assert.equal(isValidVerifyMode(mode), true);
  assert.equal(isValidVerifyMode("dry-run: custom prose"), false);
  const seed = JSON.parse(readFileSync(new URL("../knowledge-seed-feishu-to-xianyu-20260728.json", import.meta.url), "utf8"));
  for (const item of seed) assert.equal(isValidVerifyMode(item.verifyMode), true, item.id);
});

test("job summary requires explicit output, restoration, and verification success", () => {
  assert.deepEqual(summarizeJob({ status: "succeeded", result: { output: { ok: true } } }), {
    status: "succeeded",
    errorCode: null,
    outputOk: true,
    verificationOk: false,
    restorationOk: false,
    restorationFailed: false,
    verificationFailed: false,
  });
  const complete = summarizeJob({
    status: "succeeded",
    result: { output: { ok: true }, restoration: { ok: true }, verification: { ok: true } },
  });
  assert.equal(complete.outputOk, true);
  assert.equal(complete.restorationOk, true);
  assert.equal(complete.verificationOk, true);
});

test("command errors redact session tokens from argv echoes", () => {
  const token = "SAMPLE_SECRET_DO_NOT_LOG";
  const message = `Command failed: node devicectl session heartbeat --session s1 --token ${token}`;
  const redacted = redactSensitiveArgValues(message, ["session", "heartbeat", "--session", "s1", "--token", token]);
  assert.equal(redacted.includes(token), false);
  assert.match(redacted, /--token \[REDACTED\]/);
});
