import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";

const root = dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/u, (value) => value.slice(1)));
const host = resolve(root, "m6-4-handoff-host.ps1");
const launcher = resolve(root, "m6-4-handoff-launcher.ps1");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function plain(path, bytes = "fixture\n") {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return path;
}

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), "m64-handoff-host-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repositoryRoot = join(base, "repo");
  const workerRoot = join(repositoryRoot, "tools", "m6");
  mkdirSync(workerRoot, { recursive: true });
  for (const name of [
    "m6-4-independent-observation-worker.mjs",
    "m6-4-process-inventory-worker.mjs",
    "m6-4-normal-close-bundle-worker.mjs",
  ]) plain(join(workerRoot, name));
  const releaseRoot = join(base, "release");
  const observationTickets = join(base, "observation-tickets");
  const processRequests = join(base, "process-requests");
  const processResponses = join(base, "process-responses");
  const closeRequests = join(base, "close-requests");
  const windows = join(base, "windows");
  const closeOutput = join(base, "close-output");
  for (const path of [releaseRoot, observationTickets, processRequests, processResponses, closeRequests, windows, closeOutput]) mkdirSync(path, { recursive: true });
  const policyBytes = Buffer.from('{"schemaId":"fixture"}\n');
  const policyPath = plain(join(base, "policy.json"), policyBytes);
  const observerKey = plain(join(base, "observer-private.pem"), "not-read-during-config-validation\n");
  const gateKey = plain(join(base, "gate-private.pem"), "not-read-during-config-validation\n");
  const dbPath = plain(join(base, "control.db"));
  const config = {
    schemaId: "xw.m6-4-handoff-host-config.v1",
    nodePath: process.execPath,
    repositoryRoot,
    maxRequestBytes: 65536,
    requestTimeoutMs: 10000,
    roles: {
      observation: {
        workerPath: join(workerRoot, "m6-4-independent-observation-worker.mjs"), privateKeyPath: observerKey,
        policyDescriptor: `${policyPath}@${sha256(policyBytes)}`, releaseRoot, ticketInboxRoot: observationTickets,
        controlPlaneUrl: "http://127.0.0.1:17920/",
      },
      "process-inventory": {
        workerPath: join(workerRoot, "m6-4-process-inventory-worker.mjs"), privateKeyPath: observerKey,
        policyPath, dbPath, requestInboxRoot: processRequests, responseRoot: processResponses,
      },
      "normal-close": {
        workerPath: join(workerRoot, "m6-4-normal-close-bundle-worker.mjs"), privateKeyPath: gateKey,
        gateKeyId: "gate-key-01", gateSubject: "operator:gate-01", gateAllowlistVersion: 1,
        requestInboxRoot: closeRequests, windowInboxRoot: windows, outputRoot: closeOutput,
      },
    },
  };
  const configPath = join(base, "config.json");
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return { base, config, configPath, observationTickets };
}

function validate(configPath) {
  return JSON.parse(execFileSync("pwsh", [
    "-NoProfile", "-NonInteractive", "-File", host,
    "-PipeName", "xw-m6-4-handoff-test0001", "-ConfigPath", configPath, "-ValidateConfigOnly",
  ], { encoding: "utf8", windowsHide: true }));
}

test("host config validation freezes the three exact worker roles without reading key bytes", (t) => {
  const f = fixture(t);
  const output = validate(f.configPath);
  assert.equal(output.status, "CONFIG_VALID");
  assert.deepEqual(output.roles, ["observation", "process-inventory", "normal-close"]);
  assert.equal(output.actionCount, 0);
});

test("host rejects a worker path outside the repository allowlist and a changed descriptor", (t) => {
  const f = fixture(t);
  const outside = plain(join(f.base, "m6-4-process-inventory-worker.mjs"));
  f.config.roles["process-inventory"].workerPath = outside;
  writeFileSync(f.configPath, `${JSON.stringify(f.config, null, 2)}\n`);
  assert.throws(() => validate(f.configPath));

  const clean = fixture(t);
  writeFileSync(clean.config.roles.observation.policyDescriptor.split("@")[0], "changed\n");
  assert.throws(() => validate(clean.configPath));
});

test("observation RUN_ONCE binds one ticket descriptor to the outer request hash", (t) => {
  const f = fixture(t);
  const requestHash = "a".repeat(64);
  const ticketPath = join(f.observationTickets, "ticket.json");
  const ticketBytes = Buffer.from(`${JSON.stringify({
    schemaId: "xw.m6-4-device-read-work-ticket.v1",
    request: { requestHash },
  })}\n`);
  writeFileSync(ticketPath, ticketBytes);
  const handoffPath = join(f.base, "handoff-request.json");
  writeFileSync(handoffPath, `${JSON.stringify({
    schemaId: "xw.m6-4-handoff-host-request.v1",
    requestId: "request-observation-0001",
    operation: "RUN_ONCE",
    role: "observation",
    requestHash,
    descriptors: { ticket: { path: ticketPath, sha256: sha256(ticketBytes) } },
  })}\n`);
  const result = JSON.parse(execFileSync("pwsh", [
    "-NoProfile", "-NonInteractive", "-File", host,
    "-PipeName", "xw-m6-4-handoff-test0002", "-ConfigPath", f.configPath,
    "-ValidateRequestPath", handoffPath,
  ], { encoding: "utf8", windowsHide: true }));
  assert.deepEqual(result, {
    ok: true, status: "REQUEST_VALID", role: "observation", operation: "RUN_ONCE", requestHash, actionCount: 0,
  });
  const rebound = JSON.parse(readFileSync(handoffPath, "utf8"));
  rebound.requestHash = "b".repeat(64);
  writeFileSync(handoffPath, `${JSON.stringify(rebound)}\n`);
  assert.throws(() => execFileSync("pwsh", [
    "-NoProfile", "-NonInteractive", "-File", host,
    "-PipeName", "xw-m6-4-handoff-test0003", "-ConfigPath", f.configPath,
    "-ValidateRequestPath", handoffPath,
  ], { encoding: "utf8", windowsHide: true }));
});

test("host and launcher expose only bounded, current-user named-pipe transport and no shell dispatch", () => {
  const hostSource = readFileSync(host, "utf8");
  const launcherSource = readFileSync(launcher, "utf8");
  assert.match(hostSource, /PipeOptions\]::CurrentUserOnly/u);
  assert.match(hostSource, /ArgumentList\.Add/u);
  assert.match(hostSource, /UseShellExecute = \$false/u);
  assert.match(hostSource, /process\.Kill\(\$true\)/u);
  assert.doesNotMatch(hostSource, /Invoke-Expression|cmd\.exe|powershell\.exe/u);
  assert.match(launcherSource, /-Verb RunAs -WindowStyle Hidden/u);
  assert.equal(basename(host), "m6-4-handoff-host.ps1");
});
