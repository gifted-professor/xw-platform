#!/usr/bin/env node
/**
 * sync-feishu.mjs — 飞书多维表格 <-> Windows registry 双向桥（跑在 Mac）
 *
 * 每一轮（默认 60s）：
 *   1. lark-cli 读飞书身份行（serial=ADB序列号 为身份锚点）
 *   2. 经 SSH curl 把身份推给 Windows registry（PUT /api/identities）
 *   3. 经 SSH curl 读 registry 聚合状态（GET /api/devices）
 *   4. 按 serial 找回飞书 record，写回状态列（在线状态/当前任务/占用者/状态更新时间），无变化跳过
 *
 * 依赖：Mac 本机 lark-cli 已完成用户授权；~/.ssh/config 有 xhs-windows。
 * 用法: node sync-feishu.mjs [--once] [--interval 60]
 * 注意：禁 console.error（Windows 远端约束传染防御），一律 console.log。
 */
import { execFileSync } from "node:child_process";

const BASE_TOKEN = "REDACTED_FEISHU_BASE_TOKEN";
const TABLE_ID = "REPLACE_FEISHU_IDENTITY_TABLE_ID";
const SSH_HOST = "xhs-windows";
const REGISTRY = "http://127.0.0.1:17930";
const REGISTRY_TOKEN = "REDACTED_OLD_AGENT_TOKEN";

const F = {
  alias: "设备编号",
  serial: "ADB序列号",
  xhsNick: "小红书昵称",
  xianyu: "闲鱼账号",
  wechat: "微信账号",
  customer: "客户",
  notes: "设备备注",
  model: "手机型号",
  brand: "品牌",
  status: "在线状态",
  task: "当前任务",
  holder: "占用者",
  statusAt: "状态更新时间",
};

function argOf(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const ONCE = process.argv.includes("--once");
const INTERVAL_S = Number(argOf("interval", "60"));

function sh(cmd, args, input) {
  return execFileSync(cmd, args, {
    input: input == null ? undefined : input,
    maxBuffer: 16 * 1024 * 1024,
    encoding: "utf8",
    timeout: 60000,
  });
}

function lark(args) {
  const out = sh("lark-cli", args);
  const d = JSON.parse(out);
  if (!d.ok) throw new Error(`lark-cli ${args.slice(0, 2).join(" ")}: ${d.error?.message || "unknown"}`);
  return d.data;
}

function sshCurlJson(curlArgs, stdinData) {
  const out = sh("ssh", [SSH_HOST, "curl.exe", "-s", ...curlArgs], stdinData);
  return JSON.parse(out);
}

// ---------- 1. 读飞书 ----------
function readFeishuRows() {
  const data = lark([
    "base", "+record-list",
    "--base-token", BASE_TOKEN,
    "--table-id", TABLE_ID,
    "--limit", "50",
    "--as", "user",
    "--format", "json",
  ]);
  const fields = data.fields;
  const idx = Object.fromEntries(Object.values(F).map((name) => [name, fields.indexOf(name)]));
  for (const [k, name] of Object.entries(F)) {
    if (idx[name] < 0) throw new Error(`飞书表缺字段: ${name}`);
  }
  const rows = [];
  data.data.forEach((values, i) => {
    const get = (name) => values[idx[name]] ?? null;
    const serial = get(F.serial);
    const alias = get(F.alias);
    if (!serial && !alias) return; // 空行跳过
    rows.push({
      recordId: data.record_id_list[i],
      alias: alias ? String(alias).trim() : null,
      serial: serial ? String(serial).trim() : null,
      xhsNick: get(F.xhsNick),
      xianyu: get(F.xianyu),
      wechat: get(F.wechat),
      customer: get(F.customer),
      notes: get(F.notes),
      model: [get(F.brand), get(F.model)].filter(Boolean).join(" ") || null,
      oldStatus: get(F.status),
      oldTask: get(F.task),
      oldHolder: get(F.holder),
    });
  });
  return rows;
}

// ---------- 2/3. registry 读写 ----------
function registryGetDevices() {
  return sshCurlJson(["-H", `"x-registry-token: ${REGISTRY_TOKEN}"`, `${REGISTRY}/api/devices`]);
}
function registryPutIdentities(identities) {
  // 注意：远端是 PowerShell，@- 是 splatting 运算符、-H 值含空格，都必须内嵌双引号传字面量
  return sshCurlJson(
    ["-X", "PUT", `${REGISTRY}/api/identities`, "-H", '"content-type: application/json"', "-H", `"x-registry-token: ${REGISTRY_TOKEN}"`, "--data-binary", '"@-"'],
    JSON.stringify({ identities }),
  );
}

// ---------- 4. 写回飞书状态 ----------
function updateFeishuRecord(recordId, fields) {
  return lark([
    "api", "PUT",
    `/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${TABLE_ID}/records/${recordId}`,
    "--data", JSON.stringify({ fields }),
    "--as", "user",
  ]);
}

function nowCn() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 19).replace("T", " ");
}

