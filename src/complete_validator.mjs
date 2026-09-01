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

const fs = require('fs');
const path = require('path');

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
  // 匹配常见路径格式
  const patterns = [
    /[^\s'"`\\]+\\[^\s'"`\\]+\.js[^\s'"`\\]*/g,  // Windows .js
    /[^\s'"`\\]+\\[^\s'"`\\]+\.html[^\s'"`\\]*/g, // Windows .html
    /[^\s'"`\\]+\\[^\s'"`\\]+\.css[^\s'"`\\]*/g,  // Windows .css
    /[^\s'"`\\]+\\[^\s'"`\\]+\.py[^\s'"`\\]*/g,   // Windows .py
    /[^\s'"`\\]+\/[^\s'"`\\]+\.js[^\s'"`\\]*/g,   // Unix .js
    /[^\s'"`\\]+\/[^\s'"`\\]+\.html[^\s'"`\\]*/g, // Unix .html
    /[^\s'"`\\]+\/[^\s'"`\\]+\.css[^\s'"`\\]*/g,  // Unix .css
    /[^\s'"`\\]+\/[^\s'"`\\]+\.py[^\s'"`\\]*/g,   // Unix .py
    /[^\s'"`\\]+\/[^\s'"`\\]+\.mjs[^\s'"`\\]*/g,  // Unix .mjs
    /[^\s'"`\\]+\/[^\s'"`\\]+\.cjs[^\s'"`\\]*/g,  // Unix .cjs
  ];

  for (const pat of patterns) {
    let m;
    while ((m = pat.exec(text)) !== null) {
      paths.add(m[0]);
    }
  }

  // 也匹配相对路径引用（如 src="script.js"）
  const relPatterns = [
    /src=["']([^"']+\.js)["']/g,
    /src=["']([^"']+\.mjs)["']/g,
    /href=["']([^"']+\.css)["']/g,
    /href=["']([^"']+\.html)["']/g,
  ];
  for (const pat of relPatterns) {
    let m;
    while ((m = pat.exec(text)) !== null) {
      paths.add(m[1]);
    }
  }

  return Array.from(paths);
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

let allValid = true;
const results = [];

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
  files: results
}, null, 2));
