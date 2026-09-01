// ai.mjs — 冒险公会：内置 AI 项目管理 CLI
// 总指挥 AI：把一个大目标自动拆解成任务并派发到任务池
//   用法: node src/ai.mjs direct "目标描述" [--workspace 工作区]
// 模型与 Key 从 config.json 的 ai 段读取（见 src/lib/config.cjs）。

import dbutil from './lib/db.cjs';
import cfg from './lib/config.cjs';
import ai from './lib/ai.cjs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TASK_CLI = path.join(__dirname, 'task.mjs');

const db = dbutil.openDb();
dbutil.ensureSchema(db);

// ─── 小工具 ───────────────────────────────────────────

function runTaskCli(args) {
  const r = spawnSync(process.execPath, [TASK_CLI, ...args], { encoding: 'utf-8', timeout: 120000 });
  if (r.error) throw new Error('调用 task.mjs 失败: ' + r.error.message);
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const eq = k.indexOf('=');
      if (eq !== -1) { out[k.slice(0, eq)] = k.slice(eq + 1); }
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) { out[k] = argv[i + 1]; i++; }
      else { out[k] = true; }
    } else { out._.push(a); }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];

function needAi() {
  const a = cfg.ai || {};
  if (!a.apiKey) {
    console.error('❌ 未配置 AI API Key。请在设置页或 config.json 的 ai.apiKey 填写。');
    process.exit(1);
  }
  return a;
}

// ─── 总指挥 AI：拆解目标并派发 ─────────────────────────

async function direct(goal, workspaceArg) {
  const a = needAi();
  if (!goal) { console.error('用法: node src/ai.mjs direct "目标描述" [--workspace 工作区]'); process.exit(1); }

  console.log(`🧭 总指挥 AI 正在拆解目标：${goal}\n`);

  const sys = `你是「冒险公会」任务看板的总指挥 AI。你的职责是把用户的大目标拆解为可执行、可验收的子任务。
子任务要求：
1. 每个子任务独立、可交付、有明确的验收标准；
2. 数量控制在 2-${a.maxTasks || 8} 个，粒度适中（不要过碎）；
3. 优先级 2=高（关键路径/前置），1=中（主体工作），0=低（收尾/可选）；
4. 严格输出 JSON 数组，每个元素形如 {"title":"标题","description":"做什么、验收标准","priority":0|1|2}，不要输出 JSON 以外的任何内容。`;

  const user = `目标：${goal}\n请拆解为子任务。`;

  let tasks;
  try {
    tasks = await ai.chatJson([{ role: 'system', content: sys }, { role: 'user', content: user }],
      { model: a.directorModel, maxTokens: 2000 });
  } catch (e) {
    console.error(`❌ 总指挥 AI 拆解失败：${e.message}`);
    process.exit(1);
  }

  if (!Array.isArray(tasks) || tasks.length === 0) {
    console.error('❌ 总指挥 AI 未返回有效任务列表');
    process.exit(1);
  }

  console.log(`📋 总指挥拆解出 ${tasks.length} 个子任务，开始派发...\n`);
  const created = [];
  for (const t of tasks) {
    const title = String(t.title || '').trim();
    if (!title) continue;
    const desc = String(t.description || '').trim() || '（无描述）';
    const prio = [0, 1, 2].includes(Number(t.priority)) ? Number(t.priority) : 1;
    const cli = ['create', title, desc, '--priority', String(prio), '--prefix', a.workerPrefix || 'ai'];
    if (workspaceArg) cli.push('--workspace', workspaceArg);
    const r = runTaskCli(cli);
    const m = r.stdout.match(/已创建任务 (\S+)/);
    created.push({ taskId: m ? m[1] : '?', title, priority: prio });
    if (r.status !== 0) console.error(`  ⚠️ 创建失败：${title}（${r.stderr || r.stdout}）`);
  }

  console.log(`\n✅ 派发完成：共 ${created.length} 个任务进入待领取池`);
  for (const c of created) console.log(`  [${c.taskId}] ${c.title}（优先级 ${c.priority}）`);
  console.log(`\n💡 任务已发布到池子，由外部 AI 工人（task.mjs claim）或人工领取执行。`);
}

// ─── 主入口 ───────────────────────────────────────────

(async () => {
  switch (cmd) {
    case 'direct':
      await direct(args._[1], args.workspace);
      break;
    case 'status': {
      const a = cfg.ai || {};
      console.log('=== 内置 AI 项目管理状态 ===');
      console.log('启用:', a.enabled ? '✅' : '❌（config.json 的 ai.enabled）');
      console.log('API Key:', a.apiKey ? '✅ 已配置' : '❌ 未配置');
      console.log('总指挥模型:', a.directorModel || '—');
      console.log('Base URL:', a.baseUrl || '—');
      break;
    }
    default:
      console.log(`冒险公会 · 内置 AI 项目管理
用法:
  node src/ai.mjs direct "目标" [--workspace 工作区]   # 总指挥 AI：拆解目标→派任务
  node src/ai.mjs status                                 # 查看 AI 配置状态
模型与 Key 在设置页或 config.json 的 ai 段配置。`);
  }
})();
