#!/usr/bin/env node
/**
 * Fixed one-shot blind-review client.
 *
 * The privileged broker launches this process as CodexSandboxOffline through
 * one session-bound S4U task.  It reads only the fixed draft in its fixed
 * working directory (stdin remains available for a reviewer-owned interactive
 * session).  It accepts no argv, path, command, credential, endpoint, or
 * secret, and the broker independently impersonates the pipe client.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HASH = /^(?!0{64}$)[0-9a-f]{64}$/u;
const MAX_BYTES = 16 * 1024 * 1024;
const FIXED_DENIED_SOURCE_FILES = Object.freeze([
  "C:\\Users\\Public\\xw-fusion\\xw-platform\\package.json",
]);
const FIXED_DENIED_DIRECTORIES = Object.freeze([
  "C:\\Users\\Public\\xw-fusion\\xw-platform",
  "C:\\Users\\Public\\xw-runtime\\private\\xhs-v3",
  "C:\\Users\\Public\\xw-runtime\\releases",
  "C:\\Program Files\\XW Platform\\providers",
]);
const ISOLATION_PROBE_CANONICAL = [
  ...FIXED_DENIED_SOURCE_FILES.map((path) => `file:${path}:DENIED`),
  ...FIXED_DENIED_DIRECTORIES.map((path) => `directory:${path}:DENIED`),
].join("\n");

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

export function verifyFixedBlindReviewSourceIsolation({
  readFileSyncFn = readFileSync,
  readdirSyncFn = readdirSync,
} = {}) {
  for (const path of FIXED_DENIED_SOURCE_FILES) {
    let denied = false;
    try { readFileSyncFn(path); } catch (error) {
      if (["EACCES", "EPERM"].includes(error?.code)) denied = true;
      else fail("XHS_V3_BLIND_REVIEW_CLIENT_SOURCE_PROBE_INVALID");
    }
    if (!denied) fail("XHS_V3_BLIND_REVIEW_CLIENT_SOURCE_DISCLOSED");
  }
  for (const path of FIXED_DENIED_DIRECTORIES) {
    let denied = false;
    try { readdirSyncFn(path); } catch (error) {
      if (["EACCES", "EPERM"].includes(error?.code)) denied = true;
      else fail("XHS_V3_BLIND_REVIEW_CLIENT_ISOLATION_PROBE_INVALID");
    }
    if (!denied) fail("XHS_V3_BLIND_REVIEW_CLIENT_PRIVATE_MATERIAL_DISCLOSED");
  }
  return createHash("sha256").update(ISOLATION_PROBE_CANONICAL, "utf8").digest();
}

export async function readBoundedBlindReviewResponse(input = process.stdin, {
  allowFixedDraft = false,
} = {}) {
  const chunks = [];
  let size = 0;
  for await (const chunk of input) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BYTES) fail("XHS_V3_BLIND_REVIEW_CLIENT_RESPONSE_TOO_LARGE");
    chunks.push(bytes);
  }
  let responseBytes = Buffer.concat(chunks);
  if (responseBytes.length === 0 && allowFixedDraft) {
    try {
      responseBytes = readFileSync(join(process.cwd(), "human-response.draft.v1.json"));
    } catch {
      fail("XHS_V3_BLIND_REVIEW_CLIENT_RESPONSE_INVALID");
    }
    if (responseBytes.length > MAX_BYTES) fail("XHS_V3_BLIND_REVIEW_CLIENT_RESPONSE_TOO_LARGE");
  }
  if (responseBytes.length < 2) fail("XHS_V3_BLIND_REVIEW_CLIENT_RESPONSE_INVALID");
  let value;
  try { value = JSON.parse(responseBytes.toString("utf8")); } catch {
    fail("XHS_V3_BLIND_REVIEW_CLIENT_RESPONSE_INVALID");
  }
  const keys = [
    "accessAttestationHash", "annotations", "challenge", "corpusSetId", "reviewRequestHash",
    "schemaId", "schemaVersion", "sessionId",
  ];
  if (!value || typeof value !== "object" || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys.sort())
    || value.schemaId !== "xw.xhs.v3-fixed-blind-review-human-response.v1" || value.schemaVersion !== 1
    || !HASH.test(value.sessionId || "") || !HASH.test(value.challenge || "")
    || !HASH.test(value.reviewRequestHash || "") || !HASH.test(value.accessAttestationHash || "")
    || !Array.isArray(value.annotations) || value.annotations.length === 0) {
    fail("XHS_V3_BLIND_REVIEW_CLIENT_RESPONSE_INVALID");
  }
  return Object.freeze({
    value,
    responseBytes,
    responseHash: createHash("sha256").update(responseBytes).digest("hex"),
    pipeName: `\\\\.\\pipe\\xw-xhs-v3-review-${value.sessionId}`,
  });
}

export async function submitBlindReviewResponse({
  input = process.stdin,
  connectFn = connect,
  retryDeadlineMs = 120_000,
  now = Date.now,
  stdout = process.stdout,
  sourceIsolationProbe = verifyFixedBlindReviewSourceIsolation,
} = {}) {
  const isolationProbe = Buffer.from(sourceIsolationProbe());
  if (isolationProbe.length !== 32) fail("XHS_V3_BLIND_REVIEW_CLIENT_ISOLATION_PROBE_INVALID");
  const loaded = await readBoundedBlindReviewResponse(input, { allowFixedDraft: true });
  // This non-secret rendezvous lets the privileged operator receive the
  // content hash without ever receiving response bytes through argv/stdout.
  stdout.write(`${JSON.stringify({
    ok: true, status: "WAITING_FOR_FIXED_BROKER", sessionId: loaded.value.sessionId,
    responseHash: loaded.responseHash,
  })}\n`);
  const deadline = now() + retryDeadlineMs;
  let socket;
  while (!socket) {
    try {
      socket = await new Promise((resolve, reject) => {
        const candidate = connectFn(loaded.pipeName);
        candidate.once("connect", () => resolve(candidate));
        candidate.once("error", reject);
      });
    } catch (error) {
      if (now() >= deadline || !["ENOENT", "ECONNREFUSED", "EPIPE"].includes(error?.code)) {
        fail("XHS_V3_BLIND_REVIEW_CLIENT_BROKER_UNAVAILABLE");
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(loaded.responseBytes.length, 0);
  socket.write(Buffer.concat([isolationProbe, header, loaded.responseBytes]));
  socket.end();
  await new Promise((resolve, reject) => {
    let admitted = false;
    socket.on("data", (bytes) => { if (Buffer.from(bytes).includes(1)) admitted = true; });
    socket.once("close", () => admitted ? resolve() : reject(Object.assign(
      new Error("broker did not acknowledge admission"), { code: "EPIPE" },
    )));
    socket.once("error", reject);
  });
  return Object.freeze({ ok: true, status: "ADMITTED", responseHash: loaded.responseHash });
}

if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === process.argv[1].toLowerCase()) {
  try {
    if (process.argv.length !== 2) fail("XHS_V3_BLIND_REVIEW_CLIENT_ARGUMENT_FORBIDDEN");
    const result = await submitBlindReviewResponse();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: { code: error?.code || "XHS_V3_BLIND_REVIEW_CLIENT_FAILED" } })}\n`);
    process.exitCode = 1;
  }
}
