/* ============================================================
   冒险公会：任务看板 — 前端应用逻辑（Phase 2）
   职责：拉取 /api/state 渲染看板；筛选/分页/工作区/详情/打分/统计/设置；自动刷新
   ============================================================ */
'use strict';

// ─── 全局状态 ───
let STATE = null;                 // 最近一次 /api/state
let CFG = null;                   // /api/config
let CURRENT_WORKSPACE = 'all';       // 工作区（数据层，历史兼容）
let CURRENT_PROJECT = (function(){ try { return localStorage.getItem('ag_current_project') || 'all'; } catch(e){ return 'all'; } })();         // 项目（查看层，全数据隔离：zhaoxi/guild/tool/zaima/other/all）
let currentStatus = 'all';
let currentAssignee = '';
let currentCreator = '';
let currentPriority = '';   // opt-003: 优先级组合筛选
let searchQuery = '';        // opt-003: 搜索关键词（ID/标题/执行人，匹配高亮）
let completedPage = 1;
let modelPage = 1;
let MODEL_PERIOD = 'all';   // opt-004: 执行AI排行周期（总榜/本周/本月）
// opt-010: 排行表折叠态（默认折叠：只显前5名+精简5列）
let MODEL_EXPANDED = false;
const MODEL_TOP_N = 5;      // 折叠时显示前 N 名
// opt-010: 折叠态 localStorage 保持（可选增强）
try { if (localStorage.getItem('modelExpanded') === '1') MODEL_EXPANDED = true; } catch (e) {}
// opt-012: 顶部面板整体折叠态（默认只显统计卡；展开后才显筛选栏+排行表）
let PANEL_EXPANDED = false;
try { if (localStorage.getItem('panelExpanded') === '1') PANEL_EXPANDED = true; } catch (e) {}
// opt-008: AI排行表头排序状态
let modelSortKey = 'level'; // opt-025: 默认按等级(level)降序（等级决定一切，经验仅排序兜底）
let modelSortDir = 1; // 1=降序, -1=升序
let lastSignature = '';
let refreshTimer = null;
let autoPaused = false;
let COMPLETED_DATA = [];
let MODEL_DATA = [];

// ─── 常量映射 ───
const STATUS_LABEL = { pending: '⏳ 待领取', in_progress: '🔄 进行中', review: '🔍 待审查', completed: '✅ 已完成', failed: '❌ 失败', cancelled: '🚫 已取消' };
const STATUS_COLOR = { pending: '#f0a030', in_progress: '#4aa3ff', review: '#c084fc', completed: '#37c08a', failed: '#e05555', cancelled: '#8a9bb0' };
const PRIORITY_LABEL = { 0: '低', 1: '中', 2: '高' };
const PRIORITY_COLOR = { 0: '#8a9bb0', 1: '#f0a030', 2: '#e05555' };

// ─── 工具 ───
function $(id) { return document.getElementById(id); }
function escHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
// opt-003: 搜索高亮 —— 原始文本截断 -> HTML 转义 -> 命中词包 <mark>（大小写不敏感，安全处理实体）
function hlText(text, len) {
  let s = String(text === null || text === undefined ? '' : text);
  let cut = false;
  if (len && s.length > len) { s = s.substring(0, len); cut = true; }
  const q = String(searchQuery || '').trim();
  if (!q) return escHtml(s) + (cut ? '…' : '');
  const out = [];
  const lower = s.toLowerCase(), ql = q.toLowerCase();
  let i = 0, idx;
  while ((idx = lower.indexOf(ql, i)) !== -1) {
    if (idx > i) out.push(escHtml(s.substring(i, idx)));
    out.push('<mark class="hl">' + escHtml(s.substring(idx, idx + q.length)) + '</mark>');
    i = idx + q.length;
  }
  out.push(escHtml(s.substring(i)));
  return out.join('') + (cut ? '…' : '');
}
// opt-004: 打回原因醒目横幅（卡片上直接可见，不必点开详情）
function rejectBanner(t) {
  let reason = (t.reject_reason || '').trim();
  let flagged = !!reason;
  if (!reason) {
    const m = (t.description || '').match(/【被打回重做】(.+?)(?:\n|$)/);
    if (m) { reason = m[1].trim(); flagged = !!reason; }
  }
  if (!flagged) return '';
  if (!reason) reason = '（未记录原因）';
  const who = t.rejected_by || '公会会长';
  const when = t.rejected_at ? ' · ' + t.rejected_at : '';
  return `<div class="redo-banner" title="打回者：${escHtml(who)}${escHtml(when)}">↩️ 打回原因：${escHtml(reason)}</div>`;
}
async function fetchJSON(url, opts) {
  const resp = await fetch(url, opts);
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data.ok === false) throw new Error(data.error || ('HTTP ' + resp.status));
  return data;
}
function toast(msg, ok) {
  const t = $('toast');
  t.className = ok ? 'ok' : 'err';
  t.textContent = msg;
  t.style.display = 'block';
  clearTimeout(t._t);
  t._t = setTimeout(() => { t.style.display = 'none'; }, 3000);
}
function flashEl(id) {
  const el = $(id);
  if (!el) return;
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 800);
}
function assigneeColor(name) {
  if (!name) return '#475569';
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return 'hsl(' + (Math.abs(hash) % 360) + ', 65%, 55%)';
}
function assigneeInitial(name) { return name ? name.trim().charAt(0).toUpperCase() : '?'; }
function scoreClass(s) { const v = parseFloat(s); if (isNaN(v)) return 'none'; if (v >= 3.8) return 'good'; if (v >= 3.2) return 'mid'; return 'bad'; }
function scoreBadge(s) {
  if (s === null || s === undefined || s === '') return '<span class="score none">未评</span>';
  return '<span class="score ' + scoreClass(s) + '">' + parseFloat(s).toFixed(1) + '</span>';
}
function overtimeLevel(t) {
  if (t.status !== 'in_progress' || !t.claimed_at) return 0;
  const c = new Date(t.claimed_at.replace(' ', 'T'));
  if (isNaN(c.getTime())) return 0;
  const diff = (Date.now() - c.getTime()) / 60000;
  if (diff > 60) return 2;
  if (diff > 30) return 1;
  return 0;
}

// ─── 卡片渲染 ───
// opt-026: 难度星级（1-5星，默认3；t.difficulty 可能缺失/为 null 时兜底）
function diffStars(t) {
  const n = Math.max(1, Math.min(5, parseInt(t.difficulty, 10) || 3));
  const labels = { 1: '简单', 2: '较易', 3: '普通', 4: '较难', 5: '困难' };
  return `<span class="task-diff" title="难度：${n} 星（${labels[n]}）">${'⭐'.repeat(n)}</span>`;
}
function taskCard(t) {
  const isRedo = (t.title || '').startsWith('[重做]');
  const title = isRedo ? t.title.replace('[重做]', '') : t.title;
  const ot = overtimeLevel(t);
  const otTag = ot === 2 ? '<span class="ot-tag ot-red">⚠️超时>60min</span>'
    : ot === 1 ? '<span class="ot-tag ot-yellow">⏱️>30min</span>' : '';
  const creator = (t.created_by || '').trim() || '未知';
  const assigneeHtml = t.assignee
    ? `<div class="task-assignee" data-assignee="${escHtml(t.assignee)}" onclick="event.stopPropagation();filterByAssignee('${escHtml(t.assignee)}')">
         <span class="assignee-avatar" style="background:${assigneeColor(t.assignee)}">${assigneeInitial(t.assignee)}</span>
         <span class="assignee-name">${hlText(t.assignee)}</span></div>`
    : '<div class="task-assignee unassigned"><span class="assignee-avatar" style="background:#475569">?</span><span class="assignee-name">未领取</span></div>';
  const timeHtml = t.completed_at ? `<div class="task-time">✅ 完成于 ${escHtml(t.completed_at)}</div>`
    : t.claimed_at ? `<div class="task-time">📥 领取于 ${escHtml(t.claimed_at)}</div>` : '';
  const resetBtn = t.status === 'in_progress'
    ? `<button class="btn ghost score-btn" style="font-size:11px" onclick="event.stopPropagation();resetTask('${escHtml(t.task_id)}','${escHtml(t.assignee || '')}')">↺ 重置</button>` : '';
  const scoreBtn = t.status === 'completed'
    ? `<button class="score-btn" onclick="event.stopPropagation();openScoreForm('${escHtml(t.task_id)}')">🧭 评分</button>` : '';
  const reviewBtns = t.status === 'review'
    ? `<span style="display:inline-flex;gap:6px;margin-top:2px">
        <button class="score-btn" style="color:#37c08a" onclick="event.stopPropagation();openScoreForm('${escHtml(t.task_id)}')">✅ 通过审查</button>
        <button class="score-btn" style="color:#e05555" onclick="event.stopPropagation();reviewReject('${escHtml(t.task_id)}')">↩️ 打回</button>
      </span>` : '';
  return `<div class="task-card status-${t.status}${ot ? ' overtime-' + ot : ''}" data-status="${t.status}"
       data-assignee="${escHtml(t.assignee || '')}" data-creator="${escHtml(creator)}" data-redo="${t.is_redo}" data-task-id="${escHtml(t.task_id)}" data-title="${escHtml(title)}" data-priority="${t.priority ?? ''}"
       onclick="openTaskDetail('${escHtml(t.task_id)}')">
    <div class="task-header">
      <span class="task-id">${escHtml(t.task_id)}</span>
      <span class="creator-tag${(t.created_by||'').trim()?'':' creator-unknown'}" title="创建人：${escHtml(creator)}" onclick="event.stopPropagation();filterByCreator('${escHtml(creator)}')">👤 ${escHtml(creator)}</span>
      <span class="task-priority pr-${t.priority}" title="优先级：${PRIORITY_LABEL[t.priority] || '?'}">●${PRIORITY_LABEL[t.priority] || '?'}</span>
      ${diffStars(t)}
      ${isRedo ? '<span class="redo-tag">🔄重做</span>' : ''}
      ${otTag}
      ${scoreBadge(t.score_total)}
      <span class="task-status" style="background:${STATUS_COLOR[t.status]}">${STATUS_LABEL[t.status] || t.status}</span>
      ${resetBtn}
    </div>
    <div class="task-title">${hlText(title)}</div>
    ${assigneeHtml}
    ${rejectBanner(t)}
    ${t.description ? `<div class="task-desc">${hlText(t.description, 150)}</div>` : ''}
    ${t.result ? `<div class="task-result">📋 ${hlText(t.result.replace(/\n/g, ' '), 120)}</div>` : ''}
    ${t.score_comment ? `<div class="task-score-comment">💬 评分: ${escHtml(t.score_comment)}</div>` : ''}
    ${t.workspace_name ? `<div class="task-workspace">🏰 ${escHtml(t.workspace_name)}</div>` : ''}
      ${timeHtml}
      ${scoreBtn}
      ${reviewBtns}
  </div>`;
}

function redoTaskCard(t) {
  const title = (t.title || '').startsWith('[重做]') ? t.title.replace('[重做]', '') : t.title;
  let rejectReason = t.reject_reason || '';
  if (!rejectReason) {
    const m = (t.description || '').match(/【被打回重做】(.+?)(?:\n|$)/);
    if (m) rejectReason = m[1].trim();
  }
  const originalAssignee = t.original_assignee || '—';
  const rejectedBy = t.rejected_by || '公会会长';
  const reworkedBy = t.reworked_by || t.assignee || '—';
  const rCreator = (t.created_by || '').trim() || '未知';
  const mini = n => `<span class="assignee-mini" style="background:${assigneeColor(n)}">${assigneeInitial(n)}</span> ${escHtml(n)}`;
  const steps = [
    `<div class="timeline-step"><div class="timeline-dot" style="background:#4aa3ff"></div><div class="timeline-content"><span class="timeline-label">原作者</span>${mini(originalAssignee)}</div></div>`,
    `<div class="timeline-step"><div class="timeline-dot" style="background:#e05555"></div><div class="timeline-content"><span class="timeline-label">打回者</span>${mini(rejectedBy)}${t.rejected_at ? `<span class="timeline-time">${escHtml(t.rejected_at)}</span>` : ''}${rejectReason ? `<div class="timeline-reason">📌 ${escHtml(rejectReason)}</div>` : ''}</div></div>`,
    t.status === 'completed'
      ? `<div class="timeline-step"><div class="timeline-dot" style="background:#37c08a"></div><div class="timeline-content"><span class="timeline-label">重做者</span>${mini(reworkedBy)}${t.reworked_at ? `<span class="timeline-time">${escHtml(t.reworked_at)}</span>` : ''}</div></div>`
      : `<div class="timeline-step"><div class="timeline-dot" style="background:#f0a030"></div><div class="timeline-content"><span class="timeline-label">待重做</span><span style="color:#f0a030">等待领取…</span></div></div>`
  ];
  return `<div class="task-card redo-card" data-status="redo" data-assignee="${escHtml(reworkedBy)}" data-creator="${escHtml(rCreator)}" data-redo="true" data-task-id="${escHtml(t.task_id)}" data-title="${escHtml(title)}" data-priority="${t.priority ?? ''}" onclick="openTaskDetail('${escHtml(t.task_id)}')">
    <div class="task-header">
      <span class="task-id">${escHtml(t.task_id)}</span>
      <span class="creator-tag${(t.created_by||'').trim()?'':' creator-unknown'}" title="创建人：${escHtml(rCreator)}" onclick="event.stopPropagation();filterByCreator('${escHtml(rCreator)}')">👤 ${escHtml(rCreator)}</span>
      <span class="task-priority pr-${t.priority}" title="优先级：${PRIORITY_LABEL[t.priority] || '?'}">●${PRIORITY_LABEL[t.priority] || '?'}</span>
      ${diffStars(t)}
      <span class="redo-tag">🔄重做</span>
      <span class="task-status" style="background:${STATUS_COLOR[t.status] || '#a06bd0'}">${STATUS_LABEL[t.status] || t.status}</span>
    </div>
    <div class="task-title">${hlText(title)}</div>
    ${rejectBanner(t)}
    <div class="timeline">${steps.join('')}</div>
    ${t.result ? `<div class="task-result">📋 ${hlText(t.result.replace(/\n/g, ' '), 100)}</div>` : ''}
  </div>`;
}

// opt-004: 评分后本地立即更新卡片分数（不等网络返回）
function applyLocalScore(taskId, s) {
  const t = (STATE && STATE.tasks || []).find(x => x.task_id === taskId);
  if (t) {
    t.score_total = s.score_total;
    t.score_comment = s.comment || '';
    if (s.completion !== undefined) { t.score_completion = s.completion; t.score_quality = s.quality; t.score_verification = s.verification; t.score_record = s.record; }
  }
  // 同步数据属性，供筛选/搜索使用
  const card = document.querySelector('.task-card[data-task-id="' + CSS.escape(taskId) + '"]');
  if (!card) return;
  const header = card.querySelector('.task-header');
  if (header) {
    const old = header.querySelector('.score');
    if (old) old.remove();
    const newBadge = document.createElement('span');
    newBadge.innerHTML = scoreBadge(s.score_total);
    const statusEl = header.querySelector('.task-status');
    if (statusEl) header.insertBefore(newBadge.firstChild, statusEl);
  }
  // 评分评语同步
  let commentEl = card.querySelector('.task-score-comment');
  if (s.comment) {
    if (!commentEl) {
      commentEl = document.createElement('div');
      commentEl.className = 'task-score-comment';
      card.appendChild(commentEl);
    }
    commentEl.innerHTML = '💬 评分: ' + escHtml(s.comment);
  } else if (commentEl) { commentEl.remove(); }
}

