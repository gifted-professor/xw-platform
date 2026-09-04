import { execFileSync } from 'node:child_process';
import path from 'node:path';

/**
 * 手机相册发布目录保序暂存模块
 *
 * 核心原理：
 * Android 系统多媒体相册（如小红书 CapaAlbumActivity）默认按修改时间戳倒序（最新在前）排列。
 * 为了确保第一张图（封面）在相册左上角第一格，必须遵循「倒序推送 + 严格单调递增 touch 时间戳」：
 * 1. 倒序推送：先推第 N 张，最后推第 1 张（封面图）。
 * 2. 每张推送后通过 adb shell touch 刷新手机上文件的修改时间，并 sleep 间隔（如 500ms），
 *    使得封面图获得最大的 mtime（最新修改），从而天然排在小红书选图界面的第一位。
 * 3. 广播 MEDIA_SCANNER_SCAN_FILE 通知系统媒体库收录。
 */

export const DEFAULT_ADB_PATH = process.env.ADB_PATH || 'C:\\Program Files (x86)\\xiaowei_android\\tools\\adb.exe';
export const DEFAULT_ADB_PORT = process.env.ANDROID_ADB_SERVER_PORT || '5038';

/**
 * 获取小红书发布专用相册路径
 * @param {string|number} alias - 设备编号，如 "04"
 * @returns {string} 手机内部存储路径，如 "/sdcard/Pictures/XhsPublish4"
 */
export function getXhsAlbumPath(alias) {
  const num = Number(alias);
  const aliasNum = Number.isNaN(num) ? alias : num;
  return `/sdcard/Pictures/XhsPublish${aliasNum}`;
}

/**
 * 执行 ADB 命令包装
 */
export function runAdb(args, options = {}) {
  const adbPath = options.adbPath || DEFAULT_ADB_PATH;
  const env = {
    ...process.env,
    ANDROID_ADB_SERVER_PORT: options.adbPort || DEFAULT_ADB_PORT,
    ...(options.env || {})
  };
  return execFileSync(adbPath, args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env,
    timeout: options.timeout || 60000,
    ...options
  });
}

function defaultSleep(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // 同步空转防止子进程调度被跳过
  }
}

/**
 * 计划倒序推送列表：输入 01, 02... 0N，输出 0N, 0N-1... 01
 * 严格保留原始 orderIndex 便于跟踪
 *
 * @param {Array<{orderIndex: number, localPath: string, fileName: string}>} images
 * @returns {Array<{orderIndex: number, localPath: string, fileName: string}>}
 */
export function computeReversePushOrder(images) {
  if (!Array.isArray(images)) return [];
  // 必须深拷贝后反转
  return [...images].sort((a, b) => a.orderIndex - b.orderIndex).reverse();
}

/**
 * 将本地图片保序暂存推送到目标设备相册
 *
 * @param {Object} params
 * @param {string} params.serial - 目标手机 ADB 设备序列号
 * @param {string|number} params.alias - 目标手机 alias，如 "04"
 * @param {Array<{orderIndex: number, localPath: string, fileName: string, sha256?: string}>} params.images - 顺序排列的本地图片列表
 * @param {Object} [params.options]
 * @param {Function} [params.options.executor] - 可选 adb 执行函数（便于单测 mock）
 * @param {Function} [params.options.sleeper] - 可选 sleep 函数（单测可缩短）
 * @param {number} [params.options.touchGapMs=500] - 每次 touch 之间的最小间隔
 * @returns {Array<{orderIndex: number, phonePath: string, fileName: string}>}
 */
export function stageImagesToDeviceAlbum({
  serial,
  alias,
  images,
  options = {}
}) {
  if (!serial) {
    throw new Error('stageImagesToDeviceAlbum requires serial');
  }
  if (!alias) {
    throw new Error('stageImagesToDeviceAlbum requires alias');
  }
  if (!Array.isArray(images) || images.length === 0) {
    return [];
  }

  const executor = options.executor || ((args) => runAdb(args, options));
  const sleeper = options.sleeper || defaultSleep;
  const touchGapMs = options.touchGapMs ?? 500;

  const albumDir = getXhsAlbumPath(alias);

  // 1. 清空远端相册目录，确保无历史旧文件影响排序
  executor(['-s', serial, 'shell', 'rm', '-rf', albumDir]);
  executor(['-s', serial, 'shell', 'mkdir', '-p', albumDir]);

  // 2. 计算倒序推送顺序（最后推封面图）
  const reverseList = computeReversePushOrder(images);
  const staged = [];

  for (const img of reverseList) {
    const remotePhonePath = `${albumDir}/${img.fileName}`;

    // 2.1 推送本地图片到手机端
    executor(['-s', serial, 'push', img.localPath, remotePhonePath]);

    // 2.2 强制用 touch 更新为手机当前时间（确保 push 顺序掌控 mtime，而非宿主机文件 mtime）
    executor(['-s', serial, 'shell', 'touch', remotePhonePath]);

    // 2.3 广播通知 Android 媒体库扫描索引该文件
    executor([
      '-s', serial, 'shell', 'am', 'broadcast',
      '-a', 'android.intent.action.MEDIA_SCANNER_SCAN_FILE',
      '-d', `file://${remotePhonePath}`
    ]);

    // 2.4 等待间隙，确保下一张图的 mtime 严格递增
    if (touchGapMs > 0) {
      sleeper(touchGapMs);
    }

    staged.push({
      orderIndex: img.orderIndex,
      phonePath: remotePhonePath,
      fileName: img.fileName
    });
  }

  // 返回按原始业务顺序 (0 -> N-1) 排序的暂存结果
  return staged.sort((a, b) => a.orderIndex - b.orderIndex);
}
