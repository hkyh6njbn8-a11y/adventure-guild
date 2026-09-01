# 冒险公会：任务看板

多 AI 协作任务管理平台 —— 任务池分发 + peer 审查 + 项目隔离 + 共享记忆 + 角色化接入。

**为什么做这个**：为了白嫖国内各种免费的 AI 工具所创建的项目——豆包、Agnes、DeepSeek、WorkBuddy 等各有免费额度，单独用太浪费；把它们凑在一起当「冒险者」分工干活，让每个 AI 的免费额度都物尽其用，多 AI 协作产生 1+1>2 的价值。

- **工会会长**（人类管理员或任命的 AI）创建任务、验收打分、打回重做，只管理不执行
- **冒险者**（任何 AI 工人）从任务池领取任务、执行、提交，一段提示词即可接入
- 任务提交后进入「待审查」，审查员通过才完成（peer review），不合格打回重做
- 项目级数据隔离（按任务前缀/记忆关键词归属项目），共享记忆库打通（换 AI 不丢上下文）

> **开源说明**：本仓库只含程序代码。**运行数据默认存于用户目录 `~/.adventure-guild/`**（任务/评分/执行者/配置，含 API Key），不随仓库分发。共享记忆库通过 `integrations.sharedMemoryDir` 或环境变量 `SHARED_MEMORY_DIR` 配置，未配置则自动禁用该功能。API Key 只填在用户目录的 `config.json`，代码和文档中只有占位符。

## 快速开始

```powershell
cd <冒险公会安装目录>   # 例如 D:\冒险公会

# 1.（可选）从旧库迁移数据（旧库只读，不修改）
node migrate\migrate_legacy.cjs

# 2.（首次）安装依赖（若 node_modules 缺失）
npm install

# 3. 一键启动看板
start.bat
```

启动后浏览器自动打开（端口由 `~/.adventure-guild/config.json` 的 `server.port` 决定；默认 8765，被占则自动 +1 并写回配置，无需手动处理）。

> **服务自愈**：`start.bat` 启动的是后台看门狗（`watchdog.mjs`），每 20 秒探测看板，挂了自动拉起；开机自启已注册（启动文件夹「冒险公会自愈.vbs」，静默运行）。日常无需手动启动；看板异常时可查 `watchdog.log`（看门狗记录）和 `srv-err.log`（崩溃原因）。

## 目录结构

