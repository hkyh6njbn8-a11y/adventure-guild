#!/usr/bin/env node
// dashboard_server.cjs — 冒险公会：任务看板 动态HTTP服务器
// 架构（Phase 2）：前端拆为 web/ 静态资源（index.html + style.css + app.js），
//                 本服务只负责 API + 静态文件分发 + 数据库访问。
// 监听 127.0.0.1:8765，浏览器访问 http://127.0.0.1:8765
// 用法：node dashboard_server.cjs

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawnSync, spawn } = require('node:child_process');
const cfg = require('./lib/config.cjs');
const dbutil = require('./lib/db.cjs');
const agent = require('./lib/agent.cjs');
const sharedMemory = require('./lib/sharedMemory.cjs');

const db = dbutil.openDb();
dbutil.ensureSchema(db);

const PORT = cfg.server.port;
const HOST = cfg.server.host;
const COMPLETED_PER_PAGE = cfg.server.completedPerPage;
const MODELS_PER_PAGE = cfg.server.modelsPerPage;
const REFRESH_MS = cfg.server.refreshMs;
const WEB_ROOT = path.join(__dirname, '..', 'web');
const PRODUCT_ROOT = path.join(__dirname, '..');

const statusLabel = { 'pending': '⏳ 待领取', 'in_progress': '🔄 进行中', 'review': '🔍 待审查', 'completed': '✅ 已完成', 'failed': '❌ 失败' };
const priorityLabel = { 0: '低', 1: '中', 2: '高' };
const priorityColor = { 0: '#94a3b8', 1: '#f59e0b', 2: '#ef4444' };

