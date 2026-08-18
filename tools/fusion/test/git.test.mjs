import assert from "node:assert/strict";
import test from "node:test";
import { compareListings, parseLsTree } from "../git.mjs";

test("parseLsTree reads mode type oid and path", () => {
  const text = [
    "100644 blob abcdef0123456789abcdef0123456789abcdef01\tregistry.mjs",
    "100755 blob 1234567890abcdef1234567890abcdef12345678\twatchdog/watchdog.sh",
    "",
  ].join("\n");
  assert.deepEqual(parseLsTree(text), [
    { path: "registry.mjs", mode: "100644", type: "blob", oid: "abcdef0123456789abcdef0123456789abcdef01" },
    { path: "watchdog/watchdog.sh", mode: "100755", type: "blob", oid: "1234567890abcdef1234567890abcdef12345678" },
  ]);
});

test("compareListings is zero when listings match", () => {
  const listing = [
    { path: "a.mjs", mode: "100644", type: "blob", oid: "aa" },
    { path: "bin.sh", mode: "100755", type: "blob", oid: "bb" },
  ];
  assert.deepEqual(compareListings(listing, listing), {
    blobMismatchCount: 0,
    modeMismatchCount: 0,
    missingFileCount: 0,
    extraFileCount: 0,
    expectedCount: 2,
    actualCount: 2,
    details: [],
  });
});

test("compareListings counts blob mode missing and extra separately", () => {
  const expected = [
    { path: "keep.mjs", mode: "100644", type: "blob", oid: "11" },
    { path: "changed.mjs", mode: "100644", type: "blob", oid: "22" },
    { path: "mode.sh", mode: "100755", type: "blob", oid: "33" },
    { path: "gone.mjs", mode: "100644", type: "blob", oid: "44" },
  ];
  const actual = [
    { path: "keep.mjs", mode: "100644", type: "blob", oid: "11" },
    { path: "changed.mjs", mode: "100644", type: "blob", oid: "99" },
    { path: "mode.sh", mode: "100644", type: "blob", oid: "33" },
    { path: "extra.mjs", mode: "100644", type: "blob", oid: "55" },
  ];
  const cmp = compareListings(expected, actual);
  assert.equal(cmp.blobMismatchCount, 1);
  assert.equal(cmp.modeMismatchCount, 1);
  assert.equal(cmp.missingFileCount, 1);
  assert.equal(cmp.extraFileCount, 1);
  assert.deepEqual(cmp.details.map((d) => `${d.kind}:${d.path}`).sort(), [
    "blob:changed.mjs",
    "extra:extra.mjs",
    "missing:gone.mjs",
    "mode:mode.sh",
  ]);
});
