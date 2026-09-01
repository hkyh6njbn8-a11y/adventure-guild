#!/usr/bin/env node
/**
 * memory.mjs — 冒险公会本地记忆库 CLI
 *
 * 用法：
 *   node memory.mjs add "标题" "内容" [--type fact|log|idea] [--who "作者"]
 *   node memory.mjs search "关键词" [--type fact|log|idea] [--limit 10]
 *   node memory.mjs recent [--limit 20]
 *   node memory.mjs list [--type fact|log|idea]
 *   node memory.mjs get <id>
 *   node memory.mjs update <id> --content "新内容"
 *   node memory.mjs delete <id>
 *   node memory.mjs stats
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';

// ─── 数据库路径（与 task.mjs 一致）──────────────────────
const DATA_DIR = process.env.AI_GUILD_DATA || path.join(os.homedir(), '.adventure-guild');
const DB_PATH = path.join(DATA_DIR, 'data', 'memory.db');

function openDb() {
  fs.mkdirSync(path.join(DATA_DIR, 'data'), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT DEFAULT '[]',
      entities TEXT DEFAULT '[]',
      confidence REAL DEFAULT 0.9,
      importance INTEGER DEFAULT 1,
      status TEXT DEFAULT 'active',
      source TEXT DEFAULT '',
      session_id TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime')),
      last_accessed_at TEXT DEFAULT '',
      access_count INTEGER DEFAULT 0,
      supersedes_id TEXT DEFAULT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
    CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status);
    CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at DESC);
  `);
}

// ─── 工具函数 ───────────────────────────────────────────
function genId() {
  return crypto.randomUUID();
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(argv[i]);
    }
  }
  return args;
}

function printResult(msg) {
  console.log(msg);
}

// ─── 命令实现 ───────────────────────────────────────────
function cmdAdd(args) {
  const db = openDb();
  ensureSchema(db);

  const title = (args._[1] || '').trim();
  const content = (args._[2] || '').trim();
  if (!title || !content) {
    printResult('❌ 用法：node memory.mjs add "标题" "内容" [--type fact|log|idea] [--who "作者"]');
    process.exit(1);
  }

  const id = genId();
  const type = args.type || 'fact';
  const who = args.who || '未知';
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  db.prepare(`INSERT INTO memories (id, type, title, content, source, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    id, type, title, content, who, now, now
  );

  printResult(`✅ 记忆已添加 [${type}] ${title}`);
  printResult(`   ID: ${id}`);
  db.close();
}

function cmdSearch(args) {
  const db = openDb();
  ensureSchema(db);

  const keyword = (args._[1] || '').trim();
  if (!keyword) {
    printResult('❌ 用法：node memory.mjs search "关键词" [--type fact|log|idea] [--limit 10]');
    process.exit(1);
  }

  const limit = parseInt(args.limit) || 10;
  const typeFilter = args.type ? `AND type = ?` : '';
  const sql = `SELECT id, type, title, content, source, created_at FROM memories
               WHERE (title LIKE ? OR content LIKE ?) ${typeFilter}
               AND status = 'active'
               ORDER BY created_at DESC LIMIT ?`;

  const params = [`%${keyword}%`, `%${keyword}%`];
  if (args.type) params.push(args.type);
  params.push(limit);

  const rows = db.prepare(sql).all(...params);
  if (!rows.length) {
    printResult('（无匹配结果）');
    db.close();
    return;
  }

  printResult(`🔍 找到 ${rows.length} 条结果（关键词："${keyword}"）`);
  for (const r of rows) {
    printResult(`\n[${r.type}] ${r.title}`);
    printResult(`   ${r.content.slice(0, 200)}${r.content.length > 200 ? '...' : ''}`);
    printResult(`   来源: ${r.source || '未知'} | ${r.created_at}`);
  }
  db.close();
}

function cmdRecent(args) {
  const db = openDb();
  ensureSchema(db);

  const limit = parseInt(args.limit) || 20;
  const rows = db.prepare(`SELECT id, type, title, content, source, created_at FROM memories
                           WHERE status = 'active' ORDER BY created_at DESC LIMIT ?`).all(limit);

  if (!rows.length) {
    printResult('（无记忆记录）');
    db.close();
    return;
  }

  printResult(`📋 最近 ${rows.length} 条记忆`);
  for (const r of rows) {
    printResult(`\n[${r.type}] ${r.title}`);
    printResult(`   ${r.content.slice(0, 150)}${r.content.length > 150 ? '...' : ''}`);
    printResult(`   ${r.source || '未知'} | ${r.created_at}`);
  }
  db.close();
}

function cmdList(args) {
  const db = openDb();
  ensureSchema(db);

  const typeFilter = args.type ? `WHERE type = ?` : 'WHERE status = \'active\'';
  const sql = `SELECT type, title, created_at FROM memories ${typeFilter} ORDER BY created_at DESC`;
  const rows = args.type
    ? db.prepare(sql).all(args.type)
    : db.prepare(sql).all();

  if (!rows.length) {
    printResult('（无记忆记录）');
    db.close();
    return;
  }

  printResult(`📋 记忆列表（共 ${rows.length} 条）`);
  for (const r of rows) {
    printResult(`[${r.type}] ${r.title} — ${r.created_at}`);
  }
  db.close();
}

function cmdGet(args) {
  const db = openDb();
  ensureSchema(db);

  const id = (args._[1] || '').trim();
  if (!id) {
    printResult('❌ 用法：node memory.mjs get <id>');
    process.exit(1);
  }

  const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
  if (!row) {
    printResult(`❌ 记忆 ${id} 不存在`);
    db.close();
    return;
  }

  // 增加访问计数
  db.prepare('UPDATE memories SET access_count = access_count + 1, last_accessed_at = datetime(\'now\',\'localtime\') WHERE id = ?').run(id);

  printResult(`📄 记忆详情`);
  printResult(`   ID: ${row.id}`);
  printResult(`   类型: ${row.type}`);
  printResult(`   标题: ${row.title}`);
  printResult(`   内容: ${row.content}`);
  printResult(`   来源: ${row.source || '未知'}`);
  printResult(`   状态: ${row.status}`);
  printResult(`   创建: ${row.created_at}`);
  printResult(`   访问: ${row.access_count} 次`);
  db.close();
}

function cmdUpdate(args) {
  const db = openDb();
  ensureSchema(db);

  const id = (args._[1] || '').trim();
  const content = args.content;
  if (!id || !content) {
    printResult('❌ 用法：node memory.mjs update <id> --content "新内容"');
    process.exit(1);
  }

  const exists = db.prepare('SELECT id FROM memories WHERE id = ?').get(id);
  if (!exists) {
    printResult(`❌ 记忆 ${id} 不存在`);
    db.close();
    return;
  }

  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  db.prepare('UPDATE memories SET content = ?, updated_at = ? WHERE id = ?').run(content, now, id);
  printResult(`✅ 记忆 ${id} 已更新`);
  db.close();
}

function cmdDelete(args) {
  const db = openDb();
  ensureSchema(db);

  const id = (args._[1] || '').trim();
  if (!id) {
    printResult('❌ 用法：node memory.mjs delete <id>');
    process.exit(1);
  }

  const exists = db.prepare('SELECT id FROM memories WHERE id = ?').get(id);
  if (!exists) {
    printResult(`❌ 记忆 ${id} 不存在`);
    db.close();
    return;
  }

  db.prepare("UPDATE memories SET status = 'deleted', updated_at = datetime('now','localtime') WHERE id = ?").run(id);
  printResult(`🗑️ 记忆 ${id} 已删除`);
  db.close();
}

function cmdStats(args) {
  const db = openDb();
  ensureSchema(db);

  const total = db.prepare("SELECT COUNT(*) as cnt FROM memories WHERE status = 'active'").get();
  const byType = db.prepare("SELECT type, COUNT(*) as cnt FROM memories WHERE status = 'active' GROUP BY type ORDER BY cnt DESC").all();
  const bySource = db.prepare("SELECT source, COUNT(*) as cnt FROM memories WHERE status = 'active' AND source != '' GROUP BY source ORDER BY cnt DESC LIMIT 10").all();

  printResult('📊 记忆库统计');
  printResult(`   总记忆数: ${total.cnt}`);
  printResult('');
  printResult('   按类型分布:');
  for (const r of byType) {
    printResult(`     [${r.type}]: ${r.cnt}`);
  }
  printResult('');
  printResult('   按来源分布（Top 10）:');
  for (const r of bySource) {
    printResult(`     ${r.source}: ${r.cnt}`);
  }
  db.close();
}

// ─── 主入口 ───────────────────────────────────────────
const argv = process.argv.slice(2);
const args = parseArgs(argv);
const cmd = args._[0];

switch (cmd) {
  case 'add': cmdAdd(args); break;
  case 'search': cmdSearch(args); break;
  case 'recent': cmdRecent(args); break;
  case 'list': cmdList(args); break;
  case 'get': cmdGet(args); break;
  case 'update': cmdUpdate(args); break;
  case 'delete': cmdDelete(args); break;
  case 'stats': cmdStats(args); break;
  default:
    console.log(`冒险公会 · 记忆库 CLI

用法：
  node memory.mjs add "标题" "内容" [--type fact|log|idea] [--who "作者"]
  node memory.mjs search "关键词" [--type fact|log|idea] [--limit 10]
  node memory.mjs recent [--limit 20]
  node memory.mjs list [--type fact|log|idea]
  node memory.mjs get <id>
  node memory.mjs update <id> --content "新内容"
  node memory.mjs delete <id>
  node memory.mjs stats

类型：
  fact  事实/知识（默认）
  log   工作日志
  idea  想法/建议

示例：
  node memory.mjs add "冒险公会项目根目录" "D:\\冒险公会，包含src/web/data目录" --who "AgnesCode"
  node memory.mjs search "任务池" --limit 5
  node memory.mjs recent --limit 10
  node memory.mjs stats`);
}