```
D:\冒险公会\
├── start.bat               # 一键启动看板（自愈版：已运行则直接开浏览器；未运行则清僵尸+起看门狗）
├── watchdog.mjs            # 看门狗：每20秒探测，服务挂了自动拉起（开机自启）
├── backup.bat              # 数据备份（memory.db + config.json）
├── srv-out.log             # 看板运行日志（watchdog 拉起时追加）
├── srv-err.log             # 看板错误日志（崩溃原因在此，watchdog 拉起时追加）
├── watchdog.log            # 看门狗自身日志（启动/探测/重启记录）
├── package.json            # 本地依赖（better-sqlite3）
├── worker-example.mjs      # AI 工人示例（轮询→领取→执行→提交）
├── scripts\
│   ├── find-port.ps1       # 自动找可用端口（被占 +1，最多 20 次）
│   └── open-browser.ps1    # 轮询等端口就绪后自动开浏览器
├── src\
│   ├── task.mjs            # CLI（任务池管理，支持 --json）
│   ├── ai.mjs              # 内置 AI 项目管理 CLI（direct/work/status）
│   ├── dashboard_server.cjs# Web 看板服务 + Worker API + AI API + 对话 API
│   ├── memory.mjs          # 本地记忆读写 CLI（供总指挥搜索记忆）
│   ├── patrol.mjs          # 总指挥自主巡查 CLI（重置/取消/补建任务）
│   ├── complete_validator.mjs # 任务完成前置校验（验证声称改动的文件真实存在）
│   ├── dispatch_priority.mjs  # 任务优先级派发工具
│   ├── add_decision_log.mjs   # 决策记录写入工具
│   ├── check_tables.mjs       # 建表/表结构检查
│   └── lib\
│       ├── config.cjs      # 配置加载（默认 + 用户覆盖 + 保存）
│       ├── ai.cjs          # LLM 调用封装（OpenAI 兼容，含工具调用）
│       ├── agent.cjs       # 全自主 Agent：总指挥循环 + 工人执行（Phase 7）
│       └── db.cjs          # 数据库路径/初始化/建表（CLI 与看板共用）
├── migrate\
│   └── migrate_legacy.cjs  # 旧库全表迁移工具
├── docs\
│   ├── AI_WORKER_PROTOCOL.md  # AI 工人接入协议文档（技术细节：CLI/HTTP）
│   ├── RECRUIT.md             # ⚔️ 冒险者招募令（整段复制给任意 AI 即可加入）
│   ├── LEADER_PROTOCOL.md     # 👑 工会会长上岗提示词（整段复制给主脑 AI）
│   └── COMPLETE_CHECKLIST_TEMPLATE.md # 任务完成清单模板
└── web\                    # 前端静态资源
    ├── index.html          # 侧边栏导航 + 看板/统计/设置三视图
    ├── style.css           # 深色纯色简洁主题
    ├── app.js              # 状态管理 / 筛选 / 分页 / 打分 / 设置
    ├── ranking.js/css      # 排行榜视图
    ├── achievements.js/css # 成就/徽章视图
    └── patrol_log.json     # 巡查日志（运行时生成）
```

## 配置

配置与数据存放在**用户目录**（默认 `~/.adventure-guild/`），不硬编码路径。

- 数据目录可用环境变量 `AI_GUILD_DATA` 覆盖
- 用户配置文件：`~/.adventure-guild/config.json`（不存在则用默认值）
- 看板「设置」页可直接编辑并保存配置（端口/刷新/分页/前缀/创建人/评分维度）

常用配置项（完整见 `src/lib/config.cjs`）：

```json
{
  "app": { "name": "冒险公会", "title": "冒险公会 · 任务看板" },
  "server": { "host": "127.0.0.1", "port": 8765, "refreshMs": 30000, "completedPerPage": 20, "modelsPerPage": 10 },
  "tasks": {
    "defaultPrefix": "quest",
    "allowedPrefixes": ["quest", "tool", "fix"],
    "createdByDefault": "工会会长",
    "creatorOptions": ["工会会长", "用户", "冒险者"],
    "projectPrefixMap": { "zhaoxi": "项目A", "quest": "任务", "tool": "工具" }
  },
  "scoring": {
    "min": 1, "max": 4,
    "dimensions": [
      { "key": "completion", "name": "完成度" },
      { "key": "quality", "name": "质量" },
      { "key": "verification", "name": "验证" },
      { "key": "record", "name": "记录" }
    ]
  },
  "integrations": { "memoryArchive": true },
  "ai": {
    "enabled": true,
    "baseUrl": "https://ark.cn-beijing.volces.com/api/v3",
    "apiKey": "ark-你的火山方舟APIKey",
    "directorModel": "deepseek-v4-flash-ga-260731",
    "workerModel": "deepseek-v4-flash-ga-260731",
    "maxTasks": 8,
    "workerPrefix": "ai"
  }
}
```

> `scoring.dimensions`：评分维度名称和范围可配置，key 固定（completion/quality/verification/record）。
> `integrations.memoryArchive`：完成任务时是否自动写工作记录 + 问题闭环（记忆集成开关）。
> `integrations.sharedMemoryDir`：共享项目记忆库路径（可通过环境变量 `SHARED_MEMORY_DIR` 覆盖，未配置则禁用）。打通后：任务完成自动同步工作日志到共享库；搜索双库合并；看板「📚 项目记忆」视图可浏览/搜索。外部 AI 也可直接调 `GET /api/memory?kw=&limit=` 查项目上下文。
> `ai`：内置 AI 项目管理。`apiKey` 为 OpenAI 兼容 API Key，`directorModel` 为总指挥拆解模型、`workerModel` 为工人执行模型，`maxTasks` 为单次拆解最多子任务数，`workerPrefix` 为 AI 派发任务的 ID 前缀。API Key 只存本地 config.json，看板 API 返回时自动打码。

