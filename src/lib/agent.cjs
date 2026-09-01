// agent.cjs — 冒险公会：全自主 AI 助手（Phase 7）
// 职责：实现「总指挥 Agent」的多轮自主循环——用户给目标，AI 自己规划、拆任务、派活（发布到任务池）、
//       检查进度、补任务、收尾汇报。所有动手动作一律通过「派任务」完成，由外部 AI 工人领取执行。
// 架构：进程内 async 循环（不阻塞事件循环），供 dashboard_server 的对话/巡查 API 调用。

const dbutil = require('./db.cjs');
const cfg = require('./config.cjs');
const ai = require('./ai.cjs');
const sharedMemory = require('./sharedMemory.cjs');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const db = dbutil.openDb();
dbutil.ensureSchema(db);

// ─── 任务 ID 生成（与 task.mjs 一致）────────────────────
function genTaskId(prefix) {
  const row = db.prepare('SELECT task_id FROM tasks WHERE task_id LIKE ? ORDER BY task_id DESC LIMIT 1').get(`${prefix}-%`);
  let n = 1;
  if (row) {
    const m = row.task_id.match(new RegExp(`^${prefix}-(\\d+)$`));
    if (m) n = parseInt(m[1], 10) + 1;
  }
  return `${prefix}-${String(n).padStart(3, '0')}`;
}

// 状态中文
const ST = { pending: '待领取', in_progress: '进行中', completed: '已完成', failed: '失败', cancelled: '已取消' };

// ═══════════════════ 总指挥 Agent 工具 ═══════════════════
// 每个工具接收参数对象，返回字符串结果给模型

const DIRECTOR_TOOLS = [
  { type: 'function', function: { name: 'query_tasks', description: '查询任务池。按状态/工作区/关键词筛选，返回任务列表。status 取值 pending/in_progress/completed/failed/all。', parameters: { type: 'object', properties: {
    status: { type: 'string', description: '任务状态，默认 all' },
    workspace: { type: 'string', description: '工作区名称，如 默认' },
    keyword: { type: 'string', description: '标题/描述关键词' },
    limit: { type: 'integer', description: '最多返回条数，默认 20' } }, required: [] } } },
  { type: 'function', function: { name: 'get_task_detail', description: '查看单个任务详情（含评分、结果、打回原因）。', parameters: { type: 'object', properties: {
    task_id: { type: 'string', description: '任务ID，如 ai-001' } }, required: ['task_id'] } } },
  { type: 'function', function: { name: 'create_task', description: '派发任务：把一项要执行的工作（读文件、写代码、调研、产出文档等）作为任务投进任务池。描述里写清做什么、验收标准、涉及路径。', parameters: { type: 'object', properties: {
    title: { type: 'string', description: '任务标题' },
    description: { type: 'string', description: '任务描述：要做什么、验收标准、涉及的文件路径' },
    priority: { type: 'integer', description: '优先级 2=高 1=中 0=低，默认 1' },
    workspace: { type: 'string', description: '工作区名称，默认 默认' } }, required: ['title', 'description'] } } },
  { type: 'function', function: { name: 'search_memories', description: '读取项目记忆（共享项目记忆库 + 本地记忆库，双库），按关键词或类型搜索，作为背景知识辅助决策。任何 AI 接手任务前都应先搜记忆了解项目上下文。', parameters: { type: 'object', properties: {
    keyword: { type: 'string', description: '搜索关键词' },
    type: { type: 'string', description: '记忆类型：work_log/knowledge/issue 等，可选' },
    limit: { type: 'integer', description: '最多返回条数，默认 8' } }, required: ['keyword'] } } },
  { type: 'function', function: { name: 'get_executor_stats', description: '查看执行者（AI 工人）的表现排行与平均分。', parameters: { type: 'object', properties: {
    limit: { type: 'integer', description: '最多返回，默认 10' } }, required: [] } } },
  { type: 'function', function: { name: 'get_workspace_list', description: '列出所有工作区。', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'cancel_task', description: '取消任务：把「作废/无意义/已被替代/重复」的待领取或进行中任务标记为已取消（状态 cancelled，任务不再执行，保留历史记录）。', parameters: { type: 'object', properties: {
    task_id: { type: 'string', description: '任务ID，如 ai-018' },
    reason: { type: 'string', description: '取消原因' } }, required: ['task_id', 'reason'] } } },
  { type: 'function', function: { name: 'reset_task', description: '重置任务：把「失败/卡住/异常」的进行中或失败任务重置回待领取（清空负责人与结果，重新执行）。可先 get_task_detail 看原因再决定。', parameters: { type: 'object', properties: {
    task_id: { type: 'string', description: '任务ID' },
    reason: { type: 'string', description: '重置原因' } }, required: ['task_id', 'reason'] } } }
];

