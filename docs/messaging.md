# Agent-to-Agent Messaging

跨会话消息传递：一个 agent 会话向另一个会话投递一段文本，用于任务交接、状态汇报、结果回传。对齐 Claude Code 的 `ListAgents` + `SendMessage` 接口。

意图：**只传递结论，不传递上下文**。消息是纯文本，接收方只看到发送者名字、回复地址和文本——不是会话历史、不是文件。要迁移完整上下文请用 resume，不是消息。

## ListAgents

发现当前可到达的会话列表。

```typescript
ListAgents() → {
  agents: [
    {
      name: string,        // 会话名（显式命名，否则从目录派生）
      type: "peer" | "subagent" | ...,
      cwd?: string,        // 区分同名会话
      status?: "idle" | "working" | "blocked" | ...,
    },
    ...
  ],
}
```

- 由 agent 调用，自己决定要向谁发消息
- 只列出**已存在**的会话；不负责创建会话

## SendMessage

向指定会话投递一条消息。

```typescript
SendMessage({
  agent: string,        // ListAgents 返回的会话名
  message: string,      // 要传达的内容（纯文本）
}) → { delivered: boolean }
```

- 调用方（agent）只表达**意图**，消息文本由 agent 自己写
- 接收方会话在空闲时收到消息即开新 turn；工作中则在当前工具之间/之后读取
- 接收方的权限规则照常生效——消息不能代替用户批准、不能改配置、不能执行 slash command

### 回复

消息可携带**回复地址**，接收方借此回信；不保证原路返回，但保证同一通道语义对称。

## Commands（user 视角）

| 命令                            | 来源     | 作用                                         |
| ------------------------------- | -------- | -------------------------------------------- |
| `/list-agents`（别名 `/peers`） | **新增** | 列出当前可到达的会话（子代理、本地会话）     |
| `/name`                         | pi 已有  | 给当前会话命名；未命名时从目录派生，可能重名 |
| `/session`                      | pi 已有  | 显示本会话信息与统计                         |

agent 用上面的工具（`ListAgents` / `SendMessage`），user 用命令——两个视角各一套。
