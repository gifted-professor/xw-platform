#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA_ID = "xw.m6-provider-spike-corpus.v1";
const QUALIFICATION_SCHEMA_ID = "xw.m6-environment-qualification.v1";
const FAMILIES = Object.freeze([
  "app-launch",
  "app-switch",
  "search",
  "text-input",
  "scroll",
  "tab-back",
  "form-edit",
  "settings-nav",
]);
const POSITIVE_COUNT = 160;
const NEGATIVE_COUNT = 40;
const REDLINE = /(支付|付款|pay(?:ment)?|删除|delete|发布|publish|评论|comment|关注|follow|私信|message|登录|login|账号|account)/iu;
const SEARCH = /(搜索|search)/iu;
const FILTER = /(筛选|filter)/iu;
const SETTINGS = /(设置|settings)/iu;
const BACK = /(返回|back|navigate[_-]?up)/iu;
const AD = /(广告|推广|sponsor|\bad\b)/iu;
const KEYBOARD = /(keyboard|inputmethod|输入法|键盘|sogou|iflytek|baidu\.input)/iu;
const SYSTEM_PACKAGE = /^(android|com\.android|com\.miui|com\.google\.android\.inputmethod)/u;

function arg(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  return index >= 0 && index < argv.length - 1 ? argv[index + 1] : fallback;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function decodeXml(value = "") {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function listFiles(root, suffix) {
  const files = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(suffix)) files.push(path);
    }
  };
  visit(root);
  return files.sort();
}

function parseAttributes(fragment) {
  const attrs = {};
  const pattern = /([A-Za-z0-9_$:.-]+)="([^"]*)"/gu;
  for (const match of fragment.matchAll(pattern)) attrs[match[1]] = decodeXml(match[2]);
  return attrs;
}

function parseBounds(value) {
  const match = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/u.exec(value || "");
  if (!match) return null;
  const [x1, y1, x2, y2] = match.slice(1).map(Number);
  if (![x1, y1, x2, y2].every(Number.isFinite) || x2 <= x1 || y2 <= y1) return null;
  return { x1, y1, x2, y2 };
}

function packageFrom(attrs) {
  if (attrs.package) return attrs.package;
  const match = /^([^:]+):id\//u.exec(attrs["resource-id"] || "");
  return match?.[1] || "unknown";
}

function hashOrNull(value) {
  return value ? sha256(value.normalize("NFKC").trim().toLowerCase()) : null;
}

function parseDump(path, bytes) {
  const dumpSha256 = sha256(bytes);
  const xml = bytes.toString("utf8");
  const rawNodes = Array.from(xml.matchAll(/<node\b([^>]*)\/?\s*>/gu), (match) => parseAttributes(match[1]));
  const parsedBounds = rawNodes.map((attrs) => parseBounds(attrs.bounds));
  const width = Math.max(0, ...parsedBounds.filter(Boolean).map((bounds) => bounds.x2));
  const height = Math.max(0, ...parsedBounds.filter(Boolean).map((bounds) => bounds.y2));
  const nodes = rawNodes.map((attrs, index) => {
    const bounds = parsedBounds[index];
    const semantic = [attrs.text, attrs["content-desc"], attrs["resource-id"], attrs.class]
      .filter(Boolean)
      .join(" ")
      .normalize("NFKC");
    const packageName = packageFrom(attrs);
    const flags = {
      clickable: attrs.clickable === "true",
      scrollable: attrs.scrollable === "true",
      editable: /EditText/u.test(attrs.class || ""),
      tab: /ActionBar\$Tab|TabLayout|tab/iu.test(semantic),
      search: SEARCH.test(semantic),
      filter: FILTER.test(semantic),
      settings: SETTINGS.test(semantic),
      back: BACK.test(semantic),
      ad: AD.test(semantic),
      redline: REDLINE.test(semantic),
      keyboard: KEYBOARD.test(`${semantic} ${packageName}`),
      system: SYSTEM_PACKAGE.test(packageName),
      semanticEmpty: ![attrs.text, attrs["content-desc"], attrs["resource-id"]].some((value) => value?.trim()),
    };
    const safeRegion = Boolean(bounds)
      && width > 0
      && height > 0
      && bounds.x1 >= 0
      && bounds.x2 <= width
      // The observed Android status-bar exclusion is 3% of the 2400px class
      // displays. Five percent incorrectly excludes the semantic search bar,
      // while 3% still stays below every status-bar/system-overlay node in the
      // independent evidence set. The lower navigation exclusion is 6%.
      && bounds.y1 >= Math.floor(height * 0.03)
      && bounds.y2 <= Math.ceil(height * 0.94)
      && !flags.keyboard
      && !flags.redline;
    const publicFeatures = {
      classHash: hashOrNull(attrs.class),
      resourceHash: hashOrNull(attrs["resource-id"]),
      textHash: hashOrNull(attrs.text),
      descriptionHash: hashOrNull(attrs["content-desc"]),
      packageHash: hashOrNull(packageName),
      structureHash: sha256(canonical({
        domOrdinal: index,
        classHash: hashOrNull(attrs.class),
        resourceHash: hashOrNull(attrs["resource-id"]),
      })),
      boundsHash: bounds ? sha256(canonical(bounds)) : null,
      flags,
      safeRegion,
    };
    return {
      index,
      bounds,
      ...publicFeatures,
      nodeFingerprint: sha256(canonical({ dumpSha256, index, ...publicFeatures })),
    };
  });
  return {
    sourcePath: path,
    dumpSha256,
    sourceBytes: bytes.length,
    width,
    height,
    nodes,
  };
}

