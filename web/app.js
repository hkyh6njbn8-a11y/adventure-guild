/* ============================================================
   冒险公会：任务看板 — 前端应用逻辑（Phase 2）
   职责：拉取 /api/state 渲染看板；筛选/分页/工作区/详情/打分/统计/设置；自动刷新
   ============================================================ */
'use strict';

// ─── 全局状态 ───
let STATE = null;                 // 最近一次 /api/state
let CFG = null;                   // /api/config
let CURRENT_WORKSPACE = 'all';       // 工作区（数据层，历史兼容）
let CURRENT_PROJECT = 'all';         // 项目（查看层，全数据隔离：zhaoxi/guild/tool/zaima/other/all）
let currentStatus = 'all';
let currentAssignee = '';
let currentCreator = '';
let completedPage = 1;
let modelPage = 1;
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
         <span class="assignee-name">${escHtml(t.assignee)}</span></div>`
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
       data-assignee="${escHtml(t.assignee || '')}" data-creator="${escHtml(creator)}" data-redo="${t.is_redo}" data-task-id="${escHtml(t.task_id)}"
       onclick="openTaskDetail('${escHtml(t.task_id)}')">
    <div class="task-header">
      <span class="task-id">${escHtml(t.task_id)}</span>
      <span class="creator-tag${(t.created_by||'').trim()?'':' creator-unknown'}" title="创建人：${escHtml(creator)}" onclick="event.stopPropagation();filterByCreator('${escHtml(creator)}')">👤 ${escHtml(creator)}</span>
      <span class="task-priority" style="color:${PRIORITY_COLOR[t.priority]}">●${PRIORITY_LABEL[t.priority] || '?'}</span>
      ${isRedo ? '<span class="redo-tag">🔄重做</span>' : ''}
      ${otTag}
      ${scoreBadge(t.score_total)}
      <span class="task-status" style="background:${STATUS_COLOR[t.status]}">${STATUS_LABEL[t.status] || t.status}</span>
      ${resetBtn}
    </div>
    <div class="task-title">${escHtml(title)}</div>
    ${assigneeHtml}
    ${t.description ? `<div class="task-desc">${escHtml(t.description.substring(0, 150))}${t.description.length > 150 ? '…' : ''}</div>` : ''}
    ${t.result ? `<div class="task-result">📋 ${escHtml(t.result.substring(0, 120).replace(/\n/g, ' '))}${t.result.length > 120 ? '…' : ''}</div>` : ''}
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
  const rejectedBy = t.rejected_by || '总指挥';
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
  return `<div class="task-card redo-card" data-status="redo" data-assignee="${escHtml(reworkedBy)}" data-creator="${escHtml(rCreator)}" data-redo="true" data-task-id="${escHtml(t.task_id)}" onclick="openTaskDetail('${escHtml(t.task_id)}')">
    <div class="task-header">
      <span class="task-id">${escHtml(t.task_id)}</span>
      <span class="creator-tag${(t.created_by||'').trim()?'':' creator-unknown'}" title="创建人：${escHtml(rCreator)}" onclick="event.stopPropagation();filterByCreator('${escHtml(rCreator)}')">👤 ${escHtml(rCreator)}</span>
      <span class="redo-tag">🔄重做</span>
      <span class="task-status" style="background:${STATUS_COLOR[t.status] || '#a06bd0'}">${STATUS_LABEL[t.status] || t.status}</span>
    </div>
    <div class="task-title">${escHtml(title)}</div>
    <div class="timeline">${steps.join('')}</div>
    ${t.result ? `<div class="task-result">📋 ${escHtml(t.result.substring(0, 100).replace(/\n/g, ' '))}${t.result.length > 100 ? '…' : ''}</div>` : ''}
  </div>`;
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
    ['cancelled', '🚫 已取消', sm.cancelled || 0, '#8a9bb0', "filterByStatus('cancelled')"],
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
  COMPLETED_DATA = groups.completed;
  MODEL_DATA = d.modelScores || [];
  const redoTasks = d.tasks.filter(t => t.is_redo);

  // 各分区 HTML
  let html = '';
  const section = (title, list, renderer) => list.length
    ? `<div class="section" data-section="${title}"><div class="section-title">${title} <span class="count">${list.length}</span></div><div class="task-grid">${list.map(renderer).join('')}</div></div>` : '';
  html += section('🔄 进行中', groups.in_progress, taskCard);
  html += section('⏳ 待领取', groups.pending, taskCard);
  html += section('🔍 待审查（peer review：通过或打回）', groups.review, taskCard);
  html += section('❌ 失败', groups.failed, taskCard);
  html += section('🚫 已取消', groups.cancelled, taskCard);
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

  // 执行AI排行
  const mp = d.modelsPerPage || 10;
  const modelPages = Math.ceil(MODEL_DATA.length / mp);
  html += `<div class="section"><div class="section-title">🛡️ 执行AI表现排行 <span class="count">${MODEL_DATA.length}个AI</span></div>
    <table class="model-table"><thead><tr><th>冒险者</th><th>完成/领取</th><th>完成率</th><th>均分</th><th>完成度</th><th>代码质量</th><th>验证</th><th>打回</th><th>擅长项目</th><th>最近完成</th></tr></thead>
    <tbody id="modelTbody">${MODEL_DATA.slice(0, mp).map(modelRow).join('')}</tbody></table>
    ${modelPages > 1 ? `<div class="pagination"><button class="page-btn" onclick="changeModelPage(-1)" id="modelPrev">上一页</button><span class="page-info" id="modelPageInfo">第 1 / ${modelPages} 页</span><button class="page-btn" onclick="changeModelPage(1)" id="modelNext">下一页</button></div>` : ''}
  </div>`;

  $('taskSections').innerHTML = html;

  // ai-028: 全空状态
  if (d.total === 0) {
    $('taskSections').innerHTML = `<div class="empty-state">
      <div class="empty-icon">📋</div>
      <div class="empty-title">任务池还是空的</div>
      <div class="empty-desc">点击右上角「＋ 新建任务」开始第一个任务，或在 AI 助手栏设定目标让总指挥自动拆解。</div>
    </div>`;
  }

  // 筛选 chips / 创建人下拉
  renderFilterChips(d);
  renderProjectSelect();
  renderCompletedPage();
  renderModelPage();
  applyFilters();
}

function modelRow(m) {
  const avg = parseFloat(m.avg_total);
  const cls = isNaN(avg) ? 'none' : (avg >= 3.8 ? 'good' : (avg >= 3.2 ? 'mid' : 'bad'));
  const rate = m.rate ?? 0;
  const rateCls = rate >= 80 ? 'good' : (rate >= 50 ? 'mid' : 'bad');
  return `<tr>
    <td class="model-name">${escHtml(m.assignee)}</td>
    <td>${m.completed ?? m.cnt}<span class="dim">/${m.cnt ?? '—'}</span></td>
    <td class="avg-score ${rateCls}">${rate}%</td>
    <td class="avg-score ${cls}">${isNaN(avg) ? '—' : m.avg_total}</td>
    <td>${m.avg_comp ?? '—'}</td>
    <td>${m.avg_qual ?? '—'}</td>
    <td>${m.avg_verif ?? '—'}</td>
    <td>${m.redo ?? 0}</td>
    <td>${escHtml(m.top_project || '—')}</td>
    <td class="dim">${m.last_at ? String(m.last_at).slice(0, 10) : '—'}</td>
  </tr>`;
}

function renderFilterChips(d) {
  const af = $('assigneeFilter');
  af.innerHTML = '';
  (d.allAssignees || []).forEach(a => {
    const chip = document.createElement('span');
    chip.className = 'assignee-chip';
    chip.dataset.assignee = a;
    chip.innerHTML = `<span class="dot" style="background:${assigneeColor(a)}"></span>${escHtml(a)}`;
    chip.addEventListener('click', () => filterByAssignee(a));
    af.appendChild(chip);
  });
  document.querySelectorAll('.assignee-chip').forEach(c => c.classList.toggle('active', c.dataset.assignee === currentAssignee));

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
const PROJECT_OPTIONS = [
  { key: 'all', label: '🌐 全部项目' },
  { key: 'zhaoxi', label: '项目A' },
  { key: 'guild', label: '冒险公会' },
  { key: 'tool', label: '工具链' },
  { key: 'zaima', label: '项目B' },
  { key: 'other', label: '其他' },
];
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

// 已完成分页
function renderCompletedPage() {
  const grid = $('completedGrid');
  if (!grid) return;
  const perPage = (STATE && STATE.completedPerPage) || 20;
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
function renderModelPage() {
  const tbody = $('modelTbody');
  if (!tbody) return;
  const perPage = (STATE && STATE.modelsPerPage) || 10;
  const start = (modelPage - 1) * perPage;
  tbody.innerHTML = MODEL_DATA.slice(start, start + perPage).map(modelRow).join('');
  const totalPages = Math.ceil(MODEL_DATA.length / perPage);
  const info = $('modelPageInfo');
  const prev = $('modelPrev');
  const next = $('modelNext');
  if (info) info.textContent = '第 ' + modelPage + ' / ' + totalPages + ' 页';
  if (prev) prev.disabled = modelPage <= 1;
  if (next) next.disabled = modelPage >= totalPages;
}
function changeModelPage(dir) {
  const totalPages = Math.ceil(MODEL_DATA.length / ((STATE && STATE.modelsPerPage) || 10));
  modelPage = Math.max(1, Math.min(totalPages, modelPage + dir));
  renderModelPage();
}

// ─── 筛选 ───
function filterByStatus(status) {
  currentStatus = status;
  document.querySelectorAll('.filter-tab').forEach(tab => tab.classList.toggle('active', tab.dataset.filter === status));
  applyFilters();
  if (status !== 'all') {
    const target = status === 'redo' ? $('redoSection') : document.querySelector('.section[data-section="' + status + '"]');
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}
function filterByAssignee(name) {
  currentAssignee = (currentAssignee === name) ? '' : name;
  document.querySelectorAll('.assignee-chip').forEach(c => c.classList.toggle('active', c.dataset.assignee === currentAssignee));
  applyFilters();
}
function filterByCreator(name) {
  currentCreator = (currentCreator === name) ? '' : name;
  const sel = $('creatorSelect');
  if (sel) sel.value = currentCreator;
  applyFilters();
}
function onCreatorChange(value) { currentCreator = value || ''; applyFilters(); }
function clearFilters() {
  currentStatus = 'all'; currentAssignee = ''; currentCreator = '';
  document.querySelectorAll('.filter-tab').forEach(t => t.classList.toggle('active', t.dataset.filter === 'all'));
  document.querySelectorAll('.assignee-chip').forEach(c => c.classList.remove('active'));
  const sel = $('creatorSelect'); if (sel) sel.value = '';
  applyFilters();
}
function applyFilters() {
  const cards = document.querySelectorAll('.task-card');
  let visible = 0;
  cards.forEach(card => {
    let statusMatch;
    if (currentStatus === 'redo') statusMatch = card.dataset.redo === 'true';
    else statusMatch = (currentStatus === 'all') || (card.dataset.status === currentStatus);
    const assigneeMatch = !currentAssignee || card.dataset.assignee === currentAssignee;
    const creatorMatch = !currentCreator || card.dataset.creator === currentCreator;
    const pageOk = card.dataset.pageHidden !== '1';
    const show = statusMatch && assigneeMatch && creatorMatch && pageOk;
    card.classList.toggle('hidden', !show);
    if (show) visible++;
  });
  $('emptyHint').style.display = visible === 0 ? 'block' : 'none';
  $('clearFilter').style.display = (currentStatus !== 'all' || currentAssignee || currentCreator) ? 'inline' : 'none';
  const redoSection = $('redoSection');
  if (redoSection) {
    if (currentStatus === 'redo') {
      redoSection.style.display = '';
      document.querySelectorAll('.section[data-section]').forEach(s => s.style.display = 'none');
    } else {
      redoSection.style.display = 'none';
      document.querySelectorAll('.section[data-section]').forEach(section => {
        const n = section.querySelectorAll('.task-card:not(.hidden)').length;
        section.style.display = n === 0 ? 'none' : '';
      });
    }
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
    if (RECRUIT_CACHE && $('recruitAdventurer').textContent !== '加载中…') return;
    const d = await fetchJSON('/api/recruit');
    RECRUIT_CACHE = d;
    $('recruitAdventurer').textContent = d.adventurer || '（未找到 docs/RECRUIT.md）';
    $('recruitLeader').textContent = d.leader || '（未找到 docs/LEADER_PROTOCOL.md）';
  } catch (e) {
    $('recruitAdventurer').textContent = '加载失败：' + e.message;
  }
}
function copyRecruit(which) {
  const text = which === 'leader' ? RECRUIT_CACHE.leader : RECRUIT_CACHE.adventurer;
  if (!text) { toast('内容未就绪，请稍候', false); return; }
  const done = () => toast(which === 'leader' ? '👑 会长提示词已复制，发给目标 AI 即可' : '⚔️ 招募令已复制，发给目标 AI 即可', true);
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

// ─── 项目记忆视图（共享项目记忆库 + 本地库，跟随顶部项目完全隔离） ───
async function loadMemory(kw) {
  const q = (kw !== undefined ? kw : ($('memSearch').value || '')).trim();
  const proj = CURRENT_PROJECT || 'all';
  $('memHint').textContent = q ? `正在搜索「${q}」…` : '正在加载…';
  try {
    const r = await fetch('/api/memory?kw=' + encodeURIComponent(q) + '&limit=15&project=' + encodeURIComponent(proj));
    const data = await r.json();
    if (!data.ok) { $('memHint').textContent = '加载失败'; return; }
    $('memSharedBadge').textContent = data.sharedAvailable ? '（已打通 · 所有 AI 共用）' : '（共享库不可用）';
    renderMemList('memSharedList', data.shared, '共享');
    renderMemList('memLocalList', data.local, '本地');
    const pname = projectLabel(proj);
    $('memHint').textContent = `${proj !== 'all' ? '【' + pname + '】' : ''}${q ? '搜索「' + q + '」' : '最近记录'}：共享 ${data.shared.length} 条 / 本地 ${data.local.length} 条`;
  } catch (e) { $('memHint').textContent = '请求失败: ' + e.message; }
}
function loadMemoryRecent() { $('memSearch').value = ''; loadMemory(''); }
function renderMemList(id, rows, srcLabel) {
  const el = $(id);
  if (!rows.length) { el.innerHTML = '<div class="mem-empty">（无匹配记录）</div>'; return; }
  el.innerHTML = rows.map(r => {
    const c = String(r.content || '').replace(/</g, '&lt;').slice(0, 220);
    const t = String(r.title || '').replace(/</g, '&lt;');
    return `<div class="mem-item">
      <div class="mem-item-title"><span class="mem-type">${r.type || ''}</span> ${t} ${r.project && r.project !== 'other' ? `<span class="mem-proj">${r.projectName || ''}</span>` : ''}</div>
      <div class="mem-item-content">${c}</div>
      <div class="mem-item-foot">${r.created_at || ''}</div>
    </div>`;
  }).join('');
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
  startAutoRefresh();
}


// ─── 详情抽屉 ───
// ai-035: 总指挥决策结构化解析
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
    <div class="d-label">🧭 总指挥决策</div>
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
      打回者：${escHtml(t.rejected_by || '总指挥')}${t.rejected_at ? '（' + escHtml(t.rejected_at) + '）' : ''}<br>
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
  if (CFG) $('fPrefix').value = CFG.tasks.defaultPrefix;
  const fw = $('fWorkspace');
  if (fw && CFG) {
    const def = (CFG.workspaces || []).find(w => w.is_default);
    fw.value = (def && def.name) || '默认';
  }
  const cs = $('fCreator'); if (cs) cs.value = (CFG && CFG.tasks.createdByDefault) || '总指挥';
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
      body: JSON.stringify({ title, description: desc, priority, prefix, created_by: creator, workspace })
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
    </div>`).join('');
  $('fScoreComment').value = '';
  updateScoreTotal();
  const hint = $('scoreHint');
  if (hint) hint.textContent = `评分维度 ${minS}-${maxS} 分，总分 = ${dims.length} 维平均。提交后可再次修改覆盖。`;
  $('scoreMask').classList.add('show');
  pauseAutoRefresh();
}
function onScoreSlider(key) {
  const v = $('sds-' + key).value;
  const el = $('sdv-' + key);
  if (el) el.textContent = v;
  updateScoreTotal();
}
function updateScoreTotal() {
  const dims = (CFG && CFG.scoring && CFG.scoring.dimensions) || [
    { key: 'completion' }, { key: 'quality' }, { key: 'verification' }, { key: 'record' }
  ];
  const vals = dims.map(d => parseInt(($('sds-' + d.key) || { value: 3 }).value, 10));
  const total = (vals.reduce((a, b) => a + b, 0) / dims.length).toFixed(2);
  $('scoreTotal').textContent = total;
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
  // AI 项目管理（可编辑）
  const ai = c.ai || {};
  $('setAi').innerHTML = `
    <div class="set-line"><span class="k">启用 AI 项目管理</span>
      <label class="switch"><input type="checkbox" id="cfg-ai-enabled" ${ai.enabled ? 'checked' : ''}><span class="slider"></span></label>
    </div>
    <div class="set-line"><span class="k">目标自主运行（后台自动派活执行）</span>
      <label class="switch"><input type="checkbox" id="cfg-ai-autorun" ${ai.autoRun ? 'checked' : ''}><span class="slider"></span></label>
    </div>
    ${setInput('API Key（火山方舟 ark-…，留空不修改）', 'cfg-ai-key', ai.apiKey === '****' ? '****' : '', 'password')}
    ${setInput('Base URL', 'cfg-ai-baseurl', ai.baseUrl, 'text')}
    ${setInput('总指挥模型', 'cfg-ai-director', ai.directorModel, 'text')}
    ${setInput('工人模型', 'cfg-ai-worker', ai.workerModel, 'text')}
    <div class="set-note">模型为火山方舟可用模型 ID（如 deepseek-v4-flash-ga-260731）。「目标自主运行」开启后，运行中的目标会由后台自动拆解、派活、执行。API Key 只存本地 config.json，不对外显示。</div>
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
    },
    ai: {
      enabled: $('cfg-ai-enabled') ? $('cfg-ai-enabled').checked : false,
      apiKey: $('cfg-ai-key') ? $('cfg-ai-key').value.trim() : '',
      baseUrl: $('cfg-ai-baseurl') ? $('cfg-ai-baseurl').value.trim() : '',
      directorModel: $('cfg-ai-director') ? $('cfg-ai-director').value.trim() : '',
      workerModel: $('cfg-ai-worker') ? $('cfg-ai-worker').value.trim() : '',
      autoRun: $('cfg-ai-autorun') ? $('cfg-ai-autorun').checked : false
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
    $('fCreator').value = CFG.tasks.createdByDefault || '总指挥';
  }
  // 工作区下拉初始由 /api/state 提供
  await loadState(true);
  $('footDataDir').textContent = '数据目录：' + ((CFG && CFG.dataDir) || '—');
  $('footPort').textContent = '端口：' + ((CFG && CFG.server && CFG.server.port) || '—');
  $('footer').textContent = (CFG && CFG.app && CFG.app.footer) || '冒险公会任务看板';
  startAutoRefresh();
  startPatrolRefresh();  // ai-036: 巡查日志定时刷新
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if ($('createMask').classList.contains('show')) closeCreateForm();
    if ($('scoreMask').classList.contains('show')) closeScoreForm();
    if ($('drawerMask').classList.contains('show')) closeDrawer();
  }
});

init();
