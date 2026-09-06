// config.cjs — 冒险公会：任务看板 配置加载模块
// 设计原则：代码目录只放程序；配置与数据放在用户目录（默认 ~/.adventure-guild/），不硬编码绝对路径。
// 优先级：默认配置 < 用户配置（~/.adventure-guild/config.json）< 环境变量（AI_GUILD_DATA 指定数据目录）
// 用法：CommonJS `const cfg = require('./lib/config.cjs')`；ESM `import cfg from './lib/config.cjs'`
//       导出即合并后的配置对象：cfg.app.title / cfg.server.port / cfg.tasks.* / cfg.integrations.* 等，
//       同时附工具属性 cfg.DB_PATH / cfg.ensureDirs() / cfg.getConfig()。

const os = require('os');
const path = require('path');
const fs = require('fs');

// 产品根目录：本文件位于 <产品根>/src/lib/config.cjs → 上溯两级
const PRODUCT_ROOT = path.resolve(__dirname, '..', '..');

// 默认配置
const DEFAULT_CONFIG = {
  app: {
    name: '冒险公会',               // 产品名
    title: '冒险公会 · 任务看板',     // 页面标题
    footer: '冒险公会任务看板 · 动态服务模式'
  },
  guild: {
    // opt-022: 公会管理层——总会长（执事从 projects 表 leader 字段读取，无需配置）
    chiefLeader: '豆包 (Doubao-MainAgent)'
  },
  server: {
    host: '127.0.0.1',
    port: 8765,
    refreshMs: 30000,              // AJAX 自动刷新间隔
    completedPerPage: 20,          // 已完成任务每页条数
    modelsPerPage: 10              // 执行者排行每页条数
  },
  tasks: {
    defaultPrefix: 'quest',        // 新建任务默认 ID 前缀（未指定且无法推断时）
    allowedPrefixes: ['quest', 'zhaoxi', 'tool', 'fix'], // 看板新建表单可选前缀
    createdByDefault: '工会会长',   // 新建任务默认创建人（角色制，不绑定具体 AI）
    creatorOptions: ['工会会长', '用户', '冒险者'], // 创建人下拉选项（通用角色，可自定义）
    projectPrefixMap: {            // 前缀 → 项目名映射（complete 归档工作记录时使用）
      zhaoxi: '项目A',
      quest: '任务',
      tool: '工具'
    }
  },
  scoring: {
    // 评分维度配置（Phase 3 会扩展为可增删/权重，Phase 0 先保持四维固定但由配置驱动名称）
    dimensions: [
      { key: 'completion',   name: '完成度' },
      { key: 'quality',      name: '质量' },
      { key: 'verification', name: '验证' },
      { key: 'record',       name: '记录' }
    ],
    min: 1,
    max: 4
  },
  integrations: {
    // 记忆集成开关：complete 时自动写工作记录到 memories 表 + 问题闭环标记
    // 数据（memories 表）始终迁移；此开关只控制 complete 的自动写入行为
    memoryArchive: true,
    // 共享项目记忆库（路径可配置，见 SHARED_MEMORY_DIR）：所有 AI 共用的项目上下文。
    // 打通后：搜索读双库（共享优先），完成任务自动写共享库（走其 memory.mjs 标准工具）。
    sharedMemoryDir: 'D:/MemoryBank/公共漏斗库'
  },
  ai: {
    // 内置 AI 项目管理：总指挥 AI 拆解目标派任务，工人 AI 领取执行
    // apiKey 为敏感凭证，仅存于用户目录 config.json，不进代码/文档
    enabled: false,               // 总开关：设置页/CLI 可开启
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    apiKey: '',
    directorModel: 'deepseek-v4-flash-ga-260731',  // 总指挥 AI 模型
    workerModel: 'deepseek-v4-flash-ga-260731',    // 工人 AI 模型
    maxTasks: 8,                  // 单次拆解最大任务数
    workerPrefix: 'ai',           // AI 拆解任务的前缀
    autoRun: true,                // 总指挥自主管理：定期按目标规划拆任务（发布到池子）、巡查处置异常任务（重置/取消/补建）。执行不自动——由外部 AI 工人或人工领取
    autoRunInterval: 20,          // 后台检查间隔（秒）
    autoRunMaxWorkers: 2,         // 保留字段（当前"管理不执行"，不再自动派内置工人）
    staleMinutes: 30,             // 进行中任务超过该分钟数视为卡住，自动重置回待领取
    patrolInterval: 5             // 总指挥自主巡查间隔（分钟）：审视任务池，自主重置/取消/补建任务
  }
};

// 数据目录：环境变量 AI_GUILD_DATA 优先，否则用户目录 ~/.adventure-guild
function resolveDataDir() {
  if (process.env.AI_GUILD_DATA && process.env.AI_GUILD_DATA.trim()) {
    return path.resolve(process.env.AI_GUILD_DATA.trim());
  }
  return path.join(os.homedir(), '.adventure-guild');
}

const DATA_DIR = resolveDataDir();
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const DB_PATH = path.join(DATA_DIR, 'data', 'memory.db');
const AGENT_CONFIG_PATH = path.join(DATA_DIR, 'agent_name'); // 替代旧的 ~/.zhaoxi_agent_name

// 确保数据目录存在（可写目录，建库/写配置前调用）
function ensureDirs() {
  fs.mkdirSync(path.join(DATA_DIR, 'data'), { recursive: true });
  return DATA_DIR;
}

// 读取用户配置文件（损坏时不阻断，返回空对象）
function readUserConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      // 剥掉 UTF-8 BOM（Windows 记事本/PowerShell 常见），避免 JSON 解析失败
      const raw = fs.readFileSync(CONFIG_FILE, 'utf-8').replace(/^\uFEFF/, '');
      return JSON.parse(raw);
    }
  } catch (e) {
    console.warn(`⚠️ 配置读取失败（${CONFIG_FILE}）：${e.message}，将使用默认配置`);
  }
  return {};
}

// 深合并：用户配置覆盖默认配置（对象递归，数组直接替换）
function mergeDeep(base, extra) {
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  for (const k of Object.keys(extra || {})) {
    if (extra[k] && typeof extra[k] === 'object' && !Array.isArray(extra[k]) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = mergeDeep(base[k], extra[k]);
    } else {
      out[k] = extra[k];
    }
  }
  return out;
}

// 保存用户配置（partial 深合并到现有用户配置，写回 config.json）
// 返回写入后的完整用户配置对象
function saveUserConfig(partial) {
  ensureDirs();
  const current = readUserConfig();
  const merged = mergeDeep(current, partial || {});
  const json = JSON.stringify(merged, null, 2);
  fs.writeFileSync(CONFIG_FILE, json, 'utf-8');
  return merged;
}

// 合并后的配置（进程内静态）
const _merged = mergeDeep(DEFAULT_CONFIG, readUserConfig());

// 导出：合并配置 + 工具属性
module.exports = Object.assign(_merged, {
  PRODUCT_ROOT,
  DATA_DIR,
  CONFIG_FILE,
  DB_PATH,
  AGENT_CONFIG_PATH,
  ensureDirs,
  saveUserConfig,
  getConfig: () => _merged
});