// ─── 看板渲染 ───
function renderBoard() {
  const d = STATE;
  if (!d) return;

  // 统计卡
  const sm = d.statMap || {};
  const cards = [
    ['in_progress', '🔄 进行中', sm.in_progress || 0, '#4aa3ff', "filterByStatus('in_progress')"],
    ['pending', '⏳ 待领取', sm.pending || 0, '#f0a030', "filterByStatus('pending')"],
    ['completed', '✅ 已完成', sm.completed || 0, '#37c08a', "filterByStatus('completed')"],
    ['failed', '❌ 失败', sm.failed || 0, '#e05555', "filterByStatus('failed')"],
    ['cancelled', '🚫 已取消', sm.cancelled || 0, '#8a9bb0', 'void(0)'],
    ['redo', '🔄 重做', d.redoCount || 0, '#a06bd0', "filterByStatus('redo')"],
    ['total', '📊 总任务', d.total || 0, '#d4af37', "filterByStatus('all')"],
    ['rate', '📉 打回率', (d.rejectRate || 0) + '%', '#f0a030', "filterByStatus('redo')"]
  ];
  $('statsBar').innerHTML = cards.map(c =>
    `<div class="stat-card" onclick="${c[4]}"><div class="num" id="stat-${c[0]}" style="color:${c[3]}">${c[2]}</div><div class="label">${c[1]}</div></div>`).join('');

  // 筛选标签计数
  const tabCounts = { all: d.total, in_progress: sm.in_progress || 0, pending: sm.pending || 0,
                      completed: sm.completed || 0, failed: sm.failed || 0, cancelled: sm.cancelled || 0, redo: d.redoCount || 0 };
  document.querySelectorAll('.filter-tab').forEach(tab => {
    const c = tab.querySelector('.count');
    if (c) c.textContent = tabCounts[tab.dataset.filter] ?? 0;
  });

  // 分组
  const groups = { in_progress: [], pending: [], review: [], failed: [], cancelled: [], completed: [] };
  d.tasks.forEach(t => { if (groups[t.status]) groups[t.status].push(t); });
  // opt-002: 已完成任务按完成时间倒序（最新完成的排最前）。
  // 服务端 SQL 的 ORDER BY 只有 priority + task_id，导致 ai-020 会排在 ai-002 前面。
  // completed_at 形如 '2026-09-01 14:19:17'，字典序等于时间序可直接比；
  // 缺失完成时间的脏数据排到最后，别让它霸占榜首。
  groups.completed.sort((a, b) => {
    const x = a.completed_at || '', y = b.completed_at || '';
    if (!x && !y) return 0;
    if (!x) return 1;
    if (!y) return -1;
    return x < y ? 1 : x > y ? -1 : 0;
  });
  COMPLETED_DATA = groups.completed;
  MODEL_DATA = d.modelScores || [];
  applyModelPeriodFilter(); // opt-004: 按总榜/本周/本月过滤执行AI
  applyModelSort(); // opt-008: 若用户已选排序列，对新数据重新排序
  const redoTasks = d.tasks.filter(t => t.is_redo);

  // 各分区 HTML
  let html = '';
  const section = (title, list, renderer) => list.length
    ? `<div class="section" data-section="${title}"><div class="section-title">${title} <span class="count">${list.length}</span></div><div class="task-grid">${list.map(renderer).join('')}</div></div>` : '';
  // opt-007: 执行AI排行移到主页最顶部（进行中分区之前）
  // opt-009: 排行表与筛选栏合并为顶部面板 —— 排行渲染进 #modelPanel（index.html 中与 filter-bar 同面板）
  // opt-010: 紧凑化 —— 默认折叠（前5名+精简5列），展开按钮控制；行高/字体压缩
  const mp = d.modelsPerPage || 10;
  const modelPages = Math.ceil(MODEL_DATA.length / mp);
  // 展开按钮文案：折叠→「展开全部（共 N 个AI）」；展开→「收起」
  const expBtn = MODEL_EXPANDED
    ? `<button class="rank-btn expand-btn" id="modelExpandBtn" onclick="toggleModelExpand()">收起 ▲</button>`
    : `<button class="rank-btn expand-btn" id="modelExpandBtn" onclick="toggleModelExpand()">展开全部（共 ${MODEL_DATA.length} 个AI）▾</button>`;
  // opt-010-r: 表头——折叠态不显示表头行（省一行高度，新视觉），展开态完整 11 列可排序表头
  const modelHead = MODEL_EXPANDED
    ? `<tr><th class="rank-col" title="排名">#</th><th data-sort="assignee" onclick="sortModelBy('assignee')" style="cursor:pointer">冒险者<span class="sort-ind"></span></th><th data-sort="level" onclick="sortModelBy('level')" style="cursor:pointer" title="RPG 等级">🏅等级<span class="sort-ind"></span></th><th data-sort="coins" onclick="sortModelBy('coins')" style="cursor:pointer" title="RPG 金币">💰金币<span class="sort-ind"></span></th><th data-sort="combo" onclick="sortModelBy('combo')" style="cursor:pointer" title="当前连击">🔥连击<span class="sort-ind"></span></th><th data-sort="completed" onclick="sortModelBy('completed')" style="cursor:pointer">完成/领取<span class="sort-ind"></span></th><th data-sort="rate" onclick="sortModelBy('rate')" style="cursor:pointer">完成率<span class="sort-ind"></span></th><th data-sort="avg_total" onclick="sortModelBy('avg_total')" style="cursor:pointer">均分<span class="sort-ind"></span></th><th data-sort="redo_rate" onclick="sortModelBy('redo_rate')" style="cursor:pointer">打回率<span class="sort-ind"></span></th><th>擅长项目</th><th data-sort="last_at" onclick="sortModelBy('last_at')" style="cursor:pointer">最近完成<span class="sort-ind"></span></th></tr>`
    : '';
  // 折叠时只显前5（带排名）；展开时按分页 slice（超10个走分页）
  const ranked = MODEL_DATA.map((m, i) => { m._rank = i + 1; return m; });
  const shown = MODEL_EXPANDED ? ranked.slice(0, mp) : ranked.slice(0, MODEL_TOP_N);
  const spanCols = MODEL_EXPANDED ? 11 : 2;
  const modelHtml = `<div class="section model-section"><div class="section-title">⚔️ 冒险者排行榜 <span class="count">${MODEL_DATA.length}个AI</span>
    <span class="model-period" style="margin-left:10px">
      <button class="rank-btn${MODEL_PERIOD === 'all' ? ' active' : ''}" onclick="switchModelPeriod('all')" id="modelRankAll">总榜</button>
      <button class="rank-btn${MODEL_PERIOD === 'week' ? ' active' : ''}" onclick="switchModelPeriod('week')" id="modelRankWeek">本周</button>
      <button class="rank-btn${MODEL_PERIOD === 'month' ? ' active' : ''}" onclick="switchModelPeriod('month')" id="modelRankMonth">本月</button>
    </span><span class="model-filter-badge" id="modelFilterBadge" style="display:none" title="点击 ✕ 取消筛选"></span>${expBtn}</div>
    <table class="model-table${MODEL_EXPANDED ? '' : ' compact slim'}">${MODEL_EXPANDED ? `<thead>${modelHead}</thead>` : ''}
    <tbody id="modelTbody">${shown.length ? shown.map(m => modelRow(m, !MODEL_EXPANDED)).join('') : `<tr><td colspan="${spanCols}" style="text-align:center;color:var(--text-dim);padding:14px">${MODEL_PERIOD === 'week' ? '本周' : MODEL_PERIOD === 'month' ? '本月' : ''}暂无上榜AI（本周/本月无完成任务）</td></tr>`}</tbody></table>
    ${(!MODEL_EXPANDED && MODEL_DATA.length > MODEL_TOP_N) || (MODEL_EXPANDED && modelPages > 1) ? `<div class="pagination">${MODEL_EXPANDED && modelPages > 1 ? `<button class="page-btn" onclick="changeModelPage(-1)" id="modelPrev">上一页</button><span class="page-info" id="modelPageInfo">第 1 / ${modelPages} 页</span><button class="page-btn" onclick="changeModelPage(1)" id="modelNext">下一页</button>` : ''}</div>` : ''}
  </div>`;
  const mpEl = $('modelPanel');
  if (mpEl) mpEl.innerHTML = modelHtml;
  html += section('🔄 进行中', groups.in_progress, taskCard);
  html += section('⏳ 待领取', groups.pending, taskCard);
  // opt-031: 反馈收件箱内嵌首页（待领取 ↓ / 待审查 ↑），巡查直接可见
  html += fbBoardSection(FB_VIEW_ROLE);
  html += section('🔍 待审查（peer review：通过或打回）', groups.review, taskCard);
  html += section('❌ 失败', groups.failed, taskCard);
  // fix--001: 已取消任务彻底不显示在主页（不渲染分区、统计卡点击不调出）
  html += `<div class="section" id="redoSection" style="display:none"><div class="section-title">🔄 重做任务（打回待重做） <span class="count">${redoTasks.length}</span></div><div class="task-grid">${redoTasks.map(redoTaskCard).join('')}</div></div>`;

  // 已完成（分页）
  const perPage = d.completedPerPage || 20;
  const compPages = Math.ceil(COMPLETED_DATA.length / perPage);
  html += `<div class="section" data-section="completed"><div class="section-title">✅ 已完成任务 <span class="count">${COMPLETED_DATA.length}</span></div>
    <div class="task-grid" id="completedGrid">${COMPLETED_DATA.map((t, i) => {
      const card = taskCard(t);
      const pageNum = Math.floor(i / perPage) + 1;
      return card.replace('<div class="task-card', `<div class="task-card" data-page="${pageNum}" data-page-hidden="${i >= perPage ? '1' : '0'}"`).replace(' data-task-id=', ' data-task-id=');
    }).join('')}</div>
    ${compPages > 1 ? `<div class="pagination"><button class="page-btn" onclick="changeCompletedPage(-1)" id="completedPrev">上一页</button><span class="page-info" id="completedPageInfo">第 1 / ${compPages} 页（每页${perPage}个）</span><button class="page-btn" onclick="changeCompletedPage(1)" id="completedNext">下一页</button></div>` : ''}
  </div>`;

  $('taskSections').innerHTML = html;
  updateModelSortIndicators(); // opt-008: 设置表头排序箭头
  applyPanelView();            // opt-012: 顶部面板折叠态显隐（统计卡恒显）

  // ai-028: 全空状态
  if (d.total === 0) {
    $('taskSections').innerHTML = `<div class="empty-state">
      <div class="empty-icon">📋</div>
      <div class="empty-title">任务池还是空的</div>
      <div class="empty-desc">点击右上角「＋ 新建任务」开始第一个任务，或在 AI 助手栏设定目标让公会会长自动拆解。</div>
    </div>`;
  }

  // 筛选 chips / 创建人下拉
  renderFilterChips(d);
  renderProjectSelect();
  renderCompletedPage();
  // opt-010: 数据变化后钳制 modelPage 防越界（展开态翻页后刷新数据变少的边界）
  if (MODEL_EXPANDED && MODEL_DATA.length > 0) {
    const tPages = Math.ceil(MODEL_DATA.length / mp);
    if (modelPage > tPages) modelPage = tPages;
    if (modelPage < 1) modelPage = 1;
  } else if (!MODEL_EXPANDED) {
    modelPage = 1; // 折叠态分页控件隐藏，重置页号避免残留
  }
  renderModelPage();
  updateModelFilterBadge(); // opt-022: 重渲染后恢复筛选徽标与行高亮
  highlightModelRows();
  applyFilters();
}

// opt-022: 排行表顶部筛选状态徽标
function updateModelFilterBadge() {
  const el = $('modelFilterBadge');
  if (!el) return;
  if (currentAssignee) {
    el.style.display = 'inline-flex';
    el.innerHTML = `当前筛选：<b>${escHtml(currentAssignee)}</b><span class="badge-x" onclick="event.stopPropagation();clearAssigneeFilter()" title="取消筛选">✕</span>`;
  } else {
    el.style.display = 'none';
    el.innerHTML = '';
  }
}
function clearAssigneeFilter() {
  currentAssignee = '';
  updateModelFilterBadge();
  highlightModelRows();
  applyFilters();
}
// opt-022: 排行表行高亮（含职务表联动高亮）
function highlightModelRows() {
  document.querySelectorAll('#modelPanel .model-table tbody tr').forEach(tr => {
    const trName = tr.dataset && tr.dataset.assignee ? tr.dataset.assignee : (tr.querySelector('.model-name') || {}).textContent;
    tr.classList.toggle('rank-hl', !!currentAssignee && trName === currentAssignee);
  });
}

function modelRow(m, compact) {
  // opt-010: compact=true（折叠态）只输出核心 5 列；否则完整 11 列
  const avg = parseFloat(m.avg_total);
  const cls = isNaN(avg) ? 'none' : (avg >= 3.8 ? 'good' : (avg >= 3.2 ? 'mid' : 'bad'));
  const rate = m.rate ?? 0;
  const rateCls = rate >= 80 ? 'good' : (rate >= 50 ? 'mid' : 'bad');
  // opt-004: 打回率 = redo / 领取数；0 打回且做过任务视为优秀
  const redoN = m.redo ?? 0;
  const rr = m.cnt ? Math.round((redoN / m.cnt) * 100) : 0;
  const rrCls = rr === 0 ? 'rate-good' : (rr <= 30 ? 'rate-mid' : 'rate-bad');
  // opt-004: 成功率 = 完成数中未被计入重做的比例（有打分才统计，这里用 100% - 打回率 直观展示）
  const success = Math.max(0, 100 - rr);
  const ssCls = success >= 80 ? 'rate-good' : (success >= 50 ? 'rate-mid' : 'rate-bad');
  if (compact) {
    // opt-010-r: 折叠态全新紧凑条设计 —— 无表头窄行，信息密度高，视觉焕新
    const rank = m._rank !== undefined ? m._rank : '';
    const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : '';
    return `<tr class="model-slim-row" data-assignee="${escHtml(m.assignee)}" onclick="filterByAssignee('${escHtml(m.assignee)}')" style="cursor:pointer" title="点击筛选该冒险者的任务">
    <td class="model-name slim-name">${medal}<span class="nm">${escHtml(m.assignee)}</span><span class="slim-rpg" title="等级 · 金币 · 连击">Lv.${m.level ?? 0} · ${m.coins ?? 0}💰 <span class="slim-combo">🔥${m.combo ?? 0}</span></span><span class="slim-cnt" title="完成/领取任务数">✓${m.completed ?? m.cnt}<span class="dim">/${m.cnt ?? '—'}</span></span></td>
    <td class="slim-metrics"><span class="sm ${rateCls}" title="完成率">● ${rate}%</span><span class="sm avg-score ${cls}" title="平均分">★ ${isNaN(avg) ? '—' : m.avg_total}</span><span class="sm ${rrCls}" title="打回 ${redoN} 次 / 共领取 ${m.cnt ?? 0} 次">↩ ${rr}%</span></td>
  </tr>`;
  }
  return `<tr data-assignee="${escHtml(m.assignee)}" onclick="filterByAssignee('${escHtml(m.assignee)}')" style="cursor:pointer" title="点击筛选该冒险者的任务">
    <td class="rank-cell dim" title="排名">${m._rank ?? '—'}</td>
    <td class="model-name">${escHtml(m.assignee)}</td>
    <td class="dim" title="RPG 等级">Lv.${m.level ?? 0}</td>
    <td title="RPG 金币">${m.coins ?? 0}<span class="dim"> 💰</span></td>
    <td title="当前连击">${m.combo ?? 0}<span class="dim"> 🔥</span></td>
    <td>${m.completed ?? m.cnt}<span class="dim">/${m.cnt ?? '—'}</span></td>
    <td class="avg-score ${rateCls}">${rate}%</td>
    <td class="avg-score ${cls}">${isNaN(avg) ? '—' : m.avg_total}</td>
    <td><span class="model-rate ${rrCls}" title="打回 ${redoN} 次 / 共领取 ${m.cnt ?? 0} 次">↩ ${rr}%</span></td>
    <td>${escHtml(m.top_project || '—')}</td>
    <td class="dim">${m.last_at ? String(m.last_at).slice(0, 10) : '—'}</td>
  </tr>`;
}

