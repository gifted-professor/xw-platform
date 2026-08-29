import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  XHS_EXPLORATION_VISION_CORPUS_ROUTES,
  XHS_EXPLORATION_VISION_CORPUS_PROVENANCE,
  XHS_EXPLORATION_DUMP_RECEIPT_SCHEMA_ID,
  buildVisionCorpusDumpReceipt,
  createVisionCorpusProcessProviderAdapter,
  deriveVisionCorpusAnnotationHash,
  evaluateVisionCorpusGate,
  validateVisionCorpusManifest,
} from "../scripts/lib/xhs-exploration-vision-corpus.mjs";

const MANIFEST = JSON.parse(readFileSync(
  new URL("../contracts/xhs-exploration-vision-corpus.v1.json", import.meta.url),
  "utf8",
));

const IDENTITY = Object.freeze({
  providerBundleDigest: "9".repeat(64),
  pythonHash: "d".repeat(64),
  modelHash: "a".repeat(64),
  scriptHash: "b".repeat(64),
  configHash: "c".repeat(64),
});

const ROLE_BY_ROUTE = Object.freeze({
  HOME_FEED: "OPEN_CONTENT_CARD",
  SEARCH_RESULTS: "OPEN_CONTENT_CARD",
  IMAGE_NOTE: "OPEN_COMMENT_PANEL",
  VIDEO_NOTE: "PAUSE_VIDEO_SAFE_ZONE",
  COMMENT_PANEL: "BACK",
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function png(width, height, salt) {
  const bytes = Buffer.alloc(40);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes.writeUInt32BE(salt, 32);
  return bytes;
}

function coverageFor(rows) {
  const distinctFramesByRoute = Object.fromEntries(
    XHS_EXPLORATION_VISION_CORPUS_ROUTES.map((route) => [route, 0]),
  );
  for (const route of XHS_EXPLORATION_VISION_CORPUS_ROUTES) {
    distinctFramesByRoute[route] = new Set(
      rows.filter((row) => row.pageClass === route).map((row) => row.frame.sha256),
    ).size;
  }
  const verifiedRoutes = XHS_EXPLORATION_VISION_CORPUS_ROUTES
    .filter((route) => distinctFramesByRoute[route] >= 3);
  const missingRoutes = XHS_EXPLORATION_VISION_CORPUS_ROUTES
    .filter((route) => distinctFramesByRoute[route] < 3);
  return {
    complete: missingRoutes.length === 0,
    distinctFramesByRoute,
    verifiedRoutes,
    missingRoutes,
  };
}

function buildFixture() {
  const frames = new Map();
  const receipts = new Map();
  const rows = [];
  let ordinal = 0;
  for (const route of XHS_EXPLORATION_VISION_CORPUS_ROUTES) {
    for (let sample = 0; sample < 3; sample += 1) {
      ordinal += 1;
      const bytes = png(1080, 2400, ordinal);
      const sourceRef = `src:${sha256(`private-source-${ordinal}`)}`;
      const role = ROLE_BY_ROUTE[route];
      const row = {
        id: `row-${String(ordinal).padStart(3, "0")}`,
        sourceRef,
        frame: {
          sha256: sha256(bytes),
          width: 1080,
          height: 2400,
          alias: `0${((ordinal - 1) % 4) + 1}`,
          receiptHash: "",
        },
        pageClass: route,
        dumpVerdict: sample % 2 === 0 ? "AMBIGUOUS_SAFE" : "ABSENT_OR_INVALID",
        positiveRoles: [role],
        geometry: {
          positiveRegions: [{ role, bounds: [100, 200, 800, 1800] }],
          protectedRegions: [
            { kind: "STATUS_BAR", bounds: [0, 0, 1080, 100] },
            { kind: "SOCIAL_ACTIONS", bounds: [900, 100, 1080, 2000] },
            { kind: "BOTTOM_NAV", bounds: [0, 2000, 1080, 2400] },
          ],
        },
        annotationHash: "",
      };
      const receipt = {
        schemaId: XHS_EXPLORATION_DUMP_RECEIPT_SCHEMA_ID,
        schemaVersion: 1,
        frameHash: row.frame.sha256,
        pageClass: row.pageClass,
        requestedRole: role,
        dumpDecision: {
          verdict: row.dumpVerdict,
          page: row.pageClass,
          navigationRole: role,
          visionEligible: true,
          evidenceHash: sha256(`dump-evidence-${ordinal}`),
          positiveRegions: row.geometry.positiveRegions,
          protectedRegions: row.geometry.protectedRegions,
          reasons: [sample % 2 === 0 ? "multiple_safe_candidates" : "target_absent_in_known_positive_region"],
        },
      };
      const receiptBytes = Buffer.from(JSON.stringify(receipt), "utf8");
      row.frame.receiptHash = sha256(receiptBytes);
      row.annotationHash = deriveVisionCorpusAnnotationHash(row);
      rows.push(row);
      frames.set(sourceRef, bytes);
      receipts.set(row.frame.receiptHash, receiptBytes);
    }
  }
  return {
    manifest: {
      schemaId: "xw.xhs.exploration-vision-corpus.v1",
      schemaVersion: 1,
      requiredRoutes: [...XHS_EXPLORATION_VISION_CORPUS_ROUTES],
      minimumDistinctFramesPerRoute: 3,
      provenance: { ...XHS_EXPLORATION_VISION_CORPUS_PROVENANCE },
      coverage: coverageFor(rows),
      rows,
    },
    frames,
    receipts,
  };
}

test("DUMP receipt builder preserves exact fallback eligibility and parser geometry", () => {
  const frameHash = "1".repeat(64);
  const evidenceHash = "2".repeat(64);
  const dumpDecision = {
    verdict: "AMBIGUOUS_SAFE",
    page: "IMAGE_NOTE",
    navigationRole: "OPEN_COMMENT_PANEL",
    visionEligible: true,
    positiveRegion: { x: 100, y: 200, w: 700, h: 1600 },
    protectedZones: [
      { kind: "status_bar", x: 0, y: 0, w: 1080, h: 100 },
      { kind: "effect_control", x: 900, y: 200, w: 180, h: 1600 },
    ],
    reasons: ["multiple_safe_role_candidates"],
  };
  assert.deepEqual(buildVisionCorpusDumpReceipt({
    frameHash,
    pageClass: "IMAGE_NOTE",
    requestedRole: "OPEN_COMMENT_PANEL",
    dumpDecision,
    evidenceHash,
  }), {
    schemaId: XHS_EXPLORATION_DUMP_RECEIPT_SCHEMA_ID,
    schemaVersion: 1,
    frameHash,
    pageClass: "IMAGE_NOTE",
    requestedRole: "OPEN_COMMENT_PANEL",
    dumpDecision: {
      verdict: "AMBIGUOUS_SAFE",
      page: "IMAGE_NOTE",
      navigationRole: "OPEN_COMMENT_PANEL",
      visionEligible: true,
      evidenceHash,
      positiveRegions: [{ role: "OPEN_COMMENT_PANEL", bounds: [100, 200, 800, 1800] }],
      protectedRegions: [
        { kind: "STATUS_BAR", bounds: [0, 0, 1080, 100] },
        { kind: "SOCIAL_ACTIONS", bounds: [900, 200, 1080, 1800] },
      ],
      reasons: ["multiple_safe_role_candidates"],
    },
  });

  const complete = buildVisionCorpusDumpReceipt({
      frameHash,
      pageClass: "IMAGE_NOTE",
      requestedRole: "OPEN_COMMENT_PANEL",
      dumpDecision: {
        ...dumpDecision,
        verdict: "COMPLETE_SAFE_UNIQUE",
        visionEligible: false,
      },
      evidenceHash,
    });
  assert.equal(complete.dumpDecision.verdict, "COMPLETE_SAFE_UNIQUE");
  assert.equal(complete.dumpDecision.visionEligible, false);
  assert.deepEqual(complete.dumpDecision.positiveRegions, [
    { role: "OPEN_COMMENT_PANEL", bounds: [100, 200, 800, 1800] },
  ]);
});

function safeResult(request) {
  return {
    frameHash: request.frame.sha256,
    verdict: "SAFE",
    blocks: [{
      role: request.requestedRole,
      semanticClass: "NAVIGATION",
      confidence: 0.97,
      bounds: [200, 400, 400, 600],
    }],
  };
}

function providerMutatingFirst(fixture, mutate) {
  const first = fixture.manifest.rows[0].frame.sha256;
  return pinnedProvider(async (request) => {
    const result = safeResult(request);
    return request.frame.sha256 === first ? mutate(result, request) : result;
  });
}

function pinnedProvider(analyze, providerIdentity = IDENTITY) {
  return Object.freeze({
    providerIdentity: Object.freeze({ ...providerIdentity }),
    analyze,
  });
}

async function runFixture(fixture, provider = pinnedProvider(async (request) => safeResult(request))) {
  return evaluateVisionCorpusGate({
    manifest: fixture.manifest,
    loadFrame: async (sourceRef) => fixture.frames.get(sourceRef),
    loadDumpReceipt: async (receiptHash) => fixture.receipts.get(receiptHash),
    provider,
    expectedProviderIdentity: IDENTITY,
  });
}

function assertFailClosed(result, expectedCode) {
  assert.equal(result.passed, false);
  assert.equal(result.tapCount, 0);
  if (expectedCode) {
    assert.ok(result.errors.some((error) => error.code === expectedCode),
      `expected ${expectedCode}; got ${result.errors.map((error) => error.code).join(", ")}`);
  }
}

test("checked-in manifest is privacy-safe and honestly records only HOME_FEED 4 + SEARCH_RESULTS 3", () => {
  const validation = validateVisionCorpusManifest(MANIFEST);
  assert.equal(validation.valid, true);
  assert.equal(validation.complete, false);
  assert.equal(validation.passed, false);
  assert.deepEqual(validation.coverage.distinctFramesByRoute, {
    HOME_FEED: 4,
    SEARCH_RESULTS: 3,
    IMAGE_NOTE: 0,
    VIDEO_NOTE: 0,
    COMMENT_PANEL: 0,
  });
  assert.deepEqual(validation.coverage.missingRoutes, ["IMAGE_NOTE", "VIDEO_NOTE", "COMMENT_PANEL"]);
  assert.equal(MANIFEST.rows.length, 7);
  assert.deepEqual(MANIFEST.provenance, XHS_EXPLORATION_VISION_CORPUS_PROVENANCE);
  assert.equal(MANIFEST.provenance.gateECountingEligible, false);
  assert.ok(MANIFEST.rows.every((row) => /^src:[0-9a-f]{64}$/.test(row.sourceRef)));
  assert.ok(MANIFEST.rows.every((row) => row.annotationHash === deriveVisionCorpusAnnotationHash(row)));
  const publicBytes = JSON.stringify(MANIFEST);
  assert.doesNotMatch(publicBytes, /[a-zA-Z]:[\\/]/);
  assert.doesNotMatch(publicBytes, /(?:ocr|landmark|filename|filepath|"path"|"text"|"label")/i);

  const forgedCountingCorpus = structuredClone(MANIFEST);
  forgedCountingCorpus.provenance.gateECountingEligible = true;
  const forgedValidation = validateVisionCorpusManifest(forgedCountingCorpus);
  assert.equal(forgedValidation.valid, false);
  assert.ok(forgedValidation.errors.some((error) => error.code === "CORPUS_PROVENANCE_INVALID"));
});

test("complete five-route corpus passes only with exact frame bytes and a pinned safe unique provider", async () => {
  const fixture = buildFixture();
  const validation = validateVisionCorpusManifest(fixture.manifest);
  assert.equal(validation.valid, true);
  assert.equal(validation.complete, true);
  const result = await runFixture(fixture);
  assert.equal(result.passed, true);
  assert.equal(result.tapCount, 15);
  assert.ok(result.rows.every((row) => row.tapAuthorized));
});

test("provider input is oracle-separated: frame + page/requestedRole only", async () => {
  const fixture = buildFixture();
  const observed = [];
  const provider = pinnedProvider(async (request) => {
    observed.push(request);
    return safeResult(request);
  });
  const result = await runFixture(fixture, provider);
  assert.equal(result.passed, true);
  assert.equal(observed.length, 15);
  for (const request of observed) {
    assert.deepEqual(Object.keys(request).sort(), ["frame", "page", "requestedRole"]);
    assert.deepEqual(Object.keys(request.frame).sort(), ["bytes", "height", "sha256", "width"]);
    assert.equal(Buffer.isBuffer(request.frame.bytes), true);
    assert.equal(Object.isFrozen(request), true);
    assert.equal(Object.isFrozen(request.frame), true);
    const serialized = JSON.stringify({ ...request, frame: { ...request.frame, bytes: "<bytes>" } });
    assert.doesNotMatch(serialized, /annotation|positiveRegions|protectedRegions|sourceRef|rowId|alias|receipt/i);
  }
});

test("content-addressed DUMP receipts, not screenshot labels, prove vision eligibility", async (t) => {
  await t.test("ordinary COMPLETE DUMP cannot be relabelled AMBIGUOUS by the manifest", async () => {
    const fixture = buildFixture();
    const row = fixture.manifest.rows.find((candidate) => candidate.pageClass === "IMAGE_NOTE");
    const receipt = JSON.parse(fixture.receipts.get(row.frame.receiptHash).toString("utf8"));
    receipt.dumpDecision.verdict = "COMPLETE_SAFE_UNIQUE";
    receipt.dumpDecision.visionEligible = false;
    receipt.dumpDecision.reasons = ["unique_dump_target"];
    const bytes = Buffer.from(JSON.stringify(receipt), "utf8");
    fixture.receipts.delete(row.frame.receiptHash);
    row.frame.receiptHash = sha256(bytes);
    row.annotationHash = deriveVisionCorpusAnnotationHash(row);
    fixture.receipts.set(row.frame.receiptHash, bytes);
    assertFailClosed(await runFixture(fixture), "CORPUS_DUMP_RECEIPT_DECISION_DRIFT");
  });

  await t.test("receipt byte drift fails before provider evaluation", async () => {
    const fixture = buildFixture();
    const first = fixture.manifest.rows[0];
    fixture.receipts.set(first.frame.receiptHash, Buffer.from("{}", "utf8"));
    assertFailClosed(await runFixture(fixture), "CORPUS_DUMP_RECEIPT_HASH_DRIFT");
  });

  await t.test("receipt geometry cannot be substituted for the hand oracle", async () => {
    const fixture = buildFixture();
    const row = fixture.manifest.rows[0];
    const receipt = JSON.parse(fixture.receipts.get(row.frame.receiptHash).toString("utf8"));
    receipt.dumpDecision.positiveRegions[0].bounds[0] += 1;
    const bytes = Buffer.from(JSON.stringify(receipt), "utf8");
    fixture.receipts.delete(row.frame.receiptHash);
    row.frame.receiptHash = sha256(bytes);
    row.annotationHash = deriveVisionCorpusAnnotationHash(row);
    fixture.receipts.set(row.frame.receiptHash, bytes);
    assertFailClosed(await runFixture(fixture), "CORPUS_DUMP_RECEIPT_GEOMETRY_DRIFT");
  });
});

test("real-process adapter binds page/role and maps only closed generic navigation labels", async () => {
  const fixture = buildFixture();
  const observed = [];
  const labels = {
    OPEN_CONTENT_CARD: "打开内容卡片安全区",
    OPEN_COMMENT_PANEL: "打开评论面板导航区",
    PAUSE_VIDEO_SAFE_ZONE: "暂停视频安全区",
    BACK: "返回导航区",
  };
  const provider = createVisionCorpusProcessProviderAdapter({
    providerIdentity: IDENTITY,
    analyzer: {
      async analyze(request) {
        observed.push(request);
        return [{
          label: labels[request.requestedRole],
          bounds: { x: 200, y: 400, w: 200, h: 200 },
          confidence: 0.97,
        }];
      },
    },
  });
  const result = await runFixture(fixture, provider);
  assert.equal(result.passed, true);
  assert.equal(observed.length, 15);
  assert.ok(observed.every((request) => (
    Object.hasOwn(request, "page")
    && Object.hasOwn(request, "requestedRole")
    && !Object.hasOwn(request, "annotation")
  )));
});

test("frame hash, dimensions, duplicate evidence, and route coverage mutations fail closed", async (t) => {
  await t.test("frame byte hash drift", async () => {
    const fixture = buildFixture();
    fixture.manifest.rows[0].frame.sha256 = "f".repeat(64);
    fixture.manifest.rows[0].annotationHash = deriveVisionCorpusAnnotationHash(fixture.manifest.rows[0]);
    fixture.manifest.coverage = coverageFor(fixture.manifest.rows);
    assertFailClosed(await runFixture(fixture), "CORPUS_FRAME_HASH_DRIFT");
  });

  await t.test("PNG dimension drift", async () => {
    const fixture = buildFixture();
    fixture.manifest.rows[0].frame.width = 1079;
    fixture.manifest.rows[0].annotationHash = deriveVisionCorpusAnnotationHash(fixture.manifest.rows[0]);
    assertFailClosed(await runFixture(fixture), "CORPUS_FRAME_DIMS_DRIFT");
  });

  await t.test("duplicate frame removes three-distinct coverage", async () => {
    const fixture = buildFixture();
    fixture.manifest.rows[1].frame.sha256 = fixture.manifest.rows[0].frame.sha256;
    fixture.manifest.rows[1].annotationHash = deriveVisionCorpusAnnotationHash(fixture.manifest.rows[1]);
    fixture.manifest.coverage = coverageFor(fixture.manifest.rows);
    assertFailClosed(await runFixture(fixture), "CORPUS_FRAME_DUPLICATE");
  });

  await t.test("route reassignment leaves its original route incomplete", async () => {
    const fixture = buildFixture();
    const row = fixture.manifest.rows[0];
    row.pageClass = "SEARCH_RESULTS";
    row.positiveRoles = ["OPEN_CONTENT_CARD"];
    row.geometry.positiveRegions[0].role = "OPEN_CONTENT_CARD";
    row.annotationHash = deriveVisionCorpusAnnotationHash(row);
    fixture.manifest.coverage = coverageFor(fixture.manifest.rows);
    assertFailClosed(await runFixture(fixture), "CORPUS_INCOMPLETE");
  });

  await t.test("unknown route never reaches object prototype or provider", async () => {
    const fixture = buildFixture();
    const row = fixture.manifest.rows[0];
    row.pageClass = "toString";
    row.annotationHash = deriveVisionCorpusAnnotationHash(row);
    fixture.manifest.coverage = coverageFor(fixture.manifest.rows);
    assertFailClosed(await runFixture(fixture), "CORPUS_PAGE_CLASS_INVALID");
  });

  await t.test("one row cannot smuggle multiple requested roles to weaken the oracle", async () => {
    const fixture = buildFixture();
    const row = fixture.manifest.rows.find((candidate) => candidate.pageClass === "VIDEO_NOTE");
    row.positiveRoles.push("OPEN_COMMENT_PANEL");
    row.geometry.positiveRegions.push({
      role: "OPEN_COMMENT_PANEL",
      bounds: [100, 200, 800, 1800],
    });
    row.annotationHash = deriveVisionCorpusAnnotationHash(row);
    assertFailClosed(await runFixture(fixture), "CORPUS_POSITIVE_ROLES_INVALID");
  });

  await t.test("malformed role annotations fail closed without crashing receipt validation", async () => {
    const fixture = buildFixture();
    const row = fixture.manifest.rows[0];
    row.positiveRoles = null;
    row.annotationHash = deriveVisionCorpusAnnotationHash(row);
    const result = await runFixture(fixture);
    assertFailClosed(result, "CORPUS_POSITIVE_ROLES_INVALID");
    assert.equal(result.tapCount, 0);
  });
});

test("provider identity, confidence, uniqueness, geometry, semantics, crash and absence all fail with tap0", async (t) => {
  const cases = [
    {
      name: "provider bundle identity drift",
      code: "CORPUS_PROVIDER_IDENTITY_DRIFT",
      wrapperIdentity: { ...IDENTITY, providerBundleDigest: "8".repeat(64) },
    },
    {
      name: "provider identity drift",
      code: "CORPUS_PROVIDER_IDENTITY_DRIFT",
      wrapperIdentity: { ...IDENTITY, modelHash: "d".repeat(64) },
    },
    {
      name: "python executable identity drift",
      code: "CORPUS_PROVIDER_IDENTITY_DRIFT",
      wrapperIdentity: { ...IDENTITY, pythonHash: "e".repeat(64) },
    },
    {
      name: "low confidence",
      code: "CORPUS_PROVIDER_CONFIDENCE_LOW",
      mutate(result) {
        result.blocks[0].confidence = 0.89;
        return result;
      },
    },
    {
      name: "duplicate candidate",
      code: "CORPUS_PROVIDER_NOT_UNIQUE",
      mutate(result) {
        result.blocks.push({ ...result.blocks[0] });
        return result;
      },
    },
    {
      name: "out of frame bounds",
      code: "CORPUS_PROVIDER_BOUNDS_INVALID",
      mutate(result) {
        result.blocks[0].bounds = [1000, 2200, 1200, 2500];
        return result;
      },
    },
    {
      name: "protected region intersection",
      code: "CORPUS_PROVIDER_INTERSECTS_PROTECTED",
      mutate(result) {
        result.blocks[0].bounds = [200, 40, 400, 90];
        return result;
      },
    },
    {
      name: "effect relabel",
      code: "CORPUS_PROVIDER_EFFECT_RELABEL",
      mutate(result) {
        result.blocks[0].semanticClass = "EFFECT_CONTROL";
        return result;
      },
    },
  ];

  for (const mutation of cases) {
    await t.test(mutation.name, async () => {
      const fixture = buildFixture();
      const provider = mutation.wrapperIdentity
        ? pinnedProvider(async (request) => safeResult(request), mutation.wrapperIdentity)
        : providerMutatingFirst(fixture, mutation.mutate);
      assertFailClosed(
        await runFixture(fixture, provider),
        mutation.code,
      );
    });
  }

  await t.test("provider crash", async () => {
    const fixture = buildFixture();
    const first = fixture.manifest.rows[0].frame.sha256;
    const provider = pinnedProvider(async (request) => {
      if (request.frame.sha256 === first) throw new Error("simulated provider crash");
      return safeResult(request);
    });
    assertFailClosed(await runFixture(fixture, provider), "CORPUS_PROVIDER_CRASH");
  });

  await t.test("provider absence", async () => {
    const fixture = buildFixture();
    assertFailClosed(await runFixture(fixture, null), "CORPUS_PROVIDER_MISSING");
  });
});

test("unsafe/ambiguous output and frame/protocol binding drift never authorize a tap", async (t) => {
  await t.test("ambiguous verdict", async () => {
    const fixture = buildFixture();
    const provider = providerMutatingFirst(fixture, (result) => {
      result.verdict = "AMBIGUOUS";
      result.blocks = [];
      return result;
    });
    assertFailClosed(await runFixture(fixture, provider), "CORPUS_PROVIDER_UNSAFE_OR_AMBIGUOUS");
  });

  await t.test("frame binding drift", async () => {
    const fixture = buildFixture();
    const provider = providerMutatingFirst(fixture, (result) => {
      result.frameHash = "e".repeat(64);
      return result;
    });
    assertFailClosed(await runFixture(fixture, provider), "CORPUS_PROVIDER_BINDING_DRIFT");
  });

  await t.test("provider cannot smuggle oracle/provenance fields into its result", async () => {
    const fixture = buildFixture();
    const provider = providerMutatingFirst(fixture, (result) => {
      result.annotationHash = "e".repeat(64);
      return result;
    });
    assertFailClosed(await runFixture(fixture, provider), "CORPUS_PROVIDER_RESULT_FIELD_INVALID");
  });

  await t.test("hand annotation mutation without resealing", async () => {
    const fixture = buildFixture();
    fixture.manifest.rows[0].geometry.positiveRegions[0].bounds[0] += 1;
    assertFailClosed(await runFixture(fixture), "CORPUS_ANNOTATION_HASH_INVALID");
  });

  await t.test("private frame absence", async () => {
    const fixture = buildFixture();
    fixture.frames.delete(fixture.manifest.rows[0].sourceRef);
    assertFailClosed(await runFixture(fixture), "CORPUS_FRAME_BYTES_MISSING");
  });
});

test("public manifest rejects path and OCR-shaped data even when annotation is resealed", () => {
  const fixture = buildFixture();
  fixture.manifest.rows[0].path = "C:\\private\\frame.png";
  fixture.manifest.rows[0].annotationHash = deriveVisionCorpusAnnotationHash(fixture.manifest.rows[0]);
  const validation = validateVisionCorpusManifest(fixture.manifest);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => error.code === "CORPUS_PUBLIC_PATH_FORBIDDEN"));
  assert.ok(validation.errors.some((error) => error.code === "CORPUS_PUBLIC_FIELD_FORBIDDEN"));
});

test("path-traversal sourceRef fails before the private loader or provider sees it", async () => {
  const fixture = buildFixture();
  fixture.manifest.rows[0].sourceRef = "src:../../private-frame.png";
  fixture.manifest.rows[0].annotationHash = deriveVisionCorpusAnnotationHash(fixture.manifest.rows[0]);
  let loaderCalls = 0;
  let providerCalls = 0;
  const result = await evaluateVisionCorpusGate({
    manifest: fixture.manifest,
    loadFrame: async () => {
      loaderCalls += 1;
      return Buffer.alloc(0);
    },
    loadDumpReceipt: async () => Buffer.from("{}", "utf8"),
    provider: async () => {
      providerCalls += 1;
      return null;
    },
    expectedProviderIdentity: IDENTITY,
  });
  assertFailClosed(result, "CORPUS_SOURCE_REF_INVALID");
  assert.equal(loaderCalls, fixture.manifest.rows.length - 1);
  assert.equal(providerCalls, 0);
  assert.ok(result.errors.some((error) => error.code === "CORPUS_FRAME_SOURCE_REF_UNSAFE"));
});
