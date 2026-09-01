/* ============================================================
   冒险公会 · 排行榜功能（任务：ai-027）
   实现：基于经验/等级/任务完成数的排行榜
   ============================================================ */
'use strict';

// ─── 排行榜数据模型 ───────────────────────────────────────
const RANKING_KEY = 'guild_ranking_v1';
const CURRENT_PLAYER_KEY = 'guild_current_player';

// 默认玩家
const DEFAULT_PLAYER = {
  id: 'player_001',
  name: '勇敢的冒险者',
  level: 1,
  exp: 0,
  questsCompleted: 0,
  createdAt: Date.now()
};

// 模拟其他玩家（用于演示）
const MOCK_PLAYERS = [
  { id: 'player_002', name: '剑士·艾琳', level: 5, exp: 420, questsCompleted: 12, createdAt: Date.now() - 86400000 },
  { id: 'player_003', name: '法师·洛克', level: 3, exp: 180, questsCompleted: 7, createdAt: Date.now() - 172800000 },
  { id: 'player_004', name: '刺客·影', level: 7, exp: 850, questsCompleted: 25, createdAt: Date.now() - 259200000 },
  { id: 'player_005', name: '牧师·光', level: 2, exp: 90, questsCompleted: 4, createdAt: Date.now() - 345600000 }
];

// ─── 本地存储操作 ─────────────────────────────────────────
function loadRanking() {
  try {
    const data = localStorage.getItem(RANKING_KEY);
    return data ? JSON.parse(data) : null;
  } catch (e) {
    console.warn('加载排行榜失败:', e);
    return null;
  }
}

function saveRanking(data) {
  try {
    localStorage.setItem(RANKING_KEY, JSON.stringify(data));
  } catch (e) {
    console.warn('保存排行榜失败:', e);
  }
}

function loadCurrentPlayer() {
  try {
    const data = localStorage.getItem(CURRENT_PLAYER_KEY);
    return data ? JSON.parse(data) : DEFAULT_PLAYER;
  } catch (e) {
    return DEFAULT_PLAYER;
  }
}

function saveCurrentPlayer(player) {
  try {
    localStorage.setItem(CURRENT_PLAYER_KEY, JSON.stringify(player));
  } catch (e) {
    console.warn('保存当前玩家失败:', e);
  }
}

// ─── 计算排名 ─────────────────────────────────────────────
function calculateRanking() {
  const players = [...MOCK_PLAYERS];
  const current = loadCurrentPlayer();
  
  // 检查当前玩家是否已在列表中
  const existingIndex = players.findIndex(p => p.id === current.id);
  if (existingIndex >= 0) {
    players[existingIndex] = current;
  } else {
    players.push(current);
  }
  
  // 按经验降序排序
  players.sort((a, b) => b.exp - a.exp);
  
  // 添加排名
  return players.map((p, index) => ({
    ...p,
    rank: index + 1,
    isCurrentPlayer: p.id === current.id
  }));
}