function renderFilterChips(d) {
  // opt-022: 执行人 chips 移除（点击筛选功能挪到排行表行），原位置放公会管理层职务表
  renderMemberTable();

  const sel = $('creatorSelect');
  const keep = currentCreator;
  sel.innerHTML = '<option value="">👤 全部创建人</option>';
  (d.allCreators || []).forEach(c => {
    const o = document.createElement('option');
    o.value = c;
    o.textContent = '👤 ' + c;
    sel.appendChild(o);
  });
  sel.value = (d.allCreators || []).includes(keep) ? keep : '';
  if (!sel.value) currentCreator = '';
}

// 项目切换器（固定项目选项，全数据隔离）
// opt-015: PROJECT_OPTIONS 改为动态——从 /api/projects 拉取（DB projects 表），
//          不再硬编码。all/other 为系统保留项；tool 兼容别名由后端映射 guild，前端不再出现。
let PROJECT_OPTIONS = [
  { key: 'all', label: '🌐 全部项目' },
  { key: 'other', label: '其他' },
];
let PROJECT_DB = []; // /api/projects 返回的 DB 项目（含 task_count），供项目管理面板使用

// 拉取项目列表并重建下拉（新增/编辑/删除项目后也调用）
async function loadProjects() {
  try {
    const r = await fetchJSON('/api/projects');
    if (r && r.ok && Array.isArray(r.projects)) {
      PROJECT_DB = r.projects;
      const dbItems = r.projects.map(p => ({ key: p.key, label: p.name }));
      PROJECT_OPTIONS = [
        { key: 'all', label: '🌐 全部项目' },
        ...dbItems,
        { key: 'other', label: '其他' },
      ];
      renderProjectSelect();
      if (typeof renderProjectsPanel === 'function') renderProjectsPanel();
      // 新建任务表单前缀下拉：allowedPrefixes ∪ 项目前缀（新项目自动可建任务）
      const fPrefix = $('fPrefix');
      if (fPrefix) {
        const cfgP = (CFG && CFG.tasks && CFG.tasks.allowedPrefixes) || [];
        const projP = r.projects.flatMap(p => (p.prefixes || [])).map(pf => pf.replace(/-$/, ''));
        const allP = [...new Set([...cfgP, ...projP])];
        fPrefix.innerHTML = allP.map(p => `<option value="${escHtml(p)}">${escHtml(p)}</option>`).join('');
        const def = (CFG && CFG.tasks && CFG.tasks.defaultPrefix) || 'quest';
        if (allP.includes(def)) fPrefix.value = def;
      }
    }
  } catch (e) { console.warn('项目列表加载失败', e); }
}
function renderProjectSelect() {
  const sel = $('projectSelect');
  if (!sel) return;
  const keep = CURRENT_PROJECT;
  sel.innerHTML = PROJECT_OPTIONS.map(p => `<option value="${p.key}">${p.label}</option>`).join('');
  sel.value = PROJECT_OPTIONS.some(p => p.key === keep) ? keep : 'all';
  if (sel.value !== keep) CURRENT_PROJECT = sel.value;
}
function projectLabel(key) {
  const p = PROJECT_OPTIONS.find(x => x.key === key);
  return p ? p.label.replace(/^[^\w\u4e00-\u9fa5]+/, '') : (key || '全部');
}

// ─── opt-015: 项目管理面板（设置视图内 CRUD）───
function toggleAddProject(show) {
  const f = $('projAddForm');
  if (!f) return;
  const go = show === undefined ? (f.style.display === 'none') : !!show;
  f.style.display = go ? '' : 'none';
  if (!go) { $('npKey').value = ''; $('npName').value = ''; $('npPrefixes').value = ''; $('npLeader').value = ''; $('npOrder').value = '50'; }
}

async function addProject() {
  const key = ($('npKey').value || '').trim();
  const name = ($('npName').value || '').trim();
  const prefixes = ($('npPrefixes').value || '').split(/[,，;；]/).map(s => s.trim()).filter(Boolean);
  const leader = ($('npLeader').value || '').trim();
  const sort_order = parseInt($('npOrder').value, 10) || 0;
  if (!key || !name) return toast('项目 key 与名称不能为空', false);
  if (prefixes.length === 0) return toast('至少需要一个前缀（如 myproj-）', false);
  try {
    const r = await fetchJSON('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ key, name, prefixes, leader, sort_order })
    });
    toast('✅ 项目 ' + key + ' 已新增');
    toggleAddProject(false);
    await loadProjects();
    await loadState(false); // 刷新分区（新项目任务将归入新分区）
  } catch (e) {
    toast('新增失败：' + e.message, false);
  }
}

function renderProjectsPanel() {
  const box = $('projPanel');
  if (!box) return;
  if (!PROJECT_DB || PROJECT_DB.length === 0) {
    box.innerHTML = '<div style="opacity:.6; padding:8px">暂无项目数据</div>';
    return;
  }
  box.innerHTML = '<table class="model-table compact" style="width:100%"><thead><tr>' +
    '<th>项目</th><th>key</th><th>任务前缀</th><th>负责人</th><th>排序</th><th>任务数</th><th>操作</th>' +
    '</tr></thead><tbody>' + PROJECT_DB.map(p => {
    const isGuild = p.key === 'guild';
    const pf = (p.prefixes || []).join(', ');
    return `<tr data-key="${escHtml(p.key)}">` +
      `<td><b>${escHtml(p.name)}</b>${isGuild ? ' <span style="opacity:.55;font-size:12px">(内置)</span>' : ''}</td>` +
      `<td><code>${escHtml(p.key)}</code></td>` +
      `<td style="max-width:260px">${escHtml(pf)}</td>` +
      `<td>${escHtml(p.leader || '—')}</td>` +
      `<td>${p.sort_order ?? 0}</td>` +
      `<td>${p.task_count ?? '—'}</td>` +
      `<td>${isGuild
        ? '<span style="opacity:.5;font-size:12px">内置保护</span>'
        : `<button class="btn" style="padding:2px 8px;font-size:12px" onclick="startEditProject('${escHtml(p.key)}')">✏️ 编辑</button> ` +
          `<button class="btn" style="padding:2px 8px;font-size:12px;color:#ef4444" onclick="deleteProject('${escHtml(p.key)}')">🗑️ 删除</button>`}` +
      `</td></tr>`;
  }).join('') + '</tbody></table>';
}

// 行内编辑：把该行替换为编辑控件
function startEditProject(key) {
  const p = PROJECT_DB.find(x => x.key === key);
  if (!p) return;
  const tr = document.querySelector(`#projPanel tr[data-key="${key}"]`);
  if (!tr) return;
  const esc = escHtml;
  tr.innerHTML = `<td colspan="7" style="padding:6px">
    <div style="display:flex; gap:6px; flex-wrap:wrap; align-items:center;">
      <input id="epKey" value="${esc(key)}" disabled style="width:90px;opacity:.7">
      <input id="epName" value="${esc(p.name)}" style="width:120px" autocomplete="off">
      <input id="epPrefixes" value="${esc((p.prefixes || []).join(','))}" style="width:240px" autocomplete="off" placeholder="前缀逗号分隔">
      <input id="epLeader" value="${esc(p.leader || '')}" style="width:110px" autocomplete="off" placeholder="负责人">
      <input id="epOrder" type="number" value="${p.sort_order ?? 0}" style="width:60px" autocomplete="off">
      <button class="btn primary" style="padding:2px 10px" onclick="saveEditProject('${esc(key)}')">保存</button>
      <button class="btn" style="padding:2px 10px" onclick="loadProjects()">取消</button>
    </div></td>`;
}

async function saveEditProject(key) {
  const payload = {
    name: ($('epName').value || '').trim(),
    prefixes: ($('epPrefixes').value || '').split(/[,，;；]/).map(s => s.trim()).filter(Boolean),
    leader: ($('epLeader').value || '').trim(),
    sort_order: parseInt($('epOrder').value, 10) || 0
  };
  if (!payload.name) return toast('名称不能为空', false);
  if (payload.prefixes.length === 0) return toast('至少需要一个前缀', false);
  const r = await fetchJSON('/api/projects/' + encodeURIComponent(key), {
    method: 'PUT',
    body: JSON.stringify(payload)
  }).catch(e => ({ ok: false, error: e.message }));
  if (r && r.ok) {
    toast('✅ 项目 ' + key + ' 已更新');
    await loadProjects();
    await loadState(false);
  } else {
    toast('更新失败：' + ((r && r.error) || '未知错误'), false);
  }
}

async function deleteProject(key) {
  const p = PROJECT_DB.find(x => x.key === key);
  if (!p) return;
  const warn = (p.task_count > 0)
    ? `项目「${p.name}」下有 ${p.task_count} 个任务，删除后这些任务将落入「其他」分区（数据不丢失）。确定删除？`
    : `确定删除项目「${p.name}」（${key}）？`;
  if (!confirm(warn)) return;
  const r = await fetchJSON('/api/projects/' + encodeURIComponent(key), { method: 'DELETE' }).catch(e => ({ ok: false, error: e.message }));
  if (r && r.ok) {
    toast('🗑️ 项目 ' + key + ' 已删除' + (r.related_tasks > 0 ? '（' + r.related_tasks + ' 个任务落入其他）' : ''));
    await loadProjects();
    await loadState(false);
  } else {
    toast('删除失败：' + ((r && r.error) || '未知错误'), false);
  }
}

// 已完成分页
function renderCompletedPage() {
  const grid = $('completedGrid');
  if (!grid) return;
  const perPage = (STATE && STATE.completedPerPage) || 20;
  const hasFilter = currentAssignee || currentCreator || currentPriority || (currentStatus !== 'all' && currentStatus !== 'redo');
  const pagination = document.querySelector('.section[data-section="completed"] .pagination');
  if (hasFilter) {
    // 筛选状态下显示所有命中任务，隐藏分页控件
    grid.querySelectorAll('.task-card').forEach(card => card.classList.remove('hidden'));
    if (pagination) pagination.style.display = 'none';
    return;
  }
  if (pagination) pagination.style.display = '';
  grid.querySelectorAll('.task-card').forEach(card => {
    const pageNum = parseInt(card.dataset.page, 10) || 1;
    card.classList.toggle('hidden', pageNum !== completedPage);
  });
  const totalPages = Math.ceil(COMPLETED_DATA.length / perPage);
  const info = $('completedPageInfo');
  const prev = $('completedPrev');
  const next = $('completedNext');
  if (info) info.textContent = '第 ' + completedPage + ' / ' + totalPages + ' 页（每页' + perPage + '个）';
  if (prev) prev.disabled = completedPage <= 1;
  if (next) next.disabled = completedPage >= totalPages;
}
function changeCompletedPage(dir) {
  const totalPages = Math.ceil(COMPLETED_DATA.length / ((STATE && STATE.completedPerPage) || 20));
  completedPage = Math.max(1, Math.min(totalPages, completedPage + dir));
  renderCompletedPage();
  applyFilters();
}

// 排行分页
// opt-004: 执行AI排行周期切换（总榜/本周/本月，按最近完成时间过滤）
function applyModelPeriodFilter() {
  if (MODEL_PERIOD === 'all' || !MODEL_DATA || !MODEL_DATA.length) return;
  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekStart = new Date(dayStart); weekStart.setDate(dayStart.getDate() - (dayStart.getDay() || 7) + 1);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const cutoff = MODEL_PERIOD === 'week' ? weekStart : MODEL_PERIOD === 'month' ? monthStart : null;
  if (!cutoff) return;
  MODEL_DATA = MODEL_DATA.filter(r => {
    const d = r.last_at ? new Date(String(r.last_at).replace(/-/g, '/')) : null;
    return d && d >= cutoff;
  });
}
function switchModelPeriod(period) {
  MODEL_PERIOD = period || 'all';
  lastSignature = '';
  loadState(true); // 重新拉数据后 renderBoard 会套用周期过滤
}
// opt-008: AI排行表头排序
function applyModelSort() {
  if (!modelSortKey) return;
  MODEL_DATA.sort((a, b) => {
    // opt-022: 经验排序的平级规则——exp 相同按 level DESC，再相同按完成数 DESC
    if (modelSortKey === 'level') {
      const dLv = ((b.level ?? 0) - (a.level ?? 0)) * modelSortDir;
      if (dLv) return dLv;
      const dExp = ((b.exp ?? 0) - (a.exp ?? 0)) * modelSortDir;
      if (dExp) return dExp;
      return ((b.completed ?? 0) - (a.completed ?? 0)) * modelSortDir;
    }
    if (modelSortKey === 'exp') {
      // 点击经验列排序保留（exp 无显示列，通过 level 分支已覆盖默认场景）
      const dExp = ((b.exp ?? 0) - (a.exp ?? 0)) * modelSortDir;
      if (dExp) return dExp;
      const dLv = ((b.level ?? 0) - (a.level ?? 0)) * modelSortDir;
      if (dLv) return dLv;
      return ((b.completed ?? 0) - (a.completed ?? 0)) * modelSortDir;
    }
    // opt-004: 计算型排序键（打回率/成功率）
    if (modelSortKey === 'redo_rate') {
      const ra = a.cnt ? Math.round(((a.redo ?? 0) / a.cnt) * 100) : 0;
      const rb = b.cnt ? Math.round(((b.redo ?? 0) / b.cnt) * 100) : 0;
      return (rb - ra) * modelSortDir;
    }
    if (modelSortKey === 'success_rate') {
      const sa = a.cnt ? Math.max(0, 100 - Math.round(((a.redo ?? 0) / a.cnt) * 100)) : 0;
      const sb = b.cnt ? Math.max(0, 100 - Math.round(((b.redo ?? 0) / b.cnt) * 100)) : 0;
      return (sb - sa) * modelSortDir;
    }
    let va = a[modelSortKey], vb = b[modelSortKey];
    // 缺失值排最后（降序时设为-Infinity，升序时设为Infinity）
    if (va === undefined || va === null || va === '' || va === '—') va = modelSortDir === 1 ? -Infinity : Infinity;
    if (vb === undefined || vb === null || vb === '' || vb === '—') vb = modelSortDir === 1 ? -Infinity : Infinity;
    if (typeof va === 'string' && typeof vb === 'string') {
      return va < vb ? modelSortDir : va > vb ? -modelSortDir : 0;
    }
    return (vb - va) * modelSortDir;
  });
}
function sortModelBy(key) {
  if (modelSortKey === key) {
    modelSortDir = -modelSortDir; // 同列再点：切换升降序
  } else {
    modelSortKey = key;
    modelSortDir = 1; // 新列默认降序
  }
  applyModelSort();
  modelPage = 1; // 排序后回到第一页
  updateModelSortIndicators();
  renderModelPage();
}
function updateModelSortIndicators() {
  document.querySelectorAll('.model-table th[data-sort] .sort-ind').forEach(span => {
    const th = span.closest('th');
    if (th && th.dataset.sort === modelSortKey) {
      span.textContent = modelSortDir === 1 ? ' ▼' : ' ▲';
    } else {
      span.textContent = '';
    }
  });
}
function renderModelPage() {
  const tbody = $('modelTbody');
  if (!tbody) return;
  const perPage = (STATE && STATE.modelsPerPage) || 10;
  // opt-010: 折叠态忽略分页只显前5；展开态才按分页 slice
  const rows = MODEL_EXPANDED ? MODEL_DATA.slice((modelPage - 1) * perPage, (modelPage - 1) * perPage + perPage) : MODEL_DATA.slice(0, MODEL_TOP_N);
  const cols = MODEL_EXPANDED ? 11 : 2;
  if (!MODEL_DATA.length) {
    // opt-004: 周期切换后无上榜数据时给空态提示
    tbody.innerHTML = `<tr><td colspan="${cols}" style="text-align:center;color:var(--text-dim);padding:14px">${MODEL_PERIOD === 'week' ? '本周' : MODEL_PERIOD === 'month' ? '本月' : ''}暂无上榜AI（本周/本月无完成任务）</td></tr>`;
  } else {
    // 排序/翻页渲染前按当前顺序重赋排名（保证奖牌跟随当前排序）
    const rowModels = rows.map((m, i) => { m._rank = (MODEL_EXPANDED ? (modelPage - 1) * perPage : 0) + i + 1; return m; });
    tbody.innerHTML = rowModels.map(m => modelRow(m, !MODEL_EXPANDED)).join('');
  }
  // opt-010: 折叠态分页控件整体由 renderBoard 控制显隐；此处仅更新文案/禁用态（若存在）
  const info = $('modelPageInfo');
  const prev = $('modelPrev');
  const next = $('modelNext');
  const totalPages = Math.ceil(MODEL_DATA.length / perPage);
  if (info) info.textContent = '第 ' + modelPage + ' / ' + totalPages + ' 页';
  if (prev) prev.disabled = modelPage <= 1;
  if (next) next.disabled = modelPage >= totalPages;
}
function toggleModelExpand() {
  // opt-010: 折叠/展开切换 —— 需重建表头（列数不同）+展开按钮，故整体重渲染面板
  MODEL_EXPANDED = !MODEL_EXPANDED;
  modelPage = 1; // 展开回到第一页
  try { localStorage.setItem('modelExpanded', MODEL_EXPANDED ? '1' : '0'); } catch (e) {}
  if (typeof renderBoard === 'function') renderBoard(); // 重建 modelPanel（含表头/按钮/分页显隐）
}
// opt-012: 顶部面板整体折叠/展开 —— 折叠态只显统计卡+展开按钮；展开态显示筛选栏+排行表
function togglePanelExpand() {
  PANEL_EXPANDED = !PANEL_EXPANDED;
  try { localStorage.setItem('panelExpanded', PANEL_EXPANDED ? '1' : '0'); } catch (e) {}
  applyPanelView();
}
// opt-012: 依据 PANEL_EXPANDED 应用面板显隐（筛选栏/排行表/标题），展开/收起按钮文案
function applyPanelView() {
  const tp = document.getElementById('topPanel');
  if (!tp) return;
  tp.classList.toggle('collapsed', !PANEL_EXPANDED);
  const btn = document.getElementById('panelHeadBtn');
  if (btn) btn.textContent = PANEL_EXPANDED ? '收起 ▲' : '展开筛选与排行 ▾';
  // 展开态下若排行表数据未渲染则重建；折叠态隐藏排行表（省布局）
  const mp = document.getElementById('modelPanel');
  if (mp) mp.style.display = PANEL_EXPANDED ? '' : 'none';
  const fb = document.getElementById('filterBar');
  if (fb) fb.style.display = PANEL_EXPANDED ? '' : 'none';
  const pt = document.getElementById('panelTitle');
  if (pt) pt.style.display = PANEL_EXPANDED ? '' : 'none';
  const ps = document.getElementById('panelSub');
  if (ps) ps.style.display = PANEL_EXPANDED ? '' : 'none';
}
function changeModelPage(dir) {
  const totalPages = Math.ceil(MODEL_DATA.length / ((STATE && STATE.modelsPerPage) || 10));
  modelPage = Math.max(1, Math.min(totalPages, modelPage + dir));
  renderModelPage();
}

