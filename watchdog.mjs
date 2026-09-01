#!/usr/bin/env node
/**
 * watchdog.mjs — 冒险公会看门狗（自愈守护）
 *
 * 作用：每 20 秒探测看板服务，挂了自动拉起，开机自启后无需手动启动。
 * 日志：watchdog.log（本脚本运行记录）；服务输出在 srv-out.log / srv-err.log。
 *
 * 启动方式（任选）：
 *   node watchdog.mjs
 *   或通过 start.bat / 开机启动项静默运行
 */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));       // D:\冒险公会
const DATA_DIR = path.join(os.homedir(), '.adventure-guild');
const OUT_LOG = path.join(APP_DIR, 'srv-out.log');
const ERR_LOG = path.join(APP_DIR, 'srv-err.log');
const WATCH_LOG = path.join(APP_DIR, 'watchdog.log');

const PROBE_MS = 20000;      // 探测间隔
const DOWN_BEFORE_RESTART = 2; // 连续失败 N 次才重启（容忍瞬时抖动）
const COOLDOWN_MS = 5 * 60 * 1000; // 连续崩溃冷却：5 分钟内不重复狂拉起

let restartCount = 0;
let lastRestartAt = 0;
let downStreak = 0;

function getPort() {
  try {
    // 注意：find-port.ps1 用 Set-Content -Encoding UTF8 写回，PowerShell 5.1 会加 BOM，
    // JSON.parse 遇到 \uFEFF 会抛错 → 必须剥掉 BOM，否则回退默认端口导致探测错位
    const raw = fs.readFileSync(path.join(DATA_DIR, 'config.json'), 'utf8').replace(/^\uFEFF/, '');
    const cfg = JSON.parse(raw);
    return cfg.server && cfg.server.port ? cfg.server.port : 8765;
  } catch { return 8765; }
}

function log(msg) {
  const t = new Date().toLocaleString('zh-CN', { hour12: false });
  const line = `[${t}] ${msg}\n`;
  try { fs.appendFileSync(WATCH_LOG, line); } catch {}
  console.log(line.trim());
}

function isUp(port, cb) {
  const req = http.get({ host: '127.0.0.1', port, path: '/api/state', timeout: 3000 }, (res) => {
    res.resume();
    cb(true);
  });
  req.on('error', () => cb(false));
  req.on('timeout', () => { req.destroy(); cb(false); });
}

function startServer(port) {
  const now = Date.now();
  if (now - lastRestartAt < COOLDOWN_MS && restartCount >= 3) {
    log(`⚠️ 5 分钟内已连续重启 ${restartCount} 次，进入冷却，暂不拉起（避免崩溃循环）。`);
    return;
  }
  try {
    const outFd = fs.openSync(OUT_LOG, 'a');
    const errFd = fs.openSync(ERR_LOG, 'a');
    const child = spawn(process.execPath, ['src/dashboard_server.cjs'], {
      cwd: APP_DIR,
      detached: true,
      stdio: ['ignore', outFd, errFd],
    });
    child.unref();
    restartCount++;
    lastRestartAt = now;
    log(`🚀 服务已拉起 (PID ${child.pid}, 端口 ${port})，本次启动后共重启 ${restartCount} 次`);
    // 5 分钟窗口过后重置计数
    setTimeout(() => { restartCount = 0; }, COOLDOWN_MS);
  } catch (e) {
    log(`❌ 拉起失败: ${e.message}`);
  }
}

function tick() {
  const port = getPort();
  isUp(port, (up) => {
    if (up) {
      if (downStreak > 0) log(`✅ 服务恢复在线（端口 ${port}）`);
      downStreak = 0;
    } else {
      downStreak++;
      if (downStreak >= DOWN_BEFORE_RESTART) {
        log(`⚠️ 连续 ${downStreak} 次探测失败（端口 ${port}），准备重启`);
        startServer(port);
        downStreak = 0;
      }
    }
  });
}

// 启动 1.5 秒后先探一次（服务不在就拉起），然后进入周期
setTimeout(() => {
  const port = getPort();
  isUp(port, (up) => {
    if (up) log(`👀 看门狗已启动，服务在线（端口 ${port}），每 ${PROBE_MS / 1000}s 巡检`);
    else { log(`👀 看门狗已启动，服务离线（端口 ${port}），立即拉起`); startServer(port); }
  });
}, 1500);

setInterval(tick, PROBE_MS);
log(`🛡️ 看门狗进程启动 (PID ${process.pid})，数据目录 ${DATA_DIR}`);
