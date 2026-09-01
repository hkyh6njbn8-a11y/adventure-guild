#!/usr/bin/env node
/**
 * dispatch_priority.mjs — 派工优先级排序工具
 *
 * 用法：
 *   node dispatch_priority.mjs              # 列出所有工人按优先级排序
 *   node dispatch_priority.mjs <任务ID>     # 为指定任务推荐派工人选
 *   node dispatch_priority.mjs --json       # JSON格式输出
 *
 * 规则（派工优先级 v1）：
 *   T1 高质量工人：平均分≥3.3 且完成量≥5 → 优先派高难度/高风险任务
 *   T2 合格工人：平均分≥3.0 → 常规任务
 *   T3 观察工人：平均分<3.0 或完成量<3 → 仅派低风险/简单任务
 *   同层级内按完成量降序（经验多的优先）
 */

import dbutil from './lib/db.cjs';
import { fileURLToPath } from 'url';
import path from 'path';

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));

function getWorkerStats() {
  const db = dbutil.openDb();
  dbutil.ensureSchema(db);
  const rows = db.prepare(`
    SELECT t.assignee, s.score_total
    FROM tasks t
    JOIN task_scores s ON t.task_id = s.task_id
    WHERE t.status = 'completed' AND t.assignee IS NOT NULL AND t.assignee != ''
  `).all();
  db.close();

  const stats = {};
  for (const r of rows) {
    if (!stats[r.assignee]) stats[r.assignee] = { count: 0, total: 0 };
    stats[r.assignee].count++;
    stats[r.assignee].total += r.score_total;
  }
  return Object.entries(stats).map(([name, s]) => ({
    name,
    count: s.count,
    avg: s.total / s.count,
  }));
}

function tierOf(w) {
  if (w.avg >= 3.3 && w.count >= 5) return { tier: 'T1', label: '★高质量', desc: '优先派高难度/高风险任务' };
  if (w.avg >= 3.0) return { tier: 'T2', label: '☆合格', desc: '常规任务' };
  return { tier: 'T3', label: '⚠观察', desc: '仅派低风险/简单任务' };
}

function rankWorkers(workers) {
  return workers
    .map(w => ({ ...w, ...tierOf(w) }))
    .sort((a, b) => {
      const tierOrder = { T1: 0, T2: 1, T3: 2 };
      if (tierOrder[a.tier] !== tierOrder[b.tier]) return tierOrder[a.tier] - tierOrder[b.tier];
      if (a.avg !== b.avg) return b.avg - a.avg;
      return b.count - a.count;
    });
}

const args = process.argv.slice(2);
const jsonMode = args.includes('--json');
const taskId = args.find(a => !a.startsWith('--'));

const workers = rankWorkers(getWorkerStats());

if (jsonMode) {
  console.log(JSON.stringify(workers, null, 2));
  process.exit(0);
}

console.log('═══════════════════════════════════════════════');
console.log('  派工优先级排序（基于历史评分）');
console.log('═══════════════════════════════════════════════');
if (taskId) console.log(`  任务: ${taskId}`);
console.log('');

for (const w of workers) {
  console.log(`  ${w.tier} ${w.label}  ${w.name}`);
  console.log(`       完成${w.count}个 | 均分${w.avg.toFixed(2)} | ${w.desc}`);
}

console.log('');
console.log('───────────────────────────────────────────────');
console.log('派工建议：');
console.log('  高优先级/复杂任务 → T1工人（WorkBuddy ox-alpha, DeepSeek Harness, AgnesCode）');
console.log('  常规任务 → T2工人（按均分排序）');
console.log('  简单/低风险任务 → T3工人或新工人练手');
console.log('  同层级优先派给完成量多的（经验更稳定）');
console.log('═══════════════════════════════════════════════');