## CLI 用法

```powershell
node src\task.mjs create "标题" "描述" [--priority 0|1|2] [--prefix quest] [--workspace 工作区]
node src\task.mjs list [--status pending|in_progress|review|completed|failed|all] [--workspace 工作区] [--json]
node src\task.mjs show <task_id> [--json]
node src\task.mjs claim <task_id> [--assignee "AI名称"]
node src\task.mjs complete <task_id> --result "结果" [--notes "备注"]   # 提交后进入「待审查」，不直接完成
node src\task.mjs review <task_id> --approve [--c N --q N --v N --r N --comment "评语" --reviewer "审查员"]  # peer 审查通过（可选打分）
node src\task.mjs review <task_id> --reject --reason "打回原因" [--by "审查员"]                              # peer 审查打回
node src\task.mjs fail <task_id> --reason "原因"
node src\task.mjs reject <task_id> --reason "打回原因" [--by "打回者"]
node src\task.mjs reset <task_id>
node src\task.mjs score <task_id> --c N --q N --v N --r N [--comment "评语"] [--reviewer "评分人"]
node src\task.mjs agents [--workspace 工作区] [--json]
node src\task.mjs workspaces [--json]
```

- **peer 审查流程**：冒险者 `complete` 提交后，任务进入 `review`（🔍 待审查）而不是直接完成；审查员（会长/评审员）用 `review --approve` 通过（可附带四维打分，一步完成），或 `review --reject` 打回重做。看板「🔍 待审查」筛选区可看到待审任务，卡片上有「✅ 通过审查 / ↩️ 打回」按钮。

- `--json`：list/show/agents/workspaces 输出结构化 JSON，便于程序解析
- 打分维度和分数范围由配置 `scoring` 决定（默认四维 1-4 制，总分 = 平均）

## AI 工人接入

**角色体系**（谁当什么，一眼看懂）：

| 角色 | 职责 | 提示词文档 |
|---|---|---|
| 👑 工会会长（主脑） | 规划/派活/巡查/验收打分，**只管理不执行** | `docs/LEADER_PROTOCOL.md` |
| ⚔️ 冒险者（工人） | 领活/执行/提交 | `docs/RECRUIT.md`（招募令，整段复制即可加入） |
| 🔍 审查员（审代码） | 代码任务提交后校验+抽查 | 见 LEADER_PROTOCOL（complete_validator.mjs） |
| ⭐ 评审员（打分） | 独立验收打分，避免自评 | 见 LEADER_PROTOCOL（score 命令） |

> **看板内直接生成提示词**：侧边栏「📣 招募令」页可一键复制冒险者招募令 / 会长上岗提示词，发给任意 AI 即完成接入；后端 `GET /api/recruit` 同效。

两种接入方式，任选其一：

### HTTP API（推荐，远程 AI 无本地盘也能用）

```
GET  /api/worker/pending?workspace=可选      # 待领取任务列表
GET  /api/worker/task?task_id=xxx            # 任务详情（含评分）
POST /api/worker/claim    {task_id, assignee} # 领取（原子操作）
POST /api/worker/complete {task_id, result, notes}  # 完成
POST /api/worker/fail     {task_id, reason}  # 标记失败
```

全部返回 JSON。详见 `docs/AI_WORKER_PROTOCOL.md`。

### 示例 Worker

```powershell
node worker-example.mjs --name "MyAI (model-v1)" --url http://127.0.0.1:8765 --interval 30
```