// ─── 筛选（opt-003：状态+优先级+执行人+创建人+搜索 组合） ───
function filterByStatus(status) {
  // 点击状态标签时清除冒险者筛选（状态筛选与冒险者筛选互斥，不做组合筛选）
  currentAssignee = '';
  updateModelFilterBadge();
  highlightModelRows();
  document.querySelectorAll('.member-row').forEach(r => r.classList.remove('active'));
  if (status === 'all') {
    // 点击全部时清除所有筛选（状态/创建人/优先级/搜索），回到页面初始态
    currentStatus = 'all';
    currentCreator = '';
    currentPriority = '';
    searchQuery = '';
    document.querySelectorAll('.filter-tab').forEach(tab => tab.classList.toggle('active', tab.dataset.filter === 'all'));
    const creatorSel = $('creatorSelect'); if (creatorSel) creatorSel.value = '';
    const prioritySel = $('prioritySelect'); if (prioritySel) prioritySel.value = '';
    const searchInput = $('taskSearch'); if (searchInput) searchInput.value = '';
    applyFilters();
    renderCompletedPage();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  currentStatus = status;
  document.querySelectorAll('.filter-tab').forEach(tab => tab.classList.toggle('active', tab.dataset.filter === status));
  applyFilters();
  renderCompletedPage();
  const target = status === 'redo' ? $('redoSection') : status === 'cancelled' ? $('cancelledSection') : document.querySelector('.section[data-section="' + status + '"]');
  if (target && !target.classList.contains('hidden')) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function filterByAssignee(name) {
  currentAssignee = (currentAssignee === name) ? '' : name;
  // opt-022: chips 已移除（功能挪到排行表行点击 + 职务表），联动三处：排行表行高亮 / 顶部徽标 / 职务表行高亮
  highlightModelRows();
  updateModelFilterBadge();
  document.querySelectorAll('.member-row').forEach(r => r.classList.toggle('active', r.dataset.assignee === currentAssignee));
  applyFilters();
  renderCompletedPage(); // 筛选冒险者后同步分页控件显隐
}
function filterByCreator(name) {
  currentCreator = (currentCreator === name) ? '' : name;
  const sel = $('creatorSelect');
  if (sel) sel.value = currentCreator;
  applyFilters();
  renderCompletedPage(); // 筛选创建人后同步分页控件显隐
}
function onCreatorChange(value) { currentCreator = value || ''; applyFilters(); renderCompletedPage(); }
// opt-003: 优先级组合筛选
function onPriorityChange(value) {
  currentPriority = value || '';
  const sel = $('prioritySelect');
  if (sel) sel.value = currentPriority;
  applyFilters();
  renderCompletedPage(); // 筛选优先级后同步分页控件显隐
}
// opt-003: 搜索（ID/标题/执行人），匹配高亮 —— 重新渲染卡片以套用 hlText
function onTaskSearch(value) {
  searchQuery = (value || '').trim();
  if (searchQuery) completedPage = 1; // 搜索时回到已完成第一页，避免匹配被分页藏掉
  renderBoard(); // 重渲染 -> 卡片文本高亮；内部会 applyFilters 完成显隐
}
function clearFilters() {
  currentStatus = 'all'; currentAssignee = ''; currentCreator = ''; currentPriority = ''; searchQuery = '';
  document.querySelectorAll('.filter-tab').forEach(t => t.classList.toggle('active', t.dataset.filter === 'all'));
  updateModelFilterBadge(); // opt-022: 清除后同步排行表徽标/行高亮/职务表高亮
  highlightModelRows();
  document.querySelectorAll('.member-row').forEach(r => r.classList.remove('active'));
  const sel = $('creatorSelect'); if (sel) sel.value = '';
  const psel = $('prioritySelect'); if (psel) psel.value = '';
  const isel = $('taskSearch'); if (isel) isel.value = '';
  applyFilters();
}
function applyFilters() {
  const cards = document.querySelectorAll('.task-card');
  const q = searchQuery.toLowerCase();
  let visible = 0;
  cards.forEach(card => {
    let statusMatch;
    if (currentStatus === 'redo') statusMatch = card.dataset.redo === 'true';
    else statusMatch = (currentStatus === 'all') || (card.dataset.status === currentStatus);
    const assigneeMatch = !currentAssignee || card.dataset.assignee === currentAssignee;
    const creatorMatch = !currentCreator || card.dataset.creator === currentCreator;
    // opt-003: 优先级组合筛选
    const priorityMatch = !currentPriority || String(card.dataset.priority || '') === currentPriority;
    // opt-003: 搜索（ID/标题/执行人）
    const searchMatch = !q
      || String(card.dataset.title || '').toLowerCase().indexOf(q) !== -1
      || String(card.dataset.taskId || '').toLowerCase().indexOf(q) !== -1
      || String(card.dataset.assignee || '').toLowerCase().indexOf(q) !== -1;
    // 搜索或筛选状态下忽略分页显示所有命中；非筛选按当前页码分页
    // 注意：只有已完成任务有 data-page 属性，其他分区（待领取/进行中/待审查/失败）不受分页影响
    const hasFilter = currentAssignee || currentCreator || currentPriority || (currentStatus !== 'all' && currentStatus !== 'redo');
    const hasPage = card.dataset.page !== undefined;
    const pageOk = (searchMatch && q) || hasFilter || !hasPage || (parseInt(card.dataset.page, 10) === completedPage);
    const show = statusMatch && assigneeMatch && creatorMatch && priorityMatch && searchMatch && pageOk;
    card.classList.toggle('hidden', !show);
    if (show) visible++;
  });
  $('emptyHint').style.display = visible === 0 ? 'block' : 'none';
  $('clearFilter').style.display = (currentStatus !== 'all' || currentAssignee || currentCreator || currentPriority || searchQuery) ? 'inline' : 'none';
  const redoSection = $('redoSection');
  if (redoSection) {
    if (currentStatus === 'redo') {
      redoSection.style.display = '';
      document.querySelectorAll('.section[data-section]').forEach(s => s.style.display = 'none');
      const cs = $('cancelledSection'); if (cs) cs.style.display = 'none';
    } else {
      redoSection.style.display = 'none';
      document.querySelectorAll('.section[data-section]').forEach(section => {
        const n = section.querySelectorAll('.task-card:not(.hidden)').length;
        section.style.display = n === 0 ? 'none' : '';
      });
    }
  }
  // opt-001 补全：已取消分区仅在筛选「已取消」时显示
  const cancelledSection = $('cancelledSection');
  if (cancelledSection) {
    cancelledSection.style.display = (currentStatus === 'cancelled') ? '' : 'none';
  }
}

// ─── 工作区 ───
function onWorkspaceChange(name) {
  CURRENT_WORKSPACE = name || 'all';
  lastSignature = '';
  loadState(true);
}
// 项目切换（全数据隔离：任务/统计/排行/记忆）
function onProjectChange(key) {
  CURRENT_PROJECT = key || 'all';
  try { localStorage.setItem('ag_current_project', CURRENT_PROJECT); } catch(e) {}
  lastSignature = '';
  loadState(true);
  if ($('viewMemory').style.display !== 'none') loadMemory();
}

// ─── 视图切换 ───
function switchView(view) {
  document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.view === view));
  $('viewBoard').style.display = view === 'board' ? '' : 'none';
  $('viewStats').style.display = view === 'stats' ? '' : 'none';
  $('viewSettings').style.display = view === 'settings' ? '' : 'none';
  $('viewMemory').style.display = view === 'memory' ? '' : 'none';
  $('viewRecruit').style.display = view === 'recruit' ? '' : 'none';
  const titles = { board: '任务看板', stats: '统计仪表盘', settings: '设置', memory: '项目记忆', recruit: '招募令' };
  $('tbTitle').textContent = titles[view] || '任务看板';
  if (view === 'stats' && STATE) renderStats();
  if (view === 'settings' && !CFG) loadConfig();
  if (view === 'memory') loadMemoryRecent();
  if (view === 'recruit') loadRecruit();
}

// ─── 招募令视图（生成接入提示词，一键复制） ───
let RECRUIT_CACHE = null;
async function loadRecruit() {
  try {
    if (RECRUIT_CACHE && $('recruitChief') && $('recruitChief').textContent !== '加载中…') return;
    const d = await fetchJSON('/api/recruit');
    RECRUIT_CACHE = d;
    $('recruitChief').textContent = d.chief || '（未找到 docs/CHIEF_PROTOCOL.md）';
    $('recruitLeader').textContent = d.leader || '（未找到 docs/LEADER_PROTOCOL.md）';
    $('recruitAdventurer').textContent = d.adventurer || '（未找到 docs/RECRUIT.md）';
  } catch (e) {
    $('recruitAdventurer').textContent = '加载失败：' + e.message;
  }
}
function cleanCopyText(text, which) {
  // 提取 ═══ 角色提示词 ═══ 框内的核心正文（行首标记，避免引用行干扰），去掉标题/引用/代码块标记
  const marks = {
    chief: ['工会总会长上岗提示词', '总会长上岗提示词结束'],
    leader: ['执事上岗提示词', '会长上岗提示词结束'],
    adventurer: ['冒险者招募令', '冒险者招募令结束']
  };
  const ms = marks[which];
  if (ms) {
    // 逐行扫描：找到以 ═══ 开头且含开标记且不在引用行(「)的作为起点，含结束标记的行为终点
    const lines = text.split(/\r?\n/);
    let si = -1, ei = -1;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (si === -1 && l.indexOf('═══') !== -1 && l.indexOf(ms[0]) !== -1 && l.indexOf('「') === -1) { si = i + 1; continue; }
      if (si !== -1 && l.indexOf('═══') !== -1 && l.indexOf(ms[1]) !== -1) { ei = i; break; }
    }
    if (si !== -1 && ei !== -1) {
      let inner = lines.slice(si, ei).join('\n');
      inner = inner.replace(/^```\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
      if (inner) return inner;
    }
  }
  // 兜底：去掉标题行、引用说明、代码块标记
  return text.split(/\r?\n/).filter(l => !l.startsWith('#') && !l.startsWith('>') && !l.startsWith('```')).join('\n').trim();
}
function copyRecruit(which) {
  const names = { chief: RECRUIT_CACHE.chief, leader: RECRUIT_CACHE.leader, adventurer: RECRUIT_CACHE.adventurer };
  const raw = names[which];
  if (!raw) { toast('内容未就绪，请稍候', false); return; }
  const text = cleanCopyText(raw, which);
  const label = which === 'chief' ? '👑 总会长提示词已复制，发给目标 AI 即可' : which === 'leader' ? '🏛️ 会长提示词已复制，发给目标 AI 即可' : '⚔️ 招募令已复制，发给目标 AI 即可';
  const done = () => toast(label, true);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else fallbackCopy(text, done);
}
function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); done(); } catch (e) { toast('复制失败，请手动全选复制', false); }
  document.body.removeChild(ta);
}