const DIRECTOR_HANDLERS = {
  query_tasks(args) {
    const status = args.status || 'all';
    const limit = Math.min(parseInt(args.limit, 10) || 20, 50);
    let sql = 'SELECT task_id,title,status,priority,assignee,created_by FROM tasks WHERE 1=1';
    const p = [];
    if (status !== 'all') { sql += ' AND status=?'; p.push(status); }
    if (args.workspace) { sql += ' AND workspace_id=(SELECT id FROM workspaces WHERE name=?)'; p.push(args.workspace); }
    if (args.keyword) { sql += ' AND (title LIKE ? OR description LIKE ?)'; p.push(`%${args.keyword}%`, `%${args.keyword}%`); }
    sql += ' ORDER BY priority DESC, created_at DESC LIMIT ?'; p.push(limit);
    const rows = db.prepare(sql).all(...p);
    if (!rows.length) return '（没有符合条件的任务）';
    return rows.map(r => `[${r.task_id}] ${ST[r.status] || r.status} 优先级${r.priority} ${r.title}${r.assignee ? ' 负责人:' + r.assignee : ''}`).join('\n');
  },
  get_task_detail(args) {
    const t = db.prepare('SELECT * FROM tasks WHERE task_id=?').get(args.task_id);
    if (!t) return `任务 ${args.task_id} 不存在`;
    const s = db.prepare('SELECT * FROM task_scores WHERE task_id=?').get(args.task_id);
    const ws = dbutil.workspaceNameOf(db, t.workspace_id);
    const lines = [
      `[${t.task_id}] ${t.title}`,
      `状态:${ST[t.status] || t.status} 优先级:${t.priority} 工作区:${ws}`,
      `创建人:${t.created_by || '未知'} 负责人:${t.assignee || '未领取'} 创建:${t.created_at}`,
      `描述:${t.description || '（无）'}`
    ];
    if (t.reject_reason) lines.push(`打回原因:${t.reject_reason}`);
    if (t.result) lines.push(`完成结果:${String(t.result).slice(0, 600)}`);
    if (s) lines.push(`评分:${s.score_total ?? '未评'} ${s.comment ? '评语:' + s.comment : ''}`);
    return lines.join('\n');
  },
  create_task(args) {
    const title = String(args.title || '').trim();
    if (!title) return '错误：title 不能为空';
    const desc = String(args.description || '').trim() || '（无描述）';
    const prio = [0, 1, 2].includes(Number(args.priority)) ? Number(args.priority) : 1;
    const wsName = String(args.workspace || '').trim() || '默认';
    const wsId = dbutil.getOrCreateWorkspace(db, wsName);
    const taskId = genTaskId(cfg.ai.workerPrefix || 'ai');
    db.prepare(`INSERT INTO tasks (task_id, title, description, priority, created_by, workspace_id)
                VALUES (?,?,?,?,?,?)`).run(taskId, title, desc, prio, '总指挥AI', wsId);
    return `已派发任务 ${taskId}（优先级${prio}）：${title}`;
  },
  search_memories(args) {
    const kw = String(args.keyword || '').trim();
    const limit = Math.min(parseInt(args.limit, 10) || 8, 20);
    // 双库搜索：共享项目记忆库（公共漏斗库，所有 AI 共用）优先，再补本地库
    const shared = sharedMemory.search(kw, limit);
    let sql = "SELECT type,title,content,importance,created_at FROM memories WHERE (title LIKE ? OR content LIKE ? OR tags LIKE ?) AND status='active'";
    const p = [`%${kw}%`, `%${kw}%`, `%${kw}%`];
    if (args.type) { sql += ' AND type=?'; p.push(args.type); }
    sql += ' ORDER BY importance DESC, created_at DESC LIMIT ?'; p.push(limit);
    const local = db.prepare(sql).all(...p);
    const rows = [
      ...shared.map(r => ({ ...r, src: '共享' })),
      ...local.map(r => ({ ...r, src: '本地' })),
    ].slice(0, limit * 2);
    if (!rows.length) return '（记忆库中没有匹配结果）';
    return rows.map(r => `【${r.type}｜${r.src}】${r.title}\n${String(r.content).slice(0, 200)}`).join('\n---\n');
  },
  get_executor_stats(args) {
    const limit = Math.min(parseInt(args.limit, 10) || 10, 30);
    const rows = db.prepare(`
      SELECT a.name, a.total_tasks, a.avg_score FROM agents a
      ORDER BY a.total_tasks DESC, a.avg_score DESC LIMIT ?`).all(limit);
    if (!rows.length) return '（暂无执行者数据）';
    return rows.map(r => `${r.name}：完成${r.total_tasks}个任务，平均分${r.avg_score ?? 0}`).join('\n');
  },
  get_workspace_list() {
    const rows = dbutil.getWorkspaces(db);
    return rows.map(w => `${w.name}${w.is_default ? '（默认）' : ''} ${w.description || ''}`.trim()).join('\n') || '（无）';
  },
  cancel_task(args) {
    const id = String(args.task_id || '').trim();
    const reason = String(args.reason || '').trim() || '总指挥取消';
    const t = db.prepare('SELECT * FROM tasks WHERE task_id=?').get(id);
    if (!t) return `错误：任务 ${id} 不存在`;
    if (t.status !== 'pending' && t.status !== 'in_progress') return `错误：任务 ${id} 当前是「${ST[t.status] || t.status}」，只能取消待领取或进行中的任务`;
    db.prepare(`UPDATE tasks SET status='cancelled', assignee='', claimed_at=NULL,
                notes=COALESCE(NULLIF(notes,''),'') || '【已取消】' || ? WHERE task_id=?`).run(reason, id);
    return `已取消任务 ${id}「${t.title}」：${reason}`;
  },
  reset_task(args) {
    const id = String(args.task_id || '').trim();
    const reason = String(args.reason || '').trim() || '总指挥重置';
    const t = db.prepare('SELECT * FROM tasks WHERE task_id=?').get(id);
    if (!t) return `错误：任务 ${id} 不存在`;
    if (t.status !== 'in_progress' && t.status !== 'failed') return `错误：任务 ${id} 当前是「${ST[t.status] || t.status}」，只能重置进行中或失败的任务`;
    db.prepare(`UPDATE tasks SET status='pending', assignee='', claimed_at=NULL, result=NULL,
                notes=COALESCE(NULLIF(notes,''),'') || '【已重置】' || ? WHERE task_id=?`).run(reason, id);
    return `已重置任务 ${id}「${t.title}」回待领取：${reason}`;
  }
};

