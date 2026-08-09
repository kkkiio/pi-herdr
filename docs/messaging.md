# Agent Messaging

pi-herdr 通过 herdr `agent.prompt` 在 live pi 会话之间传递纯文本请求和结论。消息不复制发送方 transcript，不建立 Team，也不承诺目标 runtime 消失后的排队或恢复。

## ListAgents

`ListAgents` 直接返回当前 herdr socket 可见的 live `AgentInfo`，并附加当前 Primary 能确认的来源信息：

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
- `type: "agent"` 只用于当前 Primary 进程内创建且仍 live 的 Agent；其余会话返回 `peer`。
- `createdBy` 使用创建者当前 live name；没有可用 name 时使用创建者 pane ID。
- Primary 重启会清空创建者内存，原 Agent 即使仍 live，也会作为 peer 返回。
- name 是首选 target；未命名 peer 使用 `pane_id`。

ListAgents 不读取 pi session 文件，不返回已经关闭的 runtime，也不维护 offline registry。

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

## Envelope and Reply

初始 Agent prompt 和每次 SendMessage 都使用同一个没有 closing tag 的文本 envelope：

```text
<from agent="primary" reply-to="w1:p1">
这里开始全部是消息正文，直到本次 prompt 结束。
```

- `agent` 是发送方当前 live name；没有 name 时使用发送方 pane ID。
- `reply-to` 使用发送时可用的 live name，否则使用 pane ID。
- attribute 值进行 XML 转义；消息正文不解析、不改写。
- opening tag 只标识后续文本的来源和回复目标，不执行 slash command，也不携带权限。

reply address 是 live 地址。发送方关闭、移动到新 pane 或更名后，旧 reply 地址可能失效；接收方可以重新调用 `ListAgents` 查找当前目标。pi-herdr 不维护稳定的 offline reply identity。

Agent 完成工作后按 system prompt 使用 `SendMessage` 回复：

```typescript
SendMessage({
  agent: "w1:p1",
  message: "认证入口位于 src/auth/index.ts；刷新令牌逻辑在 src/auth/refresh.ts。",
})
```

结果没有独立 store、消费协议或完成通知抑制。一次回复是否成功只取决于 reply target 当时是否 live。

## Delivery and Failures

- 不实现 durable mailbox、message ID、ack、去重或 offline queue。
- 不读取目标 session 最后一条 assistant 消息来推断结果。
- 不自动恢复已经关闭的 Agent。
- socket 断线时只自动重试 `agent.list`、`agent.get` 等幂等读取。
- `agent.prompt`、`agent.start`、rename、close 等 mutating RPC 不自动重放，避免重复提交或重复操作。

消息不会提升接收方权限，也不能代替用户批准。Spawned 模式始终拥有 `ListAgents` 和 `SendMessage`，但不拥有 `Agent` 或 `StopAgent`。
