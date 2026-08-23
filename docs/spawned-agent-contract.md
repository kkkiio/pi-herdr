# Spawned Agent Contract

Spawned Agent 是由 Primary Agent 创建、在独立 Herdr tab 的受管 pane 中运行的后台 Pi 会话。每个 Spawned Agent 使用正常落盘的全新 session；完成一次请求后保持 idle，保留上下文并等待后续消息。

```text
Herdr live session
├── Tab: primary
│   └── Primary Pi + pi-herdr extension (Primary mode)
├── Tab: code-explorer
│   └── Managed pane: Pi + same extension (Spawned mode)
├── Tab: implementer
│   └── Managed pane: Pi + same extension (Spawned mode)
└── Other live Pi peers
```

一个 Spawned Agent 对应一个 tab 和一个受管 pane。用户后来在同一 tab 中创建的其他 pane 不属于该 Agent runtime；停止 Agent 只关闭受管 pane。

## Runtime Boundary

持久性以 live runtime 为边界。只要 pane 和 Pi 进程存在，Spawned Agent 就能跨多轮复用；pane、tab 或进程消失后：

- 当前 Primary 删除内存 ownership 并释放容量。
- Pi session 与可选 worktree 保留。
- `ListAgents` 不再返回该 Agent，`SendMessage` 不会自动恢复它。
- 用户仍可使用原生 Pi、Git 与 Herdr 管理留下的资源。

pi-herdr 不维护 offline Agent registry、durable mailbox、session-to-pane 映射或关闭后的 name reservation。

## Agent

Primary Agent 使用 `Agent` 创建 Spawned Agent：

```typescript
Agent({
  description: string,
  prompt: string,
  definition: string,
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
- `definition` 接受 catalog name，或以 `.md` 结尾的绝对路径、显式相对路径；完整选择与解析规则见 [Agent Definitions](agent-definitions.md)。
- `name` 同时作为 Pi session name、Herdr live route name 和 tab label，必须符合 `[a-z][a-z0-9_-]{0,31}`。
- `model` 与 `thinking` 覆盖 definition 的初始值；启动后仍可使用 Pi 原生能力修改。
- `cwd` 选择 Spawned Agent 的工作目录；相对路径以 Primary 调用时的 cwd 为基准，未设置时继承该 cwd。
- `isolation: "worktree"` 从解析后的 `cwd` 创建独立 worktree workspace；未设置时在共享 workspace 中创建使用该 cwd 的 tab。

Definition path 只选择角色配置，不改变 workspace 或 cwd。相对 definition path 与相对 `cwd` 分别以 Primary 调用时的 cwd 解析，二者不互相推导或校验。

## 单扩展双模式

Primary 与 Spawned 运行同一个 pi-herdr extension 入口。Primary 默认使用 `primary` role；创建 Spawned Agent 时，pi-herdr 在 `agent.start.args` 中传入 Pi extension flag：

```text
--pi-herdr-role spawned
```

extension 通过 `registerFlag` 注册该参数，并在 `session_start` 时用 `getFlag` 选择工具表面：

- Primary 模式注册 `Agent`、`ListAgents`、`SendMessage` 和用户 UI。
- Spawned 模式只注册 `ListAgents`、`SendMessage` 和 name 同步逻辑。

因此 Spawned Agent 不能递归创建 Agent。Definition 加载的普通 extensions 与 skills 不改变 pi-herdr 自己的工具表面。

共享 workspace 与 worktree 使用完全相同的 role flag。`worktree.create` 没有环境变量参数，role 不通过 worktree env 传递。

## Creation Transaction

共享 workspace 创建流程：

1. 校验 Herdr 环境、配置、definition selector、cwd、name 和初始模型。
2. 核对当前 Primary 创建且仍 live 的 Agent 数量。
3. `tab.create` 使用解析后的 cwd 创建不抢焦点的 tab，并返回 root pane。
4. `agent.start` 在 root pane 中启动全新、持久的 Pi session；role 和 definition 配置都通过 Pi args 传入。
5. 只用 `agent.get` 轮询，直到 `launch_pending: false` 且 `interactive_ready: true`。
6. `agent.prompt` 投递带 `<from ...>` envelope 的初始请求。
7. 只有 prompt 被 Herdr 接受后才记录 ownership，并返回 `launched`。

Worktree 隔离用传入同一 cwd 的 `worktree.create` 替换第 3 步，直接复用返回的 workspace、tab 与 root pane，再显式调用 `tab.rename` 同步 Agent name；不会额外创建第二个 tab。Definition 文件位置不参与 workspace 或 worktree 选择。

raw `agent.start` 成功只表示 launch 已提交，不表示 Pi 已经可以接收 prompt；`Agent` 返回 `launched` 也只表示初始 prompt 被接受，不等待 Agent 完成本轮工作。

## Failure Cleanup

共享 workspace 创建失败时，pi-herdr 关闭本次新建的 tab。Worktree 创建失败时，先以 `force: false` 调用 `worktree.remove`，只有安全移除失败时才继续关闭本次 pane。

只有 runtime 已确认关闭、Herdr 返回的是本次 launch 创建的 `herdr:pi` session、且绝对 `.jsonl` path 位于 Pi 实际 session directory 内时，才删除该精确 session 文件。目录解析顺序为 `PI_CODING_AGENT_SESSION_DIR`、项目覆盖后的 `settings.json#sessionDir`、agent directory 下的 `sessions/`。

close 结果不确定时保留 session，不扫描目录或根据 name 猜测文件。无法验证或完成的清理会保留现场，并把 workspace、pane 和 session residual 合并到原始 launch 错误中。RPC 层的 unknown delivery 规则见 [Herdr RPC Integration](herdr-rpc.md#retry-and-delivery)。

## Name and Identity

Pi session name 是持久显示名，Herdr Agent name 是 live route，tab label 是 UI 名称；Spawned runtime live 时三者保持一致。name 在 live Agent 中必须唯一，已经关闭的 session 不继续占用该 name。

Spawned 模式监听 `session_info_changed`。用户执行 `/name` 后：

1. 校验新名字格式，并通过 Herdr 检查 live 唯一性。
2. 以稳定的 live `pane_id` 调用 `agent.rename`。
3. 调用 `tab.rename` 同步 tab label。
4. 任一步失败时，带重入保护地恢复已经修改的 Herdr surface 和原 Pi session name。

Primary 的 ownership 使用 pane ID 作为稳定键，name 只是可变的路由属性。

## Ownership and Lifecycle

Primary 只在内存中记录自己成功创建且仍 live 的 Agent，记录包含 description、definition、createdBy pane 和最新 `AgentInfo`。它只用于给 `ListAgents` 附加来源、计算当前 Primary 的容量，以及在 lifecycle event 或 reconciliation 后释放已经消失的 runtime。

Primary 重启后 ownership 清空；先前仍 live 的 Spawned Agent 继续保留 session、上下文和 Spawned 工具表面，但在新 Primary 看来是普通 peer。

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