// ═══════════════════ 总指挥 Agent 主循环 ═══════════════════
// goal: 用户本次消息；history: [{role, content}] 该会话之前的对话（不含本次）
// 返回 { reply, steps }
async function runDirector(goal, history = []) {
  const a = cfg.ai || {};
  if (!a.apiKey) throw new Error('未配置 AI API Key');
  const maxTasks = a.maxTasks || 8;

  const sys = `你是「冒险公会」任务看板的总指挥 AI 助手，处于「全自主管理」模式。
系统采用「总指挥管理 + 外部工人执行」架构，你的工作方式：
  1. 用户给目标 → 你负责规划与派发：把目标拆成可执行、可验收的子任务（2-${maxTasks} 个），用 create_task 投进任务池（描述写清做什么、验收标准、涉及路径）。任务发布后由外部 AI 工人领取执行，你不执行。
  2. 你只负责管理：规划拆任务、按进度补任务、巡查处置异常任务（卡住的重置、无意义的取消、缺口补建）、回答用户的进度查询。
  3. 检查进度用 query_tasks / get_task_detail；读背景知识用 search_memories；看执行者表现用 get_executor_stats。
读文件、写代码、写文档、自动进化等一切"动手"都必须先 create_task 派任务发布到池子，由外部工人领取执行，你绝不自己直接读写文件、绝不自动执行任务。
节奏：回复要快、行动导向。拆完任务就返回阶段汇报，不要长时间空转。`;

  const messages = [
    { role: 'system', content: sys },
    ...history,
    { role: 'user', content: goal }
  ];
  const steps = [];
  let reply = '';
  const MAX_STEPS = 20;

  for (let i = 0; i < MAX_STEPS; i++) {
    const m = await ai.chatMessage(messages, { model: a.directorModel, tools: DIRECTOR_TOOLS, maxTokens: 2000, timeoutMs: 150000 });
    messages.push({ role: m.role, content: m.content || '' });
    if (!m.toolCalls || !m.toolCalls.length) { reply = m.content || ''; break; }
    for (const tc of m.toolCalls) {
      let argObj = {};
      try { argObj = JSON.parse(tc.arguments || '{}'); } catch (e) { argObj = { _parseError: e.message }; }
      let out;
      try {
        const h = DIRECTOR_HANDLERS[tc.name];
        out = h ? String(await h(argObj)) : `未知工具 ${tc.name}`;
      } catch (e) {
        out = '工具执行出错: ' + e.message;
      }
      steps.push({ tool: tc.name, args: argObj, result: String(out).slice(0, 300) });
      console.log(`[Agent] ${tc.name} ${JSON.stringify(argObj).slice(0, 120)}`);
      messages.push({ role: 'tool', tool_call_id: tc.id, content: String(out).slice(0, 5000) });
    }
  }
  if (!reply) reply = '（已达最大执行步骤，任务可能未完全结束。可让我继续。）';
  return { reply, steps };
}

