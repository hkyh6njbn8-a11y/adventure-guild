// db.cjs — 冒险公会：任务看板 数据库统一入口
// 提供：openDb()（打开/初始化连接）、ensureSchema(db)（建表 + 兼容性迁移）
// 用途：CLI（task.mjs）、Web 服务（dashboard_server.cjs）、迁移工具（migrate_legacy.cjs）共用同一套路径与结构，
//       避免「CLI 建的库，看板打不开」这类不一致。

const Database = require('better-sqlite3');
const { DB_PATH, ensureDirs } = require('./config.cjs');

// 打开数据库（WAL 模式，与旧系统一致）
function openDb() {
  ensureDirs();
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

// 建表 + 兼容性迁移（幂等，可重复执行）
function ensureSchema(db) {
  // ─── 建表 ────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      assignee TEXT DEFAULT '',
      priority INTEGER DEFAULT 1,
      depends_on TEXT DEFAULT '',
      result TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      claimed_at TEXT DEFAULT '',
      completed_at TEXT DEFAULT '',
      original_assignee TEXT DEFAULT '',
      rejected_by TEXT DEFAULT '',
      rejected_at TEXT DEFAULT '',
      reject_reason TEXT DEFAULT '',
      reworked_by TEXT DEFAULT '',
      reworked_at TEXT DEFAULT '',
      created_by TEXT DEFAULT '',
      workspace_id INTEGER DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);

    CREATE TABLE IF NOT EXISTS workspaces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      display_name TEXT DEFAULT '',
      description TEXT DEFAULT '',
      is_default INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS task_scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT UNIQUE,
      score_completion INTEGER,
      score_quality INTEGER,
      score_verification INTEGER,
      score_record INTEGER,
      score_total REAL,
      reviewer TEXT,
      comment TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      reviewed INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS agents (
      name TEXT PRIMARY KEY,
      model TEXT DEFAULT '',
      total_tasks INTEGER DEFAULT 0,
      avg_score REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

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

    CREATE TABLE IF NOT EXISTS goals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      goal_id TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      status TEXT DEFAULT 'active',
      task_prefix TEXT DEFAULT '',
      workspace_id INTEGER DEFAULT 1,
      last_plan_at TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    );
  `);

    // ─── g003-013: 公会任务与悬赏表 ──────────────────
    db.exec(`
      CREATE TABLE IF NOT EXISTS guild_tasks (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id     TEXT UNIQUE NOT NULL,
        title       TEXT NOT NULL,
        description TEXT NOT NULL,
        poster      TEXT NOT NULL,              -- 发布者（会长/干部身份）
        reward_coins INTEGER DEFAULT 0,         -- 悬赏金币奖励
        reward_exp  INTEGER DEFAULT 0,          -- 悬赏经验奖励
        priority    INTEGER DEFAULT 1,
        status      TEXT DEFAULT 'open',        -- open/claimed/completed/cancelled
        assignee    TEXT DEFAULT '',
        claimed_at  TEXT DEFAULT '',
        completed_at TEXT DEFAULT '',
        result      TEXT DEFAULT '',
        created_at  TEXT DEFAULT (datetime('now','localtime')),
        updated_at  TEXT DEFAULT (datetime('now','localtime'))
      );
      CREATE INDEX IF NOT EXISTS idx_guild_tasks_status ON guild_tasks(status);
      CREATE INDEX IF NOT EXISTS idx_guild_tasks_poster ON guild_tasks(poster);
    `);

  // ─── tasks 表重做历史字段迁移 ────────────────────
  const taskCols = db.prepare('PRAGMA table_info(tasks)').all().map(c => c.name);
  const redoCols = [
    ['original_assignee', "TEXT DEFAULT ''"],
    ['rejected_by', "TEXT DEFAULT ''"],
    ['rejected_at', "TEXT DEFAULT ''"],
    ['reject_reason', "TEXT DEFAULT ''"],
    ['reworked_by', "TEXT DEFAULT ''"],
    ['reworked_at', "TEXT DEFAULT ''"],
    ['created_by', "TEXT DEFAULT ''"]
  ];
  for (const [col, def] of redoCols) {
    if (!taskCols.includes(col)) {
      db.exec(`ALTER TABLE tasks ADD COLUMN ${col} ${def}`);
      console.log(`迁移：已添加字段 tasks.${col}`);
    }
  }

  // ─── task_scores.reviewed 字段迁移 ────────────────
  const scoreCols = db.prepare('PRAGMA table_info(task_scores)').all().map(c => c.name);
  if (!scoreCols.includes('reviewed')) {
    db.exec(`ALTER TABLE task_scores ADD COLUMN reviewed INTEGER DEFAULT 0`);
    console.log('迁移：已添加 task_scores.reviewed 字段');
  }

  // ─── g003-003: agents 经验/等级字段迁移 ───────────
  const agentCols = db.prepare('PRAGMA table_info(agents)').all().map(c => c.name);
  if (!agentCols.includes('exp')) {
    db.exec(`ALTER TABLE agents ADD COLUMN exp INTEGER DEFAULT 0`);
    console.log('迁移：已添加 agents.exp 字段');
  }
  if (!agentCols.includes('level')) {
    db.exec(`ALTER TABLE agents ADD COLUMN level INTEGER DEFAULT 1`);
    console.log('迁移：已添加 agents.level 字段');
  }
  if (!agentCols.includes('combo')) {
    db.exec(`ALTER TABLE agents ADD COLUMN combo INTEGER DEFAULT 0`);
    console.log('迁移：已添加 agents.combo 字段');
  }
  if (!agentCols.includes('coins')) {
    db.exec(`ALTER TABLE agents ADD COLUMN coins INTEGER DEFAULT 0`);
    console.log('迁移：已添加 agents.coins 字段');
  }

  // ─── 旧 1-5 制分数 → 1-4 制迁移（保留旧数据）──────
  const oldScoreCount = db.prepare("SELECT COUNT(*) as cnt FROM task_scores WHERE score_completion > 4").get();
  if (oldScoreCount.cnt > 0) {
    db.exec(`UPDATE task_scores SET
      score_completion = CAST(score_completion * 0.8 AS INTEGER),
      score_quality = CAST(score_quality * 0.8 AS INTEGER),
      score_verification = CAST(score_verification * 0.8 AS INTEGER),
      score_record = CAST(score_record * 0.8 AS INTEGER),
      score_total = ROUND((score_completion + score_quality + score_verification + score_record) / 4.0, 2)
      WHERE score_completion > 4`);
    console.log(`迁移：已将 ${oldScoreCount.cnt} 条旧 1-5 制分数转为 1-4 制（含总分重算）`);
  }

  // ─── workspaces 表 + tasks.workspace_id 迁移（Phase 1 多工作区）───
  // 1) 确保默认工作区「默认」存在（历史/未归类任务都归入它）
  db.prepare(`INSERT OR IGNORE INTO workspaces (name, display_name, description, is_default)
              VALUES ('默认', '默认工作区', '未指定工作区的历史任务', 1)`).run();
  const defaultWs = db.prepare("SELECT id FROM workspaces WHERE is_default = 1 ORDER BY id LIMIT 1").get();

  // 2) 已有库补充 workspace_id 列（ALTER 带 DEFAULT 会回填旧行到默认工作区）
  const taskCols2 = db.prepare('PRAGMA table_info(tasks)').all().map(c => c.name);
  if (!taskCols2.includes('workspace_id')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN workspace_id INTEGER DEFAULT ${defaultWs ? defaultWs.id : 1}`);
    console.log('迁移：已添加字段 tasks.workspace_id');
  }

  // 3) 防御性回填：任何指向不存在工作区的行归入默认工作区
  db.prepare(`UPDATE tasks SET workspace_id = ?
              WHERE workspace_id IS NULL OR workspace_id NOT IN (SELECT id FROM workspaces)`)
    .run(defaultWs ? defaultWs.id : 1);

  // 4) 索引要在列存在后再建（旧库需先经过上面的 ALTER 才有该列）
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks(workspace_id)');

  // ─── 从 tasks 聚合历史执行者到 agents 表（首次出现才插入，避免每次启动都刷日志）──
  const agentRows = db.prepare(`
    SELECT assignee, COUNT(*) as cnt,
           ROUND(AVG(CASE WHEN ts.task_id IS NOT NULL THEN ts.score_total END), 2) as avg_score
    FROM tasks t
    LEFT JOIN task_scores ts ON t.task_id = ts.task_id
    WHERE t.status = 'completed' AND t.assignee != ''
    GROUP BY t.assignee
    ORDER BY cnt DESC
  `).all();
  let insertedAgents = 0;
  for (const a of agentRows) {
    const existing = db.prepare('SELECT name FROM agents WHERE name = ?').get(a.assignee);
    if (!existing) {
      db.prepare(`INSERT INTO agents (name, total_tasks, avg_score, created_at)
                  VALUES (?, ?, ?, datetime('now','localtime'))`).run(a.assignee, a.cnt, a.avg_score || 0);
      insertedAgents++;
    } else {
      db.prepare(`UPDATE agents SET total_tasks = ?, avg_score = ? WHERE name = ?`).run(a.cnt, a.avg_score || 0, a.assignee);
    }
  }
  if (insertedAgents > 0) {
    console.log(`迁移：已聚合 ${insertedAgents} 位历史执行者到 agents 表`);
  }
}