function computeStatus(dev) {
  const c = dev.control;
  if (!c) return { status: "❓ 未知", task: "", holder: "" };
  if (c.notListed) return { status: "⚫ 离线", task: "", holder: "" };
  if (c.quarantined) return { status: "🟡 隔离", task: "", holder: c.lease?.holderId || "" };
  if (c.online) {
    const task = c.lease ? `${c.lease.kind || "session"}` : "空闲";
    return { status: "🟢 在线", task, holder: c.lease?.holderId || "" };
  }
  return { status: "⚫ 离线", task: "", holder: "" };
}

async function oneRound() {
  const t0 = Date.now();
  // 1. 读飞书 + registry
  const rows = readFeishuRows();
  const agg = registryGetDevices();
  const regDevices = agg.devices || [];
  const aliasBySerial = new Map(regDevices.filter((d) => d.serial).map((d) => [d.serial, d.alias]));

  // 2. 组装身份（serial 锚定 alias；匹配不上回退飞书编号）
  const conflicts = [];
  const identities = rows.map((r) => {
    let alias = r.serial ? aliasBySerial.get(r.serial) : null;
    if (alias && r.alias && alias !== r.alias) {
      conflicts.push(`serial=${r.serial}: registry=${alias} vs 飞书=${r.alias}（以 serial 锚定为准）`);
    }
    if (!alias) alias = r.alias || r.serial;
    return {
      alias,
      serial: r.serial,
      label: null, // label（店名）由 registry seed/人工维护，飞书不覆盖
      model: r.model,
      accounts: { xhs: r.xhsNick || "", xianyu: r.xianyu || "", wechat: r.wechat || "" },
      customer: r.customer || "",
      notes: r.notes || "",
    };
  }).filter((x) => x.alias);

  // label 保留：PUT 是全字段 upsert，label 传 null 会清掉现有值 → 把现有 label 带过来
  const cur = new Map(regDevices.map((d) => [d.alias, d]));
  for (const it of identities) {
    it.label = cur.get(it.alias)?.label ?? it.label;
    // 飞书侧空的账号字段不清空 registry 已有值（飞书是增量编辑，registry 可能有人工补充）
    const curAcct = cur.get(it.alias)?.accounts || {};
    for (const k of Object.keys(it.accounts)) {
      if (!it.accounts[k] && curAcct[k]) it.accounts[k] = curAcct[k];
    }
    if (!it.customer && cur.get(it.alias)?.customer) it.customer = cur.get(it.alias).customer;
    if (!it.notes && cur.get(it.alias)?.notes) it.notes = cur.get(it.alias).notes;
  }
  const putRes = registryPutIdentities(identities);

  // 3. 状态写回（按 serial 找 record）
  const rowBySerial = new Map(rows.filter((r) => r.serial).map((r) => [r.serial, r]));
  // datetime 写时间戳，statusAt 仅日志用
  let updated = 0, skipped = 0;
  for (const dev of regDevices) {
    if (!dev.serial) continue;
    const row = rowBySerial.get(dev.serial);
    if (!row) continue;
    const s = computeStatus(dev);
    if ((row.oldStatus || "") === s.status && (row.oldTask || "") === s.task && (row.oldHolder || "") === s.holder) {
      skipped++;
      continue;
    }
    updateFeishuRecord(row.recordId, {
      [F.status]: s.status,
      [F.task]: s.task,
      [F.holder]: s.holder,
      [F.statusAt]: Date.now(), // 裸 api 不做 CellValue 转换，datetime 必须是毫秒时间戳
    });
    updated++;
  }

  console.log(
    `[sync ${nowCn()}] identities=${putRes.count} feishuRows=${rows.length} ` +
    `statusWrite: updated=${updated} skipped=${skipped} ` +
    `control=${agg.controlPlane?.reachable ? "online" : "DOWN"} ${Date.now() - t0}ms` +
    (conflicts.length ? `\n  ⚠️ 编号冲突: ${conflicts.join("; ")}` : ""),
  );
}

async function main() {
  console.log(`[sync-feishu] start interval=${INTERVAL_S}s once=${ONCE}`);
  for (;;) {
    try {
      await oneRound();
    } catch (e) {
      console.log(`[sync ${nowCn()}] ROUND FAIL: ${e.message}`);
    }
    if (ONCE) break;
    await new Promise((r) => setTimeout(r, INTERVAL_S * 1000));
  }
}

main();