// ═══════════════════ 目标 / 项目（goal）驱动 ═══════════════════
// 用户可创建多个目标（项目），每个目标分配唯一任务前缀；后台调度器按目标自动派活。
// 目标状态：active（运行中）/ paused（暂停）/ completed（已完成）

// 创建目标，返回目标对象（含分配的 task_prefix）
function createGoal(title, description, workspaceName) {
  const t = String(title || '').trim();
  if (!t) throw new Error('目标名称不能为空');
  const wsName = String(workspaceName || '').trim() || '默认';
  const wsId = dbutil.getOrCreateWorkspace(db, wsName);
  // 生成唯一 goal_id 和任务前缀 g001, g002...
  let n = db.prepare('SELECT COUNT(*) c FROM goals').get().c + 1;
  while (db.prepare('SELECT id FROM goals WHERE task_prefix=?').get('g' + String(n).padStart(3, '0'))) n++;
  const prefix = 'g' + String(n).padStart(3, '0');
  const goalId = 'goal-' + String(n).padStart(3, '0');
  db.prepare(`INSERT INTO goals (goal_id, title, description, status, task_prefix, workspace_id, created_at, updated_at)
              VALUES (?,?,?,?,?,?, datetime('now','localtime'), datetime('now','localtime'))`)
    .run(goalId, t, String(description || '').trim(), 'active', prefix, wsId);
  const g = db.prepare('SELECT * FROM goals WHERE goal_id=?').get(goalId);
  console.log(`🎯 新目标「${t}」已创建（${goalId}，任务前缀 ${prefix}）`);
  return g;
}

// 目标进度统计
function goalStats(goal) {
  const prefix = goal.task_prefix;
  const cnt = (status) => status
    ? db.prepare("SELECT COUNT(*) c FROM tasks WHERE task_id LIKE ? AND status=?").get(prefix + '-%', status).c
    : db.prepare("SELECT COUNT(*) c FROM tasks WHERE task_id LIKE ?").get(prefix + '-%').c;
  return { total: cnt(null), pending: cnt('pending'), in_progress: cnt('in_progress'), completed: cnt('completed'), failed: cnt('failed') };
}

// 目标下最近的任务标题（供规划避免重复派同样任务）
function goalTaskTitles(goal, limit = 30) {
  const rows = db.prepare(`SELECT task_id,title,status FROM tasks WHERE task_id LIKE ? ORDER BY created_at DESC LIMIT ?`)
    .all(goal.task_prefix + '-%', limit);
  return rows.map(r => `${r.task_id}[${r.status}] ${r.title}`).join('\n');
}

