// 临时脚本：提交 opt-002 完成结果
// 用 .cjs 文件 + 数组传参，避免中文路径经 shell 被改编码。
const path = require('path');
const { execFileSync } = require('child_process');

const TASK = path.join(__dirname, '..', 'src', 'task.mjs');

const result = `【修改文件】D:\\冒险公会\\web\\app.js, D:\\冒险公会\\scripts\\test_completed_sort.cjs

【改动摘要】
1) web/app.js：在分组之后、赋值之前，对已完成列表按完成时间倒序排序。原代码直接沿用服务端 SQL 的顺序（ORDER BY 只有状态分段、priority、task_id），所以 ai-020 会排在 ai-002 前面。新增排序：completed_at 非空时按字符串倒序比较（格式为 YYYY-MM-DD HH:MM:SS，字典序等于时间序，无需转 Date）；缺失完成时间的脏数据排到最后，不让它霸占榜首。
2) 选择改前端而不是改 SQL 的理由：任务描述给了两个可选方案。改前端不用重启看板服务（其它冒险者可能正在线使用），改动集中在一处，且 /api/state 的数据契约不变；服务端 SQL 的 ORDER BY 保持原样，其余分区顺序完全不受影响。
3) 新增 scripts/test_completed_sort.cjs：8 条断言的端到端验收脚本（jsdom 加载真实看板 + 真实 HTTP + 直连数据库对照）。

【验证方式】
1) node --check web/app.js 前端语法检查
2) 新增测试脚本 scripts/test_completed_sort.cjs，jsdom 加载 http://127.0.0.1:8767 真实页面（mock fetch 转发到真实服务），从已完成分区提取实际卡片顺序，与 better-sqlite3 直查数据库算出的期望顺序逐条比对
3) 顺带回归分页与分区结构，确认不受影响

【验证结果】
1) node --check 语法通过
2) 测试脚本 8 通过 / 0 失败：
   - 已完成卡片 137 张，实际顺序与数据库按 completed_at 倒序算出的期望顺序完全一致
   - 最新完成的任务排在第一位（首位 g003-005，其完成时间 2026-09-01 17:24:58 为全库最晚），直接对上验收标准
   - 全部 137 条完成时间单调不递增，无逆序
   - 首页显示 20 张等于每页容量，data-page 按新顺序连续分配到第 7 页，分页逻辑不受影响
   - 分区结构完整（进行中/待领取/待审查/已取消/已完成齐全），其余分区顺序不受影响

需要向会长报告的两件事：
一、验证期间看板服务（端口 8767）处于离线状态，看门狗日志停在 9 月 2 日、自愈进程早已退出。我用 node src/dashboard_server.cjs 把它重新拉起了，但这样启动没有看门狗守护，崩了不会自愈。建议有空跑一次 start.bat 把看门狗装回去。
二、服务启动时会执行「释放因重启中断的进行中任务」，把我已领取的 opt-002 释放回了待领取池（负责人被清空），我已重新领取后才继续验证。这是公会既有的防卡死机制，不是 bug，但意味着「重启服务会打断所有进行中的任务」，最好在会长通知后再重启。`;

const notes = `只改了前端 web/app.js 一个文件（外加新增测试脚本），服务端 dashboard_server.cjs 未动。备份 web/app.js.bak_opt002_20260905_043112 与 src/dashboard_server.cjs.bak_opt002_20260905_043112（后者是预防性备份，实际未修改）。`;

try {
  const out = execFileSync(process.execPath, [TASK, 'complete', 'opt-002', '--result', result, '--notes', notes],
    { encoding: 'utf8', cwd: path.join(__dirname, '..'), stdio: 'pipe' });
  console.log(out);
} catch (e) {
  console.log('退出码:', e.status);
  console.log(e.stdout || '');
  console.error(e.stderr || '');
}