轮询待领取任务 → 领取 → 执行 → 提交完成。替换 `doWork()` 为真实逻辑即可。

## 内置 AI 项目管理（面板内置模型）

看板顶栏「✨ AI 派发」可在界面内直接使用大模型进行项目管理和任务派发，无需单独起 Worker 进程：

- **总指挥 AI**：输入一个目标（如"做一个番茄钟应用"），内置模型自动拆解为多个子任务并派发到任务池（带优先级）。
- **工人 AI**：从待领取池领取任务，调用模型生成执行结果并提交完成。

后端 API（前端看板已集成，也可命令行调用）：

```
GET  /api/ai/status                  # AI 配置与任务池摘要
POST /api/ai/direct  {goal}          # 总指挥 AI 拆解并派发（异步，返回 job_id）
POST /api/ai/work    {assignee}      # 工人 AI 领取执行一个任务（异步，返回 job_id）
GET  /api/ai/result?job_id=xxx       # 轮询异步任务结果
```

AI 调用为**异步任务**模式：请求立即返回 `job_id`，后台执行，前端轮询结果，不阻塞服务器、不因浏览器断连而崩溃。

命令行用法：

```powershell
node src\ai.mjs status
node src\ai.mjs direct "你的目标" [--workspace 工作区]
node src\ai.mjs work --once [--assignee "AI名称"] [--workspace 工作区]
```

> 说明：AI 调用走火山方舟 API（独立计费，新用户有免费额度）。豆包专业版订阅额度不提供 API 调用，无法路由到本产品。

## 全自主 AI 助手（对话式 + 目标驱动，Phase 7）

> ⚠️ 看板界面已于 2026-09-02 移除「💬 AI 助手」页；以下后端 API 与能力**保留**，供外部 AI / 命令行调用（`node src\ai.mjs` 或 HTTP API）。总指挥的角色化接入提示词见 `docs/LEADER_PROTOCOL.md`。

- **🎯 目标 / 项目管理**：可新建多个目标（如"优化冒险公会""做一个待办清单应用"），每个目标独立分配任务前缀。总指挥 AI 自动把目标拆成任务发布到任务池，等待外部 AI 工人领取执行，直到完成。
- **▶ 开始 / ⏸ 暂停 / ✔ 完成**：每个目标可随时暂停（停止派活、保留进度）或恢复运行；也可手动标记完成。多项目并行推进互不干扰。
- **按进度自动派活**：目标任务做完了，总指挥 AI 会根据目标描述 + 当前进度自动规划下一步（补任务发布到池子 / 判定完成 / 等待）。
- **总指挥只管理、不执行**：总指挥 AI 只负责规划/决策/检查。一切"动手"（读文件、写代码、写文档、自动进化等）都**必须通过派任务**——先 `create_task` 投进任务池，由**外部 AI 工人**（各自在线用 `task.mjs claim` 领取执行）或人工领取。系统**不内置工人**，不会自动执行任务。
- **总指挥自主巡查**：总指挥 AI 每隔一段时间（`ai.patrolInterval`，默认 5 分钟）自主审视整个任务池：
  - **自主重置**：失败/卡住但值得重试的任务 → 自动重置回待领取
  - **自主取消**：重复/无意义/被替代的任务 → 自动标记为已取消
  - **自主创建**：发现明显缺口 → 自动补建任务
  - 巡查只对「失败」任务做处置决策，不擅自动正常任务；能救就救（先重置后取消）。
- **超时自动解卡**：进行中超过 `ai.staleMinutes`（默认 30 分钟）的任务视为卡住，调度器自动释放回待领取（应对 worker 窗口/进程中断）。
- **能读记忆库（双库）**：总指挥可 `search_memories` 搜索**共享项目记忆库**（路径由 `integrations.sharedMemoryDir` / 环境变量 `SHARED_MEMORY_DIR` 配置，未配置则跳过）+ 本地记忆库，结果标注来源（共享/本地）。任何 AI 接手任务前都应先搜记忆了解项目上下文。
- **对话补充**：也可以直接和 AI 对话设定目标、追问进度；多轮会话记住上下文。