// 规划下一步：根据目标描述 + 当前进度，让总指挥决定「拆新任务 / 标记完成 / 等待」
// 返回 { action: 'plan', tasks:[{title,description,priority}] } 或 { action:'complete', summary } 或 { action:'wait', reason }
async function planAndDispatch(goal) {
  const a = cfg.ai || {};
  if (!a.apiKey) return { action: 'wait', reason: '未配置 API Key' };
  const stats = goalStats(goal);
  const sys = `你是「冒险公会」的总指挥 AI，负责推进一个目标项目。
请根据目标描述和当前进度，决定下一步行动，严格输出 JSON（不要其他文字）：
  1. 若还有工作可做 → {"action":"plan","tasks":[{"title":"子任务标题","description":"做什么、验收标准","priority":0|1|2}]}（2-${a.maxTasks || 8} 个，避免与已有任务重复）
  2. 若目标已基本达成 → {"action":"complete","summary":"完成情况总结"}
  3. 若暂时无需新任务（等已有任务反馈/条件不满足）→ {"action":"wait","reason":"原因"}`;
  const user = `【目标】${goal.title}\n【目标描述】${goal.description || '（无）'}\n【当前进度】完成 ${stats.completed}/${stats.total}，待领取 ${stats.pending}，进行中 ${stats.in_progress}，失败 ${stats.failed}\n【已有任务】\n${goalTaskTitles(goal) || '（暂无）'}\n\n请决定下一步行动。`;
  try {
    const j = await ai.chatJson([{ role: 'system', content: sys }, { role: 'user', content: user }], { model: a.directorModel, maxTokens: 2000, timeoutMs: 120000 });
    const action = j && j.action;
    if (action === 'plan' && Array.isArray(j.tasks) && j.tasks.length) {
      const created = [];
      for (const t of j.tasks) {
        const title = String(t.title || '').trim();
        if (!title) continue;
        const desc = String(t.description || '').trim() || '（无描述）';
        const prio = [0, 1, 2].includes(Number(t.priority)) ? Number(t.priority) : 1;
        const taskId = genTaskId(goal.task_prefix);
        db.prepare(`INSERT INTO tasks (task_id, title, description, priority, created_by, workspace_id)
                    VALUES (?,?,?,?,?,?)`).run(taskId, title, desc, prio, '总指挥AI', goal.workspace_id);
        created.push(`${taskId} ${title}`);
      }
      db.prepare(`UPDATE goals SET last_plan_at=datetime('now','localtime'), updated_at=datetime('now','localtime') WHERE id=?`).run(goal.id);
      console.log(`🎯 目标「${goal.title}」规划派发 ${created.length} 个新任务`);
      return { action: 'plan', created };
    }
    if (action === 'complete') {
      db.prepare(`UPDATE goals SET status='completed', updated_at=datetime('now','localtime') WHERE id=?`).run(goal.id);
      console.log(`🏁 目标「${goal.title}」已自动判定完成`);
      return { action: 'complete', summary: j.summary || '' };
    }
    return { action: 'wait', reason: j && j.reason ? String(j.reason) : '暂无需新任务' };
  } catch (e) {
    return { action: 'wait', reason: '规划调用失败: ' + e.message };
  }
}

