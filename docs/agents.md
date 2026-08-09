# Agents

pi-herdr 的 Agent 由某个 Primary Agent 创建，并拥有独立 herdr tab。pi 进程运行在该 tab 的受管 pane 中，使用正常落盘的 session。完成当前请求后，Agent 进入空闲状态并保留上下文，任何能通过 herdr 到达它的 Agent 都可以继续发送消息。

创建关系只记录 `createdBy`，不形成 Team 或可见性边界。Agent 默认与创建者使用同一 workspace 和工作目录；只有显式指定 `isolation: "worktree"` 时才创建隔离 worktree。

## Agent 工具

Primary Agent 使用 `Agent` 创建新的持久后台 Agent：

```typescript
Agent({
  description: string,
  prompt: string,
  agent_type: string,
  name: string,
  model?: string | string[],
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
  max_turns?: number,
  isolated?: boolean,
  inherit_context?: boolean,
  isolation?: "worktree",
})
```

- `description`：简短描述初始请求，作为 tab 初始标题的一部分。
- `prompt`：Agent 收到的第一条消息。
- `agent_type`：角色定义名称，例如 `explorer` 或 `general-purpose`。
- `name`：同时作为 pi session name、herdr Agent 路由名和 tab label，必须符合 `[a-z][a-z0-9_-]{0,31}`。
- `model`、`thinking`、`max_turns`：覆盖角色定义的运行配置。
- `isolated`：只加载允许的内置工作工具，不继承普通扩展和 MCP。
- `inherit_context`：创建时是否 fork Primary Agent 的当前会话历史；默认 `false`。
- `isolation: "worktree"`：显式要求独立 worktree；未设置时共享当前 workspace。

创建操作立即返回：

```typescript
{
  status: "launched",
  name: string,
  description: string,
  tabId: string,
  paneId: string,
}
```

pi session name 是持久事实来源。herdr 要求 live Agent name 唯一；pi-herdr 进一步要求当前 herdr session 中尚未删除的持久 Agent session name 唯一。即使 runtime 暂时 unavailable，也不能用同名创建另一个 Agent。

创建时，pi-herdr 设置 pi session name，并把同一个值传给 `herdr agent start` 和 tab label。恢复时从 pi session 读取 name，再重新绑定 herdr Agent 和 tab。spawned Agent 中的 `/name` 变更会通过 `session_info_changed` 同步到 herdr 和 tab；新名字格式无效或已经被占用时，扩展恢复原名并给出错误。

未知、禁用或无效的 `agent_type` 会直接报错。已有 Agent 的 tab 或 runtime 消失后，supervisor 可以根据持久 session 和 name 恢复它。

## 发现与复用

`ListAgents` 返回 herdr 当前可到达的全部 Agent 和 peer，不按创建者、工作目录或 worktree 过滤。pi-herdr 创建的 Agent 一定有 name；手动启动且没有命名的 peer 只能通过 `pane_id` 寻址。

```typescript
SendMessage({
  agent: "code-explorer",
  message: "继续检查刷新令牌的错误处理，并把新增发现回复给我。",
})
```

消息发送给空闲 Agent 时会触发新一轮工作；Agent 正在工作时，消息按投递模式进入 steering 或 follow-up 队列。详细语义见 [Messaging](messaging.md)。

## 生命周期

```text
created -> starting -> working -> idle
                           ^         |
                           |         |
                           +---------+

starting/working/idle -> blocked -> working
starting/working/idle -> unavailable
```

- `starting`：tab 与受管 pane 已创建，herdr 尚未识别到 pi Agent。
- `working`：Agent 正在处理消息。
- `blocked`：Agent 正在等待批准或用户输入。
- `idle`：本轮工作已经 settle，可以接收下一条消息。
- `unavailable`：tab、受管 pane、进程或 socket 已不可用；持久 session 仍可用于恢复。

herdr 的 `done` 表示后台工作结束后尚未被查看的 idle 状态，不表示 Agent 生命周期结束。pi-herdr 把 herdr 的 `idle` 和 `done` 都归一为 `idle`。

Agent 的身份和 session 默认持久化。本轮结束不会删除 tab、session 或可选 worktree；关闭 Agent tab 只让 runtime unavailable，不删除 session。

## 数量上限

pi-herdr 不限制同时工作的 Agent 数量。当前 herdr workspace 默认最多存在 16 个由 pi-herdr 创建且尚未移除的 Agent，用于防止错误循环无限创建 tab、session 和模型调用。

达到 `maxMembers` 后，`Agent` 返回明确错误。调用方可以通过 `ListAgents` 复用已有 Agent，或由用户清理不再需要的 Agent。

## Bundled Agents

### `explorer`

`explorer` 用于只读代码与资源搜索：

- 适合定位文件、符号、调用关系和资源目录。
- 提供 `read`、`bash`、`grep`、`find` 和 `ls`，可以使用 `rg`、Git 查询、文件统计等命令辅助搜索和分析。
- Bash 遵守只读角色约束，不创建、修改或删除文件。
- 完成当前请求后，通过消息 reply 地址把结论发回请求者。
- 默认模型偏好为 `gpt-5.6-luna`，其次为 `deepseek-v4-flash`，均不可用时继承创建者模型。

### `general-purpose`

`general-purpose` 具备完整工作工具：

- 适合实现、重构、测试、文档和开放式调查。
- 可以创建和修改文件。
- 默认继承创建者当前模型。
- 完成当前请求后，通过消息 reply 地址回复请求者，并继续保持空闲。

两个定义都来自 npm 包中的 Markdown 文件，详见 [Agent definitions](agent-definitions.md)。

## 用户命令

`/agents` 展示 herdr 当前可到达的全部 Agent、peer、状态、cwd 和 tab，不按创建关系分组或过滤。