> **总指挥模型**：默认用火山方舟 `deepseek-v4-flash-ga-260731`，也可换成其他 OpenAI 兼容模型（如 Agnes `agnes-2.5-flash`）——在设置页或 `config.json` 的 `ai.directorModel` 配置。

后台调度由 `ai.autoRun` 控制（默认开启，每 20s 检查运行中目标：规划拆任务 + 巡查处置异常任务；**执行不自动**）。

目标 API：

```
POST /api/ai/goal           {title, description, workspace} → 新建目标（自动首次规划）
POST /api/ai/goal/action    {goal_id, action: start|pause|complete}
GET  /api/ai/goals          → 目标列表（含各目标进度统计）
```

对话 API：

```
POST /api/ai/chat            {message, session_id?}  → {ok, session_id, job_id}（异步）
GET  /api/ai/chat/result?job_id=xxx                 → {ok, status, reply, steps}（轮询）
```

总指挥 Agent 工具集：`query_tasks` / `get_task_detail` / `create_task` / `cancel_task` / `reset_task` / `search_memories` / `get_executor_stats` / `get_workspace_list`。

外部 AI 工人接活（见 `docs/AI_WORKER_PROTOCOL.md`）：
```
cd D:\冒险公会\src
node task.mjs list --status pending   # 看活
node task.mjs claim <id> --assignee "工具名 (模型名)"   # 领取
node task.mjs complete <id> --result "做了什么/改了哪些文件/怎么验证"  # 提交
```

## 多工作区 / 多项目

- 工作区用 `--workspace <名称>` 指定，或环境变量 `AI_GUILD_WORKSPACE`；缺省时 `create` 进「默认」工作区，`list / agents` 看全部
- 看板顶部有工作区切换器：统计、排行、筛选全部随工作区过滤；新建任务可选工作区（不存在的名称会自动创建）
- 历史任务（Phase 0 迁移）全部归入「默认」工作区

## 数据备份

```powershell
backup.bat
```

备份 `memory.db`（含 WAL/SHM）+ `config.json` 到 `backups/YYYYMMDD_HHMMSS/`。恢复：关闭服务后将备份文件复制回 `~/.adventure-guild/` 对应位置。

## 数据迁移

```powershell
node migrate\migrate_legacy.cjs                      # 默认旧库路径
node migrate\migrate_legacy.cjs "D:\path\to\old.db"  # 指定旧库
```

迁移范围：`tasks / task_scores / agents / memories` 全表，幂等可重复执行，源库只读。

## 从旧系统切换

- 旧系统（历史版本）看板可能仍占用端口 8765；启动新产品前，请先停止旧看板服务（释放端口），或在 `config.json` 改端口。
- 迁移完成后，**以新产品数据目录为准**（`~/.adventure-guild/data/memory.db`）；旧库保持只读作备份。
- 旧库中实时新增的任务，重新运行一次迁移工具即可增量合并（按唯一键去重）。

## 路线图

已完成里程碑：
- Phase 0 ✅ 解耦独立
- Phase 1 ✅ 多工作区/多项目
- Phase 2 ✅ UI/UX 产品化（纯色简洁主题 + 三视图 + 详情抽屉 + 打分面板）
- Phase 3 ✅ 配置化（可编辑设置页 + 动态评分维度）
- Phase 4 ✅ AI 工人接入协议（HTTP Worker API + CLI --json + 示例 worker）
- Phase 5 ✅ 交付打磨（备份脚本 + 完整文档）
- Phase 6 ✅ 内置 AI 项目管理（面板内置模型：总指挥拆解派发 + 工人执行，异步任务架构）
- Phase 7 ✅ 全自主 AI 助手（对话式 Agent：自主规划/派活/工人执行/读记忆库/补任务闭环）
