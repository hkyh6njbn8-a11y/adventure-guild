#!/usr/bin/env node
/**
 * watchdog.mjs — 冒险公会看门狗（自愈守护）[fix-004 加固版]
 *
 * 作用：每 20 秒探测看板服务，挂了自动拉起，开机自启后无需手动启动。
 * 日志：watchdog.log（本脚本运行记录）；服务输出在 srv-out.log / srv-err.log。
 *
 * fix-004 加固内容：
 *  1) 全局 uncaughtException / unhandledRejection 捕获：写 watchdog.log（含堆栈）后继续巡检，
 *     不再因单点异步异常静默退出（历史掉线根因：看门狗进程自身无异常兜底+挂控制台被连带终止）。
 *  2) tick() / 启动探测包 try/catch，单次探测异常不退出。
 *  3) startServer() 拉起前先二次探测端口：端口已在线则不重复拉起（防双服务实例，历史 05:03 隐患）。
 *  4) PID 文件（watchdog.pid）：启动时检测是否已有看门狗实例，重复启动则退出（防多实例互相干扰）。
 *  5) 服务 PID 落盘（server.pid），供外层计划任务巡检确认服务真实存活。
 *
 * 启动方式（任选，推荐 1）：
 *  1) 安装外层保活计划任务：运行 install-watchdog-task.bat（每 5 分钟检查看门狗+服务，掉线自动拉起，
 *     开机也会触发）。这是 fix-004 的核心——看门狗自身死亡时由计划任务拉起，不再依赖人工。
 *  2) node watchdog.mjs（前台/手动）
 *  3) 通过 start.bat / 开机启动项静默运行
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
const PID_FILE = path.join(APP_DIR, 'watchdog.pid');
const SRV_PID_FILE = path.join(APP_DIR, 'server.pid');

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

/** fix-004：单实例锁——已存在存活看门狗则退出（防多实例互相干扰重启计数/日志） */
function acquireSingleInstance() {
  try {
    if (fs.existsSync(PID_FILE)) {
      const oldPid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
      if (oldPid && oldPid !== process.pid) {
        try {
          process.kill(oldPid, 0); // 探活：信号 0 不杀进程，仅检测存在性
          console.log(`🛡️ 已有看门狗实例在运行 (PID ${oldPid})，本实例退出。`);
          process.exit(0);
        } catch (e) {
          // PID 不存在（旧实例已死但 PID 文件残留）→ 接管
          fs.writeFileSync(PID_FILE, String(process.pid));
          return;
        }
      }
    }
    fs.writeFileSync(PID_FILE, String(process.pid));
  } catch (e) {
    console.log(`⚠️ PID 文件处理失败（继续运行）: ${e.message}`);
  }
}

/** fix-004：全局异常兜底——写日志后继续巡检（不自杀，自愈优先） */
process.on('uncaughtException', (err) => {
  try {
    log(`💥 uncaughtException（已捕获，看门狗继续运行）: ${err && err.stack ? err.stack : String(err)}`);
  } catch (e) { /* 日志写失败不影响 */ }
});
process.on('unhandledRejection', (reason) => {
  try {
    log(`💥 unhandledRejection（已捕获，看门狗继续运行）: ${reason && reason.stack ? reason.stack : String(reason)}`);
  } catch (e) { /* 日志写失败不影响 */ }
});

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
      windowsHide: true,
    });
    child.unref();
    restartCount++;
    lastRestartAt = now;
    // fix-004：服务 PID 落盘（供外层计划任务巡检）
    try { fs.writeFileSync(SRV_PID_FILE, String(child.pid)); } catch (e) {}
    log(`🚀 服务已拉起 (PID ${child.pid}, 端口 ${port})，本次启动后共重启 ${restartCount} 次`);
    // 5 分钟窗口过后重置计数
    setTimeout(() => { restartCount = 0; }, COOLDOWN_MS);
  } catch (e) {
    log(`❌ 拉起失败: ${e.message}`);
  }
}

/** fix-004：探测失败累计达标后，先二次确认端口确实不在线，再拉起（防双实例） */
function tick() {
  try {
    const port = getPort();
    isUp(port, (up) => {
      if (up) {
        if (downStreak > 0) log(`✅ 服务恢复在线（端口 ${port}）`);
        downStreak = 0;
      } else {
        downStreak++;
        if (downStreak >= DOWN_BEFORE_RESTART) {
          // fix-004：二次确认——探测与拉起之间的窗口可能已有他人/他实例拉起
          isUp(port, (up2) => {
            if (up2) {
              log(`⚠️ 准备重启时发现服务已恢复在线（端口 ${port}），取消拉起（防双实例）`);
              downStreak = 0;
              return;
            }
            log(`⚠️ 连续 ${downStreak} 次探测失败（端口 ${port}），准备重启`);
            startServer(port);
            downStreak = 0;
          });
        }
      }
    });
  } catch (e) {
    log(`❌ tick 异常（已捕获，继续巡检）: ${e.message}`);
    downStreak = 0; // 异常不累计失败，避免误重启
  }
}

// fix-004：单实例锁
acquireSingleInstance();

// 启动 1.5 秒后先探一次（服务不在就拉起），然后进入周期
setTimeout(() => {
  try {
    const port = getPort();
    isUp(port, (up) => {
      if (up) {
        log(`👀 看门狗已启动，服务在线（端口 ${port}），每 ${PROBE_MS / 1000}s 巡检`);
        downStreak = 0;
      } else {
        log(`👀 看门狗已启动，服务离线（端口 ${port}），立即拉起`);
        startServer(port);
      }
    });
  } catch (e) {
    log(`❌ 启动探测异常: ${e.message}`);
    startServer(getPort());
  }
}, 1500);

setInterval(tick, PROBE_MS);
log(`🛡️ 看门狗进程启动 (PID ${process.pid})，数据目录 ${DATA_DIR}`);
