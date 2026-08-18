import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildManifest,
  buildProjection,
  collectEntries,
  detectCaseCollisions,
  fsGitMode,
  hashBytes,
  manifestHash,
  toPosixPath,
} from "../hash.mjs";
import { canonicalize } from "../jcs.mjs";

// Known-answer: build a manifest from explicit entries and compare the JCS string
// to a hand-written expected canonical form. This verifies the manifest shape,
// the UTF-8 path byte sort, and the field order — independent of the sha256 value.
test("buildManifest produces the canonical shape with UTF-8-byte-sorted paths", () => {
  const entries = [
    { path: "b/zebra.txt", gitMode: "100644", size: 3, sha256: "a".repeat(64) },
    { path: "b/Apple.txt", gitMode: "100644", size: 4, sha256: "b".repeat(64) },
    { path: "a.txt", gitMode: "100644", size: 1, sha256: "c".repeat(64) },
  ];
  // UTF-8 byte sort: "a.txt" < "b/Apple.txt" (uppercase A=0x41 < lowercase z=0x7a)
  //   < "b/zebra.txt". Array order is preserved; within each entry object JCS sorts
  //   keys alphabetically (gitMode, path, sha256, size), and the top-level object
  //   sorts to (files, schemaId, schemaVersion).
  const expected =
    '{"files":[' +
    '{"gitMode":"100644","path":"a.txt","sha256":"' + "c".repeat(64) + '","size":1},' +
    '{"gitMode":"100644","path":"b/Apple.txt","sha256":"' + "b".repeat(64) + '","size":4},' +
    '{"gitMode":"100644","path":"b/zebra.txt","sha256":"' + "a".repeat(64) + '","size":3}' +
    '],"schemaId":"xhs.m0.file-manifest.v1","schemaVersion":1}';
  assert.equal(canonicalize(buildManifest(entries)), expected);
});

test("buildManifest does not mutate the input array order", () => {
  const entries = [
    { path: "z", gitMode: "100644", size: 0, sha256: "0".repeat(64) },
    { path: "a", gitMode: "100644", size: 0, sha256: "0".repeat(64) },
  ];
  buildManifest(entries);
  assert.deepEqual(entries.map((e) => e.path), ["z", "a"]);
});

test("manifestHash is 64 lowercase hex and order-invariant (sort applied)", () => {
  const a = [
    { path: "z", gitMode: "100644", size: 1, sha256: "a".repeat(64) },
    { path: "a", gitMode: "100644", size: 1, sha256: "b".repeat(64) },
  ];
  const b = [...a].reverse();
  const ha = manifestHash(a);
  const hb = manifestHash(b);
  assert.match(ha, /^[a-f0-9]{64}$/);
  assert.equal(ha, hb, "hash must be order-invariant because buildManifest sorts");
});

test("manifestHash changes when content, size, or mode changes", () => {
  const base = { path: "x", gitMode: "100644", size: 1, sha256: "a".repeat(64) };
  const h = manifestHash([base]);
  assert.notEqual(h, manifestHash([{ ...base, sha256: "b".repeat(64) }]));
  assert.notEqual(h, manifestHash([{ ...base, size: 2 }]));
  assert.notEqual(h, manifestHash([{ ...base, gitMode: "100755" }]));
  assert.notEqual(h, manifestHash([{ ...base, path: "y" }]));
});

test("toPosixPath converts backslashes, preserves case and forward slashes", () => {
  assert.equal(toPosixPath("docs\\platform\\m0\\x.json"), "docs/platform/m0/x.json");
  assert.equal(toPosixPath("a/b/c"), "a/b/c");
  assert.equal(toPosixPath("Foo.TXT"), "Foo.TXT");
});

test("detectCaseCollisions throws on case-only differences", () => {
  assert.doesNotThrow(() => detectCaseCollisions(["a/b.txt", "a/c.txt"]));
  assert.throws(
    () => detectCaseCollisions(["a/Foo.txt", "a/foo.txt"]),
    /case collision/,
  );
});

test("hashBytes is 64 lowercase hex over raw content", () => {
  // sha256("abc") known value
  assert.equal(
    hashBytes(Buffer.from("abc", "utf8")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("collectEntries reads bytes, sizes, and fs-derived gitMode from disk", () => {
  const root = mkdtempSync(join(tmpdir(), "m0hash-"));
  try {
    mkdirSync(join(root, "sub"), { recursive: true });
    writeFileSync(join(root, "a.txt"), "hello");
    writeFileSync(join(root, "sub", "b.txt"), "world!");
    const entries = collectEntries(root, ["a.txt", "sub/b.txt"]);
    assert.deepEqual(
      entries.map((e) => e.path),
      ["a.txt", "sub/b.txt"],
    );
    assert.equal(entries[0].size, 5);
    assert.equal(entries[0].sha256, hashBytes(Buffer.from("hello", "utf8")));
    assert.equal(entries[1].size, 6);
    assert.equal(entries[1].gitMode, "100644");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collectEntries honors gitModeMap override and detects case collisions", () => {
  const root = mkdtempSync(join(tmpdir(), "m0hash2-"));
  try {
    writeFileSync(join(root, "x.sh"), "#!/bin/sh\n");
    const map = new Map([["x.sh", "100755"]]);
    const entries = collectEntries(root, ["x.sh"], { gitModeMap: map });
    assert.equal(entries[0].gitMode, "100755");
    // case collision across two distinct relative paths that differ only by case
    writeFileSync(join(root, "Foo.txt"), "1");
    assert.throws(() => collectEntries(root, ["Foo.txt", "foo.txt"]), /case collision/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildProjection returns manifest + hash + counts", () => {
  const entries = [{ path: "a", gitMode: "100644", size: 2, sha256: "f".repeat(64) }];
  const p = buildProjection(entries);
  assert.equal(p.fileCount, 1);
  assert.equal(p.totalBytes, 2);
  assert.match(p.hash, /^[a-f0-9]{64}$/);
  assert.equal(p.manifest.files[0].path, "a");
});

// Symlink creation needs admin/developer-mode on Windows; skip there. The 120000
// branch is exercised on POSIX where unprivileged symlinks are allowed.
const symlinkTest = process.platform === "win32" ? test.skip : test;
symlinkTest("symlinks get mode 120000 and content = link target", () => {
  const root = mkdtempSync(join(tmpdir(), "m0hash3-"));
  try {
    writeFileSync(join(root, "target.txt"), "data");
    symlinkSync("target.txt", join(root, "link.txt"));
    const entries = collectEntries(root, ["link.txt"]);
    assert.equal(entries[0].gitMode, "120000");
    assert.equal(entries[0].size, "target.txt".length);
    assert.equal(entries[0].sha256, hashBytes(Buffer.from("target.txt", "utf8")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});