// ─── 项目记忆视图（共享记忆库全局显示 + 软件记忆按项目过滤） ───
// opt-018: 记忆浏览状态
let MEM_TYPE = 'all';
let MEM_PAGE = 0;
let MEM_PAGE_SIZE = 40;
let MEM_DATA = { shared: [], local: [] };
let MEM_FULL = { shared: [], local: [] };
const MEM_TYPES = ['work_log','decision','knowledge','preference','project'];
const MEM_TYPE_NAME = { work_log:'📋 工作日志', decision:'🎯 决策经验', knowledge:'📚 项目知识', fact:'📚 项目知识', preference:'⚙️ 用户偏好', identity:'⚙️ 用户偏好', project:'📁 项目状态' };
const MEM_TYPE_COLOR = { work_log:'#4a90d9', decision:'#b078e0', knowledge:'#37c08a', fact:'#2ea8b8', preference:'#e0a030', identity:'#d95f7a', project:'#e05f5f', other:'#8a9bb0' };
function memTypeOf(t){ return MEM_TYPE_NAME[t] ? t : (t || 'other'); }
function memTypeLabel(t){ return MEM_TYPE_NAME[t] || (t || '其他'); }
function memTypeColor(t){ if(MEM_TYPE_COLOR[t]) return MEM_TYPE_COLOR[t]; if(t==='knowledge'||t==='fact') return MEM_TYPE_COLOR.knowledge; if(t==='preference'||t==='identity') return MEM_TYPE_COLOR.preference; return MEM_TYPE_COLOR.other; }
function memWho(r){ try { const tg = typeof r.tags === 'string' ? JSON.parse(r.tags) : (Array.isArray(r.tags) ? r.tags : []); if (Array.isArray(tg)) { const hits = tg.filter(function(x){ return !/\d{4}[-/]|\d{4}年/.test(String(x)) && String(x).length > 1 && !/^\[|^decision|^决策/.test(String(x)); }); if (hits.length) return hits[0]; } } catch(e){} var tt = String(r.title||''); if (!/^\[.*?\]/.test(tt)) return ''; var rest = tt.replace(/^\[[^\]]+\]\s*/, '').replace(/^\d{4}[-/]\d{1,2}(?:[-/]\d{1,2})?\s*/, '').replace(/^\d{4}年[^\s]*\s*/, ''); var m = rest.match(/^([^\s]+(?:\s*\([^)]*\))?)/); if (m) { var w = m[1].replace(/^[:：]/, '').trim(); if (w && w.length <= 60) return w; } return ''; }
function memTime(r){ return String(r.created_at||'').replace(/-/g,'/').slice(0,16); }
function memTypeFilterOk(t){ if(MEM_TYPE==='all') return true; if(MEM_TYPE==='knowledge') return t==='knowledge'||t==='fact'; if(MEM_TYPE==='preference') return t==='preference'||t==='identity'; return t===MEM_TYPE; }
function memCard(r){ var c=String(r.content||'').replace(/</g,'&lt;').replace(/\n/g,' ').slice(0,160); var t=String(r.title||'').replace(/</g,'&lt;'); var ty=memTypeOf(r.type); var col=memTypeColor(ty); var who=memWho(r); var star=(r.importance>=4)?'<span class="mem-star">⭐</span> ':''; var pj=(r.project&&r.project!=='other')?'<span class="mem-proj">'+(r.projectName||'')+'</span>':''; var wh=who?'<span class="mem-who">✍️ '+who+'</span>':''; return '<div class="mem-item"><div class="mem-item-title"><span class="mem-type" style="color:'+col+';border-color:'+col+';background:'+col+'18">'+memTypeLabel(r.type)+'</span> '+star+t+' '+pj+'</div><div class="mem-item-content">'+c+'</div><div class="mem-item-foot">'+wh+(wh&&memTime(r)?' · ':'')+memTime(r)+'</div></div>'; }
function memFiltered(arr){ var f=(arr||[]).filter(function(r){ return memTypeFilterOk(r.type); }); var sorted=f.slice().sort(function(x,y){ return String(y.created_at||'').localeCompare(String(x.created_at||'')); }); var stars=sorted.filter(function(r){ return r.importance>=4; }).slice(0,3); return { all:sorted, stars:stars }; }
async function loadMemory(kw) {
  const q = (kw !== undefined ? kw : ($('memSearch').value || '')).trim();
  const proj = CURRENT_PROJECT || 'all';
  $('memHint').textContent = q ? '正在搜索「' + q + '」…' : '正在加载…';
  try {
    const r = await fetch('/api/memory?kw=' + encodeURIComponent(q) + '&limit=200&project=' + encodeURIComponent(proj));
    const data = await r.json();
    if (!data.ok) { $('memHint').textContent = '加载失败'; return; }
    $('memSharedBadge').textContent = data.sharedAvailable ? '（已打通 · 所有 AI 共用）' : '（本地共享库不可用）';
    MEM_FULL = { shared: data.shared || [], local: data.local || [] };
    MEM_PAGE = 0;
    renderMemPanels();
    const pname = projectLabel(proj);
    $('memHint').textContent = (proj !== 'all' ? '【' + pname + '】' : '') + (q ? '搜索「' + q + '」' : '最近记录') + '：本地共享 ' + (data.shared || []).length + ' 条 / 软件 ' + (data.local || []).length + ' 条';
  } catch (e) { $('memHint').textContent = '请求失败: ' + e.message; }
}
function renderMemPanels() {
  renderMemList('memSharedList', 'memSharedStars', 'memSharedMoreWrap', MEM_FULL.shared, '本地共享');
  renderMemList('memLocalList', 'memLocalStars', 'memLocalMoreWrap', MEM_FULL.local, '软件');
}
function loadMemoryRecent() { $('memSearch').value = ''; loadMemory(''); }
function renderMemList(id, starsId, moreId, rows, srcLabel) {
  const el = $(id);
  const stEl = starsId ? $(starsId) : null;
  const moEl = moreId ? $(moreId) : null;
  if (!el) return;
  const { all, stars } = memFiltered(rows || []);
  if (stEl) {
    if (stars.length) { stEl.style.display = ''; stEl.innerHTML = '<div class="mem-stars-title">⭐ 重要记忆</div>' + stars.map(r => memCard(r)).join(''); }
    else { stEl.style.display = 'none'; stEl.innerHTML = ''; }
  }
  const shown = all.slice(0, (MEM_PAGE + 1) * MEM_PAGE_SIZE);
  if (!shown.length) el.innerHTML = '<div class="mem-empty">（无匹配记录）</div>';
  else el.innerHTML = shown.map(r => memCard(r)).join('');
  if (moEl) moEl.style.display = shown.length < all.length ? '' : 'none';
}
function loadMoreMem(kind) {
  MEM_PAGE++;
  const key = kind === 'shared' ? 'shared' : 'local';
  renderMemList(kind === 'shared' ? 'memSharedList' : 'memLocalList',
    kind === 'shared' ? 'memSharedStars' : 'memLocalStars',
    kind === 'shared' ? 'memSharedMoreWrap' : 'memLocalMoreWrap',
    MEM_FULL[key], kind === 'shared' ? '本地共享' : '软件');
}
function setMemType(t) {
  MEM_TYPE = t;
  MEM_PAGE = 0;
  document.querySelectorAll('#memTypeTabs .mem-tab').forEach(b => b.classList.toggle('active', b.dataset.type === t));
  renderMemPanels();
}


// ─── 数据加载与刷新 ───
function makeSignature(tasks) {
  return tasks.map(t => t.task_id + ':' + t.status + ':' + (t.assignee || '') + ':' + (t.completed_at || '') + ':' + (t.created_by || '') + ':' + (t.score_total || '')).join('|');
}
function setNum(id, val, flash) {
  const el = $(id);
  if (!el) return;
  if (el.textContent !== String(val)) {
    el.textContent = String(val);
    if (flash) flashEl(id);
  }
}

async function loadState(manual) {
  const btn = $('refreshBtn');
  if (btn) { btn.disabled = true; btn.textContent = '🔄 刷新中…'; }
  try {
    const d = await fetchJSON('/api/state?workspace=' + encodeURIComponent(CURRENT_WORKSPACE) + '&project=' + encodeURIComponent(CURRENT_PROJECT));
    STATE = d;
    const sig = makeSignature(d.tasks || []);
    const changed = sig !== lastSignature;
    if (lastSignature !== '' && changed) {
      const dot = $('liveDot');
      if (dot) { dot.style.background = '#fde047'; setTimeout(() => dot.style.background = '#37c08a', 900); }
    }
    lastSignature = sig;
    $('updateTime').textContent = d.updatedAt;

    if (changed || manual) {
      renderBoard();
      loadFbBoard();          // opt-031: 反馈收件箱内嵌首页，与任务列表同步刷新
      renderGuildRanking();  // g003-008: 公会排行榜
    } else {
      // 数字微更新
      const sm = d.statMap || {};
      setNum('stat-in_progress', sm.in_progress || 0, true);
      setNum('stat-pending', sm.pending || 0, true);
      setNum('stat-completed', sm.completed || 0, true);
      setNum('stat-failed', sm.failed || 0, true);
      setNum('stat-redo', d.redoCount || 0, true);
      setNum('stat-total', d.total || 0, true);
      setNum('stat-rate', (d.rejectRate || 0) + '%', true);
      document.querySelectorAll('.filter-tab').forEach(tab => {
        const c = tab.querySelector('.count');
        const map = { all: d.total, in_progress: sm.in_progress || 0, pending: sm.pending || 0, review: sm.review || 0, completed: sm.completed || 0, failed: sm.failed || 0, redo: d.redoCount || 0 };
        if (c) c.textContent = map[tab.dataset.filter] ?? 0;
      });
      renderFilterChips(d);
      renderProjectSelect();
      loadFbBoard();          // opt-031: 反馈数据与任务无关，微更新路径也同步刷新
    }
    if (CFG) renderSettings(); // 设置页同步最新工作区列表
    if (manual) toast(changed ? '已刷新，数据有更新' : '已刷新，暂无变化', true);
  } catch (e) {
    toast('刷新失败：' + e.message, false);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🔄 刷新'; }
  }
}

// ─── 自动刷新 ───
function startAutoRefresh() {
  stopAutoRefresh();
  const ms = (STATE && STATE.refreshMs) || 30000;
  refreshTimer = setInterval(() => { if (!autoPaused && document.visibilityState !== 'hidden') loadState(false); }, ms);
  $('autoState').textContent = '自动刷新中（' + Math.round(ms / 1000) + 's）';
}
function stopAutoRefresh() { if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; } }
function pauseAutoRefresh() {
  autoPaused = true; stopAutoRefresh();
  const st = $('autoState'); if (st) { st.textContent = '⏸ 自动刷新已暂停'; st.style.color = '#f0a030'; }
}
function resumeAutoRefresh() {
  autoPaused = false;
  const st = $('autoState'); if (st) st.style.color = '';
  if ($('fbBoardSection')) loadFbBoard(); // opt-031: 恢复自动刷新时同步首页反馈区
  startAutoRefresh();
}


// ─── 详情抽屉 ───
// ai-035: 公会会长决策结构化解析
function parseDecision(desc) {
  if (!desc) return null;
  const lines = String(desc).split('\n');
  const sections = { background: [], todo: [], acceptance: [], paths: [], risk: [], other: [] };
  let cur = 'background';
  const headerRe = /^(背景|痛点|问题|原因|动机|要做|方案|实现|需求|目标|验收|验证|标准|涉及路径|涉及文件|修改文件|文件|风险|注意|备注|提示)[：:]/;
  for (const line of lines) {
    const m = line.match(headerRe);
    if (m) {
      const h = m[1];
      if (['背景','痛点','问题','原因','动机'].includes(h)) cur = 'background';
      else if (['要做','方案','实现','需求','目标'].includes(h)) cur = 'todo';
      else if (['验收','验证','标准'].includes(h)) cur = 'acceptance';
      else if (['涉及路径','涉及文件','修改文件','文件'].includes(h)) cur = 'paths';
      else if (['风险','注意'].includes(h)) cur = 'risk';
      else cur = 'other';
      // 去掉标题前缀，保留内容
      const content = line.replace(headerRe, '').trim();
      if (content) sections[cur].push(content);
    } else {
      sections[cur].push(line);
    }
  }
  // 清理空行
  for (const k of Object.keys(sections)) {
    sections[k] = sections[k].map(s => s.trim()).filter(s => s);
  }
  const hasStructure = sections.todo.length > 0 || sections.acceptance.length > 0 || sections.paths.length > 0;
  if (!hasStructure) return null;
  return sections;
}

function renderDecisionPanel(t) {
  const desc = t.description || '';
  const parsed = parseDecision(desc);
  if (!parsed) {
    // 无结构化信息，显示全文
    return `<div class="d-item"><div class="d-label">📋 任务描述</div><div class="d-value decision-raw">${escHtml(desc) || '（无）'}</div></div>`;
  }
  const sec = (icon, label, arr) => arr.length ? `
    <div class="decision-sec">
      <div class="decision-sec-title">${icon} ${label}</div>
      <div class="decision-sec-body">${arr.map(l => `<div class="decision-line">${escHtml(l)}</div>`).join('')}</div>
    </div>` : '';
  return `
  <div class="d-item">
    <div class="d-label">🧭 公会会长决策</div>
    <div class="d-value decision-panel">
      ${sec('🎯', '背景与动机', parsed.background)}
      ${sec('✅', '要做什么', parsed.todo)}
      ${sec('🔍', '验收标准', parsed.acceptance)}
      ${sec('⚠️', '风险与注意', parsed.risk)}
      ${sec('📁', '涉及路径', parsed.paths)}
      ${sec('📝', '其他', parsed.other)}
    </div>
  </div>`;
}
async function openTaskDetail(taskId) {
  $('drawerMask').classList.add('show');
  $('drawerBody').innerHTML = '加载中…';
  try {
    const d = await fetchJSON('/api/task?task_id=' + encodeURIComponent(taskId));
    $('drawerBody').innerHTML = renderTaskDetail(d.task, d.score, d.workspace);
  } catch (e) {
    $('drawerBody').innerHTML = '<div class="d-value" style="color:#ff9d9d">加载失败：' + escHtml(e.message) + '</div>';
  }
}
function closeDrawer() { $('drawerMask').classList.remove('show'); }
function renderTaskDetail(t, score, workspace) {
  const rows = [];
  const row = (k, v) => `<div class="d-item"><div class="d-label">${k}</div><div class="d-value">${v === '' || v === null || v === undefined ? '—' : v}</div></div>`;
  rows.push(`<div class="d-row">
      ${row('任务ID', `<span class="d-value mono">${escHtml(t.task_id)}</span>`)}
      ${row('状态', STATUS_LABEL[t.status] || t.status)}
      ${row('优先级', PRIORITY_LABEL[t.priority] || t.priority)}
      ${row('难度', (() => { const n = Math.max(1, Math.min(5, parseInt(t.difficulty, 10) || 3)); const ls = { 1: '简单', 2: '较易', 3: '普通', 4: '较难', 5: '困难' }; return '⭐'.repeat(n) + ' ' + ls[n]; })())}
      ${row('工作区', '🏰 ' + escHtml(workspace))}
    </div>`);
  rows.push(row('标题', escHtml(t.title)));
  rows.push(row('创建人', escHtml(t.created_by || '未知')) + row('创建时间', escHtml(t.created_at)));
  rows.push(row('负责人', t.assignee ? escHtml(t.assignee) : '（未领取）'));
  if (t.claimed_at) rows.push(row('领取时间', escHtml(t.claimed_at)));
  if (t.completed_at) rows.push(row('完成时间', escHtml(t.completed_at)));
  // ai-035: 结构化决策面板替代纯文本描述
  rows.push(renderDecisionPanel(t));

  if (t.reject_reason || (t.description || '').includes('【被打回重做】')) {
    let reason = t.reject_reason || ((t.description || '').match(/【被打回重做】(.+?)(?:\n|$)/) || [, ''])[1].trim();
    rows.push(`<div class="d-item"><div class="d-label">🔄 重做历史链</div><div class="d-value">
      原作者：${escHtml(t.original_assignee || '—')}<br>
      打回者：${escHtml(t.rejected_by || '公会会长')}${t.rejected_at ? '（' + escHtml(t.rejected_at) + '）' : ''}<br>
      打回原因：${escHtml(reason || '—')}<br>
      重做者：${escHtml(t.reworked_by || t.assignee || '（待重做）')}${t.reworked_at ? '（' + escHtml(t.reworked_at) + '）' : ''}
    </div></div>`);
  }
  if (t.result) rows.push(row('结果', escHtml(t.result)));
  if (t.notes) rows.push(row('备注', escHtml(t.notes)));

  if (score) {
    const sc = scoreClass(score.score_total);
    rows.push(`<div class="d-item"><div class="d-label">📊 打分</div><div class="d-value">
      <div class="d-score-line"><span class="k">完成度</span><span class="v">${score.score_completion} / 4</span></div>
      <div class="d-score-line"><span class="k">质量</span><span class="v">${score.score_quality} / 4</span></div>
      <div class="d-score-line"><span class="k">验证</span><span class="v">${score.score_verification} / 4</span></div>
      <div class="d-score-line"><span class="k">记录</span><span class="v">${score.score_record} / 4</span></div>
      <div class="d-score-line"><span class="k">总分</span><span class="v" style="color:#e8c766">${score.score_total}</span></div>
      ${score.comment ? `<div style="margin-top:6px;color:#ffd28a">💬 ${escHtml(score.comment)}</div>` : ''}
      <div style="margin-top:4px;font-size:12px;color:#6f6a58">评分人：${escHtml(score.reviewer || '—')} · ${escHtml(score.created_at || '')}</div>
    </div></div>`);
  } else if (t.status === 'completed') {
    rows.push(`<div class="d-item"><div class="d-value"><button class="score-btn" onclick="closeDrawer();openScoreForm('${escHtml(t.task_id)}')">🧭 去评分</button></div></div>`);
  }

  if (t.status === 'in_progress') {
    rows.push(`<div class="d-item"><button class="btn ghost score-btn" onclick="resetTask('${escHtml(t.task_id)}','${escHtml(t.assignee || '')}')">↺ 重置为待领取</button></div>`);
  }
  return rows.join('');
}

