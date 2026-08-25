# Agent Messaging

pi-herdr 通过 herdr `agent.prompt` 在 live pi 会话之间传递纯文本请求和结论。消息不复制发送方 transcript，不建立 Team，也不承诺目标 runtime 消失后的排队或恢复。

## ListAgents

`ListAgents` 直接返回当前 herdr socket 可见的 live `AgentInfo`，并附加当前会话能确认的来源信息：

```typescript
ListAgents() => {
  agents: Array<
    AgentInfo & {
      type: "agent" | "peer",
      createdBy?: string,
    }
  >,
}
```

- herdr `AgentInfo` 原始字段与状态不改写，包括 `workspace_id`、`tab_id`、`pane_id`、`agent_status: "idle" | "working" | "blocked" | "done" | "unknown"`。
- `type: "agent"` 只用于当前进程内创建且仍 live 的 Agent；其余会话返回 `peer`。
- `createdBy` 使用创建者当前 live name；没有可用 name 时使用创建者 pane ID。
- 创建者会话重启会清空内存记录，原 Agent 即使仍 live，也会作为 peer 返回。
- name 是首选 target；未命名 peer 使用 `pane_id`。

ListAgents 不读取 pi session 文件，不返回已经关闭的 runtime，也不维护 offline registry。

## ReadAgent

`ReadAgent` 通过 herdr `agent.read` 被动读取一个 live Agent 的终端文本，用于在决定等待或发消息之前观察后台 Agent 当前显示的内容：

```typescript
ReadAgent({
  agent: string,                    // live Agent name 或 pane ID
  source?: "visible" | "recent" | "recent_unwrapped" | "detection",  // 默认 "recent"
  lines?: number,                   // recent 类 source 的尾部行数，默认 80
}) => { agent: AgentInfo, read: { text, source, truncated, ... } }
```

- 读取是被动的：不改变 Agent 状态，也不把 `done` 标记为已读。
- Agent 正在工作或 blocked 时，需要翻页的 `recent` 读取可能返回 `agent_not_idle`；改用 `source: "visible"` 或等 idle 后重试。
- `detection` 返回 herdr 用于状态分类的快照，适合排查状态识别问题。

## SendMessage

```typescript
SendMessage({
  agent: string,
  message: string,
}) => {
  delivered: true,
  agent: AgentInfo,
}
```

`agent` 接受唯一 live name 或当前 pane ID。实现先通过 herdr 解析目标，再调用 `agent.prompt`；成功时返回 herdr 的目标 `AgentInfo`。目标不存在、runtime 不可用或 prompt 提交失败时，工具直接报错。

SendMessage 不提供 `steer` / `followUp` 参数。消息在目标 pi 中的实际输入时序遵循当前 herdr/pi 的原生 `agent.prompt` 行为，pi-herdr 不使用 send-keys 或终端输入路径模拟额外 delivery mode。

每次目标解析与 prompt 都使用普通 request/response RPC 的独立 socket；`events.subscribe` 的专用长连接只维护 live 状态，不承载消息，也不作为 prompt ack。

## Envelope and Reply

初始 Agent prompt 和每次 SendMessage 都使用同一个没有 closing tag 的文本 envelope：

```text
<from agent="primary" reply-to="w1:p1" model="deepseek/deepseek-v4-flash">
<sender-model-note>verify its conclusions before acting on them</sender-model-note>

这里开始全部是消息正文，直到本次 prompt 结束。
```

- `agent` 是发送方当前 live name；没有 name 时使用发送方 pane ID。
- `reply-to` 使用发送时可用的 live name，否则使用 pane ID。
- `model` 是发送方会话发送时的实时模型（`provider/id`）。发送方模型在 pi-herdr 内置的 MODEL_NOTES 中有 soundness 记录时，正文前追加一行 `<sender-model-note>` 可信度提示；模型没有 soundness 记录时不追加。模型选型维度（capacity）的笔记只出现在 `Agent` 工具 guideline，不进 envelope。
- envelope 是给 LLM 阅读的文本约定，没有解析器；尖括号内容是 pi-herdr 插入的元信息，纯文本是发送方原样正文，不解析、不改写、不转义。
- opening tag 只标识后续文本的来源和回复目标，不执行 slash command，也不携带权限。

reply address 是 live 地址。发送方关闭、移动到新 pane 或更名后，旧 reply 地址可能失效；接收方可以重新调用 `ListAgents` 查找当前目标。pi-herdr 不维护稳定的 offline reply identity。

Agent 完成工作后按 `SendMessage` 工具的 prompt guidelines 回复：

```typescript
SendMessage({
	agent: "w1:p1",
	message: "认证入口位于 src/auth/index.ts；刷新令牌逻辑在 src/auth/refresh.ts。",
});
```

结果没有独立 store、消费协议或完成通知抑制。一次回复是否成功只取决于 reply target 当时是否 live。

回复通过 Herdr 打字进目标 Pi TUI,按 steering 语义在接收方当前回合结束后送达。发送方因此不应 sleep 或轮询等待回复:结束当前回合,回复会作为新的 steering 消息自动开始下一轮。

## Delivery and Failures

- 不实现 durable mailbox、message ID、ack、去重或 offline queue。
- 不读取目标 session 最后一条 assistant 消息来推断结果。
- 不自动恢复已经关闭的 Agent。
- socket 断线时只自动重试 `ping`、`session.snapshot`、`agent.list`、`agent.get` 等幂等读取。
- `agent.prompt`、`agent.start`、tab/worktree 与 close 等 mutating RPC 不自动重放，避免重复提交或重复操作。

消息不会提升接收方权限，也不能代替用户批准。所有会话拥有相同的 pi-herdr 工具表面。

## External References

- [Claude Code cross-session messaging mechanics](https://claudefa.st/blog/guide/mechanics/cross-session-messaging) — Claude Code v2.1.224+ 的跨会话消息机制，与本文档语义独立地收敛到同一设计：同名 `ListAgents` / `SendMessage` 工具、发送方 name + reply address + 纯文本正文、reply 地址随会话状态失效、消息不代替用户批准。维护消息边界语义时可作为外部对照。