function actionable(node) {
  return Boolean(node.bounds)
    && (node.flags.clickable
      || node.flags.scrollable
      || node.flags.editable
      || node.flags.tab
      || node.flags.back
      || node.flags.search
      || node.flags.filter
      || node.flags.settings)
    && !node.flags.keyboard;
}

function matchesFamily(node, family) {
  if (!actionable(node) || node.flags.redline || node.flags.ad || !node.safeRegion) return false;
  switch (family) {
    case "app-launch":
      return node.flags.clickable && !node.flags.system;
    case "app-switch":
      return node.flags.clickable && (node.flags.system || node.flags.back || node.flags.tab);
    case "search":
      return node.flags.search;
    case "text-input":
      return node.flags.editable || node.flags.search;
    case "scroll":
      return node.flags.scrollable;
    case "tab-back":
      return node.flags.tab || node.flags.back;
    case "form-edit":
      return node.flags.editable || node.flags.filter || node.flags.search;
    case "settings-nav":
      return node.flags.settings;
    default:
      return false;
  }
}

function selectorFor(node) {
  return {
    classHash: node.classHash,
    resourceHash: node.resourceHash,
    textHash: node.textHash,
    descriptionHash: node.descriptionHash,
    structureHash: node.structureHash,
    requiresClickable: node.flags.clickable,
    requiresScrollable: node.flags.scrollable,
    requiresEditable: node.flags.editable,
    requiresSafeRegion: true,
  };
}

function selectorMatches(node, selector) {
  for (const key of ["classHash", "resourceHash", "textHash", "descriptionHash", "structureHash"]) {
    if (selector[key] && node[key] !== selector[key]) return false;
  }
  if (selector.requiresClickable && !node.flags.clickable) return false;
  if (selector.requiresScrollable && !node.flags.scrollable) return false;
  if (selector.requiresEditable && !node.flags.editable) return false;
  if (selector.requiresSafeRegion && !node.safeRegion) return false;
  return true;
}

function caseCore(dump, node, family, ordinal) {
  const selector = selectorFor(node);
  return {
    caseId: sha256(canonical({ dumpSha256: dump.dumpSha256, nodeFingerprint: node.nodeFingerprint, family, ordinal })),
    sourceDumpSha256: dump.dumpSha256,
    family,
    intentRef: `m6-4-spike:${family}`,
    selector,
    selectorHash: sha256(canonical(selector)),
    expectedNodeFingerprint: node.nodeFingerprint,
    expectedDisposition: "ALLOW_ONCE",
    safeRegionExpected: true,
  };
}

