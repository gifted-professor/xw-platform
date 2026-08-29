#!/usr/bin/env node

/**
 * P4A corpus operator.
 *
 * This tracked CLI is intentionally offline-only until P5 wires it through the
 * immutable task-owned runtime. It accepts local fixture JSON only: there is no
 * endpoint flag, HTTP client, device transport, job/session API, module path,
 * or caller-selected adapter.
 *
 *   node ops/xw-xhs-exploration-corpus.mjs preflight [--input fixture.json]
 *   node ops/xw-xhs-exploration-corpus.mjs traverse
 *   node ops/xw-xhs-exploration-corpus.mjs capture --input fixture.json
 *   node ops/xw-xhs-exploration-corpus.mjs seal --input seal-input.json
 *   node ops/xw-xhs-exploration-corpus.mjs evaluate --input sealed-input.json
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  createFixtureCorpusAdapter,
  createOfflineCorpusOperator,
  sealBlindLabels,
} from "../scripts/lib/xhs-exploration-corpus-operator.mjs";

const COMMANDS = new Set(["preflight", "traverse", "capture", "seal", "evaluate"]);
const DEFAULT_FIXTURE_KEY = Buffer.alloc(32, 0x5a);
const DEFAULT_KEY_ID = "p4a-fixture-key-v1";

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!COMMANDS.has(command)) {
    fail("XHS_CORPUS_COMMAND_INVALID", "expected preflight|traverse|capture|seal|evaluate");
  }
  let inputPath = null;
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token !== "--input" || inputPath !== null || !rest[index + 1]) {
      fail("XHS_CORPUS_ARGUMENT_FORBIDDEN", `unsupported argument: ${token}`);
    }
    inputPath = resolve(rest[index + 1]);
    index += 1;
  }
  if (command === "traverse" && inputPath !== null) {
    fail("XHS_CORPUS_ARGUMENT_FORBIDDEN", "traverse uses only the built-in sealed exact-pair fixture");
  }
  if (!new Set(["preflight", "traverse"]).has(command) && inputPath === null) {
    fail("XHS_CORPUS_INPUT_REQUIRED", `${command} requires --input fixture.json`);
  }
  return { command, inputPath };
}

function loadInput(path) {
  if (path === null) return {};
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("XHS_CORPUS_INPUT_INVALID", "input must be one JSON object");
  }
  const serialized = JSON.stringify(parsed);
  if (/"(?:endpoint|baseUrl|host|port|transport|adapter|module|command|adb|device|controlPlane|registry)"\s*:/i.test(serialized)) {
    fail("XHS_CORPUS_PRODUCTION_SURFACE_FORBIDDEN", "production/dynamic transport fields are forbidden in P4A");
  }
  return parsed;
}

function fixtureKey(input) {
  if (input.fixtureSigningKeyHex === undefined) return DEFAULT_FIXTURE_KEY;
  if (typeof input.fixtureSigningKeyHex !== "string"
    || !/^[0-9a-f]{64,}$/i.test(input.fixtureSigningKeyHex)
    || input.fixtureSigningKeyHex.length % 2 !== 0) {
    fail("XHS_CORPUS_FIXTURE_KEY_INVALID", "fixtureSigningKeyHex must encode at least 32 bytes");
  }
  return Buffer.from(input.fixtureSigningKeyHex, "hex");
}

function decodeFixtureCapture(capture, index) {
  if (!capture || typeof capture !== "object" || Array.isArray(capture)) {
    fail("XHS_CORPUS_FIXTURE_CAPTURE_INVALID", `captures[${index}] must be an object`);
  }
  for (const field of ["pngBase64", "dumpBase64", "focusBase64"]) {
    if (typeof capture[field] !== "string" || capture[field].length === 0) {
      fail("XHS_CORPUS_FIXTURE_BYTES_INVALID", `captures[${index}].${field} is required`);
    }
  }
  const {
    pngBase64,
    dumpBase64,
    focusBase64,
    ...metadata
  } = capture;
  return {
    ...metadata,
    pngBytes: Buffer.from(pngBase64, "base64"),
    dumpBytes: Buffer.from(dumpBase64, "base64"),
    focusBytes: Buffer.from(focusBase64, "base64"),
  };
}

export async function runCli(argv = process.argv.slice(2)) {
  const { command, inputPath } = parseArgs(argv);
  const input = loadInput(inputPath);
  const signingKey = fixtureKey(input);
  const digestKeyId = input.digestKeyId ?? DEFAULT_KEY_ID;
  const captures = Array.isArray(input.captures)
    ? input.captures.map(decodeFixtureCapture)
    : [];
  const adapter = createFixtureCorpusAdapter({ captures });
  const operator = createOfflineCorpusOperator({
    adapter,
    signingKey,
    digestKeyId,
    expectedRuntime: input.expectedRuntime ?? null,
  });

  if (command === "preflight") return operator.preflight();
  if (command === "traverse") return operator.traverse();
  if (command === "capture") return operator.capture();
  if (command === "seal") {
    const labels = sealBlindLabels({
      receipts: input.receipts,
      annotations: input.annotations,
      reviewerId: input.reviewerId,
      providerImplementerId: input.providerImplementerId,
      annotationsSealedAt: input.annotationsSealedAt,
      providerOutputDisclosedAt: input.providerOutputDisclosedAt ?? null,
      accessAttestationHash: input.accessAttestationHash,
      signingKey,
      digestKeyId,
    });
    return operator.seal({
      receipts: input.receipts,
      annotationManifest: labels.annotationManifest,
      labelSession: labels.labelSession,
    });
  }
  return operator.evaluate({ bundle: input.bundle });
}

async function main() {
  try {
    const result = await runCli();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      passed: false,
      code: error?.code ?? String(error?.message ?? error).split(":", 1)[0] ?? "XHS_CORPUS_FAILED",
      message: error?.message ?? String(error),
      resources: { jobs: 0, sessions: 0, leases: 0, deviceIo: 0 },
    })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
