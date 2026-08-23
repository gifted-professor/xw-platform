import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  assertExactM6GroundedRunStaticClosure,
  computeM6GroundedRunStaticClosure,
} from "../control-plane/lib/m6-grounded-run-tcb-closure.mjs";
import {
  createTcbManifest,
  verifyTcbManifestAgainstRoot,
} from "../control-plane/lib/tcb-manifest.mjs";

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "m6-static-tcb-"));
  for (const [path, contents] of Object.entries(files)) {
    const target = join(root, ...path.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents, "utf8");
  }
  return root;
}

function closure(root, {
  roots = ["src/entry.mjs"],
  data = ["policy/policy.json"],
} = {}) {
  return computeM6GroundedRunStaticClosure({
    rootDir: root,
    authorityRoots: roots,
    explicitDataDependencies: data,
  });
}

test("static closure follows repo-local imports, re-exports, and literal dynamic imports only", () => {
  const root = fixture({
    "policy/policy.json": "{}\n",
    "src/entry.mjs": [
      "import { value } from './static.mjs';",
      "export { leaf } from './reexport.mjs';",
      "export async function load() { return import('./dynamic.mjs'); }",
      "export default value;",
      "",
    ].join("\n"),
    "src/static.mjs": "export const value = 1;\n",
    "src/reexport.mjs": "export { leaf } from './leaf.mjs';\n",
    "src/leaf.mjs": "export const leaf = true;\n",
    "src/dynamic.mjs": "export const dynamic = true;\n",
  });
  try {
    assert.deepEqual(closure(root), [
      "policy/policy.json",
      "src/dynamic.mjs",
      "src/entry.mjs",
      "src/leaf.mjs",
      "src/reexport.mjs",
      "src/static.mjs",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a newly imported local module fails the frozen manifest path set until regeneration", () => {
  const root = fixture({
    "policy/policy.json": "{}\n",
    "src/entry.mjs": "import './stable.mjs';\n",
    "src/stable.mjs": "export const stable = true;\n",
    "src/new-authority.mjs": "export const added = true;\n",
  });
  try {
    const frozenManifestPaths = closure(root);
    appendFileSync(join(root, "src", "entry.mjs"), "import './new-authority.mjs';\n", "utf8");
    const recomputedPaths = closure(root);
    assert.throws(
      () => assertExactM6GroundedRunStaticClosure({
        declaredPaths: frozenManifestPaths,
        expectedPaths: recomputedPaths,
      }),
      (error) => error.code === "M6_GROUNDED_RUN_TCB_PATHS_MISMATCH"
        && error.details.missingFromManifest.includes("src/new-authority.mjs"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("declared data byte drift fails the reproduced implementation closure hash", () => {
  const root = fixture({
    "policy/policy.json": "{\"version\":1}\n",
    "src/entry.mjs": "export const stable = true;\n",
  });
  try {
    const paths = closure(root);
    const manifest = createTcbManifest({
      manifestId: "fixture.m6-static-tcb.v1",
      rootDir: root,
      paths,
      capabilityIds: ["fixture.m6"],
    });
    assert.doesNotThrow(() => verifyTcbManifestAgainstRoot(manifest, root));
    writeFileSync(join(root, "policy", "policy.json"), "{\"version\":2}\n", "utf8");
    assert.throws(
      () => verifyTcbManifestAgainstRoot(manifest, root),
      { code: "IMPLEMENTATION_CONTRACT_CHANGED" },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("non-literal dynamic import and non-literal require are rejected", () => {
  for (const [source, code] of [
    ["const target = './dep.mjs'; export const loaded = import(target);\n", "M6_TCB_NON_LITERAL_DYNAMIC_IMPORT"],
    ["const target = './dep.cjs'; module.exports = require(target);\n", "M6_TCB_NON_LITERAL_REQUIRE"],
  ]) {
    const root = fixture({
      "policy/policy.json": "{}\n",
      "src/entry.mjs": source,
      "src/dep.mjs": "export default true;\n",
      "src/dep.cjs": "module.exports = true;\n",
    });
    try {
      assert.throws(() => closure(root), { code });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("a literal repository read must be present in the explicit data dependency set", () => {
  const root = fixture({
    "policy/policy.json": "{}\n",
    "src/entry.mjs": [
      "import { readFileSync } from 'node:fs';",
      "export const hidden = readFileSync(new URL('./hidden.json', import.meta.url), 'utf8');",
      "",
    ].join("\n"),
    "src/hidden.json": "{\"hidden\":true}\n",
  });
  try {
    assert.throws(
      () => closure(root),
      (error) => error.code === "M6_TCB_UNDECLARED_STATIC_DATA"
        && error.details.dataPath === "src/hidden.json",
    );
    assert.deepEqual(closure(root, { data: ["policy/policy.json", "src/hidden.json"] }), [
      "policy/policy.json",
      "src/entry.mjs",
      "src/hidden.json",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("local import path escape and missing dependency are fail-closed", () => {
  const parent = mkdtempSync(join(tmpdir(), "m6-static-tcb-parent-"));
  const root = join(parent, "repo");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "policy"), { recursive: true });
  writeFileSync(join(root, "policy", "policy.json"), "{}\n", "utf8");
  writeFileSync(join(parent, "outside.mjs"), "export default true;\n", "utf8");
  try {
    writeFileSync(join(root, "src", "entry.mjs"), "import '../../outside.mjs';\n", "utf8");
    assert.throws(() => closure(root), { code: "M6_TCB_CLOSURE_PATH_ESCAPE" });

    writeFileSync(join(root, "src", "entry.mjs"), "import './missing.mjs';\n", "utf8");
    assert.throws(() => closure(root), { code: "M6_TCB_CLOSURE_DEPENDENCY_MISSING" });

    writeFileSync(join(root, "src", "entry.mjs"), [
      "import { readFileSync } from 'node:fs';",
      "export const escaped = readFileSync('../../outside.json', 'utf8');",
      "",
    ].join("\n"), "utf8");
    assert.throws(() => closure(root), { code: "M6_TCB_STATIC_DATA_PATH_ESCAPE" });
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("comments, strings, regex literals, and method names cannot forge dependency edges", () => {
  const root = fixture({
    "policy/policy.json": "{}\n",
    "src/entry.mjs": [
      "// import('./comment.mjs')",
      "const text = \"require(variable)\";",
      "const pattern = /import\\(hidden\\)|require\\(hidden\\)/u;",
      "class Registry { require(id) { return id; } }",
      "export { text, pattern, Registry };",
      "",
    ].join("\n"),
  });
  try {
    assert.deepEqual(closure(root), ["policy/policy.json", "src/entry.mjs"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
