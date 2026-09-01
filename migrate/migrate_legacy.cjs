// migrate_legacy.cjs — 冒险公会：任务看板 旧库数据迁移工具（全表迁移）
// 功能：把旧「共享记忆库」memory.db 的任务相关表（tasks / task_scores / agents / memories）
//       全部迁移到产品独立数据目录的数据库，不丢失历史数据，源库只读不修改。
// 用法：
//   node migrate/migrate_legacy.cjs                       # 使用默认源路径
//   node migrate/migrate_legacy.cjs "D:\path\to\old.db"   # 指定旧库路径
//
// 说明：sqlite_sequence（AUTOINCREMENT 计数器）由 SQLite 在写入显式 id 时自动维护，此处仅做兜底同步。
// 幂等性：任务/评分/执行者按唯一键 INSERT OR IGNORE；memories 按 id 去重，重复执行不会产生脏数据。

const Database = require('better-sqlite3');
const { openDb, ensureSchema } = require('../src/lib/db.cjs');
const { DB_PATH } = require('../src/lib/config.cjs');

const DEFAULT_SRC = ''; // 迁移源库路径，默认留空（旧库位置可手动传入：node migrate_legacy.cjs <旧库路径>）
const SRC = process.argv[2] || DEFAULT_SRC;

const TABLE_ORDER = ['tasks', 'task_scores', 'agents', 'memories'];

function count(db, table) {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
}

function migrateTable(src, dst, table) {
  const srcCols = src.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  const dstCols = dst.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  const cols = srcCols.filter(c => dstCols.includes(c)); // 只复制双方都有的列
  const colList = cols.join(', ');
  const placeholders = cols.map(() => '?').join(', ');
  const rows = src.prepare(`SELECT ${colList} FROM ${table}`).all();

  let inserted = 0, skipped = 0;
  const dstCount = count(dst, table);

  if (table === 'memories') {
    // memories.id 无唯一约束，按 id 去重
    const existing = new Set(dst.prepare(`SELECT id FROM ${table}`).all().map(r => r.id));
    const ins = dst.prepare(`INSERT INTO ${table} (${colList}) VALUES (${placeholders})`);
    const tx = dst.transaction(() => {
      for (const r of rows) {
        if (existing.has(r.id)) { skipped++; continue; }
        ins.run(cols.map(c => r[c]));
        existing.add(r.id);
        inserted++;
      }
    });
    tx();
  } else {
    // tasks.task_id 唯一 / agents.name 主键 / task_scores.id 主键 → INSERT OR IGNORE
    const ins = dst.prepare(`INSERT OR IGNORE INTO ${table} (${colList}) VALUES (${placeholders})`);
    const tx = dst.transaction(() => {
      for (const r of rows) {
        const info = ins.run(cols.map(c => r[c]));
        if (info.changes > 0) inserted++; else skipped++;
      }
    });
    tx();
  }
  console.log(`  ${table}: 源 ${rows.length} 条 → 目标新增 ${inserted} / 跳过 ${skipped}（目标原 ${dstCount} 条）`);
  return { inserted, skipped };
}

function main() {
  if (!require('fs').existsSync(SRC)) {
    console.error(`❌ 旧库不存在：${SRC}`);
    console.error('   请传入正确路径：node migrate/migrate_legacy.cjs "旧库路径"');
    process.exit(1);
  }

  console.log(`源库：${SRC}`);
  console.log(`目标：${DB_PATH}`);
  console.log('');

  const src = new Database(SRC, { readonly: true });
  const dst = openDb();
  ensureSchema(dst);

  console.log('=== 开始迁移 ===');
  const report = {};
  for (const t of TABLE_ORDER) {
    const { inserted } = migrateTable(src, dst, t);
    report[t] = inserted;
  }

  // 兜底同步 sqlite_sequence（任务 id 计数器）
  try {
    const seqRows = src.prepare("SELECT name, seq FROM sqlite_sequence WHERE name IN ('tasks','task_scores')").all();
    for (const s of seqRows) {
      dst.prepare('INSERT OR IGNORE INTO sqlite_sequence (name, seq) VALUES (?, ?)').run(s.name, s.seq);
    }
  } catch (e) { /* 旧库可能无该表，忽略 */ }

  console.log('');
  console.log('=== 迁移后核对 ===');
  let ok = true;
  for (const t of TABLE_ORDER) {
    const s = count(src, t);
    const d = count(dst, t);
    const match = s === d ? '✔' : '✘ 不一致!';
    if (s !== d) ok = false;
    console.log(`  ${t}: 源 ${s} / 目标 ${d} ${match}`);
  }
  console.log('');
  console.log(ok ? '✅ 迁移完成，行数一致。' : '⚠️ 存在不一致，请检查。');
  src.close();
  dst.close();
}

main();
