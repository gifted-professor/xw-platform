import assert from "node:assert/strict";
import { win32 } from "node:path";
import test from "node:test";

import { buildChildEnv, DEFAULT_NODE_EXE, resolveNodeExe } from "../scripts/lib/node-runtime.mjs";

test("resolveNodeExe prefers XHS_NODE_EXE then pinned default", () => {
  assert.equal(resolveNodeExe({}), DEFAULT_NODE_EXE);
  assert.equal(resolveNodeExe({ XHS_NODE_EXE: "D:\\custom\\node.exe" }), "D:\\custom\\node.exe");
});

test("buildChildEnv pins XHS_NODE_EXE and prepends Node directory to PATH", () => {
  // 生产实现是 Windows 目标（win32 路径 + ';' 分隔），测试显式用 path.win32.delimiter 断言，
  // 使其在 POSIX CI 上同样成立（不再依赖宿主平台的分隔符）。
  const cursorNode = "C:\\Program Files\\cursor\\resources\\app\\resources\\helpers";
  const env = buildChildEnv({
    PATH: `${cursorNode};D:\\Other;D:\\Program Files\\Node`,
    FOO: "bar",
  });
  assert.equal(env.XHS_NODE_EXE, DEFAULT_NODE_EXE);
  assert.equal(env.FOO, "bar");
  const segments = env.PATH.split(win32.delimiter);
  assert.equal(segments[0], "D:\\Program Files\\Node");
  assert.equal(segments[1], cursorNode);
  assert.equal(segments.filter((segment) => segment === "D:\\Program Files\\Node").length, 1);
});