// ─── 重置 ───
async function resetTask(taskId, assignee) {
  const msg = '确定要重置任务 ' + taskId + ' 吗？\n\n将：状态改回「待领取」、释放负责人' + (assignee ? '（' + assignee + '）' : '') + '。\n仅用于 AI 卡死时释放任务，误点请取消。';
  if (!window.confirm(msg)) return;
  try {
    const d = await fetchJSON('/api/reset', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_id: taskId })
    });
    toast('✅ ' + taskId + ' 已重置为待领取', true);
    lastSignature = '';
    await loadState(true);
  } catch (e) { toast('❌ 重置失败：' + e.message, false); }
}

// ─── 新建任务 ───
function openCreateForm() {
  $('createMask').classList.add('show');
  const fw = $('fWorkspace');
  if (fw && CURRENT_WORKSPACE !== 'all') fw.value = CURRENT_WORKSPACE;
  pauseAutoRefresh();
  setTimeout(() => $('fTitle').focus(), 50);
}
function closeCreateForm() {
  $('createMask').classList.remove('show');
  $('fTitle').value = ''; $('fDesc').value = '';
  $('fPriority').value = '1';
  const fd = $('fDifficulty'); if (fd) fd.value = '3';
  if (CFG) $('fPrefix').value = CFG.tasks.defaultPrefix;
  const fw = $('fWorkspace');
  if (fw && CFG) {
    const def = (CFG.workspaces || []).find(w => w.is_default);
    fw.value = (def && def.name) || '默认';
  }
  const cs = $('fCreator'); if (cs) cs.value = (CFG && CFG.tasks.createdByDefault) || '公会会长';
  const co = $('fCreatorOther'); if (co) { co.value = ''; co.classList.remove('show'); }
  resumeAutoRefresh();
}
function onFormCreatorChange(value) {
  const other = $('fCreatorOther');
  if (other) other.classList.toggle('show', value === '__other__');
}
async function submitCreate() {
  const title = $('fTitle').value.trim();
  const desc = $('fDesc').value.trim();
  const priority = parseInt($('fPriority').value, 10);
  const fdEl = $('fDifficulty');
  const difficulty = fdEl ? parseInt(fdEl.value, 10) : 3;
  const prefix = $('fPrefix').value;
  const workspace = $('fWorkspace').value;
  let creator = $('fCreator').value;
  if (creator === '__other__') creator = ($('fCreatorOther').value || '').trim() || '用户';
  if (!title) { toast('❌ 标题不能为空', false); $('fTitle').focus(); return; }
  if (!desc) { toast('❌ 描述不能为空', false); $('fDesc').focus(); return; }
  const btn = $('fSubmit');
  btn.disabled = true; btn.textContent = '创建中…';
  try {
    const d = await fetchJSON('/api/create', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, description: desc, priority, difficulty, prefix, created_by: creator, workspace })
    });
    closeCreateForm();
    toast('✅ 已创建任务 ' + d.task_id, true);
    lastSignature = '';
    await loadState(true);
  } catch (e) {
    toast('❌ 创建失败：' + e.message, false);
  } finally {
    btn.disabled = false; btn.textContent = '创建';
  }
}

// ─── 打分面板 ───
let currentScoreTask = null;
let currentScoreTaskStatus = 'completed'; // review → 提交时先通过审查再打分
function openScoreForm(taskId) {
  currentScoreTask = taskId;
  const t = (STATE && STATE.tasks || []).find(x => x.task_id === taskId);
  currentScoreTaskStatus = t && t.status === 'review' ? 'review' : 'completed';
  $('scoreTaskId').textContent = taskId;
  const dims = (CFG && CFG.scoring && CFG.scoring.dimensions) || [
    { key: 'completion', name: '完成度' }, { key: 'quality', name: '质量' },
    { key: 'verification', name: '验证' }, { key: 'record', name: '记录' }
  ];
  const minS = (CFG && CFG.scoring && CFG.scoring.min) || 1;
  const maxS = (CFG && CFG.scoring && CFG.scoring.max) || 4;
  const defaultVal = Math.min(3, maxS);
  const scaleLabels = [];
  for (let i = minS; i <= maxS; i++) scaleLabels.push(i);
  $('scoreDims').innerHTML = dims.map((d) => `
    <div class="score-dim">
      <div class="score-dim-head"><span class="name">${escHtml(d.name)}${d.hint ? ' <span style="font-weight:400;color:var(--text-faint)">' + escHtml(d.hint) + '</span>' : ''}</span><span class="val" id="sdv-${d.key}">${defaultVal}</span></div>
      <input type="range" class="score-slider" id="sds-${d.key}" min="${minS}" max="${maxS}" step="1" value="${defaultVal}" oninput="onScoreSlider('${d.key}')">
      <div class="score-scale">${scaleLabels.map(n => `<span>${n}</span>`).join('')}</div>
      <div class="score-bar-row"><span class="k"></span><div class="score-bar-track"><div class="score-bar-fill" id="sdb-${d.key}"></div></div><span class="v"></span></div>
    </div>`).join('');
  $('fScoreComment').value = '';
  updateScoreTotal();
  // opt-004: 四维可视化条初始化（进度条 + 分段刻度点亮）
  dims.forEach(d => {
    const v = parseInt(($('sds-' + d.key) || { value: defaultVal }).value, 10);
    paintScoreDim(d.key, v);
  });
  const hint = $('scoreHint');
  if (hint) hint.textContent = `评分维度 ${minS}-${maxS} 分，总分 = ${dims.length} 维平均。提交后可再次修改覆盖。`;
  $('scoreMask').classList.add('show');
  pauseAutoRefresh();
}
// opt-004: 维度色阶（1 红 / 2 橙 / 3 黄绿 / 4 绿）
function scoreBarColor(v, maxS) {
  const t = Math.max(0, Math.min(1, (v - 1) / Math.max(1, (maxS || 4) - 1)));
  const r = Math.round(201 - t * 145);   // 201 -> 56
  const g = Math.round(85 + t * 122);    // 85 -> 207
  const b = Math.round(85 + t * 23);     // 85 -> 108
  return 'rgb(' + r + ',' + g + ',' + b + ')';
}
// opt-004: 刷新某一维度的进度条与刻度高亮
function paintScoreDim(key, v) {
  const dims = (CFG && CFG.scoring && CFG.scoring.dimensions) || [
    { key: 'completion' }, { key: 'quality' }, { key: 'verification' }, { key: 'record' }
  ];
  const maxS = (CFG && CFG.scoring && CFG.scoring.max) || 4;
  const bar = $('sdb-' + key);
  if (bar) {
    bar.style.width = Math.round((v / maxS) * 100) + '%';
    bar.style.background = scoreBarColor(v, maxS);
  }
  const num = $('sdv-' + key);
  if (num) num.textContent = v;
  const scale = $('sds-' + key) ? $('sds-' + key).parentElement.querySelectorAll('.score-scale span') : [];
  scale.forEach((sp, i) => sp.classList.toggle('on', (i + 1) <= v));
}
function onScoreSlider(key) {
  const v = parseInt($('sds-' + key).value, 10);
  paintScoreDim(key, v);
  updateScoreTotal();
}
function updateScoreTotal() {
  const dims = (CFG && CFG.scoring && CFG.scoring.dimensions) || [
    { key: 'completion' }, { key: 'quality' }, { key: 'verification' }, { key: 'record' }
  ];
  const vals = dims.map(d => parseInt(($('sds-' + d.key) || { value: 3 }).value, 10));
  const total = (vals.reduce((a, b) => a + b, 0) / dims.length).toFixed(2);
  const el = $('scoreTotal');
  el.textContent = total;
  // opt-004: 总分实时着色
  el.style.color = total >= 3.8 ? 'var(--st-completed)' : (total >= 3.2 ? 'var(--st-pending)' : (total >= 1 ? 'var(--st-failed)' : ''));
}
function closeScoreForm() {
  $('scoreMask').classList.remove('show');
  currentScoreTask = null;
  resumeAutoRefresh();
}
async function submitScore() {
  if (!currentScoreTask) return;
  const dims = (CFG && CFG.scoring && CFG.scoring.dimensions) || [
    { key: 'completion' }, { key: 'quality' }, { key: 'verification' }, { key: 'record' }
  ];
  const payload = { task_id: currentScoreTask };
  dims.forEach(d => {
    const el = $('sds-' + d.key);
    payload[d.key] = el ? parseInt(el.value, 10) : 3;
  });
  const comment = $('fScoreComment').value.trim();
  if (comment) payload.comment = comment;
  try {
    let d;
    if (currentScoreTaskStatus === 'review') {
      // peer 审查：通过审查 + 打分 一步完成
      d = await fetchJSON('/api/worker/review', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          task_id: currentScoreTask, action: 'approve',
          score: { c: payload.completion, q: payload.quality, v: payload.verification, r: payload.record },
          comment: payload.comment || '', reviewer: '审查员'
        })
      });
      if (!d.ok) throw new Error(d.error || '审查失败');
      closeScoreForm();
      toast('✅ 审查通过 + 评分 ' + currentScoreTask + '：' + d.score_total + ' 分', true);
      lastSignature = '';
      await loadState(true);
      return;
    }
    d = await fetchJSON('/api/score', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    closeScoreForm();
    toast('✅ 已评分 ' + currentScoreTask + '：' + d.score_total + ' 分', true);
    // opt-004: 评分后立即生效——本地补丁卡片 DOM + 后台刷新（无需用户手动刷新）
    applyLocalScore(currentScoreTask, {
      score_total: d.score_total,
      completion: payload.completion, quality: payload.quality,
      verification: payload.verification, record: payload.record,
      comment: payload.comment
    });
    lastSignature = '';
    await loadState(true);
  } catch (e) { toast('❌ 评分失败：' + e.message, false); }
}

// peer 审查：打回（待审查任务）
async function reviewReject(taskId) {
  const reason = prompt('打回原因（将退回待领取，冒险者可重新领取执行）：', '');
  if (reason === null) return;
  try {
    const d = await fetchJSON('/api/worker/review', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_id: taskId, action: 'reject', reason: reason || '审查未通过', reviewer: '审查员' })
    });
    if (!d.ok) throw new Error(d.error || '打回失败');
    toast('↩️ 已打回 ' + taskId + '：' + (reason || '审查未通过'), true);
    lastSignature = '';
    await loadState(true);
  } catch (e) { toast('❌ 打回失败：' + e.message, false); }
}

// ─── 统计仪表盘 ───
function renderStats() {
  const d = STATE;
  if (!d) return;
  const sm = d.statMap || {};
  // 状态分布
  const order = [
    ['in_progress', '🔄 进行中', sm.in_progress || 0, '#4aa3ff'],
    ['pending', '⏳ 待领取', sm.pending || 0, '#f0a030'],
    ['completed', '✅ 已完成', sm.completed || 0, '#37c08a'],
    ['failed', '❌ 失败', sm.failed || 0, '#e05555']
  ];
  const max = Math.max(1, ...order.map(o => o[2]));
  $('dashStatus').innerHTML = order.map(o =>
    `<div class="bar-row"><span class="bar-label">${o[1]}</span><div class="bar-track"><div class="bar-fill" style="width:${(o[2] / max) * 100}%;background:${o[3]}"></div></div><span class="bar-num">${o[2]}</span></div>`).join('')
    + `<div class="bar-row" style="margin-top:8px"><span class="bar-label">📊 总任务</span><div class="bar-track"><div class="bar-fill" style="width:100%;background:linear-gradient(90deg,#b8962e,#e8c766)"></div></div><span class="bar-num">${d.total || 0}</span></div>`;

  // 每日完成趋势（近14天）
  const trendMap = {};
  (d.completedTrend || []).forEach(t => trendMap[t.d] = t.c);
  const days = [];
  const now = new Date();
  for (let i = 13; i >= 0; i--) {
    const dt = new Date(now.getTime() - i * 86400000);
    const key = dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
    days.push({ d: key.slice(5), c: trendMap[key] || 0 });
  }
  const tMax = Math.max(1, ...days.map(x => x.c));
  $('dashTrend').innerHTML = `<div class="trend-row">${days.map(x =>
    `<div class="trend-bar" style="height:${(x.c / tMax) * 100}%" data-label="${x.d}: ${x.c}"></div>`).join('')}</div>
    <div style="display:flex;justify-content:space-between;font-size:10px;color:#6f6a58;margin-top:6px"><span>14天前</span><span>今天</span></div>`;

  // 排行
  const mp = d.modelsPerPage || 10;
  $('dashRanking').innerHTML = (d.modelScores || []).slice(0, mp).length
    ? `<table class="model-table"><thead><tr><th>冒险者</th><th>完成/领取</th><th>完成率</th><th>均分</th><th>打回</th><th>擅长项目</th></tr></thead><tbody>${(d.modelScores || []).slice(0, mp).map(m => {
        const avg = parseFloat(m.avg_total);
        const cls = isNaN(avg) ? 'none' : (avg >= 3.8 ? 'good' : (avg >= 3.2 ? 'mid' : 'bad'));
        const rate = m.rate ?? 0;
        return `<tr><td class="model-name">${escHtml(m.assignee)}</td><td>${m.completed ?? m.cnt}<span class="dim">/${m.cnt ?? '—'}</span></td><td class="avg-score ${rate >= 80 ? 'good' : (rate >= 50 ? 'mid' : 'bad')}">${rate}%</td><td class="avg-score ${cls}">${isNaN(avg) ? '—' : m.avg_total}</td><td>${m.redo ?? 0}</td><td>${escHtml(m.top_project || '—')}</td></tr>`;
      }).join('')}</tbody></table>`
    : '<div class="set-note">暂无评分数据</div>';

  // 指标
  const scored = d.tasks.filter(t => t.score_total !== null && t.score_total !== '');
  const avgScore = scored.length ? (scored.reduce((a, t) => a + parseFloat(t.score_total), 0) / scored.length).toFixed(2) : '—';
  $('dashMetrics').innerHTML = `<div class="metric-card">
    <div class="metric"><span class="k">📊 总任务</span><span class="v">${d.total || 0}</span></div>
    <div class="metric"><span class="k">✅ 已完成</span><span class="v">${sm.completed || 0}</span></div>
    <div class="metric"><span class="k">🔄 重做</span><span class="v">${d.redoCount || 0}</span></div>
    <div class="metric"><span class="k">📉 打回率</span><span class="v">${(d.rejectRate || 0)}%</span></div>
    <div class="metric"><span class="k">⭐ 平均分</span><span class="v">${avgScore}</span></div>
    <div class="metric"><span class="k">🤖 执行AI</span><span class="v">${(d.modelScores || []).length}</span></div>
  </div>`;

  // ai-036: 加载巡查报告
  loadPatrolLog();
  // opt-005: 加载经验沉淀（最近决策）
  loadDecisions();
  // opt-006: 加载完成报表
  loadReports(REPORT_GRAN);
}

// ─── 完成报表（opt-006：趋势 周/月切换 + 执行人产能） ───
let REPORT_GRAN = 'day';   // 当前粒度：day | week | month
let REPORT_DATA = null;    // 缓存 /api/reports 数据

async function loadReports(gran) {
  REPORT_GRAN = gran || REPORT_GRAN;
  document.querySelectorAll('.trend-tab').forEach(b => b.classList.toggle('active', b.dataset.gran === REPORT_GRAN));
  const elTrend = $('dashReportTrend'), elAsg = $('dashAssignees');
  if (!elTrend) return;
  try {
    if (!REPORT_DATA || Date.now() - (REPORT_DATA._ts || 0) > 60000) {
      const r = await fetch('/api/reports').then(x => x.json());
      if (!r.ok) throw new Error(r.error || '加载失败');
      REPORT_DATA = r; REPORT_DATA._ts = Date.now();
    }
    renderReportTrend(elTrend, REPORT_DATA.trend || []);
    renderAssignees(elAsg, REPORT_DATA.assignees || []);
  } catch (e) {
    elTrend.innerHTML = `<div class="set-note">报表加载失败: ${escHtml(String(e.message || e))}</div>`;
  }
}

