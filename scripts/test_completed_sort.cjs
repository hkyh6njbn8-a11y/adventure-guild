// opt-002 验收：已完成任务按完成时间倒序
// 用法: NODE_PATH=<带 jsdom 的 node_modules> node scripts/test_completed_sort.cjs
// 覆盖: 卡片顺序 == DB 按 completed_at DESC 的顺序；分页不受影响；其它分区顺序不变
const http = require('http');
const path = require('path');
const { JSDOM } = require('jsdom');

const PORT = 8767;
const HOST = '127.0.0.1';
const DB_PATH = 'C:/Users/qq862/.adventure-guild/data/memory.db';

function get(pathname) {
  return new Promise((res, rej) => {
    http.get({ host: HOST, port: PORT, path: pathname }, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => res(d));
    }).on('error', rej);
  });
}

let pass = 0, fail = 0;
function check(name, ok, extra) {
  console.log((ok ? '✅' : '❌') + ' ' + name + (extra ? ' (' + extra + ')' : ''));
  ok ? pass++ : fail++;
}

(async () => {
  // --- DB 期望顺序 ---
  const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
  const db = new Database(DB_PATH, { readonly: true });
  const all = db.prepare("SELECT task_id, completed_at FROM tasks WHERE status='completed'").all();
  const expected = all
    .slice()
    .sort((a, b) => {
      const x = a.completed_at || '', y = b.completed_at || '';
      if (!x && !y) return 0;
      if (!x) return 1;
      if (!y) return -1;
      return x < y ? 1 : x > y ? -1 : 0;
    })
    .map(t => t.task_id);

  // --- 页面实际顺序 ---
  const html = await get('/');
  // 公会看板是纯前端渲染（index.html 里 0 个 task-card，全靠 app.js 拉 /api/state 画），
  // 所以必须在页面脚本执行【之前】就注入 fetch —— 用 beforeParse，构造后再挂已经晚了。
  const dom = new JSDOM(html, {
    url: `http://${HOST}:${PORT}/`, runScripts: 'dangerously', pretendToBeVisual: true,
    // jsdom 默认不下载 <script src>，不加这个 app.js 根本不会执行、页面永远是空壳
    resources: 'usable',
    beforeParse(window) {
      window.fetch = async (url) => {
        const p = String(url).replace(/^https?:\/\/[^/]+/, '') || '/';
        const body = await get(p);
        return { ok: true, status: 200, json: async () => JSON.parse(body) };
      };
    }
  });
  const { document } = dom.window;
  await new Promise(r => setTimeout(r, 800));

  const sec = document.querySelector('[data-section="completed"]');
  check('已完成分区存在', !!sec);
  if (!sec) { console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败'); process.exit(1); }

  const ids = [...sec.querySelectorAll('.task-id')].map(n => n.textContent.trim());
  check('已完成卡片非空', ids.length > 0, ids.length + ' 张');

  // 1) 顺序 == DB 期望
  const same = JSON.stringify(ids) === JSON.stringify(expected);
  check('卡片顺序 == DB 按 completed_at DESC', same,
    '页面前5: ' + ids.slice(0, 5).join(',') + ' | 期望前5: ' + expected.slice(0, 5).join(','));

  // 1b) 验收标准原话：最新完成的必须排在第一位
  const maxAt = all.map(t => t.completed_at).filter(Boolean).sort().pop();
  const newestIds = all.filter(t => t.completed_at === maxAt).map(t => t.task_id);
  check('最新完成的任务排在第一位', newestIds.includes(ids[0]),
    '首位 ' + ids[0] + '，全库最晚完成时间 ' + maxAt + '（属于 ' + newestIds.join('/') + '）');

  // 2) 确实是倒序（相邻两条时间不递增）
  const map = new Map(all.map(t => [t.task_id, t.completed_at]));
  let mono = true, badAt = '';
  for (let i = 1; i < ids.length; i++) {
    const a = map.get(ids[i - 1]) || '', b = map.get(ids[i]) || '';
    if (a && b && a < b) { mono = false; badAt = ids[i - 1] + '(' + a + ') → ' + ids[i] + '(' + b + ')'; break; }
  }
  check('完成时间单调不递增（新→旧）', mono, badAt || '全部 ' + ids.length + ' 条有序');

  // 3) 分页不受影响：首页只显示 perPage 张，data-page 编号连续
  const grid = document.getElementById('completedGrid');
  const cards = [...grid.querySelectorAll('.task-card')];
  const shown = cards.filter(c => !c.classList.contains('hidden')).length;
  const perPage = (dom.window.STATE && dom.window.STATE.completedPerPage) || 20;
  check('首页显示数 == 每页容量', shown === Math.min(perPage, ids.length),
    shown + ' / ' + perPage + '（共 ' + ids.length + '）');
  const pages = cards.map(c => parseInt(c.dataset.page, 10));
  check('data-page 按新顺序连续分配',
    pages.every((p, i) => p === Math.floor(i / perPage) + 1),
    '前3页号: ' + pages.slice(0, 3).join(',') + ' 末页号: ' + pages[pages.length - 1]);

  // 4) 其它分区顺序不受影响（进行中/待领取仍按原规则）
  const other = document.querySelector('[data-section]');
  const sections = [...document.querySelectorAll('[data-section]')].map(s => s.getAttribute('data-section'));
  check('分区结构完整', sections.includes('completed') && sections.length >= 2, sections.join(','));

  console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常:', e); process.exit(1); });
