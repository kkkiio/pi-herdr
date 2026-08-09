# Agent-to-Agent Messaging

跨会话消息传递：一个 agent 会话向另一个会话投递一段文本，用于任务交接、状态汇报、结果回传。对齐 Claude Code 的 `ListAgents` + `SendMessage` 接口。

意图：**只传递结论，不传递上下文**。消息是纯文本，接收方只看到发送者名字、回复地址和文本——不是会话历史、不是文件。要迁移完整上下文请用 resume，不是消息。

## ListAgents

发现当前可到达的会话列表。实现上直接调用 herdr 的 `agent list`（或其 socket API `agent.list`），因此只返回 herdr 能看到的 agent/session。

```typescript
ListAgents() → {
  agents: [
    {
      name: string,        // herdr agent 名（显式命名，否则从目录派生）
      type: "peer" | "subagent",
      cwd?: string,        // 区分同名会话
      status?: "idle" | "working" | "blocked" | "done" | "unknown",
    },
    ...
  ],
}
```

- 由 agent 调用，自己决定要向谁发消息。
- 只列出**已存在**的会话；不负责创建会话。
- 在 pi-herdr 中，可到达的会话来自 herdr `agent list`，包括：
  - 同一 herdr workspace 下的其他 pi 会话（peer）。
  - 由 `Agent` 工具启动的 background subagent（`type: "subagent"`）。
  - 这些会话通过 herdr socket registry 发现，不是通过网络扫描。

## SendMessage

向指定会话投递一条消息。

```typescript
SendMessage({
  agent: string,      // ListAgents 返回的会话名
  message: string,    // 要传达的内容（纯文本）
}) → { delivered: boolean }
```

- 调用方（agent）只表达**意图**，消息文本由 agent 自己写。
- 接收方会话在空闲时收到消息即开新 turn；工作中则在当前工具之间/之后读取。
- 接收方的权限规则照常生效——消息不能代替用户批准、不能改配置、不能执行 slash command。

### 回复

消息可携带**回复地址**，接收方借此回信；不保证原路返回，但保证同一通道语义对称。

## Subagent 结果投递

background subagent 完成后，supervisor 通过 `SendMessage` 语义把结果投递回主会话。实际实现使用 `pi.sendMessage`：

```typescript
pi.sendMessage(
  {
    customType: "subagent_result",
    content: formattedResult,
    details: { agentId, status, toolUses, tokens, durationMs, outputFile },
  },
  { deliverAs: "followUp", triggerTurn: true }
);
```

- `triggerTurn: true`：主 agent 空闲时立即开新 turn。
- `deliverAs: "followUp"`：主 agent 正在工作时，等当前工作结束再交付，不打断现有工作。
- `get_subagent_result` 消费结果后会抑制这条通知。

## Commands（user 视角）

| 命令                            | 来源     | 作用                                         |
| ------------------------------- | -------- | -------------------------------------------- |
| `/list-agents`（别名 `/peers`） | **新增** | 列出当前可到达的会话（子代理、本地会话）     |
| `/name`                         | pi 已有  | 给当前会话命名；未命名时从目录派生，可能重名 |
| `/session`                      | pi 已有  | 显示本会话信息与统计                         |

agent 用上面的工具（`ListAgents` / `SendMessage`），user 用命令——两个视角各一套。
