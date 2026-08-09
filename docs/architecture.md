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
├── herdr-types.ts
├── tools.ts
└── ui.ts
```

- `index.ts`：读取 runtime role、环境与设置，装配同一个 extension 的 Primary/Spawned 工具表面。
- `agent-supervisor.ts`：管理当前 Primary 创建的 live Agent 内存记录、容量、snapshot reconciliation、事件和创建回滚。
- `agent-runtime.ts`：构造 pi 启动参数、system prompt、消息 envelope 与 rename 同步。
- `agent-definitions.ts`：严格发现、解析并固定 Markdown definition。
- `herdr-client.ts`：类型化 socket RPC、专用事件订阅连接和只读重试。
- `herdr-types.ts`：固定 Herdr 0.7.5 / protocol 17 的 request、response、snapshot 与 event wire types。
- `tools.ts`：实现 `Agent`、`StopAgent`、`ListAgents` 与 `SendMessage`。
- `ui.ts`：`/agents` live runtime 展示；入口负责启动期配置与连接诊断。

没有独立的 `agent-registry` 或第二个 agent extension。Primary/Spawned 是同一 extension 入口的两种 runtime role。

Spawned role 通过 `agent.start.args` 中的 Pi extension flag `--pi-herdr-role spawned` 注入。`worktree.create` 没有环境变量参数，因此 role 不通过 worktree env 传递；共享 workspace 与 worktree 两条路径使用完全相同的 Pi flag。

## Herdr Transport Contract

当前实现以 Herdr 0.7.5 / socket protocol 17 作为 wire contract。初始化先调用 `ping` 获取 server version 与 protocol，再用 `session.snapshot` 进行第二次协议检查并建立 live 基线；protocol 不是 17 时会阻止后续控制操作，并显示实际 version/protocol 供诊断。所有工具操作都等待这两个步骤完整成功；暂时性的 snapshot 失败不会留下可用的半初始化控制面，后续工具调用或 event acknowledgement 会重试 bootstrap。

普通 RPC 每次建立独立 local socket，写入一行带唯一 request ID 的 JSON，读取同 ID 的单行响应后关闭。请求与首次 subscription acknowledgement 使用 5 秒绝对 deadline，零散字节不会延长 deadline；`events.subscribe` 确认后取消该 deadline，并在另一条专用长连接上持续接收 push。普通 RPC 不与订阅复用连接，订阅断线也不会使 mutating RPC 被自动重放。

订阅请求的 `type` 使用点号 schema：`pane.agent_detected`、`pane.closed`、`pane.exited`、`tab.closed`、`tab.renamed`，以及按 pane 创建的 `pane.agent_status_changed`。Herdr push 保留各自实际 schema：普通 lifecycle envelope 使用 `pane_agent_detected`、`pane_closed`、`pane_exited`、`tab_closed`、`tab_renamed`，过滤后的状态订阅使用 `pane.agent_status_changed`。

## In-memory Ownership

Primary 以 live `pane_id` 为键记录自己成功创建的 Agent，值包含 description、创建时选中的 definition、createdBy pane 和最新 `AgentInfo`。记录只用于：

- 给 `ListAgents` 结果附加 `type: "agent"` 与 `createdBy`。
- 统计当前 Primary 的 `maxMembers`。
- 由 pane/tab lifecycle event 与 reconciliation 释放已经消失的 ownership。

event socket 重连后，supervisor 通过 `session.snapshot` 删除已经不 live 的本地记录并刷新仍存在的 runtime 引用；正常 `ListAgents` 调用还会用最新 `agent.list` 做同样核对。每次读取开始时先捕获当时已有的 ownership key，响应只能更新或删除这组记录，不能用延迟返回的旧 snapshot/list 擦除并发完成的新 launch。它不会从 session 文件重建丢失记录；Primary 重启后，已有 live 会话自然作为 peer 返回。

## Creation Transaction

共享 workspace 创建流程：

1. 校验环境、设置、definition、name 和初始模型。
2. 检查当前 Primary 的 live Agent 数量。
3. `tab.create` 创建不抢焦点的 name tab，并取得 root pane。
4. `agent.start` 启动全新持久 Pi session；Spawned role 与 definition 配置都通过 Pi args 传入。
5. raw `agent.start` 返回的 Agent 可能仍为 `launch_pending`。运行时只用幂等的 `agent.get` 轮询，直到 `launch_pending: false` 且 `interactive_ready: true`。
6. `agent.prompt` 投递带 `<from ...>` envelope 的初始请求。
7. 只有 prompt 被 Herdr 接受后才写入内存记录并返回 `launched`。

Worktree 流程用 `worktree.create` 替换第 3 步，直接复用其返回的 workspace、tab 和 root pane，再显式调用 `tab.rename` 同步 Agent name；`worktree.create` 的 label 不能替代这一步。

Worktree 创建失败回滚先以 `force: false` 调用 `worktree.remove`；只有安全移除失败时才继续 `pane.close`，避免先关闭 workspace 后丢失 Herdr 的安全移除上下文。共享 workspace 创建失败关闭本次新建的 tab。只有 runtime 已确认关闭，且 `agent.start` 已暴露本次新建 Pi session 的 `herdr:pi` 绝对 `.jsonl` path、该 path 位于 Pi 实际 session directory 内时，回滚才删除这个精确文件。目录解析遵循 Spawned Pi 使用的 `PI_CODING_AGENT_SESSION_DIR` > 项目覆盖后的 `settings.json#sessionDir` > agent directory `sessions/`；若 close 结果不确定则保留 session，不扫描或按名字猜测其他 session。任何无法验证或完成的清理都会保留现场，并把 workspace、pane 或 session 残留合并进最终错误。

