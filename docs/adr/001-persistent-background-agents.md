# ADR-001: Live Persistent Background Agents

- 状态：已接受（Accepted）
- 日期：2026-08-09

## Context

pi-herdr 创建的 Agent 需要在独立 herdr tab 中长期保留上下文，并在完成一次请求后继续等待消息。与此同时，herdr 已经提供 live Agent 发现、tab/pane 生命周期和持久 pi session；为已经关闭的 runtime 再建立一套 registry、mailbox 和自动恢复系统，会引入额外身份、并发和清理事务。

持久边界定义在 live runtime：session 正常落盘，但 pi-herdr 只管理当前 socket 仍可到达的 Agent。

## Decision

### 1. Agent 一律后台运行

`Agent` 创建独立 tab/pane 后，在初始 prompt 被 herdr 接受时返回 `launched`。它不提供 foreground 分支，也不等待 Agent 完成本轮工作。

### 2. 每次创建全新持久 pi session

Agent 使用正常落盘的全新 session，不 fork Primary transcript，也不提供临时 session 分支。

一次请求完成只表示 runtime idle；session、tab 和可选 worktree 继续存在，后续 `SendMessage` 复用同一上下文。

### 3. 管理边界是 live runtime

pi-herdr 不保存 offline Agent registry。pane、tab 或进程消失后：

- 当前 Primary 释放对应内存记录、name 与容量名额。
- `ListAgents` 不再返回该 runtime。
- `SendMessage` 不自动恢复它。
- session 与可选 worktree 保留，由用户使用原生 pi、Git 和 herdr 处理。

Primary 重启会丢失创建来源内存。仍在 herdr 中运行的旧 Agent 继续可达，但在新 Primary 的 `ListAgents` 结果中归类为 peer。

### 4. 结果与请求统一走 live prompt

初始请求、后续请求和结果都通过 `agent.prompt` 发送，并使用 `<from agent="…" reply-to="…">` opening tag 标识来源。reply address 是发送时的 live name 或 pane ID，不是持久身份。

不实现 durable mailbox、message ID、offline queue、result store、`get_subagent_result` 或 transcript 结果提取。目标不 live 或 prompt 提交失败时直接报错。

### 5. Supervisor 只维护进程内事实

每个 Primary 以 pane ID 为键记录自己成功创建且仍 live 的 Agent。记录用于 `type` / `createdBy` 注解、容量统计、rename 关联和失败回滚，不写入磁盘，也不在 Primary 之间共享。

Socket 重连只通过 live snapshot 删除失效记录、刷新仍存在的 runtime，不从 session 文件重建 ownership。Snapshot 与 `agent.list` reconciliation 只能处理各自读取开始前已经存在的 ownership key，延迟响应不能删除并发创建成功的新记录。

### 6. Capacity 是 per-Primary 安全阀

Pi settings 的 `piHerdr.maxMembers` 默认 16，接受任意正整数。每个 Primary 只统计自己当前进程创建且仍 live 的 Agent；多个 Primary 可以共同超过该值。

非法值产生诊断并阻止新 Agent 创建，但不影响 discovery、messaging 或 stop。该限制用于阻止单个 Primary 的错误 spawn 循环，不是 workspace-wide 调度或全局配额。

### 7. Stop 与资源保留分离

`StopAgent` 接受唯一 live name 或 pane ID，可以关闭任意其他 Agent/peer 的宿主 pane，但禁止关闭调用者自身。它只调用 `pane.close`，不关闭 tab 中其他 pane，也不删除 session 或 worktree。

常规 worktree 合并与清理由 Primary 在用户指示下使用原生 Git/Herdr 完成。pi-herdr 只在 Agent 创建失败回滚时以 `force: false` 先尝试移除本次新建的 worktree；安全移除失败后再关闭本次 pane。只有 runtime 已确认关闭，且 launch 已产生可验证的 `herdr:pi` session、绝对 `.jsonl` path 位于配置的 Pi session tree 内时，才删除这个精确文件。close 结果不确定或其他清理无法验证时保留现场并报告残留资源。

## Alternatives

| Alternative                           | Why not chosen                                                                                     |
| ------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Offline registry + automatic recovery | 需要稳定 herdr session identity、共享锁、schema migration、ownership reconciliation 和资源删除事务 |
| Durable mailbox                       | 需要消息 ID、ack、去重、顺序与崩溃恢复，而 live `agent.prompt` 已覆盖当前目标                      |
| Ephemeral pi sessions                 | Agent tab 关闭后无法用原生 pi 排查或手动恢复上下文                                                 |
| Workspace-wide capacity               | 无共享 managed metadata 时无法准确区分多个 Primary 创建的 Agent 与普通 peer                        |
| 插件自动清理所有 worktree             | 合并状态与用户保留意图应由 Primary、Git 和用户决定                                                 |

## Consequences

### Positive

- Agent 可以在 live tab 中长期复用，同时没有第二套持久状态系统。
- Primary 重启、peer 发现和 tab 关闭语义直接对齐 herdr live snapshot。
- Stop、消息和 worktree 清理边界明确，避免插件隐藏删除用户资源。

### Negative

- 已关闭 Agent 不能通过 `SendMessage` 自动恢复。
- reply address 与 `createdBy` 都是 live 信息，可能随 rename、pane 变化或 Primary 重启失效。
- per-Primary 上限不能阻止多个 Primary 合计创建大量 Agent。

### Unresolved

- 无。
