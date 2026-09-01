// task.mjs — 冒险公会：任务看板 CLI
// 用法:
//   node task.mjs create "标题" "描述" [--priority 2] [--depends id1,id2] [--workspace 工作区]
//   node task.mjs list [--status pending|in_progress|completed|failed|all] [--workspace 工作区]
//   node task.mjs show <task_id>
//   node task.mjs claim <task_id> [--assignee "AI名称"]
//   node task.mjs complete <task_id> --result "结果内容" [--notes "备注"]
//   node task.mjs fail <task_id> --reason "失败原因"
//   node task.mjs reject <task_id> --reason "打回原因" [--by "打回者"]
//   node task.mjs reset <task_id>
//   node task.mjs score <task_id> --c N --q N --v N --r N [--comment '评语'] [--reviewer '评分人']
//   node task.mjs agents [--workspace 工作区]
//   node task.mjs workspaces
//   node task.mjs agent --reset
// 工作区：可用 --workspace 指定，或环境变量 AI_GUILD_WORKSPACE；缺省时 create 进默认工作区，list/agents 看全部。

import dbutil from './lib/db.cjs';
import cfg from './lib/config.cjs';
import sharedMemory from './lib/sharedMemory.cjs';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';

const AGENT_CONFIG_PATH = cfg.AGENT_CONFIG_PATH;

const db = dbutil.openDb();
dbutil.ensureSchema(db);

// ─── 工具函数 ───────────────────────────────────────────

function nowStr() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function priorityLabel(p) {
  return p >= 2 ? '高' : p >= 1 ? '中' : '低';
}

function statusLabel(s) {
  const map = { pending: '⏳待领取', in_progress: '🔄进行中', review: '🔍待审查', completed: '✅已完成', failed: '❌失败' };
  return map[s] || s;
}

function isRedoTask(t) {
  return !!(t.reject_reason && String(t.reject_reason).trim())
    || (t.description || '').includes('【被打回重做】')
    || (t.title || '').startsWith('[重做]');
}

function genTaskId(prefix = cfg.tasks.defaultPrefix) {
  const row = db.prepare(
    "SELECT task_id FROM tasks WHERE task_id LIKE ? ORDER BY task_id DESC LIMIT 1"
  ).get(`${prefix}-%`);
  let nextNum = 1;
  if (row) {
    const m = row.task_id.match(new RegExp(`^${prefix}-(\\d+)$`));
    if (m) nextNum = parseInt(m[1]) + 1;
  }
  return `${prefix}-${String(nextNum).padStart(3, '0')}`;
}

function inferPrefix(taskId) {
  const m = taskId.match(/^([a-z]+)-(\d+)/i);
  return m ? m[1].toLowerCase() : 'task';
}

// ─── 本地执行者注册（tool-009）──────────────────────────

function readAgentConfig() {
  try {
    if (existsSync(AGENT_CONFIG_PATH)) {
      return readFileSync(AGENT_CONFIG_PATH, 'utf-8').trim();
    }
  } catch (e) { /* ignore */ }
  return '';
}

function writeAgentConfig(name) {
  try {
    writeFileSync(AGENT_CONFIG_PATH, name, 'utf-8');
  } catch (e) { /* ignore */ }
}

function ensureAgentRegistered(name) {
  const existing = db.prepare('SELECT name FROM agents WHERE name = ?').get(name);
  if (!existing) {
    db.prepare('INSERT INTO agents (name, created_at) VALUES (?, ?)').run(name, nowStr());
    console.log(`🆕 执行者「${name}」已注册到 agents 表`);
  }
}

function getAgentStats(name) {
  return db.prepare(`
    SELECT COUNT(*) as total_tasks,
           COALESCE(AVG(ts.score_total), 0) as avg_score
    FROM tasks t
    LEFT JOIN task_scores ts ON t.task_id = ts.task_id
    WHERE t.assignee = ? AND t.status = 'completed'
  `).get(name);
}

// ─── 打分反馈查询（tool-009）────────────────────────────

function getUnreadFeedback(assignee, limit = 3) {
  return db.prepare(`
    SELECT t.task_id, t.title, ts.score_total, ts.score_completion,
           ts.score_quality, ts.score_verification, ts.score_record,
           ts.comment, ts.reviewer
    FROM task_scores ts
    JOIN tasks t ON t.task_id = ts.task_id
    WHERE t.assignee = ? AND ts.reviewed = 0
    ORDER BY ts.created_at DESC
    LIMIT ?
  `).all(assignee, limit);
}

function markFeedbackReviewed(taskIds) {
  if (taskIds.length === 0) return;
  const placeholders = taskIds.map(() => '?').join(',');
  db.prepare(`UPDATE task_scores SET reviewed = 1 WHERE task_id IN (${placeholders})`).run(...taskIds);
}

// ─── 解析命令行参数 ─────────────────────────────────────

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        args[key] = argv[++i];
      } else {
        args[key] = true;
      }
    } else {
      args._.push(argv[i]);
    }
  }
  return args;
}

// ─── 交互式询问名称 ─────────────────────────────────────

function askAgentName() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    console.log('\n📝 首次使用，请注册你的身份');
    console.log('   命名规范：工具名 (模型名)');
    console.log('   示例：AgnesCode (Agnes-2.5-Pro)、WorkBuddy (GLM-5.3-Flash)');
    rl.question('\n   请输入你的名称: ', answer => {
      rl.close();
      const name = (answer || '').trim();
      if (!name) {
        console.error('❌ 名称不能为空');
        process.exit(1);
      }
      resolve(name);
    });
  });
}

// ─── 命令处理 ───────────────────────────────────────────

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];

