# ADR-001: Persistent Background Agents

- 状态：提议（Proposed）
- 日期：2026-08-09

## 上下文

在 pi-herdr 中创建一个 Agent 会产生独立的 herdr tab、受管 pane、pi 进程、模型上下文和 session 文件。随着上下文窗口扩大、compaction 改善以及 herdr 提供可见且可恢复的运行环境，把这些资源用于一次性请求会造成不必要的启动成本，也会丢失 Agent 已经建立的代码库认识。

项目需要让 Primary Agent 创建少量有稳定 name 的 Agent，之后通过消息继续复用。完成一轮工作只表示 Agent 空闲，不表示 Agent 生命周期结束。创建关系不形成 Team，也不限制其他可达 Agent 发现或联系它。

## 决策

### 1. Agent 一律后台运行

`Agent` 工具创建 Agent 后立即返回，不提供 foreground 模式。Primary Agent 继续自己的工作，并通过消息接收回复。

API 不包含 `run_in_background`，也没有同步返回最终内容的分支。

### 2. Agent 一律使用持久 session

每个 Agent 启动正常落盘的 pi session。`persist_session` 不是可配置选项，session 不会在一轮工作结束后被删除。

持久化包含两个层次：

- pi session 保存 Agent 的对话、工具调用和 compaction 历史。
- pi session name 保存 Agent 的持久名称；pi-herdr registry 只保存 session reference、`createdBy` 以及当前 runtime 引用。

如果 tab、pane 或进程消失，Agent 仍然存在。下一次投递消息时，supervisor 使用原 session 恢复 runtime。

### 3. 一轮完成后进入 idle

herdr 的 `working` 和 `blocked` 直接映射到 Agent 活动状态。herdr 的 `idle` 与 `done` 都映射为 pi-herdr 的 `idle`；其中 `done` 只是后台工作已经 settle 且尚未在 UI 中被查看。

`unknown` 不能证明成功或失败。supervisor 保留最近可信状态，并通过 session reference、pane 状态和重连 reconciliation 判断 runtime 是否仍可用。

### 4. 结果通过消息返回

Agent 收到消息时会得到 sender 和 reply 地址。完成当前请求后，Agent 使用 `SendMessage` 回复请求者。

不实现以下机制：

- 从 session 最后一条 assistant 消息提取结果。
- supervisor 内存结果缓存。
- `get_subagent_result`。
- 结果消费和通知抑制。
- 按 spawn turn 聚合结果的 group join。

消息暂时无法投递时进入 durable mailbox；接收方恢复后继续投递。

### 5. Supervisor 管理 Agent 而不是一次性任务

Supervisor 的职责是：

- 创建具名 Agent、把 name 写入 pi session、验证 herdr session 范围的唯一性，并记录 `createdBy`。
- 保存 Agent、pi session、tab、受管 pane、workspace 和可选 worktree 的对应关系。
- 将消息路由到存活 runtime，或先恢复 runtime 再投递。
- 监听 herdr 状态并更新 widget。
- 在 socket 重连和 Primary session 恢复时 reconciliation。
- 执行显式的 stop/remove 操作。

### 6. 只保留 Agent 数量上限

不限制 active、working 或同时运行的 Agent 数量，也不在扩展中排队调度工作。

每个 herdr workspace 默认最多保留 16 个由 pi-herdr 创建的 Agent。这个宽松的 `maxMembers` 只用于阻止错误循环无限创建 tab、session 和模型调用；普通 peer 不计入上限。达到上限时拒绝继续创建，并提示调用方通过 `ListAgents` 复用已有 Agent。

### 7. Worktree 是显式可选项

Agent 默认共享创建者的 workspace 和 cwd。只有显式设置 `isolation: "worktree"` 时才创建 worktree；该 worktree 归属于 Agent，而不是某一轮请求。Agent 空闲时保留 worktree，供后续消息继续使用。

- stop 只关闭 runtime，保留 session 和 worktree。
- remove 才尝试移除 Agent 资源。
- worktree 存在未提交或未合并变更时，remove 失败并保留现场。

只读 Explorer 默认共享 Primary 工作区，以持续看到最新代码。

## 备选方案

| 方案 | 未采纳原因 |
| --- | --- |
| 每次请求创建一次性 Agent | 重复支付 tab、session 和上下文建立成本，无法复用已有认识 |
| foreground Agent | 阻塞 Primary Agent，且与 herdr 独立 tab 的价值冲突 |
| session 可选持久化 | 增加两套生命周期和清理路径，使调用方无法可靠判断 Agent 能否复用 |
| 限制 active 并发数 | 扩展不应替模型和 herdr 调度工作；只需防止无限创建 Agent |

## 后果

### 正面

- Primary Agent 会感知创建 Agent 的成本，并倾向复用具名 Agent。
- Agent 能积累针对代码库或资源的长期上下文。
- 前后台、临时/持久两组分支被删除，生命周期更简单。
- 所有协作统一使用同一个消息模型。

### 负面

- 必须持久化 Agent registry 和 mailbox，并实现恢复与 reconciliation。
- 长期 session 会占用磁盘，需要用户显式管理不再需要的 Agent。
- 长期 writer worktree 可能落后于 Primary 分支，需要用户或 Agent 主动同步。

### 未解决

- 无。
