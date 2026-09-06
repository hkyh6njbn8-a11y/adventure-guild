#!/usr/bin/env node
/**
 * complete_validator.mjs — 任务完成前置校验工具
 *
 * 用途：在任务标记完成前，验证声称改动的文件是否真实存在/被修改。
 * 用法：node complete_validator.mjs <task_id> <result_text> [工作目录]
 *
 * 示例：
 *   node complete_validator.mjs ai-001 "已创建 index.html" <冒险公会安装目录>
 */

// fix-003: 本文件是 .mjs（ES Module），不能用 CommonJS 的 require，
// 否则运行即报 ReferenceError: require is not defined in ES module scope。
import fs from 'node:fs';
import path from 'node:path';

// ─── 参数解析 ───────────────────────────────────────────
const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('用法：node complete_validator.mjs <task_id> <result_text> [工作目录]');
  process.exit(1);
}

const taskId = args[0];
const resultText = args[1];
const workDir = args[2] || process.cwd();

// ─── 提取文件路径 ───────────────────────────────────────
function extractFilePaths(text) {
  const paths = new Set();
  // fix-003: 原正则有两个致命缺陷——
  //   (1) Windows 段 [^\s'"\\]+ 排除了反斜杠，所以 D:\公会\src\task.mjs 只能截出
  //       最后两段（src\task.mjs），工作目录之外的文件永远校验不到；
  //   (2) 完全没有 Windows 的 .mjs/.cjs 分支，而公会 src/ 下全是 .mjs，
  //       等于对本项目的文件改动 100% 漏检。
  // 现在改为「绝对路径优先 + 相对路径兜底」，扩展名统一收进 EXT。
  // opt-032: 扩展名白名单补 dart/yaml/yml/md/json（反馈2：Flutter 工程不再被误判「无文件改动」）
  const EXT = '(?:dart|yaml|yml|md|json|mjs|cjs|js|html|css|py|ts|tsx|jsx|xml|txt|sh|go|java|kt|swift)';
  const SAFE = "[^\\s'\"`*?<>|]";   // 路径里不该出现的字符（含空白与文件名非法字符）
  const patterns = [
    // Windows 绝对路径（含盘符）—— 必须排在最前，否则会被相对路径规则截断
    new RegExp(`[A-Za-z]:${SAFE}*\\.${EXT}\\b`, 'g'),
    // Unix 绝对路径
    new RegExp(`/(?:${SAFE}*/)*${SAFE}*\\.${EXT}\\b`, 'g'),
    // Windows 相对路径（含反斜杠、无盘符）
    new RegExp(`${SAFE}*\\\\${SAFE}*\\.${EXT}\\b`, 'g'),
    // Unix 相对路径（含斜杠、无前导 /）
    new RegExp(`${SAFE}*/${SAFE}*\\.${EXT}\\b`, 'g'),
  ];

  for (const pat of patterns) {
    let m;
    while ((m = pat.exec(text)) !== null) {
      paths.add(m[0]);
    }
  }

  // 也匹配相对路径引用（如 src="script.js"）——opt-032: 扩展名收进 EXT 动态生成
  const EXT_SRC = EXT.replace('(?:', '').replace(')', '');
  const relPatterns = [
    new RegExp('src=["\']([^"\']+\\.(?:' + EXT_SRC + '))["\']', 'g'),
    new RegExp('href=["\']([^"\']+\\.(?:' + EXT_SRC + '))["\']', 'g'),
  ];
  for (const pat of relPatterns) {
    let m;
    while ((m = pat.exec(text)) !== null) {
      paths.add(m[1]);
    }
  }

  // fix-003: 绝对路径规则会连同其尾部的相对路径一起命中（D:\a\b.mjs 与 b.mjs），
  // 不去重会校验两遍、输出重复项。保留最长的那条。
  const norm = s => String(s).replace(/\//g, '\\').toLowerCase();
  const arr = Array.from(paths);
  return arr.filter(p => {
    const np = norm(p);
    return !arr.some(q => q !== p && norm(q).length > np.length && norm(q).endsWith(np));
  });
}

// ─── 验证文件 ───────────────────────────────────────────
function validateFile(filePath, workDir) {
  // 如果是绝对路径，直接检查
  if (path.isAbsolute(filePath)) {
    const exists = fs.existsSync(filePath);
    const stat = exists ? fs.statSync(filePath) : null;
    return {
      path: filePath,
      exists,
      size: stat ? stat.size : 0,
      modified: stat ? stat.mtime.toISOString() : null,
      isFile: stat ? stat.isFile() : false
    };
  }

  // 相对路径：尝试多个可能位置
  const candidates = [
    path.join(workDir, filePath),
    path.join(workDir, 'web', filePath),
    path.join(workDir, 'src', filePath),
    filePath  // 当前目录
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      const stat = fs.statSync(candidate);
      return {
        path: candidate,
        exists: true,
        size: stat.size,
        modified: stat.mtime.toISOString(),
        isFile: stat.isFile()
      };
    }
  }

  return {
    path: filePath,
    exists: false,
    size: 0,
    modified: null,
    isFile: false
  };
}

// ─── 主逻辑 ─────────────────────────────────────────────
console.log(`\n🔍 完成校验：${taskId}`);
console.log(`   工作目录：${workDir}`);
console.log(`   结果文本长度：${resultText.length} 字符\n`);

const filePaths = extractFilePaths(resultText);
console.log(`📁 提取到 ${filePaths.length} 个文件路径：`);

// opt-032: 提取不到文件时降级为警告（不硬拦，避免误杀 Flutter/纯说明类任务）
let allValid = true;
let degradedWarning = null;
const results = [];
if (filePaths.length === 0) {
  degradedWarning = '⚠️ 未从 result 文本提取到任何文件路径——已降级为警告而非打回，请人工确认 result 是否列出真实改动文件（支持 dart/yaml/yml/md/json 等扩展名）。';
  console.log(degradedWarning);
}

for (const fp of filePaths) {
  const v = validateFile(fp, workDir);
  results.push(v);

  if (!v.exists) {
    console.log(`  ❌ ${v.path} — 不存在`);
    allValid = false;
  } else {
    console.log(`  ✅ ${v.path} — ${v.size} 字节，修改于 ${v.modified}`);
  }
}

console.log(`\n${allValid ? '✅ 所有声称改动文件均已验证存在' : '⚠️ 发现缺失文件，任务可能为假完成'}`);

// 输出 JSON 供后续处理
process.stdout.write(JSON.stringify({
  task_id: taskId,
  work_dir: workDir,
  all_valid: allValid,
  files: results,
  warning: degradedWarning
}, null, 2));