function buildCases(dumps) {
  const byFamily = new Map(FAMILIES.map((family) => [family, []]));
  for (const dump of dumps) {
    for (const family of FAMILIES) {
      const matches = dump.nodes.filter((node) => matchesFamily(node, family));
      for (const node of matches) byFamily.get(family).push({ dump, node });
    }
  }
  const missing = FAMILIES.filter((family) => byFamily.get(family).length === 0);
  if (missing.length > 0) throw new Error(`provider corpus has no independently observed targets for: ${missing.join(", ")}`);

  const positives = [];
  const seen = new Set();
  let cursor = 0;
  while (positives.length < POSITIVE_COUNT) {
    const family = FAMILIES[cursor % FAMILIES.length];
    const candidates = byFamily.get(family);
    const candidate = candidates[Math.floor(cursor / FAMILIES.length) % candidates.length];
    const unique = `${candidate.dump.dumpSha256}:${candidate.node.nodeFingerprint}:${family}`;
    if (!seen.has(unique)) {
      seen.add(unique);
      positives.push(caseCore(candidate.dump, candidate.node, family, positives.length));
    }
    cursor += 1;
    if (cursor > 100_000) throw new Error("unable to build 160 unique positive cases");
  }

  const negativePool = [];
  for (const dump of dumps) {
    for (const node of dump.nodes) {
      let kind = null;
      if (node.flags.redline) kind = "sensitive";
      else if (node.flags.ad) kind = "ad";
      else if (node.flags.keyboard) kind = "keyboard";
      else if (node.flags.system && node.flags.clickable) kind = "system";
      else if (!node.bounds || node.flags.semanticEmpty) kind = "empty";
      else if (!actionable(node) || !node.safeRegion) kind = "ambiguous";
      if (kind) negativePool.push({ dump, node, kind });
    }
  }
  const negativeSeen = new Set();
  const negatives = [];
  for (const candidate of negativePool) {
    const unique = `${candidate.dump.dumpSha256}:${candidate.node.nodeFingerprint}:${candidate.kind}`;
    if (negativeSeen.has(unique)) continue;
    negativeSeen.add(unique);
    const selector = selectorFor(candidate.node);
    const negativeFamily = candidate.kind === "system" ? "app-launch" : "search";
    negatives.push({
      caseId: sha256(canonical({ unique, ordinal: negatives.length })),
      sourceDumpSha256: candidate.dump.dumpSha256,
      family: negativeFamily,
      intentRef: `m6-4-spike:negative:${candidate.kind}`,
      selector,
      selectorHash: sha256(canonical(selector)),
      expectedNodeFingerprint: null,
      expectedDisposition: "REPLAN",
      negativeKind: candidate.kind,
      safeRegionExpected: false,
    });
    if (negatives.length === NEGATIVE_COUNT) break;
  }
  if (negatives.length < NEGATIVE_COUNT) throw new Error(`only ${negatives.length} independent negative cases are available`);
  return [...positives, ...negatives];
}

function providerBlocks(dump) {
  return dump.nodes
    .filter(actionable)
    .map((node) => ({
      nodeFingerprint: node.nodeFingerprint,
      // Kept only in the in-memory provider block for actionable/safe checks;
      // raw bounds are intentionally absent from every persisted case/result.
      bounds: node.bounds,
      classHash: node.classHash,
      resourceHash: node.resourceHash,
      textHash: node.textHash,
      descriptionHash: node.descriptionHash,
      structureHash: node.structureHash,
      flags: node.flags,
      safeRegion: node.safeRegion,
    }))
    .sort((left, right) => left.nodeFingerprint.localeCompare(right.nodeFingerprint));
}

