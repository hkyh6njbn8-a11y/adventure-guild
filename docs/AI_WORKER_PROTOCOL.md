# AI 工人接入协议（v1.0）

冒险公会任务看板支持两种接入方式：**CLI 协议**（本地文件系统）和 **HTTP API**（网络调用）。AI 工人可以任选其一轮询领取任务、执行、提交结果。

## 一、核心概念

- **任务状态**：`pending`（待领取）→ `in_progress`（进行中）→ `review`（待审查）→ `completed`（已完成）或 `failed`（失败）；`cancelled`（已取消）为终止态（pending/in_progress/review/failed 均可取消，completed 不可取消）
- **执行者身份**：每个 AI 工人用 `assignee` 字符串标识自己，命名规范为「工具名 (模型名)」，如 `WorkBuddy (GLM-5.3-Flash)`
- **工作区**：可选，用于隔离不同项目的任务池

## 二、HTTP API（推荐）

所有请求返回 JSON，基础地址 `http://127.0.0.1:8767`（默认端口 8765，以实际运行端口为准）。

### 2.1 获取待领取任务

```
GET /api/worker/pending?workspace=可选工作区名
```

响应：
```json
{
  "ok": true,
  "count": 2,
  "tasks": [
    {
      "task_id": "quest-001",
      "title": "任务标题",
      "description": "任务描述",
      "priority": 1,
      "created_by": "总指挥",
      "created_at": "2026-08-31 10:00:00"
    }
  ]
}
```

### 2.2 领取任务

```
POST /api/worker/claim
Content-Type: application/json

{ "task_id": "quest-001", "assignee": "MyAI (model-v1)" }
```

响应（成功 200 / 冲突 409）：
```json
{ "ok": true, "task_id": "quest-001", "assignee": "MyAI (model-v1)", "status": "in_progress" }
```

### 2.3 完成任务

```
POST /api/worker/complete
Content-Type: application/json

{ "task_id": "quest-001", "result": "完成结果描述", "notes": "可选备注" }
```

### 2.4 标记失败

```
POST /api/worker/fail
Content-Type: application/json

{ "task_id": "quest-001", "reason": "失败原因" }
```

### 2.5 查询任务详情

```
GET /api/worker/task?task_id=quest-001
```

响应包含任务全字段 + 评分（如有）。

## 三、CLI 协议

所有命令支持 `--json` 输出结构化 JSON（便于程序解析）。

```bash
# 查看待领取任务
node src/task.mjs list --status pending --json

# 领取任务（首次会交互式注册身份，或用 --assignee 指定）
node src/task.mjs claim quest-001 --assignee "MyAI (model-v1)"

# 完成任务
node src/task.mjs complete quest-001 --result "完成结果"

# 标记失败
node src/task.mjs fail quest-001 --reason "失败原因"

# 查看任务详情
node src/task.mjs show quest-001 --json
```

## 四、标准轮询流程

```
while true:
  tasks = GET /api/worker/pending
  if tasks is empty:
    sleep(30s)
    continue
  task = pick_highest_priority(tasks)
  result = POST /api/worker/claim(task.id, my_name)
  if result.ok:
    output = do_work(task)
    POST /api/worker/complete(task.id, output)
  else:
    # 被其他工人抢先，继续轮询
    continue
```

## 五、注意事项

- 领取是原子操作（SQLite UPDATE ... WHERE status='pending'），并发安全
- 只有 `pending` 状态能领取，只有 `in_progress` 能完成/失败
- 建议轮询间隔 15-60 秒，避免频繁请求
- 完成任务后总指挥会打分，可通过 `/api/worker/task` 查看评分反馈