// ─── 工作区帮助函数（CLI 与看板共用，Phase 1）───
function getWorkspaces(db) {
  return db.prepare('SELECT * FROM workspaces ORDER BY is_default DESC, id ASC').all();
}

function getDefaultWorkspaceId(db) {
  const row = db.prepare("SELECT id FROM workspaces WHERE is_default = 1 ORDER BY id LIMIT 1").get();
  return row ? row.id : 1;
}

function getOrCreateWorkspace(db, name) {
  const n = String(name || '').trim() || '默认';
  let row = db.prepare('SELECT id FROM workspaces WHERE name = ?').get(n);
  if (!row) {
    const info = db.prepare('INSERT INTO workspaces (name, display_name) VALUES (?, ?)').run(n, n);
    row = { id: info.lastInsertRowid };
    console.log(`🆕 工作区「${n}」已创建`);
  }
  return row.id;
}

function workspaceNameOf(db, id) {
  const row = db.prepare('SELECT name FROM workspaces WHERE id = ?').get(id);
  return row ? row.name : '默认';
}

// g003-013: 生成公会任务ID
function genGuildTaskId() {
  const row = db.prepare("SELECT task_id FROM guild_tasks ORDER BY task_id DESC LIMIT 1").get();
  let nextNum = 1;
  if (row) {
    const m = row.task_id.match(/^g Guild-(\d+)$/);
    if (m) nextNum = parseInt(m[1], 10) + 1;
  }
  return `gGuild-${String(nextNum).padStart(3, '0')}`;
}

module.exports = {
  openDb, ensureSchema,
  getWorkspaces, getDefaultWorkspaceId, getOrCreateWorkspace, workspaceNameOf,
  genGuildTaskId
};
