// 测试用 preload：在子进程里包装 fs.promises.readFile 与 realpath，对 runsRoot 下的访问计数。
// 通过 --import 加载。写两类计数到 SCREEN_COUNTER_FILE：
//   READ <path>  —— readFile（截图字节读取，用于证明单飞只读一次盘）
//   REAL <path>  —— realpath（loadScreenEntry 的路径校验调用，用于证明 fallback 写回后命中缓存不再重载）
import fs from "node:fs";

const counterFile = process.env.SCREEN_COUNTER_FILE;
const countRoot = process.env.SCREEN_COUNT_ROOT;
if (counterFile && countRoot) {
  const mark = (tag, p) => {
    try { if (String(p).includes(countRoot)) fs.appendFileSync(counterFile, `${tag} ${String(p)}\n`); } catch { /* 计数失败不影响被测流程 */ }
  };
  const origRead = fs.promises.readFile;
  fs.promises.readFile = async function patchedReadFile(p, ...rest) { mark("READ", p); return origRead.call(this, p, ...rest); };
  const origReal = fs.promises.realpath;
  fs.promises.realpath = async function patchedRealpath(p, ...rest) { mark("REAL", p); return origReal.call(this, p, ...rest); };
}