// ─── 渲染排行榜 ───────────────────────────────────────────
function renderRanking() {
  const container = document.getElementById('ranking-container');
  if (!container) return;
  
  const ranking = calculateRanking();
  
  // 获取当前玩家排名
  const currentRank = ranking.find(r => r.isCurrentPlayer);
  const currentRankIndex = ranking.findIndex(r => r.isCurrentPlayer);
  
  let html = `
    <div class="ranking-header">
      <h3>🏆 冒险者排行榜</h3>
      <div class="ranking-view-toggle">
        <button class="view-btn active" data-period="all">全部</button>
        <button class="view-btn" data-period="week">本周</button>
        <button class="view-btn" data-period="month">本月</button>
      </div>
    </div>
  `;
  
  // Top 3 展示
  if (ranking.length > 0) {
    const top3 = ranking.slice(0, 3);
    html += '<div class="top-three">';
    top3.forEach((player, index) => {
      const medals = ['🥇', '🥈', '🥉'];
      const height = index === 0 ? 'tall' : (index === 1 ? 'medium' : 'short');
      html += `
        <div class="top-player ${height} ${player.isCurrentPlayer ? 'current-player' : ''}">
          <div class="player-avatar">${medals[index]}</div>
          <div class="player-info">
            <div class="player-name">${escapeHtml(player.name)}</div>
            <div class="player-stats">Lv.${player.level} · ${player.questsCompleted}任务</div>
          </div>
          <div class="player-exp">${player.exp} EXP</div>
        </div>
      `;
    });
    html += '</div>';
  }
  
  // 完整列表
  html += '<div class="ranking-list">';
  ranking.forEach((player, index) => {
    const rankClass = index < 3 ? `rank-${index + 1}` : '';
    html += `
      <div class="ranking-item ${rankClass} ${player.isCurrentPlayer ? 'current-player' : ''}">
        <div class="rank-number">${player.rank <= 3 ? ['🥇', '🥈', '🥉'][player.rank - 1] : player.rank}</div>
        <div class="rank-info">
          <div class="rank-name">${escapeHtml(player.name)}${player.isCurrentPlayer ? ' (我)' : ''}</div>
          <div class="rank-details">Lv.${player.level} · ${player.questsCompleted}任务完成</div>
        </div>
        <div class="rank-exp">${player.exp} EXP</div>
      </div>
    `;
  });
  html += '</div>';
  
  // 当前玩家总结
  if (currentRank) {
    html += `
      <div class="current-player-summary">
        <div class="summary-title">📊 你的排名</div>
        <div class="summary-stats">
          <span>排名: <strong>#${currentRank.rank}</strong></span>
          <span>等级: <strong>Lv.${currentRank.level}</strong></span>
          <span>经验: <strong>${currentRank.exp}</strong></span>
          <span>任务: <strong>${currentRank.questsCompleted}</strong></span>
        </div>
        ${currentRank.rank > 1 ? `<div class="motivation">距离上一名还差 ${ranking[currentRank.rank - 2].exp - currentRank.exp} 经验！</div>` : '<div class="motivation">🎉 你是第一名！继续保持！</div>'}
      </div>
    `;
  }
  
  container.innerHTML = html;
  
  // 绑定视图切换按钮
  container.querySelectorAll('.view-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      container.querySelectorAll('.view-btn').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      // 实际项目中这里会根据周期重新计算排名
      console.log('切换视图:', e.target.dataset.period);
    });
  });
}

// ─── 经验更新时刷新排行榜 ────────────────────────────────
function updateRankingOnExpChange(newExp) {
  const player = loadCurrentPlayer();
  player.exp = newExp;
  
  // 检查升级
  const oldLevel = player.level;
  while (player.exp >= player.level * 100) {
    player.exp -= player.level * 100;
    player.level++;
  }
  
  if (player.level > oldLevel) {
    showToast(`🎉 升级！升至 Lv.${player.level}`);
  }
  
  saveCurrentPlayer(player);
  renderRanking();
}

// ─── 完成任务时更新 ───────────────────────────────────────
function updateRankingOnQuestComplete(expReward) {
  const player = loadCurrentPlayer();
  player.questsCompleted++;
  player.exp += expReward;
  saveCurrentPlayer(player);
  updateRankingOnExpChange(player.exp);
}

// ─── 工具函数 ─────────────────────────────────────────────
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function showToast(message) {
  const toast = document.createElement('div');
  toast.className = 'level-toast';
  toast.textContent = message;
  document.body.appendChild(toast);
  
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 400);
  }, 3000);
}

// ─── 初始化 ───────────────────────────────────────────────
function initRanking() {
  // 如果本地没有玩家数据，初始化默认玩家
  if (!localStorage.getItem(CURRENT_PLAYER_KEY)) {
    saveCurrentPlayer(DEFAULT_PLAYER);
  }
  
  // 渲染排行榜
  renderRanking();
  
  // 监听任务完成事件（通过自定义事件）
  document.addEventListener('questCompleted', (e) => {
    updateRankingOnQuestComplete(e.detail.expReward || 50);
  });
  
  // 监听经验变化事件
  document.addEventListener('expChanged', (e) => {
    updateRankingOnExpChange(e.detail.newExp);
  });
}

// 导出供其他模块使用
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    initRanking,
    renderRanking,
    updateRankingOnExpChange,
    updateRankingOnQuestComplete,
    calculateRanking,
    loadCurrentPlayer,
    saveCurrentPlayer
  };
}
