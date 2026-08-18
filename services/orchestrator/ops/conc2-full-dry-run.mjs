#!/usr/bin/env node
// 临时生产并发入口：只允许设备 01/02。
// 复用 conc4 的 live preflight、控制面 job submit、可见 lease、poll 与恢复判定。

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
if (argv.includes("--aliases")) {
  console.error("✗ conc2 入口固定 aliases=01,02；不得通过 --aliases 扩大设备范围");
  process.exit(4);
}

if (argv.includes("--help") || argv.includes("-h")) {
  console.log(`用法: node ops/conc2-full-dry-run.mjs --actor <id> [conc4 其他选项]

固定设备: 01,02
只预检: node ops/conc2-full-dry-run.mjs --actor <id> --dry-run

该入口复用 conc4 的控制面提交与验收逻辑；效卫 22222 仍为单实例共享传输，
跨设备 job 可重叠，但传输请求由全局锁串行化。`);
  process.exit(0);
}

const target = join(dirname(fileURLToPath(import.meta.url)), "conc4-full-dry-run.mjs");
const child = spawnSync(process.execPath, [target, ...argv, "--aliases", "01,02"], {
  stdio: "inherit",
});
if (child.error) {
  console.error(`✗ conc2 客户端错误: ${child.error.message}`);
  process.exit(4);
}
process.exit(child.status ?? 4);
