#!/usr/bin/env node
/**
 * patrol.mjs — 冒险公会常驻巡查员
 *
 * 用法：node patrol.mjs [--once] [--dry-run]
 *   --once    只执行一轮（默认循环）
 *   --dry-run 只报告不执行清理
 *
 * 职责：
 * 1. 发现卡住/假完成/进度停滞的任务
 * 2. 清理与核心目标无关的任务
 * 3. 记录巡查结果到记忆库
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const TASK_CLI = `node "${path.join(SRC_DIR, 'task.mjs')}"`;
const MEMORY_CLI = `node "${path.join(SRC_DIR, 'memory.mjs')}"`;
const PATROL_LOG = path.join(SRC_DIR, '..', 'web', 'patrol_log.json');

const CORE_KEYWORDS = ['冒险公会', '任务', '看板', 'AI', '工人', '派工', '决策', '巡查', '记忆', '对话', '持久化', '前端', '后端', '服务器', '界面', '优化', '修复', '沙箱', '门禁', '验收'];
const SUSPECT_KEYWORDS = ['计算器', '独立游戏', '与冒险公会无关', '测试任务', '幻觉'];

function run(cmd) {
  try { return execSync(cmd, { encoding: 'utf8', cwd: SRC_DIR, timeout: 15000 }); }
  catch (e) { return e.stdout || e.stderr || ''; }
}

function listTasks(status) {
  const out = run(`${TASK_CLI} list --status ${status}`);
  const tasks = [];
  const lines = out.split('\n');
  for (const line of lines) {
    const m = line.match(/^\[([^\]]+)\]\s+(\S+)\s+优先级:(\S+)\s+(.+?)\s+（(.+?)）/);
    if (m) {
      tasks.push({ id: m[1], status: m[2], priority: m[3], title: m[4].trim(), workspace: m[5] });
    }
  }
  return tasks;
}

function isIrrelevant(task) {
  const text = task.title.toLowerCase();
  for (const kw of SUSPECT_KEYWORDS) {
    if (text.includes(kw.toLowerCase())) return true;
  }
  return false;
}

function patrolOnce(dryRun) {
  const report = { time: new Date().toLocaleString('zh-CN'), summary: '', issues: [], actions: [] };
  const pending = listTasks('pending');
  const inProgress = listTasks('in_progress');
  const completed = listTasks('completed');

  report.summary = `待领取${pending.length}，进行中${inProgress.length}，已完成${completed.length}`;

  // 1. 检查卡住的任务（进行中超过30分钟）
  for (const t of inProgress) {
    const detail = run(`${TASK_CLI} show ${t.id}`);
    const claimMatch = detail.match(/领取:\s*(.+)/);
    if (claimMatch) {
      const claimTime = new Date(claimMatch[1].replace(/\//g, '-'));
      const hours = (Date.now() - claimTime.getTime()) / 3600000;
      if (hours > 2) {
        report.issues.push(`任务 ${t.id} 已进行中 ${hours.toFixed(1)} 小时，疑似卡住`);
      }
    }
  }

  // 2. 清理无关任务
  for (const t of pending) {
    if (isIrrelevant(t)) {
      report.issues.push(`发现疑似无关任务: ${t.id} ${t.title}`);
      if (!dryRun) {
        run(`${TASK_CLI} cancel ${t.id} --reason "巡查员判定与核心目标无关"`);
        report.actions.push(`已取消任务 ${t.id}`);
      }
    }
  }

  // 3. 写入巡查日志
  try {
    let logs = [];
    if (fs.existsSync(PATROL_LOG)) logs = JSON.parse(fs.readFileSync(PATROL_LOG, 'utf8'));
    logs.push(report);
    if (logs.length > 100) logs = logs.slice(-100);
    fs.writeFileSync(PATROL_LOG, JSON.stringify(logs, null, 2), 'utf8');
  } catch (e) { report.actions.push(`日志写入失败: ${e.message}`); }

  // 4. 记录到记忆库
  if (report.issues.length > 0 || report.actions.length > 0) {
    const logMsg = `[巡查] ${report.summary}。问题: ${report.issues.join('; ') || '无'}。动作: ${report.actions.join('; ') || '无'}`;
    run(`${MEMORY_CLI} log "${logMsg.replace(/"/g, "'")}" --who "patrol-agent"`);
  }

  console.log(`[巡查] ${report.time} | ${report.summary}`);
  if (report.issues.length) console.log(`  问题: ${report.issues.join('; ')}`);
  if (report.actions.length) console.log(`  动作: ${report.actions.join('; ')}`);
  return report;
}

const args = process.argv.slice(2);
const once = args.includes('--once');
const dryRun = args.includes('--dry-run');

if (once) {
  patrolOnce(dryRun);
} else {
  console.log('常驻巡查员启动，每10分钟巡查一次（Ctrl+C 停止）');
  patrolOnce(dryRun);
  setInterval(() => patrolOnce(dryRun), 600000);
}
