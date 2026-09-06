// fix-003: complete_validator.mjs 路径提取能力测试
// 用法: node scripts/test_validator_paths.cjs
// 目的：固定「提取文件路径」的行为基线，改正则前后各跑一次，只允许变好不许变坏。
// 注意：package.json 是 type:commonjs，所以测试脚本必须用 .cjs 后缀。
const path = require('path');
const { execFileSync } = require('child_process');

const NODE = process.execPath;
const VALIDATOR = path.join(__dirname, '..', 'src', 'complete_validator.mjs');
const WORKDIR = path.join(__dirname, '..');

// 用真实存在的文件做用例（src 下全是 .mjs，正是公会主力扩展名）
const REAL_MJS = 'D:\\冒险公会\\src\\complete_validator.mjs';
const REAL_MJS2 = 'D:\\冒险公会\\src\\task.mjs';
const REAL_CJS = 'D:\\冒险公会\\scripts\\test_validator_paths.cjs';

const cases = [
  { name: 'Windows 绝对路径 .mjs', text: `改了 ${REAL_MJS}`, must: [REAL_MJS] },
  { name: 'Windows 绝对路径 .mjs（第二个）', text: `改了 ${REAL_MJS2}`, must: [REAL_MJS2] },
  { name: 'Windows 绝对路径 .cjs', text: `改了 ${REAL_CJS}`, must: [REAL_CJS] },
  { name: 'Windows 绝对路径 .js 不被截断',
    text: '改了 D:\\冒险公会\\src\\y.js',
    must: ['D:\\冒险公会\\src\\y.js'],
    mustNot: ['src\\y.js'] },
  { name: 'Windows 相对路径 .mjs', text: '改了 src/complete_validator.mjs', must: ['src/complete_validator.mjs'] },
  { name: 'Unix 相对路径 .js（既有能力）', text: '改了 web/app.js', must: ['web/app.js'] },
  { name: 'Unix 相对路径 .mjs（既有能力）', text: '改了 src/task.mjs', must: ['src/task.mjs'] },
  { name: 'HTML src 引用（既有能力）', text: '<script src="foo.js"></script>', must: ['foo.js'] },
  { name: '中文标点不粘连', text: '改了 web/app.js，还改了别的', must: ['web/app.js'], mustNot: ['web/app.js，还改了别的'] },
  { name: '多个路径一次提取',
    text: `改了 ${REAL_MJS} 和 ${REAL_MJS2}`,
    must: [REAL_MJS, REAL_MJS2] },
];

function run(resultText) {
  try {
    const out = execFileSync(NODE, [VALIDATOR, 'test', resultText, WORKDIR],
      { encoding: 'utf8', timeout: 15000 });
    // 只取 stdout 里的 JSON 部分（从第一个 { 开始）
    const i = out.indexOf('{');
    if (i < 0) return null;
    return JSON.parse(out.slice(i));
  } catch (e) {
    return { __error: String(e.message || e).slice(0, 300) };
  }
}

let pass = 0, fail = 0;
for (const c of cases) {
  const r = run(c.text);
  if (!r || r.__error) {
    console.log('❌ ' + c.name + ' — 运行失败: ' + (r ? r.__error : '无 JSON 输出'));
    fail++;
    continue;
  }
  // 注意：相对路径会被 validateFile 解析成绝对路径返回，所以按「后缀匹配」判定
  const norm = s => String(s).replace(/\//g, '\\').toLowerCase();
  const got = (r.files || []).map(f => f.path);
  const gotN = got.map(norm);
  const has = m => gotN.some(g => g === norm(m) || g.endsWith('\\' + norm(m)));
  const missing = (c.must || []).filter(m => !has(m));
  // mustNot 用精确匹配：完整路径以短路径结尾是正常的，不能按后缀判定
  const extra = (c.mustNot || []).filter(m => gotN.includes(norm(m)));
  const ok = missing.length === 0 && extra.length === 0;
  console.log((ok ? '✅' : '❌') + ' ' + c.name);
  if (!ok) {
    console.log('     提取到: ' + JSON.stringify(got, null, 0));
    if (missing.length) console.log('     缺失: ' + JSON.stringify(missing));
    if (extra.length) console.log('     不该有: ' + JSON.stringify(extra));
  }
  ok ? pass++ : fail++;
}

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
