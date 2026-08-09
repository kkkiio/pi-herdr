# Agent Messaging

pi-herdr 使用消息连接 herdr 中可到达的 pi 会话。消息传递请求和结论，不复制发送方的会话历史，也不要求双方属于同一个 Team、工作目录或 worktree。

每条入站消息都包含发送者身份和 reply 地址。收到请求的 Agent 使用 reply 地址回复，不假设消息一定来自创建自己的 Primary Agent。

## ListAgents

`ListAgents` 以当前 herdr session 为范围：返回 herdr 当前可达的全部 Agent 和 peer，并补充 pi-herdr 管理但 runtime 暂时 unavailable 的持久 Agent。它不按创建者或 workspace 过滤。

```typescript
ListAgents() => {
  agents: [
    {
      name?: string,
      type: "agent" | "peer",
      createdBy?: string,
      cwd?: string,
      workspace_id: string,
      tab_id: string,
      pane_id: string,
      status: "starting" | "working" | "blocked" | "idle" | "unavailable",
    },
  ],
}
```

- `agent`：由 pi-herdr 的 `Agent` 工具创建，拥有持久 session。
- `peer`：herdr 中可到达的其他 pi 会话。
- `createdBy` 只是创建来源元数据，不用于过滤列表或限制通信。
- pi-herdr 创建的 Agent 始终有 name；它同时是 pi session name 和 herdr live alias，符合 `[a-z][a-z0-9_-]{0,31}`，并在当前 herdr session 中保持唯一。
- 手动启动的 peer 可以没有 name，此时使用 `pane_id` 寻址。
- `pane_id` 是 runtime fallback，可能在 pane 跨 workspace 移动或 session 恢复后变化。
- `tab_id` 用于 UI 定位，不是 Agent 路由身份。
- `cwd`、workspace、tab 和 pane 都不构成通信边界。

实现以 herdr `agent.list` 的可达结果为基础，再用 pi-herdr registry 补充 `createdBy` 和持久 session 信息。

## SendMessage

```typescript
SendMessage({
  agent: string,
  message: string,
  delivery?: "steer" | "followUp",
}) => {
  delivered: boolean,
}
```

- `agent` 接受唯一 live name，或当前宿主 `pane_id`。
- `message` 是接收方真正看到的文本。
- `steer` 尽快影响正在进行的工作；目标空闲时立即触发新 turn。
- `followUp` 等当前工作 settle 后再交付；目标空闲时同样立即触发新 turn。
- 未指定 `delivery` 时默认使用 `followUp`，避免普通补充消息打断正在执行的工具链。

普通工作结果也通过 `SendMessage` 返回。pi-herdr 不提供单独的 result store 或结果消费协议。

## Reply

消息进入接收方时，系统附加路由信息。发送方有唯一 live herdr name 时使用 name；没有时使用当前 `pane_id`：

```text
From: primary
Reply-To: w1:p1
```

Agent 完成请求后直接回复：

```typescript
SendMessage({
  agent: "w1:p1",
  message: "认证入口位于 src/auth/index.ts；刷新令牌逻辑在 src/auth/refresh.ts。",
})
```

reply 地址只负责路由，不携带发送方的上下文、权限或工具能力。普通 Primary/peer 的 pi session name 可以包含空格等字符，因此不会自动成为 herdr name；只有 pi-herdr 创建的 Agent 强制让两者一致。

## 投递到 pi 会话

接收方进程内的扩展使用 pi 的消息注入能力：

```typescript
pi.sendMessage(
  {
    customType: "agent_message",
    content: formattedMessage,
    details: { senderId, senderName, replyTo },
  },
  { deliverAs: "followUp", triggerTurn: true },
)
```

- 接收方空闲时，消息立即触发新 turn。
- 接收方工作中时，消息在当前工作结束后交付。
- 消息不需要轮询。

如果目标 runtime 暂时不可用，pi-herdr 创建的 Agent 可以通过持久 session 恢复后再接收消息。普通 peer 不受 pi-herdr 管理，投递失败会直接返回错误。

## Agent 权限

pi-herdr 创建的 Agent 始终获得 `ListAgents` 和 `SendMessage`，即使 definition 限制了其他工具。它们不会获得 `Agent` 或任意 pane 管理能力，因此可以直接协作，但不能递归创建下级 Agent。

消息不能提升接收方权限，不能代替用户批准，也不能执行 slash command。
