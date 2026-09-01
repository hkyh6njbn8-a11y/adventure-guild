// sharedMemory.cjs — 冒险公会 ↔ 共享项目记忆库打通模块
//
// 背景：所有 AI 共享的项目记忆库（路径由 config.integrations.sharedMemoryDir 或环境变量 SHARED_MEMORY_DIR 配置，未配置则禁用）。
//       冒险公会本地的 memories 表只是本系统内部记录；要让"不管哪个 AI 进来看板
//       都自带项目上下文"，必须读写共享记忆库。
//
// 规则（重要，必须遵守）：
//   - 写入：一律走共享库的 memory.mjs 标准工具（自动查重/归档），
//     禁止直接拼 SQL 写公共库。
//   - 读取：直接只读查询（更快，与 memory.mjs search 同一逻辑），无副作用。
//
// 用法（CommonJS）：
//   const sm = require('./lib/sharedMemory.cjs');
//   sm.search('关键词', 10)          → [{type,title,content,importance,created_at}, ...]
//   sm.archiveLog('内容', 'AI名')    → {ok, out}
//   sm.exists()                      → 公共库是否可用

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const SHARED_DIR_DEFAULT = 'D:/MemoryBank/公共漏斗库';

// 共享库目录：优先级 环境变量 SHARED_MEMORY_DIR > 配置 integrations.sharedMemoryDir > 默认本机路径
// （开源部署：设 SHARED_MEMORY_DIR 指向自己的共享记忆库，或留空禁用共享记忆功能）
function sharedDir() {
  if (process.env.SHARED_MEMORY_DIR && process.env.SHARED_MEMORY_DIR.trim()) {
    return path.resolve(String(process.env.SHARED_MEMORY_DIR).trim());
  }
  try {
    const cfg = require('./config.cjs');
    if (cfg.integrations && cfg.integrations.sharedMemoryDir && cfg.integrations.sharedMemoryDir.trim()) {
      return path.resolve(String(cfg.integrations.sharedMemoryDir).trim());
    }
  } catch (e) { /* 配置读取失败则用默认 */ }
  return SHARED_DIR_DEFAULT;
}
function sharedDbPath() { return path.join(sharedDir(), 'data', 'memory.db'); }
function sharedCli() { return path.join(sharedDir(), 'memory.mjs'); }
function exists() { return fs.existsSync(sharedDbPath()); }

// 写工作日志到共享库（走 memory.mjs log 工具，合规）
// 返回 {ok, out}；公共库不可用时不抛错（不影响任务完成流程）
function archiveLog(content, who) {
  if (!content || !exists()) return { ok: false, error: '共享记忆库不可用' };
  try {
    const r = spawnSync(process.execPath, [sharedCli(), 'log', String(content), '--who', who || '冒险公会'], {
      encoding: 'utf8', timeout: 30000, windowsHide: true, maxBuffer: 2 * 1024 * 1024
    });
    if (r.status !== 0) return { ok: false, error: (r.stderr || r.stdout || '退出码 ' + r.status).slice(0, 200) };
    return { ok: true, out: (r.stdout || '').trim().slice(0, 200) };
  } catch (e) {
    return { ok: false, error: e.message.slice(0, 200) };
  }
}

// 项目识别：公共库记忆没有统一项目字段，用 tags/title/content 关键词映射到项目
const PROJECTS = [
  { key: 'zhaoxi', name: '项目A', kws: ['zhaoxi'] },
  { key: 'guild',  name: '冒险公会', kws: ['冒险', '公会', 'quest', '任务看板'] },
  { key: 'tool',   name: '工具链', kws: ['tool', '工具'] },
  { key: 'zaima',  name: '项目B', kws: ['zaima', 'zaimozaime'] },
];
function projectOf(title, content, tags) {
  const hay = String(title || '') + ' ' + String(content || '') + ' ' + String(tags || '');
  for (const p of PROJECTS) {
    if (p.kws.some(k => hay.toLowerCase().includes(k.toLowerCase()))) return p.key;
  }
  return 'other';
}
function projectName(key) {
  const p = PROJECTS.find(x => x.key === key);
  return p ? p.name : (key === 'other' ? '其他' : key);
}

// 搜索共享库（只读，不产生副作用）。project 可选：zhaoxi/guild/tool/zaima/other/all
function search(kw, limit, project) {
  if (!exists()) return [];
  try {
    const Database = require('better-sqlite3');
    const db = new Database(sharedDbPath(), { readonly: true });
    try {
      const q = `%${(kw || '').trim()}%`;
      const n = Math.min(parseInt(limit, 10) || 10, 30);
      const rows = db.prepare(
        `SELECT type,title,content,importance,created_at,tags FROM memories
         WHERE (title LIKE ? OR content LIKE ?) AND status='active'
         ORDER BY importance DESC, created_at DESC LIMIT ?`
      ).all(q, q, n * 4); // 多取一些，JS 层做项目过滤
      return rows
        .map(r => ({ ...r, project: projectOf(r.title, r.content, r.tags), projectName: projectName(projectOf(r.title, r.content, r.tags)) }))
        .filter(r => !project || project === 'all' || r.project === project)
        .slice(0, n);
    } finally { db.close(); }
  } catch (e) {
    console.warn('⚠️ 共享记忆库搜索失败:', e.message);
    return [];
  }
}

// 最近 N 条（不带关键词）
function recent(limit) { return search('', limit); }

module.exports = { sharedDir, sharedDbPath, exists, archiveLog, search, recent, projectOf, projectName, PROJECTS };