// ─── 工作区解析（Phase 1 多工作区）───
// 取值优先级：--workspace 参数 > 环境变量 AI_GUILD_WORKSPACE > 缺省
const workspaceArg = (args.workspace || process.env.AI_GUILD_WORKSPACE || '').trim();
// createMode=true 时必须落到某个工作区（缺省=默认工作区）；否则 filter=false 表示看全部
function resolveWorkspace(createMode) {
  if (!workspaceArg) {
    if (createMode) {
      const id = dbutil.getDefaultWorkspaceId(db);
      return { id, name: dbutil.workspaceNameOf(db, id), filter: false };
    }
    return { id: null, name: '', filter: false };
  }
  const id = dbutil.getOrCreateWorkspace(db, workspaceArg);
  return { id, name: dbutil.workspaceNameOf(db, id), filter: true };
}

// ─── ai-030: 防假完成验收门禁 ─────────────────────────
const COMPLETION_CHECKLIST = `
╔══════════════════════════════════════════════╗
║         完成自检清单（提交前逐项确认）          ║
╠══════════════════════════════════════════════╣
║ 1. 【修改文件】列出实际改动的文件完整路径       ║
║ 2. 【改动摘要】每个文件改了什么（不是"做了"）   ║
║ 3. 【验证方式】语法检查/测试/运行/截图等证据    ║
║ 4. 【验证结果】实际输出（通过/失败/具体数据）   ║
║ 5. 文件真实存在于磁盘（非沙箱假路径）           ║
╚══════════════════════════════════════════════╝
示例：
【修改文件】D:\\项目\\src\\app.js, D:\\项目\\web\\index.html
【改动摘要】app.js新增loadChatHistory函数；index.html添加对话面板
【验证方式】node -c app.js语法检查；浏览器刷新验证对话保留
【验证结果】语法通过；刷新后对话历史完整保留`;

function validateCompletion(result, taskDesc) {
  const issues = [];
  const evidence = { files: [], verified: false };
  if (!result || result.trim().length < 20) {
    issues.push('结果内容过短（<20字），疑似未实际描述工作内容');
  }
  // 提取声称的文件路径（Windows绝对路径 / 相对路径 / 标记段）
  const claimedFiles = new Set();
  // 【修改文件】/【改动文件】标记后的内容
  const tagMatch = result.match(/【(?:修改|改动)文件】\s*([^\n【]+)/);
  if (tagMatch) {
    tagMatch[1].split(/[,，;；]/).forEach(f => {
      const clean = f.trim();
      if (clean && clean.length > 3) claimedFiles.add(clean);
    });
  }
  // Windows绝对路径 D:\...
  const winMatches = result.matchAll(/[A-Za-z]:\\[^\s,，；;【】\n]+\.\w+/g);
  for (const m of winMatches) claimedFiles.add(m[0]);
  // 相对路径 src/...
  const relMatches = result.matchAll(/(?:^|\s)((?:src|web|lib|core|config|data|assets)[\\/][^\s,，；;【】\n]+\.\w+)/g);
  for (const m of relMatches) claimedFiles.add(m[1]);
  evidence.files = [...claimedFiles];
  // 验证文件是否存在
  const nonexistent = [];
  for (const f of claimedFiles) {
    try { if (!existsSync(f)) nonexistent.push(f); } catch { nonexistent.push(f); }
  }
  if (claimedFiles.size > 0 && nonexistent.length > 0) {
    issues.push(`声称改动的文件不存在（${nonexistent.length}个）：${nonexistent.slice(0,3).join('、')}${nonexistent.length > 3 ? '…' : ''}`);
  }
  // 检查验证证据
  if (!/(验证|测试|检查|通过|语法|运行|截图|200|OK|成功|报错|错误)/i.test(result)) {
    issues.push('未包含任何验证证据（测试/检查/运行结果/截图等）');
  } else {
    evidence.verified = true;
  }
  // 任务涉及代码/文件但结果无文件路径
  if (/(文件|代码|修改|实现|修复|添加|新增|删除|重构|前端|后端|脚本|函数|类|样式|界面|UI|API|接口)/i.test(taskDesc || '') && claimedFiles.size === 0) {
    issues.push('任务涉及代码/文件改动，但结果中未列出任何修改文件路径');
  }
  return { pass: issues.length === 0, issues, evidence };
}

