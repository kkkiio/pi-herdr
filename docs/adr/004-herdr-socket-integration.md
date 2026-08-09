# ADR-004: Herdr Socket Integration

- 状态：提议（Proposed）
- 日期：2026-08-09

## Context

pi-herdr 需要创建 Agent tab/pane、启动交互式 pi、投递 live prompt、发现 peer、同步 name、观察状态和实现 StopAgent。所有操作都发生在当前 herdr live session，不需要在 runtime 消失后重建逻辑 Agent。

## Decision

### 1. Raw socket is the control plane

扩展从 `HERDR_SOCKET_PATH` 连接当前 herdr server，使用 newline-delimited JSON、唯一 request ID 和 schema 对齐的类型。CLI 只用于人工诊断，不是实现控制面。

`HERDR_ENV != 1` 时 extension 静默不注册控制面。已经处于 herdr 环境但 socket 缺失或协议不兼容时显示明确诊断，不猜测默认路径。

### 2. Creation uses returned root panes

共享 workspace 时调用 `tab.create`，直接在返回的 root pane 中执行 `agent.start`。Worktree 隔离时调用 `worktree.create`，直接复用其返回的 workspace、tab 和 root pane，不再额外调用 `tab.create`。

`agent.start` 启动全新正常落盘的 pi session，显式加载同一个 pi-herdr extension 的 Spawned role，并传入创建时固定的 definition 配置。name 同时用于 pi session、herdr Agent route 和 tab label。

只有初始 `agent.prompt` 成功后 `Agent` 才返回 `launched`。此前失败按逆序使用 `pane.close` / `tab.close`、session cleanup 和 `worktree.remove({ force: false })` 回滚；herdr 拒绝移除时保留现场并报告残留。

### 3. Prompt is the only message ingress

初始 prompt 和 `SendMessage` 都调用 `agent.prompt`，文本格式为：

```text
<from agent="sender" reply-to="reply-address">
message body
```

Tag attribute XML-escape，正文原样传递，没有 closing tag。pi-herdr 不跨进程调用目标的 `pi.sendMessage`，不使用 `pane.send_text`、send-keys 或额外 IPC broker，也不承诺 `steer` / `followUp`。

目标必须 live。`agent.prompt` 成功仅证明 herdr 接受输入，不代表 Agent 已完成工作。

### 4. Discovery and stop use live AgentInfo

`agent.list` / `agent.get` 是 discovery 与目标解析的事实来源。`ListAgents` 保留原始 `AgentInfo`，再用当前 Primary 内存附加 `type` 与 `createdBy`。

`StopAgent` 解析 name 或 pane ID，拒绝调用者自身，然后调用目标 `pane.close`。它不关闭整个 tab，不删除 session/worktree，也不成为任意 pane 管理接口。

### 5. Name synchronization stays in the spawned process

同一个 extension 的 Spawned 模式监听自身 `session_info_changed`。新名字必须符合 `[a-z][a-z0-9_-]{0,31}` 并满足 herdr live 唯一性，然后依次调用 `agent.rename` 与 `tab.rename`。

herdr 的原子 uniqueness check 处理验证后的竞争。任一步失败时，extension 用重入 guard 恢复已修改状态和旧 pi session name。

### 6. Events maintain live memory only

Supervisor 使用 herdr schema 的实际事件名订阅 `pane_agent_detected`、`pane_agent_status_changed`、`pane_closed`、`pane_exited`、`tab_closed` 和 `tab_renamed`。

事件更新当前 Primary 的内存记录、容量和 UI。`done` 与 `unknown` 保留在工具返回中；只有 UI 可以把 `done` 视觉归类为 idle。关闭事件删除本地 ownership，不创建 unavailable 状态。

### 7. Retry only idempotent reads

Socket 断开后进行有界重连、重新订阅并获取 `session.snapshot` / `agent.list`。Reconciliation 只删除不再 live 的本地记录并刷新现有引用，不恢复 runtime 或 ownership。

`agent.list`、`agent.get`、snapshot 等幂等读取可以重试。`agent.start`、`agent.prompt`、rename、close、tab/worktree mutation 不自动重放，避免响应丢失后产生重复副作用。

### 8. RPC boundary

| pi-herdr behavior | Herdr RPC |
| --- | --- |
| Live discovery and target resolution | `agent.list`, `agent.get` |
| Shared Agent container | `tab.create` |
| Worktree Agent container | `worktree.create` |
| Start pi | `agent.start` |
| Initial and later messages | `agent.prompt` |
| `/name` synchronization | `agent.rename`, `tab.rename` |
| Stop runtime | `pane.close` |
| Failure rollback | `pane.close`, `tab.close`, `worktree.remove` |
| Caller/runtime lookup | `pane.current`, `pane.get` |
| State and reconnect | `events.subscribe`, `session.snapshot` |

pi-herdr 不暴露通用 workspace/tab/pane/layout、terminal input、agent wait/read/focus、worktree cleanup、plugin/server/integration 或 notification 管理工具。

## Alternatives

| Alternative | Why not chosen |
| --- | --- |
| CLI wrappers | 需要频繁 fork 和文本解析，不适合事件驱动扩展 |
| Durable mailbox + wake token | 当前产品只承诺 live messaging，不需要消息持久化协议 |
| Cross-process custom `pi.sendMessage` | 该 API 属于目标进程本地 extension，herdr prompt 无法直接调用它 |
| Mutating RPC auto-retry | 响应丢失时会重复创建、发送或关闭 |
| Worktree 后再创建 tab | `worktree.create` 已返回 tab/root pane，会破坏一个 Agent 一个 tab |
| StopAgent 关闭整个 tab | 可能误关用户后来加入的其他 pane |

## Consequences

### Positive

- 控制面直接对应 herdr live primitives，没有隐藏恢复协议。
- Prompt、stop、rename 和 worktree 拓扑都有单一路径。
- 只读重试避免重复副作用，同时允许短暂断线恢复 discovery。

### Negative

- Prompt delivery mode 完全依赖 herdr/pi 当前原生行为。
- Primary 重启后无法恢复 createdBy/type ownership。
- 关闭 runtime 后不能再通过 pi-herdr 消息寻址原 session。

### Unresolved

- 无。