function switchReportGran(g) {
  loadReports(g); // 数据已缓存在 REPORT_DATA，仅切换渲染粒度
}

function renderReportTrend(el, trend) {
  // trend: [{d:'YYYY-MM-DD', c:n}] 按天；按粒度聚合
  const buckets = new Map();
  if (REPORT_GRAN === 'day') {
    // 近14天，补零
    const tmap = {}; trend.forEach(t => tmap[t.d] = t.c);
    const now = new Date();
    for (let i = 13; i >= 0; i--) {
      const dt = new Date(now.getTime() - i * 86400000);
      const k = dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
      buckets.set(k.slice(5), tmap[k] || 0);
    }
  } else if (REPORT_GRAN === 'week') {
    // 近12周（按周一所在周聚合）
    const tmap = {}; trend.forEach(t => tmap[t.d] = t.c);
    const now = new Date();
    for (let i = 11; i >= 0; i--) {
      const base = new Date(now.getTime() - i * 7 * 86400000);
      const dow = (base.getDay() + 6) % 7; // 周一=0
      const mon = new Date(base.getTime() - dow * 86400000);
      const wk = 'W' + String(isoWeek(mon)).padStart(2, '0');
      const wkStart = mon.getFullYear() + '-' + String(mon.getMonth() + 1).padStart(2, '0') + '-' + String(mon.getDate()).padStart(2, '0');
      let c = 0;
      for (let j = 0; j < 7; j++) {
        const dt = new Date(mon.getTime() + j * 86400000);
        const k = dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
        c += tmap[k] || 0;
      }
      buckets.set(wkStart.slice(5) + ' ' + wk, c);
    }
  } else {
    // 近12个月
    const tmap = {}; trend.forEach(t => tmap[t.d] = t.c);
    const now = new Date();
    for (let i = 11; i >= 0; i--) {
      const dt = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const k = dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0');
      buckets.set(k, tmap[k] || 0);
    }
  }
  const keys = [...buckets.keys()], vals = [...buckets.values()];
  const max = Math.max(1, ...vals);
  el.innerHTML = `<div class="trend-row">${keys.map((k, i) =>
    `<div class="trend-bar" style="height:${(vals[i] / max) * 100}%" data-label="${k}: ${vals[i]}"></div>`).join('')}</div>
    <div style="display:flex;justify-content:space-between;font-size:10px;color:#6f6a58;margin-top:6px"><span>${escHtml(keys[0] || '')}</span><span>${escHtml(keys[keys.length - 1] || '')}</span></div>`;
}

function isoWeek(d) {
  const dt = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  return Math.ceil((((dt - yearStart) / 86400000) + 1) / 7);
}

function renderAssignees(el, rows) {
  if (!el) return;
  if (!rows.length) { el.innerHTML = '<div class="set-note">暂无执行人数据</div>'; return; }
  const max = Math.max(1, ...rows.map(r => r.completed || 0));
  el.innerHTML = '<div class="panel-title" style="font-size:12px;margin-bottom:8px">👷 执行人产能对比（完成量 · 近20名）</div>'
    + rows.map(r => {
      const done = r.completed || 0, ip = r.in_progress || 0, fd = r.failed || 0;
      return `<div class="assignee-row"><span class="assignee-name" title="${escHtml(r.assignee)}">${escHtml(r.assignee)}</span>`
        + `<div class="bar-track"><div class="bar-fill" style="width:${(done / max) * 100}%;background:var(--accent)"></div></div>`
        + `<span class="assignee-nums">✅${done} 🔄${ip} ❌${fd} · 共${r.total}</span></div>`;
    }).join('');
}

// ─── 经验沉淀（opt-005：本地共享记忆库最近决策，统计页展示） ───
async function loadDecisions() {
  const el = $('dashDecisions');
  if (!el) return;
  try {
    const r = await fetch('/api/memory/decisions?limit=12');
    const d = await r.json();
    if (!d.ok) throw new Error(d.error || '加载失败');
    if (!d.sharedAvailable) {
      el.innerHTML = '<div class="set-note">本地共享记忆库未配置（SHARED_MEMORY_DIR），决策沉淀已停用</div>';
      return;
    }
    if (!(d.rows || []).length) {
      el.innerHTML = '<div class="set-note">还没有决策记录——打回 / 重置 / 取消 / 评分任务后会自动沉淀到这里</div>';
      return;
    }
    const kindColor = {
      '打回': '#e05555', '重置': '#f0a030', '取消': '#8a8a8a',
      '评分': '#b8962e', '审查通过': '#37c08a', '审查通过+评分': '#37c08a', '失败': '#c06060'
    };
    el.innerHTML = '<table class="model-table"><thead><tr><th>时间</th><th>决策</th><th>任务</th><th>详情</th><th>决策者</th></tr></thead><tbody>'
      + d.rows.map(x => {
        const m = (x.title || '').match(/^【决策(?:·(.+?))?】(.+)$/);
        const kind = m && m[1] ? m[1] : '决策';
        const rest = m ? m[2] : (x.title || '');
        // 新格式第二段是任务ID；旧格式（【决策】标题）第二段是摘要，任务列留空
        const isTaskId = /^(quest|ai|opt|fix|tool|zhaoxi|gGuild|g\d+)-/.test(rest);
        const taskId = isTaskId ? rest : '—';
        const detail = isTaskId ? (x.content || '').replace(/（决策者：.*$/, '') : rest + '：' + (x.content || '').replace(/（决策者：.*$/, '');
        const color = kindColor[kind] || '#4aa3ff';
        return `<tr><td style="white-space:nowrap;color:#6f6a58;font-size:11px">${escHtml((x.created_at || '').slice(5, 16))}</td>`
          + `<td><span style="background:${color};color:#fff;border-radius:8px;padding:1px 8px;font-size:11px;white-space:nowrap">${escHtml(kind)}</span></td>`
          + `<td style="white-space:nowrap;font-weight:bold">${escHtml(taskId)}</td>`
          + `<td style="max-width:420px;word-break:break-word">${escHtml(detail)}</td>`
          + `<td style="white-space:nowrap;font-size:11px;color:#6f6a58">${escHtml((x.content || '').match(/决策者：(.+?)；/)?.[1] || '—')}</td></tr>`;
      }).join('') + '</tbody></table>';
  } catch (e) {
    el.innerHTML = `<div class="set-note">决策记录加载失败：${escHtml(String(e.message || e))}</div>`;
  }
}

// ─── 公会排行榜（g003-008：冒险者按完成数与均分排名，总榜/本周/本月） ───
let RANK_PERIOD = 'all';
function switchRankPeriod(period) {
  RANK_PERIOD = period || 'all';
  document.querySelectorAll('.rank-btn').forEach(b => b.classList.toggle('active', b.id === ('rank' + period[0].toUpperCase() + period.slice(1))));
  renderGuildRanking();
}
function renderGuildRanking() {
  const el = $('guildRanking');
  if (!el) return;
  const rows = (STATE && STATE.modelScores || []).slice();
  if (!rows.length) { el.innerHTML = '<div class="set-note">暂无冒险者数据</div>'; return; }
  // 本周/本月按最近完成时间过滤（久未活跃的不上榜）
  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekStart = new Date(dayStart); weekStart.setDate(dayStart.getDate() - (dayStart.getDay() || 7) + 1);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const cutoff = RANK_PERIOD === 'week' ? weekStart : RANK_PERIOD === 'month' ? monthStart : null;
  const filtered = cutoff
    ? rows.filter(r => { const d = r.last_at ? new Date(String(r.last_at).replace(/-/g, '/')) : null; return d && d >= cutoff; })
    : rows;
  if (!filtered.length) { el.innerHTML = `<div class="set-note">${RANK_PERIOD === 'week' ? '本周' : RANK_PERIOD === 'month' ? '本月' : ''}暂无上榜冒险者</div>`; return; }
  filtered.sort((a, b) => (b.completed || 0) - (a.completed || 0) || (b.avg_total || 0) - (a.avg_total || 0));
  const medal = ['🥇', '🥈', '🥉'];
  el.innerHTML = `<table class="rank-table"><thead><tr><th>#</th><th>冒险者</th><th>完成</th><th>完成率</th><th>均分</th></tr></thead><tbody>` +
    filtered.slice(0, 10).map((m, i) => {
      const avg = parseFloat(m.avg_total);
      const avgCls = isNaN(avg) ? 'none' : (avg >= 3.8 ? 'good' : (avg >= 3.2 ? 'mid' : 'bad'));
      return `<tr><td class="rank-no">${medal[i] || (i + 1)}</td><td class="model-name">${escHtml(m.assignee)}</td>
        <td>${m.completed ?? m.cnt ?? 0}</td><td>${m.rate ?? 0}%</td>
        <td class="avg-score ${avgCls}">${isNaN(avg) ? '—' : m.avg_total}</td></tr>`;
    }).join('') + `</tbody></table>`;
}

// ai-036: 巡查日志
const PATROL_LOG_URL = '/patrol_log.json';
let PATROL_TIMER = null;
async function loadPatrolLog() {
  try {
    const resp = await fetch(PATROL_LOG_URL, { cache: 'no-store' });
    if (!resp.ok) {
      $('dashPatrol').innerHTML = '<div class="set-note">暂无巡查记录（巡查员尚未运行）</div>';
      $('patrolTime').textContent = '';
      return;
    }
    const logs = await resp.json();
    if (!Array.isArray(logs) || logs.length === 0) {
      $('dashPatrol').innerHTML = '<div class="set-note">暂无巡查记录</div>';
      $('patrolTime').textContent = '';
      return;
    }
    // 最新的在前
    const sorted = [...logs].reverse();
    const latest = sorted[0];
    $('patrolTime').textContent = '最近：' + (latest.time || '—');
    // 展示最近5条
    const html = sorted.slice(0, 5).map(entry => {
      const issues = (entry.issues || []).map(i => `<div class="patrol-issue">⚠️ ${escHtml(i)}</div>`).join('');
      const actions = (entry.actions || []).map(a => {
        const stColor = a.status === 'completed' ? '#37c08a' : (a.status === 'in_progress' ? '#4aa3ff' : (a.status === 'failed' ? '#e05555' : '#f0a030'));
        return `<div class="patrol-action">📌 <span class="mono">${escHtml(a.task_id || '—')}</span> ${escHtml(a.action || '')} <span style="color:${stColor}">[${escHtml(a.status || '—')}]</span></div>`;
      }).join('');
      return `<div class="patrol-entry">
        <div class="patrol-time">🕐 ${escHtml(entry.time || '—')}</div>
        ${entry.summary ? `<div class="patrol-summary">${escHtml(entry.summary)}</div>` : ''}
        ${issues}
        ${actions}
      </div>`;
    }).join('');
    $('dashPatrol').innerHTML = html || '<div class="set-note">暂无巡查记录</div>';
  } catch (e) {
    $('dashPatrol').innerHTML = '<div class="set-note">巡查日志加载失败（' + escHtml(e.message) + '）</div>';
  }
}

function startPatrolRefresh() {
  if (PATROL_TIMER) clearInterval(PATROL_TIMER);
  PATROL_TIMER = setInterval(() => {
    if ($('viewStats').style.display !== 'none') loadPatrolLog();
  }, 45000);
}