function esc(s) { if (!s) return ''; return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

// 是否重做任务（与 CLI 判断一致）
function isRedoTask(t) {
  return !!(t.reject_reason && String(t.reject_reason).trim())
    || (t.description || '').includes('【被打回重做】')
    || (t.title || '').startsWith('[重做]');
}

// ─── 工作区解析（Phase 1）：返回工作区 id；'all'/空/未知 → null（不限定）───
function resolveWsId(workspace) {
  if (!workspace || workspace === 'all' || workspace === '全部') return null;
  const n = String(workspace).trim();
  let row = db.prepare('SELECT id FROM workspaces WHERE name = ?').get(n);
  if (!row && /^\d+$/.test(n)) row = db.prepare('SELECT id FROM workspaces WHERE id = ?').get(parseInt(n, 10));
  return row ? row.id : null;
}

// ─── 项目识别（按 task_id 前缀，全数据隔离）────────────────
// 项目 → 前缀映射；other = 不属于任何已知项目。like 条件间 OR，notLike 条件间 AND。
function projectCond(project, alias) {
  const a = alias ? alias + '.' : '';
  if (!project || project === 'all') return { sql: '', params: [] };
  const P = {
    zhaoxi: { like: ['zhaoxi-%'] },
    tool:   { like: ['tool-%'] },
    guild:  { like: ['quest-%', 'ai-%', 'opt-%', 'g001-%', 'g003-%', 'fix-%'] },
    zaima:  { like: ['zaima-%', 'zaimozaime-%'] },
    other:  { notLike: ['zhaoxi-%', 'tool-%', 'quest-%', 'ai-%', 'opt-%', 'g001-%', 'g003-%', 'fix-%', 'zaima-%', 'zaimozaime-%'] }
  };
  const conf = P[project];
  if (!conf) return { sql: '', params: [] };
  if (conf.like) return { sql: ' AND (' + conf.like.map(l => `${a}task_id LIKE ?`).join(' OR ') + ')', params: conf.like };
  if (conf.notLike) return { sql: ' AND (' + conf.notLike.map(l => `${a}task_id NOT LIKE ?`).join(' AND ') + ')', params: conf.notLike };
  return { sql: '', params: [] };
}

// ─── 取数据（可按工作区/项目过滤）────────────────────────────
function getData(workspace, project) {
  const wsId = resolveWsId(workspace);
  const pj = projectCond(project, 't');     // 带别名（tasks/modelScores 查询）
  const pjRaw = projectCond(project, '');   // 无别名（stats/completedTrend 查询）

  const stats = wsId
    ? db.prepare(`SELECT status, COUNT(*) as c FROM tasks WHERE workspace_id = ?${pjRaw.sql} GROUP BY status`).all(wsId, ...pjRaw.params)
    : db.prepare(`SELECT status, COUNT(*) as c FROM tasks WHERE 1=1${pjRaw.sql} GROUP BY status`).all(...pjRaw.params);
  const statMap = {};
  stats.forEach(s => statMap[s.status] = s.c);
  const total = Object.values(statMap).reduce((a, b) => a + b, 0);

  const tasks = (wsId
    ? db.prepare(`
        SELECT t.*, s.score_total, s.score_completion, s.score_quality,
               s.score_verification, s.score_record, s.comment as score_comment,
               w.name as workspace_name
        FROM tasks t
        LEFT JOIN task_scores s ON t.task_id = s.task_id
        LEFT JOIN workspaces w ON t.workspace_id = w.id
        WHERE t.workspace_id = ?${pj.sql}
        ORDER BY
          CASE t.status WHEN 'in_progress' THEN 1 WHEN 'pending' THEN 2 WHEN 'review' THEN 3 WHEN 'failed' THEN 4 ELSE 5 END,
          t.priority DESC, t.task_id
      `).all(wsId, ...pj.params)
    : db.prepare(`
        SELECT t.*, s.score_total, s.score_completion, s.score_quality,
               s.score_verification, s.score_record, s.comment as score_comment,
               w.name as workspace_name
        FROM tasks t
        LEFT JOIN task_scores s ON t.task_id = s.task_id
        LEFT JOIN workspaces w ON t.workspace_id = w.id
        WHERE 1=1${pj.sql}
        ORDER BY
          CASE t.status WHEN 'in_progress' THEN 1 WHEN 'pending' THEN 2 WHEN 'review' THEN 3 WHEN 'failed' THEN 4 ELSE 5 END,
          t.priority DESC, t.task_id
      `).all(...pj.params));

  const redoTasks = tasks.filter(isRedoTask);
  const redoCount = redoTasks.length;

  // 冒险者能力档案：领取/完成/失败/进行中/打回/四维均分/最近完成 + 擅长项目
  const modelScores = (wsId
    ? db.prepare(`
        SELECT t.assignee, COUNT(*) as cnt,
               SUM(CASE WHEN t.status='completed' THEN 1 ELSE 0 END) as completed,
               SUM(CASE WHEN t.status='failed' THEN 1 ELSE 0 END) as failed,
               SUM(CASE WHEN t.status='in_progress' THEN 1 ELSE 0 END) as in_progress,
               SUM(CASE WHEN t.status='cancelled' THEN 1 ELSE 0 END) as cancelled,
               SUM(CASE WHEN t.reject_reason IS NOT NULL AND trim(t.reject_reason) != '' OR t.title LIKE '[重做]%' THEN 1 ELSE 0 END) as redo,
               ROUND(AVG(s.score_total),2) as avg_total,
               ROUND(AVG(s.score_completion),2) as avg_comp,
               ROUND(AVG(s.score_quality),2) as avg_qual,
               ROUND(AVG(s.score_verification),2) as avg_verif,
               ROUND(AVG(s.score_record),2) as avg_record,
               MAX(t.completed_at) as last_at
        FROM tasks t LEFT JOIN task_scores s ON t.task_id = s.task_id
        WHERE t.assignee IS NOT NULL AND t.assignee != '' AND t.workspace_id = ?${pj.sql}
        GROUP BY t.assignee ORDER BY completed DESC, avg_total DESC
      `).all(wsId, ...pj.params)
    : db.prepare(`
        SELECT t.assignee, COUNT(*) as cnt,
               SUM(CASE WHEN t.status='completed' THEN 1 ELSE 0 END) as completed,
               SUM(CASE WHEN t.status='failed' THEN 1 ELSE 0 END) as failed,
               SUM(CASE WHEN t.status='in_progress' THEN 1 ELSE 0 END) as in_progress,
               SUM(CASE WHEN t.status='cancelled' THEN 1 ELSE 0 END) as cancelled,
               SUM(CASE WHEN t.reject_reason IS NOT NULL AND trim(t.reject_reason) != '' OR t.title LIKE '[重做]%' THEN 1 ELSE 0 END) as redo,
               ROUND(AVG(s.score_total),2) as avg_total,
               ROUND(AVG(s.score_completion),2) as avg_comp,
               ROUND(AVG(s.score_quality),2) as avg_qual,
               ROUND(AVG(s.score_verification),2) as avg_verif,
               ROUND(AVG(s.score_record),2) as avg_record,
               MAX(t.completed_at) as last_at
        FROM tasks t LEFT JOIN task_scores s ON t.task_id = s.task_id
        WHERE t.assignee IS NOT NULL AND t.assignee != ''${pj.sql}
        GROUP BY t.assignee ORDER BY completed DESC, avg_total DESC
      `).all(...pj.params));

  // 擅长项目（各冒险者完成最多的项目）
  const topProjRows = (wsId
    ? db.prepare(`
        SELECT t.assignee,
               CASE WHEN t.task_id LIKE 'zhaoxi-%' THEN '项目A'
                    WHEN t.task_id LIKE 'tool-%' THEN '工具链'
                    WHEN t.task_id LIKE 'quest-%' OR t.task_id LIKE 'ai-%' OR t.task_id LIKE 'opt-%'
                      OR t.task_id LIKE 'g001-%' OR t.task_id LIKE 'g003-%' OR t.task_id LIKE 'fix-%' THEN '冒险公会'
                    WHEN t.task_id LIKE 'zaima-%' OR t.task_id LIKE 'zaimozaime-%' THEN '项目B'
                    ELSE '其他' END proj, COUNT(*) c
        FROM tasks t
        WHERE t.status='completed' AND t.assignee IS NOT NULL AND t.assignee != '' AND t.workspace_id = ?${pj.sql}
        GROUP BY t.assignee, proj ORDER BY t.assignee, c DESC
      `).all(wsId, ...pj.params)
    : db.prepare(`
        SELECT t.assignee,
               CASE WHEN t.task_id LIKE 'zhaoxi-%' THEN '项目A'
                    WHEN t.task_id LIKE 'tool-%' THEN '工具链'
                    WHEN t.task_id LIKE 'quest-%' OR t.task_id LIKE 'ai-%' OR t.task_id LIKE 'opt-%'
                      OR t.task_id LIKE 'g001-%' OR t.task_id LIKE 'g003-%' OR t.task_id LIKE 'fix-%' THEN '冒险公会'
                    WHEN t.task_id LIKE 'zaima-%' OR t.task_id LIKE 'zaimozaime-%' THEN '项目B'
                    ELSE '其他' END proj, COUNT(*) c
        FROM tasks t
        WHERE t.status='completed' AND t.assignee IS NOT NULL AND t.assignee != ''${pj.sql}
        GROUP BY t.assignee, proj ORDER BY t.assignee, c DESC
      `).all(...pj.params));
  const topProj = {};
  topProjRows.forEach(r => { if (!topProj[r.assignee] || r.c > topProj[r.assignee].c) topProj[r.assignee] = r; });
  modelScores.forEach(m => {
    m.rate = m.cnt ? Math.round((m.completed / m.cnt) * 100) : 0;         // 完成率
    m.top_project = topProj[m.assignee] ? topProj[m.assignee].proj : '—'; // 擅长项目
  });

  const allAssignees = [...new Set(tasks.map(t => t.assignee).filter(Boolean))];
  const allCreators = [...new Set(tasks.map(t => (t.created_by || '').trim() || '未知'))].sort();

  // 每日完成趋势（统计仪表盘）
  const completedTrend = (wsId
    ? db.prepare(`SELECT substr(completed_at,1,10) d, COUNT(*) c FROM tasks
                  WHERE status='completed' AND completed_at != '' AND workspace_id = ?${pjRaw.sql} GROUP BY d ORDER BY d`).all(wsId, ...pjRaw.params)
    : db.prepare(`SELECT substr(completed_at,1,10) d, COUNT(*) c FROM tasks
                  WHERE status='completed' AND completed_at != '' AND 1=1${pjRaw.sql} GROUP BY d ORDER BY d`).all(...pjRaw.params));

  return { statMap, total, tasks, modelScores, allAssignees, allCreators, redoTasks, redoCount, completedTrend, wsId };
}

// ─── /api/state 组装（客户端据此渲染整个页面）────────────
function buildState(workspace, project) {
  const d = getData(workspace, project);
  const now = new Date().toLocaleString('zh-CN');
  return {
    ok: true,
    statMap: d.statMap,
    total: d.total,
    redoCount: d.redoCount,
    rejectRate: d.total ? Math.round((d.redoCount / d.total) * 1000) / 10 : 0,
    allAssignees: d.allAssignees,
    allCreators: d.allCreators,
    modelScores: d.modelScores,
    workspaces: dbutil.getWorkspaces(db),
    completedTrend: d.completedTrend,
    completedPerPage: COMPLETED_PER_PAGE,
    modelsPerPage: MODELS_PER_PAGE,
    refreshMs: REFRESH_MS,
    updatedAt: now,
    // 完整任务数据（客户端渲染卡片，含评分与工作区）
    tasks: d.tasks.map(t => ({
      task_id: t.task_id, title: t.title, description: t.description, status: t.status,
      assignee: t.assignee, priority: t.priority, depends_on: t.depends_on, result: t.result,
      notes: t.notes, created_at: t.created_at, claimed_at: t.claimed_at, completed_at: t.completed_at,
      original_assignee: t.original_assignee, rejected_by: t.rejected_by, rejected_at: t.rejected_at,
      reject_reason: t.reject_reason, reworked_by: t.reworked_by, reworked_at: t.reworked_at,
      created_by: t.created_by, workspace_id: t.workspace_id, workspace_name: t.workspace_name,
      score_total: t.score_total, score_completion: t.score_completion, score_quality: t.score_quality,
      score_verification: t.score_verification, score_record: t.score_record, score_comment: t.score_comment,
      is_redo: isRedoTask(t)
    }))
  };
}

// ─── 静态文件 / JSON 工具 ─────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

function serveStatic(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1e6) { reject(new Error('请求体过大')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { reject(new Error('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

// ─── AI 后台任务（异步：请求立即返回 job_id，结果由前端轮询）───
const aiJobs = new Map();
const aiSessions = new Map(); // 对话会话历史 session_id -> [{role, content}]
function startAiJob(cli) {
  const jobId = 'job-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const job = { status: 'running', output: '', error: '', startedAt: Date.now() };
  aiJobs.set(jobId, job);
  const child = spawn(process.execPath, cli, { encoding: 'utf-8' });
  child.stdout.on('data', d => { job.output += d; });
  child.stderr.on('data', d => { job.error += d; });
  child.on('error', e => { job.status = 'error'; job.error = (job.error + '\n' + e.message).trim(); });
  child.on('close', code => {
    job.status = (code === 0) ? 'done' : 'error';
    job.exitCode = code;
    // 结果保留 10 分钟后清理
    setTimeout(() => aiJobs.delete(jobId), 10 * 60 * 1000);
  });
  return jobId;
}

// 生成下一个任务ID（前缀-序号，与 task.mjs 保持一致）
function genTaskId(prefix = cfg.tasks.defaultPrefix) {
  const row = db.prepare("SELECT task_id FROM tasks WHERE task_id LIKE ? ORDER BY task_id DESC LIMIT 1").get(`${prefix}-%`);
  let nextNum = 1;
  if (row) {
    const m = row.task_id.match(new RegExp(`^${prefix}-(\\d+)$`));
    if (m) nextNum = parseInt(m[1], 10) + 1;
  }
  return `${prefix}-${String(nextNum).padStart(3, '0')}`;
}

// ─── 路由 ─────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const p = url.pathname;

  // 静态资源
  if (p === '/' || p === '/index.html') {
    return serveStatic(res, path.join(WEB_ROOT, 'index.html'));
  }
  if (p === '/style.css') return serveStatic(res, path.join(WEB_ROOT, 'style.css'));
  if (p === '/app.js') return serveStatic(res, path.join(WEB_ROOT, 'app.js'));
  if (p === '/patrol_log.json') return serveStatic(res, path.join(WEB_ROOT, 'patrol_log.json'));  // ai-036
  if (p === '/ranking.js') return serveStatic(res, path.join(WEB_ROOT, 'ranking.js'));          // ai-024 游戏化
  if (p === '/ranking.css') return serveStatic(res, path.join(WEB_ROOT, 'ranking.css'));
  if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }

  // API
  if (p === '/api/state') {
    try { return sendJson(res, 200, buildState(url.searchParams.get('workspace'), url.searchParams.get('project'))); }
    catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message || e) }); }
  }
  if (p === '/api/tasks') {
    try {
      const { tasks } = getData(url.searchParams.get('workspace'), url.searchParams.get('project'));
      return sendJson(res, 200, tasks);
    } catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message || e) }); }
  }
  if (p === '/api/workspaces') {
    return sendJson(res, 200, { ok: true, workspaces: dbutil.getWorkspaces(db) });
  }
  // GET /api/recruit — 生成接入提示词（冒险者招募令 / 工会会长上岗提示词），一键复制
  if (p === '/api/recruit' && req.method === 'GET') {
    try {
      const readDoc = (name) => {
        try { return fs.readFileSync(path.join(PRODUCT_ROOT, 'docs', name), 'utf8'); }
        catch (e) { return ''; }
      };
      return sendJson(res, 200, {
        ok: true,
        adventurer: readDoc('RECRUIT.md'),
        leader: readDoc('LEADER_PROTOCOL.md'),
        workerApi: readDoc('AI_WORKER_PROTOCOL.md')
      });
    } catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message || e) }); }
  }

  // GET /api/memory?kw=&limit=&project= — 项目记忆（共享项目记忆库优先 + 本地库），可按键词/项目过滤
  if (p === '/api/memory' && req.method === 'GET') {
    try {
      const kw = String(url.searchParams.get('kw') || '').trim();
      const limit = Math.min(parseInt(url.searchParams.get('limit'), 10) || 10, 30);
      const project = String(url.searchParams.get('project') || 'all').trim();
      const shared = sharedMemory.search(kw, limit, project);
      const q = `%${kw}%`;
      const local = db.prepare(
        `SELECT type,title,content,importance,created_at,tags FROM memories
         WHERE (title LIKE ? OR content LIKE ?) AND status='active'
         ORDER BY importance DESC, created_at DESC LIMIT ?`
      ).all(q, q, limit * 4);
      const localF = local
        .map(r => ({ ...r, project: sharedMemory.projectOf(r.title, r.content, r.tags), projectName: sharedMemory.projectName(sharedMemory.projectOf(r.title, r.content, r.tags)) }))
        .filter(r => project === 'all' || r.project === project)
        .slice(0, limit);
      return sendJson(res, 200, {
        ok: true,
        kw,
        project,
        shared: shared.map(r => ({ ...r, source: '共享' })),
        local: localF.map(r => ({ ...r, source: '本地' })),
        sharedAvailable: sharedMemory.exists(),
        projects: [{ key: 'all', name: '全部' }].concat(sharedMemory.PROJECTS.map(p => ({ key: p.key, name: p.name }))).concat([{ key: 'other', name: '其他' }])
      });
    } catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message || e) }); }
  }
  if (p === '/api/config' && req.method === 'GET') {
    const aiCfg = cfg.ai || {};
    return sendJson(res, 200, {
      ok: true,
      app: cfg.app,
      server: { host: HOST, port: PORT, refreshMs: REFRESH_MS, completedPerPage: COMPLETED_PER_PAGE, modelsPerPage: MODELS_PER_PAGE },
      tasks: cfg.tasks,
      scoring: cfg.scoring,
      integrations: cfg.integrations,
      ai: {
        enabled: !!aiCfg.enabled,
        baseUrl: aiCfg.baseUrl || '',
        apiKey: aiCfg.apiKey ? '****' : '',   // 打码，不泄露明文
        directorModel: aiCfg.directorModel || '',
        workerModel: aiCfg.workerModel || '',
        maxTasks: aiCfg.maxTasks || 8,
        workerPrefix: aiCfg.workerPrefix || 'ai',
        autoRun: !!aiCfg.autoRun
      },
      dataDir: cfg.DATA_DIR,
      configFile: cfg.CONFIG_FILE
    });
  }
  if (p === '/api/task') {
    const taskId = url.searchParams.get('task_id');
    if (!taskId) return sendJson(res, 400, { ok: false, error: '缺少 task_id' });
    const t = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId);
    if (!t) return sendJson(res, 404, { ok: false, error: `任务 ${taskId} 不存在` });
    const score = db.prepare('SELECT * FROM task_scores WHERE task_id = ?').get(taskId);
    return sendJson(res, 200, { ok: true, task: t, score, workspace: dbutil.workspaceNameOf(db, t.workspace_id) });
  }

  if (p === '/api/reset' && req.method === 'POST') {
    return (async () => {
      try {
        const body = await readJsonBody(req);
        const taskId = String(body.task_id || '').trim();
        if (!taskId) return sendJson(res, 400, { ok: false, error: '缺少 task_id' });
        const task = db.prepare('SELECT status, assignee, notes FROM tasks WHERE task_id = ?').get(taskId);
        if (!task) return sendJson(res, 404, { ok: false, error: `任务 ${taskId} 不存在` });
        if (task.status !== 'in_progress') {
          return sendJson(res, 400, { ok: false, error: `只能重置「进行中」的任务，当前状态：${statusLabel[task.status] || task.status}` });
        }
        const stamp = new Date().toLocaleString('zh-CN');
        const oldAssignee = task.assignee || '（无）';
        const logLine = `[${stamp}] 看板重置：状态 in_progress→pending，释放原负责人 ${oldAssignee}`;
        const newNotes = (task.notes ? task.notes + '\n' : '') + logLine;
        db.prepare(`UPDATE tasks SET status='pending', assignee='', claimed_at='', notes=? WHERE task_id=?`).run(newNotes, taskId);
        console.log(`🔄 看板重置任务 ${taskId}（原负责人 ${oldAssignee}）`);
        sendJson(res, 200, { ok: true, task_id: taskId, released: oldAssignee });
      } catch (e) { sendJson(res, 500, { ok: false, error: String(e.message || e) }); }
    })();
  }

  if (p === '/api/create' && req.method === 'POST') {
    return (async () => {
      try {
        const body = await readJsonBody(req);
        const title = String(body.title || '').trim();
        const description = String(body.description || '').trim();
        if (!title) return sendJson(res, 400, { ok: false, error: '标题不能为空' });
        if (!description) return sendJson(res, 400, { ok: false, error: '描述不能为空' });
        const priority = [0, 1, 2].includes(parseInt(body.priority, 10)) ? parseInt(body.priority, 10) : 1;
        const prefix = (cfg.tasks.allowedPrefixes || []).includes(body.prefix) ? body.prefix : cfg.tasks.defaultPrefix;
        const createdBy = String(body.created_by || '').trim() || cfg.tasks.createdByDefault;
        // 工作区（不存在的名称自动创建；空 → 默认工作区）
        let workspaceId = null;
        if (body.workspace && String(body.workspace).trim()) {
          const wsName = String(body.workspace).trim();
          let wsRow = db.prepare('SELECT id FROM workspaces WHERE name = ?').get(wsName);
          if (!wsRow) {
            const info = db.prepare('INSERT INTO workspaces (name, display_name) VALUES (?, ?)').run(wsName, wsName);
            wsRow = { id: info.lastInsertRowid };
            console.log(`🆕 工作区「${wsName}」已创建（看板新建）`);
          }
          workspaceId = wsRow.id;
        }
        if (!workspaceId) {
          const def = db.prepare("SELECT id FROM workspaces WHERE is_default = 1 ORDER BY id LIMIT 1").get();
          workspaceId = def ? def.id : 1;
        }
        const taskId = genTaskId(prefix);
        db.prepare(`INSERT INTO tasks (task_id, title, description, priority, created_by, workspace_id) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(taskId, title, description, priority, createdBy, workspaceId);
        console.log(`✅ 看板新建任务 ${taskId}: ${title}（创建人：${createdBy}，工作区id：${workspaceId}）`);
        sendJson(res, 200, { ok: true, task_id: taskId });
      } catch (e) { sendJson(res, 500, { ok: false, error: String(e.message || e) }); }
    })();
  }

  if (p === '/api/score' && req.method === 'POST') {
    return (async () => {
      try {
        const body = await readJsonBody(req);
        const taskId = String(body.task_id || '').trim();
        if (!taskId) return sendJson(res, 400, { ok: false, error: '缺少 task_id' });
        // 评分维度从配置读取（key 固定为 completion/quality/verification/record，名称可配）
        const dims = (cfg.scoring && cfg.scoring.dimensions) || [];
        const dimKeys = dims.map(d => d.key);
        const minScore = (cfg.scoring && cfg.scoring.min) || 1;
        const maxScore = (cfg.scoring && cfg.scoring.max) || 4;
        const vals = {};
        for (const k of dimKeys) {
          const v = parseInt(body[k], 10);
          if (isNaN(v) || v < minScore || v > maxScore) {
            return sendJson(res, 400, { ok: false, error: `${k} 分数必须为 ${minScore}-${maxScore} 的整数` });
          }
          vals[k] = v;
        }
        const comment = String(body.comment || '').trim();
        const reviewer = String(body.reviewer || '').trim() || '总指挥';
        const task = db.prepare('SELECT status, assignee FROM tasks WHERE task_id=?').get(taskId);
        if (!task) return sendJson(res, 404, { ok: false, error: `任务 ${taskId} 不存在` });
        if (task.status !== 'completed') {
          return sendJson(res, 400, { ok: false, error: `只能评分已完成的任务，当前状态：${statusLabel[task.status] || task.status}` });
        }
        const sum = dimKeys.reduce((a, k) => a + (vals[k] || 0), 0);
        const total = (sum / dimKeys.length).toFixed(2);
        db.prepare(`INSERT INTO task_scores (task_id, score_completion, score_quality, score_verification, score_record, score_total, reviewer, comment, reviewed)
                    VALUES (?,?,?,?,?,?,?,?,0)
                    ON CONFLICT(task_id) DO UPDATE SET
                      score_completion=excluded.score_completion, score_quality=excluded.score_quality,
                      score_verification=excluded.score_verification, score_record=excluded.score_record,
                      score_total=excluded.score_total, reviewer=excluded.reviewer, comment=excluded.comment, reviewed=0`)
          .run(taskId, vals.completion || 0, vals.quality || 0, vals.verification || 0, vals.record || 0, total, reviewer, comment);
        if (task.assignee) {
          const st = db.prepare(`SELECT COUNT(*) total_tasks, COALESCE(AVG(ts.score_total),0) avg_score
                                 FROM tasks t LEFT JOIN task_scores ts ON t.task_id=ts.task_id
                                 WHERE t.assignee=? AND t.status='completed'`).get(task.assignee);
          db.prepare(`INSERT INTO agents (name,total_tasks,avg_score,created_at) VALUES (?,?,?,datetime('now','localtime'))
                      ON CONFLICT(name) DO UPDATE SET total_tasks=excluded.total_tasks, avg_score=excluded.avg_score`)
            .run(task.assignee, st.total_tasks, st.avg_score);
        }
        console.log(`📊 看板评分 ${taskId}: ${dimKeys.map(k => vals[k]).join('/')} → ${total}（${reviewer}）`);
        sendJson(res, 200, { ok: true, task_id: taskId, score_total: total });
      } catch (e) { sendJson(res, 500, { ok: false, error: String(e.message || e) }); }
    })();
  }

  // 保存配置（部分更新，写回用户目录 config.json）
  if (p === '/api/config' && req.method === 'PUT') {
    return (async () => {
      try {
        const body = await readJsonBody(req);
        // 只允许白名单字段，防止误写
        const allowed = {};
        if (body.server && typeof body.server === 'object') {
          const s = {};
          if (body.server.port !== undefined) s.port = parseInt(body.server.port, 10);
          if (body.server.refreshMs !== undefined) s.refreshMs = parseInt(body.server.refreshMs, 10);
          if (body.server.completedPerPage !== undefined) s.completedPerPage = parseInt(body.server.completedPerPage, 10);
          if (body.server.modelsPerPage !== undefined) s.modelsPerPage = parseInt(body.server.modelsPerPage, 10);
          if (Object.keys(s).length) allowed.server = s;
        }
        if (body.tasks && typeof body.tasks === 'object') {
          const t = {};
          if (body.tasks.defaultPrefix) t.defaultPrefix = String(body.tasks.defaultPrefix);
          if (Array.isArray(body.tasks.creatorOptions)) t.creatorOptions = body.tasks.creatorOptions.map(String);
          if (Array.isArray(body.tasks.allowedPrefixes)) t.allowedPrefixes = body.tasks.allowedPrefixes.map(String);
          if (body.tasks.createdByDefault) t.createdByDefault = String(body.tasks.createdByDefault);
          if (Object.keys(t).length) allowed.tasks = t;
        }
        if (body.scoring && typeof body.scoring === 'object') {
          const sc = {};
          if (Array.isArray(body.scoring.dimensions)) {
            sc.dimensions = body.scoring.dimensions.map(d => ({
              key: String(d.key),
              name: String(d.name),
              hint: d.hint ? String(d.hint) : undefined
            })).filter(d => d.key && d.name);
          }
          if (body.scoring.min !== undefined) sc.min = parseInt(body.scoring.min, 10);
          if (body.scoring.max !== undefined) sc.max = parseInt(body.scoring.max, 10);
          if (Object.keys(sc).length) allowed.scoring = sc;
        }
        if (body.app && typeof body.app === 'object') {
          const a = {};
          if (body.app.title) a.title = String(body.app.title);
          if (body.app.footer) a.footer = String(body.app.footer);
          if (Object.keys(a).length) allowed.app = a;
        }
        if (body.ai && typeof body.ai === 'object') {
          const aic = {};
          if (body.ai.enabled !== undefined) aic.enabled = !!body.ai.enabled;
          if (body.ai.baseUrl) aic.baseUrl = String(body.ai.baseUrl);
          // apiKey：前端传 '****' 表示不修改；传其他值才更新
          if (body.ai.apiKey && body.ai.apiKey !== '****') aic.apiKey = String(body.ai.apiKey);
          if (body.ai.directorModel) aic.directorModel = String(body.ai.directorModel);
          if (body.ai.workerModel) aic.workerModel = String(body.ai.workerModel);
          if (body.ai.autoRun !== undefined) aic.autoRun = !!body.ai.autoRun;
          if (body.ai.autoRunInterval !== undefined) aic.autoRunInterval = parseInt(body.ai.autoRunInterval, 10);
          if (body.ai.autoRunMaxWorkers !== undefined) aic.autoRunMaxWorkers = parseInt(body.ai.autoRunMaxWorkers, 10);
          if (Object.keys(aic).length) allowed.ai = aic;
        }
        if (!Object.keys(allowed).length) {
          return sendJson(res, 400, { ok: false, error: '没有可保存的配置字段' });
        }
        cfg.saveUserConfig(allowed);
        console.log(`⚙️ 配置已保存: ${JSON.stringify(allowed)}`);
        sendJson(res, 200, { ok: true, saved: allowed, message: '配置已保存，重启服务后生效' });
      } catch (e) { sendJson(res, 500, { ok: false, error: String(e.message || e) }); }
    })();
  }

  // ─── AI 工人接入协议（Phase 4）───
  // GET /api/worker/pending?workspace=xxx — 待领取任务列表（JSON）
  if (p === '/api/worker/pending' && req.method === 'GET') {
    try {
      const wsName = url.searchParams.get('workspace');
      let tasks;
      if (wsName) {
        const ws = db.prepare('SELECT id FROM workspaces WHERE name = ?').get(wsName);
        if (!ws) return sendJson(res, 404, { ok: false, error: `工作区 ${wsName} 不存在` });
        tasks = db.prepare(`SELECT task_id, title, description, priority, created_by, created_at FROM tasks WHERE status='pending' AND workspace_id=? ORDER BY priority DESC, created_at ASC`).all(ws.id);
      } else {
        tasks = db.prepare(`SELECT task_id, title, description, priority, created_by, created_at FROM tasks WHERE status='pending' ORDER BY priority DESC, created_at ASC`).all();
      }
      return sendJson(res, 200, { ok: true, count: tasks.length, tasks });
    } catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message || e) }); }
  }

  // GET /api/worker/task?task_id=xxx — 任务详情（JSON，含打分）
  if (p === '/api/worker/task' && req.method === 'GET') {
    const taskId = url.searchParams.get('task_id');
    if (!taskId) return sendJson(res, 400, { ok: false, error: '缺少 task_id' });
    const t = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId);
    if (!t) return sendJson(res, 404, { ok: false, error: `任务 ${taskId} 不存在` });
    const score = db.prepare('SELECT * FROM task_scores WHERE task_id = ?').get(taskId);
    return sendJson(res, 200, { ok: true, task: t, score: score || null });
  }

  // POST /api/worker/claim — 领取任务 {task_id, assignee}
  if (p === '/api/worker/claim' && req.method === 'POST') {
    return (async () => {
      try {
        const body = await readJsonBody(req);
        const taskId = String(body.task_id || '').trim();
        const assignee = String(body.assignee || '').trim();
        if (!taskId) return sendJson(res, 400, { ok: false, error: '缺少 task_id' });
        if (!assignee) return sendJson(res, 400, { ok: false, error: '缺少 assignee' });
        const info = db.prepare(`UPDATE tasks SET status='in_progress', assignee=?, claimed_at=datetime('now','localtime')
                                 WHERE task_id=? AND status='pending'`).run(assignee, taskId);
        if (info.changes === 0) {
          const r = db.prepare('SELECT status, assignee FROM tasks WHERE task_id=?').get(taskId);
          if (!r) return sendJson(res, 404, { ok: false, error: `任务 ${taskId} 不存在` });
          return sendJson(res, 409, { ok: false, error: `领取失败：任务状态为 ${r.status}${r.assignee ? `（负责人: ${r.assignee}）` : ''}` });
        }
        // 注册执行者
        db.prepare(`INSERT OR IGNORE INTO agents (name, total_tasks, avg_score, created_at) VALUES (?, 0, 0, datetime('now','localtime'))`).run(assignee);
        console.log(`🤖 Worker claim: ${assignee} 领取 ${taskId}`);
        sendJson(res, 200, { ok: true, task_id: taskId, assignee, status: 'in_progress' });
      } catch (e) { sendJson(res, 500, { ok: false, error: String(e.message || e) }); }
    })();
  }

  // POST /api/worker/complete — 完成任务 {task_id, result, notes}
  if (p === '/api/worker/complete' && req.method === 'POST') {
    return (async () => {
      try {
        const body = await readJsonBody(req);
        const taskId = String(body.task_id || '').trim();
        const result = String(body.result || '');
        const notes = String(body.notes || '');
        if (!taskId) return sendJson(res, 400, { ok: false, error: '缺少 task_id' });
        const taskInfo = db.prepare('SELECT assignee, reject_reason FROM tasks WHERE task_id=?').get(taskId);
        if (!taskInfo) return sendJson(res, 404, { ok: false, error: `任务 ${taskId} 不存在` });
        const isRework = !!taskInfo.reject_reason;
        const reworkedBy = isRework ? (taskInfo.assignee || '') : '';
        const reworkedAt = isRework ? new Date().toLocaleString('zh-CN') : '';
        const info = db.prepare(`UPDATE tasks SET status='review', result=?, notes=?, completed_at=datetime('now','localtime'),
                                    reworked_by=COALESCE(NULLIF(?,''), reworked_by), reworked_at=COALESCE(NULLIF(?,''), reworked_at)
                                  WHERE task_id=? AND status='in_progress'`).run(result, notes, reworkedBy, reworkedAt, taskId);
        if (info.changes === 0) {
          const r = db.prepare('SELECT status FROM tasks WHERE task_id=?').get(taskId);
          return sendJson(res, 409, { ok: false, error: `完成失败：任务状态为 ${r.status}，只有进行中的任务能完成` });
        }
        console.log(`🤖 Worker complete: ${taskId}（已提交，待审查）${result ? ' (' + result.slice(0, 50) + ')' : ''}`);
        // ── 记忆归档（与 CLI complete 一致）：写本地 + 同步共享项目记忆库 ──
        try {
          if (cfg.integrations.memoryArchive) {
            const t = db.prepare('SELECT title, description, assignee, priority FROM tasks WHERE task_id=?').get(taskId);
            if (t) {
              const who = t.assignee || '未知';
              const content = `【任务】${taskId} ${t.title}\n【负责人】${who}\n【完成时间】${new Date().toLocaleString('zh-CN')}\n【任务描述】${(t.description || '').slice(0, 300)}\n【完成结果】${result || '（无）'}`;
              try {
                db.prepare(`INSERT INTO memories (id, type, title, content, tags, importance, confidence, source, created_at, updated_at)
                            VALUES (?, 'work_log', ?, ?, ?, ?, 0.9, 'task_pool_api', datetime('now','localtime'), datetime('now','localtime'))`
                ).run(require('node:crypto').randomUUID(), `[工作记录] ${taskId} ${t.title}`, content, JSON.stringify([taskId, who]), t.priority >= 2 ? 3 : (t.priority >= 1 ? 2 : 1));
              } catch (e) { console.log('⚠️ 本地记忆归档失败:', e.message); }
              const shr = sharedMemory.archiveLog(content, who);
              if (shr.ok) console.log(`📚 已完成任务 ${taskId} 已同步到共享项目记忆库`);
              else console.log(`⚠️ 共享记忆库写入跳过: ${shr.error || '不可用'}`);
            }
          }
        } catch (e) { console.log('⚠️ 记忆归档异常:', e.message); }
        sendJson(res, 200, { ok: true, task_id: taskId, status: 'completed' });
      } catch (e) { sendJson(res, 500, { ok: false, error: String(e.message || e) }); }
    })();
  }

  // POST /api/worker/review — peer 审查 {task_id, action: approve|reject, reason?, score?{c,q,v,r}, comment?, reviewer?}
  if (p === '/api/worker/review' && req.method === 'POST') {
    return (async () => {
      try {
        const body = await readJsonBody(req);
        const taskId = String(body.task_id || '').trim();
        const action = String(body.action || '').trim();
        if (!taskId) return sendJson(res, 400, { ok: false, error: '缺少 task_id' });
        if (action !== 'approve' && action !== 'reject') return sendJson(res, 400, { ok: false, error: 'action 只能是 approve（通过）或 reject（打回）' });
        const task = db.prepare('SELECT status, assignee, title, description, result, notes FROM tasks WHERE task_id=?').get(taskId);
        if (!task) return sendJson(res, 404, { ok: false, error: `任务 ${taskId} 不存在` });
        if (task.status !== 'review') return sendJson(res, 409, { ok: false, error: `审查失败：任务状态为 ${task.status}，只能审查「待审查」任务` });
        const reviewer = String(body.reviewer || '审查员').trim();
        if (action === 'reject') {
          const reason = String(body.reason || '审查未通过').trim();
          const newTitle = (task.title || '').startsWith('[重做]') ? task.title : `[重做]${task.title || ''}`;
          const newDesc = (task.description || '') + `\n\n【被打回重做】${reason}`;
          const now = new Date().toLocaleString('zh-CN');
          const prevSubmit = (task.result || '').trim();
          const prevNotes = (task.notes || '').trim();
          const notesBlock = (prevSubmit ? `【上次提交（${now}）】${prevSubmit}\n` : '')
            + `【打回记录】${JSON.stringify({ rejected_by: reviewer, rejected_at: now, reject_reason: reason, original_assignee: task.assignee || '' }, null, 0)}`;
          const newNotes = prevNotes ? prevNotes + '\n' + notesBlock : notesBlock;
          db.prepare(`UPDATE tasks SET status='pending', assignee='', claimed_at='', result='',
                      title=?, description=?, notes=?, completed_at='',
                      original_assignee=COALESCE(NULLIF(original_assignee,''), ?),
                      rejected_by=?, rejected_at=?, reject_reason=?
                      WHERE task_id=?`).run(newTitle, newDesc, newNotes, task.assignee || '', reviewer, now, reason, taskId);
          if (task.assignee) {
            db.prepare(`INSERT INTO agents (name, total_tasks, avg_score, exp, level, combo, created_at)
                        VALUES (?, 0, 0, 0, 1, 0, datetime('now','localtime'))
                        ON CONFLICT(name) DO UPDATE SET combo=0`).run(task.assignee);
          }
          console.log(`🔍 审查打回: ${taskId}（${reviewer}）：${reason.slice(0, 50)}`);
          return sendJson(res, 200, { ok: true, task_id: taskId, status: 'pending', action: 'reject' });
        }
        // approve：通过审查 → completed（可选打分）
        db.prepare(`UPDATE tasks SET status='completed' WHERE task_id=?`).run(taskId);
        const sc = body.score || {};
        if (sc.c !== undefined && sc.c !== null) {
          const c = parseInt(sc.c), q = parseInt(sc.q), v = parseInt(sc.v), r = parseInt(sc.r);
          if ([c, q, v, r].some(x => isNaN(x) || x < 1 || x > 4)) {
            return sendJson(res, 200, { ok: true, task_id: taskId, status: 'completed', action: 'approve', warn: '已通过但评分参数无效，未打分' });
          }
          const total = ((c + q + v + r) / 4).toFixed(2);
          const comment = String(body.comment || '').trim();
          db.prepare(`INSERT INTO task_scores (task_id, score_completion, score_quality, score_verification, score_record, score_total, reviewer, comment, reviewed)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
                      ON CONFLICT(task_id) DO UPDATE SET
                        score_completion=excluded.score_completion, score_quality=excluded.score_quality,
                        score_verification=excluded.score_verification, score_record=excluded.score_record,
                        score_total=excluded.score_total, reviewer=excluded.reviewer,
                        comment=excluded.comment, reviewed=0`).run(taskId, c, q, v, r, total, reviewer, comment);
          if (task.assignee) {
            const agent = db.prepare('SELECT total_tasks, avg_score FROM agents WHERE name=?').get(task.assignee);
            if (agent) {
              const newTotal = agent.total_tasks + 1;
              const newAvg = Math.round(((agent.avg_score || 0) * agent.total_tasks + parseFloat(total)) / newTotal * 100) / 100;
              db.prepare('UPDATE agents SET total_tasks=?, avg_score=? WHERE name=?').run(newTotal, newAvg, task.assignee);
            }
          }
          console.log(`🔍 审查通过+评分: ${taskId}（${reviewer}）：${total}分`);
          return sendJson(res, 200, { ok: true, task_id: taskId, status: 'completed', action: 'approve', score_total: total });
        }
        console.log(`🔍 审查通过: ${taskId}（${reviewer}）`);
        sendJson(res, 200, { ok: true, task_id: taskId, status: 'completed', action: 'approve' });
      } catch (e) { sendJson(res, 500, { ok: false, error: String(e.message || e) }); }
    })();
  }

  // POST /api/worker/fail — 失败任务 {task_id, reason}
  if (p === '/api/worker/fail' && req.method === 'POST') {
    return (async () => {
      try {
        const body = await readJsonBody(req);
        const taskId = String(body.task_id || '').trim();
        const reason = String(body.reason || '').trim();
        if (!taskId) return sendJson(res, 400, { ok: false, error: '缺少 task_id' });
        const info = db.prepare(`UPDATE tasks SET status='failed', notes=? WHERE task_id=? AND status='in_progress'`).run(reason, taskId);
        if (info.changes === 0) {
          const r = db.prepare('SELECT status FROM tasks WHERE task_id=?').get(taskId);
          if (!r) return sendJson(res, 404, { ok: false, error: `任务 ${taskId} 不存在` });
          return sendJson(res, 409, { ok: false, error: `失败失败：任务状态为 ${r.status}，只有进行中的任务能标记失败` });
        }
        console.log(`🤖 Worker fail: ${taskId} — ${reason.slice(0, 50)}`);
        sendJson(res, 200, { ok: true, task_id: taskId, status: 'failed' });
      } catch (e) { sendJson(res, 500, { ok: false, error: String(e.message || e) }); }
    })();
  }

  // ─── g003-013: 公会任务与悬赏系统 ────────────────
  // GET /api/guild-tasks — 获取公会任务列表
  if (p === '/api/guild-tasks' && req.method === 'GET') {
    try {
      const status = url.searchParams.get('status');
      const q = status
        ? db.prepare("SELECT * FROM guild_tasks WHERE status = ? ORDER BY created_at DESC").all(status)
        : db.prepare("SELECT * FROM guild_tasks ORDER BY created_at DESC").all();
      return sendJson(res, 200, { ok: true, tasks: q });
    } catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message || e) }); }
  }

  // POST /api/guild-tasks — 发布公会任务/悬赏
  if (p === '/api/guild-tasks' && req.method === 'POST') {
    return (async () => {
      try {
        const body = await readJsonBody(req);
        const title = String(body.title || '').trim();
        const description = String(body.description || '').trim();
        const poster = String(body.poster || '').trim();
        const rewardCoins = parseInt(body.reward_coins, 10) || 0;
        const rewardExp = parseInt(body.reward_exp, 10) || 0;
        const priority = [0, 1, 2].includes(parseInt(body.priority, 10)) ? parseInt(body.priority, 10) : 1;
        if (!title || !description || !poster) {
          return sendJson(res, 400, { ok: false, error: '标题、描述、发布者不能为空' });
        }
        const taskId = dbutil.genGuildTaskId();
        db.prepare(`INSERT INTO guild_tasks (task_id, title, description, poster, reward_coins, reward_exp, priority, status)
                    VALUES (?, ?, ?, ?, ?, ?, ?, 'open')`)
          .run(taskId, title, description, poster, rewardCoins, rewardExp, priority);
        console.log(`📜 公会任务已发布 ${taskId}: ${title}（悬赏 ${rewardCoins}金币/${rewardExp}经验）`);
        return sendJson(res, 200, { ok: true, task_id: taskId });
      } catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message || e) }); }
    })();
  }

  // POST /api/guild-tasks/claim — 领取公会任务
  if (p === '/api/guild-tasks/claim' && req.method === 'POST') {
    return (async () => {
      try {
        const body = await readJsonBody(req);
        const taskId = String(body.task_id || '').trim();
        const assignee = String(body.assignee || '').trim();
        if (!taskId || !assignee) return sendJson(res, 400, { ok: false, error: '缺少 task_id 或 assignee' });
        const info = db.prepare(`UPDATE guild_tasks SET status='claimed', assignee=?, claimed_at=datetime('now','localtime')
                                 WHERE task_id=? AND status='open'`).run(assignee, taskId);
        if (info.changes === 0) {
          const r = db.prepare('SELECT status, assignee FROM guild_tasks WHERE task_id=?').get(taskId);
          if (!r) return sendJson(res, 404, { ok: false, error: `任务 ${taskId} 不存在` });
          return sendJson(res, 409, { ok: false, error: `领取失败：当前状态 ${r.status}${r.assignee ? '（已由 ' + r.assignee + ' 领取）' : ''}` });
        }
        // 注册执行者到 agents
        db.prepare(`INSERT OR IGNORE INTO agents (name, total_tasks, avg_score, created_at) VALUES (?, 0, 0, datetime('now','localtime'))`).run(assignee);
        console.log(`⚔️ 公会任务 ${taskId} 被 ${assignee} 领取`);
        return sendJson(res, 200, { ok: true, task_id: taskId, status: 'claimed' });
      } catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message || e) }); }
    })();
  }

  // POST /api/guild-tasks/complete — 完成公会任务并领取奖励
  if (p === '/api/guild-tasks/complete' && req.method === 'POST') {
    return (async () => {
      try {
        const body = await readJsonBody(req);
        const taskId = String(body.task_id || '').trim();
        const result = String(body.result || '');
        if (!taskId) return sendJson(res, 400, { ok: false, error: '缺少 task_id' });
        const task = db.prepare('SELECT assignee, reward_coins, reward_exp FROM guild_tasks WHERE task_id=?').get(taskId);
        if (!task) return sendJson(res, 404, { ok: false, error: `任务 ${taskId} 不存在` });
        if (task.status !== 'claimed') {
          return sendJson(res, 400, { ok: false, error: `只能完成已领取的任务，当前状态：${task.status}` });
        }
        db.prepare(`UPDATE guild_tasks SET status='completed', result=?, completed_at=datetime('now','localtime') WHERE task_id=?`)
          .run(result, taskId);
        // 发放奖励到 agents 表
        if (task.reward_coins > 0 || task.reward_exp > 0) {
          db.prepare(`INSERT INTO agents (name, total_tasks, exp, coins, created_at)
                      VALUES (?, 0, ?, ?, datetime('now','localtime'))
                      ON CONFLICT(name) DO UPDATE SET
                        exp = exp + excluded.exp,
                        coins = coins + excluded.coins`)
            .run(task.assignee, task.reward_exp, task.reward_coins);
          console.log(`💰 ${task.assignee} 完成 ${taskId}，获得 ${task.reward_coins}金币/${task.reward_exp}经验`);
        }
        return sendJson(res, 200, { ok: true, task_id: taskId, status: 'completed',
          reward_coins: task.reward_coins, reward_exp: task.reward_exp });
      } catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message || e) }); }
    })();
  }

  // POST /api/guild-tasks/cancel — 取消公会任务
  if (p === '/api/guild-tasks/cancel' && req.method === 'POST') {
    return (async () => {
      try {
        const body = await readJsonBody(req);
        const taskId = String(body.task_id || '').trim();
        if (!taskId) return sendJson(res, 400, { ok: false, error: '缺少 task_id' });
        const info = db.prepare(`UPDATE guild_tasks SET status='cancelled', updated_at=datetime('now','localtime')
                                 WHERE task_id=? AND status IN ('open','claimed')`).run(taskId);
        if (info.changes === 0) {
          return sendJson(res, 404, { ok: false, error: `任务 ${taskId} 不存在或已完成` });
        }
        return sendJson(res, 200, { ok: true, task_id: taskId });
      } catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message || e) }); }
    })();
  }

  // ─── 内置 AI 项目管理（Phase 6：面板内置模型，异步任务模式）───
  // GET /api/ai/status — AI 配置与任务池摘要
  if (p === '/api/ai/status' && req.method === 'GET') {
    try {
      const aiCfg = cfg.ai || {};
      const pending = db.prepare("SELECT COUNT(*) c FROM tasks WHERE status='pending'").get().c;
      const running = db.prepare("SELECT COUNT(*) c FROM tasks WHERE status='in_progress'").get().c;
      return sendJson(res, 200, {
        ok: true,
        enabled: !!aiCfg.enabled,
        hasKey: !!aiCfg.apiKey,
        directorModel: aiCfg.directorModel || '',
        workerModel: aiCfg.workerModel || '',
        autoRun: !!aiCfg.autoRun,
        runningWorkers: autoRunWorkers.filter(w => w.running).length,
        pending,
        running
      });
    } catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message || e) }); }
  }

  // GET /api/ai/result?job_id=xxx — 查询 AI 后台任务结果（前端轮询）
  if (p === '/api/ai/result' && req.method === 'GET') {
    const jobId = url.searchParams.get('job_id');
    const job = jobId && aiJobs.get(jobId);
    if (!job) return sendJson(res, 404, { ok: false, error: '任务不存在或已过期' });
    return sendJson(res, 200, { ok: true, status: job.status, output: job.output, error: job.error });
  }

  // POST /api/ai/direct — 总指挥 AI：异步把目标拆解为任务并派发
  if (p === '/api/ai/direct' && req.method === 'POST') {
    return (async () => {
      try {
        const body = await readJsonBody(req);
        const goal = String(body.goal || '').trim();
        if (!goal) return sendJson(res, 400, { ok: false, error: '请输入目标描述' });
        const ws = String(body.workspace || '').trim();
        const cli = [path.join(PRODUCT_ROOT, 'src', 'ai.mjs'), 'direct', goal];
        if (ws) cli.push('--workspace', ws);
        const jobId = startAiJob(cli);
        console.log(`🧭 AI 派发目标：${goal.slice(0, 50)}（job=${jobId}）`);
        sendJson(res, 200, { ok: true, job_id: jobId });
      } catch (e) { sendJson(res, 500, { ok: false, error: String(e.message || e) }); }
    })();
  }

  // POST /api/ai/chat — 全自主 AI 助手对话（异步：立即返回 job_id + session_id）
  if (p === '/api/ai/chat' && req.method === 'POST') {
    return (async () => {
      try {
        const body = await readJsonBody(req);
        const message = String(body.message || '').trim();
        if (!message) return sendJson(res, 400, { ok: false, error: '请输入消息' });
        const sid = String(body.session_id || '').trim();
        const history = (sid && aiSessions.has(sid)) ? aiSessions.get(sid) : [];
        const jobId = 'chat-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
        aiJobs.set(jobId, { status: 'running', output: '', error: '', startedAt: Date.now() });
        const newSid = sid || jobId;
        // 进程内异步执行（不阻塞事件循环）
        (async () => {
          try {
            const r = await agent.runDirector(message, history);
            const next = [...history, { role: 'user', content: message }, { role: 'assistant', content: r.reply }];
            aiSessions.set(newSid, next);
            const job = aiJobs.get(jobId);
            job.output = JSON.stringify({ reply: r.reply, steps: r.steps });
            job.status = 'done';
          } catch (e) {
            const job = aiJobs.get(jobId);
            job.status = 'error';
            job.error = String((e && e.message) || e);
          }
          setTimeout(() => aiJobs.delete(jobId), 30 * 60 * 1000);
        })();
        console.log(`💬 AI 助手收到消息（session=${newSid.slice(0, 16)}）：${message.slice(0, 50)}`);
        sendJson(res, 200, { ok: true, session_id: newSid, job_id: jobId });
      } catch (e) { sendJson(res, 500, { ok: false, error: String(e.message || e) }); }
    })();
  }

  // GET /api/ai/chat/result?job_id=xxx — 对话任务结果（reply + steps）
  if (p === '/api/ai/chat/result' && req.method === 'GET') {
    const jobId = url.searchParams.get('job_id');
    const job = jobId && aiJobs.get(jobId);
    if (!job) return sendJson(res, 404, { ok: false, error: '任务不存在或已过期' });
    if (job.status === 'done') {
      try {
        const parsed = JSON.parse(job.output || '{}');
        return sendJson(res, 200, { ok: true, status: 'done', reply: parsed.reply || '', steps: parsed.steps || [] });
      } catch (e) {
        return sendJson(res, 200, { ok: true, status: 'done', reply: job.output, steps: [] });
      }
    }
    return sendJson(res, 200, { ok: true, status: job.status, error: job.error });
  }

  // ─── 目标 / 项目管理（Phase 7 目标驱动自主运行）───
  // POST /api/ai/goal  {title, description, workspace} → 新建目标
  if (p === '/api/ai/goal' && req.method === 'POST') {
    return (async () => {
      try {
        const body = await readJsonBody(req);
        const title = String(body.title || '').trim();
        if (!title) return sendJson(res, 400, { ok: false, error: '请输入目标名称' });
        const g = agent.createGoal(title, body.description, body.workspace);
        // 创建后立即异步做首次规划
        agent.planAndDispatch(g).then(r => {
          if (r.action === 'plan') console.log(`🎯 目标「${title}」首次规划完成，派发 ${(r.created || []).length} 个任务`);
        }).catch(e => console.log(`⚠️ 目标首次规划失败: ${e.message}`));
        sendJson(res, 200, { ok: true, goal: g, message: `目标「${title}」已创建，AI 正在自动规划任务` });
      } catch (e) { sendJson(res, 500, { ok: false, error: String(e.message || e) }); }
    })();
  }

  // POST /api/ai/goal/action  {goal_id, action: start|pause|complete}
  if (p === '/api/ai/goal/action' && req.method === 'POST') {
    return (async () => {
      try {
        const body = await readJsonBody(req);
        const goalId = String(body.goal_id || '').trim();
        const action = String(body.action || '').trim();
        if (!goalId) return sendJson(res, 400, { ok: false, error: '缺少 goal_id' });
        const g = db.prepare('SELECT * FROM goals WHERE goal_id=?').get(goalId);
        if (!g) return sendJson(res, 404, { ok: false, error: `目标 ${goalId} 不存在` });
        let newStatus;
        if (action === 'start') newStatus = 'active';
        else if (action === 'pause') newStatus = 'paused';
        else if (action === 'complete') newStatus = 'completed';
        else return sendJson(res, 400, { ok: false, error: 'action 只能是 start/pause/complete' });
        db.prepare(`UPDATE goals SET status=?, updated_at=datetime('now','localtime') WHERE id=?`).run(newStatus, g.id);
        console.log(`🎛 目标「${g.title}」→ ${newStatus}`);
        // 恢复运行：立即补一次调度
        if (newStatus === 'active') autoRunTick();
        sendJson(res, 200, { ok: true, goal_id: goalId, status: newStatus, message: `目标「${g.title}」已${newStatus === 'active' ? '恢复运行' : newStatus === 'paused' ? '暂停' : '标记完成'}` });
      } catch (e) { sendJson(res, 500, { ok: false, error: String(e.message || e) }); }
    })();
  }

  // GET /api/ai/goals → 目标列表（含进度统计）
  if (p === '/api/ai/goals' && req.method === 'GET') {
    try {
      const rows = db.prepare('SELECT * FROM goals ORDER BY id DESC').all();
      const list = rows.map(g => {
        const st = agent.goalStats(g);
        return { goal_id: g.goal_id, title: g.title, description: g.description, status: g.status, task_prefix: g.task_prefix, created_at: g.created_at, updated_at: g.updated_at, stats: st, progress: st.total ? Math.round(st.completed / st.total * 100) : 0 };
      });
      return sendJson(res, 200, { ok: true, goals: list });
    } catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message || e) }); }
  }

  if (p === '/refresh') { res.writeHead(302, { 'Location': '/' }); return res.end(); }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404 Not Found');
});

server.listen(PORT, HOST, () => {
  console.log(`冒险公会任务看板已启动: http://${HOST}:${PORT}`);
  console.log(`API: /api/state | /api/config(GET/PUT) | /api/worker/{pending,task,claim,complete,fail}`);
  // 启动时清理「僵尸进行中任务」：服务重启 = 所有 worker 进程已终止，
  // 仍在 in_progress 的任务永远不会完成，按工作流原则释放回待领取池，由调度器重新派活。
  const zombie = db.prepare("SELECT task_id FROM tasks WHERE status='in_progress'").all();
  if (zombie.length) {
    const upd = db.prepare("UPDATE tasks SET status='pending', assignee=NULL, claimed_at=NULL WHERE status='in_progress'");
    const r = upd.run();
    console.log(`♻️ 启动清理：释放 ${r.changes} 个因服务重启中断的进行中任务回待领取池`);
  }
  startAutoRun();
});

// ─── 后台常驻自主执行（Phase 7：目标驱动自主运行模式）───
// 遍历所有「运行中」的目标：总指挥 AI 只负责「管理」——规划拆任务（发布到池子）、
// 巡查处置异常任务（重置/取消/补建）、判定目标完成；**不自动执行**。
// 任务的「执行」留给外部 AI 工人（各自在线主动领取）或人类手动领取。
// 暂停的目标不管理；支持多个目标并行推进。
let autoRunWorkers = [];       // 保留（供 /api/ai/status 读取），当前不自动派内置工人
let autoRunTimer = null;
let tickRunning = false;
let lastPatrolAt = 0;          // 总指挥自主巡查的上次时间戳

async function autoRunTick() {
  const a = cfg.ai || {};
  if (!a.enabled || !a.autoRun || tickRunning) return;
  tickRunning = true;
  try {
    // 0) 自动重置超时任务：worker 窗口/进程中断导致 in_progress 卡住 → 释放回待领取
    //    （与《多AI协同开发工作流》"进行中超时→重置回待领取"的巡查原则一致）
    const staleMin = Math.max(5, parseInt(a.staleMinutes, 10) || 30);
    const staleRes = db.prepare(
      `UPDATE tasks SET status='pending', assignee='', claimed_at=NULL
       WHERE status='in_progress' AND claimed_at IS NOT NULL
         AND datetime('now','localtime') > datetime(claimed_at, '+' || ? || ' minutes')`
    ).run(staleMin);
    if (staleRes.changes > 0) {
      console.log(`⏱ 自动重置 ${staleRes.changes} 个超时（>${staleMin} 分钟）的进行中任务 → 待领取`);
    }
    const goals = db.prepare("SELECT * FROM goals WHERE status='active' ORDER BY id").all();
    for (const g of goals) {
      const st = agent.goalStats(g);
      // 目标下还有待领取或进行中的任务 → 等外部工人/人工领取执行，总指挥不干预
      if (st.pending > 0 || st.in_progress > 0) continue;
      // 任务都做完了 → 总指挥规划下一步（拆新任务发布到池子 / 判定完成 / 等待）
      const minGapMs = Math.max(60, (a.planIntervalMin || 3) * 60) * 1000;
      let gapOk = true;
      if (g.last_plan_at) {
        const last = new Date(String(g.last_plan_at).replace(' ', 'T'));
        gapOk = (Date.now() - last.getTime()) > minGapMs;
      }
      if (gapOk) {
        const r = await agent.planAndDispatch(g);
        if (r.action === 'plan') console.log(`🎯 目标「${g.title}」规划派发 ${(r.created || []).length} 个新任务（发布到池子，等待工人领取）`);
        else if (r.action === 'complete') console.log(`🏁 目标「${g.title}」自动完成：${(r.summary || '').slice(0, 80)}`);
        else console.log(`⏳ 目标「${g.title}」规划：等待（${r.reason}）`);
      }
    }
    // 3) 总指挥自主巡查：定期审视整个任务池，自主决策 重置/取消/补建 任务
    const patrolMin = Math.max(5, parseInt(a.patrolInterval, 10) || 5);
    if (Date.now() - lastPatrolAt > patrolMin * 60 * 1000) {
      lastPatrolAt = Date.now();
      const pr = await agent.patrolTasks();
      if (pr.ok) {
        const n = (pr.actions.reset || []).length + (pr.actions.cancel || []).length + (pr.actions.create || []).length;
        if (n) console.log(`🔍 总指挥自主巡查完成：重置 ${pr.actions.reset.length}｜取消 ${pr.actions.cancel.length}｜补建 ${pr.actions.create.length}`);
      } else if (pr.reason && pr.reason !== '任务池无异常，无需巡查') {
        console.log(`🔍 总指挥自主巡查：${pr.reason}`);
      }
    }
  } finally {
    tickRunning = false;
  }
}

function startAutoRun() {
  const a = cfg.ai || {};
  if (!a.enabled || !a.autoRun) {
    console.log('后台自主执行：未开启（config.json 的 ai.autoRun）');
    return;
  }
  const interval = Math.max(5, parseInt(a.autoRunInterval, 10) || 20) * 1000;
  autoRunTimer = setInterval(autoRunTick, interval);
  console.log(`🤖 总指挥自主管理已启动：每 ${interval / 1000}s 规划拆任务 + 巡查处置异常任务（执行不自动，由外部工人/人工领取）`);
  autoRunTick(); // 启动后立即跑一次
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log('');
    console.log(`[冒险公会] 端口 ${PORT} 已被占用，说明已有看板服务（或旧系统看板）正在运行。`);
    console.log(`  处理方式（任选其一）：`);
    console.log(`  1) 停止占用 ${PORT} 端口的旧服务后，再重新运行 start.bat；`);
    console.log(`  2) 在配置文件 ~/.adventure-guild/config.json 中设置其他端口，例如：`);
    console.log(`       { "server": { "port": 8767 } }`);
    console.log(`     然后重新运行 start.bat。`);
    console.log('');
    process.exit(0);
  } else {
    console.error('服务器错误:', err);
    process.exit(1);
  }
});

// ========== 崩溃兜底：把致命错误写进 srv-err.log 再退出（看门狗 watchdog.mjs 会自动拉起） ==========
function crashLog(label, err) {
  try {
    const ts = new Date().toLocaleString('zh-CN', { hour12: false });
    const msg = `[${ts}] ${label}: ${err && err.stack ? err.stack : String(err)}\n`;
    require('fs').appendFileSync(require('path').join(__dirname, '..', 'srv-err.log'), msg);
  } catch (e) { /* 日志写失败不影响退出 */ }
}
process.on('uncaughtException', (err) => {
  crashLog('uncaughtException', err);
  console.error('未捕获异常，进程退出（watchdog 将自动拉起）:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  crashLog('unhandledRejection', reason);
  console.error('未处理的 Promise 拒绝，进程退出（watchdog 将自动拉起）:', reason);
  process.exit(1);
});
