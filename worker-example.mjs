// worker-example.mjs — 冒险公会 AI 工人示例
// 用法：node worker-example.mjs --name "MyAI (model-v1)" [--url http://127.0.0.1:8767（看板地址）] [--interval 30] [--workspace 工作区]
// 功能：轮询待领取任务 → 领取 → 模拟执行 → 提交完成。实际使用时替换 doWork() 为真实逻辑。

import { parseArgs } from 'node:util';

const args = parseArgs({
  options: {
    name: { type: 'string' },
    url: { type: 'string', default: 'http://127.0.0.1:8767' },  // 看板地址；实际端口以 config.json server.port 为准
    interval: { type: 'string', default: '30' },
    workspace: { type: 'string' }
  }
}).values;

const ASSIGNEE = args.name || 'ExampleWorker (demo)';
const BASE = args.url.replace(/\/$/, '');
const INTERVAL = parseInt(args.interval, 10) * 1000;
const WORKSPACE = args.workspace || '';

console.log(`🤖 ${ASSIGNEE} 启动，轮询间隔 ${INTERVAL / 1000}s，目标 ${BASE}`);

async function api(path, options = {}) {
  const res = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !data.ok) throw new Error(`${res.status} ${data.error || res.statusText}`);
  return data;
}

// 模拟执行：实际使用时替换为真实任务处理逻辑
async function doWork(task) {
  console.log(`   执行任务: ${task.task_id} — ${task.title}`);
  await new Promise(r => setTimeout(r, 2000)); // 模拟耗时
  return `已完成：${task.title}（示例 worker 自动生成的结果）`;
}

async function tick() {
  try {
    // 1. 获取待领取任务
    const qs = WORKSPACE ? `?workspace=${encodeURIComponent(WORKSPACE)}` : '';
    const { tasks } = await api(`/api/worker/pending${qs}`);
    if (!tasks.length) return;

    // 2. 按优先级取第一个
    const task = tasks[0];
    console.log(`📋 发现任务: ${task.task_id}（优先级 ${task.priority}）`);

    // 3. 领取（原子操作，可能被其他工人抢先）
    const claim = await api('/api/worker/claim', {
      method: 'POST',
      body: JSON.stringify({ task_id: task.task_id, assignee: ASSIGNEE })
    }).catch(e => { console.log(`   领取失败: ${e.message}`); return null; });
    if (!claim || !claim.ok) return;

    // 4. 执行
    const result = await doWork(task);

    // 5. 提交完成
    await api('/api/worker/complete', {
      method: 'POST',
      body: JSON.stringify({ task_id: task.task_id, result })
    });
    console.log(`✅ ${task.task_id} 已提交完成`);
  } catch (e) {
    console.error(`❌ 轮询出错: ${e.message}`);
  }
}

// 主循环
tick();
setInterval(tick, INTERVAL);
