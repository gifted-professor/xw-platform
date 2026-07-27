import { requireRecordedLabBypass } from "../control-plane/lib/operator-access.mjs";

const WS_URL = "ws://127.0.0.1:22222/";
const DEFAULT_DEVICE = "";

function send(request, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(WS_URL);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`绿箭 API 超时：${request.action}`));
    }, timeoutMs);

    socket.addEventListener("open", () => socket.send(JSON.stringify(request)));
    socket.addEventListener("message", (event) => {
      clearTimeout(timer);
      socket.close();
      try {
        resolve(JSON.parse(String(event.data)));
      } catch {
        resolve(String(event.data));
      }
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("无法连接绿箭 API，请确认绿箭矩阵正在运行且 API 服务已开启"));
    });
  });
}

function request(action, devices, data) {
  const body = { action };
  if (devices) body.devices = devices;
  if (data !== undefined) body.data = data;
  return body;
}

function requirePackageName(value, command) {
  const packageName = String(value || "").trim();
  if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/.test(packageName)) {
    throw new Error(`用法：${command} <包名>（例如 com.taobao.idlefish）`);
  }
  return packageName;
}

async function main() {
  const [command = "help", ...args] = process.argv.slice(2);
  if (command !== "help") requireRecordedLabBypass("greenarrow-api");
  const device = process.env.LVJIAN_DEVICE || DEFAULT_DEVICE;
  if (!device && !["help", "list"].includes(command)) {
    throw new Error("请先设置环境变量 LVJIAN_DEVICE");
  }
  let result;

  switch (command) {
    case "list":
      result = await send(request("list"));
      break;

    case "home":
      result = await send(request("pushEvent", device, { type: "2" }));
      break;

    case "back":
      result = await send(request("pushEvent", device, { type: "3" }));
      break;

    case "start-xhs":
      result = await send(request("startApk", device, { apk: "com.xingin.xhs" }));
      break;

    case "start-apk":
      result = await send(request("startApk", device, { apk: requirePackageName(args[0], command) }));
      break;

    case "stop-apk":
      result = await send(request("stopApk", device, { apk: requirePackageName(args[0], command) }));
      break;

    case "apk-list":
      result = await send(request("apkList", device));
      break;

    case "tap-xhs": {
      throw new Error("不同手机桌面布局不同，请使用 start-xhs 按包名启动，或先读取页面结构再点击");
    }

    case "tap": {
      if (args.length < 2) throw new Error("用法：tap <x百分比> <y百分比>");
      const [x, y] = args;
      const down = await send(request("pointerEvent", device, { type: "0", x, y }));
      const up = await send(request("pointerEvent", device, { type: "1", x, y }));
      result = { down, up, percent: { x, y } };
      break;
    }

    case "swipe-up":
      result = await send(request("pointerEvent", device, { type: "6" }));
      break;

    case "swipe-down":
      result = await send(request("pointerEvent", device, { type: "7" }));
      break;

    case "screenshot":
      result = await send(request("Screen", device, {
        savePath: args[0] || "D:\\Pictures",
      }));
      break;

    case "shell":
      if (!args.length) throw new Error("用法：shell <adb shell 后面的命令>");
      result = await send(request("adb_shell", device, { command: args.join(" ") }));
      break;

    default:
      console.log(`绿箭 API 控制器

node 绿箭API控制器.mjs list
node 绿箭API控制器.mjs home
node 绿箭API控制器.mjs back
node 绿箭API控制器.mjs start-xhs
node 绿箭API控制器.mjs start-apk <包名>
node 绿箭API控制器.mjs stop-apk <包名>
node 绿箭API控制器.mjs apk-list
node 绿箭API控制器.mjs tap-xhs
node 绿箭API控制器.mjs tap <x百分比> <y百分比>
node 绿箭API控制器.mjs swipe-up
node 绿箭API控制器.mjs swipe-down
node 绿箭API控制器.mjs screenshot [保存目录]
node 绿箭API控制器.mjs shell <adb shell 后面的命令>

必须通过环境变量 LVJIAN_DEVICE 指定设备串号。`);
      return;
  }

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