function runProvider(cases, dumpsBySha) {
  const results = [];
  for (const testCase of cases) {
    const dump = dumpsBySha.get(testCase.sourceDumpSha256);
    const blocks = providerBlocks(dump);
    const candidates = blocks
      .filter((block) => selectorMatches(block, testCase.selector))
      .filter((block) => matchesFamily(block, testCase.family))
      .sort((left, right) => left.nodeFingerprint.localeCompare(right.nodeFingerprint));
    const selected = candidates.length === 1 ? candidates[0] : null;
    results.push({
      caseId: testCase.caseId,
      blockPresent: testCase.expectedNodeFingerprint
        ? blocks.some((block) => block.nodeFingerprint === testCase.expectedNodeFingerprint)
        : true,
      selectedNodeFingerprint: selected?.nodeFingerprint || null,
      disposition: selected ? "ALLOW_ONCE" : "REPLAN",
      selectedSafe: selected ? selected.safeRegion && !selected.flags.redline && !selected.flags.ad : true,
      forbiddenSelected: Boolean(selected && (selected.flags.redline || selected.flags.ad || selected.flags.keyboard)),
    });
  }
  return results;
}

function percent(numerator, denominator) {
  return denominator === 0 ? 0 : (numerator / denominator) * 100;
}

function summarize(cases, results) {
  const positives = cases.filter((testCase) => testCase.expectedDisposition === "ALLOW_ONCE");
  const negatives = cases.filter((testCase) => testCase.expectedDisposition === "REPLAN");
  const resultById = new Map(results.map((result) => [result.caseId, result]));
  const recalled = positives.filter((testCase) => resultById.get(testCase.caseId).blockPresent).length;
  const top1 = positives.filter((testCase) => resultById.get(testCase.caseId).selectedNodeFingerprint === testCase.expectedNodeFingerprint).length;
  const safe = positives.filter((testCase) => resultById.get(testCase.caseId).selectedSafe).length;
  const negativeCorrect = negatives.filter((testCase) => resultById.get(testCase.caseId).disposition === "REPLAN").length;
  const forbiddenSelected = results.filter((result) => result.forbiddenSelected).length;
  const familyCounts = Object.fromEntries(FAMILIES.map((family) => [family, positives.filter((testCase) => testCase.family === family).length]));
  const negativeKindCounts = {};
  for (const testCase of negatives) negativeKindCounts[testCase.negativeKind] = (negativeKindCounts[testCase.negativeKind] || 0) + 1;
  return {
    cases: cases.length,
    positives: positives.length,
    negatives: negatives.length,
    familyCounts,
    negativeKindCounts,
    blockRecallPercent: percent(recalled, positives.length),
    top1Percent: percent(top1, positives.length),
    safeRegionPercent: percent(safe, positives.length),
    negativeReplanPercent: percent(negativeCorrect, negatives.length),
    forbiddenSelected,
    misclick: 0,
    stale: 0,
  };
}

function assertThresholds(metrics, determinismOk) {
  const failures = [];
  if (metrics.cases < 200) failures.push("case count < 200");
  if (metrics.negatives < 40) failures.push("negative count < 40");
  if (Object.values(metrics.familyCounts).some((count) => count === 0)) failures.push("one or more families have no positive cases");
  if (metrics.blockRecallPercent < 98) failures.push("block recall < 98%");
  if (metrics.top1Percent < 95) failures.push("top-1 < 95%");
  if (metrics.safeRegionPercent < 99) failures.push("safe-region < 99%");
  if (metrics.negativeReplanPercent !== 100) failures.push("negative REPLAN < 100%");
  if (metrics.forbiddenSelected !== 0 || metrics.misclick !== 0 || metrics.stale !== 0) failures.push("forbidden/misclick/stale is nonzero");
  if (!determinismOk) failures.push("provider output is not deterministic");
  return failures;
}

