#!/usr/bin/env node
/**
 * xhs-watcher.mjs — Windows 侧核心 watcher（ESM）
 *
 * 两种模式：
 *   --status-only  纯只读，只 GET /status 和 /agent/state，绝不 takeover/heartbeat/release
 *   默认模式       完整生命周期：takeover → home → start task → heartbeat → 监控 → 总结 → 写进度 → release
 *
 * 日志：内部写入 C:\Users\Public\xhs-agent-runs\<runId>.log（JSONL 逐行 append）
 * run-state：原子写入 C:\Users\Public\xhs-agent-runs\<runId>.json（tmp + rename）
 *
 * 环境要求：Node.js >= 18，dashboard 运行在 localhost:17900
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BASE = 'http://localhost:17900';
const PROGRESS_PATH = String.raw`C:\Users\Public\xhs-agent-progress.md`;
const RUN_STATE_DIR = String.raw`C:\Users\Public\xhs-agent-runs`;
const RETRYABLE_HTTP = new Set([502, 503, 504]);

const DEFAULT_PLAN = {
  'REPLACE_SERIAL_01':       { task: '纯刷', durationMin: 10, cap: 1 },
  'REPLACE_SERIAL_03':       { task: '纯刷', durationMin: 10, cap: 1 },
  'REPLACE_SERIAL_02':       { task: '养号', durationMin: 10, cap: 1 },
  'REPLACE_SERIAL_04': { task: '养号', durationMin: 10, cap: 1 },
};

const STATUS_INTERVAL_S = 60;
const HEARTBEAT_INTERVAL_S = 10;
const MAX_WATCH_S = 20 * 60;

// ── logging (JSONL append) ──

let _logFd = null;

function initLog(runId) {
  fs.mkdirSync(RUN_STATE_DIR, { recursive: true });
  const logPath = path.join(RUN_STATE_DIR, `${runId}.log`);
  _logFd = fs.openSync(logPath, 'a');
  return logPath;
}

function logLine(level, msg, extra) {
  const entry = { ts: new Date().toISOString(), level, msg };
  if (extra !== undefined) entry.data = extra;
  const line = JSON.stringify(entry) + '\n';
  if (_logFd !== null) {
    fs.writeSync(_logFd, line);
  }
  // also mirror to stdout for interactive debugging
  process.stdout.write(`[${entry.ts}] ${level}: ${msg}${extra !== undefined ? ' ' + JSON.stringify(extra) : ''}\n`);
}

function closeLog() {
  if (_logFd !== null) {
    try { fs.closeSync(_logFd); } catch {}
    _logFd = null;
  }
}

// ── helpers ──

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--runId')        opts.runId = args[++i];
    else if (a === '--agentId') opts.agentId = args[++i];
    else if (a === '--plan')    opts.plan = JSON.parse(args[++i]);
    else if (a === '--status-only') opts.statusOnly = true;
  }
  if (!opts.runId || !opts.agentId) {
    console.error('用法: node scripts/xhs-watcher.mjs --runId <runId> --agentId <agentId> [--plan <json>] [--status-only]');
    process.exit(1);
  }
  return opts;
}

function httpJson(method, urlPath, data, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE);
    const body = data ? JSON.stringify(data) : null;
    const reqOpts = {
      hostname: url.hostname, port: url.port, path: url.pathname,
      method, headers: { 'Content-Type': 'application/json' }, timeout,
    };
    if (body) reqOpts.headers['Content-Length'] = Buffer.byteLength(body);
    const req = http.request(reqOpts, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, data: raw }); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function withRetry(method, urlPath, data, timeout = 15000, attempts = 3, backoff = 2000) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const result = await httpJson(method, urlPath, data, timeout);
      if (RETRYABLE_HTTP.has(result.status) && i < attempts - 1) {
        await sleep(backoff * (i + 1));
        continue;
      }
      return result;
    } catch (e) {
      lastErr = e;
      if (i === attempts - 1) return { status: 0, data: { ok: false, error: e.message } };
      await sleep(backoff * (i + 1));
    }
  }
  return { status: 0, data: { ok: false, error: String(lastErr) } };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function ts() { return new Date().toISOString(); }
function sha256(content) { return crypto.createHash('sha256').update(content).digest('hex'); }

// ── run-state (atomic: tmp + rename) ──

function writeRunState(runId, agentId, state) {
  fs.mkdirSync(RUN_STATE_DIR, { recursive: true });
  const statePath = path.join(RUN_STATE_DIR, `${runId}.json`);
  const tmpPath = statePath + '.tmp';
  const content = JSON.stringify({ runId, agentId, ...state, updatedAt: ts() }, null, 2);
  fs.writeFileSync(tmpPath, content, 'utf-8');
  fs.renameSync(tmpPath, statePath);
  logLine('info', 'run-state written', { path: statePath, ...state });
  return statePath;
}

// ── progress file with CAS ──

function readProgress() {
  try {
    const raw = fs.readFileSync(PROGRESS_PATH, 'utf-8');
    const revMatch = raw.match(/revision:\s*(\d+)/);
    return { revision: revMatch ? parseInt(revMatch[1]) : 0, raw, hash: sha256(raw) };
  } catch {
    return { revision: 0, raw: '', hash: '' };
  }
}

function updateProgress(opts, lines, conclusion) {
  const before = readProgress();
  const newRev = before.revision + 1;

  const newSection = `\n---\n\n## Run ${newRev} (${opts.runId})\n\n- agentId: ${opts.agentId}\n- startedAt: ${opts.startedAt}\n- finishedAt: ${ts()}\n\n### 验证证据\n${lines.map(l => `- ${l}`).join('\n')}\n\n### 结论\n${conclusion}\n`;

  let content;
  if (before.raw) {
    content = before.raw.replace(/revision:\s*\d+/, `revision: ${newRev}`) + newSection;
  } else {
    content = `# xhs-agent-progress\n\nrevision: ${newRev}\n${newSection}`;
  }
  const newHash = sha256(content);

  // CAS check
  const recheck = readProgress();
  if (recheck.hash !== before.hash) {
    logLine('error', 'CAS failed: hash changed during preparation', {
      expected: before.hash, actual: recheck.hash,
    });
    return null;
  }

  // atomic write
  const tmpPath = PROGRESS_PATH + '.tmp';
  fs.writeFileSync(tmpPath, content, 'utf-8');
  const tmpContent = fs.readFileSync(tmpPath, 'utf-8');
  if (sha256(tmpContent) !== newHash) {
    logLine('error', 'temp file hash mismatch');
    try { fs.unlinkSync(tmpPath); } catch {}
    return null;
  }
  fs.renameSync(tmpPath, PROGRESS_PATH);

  const finalHash = sha256(fs.readFileSync(PROGRESS_PATH, 'utf-8'));
  if (finalHash !== newHash) {
    logLine('error', 'post-write hash mismatch', { expected: newHash, actual: finalHash });
    return null;
  }

  logLine('info', 'progress CAS OK', { revision: before.revision, newRevision: newRev, hash: finalHash });
  return { revision: newRev, hash: finalHash };
}

// ── status-only ──

async function runStatusOnly(opts) {
  logLine('info', 'status-only mode start');

  const { data: payload } = await withRetry('GET', '/status', null, 15000);
  if (!payload?.devices) {
    logLine('error', 'status error', { response: payload });
    throw new Error('status-only request failed');
  }

  const { data: state } = await withRetry('GET', '/agent/state', null, 10000);
  logLine('info', 'agent state', { active: state?.agent?.active, id: state?.agent?.id });

  for (const d of payload.devices) {
    const task = d.task || {};
    const last = d.lastTask || {};
    if (d.running) {
      logLine('info', 'device', { serial: d.serial, status: 'RUN', name: task.name, phase: task.phase, loop: task.loop, ok: task.ok, skip: task.skip });
    } else {
      logLine('info', 'device', { serial: d.serial, status: 'IDLE', serve: d.serve, activity: d.activity, lastLoops: last.loopsDone, lastOk: last.ok, lastSkip: last.skip });
    }
  }

  writeRunState(opts.runId, opts.agentId, { phase: 'status-only', status: 'completed' });
  logLine('info', 'status-only mode done');
  return 0;
}

// ── full lifecycle ──

async function runFullLifecycle(opts) {
  const plan = opts.plan || DEFAULT_PLAN;
  const serials = Object.keys(plan);

  const tk = await withRetry('POST', '/agent/takeover', { id: opts.agentId, kind: 'watcher' }, 10000);
  logLine('info', 'takeover', tk.data);
  if (!tk.data?.ok) {
    logLine('error', 'takeover failed', tk.data);
    writeRunState(opts.runId, opts.agentId, { phase: 'takeover', status: 'failed', error: tk.data?.error });
    throw new Error(`takeover failed: ${tk.data?.error || 'unknown error'}`);
  }

  writeRunState(opts.runId, opts.agentId, { phase: 'taken', status: 'active' });

  let everRunning = false;
  const stallCounts = {};
  const prevProgress = {};
  serials.forEach(s => { stallCounts[s] = 0; });

  try {
    // Agent inactivity does not imply that device tasks stopped. Re-check the
    // targeted devices after takeover and never home or restart a busy device.
    const preflight = await withRetry('GET', '/status', null, 15000);
    if (!preflight.data?.devices) {
      writeRunState(opts.runId, opts.agentId, { phase: 'preflight', status: 'failed', error: 'status unavailable' });
      throw new Error('preflight status unavailable');
    }
    const bySerial = new Map(preflight.data.devices.map(d => [d.serial, d]));
    const blocked = serials.flatMap(serial => {
      const device = bySerial.get(serial);
      if (!device) return [{ serial, reason: 'missing' }];
      if (device.running) return [{ serial, reason: 'already-running' }];
      if (device.serve !== 'ok') return [{ serial, reason: `serve-${device.serve || 'unknown'}` }];
      return [];
    });
    if (blocked.length > 0) {
      logLine('error', 'preflight blocked', { devices: blocked });
      writeRunState(opts.runId, opts.agentId, { phase: 'preflight', status: 'blocked', devices: blocked });
      throw new Error('preflight blocked');
    }

    // home all
    for (const serial of serials) {
      const r = await withRetry('POST', '/home', { serial, id: opts.agentId }, 20000);
      logLine('info', 'home', { serial, result: r.data });
      if (!r.data?.ok) {
        logLine('error', '/home failed', { serial, response: r.data });
        writeRunState(opts.runId, opts.agentId, { phase: 'home', status: 'failed', error: JSON.stringify(r.data), device: serial });
        throw new Error(`/home failed for ${serial}`);
      }
      await sleep(1000);
    }

    // start tasks
    for (const serial of serials) {
      const task = plan[serial];
      const r = await withRetry('POST', '/task', { serial, action: 'start', queue: [task], id: opts.agentId }, 25000);
      logLine('info', 'task start', { serial, task: task.task, result: r.data });
      if (!r.data?.ok) {
        logLine('error', '/task failed', { serial, response: r.data });
        writeRunState(opts.runId, opts.agentId, { phase: 'task', status: 'failed', error: JSON.stringify(r.data), device: serial });
        throw new Error(`/task failed for ${serial}`);
      }
      await sleep(1000);
    }
    writeRunState(opts.runId, opts.agentId, { phase: 'watching', status: 'active' });

    // watch loop
    const startTime = Date.now();
    let nextStatus = startTime;
    let nextHb = startTime;
    const allLines = [];

    while (true) {
      const now = Date.now();
      const elapsed = Math.floor((now - startTime) / 1000);

      if (now >= nextHb) {
        const hb = await withRetry('POST', '/agent/heartbeat', { id: opts.agentId }, 10000);
        if (!hb.data?.ok) {
          logLine('error', 'heartbeat failed', hb.data);
          writeRunState(opts.runId, opts.agentId, { phase: 'heartbeat', status: 'failed', error: JSON.stringify(hb.data) });
          throw new Error('heartbeat failed');
        }
        nextHb += HEARTBEAT_INTERVAL_S * 1000;
      }

      if (now >= nextStatus) {
        const { data: payload } = await withRetry('GET', '/status', null, 15000);
        if (!payload?.devices) {
          logLine('warn', 'status poll error', { elapsed, response: payload });
          nextStatus += STATUS_INTERVAL_S * 1000;
          await sleep(1000);
          if (elapsed > MAX_WATCH_S) break;
          continue;
        }

        const devices = {};
        payload.devices.forEach(d => { devices[d.serial] = d; });
        let allDone = true;

        for (const serial of serials) {
          const d = devices[serial] || {};
          const running = !!d.running;
          const task = d.task || {};
          const last = d.lastTask || {};

          if (running) {
            everRunning = true;
            const progress = [task.loop, task.ok, task.skip, task.comments].join(',');
            if (prevProgress[serial] === progress) stallCounts[serial]++;
            else stallCounts[serial] = 0;
            prevProgress[serial] = progress;
            logLine('info', 'poll', { serial, status: 'RUN', name: task.name, phase: task.phase, loop: task.loop, ok: task.ok, skip: task.skip, comments: task.comments, remain: task.remainingMs, stall: stallCounts[serial] });
            allDone = false;
          } else {
            logLine('info', 'poll', { serial, status: 'DONE', loopsDone: last.loopsDone, ok: last.ok, skip: last.skip, comments: last.comments, lastErr: last.lastErr });
          }
        }
        nextStatus += STATUS_INTERVAL_S * 1000;

        if (everRunning && allDone) {
          let anyStall = false, anyErr = false;
          for (const serial of serials) {
            const d = devices[serial] || {};
            const last = d.lastTask || {};
            const line = `${serial}: loopsDone=${last.loopsDone}, ok=${last.ok}, skip=${last.skip}, comments=${last.comments}, endedAt=${last.endedAt}, lastErr=${last.lastErr}`;
            allLines.push(line);
            if (stallCounts[serial] >= 2) anyStall = true;
            if (last.lastErr) anyErr = true;
          }

          let conclusion;
          if (anyErr) conclusion = '有任务结束但存在 lastErr，需人工复查';
          else if (anyStall) conclusion = '全部结束但中途疑似卡顿';
          else conclusion = '全部自然结束，未发现明显卡顿';
          logLine('info', 'final summary', { conclusion, lines: allLines });

          const prog = updateProgress(opts, allLines, conclusion);
          if (prog) {
            writeRunState(opts.runId, opts.agentId, { phase: 'completed', status: 'ok', conclusion });
          } else {
            logLine('error', 'progress CAS conflict — not writing completed/ok');
            writeRunState(opts.runId, opts.agentId, { phase: 'completed', status: 'progress-conflict', conclusion });
            throw new Error('progress CAS conflict');
          }
          break;
        }
      }

      if (Math.floor((Date.now() - startTime) / 1000) > MAX_WATCH_S) {
        logLine('error', 'timeout exceeded');
        writeRunState(opts.runId, opts.agentId, { phase: 'timeout', status: 'error' });
        throw new Error('watch timeout exceeded');
      }

      await sleep(1000);
    }
  } finally {
    const rel = await withRetry('POST', '/agent/release', { id: opts.agentId }, 10000);
    logLine('info', 'release', rel.data);
    if (!rel.data?.ok) {
      writeRunState(opts.runId, opts.agentId, { phase: 'release', status: 'failed', error: JSON.stringify(rel.data) });
      throw new Error('release failed');
    }
    const state = await withRetry('GET', '/agent/state', null, 10000);
    logLine('info', 'final agent state', { active: state.data?.agent?.active });
  }

  return 0;
}

// ── main ──

async function main() {
  const opts = parseArgs();
  opts.startedAt = ts();

  fs.mkdirSync(RUN_STATE_DIR, { recursive: true });
  const logPath = initLog(opts.runId);
  logLine('info', 'watcher start', { runId: opts.runId, agentId: opts.agentId, mode: opts.statusOnly ? 'status-only' : 'full-lifecycle', logPath });

  try {
    const exitCode = opts.statusOnly ? await runStatusOnly(opts) : await runFullLifecycle(opts);
    logLine('info', 'watcher exit', { exitCode });
    closeLog();
    process.exit(exitCode);
  } catch (e) {
    logLine('error', 'uncaught exception', { message: e.message, stack: e.stack });
    closeLog();
    process.exit(1);
  }
}

main();
