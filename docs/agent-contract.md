# Agent Contract

pi-herdr 是 Pi 与 Herdr 之间的适配层：它把 Herdr 的能力以 Pi 工具和消息约定的形式暴露，不拥有或管理 Agent 的生命周期——生命周期归 Herdr（pane/tab）和用户。

任何运行在 Herdr 中、加载了 pi-herdr 的 Pi 会话都获得相同的控制表面（`Agent`、`ListAgents`、`SendMessage` 与 `/agents`）。通过 `Agent` 创建的 Agent 是独立 Herdr tab 的受管 pane 中运行的后台 Pi 会话，使用正常落盘的全新 session；完成一次请求后保持 idle，保留上下文并等待后续消息。它与创建者的唯一区别是"被谁创建"这一事实，工具能力完全相同——包括继续创建别的 Agent。

```text
Herdr live session
├── Tab: primary
│   └── Pi + pi-herdr extension
├── Tab: code-explorer
│   └── Managed pane: Pi + same extension
├── Tab: implementer
│   └── Managed pane: Pi + same extension
└── Other live Pi peers
```

一个 Agent 对应一个 tab 和一个受管 pane。用户后来在同一 tab 中创建的其他 pane 不属于该 Agent runtime。

## Runtime Boundary

持久性以 live runtime 为边界。只要 pane 和 Pi 进程存在，Agent 就能跨多轮复用；pane、tab 或进程消失后：

- 创建者的内存 ownership 记录被删除。
- Pi session 与可选 worktree 保留。
- `ListAgents` 不再返回该 Agent，`SendMessage` 不会自动恢复它。
- 用户仍可使用原生 Pi、Git 与 Herdr 管理留下的资源。

pi-herdr 不维护 offline Agent registry、durable mailbox、session-to-pane 映射或关闭后的 name reservation。

## Agent

任何 Agent 都可以使用 `Agent` 创建新的 Agent：

```typescript
Agent({
  description: string,
  prompt: string,
  name: string,
  model?: string | string[],
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
  cwd?: string,
  isolation?: "worktree",
}) => {
  status: "launched",
  description: string,
  agent: AgentInfo,
}
```

- `description` 是工具结果与 UI 详情中的简短说明，不参与 tab label。
- `prompt` 是第一条消息，使用与 `SendMessage` 相同的 `<from ...>` envelope。
- `name` 是唯一的 Herdr live route name，并作为新 Agent tab 的初始 label；必须符合 `[a-z][a-z0-9_-]{0,31}`。
- `model` 与 `thinking` 设置新 Agent 的初始模型与 thinking level；启动后仍可使用 Pi 原生能力修改。
- `cwd` 选择新 Agent 的工作目录；相对路径以调用时的 cwd 为基准，未设置时继承该 cwd。
- `isolation: "worktree"` 从解析后的 `cwd` 创建独立 worktree workspace；未设置时在共享 workspace 中创建使用该 cwd 的 tab。

新 Agent 使用 Pi 默认配置，没有角色类型或 definition 参数；只读、审查姿态等约束写在当次 prompt 里，不进 Agent 的长期身份。设计理由见 [ADR-006](adr/006-no-subagent-type-parameter.md)。

## Uniform Extension Surface

所有 Herdr 内的 Pi 会话运行同一个 pi-herdr extension 入口，注册相同的工具表面与 `/agents`。创建新 Agent 时 `agent.start.args` 只携带短 flag（`--extension`、模型与 thinking 参数），不传任何角色标记。

递归创建（Agent 创建 Agent）不受限制。实践中 Agent 没有主动递归创建的倾向；即使发生，代价只是一个可见、可关闭的 tab。

共享 workspace 与 worktree 使用完全相同的启动参数。`worktree.create` 没有环境变量参数。

## Creation Transaction

共享 workspace 创建流程：