// ─── 设置页 ───
async function loadConfig() {
  try {
    const d = await fetchJSON('/api/config');
    CFG = d;
    renderSettings();
  } catch (e) {
    toast('加载配置失败：' + e.message, false);
  }
}
function kvHtml(pairs) {
  return pairs.map(p => `<div class="set-line"><span class="k">${p[0]}</span><span class="v">${escHtml(String(p[1] ?? ''))}</span></div>`).join('');
}
function renderSettings() {
  const c = CFG;
  if (!c) return;
  // 产品信息（只读）
  $('setApp').innerHTML = kvHtml([
    ['产品名', c.app.name],
    ['页面标题', c.app.title],
    ['数据目录', c.dataDir],
    ['配置文件', c.configFile]
  ]);
  // 服务配置（可编辑）
  $('setServer').innerHTML = `
    ${setInput('端口', 'cfg-port', c.server.port, 'number')}
    ${setInput('刷新间隔(ms)', 'cfg-refresh', c.server.refreshMs, 'number')}
    ${setInput('已完成分页', 'cfg-completedPage', c.server.completedPerPage, 'number')}
    ${setInput('排行分页', 'cfg-modelsPage', c.server.modelsPerPage, 'number')}
  `;
  // 任务配置（可编辑）
  $('setTasks').innerHTML = `
    ${setInput('默认ID前缀', 'cfg-prefix', c.tasks.defaultPrefix, 'text')}
    ${setInput('可选前缀(逗号分隔)', 'cfg-prefixes', (c.tasks.allowedPrefixes || []).join(','), 'text')}
    ${setInput('默认创建人', 'cfg-creator', c.tasks.createdByDefault, 'text')}
    ${setInput('创建人选项(逗号分隔)', 'cfg-creators', (c.tasks.creatorOptions || []).join(','), 'text')}
  `;
  // 评分体系（可编辑）
  const dims = (c.scoring && c.scoring.dimensions) || [];
  const dimInputs = dims.map((d, i) =>
    `<div class="set-line"><span class="k">维度${i + 1}（${d.key}）</span><input class="set-input" id="cfg-dim-${d.key}" value="${escAttr(d.name)}"></div>`
  ).join('');
  $('setScoring').innerHTML = dimInputs + `
    ${setInput('最低分', 'cfg-scoreMin', c.scoring.min, 'number')}
    ${setInput('最高分', 'cfg-scoreMax', c.scoring.max, 'number')}
    <div class="set-note">修改后点击下方「保存设置」，重启服务生效。</div>
  `;
}
function setInput(label, id, value, type) {
  return `<div class="set-line"><span class="k">${label}</span><input class="set-input" id="${id}" type="${type}" value="${escAttr(String(value ?? ''))}"></div>`;
}
function escAttr(s) { return String(s).replace(/"/g, '&quot;').replace(/</g, '&lt;'); }

async function saveSettings() {
  const payload = {
    server: {
      port: parseInt($('cfg-port').value, 10),
      refreshMs: parseInt($('cfg-refresh').value, 10),
      completedPerPage: parseInt($('cfg-completedPage').value, 10),
      modelsPerPage: parseInt($('cfg-modelsPage').value, 10)
    },
    tasks: {
      defaultPrefix: $('cfg-prefix').value.trim(),
      allowedPrefixes: $('cfg-prefixes').value.split(',').map(s => s.trim()).filter(Boolean),
      createdByDefault: $('cfg-creator').value.trim(),
      creatorOptions: $('cfg-creators').value.split(',').map(s => s.trim()).filter(Boolean)
    },
    scoring: {
      dimensions: ((CFG && CFG.scoring && CFG.scoring.dimensions) || []).map(d => ({
        key: d.key,
        name: ($('cfg-dim-' + d.key) || {}).value || d.name
      })),
      min: parseInt($('cfg-scoreMin').value, 10),
      max: parseInt($('cfg-scoreMax').value, 10)
    }
  };
  try {
    const d = await fetchJSON('/api/config', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    toast('✅ ' + (d.message || '设置已保存'), true);
  } catch (e) { toast('❌ 保存失败：' + e.message, false); }
}

// ─── 初始化 ───
async function init() {
  try {
    CFG = await fetchJSON('/api/config');
  } catch (e) { console.warn('配置加载失败', e); }
  if (CFG) renderSettings();
  // 填充新建表单选项
  if (CFG) {
    $('fPrefix').innerHTML = (CFG.tasks.allowedPrefixes || ['quest']).map(p => `<option value="${escHtml(p)}">${escHtml(p)}</option>`).join('');
    $('fCreator').innerHTML = (CFG.tasks.creatorOptions || []).map(c => `<option value="${escHtml(c)}">${escHtml(c)}</option>`).join('')
      + '<option value="__other__">其他（手填）</option>';
    const def = (CFG.tasks.defaultPrefix) || 'quest';
    $('fPrefix').value = def;
    $('fCreator').value = CFG.tasks.createdByDefault || '公会会长';
  }
  // 工作区下拉初始由 /api/state 提供
  await loadState(true);
  // opt-015: 项目列表动态加载（下拉 + 设置面板）
  loadProjects().catch(() => {});
  $('footDataDir').textContent = '数据目录：' + ((CFG && CFG.dataDir) || '—');
  $('footPort').textContent = '端口：' + ((CFG && CFG.server && CFG.server.port) || '—');
  $('footer').textContent = (CFG && CFG.app && CFG.app.footer) || '冒险公会任务看板';
  startAutoRefresh();
  startPatrolRefresh();  // ai-036: 巡查日志定时刷新
  refreshMembers();      // opt-022: 公会管理层职务表（轮询刷新时也会随 renderFilterChips 重渲染）
  setInterval(refreshMembers, (STATE && STATE.refreshMs) || 30000); // opt-022: 与看板同频刷新积分
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if ($('createMask').classList.contains('show')) closeCreateForm();
    if ($('scoreMask').classList.contains('show')) closeScoreForm();
    if ($('drawerMask').classList.contains('show')) closeDrawer();
  }
});

let MEMBERS_DATA = []; // opt-022: 公会管理层职务表数据（必须在init()之前声明，避免暂时性死区）

init();


/* ============================================================
   opt-022: 公会管理层职务表（总会长 + 执事）
   数据：GET /api/members（config guild.chiefLeader + projects.leader + agents 积分）
   联动：点击成员 → filterByAssignee 筛选该执行人任务
   ============================================================ */

function refreshMembers() {
  fetch('/api/members').then(r => r.json()).then(j => {
    if (!j || !j.ok) return;
    MEMBERS_DATA = j.members || [];
    renderMemberTable();
  }).catch(() => { /* 接口异常时职务表静默隐藏，不影响看板 */ });
}

// ─── opt-031: 反馈系统（收件箱内嵌首页 + 弹窗仅提交）───
let FB_VIEW_ROLE = '';          // 收件箱查看角色（''=工会总会长），localStorage 持久化
let FB_FILTER = 'all';          // 旧弹窗过滤保留字段（未用，兼容）
let FB_UNFINISHED = [];         // 待处理反馈（unread/read）
let FB_DONE = [];               // 已解决反馈（resolved）
let FB_DONE_EXPANDED = false;   // 已解决区域是否展开
let FB_UNFINISHED_PAGE = 1;     // 待处理反馈当前页码
let FB_DONE_PAGE = 1;           // 已解决反馈当前页码
const FB_PAGE_SIZE = 10;        // 每页显示数量
let FB_LIST = [];               // 兼容字段

// 反馈对象选项（总会长 + 各执事/项目，动态）——弹窗提交 & 收件箱角色下拉共用
function fbTargetOptions() {
  const opts = [{ v: '工会总会长', l: '👑 工会总会长' }];
  if (typeof PROJECT_DB !== 'undefined' && Array.isArray(PROJECT_DB)) {
    for (const pj of PROJECT_DB) {
      if (pj.leader && String(pj.leader).trim()) opts.push({ v: String(pj.leader).trim(), l: '🏛️ ' + (pj.name || pj.key) + '执事（' + pj.leader + '）' });
      else opts.push({ v: pj.name || pj.key, l: '📁 ' + (pj.name || pj.key) + '项目' });
    }
  }
  return opts;
}
// 反馈对象角色显示（收件箱视角的“反馈人角色”直接来自 from_role）
const fbRoleTag = r => ({ adventurer: '⚔️ 冒险者', leader: '🏛️ 执事', chief: '👑 总会长' })[r] || '';
// 弹窗打开（仅提交）
async function openFeedback() {
  const m = $('feedbackMask'); if (!m) return;
  m.classList.add('show');
  pauseAutoRefresh();
  try { const u = localStorage.getItem('ag_fb_user'); if (u && $('fbFromWhom')) $('fbFromWhom').value = u; } catch (e) {}
  try {
    const r = await fetchJSON('/api/projects');
    if (r && r.ok && Array.isArray(r.projects)) PROJECT_DB = r.projects;
  } catch (e) {}
  const sel = $('fbToWhom');
  if (sel) {
    const cur = sel.value;
    sel.innerHTML = fbTargetOptions().map(o2 => '<option value="' + escHtml(o2.v) + '">' + escHtml(o2.l) + '</option>').join('');
    if (cur && [...sel.options].some(opt => opt.value === cur)) sel.value = cur;
  }
}
function closeFeedback() {
  const m = $('feedbackMask'); if (m) m.classList.remove('show');
  resumeAutoRefresh();
}
// 提交反馈
async function submitFeedback() {
  const content = $('fbContent').value.trim();
  const fromWhom = $('fbFromWhom').value.trim();
  if (!content) return toast('请填写反馈内容', false);
  if (!fromWhom) return toast('请填写你的名字', false);
  try { localStorage.setItem('ag_fb_user', fromWhom); } catch (e) {}
  const payload = {
    from_whom: fromWhom,
    from_role: $('fbFromRole').value,
    to_whom: $('fbToWhom').value,
    category: $('fbCategory').value,
    content,
    task_id: $('fbTaskId').value.trim() || undefined
  };
  try {
    const r = await fetchJSON('/api/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (r && r.ok) {
      toast('✅ 反馈已提交给 ' + payload.to_whom, true);
      $('fbContent').value = ''; $('fbTaskId').value = '';
      closeFeedback();
      loadFbBoard(); // 首页同步刷新（若自己就是收件人）
    } else toast('提交失败：' + ((r && r.error) || '未知'), false);
  } catch (e) { toast('提交失败：' + e.message, false); }
}
// 收件箱查看角色（持久化 + 下拉选项）
function fbViewRoleValue() { return FB_VIEW_ROLE || '工会总会长'; }
function setFbViewRole(v) {
  FB_VIEW_ROLE = v || '工会总会长';
  try { localStorage.setItem('ag_fb_view_role', FB_VIEW_ROLE); } catch (e) {}
  const sel = $('fbBoardRole'); if (sel) sel.value = FB_VIEW_ROLE;
  refreshFbCounts(); // 未读数/已完成数
  loadFbBoard();
}
// ========== 首页反馈分区渲染 ==========
function fbBoardSection(who) {
  const w = who || '工会总会长';
  const unList = FB_UNFINISHED.filter(f => f.to_whom === w);
  const dnList = FB_DONE.filter(f => f.to_whom === w);
  const un = unList.length;
  const dn = dnList.length;
  const unreadN = unList.filter(f => f.status === 'unread').length;
  // 待处理翻页
  const unTotalPages = Math.max(1, Math.ceil(un / FB_PAGE_SIZE));
  if (FB_UNFINISHED_PAGE > unTotalPages) FB_UNFINISHED_PAGE = unTotalPages;
  const unStart = (FB_UNFINISHED_PAGE - 1) * FB_PAGE_SIZE;
  const unPageList = unList.slice(unStart, unStart + FB_PAGE_SIZE);
  // 已解决翻页
  const dnTotalPages = Math.max(1, Math.ceil(dn / FB_PAGE_SIZE));
  if (FB_DONE_PAGE > dnTotalPages) FB_DONE_PAGE = dnTotalPages;
  const dnStart = (FB_DONE_PAGE - 1) * FB_PAGE_SIZE;
  const dnPageList = dnList.slice(dnStart, dnStart + FB_PAGE_SIZE);
  const doneBox = FB_DONE_EXPANDED
    ? '<div class="fb-done-list">' + fbItemsHtml(dnPageList, true) + fbPaginationHtml('done', dn, dnTotalPages, FB_DONE_PAGE) + '</div>'
    : '';
  const hasRole = FB_VIEW_ROLE || '';
  const roleSel = '<select class="fb-role-sel" id="fbBoardRole" onchange="setFbViewRole(this.value)" title="查看谁的反馈">'
    + fbTargetOptions().map(ro => '<option value="' + escHtml(ro.v) + '"' + (ro.v === w ? ' selected' : '') + '>' + escHtml(ro.l) + '</option>').join('') + '</select>';
  return '<div class="section fb-board-section" id="fbBoardSection" data-noncard="1">'
    + '<div class="section-title fb-board-title">📬 反馈收件箱 <span class="count fb-count" id="fbBoardCount" style="background:#ef4444;color:#fff">' + (unreadN || '') + '</span>'
    + '<span class="fb-role-wrap">' + roleSel + '</span>'
    + '<span class="fb-refresh" onclick="loadFbBoard(true)" title="刷新反馈">🔄</span></div>'
    + '<div class="fb-board-sub">未读 ' + unreadN + ' · 待处理 ' + un + ' · 已解决 ' + dn + ' · 查看角色：' + escHtml(w) + '</div>'
    + '<div class="fb-board-body">'
    + '<div class="fb-board-group-title">待处理（' + un + '）</div>'
    + '<div id="fbBoardUnfinList">' + fbItemsHtml(unPageList, false) + fbPaginationHtml('un', un, unTotalPages, FB_UNFINISHED_PAGE) + '</div>'
    + '<div class="fb-done-head' + (FB_DONE_EXPANDED ? ' open' : '') + '" onclick="toggleFbDone()">已解决（' + dn + '）<span class="fb-caret">' + (FB_DONE_EXPANDED ? '▾' : '▸') + '</span></div>'
    + doneBox
    + '</div></div>';
}
// 翻页控件HTML
function fbPaginationHtml(type, total, totalPages, curPage) {
  if (total <= FB_PAGE_SIZE) return '';
  let html = '<div class="fb-pagination">';
  html += '<span class="fb-page-info">第 ' + curPage + '/' + totalPages + ' 页（共' + total + '条）</span>';
  html += '<div class="fb-page-btns">';
  html += '<button class="fb-page-btn" onclick="fbGoPage(\'' + type + '\',' + (curPage - 1) + ')"' + (curPage <= 1 ? ' disabled' : '') + '>上一页</button>';
  for (let i = 1; i <= totalPages; i++) {
    if (i === 1 || i === totalPages || Math.abs(i - curPage) <= 1) {
      html += '<button class="fb-page-btn' + (i === curPage ? ' active' : '') + '" onclick="fbGoPage(\'' + type + '\',' + i + ')">' + i + '</button>';
    } else if (Math.abs(i - curPage) === 2) {
      html += '<span class="fb-page-ellipsis">...</span>';
    }
  }
  html += '<button class="fb-page-btn" onclick="fbGoPage(\'' + type + '\',' + (curPage + 1) + ')"' + (curPage >= totalPages ? ' disabled' : '') + '>下一页</button>';
  html += '</div></div>';
  return html;
}
// 翻页
function fbGoPage(type, page) {
  if (type === 'un') FB_UNFINISHED_PAGE = Math.max(1, page);
  else FB_DONE_PAGE = Math.max(1, page);
  renderFbBoardOnly();
}
function fbItemsHtml(list, isDone) {
  if (!list.length) return '<div class="fb-empty fb-sec-empty">暂无反馈</div>';
  const stMap = { unread: '<span class="fb-st unread">未读</span>', read: '<span class="fb-st read">已读</span>', resolved: '<span class="fb-st resolved">已解决</span>' };
  return list.map(f => {
    const act = (!isDone && f.status !== 'resolved')
      ? `<span class="fb-actions">${f.status === 'unread' ? `<button class="fb-act" onclick="markFb('${f.id}','read')">标记已读</button>` : ''}<button class="fb-act primary" onclick="markFb('${f.id}','resolve')">✓ 解决</button></span>`
      : (f.status === 'resolved' ? '<span class="fb-resolved-line">✓ 已于 ' + escHtml(f.resolved_at || '') + ' 解决</span>' : '');
    const statusClass = f.status === 'unread' ? 'unread' : (f.status === 'read' ? 'read' : 'resolved');
    return '<div class="fb-item fb-card ' + statusClass + '">'
      + '<div class="fb-item-top"><span class="fb-cat">' + escHtml(f.category) + '</span>' + (stMap[f.status] || '')
      + '<span class="fb-who">' + fbRoleTag(f.from_role) + ' ' + escHtml(f.from_whom) + '</span>'
      + (f.task_id ? '<span class="fb-task">#' + escHtml(f.task_id) + '</span>' : '')
      + '<span class="fb-time">' + escHtml(f.created_at || '') + '</span></div>'
      + '<div class="fb-content fb-summary">' + escHtml(f.content) + '</div>' + act + '</div>';
  }).join('');
}
// 数据加载：拉全部（limit=100），按角色前端分流，待处理/已解决分组
async function loadFbBoard(manual) {
  try {
    const r = await fetchJSON('/api/feedback?limit=100');
    if (!r || !r.ok) return;
    FB_UNFINISHED = (r.list || []).filter(f => f.status !== 'resolved');
    FB_DONE = (r.list || []).filter(f => f.status === 'resolved');
    const w = fbViewRoleValue();
    const sec = $('fbBoardSection');
    if (sec) sec.outerHTML = fbBoardSection(w); // 重建（含当前角色选中态）
    refreshFbCounts();
  } catch (e) { /* 静默：加载失败不影响任务列表 */ }
}
// 展开/收起已解决
function toggleFbDone() { FB_DONE_EXPANDED = !FB_DONE_EXPANDED; renderFbBoardOnly(); }
// 仅重渲染反馈区（操作后刷新，不重渲染全列表）
function renderFbBoardOnly() {
  const sec = $('fbBoardSection');
  if (sec) sec.outerHTML = fbBoardSection(fbViewRoleValue());
  refreshFbCounts();
}
// 未读数/待处理数/已解决数（标题徽标）
async function refreshFbCounts() {
  const w = fbViewRoleValue();
  const b = $('fbBoardCount');
  if (b) {
    const un = FB_UNFINISHED.filter(f => f.to_whom === w && f.status === 'unread').length;
    b.textContent = un || '';
    b.style.display = un ? 'inline-block' : 'none';
  }
  const un2 = FB_UNFINISHED.filter(f => f.to_whom === w).length;
  const dn = FB_DONE.filter(f => f.to_whom === w).length;
  const sub = $('fbBoardSub');
  if (sub) sub.textContent = '未读 ' + (FB_UNFINISHED.filter(f => f.to_whom === w && f.status === 'unread').length) + ' · 待处理 ' + un2 + ' · 已解决 ' + dn + ' · 查看角色：' + escHtml(w);
}
// 标记已读 / 已解决
async function markFb(id, action) {
  try {
    const r = await fetchJSON('/api/feedback/' + id + '/' + action, { method: 'POST' });
    if (r && r.ok) {
      toast(action === 'read' ? '已标记已读' : '✅ 已标记解决', true);
      loadFbBoard(); // 服务端状态已变，整区重拉（含未读数）
    } else toast('操作失败：' + ((r && r.error) || '未知'), false);
  } catch (e) { toast('操作失败：' + e.message, false); }
}
// 首页自动刷新同步（loadState 里调用；静态方法，避免未定义）
async function syncFbBoard() {
  if (!$('fbBoardSection')) return;
  loadFbBoard();
}
function renderMemberTable() {
  const af = $('assigneeFilter');
  if (!af) return;
  if (!MEMBERS_DATA.length) { af.innerHTML = ''; return; }
  const roleTag = m => m.role === 'chief'
    ? '<span class="role-tag chief" title="总会长">👑 总会长</span>'
    : `<span class="role-tag vice" title="执事 · 负责项目">🏛️ 执事 · ${escHtml(m.project || '—')}</span>`;
  af.innerHTML = `<div class="member-table" id="memberTable">` + MEMBERS_DATA.map(m => `
    <span class="member-row${currentAssignee === m.name ? ' active' : ''}" data-assignee="${escHtml(m.name)}" onclick="filterByAssignee('${escHtml(m.name)}')" title="点击筛选该管理者的任务">
      <span class="dot" style="background:${assigneeColor(m.name)}"></span>
      <span class="member-name">${escHtml(m.name)}</span>
      ${roleTag(m)}
      <span class="member-rpg" title="等级 · 金币 · 完成数">Lv.${m.level ?? 0} · ${m.coins ?? 0}💰 · ✓${m.completed ?? 0}</span>
    </span>`).join('') + `</div>`;
}
