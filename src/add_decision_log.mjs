#!/usr/bin/env node
/**
 * add_decision_log.mjs — 总指挥决策经验沉淀工具
 *
 * 用法：
 *   node add_decision_log.mjs <任务ID> "决策摘要" "结果" "教训" [--who "总指挥"]
 *
 * 示例：
 *   node add_decision_log.mjs ai-030 "在complete命令添加文件存在性+验证证据门禁" "假完成被拦截，合法提交通过" "门禁正则需排除中文标点，const不能放switch体内"
 *
 * 写入记忆库，type=fact，标题含任务ID，内容结构化，可被 search 检索。
 */

import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const MEMORY_CLI = `node "${path.join(SRC_DIR, 'memory.mjs')}"`;

function parseArgs(argv) {
  const positional = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      opts[key] = argv[i + 1] || true;
      i++;
    } else {
      positional.push(argv[i]);
    }
  }
  return { positional, opts };
}

const { positional, opts } = parseArgs(process.argv.slice(2));

if (positional.length < 4) {
  console.log(`总指挥决策沉淀工具

用法：
  node add_decision_log.mjs <任务ID> "决策摘要" "结果" "教训" [--who "总指挥"]

示例：
  node add_decision_log.mjs ai-030 "添加验收门禁" "假完成被拦截" "const不能放switch体内"
`);
  process.exit(1);
}

const [taskId, decision, result, lesson] = positional;
const who = opts.who || '总指挥AI';
const now = new Date().toLocaleString('zh-CN');

const title = `[决策沉淀] ${taskId}: ${decision.slice(0, 40)}`;
const content = `任务ID: ${taskId}
时间: ${now}
决策: ${decision}
结果: ${result}
教训/经验: ${lesson}`;

try {
  const cmd = `${MEMORY_CLI} add ${JSON.stringify(title)} ${JSON.stringify(content)} --type fact --who ${JSON.stringify(who)}`;
  const out = execSync(cmd, { encoding: 'utf8', cwd: SRC_DIR });
  console.log(`✅ 决策已沉淀到记忆库`);
  console.log(out.trim());
  console.log(`\n检索验证: node memory.mjs search "${taskId}"`);
} catch (e) {
  console.error(`❌ 写入失败: ${e.message}`);
  process.exit(1);
}