// 总指挥自主巡查：审视整个任务池，自主判断任务执行情况并决策
//  - 对「失败」的任务：判断值得重试（reset 回待领取）还是应取消（作废/被替代/反复失败）
//  - 发现明显缺口时：自主补建任务（create）
// 返回 { ok, actions }；失败/无需巡查时返回 { ok:false } 不调用模型（省 token）
async function patrolTasks() {
  const a = cfg.ai || {};
  if (!a.apiKey) return { ok: false, reason: '未配置 API Key' };
  // 1) 收集全局视图
  const statMap = {};
  db.prepare("SELECT status, COUNT(*) c FROM tasks GROUP BY status").all().forEach(r => statMap[r.status] = r.c);
  const failedTasks = db.prepare(
    `SELECT task_id,title,assignee,priority,substr(created_at,1,16) created FROM tasks
     WHERE status='failed' ORDER BY priority DESC, created_at DESC LIMIT 15`).all();
  const pendingAll = statMap.pending || 0;
  const goals = db.prepare("SELECT goal_id,title,status,task_prefix FROM goals").all();
  const goalsInfo = goals.map(g => {
    const st = goalStats(g);
    return `${g.goal_id}「${g.title}」[${g.status}] 完成${st.completed}/${st.total} 待领取${st.pending} 进行中${st.in_progress} 失败${st.failed}`;
  }).join('\n');
  // 2) 前置判断：无 failed 任务且无严重积压 → 无事可巡，不调模型
  if (!failedTasks.length && pendingAll <= 6) return { ok: false, reason: '任务池无异常，无需巡查' };
  // 3) 交给总指挥 AI 自主决策
  const sys = `你是「冒险公会」的总指挥 AI，正在做例行巡查，自主判断任务池里任务的执行情况。
请基于给定的任务池信息，严格输出 JSON（不要任何其他文字）：
- 对每个「失败」的任务，自主判断处置方式：
  · 值得重试（问题可修复/值得再试一次）→ 加入 reset：{"task_id":"...","reason":"重置原因"}
  · 无意义/已被替代/反复失败不值得再做 → 加入 cancel：{"task_id":"...","reason":"取消原因"}
- 若发现明显缺口（如关键目标下缺必要子任务、某个失败暴露了必须补的环节）→ 加入 create：{"title":"...","description":"做什么、验收标准","priority":0|1|2,"workspace":"默认"}
- 一切正常 → 全部返回空数组。
规则：
1) 只允许对 failed 任务做 reset/cancel；绝不改动 pending/in_progress/completed 任务。
2) 能救就救：一个任务失败不代表要取消，先考虑 reset。
3) create 只在确有缺口时使用，不要无依据乱建。
输出格式：{"reset":[{"task_id","reason"}],"cancel":[{"task_id","reason"}],"create":[{"title","description","priority","workspace"}]}`;
  const user = `【任务池概况】${Object.entries(statMap).map(([k, v]) => `${ST[k] || k}:${v}`).join(' ')}；待领取 ${pendingAll}
【失败任务】
${failedTasks.map(f => `- ${f.task_id} [优先级${f.priority}] ${f.title}${f.assignee ? ' 负责人:' + f.assignee : ''}`).join('\n') || '（无）'}
【运行中目标】
${goalsInfo || '（无）'}
请自主判断并输出处置决策。`;
  try {
    const j = await ai.chatJson([{ role: 'system', content: sys }, { role: 'user', content: user }],
      { model: a.directorModel, maxTokens: 2500, timeoutMs: 120000 });
    const actions = { reset: [], cancel: [], create: [] };
    for (const r of (j.reset || [])) {
      const id = String(r.task_id || '').trim();
      if (!id) continue;
      const t = db.prepare('SELECT * FROM tasks WHERE task_id=?').get(id);
      if (!t || t.status !== 'failed') continue; // 只处理 failed
      const reason = String(r.reason || '').trim() || '总指挥巡查重置';
      db.prepare(`UPDATE tasks SET status='pending', assignee='', claimed_at=NULL, result=NULL,
                  notes=COALESCE(NULLIF(notes,''),'') || '【已重置】' || ? WHERE task_id=?`).run(reason, id);
      actions.reset.push(`${id}（${reason}）`);
      console.log(`🔄 总指挥巡查重置 ${id}「${t.title}」：${reason}`);
    }
    for (const r of (j.cancel || [])) {
      const id = String(r.task_id || '').trim();
      if (!id) continue;
      const t = db.prepare('SELECT * FROM tasks WHERE task_id=?').get(id);
      if (!t || t.status !== 'failed') continue;
      const reason = String(r.reason || '').trim() || '总指挥巡查取消';
      db.prepare(`UPDATE tasks SET status='cancelled',
                  notes=COALESCE(NULLIF(notes,''),'') || '【已取消】' || ? WHERE task_id=?`).run(reason, id);
      actions.cancel.push(`${id}（${reason}）`);
      console.log(`🗑 总指挥巡查取消 ${id}「${t.title}」：${reason}`);
    }
    for (const c of (j.create || [])) {
      const title = String(c.title || '').trim();
      if (!title) continue;
      const desc = String(c.description || '').trim() || '（无描述）';
      const prio = [0, 1, 2].includes(Number(c.priority)) ? Number(c.priority) : 1;
      const wsName = String(c.workspace || '').trim() || '默认';
      const wsId = dbutil.getOrCreateWorkspace(db, wsName);
      const taskId = genTaskId(cfg.ai.workerPrefix || 'ai');
      db.prepare(`INSERT INTO tasks (task_id, title, description, priority, created_by, workspace_id)
                  VALUES (?,?,?,?,?,?)`).run(taskId, title, desc, prio, '总指挥AI', wsId);
      actions.create.push(`${taskId} ${title}`);
      console.log(`📝 总指挥巡查补建任务 ${taskId}「${title}」`);
    }
    return { ok: true, actions };
  } catch (e) {
    return { ok: false, reason: '巡查决策失败: ' + e.message };
  }
}

module.exports = { runDirector, createGoal, goalStats, planAndDispatch, patrolTasks, DIRECTOR_TOOLS, db };
