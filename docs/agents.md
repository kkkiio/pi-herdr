# Agents

pi-herdr 的 Agent 由 Primary Agent 创建，并在独立 herdr tab 的受管 pane 中运行交互式 pi。Agent 使用全新、正常落盘的 session；一次请求完成后进入 idle，保留上下文并等待后续消息。

这里的持久性以 live runtime 为边界：只要 pane 仍存在，Agent 就能跨多轮复用。pane、tab 或进程消失后，pi-herdr 释放内存记录与名额，不再自动恢复该 Agent；session 与可选 worktree 保留给用户通过原生 pi、Git 和 herdr 管理。

## Agent

Primary Agent 使用 `Agent` 创建后台 Agent：

```typescript
Agent({
  description: string,
  prompt: string,
  agent_type: string,
  name: string,
  model?: string | string[],
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
  isolation?: "worktree",
}) => {
  status: "launched",
  description: string,
  agent: AgentInfo,
}
```

- `description` 是工具结果与 UI 详情中的简短说明，不参与 tab label。
- `prompt` 是第一条消息，使用与 `SendMessage` 相同的 `<from ...>` envelope。
- `agent_type` 是创建时解析并固定的 definition 名称。
- `name` 同时作为 pi session name、herdr live route name 和 tab label，必须符合 `[a-z][a-z0-9_-]{0,31}`。
- `model` 与 `thinking` 覆盖 definition 的初始值；Agent 启动后允许用户使用 pi 原生能力修改。
- `isolation: "worktree"` 创建独立 worktree workspace；未设置时共享当前 workspace 与 cwd。

创建过程只有在 `agent.start` 成功且初始 `agent.prompt` 被 herdr 接受后才返回 `launched`，不等待 Agent 完成工作。任一步失败都会回滚本次新建的 pane/tab、尚未承载工作的 session，并以 `force: false` 尝试移除新 worktree；herdr 拒绝移除时保留现场，残留资源进入错误信息。

共享 workspace 时，pi-herdr 使用 `tab.create` 返回的 root pane。worktree 模式直接复用 `worktree.create` 返回的 workspace、tab 与 root pane，不创建第二个 tab。

## StopAgent

Primary Agent 可以停止任意其他 live Agent 或 peer：

```typescript
StopAgent({
  agent: string,
}) => {
  stopped: true,
  agent: AgentInfo,
}
```

`agent` 接受唯一 live name 或当前 pane ID。pi-herdr 在关闭前取得目标 `AgentInfo`，拒绝目标 pane 等于调用者 pane，然后调用 `pane.close`。StopAgent 不删除 pi session、tab 中的其他 pane 或 worktree，也不负责 Git 合并与资源清理。

## 单扩展双模式

Primary 与 Spawned 使用同一个 pi-herdr extension 入口，通过创建时注入的 runtime role 选择工具表面：

- Primary 模式注册 `Agent`、`StopAgent`、`ListAgents`、`SendMessage` 和用户 UI。
- Spawned 模式只注册 `ListAgents`、`SendMessage` 和 name 同步逻辑。

Spawned 模式不会注册 `Agent` 或 `StopAgent`，因此不能递归创建 Agent 或管理其他 runtime。definition 是否加载其他普通 extensions 与 skills 不改变 pi-herdr 自己的工具表面。

## Name 与 rename

name 在 live Agent 中必须唯一。pi-herdr 不为已经关闭的 session 保留 name；关闭后可以创建同名 Agent。

Spawned 模式监听 `session_info_changed`。用户执行 `/name` 后：

1. 校验新名字格式并通过 herdr 检查 live 唯一性。
2. 以稳定的 live `pane_id` 调用 `agent.rename`。
3. 调用 `tab.rename` 保持 tab label 一致。
4. 任一步失败时，带重入保护地恢复已修改部分和原 pi session name，并显示错误。

Primary 的内存记录以 pane ID 关联 live Agent，name 只是可变路由属性，因此不需要跨进程维护额外 registry。

## Lifecycle

```text
starting -> working -> idle
                ^       |
                |       |
                +-------+

starting/working/idle -> blocked -> working
starting/working/blocked/idle/done/unknown -> closed
```

工具层直接保留 herdr `AgentInfo.agent_status` 的 `idle`、`working`、`blocked`、`done` 和 `unknown`。`/agents` UI 可以把 `done` 视觉归类为 idle，但不会改写工具数据。

`ListAgents` 只返回 live runtime，不包含 `unavailable`。Primary 重启后，之前仍 live 的 Agent 因创建者内存已经消失，会作为普通 peer 返回；它们的 session、工具模式和上下文不受影响。

## Capacity Setting

每个 Primary 进程只统计自己创建且仍 live 的 Agent。默认上限为 16，可在 Pi settings 中配置：

```json
{
  "piHerdr": {
    "maxMembers": 32
  }
}
```

`maxMembers` 接受任意正整数；项目 settings 覆盖全局 settings。非法值会产生配置诊断并阻止新的 `Agent` 创建，但不影响 `ListAgents`、`SendMessage` 或 `StopAgent`。Primary 重启后计数重新开始，多个 Primary 的进程内上限彼此独立。

## Bundled Agents

### `explorer`

- 使用 `read`、`bash`、`grep`、`find` 和 `ls`，不加载普通 extensions 或 skills。
- Bash 只用于读取、Git 查询、统计与分析，不创建、修改或删除文件。
- 初始模型优先选择 `gpt-5.6-luna`、`deepseek-v4-flash`，均不可用时继承 Primary 模型。

### `general-purpose`

- 使用全部工作工具，并继承普通 extensions 与 skills。
- 初始模型继承 Primary 模型。
- 适合实现、重构、测试、文档和开放式调查。

两个定义在创建时加载，详见 [Agent definitions](agent-definitions.md)。

## User Command

`/agents` 展示 herdr 当前返回的 live Agent/peer、原始状态、cwd、workspace、tab 和 pane。它不提供通用 tab、pane、workspace 或 worktree 管理。