若最初的 `tab.create` / `worktree.create` 已写入 socket，但响应在返回资源 ID 前丢失，mutation 不会重放。由于无法在并发创建中安全猜测资源归属，最终错误会保留 `delivery: unknown` 的含义并明确报告可能存在无法寻址的 container residual。

## Messaging

所有初始请求、后续工作和结果都通过 herdr `agent.prompt` 传递：

```text
<from agent="sender-name" reply-to="w1:p1">
message body
```

pi-herdr 不使用目标进程内的跨进程 `pi.sendMessage` 假设，也不使用 `pane.send_text`、send-keys 或终端输出轮询模拟 delivery mode。创建期间的 `agent.get` 轮询只确认交互就绪，不推断 prompt 结果。目标必须 live；提交成功只表示 Herdr 接受 prompt，不表示工作已经完成。

## Name Synchronization

pi session name 是持久显示名，herdr Agent name 是 live route，tab label 是 UI 名称。三者在 spawned runtime live 时保持一致。

Spawned 模式以自己的 pane ID 调用 herdr。`session_info_changed` 后先验证格式与 live 唯一性，再调用 `agent.rename` 和 `tab.rename`；失败时恢复已变更的 herdr 状态和 pi session name。重入 guard 防止恢复动作重复触发同步。

## Runtime State and Events

工具返回 Herdr 原始 `AgentInfo` 与 `agent_status`。Supervisor 按点号 subscription schema 发起订阅，并按 push 的实际 envelope 处理下划线 lifecycle 事件与点号 `pane.agent_status_changed`；两种命名属于 Herdr protocol 17 的不同 wire surface，不能相互替换。

事件只维护 live 内存与 UI，不把 `done` 解释为 Agent 终止，也不把 `unknown` 改写为 idle。`/agents` 可以在展示层把 `done` 归入 idle 视觉分组。

## Capacity and Settings

`piHerdr.maxMembers` 默认 16，接受任意正整数。项目 Pi settings 覆盖全局 settings。这个上限只统计当前 Primary 进程创建且仍 live 的 Agent，用于阻止单个 Primary 的错误循环；它不是 workspace-wide 或 herdr session-wide 配额。

非法设置阻止新的 Agent 创建，但不关闭已有 runtime，也不影响 discovery、messaging 或 StopAgent。

## Socket Failure Policy

- `HERDR_ENV != 1`：extension 静默禁用控制面。
- 已在 Herdr 环境但缺少 `HERDR_SOCKET_PATH`：显示明确诊断，不猜测 socket。
- 用 `ping` 与 `session.snapshot` 同时诊断 version/protocol；只接受 protocol 17，支持基线为 Herdr 0.7.5。
- 首次订阅尚未确认时进行有限次连接尝试；已经确认过的订阅断线后以封顶退避持续重连专用 event socket、重新订阅，并通过 `session.snapshot` 刷新 live 基线。
- 只自动重试 `ping`、`agent.list`、`agent.get`、`session.snapshot` 等幂等读取。
- `agent.start`、`agent.prompt`、rename、close 和 worktree mutation 不自动重放。
