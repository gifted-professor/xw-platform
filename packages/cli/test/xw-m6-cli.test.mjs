// M6-2 W8 #4/#9 — `xw m6 frame`/`xw m6 epoch` CLI namespace dispatch + dry-run.
//
// #4: `xw m6 frame ...` treats `frame` as a no-op namespace prefix (so
// `xw m6 frame preflight` routes to preflight), and `xw m6 epoch ...` dispatches
// to the operator epoch tools. #9: a `mint` dry-run (no --yes) constructs a
// signed schema-valid epoch from flags, prints the candidate + path, and writes
// nothing. Runs the real CLI as a subprocess (exercises the main guard).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const xwPath = join(dirname(fileURLToPath(import.meta.url)), "../xw.mjs");

function run(args, { cwd } = {}) {
  const result = spawnSync(process.execPath, [xwPath, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const code = result.status ?? 1;
  const line = stdout.trim().split("\n").at(-1);
  let json = null;
  try { if (line) json = JSON.parse(line); } catch { json = null; }
  return { code, stdout, stderr, json };
}

const HEX40 = "a".repeat(40);
const LOCKS = { runtimeProfile: "11".repeat(32), hardRedlinePolicy: "22".repeat(32), groundingRuntime: "33".repeat(32) };

function makeGateRoot() {
  const m6Root = mkdtempSync(join(tmpdir(), "xw-m6-cli-root-"));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  mkdirSync(join(m6Root, "m6-gate"), { recursive: true });
  writeFileSync(join(m6Root, "m6-gate", "locks.v1.json"), `${JSON.stringify({
    schemaId: "xw.m6-locks.v1", releaseId: "release-cli", sourceCommit: HEX40, lockHashes: { ...LOCKS },
  }, null, 2)}\n`);
  writeFileSync(join(m6Root, "m6-gate", "issuer-keys.json"), `${JSON.stringify({
    schemaId: "xw.m6-gate-issuer-allowlist.v1", version: 1,
    keys: [{ keyId: "key-1", subject: "operator:cli", publicKey: publicKey.export({ type: "spki", format: "pem" }), status: "active" }],
  }, null, 2)}\n`);
  const keyFile = join(m6Root, "m6-gate", "operator-key.pem");
  writeFileSync(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }));
  return { m6Root, keyFile, issuerKeysPath: join(m6Root, "m6-gate", "issuer-keys.json") };
}

test("xw m6 frame --help prints the frame usage", () => {
  const { code, stderr } = run(["m6", "frame", "--help"]);
  assert.equal(code, 0);
  assert.match(stderr, /xw m6 frame/);
});

test("xw m6 frame (no command) exits 2 with usage", () => {
  const { code, stderr } = run(["m6", "frame"]);
  assert.equal(code, 2);
  assert.match(stderr, /xw m6 frame/);
});

test("xw m6 epoch --help prints the epoch usage", () => {
  const { code, stderr } = run(["m6", "epoch", "--help"]);
  assert.equal(code, 0);
  assert.match(stderr, /xw m6 epoch mint/);
  assert.match(stderr, /xw m6 epoch aggregate-closeout/);
});

test("xw m6 epoch (no command) exits 2 with usage", () => {
  const { code, stderr } = run(["m6", "epoch"]);
  assert.equal(code, 2);
  assert.match(stderr, /xw m6 epoch/);
});

test("xw m6 epoch status without --gate-id exits 2", () => {
  const { code, stderr } = run(["m6", "epoch", "status", "--m6-root", mkdtempSync(join(tmpdir(), "xw-m6-cli-nogate-"))]);
  assert.equal(code, 2);
  assert.match(stderr, /--gate-id is required/);
});

test("xw m6 epoch mint dry-run (no --yes) builds + signs + prints and writes nothing", () => {
  const gate = makeGateRoot();
  try {
    const args = ["m6", "epoch", "mint",
      "--m6-root", gate.m6Root,
      "--gate-id", "gate-cli",
      "--release-id", "release-cli",
      "--source-commit", HEX40,
      "--allowlist", "01,02",
      "--expires-at", "2099-01-01T00:00:00.000Z",
      "--key-file", gate.keyFile,
      "--key-id", "key-1",
      "--issuer-keys", gate.issuerKeysPath,
      "--json",
    ];
    const { code, json } = run(args);
    assert.equal(code, 0);
    assert.equal(json.dryRun, true);
    assert.match(json.epoch.epochHash, /^[0-9a-f]{64}$/);
    assert.equal(json.proof.keyId, "key-1");
    assert.equal(json.epoch.actor, "operator:cli");
    // Dry-run wrote nothing — no epochs directory yet.
    assert.equal(existsSync(join(gate.m6Root, "m6-gate", "gate-cli", "epochs")), false);
  } finally {
    rmSync(gate.m6Root, { recursive: true, force: true });
  }
});

test("xw m6 epoch mint --yes writes the immutable epoch file", () => {
  const gate = makeGateRoot();
  try {
    const args = ["m6", "epoch", "mint",
      "--m6-root", gate.m6Root, "--gate-id", "gate-cli", "--release-id", "release-cli",
      "--source-commit", HEX40, "--allowlist", "01,02", "--expires-at", "2099-01-01T00:00:00.000Z",
      "--key-file", gate.keyFile, "--key-id", "key-1", "--issuer-keys", gate.issuerKeysPath,
      "--yes", "--json",
    ];
    const { code, json } = run(args);
    assert.equal(code, 0);
    assert.equal(json.dryRun, false);
    assert.equal(json.written !== null, true);
    assert.equal(existsSync(join(gate.m6Root, "m6-gate", "gate-cli", "epochs", `${json.epoch.epochHash}.json`)), true);
  } finally {
    rmSync(gate.m6Root, { recursive: true, force: true });
  }
});

test("xw m6 epoch verify on an empty gate reports ok:false (closed)", () => {
  const gate = makeGateRoot();
  try {
    const { code, json } = run(["m6", "epoch", "verify", "--m6-root", gate.m6Root, "--gate-id", "gate-cli", "--issuer-keys", gate.issuerKeysPath, "--json"]);
    assert.equal(code, 1);
    assert.equal(json.ok, false);
    assert.equal(json.epochs, 0);
  } finally {
    rmSync(gate.m6Root, { recursive: true, force: true });
  }
});

test("xw m6 epoch close cannot mint CLOSED without an explicit aggregate seal", () => {
  const gate = makeGateRoot();
  try {
    const common = ["--m6-root", gate.m6Root, "--gate-id", "gate-cli", "--issuer-keys", gate.issuerKeysPath, "--json"];
    const minted = run(["m6", "epoch", "mint", ...common,
      "--release-id", "release-cli", "--source-commit", HEX40, "--allowlist", "01,02,03,04",
      "--expires-at", "2099-01-01T00:00:00.000Z", "--key-file", gate.keyFile, "--key-id", "key-1", "--yes"]);
    assert.equal(minted.code, 0, minted.stderr);
    const activated = run(["m6", "epoch", "activate", ...common, "--epoch-hash", minted.json.epoch.epochHash, "--yes"]);
    assert.equal(activated.code, 0, activated.stderr);
    const closed = run(["m6", "epoch", "close", ...common, "--reason", "probe", "--key-file", gate.keyFile, "--key-id", "key-1", "--yes"]);
    assert.equal(closed.code, 2);
    assert.match(closed.stderr, /--aggregate-seal is required/);
    assert.equal(existsSync(join(gate.m6Root, "m6-gate", "gate-cli", "closeouts")), false);
  } finally {
    rmSync(gate.m6Root, { recursive: true, force: true });
  }
});
