// 测试用 preload：在子进程里包装 fs.promises.readFile 与 realpath，对 runsRoot 下的访问计数。
// 通过 --import 加载。写两类计数到 SCREEN_COUNTER_FILE：
//   READ <path>  —— readFile（截图字节读取，用于证明单飞只读一次盘）
//   REAL <path>  —— realpath（loadScreenEntry 的路径校验调用，用于证明 fallback 写回后命中缓存不再重载）
// 归属判定（是否在 runsRoot 内）：根用 fs.promises.realpath 归一（与 registry 同源），
// 再用 path.relative 判根内；短名/长名前缀互转，避免 Windows 8.3 短名（WINDOW~1）与长名
// 不一致导致同目录被判到根外。
import fs from "node:fs";
import path from "node:path";

const counterFile = process.env.SCREEN_COUNTER_FILE;
const countRoot = process.env.SCREEN_COUNT_ROOT;
if (counterFile && countRoot) {
  const origRead = fs.promises.readFile;
  const origReal = fs.promises.realpath;
  const norm = (p) => {
    let resolved = path.resolve(String(p));
    if (process.platform === "win32") resolved = resolved.replaceAll("/", "\\").toLowerCase();
    return resolved;
  };
  // 根归一与 registry 同源（fs.promises.realpath → 长名）；短名前缀用于把 REAL 输入的短名归一成长名。
  const rootKey = norm(await origReal(path.resolve(countRoot)));
  const shortRoot = norm(countRoot);
  const inside = (p) => {
    let key = norm(p);
    if (key.startsWith(shortRoot)) key = rootKey + key.slice(shortRoot.length);
    const rel = path.relative(rootKey, key);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  };
  const mark = (tag, p) => {
    try { if (inside(p)) fs.appendFileSync(counterFile, `${tag} ${String(p)}\n`); } catch { /* 计数失败不影响被测流程 */ }
  };
  fs.promises.readFile = async function patchedReadFile(p, ...rest) { mark("READ", p); return origRead.call(this, p, ...rest); };
  fs.promises.realpath = async function patchedRealpath(p, ...rest) { mark("REAL", p); return origReal.call(this, p, ...rest); };
}
