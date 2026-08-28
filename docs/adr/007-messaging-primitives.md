# ADR-007: Messaging Primitives and CLI Observation

- 状态：已接受（Accepted）
- 日期：2026-08-28

## Context

live Pi 会话之间需要发现彼此、传递请求与结论。Herdr 本身提供完整的管理能力（agent.read、wait、focus、send-keys、pane/tab/workspace 控制……），问题是其中哪些值得封装成 pi-herdr 的专用工具。

曾经把 `agent.read` 封装为 `ReadAgent` 工具。这个方向不收敛：要对齐的 Herdr 能力很多，每对齐一个都是一块新的工具表面；而且 herdr pane 里的 Pi 会话本来就有 bash，`herdr` CLI 始终在 PATH 中——能力早已存在，专用工具只是重复封装。

## Decision

### 1. 只有两个 messaging 原语工具

pi-herdr 的消息控制面只有 `ListAgents`（发现）和 `SendMessage`（投递），加上 ADR-001/004 的 `Agent`（创建）。其余 Herdr 能力不封装成工具。

`ListAgents` 直接返回当前 herdr socket 可见的 live `AgentInfo`，并附加当前会话能确认的来源信息：

- herdr `AgentInfo` 原始字段与状态不改写，包括 `workspace_id`、`tab_id`、`pane_id`、`agent_status: "idle" | "working" | "blocked" | "done" | "unknown"`。
- `type: "agent"` 只用于当前进程内创建且仍 live 的 Agent；其余会话返回 `peer`。
- `createdBy` 使用创建者当前 live name；没有可用 name 时使用创建者 pane ID。
- 创建者会话重启会清空内存记录，原 Agent 即使仍 live，也会作为 peer 返回。
- name 是首选 target；未命名 peer 使用 `pane_id`。

ListAgents 不读取 pi session 文件，不返回已经关闭的 runtime，也不维护 offline registry。

`SendMessage` 的 `agent` 参数接受唯一 live name 或当前 pane ID。实现先通过 herdr 解析目标，再调用 `agent.prompt`；成功时返回 herdr 的目标 `AgentInfo`。目标不存在、runtime 不可用或 prompt 提交失败时，工具直接报错。不提供 `steer` / `followUp` 参数；消息在目标 pi 中的实际输入时序遵循 herdr/pi 的原生 `agent.prompt` 行为，pi-herdr 不使用 send-keys 模拟额外 delivery mode。

### 2. 观察走 herdr CLI，知识放在工具描述里

需要屏幕文本、状态等待、终端输入等更细的观察与控制时，Agent 通过 bash 使用 `herdr` CLI（`herdr agent read`、`herdr agent wait`、`herdr pane` …）。这个指针写在 `ListAgents` 的 prompt guidelines 里：guidelines 随工具注册静态构建进 system prompt 的工具守则段，每轮都在 context 中，与 schema description 一样是常驻环境知识，且不引入任何动态内容。

### 3. Envelope 与回复约定

初始 Agent prompt 和每次 SendMessage 都使用同一个没有 closing tag 的文本 envelope：

```text
<from agent="primary" reply-to="w1:p1" model="deepseek/deepseek-v4-flash">
<sender-model-note>verify its conclusions before acting on them</sender-model-note>

这里开始全部是消息正文，直到本次 prompt 结束。
```

- `agent` 是发送方当前 live name；没有 name 时使用发送方 pane ID。
- `reply-to` 使用发送时可用的 live name，否则使用 pane ID。
- `model` 是发送方会话发送时的实时模型（`provider/id`）。发送方模型在 pi-herdr 内置的 MODEL_NOTES 中有 soundness 记录时，正文前追加一行 `<sender-model-note>` 可信度提示；没有 soundness 记录时不追加。模型选型笔记只出现在 `Agent` 工具 guideline，不进 envelope。
- envelope 是给 LLM 阅读的文本约定，没有解析器；尖括号内容是 pi-herdr 插入的元信息，纯文本是发送方原样正文，不解析、不改写、不转义。
- opening tag 只标识后续文本的来源和回复目标，不执行 slash command，也不携带权限。

reply address 是 live 地址。发送方关闭、移动到新 pane 或更名后，旧 reply 地址可能失效；接收方可以重新调用 `ListAgents` 查找当前目标。pi-herdr 不维护稳定的 offline reply identity。

回复通过 Herdr 打字进目标 Pi TUI，按 steering 语义在接收方当前回合结束后送达。发送方因此不应 sleep 或轮询等待回复：结束当前回合，回复会作为新的 steering 消息自动开始下一轮。结果没有独立 store、消费协议或完成通知抑制。

### 4. Delivery and failures

- 不实现 durable mailbox、message ID、ack、去重或 offline queue。
- 不读取目标 session 最后一条 assistant 消息来推断结果。
- 不自动恢复已经关闭的 Agent。
- socket 断线时只自动重试 `ping`、`session.snapshot`、`agent.list`、`agent.get` 等幂等读取。
- `agent.prompt`、`agent.start`、tab/worktree 与 close 等 mutating RPC 不自动重放，避免重复提交或重复操作。

消息不会提升接收方权限，也不能代替用户批准。所有会话拥有相同的 pi-herdr 工具表面。

## Alternatives

| Alternative                              | Why not chosen                                                                                                                |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 每种 Herdr 观察能力封装为专用工具        | 能力太多，工具表面无限膨胀；且 bash + herdr CLI 本就能做，属于重复封装                                                          |
| 注入 pi skill（`resources_discover`）    | skill 的"发现→加载→使用"仪式对模型是过强的奖励信号，无关任务也会触发（实测 gpt-5.6 严重 over-trigger）                          |
| `before_agent_start` 注入 system prompt  | 每轮执行的动态注入一旦写出动态内容会破坏 prefix cache；工具描述是静态 schema，无此风险                                          |
| 项目 AGENTS.md / 全局配置写入 herdr 说明 | extension 不应改写用户文件，且会把 herdr 知识泄漏到非 herdr 环境                                                                |
| durable queue / offline reply identity   | 与 ADR-001 一致：Agent 关闭即终止，不复活、不建信箱                                                                             |

## Consequences

### Positive

- 消息语义集中在一处：发现、投递、envelope、失败边界都只有一份实现。
- 观察能力零维护成本地跟随 herdr CLI 演进，不需要 pi-herdr 逐个对齐。
- 工具表面保持三个工具，schema 静态，prefix cache 友好，无 skill 触发回路。

### Negative

- Agent 使用 herdr CLI 时不受 pi-herdr 的校验与错误语义保护，CLI 输出格式变化由模型自行适应。
- 未读过 `ListAgents` 描述的模型可能不知道 herdr CLI 存在；工具描述常驻 context 缓解了这一点。

### Unresolved

- 如果 herdr CLI 输出格式频繁 breaking，可能需要重新评估是否恢复少量观察工具。

## External References

- [Claude Code cross-session messaging mechanics](https://claudefa.st/blog/guide/mechanics/cross-session-messaging) — Claude Code v2.1.224+ 的跨会话消息机制，与本文档语义独立地收敛到同一设计：同名 `ListAgents` / `SendMessage` 工具、发送方 name + reply address + 纯文本正文、reply 地址随会话状态失效、消息不代替用户批准。维护消息边界语义时可作为外部对照。