switch (cmd) {

  // ---------- create ----------
  case 'create': {
    const title = args._[1];
    const description = args._[2] || '';
    if (!title) {
      console.error('用法: node task.mjs create "标题" ["描述"] [--priority 0|1|2] [--prefix 前缀]');
      process.exit(1);
    }
    const priority = args.priority !== undefined ? parseInt(args.priority) : 1;
    const prefix = args.prefix || inferPrefix(args._[1] || 'new-task');
    const taskId = genTaskId(prefix);
    const depends = args.depends_on || args.depends || '';
    // tool-013：创建人，--created-by / --created_by 都收，不传默认「总指挥」
    const createdBy = (args['created-by'] || args.created_by
      || (args['createdBy'] !== true ? args['createdBy'] : '') || '总指挥');
    // Phase 1：工作区（缺省=默认工作区）
    const ws = resolveWorkspace(true);
    db.prepare(`INSERT INTO tasks (task_id, title, description, priority, depends_on, created_by, workspace_id)
                VALUES (?, ?, ?, ?, ?, ?, ?)`).run(taskId, title, description, priority, depends, createdBy, ws.id);
    console.log(`✅ 已创建任务 ${taskId}: ${title}`);
    console.log(`   优先级: ${priorityLabel(priority)}`);
    console.log(`   创建人: ${createdBy}`);
    console.log(`   工作区: ${ws.name}`);
    if (depends) console.log(`   依赖: ${depends}`);
    break;
  }

  // ---------- list ----------
  case 'list': {
    const status = args.status || 'pending';
    const ws = resolveWorkspace(false);
    let rows;
    if (status === 'all') {
      rows = ws.filter
        ? db.prepare('SELECT * FROM tasks WHERE workspace_id = ? ORDER BY priority DESC, created_at ASC').all(ws.id)
        : db.prepare('SELECT * FROM tasks ORDER BY priority DESC, created_at ASC').all();
    } else {
      rows = ws.filter
        ? db.prepare('SELECT * FROM tasks WHERE status = ? AND workspace_id = ? ORDER BY priority DESC, created_at ASC').all(status, ws.id)
        : db.prepare('SELECT * FROM tasks WHERE status = ? ORDER BY priority DESC, created_at ASC').all(status);
    }
    if (!rows.length) { console.log(args.json ? '[]' : '（无任务）'); break; }
    if (args.json) { console.log(JSON.stringify(rows)); break; }
    console.log(`===== 任务列表（${status === 'all' ? '全部' : statusLabel(status)}）共 ${rows.length} 条${ws.filter ? `（工作区: ${ws.name}）` : '（全部工作区）'} =====\n`);
    for (const r of rows) {
      const reworkMark = (isRedoTask(r) && !(r.title || '').startsWith('[重做]')) ? '[重做] ' : '';
      const wsName = dbutil.workspaceNameOf(db, r.workspace_id);
      console.log(`[${r.task_id}] ${reworkMark}${statusLabel(r.status)} 优先级:${priorityLabel(r.priority)}  ${r.title}  （${wsName}）`);
      if (r.assignee) console.log(`    负责人: ${r.assignee} | 创建: ${r.created_at}`);
      if (r.description) console.log(`    ${r.description.slice(0, 80)}${r.description.length > 80 ? '…' : ''}`);
      console.log();
    }
    break;
  }

  // ---------- show ----------
  case 'show': {
    const taskId = args._[1];
    if (!taskId) { console.error('用法: node task.mjs show <task_id>'); process.exit(1); }
    const r = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId);
    if (!r) { console.error(`任务 ${taskId} 不存在`); process.exit(1); }
    if (args.json) {
      const score = db.prepare('SELECT * FROM task_scores WHERE task_id = ?').get(taskId);
      console.log(JSON.stringify({ task: r, score: score || null }));
      break;
    }
    console.log(`===== ${r.task_id} =====`);
    console.log(`标题: ${r.title}`);
    console.log(`状态: ${statusLabel(r.status)}`);
    console.log(`优先级: ${priorityLabel(r.priority)}`);
    console.log(`负责人: ${r.assignee || '（未领取）'}`);
    console.log(`创建人: ${r.created_by || '未知'}`);
    console.log(`工作区: ${dbutil.workspaceNameOf(db, r.workspace_id)}`);
    console.log(`创建: ${r.created_at}`);
    if (r.claimed_at) console.log(`领取: ${r.claimed_at}`);
    if (r.completed_at) console.log(`完成: ${r.completed_at}`);
    if (r.depends_on) console.log(`依赖: ${r.depends_on}`);
    console.log(`\n描述:\n${r.description || '（无）'}`);
    if (isRedoTask(r)) {
      const reason = (r.reject_reason && String(r.reject_reason).trim())
        ? String(r.reject_reason)
        : ((r.description || '').match(/【被打回重做】([^\n]+)/) || [, ''])[1].trim();
      console.log(`\n🔄 重做任务历史链:`);
      console.log(`   原作者: ${r.original_assignee || '—'}`);
      console.log(`   打回者: ${r.rejected_by || '总指挥'}${r.rejected_at ? `  （${r.rejected_at}）` : ''}`);
      if (reason) console.log(`   打回原因: ${reason}`);
      console.log(`   重做者: ${r.reworked_by || r.assignee || '（待重做）'}${r.reworked_at ? `  （${r.reworked_at}）` : ''}`);
    }
    if (r.result) console.log(`\n结果:\n${r.result}`);
    if (r.notes) console.log(`\n备注:\n${r.notes}`);

    // 显示打分
    const score = db.prepare('SELECT * FROM task_scores WHERE task_id = ?').get(taskId);
    if (score) {
      console.log(`\n📊 打分:`);
      console.log(`   完成度:${score.score_completion} 质量:${score.score_quality} 验证:${score.score_verification} 记录:${score.score_record} 总分:${score.score_total}`);
      if (score.comment) console.log(`   评语: ${score.comment}`);
      console.log(`   评分人: ${score.reviewer} | ${score.created_at}`);
    }
    break;
  }

  // ---------- claim（tool-009：交互式注册 + 反馈回显）────────────
  case 'claim': {
    const taskId = args._[1];
    if (!taskId) {
      console.error('用法: node task.mjs claim <task_id> [--assignee "AI名称"]');
      process.exit(1);
    }

    // 如果没有 --assignee，尝试从本地配置读取或交互式询问
    let assignee = args.assignee;
    if (!assignee) {
      assignee = readAgentConfig();
      if (!assignee) {
        assignee = await askAgentName();
        writeAgentConfig(assignee);
      }
    }

    if (!assignee) { console.error('❌ 领取失败：未提供 assignee'); process.exit(1); }

    // 原子领取
    const info = db.prepare(`UPDATE tasks SET status='in_progress', assignee=?, claimed_at=datetime('now','localtime')
                             WHERE task_id=? AND status='pending'`).run(assignee, taskId);
    if (info.changes === 0) {
      const r = db.prepare('SELECT status, assignee FROM tasks WHERE task_id=?').get(taskId);
      if (!r) { console.error(`任务 ${taskId} 不存在`); }
      else { console.error(`❌ 领取失败：任务状态为 ${statusLabel(r.status)}${r.assignee ? `（负责人: ${r.assignee}）` : ''}`); }
      process.exit(1);
    }

    // 注册执行者（首次出现时写入 agents 表）
    ensureAgentRegistered(assignee);

    console.log(`✅ ${assignee} 已领取任务 ${taskId}`);

    // 查询并回显未查看的打分反馈（tool-009）
    const feedback = getUnreadFeedback(assignee, 3);
    if (feedback.length > 0) {
      markFeedbackReviewed(feedback.map(f => f.task_id));
      console.log(`\n📊 你之前的任务有 ${feedback.length} 条未查看的打分反馈：\n`);
      for (const f of feedback) {
        console.log(`  ${f.task_id} ${f.title}`);
        console.log(`    总分: ${f.score_total} | 完成:${f.score_completion} 质量:${f.score_quality} 验证:${f.score_verification} 记录:${f.score_record}`);
        if (f.comment) console.log(`    评语: ${f.comment}（${f.reviewer}）`);
        console.log();
      }
      console.log('  💬 请查看以上反馈，帮助你在后续任务中提升评分');
    }

    break;
  }

  // ---------- complete ----------
  case 'complete': {
    const taskId = args._[1];
    const result = args.result || '';
    const notes = args.notes || '';
    const force = args.force || false;
    if (!taskId) { console.error('用法: node task.mjs complete <task_id> --result "结果" [--notes "备注"] [--force]'); process.exit(1); }
    // ai-030: 验收门禁
    const taskRow = db.prepare('SELECT description, title FROM tasks WHERE task_id=?').get(taskId);
    const validation = validateCompletion(result, taskRow ? taskRow.description : '');
    if (!validation.pass && !force) {
      console.error('❌ 验收门禁未通过，任务无法标记为已完成：');
      validation.issues.forEach((iss, i) => console.error(`  ${i + 1}. ${iss}`));
      console.error(COMPLETION_CHECKLIST);
      console.error('\n如确为无需文件改动的纯研究/讨论任务，可加 --force 跳过门禁。');
      process.exit(1);
    }
    if (validation.pass) {
      console.log(`✅ 验收门禁通过（声称改动${validation.evidence.files.length}个文件，含验证证据）`);
    } else if (force) {
      console.log('⚠️ 已使用 --force 跳过验收门禁');
    }
    const taskInfo = db.prepare('SELECT assignee, reject_reason, priority FROM tasks WHERE task_id=?').get(taskId);
    const isRework = taskInfo && taskInfo.reject_reason;
    const reworkedBy = isRework ? (taskInfo.assignee || '') : '';
    const reworkedAt = isRework ? nowStr() : '';
    const info = db.prepare(`UPDATE tasks SET status='review', result=?, notes=?, completed_at=datetime('now','localtime'),
                                reworked_by=COALESCE(NULLIF(?,''), reworked_by), reworked_at=COALESCE(NULLIF(?,''), reworked_at)
                              WHERE task_id=? AND status='in_progress'`).run(result, notes, reworkedBy, reworkedAt, taskId);
    if (info.changes === 0) {
      const r = db.prepare('SELECT status FROM tasks WHERE task_id=?').get(taskId);
      if (!r) { console.error(`任务 ${taskId} 不存在`); }
      else { console.error(`❌ 完成失败：任务状态为 ${statusLabel(r.status)}，只有进行中的任务能完成`); }
      process.exit(1);
    }
    console.log(`📤 任务 ${taskId} 已提交，等待审查（peer review：会长/审查员通过后完成，或打回重做）`);
    if (result) console.log(`结果: ${result.slice(0, 100)}${result.length > 100 ? '…' : ''}`);
    // g003-003: 完成任务增加经验值，计算等级
    // ai-026: 连击系统
    if (taskInfo.assignee) {
      const agent = db.prepare('SELECT exp, level, combo, coins FROM agents WHERE name=?').get(taskInfo.assignee);
      const oldExp = agent ? agent.exp : 0;
      const oldLevel = agent ? agent.level : 1;
      const oldCombo = agent ? agent.combo : 0;
      const oldCoins = agent ? agent.coins : 0;
      const newCombo = oldCombo + 1;
      const baseExp = taskInfo.priority >= 2 ? 30 : taskInfo.priority >= 1 ? 20 : 10;
      // 连击奖励：1连击基础，2连+10%，3连+20%，4连+30%，5连+50%
      const comboBonus = newCombo >= 5 ? 0.5 : newCombo >= 4 ? 0.3 : newCombo >= 3 ? 0.2 : newCombo >= 2 ? 0.1 : 0;
      const expGain = Math.floor(baseExp * (1 + comboBonus));
      const newExp = oldExp + expGain;
      const newLevel = Math.floor(Math.sqrt(newExp / 50)) + 1;
      // g003-005: 金币奖励（高50/中30/低10，连击额外加成）
      const baseCoins = taskInfo.priority >= 2 ? 50 : taskInfo.priority >= 1 ? 30 : 10;
      const coinGain = Math.floor(baseCoins * (1 + comboBonus));
      const newCoins = oldCoins + coinGain;
      db.prepare(`INSERT INTO agents (name, total_tasks, avg_score, exp, level, combo, coins, created_at)
                  VALUES (?, 0, 0, ?, ?, ?, ?, datetime('now','localtime'))
                  ON CONFLICT(name) DO UPDATE SET exp=excluded.exp, level=excluded.level, combo=excluded.combo, coins=excluded.coins`)
        .run(taskInfo.assignee, newExp, newLevel, newCombo, newCoins);
      const levelUp = newLevel > oldLevel;
      const comboText = newCombo >= 2 ? ` 🔥${newCombo}连击!` : '';
      const bonusText = comboBonus > 0 ? `(连击+${Math.round(comboBonus*100)}%)` : '';
      console.log(`🎯 获得 ${expGain} 经验（优先级${priorityLabel(taskInfo.priority)}${bonusText}），当前 Lv.${newLevel} (${newExp} EXP)${comboText}${levelUp ? ' 🎉升级！' : ''}`);
      console.log(`💰 获得 ${coinGain} 金币，当前余额 ${newCoins} 金币`);
    }
    // 自动归档工作记录到 memories 表（记忆集成：由配置 integrations.memoryArchive 控制开关）
    if (cfg.integrations.memoryArchive) {
    try {
      const task = db.prepare('SELECT title, description, assignee, priority FROM tasks WHERE task_id=?').get(taskId);
      if (task) {
        // 前缀 → 项目名映射（配置 tasks.projectPrefixMap 控制，默认按前缀映射，未命中归「其他」）
        const proj = (cfg.tasks.projectPrefixMap && cfg.tasks.projectPrefixMap[inferPrefix(taskId)]) || '其他';
        const imp = task.priority >= 2 ? 3 : (task.priority >= 1 ? 2 : 1);
        const descShort = (task.description || '').slice(0, 300);
        const content = `【任务】${taskId} ${task.title}\n【负责人】${task.assignee || '未知'}\n【完成时间】${new Date().toLocaleString('zh-CN')}\n【任务描述】${descShort}\n【完成结果】${result || '（无）'}`;
        const tags = JSON.stringify([taskId, task.assignee || 'unknown', proj]);
        db.prepare(`INSERT INTO memories (id, type, title, content, tags, importance, confidence, source, created_at, updated_at)
                    VALUES (?, 'work_log', ?, ?, ?, ?, 0.9, 'task_pool', datetime('now','localtime'), datetime('now','localtime'))`
        ).run(randomUUID(), `[工作记录] ${taskId} ${task.title}`, content, tags, imp);
        console.log(`📝 工作记录已归档到记忆库`);
        // ── 共享项目记忆库打通：同步写共享记忆库（走 memory.mjs 标准工具，合规）──
        const who = task.assignee || '未知';
        const shr = sharedMemory.archiveLog(`${content}`, who);
        if (shr.ok) console.log(`📚 工作记录已同步到共享项目记忆库（${who}）`);
        else console.log(`⚠️ 共享记忆库写入跳过: ${shr.error || '不可用'}`);
      }
    } catch (e) {
      console.log(`⚠️ 工作记录归档失败: ${e.message}`);
    }
    // 自动问题闭环（tool-003）
    try {
      const t = db.prepare('SELECT title, description FROM tasks WHERE task_id=?').get(taskId);
      if (t) {
        const parseTags = (s) => { try { return JSON.parse(s || '[]'); } catch { return []; } };
        let marked = 0;
        const ids = [...(t.description || '').matchAll(/来源记忆:\s*([0-9a-f-]{36})/gi)].map(m => m[1]);
        for (const id of ids) {
          const row = db.prepare('SELECT id, tags FROM memories WHERE id=?').get(id);
          if (!row) continue;
          let tags = parseTags(row.tags);
          if (tags.includes('待修复')) {
            tags = tags.filter(x => x !== '待修复');
            if (!tags.includes('已修复')) tags.push('已修复');
            db.prepare(`UPDATE memories SET tags=?, updated_at=datetime('now','localtime') WHERE id=?`).run(JSON.stringify(tags), id);
            console.log(`🔗 问题闭环：来源记忆已标记为已修复（${id.slice(0, 8)}…）`);
            marked++;
          }
        }
        const kws = [...new Set([...(t.title || '').matchAll(/[\w\u4e00-\u9fa5.\-\\/]+\.(py|js|mjs|cjs|md|db|json|vbs|txt|lua|html|css|yaml|yml|bat|ps1)/gi)].map(m => m[0].toLowerCase()))];
        if (kws.length) {
          const issues = db.prepare(`SELECT id, title, tags FROM memories WHERE type='knowledge' AND status='active' AND tags LIKE '%待修复%'`).all()
            .filter(r => parseTags(r.tags).includes('待修复'));
          for (const iss of issues) {
            const tl = iss.title.toLowerCase();
            if (kws.some(k => tl.includes(k))) {
              let tags = parseTags(iss.tags).filter(x => x !== '待修复');
              if (!tags.includes('已修复')) tags.push('已修复');
              db.prepare(`UPDATE memories SET tags=?, updated_at=datetime('now','localtime') WHERE id=?`).run(JSON.stringify(tags), iss.id);
              console.log(`🔗 问题闭环：问题「${iss.title.slice(0, 40)}…」已标记为已修复`);
              marked++;
            }
          }
        }
      }
    } catch (e) {
      console.log(`⚠️ 问题闭环标记失败: ${e.message}`);
    }
    }
    break;
  }

  // ---------- fail ----------
  case 'fail': {
    const taskId = args._[1];
    const reason = args.reason || args.result || '未知原因';
    if (!taskId) { console.error('用法: node task.mjs fail <task_id> --reason "失败原因"'); process.exit(1); }
    const info = db.prepare(`UPDATE tasks SET status='failed', result=?, completed_at=datetime('now','localtime')
                             WHERE task_id=? AND status='in_progress'`).run(reason, taskId);
    if (info.changes === 0) {
      console.error(`❌ 失败标记失败：任务不存在或不是进行中状态`);
      process.exit(1);
    }
    console.log(`❌ 任务 ${taskId} 标记为失败: ${reason}`);
    // ai-026: 失败清零连击
    const failTask = db.prepare('SELECT assignee FROM tasks WHERE task_id=?').get(taskId);
    if (failTask && failTask.assignee) {
      db.prepare(`INSERT INTO agents (name, total_tasks, avg_score, exp, level, combo, created_at)
                  VALUES (?, 0, 0, 0, 1, 0, datetime('now','localtime'))
                  ON CONFLICT(name) DO UPDATE SET combo=0`).run(failTask.assignee);
      console.log(`💔 连击已清零`);
    }
    break;
  }

  // ---------- review（peer 审查：通过 / 打回）----------
  case 'review': {
    const taskId = args._[1];
    const approve = !!args.approve;
    const reject = !!args.reject;
    if (!taskId || (!approve && !reject)) {
      console.error('用法: node task.mjs review <task_id> --approve [--c N --q N --v N --r N --comment "评语" --reviewer "审查员"]');
      console.error('      node task.mjs review <task_id> --reject --reason "打回原因" [--by "审查员"]');
      process.exit(1);
    }
    const task = db.prepare('SELECT status, assignee, title, description, result, notes, original_assignee FROM tasks WHERE task_id=?').get(taskId);
    if (!task) { console.error(`任务 ${taskId} 不存在`); process.exit(1); }
    if (task.status !== 'review') {
      console.error(`❌ 审查失败：任务状态为 ${statusLabel(task.status)}，只能审查「待审查」的任务`);
      process.exit(1);
    }
    if (reject) {
      // 打回重做（与 reject 命令同逻辑）
      const reason = args.reason || '审查未通过';
      const reviewer = args.by || args.reviewer || '审查员';
      const newTitle = (task.title || '').startsWith('[重做]') ? task.title : `[重做]${task.title || ''}`;
      const newDesc = (task.description || '') + `\n\n【被打回重做】${reason}`;
      const now = nowStr();
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
      console.log(`↩️ 任务 ${taskId} 审查不通过，已打回（审查员: ${reviewer}）：${reason}`);
      console.log(`   标题已标记 [重做]，冒险者可重新领取执行`);
    } else {
      // 通过审查
      db.prepare(`UPDATE tasks SET status='completed' WHERE task_id=?`).run(taskId);
      console.log(`✅ 任务 ${taskId} 审查通过，状态更新为已完成`);
      // 可选打分（与 score 命令同逻辑）
      const c = args.c !== undefined ? parseInt(args.c) : undefined;
      const q = args.q !== undefined ? parseInt(args.q) : undefined;
      const v = args.v !== undefined ? parseInt(args.v) : undefined;
      const rScore = args.r !== undefined ? parseInt(args.r) : undefined;
      if (c !== undefined || q !== undefined || v !== undefined || rScore !== undefined) {
        const dims = [{ val: c }, { val: q }, { val: v }, { val: rScore }];
        for (const d of dims) {
          if (d.val === undefined || isNaN(d.val) || d.val < 1 || d.val > 4) {
            console.error(`❌ 评分失败：四维度分数必须为 1-4 的整数（--c --q --v --r）`);
            process.exit(1);
          }
        }
        const total = ((c + q + v + rScore) / 4).toFixed(2);
        const reviewer = args.reviewer || '审查员';
        const comment = args.comment || '';
        db.prepare(`INSERT INTO task_scores (task_id, score_completion, score_quality, score_verification, score_record, score_total, reviewer, comment, reviewed)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
                    ON CONFLICT(task_id) DO UPDATE SET
                      score_completion=excluded.score_completion, score_quality=excluded.score_quality,
                      score_verification=excluded.score_verification, score_record=excluded.score_record,
                      score_total=excluded.score_total, reviewer=excluded.reviewer,
                      comment=excluded.comment, reviewed=0`).run(taskId, c, q, v, rScore, total, reviewer, comment);
        if (task.assignee) {
          const agent = db.prepare('SELECT total_tasks, avg_score FROM agents WHERE name=?').get(task.assignee);
          if (agent) {
            const newTotal = agent.total_tasks + 1;
            const newAvg = Math.round(((agent.avg_score || 0) * agent.total_tasks + parseFloat(total)) / newTotal * 100) / 100;
            db.prepare('UPDATE agents SET total_tasks=?, avg_score=? WHERE name=?').run(newTotal, newAvg, task.assignee);
          }
        }
        console.log(`🧭 已评分：${total} 分（完成${c}/质量${q}/验证${v}/记录${rScore}，${reviewer}）`);
      } else {
        console.log(`   提示：可用 --c --q --v --r 附带评分，或稍后用 score 命令补分`);
      }
    }
    break;
  }

  // ---------- reject ----------
  case 'reject': {
    const taskId = args._[1];
    const reason = args.reason || '未说明原因';
    const rejectedBy = args.by || args.rejected_by || '总指挥';
    if (!taskId) { console.error('用法: node task.mjs reject <task_id> --reason "打回原因" [--by "打回者"]'); process.exit(1); }
    const r = db.prepare('SELECT status, assignee, result, title, notes, original_assignee FROM tasks WHERE task_id=?').get(taskId);
    if (!r) { console.error(`任务 ${taskId} 不存在`); process.exit(1); }
    if (r.status !== 'completed' && r.status !== 'in_progress' && r.status !== 'review') {
      console.error(`❌ 打回失败：任务状态为 ${statusLabel(r.status)}，只能打回 completed / in_progress / 待审查 的任务`);
      process.exit(1);
    }
    const newTitle = (r.title || '').startsWith('[重做]') ? r.title : `[重做]${r.title || ''}`;
    const newDesc = (r.description || '') + `\n\n【被打回重做】${reason}`;
    const now = nowStr();
    const prevSubmit = (r.result || '').trim();
    const prevNotes = (r.notes || '').trim();
    const notesBlock = (prevSubmit ? `【上次提交（${now}）】${prevSubmit}\n` : '')
      + `【打回记录】${JSON.stringify({ rejected_by: rejectedBy, rejected_at: now, reject_reason: reason, original_assignee: r.assignee || '' }, null, 0)}`;
    const newNotes = prevNotes ? prevNotes + '\n' + notesBlock : notesBlock;
    db.prepare(`UPDATE tasks SET status='pending', assignee='', claimed_at='', result='',
                title=?, description=?, notes=?, completed_at='',
                original_assignee=COALESCE(NULLIF(original_assignee,''), ?),
                rejected_by=?, rejected_at=?, reject_reason=?
                WHERE task_id=?`).run(newTitle, newDesc, newNotes, r.assignee || '', rejectedBy, now, reason, taskId);
    console.log(`↩️ 任务 ${taskId} 已打回（打回者: ${rejectedBy}, 原作者: ${r.assignee || '未领取'}）：${reason}`);
    console.log(`   标题已标记 [重做]，上次提交已存入 notes，可在看板「重做」筛选里查看完整历史链`);
    // ai-026: 打回清零连击
    if (r.assignee) {
      db.prepare(`INSERT INTO agents (name, total_tasks, avg_score, exp, level, combo, created_at)
                  VALUES (?, 0, 0, 0, 1, 0, datetime('now','localtime'))
                  ON CONFLICT(name) DO UPDATE SET combo=0`).run(r.assignee);
      console.log(`💔 连击已清零`);
    }
    break;
  }

  // ---------- reset ----------
  case 'reset': {
    const taskId = args._[1];
    if (!taskId) { console.error('用法: node task.mjs reset <task_id>（将任务重置为待领取）'); process.exit(1); }
    db.prepare(`UPDATE tasks SET status='pending', assignee='', claimed_at='', result='', completed_at=''
                WHERE task_id=?`).run(taskId);
    console.log(`🔄 任务 ${taskId} 已重置为待领取`);
    break;
  }

  // ---------- score（tool-009）────────────────────
  case 'score': {
    const taskId = args._[1];
    if (!taskId) {
      console.error('用法: node task.mjs score <task_id> --c N --q N --v N --r N [--comment "评语"] [--reviewer "评分人"]');
      console.error('  四维度评分 1-4 分：completion完成度/quality质量/verification验证/record记录');
      process.exit(1);
    }
    const c = args.c !== undefined ? parseInt(args.c) : undefined;
    const q = args.q !== undefined ? parseInt(args.q) : undefined;
    const v = args.v !== undefined ? parseInt(args.v) : undefined;
    const r_score = args.r !== undefined ? parseInt(args.r) : undefined;
    const comment = args.comment || '';
    const reviewer = args.reviewer || '总指挥';

    // 校验维度分数
    const dims = [{ key: 'c', val: c, name: '完成度' }, { key: 'q', val: q, name: '质量' },
                  { key: 'v', val: v, name: '验证' }, { key: 'r', val: r_score, name: '记录' }];
    for (const d of dims) {
      if (d.val === undefined || isNaN(d.val) || d.val < 1 || d.val > 4) {
        console.error(`❌ 评分失败：${d.name} 分数必须为 1-4 的整数，收到: ${d.val}`);
        process.exit(1);
      }
    }
    const total = ((c + q + v + r_score) / 4).toFixed(2);

    // 校验任务存在且已完成
    const task = db.prepare('SELECT status, assignee FROM tasks WHERE task_id=?').get(taskId);
    if (!task) { console.error(`❌ 评分失败：任务 ${taskId} 不存在`); process.exit(1); }
    if (task.status !== 'completed') {
      console.error(`❌ 评分失败：任务 ${taskId} 状态为 ${statusLabel(task.status)}，只能评分已完成的任务`);
      process.exit(1);
    }

    // 检查是否已有评分（tool-009 修复：不静默覆盖）
    const existingScore = db.prepare('SELECT id, score_total, reviewer FROM task_scores WHERE task_id = ?').get(taskId);
    if (existingScore) {
      console.warn(`⚠️ 警告：任务 ${taskId} 已有评分（${existingScore.score_total}分，${existingScore.reviewer}评分）`);
      console.warn(`   当前操作将覆盖旧评分。如需保留请取消。`);
      // 静默继续（非阻塞），但记录警告
    }

    // INSERT OR REPLACE
    db.prepare(`INSERT INTO task_scores (task_id, score_completion, score_quality, score_verification, score_record, score_total, reviewer, comment, reviewed)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
                ON CONFLICT(task_id) DO UPDATE SET
                  score_completion=excluded.score_completion,
                  score_quality=excluded.score_quality,
                  score_verification=excluded.score_verification,
                  score_record=excluded.score_record,
                  score_total=excluded.score_total,
                  reviewer=excluded.reviewer,
                  comment=excluded.comment,
                  reviewed=0`).run(taskId, c, q, v, r_score, total, reviewer, comment);

    // 更新 agents 表统计
    if (task.assignee) {
      const stats = getAgentStats(task.assignee);
      db.prepare(`INSERT INTO agents (name, total_tasks, avg_score, created_at)
                  VALUES (?, ?, ?, datetime('now','localtime'))
                  ON CONFLICT(name) DO UPDATE SET
                    total_tasks=excluded.total_tasks,
                    avg_score=excluded.avg_score`).run(task.assignee, stats.total_tasks, stats.avg_score);
    }

    console.log(`📊 任务 ${taskId} 已评分：`);
    console.log(`   完成度:${c} 质量:${q} 验证:${v} 记录:${r_score} → 总分:${total}`);
    if (comment) console.log(`   评语: ${comment}`);
    console.log(`   评分人: ${reviewer}`);
    break;
  }

  // ---------- agents（tool-009 + Phase 1 工作区过滤）───────────
  case 'agents': {
    if (args.reset) {
      // 清除本地配置
      try { writeFileSync(AGENT_CONFIG_PATH, '', 'utf-8'); console.log('🗑️ 已清除本地执行者配置，下次 claim 将重新注册'); }
      catch (e) { console.error(`清除配置失败: ${e.message}`); }
      break;
    }
    // 从 tasks 实时聚合（与看板排行口径一致），可按工作区过滤
    const ws = resolveWorkspace(false);
    const where = ws.filter
      ? "WHERE t.workspace_id = ? AND t.status = 'completed' AND t.assignee != ''"
      : "WHERE t.status = 'completed' AND t.assignee != ''";
    const agents = ws.filter
      ? db.prepare(`SELECT t.assignee AS name, COUNT(*) AS total_tasks,
                            ROUND(AVG(ts.score_total), 2) AS avg_score, MAX(a.model) AS model,
                            MAX(a.exp) AS exp, MAX(a.level) AS level, MAX(a.combo) AS combo, MAX(a.coins) AS coins
                    FROM tasks t
                    LEFT JOIN task_scores ts ON t.task_id = ts.task_id
                    LEFT JOIN agents a ON a.name = t.assignee
                    ${where} GROUP BY t.assignee ORDER BY avg_score DESC, total_tasks DESC`).all(ws.id)
      : db.prepare(`SELECT t.assignee AS name, COUNT(*) AS total_tasks,
                            ROUND(AVG(ts.score_total), 2) AS avg_score, MAX(a.model) AS model,
                            MAX(a.exp) AS exp, MAX(a.level) AS level, MAX(a.combo) AS combo, MAX(a.coins) AS coins
                    FROM tasks t
                    LEFT JOIN task_scores ts ON t.task_id = ts.task_id
                    LEFT JOIN agents a ON a.name = t.assignee
                    ${where} GROUP BY t.assignee ORDER BY avg_score DESC, total_tasks DESC`).all();
    if (!agents.length) {
      console.log(args.json ? '[]' : '（暂无执行者记录）');
      break;
    }
    if (args.json) { console.log(JSON.stringify(agents)); break; }
    console.log(`===== 执行者统计 共 ${agents.length} 位${ws.filter ? `（工作区: ${ws.name}）` : '（全部工作区）'} =====\n`);
    for (const a of agents) {
      const avg = a.avg_score > 0 ? a.avg_score.toFixed(2) : '—';
      console.log(`  ${a.name}`);
      console.log(`    任务数: ${a.total_tasks} | 平均分: ${avg} | Lv.${a.level || 1} (${a.exp || 0} EXP) | 🔥连击${a.combo || 0} | 💰${a.coins || 0}金币`);
      if (a.model) console.log(`    模型: ${a.model}`);
      console.log();
    }
    break;
  }

  // ---------- workspaces（Phase 1 多工作区）────────────
  case 'workspaces': {
    const list = dbutil.getWorkspaces(db);
    if (!list.length) { console.log(args.json ? '[]' : '（暂无工作区）'); break; }
    if (args.json) {
      const withCount = list.map(w => ({ ...w, task_count: db.prepare('SELECT COUNT(*) c FROM tasks WHERE workspace_id = ?').get(w.id).c }));
      console.log(JSON.stringify(withCount));
      break;
    }
    console.log(`===== 工作区列表 共 ${list.length} 个 =====\n`);
    for (const w of list) {
      const cnt = db.prepare('SELECT COUNT(*) c FROM tasks WHERE workspace_id = ?').get(w.id).c;
      const tag = w.is_default ? '（默认）' : '';
      console.log(`  [${w.id}] ${w.name}${tag}${w.display_name ? ' - ' + w.display_name : ''}`);
      console.log(`    任务数: ${cnt}`);
      console.log();
    }
    console.log('提示：用 --workspace <名称> 或环境变量 AI_GUILD_WORKSPACE 指定当前工作区');
    break;
  }

  // ---------- agent --reset（tool-009 别名）───────────
  case 'agent': {
    if (args.reset) {
      try {
        if (existsSync(AGENT_CONFIG_PATH)) {
          writeFileSync(AGENT_CONFIG_PATH, '', 'utf-8');
          console.log('🗑️ 已清除本地执行者配置');
        } else {
          console.log('（暂无本地配置）');
        }
      } catch (e) { console.error(`清除配置失败: ${e.message}`); }
    } else {
      const name = readAgentConfig();
      if (name) {
        console.log(`当前注册身份: ${name}`);
        const stats = getAgentStats(name);
        console.log(`任务数: ${stats.total_tasks} | 平均分: ${stats.avg_score > 0 ? stats.avg_score.toFixed(2) : '—'}`);
      } else {
        console.log('（未注册，下次 claim 时将交互式询问）');
      }
    }
    break;
  }

  default:
    console.log(`冒险公会：任务看板 CLI

用法:
  node task.mjs create "标题" ["描述"] [--priority 0|1|2] [--prefix 前缀]
  node task.mjs list [--status pending|in_progress|completed|failed|all]
  node task.mjs show <task_id>
  node task.mjs claim <task_id> [--assignee "AI名称"]
  node task.mjs complete <task_id> --result "结果内容" [--notes "备注"]
  node task.mjs fail <task_id> --reason "失败原因"
  node task.mjs reject <task_id> --reason "打回原因" [--by "打回者"]
  node task.mjs reset <task_id>
  node task.mjs score <task_id> --c N --q N --v N --r N [--comment "评语"] [--reviewer "评分人"]
  node task.mjs agents [--workspace 工作区]
  node task.mjs workspaces
  node task.mjs agent --reset

工作区:
  --workspace <名称> 指定工作区（也可用环境变量 AI_GUILD_WORKSPACE）
  缺省：create 进「默认」工作区；list / agents 看全部工作区
  workspaces: 列出所有工作区及任务数

打分说明:
  score 四维度 1-4 分：completion完成度/quality质量/verification验证/record记录
  总分 = 四维度平均分，已打分任务再次执行则更新（会显示警告）

 agents: 列出所有执行者及统计（任务数/平均分）
 agent --reset: 清除本地配置重新注册
 claim 不带 --assignee: 交互式询问名称并自动注册

示例:
  node task.mjs create "设计任务看板的数据库表" "设计任务池的加密数据库表" --priority 2 --prefix quest
  node task.mjs list --status pending
  node task.mjs claim zhaoxi-001 --assignee "AgnesCode (Agnes-2.5-Pro)"
  node task.mjs score zhaoxi-001 --c 4 --q 3 --v 4 --r 3 --comment "结构完整，自检通过" --reviewer "总指挥"
  node task.mjs agents
`);
}

db.close();