1. 校验 Herdr 环境、配置、cwd、name 和初始模型。
2. `tab.create` 使用解析后的 cwd 和 Agent name 创建不抢焦点的 tab，并返回 root pane。
3. `agent.start` 在 root pane 中启动全新、持久的 Pi session；模型与 thinking 覆盖通过 Pi args 传入。
4. 只用 `agent.get` 轮询，直到 `launch_pending: false` 且 `interactive_ready: true`。
5. `agent.prompt` 投递带 `<from ...>` envelope 的初始请求。
6. 只有 prompt 被 Herdr 接受后才记录 ownership，并返回 `launched`。

Worktree 隔离用传入同一 cwd 的 `worktree.create` 替换第 2 步，直接复用返回的 workspace、tab 与 root pane，再显式调用 `tab.rename` 设置初始 Agent tab label；不会额外创建第二个 tab。

raw `agent.start` 成功只表示 launch 已提交，不表示 Pi 已经可以接收 prompt；`Agent` 返回 `launched` 也只表示初始 prompt 被接受，不等待 Agent 完成本轮工作。

## Failure Cleanup

共享 workspace 创建失败时，pi-herdr 关闭本次新建的 tab。Worktree 创建失败时，先以 `force: false` 调用 `worktree.remove`，只有安全移除失败时才继续关闭本次 pane。

只有 runtime 已确认关闭、Herdr 返回的是本次 launch 创建的 `herdr:pi` session、且绝对 `.jsonl` path 位于 Pi 实际 session directory 内时，才删除该精确 session 文件。目录解析顺序为 `PI_CODING_AGENT_SESSION_DIR`、项目覆盖后的 `settings.json#sessionDir`、agent directory 下的 `sessions/`。

close 结果不确定时保留 session，不扫描目录或根据 name 猜测文件。无法验证或完成的清理会保留现场，并把 workspace、pane 和 session residual 合并到原始 launch 错误中。RPC 层的 unknown delivery 规则见 [Herdr RPC Integration](herdr-rpc.md#retry-and-delivery)。

## Name and Identity

Herdr Agent name 是 live route，在创建时必须唯一，并用于初始化专用 tab 的 label。已经关闭的 session 不继续占用该 route name。

Pi session name 是 Pi 管理的持久显示名，tab label 是 Herdr 管理的 UI 名称。用户可以分别使用 Pi 的 `/name` 和 Herdr 的 tab 管理能力修改它们；消息寻址仍使用 Herdr 返回的 live Agent name 或 pane ID。

Ownership 记录使用 pane ID 作为稳定键，Agent name 是 live 路由属性。

## Ownership and Lifecycle

每个会话只在内存中记录自己成功创建且仍 live 的 Agent，记录包含 description、createdBy pane 和最新 `AgentInfo`。它只用于给 `ListAgents` 附加来源，以及在 lifecycle event 或 reconciliation 后释放已经消失的 runtime。

会话重启后 ownership 清空；先前仍 live 的 Agent 继续保留 session、上下文和完整工具表面，但在其他会话看来是普通 peer。

```text
starting -> working -> idle
                ^       |
                |       |
                +-------+

starting/working/idle -> blocked -> working
starting/working/blocked/idle/done/unknown -> closed
```

工具结果保留 Herdr 原始 `AgentInfo.agent_status`：`idle`、`working`、`blocked`、`done` 和 `unknown`。`done` 不表示 runtime 已终止；`/agents` 可以在展示层把它归入 idle，但不会改写工具数据。只有 pane、tab 或进程消失才结束 pi-herdr 管理。

pi-herdr 不提供停止工具。停止 Agent 由用户直接通过 Herdr 关闭 pane/tab；session 与 worktree 由 Herdr 语义保留。

## User Command

`/agents` 展示 Herdr 当前返回的 live Agent 和 peer，包括原始状态、cwd、workspace、tab 与 pane。它不提供通用 tab、pane、workspace 或 worktree 管理。
