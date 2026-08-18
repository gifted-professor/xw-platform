import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAnnotation, prepareTag, verifyTag, localTagObject, tagPeeledCommit } from "../tag.mjs";

function sh(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}
function makeRepo() {
  const d = mkdtempSync(join(tmpdir(), "m0tag-"));
  sh(d, "init", "-q");
  sh(d, "config", "user.email", "t@t");
  sh(d, "config", "user.name", "t");
  writeFileSync(join(d, "a.txt"), "x");
  sh(d, "add", "a.txt");
  sh(d, "commit", "-q", "-m", "c");
  return d;
}

test("buildAnnotation records both targets, input pair, hashes, peer by name not object id", () => {
  const body = buildAnnotation({
    baselineId: "xw-m0-20260817-r0",
    thisSide: { tagName: "xw-m0-registry-r0", repo: "registry", target: "aaaa" },
    peerSide: { tagName: "xw-m0-device-agent-r0", repo: "deviceAgent", target: "bbbb" },
    inputPair: { registry: "aaaa", deviceAgent: "bbbb" },
    projectionHashes: { registry: "r".repeat(64), deviceAgent: "d".repeat(64) },
    toolingHash: "t".repeat(64),
    dossierManifestHash: "m".repeat(64),
  });
  assert.ok(body.includes("baselineId: xw-m0-20260817-r0"));
  assert.ok(body.includes("peer: xw-m0-device-agent-r0 -> deviceAgent:bbbb"));
  assert.ok(!body.includes("object"), "annotation must not reference peer object id");
});

test("prepareTag creates a local annotated tag and blocks on re-prepare", () => {
  const d = makeRepo();
  try {
    const target = sh(d, "rev-parse", "HEAD").trim();
    const ann = buildAnnotation({
      baselineId: "xw-m0-20260817-r0",
      thisSide: { tagName: "xw-m0-registry-r0", repo: "registry", target },
      peerSide: { tagName: "xw-m0-device-agent-r0", repo: "deviceAgent", target: "b".repeat(40) },
      inputPair: { registry: target, deviceAgent: "b".repeat(40) },
      projectionHashes: { registry: "r".repeat(64), deviceAgent: "d".repeat(64) },
      toolingHash: "t".repeat(64),
      dossierManifestHash: "m".repeat(64),
    });
    const r = prepareTag(d, "origin", { tagName: "xw-m0-registry-r0", target, annotation: ann });
    assert.ok(r.object, "tag object id returned");
    assert.equal(r.peeled, target);
    assert.equal(localTagObject(d, "xw-m0-registry-r0"), r.object);
    // re-prepare must BLOCK
    assert.throws(
      () => prepareTag(d, "origin", { tagName: "xw-m0-registry-r0", target, annotation: ann }),
      /BLOCK: local tag/,
    );
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("verifyTag confirms object + peeled target + annotation baselineId", () => {
  const d = makeRepo();
  try {
    const target = sh(d, "rev-parse", "HEAD").trim();
    const ann = buildAnnotation({
      baselineId: "xw-m0-20260817-r0",
      thisSide: { tagName: "xw-m0-device-agent-r0", repo: "deviceAgent", target },
      peerSide: { tagName: "xw-m0-registry-r0", repo: "registry", target },
      inputPair: { registry: target, deviceAgent: target },
      projectionHashes: { registry: "r".repeat(64), deviceAgent: "d".repeat(64) },
      toolingHash: "t".repeat(64),
      dossierManifestHash: "m".repeat(64),
    });
    prepareTag(d, "origin", { tagName: "xw-m0-device-agent-r0", target, annotation: ann });
    const v = verifyTag(d, "xw-m0-device-agent-r0", target, "xw-m0-20260817-r0");
    assert.equal(v.ok, true);
    // wrong expected target -> not ok
    const v2 = verifyTag(d, "xw-m0-device-agent-r0", "0".repeat(40), "xw-m0-20260817-r0");
    assert.equal(v2.ok, false);
    // wrong baselineId -> not ok
    const v3 = verifyTag(d, "xw-m0-device-agent-r0", target, "xw-m0-20260817-r1");
    assert.equal(v3.ok, false);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});