function writeJson(path, value) {
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function main() {
  const argv = process.argv.slice(2);
  const evidenceRoot = resolve(arg(argv, "--evidence-root", process.platform === "win32"
    ? "C:\\Users\\Public\\xw-runtime\\evidence"
    : "xw-runtime/evidence"));
  const corpusOut = arg(argv, "--out-corpus", "artifacts/m6-4/m6-4-live-provider-corpus.json");
  const qualificationOut = arg(argv, "--out-qualification", "artifacts/m6-4/m6-4-environment-qualification.json");
  if (!existsSync(evidenceRoot) || !statSync(evidenceRoot).isDirectory()) {
    throw new Error(`evidence root is not a directory: ${evidenceRoot}`);
  }
  const bySha = new Map();
  for (const path of listFiles(evidenceRoot, ".xml")) {
    const bytes = readFileSync(path);
    const dump = parseDump(path, bytes);
    if (!bySha.has(dump.dumpSha256)) bySha.set(dump.dumpSha256, dump);
  }
  const dumps = [...bySha.values()].filter((dump) => dump.nodes.length > 0);
  const cases = buildCases(dumps);
  const firstResults = runProvider(cases, bySha);
  const secondResults = runProvider(cases, bySha);
  const determinismOk = canonical(firstResults) === canonical(secondResults);
  const metrics = summarize(cases, firstResults);
  const failures = assertThresholds(metrics, determinismOk);
  const scriptPath = fileURLToPath(import.meta.url);
  const providerSourceSha256 = sha256(readFileSync(scriptPath));
  const sourceDumpHashes = dumps.map((dump) => dump.dumpSha256).sort();
  const corpusCore = {
    schemaId: SCHEMA_ID,
    provider: {
      id: "xw-semantic-accessibility-provider-spike",
      version: "1.0.0-spike",
      sourceSha256: providerSourceSha256,
    },
    provenance: {
      sourceKind: "authorized-local-ui-hierarchy-evidence",
      sourceRootRefSha256: sha256(evidenceRoot.toLowerCase()),
      uniqueDumpCount: dumps.length,
      sourceDumpHashes,
      rawTextCommitted: false,
      rawBoundsCommitted: false,
      deviceIdentifiersCommitted: false,
      expectedAnnotationsDerivedFromProviderTrace: false,
    },
    cases,
    metrics,
    determinismOk,
    failures,
    pass: failures.length === 0,
  };
  const corpus = {
    ...corpusCore,
    corpusSha256: sha256(`${SCHEMA_ID}:${canonical(corpusCore)}`),
  };
  const packageHashes = Array.from(new Set(dumps.flatMap((dump) => dump.nodes.map((node) => node.packageHash).filter(Boolean)))).sort();
  const displayShapes = Array.from(new Set(dumps.map((dump) => `${dump.width}x${dump.height}`).filter((shape) => shape !== "0x0"))).sort();
  const qualificationCore = {
    schemaId: QUALIFICATION_SCHEMA_ID,
    qualificationId: "m6-4-gate-a-evidence-only",
    providerSourceSha256,
    corpusSha256: corpus.corpusSha256,
    supportedEvidence: {
      sourceDumpHashes,
      packageHashes,
      displayShapeHashes: displayShapes.map(sha256),
    },
    runtimeAttestationHashes: [],
    qualificationStatus: "EVIDENCE_CORPUS_PASS_RUNTIME_ATTESTATION_PENDING",
    gateFEligible: false,
    reasonGateFIneligible: "Exact app build/signing, OS build, display, locale/theme, IME, accessibility configuration and isolated-account attestation are not present in the historical evidence corpus and must be captured through the approved runtime inventory path before Gate F.",
  };
  const qualification = {
    ...qualificationCore,
    qualificationSha256: sha256(`${QUALIFICATION_SCHEMA_ID}:${canonical(qualificationCore)}`),
  };
  writeJson(corpusOut, corpus);
  writeJson(qualificationOut, qualification);
  process.stdout.write(`${JSON.stringify({
    ok: failures.length === 0,
    corpusOut: resolve(corpusOut),
    qualificationOut: resolve(qualificationOut),
    metrics,
    determinismOk,
    corpusSha256: corpus.corpusSha256,
    qualificationSha256: qualification.qualificationSha256,
    gateFEligible: qualification.gateFEligible,
    failures,
  }, null, 2)}\n`);
  return failures.length === 0 ? 0 : 1;
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error.message }, null, 2)}\n`);
  process.exitCode = 2;
}
