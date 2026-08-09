# Architecture

pi-herdr 是 herdr live session 上的轻量 Agent 协作层。Primary 创建后台 Agent，每个 Agent 使用独立 tab、受管 pane 和正常落盘的全新 pi session；通信、发现和状态都以当前 socket 可见的 runtime 为边界。

```text
Herdr live session
├── Tab: primary
│   └── Primary pi + pi-herdr extension (Primary mode)
├── Tab: code-explorer
│   └── Managed pane: pi + same extension (Spawned mode)
├── Tab: implementer
│   └── Managed pane: pi + same extension (Spawned mode)
└── Other live pi peers
```

一个 Agent 创建时对应一个 tab 和一个受管 pane。用户之后在 tab 中创建的其他 pane 不属于 Agent runtime；`StopAgent` 只关闭目标 Agent pane，不连带关闭其他 pane。

## Scope Boundary

pi-herdr 持久化的是普通 pi session，不持久化自己的 Agent registry。只要 runtime live，Agent 可以反复接收消息并保留上下文；runtime 消失后：

- 当前 Primary 删除内存记录并释放名额。
- pi session 与可选 worktree 保留。
- `ListAgents` 不再返回该 Agent，`SendMessage` 也不会自动恢复它。
- 用户可以使用原生 pi、Git 与 herdr 继续管理资源。

因此系统不需要 durable mailbox、offline name reservation、session-to-pane registry、leader election 或跨 Primary 的共享锁。

## Components

实现保持少量深模块：

```text
src/
├── index.ts
├── agent-supervisor.ts
├── agent-runtime.ts
├── agent-definitions.ts
├── herdr-client.ts
├── tools.ts
└── ui.ts
```

- `index.ts`：读取 runtime role、环境与设置，装配同一个 extension 的 Primary/Spawned 工具表面。
- `agent-supervisor.ts`：管理当前 Primary 创建的 live Agent 内存记录、容量、事件和创建回滚。
- `agent-runtime.ts`：构造 pi 启动参数、system prompt、消息 envelope 与 rename 同步。
- `agent-definitions.ts`：严格发现、解析并固定 Markdown definition。
- `herdr-client.ts`：类型化 socket RPC、事件订阅、只读重试和 live snapshot reconciliation。
- `tools.ts`：实现 `Agent`、`StopAgent`、`ListAgents` 与 `SendMessage`。
- `ui.ts`：`/agents`、状态与配置诊断。

没有独立的 `agent-registry` 或第二个 agent extension。Primary/Spawned 是同一 extension 入口的两种 runtime role。

## In-memory Ownership

Primary 以 live `pane_id` 为键记录自己成功创建的 Agent，值包含 description、definition、createdBy、tab/workspace/worktree 引用和当前 name。记录只用于：

- 给 `ListAgents` 结果附加 `type: "agent"` 与 `createdBy`。
- 统计当前 Primary 的 `maxMembers`。
- 关联 rename、pane/tab close 与创建失败回滚。

socket 重连后，supervisor 通过 `session.snapshot` / `agent.list` 删除已经不 live 的本地记录并刷新仍存在的 runtime 引用。它不会从 session 文件重建丢失记录；Primary 重启后，已有 live 会话自然作为 peer 返回。

## Creation Transaction

共享 workspace 创建流程：

1. 校验环境、设置、definition、name 和初始模型。
2. 检查当前 Primary 的 live Agent 数量。
3. `tab.create` 创建不抢焦点的 name tab，并取得 root pane。
4. `agent.start` 启动全新持久 pi session、同一个 extension 的 Spawned role 及 definition 配置。
5. `agent.prompt` 投递带 `<from ...>` envelope 的初始请求。
6. 只有 prompt 被 herdr 接受后才写入内存记录并返回 `launched`。

Worktree 流程用 `worktree.create` 替换第 3 步，直接复用其返回的 workspace、tab 和 root pane。

失败时按已完成步骤逆序回滚：关闭新 pane/tab、删除尚未承载工作的 session，并以 `force: false` 移除本次新建的 worktree。Herdr 拒绝安全移除时保留现场；mutating RPC 不自动重放，清理失败与残留路径合并进最终错误。

## Messaging

所有初始请求、后续工作和结果都通过 herdr `agent.prompt` 传递：

```text
<from agent="sender-name" reply-to="w1:p1">
message body
```

pi-herdr 不使用目标进程内的跨进程 `pi.sendMessage` 假设，也不使用 `pane.send_text`、send-keys 或轮询模拟 delivery mode。目标必须 live；提交成功只表示 herdr 接受 prompt，不表示工作已经完成。

## Name Synchronization

pi session name 是持久显示名，herdr Agent name 是 live route，tab label 是 UI 名称。三者在 spawned runtime live 时保持一致。

Spawned 模式以自己的 pane ID 调用 herdr。`session_info_changed` 后先验证格式与 live 唯一性，再调用 `agent.rename` 和 `tab.rename`；失败时恢复已变更的 herdr 状态和 pi session name。重入 guard 防止恢复动作重复触发同步。

## Runtime State and Events

工具返回 herdr 原始 `AgentInfo` 与 `agent_status`。Supervisor 订阅实际的下划线事件名，包括 `pane_agent_detected`、`pane_agent_status_changed`、`pane_closed`、`pane_exited`、`tab_closed` 和 `tab_renamed`。

事件只维护 live 内存与 UI，不把 `done` 解释为 Agent 终止，也不把 `unknown` 改写为 idle。`/agents` 可以在展示层把 `done` 归入 idle 视觉分组。

## Capacity and Settings

`piHerdr.maxMembers` 默认 16，接受任意正整数。项目 Pi settings 覆盖全局 settings。这个上限只统计当前 Primary 进程创建且仍 live 的 Agent，用于阻止单个 Primary 的错误循环；它不是 workspace-wide 或 herdr session-wide 配额。

非法设置阻止新的 Agent 创建，但不关闭已有 runtime，也不影响 discovery、messaging 或 StopAgent。

## Socket Failure Policy

- `HERDR_ENV != 1`：extension 静默禁用控制面。
- 已在 herdr 环境但缺少 `HERDR_SOCKET_PATH` 或协议不兼容：显示明确诊断，不猜测 socket。
- 断线后重连并恢复事件订阅。
- 只自动重试 `agent.list`、`agent.get`、snapshot 等幂等读取。
- `agent.start`、`agent.prompt`、rename、close 和 worktree mutation 不自动重放。
